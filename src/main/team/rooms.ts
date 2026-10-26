import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { isMissing, readJsonOrSetAside, writeFileAtomic } from "../fileOps";
import { fingerprintOf, roomIdFor, TEAM_DIR, verifySignature, type Identity } from "./identity";
import { CONTROL_CHARS_RE } from "../../shared/team/agentText";
import { CATCH_UP_MS, RateBucket, ROOM_LIMITS, sizeText, type LimitKind, type RoomLimits } from "./roomLimits";
import { canonicalJson, MEMBER_ID_RE, OWNER_CLAIM_WAIT_MS, PUBLIC_KEY_RE, ROOM_ID_RE, SIGNATURE_RE, toBase64Url, TOKEN_RE, type JoinRequestFields } from "../../shared/team/protocol";
import type { FormerMember, MemberId, RoomEvent, RoomEventBodies, RoomEventType, RoomId, RoomRole, RoomRoles, RoomState } from "../../shared/team/types";

/**
 * Room state: every member keeps a full copy of each room as an append-only
 * log of signed events (~/.mockingbird/team/rooms/<roomId>/log.jsonl, plus a
 * snapshot of the reduced state). Events are ordered by Lamport time, then
 * author, then id, so every member that has the same events computes the
 * same state; reconnecting members exchange what the other lacks (see
 * summary/missingFor) and the order settles itself.
 *
 * An event is accepted only when its id is the hash of what it says, its
 * author is or was a member (or, for room.created, the key the room id was
 * made from), and the author's key signed it. Events from authors not yet
 * known wait (an add may arrive later); events that fail a check are refused.
 *
 * Membership is decided where an event falls in the room's order, the same
 * on every member: an event counts only if its author is a member at that
 * point. So a member who left or was removed (member.removed) is kept as a
 * former member — what they did before still counts, what they do after
 * changes nothing — until a later member.added brings them back. Anyone
 * may leave; who removes someone else is up to their roles (mayRemove).
 * Joins need accepting: only the owner's or an admin's member.added counts,
 * except in rooms from before that, up to their switch (mayAddMember).
 *
 * Roles (roomRoles): one owner — the creator, until a hand-over (role.owner),
 * a claim (role.claim) or their leaving — and the admins the owner makes
 * (role.admin). Like membership, a role event counts only if its author
 * holds the role it needs at that point in the order, so every member
 * reduces the same roles; an older Mockingbird that doesn't know role events
 * keeps them and passes them on, and goes on taking legacyAdmin for the
 * admin.
 *
 * Adding an event type: declare its body in RoomEventBodies (and any state
 * in RoomExtensions), then defineEventType(type, { validate, reduce }).
 * Unknown types (from a newer Mockingbird) are kept and passed on but don't
 * change the state.
 *
 * Limits (roomLimits.ts) hold every author to a share of the log: an event
 * over the size limit, past the author's share, or backdated below what the
 * author sent before is refused from anyone; past the per-minute limit, from
 * peers (`remote`). A refusal says which limit (AddOutcome.limit).
 */

export const ROOMS_DIR = path.join(TEAM_DIR, "rooms");

/** The largest event body accepted. Bulk data travels by request, not in the log. */
export const MAX_EVENT_BODY = ROOM_LIMITS.maxEventBytes;
const MAX_PENDING = 2000;
const SNAPSHOT_EVERY = 100;

/**
 * How far past a log's clock (its largest Lamport time) an event's time may
 * be. Every event's time becomes every member's clock, and the next event
 * needs one more than that: an event at Number.MAX_SAFE_INTEGER would leave
 * the room unable to take another. An event's time is one more than the
 * largest its author had seen, so it is never more than the room's event
 * count past any member's clock, whatever order events arrive in: a room
 * under a million events never has one refused. Refused, a leap moves no
 * clock; pushing one to the limit by leaps that pass takes ~9e9 events.
 */
export const LAMPORT_LEAP = 1_000_000;

// ---- event types --------------------------------------------------------------------

export interface EventDef<B> {
  /**
   * Throw when the body is malformed; runs before the event is stored (never
   * on a log being loaded). `now` is this Mac's clock: an event whose rule
   * reads its time can refuse one dated ahead of it (notAhead).
   */
  validate?(body: unknown, event: RoomEvent, ctx: { now: number }): void;
  /**
   * Apply the event, in total order, to the room's state (mutated in place).
   * Deterministic and JSON only: every member reduces the same events to the
   * same state, which is snapshotted to disk. An event that arrives late
   * replays the room from the start.
   */
  reduce(state: RoomState, event: RoomEvent & { body: B }): void;
}

const registry = new Map<string, EventDef<any>>();

/** Teach every room an event type. Each type is defined once, by the stage that owns it. */
export function defineEventType<K extends RoomEventType>(type: K, def: EventDef<RoomEventBodies[K]>): void {
  if (registry.has(type)) throw new Error(`room event type ${type} is already defined`);
  registry.set(type, def);
}

/** What a stage does to its own part of a room's state when a member leaves or is removed (part of reducing: deterministic, JSON only). */
export type MemberRemovedReducer = (state: RoomState, member: MemberId, event: RoomEvent<"member.removed">) => void;
const removalReducers = new Map<string, MemberRemovedReducer>();

/** Have member.removed also change a stage's state (its sessions go, its chat says so). `name` is the stage's, once. */
export function onMemberRemoved(name: string, reduce: MemberRemovedReducer): void {
  if (removalReducers.has(name)) throw new Error(`a member.removed reducer named ${name} is already defined`);
  removalReducers.set(name, reduce);
}

/** What a member.added that counts also does to a stage's state (the chat says who joined). Part of reducing: deterministic, JSON only. */
export type MemberAddedReducer = (state: RoomState, event: RoomEvent<"member.added">) => void;
const addedReducers = new Map<string, MemberAddedReducer>();

/** Have member.added also change a stage's state. `name` is the stage's, once. */
export function onMemberAdded(name: string, reduce: MemberAddedReducer): void {
  if (addedReducers.has(name)) throw new Error(`a member.added reducer named ${name} is already defined`);
  addedReducers.set(name, reduce);
}

