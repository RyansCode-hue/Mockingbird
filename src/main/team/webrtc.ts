import { randomNonce, verifySignature, fingerprintOf, type Identity } from "./identity";
import { SignalingClient, type SignalingEvent } from "./signalingClient";
import type { IntroType, PeerWire, WireHandler, WireRoom } from "./transport";
import { envelopeProblem, INTRO_TYPES, PUBLIC_KEY_RE, ReplayGuard, sdpFingerprint, signalPayload, TEAM_PROTOCOL, type IceServer, type SignalType, type SignedEnvelope, type UnsignedEnvelope } from "../../shared/team/protocol";
import { FINGERPRINT_MISMATCH, type HostCommand, type HostEvent, type IceCandidate, type Route } from "../../shared/team/peerHost";
import type { MemberId, PeerLinkState, RoomId } from "../../shared/team/types";

/**
 * The WebRTC wire: teammates connected peer to peer, introduced by each
 * room's signaling server. Main does everything that needs a key — signing
 * this install's connection details, checking the other side's against the
 * room's members, extracting the DTLS fingerprint to pin — and drives the
 * hidden peer host (PeerHostBridge), which only runs the connections.
 *
 * One connection per teammate, whatever rooms they share. The member with
 * the lower id offers; the other knocks when it wants a connection. Each
 * connection attempt has an epoch, so details from an earlier attempt are
 * ignored. A connection that drops is repaired by an ICE restart, else
 * replaced; the host restarting loses every connection, which are then made
 * again (room state lives in main and isn't touched).
 */

export interface PeerHostBridge {
  /** Delivered once the host is ready; commands from before a restart are dropped. */
  command(cmd: HostCommand): void;
  setListener(cb: (e: HostEvent) => void): void;
  start(): void;
  stop(): void;
}

export interface WebRtcTiming {
  /** Give up on an attempt that hasn't opened by then. */
  connectTimeoutMs: number;
  /** Wait this long after "disconnected" before repairing. */
  disconnectGraceMs: number;
  /** Delays between attempts (the last repeats). */
  retryMs: number[];
  /** Least time between knocks. */
  knockMs: number;
  /** Start connecting without TURN credentials if the signaling server hasn't sent them by then. */
  iceWaitMs: number;
}

export const DEFAULT_TIMING: WebRtcTiming = {
  connectTimeoutMs: 30_000,
  disconnectGraceMs: 5_000,
  retryMs: [1000, 3000, 8000, 20000, 60000],
  knockMs: 4000,
  iceWaitMs: 3000,
};

export interface WebRtcWireOptions {
  identity: Identity;
  host: PeerHostBridge;
  log: (msg: string) => void;
  WebSocketImpl?: typeof WebSocket;
  /** ICE servers before the signaling server's arrive (the app: public STUN; tests: none). */
  defaultIce?: IceServer[];
  timing?: Partial<WebRtcTiming>;
}

interface Peer {
  id: MemberId;
  link: "idle" | "connecting" | "open";
  /** The handler was told it's up. */
  up: boolean;
  epoch: string | null;
  role: "offerer" | "answerer";
  since: number;
  route: Route | null;
  /** The last refusal or failure worth showing. */
  error: string | null;
  attempts: number;
  congested: boolean;
  lastKnock: number;
  /** TEAM_PROTOCOL announced on the signaling server, when it isn't ours. */
  otherProtocol: number | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  connectTimer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

interface Room {
  spec: WireRoom;
  client: SignalingClient;
  /** Invites and admits this connection has registered. */
  registered: Set<string>;
  admitted: string;
}

const PUBLIC_STUN: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

export class WebRtcWire implements PeerWire {
  readonly self: MemberId;
  private handler: WireHandler | null = null;
  private rooms = new Map<RoomId, Room>();
  private peers = new Map<MemberId, Peer>();
  private replay = new ReplayGuard();
  private ice: { servers: IceServer[]; ready: boolean; fetchedAt: number; ttl: number; relay: boolean; problem: string | null };
  private iceTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setInterval>;
  private readonly timing: WebRtcTiming;
  private hostReady = false;
  private closed = false;

