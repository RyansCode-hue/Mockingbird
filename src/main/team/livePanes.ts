import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";
import { git } from "../git";
import { worktreeState } from "../worktrees";
import { readJsonOrSetAside, writeFileAtomic } from "../fileOps";
import { roomWaitingNotice, shouldNotify } from "../notifications";
import { roomSecretReads } from "../secrets";
import {
  CODEX_ROOM_APPROVALS,
  CODEX_ROOM_SANDBOX_NOTE,
  codexHomeOf,
  codexOutsideOff,
  codexProjectFolders,
  codexRoomPermissions,
  roomCacheEnv,
  roomCachesFolder,
  roomGitDirs,
  type RoomGitDirs,
} from "../codexRoomSandbox";
import { codexMcpNames } from "../codexMcpNames";
import { claudeRoomSettings } from "../claudeRoomSandbox";
import { sandboxMarkerCommand } from "../hooks";
import { gitPinRefusal, gitTop, onGitPinRefused, pinGitDirs, unpinGitDirs } from "../gitPins";
import { splitGroupKey, topOfKey, type SessionInfo, type Settings, type WorktreeStateInfo } from "../../shared/types";
import { isTermReply, isViewControl } from "../../shared/termInput";
import { CLAUDE_INLINE_ENV, codexMcpOff } from "../agents";
import {
  claudeSandboxes,
  claudeTooOld,
  codexGuardsSecrets,
  decodePtyChunk,
  encodePtyChunk,
  INPUT_VERSION,
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
  type RemoteTyping,
  type TypingAnswer,
  type TypingAsk,
  type TypingGrant,
  type TypingState,
  type ViewMessage,
  TYPING_MINUTES,
  outsideRoomSandbox,
} from "../../shared/team/livePanes";
import { quoted } from "../../shared/team/agentText";
import { takenOverOwn, takenOverTag } from "../../shared/team/takeover";
import type { RemoteAudit } from "./remoteAudit";
import type { MemberId, RoomId, RoomState } from "../../shared/team/types";
import type { LaunchTarget, RemotePanes, RoomLaunch, SessionManager } from "../sessions";
import { MAX_STREAM_CHUNK, splitText } from "./frames";
import { roomAgentContext } from "./houseService";
import { TEAM_CHANGES_READ_TOOLS } from "./teamChanges";
import { ROOM_CONTEXT_ENV } from "../../shared/team/claims";
import { HOUSE_READ_TOOLS } from "../../shared/team/house";
import { ARTIFACT_TOOL } from "../../shared/team/artifacts";
import { TEAM_DIR } from "./identity";
import { CoauthorTurns, COAUTHORS_DIR, ensureHooks, hooksEnv, HOOKS_DIR } from "./coauthors";
import { gitOf, memberName, originIdentity, recordFor, setRoomSessionLookup, turnEnded, TurnFeed, type RoomSessionSource, type TurnEnded } from "./roomSessions";
import { PeerError, TeamError, type Team, type TeamStream } from "./transport";

/**
 * Live panes (docs/team-rooms.md, "Sessions in a room"): this install's room
 * sessions published to their rooms and streamed to teammates who show them,
 * and teammates' room sessions shown here, typed into, and notified about.
 *
 * Owner side: each room session's record goes to the room log (coalesced:
 * waiting and closing go out at once, other changes at most once a second).
 * Its pty output is streamed on "pty:<id>" while a connected teammate shows
 * it — their view says so (or they just asked for its scrollback). A
 * teammate's copy is view-only: their keystrokes arrive as pty.input
 * requests and are written into the pty only once this Mac's person let that
 * teammate type into that session (pty.typingAsk asks; the answer goes back
 * as pty.typingState), and never while its agent is asking for permission —
 * so every approval is the owner's. The terminal's automatic answers never
 * are written, nor mouse reports and PageUp/PageDown, which would move the
 * owner's view. This is decided here, on the owner's Mac: a teammate's
 * Mockingbird can't skip it.
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
  /** The audit log of remote actions: typing asked, allowed and refused, and keystrokes counted (never their content). */
  remoteAudit?: Pick<RemoteAudit, "record" | "count">;
  log: (context: string, err: unknown) => string;
  gitState?: (cwd: string) => Promise<WorktreeStateInfo>;
  /** The repository's origin URL, or null when it has none. */
  originOf?: (repoPath: string) => Promise<string | null>;
  /** This install's git email, for teammates' Co-authored-by trailers. */
  gitEmail?: () => Promise<string | null>;
  /** What an agent in a room starts knowing about its House board (default: the House service's roomAgentContext). */
  agentContext?: (roomId: RoomId) => string;
  /** Where per-person settings for teammates' sessions (mutes) are kept. */
  dir?: string;
  hooksDir?: string;
  coauthorsDir?: string;
  /** Where rooms' caches go (ROOM_CACHES_DIR unless a test says otherwise). */
  cachesDir?: string;
  /** The room sandbox's marker hook script (hooks.ts's unless a test says otherwise). */
  markerScript?: string;
  /** The names of the user's Codex MCP servers, which a Codex room launch switches off; throws when they can't be read (codexMcpNames's unless a test says otherwise). */
  codexMcpServers?: () => Promise<string[]>;
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
/** An ask to type that its owner hasn't answered lapses after this long (the teammate can ask again). */
const ASK_TTL_MS = 10 * 60_000;
/** After a no, a new ask waits this long: keys held down can't nag the owner. */
const ASK_AGAIN_MS = 30_000;
const TYPING_STATES = new Set<TypingState>(["view-only", "asked", "allowed", "denied"]);

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
  /** The window shows it; showing it again after a spell hidden fetches its scrollback again. */
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

