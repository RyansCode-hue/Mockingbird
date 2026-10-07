import * as os from "os";
import * as path from "path";
import { git } from "../git";
import { worktreeState } from "../worktrees";
import { readJsonOrSetAside, writeFileAtomic } from "../fileOps";
import { roomWaitingNotice, shouldNotify } from "../notifications";
import { roomSecretReads } from "../secrets";
import { splitGroupKey, topOfKey, type SessionInfo, type Settings, type WorktreeStateInfo } from "../../shared/types";
import { isMouseReports, isTermReply } from "../../shared/termInput";
import {
  decodePtyChunk,
  encodePtyChunk,
  isRemotePaneId,
  LIVE_METHODS,
  parseRoomSessionKey,
  ptyChannel,
  remotePaneId,
  roomSessionKey,
  VIEW_CHANNEL,
  type LivePanesState,
  type MemberView,
  type PaneSnapshot,
  type PtyChunk,
  type RoomGitState,
  type RoomSessionRecord,
  type RoomSessionState,
  type RoomSessionTag,
  type ViewMessage,
} from "../../shared/team/livePanes";
import type { MemberId, RoomId, RoomState } from "../../shared/team/types";
import type { LaunchTarget, RemotePanes, RoomLaunch, SessionManager } from "../sessions";
import { MAX_STREAM_CHUNK, splitText } from "./frames";
import { roomAgentContext } from "./planService";
import { PLAN_CONTEXT_ENV, PLAN_TOOL } from "../../shared/team/plan";
import { TEAM_DIR } from "./identity";
import { CoauthorTurns, COAUTHORS_DIR, ensureHooks, hooksEnv, HOOKS_DIR } from "./coauthors";
import { gitOf, memberName, originIdentity, recordFor, setRoomSessionLookup, turnEnded } from "./roomSessions";
import { TeamError, type Team, type TeamStream } from "./transport";

/**
 * Live panes (docs/team-rooms.md, "Sessions in a room"): this install's room
 * sessions published to their rooms and streamed to teammates who show them,
 * and teammates' room sessions shown here, typed into, and notified about.
 *
 * Owner side: each room session's record goes to the room log (coalesced:
 * waiting and closing go out at once, other changes at most once a second).
 * Its pty output is streamed on "pty:<id>" while a connected teammate shows
 * it — their view says so (or they just asked for its scrollback). A
 * teammate's keystrokes arrive as pty.input requests and are written into the
 * pty; the terminal's automatic answers never are.
 *
 * Viewer side: a teammate's session is a pane here (remotePaneId). Its
 * scrollback comes by pty.scrollback; live output follows on the stream, each
 * chunk saying where it starts in the owner's pty output, so a missed chunk
 * (congestion, a reconnect, the owner restarting it) is noticed and the
 * scrollback fetched again. Typing goes to the owner; resizing never does —
 * the pane renders at the owner's terminal size.
 *
 * Views: every member tells each room which of its sessions it shows and
 * which it's in (the "view" stream, again every few seconds), for the
 * sidebar's presence initials, Follow, and deciding what to stream. Views are
 * ephemeral; nothing about them is stored.
 */

export interface LivePanesDeps {
  team: () => Team | null;
  /** Rooms this install is in, with the local top-level group each is shown as. */
  rooms: () => { id: RoomId; groupKey: string }[];
  sessions: SessionManager;
  settings: () => Settings;
  /** A desktop notification; clicking it brings up the pane `paneId`. */
  notify: (title: string, body: string, paneId: string) => void;
  toWindow: (channel: string, ...args: unknown[]) => void;
  /** A line in the pty audit log (Store.audit). */
  audit: (line: string) => void;
  log: (context: string, err: unknown) => string;
  gitState?: (cwd: string) => Promise<WorktreeStateInfo>;
  /** The repository's origin URL, or null when it has none. */
  originOf?: (repoPath: string) => Promise<string | null>;
  /** This install's git email, for teammates' Co-authored-by trailers. */
  gitEmail?: () => Promise<string | null>;
  /** What an agent in a room starts knowing about its plan board (default: the plan service's roomAgentContext). */
  agentContext?: (roomId: RoomId) => string;
  /** Where per-person settings for teammates' sessions (mutes) are kept. */
  dir?: string;
  hooksDir?: string;
  coauthorsDir?: string;
  now?: () => number;
  timing?: Partial<Timing>;
}

interface Timing {
  /** A record's changes go out at most this often (waiting and closing at once). */
  publishMs: number;
  /** Output is gathered this long before a stream write. */
  batchMs: number;
  /** Views are sent again this often. */
  heartbeatMs: number;
  /** A teammate's view not heard again in this long is dropped. */
  viewTtlMs: number;
  /** Asking for a session's scrollback counts as showing it for this long. */
  leaseMs: number;
  /** Scrollback is fetched again at most this often per pane. */
  resyncMs: number;
  gitMs: number;
}

const TIMING: Timing = { publishMs: 1000, batchMs: 10, heartbeatMs: 5000, viewTtlMs: 20_000, leaseMs: 20_000, resyncMs: 2000, gitMs: 30_000 };
const NO_GUARDS = { secrets: false, coauthors: false };
/** A stream message carries one chunk with its header; the transport would split longer ones. */
const PIECE = MAX_STREAM_CHUNK - 256;
const MIRROR_MAX = 400_000;
const MAX_INPUT = 64 * 1024;
const MAX_VIEW_KEYS = 200;

