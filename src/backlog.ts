import { readdir, readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import type { FlowConfig } from "./config.js";
import { parseTicket, type Ticket } from "./ticket.js";

/**
 * Where `hector-flow start` gets tickets from. Every adapter turns its items
 * into the same markdown Ticket the flow already uses, so the rest of the
 * system does not know or care where a ticket came from.
 */
export interface BacklogItem {
  ticket: Ticket;
  /** Human reference: file path or web URL. */
  ref: string;
}

export interface BacklogListing {
  items: BacklogItem[];
  /** Items that exist but cannot run (e.g. no acceptance criteria), with the reason. */
  skipped: Array<{ ref: string; reason: string }>;
}

export interface BacklogAdapter {
  readonly kind: "folder" | "github" | "azure-devops";
  list(): Promise<BacklogListing>;
  /** Posts a message about a ticket back to its source (a comment). No-op for folders. */
  report(item: BacklogItem, message: string): Promise<void>;
}

export interface BacklogDeps {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export function createBacklog(config: FlowConfig, primaryRoot: string, deps: BacklogDeps = {}): BacklogAdapter {
  const b = config.backlog;
  if (!b) throw new Error("No backlog configured. Add a 'backlog' section to hector-flow.config.json (see docs/15-backlog-y-bucle.md).");
  const http = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  switch (b.type) {
    case "folder":
      return new FolderBacklog(isAbsolute(b.path) ? b.path : resolve(primaryRoot, b.path));
    case "github":
      return new GitHubBacklog(b.repo, b.label, token(env, b.tokenEnv), b.comment, http);
    case "azure-devops":
      return new AzureDevOpsBacklog(b, token(env, b.tokenEnv), http);
  }
}

function token(env: Record<string, string | undefined>, name: string): string {
  const t = env[name];
  if (!t) throw new Error(`Environment variable ${name} is not set: the backlog adapter needs it to authenticate.`);
  return t;
}

// ── Folder ────────────────────────────────────────────────────────────────

/** Every *.md file directly inside a folder is a ticket. Files are read in name order. */
export class FolderBacklog implements BacklogAdapter {
  readonly kind = "folder" as const;
  constructor(readonly dir: string) {}

  async list(): Promise<BacklogListing> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((n) => extname(n).toLowerCase() === ".md").sort();
    } catch {
      throw new Error(`Backlog folder ${this.dir} does not exist.`);
    }
    const out: BacklogListing = { items: [], skipped: [] };
    for (const name of names) {
      const path = join(this.dir, name);
      try {
        out.items.push({ ticket: parseTicket(await readFile(path, "utf8"), { fallbackId: basename(name, ".md"), source: path }), ref: path });
      } catch (err) {
        out.skipped.push({ ref: path, reason: (err as Error).message });
      }
    }
    return out;
  }

  async report(): Promise<void> {}
}

// ── GitHub issues ─────────────────────────────────────────────────────────

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  pull_request?: unknown;
}

/** Open issues with a label. Ticket id: GH-<number>. Body: the issue body as markdown. */
export class GitHubBacklog implements BacklogAdapter {
  readonly kind = "github" as const;
  constructor(
    readonly repo: string,
    readonly label: string,
    private readonly token: string,
    private readonly comment: boolean,
    private readonly http: typeof fetch,
  ) {}

