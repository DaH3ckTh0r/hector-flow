import { existsSync } from "node:fs";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LedgerEntry } from "./prompts.js";
import type { AcceptanceCheck, Discovery, Plan, Review } from "./schemas.js";
import type { Ticket } from "./ticket.js";
import type { Workspace } from "./tools/git.js";
import type { TokenCounts } from "./usage.js";

/**
 * Everything the flow needs to continue a run after a crash, written to
 * <runDir>/state.json after every step. The code itself lives in git (the
 * integration and task branches); this file says how far the run got.
 */
export interface RunState {
  version: 1;
  runId: string;
  ticket: Ticket;
  /** running until the run ends; a crashed process leaves it at running. */
  status: "running" | "completed" | "needs_human" | "failed";
  reason?: string;
  /** Wall time spent in earlier sessions of this run (resumes add to it). */
  elapsedMs: number;
  resumes: number;
  research?: Discovery;
  plan?: Plan;
  /** Set once the locked tests are committed in every repo. */
  acceptance?: Array<AcceptanceCheck & { component: string }>;
  repos: Array<{
    root: string;
    name: string;
    integration: Workspace;
    baseBranch?: string;
    testsRef?: string;
  }>;
  tasks: Array<{
    taskId: string;
    component: string;
    ws: Workspace;
    sessionId?: string;
    files: string[];
    resumes: number;
    integrated: boolean;
  }>;
  /** Set once the review loop has finished (approved or out of rounds). */
  review?: Review;
  ledger: LedgerEntry[];
  questions: Array<{ asker: string; question: string; answer: string; confident: boolean; basis: string }>;
  counters: { repairAttempts: number; reviewRounds: number; maxConcurrentWorkers: number; memoriesSaved: number };
  costUsd: number;
  usage: { byModel: Record<string, TokenCounts>; byRuntime: Record<string, TokenCounts> };
  /** Memories saved in this run but not yet written to an external backend (Engram). */
  pendingMemories?: unknown[];
}

const FILE = "state.json";

/** Atomic write: a crash mid-write never leaves a truncated state file. */
export async function saveState(runDir: string, state: RunState): Promise<void> {
  const tmp = join(runDir, `${FILE}.tmp`);
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, join(runDir, FILE));
}

export async function loadState(runDir: string): Promise<RunState | undefined> {
  const text = await readFile(join(runDir, FILE), "utf8").catch(() => undefined);
  if (!text) return undefined;
  const s = JSON.parse(text) as RunState;
  if (s.version !== 1) throw new Error(`${join(runDir, FILE)} has an unsupported version (${s.version}).`);
  return s;
}

/**
 * The most recent run of a ticket that can be resumed: interrupted
 * (still "running"), failed or needing a human. Completed runs are never resumed.
 */
export async function findResumableRun(runsDir: string, ticketId: string): Promise<{ runDir: string; state: RunState } | undefined> {
  const dirs = (await readdir(runsDir).catch(() => [] as string[])).filter((d) => d.startsWith(`${ticketId}-`)).sort().reverse();
  for (const d of dirs) {
    const runDir = join(runsDir, d);
    if (!existsSync(join(runDir, FILE))) continue;
    const state = await loadState(runDir);
    if (!state || state.ticket.id !== ticketId) continue;
    if (state.status === "completed") return undefined; // the latest run finished: nothing to resume
    return { runDir, state };
  }
  return undefined;
}
