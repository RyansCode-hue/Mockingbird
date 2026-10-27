import type { AgentKind } from "../types";
import type { MemberId, RoomId } from "./types";
import { ago } from "../format";

/**
 * Team rooms, take-over (docs/team-rooms.md): what the room records about each
 * room session's backup, and what the window is told. The main-process side is
 * src/main/team/takeover.ts.
 *
 * Origin only ever gets a member's snapshots when the room's admin made it
 * available and that member allowed it for their own sessions.
 *
 * After every agent turn the owner's Mockingbird snapshots the session's
 * worktree as a commit on top of its branch's commit, keeps it under the
 * hidden ref `refs/mockingbird/rooms/<room>/<session>`, copies it peer to peer
 * into connected teammates' clones under the same ref, and sends them the
 * conversation's new lines. Only when the room's admin turned on backups to
 * origin (`room.settings`; off by default) is the ref pushed to origin too,
 * where anyone who can read the repository can fetch that work in progress.
 * A `session.backup` event records each snapshot and, for a room backing up
 * to origin, how its push went; `session.takenOver` records that a teammate
 * continued the session on their own laptop; `session.backupDropped` that its
 * current owner deleted the backup (members then delete their copies).
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
  /** The session's ticket, for the taker's brief. Absent from backups by Mockingbirds before it. */
  ticketId?: string | null;
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
  /**
   * What let it count: the owner's hand-over; "offline" — taken while the
   * owner was offline, which needs no grant (the owner's Mac may still refuse
   * it, session.takeoverRefused); an away grant (1.5, no longer given); or
   * "accepted" — a take-over from before grants that the owner's Mockingbird
   * had already honoured, accepted once it updated. Absent on an ungranted
   * one (RoomSessionBackup.ungranted).
   */
  grant?: TakeoverGrant["kind"] | "offline" | "accepted";
}

/**
 * A session owner's signed consent to a take-over (src/main/team/takeoverGrants.ts):
 *   - "handover": answering a teammate's request, for one session, that
 *     teammate (`to`) and the snapshot handed over (`sha`), for HANDOVER_GRANT_MS;
 *   - "away": 1.5 only, no longer given (take-overs while the owner is offline
 *     need no grant from 1.6): ahead of time, for the owner's sessions in the
 *     room (`sessions`, or null for all of them), any teammate, until
 *     `expiresAt` (at most AWAY_GRANT_MAX_MS). Published as
 *     `session.awayGrant`; logs keep them, and take-overs they granted still count.
 * `sig` is the owner's key over the rest (grantInput).
 */
export interface TakeoverGrant {
  v: 1;
  id: string;
  kind: "handover" | "away";
  roomId: RoomId;
  owner: MemberId;
  sessions: string[] | null;
  to: MemberId | null;
  sha: string | null;
  issuedAt: number;
  expiresAt: number;
  sig: string;
}
/** How long a hand-over stays good for the taker to start the session and tell the room. */
export const HANDOVER_GRANT_MS = 30 * 60_000;
/** The longest an away grant can last. */
export const AWAY_GRANT_MAX_MS = 7 * 86_400_000;
/** How far ahead of a take-over a grant's issue time may be (clocks differ between laptops). */
export const GRANT_SKEW_MS = 5 * 60_000;
/**
 * The leeway an offline take-over's time gets against the owner's record of
 * when it was connected to the taker: clocks differ between laptops, and each
 * side notices a dropped or new connection a little after the other. A
 * take-over stamped within this of a connection starting or ending counts as
 * taken while apart.
 */
export const OFFLINE_TAKEOVER_SKEW_MS = 2 * 60_000;

