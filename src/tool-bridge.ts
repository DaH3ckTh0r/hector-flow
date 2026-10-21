import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentRequest, MemorySaveInput } from "./runner/agent-runner.js";

/**
 * Exposes the workflow's own tools (ask, memory_search, memory_save) as a
 * streamable-HTTP MCP server on 127.0.0.1, for runtimes that cannot host an
 * in-process MCP server (Codex, OpenCode).
 *
 * Every agent call registers its tools under a random token and gets its own
 * URL (/mcp/<token>). Parallel workers therefore never see each other's tools,
 * and a URL stops working the moment its call ends.
 */
export interface BridgeTools {
  ask?: AgentRequest<never>["ask"];
  memory?: AgentRequest<never>["memory"];
}

export class ToolBridge {
  private http: HttpServer | null = null;
  private base = "";
  private readonly routes = new Map<string, BridgeTools>();

  /** Starts the HTTP server (once) and returns its base URL. */
  async start(): Promise<string> {
    if (this.http) return this.base;
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String((err as Error).message) }));
      });
    });
    await new Promise<void>((done) => this.http!.listen(0, "127.0.0.1", done));
    this.base = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
    return this.base;
  }

  /** Registers one call's tools. Returns its URL, or null when the call has no bridge tools. */
  async register(tools: BridgeTools): Promise<{ url: string; token: string } | null> {
    if (!tools.ask && !tools.memory?.search && !tools.memory?.save) return null;
    const base = await this.start();
    const token = randomBytes(12).toString("hex");
    this.routes.set(token, tools);
    return { url: `${base}/mcp/${token}`, token };
  }

  unregister(token: string | undefined): void {
    if (token) this.routes.delete(token);
  }

  async close(): Promise<void> {
    this.routes.clear();
    const http = this.http;
    this.http = null;
    if (http) await new Promise<void>((done) => http.close(() => done()));
  }

  /** Tool definitions (JSON Schema) for a registration. */
  static definitions(tools: BridgeTools) {
    const defs: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
    if (tools.ask) {
      defs.push({
        name: "ask",
        description:
          "Ask the workflow a question about the ticket, the plan or the intended behavior when the repository does not answer it. " +
          "Use it before guessing on anything that changes behavior. If the answer says no authoritative answer exists, make the most " +
          "reasonable decision and record the assumption in your notes.",
        inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
      });
    }
    if (tools.memory?.search) {
      defs.push({
        name: "memory_search",
        description: "Search this repository's persistent memory: decisions, discoveries, conventions and gotchas recorded by earlier runs.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } },
          required: ["query"],
        },
      });
    }
    if (tools.memory?.save) {
      defs.push({
        name: "memory_save",
        description:
          "Record something future runs on this repository should know: a decision and its reason, a non-obvious discovery, a convention, " +
          "or a gotcha. Not for task progress. It becomes permanent only if this run completes.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: { type: "string" },
            kind: { type: "string", enum: ["decision", "discovery", "convention", "gotcha"] },
            tags: { type: "array", items: { type: "string" } },
            files: { type: "array", items: { type: "string" } },
          },
          required: ["title", "content", "kind"],
        },
      });
    }
    return defs;
  }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const token = req.url?.match(/^\/mcp\/([0-9a-f]+)\/?$/)?.[1];
    const tools = token ? this.routes.get(token) : undefined;
    if (!tools) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "unknown or expired tool route" }));
      return;
    }
    const body = req.method === "POST" ? await readJson(req) : undefined;

    // Stateless: a fresh MCP server and transport per HTTP request.
    const server = new Server({ name: "hector", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ToolBridge.definitions(tools) }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const text = await call(tools, request.params.name, args);
      return { content: [{ type: "text", text }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}

async function call(tools: BridgeTools, name: string, args: Record<string, unknown>): Promise<string> {
  if (name === "ask" && tools.ask) return tools.ask(String(args.question ?? ""));
  if (name === "memory_search" && tools.memory?.search) {
    return tools.memory.search(String(args.query ?? ""), typeof args.limit === "number" ? args.limit : undefined);
  }
  if (name === "memory_save" && tools.memory?.save) {
    return tools.memory.save({
      title: String(args.title ?? ""),
      content: String(args.content ?? ""),
      kind: (args.kind as MemorySaveInput["kind"]) ?? "discovery",
      tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
      files: Array.isArray(args.files) ? args.files.map(String) : undefined,
    });
  }
  return `Tool ${name} is not available to this step.`;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((done, fail) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        done(raw ? JSON.parse(raw) : undefined);
      } catch (err) {
        fail(err);
      }
    });
    req.on("error", fail);
  });
}
