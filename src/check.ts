import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { loadSkills } from "./skills.js";
import { resolveComponents } from "./components.js";
import { RoleSchema, type FlowConfig } from "./config.js";
import { resolveRuntime, runtimesInUse } from "./runtimes.js";
import { isCommandAllowed } from "./guards.js";
import { readTicket } from "./ticket.js";
import { git } from "./tools/git.js";
import { commandEnv } from "./tools/env.js";
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
      const r = await runShell(cmd, dir, { timeoutMs: 15 * 60_000, maxChars: 3000, baseEnv: commandEnv(opts.config).env });
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

  for (const line of checkSandbox(opts.config)) add(line);
  if (opts.config.memory.enabled && opts.config.memory.backend === "engram") add(await checkEngram(opts.config, primaryRoot));
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
  copilotAuth: (config: FlowConfig) => Promise<{ ok: boolean; message: string }> = copilotSignedIn,
  piProbe: (config: FlowConfig, models: string[]) => Promise<PiProbe> = probePi,
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
  if (used.has("copilot")) {
    const env = config.runtime.copilot.tokenEnv;
    lines.push(
      env
        ? { ok: !!process.env[env], label: `copilot: token variable ${env} is set`, detail: process.env[env] ? undefined : `Export ${env}, or remove tokenEnv to use your \`copilot login\` session.` }
        : { ok: true, label: "copilot: using COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, your `copilot login` session or `gh auth token`" },
    );
    const auth = await copilotAuth(config);
    lines.push({ ok: auth.ok, label: "copilot is signed in", detail: auth.ok ? undefined : auth.message });
    if (config.runtime.copilot.path) {
      lines.push({ ok: existsSync(config.runtime.copilot.path), label: `copilot CLI ${config.runtime.copilot.path} exists` });
    }
  }
  if (used.has("pi")) {
    // Every pi model the config names: runtime.pi.model, step objects and judges on pi.
    const named = new Set<string>();
    if (config.runtime.pi.model) named.add(config.runtime.pi.model);
    for (const entry of Object.values(config.runtime.steps)) if (typeof entry === "object" && entry.use === "pi" && entry.model) named.add(entry.model);
    for (const j of config.review.judges) if (j.runtime === "pi" && j.model) named.add(j.model);
    if (!named.size) lines.push({ ok: true, warn: true, label: "runtime.pi.model is not set: pi will use the first model it has credentials for" });
    const probe = await piProbe(config, [...named]);
    if (probe.error) lines.push({ ok: false, label: "pi model runtime", detail: probe.error });
    for (const m of probe.models) {
      lines.push(
        !m.known
          ? { ok: false, label: `pi knows the model ${m.id}`, detail: "Use \"provider/model\". `hector-flow models --repo <repo> pi` lists them." }
          : { ok: m.auth, label: `pi has credentials for ${m.id}`, detail: m.auth ? undefined : `Run \`pi /login\` or export the provider's API key variable (e.g. ANTHROPIC_API_KEY).` },
      );
    }
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

export interface PiProbe {
  error?: string;
  models: Array<{ id: string; known: boolean; auth: boolean }>;
}

/** Loads pi's model runtime (no network, no model call) and checks each model and its provider's credentials. */
async function probePi(config: FlowConfig, models: string[]): Promise<PiProbe> {
  try {
    const rt = await piModelRuntime(config);
    return {
      models: models.map((id) => {
        const slash = id.indexOf("/");
        const provider = id.slice(0, slash);
        const known = slash > 0 && !!rt.getModel(provider, id.slice(slash + 1));
        return { id, known, auth: known && rt.hasConfiguredAuth(provider) };
      }),
    };
  } catch (err) {
    return { error: (err as Error).message, models: [] };
  }
}

async function piModelRuntime(config: FlowConfig) {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const dir = config.runtime.pi.agentDir;
  return ModelRuntime.create(dir ? { authPath: `${dir}/auth.json`, modelsPath: `${dir}/models.json` } : {});
}

/** pi models usable right now (credentials configured), as "provider/model". */
export async function listPiModels(config: FlowConfig): Promise<Array<{ id: string; name: string; reasoning: boolean }>> {
  const rt = await piModelRuntime(config);
  return (await rt.getAvailable()).map((m) => ({ id: `${m.provider}/${m.id}`, name: m.name ?? m.id, reasoning: !!m.reasoning }));
}

/** Copilot model ids this account can use (no model call), for runtime.copilot.model and judges. */
export async function listCopilotModels(
  config: FlowConfig,
): Promise<Array<{ id: string; name: string; enabled: boolean; efforts: string[]; multiplier?: number }>> {
  const s = config.runtime.copilot;
  const token = s.tokenEnv ? process.env[s.tokenEnv] : undefined;
  const { CopilotClient } = await import("@github/copilot-sdk");
  const client = new CopilotClient({
    logLevel: "none",
    ...(token ? { gitHubToken: token } : {}),
    ...(s.path ? { env: { ...process.env, COPILOT_CLI_PATH: s.path } } : {}),
  });
  try {
    await client.start();
    const auth = await client.getAuthStatus();
    if (!auth.isAuthenticated) throw new Error(`Copilot is not signed in (${auth.statusMessage ?? "no status"}). Run \`copilot login\`.`);
    return (await client.listModels()).map((m) => ({
      id: m.id,
      name: m.name,
      enabled: m.policy?.state !== "disabled",
      efforts: m.supportedReasoningEfforts ?? [],
      multiplier: m.billing?.multiplier,
    }));
  } finally {
    await client.stop();
  }
}

/** Starts the Copilot runtime briefly (no model call) and asks whether it is signed in. */
async function copilotSignedIn(config: FlowConfig): Promise<{ ok: boolean; message: string }> {
  const s = config.runtime.copilot;
  const token = s.tokenEnv ? process.env[s.tokenEnv] : undefined;
  try {
    const { CopilotClient } = await import("@github/copilot-sdk");
    const client = new CopilotClient({
      logLevel: "none",
      ...(token ? { gitHubToken: token } : {}),
      ...(s.path ? { env: { ...process.env, COPILOT_CLI_PATH: s.path } } : {}),
    });
    try {
      await client.start();
      const status = await client.getAuthStatus();
      return { ok: status.isAuthenticated, message: `${status.statusMessage ?? "Not authenticated"}. Run \`copilot login\` or set runtime.copilot.tokenEnv.` };
    } finally {
      await client.stop();
    }
  } catch (err) {
    return { ok: false, message: `Could not start the Copilot runtime: ${(err as Error).message}` };
  }
}

async function onPath(bin: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const names = process.platform === "win32" ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin];
  return dirs.some((d) => d && names.some((n) => existsSync(resolve(d, n))));
}

