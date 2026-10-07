import type { SessionInfo } from "../../shared/types";
import type { LivePanesState, MemberView } from "../../shared/team/livePanes";

/**
 * Team rooms in the window, stage 2 (live panes): the plain logic behind
 * RoomLive.tsx, kept apart so it can be tested without a DOM.
 */

/** This window's sessions with teammates' room sessions added, and its own room sessions tagged. */
export function mergeRoomSessions(own: SessionInfo[], state: LivePanesState | null): SessionInfo[] {
  if (!state) return own;
  const tagged = own.map((s) => (state.own[s.id] ? { ...s, room: state.own[s.id] } : s));
  const ids = new Set(own.map((s) => s.id));
  return [...tagged, ...state.remote.filter((r) => !ids.has(r.id))];
}

/** What following a teammate puts on screen: their shown room sessions in one group, and the one they're in. */
export interface FollowPlan {
  group: string;
  ids: string[];
  focused: string | null;
}

/**
 * The grid shows one top-level group at a time, so following shows the
 * group of the pane the teammate is in (else of the first they show), with
 * the panes of theirs that are in it. Null when they show no room session
 * this window knows.
 */
export function followPlan(view: MemberView | undefined, sessions: SessionInfo[], groupOf: (s: SessionInfo) => string): FollowPlan | null {
  if (!view) return null;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const shown = view.shown.filter((id) => byId.has(id));
  const focused = view.focused && byId.has(view.focused) ? view.focused : null;
  const anchor = focused ?? shown[0];
  if (!anchor) return null;
  const group = groupOf(byId.get(anchor)!);
  const ids = shown.filter((id) => groupOf(byId.get(id)!) === group);
  if (focused && !ids.includes(focused)) ids.push(focused);
  return { group, ids, focused };
}

export const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
