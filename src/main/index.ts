import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, Tray, nativeImage, powerMonitor, shell } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Store, appendLogLine, expandHome, MB_DIR } from "./store";
import { readJsonFile, writeFileAtomic } from "./fileOps";
import { SessionManager, PTY_TERM, paneEnv, terminalEnv, type OverdueMessage } from "./sessions";
import { indexRepos } from "./repos";
import { worktreeState, cleanupWorktree, listBranches, listWorktrees, removeWorktree, migrateWorktree, forgetState } from "./worktrees";
import { FolderWatcher } from "./watch";
import { computeMeters, conversationsOf, fiveHourWindows } from "./meters";
import { RunManager } from "./run";
import { loadProfile, mainCheckout, profilePath, saveProfile } from "./runProfile";
import { draftProfile } from "./runDraft";
import { DebugManager } from "./dap/session";
import { debugTargetFor } from "./dap/targets";
import * as pty from "node-pty";
import { installHooks, hooksInstalled, watchEvents, ensureHookScript } from "./hooks";
import { readUsage, watchUsage, setClaudePlan, readContextWindow } from "./usage";
import { planRateOf, refreshBrief, resumeEstimate, type RefreshBrief, type ResumeEstimate } from "./contextActions";
import { listDir, readFile, writeFile, gitChanges, fileDiff, applyFileEdits, resolveIn, baseRef, inside, branchStat, forgetBranchStat } from "./files";
import { scmStatus, scmStage, scmUnstage, scmDiscard, scmCommit, scmPush, scmPull, scmFetch, scmGraph, scmCommitFiles, scmCommitDiff, scmDiff } from "./scm";
import { listAllFiles, searchFiles } from "./find";
import { generateCommitMessage } from "./commitMessage";
import { Messaging, removeMcpTokenFiles } from "./messaging";
import { setupStatus } from "./setup";
import { CollabRooms, COLLAB_DIR, COLLAB_MODELS, COLLAB_EFFORTS, cliTurnRunner } from "./collab";
import { codexMcpNames } from "./codexMcpNames";
import { CouncilTickets } from "./collabTickets";
import { userShell, userShellWithInput, which, quote } from "./shell";
import { runDebrief, startScheduler } from "./debrief";
import { listClaudeConversations } from "./importer";
import { listWorkItems, workItemStates, updateWorkItem, listComments, addComment, adoIdentity, resetAdoCache, teamBoards, moveToBoardColumn, reorderWorkItem, adoRequest, setWorkItemTags, projectTags } from "./ado";
import { PipelineStore } from "./pipeline";
import { LandscapeStore } from "./landscape";
import { WireService } from "./wires";
import type { WireState } from "../shared/wires";
import { WireDelivery } from "./wireDelivery";
import { areaKeyOf, LOOSE_GROUP } from "../shared/landscape";
import { openPr, prBaseProblem, prDescriptionPrompt, prError, prPreflight, summaryOf, type PrDeps } from "./pullRequests";
import { askAgent, cleanReply } from "./headless";
import { currentBranch, originUrl, parseRemote, remoteName } from "./git";
import { CLAUDE_PROJECTS, CODEX_SESSIONS, claudeTranscriptOf, codexRolloutOf } from "./agentFiles";
import { conversationFiles, handoffKickoff, handoffPrompt, replyOfConversation, repoState, transcriptDigest, transcriptLines, type ConversationLookup } from "./handoff";
import { WireTools } from "./wireTools";
import { TicketTools } from "./ticketTools";
import { PATCH_NOTES_GUIDANCE } from "./ticketToolSchemas";
import { presetRequest } from "./presets";
import { HELPDESK_KEEPS_ITS_CONVERSATION, helpdeskShareRefusal, inHelpdeskFolder } from "./helpdesk";
import { reviewPrompt } from "./review";
import { shouldNotify, toolsLostNotice } from "./notifications";
import { composeRollup, weekBounds } from "./rollup";
import { fmtElapsed } from "../shared/format";
import { MessageLog } from "./messageLog";
import { overlapReport, rereadWorktrees, type WorktreeReads } from "./conflicts";
import { logOwnGitFailuresTo } from "./safeGit";
import { changesSince, dropSnapshots, listSnapshots, restoreSnapshot, takeSnapshot } from "./snapshots";
import { prStateById, prStatusFor } from "./prStatus";
import { PR_TTL_MS, PrWatch } from "./prWatch";
import { LspManager } from "./lsp/manager";
import { LSP_DIR } from "./lsp/servers";
import { checkForUpdate, updateRepo } from "./updates";
import { Suggestions, findGhOnPath } from "./suggestions";
import { agentLabel, cliVersion, isInstalledBin } from "./agents";
import { TranscriptIndex, importable, linkHits, retryingSync, type UsageRow } from "./transcripts";
import { buildCatalog, collabModels } from "./models";
import type { AgentKind, AgentMessage, BroadcastRequest, ContextWindow, LastReply, Meters, ModelCatalog, OverlapReport, PrStatus, SessionInfo, UpdateOutcome } from "../shared/types";
import { BY_YOU, HELPDESK_PRESET, isWorkItemId, keptTicksLine, localDay, stageLabel, topOfKey, UI_COMMANDS } from "../shared/types";
import { plainLine } from "../shared/team/agentText";
import { UpdateRunner, findSourceClone, loginShellExec, startInstaller, takeUpdateOutcome } from "./selfUpdate";
import { QuitSequence } from "./quit";
import { claudeRunner, freeForResume } from "./claudeBackground";
import { binSettingsChanged, guarded, instructionFile, liveSessionIn, rememberAnswer, samePath } from "./handlers";
import { TeamService, type RoomCleanup } from "./team/service";
import { configureWebRtc } from "./team/peerHost";
// team rooms: the Radley House board (importing it registers the board's room events, before any room log loads)
import { HouseService } from "./team/houseService";
import { TicketSessions } from "./team/ticketSession";
import { TeamChanges } from "./team/teamChanges";
// team rooms: team chat
import { TeamRoom } from "./team/teamRoom";
import { forgetViewsWith } from "./team/chat";
// team rooms: take-over
import { liveRoomHost, TakeoverService } from "./team/takeover";
import { untakenHandler, type UntakenDeps } from "./takenOverGuard";
import type { TakeoverView } from "../shared/team/takeover";
import { knownSecretFiles } from "./secrets";
import { ROOMS_DIR } from "./team/rooms";
// team rooms: live panes
import { LivePanes } from "./team/livePanes";
import { RemoteAudit } from "./team/remoteAudit";
import { stopTeamRooms } from "./team/shutdown";
// team rooms: artifacts (importing it registers the artifacts' room events, before any room log loads)
import { TeamArtifacts } from "./team/artifacts";
import { assistantArtifacts } from "./team/artifactTools";
import { AreaArtifacts, artifactShelves } from "./areaArtifacts";
import { artifactViewer } from "./team/artifactViewer";
import { isRemotePaneId } from "../shared/team/livePanes";
import { guardNavigation } from "./navigation";
import { externalUrlAllowed } from "../shared/links";
import { PRIVACY_PANES, startPhoneService, type PhoneService } from "./phone/service";

const LOG = path.join(MB_DIR, "main.log");
function logError(context: string, err: unknown): string {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  try {
    appendLogLine(LOG, `[${new Date().toISOString()}] ${context}: ${msg}`);
  } catch {
    /* logging must never crash the app */
  }
  return err instanceof Error ? err.message : String(err);
}
function logLine(line: string): void {
  try {
    appendLogLine(LOG, `[${new Date().toISOString()}] ${line}`);
  } catch {
    /* logging must never crash the app */
  }
}
process.on("uncaughtException", (e) => logError("uncaughtException", e));
logOwnGitFailuresTo(logError);
process.on("unhandledRejection", (e) => logError("unhandledRejection", e));
guardNavigation(app, shell, (msg) => void logError("navigation", msg));

// One instance per user: a second copy would overwrite ~/.mockingbird/state.json
// and take over the agent-messaging socket from the first. Opening the app again
// just brings the running window forward.
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) {
  app.quit(); // asynchronous — startup checks isPrimary so nothing writes meanwhile
} else {
  app.on("second-instance", () => focusPane());
}

const store = new Store();
if (isPrimary) {
  // debrief panes are ephemeral reviews — don't carry them across restarts
  store.state.sessions = store.state.sessions.filter((s) => !s.debrief);
  store.save();
}
const sessions = new SessionManager(store);
// The app's window. Not BrowserWindow.getAllWindows()[0]: team rooms keep a hidden window of their own.
let mainWindow: BrowserWindow | null = null;
const appWindow = (): BrowserWindow | null => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
const toWindow = (channel: string, ...args: unknown[]) => appWindow()?.webContents.send(channel, ...args);

// the landscape (docs/landscape.md): where workspaces and areas sit. Its wires go to the window with what only main can
// tell for drawing them (WireService.forWindows), once the service is there
let wiresForWindows = <S extends WireState>(s: S): S => s;
const landscape = new LandscapeStore({ file: path.join(MB_DIR, "landscape.json"), emit: (change) => toWindow("landscape:changed", change), emitWires: (change) => toWindow("wires:changed", wiresForWindows(change)), log: logError });

// Team rooms (docs/team-rooms.md): identity, rooms and the WebRTC transport
configureWebRtc(app);
const team: TeamService = new TeamService({
  settings: () => store.settings,
  localGroups: () => [...new Set([...sessions.list(), ...store.state.sessions].map((s) => topOfKey(s.taskGroup ?? "ungrouped")))],
  emit: (status) => toWindow("team:changed", status),
  log: logError,
  assetsDir: __dirname,
  // what each stage kept of a room this install left or was removed from goes, then the room's folder
  cleanup: (): RoomCleanup[] => [
    { what: "the room's live panes", roomLeft: (room, groupKey) => livePanes.roomLeft(room, groupKey) },
    { what: "the room chat's read marks", roomLeft: (room) => teamRoom.chat.roomLeft(room.id) },
    { what: "the room's files in worktrees (claims, agent context, overlaps, migrations)", roomLeft: (room) => (teamChanges.roomLeft(room.id), teamHouse.roomLeft(room.id)) },
    { what: "the room's artifacts and agents' copies of them", roomLeft: (room) => teamArtifacts.roomLeft(room.id) },
    { what: "the room's backups and hidden refs", roomLeft: (room) => takeover?.roomLeft(room) ?? [] },
  ],
  notify: (title, body) => {
    if (shouldNotify({ settings: store.settings, kind: "other", now: new Date() })) new Notification({ title, body }).show();
  },
});

// Folders that may be clones of a room's repo: sessions' repos, and the repo index (read again every 5 minutes)
let roomRepoIndex = { at: 0, repos: [] as string[] };
function knownRoomRepos(): string[] {
  if (Date.now() - roomRepoIndex.at > 5 * 60_000) roomRepoIndex = { at: Date.now(), repos: indexRepos(store.settings.repoRoots).map((r) => r.path) };
  const used = [...sessions.list(), ...store.state.sessions].map((s) => s.repoPath).filter((p): p is string => !!p);
  return [...new Set([...used, ...roomRepoIndex.repos])];
}

