import { currentBranch } from "./git";
import { baseRef } from "./files";
import { guardedGit } from "./safeGit";
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
  const g = await guardedGit(cwd);
  const status = await g.status(["--porcelain", "-z", "--untracked-files=all"], { trim: false });
  const parts = status.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    files.add(p.slice(3));
    if (p[0] === "R" || p[0] === "C") i++; // a rename's next entry is its old name
  }
  const base = await baseRef(cwd);
  if (base) {
    const onBranch = await g.diff(["--name-only", "-z", `${base}...HEAD`], { trim: false });
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

/** A team room member's pushed branch, as fetched into a local clone, and the files it changes against its base. */
export interface TeammateChanges {
  /** The room of the teammate's session on the branch. */
  roomId: string;
  member: string;
  name: string;
  branch: string;
  /** The local clone's main checkout (as WorktreeChanges.repo). */
  repo: string;
  files: string[];
  /** Of `files`, those changed in uncommitted work (the session's newest snapshot shared peer to peer). */
  uncommitted?: string[];
  /** The teammate's session, when known (its snapshot or record): its title. */
  session?: string;
}

/** The `other` of a teammate's overlap: not a session here, so there's no pane to jump to. */
export const teammateOverlapId = (member: string, branch: string) => `team:${member}:${branch}`;

/**
 * Which sessions' worktrees change files a teammate's pushed branch also
 * changes ("Nick's branch also changes this"). A worktree on that same branch
 * is the teammate's work checked out here, not a clash.
 */
export function teammateOverlaps(list: WorktreeChanges[], teammates: TeammateChanges[]): Record<string, FileOverlap[]> {
  const out: Record<string, FileOverlap[]> = {};
  for (const a of list) {
    for (const t of teammates) {
      if (a.repo !== t.repo || a.branch === t.branch) continue;
      const theirs = new Set(t.files);
      const both = a.files.filter((f) => theirs.has(f));
      if (!both.length) continue;
      const uncommitted = both.filter((f) => t.uncommitted?.includes(f));
      (out[a.sessionId] ??= []).push({
        other: teammateOverlapId(t.member, t.branch),
        otherTitle: t.session ? `${t.name}'s session ${t.session}` : `${t.name}'s pushed branch`,
        otherBranch: t.branch,
        files: both,
        teammate: { id: t.member, name: t.name, roomId: t.roomId, ...(uncommitted.length ? { uncommitted } : {}) },
      });
    }
  }
  return out;
}

/** Overlaps from several checks, per session: this machine's worktrees first, so a click still jumps to a session here. */
export function mergeOverlaps(...maps: Record<string, FileOverlap[]>[]): Record<string, FileOverlap[]> {
  const out: Record<string, FileOverlap[]> = {};
  for (const m of maps) for (const [id, list] of Object.entries(m)) (out[id] ??= []).push(...list);
  return out;
}
