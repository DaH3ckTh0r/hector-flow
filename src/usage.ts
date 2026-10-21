import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Tokens one or more model calls consumed, normalized across runtimes:
 *  - input:      input tokens NOT served from the prompt cache
 *  - cacheWrite: input tokens written to the prompt cache
 *  - cacheRead:  input tokens served from the prompt cache
 *  - output:     output tokens (reasoning included)
 *  - reasoning:  reasoning/thinking tokens, already counted in output (when reported)
 * total = input + cacheWrite + cacheRead + output.
 */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** Estimated USD, when the runtime reports it (Claude, OpenCode). */
  costUsd: number;
  /** Runtime-specific counters, e.g. webSearchRequests (Claude), nanoAiu and billingMultiplier (Copilot). */
  extra?: Record<string, number>;
}

/** Usage of one agent call or many, by model id. */
export type Usage = Record<string, TokenCounts>;

export const emptyCounts = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 });

export const totalTokens = (c: TokenCounts) => c.input + c.cacheWrite + c.cacheRead + c.output;

export function addCounts(into: TokenCounts, add: Partial<TokenCounts>): TokenCounts {
  into.input += add.input ?? 0;
  into.output += add.output ?? 0;
  into.cacheRead += add.cacheRead ?? 0;
  into.cacheWrite += add.cacheWrite ?? 0;
  into.reasoning += add.reasoning ?? 0;
  into.costUsd += add.costUsd ?? 0;
  for (const [k, v] of Object.entries(add.extra ?? {})) {
    if (!v) continue;
    into.extra ??= {};
    into.extra[k] = (into.extra[k] ?? 0) + v;
  }
  return into;
}

/** Adds one call's usage of a model into a Usage map. */
export function addModel(into: Usage, model: string, add: Partial<TokenCounts>): Usage {
  addCounts((into[model] ??= emptyCounts()), add);
  return into;
}

export function addUsage(into: Usage, add: Usage | undefined): Usage {
  for (const [model, c] of Object.entries(add ?? {})) addModel(into, model, c);
  return into;
}

export function sumUsage(u: Usage | undefined): TokenCounts {
  return Object.values(u ?? {}).reduce((acc, c) => addCounts(acc, c), emptyCounts());
}

/** current − previous, per model and field (for runtimes that report running totals). */
export function diffUsage(current: Usage, previous: Usage | undefined): Usage {
  if (!previous) return current;
  const out: Usage = {};
  for (const [model, c] of Object.entries(current)) {
    const p = previous[model] ?? emptyCounts();
    const extra: Record<string, number> = {};
    for (const [k, v] of Object.entries(c.extra ?? {})) extra[k] = Math.max(0, v - (p.extra?.[k] ?? 0));
    const d: TokenCounts = {
      input: Math.max(0, c.input - p.input),
      output: Math.max(0, c.output - p.output),
      cacheRead: Math.max(0, c.cacheRead - p.cacheRead),
      cacheWrite: Math.max(0, c.cacheWrite - p.cacheWrite),
      reasoning: Math.max(0, c.reasoning - p.reasoning),
      costUsd: Math.max(0, c.costUsd - p.costUsd),
      ...(Object.keys(extra).length ? { extra } : {}),
    };
    if (totalTokens(d) || d.costUsd) out[model] = d;
  }
  return out;
}

/** 1234 → "1.2k", 2_500_000 → "2.5M". */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

/** One line: "in 12k · cache w 3.1k r 40k · out 2.2k (reasoning 800) · total 57k". */
export function describeCounts(c: TokenCounts): string {
  return [
    `in ${fmtTokens(c.input)}`,
    `cache w ${fmtTokens(c.cacheWrite)} r ${fmtTokens(c.cacheRead)}`,
    `out ${fmtTokens(c.output)}${c.reasoning ? ` (reasoning ${fmtTokens(c.reasoning)})` : ""}`,
    `total ${fmtTokens(totalTokens(c))}`,
  ].join(" · ");
}

// ── Reports over run logs ─────────────────────────────────────────────────

/** One agent call as recorded in events.jsonl (step.end with usage). */
export interface UsageRecord {
  ts: string;
  runId: string;
  ticketId: string;
  step: string;
  attempt?: number;
  role?: string;
  runtime: string;
  ok: boolean;
  usage: Usage;
}

export type UsageGroup = "model" | "runtime" | "step" | "role" | "ticket" | "run" | "day";

export async function readUsageRecords(runsDir: string): Promise<UsageRecord[]> {
  const out: UsageRecord[] = [];
  const runs = await readdir(runsDir).catch(() => [] as string[]);
  for (const run of runs.sort()) {
    const text = await readFile(join(runsDir, run, "events.jsonl"), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line.includes('"step.end"') || !line.includes('"usage"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.type !== "step.end" || !e.usage) continue;
        out.push({
          ts: e.ts,
          runId: e.runId,
          ticketId: e.ticketId ?? String(e.runId).replace(/-\d{4}-\d{2}-\d{2}T.*$/, ""),
          step: e.step,
          attempt: e.attempt,
          role: e.role,
          runtime: e.runtime ?? "claude",
          ok: e.ok,
          usage: e.usage,
        });
      } catch {
        // A half-written line from a crashed run: skip it.
      }
    }
  }
  return out;
}

export interface UsageRow extends TokenCounts {
  key: string;
  calls: number;
}

/** Groups records; "model" splits each call by model, the others keep a call whole. */
export function groupUsage(records: UsageRecord[], by: UsageGroup): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  const row = (key: string) => rows.get(key) ?? rows.set(key, { key, calls: 0, ...emptyCounts() }).get(key)!;
  for (const r of records) {
    if (by === "model") {
      for (const [model, c] of Object.entries(r.usage)) {
        const x = row(`${model} (${r.runtime})`);
        x.calls++;
        addCounts(x, c);
      }
      continue;
    }
    const key =
      by === "runtime" ? r.runtime
      : by === "step" ? r.step.replace(/-T\d+$/, "-T*")
      : by === "role" ? (r.role ?? "?")
      : by === "ticket" ? r.ticketId
      : by === "run" ? r.runId
      : r.ts.slice(0, 10);
    const x = row(key);
    x.calls++;
    addCounts(x, sumUsage(r.usage));
  }
  return [...rows.values()].sort((a, b) => totalTokens(b) - totalTokens(a));
}
