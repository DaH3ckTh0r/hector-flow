import { spawn } from "node:child_process";

export interface ShellResult {
  ok: boolean;
  code: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Runs a command through the shell with a timeout. Output is combined
 * stdout+stderr, trimmed to the last `maxChars` so failures stay readable
 * when passed to the diagnose agent.
 */
export function runShell(
  command: string,
  cwd: string,
  opts: {
    timeoutMs?: number;
    maxChars?: number;
    /** Added on top of baseEnv. */
    env?: NodeJS.ProcessEnv;
    /** The environment to start from (default: this process's). */
    baseEnv?: NodeJS.ProcessEnv;
  } = {},
): Promise<ShellResult> {
  const { timeoutMs = 10 * 60_000, maxChars = 12_000 } = opts;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: { ...(opts.baseEnv ?? process.env), CI: "1", ...opts.env } });
    let out = "";
    let timedOut = false;
    const append = (d: Buffer) => {
      out += d.toString();
      if (out.length > maxChars * 2) out = out.slice(-maxChars);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = out.length > maxChars ? "…(truncated)…\n" + out.slice(-maxChars) : out;
      resolve({ ok: code === 0 && !timedOut, code, output, durationMs: Date.now() - started, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, output: String(err), durationMs: Date.now() - started, timedOut });
    });
  });
}
