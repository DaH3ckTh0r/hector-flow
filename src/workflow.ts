import { basename, dirname, join, posix, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { z } from "zod";
import { resolveComponents, type Component } from "./components.js";
import type { Effort, FlowConfig, Role } from "./config.js";
import { isCommandAllowed, PathPolicy } from "./guards.js";
import { LessonStore, type ErrorLesson } from "./lessons.js";
import { MemoryStore, renderMemories } from "./memory.js";
import { RunLog } from "./log.js";
import { KeyedMutex } from "./mutex.js";
import {
  prompts,
  renderDiagnosis,
  renderIssues,
  systemPrompt,
  type ComponentInfo,
  type LedgerEntry,
} from "./prompts.js";
import type { AgentMode, AgentRequest, AgentResult, AgentRunner, AgentScope } from "./runner/agent-runner.js";
import { runDag, validateDag } from "./scheduler.js";
import { resolveRuntime } from "./runtimes.js";
import { commandEnv } from "./tools/env.js";
import { addCounts, emptyCounts, type TokenCounts, type Usage } from "./usage.js";
import { loadSkills, resolveStep, type SkillSet } from "./skills.js";
import {
  AnswerSchema,
  DiagnosisSchema,
  DiscoverySchema,
  ImplementationSchema,
  PlanSchema,
  QaPlanSchema,
  ReviewSchema,
  TestAuthoringSchema,
  type AcceptanceCheck,
  type Diagnosis,
  type Discovery,
  type Implementation,
  type Plan,
  type PlanTask,
  type Review,
} from "./schemas.js";
import type { Ticket } from "./ticket.js";
import {
  abortMerge,
  addWorktree,
  assertClean,
  changedFiles,
  commitAll,
  commitFiles,
  concludeMerge,
  diff,
  filesWithConflictMarkers,
  git,
  merge,
  removeWorktree,
  restoreFiles,
  type Workspace,
} from "./tools/git.js";
import { runShell } from "./tools/shell.js";

export type RunStatus = "completed" | "needs_human" | "failed";

export interface QuestionRecord {
  asker: string;
  question: string;
  answer: string;
  confident: boolean;
  basis: string;
}

export interface RepoSummary {
  name: string;
  root: string;
  branch: string;
  worktree: string;
  baseRef: string;
  /** Branch that was checked out when the run started (the merge target in supervised/auto mode). */
  baseBranch?: string;
  testsRef?: string;
  /** Last commit made by the flow. Human corrections after it feed `distill`. */
  flowCommit?: string;
}

export interface RunSummary {
  runId: string;
  ticketId: string;
  status: RunStatus;
  reason?: string;
  /** One entry per repository the ticket touched. */
  repos: RepoSummary[];
  /** Primary repository, kept for single-repo convenience. */
  branch?: string;
  worktree?: string;
  flowCommit?: string;
  tasks: number;
  maxConcurrentWorkers: number;
  repairAttempts: number;
  reviewRounds: number;
  questionsAsked: number;
  /** Memories saved during the run (validated only if the run completed). */
  memoriesSaved: number;
  /** Questions nobody could settle: the worker decided alone. Check these. */
  openAssumptions: QuestionRecord[];
  costUsd: number;
  /** Tokens consumed by every agent call of the run (failed calls included). */
  usage: RunUsage;
  durationMs: number;
  runDir: string;
}

export interface RunUsage {
  total: TokenCounts;
  /** Key: "<model> (<runtime>)". */
  byModel: Record<string, TokenCounts>;
  byRuntime: Record<string, TokenCounts>;
}

class StopFlow extends Error {
  constructor(
    readonly status: Exclude<RunStatus, "completed">,
    message: string,
  ) {
    super(message);
  }
}

interface CheckResult {
  ok: boolean;
  output: string;
}

interface RepoState {
  root: string;
  baseBranch?: string;
  name: string;
  integration: Workspace;
  testsRef?: string;
  /** Union of locked globs of every component in this repo. */
  lockedPaths: string[];
}

interface Comp extends Component {
  repo: RepoState;
  info: ComponentInfo;
}

/** Where an agent works: a component inside a specific worktree. */
interface Place {
  comp: Comp;
  wt: string;
}

/** An implementer that owns a plan task, in its own worktree, kept so defects can go back to it. */
interface Worker {
  taskId: string;
  comp: Comp;
  ws: Workspace;
  sessionId?: string;
  /** Repo-relative files this worker committed. */
  files: Set<string>;
  resumes: number;
  integrated: boolean;
}

/** Shared paths for runs and lessons, next to the primary repository. */
export function flowPaths(repoRoot: string, config: FlowConfig) {
  const root = resolve(dirname(repoRoot), config.workspacesDir);
  return {
    root,
    runs: join(root, "_runs"),
    lessons: join(root, "_lessons", `${basename(repoRoot)}.json`),
    memory: join(root, "_memory", `${basename(repoRoot)}.jsonl`),
    loop: join(root, "_loop"),
  };
}

/**
 * The whole flow, as ordinary TypeScript. Step order, retry budgets, what
 * counts as done and when to stop are decided here — never by a model.
 *
 *  RESEARCH        enrich → plan (tasks per component, with dependencies)
 *                  → locked tests + executable acceptance map, per component
 *  IMPLEMENTATION  dependency graph, up to maxParallel workers at once, each in
 *                  its own worktree: implement → build gate → merge into the
 *                  repo's integration branch (conflicts go back to that worker)
 *                  → stabilize ⟲ per component
 *  VERIFICATION    review ⟲ across components → QA ⟲ per component → test plan → notify
 *
 *  ⟲ = diagnose → route the defect to the worker that owns the files (resumed,
 *      ≤ sameWorkerRetries) → otherwise a fresh implementer → otherwise a human.
 */
export async function implementTicket(opts: {
  repo: string;
  ticket: Ticket;
  config: FlowConfig;
  runner: AgentRunner;
}): Promise<RunSummary> {
  const { ticket, config, runner } = opts;
  const started = Date.now();
  const primaryRoot = await git(resolve(opts.repo), "rev-parse", "--show-toplevel");
  const paths = flowPaths(primaryRoot, config);
  const ticketDir = join(paths.root, ticket.id);
  const runId = `${ticket.id}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`;
  const log = await RunLog.create(paths.runs, runId);
  const lessons = await LessonStore.open(paths.lessons);
  const memory = await MemoryStore.open(paths.memory);
  let memoriesSaved = 0;
  const pluginPaths = config.pluginDirs.map((d) => resolve(primaryRoot, d));
  let skillSet: SkillSet | undefined;
  const repoLock = new KeyedMutex();

  // Commands the flow runs execute agent-written code: no credentials in their environment.
  const { env: cmdEnv } = commandEnv(config);
  let costUsd = 0;
  const usageByModel: Record<string, TokenCounts> = {};
  const usageByRuntime: Record<string, TokenCounts> = {};
  const recordUsage = (runtime: string, usage: Usage | undefined) => {
    for (const [model, c] of Object.entries(usage ?? {})) {
      addCounts((usageByModel[`${model} (${runtime})`] ??= emptyCounts()), c);
      addCounts((usageByRuntime[runtime] ??= emptyCounts()), c);
    }
  };
  let repairAttempts = 0;
  let reviewRounds = 0;
  let activeWorkers = 0;
  let maxConcurrentWorkers = 0;
  let research: Discovery | undefined;
  let plan: Plan | undefined;
  const repos = new Map<string, RepoState>();
  const comps: Comp[] = [];
  const ledger: LedgerEntry[] = [];
  const workers: Worker[] = [];
  const questions: QuestionRecord[] = [];

  const repoSummaries = (): RepoSummary[] =>
    [...repos.values()].map((r) => ({
      name: r.name,
      root: r.root,
      branch: r.integration.branch,
      worktree: r.integration.path,
      baseRef: r.integration.baseRef,
      baseBranch: r.baseBranch,
      testsRef: r.testsRef,
    }));

  const summary = (status: RunStatus, reason: string | undefined, repoInfo: RepoSummary[]): RunSummary => {
    const primary = repoInfo.find((r) => r.root === primaryRoot) ?? repoInfo[0];
    return {
      runId,
      ticketId: ticket.id,
      status,
      reason,
      repos: repoInfo,
      branch: primary?.branch,
      worktree: primary?.worktree,
      flowCommit: primary?.flowCommit,
      tasks: plan?.tasks.length ?? 0,
      maxConcurrentWorkers,
      repairAttempts,
      reviewRounds,
      questionsAsked: questions.length,
    memoriesSaved,
      openAssumptions: questions.filter((q) => !q.confident),
      costUsd: Math.round(costUsd * 10_000) / 10_000,
      usage: {
        total: Object.values(usageByRuntime).reduce((acc, c) => addCounts(acc, c), emptyCounts()),
        byModel: usageByModel,
        byRuntime: usageByRuntime,
      },
      durationMs: Date.now() - started,
      runDir: log.runDir,
    };
  };

  // ── Places, scopes and agents ───────────────────────────────────────────
  const dirOf = (p: Place) => (p.comp.path === "." ? p.wt : join(p.wt, p.comp.path));
  const home = (comp: Comp): Place => ({ comp, wt: comp.repo.integration.path });

  function scopeFor(p: Place): AgentScope {
    return {
      root: p.wt,
      writeRoot: dirOf(p),
      lockedPaths: p.comp.repo.lockedPaths,
      testPaths: p.comp.lockedPaths,
      allowedCommands: p.comp.allowedCommands,
      readDeny: config.readDenyPaths,
    };
  }

  /** Other repos' integration worktrees (and this repo's, when working in a task worktree) are readable. */
  function readDirsFor(p: Place): string[] {
    return [...repos.values()].map((r) => r.integration.path).filter((d) => d !== p.wt);
  }

  /** memory_search / memory_save for a step, per config.memory. */
  function memoryToolsFor(role: Role, step: string): AgentRequest<z.ZodType>["memory"] {
    if (!config.memory.enabled) return undefined;
    const tools: NonNullable<AgentRequest<z.ZodType>["memory"]> = {};
    if (config.memory.search.includes(role)) {
      tools.search = async (query, limit) => {
        const hits = memory.search(query, { limit: limit ?? 5, runId });
        return hits.length ? renderMemories(hits) : "No memories match. Try other keywords, or continue without.";
      };
    }
    if (config.memory.save.includes(role)) {
      tools.save = async (input) => {
        const e = await memory.save({
          title: input.title,
          content: input.content,
          kind: input.kind,
          tags: input.tags ?? [],
          files: input.files ?? [],
          ticketId: ticket.id,
          runId,
          role,
        });
        if (e.runId === runId) {
          memoriesSaved++;
          await log.emit({ type: "info", message: `memory saved by ${step}: [${e.kind}] ${e.title} (${e.id})` });
          return `Saved as memory ${e.id}. It becomes permanent if this run completes.`;
        }
        return `Already known (memory ${e.id}); not saved again.`;
      };
    }
    return Object.keys(tools).length ? tools : undefined;
  }

  async function agentFull<S extends z.ZodType>(
    step: string,
    role: Role,
    mode: AgentMode,
    place: Place,
    prompt: string,
    schema: S,
    extra: {
      attempt?: number;
      resumeSessionId?: string;
      ask?: (q: string) => Promise<string>;
      /** Review judge: its own runtime, model, effort. */
      judge?: FlowConfig["review"]["judges"][number];
    } = {},
  ): Promise<AgentResult<z.infer<S>>> {
    const { attempt } = extra;
    const stepSkill = resolveStep(skillSet!, role, config);
    const choice = resolveRuntime(config, role, stepSkill, extra.judge);
    await log.emit({ type: "step.start", step, attempt, ...(choice.runtime !== "claude" ? { runtime: choice.runtime } : {}) });
    const t0 = Date.now();
    try {
      const res = await runner.run({
        role,
        mode,
        cwd: dirOf(place),
        systemPrompt: systemPrompt(stepSkill.instructions, lessons.guidelinesFor(role)),
        prompt,
        schema,
        resumeSessionId: extra.resumeSessionId,
        ask: extra.ask,
        scope: scopeFor(place),
        readDirs: readDirsFor(place),
        runtime: choice.runtime,
        model: choice.model,
        effort: choice.effort,
        claudeSkills: stepSkill.claudeSkills,
        plugins: pluginPaths,
        memory: memoryToolsFor(role, step),
        mcpServers: config.mcpAccess[role] ?? [],
      });
      costUsd += res.costUsd;
      recordUsage(choice.runtime, res.usage);
      for (const d of res.denials) await log.emit({ type: "guard", step, action: `denied ${d.tool}`, detail: d.reason });
      await log.artifact(`${step}${attempt ? `-${attempt}` : ""}.json`, res.output);
      await log.emit({
        type: "step.end",
        step,
        ok: true,
        durationMs: Date.now() - t0,
        costUsd: res.costUsd,
        attempt,
        role,
        runtime: choice.runtime,
        usage: res.usage,
      });
      return res;
    } catch (err) {
      const failed = err as { costUsd?: number; usage?: Usage };
      costUsd += failed.costUsd ?? 0;
      recordUsage(choice.runtime, failed.usage);
      await log.emit({
        type: "step.end",
        step,
        ok: false,
        durationMs: Date.now() - t0,
        costUsd: failed.costUsd,
        attempt,
        role,
        runtime: choice.runtime,
        usage: failed.usage,
      });
      throw new StopFlow("failed", `${step}: ${(err as Error).message}`);
    }
  }

  async function agent<S extends z.ZodType>(
    step: string,
    role: Role,
    place: Place,
    prompt: string,
    schema: S,
    attempt?: number,
  ): Promise<z.infer<S>> {
    return (await agentFull(step, role, "readonly", place, prompt, schema, { attempt })).output;
  }

  // ── Ask channel ─────────────────────────────────────────────────────────
  function askFor(asker: string) {
    return async (question: string): Promise<string> => {
      const decideAlone =
        "Decide on the most conservative option consistent with the ticket and record the assumption in your notes.";
      if (questions.length >= config.policy.maxQuestions) {
        await log.emit({ type: "info", message: `question budget exhausted (${asker}): ${question}` });
        return `No more questions are available in this run. ${decideAlone}`;
      }
      const record: QuestionRecord = { asker, question, answer: "", confident: false, basis: "" };
      questions.push(record);
      try {
        const a = await agent(
          `ask-${questions.length}`,
          "lead",
          home(comps[0]!),
          prompts.answer(ticket, research!, plan!, question, asker),
          AnswerSchema,
        );
        Object.assign(record, a);
      } catch (err) {
        record.answer = `(no answer: ${(err as Error).message})`;
      }
      await log.artifact("questions.json", questions);
      return record.confident
        ? `${record.answer}\n(basis: ${record.basis})`
        : `No authoritative answer exists. Lead's suggestion: ${record.answer}\n${decideAlone}`;
    };
  }

  // ── Checks and guards (pure code) ───────────────────────────────────────
  async function runCommands(step: string, cwd: string, commands: string[]): Promise<CheckResult> {
    for (const command of commands) {
      const r = await runShell(command, cwd, { baseEnv: cmdEnv });
      await log.emit({ type: "shell", step, command, ok: r.ok, code: r.code, durationMs: r.durationMs });
      if (!r.ok) return { ok: false, output: `$ ${command}\n${r.timedOut ? "(timed out)\n" : ""}${r.output}` };
    }
    return { ok: true, output: "" };
  }

  const commandsOf = (c: Comp, which: Array<"build" | "test" | "lint">) =>
    which
      .map((w) => (w === "build" ? c.buildCommand : w === "test" ? c.testCommand : c.lintCommand))
      .filter((x): x is string => !!x);

  /** Build → tests → lint for one component, in a worktree (its integration one by default). */
  const fullCheck = (comp: Comp, p: Place = home(comp)) => () =>
    runCommands(`check:${comp.name}`, dirOf(p), commandsOf(comp, ["build", "test", "lint"]));

  /** After any edit: changes to locked files are reverted to the committed tests. */
  async function enforceLocks(p: Place, step: string): Promise<void> {
    const policy = new PathPolicy(p.wt, p.comp.repo.lockedPaths);
    const touched = (await changedFiles(p.wt, p.comp.repo.testsRef)).filter((f) => policy.isLocked(f));
    if (touched.length) {
      await restoreFiles(p.wt, touched, p.comp.repo.testsRef!);
      await log.emit({ type: "guard", step, action: "reverted locked files", detail: touched.join(", ") });
    }
  }

  /**
   * Commits exactly the files the agent declared AND changed, inside its
   * component folder. Anything else is reverted (or flagged, per policy).
   */
  async function commitExact(
    p: Place,
    step: string,
    taskId: string | undefined,
    description: string,
    out: Implementation,
  ): Promise<LedgerEntry | undefined> {
    return repoLock.run(p.comp.repoRoot, async () => {
      const policy = new PathPolicy(p.wt, p.comp.repo.lockedPaths, dirOf(p));
      const actual = await changedFiles(p.wt, "HEAD");
      const declared = new Set(
        out.changedFiles.map((f) => policy.toRelative(f, dirOf(p))).filter((f): f is string => !!f && policy.isWritable(f)),
      );
      const outside = actual.filter((f) => !policy.isWritable(f));
      const undeclared = actual.filter((f) => policy.isWritable(f) && !declared.has(f));

      if (outside.length) {
        await restoreFiles(p.wt, outside, "HEAD");
        await log.emit({ type: "guard", step, action: "reverted files outside the component", detail: outside.join(", ") });
      }
      let toCommit = actual.filter((f) => declared.has(f));
      if (undeclared.length) {
        if (config.policy.undeclaredFiles === "revert") {
          await restoreFiles(p.wt, undeclared, "HEAD");
          await log.emit({ type: "guard", step, action: "reverted undeclared files", detail: undeclared.join(", ") });
        } else {
          toCommit = [...toCommit, ...undeclared];
          await log.emit({ type: "guard", step, action: "committing undeclared files", detail: undeclared.join(", ") });
        }
      }
      if (!toCommit.length) {
        await log.emit({ type: "info", message: `${step} produced no committable changes` });
        return undefined;
      }
      const sha = await commitFiles(p.wt, toCommit, `${step.startsWith("implement-") ? "feat" : "fix"}(${ticket.id}): ${description}`);
      const entry: LedgerEntry = {
        step,
        role: "coder",
        component: p.comp.name,
        repo: p.comp.repoName,
        taskId,
        description,
        sha,
        files: toCommit,
        undeclared,
        notes: out.notes,
      };
      ledger.push(entry);
      await log.artifact("ledger.json", ledger);
      return entry;
    });
  }

  async function editStep(o: {
    place: Place;
    step: string;
    description: string;
    prompt: string;
    worker?: Worker;
    resume?: boolean;
    attempt?: number;
  }): Promise<Implementation> {
    const res = await agentFull(o.step, "coder", "edit", o.place, o.prompt, ImplementationSchema, {
      attempt: o.attempt,
      resumeSessionId: o.resume ? o.worker?.sessionId : undefined,
      ask: askFor(o.worker ? `worker ${o.worker.taskId}` : o.step),
    });
    await enforceLocks(o.place, o.step);
    const entry = await commitExact(o.place, o.step, o.worker?.taskId, o.description, res.output);
    if (o.worker) {
      if (res.sessionId) o.worker.sessionId = res.sessionId;
      entry?.files.forEach((f) => o.worker!.files.add(f));
    }
    return res.output;
  }

  // ── Worker worktrees and integration ────────────────────────────────────
  const workerPlace = (w: Worker): Place => ({ comp: w.comp, wt: w.ws.path });
  const canResume = (w: Worker | undefined): boolean =>
    !!w?.sessionId && w.resumes < config.policy.sameWorkerRetries;

  /**
   * Merges a worker's branch into its repo's integration branch. On conflict,
   * the integration merge is aborted, the integration branch is merged into the
   * worker's worktree instead, and the same worker resolves the conflicts.
   */
  async function integrate(w: Worker): Promise<void> {
    const repo = w.comp.repo;
    for (;;) {
      const res = await repoLock.run(repo.root, async () => {
        const r = await merge(repo.integration.path, w.ws.branch, `merge(${ticket.id}): ${w.taskId} into integration`, { noFf: true });
        if (!r.ok) await abortMerge(repo.integration.path);
        return r;
      });
      if (res.ok) {
        w.integrated = true;
        await log.emit({ type: "info", message: `integrated ${w.taskId} into ${repo.name}:${repo.integration.branch}` });
        return;
      }

      const sync = await repoLock.run(repo.root, () =>
        merge(w.ws.path, repo.integration.branch, `merge(${ticket.id}): sync ${w.taskId} with integration`),
      );
      if (sync.ok) continue; // integration moved in a way that no longer conflicts
      if (!canResume(w)) {
        await abortMerge(w.ws.path);
        throw new StopFlow(
          "needs_human",
          `Task ${w.taskId} conflicts with work integrated in parallel (${sync.conflicts.join(", ")}) and its worker has no retries left.`,
        );
      }
      w.resumes++;
      await log.emit({ type: "info", message: `conflicts in ${w.taskId}: ${sync.conflicts.join(", ")} — back to its worker` });
      const res2 = await agentFull(
        `resolve-${w.taskId}`,
        "coder",
        "edit",
        workerPlace(w),
        prompts.resolveConflicts(sync.conflicts, w.comp.testCommand),
        ImplementationSchema,
        { resumeSessionId: w.sessionId, ask: askFor(`worker ${w.taskId}`) },
      );
      if (res2.sessionId) w.sessionId = res2.sessionId;
      const stillMarked = await filesWithConflictMarkers(w.ws.path, sync.conflicts);
      if (stillMarked.length) {
        await abortMerge(w.ws.path);
        throw new StopFlow("needs_human", `Task ${w.taskId}: conflict markers remain in ${stillMarked.join(", ")}.`);
      }
      const policy = new PathPolicy(w.ws.path, repo.lockedPaths, dirOf(workerPlace(w)));
      const touched = res2.output.changedFiles
        .map((f) => policy.toRelative(f, dirOf(workerPlace(w))))
        .filter((f): f is string => !!f && policy.isWritable(f) && !policy.isLocked(f));
      const sha = await repoLock.run(repo.root, () => concludeMerge(w.ws.path, [...new Set([...sync.conflicts, ...touched])]));
      ledger.push({
        step: `resolve-${w.taskId}`,
        role: "coder",
        component: w.comp.name,
        repo: repo.name,
        taskId: w.taskId,
        description: `${w.taskId} resolve conflicts with parallel work`,
        sha,
        files: sync.conflicts,
        undeclared: [],
        notes: res2.output.notes,
      });
      await log.artifact("ledger.json", ledger);
    }
  }

  /** Brings an integrated worker's worktree up to date with its integration branch. */
  async function syncWorker(w: Worker): Promise<void> {
    const repo = w.comp.repo;
    const r = await repoLock.run(repo.root, () =>
      merge(w.ws.path, repo.integration.branch, `merge(${ticket.id}): sync ${w.taskId} with integration`),
    );
    if (!r.ok) {
      await abortMerge(w.ws.path);
      throw new StopFlow("needs_human", `Could not update ${w.taskId}'s workspace: conflicts in ${r.conflicts.join(", ")}`);
    }
  }

  /** One plan task, start to finish, in its own worktree. */
  async function runTask(task: PlanTask): Promise<void> {
    const comp = compByName(task.component);
    const repo = comp.repo;
    const ws = await repoLock.run(repo.root, () =>
      addWorktree(repo.root, join(ticketDir, "_tasks", task.id), `hector-tasks/${ticket.id}/${task.id}`, repo.integration.branch),
    );
    const worker: Worker = { taskId: task.id, comp, ws, files: new Set(), resumes: 0, integrated: false };
    workers.push(worker);
    activeWorkers++;
    maxConcurrentWorkers = Math.max(maxConcurrentWorkers, activeWorkers);
    try {
      await editStep({
        place: workerPlace(worker),
        step: `implement-${task.id}`,
        description: `${task.id} ${task.description}`,
        prompt: prompts.coder(ticket, plan!, task, ledger, comp.info, comps.filter((c) => c !== comp).map((c) => c.info)),
        worker,
      });

      // Build gate in the worker's own worktree: compile errors are always the worker's.
      const gateCmds = commandsOf(comp, ["build", "lint"]);
      let gate = await runCommands(`gate:${task.id}`, dirOf(workerPlace(worker)), gateCmds);
      while (!gate.ok) {
        if (!canResume(worker)) {
          throw new StopFlow("needs_human", `Task ${task.id} does not build and its worker has no retries left.\n${gate.output}`);
        }
        worker.resumes++;
        await editStep({
          place: workerPlace(worker),
          step: `gate-${task.id}`,
          description: `${task.id} fix build`,
          prompt: prompts.workerDefects("build", gate.output, comp.testCommand),
          worker,
          resume: true,
          attempt: worker.resumes,
        });
        gate = await runCommands(`gate:${task.id}`, dirOf(workerPlace(worker)), gateCmds);
      }

      await integrate(worker);
    } finally {
      activeWorkers--;
    }
  }

  // ── Defect routing ──────────────────────────────────────────────────────
  function compByName(name: string): Comp {
    const c = comps.find((x) => x.name === name);
    if (!c) throw new StopFlow("failed", `Unknown component "${name}".`);
    return c;
  }

  /** Component-relative paths → the worker of that component whose commits overlap most. */
  function ownerOf(comp: Comp, files: string[]): Worker | undefined {
    const rel = files.map((f) => posix.normalize(comp.path === "." ? f : posix.join(comp.path, f.replace(/^\.?\//, ""))));
    let best: Worker | undefined;
    let bestScore = 0;
    for (const w of workers.filter((x) => x.comp === comp)) {
      const score = rel.filter((f) => w.files.has(f)).length;
      if (score > bestScore) [best, bestScore] = [w, score];
    }
    return best;
  }

  async function routeDefect(o: {
    source: "repair" | "review";
    comp: Comp;
    owner: Worker | undefined;
    details: string;
    freshPrompt: string;
    attempt?: number;
  }): Promise<void> {
    const { owner } = o;
    if (owner && canResume(owner) && owner.integrated) {
      owner.resumes++;
      await log.emit({ type: "info", message: `${o.source}: back to worker ${owner.taskId} (resume ${owner.resumes}/${config.policy.sameWorkerRetries})` });
      await syncWorker(owner);
      await editStep({
        place: workerPlace(owner),
        step: `${o.source}-${owner.taskId}`,
        description: `${owner.taskId} fix ${o.source === "review" ? "review findings" : "verification failure"}`,
        prompt: prompts.workerDefects(o.source === "review" ? "review" : "verification", o.details, o.comp.testCommand),
        worker: owner,
        resume: true,
        attempt: o.attempt,
      });
      await integrate(owner);
      return;
    }
    const why = owner ? `worker ${owner.taskId} used its ${config.policy.sameWorkerRetries} retries` : "no owning worker";
    await log.emit({ type: "info", message: `${o.source}: fresh implementer in ${o.comp.name} (${why})` });
    await editStep({
      place: home(o.comp),
      step: `${o.source}:${o.comp.name}`,
      description: o.source === "review" ? `address review findings in ${o.comp.name}` : `fix verification failure in ${o.comp.name}`,
      prompt: o.freshPrompt,
      attempt: o.attempt,
    });
  }

  async function untilGreen(label: string, comp: Comp, check: () => Promise<CheckResult>): Promise<void> {
    let result = await check();
    let lastDiagnosis: Diagnosis | undefined;
    while (!result.ok) {
      if (repairAttempts >= config.policy.repairAttempts) {
        throw new StopFlow("needs_human", `${label}: still failing after ${repairAttempts} repair attempts.\n${result.output}`);
      }
      repairAttempts++;
      const diagnosis = await agent(
        `diagnose:${comp.name}`,
        "diagnose",
        home(comp),
        prompts.diagnose(
          ticket,
          comp.info,
          result.output,
          await diff(comp.repo.integration.path, comp.repo.testsRef),
          knownFixes(lessons, result.output),
        ),
        DiagnosisSchema,
        repairAttempts,
      );
      if (diagnosis.owner !== "implementation") {
        throw new StopFlow(
          "needs_human",
          `${label}: the diagnosis says the problem is in the ${diagnosis.owner}: ${diagnosis.rootCause}\nSuggested fix: ${diagnosis.fixPlan}`,
        );
      }
      await routeDefect({
        source: "repair",
        comp,
        owner: ownerOf(comp, diagnosis.files),
        details: renderDiagnosis(diagnosis, result.output),
        freshPrompt: prompts.repair(ticket, comp.info, diagnosis, result.output),
        attempt: repairAttempts,
      });
      lastDiagnosis = diagnosis;
      result = await check();
    }
    if (lastDiagnosis) {
      await lessons.recordValidatedError({
        signature: lastDiagnosis.errorSignature,
        rootCause: lastDiagnosis.rootCause,
        fix: lastDiagnosis.fixPlan,
        ticketId: ticket.id,
      });
      await log.emit({ type: "info", message: `validated fix recorded: ${lastDiagnosis.errorSignature}` });
    }
  }

  async function allDiffs(): Promise<string> {
    const parts: string[] = [];
    for (const r of repos.values()) {
      const d = await diff(r.integration.path, r.integration.baseRef);
      if (d.trim()) parts.push(`### repository ${r.name}\n${d}`);
    }
    return parts.join("\n\n");
  }

  async function cleanup(removeTaskWorktrees: boolean): Promise<RepoSummary[]> {
    const info = repoSummaries();
    for (const r of info) {
      const state = repos.get(r.root)!;
      r.flowCommit = await git(state.integration.path, "rev-parse", "HEAD").catch(() => undefined);
    }
    if (removeTaskWorktrees) {
      for (const w of workers) await removeWorktree(w.comp.repoRoot, w.ws);
    }
    // Repos the ticket never touched leave no branch behind.
    const touched: RepoSummary[] = [];
    for (const r of info) {
      const state = repos.get(r.root)!;
      if (r.flowCommit === r.baseRef && !workers.some((w) => w.comp.repo === state)) {
        await removeWorktree(r.root, state.integration);
      } else touched.push(r);
    }
    return touched;
  }

  try {
    // ── Step skills ──────────────────────────────────────────────────────
    skillSet = await loadSkills(primaryRoot, config);
    for (const s of Object.values(skillSet.skills)) {
      for (const w of s.warnings) await log.emit({ type: "info", message: `skill ${s.role} (${s.source}): ${w}` });
    }
    const custom = Object.values(skillSet.skills).filter((s) => s.sourceKind !== "builtin");
    if (custom.length) {
      await log.emit({ type: "info", message: `custom skills: ${custom.map((s) => `${s.role} (${s.sourceKind})`).join(", ")}` });
    }

    // ── Workspaces ───────────────────────────────────────────────────────
    const resolved = await resolveComponents(primaryRoot, config);
    for (const root of new Set(resolved.map((c) => c.repoRoot))) await assertClean(root);
    for (const c of resolved) {
      let repo = repos.get(c.repoRoot);
      if (!repo) {
        const integration = await addWorktree(c.repoRoot, join(ticketDir, c.repoName), `hector/${ticket.id}`, "HEAD");
        const baseBranch = await git(c.repoRoot, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => undefined);
        repo = { root: c.repoRoot, name: c.repoName, integration, lockedPaths: [], baseBranch };
        repos.set(c.repoRoot, repo);
        await log.emit({ type: "info", message: `integration worktree ${integration.path} on ${integration.branch}` });
      }
      repo.lockedPaths.push(...c.lockedPaths);
      const dir = c.path === "." ? repo.integration.path : join(repo.integration.path, c.path);
      comps.push({
        ...c,
        repo,
        info: {
          name: c.name,
          description: c.description,
          repoName: c.repoName,
          path: c.path,
          dir,
          testCommand: c.testCommand,
          allowedCommands: c.allowedCommands,
        },
      });
    }
    await log.artifact("ticket.md", ticket.body);
    const primary = home(comps[0]!);
    const infos = comps.map((c) => c.info);

    // ── RESEARCH ─────────────────────────────────────────────────────────
    const recalled =
      config.memory.enabled && config.memory.injectIntoEnrich > 0
        ? memory.search([ticket.title, ...ticket.acceptanceCriteria].join(" "), { limit: config.memory.injectIntoEnrich })
        : [];
    if (recalled.length) await log.emit({ type: "info", message: `recalled ${recalled.length} memories for enrich` });
    research = await agent("enrich", "enrich", primary, prompts.enrich(ticket, infos, renderMemories(recalled)), DiscoverySchema);
    if (research.openQuestions.length) {
      await log.emit({ type: "info", message: "open questions (continuing autonomously)", data: research.openQuestions });
    }
    plan = await agent("plan", "plan", primary, prompts.plan(ticket, research, infos), PlanSchema);
    for (const t of plan.tasks) compByName(t.component);
    try {
      validateDag(plan.tasks);
    } catch (err) {
      throw new StopFlow("failed", `Invalid plan: ${(err as Error).message}`);
    }
    await log.artifact("plan.md", renderPlan(plan));
    const involved = comps.filter((c) => plan!.tasks.some((t) => t.component === c.name));

    // Locked tests and acceptance map, component by component.
    const acceptance: Array<AcceptanceCheck & { component: string }> = [];
    for (const comp of involved) {
      const authored = (
        await agentFull(`write-tests:${comp.name}`, "testAuthor", "tests", home(comp), prompts.testAuthor(ticket, research, plan, comp.info), TestAuthoringSchema)
      ).output;
      const policy = new PathPolicy(comp.repo.integration.path, comp.repo.lockedPaths, dirOf(home(comp)));
      const changed = await changedFiles(comp.repo.integration.path, comp.repo.integration.baseRef);
      const stray = changed.filter((f) => !policy.isLocked(f));
      if (stray.length) {
        await restoreFiles(comp.repo.integration.path, stray, comp.repo.integration.baseRef);
        await log.emit({ type: "guard", step: `write-tests:${comp.name}`, action: "reverted non-test files", detail: stray.join(", ") });
      }
      const rejected = authored.acceptanceMap.filter((c) => !isCommandAllowed(c.command, comp.allowedCommands).ok);
      if (rejected.length) {
        throw new StopFlow(
          "failed",
          `Acceptance map for ${comp.name} has commands outside allowedCommands:\n${rejected.map((r) => `- ${r.command}`).join("\n")}`,
        );
      }
      acceptance.push(...authored.acceptanceMap.map((a) => ({ ...a, component: comp.name })));
    }
    if (acceptance.length < ticket.acceptanceCriteria.length) {
      throw new StopFlow(
        "failed",
        `Acceptance map has ${acceptance.length} checks for ${ticket.acceptanceCriteria.length} acceptance criteria. Every criterion needs a command.`,
      );
    }
    for (const repo of repos.values()) {
      const written = await changedFiles(repo.integration.path, repo.integration.baseRef);
      if (!written.length) {
        repo.testsRef = repo.integration.baseRef;
        continue;
      }
      repo.testsRef = await commitAll(repo.integration.path, `test(${ticket.id}): acceptance tests for ${ticket.title}`);
      ledger.push({
        step: "write-tests",
        role: "testAuthor",
        component: comps.filter((c) => c.repo === repo).map((c) => c.name).join(","),
        repo: repo.name,
        description: `acceptance tests for ${ticket.title}`,
        sha: repo.testsRef,
        files: written,
        undeclared: [],
        notes: "",
      });
    }
    if (!ledger.some((e) => e.step === "write-tests")) {
      throw new StopFlow("failed", "No test files matching lockedPaths were written for any component.");
    }
    await log.artifact("acceptance-map.json", acceptance);
    await log.artifact("ledger.json", ledger);
    for (const comp of involved) {
      const red = await runCommands(`tests-red:${comp.name}`, dirOf(home(comp)), [comp.testCommand]);
      if (red.ok) await log.emit({ type: "info", message: `${comp.name}: tests already pass before implementation — they may not constrain the change` });
    }

    // ── IMPLEMENTATION (parallel) ────────────────────────────────────────
    await runDag(plan.tasks, config.policy.maxParallel, runTask);
    await log.emit({ type: "info", message: `all ${plan.tasks.length} tasks integrated (max ${maxConcurrentWorkers} in parallel)` });
    for (const comp of involved) await untilGreen(`stabilize:${comp.name}`, comp, fullCheck(comp));

    // ── VERIFICATION ─────────────────────────────────────────────────────
    /**
     * "Judgment day": every configured judge reviews the same diff on its own,
     * in parallel, without seeing the others. The change is approved only if
     * every judge approves and no merged finding is a blocker.
     */
    async function judgeReview(round: number): Promise<Review> {
      const diffs = await allDiffs();
      const judges = config.review.judges;
      const verdicts = await Promise.all(
        judges.map((j) =>
          agentFull(
            judges.length === 1 ? "review" : `review:${j.name}`,
            "review",
            "readonly",
            primary,
            prompts.review(ticket, diffs, infos, j.focus),
            ReviewSchema,
            { attempt: round, judge: j },
          ).then((r) => ({ judge: j.name, review: r.output })),
        ),
      );
      const merged = mergeReviews(verdicts);
      if (judges.length > 1) {
        await log.artifact(`review-${round}.json`, { ...merged, judges: verdicts.map((v) => ({ judge: v.judge, approved: v.review.approved })) });
        await log.emit({
          type: "info",
          message: `review round ${round}: ${verdicts.map((v) => `${v.judge} ${v.review.approved ? "approves" : "rejects"}`).join(", ")} → ${merged.approved ? "approved" : "not approved"}`,
        });
      }
      return merged;
    }

    let review: Review;
    for (;;) {
      review = await judgeReview(reviewRounds + 1);
      const serious = review.issues.filter((i) => i.severity !== "minor");
      if (serious.length === 0 || reviewRounds >= config.policy.reviewRounds) break;
      reviewRounds++;
      const groups = new Map<string, { comp: Comp; owner?: Worker; issues: Review["issues"] }>();
      for (const issue of serious) {
        const comp = comps.find((c) => c.name === issue.component) ?? involved[0]!;
        const owner = ownerOf(comp, [issue.file]);
        const key = `${comp.name}:${owner?.taskId ?? "-"}`;
        const g = groups.get(key) ?? { comp, owner, issues: [] };
        g.issues.push(issue);
        groups.set(key, g);
      }
      for (const g of groups.values()) {
        await routeDefect({
          source: "review",
          comp: g.comp,
          owner: g.owner,
          details: renderIssues(g.issues),
          freshPrompt: prompts.reviewFix(ticket, g.comp.info, g.issues),
          attempt: reviewRounds,
        });
      }
      for (const comp of involved) await untilGreen(`review-fix:${comp.name}`, comp, fullCheck(comp));
    }

    // QA: the machine decides if the ticket is done, criterion by criterion.
    const qaReport: Array<{ component: string; criterion: string; command: string; ok: boolean }> = [];
    for (const comp of involved) {
      const checks = acceptance.filter((a) => a.component === comp.name);
      if (!checks.length) continue;
      await untilGreen(`qa:${comp.name}`, comp, async () => {
        const failures: string[] = [];
        for (const c of checks) {
          const r = await runCommands(`qa:${comp.name}`, dirOf(home(comp)), [c.command]);
          const row = { component: comp.name, criterion: c.criterion, command: c.command, ok: r.ok };
          const i = qaReport.findIndex((x) => x.component === comp.name && x.command === c.command);
          if (i >= 0) qaReport[i] = row;
          else qaReport.push(row);
          if (!r.ok) failures.push(`Criterion not met: ${c.criterion}\n${r.output}`);
        }
        return { ok: failures.length === 0, output: failures.join("\n\n") };
      });
    }
    for (const comp of involved) await untilGreen(`final-check:${comp.name}`, comp, fullCheck(comp));
    await log.artifact("qa-report.json", qaReport);

    const qaPlan = await agent("qa-plan", "qaPlan", primary, prompts.qaPlan(ticket, await allDiffs(), acceptance), QaPlanSchema);
    await log.artifact("test-plan.md", qaPlan.markdown);

    const repoInfo = await cleanup(true);
    const validated = await memory.validateRun(runId);
    if (validated) await log.emit({ type: "info", message: `${validated} memories from this run validated` });
    const blockers = review.issues.filter((i) => i.severity === "blocker");
    if (blockers.length) {
      return await finish(
        summary(
          "needs_human",
          `Acceptance criteria pass, but review still reports blockers:\n${blockers.map((b) => `- ${b.component}/${b.file}: ${b.description}`).join("\n")}`,
          repoInfo,
        ),
      );
    }
    return await finish(summary("completed", undefined, repoInfo));
  } catch (err) {
    // Keep task worktrees on failure so they can be inspected.
    const repoInfo = await cleanup(false).catch(() => repoSummaries());
    if (err instanceof StopFlow) {
      await log.emit({ type: "error", step: "flow", message: err.message });
      return await finish(summary(err.status, err.message, repoInfo));
    }
    await log.emit({ type: "error", step: "flow", message: (err as Error).stack ?? String(err) });
    return await finish(summary("failed", (err as Error).message, repoInfo));
  }

  async function finish(s: RunSummary): Promise<RunSummary> {
    const summaryPath = join(log.runDir, "summary.json");
    await writeFile(summaryPath, JSON.stringify(s, null, 2));
    if (config.notifyCommand) {
      const r = await runShell(config.notifyCommand, process.cwd(), {
        timeoutMs: 30_000,
        env: {
          HECTOR_STATUS: s.status,
          HECTOR_TICKET: s.ticketId,
          HECTOR_SUMMARY: summaryPath,
          HECTOR_OPEN_ASSUMPTIONS: String(s.openAssumptions.length),
        },
      });
      await log.emit({ type: "shell", step: "notify", command: config.notifyCommand, ok: r.ok, code: r.code, durationMs: r.durationMs });
    }
    return s;
  }
}

const SEVERITY_RANK = { minor: 0, major: 1, blocker: 2 } as const;

/**
 * Merges independent reviews. Approved only if every judge approved and no
 * finding is a blocker. Findings on the same component, file and description
 * (case and spacing ignored) are merged, keeping the highest severity; with
 * several judges each finding names the judges that raised it.
 */
export function mergeReviews(verdicts: Array<{ judge: string; review: Review }>): Review {
  const byKey = new Map<string, { issue: Review["issues"][number]; judges: string[] }>();
  for (const { judge, review } of verdicts) {
    for (const issue of review.issues) {
      const key = [issue.component, issue.file, issue.description.toLowerCase().replace(/\s+/g, " ").trim()].join("|");
      const seen = byKey.get(key);
      if (!seen) byKey.set(key, { issue: { ...issue }, judges: [judge] });
      else {
        if (SEVERITY_RANK[issue.severity] > SEVERITY_RANK[seen.issue.severity]) seen.issue.severity = issue.severity;
        if (!seen.judges.includes(judge)) seen.judges.push(judge);
      }
    }
  }
  const several = verdicts.length > 1;
  const issues = [...byKey.values()].map(({ issue, judges }) =>
    several ? { ...issue, description: `[${judges.join(", ")}] ${issue.description}` } : issue,
  );
  const approved = verdicts.every((v) => v.review.approved) && !issues.some((i) => i.severity === "blocker");
  return { approved, issues };
}

/** Cheap deterministic signature from tool output: compiler codes like TS2345, CS8862. */
function knownFixes(store: LessonStore, output: string): ErrorLesson[] {
  const codes = [...new Set(output.match(/\b[A-Z]{2,4}\d{3,5}\b/g) ?? [])].slice(0, 5);
  return codes.flatMap((c) => store.findErrors(c));
}

function renderPlan(plan: Plan): string {
  return [
    `# Plan\n\n${plan.summary}\n`,
    ...plan.tasks.map(
      (t) =>
        `## ${t.id} · ${t.component}${t.dependsOn.length ? ` · after ${t.dependsOn.join(", ")}` : " · parallel"}\n\n${t.description}\n\nFiles: ${t.files.join(", ")}\n\n${t.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n`,
    ),
    plan.risks.length ? `## Risks\n\n${plan.risks.map((r) => `- ${r}`).join("\n")}\n` : "",
  ].join("\n");
}