  constructor(private o: WebRtcWireOptions) {
    this.self = o.identity.id;
    this.timing = { ...DEFAULT_TIMING, ...o.timing };
    this.ice = { servers: o.defaultIce ?? PUBLIC_STUN, ready: false, fetchedAt: 0, ttl: 0, relay: false, problem: null };
    o.host.setListener((e) => this.onHost(e));
    this.refreshTimer = setInterval(() => this.refreshIce(), 60_000);
    this.refreshTimer.unref?.();
  }

  setHandler(h: WireHandler): void {
    this.handler = h;
  }

  // ---- PeerWire -------------------------------------------------------------------------

  setRooms(rooms: WireRoom[]): void {
    if (this.closed) return;
    const want = new Map(rooms.map((r) => [r.roomId, r]));
    for (const [id, room] of this.rooms) {
      const next = want.get(id);
      if (!next || next.url !== room.spec.url || next.create !== room.spec.create || next.join !== room.spec.join) {
        room.client.stop();
        this.rooms.delete(id);
      }
    }
    for (const spec of rooms) {
      const room = this.rooms.get(spec.roomId);
      if (room) {
        room.spec = spec;
        this.register(room);
        continue;
      }
      const r: Room = { spec, registered: new Set(), admitted: "", client: null as unknown as SignalingClient };
      r.client = new SignalingClient({
        url: spec.url,
        roomId: spec.roomId,
        identity: this.o.identity,
        create: spec.create,
        join: spec.join,
        WebSocketImpl: this.o.WebSocketImpl,
        log: this.o.log,
        onEvent: (e) => this.onSignaling(r, e),
      });
      this.rooms.set(spec.roomId, r);
      r.client.start();
    }
    if (this.rooms.size && !this.hostReady) this.o.host.start();
    for (const id of this.wanted()) if (!this.peers.has(id)) this.peers.set(id, this.newPeer(id));
    for (const p of [...this.peers.values()]) this.evaluate(p);
    this.handler?.changed();
  }

  send(peer: MemberId, text: string): boolean {
    const p = this.peers.get(peer);
    if (p?.link !== "open") return false;
    this.o.host.command({ op: "send", peer, data: text });
    return true;
  }

  sendStream(peer: MemberId, text: string): boolean {
    const p = this.peers.get(peer);
    if (p?.link !== "open" || p.congested) return false;
    this.o.host.command({ op: "stream", peer, data: text });
    return true;
  }

  congested(peer: MemberId): boolean {
    return !!this.peers.get(peer)?.congested;
  }

  connected(): MemberId[] {
    return [...this.peers.values()].filter((p) => p.up).map((p) => p.id);
  }

