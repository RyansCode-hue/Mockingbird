import { latestPr, ticketOfSession, type SessionInfo, type TicketPipeline } from "../shared/types";
import type { JoinRequestSummary, TeamRoomSummary } from "../shared/team/types";
import type { TypingAsk } from "../shared/team/livePanes";
import { permissionTool, shortReason } from "../shared/phoneAlerts";
import { takenOverWhy, type Can } from "./workspaceActions";
import { firstName } from "./team/connectedModel";
import { agentPatchNotes } from "./ticketPipelineModel";

/**
 * The Needs you tray (docs/landscape.md, Finding what needs you): what's waiting on you, as items. Phase 1 has four
 * kinds: a session waiting on you (amber: a permission prompt, or a question it asked), a teammate asking to type
 * into one of this install's room sessions, a room's join request this install answers as the admin, and a session
 * whose turn ended and that has been idle since. W15 adds two from the ticket pipelines: an agent asking for a pull
 * request (request_pr), and a ticket at a stage that's yours (stakeholder testing, patch notes an agent drafted).
 * Everything here is worked out from what the window already has (sessions, the team status, the pipelines), so the
 * tray, the badges and N agree.
 */

export type NeedsKind = "permission" | "question" | "typing" | "pr" | "join" | "ticket" | "finished";

export interface NeedsItem {
  /**
   * The same while it's the same thing waiting: "s:<session id>", "type:<session id>:<member>",
   * "join:<room>:<member>:<asked at>", "pr:<ticket>:<target>" or "ticket:<ticket>".
   */
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
  /** A typing ask's item: the teammate asking, answered as the ask's strip on the workspace answers it. */
  typing: { member: string; name: string } | null;
  /** A ticket's item: the ticket, and the agent's pull request request it is (a `pr` item's), whose words stay out of the tray. */
  pipeline: { ticket: string; request: string | null } | null;
  /** What it says: "API: last org per user wants to use Bash". */
  text: string;
  /** The code-like part of `text` to set apart (the tool), or null. */
  code: string | null;
}

/** Its kind as the tray's line says it, before the area. */
export const KIND_LABEL: Record<NeedsKind, string> = { permission: "Permission", question: "Waiting", typing: "Wants to type", pr: "Pull request", join: "Join request", ticket: "Ticket", finished: "Finished" };

/**
 * Which kinds come first: what holds an agent or a person up (a prompt, a question, a teammate waiting to type, an
 * agent waiting on its pull request), then someone at the room's door and a ticket at your stage, before what's only
 * done; newest first within a rank.
 */
const RANK: Record<NeedsKind, number> = { permission: 0, question: 0, typing: 0, pr: 0, join: 1, ticket: 1, finished: 2 };

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

/**
 * The teammates asking to type into session `s`, waiting on this install's answer: only ever one of its own room
 * sessions (a teammate's copy, or one a teammate took over, has none to answer here).
 */
export function typingAsksOf(s: SessionInfo): TypingAsk[] {
  if (!s.room || notMine(s)) return [];
  return s.room.typingAsks ?? [];
}

/** Session `s`'s typing asks as items, one per teammate asking. */
export function typingItems(s: SessionInfo, area: string, title: string): NeedsItem[] {
  return typingAsksOf(s).map((a) => ({
    id: `type:${s.id}:${a.member}`,
    sig: `type:${s.id}:${a.member}|${a.at}`,
    kind: "typing",
    at: a.at,
    area,
    session: s.id,
    join: null,
    typing: { member: a.member, name: a.name },
    pipeline: null,
    text: `${firstName(a.name)} wants to type in ${title}`,
    code: null,
  }));
}

