import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { defineEventType, isRoomAdmin, onMemberRemoved, roomOwner } from "./rooms";
import { grantProblem, grantShapeProblem, grantSigned, signGrant } from "./takeoverGrants";
import { CONNECTED_BEAT_MS, ConnectionLog, connectedThen, type Span } from "./connectionLog";
import { checkRepoKey } from "./migrations";
import { checkFolder } from "../../shared/team/migrations";
import type { RoomSessionSource } from "./roomSessions";
import { PeerError, TeamError, type RequestContext, type Team, type Unsubscribe } from "./transport";
import { transcriptRefusal } from "./roomLimits";
import { branchesOf, currentBranch, git, gitBytes, hasCredentials, isAncestor, originUrl, pickDefaultBase, publicUrl, repoIdentity, repoTop, withoutCredentials } from "../git";
import { checkoutSnapshotFiles, skippedIn, snapshotCommit, takeSnapshot, worktreeCommitOn, worktreeTree } from "../snapshots";
import { parseNameStatus } from "../files";
import { secretPathspecs } from "../secrets";
import { worktreeAt } from "../worktrees";
import { CLAUDE_PROJECTS, CODEX_SESSIONS, ROLLOUT_NAME_RE, claudeProjectDir, claudeTranscriptOf, codexRolloutOf, realpathOr } from "../agentFiles";
import { rebaseTranscript } from "../transcripts";
import { transcriptLines } from "../handoff";
import { takeoverBrief } from "./takeoverBrief";
import { TAKEOVER_TRANSCRIPT_DIR } from "../../shared/team/claims";
import { excludePlanDir } from "./claims";
import { baseRef } from "../files";
import { isMissing, readJsonOrSetAside, removeDirInside, writeFileAtomic, writeGeneratedInside } from "../fileOps";
import { MEMBER_ID_RE } from "../../shared/team/protocol";
import {
  ASK_MS,
  backupsToOrigin,
  MAX_REFUSALS,
  OFFLINE_REFUSAL_REASONS,
  OFFLINE_TAKEOVER_SKEW_MS,
  ownerChecks,
  type OfflineRefusalReason,
  HANDOVER_GRANT_MS,
  type RefusedTakeover,
  type TakeoverGrant,
  continuation,
  NOT_ALLOWED,
  DROP_REASONS,
  HANDOVER_TURN_MS,
  NOT_PUSHED,
  ORIGIN_COPY_ROOT,
  remoteLabel,
  ROOM_REF_ROOT,
  roomBackupRef,
  SESSION_ID_RE,
  STALE_BACKUP_MS,
  type AskAnswer,
  type RoomBackupSetting,
  type ChangedFile,
  type ConversationCarried,
  type DropReason,
  type IncomingAsk,
  type LeftCopy,
  type OutgoingAsk,
  type PushOutcome,
  type ReceivedChanges,
  type RoomSessionBackup,
  type RoomSessionBackupView,
  type RoomSessionDescriptor,
  type SnapshotSource,
  type TakeoverPlan,
  type TakeoverResult,
  type TakeoverView,
} from "../../shared/team/takeover";
import type { AgentKind, NewSessionRequest, SessionInfo } from "../../shared/types";
import type { MemberId, RoomEvent, RoomId, RoomState } from "../../shared/team/types";

/**
 * Take-over (docs/team-rooms.md): a room session continues on a teammate's
 * laptop, under their account, when its owner is away.
 *
 * Owner side, after every agent turn in a room session:
 *   - the worktree is snapshotted as a commit on top of HEAD (the Undo-turn
 *     mechanism: a temporary index; branch, index and history untouched;
 *     ignored, big and secret files left out), kept under
 *     refs/mockingbird/rooms/<room>/<session>; a `session.backup` room event
 *     records it;
 *   - each connected teammate gets the snapshot peer to peer (a git bundle of
 *     what their clone lacks, imported under the same ref there) and the
 *     conversation's new bytes (offset-checked appends, resent from where they
 *     are after a gap). The conversation never goes anywhere else;
 *   - only in a room whose admin made backups to origin available
 *     (`room.settings`, off by default), and only once this member allowed
 *     it for their own sessions in that room (asked once, kept on this Mac,
 *     like the House token's consent): that ref is pushed to origin with a lease on its own
 *     last value (never a branch), through the repository's pre-push hook,
 *     coalesced, with a timeout; the event records how it went, failures
 *     included. Turned off — by the admin, or by the member for their own —
 *     each owner deletes what it pushed there.
 *
 * Taker side, on Take over: their clone (found by origin URL), a new worktree
 * on the session's branch at the snapshot's parent with the snapshot's files
 * on top (uncommitted work and untracked files exactly), the newest snapshot of
 * the peer copy (and origin's, in a room backing up there), a new session
 * launched on the taker's account with a brief as its first input
 * (takeoverBrief.ts; never a resume of the owner's conversation) and the
 * transcript that arrived saved in the worktree's .mockingbird for reference,
 * and `session.takenOver` published. Taking back a session that was this
 * Mac's resumes this Mac's own conversation instead, briefed on the
 * teammate's turns.
 *
 * Owner online: the taker asks first (takeover.handover), whatever their
 * role in the room. The owner is prompted (Hand over / Keep it, kept after
 * ASK_MS unanswered); handing over lets the turn in progress finish, backs the
 * session up, copies that snapshot and the conversation to the taker, stops
 * the agent here and answers with the snapshot and a signed hand-over for
 * exactly that snapshot and teammate (takeoverGrants.ts; security review R6).
 * Keep, no answer, or the owner going offline mid-request leaves the session
 * where it is. An older taker's takeover.ask is refused, saying it needs an
 * update.
 *
 * Owner offline: any member takes it over without asking (`offline: 1`, no
 * grant), when the owner's Mockingbird takes those (its backups say
 * `offline: 1`; a 1.5 Mac refuses them). Every member's reducer lets it count
 * at once. The owner's Mac is the guard that it was really offline: it keeps
 * when it was connected to each teammate (connectionLog.ts) and, when it
 * learns of the take-over, refuses one stamped while it was connected to the
 * taker — or before the snapshot it continues from was taken — by publishing
 * `session.takeoverRefused`, which every member's reducer applies: the
 * session is the owner's again on every log, its agent never stopped, and the
 * taker's Mac stops its copy. So a session the owner is in is never stopped
 * by a take-over that should have asked.
 *
 * A take-over with neither a valid grant nor `offline` — an older
 * Mockingbird's, or a forged one — changes nothing (M3): the owner's Mac says
 * so in the room; take-overs from before grants that this Mac had already
 * honoured are accepted once (`session.takeoverAccepted`), so updating changes
 * no history. 1.5's away grants (`session.awayGrant`) are no longer given;
 * logs keep them and the take-overs they granted. A take-over carrying one is
 * checked by the owner's Mac like an offline one (ownerChecks): the grant's
 * window is read against the take-over's own time, which the taker picks, and
 * it can't be withdrawn any more.
 *
 * The snapshot a take-over starts from is one the owner signed: the commit a
 * `session.backup` (or the hand-over) names. The peer copy is what the
 * owner's Mockingbird sent this Mac, checked against the commit it named;
 * origin's ref counts only when it points at such a commit — never a commit
 * date or ref picked up from the remote (N6).
 *
 * The old copy: when the owner's Mockingbird learns of a take-over (at once,
 * on reconnecting, or on starting), it stops that session's agent and never
 * runs it again (SessionManager.relaunchGuard); its worktree is left exactly
 * as it is. The snapshot the taker continued from is kept under
 * refs/mockingbird/rooms-left/<room>/<session>, so the copy's changes since
 * (made while the owner was offline) can be counted and sent to whoever runs
 * the session now (takeover.changes): a patch they review and apply, never
 * applied by itself. Take it back is a take-over of the taker's copy.
 *
 * Cleanup: only a session's current owner (the taker, once taken over)
 * deletes its backup ref (on origin too, where there is one), then publishes `session.backupDropped`
 * and every member deletes its copies — when the owner forgets the session,
 * when the daily prune finds all its work merged into the base branch or no
 * turn for STALE_BACKUP_MS, and when a taker's first backup of its copy lands.
 * The conversation a take-over saved in the taker's worktree goes once the
 * session continued there no longer needs it (savedDone, removeSaved).
 *
 * Request methods between members: takeover.have, takeover.snapshot,
 * takeover.transcript, takeover.handover (takeover.ask before grants: refused),
 * takeover.progress, takeover.changes (each names its room; the transport
 * checks membership).
 *
 * TODO(audit-log, R5): take-over asks, hand-overs and refused
 * take-overs belong in the remote-action audit log once it exists; each place
 * is marked "TODO(audit-log)".
 */

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const CONV_ID_RE = /^[\w-]{1,100}$/;
/** The largest snapshot bundle sent peer to peer; bigger ones reach teammates only through origin, in a room backing up there. */
export const MAX_BUNDLE = 24 * 1024 * 1024;
/** Conversation bytes per request. */
export const TRANSCRIPT_CHUNK = 4 * 1024 * 1024;
const MAX_CANDIDATES = 32;
const SEND_TIMEOUT_MS = 120_000;
const REPO_INDEX_MS = 60_000;
/** A taken-over copy's changes are counted again this often. */
const LEFT_CHECK_MS = 60_000;
/** The patch a review shows at most. */
const REVIEW_MAX = 400_000;
/** Where the owner keeps the snapshot a teammate continued from, and the changes last sent them. */
const LEFT_ROOT = "refs/mockingbird/rooms-left";
const SENT_ROOT = "refs/mockingbird/rooms-sent";
const ASK_ID_RE = /^[0-9a-f]{16,64}$/;
const RECEIVED_ID_RE = /^[0-9a-f]{12,64}$/;

// ---- room events ------------------------------------------------------------------------

const text = (v: unknown, what: string, max: number, min = 0): string => {
  if (typeof v !== "string" || v.length > max || v.length < min) throw new PeerError(`${what} must be text of ${min}–${max} characters`);
  return v;
};
const time = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new PeerError(`${what} must be a time`);
  return v;
};
const sha = (v: unknown, what = "sha"): string => {
  if (typeof v !== "string" || !SHA_RE.test(v)) throw new PeerError(`${what} must be a commit id`);
  return v;
};
const sessionIdOf = (v: unknown): string => {
  if (typeof v !== "string" || !SESSION_ID_RE.test(v)) throw new PeerError("bad session id");
  return v;
};
const agentOf = (v: unknown): AgentKind => {
  if (v !== "claude" && v !== "codex") throw new PeerError("agent must be claude or codex");
  return v;
};
const sourceOf = (v: unknown): SnapshotSource => {
  if (v !== "peer" && v !== "origin") throw new PeerError("source must be peer or origin");
  return v;
};

function checkDescriptor(d: any): void {
  if (!d || typeof d !== "object") throw new Error("no session");
  text(d.title, "title", 300);
  agentOf(d.agent);
  if (d.branch !== null) text(d.branch, "branch", 250, 1);
  text(d.originUrl, "originUrl", 500, 1);
  if (hasCredentials(d.originUrl)) throw new Error("originUrl must not carry credentials");
  text(d.cwd, "cwd", 1000, 1);
  if (d.conversationId !== null && (typeof d.conversationId !== "string" || !CONV_ID_RE.test(d.conversationId))) throw new Error("bad conversation id");
  if (d.ticketId !== undefined && d.ticketId !== null) text(d.ticketId, "ticketId", 100, 1);
}

defineEventType("session.backup", {
  validate(b: any) {
    if (!b || typeof b !== "object") throw new Error("no body");
    sessionIdOf(b.sessionId);
    sha(b.sha);
    time(b.takenAt, "takenAt");
    if (!b.push || typeof b.push.ok !== "boolean") throw new Error("no push outcome");
    time(b.push.at, "push.at");
    if (!b.push.ok) text(b.push.error, "push.error", 500);
    if (!b.push.ok && withoutCredentials(b.push.error) !== b.push.error) throw new Error("push.error must not carry credentials");
    if (b.toOrigin !== undefined && typeof b.toOrigin !== "boolean") throw new Error("toOrigin must be true or false");
    checkDescriptor(b.session);
    if (b.transcriptBytes !== null && (!Number.isSafeInteger(b.transcriptBytes) || b.transcriptBytes < 0)) throw new Error("bad transcript size");
    if (b.grants !== undefined && b.grants !== 1) throw new Error("grants must be 1");
    if (b.offline !== undefined && b.offline !== 1) throw new Error("offline must be 1");
  },
  reduce(state, e) {
    const b = e.body;
    const t = (state.ext.takeover ??= { sessions: {} });
    const prev = t.sessions[b.sessionId];
    // a session is its first backer's; once taken over, the old copy's backups don't count
    if (prev && (prev.owner !== e.author || prev.takenOver || b.takenAt < prev.latest.takenAt)) return;
    const toOrigin = b.toOrigin !== false;
    const push = b.push.ok ? { ok: true as const, at: b.push.at, sha: b.sha } : { ok: false as const, at: b.push.at, error: b.push.error, sha: b.sha };
    t.sessions[b.sessionId] = {
      sessionId: b.sessionId,
      owner: e.author,
      session: b.session,
      latest: { sha: b.sha, takenAt: b.takenAt },
      toOrigin,
      push,
      // kept off origin, its owner deletes what it pushed there before
      pushed: !toOrigin ? null : b.push.ok ? { sha: b.sha, takenAt: b.takenAt, at: b.push.at } : prev?.pushed ?? null,
      transcriptBytes: b.transcriptBytes ?? prev?.transcriptBytes ?? null,
      ...(b.grants === 1 ? { grants: true as const } : {}),
      ...(b.offline === 1 ? { offline: true as const } : {}),
      takenOver: null,
      ...(prev?.ungranted ? { ungranted: prev.ungranted } : {}),
      ...(prev?.ungrantedDrop ? { ungrantedDrop: prev.ungrantedDrop } : {}),
      ...(prev?.refusals ? { refusals: prev.refusals } : {}),
      dropped: null,
    };
  },
});

defineEventType("session.backupDropped", {
  validate(b: any) {
    if (!b || typeof b !== "object") throw new Error("no body");
    sessionIdOf(b.sessionId);
    if (!DROP_REASONS.includes(b.reason)) throw new Error("bad reason");
  },
  reduce(state, e) {
    const s = state.ext.takeover?.sessions[e.body.sessionId];
    if (!s || s.dropped) return;
    // an ungranted taker's drop counts only if its owner accepts that take-over (session.takeoverAccepted)
    if (!s.takenOver && s.ungranted?.by === e.author) {
      s.ungrantedDrop ??= { at: e.at, by: e.author, reason: e.body.reason };
      return;
    }
    // only the session's current owner deletes its backup: the taker, once it's taken over
    if (e.author !== (s.takenOver?.by ?? s.owner)) return;
    s.dropped = { at: e.at, by: e.author, reason: e.body.reason };
  },
});

defineEventType("session.takenOver", {
  validate(b: any) {
    if (!b || typeof b !== "object") throw new Error("no body");
    sessionIdOf(b.sessionId);
    sessionIdOf(b.newSessionId);
    if (typeof b.from !== "string" || !MEMBER_ID_RE.test(b.from)) throw new Error("bad owner");
    if (!b.snapshot || typeof b.snapshot !== "object") throw new Error("no snapshot");
    sha(b.snapshot.sha, "snapshot.sha");
    time(b.snapshot.takenAt, "snapshot.takenAt");
    sourceOf(b.snapshot.source);
    if (!["full", "digest", "none"].includes(b.conversation)) throw new Error("bad conversation");
    if (b.branch !== null) text(b.branch, "branch", 250, 1);
    if (b.grant !== undefined) {
      const problem = grantShapeProblem(b.grant);
      if (problem) throw new Error(problem);
    }
    if (b.offline !== undefined && b.offline !== 1) throw new Error("offline must be 1");
  },
  reduce(state, e) {
    const b = e.body;
    const s = state.ext.takeover?.sessions[b.sessionId];
    // the first granted take-over in the room's order wins; an owner can't take over their own
    if (!s || s.takenOver || s.dropped || s.owner !== b.from || e.author === b.from) return;
    const t = { by: e.author, at: e.at, newSessionId: b.newSessionId, snapshot: b.snapshot, conversation: b.conversation };
    // the owner's signed consent, for this session, this taker (and snapshot, for a hand-over), at this time: no role gets past it
    if (!grantProblem(state, b.grant, { owner: s.owner, ownerName: "the owner", sessionId: b.sessionId, taker: e.author, at: e.at, sha: b.snapshot.sha })) {
      s.takenOver = { ...t, grant: b.grant!.kind };
      delete s.ungranted;
      delete s.ungrantedDrop;
      return;
    }
    // taken while the owner was offline: it counts until their Mac refuses it (session.takeoverRefused) — only when their Mockingbird takes those
    if (b.offline === 1 && b.grant === undefined && s.offline) {
      s.takenOver = { ...t, grant: "offline" };
      delete s.ungranted;
      delete s.ungrantedDrop;
      return;
    }
    // without it nothing changes: the owner's session runs on. Kept so the owner's Mockingbird can say so, and accept one it honoured before grants
    s.ungranted ??= t;
  },
});

defineEventType("session.takeoverRefused", {
  validate(b: any) {
    if (!b || typeof b !== "object") throw new Error("no body");
    sessionIdOf(b.sessionId);
    sessionIdOf(b.newSessionId);
    if (typeof b.by !== "string" || !MEMBER_ID_RE.test(b.by)) throw new Error("bad taker");
    if (!OFFLINE_REFUSAL_REASONS.includes(b.reason)) throw new Error("bad reason");
  },
  reduce(state, e) {
    const b = e.body;
    const s = state.ext.takeover?.sessions[b.sessionId];
    // only the session's owner refuses, and only the offline or away-granted take-over the room holds now
    const t = s?.takenOver;
    if (!s || !t || !ownerChecks(t) || e.author !== s.owner || t.by !== b.by || t.newSessionId !== b.newSessionId) return;
    s.takenOver = null;
    // the taker's drop of the old backup went with the take-over
    if (s.dropped?.by === t.by) s.dropped = null;
    s.refusals = [...(s.refusals ?? []), { by: t.by, newSessionId: t.newSessionId, takenAt: t.at, at: e.at, reason: b.reason }].slice(-MAX_REFUSALS);
  },
});

