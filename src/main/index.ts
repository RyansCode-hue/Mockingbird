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
import { computeMeters, conversationsOf, fiveHourWindows } from "./meters";
import { RunManager } from "./run";
import { loadProfile, mainCheckout, profilePath, saveProfile } from "./runProfile";
import { draftProfile } from "./runDraft";
import { DebugManager } from "./dap/session";
import { debugTargetFor } from "./dap/targets";
import * as pty from "node-pty";
import { installHooks, hooksInstalled, watchEvents, ensureHookScript } from "./hooks";
import { readUsage, watchUsage, setClaudePlan } from "./usage";
import { listDir, readFile, writeFile, gitChanges, fileDiff, applyFileEdits, resolveIn, baseRef } from "./files";
import { scmStatus, scmStage, scmUnstage, scmDiscard, scmCommit, scmPush, scmPull, scmFetch, scmGraph, scmCommitFiles, scmCommitDiff, scmDiff } from "./scm";
import { listAllFiles, searchFiles } from "./find";
import { generateCommitMessage } from "./commitMessage";
import { Messaging } from "./messaging";
import { setupStatus } from "./setup";
import { CollabRooms, COLLAB_DIR, COLLAB_MODELS, COLLAB_EFFORTS, cliTurnRunner } from "./collab";
import { userShell, userShellWithInput, which, quote } from "./shell";
import { runDebrief, startScheduler } from "./debrief";
import { listClaudeConversations } from "./importer";
import { listWorkItems, workItemStates, updateWorkItem, listComments, addComment, adoIdentity, resetAdoCache, teamBoards, moveToBoardColumn, adoRequest } from "./ado";
import { PipelineStore } from "./pipeline";
import { openPr, parseRemote, prDescriptionPrompt, prError, prPreflight, remoteName, summaryOf } from "./pullRequests";
import { askAgent, cleanReply } from "./headless";
import { git } from "./git";
import { handoffKickoff, handoffPrompt, repoState, transcriptDigest, transcriptLines } from "./handoff";
import { presetRequest } from "./presets";
import { reviewPrompt } from "./review";
import { prStatusFor } from "./prStatus";
import { LspManager } from "./lsp/manager";
import { LSP_DIR } from "./lsp/servers";
import { checkForUpdate, updateRepo } from "./updates";
import { TranscriptIndex, linkHits, type UsageRow } from "./transcripts";
import { buildCatalog, collabModels } from "./models";
import type { AgentKind, Meters, ModelCatalog, PrStatus } from "../shared/types";
import { UpdateRunner, findSourceClone, loginShellExec, startInstaller, takeUpdateOutcome } from "./selfUpdate";

const store = new Store();
// debrief panes are ephemeral reviews — don't carry them across restarts
store.state.sessions = store.state.sessions.filter((s) => !s.debrief);
store.save();
const sessions = new SessionManager(store);
const toWindow = (channel: string, ...args: unknown[]) => BrowserWindow.getAllWindows()[0]?.webContents.send(channel, ...args);

// Run and Debug: a repo's services per worktree, each on its own terminal,
// optionally under the debugger
const debug = new DebugManager({ emit: toWindow });
const runs = new RunManager({
  debugger: debug,
  debugTarget: debugTargetFor,
  spawn: (command, opts) => pty.spawn("/bin/zsh", ["-ilc", command], { name: "xterm-256color", cols: 120, rows: 30, cwd: opts.cwd, env: opts.env }),
  emit: toWindow,
  baseEnv: () => paneEnv() as Record<string, string>,
  docker: async () => {
    const bin = await which("docker");
    if (!bin) throw new Error("Docker isn't installed (or isn't on your shell's PATH)");
    return bin;
  },
  runShell: (command, cwd, env) => userShellWithInput(command, "", { cwd, env, timeoutMs: 120_000 }),
});

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
  // the editor holds unsaved changes: the window says so (beforeunload), and quitting asks first
  win.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Quit without saving", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Some files have unsaved changes",
      detail: "Edits in the editor that haven't been saved (⌘S) will be lost.",
    });
    if (choice === 0) event.preventDefault(); // go ahead and unload
  });
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
  watchUsage((u) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("usage:changed", u);
    metersChanged();
  });
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

