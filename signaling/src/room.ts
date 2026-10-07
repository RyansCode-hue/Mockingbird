import {
  CLOSE,
  fromBase64Url,
  helloPayload,
  MAX_SIGNALING_MESSAGE,
  MEMBER_ID_RE,
  PUBLIC_KEY_RE,
  roomIdInput,
  SIGNALING_PROTOCOL,
  SIGNATURE_RE,
  toBase64Url,
  toHex,
  TOKEN_RE,
  utf8,
  type ClientMessage,
  type IceServer,
  type ServerMessage,
  type SignalingErrorCode,
  type SignalingPeer,
} from "../../src/shared/team/protocol";

/**
 * One room on the signaling server: who's a member, who's connected, and the
 * relay of signed connection details between them. Plain code with no
 * Cloudflare APIs: the Worker's Durable Object (worker.ts) and the local
 * signaling server (local/server.ts) both drive it through RoomDeps.
 *
 * The server is trusted for introductions only. Members prove their key on
 * every connect (a signed challenge); everything they relay is signed by the
 * sender and checked by the receiver, so a tampered server can drop messages
 * but not impersonate anyone. It never sees content, nor an invite's token
 * (only a hash of a key derived from it).
 *
 * Getting in: an existing member by key; the room's creator, by the salt its
 * room id was made from; or a newcomer holding a join key from an invite,
 * once. Members can also admit keys they already trust (their room log's
 * members), which keeps the server's list in step after it lost its storage.
 *
 * State survives the Durable Object hibernating: the member list and invites
 * live in storage, each connection's own state in its attachment (save()).
 */

export interface ConnState {
  cid: string;
  nonce: string;
  openedAt: number;
  member?: { id: string; publicKey: string; team: number };
  /** Rate limiting: a token bucket. */
  tokens: number;
  refilledAt: number;
  strikes: number;
  turnAt?: number;
}

export interface RoomSocket {
  /** Stable for the connection's life. */
  readonly cid: string;
  send(text: string): void;
  close(code: number, reason: string): void;
  state(): ConnState | null;
  save(s: ConnState): void;
}

export interface RoomStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface RoomCrypto {
  sha256(data: Uint8Array): Promise<Uint8Array>;
  verify(publicKey: Uint8Array, data: Uint8Array, sig: Uint8Array): Promise<boolean>;
  random(n: number): Uint8Array;
}

/** WebCrypto, as both Workers and Node 22 provide it. */
export const webCrypto: RoomCrypto = {
  sha256: async (data) => new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource)),
  verify: async (publicKey, data, sig) => {
    // runtimes that predate the standard name know Ed25519 as NODE-ED25519
    let alg: { name: string; namedCurve?: string } = { name: "Ed25519" };
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey("raw", publicKey as BufferSource, alg, false, ["verify"]);
    } catch (err) {
      if ((err as Error).name !== "NotSupportedError") throw err;
      alg = { name: "NODE-ED25519", namedCurve: "NODE-ED25519" };
      key = await crypto.subtle.importKey("raw", publicKey as BufferSource, alg, false, ["verify"]);
    }
    return crypto.subtle.verify(alg, key, sig as BufferSource, data as BufferSource);
  },
  random: (n) => crypto.getRandomValues(new Uint8Array(n)),
};

export interface TurnConfig {
  keyId: string;
  apiToken: string;
}

export interface RoomLimits {
  /** Members connected at once. */
  maxOnline: number;
  /** Unused invites outstanding. */
  maxInvites: number;
  inviteMaxAgeMs: number;
  /** A connection that hasn't said hello by then is closed. */
  helloTimeoutMs: number;
  /** Token bucket per connection. */
  burst: number;
  perSecond: number;
  /** Rate-limit violations before the connection is closed. */
  strikes: number;
  /** Least time between TURN credential requests on one connection. */
  turnIntervalMs: number;
  turnTtlSeconds: number;
}