/** A session's item, or null when it has none: waiting on you, or idle since its turn ended (`finishedAt`). */
export function sessionItem(s: SessionInfo, area: string, title: string): NeedsItem | null {
  if (notMine(s)) return null;
  if (s.status === "waiting") {
    const tool = permissionTool(s.waitingReason);
    // each prompt's own time (waitingAt): a second prompt worded like a dismissed one is a new item
    const at = s.waitingAt ?? s.waitingSince ?? s.createdAt;
    return {
      id: `s:${s.id}`,
      sig: `s:${s.id}|w|${at}|${s.waitingReason ?? ""}`,
      kind: tool ? "permission" : "question",
      at,
      area,
      session: s.id,
      join: null,
      typing: null,
      pipeline: null,
      text: tool ? `${title} wants to use ${tool}` : `${title}: ${shortReason(s.waitingReason)}`,
      code: tool,
    };
  }
  if (s.status === "idle" && s.finishedAt) {
    return { id: `s:${s.id}`, sig: `s:${s.id}|f|${s.finishedAt}`, kind: "finished", at: s.finishedAt, area, session: s.id, join: null, typing: null, pipeline: null, text: `${title} is done and idle`, code: null };
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
    typing: null,
    pipeline: null,
    text: `${request.name} wants to join ${room.name}`,
    code: null,
  };
}

/**
 * Where ticket `ticket`'s item goes (N) and counts: `prefer`, the session main recorded for it (the one that asked, or
 * drafted, or opened the PR), while it's on the ticket and this install's; else another of this install's on it. Its
 * area is that session's, else the ticket's own group.
 */
function ticketPlace(ticket: string, prefer: string | null | undefined, sessions: readonly SessionInfo[], areaOf: (s: SessionInfo) => string): { session: string | null; area: string } {
  const on = sessions.filter((s) => ticketOfSession(s) === ticket && !notMine(s));
  const s = on.find((x) => x.id === prefer) ?? on[0];
  return { session: s?.id ?? null, area: s ? areaOf(s) : ticket };
}

/**
 * Ticket `p`'s items: each agent's held request for a pull request (`pr`, one per target), and the ticket itself
 * (`ticket`) at stakeholder testing, or with patch notes an agent drafted at AI testing in staging/prod or Patch notes.
 * What they say is Mockingbird's words and the asker's title as main recorded it: the agent's title, description and
 * notes stay in the form that Open shows, marked as the agent's.
 */
export function pipelineItems(p: TicketPipeline, sessions: readonly SessionInfo[], areaOf: (s: SessionInfo) => string): NeedsItem[] {
  const id = p.ticketId;
  const out: NeedsItem[] = (p.requests ?? []).map((r) => ({
    id: `pr:${id}:${r.target}`,
    // a newer request (a new id) is a new state: one dismissed from the tray comes back
    sig: `pr:${id}:${r.id}`,
    kind: "pr",
    at: r.at,
    ...ticketPlace(id, r.from, sessions, areaOf),
    join: null,
    typing: null,
    pipeline: { ticket: id, request: r.id },
    text: `${r.fromTitle} asks to open the PR to ${r.target} · #${id}`,
    code: null,
  }));
  const item = (sig: string, at: number, prefer: string | null | undefined, text: string): NeedsItem => ({
    id: `ticket:${id}`,
    sig: `ticket:${id}|${sig}`,
    kind: "ticket",
    at,
    ...ticketPlace(id, prefer, sessions, areaOf),
    join: null,
    typing: null,
    pipeline: { ticket: id, request: null },
    text,
    code: null,
  });
  const notes = agentPatchNotes(p);
  if (p.stage === "stakeholder") {
    // each arrival at it is a state of its own: one dismissed comes back when the ticket returns after a rework
    const since = (p.history ?? []).at(-1)?.at ?? 0;
    out.push(item(`stakeholder|${since}`, since, latestPr(p.prs ?? [], "dev")?.by, `#${id} is ready for your stakeholder testing`));
  } else if (notes) out.push(item(`notes|${notes.id}`, notes.at, notes.from, `#${id}'s patch notes are drafted`));
  return out;
}

/**
 * Everything that needs you, in the tray's order (and N's): sessions waiting on you, teammates asking to type and
 * agents asking for a pull request; then join requests and tickets at your stages; then finished sessions, newest
 * first within each. `asks` are the requests this install answers as a room's admin (JoinRequests.tsx's
 * adminRequests: the admin's prompt and Members ▾ read the same list); `areaOf` is the area a session's workspace is
 * in on the landscape; `pipelines` are pipeline.json's tickets, as the window reads them.
 */
