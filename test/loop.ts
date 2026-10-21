/**
 * Memory, MCP access, backlog adapters and the continuous loop, with scripted
 * runners and mocked HTTP (no model calls, no network).
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AzureDevOpsBacklog, FolderBacklog, GitHubBacklog, htmlToMarkdown, type BacklogAdapter, type BacklogItem } from "../src/backlog.js";
import { ConfigSchema } from "../src/config.js";
import { acquireLoopLock, approveTicket, loopStatus, rejectTicket, requeueTicket, runLoop } from "../src/loop.js";
import { MemoryStore, tokenize } from "../src/memory.js";
import { readTicket } from "../src/ticket.js";
import { implementTicket } from "../src/workflow.js";
import { ScriptedRunner, sh, write, type Req } from "./helpers.js";

// ── Memory store ──────────────────────────────────────────────────────────
async function memoryStore() {
  const dir = mkdtempSync(join(tmpdir(), "hector-mem-"));
  const path = join(dir, "repo.jsonl");
  const m = await MemoryStore.open(path);
  const base = { tags: [], files: [], ticketId: "A-1", role: "coder" };
  await m.save({ ...base, runId: "r1", title: "Montos en centavos", content: "Todos los importes son enteros en centavos.", kind: "convention" });
  await m.save({ ...base, runId: "r2", title: "Retry policy for Service Bus", content: "Use exponential backoff, max 5.", kind: "decision" });
  assert.equal(m.search("centavos").length, 0, "provisional entries are not returned to other runs");
  assert.equal(m.search("centavos", { runId: "r1" }).length, 1, "a run sees its own provisional entries");
  assert.equal(await m.validateRun("r1"), 1);
  assert.equal(m.search("CENTAVOS importes")[0]!.entry.title, "Montos en centavos", "search is case-insensitive");
  assert.deepEqual(tokenize("Configuración de Órdenes"), ["configuracion", "ordenes"], "accents and stopwords removed");
  const dup = await m.save({ ...base, runId: "r3", title: "montos en  centavos", content: "Todos los importes son enteros en centavos.", kind: "convention" });
  assert.equal(dup.runId, "r1", "a duplicate of a validated memory is not saved again");
  const reopened = await MemoryStore.open(path);
  assert.equal(reopened.all().length, 1, "persisted: one validated");
  assert.equal(reopened.all({ includeProvisional: true }).length, 2);
  const id = reopened.all()[0]!.id;
  assert.deepEqual(await reopened.forget([id]), [id]);
  assert.equal((await MemoryStore.open(path)).all().length, 0, "forget persists");
  console.log("✓ memory store: provisional until validated, search, dedupe, forget, persistence");
}

// ── Fixtures ──────────────────────────────────────────────────────────────
function makeProject() {
  const parent = mkdtempSync(join(tmpdir(), "hector-loop-"));
  const repo = join(parent, "calc");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "e2e@example.com");
  sh(repo, "config", "user.name", "e2e");
  write(repo, "package.json", JSON.stringify({ name: "calc", type: "module" }));
  write(repo, "src/math.js", "export const add = (a, b) => a + b;\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "init");
  mkdirSync(join(parent, "tickets"));
  return { parent, repo, tickets: join(parent, "tickets") };
}

function config(extra: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    testCommand: "node --test",
    lockedPaths: ["test/**"],
    allowedCommands: ["node --test"],
    workspacesDir: "ws",
    backlog: { type: "folder", path: "../tickets" },
    loop: { intervalSeconds: 5 },
    ...extra,
  });
}

const ticketMd = (id: string, title: string, criteria: string[]) =>
  `# ${id}: ${title}\n\n${title}.\n\n## Acceptance criteria\n${criteria.map((c) => `- ${c}`).join("\n")}\n`;

/** Queues keyed by role and ticket id: "coder:A-1", "plan:B-2"… */
const byRoleAndTicket = (r: Req) => `${r.role}:${r.prompt.match(/<ticket id="([^"]+)"/)?.[1] ?? "?"}`;

