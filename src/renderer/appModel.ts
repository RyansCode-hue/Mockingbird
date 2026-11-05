/**
 * The App's own rules that don't need React: how panes are numbered and named
 * in the grid, how group-keyed UI state follows a rename, and how the close
 * and broadcast flows read the main process's answers.
 */
import type { SessionInfo } from "../shared/types";
import { splitGroupKey, topOfKey } from "../shared/types";
import { readingOrder, renameWorkspaces, type LayoutNode } from "./layoutTree";

/** A session's display name: its ticket title when it has one. */
export const titleOf = (s: Pick<SessionInfo, "title" | "ticketTitle">): string => s.ticketTitle ?? s.title;

/** The session whose folder holds `path`: `prefer` when it does, else the first one that does. */
export function sessionHolding(sessions: SessionInfo[], path: string, prefer?: SessionInfo | null): SessionInfo | null {
  const inside = (s: SessionInfo) => path.startsWith(s.cwd + "/");
  return prefer && inside(prefer) ? prefer : sessions.find(inside) ?? null;
}

/**
 * A grid cell: a plain session renders alone; a workspace (sub-group) renders
 * as one pane with a tab per member. `key` is the workspace's group path
 * ("5038/backend").
 */
export type GridCell = { kind: "session"; s: SessionInfo } | { kind: "workspace"; key: string; sub: string; list: SessionInfo[] };

/** The session a cell shows: its own, or the workspace's front tab. */
export function frontOf(cell: GridCell, wsTabs: Record<string, string>): SessionInfo {
  return cell.kind === "session" ? cell.s : cell.list.find((s) => s.id === wsTabs[cell.key]) ?? cell.list[0];
}

/**
 * ⌘1–9 by pane, as the keys and the pane badges count: each number's session
 * is the one it brings up. `cells` come in reading order (inReadingOrder).
 */
export function paneShortcuts(cells: GridCell[], wsTabs: Record<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  cells.slice(0, 9).forEach((c, i) => out.set(frontOf(c, wsTabs).id, i + 1));
  return out;
}

/** How the layout and drops name the cell of session `id` in `group`: "ws:<top>/<sub>" inside a workspace, else the id. */
export function cellKeyFor(id: string, group: string | null | undefined): string {
  const { top, sub } = splitGroupKey(group ?? "ungrouped");
  return sub ? `ws:${top}/${sub}` : id;
}

/** A cell's key in the layout tree. */
export const cellKeyOf = (c: GridCell): string => (c.kind === "session" ? c.s.id : `ws:${c.key}`);

/** Cells as the user reads the grid, top-left first, so pane numbers match what's on screen. */
export function inReadingOrder(cells: GridCell[], tree: LayoutNode | null): GridCell[] {
  const order = readingOrder(tree);
  const rank = (c: GridCell) => {
    const i = order.indexOf(cellKeyOf(c));
    return i < 0 ? order.length : i;
  };
  return cells.map((c, i) => [c, rank(c), i] as const).sort((x, y) => x[1] - y[1] || x[2] - y[2]).map(([c]) => c);
}

const renamed = (key: string, oldKey: string, newKey: string): string | null =>
  key === oldKey || key.startsWith(oldKey + "/") ? newKey + key.slice(oldKey.length) : null;

/** A record keyed by group path, with `oldKey` and everything under it moved to `newKey`. */
export function remapGroupKeys<T>(rec: Record<string, T>, oldKey: string, newKey: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) out[renamed(k, oldKey, newKey) ?? k] = v;
  return out;
}

/**
 * Layout trees across a rename: the groups they belong to, and the workspace
 * panes ("ws:<path>") in them. A tree already saved under the new name — the
 * copy made before the rename, so the grid kept its layout while the new
 * session list arrived — stays, and the old one goes.
 */
export function remapTrees(trees: Record<string, LayoutNode>, oldKey: string, newKey: string): Record<string, LayoutNode> {
  const out: Record<string, LayoutNode> = {};
  for (const [k, v] of Object.entries(trees)) {
    const to = renamed(k, oldKey, newKey);
    if (to !== null && to in trees) continue;
    out[to ?? k] = renameWorkspaces(v, oldKey, newKey);
  }
  return out;
}

/**
 * Reading a worktree's state failed because its folder is gone (git can't even
 * change into it). Any other failure — a held index.lock, a timeout — says
 * nothing about the work in it, so it must not be treated as nothing to lose.
 */
