import { currentBranch, git } from "./git";
import { baseRef } from "./files";
import { mainCheckout } from "./runProfile";
import type { FileOverlap } from "../shared/types";

/** A worktree's changes: what its branch changed since the base, plus what isn't committed yet. */
export interface WorktreeChanges {
  sessionId: string;
  title: string;
  branch: string | null;
  repo: string;
  cwd: string;
  files: string[];
}

/** Paths a worktree has changed relative to its repository's base branch (repo-relative). */
export async function changedFiles(cwd: string): Promise<{ repo: string; branch: string | null; files: string[] }> {
  const repo = await mainCheckout(cwd);
  const branch = await currentBranch(cwd);
  const files = new Set<string>();
  const status = await git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"], { trim: false });
  const parts = status.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    files.add(p.slice(3));
    if (p[0] === "R" || p[0] === "C") i++; // a rename's next entry is its old name
  }
  const base = await baseRef(cwd);
  if (base) {
    const onBranch = await git(cwd, ["diff", "--name-only", "-z", `${base}...HEAD`], { trim: false });
    for (const f of onBranch.split("\0")) if (f) files.add(f);
  }
  return { repo, branch, files: [...files].sort() };
}

/**
 * Which sessions' worktrees of the same repository have changed the same
 * files. Sessions sharing one folder aren't compared: they're on the same
 * branch, so they can't conflict with each other.
 */
export function overlaps(list: WorktreeChanges[]): Record<string, FileOverlap[]> {
  const out: Record<string, FileOverlap[]> = {};
  for (const a of list) {
    for (const b of list) {
      if (a === b || a.repo !== b.repo || a.cwd === b.cwd) continue;
      const theirs = new Set(b.files);
      const both = a.files.filter((f) => theirs.has(f));
      if (!both.length) continue;
      (out[a.sessionId] ??= []).push({ other: b.sessionId, otherTitle: b.title, otherBranch: b.branch, files: both });
    }
  }
  return out;
}