/**
 * A role change that counted, for a stage's state (the chat announces it):
 *   admin / unadmin   the owner (author) made `member` an admin, or took it back
 *   owner             the owner (author) handed ownership to `member`
 *   claim             the author claimed ownership from `member`, who'd gone unheard
 *   contest           the author took ownership back from `member`, whose claim it was
 *   succeeded         the owner left (only an older Mockingbird lets them): `member` owns the room now
 */
export interface RoleChange {
  change: "admin" | "unadmin" | "owner" | "claim" | "contest" | "succeeded";
  member: MemberId;
}
export type RoleChangedReducer = (state: RoomState, change: RoleChange, event: RoomEvent) => void;
const roleReducers = new Map<string, RoleChangedReducer>();

/** Have a role change also change a stage's state. `name` is the stage's, once. Part of reducing: deterministic, JSON only. */
export function onRoleChanged(name: string, reduce: RoleChangedReducer): void {
  if (roleReducers.has(name)) throw new Error(`a role reducer named ${name} is already defined`);
  roleReducers.set(name, reduce);
}

const announce = (state: RoomState, e: RoomEvent, change: RoleChange): void => {
  for (const reduce of roleReducers.values()) reduce(state, change, e);
};

/** Everything that reduces events: a snapshot made under another set is reduced again. */
const reducerNames = (): string[] => [
  ...registry.keys(),
  ...[...removalReducers.keys()].map((n) => `member.removed:${n}`),
  ...[...addedReducers.keys()].map((n) => `member.added:${n}`),
  ...[...roleReducers.keys()].map((n) => `role:${n}`),
];

// ---- roles --------------------------------------------------------------------------------

/**
 * OWNER_CLAIM_WAIT_MS: how long the owner must go unheard from in the room
 * (no event of theirs, by its time) before the room's claimant may take
 * ownership (role.claim). Fourteen days: longer than a week off or a
 * fortnight's holiday with the laptop shut is likely to run, so an owner
 * who's simply away isn't claimed from — and they can contest a claim
 * whenever they're back — yet short enough that a room whose owner is gone
 * for good isn't left for a month with nobody to make admins, set where
 * backups go or pick its House project. The owner a claim took ownership
 * from can't be removed for as long again (mayRemove), so a claim can't be
 * followed at once by removing the person who could contest it.
 */
export { OWNER_CLAIM_WAIT_MS };

/** How far ahead of this Mac's clock an event whose rule reads its time may be dated (clocks drift). */
export const AHEAD_MS = 10 * 60_000;

/** Refuse an event dated ahead of this Mac's clock: a rule that reads its time can't be hurried by a clock set forward. */
const notAhead = (e: RoomEvent, now: number) => {
  if (e.at > now + AHEAD_MS) throw new Error(`it's dated ${Math.round((e.at - now) / 60_000)} minutes ahead of this Mac's clock`);
};

/**
 * Who Mockingbirds from before roles (and the signaling Worker, until it's
 * told the roles: signaling/src/room.ts) take for the room's admin: its
 * creator while a member, else the longest-standing member. Null once nobody
 * is left. Never what this Mockingbird checks permissions against.
 */
export function legacyAdmin(state: Pick<RoomState, "creator" | "members">): MemberId | null {
  if (state.members.some((m) => m.id === state.creator)) return state.creator;
  return state.members[0]?.id ?? null;
}

type RolesView = Pick<RoomState, "creator" | "members" | "roles">;
const inRoom = (state: Pick<RoomState, "members">, id: MemberId | null | undefined): id is MemberId => !!id && state.members.some((m) => m.id === id);

/**
 * A room's roles. A state reduced from its log always has them (room.created
 * makes the creator the owner); one made by hand without them reads as a
 * room before roles: legacyAdmin owns it, nobody else is an admin.
 */
export function roomRoles(state: RolesView): RoomRoles {
  return state.roles ?? { owner: legacyAdmin(state), admins: [], ownerSeenAt: 0 };
}

/** The roles of a state being reduced, made when it has none yet. */
const rolesFor = (state: RoomState): RoomRoles => (state.roles ??= { owner: legacyAdmin(state), admins: [], ownerSeenAt: 0 });

/** The room's owner: everything an admin can do, plus making admins, handing over ownership, and the owner-only settings. Null once nobody is left. */
export function roomOwner(state: RolesView): MemberId | null {
  const o = roomRoles(state).owner;
  return inRoom(state, o) ? o : null;
}

/** The room's admins (not the owner), the longest-standing first. */
export function roomAdmins(state: RolesView): MemberId[] {
  const r = roomRoles(state);
  return r.admins.filter((id) => id !== r.owner && inRoom(state, id));
}

/** A member's role, or null for someone who isn't a member. */
export function roleOf(state: RolesView, id: MemberId): RoomRole | null {
  if (!inRoom(state, id)) return null;
  if (roomOwner(state) === id) return "owner";
  return roomAdmins(state).includes(id) ? "admin" : "member";
}

/**
 * May `id` do what admins do: accept or decline joins, remove members, set
 * the room's rules (the migration check and its folders, release a
 * reservation)? The owner and the admins.
 */
export function isRoomAdmin(state: RolesView, id: MemberId): boolean {
  const r = roleOf(state, id);
  return r === "owner" || r === "admin";
}

/** The owner and the admins: who answers join requests. The owner first. */
export function roomDeciders(state: RolesView): MemberId[] {
  const owner = roomOwner(state);
  return [...(owner ? [owner] : []), ...roomAdmins(state)];
}

/**
 * May `author` remove `target` at time `at`? Anyone may leave. The owner
 * removes anyone; an admin removes members, never another admin or the
 * owner. The owner a claim took ownership from can't be removed by anyone
 * for OWNER_CLAIM_WAIT_MS after it (they may come back to contest it).
 */
export function mayRemove(state: RolesView, author: MemberId, target: MemberId, at: number): boolean {
  if (author === target) return inRoom(state, author);
  const by = roleOf(state, author);
  const of = roleOf(state, target);
  if (!by || !of) return false;
  const claim = roomRoles(state).claim;
  if (claim?.from === target && at < claim.at + OWNER_CLAIM_WAIT_MS) return false;
  if (by === "owner") return true;
  return by === "admin" && of === "member";
}