/** One room session's backup as the room knows it. */
export interface RoomSessionBackup {
  sessionId: string;
  /** Who runs it: the author of its first backup. Only the owner's backups count. */
  owner: MemberId;
  session: RoomSessionDescriptor;
  /** The newest snapshot (the worktree after the owner's last turn). */
  latest: { sha: string; takenAt: number };
  /**
   * Whether the newest snapshot went to origin as well as peer to peer: the
   * room's setting when it was taken. Backups from before the setting existed
   * were always pushed.
   */
  toOrigin: boolean;
  /** How pushing the newest snapshot to origin went (meaningless while `toOrigin` is false). */
  push: PushOutcome & { sha: string };
  /** The newest snapshot origin holds; null until a push succeeded, and once the room keeps backups off origin. */
  pushed: { sha: string; takenAt: number; at: number } | null;
  /** The transcript's size when the newest snapshot was taken: a complete copy has at least this much. */
  transcriptBytes: number | null;
  /** Its owner's Mockingbird signs take-over grants (its latest backup said so): one that doesn't needs an update before the session can be taken over. */
  grants?: true;
  /** Its owner's Mockingbird takes take-overs while it's offline, and refuses one taken while it was connected to the taker (1.6; its latest backup said so). */
  offline?: true;
  takenOver: TakenOver | null;
  /**
   * A take-over that carried no valid grant from the owner (an older
   * Mockingbird's, or a forged one): it changes nothing — the owner's session
   * runs on — but is kept so the owner's Mockingbird can tell the taker, and
   * accept one it had already honoured before it updated.
   */
  ungranted?: TakenOver | null;
  /** The ungranted taker dropped the old backup; it counts if the take-over is accepted. */
  ungrantedDrop?: { at: number; by: MemberId; reason: DroppedBecause } | null;
  /** Its backup was deleted from origin and members' clones (or its owner left the room); a later backup by its owner revives it. */
  dropped: { at: number; by: MemberId; reason: DroppedBecause } | null;
  /** Offline take-overs its owner's Mac refused (session.takeoverRefused), newest last, at most MAX_REFUSALS: the takers' copies don't run. */
  refusals?: OfflineRefusal[];
}

/** An offline take-over the session's owner refused: their Mac was connected to the taker when it was stamped. */
export interface OfflineRefusal {
  by: MemberId;
  newSessionId: string;
  /** The take-over's time (the taker's clock), and the refusal's (the owner's). */
  takenAt: number;
  at: number;
  reason: OfflineRefusalReason;
}
/** connected: the owner's Mac was connected to the taker then; before-snapshot: stamped before the snapshot it continues from was taken. */
export type OfflineRefusalReason = "connected" | "before-snapshot";
export const OFFLINE_REFUSAL_REASONS: OfflineRefusalReason[] = ["connected", "before-snapshot"];
export const MAX_REFUSALS = 20;

/** Why a backup counts as deleted: a DropReason its owner published, or "left-room" (its owner left or was removed: they delete it). */
export type DroppedBecause = DropReason | "left-room";

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
  /** Each member's latest away grant (session.awayGrant, 1.5): kept so the take-overs they granted still count. */
  away?: Record<MemberId, TakeoverGrant>;
}

/**
 * A room's settings, as its admin last set them (room.settings: anyone
 * else's change nothing). A room without any has every setting off.
 */
export interface RoomSettings {
  /**
   * Snapshots also go to a hidden ref on origin after each turn, so a teammate
   * can take a session over while its owner's laptop is off — and anyone with
   * read access to the repository can fetch them. Off: peer to peer only.
   */
  backupsToOrigin: boolean;
  /**
   * Agents' new migration files are held back unless their number is
   * reserved (docs/team-rooms.md, "Teammates' changes and migration
   * numbers"). Absent: on.
   */
  migrationCheck?: boolean;
  /** Per repository (origin key): the folders that hold numbered migrations, where detection got it wrong. Absent: detected. */
  migrationFolders?: Record<string, string[]>;
  /** Who last changed them, and when (their clock: display only). */
  by: MemberId;
  at: number;
}

/** Whether a room's backups go to origin as well as peer to peer: only once its admin turned that on. */
export const backupsToOrigin = (room: { ext: { settings?: RoomSettings } } | null | undefined): boolean => room?.ext.settings?.backupsToOrigin === true;

