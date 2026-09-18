import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, Tray, nativeImage, shell } from "electron";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Store, expandHome } from "./store";
import { SessionManager } from "./sessions";
import { indexRepos } from "./repos";
import { worktreeState, cleanupWorktree, listBranches, listWorktrees, removeWorktree, migrateWorktree } from "./worktrees";
import { installHooks, hooksInstalled, watchEvents } from "./hooks";
import { readUsage, watchUsage } from "./usage";
import { listDir, readFile, gitChanges, fileDiff } from "./files";
import { runDebrief, startScheduler } from "./debrief";
import { listClaudeConversations } from "./importer";
import { listWorkItems, workItemStates, updateWorkItem, listComments, addComment, adoIdentity, resetAdoCache } from "./ado";
import { checkForUpdate } from "./updates";

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

  tray.setTitle(waiting.length ? `🪶 ${waiting.length}` : "🪶", { fontType: "monospacedDigit" });
  app.dock?.setBadge(waiting.length ? String(waiting.length) : "");

  const template: Electron.MenuItemConstructorOptions[] = [];
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
  template.push({ label: "Run 4pm wrap-up", click: () => runDebrief("wrapUp", sessions, store) });
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

app.whenReady().then(() => {
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
            body: `v${u.latest} is out (you're on v${u.current}). Click to open the release.`,
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
  watchUsage((u) => BrowserWindow.getAllWindows()[0]?.webContents.send("usage:changed", u));
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
ipcMain.handle("sessions:create", (_e, req) => safe("sessions:create", () => sessions.create(req))());
ipcMain.handle("sessions:relaunch", (_e, id) => safe("sessions:relaunch", () => sessions.relaunch(id))());
ipcMain.handle("sessions:kill", (_e, id, forget) => sessions.kill(id, forget));
ipcMain.handle("sessions:restartAll", (_e, includeBusy) =>
  safe("sessions:restartAll", () => sessions.restartAll(!!includeBusy))()
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
ipcMain.handle("worktree:state", (_e, wtPath) => safe("worktree:state", () => worktreeState(wtPath))());
ipcMain.handle("worktree:cleanup", (_e, repo, wtPath, mode) =>
  safe("worktree:cleanup", () => cleanupWorktree(repo, wtPath, mode))()
);
ipcMain.handle("worktrees:list", () =>
  safe("worktrees:list", () =>
    listWorktrees(
      indexRepos(store.settings.repoRoots),
      sessions.list().map((s) => s.cwd)
    )
  )()
);
ipcMain.handle("worktrees:remove", (_e, repo, wtPath) =>
  safe("worktrees:remove", () => {
    if (sessions.list().some((s) => s.cwd === wtPath && s.status !== "dead")) {
      throw new Error("a live session is running in that worktree — close it first");
    }
    removeWorktree(repo, wtPath);
    return true;
  })()
);
ipcMain.handle("worktrees:migrate", (_e, repo, wtPath) =>
  safe("worktrees:migrate", () => {
    if (sessions.list().some((s) => s.cwd === wtPath && s.status !== "dead")) {
      throw new Error("a live session is running in that worktree — close it first");
    }
    const dest = migrateWorktree(repo, wtPath);
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
ipcMain.handle("repo:branches", (_e, repoPath) =>
  safe("repo:branches", () => listBranches(expandHome(repoPath)))()
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
ipcMain.handle("hooks:installed", () => hooksInstalled());
ipcMain.handle("hooks:install", () => installHooks());
ipcMain.handle("settings:get", () => store.settings);
ipcMain.handle("settings:set", (_e, s) => {
  store.setSettings(s);
  sessions.resetBinCache(); // a new claude path must apply without a restart
  return store.settings;
});
ipcMain.handle("debrief:run", (_e, kind) => runDebrief(kind, sessions, store));
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
ipcMain.handle("update:check", () => safeAsync("update:check", () => checkForUpdate())());
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
  safe("connectors:status", () => {
    let az = false;
    try {
      execFileSync("/bin/zsh", ["-lc", "command -v az"], { encoding: "utf8" });
      az = true;
    } catch {
      /* az not installed */
    }
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