/**
 * Who may claim ownership once the owner has gone unheard from: the
 * longest-standing admin, or — in a room with no admins — the
 * longest-standing member besides the owner. Null with no owner or nobody else.
 */
export function claimantOf(state: RolesView): MemberId | null {
  const owner = roomOwner(state);
  if (!owner) return null;
  return roomAdmins(state)[0] ?? state.members.find((m) => m.id !== owner)?.id ?? null;
}

/** From when the claimant may claim ownership (the owner last heard from, plus OWNER_CLAIM_WAIT_MS); null with no owner. */
export function claimOpensAt(state: RolesView): number | null {
  return roomOwner(state) ? roomRoles(state).ownerSeenAt + OWNER_CLAIM_WAIT_MS : null;
}

/**
 * May `author` add a member at this point in the room's order? Joins need
 * accepting: once the room says so (`joinApproval`, from its room.created or
 * its first room.approval by its owner or an admin), only the owner's or an
 * admin's member.added counts. Before that point — every room created before
 * joins needed accepting, up to the switch — any member's counts, as it did
 * then, so the members they added stay members. Which side of the switch an
 * event falls on is its place in the room's order, the same on every member.
 */
export function mayAddMember(state: Pick<RoomState, "creator" | "members" | "joinApproval" | "roles">, author: MemberId): boolean {
  if (!inRoom(state, author)) return false;
  return !state.joinApproval || isRoomAdmin(state, author);
}

const str = (v: unknown, what: string, max: number, min = 0): string => {
  if (typeof v !== "string" || v.length > max || v.length < min) throw new Error(`${what} must be text of ${min}–${max} characters`);
  return v;
};

/**
 * A member's or a room's name: what str checks, on one line. Names go into
 * what agents read, so a newline in one could pass for Mockingbird's own
 * lines. Validation runs only on events being added (this install's, or a
 * peer's arriving), never on a log being loaded, so a room whose stored
 * events hold such a name from before still loads; what agents are given
 * one-lines and quotes names wherever they came from (shared/team/agentText.ts).
 */
const nameStr = (v: unknown, what: string, max: number, min = 0): string => {
  str(v, what, max, min);
  if (CONTROL_CHARS_RE.test(v as string)) throw new Error(`${what} has control characters (a line break?)`);
  return v as string;
};

defineEventType("room.created", {
  validate(b: any) {
    if (!b || typeof b !== "object") throw new Error("no body");
    nameStr(b.name, "name", 200, 1);
    str(b.groupKey, "groupKey", 200, 1);
    nameStr(b.creatorName, "creatorName", 100);
    if (typeof b.publicKey !== "string" || !PUBLIC_KEY_RE.test(b.publicKey)) throw new Error("bad creator key");
    if (typeof b.salt !== "string" || !TOKEN_RE.test(b.salt)) throw new Error("bad salt");
    if (b.approval !== undefined && b.approval !== true) throw new Error("bad approval");
  },
  reduce() {
    // creates the state: see applyEvent
  },
});

defineEventType("member.added", {
  validate(b: any) {
    if (!b || typeof b !== "object") throw new Error("no body");
    if (typeof b.id !== "string" || !MEMBER_ID_RE.test(b.id)) throw new Error("bad member id");
    nameStr(b.name, "name", 100);
    if (typeof b.publicKey !== "string" || !PUBLIC_KEY_RE.test(b.publicKey) || fingerprintOf(b.publicKey) !== b.id) throw new Error("the member's key doesn't match its id");
    if (b.inviter !== undefined && (typeof b.inviter !== "string" || !MEMBER_ID_RE.test(b.inviter))) throw new Error("bad inviter");
  },
  reduce(state, e) {
    // kept in the log either way; only an add the room allows at this point counts
    if (!mayAddMember(state, e.author)) return;
    if (state.members.some((m) => m.id === e.body.id)) return;
    // someone who left or was removed comes back with a new invite: as the newest member
    const accepted = state.joinApproval ? { acceptedBy: e.author } : {};
    state.members.push({ id: e.body.id, name: e.body.name, publicKey: e.body.publicKey, joinedAt: e.at, invitedBy: e.body.inviter ?? e.author, ...accepted });
    if (state.former?.some((f) => f.id === e.body.id)) state.former = state.former.filter((f) => f.id !== e.body.id);
    for (const reduce of addedReducers.values()) reduce(state, e as RoomEvent<"member.added">);
  },
});

// a room created before joins needed accepting switches over at its owner's or an admin's room.approval (see mayAddMember)
defineEventType("room.approval", {
  validate(b: any) {
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("no body");
  },
  reduce(state, e) {
    if (isRoomAdmin(state, e.author)) state.joinApproval = true;
  },
});

defineEventType("join.declined", {
  validate(b: any) {
    if (!b || typeof b !== "object") throw new Error("no body");
    if (typeof b.id !== "string" || !MEMBER_ID_RE.test(b.id)) throw new Error("bad member id");
    if (typeof b.invite !== "string" || !TOKEN_RE.test(b.invite)) throw new Error("bad invite");
    if (typeof b.inviter !== "string" || !MEMBER_ID_RE.test(b.inviter)) throw new Error("bad inviter");
  },
  reduce() {
    // a message from the admin to the inviter, kept so it reaches them whenever they're next online; the joiner never gets the room
  },
});

