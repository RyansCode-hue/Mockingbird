import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { defineEventType } from "./rooms";
import type { RoomSessionSource } from "./roomSessions";
import type { RequestContext, Team, Unsubscribe } from "./transport";
import { branchesOf, currentBranch, git, isAncestor, originUrl, pickDefaultBase, publicUrl, repoIdentity, repoTop, withoutCredentials } from "../git";
import { checkoutSnapshotFiles, skippedIn, snapshotCommit } from "../snapshots";
import { secretPathspecs } from "../secrets";
import { worktreeAt } from "../worktrees";
import { CLAUDE_PROJECTS, CODEX_SESSIONS, ROLLOUT_NAME_RE, claudeProjectDir, claudeTranscriptOf, codexRolloutOf, codexRolloutPath, realpathOr } from "../agentFiles";
import { rebaseTranscript } from "../transcripts";
import { repoState, takeoverKickoff, transcriptDigest, transcriptLines } from "../handoff";
import { isMissing, readJsonOrSetAside, writeFileAtomic } from "../fileOps";
import { MEMBER_ID_RE } from "../../shared/team/protocol";
import {
  DROP_REASONS,
  ORIGIN_COPY_ROOT,
  roomBackupRef,
  SESSION_ID_RE,
  STALE_BACKUP_MS,
  type ConversationCarried,
  type DropReason,
  type PushOutcome,
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
 *     refs/mockingbird/rooms/<room>/<session>;
 *   - that ref is pushed to origin with a lease on its own last value (never a
 *     branch), in the background, coalesced, with a timeout; the outcome is
 *     recorded as a `session.backup` room event, failures included;
 *   - each connected teammate gets the snapshot peer to peer (a git bundle of
 *     what their clone lacks, imported under the same ref there) and the
 *     conversation's new bytes (offset-checked appends, resent from where they
 *     are after a gap). The conversation never goes anywhere else.
 *
 * Taker side, on Take over: their clone (found by origin URL), a new worktree
 * on the session's branch at the snapshot's parent with the snapshot's files
 * on top (uncommitted work and untracked files exactly), the newest snapshot of
 * the peer copy and origin's, the transcript placed where the taker's CLI
 * resumes it (or, when it didn't all arrive, a kickoff built from the handoff
 * digest that says so), the session launched, and `session.takenOver` published.
 *
 * Cleanup: only a session's current owner (the taker, once taken over)
 * deletes its backup ref on origin, then publishes `session.backupDropped`
 * and every member deletes its copies — when the owner forgets the session,
 * when the daily prune finds all its work merged into the base branch or no
 * turn for STALE_BACKUP_MS, and when a taker's first backup of its copy lands.
 *
 * Request methods between members: takeover.have, takeover.snapshot,
 * takeover.transcript (each names its room; the transport checks membership).
 */

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const CONV_ID_RE = /^[\w-]{1,100}$/;
/** The largest snapshot bundle sent peer to peer; bigger ones reach teammates through origin only. */
export const MAX_BUNDLE = 24 * 1024 * 1024;
/** Conversation bytes per request. */
export const TRANSCRIPT_CHUNK = 4 * 1024 * 1024;
const MAX_CANDIDATES = 32;
const SEND_TIMEOUT_MS = 120_000;
const REPO_INDEX_MS = 60_000;

// ---- room events ------------------------------------------------------------------------

