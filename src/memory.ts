import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Persistent memory shared by every run on a repository: decisions,
 * discoveries, conventions and gotchas that agents found worth remembering.
 * Agents read it with `memory_search` and add to it with `memory_save`
 * (in-process MCP tools); `enrich` also receives the most relevant entries.
 *
 * Entries saved during a run are provisional. They become validated only if
 * that run completes; provisional entries from other runs are never returned,
 * so a failed run cannot teach the next one something wrong.
 *
 * Stored as JSON lines: easy to read, grep, edit and version.
 */

export const MEMORY_KINDS = ["decision", "discovery", "convention", "gotcha"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  kind: MemoryKind;
  tags: string[];
  files: string[];
  ticketId: string;
  runId: string;
  role: string;
  createdAt: string;
  status: "provisional" | "validated";
}

export interface MemoryHit {
  entry: MemoryEntry;
  score: number;
}

const STOPWORDS = new Set(
  "a an and are as at be by for from has have in is it its of on or that the this to was were will with de del el la las los un una y o en para por con que se su al lo como".split(
    " ",
  ),
);

export class MemoryStore {
  private entries: MemoryEntry[] = [];

  private constructor(readonly path: string) {}

  static async open(path: string): Promise<MemoryStore> {
    const store = new MemoryStore(path);
    const raw = await readFile(path, "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        store.entries.push(JSON.parse(line));
      } catch {
        // skip a corrupt line rather than losing the whole store
      }
    }
    return store;
  }

  all(opts: { includeProvisional?: boolean } = {}): MemoryEntry[] {
    return this.entries.filter((e) => opts.includeProvisional || e.status === "validated");
  }

  /**
   * Keyword search (tf-idf over title, content, tags and files; title counts double).
   * Returns validated entries plus the provisional ones of `runId`.
   */
  search(query: string, opts: { limit?: number; runId?: string } = {}): MemoryHit[] {
    const pool = this.entries.filter((e) => e.status === "validated" || (opts.runId && e.runId === opts.runId));
    const terms = [...new Set(tokenize(query))];
    if (!terms.length || !pool.length) return [];
    const docs = pool.map((e) => ({
      entry: e,
      title: tokenize(e.title),
      body: tokenize([e.content, e.tags.join(" "), e.files.join(" "), e.kind].join(" ")),
    }));
    const df = new Map<string, number>();
    for (const t of terms) df.set(t, docs.filter((d) => d.title.includes(t) || d.body.includes(t)).length);
    const hits: MemoryHit[] = [];
    for (const d of docs) {
      let score = 0;
      for (const t of terms) {
        const n = df.get(t)!;
        if (!n) continue;
        const idf = Math.log(1 + pool.length / n);
        const tf = 2 * d.title.filter((x) => x === t).length + d.body.filter((x) => x === t).length;
        score += tf ? (1 + Math.log(tf)) * idf : 0;
      }
      if (score > 0) hits.push({ entry: d.entry, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 5);
  }

  async save(input: Omit<MemoryEntry, "id" | "createdAt" | "status">): Promise<MemoryEntry> {
    const dup = this.entries.find(
      (e) => e.status === "validated" && norm(e.title) === norm(input.title) && norm(e.content) === norm(input.content),
    );
    if (dup) return dup;
    const entry: MemoryEntry = { ...input, id: randomUUID().slice(0, 8), createdAt: new Date().toISOString(), status: "provisional" };
    this.entries.push(entry);
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(entry) + "\n");
    return entry;
  }

  /** Marks a run's provisional entries as validated. Returns how many. */
  async validateRun(runId: string): Promise<number> {
    let n = 0;
    for (const e of this.entries) {
      if (e.runId === runId && e.status === "provisional") {
        e.status = "validated";
        n++;
      }
    }
    if (n) await this.rewrite();
    return n;
  }

  /** Removes entries by id (the `memory forget` command). Returns the ids removed. */
  async forget(ids: string[]): Promise<string[]> {
    const removed = this.entries.filter((e) => ids.includes(e.id)).map((e) => e.id);
    if (removed.length) {
      this.entries = this.entries.filter((e) => !ids.includes(e.id));
      await this.rewrite();
    }
    return removed;
  }

  private async rewrite(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, this.entries.map((e) => JSON.stringify(e)).join("\n") + (this.entries.length ? "\n" : ""));
  }
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").match(/[\p{L}\p{N}_]{2,}/gu) ?? []).filter(
    (t) => !STOPWORDS.has(t),
  );
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Short plain-text rendering of hits, for prompts and tool results. */
export function renderMemories(hits: MemoryHit[], maxChars = 600): string {
  return hits
    .map(({ entry: e }) => {
      const content = e.content.length > maxChars ? e.content.slice(0, maxChars) + "…" : e.content;
      return `- [${e.kind}] ${e.title} (id ${e.id}, ${e.ticketId}${e.files.length ? `, files: ${e.files.join(", ")}` : ""})\n  ${content.replace(/\n/g, "\n  ")}`;
    })
    .join("\n");
}
