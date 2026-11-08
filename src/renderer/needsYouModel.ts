import type { SessionInfo } from "../shared/types";
import type { JoinRequestSummary, TeamRoomSummary } from "../shared/team/types";
import { permissionTool, shortReason } from "../shared/phoneAlerts";
import { takenOverWhy, type Can } from "./workspaceActions";

/**
 * The Needs you tray (docs/landscape.md, Finding what needs you): what's waiting on you, as items. Phase 1 has three
 * kinds: a session waiting on you (amber: a permission prompt, or a question it asked), a room's join request this
 * install answers as the admin, and a session whose turn ended and that has been idle since. Everything here is
 * worked out from what the window already has (sessions, the team status), so the tray, the badges and N agree.
 */

export type NeedsKind = "permission" | "question" | "join" | "finished";

export interface NeedsItem {
  /** The same while it's the same thing waiting: "s:<session id>", or "join:<room>:<member>:<asked at>". */
  id: string;
  /** Its state: a Dismiss holds until this changes. */
  sig: string;
  kind: NeedsKind;
  /** Since when it has waited. */
  at: number;
  /** The area its badge counts toward: the workspace's (LOOSE_GROUP for one in none), or the room's. */
  area: string;
  /** A workspace's item: its session. */
  session: string | null;
  /** A join request's item: its room, and the request as the admin's prompt keys it. */
  join: { roomId: string; key: string } | null;
  /** What it says: "API: last org per user wants to use Bash". */
  text: string;
  /** The code-like part of `text` to set apart (the tool), or null. */
  code: string | null;
}

/** Its kind as the tray's line says it, before the area. */
export const KIND_LABEL: Record<NeedsKind, string> = { permission: "Permission", question: "Waiting", join: "Join request", finished: "Finished" };

/**
 * Which kinds come first: what holds an agent or a person up (a prompt, a question, someone at the room's door)
 * before what's only done; newest first within a kind.
 */
const RANK: Record<NeedsKind, number> = { permission: 0, question: 0, join: 1, finished: 2 };

/** A join request's key, as the admin's prompt (main.tsx's joinKey) and Later name it. */
export const joinKeyOf = (r: Pick<JoinRequestSummary, "roomId" | "id" | "at">): string => `${r.roomId}:${r.id}:${r.at}`;

/**
 * Why session `s` has no item even when its status would give it one, or null: it's a teammate's (it waits on
 * them, as the area's counts say), a teammate took it over (its prompts and turns go on on their laptop), or it's a
 * morning brief or wrap-up, which lives on the WorkTracker tab, not the landscape.
 */
export function notMine(s: SessionInfo): string | null {
  if (s.room?.remote) return `${s.room.ownerName}'s session: it waits on them`;
  const taken = takenOverWhy(s, "to answer it here");
  if (taken) return taken;
  if (s.debrief) return "A morning brief or wrap-up: it's on the WorkTracker tab";
  return null;
}

/** A session's item, or null when it has none: waiting on you, or idle since its turn ended (`finishedAt`). */
export function sessionItem(s: SessionInfo, area: string, title: string): NeedsItem | null {
  if (notMine(s)) return null;
  if (s.status === "waiting") {
    const tool = permissionTool(s.waitingReason);
    return {
      id: `s:${s.id}`,
      sig: `s:${s.id}|w|${s.waitingSince ?? ""}|${s.waitingReason ?? ""}`,
      kind: tool ? "permission" : "question",
      at: s.waitingSince ?? s.createdAt,
      area,
      session: s.id,
      join: null,
      text: tool ? `${title} wants to use ${tool}` : `${title}: ${shortReason(s.waitingReason)}`,
      code: tool,
    };
  }
  if (s.status === "idle" && s.finishedAt) {
    return { id: `s:${s.id}`, sig: `s:${s.id}|f|${s.finishedAt}`, kind: "finished", at: s.finishedAt, area, session: s.id, join: null, text: `${title} is done and idle`, code: null };
  }
  return null;
}

/** A join request's item: someone asking to join a room this install answers for. */
export function joinItem(request: JoinRequestSummary, room: TeamRoomSummary): NeedsItem {
  const key = joinKeyOf(request);
  return {
    id: `join:${key}`,
    sig: `join:${key}|${request.state}`,
    kind: "join",
    at: request.at,
    area: room.groupKey,
    session: null,
    join: { roomId: room.id, key },
    text: `${request.name} wants to join ${room.name}`,
    code: null,
  };
}

/**
 * Everything that needs you, in the tray's order (and N's): sessions waiting on you, then join requests, then
 * finished sessions, newest first within each. `asks` are the requests this install answers as a room's admin
 * (JoinRequests.tsx's adminRequests: the admin's prompt and Members ▾ read the same list); `areaOf` is the area a
 * session's workspace is in on the landscape.
 */
