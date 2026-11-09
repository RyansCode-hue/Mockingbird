import { isErr, type SessionInfo } from "../../shared/types";
import { settled } from "../settled";
import type { LivePanesState, MemberView } from "../../shared/team/livePanes";
import type { MemberId } from "../../shared/team/types";

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

/**
 * Following as one room offers it (its group's bar, its area's header and menu): only its members to follow, and the
 * one followed only when they're one of them. Outside a room, no one.
 */
export function followIn<F extends { leader: { id: MemberId } | null; candidates: readonly { member: MemberId }[] }>(follow: F, room: { members: readonly { id: MemberId }[] } | null | undefined): F {
  const member = (id: MemberId) => !!room?.members.some((m) => m.id === id);
  return { ...follow, leader: follow.leader && member(follow.leader.id) ? follow.leader : null, candidates: follow.candidates.filter((v) => member(v.member)) };
}

/** What following a teammate puts on screen: their shown room sessions in one group, and the one they're in. */
export interface FollowPlan {
  group: string;
  ids: string[];
  focused: string | null;
}

/**
 * What following brings into view: the group of the session the teammate is
 * in (else of the first they show), with the sessions of theirs that are in
 * it. Null when they show no room session this window knows.
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

/**
 * Tell the main process what this window shows (teamLiveView), which decides which teammates' sessions stream here
 * and what teammates see you watching: why it couldn't be told, logged with what was being told, or null.
 */
export async function tellLiveView(send: () => unknown, view: { shown: readonly string[]; focused: string | null }): Promise<string | null> {
  const r = await settled(send());
  if (!isErr(r)) return null;
  console.error(`[mockingbird] team rooms: couldn't say what's on screen here (${view.shown.length} sessions, focused ${view.focused ?? "none"}):`, r.error);
  return r.error;
}