// services Mockingbird started stop with it — nothing keeps holding ports or containers
let runsStopped = false;
app.on("before-quit", (e) => {
  if (runsStopped || !runs.states().some((s) => s.status === "running" || s.status === "starting" || s.status === "stopping")) return;
  e.preventDefault();
  const done = () => {
    runsStopped = true;
    app.quit();
  };
  Promise.race([runs.stopAll(), new Promise((r) => setTimeout(r, 15_000))])
    .catch((err) => logError("run:stopAll on quit", err))
    .finally(done);
});

app.on("window-all-closed", () => {
  app.quit();
});

// ---- IPC ----
ipcMain.handle("sessions:list", () => sessions.list());
ipcMain.handle("sessions:resumable", () => sessions.resumable());
ipcMain.handle("sessions:create", (_e, req) =>
  safeAsync("sessions:create", async () => {
    const info = await sessions.create(req);
    // a session opened on a ticket means its coding has started
    if (req?.ticketId && pipeline.startCoding(String(req.ticketId), req.ticketTitle ?? undefined)) pipelineChanged();
    return info;
  })()
);
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
ipcMain.handle("files:write", (_e, id, rel, content, expected) =>
  safeAsync("files:write", () => {
    if (typeof content !== "string") throw new Error("Nothing to save");
    return writeFile(sessionRoot(id), String(rel), content, typeof expected === "number" ? expected : null);
  })()
);
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
ipcMain.handle("run:profile", (_e, id) =>
  safeAsync("run:profile", async () => {
    const worktree = sessionRoot(id);
    const repo = await mainCheckout(worktree);
    return { worktree, repo, file: profilePath(repo), profile: loadProfile(repo) };
  })()
);
ipcMain.handle("run:saveProfile", (_e, id, profile) =>
  safeAsync("run:saveProfile", async () => saveProfile(profile, await mainCheckout(sessionRoot(id))))()
);
ipcMain.handle("run:draft", (_e, id) =>
  safeAsync("run:draft", async () => draftProfile(await mainCheckout(sessionRoot(id)), sessions.binFor("claude"), userShellWithInput, paneEnv() as Record<string, string>))()
);
ipcMain.handle("run:start", (_e, id, opts) =>
  safeAsync("run:start", () =>
    runs.start(sessionRoot(id), {
      mode: opts?.mode === "side" ? "side" : "swap",
      services: Array.isArray(opts?.services) ? opts.services.map(String) : undefined,
      debug: Array.isArray(opts?.debug) ? opts.debug.map(String) : undefined,
    })
  )()
);
ipcMain.handle("run:stopListeners", (_e, id, pids) =>
  safe("run:stopListeners", () => runs.stopListeners(sessionRoot(id), (Array.isArray(pids) ? pids : []).map(Number)))()
);
ipcMain.handle("run:stop", (_e, id, services) =>
  safeAsync("run:stop", () => runs.stop(sessionRoot(id), Array.isArray(services) ? services.map(String) : undefined))()
);
ipcMain.handle("run:prepare", (_e, id) => safeAsync("run:prepare", () => runs.prepare(sessionRoot(id)))());
ipcMain.handle("run:states", () => runs.states());
ipcMain.handle("run:buffer", (_e, runId) => runs.buffer(String(runId)));
ipcMain.handle("run:clear", (_e, runId) => runs.clear(String(runId)));
// the debugger: breakpoints are the repo's (relative paths), sessions are addressed by their own id
ipcMain.handle("debug:breakpoints", (_e, id) =>
  safeAsync("debug:breakpoints", async () => {
    const repo = await mainCheckout(sessionRoot(id));
    return { repo, breakpoints: debug.breakpoints(repo) };
  })()
);
ipcMain.handle("debug:setBreakpoints", (_e, id, rel, lines) =>
  safeAsync("debug:setBreakpoints", async () => {
    const repo = await mainCheckout(sessionRoot(id));
    const r = await debug.setBreakpoints(repo, String(rel), Array.isArray(lines) ? lines.map(Number) : []);
    toWindow("debug:breakpointsChanged", repo);
    return r;
  })()
);
ipcMain.handle("debug:sessions", () => debug.infos());
ipcMain.handle("debug:control", (_e, sid, op, threadId) =>
  safeAsync("debug:control", () => {
    if (!["continue", "next", "stepIn", "stepOut", "pause"].includes(op)) throw new Error(`Unknown debug command: ${op}`);
    return debug.control(String(sid), op, typeof threadId === "number" ? threadId : undefined);
  })()
);
ipcMain.handle("debug:stack", (_e, sid, threadId) => safeAsync("debug:stack", () => debug.stackTrace(String(sid), Number(threadId)))());
ipcMain.handle("debug:scopes", (_e, sid, frameId) => safeAsync("debug:scopes", () => debug.scopes(String(sid), Number(frameId)))());
ipcMain.handle("debug:variables", (_e, sid, ref) => safeAsync("debug:variables", () => debug.variables(String(sid), Number(ref)))());
ipcMain.handle("debug:evaluate", (_e, sid, expr, frameId, context) =>
  safeAsync("debug:evaluate", () =>
    debug.evaluate(String(sid), String(expr), typeof frameId === "number" ? frameId : undefined, context === "watch" || context === "hover" ? context : "repl")
  )()
);
ipcMain.handle("debug:stop", (_e, sid) => safeAsync("debug:stop", () => debug.stop(String(sid)))());
ipcMain.handle("debug:prune", () => debug.prune());
ipcMain.handle("run:stopById", (_e, runId) => safeAsync("run:stopById", () => runs.stopById(String(runId)))());
ipcMain.on("run:write", (_e, runId, data) => runs.write(String(runId), String(data)));
ipcMain.on("run:resize", (_e, runId, cols, rows) => runs.resize(String(runId), Number(cols), Number(rows)));
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
ipcMain.handle("scm:pull", (_e, id) => safeAsync("scm:pull", () => scmPull(sessionRoot(id)))());
ipcMain.handle("scm:fetch", (_e, id) => safeAsync("scm:fetch", () => scmFetch(sessionRoot(id)))());
ipcMain.handle("scm:graph", (_e, id, limit) => safeAsync("scm:graph", () => scmGraph(sessionRoot(id), Math.min(2000, Math.max(20, Number(limit) || 150))))());
ipcMain.handle("scm:commitFiles", (_e, id, sha) => safeAsync("scm:commitFiles", () => scmCommitFiles(sessionRoot(id), String(sha)))());
ipcMain.handle("scm:commitDiff", (_e, id, sha, rel) => safeAsync("scm:commitDiff", () => scmCommitDiff(sessionRoot(id), String(sha), String(rel)))());
// a commit message from the folder's staged change (or all of it), written by the
// session's own agent — or the other one when that isn't installed
ipcMain.handle("scm:commitMessage", (_e, id) =>
  safeAsync("scm:commitMessage", async () => {
    const s = sessions.list().find((x) => x.id === id);
    if (!s) throw new Error("Session is no longer running");
    const want: AgentKind = s.agent ?? "claude";
    const agent: AgentKind = sessions.binFor(want).includes("/") ? want : want === "claude" ? "codex" : "claude";
    return { ...(await generateCommitMessage(s.cwd, agent, sessions.binFor(agent), userShellWithInput, paneEnv())), agent };
  })()
);
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

