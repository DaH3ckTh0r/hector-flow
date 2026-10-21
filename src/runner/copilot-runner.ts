import type { z } from "zod";
import type { FlowConfig } from "../config.js";
import { toJsonSchema } from "../schemas.js";
import { call, ToolBridge, type BridgeTools } from "../tool-bridge.js";
import { AgentError, type AgentRequest, type AgentResult, type AgentRunner } from "./agent-runner.js";
import { decide, decisionContext, type DecisionContext, type Verdict } from "./claude-runner.js";
import { dropNulls, strictify } from "./strict-schema.js";

/** A permission request from Copilot (the fields this runner reads). */
export interface CopilotPermission {
  kind: string;
  managedApprovalRequired?: boolean;
  // shell
  fullCommandText?: string;
  // write
  fileName?: string;
  resolvedPath?: string;
  fileEdits?: Array<{ before?: { path: string }; after?: { path: string } }>;
  // read
  path?: string;
  // mcp / custom-tool
  serverName?: string;
  toolName?: string;
}
export type CopilotDecision = { kind: "approve-once" } | { kind: "reject"; feedback?: string };

/** The slice of the Copilot SDK this runner uses, so tests can inject a fake. */
export interface CopilotSessionLike {
  readonly sessionId: string;
  sendAndWait(options: { prompt: string; responseSchema?: Record<string, unknown> }, timeout?: number): Promise<{ data: { content: string } } | undefined>;
  on(eventType: string, handler: (event: { data?: unknown }) => void): () => void;
  disconnect(): Promise<void>;
}
export interface CopilotClientLike {
  start(): Promise<void>;
  createSession(config: Record<string, unknown>): Promise<CopilotSessionLike>;
  resumeSession(sessionId: string, config: Record<string, unknown>): Promise<CopilotSessionLike>;
  stop(): Promise<unknown>;
  getAuthStatus?(): Promise<{ isAuthenticated: boolean; statusMessage?: string }>;
}
export type CopilotFactory = (options: Record<string, unknown>) => CopilotClientLike | Promise<CopilotClientLike>;

const defaultFactory: CopilotFactory = async (options) => {
  const { CopilotClient } = await import("@github/copilot-sdk");
  return new CopilotClient(options as never) as unknown as CopilotClientLike;
};

/** Built-in Copilot tools the flow never offers: web, subagents, questions to a person, Copilot skills. */
export const COPILOT_EXCLUDED_TOOLS = [
  "web_fetch",
  "web_search",
  "task",
  "read_agent",
  "write_agent",
  "list_agents",
  "send_inbox",
  "context_board",
  "ask_user",
  "exit_plan_mode",
  "skill",
];

/** Built-in tools that read without asking: the pre-tool hook checks their paths. */
const READ_TOOLS = new Set(["view", "grep", "glob", "rg", "lsp", "read_file", "list_dir", "ls"]);

/**
 * Runs a step with GitHub Copilot (the Copilot SDK drives the Copilot CLI
 * runtime over JSON-RPC; one runtime per run, one session per step).
 *
 * Copilot asks before every write, shell command, MCP or custom tool call,
 * and the runner answers with decide(), the same rules as Claude. Reads inside
 * the working directory do not ask, so a pre-tool hook checks their paths
 * against the readable roots and the secret list. Web, subagents and
 * questions to a person are removed from the session's tools.
 *
 * ask/memory are registered as in-process Copilot tools: no bridge needed.
 */
export class CopilotAgentRunner implements AgentRunner {
  private client: Promise<CopilotClientLike> | null = null;

  constructor(
    private readonly config: FlowConfig,
    private readonly factory: CopilotFactory = defaultFactory,
  ) {}

