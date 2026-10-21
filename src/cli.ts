#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { preflight } from "./check.js";
import { cleanTicket } from "./clean.js";
import { loadConfig } from "./config.js";
import { distillTicket } from "./distill.js";
import { ClaudeAgentRunner } from "./runner/claude-runner.js";
import { readTicket } from "./ticket.js";
import { implementTicket } from "./workflow.js";

const USAGE = `hector-flow check   --repo <path> [--ticket <ticket.md>] [--no-commands] [--config <path>]
hector-flow run     --repo <path> --ticket <ticket.md>                    [--config <path>]
hector-flow distill --repo <path> --ticket-id <ID>                        [--config <path>]
hector-flow clean   --repo <path> --ticket-id <ID>                        [--config <path>]

  check    Validates config, repos, each component's commands and the ticket. No model calls.
  run      Implements the ticket: worktrees per task, branches hector/<ID> in every touched repo.
  distill  After you correct the result on those branches, turns your corrections
           into guidelines for the step that caused them.
  clean    Removes the ticket's worktrees and branches (hector/<ID>, hector-tasks/<ID>/*)
           in every component repo. Logs and lessons are kept.

  --repo         Primary repository (where hector-flow.config.json lives)
  --ticket       Markdown ticket with '# ID: title' and '## Acceptance criteria'
  --ticket-id    Ticket id, e.g. AB-123
  --config       Config file (default: <repo>/hector-flow.config.json)
  --no-commands  check: skip running build/test/lint

Exit codes: 0 completed/ok · 3 needs_human · 1 failed · 2 usage error
`;

const COMMANDS = ["check", "run", "distill", "clean"] as const;
type Command = (typeof COMMANDS)[number];

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      ticket: { type: "string" },
      "ticket-id": { type: "string" },
      config: { type: "string" },
      "no-commands": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0] as Command | undefined;
  if (values.help || !values.repo || !command || !COMMANDS.includes(command)) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  // `npm run flow` changes the working directory to the hector-flow folder; npm keeps the
  // folder the user typed the command in as INIT_CWD, so relative paths resolve from there.
  const base = process.env.INIT_CWD ?? process.cwd();
  const at = (p: string) => resolve(base, p);
  const repo = at(values.repo);
  const config = await loadConfig(repo, values.config && at(values.config));

  if (command === "check") {
    const lines = await preflight({
      repo,
      config,
      ticketPath: values.ticket && at(values.ticket),
      runCommands: !values["no-commands"],
      onLine: (l) => {
        console.log(`${l.ok ? (l.warn ? "⚠" : "✔") : "✖"} ${l.label}`);
        if (l.detail && (!l.ok || l.warn)) console.log(l.detail.replace(/^/gm, "    "));
      },
    });
    const failed = lines.filter((l) => !l.ok).length;
    console.log(failed ? `\n${failed} check(s) failed.` : "\nReady to run.");
    return failed ? 1 : 0;
  }

  if (command === "clean") {
    if (!values["ticket-id"]) return (console.log(USAGE), 2);
    const res = await cleanTicket({ repo, ticketId: values["ticket-id"], config });
    for (const w of res.removedWorktrees) console.log(`removed worktree ${w}`);
    for (const b of res.deletedBranches) console.log(`deleted branch   ${b}`);
    if (!res.removedWorktrees.length && !res.deletedBranches.length) console.log(`Nothing to clean for ${values["ticket-id"]}.`);
    return 0;
  }

  const runner = new ClaudeAgentRunner(config);

  if (command === "distill") {
    if (!values["ticket-id"]) return (console.log(USAGE), 2);
    const res = await distillTicket({ repo, ticketId: values["ticket-id"], config, runner });
    if ("reason" in res) {
      console.log(res.reason);
      return 0;
    }
    console.log(`${res.added} new guideline(s):`);
    for (const l of res.lessons) console.log(`- [${l.role}] ${l.guideline}`);
    return 0;
  }

  if (!values.ticket) return (console.log(USAGE), 2);
  const ticket = await readTicket(at(values.ticket));
  console.log(`hector-flow · ${ticket.id}: ${ticket.title}\n`);

  const summary = await implementTicket({ repo, ticket, config, runner });

  console.log(`\n${"─".repeat(60)}`);
  console.log(`status   ${summary.status}`);
  for (const r of summary.repos) console.log(`repo     ${r.name}: ${r.branch} → ${r.worktree}`);
  console.log(`tasks    ${summary.tasks} (max ${summary.maxConcurrentWorkers} in parallel)`);
  console.log(`repairs  ${summary.repairAttempts}   review rounds ${summary.reviewRounds}   questions ${summary.questionsAsked}`);
  console.log(`cost     $${summary.costUsd.toFixed(4)}   time ${(summary.durationMs / 1000).toFixed(0)}s`);
  console.log(`log      ${summary.runDir}`);
  if (summary.reason) console.log(`\n${summary.reason}`);
  if (summary.openAssumptions.length) {
    console.log(`\nAssumptions the workers made without an authoritative answer — check these:`);
    for (const q of summary.openAssumptions) console.log(`- (${q.asker}) ${q.question}\n  → ${q.answer}`);
  }

  return summary.status === "completed" ? 0 : summary.status === "needs_human" ? 3 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