// team rooms: the Radley House board — tickets read and written with this builder's token, claims in the
// room repos' worktrees, teammates' branches
const teamHouse: HouseService = new HouseService({
  roomGroups: () => team.status().rooms.map((r) => ({ roomId: r.id, groupKey: r.groupKey })),
  sessions: () => sessions.list(),
  roomGuards: (id) => sessions.guardsOf(id),
  knownRepos: knownRoomRepos,
  emit: toWindow,
  log: logError,
  notify: (title, body, sessionId) => (sessionId ? notifySession(sessionId, title, body) : new Notification({ title, body }).show()),
  overlapsChanged: () => {
    overlapsSoon();
    teamChanges.refreshSoon();
  },
  worktreeFiles: (o) => teamChanges.worktreeFiles(o),
  migrationFolders: (roomId) => teamChanges.migrationFolders(roomId),
});
// team rooms: a session from a House ticket — the board's claim, New session's worktree and launch, in that order
const ticketSessions = new TicketSessions({
  house: teamHouse,
  knownRepos: () => indexRepos(store.settings.repoRoots).map((r) => r.path),
  createSession: async (req) => {
    const info = await sessions.create(req);
    if (info.repoPath) overlapsSoon(info.cwd);
    return info;
  },
  baseOf: async (repo) => (await listBranches(repo)).defaultBase,
  log: logError,
});
// team rooms: what teammates' sessions on other Macs change (their pushed branches and the snapshots
// take-over copies here), for the overlap heads-up and the agents' tools; migration number reservations
const teamChanges: TeamChanges = new TeamChanges({
  roomGroups: () => team.status().rooms.map((r) => ({ roomId: r.id, groupKey: r.groupKey })),
  sessions: () => sessions.list(),
  knownRepos: knownRoomRepos,
  teammateBranches: () => teamHouse.teammateBranches(),
  mirrors: () => takeover?.mirrored() ?? [],
  rewriteCopies: () => teamHouse.rewriteCopies(),
  overlapsChanged: () => overlapsSoon(),
  emit: toWindow,
  log: logError,
  notify: (title, body, sessionId) => (sessionId ? notifySession(sessionId, title, body) : new Notification({ title, body }).show()),
  secretFiles: () => knownSecretFiles(store.settings.workTrackerPath).files,
});
// team rooms: artifacts — files, notes, repo references and links kept in a room;
// files copied peer to peer by hash, read by room agents through their tools
const teamArtifacts = new TeamArtifacts({
  sessions: () => sessions.list(),
  knownRepos: knownRoomRepos,
  roomGroups: () => team.status().rooms.map((r) => ({ roomId: r.id, groupKey: r.groupKey })),
  secretFiles: () => knownSecretFiles(store.settings.workTrackerPath).files,
  emit: (roomId) => toWindow("artifacts:changed", roomId),
  log: logError,
});
// areas' artifacts on this Mac: an area that isn't a room's keeps its own, by its key
const areaArtifacts = new AreaArtifacts({
  root: MB_DIR,
  sessions: () => sessions.list(),
  knownRepos: knownRoomRepos,
  secretFiles: () => knownSecretFiles(store.settings.workTrackerPath).files,
  neverAdd: [path.join(MB_DIR, "team")],
  emit: (shelf) => toWindow("artifacts:changed", shelf),
  roomOfArea: (key) => team.status().rooms.find((r) => r.groupKey === key)?.id ?? null,
  log: logError,
});
areaArtifacts.start();
// a folder kept by a rename or merge says why only until a restart: one no area has is logged as the app starts
try {
  areaArtifacts.unclaimed([...sessions.list().map(areaKeyOf), ...Object.keys(landscape.get().landscape.areas)]);
} catch (err) {
  logError("area artifacts: looking for folders no area has", err);
}
// the window's artifact calls name a shelf: a room's id, or an area's (shared/areaArtifacts.ts)
const shelves = artifactShelves(teamArtifacts, areaArtifacts);
const artifactUi = artifactViewer(shelves, {
  previewFile: (file, name) => appWindow()?.previewFile(file, name || undefined),
  showItemInFolder: (file) => shell.showItemInFolder(file),
  saveDialog: async (defaultName) => {
    const win = appWindow();
    const r = win ? await dialog.showSaveDialog(win, { defaultPath: defaultName }) : await dialog.showSaveDialog({ defaultPath: defaultName });
    return r.canceled || !r.filePath ? null : r.filePath;
  },
  openFilesDialog: async () => {
    const win = appWindow();
    const opts = { title: "Add artifacts", buttonLabel: "Add", properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths.length ? null : r.filePaths;
  },
});
// team rooms: take-over — room sessions back up after each turn; a teammate can
// continue one on their laptop. Room sessions and their turn ends are the live
// panes' (roomSessions.ts).
let takeover: TakeoverService | null = null;
let secretFilesProblem: string | null = null;
function startTakeover(): TakeoverService | null {
  const transport = team.transport;
  if (!transport) return null; // team rooms didn't start: Settings → Team says why
  return new TakeoverService({
    team: transport,
    roomsDir: ROOMS_DIR,
    host: liveRoomHost(livePanes, { sessions: () => sessions.list(), resumable: () => sessions.resumable(), rooms: () => team.status().rooms, stop: (id) => sessions.stop(id) }),
    secretFiles: () => {
      const known = knownSecretFiles(store.settings.workTrackerPath);
      if (known.problem && known.problem !== secretFilesProblem) logError("team: what room backups leave out", known.problem);
      secretFilesProblem = known.problem;
      return known.files;
    },
    repos: () => [...new Set([...indexRepos(store.settings.repoRoots).map((r) => r.path), ...sessions.list().flatMap((s) => (s.repoPath ? [s.repoPath] : []))])],
    launch: (req) => sessions.create(req),
    log: logError,
    changed: () => {
      toWindow("team:takeoverChanged", takeover?.view());
      teamChanges.refreshSoon(); // a teammate's snapshot may have arrived: their uncommitted work
    },
    onTakenOver: (id, by) => notifySession(id, "Taken over", `${by} continues ${titleOfSession(id)} on their Mac: it stopped here`),
    onRefused: (id, owner, title) => notifySession(id, "Take-over refused", `${owner}'s Mac refused your take-over of “${title}”, so it stays theirs: this copy stopped. The room's chat says why.`),
    // asked to hand a session over: told even when its pane's notifications were just shown (no coalescing)
    onAsk: (a) => {
      if (!shouldNotify({ settings: store.settings, kind: "other", now: new Date() })) return;
      const n = new Notification({ title: `${a.fromName} wants to take over “${a.title}”`, body: "Hand over, or keep it?" });
      n.on("click", () => focusPane(a.sessionId));
      n.show();
    },
    onReceived: (r) => notifySession(r.sessionId, `Changes from ${r.fromName}`, `${r.files.length === 1 ? "1 changed file" : `${r.files.length} changed files`} from their copy of ${r.title}, to review`),
    chat: (roomId, text) => void teamRoom.chat.post(roomId, text),
  });
}
const titleOfSession = (id: string) => [...sessions.list(), ...sessions.resumable()].find((s) => s.id === id)?.title ?? "a room session";
// a session a teammate continues never runs here again (team rooms: take-over)
sessions.relaunchGuard = (id) => takeover?.relaunchRefusal(id) ?? null;
// a Claude conversation a relaunch resumes may be running in Claude Code's background, outside its pane
sessions.freeConversation = async (conv) => {
  if (conv.agent !== "claude") return null;
  const bin = await installedBin("claude");
  return bin ? freeForResume(claudeRunner(bin, paneEnv()), conv.id) : null;
};
const needTakeover = (): TakeoverService => {
  if (!takeover) throw new Error("Team rooms haven't started — see Settings → Team");
  return takeover;
};

// team rooms: one log of what teammates did on this Mac (~/.mockingbird/team/audit.log)
const remoteAudit = new RemoteAudit({ log: logError });

// phone alerts: started once the app is ready (powerMonitor needs it)
let phone: PhoneService | null = null;

// team rooms: live panes — sessions in shared groups, streamed to teammates, typed into with their owner's consent
const livePanes = new LivePanes({
  team: () => team.transport,
  rooms: () => team.status().rooms.map((r) => ({ id: r.id, groupKey: r.groupKey })),
  sessions,
  settings: () => store.settings,
  notify: (title, body, paneId) => {
    const n = new Notification({ title, body });
    n.on("click", () => focusPane(paneId));
    n.show();
  },
  toWindow,
  audit: (line) => Store.audit(line),
  remoteAudit,
  log: logError,
});

// Run and Debug: a repo's services per worktree, each on its own terminal,
// optionally under the debugger
const debug = new DebugManager({ emit: toWindow });
const runs = new RunManager({
  debugger: debug,
  debugTarget: debugTargetFor,
  spawn: (command, opts) => pty.spawn("/bin/zsh", ["-ilc", command], { name: PTY_TERM, cols: 120, rows: 30, cwd: opts.cwd, env: opts.env }),
  emit: toWindow,
  baseEnv: terminalEnv,
  docker: async () => {
    const bin = await which("docker");
    if (!bin) throw new Error("Docker isn't installed (or isn't on your shell's PATH)");
    return bin;
  },
  runShell: (command, cwd, env) => userShellWithInput(command, "", { cwd, env, timeoutMs: 120_000 }),
});

/** Every IPC call answers rather than rejects: a failure comes back as `{ error }` and is logged. */
function handle(channel: string, fn: (...args: any[]) => unknown): void {
  const run = guarded(channel, fn, logError);
  ipcMain.handle(channel, (_e, ...args) => run(...args));
}

// The agents' binaries are found by a login shell. binFor() before that has
// answered looks them up synchronously, holding up the main process and every
// pane, so callers that can wait go through lookUpBins() first. Lookups are
// queued, so a reset (Settings named another binary) never interleaves with one.
let binsReady: Promise<void> = Promise.resolve();
function lookUpBins(reset = false): Promise<void> {
  binsReady = binsReady
    .then(() => {
      if (reset) {
        sessions.resetBinCache();
        claudeHelp.forget(); // another claude may offer other models
      }
      return sessions.warmBins();
    })
    .catch((err) => {
      logError("bins", err);
    });
  return binsReady;
}
/** The agent's binary when the user's shell found it, else null (not installed). */
async function installedBin(kind: AgentKind): Promise<string | null> {
  await lookUpBins();
  const bin = sessions.binFor(kind);
  return isInstalledBin(bin) ? bin : null;
}
const otherAgent = (a: AgentKind): AgentKind => (a === "claude" ? "codex" : "claude");
/** The agent to ask a one-off question: the one wanted, or the other one when it isn't installed. */
async function askingAgent(want: AgentKind = "claude"): Promise<{ agent: AgentKind; bin: string }> {
  for (const agent of [want, otherAgent(want)]) {
    const bin = await installedBin(agent);
    if (bin) return { agent, bin };
  }
  return { agent: want, bin: sessions.binFor(want) }; // neither: askAgent says it isn't installed
}
/** One question for an agent's CLI (Sonnet, for Claude), answered with the reply alone; an empty reply is an error naming `what`. */
async function askFor(prompt: string, who: { agent: AgentKind; bin: string }, o: { tag: string; label: RegExp; timeoutMs: number; what: string }): Promise<string> {
  const reply = await askAgent(prompt, { ...who, run: userShellWithInput, env: paneEnv(), tag: o.tag, model: "sonnet", timeoutMs: o.timeoutMs });
  const text = cleanReply(reply, o.label);
  if (!text) throw new Error(`The model returned an empty ${o.what}`);
  return text;
}

// Coalesced notifications: at most one per session per 30s (design 1a).
const lastNotified = new Map<string, number>();
function notifySession(sessionId: string, title: string, body: string, kind: "waiting" | "finished" | "other" = "other"): void {
  const session = sessions.list().find((s) => s.id === sessionId);
  if (!shouldNotify({ settings: store.settings, session, kind, now: new Date() })) return;
  const last = lastNotified.get(sessionId) ?? 0;
  if (Date.now() - last < 30_000) return;
  lastNotified.set(sessionId, Date.now());
  new Notification({ title, body }).show();
}

// ---- Menu bar + Dock glanceability (design 1h) ----
// The Dock badge and tray count reflect sessions blocked on you ONLY — never
// working sessions. No badge when nothing is waiting.
let tray: Tray | null = null;

// the same reading the pane shows for how long it has waited
const fmtWait = (since: number | null): string => (since ? fmtElapsed(since) : "");

function focusPane(sessionId?: string): void {
  const win = appWindow();
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
  if (sessionId) win.webContents.send("ui:command", UI_COMMANDS.focusSession, sessionId);
}

function focusRoom(roomId: string): void {
  focusPane();
  toWindow("collab:focus", roomId);
}

function updateTray(): void {
  if (!tray) return;
  const list = sessions.list();
  const waiting = list
    .filter((s) => s.status === "waiting")
    .sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0));
  const working = list.filter((s) => s.status === "working").length;
  const idle = list.filter((s) => s.status === "idle").length;
  const dead = list.filter((s) => s.status === "dead").length;
  // Collaborate models waiting on an approval are blocked on the user too
  const asks = collab.list().flatMap((r) => (r.pending ?? []).map((q) => ({ room: r, q }))).sort((a, b) => a.q.at - b.q.at);
  const blocked = waiting.length + asks.length;

  tray.setTitle(blocked ? `🪶 ${blocked}` : "🪶", { fontType: "monospacedDigit" });
  app.dock?.setBadge(blocked ? String(blocked) : "");

  const template: Electron.MenuItemConstructorOptions[] = [];
  if (asks.length) {
    template.push({ label: `MODELS ASKING YOU · ${asks.length}`, enabled: false });
    for (const { room, q } of asks) {
      const who = room.participants.find((p) => p.key === q.seat)?.label ?? q.seat;
      const what = (q.tool === "Bash" ? q.detail : `${q.tool} ${q.detail}`).replace(/\s+/g, " ");
      template.push({
        label: `${who}: ${what.length > 48 ? `${what.slice(0, 47)}…` : what}   ${fmtWait(q.at)}`,
        click: () => focusRoom(room.id),
      });
    }
    template.push({ type: "separator" });
  }
  if (waiting.length) {
    template.push({ label: `WAITING FOR YOU · ${waiting.length}`, enabled: false });
    for (const s of waiting) {
      template.push({
        label: `${s.title}   ${fmtWait(s.waitingSince)}`,
        click: () => focusPane(s.id),
      });
    }
    template.push({ type: "separator" });
  }
  template.push({ label: `${working} working`, enabled: false });
  template.push({ label: `${idle} idle · ${dead} dead`, enabled: false });
  template.push({ type: "separator" });
  template.push({
    label: "New session ⌘N",
    click: () => {
      focusPane();
      toWindow("ui:command", UI_COMMANDS.newSession);
    },
  });
  template.push({ label: "Run 4pm wrap-up", click: () => runDebrief("wrapUp", sessions, store).catch((err) => logError("debrief:wrapUp", err)) });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    // the top bar folds what doesn't fit behind », down to the brand, the open tab, Needs you and + New: about 500 px
    minWidth: 640,
    title: "Mockingbird",
    backgroundColor: "#1a1917",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  // closing the window quits the app: the hidden team window mustn't keep it open
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    stopTeam();
  });
  // a reload, a renderer that went, or the window closing: the room chats it said were on screen are no longer
  forgetViewsWith(win.webContents, () => teamRoom.chat.setViewing(null));
  win.loadFile(path.join(__dirname, "index.html"));
  // the editor holds unsaved changes: the window says so (beforeunload), and
  // quitting asks first. A signal quits regardless: the question would hold
  // the app open with no one to answer it, and a modal question blocks the
  // main process, so not even a second signal would get through.
  win.webContents.on("will-prevent-unload", (event) => {
    if (quit.bySignal) {
      logLine(`quit: unsaved editor changes discarded, quitting on ${quit.bySignal}`);
      event.preventDefault();
      return;
    }
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Quit without saving", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Some files have unsaved changes",
      detail: "Edits in the editor that haven't been saved (⌘S) will be lost.",
    });
    if (choice === 0) {
      event.preventDefault(); // go ahead and unload
      quit.resumed();
      return;
    }
    quit.cancelled();
    if (pendingInstall) {
      // the quit is off, and so is the restart into the update
      pendingInstall = null;
      updater.installAborted();
    }
  });
  sessions.attach(win.webContents);
}