// 1.5's away grants: no longer published, still reduced, so the take-overs they granted keep counting
defineEventType("session.awayGrant", {
  validate(b: any, e) {
    if (!b || typeof b !== "object" || !("grant" in b)) throw new Error("no grant");
    if (b.grant === null) return;
    const problem = grantShapeProblem(b.grant);
    if (problem) throw new Error(problem);
    if (b.grant.kind !== "away") throw new Error("not an away grant");
    if (b.grant.owner !== e.author) throw new Error("an away grant is its owner's own");
  },
  reduce(state, e) {
    const t = (state.ext.takeover ??= { sessions: {} });
    const g = e.body.grant;
    if (g === null) {
      if (t.away) delete t.away[e.author];
      return;
    }
    if (g.owner !== e.author || g.roomId !== state.id || !grantSigned(state, g)) return;
    (t.away ??= {})[e.author] = g;
  },
});

defineEventType("session.takeoverAccepted", {
  validate(b: any) {
    if (!b || typeof b !== "object") throw new Error("no body");
    sessionIdOf(b.sessionId);
    sessionIdOf(b.newSessionId);
    if (typeof b.by !== "string" || !MEMBER_ID_RE.test(b.by)) throw new Error("bad taker");
  },
  reduce(state, e) {
    const s = state.ext.takeover?.sessions[e.body.sessionId];
    // only the session's owner accepts, and only the ungranted take-over the room kept
    if (!s || s.takenOver || e.author !== s.owner || s.ungranted?.by !== e.body.by || s.ungranted.newSessionId !== e.body.newSessionId) return;
    s.takenOver = { ...s.ungranted, grant: "accepted" };
    if (s.ungrantedDrop && !s.dropped) s.dropped = s.ungrantedDrop;
    delete s.ungranted;
    delete s.ungrantedDrop;
  },
});

defineEventType("room.settings", {
  validate(b: any) {
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("no body");
    if (b.backupsToOrigin !== undefined && typeof b.backupsToOrigin !== "boolean") throw new Error("backupsToOrigin must be true or false");
    if (b.migrationCheck !== undefined && typeof b.migrationCheck !== "boolean") throw new Error("migrationCheck must be true or false");
    if (b.migrationFolders !== undefined) checkMigrationFolders(b.migrationFolders);
  },
  reduce(state, e) {
    // roles at this point in the room's order decide, the same on every member: where backups go is
    // the owner's alone, the migration check (a room rule) its owner's or an admin's
    if (!isRoomAdmin(state, e.author)) return;
    const owner = roomOwner(state) === e.author;
    if (!owner && e.body.migrationCheck === undefined && e.body.migrationFolders === undefined) return;
    const was = state.ext.settings;
    const check = e.body.migrationCheck ?? was?.migrationCheck;
    // a repository given no folders goes back to detection
    const folders = { ...(was?.migrationFolders ?? {}), ...(e.body.migrationFolders ?? {}) };
    for (const [k, v] of Object.entries(folders)) if (!v.length) delete folders[k];
    state.ext.settings = {
      backupsToOrigin: (owner ? e.body.backupsToOrigin : undefined) ?? was?.backupsToOrigin ?? false,
      ...(check !== undefined ? { migrationCheck: check } : {}),
      ...(Object.keys(folders).length ? { migrationFolders: folders } : {}),
      by: e.author,
      at: e.at,
    };
  },
});

/** room.settings' migration folders: at most 20 repositories (origin keys), each with at most 10 folders (none: back to detection). */
function checkMigrationFolders(v: unknown): void {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("migrationFolders must be an object");
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 20) throw new Error("migrationFolders names at most 20 repositories");
  for (const [k, folders] of entries) {
    checkRepoKey(k);
    if (!Array.isArray(folders) || folders.length > 10) throw new Error("each repository's migrationFolders is a list of at most 10");
    for (const f of folders) if (checkFolder(f) !== f) throw new Error("a migration folder isn't in its plain form");
  }
}

// a member who left or was removed deletes their own backups; nobody can take those sessions over any more
onMemberRemoved("takeover", (state, member, e) => {
  for (const s of Object.values(state.ext.takeover?.sessions ?? {})) {
    if (s.owner !== member || s.takenOver || s.dropped) continue;
    s.dropped = { at: e.at, by: e.author, reason: "left-room" };
  }
});

// ---- the seams ------------------------------------------------------------------------------

/**
 * What take-over needs from the app's sessions. index.ts provides liveRoomHost
 * (the live panes' room sessions and their turn ends); tests provide their own.
 */
export interface RoomSessionHost {
  /** The room a session on this install is shared in, or null when it's private (or a teammate took it over). */
  roomOf(sessionId: string): RoomId | null;
  /** A session on this install: running, or closed and resumable. */
  session(sessionId: string): SessionInfo | undefined;
  /** The local group a room is shown as: where a taken-over session goes. */
  groupOf(roomId: RoomId): string | null;
  /** Each agent turn's end in a session on this install. */
  onTurnEnd(cb: (sessionId: string) => void): Unsubscribe;
  /** End a running session's agent, leaving its pane and folder as they are; false when it wasn't running. */
  stop(sessionId: string): boolean;
}

/**
 * The host over this install's room sessions as the live panes know them
 * (roomSessions.ts): a session's room, and the turn ends they report — the
 * same turn ends the Co-authored-by trailers count, so a backup follows every
 * turn a teammate's typing is credited for.
 */
export function liveRoomHost(
  live: RoomSessionSource,
  o: { sessions: () => SessionInfo[]; resumable: () => SessionInfo[]; rooms: () => { id: RoomId; groupKey: string }[]; stop: (sessionId: string) => boolean }
): RoomSessionHost {
  return {
    roomOf: (id) => live.roomOfSession(id),
    session: (id) => o.sessions().find((s) => s.id === id) ?? o.resumable().find((s) => s.id === id),
    groupOf: (roomId) => o.rooms().find((r) => r.id === roomId)?.groupKey ?? null,
    onTurnEnd: (cb) => live.onTurnEnded((e) => cb(e.sessionId)),
    stop: (id) => o.stop(id),
  };
}

export interface TakeoverDeps {
  team: Team;
  /** Where this install keeps rooms (<team dir>/rooms): records and transcripts go under <room>/. */
  roomsDir: string;
  host: RoomSessionHost;
  /** Repositories on this Mac, to find a clone by its origin. */
  repos: () => string[];
  /** Start the continued session (SessionManager.create). */
  launch: (req: NewSessionRequest) => Promise<SessionInfo>;
  log: (context: string, err: unknown) => string;
  /** What the window shows changed. */
  changed?: () => void;
  /** A teammate took over a session this install runs. */
  onTakenOver?: (sessionId: string, byName: string) => void;
  /** A session's owner refused this install's offline take-over of it (session.takeoverRefused): `sessionId`, the copy here, stopped. */
  onRefused?: (sessionId: string, ownerName: string, title: string) => void;
  /** A teammate asks to continue a session this install runs: the owner is prompted (the window shows view().asks). */
  onAsk?: (ask: IncomingAsk) => void;
  /** A teammate sent changes from their copy of a session this install now runs. */
  onReceived?: (r: ReceivedChanges) => void;
  /** Post a line to a room's chat as this install's member (TeamChat.post). */
  chat: (roomId: RoomId, text: string) => void;
  /** How long the owner has to answer (default ASK_MS), and a hand-over waits for a turn (HANDOVER_TURN_MS). */
  askMs?: number;
  handoverTurnMs?: number;
  /** Secret files at known places on this Mac (absolute paths): a backup leaves them out, with every SECRET_FILE_GLOBS match. */
  secretFiles?: () => string[];
  /** Where the CLIs keep conversations on this Mac (default ~/.claude/projects, ~/.codex/sessions). */
  claudeProjects?: string;
  codexSessions?: string;
  now?: () => number;
  /** The leeway an offline take-over's time gets against this Mac's record of connections (default OFFLINE_TAKEOVER_SKEW_MS). */
  offlineSkewMs?: number;
  pushTimeoutMs?: number;
  fetchTimeoutMs?: number;
  /** Where this member's answers to "back up my room sessions to origin?" are kept (default <team dir>/backup-consent.json). */
  consentFile?: string;
}

/** What this install remembers per room (<room>/takeover.json). */
interface OwnRecord {
  sha: string;
  tree: string;
  parent: string | null;
  takenAt: number;
  /** What origin's backup ref was last set to by this install. */
  pushed: string | null;
  pushedAt?: number;
  /** The session's repository (its main clone: refs are shared by its worktrees, which may be gone). */
  repo: string;
  title: string;
  /** The last turn's end: a backup with none for STALE_BACKUP_MS is deleted. */
  activeAt: number;
  /** Deleting the backup failed: retried on the next prune. */
  drop?: { reason: DropReason; error: string; at: number };
}
interface MirrorRecord {
  sha: string;
  takenAt: number;
  repo: string;
  from: MemberId;
  at: number;
}
/** A session of this install's that a teammate continued: what's needed to tell (and send) what they lack. */
interface LeftRecord {
  /** The snapshot the teammate continued from (kept under LEFT_ROOT). */
  base: string;
  /** The session's repository (its refs) and folder. */
  repo: string;
  cwd: string;
  title: string;
  at: number;
  /** The changes last sent: a commit on top of `base` (or of the send before), kept under SENT_ROOT. */
  sent?: { sha: string; at: number; files: number };
}
/**
 * A teammate's conversation saved in one of this Mac's worktrees at a
 * take-over (TAKEOVER_TRANSCRIPT_DIR), for the continued session's agent to
 * read. It's the whole conversation, never filtered for secrets, so it goes
 * once that session no longer needs it (savedDone).
 */
interface SavedTranscript {
  /** The session continued there; null until it has started. */
  sessionId: string | null;
  /** The teammate's session it came from. */
  from: string;
  title: string;
  at: number;
}
/** Changes a teammate sent from their copy (the patch is <room>/received/<id>.patch). */
interface ReceivedRecord {
  sessionId: string;
  fromSessionId: string;
  from: MemberId;
  title: string;
  files: ChangedFile[];
  bytes: number;
  at: number;
  applied: number | null;
}
/** A take-over of one of this install's sessions that carried no grant from it: told once in the room, shown until it's resolved. */
interface RefusedRecord {
  sessionId: string;
  by: MemberId;
  title: string;
  at: number;
  why: string;
}
interface LocalState {
  v: 1;
  /** Take-overs this install refused, by session and taker. */
  refused?: Record<string, RefusedRecord>;
  /** Room sessions this install runs: the newest snapshot and what origin has. */
  own: Record<string, OwnRecord>;
  /** Teammates' sessions: the snapshot copied into this Mac's clone. */
  mirrored: Record<string, MirrorRecord>;
  /** This install's sessions that teammates continued. */
  left: Record<string, LeftRecord>;
  /** Changes teammates sent, by id. */
  received: Record<string, ReceivedRecord>;
  /** Teammates' conversations saved in this Mac's worktrees at take-overs, by worktree. */
  saved: Record<string, SavedTranscript>;
}
type Decision = "handover" | "keep" | "timeout" | "gone" | "closed";
interface PendingAsk extends IncomingAsk {
  decide: (d: Decision) => void;
}
interface PendingOutgoing extends OutgoingAsk {
  owner: MemberId;
}
interface TranscriptMeta {
  agent: AgentKind;
  conversationId: string;
  file: string;
  ownerCwd: string;
  /** The owner's size when it last sent: a complete copy holds at least this. */
  total: number;
  from: MemberId;
  updatedAt: number;
}
interface Job {
  again: boolean;
  done: Promise<void>;
}
interface Candidate {
  sha: string;
  takenAt: number;
  source: SnapshotSource;
}

export class TakeoverService {
  private readonly now: () => number;
  private readonly claudeProjects: string;
  private readonly codexSessions: string;
  private offs: Unsubscribe[] = [];
  private backups = new Map<string, Job>();
  private mirrors = new Map<string, Job>();
  private background = new Set<Promise<unknown>>();
  private locals = new Map<RoomId, LocalState>();
  /** Per teammate, session and conversation: the bytes they hold, as last answered. */
  private transcriptAt = new Map<string, number>();
  /** Problems sending a session to teammates, by session. */
  private problems = new Map<string, string>();
  private unbacked = new Map<string, { roomId: RoomId; title: string; problem: string }>();
  private lastPublished = new Map<string, string>();
  private presence = new Map<RoomId, Set<MemberId>>();
  private repoIndex: { at: number; byIdentity: Map<string, string> } | null = null;
  private ownFiles = new Map<string, string>();
  private noClone = new Set<string>();
  private taking = new Set<string>();
  /** Sessions the owner forgot: no more backups. */
  private forgotten = new Set<string>();
  private cleanupProblems = new Map<string, { roomId: RoomId; title: string; problem: string; what?: string }>();
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly askMs: number;
  private readonly handoverTurnMs: number;
  /** Teammates' requests to continue this install's sessions, by ask id. */
  private incoming = new Map<string, PendingAsk>();
  /** This install's requests to owners, by ask id. */
  private outgoing = new Map<string, PendingOutgoing>();
  /** What each left copy has that its teammate lacks, as last counted. */
  private unsent = new Map<string, LeftCopy["unsent"]>();
  private checks = new Map<string, Job>();
  private sending = new Set<string>();
  private leftTimer: ReturnType<typeof setInterval>;
  /** Per session of this install's: the snapshot each teammate's clone holds, as last heard. */
  private held = new Map<string, Map<MemberId, string>>();
  /** Each room's backups-to-origin setting as last acted on. */
  private originSetting = new Map<RoomId, boolean>();
  /** This member's answer per room to backing up their own sessions to origin (R7): only theirs to give. */
  private consents: Record<RoomId, { allow: boolean; at: number }> = {};
  private readonly consentFile: string;
  /** When this Mac was connected to each teammate: what an offline take-over of its sessions is checked against. */
  private readonly connections: ConnectionLog;
  private readonly offlineSkewMs: number;
  private beatTimer: ReturnType<typeof setInterval>;

  constructor(private d: TakeoverDeps) {
    this.now = d.now ?? Date.now;
    this.claudeProjects = d.claudeProjects ?? CLAUDE_PROJECTS;
    this.codexSessions = d.codexSessions ?? CODEX_SESSIONS;
    this.askMs = d.askMs ?? ASK_MS;
    this.handoverTurnMs = d.handoverTurnMs ?? HANDOVER_TURN_MS;
    this.consentFile = d.consentFile ?? path.join(path.dirname(d.roomsDir), "backup-consent.json");
    const answers = readJsonOrSetAside(this.consentFile, {}, "your answers about backing up to origin");
    for (const [roomId, a] of Object.entries(answers && typeof answers === "object" ? answers : {})) {
      if (typeof (a as any)?.allow === "boolean") this.consents[roomId] = { allow: (a as any).allow, at: Number((a as any).at) || 0 };
    }
    const t = d.team;
    this.offlineSkewMs = d.offlineSkewMs ?? OFFLINE_TAKEOVER_SKEW_MS;
    this.connections = new ConnectionLog({ dir: d.roomsDir, now: this.now, log: d.log });
    for (const r of t.rooms()) {
      this.presence.set(r.id, new Set(t.presence(r.id)));
      this.connections.update(r.id, t.presence(r.id));
      this.originSetting.set(r.id, backupsToOrigin(r));
    }
    this.offs.push(
      d.host.onTurnEnd((id) => void this.track(this.turnEnded(id))),
      t.onRequest("takeover.have", (p, ctx) => this.onHave(p, ctx)),
      t.onRequest("takeover.snapshot", (p, ctx) => this.onSnapshot(p, ctx)),
      t.onRequest("takeover.transcript", (p, ctx) => this.onTranscript(p, ctx)),
      t.onRequest("takeover.handover", (p, ctx) => this.onAsk(p, ctx)),
      t.onRequest("takeover.ask", (p, ctx) => this.onUngrantedAsk(p, ctx)),
      t.onRequest("takeover.progress", (p, ctx) => this.onProgress(p, ctx)),
      t.onRequest("takeover.changes", (p, ctx) => this.onChanges(p, ctx)),
      t.onEvent("session.backup", () => this.changed()),
      t.onEvent("session.takenOver", (e, room) => this.onTakenOver(e, room)),
      t.onEvent("session.takeoverAccepted", (e, room) => this.onAccepted(e, room)),
      t.onEvent("session.takeoverRefused", (e, room) => this.onRefusedEvent(e, room)),
      t.onEvent("session.backupDropped", (e, room) => this.onDropped(e, room)),
      t.onEvent("member.removed", (e, room) => this.onMemberRemoved(e, room)),
      t.onEvent("room.settings", (_e, room) => this.onSettings(room)),
      t.onPresence((roomId, online) => this.onPresence(roomId, online))
    );
    // take-overs from before grants that this install honoured then (it keeps a record of each copy it stopped): accepted, so they still count
    for (const room of t.rooms()) {
      for (const e of Object.values(room.ext.takeover?.sessions ?? {})) {
        if (e.takenOver || !e.ungranted || e.owner !== t.self.id || !this.local(room.id).left[e.sessionId]) continue;
        try {
          t.publish(room.id, "session.takeoverAccepted", { sessionId: e.sessionId, by: e.ungranted.by, newSessionId: e.ungranted.newSessionId });
          this.d.log(`team: session ${e.sessionId}`, `accepted ${this.nameOf(room.id, e.ungranted.by)}'s take-over from before take-overs needed a grant: this Mac had already stopped its copy`);
        } catch (err) {
          this.d.log(`team: accepting the take-over of session ${e.sessionId} from before grants`, err);
        }
      }
    }
    // take-overs this install already knows of (heard before it last quit, or kept in the room log): their copies stay stopped —
    // an offline one it hasn't stopped for yet is checked first, as when it's heard. An away-granted one only while its
    // session is still here: one this Mac honoured before it checked those (1.5, 1.6.0) has a `left` record, or its
    // session was closed here before it was heard, and keeps counting
    for (const room of t.rooms()) {
      for (const e of Object.values(room.ext.takeover?.sessions ?? {})) {
        if (!e.takenOver || e.owner !== t.self.id) continue;
        const unchecked = !this.local(room.id).left[e.sessionId] && (e.takenOver.grant === "offline" || (e.takenOver.grant === "away" && !!this.d.host.session(e.sessionId)));
        if (unchecked && this.refuseOffline(room, e)) continue;
        this.leave(room.id, e.sessionId);
      }
    }
    // this install's take-overs refused while it wasn't running: their copies stop
    for (const room of t.rooms()) {
      for (const e of Object.values(room.ext.takeover?.sessions ?? {})) for (const r of e.refusals ?? []) if (r.by === t.self.id) this.stopRefused(room, e, r.newSessionId, false);
    }
    this.beatTimer = setInterval(() => this.connections.beat(), CONNECTED_BEAT_MS);
    this.beatTimer.unref?.();
    this.leftTimer = setInterval(() => {
      for (const room of this.d.team.rooms()) for (const id of Object.keys(this.local(room.id).left)) void this.track(this.checkLeft(room.id, id));
    }, LEFT_CHECK_MS);
    this.leftTimer.unref?.();
  }

