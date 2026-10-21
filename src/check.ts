import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { loadSkills } from "./skills.js";
import { resolveComponents } from "./components.js";
import { RoleSchema, type FlowConfig } from "./config.js";
import { resolveRuntime, runtimesInUse } from "./runtimes.js";
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

  try {
    const set = await loadSkills(primaryRoot, opts.config);
    const custom = Object.values(set.skills).filter((s) => s.sourceKind !== "builtin");
    add({
      ok: true,
      label: custom.length
        ? `step skills: ${custom.map((s) => `${s.role} (${s.sourceKind})`).join(", ")} customized; the rest built-in`
        : "step skills: all built-in",
    });
    for (const s of Object.values(set.skills)) {
      for (const w of s.warnings) add({ ok: true, warn: true, label: `skill ${s.role}: ${w}`, detail: s.source });
    }
  } catch (err) {
    add({ ok: false, label: "step skills", detail: (err as Error).message });
  }
  for (const dir of opts.config.pluginDirs) {
    const abs = resolve(primaryRoot, dir);
    add({ ok: existsSync(abs), label: `plugin folder ${abs} exists` });
  }
  const judges = opts.config.review.judges;
  if (judges.length > 1) {
    add({ ok: true, label: `review by ${judges.length} independent judges: ${judges.map((j) => j.name).join(", ")}` });
  }

  for (const line of await checkRuntimes(opts.config)) add(line);

  const b = opts.config.backlog;
  if (b) {
    if (b.type === "folder") {
      const dir = isAbsolute(b.path) ? b.path : resolve(primaryRoot, b.path);
      add({ ok: existsSync(dir), label: `backlog folder ${dir} exists` });
      const inside = [...new Set(components.map((c) => c.repoRoot))].find((r) => !relative(r, dir).startsWith(".."));
      if (inside) {
        add({
          ok: true,
          warn: true,
          label: "backlog folder is inside a component repo",
          detail: `New ticket files there leave ${inside} with uncommitted changes, and runs require clean repos. Commit tickets as you add them, or move the folder outside the repo (e.g. "../tickets").`,
        });
      }
    } else {
      add({
        ok: !!process.env[b.tokenEnv],
        label: `backlog ${b.type}: token variable ${b.tokenEnv} is set`,
        detail: process.env[b.tokenEnv] ? undefined : `Export ${b.tokenEnv} before running 'start'.`,
      });
    }
  }
  for (const [role, names] of Object.entries(opts.config.mcpAccess)) {
    const unknown = (names ?? []).filter((n) => !(n in opts.config.mcpServers));
    if (unknown.length) add({ ok: false, label: `mcpAccess.${role} names unknown MCP servers: ${unknown.join(", ")}` });
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

/** Which runtimes the config routes to, and whether each one can start here. */
export async function checkRuntimes(
  config: FlowConfig,
  which: (bin: string) => Promise<boolean> = onPath,
): Promise<CheckLine[]> {
  const lines: CheckLine[] = [];
  const used = runtimesInUse(config);
  if (used.size === 1 && used.has("claude")) return lines;
  const routes = RoleSchema.options.map(
    (role) => `${role}=${resolveRuntime(config, role, {}).runtime}`,
  );
  lines.push({ ok: true, label: `runtimes: ${routes.join(" ")}` });
  if (used.has("codex")) {
    const bin = config.runtime.codex.path;
    lines.push({
      ok: bin ? existsSync(bin) : true,
      label: bin ? `codex binary ${bin} exists` : "codex: using the CLI bundled with @openai/codex-sdk",
    });
    lines.push({
      ok: true,
      warn: true,
      label: "codex steps: the read deny-list and the command allowlist are not enforced",
      detail: "Codex has no per-call permission hook. Its OS sandbox limits writes to the component folder and blocks the network; locked tests and stray files are still reverted by the workflow. Keep secrets out of the worktree.",
    });
    const sse = Object.entries(config.mcpServers).filter(([, s]) => "type" in s && s.type === "sse").map(([n]) => n);
    if (sse.length) lines.push({ ok: true, warn: true, label: `codex cannot use SSE MCP servers: ${sse.join(", ")}` });
  }
  if (used.has("opencode")) {
    const found = await which("opencode");
    lines.push({
      ok: found,
      label: "opencode is installed (on PATH)",
      detail: found ? undefined : "Install it (npm i -g opencode-ai) or route those steps to another runtime.",
    });
    if (!config.runtime.opencode.model) lines.push({ ok: true, warn: true, label: "runtime.opencode.model is not set: OpenCode will use its own default model" });
  }
  return lines;
}

async function onPath(bin: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const names = process.platform === "win32" ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin];
  return dirs.some((d) => d && names.some((n) => existsSync(resolve(d, n))));
}