app.whenReady().then(() => {
  if (!isPrimary) return;
  // node-pty ships spawn-helper without its exec bit (microsoft/node-pty#850) —
  // the cause of "posix_spawnp failed" on macOS. Repair every candidate location.
  const ptyRoot = path.join(__dirname, "..", "node_modules", "node-pty");
  const candidates = [path.join(ptyRoot, "build", "Release", "spawn-helper")];
  try {
    for (const d of fs.readdirSync(path.join(ptyRoot, "prebuilds"))) {
      candidates.push(path.join(ptyRoot, "prebuilds", d, "spawn-helper"));
    }
  } catch {
    /* no prebuilds dir */
  }
  for (const c of candidates) {
    try {
      fs.chmodSync(c, 0o755);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") logError(`spawn-helper chmod ${c}`, err);
    }
  }
  createWindow();
  team.start();
  if (team.transport) remoteAudit.watch(team.transport); // team rooms: the audit log of remote actions
  if (team.transport) teamHouse.start(team.transport); // team rooms: the House board
  if (team.transport) teamChanges.start(team.transport); // team rooms: teammates' changes, migration numbers
  if (team.transport) teamArtifacts.start(team.transport); // team rooms: artifacts
  // team rooms: take-over — unneeded backups are pruned now and daily
  takeover = startTakeover();
  const pruneBackups = () => takeover?.prune().catch((err) => logError("team: pruning room backups", err));
  void pruneBackups();
  setInterval(pruneBackups, 86_400_000).unref();
  livePanes.start(); // team rooms: live panes
  roomsKnown = true; // started, or found team rooms can't run: either way roomOfSession can be believed from here
  wireTools.roomsStarted(); // what launched before now heard nothing of its wires
  // team rooms: a room left or removed from whose cleanup didn't finish (Mockingbird quit) is cleaned up now
  void team.finishLeftRooms().catch((err) => logError("team: finishing rooms left before", err));
  powerMonitor.on("resume", () => team.wake());
  // phone alerts: iMessages while you're away, and replies to them (Settings → Notifications)
  phone = startPhoneService({
    packaged: app.isPackaged,
    monitor: powerMonitor,
    sessions,
    settings: () => store.settings,
    audit: remoteAudit,
    log: logError,
    notify: (title, body) => new Notification({ title, body }).show(),
    onChanged: (s) => toWindow("phone:changed", s),
  });
  // find claude/codex in the background now, so the first session doesn't block on a login shell
  void lookUpBins();
  startTranscriptIndex();

  // update polling: notify once per new version; user updates when they choose
  let notifiedVersion = "";
  const pollUpdates = async () => {
    try {
      const u = await checkForUpdate();
      if (u?.newer) {
        toWindow("update:available", u);
        if (notifiedVersion !== u.latest && store.settings.notifications) {
          notifiedVersion = u.latest;
          const n = new Notification({
            title: "Mockingbird update available",
            body: `v${u.latest} is out (you're on v${u.current}). Click to update — Mockingbird builds it in your clone.`,
          });
          // the window's update panel pulls, builds and restarts in-app
          n.on("click", () => {
            focusPane();
            toWindow("ui:command", UI_COMMANDS.update);
          });
          n.show();
        }
      }
    } catch (err) {
      logError("update check", err);
    }
  };
  setTimeout(pollUpdates, 10_000);
  setInterval(pollUpdates, 6 * 3_600_000);

  // dev runs show Electron's default Dock icon — swap in the feather
  // (packaged builds get it from build/icon.icns via electron-builder)
  const devIcon = path.join(__dirname, "..", "build", "icon.png");
  if (!app.isPackaged && app.dock && fs.existsSync(devIcon)) app.dock.setIcon(devIcon);
  tray = new Tray(nativeImage.createEmpty());
  sessions.onChanged = updateTray;
  updateTray();
  setInterval(updateTray, 60_000); // keep wait durations in the dropdown fresh
  const messaging = new Messaging(
    sessions,
    submitsAgentMessages,
    (from, to) =>
      notifySession(
        from.id,
        "Agents paused messaging",
        `${from.ticketTitle ?? from.title} ↔ ${to.ticketTitle ?? to.title} hit the message limit — check on them`
      ),
    recordMessage,
    {
      log: logError,
      // Messaging calls this once per pane launch; it shows under the notification settings every pane's notices follow
      onToolsLost: ({ session, why }) => {
        if (!shouldNotify({ settings: store.settings, session, kind: "other", now: new Date() })) return;
        const n = new Notification(toolsLostNotice({ title: session.ticketTitle ?? session.title, why }));
        n.on("click", () => focusPane(session.id));
        n.show();
      },
    }
  );
  messaging.start();
  messaging.setRoomHandler((roomId, seat, op, args) => collab.handleRoomRequest(roomId, seat, op, args));
  messaging.setWires(wires);
  messaging.setWireTools(wireTools);
  messaging.setTicketTools(ticketTools);
  // team rooms: team chat
  teamRoom.start(team.transport, messaging);
  const beforeTeamRoom = sessions.onChanged;
  sessions.onChanged = () => {
    beforeTeamRoom?.();
    teamRoom.sessionsChanged();
  };
  // the plan name isn't in Claude's statusline payload; `claude auth status` has it
  void (async () => {
    const bin = await installedBin("claude");
    if (!bin) return;
    const r = await userShell(`${quote(bin)} auth status 2>/dev/null`);
    try {
      setClaudePlan(JSON.parse(r.out).subscriptionType ?? null);
    } catch {
      console.warn(`usage: couldn't read the Claude plan from auth status: ${r.out.slice(0, 200)}`);
    }
    toWindow("usage:changed", readUsage());
  })();
  watchUsage((u) => {
    toWindow("usage:changed", u);
    metersChanged();
  });
  ensureHookScript();
  watchEvents(sessions, (info, status) => {
    notifySession(
      info.id,
      status === "waiting" ? "Needs input" : "Finished",
      status === "waiting"
        ? `${info.title} · ${info.waitingReason ?? "waiting on you"}`
        : `${info.title} is done responding`,
      status === "waiting" ? "waiting" : "finished"
    );
    if (status === "waiting" || status === "idle") phone?.alerts.sessionStatus(info, status);
  }, (info, prompt) => {
    // the files before this turn, so it can be undone (agent panes in a repository only)
    if (info.shell || !info.repoPath) return;
    takeSnapshot(info.cwd, info.id, prompt).then(
      () => snapshotErrors.delete(info.id),
      (err) => snapshotErrors.set(info.id, logError(`snapshot ${info.id}`, err))
    );
  }, (e) => (e.kind === "room" ? teamChanges.roomCheck(e.notice) : teamHouse.claimEvent(e))); // team rooms: the room checks in the agents' hooks
  startScheduler(sessions, store);
  app.on("activate", () => {
    if (!appWindow()) createWindow();
  });
});

// each pane's scrollback, so relaunched panes show their earlier output
setInterval(() => sessions.saveScrollback(), 60_000);

// quitting (see QuitSequence): services and debug sessions Mockingbird started
// stop first, so nothing keeps holding ports, containers or debug windows; once
// nothing can cancel the quit, the steps below run and the panes' ptys end
// before Node is torn down
const quit = new QuitSequence({
  app,
  log: (line) => {
    if (isPrimary) logLine(line); // a second copy only hands over to the first
  },
  logError: (context, err) => void logError(context, err),
  stopServices: () => {
    const running = runs.states().some((s) => s.status === "running" || s.status === "starting" || s.status === "stopping") || debug.infos().some((d) => d.state !== "ended");
    if (!running) return null;
    return Promise.allSettled([runs.stopAll(), debug.stopAll()]).then(([r, d]) => {
      if (r.status === "rejected") logError("run:stopAll on quit", r.reason);
      if (d.status === "rejected") logError("debug:stopAll on quit", d.reason);
    });
  },
  steps: [
    { name: "saving scrollback", run: () => sessions.saveScrollback(true) },
    { name: "saving the landscape", run: () => landscape.flush() },
    { name: "removing tool tokens", run: () => removeMcpTokenFiles() },
    { name: "stopping team rooms", run: () => stopTeam() },
    { name: "stopping phone alerts", run: () => phone?.stop() },
    // whatever debug session outlasted the services' bounded stop: its adapter's process group ends now
    { name: "ending debug sessions", run: () => debug.endAll() },
    { name: "stopping language servers", run: () => void lsp.stopAll().catch((err) => logError("lsp:stopAll on quit", err)) },
    { name: "starting the update's installer", run: () => startPendingInstall() },
  ],
  endPtys: () => sessions.shutdown(),
  killPtys: () => sessions.killAll(),
});
app.whenReady().then(() => quit.listenForSignals(process));

// team rooms stop once, whichever comes first (the window closing, or quitting): see stopTeamRooms for the order
let teamStopped = false;
function stopTeam(): void {
  if (teamStopped) return;
  teamStopped = true;
  stopTeamRooms({ livePanes, chat: teamRoom, house: teamHouse, changes: teamChanges, artifacts: teamArtifacts, takeover: () => takeover, audit: remoteAudit, team }, logError);
}

app.on("window-all-closed", () => {
  app.quit();
});

// ---- IPC ----
handle("sessions:list", () => sessions.list());
handle("sessions:resumable", () => sessions.resumable());
handle("sessions:closedOutput", (id) => sessions.closedOutput(String(id)));
handle("sessions:missingFolders", () => sessions.missingFolders());
handle("sessions:create", async (req) => {
  const info = await sessions.create(req);
  if (info.repoPath) overlapsSoon(info.cwd);
  // a session opened on a ticket means its coding has started
  if (req?.ticketId && pipeline.startCoding(String(req.ticketId), req.ticketTitle ?? undefined, BY_YOU)) pipelineChanged();
  return info;
});
/** Reopen closed session `id`, as the window's Reopen and a wire's Send to it do; null when it has no record. */
async function reopenSession(id: string): Promise<SessionInfo | null> {
  const info = await sessions.relaunch(id);
  if (!info) return info;
  // it's running again, so it belongs in its own area; logged rather than refused, as it's reopened either way
  try {
    landscape.sessionReopened(info);
  } catch (err) {
    logError(`landscape: placing ${info.id} again`, err);
  }
  return info;
}
handle("sessions:relaunch", (id) => reopenSession(id));
handle("sessions:resume", (id) => sessions.resume(String(id)));
handle("sessions:mute", (id, muted) => sessions.setMuted(String(id), !!muted));
handle("sessions:kill", (id, forget) => {
  // a pane closed to resume isn't live any more, but forgetting it later must still find it
  const s = sessions.list().find((x) => x.id === id) ?? sessions.resumable().find((x) => x.id === id);
  const r = sessions.kill(id, forget);
  // a forgotten session's snapshots go with it; a resumable one keeps them. They
  // are the repository's refs, so the main checkout reaches them once a
  // worktree has been removed
  if (forget && s?.repoPath) {
    const at = fs.existsSync(s.cwd) ? s.cwd : s.repoPath;
    dropSnapshots(at, s.id).catch((err) => logError(`drop snapshots ${id}`, err));
  }
  if (forget) void takeover?.sessionForgotten(String(id)); // team rooms: take-over — its room backup goes too (failures shown in the sidebar)
  if (forget) wires.sessionForgotten(String(id));
  return r;
});
handle("sessions:restartAll", (includeBusy) => sessions.restartAll(!!includeBusy));
handle("session:buffer", (id) => sessions.paneBuffer(id));
handle("sessions:broadcast", (req: Partial<BroadcastRequest>) => {
  if (typeof req?.message !== "string" || !req.message) throw new Error("Nothing to broadcast");
  return sessions.broadcast(req.message, req.sessionIds ?? [], req.whenIdle ?? true);
});
ipcMain.on("session:write", (_e, id, data) => sessions.write(id, data));
// Audit trail for the "something typed /clear into my session" class of bug:
// the renderer reports any pty write it did not attribute to a keystroke.
ipcMain.on("session:audit", (_e, id, kind, data) =>
  Store.audit(`${kind} session=${id} bytes=${JSON.stringify(String(data).slice(0, 300))}`)
);
ipcMain.on("session:resize", (_e, id, cols, rows) => sessions.resize(id, cols, rows));

