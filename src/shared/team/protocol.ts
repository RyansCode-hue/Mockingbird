/**
 * Team rooms: what travels between Mockingbirds and the signaling Worker, and
 * the exact bytes each signature covers. Plain code with no Node, Electron or
 * Cloudflare APIs, so the app, the hidden peer host and the Worker share it.
 *
 * Two versions are kept apart:
 * - SIGNALING_PROTOCOL: the messages between an app and the signaling server.
 *   A mismatch means the Worker (or the app) needs redeploying/updating.
 * - TEAM_PROTOCOL: everything between two Mockingbirds (signed envelopes, the
 *   peer-to-peer frames). A teammate on another version is shown as "needs an
 *   update" instead of half-working.
 */

export const SIGNALING_PROTOCOL = 1;
export const TEAM_PROTOCOL = 1;

/** Signed signaling envelopes older or newer than this (against the signaling server's clock) are refused. */
export const REPLAY_WINDOW_MS = 120_000;
/** The largest message the signaling server relays. SDP is a few KB. */
export const MAX_SIGNALING_MESSAGE = 64 * 1024;

/** The keep-alive the Worker answers without waking the room (setWebSocketAutoResponse). */
export const SIGNALING_PING = '{"t":"ping"}';
export const SIGNALING_PONG = '{"t":"pong"}';

// ---- identifiers ---------------------------------------------------------------
// memberId: the first 128 bits of SHA-256 over the raw Ed25519 public key, hex.
// roomId:   the first 22 base64url characters of SHA-256(roomIdInput), binding a
//           room to its creator's key, so nobody else can claim it.

export const MEMBER_ID_RE = /^[0-9a-f]{32}$/;
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** A raw 32-byte Ed25519 public key, base64url. */
export const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
/** A 64-byte Ed25519 signature, base64url. */
export const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;
/** 32 random or hashed bytes, base64url: join tokens and their hashes. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const roomIdInput = (creatorPublicKey: string, salt: string) => `mockingbird-team/room/v1\n${creatorPublicKey}\n${salt}`;
/** What the signaling server is given for a join: a hash of the invite token, never the token itself. */
export const signalingJoinKeyInput = (token: string) => `mockingbird-team/signaling-join/v1\n${token}`;
/** HMAC input (keyed by the invite token) that proves to the inviter that a joiner holds the code. */
export const joinProofInput = (roomId: string, joinerPublicKey: string) => `mockingbird-team/join/v1\n${roomId}\n${joinerPublicKey}`;

/** "a1b2c3d4…" → "a1b2 c3d4 e5f6 …": how a fingerprint is read aloud or compared by eye. */
export function formatFingerprint(fp: string): string {
  return fp.replace(/(.{4})(?=.)/g, "$1 ");
}

// ---- encoding --------------------------------------------------------------------

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * JSON with object keys sorted at every level, so a body signed on one machine
 * and parsed on another gives the same bytes. Undefined object members are
 * dropped (as JSON.stringify does); anything JSON can't carry throws.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  switch (typeof v) {
    case "string":
    case "boolean":
      return JSON.stringify(v);
    case "number":
      if (!Number.isFinite(v)) throw new Error("canonicalJson: a number that JSON can't carry");
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: can't encode a ${typeof v}`);
  }
}

// ---- signed signaling envelopes ------------------------------------------------------

/**
 * Connection details between two members, relayed by the signaling server.
 * offer/answer/ice carry WebRTC negotiation; knock asks the other side (the
 * offerer) to connect; join and join-* introduce a new member to its inviter.
 */
export type SignalType = "offer" | "answer" | "ice" | "knock" | "join" | "join-accepted" | "join-rejected";
export const SIGNAL_TYPES: SignalType[] = ["offer", "answer", "ice", "knock", "join", "join-accepted", "join-rejected"];
/** Signals that travel before the two sides know each other as members: the sender's key is in the body. */
export const INTRO_TYPES: SignalType[] = ["join", "join-accepted", "join-rejected"];

export interface UnsignedEnvelope {
  /** TEAM_PROTOCOL of the sender. */
  v: number;
  roomId: string;
  from: string;
  to: string;
  type: SignalType;
  body: unknown;
  /** Sender's time, ms, corrected to the signaling server's clock. */
  ts: number;
  nonce: string;
}
export interface SignedEnvelope extends UnsignedEnvelope {
  sig: string;
}