/** A full scripted run for a single-file change: writes a test, implements, approves. */
function scriptFor(id: string, opts: { test: string; impl: string; file?: string; implFile?: string; onCoder?: (req: Req) => Promise<void> }) {
  const file = opts.file ?? `test/${id}.test.js`;
  const implFile = opts.implFile ?? "src/math.js";
  return {
    [`enrich:${id}`]: [() => ({ summary: "calc", stack: ["node"], relevantFiles: [], conventions: [], openQuestions: [] })],
    [`plan:${id}`]: [() => ({ summary: id, tasks: [{ id: "T1", component: "main", dependsOn: [], description: id, files: [implFile], acceptanceCriteria: ["see ticket"] }], risks: [] })],
    [`testAuthor:${id}`]: [(cwd: string) => (write(cwd, file, opts.test), { testFiles: [file], acceptanceMap: [{ criterion: "c", command: "node --test" }] })],
    [`coder:${id}`]: [
      async (cwd: string, req: Req) => {
        await opts.onCoder?.(req);
        write(cwd, implFile, opts.impl);
        return { changedFiles: [implFile], notes: id };
      },
    ],
    [`review:${id}`]: [() => ({ approved: true, issues: [] })],
    [`qaPlan:${id}`]: [() => ({ markdown: "plan" })],
  };
}

const testFile = (imports: string, assertion: string) =>
  `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { ${imports} } from "../src/math.js";\ntest("t", () => ${assertion});\n`;

// ── Memory and MCP access inside the flow ─────────────────────────────────
async function memoryInFlow() {
  const { repo, tickets } = makeProject();
  const cfg = config({
    mcpServers: { context7: { type: "http", url: "https://mcp.context7.com/mcp" } },
    mcpAccess: { coder: ["context7"], plan: ["context7"] },
  });
  writeFileSync(join(tickets, "M-1.md"), ticketMd("M-1", "Add sub", ["sub subtracts"]));
  writeFileSync(join(tickets, "M-2.md"), ticketMd("M-2", "Add a mul helper to math.js", ["mul multiplies"]));
  let saveReply = "";
  let searchReply = "";
  const runner = new ScriptedRunner(
    {
      ...scriptFor("M-1", {
        test: testFile("sub", "assert.equal(sub(5, 3), 2)"),
        impl: "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n",
        onCoder: async (req) => {
          saveReply = await req.memory!.save!({ title: "math.js exports arrow functions", content: "Every helper in src/math.js is an exported arrow function.", kind: "convention", files: ["src/math.js"] });
          searchReply = await req.memory!.search!("arrow functions math");
        },
      }),
      ...scriptFor("M-2", {
        test: testFile("mul", "assert.equal(mul(2, 3), 6)"),
        impl: "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n",
      }),
    },
    byRoleAndTicket,
  );

  const s1 = await implementTicket({ repo, ticket: await readTicket(join(tickets, "M-1.md")), config: cfg, runner });
  assert.equal(s1.status, "completed", s1.reason);
  assert.match(saveReply, /becomes permanent if this run completes/);
  assert.match(searchReply, /math\.js exports arrow functions/, "a run finds its own provisional memory");
  assert.equal(s1.memoriesSaved, 1);
  const call = (k: string) => runner.calls.find((c) => c.key === k)!;
  assert.deepEqual(call("coder:M-1").memoryTools.sort(), ["save", "search"]);
  assert.deepEqual(call("review:M-1").memoryTools, ["search"], "review searches but does not save");
  assert.deepEqual(call("qaPlan:M-1").memoryTools, [], "qaPlan gets no memory tools");
  assert.deepEqual(call("coder:M-1").mcpServers, ["context7"], "MCP access per step");
  assert.deepEqual(call("enrich:M-1").mcpServers, []);

  // The validated memory is recalled for the next ticket's research.
  const s2 = await implementTicket({ repo, ticket: await readTicket(join(tickets, "M-2.md")), config: cfg, runner });
  assert.equal(s2.status, "completed", s2.reason);
  assert.match(call("enrich:M-2").prompt, /<memories_from_earlier_tickets>[\s\S]*arrow function/, "relevant memory injected into enrich");
  console.log("✓ memory in the flow: tools per step, provisional → validated on completion, recalled by the next ticket; MCP access per step");
}