export const DEFAULT_LIMITS: RoomLimits = {
  maxOnline: 32,
  maxInvites: 20,
  inviteMaxAgeMs: 7 * 24 * 3_600_000,
  helloTimeoutMs: 30_000,
  burst: 60,
  perSecond: 20,
  strikes: 3,
  turnIntervalMs: 30_000,
  turnTtlSeconds: 24 * 3600,
};

/** Public STUN, used whatever TURN does. */
export const PUBLIC_STUN: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

export interface RoomDeps {
  roomId: string;
  storage: RoomStorage;
  /** Every open connection to this room. */
  sockets(): RoomSocket[];
  crypto?: RoomCrypto;
  now?: () => number;
  fetch?: typeof fetch;
  /** Cloudflare TURN key (the Worker's TURN_KEY_ID / TURN_KEY_API_TOKEN secrets); none: STUN only. */
  turn?: TurnConfig | null;
  /** STUN servers handed out (the local server passes [] for loopback-only tests). */
  stun?: IceServer[];
  log?: (msg: string) => void;
  limits?: Partial<RoomLimits>;
}

interface RoomRecord {
  members: Record<string, { publicKey: string; addedAt: number }>;
  invites: Record<string, { expiresAt: number; by: string; usedAt?: number }>;
}

export const TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";

export class SignalingRoom {
  private record: RoomRecord | null = null;
  private readonly crypto: RoomCrypto;
  private readonly now: () => number;
  private readonly limits: RoomLimits;
  private readonly log: (msg: string) => void;

  constructor(private deps: RoomDeps) {
    this.crypto = deps.crypto ?? webCrypto;
    this.now = deps.now ?? Date.now;
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.log = deps.log ?? ((m) => console.log(m));
  }

  /** A new connection: it's challenged to prove its key. */
  open(sock: RoomSocket): void {
    const now = this.now();
    const state: ConnState = { cid: sock.cid, nonce: toBase64Url(this.crypto.random(24)), openedAt: now, tokens: this.limits.burst, refilledAt: now, strikes: 0 };
    sock.save(state);
    this.send(sock, { t: "challenge", v: SIGNALING_PROTOCOL, nonce: state.nonce });
  }

