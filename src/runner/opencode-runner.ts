import { isAbsolute, resolve } from "node:path";
import type { z } from "zod";
import type { FlowConfig } from "../config.js";
import { toJsonSchema } from "../schemas.js";
import { addModel, sumUsage, type Usage } from "../usage.js";
import { ToolBridge } from "../tool-bridge.js";
import { AgentError, type AgentRequest, type AgentResult, type AgentRunner } from "./agent-runner.js";
import { decide, decisionContext, resolvedScope, type DecisionContext, type Verdict } from "./claude-runner.js";

/** One permission request from OpenCode (the `permission.asked` event). */
export interface OpencodePermission {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
}

type Result<T> = Promise<{ data?: T; error?: unknown }>;

/** OpenCode's per-step usage (a "step-finish" part). Its input excludes cache reads and writes. */
export interface OpencodeStepFinish {
  type: "step-finish";
  cost?: number;
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
}
type OpencodeMessageInfo = {
  role?: string;
  time?: { created: number };
  providerID?: string;
  modelID?: string;
  structured?: unknown;
  cost: number;
  tokens?: OpencodeStepFinish["tokens"];
  error?: { name?: string; data?: { message?: string } };
};

/** The slice of the OpenCode v2 client this runner uses, so tests can inject a fake. */
export interface OpencodeClientLike {
  global: { event(options?: { signal?: AbortSignal }): Promise<{ stream: AsyncIterable<unknown> }> };
  session: {
    create(p: { directory?: string; title?: string; permission?: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }> }): Result<{ id: string }>;
    prompt(p: {
      sessionID: string;
      directory?: string;
      model?: { providerID: string; modelID: string };
      system?: string;
      variant?: string;
      format?: { type: "json_schema"; schema: Record<string, unknown>; retryCount?: number };
      parts?: Array<{ type: "text"; text: string }>;
    }): Result<{ info: OpencodeMessageInfo; parts: Array<{ type: string }> }>;
    messages?(p: { sessionID: string; directory?: string; limit?: number }): Result<Array<{ info: OpencodeMessageInfo; parts: Array<{ type: string }> }>>;
  };
  permission: {
    reply(p: { requestID: string; directory?: string; reply?: "once" | "always" | "reject"; message?: string }): Result<unknown>;
  };
  mcp: {
    add(p: { directory?: string; name?: string; config?: Record<string, unknown> }): Result<unknown>;
    disconnect(p: { name: string; directory?: string }): Result<unknown>;
  };
}

export type OpencodeFactory = (options: {
  hostname: string;
  port: number;
}) => Promise<{ client: OpencodeClientLike; close(): void }>;

const defaultFactory: OpencodeFactory = async ({ hostname, port }) => {
  const { createOpencode } = await import("@opencode-ai/sdk/v2");
  const { client, server } = await createOpencode({ hostname, port, config: { share: "disabled", autoupdate: false } });
  return { client: client as unknown as OpencodeClientLike, close: () => server.close() };
};

/**
 * Runs a step in OpenCode (`opencode serve`, started once per run and shared).
 *
 * Every session is created with the ruleset "ask for everything"; the runner
 * listens to the server's event stream and answers each permission request
 * with decide(), the same rules the Claude runner applies. So mode, readable
 * roots, the read deny-list, component write isolation, locked tests and the
 * command allowlist are all enforced before the tool runs.
 *
 * The workflow's ask/memory tools reach OpenCode through the local HTTP MCP
 * bridge, registered under a per-call server name so concurrent sessions in
 * the same folder cannot use each other's tools.
 */
export class OpenCodeAgentRunner implements AgentRunner {
  private readonly bridge = new ToolBridge();
  private server: Promise<{ client: OpencodeClientLike; close(): void }> | null = null;
  private readonly events = new AbortController();
  private readonly handlers = new Map<string, (p: OpencodePermission) => void>();
  /** (directory, server name) → number of calls using it, so a shared external server is disconnected only when unused. */
  private readonly mcpRefs = new Map<string, number>();

  constructor(
    private readonly config: FlowConfig,
    private readonly factory: OpencodeFactory = defaultFactory,
  ) {}

