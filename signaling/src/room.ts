import {
  CLOSE,
  formatFingerprint,
  fromBase64Url,
  helloPayload,
  INTRO_TYPES,
  MAX_REVOKE_EVENT,
  MAX_SIGNALING_MESSAGE,
  MEMBER_ID_RE,
  PUBLIC_KEY_RE,
  roomIdInput,
  SIGNALING_FEATURES,
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
  type SignalingFeature,
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
 * room id was made from — only when that key is on the server's allowlist of
 * creators (ALLOWED_CREATORS), since anyone can make a room id from their own
 * key and members can mint TURN credentials; or a newcomer holding a join key
 * from an invite, once — which (approve) only gets it to the door: knocking,
 * it exchanges the join handshake (INTRO_TYPES) with members and nothing
 * else — no TURN, no invites or admits, no member list but its inviter's
 * presence — until the room's admin admits its key, or denies it (declined:
 * dropped, the invite stays used). The knock expires with the invite. Only
 * the admin's admit adds keys: every member's Mockingbird admits its room
 * log's members (which keeps the server in step after it lost its storage),
 * and only the admin's member.added counts in the log, so the admin's admit
 * is all a joiner needs. A room whose admin the server doesn't know (from
 * before revoke, its creator not seen since) takes any member's admit, as
 * before, so it can't lock everyone out.
 *
 * Getting out (revoke): a member cuts itself off when it leaves; the room's
 * admin cuts off someone it removed. The admin is the creator while a member
 * (its id is stored once its hello proves the salt), else the member admitted
 * earliest here — the app's rule (rooms.ts roomAdmin) as far as the server
 * can know it. A revoked key loses its connections, its invites and TURN; its
 * hellos are refused (with the signed removal, so its app learns of it) until
 * a new invite brings it back, and members can't re-admit it — only the
 * admin can. A room whose creator never said hello since this was deployed
 * has no known admin: only leaving works there.
 *
 * State survives the Durable Object hibernating: the member list and invites
 * live in storage, each connection's own state in its attachment (save()).
 */

export interface ConnState {
  cid: string;
  nonce: string;
  openedAt: number;
  /** Said hello. `knocking`: a joiner at the door (approve), whose invite `inviter` made. */
  member?: { id: string; publicKey: string; team: number; knocking?: boolean; inviter?: string };
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
  /**
   * Member ids allowed to create rooms (ALLOWED_CREATORS). None or empty: no
   * new rooms at all. "any" is for the local test server only.
   */
  allowedCreators?: readonly string[] | "any";
  /** The server-wide daily budget of TURN credentials; each mint takes one. */
  turnQuota?: TurnQuota | null;
  log?: (msg: string) => void;
  limits?: Partial<RoomLimits>;
  /** The SIGNALING_FEATURES served (default all; tests pass fewer to play a Worker deployed before them). */
  features?: readonly SignalingFeature[];
}

export interface TurnQuota {
  take(now: number): Promise<QuotaAnswer>;
}

export interface QuotaAnswer {
  ok: boolean;
  used: number;
  limit: number;
}

/** TURN credentials a Worker mints per UTC day, across all rooms, unless TURN_DAILY_LIMIT says otherwise. */
export const DEFAULT_TURN_DAILY_LIMIT = 200;

/**
 * A count per UTC day, refusing once it reaches `limit`: the Worker's TURN
 * budget (one Durable Object holds it for every room), and the local
 * server's. Logs the first refusal of each day.
 */
export class DailyCounter implements TurnQuota {
  private rec: { day: string; used: number; tripped?: boolean } | null = null;

  constructor(private storage: RoomStorage, private limit: number, private log: (msg: string) => void) {}

  async take(now: number): Promise<QuotaAnswer> {
    const day = new Date(now).toISOString().slice(0, 10);
    this.rec ??= (await this.storage.get<{ day: string; used: number; tripped?: boolean }>("daily")) ?? { day, used: 0 };
    if (this.rec.day !== day) this.rec = { day, used: 0 };
    if (this.rec.used >= this.limit) {
      if (!this.rec.tripped) {
        this.rec.tripped = true;
        await this.storage.put("daily", this.rec);
        this.log(`TURN budget used up: ${this.rec.used} credentials minted today (${day}, limit ${this.limit}); refusing more until midnight UTC`);
      }
      return { ok: false, used: this.rec.used, limit: this.limit };
    }
    this.rec.used += 1;
    await this.storage.put("daily", this.rec);
    return { ok: true, used: this.rec.used, limit: this.limit };
  }
}

