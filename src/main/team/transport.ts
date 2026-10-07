import { decodeInvite, encodeInvite, PUBLIC_KEY_RE, TEAM_PROTOCOL, type SignalType } from "../../shared/team/protocol";
import type { MemberId, PeerLinkState, PeerStatus, PendingJoinSummary, RoomEvent, RoomEventBodies, RoomEventType, RoomId, RoomState, TeamRoomSummary, TeamStatus } from "../../shared/team/types";
import { encodeFrame, MAX_STREAM_CHUNK, Reassembler, splitText, type StreamFrame, type TeamFrame } from "./frames";
import { fingerprintOf, joinProof, randomToken, roomIdFor, sameSecret, signalingJoinKey, signalingTokenHash, type Identity } from "./identity";
import type { PendingJoin, RoomLog, RoomStore, StoredInvite } from "./rooms";

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

export type IntroType = Extract<SignalType, "join" | "join-accepted" | "join-rejected">;

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
}

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
  linkStates(): Map<MemberId, { state: PeerLinkState; detail?: string; since: number }>;
  roomStates(): Map<RoomId, { signaling: "online" | "connecting" | "offline"; problem?: string }>;
  problems(): string[];
  /** After sleep or a network change: reconnect everything now. */
  wake(): void;
  close(): void;
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
  log?: (msg: string) => void;
}

interface PendingRequest {
  peer: MemberId;
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const key = (...parts: string[]) => parts.join("\n");

export class TeamCore implements Team {
  readonly self: { id: MemberId; publicKey: string };
  private readonly identity: Identity;
  private readonly store: RoomStore;
  private readonly wire: PeerWire;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly requestTimeoutMs: number;
  private readonly inviteTtlMs: number;

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
  private joins: PendingJoin[];
  private lastPresence = new Map<RoomId, string>();
  /** Events just applied, to pass on to the room's other members (not back to the member they came from). */
  private outbox: { roomId: RoomId; event: RoomEvent; from: MemberId | null }[] = [];
  private applyingFrom: MemberId | null = null;
  private flushQueued = false;
  private changeQueued = false;
  private joinTimer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private o: TeamOptions) {
    this.identity = o.identity;
    this.self = { id: o.identity.id, publicKey: o.identity.publicKey };
    this.store = o.store;
    this.wire = o.wire;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.log(`[team] ${m}`));
    this.requestTimeoutMs = o.requestTimeoutMs ?? 15_000;
    this.inviteTtlMs = o.inviteTtlMs ?? 7 * 24 * 3_600_000;
    this.joins = this.store.pendingJoins();
    for (const log of this.store.list()) this.watch(log);
    this.wire.setHandler(this.handler);
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
    log.create(this.identity, "room.created", { name: spec.name, groupKey: spec.groupKey, publicKey: this.self.publicKey, creatorName: this.o.name(), salt }, this.now());
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