export function worktreeGone(error: string): boolean {
  return /cannot change to .*No such file or directory/i.test(error);
}

/**
 * Whether a broadcast can reach a session, as SessionManager.broadcast decides
 * it: shells (it would run as commands), debriefs (mid-interview) and dead panes
 * never get one. When the rest get it is main's to say: its reply names each
 * session's outcome.
 */
export function reachesBroadcast(s: Pick<SessionInfo, "status" | "shell" | "debrief">): boolean {
  return !(s.status === "dead" || s.shell || s.debrief);
}

/** A row of the Sessions outline: a top-level group with this Mac's sessions in it (`shared` when it's a team room's), or the one line standing for the team rooms. */
export type OutlineGroup<T> = { kind: "group"; key: string; list: T[]; shared: boolean };
export type OutlineEntry<T> = OutlineGroup<T> | { kind: "connected" };

/**
 * The Sessions outline's top-level rows: the groups holding this Mac's own
 * sessions, a team room's group included, in first-appearance order; then
 * one "connected" line when there are team rooms. Teammates' sessions
 * (`room.remote`) aren't listed here: they live in the Team view, with each
 * room's whole group, which the line opens. While `filtering`, only groups
 * with a matching session show, and the line only when a room's session
 * matches.
 */
export function sessionOutline<T extends Pick<SessionInfo, "taskGroup" | "room">>(visible: readonly T[], roomGroups: readonly string[], filtering: boolean): OutlineEntry<T>[] {
  const rooms = new Set(roomGroups);
  const byKey = new Map<string, T[]>();
  let inRooms = 0;
  for (const s of visible) {
    const key = topOfKey(s.taskGroup ?? "ungrouped");
    if (rooms.has(key)) inRooms++;
    if (!s.room?.remote) byKey.set(key, [...(byKey.get(key) ?? []), s]);
  }
  const own = [...byKey].map(([key, list]): OutlineGroup<T> => ({ kind: "group", key, list, shared: rooms.has(key) }));
  return rooms.size && (!filtering || inRooms) ? [...own, { kind: "connected" }] : own;
}

/** The groups New Session and the move dialog offer: every session's group and every joined room's, once each. */
export function groupChoices(sessions: readonly Pick<SessionInfo, "taskGroup">[], roomGroups: readonly string[]): string[] {
  const keys = [...sessions.map((s) => s.taskGroup), ...roomGroups];
  return [...new Set(keys.filter((g): g is string => !!g && g !== "assistant"))];
}

/**
 * The next of several sessions queued to close together (`queue`, ids in order), as it is now in `sessions`: those
 * closed meanwhile are dropped, never closed from a stale copy. `next` is null once none of them is left.
 */
export function nextToClose(queue: readonly string[], sessions: readonly SessionInfo[]): { next: SessionInfo | null; rest: string[] } {
  for (let i = 0; i < queue.length; i++) {
    const s = sessions.find((x) => x.id === queue[i]);
    if (s) return { next: s, rest: queue.slice(i + 1) };
  }
  return { next: null, rest: [] };
}

/**
 * The close queue's next step: none while one of it is being closed or a close dialog is open (a queued close waits
 * for it, never replacing it), nor with nothing queued; else the next of `queue` as it is now (nextToClose), with the
 * ids it takes off the queue (those closed meanwhile, and it).
 */
export function closeStep(queue: readonly string[], sessions: readonly SessionInfo[], busy: { closing: boolean; dialog: boolean }): { next: SessionInfo | null; taken: string[] } | null {
  if (busy.closing || busy.dialog || !queue.length) return null;
  const { next, rest } = nextToClose(queue, sessions);
  return { next, taken: queue.slice(0, queue.length - rest.length) };
}

/**
 * Session `id`'s close, needing its dialog while `open` is the session whose close dialog is open (null: none): null
 * to ask now, or the queue with `id` first, to be asked once that one's answered. One dialog never replaces another's.
 */
export function closeWaits(open: string | null, id: string, queue: readonly string[]): string[] | null {
  return !open || open === id ? null : [id, ...queue.filter((x) => x !== id)];
}

/**
 * Sessions `ids` queued to close after those already waiting in `queue`: each once, and never `closing`, the one
 * being closed now (its own dialog asks about it), so a second Close… on several never drops the first's rest.
 */
export function queueClose(queue: readonly string[], ids: readonly string[], closing: string | null): string[] {
  const out = [...queue];
  for (const id of ids) if (id !== closing && !out.includes(id)) out.push(id);
  return out;
}
