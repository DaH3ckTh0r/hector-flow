import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import type { Role } from "../src/config.js";
import type { AgentRequest, AgentResult, AgentRunner } from "../src/runner/agent-runner.js";

export type Req = AgentRequest<z.ZodType>;
export type Step = (cwd: string, req: Req) => unknown | Promise<unknown>;
export type Script = Record<string, Step[]>;

export interface Call {
  key: string;
  role: Role;
  resume?: string;
  hasAsk: boolean;
  sessionId: string;
  cwd: string;
  readDirs: string[];
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake AgentRunner: returns scripted outputs instead of calling a model.
 * `keyOf` picks which queue answers a request, so parallel workers get
 * deterministic answers; `delayOf` simulates work to exercise concurrency.
 */
export class ScriptedRunner implements AgentRunner {
  calls: Call[] = [];
  systemPrompts: Partial<Record<Role, string>> = {};
  active = 0;
  maxActive = 0;
  private n = 0;
  constructor(
    private readonly script: Script,
    private readonly keyOf: (req: Req) => string = (r) => r.role,
    private readonly delayOf: (key: string) => number = () => 0,
  ) {}
  get roles() {
    return this.calls.map((c) => c.role);
  }
  keys(prefix: string) {
    return this.calls.filter((c) => c.key.startsWith(prefix));
  }
  async run<S extends z.ZodType>(req: AgentRequest<S>): Promise<AgentResult<z.infer<S>>> {
    const r = req as unknown as Req;
    const key = this.keyOf(r);
    const sessionId = req.resumeSessionId ?? `${req.role}-${++this.n}`;
    this.calls.push({ key, role: req.role, resume: req.resumeSessionId, hasAsk: !!req.ask, sessionId, cwd: req.cwd, readDirs: req.readDirs ?? [] });
    this.systemPrompts[req.role] = req.systemPrompt;
    const next = this.script[key]?.shift();
    if (!next) throw new Error(`No scripted response left for ${key}`);
    const isWorker = req.role === "coder";
    if (isWorker) this.maxActive = Math.max(this.maxActive, ++this.active);
    try {
      await sleep(this.delayOf(key));
      return { output: req.schema.parse(await next(req.cwd, r)), sessionId, costUsd: 0.01, turns: 1, durationMs: 1, denials: [] };
    } finally {
      if (isWorker) this.active--;
    }
  }
}

/** coder:T1 for an implementation, coder:resolve for conflicts, coder:fix for any other edit. */
export const byTask = (r: Req) => {
  if (r.role !== "coder") return r.role;
  const id = r.prompt.match(/<current_task id="([^"]+)"/)?.[1];
  if (id) return `coder:${id}`;
  if (r.prompt.includes("conflict markers")) return "coder:resolve";
  return "coder:fix";
};

export const write = (cwd: string, file: string, body: string) => {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), body);
};

export const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
