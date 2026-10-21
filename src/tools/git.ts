import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 });
  return stdout.trimEnd();
}

export interface Workspace {
  path: string;
  branch: string;
  baseRef: string;
}

export async function assertClean(repoRoot: string): Promise<void> {
  if (await git(repoRoot, "status", "--porcelain")) {
    throw new Error(
      `${repoRoot} has uncommitted changes. Commit or stash them first: worktrees are created from HEAD.`,
    );
  }
}

/** Creates a worktree at `path` on a new `branch` starting at `startRef`. */
export async function addWorktree(repoRoot: string, path: string, branch: string, startRef: string): Promise<Workspace> {
  if (await git(repoRoot, "branch", "--list", branch)) {
    throw new Error(
      `Branch ${branch} already exists in ${repoRoot}. Remove it (git worktree remove <path> && git branch -D ${branch}) or rename the ticket.`,
    );
  }
  await mkdir(dirname(path), { recursive: true });
  const baseRef = await git(repoRoot, "rev-parse", startRef);
  await git(repoRoot, "worktree", "add", "-b", branch, path, baseRef);
  return { path, branch, baseRef };
}

export async function removeWorktree(repoRoot: string, ws: Workspace): Promise<void> {
  await git(repoRoot, "worktree", "remove", "--force", ws.path).catch(() => undefined);
  await git(repoRoot, "branch", "-D", ws.branch).catch(() => undefined);
}

/** Files changed in the worktree since `ref`, including untracked files. */
export async function changedFiles(cwd: string, ref = "HEAD"): Promise<string[]> {
  const tracked = await git(cwd, "diff", "--name-only", ref);
  const untracked = await git(cwd, "ls-files", "--others", "--exclude-standard");
  return [...new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean))];
}

export async function diff(cwd: string, ref = "HEAD", maxChars = 20_000): Promise<string> {
  await git(cwd, "add", "-N", "."); // include untracked files in the diff
  const d = await git(cwd, "diff", ref);
  return d.length > maxChars ? d.slice(0, maxChars) + "\n…(diff truncated)…" : d;
}

/** Restores files to `ref`, deleting them if they did not exist there. */
export async function restoreFiles(cwd: string, files: string[], ref: string): Promise<void> {
  for (const file of files) {
    const existed = await git(cwd, "cat-file", "-e", `${ref}:${file}`).then(
      () => true,
      () => false,
    );
    if (existed) {
      await git(cwd, "checkout", ref, "--", file);
    } else {
      await git(cwd, "rm", "-f", "--cached", "--ignore-unmatch", file);
      await rm(join(cwd, file), { force: true });
    }
  }
}

/** Commits exactly these paths (additions, edits and deletions), nothing else. */
export async function commitFiles(cwd: string, files: string[], message: string): Promise<string> {
  await git(cwd, "add", "-A", "--", ...files);
  await git(cwd, "commit", "-m", message, "--no-verify", "--", ...files);
  return git(cwd, "rev-parse", "HEAD");
}

export async function commitAll(cwd: string, message: string): Promise<string> {
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", message, "--no-verify");
  return git(cwd, "rev-parse", "HEAD");
}

export type MergeResult = { ok: true; sha: string } | { ok: false; conflicts: string[] };

/**
 * Merges `branch` into the worktree's current branch. On conflict the merge is
 * left in progress so the caller can resolve it or abort it.
 */
export async function merge(cwd: string, branch: string, message: string, opts: { noFf?: boolean } = {}): Promise<MergeResult> {
  try {
    await git(cwd, "merge", ...(opts.noFf ? ["--no-ff"] : []), "--no-verify", "-m", message, branch);
    return { ok: true, sha: await git(cwd, "rev-parse", "HEAD") };
  } catch {
    const conflicts = (await git(cwd, "diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean);
    if (!conflicts.length) throw new Error(`git merge ${branch} failed in ${cwd} without conflicts`);
    return { ok: false, conflicts };
  }
}

export async function abortMerge(cwd: string): Promise<void> {
  await git(cwd, "merge", "--abort").catch(() => undefined);
}

export async function filesWithConflictMarkers(cwd: string, files: string[]): Promise<string[]> {
  const marked: string[] = [];
  for (const f of files) {
    const body = await readFile(join(cwd, f), "utf8").catch(() => "");
    if (/^(<{7}|={7}|>{7})( |$)/m.test(body)) marked.push(f);
  }
  return marked;
}

/** Concludes an in-progress merge after conflicts were resolved in the working tree. */
export async function concludeMerge(cwd: string, files: string[]): Promise<string> {
  await git(cwd, "add", "-A", "--", ...files);
  await git(cwd, "commit", "--no-edit", "--no-verify");
  return git(cwd, "rev-parse", "HEAD");
}
