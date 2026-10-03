import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, Tray, nativeImage, shell } from "electron";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Store, expandHome, MB_DIR } from "./store";
import { SessionManager, paneEnv } from "./sessions";
import { indexRepos } from "./repos";
import { worktreeState, cleanupWorktree, listBranches, listWorktrees, removeWorktree, migrateWorktree, forgetState } from "./worktrees";
import { FolderWatcher } from "./watch";
import { installHooks, hooksInstalled, watchEvents, ensureHookScript } from "./hooks";
import { readUsage, watchUsage, setClaudePlan } from "./usage";
import { listDir, readFile, gitChanges, fileDiff } from "./files";
import { scmStatus, scmStage, scmUnstage, scmDiscard, scmCommit, scmPush, scmDiff } from "./scm";
import { listAllFiles, searchFiles } from "./find";
import { Messaging } from "./messaging";
import { setupStatus } from "./setup";
import { CollabRooms, COLLAB_DIR, COLLAB_MODELS, COLLAB_EFFORTS, cliTurnRunner } from "./collab";
import { userShell, which, quote } from "./shell";
import { runDebrief, startScheduler } from "./debrief";
import { listClaudeConversations } from "./importer";
import { listWorkItems, workItemStates, updateWorkItem, listComments, addComment, adoIdentity, resetAdoCache, teamBoards, moveToBoardColumn } from "./ado";
import { checkForUpdate, updateRepo } from "./updates";
import { TranscriptIndex, linkHits } from "./transcripts";
import { buildCatalog, collabModels } from "./models";
import type { ModelCatalog } from "../shared/types";
import { UpdateRunner, findSourceClone, loginShellExec, startInstaller, takeUpdateOutcome } from "./selfUpdate";

const store = new Store();
// debrief panes are ephemeral reviews — don't carry them across restarts
store.state.sessions = store.state.sessions.filter((s) => !s.debrief);
store.save();
const sessions = new SessionManager(store);

