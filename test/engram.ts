/**
 * Engram as the memory backend, through its MCP server (stdio). The server
 * here is test/fake-engram.mjs, which mirrors Engram's mem_search/mem_save
 * contract; hector-flow talks to it exactly as it would to `engram mcp`.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { checkEngram } from "../src/check.js";
import { findResumableRun } from "../src/checkpoint.js";
import { ConfigSchema } from "../src/config.js";
import { MemoryStore } from "../src/memory.js";
import { EngramMemory, engramContent } from "../src/memory-backend.js";
import { readTicket } from "../src/ticket.js";
import { flowPaths, implementTicket } from "../src/workflow.js";
import { approve, durableScript, LERP, makeDurableRepo, qaPlan, CLAMP } from "./durable-fixture.js";
import { byTask, ScriptedRunner, write } from "./helpers.js";

const FAKE = resolve("test/fake-engram.mjs");
const engramConfig = (dataDir: string, extra: Record<string, unknown> = {}) => ({
  memory: { backend: "engram", engram: { command: process.execPath, args: [FAKE, ...((extra.args as string[]) ?? [])], dataDir } },
});
const db = (dataDir: string) =>
  existsSync(join(dataDir, "fake-engram.json")) ? JSON.parse(readFileSync(join(dataDir, "fake-engram.json"), "utf8")).observations : [];
const calls = (dataDir: string) =>
  existsSync(join(dataDir, "calls.jsonl"))
    ? readFileSync(join(dataDir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

async function backendUnit() {
  const dataDir = mkdtempSync(join(tmpdir(), "engram-data-"));
  const repo = mkdtempSync(join(tmpdir(), "my-service-"));
  const config = ConfigSchema.parse({ testCommand: "x", ...engramConfig(dataDir) });
  const m = new EngramMemory(config.memory.engram, repo, join(dataDir, "local.jsonl"));
  assert.deepEqual((await m.probe()).sort(), ["mem_save", "mem_search"]);

  await m.save({ title: "Amounts are integer cents", content: "Money in the cart is stored in cents to avoid rounding", kind: "decision", tags: ["money"], files: ["src/cart.js"], ticketId: "T-1", runId: "run-1", role: "coder" });
  assert.equal((await m.save({ title: "Amounts are integer cents", content: "Money in the cart is stored in cents to avoid rounding", kind: "decision", tags: [], files: [], ticketId: "T-1", runId: "run-1", role: "coder" })).duplicate, true);
  assert.equal(db(dataDir).length, 0, "nothing reaches Engram before the run completes");
  assert.match(await m.search("cart money rounding", { limit: 5, runId: "run-1" }), /From this run \(not yet saved to Engram\):\n- \[decision\] Amounts are integer cents/);
  assert.doesNotMatch(await m.search("cart money", { limit: 5, runId: "other-run" }), /integer cents/, "another run never sees provisional memories");

  assert.equal(await m.commit("run-1"), 1);
  const saved = db(dataDir);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].type, "decision");
  assert.equal(saved[0].project, basename(repo), "Engram resolves the project from the repo the server runs in");
  assert.equal(saved[0].content, engramContent({ title: "", content: "Money in the cart is stored in cents to avoid rounding", kind: "decision", tags: ["money"], files: ["src/cart.js"], ticketId: "T-1", runId: "run-1", role: "coder" }));
  assert.match(saved[0].content, /^\*\*What\*\*: Money in the cart.*\n\*\*Why\*\*: decision recorded by hector-flow's coder step while implementing T-1\n\*\*Where\*\*: src\/cart\.js/);
  const save = calls(dataDir).find((c) => c.tool === "mem_save")!;
  assert.equal(save.args.capture_prompt, false, "automated saves do not capture a prompt");
  assert.equal(save.args.project, undefined, "no explicit project unless configured");
  assert.deepEqual(m.pending(), []);
  assert.match(await m.search("cents", { limit: 5, runId: "run-2" }), /Found 1 memories:[\s\S]*#1 \(decision\) — Amounts are integer cents/);
  assert.equal(calls(dataDir).filter((c) => c.tool === "mem_search").at(-1).args.match_mode, "any");
  await m.close();
  console.log("✓ engram backend: buffered until commit, visible to its own run only, written with Engram's type/content format, project from the repo");
}

async function workflowWithEngram() {
  const dataDir = mkdtempSync(join(tmpdir(), "engram-data-"));
  const fx = makeDurableRepo(engramConfig(dataDir));
  const config = ConfigSchema.parse(fx.config);
  const savingWorker = (file: string, body: string, title: string) => async (cwd: string, req: { memory?: { save?: (m: never) => Promise<string> } }) => {
    const answer = await req.memory?.save?.({ title, content: `${title} — see ${file}`, kind: "gotcha", files: [file] } as never);
    assert.match(answer!, /becomes permanent if this run completes/);
    write(cwd, file, body);
    return { changedFiles: [file], notes: "done" };
  };

  // A failed run writes nothing to Engram.
  const failing = new ScriptedRunner(
    {
      ...durableScript(),
      "coder:T1": [savingWorker("src/clamp.js", CLAMP, "clamp gotcha")],
      "coder:T2": [savingWorker("src/lerp.js", LERP, "lerp gotcha")],
      review: [
        () => {
          throw new Error("Agent failed: error_max_turns");
        },
      ],
    },
    byTask,
  );
  const s1 = await implementTicket({ repo: fx.repo, ticket: await readTicket(fx.ticket), config, runner: failing });
  assert.equal(s1.status, "failed");
  assert.equal(s1.memoriesSaved, 2);
  assert.equal(db(dataDir).length, 0, "a failed run never teaches Engram");

  // Resuming it completes the run: its memories are written then, once.
  const s2 = await implementTicket({
    repo: fx.repo,
    ticket: await readTicket(fx.ticket),
    config,
    runner: new ScriptedRunner({ review: [approve], qaPlan: [qaPlan] }, byTask),
    resume: { runDir: s1.runDir },
  });
  assert.equal(s2.status, "completed", s2.reason);
  assert.deepEqual(db(dataDir).map((o: { title: string }) => o.title).sort(), ["clamp gotcha", "lerp gotcha"]);
  const ev = readFileSync(join(s2.runDir, "events.jsonl"), "utf8");
  assert.match(ev, /2 memories from this run written to Engram/);

  // The next ticket's enrich step recalls them from Engram.
  const fx2 = makeDurableRepo({ ...engramConfig(dataDir), memory: { ...engramConfig(dataDir).memory, engram: { ...engramConfig(dataDir).memory.engram, project: basename(fx.repo) } } });
  let enrichPrompt = "";
  const next = new ScriptedRunner(
    {
      ...durableScript(),
      enrich: [(_cwd: string, req: { prompt: string }) => ((enrichPrompt = req.prompt), durableScript().enrich![0]!(_cwd, req as never))],
      "coder:T1": [savingWorker("src/clamp.js", CLAMP, "another clamp note")],
      "coder:T2": [savingWorker("src/lerp.js", LERP, "another lerp note")],
      review: [approve],
      qaPlan: [qaPlan],
    } as never,
    byTask,
  );
  const s3 = await implementTicket({ repo: fx2.repo, ticket: await readTicket(fx2.ticket), config: ConfigSchema.parse(fx2.config), runner: next });
  assert.equal(s3.status, "completed", s3.reason);
  assert.match(enrichPrompt, /clamp gotcha|lerp gotcha/, "Engram memories reach the next ticket's enrich");
  console.log("✓ workflow + engram: failed run writes nothing, resumed run writes once on completion, the next ticket recalls them");
}

async function crashKeepsPendingMemories() {
  const dataDir = mkdtempSync(join(tmpdir(), "engram-data-"));
  const fx = makeDurableRepo(engramConfig(dataDir));
  const child = spawnSync(process.execPath, ["--import", "tsx", "test/durable-child.ts", fx.repo, fx.ticket, fx.configPath, "save-memory"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(child.signal, "SIGKILL", child.stderr);
  const config = ConfigSchema.parse(fx.config);
  const found = await findResumableRun(flowPaths(fx.repo, config).runs, "DUR-1");
  assert.equal((found!.state.pendingMemories as Array<{ title: string }>).map((m) => m.title).join(), "clamp uses Math.min/Math.max", "the unsaved memory is in the checkpoint");
  assert.equal(db(dataDir).length, 0);
  const s = await implementTicket({
    repo: fx.repo,
    ticket: await readTicket(fx.ticket),
    config,
    runner: new ScriptedRunner({ "coder:T2": [(cwd: string) => (write(cwd, "src/lerp.js", LERP), { changedFiles: ["src/lerp.js"], notes: "" })], review: [approve], qaPlan: [qaPlan] }, byTask),
    resume: { runDir: found!.runDir },
  });
  assert.equal(s.status, "completed", s.reason);
  assert.deepEqual(db(dataDir).map((o: { title: string; type: string }) => [o.title, o.type]), [["clamp uses Math.min/Math.max", "pattern"]]);
  console.log("✓ crash with unsaved Engram memories: kept in the checkpoint, written once when the resumed run completes");
}

async function engramDownAtCommit() {
  const dataDir = mkdtempSync(join(tmpdir(), "engram-data-"));
  const local = join(dataDir, "local.jsonl");
  const config = ConfigSchema.parse({ testCommand: "x", ...engramConfig(dataDir, { args: ["--fail-saves"] }) });
  const lines: string[] = [];
  const m = new EngramMemory(config.memory.engram, process.cwd(), local, [], (l) => lines.push(l));
  await m.save({ title: "keep me", content: "important", kind: "gotcha", tags: [], files: [], ticketId: "T", runId: "r", role: "coder" });
  assert.equal(await m.commit("r"), 1);
  await m.close();
  const kept = (await MemoryStore.open(local)).all();
  assert.deepEqual(kept.map((e) => [e.title, e.status]), [["keep me", "validated"]], "a completed run's memories are never lost");
  assert.ok(lines.some((l) => /kept in .*local\.jsonl because Engram did not accept them/.test(l)));
  console.log("✓ engram rejects saves at commit: memories kept in the local file instead");
}

async function checkAndCli() {
  const dataDir = mkdtempSync(join(tmpdir(), "engram-data-"));
  const ok = await checkEngram(ConfigSchema.parse({ testCommand: "x", ...engramConfig(dataDir) }), process.cwd());
  assert.equal(ok.ok, true, ok.detail);
  assert.match(ok.label, /^memory: Engram/);
  const bad = await checkEngram(ConfigSchema.parse({ testCommand: "x", memory: { backend: "engram", engram: { command: "/nonexistent/engram" } } }), process.cwd());
  assert.equal(bad.ok, false);
  assert.match(bad.detail!, /Could not start `\/nonexistent\/engram mcp --tools=agent`.*Install Engram/);

  const fx = makeDurableRepo(engramConfig(dataDir));
  const m = new EngramMemory(ConfigSchema.parse(fx.config).memory.engram, fx.repo, "/dev/null");
  await m.save({ title: "cli visible", content: "searchable from the CLI", kind: "discovery", tags: [], files: [], ticketId: "T", runId: "r", role: "enrich" });
  await m.commit("r");
  await m.close();
  const cli = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "memory", "--repo", fx.repo, "--config", fx.configPath, "search", "cli", "searchable"], { encoding: "utf8" });
  assert.match(cli.stdout, /cli visible/, cli.stderr);
  const list = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "memory", "--repo", fx.repo, "--config", fx.configPath, "list"], { encoding: "utf8" });
  assert.match(list.stdout, /Memory lives in Engram.*engram tui/);
  console.log("✓ check starts engram mcp and finds its tools (or explains how to fix it); memory search goes through Engram");
}

await backendUnit();
await workflowWithEngram();
await crashKeepsPendingMemories();
await engramDownAtCommit();
await checkAndCli();
console.log("\nengram checks passed");
