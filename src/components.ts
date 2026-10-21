import { basename, posix, resolve } from "node:path";
import type { FlowConfig } from "./config.js";
import { git } from "./tools/git.js";

/** A component resolved against the filesystem. */
export interface Component {
  name: string;
  description?: string;
  /** Absolute path of the repository's main checkout. */
  repoRoot: string;
  /** Repository folder name, used for worktree paths. */
  repoName: string;
  /** Folder inside the repo, posix, "." for the root. */
  path: string;
  buildCommand?: string;
  testCommand: string;
  lintCommand?: string;
  /** Globs relative to the REPO root (already prefixed with `path`). */
  lockedPaths: string[];
  allowedCommands: string[];
}

/**
 * Turns the config into concrete components. Without `components`, the
 * top-level commands define a single component called "main" at the repo root,
 * which keeps single-repo configs working unchanged.
 */
export async function resolveComponents(primaryRepo: string, config: FlowConfig): Promise<Component[]> {
  const entries = config.components
    ? Object.entries(config.components)
    : [
        [
          "main",
          {
            repo: ".",
            path: ".",
            buildCommand: config.buildCommand,
            testCommand: config.testCommand!,
            lintCommand: config.lintCommand,
          },
        ] as const,
      ];

  const out: Component[] = [];
  for (const [name, c] of entries) {
    const dir = resolve(primaryRepo, c.repo ?? ".");
    let repoRoot: string;
    try {
      repoRoot = await git(dir, "rev-parse", "--show-toplevel");
    } catch {
      throw new Error(`Component "${name}": ${dir} is not inside a git repository.`);
    }
    const path = normalizePath(c.path ?? ".");
    const locked = ("lockedPaths" in c && c.lockedPaths) || config.lockedPaths;
    out.push({
      name,
      description: "description" in c ? c.description : undefined,
      repoRoot,
      repoName: basename(repoRoot),
      path,
      buildCommand: c.buildCommand,
      testCommand: c.testCommand,
      lintCommand: c.lintCommand,
      lockedPaths: locked.map((g) => (path === "." ? g : posix.join(path, g))),
      allowedCommands: ("allowedCommands" in c && c.allowedCommands) || config.allowedCommands,
    });
  }

  const repoNames = new Map<string, string>();
  for (const c of out) {
    const seen = repoNames.get(c.repoName);
    if (seen && seen !== c.repoRoot) {
      throw new Error(`Two different repositories are both named "${c.repoName}"; worktree folders would collide.`);
    }
    repoNames.set(c.repoName, c.repoRoot);
  }
  return out;
}

function normalizePath(p: string): string {
  const n = posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\/|\/$/g, "");
  if (n.startsWith("..") || posix.isAbsolute(n)) throw new Error(`Component path must stay inside its repo: ${p}`);
  return n === "" ? "." : n;
}
