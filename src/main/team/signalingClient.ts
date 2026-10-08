import type { Identity } from "./identity";
import {
  helloPayload,
  SIGNALING_PING,
  SIGNALING_PROTOCOL,
  signalingSocketUrl,
  TEAM_PROTOCOL,
  type ClientMessage,
  type IceServer,
  type ServerMessage,
  type SignalingPeer,
  type SignedEnvelope,
} from "../../shared/team/protocol";

/**
 * One room's connection to the signaling server, from the main process
 * (Node's built-in WebSocket). It proves this install's key on every
 * connect, keeps the connection alive, and reconnects with backoff after
 * any drop — sleep, a network change, the Worker redeploying.
 */

export type SignalingEvent =
  | { t: "online"; peers: SignalingPeer[]; relay: boolean }
  | { t: "offline"; reason: string }
  | { t: "peer-joined"; peer: SignalingPeer }
  | { t: "peer-left"; id: string }
  | { t: "signal"; from: string; env: SignedEnvelope }
  | { t: "turn"; iceServers: IceServer[]; ttl: number; relay: boolean; error?: string }
  /** Signed room events the server passed on: removals made while this install was offline, or its own. */
  | { t: "room-events"; events: unknown[] }
  /** The server refused a request (a signal to someone offline, too many messages…). */
  | { t: "refused"; code: string; message: string; to?: string };

/** What the server said to a revoke (see transport.ts RevokeOutcome). */
export type RevokeAnswer = { ok: true } | { ok: false; reason: "unsupported" | "refused" | "offline" | "failed"; message: string };

export const OLD_WORKER_REVOKE =
  "The signaling Worker is older and can't cut members off — update it (cd signaling && npx wrangler deploy) to also cut them off at the Worker";

export interface SignalingClientOptions {
  url: string;
  roomId: string;
  identity: Identity;
  /** The salt the room id was made from: hello as its creator. */
  create?: string;
  /** An invite's join key. */
  join?: string;
  onEvent(e: SignalingEvent): void;
  log(msg: string): void;
  WebSocketImpl?: typeof WebSocket;
  /** Reconnect delays, ms (the last repeats). */
  backoffMs?: number[];
  keepAliveMs?: number;
}

export class SignalingClient {
  state: "connecting" | "online" | "offline" | "stopped" = "offline";
  /** Why the server refused this install (set until it's let in), and that refusal's code. */
  problem: string | null = null;
  problemCode: "protocol" | "not-member" | "revoked" | "creation-refused" | "bad-url" | null = null;
  /** Members connected to the room right now (not this install). */
  readonly peers = new Map<string, SignalingPeer>();
  relay = false;
  /** What the server announced it can do beyond the protocol (from its welcome); null until welcomed. */
  features: Set<string> | null = null;
  /** Revokes sent, waiting for the server's answer, by member. */
  private revokes = new Map<string, { resolve: (a: RevokeAnswer) => void; timer: ReturnType<typeof setTimeout> }[]>();
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private lastHeard = 0;
  /** The server's clock minus this machine's, from the welcome. */
  private offset = 0;
  /** The next reconnect's delay, when a refusal sets one. */
  private retryAfter: number | null = null;
  private readonly backoff: number[];

  constructor(private o: SignalingClientOptions) {
    this.backoff = o.backoffMs ?? [1000, 2000, 4000, 8000, 15000, 30000];
  }

  get roomId(): string {
    return this.o.roomId;
  }

  /** Time on the signaling server's clock: what signed envelopes carry and are checked against. */
  serverNow(): number {
    return Date.now() + this.offset;
  }

  start(): void {
    if (this.state === "stopped") return;
    this.connect();
  }

