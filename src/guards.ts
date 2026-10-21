import { isAbsolute, relative, resolve, sep } from "node:path";

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

const FORBIDDEN_SHELL = /[;&|`<>]|\$\(|\$\{|\n/;

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