  async run<S extends z.ZodType>(req: AgentRequest<S>): Promise<AgentResult<z.infer<S>>> {
    const started = Date.now();
    const client = await this.start();
    const settings = this.config.runtime.copilot;
    const ctx = decisionContext(req, this.config);
    const denials: AgentResult<unknown>["denials"] = [];
    const record = (tool: string, v: Verdict) => {
      if (!v.ok && !denials.some((d) => d.tool === tool && d.reason === v.reason)) denials.push({ tool, reason: v.reason });
      return v;
    };

    const bridgeTools: BridgeTools = { ask: req.ask, memory: req.memory };
    const tools = ToolBridge.definitions(bridgeTools).map((d) => ({
      name: d.name,
      description: d.description,
      parameters: d.inputSchema,
      skipPermission: true,
      handler: (args: unknown) => call(bridgeTools, d.name, (args ?? {}) as Record<string, unknown>),
    }));
    const ownTools = tools.map((t) => t.name);

    const sessionConfig: Record<string, unknown> = {
      model: req.model ?? settings.model,
      reasoningEffort: req.effort ?? settings.effort,
      workingDirectory: req.cwd,
      systemMessage: { content: req.systemPrompt },
      tools,
      excludedTools: COPILOT_EXCLUDED_TOOLS,
      mcpServers: Object.fromEntries(ctx.mcpServers.map((n) => [n, { ...this.config.mcpServers[n]!, tools: ["*"] }])),
      onPermissionRequest: (request: CopilotPermission) => {
        const v = record(request.kind, decideCopilot(ctx, request, ownTools));
        return v.ok ? { kind: "approve-once" } : { kind: "reject", feedback: v.reason };
      },
      hooks: {
        onPreToolUse: (input: { toolName: string; toolArgs: unknown }) => {
          const v = record(input.toolName, checkToolUse(ctx, input.toolName, input.toolArgs));
          return v.ok ? undefined : { permissionDecision: "deny", permissionDecisionReason: v.reason };
        },
      },
    };

    let session: CopilotSessionLike | undefined;
    let turns = 0;
    try {
      session = req.resumeSessionId
        ? await client.resumeSession(req.resumeSessionId, sessionConfig)
        : await client.createSession({ ...sessionConfig, trustWorkingDirectory: "session" });
      session.on("assistant.usage", () => void turns++);
      let sessionError: string | undefined;
      session.on("session.error", (e) => void (sessionError = String((e.data as { message?: string })?.message ?? "session error")));

      const message = await session.sendAndWait(
        { prompt: req.prompt, responseSchema: strictify(toJsonSchema(req.schema)) as Record<string, unknown> },
        settings.timeoutMinutes * 60_000,
      );
      if (!message) throw new AgentError(`Copilot finished without a final message${sessionError ? `: ${sessionError}` : ""}`, req.role);
      let raw: unknown;
      try {
        raw = dropNulls(JSON.parse(message.data.content));
      } catch {
        throw new AgentError(`Copilot did not return JSON: ${message.data.content.slice(0, 200)}`, req.role);
      }
      const parsed = req.schema.safeParse(raw);
      if (!parsed.success) throw new AgentError(`Structured output did not match the contract: ${parsed.error.message}`, req.role);
      return {
        output: parsed.data,
        sessionId: session.sessionId,
        costUsd: 0, // Copilot bills premium requests, not USD.
        turns: Math.max(1, turns),
        durationMs: Date.now() - started,
        denials,
      };
    } catch (err) {
      if (err instanceof AgentError) throw err;
      throw new AgentError(`Copilot failed: ${(err as Error).message}`, req.role);
    } finally {
      await session?.disconnect().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await (await client.catch(() => null))?.stop();
  }

  /** Starts the Copilot runtime once per run. */
  private start(): Promise<CopilotClientLike> {
    if (this.client) return this.client;
    const s = this.config.runtime.copilot;
    const token = s.tokenEnv ? process.env[s.tokenEnv] : undefined;
    if (s.tokenEnv && !token) return Promise.reject(new Error(`Environment variable ${s.tokenEnv} is not set.`));
    const options: Record<string, unknown> = { logLevel: "error", ...(token ? { gitHubToken: token } : {}) };
    if (s.path) options.env = { ...process.env, COPILOT_CLI_PATH: s.path };
    this.client = Promise.resolve(this.factory(options)).then(async (c) => {
      await c.start();
      // Unauthenticated sessions do not fail: they wait until the timeout. Fail now instead.
      const auth = await c.getAuthStatus?.().catch(() => undefined);
      if (auth && !auth.isAuthenticated) {
        await c.stop().catch(() => undefined);
        throw new Error(`Copilot is not signed in (${auth.statusMessage ?? "no status"}). Run \`copilot login\`, or set runtime.copilot.tokenEnv.`);
      }
      return c;
    });
    this.client.catch(() => (this.client = null));
    return this.client;
  }
}

/** Maps one Copilot permission request onto decide(). */
export function decideCopilot(ctx: DecisionContext, r: CopilotPermission, ownTools: string[] = []): Verdict {
  if (r.managedApprovalRequired) {
    return { ok: false, reason: "Your organization's Copilot policy requires a person to approve this, and nobody is watching this step." };
  }
  const all = (checks: Verdict[]): Verdict => checks.find((v) => !v.ok) ?? { ok: true };
  switch (r.kind) {
    case "read":
      return decide(ctx, "Read", { file_path: r.resolvedPath ?? r.path ?? "" });
    case "write": {
      const paths = new Set<string>([r.resolvedPath ?? r.fileName ?? ""]);
      for (const e of r.fileEdits ?? []) for (const p of [e.before?.path, e.after?.path]) if (p) paths.add(p);
      return all([...paths].map((p) => decide(ctx, "Write", { file_path: p })));
    }
    case "shell":
      return decide(ctx, "Bash", { command: r.fullCommandText ?? "" });
    case "mcp":
      return ctx.mcpServers.includes(r.serverName ?? "")
        ? { ok: true }
        : { ok: false, reason: `MCP server "${r.serverName}" is not available to this step (see mcpAccess).` };
    case "custom-tool":
      return ownTools.includes(r.toolName ?? "") ? { ok: true } : { ok: false, reason: `Tool ${r.toolName} is not available to this step.` };
    case "url":
      return { ok: false, reason: "Web access is not available in this flow." };
    case "memory":
      return { ok: false, reason: "Use the hector memory_search / memory_save tools instead of Copilot memory." };
    default:
      return { ok: false, reason: `${r.kind} is not available in this flow.` };
  }
}

/** Pre-tool hook: reads that never ask for permission still must target readable, non-secret paths. */
export function checkToolUse(ctx: DecisionContext, toolName: string, args: unknown): Verdict {
  if (COPILOT_EXCLUDED_TOOLS.includes(toolName)) return { ok: false, reason: `Tool ${toolName} is not available in this flow.` };
  if (!READ_TOOLS.has(toolName)) return { ok: true }; // writes, shell, MCP: judged by the permission handler
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const paths = ["path", "file_path", "filePath", "file", "dir", "directory"]
    .flatMap((k) => (Array.isArray(a[k]) ? (a[k] as unknown[]) : [a[k]]))
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  if (toolName === "view" || toolName === "read_file") return paths.length ? decide(ctx, "Read", { file_path: paths[0] }) : { ok: true };
  return paths.length ? decide(ctx, "Grep", { path: paths[0] }) : decide(ctx, "Grep", {});
}
