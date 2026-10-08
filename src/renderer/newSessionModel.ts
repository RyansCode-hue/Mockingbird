import { isShareableGroup, sanitizeSegment, splitGroupKey, topOfKey, type RepoEntry, type SessionInfo } from "../shared/types";
import type { TeamRoomSummary } from "../shared/team/types";

/**
 * The New session dialog's choices that don't need React: where a session
 * goes (a local group, a team room's shared group — a connected session — or
 * a new room) and which repos to offer first.
 */

/** A team room + New room makes: the group it shares and the room's name. */
export interface NewRoom {
  key: string;
  title: string;
}

/**
 * The group a new room shares, and the room's name, from the name typed for
 * it. A leading ticket number keys the group by the ticket, as a ticket's
 * sessions are grouped, and names the room as the sidebar titles that group:
 * "5120 Donor search" → group 5120, room "#5120 Donor search". Any other name
 * is both the group's and the room's ("Spike"). A number run into a word
 * ("2026-planning") isn't a ticket. Null when nothing is typed.
 */
export function newRoomOf(name: string): NewRoom | null {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n) return null;
  const ticket = /^#?(\d+)(?:\s*[:·–—]\s*|\s+-\s+|\s+|$)/.exec(n);
  if (ticket) {
    const rest = n.slice(ticket[0].length);
    return { key: ticket[1], title: rest ? `#${ticket[1]} ${rest}` : `#${ticket[1]}` };
  }
  const key = sanitizeSegment(n);
  return { key, title: key };
}

/** What Start does with the name typed for + New room. */
export type NewRoomPlan =
  | { kind: "unnamed" }
  /** The sidebar's ungrouped or assistant bucket: never shared. */
  | { kind: "reserved"; key: string }
  /** The group is a room already: the session starts there rather than in a second one. */
  | { kind: "existing"; key: string; room: TeamRoomSummary }
  /** A new room; sharing a group this Mac already has (`localGroup`) puts its sessions in the room too. */
  | ({ kind: "create"; localGroup: boolean } & NewRoom);

export function newRoomPlan(name: string, rooms: readonly TeamRoomSummary[], existingGroups: readonly string[]): NewRoomPlan {
  const nr = newRoomOf(name);
  if (!nr) return { kind: "unnamed" };
  if (!isShareableGroup(nr.key)) return { kind: "reserved", key: nr.key };
  const room = rooms.find((r) => r.groupKey === nr.key);
  if (room) return { kind: "existing", key: nr.key, room };
  return { kind: "create", ...nr, localGroup: localTops(existingGroups, rooms).includes(nr.key) };
}

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