export class LivePanes implements RemotePanes, RoomSessionSource {
  private readonly t: Timing;
  private readonly now: () => number;
  private readonly coauthors: CoauthorTurns;
  private hooksReady = false;
  private started = false;
  private turns = new TurnFeed();
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
  /** When a teammate's mouse or paging input to a session was last written to the audit log, per `${sessionId}\n${member}`. */
  private viewInputAudited = new Map<string, number>();
  /** Teammates allowed to type, per session of this install's. */
  private grants = new Map<string, Map<MemberId, TypingGrant & { roomId: RoomId }>>();
  /** Teammates asking to type, per session of this install's. */
  private asks = new Map<string, Map<MemberId, TypingAsk & { roomId: RoomId }>>();
  /** When this install's person last said no to a teammate typing, per `${sessionId}\n${member}`. */
  private denied = new Map<string, number>();
  /** Teammates whose Mockingbird can't hear typing answers (older), said once each. */
  private oldViewers = new Set<MemberId>();

  // viewer side
  private remotes = new Map<string, Remote>();
  private panes = new Map<string, PaneSync>();
  private views = new Map<MemberId, ViewsByRoom>();
  private myView: { shown: string[]; focused: string | null } = { shown: [], focused: null };
  private sentViews = new Map<RoomId, { text: string; at: number }>();
  private inputQueue = new Map<string, string>();
  /** Where this install stands on typing into each teammate's session; absent until its owner says. */
  private typing = new Map<string, RemoteTyping>();
  private asking = new Set<string>();
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
    s.sandboxLost = (info, why) =>
      this.problem(`“${info.ticketTitle ?? info.title}” isn't in its team room's sandbox: ${why}. Nothing crosses the room's line for it, and teammates see it as unguarded; restart it to try again.`);
    s.folderNoticeSeen = (info, what, why) => {
      const title = info.ticketTitle ?? info.title;
      if (what === "answered") this.d.log(`team: room session ${info.id}`, `answered its Codex's folder notice for “${title}” with “Open restricted” (Enter)`);
      else this.problem(`“${title}” is waiting on its Codex: ${why}. Answer its folder notice in its pane if it's still up; nothing is typed into the pane until its Codex has opened.`);
    };
    const ownFolder = (top: string) => [...s.list(), ...s.resumable()].some((x) => x.cwd === top || x.cwd.startsWith(top + path.sep));
    this.offs.push(onGitPinRefused((top, why) => ownFolder(top) && this.problem(why)));
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
      team.onEvent("member.removed", (e, room) => this.memberRemoved(room.id, e.body.member, room)),
      team.onPresence((roomId, online) => this.presenceChanged(roomId, online)),
      team.onStream("pty:*", (chunk, ctx) => this.heardChunk(chunk, ctx.roomId, ctx.from)),
      team.onStream(VIEW_CHANNEL, (chunk, ctx) => this.heardView(chunk, ctx.roomId, ctx.from)),
      team.onRequest(LIVE_METHODS.scrollback, (params, ctx) => this.answerScrollback(params, ctx.from, ctx.roomId)),
      team.onRequest(LIVE_METHODS.input, (params, ctx) => this.answerInput(params, ctx.from, ctx.roomId)),
      team.onRequest(LIVE_METHODS.typingAsk, (params, ctx) => this.answerTypingAsk(params, ctx.from, ctx.roomId)),
      team.onRequest(LIVE_METHODS.typingState, (params, ctx) => this.heardTypingState(params, ctx.from, ctx.roomId)),
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
    s.sandboxLost = null;
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
  /** Whether session `id` is in a room but runs outside its sandbox (outsideRoomSandbox): nothing crosses the line for it. */
  outsideSandbox(id: string): boolean {
    const s = this.d.sessions.list().find((x) => x.id === id);
    return !!s && !!this.roomOfSession(id) && outsideRoomSandbox(s.shell ? null : (s.agent ?? "claude"), this.d.sessions.guardsOf(id));
  }

  roomOfSession(id: string): RoomId | null {
    if (!this.started) return null;
    if (!this.ownRooms) {
      this.ownRooms = new Map();
      for (const s of [...this.d.sessions.list(), ...this.d.sessions.resumable()]) if (!this.ownRooms.has(s.id)) this.ownRooms.set(s.id, this.roomOfInfo(s));
    }
    return this.ownRooms.get(id) ?? null;
  }

  /**
   * The room a session of this install's is in: its group's, unless a teammate took it over, in that room or any other
   * (then this copy has left every room: it's never shared again, wherever its group goes).
   */
  private roomOfInfo(s: SessionInfo): RoomId | null {
    const roomId = this.groupRoomOf(s);
    return roomId && !this.takenOver(s.id) ? roomId : null;
  }

  /** The room a session's group is shared as, taken over or not. */
  private groupRoomOf(s: SessionInfo): RoomId | null {
    return s.debrief ? null : this.roomForGroup(topOfKey(s.taskGroup ?? "ungrouped"));
  }

  /** Whether a teammate took this install's session `sessionId` over, in any room: the one rule main and the window go by (takenOverOwn). */
  private takenOver(sessionId: string): ReturnType<typeof takenOverOwn> {
    const team = this.d.team();
    return team ? takenOverOwn(team.rooms(), team.self.id, sessionId) : null;
  }

