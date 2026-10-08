import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { isMissing, readJsonOrSetAside, writeFileAtomic } from "../fileOps";
import { fingerprintOf, roomIdFor, TEAM_DIR, verifySignature, type Identity } from "./identity";
import { canonicalJson, MEMBER_ID_RE, PUBLIC_KEY_RE, ROOM_ID_RE, SIGNATURE_RE, toBase64Url, TOKEN_RE } from "../../shared/team/protocol";
import type { FormerMember, MemberId, RoomEvent, RoomEventBodies, RoomEventType, RoomId, RoomState } from "../../shared/team/types";

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
 * changes nothing — until a later member.added brings them back. Only the
 * room's admin (roomAdmin) removes someone else; anyone may leave.
 *
 * Adding an event type: declare its body in RoomEventBodies (and any state
 * in RoomExtensions), then defineEventType(type, { validate, reduce }).
 * Unknown types (from a newer Mockingbird) are kept and passed on but don't
 * change the state.
 */

export const ROOMS_DIR = path.join(TEAM_DIR, "rooms");

/** The largest event body accepted. Bulk data travels by request, not in the log. */
export const MAX_EVENT_BODY = 256 * 1024;
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
  /** Throw when the body is malformed; runs before the event is stored. */
  validate?(body: unknown, event: RoomEvent): void;
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

/** Everything that reduces events: a snapshot made under another set is reduced again. */
const reducerNames = (): string[] => [...registry.keys(), ...[...removalReducers.keys()].map((n) => `member.removed:${n}`)];

/**
 * Who may remove other members: the room's creator while it's a member, else
 * the longest-standing member (the earliest member.added, in room order, of
 * those still in it). Null once nobody is left. The signaling Worker follows
 * the same rule as far as it can know it (signaling/src/room.ts signalingAdmin).
 */
export function roomAdmin(state: Pick<RoomState, "creator" | "members">): MemberId | null {
  if (state.members.some((m) => m.id === state.creator)) return state.creator;
  return state.members[0]?.id ?? null;
}

const str = (v: unknown, what: string, max: number, min = 0): string => {
  if (typeof v !== "string" || v.length > max || v.length < min) throw new Error(`${what} must be text of ${min}–${max} characters`);
  return v;
};

defineEventType("room.created", {
  validate(b: any) {
    if (!b || typeof b !== "object") throw new Error("no body");
    str(b.name, "name", 200, 1);
    str(b.groupKey, "groupKey", 200, 1);
    str(b.creatorName, "creatorName", 100);
    if (typeof b.publicKey !== "string" || !PUBLIC_KEY_RE.test(b.publicKey)) throw new Error("bad creator key");
    if (typeof b.salt !== "string" || !TOKEN_RE.test(b.salt)) throw new Error("bad salt");
  },
  reduce() {
    // creates the state: see applyEvent
  },
});

defineEventType("member.added", {
  validate(b: any) {
    if (!b || typeof b !== "object") throw new Error("no body");
    if (typeof b.id !== "string" || !MEMBER_ID_RE.test(b.id)) throw new Error("bad member id");
    str(b.name, "name", 100);
    if (typeof b.publicKey !== "string" || !PUBLIC_KEY_RE.test(b.publicKey) || fingerprintOf(b.publicKey) !== b.id) throw new Error("the member's key doesn't match its id");
  },
  reduce(state, e) {
    if (state.members.some((m) => m.id === e.body.id)) return;
    // someone who left or was removed comes back with a new invite: as the newest member
    state.members.push({ id: e.body.id, name: e.body.name, publicKey: e.body.publicKey, joinedAt: e.at, invitedBy: e.author });
    if (state.former?.some((f) => f.id === e.body.id)) state.former = state.former.filter((f) => f.id !== e.body.id);
  },
});