const LOG = path.join(require("os").homedir(), ".mockingbird", "main.log");
function logError(context: string, err: unknown): string {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${context}: ${msg}\n`);
  } catch {
    /* logging must never crash the app */
  }
  return err instanceof Error ? err.message : String(err);
}
process.on("uncaughtException", (e) => logError("uncaughtException", e));
process.on("unhandledRejection", (e) => logError("unhandledRejection", e));

/** IPC handlers must never reject silently — surface errors to the renderer. */
function safe<T extends unknown[], R>(context: string, fn: (...args: T) => R) {
  return (...args: T): R | { error: string } => {
    try {
      return fn(...args);
    } catch (err) {
      return { error: logError(context, err) };
    }
  };
}

/** Async flavor of safe() for handlers that call the network (ADO). */
function safeAsync<T extends unknown[], R>(context: string, fn: (...args: T) => Promise<R>) {
  return async (...args: T): Promise<R | { error: string }> => {
    try {
      return await fn(...args);
    } catch (err) {
      return { error: logError(context, err) };
    }
  };
}

// Coalesced notifications: at most one per session per 30s (design 1a).
const lastNotified = new Map<string, number>();
function notifySession(sessionId: string, title: string, body: string): void {
  if (!store.settings.notifications) return;
  const last = lastNotified.get(sessionId) ?? 0;
  if (Date.now() - last < 30_000) return;
  lastNotified.set(sessionId, Date.now());
  new Notification({ title, body }).show();
}

// ---- Menu bar + Dock glanceability (design 1h) ----
// The Dock badge and tray count reflect sessions blocked on you ONLY — never
// working sessions. No badge when nothing is waiting.
let tray: Tray | null = null;

function fmtWait(since: number | null): string {
  if (!since) return "";
  const m = Math.max(0, Math.round((Date.now() - since) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function focusPane(sessionId?: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
  if (sessionId) win.webContents.send("ui:command", "focus-session", sessionId);
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
      BrowserWindow.getAllWindows()[0]?.webContents.send("ui:command", "new-session");
    },
  });
  template.push({ label: "Run 4pm wrap-up", click: () => runDebrief("wrapUp", sessions, store).catch((err) => logError("debrief:wrapUp", err)) });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
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
  win.loadFile(path.join(__dirname, "index.html"));
  sessions.attach(win.webContents);
}

// One instance per user: a second copy would overwrite ~/.mockingbird/state.json
// and take over the agent-messaging socket from the first. Opening the app again
// just brings the running window forward.
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) {
  app.quit(); // asynchronous — startup below checks isPrimary so nothing runs meanwhile
} else {
  app.on("second-instance", () => focusPane());
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
      logError("spawn-helper chmod ok", c);
    } catch {
      /* candidate doesn't exist */
    }
  }
  createWindow();
  // find claude/codex in the background now, so the first session doesn't block on a login shell
  sessions.warmBins().catch((err) => logError("startup:warmBins", err));
  startTranscriptIndex();

  // update polling: notify once per new version; user updates when they choose
  let notifiedVersion = "";
  const pollUpdates = async () => {
    try {
      const u = await checkForUpdate();
      if (u?.newer) {
        BrowserWindow.getAllWindows()[0]?.webContents.send("update:available", u);
        if (notifiedVersion !== u.latest && store.settings.notifications) {
          notifiedVersion = u.latest;
          const n = new Notification({
            title: "Mockingbird update available",
            body: `v${u.latest} is out (you're on v${u.current}). ${u.source === "release" ? "Click to open the release." : "Update with git pull, then npm run package."}`,
          });
          n.on("click", () => shell.openExternal(u.url));
          n.show();
        }
      }
    } catch (err) {
      console.error("[updates] check failed:", err);
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
    () => store.settings.agentMessagesSubmit !== false,
    (from, to) =>
      notifySession(
        from.id,
        "Agents paused messaging",
        `${from.ticketTitle ?? from.title} ↔ ${to.ticketTitle ?? to.title} hit the message limit — check on them`
      )
  );
  messaging.start();
  messaging.setRoomHandler((roomId, seat, op, args) => collab.handleRoomRequest(roomId, seat, op, args));
  // the plan name isn't in Claude's statusline payload; `claude auth status` has it
  void (async () => {
    const bin = sessions.binFor("claude");
    if (!bin.includes("/")) return;
    const r = await userShell(`${quote(bin)} auth status 2>/dev/null`);
    try {
      setClaudePlan(JSON.parse(r.out).subscriptionType ?? null);
    } catch {
      console.warn(`usage: couldn't read the Claude plan from auth status: ${r.out.slice(0, 200)}`);
    }
    BrowserWindow.getAllWindows()[0]?.webContents.send("usage:changed", readUsage());
  })();
  watchUsage((u) => BrowserWindow.getAllWindows()[0]?.webContents.send("usage:changed", u));
  ensureHookScript();
  watchEvents(sessions, (info, status) => {
    notifySession(
      info.id,
      status === "waiting" ? "Needs input" : "Finished",
      status === "waiting"
        ? `${info.title} · ${info.waitingReason ?? "waiting on you"}`
        : `${info.title} is done responding`
    );
  });
  startScheduler(sessions, store);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

// ---- IPC ----
ipcMain.handle("sessions:list", () => sessions.list());
ipcMain.handle("sessions:resumable", () => sessions.resumable());
ipcMain.handle("sessions:create", (_e, req) => safeAsync("sessions:create", () => sessions.create(req))());
ipcMain.handle("sessions:relaunch", (_e, id) => safeAsync("sessions:relaunch", () => sessions.relaunch(id))());
ipcMain.handle("sessions:kill", (_e, id, forget) => sessions.kill(id, forget));
ipcMain.handle("sessions:restartAll", (_e, includeBusy) =>
  safeAsync("sessions:restartAll", () => sessions.restartAll(!!includeBusy))()
);
ipcMain.handle("session:buffer", (_e, id) => sessions.buffer(id));
ipcMain.handle("sessions:broadcast", (_e, req) =>
  sessions.broadcast(req.message, req.sessionIds ?? [], req.whenIdle ?? true)
);
ipcMain.on("session:write", (_e, id, data) => sessions.write(id, data));
// Audit trail for the "something typed /clear into my session" class of bug:
// the renderer reports any pty write it did not attribute to a keystroke.
ipcMain.on("session:audit", (_e, id, kind, data) =>
  Store.audit(`${kind} session=${id} bytes=${JSON.stringify(String(data).slice(0, 300))}`)
);
ipcMain.on("session:resize", (_e, id, cols, rows) => sessions.resize(id, cols, rows));

