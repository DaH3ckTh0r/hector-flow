import { Codex, type CodexOptions, type ThreadOptions, type ThreadItem, type Usage } from "@openai/codex-sdk";
import type { z } from "zod";
import type { FlowConfig } from "../config.js";
import { toJsonSchema } from "../schemas.js";
import { ToolBridge } from "../tool-bridge.js";
import { AgentError, type AgentRequest, type AgentResult, type AgentRunner } from "./agent-runner.js";
import { resolvedScope } from "./claude-runner.js";
import { dropNulls, strictify } from "./strict-schema.js";

/** The slice of the Codex SDK this runner uses, so tests can inject a fake. */
export interface CodexLike {
  startThread(options?: ThreadOptions): ThreadLike;
  resumeThread(id: string, options?: ThreadOptions): ThreadLike;
}
export interface ThreadLike {
  readonly id: string | null;
  run(input: string, options?: { outputSchema?: unknown; signal?: AbortSignal }): Promise<{
    items: ThreadItem[];
    finalResponse: string;
    usage: Usage | null;
  }>;
}
export type CodexFactory = (options: CodexOptions) => CodexLike;

/**
 * Runs a step with the OpenAI Codex SDK (`codex exec` under the hood).
 *
 * Codex has no per-tool-call permission hook, so isolation comes from its OS
 * sandbox instead of decide():
 *  - readonly → sandbox "read-only": nothing on disk can change.
 *  - edit     → "workspace-write" rooted at the component folder: writes
 *               outside it are blocked by the OS.
 *  - tests    → "workspace-write" rooted at the worktree (tests may live
 *               outside the component); the workflow then reverts any
 *               non-test file.
 * Network is off and approvals are never requested. Locked tests, files
 * outside the component and undeclared files are still enforced by the
 * workflow's git checks after the step. Not enforced with Codex: the read
 * deny-list and the command allowlist (Codex reads and runs through its shell).
 *
 * The workflow's ask/memory tools are served to Codex over a local HTTP MCP
 * bridge; external servers granted by mcpAccess are passed as Codex config.
 */
export class CodexAgentRunner implements AgentRunner {
  private readonly bridge = new ToolBridge();

  constructor(
    private readonly config: FlowConfig,
    private readonly factory: CodexFactory = (o) => new Codex(o),
  ) {}

  async run<S extends z.ZodType>(req: AgentRequest<S>): Promise<AgentResult<z.infer<S>>> {
    const started = Date.now();
    const scope = resolvedScope(req, this.config);
    const settings = this.config.runtime.codex;
    const route = await this.bridge.register({ ask: req.ask, memory: req.memory });
    try {
      const codex = this.factory({
        codexPathOverride: settings.path,
        config: this.mcpConfig(req, route?.url),
      });
      const options: ThreadOptions = {
        model: req.model ?? settings.model,
        modelReasoningEffort: req.effort ?? settings.effort,
        sandboxMode: req.mode === "readonly" ? "read-only" : "workspace-write",
        workingDirectory: req.mode === "edit" ? scope.writeRoot : req.mode === "tests" ? scope.root : req.cwd,
        skipGitRepoCheck: true,
        approvalPolicy: "never",
        networkAccessEnabled: settings.networkAccess,
        webSearchMode: "disabled",
      };
      const thread = req.resumeSessionId ? codex.resumeThread(req.resumeSessionId, options) : codex.startThread(options);
      const turn = await thread.run(codexPrompt(req, scope), { outputSchema: strictify(toJsonSchema(req.schema)) });

      const failed = turn.items.find((i) => i.type === "error");
      let raw: unknown;
      try {
        raw = dropNulls(JSON.parse(turn.finalResponse));
      } catch {
        throw new AgentError(
          `Codex did not return JSON${failed && "message" in failed ? ` (${failed.message})` : ""}: ${turn.finalResponse.slice(0, 200)}`,
          req.role,
        );
      }
      const parsed = req.schema.safeParse(raw);
      if (!parsed.success) throw new AgentError(`Structured output did not match the contract: ${parsed.error.message}`, req.role);

      return {
        output: parsed.data,
        sessionId: thread.id ?? undefined,
        costUsd: 0, // Codex reports tokens, not money (see usage in the run log).
        turns: Math.max(1, turn.items.filter((i) => i.type === "command_execution" || i.type === "file_change" || i.type === "mcp_tool_call").length),
        durationMs: Date.now() - started,
        denials: [],
      };
    } catch (err) {
      if (err instanceof AgentError) throw err;
      throw new AgentError(`Codex failed: ${(err as Error).message}`, req.role);
    } finally {
      this.bridge.unregister(route?.token);
    }
  }

  async close(): Promise<void> {
    await this.bridge.close();
  }

  /** `--config` overrides: the hector bridge plus the external MCP servers granted to this step. */
  private mcpConfig(req: AgentRequest<z.ZodType>, bridgeUrl: string | undefined): CodexOptions["config"] {
    const servers: Record<string, Record<string, string | string[] | Record<string, string>>> = {};
    if (bridgeUrl) servers.hector = { url: bridgeUrl };
    for (const name of req.mcpServers ?? []) {
      const s = this.config.mcpServers[name];
      if (!s) continue;
      if ("command" in s) {
        servers[name] = { command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}) };
      } else if (s.type === "http") {
        servers[name] = { url: s.url, ...(s.headers ? { http_headers: s.headers } : {}) };
      }
      // SSE servers are not supported by Codex; `check` warns about them.
    }
    return Object.keys(servers).length ? { mcp_servers: servers } : undefined;
  }
}

/** Codex has no system prompt option: the step's instructions and its limits go first in the prompt. */
export function codexPrompt(req: AgentRequest<z.ZodType>, scope: ReturnType<typeof resolvedScope>): string {
  const limits: string[] = [];
  if (req.mode === "readonly") limits.push("This step is read-only: do not modify any file.");
  if (req.mode === "edit") {
    limits.push(`Write only inside ${scope.writeRoot}.`);
    if (scope.lockedPaths.length) limits.push(`Never modify locked test files: ${scope.lockedPaths.join(", ")}.`);
  }
  if (req.mode === "tests") limits.push(`Write only test files matching: ${(scope.testPaths ?? scope.lockedPaths).join(", ")}.`);
  if (req.mode !== "readonly" && scope.allowedCommands.length) limits.push(`Run only these commands: ${scope.allowedCommands.join(", ")}.`);
  if (req.readDirs?.length) limits.push(`You may also read (not write) these folders: ${req.readDirs.join(", ")}.`);
  if (req.ask || req.memory) limits.push("Workflow tools are available from the MCP server named \"hector\".");
  return [
    req.systemPrompt,
    limits.length ? `## Limits of this step\n\n${limits.map((l) => `- ${l}`).join("\n")}` : "",
    "## Task",
    req.prompt,
    "Finish with a single JSON object that matches the output schema.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
