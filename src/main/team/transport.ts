import { decodeInvite, encodeInvite, formatFingerprint, joinRequestPayload, MEMBER_ID_RE, PUBLIC_KEY_RE, SIGNATURE_RE, TEAM_PROTOCOL, TOKEN_RE, type JoinRequestFields, type SignalType } from "../../shared/team/protocol";
import type { JoinRequestSummary, MemberId, PeerLinkState, PeerStatus, PendingJoinSummary, RoomEvent, RoomEventBodies, RoomEventType, RoomId, RoomState, TeamRoomSummary, TeamStatus } from "../../shared/team/types";
import { encodeFrame, MAX_STREAM_CHUNK, Reassembler, splitText, type StreamFrame, type TeamFrame } from "./frames";
import { fingerprintOf, joinProof, randomToken, roomIdFor, sameSecret, signalingJoinKey, signalingTokenHash, verifySignature, type Identity } from "./identity";
import { roomAdmin, type JoinRequestRecord, type PendingJoin, type RoomLog, type RoomStore, type StoredInvite } from "./rooms";

/**
 * The team transport: what every stage after the foundation uses to share a
 * room, without knowing how members are connected (WebRTC through the hidden
 * peer host, or the in-process loopback in tests).
 *
 *   team.publish(roomId, type, body)      append a durable, signed room event; it
 *                                         reaches every member (now, or when they
 *                                         reconnect: logs are merged on connect)
 *   team.onEvent(type, handler)           every event applied to a room's state,
 *                                         this install's own included, once each
 *   team.request(peer, method, params)    ask one connected teammate (RPC, with a
 *                                         timeout); team.onRequest(method, handler)
 *                                         answers
 *   team.stream(roomId, channel)          a high-volume pipe to the room's connected
 *                                         members: ordered, never stored, and lossy
 *                                         under pressure (write() says when it
 *                                         dropped; receivers see `gap`)
 *   team.onStream(channel, handler)       "pane:*" matches every channel starting "pane:"
 *   team.presence(roomId)                 teammates connected to the room right now;
 *                                         onPresence(handler) when that changes
 *
 * Room membership is the only permission: events, requests and streams from
 * anyone who isn't a member of the room they name are refused.
 *
 * Leaving and removal (member.removed): the event goes to the room's
 * connected members — and to the member removed — before this install stops
 * talking to them, then the signaling server is asked to cut the key off
 * (revoke). A member removed while offline hears of it from a teammate they
 * still share a connection with, or from the signaling server when its hello
 * is refused; members offline when someone left hear of it from the others,
 * or from the server's welcome. onLeft tells the app when this install's own
 * membership ended, so it can delete what it kept of the room.
 *
 * Joining: the joiner proves to the inviter (the member whose code it holds)
 * that it has the code, and the room's admin accepts or declines. The
 * inviter checks the proof, takes the code (it works once), and tells the
 * joiner whom it waits for (join-pending); when the inviter isn't the admin
 * it passes the request on, signed, to the admin's Mockingbird — held, and
 * passed on once the admin is connected. Accepting is the admin's
 * member.added (only the admin's counts: rooms.ts mayAddMember); declining
 * is the admin's join.declined, and the signaling server drops the joiner at
 * the door (deny). Either reaches the inviter in the room log, and the
 * inviter tells the joiner (join-accepted / join-rejected): the joiner only
 * ever trusts the key its code names. onJoinRequest tells the app when the
 * admin has a request to answer (answerJoin).
 */

export type Unsubscribe = () => void;

export interface RequestContext {
  from: MemberId;
  /** The room the request was made for, when the caller named one (its membership was checked). */
  roomId?: RoomId;
}

export interface StreamContext {
  roomId: RoomId;
  from: MemberId;
  seq: number;
  /** Chunks were dropped since the last one received on this channel from this member. */
  gap: boolean;
}

export interface TeamStream {
  /** Send to the room's connected members. False when a chunk was dropped somewhere (the pipe is congested). */
  write(chunk: string): boolean;
  /** Some receiver's pipe is full: writes are being dropped for it. */
  readonly congested: boolean;
  /** Called once the pipe has room again. */
  onDrain(cb: () => void): Unsubscribe;
}

export type TeamErrorCode = "offline" | "timeout" | "no-handler" | "forbidden" | "remote" | "disconnected" | "not-member" | "closed";

export class TeamError extends Error {
  constructor(readonly code: TeamErrorCode, message: string) {
    super(message);
  }
}

export interface Team {
  readonly self: { id: MemberId; publicKey: string };
  /** Rooms this install is a member of. */
  rooms(): readonly RoomState[];
  room(roomId: RoomId): RoomState | undefined;
  /** A room was created, joined, or its state changed. */
  onRoomsChanged(cb: () => void): Unsubscribe;
  publish<K extends RoomEventType>(roomId: RoomId, type: K, body: RoomEventBodies[K]): RoomEvent<K>;
  onEvent<K extends RoomEventType>(type: K | "*", handler: (event: RoomEvent<K>, room: RoomState) => void): Unsubscribe;
  request<T = unknown>(peer: MemberId, method: string, params?: unknown, opts?: { timeoutMs?: number; roomId?: RoomId }): Promise<T>;
  onRequest(method: string, handler: (params: any, ctx: RequestContext) => unknown): Unsubscribe;
  stream(roomId: RoomId, channel: string): TeamStream;
  onStream(channel: string, handler: (chunk: string, ctx: StreamContext) => void): Unsubscribe;
  presence(roomId: RoomId): MemberId[];
  onPresence(handler: (roomId: RoomId, online: MemberId[]) => void): Unsubscribe;
  /** Every teammate across rooms, and how they're reached. */
  peers(): PeerStatus[];
}

// ---- the wire: how a transport connects members ---------------------------------------

export type IntroType = Extract<SignalType, "join" | "join-pending" | "join-accepted" | "join-rejected">;

/** A room as the wire sees it: where to signal, whose connection details to accept, what to register. */
export interface WireRoom {
  roomId: RoomId;
  url: string;
  /** Members whose connection details are accepted in this room (during a join: the inviter). */
  members: { id: MemberId; publicKey: string }[];
  /** Keys to (re-)admit at the signaling server: the room log's members. */
  admit: string[];
  /** Say hello as the room's creator: the salt its id was made from. */
  create?: string;
  /** Say hello with an invite's join key (signalingJoinKey(token)). */
  join?: string;
  /** Invites to register with the signaling server. */
  invites: { tokenHash: string; expiresAt: number }[];
  /**
   * Former members to cut off at the signaling server, each with its signed
   * removal (the room's admin keeps the server in step: a revoke that failed
   * before, or happened while the server was older, is made again).
   */
  revoke?: { member: MemberId; event: RoomEvent | null }[];
}

/** What the signaling server said to a revoke. */
export type RevokeOutcome =
  | { ok: true }
  | {
      ok: false;
      /** unsupported: a Worker deployed before revoke · refused: it won't (not the admin as it sees it) · offline: not reached · failed: no answer */
      reason: "unsupported" | "refused" | "offline" | "failed";
      message: string;
    };

export interface WireHandler {
  /** A reliable-channel message from a connected peer. */
  frame(peer: MemberId, text: string): void;
  stream(peer: MemberId, text: string): void;
  /** Connected and on the same TEAM_PROTOCOL. */
  up(peer: MemberId): void;
  down(peer: MemberId): void;
  /** A congested stream pipe to `peer` has room again. */
  drain(peer: MemberId): void;
  /** A join introduction; the wire checked it's from `from` (the key in the body). */
  intro(roomId: RoomId, from: MemberId, type: IntroType, body: any): void;
  /** Members reachable for introductions in a room changed. */
  reachable(roomId: RoomId, ids: MemberId[]): void;
  /** Signed room events the signaling server passed on (removals from revokes): checked like any event before they count. */
  roomEvents(roomId: RoomId, events: unknown[]): void;
  /** Link or signaling states changed (for the window). */
  changed(): void;
}

export interface PeerWire {
  readonly self: MemberId;
  setHandler(h: WireHandler): void;
  /** The rooms to be in: the wire connects, signals and admits accordingly. */
  setRooms(rooms: WireRoom[]): void;
  /** Reliable and ordered. False when the peer isn't connected. */
  send(peer: MemberId, text: string): boolean;
  /** Lossy and ordered. False when the chunk was dropped (not connected, or congested). */
  sendStream(peer: MemberId, text: string): boolean;
  congested(peer: MemberId): boolean;
  connected(): MemberId[];
  /** Send a join introduction through the room's signaling. Rejects when `to` can't be reached there. */
  introduce(roomId: RoomId, to: MemberId, type: IntroType, body: unknown): Promise<void>;
  /** Ask the room's signaling server to cut `member` off, passing `event` (their signed removal) on. Never rejects. */
  revoke(roomId: RoomId, member: MemberId, event: RoomEvent | null, timeoutMs?: number): Promise<RevokeOutcome>;
  /** Ask the room's signaling server to drop a joiner knocking at the door (the admin declined it). Never rejects. */
  deny(roomId: RoomId, member: MemberId, timeoutMs?: number): Promise<RevokeOutcome>;
  linkStates(): Map<MemberId, { state: PeerLinkState; detail?: string; since: number }>;
  roomStates(): Map<RoomId, RoomSignalingState>;
  problems(): string[];
  /** After sleep or a network change: reconnect everything now (or only one room's signaling). */
  wake(roomId?: RoomId): void;
  close(): void;
}

export interface RoomSignalingState {
  signaling: "online" | "connecting" | "offline";
  /** Why the signaling server refused this install, until it lets it in. */
  problem?: string;
  /** That refusal's kind: creation-refused (not on ALLOWED_CREATORS), not-member, revoked, protocol, bad-url. */
  code?: string;
  /** The server can revoke (cut removed members off); absent until it has welcomed this install. */
  revoke?: boolean;
  /** The server holds joiners at the door until the admin admits them; absent until it has welcomed this install. */
  approve?: boolean;
  /** This install is a joiner at the door: it can only talk to its inviter until the admin admits it. */
  knocking?: boolean;
}

