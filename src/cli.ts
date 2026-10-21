#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { listCopilotModels, preflight } from "./check.js";
import { cleanTicket } from "./clean.js";
import { loadConfig, RoleSchema, type Role } from "./config.js";
import { ejectSkills, loadSkills, resolveStep } from "./skills.js";
import { git } from "./tools/git.js";
import { distillTicket } from "./distill.js";
import { createRunner } from "./runtimes.js";
import { readTicket } from "./ticket.js";
import { approveTicket, loopStatus, rejectTicket, requeueTicket, runLoop, type LoopMode } from "./loop.js";
import { MemoryStore, renderMemories } from "./memory.js";
import { flowPaths, implementTicket } from "./workflow.js";

const USAGE = `hector-flow check   --repo <path> [--ticket <ticket.md>] [--no-commands] [--config <path>]
hector-flow run     --repo <path> --ticket <ticket.md>                    [--config <path>]
hector-flow distill --repo <path> --ticket-id <ID>                        [--config <path>]
hector-flow clean   --repo <path> --ticket-id <ID>                        [--config <path>]
hector-flow skills  --repo <path> [list | eject <role…|all>]              [--config <path>]
hector-flow start   --repo <path> [--mode manual|supervised|auto] [--once] [--max <n>]
hector-flow status  --repo <path>
hector-flow approve --repo <path> <ID>
hector-flow reject  --repo <path> <ID> [--reason <text>]
hector-flow requeue --repo <path> <ID>
hector-flow memory  --repo <path> [list [--all] | search <words…> | forget <id…>]
hector-flow models  --repo <path> copilot                                  [--config <path>]

  check    Validates config, repos, each component's commands and the ticket. No model calls.
  run      Implements the ticket: worktrees per task, branches hector/<ID> in every touched repo.
  distill  After you correct the result on those branches, turns your corrections
           into guidelines for the step that caused them.
  clean    Removes the ticket's worktrees and branches (hector/<ID>, hector-tasks/<ID>/*)
           in every component repo. Logs and lessons are kept.
  skills   Lists each step's skill (where it comes from, model, effort, Claude skills),
           or copies built-in skills into <repo>/.hector/skills to customize them.
  start    Continuous loop: takes tickets from the configured backlog one by one.
           manual leaves branches, supervised waits for approve/reject, auto merges.
  status   Lists the loop's tickets and their state.
  approve  Merges a ticket's branches into each repo's base branch (verified, rolled back on failure).
  reject   Discards a ticket's branches and marks it rejected.
  requeue  Cleans a ticket and forgets its state so the loop runs it again.
  memory   Lists, searches or removes entries of the repo's persistent memory.
  models   Lists the model ids a runtime accepts (currently: copilot). No model calls.

  --repo         Primary repository (where hector-flow.config.json lives)
  --ticket       Markdown ticket with '# ID: title' and '## Acceptance criteria'
  --ticket-id    Ticket id, e.g. AB-123
  --config       Config file (default: <repo>/hector-flow.config.json)
  --no-commands  check: skip running build/test/lint
  --mode         start: overrides loop.mode
  --once         start: process what is ready now, then exit
  --max          start: stop after this many tickets
  --reason       reject: why (reported back to the backlog)
  --all          memory list: include provisional entries

Exit codes: 0 completed/ok · 3 needs_human · 1 failed · 2 usage error
`;