  async message(sock: RoomSocket, data: string | ArrayBuffer | Uint8Array): Promise<void> {
    const state = sock.state();
    if (!state) return this.fail(sock, "bad-message", "connection has no state", CLOSE.badMessage);
    if (typeof data !== "string") return this.fail(sock, "bad-message", "only text messages are accepted", CLOSE.badMessage);
    if (data.length > MAX_SIGNALING_MESSAGE) return this.fail(sock, "too-big", `messages are limited to ${MAX_SIGNALING_MESSAGE} bytes`, CLOSE.badMessage);
    if (!this.allow(sock, state)) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      return this.fail(sock, "bad-message", "not JSON", CLOSE.badMessage);
    }
    if (!msg || typeof msg !== "object" || typeof (msg as { t?: unknown }).t !== "string") return this.fail(sock, "bad-message", "no message type", CLOSE.badMessage);
    if (msg.t === "ping") return this.send(sock, { t: "pong" });
    if (!state.member) {
      if (msg.t !== "hello") {
        if (this.now() - state.openedAt > this.limits.helloTimeoutMs) return this.fail(sock, "not-ready", "no hello in time", CLOSE.helloTimeout);
        return this.error(sock, "not-ready", "say hello first");
      }
      return this.hello(sock, state, msg);
    }
    const me = state.member;
    switch (msg.t) {
      case "hello":
        return this.error(sock, "bad-message", "already said hello");
      case "signal":
        return this.relay(sock, me, msg);
      case "invite":
        return this.invite(sock, me, msg);
      case "admit":
        return this.admit(sock, msg);
      case "turn":
        return this.turn(sock, state);
      default:
        return this.error(sock, "bad-message", `unknown message ${String((msg as { t: unknown }).t).slice(0, 20)}`);
    }
  }

  /** A connection closed: the others hear the member left, unless it's still connected another way. */
  close(sock: RoomSocket): void {
    const me = sock.state()?.member;
    if (!me) return;
    const still = this.members().some((s) => s.cid !== sock.cid && s.state()?.member?.id === me.id);
    if (!still) this.broadcast(sock.cid, { t: "peer-left", id: me.id });
  }

  /** Member ids the room admits (for tests and diagnostics). */
  async memberIds(): Promise<string[]> {
    return Object.keys((await this.load()).members);
  }

  // ---- messages --------------------------------------------------------------------

  private async hello(sock: RoomSocket, state: ConnState, msg: Extract<ClientMessage, { t: "hello" }>): Promise<void> {
    if (msg.v !== SIGNALING_PROTOCOL) {
      this.send(sock, { t: "error", code: "protocol", message: `this signaling server speaks protocol ${SIGNALING_PROTOCOL}, not ${msg.v}`, serverProtocol: SIGNALING_PROTOCOL });
      return sock.close(CLOSE.protocol, "protocol");
    }
    if (typeof msg.publicKey !== "string" || !PUBLIC_KEY_RE.test(msg.publicKey) || typeof msg.sig !== "string" || !SIGNATURE_RE.test(msg.sig) || typeof msg.team !== "number") {
      return this.fail(sock, "bad-message", "malformed hello", CLOSE.badMessage);
    }
    if ((msg.join !== undefined && (typeof msg.join !== "string" || !TOKEN_RE.test(msg.join))) || (msg.create !== undefined && (typeof msg.create !== "string" || !TOKEN_RE.test(msg.create)))) {
      return this.fail(sock, "bad-message", "malformed hello", CLOSE.badMessage);
    }
    const pub = fromBase64Url(msg.publicKey);
    let signed = false;
    try {
      signed = await this.crypto.verify(pub, utf8(helloPayload(this.deps.roomId, state.nonce, msg)), fromBase64Url(msg.sig));
    } catch (err) {
      this.log(`room ${this.deps.roomId}: verifying a hello failed: ${(err as Error).message}`);
    }
    if (!signed) return this.fail(sock, "not-member", "the hello's signature doesn't match its key", CLOSE.notMember);
    const id = toHex(await this.crypto.sha256(pub)).slice(0, 32);
    const rec = await this.load();
    const now = this.now();
    let changed = false;
    let admitted = !!rec.members[id];
    if (!admitted && msg.create) {
      const rid = toBase64Url(await this.crypto.sha256(utf8(roomIdInput(msg.publicKey, msg.create)))).slice(0, 22);
      if (rid === this.deps.roomId) admitted = changed = true;
    }
    if (!admitted && msg.join) {
      const hash = toBase64Url(await this.crypto.sha256(utf8(msg.join)));
      const invite = rec.invites[hash];
      if (invite && !invite.usedAt && invite.expiresAt > now) {
        invite.usedAt = now;
        admitted = changed = true;
      }
    }
    if (!admitted) {
      this.log(`room ${this.deps.roomId}: refused ${id} (not a member, no valid join key)`);
      return this.fail(sock, "not-member", "this key isn't a member of the room, and holds no valid invite", CLOSE.notMember);
    }
    const online = new Set(this.members().filter((s) => s.cid !== sock.cid && s.state()!.member!.id !== id).map((s) => s.state()!.member!.id));
    if (online.size >= this.limits.maxOnline) return this.fail(sock, "room-full", `at most ${this.limits.maxOnline} members can be connected at once`, CLOSE.roomFull);
    if (!rec.members[id]) rec.members[id] = { publicKey: msg.publicKey, addedAt: now };
    if (changed) await this.save();
    state.member = { id, publicKey: msg.publicKey, team: msg.team };
    sock.save(state);
    // one connection per member: an app that reconnected replaces its old socket
    for (const s of this.members()) {
      if (s.cid !== sock.cid && s.state()?.member?.id === id) {
        this.send(s, { t: "error", code: "replaced", message: "the same member connected again" });
        s.close(CLOSE.replaced, "replaced");
      }
    }
    const peers: SignalingPeer[] = this.members()
      .filter((s) => s.cid !== sock.cid && s.state()!.member!.id !== id)
      .map((s) => ({ id: s.state()!.member!.id, team: s.state()!.member!.team }));
    this.send(sock, { t: "welcome", v: SIGNALING_PROTOCOL, you: id, now, peers, relay: !!this.deps.turn });
    this.broadcast(sock.cid, { t: "peer-joined", peer: { id, team: msg.team } }, id);
    this.closeStale(now);
  }

  private relay(sock: RoomSocket, me: NonNullable<ConnState["member"]>, msg: Extract<ClientMessage, { t: "signal" }>): void {
    if (typeof msg.to !== "string" || !MEMBER_ID_RE.test(msg.to) || !msg.env || typeof msg.env !== "object") return this.error(sock, "bad-message", "malformed signal");
    if (msg.env.from !== me.id) return this.error(sock, "bad-message", "a signal's sender must be the connected member");
    const targets = this.members().filter((s) => s.state()!.member!.id === msg.to);
    if (!targets.length) return this.send(sock, { t: "error", code: "peer-offline", message: "that member isn't connected", to: msg.to });
    for (const t of targets) this.send(t, { t: "signal", from: me.id, env: msg.env });
  }

  private async invite(sock: RoomSocket, me: NonNullable<ConnState["member"]>, msg: Extract<ClientMessage, { t: "invite" }>): Promise<void> {
    const now = this.now();
    if (typeof msg.tokenHash !== "string" || !TOKEN_RE.test(msg.tokenHash) || typeof msg.expiresAt !== "number") return this.error(sock, "bad-message", "malformed invite");
    if (msg.expiresAt <= now || msg.expiresAt > now + this.limits.inviteMaxAgeMs + 60_000) return this.error(sock, "bad-message", "an invite must expire within 7 days");
    const rec = await this.load();
    for (const [hash, inv] of Object.entries(rec.invites)) {
      if (inv.expiresAt < now || (inv.usedAt && inv.usedAt < now - 24 * 3_600_000)) delete rec.invites[hash];
    }
    const open = Object.values(rec.invites).filter((i) => !i.usedAt).length;
    if (!rec.invites[msg.tokenHash] && open >= this.limits.maxInvites) return this.error(sock, "rate", `at most ${this.limits.maxInvites} invites can be open at once`);
    rec.invites[msg.tokenHash] ??= { expiresAt: msg.expiresAt, by: me.id };
    await this.save();
    this.send(sock, { t: "invited", tokenHash: msg.tokenHash });
  }

  private async admit(sock: RoomSocket, msg: Extract<ClientMessage, { t: "admit" }>): Promise<void> {
    if (!Array.isArray(msg.publicKeys) || msg.publicKeys.length > 64 || msg.publicKeys.some((k) => typeof k !== "string" || !PUBLIC_KEY_RE.test(k))) {
      return this.error(sock, "bad-message", "malformed admit");
    }
    const rec = await this.load();
    const ids: string[] = [];
    let changed = false;
    for (const k of msg.publicKeys) {
      const id = toHex(await this.crypto.sha256(fromBase64Url(k))).slice(0, 32);
      ids.push(id);
      if (!rec.members[id]) {
        rec.members[id] = { publicKey: k, addedAt: this.now() };
        changed = true;
      }
    }
    if (changed) await this.save();
    this.send(sock, { t: "admitted", ids });
  }

  private async turn(sock: RoomSocket, state: ConnState): Promise<void> {
    const now = this.now();
    if (state.turnAt && now - state.turnAt < this.limits.turnIntervalMs) return this.error(sock, "rate", "relay credentials were just issued; ask again in a little while");
    state.turnAt = now;
    sock.save(state);
    const stun = this.deps.stun ?? PUBLIC_STUN;
    if (!this.deps.turn) return this.send(sock, { t: "turn", iceServers: stun, ttl: 0, relay: false });
    try {
      const iceServers = await mintTurnCredentials(this.deps.turn, this.limits.turnTtlSeconds, this.deps.fetch ?? fetch);
      this.send(sock, { t: "turn", iceServers, ttl: this.limits.turnTtlSeconds, relay: true });
    } catch (err) {
      const why = (err as Error).message;
      this.log(`room ${this.deps.roomId}: minting TURN credentials failed: ${why}`);
      this.send(sock, { t: "turn", iceServers: stun, ttl: 0, relay: false, error: why });
    }
  }

  // ---- helpers ---------------------------------------------------------------------

  /** Connections that have said hello. */
  private members(): RoomSocket[] {
    return this.deps.sockets().filter((s) => !!s.state()?.member);
  }

  private broadcast(exceptCid: string, msg: ServerMessage, exceptMember?: string): void {
    for (const s of this.members()) {
      if (s.cid !== exceptCid && s.state()!.member!.id !== exceptMember) this.send(s, msg);
    }
  }

  /** Close connections that never said hello. */
  private closeStale(now: number): void {
    for (const s of this.deps.sockets()) {
      const st = s.state();
      if (st && !st.member && now - st.openedAt > this.limits.helloTimeoutMs) s.close(CLOSE.helloTimeout, "no hello");
    }
  }

  private allow(sock: RoomSocket, state: ConnState): boolean {
    const now = this.now();
    state.tokens = Math.min(this.limits.burst, state.tokens + ((now - state.refilledAt) / 1000) * this.limits.perSecond);
    state.refilledAt = now;
    if (state.tokens >= 1) {
      state.tokens -= 1;
      sock.save(state);
      return true;
    }
    state.strikes += 1;
    sock.save(state);
    if (state.strikes >= this.limits.strikes) {
      this.log(`room ${this.deps.roomId}: closed ${state.member?.id ?? "an unknown connection"} for sending too fast`);
      this.fail(sock, "rate", "too many messages", CLOSE.rate);
    } else {
      this.error(sock, "rate", "too many messages; slow down");
    }
    return false;
  }

  private send(sock: RoomSocket, msg: ServerMessage): void {
    try {
      sock.send(JSON.stringify(msg));
    } catch (err) {
      this.log(`room ${this.deps.roomId}: sending ${msg.t} to ${sock.state()?.member?.id ?? sock.cid} failed: ${(err as Error).message}`);
    }
  }

  private error(sock: RoomSocket, code: SignalingErrorCode, message: string): void {
    this.send(sock, { t: "error", code, message });
  }

  private fail(sock: RoomSocket, code: SignalingErrorCode, message: string, closeCode: number): void {
    this.error(sock, code, message);
    sock.close(closeCode, code);
  }

  private async load(): Promise<RoomRecord> {
    if (!this.record) this.record = (await this.deps.storage.get<RoomRecord>("room")) ?? { members: {}, invites: {} };
    return this.record;
  }

  private async save(): Promise<void> {
    await this.deps.storage.put("room", this.record);
  }
}

/**
 * Short-lived Cloudflare TURN credentials, minted with the Worker's TURN key.
 * Port 53 URLs are dropped: browsers block them, and ICE would wait on them.
 */
export async function mintTurnCredentials(turn: TurnConfig, ttlSeconds: number, fetchImpl: typeof fetch): Promise<IceServer[]> {
  const res = await fetchImpl(`${TURN_API}/${encodeURIComponent(turn.keyId)}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${turn.apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: ttlSeconds }),
  });
  if (!res.ok) throw new Error(`Cloudflare TURN answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { iceServers?: unknown };
  const list = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
  const servers: IceServer[] = [];
  for (const s of list as Record<string, unknown>[]) {
    const urls = (Array.isArray(s?.urls) ? s.urls : [s?.urls]).filter((u): u is string => typeof u === "string" && !/:53(\?|$)/.test(u));
    if (!urls.length) continue;
    servers.push({
      urls,
      ...(typeof s.username === "string" ? { username: s.username } : {}),
      ...(typeof s.credential === "string" ? { credential: s.credential } : {}),
    });
  }
  if (!servers.some((s) => s.username)) throw new Error("Cloudflare TURN's answer had no relay credentials");
  return servers;
}