/** The exact text an envelope's signature covers. */
export function signalPayload(e: UnsignedEnvelope): string {
  return `mockingbird-team/signal/v1\n${JSON.stringify([e.v, e.roomId, e.from, e.to, e.type, canonicalJson(e.body), e.ts, e.nonce])}`;
}

/** The exact text a signaling hello's signature covers: the server's challenge, bound to the room and key. */
export function helloPayload(roomId: string, nonce: string, m: { publicKey: string; join?: string; create?: string }): string {
  return `mockingbird-team/hello/v1\n${JSON.stringify([roomId, nonce, m.publicKey, m.join ?? "", m.create ?? ""])}`;
}

/** An envelope's fields are the right shapes (signature not checked). Returns why not, or null. */
export function envelopeProblem(e: unknown): string | null {
  if (!e || typeof e !== "object") return "not an object";
  const x = e as Record<string, unknown>;
  if (typeof x.v !== "number") return "no version";
  if (typeof x.roomId !== "string" || !ROOM_ID_RE.test(x.roomId)) return "bad room id";
  if (typeof x.from !== "string" || !MEMBER_ID_RE.test(x.from)) return "bad sender";
  if (typeof x.to !== "string" || !MEMBER_ID_RE.test(x.to)) return "bad recipient";
  if (typeof x.type !== "string" || !SIGNAL_TYPES.includes(x.type as SignalType)) return `unknown type ${String(x.type).slice(0, 20)}`;
  if (typeof x.ts !== "number" || !Number.isFinite(x.ts)) return "bad timestamp";
  if (typeof x.nonce !== "string" || !NONCE_RE.test(x.nonce)) return "bad nonce";
  if (typeof x.sig !== "string" || !SIGNATURE_RE.test(x.sig)) return "bad signature encoding";
  return null;
}

/**
 * Refuses envelopes outside the replay window and any (sender, nonce) seen
 * within it. Timestamps are on the signaling server's clock (see welcome.now).
 */
export class ReplayGuard {
  private seen = new Map<string, number>();
  constructor(private windowMs = REPLAY_WINDOW_MS) {}

  check(from: string, ts: number, nonce: string, now: number): "ok" | "stale" | "replayed" {
    this.prune(now);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > this.windowMs) return "stale";
    const key = `${from}:${nonce}`;
    if (this.seen.has(key)) return "replayed";
    this.seen.set(key, ts + this.windowMs);
    return "ok";
  }

  /** A nonce is kept while its envelope could still pass the window: a replay carries the signed ts. */
  private prune(now: number): void {
    for (const [k, expires] of this.seen) if (expires < now) this.seen.delete(k);
  }
}

// ---- signaling server wire messages ------------------------------------------------------

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** A member connected to the room's signaling, with the TEAM_PROTOCOL it announced. */
export interface SignalingPeer {
  id: string;
  team: number;
}

export type ClientMessage =
  | { t: "hello"; v: number; team: number; publicKey: string; sig: string; join?: string; create?: string }
  | { t: "invite"; tokenHash: string; expiresAt: number }
  | { t: "admit"; publicKeys: string[] }
  | { t: "signal"; to: string; env: SignedEnvelope }
  | { t: "turn" }
  | { t: "ping" };

export type SignalingErrorCode =
  | "protocol" // the hello's SIGNALING_PROTOCOL isn't the server's
  | "bad-message"
  | "not-member" // neither a member, the room's creator, nor holding a valid join token
  | "not-ready" // a message before the hello was accepted
  | "room-full"
  | "rate" // too many messages
  | "too-big"
  | "peer-offline" // a signal to a member who isn't connected
  | "replaced"; // the same member connected again; this connection is closed

export type ServerMessage =
  | { t: "challenge"; v: number; nonce: string }
  | { t: "welcome"; v: number; you: string; now: number; peers: SignalingPeer[]; relay: boolean }
  | { t: "peer-joined"; peer: SignalingPeer }
  | { t: "peer-left"; id: string }
  | { t: "signal"; from: string; env: SignedEnvelope }
  | { t: "turn"; iceServers: IceServer[]; ttl: number; relay: boolean; error?: string }
  | { t: "invited"; tokenHash: string }
  | { t: "admitted"; ids: string[] }
  | { t: "error"; code: SignalingErrorCode; message: string; serverProtocol?: number; to?: string }
  | { t: "pong" };

