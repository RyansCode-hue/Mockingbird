/**
 * Team rooms: the room state every member keeps a copy of, and what the
 * window is told about it. See docs/team-rooms.md.
 *
 * Later stages extend two interfaces by declaration merging:
 *
 *   declare module "../shared/team/types" {
 *     interface RoomEventBodies { "chat.message": { text: string } }
 *     interface RoomExtensions { chat: ChatState }
 *   }
 *
 * and register the event's reducer with defineEventType (src/main/team/rooms.ts).
 */

/** A member's id: the fingerprint of its public key (32 hex characters). */
export type MemberId = string;
export type RoomId = string;

export interface RoomMember {
  id: MemberId;
  name: string;
  /** Ed25519 public key, raw 32 bytes, base64url. */
  publicKey: string;
  joinedAt: number;
  /** Who admitted this member; null for the room's creator. */
  invitedBy: MemberId | null;
}

/** Someone who was a member: left, or was removed by the room's admin. Kept so their history still has a name. */
export interface FormerMember extends RoomMember {
  /** When they left or were removed (the event's time). */
  leftAt: number;
  /** Who removed them; null when they left. */
  removedBy: MemberId | null;
}

/**
 * Each event type's body. Stage 1 defines the room and its members; other
 * stages add theirs (see the note at the top of this file).
 */
export interface RoomEventBodies {
  "room.created": { name: string; groupKey: string; publicKey: string; creatorName: string; salt: string };
  "member.added": { id: MemberId; name: string; publicKey: string };
  "member.renamed": { name: string };
  /** A member leaves (`member` is the author), or the room's admin removes them. */
  "member.removed": { member: MemberId; reason?: "left" | "removed" };
}
export type RoomEventType = keyof RoomEventBodies;

/** A room's durable, signed, append-only record. Ordered by (lamport, author, id). */
export interface RoomEvent<K extends string = string> {
  /** Content hash of what the signature covers (base64url, 22 characters): equal ids are the same event. */
  id: string;
  roomId: RoomId;
  type: K;
  body: K extends RoomEventType ? RoomEventBodies[K] : unknown;
  author: MemberId;
  lamport: number;
  /** Author's wall clock, ms: for display only, never for order. */
  at: number;
  /** Ed25519 signature by the author, base64url. */
  sig: string;
}

/** What later stages keep in a room (sessions, chat, board…), each under its own key. */
export interface RoomExtensions {}

export interface RoomState {
  id: RoomId;
  name: string;
  /** The top-level group the room was shared from, as named on the creator's machine. */
  groupKey: string;
  creator: MemberId;
  createdAt: number;
  /** In the order they joined; the creator first. Who may act in the room. */
  members: RoomMember[];
  /** Who left or was removed, newest last (absent in states reduced before removal existed). */
  former?: FormerMember[];
  /** Filled by other stages' reducers. */
  ext: Partial<RoomExtensions>;
  /** Highest Lamport time applied. */
  lamport: number;
  /** Events applied. */
  events: number;
}

/** How this Mockingbird reaches a teammate right now. */
export type PeerLinkState =
  | "offline" // not on the signaling server, or no connection attempted yet
  | "connecting"
  | "direct" // peer to peer without a relay
  | "turn" // through Cloudflare's TURN relay (still end-to-end encrypted)
  | "needs-update" // on another TEAM_PROTOCOL
  | "error"; // connection refused (bad signature, fingerprint mismatch…): see detail

export interface PeerStatus {
  id: MemberId;
  name: string;
  state: PeerLinkState;
  /** Why it's in that state, when there's more to say ("Nick's Mockingbird needs an update"). */
  detail?: string;
  /** Since when, ms. */
  since: number;
}

/** A room as Settings → Team and the sidebar show it. */
export interface TeamRoomSummary {
  id: RoomId;
  name: string;
  /** The local top-level group the room is shown as. */
  groupKey: string;
  members: { id: MemberId; name: string; self: boolean }[];
  /** Who can remove members: the creator while a member, else the longest-standing member (see roomAdmin). */
  admin?: MemberId | null;
  creator?: MemberId;
  /** People who left or were removed, by name: their messages still say who wrote them. */
  former?: { id: MemberId; name: string }[];
  /** Teammates connected to this room right now (not this install). */
  online: MemberId[];
  signalingUrl: string;
  /** The signaling server answered for this room ("online"), is being reached, or failed (problem). */
  signaling: "online" | "connecting" | "offline";
  problem?: string;
  /** The signaling Worker can cut a removed member off: false when it's older and needs redeploying, absent until it has answered. */
  workerRevoke?: boolean;
}

/** A room code pasted here and not yet completed. */
export interface PendingJoinSummary {
  roomId: RoomId;
  name: string;
  inviter: MemberId;
  /** waiting: for the inviter to come online and accept · syncing: accepted, copying the room · rejected: see reason */
  state: "waiting" | "syncing" | "rejected";
  reason?: string;
  since: number;
}

/** This install left a room, or was removed from one: shown until dismissed. */
export interface TeamNotice {
  id: string;
  roomId: RoomId;
  roomName: string;
  kind: "left" | "removed";
  /** Who removed this install (kind "removed"). */
  by?: string;
  at: number;
  /** What couldn't be cleaned up on this Mac, one sentence each; empty when everything went. */
  problems: string[];
  /** Why the signaling Worker didn't cut this install's key off, when it didn't. */
  worker?: string;
}

/** What leaving a room did, for the dialog that started it. */
export interface LeaveOutcome {
  roomName: string;
  /** Teammates whose Mockingbird confirmed it heard, by name. */
  told: string[];
  /** Teammates who weren't connected or didn't confirm: they hear it from a teammate, or from the Worker, when next online. */
  notTold: string[];
  /** Why the signaling Worker didn't cut this install off, when it didn't. */
  worker: string | null;
  /** What couldn't be cleaned up on this Mac. */
  problems: string[];
}

/** What removing a member did, for the dialog that started it. */
export interface RemoveOutcome {
  name: string;
  /** Their Mockingbird confirmed it heard (it deletes the room there). */
  delivered: boolean;
  /** Why the signaling Worker didn't cut them off, when it didn't. */
  worker: string | null;
}

export interface TeamStatus {
  /** This install's identity; null when it couldn't be read (see error). */
  self: { id: MemberId; name: string; fingerprint: string } | null;
  signalingUrl: string;
  rooms: TeamRoomSummary[];
  pending: PendingJoinSummary[];
  peers: PeerStatus[];
  /** Problems worth showing (an unreadable room log, TURN unavailable…). */
  problems: string[];
  /** Rooms this install left or was removed from, until dismissed. */
  notices?: TeamNotice[];
  error?: string;
}