defineEventType("member.removed", {
  validate(b: any, e) {
    if (!b || typeof b !== "object") throw new Error("no body");
    if (typeof b.member !== "string" || !MEMBER_ID_RE.test(b.member)) throw new Error("bad member id");
    if (b.reason !== undefined && b.reason !== "left" && b.reason !== "removed") throw new Error("bad reason");
    if (b.reason === "left" && b.member !== e.author) throw new Error("only the member themselves can leave");
  },
  reduce(state, e) {
    const target = e.body.member;
    const i = state.members.findIndex((m) => m.id === target);
    if (i < 0) return;
    // anyone may leave; only the admin removes someone else
    if (target !== e.author && roomAdmin(state) !== e.author) return;
    const [m] = state.members.splice(i, 1);
    const former: FormerMember = { ...m, leftAt: e.at, removedBy: target === e.author ? null : e.author };
    state.former = [...(state.former ?? []).filter((f) => f.id !== target), former];
    for (const reduce of removalReducers.values()) reduce(state, target, e as RoomEvent<"member.removed">);
  },
});

defineEventType("member.renamed", {
  validate(b: any) {
    str(b?.name, "name", 100, 1);
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
  if (state.members.some((m) => m.id === e.author)) registry.get(e.type)?.reduce(state, e);
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

export type AddOutcome = { status: "added" } | { status: "duplicate" } | { status: "pending" } | { status: "rejected"; reason: string };

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

  constructor(readonly roomId: RoomId, readonly dir: string) {
    if (!ROOM_ID_RE.test(roomId)) throw new Error(`not a room id: ${roomId}`);
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

  /**
   * Take an event from anyone (this install or a peer): check it, store it,
   * apply it. Throws only when it can't be written to disk.
   */
  add(e: RoomEvent): AddOutcome {
    const problem = shapeProblem(e, this.roomId);
    if (problem) return { status: "rejected", reason: problem };
    if (this.ids.has(e.id)) return { status: "duplicate" };
    let payload: string;
    try {
      payload = eventPayload(e);
    } catch (err) {
      return { status: "rejected", reason: (err as Error).message };
    }
    if (payload.length > MAX_EVENT_BODY + 1024) return { status: "rejected", reason: "body too big" };
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
            console.error(`[mockingbird] room ${this.roomId}: dropped event ${oldest} from an unknown author (too many waiting)`);
          }
          this.pending.set(e.id, e);
        }
        return { status: "pending" };
      }
    }
    if (!verifySignature(key, payload, e.sig)) return { status: "rejected", reason: "bad signature" };
    try {
      registry.get(e.type)?.validate?.(e.body, e);
    } catch (err) {
      return { status: "rejected", reason: `malformed ${e.type}: ${(err as Error).message}` };
    }
    if (e.lamport > this.clock + LAMPORT_LEAP) return { status: "rejected", reason: `its Lamport time ${e.lamport} is more than ${LAMPORT_LEAP} past this room's ${this.clock}` };
    this.store(e);
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
   * decide membership (room.created, member.added, member.removed), up to and
   * including their newest removal — never what was said after it.
   */
  membershipUpTo(member: MemberId): RoomEvent[] {
    const removal = this.removalOf(member);
    if (!removal) return [];
    return this.events.filter((e) => (e.type === "room.created" || e.type === "member.added" || e.type === "member.removed") && compareEvents(e, removal) <= 0);
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

  private store(e: RoomEvent): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.logFile, `${JSON.stringify(e)}\n`);
    this.ids.add(e.id);
    this.pending.delete(e.id);
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
          const r = this.add(e);
          if (r.status === "rejected") console.error(`[mockingbird] room ${this.roomId}: refused event ${e.id} (${e.type}) by ${e.author}: ${r.reason}`);
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
  /** The inviter accepted; its key, so its connection details can be checked before the room's log arrives. */
  inviterKey?: string;
  rejected?: string;
}

export class RoomStore {
  private logs = new Map<RoomId, RoomLog>();
  readonly problems: string[] = [];

  constructor(readonly dir = ROOMS_DIR) {}

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
        const log = new RoomLog(name, path.join(this.dir, name)).load();
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
      log = new RoomLog(roomId, path.join(this.dir, roomId));
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
