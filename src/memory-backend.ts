import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { FlowConfig } from "./config.js";
import { MemoryStore, renderMemories, tokenize, type MemoryEntry, type MemoryKind } from "./memory.js";

/** A memory saved during a run. It reaches permanent memory only if the run completes. */
export interface PendingMemory {
  title: string;
  content: string;
  kind: MemoryKind;
  tags: string[];
  files: string[];
  ticketId: string;
  runId: string;
  role: string;
}

/**
 * Where the flow's persistent memory lives. Both backends keep the same rule:
 * what a run saves is visible to that run only, and becomes permanent only if
 * the run completes, so a failed attempt never teaches the next ticket.
 */
export interface MemoryBackend {
  readonly kind: "local" | "engram";
  /** Rendered results for an agent ("" when nothing matches): permanent memory plus this run's own saves. */
  search(query: string, opts: { limit: number; runId: string }): Promise<string>;
  save(input: PendingMemory): Promise<{ id: string; duplicate: boolean }>;
  /** The run completed: make its memories permanent. Returns how many. */
  commit(runId: string): Promise<number>;
  /** Saves not yet permanent, for the run's checkpoint (so a crash does not lose them). */
  pending(): PendingMemory[];
  close(): Promise<void>;
}

/** The default: a JSONL file per repo with keyword search (see memory.ts). */
export class LocalMemory implements MemoryBackend {
  readonly kind = "local" as const;
  private constructor(private readonly store: MemoryStore) {}

  static async open(file: string): Promise<LocalMemory> {
    return new LocalMemory(await MemoryStore.open(file));
  }

  async search(query: string, opts: { limit: number; runId: string }): Promise<string> {
    const hits = this.store.search(query, { limit: opts.limit, runId: opts.runId });
    return hits.length ? renderMemories(hits) : "";
  }

  async save(input: PendingMemory) {
    const e = await this.store.save(input);
    return { id: e.id, duplicate: e.runId !== input.runId };
  }

  commit(runId: string) {
    return this.store.validateRun(runId);
  }

  /** Provisional entries already live in the JSONL file. */
  pending(): PendingMemory[] {
    return [];
  }

  async close() {}
}

/** Engram's types for our kinds. */
const ENGRAM_TYPE: Record<MemoryKind, string> = { decision: "decision", discovery: "discovery", convention: "pattern", gotcha: "learning" };

/**
 * Engram (github.com/Gentleman-Programming/engram) as the memory backend,
 * through its MCP server (`engram mcp`, stdio), started in the primary repo so
 * Engram resolves the project the same way your other agents do.
 *
 * Searches go to Engram (mem_search) plus this run's own unsaved memories.
 * Saves are buffered (and checkpointed with the run) and written with
 * mem_save only when the run completes. If Engram is unreachable then, they
 * are kept in the local memory file instead of being lost.
 */
export class EngramMemory implements MemoryBackend {
  readonly kind = "engram" as const;
  private buffer: PendingMemory[];
  private client: Client | null = null;

  constructor(
    private readonly settings: FlowConfig["memory"]["engram"],
    private readonly cwd: string,
    private readonly fallbackFile: string,
    restored: PendingMemory[] = [],
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.buffer = [...restored];
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    if (this.settings.project) env.ENGRAM_PROJECT = this.settings.project;
    if (this.settings.dataDir) env.ENGRAM_DATA_DIR = this.settings.dataDir;
    const client = new Client({ name: "hector-flow", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: this.settings.command, args: this.settings.args, cwd: this.cwd, env, stderr: "ignore" }));
    this.client = client;
    return client;
  }

  private async call(name: string, args: Record<string, unknown>): Promise<string> {
    const client = await this.connect();
    const res = (await client.callTool({ name, arguments: args })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
    if (res.isError) throw new Error(`engram ${name}: ${text || "error"}`);
    return text;
  }

  async search(query: string, opts: { limit: number; runId: string }): Promise<string> {
    const parts: string[] = [];
    const mine = this.ownMatches(query, opts.runId, opts.limit);
    if (mine.length) parts.push(`From this run (not yet saved to Engram):\n${mine.map((m) => `- [${m.kind}] ${m.title}: ${m.content}`).join("\n")}`);
    try {
      const found = await this.call("mem_search", { query, limit: Math.min(20, opts.limit), match_mode: "any" });
      if (found && !/^No memories found/i.test(found)) parts.push(found);
    } catch (err) {
      this.log(`engram search failed: ${(err as Error).message}`);
      parts.push("(Engram is unavailable right now; continue without it.)");
    }
    return parts.join("\n\n");
  }

  async save(input: PendingMemory) {
    const dup = this.buffer.find((m) => m.runId === input.runId && m.title === input.title && m.content === input.content);
    if (dup) return { id: `pending-${this.buffer.indexOf(dup) + 1}`, duplicate: true };
    this.buffer.push(input);
    return { id: `pending-${this.buffer.length}`, duplicate: false };
  }

  async commit(runId: string): Promise<number> {
    const mine = this.buffer.filter((m) => m.runId === runId);
    let written = 0;
    const failed: PendingMemory[] = [];
    for (const m of mine) {
      try {
        await this.call("mem_save", {
          title: m.title,
          type: ENGRAM_TYPE[m.kind],
          content: engramContent(m),
          capture_prompt: false,
        });
        written++;
      } catch (err) {
        this.log(`engram save failed for "${m.title}": ${(err as Error).message}`);
        failed.push(m);
      }
    }
    if (failed.length) {
      // Never lose what a completed run learned: keep it locally, validated.
      const local = await MemoryStore.open(this.fallbackFile);
      for (const m of failed) await local.save(m);
      await local.validateRun(runId);
      this.log(`${failed.length} memories kept in ${this.fallbackFile} because Engram did not accept them`);
    }
    this.buffer = this.buffer.filter((m) => m.runId !== runId);
    return written + failed.length;
  }

  pending(): PendingMemory[] {
    return [...this.buffer];
  }

  async close() {
    await this.client?.close().catch(() => undefined);
    this.client = null;
  }

  private ownMatches(query: string, runId: string, limit: number): PendingMemory[] {
    const terms = new Set(tokenize(query));
    return this.buffer
      .filter((m) => m.runId === runId)
      .map((m) => ({ m, score: tokenize(`${m.title} ${m.content} ${m.tags.join(" ")} ${m.files.join(" ")}`).filter((t) => terms.has(t)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.m);
  }

  /** For `check`: starts the server and confirms it offers the tools hector-flow uses. No model call. */
  async probe(): Promise<string[]> {
    const client = await this.connect();
    return (await client.listTools()).tools.map((t) => t.name);
  }
}

/** Engram's recommended layout: What / Why / Where / Learned. */
export function engramContent(m: PendingMemory): string {
  return [
    `**What**: ${m.content}`,
    `**Why**: ${m.kind} recorded by hector-flow's ${m.role} step while implementing ${m.ticketId}`,
    m.files.length ? `**Where**: ${m.files.join(", ")}` : "",
    m.tags.length ? `**Learned**: tags ${m.tags.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function openMemory(
  config: FlowConfig,
  opts: { primaryRoot: string; localFile: string; restored?: PendingMemory[]; log?: (m: string) => void },
): Promise<MemoryBackend> {
  if (config.memory.backend === "engram") {
    return new EngramMemory(config.memory.engram, opts.primaryRoot, opts.localFile, opts.restored, opts.log);
  }
  return LocalMemory.open(opts.localFile);
}

export type { MemoryEntry };
