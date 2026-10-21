import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createBacklog, type BacklogAdapter, type BacklogItem } from "./backlog.js";
import { findResumableRun } from "./checkpoint.js";
import { cleanTicket } from "./clean.js";
import { resolveComponents } from "./components.js";
import type { FlowConfig } from "./config.js";
import type { AgentRunner } from "./runner/agent-runner.js";
import { abortMerge, git, merge } from "./tools/git.js";
import { commandEnv } from "./tools/env.js";
import { runShell } from "./tools/shell.js";
import { flowPaths, implementTicket, type RepoSummary, type RunSummary } from "./workflow.js";

/**
 * The continuous loop: take the next ticket from the backlog, implement it,
 * then act according to the mode:
 *
 *   manual      leave the branches for you (status: completed)
 *   supervised  wait for `approve` or `reject` (status: awaiting_review)
 *   auto        merge into each repo's base branch, verify, roll back on failure
 *
 * One ticket at a time (each ticket already runs its tasks in parallel). A
 * ticket that has a state entry is never picked again until you `requeue` it,
 * so failures never turn into an expensive retry loop.
 */

export type TicketStatus =
  | "running"
  | "completed"
  | "awaiting_review"
  | "merged"
  | "merge_failed"
  | "rejected"
  | "needs_human"
  | "failed";

export interface TicketState {
  id: string;
  title: string;
  ref: string;
  status: TicketStatus;
  updatedAt: string;
  runId?: string;
  runDir?: string;
  reason?: string;
  repos?: RepoSummary[];
  openAssumptions?: number;
}

export type LoopMode = FlowConfig["loop"]["mode"];

// ── State ─────────────────────────────────────────────────────────────────

export class LoopStore {
  private data: { tickets: Record<string, TicketState> } = { tickets: {} };
  private constructor(readonly dir: string) {}

  static async open(dir: string): Promise<LoopStore> {
    const s = new LoopStore(dir);
    try {
      s.data = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    } catch {
      // first run
    }
    return s;
  }

  get(id: string): TicketState | undefined {
    return this.data.tickets[id];
  }

  all(): TicketState[] {
    return Object.values(this.data.tickets).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  async set(entry: Omit<TicketState, "updatedAt">): Promise<TicketState> {
    const full = { ...entry, updatedAt: new Date().toISOString() };
    this.data.tickets[entry.id] = full;
    await this.save();
    return full;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.data.tickets[id]) return false;
    delete this.data.tickets[id];
    await this.save();
    return true;
  }

  private async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, "state.json"), JSON.stringify(this.data, null, 2));
  }
}