  stop(): void {
    this.state = "stopped";
    this.clearTimers();
    this.peers.clear();
    this.settleRevokes(null, { ok: false, reason: "failed", message: "the signaling connection was closed before the server answered" });
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "stopped");
  }

  /**
   * Ask the server to cut `member` off the room (oneself, or — from the room's
   * admin — someone removed), passing `event` on. Waits for the connection
   * (up to `timeoutMs`), and for the answer. Never rejects.
   */
  async revoke(member: string, event: unknown, timeoutMs = 10_000): Promise<RevokeAnswer> {
    const until = Date.now() + timeoutMs;
    while (this.state !== "online" && this.state !== "stopped" && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    if (this.state !== "online") return { ok: false, reason: "offline", message: this.problem ? `the signaling server refused this install: ${this.problem}` : "the signaling server couldn't be reached" };
    if (!this.features?.has("revoke")) return { ok: false, reason: "unsupported", message: OLD_WORKER_REVOKE };
    return new Promise<RevokeAnswer>((resolve) => {
      const timer = setTimeout(() => this.settleRevokes(member, { ok: false, reason: "failed", message: "the signaling server didn't answer" }), Math.max(1000, until - Date.now()));
      timer.unref?.();
      this.revokes.set(member, [...(this.revokes.get(member) ?? []), { resolve, timer }]);
      if (!this.send({ t: "revoke", member, ...(event ? { event } : {}) })) this.settleRevokes(member, { ok: false, reason: "offline", message: "the signaling connection dropped" });
    });
  }

  /** Answer the revokes waiting for `member` (null: all of them). */
  private settleRevokes(member: string | null, answer: RevokeAnswer): void {
    for (const [m, waiting] of [...this.revokes]) {
      if (member !== null && m !== member) continue;
      this.revokes.delete(m);
      for (const w of waiting) {
        clearTimeout(w.timer);
        w.resolve(answer);
      }
    }
  }

  /** Drop the connection and connect again now (after sleep, the old socket may be silently dead). */
  reconnect(): void {
    if (this.state === "stopped") return;
    this.attempt = 0;
    this.problem = this.problemCode = null; // asked again: the server's answer decides
    this.drop("reconnecting");
    this.connect();
  }

  send(msg: ClientMessage): boolean {
    if (this.state !== "online" || this.ws?.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      this.o.log(`signaling ${this.o.roomId}: sending ${msg.t} failed: ${(err as Error).message}`);
      return false;
    }
  }

  private connect(): void {
    this.clearTimers();
    let url: string;
    try {
      url = signalingSocketUrl(this.o.url, this.o.roomId);
    } catch (err) {
      this.problem = (err as Error).message;
      this.problemCode = "bad-url";
      this.state = "offline";
      this.o.onEvent({ t: "offline", reason: this.problem });
      return;
    }
    this.state = "connecting";
    const Impl = this.o.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new Impl(url);
    } catch (err) {
      return this.fail(`couldn't open ${url}: ${(err as Error).message}`);
    }
    this.ws = ws;
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.lastHeard = Date.now();
      if (typeof e.data !== "string") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return this.o.log(`signaling ${this.o.roomId}: dropped a message that isn't JSON`);
      }
      this.onMessage(ws, msg);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.fail(e.reason ? `closed: ${e.reason} (${e.code})` : `connection closed (${e.code})`);
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.fail(`couldn't reach ${new URL(this.o.url).host}`);
    };
  }

  private onMessage(ws: WebSocket, msg: ServerMessage): void {
    switch (msg.t) {
      case "challenge": {
        const fields = { publicKey: this.o.identity.publicKey, ...(this.o.join ? { join: this.o.join } : {}), ...(this.o.create ? { create: this.o.create } : {}) };
        const hello: ClientMessage = { t: "hello", v: SIGNALING_PROTOCOL, team: TEAM_PROTOCOL, ...fields, sig: this.o.identity.sign(helloPayload(this.o.roomId, msg.nonce, fields)) };
        ws.send(JSON.stringify(hello));
        return;
      }
      case "welcome":
        this.offset = msg.now - Date.now();
        this.peers.clear();
        for (const p of msg.peers) this.peers.set(p.id, p);
        this.relay = msg.relay;
        this.features = new Set(Array.isArray(msg.features) ? msg.features.filter((f): f is string => typeof f === "string") : []);
        this.state = "online";
        this.problem = this.problemCode = null;
        this.attempt = 0;
        this.startKeepAlive(ws);
        this.o.onEvent({ t: "online", peers: msg.peers, relay: msg.relay });
        if (Array.isArray(msg.events) && msg.events.length) this.o.onEvent({ t: "room-events", events: msg.events });
        return;
      case "revoked":
        if (typeof msg.member === "string") this.settleRevokes(msg.member, { ok: true });
        return;
      case "peer-joined":
        this.peers.set(msg.peer.id, msg.peer);
        this.o.onEvent({ t: "peer-joined", peer: msg.peer });
        return;
      case "peer-left":
        this.peers.delete(msg.id);
        this.o.onEvent({ t: "peer-left", id: msg.id });
        return;
      case "signal":
        this.o.onEvent({ t: "signal", from: msg.from, env: msg.env });
        return;
      case "turn":
        this.o.onEvent({ t: "turn", iceServers: msg.iceServers, ttl: msg.ttl, relay: msg.relay, ...(msg.error ? { error: msg.error } : {}) });
        return;
      case "error":
        if (msg.code === "creation-refused") {
          this.problem = msg.message;
          this.problemCode = "creation-refused";
          this.retryAfter = 60_000;
          this.o.log(`signaling ${this.o.roomId}: ${msg.message}`);
          return;
        }
        if (msg.code === "protocol") {
          this.retryAfter = 60_000;
          this.problemCode = "protocol";
          this.problem =
            (msg.serverProtocol ?? 0) < SIGNALING_PROTOCOL
              ? "The signaling Worker is older than this Mockingbird — redeploy it (cd signaling && npx wrangler deploy)"
              : "The signaling Worker is newer than this Mockingbird — update Mockingbird";
          this.o.log(`signaling ${this.o.roomId}: ${this.problem}`);
          return;
        }
        if (msg.code === "not-member" && msg.revoked) {
          // cut off by a revoke: the removal it passes on is signed, and the room log decides whether it counts
          this.problem = "The signaling server says this install was removed from the room";
          this.problemCode = "revoked";
          this.retryAfter = 10 * 60_000;
          this.o.log(`signaling ${this.o.roomId}: ${this.problem}`);
          if (msg.event !== undefined) this.o.onEvent({ t: "room-events", events: [msg.event] });
          return;
        }
        if (msg.code === "not-member") {
          // with a join key, the likely reason is that the inviter's Mockingbird hasn't registered the code yet
          this.problem = this.o.join
            ? "The room code isn't active yet: the inviter's Mockingbird has to be online with the room once"
            : "The signaling server doesn't know this install as a member of the room";
          this.retryAfter = this.o.join ? 10_000 : 30_000;
          this.problemCode = "not-member";
          this.o.log(`signaling ${this.o.roomId}: ${this.problem} (${msg.message})`);
          return;
        }
        if (msg.code === "forbidden" && typeof msg.member === "string") {
          this.settleRevokes(msg.member, { ok: false, reason: "refused", message: `the signaling Worker refused: ${msg.message}` });
          return;
        }
        if (msg.code === "bad-message" && /^unknown message revoke\b/.test(msg.message)) {
          this.features?.delete("revoke");
          this.settleRevokes(null, { ok: false, reason: "unsupported", message: OLD_WORKER_REVOKE });
          return;
        }
        if (msg.code === "replaced") return;
        this.o.onEvent({ t: "refused", code: msg.code, message: msg.message, ...(msg.to ? { to: msg.to } : {}) });
        return;
      case "invited":
      case "admitted":
      case "pong":
        return;
      default:
        this.o.log(`signaling ${this.o.roomId}: dropped an unknown message ${String((msg as { t: unknown }).t).slice(0, 20)}`);
    }
  }

  private startKeepAlive(ws: WebSocket): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    const every = this.o.keepAliveMs ?? 25_000;
    this.keepAlive = setInterval(() => {
      if (this.ws !== ws) return;
      if (Date.now() - this.lastHeard > every * 2) return this.fail("the signaling server stopped answering");
      try {
        ws.send(SIGNALING_PING);
      } catch (err) {
        this.fail(`keep-alive failed: ${(err as Error).message}`);
      }
    }, every);
    this.keepAlive.unref?.();
  }

  private fail(reason: string): void {
    if (this.state === "stopped") return;
    const wasOnline = this.state === "online";
    this.drop(reason);
    // a refused hello (protocol, membership) is retried slowly: it won't change in seconds
    const delay = this.retryAfter ?? this.backoff[Math.min(this.attempt, this.backoff.length - 1)] * (0.8 + Math.random() * 0.4);
    this.retryAfter = null;
    this.attempt++;
    if (wasOnline || this.attempt === 1) this.o.log(`signaling ${this.o.roomId}: ${reason}; retrying in ${Math.round(delay / 1000)} s`);
    this.retryTimer = setTimeout(() => this.connect(), delay);
    this.retryTimer.unref?.();
  }

  private drop(reason: string): void {
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000, "reconnecting");
      } catch (err) {
        this.o.log(`signaling ${this.o.roomId}: closing the old connection failed: ${(err as Error).message}`);
      }
    }
    this.peers.clear();
    this.settleRevokes(null, { ok: false, reason: "offline", message: `the signaling connection dropped before the server answered (${reason})` });
    if (this.state !== "stopped") this.state = "offline";
    this.o.onEvent({ t: "offline", reason });
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.retryTimer = this.keepAlive = null;
  }
}
