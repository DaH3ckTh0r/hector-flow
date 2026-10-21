/**
 * Token usage: what each runtime reports becomes the same normalized counts,
 * resumed Claude sessions only count their new turns, and the reports group
 * the run logs correctly. No model calls.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ConfigSchema } from "../src/config.js";
import { ClaudeAgentRunner } from "../src/runner/claude-runner.js";
import { CodexAgentRunner, codexUsage } from "../src/runner/codex-runner.js";
import { addCopilotUsage, CopilotAgentRunner, type CopilotClientLike } from "../src/runner/copilot-runner.js";
import { OpenCodeAgentRunner, type OpencodeClientLike } from "../src/runner/opencode-runner.js";
import { describeCounts, diffUsage, fmtTokens, groupUsage, readUsageRecords, sumUsage, totalTokens, type Usage } from "../src/usage.js";

const Out = z.object({ answer: z.string() });
const dir = mkdtempSync(join(tmpdir(), "hector-usage-"));
const config = ConfigSchema.parse({ testCommand: "npm test" });
const req = (over: Record<string, unknown> = {}) => ({
  role: "coder" as const,
  mode: "readonly" as const,
  cwd: dir,
  systemPrompt: "s",
  prompt: "p",
  schema: Out,
  ...over,
});

// ─────────────────────────────────────────── Claude: per model, resume delta

async function claude() {
  // The SDK's result carries running totals for the session (earlier turns included on resume).
  const results = [
    { session_id: "s1", total_cost_usd: 0.5, modelUsage: { "claude-sonnet-5-5": mu(1000, 200, 3000, 500, 0.4, 50), "claude-haiku-5-5": mu(100, 10, 0, 0, 0.1) } },
    { session_id: "s1", total_cost_usd: 0.8, modelUsage: { "claude-sonnet-5-5": mu(1600, 300, 7000, 900, 0.7, 80), "claude-haiku-5-5": mu(100, 10, 0, 0, 0.1) } },
  ];
  let i = 0;
  const fakeQuery = (() =>
    (async function* () {
      const r = results[i++]!;
      yield { type: "result", subtype: "success", num_turns: 3, structured_output: { answer: "ok" }, ...r };
    })()) as never;
  const runner = new ClaudeAgentRunner(config, fakeQuery);

  const first = await runner.run(req());
  assert.equal(first.costUsd, 0.5);
  assert.deepEqual(first.usage!["claude-sonnet-5-5"], { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 500, reasoning: 50, costUsd: 0.4 });
  assert.equal(totalTokens(sumUsage(first.usage)), 1000 + 200 + 3000 + 500 + 100 + 10);

  const resumed = await runner.run(req({ resumeSessionId: "s1" }));
  assert.equal(Math.round(resumed.costUsd * 100) / 100, 0.3, "only the new turns' cost, not the session's running total");
  assert.deepEqual(Object.keys(resumed.usage!), ["claude-sonnet-5-5"], "a model with no new calls is left out");
  const d = resumed.usage!["claude-sonnet-5-5"]!;
  assert.deepEqual([d.input, d.output, d.cacheRead, d.cacheWrite, d.reasoning], [600, 100, 4000, 400, 30]);
  console.log("✓ claude: per-model tokens and cost; a resumed session counts only its new turns (cost included)");
}

function mu(input: number, output: number, cacheRead: number, cacheWrite: number, costUSD: number, thinkingTokens?: number) {
  return { inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite, costUSD, thinkingTokens, webSearchRequests: 0, contextWindow: 0, maxOutputTokens: 0 };
}

// ─────────────────────────────────────────────────────────────────── Codex

async function codex() {
  const u = { input_tokens: 5000, cached_input_tokens: 3000, cache_write_input_tokens: 0, output_tokens: 700, reasoning_output_tokens: 300 };
  assert.deepEqual(codexUsage(u, "gpt-5.5")["gpt-5.5"], { input: 2000, output: 700, cacheRead: 3000, cacheWrite: 0, reasoning: 300, costUsd: 0 }, "OpenAI input includes cached tokens: split them");
  assert.deepEqual(Object.keys(codexUsage(u, undefined)), ["codex default"]);
  assert.deepEqual(codexUsage(null, "x"), {});
  const runner = new CodexAgentRunner(config, () => ({
    startThread: () => ({ id: "t", run: async () => ({ items: [], finalResponse: '{"answer":"x"}', usage: u }) }),
    resumeThread: () => assert.fail(),
  }));
  const res = await runner.run(req({ model: "gpt-5.5" }));
  assert.equal(totalTokens(sumUsage(res.usage)), 2000 + 3000 + 700);
  const bad = new CodexAgentRunner(config, () => ({
    startThread: () => ({ id: "t", run: async () => ({ items: [], finalResponse: "no json", usage: u }) }),
    resumeThread: () => assert.fail(),
  }));
  const err = await bad.run(req()).catch((e) => e);
  assert.equal(totalTokens(sumUsage(err.usage)), 5700, "a failed call still reports what it spent");
  await runner.close();
  console.log("✓ codex: cached input split out of input_tokens; failed calls keep their usage");
}

// ──────────────────────────────────────────────────────────────── OpenCode

async function opencode() {
  const now = Date.now();
  const step = (input: number, output: number, read: number, write: number, cost: number) => ({
    type: "step-finish",
    cost,
    tokens: { input, output, reasoning: 0, cache: { read, write } },
  });
  const messages = [
    { info: { role: "assistant", time: { created: now - 60_000 }, providerID: "old", modelID: "x", cost: 9 }, parts: [step(9, 9, 9, 9, 9)] },
    { info: { role: "user", time: { created: now } , cost: 0 }, parts: [] },
    { info: { role: "assistant", time: { created: now + 10 }, providerID: "anthropic", modelID: "claude-sonnet-5-5", cost: 0.03 }, parts: [step(100, 20, 1000, 50, 0.01), step(80, 30, 1100, 0, 0.02)] },
    { info: { role: "assistant", time: { created: now + 20 }, providerID: "anthropic", modelID: "claude-sonnet-5-5", structured: { answer: "ok" }, cost: 0.005 }, parts: [step(10, 40, 1200, 0, 0.005)] },
  ];
  const client: OpencodeClientLike = {
    global: { event: async () => ({ stream: (async function* () {})() }) },
    session: {
      create: async () => ({ data: { id: "ses" } }),
      prompt: async () => ({ data: messages[3] as never }),
      messages: async () => ({ data: messages as never }),
    },
    permission: { reply: async () => ({ data: true }) },
    mcp: { add: async () => ({ data: {} }), disconnect: async () => ({ data: true }) },
  };
  const runner = new OpenCodeAgentRunner(config, async () => ({ client, close: () => undefined }));
  const res = await runner.run(req());
  const c = res.usage!["anthropic/claude-sonnet-5-5"]!;
  assert.deepEqual([c.input, c.output, c.cacheRead, c.cacheWrite], [190, 90, 3300, 50], "every step of every message this prompt created, not just the last");
  assert.equal(Math.round(res.costUsd * 1000) / 1000, 0.035, "cost summed over the same steps");
  assert.equal(res.usage!["old/x"], undefined, "earlier messages are not counted");
  await runner.close();
  console.log("✓ opencode: sums step-finish usage of all messages the prompt created");
}

// ───────────────────────────────────────────────────────────────── Copilot

async function copilot() {
  const events = [
    { model: "gpt-5.5", inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 0, reasoningTokens: 120, cost: 1, copilotUsage: { totalNanoAiu: 5000 } },
    { model: "gpt-5.5", inputTokens: 1500, outputTokens: 100, cacheReadTokens: 1300, cost: 1, copilotUsage: { totalNanoAiu: 4000 } },
  ];
  const client: CopilotClientLike = {
    start: async () => undefined,
    stop: async () => undefined,
    getAuthStatus: async () => ({ isAuthenticated: true }),
    resumeSession: async () => assert.fail(),
    createSession: async () => {
      const handlers: Array<(e: { data?: unknown }) => void> = [];
      return {
        sessionId: "cs",
        on: (type, h) => (type === "assistant.usage" && handlers.push(h), () => undefined),
        disconnect: async () => undefined,
        sendAndWait: async () => {
          for (const e of events) handlers.forEach((h) => h({ data: e }));
          return { data: { content: '{"answer":"ok"}' } };
        },
      };
    },
  };
  const res = await new CopilotAgentRunner(config, () => client).run(req());
  const c = res.usage!["gpt-5.5"]!;
  assert.deepEqual([c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning], [2700, 400, 2100, 0, 120]);
  assert.deepEqual(c.extra, { nanoAiu: 9000, billingMultiplier: 2 }, "Copilot's own billing counters kept");
  assert.equal(res.turns, 2);
  assert.deepEqual(addCopilotUsage({}, { inputTokens: 1 })["copilot default"]!.input, 1);
  console.log("✓ copilot: one assistant.usage per model call, summed per model, with Copilot billing counters");
}

// ─────────────────────────────────────────────────────────────── reports

async function reports() {
  const runs = join(dir, "_runs");
  const line = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";
  const u = (model: string, input: number, output: number, costUsd = 0): Usage => ({ [model]: { input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd } });
  mkdirSync(join(runs, "AB-1-2026-10-20T10-00-00-000Z-aaaa"), { recursive: true });
  mkdirSync(join(runs, "AB-2-2026-10-21T09-00-00-000Z-bbbb"), { recursive: true });
  writeFileSync(
    join(runs, "AB-1-2026-10-20T10-00-00-000Z-aaaa", "events.jsonl"),
    line({ ts: "2026-10-20T10:00:01Z", runId: "AB-1-2026-10-20T10-00-00-000Z-aaaa", type: "step.start", step: "enrich" }) +
      line({ ts: "2026-10-20T10:00:02Z", runId: "AB-1-2026-10-20T10-00-00-000Z-aaaa", type: "step.end", step: "enrich", ok: true, role: "enrich", runtime: "claude", usage: u("claude-sonnet-5-5", 100, 10, 0.01) }) +
      line({ ts: "2026-10-20T10:00:03Z", runId: "AB-1-2026-10-20T10-00-00-000Z-aaaa", type: "step.end", step: "implement-T1", ok: true, role: "coder", runtime: "codex", usage: u("gpt-5.5", 1000, 100) }) +
      line({ ts: "2026-10-20T10:00:04Z", runId: "AB-1-2026-10-20T10-00-00-000Z-aaaa", type: "step.end", step: "implement-T2", ok: false, role: "coder", runtime: "codex", usage: u("gpt-5.5", 500, 50) }) +
      '{"type":"step.end","usage":', // half-written line from a crash
  );
  writeFileSync(
    join(runs, "AB-2-2026-10-21T09-00-00-000Z-bbbb", "events.jsonl"),
    line({ ts: "2026-10-21T09:00:02Z", runId: "AB-2-2026-10-21T09-00-00-000Z-bbbb", type: "step.end", step: "review:security", ok: true, role: "review", runtime: "copilot", usage: u("claude-sonnet-5-5", 300, 30) }),
  );
  const records = await readUsageRecords(runs);
  assert.equal(records.length, 4, "every step.end with usage; broken lines skipped");
  assert.deepEqual(records.map((r) => r.ticketId), ["AB-1", "AB-1", "AB-1", "AB-2"]);
  const byModel = groupUsage(records, "model");
  assert.deepEqual(byModel.map((r) => [r.key, r.calls, r.input]), [["gpt-5.5 (codex)", 2, 1500], ["claude-sonnet-5-5 (copilot)", 1, 300], ["claude-sonnet-5-5 (claude)", 1, 100]], "same model on two runtimes stays apart");
  assert.deepEqual(groupUsage(records, "step").map((r) => r.key), ["implement-T*", "review:security", "enrich"], "tasks grouped");
  assert.deepEqual(groupUsage(records, "ticket").map((r) => [r.key, r.calls]), [["AB-1", 3], ["AB-2", 1]]);
  assert.deepEqual(groupUsage(records, "day").map((r) => r.key).sort(), ["2026-10-20", "2026-10-21"]);
  assert.equal(groupUsage(records, "runtime")[0]!.key, "codex");

  assert.deepEqual(diffUsage(u("m", 10, 1), u("m", 10, 1)), {}, "nothing new, nothing reported");
  assert.equal(fmtTokens(999), "999");
  assert.equal(fmtTokens(12_345), "12k");
  assert.equal(fmtTokens(2_500_000), "2.50M");
  assert.equal(describeCounts({ input: 1200, output: 300, cacheRead: 40_000, cacheWrite: 3100, reasoning: 80, costUsd: 0 }), "in 1.2k · cache w 3.1k r 40k · out 300 (reasoning 80) · total 45k");
  console.log("✓ reports: run logs read, grouped by model/runtime/step/ticket/day; crash lines skipped");
}

await claude();
await codex();
await opencode();
await copilot();
await reports();
console.log("\nusage checks passed");