defineEventType("member.removed", {
  validate(b: any, e, ctx) {
    if (!b || typeof b !== "object") throw new Error("no body");
    if (typeof b.member !== "string" || !MEMBER_ID_RE.test(b.member)) throw new Error("bad member id");
    if (b.reason !== undefined && b.reason !== "left" && b.reason !== "removed") throw new Error("bad reason");
    if (b.reason === "left" && b.member !== e.author) throw new Error("only the member themselves can leave");
    // removing someone else can depend on its time (an owner whose ownership was claimed, mayRemove)
    if (b.member !== e.author) notAhead(e, ctx.now);
  },
  reduce(state, e) {
    const target = e.body.member;
    const i = state.members.findIndex((m) => m.id === target);
    if (i < 0) return;
    if (!mayRemove(state, e.author, target, e.at)) return;
    const [m] = state.members.splice(i, 1);
    const former: FormerMember = { ...m, leftAt: e.at, removedBy: target === e.author ? null : e.author };
    state.former = [...(state.former ?? []).filter((f) => f.id !== target), former];
    const r = rolesFor(state);
    r.admins = r.admins.filter((id) => id !== target);
    if (r.claim?.from === target) delete r.claim;
    // an owner can only leave (nobody else removes them), and only an older Mockingbird lets them before
    // handing over: ownership goes on as before roles, to the longest-standing admin, else member
    let next: MemberId | null = null;
    if (r.owner === target) {
      next = r.admins[0] ?? state.members[0]?.id ?? null;
      r.owner = next;
      r.admins = r.admins.filter((id) => id !== next);
      r.ownerSeenAt = e.at;
    }
    for (const reduce of removalReducers.values()) reduce(state, target, e as RoomEvent<"member.removed">);
    if (next) announce(state, e, { change: "succeeded", member: next });
  },
});

const memberIdOf = (v: unknown): MemberId => {
  if (typeof v !== "string" || !MEMBER_ID_RE.test(v)) throw new Error("bad member id");
  return v;
};
const isBody = (b: unknown): b is Record<string, unknown> => !!b && typeof b === "object" && !Array.isArray(b);

// the owner makes an admin, or takes the role back
defineEventType("role.admin", {
  validate(b) {
    if (!isBody(b)) throw new Error("no body");
    memberIdOf(b.member);
    if (typeof b.admin !== "boolean") throw new Error("admin must be true or false");
  },
  reduce(state, e) {
    const m = e.body.member;
    if (roomOwner(state) !== e.author || m === e.author || !inRoom(state, m)) return;
    const r = rolesFor(state);
    if (r.admins.includes(m) === e.body.admin) return;
    r.admins = e.body.admin ? [...r.admins, m] : r.admins.filter((id) => id !== m);
    announce(state, e, { change: e.body.admin ? "admin" : "unadmin", member: m });
  },
});

// the owner hands ownership to another member, and stays an admin
defineEventType("role.owner", {
  validate(b) {
    if (!isBody(b)) throw new Error("no body");
    memberIdOf(b.member);
  },
  reduce(state, e) {
    const m = e.body.member;
    if (roomOwner(state) !== e.author || m === e.author || !inRoom(state, m)) return;
    const r = rolesFor(state);
    r.owner = m;
    r.admins = [...r.admins.filter((id) => id !== m && id !== e.author), e.author];
    r.ownerSeenAt = e.at;
    if (r.claim?.from === m) delete r.claim;
    announce(state, e, { change: "owner", member: m });
  },
});

// the claimant takes ownership from an owner unheard from for OWNER_CLAIM_WAIT_MS; the owner may contest it
defineEventType("role.claim", {
  validate(b, e, ctx) {
    if (!isBody(b)) throw new Error("no body");
    notAhead(e, ctx.now);
  },
  reduce(state, e) {
    const owner = roomOwner(state);
    const r = rolesFor(state);
    if (!owner || claimantOf(state) !== e.author || e.at < r.ownerSeenAt + OWNER_CLAIM_WAIT_MS) return;
    r.claim = { from: owner, by: e.author, at: e.at, byWasAdmin: r.admins.includes(e.author) };
    r.owner = e.author;
    r.admins = r.admins.filter((id) => id !== e.author);
    r.ownerSeenAt = e.at;
    announce(state, e, { change: "claim", member: owner });
  },
});

// the owner a claim took ownership from takes it back; whoever owned it since stays an admin (a claimant who wasn't one before doesn't)
defineEventType("role.contest", {
  validate(b) {
    if (!isBody(b)) throw new Error("no body");
  },
  reduce(state, e) {
    const r = rolesFor(state);
    const c = r.claim;
    if (!c || c.from !== e.author) return;
    const was = roomOwner(state);
    r.owner = e.author;
    r.admins = r.admins.filter((id) => id !== e.author);
    if (was && was !== e.author && (was !== c.by || c.byWasAdmin) && !r.admins.includes(was)) r.admins.push(was);
    delete r.claim;
    r.ownerSeenAt = e.at;
    if (was && was !== e.author) announce(state, e, { change: "contest", member: was });
  },
});

defineEventType("member.renamed", {
  validate(b: any) {
    nameStr(b?.name, "name", 100, 1);
  },
  reduce(state, e) {
    const m = state.members.find((x) => x.id === e.author);
    if (m) m.name = e.body.name;
  },
});

// ---- events ----------------------------------------------------------------------------

/** The exact text an event's signature covers; its id is a hash of the same text. */
export function eventPayload(e: Pick<RoomEvent, "roomId" | "type" | "body" | "author" | "lamport" | "at">): string {
  return `mockingbird-team/event/v1\n${JSON.stringify([e.roomId, e.type, canonicalJson(e.body), e.author, e.lamport, e.at])}`;
}

export const eventIdOf = (payload: string): string => toBase64Url(crypto.createHash("sha256").update(payload, "utf8").digest()).slice(0, 22);

