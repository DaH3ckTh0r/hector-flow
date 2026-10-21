/**
 * Transient agent failures: worth retrying the same call after a pause.
 * Limits the step itself hit (max turns, budget), contract violations and
 * refused credentials are not transient: retrying would fail the same way.
 */
const PERMANENT = [
  /max[_ ]?turns|max[_ ]?budget|budget exceeded/i,
  /did not match the contract/i,
  /not signed in|unauthori[sz]ed|\b401\b|\b403\b|invalid (api )?key|authentication/i,
  /does not know the model|unknown model|model not found|not open in this run/i,
];
const TRANSIENT = [
  /rate.?limit|too many requests|\b429\b/i,
  /overloaded|\b529\b|\b50[0234]\b|internal server error|bad gateway|service unavailable|gateway timeout/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|fetch failed|connection (closed|reset|error)/i,
  /timed? ?out|timeout/i,
  /exited with code|process exited|terminated|SIGKILL|SIGTERM|killed|crash/i,
  /without a result message|error_during_execution/i,
];

export function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}` : String(err);
  if (PERMANENT.some((re) => re.test(msg))) return false;
  return TRANSIENT.some((re) => re.test(msg));
}

/** Wait before retry n (1-based): base · 2^(n-1), ±20% jitter, at most 5 minutes. */
export function retryDelayMs(n: number, baseSeconds: number, random: () => number = Math.random): number {
  const ms = Math.min(300_000, baseSeconds * 1000 * 2 ** (n - 1));
  return Math.round(ms * (0.8 + 0.4 * random()));
}