  async run<S extends z.ZodType>(req: AgentRequest<S>): Promise<AgentResult<z.infer<S>>> {
    const started = Date.now();
    const { client } = await this.start();
    const ctx = decisionContext(req, this.config);
    const root = resolvedScope(req, this.config).root;
    const denials: AgentResult<unknown>["denials"] = [];
    const route = await this.bridge.register({ ask: req.ask, memory: req.memory });
    const hectorName = route ? `hector-${route.token}` : undefined;
    const servers = [...(hectorName ? [hectorName] : []), ...ctx.mcpServers];
    const policy: DecisionContext = { ...ctx, mcpServers: servers };
    let sessionID = req.resumeSessionId;

    try {
      if (route && hectorName) await this.addMcp(client, req.cwd, hectorName, { type: "remote", url: route.url, oauth: false });
      for (const name of ctx.mcpServers) await this.addMcp(client, req.cwd, name, opencodeMcp(this.config.mcpServers[name]!));

      if (!sessionID) {
        const created = await client.session.create({
          directory: req.cwd,
          title: `hector ${req.role}`,
          permission: [{ permission: "*", pattern: "*", action: "ask" }],
        });
        if (!created.data) throw new AgentError(`OpenCode could not create a session: ${describe(created.error)}`, req.role);
        sessionID = created.data.id;
      }

      this.handlers.set(sessionID, (p) => {
        const verdict = decideOpencode(policy, p, root);
        if (!verdict.ok && !denials.some((d) => d.tool === p.permission && d.reason === verdict.reason)) {
          denials.push({ tool: p.permission, reason: verdict.reason });
        }
        void client.permission.reply({
          requestID: p.id,
          directory: req.cwd,
          reply: verdict.ok ? "once" : "reject",
          message: verdict.ok ? undefined : verdict.reason,
        });
      });

      const promptedAt = Date.now() - 1000;
      const model = req.model ?? this.config.runtime.opencode.model;
      const slash = model?.indexOf("/") ?? -1;
      const answer = await client.session.prompt({
        sessionID,
        directory: req.cwd,
        model: model && slash > 0 ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } : undefined,
        variant: req.effort,
        system: req.systemPrompt,
        format: { type: "json_schema", schema: toJsonSchema(req.schema), retryCount: 2 },
        parts: [{ type: "text", text: req.prompt }],
      });
      if (!answer.data) throw new AgentError(`OpenCode request failed: ${describe(answer.error)}`, req.role);
      const { info, parts } = answer.data;
      const usage = await this.usageSince(client, sessionID, req.cwd, promptedAt, answer.data);
      const costUsd = sumUsage(usage).costUsd || info.cost || 0;
      if (info.error) {
        throw new AgentError(`OpenCode failed: ${info.error.data?.message ?? info.error.name ?? "unknown error"}`, req.role, costUsd, usage);
      }
      const parsed = req.schema.safeParse(info.structured);
      if (!parsed.success) throw new AgentError(`Structured output did not match the contract: ${parsed.error.message}`, req.role, costUsd, usage);

      return {
        output: parsed.data,
        sessionId: sessionID,
        costUsd,
        usage,
        turns: Math.max(1, parts.filter((p) => p.type === "step-finish").length),
        durationMs: Date.now() - started,
        denials,
      };
    } catch (err) {
      if (err instanceof AgentError) throw err;
      throw new AgentError(`OpenCode failed: ${(err as Error).message}`, req.role);
    } finally {
      if (sessionID) this.handlers.delete(sessionID);
      if (hectorName) await this.removeMcp(client, req.cwd, hectorName);
      for (const name of ctx.mcpServers) await this.removeMcp(client, req.cwd, name);
      this.bridge.unregister(route?.token);
    }
  }

  async close(): Promise<void> {
    this.events.abort();
    const server = this.server;
    this.server = null;
    if (server) (await server.catch(() => null))?.close();
    await this.bridge.close();
  }

  /**
   * Usage of every model step this prompt caused. One prompt can create
   * several assistant messages, and a message's own `tokens` holds only its
   * last step, so the step-finish parts of every new message are summed.
   */
  private async usageSince(
    client: OpencodeClientLike,
    sessionID: string,
    directory: string,
    since: number,
    final: { info: OpencodeMessageInfo; parts: Array<{ type: string }> },
  ): Promise<Usage> {
    const listed = await client.session.messages?.({ sessionID, directory }).catch(() => undefined);
    const messages = listed?.data?.filter((m) => m.info.role === "assistant" && (m.info.time?.created ?? 0) >= since) ?? [final];
    const usage: Usage = {};
    for (const m of messages.length ? messages : [final]) {
      const key = m.info.providerID && m.info.modelID ? `${m.info.providerID}/${m.info.modelID}` : "opencode default";
      const steps = m.parts.filter((p): p is OpencodeStepFinish => p.type === "step-finish");
      const counted = steps.length ? steps : [{ type: "step-finish" as const, cost: m.info.cost, tokens: m.info.tokens }];
      for (const s of counted) {
        if (!s.tokens) continue;
        addModel(usage, key, {
          input: s.tokens.input,
          output: s.tokens.output,
          reasoning: s.tokens.reasoning,
          cacheRead: s.tokens.cache.read,
          cacheWrite: s.tokens.cache.write,
          costUsd: s.cost ?? 0,
        });
      }
    }
    return usage;
  }

  /** Starts `opencode serve` once and begins dispatching its permission requests. */
  private start(): Promise<{ client: OpencodeClientLike; close(): void }> {
    if (this.server) return this.server;
    const { hostname, port } = this.config.runtime.opencode;
    this.server = this.factory({ hostname, port }).then(async (srv) => {
      const { stream } = await srv.client.global.event({ signal: this.events.signal });
      void this.dispatch(stream);
      return srv;
    });
    this.server.catch(() => (this.server = null));
    return this.server;
  }

  private async dispatch(stream: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const event of stream) {
        const p = permissionAsked(event);
        if (p) this.handlers.get(p.sessionID)?.(p);
      }
    } catch {
      // The stream ends when the runner closes.
    }
  }

  private async addMcp(client: OpencodeClientLike, directory: string, name: string, config: Record<string, unknown>): Promise<void> {
    const key = `${directory}\0${name}`;
    const refs = this.mcpRefs.get(key) ?? 0;
    this.mcpRefs.set(key, refs + 1);
    if (refs === 0) await client.mcp.add({ directory, name, config });
  }

  private async removeMcp(client: OpencodeClientLike, directory: string, name: string): Promise<void> {
    const key = `${directory}\0${name}`;
    const refs = (this.mcpRefs.get(key) ?? 1) - 1;
    if (refs > 0) return void this.mcpRefs.set(key, refs);
    this.mcpRefs.delete(key);
    await client.mcp.disconnect({ name, directory }).catch(() => undefined);
  }
}