async function failedRunMemoryIsNotRecalled() {
  const { repo, tickets } = makeProject();
  const cfg = config({ policy: { repairAttempts: 0 } });
  writeFileSync(join(tickets, "F-1.md"), ticketMd("F-1", "Add div", ["div divides"]));
  const runner = new ScriptedRunner(
    {
      ...scriptFor("F-1", {
        test: testFile("div", "assert.equal(div(6, 3), 2)"),
        impl: "export const add = (a, b) => a + b;\nexport const div = () => 0;\n",
        onCoder: async (req) => void (await req.memory!.save!({ title: "div needs no zero check", content: "Wrong lesson", kind: "decision" })),
      }),
    },
    byRoleAndTicket,
  );
  const s = await implementTicket({ repo, ticket: await readTicket(join(tickets, "F-1.md")), config: cfg, runner });
  assert.equal(s.status, "needs_human");
  const store = await MemoryStore.open(join(repo, "..", "ws", "_memory", "calc.jsonl"));
  assert.equal(store.all().length, 0, "nothing validated from a failed run");
  assert.equal(store.all({ includeProvisional: true }).length, 1, "kept as provisional for inspection");
  assert.equal(store.search("zero check div").length, 0, "never recalled");
  console.log("✓ memories from a failed run stay provisional and are never recalled");
}

