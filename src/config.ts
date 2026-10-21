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

export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

export const RuntimeNameSchema = z.enum(["claude", "codex", "opencode"]);
export type RuntimeName = z.infer<typeof RuntimeNameSchema>;

/** A step's runtime: just a name, or a name with the model and effort to use there. */
const StepRuntimeSchema = z.union([
  RuntimeNameSchema,
  z.object({ use: RuntimeNameSchema, model: z.string().optional(), effort: EffortSchema.optional() }),
]);

/** Secret-looking files no agent may read. Override with `readDenyPaths` (set [] to disable). */
export const DEFAULT_READ_DENY = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.pfx",
  "**/*.p12",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/.npmrc",
  "**/.pypirc",
  "**/.netrc",
  "**/secrets.json",
  "**/*.secrets.json",
  "**/appsettings.*.local.json",
  "**/local.settings.json",
  "~/.ssh/**",
  "~/.aws/**",
  "~/.azure/**",
  "~/.config/gcloud/**",
  "~/.kube/**",
  "~/.docker/config.json",
];

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
  /**
   * Extra folders with step skills (<dir>/<role>/SKILL.md), relative to the
   * primary repo, searched in order before <repo>/.hector/skills and the built-ins.
   */
  skillDirs: z.array(z.string()).default([]),
  /** Claude Code skills each step may use, by name (or plugin:skill). Merged with the step skill's front-matter. */
  claudeSkills: z.partialRecord(RoleSchema, z.array(z.string())).default({}),
  /** Local Claude Code plugin folders (skills, agents, hooks) loaded into every agent. Relative to the primary repo. */
  pluginDirs: z.array(z.string()).default([]),
  /**
   * Which agent runtime runs each step: Claude (Agent SDK), Codex (OpenAI
   * Codex SDK) or OpenCode. models/efforts and skill front-matter models are
   * Claude models; for other runtimes set the model here.
   */
  runtime: z
    .object({
      default: RuntimeNameSchema.default("claude"),
      steps: z.partialRecord(RoleSchema, StepRuntimeSchema).default({}),
      codex: z
        .object({
          /** Default model for Codex steps (e.g. "gpt-5.5-codex"). Omit for Codex's default. */
          model: z.string().optional(),
          effort: EffortSchema.optional(),
          /** Let sandboxed commands use the network. Off by default. */
          networkAccess: z.boolean().default(false),
          /** Path to a codex binary instead of the one bundled with the SDK. */
          path: z.string().optional(),
        })
        .prefault({}),
      opencode: z
        .object({
          /** Default model for OpenCode steps, as "provider/model" (e.g. "anthropic/claude-sonnet-4-5"). */
          model: z.string().regex(/^[^/]+\/.+$/, 'use "provider/model"').optional(),
          hostname: z.string().default("127.0.0.1"),
          /** Port for `opencode serve`. 0 lets the system choose (allows several runs at once). */
          port: z.number().int().min(0).default(0),
        })
        .prefault({}),
    })
    .prefault({}),
  /** Persistent memory shared by every run on this repo (built-in MCP tools memory_search / memory_save). */
  memory: z
    .object({
      enabled: z.boolean().default(true),
      /** Steps that get memory_search. */
      search: z.array(RoleSchema).default(["enrich", "plan", "testAuthor", "coder", "diagnose", "review", "lead"]),
      /** Steps that get memory_save. */
      save: z.array(RoleSchema).default(["enrich", "coder", "diagnose"]),
      /** Memories injected into the enrich prompt (most relevant to the ticket). 0 to disable. */
      injectIntoEnrich: z.number().int().min(0).default(5),
    })
    .prefault({}),
  /**
   * External MCP servers agents may use (Engram, Context7, …), by name. Same
   * shape as Claude Code's mcpServers. Which steps see which server: mcpAccess.
   */
  mcpServers: z
    .record(
      z.string().regex(/^[a-zA-Z][\w-]*$/).refine((n) => n !== "hector", "'hector' is reserved for built-in tools"),
      z.union([
        z.object({
          type: z.literal("stdio").optional(),
          command: z.string(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string(), z.string()).optional(),
        }),
        z.object({
          type: z.enum(["http", "sse"]),
          url: z.string().url(),
          headers: z.record(z.string(), z.string()).optional(),
        }),
      ]),
    )
    .default({}),
  /** Step → MCP server names it may use. A server not listed for a step is invisible to it. */
  mcpAccess: z.partialRecord(RoleSchema, z.array(z.string())).default({}),
  /** Where `hector-flow start` takes tickets from. */
  backlog: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("folder"),
        /** Folder with ticket .md files, relative to the primary repo or absolute. */
        path: z.string(),
      }),
      z.object({
        type: z.literal("github"),
        /** owner/name */
        repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
        /** Only open issues with this label. */
        label: z.string().default("hector"),
        /** Environment variable with the token. */
        tokenEnv: z.string().default("GITHUB_TOKEN"),
        /** Post the run's result as an issue comment. */
        comment: z.boolean().default(true),
      }),
      z.object({
        type: z.literal("azure-devops"),
        organization: z.string(),
        project: z.string(),
        /** Only work items with this tag… */
        tag: z.string().default("hector"),
        /** …in one of these states. */
        states: z.array(z.string()).default(["New", "Approved", "Committed", "To Do", "Active"]),
        /** Full WIQL query instead of tag + states. Must select [System.Id]. */
        wiql: z.string().optional(),
        /** Environment variable with a Personal Access Token (Work Items: read & write). */
        tokenEnv: z.string().default("AZURE_DEVOPS_PAT"),
        comment: z.boolean().default(true),
      }),
    ])
    .optional(),
  /** Continuous loop (`hector-flow start`). */
  loop: z
    .object({
      /**
       * manual: implement and leave the branches. supervised: implement, then wait
       * for `approve`/`reject`. auto: implement and merge completed tickets.
       */
      mode: z.enum(["manual", "supervised", "auto"]).default("supervised"),
      /** Seconds between backlog checks when there is nothing to do. */
      intervalSeconds: z.number().int().min(5).default(60),
      /** auto mode: only merge tickets with no open assumptions. */
      autoMergeRequiresNoAssumptions: z.boolean().default(true),
    })
    .prefault({}),
  /**
   * Paths agents may never read, even inside their workspace. Globs: relative
   * ones match anywhere under a readable root; ones starting with ~ or / are absolute.
   */
  readDenyPaths: z.array(z.string()).default(DEFAULT_READ_DENY),
  /** Independent reviewers ("judgment day"). All must approve. Default: one reviewer with the review role's model. */
  review: z
    .object({
      judges: z
        .array(
          z.object({
            name: z.string().regex(/^[a-z][a-z0-9-]*$/, "judge names: lowercase, digits, dashes"),
            /** Runtime for this judge (default: the review step's). Its model is a model of that runtime. */
            runtime: RuntimeNameSchema.optional(),
            model: z.string().optional(),
            effort: EffortSchema.optional(),
            /** Extra instructions for this judge, e.g. "Focus on security and data exposure." */
            focus: z.string().optional(),
          }),
        )
        .min(1)
        .default([{ name: "reviewer" }]),
    })
    .prefault({}),
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