/** Total order: Lamport time, then author, then id. */
export function compareEvents(a: RoomEvent, b: RoomEvent): number {
  return a.lamport - b.lamport || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function createdState(e: RoomEvent<"room.created">): RoomState {
  return {
    id: e.roomId,
    name: e.body.name,
    groupKey: e.body.groupKey,
    creator: e.author,
    createdAt: e.at,
    members: [{ id: e.author, name: e.body.creatorName, publicKey: e.body.publicKey, joinedAt: e.at, invitedBy: null }],
    former: [],
    ...(e.body.approval ? { joinApproval: true as const } : {}),
    roles: { owner: e.author, admins: [], ownerSeenAt: e.at },
    ext: {},
    lamport: e.lamport,
    events: 1,
  };
}

/** One event applied to a room's state (null before its room.created). */
export function applyEvent(state: RoomState | null, e: RoomEvent): RoomState | null {
  if (e.type === "room.created") return state ?? createdState(e as RoomEvent<"room.created">);
  if (!state) return null;
  // an author who isn't a member at this point in the order (gone, or not yet back) changes nothing
  if (state.members.some((m) => m.id === e.author)) {
    registry.get(e.type)?.reduce(state, e);
    // anything the owner says — of any type, known here or not — is them being heard from (claimOpensAt)
    const r = state.roles;
    if (r && r.owner === e.author && e.at > r.ownerSeenAt) r.ownerSeenAt = e.at;
  }
  state.lamport = Math.max(state.lamport, e.lamport);
  state.events += 1;
  return state;
}

/** A room's state from its events, in total order. */
export function reduceRoom(events: readonly RoomEvent[]): RoomState | null {
  let state: RoomState | null = null;
  for (const e of events) state = applyEvent(state, e);
  return state;
}

/** Why an event's fields aren't the right shapes, or null. */
function shapeProblem(e: RoomEvent, roomId: string): string | null {
  if (!e || typeof e !== "object") return "not an event";
  if (e.roomId !== roomId) return "for another room";
  if (typeof e.id !== "string" || e.id.length !== 22) return "bad id";
  if (typeof e.type !== "string" || !/^[a-z][a-zA-Z0-9_.-]{0,63}$/.test(e.type)) return "bad type";
  if (typeof e.author !== "string" || !MEMBER_ID_RE.test(e.author)) return "bad author";
  if (!Number.isSafeInteger(e.lamport) || e.lamport < 1) return "bad Lamport time";
  if (typeof e.at !== "number" || !Number.isFinite(e.at)) return "bad time";
  if (typeof e.sig !== "string" || !SIGNATURE_RE.test(e.sig)) return "bad signature encoding";
  return null;
}

export type AddOutcome = { status: "added" } | { status: "duplicate" } | { status: "pending" } | { status: "rejected"; reason: string; limit?: LimitKind };

/** Events that change who holds which role. */
export const ROLE_TYPES = ["role.admin", "role.owner", "role.claim", "role.contest"] as const;

/** Events that decide who's a member and who may add or remove one: what a former member is given to see their own removal (membershipUpTo). */
const DECIDES_MEMBERSHIP = new Set(["room.created", "member.added", "member.removed", "room.approval", ...ROLE_TYPES]);

/** Events that decide who's in the room: always taken past an author's share, so a member over it can still leave or be removed. */
const MEMBERSHIP_TYPES = new Set(["room.created", "member.added", "member.removed", "room.approval", "join.declined", ...ROLE_TYPES]);

/** While an author's events wait to be asked for again (refused for rate), their order floor holds still: the backlog may sort below newer events. */
const RATE_FREEZE_MS = 30 * 60_000;

export interface RoomLogOptions {
  limits?: Partial<RoomLimits>;
  now?: () => number;
}

/** Per author: how many events, and a digest of their ids. Equal summaries mean equal logs. */
export type LogSummary = Record<MemberId, { n: number; h: string }>;

interface Snapshot {
  v: 1;
  count: number;
  lastId: string | null;
  reducers: string[];
  state: RoomState | null;
}

// ---- one room's log ----------------------------------------------------------------------

export class RoomLog {
  private events: RoomEvent[] = [];
  private ids = new Set<string>();
  private pending = new Map<string, RoomEvent>();
  private _state: RoomState | null = null;
  private clock = 0;
  private sinceSnapshot = 0;
  private summaryCache: LogSummary | null = null;
  /** Lines of the log that couldn't be read (shown in Settings → Team). */
  readonly problems: string[] = [];
  /** Called for each event once it's stored and applied (directly, or once its author became known). */
  onApplied: ((e: RoomEvent) => void) | null = null;
  /** Called when a waiting event, retried once its author became known, is refused by a limit (add's caller has long returned). */
  onRefused: ((e: RoomEvent, r: Extract<AddOutcome, { status: "rejected" }>) => void) | null = null;
  readonly limits: RoomLimits;
  private readonly now: () => number;
  /** Per author: bytes of the log (as stored). */
  private bytesBy = new Map<MemberId, number>();
  /** Per author: the newest Lamport time held long enough to be a floor, and what arrived since. */
  private order = new Map<MemberId, { floor: number; recent: { lamport: number; at: number }[] }>();
  private buckets = new Map<MemberId, RateBucket>();
  /** Per author: events a peer's sync said it holds that this log lacks, taken without the per-minute limit until `until`. */
  private catchUp = new Map<MemberId, { n: number; until: number }>();
  private rateRefusedAt = new Map<MemberId, number>();

  constructor(
    readonly roomId: RoomId,
    readonly dir: string,
    o: RoomLogOptions = {}
  ) {
    if (!ROOM_ID_RE.test(roomId)) throw new Error(`not a room id: ${roomId}`);
    this.limits = { ...ROOM_LIMITS, ...o.limits };
    this.now = o.now ?? Date.now;
  }

  get state(): RoomState | null {
    return this._state;
  }

  private get logFile() {
    return path.join(this.dir, "log.jsonl");
  }
  private get snapshotFile() {
    return path.join(this.dir, "snapshot.json");
  }

  /** Read the log from disk. Its events were verified when written, so they aren't checked again. */
  load(): this {
    let text = "";
    try {
      text = fs.readFileSync(this.logFile, "utf8");
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const e = JSON.parse(line) as RoomEvent;
        const problem = shapeProblem(e, this.roomId);
        if (problem) throw new Error(problem);
        if (this.ids.has(e.id)) return;
        this.ids.add(e.id);
        this.events.push(e);
        this.bytesBy.set(e.author, (this.bytesBy.get(e.author) ?? 0) + Buffer.byteLength(line) + 1);
        const o = this.order.get(e.author);
        if (!o) this.order.set(e.author, { floor: e.lamport, recent: [] });
        else o.floor = Math.max(o.floor, e.lamport);
      } catch (err) {
        const msg = `${this.logFile} line ${i + 1} is unreadable (${(err as Error).message}); skipped`;
        this.problems.push(msg);
        console.error(`[mockingbird] ${msg}`);
      }
    });
    this.events.sort(compareEvents);
    this.clock = this.events.reduce((m, e) => Math.max(m, e.lamport), 0);
    const snap = readJsonOrSetAside(this.snapshotFile, null, `room ${this.roomId}'s snapshot`) as Snapshot | null;
    const last = this.events.at(-1)?.id ?? null;
    if (snap && snap.v === 1 && snap.count === this.events.length && snap.lastId === last && sameList(snap.reducers, reducerNames())) {
      this._state = snap.state;
    } else {
      this._state = reduceRoom(this.events);
    }
    return this;
  }

  /** Every event, in total order. */
  all(): readonly RoomEvent[] {
    return this.events;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  memberKey(id: MemberId): string | undefined {
    return this._state?.members.find((m) => m.id === id)?.publicKey;
  }

  isMember(id: MemberId): boolean {
    return !!this.memberKey(id);
  }

  /** The key of a member, or of someone who was one: what their events are checked against (where they fall decides whether they count). */
  private knownKey(id: MemberId): string | undefined {
    return this.memberKey(id) ?? this._state?.former?.find((m) => m.id === id)?.publicKey;
  }

  /** Was `id` a member who left or was removed (and isn't back)? */
  wasMember(id: MemberId): boolean {
    return !this.isMember(id) && !!this._state?.former?.some((m) => m.id === id);
  }

  /** Events whose author isn't known as a member yet. */
  get waiting(): number {
    return this.pending.size;
  }

  /** Bytes of the log `author` wrote. */
  bytesOf(author: MemberId): number {
    return this.bytesBy.get(author) ?? 0;
  }

  /**
   * A peer's sync says it holds `n` events by `author` this log lacks: they
   * may arrive (from anyone) without counting against the per-minute limit
   * for a while. The share and order still hold.
   */
  expectCatchUp(author: MemberId, n: number): void {
    if (!(n > 0)) return;
    const was = this.catchUp.get(author);
    const now = this.now();
    this.catchUp.set(author, { n: Math.max(n, was && was.until > now ? was.n : 0), until: now + CATCH_UP_MS });
  }

  /** How long until `n` more of `author`'s events from peers would be taken (at most a burst's worth). */
  rateWaitMs(author: MemberId, n = 1): number {
    return this.buckets.get(author)?.waitMs(this.now(), n) ?? 0;
  }

  /**
   * The Lamport time an author's next event must be above: the newest of
   * theirs held for backdateGraceMs. Held still while their events wait to
   * be asked for again (refused for rate), whose backlog may sort lower.
   */
  private floorOf(author: MemberId): number {
    const o = this.order.get(author);
    if (!o) return 0;
    const now = this.now();
    if (now - (this.rateRefusedAt.get(author) ?? -Infinity) >= RATE_FREEZE_MS) {
      while (o.recent.length && now - o.recent[0].at >= this.limits.backdateGraceMs) o.floor = Math.max(o.floor, o.recent.shift()!.lamport);
    }
    return o.floor;
  }

  /** Why an event that passed every other check is over its author's limits, or null. */
  private overLimit(e: RoomEvent, bytes: number, remote: boolean): { reason: string; limit: LimitKind } | null {
    const floor = this.floorOf(e.author);
    if (e.type !== "room.created" && e.lamport <= floor) return { limit: "order", reason: `backdated: its Lamport time ${e.lamport} sorts at or before ${floor}, which its author sent earlier` };
    if (!MEMBERSHIP_TYPES.has(e.type) && this.bytesOf(e.author) + bytes > this.limits.maxMemberLogBytes) {
      return { limit: "share", reason: `its author has written ${sizeText(this.bytesOf(e.author))} of this room's log; the limit is ${sizeText(this.limits.maxMemberLogBytes)}` };
    }
    if (!remote) return null;
    const now = this.now();
    const c = this.catchUp.get(e.author);
    if (c && c.n > 0 && c.until > now) {
      c.n -= 1;
      return null;
    }
    let bucket = this.buckets.get(e.author);
    if (!bucket) this.buckets.set(e.author, (bucket = new RateBucket(this.limits.eventsPerMinute, this.limits.eventBurst, now)));
    if (bucket.take(now)) return null;
    this.rateRefusedAt.set(e.author, now);
    return { limit: "rate", reason: `its author sent more than ${this.limits.eventsPerMinute} events a minute` };
  }

  /**
   * Take an event from anyone (this install or a peer): check it, store it,
   * apply it. Throws only when it can't be written to disk. `remote`: it came
   * from a peer, so the per-minute limit applies too.
   */
  add(e: RoomEvent, o: { remote?: boolean } = {}): AddOutcome {
    const problem = shapeProblem(e, this.roomId);
    if (problem) return { status: "rejected", reason: problem };
    if (this.ids.has(e.id)) return { status: "duplicate" };
    let payload: string;
    try {
      payload = eventPayload(e);
    } catch (err) {
      return { status: "rejected", reason: (err as Error).message };
    }
    if (payload.length > this.limits.maxEventBytes + 1024) return { status: "rejected", reason: `over ${sizeText(this.limits.maxEventBytes)}`, limit: "size" };
    if (eventIdOf(payload) !== e.id) return { status: "rejected", reason: "its id doesn't match its content" };
    let key: string | undefined;
    if (e.type === "room.created") {
      const b = e.body as RoomEventBodies["room.created"];
      if (this._state) return { status: "rejected", reason: "the room was already created" };
      if (typeof b?.publicKey !== "string" || !PUBLIC_KEY_RE.test(b.publicKey) || fingerprintOf(b.publicKey) !== e.author) return { status: "rejected", reason: "the creator's key doesn't match the author" };
      if (typeof b.salt !== "string" || roomIdFor(b.publicKey, b.salt) !== this.roomId) return { status: "rejected", reason: "the room id wasn't made from the creator's key" };
      key = b.publicKey;
    } else {
      key = this.knownKey(e.author);
      if (!key) {
        if (!this.pending.has(e.id)) {
          if (this.pending.size >= MAX_PENDING) {
            const oldest = this.pending.keys().next().value!;
            this.pending.delete(oldest);
            this.pendingRemote.delete(oldest);
            console.error(`[mockingbird] room ${this.roomId}: dropped event ${oldest} from an unknown author (too many waiting)`);
          }
          this.pending.set(e.id, e);
          if (o.remote) this.pendingRemote.add(e.id);
        }
        return { status: "pending" };
      }
    }
    if (!verifySignature(key, payload, e.sig)) return { status: "rejected", reason: "bad signature" };
    try {
      registry.get(e.type)?.validate?.(e.body, e, { now: this.now() });
    } catch (err) {
      return { status: "rejected", reason: `malformed ${e.type}: ${(err as Error).message}` };
    }
    if (e.lamport > this.clock + LAMPORT_LEAP) return { status: "rejected", reason: `its Lamport time ${e.lamport} is more than ${LAMPORT_LEAP} past this room's ${this.clock}` };
    const line = JSON.stringify(e);
    const over = this.overLimit(e, Buffer.byteLength(line) + 1, !!o.remote);
    if (over) return { status: "rejected", ...over };
    this.store(e, line);
    this.retryPending();
    return { status: "added" };
  }

  /** A new event by this install, signed and added. Throws when it can't be (a non-member, a bad body). */
  create<K extends string>(identity: Identity, type: K, body: K extends RoomEventType ? RoomEventBodies[K] : unknown, at = Date.now()): RoomEvent<K> {
    const unsigned = { roomId: this.roomId, type, body, author: identity.id, lamport: this.clock + 1, at };
    const payload = eventPayload(unsigned);
    const e = { ...unsigned, id: eventIdOf(payload), sig: identity.sign(payload) } as RoomEvent<K>;
    const r = this.add(e);
    if (r.status !== "added") throw new Error(`couldn't add ${type} to room ${this.roomId}: ${r.status === "rejected" ? r.reason : r.status === "pending" ? "this install isn't a member" : r.status}`);
    return e;
  }

  /** Per author: count and a digest of ids. */
  summary(): LogSummary {
    if (this.summaryCache) return this.summaryCache;
    const by = new Map<string, string[]>();
    for (const e of this.events) by.set(e.author, [...(by.get(e.author) ?? []), e.id]);
    const s: LogSummary = {};
    for (const [author, ids] of by) s[author] = { n: ids.length, h: digest(ids) };
    return (this.summaryCache = s);
  }

  /** Authors whose events differ between this log and `theirs`. */
  differingAuthors(theirs: LogSummary): MemberId[] {
    const mine = this.summary();
    const authors = new Set([...Object.keys(mine), ...Object.keys(theirs ?? {})]);
    return [...authors].filter((a) => mine[a]?.h !== theirs?.[a]?.h);
  }

  idsBy(author: MemberId): string[] {
    return this.events.filter((e) => e.author === author).map((e) => e.id);
  }

  /** The newest member.removed of `member` in the log (applied or not), or null. */
  removalOf(member: MemberId): RoomEvent<"member.removed"> | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.type === "member.removed" && (e.body as RoomEventBodies["member.removed"])?.member === member) return e as RoomEvent<"member.removed">;
    }
    return null;
  }

  /**
   * What a former member needs to see their own removal: the events that
   * decide membership and roles (room.created, member.added, member.removed, role.*), up to and
   * including their newest removal — never what was said after it.
   */
  membershipUpTo(member: MemberId): RoomEvent[] {
    const removal = this.removalOf(member);
    if (!removal) return [];
    return this.events.filter((e) => DECIDES_MEMBERSHIP.has(e.type) && compareEvents(e, removal) <= 0);
  }

  /** This log's events by `author` that aren't among `theirIds`, in total order. */
  missingFor(author: MemberId, theirIds: string[]): RoomEvent[] {
    const have = new Set(theirIds);
    return this.events.filter((e) => e.author === author && !have.has(e.id));
  }

  /** Write the snapshot now (on quit, and every SNAPSHOT_EVERY events). */
  flush(): void {
    if (!this.sinceSnapshot) return;
    const snap: Snapshot = { v: 1, count: this.events.length, lastId: this.events.at(-1)?.id ?? null, reducers: reducerNames(), state: this._state };
    writeFileAtomic(this.snapshotFile, JSON.stringify(snap));
    this.sinceSnapshot = 0;
  }

  private store(e: RoomEvent, line: string): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.logFile, `${line}\n`);
    this.ids.add(e.id);
    this.pending.delete(e.id);
    this.pendingRemote.delete(e.id);
    this.bytesBy.set(e.author, this.bytesOf(e.author) + Buffer.byteLength(line) + 1);
    const o = this.order.get(e.author);
    if (!o) this.order.set(e.author, { floor: 0, recent: [{ lamport: e.lamport, at: this.now() }] });
    else o.recent.push({ lamport: e.lamport, at: this.now() });
    this.summaryCache = null;
    this.clock = Math.max(this.clock, e.lamport);
    const last = this.events.at(-1);
    if (!last || compareEvents(last, e) < 0) {
      this.events.push(e);
      this._state = applyEvent(this._state, e);
    } else {
      // arrived out of order (merged after a partition): replay from the start
      let lo = 0;
      let hi = this.events.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (compareEvents(this.events[mid], e) < 0) lo = mid + 1;
        else hi = mid;
      }
      this.events.splice(lo, 0, e);
      this._state = reduceRoom(this.events);
    }
    if (++this.sinceSnapshot >= SNAPSHOT_EVERY) this.flush();
    this.onApplied?.(e);
  }

  private retrying = false;
  /** Waiting events that came from peers (the per-minute limit applies when they're taken). */
  private pendingRemote = new Set<string>();

  /** Waiting events whose author has since become a member. */
  private retryPending(): void {
    if (this.retrying) return;
    this.retrying = true;
    try {
      let progressed = true;
      while (progressed && this.pending.size) {
        progressed = false;
        for (const e of [...this.pending.values()].sort(compareEvents)) {
          if (!this.knownKey(e.author)) continue;
          this.pending.delete(e.id);
          const remote = this.pendingRemote.delete(e.id);
          const r = this.add(e, { remote });
          if (r.status === "rejected") {
            console.error(`[mockingbird] room ${this.roomId}: refused event ${e.id} (${e.type}) by ${e.author}: ${r.reason}`);
            if (r.limit) this.onRefused?.(e, r);
          }
          progressed = true;
        }
      }
    } finally {
      this.retrying = false;
    }
  }
}

