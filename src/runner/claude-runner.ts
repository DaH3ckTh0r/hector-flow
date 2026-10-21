import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type HookCallback,
  type Options,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import type { FlowConfig } from "../config.js";
import { isCommandAllowed, PathPolicy, ReadPolicy } from "../guards.js";
import { toJsonSchema } from "../schemas.js";
import { AgentError, type AgentMode, type AgentRequest, type AgentResult, type AgentRunner } from "./agent-runner.js";

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Built-in tools of the in-process "hector" MCP server; each is registered only when the step gets it. */
const HECTOR_TOOLS = new Set(["mcp__hector__ask", "mcp__hector__memory_search", "mcp__hector__memory_save"]);

/** Everything decide() needs to judge one tool call. */
export interface DecisionContext {
  mode: AgentMode;
  cwd: string;
  write: PathPolicy;
  tests: PathPolicy;
  read: ReadPolicy;
  allowedCommands: string[];
  skillsEnabled: boolean;
  /** External MCP servers this step may use. */
  mcpServers: string[];
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * Runs each step as a Claude Agent SDK session inside the worktree.
 *
 * Every tool call is judged by decide() twice over: in a PreToolUse hook (which
 * runs for every call, including reads that never ask for permission) and in
 * canUseTool (for calls that do ask). decide() enforces the step's mode, the
 * readable roots and the read deny-list, component write isolation, locked
 * tests and the command allowlist. Web tools, subagents and external MCP are
 * denied. MCP tools are limited to the workflow's in-process server (ask,
 * memory) and the external servers that mcpAccess grants to the step.
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
    const claudeSkills = req.claudeSkills ?? [];
    const ctx: DecisionContext = {
      mode: req.mode,
      cwd: req.cwd,
      write: new PathPolicy(scope.root, scope.lockedPaths, scope.writeRoot),
      tests: new PathPolicy(scope.root, scope.testPaths ?? scope.lockedPaths),
      read: new ReadPolicy([scope.root, ...(req.readDirs ?? [])], scope.readDeny ?? this.config.readDenyPaths),
      allowedCommands: scope.allowedCommands,
      skillsEnabled: claudeSkills.length > 0,
      mcpServers: (req.mcpServers ?? []).filter((n) => n in this.config.mcpServers),
    };

    const judge = (toolName: string, input: Record<string, unknown>): Verdict => {
      const verdict = decide(ctx, toolName, input);
      if (!verdict.ok && !denials.some((d) => d.tool === toolName && d.reason === verdict.reason)) {
        denials.push({ tool: toolName, reason: verdict.reason });
      }
      return verdict;
    };

    const preToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return { continue: true };
      const verdict = judge(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
      if (verdict.ok) return { continue: true };
      return {
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason },
      };
    };

    const canUseTool: CanUseTool = async (toolName, input) => {
      const verdict = judge(toolName, input);
      return verdict.ok ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: verdict.reason };
    };

    const mcpServers: Options["mcpServers"] = {};
    const allowedTools = [...READ_TOOLS];
    const hectorTools = [];
    if (req.ask) {
      const ask = req.ask;
      hectorTools.push(
        tool(
          "ask",
          "Ask the workflow a question about the ticket, the plan or the intended behavior when the repository does not answer it. " +
            "Use it before guessing on anything that changes behavior. You always get an answer; if it says no authoritative answer exists, " +
            "make the most reasonable decision and record the assumption in your notes.",
          { question: z.string().describe("One specific, self-contained question") },
          async ({ question }) => ({ content: [{ type: "text", text: await ask(question) }] }),
        ),
      );
    }
    if (req.memory?.search) {
      const search = req.memory.search;
      hectorTools.push(
        tool(
          "memory_search",
          "Search this repository's persistent memory: decisions, discoveries, conventions and gotchas recorded by earlier runs. " +
            "Search before deciding something a previous ticket may already have settled.",
          {
            query: z.string().describe("Keywords: component, file, concept or error"),
            limit: z.number().int().min(1).max(20).optional().describe("Maximum results (default 5)"),
          },
          async ({ query, limit }) => ({ content: [{ type: "text", text: await search(query, limit) }] }),
        ),
      );
    }
    if (req.memory?.save) {
      const save = req.memory.save;
      hectorTools.push(
        tool(
          "memory_save",
          "Record something future runs on this repository should know: a decision and its reason, a non-obvious discovery about " +
            "the code, a convention, or a gotcha that cost you time. Not for task progress or things obvious from the code. " +
            "It becomes permanent only if this run completes.",
          {
            title: z.string().describe("Short, searchable summary"),
            content: z.string().describe("The knowledge itself, with the why"),
            kind: z.enum(["decision", "discovery", "convention", "gotcha"]),
            tags: z.array(z.string()).optional(),
            files: z.array(z.string()).optional().describe("Related files, relative to the component folder"),
          },
          async (input) => ({ content: [{ type: "text", text: await save(input) }] }),
        ),
      );
    }
    if (hectorTools.length) {
      mcpServers.hector = createSdkMcpServer({ name: "hector", tools: hectorTools });
      for (const t of hectorTools) allowedTools.push(`mcp__hector__${t.name}`);
    }
    for (const name of ctx.mcpServers) mcpServers[name] = this.config.mcpServers[name]!;

    const options: Options = {
      cwd: req.cwd,
      resume: req.resumeSessionId,
      additionalDirectories: req.readDirs,
      mcpServers,
      model: req.model ?? this.config.models[req.role],
      effort: req.effort ?? this.config.efforts[req.role],
      systemPrompt: { type: "preset", preset: "claude_code", append: req.systemPrompt },
      allowedTools,
      disallowedTools: ["WebFetch", "WebSearch", "Task", "Agent"],
      permissionMode: "default",
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      // Explicit list: a step sees only its own skills, never every skill installed on the machine.
      skills: claudeSkills,
      plugins: (req.plugins ?? []).map((path) => ({ type: "local" as const, path, skipMcpDiscovery: true })),
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
}

