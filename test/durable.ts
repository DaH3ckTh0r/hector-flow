/**
 * Durable runs: transient failures are retried, a run killed with SIGKILL in
 * the middle of a task resumes where it stopped (without repeating finished
 * work), failed and needs_human runs can be resumed, and the loop resumes an
 * interrupted ticket on its own. No model calls.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findResumableRun, loadState } from "../src/checkpoint.js";
import { ConfigSchema } from "../src/config.js";
import { LoopStore, runLoop } from "../src/loop.js";
import { isTransient, retryDelayMs } from "../src/retry.js";
import { readTicket } from "../src/ticket.js";
import { resetWorktree } from "../src/tools/git.js";
import { flowPaths, implementTicket } from "../src/workflow.js";
import { approve, CLAMP, durableScript, LERP, makeDurableRepo, qaPlan } from "./durable-fixture.js";
import { byTask, ScriptedRunner, sh, write } from "./helpers.js";

const lerpWorker = (cwd: string) => (write(cwd, "src/lerp.js", LERP), { changedFiles: ["src/lerp.js"], notes: "lerp" });
const clampWorker = (cwd: string) => (write(cwd, "src/clamp.js", CLAMP), { changedFiles: ["src/clamp.js"], notes: "clamp" });
const events = (runDir: string) =>
  readFileSync(join(runDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

function classification() {
  for (const m of ["429 Too Many Requests", "Overloaded (529)", "fetch failed: ECONNRESET", "Claude Code process exited with code 1", "503 Service Unavailable", "Request timed out"]) {
    assert.ok(isTransient(new Error(m)), m);
  }
  for (const m of ["Agent failed: error_max_turns", "Structured output did not match the contract: …", "401 Unauthorized", "Copilot is not signed in", "pi does not know the model x", "No scripted response left"]) {
    assert.ok(!isTransient(new Error(m)), m);
  }
  assert.equal(retryDelayMs(1, 10, () => 0.5), 10_000);
  assert.equal(retryDelayMs(3, 10, () => 0.5), 40_000);
  assert.equal(retryDelayMs(10, 10, () => 0.5), 300_000, "capped at 5 minutes");
  console.log("✓ retry: rate limits, 5xx, network and crashed agents are transient; limits, contract and auth errors are not");
}

async function retries() {
  const { repo, ticket, config } = makeDurableRepo({ policy: { agentRetries: 2, agentRetryDelaySeconds: 0, reviewRounds: 1 } });
  let enrichCalls = 0;
  const runner = new ScriptedRunner(
    {
      ...durableScript(),
      enrich: [
        () => {
          enrichCalls++;
          throw new Error("429 rate_limit_error: slow down");
        },
        () => {
          enrichCalls++;
          throw new Error("fetch failed (ECONNRESET)");
        },
        ...durableScript().enrich!,
      ],
      "coder:T1": [clampWorker],
      "coder:T2": [lerpWorker],
      review: [approve],
      qaPlan: [qaPlan],
    },
    byTask,
  );
  const s = await implementTicket({ repo, ticket: await readTicket(ticket), config: ConfigSchema.parse(config), runner });
  assert.equal(s.status, "completed", s.reason);
  assert.equal(enrichCalls, 2, "two transient failures, then success");
  const ev = events(s.runDir);
  assert.equal(ev.filter((e) => e.type === "info" && /enrich: transient failure, retry \d\/2/.test(e.message)).length, 2);
  assert.equal(ev.filter((e) => e.type === "step.end" && e.step === "enrich" && !e.ok).length, 2, "failed attempts stay in the log");

  // A permanent error is not retried.
  const r2 = makeDurableRepo({ policy: { agentRetries: 3, agentRetryDelaySeconds: 0 } });
  let planCalls = 0;
  const runner2 = new ScriptedRunner({
    ...durableScript(),
    plan: [
      () => {
        planCalls++;
        throw new Error("Agent failed: error_max_turns");
      },
    ],
  });
  const s2 = await implementTicket({ repo: r2.repo, ticket: await readTicket(r2.ticket), config: ConfigSchema.parse(r2.config), runner: runner2 });
  assert.equal(s2.status, "failed");
  assert.equal(planCalls, 1, "max turns is not retried");
  console.log("✓ retries: transient agent failures retried with backoff; permanent ones stop the run");
}

async function crashAndResume() {
  const fx = makeDurableRepo();
  // A real crash: the child process kills itself with SIGKILL in the middle of T2.
  const child = spawnSync(process.execPath, ["--import", "tsx", "test/durable-child.ts", fx.repo, fx.ticket, fx.configPath], {
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(child.signal, "SIGKILL", `child should die by SIGKILL: ${child.stdout}${child.stderr}`);
  assert.doesNotMatch(child.stdout, /UNREACHABLE/);

  const config = ConfigSchema.parse(fx.config);
  const runs = flowPaths(fx.repo, config).runs;
  const found = await findResumableRun(runs, "DUR-1");
  assert.ok(found, "the killed run is resumable");
  const before = found.state;
  assert.equal(before.status, "running", "a killed process leaves the run 'running'");
  assert.ok(before.plan && before.acceptance, "plan and tests were checkpointed");
  assert.deepEqual(
    before.tasks.map((t) => [t.taskId, t.integrated]),
    [["T1", true], ["T2", false]],
  );
  const t2 = before.tasks.find((t) => t.taskId === "T2")!;
  assert.ok(existsSync(join(t2.ws.path, "src/scratch.js")), "the crash left half-done edits behind");
  // The ticket file changes after the crash: the resumed run keeps the original.
  writeFileSync(fx.ticket, "# DUR-1: Something else entirely\n\n## Acceptance criteria\n- nope\n");

  const runner = new ScriptedRunner({ "coder:T2": [lerpWorker], review: [approve], qaPlan: [qaPlan] }, byTask);
  const s = await implementTicket({
    repo: fx.repo,
    ticket: await readTicket(fx.ticket),
    config,
    runner,
    resume: { runDir: found.runDir },
  });
  assert.equal(s.status, "completed", s.reason);
  assert.equal(s.runId, before.runId, "same run, same folder");
  assert.deepEqual(runner.roles, ["coder", "review", "qaPlan"], "research, plan, tests and T1 are not repeated");
  assert.match(runner.calls[0]!.prompt, /<current_task id="T2"/);
  assert.equal(readFileSync(join(s.worktree!, "src/lerp.js"), "utf8"), LERP);
  assert.equal(readFileSync(join(s.worktree!, "src/clamp.js"), "utf8"), CLAMP, "T1's work kept");
  assert.ok(!existsSync(join(s.worktree!, "src/scratch.js")), "half-done edits of the crash discarded, never integrated");

  const ev = events(s.runDir);
  assert.ok(ev.some((e) => e.type === "guard" && /discarded uncommitted changes of T2/.test(e.action) && /scratch\.js/.test(e.detail)));
  assert.ok(ev.some((e) => e.type === "info" && /resuming run .* 1\/2 tasks integrated/.test(e.message)));
  assert.equal(ev.filter((e) => e.type === "step.end" && e.step === "plan").length, 1, "one log for the whole run");
  // Usage and cost add up both processes: enrich, plan, tests, T1 (4) + T2, review, qaPlan (3).
  assert.equal(s.usage.total.input, 700);
  assert.equal(s.costUsd, 0.07);
  const after = await loadState(s.runDir);
  assert.equal(after!.status, "completed");
  assert.equal(after!.resumes, 1);
  assert.equal(await findResumableRun(runs, "DUR-1"), undefined, "a completed run is not resumable");
  assert.equal(sh(fx.repo, "branch", "--list", "hector-tasks/*"), "", "task branches cleaned up after success");
  console.log("✓ crash (SIGKILL mid-task) → resume: same run, finished phases and T1 skipped, half-done edits discarded, usage adds up");
}

async function resumeFailedAndNeedsHuman() {
  // failed at review (e.g. provider outage longer than the retries) → resume repeats only review onwards
  const fx = makeDurableRepo({ policy: { agentRetries: 0, agentRetryDelaySeconds: 0, reviewRounds: 1 } });
  const config = ConfigSchema.parse(fx.config);
  const first = new ScriptedRunner(
    {
      ...durableScript(),
      "coder:T1": [clampWorker],
      "coder:T2": [lerpWorker],
      review: [
        () => {
          throw new Error("503 Service Unavailable");
        },
      ],
    },
    byTask,
  );
  const s1 = await implementTicket({ repo: fx.repo, ticket: await readTicket(fx.ticket), config, runner: first });
  assert.equal(s1.status, "failed");
  const second = new ScriptedRunner({ review: [approve], qaPlan: [qaPlan] }, byTask);
  const s2 = await implementTicket({ repo: fx.repo, ticket: await readTicket(fx.ticket), config, runner: second, resume: { runDir: s1.runDir } });
  assert.equal(s2.status, "completed", s2.reason);
  assert.deepEqual(second.roles, ["review", "qaPlan"], "everything before review was kept");

  // needs_human because the repair budget ran out → resume with fresh budgets
  const fx2 = makeDurableRepo({ policy: { repairAttempts: 0, agentRetryDelaySeconds: 0, reviewRounds: 1 } });
  const config2 = ConfigSchema.parse(fx2.config);
  const broken = (cwd: string) => (write(cwd, "src/lerp.js", "export const lerp = () => 0;\n"), { changedFiles: ["src/lerp.js"], notes: "wrong" });
  const r1 = await implementTicket({
    repo: fx2.repo,
    ticket: await readTicket(fx2.ticket),
    config: config2,
    runner: new ScriptedRunner({ ...durableScript(), "coder:T1": [clampWorker], "coder:T2": [broken] }, byTask),
  });
  assert.equal(r1.status, "needs_human");
  assert.match(r1.reason!, /still failing after 0 repair attempts/);
  const fixer = new ScriptedRunner(
    {
      diagnose: [() => ({ owner: "implementation", errorSignature: "lerp", rootCause: "lerp returns 0", files: ["src/lerp.js"], fixPlan: "interpolate" })],
      "coder:fix": [lerpWorker],
      review: [approve],
      qaPlan: [qaPlan],
    },
    byTask,
  );
  const r2 = await implementTicket({
    repo: fx2.repo,
    ticket: await readTicket(fx2.ticket),
    config: ConfigSchema.parse({ ...fx2.config, policy: { ...fx2.config.policy, repairAttempts: 1 } }),
    runner: fixer,
    resume: { runDir: r1.runDir, freshBudgets: true },
  });
  assert.equal(r2.status, "completed", r2.reason);
  assert.deepEqual(fixer.roles, ["diagnose", "coder", "review", "qaPlan"]);
  assert.equal(fixer.calls[1]!.resume, fixer.calls[1]!.sessionId, "the defect went back to T2's worker, resuming its session");
  console.log("✓ resume after failed (outage) and needs_human (fresh budgets): only the remaining work runs");
}

async function loopResumesInterrupted() {
  const fx = makeDurableRepo();
  spawnSync(process.execPath, ["--import", "tsx", "test/durable-child.ts", fx.repo, fx.ticket, fx.configPath], { timeout: 120_000 });
  const config = ConfigSchema.parse(fx.config);
  // The loop that was running this ticket died with it.
  const store = await LoopStore.open(flowPaths(fx.repo, config).loop);
  await store.set({ id: "DUR-1", title: "Add clamp and lerp", ref: "DUR-1.md", status: "running" });
  const lines: string[] = [];
  const runner = new ScriptedRunner({ "coder:T2": [lerpWorker], review: [approve], qaPlan: [qaPlan] }, byTask);
  const res = await runLoop({ repo: fx.repo, config, runner, mode: "manual", once: true, log: (l) => lines.push(l) });
  assert.deepEqual(res.processed.map((p) => [p.id, p.status]), [["DUR-1", "completed"]]);
  assert.ok(lines.some((l) => /resuming the interrupted run DUR-1-/.test(l)), lines.join("\n"));
  assert.deepEqual(runner.roles, ["coder", "review", "qaPlan"]);

  // Interrupted before its first checkpoint: cleaned and started over.
  const fx2 = makeDurableRepo();
  const config2 = ConfigSchema.parse(fx2.config);
  sh(fx2.repo, "branch", "hector/DUR-1"); // left by a crash before any state was written
  const store2 = await LoopStore.open(flowPaths(fx2.repo, config2).loop);
  await store2.set({ id: "DUR-1", title: "x", ref: "DUR-1.md", status: "running" });
  const lines2: string[] = [];
  const runner2 = new ScriptedRunner({ ...durableScript(), "coder:T1": [clampWorker], "coder:T2": [lerpWorker], review: [approve], qaPlan: [qaPlan] }, byTask);
  const res2 = await runLoop({ repo: fx2.repo, config: config2, runner: runner2, mode: "manual", once: true, log: (l) => lines2.push(l) });
  assert.deepEqual(res2.processed.map((p) => p.status), ["completed"]);
  assert.ok(lines2.some((l) => /before any progress was saved; starting it again/.test(l)));
  console.log("✓ loop: an interrupted ticket is resumed first; one interrupted before any checkpoint starts over");
}

async function worktreeReset() {
  const fx = makeDurableRepo();
  const wt = fx.repo;
  sh(wt, "checkout", "-q", "-b", "other");
  write(wt, "src/index.js", "export const a = 1;\n");
  sh(wt, "commit", "-qam", "other");
  sh(wt, "checkout", "-q", "main");
  write(wt, "src/index.js", "export const a = 2;\n");
  sh(wt, "commit", "-qam", "main");
  spawnSync("git", ["merge", "other"], { cwd: wt }); // leaves a conflicted merge in progress
  write(wt, "src/new.js", "// untracked\n");
  const dropped = await resetWorktree(wt);
  assert.ok(dropped.includes("src/new.js"));
  assert.equal(sh(wt, "status", "--porcelain"), "", "clean");
  assert.ok(!existsSync(join(wt, ".git", "MERGE_HEAD")), "unfinished merge aborted");
  console.log("✓ resetWorktree: aborts an unfinished merge, drops edits and new files, keeps commits");
}

classification();
await retries();
await crashAndResume();
await resumeFailedAndNeedsHuman();
await loopResumesInterrupted();
await worktreeReset();
console.log("\ndurable checks passed");