/** WebSocket close codes the signaling server uses (4000–4999 are the application's). */
export const CLOSE = {
  protocol: 4000,
  notMember: 4001,
  replaced: 4002,
  rate: 4008,
  badMessage: 4009,
  helloTimeout: 4010,
  roomFull: 4011,
} as const;

/** The signaling server's WebSocket URL for a room, from the URL Settings holds (https → wss, http → ws). */
export function signalingSocketUrl(base: string, roomId: string): string {
  const u = new URL(base);
  if (u.protocol !== "https:" && u.protocol !== "http:" && u.protocol !== "wss:" && u.protocol !== "ws:") throw new Error(`The signaling URL must start with https:// (got ${base})`);
  u.protocol = u.protocol === "https:" || u.protocol === "wss:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/rooms/${roomId}`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

// ---- DTLS fingerprints -----------------------------------------------------------------

/** "AB:CD:…" → "abcd…": how fingerprints are compared. */
export const normalizeFingerprint = (s: string): string => s.replace(/:/g, "").toLowerCase();

/**
 * The single SHA-256 DTLS fingerprint a session description announces,
 * normalized. Throws when there is none, more than one, or another algorithm:
 * the connection is pinned to exactly this certificate.
 */
export function sdpFingerprint(sdp: string): string {
  const found = new Set<string>();
  for (const line of sdp.split(/\r?\n/)) {
    const m = /^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)\s*$/.exec(line);
    if (!m) continue;
    if (m[1].toLowerCase() !== "sha-256") throw new Error(`unsupported DTLS fingerprint algorithm ${m[1]}`);
    found.add(normalizeFingerprint(m[2]));
  }
  if (found.size === 0) throw new Error("the session description has no DTLS fingerprint");
  if (found.size > 1) throw new Error("the session description names more than one DTLS fingerprint");
  return [...found][0];
}

// ---- invite codes --------------------------------------------------------------------------

export const INVITE_VERSION = 1;

/** What an invite code carries: enough to reach the room and prove the right to join it once. */
export interface Invite {
  roomId: string;
  /** The signaling server's base URL (from the inviter's Settings → Team). */
  url: string;
  /** The one-time join token (32 random bytes, base64url). */
  token: string;
  /** The inviter's member id: the joiner accepts the room only from this key. */
  inviter: string;
  /** The room's name, shown before joining. */
  name: string;
}

export class InviteError extends Error {}

export function encodeInvite(i: Invite): string {
  const json = JSON.stringify({ r: i.roomId, u: i.url, t: i.token, f: i.inviter, n: i.name });
  return `MBR${INVITE_VERSION}-${toBase64Url(utf8(json))}`;
}

/** An invite code as pasted (spaces and line breaks from wrapping are ignored). Throws InviteError saying what's wrong. */
export function decodeInvite(code: string): Invite {
  const compact = code.replace(/\s+/g, "");
  const m = /^MBR(\d+)-([A-Za-z0-9_-]+)$/.exec(compact);
  if (!m) throw new InviteError("That isn't a Mockingbird room code — it starts with MBR1-");
  const v = Number(m[1]);
  if (v > INVITE_VERSION) throw new InviteError("This room code comes from a newer Mockingbird — update to join the room");
  if (v !== INVITE_VERSION) throw new InviteError(`Room codes of version ${v} aren't supported`);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(new TextDecoder().decode(fromBase64Url(m[2])));
  } catch {
    throw new InviteError("The room code is damaged — copy it again");
  }
  const invite = { roomId: raw.r, url: raw.u, token: raw.t, inviter: raw.f, name: raw.n };
  if (typeof invite.roomId !== "string" || !ROOM_ID_RE.test(invite.roomId)) throw new InviteError("The room code is damaged (room id)");
  if (typeof invite.token !== "string" || !TOKEN_RE.test(invite.token)) throw new InviteError("The room code is damaged (token)");
  if (typeof invite.inviter !== "string" || !MEMBER_ID_RE.test(invite.inviter)) throw new InviteError("The room code is damaged (inviter)");
  if (typeof invite.name !== "string" || invite.name.length > 200) throw new InviteError("The room code is damaged (name)");
  if (typeof invite.url !== "string" || !/^https?:\/\/[^\s]+$/.test(invite.url)) throw new InviteError("The room code is damaged (signaling URL)");
  return invite as Invite;
}