/** A worktree is shared on purpose (a handoff's or review's session runs in the same folder): removing it from under one that's live breaks it. */
function assertWorktreeFree(wtPath: string): void {
  const s = liveSessionIn(sessions.list(), wtPath);
  if (s) throw new Error(`"${s.ticketTitle ?? s.title}" is still running in that worktree — close it first`);
}
handle("repos:list", () => indexRepos(store.settings.repoRoots));
handle("worktree:state", (wtPath) => worktreeState(wtPath));
handle("worktree:cleanup", (repo, wtPath, mode) => {
  assertWorktreeFree(String(wtPath));
  return cleanupWorktree(repo, wtPath, mode);
});
handle("worktrees:list", () =>
  listWorktrees(
    indexRepos(store.settings.repoRoots),
    sessions.list().map((s) => s.cwd)
  )
);
handle("worktrees:remove", async (repo, wtPath) => {
  assertWorktreeFree(String(wtPath));
  await removeWorktree(repo, wtPath);
  return true;
});
handle("worktrees:migrate", async (repo, wtPath) => {
  assertWorktreeFree(String(wtPath));
  const dest = await migrateWorktree(repo, wtPath);
  // previous sessions must follow their checkout, or resuming them would
  // try to re-add a branch that is already checked out at the new path
  let touched = false;
  for (const rec of store.state.sessions) {
    if (samePath(rec.cwd, wtPath)) {
      rec.cwd = dest;
      touched = true;
    }
  }
  if (touched) store.save();
  return dest;
});
function sessionOf(id: string): SessionInfo {
  const s = sessions.list().find((x) => x.id === id);
  if (!s && isRemotePaneId(id)) throw new Error("That's a teammate's session: it runs on their Mac");
  if (!s) throw new Error("Session is no longer running");
  return s;
}
/** What the handlers that refuse a copy a teammate took over look sessions up with (takenOverGuard.ts). */
const untaken: UntakenDeps<SessionInfo> = { sessionOf, refusal: () => (takeover ? (sid, doing) => takeover!.takenOverRefusal(sid, doing) : null) };
// The explorer addresses files by session id + relative path, so the renderer
// can only reach into folders a live session actually runs in.
const sessionRoot = (sessionId: string) => sessionOf(sessionId).cwd;
handle("files:list", (id, rel) => listDir(sessionRoot(id), rel));
handle("files:read", (id, rel) => readFile(sessionRoot(id), rel));
handle("files:write", (id, rel, content, expected) => {
  if (typeof content !== "string") throw new Error("Nothing to save");
  return writeFile(sessionRoot(id), String(rel), content, typeof expected === "number" ? expected : null);
});
handle("files:changes", (id, scope) => gitChanges(sessionRoot(id), scope));
// a landscape card's diff badge: its worktree against its area repo's base (null: the repository's own)
handle("git:branchStat", (id, base) => branchStat(sessionRoot(String(id)), typeof base === "string" && base.trim() ? base.trim() : null));
handle("files:diff", (id, rel, scope, untracked) => fileDiff(sessionRoot(id), rel, scope, untracked));
// Folders the window shows are watched, so its views refresh on a change instead
// of polling. Addressed by session id, like the explorer: only live sessions' folders.
const folderWatcher = new FolderWatcher(
  (root) => {
    forgetState(root);
    forgetBranchStat(root);
    toWindow("folder:changed", root);
    overlapsSoon(root);
  },
  (root, err) => logError(`folder watch ${root}`, err)
);
handle("folders:watch", (ids: unknown) => {
  const live = new Map(sessions.list().map((s) => [s.id, s.cwd]));
  const roots = (Array.isArray(ids) ? ids : []).map((id) => live.get(String(id))).filter((r): r is string => !!r);
  return folderWatcher.set(roots);
});
handle("run:profile", async (id) => {
  const worktree = sessionRoot(id);
  const repo = await mainCheckout(worktree);
  return { worktree, repo, file: profilePath(repo), profile: loadProfile(repo) };
});
handle("run:saveProfile", async (id, profile) => saveProfile(profile, await mainCheckout(sessionRoot(id))));
handle("run:draft", async (id) => {
  const repo = await mainCheckout(sessionRoot(id));
  return draftProfile(repo, (await installedBin("claude")) ?? "claude", userShellWithInput, paneEnv() as Record<string, string>);
});
handle("run:start", (id, opts) =>
  runs.start(sessionRoot(id), {
    mode: opts?.mode === "side" ? "side" : "swap",
    services: Array.isArray(opts?.services) ? opts.services.map(String) : undefined,
    debug: Array.isArray(opts?.debug) ? opts.debug.map(String) : undefined,
  })
);
handle("run:stopListeners", (id, pids) => runs.stopListeners(sessionRoot(id), (Array.isArray(pids) ? pids : []).map(Number)));
handle("run:stop", (id, services) => runs.stop(sessionRoot(id), Array.isArray(services) ? services.map(String) : undefined));
handle("run:prepare", (id) => runs.prepare(sessionRoot(id)));
handle("run:states", () => runs.states());
handle("run:buffer", (runId) => runs.buffer(String(runId)));
handle("run:clear", (runId) => runs.clear(String(runId)));
// the debugger: breakpoints are the repo's (relative paths), sessions are addressed by their own id
handle("debug:breakpoints", async (id) => {
  const repo = await mainCheckout(sessionRoot(id));
  return { repo, breakpoints: debug.breakpoints(repo) };
});
handle("debug:setBreakpoints", async (id, rel, lines) => {
  const repo = await mainCheckout(sessionRoot(id));
  const r = await debug.setBreakpoints(repo, String(rel), Array.isArray(lines) ? lines.map(Number) : []);
  toWindow("debug:breakpointsChanged", repo);
  return r;
});
handle("debug:sessions", () => debug.infos());
handle("debug:control", (sid, op, threadId) => {
  if (!["continue", "next", "stepIn", "stepOut", "pause"].includes(op)) throw new Error(`Unknown debug command: ${op}`);
  return debug.control(String(sid), op, typeof threadId === "number" ? threadId : undefined);
});
handle("debug:stack", (sid, threadId) => debug.stackTrace(String(sid), Number(threadId)));
handle("debug:scopes", (sid, frameId) => debug.scopes(String(sid), Number(frameId)));
handle("debug:variables", (sid, ref) => debug.variables(String(sid), Number(ref)));
handle("debug:evaluate", (sid, expr, frameId, context) =>
  debug.evaluate(String(sid), String(expr), typeof frameId === "number" ? frameId : undefined, context === "watch" || context === "hover" ? context : "repl")
);
handle("debug:stop", (sid) => debug.stop(String(sid)));
handle("run:stopById", (runId) => runs.stopById(String(runId)));
ipcMain.on("run:write", (_e, runId, data) => runs.write(String(runId), String(data)));
ipcMain.on("run:resize", (_e, runId, cols, rows) => runs.resize(String(runId), Number(cols), Number(rows)));
handle("files:all", (id) => listAllFiles(sessionRoot(id)));
handle("files:search", (id, query, opts) => searchFiles(sessionRoot(id), String(query ?? ""), { regex: !!opts?.regex, matchCase: !!opts?.matchCase }));
// Source control for a session's folder (addressed by session id, like the explorer)
handle("scm:status", (id) => scmStatus(sessionRoot(id)));
handle("scm:stage", (id, paths) => scmStage(sessionRoot(id), paths));
handle("scm:unstage", (id, paths) => scmUnstage(sessionRoot(id), paths));
handle("scm:discard", (id, entries) => scmDiscard(sessionRoot(id), entries, (abs) => shell.trashItem(abs)));
handle("scm:commit", (id, message) => scmCommit(sessionRoot(id), String(message ?? "")));
handle("scm:push", (id) => scmPush(sessionRoot(id)));
handle("scm:pull", (id) => scmPull(sessionRoot(id)));
handle("scm:fetch", (id) => scmFetch(sessionRoot(id)));
handle("scm:graph", (id, limit) => scmGraph(sessionRoot(id), Math.min(2000, Math.max(20, Number(limit) || 150))));
handle("scm:commitFiles", (id, sha) => scmCommitFiles(sessionRoot(id), String(sha)));
handle("scm:commitDiff", (id, sha, rel) => scmCommitDiff(sessionRoot(id), String(sha), String(rel)));
// a commit message from the folder's staged change (or all of it), written by the
// session's own agent — or the other one when that isn't installed
handle("scm:commitMessage", async (id) => {
  const s = sessionOf(id);
  const { agent, bin } = await askingAgent(s.agent ?? "claude");
  return { ...(await generateCommitMessage(s.cwd, agent, bin, userShellWithInput, paneEnv())), agent };
});
handle("scm:diff", (id, rel, staged, untracked) => scmDiff(sessionRoot(id), rel, !!staged, !!untracked));
handle("repo:branches", (repoPath) => listBranches(expandHome(repoPath)));

handle("claudemd:read", (p) => {
  const full = instructionFile(p);
  // "file not there yet" is an empty editor; anything else (permissions, EISDIR)
  // must surface — otherwise a save writes "" over a file we simply couldn't read
  if (!fs.existsSync(full)) return { path: full, content: "" };
  return { path: full, content: fs.readFileSync(full, "utf8") };
});
handle("claudemd:save", (p, content) => {
  const full = instructionFile(p);
  if (typeof content !== "string") throw new Error("Nothing to save");
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return true;
});

handle("usage:get", () => readUsage());
handle("usage:context", (id: string): ContextWindow => {
  const s = sessions.list().find((x) => x.id === id);
  return s ? readContextWindow(s) : { state: "none", why: "This session isn't running" };
});
// the context warning's actions: Compact (only at an idle prompt), a fresh session from a brief, and cost estimates
handle("usage:compact", (id: string) => sessions.compact(String(id)));
/** Weighted units per 1% of `agent`'s 5-hour limit, from this Mac's use of the window; null without a reading. */
function planRate(agent: AgentKind): number | null {
  const w = fiveHourWindows(readUsage(), Date.now())[agent];
  if (!w || !transcripts) return null;
  return planRateOf(transcripts.usage({ since: w.start }).filter((r) => r.agent === agent), w.usedPct);
}
handle("usage:resumeCost", (id: string): ResumeEstimate | null => {
  const s = sessions.list().find((x) => x.id === id) ?? sessions.resumable().find((x) => x.id === id);
  if (!s || s.shell) return null;
  const cw = readContextWindow(s);
  return cw.state === "reading" ? resumeEstimate(cw, planRate(cw.agent), Date.now()) : null;
});
handle("usage:brief", async (id: string): Promise<RefreshBrief> => {
  const s = sessionOf(String(id));
  if (s.shell) throw new Error("A terminal has no conversation to brief from");
  if (s.role === "tasks") throw new Error(HELPDESK_KEEPS_ITS_CONVERSATION);
  const conv = s.conversation?.id ?? conversationsOf(s).at(-1);
  if (!conv) throw new Error("Couldn't read the conversation: Mockingbird hasn't seen this session's conversation yet");
  if (!transcripts) throw new Error(`Couldn't read the conversation: the conversation index isn't available${transcriptsProblem ? ` (${transcriptsProblem})` : ""}`);
  await syncForFiles(transcripts);
  const agent: AgentKind = s.agent ?? "claude";
  try {
    return await refreshBrief(s, { files: transcripts.filesOf(conv), conversationId: conv, context: readContextWindow(s), rate: planRate(agent), now: Date.now() });
  } catch (err) {
    throw new Error(`Couldn't read the conversation: ${(err as Error).message}`);
  }
});
// a landscape card's "what it did": the first line of its agent's latest message, from its conversation's transcript.
// The file is found now (the one its hooks named, its project folder's, the newest rollout), not when the index next
// syncs. Nothing said yet (no conversation seen, its transcript not written yet, a terminal) is `{ line: null }`; a
// file that can't be read is an error, which the card shows as one
handle("transcripts:lastReply", async (id): Promise<LastReply> => {
  const s = sessions.list().find((x) => x.id === id) ?? sessions.resumable().find((x) => x.id === id);
  if (!s) throw new Error(isRemotePaneId(String(id)) ? "That's a teammate's session: its conversation is on their Mac" : "Session is no longer running");
  const conv = s.shell ? undefined : (s.conversation?.id ?? conversationsOf(s).at(-1));
  if (!conv) return { line: null, at: null };
  const { agent, lookup } = conversationLookup(s, conv);
  return replyOfConversation(agent, conv, lookup);
});
/** Where session `s`'s conversation `conv` is read from now, and whose agent wrote it. */
function conversationLookup(s: SessionInfo, conv: string): { agent: AgentKind; lookup: ConversationLookup } {
  const agent: AgentKind = s.conversation?.id === conv ? s.conversation.agent : (s.agent ?? "claude");
  return {
    agent,
    lookup: {
      hook: sessions.transcriptOf(s.id, conv),
      roots: [CLAUDE_PROJECTS, CODEX_SESSIONS],
      indexed: transcripts?.filesOf(conv) ?? [],
      locate: () => (agent === "claude" ? claudeTranscriptOf(conv, s.cwd) : codexRolloutOf(conv)),
      log: logError,
    },
  };
}
// a session of the same agent in the same folder and group, started from the brief
handle(
  "usage:briefStart",
  untakenHandler("usage:briefStart", untaken, (s, brief: unknown) => {
    const text = String(brief ?? "").trim();
    if (!text) throw new Error("The brief is empty");
    return companionSession(s, s.agent ?? "claude", `${s.ticketTitle ?? s.title} · fresh`, text);
  })
);
handle("hooks:installed", async () => hooksInstalled(await installedBin("codex")));
handle("hooks:install", async () => installHooks(await installedBin("codex")));
handle("app:version", () => app.getVersion());

// ---- Collaborate rooms ----
const collab = new CollabRooms(
  COLLAB_DIR,
  cliTurnRunner((agent) => sessions.binFor(agent)),
  (room) => {
    toWindow("collab:changed", room);
    updateTray(); // a model waiting on the user counts as blocked
  },
  (req) => sessions.create(req),
  async (repo) => (await listBranches(repo)).defaultBase,
  (room, req, reminder) => {
    // the model's turn is waiting on this, so it's shown whatever the notifications setting
    const who = room.participants.find((p) => p.key === req.seat)?.label ?? req.seat;
    const n = new Notification({
      title: reminder ? `Still waiting: ${who} is asking permission` : `${who} is asking permission`,
      body: `${room.title}\n${req.tool === "Bash" ? req.detail : `${req.tool} ${req.detail}`}`.slice(0, 240),
    });
    n.on("click", () => focusRoom(room.id));
    n.show();
  },
  // levels the CLIs accept: what they told us, plus the built-in list until they have
  () => ({
    claude: [...new Set([...COLLAB_EFFORTS.claude, ...(lastCatalog?.claude.efforts ?? [])])],
    codex: [...new Set([...COLLAB_EFFORTS.codex, ...(lastCatalog?.codex.efforts ?? [])])],
  })
);

handle("collab:models", async () => {
  try {
    const c = await modelCatalog();
    const { presets, defaults } = collabModels(c);
    return { presets: presets.length ? presets : COLLAB_MODELS, defaults: defaults.length ? defaults : COLLAB_MODELS, efforts: { claude: c.claude.efforts, codex: c.codex.efforts } };
  } catch (err) {
    logError("collab:models", err); // the built-in trio still lets a room start
    return { presets: COLLAB_MODELS, defaults: COLLAB_MODELS, efforts: COLLAB_EFFORTS };
  }
});
handle("collab:repo", (id, repo) => collab.setRepo(id, repo));
handle("collab:permission", (id, reqId, decision) => collab.answerPermission(id, reqId, decision));
handle("collab:askTimeout", (id, minutes) => collab.setAskTimeout(id, Number(minutes)));
handle("collab:revokeKind", (id, kind) => collab.revokeAllowKind(id, kind));
handle("collab:resetCopy", (id) => collab.resetTestCopy(id));
handle("collab:participants", (id, specs) => collab.setParticipants(id, specs));
handle("collab:list", () => collab.list());
handle("collab:problems", () => collab.unreadable());
handle("collab:create", (spec) => collab.create(spec));
handle("collab:delete", (id) => collab.delete(id));
handle("collab:send", (id, text) => collab.send(id, text));
handle("collab:run", (id) => {
  // runs for minutes; progress arrives as collab:changed, failures are logged and shown in the room
  collab.run(id).catch((err) => logError("collab:run", err));
  return true;
});
handle("collab:stop", (id) => collab.stop(id));
handle("collab:mode", (id, mode, rounds) => collab.setMode(id, mode, rounds));
handle("collab:synthesize", (id, key) => collab.synthesize(id, key));
handle("collab:approve", (id, messageId) => collab.approve(id, messageId));
handle("collab:implement", (id, key) => collab.implement(id, key));
// an approved plan as Radley House tickets: created only from the user's click, with their own builder token
const councilTickets = new CouncilTickets(collab, teamHouse);
handle("collab:ticketDrafts", (id) => collab.ticketDrafts(String(id)));
handle("collab:saveTicketDrafts", (id, drafts) => collab.setTicketDrafts(String(id), drafts ?? null));
handle("collab:wholePlanTicket", (id) => collab.wholePlanTicket(String(id)));
handle("collab:splitWithModel", (id, key) => collab.splitPlanWithModel(String(id), String(key)));
handle("collab:ticketTargets", (id) => councilTickets.targets(String(id)));
handle("collab:ticketConsent", (id, target, allow) => councilTickets.consent(String(id), target, allow === true));
handle("collab:createTickets", (id, target, drafts, track) => councilTickets.create(String(id), target, drafts, track === true));
handle("collab:openTicket", async (id, n) => {
  const { url, problem } = await councilTickets.url(String(id), Number(n));
  if (!externalUrlAllowed(url)) throw new Error(`The House's address isn't an https link (${url.slice(0, 80)})`);
  await shell.openExternal(url);
  return problem ? { note: problem } : {};
});
handle("setup:status", () => setupStatus(store, { binFor: (kind) => sessions.binFor(kind), refresh: () => lookUpBins(true) }));
handle("settings:get", () => store.settings);
handle("settings:set", (s) => {
  const before = store.settings;
  store.setSettings(s);
  // a new claude or codex path applies without a restart
  if (binSettingsChanged(before, store.settings)) void lookUpBins(true);
  team.settingsChanged(before, store.settings);
  livePanes.settingsChanged(before, store.settings);
  phone?.alerts.settingsChanged();
  return store.settings;
});

