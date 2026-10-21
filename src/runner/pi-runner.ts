import type { z } from "zod";
import type { FlowConfig } from "../config.js";
import { toJsonSchema } from "../schemas.js";
import { call, ToolBridge, type BridgeTools } from "../tool-bridge.js";
import { addModel, type Usage } from "../usage.js";
import { AgentError, type AgentRequest, type AgentResult, type AgentRunner } from "./agent-runner.js";
import { decide, decisionContext, type DecisionContext, type Verdict } from "./claude-runner.js";

type PiSdk = typeof import("@earendil-works/pi-coding-agent");
type ModelRuntime = Awaited<ReturnType<PiSdk["ModelRuntime"]["create"]>>;
type AgentSession = Awaited<ReturnType<PiSdk["createAgentSession"]>>["session"];

/** The tool that ends a pi run with the step's structured output. */
export const SUBMIT_TOOL = "submit_result";

/** pi built-ins per mode. bash/powershell only where the flow allows commands. */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const EDIT_TOOLS = [...READ_ONLY_TOOLS, "edit", "write", "bash"];

/** Per-call state the guard extension reads: a resumed session keeps its extension, so the policy is swapped per call. */
interface CallState {
  ctx: DecisionContext;
  ownTools: string[];
  denials: AgentResult<unknown>["denials"];
  submitted?: unknown;
  tools: BridgeTools;
}

/**
 * Runs a step with pi (the pi coding agent SDK, in this process).
 *
 * pi has no permission prompts of its own, but every tool call, built-in or
 * custom, goes through extension `tool_call` handlers, which can block it.
 * The runner installs one inline extension that judges each call with
 * decide(): mode, readable roots, secret list, component write isolation,
 * locked tests and the command allowlist, like the Claude runner. Extensions,
 * skills, prompt templates and settings from ~/.pi or the repo are NOT loaded,
 * so nothing can register tools or handlers that bypass the guard.
 *
 * pi has no structured-output mode: the step's schema becomes the parameters
 * of a `submit_result` tool that ends the run. ask/memory are custom tools.
 */
export class PiAgentRunner implements AgentRunner {
  private runtime: Promise<ModelRuntime> | null = null;
  private sdk: Promise<PiSdk> | null = null;
  /** Live sessions of this run, for sending defects back to the same worker. */
  private readonly sessions = new Map<string, { session: AgentSession; state: { current?: CallState } }>();

  constructor(
    private readonly config: FlowConfig,
    private readonly makeRuntime?: (sdk: PiSdk) => Promise<ModelRuntime>,
  ) {}

  async run<S extends z.ZodType>(req: AgentRequest<S>): Promise<AgentResult<z.infer<S>>> {
    const started = Date.now();
    const sdk = await this.loadSdk();
    const runtime = await this.loadRuntime(sdk);
    const settings = this.config.runtime.pi;

    const bridgeTools: BridgeTools = { ask: req.ask, memory: req.memory };
    const ownTools = [...ToolBridge.definitions(bridgeTools).map((d) => d.name), SUBMIT_TOOL];
    const state: CallState = { ctx: decisionContext(req, this.config), ownTools, denials: [], tools: bridgeTools };

    let entry = req.resumeSessionId ? this.sessions.get(req.resumeSessionId) : undefined;
    if (req.resumeSessionId && !entry) {
      throw new AgentError(`pi session ${req.resumeSessionId} is not open in this run; it cannot be resumed.`, req.role);
    }
    if (!entry) {
      const holder: { current?: CallState } = {};
      const modelId = req.model ?? settings.model;
      let model;
      if (modelId) {
        const slash = modelId.indexOf("/");
        model = slash > 0 ? runtime.getModel(modelId.slice(0, slash), modelId.slice(slash + 1)) : undefined;
        if (!model) throw new AgentError(`pi does not know the model "${modelId}" (use "provider/model"; \`pi --list-models\` lists them).`, req.role);
      }
      const loader = new sdk.DefaultResourceLoader({
        cwd: req.cwd,
        agentDir: settings.agentDir ?? sdk.getAgentDir(),
        settingsManager: sdk.SettingsManager.inMemory(),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: !this.config.loadProjectSettings,
        disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
        appendSystemPromptOverride: () => [req.systemPrompt],
        extensionFactories: [{ name: "hector-guard", factory: guardExtension(holder) }],
      });
      await loader.reload();
      const { session } = await sdk.createAgentSession({
        cwd: req.cwd,
        modelRuntime: runtime,
        model,
        thinkingLevel: req.effort ?? settings.effort,
        settingsManager: sdk.SettingsManager.inMemory(),
        sessionManager: sdk.SessionManager.inMemory(req.cwd),
        resourceLoader: loader,
        tools: [...(req.mode === "readonly" ? READ_ONLY_TOOLS : EDIT_TOOLS), ...ownTools],
        customTools: piTools(holder, req.schema),
      });
      entry = { session, state: holder };
      this.sessions.set(session.sessionId, entry);
    }

    const { session } = entry;
    entry.state.current = state;
    const usage: Usage = {};
    let turns = 0;
    let lastError: string | undefined;
    const unsubscribe = session.subscribe((event: { type: string; message?: PiMessage }) => {
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      turns++;
      addPiUsage(usage, event.message);
      if (event.message.stopReason === "error") lastError = event.message.errorMessage;
    });
    try {
      await session.prompt(
        `${req.prompt}\n\nWhen you are done, call the ${SUBMIT_TOOL} tool exactly once with your result. Do not answer in plain text.`,
      );
    } catch (err) {
      throw new AgentError(`pi failed: ${(err as Error).message}`, req.role, costOf(usage), usage);
    } finally {
      unsubscribe();
      entry.state.current = undefined;
    }

    if (state.submitted === undefined) {
      throw new AgentError(`pi finished without calling ${SUBMIT_TOOL}${lastError ? `: ${lastError}` : ""}`, req.role, costOf(usage), usage);
    }
    const parsed = req.schema.safeParse(state.submitted);
    if (!parsed.success) {
      throw new AgentError(`Structured output did not match the contract: ${parsed.error.message}`, req.role, costOf(usage), usage);
    }
    return {
      output: parsed.data,
      sessionId: session.sessionId,
      costUsd: costOf(usage),
      turns: Math.max(1, turns),
      durationMs: Date.now() - started,
      denials: state.denials,
      usage,
    };
  }