  close(): void {
    this.closed = true;
    for (const off of this.offs) off();
    this.offs = [];
    if (this.changeTimer) clearTimeout(this.changeTimer);
    clearInterval(this.leftTimer);
    clearInterval(this.beatTimer);
    this.connections.close();
    for (const a of this.incoming.values()) a.decide("closed");
  }

  /** Resolves once every background send and push started so far has finished (for tests and quitting). */
  async settled(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  // ---- backing up (owner) ---------------------------------------------------------------

  /**
   * An agent turn ended in a session on this install: when it's a room
   * session, snapshot it, send it to connected teammates and — when the room
   * backs up to origin — push it there. Turns that end while one is being
   * backed up make it run once more. Resolves once the push is done and
   * recorded; never rejects (failures are logged, recorded in the room and
   * shown).
   */
  turnEnded(sessionId: string): Promise<void> {
    return this.coalesce(this.backups, sessionId, () => this.backupOnce(sessionId));
  }

  private async backupOnce(sessionId: string): Promise<void> {
    if (this.closed) return;
    const roomId = this.d.host.roomOf(sessionId);
    if (!roomId) return;
    const s = this.d.host.session(sessionId);
    if (!s || s.shell || !s.repoPath || this.forgotten.has(sessionId)) return;
    if (this.d.team.room(roomId)?.ext.takeover?.sessions[sessionId]?.takenOver) return; // a teammate continues it: this copy isn't the room's
    try {
      await this.backup(roomId, s);
      this.unbacked.delete(sessionId);
    } catch (err) {
      const problem = withoutCredentials(err instanceof Error ? err.message : String(err));
      this.d.log(`team: backing up session ${sessionId}`, problem);
      this.unbacked.set(sessionId, { roomId, title: s.ticketTitle ?? s.title, problem });
    }
    this.changed();
  }

  private async backup(roomId: RoomId, s: SessionInfo): Promise<void> {
    const top = await repoTop(s.cwd);
    if (!top) throw new Error(`${s.cwd} isn't in a git repository`);
    const url = await originUrl(top);
    if (!url) throw new Error("the repository has no origin remote: there's nowhere to back it up, and teammates can't find their clone of it");
    const ref = roomBackupRef(roomId, s.id);
    const prev = this.local(roomId).own[s.id];
    const takenAt = this.now();
    const snap = await snapshotCommit(top, `${snapshotSubject(s.id)}\n\ntaken-at: ${takenAt}`, { secrets: secretPathspecs(top, this.d.secretFiles?.() ?? []) });
    if (!snap) throw new Error(`${s.cwd} isn't in a git repository`);
    // nothing changed since the last turn: keep that snapshot, with nothing new to send or push
    const same = !!prev && prev.tree === snap.tree && prev.parent === snap.parent && (await hasCommits(top, [prev.sha])).length === 1;
    const kept = { repo: s.repoPath ?? top, title: (s.ticketTitle ?? s.title).slice(0, 300), activeAt: takenAt }; // a turn is activity: a pending drop no longer applies
    let rec: OwnRecord = same ? { ...prev, ...kept, drop: undefined } : { sha: snap.sha, tree: snap.tree, parent: snap.parent, takenAt, pushed: prev?.pushed ?? null, pushedAt: prev?.pushedAt, ...kept };
    await git(top, ["update-ref", ref, rec.sha]);
    this.saveOwn(roomId, s.id, rec);
    for (const peer of this.d.team.presence(roomId)) this.mirror(peer, roomId, s.id);
    const toOrigin = this.toOriginFor(roomId);
    let push: PushOutcome;
    if (!toOrigin) push = { ok: false, at: rec.takenAt, error: backupsToOrigin(this.d.team.room(roomId)) ? NOT_ALLOWED : NOT_PUSHED };
    else if (rec.pushed === rec.sha) push = { ok: true, at: rec.pushedAt ?? takenAt };
    else {
      push = await this.push(top, ref, rec, s.id);
      if (push.ok) this.saveOwn(roomId, s.id, (rec = { ...rec, pushed: rec.sha, pushedAt: push.at }));
    }
    const conv = conversationOf(s);
    const file = conv ? this.ownTranscript(conv.agent, conv.id, s.cwd) : null;
    const session: RoomSessionDescriptor = {
      title: (s.ticketTitle ?? s.title).slice(0, 300),
      agent: s.agent ?? "claude",
      branch: await currentBranch(top),
      originUrl: publicUrl(url),
      cwd: s.cwd,
      conversationId: conv?.id ?? null,
      ...(s.ticketId ? { ticketId: s.ticketId.slice(0, 100) } : {}),
    };
    const body = { sessionId: s.id, sha: rec.sha, takenAt: rec.takenAt, push, ...(toOrigin ? {} : { toOrigin: false }), session, transcriptBytes: file ? (await fs.promises.stat(file)).size : null, grants: 1 as const, offline: 1 as const };
    // a turn that changed nothing anyone records isn't a new event
    const key = JSON.stringify({ ...body, push: push.ok ? { ok: true, at: push.at } : { ok: false, error: push.error } });
    if (this.lastPublished.get(s.id) !== key) {
      this.d.team.publish(roomId, "session.backup", body);
      this.lastPublished.set(s.id, key);
    }
    // the session this one took over: its backup goes once this copy has one (on origin, in a room backing up there)
    if (toOrigin && !push.ok) return;
    for (const old of Object.values(this.d.team.room(roomId)?.ext.takeover?.sessions ?? {})) {
      if (old.takenOver?.by === this.d.team.self.id && old.takenOver.newSessionId === s.id && !old.dropped) await this.dropBackup(roomId, old.sessionId, "taken-over", rec.repo, old.session.title);
    }
  }

  // ---- deleting backups (their current owner) --------------------------------------------------

  /**
   * The owner forgot a session (closed it without keeping it to resume): its
   * backup goes from origin and from members' clones. Not when the session
   * was taken over: then it's the taker's to delete.
   */
  async sessionForgotten(sessionId: string): Promise<void> {
    this.forgotten.add(sessionId);
    this.removeSavedFor(sessionId, "its session was closed");
    await this.backups.get(sessionId)?.done; // a push under way would bring the ref back
    for (const room of this.d.team.rooms()) {
      const local = this.local(room.id);
      const left = local.left[sessionId];
      if (left) {
        // the copy a teammate continued is closed: what kept count of its changes goes (its folder stays)
        try {
          if (fs.existsSync(left.repo)) for (const root of [LEFT_ROOT, SENT_ROOT]) await git(left.repo, ["update-ref", "-d", roomBackupRef(room.id, sessionId, root)]);
          delete local.left[sessionId];
          this.unsent.delete(sessionId);
          this.saveLocal(room.id);
        } catch (err) {
          this.cleanupFailed(room.id, sessionId, left.title, err);
        }
      }
      for (const [id, r] of Object.entries(local.received)) if (r.sessionId === sessionId) await this.dropReceived(room.id, id);
      const rec = local.own[sessionId];
      if (!rec) continue;
      const entry = room.ext.takeover?.sessions[sessionId];
      try {
        if (entry?.takenOver || entry?.dropped) await this.forgetLocal(room.id, sessionId);
        else await this.dropBackup(room.id, sessionId, "closed", rec.repo, rec.title);
      } catch (err) {
        this.cleanupFailed(room.id, sessionId, rec.title, err);
      }
    }
  }

  /**
   * Delete this install's backups that are no longer needed: no turn for
   * STALE_BACKUP_MS, all their work in the base branch, or a deletion that
   * failed before — and, in a room that keeps backups off origin, whatever
   * this install pushed there. Run on start and daily. Never rejects:
   * failures are logged and shown, and retried next time.
   */
  async prune(): Promise<void> {
    for (const room of this.d.team.rooms()) {
      try {
        this.adoptSaved(room);
      } catch (err) {
        this.d.log(`team: finding conversations saved at take-overs in room ${room.id}`, err);
      }
      for (const [worktree, rec] of Object.entries(this.local(room.id).saved)) {
        const why = this.savedDone(room, rec);
        if (why) this.removeSaved(room.id, worktree, why);
      }
      if (!this.toOriginFor(room.id)) await this.withdrawFromOrigin(room.id);
      for (const [sessionId, rec] of Object.entries(this.local(room.id).own)) {
        if (this.backups.has(sessionId)) continue; // being backed up: it's active
        try {
          const entry = room.ext.takeover?.sessions[sessionId];
          // taken over (the taker deletes it) or already deleted: only this Mac's own copy is left
          if (entry?.takenOver || entry?.dropped) {
            await this.forgetLocal(room.id, sessionId);
            continue;
          }
          const reason: DropReason | null = rec.drop?.reason ?? (this.now() - rec.activeAt > STALE_BACKUP_MS ? "stale" : (await this.merged(rec)) ? "merged" : null);
          if (reason) await this.dropBackup(room.id, sessionId, reason, rec.repo, rec.title);
        } catch (err) {
          this.cleanupFailed(room.id, sessionId, rec.title, err);
        }
      }
    }
  }

  /** All of a backup's work is in the repository's base branch on origin: no uncommitted changes, and its commit merged. */
  private async merged(rec: OwnRecord): Promise<boolean> {
    if (!rec.parent || !fs.existsSync(rec.repo)) return false;
    if ((await git(rec.repo, ["rev-parse", `${rec.parent}^{tree}`])) !== rec.tree) return false; // uncommitted work lives only in the backup
    const base = pickDefaultBase((await branchesOf(rec.repo)).origin);
    return !!base && (await isAncestor(rec.repo, rec.parent, `refs/remotes/origin/${base}`));
  }

  /**
   * Delete a session's backup ref on origin, where there may be one, then
   * tell the room, whose members delete their copies, and delete this
   * install's own before resolving: its record of the backup must be gone by
   * the next turn, which would otherwise take origin's copy as still pushed.
   * A failure is kept on the session and shown.
   */
  private async dropBackup(roomId: RoomId, sessionId: string, reason: DropReason, repo: string, title: string): Promise<void> {
    try {
      // a room that keeps backups off origin has one there only if this install pushed it before
      if (this.toOriginFor(roomId) || this.local(roomId).own[sessionId]?.pushed) await this.deleteOnOrigin(repo, roomBackupRef(roomId, sessionId));
      this.d.team.publish(roomId, "session.backupDropped", { sessionId, reason });
      this.cleanupProblems.delete(sessionId);
    } catch (err) {
      const rec = this.local(roomId).own[sessionId];
      const error = this.cleanupFailed(roomId, sessionId, title, err);
      if (rec) this.saveOwn(roomId, sessionId, { ...rec, drop: { reason, error, at: this.now() } });
      this.changed();
      return;
    }
    await this.forgetLocal(roomId, sessionId).catch((err) => void this.cleanupFailed(roomId, sessionId, title, err));
  }

  private cleanupFailed(roomId: RoomId, sessionId: string, title: string, err: unknown): string {
    const problem = withoutCredentials(err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim().slice(0, 300);
    this.d.log(`team: deleting the backup of session ${sessionId}`, problem);
    this.cleanupProblems.set(sessionId, { roomId, title, problem });
    this.changed();
    return problem;
  }

  /**
   * Delete `ref` on origin, expecting the value it has there, so nothing
   * written meanwhile is lost. Without the pre-push hook: a deletion carries
   * no content for it to check, and one that refuses hidden refs mustn't
   * leave a backup on origin for good. Throws when it couldn't.
   */
  private async deleteOnOrigin(repo: string, ref: string): Promise<void> {
    const there = (await git(repo, ["ls-remote", "origin", ref], { timeoutMs: this.d.fetchTimeoutMs ?? 30_000 })).split("\t")[0];
    if (there) await git(repo, ["push", "--no-verify", "--quiet", `--force-with-lease=${ref}:${there}`, "origin", `:${ref}`], { timeoutMs: this.d.pushTimeoutMs ?? 60_000 });
  }

  /**
   * This member's sessions in the room keep backups off origin (its admin
   * turned that off or never on, or this member hasn't allowed it): delete
   * there every backup ref this install pushed. A failure is kept on the
   * session, shown, and retried on the next prune.
   */
  private async withdrawFromOrigin(roomId: RoomId): Promise<void> {
    const local = this.local(roomId);
    for (const sessionId of Object.keys(local.own)) {
      if (!local.own[sessionId]?.pushed) continue;
      await this.backups.get(sessionId)?.done; // a push under way would bring the ref back
      if (this.toOriginFor(roomId)) return; // turned on again meanwhile
      const rec = local.own[sessionId];
      if (!rec?.pushed) continue;
      try {
        await this.deleteOnOrigin(rec.repo, roomBackupRef(roomId, sessionId));
        this.saveOwn(roomId, sessionId, { ...rec, pushed: null, pushedAt: undefined });
        this.cleanupProblems.delete(sessionId);
      } catch (err) {
        this.cleanupFailed(roomId, sessionId, rec.title, err);
      }
    }
    this.changed();
  }

  /**
   * The room's settings changed: backups to origin made available push what
   * this install has now, once this member allowed it (until then the window
   * asks); taken away, what it pushed goes.
   */
  private onSettings(room: RoomState): void {
    const now = backupsToOrigin(room);
    if (this.originSetting.get(room.id) === now) return; // an event that changed nothing (not the admin's, or the same value)
    this.originSetting.set(room.id, now);
    if (now) this.pushOwnNow(room.id);
    else void this.track(this.withdrawFromOrigin(room.id));
    this.changed();
  }

  /** Back up this install's sessions in the room at once, without waiting for a turn: what goes to origin goes now. */
  private pushOwnNow(roomId: RoomId): void {
    if (!this.toOriginFor(roomId)) return;
    for (const sessionId of Object.keys(this.local(roomId).own)) if (this.d.host.roomOf(sessionId) === roomId) void this.track(this.turnEnded(sessionId));
  }

  /**
   * Whether this install's sessions in the room back up to origin: only
   * when the room's admin made it available and this member allowed it for
   * their own sessions. The admin's switch never pushes anyone's work alone.
   */
  private toOriginFor(roomId: RoomId): boolean {
    return backupsToOrigin(this.d.team.room(roomId)) && this.consents[roomId]?.allow === true;
  }

  /** This member's answer to backing up their own room sessions to origin: true, false (Not now), or null (not asked yet). */
  backupConsent(roomId: RoomId): boolean | null {
    return this.consents[roomId]?.allow ?? null;
  }

  /**
   * This member allows (or stops) backups of their own sessions in the room
   * to origin. Kept on this Mac only. Allowed while the room has them
   * available, the newest snapshots go at once; stopped, what this install
   * pushed is deleted from origin.
   */
  setBackupConsent(roomId: RoomId, allow: boolean): void {
    if (typeof allow !== "boolean") throw new Error("Say allow or not");
    if (!this.d.team.room(roomId)) throw new Error("You're not in that room");
    this.consents[roomId] = { allow, at: this.now() };
    this.saveConsents();
    if (allow) this.pushOwnNow(roomId);
    else void this.track(this.withdrawFromOrigin(roomId));
    this.changed();
  }

  private saveConsents(): void {
    fs.mkdirSync(path.dirname(this.consentFile), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.consentFile, `${JSON.stringify(this.consents, null, 2)}\n`, 0o600);
  }

  /**
   * Turn backups to origin on or off for a room: its owner's choice alone (a
   * room event every member applies; anyone else's changes nothing). Off is
   * the default.
   */
  setBackupsToOrigin(roomId: RoomId, on: boolean): void {
    if (typeof on !== "boolean") throw new Error("Say on or off");
    const room = this.d.team.room(roomId);
    if (!room) throw new Error("You're not in that room");
    const owner = roomOwner(room);
    if (owner !== this.d.team.self.id) throw new Error(`Only the room's owner${owner ? ` (${this.nameOf(roomId, owner)})` : ""} can change where its backups go`);
    if (backupsToOrigin(room) === on) return;
    this.d.team.publish(roomId, "room.settings", { backupsToOrigin: on });
  }

  /** A session's backup was deleted: this Mac's copies go too (its own ref, a teammate's copy in a clone, the conversation). */
  private async forgetLocal(roomId: RoomId, sessionId: string): Promise<void> {
    const local = this.local(roomId);
    const own = local.own[sessionId];
    const mirrored = local.mirrored[sessionId];
    const entry = this.d.team.room(roomId)?.ext.takeover?.sessions[sessionId];
    const clone = entry && !own ? await this.cloneFor(entry.session.originUrl) : null;
    const ref = roomBackupRef(roomId, sessionId);
    // what this install pushed while the room backed up to origin goes from there first (with the room on, its current owner deletes it)
    if (own?.pushed && !this.toOriginFor(roomId)) await this.deleteOnOrigin(own.repo, ref);
    for (const repo of new Set([own?.repo, mirrored?.repo, clone].filter((r): r is string => !!r && fs.existsSync(r)))) {
      for (const r of [ref, roomBackupRef(roomId, sessionId, ORIGIN_COPY_ROOT)]) await git(repo, ["update-ref", "-d", r]);
    }
    await fs.promises.rm(this.transcriptDir(roomId, sessionId), { recursive: true, force: true });
    delete local.own[sessionId];
    delete local.mirrored[sessionId];
    this.saveLocal(roomId);
    this.lastPublished.delete(sessionId);
    this.held.delete(sessionId);
    this.cleanupProblems.delete(sessionId);
    this.changed();
  }

  private onDropped(e: RoomEvent<"session.backupDropped">, room: RoomState): void {
    const s = room.ext.takeover?.sessions[e.body.sessionId];
    if (s?.dropped?.by !== e.author) return; // not the owner's: the room ignored it
    // the session continued in a worktree here is done (closed, merged, stale, taken over): the conversation saved for it goes
    if (s.owner === this.d.team.self.id) this.removeSavedFor(e.body.sessionId, `the backup of “${s.session.title}” was deleted (${e.body.reason})`);
    // this install's own drop: dropBackup deletes its copies itself, in order with its next turn
    if (e.author === this.d.team.self.id) return;
    this.track(
      this.forgetLocal(room.id, e.body.sessionId).catch((err) => {
        this.cleanupFailed(room.id, e.body.sessionId, s.session.title, err);
      })
    );
  }

  /**
   * A teammate left the room or was removed: this Mac forgets what it got
   * from their sessions — snapshots in its clone, conversations, records —
   * and the changes and requests they sent. (The room marked their backups
   * deleted; deleting them on origin is theirs.)
   */
  private onMemberRemoved(e: RoomEvent<"member.removed">, room: RoomState): void {
    const member = e.body.member;
    if (member === this.d.team.self.id || room.members.some((m) => m.id === member)) return; // this install's own leave is roomLeft's; a refused removal changed nothing
    for (const b of Object.values(room.ext.takeover?.sessions ?? {})) {
      if (b.owner !== member || b.dropped?.reason !== "left-room") continue;
      this.track(this.forgetLocal(room.id, b.sessionId).catch((err) => void this.cleanupFailed(room.id, b.sessionId, b.session.title, err)));
    }
    for (const [id, r] of Object.entries(this.local(room.id).received)) {
      if (r.from === member) this.track(this.dropReceived(room.id, id).catch((err) => void this.d.log(`team: forgetting the changes ${r.title} got from a member who left`, err)));
    }
    for (const a of this.incoming.values()) if (a.roomId === room.id && a.from === member) a.decide("gone");
    for (const [sessionId, peers] of this.held) if (this.local(room.id).own[sessionId]) peers.delete(member);
    this.changed();
  }

  /**
   * This install left the room (or was removed): its own backups go from
   * origin, where it pushed them (best effort: what fails is returned, not hidden), every hidden ref
   * of the room goes from the repositories this Mac knows (backups, copies
   * from teammates and origin, what left copies kept and sent), and so does
   * what this service held. The room's folder — records, conversations,
   * received patches — is deleted by the caller afterwards. Resolves with
   * what couldn't be cleaned up.
   */
  async roomLeft(room: RoomState): Promise<string[]> {
    const problems: string[] = [];
    const local = this.local(room.id);
    // the conversations saved at its take-overs, before the room's folder (and their record) goes
    try {
      this.adoptSaved(room);
    } catch (err) {
      this.d.log(`team: finding conversations saved at take-overs in room ${room.id}`, err);
    }
    for (const [worktree, rec] of Object.entries(local.saved)) {
      const failed = this.removeSaved(room.id, worktree, "this Mac left the room");
      if (failed) problems.push(`The conversation of “${rec.title}” saved at its take-over couldn't be deleted from ${path.join(worktree, TAKEOVER_TRANSCRIPT_DIR)}: ${failed}`);
    }
    const owned = Object.entries(local.own);
    // a push under way would bring the ref back (later turns aren't backed up: the session isn't the room's any more)
    for (const [sessionId] of owned) await this.backups.get(sessionId)?.done;
    const toOrigin = this.toOriginFor(room.id);
    for (const [sessionId, rec] of owned) {
      if (!toOrigin && !rec.pushed) continue; // kept peer to peer: nothing of it on origin
      const ref = roomBackupRef(room.id, sessionId);
      if (!fs.existsSync(rec.repo)) {
        if (rec.pushed) problems.push(`The backup of “${rec.title}” may still be on origin (${ref}): its repository ${rec.repo} isn't on this Mac any more`);
        continue;
      }
      try {
        await this.deleteOnOrigin(rec.repo, ref);
      } catch (err) {
        const why = withoutCredentials(err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim().slice(0, 300);
        this.d.log(`team: deleting the backup of session ${sessionId} from origin after leaving the room`, why);
        problems.push(`The backup of “${rec.title}” couldn't be deleted from origin (${ref}): ${why}`);
      }
    }
    const repos = new Set([...this.d.repos(), ...owned.map(([, r]) => r.repo), ...Object.values(local.mirrored).map((r) => r.repo), ...Object.values(local.left).map((r) => r.repo)]);
    for (const repo of repos) {
      if (!fs.existsSync(repo)) continue;
      try {
        const refs = (await git(repo, ["for-each-ref", "--format=%(refname)", ...[ROOM_REF_ROOT, ORIGIN_COPY_ROOT, LEFT_ROOT, SENT_ROOT].map((root) => `${root}/${room.id}/`)])).split("\n").filter(Boolean);
        for (const r of refs) await git(repo, ["update-ref", "-d", r]);
      } catch (err) {
        const why = withoutCredentials(err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim().slice(0, 300);
        this.d.log(`team: deleting the room's hidden refs in ${repo}`, why);
        problems.push(`The room's hidden refs in ${repo} couldn't be deleted: ${why}`);
      }
    }
    for (const a of this.incoming.values()) if (a.roomId === room.id) a.decide("gone");
    const sessions = new Set([...owned.map(([id]) => id), ...Object.keys(local.mirrored), ...Object.keys(local.left), ...Object.values(local.received).map((r) => r.sessionId)]);
    for (const m of [this.unbacked, this.cleanupProblems]) for (const [k, v] of m) if (v.roomId === room.id) m.delete(k);
    for (const id of sessions) {
      this.problems.delete(id);
      this.unsent.delete(id);
      this.lastPublished.delete(id);
      this.held.delete(id);
    }
    this.locals.delete(room.id);
    this.presence.delete(room.id);
    this.originSetting.delete(room.id);
    if (this.consents[room.id]) {
      delete this.consents[room.id];
      try {
        this.saveConsents();
      } catch (err) {
        problems.push(`Your answer about backing up this room's sessions to origin couldn't be forgotten: ${this.d.log(`team: forgetting the backup answer for room ${room.id}`, err)}`);
      }
    }
    this.changed();
    return problems;
  }

  /**
   * Set origin's backup ref, only if it still holds what this install last
   * put there. The repository's pre-push hook runs, as for any push: a secret
   * scanner sees the snapshot first, and one that refuses it fails the push,
   * which the session's backup shows.
   */
  private async push(top: string, ref: string, rec: OwnRecord, sessionId: string): Promise<PushOutcome> {
    const lease = (expect: string) => git(top, ["push", "--quiet", `--force-with-lease=${ref}:${expect}`, "origin", `${rec.sha}:${ref}`], { timeoutMs: this.d.pushTimeoutMs ?? 60_000 });
    const onOrigin = async () => (await git(top, ["ls-remote", "origin", ref], { timeoutMs: this.d.fetchTimeoutMs ?? 30_000 })).split("\t")[0];
    try {
      try {
        // without a record (a lost takeover.json), origin's value is the session's own earlier backup
        await lease(rec.pushed ?? (await onOrigin()));
      } catch (err) {
        // origin moved on from the recorded value (a push that timed out here but landed there):
        // carry on only from an earlier snapshot of this same session
        if (!/stale info/i.test((err as Error).message)) throw err;
        const there = await onOrigin();
        if (!there || !(await isSnapshotOf(top, there, sessionId))) throw err;
        await lease(there);
      }
      return { ok: true, at: this.now() };
    } catch (err) {
      const error = withoutCredentials((err as Error).message).replace(/\s+/g, " ").trim().slice(0, 300);
      this.d.log(`team: pushing the backup of session ${sessionId} to origin`, error);
      return { ok: false, at: this.now(), error };
    }
  }

  // ---- mirroring to teammates (owner) -----------------------------------------------------

  /** Send a session's newest snapshot and conversation to one teammate, in the background. */
  private mirror(peer: MemberId, roomId: RoomId, sessionId: string): void {
    this.track(
      this.coalesce(this.mirrors, `${peer}\n${sessionId}`, async () => {
        if (this.closed || this.d.team.room(roomId)?.ext.takeover?.sessions[sessionId]?.takenOver) return;
        const failures: string[] = [];
        for (const [what, send] of [
          ["the snapshot", () => this.sendSnapshot(peer, roomId, sessionId)],
          ["the conversation", () => this.sendTranscript(peer, roomId, sessionId)],
        ] as const) {
          try {
            await send();
          } catch (err) {
            failures.push(`sending ${what} to ${this.nameOf(roomId, peer)} failed: ${(err as Error).message}`);
          }
        }
        if (failures.length) {
          this.d.log(`team: session ${sessionId}`, failures.join("; "));
          this.problems.set(sessionId, failures.join("; "));
        } else this.problems.delete(sessionId);
        this.changed();
      })
    );
  }

  /** Copy a session's newest snapshot into a teammate's clone; true once their clone holds it, false when there's nothing to send or they have no clone. */
  private async sendSnapshot(peer: MemberId, roomId: RoomId, sessionId: string): Promise<boolean> {
    const rec = this.local(roomId).own[sessionId];
    const s = this.d.host.session(sessionId);
    if (!rec || !s) return false;
    const top = await repoTop(s.cwd);
    const url = top && (await originUrl(top));
    if (!top || !url) return false;
    const ref = roomBackupRef(roomId, sessionId);
    const candidates = [rec.parent, ...(await git(top, ["for-each-ref", `--count=${MAX_CANDIDATES}`, "--sort=-committerdate", "--format=%(objectname)", "refs/remotes/origin"])).split("\n")].filter(
      (c): c is string => !!c && SHA_RE.test(c)
    );
    const r = await this.d.team.request<{ repo: boolean; have: string[]; current: string | null }>(
      peer,
      "takeover.have",
      { roomId, sessionId, originUrl: publicUrl(url), candidates: [rec.sha, ...new Set(candidates)] },
      { roomId, timeoutMs: SEND_TIMEOUT_MS }
    );
    const toOrigin = this.toOriginFor(roomId);
    if (!r?.repo) {
      const k = `${peer}\n${repoIdentity(url)}`;
      const then = toOrigin ? "they'll take it over from origin's backup" : "they can't take it over until they clone it (this room keeps backups off origin)";
      if (!this.noClone.has(k)) this.d.log(`team: session ${sessionId}`, `${this.nameOf(roomId, peer)} has no clone of ${publicUrl(url)}: ${then}`);
      this.noClone.add(k);
      return false;
    }
    const current = typeof r.current === "string" ? r.current : null;
    if (current === rec.sha) {
      this.holds(sessionId, peer, rec.sha);
      return true;
    }
    const have = Array.isArray(r.have) ? r.have.filter((h): h is string => typeof h === "string" && SHA_RE.test(h)) : [];
    let bundle: string | null = null;
    if (!have.includes(rec.sha)) {
      // their copy of an earlier snapshot holds this one's history too, when it's still here
      const exclude = [...have, ...(current ? await hasCommits(top, [current]) : [])];
      const tmp = path.join(os.tmpdir(), `mb-room-${crypto.randomBytes(6).toString("hex")}.bundle`);
      try {
        await git(top, ["bundle", "create", tmp, ref, ...exclude.map((h) => `^${h}`)]);
        const { size } = await fs.promises.stat(tmp);
        if (size > MAX_BUNDLE) {
          throw new Error(`the snapshot and what their clone lacks come to ${mb(size)}, over the ${mb(MAX_BUNDLE)} sent peer to peer: ${toOrigin ? "origin's backup has it" : "this room keeps backups off origin, so it reaches them once less of it is new to their clone (push the branch; they fetch)"}`);
        }
        bundle = (await fs.promises.readFile(tmp)).toString("base64");
      } finally {
        await fs.promises.rm(tmp, { force: true });
      }
    }
    await this.d.team.request(peer, "takeover.snapshot", { roomId, sessionId, sha: rec.sha, originUrl: publicUrl(url), bundle }, { roomId, timeoutMs: SEND_TIMEOUT_MS });
    this.holds(sessionId, peer, rec.sha);
    return true;
  }

  /** A teammate's clone holds snapshot `sha` of this install's session. */
  private holds(sessionId: string, peer: MemberId, sha: string): void {
    let peers = this.held.get(sessionId);
    if (!peers) this.held.set(sessionId, (peers = new Map()));
    if (peers.get(peer) === sha) return;
    peers.set(peer, sha);
    this.changed();
  }

  /** The conversation's bytes the teammate lacks, from where they are; a gap or a rewrite starts over from what they hold. */
  private async sendTranscript(peer: MemberId, roomId: RoomId, sessionId: string): Promise<void> {
    const s = this.d.host.session(sessionId);
    const conv = s && conversationOf(s);
    if (!s || !conv) return;
    const file = this.ownTranscript(conv.agent, conv.id, s.cwd);
    if (!file) return;
    const key = `${peer}\n${sessionId}\n${conv.id}`;
    const size = (await fs.promises.stat(file)).size;
    let at = this.transcriptAt.get(key) ?? 0;
    let probe = !this.transcriptAt.has(key); // what they hold is unknown: ask before sending
    let reset = false;
    for (let i = 0; i < 1000; i++) {
      const len = probe ? 0 : Math.max(0, Math.min(TRANSCRIPT_CHUNK, size - at));
      const data = len ? await readBytes(file, at, len) : Buffer.alloc(0);
      // ownerCwd as the CLI records it (symbolic links resolved); the backup's descriptor has the folder as Mockingbird named it: a take-over moves the transcript from either
      const r = await this.d.team.request<{ have: number }>(
        peer,
        "takeover.transcript",
        { roomId, sessionId, agent: conv.agent, conversationId: conv.id, file: path.basename(file), ownerCwd: realpathOr(s.cwd), offset: at, data: data.toString("base64"), total: size, ...(reset ? { reset: true } : {}) },
        { roomId, timeoutMs: SEND_TIMEOUT_MS }
      );
      probe = reset = false;
      if (!Number.isSafeInteger(r?.have) || r.have < 0) throw new Error(`${this.nameOf(roomId, peer)} answered with a bad offset`);
      if (r.have > size) {
        // they hold more than there is: this file was rewritten, so theirs starts over
        at = 0;
        reset = true;
        continue;
      }
      at = r.have;
      this.transcriptAt.set(key, at);
      if (at >= size) return;
    }
    throw new Error("the conversation's copy didn't catch up after 1000 sends");
  }

  private onPresence(roomId: RoomId, online: MemberId[]): void {
    const before = this.presence.get(roomId) ?? new Set<MemberId>();
    this.presence.set(roomId, new Set(online));
    this.connections.update(roomId, online);
    // a teammate who asked for a session and went away can't hear the answer: their request lapses
    for (const a of this.incoming.values()) if (a.roomId === roomId && a.state === "waiting" && !online.includes(a.from)) a.decide("gone");
    // a teammate who reconnects is asked what they hold again
    for (const k of [...this.transcriptAt.keys()]) if (!online.includes(k.split("\n")[0]) && before.has(k.split("\n")[0])) this.transcriptAt.delete(k);
    // who's online is part of the view: Take over leads while a session's owner is away
    this.changed();
    const fresh = online.filter((p) => !before.has(p));
    if (!fresh.length) return;
    for (const sessionId of Object.keys(this.local(roomId).own)) {
      if (this.d.host.roomOf(sessionId) !== roomId || !this.d.host.session(sessionId)) continue;
      for (const peer of fresh) this.mirror(peer, roomId, sessionId);
    }
  }

  // ---- receiving (teammate) ----------------------------------------------------------------

  /** Which of the offered commits this Mac's clone has, and the snapshot it holds now. */
  private async onHave(p: any, ctx: RequestContext): Promise<{ repo: boolean; have: string[]; current: string | null }> {
    const { roomId, sessionId } = this.requestFor(p, ctx);
    const clone = await this.cloneFor(text(p.originUrl, "originUrl", 500, 1));
    if (!clone) return { repo: false, have: [], current: null };
    const ref = roomBackupRef(roomId, sessionId);
    const current = (await git(clone, ["rev-parse", "--verify", "-q", ref], { okCodes: [0, 1] })) || null;
    const offered = (Array.isArray(p.candidates) ? p.candidates : []).slice(0, MAX_CANDIDATES + 1).filter((c: unknown): c is string => typeof c === "string" && SHA_RE.test(c));
    return { repo: true, have: await hasCommits(clone, offered), current };
  }

  /** A teammate's snapshot: imported into this Mac's clone under the session's backup ref. */
  private async onSnapshot(p: any, ctx: RequestContext): Promise<{ sha: string }> {
    const { roomId, sessionId } = this.requestFor(p, ctx);
    const url = text(p.originUrl, "originUrl", 500, 1);
    const clone = await this.cloneFor(url);
    if (!clone) throw new PeerError(`there's no clone of ${url} on this Mac`);
    const ref = roomBackupRef(roomId, sessionId);
    const want = sha(p.sha);
    if (typeof p.bundle === "string" && p.bundle) {
      const bytes = Buffer.from(p.bundle, "base64");
      if (bytes.length > MAX_BUNDLE) {
        this.d.team.refusedOverLimit?.(roomId, ctx.from, "snapshot", `a ${mb(bytes.length)} session snapshot, over the ${mb(MAX_BUNDLE)} accepted`);
        throw new PeerError(`a ${mb(bytes.length)} snapshot is over the ${mb(MAX_BUNDLE)} accepted`);
      }
      const tmp = path.join(os.tmpdir(), `mb-room-${crypto.randomBytes(6).toString("hex")}.bundle`);
      await fs.promises.writeFile(tmp, bytes, { mode: 0o600 });
      try {
        // the bundle's objects only: the ref is set to the commit named, never to whatever the bundle's own ref says
        await git(clone, ["fetch", "--no-tags", "--no-write-fetch-head", tmp, ref]);
      } finally {
        await fs.promises.rm(tmp, { force: true });
      }
    }
    // a commit's id is the hash of its content: the one named, present here, is exactly the snapshot sent
    if (!(await hasCommits(clone, [want])).length) {
      this.d.log(`team: session ${sessionId}`, `the snapshot ${this.nameOf(roomId, ctx.from)} sent doesn't hold the commit it named (${want.slice(0, 8)}): refused`);
      throw new PeerError(`snapshot ${want.slice(0, 8)} isn't in this Mac's clone${p.bundle ? " (the bundle didn't hold it)" : ""}`);
    }
    await git(clone, ["update-ref", ref, want]);
    const got = want;
    const signed = this.d.team.room(roomId)?.ext.takeover?.sessions[sessionId];
    const takenAt = signed?.latest.sha === got ? signed.latest.takenAt : await takenAtOf(clone, got);
    this.saveMirror(roomId, sessionId, { sha: got, takenAt, repo: clone, from: ctx.from, at: this.now() });
    this.changed();
    return { sha: got };
  }

  /** New bytes of a teammate's conversation: appended when they start where this copy ends; either way, what's held is answered. */
  private async onTranscript(p: any, ctx: RequestContext): Promise<{ have: number }> {
    const { roomId, sessionId } = this.requestFor(p, ctx);
    const agent = agentOf(p.agent);
    const conversationId = text(p.conversationId, "conversationId", 100, 1);
    if (!CONV_ID_RE.test(conversationId)) throw new PeerError("bad conversation id");
    const file = text(p.file, "file", 200, 1);
    const named = agent === "codex" ? ROLLOUT_NAME_RE.exec(file)?.[1] : file === `${conversationId}.jsonl` ? conversationId : null;
    if (named !== conversationId) throw new PeerError(`${file} isn't conversation ${conversationId}'s transcript`);
    if (!Number.isSafeInteger(p.offset) || p.offset < 0 || !Number.isSafeInteger(p.total) || p.total < 0) throw new PeerError("bad offset");
    const data = text(p.data, "data", Math.ceil(TRANSCRIPT_CHUNK / 3) * 4 + 4);
    const ownerCwd = text(p.ownerCwd, "ownerCwd", 1000, 1);
    const dir = this.transcriptDir(roomId, sessionId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, file);
    if (p.reset === true && p.offset === 0) await fs.promises.rm(target, { force: true });
    let have = await fileSize(target);
    if (p.offset !== have) return { have };
    const bytes = Buffer.from(data, "base64");
    const over = transcriptRefusal(path.dirname(dir), target, ctx.from, have, bytes.length);
    if (over) {
      this.d.team.refusedOverLimit?.(roomId, ctx.from, "transcript", over);
      throw new PeerError(`refused: ${over} (this Mac's limit)`);
    }
    if (bytes.length) await fs.promises.appendFile(target, bytes, { mode: 0o600 });
    have += bytes.length;
    const meta: TranscriptMeta = { agent, conversationId, file, ownerCwd, total: Math.max(p.total, have), from: ctx.from, updatedAt: this.now() };
    writeFileAtomic(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), 0o600);
    this.changed();
    return { have };
  }

  /** A request's room and session, refused when it doesn't come from the session's owner. */
  private requestFor(p: any, ctx: RequestContext): { roomId: RoomId; sessionId: string } {
    if (!p || typeof p !== "object") throw new PeerError("no parameters");
    // the transport checked membership of the room the request named: it must be this one
    if (!ctx.roomId || p.roomId !== ctx.roomId) throw new PeerError("the request doesn't name its room");
    const sessionId = sessionIdOf(p.sessionId);
    const known = this.d.team.room(ctx.roomId)?.ext.takeover?.sessions[sessionId];
    if (known && known.owner !== ctx.from) throw new PeerError(`session ${sessionId} isn't ${this.nameOf(ctx.roomId, ctx.from)}'s`);
    if (known?.takenOver) throw new PeerError(`session ${sessionId} was taken over`);
    return { roomId: ctx.roomId, sessionId };
  }

  private onTakenOver(e: RoomEvent<"session.takenOver">, room: RoomState): void {
    const s = room.ext.takeover?.sessions[e.body.sessionId];
    // only the take-over the room settled on counts: one its owner granted
    if (s?.takenOver?.by === e.author && e.body.from === this.d.team.self.id) {
      // taken while this Mac was offline (or under an away grant): unless it was connected to the taker then, after all
      if (ownerChecks(s.takenOver) && this.refuseOffline(room, s)) return this.changed();
      // TODO(audit-log): a teammate took over this install's session, with its grant (s.takenOver.grant)
      this.honour(room, e.body.sessionId, e.author);
    } else if (s && !s.takenOver && s.ungranted?.by === e.author && s.owner === this.d.team.self.id && e.body.from === s.owner) {
      this.refuse(room, s, e);
    }
    this.changed();
  }

  /** A take-over of this install's session that counts: its agent stops here for good. */
  private honour(room: RoomState, sessionId: string, by: MemberId): void {
    const s = room.ext.takeover?.sessions[sessionId];
    this.leave(room.id, sessionId);
    // whoever continues it now has the conversation: this copy's agent has stopped and needs it no more
    this.removeSavedFor(sessionId, `“${s?.session.title ?? sessionId}” was taken over by ${this.nameOf(room.id, by)}`);
    try {
      this.d.onTakenOver?.(sessionId, this.nameOf(room.id, by));
    } catch (err) {
      this.d.log(`team: telling about the take-over of session ${sessionId}`, err);
    }
  }

  /**
   * A teammate's take-over of this install's session without its signed
   * consent: nothing stops here. Logged, kept in the view, and said once in
   * the room's chat — the only way to reach an older Mockingbird, which
   * believes it took the session over.
   */
  private refuse(room: RoomState, s: RoomSessionBackup, e: RoomEvent<"session.takenOver">): void {
    const local = this.local(room.id);
    const key = `${s.sessionId}\n${e.author}`;
    if (local.refused?.[key]) return;
    const me = this.nameOf(room.id, this.d.team.self.id);
    const by = this.nameOf(room.id, e.author);
    const why =
      e.body.grant === undefined
        ? `${by}'s Mockingbird needs to update to take over: take-overs now need ${me}'s signed hand-over`
        : `${by}'s take-over carried no valid grant from ${me} (${grantProblem(room, e.body.grant, { owner: s.owner, ownerName: me, sessionId: s.sessionId, taker: e.author, at: e.at, sha: e.body.snapshot.sha })})`;
    // TODO(audit-log): a take-over of this install's session refused for want of a grant (who, which session, why)
    this.d.log(`team: refused ${by}'s take-over of session ${s.sessionId}`, why);
    (local.refused ??= {})[key] = { sessionId: s.sessionId, by: e.author, title: s.session.title, at: this.now(), why };
    this.saveLocal(room.id);
    try {
      this.d.chat(room.id, `“${s.session.title}” keeps running on ${me}'s laptop: ${why}. Ask ${me} to hand it over.`);
    } catch (err) {
      this.d.log(`team: telling room ${room.id} a take-over was refused`, err);
    }
  }

  /**
   * An offline or away-granted take-over (ownerChecks) of this install's
   * session `s`: refused — the room told, so every member puts the session
   * back, and this Mac's agent never stopped — when this Mac was connected to
   * the taker at the take-over's time, or it's stamped before the snapshot it
   * continues from was taken. True when refused.
   */
  private refuseOffline(room: RoomState, s: RoomSessionBackup): boolean {
    const t = s.takenOver;
    if (!t || !ownerChecks(t) || s.owner !== this.d.team.self.id) return false;
    // the snapshot's time as this Mac signed it, when it's the newest; else as the taker says
    const snapshotAt = s.latest.sha === t.snapshot.sha ? s.latest.takenAt : t.snapshot.takenAt;
    const reason = offlineTakeoverRefusal({ at: t.at, snapshotAt, connected: this.connections.spans(room.id, t.by), skew: this.offlineSkewMs });
    if (!reason) return false;
    const me = this.nameOf(room.id, this.d.team.self.id);
    const by = this.nameOf(room.id, t.by);
    const why = reason === "connected" ? `${me}'s Mac was connected to ${by}'s then, so ${by} should have asked` : `it's dated before the snapshot it continues from`;
    // TODO(audit-log): an offline take-over of this install's session refused (who, which session, why)
    const kind = t.grant === "away" ? "take-over (under a 1.5 away grant)" : "offline take-over";
    this.d.log(`team: refused ${by}'s ${kind} of session ${s.sessionId}`, why);
    try {
      this.d.team.publish(room.id, "session.takeoverRefused", { sessionId: s.sessionId, by: t.by, newSessionId: t.newSessionId, reason });
    } catch (err) {
      // the room still holds the take-over: this copy stops like any other's, rather than run beside the taker's
      this.d.log(`team: refusing ${by}'s ${kind} of session ${s.sessionId}`, err);
      return false;
    }
    try {
      this.d.chat(room.id, `“${s.session.title}” stays on ${me}'s laptop: ${by}'s take-over was refused (${why}). Ask ${me} to hand it over.`);
    } catch (err) {
      this.d.log(`team: telling room ${room.id} that ${by}'s ${kind} was refused`, err);
    }
    // the turns made while the room held the take-over weren't backed up: back up now
    if (this.d.host.session(s.sessionId)) void this.track(this.turnEnded(s.sessionId));
    return true;
  }

  /** The owner refused an offline take-over: when it was this install's, the copy it started stops. */
  private onRefusedEvent(e: RoomEvent<"session.takeoverRefused">, room: RoomState): void {
    const s = room.ext.takeover?.sessions[e.body.sessionId];
    const counted = s?.refusals?.some((r) => r.by === e.body.by && r.newSessionId === e.body.newSessionId && e.author === s.owner);
    if (s && counted && e.body.by === this.d.team.self.id) this.stopRefused(room, s, e.body.newSessionId, true);
    this.changed();
  }

  /** This install's copy from a refused take-over: its agent stops, its folder stays as it is, and its backup goes. */
  private stopRefused(room: RoomState, s: RoomSessionBackup, newSessionId: string, tell: boolean): void {
    const running = this.d.host.session(newSessionId);
    try {
      this.d.host.stop(newSessionId);
    } catch (err) {
      this.d.log(`team: stopping session ${newSessionId}, whose take-over ${this.nameOf(room.id, s.owner)} refused`, err);
    }
    const own = this.local(room.id).own[newSessionId];
    const mine = room.ext.takeover?.sessions[newSessionId];
    if (own && mine?.owner === this.d.team.self.id && !mine.dropped) {
      void this.track(this.dropBackup(room.id, newSessionId, "closed", own.repo, mine.session.title).catch((err) => this.cleanupFailed(room.id, newSessionId, mine.session.title, err)));
    }
    if (!tell || !running) return;
    try {
      this.d.onRefused?.(newSessionId, this.nameOf(room.id, s.owner), s.session.title);
    } catch (err) {
      this.d.log(`team: telling about the refused take-over of session ${s.sessionId}`, err);
    }
  }

  /** The owner accepted a take-over from before grants: the same as any take-over that counts. */
  private onAccepted(e: RoomEvent<"session.takeoverAccepted">, room: RoomState): void {
    const s = room.ext.takeover?.sessions[e.body.sessionId];
    if (s?.takenOver?.grant === "accepted" && s.owner === this.d.team.self.id && e.author === s.owner) this.honour(room, e.body.sessionId, s.takenOver.by);
    this.changed();
  }

  // ---- the copy left behind (owner) ------------------------------------------------------------

  /**
   * A teammate continues this install's session `sessionId`: its agent stops
   * here at once, its folder untouched, and what it has that they lack is
   * counted. Idempotent: run for every take-over heard and on start.
   */
  private leave(roomId: RoomId, sessionId: string): void {
    try {
      this.d.host.stop(sessionId);
    } catch (err) {
      this.d.log(`team: stopping session ${sessionId}, which a teammate continues`, err);
    }
    void this.track(
      this.recordLeft(roomId, sessionId).catch((err) => {
        const error = withoutCredentials((err as Error).message);
        this.d.log(`team: keeping track of session ${sessionId}, which a teammate continues`, error);
        this.unsent.set(sessionId, { error });
        this.changed();
      })
    );
  }

  private async recordLeft(roomId: RoomId, sessionId: string): Promise<void> {
    const entry = this.d.team.room(roomId)?.ext.takeover?.sessions[sessionId];
    if (!entry?.takenOver || entry.owner !== this.d.team.self.id) return;
    const local = this.local(roomId);
    if (!local.left[sessionId]) {
      const s = this.d.host.session(sessionId);
      if (!s) return; // closed for good before the take-over reached this Mac: nothing of it is left here
      const repo = s.repoPath ?? local.own[sessionId]?.repo ?? s.cwd;
      const base = entry.takenOver.snapshot.sha;
      local.left[sessionId] = { base, repo, cwd: s.cwd, title: entry.session.title, at: this.now() };
      this.saveLocal(roomId);
      this.changed();
      // the snapshot they continued from outlives its backup ref, which is deleted once they back up theirs
      const pin = roomBackupRef(roomId, sessionId, LEFT_ROOT);
      if (!(await hasCommits(repo, [base])).length && backupsToOrigin(this.d.team.room(roomId))) {
        try {
          await git(repo, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", `+${roomBackupRef(roomId, sessionId)}:${pin}`], { timeoutMs: this.d.fetchTimeoutMs ?? 30_000 });
        } catch (err) {
          this.d.log(`team: fetching the snapshot session ${sessionId} was continued from`, err);
        }
      }
      if ((await hasCommits(repo, [base])).length) await git(repo, ["update-ref", pin, base]);
    }
    await this.checkLeft(roomId, sessionId);
  }

  /** Count what a left copy has that whoever continues it lacks: its files against the snapshot they continued from (or what was last sent them). */
  checkLeft(roomId: RoomId, sessionId: string): Promise<void> {
    return this.coalesce(this.checks, sessionId, async () => {
      const rec = this.local(roomId).left[sessionId];
      if (!rec) return;
      const by = this.continuedBy(roomId, sessionId);
      try {
        if (!fs.existsSync(rec.cwd)) throw new Error(`its folder ${rec.cwd} isn't there any more`);
        const top = await repoTop(rec.cwd);
        if (!top) throw new Error(`${rec.cwd} isn't in a git repository any more`);
        const base = rec.sent?.sha ?? rec.base;
        if (!(await hasCommits(top, [base])).length) throw new Error(`the snapshot ${by} continued from (${base.slice(0, 8)}) isn't in this clone, so what they lack can't be told`);
        const now = await worktreeTree(top, { secrets: secretPathspecs(top, this.d.secretFiles?.() ?? []), base });
        const files = await changedFiles(top, `${base}^{tree}`, now!.tree);
        this.unsent.set(sessionId, { files: files.map((f) => f.path), checkedAt: this.now() });
      } catch (err) {
        const error = withoutCredentials((err as Error).message).replace(/\s+/g, " ").trim().slice(0, 300);
        const before = this.unsent.get(sessionId);
        // counted again every minute: the same failure is logged once, and shown on the copy all along
        if (!before || !("error" in before) || before.error !== error) this.d.log(`team: counting what session ${sessionId}'s copy has that ${by} lacks`, error);
        this.unsent.set(sessionId, { error });
      }
      this.changed();
    });
  }

  /**
   * Send a left copy's changes (since the snapshot the teammate continued
   * from, or since the last send) to whoever runs the session now: a patch
   * that lands on their session to review and apply. Secrets, ignored and
   * big files are left out, as in backups. A line in the room's chat says so.
   */
  async sendLeft(roomId: RoomId, sessionId: string): Promise<{ files: number }> {
    if (this.sending.has(sessionId)) throw new Error("Those changes are already being sent");
    const rec = this.local(roomId).left[sessionId];
    if (!rec) throw new Error("That session wasn't continued by a teammate");
    const room = this.d.team.room(roomId);
    const now = continuation(room?.ext.takeover, sessionId);
    if (!room || !now) throw new Error("That session wasn't continued by a teammate");
    const name = this.nameOf(roomId, now.owner);
    if (now.owner === this.d.team.self.id) throw new Error("It continues on this Mac now: there's no one to send it to");
    if (!this.d.team.presence(roomId).includes(now.owner)) throw new Error(`${name} is offline — send it once they're back`);
    this.sending.add(sessionId);
    this.changed();
    try {
      const top = await repoTop(rec.cwd);
      if (!top) throw new Error(`${rec.cwd} isn't in a git repository any more`);
      const base = rec.sent?.sha ?? rec.base;
      if (!(await hasCommits(top, [base])).length) throw new Error(`The snapshot ${name} continued from (${base.slice(0, 8)}) isn't in this clone, so what they lack can't be told`);
      const me = this.nameOf(roomId, this.d.team.self.id);
      const commit = await worktreeCommitOn(top, base, `Mockingbird: ${me}'s changes to “${rec.title}” after ${name} continued it\n\nfrom-session: ${sessionId}`, {
        secrets: secretPathspecs(top, this.d.secretFiles?.() ?? []),
      });
      const files = await changedFiles(top, base, commit.sha);
      if (!files.length) throw new Error(`Nothing to send: ${name} has everything in this copy`);
      const patch = await gitBytes(top, ["diff", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", base, commit.sha]);
      if (patch.length > MAX_BUNDLE) throw new Error(`The changes come to ${mb(patch.length)}, over the ${mb(MAX_BUNDLE)} sent peer to peer`);
      await this.d.team.request(now.owner, "takeover.changes", { roomId, sessionId, title: rec.title, files, patch: patch.toString("base64") }, { roomId, timeoutMs: SEND_TIMEOUT_MS });
      await git(top, ["update-ref", roomBackupRef(roomId, sessionId, SENT_ROOT), commit.sha]);
      rec.sent = { sha: commit.sha, at: this.now(), files: files.length };
      this.saveLocal(roomId);
      this.unsent.set(sessionId, { files: [], checkedAt: this.now() });
      const n = files.length === 1 ? "1 changed file" : `${files.length} changed files`;
      try {
        this.d.chat(roomId, `Sent ${name} ${n} from my copy of “${rec.title}”, made after the snapshot they continued from. They're on ${name}'s session to review and apply.`);
      } catch (err) {
        this.d.log(`team: telling room ${roomId} the changes to session ${sessionId} were sent`, err);
      }
      return { files: files.length };
    } finally {
      this.sending.delete(sessionId);
      this.changed();
    }
  }

  /** Who continues a session of this install's, by name. */
  private continuedBy(roomId: RoomId, sessionId: string): string {
    const now = continuation(this.d.team.room(roomId)?.ext.takeover, sessionId);
    return now ? this.nameOf(roomId, now.owner) : "the teammate";
  }

  /**
   * Why one of this install's sessions mustn't run again here, nor be handed on, reviewed or have its files put back
   * (`doing`, said in the refusal): a teammate continues it (or it was taken back into another session). Null when it
   * may.
   */
  relaunchRefusal(sessionId: string, doing = "running this copy again"): string | null {
    for (const room of this.d.team.rooms()) {
      const e = room.ext.takeover?.sessions[sessionId];
      if (!e?.takenOver || e.owner !== this.d.team.self.id) continue;
      const now = continuation(room.ext.takeover, sessionId);
      if (now?.owner === this.d.team.self.id) return `“${e.session.title}” was taken back into another session here: this copy doesn't run again`;
      return `“${e.session.title}” continues on ${this.nameOf(room.id, now?.owner ?? e.takenOver.by)}'s laptop — take it back rather than ${doing}`;
    }
    // this install's copy from a take-over its owner refused: the session stayed theirs
    for (const room of this.d.team.rooms()) {
      for (const e of Object.values(room.ext.takeover?.sessions ?? {})) {
        if (!e.refusals?.some((r) => r.by === this.d.team.self.id && r.newSessionId === sessionId)) continue;
        return `${this.nameOf(room.id, e.owner)}'s Mac refused this take-over of “${e.session.title}”: the session stayed theirs, and this copy doesn't run`;
      }
    }
    return null;
  }

  // ---- changes sent from a left copy (taker) ------------------------------------------------------

  /** A teammate's changes from their copy of a session this install continues: kept as a patch to review and apply. */
  private async onChanges(p: any, ctx: RequestContext): Promise<{ id: string }> {
    if (!p || typeof p !== "object") throw new PeerError("no parameters");
    if (!ctx.roomId || p.roomId !== ctx.roomId) throw new PeerError("the request doesn't name its room");
    const roomId = ctx.roomId;
    const fromSessionId = sessionIdOf(p.sessionId);
    const room = this.d.team.room(roomId);
    const entry = room?.ext.takeover?.sessions[fromSessionId];
    if (!entry || entry.owner !== ctx.from || !entry.takenOver) throw new PeerError(`session ${fromSessionId} isn't a session of ${this.nameOf(roomId, ctx.from)}'s that was continued`);
    const now = continuation(room!.ext.takeover, fromSessionId);
    if (now?.owner !== this.d.team.self.id) throw new PeerError(`session ${fromSessionId} doesn't continue on this Mac`);
    if (!this.d.host.session(now.sessionId)) throw new PeerError(`the session that continues ${fromSessionId} isn't on this Mac any more`);
    const title = text(p.title, "title", 300);
    if (!Array.isArray(p.files) || !p.files.length || p.files.length > 10_000) throw new PeerError("files must be a list");
    const files: ChangedFile[] = p.files.map((f: any) => {
      if (!f || typeof f.path !== "string" || !f.path || f.path.length > 1000 || !["added", "modified", "deleted"].includes(f.status)) throw new PeerError("a file isn't a changed file");
      return { path: f.path, status: f.status };
    });
    const patch = Buffer.from(text(p.patch, "patch", Math.ceil(MAX_BUNDLE / 3) * 4 + 4, 1), "base64");
    if (!patch.length || patch.length > MAX_BUNDLE) throw new PeerError("the patch is empty or too big");
    const id = crypto.randomBytes(8).toString("hex");
    const dir = path.join(this.d.roomsDir, roomId, "received");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(path.join(dir, `${id}.patch`), patch, { mode: 0o600 });
    const rec: ReceivedRecord = { sessionId: now.sessionId, fromSessionId, from: ctx.from, title, files, bytes: patch.length, at: this.now(), applied: null };
    this.local(roomId).received[id] = rec;
    this.saveLocal(roomId);
    this.changed();
    try {
      this.d.onReceived?.(this.receivedView(roomId, id, rec));
    } catch (err) {
      this.d.log(`team: telling about the changes ${this.nameOf(roomId, ctx.from)} sent`, err);
    }
    return { id };
  }

  /** The patch of changes a teammate sent, to review (cut to REVIEW_MAX, saying so), and where it's kept. */
  async receivedPatch(roomId: RoomId, id: string): Promise<{ patch: string; truncated: boolean; file: string }> {
    this.received(roomId, id);
    const file = this.receivedFile(roomId, id);
    const bytes = await fs.promises.readFile(file);
    return { patch: bytes.subarray(0, REVIEW_MAX).toString("utf8"), truncated: bytes.length > REVIEW_MAX, file };
  }

  /**
   * Apply a teammate's changes to the worktree of the session they're for —
   * only when they apply cleanly to it as it is now, and after an Undo-turn
   * snapshot of it, so applying can be undone. Otherwise nothing changes and
   * the files in the way are named.
   */
  async applyReceived(roomId: RoomId, id: string): Promise<{ files: number }> {
    const rec = this.received(roomId, id);
    if (rec.applied) throw new Error("Those changes were applied already");
    const s = this.d.host.session(rec.sessionId);
    if (!s) throw new Error("The session they're for isn't on this Mac any more");
    const top = await repoTop(s.cwd);
    if (!top) throw new Error(`${s.cwd} isn't in a git repository`);
    const file = this.receivedFile(roomId, id);
    const patch = await fs.promises.readFile(file);
    try {
      await git(top, ["apply", "--check", "--binary", "-"], { input: patch });
    } catch (err) {
      const msg = (err as Error).message;
      const inTheWay = [...new Set([...msg.matchAll(/^error: (.+?): (?:patch does not apply|already exists in working directory|does not exist in working directory|No such file or directory)/gm)].map((m) => m[1]))];
      throw new Error(
        `They don't apply cleanly to this worktree, so nothing was changed${inTheWay.length ? ` — changed here too: ${inTheWay.join(", ")}` : `: ${msg.replace(/\s+/g, " ").slice(0, 300)}`}. To merge them by hand: git apply --3way ${file}`
      );
    }
    const before = await takeSnapshot(top, rec.sessionId, `(before applying ${this.nameOf(roomId, rec.from)}'s changes)`);
    if (!before) throw new Error(`Couldn't record ${top}'s files before applying, so nothing was changed`);
    await git(top, ["apply", "--binary", "-"], { input: patch });
    rec.applied = this.now();
    this.saveLocal(roomId);
    this.changed();
    return { files: rec.files.length };
  }

  /** Forget changes a teammate sent (applied or not): their patch goes. */
  async dismissReceived(roomId: RoomId, id: string): Promise<void> {
    this.received(roomId, id);
    await this.dropReceived(roomId, id);
  }

  private async dropReceived(roomId: RoomId, id: string): Promise<void> {
    await fs.promises.rm(this.receivedFile(roomId, id), { force: true });
    delete this.local(roomId).received[id];
    this.saveLocal(roomId);
    this.changed();
  }

  private received(roomId: RoomId, id: string): ReceivedRecord {
    if (typeof id !== "string" || !RECEIVED_ID_RE.test(id)) throw new Error("Not a set of changes");
    const rec = this.local(roomId).received[id];
    if (!rec) throw new Error("Those changes aren't here any more");
    return rec;
  }

  private receivedFile(roomId: RoomId, id: string): string {
    if (!RECEIVED_ID_RE.test(id)) throw new Error("Not a set of changes");
    return path.join(this.d.roomsDir, roomId, "received", `${id}.patch`);
  }

  private receivedView(roomId: RoomId, id: string, r: ReceivedRecord): ReceivedChanges {
    return { id, roomId, sessionId: r.sessionId, fromSessionId: r.fromSessionId, from: r.from, fromName: this.nameOf(roomId, r.from), title: r.title, files: r.files, bytes: r.bytes, at: r.at, applied: r.applied };
  }

  // ---- asking the owner first ---------------------------------------------------------------

  /**
   * A Mockingbird from before grants asks for a session: it would take it
   * over without the owner's signed hand-over, so it's refused, saying why.
   */
  private onUngrantedAsk(p: any, ctx: RequestContext): never {
    const roomId = ctx.roomId ?? "";
    const sessionId = typeof p?.sessionId === "string" && SESSION_ID_RE.test(p.sessionId) ? p.sessionId : null;
    const title = (sessionId && this.d.team.room(roomId)?.ext.takeover?.sessions[sessionId]?.session.title) || "this session";
    const me = this.nameOf(roomId, this.d.team.self.id);
    // TODO(audit-log): an older Mockingbird asked to take over a session of this install's: refused
    this.d.log(`team: refused ${this.nameOf(roomId, ctx.from)}'s request for session ${sessionId ?? "?"}`, "their Mockingbird asks without taking a signed hand-over: it needs an update");
    throw new PeerError(`${this.nameOf(roomId, ctx.from)} needs to update Mockingbird to take over “${title}”: take-overs now need ${me}'s signed hand-over`);
  }

  /**
   * A teammate asks to continue this install's session (its owner is online).
   * The owner is prompted; on Hand over the turn in progress finishes, the
   * session is backed up, that snapshot and the conversation are copied to
   * the teammate, and the agent stops here — then the answer names the
   * snapshot, with the owner's signed hand-over for it. Keep, no answer
   * within askMs, the teammate going away or this app closing leave the
   * session running here.
   */
  private async onAsk(p: any, ctx: RequestContext): Promise<AskAnswer> {
    if (!p || typeof p !== "object") throw new PeerError("no parameters");
    if (!ctx.roomId || p.roomId !== ctx.roomId) throw new PeerError("the request doesn't name its room");
    const roomId = ctx.roomId;
    const sessionId = sessionIdOf(p.sessionId);
    const askId = text(p.askId, "askId", 64, 16);
    if (!ASK_ID_RE.test(askId)) throw new PeerError("bad request id");
    const entry = this.d.team.room(roomId)?.ext.takeover?.sessions[sessionId];
    if (!entry || entry.owner !== this.d.team.self.id) throw new PeerError(`session ${sessionId} isn't this Mac's`);
    if (entry.takenOver) throw new PeerError(`${this.nameOf(roomId, entry.takenOver.by)} already continues it`);
    if (entry.dropped) throw new PeerError("its backup was deleted");
    if (!this.d.host.session(sessionId) || this.d.host.roomOf(sessionId) !== roomId) throw new PeerError("that session isn't on this Mac any more");
    if (this.incoming.has(askId)) throw new PeerError("that request is being answered already");
    const busy = [...this.incoming.values()].find((a) => a.sessionId === sessionId && a.state === "handing-over");
    if (busy) throw new PeerError(`it's being handed over to ${busy.fromName}`);
    const at = this.now();
    let decide!: (d: Decision) => void;
    const decided = new Promise<Decision>((resolve) => (decide = resolve));
    const ask: PendingAsk = { askId, roomId, sessionId, title: entry.session.title, from: ctx.from, fromName: this.nameOf(roomId, ctx.from), at, deadline: at + this.askMs, state: "waiting", decide };
    // TODO(audit-log): a teammate asked to take over this install's session
    this.incoming.set(askId, ask);
    const timer = setTimeout(() => decide("timeout"), this.askMs);
    this.changed();
    try {
      this.d.onAsk?.(askView(ask));
    } catch (err) {
      this.d.log(`team: telling about ${ask.fromName}'s request for session ${sessionId}`, err);
    }
    try {
      const d = await decided;
      clearTimeout(timer);
      if (d !== "handover") return d === "timeout" ? { answer: "timeout" } : { answer: "kept" };
      ask.state = "handing-over";
      this.changed();
      // anyone else asking for it is answered: it goes to this teammate
      for (const other of this.incoming.values()) if (other !== ask && other.sessionId === sessionId) other.decide("keep");
      this.d.team.request(ctx.from, "takeover.progress", { roomId, sessionId, askId, state: "handing-over" }, { roomId }).catch((err) => this.d.log(`team: telling ${ask.fromName} session ${sessionId} is being handed over`, err));
      return await this.handOver(roomId, sessionId, ctx.from);
    } finally {
      clearTimeout(timer);
      this.incoming.delete(askId);
      this.changed();
    }
  }

  /** The owner's answer to a teammate's request: hand the session over, or keep it. */
  answerAsk(askId: string, answer: "handover" | "keep"): void {
    const a = this.incoming.get(askId);
    if (!a || a.state !== "waiting") throw new Error("That request was withdrawn, answered, or timed out");
    a.decide(answer);
  }

  /** Let the turn in progress finish, back the session up, copy that to `to`, stop the agent: the snapshot `to` continues from. */
  private async handOver(roomId: RoomId, sessionId: string, to: MemberId): Promise<AskAnswer> {
    const deadline = Date.now() + this.handoverTurnMs;
    while (this.d.host.session(sessionId)?.status === "working") {
      if (this.closed) throw new PeerError("Mockingbird is quitting");
      if (Date.now() > deadline) throw new PeerError(`its turn didn't finish within ${Math.round(this.handoverTurnMs / 60_000)} minutes, so it carries on here`);
      await new Promise((r) => setTimeout(r, 250));
    }
    await this.turnEnded(sessionId);
    const unbacked = this.unbacked.get(sessionId);
    if (unbacked) {
      this.d.log(`team: handing session ${sessionId} over: it couldn't be backed up`, unbacked.problem);
      throw new PeerError("it couldn't be backed up (the reason is in their Mockingbird's log)");
    }
    const rec = this.local(roomId).own[sessionId];
    if (!rec) throw new PeerError("it couldn't be backed up");
    // a copy to them already under way finishes first; then make sure they hold exactly this snapshot and the whole conversation
    await this.mirrors.get(`${to}\n${sessionId}`)?.done;
    const delivered = await this.sendSnapshot(to, roomId, sessionId);
    await this.sendTranscript(to, roomId, sessionId);
    const toOrigin = this.toOriginFor(roomId);
    if (!delivered && (!toOrigin || rec.pushed !== rec.sha)) {
      throw new PeerError(`${this.nameOf(roomId, to)} has no clone of the repository to copy it into, ${toOrigin ? "and origin's backup didn't take it" : "and this session's backups stay off origin"}`);
    }
    // the owner's consent, for this teammate and exactly this snapshot: what lets the take-over count on every member
    const now = Date.now(); // checked against the take-over event's time: wall-clock
    const grant = signGrant(this.d.team, { kind: "handover", roomId, sessions: [sessionId], to, sha: rec.sha, issuedAt: now, expiresAt: now + HANDOVER_GRANT_MS });
    // TODO(audit-log): this install handed a session over (to whom, which snapshot)
    this.d.host.stop(sessionId);
    return { answer: "handed-over", sha: rec.sha, takenAt: rec.takenAt, grant };
  }

  /** The owner is handing over the session this install asked for. */
  private onProgress(p: any, ctx: RequestContext): { ok: true } {
    if (!p || typeof p !== "object" || typeof p.askId !== "string") throw new PeerError("no request id");
    const out = this.outgoing.get(p.askId);
    if (!out || out.owner !== ctx.from || out.roomId !== ctx.roomId) throw new PeerError("no such request");
    if (p.state !== "handing-over") throw new PeerError("unknown state");
    out.state = "handing-over";
    this.changed();
    return { ok: true };
  }

  /** Ask a connected owner to hand their session over: the snapshot they handed over and their signed grant for it, or why not (thrown). */
  private async ask(roomId: RoomId, b: RoomSessionBackup): Promise<{ sha: string; takenAt: number; grant: TakeoverGrant }> {
    const askId = crypto.randomBytes(12).toString("hex");
    const ownerName = this.nameOf(roomId, b.owner);
    const title = b.session.title;
    const at = this.now();
    this.outgoing.set(askId, { roomId, sessionId: b.sessionId, owner: b.owner, ownerName, at, deadline: at + this.askMs, state: "asking" });
    this.changed();
    try {
      const r = await this.d.team.request<AskAnswer>(b.owner, "takeover.handover", { roomId, sessionId: b.sessionId, askId }, { roomId, timeoutMs: this.askMs + this.handoverTurnMs + 3 * SEND_TIMEOUT_MS });
      if (r?.answer === "handed-over") {
        const handed = { sha: sha(r.sha), takenAt: time(r.takenAt, "takenAt") };
        const room = this.d.team.room(roomId);
        const why = room ? grantProblem(room, r.grant, { owner: b.owner, ownerName, sessionId: b.sessionId, taker: this.d.team.self.id, at: Date.now(), sha: handed.sha }) : "you're not in the room any more";
        if (why) throw new Error(`${ownerName}'s Mockingbird handed “${title}” over without a hand-over that holds (${why}), so it isn't taken over — ${ownerName} can resume it there`);
        return { ...handed, grant: r.grant };
      }
      if (r?.answer === "kept") throw new Error(`${ownerName} kept “${title}”: it carries on on their laptop`);
      if (r?.answer === "timeout") throw new Error(`${ownerName} didn't answer in time, so “${title}” stays on their laptop`);
      throw new Error(`${ownerName}'s Mockingbird gave an answer this one doesn't know`);
    } catch (err) {
      if (err instanceof TeamError) {
        if (err.code === "offline" || err.code === "disconnected" || err.code === "closed") {
          throw new Error(`${ownerName} went offline before handing “${title}” over — you can take it over from the newest backup now`);
        }
        if (err.code === "no-handler") throw new Error(`${ownerName} needs to update Mockingbird to hand “${title}” over: take-overs now need their signed hand-over`);
        if (err.code === "remote") throw new Error(`${ownerName}'s Mockingbird couldn't hand “${title}” over: ${err.message}`);
        if (err.code === "timeout") throw new Error(`${ownerName}'s Mockingbird stopped answering while handing “${title}” over`);
      }
      throw err;
    } finally {
      this.outgoing.delete(askId);
      this.changed();
    }
  }

  // ---- taking over (teammate) ----------------------------------------------------------------

  /** What a take-over would use, for the confirm dialog: the clone, the newest snapshot, whether the whole conversation is here. */
  async plan(roomId: RoomId, sessionId: string, clonePath?: string | null, handed?: { sha: string; takenAt: number }): Promise<TakeoverPlan> {
    const b = this.backupOf(roomId, sessionId);
    const clone = clonePath ? await this.checkClone(clonePath, b.session.originUrl) : await this.cloneFor(b.session.originUrl, true);
    const ownerOnline = this.d.team.presence(roomId).includes(b.owner);
    const base = {
      roomId,
      sessionId,
      title: b.session.title,
      agent: b.session.agent,
      branch: b.session.branch,
      ownerName: this.nameOf(roomId, b.owner),
      ownerOnline,
      originUrl: b.session.originUrl,
      conversation: this.conversationPlan(roomId, b),
      resumesOwn: this.resumesOwn(roomId, b),
      toOrigin: backupsToOrigin(this.d.team.room(roomId)),
      grant: this.grantPlan(roomId, b, ownerOnline),
    };
    if (!clone) return { ...base, clone: null, snapshot: null, other: null, originProblem: null, latestMissing: true };
    const { pick, other, originProblem } = await this.snapshotsFor(clone, roomId, b, handed);
    return {
      ...base,
      clone,
      snapshot: pick ? { ...pick, skipped: await skippedIn(clone, pick.sha) } : null,
      other,
      originProblem,
      latestMissing: !pick || pick.takenAt < b.latest.takenAt,
    };
  }

  /**
   * Continue a teammate's room session on this Mac: a worktree on its branch
   * from the newest snapshot, the conversation placed for this Mac's CLI (or a
   * kickoff from what arrived, which says so), the session launched under this
   * Mac's account, and the room told. A connected owner is asked first and
   * hands over the exact snapshot to continue from (their agent stopped);
   * when they keep it, don't answer, or go offline meanwhile, this throws
   * saying which.
   */
  async takeOver(roomId: RoomId, sessionId: string, clonePath?: string | null): Promise<TakeoverResult> {
    const k = `${roomId}\n${sessionId}`;
    if (this.taking.has(k)) throw new Error("This session is already being taken over");
    this.taking.add(k);
    try {
      let plan = await this.plan(roomId, sessionId, clonePath);
      if (plan.grant.kind === "none") throw new Error(`“${plan.title}” can't be taken over: ${plan.grant.why}`);
      if (!plan.clone) throw new Error(`No clone of ${plan.originUrl} was found among your repositories — choose yours`);
      const clone = plan.clone;
      const handed = plan.ownerOnline ? await this.ask(roomId, this.backupOf(roomId, sessionId)) : null;
      if (handed) plan = await this.plan(roomId, sessionId, clone, handed);
      const snap = handed ? ([plan.snapshot, plan.other].find((c) => c?.sha === handed.sha) ?? null) : plan.snapshot;
      if (!snap && handed) {
        const missed = plan.toOrigin ? `reached neither this Mac nor origin${plan.originProblem ? ` (reading origin failed: ${plan.originProblem})` : ""}` : "didn't reach this Mac";
        throw new Error(`${plan.ownerName} handed it over, but its snapshot ${handed.sha.slice(0, 8)} ${missed} — ${plan.ownerName} can resume it there`);
      }
      if (!snap) {
        throw new Error(
          plan.toOrigin
            ? `No snapshot of this session reached this Mac or origin${plan.originProblem ? ` (reading origin failed: ${plan.originProblem})` : ""} — it's only on ${plan.ownerName}'s laptop`
            : `No copy of this session has reached this Mac yet: this room keeps backups peer to peer, and ${plan.ownerName}'s laptop hasn't sent one while you were both connected. Take it over once ${plan.ownerName} is back online (they're asked to hand it over), or ask the room's admin to turn on backups to origin.`
        );
      }
      const b = this.backupOf(roomId, sessionId);
      // the owner's hand-over, checked here as every member will check it, before anything starts; offline, none is needed
      const grant = handed?.grant;
      if (grant) {
        const refusal = grantProblem(this.d.team.room(roomId)!, grant, { owner: b.owner, ownerName: plan.ownerName, sessionId, taker: this.d.team.self.id, at: Date.now(), sha: snap.sha });
        if (refusal) throw new Error(`“${plan.title}” can't be taken over: ${refusal}. ${whomToAsk(plan.ownerName)}`);
      } else if (!b.offline) {
        throw new Error(`“${plan.title}” can't be taken over: ${olderOwner(plan.ownerName)}`);
      }
      const base = (await git(clone, ["rev-parse", "--verify", "-q", `${snap.sha}^1`], { okCodes: [0, 1] })) || null;
      if (!base) throw new Error("The snapshot has no parent commit (the repository had no commits yet), so there's no branch to continue");
      const wt = await worktreeAt(clone, b.session.branch, base);
      await checkoutSnapshotFiles(wt.path, snap.sha);
      const carried = await this.startFrom(roomId, b, plan, wt, snap);
      const req: NewSessionRequest = {
        repoPath: clone,
        cwd: wt.path,
        branchName: wt.branch ?? undefined,
        useWorktree: false,
        agent: b.session.agent,
        title: b.session.title,
        taskGroup: this.d.host.groupOf(roomId) ?? undefined,
        ...carried.req,
      };
      // an owner who came back while the work was restored is asked instead: their Mac would refuse it now
      if (!grant && this.d.team.presence(roomId).includes(b.owner)) {
        if (this.local(roomId).saved[wt.path]) this.removeSaved(roomId, wt.path, "the take-over didn't go ahead");
        throw new Error(`${plan.ownerName} came back online while the work was restored in ${wt.path}: take it over again to ask them`);
      }
      let info: SessionInfo;
      try {
        info = await this.d.launch(req);
      } catch (err) {
        if (this.local(roomId).saved[wt.path]) this.removeSaved(roomId, wt.path, "the session it was saved for didn't start");
        throw new Error(`The work is restored in ${wt.path}, but the session didn't start: ${(err as Error).message}`);
      }
      const saved = this.local(roomId).saved[wt.path];
      if (saved) {
        saved.sessionId = info.id;
        this.saveLocal(roomId);
      }
      const snapshot = { sha: snap.sha, takenAt: snap.takenAt, source: snap.source };
      try {
        this.d.team.publish(roomId, "session.takenOver", { sessionId, from: b.owner, newSessionId: info.id, snapshot, conversation: carried.carried, branch: wt.branch, ...(grant ? { grant } : { offline: 1 as const }) });
      } catch (err) {
        throw new Error(`The session runs here now (in ${wt.path}), but the room couldn't be told, so ${plan.ownerName}'s copy still shows as live: ${(err as Error).message}`);
      }
      if (this.d.team.room(roomId)?.ext.takeover?.sessions[sessionId]?.takenOver?.newSessionId !== info.id) {
        throw new Error(`The session runs here now (in ${wt.path}), but the room didn't take the take-over (${grant ? `${plan.ownerName}'s hand-over no longer held` : "someone else's take-over came first"}), so ${plan.ownerName}'s copy runs on`);
      }
      this.changed();
      return { sessionId: info.id, cwd: wt.path, branch: wt.branch, renamedFrom: wt.renamedFrom, snapshot, conversation: carried.carried };
    } finally {
      this.taking.delete(k);
    }
  }

  /**
   * How a take-over of `b` would go now: the owner is asked (they're
   * connected — whoever takes it, the room's owner or an admin too), it goes
   * ahead without asking (they're offline and their Mockingbird takes that),
   * or it can't, and why.
   */
  private grantPlan(roomId: RoomId, b: RoomSessionBackup, ownerOnline: boolean): TakeoverPlan["grant"] {
    if (ownerOnline) return { kind: "ask" };
    if (b.offline) return { kind: "offline" };
    return { kind: "none", why: olderOwner(this.nameOf(roomId, b.owner)) };
  }

  /**
   * The snapshots a take-over may start from, newest first by the time the
   * owner signed (ties go to the one the room last announced): only commits
   * the owner's signed room log names — its newest `session.backup`, and what
   * it says origin holds — or, for a hand-over, the snapshot their signed
   * answer names. The peer copy is the commit the owner's Mockingbird sent this
   * Mac itself (checked against what it named when it arrived); origin's ref
   * counts only when it points at one of those commits. Anything else on
   * origin — anyone who can push to the repository can set that ref — is
   * ignored, logged and said; a commit's own date is never read (N6).
   */
  private async snapshotsFor(clone: string, roomId: RoomId, b: RoomSessionBackup, handed?: { sha: string; takenAt: number }): Promise<{ pick: Candidate | null; other: Candidate | null; originProblem: string | null }> {
    const ref = roomBackupRef(roomId, b.sessionId);
    const ownerName = this.nameOf(roomId, b.owner);
    const signed = new Map<string, number>([[b.latest.sha, b.latest.takenAt]]);
    if (b.pushed && !signed.has(b.pushed.sha)) signed.set(b.pushed.sha, b.pushed.takenAt);
    if (handed && !signed.has(handed.sha)) signed.set(handed.sha, handed.takenAt);
    const found: Candidate[] = [];
    const mirrored = this.local(roomId).mirrored[b.sessionId];
    const peerSha = (await git(clone, ["rev-parse", "--verify", "-q", ref], { okCodes: [0, 1] })) || null;
    if (mirrored && mirrored.from === b.owner && (await hasCommits(clone, [mirrored.sha])).length) {
      // what the owner's Mockingbird sent here, whatever the ref in this clone says now (a fetch of refs/mockingbird/* from origin could have moved it)
      if (peerSha && peerSha !== mirrored.sha) this.d.log(`team: session ${b.sessionId}`, `${ref} in ${clone} points at ${peerSha.slice(0, 8)}, not the copy ${ownerName}'s Mockingbird sent (${mirrored.sha.slice(0, 8)}): using that copy`);
      found.push({ sha: mirrored.sha, takenAt: signed.get(mirrored.sha) ?? mirrored.takenAt, source: "peer" });
    } else if (peerSha && signed.has(peerSha)) {
      found.push({ sha: peerSha, takenAt: signed.get(peerSha)!, source: "peer" });
    }
    let originProblem: string | null = null;
    const copy = roomBackupRef(roomId, b.sessionId, ORIGIN_COPY_ROOT);
    // origin holds a backup of this session only when its owner pushed one (the room offers it and they allowed it)
    if (backupsToOrigin(this.d.team.room(roomId)) && (b.toOrigin || b.pushed || handed)) {
      try {
        await git(clone, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", `+${ref}:${copy}`], { timeoutMs: this.d.fetchTimeoutMs ?? 30_000 });
        const got = await git(clone, ["rev-parse", "--verify", copy]);
        const at = signed.get(got);
        if (at !== undefined) found.push({ sha: got, takenAt: at, source: "origin" });
        else {
          originProblem = `origin's backup ref points at ${got.slice(0, 8)}, a commit ${ownerName} never recorded backing up — ignored (anyone who can push to the repository can set that ref)`;
          // TODO(audit-log): a planted backup ref on origin was ignored
          this.d.log(`team: reading origin's backup of session ${b.sessionId}`, originProblem);
          await git(clone, ["update-ref", "-d", copy]);
        }
      } catch (err) {
        const msg = withoutCredentials((err as Error).message);
        // origin never got a backup of this session: nothing to compare, unless the room says it did
        if (!/couldn't find remote ref/i.test(msg) || b.pushed) {
          originProblem = msg.replace(/\s+/g, " ").trim().slice(0, 300);
          this.d.log(`team: reading origin's backup of session ${b.sessionId}`, originProblem);
        }
      }
    }
    found.sort((x, y) => y.takenAt - x.takenAt || Number(y.sha === b.latest.sha) - Number(x.sha === b.latest.sha) || (x.source === "origin" ? -1 : 1));
    const pick = found[0] ?? null;
    const other = found.find((c) => c.sha !== pick?.sha) ?? null;
    return { pick, other, originProblem };
  }

  /** Whether the conversation reached this Mac whole: as long as the owner last said it was, and the same conversation. */
  private conversationPlan(roomId: RoomId, b: RoomSessionBackup): TakeoverPlan["conversation"] {
    const meta = this.transcriptMeta(roomId, b.sessionId);
    if (!meta) return { kind: "none" };
    const have = fileSizeSync(path.join(this.transcriptDir(roomId, b.sessionId), meta.file));
    if (!have) return { kind: "none" };
    const current = !b.session.conversationId || b.session.conversationId === meta.conversationId;
    const of = Math.max(meta.total, current ? b.transcriptBytes ?? 0 : have + 1);
    return current && have >= of && meta.agent === b.session.agent ? { kind: "full", bytes: have } : { kind: "partial", have, of };
  }

  /**
   * How the continued session starts. A teammate's session starts a new
   * conversation on this Mac's account from a brief (takeoverBrief.ts) — never
   * by resuming theirs, which would send the whole of it, uncached on this
   * account, with the first turn — and the transcript that arrived is saved in
   * the worktree for the agent to read when it needs detail. A session that
   * was this Mac's own (taken back) resumes this Mac's own conversation,
   * moved to the new worktree, with the brief of the teammate's turns as its
   * first input.
   */
  private async startFrom(roomId: RoomId, b: RoomSessionBackup, plan: TakeoverPlan, wt: { path: string; branch: string | null }, snap: { sha: string; takenAt: number }): Promise<{ req: Partial<NewSessionRequest>; carried: ConversationCarried }> {
    const meta = this.transcriptMeta(roomId, b.sessionId);
    const file = meta && plan.conversation.kind !== "none" ? path.join(this.transcriptDir(roomId, b.sessionId), meta.file) : null;
    const conversation = plan.conversation.kind === "full" ? "full" : plan.conversation.kind === "partial" ? "partial" : "none";
    const lines = file ? await transcriptLines(file) : [];
    const transcript = file ? await this.saveTranscriptIn(roomId, wt.path, file, meta!.file, b) : null;
    const own = await this.resumeOwn(roomId, b, wt.path);
    let base = await baseRef(wt.path);
    const fork = base ? await git(wt.path, ["merge-base", "HEAD", base], { okCodes: [0, 1] }) : "";
    if (!fork) base = null;
    const stat = await git(wt.path, ["diff", "--stat=160", fork || "HEAD"]);
    const untracked = await git(wt.path, ["ls-files", "--others", "--exclude-standard"]);
    const initialPrompt = takeoverBrief({
      mode: own ? "return" : "fresh",
      owner: this.nameOf(roomId, b.owner),
      taker: this.nameOf(roomId, this.d.team.self.id),
      agent: b.session.agent,
      title: b.session.title,
      ticketId: b.session.ticketId ?? null,
      room: this.d.team.room(roomId)?.name ?? roomId,
      repo: b.session.originUrl,
      branch: wt.branch,
      worktree: wt.path,
      snapshot: snap,
      base,
      changes: [...untracked.split("\n").filter(Boolean).map((f) => `${f} (new, untracked)`), ...stat.split("\n").filter(Boolean)],
      conversation,
      lines,
      conversationId: meta?.conversationId ?? null,
      transcript,
    });
    return { req: { initialPrompt, ...(own ? { resumeSessionId: own } : {}) }, carried: conversation === "full" ? "full" : conversation === "partial" ? "digest" : "none" };
  }

  /**
   * The transcript that arrived, saved read-only in the worktree's .mockingbird
   * (git-excluded first, so it's never committed or in a backup) for the agent
   * to read on demand, and recorded so it's deleted once the session continued
   * there is done with it (savedDone). A failure is logged and the brief says so.
   */
  private async saveTranscriptIn(roomId: RoomId, worktree: string, file: string, name: string, b: RoomSessionBackup): Promise<{ path: string; bytes: number } | { error: string }> {
    try {
      await excludePlanDir(worktree);
      const text = await fs.promises.readFile(file, "utf8");
      const rel = `${TAKEOVER_TRANSCRIPT_DIR}/${name}`;
      writeGeneratedInside(worktree, rel, text, 0o400, 0o700);
      this.local(roomId).saved[worktree] = { sessionId: null, from: b.sessionId, title: b.session.title.slice(0, 300), at: this.now() };
      this.saveLocal(roomId);
      return { path: path.join(worktree, rel), bytes: Buffer.byteLength(text) };
    } catch (err) {
      this.d.log(`team: saving session ${b.sessionId}'s conversation in ${worktree}`, err);
      return { error: (err as Error).message };
    }
  }

  /**
   * Why a conversation saved at a take-over is no longer needed, or null
   * while the session continued there still runs (or can be resumed) and has
   * had a turn within STALE_BACKUP_MS.
   */
  private savedDone(room: RoomState, rec: SavedTranscript): string | null {
    if (!rec.sessionId) return this.taking.size ? null : "the session it was saved for never started";
    const entry = room.ext.takeover?.sessions[rec.sessionId];
    if (entry?.takenOver) return `“${rec.title}” was taken over again, by ${this.nameOf(room.id, entry.takenOver.by)}`;
    if (entry?.dropped) return `the backup of “${rec.title}” was deleted (${entry.dropped.reason})`;
    if (!this.d.host.session(rec.sessionId)) return `“${rec.title}” is closed`;
    const active = Math.max(rec.at, this.local(room.id).own[rec.sessionId]?.activeAt ?? 0);
    if (this.now() - active > STALE_BACKUP_MS) return `“${rec.title}” had no turn for ${Math.round(STALE_BACKUP_MS / 86_400_000)} days`;
    return null;
  }

  /**
   * Delete a conversation saved in a worktree at a take-over (a symbolic link
   * on the way is refused, never followed), logging why. A failure is logged,
   * shown with the room's cleanup problems, kept and retried on the next
   * prune; it's returned.
   */
  private removeSaved(roomId: RoomId, worktree: string, why: string): string | null {
    const local = this.local(roomId);
    const rec = local.saved[worktree];
    const key = `saved:${worktree}`;
    const where = path.join(worktree, TAKEOVER_TRANSCRIPT_DIR);
    try {
      if (removeDirInside(worktree, TAKEOVER_TRANSCRIPT_DIR)) console.log(`[team] deleted the conversation saved at a take-over in ${where}: ${why}`);
    } catch (err) {
      const problem = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim().slice(0, 300);
      this.d.log(`team: deleting the conversation saved at a take-over in ${where} (${why})`, problem);
      this.cleanupProblems.set(key, { roomId, title: rec?.title ?? path.basename(worktree), problem: `${where}: ${problem}`, what: "conversation not deleted from its worktree" });
      this.changed();
      return problem;
    }
    if (rec) {
      delete local.saved[worktree];
      this.saveLocal(roomId);
    }
    if (this.cleanupProblems.delete(key)) this.changed();
    return null;
  }

  /** Delete what was saved for `sessionId` (the session continued there), in any room, because `why`. */
  private removeSavedFor(sessionId: string, why: string): void {
    for (const room of this.d.team.rooms()) {
      for (const [worktree, rec] of Object.entries(this.local(room.id).saved)) if (rec.sessionId === sessionId) this.removeSaved(room.id, worktree, why);
    }
  }

  /**
   * Conversations an earlier Mockingbird saved at take-overs without a record
   * of them: found from the room's take-overs by this install and the
   * worktree each continued session runs in, and recorded.
   */
  private adoptSaved(room: RoomState): void {
    const self = this.d.team.self.id;
    const local = this.local(room.id);
    const known = new Set(Object.values(local.saved).map((r) => r.sessionId));
    let changed = false;
    for (const e of Object.values(room.ext.takeover?.sessions ?? {})) {
      const t = e.takenOver;
      if (t?.by !== self || known.has(t.newSessionId)) continue;
      const mine = room.ext.takeover?.sessions[t.newSessionId];
      const cwd = this.d.host.session(t.newSessionId)?.cwd ?? (mine?.owner === self ? mine.session.cwd : null);
      if (!cwd || local.saved[cwd]) continue;
      try {
        fs.lstatSync(path.join(cwd, TAKEOVER_TRANSCRIPT_DIR));
      } catch (err) {
        if (!isMissing(err)) this.d.log(`team: looking for a conversation saved at a take-over in ${cwd}`, err);
        continue;
      }
      local.saved[cwd] = { sessionId: t.newSessionId, from: e.sessionId, title: e.session.title, at: t.at };
      changed = true;
    }
    if (changed) this.saveLocal(room.id);
  }

  /** This Mac's own session that became `b` (it's being taken back): its own conversation, moved to `worktree` for its CLI to resume. The conversation id, or null. */
  private async resumeOwn(roomId: RoomId, b: RoomSessionBackup, worktree: string): Promise<string | null> {
    const mine = this.ownPredecessor(roomId, b);
    if (!mine) return null;
    const { agent, conversationId: id, cwd } = mine.session;
    const src = this.ownTranscript(agent, id!, cwd);
    if (!src) {
      this.d.log(`team: taking back session ${b.sessionId}`, `this Mac's own conversation ${id} wasn't found, so it starts from the brief`);
      return null;
    }
    // the CLI started in the new worktree sees its real path: that's the one it looks under and records
    const to = realpathOr(worktree);
    const moved = rebaseTranscript(await fs.promises.readFile(src, "utf8"), agent, [...new Set([cwd, realpathOr(cwd)])], to);
    // a Codex rollout is found by id wherever it is: moved in place (its old copy never runs again)
    const dest = agent === "codex" ? src : path.join(claudeProjectDir(to, this.claudeProjects), `${id}.jsonl`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeFileAtomic(dest, moved, 0o600);
    return id;
  }

  /** Whether taking `b` over resumes this Mac's own conversation (see resumeOwn). */
  private resumesOwn(roomId: RoomId, b: RoomSessionBackup): boolean {
    const mine = this.ownPredecessor(roomId, b);
    return !!mine && !!this.ownTranscript(mine.session.agent, mine.session.conversationId!, mine.session.cwd);
  }

  /** The session of this Mac's that a teammate continued as `b`, when it ran the same agent and its conversation is known. */
  private ownPredecessor(roomId: RoomId, b: RoomSessionBackup): RoomSessionBackup | null {
    const self = this.d.team.self.id;
    const all = Object.values(this.d.team.room(roomId)?.ext.takeover?.sessions ?? {});
    return all.find((e) => e.owner === self && e.takenOver?.newSessionId === b.sessionId && e.takenOver.by === b.owner && e.session.agent === b.session.agent && !!e.session.conversationId) ?? null;
  }

  // ---- the window's view ----------------------------------------------------------------------

  view(): TakeoverView {
    const sessions: RoomSessionBackupView[] = [];
    for (const room of this.d.team.rooms()) {
      const online = new Set(this.d.team.presence(room.id));
      const mirrored = this.local(room.id).mirrored;
      for (const b of Object.values(room.ext.takeover?.sessions ?? {})) {
        if (!room.members.some((m) => m.id === b.owner)) continue; // its owner left the room: it's gone with them
        const self = b.owner === this.d.team.self.id;
        const m = mirrored[b.sessionId];
        const meta = self ? null : this.transcriptMeta(room.id, b.sessionId);
        const sameConv = !!meta && (!b.session.conversationId || meta.conversationId === b.session.conversationId);
        sessions.push({
          ...b,
          roomId: room.id,
          ownerName: this.nameOf(room.id, b.owner),
          ownerOnline: self || online.has(b.owner),
          self,
          takenOverByName: b.takenOver ? this.nameOf(room.id, b.takenOver.by) : null,
          peerCopy: !self && m && m.from === b.owner ? { sha: m.sha, takenAt: m.takenAt } : null,
          offlineTakeover: !self && !online.has(b.owner) && !!b.offline,
          heldBy: self ? [...(this.held.get(b.sessionId) ?? [])].filter(([peer, sha]) => sha === b.latest.sha && room.members.some((x) => x.id === peer)).map(([peer]) => this.nameOf(room.id, peer)) : [],
          transcript: meta ? { have: fileSizeSync(path.join(this.transcriptDir(room.id, b.sessionId), meta.file)), of: sameConv ? Math.max(meta.total, b.transcriptBytes ?? 0) : null } : null,
          problem: this.problems.get(b.sessionId) ?? null,
        });
      }
    }
    const list = <T extends { roomId: RoomId; title: string; problem: string }>(m: Map<string, T>) => [...m].map(([sessionId, u]) => ({ sessionId, ...u }));
    const left: LeftCopy[] = [];
    const received: ReceivedChanges[] = [];
    for (const room of this.d.team.rooms()) {
      const online = this.d.team.presence(room.id);
      const local = this.local(room.id);
      for (const e of Object.values(room.ext.takeover?.sessions ?? {})) {
        if (!e.takenOver || e.owner !== this.d.team.self.id || (!local.left[e.sessionId] && !this.d.host.session(e.sessionId))) continue;
        const now = continuation(room.ext.takeover, e.sessionId)!;
        const self = now.owner === this.d.team.self.id;
        const sent = local.left[e.sessionId]?.sent;
        left.push({
          roomId: room.id,
          sessionId: e.sessionId,
          title: e.session.title,
          by: e.takenOver.by,
          byName: this.nameOf(room.id, e.takenOver.by),
          at: e.takenOver.at,
          now: { owner: now.owner, ownerName: this.nameOf(room.id, now.owner), sessionId: now.sessionId, self, online: self || online.includes(now.owner) },
          takeBack: !self && now.backedUp,
          unsent: this.unsent.get(e.sessionId) ?? null,
          sent: sent ? { at: sent.at, files: sent.files } : null,
          sending: this.sending.has(e.sessionId),
        });
      }
      for (const [id, r] of Object.entries(local.received)) received.push(this.receivedView(room.id, id, r));
    }
    const refused: RefusedTakeover[] = [];
    for (const room of this.d.team.rooms()) {
      for (const r of Object.values(this.local(room.id).refused ?? {})) {
        const s = room.ext.takeover?.sessions[r.sessionId];
        // until the session is done with here, or the take-over came to count after all
        if (!s || s.takenOver || s.dropped || s.ungranted?.by !== r.by) continue;
        refused.push({ roomId: room.id, sessionId: r.sessionId, title: r.title, byName: this.nameOf(room.id, r.by), at: r.at, why: r.why });
      }
    }
    return {
      sessions,
      rooms: this.d.team.rooms().map((room) => this.backupSetting(room)),
      unbacked: list(this.unbacked),
      cleanup: list(this.cleanupProblems),
      asks: [...this.incoming.values()].map(askView),
      asking: [...this.outgoing.values()].map(({ owner: _owner, ...o }) => o),
      left,
      received,
      refused,
    };
  }

  /**
   * Teammates' room sessions whose newest snapshot was copied into a clone
   * here peer to peer (their uncommitted work, as of their last turn): what
   * the overlap check and the agents' teammate tools read. A session taken
   * over, whose backup was dropped, or whose owner left isn't listed.
   */
  mirrored(): { roomId: RoomId; sessionId: string; owner: MemberId; sha: string; takenAt: number; repo: string }[] {
    const out: { roomId: RoomId; sessionId: string; owner: MemberId; sha: string; takenAt: number; repo: string }[] = [];
    for (const room of this.d.team.rooms()) {
      const mirrored = this.local(room.id).mirrored;
      for (const b of Object.values(room.ext.takeover?.sessions ?? {})) {
        const m = mirrored[b.sessionId];
        if (!m || m.from !== b.owner || b.owner === this.d.team.self.id || b.takenOver || b.dropped || !room.members.some((x) => x.id === b.owner)) continue;
        out.push({ roomId: room.id, sessionId: b.sessionId, owner: b.owner, sha: m.sha, takenAt: m.takenAt, repo: m.repo });
      }
    }
    return out;
  }

  /** A room's backup setting for Settings → Team: on or off, who changed it, who may, and what the remote is called. */
  private backupSetting(room: RoomState): RoomBackupSetting {
    const owner = roomOwner(room);
    const s = room.ext.settings;
    const urls = [
      ...Object.values(room.ext.takeover?.sessions ?? {}).map((b) => b.session.originUrl),
      ...Object.values(room.ext.sessions ?? {}).flatMap((r) => (r.repo ? [r.repo] : [])),
    ];
    return {
      roomId: room.id,
      toOrigin: backupsToOrigin(room),
      consent: this.backupConsent(room.id),
      changed: s ? { byName: this.nameOf(room.id, s.by), self: s.by === this.d.team.self.id, at: s.at } : null,
      adminName: owner ? this.nameOf(room.id, owner) : null,
      canChange: owner === this.d.team.self.id,
      remote: remoteLabel(urls),
    };
  }

  // ---- helpers ------------------------------------------------------------------------------

  /** A teammate's room session that can be taken over. */
  private backupOf(roomId: RoomId, sessionId: string): RoomSessionBackup {
    const room = this.d.team.room(roomId);
    if (!room) throw new Error("You're not in that room");
    const b = room.ext.takeover?.sessions[sessionId];
    if (!b) throw new Error("No backup of that session has reached this Mac yet");
    if (b.owner === this.d.team.self.id) throw new Error("That's your own session");
    if (b.takenOver) throw new Error(`${this.nameOf(roomId, b.takenOver.by)} already took that session over`);
    if (b.dropped?.reason === "left-room") throw new Error(`${this.nameOf(roomId, b.owner)} left the room: their sessions can't be taken over`);
    if (b.dropped) throw new Error("Its backup was deleted: the session was closed, its work merged, or it sat idle");
    return b;
  }

  /** This Mac's clone of the repository at `url`, by origin (not path). */
  private async cloneFor(url: string, fresh = false): Promise<string | null> {
    const id = repoIdentity(url);
    if (fresh || !this.repoIndex || this.now() - this.repoIndex.at > REPO_INDEX_MS) {
      const byIdentity = new Map<string, string>();
      for (const repo of this.d.repos()) {
        try {
          const u = await originUrl(repo);
          if (u && !byIdentity.has(repoIdentity(u))) byIdentity.set(repoIdentity(u), repo);
        } catch (err) {
          this.d.log(`team: reading ${repo}'s origin`, err);
        }
      }
      this.repoIndex = { at: this.now(), byIdentity };
    }
    const hit = this.repoIndex.byIdentity.get(id) ?? null;
    return hit && fs.existsSync(hit) ? hit : null;
  }

  /** A folder the taker chose: the top of a clone whose origin is the session's. */
  private async checkClone(dir: string, url: string): Promise<string> {
    const top = await repoTop(dir);
    if (!top) throw new Error(`${dir} isn't a git repository`);
    const theirs = await originUrl(top);
    if (!theirs || repoIdentity(theirs) !== repoIdentity(url)) throw new Error(`${top}'s origin is ${theirs ? publicUrl(theirs) : "not set"}, not ${url}`);
    return top;
  }

  private ownTranscript(agent: AgentKind, id: string, cwd: string): string | null {
    // by folder too: a session taken back runs the same conversation as the stopped copy, in another worktree with its own transcript
    const key = `${agent}\n${id}\n${cwd}`;
    const cached = this.ownFiles.get(key);
    if (cached && fs.existsSync(cached)) return cached;
    const file = agent === "codex" ? codexRolloutOf(id, this.codexSessions) : claudeTranscriptOf(id, cwd, this.claudeProjects);
    if (file) this.ownFiles.set(key, file);
    return file;
  }

  private transcriptDir(roomId: RoomId, sessionId: string): string {
    return path.join(this.d.roomsDir, roomId, "transcripts", sessionIdOf(sessionId));
  }

  private transcriptMeta(roomId: RoomId, sessionId: string): TranscriptMeta | null {
    const v = readJsonOrSetAside(path.join(this.transcriptDir(roomId, sessionId), "meta.json"), null, `the conversation copied for session ${sessionId}`) as TranscriptMeta | null;
    return v && typeof v.file === "string" && path.basename(v.file) === v.file ? v : null;
  }

  private local(roomId: RoomId): LocalState {
    let s = this.locals.get(roomId);
    if (!s) {
      const v = readJsonOrSetAside(path.join(this.d.roomsDir, roomId, "takeover.json"), null, `room ${roomId}'s backups`) as LocalState | null;
      s =
        v && v.v === 1
          ? { v: 1, own: v.own ?? {}, mirrored: v.mirrored ?? {}, left: v.left ?? {}, received: v.received ?? {}, saved: v.saved ?? {}, refused: v.refused ?? {} }
          : { v: 1, own: {}, mirrored: {}, left: {}, received: {}, saved: {}, refused: {} };
      this.locals.set(roomId, s);
    }
    return s;
  }

  private saveLocal(roomId: RoomId): void {
    fs.mkdirSync(path.join(this.d.roomsDir, roomId), { recursive: true, mode: 0o700 });
    writeFileAtomic(path.join(this.d.roomsDir, roomId, "takeover.json"), JSON.stringify(this.local(roomId), null, 2));
  }

  private saveOwn(roomId: RoomId, sessionId: string, rec: OwnRecord): void {
    this.local(roomId).own[sessionId] = rec;
    this.saveLocal(roomId);
  }

  private saveMirror(roomId: RoomId, sessionId: string, rec: MirrorRecord): void {
    this.local(roomId).mirrored[sessionId] = rec;
    this.saveLocal(roomId);
  }

  private nameOf(roomId: RoomId, id: MemberId): string {
    const room = this.d.team.room(roomId);
    return (room?.members.find((m) => m.id === id) ?? room?.former?.find((m) => m.id === id))?.name || "a teammate";
  }

  private coalesce(jobs: Map<string, Job>, key: string, run: () => Promise<void>): Promise<void> {
    const running = jobs.get(key);
    if (running) {
      running.again = true;
      return running.done;
    }
    const job: Job = { again: false, done: Promise.resolve() };
    job.done = (async () => {
      try {
        do {
          job.again = false;
          try {
            await run();
          } catch (err) {
            this.d.log(`team: ${key.replace(/\n/g, " ")}`, err);
          }
        } while (job.again && !this.closed);
      } finally {
        jobs.delete(key);
      }
    })();
    jobs.set(key, job);
    return job.done;
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.background.add(p);
    void p.finally(() => this.background.delete(p)).catch(() => {}); // `p` itself is the caller's to handle
    return p;
  }

  private changed(): void {
    if (this.changeTimer || this.closed) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      try {
        this.d.changed?.();
      } catch (err) {
        this.d.log("team: sending the take-over view to the window", err);
      }
    }, 150);
  }
}

// ---- git and files ----------------------------------------------------------------------------

/** The commits among `shas` that `repo` has. */
async function hasCommits(repo: string, shas: string[]): Promise<string[]> {
  const ok = shas.filter((s) => SHA_RE.test(s));
  if (!ok.length) return [];
  const out = await git(repo, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: `${ok.join("\n")}\n` });
  return out
    .split("\n")
    .map((l) => l.split(" "))
    .filter(([s, type]) => type === "commit" && ok.includes(s))
    .map(([s]) => s);
}

/** Whether `commit` (in `repo`) is a room backup snapshot of session `sessionId`. */
async function isSnapshotOf(repo: string, commit: string, sessionId: string): Promise<boolean> {
  if (!(await hasCommits(repo, [commit])).length) return false;
  return (await git(repo, ["show", "-s", "--format=%s", commit])) === snapshotSubject(sessionId);
}

/** The first line of every backup snapshot's message. */
const snapshotSubject = (sessionId: string) => `Mockingbird: room session ${sessionId} after a turn`;

/** When a backup snapshot was taken: its message's taken-at, else its commit time. */
async function takenAtOf(repo: string, commit: string): Promise<number> {
  const out = await git(repo, ["show", "-s", "--format=%ct%n%B", commit]);
  const [ct, ...body] = out.split("\n");
  const at = Number(/^taken-at: (\d+)$/m.exec(body.join("\n"))?.[1]);
  return Number.isFinite(at) && at > 0 ? at : Number(ct) * 1000;
}

const conversationOf = (s: SessionInfo): { agent: AgentKind; id: string } | null => (s.conversation && CONV_ID_RE.test(s.conversation.id) ? s.conversation : null);

/** The files that differ between two commits (or trees), as added, modified or deleted. */
async function changedFiles(repo: string, from: string, to: string): Promise<ChangedFile[]> {
  const out = await git(repo, ["diff", "--name-status", "--no-renames", "-z", from, to], { trim: false });
  return parseNameStatus(out).map((c) => ({ path: c.path, status: c.status === "A" ? "added" : c.status === "D" ? "deleted" : "modified" }));
}

/** A pending request as the window sees it. */
const askView = (a: PendingAsk): IncomingAsk => ({ askId: a.askId, roomId: a.roomId, sessionId: a.sessionId, title: a.title, from: a.from, fromName: a.fromName, at: a.at, deadline: a.deadline, state: a.state });

async function readBytes(file: string, at: number, len: number): Promise<Buffer> {
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, at);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.promises.stat(file)).size;
  } catch (err) {
    if (isMissing(err)) return 0;
    throw err;
  }
}

function fileSizeSync(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    if (isMissing(err)) return 0;
    throw err;
  }
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Who to ask, when a take-over has no grant. */
/**
 * Why the owner's Mac refuses an offline take-over stamped `at` (the taker's
 * clock), or null when it counts: stamped while this Mac was connected to the
 * taker (its spans of connection, in its own clock), or before the snapshot it
 * continues from was taken — each with `skew` of leeway for the two clocks and
 * for each side noticing a connection change a little after the other.
 */
export function offlineTakeoverRefusal(o: { at: number; snapshotAt: number; connected: readonly Span[]; skew: number }): OfflineRefusalReason | null {
  if (o.at < o.snapshotAt - o.skew) return "before-snapshot";
  return connectedThen(o.connected, o.at, o.skew) ? "connected" : null;
}

const whomToAsk = (ownerName: string) => `Ask ${ownerName} to hand it over.`;
/** Why a session whose owner's Mockingbird is older than 1.6 can't be taken over while they're offline. */
const olderOwner = (ownerName: string) =>
  `${ownerName}'s Mockingbird needs an update (1.6.0) before their sessions can be taken over while they're offline. Take it over once ${ownerName} is back online: they're asked to hand it over.`;