// ---- Phone alerts ----
const needPhone = (): PhoneService => {
  if (!phone) throw new Error("Phone alerts haven't started yet — try again in a moment");
  return phone;
};
handle("phone:status", () => needPhone().alerts.status());
handle("phone:test", () => needPhone().alerts.test());
handle("phone:checkReplies", () => needPhone().alerts.checkReplies());
handle("phone:openPrivacy", (which) => shell.openExternal(which === "fullDiskAccess" ? PRIVACY_PANES.fullDiskAccess : PRIVACY_PANES.automation));
handle("sessions:clearPhoneNote", (id) => sessions.setPhoneNote(String(id), null));
handle("debrief:run", (kind) => runDebrief(kind, sessions, store));
// recent conversations of both agents come from the transcript index; without
// it (it couldn't open), Claude's are still read from its own folder
// the Helpdesk tasks workspace's conversations open only as it (HELPDESK_FOLDER_ONLY), so they aren't listed
handle("import:list", () => importable(transcripts?.recentConversations() ?? listClaudeConversations(), sessions.list(), collab.list()).filter((c) => !inHelpdeskFolder(c.cwd)));
handle("sessions:rename", (id, title) => sessions.rename(id, title));
handle("sessions:renameGroup", (oldKey, newKey) => {
  const [from, to] = [String(oldKey), String(newKey)];
  const members = sessions.list().filter((s) => areaKeyOf(s) === from).map((s) => s.id);
  // every group's: a ghost lying inside the area is in it, whatever its own group. Read before the rename, which changes
  // the records' groups in place
  const closed = sessions.resumable().map((s) => ({ id: s.id, taskGroup: s.taskGroup }));
  sessions.renameGroup(oldKey, newKey);
  team.groupRenamed(from, to); // a shared group stays its room
  // its area on the landscape follows; the rename itself is done, so a failure here is logged rather than refused
  try {
    landscape.groupRenamed(from, to, members, closed);
  } catch (err) {
    logError(`landscape: moving ${from}'s area to ${to}`, err);
  }
  // its artifacts on this Mac go with it; likewise logged rather than refused (they stay where they were)
  if (from === to || from.includes("/") || from === LOOSE_GROUP) return;
  if (to.includes("/") || to === LOOSE_GROUP) {
    if (areaArtifacts.has(from)) logError(`area artifacts: ${from} became ${to}, which isn't an area`, new Error(`${from}'s artifacts stay on this Mac under ${from}: name an area ${from} again to see them`));
    return;
  }
  try {
    areaArtifacts.areaRenamed(from, to);
  } catch (err) {
    logError(`area artifacts: moving ${from}'s to ${to}`, err);
  }
});

// ---- Team rooms ----
handle("team:status", () => team.status());
handle("team:share", (groupKey, title) => {
  const refused = helpdeskShareRefusal(String(groupKey ?? ""), [...sessions.list(), ...sessions.resumable()]);
  if (refused) throw new Error(refused);
  return team.shareGroup(String(groupKey ?? ""), String(title ?? ""));
});
handle("team:invite", (roomId) => ({ invite: team.createInvite(String(roomId)) }));
handle("team:join", (code) => team.join(String(code ?? "")));
handle("team:cancelJoin", (roomId) => team.cancelJoin(String(roomId)));
handle("team:leaveRoom", (roomId) => team.leaveRoom(String(roomId)));
handle("team:removeMember", (roomId, memberId) => team.removeMember(String(roomId), String(memberId)));
handle("team:answerJoin", (roomId, joinerId, accept) => team.answerJoin(String(roomId), String(joinerId), accept === true));
handle("team:setAdmin", (roomId, memberId, admin) => team.setAdmin(String(roomId), String(memberId), admin === true));
handle("team:handOver", (roomId, memberId) => team.handOver(String(roomId), String(memberId)));
handle("team:claimOwnership", (roomId) => team.claimOwnership(String(roomId)));
handle("team:contestClaim", (roomId) => team.contestClaim(String(roomId)));
handle("team:dismissNotice", (id) => team.dismissNotice(String(id)));
handle("team:checkSignaling", (url) => TeamService.checkSignaling(String(url ?? "")));
// team rooms: the Radley House board — every House call is made here, with this builder's token
handle("house:get", (roomId) => teamHouse.view(String(roomId)));
handle("house:watch", (roomId, open) => teamHouse.watch(String(roomId), open === true));
handle("house:refresh", (roomId) => teamHouse.refreshNow(String(roomId)));
handle("house:ticket", (roomId, n) => teamHouse.ticket(String(roomId), Number(n)));
handle("house:write", (roomId, w) => teamHouse.write(String(roomId), w));
handle("house:sessionPlan", (roomId, n) => ticketSessions.plan(String(roomId), Number(n)));
handle("house:startSession", (roomId, req) => ticketSessions.start(String(roomId), req ?? {}));
handle("house:consent", (roomId, allow) => teamHouse.consent(String(roomId), allow === true));
handle("house:pendingConsents", () => teamHouse.pendingConsents());
handle("house:open", async (roomId, n) => {
  const { url, problem } = await teamHouse.webUrl(String(roomId), Number(n));
  if (!externalUrlAllowed(url)) throw new Error(`The House's address isn't an https link (${url.slice(0, 80)})`);
  await shell.openExternal(url);
  return problem ? { note: problem } : {};
});
// team rooms: artifacts (src/shared/team/artifacts.ts); Quick Look, Reveal and Save as act on paths main makes
// each names a shelf: a room's id, or `area:<key>` for an area's on this Mac
handle("artifacts:list", (shelf) => shelves.list(String(shelf)));
handle("artifacts:pickFiles", () => artifactUi.pickFiles());
handle("artifacts:addFiles", (shelf, paths, confirmSecret) => shelves.addFiles(String(shelf), Array.isArray(paths) ? paths.map(String) : [], confirmSecret === true));
handle("artifacts:addBytes", (shelf, name, bytes, confirmSecret) => shelves.addBytes(String(shelf), String(name ?? ""), bytes, confirmSecret === true));
handle("artifacts:addNote", (shelf, name, text, confirmSecret) => shelves.newNote(String(shelf), String(name ?? ""), String(text ?? ""), confirmSecret === true));
handle("artifacts:addRepo", (shelf, req) => shelves.addRepo(String(shelf), req ?? {}));
handle("artifacts:addLink", (shelf, url, title) => shelves.addLink(String(shelf), String(url ?? ""), String(title ?? "")));
handle("artifacts:rename", (shelf, id, name) => shelves.rename(String(shelf), String(id), String(name ?? "")));
handle("artifacts:remove", (shelf, id) => shelves.remove(String(shelf), String(id)));
handle("artifacts:saveNote", (shelf, id, text, base, mode, confirmSecret) => shelves.saveNote(String(shelf), String(id), String(text ?? ""), String(base ?? ""), mode, confirmSecret === true));
handle("artifacts:read", (shelf, id) => shelves.read(String(shelf), String(id)));
handle("artifacts:download", (shelf, id) => shelves.download(String(shelf), String(id)));
handle("artifacts:resolveRepo", (shelf, id, preferSessionId) => shelves.resolveRepo(String(shelf), String(id), preferSessionId ? String(preferSessionId) : null));
handle("artifacts:quickLook", (shelf, id) => artifactUi.quickLook(String(shelf), String(id)));
handle("artifacts:reveal", (shelf, id) => artifactUi.reveal(String(shelf), String(id)));
handle("artifacts:saveAs", (shelf, id) => artifactUi.saveAs(String(shelf), String(id)));
handle("artifacts:dismissNotice", (shelf, noticeId) => shelves.dismissNotice(String(shelf), String(noticeId)));
// an area shared as a room: its artifacts on this Mac copied into the room, when asked
handle("artifacts:shareArea", (key, roomId) => areaArtifacts.shareTo(String(key ?? ""), teamArtifacts, String(roomId ?? "")));
// team rooms: team chat — each room's chat, its agent updates, the @assistant
// (on this laptop, under this user's account), and agent messaging across laptops
const teamRoom = new TeamRoom({
  sessions: () => sessions.list(),
  resumable: () => sessions.resumable(),
  roomGroups: () => team.status().rooms.map((r) => ({ roomId: r.id, groupKey: r.groupKey })),
  roomOf: (id) => livePanes.roomOfSession(id),
  guardsOf: (id) => sessions.guardsOf(id),
  // Claude only: it runs with no tools, while Codex's read-only sandbox can still read files,
  // and the room's chat (which teammates write) is in the prompt
  ask: async (prompt) => {
    const bin = await installedBin("claude");
    if (!bin) throw new Error("The room's assistant runs Claude Code (with no tools), and Claude Code isn't installed on this laptop");
    return askAgent(prompt, { agent: "claude", bin, run: userShellWithInput, env: paneEnv(), tag: "team-assistant", model: "sonnet", timeoutMs: 180_000 });
  },
  houseBoard: (roomId) => teamHouse.boardSummary(roomId),
  chatChanged: (roomId) => toWindow("teamChat:changed", roomId),
  notify: ({ roomId, title, body }) => {
    if (!shouldNotify({ settings: store.settings, kind: "other", now: new Date() })) return;
    const n = new Notification({ title, body });
    n.on("click", () => {
      focusPane();
      toWindow("teamChat:open", roomId);
    });
    n.show();
  },
  windowFocused: () => !!appWindow()?.isFocused(),
  log: (msg) => void logError("team chat", msg),
  // the room's artifacts, the ones the question names first (secret ones withheld)
  artifacts: (roomId, question) => assistantArtifacts(roomId, question.body.artifacts ?? []),
});
handle("teamChat:view", (roomId) => teamRoom.chat.view(String(roomId)));
handle("teamChat:post", (roomId, text) => teamRoom.chat.post(String(roomId), String(text ?? "")));
handle("teamChat:read", (roomId) => teamRoom.chat.markRead(String(roomId)));
handle("teamChat:unread", () => teamRoom.chat.unread());
handle("teamChat:viewing", (rooms) => teamRoom.chat.setViewing(Array.isArray(rooms) ? rooms.map(String) : rooms ? String(rooms) : null));
// team rooms: take-over
handle("team:takeover", (): TakeoverView => takeover?.view() ?? { sessions: [], rooms: [], unbacked: [], cleanup: [], asks: [], asking: [], left: [], received: [], refused: [] });
handle("team:setBackupsToOrigin", (roomId, on) => needTakeover().setBackupsToOrigin(String(roomId), on === true));
handle("team:setBackupConsent", (roomId, allow) => needTakeover().setBackupConsent(String(roomId), allow === true));
// team rooms: migration number reservations and the admin's settings for them
handle("teamChanges:view", (roomId) => teamChanges.view(String(roomId)));
handle("teamChanges:setCheck", (roomId, on) => teamChanges.setCheck(String(roomId), on === true));
handle("teamChanges:setFolders", (roomId, key, folders) => teamChanges.setFolders(String(roomId), String(key), Array.isArray(folders) ? folders.map(String) : []));
handle("team:takeoverPlan", (roomId, sessionId, clonePath) => needTakeover().plan(String(roomId), String(sessionId), clonePath ? String(clonePath) : null));
handle("team:takeOver", (roomId, sessionId, clonePath) => needTakeover().takeOver(String(roomId), String(sessionId), clonePath ? String(clonePath) : null));
handle("team:takeoverAnswer", (askId, answer) => {
  if (answer !== "handover" && answer !== "keep") throw new Error("Answer hand over or keep");
  needTakeover().answerAsk(String(askId), answer);
});
handle("team:takeoverCheckLeft", (roomId, sessionId) => needTakeover().checkLeft(String(roomId), String(sessionId)));
handle("team:takeoverSendLeft", (roomId, sessionId) => needTakeover().sendLeft(String(roomId), String(sessionId)));
handle("team:takeoverReceivedPatch", (roomId, id) => needTakeover().receivedPatch(String(roomId), String(id)));
handle("team:takeoverApplyReceived", (roomId, id) => needTakeover().applyReceived(String(roomId), String(id)));
handle("team:takeoverDismissReceived", (roomId, id) => needTakeover().dismissReceived(String(roomId), String(id)));
// team rooms: live panes
handle("team:live", () => livePanes.state());
handle("team:paneResync", (id) => livePanes.resync(String(id)));
handle("team:askToType", (id) => livePanes.askToType(String(id)));
handle("team:decideTyping", (sessionId, member, choice) => {
  if (!["session", "minutes", "deny", "revoke"].includes(choice)) throw new Error(`unknown answer ${String(choice)}`);
  livePanes.decideTyping(String(sessionId), String(member), choice);
});
handle("team:auditRecent", (n) => remoteAudit.recent(Math.min(500, Math.max(1, Number(n) || 50))));
handle("team:liveView", (view) => livePanes.setView(view));
handle("sessions:setGroup", (id, group) => sessions.setGroup(id, group));
handle("sessions:clearWaiting", (id) => sessions.clearWaiting(id));

// ---- Azure DevOps dashboard (reads WorkTracker config; PAT stays in main) ----
handle("ado:list", () => listWorkItems(store));
handle("ado:states", (type) => workItemStates(store, type));
handle("ado:update", (id, patch) => updateWorkItem(store, id, patch));
handle("ado:setTags", (id, change) => setWorkItemTags(store, Number(id), change));
handle("ado:projectTags", () => projectTags(store));
handle("ado:me", () => adoIdentity(store));
handle("ado:boards", (fresh) => teamBoards(store, !!fresh));
handle("ado:moveToColumn", (id, type, board, column) => moveToBoardColumn(store, Number(id), String(type), String(board), String(column)));
handle("ado:reorder", (id, previousId, nextId) => reorderWorkItem(store, Number(id), Number(previousId), Number(nextId)));
handle("update:check", () => checkForUpdate());
// Each CLI updates itself (`claude update` / `codex update`); running panes keep
// the old build until they restart, which the Settings UI offers right after.
handle("agents:update", async (agent) => {
  const kind = agent === "codex" ? "codex" : "claude";
  const bin = await installedBin(kind);
  if (!bin) throw new Error(`${agentLabel(kind)} isn't installed (not found on your shell's PATH)`);
  const r = await userShell(`${quote(bin)} update 2>&1`, 180_000);
  if (r.code !== 0) throw new Error(r.out || `${agentLabel(kind)}'s update exited with code ${r.code}`);
  void lookUpBins(true); // a self-updater may have moved the binary
  return r.out.split("\n").slice(-2).join(" · ");
});
// ---- connectors (Settings → Connectors card) ----
const wtFile = (name: string) => path.join(expandHome(store.settings.workTrackerPath), name);

