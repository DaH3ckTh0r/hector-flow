import type { z } from "zod";
import type { Effort, Role } from "../config.js";

/**
 * What an agent is allowed to do to the worktree.
 *  - readonly: read and search only.
 *  - edit:     may write files outside locked paths and run allowlisted commands.
 *  - tests:    may write files ONLY inside locked paths (the test author).
 */
export type AgentMode = "readonly" | "edit" | "tests";

export interface AgentRequest<S extends z.ZodType> {
  role: Role;
  mode: AgentMode;
  cwd: string;
  systemPrompt: string;
  prompt: string;
  schema: S;
  /**
   * Continue an earlier session instead of starting fresh. Used to send
   * defects back to the worker that wrote the code, with its context intact.
   */
  resumeSessionId?: string;
  /**
   * When present, the agent gets an `ask` tool. The workflow answers from the
   * ticket, research and plan; the agent never blocks waiting for a human.
   */
  ask?: (question: string) => Promise<string>;
  /**
   * Where this agent may write and what it may run. `root` is the worktree,
   * `writeRoot` the component folder inside it; lockedPaths are root-relative.
   * Omitted: the whole `cwd`, with the config's top-level lists.
   */
  scope?: AgentScope;
  /** Extra absolute folders the agent may read (other repos of the same ticket). */
  readDirs?: string[];
  /** Model and effort resolved for this step (config over skill front-matter). */
  model?: string;
  effort?: Effort;
  /** Claude Code skills this step may use. An empty list hides all skills from the agent. */
  claudeSkills?: string[];
  /** Absolute paths of local Claude Code plugins to load (skills only; their MCP servers are not loaded). */
  plugins?: string[];
  /** Persistent memory tools for this step; each one present becomes an MCP tool. */
  memory?: {
    search?: (query: string, limit?: number) => Promise<string>;
    save?: (input: MemorySaveInput) => Promise<string>;
  };
  /** Names of external MCP servers (config.mcpServers) this step may use. */
  mcpServers?: string[];
}

export interface MemorySaveInput {
  title: string;
  content: string;
  kind: "decision" | "discovery" | "convention" | "gotcha";
  tags?: string[];
  files?: string[];
}

export interface AgentScope {
  root: string;
  writeRoot: string;
  /** Locked globs of every component in this repo: no implementer may touch them. */
  lockedPaths: string[];
  /** This component's own test globs: the only places its test author may write (may be outside writeRoot). */
  testPaths?: string[];
  allowedCommands: string[];
  /** Paths no tool may read (secrets). Relative globs match under any readable root; ~ and / are absolute. */
  readDeny?: string[];
}

export interface AgentResult<T> {
  output: T;
  /** Session id to resume this agent later, if the runtime supports it. */
  sessionId?: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  /** Tool calls the guards refused, for the run log. */
  denials: Array<{ tool: string; reason: string }>;
}

/**
 * The seam between the workflow and whatever runs the agent. The workflow
 * never sees prompts turn into tool calls; it hands over a task and gets back
 * validated JSON. Swap Claude for another agentic runtime by implementing this.
 */
export interface AgentRunner {
  run<S extends z.ZodType>(req: AgentRequest<S>): Promise<AgentResult<z.infer<S>>>;
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly role: Role,
    readonly costUsd = 0,
  ) {
    super(message);
  }
}