const COMMANDS = ["check", "run", "distill", "clean", "skills", "start", "status", "approve", "reject", "requeue", "memory", "models"] as const;
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
      mode: { type: "string" },
      once: { type: "boolean" },
      max: { type: "string" },
      reason: { type: "string" },
      all: { type: "boolean" },
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

  const ticketArg = values["ticket-id"] ?? positionals[1];

  if (command === "status") {
    const rows = await loopStatus({ repo, config });
    if (!rows.length) return (console.log("The loop has not processed any ticket yet."), 0);
    for (const r of rows) {
      console.log(`${r.id.padEnd(14)} ${r.status.padEnd(16)} ${r.updatedAt.slice(0, 16).replace("T", " ")}  ${r.title}`);
      if (r.reason) console.log(`${" ".repeat(15)}${r.reason.split("\n")[0]}`);
    }
    return 0;
  }

  if (command === "approve" || command === "reject" || command === "requeue") {
    if (!ticketArg) return (console.log(`Usage: hector-flow ${command} --repo <path> <ID>`), 2);
    if (command === "approve") {
      const s = await approveTicket({ repo, config, ticketId: ticketArg, log: (l) => console.log(l) });
      console.log(`${s.id} → ${s.status}${s.reason ? `\n${s.reason}` : ""}`);
      return s.status === "merged" ? 0 : 1;
    }
    if (command === "reject") {
      const s = await rejectTicket({ repo, config, ticketId: ticketArg, reason: values.reason });
      console.log(`${s.id} → rejected; its branches were removed.`);
      return 0;
    }
    const existed = await requeueTicket({ repo, config, ticketId: ticketArg });
    console.log(existed ? `${ticketArg} requeued: the loop will run it again.` : `${ticketArg} had no state; branches cleaned if any.`);
    return 0;
  }

  if (command === "models") {
    const which = positionals[1] ?? "copilot";
    if (which !== "copilot") return (console.log("Usage: hector-flow models --repo <path> copilot"), 2);
    const models = await listCopilotModels(config);
    const width = Math.max(4, ...models.map((m) => m.id.length));
    console.log(`${"id".padEnd(width)}  premium×  efforts            name`);
    for (const m of models) {
      console.log(
        `${m.id.padEnd(width)}  ${(m.multiplier === undefined ? "-" : String(m.multiplier)).padEnd(8)}  ${(m.efforts.join(",") || "-").padEnd(17)}  ${m.name}${m.enabled ? "" : "  (disabled by policy)"}`,
      );
    }
    console.log(`\nUse an id in runtime.copilot.model, runtime.steps.<role>.model or a judge's model.`);
    return 0;
  }

  if (command === "memory") {
    const primaryRoot = await git(repo, "rev-parse", "--show-toplevel");
    const store = await MemoryStore.open(flowPaths(primaryRoot, config).memory);
    const sub = positionals[1] ?? "list";
    if (sub === "search") {
      const q = positionals.slice(2).join(" ");
      if (!q) return (console.log("Usage: hector-flow memory --repo <path> search <words…>"), 2);
      const hits = store.search(q, { limit: 10 });
      console.log(hits.length ? renderMemories(hits) : "No memories match.");
      return 0;
    }
    if (sub === "forget") {
      const ids = positionals.slice(2);
      if (!ids.length) return (console.log("Usage: hector-flow memory --repo <path> forget <id…>"), 2);
      const removed = await store.forget(ids);
      console.log(removed.length ? `Removed: ${removed.join(", ")}` : "No memory with those ids.");
      return 0;
    }
    if (sub !== "list") return (console.log(USAGE), 2);
    const all = store.all({ includeProvisional: values.all });
    if (!all.length) return (console.log(`No memories yet (${store.path}).`), 0);
    for (const e of all) {
      console.log(`${e.id}  ${e.status === "validated" ? "        " : "(prov.) "}[${e.kind}] ${e.title}  — ${e.ticketId}, ${e.role}`);
    }
    console.log(`\n${all.length} entr${all.length === 1 ? "y" : "ies"} · ${store.path}`);
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

  // One router for every runtime; close() stops servers it started (OpenCode, tool bridge).
  const runner = createRunner(config);
  try {

    if (command === "start") {
      const mode = values.mode as LoopMode | undefined;
      if (mode && !["manual", "supervised", "auto"].includes(mode)) return (console.log("--mode must be manual, supervised or auto"), 2);
      const max = values.max ? Number(values.max) : undefined;
      if (max !== undefined && !(max > 0)) return (console.log("--max must be a positive number"), 2);
      const stop = new AbortController();
      let interrupts = 0;
      process.on("SIGINT", () => {
        if (++interrupts > 1) process.exit(130);
        console.log("\nStopping after the current ticket (Ctrl+C again to quit now)…");
        stop.abort();
      });
      const res = await runLoop({ repo, config, runner, mode, once: values.once, maxTickets: max, signal: stop.signal });
      console.log(`\nLoop finished: ${res.processed.length} ticket(s) processed.`);
      for (const t of res.processed) console.log(`  ${t.id.padEnd(14)} ${t.status}`);
      return 0;
    }

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
  } finally {
    await runner.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