/** TURN_DAILY_LIMIT as a count, or the default when unset or not a positive whole number. */
export function turnDailyLimit(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_TURN_DAILY_LIMIT;
}

interface RoomRecord {
  members: Record<string, { publicKey: string; addedAt: number }>;
  invites: Record<string, { expiresAt: number; by: string; usedAt?: number }>;
  /** The room's creator, once its hello proved the salt (absent in rooms created before revoke, until then). */
  creator?: string;
  /** Keys cut off, with the signed removal to pass on. */
  revoked?: Record<string, { at: number; by: string; event?: unknown }>;
  /** Joiners at the door (approve): the invite (hash) they used, who made it, and when the knock expires (with the invite). */
  knocking?: Record<string, Knock>;
}

interface Knock {
  publicKey: string;
  invite: string;
  by: string;
  at: number;
  expiresAt: number;
}

/** Revocations a room remembers (the oldest go first); the newest are handed to members in the welcome. */
const MAX_REVOKED = 100;
const WELCOME_EVENTS = 20;

/**
 * Who may revoke other members, as this server knows the room: its creator
 * while a member, else the member admitted earliest (ties: the lower id).
 * Null when the creator isn't known (a room created before revoke whose
 * creator hasn't said hello since) or nobody is left.
 */
export function signalingAdmin(rec: { creator?: string; members: Record<string, { addedAt: number }> }): string | null {
  if (!rec.creator) return null;
  if (rec.members[rec.creator]) return rec.creator;
  let best: [string, number] | null = null;
  for (const [id, m] of Object.entries(rec.members)) if (!best || m.addedAt < best[1] || (m.addedAt === best[1] && id < best[0])) best = [id, m.addedAt];
  return best?.[0] ?? null;
}

export const TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";

export class SignalingRoom {
  private record: RoomRecord | null = null;
  private readonly crypto: RoomCrypto;
  private readonly now: () => number;
  private readonly limits: RoomLimits;
  private readonly log: (msg: string) => void;
  private readonly features: readonly SignalingFeature[];

  constructor(private deps: RoomDeps) {
    this.crypto = deps.crypto ?? webCrypto;
    this.now = deps.now ?? Date.now;
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.log = deps.log ?? ((m) => console.log(m));
    this.features = deps.features ?? SIGNALING_FEATURES;
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
    // membership is checked on every message: a connection whose key was revoked meanwhile gets nothing more (TURN included)
    const rec = await this.load();
    if (!rec.members[me.id]) {
      const knock = this.approves() ? rec.knocking?.[me.id] : undefined;
      if (knock && knock.expiresAt > this.now()) {
        // at the door: the join handshake with members, and nothing else
        if (msg.t === "signal") return this.relay(sock, me, msg);
        if (msg.t === "hello") return this.error(sock, "bad-message", "already said hello");
        this.log(`room ${this.deps.roomId}: refused a ${String(msg.t).slice(0, 20)} from ${me.id}, who's waiting at the door`);
        return this.error(sock, "knocking", `this key is waiting for the room's admin to accept it: ${String(msg.t).slice(0, 20)} is for members`);
      }
      if (knock) {
        delete rec.knocking![me.id];
        await this.save();
        this.log(`room ${this.deps.roomId}: ${me.id}'s knock expired with its invite`);
        return this.fail(sock, "not-member", "the invite expired before the room's admin accepted this key", CLOSE.notMember);
      }
      this.log(`room ${this.deps.roomId}: refused a ${String(msg.t).slice(0, 20)} from ${me.id}, who isn't a member any more`);
      return this.fail(sock, "not-member", "this key isn't a member of the room any more", CLOSE.notMember);
    }
    if (me.knocking) {
      // admitted since this connection said hello (promote() tells open connections at once; this catches one it missed)
      state.member = { id: me.id, publicKey: me.publicKey, team: me.team };
      sock.save(state);
    }
    switch (msg.t) {
      case "hello":
        return this.error(sock, "bad-message", "already said hello");
      case "signal":
        return this.relay(sock, me, msg);
      case "invite":
        return this.invite(sock, me, msg);
      case "admit":
        return this.admit(sock, me, msg);
      case "turn":
        return this.turn(sock, state);
      case "revoke":
        if (this.features.includes("revoke")) return this.revoke(sock, me, msg);
        return this.error(sock, "bad-message", "unknown message revoke");
      case "deny":
        if (this.approves()) return this.deny(sock, me, msg);
        return this.error(sock, "bad-message", "unknown message deny");
      default:
        return this.error(sock, "bad-message", `unknown message ${String((msg as { t: unknown }).t).slice(0, 20)}`);
    }
  }

