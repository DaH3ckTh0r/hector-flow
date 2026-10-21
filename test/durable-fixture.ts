/** Shared fixture of test/durable.ts and its crashing child process: two tasks, T2 after T1. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Script } from "./helpers.js";
import { sh, write } from "./helpers.js";

export const CLAMP = "export const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);\n";
export const LERP = "export const lerp = (a, b, t) => a + (b - a) * t;\n";
const TESTS = `import test from "node:test";
import assert from "node:assert/strict";
import { clamp } from "../src/clamp.js";
import { lerp } from "../src/lerp.js";
test("clamp", () => assert.equal(clamp(50, 0, 10), 10));
test("lerp", () => assert.equal(lerp(0, 10, 0.5), 5));
`;

export function makeDurableRepo(extra: Record<string, unknown> = {}) {
  const parent = mkdtempSync(join(tmpdir(), "hector-durable-"));
  const repo = join(parent, "mathlib");
  mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "d@example.com");
  sh(repo, "config", "user.name", "durable");
  write(repo, "package.json", JSON.stringify({ name: "mathlib", type: "module" }));
  write(repo, "src/index.js", "export {};\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "init");
  const tickets = join(parent, "tickets");
  mkdirSync(tickets);
  const ticket = join(tickets, "DUR-1.md");
  writeFileSync(ticket, "# DUR-1: Add clamp and lerp\n\nTwo helpers.\n\n## Acceptance criteria\n- clamp limits a number\n- lerp interpolates\n");
  const config = {
    testCommand: "node --test",
    lockedPaths: ["test/**"],
    allowedCommands: ["node --test"],
    workspacesDir: "ws",
    policy: { reviewRounds: 1, repairAttempts: 2, agentRetryDelaySeconds: 0 },
    backlog: { type: "folder", path: "../tickets" },
    ...extra,
  };
  const configPath = join(parent, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  return { parent, repo, ticket, config, configPath };
}

const task = (id: string, dependsOn: string[], file: string) => ({
  id,
  component: "main",
  dependsOn,
  description: `task ${id}`,
  files: [file],
  acceptanceCriteria: ["see ticket"],
});

/** Responses up to the implementation; coder/review/qaPlan are added per scenario. */
export function durableScript(): Script {
  return {
    enrich: [() => ({ summary: "math", stack: ["node"], relevantFiles: [], conventions: [], openQuestions: [] })],
    plan: [() => ({ summary: "two helpers", tasks: [task("T1", [], "src/clamp.js"), task("T2", ["T1"], "src/lerp.js")], risks: [] })],
    testAuthor: [
      (cwd) => (
        write(cwd, "test/math.test.js", TESTS),
        {
          testFiles: ["test/math.test.js"],
          acceptanceMap: [
            { criterion: "clamp limits a number", command: "node --test --test-name-pattern=clamp" },
            { criterion: "lerp interpolates", command: "node --test --test-name-pattern=lerp" },
          ],
        }
      ),
    ],
  };
}

export const approve = () => ({ approved: true, issues: [] });
export const qaPlan = () => ({ markdown: "# Plan\n1. clamp(50, 0, 10) → 10\n" });