/**
 * What a backup kept off origin carries as its push outcome. Mockingbirds
 * from before the setting require one: they show this as why it isn't there.
 */
export const NOT_PUSHED = "not on origin: this room keeps backups peer to peer";
/** What a backup kept off origin carries when the room makes origin available but its owner hasn't allowed it for their own sessions. */
export const NOT_ALLOWED = "not on origin: its owner keeps their backups peer to peer";

declare module "./types" {
  interface RoomEventBodies {
    "session.backup": {
      sessionId: string;
      /** The snapshot commit: the worktree as the turn left it, on top of the branch's commit. */
      sha: string;
      takenAt: number;
      /** How the push to origin went; with `toOrigin: false`, `{ ok: false, error: NOT_PUSHED }`. */
      push: PushOutcome;
      /** false: the room keeps backups peer to peer, so this one wasn't pushed. Absent from backups made before the setting existed (always pushed). */
      toOrigin?: boolean;
      session: RoomSessionDescriptor;
      transcriptBytes: number | null;
      /** 1: the owner's Mockingbird signs take-over grants. Absent from older ones. */
      grants?: 1;
      /** 1: the owner's Mockingbird takes take-overs while it's offline (1.6). Absent from older ones. */
      offline?: 1;
    };
    "session.takenOver": {
      sessionId: string;
      /** The owner it was taken from. */
      from: MemberId;
      newSessionId: string;
      snapshot: { sha: string; takenAt: number; source: SnapshotSource };
      conversation: ConversationCarried;
      branch: string | null;
      /** The owner's consent: their hand-over. Without a valid one (and not `offline`) the take-over changes nothing (an older Mockingbird sends none). */
      grant?: TakeoverGrant;
      /** 1: taken while the owner was offline, with no grant (1.6). Counts when the owner's Mockingbird takes those; its Mac may refuse it after. */
      offline?: 1;
    };
    /** 1.5: a member allowed take-overs of their sessions while they're away (or, with null, withdrew that). No longer published; kept in logs. */
    "session.awayGrant": { grant: TakeoverGrant | null };
    /** The session's owner refuses an offline take-over: their Mac was connected to the taker when it was stamped. Every member's state puts the session back. */
    "session.takeoverRefused": { sessionId: string; by: MemberId; newSessionId: string; reason: OfflineRefusalReason };
    /** A session's owner accepts a take-over that carried no grant: one its Mockingbird honoured before it signed grants. */
    "session.takeoverAccepted": { sessionId: string; by: MemberId; newSessionId: string };
    /** The session's current owner deleted its backup ref on origin: members delete their copies. */
    "session.backupDropped": { sessionId: string; reason: DropReason };
    /** The room's admin changed its settings: each one named is set, the rest stay. */
    "room.settings": { backupsToOrigin?: boolean; migrationCheck?: boolean; migrationFolders?: Record<string, string[]> };
  }
  interface RoomExtensions {
    takeover: TakeoverRoomState;
    settings: RoomSettings;
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
  /** A teammate's session whose owner is offline and whose Mockingbird takes take-overs then: Take over leads. */
  offlineTakeover: boolean;
  /** This install's session: the teammates whose clones hold its newest snapshot, by name, as heard since Mockingbird started. */
  heldBy: string[];
  /** The conversation copied to this Mac: bytes held, of the size last announced (null: unknown). */
  transcript: { have: number; of: number | null } | null;
  /** Something on this side went wrong (sending to teammates, or storing what they sent). */
  problem: string | null;
}

/** A room's backup setting as Settings → Team shows it. */
export interface RoomBackupSetting {
  roomId: RoomId;
  /** The room's admin made backups to origin available (RoomSettings.backupsToOrigin); each member's own still need their consent. */
  toOrigin: boolean;
  /**
   * This member's answer to backing up their own sessions in the room to
   * origin: true (allowed), false (Not now) or null (not asked yet: the
   * window asks once the room makes it available). Kept on this Mac only.
   */
  consent: boolean | null;
  /** Who last changed it (`self`: this install), and when; null while nobody has (off). */
  changed: { byName: string; self: boolean; at: number } | null;
  /** The room's owner, by name: the only one who can change it (backups to origin are an owner-only setting). */
  adminName: string | null;
  /** This install is the room's owner. */
  canChange: boolean;
  /** Where backups would go, for the switch's label: "GitHub", "Azure DevOps", a host name, or "origin" when the room's repositories differ or none is known. */
  remote: string;
}

export interface TakeoverView {
  sessions: RoomSessionBackupView[];
  /** Each room's backup setting. */
  rooms: RoomBackupSetting[];
  /** This install's room sessions that couldn't be backed up at all (no origin, not a repository…). */
  unbacked: { roomId: RoomId; sessionId: string; title: string; problem: string }[];
  /** Backups — or conversations saved in worktrees at take-overs (`what` says so) — this install should have deleted and couldn't (retried on the next prune). */
  cleanup: { roomId: RoomId; sessionId: string; title: string; problem: string; what?: string }[];
  /** Teammates asking to continue this install's sessions on their laptops, waiting for an answer here. */
  asks: IncomingAsk[];
  /** This install asked a session's owner to hand it over, and is waiting. */
  asking: OutgoingAsk[];
  /** This install's copies of sessions a teammate continued: stopped here, with what's left in them. */
  left: LeftCopy[];
  /** Changes a teammate sent from their copy after this install continued a session of theirs. */
  received: ReceivedChanges[];
  /** Take-overs of this install's sessions that carried no grant from it: refused, the session running on here. */
  refused: RefusedTakeover[];
}

/** A teammate's take-over of one of this install's sessions without its signed consent: it changed nothing here. */
export interface RefusedTakeover {
  roomId: RoomId;
  sessionId: string;
  title: string;
  byName: string;
  at: number;
  /** Why it didn't count, in words for both sides ("Nick's Mockingbird needs an update to take over"). */
  why: string;
}

// ---- asking the owner first --------------------------------------------------------------

/**
 * How long a session's owner has to answer a teammate's request to continue
 * it before it's kept (docs/team-rooms.md, "Take-over").
 */
export const ASK_MS = 120_000;
/** How long a hand-over waits for the owner's turn in progress to finish before giving up (the session is then kept). */
export const HANDOVER_TURN_MS = 30 * 60_000;

/** A teammate wants to continue one of this install's sessions (owner side). */
export interface IncomingAsk {
  askId: string;
  roomId: RoomId;
  sessionId: string;
  title: string;
  from: MemberId;
  fromName: string;
  at: number;
  /** Unanswered by then, the session is kept. */
  deadline: number;
  /** waiting: for this install's answer; handing-over: the turn finishing, the backup going to the teammate, the agent stopping. */
  state: "waiting" | "handing-over";
}

/** This install asked a session's owner to hand it over (taker side). */
export interface OutgoingAsk {
  roomId: RoomId;
  sessionId: string;
  ownerName: string;
  at: number;
  deadline: number;
  state: "asking" | "handing-over";
}

/** What the owner answered a request to continue their session; a hand-over carries the owner's signed grant. */
export type AskAnswer = { answer: "handed-over"; sha: string; takenAt: number; grant: TakeoverGrant } | { answer: "kept" } | { answer: "timeout" };

// ---- what's left of a taken-over copy --------------------------------------------------------

/**
 * This install's copy of a session a teammate continued (owner side): its
 * agent stopped here, its worktree untouched. `now` is where the room's
 * session runs today, at the end of its take-overs.
 */
export interface LeftCopy {
  roomId: RoomId;
  sessionId: string;
  title: string;
  by: MemberId;
  byName: string;
  at: number;
  now: { owner: MemberId; ownerName: string; sessionId: string; self: boolean; online: boolean };
  /** The copy that continues it has a backup, so it can be taken back (the same take-over, in reverse). */
  takeBack: boolean;
  /**
   * Files this copy has that the teammate doesn't: changed since the snapshot
   * they took over from (or since what was last sent them). Null while it's
   * being checked.
   */
  unsent: { files: string[]; checkedAt: number } | { error: string } | null;
  /** The last time this copy's changes were sent to the teammate. */
  sent: { at: number; files: number } | null;
  sending: boolean;
}

/** Changes a teammate sent from their copy of a session this install continues (taker side): a patch to review and apply. */
export interface ReceivedChanges {
  id: string;
  roomId: RoomId;
  /** This install's session the changes are for: the one that continues the teammate's. */
  sessionId: string;
  /** The teammate's session they come from. */
  fromSessionId: string;
  from: MemberId;
  fromName: string;
  title: string;
  files: ChangedFile[];
  bytes: number;
  at: number;
  /** When they were applied to this session's worktree; null until then. */
  applied: number | null;
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted";
}

/**
 * Where a room session runs now: the end of its take-overs, followed from
 * `sessionId` (its backup's newSessionId at each step). `backedUp` once that
 * copy has a backup of its own (so it can be taken over in turn).
 */
export function continuation(state: TakeoverRoomState | undefined, sessionId: string): { owner: MemberId; sessionId: string; backedUp: boolean } | null {
  let at = state?.sessions[sessionId];
  if (!at?.takenOver) return null;
  for (let hop = 0; hop < 100; hop++) {
    const t: TakenOver = at!.takenOver!;
    const next: RoomSessionBackup | undefined = state!.sessions[t.newSessionId];
    if (!next || next.owner !== t.by) return { owner: t.by, sessionId: t.newSessionId, backedUp: false };
    if (!next.takenOver) return { owner: next.owner, sessionId: next.sessionId, backedUp: !next.dropped };
    at = next;
  }
  throw new Error(`session ${sessionId}'s take-overs go round in a circle`);
}

/** The words for a left copy's state, for its row and pane. */
export function leftCopyText(l: Pick<LeftCopy, "now" | "byName">): string {
  return l.now.self ? "Taken back: it continues in another session here" : `Continued on ${l.now.ownerName}'s laptop`;
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
  /** The room backs up to origin, so origin's backup was considered too; false: only what reached this Mac peer to peer. */
  toOrigin: boolean;
  /** Reading origin's backup failed (offline, no access): only the peer copy was considered. */
  originProblem: string | null;
  /** The newest snapshot announced is newer than any available here. */
  latestMissing: boolean;
  /** How much of the owner's conversation reached this Mac: the brief is built from it, and it's saved in the worktree. */
  conversation: { kind: "full"; bytes: number } | { kind: "partial"; have: number; of: number } | { kind: "none" };
  /** It was this Mac's own session (taken back): this Mac's own conversation resumes, the brief telling it what the teammate did. Otherwise a new conversation starts from the brief. */
  resumesOwn: boolean;
  /**
   * How this take-over goes: the owner is asked now (they're online), it goes
   * ahead without asking (they're offline: their Mac refuses it only if it
   * was connected to this one then), or it can't — and why.
   */
  grant: { kind: "ask" } | { kind: "offline" } | { kind: "none"; why: string };
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

/** Room backups, in members' clones (and on origin when the room backs up there). Never fetched by default (origin's refspec is refs/heads/*). */
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

/**
 * A room session's backup in the take-over view. A session is known by its
 * owner's id for it, in its room (a teammate's session's id in this window is
 * remotePaneId(owner, id): match on the tag's sessionId and owner, never the
 * window's id).
 */
export function backupOf(view: TakeoverView | null | undefined, tag: { roomId: RoomId; sessionId: string; owner: MemberId } | null | undefined): RoomSessionBackupView | null {
  if (!view || !tag) return null;
  return view.sessions.find((v) => v.roomId === tag.roomId && v.sessionId === tag.sessionId && v.owner === tag.owner) ?? null;
}

// ---- freshness ---------------------------------------------------------------------------

const DROPPED_BECAUSE: Record<DroppedBecause, string> = {
  closed: "the session was closed",
  merged: "its work is in the base branch",
  stale: "no turns for 14 days",
  "taken-over": "the new copy is backed up",
  "left-room": "its owner left the room",
};

export interface Freshness {
  tone: "ok" | "warn" | "muted";
  text: string;
}

/**
 * How fresh a room session's backup is, in a few words: "backed up 2m ago",
 * "backup failed: …", "latest only on Nick's laptop", or who took it over.
 * A backup kept off origin says where its copies are: "copied to Nick 2m ago",
 * "copied here 2m ago · newer on Ryan's laptop".
 */
export function backupFreshness(v: RoomSessionBackupView, now = Date.now()): Freshness {
  if (v.takenOver) {
    const who = v.takenOverByName ?? "a teammate";
    return { tone: "muted", text: v.self ? `continued on ${who}'s laptop ${ago(v.takenOver.at, now)}` : `taken over by ${who} ${ago(v.takenOver.at, now)}` };
  }
  if (v.dropped) return { tone: "muted", text: `backup deleted ${ago(v.dropped.at, now)}: ${DROPPED_BECAUSE[v.dropped.reason]}` };
  const here = !!v.peerCopy && v.peerCopy.takenAt >= v.latest.takenAt;
  if (!v.toOrigin) {
    if (v.self) {
      return v.heldBy.length
        ? { tone: "ok", text: `copied to ${v.heldBy.join(", ")} ${ago(v.latest.takenAt, now)}` }
        : { tone: "muted", text: `snapshot ${ago(v.latest.takenAt, now)} · no teammate has a copy yet` };
    }
    if (here) return { tone: "ok", text: `copied here ${ago(v.peerCopy!.takenAt, now)}` };
    if (v.peerCopy) return { tone: "warn", text: `copied here ${ago(v.peerCopy.takenAt, now)} · newer on ${v.ownerName}'s laptop` };
    return { tone: "warn", text: `no copy here · only on ${v.ownerName}'s laptop` };
  }
  if (v.push.ok && v.push.sha === v.latest.sha && v.pushed) return { tone: "ok", text: `backed up ${ago(v.pushed.at, now)}` };
  const failed = v.push.ok ? "" : `backup failed: ${v.push.error}`;
  if (v.self) return { tone: "warn", text: failed || "not backed up yet" };
  // where the newest work is matters most to a teammate: it leads, ahead of a long push error
  const where = here ? `latest copied here ${ago(v.peerCopy!.takenAt, now)}` : `latest only on ${v.ownerName}'s laptop`;
  return { tone: here ? "ok" : "warn", text: [where, failed].filter(Boolean).join(" · ") };
}

/**
 * What the switch for backups to origin calls the remote, from the origin URLs
 * a room's repositories have: "GitHub", "Azure DevOps", "GitLab", "Bitbucket",
 * another host's name, or "origin" when they differ or none is known.
 */
export function remoteLabel(urls: string[]): string {
  const labels = new Set(urls.map(hostLabel).filter((l): l is string => !!l));
  return labels.size === 1 ? [...labels][0] : "origin";
}

function hostLabel(url: string): string | null {
  const u = url.trim();
  if (u.startsWith("/") || u.startsWith("~") || /^file:/i.test(u)) return null; // a repository on disk has no host
  const host = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)[:/]/i.exec(u)?.[1]?.toLowerCase();
  if (!host) return null;
  if (host === "github.com" || host === "www.github.com") return "GitHub";
  if (/(^|\.)dev\.azure\.com$|\.visualstudio\.com$/.test(host)) return "Azure DevOps";
  if (host === "gitlab.com") return "GitLab";
  if (host === "bitbucket.org") return "Bitbucket";
  return host;
}