  async close(): Promise<void> {
    for (const { session } of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  private loadSdk(): Promise<PiSdk> {
    return (this.sdk ??= import("@earendil-works/pi-coding-agent"));
  }

  /** One model runtime per run: credentials from ~/.pi/agent/auth.json or the provider's environment variables. */
  private loadRuntime(sdk: PiSdk): Promise<ModelRuntime> {
    if (!this.runtime) {
      const agentDir = this.config.runtime.pi.agentDir;
      this.runtime = this.makeRuntime
        ? this.makeRuntime(sdk)
        : sdk.ModelRuntime.create(agentDir ? { authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` } : {});
      this.runtime.catch(() => (this.runtime = null));
    }
    return this.runtime;
  }
}

/** The inline extension: every tool call is judged before it runs. */
function guardExtension(holder: { current?: CallState }) {
  return (pi: { on(event: "tool_call", handler: (e: { toolName: string; input: Record<string, unknown> }) => unknown): void }) => {
    pi.on("tool_call", (event) => {
      const state = holder.current;
      if (!state) return { block: true, reason: "No step is running." };
      const verdict = decidePi(state.ctx, event.toolName, event.input ?? {}, state.ownTools);
      if (verdict.ok) return undefined;
      if (!state.denials.some((d) => d.tool === event.toolName && d.reason === verdict.reason)) {
        state.denials.push({ tool: event.toolName, reason: verdict.reason });
      }
      return { block: true, reason: verdict.reason };
    });
  };
}

/** submit_result (the step's schema) plus the workflow tools the step gets. */
function piTools(holder: { current?: CallState }, schema: z.ZodType) {
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
  const submit = {
    name: SUBMIT_TOOL,
    label: "Submit result",
    description: "Return this step's result. Call it exactly once, when the work is finished; the run ends with it.",
    parameters: toJsonSchema(schema),
    executionMode: "sequential",
    async execute(_id: string, params: unknown) {
      if (holder.current) holder.current.submitted = params;
      return { ...text("Result received."), terminate: true };
    },
  };
  // Declared for every session; the guard refuses the ones this call did not get.
  const workflow = ToolBridge.definitions({ ask: async () => "", memory: { search: async () => "", save: async () => "" } }).map((d) => ({
    name: d.name,
    label: d.name,
    description: d.description,
    parameters: d.inputSchema,
    async execute(_id: string, params: unknown) {
      const tools = holder.current?.tools ?? {};
      return text(await call(tools, d.name, (params ?? {}) as Record<string, unknown>));
    },
  }));
  return [submit, ...workflow] as never;
}

/** Maps one pi tool call onto decide(). */
export function decidePi(ctx: DecisionContext, toolName: string, input: Record<string, unknown>, ownTools: string[]): Verdict {
  const path = typeof input.path === "string" && input.path ? input.path : undefined;
  switch (toolName) {
    case "read":
      return decide(ctx, "Read", { file_path: path ?? "" });
    case "grep":
    case "find":
    case "ls":
      return decide(ctx, "Grep", path ? { path } : {});
    case "edit":
    case "write":
      return decide(ctx, "Write", { file_path: path ?? "" });
    case "bash":
    case "powershell":
      return decide(ctx, "Bash", { command: String(input.command ?? "") });
  }
  if (ownTools.includes(toolName)) return { ok: true };
  return { ok: false, reason: `Tool ${toolName} is not available to this step.` };
}

/** What the runner reads from a pi assistant message. pi-ai already reports input without cached tokens. */
export interface PiMessage {
  role: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning?: number;
    cost?: { total?: number };
  };
}

export function addPiUsage(into: Usage, m: PiMessage): Usage {
  if (!m.usage) return into;
  return addModel(into, m.provider && m.model ? `${m.provider}/${m.model}` : (m.model ?? "pi default"), {
    input: m.usage.input,
    output: m.usage.output,
    cacheRead: m.usage.cacheRead,
    cacheWrite: m.usage.cacheWrite,
    reasoning: m.usage.reasoning ?? 0,
    costUsd: m.usage.cost?.total ?? 0,
  });
}

function costOf(u: Usage): number {
  return Object.values(u).reduce((sum, c) => sum + c.costUsd, 0);
}