// ---- the team ------------------------------------------------------------------------------

export interface TeamOptions {
  identity: Identity;
  store: RoomStore;
  wire: PeerWire;
  /** This install's display name (Settings → Team). */
  name: () => string;
  /** The local group a joined room is shown as (default: the room's own group name). */
  groupKeyFor?: (room: RoomState) => string;
  now?: () => number;
  requestTimeoutMs?: number;
  /** How long invite codes stay valid. */
  inviteTtlMs?: number;
  /** How long a member who left or was removed stays connected for what's in flight (default 10 s). */
  departGraceMs?: number;
  log?: (msg: string) => void;
}

interface PendingRequest {
  peer: MemberId;
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const key = (...parts: string[]) => parts.join("\n");

/** The request a member answers with whether it holds a room event (not room-scoped: the asker may have just left). */
const HAS_EVENT = "room.hasEvent";
/** How long a member who left or was removed stays connected, unless the removal's confirmed sooner (TeamOptions.departGraceMs). */
const DEPART_GRACE_MS = 10_000;
/** How long after answering a leaving member's confirmation its connection stays, for the answer to get out. */
const ANSWERED_GRACE_MS = 1_500;
/** The request an inviter passes a join request on to the room's admin with (room-scoped). */
const JOIN_REQUEST = "room.joinRequest";
/** Invites live at most this long (the signaling server's limit too): a request can't outlive one. */
const MAX_INVITE_MS = 7 * 24 * 3_600_000;
/** Decided or expired join requests are kept this long (the inviter's dialog shows how it went), then dropped. */
const REQUEST_KEEP_MS = 24 * 3_600_000;
/** A joiner waiting for the admin asks the inviter again this often (every this many join retries). */
const WAITING_RETRY_EVERY = 4;

/** This install's membership of a room ended. */
export interface LeftInfo {
  /** Who removed this install; null when it left (on another of its windows, or a leave cut short by quitting). */
  by: MemberId | null;
  byName: string | null;
  /** The room as it was reduced, this install now a former member. */
  room: RoomState;
}

export class TeamCore implements Team {
  readonly self: { id: MemberId; publicKey: string };
  private readonly identity: Identity;
  private readonly store: RoomStore;
  private readonly wire: PeerWire;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly requestTimeoutMs: number;
  private readonly inviteTtlMs: number;
  private readonly departGraceMs: number;

  private eventHandlers = new Map<string, Set<(e: RoomEvent<any>, room: RoomState) => void>>();
  private requestHandlers = new Map<string, (params: any, ctx: RequestContext) => unknown>();
  private streamHandlers = new Map<string, Set<(chunk: string, ctx: StreamContext) => void>>();
  private presenceHandlers = new Set<(roomId: RoomId, online: MemberId[]) => void>();
  private roomHandlers = new Set<() => void>();
  private drainHandlers = new Set<(peer: MemberId) => void>();

  /** Each connected peer's hello: its protocol, name and the rooms it says it shares. */
  private hellos = new Map<MemberId, { name: string; rooms: Set<RoomId> }>();
  private helloSent = new Map<MemberId, string>();
  /** Peers on another TEAM_PROTOCOL, with theirs. */
  private otherProtocol = new Map<MemberId, number>();
  private reassembler = new Reassembler();
  private requests = new Map<number, PendingRequest>();
  private nextRequest = 1;
  private sentSeq = new Map<string, number>();
  private receivedSeq = new Map<string, number>();
  private refusedStreams = new Set<string>();
  private joins: PendingJoin[];
  private lastPresence = new Map<RoomId, string>();
  /** Events just applied, to pass on to the room's other members (not back to the member they came from). */
  private outbox: { roomId: RoomId; event: RoomEvent; from: MemberId | null }[] = [];
  private applyingFrom: MemberId | null = null;
  private flushQueued = false;
  private changeQueued = false;
  private joinTimer: ReturnType<typeof setInterval>;
  private closed = false;
  /** Rooms this install is leaving: the wire keeps them as they were until forget(), so the leave reaches teammates and the server. */
  private leaving = new Map<RoomId, WireRoom>();
  /** Members who just left or were removed, kept connected a little while: their removal, and the confirmations, still have to get through. */
  private departing = new Map<RoomId, Map<MemberId, { publicKey: string; timer: ReturnType<typeof setTimeout> }>>();
  /** Removals removeMember is making (room, member): it revokes them itself. */
  private removing = new Set<string>();
  /** A room this install was just removed from, kept on the wire as it was a moment: what's in flight (the confirmation) gets through. */
  private lingering = new Map<RoomId, { spec: WireRoom; removal: string; timer: ReturnType<typeof setTimeout> }>();
  /** What the wire was last told per room. */
  private lastSpecs = new Map<RoomId, WireRoom>();
  private leftHandlers = new Set<(roomId: RoomId, info: LeftInfo) => void>();
  /** Rooms whose end of membership onLeft has reported. */
  private leftReported = new Set<RoomId>();
  private joinRequestHandlers = new Set<(r: JoinRequestSummary) => void>();
  /** Join requests being passed on to the admin right now (room, joiner): one at a time. */
  private forwarding = new Set<string>();
  private joinTicks = 0;

  constructor(private o: TeamOptions) {
    this.identity = o.identity;
    this.self = { id: o.identity.id, publicKey: o.identity.publicKey };
    this.store = o.store;
    this.wire = o.wire;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.log(`[team] ${m}`));
    this.requestTimeoutMs = o.requestTimeoutMs ?? 15_000;
    this.inviteTtlMs = o.inviteTtlMs ?? 7 * 24 * 3_600_000;
    this.departGraceMs = o.departGraceMs ?? DEPART_GRACE_MS;
    this.joins = this.store.pendingJoins();
    for (const log of this.store.list()) this.watch(log);
    // whether a teammate has an event yet: a leaving member asks before it deletes its copy of the room
    this.requestHandlers.set(HAS_EVENT, (p, ctx) => {
      const lingering = this.lingering.get(p?.roomId);
      const has = typeof p?.roomId === "string" && typeof p?.id === "string" && (!!this.store.get(p.roomId)?.has(p.id) || lingering?.removal === p.id);
      // the one who left (or removed this install) asked and is answered: the connection can go once the answer is out
      if (has && this.departing.get(p.roomId)?.has(ctx.from)) setTimeout(() => this.endDeparture(p.roomId, ctx.from), ANSWERED_GRACE_MS).unref?.();
      if (has && lingering?.removal === p.id) setTimeout(() => this.endLinger(p.roomId), ANSWERED_GRACE_MS).unref?.();
      return { has };
    });
    this.requestHandlers.set(JOIN_REQUEST, (p, ctx) => this.onForwardedRequest(p, ctx));
    this.wire.setHandler(this.handler);
    // rooms from before joins needed accepting switch over once their admin's Mockingbird has this
    for (const log of this.store.list()) this.ensureApproval(log);
    this.syncWire();
    this.joinTimer = setInterval(() => this.retryJoins(), 15_000);
    this.joinTimer.unref?.();
  }

  // ---- Team -------------------------------------------------------------------------------

  rooms(): readonly RoomState[] {
    return this.store
      .list()
      .map((l) => l.state)
      .filter((s): s is RoomState => !!s && s.members.some((m) => m.id === this.self.id));
  }

  room(roomId: RoomId): RoomState | undefined {
    const s = this.store.get(roomId)?.state;
    return s && s.members.some((m) => m.id === this.self.id) ? s : undefined;
  }

  onRoomsChanged(cb: () => void): Unsubscribe {
    this.roomHandlers.add(cb);
    return () => this.roomHandlers.delete(cb);
  }

  publish<K extends RoomEventType>(roomId: RoomId, type: K, body: RoomEventBodies[K]): RoomEvent<K> {
    if (this.closed) throw new TeamError("closed", "the team transport is closed");
    const log = this.memberLog(roomId);
    return log.create(this.identity, type, body as any, this.now());
  }

  onEvent<K extends RoomEventType>(type: K | "*", handler: (event: RoomEvent<K>, room: RoomState) => void): Unsubscribe {
    let set = this.eventHandlers.get(type);
    if (!set) this.eventHandlers.set(type, (set = new Set()));
    set.add(handler as any);
    return () => set!.delete(handler as any);
  }

