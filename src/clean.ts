import { readdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveComponents } from "./components.js";
import type { FlowConfig } from "./config.js";
import { git } from "./tools/git.js";
import { flowPaths } from "./workflow.js";

export interface CleanResult {
  removedWorktrees: string[];
  deletedBranches: string[];
}

/**
 * Removes everything a ticket's runs left in git: the integration worktree and
 * branch `hector/<ID>` and every task worktree and branch `hector-tasks/<ID>/*`,
 * in every repository of every component. Run logs and lessons are kept.
 *
 * Use it before re-running a ticket, or after you have merged its branches.
 * Unmerged work on those branches is lost, so push or merge first if you need it.
 */
export async function cleanTicket(opts: { repo: string; ticketId: string; config: FlowConfig }): Promise<CleanResult> {
  const primaryRoot = await git(resolve(opts.repo), "rev-parse", "--show-toplevel");
  const components = await resolveComponents(primaryRoot, opts.config);
  const result: CleanResult = { removedWorktrees: [], deletedBranches: [] };
  const integration = `refs/heads/hector/${opts.ticketId}`;
  const taskPrefix = `refs/heads/hector-tasks/${opts.ticketId}/`;

  for (const root of new Set(components.map((c) => c.repoRoot))) {
    // Worktrees first: a branch checked out in a worktree cannot be deleted.
    const porcelain = await git(root, "worktree", "list", "--porcelain");
    for (const block of porcelain.split("\n\n")) {
      const path = block.match(/^worktree (.+)$/m)?.[1];
      const branch = block.match(/^branch (.+)$/m)?.[1];
      if (path && branch && (branch === integration || branch.startsWith(taskPrefix))) {
        await git(root, "worktree", "remove", "--force", path);
        result.removedWorktrees.push(path);
      }
    }
    await git(root, "worktree", "prune");

    const branches = await git(root, "for-each-ref", "--format=%(refname)", integration, `${taskPrefix}*`);
    for (const ref of branches.split("\n").filter(Boolean)) {
      const name = ref.replace(/^refs\/heads\//, "");
      await git(root, "branch", "-D", name);
      result.deletedBranches.push(`${components.find((c) => c.repoRoot === root)!.repoName}:${name}`);
    }
  }

  // Remove the ticket's workspace folder if nothing is left in it.
  const ticketDir = join(flowPaths(primaryRoot, opts.config).root, opts.ticketId);
  await removeIfEmpty(join(ticketDir, "_tasks"));
  await removeIfEmpty(ticketDir);
  return result;
}

async function removeIfEmpty(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => null);
  if (entries === null) return;
  if (entries.length === 0) await rmdir(dir).catch(() => undefined);
  else if (entries.every((e) => e === ".DS_Store")) await rm(dir, { recursive: true, force: true });
}