  /** A connection closed: the others hear the member left, unless it's still connected another way. */
  close(sock: RoomSocket): void {
    const me = sock.state()?.member;
    if (!me) return;
    const still = this.members().some((s) => s.cid !== sock.cid && s.state()?.member?.id === me.id);
    if (!still) this.presence(sock.cid, me, false);
  }

  /** Member ids the room admits (for tests and diagnostics). */
  async memberIds(): Promise<string[]> {
    return Object.keys((await this.load()).members);
  }

  /** Keys knocking at the door, their knock not expired (for tests and diagnostics). */
  async knockingIds(): Promise<string[]> {
    const now = this.now();
    return Object.entries((await this.load()).knocking ?? {})
      .filter(([, k]) => k.expiresAt > now)
      .map(([id]) => id);
  }

  private approves(): boolean {
    return this.features.includes("approve");
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
    // the creator proves itself with the salt its room id was made from (also on later hellos, so a room from before revoke learns its creator)
    const isCreator = !!msg.create && toBase64Url(await this.crypto.sha256(utf8(roomIdInput(msg.publicKey, msg.create)))).slice(0, 22) === this.deps.roomId;
    const revoked = rec.revoked?.[id];
    if (!admitted && isCreator && !revoked) {
      const allowed = this.deps.allowedCreators ?? [];
      if (allowed !== "any" && !allowed.includes(id)) {
        const message = allowed.length
          ? `This key (${formatFingerprint(id)}) isn't allowed to create rooms on this signaling Worker — add its fingerprint to ALLOWED_CREATORS`
          : `This signaling Worker doesn't allow new rooms yet — add your fingerprint (${formatFingerprint(id)}) to ALLOWED_CREATORS`;
        this.log(`room ${this.deps.roomId}: refused to create it for ${id} (not in ALLOWED_CREATORS)`);
        return this.fail(sock, "creation-refused", message, CLOSE.creationRefused);
      }
      admitted = changed = true;
    }
    if (isCreator && this.features.includes("revoke") && rec.creator !== id && (admitted || !revoked)) {
      rec.creator = id;
      changed = true;
    }
    let knock: Knock | undefined;
    if (!admitted && this.approves()) {
      // a join key gets a key to the door, not in: the room's admin admits it (or denies it)
      const held = rec.knocking?.[id];
      if (held && held.expiresAt > now && held.publicKey === msg.publicKey) knock = held;
      else {
        if (held) {
          delete rec.knocking![id];
          changed = true;
        }
        if (msg.join) {
          const hash = toBase64Url(await this.crypto.sha256(utf8(msg.join)));
          const invite = rec.invites[hash];
          if (invite && !invite.usedAt && invite.expiresAt > now) {
            invite.usedAt = now;
            rec.knocking ??= {};
            knock = rec.knocking[id] = { publicKey: msg.publicKey, invite: hash, by: invite.by, at: now, expiresAt: invite.expiresAt };
            changed = true;
          }
        }
      }
    } else if (!admitted && msg.join) {
      const hash = toBase64Url(await this.crypto.sha256(utf8(msg.join)));
      const invite = rec.invites[hash];
      if (invite && !invite.usedAt && invite.expiresAt > now) {
        invite.usedAt = now;
        admitted = changed = true;
        // a new invite brings a revoked key back
        if (revoked) delete rec.revoked![id];
      }
    }
    if (!admitted && !knock && revoked) {
      if (changed) await this.save();
      this.log(`room ${this.deps.roomId}: refused ${id} (revoked by ${revoked.by})`);
      this.send(sock, { t: "error", code: "not-member", message: "this key was removed from the room", revoked: true, ...(revoked.event !== undefined ? { event: revoked.event } : {}) });
      return sock.close(CLOSE.notMember, "not-member");
    }
    if (!admitted && !knock) {
      if (changed) await this.save();
      this.log(`room ${this.deps.roomId}: refused ${id} (not a member, no valid join key)`);
      return this.fail(sock, "not-member", "this key isn't a member of the room, and holds no valid invite", CLOSE.notMember);
    }
    const online = new Set(this.members().filter((s) => s.cid !== sock.cid && s.state()!.member!.id !== id).map((s) => s.state()!.member!.id));
    if (online.size >= this.limits.maxOnline) return this.fail(sock, "room-full", `at most ${this.limits.maxOnline} members can be connected at once`, CLOSE.roomFull);
    if (admitted && !rec.members[id]) rec.members[id] = { publicKey: msg.publicKey, addedAt: now };
    if (changed) await this.save();
    state.member = knock ? { id, publicKey: msg.publicKey, team: msg.team, knocking: true, inviter: knock.by } : { id, publicKey: msg.publicKey, team: msg.team };
    sock.save(state);
    // one connection per member: an app that reconnected replaces its old socket
    for (const s of this.members()) {
      if (s.cid !== sock.cid && s.state()?.member?.id === id) {
        this.send(s, { t: "error", code: "replaced", message: "the same member connected again" });
        s.close(CLOSE.replaced, "replaced");
      }
    }
    this.send(sock, this.welcome(sock, state.member, rec, now));
    this.presence(sock.cid, state.member, true);
    this.closeStale(now, rec);
  }