  private headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "hector-flow",
    };
  }

  async list(): Promise<BacklogListing> {
    const url = `https://api.github.com/repos/${this.repo}/issues?state=open&labels=${encodeURIComponent(this.label)}&per_page=50&sort=created&direction=asc`;
    const res = await this.http(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`GitHub ${res.status} listing issues of ${this.repo}: ${await res.text()}`);
    const issues = ((await res.json()) as GitHubIssue[]).filter((i) => !i.pull_request);
    const out: BacklogListing = { items: [], skipped: [] };
    for (const i of issues) {
      const md = `# GH-${i.number}: ${i.title}\n\n${i.body ?? ""}`;
      try {
        out.items.push({ ticket: parseTicket(md, { fallbackId: `GH-${i.number}`, source: i.html_url }), ref: i.html_url });
      } catch (err) {
        out.skipped.push({ ref: i.html_url, reason: (err as Error).message });
      }
    }
    return out;
  }

  async report(item: BacklogItem, message: string): Promise<void> {
    if (!this.comment) return;
    const n = item.ticket.id.replace(/^GH-/, "");
    const res = await this.http(`https://api.github.com/repos/${this.repo}/issues/${n}/comments`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ body: message }),
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} commenting on ${item.ref}: ${await res.text()}`);
  }
}

// ── Azure DevOps work items ───────────────────────────────────────────────

type AdoConfig = Extract<NonNullable<FlowConfig["backlog"]>, { type: "azure-devops" }>;

interface AdoWorkItem {
  id: number;
  fields: Record<string, string | undefined>;
  _links?: { html?: { href?: string } };
}

/**
 * Work items found by WIQL (by default: a tag and a set of states). Ticket id:
 * ADO-<id>. Description and Acceptance Criteria are converted from HTML.
 */
export class AzureDevOpsBacklog implements BacklogAdapter {
  readonly kind = "azure-devops" as const;
  private readonly base: string;

  constructor(
    readonly cfg: AdoConfig,
    private readonly token: string,
    private readonly http: typeof fetch,
  ) {
    this.base = `https://dev.azure.com/${encodeURIComponent(cfg.organization)}/${encodeURIComponent(cfg.project)}/_apis/wit`;
  }

  private headers(json = true) {
    return {
      Authorization: `Basic ${Buffer.from(`:${this.token}`).toString("base64")}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  wiql(): string {
    if (this.cfg.wiql) return this.cfg.wiql;
    const esc = (s: string) => s.replace(/'/g, "''");
    const states = this.cfg.states.map((s) => `'${esc(s)}'`).join(", ");
    return (
      `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ` +
      `AND [System.Tags] CONTAINS '${esc(this.cfg.tag)}' AND [System.State] IN (${states}) ORDER BY [System.Id] ASC`
    );
  }

  async list(): Promise<BacklogListing> {
    const q = await this.http(`${this.base}/wiql?api-version=7.1`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ query: this.wiql() }),
    });
    if (!q.ok) throw new Error(`Azure DevOps ${q.status} running WIQL: ${await q.text()}`);
    const ids = ((await q.json()) as { workItems: Array<{ id: number }> }).workItems.map((w) => w.id).slice(0, 200);
    const out: BacklogListing = { items: [], skipped: [] };
    if (!ids.length) return out;
    const fields = ["System.Title", "System.Description", "Microsoft.VSTS.Common.AcceptanceCriteria"].join(",");
    const res = await this.http(`${this.base}/workitems?ids=${ids.join(",")}&fields=${fields}&api-version=7.1`, { headers: this.headers(false) });
    if (!res.ok) throw new Error(`Azure DevOps ${res.status} reading work items: ${await res.text()}`);
    for (const w of ((await res.json()) as { value: AdoWorkItem[] }).value) {
      const ref = `https://dev.azure.com/${this.cfg.organization}/${this.cfg.project}/_workitems/edit/${w.id}`;
      const description = htmlToMarkdown(w.fields["System.Description"] ?? "");
      const criteriaHtml = w.fields["Microsoft.VSTS.Common.AcceptanceCriteria"] ?? "";
      const criteria = htmlToMarkdown(criteriaHtml)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => (/^[-*]\s/.test(l) ? l : `- ${l}`));
      const md = [
        `# ADO-${w.id}: ${w.fields["System.Title"] ?? ""}`,
        "",
        description,
        criteria.length ? `\n## Acceptance criteria\n${criteria.join("\n")}` : "",
      ].join("\n");
      try {
        out.items.push({ ticket: parseTicket(md, { fallbackId: `ADO-${w.id}`, source: ref }), ref });
      } catch (err) {
        out.skipped.push({ ref, reason: (err as Error).message });
      }
    }
    return out;
  }

  async report(item: BacklogItem, message: string): Promise<void> {
    if (!this.cfg.comment) return;
    const id = item.ticket.id.replace(/^ADO-/, "");
    const html = `<pre>${message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
    const res = await this.http(`${this.base}/workItems/${id}/comments?api-version=7.1-preview.4`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ text: html }),
    });
    if (!res.ok) throw new Error(`Azure DevOps ${res.status} commenting on ${item.ref}: ${await res.text()}`);
  }
}

/** Small HTML → markdown conversion for work item fields: headings, lists, paragraphs, breaks, entities. */
export function htmlToMarkdown(html: string): string {
  return html
    .replace(/\r/g, "")
    .replace(/<\s*h[1-3][^>]*>/gi, "\n## ")
    .replace(/<\s*h[4-6][^>]*>/gi, "\n### ")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|h[1-6]|ul|ol|li|tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
