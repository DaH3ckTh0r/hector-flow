#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { preflight } from "./check.js";
import { cleanTicket } from "./clean.js";
import { loadConfig, RoleSchema, type Role } from "./config.js";
import { ejectSkills, loadSkills, resolveStep } from "./skills.js";
import { git } from "./tools/git.js";
import { distillTicket } from "./distill.js";
import { ClaudeAgentRunner } from "./runner/claude-runner.js";
import { readTicket } from "./ticket.js";
import { implementTicket } from "./workflow.js";

const USAGE = `hector-flow check   --repo <path> [--ticket <ticket.md>] [--no-commands] [--config <path>]
hector-flow run     --repo <path> --ticket <ticket.md>                    [--config <path>]
hector-flow distill --repo <path> --ticket-id <ID>                        [--config <path>]
hector-flow clean   --repo <path> --ticket-id <ID>                        [--config <path>]
hector-flow skills  --repo <path> [list | eject <role…|all>]              [--config <path>]

  check    Validates config, repos, each component's commands and the ticket. No model calls.
  run      Implements the ticket: worktrees per task, branches hector/<ID> in every touched repo.
  distill  After you correct the result on those branches, turns your corrections
           into guidelines for the step that caused them.
  clean    Removes the ticket's worktrees and branches (hector/<ID>, hector-tasks/<ID>/*)
           in every component repo. Logs and lessons are kept.
  skills   Lists each step's skill (where it comes from, model, effort, Claude skills),
           or copies built-in skills into <repo>/.hector/skills to customize them.

  --repo         Primary repository (where hector-flow.config.json lives)
  --ticket       Markdown ticket with '# ID: title' and '## Acceptance criteria'
  --ticket-id    Ticket id, e.g. AB-123
  --config       Config file (default: <repo>/hector-flow.config.json)
  --no-commands  check: skip running build/test/lint

Exit codes: 0 completed/ok · 3 needs_human · 1 failed · 2 usage error
`;

const COMMANDS = ["check", "run", "distill", "clean", "skills"] as const;
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

  if (command === "skills") {
    const sub = positionals[1] ?? "list";
    const primaryRoot = await git(repo, "rev-parse", "--show-toplevel");
    if (sub === "eject") {
      const asked = positionals.slice(2);
      if (!asked.length) return (console.log("Usage: hector-flow skills --repo <path> eject <role…|all>"), 2);
      const valid = RoleSchema.options as readonly string[];
      const unknown = asked.filter((r) => r !== "all" && r !== "_shared" && !valid.includes(r));
      if (unknown.length) return (console.log(`Unknown step(s): ${unknown.join(", ")}. Steps: ${valid.join(", ")}, _shared`), 2);
      const roles = asked.includes("all") ? ([...valid, "_shared"] as Array<Role | "_shared">) : (asked as Array<Role | "_shared">);
      for (const r of await ejectSkills(primaryRoot, roles)) {
        console.log(`${r.created ? "created " : "exists  "} ${r.path}`);
      }
      console.log("\nEdit these files and commit them: they override the built-in skills for this repo.");
      return 0;
    }
    if (sub !== "list") return (console.log(USAGE), 2);
    const set = await loadSkills(primaryRoot, config);
    for (const role of RoleSchema.options) {
      const s = set.skills[role];
      const step = resolveStep(set, role, config);
      const extras = [
        step.model ? `model ${step.model}${config.models[role] ? " (config)" : " (skill)"}` : "",
        step.effort ? `effort ${step.effort}${config.efforts[role] ? " (config)" : " (skill)"}` : "",
        step.claudeSkills.length ? `skills ${step.claudeSkills.join(", ")}` : "",
      ].filter(Boolean);
      console.log(`${role.padEnd(11)} ${s.sourceKind.padEnd(8)} ${s.source}${extras.length ? `\n${" ".repeat(21)}${extras.join(" · ")}` : ""}`);
      for (const w of s.warnings) console.log(`${" ".repeat(21)}⚠ ${w}`);
    }
    console.log(`${"_shared".padEnd(11)} ${set.rules ? "RULES.md " + set.rules.source : "(none)"}`);
    return 0;
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