  /**
   * What a connection is told on hello (and again once a knocking key is
   * admitted): a member, everyone connected (joiners at the door flagged),
   * the server's features and the newest removals; a joiner at the door, only
   * whether its inviter is connected — nothing else of the room.
   */
  private welcome(sock: RoomSocket, me: NonNullable<ConnState["member"]>, rec: RoomRecord, now: number): ServerMessage {
    const others = this.members().filter((s) => s.cid !== sock.cid && s.state()!.member!.id !== me.id).map((s) => s.state()!.member!);
    if (me.knocking) {
      const peers: SignalingPeer[] = others.filter((m) => m.id === me.inviter && !m.knocking).map((m) => ({ id: m.id, team: m.team }));
      return { t: "welcome", v: SIGNALING_PROTOCOL, you: me.id, now, peers, relay: false, features: [...this.features], knocking: true };
    }
    const peers: SignalingPeer[] = others.map((m) => ({ id: m.id, team: m.team, ...(m.knocking ? { knocking: true } : {}) }));
    const welcome: ServerMessage = { t: "welcome", v: SIGNALING_PROTOCOL, you: me.id, now, peers, relay: !!this.deps.turn };
    if (this.features.length) {
      welcome.features = [...this.features];
      // removals members who were offline then haven't heard of: each app checks the signed event itself
      const events = Object.values(rec.revoked ?? {})
        .filter((r) => r.event !== undefined)
        .sort((a, b) => a.at - b.at)
        .slice(-WELCOME_EVENTS)
        .map((r) => r.event);
      if (events.length) welcome.events = events;
    }
    return welcome;
  }

  /**
   * Tell connections that `who` came (or went): members hear of everyone,
   * joiners at the door flagged; a joiner at the door hears only of its
   * inviter.
   */
  private presence(exceptCid: string, who: { id: string; team?: number; knocking?: boolean }, joined: boolean): void {
    for (const s of this.members()) {
      const m = s.state()!.member!;
      if (s.cid === exceptCid || m.id === who.id) continue;
      if (m.knocking && (who.knocking || who.id !== m.inviter)) continue;
      this.send(s, joined ? { t: "peer-joined", peer: { id: who.id, team: who.team ?? 0, ...(who.knocking ? { knocking: true } : {}) } } : { t: "peer-left", id: who.id });
    }
  }