  request<T = unknown>(peer: MemberId, method: string, params?: unknown, opts: { timeoutMs?: number; roomId?: RoomId } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new TeamError("closed", "the team transport is closed"));
    if (!this.hellos.has(peer)) return Promise.reject(new TeamError("offline", `${this.nameOf(peer)} isn't connected`));
    const id = this.nextRequest++;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new TeamError("timeout", `${this.nameOf(peer)} didn't answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.requests.set(id, { peer, resolve: resolve as (v: unknown) => void, reject, timer });
      if (!this.sendFrame(peer, { k: "req", id, method, params: params ?? null, ...(opts.roomId ? { roomId: opts.roomId } : {}) })) {
        clearTimeout(timer);
        this.requests.delete(id);
        reject(new TeamError("offline", `${this.nameOf(peer)} isn't connected`));
      }
    });
  }

  onRequest(method: string, handler: (params: any, ctx: RequestContext) => unknown): Unsubscribe {
    if (this.requestHandlers.has(method)) throw new Error(`a handler for ${method} is already registered`);
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
    };
  }

  stream(roomId: RoomId, channel: string): TeamStream {
    const targets = () => this.presence(roomId);
    const seqKey = key(roomId, channel);
    const team = this;
    return {
      write(chunk: string): boolean {
        if (typeof chunk !== "string") throw new TypeError("stream chunks are text");
        if (!team.room(roomId)) throw new TeamError("not-member", `not a member of room ${roomId}`);
        let delivered = true;
        const to = targets();
        for (const piece of splitText(chunk, MAX_STREAM_CHUNK)) {
          const q = (team.sentSeq.get(seqKey) ?? 0) + 1;
          team.sentSeq.set(seqKey, q);
          const text = JSON.stringify({ r: roomId, c: channel, q, d: piece } satisfies StreamFrame);
          for (const peer of to) if (!team.wire.sendStream(peer, text)) delivered = false;
        }
        return delivered;
      },
      get congested() {
        return targets().some((p) => team.wire.congested(p));
      },
      onDrain(cb: () => void): Unsubscribe {
        const h = (peer: MemberId) => {
          if (targets().includes(peer) && !targets().some((p) => team.wire.congested(p))) cb();
        };
        team.drainHandlers.add(h);
        return () => team.drainHandlers.delete(h);
      },
    };
  }

  onStream(channel: string, handler: (chunk: string, ctx: StreamContext) => void): Unsubscribe {
    let set = this.streamHandlers.get(channel);
    if (!set) this.streamHandlers.set(channel, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  presence(roomId: RoomId): MemberId[] {
    return [...this.hellos.entries()].filter(([peer, h]) => h.rooms.has(roomId) && this.allowed(peer, roomId)).map(([peer]) => peer).sort();
  }

  onPresence(handler: (roomId: RoomId, online: MemberId[]) => void): Unsubscribe {
    this.presenceHandlers.add(handler);
    return () => this.presenceHandlers.delete(handler);
  }

  peers(): PeerStatus[] {
    const links = this.wire.linkStates();
    const out = new Map<MemberId, PeerStatus>();
    for (const room of this.rooms()) {
      for (const m of room.members) {
        if (m.id === this.self.id || out.has(m.id)) continue;
        const link = links.get(m.id) ?? { state: "offline" as const, since: room.createdAt };
        const theirs = this.otherProtocol.get(m.id);
        out.set(
          m.id,
          theirs !== undefined
            ? { id: m.id, name: this.nameOf(m.id), state: "needs-update", detail: theirs < TEAM_PROTOCOL ? `${this.nameOf(m.id)}'s Mockingbird needs an update` : "This Mockingbird needs an update to connect", since: link.since }
            : { id: m.id, name: this.nameOf(m.id), ...link }
        );
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- rooms, invites, joins ------------------------------------------------------------------

  /** Share a group: a new room, created on this install. */
  createRoom(spec: { name: string; groupKey: string; signalingUrl: string }): RoomState {
    if (!/^https?:\/\//.test(spec.signalingUrl)) throw new Error("Set the signaling URL in Settings → Team first (the Worker's address, from signaling/README.md)");
    const salt = randomToken();
    const roomId = roomIdFor(this.self.publicKey, salt);
    const log = this.store.open(roomId);
    this.watch(log);
    this.store.setMeta(roomId, { signalingUrl: spec.signalingUrl, groupKey: spec.groupKey });
    log.create(this.identity, "room.created", { name: spec.name, groupKey: spec.groupKey, publicKey: this.self.publicKey, creatorName: this.o.name(), salt, approval: true }, this.now());
    this.syncWire();
    return log.state!;
  }

  /** A one-time invite code for a room this install is in. */
  createInvite(roomId: RoomId): string {
    const room = this.memberLog(roomId).state!;
    const meta = this.store.meta(roomId);
    if (!meta) throw new Error(`room ${room.name} has no signaling URL on this install`);
    const token = randomToken();
    const now = this.now();
    const invites = this.store.invites(roomId).filter((i) => i.expiresAt > now - 30 * 24 * 3_600_000);
    invites.push({ token, tokenHash: signalingTokenHash(token), createdAt: now, expiresAt: now + this.inviteTtlMs });
    this.store.saveInvites(roomId, invites);
    this.syncWire();
    return encodeInvite({ roomId, url: meta.signalingUrl, token, inviter: this.self.id, name: room.name });
  }

  /** Start joining the room a code names. It completes once the inviter has accepted and the room is copied here. */
  join(code: string): { roomId: RoomId; name: string } {
    const invite = decodeInvite(code);
    if (invite.inviter === this.self.id) throw new Error("That's a code for your own room — send it to your teammate");
    if (this.room(invite.roomId)) throw new Error(`You're already in ${invite.name}`);
    const j: PendingJoin = { roomId: invite.roomId, url: invite.url, token: invite.token, inviter: invite.inviter, name: invite.name, since: this.now() };
    this.joins = [...this.joins.filter((x) => x.roomId !== j.roomId), j];
    this.store.savePendingJoins(this.joins);
    this.syncWire();
    this.sendJoin(j);
    this.changedSoon();
    return { roomId: j.roomId, name: j.name };
  }

  /**
   * Take back a room this install created and nobody joined (the signaling
   * server refused it): nothing of it ever left this machine. Throws for a
   * room with other members.
   */
  discardUnsharedRoom(roomId: RoomId): void {
    const room = this.room(roomId);
    if (!room) return;
    if (room.creator !== this.self.id || room.members.length > 1) throw new Error(`${room.name} has members; it can't be discarded`);
    this.store.remove(roomId);
    this.syncWire();
    this.changedSoon();
  }

  // ---- leaving and removing ---------------------------------------------------------------------

  /** Who can remove members of a room this install is in (see roomAdmin). */
  admin(roomId: RoomId): MemberId | null {
    const room = this.room(roomId);
    return room ? roomAdmin(room) : null;
  }

  /**
   * Remove a teammate (the room's admin only). The removal is published and
   * sent to them while they're still connected (each Mockingbird drops them
   * from the room), then the signaling server cuts their key off. Someone
   * already removed is only cut off at the server again: a revoke that
   * failed can be retried this way. Throws before anything changed, never
   * after: what didn't happen afterwards is in the answer.
   */
  async removeMember(roomId: RoomId, member: MemberId, o: { ackMs?: number; revokeMs?: number } = {}): Promise<{ delivered: boolean; revoke: RevokeOutcome; already: boolean }> {
    const log = this.memberLog(roomId);
    const state = log.state!;
    if (member === this.self.id) throw new Error("To leave the room yourself, use Leave room");
    const target = state.members.find((m) => m.id === member);
    if (!target && !log.wasMember(member)) throw new Error(`${this.nameOf(member)} isn't in ${state.name}`);
    const admin = roomAdmin(state);
    if (admin !== this.self.id) throw new Error(`Only the room's admin (${admin ? this.nameOf(admin) : "nobody"}) can remove members: its creator, or the longest-standing member once the creator has left`);
    let delivered = false;
    let event: RoomEvent | null = log.removalOf(member);
    let revoke: RevokeOutcome;
    this.removing.add(key(roomId, member));
    try {
      if (target) {
        const connected = this.hellos.has(member);
        event = this.publish(roomId, "member.removed", { member, reason: "removed" }); // they stay connected a little while (applied)
        this.flushOutbox();
        if (connected) delivered = (await this.confirm([member], roomId, event.id, o.ackMs ?? 5_000)).length > 0;
      }
      revoke = await this.wire.revoke(roomId, member, event, o.revokeMs ?? 10_000);
    } finally {
      this.removing.delete(key(roomId, member));
      this.endDeparture(roomId, member);
    }
    if (!revoke.ok) this.log(`the signaling server didn't cut ${this.nameOf(member)} off ${state.name}: ${revoke.message}`);
    this.changedSoon();
    return { delivered, revoke, already: !target };
  }

  /**
   * Leave a room: the leave is published, sent to the teammates connected now
   * (and confirmed by them), and this install's key is cut off at the
   * signaling server. The room stays on this install, out of reach of
   * anything but the leave, until forget(): the caller deletes what it kept
   * of it first. Throws only before anything changed.
   */
  async leave(roomId: RoomId, o: { ackMs?: number; revokeMs?: number } = {}): Promise<{ told: MemberId[]; missed: MemberId[]; revoke: RevokeOutcome; room: RoomState }> {
    const log = this.memberLog(roomId);
    const spec = this.wireRoomOf(log);
    const others = log.state!.members.filter((m) => m.id !== this.self.id).map((m) => m.id);
    const online = this.presence(roomId);
    if (spec) this.leaving.set(roomId, spec);
    let e: RoomEvent;
    try {
      e = this.publish(roomId, "member.removed", { member: this.self.id, reason: "left" });
    } catch (err) {
      this.leaving.delete(roomId);
      throw err;
    }
    this.flushOutbox();
    const told = await this.confirm(online, roomId, e.id, o.ackMs ?? 5_000);
    const revoke = spec ? await this.wire.revoke(roomId, this.self.id, e, o.revokeMs ?? 10_000) : ({ ok: false, reason: "offline", message: "this room has no signaling URL here" } as const);
    if (!revoke.ok) this.log(`the signaling server didn't cut this install off ${log.state!.name}: ${revoke.message}`);
    return { told, missed: others.filter((id) => !told.includes(id)), revoke, room: log.state! };
  }

  /**
   * Delete a room this install is no longer in (it left, or was removed):
   * its folder (log, snapshot, invites, settings and whatever other stages
   * kept there) and any pending join, and stop connecting for it. Throws when
   * the folder can't be deleted; it's tried again on the next start.
   */
  forget(roomId: RoomId): void {
    const log = this.store.get(roomId);
    if (log?.state && log.isMember(this.self.id)) throw new Error(`still a member of ${log.state.name}: leave it first`);
    this.leaving.delete(roomId);
    for (const d of this.departing.get(roomId)?.values() ?? []) clearTimeout(d.timer);
    this.departing.delete(roomId);
    // a room just removed from stays on the wire until its moment is up (an answer to the remover may still be on its way)
    this.lastSpecs.delete(roomId);
    this.leftReported.delete(roomId);
    if (this.joins.some((j) => j.roomId === roomId)) {
      this.joins = this.joins.filter((j) => j.roomId !== roomId);
      this.store.savePendingJoins(this.joins);
    }
    try {
      this.store.remove(roomId);
    } finally {
      this.syncWire();
      this.changedSoon();
    }
  }

  /** The local group a room on this install is shown as, member or not (until it's forgotten). */
  localGroupOf(roomId: RoomId): string | null {
    return this.store.get(roomId) ? (this.store.meta(roomId)?.groupKey ?? null) : null;
  }

  /** This install's membership of a room ended (removed by the admin, or left elsewhere). Not for leave(): its caller knows. */
  onLeft(cb: (roomId: RoomId, info: LeftInfo) => void): Unsubscribe {
    this.leftHandlers.add(cb);
    return () => this.leftHandlers.delete(cb);
  }

  /** Rooms still on this install that it's no longer in (a leave or removal whose cleanup didn't finish, say before quitting). */
  leftRooms(): { roomId: RoomId; info: LeftInfo }[] {
    const out: { roomId: RoomId; info: LeftInfo }[] = [];
    for (const log of this.store.list()) {
      const info = this.endedHere(log);
      if (info) out.push({ roomId: log.roomId, info });
    }
    return out;
  }

  /** How this install's membership of the room ended, when it has (and isn't being joined again, or left right now). */
  private endedHere(log: RoomLog): LeftInfo | null {
    const state = log.state;
    if (!state || !log.wasMember(this.self.id) || this.leaving.has(log.roomId) || this.joins.some((j) => j.roomId === log.roomId)) return null;
    const by = state.former?.find((f) => f.id === this.self.id)?.removedBy ?? null;
    return { by, byName: by ? this.nameIn(state, by) : null, room: state };
  }

  /** Keep a member who just left or was removed connected for `ms` (their removal, and confirmations of it, still travel). */
  private depart(roomId: RoomId, member: MemberId, publicKey: string, ms: number): void {
    let room = this.departing.get(roomId);
    if (!room) this.departing.set(roomId, (room = new Map()));
    const before = room.get(member);
    if (before) clearTimeout(before.timer);
    const timer = setTimeout(() => this.endDeparture(roomId, member), ms);
    timer.unref?.();
    room.set(member, { publicKey, timer });
  }

  /** This install was removed from the room (by `removal`): the wire keeps it as it was a moment, until the remover's confirmation is answered. */
  private linger(roomId: RoomId, removal: string): void {
    const spec = this.lastSpecs.get(roomId);
    if (!spec || this.lingering.has(roomId)) return;
    const timer = setTimeout(() => this.endLinger(roomId), this.departGraceMs);
    timer.unref?.();
    this.lingering.set(roomId, { spec, removal, timer });
  }

  private endLinger(roomId: RoomId): void {
    const l = this.lingering.get(roomId);
    if (!l) return;
    clearTimeout(l.timer);
    this.lingering.delete(roomId);
    this.syncWire();
  }

  private endDeparture(roomId: RoomId, member: MemberId): void {
    const room = this.departing.get(roomId);
    const d = room?.get(member);
    if (!room || !d) return;
    clearTimeout(d.timer);
    room.delete(member);
    if (!room.size) this.departing.delete(roomId);
    this.syncWire();
  }

  /** Tell onLeft once a room's membership ended here. */
  private checkLeft(log: RoomLog): void {
    if (this.leftReported.has(log.roomId)) return;
    const info = this.endedHere(log);
    if (!info) return;
    this.leftReported.add(log.roomId);
    queueMicrotask(() => {
      for (const h of this.leftHandlers) this.safely("a left-room handler", () => h(log.roomId, info));
    });
  }

  /** Teammates among `peers` who confirm they hold event `id` (asked after it was sent: frames arrive in order). */
  private async confirm(peers: MemberId[], roomId: RoomId, id: string, timeoutMs: number): Promise<MemberId[]> {
    const answers = await Promise.all(
      peers.map((p) =>
        this.request<{ has?: boolean }>(p, HAS_EVENT, { roomId, id }, { timeoutMs }).then(
          (r) => (r?.has ? p : null),
          (err) => {
            this.log(`${this.nameOf(p)} didn't confirm they have event ${id}: ${(err as Error).message}`);
            return null;
          }
        )
      )
    );
    return answers.filter((p): p is MemberId => !!p);
  }

  /** Give up on a pasted code. */
  cancelJoin(roomId: RoomId): void {
    this.joins = this.joins.filter((j) => j.roomId !== roomId);
    this.store.savePendingJoins(this.joins);
    this.syncWire();
    this.changedSoon();
  }

  // ---- join requests: the admin accepts or declines -----------------------------------------------

  /** The room's admin has a new join request to answer (on this install). */
  onJoinRequest(cb: (r: JoinRequestSummary) => void): Unsubscribe {
    this.joinRequestHandlers.add(cb);
    return () => this.joinRequestHandlers.delete(cb);
  }

  /**
   * Accept or decline someone's request to join (the room's admin only).
   * Accepting adds them (member.added); declining tells the inviter
   * (join.declined), who tells the joiner, and the signaling server drops
   * them at the door. Throws before anything changed; `worker` says when the
   * server couldn't drop a declined joiner.
   */
  async answerJoin(roomId: RoomId, joiner: MemberId, accept: boolean, o: { denyMs?: number } = {}): Promise<{ name: string; accepted: boolean; worker: RevokeOutcome | null }> {
    const log = this.memberLog(roomId);
    const state = log.state!;
    const admin = roomAdmin(state);
    if (admin !== this.self.id) throw new Error(`Only the room's admin (${admin ? this.nameOf(admin) : "nobody"}) can accept or decline joins`);
    const requests = this.store.joinRequests(roomId);
    const r = requests.filter((x) => x.id === joiner && !x.decision).at(-1);
    if (!r) {
      if (log.isMember(joiner)) return { name: this.nameOf(joiner), accepted: true, worker: null };
      throw new Error(`Nobody with that key is asking to join ${state.name}`);
    }
    if (r.expiresAt <= this.now()) throw new Error(`${r.name}'s request expired with the code they used: they need a new one`);
    this.ensureApproval(log, true);
    // decided before it's published: what the log tells the inviter (maybe this install) finds it answered
    r.decision = accept ? "accepted" : "declined";
    r.decidedAt = this.now();
    this.store.saveJoinRequests(roomId, requests);
    let worker: RevokeOutcome | null = null;
    if (accept) {
      if (!log.isMember(joiner)) this.publish(roomId, "member.added", { id: r.id, name: r.name, publicKey: r.publicKey, inviter: r.inviter });
      this.log(`accepted ${r.name} (${r.id}) into ${state.name}`);
    } else {
      this.publish(roomId, "join.declined", { id: r.id, invite: r.invite, inviter: r.inviter });
      this.log(`declined ${r.name}'s (${r.id}) request to join ${state.name}`);
      worker = await this.wire.deny(roomId, joiner, o.denyMs ?? 10_000);
      if (!worker.ok) this.log(`the signaling server didn't drop ${r.name} at the door of ${state.name}: ${worker.message}`);
    }
    this.changedSoon();
    return { name: r.name, accepted: accept, worker };
  }

  /**
   * From here in the room's order joins need the admin's acceptance: a room
   * created before that switches over with its admin's room.approval (later
   * in a microtask, unless `now`: publishing inside an applied event would
   * re-enter the log).
   */
  private ensureApproval(log: RoomLog, now = false): void {
    const run = () => {
      const state = log.state;
      if (this.closed || !state || state.joinApproval || roomAdmin(state) !== this.self.id || !log.isMember(this.self.id) || this.leaving.has(log.roomId)) return;
      try {
        this.publish(log.roomId, "room.approval", {});
        this.log(`joins of ${state.name} need accepting from now on`);
      } catch (err) {
        this.log(`couldn't switch ${state.name} to accepting joins: ${(err as Error).message}`);
      }
    };
    if (now) run();
    else queueMicrotask(run);
  }

  /** A forwarded or own request, as the window shows it. */
  private requestSummary(state: RoomState, r: JoinRequestRecord): JoinRequestSummary {
    const admin = roomAdmin(state);
    const role = admin === this.self.id ? "admin" : "inviter";
    const state_: JoinRequestSummary["state"] = r.decision ?? (role === "inviter" && r.forwardedTo !== admin ? "forwarding" : "waiting");
    return {
      roomId: state.id,
      id: r.id,
      name: r.name,
      fingerprint: formatFingerprint(r.id),
      inviter: r.inviter,
      inviterName: this.nameIn(state, r.inviter),
      admin,
      adminName: admin ? this.nameIn(state, admin) : "nobody",
      role,
      state: state_,
      ...(r.problem && !r.decision ? { problem: r.problem } : {}),
      at: r.at,
      expiresAt: r.expiresAt,
    };
  }

  /** The requests the window shows for a room: the admin's to answer; the inviter's passed on (and how they went, for a day). */
  private requestsOf(state: RoomState): JoinRequestSummary[] {
    const now = this.now();
    const admin = roomAdmin(state);
    return this.store
      .joinRequests(state.id)
      .filter((r) => (admin === this.self.id ? !r.decision && r.expiresAt > now && !state.members.some((m) => m.id === r.id) : r.inviter === this.self.id && (r.decision ? (r.decidedAt ?? 0) > now - REQUEST_KEEP_MS : r.expiresAt > now)))
      .map((r) => this.requestSummary(state, r));
  }

  /** Keep a request this install answers, or passes on: the admin is told of a new one. Returns false when it was already held. */
  private holdRequest(roomId: RoomId, r: JoinRequestRecord): boolean {
    const requests = this.store.joinRequests(roomId);
    if (requests.some((x) => x.id === r.id && x.invite === r.invite)) return false;
    this.store.saveJoinRequests(roomId, [...requests, r]);
    const state = this.room(roomId);
    if (state && roomAdmin(state) === this.self.id) {
      const summary = this.requestSummary(state, r);
      for (const h of this.joinRequestHandlers) this.safely("a join-request handler", () => h(summary));
    }
    this.changedSoon();
    return true;
  }

  /**
   * The admin's side of a request an inviter passed on: checked (the
   * inviter's signature, the joiner's key, the expiry) and held for the
   * admin to answer. Answers whether it was decided already.
   */
  private onForwardedRequest(p: any, ctx: RequestContext): { received: true; decision?: "accepted" | "declined" } {
    if (!ctx.roomId) throw new Error("a join request names its room");
    const log = this.memberLog(ctx.roomId);
    const state = log.state!;
    if (roomAdmin(state) !== this.self.id) throw new Error(`this Mockingbird isn't ${state.name}'s admin`);
    const r = joinRequestOf(p, ctx.roomId);
    if (!r) throw new Error("a malformed join request");
    if (r.inviter !== ctx.from) throw new Error("a join request is passed on by its inviter");
    const key = log.memberKey(ctx.from);
    if (!key || !verifySignature(key, joinRequestPayload(r), r.sig)) throw new Error("the join request isn't signed by its inviter");
    const now = this.now();
    if (r.expiresAt <= now) throw new Error("the join request expired with its code");
    if (r.expiresAt - r.at > MAX_INVITE_MS + 60_000) throw new Error("a join request can't outlive a 7-day code");
    if (log.isMember(r.id)) return { received: true, decision: "accepted" };
    const held = this.store.joinRequests(ctx.roomId).find((x) => x.id === r.id && x.invite === r.invite);
    if (held) return { received: true, ...(held.decision ? { decision: held.decision } : {}) };
    this.holdRequest(ctx.roomId, { ...r, forwardedTo: this.self.id });
    this.log(`${this.nameOf(ctx.from)} passed on ${r.name}'s (${r.id}) request to join ${state.name}`);
    return { received: true };
  }

  /** Pass the requests this install took as the inviter on to the room's admin, when the admin's Mockingbird is connected and doesn't have them yet. */
  private forwardRequests(roomId: RoomId): void {
    const state = this.room(roomId);
    if (!state) return;
    const admin = roomAdmin(state);
    if (!admin || admin === this.self.id || !this.hellos.has(admin) || !this.allowed(admin, roomId)) return;
    const now = this.now();
    for (const r of this.store.joinRequests(roomId)) {
      const k = key(roomId, r.id, r.invite);
      if (r.inviter !== this.self.id || r.decision || r.expiresAt <= now || r.forwardedTo === admin || this.forwarding.has(k) || state.members.some((m) => m.id === r.id)) continue;
      this.forwarding.add(k);
      const { decision: _d, decidedAt: _t, forwardedTo: _f, problem: _p, ...fields } = r;
      this.request<{ received?: boolean }>(admin, JOIN_REQUEST, fields, { roomId })
        .then(
          (answer) => {
            if (!answer?.received) throw new Error("the admin's Mockingbird didn't take it");
            this.updateRequest(roomId, r, { forwardedTo: admin, problem: undefined });
            this.log(`passed ${r.name}'s request to join ${state.name} on to ${this.nameOf(admin)}`);
          },
          (err: TeamError) => {
            // an admin on an older Mockingbird can't take requests: said, and asked again when it reconnects
            const problem = err.code === "no-handler" ? `${this.nameOf(admin)}'s Mockingbird needs an update to accept joins` : undefined;
            if (problem) this.updateRequest(roomId, r, { problem });
            this.log(`couldn't pass ${r.name}'s request to join ${state.name} on to ${this.nameOf(admin)}: ${err.message}`);
          }
        )
        .catch((err) => this.log(`passing on ${r.name}'s request to join ${state.name} failed: ${(err as Error).message}`))
        .finally(() => this.forwarding.delete(k));
    }
  }

  private updateRequest(roomId: RoomId, r: JoinRequestRecord, patch: Partial<JoinRequestRecord>): void {
    if (!this.store.get(roomId)) return;
    const requests = this.store.joinRequests(roomId);
    const i = requests.findIndex((x) => x.id === r.id && x.invite === r.invite);
    if (i < 0) return;
    requests[i] = { ...requests[i], ...patch };
    for (const k of Object.keys(patch) as (keyof JoinRequestRecord)[]) if (patch[k] === undefined) delete requests[i][k];
    this.store.saveJoinRequests(roomId, requests);
    this.changedSoon();
  }

  /**
   * The admin decided a request this install took as the inviter (seen in
   * the room log): the joiner is told — let in, or declined. The joiner asks
   * again while it waits, so one that can't be reached now hears it then.
   */
  private relayDecision(log: RoomLog, joiner: MemberId, decision: "accepted" | "declined", by: MemberId): void {
    const state = log.state;
    if (!state || !log.isMember(this.self.id)) return;
    const requests = this.store.joinRequests(log.roomId);
    const mine = requests.filter((r) => r.inviter === this.self.id && r.id === joiner);
    if (!mine.length) return;
    let changed = false;
    for (const r of mine) {
      if (r.decision === decision) continue;
      r.decision = decision;
      r.decidedAt = this.now();
      changed = true;
    }
    if (changed) this.store.saveJoinRequests(log.roomId, requests);
    const extra = decision === "accepted" ? { roomName: state.name } : { reason: `${this.nameIn(state, by)} declined your request to join ${state.name}`, declined: true };
    this.wire
      .introduce(log.roomId, joiner, decision === "accepted" ? "join-accepted" : "join-rejected", { publicKey: this.self.publicKey, name: this.o.name(), ...extra })
      .catch((err) => this.log(`couldn't tell ${mine[0].name} yet that ${this.nameIn(state, by)} ${decision} them (they hear it when they ask again): ${(err as Error).message}`));
    this.changedSoon();
  }

  /** Drop requests decided or expired over a day ago. */
  private pruneRequests(): void {
    const now = this.now();
    for (const room of this.rooms()) {
      const requests = this.store.joinRequests(room.id);
      const keep = requests.filter((r) => (r.decision ? (r.decidedAt ?? 0) > now - REQUEST_KEEP_MS : r.expiresAt > now - REQUEST_KEEP_MS));
      if (keep.length !== requests.length) this.store.saveJoinRequests(room.id, keep);
    }
  }

  /** Show a room as another local group (the group was renamed here). */
  bindGroup(roomId: RoomId, groupKey: string): void {
    const meta = this.store.meta(roomId);
    if (!meta) throw new Error(`room ${roomId} isn't on this install`);
    this.store.setMeta(roomId, { ...meta, groupKey });
    this.changedSoon();
  }

  /** The room shown as a local group, if any. */
  roomForGroup(groupKey: string): RoomState | undefined {
    return this.rooms().find((r) => this.store.meta(r.id)?.groupKey === groupKey);
  }

  /** The local groups rooms are shown as. */
  boundGroups(): string[] {
    return this.rooms()
      .map((r) => this.store.meta(r.id)?.groupKey)
      .filter((k): k is string => !!k);
  }

  /** After sleep or a network change: reconnect now (or only one room's signaling). */
  wake(roomId?: RoomId): void {
    this.wire.wake(roomId);
  }

  /** The room's signaling connection as it is right now. */
  signalingState(roomId: RoomId): RoomSignalingState | undefined {
    return this.wire.roomStates().get(roomId);
  }

  /** Wait until the room's signaling server has let this install in, refused it, or `ms` has passed. */
  async signalingSettled(roomId: RoomId, ms: number): Promise<RoomSignalingState | undefined> {
    const until = Date.now() + ms;
    for (;;) {
      const st = this.signalingState(roomId);
      if (st?.signaling === "online" || st?.problem || Date.now() >= until) return st;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** This install's display name changed: every room hears it. */
  nameChanged(): void {
    const name = this.o.name().trim();
    if (!name) return;
    for (const room of this.rooms()) {
      if (room.members.find((m) => m.id === this.self.id)?.name !== name) this.publish(room.id, "member.renamed", { name: name.slice(0, 100) });
    }
  }

  /** Everything Settings → Team and the sidebar show. */
  status(): Pick<TeamStatus, "rooms" | "pending" | "peers" | "problems"> {
    const signaling = this.wire.roomStates();
    const rooms: TeamRoomSummary[] = this.rooms().map((r) => {
      const meta = this.store.meta(r.id);
      const sig = signaling.get(r.id);
      return {
        id: r.id,
        name: r.name,
        groupKey: meta?.groupKey ?? r.groupKey,
        members: r.members.map((m) => ({ id: m.id, name: m.name, self: m.id === this.self.id })),
        admin: roomAdmin(r),
        creator: r.creator,
        former: (r.former ?? []).map((m) => ({ id: m.id, name: m.name })),
        online: this.presence(r.id),
        signalingUrl: meta?.signalingUrl ?? "",
        signaling: sig?.signaling ?? "offline",
        ...(sig?.problem ? { problem: sig.problem } : {}),
        ...(sig?.revoke !== undefined ? { workerRevoke: sig.revoke } : {}),
        ...(sig?.approve !== undefined ? { workerApprove: sig.approve } : {}),
        requests: this.requestsOf(r),
      };
    });
    const pending: PendingJoinSummary[] = this.joins.map((j) => ({
      roomId: j.roomId,
      name: j.name,
      inviter: j.inviter,
      state: j.rejected ? (j.declined ? "declined" : "rejected") : j.inviterKey ? "syncing" : j.admin ? "approval" : "waiting",
      ...(j.adminName ? { admin: j.adminName } : {}),
      ...(j.rejected ? { reason: j.rejected } : {}),
      since: j.since,
    }));
    return { rooms, pending, peers: this.peers(), problems: [...this.store.problems, ...this.wire.problems()] };
  }

  close(): void {
    this.closed = true;
    clearInterval(this.joinTimer);
    for (const room of this.departing.values()) for (const d of room.values()) clearTimeout(d.timer);
    this.departing.clear();
    for (const l of this.lingering.values()) clearTimeout(l.timer);
    this.lingering.clear();
    for (const [id, r] of this.requests) {
      clearTimeout(r.timer);
      r.reject(new TeamError("closed", "the team transport closed"));
      this.requests.delete(id);
    }
    this.store.flush();
    this.wire.close();
  }

  // ---- the wire's events ------------------------------------------------------------------------

  private handler: WireHandler = {
    frame: (peer, text) => this.onFrame(peer, text),
    stream: (peer, text) => this.onStreamMessage(peer, text),
    up: (peer) => {
      this.helloSent.delete(peer);
      this.sendHello(peer);
      this.changedSoon();
    },
    down: (peer) => {
      this.hellos.delete(peer);
      this.helloSent.delete(peer);
      this.reassembler.drop(peer);
      for (const k of [...this.receivedSeq.keys()]) if (k.startsWith(`${peer}\n`)) this.receivedSeq.delete(k);
      for (const [id, r] of this.requests) {
        if (r.peer !== peer) continue;
        clearTimeout(r.timer);
        this.requests.delete(id);
        r.reject(new TeamError("disconnected", `${this.nameOf(peer)} disconnected before answering`));
      }
      this.presenceChanged();
      this.changedSoon();
    },
    drain: (peer) => {
      for (const h of this.drainHandlers) this.safely("a stream drain handler", () => h(peer));
    },
    intro: (roomId, from, type, body) => this.onIntro(roomId, from, type, body),
    reachable: (roomId, ids) => {
      for (const j of this.joins) if (j.roomId === roomId && !j.inviterKey && !j.rejected && ids.includes(j.inviter)) this.sendJoin(j);
    },
    roomEvents: (roomId, events) => this.onServerEvents(roomId, events),
    changed: () => this.changedSoon(),
  };

  /**
   * Removals the signaling server passed on (from revokes): signed by their
   * author, so they're checked and placed in the room's order like any event —
   * the server can drop them, never make one up. Only member.removed is taken.
   */
  private onServerEvents(roomId: RoomId, events: unknown[]): void {
    const log = this.store.get(roomId);
    if (!log?.state || !Array.isArray(events)) return;
    for (const raw of events.slice(0, 50)) {
      if (!raw || typeof raw !== "object" || (raw as RoomEvent).type !== "member.removed") {
        this.log(`ignored an event the signaling server passed on for room ${roomId} that isn't a removal`);
        continue;
      }
      try {
        const r = log.add(raw as RoomEvent);
        if (r.status === "rejected") this.log(`refused a removal the signaling server passed on for room ${roomId}: ${r.reason}`);
        else if (r.status === "pending") this.log(`a removal the signaling server passed on for room ${roomId} is by someone this install doesn't know yet; it waits`);
      } catch (err) {
        this.log(`couldn't store a removal the signaling server passed on for room ${roomId}: ${(err as Error).message}`);
      }
    }
  }

  private onFrame(peer: MemberId, text: string): void {
    let f: TeamFrame | null;
    try {
      f = this.reassembler.push(peer, text, this.now());
    } catch (err) {
      this.log(`dropped a malformed message from ${this.nameOf(peer)}: ${(err as Error).message}`);
      return;
    }
    if (!f) return;
    if (f.k === "hello") return this.onHello(peer, f);
    if (!this.hellos.has(peer)) {
      if (!this.otherProtocol.has(peer)) this.log(`dropped a ${f.k} from ${this.nameOf(peer)} before its hello`);
      return;
    }
    switch (f.k) {
      case "ev":
        return this.onEvents(peer, f.roomId, f.events);
      case "sync":
        return this.onSync(peer, f.roomId, f.summary);
      case "have":
        return this.onHave(peer, f.roomId, f.author, f.ids);
      case "req":
        return void this.onRequestFrame(peer, f);
      case "res":
        return this.onResponse(peer, f);
      default:
        this.log(`dropped an unknown ${String((f as { k: unknown }).k).slice(0, 20)} frame from ${this.nameOf(peer)}`);
    }
  }

  private onHello(peer: MemberId, f: Extract<TeamFrame, { k: "hello" }>): void {
    if (f.team !== TEAM_PROTOCOL) {
      this.otherProtocol.set(peer, f.team);
      this.hellos.delete(peer);
      this.log(`${this.nameOf(peer)} speaks team protocol ${f.team}, this Mockingbird ${TEAM_PROTOCOL}: not connecting`);
      this.presenceChanged();
      this.changedSoon();
      return;
    }
    this.otherProtocol.delete(peer);
    const before = this.hellos.get(peer)?.rooms ?? new Set<RoomId>();
    const rooms = new Set((Array.isArray(f.rooms) ? f.rooms : []).filter((r) => typeof r === "string"));
    this.hellos.set(peer, { name: typeof f.name === "string" ? f.name.slice(0, 100) : "", rooms });
    if (!before.size) this.log(`${this.nameOf(peer)} is connected (${rooms.size} shared room${rooms.size === 1 ? "" : "s"})`);
    if (!this.helloSent.has(peer)) this.sendHello(peer);
    for (const roomId of rooms) {
      if (before.has(roomId)) continue;
      if (this.allowed(peer, roomId)) {
        this.sendSync(peer, roomId);
        this.forwardRequests(roomId); // join requests held for the admin, now it's here
      } else this.tellRemoved(peer, roomId);
    }
    this.presenceChanged();
    this.changedSoon();
  }

  /**
   * A peer still lists a room it was removed from (it was offline then): it
   * gets what decides membership up to its removal, enough to verify it there
   * — nothing said after it.
   */
  private tellRemoved(peer: MemberId, roomId: RoomId): void {
    const log = this.store.get(roomId);
    if (!log || !this.room(roomId) || !log.wasMember(peer)) return;
    const events = log.membershipUpTo(peer);
    if (!events.length) return;
    this.log(`${this.nameOf(peer)} still lists ${log.state!.name}, which they're no longer in: telling them`);
    for (let i = 0; i < events.length; i += 200) this.sendFrame(peer, { k: "ev", roomId, events: events.slice(i, i + 200) });
  }

  private onEvents(peer: MemberId, roomId: RoomId, events: RoomEvent[]): void {
    if (!this.allowed(peer, roomId)) return this.log(`refused events for room ${roomId} from ${this.nameOf(peer)}, who isn't a member`);
    if (!Array.isArray(events)) return this.log(`dropped a malformed event batch from ${this.nameOf(peer)}`);
    const log = this.store.get(roomId) ?? this.watch(this.store.open(roomId));
    this.applyingFrom = peer;
    try {
      for (const e of events) {
        let r;
        try {
          r = log.add(e);
        } catch (err) {
          this.log(`couldn't store event ${e?.id} in room ${roomId}: ${(err as Error).message}`);
          continue;
        }
        if (r.status === "rejected") this.log(`refused event ${String(e?.id)} (${String(e?.type)}) in room ${roomId} from ${this.nameOf(peer)}: ${r.reason}`);
      }
    } finally {
      this.applyingFrom = null;
    }
    this.completeJoin(roomId);
  }

  private onSync(peer: MemberId, roomId: RoomId, summary: unknown): void {
    if (!this.allowed(peer, roomId)) return this.log(`refused a sync of room ${roomId} from ${this.nameOf(peer)}, who isn't a member`);
    const log = this.store.get(roomId) ?? this.watch(this.store.open(roomId));
    for (const author of log.differingAuthors((summary ?? {}) as Record<string, { n: number; h: string }>)) {
      this.sendFrame(peer, { k: "have", roomId, author, ids: log.idsBy(author) });
    }
  }

  private onHave(peer: MemberId, roomId: RoomId, author: MemberId, ids: unknown): void {
    if (!this.allowed(peer, roomId)) return;
    const log = this.store.get(roomId);
    if (!log || !Array.isArray(ids)) return;
    const missing = log.missingFor(author, ids as string[]);
    for (let i = 0; i < missing.length; i += 200) this.sendFrame(peer, { k: "ev", roomId, events: missing.slice(i, i + 200) });
  }

  private async onRequestFrame(peer: MemberId, f: Extract<TeamFrame, { k: "req" }>): Promise<void> {
    const answer = (res: { ok: true; result: unknown } | { ok: false; error: string; code: string }) => this.sendFrame(peer, { k: "res", id: f.id, ...res } as TeamFrame);
    if (f.roomId !== undefined && !this.allowed(peer, f.roomId)) {
      this.log(`refused ${f.method} from ${this.nameOf(peer)}: not a member of room ${f.roomId}`);
      return void answer({ ok: false, code: "forbidden", error: "not a member of that room" });
    }
    const handler = this.requestHandlers.get(f.method);
    if (!handler) return void answer({ ok: false, code: "no-handler", error: `no handler for ${f.method}` });
    try {
      const result = await handler(f.params, { from: peer, ...(f.roomId ? { roomId: f.roomId } : {}) });
      answer({ ok: true, result: result ?? null });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.log(`answering ${f.method} for ${this.nameOf(peer)} failed: ${why}`);
      answer({ ok: false, code: "remote", error: why });
    }
  }

  private onResponse(peer: MemberId, f: Extract<TeamFrame, { k: "res" }>): void {
    const r = this.requests.get(f.id);
    if (!r || r.peer !== peer) return this.log(`dropped an answer from ${this.nameOf(peer)} to a request it wasn't sent (${f.id})`);
    clearTimeout(r.timer);
    this.requests.delete(f.id);
    if (f.ok) r.resolve(f.result);
    else r.reject(new TeamError(f.code === "no-handler" || f.code === "forbidden" ? f.code : "remote", f.error));
  }

  private onStreamMessage(peer: MemberId, text: string): void {
    let f: StreamFrame;
    try {
      f = JSON.parse(text);
    } catch {
      return this.log(`dropped a malformed stream message from ${this.nameOf(peer)}`);
    }
    if (typeof f?.r !== "string" || typeof f.c !== "string" || typeof f.q !== "number" || typeof f.d !== "string") return this.log(`dropped a malformed stream message from ${this.nameOf(peer)}`);
    if (!this.hellos.has(peer) || !this.allowed(peer, f.r)) {
      // said once per peer and room: a stream is many messages
      const k = key(peer, f.r);
      if (!this.refusedStreams.has(k)) this.log(`refused a ${f.c} stream for room ${f.r} from ${this.nameOf(peer)}, who isn't a member`);
      this.refusedStreams.add(k);
      return;
    }
    const k = key(peer, f.r, f.c);
    const last = this.receivedSeq.get(k);
    if (last !== undefined && f.q <= last) return; // a stale chunk from before a reconnect
    this.receivedSeq.set(k, f.q);
    // the first chunk heard on a channel is a gap unless it's the channel's first
    const ctx: StreamContext = { roomId: f.r, from: peer, seq: f.q, gap: f.q !== (last ?? 0) + 1 };
    for (const [channel, handlers] of this.streamHandlers) {
      const match = channel.endsWith("*") ? f.c.startsWith(channel.slice(0, -1)) : channel === f.c;
      if (match) for (const h of handlers) this.safely(`a ${f.c} stream handler`, () => h(f.d, ctx));
    }
  }

  // ---- joins ---------------------------------------------------------------------------------

  private sendJoin(j: PendingJoin): void {
    const body = { name: this.o.name() || "teammate", publicKey: this.self.publicKey, proof: joinProof(j.token, j.roomId, this.self.publicKey) };
    this.wire.introduce(j.roomId, j.inviter, "join", body).catch((err) => this.log(`couldn't reach the inviter of ${j.name} yet: ${(err as Error).message}`));
  }

  private retryJoins(): void {
    const tick = this.joinTicks++;
    const now = this.now();
    let ended = false;
    const signaling = this.wire.roomStates();
    for (const j of this.joins) {
      if (j.inviterKey || j.rejected) continue;
      if (signaling.get(j.roomId)?.code === "declined") {
        // the signaling server dropped this install at the door: the admin declined (the inviter says so too, when it can reach it)
        j.rejected = `${j.adminName ?? "The room's admin"} declined your request to join ${j.name}`;
        j.declined = true;
        ended = true;
        this.log(`joining ${j.name}: ${j.rejected}`);
        continue;
      }
      if (j.expiresAt && j.expiresAt <= now) {
        j.rejected = `The code expired before ${j.adminName ?? "the room's admin"} accepted — ask for a new one`;
        ended = true;
        this.log(`joining ${j.name}: ${j.rejected}`);
        continue;
      }
      // waiting for the admin: ask the inviter now and then, which also hears an answer it couldn't send
      if (!j.admin || tick % WAITING_RETRY_EVERY === 0) this.sendJoin(j);
    }
    if (ended) {
      this.store.savePendingJoins(this.joins);
      this.syncWire();
      this.changedSoon();
    }
    for (const room of this.rooms()) this.forwardRequests(room.id);
    if (tick % 40 === 0) this.safely("pruning join requests", () => this.pruneRequests());
  }

  private onIntro(roomId: RoomId, from: MemberId, type: IntroType, body: any): void {
    if (!body || typeof body.publicKey !== "string" || !PUBLIC_KEY_RE.test(body.publicKey) || fingerprintOf(body.publicKey) !== from) {
      return this.log(`dropped a ${type} for room ${roomId} whose key isn't its sender's`);
    }
    if (type === "join") return this.onJoinIntro(roomId, from, body);
    const j = this.joins.find((x) => x.roomId === roomId);
    if (!j || j.inviter !== from) return this.log(`dropped a ${type} for room ${roomId} from ${from}, who isn't the inviter of a pending join`);
    if (type === "join-pending") {
      if (j.inviterKey || j.rejected) return;
      const admin = typeof body.admin === "string" && MEMBER_ID_RE.test(body.admin) ? body.admin : undefined;
      const adminName = typeof body.adminName === "string" && body.adminName.trim() ? body.adminName.trim().slice(0, 100) : undefined;
      const expiresAt = typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt) ? body.expiresAt : undefined;
      if (j.admin === admin && j.adminName === adminName && j.expiresAt === expiresAt) return;
      Object.assign(j, { admin, adminName, expiresAt });
      this.log(`joining ${j.name}: waiting for ${adminName ?? "the room's admin"} to accept`);
    } else if (type === "join-accepted") {
      if (j.inviterKey) return;
      j.inviterKey = body.publicKey;
      j.rejected = undefined;
      this.log(`${typeof body.name === "string" ? body.name : from} let this install into ${j.name}; copying the room`);
    } else {
      j.rejected = typeof body.reason === "string" ? body.reason.slice(0, 300) : "The inviter refused the code";
      j.declined = body.declined === true || undefined;
      this.log(`joining ${j.name} was refused: ${j.rejected}`);
    }
    this.store.savePendingJoins(this.joins);
    this.syncWire();
    this.changedSoon();
  }

  /**
   * Someone asks to join with a code this install made: the proof is
   * checked, the code is taken (it works once, whatever the admin says), and
   * the request goes to the room's admin — this install, or passed on. The
   * joiner hears whom it waits for, and later how it went.
   */
  private onJoinIntro(roomId: RoomId, from: MemberId, body: { publicKey: string; name?: unknown; proof?: unknown }): void {
    const log = this.store.get(roomId);
    if (!log?.state || !log.isMember(this.self.id)) return this.log(`dropped a join request for room ${roomId}, which isn't on this install`);
    const state = log.state;
    const reply = (type: IntroType, extra: Record<string, unknown>) =>
      this.wire.introduce(roomId, from, type, { publicKey: this.self.publicKey, name: this.o.name(), ...extra }).catch((err) => this.log(`couldn't answer ${from}'s join request: ${(err as Error).message}`));
    if (log.isMember(from)) return void reply("join-accepted", { roomName: state.name });
    const proof = typeof body.proof === "string" ? body.proof : "";
    const now = this.now();
    const invites = this.store.invites(roomId);
    const match = invites.find((i) => sameSecret(joinProof(i.token, roomId, body.publicKey), proof));
    const refuse = (reason: string, extra: Record<string, unknown> = {}) => {
      this.log(`refused ${from}'s request to join ${state.name}: ${reason}`);
      void reply("join-rejected", { reason, ...extra });
    };
    if (!match) return refuse("That room code isn't valid for this room — ask for a new one");
    if (match.usedAt && match.usedBy !== from) return refuse("That room code was already used — ask for a new one");
    if (!match.usedAt && match.expiresAt < now) return refuse("That room code expired — ask for a new one");
    if (!match.usedAt) {
      match.usedAt = now;
      match.usedBy = from;
      this.store.saveInvites(roomId, invites);
    }
    const admin = roomAdmin(state);
    const adminName = admin ? this.nameIn(state, admin) : "the room's admin";
    let r = this.store.joinRequests(roomId).find((x) => x.id === from && x.invite === match.tokenHash);
    if (!r) {
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 100) : "teammate";
      const fields: JoinRequestFields = { roomId, id: from, publicKey: body.publicKey, name, inviter: this.self.id, invite: match.tokenHash, at: now, expiresAt: Math.min(match.expiresAt, now + MAX_INVITE_MS) };
      r = { ...fields, sig: this.identity.sign(joinRequestPayload(fields)) };
      this.holdRequest(roomId, r);
      this.log(`${name} (${from}) asks to join ${state.name}${admin === this.self.id ? "" : `: passing it on to ${adminName}`}`);
    }
    if (r.decision === "declined") return refuse(`${adminName} declined your request to join ${state.name}`, { declined: true });
    // let in once with this code, and not a member now (removed since): it's used
    if (r.decision === "accepted") return refuse("That room code was already used — ask for a new one");
    if (r.expiresAt <= now) return refuse(`The code expired before ${adminName} accepted — ask for a new one`);
    this.forwardRequests(roomId);
    void reply("join-pending", { admin, adminName, expiresAt: r.expiresAt });
  }

  /** A pending join whose room has arrived with this install as a member is done. */
  private completeJoin(roomId: RoomId): void {
    const j = this.joins.find((x) => x.roomId === roomId);
    const state = this.store.get(roomId)?.state;
    if (!j || !state || !state.members.some((m) => m.id === this.self.id) || !state.members.some((m) => m.id === j.inviter)) return;
    this.store.setMeta(roomId, { signalingUrl: j.url, groupKey: this.o.groupKeyFor?.(state) ?? state.groupKey });
    this.joins = this.joins.filter((x) => x.roomId !== roomId);
    this.store.savePendingJoins(this.joins);
    this.log(`joined ${state.name}`);
    this.syncWire();
    this.changedSoon();
  }

  // ---- helpers ------------------------------------------------------------------------------

  /** Hook a room's log up: applied events reach handlers and the room's other members. */
  private watch(log: RoomLog): RoomLog {
    log.onApplied = (e) => this.applied(log, e);
    return log;
  }

  private applied(log: RoomLog, e: RoomEvent): void {
    const state = log.state;
    if (state) {
      for (const type of [e.type, "*"]) {
        for (const h of this.eventHandlers.get(type) ?? []) this.safely(`a ${e.type} handler`, () => h(e, state));
      }
    }
    this.outbox.push({ roomId: log.roomId, event: e, from: this.applyingFrom });
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => this.flushOutbox());
    }
    if (e.type === "member.removed") {
      // a teammate who's gone stays connected a moment, so what's in flight (their removal, its confirmation) gets through
      const member = (e.body as RoomEventBodies["member.removed"])?.member;
      const former = state?.former?.find((f) => f.id === member);
      if (member !== this.self.id && former && !log.isMember(member) && this.hellos.has(member)) this.depart(log.roomId, member, former.publicKey, this.departGraceMs);
      if (member === this.self.id && former && !this.leaving.has(log.roomId)) this.linger(log.roomId, e.id);
      this.ensureApproval(log); // this install may be the admin now
    }
    // the admin decided a join this install took as the inviter: the joiner hears it from here
    if (e.type === "member.added") {
      const added = (e.body as RoomEventBodies["member.added"])?.id;
      if (added && log.isMember(added)) this.relayDecision(log, added, "accepted", e.author);
    }
    if (e.type === "join.declined" && state && roomAdmin(state) === e.author) {
      const b = e.body as RoomEventBodies["join.declined"];
      if (b?.inviter === this.self.id && !log.isMember(b.id)) this.relayDecision(log, b.id, "declined", e.author);
    }
    if (e.type === "member.added" || e.type === "room.created" || e.type === "member.removed") this.syncWire();
    this.checkLeft(log);
    this.changedSoon();
  }

  /**
   * Pass newly applied events on to the room's connected members (but not
   * back to where they came from). A removal also reaches the member removed
   * (what happened up to it), and the leave of this install reaches the
   * members it leaves behind.
   */
  private flushOutbox(): void {
    this.flushQueued = false;
    const out = this.outbox;
    this.outbox = [];
    for (const roomId of new Set(out.map((o) => o.roomId))) {
      const batch = out.filter((o) => o.roomId === roomId);
      const state = this.store.get(roomId)?.state;
      const leaving = this.leaving.has(roomId);
      for (const [peer, hello] of this.hellos) {
        if (!hello.rooms.has(roomId)) continue;
        let events: RoomEvent[];
        if (this.allowed(peer, roomId) || (leaving && state?.members.some((m) => m.id === peer))) {
          events = batch.filter((o) => o.from !== peer).map((o) => o.event);
        } else {
          const removal = batch.findIndex((o) => o.event.type === "member.removed" && (o.event.body as RoomEventBodies["member.removed"])?.member === peer);
          if (removal < 0) continue;
          events = batch.slice(0, removal + 1).filter((o) => o.from !== peer).map((o) => o.event);
        }
        for (let i = 0; i < events.length; i += 200) this.sendFrame(peer, { k: "ev", roomId, events: events.slice(i, i + 200) });
      }
    }
  }

  /** The room's log, when this install is a member of it. */
  private memberLog(roomId: RoomId): RoomLog {
    const log = this.store.get(roomId);
    if (!log?.state || !log.isMember(this.self.id)) throw new TeamError("not-member", `not a member of room ${roomId}`);
    return log;
  }

  /** May `peer` act in `roomId`: a member, or the inviter of a join this install has pending. */
  private allowed(peer: MemberId, roomId: RoomId): boolean {
    if (this.store.get(roomId)?.isMember(peer) && this.room(roomId)) return true;
    return this.joins.some((j) => j.roomId === roomId && j.inviter === peer && !!j.inviterKey);
  }

  /** Rooms this install shares with `peer` (for its hello). */
  private sharedRooms(peer: MemberId): RoomId[] {
    const ids = this.rooms()
      .filter((r) => r.members.some((m) => m.id === peer))
      .map((r) => r.id);
    for (const j of this.joins) if (j.inviter === peer && j.inviterKey) ids.push(j.roomId);
    return ids.sort();
  }

  private sendHello(peer: MemberId): void {
    const rooms = this.sharedRooms(peer);
    const sig = rooms.join(",");
    if (this.helloSent.get(peer) === sig) return;
    if (this.sendFrame(peer, { k: "hello", team: TEAM_PROTOCOL, name: this.o.name(), rooms })) this.helloSent.set(peer, sig);
  }

  private sendSync(peer: MemberId, roomId: RoomId): void {
    const log = this.store.get(roomId) ?? this.watch(this.store.open(roomId));
    this.sendFrame(peer, { k: "sync", roomId, summary: log.summary() });
  }

  private sendFrame(peer: MemberId, f: TeamFrame): boolean {
    let messages: string[];
    try {
      messages = encodeFrame(f);
    } catch (err) {
      this.log(`couldn't send a ${f.k} to ${this.nameOf(peer)}: ${(err as Error).message}`);
      return false;
    }
    for (const m of messages) if (!this.wire.send(peer, m)) return false;
    return true;
  }

  /** Tell the wire which rooms to be in, and re-hello peers whose shared rooms changed. */
  /**
   * A room as the wire is told it: its members (and those just removed, until
   * their removal reached them), the keys to admit and — from the room's
   * admin — the former members to keep cut off at the signaling server.
   */
  private wireRoomOf(log: RoomLog): WireRoom | null {
    const state = log.state;
    if (!state) return null;
    const meta = this.store.meta(log.roomId);
    if (!meta) {
      this.log(`room ${state.name} has no signaling URL on this install; it can't connect`);
      return null;
    }
    const now = this.now();
    const created = log.all().find((e) => e.type === "room.created") as RoomEvent<"room.created"> | undefined;
    const invites: StoredInvite[] = this.store.invites(log.roomId);
    const departing = [...(this.departing.get(log.roomId) ?? [])].filter(([id]) => !state.members.some((m) => m.id === id)).map(([id, d]) => ({ id, publicKey: d.publicKey }));
    // (someone being removed right now is revoked by removeMember itself)
    const revoke = roomAdmin(state) === this.self.id ? (state.former ?? []).filter((f) => !this.removing.has(key(log.roomId, f.id))).map((f) => ({ member: f.id, event: log.removalOf(f.id) })) : [];
    return {
      roomId: log.roomId,
      url: meta.signalingUrl,
      members: [...state.members.map((m) => ({ id: m.id, publicKey: m.publicKey })), ...departing],
      admit: state.members.map((m) => m.publicKey),
      ...(state.creator === this.self.id && created ? { create: created.body.salt } : {}),
      invites: invites.filter((i) => !i.usedAt && i.expiresAt > now).map((i) => ({ tokenHash: i.tokenHash, expiresAt: i.expiresAt })),
      ...(revoke.length ? { revoke } : {}),
    };
  }

  private syncWire(): void {
    if (this.closed) return;
    const rooms: WireRoom[] = [];
    const pendingIds = new Set(this.joins.map((j) => j.roomId));
    // rooms being left, or just removed from, stay as they were a while: the leave (or its confirmation) still has to get through
    for (const [roomId, spec] of [...this.leaving, ...[...this.lingering].map(([id, l]): [RoomId, WireRoom] => [id, l.spec])]) {
      if (!pendingIds.has(roomId) && !rooms.some((r) => r.roomId === roomId)) rooms.push(spec);
    }
    for (const log of this.store.list()) {
      if (rooms.some((r) => r.roomId === log.roomId)) continue;
      if (!log.state || !log.isMember(this.self.id) || pendingIds.has(log.roomId)) continue;
      const spec = this.wireRoomOf(log);
      if (!spec) continue;
      rooms.push(spec);
      this.lastSpecs.set(log.roomId, spec);
    }
    for (const j of this.joins) {
      if (j.rejected) continue;
      rooms.push({
        roomId: j.roomId,
        url: j.url,
        members: j.inviterKey ? [{ id: j.inviter, publicKey: j.inviterKey }] : [],
        admit: [],
        join: signalingJoinKey(j.token),
        invites: [],
      });
    }
    this.wire.setRooms(rooms);
    for (const peer of this.hellos.keys()) this.sendHello(peer);
    for (const peer of this.wire.connected()) if (!this.hellos.has(peer)) this.sendHello(peer);
    this.presenceChanged();
  }

  private presenceChanged(): void {
    const ids = new Set([...this.rooms().map((r) => r.id), ...this.lastPresence.keys()]);
    for (const roomId of ids) {
      const online = this.presence(roomId);
      const sig = online.join(",");
      if ((this.lastPresence.get(roomId) ?? "") === sig) continue;
      this.lastPresence.set(roomId, sig);
      for (const h of this.presenceHandlers) this.safely("a presence handler", () => h(roomId, online));
    }
  }

  private changedSoon(): void {
    if (this.changeQueued) return;
    this.changeQueued = true;
    queueMicrotask(() => {
      this.changeQueued = false;
      this.presenceChanged();
      for (const h of this.roomHandlers) this.safely("a rooms-changed handler", h);
    });
  }

  private nameOf(id: MemberId): string {
    for (const r of this.rooms()) {
      const m = r.members.find((x) => x.id === id) ?? r.former?.find((x) => x.id === id);
      if (m) return m.name;
    }
    return this.hellos.get(id)?.name || id.slice(0, 8);
  }

  private nameIn(room: RoomState, id: MemberId): string {
    return (room.members.find((m) => m.id === id) ?? room.former?.find((m) => m.id === id))?.name || this.nameOf(id);
  }

  private safely(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log(`${what} failed: ${(err as Error).stack ?? err}`);
    }
  }
}

/** A forwarded join request's fields, when every one is the right shape and its key is its id's; else null. */
function joinRequestOf(p: unknown, roomId: RoomId): JoinRequestRecord | null {
  if (!p || typeof p !== "object") return null;
  const x = p as Record<string, unknown>;
  const ok =
    x.roomId === roomId &&
    typeof x.id === "string" &&
    MEMBER_ID_RE.test(x.id) &&
    typeof x.publicKey === "string" &&
    PUBLIC_KEY_RE.test(x.publicKey) &&
    fingerprintOf(x.publicKey) === x.id &&
    typeof x.name === "string" &&
    x.name.trim().length > 0 &&
    x.name.length <= 100 &&
    typeof x.inviter === "string" &&
    MEMBER_ID_RE.test(x.inviter) &&
    typeof x.invite === "string" &&
    TOKEN_RE.test(x.invite) &&
    typeof x.at === "number" &&
    Number.isFinite(x.at) &&
    typeof x.expiresAt === "number" &&
    Number.isFinite(x.expiresAt) &&
    typeof x.sig === "string" &&
    SIGNATURE_RE.test(x.sig);
  if (!ok) return null;
  return { roomId, id: x.id as string, publicKey: x.publicKey as string, name: x.name as string, inviter: x.inviter as string, invite: x.invite as string, at: x.at as number, expiresAt: x.expiresAt as number, sig: x.sig as string };
}