ipcMain.handle("repos:list", () => safe("repos:list", () => indexRepos(store.settings.repoRoots))());
ipcMain.handle("worktree:state", (_e, wtPath) => safeAsync("worktree:state", () => worktreeState(wtPath))());
ipcMain.handle("worktree:cleanup", (_e, repo, wtPath, mode) =>
  safeAsync("worktree:cleanup", () => cleanupWorktree(repo, wtPath, mode))()
);
ipcMain.handle("worktrees:list", () =>
  safeAsync("worktrees:list", () =>
    listWorktrees(
      indexRepos(store.settings.repoRoots),
      sessions.list().map((s) => s.cwd)
    )
  )()
);
ipcMain.handle("worktrees:remove", (_e, repo, wtPath) =>
  safeAsync("worktrees:remove", async () => {
    if (sessions.list().some((s) => s.cwd === wtPath && s.status !== "dead")) {
      throw new Error("a live session is running in that worktree — close it first");
    }
    await removeWorktree(repo, wtPath);
    return true;
  })()
);
ipcMain.handle("worktrees:migrate", (_e, repo, wtPath) =>
  safeAsync("worktrees:migrate", async () => {
    if (sessions.list().some((s) => s.cwd === wtPath && s.status !== "dead")) {
      throw new Error("a live session is running in that worktree — close it first");
    }
    const dest = await migrateWorktree(repo, wtPath);
    // previous sessions must follow their checkout, or resuming them would
    // try to re-add a branch that is already checked out at the new path
    let touched = false;
    for (const rec of store.state.sessions) {
      if (rec.cwd === wtPath) {
        rec.cwd = dest;
        touched = true;
      }
    }
    if (touched) store.save();
    return dest;
  })()
);
// The explorer addresses files by session id + relative path, so the renderer
// can only reach into folders a live session actually runs in.
function sessionRoot(sessionId: string): string {
  const s = sessions.list().find((x) => x.id === sessionId);
  if (!s) throw new Error("Session is no longer running");
  return s.cwd;
}
ipcMain.handle("files:list", (_e, id, rel) => safeAsync("files:list", () => listDir(sessionRoot(id), rel))());
ipcMain.handle("files:read", (_e, id, rel) => safeAsync("files:read", () => readFile(sessionRoot(id), rel))());
ipcMain.handle("files:changes", (_e, id, scope) =>
  safeAsync("files:changes", () => gitChanges(sessionRoot(id), scope))()
);
ipcMain.handle("files:diff", (_e, id, rel, scope, untracked) =>
  safeAsync("files:diff", () => fileDiff(sessionRoot(id), rel, scope, untracked))()
);
// Folders the window shows are watched, so its views refresh on a change instead
// of polling. Addressed by session id, like the explorer: only live sessions' folders.
const folderWatcher = new FolderWatcher(
  (root) => {
    forgetState(root);
    BrowserWindow.getAllWindows()[0]?.webContents.send("folder:changed", root);
  },
  (root, err) => logError(`folder watch ${root}`, err)
);
ipcMain.handle(
  "folders:watch",
  safe("folders:watch", (_e: unknown, ids: unknown) => {
    const live = new Map(sessions.list().map((s) => [s.id, s.cwd]));
    const roots = (Array.isArray(ids) ? ids : []).map((id) => live.get(String(id))).filter((r): r is string => !!r);
    return folderWatcher.set(roots);
  })
);
ipcMain.handle("files:all", (_e, id) => safeAsync("files:all", () => listAllFiles(sessionRoot(id)))());
ipcMain.handle("files:search", (_e, id, query, opts) =>
  safeAsync("files:search", () =>
    searchFiles(sessionRoot(id), String(query ?? ""), { regex: !!opts?.regex, matchCase: !!opts?.matchCase })
  )()
);
// Source control for a session's folder (addressed by session id, like the explorer)
ipcMain.handle("scm:status", (_e, id) => safeAsync("scm:status", () => scmStatus(sessionRoot(id)))());
ipcMain.handle("scm:stage", (_e, id, paths) => safeAsync("scm:stage", () => scmStage(sessionRoot(id), paths))());
ipcMain.handle("scm:unstage", (_e, id, paths) => safeAsync("scm:unstage", () => scmUnstage(sessionRoot(id), paths))());
ipcMain.handle("scm:discard", (_e, id, entries) => safeAsync("scm:discard", () => scmDiscard(sessionRoot(id), entries, (abs) => shell.trashItem(abs)))());
ipcMain.handle("scm:commit", (_e, id, message) => safeAsync("scm:commit", () => scmCommit(sessionRoot(id), String(message ?? "")))());
ipcMain.handle("scm:push", (_e, id) => safeAsync("scm:push", () => scmPush(sessionRoot(id)))());
ipcMain.handle("scm:diff", (_e, id, rel, staged, untracked) => safeAsync("scm:diff", () => scmDiff(sessionRoot(id), rel, !!staged, !!untracked))());
ipcMain.handle("repo:branches", (_e, repoPath) =>
  safeAsync("repo:branches", () => listBranches(expandHome(repoPath)))()
);

