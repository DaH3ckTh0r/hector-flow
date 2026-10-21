import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Minimal glob → RegExp: supports **, *, ? and {a,b}. Paths use forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${glob.slice(i + 1, end).split(",").map(escape).join("|")})`;
        i = end;
      }
    } else re += escape(c);
  }
  return new RegExp(`^${re}$`);
}

function escape(s: string): string {
  return s.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

/**
 * Path rules for one worktree. `root` is the worktree root; locked globs are
 * relative to it. `writeRoot` (a folder inside root) limits where edits may go,
 * so a frontend worker in a monorepo cannot write into the backend folder.
 */
export class PathPolicy {
  private readonly locked: RegExp[];
  readonly writePrefix: string;

  constructor(
    private readonly root: string,
    lockedGlobs: string[],
    writeRoot: string = root,
  ) {
    this.locked = lockedGlobs.map(globToRegExp);
    const w = relative(root, writeRoot).split(sep).join("/");
    this.writePrefix = w === "" ? "" : `${w}/`;
  }

  /** Root-relative path with forward slashes, or null if it escapes the root. `base` resolves relative inputs. */
  toRelative(p: string, base: string = this.root): string | null {
    const abs = isAbsolute(p) ? p : resolve(base, p);
    const rel = relative(this.root, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel.split(sep).join("/");
  }

  isLocked(p: string, base?: string): boolean {
    const rel = this.toRelative(p, base);
    return rel !== null && this.locked.some((r) => r.test(rel));
  }

  isWritable(p: string, base?: string): boolean {
    const rel = this.toRelative(p, base);
    return rel !== null && rel.startsWith(this.writePrefix);
  }
}

/**
 * What an agent may read: only paths inside its readable roots (its worktree
 * and the other repos of the ticket), and never paths matching a deny glob.
 *
 * Deny globs starting with "~/" or "/" are absolute; any other glob is matched
 * against the path relative to the root that contains it (so "**\/.env" means
 * any .env file in any readable root).
 */
export class ReadPolicy {
  private readonly roots: string[];
  private readonly absolute: RegExp[] = [];
  private readonly relative: RegExp[] = [];

  constructor(roots: string[], deny: string[], home: string = homedir()) {
    this.roots = roots.map((r) => resolve(r));
    for (const g of deny) {
      if (g.startsWith("~/")) this.absolute.push(globToRegExp(toPosix(resolve(home, g.slice(2)))));
      else if (isAbsolute(g)) this.absolute.push(globToRegExp(toPosix(resolve(g))));
      else this.relative.push(globToRegExp(g.replace(/^\.\//, "")));
    }
  }

  check(p: string, base: string): { ok: true } | { ok: false; reason: string } {
    const abs = resolve(base, p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
    const root = this.roots.find((r) => abs === r || !relative(r, abs).startsWith("..") && !isAbsolute(relative(r, abs)));
    if (!root) {
      return { ok: false, reason: `${p} is outside the folders this step may read (its workspace and the ticket's other repositories).` };
    }
    const absPosix = toPosix(abs);
    const rel = toPosix(relative(root, abs));
    if (this.absolute.some((r) => r.test(absPosix)) || (rel && this.relative.some((r) => r.test(rel)))) {
      return { ok: false, reason: `${p} matches readDenyPaths (secrets). Do not read it; work without its contents.` };
    }
    return { ok: true };
  }
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

const FORBIDDEN_SHELL =/[;&|`<>]|\$\(|\$\{|\n/;

/**
 * Accepts a command only if it starts with an allowed prefix (a prefix ending
 * in "/" also matches files under that folder) and contains no chaining,
 * piping, redirection or substitution. Deliberately strict: the agent can run
 * the test command, not compose arbitrary shell programs.
 */
export function isCommandAllowed(command: string, allowed: string[]): { ok: boolean; reason?: string } {
  const cmd = command.trim();
  if (FORBIDDEN_SHELL.test(cmd)) {
    return { ok: false, reason: "Chaining, pipes, redirection and substitution are not allowed. Run one command at a time." };
  }
  const match = allowed.some((prefix) => {
    if (cmd === prefix || cmd.startsWith(prefix + " ")) return true;
    // "node qa/" allows "node qa/check.js", but never a path that climbs out with "..".
    if (prefix.endsWith("/") && cmd.startsWith(prefix)) {
      const pathArg = cmd.slice(prefix.length).split(" ")[0]!;
      return pathArg.length > 0 && !pathArg.split("/").includes("..");
    }
    return false;
  });
  if (!match) {
    return { ok: false, reason: `Command not in allowlist. Allowed prefixes: ${allowed.join(", ") || "(none)"}` };
  }
  return { ok: true };
}