// ── Backlog adapters (mocked HTTP) ────────────────────────────────────────
function mockFetch(routes: Array<{ match: RegExp; method?: string; reply: unknown; status?: number }>) {
  const calls: Array<{ url: string; method: string; body?: string; headers: Record<string, string> }> = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    const method = init.method ?? "GET";
    calls.push({ url: u, method, body: init.body as string | undefined, headers: init.headers as Record<string, string> });
    const r = routes.find((x) => x.match.test(u) && (x.method ?? "GET") === method);
    if (!r) return new Response(`no route for ${method} ${u}`, { status: 404 });
    return new Response(JSON.stringify(r.reply), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

async function adapters() {
  // Folder
  const dir = mkdtempSync(join(tmpdir(), "hector-folder-"));
  writeFileSync(join(dir, "B-2.md"), ticketMd("B-2", "Second", ["x"]));
  writeFileSync(join(dir, "A-1.md"), ticketMd("A-1", "First", ["y"]));
  writeFileSync(join(dir, "draft.md"), "# DRAFT-1: no criteria yet\n");
  writeFileSync(join(dir, "notes.txt"), "ignored");
  const folder = await new FolderBacklog(dir).list();
  assert.deepEqual(folder.items.map((i) => i.ticket.id), ["A-1", "B-2"], "name order, .md only");
  assert.equal(folder.skipped.length, 1);
  assert.match(folder.skipped[0]!.reason, /no acceptance criteria/);

  // GitHub
  const gh = mockFetch([
    {
      match: /\/repos\/acme\/shop\/issues\?state=open&labels=hector/,
      reply: [
        { number: 12, title: "Coupons", body: "Do it.\n\n## Acceptance criteria\n- [ ] BIENVENIDA10 gives 10%\n- [x] unknown → 400", html_url: "https://github.com/acme/shop/issues/12" },
        { number: 13, title: "A PR", body: "", html_url: "u", pull_request: {} },
        { number: 14, title: "Vague", body: "Make it better", html_url: "https://github.com/acme/shop/issues/14" },
      ],
    },
    { match: /\/issues\/12\/comments$/, method: "POST", reply: { id: 1 }, status: 201 },
  ]);
  const ghb = new GitHubBacklog("acme/shop", "hector", "tok", true, gh.f);
  const ghl = await ghb.list();
  assert.equal(ghl.items.length, 1);
  assert.equal(ghl.items[0]!.ticket.id, "GH-12");
  assert.equal(ghl.items[0]!.ticket.title, "Coupons");
  assert.deepEqual(ghl.items[0]!.ticket.acceptanceCriteria, ["BIENVENIDA10 gives 10%", "unknown → 400"]);
  assert.equal(ghl.skipped.length, 1, "issue without criteria skipped; PR ignored");
  assert.equal(gh.calls[0]!.headers.Authorization, "Bearer tok");
  await ghb.report(ghl.items[0]!, "done");
  assert.deepEqual(JSON.parse(gh.calls[1]!.body!), { body: "done" });

  // Azure DevOps
  const ado = mockFetch([
    { match: /\/_apis\/wit\/wiql\?api-version=7\.1$/, method: "POST", reply: { workItems: [{ id: 101 }, { id: 102 }] } },
    {
      match: /\/_apis\/wit\/workitems\?ids=101,102/,
      reply: {
        value: [
          {
            id: 101,
            fields: {
              "System.Title": "Retry Service Bus messages",
              "System.Description": "<div>Messages that fail <b>three</b> times go to the DLQ &amp; are logged.</div><h2>Notes</h2><ul><li>Use Polly</li></ul>",
              "Microsoft.VSTS.Common.AcceptanceCriteria": "<ul><li>Retries 3 times with backoff</li><li>Then dead-letters</li></ul>",
            },
          },
          { id: 102, fields: { "System.Title": "No criteria", "System.Description": "<p>tbd</p>" } },
        ],
      },
    },
    { match: /\/workItems\/101\/comments/, method: "POST", reply: { id: 9 } },
  ]);
  const adob = new AzureDevOpsBacklog(
    ConfigSchema.parse({ testCommand: "x", backlog: { type: "azure-devops", organization: "contoso", project: "Integrations" } }).backlog as never,
    "pat",
    ado.f,
  );
  assert.match(adob.wiql(), /\[System\.Tags\] CONTAINS 'hector' AND \[System\.State\] IN \('New', 'Approved'/);
  const adol = await adob.list();
  assert.equal(adol.items.length, 1);
  const t = adol.items[0]!.ticket;
  assert.equal(t.id, "ADO-101");
  assert.deepEqual(t.acceptanceCriteria, ["Retries 3 times with backoff", "Then dead-letters"]);
  assert.match(t.body, /fail three times go to the DLQ & are logged/);
  assert.match(t.body, /## Notes\n+- Use Polly/);
  assert.equal(adol.items[0]!.ref, "https://dev.azure.com/contoso/Integrations/_workitems/edit/101");
  assert.equal(adol.skipped.length, 1);
  assert.equal(ado.calls[0]!.headers.Authorization, `Basic ${Buffer.from(":pat").toString("base64")}`);
  await adob.report(adol.items[0]!, "a < b");
  assert.deepEqual(JSON.parse(ado.calls[2]!.body!), { text: "<pre>a &lt; b</pre>" });
  assert.equal(htmlToMarkdown("<p>a&nbsp;b</p><p></p><p>c</p>"), "a b\n\nc");
  console.log("✓ backlog adapters: folder, GitHub issues, Azure DevOps work items (WIQL, HTML → markdown, comments)");
}

// ── The loop ──────────────────────────────────────────────────────────────
class RecordingBacklog implements BacklogAdapter {
  readonly kind = "folder" as const;
  reports: Array<{ id: string; message: string }> = [];
  constructor(private readonly inner: FolderBacklog) {}
  list() {
    return this.inner.list();
  }
  async report(item: BacklogItem, message: string) {
    this.reports.push({ id: item.ticket.id, message });
  }
}

async function autoMode() {
  const { repo, tickets } = makeProject();
  writeFileSync(join(tickets, "A-1.md"), ticketMd("A-1", "Add sub", ["sub subtracts"]));
  writeFileSync(join(tickets, "B-2.md"), ticketMd("B-2", "Add mul", ["mul multiplies"]));
  const runner = new ScriptedRunner(
    {
      ...scriptFor("A-1", { test: testFile("sub", "assert.equal(sub(5, 3), 2)"), impl: "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n" }),
      // B starts after A was merged, so its worker sees sub and keeps it.
      ...scriptFor("B-2", { test: testFile("mul", "assert.equal(mul(2, 3), 6)"), impl: "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n" }),
    },
    byRoleAndTicket,
  );
  const cfg = config({ loop: { mode: "auto", intervalSeconds: 5 } });
  const backlog = new RecordingBacklog(new FolderBacklog(tickets));
  const lines: string[] = [];
  const res = await runLoop({ repo, config: cfg, runner, backlog, once: true, log: (l) => lines.push(l) });
  assert.deepEqual(res.processed.map((p) => [p.id, p.status]), [["A-1", "merged"], ["B-2", "merged"]]);
  assert.match(readFileSync(join(repo, "src/math.js"), "utf8"), /sub[\s\S]*mul/, "both tickets merged into main");
  assert.ok(existsSync(join(repo, "test/A-1.test.js")) && existsSync(join(repo, "test/B-2.test.js")));
  assert.equal(sh(repo, "branch", "--list", "hector*"), "", "branches cleaned after merge");
  assert.equal(sh(repo, "status", "--porcelain"), "");
  assert.match(sh(repo, "log", "--first-parent", "--format=%s", "-2"), /merge\(B-2\): Add mul\nmerge\(A-1\): Add sub/);
  assert.ok(lines.some((l) => /merged hector\/A-1 into calc:main/.test(l)));
  assert.equal(backlog.reports.length, 2);
  assert.match(backlog.reports[0]!.message, /A-1 → completed and merged/);

  // Nothing new: once returns immediately; state entries stop reprocessing.
  const again = await runLoop({ repo, config: cfg, runner, backlog, once: true, log: () => undefined });
  assert.equal(again.processed.length, 0, "tickets with state are not picked again");
  console.log("✓ loop auto: tickets processed in order, merged into main with post-merge checks, branches cleaned, results reported");
}

async function supervisedMode() {
  const { repo, tickets } = makeProject();
  // A changes add() to return a string; B's double() relies on numeric add. Each passes alone; together B breaks.
  writeFileSync(join(tickets, "A-1.md"), ticketMd("A-1", "add returns text", ["add returns a string"]));
  writeFileSync(join(tickets, "B-2.md"), ticketMd("B-2", "Add double", ["double doubles"]));
  writeFileSync(join(tickets, "C-3.md"), ticketMd("C-3", "Add neg", ["neg negates"]));
  const runner = new ScriptedRunner(
    {
      ...scriptFor("A-1", { test: testFile("add", 'assert.equal(add(2, 3), "5")'), impl: "export const add = (a, b) => String(a + b);\n" }),
      ...scriptFor("B-2", {
        test: `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { double } from "../src/double.js";\ntest("t", () => assert.equal(double(2), 4));\n`,
        impl: `import { add } from "./math.js";\nexport const double = (n) => add(n, n);\n`,
        implFile: "src/double.js",
      }),
      ...scriptFor("C-3", { test: testFile("neg", "assert.equal(neg(2), -2)"), impl: "export const add = (a, b) => a + b;\nexport const neg = (n) => -n;\n" }),
    },
    byRoleAndTicket,
  );
  // B's implementation lives in its own module that imports add from math.js.
  const cfg = config({ loop: { mode: "supervised", intervalSeconds: 5 } });
  const backlog = new RecordingBacklog(new FolderBacklog(tickets));
  const res = await runLoop({ repo, config: cfg, runner, backlog, once: true, maxTickets: 2, log: () => undefined });
  assert.deepEqual(res.processed.map((p) => [p.id, p.status]), [["A-1", "awaiting_review"], ["B-2", "awaiting_review"]], "maxTickets respected");
  assert.equal(readFileSync(join(repo, "src/math.js"), "utf8"), "export const add = (a, b) => a + b;\n", "supervised: nothing merged yet");

  const a = await approveTicket({ repo, config: cfg, ticketId: "A-1", backlog });
  assert.equal(a.status, "merged");
  const headAfterA = sh(repo, "rev-parse", "HEAD");
  const b = await approveTicket({ repo, config: cfg, ticketId: "B-2", backlog });
  assert.equal(b.status, "merge_failed");
  assert.match(b.reason!, /fails after merging\. Every repo was rolled back/);
  assert.equal(sh(repo, "rev-parse", "HEAD"), headAfterA, "main rolled back to the state before B");
  assert.equal(sh(repo, "status", "--porcelain"), "");
  assert.ok(sh(repo, "branch", "--list", "hector/B-2"), "a failed merge keeps the ticket's branch");
  assert.match(backlog.reports.at(-1)!.message, /merge failed and was rolled back/);

  const rejected = await rejectTicket({ repo, config: cfg, ticketId: "B-2", reason: "conflicts with A-1", backlog });
  assert.equal(rejected.status, "rejected");
  assert.equal(sh(repo, "branch", "--list", "hector/B-2"), "", "rejected: branches removed");
  await assert.rejects(approveTicket({ repo, config: cfg, ticketId: "B-2", backlog }), /only awaiting_review/);

  assert.equal(await requeueTicket({ repo, config: cfg, ticketId: "B-2" }), true);
  const states = await loopStatus({ repo, config: cfg });
  assert.deepEqual(states.map((s) => s.id).sort(), ["A-1"], "requeued ticket forgotten; C-3 not run yet");
  console.log("✓ loop supervised: waits for approval; approve merges; a merge that breaks main is rolled back; reject and requeue");
}

async function autoWithAssumptionsWaits() {
  const { repo, tickets } = makeProject();
  writeFileSync(join(tickets, "Q-1.md"), ticketMd("Q-1", "Add sub", ["sub subtracts"]));
  const runner = new ScriptedRunner(
    {
      ...scriptFor("Q-1", {
        test: testFile("sub", "assert.equal(sub(5, 3), 2)"),
        impl: "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n",
        onCoder: async (req) => void (await req.ask!("Negative results allowed?")),
      }),
      "lead:Q-1": [() => ({ answer: "Not specified", confident: false, basis: "ticket silent" })],
    },
    byRoleAndTicket,
  );
  const cfg = config({ loop: { mode: "auto", intervalSeconds: 5 } });
  const res = await runLoop({ repo, config: cfg, runner, once: true, log: () => undefined });
  assert.equal(res.processed[0]!.status, "awaiting_review");
  assert.match(res.processed[0]!.reason!, /1 open assumption/);
  assert.equal(readFileSync(join(repo, "src/math.js"), "utf8"), "export const add = (a, b) => a + b;\n", "not merged");
  console.log("✓ loop auto: a ticket with open assumptions waits for review instead of merging");
}

async function lockAndStop() {
  const { repo, tickets } = makeProject();
  const lockDir = join(repo, "..", "ws", "_loop");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "lock"), JSON.stringify({ pid: process.ppid, startedAt: "earlier" }));
  await assert.rejects(runLoop({ repo, config: config(), runner: new ScriptedRunner({}), once: true, log: () => undefined }), /Another hector-flow loop is running/);
  writeFileSync(join(lockDir, "lock"), JSON.stringify({ pid: 999999, startedAt: "dead" }));
  const release = await acquireLoopLock(lockDir);
  await release();
  assert.ok(!existsSync(join(lockDir, "lock")), "stale lock taken over and released");

  // An aborted signal stops the loop without processing anything.
  writeFileSync(join(tickets, "S-1.md"), ticketMd("S-1", "x", ["y"]));
  const stop = new AbortController();
  stop.abort();
  const res = await runLoop({ repo, config: config(), runner: new ScriptedRunner({}), signal: stop.signal, log: () => undefined });
  assert.equal(res.processed.length, 0);
  console.log("✓ loop lock: one loop per repo, stale locks taken over; stop signal honored");
}

await memoryStore();
await memoryInFlow();
await failedRunMemoryIsNotRecalled();
await adapters();
await autoMode();
await supervisedMode();
await autoWithAssumptionsWaits();
await lockAndStop();
console.log("\nall loop checks passed");
