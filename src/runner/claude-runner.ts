import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type Options,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { FlowConfig } from "../config.js";
import { isCommandAllowed, PathPolicy } from "../guards.js";
import { toJsonSchema } from "../schemas.js";
import { AgentError, type AgentMode, type AgentRequest, type AgentResult, type AgentRunner } from "./agent-runner.js";

const READ_TOOLS = ["Read", "Glob", "Grep"];
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const ASK_TOOL = "mcp__hector__ask";

/**
 * Runs each step as a Claude Agent SDK session inside the worktree.
 * Read tools are pre-approved; every write and shell call goes through
 * `canUseTool`, which enforces the step's mode, the locked paths and the
 * command allowlist. Anything else (web, external MCP, subagents) is denied.
 * The only MCP tool is the workflow's own in-process `ask`.
 */
export class ClaudeAgentRunner implements AgentRunner {
  constructor(private readonly config: FlowConfig) {}

  async run<S extends z.ZodType>(req: AgentRequest<S>): Promise<AgentResult<z.infer<S>>> {
    const started = Date.now();
    const denials: AgentResult<unknown>["denials"] = [];
    const scope = req.scope ?? {
      root: req.cwd,
      writeRoot: req.cwd,
      lockedPaths: this.config.lockedPaths,
      allowedCommands: this.config.allowedCommands,
    };
    const policy = new PathPolicy(scope.root, scope.lockedPaths, scope.writeRoot);
    const testPolicy = new PathPolicy(scope.root, scope.testPaths ?? scope.lockedPaths);

    const canUseTool: CanUseTool = async (toolName, input) => {
      const verdict = this.decide(req.mode, toolName, input, policy, testPolicy, req.cwd, scope.allowedCommands);
      if (verdict.ok) return { behavior: "allow", updatedInput: input };
      denials.push({ tool: toolName, reason: verdict.reason });
      return { behavior: "deny", message: verdict.reason };
    };

    const mcpServers: Options["mcpServers"] = {};
    const allowedTools = [...READ_TOOLS];
    if (req.ask) {
      const ask = req.ask;
      mcpServers.hector = createSdkMcpServer({
        name: "hector",
        tools: [
          tool(
            "ask",
            "Ask the workflow a question about the ticket, the plan or the intended behavior when the repository does not answer it. " +
              "Use it before guessing on anything that changes behavior. You always get an answer; if it says no authoritative answer exists, " +
              "make the most reasonable decision and record the assumption in your notes.",
            { question: z.string().describe("One specific, self-contained question") },
            async ({ question }) => ({ content: [{ type: "text", text: await ask(question) }] }),
          ),
        ],
      });
      allowedTools.push(ASK_TOOL);
    }

    const options: Options = {
      cwd: req.cwd,
      resume: req.resumeSessionId,
      additionalDirectories: req.readDirs,
      mcpServers,
      model: this.config.models[req.role],
      effort: this.config.efforts[req.role],
      systemPrompt: { type: "preset", preset: "claude_code", append: req.systemPrompt },
      allowedTools,
      disallowedTools: ["WebFetch", "WebSearch", "Task", "Agent"],
      permissionMode: "default",
      canUseTool,
      maxTurns: this.config.policy.maxTurnsPerAgent,
      maxBudgetUsd: this.config.policy.maxBudgetUsdPerAgent,
      settingSources: this.config.loadProjectSettings ? ["project"] : [],
      outputFormat: { type: "json_schema", schema: toJsonSchema(req.schema) },
    };

    let result: SDKResultMessage | undefined;
    for await (const message of query({ prompt: req.prompt, options })) {
      if (message.type === "result") result = message;
    }

    if (!result) throw new AgentError("Agent ended without a result message", req.role);
    if (result.subtype !== "success") {
      throw new AgentError(`Agent failed: ${result.subtype}`, req.role, result.total_cost_usd);
    }

    const parsed = req.schema.safeParse(result.structured_output);
    if (!parsed.success) {
      throw new AgentError(`Structured output did not match the contract: ${parsed.error.message}`, req.role, result.total_cost_usd);
    }

    return {
      output: parsed.data,
      sessionId: result.session_id,
      costUsd: result.total_cost_usd,
      turns: result.num_turns,
      durationMs: Date.now() - started,
      denials,
    };
  }

  private decide(
    mode: AgentMode,
    tool: string,
    input: Record<string, unknown>,
    policy: PathPolicy,
    testPolicy: PathPolicy,
    cwd: string,
    allowedCommands: string[],
  ): { ok: true } | { ok: false; reason: string } {
    if (READ_TOOLS.includes(tool) || tool === "TodoWrite" || tool === ASK_TOOL) return { ok: true };

    if (WRITE_TOOLS.has(tool)) {
      if (mode === "readonly") return { ok: false, reason: "This step is read-only. Return your findings as structured output." };
      const target = String(input.file_path ?? input.notebook_path ?? "");
      if (!policy.toRelative(target, cwd)) return { ok: false, reason: `Path ${target} is outside the workspace.` };
      if (mode === "tests") {
        // The test author writes exactly where this component's tests live, even outside its folder.
        return testPolicy.isLocked(target, cwd)
          ? { ok: true }
          : { ok: false, reason: `The test author may only write this component's test files (lockedPaths). ${target} is not one.` };
      }
      if (!policy.isWritable(target, cwd)) {
        return { ok: false, reason: `${target} belongs to another component. You may only write under ${policy.writePrefix || "the workspace"}.` };
      }
      if (policy.isLocked(target, cwd)) {
        return {
          ok: false,
          reason: `${target} is a locked test file. Fix the production code instead; if you believe the test is wrong, say so in your notes.`,
        };
      }
      return { ok: true };
    }

    if (tool === "Bash") {
      if (mode === "readonly") return { ok: false, reason: "This step is read-only." };
      const verdict = isCommandAllowed(String(input.command ?? ""), allowedCommands);
      return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason! };
    }

    return { ok: false, reason: `Tool ${tool} is not available in this flow.` };
  }
}