  async introduce(roomId: RoomId, to: MemberId, type: IntroType, body: unknown): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room || room.client.state !== "online") throw new Error("not connected to the room's signaling server yet");
    if (!room.client.peers.has(to)) throw new Error(`${to.slice(0, 8)} isn't connected to the room's signaling server`);
    if (!room.client.send({ t: "signal", to, env: this.sign(room, to, type, body) })) throw new Error("the signaling connection dropped");
  }

  linkStates(): Map<MemberId, { state: PeerLinkState; detail?: string; since: number }> {
    const out = new Map<MemberId, { state: PeerLinkState; detail?: string; since: number }>();
    for (const p of this.peers.values()) {
      if (p.otherProtocol !== null) {
        out.set(p.id, { state: "needs-update", detail: p.otherProtocol < TEAM_PROTOCOL ? "Their Mockingbird needs an update" : "This Mockingbird needs an update to connect", since: p.since });
      } else if (p.link === "open") out.set(p.id, { state: p.route === "turn" ? "turn" : "direct", since: p.since });
      else if (p.link === "connecting") out.set(p.id, { state: "connecting", since: p.since, ...(p.error ? { detail: p.error } : {}) });
      else if (p.error) out.set(p.id, { state: "error", detail: p.error, since: p.since });
      else out.set(p.id, { state: "offline", since: p.since });
    }
    return out;
  }

  roomStates(): Map<RoomId, { signaling: "online" | "connecting" | "offline"; problem?: string }> {
    const out = new Map<RoomId, { signaling: "online" | "connecting" | "offline"; problem?: string }>();
    for (const [id, r] of this.rooms) {
      const st = r.client.state === "stopped" ? "offline" : r.client.state;
      out.set(id, { signaling: st, ...(r.client.problem ? { problem: r.client.problem } : {}) });
    }
    return out;
  }

  problems(): string[] {
    return this.ice.problem ? [this.ice.problem] : [];
  }

  wake(): void {
    if (this.closed) return;
    this.o.log("waking: reconnecting signaling and repairing connections");
    for (const r of this.rooms.values()) r.client.reconnect();
    for (const p of this.peers.values()) {
      if (p.link === "open" && p.role === "offerer" && p.epoch) this.o.host.command({ op: "restart-ice", peer: p.id, epoch: p.epoch });
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.refreshTimer);
    if (this.iceTimer) clearTimeout(this.iceTimer);
    for (const r of this.rooms.values()) r.client.stop();
    this.rooms.clear();
    for (const p of this.peers.values()) this.clearTimers(p);
    this.peers.clear();
    this.o.host.stop();
  }

  // ---- decisions ---------------------------------------------------------------------------

  /** Every member of every room, but this install. */
  private wanted(): Set<MemberId> {
    const ids = new Set<MemberId>();
    for (const r of this.rooms.values()) for (const m of r.spec.members) if (m.id !== this.self) ids.add(m.id);
    return ids;
  }

  private newPeer(id: MemberId): Peer {
    return { id, link: "idle", up: false, epoch: null, role: this.self < id ? "offerer" : "answerer", since: Date.now(), route: null, error: null, attempts: 0, congested: false, lastKnock: 0, otherProtocol: null, retryTimer: null, connectTimer: null, graceTimer: null };
  }

  /** A room through which `peer` can be signaled right now. */
  private signalingRoomFor(peer: MemberId): Room | undefined {
    for (const r of this.rooms.values()) {
      if (r.client.state === "online" && r.client.peers.has(peer) && r.spec.members.some((m) => m.id === peer)) return r;
    }
    return undefined;
  }

  /** Bring one teammate's connection in line with who's wanted and reachable. */
  private evaluate(p: Peer): void {
    if (this.closed) return;
    if (!this.wanted().has(p.id)) {
      this.dropPeer(p, "no longer in a shared room");
      this.peers.delete(p.id);
      return;
    }
    // a teammate on another protocol isn't connected to: they're shown as needing an update
    let other: number | null = null;
    for (const r of this.rooms.values()) {
      const sp = r.client.peers.get(p.id);
      if (sp && sp.team !== TEAM_PROTOCOL) other = sp.team;
    }
    p.otherProtocol = other;
    if (other !== null) {
      if (p.link !== "idle") this.dropPeer(p, "on another protocol");
      return;
    }
    if (p.link !== "idle" || !this.hostReady || !this.ice.ready || p.retryTimer) return;
    if (!this.signalingRoomFor(p.id)) return;
    if (p.role === "offerer") this.offer(p);
    else this.knock(p);
  }

  private offer(p: Peer): void {
    this.clearTimers(p);
    if (p.link !== "idle") this.o.host.command({ op: "close", peer: p.id, reason: "replaced" });
    if (p.up) this.down(p);
    p.epoch = randomNonce();
    p.link = "connecting";
    p.since = Date.now();
    p.route = null;
    p.congested = false;
    p.attempts++;
    this.o.host.command({ op: "open", peer: p.id, epoch: p.epoch, role: "offerer", iceServers: this.ice.servers });
    this.armConnectTimeout(p);
    this.handler?.changed();
  }

  private knock(p: Peer): void {
    const now = Date.now();
    if (now - p.lastKnock < this.timing.knockMs) {
      this.retryLater(p, this.timing.knockMs - (now - p.lastKnock));
      return;
    }
    const room = this.signalingRoomFor(p.id);
    if (!room) return;
    p.lastKnock = now;
    room.client.send({ t: "signal", to: p.id, env: this.sign(room, p.id, "knock", {}) });
    // no offer in a while: knock again
    this.retryLater(p, this.timing.connectTimeoutMs / 2);
  }

  private armConnectTimeout(p: Peer): void {
    if (p.connectTimer) clearTimeout(p.connectTimer);
    const epoch = p.epoch;
    p.connectTimer = setTimeout(() => {
      if (p.epoch === epoch && p.link === "connecting") this.fail(p, "the connection attempt timed out");
    }, this.timing.connectTimeoutMs);
    p.connectTimer.unref?.();
  }

  /** The attempt or connection is over: tell the handler, and try again after a backoff. */
  private fail(p: Peer, reason: string, error?: string): void {
    this.o.log(`connection to ${p.id.slice(0, 8)} ${p.link === "open" ? "lost" : "failed"}: ${reason}`);
    this.dropPeer(p, reason);
    if (error) p.error = error;
    const delay = this.timing.retryMs[Math.min(p.attempts, this.timing.retryMs.length) - 1] ?? this.timing.retryMs[0];
    this.retryLater(p, delay);
  }

  private dropPeer(p: Peer, reason: string): void {
    this.clearTimers(p);
    if (p.link !== "idle") this.o.host.command({ op: "close", peer: p.id, reason });
    p.link = "idle";
    p.epoch = null;
    p.route = null;
    p.congested = false;
    p.since = Date.now();
    if (p.up) this.down(p);
    this.handler?.changed();
  }

  private down(p: Peer): void {
    p.up = false;
    this.o.log(`disconnected from ${p.id.slice(0, 8)}`);
    this.handler?.down(p.id);
  }

  private retryLater(p: Peer, ms: number): void {
    if (p.retryTimer) clearTimeout(p.retryTimer);
    p.retryTimer = setTimeout(() => {
      p.retryTimer = null;
      this.evaluate(p);
    }, ms);
    p.retryTimer.unref?.();
  }

  private clearTimers(p: Peer): void {
    for (const t of [p.retryTimer, p.connectTimer, p.graceTimer]) if (t) clearTimeout(t);
    p.retryTimer = p.connectTimer = p.graceTimer = null;
  }

  // ---- signaling ---------------------------------------------------------------------------

  private onSignaling(room: Room, e: SignalingEvent): void {
    if (this.closed || this.rooms.get(room.spec.roomId) !== room) return;
    switch (e.t) {
      case "online":
        room.registered.clear();
        room.admitted = "";
        this.register(room);
        this.requestIce(room);
        break;
      case "signal":
        this.onSignal(room, e.from, e.env);
        return;
      case "turn":
        this.onIce(e);
        return;
      case "refused":
        if (e.code !== "peer-offline") this.o.log(`signaling ${room.spec.roomId}: ${e.code}: ${e.message}`);
        return;
      case "offline":
      case "peer-joined":
      case "peer-left":
        break;
    }
    this.handler?.reachable(room.spec.roomId, [...room.client.peers.keys()]);
    for (const p of this.peers.values()) {
      // a teammate who reconnected to signaling while we think we're connected may have restarted: the knock tells
      if (e.t === "peer-joined" && e.peer.id === p.id && p.link === "idle") p.attempts = 0;
      if (p.retryTimer && e.t === "peer-joined" && e.peer.id === p.id) {
        clearTimeout(p.retryTimer);
        p.retryTimer = null;
      }
      this.evaluate(p);
    }
    this.handler?.changed();
  }

  /** Register the room's invites and admit its members with the signaling server (once per connection). */
  private register(room: Room): void {
    if (room.client.state !== "online") return;
    for (const inv of room.spec.invites) {
      if (room.registered.has(inv.tokenHash)) continue;
      if (room.client.send({ t: "invite", tokenHash: inv.tokenHash, expiresAt: inv.expiresAt })) room.registered.add(inv.tokenHash);
    }
    const admit = room.spec.admit.filter((k) => PUBLIC_KEY_RE.test(k)).sort().join(",");
    if (admit && admit !== room.admitted && room.client.send({ t: "admit", publicKeys: admit.split(",") })) room.admitted = admit;
  }

  private sign(room: Room, to: MemberId, type: SignalType, body: unknown): SignedEnvelope {
    const u: UnsignedEnvelope = { v: TEAM_PROTOCOL, roomId: room.spec.roomId, from: this.self, to, type, body, ts: room.client.serverNow(), nonce: randomNonce() };
    return { ...u, sig: this.o.identity.sign(signalPayload(u)) };
  }

  /** Check a relayed envelope. Returns the reason it's refused, or null. */
  private refusal(room: Room, from: MemberId, env: SignedEnvelope): string | null {
    const shape = envelopeProblem(env);
    if (shape) return `malformed (${shape})`;
    if (env.roomId !== room.spec.roomId || env.to !== this.self || env.from !== from) return "addressed elsewhere";
    if (env.v !== TEAM_PROTOCOL) return `on team protocol ${env.v}`;
    let key: string | undefined;
    if (INTRO_TYPES.includes(env.type)) {
      const k = (env.body as { publicKey?: unknown } | null)?.publicKey;
      key = typeof k === "string" && PUBLIC_KEY_RE.test(k) && fingerprintOf(k) === from ? k : undefined;
      if (!key) return "an introduction whose key isn't its sender's";
    } else {
      key = room.spec.members.find((m) => m.id === from)?.publicKey;
      if (!key) return "not a member of the room";
    }
    const fresh = this.replay.check(from, env.ts, env.nonce, room.client.serverNow());
    if (fresh !== "ok") return fresh === "stale" ? "outside the replay window (is a clock off?)" : "a replay";
    if (!verifySignature(key, signalPayload(env), env.sig)) return "a bad signature";
    return null;
  }

  private onSignal(room: Room, from: MemberId, env: SignedEnvelope): void {
    const why = this.refusal(room, from, env);
    if (why) {
      this.o.log(`refused ${String(env?.type)} from ${from.slice(0, 8)} in room ${room.spec.roomId}: ${why}`);
      const p = this.peers.get(from);
      if (p && why === "a bad signature") {
        p.error = "Refused connection details that weren't signed by this teammate";
        this.handler?.changed();
      }
      return;
    }
    if (INTRO_TYPES.includes(env.type)) return this.handler?.intro(room.spec.roomId, from, env.type as IntroType, env.body);
    const p = this.peers.get(from);
    if (!p) return;
    const body = (env.body ?? {}) as { epoch?: string; sdp?: string; candidate?: IceCandidate };
    switch (env.type) {
      case "knock":
        if (p.role !== "offerer") return;
        if (p.link === "connecting" && Date.now() - p.since < this.timing.knockMs) return;
        // the other side has no working connection: whatever this side believes, make a fresh one
        if (p.retryTimer) clearTimeout(p.retryTimer);
        p.retryTimer = null;
        if (this.hostReady && this.ice.ready) this.offer(p);
        return;
      case "offer": {
        if (p.role !== "answerer" || typeof body.epoch !== "string" || typeof body.sdp !== "string") return;
        let fingerprint: string;
        try {
          fingerprint = sdpFingerprint(body.sdp);
        } catch (err) {
          return this.o.log(`refused an offer from ${from.slice(0, 8)}: ${(err as Error).message}`);
        }
        if (!this.hostReady) return;
        if (p.epoch !== body.epoch) {
          this.clearTimers(p);
          if (p.link !== "idle") this.o.host.command({ op: "close", peer: p.id, reason: "replaced" });
          if (p.up) this.down(p);
          p.epoch = body.epoch;
          p.link = "connecting";
          p.since = Date.now();
          p.route = null;
          p.congested = false;
          this.o.host.command({ op: "open", peer: p.id, epoch: body.epoch, role: "answerer", iceServers: this.ice.servers });
          this.armConnectTimeout(p);
          this.handler?.changed();
        }
        this.o.host.command({ op: "remote", peer: p.id, epoch: body.epoch, description: { type: "offer", sdp: body.sdp }, fingerprint });
        return;
      }
      case "answer": {
        if (p.role !== "offerer" || body.epoch !== p.epoch || typeof body.sdp !== "string") return;
        let fingerprint: string;
        try {
          fingerprint = sdpFingerprint(body.sdp);
        } catch (err) {
          return this.o.log(`refused an answer from ${from.slice(0, 8)}: ${(err as Error).message}`);
        }
        this.o.host.command({ op: "remote", peer: p.id, epoch: p.epoch, description: { type: "answer", sdp: body.sdp }, fingerprint });
        return;
      }
      case "ice":
        if (body.epoch !== p.epoch || !body.candidate || typeof body.candidate.candidate !== "string") return;
        this.o.host.command({ op: "candidate", peer: p.id, epoch: p.epoch, candidate: body.candidate });
        return;
    }
  }

  // ---- ICE servers (STUN, and TURN from the signaling server) ----------------------------------

  private requestIce(room: Room): void {
    const fresh = this.ice.fetchedAt && Date.now() - this.ice.fetchedAt < (this.ice.ttl * 1000) / 2;
    if (fresh) return;
    room.client.send({ t: "turn" });
    if (!this.ice.ready && !this.iceTimer) {
      this.iceTimer = setTimeout(() => {
        this.iceTimer = null;
        if (this.ice.ready) return;
        this.o.log("no relay credentials from the signaling server yet; connecting with STUN only");
        this.ice.ready = true;
        for (const p of this.peers.values()) this.evaluate(p);
      }, this.timing.iceWaitMs);
      this.iceTimer.unref?.();
    }
  }

  private onIce(e: Extract<SignalingEvent, { t: "turn" }>): void {
    const wasReady = this.ice.ready;
    this.ice = {
      servers: e.iceServers.length || !this.o.defaultIce ? e.iceServers : this.o.defaultIce,
      ready: true,
      fetchedAt: e.relay ? Date.now() : 0,
      ttl: e.ttl,
      relay: e.relay,
      problem: e.error ? `TURN relay unavailable (${e.error}); teammates behind strict firewalls may not connect` : null,
    };
    if (e.error) this.o.log(this.ice.problem!);
    if (this.iceTimer) clearTimeout(this.iceTimer);
    this.iceTimer = null;
    if (wasReady && this.hostReady) {
      this.o.host.command({ op: "ice-servers", iceServers: this.ice.servers });
      // a relayed connection keeps using the old credentials until it renegotiates
      for (const p of this.peers.values()) if (p.link === "open" && p.route === "turn" && p.role === "offerer" && p.epoch) this.o.host.command({ op: "restart-ice", peer: p.id, epoch: p.epoch });
    }
    for (const p of this.peers.values()) this.evaluate(p);
    this.handler?.changed();
  }

  private refreshIce(): void {
    if (!this.ice.relay || !this.ice.fetchedAt || Date.now() - this.ice.fetchedAt < (this.ice.ttl * 1000) / 2) return;
    const room = [...this.rooms.values()].find((r) => r.client.state === "online");
    if (room) room.client.send({ t: "turn" });
  }

  // ---- the peer host -----------------------------------------------------------------------

  private onHost(e: HostEvent): void {
    if (this.closed) return;
    if (e.ev === "ready") {
      // a (re)started host holds no connections
      this.hostReady = true;
      for (const p of this.peers.values()) {
        const wasOpen = p.link !== "idle";
        this.clearTimers(p);
        p.link = "idle";
        p.epoch = null;
        p.attempts = 0;
        if (p.up) this.down(p);
        if (wasOpen) this.o.log(`peer host restarted: reconnecting ${p.id.slice(0, 8)}`);
      }
      for (const p of this.peers.values()) this.evaluate(p);
      this.handler?.changed();
      return;
    }
    if (e.ev === "network-changed") return this.wake();
    if (e.ev === "error") return this.o.log(`peer host${e.peer ? ` (${e.peer.slice(0, 8)})` : ""}: ${e.message}`);
    const p = this.peers.get(e.peer);
    if (!p) return;
    switch (e.ev) {
      case "message":
        if (p.up) this.handler?.frame(p.id, e.data);
        return;
      case "stream":
        if (p.up) this.handler?.stream(p.id, e.data);
        return;
      case "congestion":
        p.congested = e.congested;
        if (!e.congested) this.handler?.drain(p.id);
        return;
    }
    if (e.epoch !== p.epoch) return; // from an attempt that's been replaced
    switch (e.ev) {
      case "local-description": {
        const room = this.signalingRoomFor(p.id);
        if (!room) return this.fail(p, "the teammate left the signaling server mid-negotiation");
        room.client.send({ t: "signal", to: p.id, env: this.sign(room, p.id, e.description.type, { epoch: e.epoch, sdp: e.description.sdp }) });
        return;
      }
      case "candidate": {
        const room = this.signalingRoomFor(p.id);
        if (room) room.client.send({ t: "signal", to: p.id, env: this.sign(room, p.id, "ice", { epoch: e.epoch, candidate: e.candidate }) });
        return;
      }
      case "open":
        if (p.connectTimer) clearTimeout(p.connectTimer);
        p.connectTimer = null;
        p.link = "open";
        p.route = e.route;
        p.since = Date.now();
        p.attempts = 0;
        p.error = null;
        this.o.log(`connected to ${p.id.slice(0, 8)} (${e.route ?? "route unknown"})`);
        if (!p.up) {
          p.up = true;
          this.handler?.up(p.id);
        }
        this.handler?.changed();
        return;
      case "route":
        p.route = e.route;
        this.handler?.changed();
        return;
      case "state":
        if (e.state === "disconnected" && p.link === "open") {
          if (p.graceTimer) clearTimeout(p.graceTimer);
          const epoch = p.epoch;
          p.graceTimer = setTimeout(() => {
            p.graceTimer = null;
            if (p.epoch !== epoch) return;
            if (p.role === "offerer") {
              this.o.host.command({ op: "restart-ice", peer: p.id, epoch: epoch! });
              p.graceTimer = setTimeout(() => {
                p.graceTimer = null;
                if (p.epoch === epoch && this.lastState.get(p.id) !== "connected") this.fail(p, "the ICE restart didn't recover the connection");
              }, this.timing.connectTimeoutMs / 2);
            } else {
              this.knock(p);
            }
          }, this.timing.disconnectGraceMs);
        }
        this.lastState.set(p.id, e.state);
        if (e.state === "failed") this.fail(p, "the connection failed");
        return;
      case "closed":
        if (e.reason === FINGERPRINT_MISMATCH) {
          this.fail(p, "the teammate's certificate didn't match its signed connection details", "Refused a connection whose certificate didn't match the signed details");
        } else {
          this.fail(p, e.reason);
        }
        return;
    }
  }

  private lastState = new Map<MemberId, string>();
}
