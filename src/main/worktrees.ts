import type { WorktreeCleanupMode, WorktreeEntry } from "../shared/types";
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

/**
 * Every `<repo>-worktrees/<name>` checkout beside the given repos, with enough
 * state to decide whether it is a stray: branch, dirt, ahead/behind, age, and
 * whether a live session currently runs in it. A folder that is not a readable
 * git worktree is reported with `error` rather than skipped.
 */
export function listWorktrees(repos: { name: string; path: string }[], liveCwds: string[]): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  const live = new Set(liveCwds);
  for (const repo of repos) {
    const wtRoot = path.join(path.dirname(repo.path), `${path.basename(repo.path)}-worktrees`);
    let names: string[];
    try {
      names = fs.readdirSync(wtRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue; // no worktrees folder for this repo
    }
    for (const name of names) {
      const wtPath = path.join(wtRoot, name);
      let ageDays = 0;
      try {
        ageDays = Math.floor((Date.now() - fs.statSync(wtPath).mtimeMs) / 86_400_000);
      } catch {
        /* keep 0 */
      }
      const base = { repoPath: repo.path, repoName: repo.name, path: wtPath, name, ageDays, inUse: live.has(wtPath) };
      try {
        const st = worktreeState(wtPath);
        out.push({ ...base, branch: st.branch, dirty: st.dirty, dirtyFiles: st.dirtyFiles, ahead: st.ahead, behind: st.behind });
      } catch (err) {
        out.push({ ...base, branch: "", dirty: false, dirtyFiles: 0, ahead: 0, behind: 0, error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      }
    }
  }
  return out.sort((a, b) => a.repoName.localeCompare(b.repoName) || b.ageDays - a.ageDays);
}

/** Remove a worktree folder (the branch is kept). */
export function removeWorktree(repoPath: string, wtPath: string): void {
  git(repoPath, ["worktree", "remove", "--force", wtPath]);
  git(repoPath, ["worktree", "prune"]);
}

/**
 * Check a branch out in the repo checkout itself (no worktree), so VS Code
 * debug/launch configs on the repo just work. Refuses loudly when the checkout
 * cannot safely switch: uncommitted changes, or another live session already
 * on a different branch there (a checkout has one branch at a time — that is
 * the one thing worktrees exist to solve).
 *  - branch exists locally → switch to it
 *  - branch exists on origin only → fetch and track it
 *  - new branch → fetch origin/<base> (dev/uat) and branch off it; falls back
 *    to the local base if the fetch fails
 */
export function checkoutBranch(repoPath: string, branch: string, baseBranch?: string, occupiedBy?: string): void {
  if (occupiedBy) {
    throw new Error(
      `${path.basename(repoPath)} is already checked out on ${occupiedBy} by a running session. ` +
        `Close that session, or tick "isolated worktree" to work on both at once.`
    );
  }
  const current = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current === branch) return;
  const dirty = git(repoPath, ["status", "--porcelain"]);
  if (dirty) {
    const n = dirty.split("\n").length;
    throw new Error(
      `${path.basename(repoPath)} has ${n} uncommitted change${n === 1 ? "" : "s"} on ${current}. ` +
        `Commit or stash before switching to ${branch}, or tick "isolated worktree".`
    );
  }
  const hasLocal = git(repoPath, ["branch", "--list", branch]).length > 0;
  const hasRemote = git(repoPath, ["branch", "-r", "--list", `origin/${branch}`]).length > 0;
  if (hasLocal) {
    git(repoPath, ["switch", branch]);
  } else if (hasRemote) {
    git(repoPath, ["fetch", "origin", branch]);
    git(repoPath, ["switch", "--track", "-c", branch, `origin/${branch}`]);
  } else if (baseBranch) {
    let base = `origin/${baseBranch}`;
    try {
      git(repoPath, ["fetch", "origin", baseBranch]);
    } catch (err) {
      if (git(repoPath, ["branch", "--list", baseBranch]).length === 0) throw err;
      console.error(`[worktrees] fetch origin/${baseBranch} failed, branching off local ${baseBranch}:`, err);
      base = baseBranch;
    }
    git(repoPath, ["switch", "-c", branch, base]);
  } else {
    git(repoPath, ["switch", "-c", branch]);
  }
}
