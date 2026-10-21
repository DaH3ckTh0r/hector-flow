import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Role } from "./config.js";

/** A fix that resolved a failure; written only after build and tests passed. */
export interface ErrorLesson {
  signature: string;
  rootCause: string;
  fix: string;
  ticketId: string;
  validatedAt: string;
}

/**
 * A standing instruction for one step, distilled from what a human had to
 * correct. This is "fix the piece, not the output": the next run of that
 * step gets the guideline in its system prompt.
 */
export interface Guideline {
  role: Role;
  guideline: string;
  evidence: string;
  ticketId: string;
  addedAt: string;
}

interface StoreFile {
  errors: ErrorLesson[];
  guidelines: Guideline[];
}

export class LessonStore {
  private data: StoreFile = { errors: [], guidelines: [] };

  private constructor(private readonly path: string) {}

  static async open(path: string): Promise<LessonStore> {
    const store = new LessonStore(path);
    try {
      const raw = JSON.parse(await readFile(path, "utf8"));
      store.data = Array.isArray(raw) ? { errors: raw, guidelines: [] } : { errors: [], guidelines: [], ...raw };
    } catch {
      // no store yet
    }
    return store;
  }

  /** Error lessons whose signature equals or contains the given code, e.g. "TS2345". */
  findErrors(code: string): ErrorLesson[] {
    const key = normalize(code);
    const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    return this.data.errors.filter((l) => {
      const sig = normalize(l.signature);
      return sig === key || re.test(sig);
    });
  }

  guidelinesFor(role: Role): Guideline[] {
    return this.data.guidelines.filter((g) => g.role === role);
  }

  async recordValidatedError(lesson: Omit<ErrorLesson, "validatedAt">): Promise<void> {
    const key = normalize(lesson.signature);
    this.data.errors = this.data.errors.filter((l) => !(normalize(l.signature) === key && l.fix === lesson.fix));
    this.data.errors.push({ ...lesson, validatedAt: new Date().toISOString() });
    await this.save();
  }

  async addGuidelines(items: Array<Omit<Guideline, "addedAt">>): Promise<number> {
    let added = 0;
    for (const g of items) {
      const dup = this.data.guidelines.some(
        (x) => x.role === g.role && normalize(x.guideline) === normalize(g.guideline),
      );
      if (!dup) {
        this.data.guidelines.push({ ...g, addedAt: new Date().toISOString() });
        added++;
      }
    }
    await this.save();
    return added;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.data, null, 2));
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/:\d+(:\d+)?/g, "").trim();
}
