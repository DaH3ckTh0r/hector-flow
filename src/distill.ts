import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FlowConfig } from "./config.js";
import { LessonStore } from "./lessons.js";
import { prompts, systemPrompt, type LedgerEntry } from "./prompts.js";
import type { AgentRunner } from "./runner/agent-runner.js";
import { DistillSchema, type Distill } from "./schemas.js";
import { readTicket } from "./ticket.js";
import { git } from "./tools/git.js";
import { flowPaths, type RunSummary } from "./workflow.js";

/**
 * Pillar 2, "fix each mistake once": after a human corrects the flow's output
 * on the ticket branches, compare their changes with the flow's last commit in
 * every repo and turn each correction into a standing guideline for the step
 * that caused it. Those guidelines are injected into that step's system prompt.
 */
export async function distillTicket(opts: {
  repo: string;
  ticketId: string;
  config: FlowConfig;
  runner: AgentRunner;
}): Promise<{ added: number; lessons: Distill["lessons"]; runDir: string } | { added: 0; reason: string }> {
  const repoRoot = await git(resolve(opts.repo), "rev-parse", "--show-toplevel");
  const paths = flowPaths(repoRoot, opts.config);

  const runs = (await readdir(paths.runs).catch(() => [] as string[]))
    .filter((d) => d.startsWith(`${opts.ticketId}-`))
    .sort();
  const latest = runs.at(-1);
  if (!latest) return { added: 0, reason: `No runs found for ${opts.ticketId} in ${paths.runs}` };

  const runDir = join(paths.runs, latest);
  const summary: RunSummary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8"));
  const repos = (summary.repos ?? []).filter((r) => r.worktree && r.flowCommit);
  if (!repos.length) return { added: 0, reason: `Run ${latest} has no worktree or flow commit to compare against.` };

  // Committed and uncommitted human changes after the flow's last commit, per repo.
  const parts: string[] = [];
  for (const r of repos) {
    const d = await git(r.worktree, "diff", r.flowCommit!).catch(() => "");
    if (d.trim()) parts.push(`### repository ${r.name}\n${d}`);
  }
  const humanDiff = parts.join("\n\n");
  if (!humanDiff.trim()) return { added: 0, reason: "No human changes after the flow's last commit: nothing to learn." };

  const ticket = await readTicket(join(runDir, "artifacts", "ticket.md"));
  const ledger: LedgerEntry[] = JSON.parse(
    await readFile(join(runDir, "artifacts", "ledger.json"), "utf8").catch(() => "[]"),
  );
  const store = await LessonStore.open(paths.lessons);
  const cwd = (repos.find((r) => r.root === repoRoot) ?? repos[0]!).worktree;

  const res = await opts.runner.run({
    role: "distill",
    mode: "readonly",
    cwd,
    systemPrompt: systemPrompt("distill", []),
    prompt: prompts.distill(ticket, ledger, humanDiff.slice(0, 30_000)),
    schema: DistillSchema,
    readDirs: repos.map((r) => r.worktree).filter((w) => w !== cwd),
  });

  const added = await store.addGuidelines(res.output.lessons.map((l) => ({ ...l, ticketId: opts.ticketId })));
  return { added, lessons: res.output.lessons, runDir };
}