const digest = (ids: string[]): string => toBase64Url(crypto.createHash("sha256").update([...ids].sort().join("\n")).digest()).slice(0, 16);
const sameList = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

// ---- all rooms on this install -------------------------------------------------------------

/** What this install alone knows about a room: where to signal, and which local group shows it. */
export interface LocalRoomMeta {
  signalingUrl: string;
  /** The local top-level group the room is shown as. */
  groupKey: string;
}

/** An invite this install made. The token is a secret: invites.json is owner-only. */
export interface StoredInvite {
  token: string;
  /** What the signaling server checks (a hash of a key derived from the token). */
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
  usedBy?: MemberId;
  /** The signaling server accepted it. */
  registered?: boolean;
}

/** A room code pasted on this install, until the room has been copied. Holds the token: owner-only. */
export interface PendingJoin {
  roomId: RoomId;
  url: string;
  token: string;
  inviter: MemberId;
  name: string;
  since: number;
  /** The joiner was let in (the admin accepted); the inviter's key, so its connection details can be checked before the room's log arrives. */
  inviterKey?: string;
  rejected?: string;
  /** The rejection was the admin declining. */
  declined?: boolean;
  /** The inviter passed the request on: who answers it, and when it expires with the invite. */
  admin?: MemberId;
  adminName?: string;
  expiresAt?: number;
}

