import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type FlowEvent =
  | { type: "step.start"; step: string; attempt?: number }
  | { type: "step.end"; step: string; ok: boolean; durationMs: number; costUsd?: number; attempt?: number }
  | { type: "shell"; step: string; command: string; ok: boolean; code: number | null; durationMs: number }
  | { type: "guard"; step: string; action: string; detail: string }
  | { type: "info"; message: string; data?: unknown }
  | { type: "error"; step: string; message: string };

/**
 * Structured run log: one JSON object per line in `<runDir>/events.jsonl`,
 * plus every agent output saved as an artifact. Easy to ship to App Insights
 * or OpenTelemetry later without changing the workflow.
 */
export class RunLog {
  private constructor(
    readonly runDir: string,
    readonly runId: string,
  ) {}

  static async create(baseDir: string, runId: string): Promise<RunLog> {
    const runDir = join(baseDir, runId);
    await mkdir(join(runDir, "artifacts"), { recursive: true });
    return new RunLog(runDir, runId);
  }

  async emit(event: FlowEvent): Promise<void> {
    const line = { ts: new Date().toISOString(), runId: this.runId, ...event };
    await appendFile(join(this.runDir, "events.jsonl"), JSON.stringify(line) + "\n");
    console.log(format(event));
  }

  /** Saves an artifact. Characters invalid in Windows file names (e.g. "write-tests:api") become "_". */
  async artifact(name: string, data: unknown): Promise<void> {
    const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    await writeFile(join(this.runDir, "artifacts", name.replace(/[<>:"/\\|?*]/g, "_")), body);
  }
}

function format(e: FlowEvent): string {
  switch (e.type) {
    case "step.start":
      return `▶ ${e.step}${e.attempt ? ` (attempt ${e.attempt})` : ""}`;
    case "step.end":
      return `${e.ok ? "✔" : "✖"} ${e.step} ${(e.durationMs / 1000).toFixed(1)}s${e.costUsd ? ` $${e.costUsd.toFixed(4)}` : ""}`;
    case "shell":
      return `  $ ${e.command} → ${e.ok ? "ok" : `exit ${e.code}`} (${(e.durationMs / 1000).toFixed(1)}s)`;
    case "guard":
      return `  ⚠ guard: ${e.action} — ${e.detail}`;
    case "info":
      return `  · ${e.message}`;
    case "error":
      return `  ✖ ${e.step}: ${e.message}`;
  }
}
