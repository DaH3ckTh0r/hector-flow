import type { FlowConfig } from "../config.js";

/** Variables that look like credentials: never handed to build/test/lint/acceptance commands. */
const SECRET_NAME = [
  /(^|_)(API_?KEY|ACCESS_?KEY|ACCESS_?KEY_?ID|SECRET|SECRET_?KEY|CLIENT_?SECRET|TOKEN|PAT|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|AUTH|SAS|SAS_?TOKEN)($|_)/i,
  /CONNECTION_?STRING/i,
];
/** Harmless names that match the patterns above but tools rely on. */
const ALWAYS_KEEP = new Set(["NPM_CONFIG_REGISTRY", "NPM_CONFIG_CACHE"]);

export function isSecretName(name: string): boolean {
  return !ALWAYS_KEEP.has(name) && SECRET_NAME.some((re) => re.test(name));
}

/**
 * The environment for commands the flow runs itself (build, test, lint,
 * acceptance checks, QA, post-merge checks). Those commands execute code an
 * agent wrote, so credentials of the flow's own process (model API keys,
 * GitHub/Azure DevOps tokens) are removed unless commandEnv.keep lists them.
 */
export function commandEnv(config: Pick<FlowConfig, "commandEnv" | "backlog" | "runtime">, base: NodeJS.ProcessEnv = process.env): {
  env: NodeJS.ProcessEnv;
  removed: string[];
} {
  if (!config.commandEnv.scrubSecrets) return { env: { ...base }, removed: [] };
  const keep = new Set(config.commandEnv.keep);
  const named = new Set<string>(
    [config.backlog && "tokenEnv" in config.backlog ? config.backlog.tokenEnv : undefined, config.runtime.copilot.tokenEnv].filter(
      (n): n is string => !!n,
    ),
  );
  const env: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(base)) {
    if (!keep.has(k) && (named.has(k) || isSecretName(k))) removed.push(k);
    else env[k] = v;
  }
  return { env, removed: removed.sort() };
}