handle("connectors:status", async () => {
  const az = (await which("az")) !== null;
  const globalMcp = Object.keys(readJsonFile(path.join(os.homedir(), ".claude.json"), {}).mcpServers ?? {});
  const projectMcp = Object.keys(readJsonFile(wtFile(".mcp.json"), {}).mcpServers ?? {});
  return { az, global: globalMcp, project: projectMcp };
});

handle("ado:config:get", () => {
  const a = readJsonFile(wtFile("config.json"), {}).azureDevOps ?? {};
  return { orgUrl: a.orgUrl ?? "", project: a.project ?? "", patFile: a.patFile ?? "" };
});

// merge-write: only the azureDevOps keys change, the rest of config.json is preserved
handle("ado:config:set", (patch) => {
  const wt = expandHome(store.settings.workTrackerPath);
  fs.mkdirSync(wt, { recursive: true });
  const file = path.join(wt, "config.json");
  const cfg = readJsonFile(file, {});
  cfg.azureDevOps = {
    ...(cfg.azureDevOps ?? {}),
    orgUrl: String(patch?.orgUrl ?? "").trim(),
    project: String(patch?.project ?? "").trim(),
    patFile: String(patch?.patFile ?? "").trim(),
  };
  writeFileAtomic(file, JSON.stringify(cfg, null, 2));
  resetAdoCache();
  return { ok: true };
});

// MCP servers for debrief sessions — written to WorkTracker/.mcp.json (project
// scope: Claude Code loads it for sessions running in that folder and asks the
// user to approve it on first use)
handle("mcp:add", (name, command) => {
  const n = String(name ?? "").trim();
  const parts = String(command ?? "").trim().split(/\s+/);
  if (!n || !parts[0]) throw new Error("Name and command are required");
  const file = wtFile(".mcp.json");
  const j = readJsonFile(file, {});
  j.mcpServers = { ...(j.mcpServers ?? {}), [n]: { command: parts[0], args: parts.slice(1) } };
  writeFileAtomic(file, JSON.stringify(j, null, 2));
  return { ok: true };
});

handle("mcp:remove", (name) => {
  const file = wtFile(".mcp.json");
  const j = readJsonFile(file, {});
  if (j.mcpServers) delete j.mcpServers[String(name)];
  writeFileAtomic(file, JSON.stringify(j, null, 2));
  return { ok: true };
});
handle("ado:comments", (id) => listComments(store, id));
handle("ado:comment:add", (id, text) => addComment(store, id, text));

// ---- the landscape: patches from a window, merged and sent on to every window ----
handle("landscape:get", () => landscape.get());
handle("landscape:update", (patch) => landscape.update(patch));

// ---- wires: typed links between workspaces, kept beside the layout (docs/landscape-wires.md) ----
/** Whether team rooms have started (livePanes.start, in whenReady): until then no session looks to be in a room. */
let roomsKnown = false;
const wires = new WireService({
  store: landscape,
  sessions,
  roomOf: (id) => livePanes.roomOfSession(id),
  roomsKnown: () => roomsKnown,
  takenOver: (id) => takeover?.takenOverRefusal(id, "wiring it") ?? null,
  outsideSandbox: (id) => livePanes.outsideSandbox(id),
  log: logError,
  onAdded: (id, w) => wireTools.wired(id, w),
  delivery: { withdraw: (id, w) => delivery.withdraw(id, w), restoring: (w) => delivery.restoring(w), restored: (id) => delivery.restored(id) },
  merges: { view: (w, source) => prWatch.view(w, source) },
});
/** What the window last had of the wires' merge views and worktree folders, so a change in either alone is sent once. */
let wiresDrawn = "";
const drawnKey = (s: WireState) => JSON.stringify([s.merges ?? {}, s.folders ?? {}]);
wiresForWindows = (s) => {
  const out = wires.forWindows(s);
  wiresDrawn = drawnKey(out);
  return out;
};
/** The merge watch read its pull requests, or pipeline.json changed: the window hears the wires again if what it draws moved. */
const wiresDrawnMoved = () => {
  const s = wires.get();
  if (drawnKey(s) === wiresDrawn) return;
  wiresDrawn = drawnKey(s);
  toWindow("wires:changed", s);
};
handle("wires:get", () => wiresForWindows(landscape.wires()));
handle("wires:add", (from, to, type, settings) => wires.add(from, to, type, settings));
handle("wires:set", (id, settings) => wires.set(id, settings));
handle("wires:remove", (id) => wires.remove(id));
handle("wires:restore", (id) => wires.restore(id));
handle("wires:rekey", (old, next) => wires.rekey(old, next));
// the agents' finish_step, read_context and read_terminal (routed by messaging), a person's Finish step, and what an
// agent is told of its wires as it launches
const wireTools: WireTools = new WireTools({
  store: landscape,
  rules: wires,
  sessions,
  conversationFiles: (s, conv) => {
    const { agent, lookup } = conversationLookup(s, conv);
    return { agent, ...conversationFiles(agent, conv, lookup) };
  },
  secretFiles: () => knownSecretFiles(store.settings.workTrackerPath).files,
  submitOnDelivery: submitsAgentMessages,
  onMessage: recordMessage,
  // what a finish readied, once delivery has written it and sent what its gate sends. One notice per session per 30 s,
  // as every pane's (notifySession), with a click that shows the pane
  onPendings: ({ from, fromTitle, pendings }) => {
    const s = sessions.list().find((x) => x.id === from);
    if (!shouldNotify({ settings: store.settings, session: s, kind: "finished", now: new Date() })) return;
    if (Date.now() - (lastNotified.get(from) ?? 0) < 30_000) return;
    lastNotified.set(from, Date.now());
    const n = new Notification({ title: `${fromTitle} → ${pendings.map((p) => p.toTitle).join(", ")}`, body: `${fromTitle} finished its step: ${pendings.length === 1 ? "its wire is" : `${pendings.length} wires are`} ready at the gate.` });
    n.on("click", () => focusPane(from));
    n.show();
  },
  // delivery is the one writer of pendings, deliveries, rounds and hops
  offer: (me, f, how, prompt) => delivery.offer(me, f, how, prompt),
  promptOf: (id) => delivery.promptOf(id),
  log: logError,
});
sessions.launchInstructions = (id) => wireTools.launchInstructions(id);
handle(
  "wires:finish",
  untakenHandler("wires:finish", untaken, (s, summary: unknown, verdict: unknown) => wireTools.finish(s, { summary, ...(verdict === undefined || verdict === null ? {} : { verdict }) }, "you"))
);
handle("wires:lastMessage", (id) => wireTools.latestMessage(sessionOf(String(id))));
// what waits at a gate reaching the other end: a person's Send, an automatic gate, and settling what a run left on its way
const delivery: WireDelivery = new WireDelivery({
  store: landscape,
  context: (book) => wires.context(book),
  sessions,
  reopen: reopenSession,
  submits: submitsAgentMessages,
  // Mockingbird's label and fence around what's sent; a refusal fails the send, saying why
  frame: ({ wireId, body, automatic }) => {
    const m = wireTools.messageFor(wireId, body, { automatic });
    if ("refused" in m) throw new Error(m.refused);
    return m.text;
  },
  takenOver: () => (takeover ? (sid, doing) => takeover!.takenOverRefusal(sid, doing) : null),
  log: logError,
  notify: (id, title, body) => notifySession(id, title, body),
});
handle("wires:send", (id, pending, body, opts) => delivery.send(id, pending, body, opts));
handle("wires:sendAgain", (id, pending, body, opts) => delivery.sendAgain(id, pending, body, opts));
handle("wires:markSent", (id, pending) => delivery.markSent(id, pending));
handle("wires:moreRounds", (id) => delivery.moreRounds(id));
handle("wires:resetRounds", (id) => delivery.resetRounds(id));

// ---- ticket pipeline: each ticket's stage, PRs, feedback and drafted comments ----
const pipeline = new PipelineStore(path.join(MB_DIR, "pipeline.json"));
const pipelineChanged = () => {
  toWindow("pipeline:changed", pipeline.all());
  wiresDrawnMoved();
};
// the windows hear of the record as it is after the call, whether it worked or not: a failure may come after a change
const pipelineDo = async <T,>(fn: () => T | Promise<T>): Promise<T> => {
  try {
    return await fn();
  } finally {
    pipelineChanged();
  }
};
// the agents' set_stage, request_pr and write_patch_notes (routed by messaging), and the window's answers to them
const ticketTools = new TicketTools({
  pipeline,
  sessions,
  submitOnDelivery: submitsAgentMessages,
  takenOver: (id, doing) => takeover?.takenOverRefusal(id, doing) ?? null,
  roomOf: (id) => livePanes.roomOfSession(id),
  roomsKnown: () => roomsKnown,
  // an agent undid stage 6's approval: one notice, under the notification settings, whose click shows the pane
  onApprovalUndone: ({ ticket, title, session, by, from, note, kept }) => {
    if (!shouldNotify({ settings: store.settings, session, kind: "other", now: new Date() })) return false;
    const body = [`${by} sent it back from ${stageLabel(from)}: ${plainLine(note, 200)}`, keptTicksLine(kept)].filter(Boolean).join("\n");
    const n = new Notification({ title: `#${ticket}${title ? ` ${plainLine(title, 80)}` : ""} is back at Coding`, body });
    n.on("click", () => focusPane(session.id));
    n.show();
    return true;
  },
  onChanged: pipelineChanged,
  log: logError,
});
// a held PR request a move or another session's PR dropped: its asker hears why, as a dismissal tells it
pipeline.onRequestsDropped = (id, dropped) => void ticketTools.requestsDropped(id, dropped);
const prDeps = (root: string): PrDeps => ({ ado: (url: string, init?: RequestInit) => adoRequest(store, url, init), run: userShellWithInput, env: paneEnv(), cwd: root });
// a pull request merging: saved, the ticket moved on from its PR stage, and its pr-merged wires readied once each
const prWatch: PrWatch = new PrWatch({
  pipeline,
  read: (pr, root) => prStateById(pr, prDeps(root)),
  sessions,
  wires: () => landscape.wires(),
  fill: (me, merge, ids) => wireTools.planMerge(me, merge, ids),
  offer: (me, f, how) => delivery.offer(me, f, how, null),
  onChecked: () => wiresDrawnMoved(),
  notify: (sessionId, title, body) => {
    const session = sessionId ? sessions.list().find((s) => s.id === sessionId) : undefined;
    if (!shouldNotify({ settings: store.settings, session, kind: "other", now: new Date() })) return;
    const n = new Notification({ title, body });
    if (session) n.on("click", () => focusPane(session.id));
    n.show();
  },
  onChanged: pipelineChanged,
  log: logError,
});

handle("pipeline:all", () => pipeline.all());
handle("pipeline:stage", (id, stage, title) => pipelineDo(() => pipeline.setStage(String(id), stage, { title: title ? String(title) : undefined, by: BY_YOU })));
handle("pipeline:feedback", (id, text) => pipelineDo(() => pipeline.addFeedback(String(id), String(text ?? ""), BY_YOU)));
handle("pipeline:check", (id, key, value) => pipelineDo(() => pipeline.setCheck(String(id), String(key), !!value, BY_YOU)));
handle("pipeline:draft:add", (id, stage, text) => pipelineDo(() => pipeline.addDraft(String(id), stage, String(text ?? ""))));
handle("pipeline:draft:edit", (id, draftId, text) => pipelineDo(() => pipeline.editDraft(String(id), String(draftId), String(text ?? ""))));
handle("pipeline:draft:drop", (id, draftId) => pipelineDo(() => pipeline.dropDraft(String(id), String(draftId))));
// stage 6's approval, and its line to the agent that asked for the PR to dev; an agent's PR request dismissed, with a note
handle("pipeline:approve", (id) => pipelineDo(() => ticketTools.approve(String(id))));
handle("pipeline:request:dismiss", (id, requestId, note) => pipelineDo(() => ticketTools.dismissRequest(String(id), String(requestId), typeof note === "string" ? note : "")));
// the merge watch's Check now, and Mark merged…: the user's alone, as no tool reaches either
handle("pipeline:pr:check", (id, url) => pipelineDo(() => prWatch.checkNow(String(id), typeof url === "string" ? url : undefined)));
handle("pipeline:pr:markMerged", (id, url) => pipelineDo(() => prWatch.markMerged(String(id), String(url ?? ""))));
// posting is the one step that writes to ADO, and only for the draft the user picked
handle("pipeline:draft:post", (id, draftId) =>
  pipelineDo(async () => {
    const tid = String(id);
    if (!isWorkItemId(tid)) throw new Error(`#${tid} isn't an Azure DevOps work item, so it has no discussion to post to`);
    const d = pipeline.findDraft(tid, String(draftId));
    if (!d.text.trim()) throw new Error("The comment is empty");
    await addComment(store, Number(tid), d.text);
    return pipeline.dropDraft(tid, d.id);
  })
);
handle("pipeline:pr:preflight", (sessionId, ticketId, target) => {
  const root = sessionOf(String(sessionId)).cwd;
  return prPreflight(root, String(ticketId), target === "main" ? "main" : "dev", prDeps(root));
});
handle("pipeline:pr:describe", async (sessionId, ticketId, title, base) => {
  const s = sessionOf(String(sessionId));
  const { agent, bin } = await askingAgent(s.agent ?? "claude");
  const prompt = await prDescriptionPrompt(s.cwd, String(base), { id: String(ticketId), title: String(title ?? "") });
  const description = await askFor(prompt, { agent, bin }, { tag: "pr-description", label: /^(description)\s*:\s*/i, timeoutMs: 180_000, what: "description" });
  return { description, agent };
});
// pushes the branch and opens the pull request — run only from the PR form's button
handle("pipeline:pr:create", (sessionId, ticketId, req) =>
  pipelineDo(async () => {
    const s = sessionOf(String(sessionId));
    const target = req?.target === "main" ? "main" : "dev";
    const base = String(req?.base ?? "");
    const title = String(req?.title ?? "").trim();
    if (!base) throw new Error("Pick the branch to merge into");
    if (!title) throw new Error("The pull request needs a title");
    const pre = await prPreflight(s.cwd, String(ticketId), target, prDeps(s.cwd));
    if (!pre.branch) throw new Error("The worktree isn't on a branch");
    // checked here, not trusted from the form: the PR is recorded under `target`
    const wrongBase = prBaseProblem(target, base, pre.bases);
    if (wrongBase) throw new Error(`Can't open this pull request: ${wrongBase}`);
    if (pre.dirtyFiles) throw new Error(`Commit or stash the ${pre.dirtyFiles} uncommitted file${pre.dirtyFiles === 1 ? "" : "s"} first — they wouldn't be in the pull request`);
    if (pre.existing && pre.base === base) throw new Error(`A pull request is already open from ${pre.branch}: ${pre.existing.url}`);
    const url = await originUrl(s.cwd);
    const remote = url ? parseRemote(url) : null;
    if (!remote) throw new Error(url ? `origin (${url}) isn't on Azure DevOps or GitHub` : "The repository has no origin remote to open a pull request on");
    await scmPush(s.cwd);
    let made: { id: number; url: string };
    try {
      made = await openPr(remote, { branch: pre.branch, base, title, description: String(req?.description ?? ""), workItemId: String(ticketId) }, prDeps(s.cwd));
    } catch (err) {
      throw new Error(`The branch was pushed, but the pull request wasn't opened: ${prError(err)}`);
    }
    const description = String(req?.description ?? "");
    return pipeline.addPr(
      String(ticketId),
      { target, provider: remote.provider, id: made.id, url: made.url, repo: remoteName(remote), branch: pre.branch, base, at: Date.now(), summary: description ? summaryOf(description) : undefined, by: s.id, root: s.cwd },
      req?.ticketTitle ? String(req.ticketTitle) : undefined,
      BY_YOU
    );
  })
);
// ---- continue in the other agent: a handoff written from the session's conversation ----
/** A session of `agent` in `s`'s folder and group, on its branch as it stands (no worktree of its own), started with `initialPrompt`. */
function companionSession(s: SessionInfo, agent: AgentKind, title: string, initialPrompt: string): Promise<SessionInfo> {
  return sessions.create({
    repoPath: s.repoPath,
    cwd: s.cwd,
    branchName: s.branch ?? undefined,
    useWorktree: false,
    agent,
    title,
    taskGroup: s.taskGroup ?? undefined,
    initialPrompt,
  });
}
// the agent taking over writes the handoff: the one handing over may be out of usage
handle("handoff:draft", async (id) => {
  const s = sessionOf(String(id));
  if (s.shell) throw new Error("A terminal has no agent conversation to hand over");
  if (s.role === "tasks") throw new Error(HELPDESK_KEEPS_ITS_CONVERSATION);
  const from: AgentKind = s.agent ?? "claude";
  const to = otherAgent(from);
  const bin = await installedBin(to);
  if (!bin) throw new Error(`${agentLabel(to)} isn't installed — set it up in Settings → Agents`);
  const conv = conversationsOf(s).at(-1);
  let digest = "";
  if (conv && transcripts) {
    await syncForFiles(transcripts);
    const files = transcripts.filesOf(conv);
    const lines = (await Promise.all(files.map((f) => transcriptLines(f.path)))).flat();
    digest = transcriptDigest(lines, files[0]?.agent ?? from, conv);
  }
  if (!digest) {
    const why = !conv ? "Mockingbird hasn't seen this session's conversation yet" : transcriptsProblem ? `the conversation index isn't available (${transcriptsProblem})` : "its conversation isn't in the index yet";
    throw new Error(`Couldn't read the conversation: ${why}. Write the handoff yourself below.`);
  }
  const prompt = handoffPrompt({ from, to, cwd: s.cwd, title: s.ticketTitle ?? s.title, digest, repo: await repoState(s.cwd) });
  const handoff = await askFor(prompt, { agent: to, bin }, { tag: "handoff", label: /^(handoff)\s*:\s*/i, timeoutMs: 240_000, what: "handoff" });
  return { handoff, from, to };
});
// a session of the other agent in the same folder and group, started with the handoff
handle(
  "handoff:start",
  untakenHandler("handoff:start", untaken, (s, handoff: unknown) => {
    const text = String(handoff ?? "").trim();
    if (!text) throw new Error("The handoff is empty");
    const from: AgentKind = s.agent ?? "claude";
    const to = otherAgent(from);
    return companionSession(s, to, `${s.ticketTitle ?? s.title} · ${to}`, handoffKickoff(from, text));
  })
);

