import type { AgentKind } from "../types";
import type { MemberId, RoomId } from "./types";
import { ago } from "../format";

/**
 * Team rooms, take-over (docs/team-rooms.md): what the room records about each
 * room session's backup, and what the window is told. The main-process side is
 * src/main/team/takeover.ts.
 *
 * After every agent turn the owner's Mockingbird snapshots the session's
 * worktree as a commit on top of its branch's commit, pushes it to the hidden
 * ref `refs/mockingbird/rooms/<room>/<session>` on origin, copies it peer to
 * peer into connected teammates' clones under the same ref, and sends them the
 * conversation's new lines. A `session.backup` event records each snapshot and
 * how its push went; `session.takenOver` records that a teammate continued the
 * session on their own laptop; `session.backupDropped` that its current owner
 * deleted the backup (members then delete their copies). While a backup
 * exists, anyone who can read the repository can fetch that work in progress.
 */

/** What a teammate needs to continue a room session on their own laptop; sent with every backup. */
export interface RoomSessionDescriptor {
  title: string;
  agent: AgentKind;
  /** The session's branch; null when its HEAD was detached. */
  branch: string | null;
  /** origin's URL without credentials: how a teammate's clone of the same repository is found (never by path). */
  originUrl: string;
  /** The owner's worktree path: a transcript's working-directory fields are moved from it to the taker's. */
  cwd: string;
  /** The agent conversation the session runs (its transcript's id), when known. */
  conversationId: string | null;
}

export type PushOutcome = { ok: true; at: number } | { ok: false; at: number; error: string };

/** Where a take-over's snapshot came from: a teammate's laptop directly, or the backup ref on origin. */
export type SnapshotSource = "peer" | "origin";

/** How a taken-over session got its conversation: its transcript, a summary of what reached the taker, or nothing. */
export type ConversationCarried = "full" | "digest" | "none";

export interface TakenOver {
  by: MemberId;
  at: number;
  /** The taker's session: backups continue under its id. */
  newSessionId: string;
  snapshot: { sha: string; takenAt: number; source: SnapshotSource };
  conversation: ConversationCarried;
}

/** One room session's backup as the room knows it. */
export interface RoomSessionBackup {
  sessionId: string;
  /** Who runs it: the author of its first backup. Only the owner's backups count. */
  owner: MemberId;
  session: RoomSessionDescriptor;
  /** The newest snapshot (the worktree after the owner's last turn). */
  latest: { sha: string; takenAt: number };
  /** How pushing the newest snapshot to origin went. */
  push: PushOutcome & { sha: string };
  /** The newest snapshot origin holds; null until a push succeeded. */
  pushed: { sha: string; takenAt: number; at: number } | null;
  /** The transcript's size when the newest snapshot was taken: a complete copy has at least this much. */
  transcriptBytes: number | null;
  takenOver: TakenOver | null;
  /** Its backup was deleted from origin and members' clones; a later backup by its owner revives it. */
  dropped: { at: number; by: MemberId; reason: DropReason } | null;
}

/**
 * Why a session's backup was deleted: its owner forgot the session, its work
 * is all in the base branch, it saw no turn for STALE_BACKUP_MS, or the
 * teammate who took it over has backed up their own copy.
 */
export type DropReason = "closed" | "merged" | "stale" | "taken-over";
export const DROP_REASONS: DropReason[] = ["closed", "merged", "stale", "taken-over"];
/** A backup with no turn for this long is deleted by its owner's daily prune. */
export const STALE_BACKUP_MS = 14 * 86_400_000;

export interface TakeoverRoomState {
  sessions: Record<string, RoomSessionBackup>;
}

declare module "./types" {
  interface RoomEventBodies {
    "session.backup": {
      sessionId: string;
      /** The snapshot commit: the worktree as the turn left it, on top of the branch's commit. */
      sha: string;
      takenAt: number;
      push: PushOutcome;
      session: RoomSessionDescriptor;
      transcriptBytes: number | null;
    };
    "session.takenOver": {
      sessionId: string;
      /** The owner it was taken from. */
      from: MemberId;
      newSessionId: string;
      snapshot: { sha: string; takenAt: number; source: SnapshotSource };
      conversation: ConversationCarried;
      branch: string | null;
    };
    /** The session's current owner deleted its backup ref on origin: members delete their copies. */
    "session.backupDropped": { sessionId: string; reason: DropReason };
  }
  interface RoomExtensions {
    takeover: TakeoverRoomState;
  }
}

// ---- what the window sees -------------------------------------------------------------

