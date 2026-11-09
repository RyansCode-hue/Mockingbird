/**
 * The App's own rules that don't need React: how sessions are named and
 * grouped, and how the close and broadcast flows read the main process's
 * answers.
 */
import type { SessionInfo } from "../shared/types";
import { topOfKey } from "../shared/types";

/** A session's display name: its ticket title when it has one. */
export const titleOf = (s: Pick<SessionInfo, "title" | "ticketTitle">): string => s.ticketTitle ?? s.title;

/** The session whose folder holds `path`: `prefer` when it does, else the first one that does. */
export function sessionHolding(sessions: SessionInfo[], path: string, prefer?: SessionInfo | null): SessionInfo | null {
  const inside = (s: SessionInfo) => path.startsWith(s.cwd + "/");
  return prefer && inside(prefer) ? prefer : sessions.find(inside) ?? null;
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

/** A row of the sessions outline: a top-level group with this Mac's sessions in it (`shared` when it's a team room's), or the one line standing for the team rooms. */
export type OutlineGroup<T> = { kind: "group"; key: string; list: T[]; shared: boolean };
export type OutlineEntry<T> = OutlineGroup<T> | { kind: "connected" };

/**
 * The sessions outline's top-level rows: the groups holding this Mac's own
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
