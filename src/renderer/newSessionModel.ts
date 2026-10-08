import { splitGroupKey, topOfKey, type RepoEntry, type SessionInfo } from "../shared/types";
import type { TeamRoomSummary } from "../shared/team/types";

/**
 * The New session dialog's choices that don't need React: where a session
 * goes (a local group, or a team room's shared group — a connected session)
 * and which repos to offer first.
 */

/** Where a seeded group key ("5101" or "5101/api") starts the dialog: a team room's group is a connected session. */
export function seedWhere(initialGroup: string | undefined, rooms: readonly TeamRoomSummary[]): { connected: boolean; top: string; sub: string } {
  if (!initialGroup) return { connected: false, top: "", sub: "" };
  const { top, sub } = splitGroupKey(initialGroup);
  return { connected: rooms.some((r) => r.groupKey === top), top, sub: sub ?? "" };
}

/** Top-level groups a local session can join: every existing one but the team rooms', which are connected. */
export function localTops(existingGroups: readonly string[], rooms: readonly TeamRoomSummary[]): string[] {
  const roomKeys = new Set(rooms.map((r) => r.groupKey));
  return [...new Set(existingGroups.map(topOfKey))].filter((t) => !roomKeys.has(t));
}

/** The workspaces under a top-level group. */
export function workspacesOf(existingGroups: readonly string[], top: string): string[] {
  return [...new Set(existingGroups.filter((g) => g.startsWith(`${top}/`)).map((g) => splitGroupKey(g).sub).filter((s): s is string => !!s))];
}

/**
 * The repos each team room's sessions work in, by folder name — this Mac's
 * own sessions and teammates' alike — so the dialog can offer them first.
 */
export function roomRepoNames(sessions: readonly SessionInfo[], rooms: readonly TeamRoomSummary[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of rooms) out[r.groupKey] = [];
  for (const s of sessions) {
    const names = s.taskGroup ? out[topOfKey(s.taskGroup)] : undefined;
    const name = s.room?.repoName ?? (s.repoPath ? s.repoPath.split("/").filter(Boolean).pop() : undefined);
    if (names && name && !names.includes(name)) names.push(name);
  }
  return out;
}

/** The repos matching a search, the room's own (`suggested`, by folder name) first, at most `limit`. */
export function repoChoices(repos: readonly RepoEntry[], query: string, suggested: readonly string[], limit = 30): { repo: RepoEntry; suggested: boolean }[] {
  const q = query.trim().toLowerCase();
  const matching = repos.filter((r) => r.name.toLowerCase().includes(q));
  const first = matching.filter((r) => suggested.includes(r.name));
  const rest = matching.filter((r) => !suggested.includes(r.name));
  return [...first.map((repo) => ({ repo, suggested: true })), ...rest.map((repo) => ({ repo, suggested: false }))].slice(0, limit);
}

/**
 * The repo a conversation's folder belongs to: the repo itself or a folder in
 * it, or a Mockingbird worktree (<parent>/worktrees/<repo>/<branch>, named
 * `worktree`) of a repo by that folder name; null when it's in neither.
 */
export function repoOfFolder(repos: readonly RepoEntry[], cwd: string): { repo: RepoEntry; worktree: string | null } | null {
  const inside = repos.filter((r) => cwd === r.path || cwd.startsWith(`${r.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  if (inside) return { repo: inside, worktree: null };
  const m = /\/worktrees\/([^/]+)\/([^/]+)/.exec(cwd);
  const repo = m ? repos.find((r) => r.name === m[1]) : undefined;
  return repo && m ? { repo, worktree: m[2] } : null;
}
