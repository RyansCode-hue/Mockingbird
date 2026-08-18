import type { WorktreeCleanupMode } from "../shared/types";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Create a worktree for a session. Returns the worktree path.
 *  - branch exists locally → check it out in the worktree
 *  - branch exists on origin only → fetch it and track it
 *  - new branch + baseBranch → fetch origin/<base> first and branch off it
 *    (falls back to the local base if the fetch fails, e.g. offline)
 *  - new branch, no base → branch off the repo's current HEAD (legacy behavior)
 */
export function createWorktree(repoPath: string, branch: string, baseBranch?: string): string {
  const parent = path.dirname(repoPath);
  const wtRoot = path.join(parent, `${path.basename(repoPath)}-worktrees`);
  fs.mkdirSync(wtRoot, { recursive: true });
  const wtPath = path.join(wtRoot, branch);
  if (fs.existsSync(wtPath)) return wtPath; // reuse (multiple sessions per task)

  const hasLocal = git(repoPath, ["branch", "--list", branch]).length > 0;
  const hasRemote = git(repoPath, ["branch", "-r", "--list", `origin/${branch}`]).length > 0;

  if (hasLocal) {
    git(repoPath, ["worktree", "add", wtPath, branch]);
  } else if (hasRemote) {
    git(repoPath, ["fetch", "origin", branch]);
    git(repoPath, ["worktree", "add", "--track", "-b", branch, wtPath, `origin/${branch}`]);
  } else if (baseBranch) {
    let base = `origin/${baseBranch}`;
    try {
      git(repoPath, ["fetch", "origin", baseBranch]); // freshest dev/uat
    } catch (err) {
      // offline or no origin — fall back to the local base branch, loudly
      if (git(repoPath, ["branch", "--list", baseBranch]).length === 0) throw err;
      console.error(`[worktrees] fetch origin/${baseBranch} failed, branching off local ${baseBranch}:`, err);
      base = baseBranch;
    }
    git(repoPath, ["worktree", "add", "-b", branch, wtPath, base]);
  } else {
    git(repoPath, ["worktree", "add", "-b", branch, wtPath]);
  }
  return wtPath;
}

/** Local + origin branches for a repo, with a best-guess dev/uat base branch. */
export function listBranches(repoPath: string): { branches: string[]; defaultBase: string | null } {
  const locals = git(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    .split("\n")
    .filter(Boolean);
  const remotes = git(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"])
    .split("\n")
    .filter(Boolean)
    .map((b) => b.replace(/^origin\//, ""))
    .filter((b) => b !== "HEAD");
  const branches = [...new Set([...remotes, ...locals])].sort();
  const preferred = ["dev", "develop", "development", "uat", "main", "master"];
  const defaultBase = preferred.find((b) => branches.includes(b)) ?? null;
  return { branches, defaultBase };
}

export interface WorktreeState {
  dirty: boolean;
  dirtyFiles: number;
  branch: string;
  ahead: number;
  behind: number;
}

export function worktreeState(wtPath: string): WorktreeState {
  const porcelain = git(wtPath, ["status", "--porcelain"]);
  const dirtyFiles = porcelain ? porcelain.split("\n").length : 0;
  const branch = git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let ahead = 0;
  let behind = 0;
  try {
    ahead = parseInt(git(wtPath, ["rev-list", "--count", "@{upstream}..HEAD"]), 10) || 0;
    behind = parseInt(git(wtPath, ["rev-list", "--count", "HEAD..@{upstream}"]), 10) || 0;
  } catch {
    /* no upstream */
  }
  return { dirty: dirtyFiles > 0, dirtyFiles, branch, ahead, behind };
}

/**
 * Close-session worktree cleanup (design 1e).
 *  - keep:    leave the worktree untouched
 *  - push:    commit WIP if dirty, push the branch, then remove the worktree
 *  - discard: remove the worktree and delete its branch — not recoverable
 */
export function cleanupWorktree(
  repoPath: string,
  wtPath: string,
  mode: WorktreeCleanupMode
): { removed: boolean } {
  if (mode === "keep") return { removed: false };

  const st = worktreeState(wtPath);
  if (mode === "push") {
    if (st.dirty) {
      git(wtPath, ["add", "-A"]);
      git(wtPath, ["commit", "--no-verify", "-m", `WIP: ${st.branch} (closed from Mockingbird)`]);
    }
    git(wtPath, ["push", "-u", "origin", "HEAD"]);
    git(repoPath, ["worktree", "remove", "--force", wtPath]);
    return { removed: true };
  }

  // discard
  git(repoPath, ["worktree", "remove", "--force", wtPath]);
  try {
    git(repoPath, ["branch", "-D", st.branch]);
  } catch {
    /* branch may be checked out elsewhere or already gone */
  }
  return { removed: true };
}