/** The permission rules for one tool call. Pure, so it can be tested without a model. */
export function decide(ctx: DecisionContext, toolName: string, input: Record<string, unknown>): Verdict {
  const { mode, cwd } = ctx;

  if (READ_TOOLS.has(toolName)) return checkRead(ctx, toolName, input);
  if (toolName === "TodoWrite" || HECTOR_TOOLS.has(toolName)) return { ok: true };
  if (toolName.startsWith("mcp__")) {
    const server = toolName.split("__")[1] ?? "";
    return ctx.mcpServers.includes(server)
      ? { ok: true }
      : { ok: false, reason: `MCP server "${server}" is not available to this step (see mcpAccess).` };
  }
  if (toolName === "Skill") {
    return ctx.skillsEnabled ? { ok: true } : { ok: false, reason: "No skills are enabled for this step." };
  }

  if (WRITE_TOOLS.has(toolName)) {
    if (mode === "readonly") return { ok: false, reason: "This step is read-only. Return your findings as structured output." };
    const target = String(input.file_path ?? input.notebook_path ?? "");
    if (!ctx.write.toRelative(target, cwd)) return { ok: false, reason: `Path ${target} is outside the workspace.` };
    const readable = ctx.read.check(target, cwd);
    if (!readable.ok) return readable; // never edit secrets either
    if (mode === "tests") {
      // The test author writes exactly where this component's tests live, even outside its folder.
      return ctx.tests.isLocked(target, cwd)
        ? { ok: true }
        : { ok: false, reason: `The test author may only write this component's test files (lockedPaths). ${target} is not one.` };
    }
    if (!ctx.write.isWritable(target, cwd)) {
      return { ok: false, reason: `${target} belongs to another component. You may only write under ${ctx.write.writePrefix || "the workspace"}.` };
    }
    if (ctx.write.isLocked(target, cwd)) {
      return {
        ok: false,
        reason: `${target} is a locked test file. Fix the production code instead; if you believe the test is wrong, say so in your notes.`,
      };
    }
    return { ok: true };
  }

  if (toolName === "Bash") {
    if (mode === "readonly") return { ok: false, reason: "This step is read-only." };
    const verdict = isCommandAllowed(String(input.command ?? ""), ctx.allowedCommands);
    return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason! };
  }

  return { ok: false, reason: `Tool ${toolName} is not available in this flow.` };
}

/** Read, Glob and Grep: the file or folder they target must be readable. */
function checkRead(ctx: DecisionContext, toolName: string, input: Record<string, unknown>): Verdict {
  if (toolName === "Read") return ctx.read.check(String(input.file_path ?? ""), ctx.cwd);

  const targets: string[] = [typeof input.path === "string" && input.path ? input.path : ctx.cwd];
  // An absolute Glob pattern targets the folder before its first wildcard.
  if (toolName === "Glob" && typeof input.pattern === "string" && isAbsolute(input.pattern)) {
    const staticPart = input.pattern.split(/[*?[{]/)[0]!;
    targets.push(staticPart.endsWith("/") ? staticPart : dirname(staticPart));
  }
  for (const t of targets) {
    const v = ctx.read.check(t, ctx.cwd);
    if (!v.ok) return v;
  }
  return { ok: true };
}