export function needsItems(sessions: readonly SessionInfo[], asks: readonly { request: JoinRequestSummary; room: TeamRoomSummary }[], areaOf: (s: SessionInfo) => string, titleOf: (s: SessionInfo) => string): NeedsItem[] {
  const out: NeedsItem[] = [];
  for (const s of sessions) {
    const item = sessionItem(s, areaOf(s), titleOf(s));
    if (item) out.push(item);
  }
  for (const a of asks) if (a.request.role === "admin" && a.request.state === "waiting") out.push(joinItem(a.request, a.room));
  return out.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.at - a.at || a.id.localeCompare(b.id));
}

/** A Dismiss: the item's state when it was dismissed, and when, so the list can be kept short. */
export interface Dismissed {
  sig: string;
  at: number;
}

/** How long a dismissal is kept, and how many: a state that has changed never comes back, so old ones only take room. */
export const DISMISS_KEEP_MS = 3 * 24 * 3_600_000;
export const DISMISS_MAX = 200;

/** The items not dismissed in their current state: what the tray lists, the button and the badges count, and N visits. */
export const shownItems = (items: readonly NeedsItem[], dismissed: readonly Dismissed[]): NeedsItem[] => {
  const gone = new Set(dismissed.map((d) => d.sig));
  return items.filter((i) => !gone.has(i.sig));
};

/** `item` dismissed at `now`, keeping the list short (the newest DISMISS_MAX, none older than DISMISS_KEEP_MS). */
export function dismiss(list: readonly Dismissed[], item: NeedsItem, now: number): Dismissed[] {
  return [{ sig: item.sig, at: now }, ...list.filter((d) => d.sig !== item.sig && now - d.at < DISMISS_KEEP_MS)].slice(0, DISMISS_MAX);
}

/** Saved dismissals as read back: anything that isn't one is let go (a hand-edited or older shape), and said. */
export function dismissedFrom(v: unknown): Dismissed[] {
  if (!Array.isArray(v)) {
    if (v != null) console.warn("[mockingbird] the saved Needs you dismissals aren't a list; starting with none");
    return [];
  }
  const ok = v.filter((d): d is Dismissed => !!d && typeof d === "object" && typeof (d as Dismissed).sig === "string" && typeof (d as Dismissed).at === "number");
  if (ok.length !== v.length) console.warn(`[mockingbird] ${v.length - ok.length} saved Needs you dismissals weren't readable and were let go`);
  return ok;
}

/** How many shown items count toward each area: the area tree's, the switcher's and a collapsed area's badge. */
export function needsByArea(items: readonly NeedsItem[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of items) out.set(i.area, (out.get(i.area) ?? 0) + 1);
  return out;
}

/**
 * The item the view is on: the selected session's, or with no session selected the first join request of the area
 * selected (where N put it); -1 when it's on none.
 */
export function currentIndex(items: readonly NeedsItem[], sel: { session: string | null; area: string | null }): number {
  if (sel.session) return items.findIndex((i) => i.session === sel.session);
  if (sel.area) return items.findIndex((i) => i.join && i.area === sel.area);
  return -1;
}

/** N (`dir` 1) and ⇧N (-1): the next or previous item after `current`, round the end; from none, the first or the last. */
export function stepItem(items: readonly NeedsItem[], current: number, dir: 1 | -1): NeedsItem | null {
  if (!items.length) return null;
  const from = current < 0 || current >= items.length ? (dir === 1 ? -1 : items.length) : current;
  return items[(from + dir + items.length) % items.length];
}

/** Where Go there (and N) take an item: a workspace, or a room's area; or why it can't be gone to now. */
export type NeedsTarget = { session: SessionInfo } | { area: string; roomId: string; requestKey: string } | { no: string };

/**
 * Where `item` is now, by the sessions as they are (a session that has since left, or that a teammate took over,
 * can't be gone to: the take-over rule is `takenOverWhy`'s, as every other action of a taken-over copy keeps it).
 */
export function targetOf(item: NeedsItem, sessions: readonly SessionInfo[]): NeedsTarget {
  if (item.join) return { area: item.area, roomId: item.join.roomId, requestKey: item.join.key };
  const s = sessions.find((x) => x.id === item.session);
  if (!s) return { no: "That session isn't running any more" };
  const why = notMine(s);
  return why ? { no: why } : { session: s };
}

/** A target as an action's handler (workspaceActions' Can): `go` runs it, or it's off saying why. */
export const goCan = (t: NeedsTarget, go: (t: Exclude<NeedsTarget, { no: string }>) => void): Can => ("no" in t ? { no: t.no } : () => go(t));
