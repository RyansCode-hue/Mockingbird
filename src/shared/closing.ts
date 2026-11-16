/**
 * What closing a session can lose, as Close session asks it (the window's close dialog) and main says it
 * (sessionGuards.ts closeWarnings, an Assistant card's warnings). One set of rules for both.
 */
import type { SessionInfo, WorktreeStateInfo } from "./types";

/** Whether session `s` runs in a worktree of its own, which Close session offers to clean up: not its repository's checkout, nor a folder outside one. */
export const ownWorktree = (s: Pick<SessionInfo, "repoPath" | "branch" | "cwd">): boolean => !!(s.repoPath && s.branch && s.cwd !== s.repoPath);

/**
 * Reading a worktree's state failed because its folder is gone (git can't even
 * change into it). Any other failure — a held index.lock, a timeout — says
 * nothing about the work in it, so it must not be treated as nothing to lose.
 */
export function worktreeGone(error: string): boolean {
  return /cannot change to .*No such file or directory/i.test(error);
}

/** Whether a worktree in state `st` holds work a close could lose: uncommitted changes, or commits not pushed. */
export const closeAsks = (st: Pick<WorktreeStateInfo, "dirty" | "ahead">): boolean => st.dirty || st.ahead > 0;

/** What closing a session now can lose or interrupt. */
export interface CloseWarnings {
  /** Files with uncommitted changes in its own worktree. */
  uncommitted: number;
  /** Commits in its own worktree that its upstream doesn't have. */
  unpushed: number;
  /** It's working or waiting on you: closing stops that. */
  busy: boolean;
  /** Its worktree's state couldn't be read (not because it's gone): why. Its work may be at stake. */
  unread: string | null;
}

/** CloseWarnings as a card's lines, one per thing to know; none when nothing's at stake. */
export function closeWarningLines(w: CloseWarnings): string[] {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  return [
    ...(w.uncommitted ? [`${n(w.uncommitted, "file has", "files have")} uncommitted changes`] : []),
    ...(w.unpushed ? [`${n(w.unpushed, "commit isn't", "commits aren't")} pushed`] : []),
    ...(w.busy ? ["It's mid-turn: closing stops it"] : []),
    ...(w.unread ? [`Its worktree's changes couldn't be read (${w.unread}), so it may hold work`] : []),
  ];
}