export function needsItems(
  sessions: readonly SessionInfo[],
  asks: readonly { request: JoinRequestSummary; room: TeamRoomSummary }[],
  areaOf: (s: SessionInfo) => string,
  titleOf: (s: SessionInfo) => string,
  pipelines: Readonly<Record<string, TicketPipeline>> = {}
): NeedsItem[] {
  const out: NeedsItem[] = [];
  for (const s of sessions) {
    const item = sessionItem(s, areaOf(s), titleOf(s));
    if (item) out.push(item);
    out.push(...typingItems(s, areaOf(s), titleOf(s)));
  }
  for (const a of asks) if (a.request.role === "admin" && a.request.state === "waiting") out.push(joinItem(a.request, a.room));
  for (const p of Object.values(pipelines)) out.push(...pipelineItems(p, sessions, areaOf));
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

/**
 * `item` dismissed at `now`, keeping the list short: the newest DISMISS_MAX, none older than DISMISS_KEEP_MS. A
 * dismissal of a state still `current` is kept however old, and before any other: letting it go would bring back an
 * item that hasn't changed.
 */
export function dismiss(list: readonly Dismissed[], item: NeedsItem, now: number, current: readonly string[] = []): Dismissed[] {
  const live = new Set(current);
  const kept = list.filter((d) => d.sig !== item.sig && (live.has(d.sig) || now - d.at < DISMISS_KEEP_MS));
  return [{ sig: item.sig, at: now }, ...kept.filter((d) => live.has(d.sig)), ...kept.filter((d) => !live.has(d.sig))].slice(0, DISMISS_MAX);
}

/** A Dismiss undone: `item` listed again in the state it was dismissed in. */
export const undismiss = (list: readonly Dismissed[], item: Pick<NeedsItem, "sig">): Dismissed[] => list.filter((d) => d.sig !== item.sig);

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

/** A count of items as a badge's title says it. */
export const needsLabel = (n: number): string => `${n} ${n === 1 ? "needs" : "need"} you`;

/** How many shown items count toward each area: the area tree's, the switcher's and a collapsed area's badge. */
export function needsByArea(items: readonly NeedsItem[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of items) out.set(i.area, (out.get(i.area) ?? 0) + 1);
  return out;
}

/** The selection as Needs you reads it: the selected workspace's session, or the selected area (one or neither). */
export interface NeedsSel {
  session: string | null;
  area: string | null;
}
/** The item N (or Go there) last went to, and the selection that left. */
export interface NeedsLast {
  id: string;
  sel: NeedsSel;
}

/**
 * The item the view is on. The one N last went to, while it's still listed and the selection is still the one it
 * left: two join requests for one room select the same area, and a room with no area on the landscape selects
 * nothing, so the selection alone can't tell which. Otherwise the selected session's item, or with an area selected
 * its first join request; -1 when it's on none.
 */
export function currentIndex(items: readonly NeedsItem[], sel: NeedsSel, last: NeedsLast | null = null): number {
  if (last && last.sel.session === sel.session && last.sel.area === sel.area) {
    const i = items.findIndex((x) => x.id === last.id);
    if (i >= 0) return i;
  }
  if (sel.session) return items.findIndex((i) => i.session === sel.session);
  if (sel.area) return items.findIndex((i) => i.join && i.area === sel.area);
  return -1;
}

/**
 * The selection going to `item` leaves (main.tsx's toNeeds does this): its workspace's session selected, or its
 * room's area when that's on the landscape; a room with no area there leaves the selection as it was.
 */
export function selectionAfter(item: NeedsItem, sel: NeedsSel, onLandscape: (area: string) => boolean): NeedsSel {
  if (item.session) return { session: item.session, area: null };
  return onLandscape(item.area) ? { session: null, area: item.area } : sel;
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
  if (item.pipeline && !item.session) return { no: `No workspace on #${item.pipeline.ticket} is open here: Open shows its pipeline` };
  const s = sessions.find((x) => x.id === item.session);
  if (!s) return { no: "That session isn't running any more" };
  const why = notMine(s);
  return why ? { no: why } : { session: s };
}

/** A target as an action's handler (workspaceActions' Can): `go` runs it, or it's off saying why. */
export const goCan = (t: NeedsTarget, go: (t: Exclude<NeedsTarget, { no: string }>) => void): Can => ("no" in t ? { no: t.no } : () => go(t));
