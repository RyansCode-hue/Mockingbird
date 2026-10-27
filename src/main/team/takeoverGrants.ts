import * as crypto from "crypto";
import { verifySignature } from "./identity";
import { canonicalJson, MEMBER_ID_RE, SIGNATURE_RE } from "../../shared/team/protocol";
import { AWAY_GRANT_MAX_MS, GRANT_SKEW_MS, HANDOVER_GRANT_MS, SESSION_ID_RE, type TakeoverGrant } from "../../shared/team/takeover";
import type { MemberId, RoomState } from "../../shared/team/types";

/**
 * A session's owner's consent to a take-over while they're online (security
 * review R6, M3): a grant the owner's key signs, carried in the
 * `session.takenOver` event. Two kinds:
 *
 *   - "handover": the owner's Mockingbird answered a teammate's request with
 *     Hand over: for that one session, that teammate, that snapshot, for
 *     HANDOVER_GRANT_MS;
 *   - "away" (1.5, no longer given): the owner allowed take-overs while they
 *     were away, ahead of time, for some of their sessions in the room or all
 *     of them, until it expired (at most AWAY_GRANT_MAX_MS). Published as
 *     `session.awayGrant`, the owner's latest one counting. Logs keep them, so
 *     the take-overs they granted still count. From 1.6 a take-over while the
 *     owner is offline needs no grant (takeover.ts: `offline`, and the owner's
 *     Mac refusing one taken while it was connected to the taker).
 *
 * Every member checks the grant the same way where the take-over falls in the
 * room's order (grantProblem, from the reducer), so the owner's Mac stops its
 * session only for a take-over its owner granted — whoever's Mockingbird
 * published it — and the taker's Mac checks before it starts anything.
 *
 * No role gets past this: the room's owner or an admin can't take an online
 * member's session over without that member's hand-over either.
 *
 * The times compared are the take-over event's own (its author's clock), the
 * only time every member agrees on: a taker whose clock is wrong on purpose
 * can use a grant past its expiry, but never without the owner having signed
 * one for that session. An away grant, which can't be withdrawn any more, gets
 * no further than an offline take-over: the owner's Mac refuses a take-over
 * under one stamped while it was connected to the taker (takeover.ts,
 * ownerChecks).
 */

const GRANT_ID_RE = /^[0-9a-f]{16,64}$/;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** How many sessions an away grant can name; more than that, it covers all of them. */
export const MAX_GRANT_SESSIONS = 200;

/** What the owner's key signs: the grant without its signature, in canonical JSON, under its own label. */
export const grantInput = (g: Omit<TakeoverGrant, "sig">): string => `mockingbird-team/takeover-grant/v1\n${canonicalJson(g)}`;

/** A grant signed by this install's identity (Team.sign). */
export function signGrant(signer: { self: { id: MemberId }; sign(text: string): string }, g: Omit<TakeoverGrant, "sig" | "v" | "id" | "owner">): TakeoverGrant {
  const unsigned: Omit<TakeoverGrant, "sig"> = { v: 1, id: crypto.randomBytes(12).toString("hex"), owner: signer.self.id, ...g };
  return { ...unsigned, sig: signer.sign(grantInput(unsigned)) };
}

/** Why `g` isn't a well-formed grant, or null. Signatures aren't checked here. */
export function grantShapeProblem(g: any): string | null {
  if (!g || typeof g !== "object" || Array.isArray(g)) return "no grant";
  if (g.v !== 1) return "an unknown kind of grant";
  if (g.kind !== "handover" && g.kind !== "away") return "a grant must be a hand-over or an away grant";
  if (typeof g.id !== "string" || !GRANT_ID_RE.test(g.id)) return "a grant needs an id";
  if (typeof g.roomId !== "string" || !g.roomId) return "a grant names its room";
  if (typeof g.owner !== "string" || !MEMBER_ID_RE.test(g.owner)) return "a grant names its owner";
  if (typeof g.sig !== "string" || !SIGNATURE_RE.test(g.sig)) return "a grant must be signed";
  for (const t of [g.issuedAt, g.expiresAt]) if (typeof t !== "number" || !Number.isFinite(t) || t < 0) return "a grant's times must be times";
  if (g.expiresAt <= g.issuedAt) return "a grant must expire after it's given";
  if (g.sessions !== null && (!Array.isArray(g.sessions) || !g.sessions.length || g.sessions.length > MAX_GRANT_SESSIONS || !g.sessions.every((s: unknown) => typeof s === "string" && SESSION_ID_RE.test(s)))) {
    return "a grant names its sessions";
  }
  if (g.kind === "handover") {
    if (!Array.isArray(g.sessions) || g.sessions.length !== 1) return "a hand-over names one session";
    if (typeof g.to !== "string" || !MEMBER_ID_RE.test(g.to)) return "a hand-over names who it's handed to";
    if (typeof g.sha !== "string" || !SHA_RE.test(g.sha)) return "a hand-over names the snapshot handed over";
    if (g.expiresAt - g.issuedAt > HANDOVER_GRANT_MS) return "a hand-over can't last that long";
  } else {
    if (g.to !== null || g.sha !== null) return "an away grant is for any teammate, from any backup";
    if (g.expiresAt - g.issuedAt > AWAY_GRANT_MAX_MS) return `an away grant lasts at most ${Math.round(AWAY_GRANT_MAX_MS / 86_400_000)} days`;
  }
  return null;
}

/** Whether the grant carries its owner's signature, by the key the room knows for them at this point in its order. */
export function grantSigned(state: Pick<RoomState, "members">, g: TakeoverGrant): boolean {
  const key = state.members.find((m) => m.id === g.owner)?.publicKey;
  if (!key) return false;
  const { sig, ...unsigned } = g;
  return verifySignature(key, grantInput(unsigned), sig);
}

/**
 * Why `grant` doesn't let `taker` take over the owner's session `sessionId`
 * at `at` (from snapshot `sha`, for a hand-over), or null when it does. The
 * same answer on every member: it reads only the room's state at this point
 * in its order. In words a person can read: the taker's dialog shows them.
 */
export function grantProblem(state: RoomState, grant: unknown, use: { owner: MemberId; ownerName: string; sessionId: string; taker: MemberId; at: number; sha?: string }): string | null {
  if (grant === undefined || grant === null) return `${use.ownerName} didn't hand it over`;
  const shape = grantShapeProblem(grant);
  if (shape) return shape;
  const g = grant as TakeoverGrant;
  if (g.roomId !== state.id) return "the grant is for another room";
  if (g.owner !== use.owner) return `the grant isn't ${use.ownerName}'s`;
  if (!grantSigned(state, g)) return `the grant isn't signed by ${use.ownerName}`;
  if (g.sessions !== null && !g.sessions.includes(use.sessionId)) return `${use.ownerName}'s grant doesn't cover this session`;
  if (use.at < g.issuedAt - GRANT_SKEW_MS) return "the grant was given after this";
  if (use.at > g.expiresAt) return `${use.ownerName}'s grant expired`;
  if (g.kind === "handover") {
    if (g.to !== use.taker) return `${use.ownerName} handed it over to someone else`;
    if (use.sha !== undefined && g.sha !== use.sha) return `${use.ownerName} handed over another snapshot`;
  } else {
    const current = state.ext.takeover?.away?.[g.owner];
    if (current?.id !== g.id) return `${use.ownerName} withdrew that grant`;
  }
  return null;
}