  /**
   * What a session starting in a shared group gets: secret reads denied
   * (Claude's rules; a Codex new enough runs in the room's sandbox and is
   * told about it), its commits credit teammates, an agent starts knowing
   * the room's House board, with its read tools (and the room artifacts' two)
   * allowed — its writes ask in the pane — and, unless this Mac's person turned it off — it runs inline,
   * so teammates' copies hold its history and scroll it themselves (a
   * full-screen agent keeps its history inside itself: a copy would show one
   * screen of it).
   */
  async roomLaunch(target: LaunchTarget): Promise<RoomLaunch | null> {
    const roomId = target.group ? this.roomForGroup(splitGroupKey(target.group).top) : null;
    if (!roomId) return null;
    let denyReads: string[] = [];
    let codexPermissions: string[] = [];
    let claudeSettings: Record<string, unknown> | null = null;
    let sandboxMarker: string | null = null;
    // the agent the room's settings are for: an agent pane's, or the one a terminal brings back
    const runs = target.agent ?? target.resumes ?? null;
    const codexGuarded = runs === "codex" && codexGuardsSecrets(target.agentVersion);
    const claudeSandboxed = runs === "claude" && claudeSandboxes(target.agentVersion);
    let git: RoomGitDirs | null = null;
    let gitRead = false;
    /** `who`: the sandboxed agent that couldn't commit without them; null where nothing depends on them but pollGit. */
    const gitDirs = async (who: string | null): Promise<RoomGitDirs | null> => {
      if (gitRead) return git;
      gitRead = true;
      // what it starts on is what git in its folder is held to from here on (gitPins.ts): read afresh at each launch
      let top: string | null = null;
      try {
        top = gitTop(target.cwd);
        if (top) unpinGitDirs(top);
        git = await roomGitDirs(target.cwd);
      } catch (err) {
        git = null;
        if (who) this.problem(`${who} in room session ${target.id} can't commit: its repository's git folder couldn't be found (${errText(err)})`, err);
        else this.d.log(`team: finding room session ${target.id}'s git folder`, err);
      }
      const moved = pinGitDirs(target.cwd, git, target.repoPath);
      if (moved) {
        git = null;
        this.problem(`Mockingbird won't run git in room session ${target.id}'s folder: ${moved}`);
      }
      return git;
    };
    const hooks = [this.d.hooksDir ?? HOOKS_DIR, this.d.coauthorsDir ?? COAUTHORS_DIR];
    const caches = runs ? this.cachesFor(roomId) : null;
    if (runs === "claude") {
      const secrets = roomSecretReads(this.d.settings().workTrackerPath);
      if (secrets.problem) this.problem(secrets.problem);
      denyReads = secrets.rules;
      // a terminal is never on the room's line, so only an agent pane's sandbox reports in
      if (target.agent === "claude" && claudeSandboxed) sandboxMarker = randomBytes(16).toString("hex");
      if (!claudeSandboxed) this.problem(claudeTooOld(target.agentVersion));
      const sandbox = claudeRoomSettings({
        workTrackerPath: this.d.settings().workTrackerPath,
        git: await gitDirs("Claude"),
        hooks,
        folders: [target.cwd, ...(target.extraDirs ?? [])],
        ...(caches ? { caches } : {}),
        ...(sandboxMarker ? { marker: sandboxMarkerCommand(sandboxMarker, this.d.markerScript) } : {}),
      });
      if (sandbox.problem) this.problem(sandbox.problem);
      claudeSettings = sandbox.settings;
    }
    // the user's Codex MCP servers, switched off by name, and the folders named untrusted: either unknown, what they'd
    // keep out could run outside the sandbox, so the launch is outside it
    let codexServers: string[] | null = null;
    let codexFoldersKnown = false;
    if (codexGuarded) {
      const sandbox = codexRoomPermissions({
        workTrackerPath: this.d.settings().workTrackerPath,
        git: await gitDirs("Codex"),
        hooks,
        codexHome: codexHomeOf(process.env),
        ...(caches ? { caches } : {}),
      });
      if (sandbox.problem) this.problem(sandbox.problem);
      try {
        codexServers = await (this.d.codexMcpServers ?? (() => codexMcpNames.names(this.d.sessions.binFor("codex"))))();
      } catch (err) {
        this.problem(
          `Codex room sessions start outside the room's sandbox: Mockingbird couldn't read which MCP servers your Codex config names, to switch them off (${errText(err)}). ` +
            "Nothing crosses the room's line for them until it can. Run `codex mcp list` in a terminal to see what's wrong, then restart the session.",
          err
        );
      }
      let folders: string[] = [];
      try {
        folders = codexProjectFolders(target.cwd, gitTop(target.cwd));
        codexFoldersKnown = true;
      } catch (err) {
        this.problem(`Room session ${target.id} starts outside the room's sandbox: the folders whose Codex config it must not read couldn't be listed (${errText(err)})`, err);
      }
      codexPermissions = [...codexMcpOff(codexServers ?? []), ...codexOutsideOff(folders), CODEX_ROOM_APPROVALS, ...sandbox.config];
    }
    if (!gitRead) await gitDirs(null);
    let instructions: string | null = null;
    if (target.agent) {
      try {
        instructions = (this.d.agentContext ?? roomAgentContext)(roomId);
      } catch (err) {
        // the SessionStart hook adds the board from the worktree's copy instead
        this.d.log(`team: the House board for session ${target.id}'s launch`, err);
      }
    }
    const inline = this.d.settings().roomSessionsInline !== false;
    return {
      env: {
        ...(this.hooksReady ? hooksEnv(this.d.hooksDir ?? HOOKS_DIR) : {}),
        // the board itself is in the launch, so the SessionStart hook adds nothing
        ...(instructions ? { [ROOM_CONTEXT_ENV]: "1" } : {}),
        // every room pty, terminals too: a claude started by hand in one runs inline as well
        ...(inline ? CLAUDE_INLINE_ENV : {}),
      },
      denyReads,
      codexPermissions,
      claudeSettings,
      instructions: [instructions, codexGuarded ? CODEX_ROOM_SANDBOX_NOTE : null].filter(Boolean).join("\n\n") || null,
      allowTools: target.agent === "claude" ? [...HOUSE_READ_TOOLS, ARTIFACT_TOOL.list, ARTIFACT_TOOL.read, ...TEAM_CHANGES_READ_TOOLS] : [],
      inline,
      // a terminal is a shell once the agent it brought back quits: never guarded
      guards: { secrets: target.agent !== null && (claudeSandboxed || (codexGuarded && codexServers !== null && codexFoldersKnown)), coauthors: this.hooksReady },
      sandboxMarker,
      agentEnv: caches ? roomCacheEnv(caches) : {},
      // its folders are named untrusted (codexOutsideOff), so an interactive Codex opens on its folder notice
      codexFolderNotice: codexGuarded && codexFoldersKnown,
    };
  }

