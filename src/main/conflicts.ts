import * as fs from "fs";
import * as path from "path";
import { currentBranch } from "./git";
import { baseRef } from "./files";
import { guardedGit } from "./safeGit";
import { mainCheckout } from "./runProfile";
import type { FileOverlap, OverlapReport } from "../shared/types";

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

/** What overlaps know of each live worktree's folder: its changed files, or why they couldn't be read. */
export interface WorktreeReads {
  changes: Map<string, { repo: string; branch: string | null; files: string[] }>;
  /** A folder whose changed files couldn't be read, and git's words for why. */
  unread: Map<string, string>;
}

/**
 * Reads each of `cwds` again that `stale` names or that has no changes read, and forgets folders no longer among them. A
 * folder that can't be read leaves `changes` for `unread`, so overlaps with it are unknown rather than none, and is read
 * again on the next pass. Its failure is logged when it starts or changes, not on every pass.
 */
export async function rereadWorktrees(
  cwds: readonly string[],
  reads: WorktreeReads,
  stale: Set<string>,
  log: (context: string, err: unknown) => void,
  read: (cwd: string) => Promise<{ repo: string; branch: string | null; files: string[] }> = changedFiles
): Promise<void> {
  for (const known of [reads.changes, reads.unread]) for (const cwd of [...known.keys()]) if (!cwds.includes(cwd)) known.delete(cwd);
  for (const cwd of cwds) {
    if (reads.changes.has(cwd) && !stale.has(cwd)) continue;
    stale.delete(cwd);
    try {
      reads.changes.set(cwd, await read(cwd));
      reads.unread.delete(cwd);
    } catch (err) {
      reads.changes.delete(cwd);
      const why = err instanceof Error ? err.message : String(err);
      if (reads.unread.get(cwd) !== why) log(`overlaps: ${cwd}'s changed files couldn't be read, so overlaps with it are unknown`, err);
      reads.unread.set(cwd, why);
    }
  }
}

/**
 * A folder as one key however it's spelled (a trailing slash, a symlink): its real path. One that can't be resolved
 * (gone, or unreadable) is compared as resolved: its own read reports why it failed, and nothing else rests on the key.
 */
function sameFolder(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** A live session overlaps are worked out for: its folder, and the repository it's a worktree of. */
export interface LiveWorktree {
  sessionId: string;
  title: string;
  repoPath: string;
  cwd: string;
}

/**
 * The window's overlaps from what `reads` holds: this Mac's worktrees against each other and against teammates'
 * branches, and for each session how many worktrees of its repository couldn't be read.
 */
export function overlapReport(live: readonly LiveWorktree[], reads: WorktreeReads, teammates: TeammateChanges[]): OverlapReport {
  const list: WorktreeChanges[] = live.flatMap((s) => {
    const c = reads.changes.get(s.cwd);
    return c ? [{ sessionId: s.sessionId, title: s.title, branch: c.branch, repo: c.repo, cwd: s.cwd, files: c.files }] : [];
  });
  const unread: Record<string, number> = {};
  const repo = new Map(live.map((s) => [s.sessionId, sameFolder(s.repoPath)]));
  for (const s of live) {
    const n = new Set(live.filter((o) => repo.get(o.sessionId) === repo.get(s.sessionId) && reads.unread.has(o.cwd)).map((o) => o.cwd)).size;
    if (n) unread[s.sessionId] = n;
  }
  return { bySession: mergeOverlaps(overlaps(list), teammateOverlaps(list, teammates)), unread };
}