  private async relay(sock: RoomSocket, me: NonNullable<ConnState["member"]>, msg: Extract<ClientMessage, { t: "signal" }>): Promise<void> {
    if (typeof msg.to !== "string" || !MEMBER_ID_RE.test(msg.to) || !msg.env || typeof msg.env !== "object") return this.error(sock, "bad-message", "malformed signal");
    if (msg.env.from !== me.id) return this.error(sock, "bad-message", "a signal's sender must be the connected member");
    if (this.approves()) {
      // a joiner at the door and a member exchange the join handshake, and only that
      const rec = await this.load();
      const fromDoor = !rec.members[me.id];
      const toDoor = !rec.members[msg.to] && !!rec.knocking?.[msg.to];
      const intro = INTRO_TYPES.includes((msg.env as { type?: unknown }).type as never);
      if ((fromDoor || toDoor) && (!intro || (fromDoor && !rec.members[msg.to]))) {
        return this.send(sock, { t: "error", code: "knocking", message: "a joiner at the door only exchanges the join handshake with members until the room's admin admits it", to: msg.to });
      }
    }
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

  private async admit(sock: RoomSocket, me: NonNullable<ConnState["member"]>, msg: Extract<ClientMessage, { t: "admit" }>): Promise<void> {
    if (!Array.isArray(msg.publicKeys) || msg.publicKeys.length > 64 || msg.publicKeys.some((k) => typeof k !== "string" || !PUBLIC_KEY_RE.test(k))) {
      return this.error(sock, "bad-message", "malformed admit");
    }
    const rec = await this.load();
    const ids: string[] = [];
    const promoted: { id: string; publicKey: string }[] = [];
    let changed = false;
    // a member who hasn't heard of a removal yet would admit the key again: only the admin brings a revoked key back
    const known = signalingAdmin(rec);
    const admin = known === me.id;
    // approve: only the admin adds keys (with no known admin — a room from before revoke — any member, as before)
    const mayAdd = !this.approves() || admin || known === null;
    for (const k of msg.publicKeys) {
      const id = toHex(await this.crypto.sha256(fromBase64Url(k))).slice(0, 32);
      if (rec.revoked?.[id]) {
        if (!admin) {
          this.log(`room ${this.deps.roomId}: ${me.id} admitted ${id}, which was revoked; kept out`);
          continue;
        }
        delete rec.revoked[id];
        changed = true;
      }
      if (!rec.members[id] && !mayAdd) {
        this.log(`room ${this.deps.roomId}: ignored ${me.id}'s admit of ${id}: only the room's admin (${known}) adds keys${rec.knocking?.[id] ? "; it waits at the door" : ""}`);
        continue;
      }
      ids.push(id);
      if (!rec.members[id]) {
        rec.members[id] = { publicKey: k, addedAt: this.now() };
        changed = true;
        if (rec.knocking?.[id]) {
          delete rec.knocking[id];
          promoted.push({ id, publicKey: k });
        }
      }
    }
    if (changed) await this.save();
    this.send(sock, { t: "admitted", ids });
    for (const p of promoted) {
      this.log(`room ${this.deps.roomId}: ${me.id} let ${p.id} in from the door`);
      this.promote(p.id, rec);
    }
  }

  /** A key at the door was admitted: its open connections become a member's (welcomed again, as members get), and members hear it's here. */
  private promote(id: string, rec: RoomRecord): void {
    const now = this.now();
    for (const s of this.members()) {
      const st = s.state()!;
      const m = st.member!;
      if (m.id !== id || !m.knocking) continue;
      st.member = { id: m.id, publicKey: m.publicKey, team: m.team };
      s.save(st);
      this.send(s, this.welcome(s, st.member, rec, now));
      this.presence(s.cid, st.member, true);
    }
  }

  /**
   * Drop a joiner knocking at the door (its admin declined the join): its
   * knock and connections go, and the invite it used stays used, so it needs
   * a new code to ask again. The room's admin only (or anyone, in a room
   * whose admin the server doesn't know).
   */
  private async deny(sock: RoomSocket, me: NonNullable<ConnState["member"]>, msg: Extract<ClientMessage, { t: "deny" }>): Promise<void> {
    if (typeof msg.member !== "string" || !MEMBER_ID_RE.test(msg.member)) return this.error(sock, "bad-message", "malformed deny");
    const rec = await this.load();
    const target = msg.member;
    const admin = signalingAdmin(rec);
    if (admin !== null && admin !== me.id) {
      const why = `only the room's admin can decline joins, and this server sees ${admin} as the admin`;
      this.log(`room ${this.deps.roomId}: refused ${me.id}'s deny of ${target}: ${why}`);
      return this.send(sock, { t: "error", code: "forbidden", message: why, member: target });
    }
    if (rec.members[target]) return this.send(sock, { t: "error", code: "forbidden", message: "that key is a member, not at the door: remove it instead", member: target });
    if (rec.knocking?.[target]) {
      delete rec.knocking[target];
      await this.save();
    }
    this.log(`room ${this.deps.roomId}: ${me.id} declined ${target} at the door`);
    this.send(sock, { t: "denied", member: target });
    let had = false;
    for (const s of this.members()) {
      if (s.state()?.member?.id !== target) continue;
      had = true;
      this.send(s, { t: "error", code: "not-member", message: "the room's admin declined this join", declined: true });
      s.close(CLOSE.notMember, "declined");
    }
    if (had) this.presence("", { id: target }, false);
  }

  /**
   * Cut a member off: itself (leaving), or anyone from the room's admin. Its
   * key, connections and invites go, its hellos are refused from now on, and
   * the signed removal it carries is passed on (to it, and to members in
   * their welcome). Revoking someone who isn't a member is harmless: the
   * removal is recorded all the same, so their next hello hears of it.
   */
  private async revoke(sock: RoomSocket, me: NonNullable<ConnState["member"]>, msg: Extract<ClientMessage, { t: "revoke" }>): Promise<void> {
    if (typeof msg.member !== "string" || !MEMBER_ID_RE.test(msg.member)) return this.error(sock, "bad-message", "malformed revoke");
    let event: unknown;
    if (msg.event !== undefined) {
      let size = Infinity;
      try {
        size = JSON.stringify(msg.event).length;
      } catch {
        // not JSON: refused below
      }
      if (size > MAX_REVOKE_EVENT) return this.error(sock, "bad-message", `a revoke's event is limited to ${MAX_REVOKE_EVENT} bytes`);
      event = msg.event;
    }
    const rec = await this.load();
    const target = msg.member;
    if (target !== me.id) {
      const admin = signalingAdmin(rec);
      if (admin !== me.id) {
        const why = !rec.creator
          ? "this signaling server doesn't know the room's creator yet (a room from before removal existed, whose creator hasn't connected since): only leaving works here"
          : `only the room's admin can remove members, and this server sees ${admin ?? "nobody"} as the admin`;
        this.log(`room ${this.deps.roomId}: refused ${me.id}'s revoke of ${target}: ${why}`);
        return this.send(sock, { t: "error", code: "forbidden", message: why, member: target });
      }
    }
    delete rec.members[target];
    if (rec.knocking?.[target]) delete rec.knocking[target];
    for (const [hash, inv] of Object.entries(rec.invites)) if (inv.by === target) delete rec.invites[hash];
    rec.revoked ??= {};
    rec.revoked[target] = { at: this.now(), by: me.id, ...(event !== undefined ? { event } : {}) };
    const all = Object.entries(rec.revoked).sort(([, a], [, b]) => a.at - b.at);
    for (const [id] of all.slice(0, Math.max(0, all.length - MAX_REVOKED))) delete rec.revoked[id];
    await this.save();
    this.log(`room ${this.deps.roomId}: ${me.id} revoked ${target}${target === me.id ? " (left)" : ""}`);
    this.send(sock, { t: "revoked", member: target });
    // their connections close, with the removal passed on; the others hear they're gone
    let had = false;
    for (const s of this.members()) {
      if (s.state()?.member?.id !== target) continue;
      had = true;
      if (s.cid !== sock.cid) this.send(s, { t: "error", code: "not-member", message: "this key was removed from the room", revoked: true, ...(event !== undefined ? { event } : {}) });
      s.close(CLOSE.notMember, "revoked");
    }
    if (had) this.presence("", { id: target }, false);
  }

  private async turn(sock: RoomSocket, state: ConnState): Promise<void> {
    const now = this.now();
    if (state.turnAt && now - state.turnAt < this.limits.turnIntervalMs) return this.error(sock, "rate", "relay credentials were just issued; ask again in a little while");
    state.turnAt = now;
    sock.save(state);
    const stun = this.deps.stun ?? PUBLIC_STUN;
    if (!this.deps.turn) return this.send(sock, { t: "turn", iceServers: stun, ttl: 0, relay: false });
    if (this.deps.turnQuota) {
      let q: QuotaAnswer;
      try {
        q = await this.deps.turnQuota.take(now);
      } catch (err) {
        // the budget couldn't be checked: no credentials, rather than unmetered ones
        const why = `couldn't check the relay budget: ${(err as Error).message}`;
        this.log(`room ${this.deps.roomId}: ${why}`);
        return this.send(sock, { t: "turn", iceServers: stun, ttl: 0, relay: false, error: why });
      }
      if (!q.ok) return this.send(sock, { t: "turn", iceServers: stun, ttl: 0, relay: false, error: `the signaling Worker's daily relay budget (${q.limit} credentials) is used up until midnight UTC` });
    }
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

  /** Close connections that never said hello, and joiners at the door whose knock expired with its invite. */
  private closeStale(now: number, rec: RoomRecord): void {
    for (const s of this.deps.sockets()) {
      const st = s.state();
      if (st && !st.member && now - st.openedAt > this.limits.helloTimeoutMs) s.close(CLOSE.helloTimeout, "no hello");
      const m = st?.member;
      if (m?.knocking && !rec.members[m.id] && !((rec.knocking?.[m.id]?.expiresAt ?? 0) > now)) {
        this.send(s, { t: "error", code: "not-member", message: "the invite expired before the room's admin accepted this key" });
        s.close(CLOSE.notMember, "expired");
      }
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