/** Extracts a permission request from a global event, whatever its envelope. */
export function permissionAsked(event: unknown): OpencodePermission | null {
  const e = event as { payload?: { type?: string; properties?: unknown }; type?: string; properties?: unknown };
  const payload = e?.payload ?? e;
  if (payload?.type !== "permission.asked" || !payload.properties) return null;
  const p = payload.properties as Partial<OpencodePermission>;
  if (!p.id || !p.sessionID || !p.permission) return null;
  return { id: p.id, sessionID: p.sessionID, permission: p.permission, patterns: p.patterns ?? [], metadata: p.metadata ?? {} };
}

/**
 * Maps one OpenCode permission request onto decide(). `root` resolves the
 * relative paths OpenCode reports (they are relative to the worktree).
 */
export function decideOpencode(ctx: DecisionContext, p: OpencodePermission, root: string): Verdict {
  const abs = (path: string) => (isAbsolute(path) ? path : resolve(root, path));
  const all = (checks: Verdict[]): Verdict => checks.find((v) => !v.ok) ?? { ok: true };
  const filepath = (p.metadata.filepath ?? p.metadata.filePath ?? p.metadata.path) as string | undefined;

  switch (p.permission) {
    case "read":
      return all((filepath ? [filepath] : p.patterns).map((f) => decide(ctx, "Read", { file_path: abs(f) })));
    case "edit":
      return all((filepath ? [filepath] : p.patterns).map((f) => decide(ctx, "Write", { file_path: abs(f) })));
    case "glob":
    case "grep":
    case "list":
      return decide(ctx, "Grep", { path: typeof p.metadata.path === "string" ? abs(p.metadata.path) : ctx.cwd });
    case "external_directory":
      return all(p.patterns.map((d) => decide(ctx, "Read", { file_path: abs(d.replace(/\/\*+$/, "")) })));
    case "bash": {
      const commands = typeof p.metadata.command === "string" ? [p.metadata.command] : p.patterns;
      if (!commands.length) return { ok: false, reason: "Empty command." };
      return all(commands.map((command) => decide(ctx, "Bash", { command })));
    }
    case "todowrite":
    case "todoread":
    case "lsp":
      return { ok: true };
    case "question":
      return { ok: false, reason: "Nobody is watching this step. Use the hector ask tool, or decide and record the assumption." };
    case "task":
    case "webfetch":
    case "websearch":
    case "codesearch":
    case "skill":
    case "doom_loop":
      return { ok: false, reason: `${p.permission} is not available in this flow.` };
  }
  // MCP tools are named "<server>_<tool>".
  const server = ctx.mcpServers.find((s) => p.permission.startsWith(`${s}_`));
  if (server) return { ok: true };
  return { ok: false, reason: `Tool ${p.permission} is not available to this step.` };
}

/** config.mcpServers entry → OpenCode MCP config. */
export function opencodeMcp(s: FlowConfig["mcpServers"][string]): Record<string, unknown> {
  if ("command" in s) return { type: "local", command: [s.command, ...(s.args ?? [])], ...(s.env ? { environment: s.env } : {}) };
  return { type: "remote", url: s.url, ...(s.headers ? { headers: s.headers } : {}), oauth: false };
}

function describe(error: unknown): string {
  if (!error) return "no response";
  if (typeof error === "string") return error;
  const e = error as { message?: string; data?: { message?: string } };
  return e.data?.message ?? e.message ?? JSON.stringify(error).slice(0, 300);
}