ipcMain.handle("claudemd:read", (_e, p) => {
  const full = expandHome(p);
  // "file not there yet" is an empty editor; anything else (permissions, EISDIR)
  // must surface — otherwise a save writes "" over a file we simply couldn't read
  if (!fs.existsSync(full)) return { path: full, content: "" };
  return safe("claudemd:read", () => ({ path: full, content: fs.readFileSync(full, "utf8") }))();
});
ipcMain.handle("claudemd:save", (_e, p, content) =>
  safe("claudemd:save", () => {
    const full = expandHome(p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return true;
  })()
);

ipcMain.handle("usage:get", () => readUsage());
// the resolved binary is a path only when it was found; a bare name means not installed
const codexBinPath = () => {
  const bin = sessions.binFor("codex");
  return bin.includes("/") ? bin : null;
};
ipcMain.handle("hooks:installed", () => hooksInstalled(codexBinPath()));
ipcMain.handle("hooks:install", () => safe("hooks:install", () => installHooks(codexBinPath()))());
ipcMain.handle("app:version", () => app.getVersion());

// ---- Collaborate rooms ----
const collab = new CollabRooms(
  COLLAB_DIR,
  cliTurnRunner((agent) => sessions.binFor(agent)),
  (room) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("collab:changed", room);
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

function focusRoom(roomId: string): void {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) return;
  w.show();
  w.focus();
  w.webContents.send("collab:focus", roomId);
}
ipcMain.handle("collab:models", async () => {
  try {
    const c = await modelCatalog();
    const { presets, defaults } = collabModels(c);
    return { presets: presets.length ? presets : COLLAB_MODELS, defaults: defaults.length ? defaults : COLLAB_MODELS, efforts: { claude: c.claude.efforts, codex: c.codex.efforts } };
  } catch (err) {
    logError("collab:models", err); // the built-in trio still lets a room start
    return { presets: COLLAB_MODELS, defaults: COLLAB_MODELS, efforts: COLLAB_EFFORTS };
  }
});
ipcMain.handle("collab:repo", (_e, id, repo) => safe("collab:repo", () => collab.setRepo(id, repo))());
ipcMain.handle("collab:permission", (_e, id, reqId, decision) => safe("collab:permission", () => collab.answerPermission(id, reqId, decision))());
ipcMain.handle("collab:askTimeout", (_e, id, minutes) => safe("collab:askTimeout", () => collab.setAskTimeout(id, Number(minutes)))());
ipcMain.handle("collab:revokeKind", (_e, id, kind) => safe("collab:revokeKind", () => collab.revokeAllowKind(id, kind))());
ipcMain.handle("collab:resetCopy", (_e, id) => safe("collab:resetCopy", () => collab.resetTestCopy(id))());
ipcMain.handle("collab:participants", (_e, id, specs) => safe("collab:participants", () => collab.setParticipants(id, specs))());
ipcMain.handle("collab:list", () => safe("collab:list", () => collab.list())());
ipcMain.handle("collab:create", (_e, spec) => safe("collab:create", () => collab.create(spec))());
ipcMain.handle("collab:delete", (_e, id) => safe("collab:delete", () => collab.delete(id))());
ipcMain.handle("collab:send", (_e, id, text) => safe("collab:send", () => collab.send(id, text))());
ipcMain.handle("collab:run", (_e, id) => {
  // runs for minutes; progress arrives as collab:changed, failures are logged and shown in the room
  collab.run(id).catch((err) => logError("collab:run", err));
  return true;
});
ipcMain.handle("collab:stop", (_e, id) => safe("collab:stop", () => collab.stop(id))());
ipcMain.handle("collab:mode", (_e, id, mode, rounds) => safe("collab:mode", () => collab.setMode(id, mode, rounds))());
ipcMain.handle("collab:synthesize", (_e, id, key) => safeAsync("collab:synthesize", () => collab.synthesize(id, key))());
ipcMain.handle("collab:approve", (_e, id, messageId) => safe("collab:approve", () => collab.approve(id, messageId))());
ipcMain.handle("collab:implement", (_e, id, key) => safeAsync("collab:implement", () => collab.implement(id, key))());
ipcMain.handle("setup:status", () => safeAsync("setup:status", () => setupStatus(store, sessions))());
ipcMain.handle("settings:get", () => store.settings);
ipcMain.handle("settings:set", (_e, s) => {
  store.setSettings(s);
  sessions.resetBinCache(); // a new claude path must apply without a restart
  sessions.warmBins().catch((err) => logError("settings:warmBins", err));
  return store.settings;
});
ipcMain.handle("debrief:run", (_e, kind) => safeAsync("debrief:run", () => runDebrief(kind, sessions, store))());
ipcMain.handle("import:list", () => safe("import:list", () => listClaudeConversations())());
ipcMain.handle("sessions:rename", (_e, id, title) => sessions.rename(id, title));
ipcMain.handle("sessions:renameGroup", (_e, oldKey, newKey) => sessions.renameGroup(oldKey, newKey));
ipcMain.handle("sessions:setGroup", (_e, id, group) => sessions.setGroup(id, group));
ipcMain.handle("sessions:clearWaiting", (_e, id) => sessions.clearWaiting(id));

// ---- Azure DevOps dashboard (reads WorkTracker config; PAT stays in main) ----
ipcMain.handle("ado:list", () => safeAsync("ado:list", () => listWorkItems(store))());
ipcMain.handle("ado:states", (_e, type) => safeAsync("ado:states", () => workItemStates(store, type))());
ipcMain.handle("ado:update", (_e, id, patch) =>
  safeAsync("ado:update", () => updateWorkItem(store, id, patch))()
);
ipcMain.handle("ado:me", () => safeAsync("ado:me", () => adoIdentity(store))());
ipcMain.handle("ado:boards", (_e, fresh) => safeAsync("ado:boards", () => teamBoards(store, !!fresh))());
ipcMain.handle("ado:moveToColumn", (_e, id, type, board, column) =>
  safeAsync("ado:moveToColumn", () => moveToBoardColumn(store, Number(id), String(type), String(board), String(column)))()
);
ipcMain.handle("update:check", () => safeAsync("update:check", () => checkForUpdate())());
// Each CLI updates itself (`claude update` / `codex update`); running panes keep
// the old build until they restart, which the Settings UI offers right after.
ipcMain.handle("agents:update", (_e, agent) =>
  safeAsync("agents:update", async () => {
    const kind = agent === "codex" ? "codex" : "claude";
    const bin = sessions.binFor(kind);
    if (!bin.includes("/")) throw new Error(`${kind} isn't installed (not found on your shell's PATH)`);
    const r = await userShell(`${quote(bin)} update 2>&1`, 180_000);
    if (r.code !== 0) throw new Error(r.out || `${kind} update exited with code ${r.code}`);
    sessions.resetBinCache(); // a self-updater may have moved the binary
    return r.out.split("\n").slice(-2).join(" · ");
  })()
);
// ---- connectors (Settings → Connectors card) ----
const wtFile = (name: string) => path.join(expandHome(store.settings.workTrackerPath), name);
const readJson = (file: string): any => {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    // don't pretend the file said nothing — a syntax error here shows up in the
    // UI as "no connectors configured", which sends people down the wrong path
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
};

ipcMain.handle("connectors:status", () =>
  safeAsync("connectors:status", async () => {
    const az = (await which("az")) !== null;
    const globalMcp = Object.keys(readJson(path.join(os.homedir(), ".claude.json")).mcpServers ?? {});
    const projectMcp = Object.keys(readJson(wtFile(".mcp.json")).mcpServers ?? {});
    return { az, global: globalMcp, project: projectMcp };
  })()
);

ipcMain.handle("ado:config:get", () =>
  safe("ado:config:get", () => {
    const a = readJson(wtFile("config.json")).azureDevOps ?? {};
    return { orgUrl: a.orgUrl ?? "", project: a.project ?? "", patFile: a.patFile ?? "" };
  })()
);

// merge-write: only the azureDevOps keys change, the rest of config.json is preserved
ipcMain.handle("ado:config:set", (_e, patch) =>
  safe("ado:config:set", () => {
    const wt = expandHome(store.settings.workTrackerPath);
    fs.mkdirSync(wt, { recursive: true });
    const file = path.join(wt, "config.json");
    const cfg = readJson(file);
    cfg.azureDevOps = {
      ...(cfg.azureDevOps ?? {}),
      orgUrl: String(patch?.orgUrl ?? "").trim(),
      project: String(patch?.project ?? "").trim(),
      patFile: String(patch?.patFile ?? "").trim(),
    };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    resetAdoCache();
    return { ok: true };
  })()
);

// MCP servers for debrief sessions — written to WorkTracker/.mcp.json (project
// scope: Claude Code loads it for sessions running in that folder and asks the
// user to approve it on first use)
ipcMain.handle("mcp:add", (_e, name, command) =>
  safe("mcp:add", () => {
    const n = String(name ?? "").trim();
    const parts = String(command ?? "").trim().split(/\s+/);
    if (!n || !parts[0]) throw new Error("Name and command are required");
    const file = wtFile(".mcp.json");
    const j = readJson(file);
    j.mcpServers = { ...(j.mcpServers ?? {}), [n]: { command: parts[0], args: parts.slice(1) } };
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    return { ok: true };
  })()
);

ipcMain.handle("mcp:remove", (_e, name) =>
  safe("mcp:remove", () => {
    const file = wtFile(".mcp.json");
    const j = readJson(file);
    if (j.mcpServers) delete j.mcpServers[String(name)];
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    return { ok: true };
  })()
);
ipcMain.handle("ado:comments", (_e, id) => safeAsync("ado:comments", () => listComments(store, id))());
ipcMain.handle("ado:comment:add", (_e, id, text) =>
  safeAsync("ado:comment:add", () => addComment(store, id, text))()
);
// native folder/file picker for the Settings tab — no more typing paths
// ---- transcript index: search every Claude/Codex conversation on this Mac ----
const transcriptRoots = { claude: path.join(os.homedir(), ".claude", "projects"), codex: path.join(os.homedir(), ".codex", "sessions") };
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
  const sync = () => transcripts!.sync().catch((err) => (transcriptsProblem = logError("transcripts:sync", err)));
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

// the models each CLI offers, read from the CLIs; `claude --help` is read once per run
let claudeHelp: Promise<string | null> | null = null;
let lastCatalog: ModelCatalog | null = null;
async function modelCatalog(): Promise<ModelCatalog> {
  claudeHelp ??= (async () => {
    const bin = sessions.binFor("claude");
    if (!bin.includes("/")) return null; // not installed: no Claude models to offer
    const r = await userShell(`${quote(bin)} --help`);
    return r.code === 0 ? r.out : null;
  })();
  lastCatalog = buildCatalog({
    claudeHelp: await claudeHelp,
    recent: { claude: transcripts?.recentModels("claude") ?? [], codex: transcripts?.recentModels("codex") ?? [] },
  });
  return lastCatalog;
}
ipcMain.handle("models:catalog", () => safeAsync("models:catalog", modelCatalog)());

ipcMain.handle("transcripts:search", (_e, q) =>
  safe("transcripts:search", () => {
    if (!transcripts) throw new Error(transcriptsProblem ?? "The transcript index isn't open yet.");
    return {
      hits: linkHits(transcripts.search(String(q ?? "")), sessions.list(), sessions.resumable(), collab.list()),
      indexing: transcripts.indexing ? transcripts.progress : null,
      lastSync: transcripts.lastSync,
      problem: transcriptsProblem,
      ...transcripts.stats(),
    };
  })()
);

// ---- in-app update: build in the user's clone, then restart into it ----
// read once: the update (if any) this launch is the end of
let updateOutcome = isPrimary ? takeUpdateOutcome(MB_DIR, app.getVersion()) : null;
const findClone = async () => {
  const repo = updateRepo();
  if (!repo) throw new Error("This build doesn't name its GitHub repository, so it can't update itself.");
  return findSourceClone({ configured: store.settings.updateSource, roots: store.settings.repoRoots, ...repo });
};
const updater = new UpdateRunner({
  exec: loginShellExec(paneEnv()),
  currentVersion: app.getVersion(),
  findClone,
  onProgress: (p) => BrowserWindow.getAllWindows()[0]?.webContents.send("update:progress", p),
});
ipcMain.handle("update:status", () => updater.progress);
ipcMain.handle("update:prepare", () => {
  // runs for minutes; progress (and any failure) arrives as update:progress
  updater.prepare().catch((err) => logError("update:prepare", err));
  return updater.progress;
});
ipcMain.handle("update:cancel", () => updater.cancel());
ipcMain.handle("update:outcome", () => {
  const o = updateOutcome;
  updateOutcome = null;
  return o;
});
ipcMain.handle("update:source", () =>
  safeAsync("update:source", async () => {
    try {
      return { configured: store.settings.updateSource ?? null, found: await findClone() };
    } catch (err) {
      return { configured: store.settings.updateSource ?? null, found: null, problem: err instanceof Error ? err.message : String(err) };
    }
  })()
);
ipcMain.handle("update:install", () =>
  safe("update:install", () => {
    const p = updater.progress;
    if (p.state !== "ready" || !p.appPath || !p.version) throw new Error("There's no finished build to install yet.");
    if (!app.isPackaged) throw new Error("This is a development run (npm start); updates install into the packaged app.");
    const targetApp = path.resolve(app.getPath("exe"), "..", "..", "..");
    if (path.resolve(p.appPath) === targetApp) {
      throw new Error("Mockingbird is running from the clone's release folder, which the build replaces. Install it in /Applications (SETUP.md) and update from there.");
    }
    startInstaller({
      mbDir: MB_DIR,
      pid: process.pid,
      builtApp: p.appPath,
      targetApp,
      from: app.getVersion(),
      to: p.version,
      sessions: sessions.list().filter((s) => s.status !== "dead").map((s) => s.id),
    });
    updater.markInstalling();
    setTimeout(() => app.quit(), 300); // let this reply reach the window first
    return true;
  })()
);

ipcMain.handle("dialog:pick", async (_e, opts) => {
  const win = BrowserWindow.getAllWindows()[0];
  const r = await dialog.showOpenDialog(win, {
    properties: [opts?.file ? "openFile" : "openDirectory", "createDirectory"] as any,
    defaultPath: opts?.defaultPath ? expandHome(String(opts.defaultPath)) : undefined,
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle("shell:open", (_e, url) => {
  // external links only — the dashboard's "open in browser"
  if (typeof url === "string" && /^https:\/\//.test(url)) shell.openExternal(url);
});