/** A teammate's session, as this install keeps up with it. */
interface PaneSync {
  /** The owner's pty this copy follows; null until a scrollback arrived. */
  epoch: string | null;
  /** Where the next chunk should start. */
  expected: number;
  /** What it last showed, for when the owner is offline. */
  mirror: string;
  inflight: Promise<string> | null;
  /** Chunks that arrived while the scrollback was on its way. */
  pending: PtyChunk[];
  lastFetch: number;
  /** The window has a terminal for it (it asked for its scrollback). */
  attached: boolean;
  watched: boolean;
  problem?: string;
  resyncTimer?: ReturnType<typeof setTimeout>;
}

interface Remote {
  paneId: string;
  roomId: RoomId;
  groupKey: string;
  rec: RoomSessionState;
}

type ViewsByRoom = Map<RoomId, { msg: ViewMessage; at: number }>;

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class LivePanes implements RemotePanes {
  private readonly t: Timing;
  private readonly now: () => number;
  private readonly coauthors: CoauthorTurns;
  private hooksReady = false;
  private started = false;
  private offs: (() => void)[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];

  // owner side
  /** Last published record per `${roomId}\n${sessionId}`. */
  private published = new Map<string, { rec: RoomSessionRecord; at: number }>();
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private gitStates = new Map<string, RoomGitState | null>();
  private origins = new Map<string, string | null>();
  /** Teammates who asked for a session's scrollback, until when. */
  private leases = new Map<string, Map<MemberId, number>>();
  /** This install's sessions some connected teammate shows. */
  private watchedOwn = new Set<string>();
  private batches = new Map<string, { roomId: RoomId; epoch: string; pos: number; data: string; timer: ReturnType<typeof setTimeout> | null }>();
  private streams = new Map<string, TeamStream>();
  private dropping = new Set<string>();

  // viewer side
  private remotes = new Map<string, Remote>();
  private panes = new Map<string, PaneSync>();
  private views = new Map<MemberId, ViewsByRoom>();
  private myView: { shown: string[]; focused: string | null } = { shown: [], focused: null };
  private sentViews = new Map<RoomId, { text: string; at: number }>();
  private inputQueue = new Map<string, string>();
  private inputScheduled = false;
  private muted = new Set<string>();
  private notified = new Map<string, number | null>();
  private lastNotice = new Map<string, number>();
  private email: string | null = null;
  private problems: string[] = [];
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private roomCache: { id: RoomId; groupKey: string }[] | null = null;
  /** This install's sessions' rooms, until a session or a room changes. */
  private ownRooms: Map<string, RoomId | null> | null = null;

  constructor(private d: LivePanesDeps) {
    this.t = { ...TIMING, ...d.timing };
    this.now = d.now ?? Date.now;
    this.coauthors = new CoauthorTurns(d.coauthorsDir ?? COAUTHORS_DIR, { now: this.now, log: (m, e) => this.d.log(`team: ${m}`, e) });
  }

  private get mutedFile() {
    return path.join(this.d.dir ?? TEAM_DIR, "live-muted.json");
  }

  /** Begin: after the team transport has started. Without one, room sessions stay local and nothing is shared. */
  start(): void {
    if (this.started) return;
    const team = this.d.team();
    if (!team) {
      this.problem("Team rooms aren't running, so sessions in shared groups aren't shared");
      return;
    }
    this.started = true;
    try {
      ensureHooks(this.d.hooksDir ?? HOOKS_DIR, this.d.coauthorsDir ?? COAUTHORS_DIR);
      this.hooksReady = true;
    } catch (err) {
      this.problem(`Commits in room sessions won't credit teammates: the git hooks couldn't be written (${errText(err)})`, err);
    }
    try {
      const saved = readJsonOrSetAside(this.mutedFile, [], "muted teammates' sessions");
      if (Array.isArray(saved)) for (const id of saved) if (typeof id === "string" && isRemotePaneId(id)) this.muted.add(id);
    } catch (err) {
      this.problem(`Couldn't read which teammates' sessions are muted: ${errText(err)}`, err);
    }
    const s = this.d.sessions;
    s.remote = this;
    s.roomLaunch = (target) => this.roomLaunch(target);
    setRoomSessionLookup(this);

    this.offs.push(
      team.onRoomsChanged(() => {
        this.roomCache = null;
        this.ownRooms = null;
        this.indexRemotes();
        this.schedule(50);
        this.changed();
      }),
      team.onEvent("session.upsert", (e, room) => this.heardUpsert(e.author, e.body, room)),
      team.onPresence((roomId, online) => this.presenceChanged(roomId, online)),
      team.onStream("pty:*", (chunk, ctx) => this.heardChunk(chunk, ctx.roomId, ctx.from)),
      team.onStream(VIEW_CHANNEL, (chunk, ctx) => this.heardView(chunk, ctx.roomId, ctx.from)),
      team.onRequest(LIVE_METHODS.scrollback, (params, ctx) => this.answerScrollback(params, ctx.from, ctx.roomId)),
      team.onRequest(LIVE_METHODS.input, (params, ctx) => this.answerInput(params, ctx.from, ctx.roomId)),
      s.watch(() => {
        this.ownRooms = null;
        this.schedule(50);
        this.changed();
      }),
      s.onOutput((id, data, end, epoch) => this.output(id, data, end, epoch)),
      s.onStatusChanged((info, before) => this.statusChanged(info, before))
    );
    this.timers.push(setInterval(() => this.tick(), this.t.heartbeatMs), setInterval(() => this.pollGit(), this.t.gitMs));
    for (const t of this.timers) t.unref?.();
    (this.d.gitEmail ?? defaultGitEmail)().then(
      (e) => (this.email = e),
      (err) => this.d.log("team: reading your git email for teammates' commit trailers", err)
    );
    this.seedPublished(team);
    this.indexRemotes();
    // waits already showing when this starts were notified before (or are stale): only new ones notify
    for (const r of this.remotes.values()) if (r.rec.status === "waiting") this.notified.set(r.paneId, r.rec.waitingSince);
    this.schedule(0);
    void this.pollGit();
    this.changed();
  }

  stop(): void {
    if (!this.started) return;
    for (const id of [...this.batches.keys()]) this.flush(id); // output gathered for teammates goes out first
    this.started = false;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
    for (const off of this.offs.splice(0)) off();
    for (const t of this.timers.splice(0)) clearInterval(t);
    for (const p of this.panes.values()) if (p.resyncTimer) clearTimeout(p.resyncTimer);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    const s = this.d.sessions;
    if (s.remote === this) s.remote = null;
    s.roomLaunch = null;
    setRoomSessionLookup(null);
  }

  // ---- rooms and sessions ---------------------------------------------------------------

  private team(): Team | null {
    return this.started ? this.d.team() : null;
  }

  private rooms(): { id: RoomId; groupKey: string }[] {
    if (!this.roomCache) {
      try {
        this.roomCache = this.d.rooms();
      } catch (err) {
        this.d.log("team: listing rooms for live panes", err);
        return [];
      }
    }
    return this.roomCache;
  }

  private roomForGroup(top: string): RoomId | null {
    return this.rooms().find((r) => r.groupKey === top)?.id ?? null;
  }

  private groupOfRoom(roomId: RoomId): string | null {
    return this.rooms().find((r) => r.id === roomId)?.groupKey ?? null;
  }

  /** The room one of this install's sessions is shared in (live or resumable), or null. */
  roomOfSession(id: string): RoomId | null {
    if (!this.started) return null;
    if (!this.ownRooms) {
      this.ownRooms = new Map();
      for (const s of [...this.d.sessions.list(), ...this.d.sessions.resumable()]) if (!this.ownRooms.has(s.id)) this.ownRooms.set(s.id, this.roomOfInfo(s));
    }
    return this.ownRooms.get(id) ?? null;
  }

  private roomOfInfo(s: SessionInfo): RoomId | null {
    if (s.debrief) return null;
    return this.roomForGroup(topOfKey(s.taskGroup ?? "ungrouped"));
  }

  /**
   * What a session starting in a shared group gets: secret reads denied
   * (Claude), its commits credit teammates, and an agent starts knowing the
   * room's plan board, with its tool allowed.
   */
  roomLaunch(target: LaunchTarget): RoomLaunch | null {
    const roomId = target.group ? this.roomForGroup(splitGroupKey(target.group).top) : null;
    if (!roomId) return null;
    let denyReads: string[] = [];
    if (target.agent === "claude") {
      const secrets = roomSecretReads(this.d.settings().workTrackerPath);
      if (secrets.problem) this.problem(secrets.problem);
      denyReads = secrets.rules;
    }
    let instructions: string | null = null;
    if (target.agent) {
      try {
        instructions = (this.d.agentContext ?? roomAgentContext)(roomId);
      } catch (err) {
        // the SessionStart hook adds the board from the worktree's copy instead
        this.d.log(`team: the plan board for session ${target.id}'s launch`, err);
      }
    }
    return {
      env: { ...(this.hooksReady ? hooksEnv(this.d.hooksDir ?? HOOKS_DIR) : {}), ...(instructions ? { [PLAN_CONTEXT_ENV]: "1" } : {}) },
      denyReads,
      instructions,
      allowTools: target.agent === "claude" ? [PLAN_TOOL] : [],
      guards: { secrets: target.agent === "claude", coauthors: this.hooksReady },
    };
  }

  // ---- owner: records ----------------------------------------------------------------------

  /** What this install published before (in the room log) is what it compares against. */
  private seedPublished(team: Team): void {
    for (const room of team.rooms()) {
      for (const st of Object.values(room.ext.sessions ?? {})) {
        if (st.owner !== team.self.id) continue;
        const { owner: _o, at: _a, ...rec } = st;
        this.published.set(`${room.id}\n${st.id}`, { rec, at: 0 });
      }
    }
  }

  private schedule(ms: number): void {
    if (!this.started) return;
    if (this.reconcileTimer) {
      if (ms > 0) return;
      clearTimeout(this.reconcileTimer);
    }
    this.reconcileTimer = setTimeout(() => this.reconcile(), ms);
  }

  /** Publish what changed about this install's room sessions, and remove the ones that left. */
  private reconcile(): void {
    this.reconcileTimer = null;
    const team = this.team();
    if (!team) return;
    const now = this.now();
    const want = new Map<string, { roomId: RoomId; rec: RoomSessionRecord }>();
    const add = (info: SessionInfo, live: boolean) => {
      const roomId = this.roomOfInfo(info);
      if (!roomId) return;
      if (info.repoPath && !this.origins.has(info.repoPath)) this.lookUpOrigin(info.repoPath);
      const out = live ? this.d.sessions.paneOutput(info.id) : null;
      const rec = recordFor(info, {
        live,
        repo: info.repoPath ? this.origins.get(info.repoPath) ?? null : null,
        cols: out?.cols ?? 120,
        rows: out?.rows ?? 32,
        guards: (live && this.d.sessions.guardsOf(info.id)) || NO_GUARDS,
        git: live ? this.gitStates.get(info.id) ?? null : null,
      });
      want.set(`${roomId}\n${info.id}`, { roomId, rec });
    };
    for (const s of this.d.sessions.list()) add(s, true);
    for (const s of this.d.sessions.resumable()) if (!want.has(`${this.roomOfInfo(s)}\n${s.id}`)) add(s, false);
    let next = Infinity;
    for (const [k, { roomId, rec }] of want) {
      const prev = this.published.get(k);
      if (prev && sameJson(prev.rec, rec)) continue;
      const urgent = !prev || prev.rec.live !== rec.live || (prev.rec.status !== rec.status && (rec.status === "waiting" || prev.rec.status === "waiting"));
      const due = (prev?.at ?? 0) + this.t.publishMs;
      if (!urgent && due > now) {
        next = Math.min(next, due);
        continue;
      }
      if (this.publish(team, roomId, "session.upsert", rec)) this.published.set(k, { rec, at: now });
    }
    for (const k of [...this.published.keys()]) {
      if (want.has(k)) continue;
      const [roomId, id] = k.split("\n");
      if (this.publish(team, roomId, "session.removed", { id })) this.published.delete(k);
      if (![...want.keys()].some((w) => w.endsWith(`\n${id}`))) this.coauthors.forget(id);
    }
    if (next < Infinity) this.schedule(Math.max(1, next - now));
  }

  private publish<K extends "session.upsert" | "session.removed">(team: Team, roomId: RoomId, type: K, body: K extends "session.upsert" ? RoomSessionRecord : { id: string }): boolean {
    try {
      team.publish(roomId, type, body as never);
      return true;
    } catch (err) {
      if (err instanceof TeamError && err.code === "not-member") {
        // the room is gone from this install: nothing to tell it any more
        this.published.forEach((_v, k) => k.startsWith(`${roomId}\n`) && this.published.delete(k));
        return false;
      }
      this.problem(`Couldn't tell the room about session ${(body as { id: string }).id}: ${errText(err)}`, err);
      return false;
    }
  }

  private lookUpOrigin(repoPath: string): void {
    this.origins.set(repoPath, null);
    (this.d.originOf ?? defaultOriginOf)(repoPath).then(
      (url) => {
        this.origins.set(repoPath, url ? originIdentity(url) : null);
        this.schedule(0);
      },
      (err) => this.d.log(`team: reading ${repoPath}'s origin`, err)
    );
  }

  private async pollGit(only?: string): Promise<void> {
    if (!this.started) return;
    const read = this.d.gitState ?? worktreeState;
    for (const s of this.d.sessions.list()) {
      if ((only && s.id !== only) || !s.repoPath || s.status === "dead" || !this.roomOfInfo(s)) continue;
      let next: RoomGitState | null = null;
      try {
        next = gitOf(await read(s.cwd));
      } catch (err) {
        if (this.gitStates.get(s.id) !== null) this.d.log(`team: reading git state for room session ${s.id}`, err);
      }
      if (!sameJson(this.gitStates.get(s.id) ?? null, next) || !this.gitStates.has(s.id)) {
        this.gitStates.set(s.id, next);
        this.schedule(0);
      }
    }
  }

  private statusChanged(info: SessionInfo, before: SessionInfo["status"]): void {
    const roomId = this.roomOfSession(info.id);
    if (!roomId) return;
    const drivers = this.coauthors.statusChanged(info.id, before, info.status);
    if (!drivers) return;
    turnEnded({ sessionId: info.id, roomId, status: info.status, drivers });
    void this.pollGit(info.id);
  }

  // ---- owner: streaming ----------------------------------------------------------------------

  private output(id: string, data: string, end: number, epoch: string): void {
    if (!this.watchedOwn.has(id)) return;
    let b = this.batches.get(id);
    if (b && b.epoch !== epoch) {
      this.flush(id);
      b = undefined;
    }
    if (!b) {
      const roomId = this.roomOfSession(id);
      if (!roomId) return;
      b = { roomId, epoch, pos: end - data.length, data: "", timer: null };
      this.batches.set(id, b);
    }
    b.data += data;
    if (b.data.length >= 4 * PIECE) return this.flush(id);
    b.timer ??= setTimeout(() => this.flush(id), this.t.batchMs);
  }

  private flush(id: string): void {
    const b = this.batches.get(id);
    if (!b) return;
    this.batches.delete(id);
    if (b.timer) clearTimeout(b.timer);
    const team = this.team();
    if (!team || !b.data) return;
    try {
      const key = `${b.roomId}\n${id}`;
      let stream = this.streams.get(key);
      if (!stream) this.streams.set(key, (stream = team.stream(b.roomId, ptyChannel(id))));
      let pos = b.pos;
      let dropped = false;
      for (const piece of splitText(b.data, PIECE)) {
        if (!stream.write(encodePtyChunk({ session: id, epoch: b.epoch, pos, data: piece }))) dropped = true;
        pos += piece.length;
      }
      // teammates notice the hole by its position and fetch the scrollback; said once per spell
      if (dropped && !this.dropping.has(id)) this.d.log("team", `session ${id}'s output is being dropped for a congested teammate; they'll catch up from its scrollback`);
      if (dropped) this.dropping.add(id);
      else this.dropping.delete(id);
    } catch (err) {
      if (!(err instanceof TeamError && err.code === "not-member")) this.d.log(`team: streaming session ${id}`, err);
    }
  }

  /** Which of this install's sessions a connected teammate shows (their view, or a recent scrollback request). */
  private recomputeWatched(): void {
    const team = this.team();
    const next = new Set<string>();
    if (team) {
      const now = this.now();
      for (const s of this.d.sessions.list()) {
        const roomId = this.roomOfInfo(s);
        if (!roomId) continue;
        const key = roomSessionKey(team.self.id, s.id);
        for (const m of team.presence(roomId)) {
          const v = this.views.get(m)?.get(roomId);
          if (v?.msg.watching.includes(key) || (this.leases.get(s.id)?.get(m) ?? 0) > now) next.add(s.id);
        }
      }
    }
    for (const id of this.watchedOwn) if (!next.has(id)) this.flush(id);
    this.watchedOwn = next;
  }

  /** The room session `session` of this install's, when `from` may see it in `roomId`. */
  private ownRoomSession(params: unknown, roomId: RoomId | undefined): SessionInfo {
    const id = (params as { session?: unknown })?.session;
    if (typeof id !== "string" || !roomId) throw new Error("name a session and its room");
    const s = this.d.sessions.list().find((x) => x.id === id);
    if (!s || this.roomOfInfo(s) !== roomId) throw new Error("that session isn't running in this room");
    return s;
  }

  private answerScrollback(params: unknown, from: MemberId, roomId: RoomId | undefined): PaneSnapshot {
    const s = this.ownRoomSession(params, roomId);
    const out = this.d.sessions.paneOutput(s.id);
    if (!out) throw new Error("that session isn't running");
    const leases = this.leases.get(s.id) ?? new Map<MemberId, number>();
    leases.set(from, this.now() + this.t.leaseMs);
    this.leases.set(s.id, leases);
    // output gathered but not yet sent goes out first; the asker's copy skips what the snapshot already holds
    this.flush(s.id);
    this.recomputeWatched();
    return out;
  }

  private answerInput(params: unknown, from: MemberId, roomId: RoomId | undefined): { ok: true } {
    const s = this.ownRoomSession(params, roomId);
    const p = params as { data?: unknown; email?: unknown };
    if (typeof p.data !== "string" || !p.data || p.data.length > MAX_INPUT) throw new Error("typing must be text of up to 64 KB");
    const room = this.d.team()?.room(roomId!);
    const name = room ? memberName(room.members, from) : from.slice(0, 8);
    const data = p.data;
    if (isTermReply(data)) {
      // a terminal's automatic answer is never a teammate's typing
      this.d.audit(`dropped-remote-reply session=${s.id} from=${JSON.stringify(name)} bytes=${JSON.stringify(data.slice(0, 300))}`);
      return { ok: true };
    }
    if (/[\r\x03]/.test(data)) this.d.audit(`remote-input session=${s.id} from=${JSON.stringify(name)} bytes=${JSON.stringify(data.slice(-300))}`);
    this.d.sessions.write(s.id, data);
    if (!isMouseReports(data)) {
      const email = typeof p.email === "string" ? p.email.slice(0, 200) : null;
      this.coauthors.typed(s.id, { id: from, name, email }, s.status, !s.shell);
    }
    return { ok: true };
  }

  /** Who drives a room session's current turn (teammates who typed into it). */
  drivers(sessionId: string) {
    return this.coauthors.drivers(sessionId);
  }

  // ---- viewer: teammates' sessions ------------------------------------------------------------

  private indexRemotes(): void {
    const team = this.team();
    const next = new Map<string, Remote>();
    if (team) {
      for (const room of team.rooms()) {
        const groupKey = this.groupOfRoom(room.id);
        if (!groupKey) continue;
        for (const rec of Object.values(room.ext.sessions ?? {})) {
          if (rec.owner === team.self.id) continue;
          const paneId = remotePaneId(rec.owner, rec.id);
          next.set(paneId, { paneId, roomId: room.id, groupKey, rec });
        }
      }
    }
    for (const id of this.panes.keys()) if (!next.has(id)) this.panes.delete(id);
    this.remotes = next;
  }

  has(id: string): boolean {
    return this.remotes.has(id);
  }

  private pane(id: string): PaneSync {
    let p = this.panes.get(id);
    if (!p) this.panes.set(id, (p = { epoch: null, expected: 0, mirror: "", inflight: null, pending: [], lastFetch: 0, attached: false, watched: false }));
    return p;
  }

  private online(r: Remote): boolean {
    return this.team()?.presence(r.roomId).includes(r.rec.owner) ?? false;
  }

  /** The window opened a terminal for a teammate's session: its scrollback, from the owner (or what it last showed, when the owner is offline). */
  async buffer(id: string): Promise<string> {
    const r = this.remotes.get(id);
    if (!r) return "";
    const p = this.pane(id);
    p.attached = true;
    if (!r.rec.live || !this.online(r)) {
      const who = memberNameIn(this.team(), r.roomId, r.rec.owner);
      const note = r.rec.live ? `${who}'s Mockingbird is offline` : `${who} closed this session`;
      return `${p.mirror}${p.mirror ? "\r\n" : ""}\x1b[2m── ${note} · showing what it last sent ──\x1b[0m\r\n`;
    }
    return this.fetch(id, false);
  }

  /** Fetch a pane's scrollback from its owner. A reset (the terminal is showing an older copy) clears it and writes the new one. */
  private fetch(id: string, reset: boolean): Promise<string> {
    const p = this.pane(id);
    if (p.inflight) return p.inflight;
    const r = this.remotes.get(id);
    const team = this.team();
    if (!r || !team) return Promise.resolve(p.mirror);
    p.pending = [];
    p.lastFetch = this.now();
    p.inflight = team
      .request<PaneSnapshot>(r.rec.owner, LIVE_METHODS.scrollback, { session: r.rec.id }, { roomId: r.roomId, timeoutMs: 30_000 })
      .then(
        (snap) => {
          if (!snap || typeof snap.data !== "string" || typeof snap.epoch !== "string" || !Number.isSafeInteger(snap.end)) throw new Error("the owner sent a malformed scrollback");
          p.epoch = snap.epoch;
          p.expected = snap.end;
          let out = snap.data;
          for (const c of p.pending.sort((a, b) => a.pos - b.pos)) {
            if (c.epoch !== p.epoch || c.pos > p.expected) continue; // a later chunk shows the hole
            const fresh = c.data.slice(Math.max(0, p.expected - c.pos));
            out += fresh;
            p.expected = Math.max(p.expected, c.pos + c.data.length);
          }
          p.pending = [];
          p.mirror = out.slice(-MIRROR_MAX);
          if (p.problem) this.setProblem(id, undefined);
          if (reset) this.d.toWindow("session:data", id, `\x1bc${out}`);
          return out;
        },
        (err) => {
          p.pending = [];
          const msg = `Couldn't load ${r.rec.title} from ${memberNameIn(team, r.roomId, r.rec.owner)}: ${errText(err)}`;
          this.setProblem(id, msg);
          this.d.log("team: live pane", msg);
          return reset ? "" : `${p.mirror}\r\n\x1b[2m── ${msg} ──\x1b[0m\r\n`;
        }
      )
      .finally(() => {
        p.inflight = null;
      });
    return p.inflight;
  }

  /** Fetch a pane's scrollback again (the Repaint button, a hole in its output, its owner back). */
  resync(id: string): void {
    const p = this.panes.get(id);
    const r = this.remotes.get(id);
    if (!p || !r || !p.attached || !r.rec.live || !this.online(r)) return;
    const wait = p.lastFetch + this.t.resyncMs - this.now();
    if (wait > 0) {
      p.resyncTimer ??= setTimeout(() => {
        p.resyncTimer = undefined;
        this.resync(id);
      }, wait);
      return;
    }
    void this.fetch(id, true);
  }

  private heardChunk(text: string, roomId: RoomId, from: MemberId): void {
    const c = decodePtyChunk(text);
    if (!c) return void this.d.log("team", `dropped a malformed pty chunk from ${from.slice(0, 8)}`);
    const id = remotePaneId(from, c.session);
    const r = this.remotes.get(id);
    if (!r || r.roomId !== roomId) return;
    const p = this.pane(id);
    if (p.inflight) return void p.pending.push(c);
    if (p.epoch === null) return; // nothing to follow on from yet: the first scrollback brings it
    if (c.epoch !== p.epoch || c.pos > p.expected) return this.resync(id);
    const end = c.pos + c.data.length;
    if (end <= p.expected) return; // already have it
    const fresh = c.data.slice(p.expected - c.pos);
    p.expected = end;
    p.mirror = (p.mirror + fresh).slice(-MIRROR_MAX);
    if (p.attached) this.d.toWindow("session:data", id, fresh);
  }

  write(id: string, data: string): void {
    if (!this.remotes.has(id)) return;
    this.inputQueue.set(id, (this.inputQueue.get(id) ?? "") + data);
    if (this.inputScheduled) return;
    this.inputScheduled = true;
    setImmediate(() => this.sendInput());
  }

  /** Keystrokes gathered this tick, one request per pane, in order. */
  private sendInput(): void {
    this.inputScheduled = false;
    const team = this.team();
    for (const [id, data] of this.inputQueue) {
      this.inputQueue.delete(id);
      const r = this.remotes.get(id);
      if (!r || !team) continue;
      for (const piece of splitText(data, MAX_INPUT)) {
        team.request(r.rec.owner, LIVE_METHODS.input, { session: r.rec.id, data: piece, email: this.email }, { roomId: r.roomId }).then(
          () => this.panes.get(id)?.problem?.startsWith("Couldn't type") && this.setProblem(id, undefined),
          (err) => {
            const msg = `Couldn't type into ${r.rec.title}: ${errText(err)}`;
            this.d.log("team: typing into a teammate's session", msg);
            this.setProblem(id, msg);
          }
        );
      }
    }
  }

  setMuted(id: string, muted: boolean): void {
    if (muted) this.muted.add(id);
    else this.muted.delete(id);
    writeFileAtomic(this.mutedFile, JSON.stringify([...this.muted], null, 2));
    this.changed();
  }

  private setProblem(id: string, problem: string | undefined): void {
    const p = this.pane(id);
    if (p.problem === problem) return;
    p.problem = problem;
    this.changed();
  }

  /** A teammate's record changed: tell this install's person when it's waiting on input. */
  private heardUpsert(author: MemberId, rec: RoomSessionRecord, room: RoomState): void {
    const team = this.team();
    if (!team || author === team.self.id) return;
    const paneId = remotePaneId(author, rec.id);
    const current = room.ext.sessions?.[roomSessionKey(author, rec.id)];
    if (!current || current.status !== "waiting" || !current.live) {
      this.notified.delete(paneId);
      return;
    }
    if (this.notified.has(paneId) && this.notified.get(paneId) === current.waitingSince) return;
    this.notified.set(paneId, current.waitingSince);
    if (!shouldNotify({ settings: this.d.settings(), session: { muted: this.muted.has(paneId) }, kind: "waiting", now: new Date(this.now()) })) return;
    // as for this install's own sessions: at most one notification per session per 30s
    const last = this.lastNotice.get(paneId) ?? 0;
    if (this.now() - last < 30_000) return;
    this.lastNotice.set(paneId, this.now());
    const n = roomWaitingNotice({ owner: memberName(room.members, author), title: current.ticketTitle ?? current.title, reason: current.waitingReason });
    this.d.notify(n.title, n.body, paneId);
  }

  // ---- views ---------------------------------------------------------------------------------------

  /** What this window shows (its grid) and which pane it's in. */
  setView(view: { shown?: unknown; focused?: unknown }): void {
    const shown = Array.isArray(view?.shown) ? view.shown.filter((x): x is string => typeof x === "string").slice(0, MAX_VIEW_KEYS) : [];
    const focused = typeof view?.focused === "string" ? view.focused : null;
    this.myView = { shown, focused };
    for (const [id, p] of this.panes) {
      const watched = shown.includes(id);
      if (watched && !p.watched && p.attached) this.resync(id); // it may have missed output while hidden
      p.watched = watched;
    }
    this.sendViews(false);
  }

  /** Where a session shown here lives: its room and its key there; null outside rooms. */
  private placeOf(id: string, selfId: MemberId): { roomId: RoomId; key: string; remote: boolean } | null {
    const r = this.remotes.get(id);
    if (r) return { roomId: r.roomId, key: roomSessionKey(r.rec.owner, r.rec.id), remote: true };
    const roomId = this.roomOfSession(id);
    return roomId ? { roomId, key: roomSessionKey(selfId, id), remote: false } : null;
  }

  private sendViews(heartbeat: boolean): void {
    const team = this.team();
    if (!team) return;
    const now = this.now();
    for (const room of team.rooms()) {
      const shown: string[] = [];
      const watching: string[] = [];
      let focused: string | null = null;
      for (const id of this.myView.shown) {
        const at = this.placeOf(id, team.self.id);
        if (!at || at.roomId !== room.id) continue;
        shown.push(at.key);
        if (at.remote) watching.push(at.key);
      }
      if (this.myView.focused) {
        const at = this.placeOf(this.myView.focused, team.self.id);
        if (at?.roomId === room.id) focused = at.key;
      }
      const text = JSON.stringify({ v: 1, shown, focused, watching } satisfies ViewMessage);
      const last = this.sentViews.get(room.id);
      if (last?.text === text && !(heartbeat && now - last.at >= this.t.heartbeatMs)) continue;
      if (!team.presence(room.id).length) {
        this.sentViews.delete(room.id); // nobody to tell: say it as soon as someone's back
        continue;
      }
      try {
        team.stream(room.id, VIEW_CHANNEL).write(text);
        this.sentViews.set(room.id, { text, at: now });
      } catch (err) {
        this.d.log(`team: sending what this window shows to room ${room.name}`, err);
      }
    }
  }

  private heardView(text: string, roomId: RoomId, from: MemberId): void {
    let msg: ViewMessage;
    try {
      msg = JSON.parse(text);
    } catch {
      return void this.d.log("team", `dropped a malformed view from ${from.slice(0, 8)}`);
    }
    const keys = (v: unknown) => (Array.isArray(v) ? v.filter((k): k is string => typeof k === "string" && !!parseRoomSessionKey(k)).slice(0, MAX_VIEW_KEYS) : []);
    if (msg?.v !== 1) return void this.d.log("team", `dropped a view from ${from.slice(0, 8)} in an unknown shape`);
    const clean: ViewMessage = { v: 1, shown: keys(msg.shown), focused: typeof msg.focused === "string" && parseRoomSessionKey(msg.focused) ? msg.focused : null, watching: keys(msg.watching) };
    const byRoom = this.views.get(from) ?? new Map();
    const before = byRoom.get(roomId);
    byRoom.set(roomId, { msg: clean, at: this.now() });
    this.views.set(from, byRoom);
    if (before && sameJson(before.msg, clean)) return;
    this.recomputeWatched();
    this.changed();
  }

  private presenceChanged(roomId: RoomId, online: MemberId[]): void {
    for (const [m, byRoom] of this.views) {
      if (!online.includes(m)) byRoom.delete(roomId);
      if (!byRoom.size) this.views.delete(m);
    }
    this.sentViews.delete(roomId); // newcomers hear this window's view at once
    this.sendViews(false);
    this.recomputeWatched();
    // a teammate back online: the panes this window shows of theirs catch up
    for (const r of this.remotes.values()) {
      if (r.roomId !== roomId || !online.includes(r.rec.owner)) continue;
      const p = this.panes.get(r.paneId);
      if (p?.attached && p.watched) this.resync(r.paneId);
    }
    this.changed();
  }

  private tick(): void {
    const now = this.now();
    for (const [m, byRoom] of this.views) {
      for (const [roomId, v] of byRoom) if (now - v.at > this.t.viewTtlMs) byRoom.delete(roomId);
      if (!byRoom.size) this.views.delete(m);
    }
    for (const [id, leases] of this.leases) {
      for (const [m, until] of leases) if (until <= now) leases.delete(m);
      if (!leases.size) this.leases.delete(id);
    }
    this.recomputeWatched();
    this.sendViews(true);
  }

  // ---- the window -----------------------------------------------------------------------------------

  private changed(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      try {
        this.d.toWindow("team:liveChanged", this.state());
      } catch (err) {
        this.d.log("team: sending room sessions to the window", err);
      }
    }, 50);
  }

  private problem(msg: string, err?: unknown): void {
    if (!this.problems.includes(msg)) this.problems = [...this.problems, msg].slice(-10);
    this.d.log("team: live panes", err ?? msg);
    this.changed();
  }

  /** Everything the window shows about room sessions. */
  state(): LivePanesState {
    const team = this.team();
    if (!team) return { remote: [], own: {}, views: [], problems: this.problems };
    const self = team.self.id;
    const toLocal = (key: string): string | null => {
      const k = parseRoomSessionKey(key);
      return k ? (k.owner === self ? k.id : remotePaneId(k.owner, k.id)) : null;
    };
    // who shows each session, by local id
    const lookers = new Map<string, RoomSessionTag["lookers"]>();
    const views: MemberView[] = [];
    for (const [m, byRoom] of this.views) {
      const room = [...byRoom.keys()].map((id) => team.room(id)).find(Boolean);
      const name = room ? memberName(room.members, m) : m.slice(0, 8);
      const shown: string[] = [];
      let focused: string | null = null;
      let at = 0;
      for (const v of byRoom.values()) {
        for (const key of v.msg.shown) {
          const local = toLocal(key);
          if (!local) continue;
          shown.push(local);
          const focusedHere = v.msg.focused === key;
          lookers.set(local, [...(lookers.get(local) ?? []), { id: m, name, focused: focusedHere }]);
        }
        if (v.msg.focused && v.at >= at) {
          focused = toLocal(v.msg.focused);
          at = v.at;
        }
      }
      views.push({ member: m, name, shown, focused, at: Math.max(0, ...[...byRoom.values()].map((v) => v.at)) });
    }
    const remote: SessionInfo[] = [];
    for (const r of this.remotes.values()) {
      const room = team.room(r.roomId);
      const ownerName = room ? memberName(room.members, r.rec.owner) : r.rec.owner.slice(0, 8);
      const rec = r.rec;
      const p = this.panes.get(r.paneId);
      const tag: RoomSessionTag = {
        roomId: r.roomId,
        sessionId: rec.id,
        owner: rec.owner,
        ownerName,
        remote: true,
        online: this.online(r),
        live: rec.live,
        lookers: lookers.get(r.paneId) ?? [],
        cols: rec.cols,
        rows: rec.rows,
        git: rec.git,
        repo: rec.repo,
        repoName: rec.repoName,
        guards: rec.guards,
        ...(p?.problem ? { problem: p.problem } : {}),
      };
      remote.push({
        id: r.paneId,
        title: rec.title,
        model: rec.model,
        repoPath: null,
        cwd: `(on ${ownerName}'s Mockingbird)${rec.repoName ? ` ${rec.repoName}` : ""}`,
        branch: rec.branch,
        ticketId: rec.ticketId,
        ticketTitle: rec.ticketTitle,
        taskGroup: rec.sub ? `${r.groupKey}/${rec.sub}` : r.groupKey,
        status: rec.status,
        createdAt: rec.createdAt,
        kind: "work",
        extraDirs: [],
        waitingReason: rec.waitingReason,
        waitingSince: rec.waitingSince,
        ...(rec.agent ? { agent: rec.agent } : { shell: true }),
        ...(this.muted.has(r.paneId) ? { muted: true } : {}),
        room: tag,
      });
    }
    const own: Record<string, RoomSessionTag> = {};
    const selfName = (roomId: RoomId) => {
      const room = team.room(roomId);
      return room ? memberName(room.members, self) : "you";
    };
    for (const s of [...this.d.sessions.list(), ...this.d.sessions.resumable()]) {
      if (own[s.id]) continue;
      const roomId = this.roomOfInfo(s);
      if (!roomId) continue;
      const pub = this.published.get(`${roomId}\n${s.id}`)?.rec;
      const out = this.d.sessions.paneOutput(s.id);
      own[s.id] = {
        roomId,
        sessionId: s.id,
        owner: self,
        ownerName: selfName(roomId),
        remote: false,
        online: true,
        live: !!out,
        lookers: lookers.get(s.id) ?? [],
        cols: out?.cols ?? 120,
        rows: out?.rows ?? 32,
        git: pub?.git ?? null,
        repo: pub?.repo ?? null,
        repoName: pub?.repoName ?? null,
        guards: this.d.sessions.guardsOf(s.id) ?? NO_GUARDS,
      };
    }
    return { remote, own, views, problems: this.problems };
  }
}

function memberNameIn(team: Team | null, roomId: RoomId, id: MemberId): string {
  const room = team?.room(roomId);
  return room ? memberName(room.members, id) : id.slice(0, 8);
}

async function defaultOriginOf(repoPath: string): Promise<string | null> {
  try {
    return (await git(repoPath, ["remote", "get-url", "origin"])) || null;
  } catch (err) {
    if (/No such remote|not a git repository/i.test(errText(err))) return null;
    throw err;
  }
}

/** No global email set (git config exits 1): teammates' trailers name this install by a handle instead. */
async function defaultGitEmail(): Promise<string | null> {
  return (await git(os.homedir(), ["config", "--global", "--get", "user.email"], { okCodes: [0, 1] })) || null;
}
