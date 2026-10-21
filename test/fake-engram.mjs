#!/usr/bin/env node
/**
 * Stand-in for `engram mcp --tools=agent` in tests (the real binary cannot be
 * built in CI here). It mirrors the parts of Engram's MCP contract hector-flow
 * uses, as defined in engram's internal/mcp/mcp.go:
 *   mem_search { query (required), type, project, all_projects, scope, match_mode ("all"|"any"), response_format, limit }
 *   mem_save   { title (required), content | observation, type, scope, topic_key, project, capture_prompt (boolean) }
 * Project: ENGRAM_PROJECT, else the working directory's name (Engram detects it from the repo).
 * Data: $ENGRAM_DATA_DIR/fake-engram.json. Every call is appended to calls.jsonl for assertions.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const dir = process.env.ENGRAM_DATA_DIR ?? join(process.env.HOME ?? ".", ".engram");
mkdirSync(dir, { recursive: true });
const dbFile = join(dir, "fake-engram.json");
const project = process.env.ENGRAM_PROJECT ?? basename(process.cwd());
const load = () => (existsSync(dbFile) ? JSON.parse(readFileSync(dbFile, "utf8")) : { next: 1, observations: [] });
const record = (tool, args) => appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ tool, args, project, cwd: process.cwd() }) + "\n");

if (process.argv.includes("--fail-saves")) process.env.FAKE_ENGRAM_FAIL_SAVES = "1";
const server = new McpServer({ name: "engram", version: "fake" });

server.registerTool(
  "mem_search",
  {
    description: "Search your persistent memory across all sessions.",
    inputSchema: {
      query: z.string(),
      type: z.string().optional(),
      project: z.string().optional(),
      all_projects: z.boolean().optional(),
      scope: z.string().optional(),
      match_mode: z.string().optional(),
      response_format: z.string().optional(),
      limit: z.number().optional(),
    },
  },
  async (args) => {
    record("mem_search", args);
    if (args.match_mode && !["all", "any"].includes(args.match_mode)) {
      return { isError: true, content: [{ type: "text", text: `invalid match_mode "${args.match_mode}": must be "all" or "any"` }] };
    }
    const terms = args.query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    const any = args.match_mode === "any";
    const hits = load()
      .observations.filter((o) => o.project === (args.project ?? project))
      .filter((o) => {
        const text = `${o.title} ${o.content}`.toLowerCase();
        return any ? terms.some((t) => text.includes(t)) : terms.every((t) => text.includes(t));
      })
      .slice(0, Math.min(20, args.limit ?? 10));
    if (!hits.length) return { content: [{ type: "text", text: `No memories found for: "${args.query}"` }] };
    const text =
      `Found ${hits.length} memories:\n\n` +
      hits.map((o, i) => `[${i + 1}] #${o.id} (${o.type}) — ${o.title}\n    ${o.content.slice(0, 300)}\n    ${o.createdAt} | project: ${o.project} | scope: project\n`).join("");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "mem_save",
  {
    description: "Save an important observation to persistent memory.",
    inputSchema: {
      title: z.string(),
      content: z.string().optional(),
      observation: z.string().optional(),
      type: z.string().optional(),
      session_id: z.string().optional(),
      scope: z.string().optional(),
      topic_key: z.string().optional(),
      project: z.string().optional(),
      capture_prompt: z.boolean().optional(),
    },
  },
  async (args) => {
    record("mem_save", args);
    if (process.env.FAKE_ENGRAM_FAIL_SAVES) return { isError: true, content: [{ type: "text", text: "store is locked" }] };
    const content = args.content ?? args.observation;
    if (!content) return { isError: true, content: [{ type: "text", text: "content is required" }] };
    const db = load();
    const id = db.next++;
    db.observations.push({ id, title: args.title, content, type: args.type ?? "manual", project: args.project ?? project, createdAt: new Date().toISOString() });
    writeFileSync(dbFile, JSON.stringify(db, null, 2));
    return { content: [{ type: "text", text: `Memory saved: "${args.title}" (${args.type ?? "manual"})` }] };
  },
);

await server.connect(new StdioServerTransport());
