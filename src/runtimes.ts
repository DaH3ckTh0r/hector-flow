import type { z } from "zod";
import type { Effort, FlowConfig, Role, RuntimeName } from "./config.js";
import type { AgentRequest, AgentResult, AgentRunner } from "./runner/agent-runner.js";
import { ClaudeAgentRunner } from "./runner/claude-runner.js";
import { CodexAgentRunner } from "./runner/codex-runner.js";
import { CopilotAgentRunner } from "./runner/copilot-runner.js";
import { OpenCodeAgentRunner } from "./runner/opencode-runner.js";
import { PiAgentRunner } from "./runner/pi-runner.js";
import type { ResolvedStep } from "./skills.js";

export interface RuntimeChoice {
  runtime: RuntimeName;
  model?: string;
  effort?: Effort;
}

type Judge = FlowConfig["review"]["judges"][number];

/**
 * Picks the runtime, model and effort for one step.
 *
 * runtime: judge.runtime > runtime.steps[role] > runtime.default.
 * Claude: model/effort from judge > runtime.steps object > models/efforts > skill front-matter.
 * Codex/OpenCode/Copilot/pi: models/efforts and skill front-matter name Claude models, so they are
 * ignored for the model; it comes from judge > runtime.steps object > runtime.<name>.model.
 * Codex, Copilot and pi also accept the generic effort levels as a last fallback; OpenCode
 * effort (its "variant") is only taken from explicit runtime settings.
 */
export function resolveRuntime(config: FlowConfig, role: Role, step: Pick<ResolvedStep, "model" | "effort">, judge?: Judge): RuntimeChoice {
  const entry = config.runtime.steps[role];
  const stepObj = typeof entry === "object" ? entry : undefined;
  const runtime = judge?.runtime ?? (typeof entry === "string" ? entry : entry?.use) ?? config.runtime.default;
  // A step object's model/effort only applies to the runtime it names.
  const fromStep = stepObj && stepObj.use === runtime ? stepObj : undefined;

  if (runtime === "claude") {
    return { runtime, model: judge?.model ?? fromStep?.model ?? step.model, effort: judge?.effort ?? fromStep?.effort ?? step.effort };
  }
  const settings = config.runtime[runtime];
  const model = judge?.model ?? fromStep?.model ?? settings.model;
  const effort =
    judge?.effort ??
    fromStep?.effort ??
    (runtime === "codex" || runtime === "copilot" || runtime === "pi" ? (config.runtime[runtime].effort ?? step.effort) : undefined);
  return { runtime, model, effort };
}

/** Every runtime the config can route a step to (for `check`). */
export function runtimesInUse(config: FlowConfig): Set<RuntimeName> {
  const used = new Set<RuntimeName>([config.runtime.default]);
  for (const entry of Object.values(config.runtime.steps)) if (entry) used.add(typeof entry === "string" ? entry : entry.use);
  for (const j of config.review.judges) if (j.runtime) used.add(j.runtime);
  return used;
}

export type RunnerFactories = Partial<Record<RuntimeName, () => AgentRunner>>;

/**
 * Sends each request to the runner of its runtime. Runners are created on
 * first use, so an OpenCode server only starts if some step runs there.
 */
export class RouterRunner implements AgentRunner {
  private readonly runners = new Map<RuntimeName, AgentRunner>();

  constructor(
    private readonly defaultRuntime: RuntimeName,
    private readonly factories: RunnerFactories,
  ) {}

  run<S extends z.ZodType>(req: AgentRequest<S>): Promise<AgentResult<z.infer<S>>> {
    return this.get(req.runtime ?? this.defaultRuntime).run(req);
  }

  private get(name: RuntimeName): AgentRunner {
    let runner = this.runners.get(name);
    if (!runner) {
      const make = this.factories[name];
      if (!make) throw new Error(`Runtime "${name}" is not available.`);
      runner = make();
      this.runners.set(name, runner);
    }
    return runner;
  }

  async close(): Promise<void> {
    await Promise.all([...this.runners.values()].map((r) => r.close?.()));
    this.runners.clear();
  }
}

/** The production runner: Claude, Codex, OpenCode, Copilot and pi behind one router. */
export function createRunner(config: FlowConfig, factories: RunnerFactories = {}): RouterRunner {
  return new RouterRunner(config.runtime.default, {
    claude: () => new ClaudeAgentRunner(config),
    codex: () => new CodexAgentRunner(config),
    opencode: () => new OpenCodeAgentRunner(config),
    copilot: () => new CopilotAgentRunner(config),
    pi: () => new PiAgentRunner(config),
    ...factories,
  });
}