/** One loop per primary repo: a lock file with the owner's pid. Stale locks (dead pid) are taken over. */
export async function acquireLoopLock(dir: string): Promise<() => Promise<void>> {
  const path = join(dir, "lock");
  await mkdir(dir, { recursive: true });
  try {
    const { pid, startedAt } = JSON.parse(await readFile(path, "utf8"));
    if (pid !== process.pid && isAlive(pid)) {
      throw new Error(`Another hector-flow loop is running for this repo (pid ${pid}, since ${startedAt}). Stop it first.`);
    }
  } catch (err) {
    if ((err as Error).message.startsWith("Another")) throw err;
  }
  await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return async () => {
    await rm(path, { force: true });
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── The loop ──────────────────────────────────────────────────────────────

export interface LoopOptions {
  repo: string;
  config: FlowConfig;
  runner: AgentRunner;
  /** Defaults to the adapter built from config.backlog. */
  backlog?: BacklogAdapter;
  mode?: LoopMode;
  /** Process what is ready, then return instead of waiting for more. */
  once?: boolean;
  /** Stop after this many tickets. */
  maxTickets?: number;
  /** Abort to stop after the current ticket. */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface LoopResult {
  processed: TicketState[];
}

export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const { config, runner } = opts;
  const log = opts.log ?? ((l: string) => console.log(l));
  const mode = opts.mode ?? config.loop.mode;
  const primaryRoot = await git(resolve(opts.repo), "rev-parse", "--show-toplevel");
  const paths = flowPaths(primaryRoot, config);
  const store = await LoopStore.open(paths.loop);
  const backlog = opts.backlog ?? createBacklog(config, primaryRoot);
  const release = await acquireLoopLock(paths.loop);
  const processed: TicketState[] = [];
  const reportedSkips = new Set<string>();

  log(`hector-flow loop · ${backlog.kind} backlog · mode ${mode}${opts.once ? " · once" : ""}`);
  try {
    while (!opts.signal?.aborted) {
      const listing = await backlog.list();
      for (const s of listing.skipped) {
        if (!reportedSkips.has(s.ref)) log(`  · skipped ${s.ref}: ${s.reason.split("\n")[0]}`);
        reportedSkips.add(s.ref);
      }
      // A ticket still "running" was interrupted (only one loop runs per repo): it goes first.
      const interrupted = listing.items.find((i) => store.get(i.ticket.id)?.status === "running");
      const next = interrupted ?? listing.items.find((i) => !store.get(i.ticket.id));
      if (!next) {
        if (opts.once) break;
        log(`  · nothing to do; next check in ${config.loop.intervalSeconds}s`);
        await sleep(config.loop.intervalSeconds * 1000, opts.signal);
        continue;
      }

      const t = next.ticket;
      log(`\n▶ ${t.id}: ${t.title}  (${next.ref})`);
      await store.set({ id: t.id, title: t.title, ref: next.ref, status: "running" });
      let summary: RunSummary;
      try {
        const resumable = interrupted ? await findResumableRun(paths.runs, t.id) : undefined;
        if (interrupted && resumable) {
          log(`  · resuming the interrupted run ${resumable.state.runId}`);
          summary = await implementTicket({ repo: primaryRoot, ticket: t, config, runner, resume: { runDir: resumable.runDir } });
        } else {
          if (interrupted) {
            // Interrupted before its first checkpoint: nothing worth keeping.
            log(`  · interrupted before any progress was saved; starting it again`);
            await cleanTicket({ repo: primaryRoot, ticketId: t.id, config });
          }
          summary = await implementTicket({ repo: primaryRoot, ticket: t, config, runner });
        }
      } catch (err) {
        const state = await store.set({ id: t.id, title: t.title, ref: next.ref, status: "failed", reason: (err as Error).message });
        processed.push(state);
        log(`  → failed: ${state.reason}`);
        await reportSafely(backlog, next, reportMessage(state), log);
        if (opts.maxTickets && processed.length >= opts.maxTickets) break;
        continue;
      }
      const state = await afterRun(summary, next, mode);
      processed.push(state);
      log(`  → ${state.status}${state.reason ? `: ${state.reason.split("\n")[0]}` : ""}`);
      await reportSafely(backlog, next, reportMessage(state, summary), log);
      if (opts.maxTickets && processed.length >= opts.maxTickets) break;
    }
  } finally {
    await release();
  }
  return { processed };

  async function afterRun(summary: RunSummary, item: BacklogItem, m: LoopMode): Promise<TicketState> {
    const base = {
      id: item.ticket.id,
      title: item.ticket.title,
      ref: item.ref,
      runId: summary.runId,
      runDir: summary.runDir,
      repos: summary.repos,
      openAssumptions: summary.openAssumptions.length,
    };
    if (summary.status !== "completed") return store.set({ ...base, status: summary.status, reason: summary.reason });
    if (m === "manual") return store.set({ ...base, status: "completed" });
    if (m === "supervised") return store.set({ ...base, status: "awaiting_review" });
    if (config.loop.autoMergeRequiresNoAssumptions && summary.openAssumptions.length) {
      return store.set({
        ...base,
        status: "awaiting_review",
        reason: `${summary.openAssumptions.length} open assumption(s): review before merging`,
      });
    }
    const merged = await mergeTicket({ config, primaryRoot, ticketId: item.ticket.id, title: item.ticket.title, repos: summary.repos, log });
    return store.set({ ...base, status: merged.ok ? "merged" : "merge_failed", reason: merged.ok ? undefined : merged.reason });
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
  });
}

async function reportSafely(backlog: BacklogAdapter, item: BacklogItem, message: string, log: (l: string) => void) {
  try {
    await backlog.report(item, message);
  } catch (err) {
    log(`  ⚠ could not report back to ${item.ref}: ${(err as Error).message}`);
  }
}

export function reportMessage(state: TicketState, summary?: RunSummary): string {
  const label: Record<TicketStatus, string> = {
    running: "running",
    completed: "completed — branches ready for review",
    awaiting_review: "completed — awaiting approval",
    merged: "completed and merged",
    merge_failed: "completed, but the merge failed and was rolled back",
    rejected: "rejected",
    needs_human: "stopped: needs a human decision",
    failed: "failed",
  };
  const lines = [`**hector-flow** · ${state.id} → ${label[state.status]}`, ""];
  for (const r of state.repos ?? []) lines.push(`- ${r.name}: \`${r.branch}\``);
  if (state.reason) lines.push("", `Reason: ${state.reason}`);
  if (summary?.openAssumptions.length) {
    lines.push("", "Open assumptions:");
    for (const q of summary.openAssumptions) lines.push(`- ${q.question} → ${q.answer}`);
  }
  if (summary) lines.push("", `Cost ≈ $${summary.costUsd.toFixed(2)} · ${Math.round(summary.durationMs / 1000)}s · run ${summary.runId}`);
  return lines.join("\n");
}

// ── Merge queue ───────────────────────────────────────────────────────────

/**
 * Merges hector/<ID> into the base branch of every repo the ticket touched,
 * in your checkouts, then runs each affected component's build/test/lint on the
 * merged result. Any conflict or failing check rolls every repo back to where
 * it was. Requires each checkout to be clean and on its base branch.
 */
export async function mergeTicket(opts: {
  config: FlowConfig;
  primaryRoot: string;
  ticketId: string;
  title: string;
  repos: RepoSummary[];
  log?: (l: string) => void;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const log = opts.log ?? (() => undefined);
  const before = new Map<string, string>();

  // Preconditions for every repo first: nothing is touched unless all can merge.
  for (const r of opts.repos) {
    if (!r.baseBranch) return { ok: false, reason: `${r.name}: the run started on a detached HEAD, so there is no base branch to merge into.` };
    const current = await git(r.root, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "(detached)");
    if (current !== r.baseBranch) {
      return { ok: false, reason: `${r.name}: your checkout is on ${current}; switch it to ${r.baseBranch} to merge.` };
    }
    if (await git(r.root, "status", "--porcelain")) return { ok: false, reason: `${r.name}: your checkout has uncommitted changes.` };
    before.set(r.root, await git(r.root, "rev-parse", "HEAD"));
  }

  const rollback = async () => {
    for (const [root, sha] of before) {
      await abortMerge(root);
      await git(root, "reset", "--hard", sha);
    }
  };

  for (const r of opts.repos) {
    const m = await merge(r.root, r.branch, `merge(${opts.ticketId}): ${opts.title}`, { noFf: true });
    if (!m.ok) {
      await rollback();
      return { ok: false, reason: `${r.name}: conflicts merging ${r.branch} into ${r.baseBranch} (${m.conflicts.join(", ")}). Nothing was merged.` };
    }
    log(`  · merged ${r.branch} into ${r.name}:${r.baseBranch}`);
  }

  // Verify the merged result: other tickets may have landed since this one started.
  const roots = new Set(opts.repos.map((r) => r.root));
  const components = (await resolveComponents(opts.primaryRoot, opts.config)).filter((c) => roots.has(c.repoRoot));
  for (const c of components) {
    const dir = c.path === "." ? c.repoRoot : join(c.repoRoot, c.path);
    for (const cmd of [c.buildCommand, c.testCommand, c.lintCommand].filter((x): x is string => !!x)) {
      const res = await runShell(cmd, dir, { baseEnv: commandEnv(opts.config).env });
      log(`  $ ${cmd} (${c.name}, merged) → ${res.ok ? "ok" : `exit ${res.code}`}`);
      if (!res.ok) {
        await rollback();
        return { ok: false, reason: `${c.name}: "${cmd}" fails after merging. Every repo was rolled back.\n${res.output.slice(-2000)}` };
      }
    }
  }

  await cleanTicket({ repo: opts.primaryRoot, ticketId: opts.ticketId, config: opts.config });
  return { ok: true };
}

// ── Review commands ───────────────────────────────────────────────────────

async function storeFor(repo: string, config: FlowConfig) {
  const primaryRoot = await git(resolve(repo), "rev-parse", "--show-toplevel");
  return { primaryRoot, store: await LoopStore.open(flowPaths(primaryRoot, config).loop) };
}

function backlogOrNull(config: FlowConfig, primaryRoot: string): BacklogAdapter | null {
  try {
    return config.backlog ? createBacklog(config, primaryRoot) : null;
  } catch {
    return null;
  }
}

/** Merges a ticket that is awaiting review (or completed in manual mode). */
export async function approveTicket(opts: { repo: string; config: FlowConfig; ticketId: string; log?: (l: string) => void; backlog?: BacklogAdapter | null }) {
  const { primaryRoot, store } = await storeFor(opts.repo, opts.config);
  const s = store.get(opts.ticketId);
  if (!s) throw new Error(`${opts.ticketId} is not in the loop state.`);
  if (!["awaiting_review", "completed", "merge_failed"].includes(s.status)) {
    throw new Error(`${opts.ticketId} is ${s.status}; only awaiting_review, completed or merge_failed tickets can be approved.`);
  }
  const res = await mergeTicket({ config: opts.config, primaryRoot, ticketId: s.id, title: s.title, repos: s.repos ?? [], log: opts.log });
  const next = await store.set({ ...s, status: res.ok ? "merged" : "merge_failed", reason: res.ok ? undefined : res.reason });
  const backlog = opts.backlog === undefined ? backlogOrNull(opts.config, primaryRoot) : opts.backlog;
  if (backlog) await reportSafely(backlog, asItem(next), reportMessage(next), opts.log ?? (() => undefined));
  return next;
}

/** Discards a ticket's branches and marks it rejected. */
export async function rejectTicket(opts: { repo: string; config: FlowConfig; ticketId: string; reason?: string; backlog?: BacklogAdapter | null }) {
  const { primaryRoot, store } = await storeFor(opts.repo, opts.config);
  const s = store.get(opts.ticketId);
  if (!s) throw new Error(`${opts.ticketId} is not in the loop state.`);
  if (s.status === "merged" || s.status === "running") throw new Error(`${opts.ticketId} is ${s.status} and cannot be rejected.`);
  await cleanTicket({ repo: primaryRoot, ticketId: s.id, config: opts.config });
  const next = await store.set({ ...s, status: "rejected", reason: opts.reason ?? s.reason });
  const backlog = opts.backlog === undefined ? backlogOrNull(opts.config, primaryRoot) : opts.backlog;
  if (backlog) await reportSafely(backlog, asItem(next), reportMessage(next), () => undefined);
  return next;
}

/** Cleans a ticket's branches and forgets its state, so the loop picks it up again. */
export async function requeueTicket(opts: { repo: string; config: FlowConfig; ticketId: string }) {
  const { primaryRoot, store } = await storeFor(opts.repo, opts.config);
  const s = store.get(opts.ticketId);
  if (s?.status === "running") throw new Error(`${opts.ticketId} is running.`);
  if (s?.status === "merged") throw new Error(`${opts.ticketId} is already merged.`);
  await cleanTicket({ repo: primaryRoot, ticketId: opts.ticketId, config: opts.config });
  return store.remove(opts.ticketId);
}

export async function loopStatus(opts: { repo: string; config: FlowConfig }): Promise<TicketState[]> {
  return (await storeFor(opts.repo, opts.config)).store.all();
}

function asItem(s: TicketState): BacklogItem {
  return { ticket: { id: s.id, title: s.title, body: "", acceptanceCriteria: [] }, ref: s.ref };
}