  /** Give up on a pasted code. */
  cancelJoin(roomId: RoomId): void {
    this.joins = this.joins.filter((j) => j.roomId !== roomId);
    this.store.savePendingJoins(this.joins);
    this.syncWire();
    this.changedSoon();
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

  /** After sleep or a network change: reconnect now. */
  wake(): void {
    this.wire.wake();
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
        online: this.presence(r.id),
        signalingUrl: meta?.signalingUrl ?? "",
        signaling: sig?.signaling ?? "offline",
        ...(sig?.problem ? { problem: sig.problem } : {}),
      };
    });
    const pending: PendingJoinSummary[] = this.joins.map((j) => ({
      roomId: j.roomId,
      name: j.name,
      inviter: j.inviter,
      state: j.rejected ? "rejected" : j.inviterKey ? "syncing" : "waiting",
      ...(j.rejected ? { reason: j.rejected } : {}),
      since: j.since,
    }));
    return { rooms, pending, peers: this.peers(), problems: [...this.store.problems, ...this.wire.problems()] };
  }

  close(): void {
    this.closed = true;
    clearInterval(this.joinTimer);
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
    changed: () => this.changedSoon(),
  };

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
    for (const roomId of rooms) if (!before.has(roomId) && this.allowed(peer, roomId)) this.sendSync(peer, roomId);
    this.presenceChanged();
    this.changedSoon();
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
    if (!this.hellos.has(peer) || !this.allowed(peer, f.r)) return;
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
    for (const j of this.joins) if (!j.inviterKey && !j.rejected) this.sendJoin(j);
  }

  private onIntro(roomId: RoomId, from: MemberId, type: IntroType, body: any): void {
    if (!body || typeof body.publicKey !== "string" || !PUBLIC_KEY_RE.test(body.publicKey) || fingerprintOf(body.publicKey) !== from) {
      return this.log(`dropped a ${type} for room ${roomId} whose key isn't its sender's`);
    }
    if (type === "join") return this.onJoinRequest(roomId, from, body);
    const j = this.joins.find((x) => x.roomId === roomId);
    if (!j || j.inviter !== from) return this.log(`dropped a ${type} for room ${roomId} from ${from}, who isn't the inviter of a pending join`);
    if (type === "join-accepted") {
      if (j.inviterKey) return;
      j.inviterKey = body.publicKey;
      j.rejected = undefined;
      this.log(`${typeof body.name === "string" ? body.name : from} accepted the join of ${j.name}; copying the room`);
    } else {
      j.rejected = typeof body.reason === "string" ? body.reason.slice(0, 300) : "The inviter refused the code";
      this.log(`joining ${j.name} was refused: ${j.rejected}`);
    }
    this.store.savePendingJoins(this.joins);
    this.syncWire();
    this.changedSoon();
  }

  private onJoinRequest(roomId: RoomId, from: MemberId, body: { publicKey: string; name?: unknown; proof?: unknown }): void {
    const log = this.store.get(roomId);
    if (!log?.state || !log.isMember(this.self.id)) return this.log(`dropped a join request for room ${roomId}, which isn't on this install`);
    const reply = (type: IntroType, extra: Record<string, unknown>) =>
      this.wire.introduce(roomId, from, type, { publicKey: this.self.publicKey, name: this.o.name(), ...extra }).catch((err) => this.log(`couldn't answer ${from}'s join request: ${(err as Error).message}`));
    if (log.isMember(from)) return void reply("join-accepted", { roomName: log.state.name });
    const proof = typeof body.proof === "string" ? body.proof : "";
    const now = this.now();
    const invites = this.store.invites(roomId);
    const match = invites.find((i) => sameSecret(joinProof(i.token, roomId, body.publicKey), proof));
    const refuse = (reason: string) => {
      this.log(`refused ${from}'s request to join ${log.state!.name}: ${reason}`);
      void reply("join-rejected", { reason });
    };
    if (!match) return refuse("That room code isn't valid for this room — ask for a new one");
    if (match.usedAt && match.usedBy !== from) return refuse("That room code was already used — ask for a new one");
    if (!match.usedAt && match.expiresAt < now) return refuse("That room code expired — ask for a new one");
    if (!match.usedAt) {
      match.usedAt = now;
      match.usedBy = from;
      this.store.saveInvites(roomId, invites);
    }
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 100) : "teammate";
    this.publish(roomId, "member.added", { id: from, name, publicKey: body.publicKey });
    this.log(`${name} (${from}) joined ${log.state.name}`);
    this.syncWire();
    void reply("join-accepted", { roomName: log.state.name });
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
    if (e.type === "member.added" || e.type === "room.created") this.syncWire();
    this.changedSoon();
  }

  /** Pass newly applied events on to the room's connected members (but not back to where they came from). */
  private flushOutbox(): void {
    this.flushQueued = false;
    const out = this.outbox;
    this.outbox = [];
    for (const roomId of new Set(out.map((o) => o.roomId))) {
      for (const peer of this.presence(roomId)) {
        const events = out.filter((o) => o.roomId === roomId && o.from !== peer).map((o) => o.event);
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
  private syncWire(): void {
    if (this.closed) return;
    const now = this.now();
    const rooms: WireRoom[] = [];
    const pendingIds = new Set(this.joins.map((j) => j.roomId));
    for (const log of this.store.list()) {
      const state = log.state;
      if (!state || !log.isMember(this.self.id) || pendingIds.has(log.roomId)) continue;
      const meta = this.store.meta(log.roomId);
      if (!meta) {
        this.log(`room ${state.name} has no signaling URL on this install; it can't connect`);
        continue;
      }
      const created = log.all().find((e) => e.type === "room.created") as RoomEvent<"room.created"> | undefined;
      const invites: StoredInvite[] = this.store.invites(log.roomId);
      rooms.push({
        roomId: log.roomId,
        url: meta.signalingUrl,
        members: state.members.map((m) => ({ id: m.id, publicKey: m.publicKey })),
        admit: state.members.map((m) => m.publicKey),
        ...(state.creator === this.self.id && created ? { create: created.body.salt } : {}),
        invites: invites.filter((i) => !i.usedAt && i.expiresAt > now).map((i) => ({ tokenHash: i.tokenHash, expiresAt: i.expiresAt })),
      });
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
      const m = r.members.find((x) => x.id === id);
      if (m) return m.name;
    }
    return this.hellos.get(id)?.name || id.slice(0, 8);
  }

  private safely(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log(`${what} failed: ${(err as Error).stack ?? err}`);
    }
  }
}

