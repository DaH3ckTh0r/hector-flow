import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const RoleSchema = z.enum([
  "enrich",
  "plan",
  "testAuthor",
  "coder",
  "diagnose",
  "review",
  "qaPlan",
  "distill",
  "lead",
]);
export type Role = z.infer<typeof RoleSchema>;

const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

/**
 * A deployable part of the system — backend, middleware, frontend — with its
 * own checks. Components can live in separate repos or in folders of one repo.
 */
export const ComponentSchema = z.object({
  /** What this component is, shown to the planner. */
  description: z.string().optional(),
  /** Repository path, relative to --repo. Default: --repo itself. */
  repo: z.string().default("."),
  /** Folder inside the repo. Workers of this component can only write here. */
  path: z.string().default("."),
  buildCommand: z.string().optional(),
  testCommand: z.string(),
  lintCommand: z.string().optional(),
  /** Relative to `path`. Default: the top-level lockedPaths. */
  lockedPaths: z.array(z.string()).optional(),
  /** Default: the top-level allowedCommands. */
  allowedCommands: z.array(z.string()).optional(),
});
export type ComponentConfig = z.infer<typeof ComponentSchema>;

export const ConfigSchema = z.object({
  /**
   * Components the flow may touch. Omit for a single-component repo and use
   * the top-level build/test/lint commands instead.
   */
  components: z
    .record(z.string().regex(/^[a-z][a-z0-9-]*$/, "component names: lowercase, digits, dashes"), ComponentSchema)
    .optional(),
  /** Single-component shorthand: command that must pass for the ticket to be done. */
  testCommand: z.string().optional(),
  /** Optional build/typecheck command run before tests. */
  buildCommand: z.string().optional(),
  /** Optional linter run after tests. */
  lintCommand: z.string().optional(),
  /**
   * Globs the coder may never modify. Tests written from the acceptance criteria
   * live here, so the coder cannot "fix" a failure by weakening the test.
   */
  lockedPaths: z.array(z.string()).default(["test/**", "tests/**", "**/*.test.*", "**/*.spec.*"]),
  /**
   * Bash commands an editing agent may run, matched by prefix. Acceptance
   * commands proposed by the test author must also match one of these.
   * Chaining, redirection and substitution are always rejected.
   */
  allowedCommands: z.array(z.string()).default([]),
  /** Model per step. Tune by trial and error: implementation burns most tokens. */
  models: z.partialRecord(RoleSchema, z.string()).default({}),
  /** Reasoning effort per step. */
  efforts: z.partialRecord(RoleSchema, EffortSchema).default({}),
  policy: z
    .object({
      /** Total automatic repairs per run, across every route. */
      repairAttempts: z.number().int().min(0).default(3),
      /**
       * Times a defect goes back to the worker that wrote the code (resuming
       * its session) before a fresh implementer takes over.
       */
      sameWorkerRetries: z.number().int().min(0).default(2),
      /** Questions workers may ask per run before they must decide alone. */
      maxQuestions: z.number().int().min(0).default(10),
      /**
       * Files a worker changed but did not declare in changedFiles.
       * revert: discard them (strict, like committing exact files).
       * commit: keep them, but flag them in the ledger.
       */
      undeclaredFiles: z.enum(["revert", "commit"]).default("revert"),
      reviewRounds: z.number().int().min(0).default(1),
      /** Workers running at the same time, each in its own worktree. */
      maxParallel: z.number().int().min(1).default(3),
      maxTurnsPerAgent: z.number().int().min(1).default(40),
      maxBudgetUsdPerAgent: z.number().positive().optional(),
    })
    .prefault({}),
  /**
   * Run when the flow finishes or needs a human. Receives HECTOR_STATUS,
   * HECTOR_TICKET, HECTOR_SUMMARY (path to summary.json) as env vars.
   * Example: a curl to a Teams/Slack webhook, or `osascript -e 'display notification ...'`.
   */
  notifyCommand: z.string().optional(),
  /** Where worktrees are created. Relative to the repo's parent folder. */
  workspacesDir: z.string().default(".hector-workspaces"),
  /** Load the repo's CLAUDE.md / .claude settings into each agent. */
  loadProjectSettings: z.boolean().default(true),
}).refine((c) => c.components ? Object.keys(c.components).length > 0 : !!c.testCommand, {
  message: "Define either 'components' (one or more) or a top-level 'testCommand'.",
});
export type FlowConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(repo: string, explicitPath?: string): Promise<FlowConfig> {
  const path = explicitPath ?? join(repo, "hector-flow.config.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(`Could not read config at ${path}: ${(err as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config at ${path}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