// ---- ticket pipeline: each ticket's stage, PRs, feedback and drafted comments ----
const pipeline = new PipelineStore(path.join(MB_DIR, "pipeline.json"));
const pipelineChanged = () => toWindow("pipeline:changed", pipeline.all());
const pipelineDo = <T,>(name: string, fn: () => T | Promise<T>) =>
  safeAsync(name, async () => {
    const r = await fn();
    pipelineChanged();
    return r;
  })();
/** The session's own agent for a one-off question, or the other one when it isn't installed. */
const askingAgent = (want: AgentKind = "claude"): AgentKind => (sessions.binFor(want).includes("/") ? want : want === "claude" ? "codex" : "claude");
const prDeps = (root: string) => ({ ado: (url: string, init?: RequestInit) => adoRequest(store, url, init), run: userShellWithInput, env: paneEnv(), cwd: root });
const sessionOf = (id: string) => {
  const s = sessions.list().find((x) => x.id === id);
  if (!s) throw new Error("Session is no longer running");
  return s;
};

ipcMain.handle("pipeline:all", () => pipeline.all());
ipcMain.handle("pipeline:stage", (_e, id, stage, title) => pipelineDo("pipeline:stage", () => pipeline.setStage(String(id), stage, { title: title ? String(title) : undefined })));
ipcMain.handle("pipeline:feedback", (_e, id, text) => pipelineDo("pipeline:feedback", () => pipeline.addFeedback(String(id), String(text ?? ""))));
ipcMain.handle("pipeline:check", (_e, id, key, value) => pipelineDo("pipeline:check", () => pipeline.setCheck(String(id), String(key), !!value)));
ipcMain.handle("pipeline:draft:add", (_e, id, stage, text) => pipelineDo("pipeline:draft:add", () => pipeline.addDraft(String(id), stage, String(text ?? ""))));
ipcMain.handle("pipeline:draft:edit", (_e, id, draftId, text) => pipelineDo("pipeline:draft:edit", () => pipeline.editDraft(String(id), String(draftId), String(text ?? ""))));
ipcMain.handle("pipeline:draft:drop", (_e, id, draftId) => pipelineDo("pipeline:draft:drop", () => pipeline.dropDraft(String(id), String(draftId))));
// posting is the one step that writes to ADO, and only for the draft the user picked
ipcMain.handle("pipeline:draft:post", (_e, id, draftId) =>
  pipelineDo("pipeline:draft:post", async () => {
    const tid = String(id);
    if (!/^\d+$/.test(tid)) throw new Error(`#${tid} isn't an Azure DevOps work item, so it has no discussion to post to`);
    const d = pipeline.findDraft(tid, String(draftId));
    if (!d.text.trim()) throw new Error("The comment is empty");
    await addComment(store, Number(tid), d.text);
    return pipeline.dropDraft(tid, d.id);
  })
);
ipcMain.handle("pipeline:pr:preflight", (_e, sessionId, ticketId, target) =>
  safeAsync("pipeline:pr:preflight", () => {
    const root = sessionOf(String(sessionId)).cwd;
    return prPreflight(root, String(ticketId), target === "main" ? "main" : "dev", prDeps(root));
  })()
);
ipcMain.handle("pipeline:pr:describe", (_e, sessionId, ticketId, title, base) =>
  safeAsync("pipeline:pr:describe", async () => {
    const s = sessionOf(String(sessionId));
    const agent = askingAgent(s.agent ?? "claude");
    const prompt = await prDescriptionPrompt(s.cwd, String(base), { id: String(ticketId), title: String(title ?? "") });
    const text = cleanReply(await askAgent(prompt, { agent, bin: sessions.binFor(agent), run: userShellWithInput, env: paneEnv(), tag: "pr-description", model: "sonnet", timeoutMs: 180_000 }), /^(description)\s*:\s*/i);
    if (!text) throw new Error("The model returned an empty description");
    return { description: text, agent };
  })()
);
// pushes the branch and opens the pull request — run only from the PR form's button
ipcMain.handle("pipeline:pr:create", (_e, sessionId, ticketId, req) =>
  pipelineDo("pipeline:pr:create", async () => {
    const s = sessionOf(String(sessionId));
    const target = req?.target === "main" ? "main" : "dev";
    const base = String(req?.base ?? "");
    const title = String(req?.title ?? "").trim();
    if (!base) throw new Error("Pick the branch to merge into");
    if (!title) throw new Error("The pull request needs a title");
    const pre = await prPreflight(s.cwd, String(ticketId), target, prDeps(s.cwd));
    if (!pre.branch) throw new Error("The worktree isn't on a branch");
    if (pre.dirtyFiles) throw new Error(`Commit or stash the ${pre.dirtyFiles} uncommitted file${pre.dirtyFiles === 1 ? "" : "s"} first — they wouldn't be in the pull request`);
    if (pre.existing && pre.base === base) throw new Error(`A pull request is already open from ${pre.branch}: ${pre.existing.url}`);
    const url = await git(s.cwd, ["remote", "get-url", "origin"]);
    const remote = parseRemote(url);
    if (!remote) throw new Error(`origin (${url}) isn't on Azure DevOps or GitHub`);
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
      { target, provider: remote.provider, id: made.id, url: made.url, repo: remoteName(remote), branch: pre.branch, base, at: Date.now(), summary: description ? summaryOf(description) : undefined },
      req?.ticketTitle ? String(req.ticketTitle) : undefined
    );
  })
);
// ---- continue in the other agent: a handoff written from the session's conversation ----
const otherAgent = (a: AgentKind): AgentKind => (a === "claude" ? "codex" : "claude");
const agentName = (a: AgentKind) => (a === "codex" ? "Codex" : "Claude Code");
// the agent taking over writes the handoff: the one handing over may be out of usage
ipcMain.handle("handoff:draft", (_e, id) =>
  safeAsync("handoff:draft", async () => {
    const s = sessionOf(String(id));
    if (s.shell) throw new Error("A terminal has no agent conversation to hand over");
    const from: AgentKind = s.agent ?? "claude";
    const to = otherAgent(from);
    if (!sessions.binFor(to).includes("/")) throw new Error(`${agentName(to)} isn't installed — set it up in Settings → Agents`);
    const conv = s.conversation?.id ?? s.conversations?.at(-1);
    let digest = "";
    if (conv && transcripts) {
      await transcripts.sync();
      const files = transcripts.filesOf(conv);
      const lines = (await Promise.all(files.map((f) => transcriptLines(f.path)))).flat();
      digest = transcriptDigest(lines, files[0]?.agent ?? from, conv);
    }
    if (!digest) {
      const why = !conv ? "Mockingbird hasn't seen this session's conversation yet" : transcriptsProblem ? `the conversation index isn't available (${transcriptsProblem})` : "its conversation isn't in the index yet";
      throw new Error(`Couldn't read the conversation: ${why}. Write the handoff yourself below.`);
    }
    const prompt = handoffPrompt({ from, to, cwd: s.cwd, title: s.ticketTitle ?? s.title, digest, repo: await repoState(s.cwd) });
    const handoff = cleanReply(await askAgent(prompt, { agent: to, bin: sessions.binFor(to), run: userShellWithInput, env: paneEnv(), tag: "handoff", model: "sonnet", timeoutMs: 240_000 }), /^(handoff)\s*:\s*/i);
    if (!handoff) throw new Error("The model returned an empty handoff");
    return { handoff, from, to };
  })()
);
// a session of the other agent in the same folder and group, started with the handoff
ipcMain.handle("handoff:start", (_e, id, handoff) =>
  safeAsync("handoff:start", async () => {
    const s = sessionOf(String(id));
    const text = String(handoff ?? "").trim();
    if (!text) throw new Error("The handoff is empty");
    const from: AgentKind = s.agent ?? "claude";
    const to = otherAgent(from);
    return sessions.create({
      repoPath: s.repoPath,
      cwd: s.cwd,
      branchName: s.branch ?? undefined,
      useWorktree: false,
      agent: to,
      title: `${s.ticketTitle ?? s.title} · ${to}`,
      taskGroup: s.taskGroup ?? undefined,
      initialPrompt: handoffKickoff(from, text),
    });
  })()
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
app.on("will-quit", () => lsp.stopAll());
/** A file of a session's folder, as the root and an absolute path inside it. */
const lspFile = async (sessionId: string, rel: string) => {
  const root = sessionRoot(String(sessionId));
  return { root, abs: await resolveIn(root, String(rel)) };
};
const pos = (line: unknown, character: unknown) => ({ line: Number(line) || 0, character: Number(character) || 0 });
ipcMain.handle("lsp:open", (_e, id, rel, text) => safeAsync("lsp:open", async () => { const f = await lspFile(id, rel); return lsp.open(f.root, f.abs, String(text ?? "")); })());
ipcMain.handle("lsp:install", (_e, server) =>
  safeAsync("lsp:install", () => lsp.install(server, (message) => toWindow("lsp:status", { server, root: "", state: "installing", message })))()
);
ipcMain.handle("lsp:change", (_e, id, rel, text) => safeAsync("lsp:change", async () => { const f = await lspFile(id, rel); lsp.change(f.root, f.abs, String(text ?? "")); })());
ipcMain.handle("lsp:saved", (_e, id, rel) => safeAsync("lsp:saved", async () => { const f = await lspFile(id, rel); lsp.saved(f.root, f.abs); })());
ipcMain.handle("lsp:close", (_e, id, rel) => safeAsync("lsp:close", async () => { const f = await lspFile(id, rel); lsp.close(f.root, f.abs); })());
ipcMain.handle("lsp:hover", (_e, id, rel, line, ch) => safeAsync("lsp:hover", async () => { const f = await lspFile(id, rel); return lsp.hover(f.root, f.abs, pos(line, ch)); })());
ipcMain.handle("lsp:complete", (_e, id, rel, line, ch, prefix, trigger) =>
  safeAsync("lsp:complete", async () => { const f = await lspFile(id, rel); return lsp.completion(f.root, f.abs, pos(line, ch), String(prefix ?? ""), trigger ? String(trigger) : undefined); })()
);
ipcMain.handle("lsp:definition", (_e, id, rel, line, ch) => safeAsync("lsp:definition", async () => { const f = await lspFile(id, rel); return lsp.definition(f.root, f.abs, pos(line, ch)); })());
ipcMain.handle("lsp:rename", (_e, id, rel, line, ch, name) =>
  safeAsync("lsp:rename", async () => {
    const newName = String(name ?? "").trim();
    if (!newName) throw new Error("Type the new name");
    const f = await lspFile(id, rel);
    return lsp.rename(f.root, f.abs, pos(line, ch), newName);
  })()
);
ipcMain.handle("lsp:format", (_e, id, rel, tabSize, insertSpaces) =>
  safeAsync("lsp:format", async () => { const f = await lspFile(id, rel); return lsp.format(f.root, f.abs, { tabSize: Number(tabSize) || 4, insertSpaces: !!insertSpaces }); })()
);
// a rename's edits to a file that isn't open in the editor: written straight to it
ipcMain.handle("lsp:applyEdits", (_e, id, rel, edits) =>
  safeAsync("lsp:applyEdits", () => applyFileEdits(sessionRoot(String(id)), String(rel), Array.isArray(edits) ? edits : []))()
);

// ---- PR status in the pane rail: the branch's pull request, looked up at most every 2 minutes per folder ----
const PR_TTL_MS = 120_000;
const prCache = new Map<string, PrStatus>();
const prInFlight = new Map<string, Promise<PrStatus>>();
ipcMain.handle("pr:status", (_e, cwd, fresh) =>
  safeAsync("pr:status", async () => {
    const root = String(cwd);
    if (!sessions.list().some((s) => s.cwd === root)) throw new Error("No session runs in that folder");
    const hit = prCache.get(root);
    if (hit && !fresh && Date.now() - hit.at < PR_TTL_MS) {
      // a branch switch makes the cached answer someone else's
      const branch = (await git(root, ["symbolic-ref", "--short", "-q", "HEAD"], { okCodes: [0, 1] })) || null;
      if (branch === hit.branch) return hit;
    }
    let p = prInFlight.get(root);
    if (!p) {
      p = prStatusFor(root, prDeps(root)).finally(() => prInFlight.delete(root));
      prInFlight.set(root, p);
    }
    const st = await p;
    prCache.set(root, st);
    return st;
  })()
);

// ---- session presets: one-click recurring setups ----
ipcMain.handle("presets:start", (_e, id) =>
  safeAsync("presets:start", async () => {
    const p = (store.settings.presets ?? []).find((x) => x.id === id);
    if (!p) throw new Error("That preset no longer exists");
    const repo = p.repoPath ? expandHome(p.repoPath) : null;
    const branches = repo && p.branch.mode === "new" ? (await listBranches(repo)).branches : [];
    return sessions.create(presetRequest({ ...p, repoPath: repo }, branches, new Date()));
  })()
);

// ---- cross-agent review: the other agent reviews this session's branch and reports back ----
ipcMain.handle("review:start", (_e, id) =>
  safeAsync("review:start", async () => {
    const s = sessionOf(String(id));
    if (s.shell) throw new Error("A terminal has no agent's work to review");
    if (!s.repoPath) throw new Error("This session isn't in a repository");
    const author: AgentKind = s.agent ?? "claude";
    const reviewer = otherAgent(author);
    if (!sessions.binFor(reviewer).includes("/")) throw new Error(`${agentName(reviewer)} isn't installed — set it up in Settings → Agents`);
    const base = await baseRef(s.cwd);
    return sessions.create({
      repoPath: s.repoPath,
      cwd: s.cwd,
      branchName: s.branch ?? undefined,
      useWorktree: false,
      agent: reviewer,
      title: `Review · ${s.ticketTitle ?? s.title}`,
      taskGroup: s.taskGroup ?? undefined,
      initialPrompt: reviewPrompt({ author, authorId: s.id, authorTitle: s.ticketTitle ?? s.title, branch: s.branch, base }),
    });
  })()
);

// a short announcement for the people who use the system, from the ticket and its PRs
ipcMain.handle("pipeline:comms", (_e, ticketId, title, details) =>
  safeAsync("pipeline:comms", async () => {
    const p = pipeline.get(String(ticketId));
    const agent = askingAgent();
    const prompt = [
      `Write a short announcement for the people who use this system about a change that just shipped: ticket #${ticketId} "${String(title ?? "")}".`,
      "Plain language, no internal jargon, branch names or ticket numbers; 3 to 6 sentences: what changed, who it affects, and anything they need to do.",
      "Reply with the announcement only.",
      "",
      details ? `The ticket:\n${String(details).slice(0, 6000)}` : "",
      ...(p?.prs ?? []).filter((x) => x.summary).map((x) => `What the pull request to ${x.base} did:\n${x.summary}`),
    ].join("\n");
    const text = cleanReply(await askAgent(prompt, { agent, bin: sessions.binFor(agent), run: userShellWithInput, env: paneEnv(), tag: "comms", model: "sonnet", timeoutMs: 180_000 }), /^(announcement)\s*:\s*/i);
    if (!text) throw new Error("The model returned an empty announcement");
    return { text, agent };
  })()
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
  const sync = () =>
    transcripts!
      .sync()
      .then(metersChanged)
      .catch((err) => (transcriptsProblem = logError("transcripts:sync", err)));
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

// token meters: recomputed after the index catches up, when plan usage moves, and as panes change conversation
let metersTimer: NodeJS.Timeout | null = null;
function metersNow(): Meters {
  const now = Date.now();
  const list = sessions.list();
  if (!transcripts) return { sessions: {}, today: {}, at: now };
  const convs = [...new Set(list.flatMap(conversationsOf))];
  const windows = fiveHourWindows(readUsage(), now);
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
    report: readUsage(),
    now,
  });
}
function metersChanged(): void {
  if (metersTimer) clearTimeout(metersTimer);
  metersTimer = setTimeout(() => {
    try {
      toWindow("meters:changed", metersNow());
    } catch (err) {
      logError("meters", err);
    }
  }, 1500);
}
ipcMain.handle("meters:get", () => safe("meters:get", metersNow)());

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