/**
 * A join request this install holds: as the room's admin, to accept or
 * decline; as the inviter, to pass on to the admin (held until the admin's
 * Mockingbird has it) and to tell the joiner how it went. Both, when the
 * admin's own code was used.
 */
export interface JoinRequestRecord extends JoinRequestFields {
  /** The inviter's signature over joinRequestPayload: the admin keeps what the inviter vouched for. */
  sig: string;
  decision?: "accepted" | "declined";
  decidedAt?: number;
  /** Inviter: the first of the owner and admins whose Mockingbird confirmed it has the request. */
  forwardedTo?: MemberId;
  /** Inviter: every owner or admin whose Mockingbird confirmed it has the request. */
  sentTo?: MemberId[];
  /** Inviter: why the admin couldn't be given it yet (an older Mockingbird). */
  problem?: string;
}

export class RoomStore {
  private logs = new Map<RoomId, RoomLog>();
  readonly problems: string[] = [];

  constructor(
    readonly dir = ROOMS_DIR,
    private o: RoomLogOptions = {}
  ) {}

  /** Open every room on disk. A room that can't be read is reported, not dropped. */
  load(): this {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    for (const name of names) {
      if (!ROOM_ID_RE.test(name)) continue;
      try {
        const log = new RoomLog(name, path.join(this.dir, name), this.o).load();
        this.problems.push(...log.problems);
        this.logs.set(name, log);
      } catch (err) {
        const msg = `room ${name} couldn't be read: ${(err as Error).message}`;
        this.problems.push(msg);
        console.error(`[mockingbird] ${msg}`);
      }
    }
    return this;
  }