const text = (v: unknown, what: string, max: number, min = 0): string => {
  if (typeof v !== "string" || v.length > max || v.length < min) throw new Error(`${what} must be text of ${min}–${max} characters`);
  return v;
};
const time = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${what} must be a time`);
  return v;
};
const sha = (v: unknown, what = "sha"): string => {
  if (typeof v !== "string" || !SHA_RE.test(v)) throw new Error(`${what} must be a commit id`);
  return v;
};
const sessionIdOf = (v: unknown): string => {
  if (typeof v !== "string" || !SESSION_ID_RE.test(v)) throw new Error("bad session id");
  return v;
};
const agentOf = (v: unknown): AgentKind => {
  if (v !== "claude" && v !== "codex") throw new Error("agent must be claude or codex");
  return v;
};
const sourceOf = (v: unknown): SnapshotSource => {
  if (v !== "peer" && v !== "origin") throw new Error("source must be peer or origin");
  return v;
};

function checkDescriptor(d: any): void {
  if (!d || typeof d !== "object") throw new Error("no session");
  text(d.title, "title", 300);
  agentOf(d.agent);
  if (d.branch !== null) text(d.branch, "branch", 250, 1);
  text(d.originUrl, "originUrl", 500, 1);
  text(d.cwd, "cwd", 1000, 1);
  if (d.conversationId !== null && (typeof d.conversationId !== "string" || !CONV_ID_RE.test(d.conversationId))) throw new Error("bad conversation id");
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
    checkDescriptor(b.session);
    if (b.transcriptBytes !== null && (!Number.isSafeInteger(b.transcriptBytes) || b.transcriptBytes < 0)) throw new Error("bad transcript size");
  },
  reduce(state, e) {
    const b = e.body;
    const t = (state.ext.takeover ??= { sessions: {} });
    const prev = t.sessions[b.sessionId];
    // a session is its first backer's; once taken over, the old copy's backups don't count
    if (prev && (prev.owner !== e.author || prev.takenOver || b.takenAt < prev.latest.takenAt)) return;
    const push = b.push.ok ? { ok: true as const, at: b.push.at, sha: b.sha } : { ok: false as const, at: b.push.at, error: b.push.error, sha: b.sha };
    t.sessions[b.sessionId] = {
      sessionId: b.sessionId,
      owner: e.author,
      session: b.session,
      latest: { sha: b.sha, takenAt: b.takenAt },
      push,
      pushed: b.push.ok ? { sha: b.sha, takenAt: b.takenAt, at: b.push.at } : prev?.pushed ?? null,
      transcriptBytes: b.transcriptBytes ?? prev?.transcriptBytes ?? null,
      takenOver: null,
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
    // only the session's current owner deletes its backup: the taker, once it's taken over
    if (!s || s.dropped || e.author !== (s.takenOver?.by ?? s.owner)) return;
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
  },
  reduce(state, e) {
    const b = e.body;
    const s = state.ext.takeover?.sessions[b.sessionId];
    // the first take-over in the room's order wins; an owner can't take over their own
    if (!s || s.takenOver || s.dropped || s.owner !== b.from || e.author === b.from) return;
    s.takenOver = { by: e.author, at: e.at, newSessionId: b.newSessionId, snapshot: b.snapshot, conversation: b.conversation };
  },
});

// ---- the seams ------------------------------------------------------------------------------

/**
 * What take-over needs from the app's sessions. index.ts provides liveRoomHost
 * (the live panes' room sessions and their turn ends); tests provide their own.
 */
export interface RoomSessionHost {
  /** The room a session on this install is shared in, or null when it's private (or a teammate took it over). */
  roomOf(sessionId: string): RoomId | null;
  /** A session on this install. */
  session(sessionId: string): SessionInfo | undefined;
  /** The local group a room is shown as: where a taken-over session goes. */
  groupOf(roomId: RoomId): string | null;
  /** Each agent turn's end in a session on this install. */
  onTurnEnd(cb: (sessionId: string) => void): Unsubscribe;
}

/**
 * The host over this install's room sessions as the live panes know them
 * (roomSessions.ts): a session's room, and the turn ends they report — the
 * same turn ends the Co-authored-by trailers count, so a backup follows every
 * turn a teammate's typing is credited for.
 */
export function liveRoomHost(live: RoomSessionSource, o: { sessions: () => SessionInfo[]; rooms: () => { id: RoomId; groupKey: string }[] }): RoomSessionHost {
  return {
    roomOf: (id) => live.roomOfSession(id),
    session: (id) => o.sessions().find((s) => s.id === id),
    groupOf: (roomId) => o.rooms().find((r) => r.id === roomId)?.groupKey ?? null,
    onTurnEnd: (cb) => live.onTurnEnded((e) => cb(e.sessionId)),
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
  /** Secret files at known places on this Mac (absolute paths): a backup leaves them out, with every SECRET_FILE_GLOBS match. */
  secretFiles?: () => string[];
  /** Where the CLIs keep conversations on this Mac (default ~/.claude/projects, ~/.codex/sessions). */
  claudeProjects?: string;
  codexSessions?: string;
  now?: () => number;
  pushTimeoutMs?: number;
  fetchTimeoutMs?: number;
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
interface LocalState {
  v: 1;
  /** Room sessions this install runs: the newest snapshot and what origin has. */
  own: Record<string, OwnRecord>;
  /** Teammates' sessions: the snapshot copied into this Mac's clone. */
  mirrored: Record<string, MirrorRecord>;
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
  private cleanupProblems = new Map<string, { roomId: RoomId; title: string; problem: string }>();
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private d: TakeoverDeps) {
    this.now = d.now ?? Date.now;
    this.claudeProjects = d.claudeProjects ?? CLAUDE_PROJECTS;
    this.codexSessions = d.codexSessions ?? CODEX_SESSIONS;
    const t = d.team;
    for (const r of t.rooms()) this.presence.set(r.id, new Set(t.presence(r.id)));
    this.offs.push(
      d.host.onTurnEnd((id) => void this.track(this.turnEnded(id))),
      t.onRequest("takeover.have", (p, ctx) => this.onHave(p, ctx)),
      t.onRequest("takeover.snapshot", (p, ctx) => this.onSnapshot(p, ctx)),
      t.onRequest("takeover.transcript", (p, ctx) => this.onTranscript(p, ctx)),
      t.onEvent("session.backup", () => this.changed()),
      t.onEvent("session.takenOver", (e, room) => this.onTakenOver(e, room)),
      t.onEvent("session.backupDropped", (e, room) => this.onDropped(e, room)),
      t.onPresence((roomId, online) => this.onPresence(roomId, online))
    );
  }

  close(): void {
    this.closed = true;
    for (const off of this.offs) off();
    this.offs = [];
    if (this.changeTimer) clearTimeout(this.changeTimer);
  }

  /** Resolves once every background send and push started so far has finished (for tests and quitting). */
  async settled(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  // ---- backing up (owner) ---------------------------------------------------------------

  /**
   * An agent turn ended in a session on this install: when it's a room
   * session, snapshot it, send it to connected teammates and push it to
   * origin. Turns that end while one is being backed up make it run once more.
   * Resolves once the push is done and recorded; never rejects (failures are
   * logged, recorded in the room and shown).
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
    const snap = await snapshotCommit(top, `${snapshotSubject(s.id)}\n\ntaken-at: ${takenAt}`, { exclude: secretPathspecs(top, this.d.secretFiles?.() ?? []) });
    if (!snap) throw new Error(`${s.cwd} isn't in a git repository`);
    // nothing changed since the last turn: keep that snapshot, with nothing new to send or push
    const same = !!prev && prev.tree === snap.tree && prev.parent === snap.parent && (await hasCommits(top, [prev.sha])).length === 1;
    const kept = { repo: s.repoPath ?? top, title: (s.ticketTitle ?? s.title).slice(0, 300), activeAt: takenAt }; // a turn is activity: a pending drop no longer applies
    let rec: OwnRecord = same ? { ...prev, ...kept, drop: undefined } : { sha: snap.sha, tree: snap.tree, parent: snap.parent, takenAt, pushed: prev?.pushed ?? null, pushedAt: prev?.pushedAt, ...kept };
    await git(top, ["update-ref", ref, rec.sha]);
    this.saveOwn(roomId, s.id, rec);
    for (const peer of this.d.team.presence(roomId)) this.mirror(peer, roomId, s.id);
    let push: PushOutcome;
    if (rec.pushed === rec.sha) push = { ok: true, at: rec.pushedAt ?? takenAt };
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
    };
    const body = { sessionId: s.id, sha: rec.sha, takenAt: rec.takenAt, push, session, transcriptBytes: file ? (await fs.promises.stat(file)).size : null };
    // a turn that changed nothing anyone records isn't a new event
    const key = JSON.stringify({ ...body, push: push.ok ? { ok: true, at: push.at } : { ok: false, error: push.error } });
    if (this.lastPublished.get(s.id) !== key) {
      this.d.team.publish(roomId, "session.backup", body);
      this.lastPublished.set(s.id, key);
    }
    // the session this one took over: its backup goes once this copy's is on origin
    if (!push.ok) return;
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
    await this.backups.get(sessionId)?.done; // a push under way would bring the ref back
    for (const room of this.d.team.rooms()) {
      const rec = this.local(room.id).own[sessionId];
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
   * failed before. Run on start and daily. Never rejects: failures are logged
   * and shown, and retried next time.
   */
  async prune(): Promise<void> {
    for (const room of this.d.team.rooms()) {
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
   * Delete a session's backup ref on origin (expecting the value it has there,
   * so nothing written meanwhile is lost), then tell the room, whose members
   * delete their copies. A failure is kept on the session and shown.
   */
  private async dropBackup(roomId: RoomId, sessionId: string, reason: DropReason, repo: string, title: string): Promise<void> {
    const ref = roomBackupRef(roomId, sessionId);
    try {
      const there = (await git(repo, ["ls-remote", "origin", ref], { timeoutMs: this.d.fetchTimeoutMs ?? 30_000 })).split("\t")[0];
      if (there) await git(repo, ["push", "--no-verify", "--quiet", `--force-with-lease=${ref}:${there}`, "origin", `:${ref}`], { timeoutMs: this.d.pushTimeoutMs ?? 60_000 });
      this.d.team.publish(roomId, "session.backupDropped", { sessionId, reason });
      this.cleanupProblems.delete(sessionId);
    } catch (err) {
      const rec = this.local(roomId).own[sessionId];
      const error = this.cleanupFailed(roomId, sessionId, title, err);
      if (rec) this.saveOwn(roomId, sessionId, { ...rec, drop: { reason, error, at: this.now() } });
    }
    this.changed();
  }

  private cleanupFailed(roomId: RoomId, sessionId: string, title: string, err: unknown): string {
    const problem = withoutCredentials(err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim().slice(0, 300);
    this.d.log(`team: deleting the backup of session ${sessionId}`, problem);
    this.cleanupProblems.set(sessionId, { roomId, title, problem });
    this.changed();
    return problem;
  }

  /** A session's backup was deleted: this Mac's copies go too (its own ref, a teammate's copy in a clone, the conversation). */
  private async forgetLocal(roomId: RoomId, sessionId: string): Promise<void> {
    const local = this.local(roomId);
    const own = local.own[sessionId];
    const mirrored = local.mirrored[sessionId];
    const entry = this.d.team.room(roomId)?.ext.takeover?.sessions[sessionId];
    const clone = entry && !own ? await this.cloneFor(entry.session.originUrl) : null;
    const ref = roomBackupRef(roomId, sessionId);
    for (const repo of new Set([own?.repo, mirrored?.repo, clone].filter((r): r is string => !!r && fs.existsSync(r)))) {
      for (const r of [ref, roomBackupRef(roomId, sessionId, ORIGIN_COPY_ROOT)]) await git(repo, ["update-ref", "-d", r]);
    }
    await fs.promises.rm(this.transcriptDir(roomId, sessionId), { recursive: true, force: true });
    delete local.own[sessionId];
    delete local.mirrored[sessionId];
    this.saveLocal(roomId);
    this.lastPublished.delete(sessionId);
    this.cleanupProblems.delete(sessionId);
    this.changed();
  }

  private onDropped(e: RoomEvent<"session.backupDropped">, room: RoomState): void {
    const s = room.ext.takeover?.sessions[e.body.sessionId];
    if (s?.dropped?.by !== e.author) return; // not the owner's: the room ignored it
    this.track(
      this.forgetLocal(room.id, e.body.sessionId).catch((err) => {
        this.cleanupFailed(room.id, e.body.sessionId, s.session.title, err);
      })
    );
  }

  /** Set origin's backup ref, only if it still holds what this install last put there. */
  private async push(top: string, ref: string, rec: OwnRecord, sessionId: string): Promise<PushOutcome> {
    // --no-verify: a pre-push hook is for branches, and this runs after every turn
    const lease = (expect: string) => git(top, ["push", "--no-verify", "--quiet", `--force-with-lease=${ref}:${expect}`, "origin", `${rec.sha}:${ref}`], { timeoutMs: this.d.pushTimeoutMs ?? 60_000 });
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

  private async sendSnapshot(peer: MemberId, roomId: RoomId, sessionId: string): Promise<void> {
    const rec = this.local(roomId).own[sessionId];
    const s = this.d.host.session(sessionId);
    if (!rec || !s) return;
    const top = await repoTop(s.cwd);
    const url = top && (await originUrl(top));
    if (!top || !url) return;
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
    if (!r?.repo) {
      const k = `${peer}\n${repoIdentity(url)}`;
      if (!this.noClone.has(k)) this.d.log(`team: session ${sessionId}`, `${this.nameOf(roomId, peer)} has no clone of ${publicUrl(url)}: they'll take it over from origin's backup`);
      this.noClone.add(k);
      return;
    }
    const current = typeof r.current === "string" ? r.current : null;
    if (current === rec.sha) return;
    const have = Array.isArray(r.have) ? r.have.filter((h): h is string => typeof h === "string" && SHA_RE.test(h)) : [];
    let bundle: string | null = null;
    if (!have.includes(rec.sha)) {
      // their copy of an earlier snapshot holds this one's history too, when it's still here
      const exclude = [...have, ...(current ? await hasCommits(top, [current]) : [])];
      const tmp = path.join(os.tmpdir(), `mb-room-${crypto.randomBytes(6).toString("hex")}.bundle`);
      try {
        await git(top, ["bundle", "create", tmp, ref, ...exclude.map((h) => `^${h}`)]);
        const { size } = await fs.promises.stat(tmp);
        if (size > MAX_BUNDLE) throw new Error(`the snapshot and what their clone lacks come to ${mb(size)}, over the ${mb(MAX_BUNDLE)} sent peer to peer: origin's backup has it`);
        bundle = (await fs.promises.readFile(tmp)).toString("base64");
      } finally {
        await fs.promises.rm(tmp, { force: true });
      }
    }
    await this.d.team.request(peer, "takeover.snapshot", { roomId, sessionId, sha: rec.sha, originUrl: publicUrl(url), bundle }, { roomId, timeoutMs: SEND_TIMEOUT_MS });
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
      const r = await this.d.team.request<{ have: number }>(
        peer,
        "takeover.transcript",
        { roomId, sessionId, agent: conv.agent, conversationId: conv.id, file: path.basename(file), ownerCwd: s.cwd, offset: at, data: data.toString("base64"), total: size, ...(reset ? { reset: true } : {}) },
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
    // a teammate who reconnects is asked what they hold again
    for (const k of [...this.transcriptAt.keys()]) if (!online.includes(k.split("\n")[0]) && before.has(k.split("\n")[0])) this.transcriptAt.delete(k);
    const fresh = online.filter((p) => !before.has(p));
    if (!fresh.length) return;
    for (const sessionId of Object.keys(this.local(roomId).own)) {
      if (this.d.host.roomOf(sessionId) !== roomId || !this.d.host.session(sessionId)) continue;
      for (const peer of fresh) this.mirror(peer, roomId, sessionId);
    }
    this.changed();
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
    if (!clone) throw new Error(`there's no clone of ${url} on this Mac`);
    const ref = roomBackupRef(roomId, sessionId);
    if (typeof p.bundle === "string" && p.bundle) {
      const bytes = Buffer.from(p.bundle, "base64");
      if (bytes.length > MAX_BUNDLE) throw new Error(`a ${mb(bytes.length)} snapshot is over the ${mb(MAX_BUNDLE)} accepted`);
      const tmp = path.join(os.tmpdir(), `mb-room-${crypto.randomBytes(6).toString("hex")}.bundle`);
      await fs.promises.writeFile(tmp, bytes, { mode: 0o600 });
      try {
        await git(clone, ["fetch", "--no-tags", "--no-write-fetch-head", tmp, `+${ref}:${ref}`]);
      } finally {
        await fs.promises.rm(tmp, { force: true });
      }
    } else {
      const want = sha(p.sha);
      if (!(await hasCommits(clone, [want])).length) throw new Error(`snapshot ${want.slice(0, 8)} isn't in this Mac's clone`);
      await git(clone, ["update-ref", ref, want]);
    }
    const got = await git(clone, ["rev-parse", "--verify", ref]);
    this.saveMirror(roomId, sessionId, { sha: got, takenAt: await takenAtOf(clone, got), repo: clone, from: ctx.from, at: this.now() });
    this.changed();
    return { sha: got };
  }

  /** New bytes of a teammate's conversation: appended when they start where this copy ends; either way, what's held is answered. */
  private async onTranscript(p: any, ctx: RequestContext): Promise<{ have: number }> {
    const { roomId, sessionId } = this.requestFor(p, ctx);
    const agent = agentOf(p.agent);
    const conversationId = text(p.conversationId, "conversationId", 100, 1);
    if (!CONV_ID_RE.test(conversationId)) throw new Error("bad conversation id");
    const file = text(p.file, "file", 200, 1);
    const named = agent === "codex" ? ROLLOUT_NAME_RE.exec(file)?.[1] : file === `${conversationId}.jsonl` ? conversationId : null;
    if (named !== conversationId) throw new Error(`${file} isn't conversation ${conversationId}'s transcript`);
    if (!Number.isSafeInteger(p.offset) || p.offset < 0 || !Number.isSafeInteger(p.total) || p.total < 0) throw new Error("bad offset");
    const data = text(p.data, "data", Math.ceil(TRANSCRIPT_CHUNK / 3) * 4 + 4);
    const ownerCwd = text(p.ownerCwd, "ownerCwd", 1000, 1);
    const dir = this.transcriptDir(roomId, sessionId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, file);
    if (p.reset === true && p.offset === 0) await fs.promises.rm(target, { force: true });
    let have = await fileSize(target);
    if (p.offset !== have) return { have };
    const bytes = Buffer.from(data, "base64");
    if (bytes.length) await fs.promises.appendFile(target, bytes, { mode: 0o600 });
    have += bytes.length;
    const meta: TranscriptMeta = { agent, conversationId, file, ownerCwd, total: Math.max(p.total, have), from: ctx.from, updatedAt: this.now() };
    writeFileAtomic(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), 0o600);
    this.changed();
    return { have };
  }

  /** A request's room and session, refused when it doesn't come from the session's owner. */
  private requestFor(p: any, ctx: RequestContext): { roomId: RoomId; sessionId: string } {
    if (!p || typeof p !== "object") throw new Error("no parameters");
    // the transport checked membership of the room the request named: it must be this one
    if (!ctx.roomId || p.roomId !== ctx.roomId) throw new Error("the request doesn't name its room");
    const sessionId = sessionIdOf(p.sessionId);
    const known = this.d.team.room(ctx.roomId)?.ext.takeover?.sessions[sessionId];
    if (known && known.owner !== ctx.from) throw new Error(`session ${sessionId} isn't ${this.nameOf(ctx.roomId, ctx.from)}'s`);
    if (known?.takenOver) throw new Error(`session ${sessionId} was taken over`);
    return { roomId: ctx.roomId, sessionId };
  }

  private onTakenOver(e: RoomEvent<"session.takenOver">, room: RoomState): void {
    const s = room.ext.takeover?.sessions[e.body.sessionId];
    // only the take-over the room settled on counts
    if (s?.takenOver?.by === e.author && e.body.from === this.d.team.self.id) {
      try {
        this.d.onTakenOver?.(e.body.sessionId, this.nameOf(room.id, e.author));
      } catch (err) {
        this.d.log(`team: telling about the take-over of session ${e.body.sessionId}`, err);
      }
    }
    this.changed();
  }

  // ---- taking over (teammate) ----------------------------------------------------------------

  /** What a take-over would use, for the confirm dialog: the clone, the newest snapshot, whether the whole conversation is here. */
  async plan(roomId: RoomId, sessionId: string, clonePath?: string | null): Promise<TakeoverPlan> {
    const b = this.backupOf(roomId, sessionId);
    const clone = clonePath ? await this.checkClone(clonePath, b.session.originUrl) : await this.cloneFor(b.session.originUrl, true);
    const base = {
      roomId,
      sessionId,
      title: b.session.title,
      agent: b.session.agent,
      branch: b.session.branch,
      ownerName: this.nameOf(roomId, b.owner),
      ownerOnline: this.d.team.presence(roomId).includes(b.owner),
      originUrl: b.session.originUrl,
      conversation: this.conversationPlan(roomId, b),
    };
    if (!clone) return { ...base, clone: null, snapshot: null, other: null, originProblem: null, latestMissing: true };
    const { pick, other, originProblem } = await this.snapshotsFor(clone, roomId, b);
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
   * Mac's account, and the room told.
   */
  async takeOver(roomId: RoomId, sessionId: string, clonePath?: string | null): Promise<TakeoverResult> {
    const k = `${roomId}\n${sessionId}`;
    if (this.taking.has(k)) throw new Error("This session is already being taken over");
    this.taking.add(k);
    try {
      const plan = await this.plan(roomId, sessionId, clonePath);
      if (!plan.clone) throw new Error(`No clone of ${plan.originUrl} was found among your repositories — choose yours`);
      const snap = plan.snapshot;
      if (!snap) {
        throw new Error(
          `No snapshot of this session reached this Mac or origin${plan.originProblem ? ` (reading origin failed: ${plan.originProblem})` : ""} — it's only on ${plan.ownerName}'s laptop`
        );
      }
      const b = this.backupOf(roomId, sessionId);
      const base = (await git(plan.clone, ["rev-parse", "--verify", "-q", `${snap.sha}^1`], { okCodes: [0, 1] })) || null;
      if (!base) throw new Error("The snapshot has no parent commit (the repository had no commits yet), so there's no branch to continue");
      const wt = await worktreeAt(plan.clone, b.session.branch, base);
      await checkoutSnapshotFiles(wt.path, snap.sha);
      const carried = await this.carryConversation(roomId, b, plan, wt.path);
      const req: NewSessionRequest = {
        repoPath: plan.clone,
        cwd: wt.path,
        branchName: wt.branch ?? undefined,
        useWorktree: false,
        agent: b.session.agent,
        title: b.session.title,
        taskGroup: this.d.host.groupOf(roomId) ?? undefined,
        ...carried.req,
      };
      let info: SessionInfo;
      try {
        info = await this.d.launch(req);
      } catch (err) {
        throw new Error(`The work is restored in ${wt.path}, but the session didn't start: ${(err as Error).message}`);
      }
      const snapshot = { sha: snap.sha, takenAt: snap.takenAt, source: snap.source };
      try {
        this.d.team.publish(roomId, "session.takenOver", { sessionId, from: b.owner, newSessionId: info.id, snapshot, conversation: carried.carried, branch: wt.branch });
      } catch (err) {
        throw new Error(`The session runs here now (in ${wt.path}), but the room couldn't be told, so ${plan.ownerName}'s copy still shows as live: ${(err as Error).message}`);
      }
      this.changed();
      return { sessionId: info.id, cwd: wt.path, branch: wt.branch, renamedFrom: wt.renamedFrom, snapshot, conversation: carried.carried };
    } finally {
      this.taking.delete(k);
    }
  }

  /** The peer copy and origin's backup in this clone, the newest picked (ties go to the one the room last announced). */
  private async snapshotsFor(clone: string, roomId: RoomId, b: RoomSessionBackup): Promise<{ pick: Candidate | null; other: Candidate | null; originProblem: string | null }> {
    const ref = roomBackupRef(roomId, b.sessionId);
    const found: Candidate[] = [];
    const mirrored = this.local(roomId).mirrored[b.sessionId];
    const peerSha = (await git(clone, ["rev-parse", "--verify", "-q", ref], { okCodes: [0, 1] })) || null;
    if (peerSha && (!mirrored || mirrored.from === b.owner)) found.push({ sha: peerSha, takenAt: await takenAtOf(clone, peerSha), source: "peer" });
    let originProblem: string | null = null;
    const copy = roomBackupRef(roomId, b.sessionId, ORIGIN_COPY_ROOT);
    try {
      await git(clone, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", `+${ref}:${copy}`], { timeoutMs: this.d.fetchTimeoutMs ?? 30_000 });
      const got = await git(clone, ["rev-parse", "--verify", copy]);
      found.push({ sha: got, takenAt: await takenAtOf(clone, got), source: "origin" });
    } catch (err) {
      const msg = withoutCredentials((err as Error).message);
      // origin never got a backup of this session: nothing to compare, unless the room says it did
      if (!/couldn't find remote ref/i.test(msg) || b.pushed) {
        originProblem = msg.replace(/\s+/g, " ").trim().slice(0, 300);
        this.d.log(`team: reading origin's backup of session ${b.sessionId}`, originProblem);
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

  private async carryConversation(roomId: RoomId, b: RoomSessionBackup, plan: TakeoverPlan, cwd: string): Promise<{ req: Partial<NewSessionRequest>; carried: ConversationCarried }> {
    const meta = this.transcriptMeta(roomId, b.sessionId);
    const file = meta ? path.join(this.transcriptDir(roomId, b.sessionId), meta.file) : null;
    if (plan.conversation.kind === "full" && meta && file) {
      // the CLI started in the new worktree sees its real path: that's the one it looks under and records
      const to = realpathOr(cwd);
      const moved = rebaseTranscript(await fs.promises.readFile(file, "utf8"), meta.agent, [...new Set([b.session.cwd, meta.ownerCwd])], to);
      const dest = meta.agent === "codex" ? codexRolloutPath(meta.file, this.codexSessions) : path.join(claudeProjectDir(to, this.claudeProjects), `${meta.conversationId}.jsonl`);
      // a longer copy already here is this conversation carried on on this Mac: resume that one
      if (fileSizeSync(dest) <= Buffer.byteLength(moved)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        writeFileAtomic(dest, moved, 0o600);
      } else this.d.log(`team: taking over session ${b.sessionId}`, `${dest} already holds a longer copy of the conversation; resuming it`);
      return { req: { resumeSessionId: meta.conversationId }, carried: "full" };
    }
    const lines = file && meta && fileSizeSync(file) ? await transcriptLines(file) : [];
    const digest = lines.length ? transcriptDigest(lines, meta!.agent, meta!.conversationId) : "";
    const room = this.d.team.room(roomId);
    const initialPrompt = takeoverKickoff({
      owner: this.nameOf(roomId, b.owner),
      taker: room ? this.nameOf(roomId, this.d.team.self.id) : "a teammate",
      agent: b.session.agent,
      title: b.session.title,
      digest,
      repo: await repoState(cwd),
      partial: !!digest,
    });
    return { req: { initialPrompt }, carried: digest ? "digest" : "none" };
  }

  // ---- the window's view ----------------------------------------------------------------------

  view(): TakeoverView {
    const sessions: RoomSessionBackupView[] = [];
    for (const room of this.d.team.rooms()) {
      const online = new Set(this.d.team.presence(room.id));
      const mirrored = this.local(room.id).mirrored;
      for (const b of Object.values(room.ext.takeover?.sessions ?? {})) {
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
          transcript: meta ? { have: fileSizeSync(path.join(this.transcriptDir(room.id, b.sessionId), meta.file)), of: sameConv ? Math.max(meta.total, b.transcriptBytes ?? 0) : null } : null,
          problem: this.problems.get(b.sessionId) ?? null,
        });
      }
    }
    const list = (m: Map<string, { roomId: RoomId; title: string; problem: string }>) => [...m].map(([sessionId, u]) => ({ sessionId, ...u }));
    return { sessions, unbacked: list(this.unbacked), cleanup: list(this.cleanupProblems) };
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
    const cached = this.ownFiles.get(id);
    if (cached && fs.existsSync(cached)) return cached;
    const file = agent === "codex" ? codexRolloutOf(id, this.codexSessions) : claudeTranscriptOf(id, cwd, this.claudeProjects);
    if (file) this.ownFiles.set(id, file);
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
      s = v && v.v === 1 ? { v: 1, own: v.own ?? {}, mirrored: v.mirrored ?? {} } : { v: 1, own: {}, mirrored: {} };
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
    return this.d.team.room(roomId)?.members.find((m) => m.id === id)?.name || "a teammate";
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