/** Starts `engram mcp` from the primary repo and confirms it offers mem_search and mem_save. No model call. */
export async function checkEngram(config: FlowConfig, primaryRoot: string): Promise<CheckLine> {
  const { EngramMemory } = await import("./memory-backend.js");
  const engram = new EngramMemory(config.memory.engram, primaryRoot, "/dev/null");
  try {
    const tools = await Promise.race([
      engram.probe(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer in 15s")), 15_000)),
    ]);
    const missing = ["mem_search", "mem_save"].filter((t) => !tools.includes(t));
    return missing.length
      ? { ok: false, label: "engram memory backend", detail: `\`${config.memory.engram.command} ${config.memory.engram.args.join(" ")}\` does not offer ${missing.join(", ")}. Keep the agent tools profile (--tools=agent).` }
      : { ok: true, label: `memory: Engram (${config.memory.engram.command} ${config.memory.engram.args.join(" ")})${config.memory.engram.project ? `, project ${config.memory.engram.project}` : ""}` };
  } catch (err) {
    return {
      ok: false,
      label: "engram memory backend",
      detail: `Could not start \`${config.memory.engram.command} ${config.memory.engram.args.join(" ")}\`: ${(err as Error).message}. Install Engram (github.com/Gentleman-Programming/engram) or set memory.backend to "local".`,
    };
  } finally {
    await engram.close();
  }
}

/** Whether this run is isolated, and what the flow keeps out of the commands it runs. */
export function checkSandbox(config: FlowConfig, env: NodeJS.ProcessEnv = process.env): CheckLine[] {
  const lines: CheckLine[] = [];
  const { removed } = commandEnv(config, env);
  lines.push(
    config.commandEnv.scrubSecrets
      ? {
          ok: true,
          label: removed.length
            ? `build/test commands run without ${removed.length} credential variable(s): ${removed.join(", ")}`
            : "build/test commands: no credential variables to remove",
        }
      : { ok: true, warn: true, label: "commandEnv.scrubSecrets is off: build/test commands see every variable of this shell" },
  );
  if (env.HECTOR_SANDBOX) {
    const proxy = env.HTTPS_PROXY ?? env.https_proxy;
    lines.push({
      ok: !!proxy,
      label: proxy ? `running in the hector-flow sandbox; outbound traffic through ${proxy}` : "running in the hector-flow sandbox",
      detail: proxy ? undefined : "HTTPS_PROXY is not set: the agents cannot reach the model APIs. Start it with sandbox/hector-sandbox.sh.",
    });
    return lines;
  }
  const reasons = [
    config.loop.mode === "auto" ? "loop.mode is auto" : "",
    runtimesInUse(config).has("codex") ? "steps run on Codex" : "",
    config.backlog?.type === "github" || config.backlog?.type === "azure-devops" ? `tickets come from ${config.backlog.type}` : "",
  ].filter(Boolean);
  if (reasons.length) {
    lines.push({
      ok: true,
      warn: true,
      label: `not running in a sandbox (${reasons.join(", ")})`,
      detail: "Agent-written code runs with your files and network. See docs/17-sandbox.md: sandbox/hector-sandbox.sh runs the same commands in a container.",
    });
  }
  return lines;
}