// ---- editor intelligence: language servers per session folder ----
const lsp = new LspManager({
  dir: LSP_DIR,
  env: () => paneEnv(),
  which,
  node: process.execPath,
  onDiagnostics: (file, d) => toWindow("lsp:diagnostics", file, d),
  onStatus: (st) => toWindow("lsp:status", st),
});
/** A file of a session's folder, as the root and an absolute path inside it. */
const lspFile = async (sessionId: string, rel: string) => {
  const root = sessionRoot(String(sessionId));
  return { root, abs: await resolveIn(root, String(rel)) };
};
const pos = (line: unknown, character: unknown) => ({ line: Number(line) || 0, character: Number(character) || 0 });
handle("lsp:open", async (id, rel, text) => {
  const f = await lspFile(id, rel);
  return lsp.open(f.root, f.abs, String(text ?? ""));
});
handle("lsp:install", (server) => lsp.install(server, (message) => toWindow("lsp:status", { server, root: "", state: "installing", message })));
handle("lsp:change", async (id, rel, text) => {
  const f = await lspFile(id, rel);
  lsp.change(f.root, f.abs, String(text ?? ""));
});
handle("lsp:saved", async (id, rel) => {
  const f = await lspFile(id, rel);
  lsp.saved(f.root, f.abs);
});
handle("lsp:close", async (id, rel) => {
  const f = await lspFile(id, rel);
  lsp.close(f.root, f.abs);
});
handle("lsp:hover", async (id, rel, line, ch) => {
  const f = await lspFile(id, rel);
  return lsp.hover(f.root, f.abs, pos(line, ch));
});
handle("lsp:complete", async (id, rel, line, ch, prefix, trigger) => {
  const f = await lspFile(id, rel);
  return lsp.completion(f.root, f.abs, pos(line, ch), String(prefix ?? ""), trigger ? String(trigger) : undefined);
});
handle("lsp:definition", async (id, rel, line, ch) => {
  const f = await lspFile(id, rel);
  return lsp.definition(f.root, f.abs, pos(line, ch));
});
handle("lsp:rename", async (id, rel, line, ch, name) => {
  const newName = String(name ?? "").trim();
  if (!newName) throw new Error("Type the new name");
  const f = await lspFile(id, rel);
  return lsp.rename(f.root, f.abs, pos(line, ch), newName);
});
handle("lsp:format", async (id, rel, tabSize, insertSpaces) => {
  const f = await lspFile(id, rel);
  return lsp.format(f.root, f.abs, { tabSize: Number(tabSize) || 4, insertSpaces: !!insertSpaces });
});
// a rename's edits to a file that isn't open in the editor: written straight to it
handle("lsp:applyEdits", (id, rel, edits) => applyFileEdits(sessionRoot(String(id)), String(rel), Array.isArray(edits) ? edits : []));

// ---- PR status in the pane rail: the branch's pull request, looked up at most every 2 minutes per folder ----
const prCache = new Map<string, PrStatus>();
const prInFlight = new Map<string, Promise<PrStatus>>();
handle("pr:status", async (cwd, fresh) => {
  const root = String(cwd);
  if (!sessions.list().some((s) => s.cwd === root)) throw new Error("No session runs in that folder");
  const hit = prCache.get(root);
  if (hit && !fresh && Date.now() - hit.at < PR_TTL_MS) {
    // a branch switch makes the cached answer someone else's
    if ((await currentBranch(root)) === hit.branch) return hit;
  }
  let p = prInFlight.get(root);
  if (!p) {
    p = prStatusFor(root, prDeps(root)).finally(() => prInFlight.delete(root));
    prInFlight.set(root, p);
  }
  const st = await p;
  prCache.set(root, st);
  return st;
});

// ---- session presets: one-click recurring setups ----
handle("presets:start", async (id) => {
  const p = id === HELPDESK_PRESET.id ? HELPDESK_PRESET : (store.settings.presets ?? []).find((x) => x.id === id);
  if (!p) throw new Error("That preset no longer exists");
  const repo = p.repoPath ? expandHome(p.repoPath) : null;
  const branches = repo && p.branch.mode === "new" ? (await listBranches(repo)).branches : [];
  return sessions.create(presetRequest({ ...p, repoPath: repo }, branches, new Date()));
});

// ---- agent messaging: the log, per-group delivery, and asking a group for status ----
const messageLog = new MessageLog(path.join(MB_DIR, "messages.json"));
/** An agent message, or a read along a wire, into the log and to the window; a log that can't be written is logged. */
function recordMessage(m: AgentMessage): void {
  try {
    messageLog.add(m);
  } catch (err) {
    logError("message log", err);
  }
  toWindow("messages:changed", m);
}
handle("messages:list", () => messageLog.list());
handle("messages:groupMode", (group, mode) => {
  const g = topOfKey(String(group));
  const next = { ...(store.settings.agentMessagesByGroup ?? {}) };
  if (mode === "send" || mode === "prompt") next[g] = mode;
  else delete next[g];
  store.setSettings({ agentMessagesByGroup: next });
  return next;
});
const STATUS_CHECK =
  "Status check from the user: reply in three short lines — what you've done, what you're doing now, and anything blocking you or needing a decision. Don't start new work for this.";
handle("group:statusCheck", (group) => {
  const g = topOfKey(String(group));
  const ids = sessions
    .list()
    .filter((s) => topOfKey(s.taskGroup ?? "ungrouped") === g && !s.shell && !s.debrief && s.status !== "dead")
    .map((s) => s.id);
  if (!ids.length) throw new Error("No agent sessions in this group");
  // each gets it when its current turn ends, so nobody is interrupted mid-answer
  sessions.broadcast(STATUS_CHECK, ids, true);
  return { asked: ids.length };
});

// ---- weekly rollup: the week's time, tickets and outcomes, written into WorkTracker ----
handle("rollup:write", async (weeksAgo) => {
  if (!transcripts) throw new Error(`The conversation index isn't available${transcriptsProblem ? `: ${transcriptsProblem}` : ""}`);
  await syncTranscripts(transcripts);
  const { start, end } = weekBounds(new Date(), Math.max(0, Number(weeksAgo) || 0));
  const dir = path.join(expandHome(store.settings.workTrackerPath), "session-digests");
  // the daily digests of that week, by name only — the files aren't read
  const digests = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((n) => {
        if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(n)) return false;
        const t = new Date(`${n.slice(0, 10)}T12:00:00`).getTime();
        return t >= start.getTime() && t < end.getTime();
      })
    : [];
  const markdown = composeRollup({
    start,
    end,
    activity: transcripts.activity(start.getTime(), end.getTime()),
    usage: transcripts.usage({ since: start.getTime(), until: end.getTime() }),
    sessions: store.state.sessions,
    pipelines: pipeline.all(),
    digests,
    generated: new Date(),
  });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollup-week-of-${localDay(start)}.md`);
  fs.writeFileSync(file, markdown);
  return { file, markdown };
});
handle("shell:reveal", (file) => {
  // only what Mockingbird wrote into the WorkTracker folder
  const f = path.resolve(String(file));
  if (!inside(expandHome(store.settings.workTrackerPath), f)) throw new Error("Only files in the WorkTracker folder can be shown");
  shell.showItemInFolder(f);
});

/** Whether an agent message to this session is submitted, or typed in and left for its user. A group can override the app-wide choice. */
function submitsAgentMessages(target: SessionInfo): boolean {
  const mode = store.settings.agentMessagesByGroup?.[topOfKey(target.taskGroup ?? "ungrouped")];
  return mode ? mode === "send" : store.settings.agentMessagesSubmit !== false;
}

// ---- session health: CLIs updated under running panes, and panes that went quiet mid-turn ----
const STALL_MS = 5 * 60_000;
/** An agent message queued this long for its target's turn to end is reported to its sender. */
const MESSAGE_OVERDUE_MS = 15 * 60_000;

/** Tell a message's sender (its agent, and its user) that the message is still waiting, and why. */
function tellOverdue(o: OverdueMessage): void {
  const mins = Math.round(o.waitedMs / 60_000);
  const state = o.toStatus === "waiting" ? "waiting on its user" : o.toStatus;
  const why = o.hooksSilent ? `, but Mockingbird has heard nothing from its agent's hooks since it started, so that status may be wrong` : "";
  logLine(`messaging: a message from ${o.from} to ${o.to} ("${o.toTitle}") is still queued after ${mins} min; that session is ${state}${why}`);
  const sender = sessions.list().find((s) => s.id === o.from && s.status !== "dead");
  if (!sender) return;
  notifySession(o.from, "Message not delivered yet", `To ${o.toTitle}: waiting ${mins} min — that session is ${state}${o.hooksSilent ? " (its status may be wrong)" : ""}`);
  try {
    // Mockingbird's own notice, under its own key: it isn't a prompt the agent was given (an automatic wire sends once per
    // prompt), and a newer one replaces it while it waits
    sessions.deliverNotice(
      o.from,
      "overdue",
      `[Mockingbird: your message to session "${o.toTitle}" (id ${o.to}) hasn't been delivered after ${mins} minutes. ` +
        `It is delivered when that session's turn ends, and it is still ${state}${why}. If it's urgent, ask your user to look at that session.]`,
      submitsAgentMessages(sender)
    );
  } catch (err) {
    logError(`messaging: telling ${o.from} its message to ${o.to} is overdue`, err);
  }
}
let lastNotices = "";
/** An agent CLI's installed version; null when it isn't installed or doesn't say (logged). */
async function readAgentVersion(agent: AgentKind): Promise<string | null> {
  const bin = await installedBin(agent);
  if (!bin) return null;
  const r = await userShell(`${quote(bin)} --version`, 20_000);
  const v = r.code === 0 ? cliVersion(r.out) : null;
  if (!v) logError(`version ${agent}`, new Error(r.out.trim().slice(0, 200) || `exited with code ${r.code}`));
  return v;
}
sessions.readVersion = readAgentVersion;
async function refreshAgentVersions(): Promise<void> {
  const found: Partial<Record<AgentKind, string>> = {};
  for (const agent of ["claude", "codex"] as AgentKind[]) {
    const v = await readAgentVersion(agent);
    if (v) found[agent] = v;
  }
  sessions.setAgentVersions(found);
  healthChanged();
  // read ahead of a room's first Codex launch, which switches the user's MCP servers off by name; read again only once the config changes
  const codexBin = found.codex && team.status().rooms.length ? await installedBin("codex") : null;
  if (codexBin) codexMcpNames.names(codexBin).catch((err) => logError("reading Codex's MCP server names", err));
}
function healthChanged(): void {
  const notices = sessions.updateNotices();
  const key = JSON.stringify(notices);
  if (key === lastNotices) return;
  lastNotices = key;
  toWindow("health:updates", notices);
}
handle("health:updates", () => sessions.updateNotices());
handle("sessions:restart", (id) => sessions.restart(String(id)));
app.whenReady().then(() => {
  if (!isPrimary) return;
  const versions = () => refreshAgentVersions().catch((err) => logError("agent versions", err));
  void versions();
  // the CLIs update themselves in the background
  setInterval(versions, 10 * 60_000);
  // what the last run left on its way along wires is settled as the app starts, sending nothing; then every 30 s, for
  // what a write that failed this run left
  const settleWires = () => {
    try {
      delivery.reconcile();
    } catch (err) {
      logError("wires: settling what was on its way", err);
    }
  };
  settleWires();
  prWatch.start();
  setInterval(() => {
    sessions.checkStalls(Date.now(), STALL_MS);
    for (const o of sessions.overdueMessages(Date.now(), MESSAGE_OVERDUE_MS)) tellOverdue(o);
    healthChanged();
    settleWires();
  }, 30_000);
});