  list(): RoomLog[] {
    return [...this.logs.values()];
  }

  get(roomId: RoomId): RoomLog | undefined {
    return this.logs.get(roomId);
  }

  /** The room's log, created empty when this install has none yet. */
  open(roomId: RoomId): RoomLog {
    let log = this.logs.get(roomId);
    if (!log) {
      log = new RoomLog(roomId, path.join(this.dir, roomId), this.o);
      fs.mkdirSync(log.dir, { recursive: true, mode: 0o700 });
      this.logs.set(roomId, log);
    }
    return log;
  }

  meta(roomId: RoomId): LocalRoomMeta | null {
    return readJsonOrSetAside(path.join(this.dir, roomId, "local.json"), null, `room ${roomId}'s settings`) as LocalRoomMeta | null;
  }

  setMeta(roomId: RoomId, meta: LocalRoomMeta): void {
    writeFileAtomic(path.join(this.dir, roomId, "local.json"), JSON.stringify(meta, null, 2));
  }

  invites(roomId: RoomId): StoredInvite[] {
    const v = readJsonOrSetAside(path.join(this.dir, roomId, "invites.json"), [], `room ${roomId}'s invites`);
    return Array.isArray(v) ? (v as StoredInvite[]) : [];
  }

  saveInvites(roomId: RoomId, invites: StoredInvite[]): void {
    writeFileAtomic(path.join(this.dir, roomId, "invites.json"), JSON.stringify(invites, null, 2), 0o600);
  }

  joinRequests(roomId: RoomId): JoinRequestRecord[] {
    const v = readJsonOrSetAside(path.join(this.dir, roomId, "join-requests.json"), [], `room ${roomId}'s join requests`);
    return Array.isArray(v) ? (v as JoinRequestRecord[]) : [];
  }

  saveJoinRequests(roomId: RoomId, requests: JoinRequestRecord[]): void {
    writeFileAtomic(path.join(this.dir, roomId, "join-requests.json"), JSON.stringify(requests, null, 2), 0o600);
  }

  private get joinsFile() {
    return path.join(path.dirname(this.dir), "joins.json");
  }

  pendingJoins(): PendingJoin[] {
    const v = readJsonOrSetAside(this.joinsFile, [], "pending room joins");
    return Array.isArray(v) ? (v as PendingJoin[]) : [];
  }

  savePendingJoins(joins: PendingJoin[]): void {
    writeFileAtomic(this.joinsFile, JSON.stringify(joins, null, 2), 0o600);
  }

  /** Delete a room from this install: its log, snapshot, invites and settings. */
  remove(roomId: RoomId): void {
    if (!ROOM_ID_RE.test(roomId)) throw new Error(`not a room id: ${roomId}`);
    this.logs.delete(roomId);
    fs.rmSync(path.join(this.dir, roomId), { recursive: true, force: true });
  }

  /** Snapshot every room (on quit). */
  flush(): void {
    for (const log of this.logs.values()) {
      try {
        log.flush();
      } catch (err) {
        console.error(`[mockingbird] room ${log.roomId}: writing its snapshot failed: ${(err as Error).message}`);
      }
    }
  }
}