export interface RoomSessionBackupView extends RoomSessionBackup {
  roomId: RoomId;
  ownerName: string;
  ownerOnline: boolean;
  /** This install runs it. */
  self: boolean;
  takenOverByName: string | null;
  /** The newest snapshot copied into this Mac's clone peer to peer. */
  peerCopy: { sha: string; takenAt: number } | null;
  /** The conversation copied to this Mac: bytes held, of the size last announced (null: unknown). */
  transcript: { have: number; of: number | null } | null;
  /** Something on this side went wrong (sending to teammates, or storing what they sent). */
  problem: string | null;
}

export interface TakeoverView {
  sessions: RoomSessionBackupView[];
  /** This install's room sessions that couldn't be backed up at all (no origin, not a repository…). */
  unbacked: { roomId: RoomId; sessionId: string; title: string; problem: string }[];
  /** Backups this install should have deleted and couldn't (retried on the next prune). */
  cleanup: { roomId: RoomId; sessionId: string; title: string; problem: string }[];
}

/** What the confirm dialog shows before a take-over. */
export interface TakeoverPlan {
  roomId: RoomId;
  sessionId: string;
  title: string;
  agent: AgentKind;
  branch: string | null;
  ownerName: string;
  ownerOnline: boolean;
  originUrl: string;
  /** This Mac's clone of the repository, or null when none was found (pick one). */
  clone: string | null;
  /** The snapshot the take-over would use: the newest available. */
  snapshot: { sha: string; takenAt: number; source: SnapshotSource; skipped: string[] } | null;
  /** The other copy, when there is one, for comparison. */
  other: { sha: string; takenAt: number; source: SnapshotSource } | null;
  /** Reading origin's backup failed (offline, no access): only the peer copy was considered. */
  originProblem: string | null;
  /** The newest snapshot announced is newer than any available here. */
  latestMissing: boolean;
  conversation: { kind: "full"; bytes: number } | { kind: "partial"; have: number; of: number } | { kind: "none" };
}

export interface TakeoverResult {
  sessionId: string;
  cwd: string;
  branch: string | null;
  /** The branch had to take another name (the session's was checked out or had moved on here). */
  renamedFrom: string | null;
  snapshot: { sha: string; takenAt: number; source: SnapshotSource };
  conversation: ConversationCarried;
}

// ---- refs -------------------------------------------------------------------------------

/** Room backups, on origin and in members' clones. Never fetched by default (origin's refspec is refs/heads/*). */
export const ROOM_REF_ROOT = "refs/mockingbird/rooms";
/** Where a taker's clone keeps what it read from origin's backup ref, apart from the peer copy. */
export const ORIGIN_COPY_ROOT = "refs/mockingbird/rooms-origin";
export const SESSION_ID_RE = /^[\w-]{1,64}$/;
const ROOM_RE = /^[A-Za-z0-9_-]{22}$/;

/** The hidden ref holding a room session's newest snapshot. */
export function roomBackupRef(roomId: RoomId, sessionId: string, root = ROOM_REF_ROOT): string {
  if (!ROOM_RE.test(roomId)) throw new Error(`not a room id: ${roomId}`);
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`not a session id: ${sessionId}`);
  return `${root}/${roomId}/${sessionId}`;
}

// ---- freshness ---------------------------------------------------------------------------

const DROPPED_BECAUSE: Record<DropReason, string> = {
  closed: "the session was closed",
  merged: "its work is in the base branch",
  stale: "no turns for 14 days",
  "taken-over": "the new copy is backed up",
};

export interface Freshness {
  tone: "ok" | "warn" | "muted";
  text: string;
}

/**
 * How fresh a room session's backup is, in a few words: "backed up 2m ago",
 * "backup failed: …", "latest only on Nick's laptop", or who took it over.
 */
export function backupFreshness(v: RoomSessionBackupView, now = Date.now()): Freshness {
  if (v.takenOver) return { tone: "muted", text: `taken over by ${v.takenOverByName ?? "a teammate"} ${ago(v.takenOver.at, now)}` };
  if (v.dropped) return { tone: "muted", text: `backup deleted ${ago(v.dropped.at, now)}: ${DROPPED_BECAUSE[v.dropped.reason]}` };
  const here = !!v.peerCopy && v.peerCopy.takenAt >= v.latest.takenAt;
  if (v.push.ok && v.push.sha === v.latest.sha && v.pushed) return { tone: "ok", text: `backed up ${ago(v.pushed.at, now)}` };
  const failed = v.push.ok ? "" : `backup failed: ${v.push.error}`;
  if (v.self) return { tone: "warn", text: failed || "not backed up yet" };
  // where the newest work is matters most to a teammate: it leads, ahead of a long push error
  const where = here ? `latest copied here ${ago(v.peerCopy!.takenAt, now)}` : `latest only on ${v.ownerName}'s laptop`;
  return { tone: here ? "ok" : "warn", text: [where, failed].filter(Boolean).join(" · ") };
}
