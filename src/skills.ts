import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EffortSchema, RoleSchema, type Effort, type FlowConfig, type Role } from "./config.js";

/**
 * Step skills: the instructions of each role live in SKILL.md files, not in code.
 *
 *   <dir>/<role>/SKILL.md      one per role (enrich, plan, testAuthor, coder, …)
 *   <dir>/_shared/RULES.md     prepended to every role (optional per folder)
 *
 * Lookup order for each file, first match wins:
 *   1. config.skillDirs, in order (relative to the primary repo)
 *   2. <primary repo>/.hector/skills
 *   3. the built-in skills shipped with hector-flow
 */

export const BUILTIN_SKILLS_DIR = resolve(import.meta.dirname, "..", "skills");
export const REPO_SKILLS_DIR = join(".hector", "skills");

export interface StepSkill {
  role: Role;
  /** Instructions (SKILL.md body), without front-matter. */
  body: string;
  description?: string;
  /** Defaults from front-matter; config.models / config.efforts override them. */
  model?: string;
  effort?: Effort;
  /** Claude Code skills this step may use (front-matter `skills`). */
  claudeSkills: string[];
  /** false to skip the shared RULES.md (front-matter `rules: false`). */
  includeRules: boolean;
  /** Absolute path of the SKILL.md that was used. */
  source: string;
  sourceKind: "config" | "repo" | "builtin";
  warnings: string[];
}

export interface SkillSet {
  skills: Record<Role, StepSkill>;
  rules: { body: string; source: string } | null;
}

export interface ResolvedStep {
  instructions: string;
  model?: string;
  effort?: Effort;
  claudeSkills: string[];
}

const ROLES = RoleSchema.options;
const KNOWN_KEYS = new Set(["name", "description", "model", "effort", "skills", "rules"]);

/** Ordered search folders with their kind. */
export function skillSearchPath(primaryRoot: string, config: FlowConfig): Array<{ dir: string; kind: StepSkill["sourceKind"] }> {
  return [
    ...config.skillDirs.map((d) => ({ dir: resolve(primaryRoot, d), kind: "config" as const })),
    { dir: join(primaryRoot, REPO_SKILLS_DIR), kind: "repo" as const },
    { dir: BUILTIN_SKILLS_DIR, kind: "builtin" as const },
  ];
}

export async function loadSkills(primaryRoot: string, config: FlowConfig): Promise<SkillSet> {
  const search = skillSearchPath(primaryRoot, config);
  const skills = {} as Record<Role, StepSkill>;
  for (const role of ROLES) {
    const hit = search.find((s) => existsSync(join(s.dir, role, "SKILL.md")));
    if (!hit) throw new Error(`No SKILL.md found for step "${role}" (searched: ${search.map((s) => s.dir).join(", ")})`);
    const source = join(hit.dir, role, "SKILL.md");
    skills[role] = parseSkill(role, await readFile(source, "utf8"), source, hit.kind);
  }
  const rulesHit = search.find((s) => existsSync(join(s.dir, "_shared", "RULES.md")));
  const rules = rulesHit
    ? { body: (await readFile(join(rulesHit.dir, "_shared", "RULES.md"), "utf8")).trim(), source: join(rulesHit.dir, "_shared", "RULES.md") }
    : null;
  return { skills, rules };
}

/** Effective instructions, model, effort and Claude skills for a role. Config wins over front-matter. */
export function resolveStep(set: SkillSet, role: Role, config: FlowConfig): ResolvedStep {
  const s = set.skills[role];
  const instructions = [s.includeRules && set.rules ? set.rules.body : "", s.body].filter(Boolean).join("\n\n");
  return {
    instructions,
    model: config.models[role] ?? s.model,
    effort: config.efforts[role] ?? s.effort,
    claudeSkills: [...new Set([...s.claudeSkills, ...(config.claudeSkills[role] ?? [])])],
  };
}

/**
 * Copies built-in skills into <repo>/.hector/skills so they can be customized
 * and committed. Never overwrites an existing file.
 */
export async function ejectSkills(primaryRoot: string, roles: Array<Role | "_shared">): Promise<Array<{ path: string; created: boolean }>> {
  const out: Array<{ path: string; created: boolean }> = [];
  for (const role of roles) {
    const file = role === "_shared" ? "RULES.md" : "SKILL.md";
    const from = join(BUILTIN_SKILLS_DIR, role, file);
    const to = join(primaryRoot, REPO_SKILLS_DIR, role, file);
    if (existsSync(to)) {
      out.push({ path: to, created: false });
      continue;
    }
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    out.push({ path: to, created: true });
  }
  return out;
}

/** Parses SKILL.md: optional YAML-like front-matter between --- lines, then the body. */
export function parseSkill(role: Role, text: string, source: string, kind: StepSkill["sourceKind"]): StepSkill {
  const warnings: string[] = [];
  let meta: Record<string, string | string[]> = {};
  let body = text;
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    meta = parseFrontMatter(fm[1]!);
    body = text.slice(fm[0].length);
  }
  for (const key of Object.keys(meta)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`unknown front-matter key "${key}" (known: ${[...KNOWN_KEYS].join(", ")})`);
  }
  if (meta.name !== undefined && meta.name !== role) {
    warnings.push(`front-matter name "${String(meta.name)}" does not match its folder "${role}"; the folder decides`);
  }
  let effort: Effort | undefined;
  if (meta.effort !== undefined) {
    const parsed = EffortSchema.safeParse(meta.effort);
    if (parsed.success) effort = parsed.data;
    else warnings.push(`invalid effort "${String(meta.effort)}" (use ${EffortSchema.options.join(", ")}); ignored`);
  }
  const skillsValue = meta.skills;
  const claudeSkills = Array.isArray(skillsValue) ? skillsValue : skillsValue ? [skillsValue] : [];
  if (!body.trim()) warnings.push("the skill has no instructions");
  return {
    role,
    body: body.trim(),
    description: typeof meta.description === "string" ? meta.description : undefined,
    model: typeof meta.model === "string" && meta.model ? meta.model : undefined,
    effort,
    claudeSkills,
    includeRules: meta.rules !== "false",
    source,
    sourceKind: kind,
    warnings,
  };
}

/**
 * Minimal front-matter parser: `key: value`, `key: [a, b]`, or a key followed
 * by `- item` lines. Quotes around values are removed. Enough for SKILL.md.
 */
export function parseFrontMatter(src: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      (out[listKey] as string[]).push(unquote(item[1]!));
      continue;
    }
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv as unknown as [string, string, string];
    if (value === "") {
      out[key] = [];
      listKey = key;
    } else if (/^\[.*\]$/.test(value.trim())) {
      out[key] = value
        .trim()
        .slice(1, -1)
        .split(",")
        .map((v) => unquote(v.trim()))
        .filter(Boolean);
      listKey = null;
    } else {
      out[key] = unquote(value.trim());
      listKey = null;
    }
  }
  return out;
}

function unquote(v: string): string {
  return v.replace(/^(['"])(.*)\1$/, "$2");
}
