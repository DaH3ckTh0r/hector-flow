import { resolve } from "node:path";
import { resolveComponents } from "./components.js";
import type { FlowConfig } from "./config.js";
import { isCommandAllowed } from "./guards.js";
import { readTicket } from "./ticket.js";
import { git } from "./tools/git.js";
import { runShell } from "./tools/shell.js";

export interface CheckLine {
  ok: boolean;
  /** Warnings do not make the check fail. */
  warn?: boolean;
  label: string;
  detail?: string;
}

/**
 * Pre-flight check, no model calls: config resolves, every repo is a clean git
 * checkout, each component's commands run on the current code, the test command
 * is usable by agents, and (optionally) the ticket parses.
 */
export async function preflight(opts: {
  repo: string;
  config: FlowConfig;
  ticketPath?: string;
  runCommands?: boolean;
  onLine?: (line: CheckLine) => void;
}): Promise<CheckLine[]> {
  const lines: CheckLine[] = [];
  const add = (l: CheckLine) => {
    lines.push(l);
    opts.onLine?.(l);
  };

  let primaryRoot: string;
  try {
    primaryRoot = await git(resolve(opts.repo), "rev-parse", "--show-toplevel");
    add({ ok: true, label: `primary repo ${primaryRoot}` });
  } catch {
    add({ ok: false, label: `${opts.repo} is not inside a git repository` });
    return lines;
  }

  let components;
  try {
    components = await resolveComponents(primaryRoot, opts.config);
    add({ ok: true, label: `${components.length} component(s): ${components.map((c) => c.name).join(", ")}` });
  } catch (err) {
    add({ ok: false, label: "components", detail: (err as Error).message });
    return lines;
  }

  for (const root of new Set(components.map((c) => c.repoRoot))) {
    const dirty = await git(root, "status", "--porcelain");
    add({
      ok: !dirty,
      label: `repo ${root} is clean`,
      detail: dirty ? `uncommitted changes:\n${dirty}` : undefined,
    });
    const existing = await git(root, "branch", "--list", "hector/*", "hector-tasks/*");
    if (existing) {
      add({
        ok: true,
        warn: true,
        label: `repo ${root} has hector branches from earlier runs`,
        detail: `${existing}\nA ticket whose branch already exists cannot run again until you run 'hector-flow clean'.`,
      });
    }
  }

  for (const c of components) {
    const dir = c.path === "." ? c.repoRoot : resolve(c.repoRoot, c.path);
    const testAllowed = isCommandAllowed(c.testCommand, c.allowedCommands).ok;
    add({
      ok: true,
      warn: !testAllowed,
      label: `${c.name}: agents can run its test command`,
      detail: testAllowed
        ? undefined
        : `"${c.testCommand}" is not in allowedCommands (${c.allowedCommands.join(", ") || "empty"}). Workers will not be able to run tests, and acceptance commands will be rejected.`,
    });
    if (opts.runCommands === false) continue;
    for (const [kind, cmd] of [
      ["build", c.buildCommand],
      ["test", c.testCommand],
      ["lint", c.lintCommand],
    ] as const) {
      if (!cmd) continue;
      const r = await runShell(cmd, dir, { timeoutMs: 15 * 60_000, maxChars: 3000 });
      add({
        ok: r.ok,
        label: `${c.name}: ${kind} "${cmd}" passes on the current code (${(r.durationMs / 1000).toFixed(1)}s)`,
        detail: r.ok ? undefined : r.output,
      });
    }
  }

  if (opts.ticketPath) {
    try {
      const t = await readTicket(resolve(opts.ticketPath));
      add({ ok: true, label: `ticket ${t.id}: "${t.title}" with ${t.acceptanceCriteria.length} acceptance criteria` });
    } catch (err) {
      add({ ok: false, label: "ticket", detail: (err as Error).message });
    }
  }
  return lines;
}