// ---- conflict early warning: worktrees of one repository changing the same files ----
let overlapState: OverlapReport = { bySession: {}, unread: {} };
const worktreeReads: WorktreeReads = { changes: new Map(), unread: new Map() };
const staleRoots = new Set<string>();
let overlapTimer: NodeJS.Timeout | null = null;
let overlapRun: Promise<void> | null = null;
/** Re-read the changed folders' files (debounced), then compare every live worktree's. */
function overlapsSoon(root?: string): void {
  if (root) staleRoots.add(root);
  if (overlapTimer) clearTimeout(overlapTimer);
  overlapTimer = setTimeout(() => {
    overlapTimer = null;
    if (overlapRun) return overlapsSoon(); // one pass at a time; this one follows
    overlapRun = refreshOverlaps().finally(() => (overlapRun = null));
  }, 2000);
}
async function refreshOverlaps(): Promise<void> {
  const live = sessions.list().flatMap((s) => (s.repoPath && s.status !== "dead" && !s.debrief ? [{ sessionId: s.id, title: s.ticketTitle ?? s.title, repoPath: s.repoPath, cwd: s.cwd }] : []));
  await rereadWorktrees([...new Set(live.map((s) => s.cwd))], worktreeReads, staleRoots, logError);
  const next = overlapReport(live, worktreeReads, teamChanges.teammateChanges()); // team rooms: teammates' branches and shared uncommitted work too
  if (JSON.stringify(next) === JSON.stringify(overlapState)) return;
  overlapState = next;
  toWindow("overlaps:changed", overlapState);
}
handle("overlaps:get", () => overlapState);
// branches move and sessions come and go without a file changing: look again every 2 minutes
setInterval(() => {
  for (const cwd of worktreeReads.changes.keys()) staleRoots.add(cwd);
  overlapsSoon();
}, 120_000);
app.whenReady().then(() => {
  if (isPrimary) overlapsSoon();
});

// ---- undo an agent's turn: snapshots taken when each prompt is submitted ----
const snapshotErrors = new Map<string, string>();
handle("turns:list", async (id) => {
  const s = sessionOf(String(id));
  return { snapshots: await listSnapshots(s.cwd, s.id), lastError: snapshotErrors.get(s.id) ?? null };
});
handle("turns:changes", (id, n) => {
  const s = sessionOf(String(id));
  return changesSince(s.cwd, s.id, Number(n));
});
handle(
  "turns:restore",
  untakenHandler("turns:restore", untaken, (s, n: unknown) => restoreSnapshot(s.cwd, s.id, Number(n)))
);

// ---- cross-agent review: the other agent reviews this session's branch and reports back ----
handle(
  "review:start",
  untakenHandler("review:start", untaken, async (s) => {
    if (s.shell) throw new Error("A terminal has no agent's work to review");
    if (!s.repoPath) throw new Error("This session isn't in a repository");
    const author: AgentKind = s.agent ?? "claude";
    const reviewer = otherAgent(author);
    if (!(await installedBin(reviewer))) throw new Error(`${agentLabel(reviewer)} isn't installed — set it up in Settings → Agents`);
    const base = await baseRef(s.cwd);
    const prompt = reviewPrompt({ author, authorId: s.id, authorTitle: s.ticketTitle ?? s.title, branch: s.branch, base });
    return companionSession(s, reviewer, `Review · ${s.ticketTitle ?? s.title}`, prompt);
  })
);

// a short announcement for the people who use the system, from the ticket and its PRs
handle("pipeline:comms", async (ticketId, title, details) => {
  const p = pipeline.get(String(ticketId));
  const { agent, bin } = await askingAgent();
  const prompt = [
    `Write a short announcement for the people who use this system about a change that just shipped: ticket #${ticketId} "${String(title ?? "")}".`,
    PATCH_NOTES_GUIDANCE,
    "Reply with the announcement only.",
    "",
    details ? `The ticket:\n${String(details).slice(0, 6000)}` : "",
    ...(p?.prs ?? []).filter((x) => x.summary).map((x) => `What the pull request to ${x.base} did:\n${x.summary}`),
  ].join("\n");
  const text = await askFor(prompt, { agent, bin }, { tag: "comms", label: /^(announcement)\s*:\s*/i, timeoutMs: 180_000, what: "announcement" });
  return { text, agent };
});
// native folder/file picker for the Settings tab — no more typing paths
// ---- transcript index: search every Claude/Codex conversation on this Mac ----
const transcriptRoots = { claude: CLAUDE_PROJECTS, codex: CODEX_SESSIONS };
let transcripts: TranscriptIndex | null = null;
let transcriptsProblem: string | null = null;

/** Open the index and keep it current: now, when transcripts change (debounced), and every 5 minutes. */
function startTranscriptIndex(): void {
  try {
    transcripts = new TranscriptIndex(path.join(MB_DIR, "transcripts.db"), transcriptRoots);
  } catch (err) {
    transcriptsProblem = logError("transcripts:open", err);
    return;
  }
  // a failed sync is logged and kept as the index's problem by syncTranscripts; the meters then say so, not go on as they were
  const sync = retryingSync(() => syncTranscripts(transcripts!), metersChanged);
  void sync();
  let timer: NodeJS.Timeout | null = null;
  for (const root of Object.values(transcriptRoots)) {
    try {
      fs.watch(root, { recursive: true }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(sync, 3000); // a reply writes many lines; index once it settles
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") logError(`transcripts:watch ${root}`, err);
    }
  }
  setInterval(sync, 5 * 60_000);
}

/** Bring the index up to date. A failure is the index's problem until a sync succeeds. */
async function syncTranscripts(index: TranscriptIndex): Promise<void> {
  try {
    await index.sync();
    transcriptsProblem = null;
  } catch (err) {
    transcriptsProblem = logError("transcripts:sync", err);
    throw err;
  }
}

/**
 * A sync before reading a conversation's own files, which only needs them known: one that fails is logged and kept as
 * the index's problem by syncTranscripts, and the read goes on with the files known so far. What's worked out from the
 * index's contents (the weekly rollup) calls syncTranscripts, and fails with it.
 */
async function syncForFiles(index: TranscriptIndex): Promise<void> {
  try {
    await syncTranscripts(index);
  } catch {
    return;
  }
}

// token meters: recomputed after the index catches up, when plan usage moves, and as panes change conversation
let metersTimer: NodeJS.Timeout | null = null;
function metersNow(): Meters {
  const now = Date.now();
  // closed but resumable sessions too: a group's or ticket's usage counts them
  const live = sessions.list();
  const list = [...live, ...sessions.resumable().filter((r) => !live.some((s) => s.id === r.id))];
  // no index, or one that couldn't sync: said as a failure, so a cost badge shows "—" rather than an empty meter reading
  // as none used, or one going stale
  if (!transcripts || transcriptsProblem) throw new Error(`the conversation index isn't available${transcriptsProblem ? ` (${transcriptsProblem})` : ""}`);
  const convs = [...new Set(list.flatMap(conversationsOf))];
  const report = readUsage(); // reads Codex's session files: once per recompute
  const windows = fiveHourWindows(report, now);
  const windowRows: Partial<Record<AgentKind, UsageRow[]>> = {};
  for (const [agent, w] of Object.entries(windows) as [AgentKind, { start: number }][]) {
    windowRows[agent] = transcripts.usage({ since: w.start }).filter((r) => r.agent === agent);
  }
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return computeMeters({
    sessions: list,
    rows: transcripts.usage({ convs }),
    windowRows,
    todayRows: transcripts.usage({ since: midnight.getTime() }),
    report,
    now,
  });
}
function metersChanged(): void {
  if (metersTimer) clearTimeout(metersTimer);
  metersTimer = setTimeout(() => {
    try {
      toWindow("meters:changed", metersNow());
    } catch (err) {
      // the window hears it as it would from meters:get, so what shows the meters says they couldn't be read
      toWindow("meters:changed", { error: logError("meters", err) });
    }
  }, 1500);
}
handle("meters:get", () => metersNow());

// the models each CLI offers, read from the CLIs; `claude --help` is read once it
// answers — not while claude is missing or failing, which the next look retries
const claudeHelp = rememberAnswer(
  async () => {
    const bin = await installedBin("claude");
    if (!bin) return null; // not installed: no Claude models to offer
    const r = await userShell(`${quote(bin)} --help`);
    if (r.code !== 0) throw new Error(r.out.slice(0, 300) || `exited with code ${r.code}`);
    return r.out;
  },
  (err) => logError("models: claude --help", err)
);
let lastCatalog: ModelCatalog | null = null;
async function modelCatalog(): Promise<ModelCatalog> {
  lastCatalog = buildCatalog({
    claudeHelp: await claudeHelp.get(),
    recent: { claude: transcripts?.recentModels("claude") ?? [], codex: transcripts?.recentModels("codex") ?? [] },
  });
  return lastCatalog;
}
handle("models:catalog", () => modelCatalog());

handle("transcripts:search", (q) => {
  if (!transcripts) throw new Error(transcriptsProblem ?? "The transcript index isn't open yet.");
  return {
    hits: linkHits(transcripts.search(String(q ?? "")), sessions.list(), sessions.resumable(), collab.list()),
    indexing: transcripts.indexing ? transcripts.progress : null,
    lastSync: transcripts.lastSync,
    problem: transcriptsProblem,
    ...transcripts.stats(),
  };
});

// ---- in-app update: build in the user's clone, then restart into it ----
// read once: the update (if any) this launch is the end of
let updateOutcome = isPrimary ? readUpdateOutcome() : null;
function readUpdateOutcome(): UpdateOutcome | null {
  try {
    return takeUpdateOutcome(MB_DIR, app.getVersion());
  } catch (err) {
    logError("update outcome", err); // startup carries on; the update's own log is still there
    return null;
  }
}
const findClone = async () => {
  const repo = updateRepo();
  if (!repo) throw new Error("This build doesn't name its GitHub repository, so it can't update itself.");
  return findSourceClone({ configured: store.settings.updateSource, roots: store.settings.repoRoots, ...repo });
};
const updater = new UpdateRunner({
  exec: loginShellExec(paneEnv()),
  currentVersion: app.getVersion(),
  findClone,
  onProgress: (p) => toWindow("update:progress", p),
});
// "Restart to update" starts a quit; the installer starts only once nothing can
// cancel it anymore (unsaved editor changes ask first, and may keep the app open)
let pendingInstall: Parameters<typeof startInstaller>[0] | null = null;
function startPendingInstall(): void {
  if (!pendingInstall) return;
  const opts = pendingInstall;
  pendingInstall = null;
  try {
    startInstaller(opts);
  } catch (err) {
    const why = logError("update:install", err);
    dialog.showErrorBox("Mockingbird couldn't start the update", `${why}\n\nOpen Mockingbird again — the new version is still built in your clone.`);
  }
}
handle("update:status", () => updater.progress);
handle("update:prepare", () => {
  // runs for minutes; progress (and any failure) arrives as update:progress
  updater.prepare().catch((err) => logError("update:prepare", err));
  return updater.progress;
});
handle("update:cancel", () => updater.cancel());
handle("update:outcome", () => {
  const o = updateOutcome;
  updateOutcome = null;
  return o;
});
// What's new → Suggest something: GitHub issues filed and listed with the user's own gh
let ghPath: string | null = null;
const suggestions = new Suggestions({
  findGh: async () => (ghPath ??= findGhOnPath(process.env.PATH) ?? (await which("gh"))),
  repo: updateRepo,
  canPost: app.isPackaged,
});
handle("suggest:prepare", () => suggestions.prepare());
handle("suggest:post", (draft) => suggestions.post({ title: String(draft?.title ?? ""), body: String(draft?.body ?? "") }));
handle("suggest:list", (fresh) => suggestions.list(fresh === true));
handle("update:source", async () => {
  try {
    return { configured: store.settings.updateSource ?? null, found: await findClone() };
  } catch (err) {
    return { configured: store.settings.updateSource ?? null, found: null, problem: err instanceof Error ? err.message : String(err) };
  }
});
handle("update:install", () => {
  const p = updater.progress;
  if (p.state !== "ready" || !p.appPath || !p.version) throw new Error("There's no finished build to install yet.");
  if (!app.isPackaged) throw new Error("This is a development run (npm start); updates install into the packaged app.");
  const targetApp = path.resolve(app.getPath("exe"), "..", "..", "..");
  if (path.resolve(p.appPath) === targetApp) {
    throw new Error("Mockingbird is running from the clone's release folder, which the build replaces. Install it in /Applications (SETUP.md) and update from there.");
  }
  if (!targetApp.endsWith(".app")) throw new Error(`This copy of Mockingbird isn't an installed app (${targetApp}), so it can't replace itself.`);
  pendingInstall = {
    mbDir: MB_DIR,
    pid: process.pid,
    builtApp: p.appPath,
    targetApp,
    from: app.getVersion(),
    to: p.version,
    sessions: sessions.list().filter((s) => s.status !== "dead").map((s) => s.id),
  };
  updater.markInstalling();
  setTimeout(() => app.quit(), 300); // let this reply reach the window first
  return true;
});

handle("dialog:pick", async (opts) => {
  const win = appWindow();
  const options = {
    properties: [opts?.file ? "openFile" : "openDirectory", "createDirectory"] as any,
    defaultPath: opts?.defaultPath ? expandHome(String(opts.defaultPath)) : undefined,
  };
  const r = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

handle("shell:open", async (url) => {
  // external links only — the dashboard's "open in browser"
  if (typeof url !== "string" || !externalUrlAllowed(url)) throw new Error(`Only https links open in the browser (got ${String(url).slice(0, 80)})`);
  await shell.openExternal(url);
});
