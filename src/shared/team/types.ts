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
  /** Whose invite code this member used (the author of their member.added before joins needed accepting); null for the room's creator. */
  invitedBy: MemberId | null;
  /** The admin who accepted them, in a room whose joins need accepting. */
  acceptedBy?: MemberId;
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
  /** `approval`: joins need the admin's acceptance from the start (rooms created before it say so with room.approval). */
  "room.created": { name: string; groupKey: string; publicKey: string; creatorName: string; salt: string; approval?: true };
  /** The admin accepting a join (`inviter`: whose code it was); before joins needed accepting, the inviter's own add. */
  "member.added": { id: MemberId; name: string; publicKey: string; inviter?: MemberId };
  /** From here in the room's order, only the admin's member.added counts (see mayAddMember). */
  "room.approval": Record<string, never>;
  /** The admin declined a join request: the inviter tells the joiner. Changes no state. */
  "join.declined": { id: MemberId; invite: string; inviter: MemberId };
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
  /** Joins need the admin's acceptance from here in the room's order: only the admin's member.added counts (absent: any member's, as before). */
  joinApproval?: true;
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
  /** The signaling Worker holds joiners at the door until the admin accepts: false when it's older and needs redeploying, absent until it has answered. */
  workerApprove?: boolean;
  /** Join requests this install answers (as the room's admin) or passed on (as the inviter), newest last. */
  requests?: JoinRequestSummary[];
  /** What this Mac refused or noticed in the room (a teammate over a limit, this install's key connected elsewhere), newest last. */
  warnings?: RoomWarning[];
}

/** Something about a room this Mac refused or noticed: shown under the room once (repeats count up) until Mockingbird restarts. */
export interface RoomWarning {
  /** What it's about, one warning each: "rate:<member>", "replaced"… */
  key: string;
  text: string;
  /** When it first and last happened, and how often. */
  since: number;
  at: number;
  count: number;
}

/** Someone asking to join a room, as the admin (who accepts or declines) and the inviter (who passed it on) see it. */
export interface JoinRequestSummary {
  roomId: RoomId;
  /** The joiner's member id: the fingerprint of their key. */
  id: MemberId;
  name: string;
  /** Their fingerprint as Settings → Team shows it ("a1b2 c3d4 …"), to compare out of band. */
  fingerprint: string;
  inviter: MemberId;
  inviterName: string;
  /** The room's admin, who answers. */
  admin: MemberId | null;
  adminName: string;
  /** admin: this install answers it · inviter: this install passed it on to the admin. */
  role: "admin" | "inviter";
  /**
   * waiting: the admin hasn't answered (for the inviter: the admin has it) · forwarding: the admin
   * hasn't been reached yet (offline, or needs an update: see problem) · accepted / declined
   */
  state: "waiting" | "forwarding" | "accepted" | "declined";
  problem?: string;
  at: number;
  expiresAt: number;
}

/** A room code pasted here and not yet completed. */
export interface PendingJoinSummary {
  roomId: RoomId;
  name: string;
  inviter: MemberId;
  /**
   * waiting: for the inviter to come online · approval: the inviter passed it on, waiting for the
   * room's admin to accept · syncing: accepted, copying the room · declined: the admin said no ·
   * rejected: see reason
   */
  state: "waiting" | "approval" | "syncing" | "declined" | "rejected";
  /** The room's admin, by name, once the inviter said who answers. */
  admin?: string;
  reason?: string;
  since: number;
}

/** What answering a join request did, for the prompt that answered it. */
export interface JoinAnswerOutcome {
  name: string;
  accepted: boolean;
  /** Why the signaling Worker didn't drop a declined joiner at the door, when it didn't. */
  worker: string | null;
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