  /** Room `roomId`'s cache folder, made if it isn't there: a launch that can't have one is told why. */
  private cachesFor(roomId: RoomId): string {
    const folder = roomCachesFolder(roomId, this.d.cachesDir);
    try {
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    } catch (err) {
      this.problem(`Room sessions' package installs and builds may fail: their cache folder ${folder} couldn't be made (${errText(err)})`, err);
    }
    return folder;
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
        // a folder git is refused in (gitPins.ts) was told once, when it was first refused
        if (!gitPinRefusal(s.cwd)) next = gitOf(await read(s.cwd));
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
    const e: TurnEnded = { sessionId: info.id, roomId, status: info.status, drivers };
    this.turns.emit(e);
    turnEnded(e);
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
      // a session between its ptys (a restart: the old one gone, its relaunch not yet spawned) stays watched, so its
      // new pty's first output isn't dropped before the next view comes
      for (const s of [...this.d.sessions.list(), ...this.d.sessions.resumable()]) {
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
    if (typeof id !== "string" || !roomId) throw new PeerError("name a session and its room");
    const s = this.d.sessions.list().find((x) => x.id === id);
    const taken = s ? this.takenOver(s.id) : null;
    if (taken && taken.now === this.d.team()?.self.id) throw new PeerError("that copy was taken back into another session: it doesn't run in the room any more");
    if (taken) throw new PeerError(`that session was taken over by ${memberNameIn(this.d.team(), taken.roomId, taken.now)}: it runs on their Mac now`);
    if (!s || this.roomOfInfo(s) !== roomId) throw new PeerError("that session isn't running in this room");
    return s;
  }

  private answerScrollback(params: unknown, from: MemberId, roomId: RoomId | undefined): PaneSnapshot {
    const s = this.ownRoomSession(params, roomId);
    const out = this.d.sessions.paneOutput(s.id);
    if (!out) throw new PeerError("that session isn't running");
    const leases = this.leases.get(s.id) ?? new Map<MemberId, number>();
    leases.set(from, this.now() + this.t.leaseMs);
    this.leases.set(s.id, leases);
    // output gathered but not yet sent goes out first; the asker's copy skips what the snapshot already holds
    this.flush(s.id);
    this.recomputeWatched();
    return { ...out, typing: this.typingAnswer(s, from) };
  }

  private answerInput(params: unknown, from: MemberId, roomId: RoomId | undefined): { ok: true } | { ok: false; typing: TypingAnswer } {
    const s = this.ownRoomSession(params, roomId);
    const p = params as { data?: unknown; email?: unknown; v?: unknown };
    if (typeof p.data !== "string" || !p.data || p.data.length > MAX_INPUT) throw new PeerError("typing must be text of up to 64 KB");
    const room = this.d.team()?.room(roomId!);
    const name = room ? memberName(room.members, from) : from.slice(0, 8);
    const data = p.data;
    if (isTermReply(data)) {
      // a terminal's automatic answer is never a teammate's typing
      this.d.audit(`dropped-remote-reply session=${s.id} from=${JSON.stringify(name)} bytes=${JSON.stringify(data.slice(0, 300))}`);
      return { ok: true };
    }
    if (isViewControl(data)) {
      // The owner's view is theirs: a teammate's wheel, clicks and PageUp/PageDown move only the teammate's copy (a
      // current Mockingbird never sends them). An older one sends a stream of wheel reports, so this is logged once a minute.
      const key = `${s.id}\n${from}`;
      if (this.now() - (this.viewInputAudited.get(key) ?? -Infinity) >= 60_000) {
        this.viewInputAudited.set(key, this.now());
        this.d.audit(`dropped-remote-view-input session=${s.id} from=${JSON.stringify(name)} bytes=${JSON.stringify(data.slice(0, 300))}`);
      }
      return { ok: true };
    }
    const who = { roomId, member: from, session: s.id, title: s.ticketTitle ?? s.title };
    const refused = this.inputRefusal(s, from);
    if (refused) {
      this.d.remoteAudit?.count("input.refused", who, Buffer.byteLength(data), { reason: refused.prompt ? "prompt" : "view-only" });
      // a Mockingbird from before typing consent reads only an error, which its pane then shows
      if (p.v !== INPUT_VERSION) throw new PeerError(`${refused.why} — ${refused.prompt ? "try again once they have" : "a newer Mockingbird can ask them to let you type"}`);
      return { ok: false, typing: refused };
    }
    if (/[\r\x03]/.test(data)) this.d.audit(`remote-input session=${s.id} from=${JSON.stringify(name)} bytes=${JSON.stringify(data.slice(-300))}`);
    this.d.remoteAudit?.count("input", who, Buffer.byteLength(data));
    // typed into a Codex's folder notice, it could answer it: held until Codex has opened, as queued messages are
    if (this.d.sessions.writeFromTeammate(s.id, data) === "full")
      throw new PeerError("its Codex hasn't opened its folder yet: typing waits for it, and 64 KB of it is already waiting");
    const email = typeof p.email === "string" ? p.email.slice(0, 200) : null;
    this.coauthors.typed(s.id, { id: from, name, email }, s.status, !s.shell);
    return { ok: true };
  }

  // ---- owner: who may type ---------------------------------------------------------------------

  /** `member`'s grant to type into session `sessionId`, if it holds now. */
  private grantOf(sessionId: string, member: MemberId): TypingGrant | null {
    const g = this.grants.get(sessionId)?.get(member);
    return g && (g.until === null || g.until > this.now()) ? g : null;
  }

  private selfNameIn(roomId: RoomId): string {
    const team = this.d.team();
    return team ? memberNameIn(team, roomId, team.self.id) : "the owner";
  }

  /** Where `member` stands on typing into this install's session `s`. */
  private typingAnswer(s: SessionInfo, member: MemberId): TypingAnswer {
    const g = this.grantOf(s.id, member);
    if (g) return { session: s.id, state: "allowed", until: g.until, ...(s.status === "waiting" ? { prompt: true } : {}) };
    if (this.asks.get(s.id)?.has(member)) return { session: s.id, state: "asked" };
    if (this.denied.has(`${s.id}\n${member}`)) return { session: s.id, state: "denied" };
    return { session: s.id, state: "view-only" };
  }

  /** Why `member`'s keys can't go into `s` now; null when they can. */
  private inputRefusal(s: SessionInfo, member: MemberId): TypingAnswer | null {
    const roomId = this.roomOfInfo(s)!;
    const me = this.selfNameIn(roomId);
    const title = quoted(s.ticketTitle ?? s.title, 80);
    const a = this.typingAnswer(s, member);
    if (a.state !== "allowed") return { ...a, why: `${me} hasn't allowed you to type in ${title}` };
    // "waiting" is the agent blocked on its person: a permission prompt above all. Its answer is the owner's alone.
    if (a.prompt) return { ...a, why: `${me}'s agent in ${title} is asking for permission: only ${me} can answer it` };
    return null;
  }

  /** A teammate asks to type into one of this install's sessions (`ask: true`), or asks where they stand. */
  private answerTypingAsk(params: unknown, from: MemberId, roomId: RoomId | undefined): TypingAnswer {
    const s = this.ownRoomSession(params, roomId);
    const now = this.now();
    if ((params as { ask?: unknown }).ask === true && !this.grantOf(s.id, from) && !this.asks.get(s.id)?.has(from)) {
      const no = this.denied.get(`${s.id}\n${from}`);
      if (no !== undefined && now - no < ASK_AGAIN_MS) {
        return { session: s.id, state: "denied", why: `${this.selfNameIn(roomId!)} said no a moment ago: ask again in a minute` };
      }
      const team = this.d.team();
      const room = team?.room(roomId!);
      const name = room ? memberName(room.members, from) : from.slice(0, 8);
      const asks = this.asks.get(s.id) ?? new Map();
      asks.set(from, { member: from, name, at: now, roomId: roomId! });
      this.asks.set(s.id, asks);
      this.d.remoteAudit?.record("typing.asked", { roomId, member: from, session: s.id, title: s.ticketTitle ?? s.title });
      if (shouldNotify({ settings: this.d.settings(), kind: "other", now: new Date(now) })) {
        this.d.notify(`${name} wants to type`, `In ${quoted(s.ticketTitle ?? s.title, 80)}: allow it or not in its pane`, s.id);
      }
      this.changed();
    }
    return this.typingAnswer(s, from);
  }

  /**
   * This install's person answers a teammate's ask, or takes typing back:
   * allow while the session runs ("session"), for TYPING_MINUTES ("minutes"),
   * "deny" an ask, or "revoke" an allowance. The teammate is told at once.
   */
  decideTyping(sessionId: string, member: MemberId, choice: "session" | "minutes" | "deny" | "revoke"): void {
    const team = this.team();
    const s = this.d.sessions.list().find((x) => x.id === sessionId);
    const roomId = s ? this.roomOfInfo(s) : null;
    if (!team || !s || !roomId) throw new Error("That session isn't shared in a room any more");
    const room = team.room(roomId);
    if (!room || member === team.self.id || !room.members.some((x) => x.id === member)) throw new Error("They aren't a member of this session's room");
    const who = { roomId, member, session: s.id, title: s.ticketTitle ?? s.title };
    const me = this.selfNameIn(roomId);
    const now = this.now();
    this.asks.get(sessionId)?.delete(member);
    if (choice === "session" || choice === "minutes") {
      const until = choice === "minutes" ? now + TYPING_MINUTES * 60_000 : null;
      const grants = this.grants.get(sessionId) ?? new Map();
      grants.set(member, { member, name: memberName(room.members, member), until, at: now, roomId });
      this.grants.set(sessionId, grants);
      this.denied.delete(`${sessionId}\n${member}`);
      this.d.remoteAudit?.record("typing.allowed", who, { until });
    } else {
      const had = !!this.grants.get(sessionId)?.delete(member);
      this.denied.set(`${sessionId}\n${member}`, now);
      this.d.remoteAudit?.record(choice === "revoke" && had ? "typing.revoked" : "typing.denied", who);
    }
    const answer = this.typingAnswer(s, member);
    if (answer.state === "denied") answer.why = choice === "revoke" ? `${me} stopped your typing` : `${me} didn't allow typing`;
    this.tellTyping(roomId, member, answer);
    this.changed();
  }

  /** Tell a teammate where they stand now. An older Mockingbird can't hear it: its next keys are refused instead. */
  private tellTyping(roomId: RoomId, member: MemberId, answer: TypingAnswer): void {
    const team = this.team();
    if (!team || !team.presence(roomId).includes(member)) return; // they hear it with the session's scrollback when back
    team.request(member, LIVE_METHODS.typingState, answer, { roomId, timeoutMs: 10_000 }).catch((err) => {
      if (err instanceof TeamError && err.code === "no-handler") {
        if (!this.oldViewers.has(member)) this.d.log("team", `${memberNameIn(team, roomId, member)}'s Mockingbird predates typing consent: their keys are refused with the reason until they update`);
        this.oldViewers.add(member);
        return;
      }
      this.d.log(`team: telling ${memberNameIn(team, roomId, member)} about typing in session ${answer.session}`, err);
    });
  }

  /** Allowances that ran out, and allowances and asks for sessions that closed, left the room or whose teammate left: gone, and said so. */
  private expireTyping(): void {
    const team = this.team();
    const now = this.now();
    const live = new Map(this.d.sessions.list().map((s) => [s.id, s]));
    let changed = false;
    for (const [sessionId, grants] of this.grants) {
      const s = live.get(sessionId);
      const roomId = s && s.status !== "dead" ? this.roomOfInfo(s) : null;
      for (const [member, g] of grants) {
        const gone = !team || roomId !== g.roomId || !team.room(g.roomId)?.members.some((m) => m.id === member);
        const expired = g.until !== null && g.until <= now;
        if (!gone && !expired) continue;
        grants.delete(member);
        changed = true;
        const who = { roomId: g.roomId, member, session: sessionId, title: s ? s.ticketTitle ?? s.title : null };
        if (expired && !gone) {
          this.d.remoteAudit?.record("typing.expired", who);
          this.tellTyping(g.roomId, member, { session: sessionId, state: "view-only", why: `the ${TYPING_MINUTES} minutes ${this.selfNameIn(g.roomId)} allowed are up` });
        } else {
          const reason = !s || s.status === "dead" ? "the session ended" : roomId === g.roomId ? "they left the room" : "the session left the room";
          this.d.remoteAudit?.record("typing.ended", who, { reason });
        }
      }
      if (!grants.size) this.grants.delete(sessionId);
    }
    for (const [sessionId, asks] of this.asks) {
      const s = live.get(sessionId);
      const roomId = s && s.status !== "dead" ? this.roomOfInfo(s) : null;
      for (const [member, a] of asks) {
        const lapsed = now - a.at >= ASK_TTL_MS;
        if (!lapsed && roomId === a.roomId && team?.presence(a.roomId).includes(member)) continue;
        asks.delete(member);
        changed = true;
        if (lapsed && roomId === a.roomId) this.tellTyping(a.roomId, member, { session: sessionId, state: "view-only", why: `${this.selfNameIn(a.roomId)} didn't answer` });
      }
      if (!asks.size) this.asks.delete(sessionId);
    }
    for (const [k, at] of this.denied) if (now - at >= ASK_TTL_MS) this.denied.delete(k);
    if (changed) this.changed();
  }

  /** Hear when one of this install's room sessions ends an agent turn (take-over backs it up then). */
  onTurnEnded(cb: (e: TurnEnded) => void): () => void {
    return this.turns.on(cb);
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
          // taken over: the taker's own session is the room's now (its owner may be offline, so the record stays)
          const backup = room.ext.takeover?.sessions[rec.id];
          if (backup?.takenOver && backup.owner === rec.owner) continue;
          const paneId = remotePaneId(rec.owner, rec.id);
          next.set(paneId, { paneId, roomId: room.id, groupKey, rec });
        }
      }
    }
    for (const id of this.panes.keys()) if (!next.has(id)) this.panes.delete(id);
    for (const id of this.typing.keys()) if (!next.has(id)) this.typing.delete(id);
    const before = this.remotes;
    this.remotes = next;
    // a session started again (a restart, a relaunch): output its new pty sent while the record still said it had
    // ended was dropped, so the panes this window shows of it catch up from its scrollback
    for (const [id, r] of next) {
      const p = this.panes.get(id);
      if (r.rec.live && before.get(id)?.rec.live === false && p?.attached && p.watched) this.resync(id);
    }
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
    // its terminal asks as it opens on screen, often before the window's view says the pane is shown:
    // that view must not count as showing it again, which would redraw it from a second fetch
    p.attached = p.watched = true;
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
          // an owner from before typing consent says nothing about it: it takes anyone's typing
          const typing = snap.typing === undefined ? null : typingOf(snap.typing, r.rec.id);
          if (snap.typing !== undefined && !typing) this.d.log("team", `${memberNameIn(team, r.roomId, r.rec.owner)} sent a malformed typing answer with ${r.rec.id}'s scrollback`);
          this.setTyping(id, typing ?? { session: r.rec.id, state: "legacy" });
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
    const r = this.remotes.get(id);
    if (!r) return;
    const t = this.typing.get(id);
    // the terminal's own answers and pointer input aren't anyone's typing: never sent where they'd be refused, never an ask
    const automatic = isTermReply(data) || isViewControl(data);
    const owner = memberNameIn(this.team(), r.roomId, r.rec.owner);
    if (t && (t.state === "view-only" || t.state === "asked" || t.state === "denied")) {
      if (automatic) return;
      this.refusedHere(id, t.state === "asked" ? `Waiting for ${owner} to let you type` : `${owner} hasn't allowed typing`);
      if (t.state === "view-only") void this.askToType(id);
      return;
    }
    if (t?.state === "allowed" && r.rec.status === "waiting") {
      if (!automatic) this.refusedHere(id, `${owner}'s agent is asking for permission: only ${owner} can answer it`);
      return;
    }
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
        team.request<{ ok?: boolean; typing?: unknown } | null>(r.rec.owner, LIVE_METHODS.input, { session: r.rec.id, data: piece, email: this.email, v: INPUT_VERSION }, { roomId: r.roomId }).then(
          (res) => {
            if (this.panes.get(id)?.problem?.startsWith("Couldn't type")) this.setProblem(id, undefined);
            if (res?.ok !== false) return;
            const a = typingOf(res.typing, r.rec.id);
            if (!a) return void this.d.log("team", `${memberNameIn(team, r.roomId, r.rec.owner)} refused typing into ${r.rec.id} without saying why`);
            this.setTyping(id, a, a.why ?? "Typing was refused");
            if (a.state === "view-only") void this.askToType(id);
          },
          (err) => {
            const msg = `Couldn't type into ${r.rec.title}: ${errText(err)}`;
            this.d.log("team: typing into a teammate's session", msg);
            this.setProblem(id, msg);
          }
        );
      }
    }
  }

  /** Ask a teammate to let this install type into their session `id` (its pane's Ask to type, or typing into it). */
  async askToType(id: string): Promise<void> {
    const r = this.remotes.get(id);
    const team = this.team();
    if (!r || !team || this.asking.has(id)) return;
    this.asking.add(id);
    try {
      const a = typingOf(await team.request(r.rec.owner, LIVE_METHODS.typingAsk, { session: r.rec.id, ask: true }, { roomId: r.roomId, timeoutMs: 15_000 }), r.rec.id);
      if (!a) throw new Error("its answer made no sense");
      this.setTyping(id, a, a.why);
    } catch (err) {
      // an owner on a Mockingbird from before typing consent takes anyone's typing
      if (err instanceof TeamError && err.code === "no-handler") return void this.setTyping(id, { session: r.rec.id, state: "legacy" });
      const msg = `Couldn't ask ${memberNameIn(team, r.roomId, r.rec.owner)} to let you type: ${errText(err)}`;
      this.d.log("team: asking to type", msg);
      this.refusedHere(id, msg);
    } finally {
      this.asking.delete(id);
    }
  }

  /** The owner's word on typing into their session `id`; `why`, when keys were just refused. */
  private setTyping(id: string, a: TypingAnswer | { session: string; state: "legacy" }, why?: string): void {
    const before = this.typing.get(id);
    const next: RemoteTyping = { state: a.state, ...("until" in a && a.until !== undefined ? { until: a.until } : {}) };
    // why keys were refused stays said until typing goes through
    if (why) next.refused = { at: this.now(), why };
    else if (before?.refused && next.state !== "allowed" && next.state !== "legacy") next.refused = before.refused;
    if (sameJson(before, next)) return;
    this.typing.set(id, next);
    this.changed();
  }

  /** Keys typed here didn't go: the pane says why. */
  private refusedHere(id: string, why: string): void {
    const t = this.typing.get(id) ?? { state: "view-only" as const };
    this.typing.set(id, { ...t, refused: { at: this.now(), why } });
    this.changed();
  }

  /** An owner says where this install stands on typing into one of their sessions. */
  private heardTypingState(params: unknown, from: MemberId, roomId: RoomId | undefined): { ok: true } {
    const session = (params as { session?: unknown })?.session;
    const a = typeof session === "string" ? typingOf(params, session) : null;
    if (!a) throw new PeerError("malformed typing state");
    const id = remotePaneId(from, a.session);
    const r = this.remotes.get(id);
    if (!r || r.roomId !== roomId) throw new PeerError("no such session of yours in this room here");
    this.setTyping(id, a, a.why);
    return { ok: true };
  }

  setMuted(id: string, muted: boolean): void {
    if (muted) this.muted.add(id);
    else this.muted.delete(id);
    writeFileAtomic(this.mutedFile, JSON.stringify([...this.muted], null, 2));
    this.changed();
  }

  /** Stop muting these panes (their sessions left the room): saved at once. Returns the problem, or null. */
  private unmute(ids: string[]): string | null {
    const gone = ids.filter((id) => this.muted.has(id));
    if (!gone.length) return null;
    for (const id of gone) this.muted.delete(id);
    try {
      writeFileAtomic(this.mutedFile, JSON.stringify([...this.muted], null, 2));
      return null;
    } catch (err) {
      const why = `The muted teammates' sessions couldn't be saved to ${this.mutedFile}: ${errText(err)}`;
      this.d.log("team: live panes", why);
      return why;
    }
  }

  /**
   * This install left `room` (shown as group `groupKey` here): its sessions
   * there carry on as local sessions — not published, nobody typing in, no
   * Co-authored-by trailers — and teammates' panes, views and mutes of it go.
   * Returns what couldn't be cleaned up.
   */
  roomLeft(room: RoomState, groupKey: string | null): string[] {
    const problems: string[] = [];
    const own = new Set<string>();
    for (const k of [...this.published.keys()]) {
      const [roomId, id] = k.split("\n");
      if (roomId !== room.id) continue;
      this.published.delete(k);
      own.add(id);
    }
    if (groupKey) for (const s of [...this.d.sessions.list(), ...this.d.sessions.resumable()]) if (topOfKey(s.taskGroup ?? "ungrouped") === groupKey) own.add(s.id);
    for (const id of own) {
      this.coauthors.forget(id);
      this.leases.delete(id);
      this.watchedOwn.delete(id);
      this.grants.delete(id);
      this.asks.delete(id);
    }
    // teammates' sessions as the room last had them (this install's own records went with its removal)
    const theirs = Object.values(room.ext.sessions ?? {}).map((r) => remotePaneId(r.owner, r.id));
    for (const [id, r] of this.remotes) if (r.roomId === room.id) theirs.push(id);
    for (const id of theirs) {
      const p = this.panes.get(id);
      if (p?.resyncTimer) clearTimeout(p.resyncTimer);
      this.panes.delete(id);
      this.notified.delete(id);
      this.typing.delete(id);
    }
    const muteProblem = this.unmute(theirs);
    if (muteProblem) problems.push(muteProblem);
    for (const byRoom of this.views.values()) byRoom.delete(room.id);
    this.sentViews.delete(room.id);
    this.roomCache = null;
    this.ownRooms = null;
    this.indexRemotes();
    this.schedule(0);
    this.changed();
    return problems;
  }

  /** A teammate left or was removed: their panes went with the room's records; their mutes and views go too. */
  private memberRemoved(roomId: RoomId, member: MemberId, room: RoomState): void {
    const team = this.team();
    if (!team || member === team.self.id || room.members.some((m) => m.id === member)) return;
    this.indexRemotes();
    const prefix = remotePaneId(member, "");
    const unmute = [...this.muted].filter((id) => id.startsWith(prefix) && !this.remotes.has(id));
    const problem = this.unmute(unmute);
    if (problem) this.problem(problem);
    this.views.get(member)?.delete(roomId);
    this.expireTyping();
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

  /** What this window shows (the workspaces on the landscape's screen) and which one it's in. */
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
    this.expireTyping();
  }

  // ---- the window -----------------------------------------------------------------------------------

  /** Settings changed: the window's room sessions say whether a restart brings them inline. */
  settingsChanged(before: Settings, after: Settings): void {
    if ((before.roomSessionsInline !== false) !== (after.roomSessionsInline !== false)) this.changed();
  }

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
        ...(this.typing.has(r.paneId) ? { typing: this.typing.get(r.paneId) } : {}),
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
      // a copy a teammate took over is tagged so from the room it was taken over in, wherever its group is now: main
      // refuses what it refuses by the same rule (takenOverOwn)
      const taken = this.takenOver(s.id);
      const roomId = this.groupRoomOf(s) ?? taken?.roomId ?? null;
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
        inlineOnStart: this.d.settings().roomSessionsInline !== false,
        typists: [...(this.grants.get(s.id)?.values() ?? [])].filter((g) => roomId === g.roomId && (g.until === null || g.until > this.now())).map(({ roomId: _r, ...g }) => g),
        typingAsks: [...(this.asks.get(s.id)?.values() ?? [])].filter((a) => roomId === a.roomId).map(({ roomId: _r, ...a }) => a),
        ...(taken ? { takenOver: takenOverTag(taken, self, (m) => memberNameIn(team, taken.roomId, m)) } : {}),
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

/** A typing answer from a teammate's Mockingbird for session `session`, checked; null when malformed. */
function typingOf(v: unknown, session: string): TypingAnswer | null {
  const a = v as Partial<TypingAnswer> | null;
  if (!a || typeof a !== "object" || a.session !== session || !TYPING_STATES.has(a.state as TypingState)) return null;
  if (a.until !== undefined && a.until !== null && !Number.isSafeInteger(a.until)) return null;
  return {
    session,
    state: a.state as TypingAnswer["state"],
    ...(a.until !== undefined ? { until: a.until } : {}),
    ...(typeof a.why === "string" ? { why: a.why.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").slice(0, 300) } : {}),
    ...(a.prompt === true ? { prompt: true } : {}),
  };
}
