import type { WorktreeCleanupMode } from "../shared/types";
import { contextBridge, ipcRenderer, webUtils } from "electron";

const api = {
  // sessions
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  resumableSessions: () => ipcRenderer.invoke("sessions:resumable"),
  createSession: (req: unknown) => ipcRenderer.invoke("sessions:create", req),
  relaunchSession: (id: string) => ipcRenderer.invoke("sessions:relaunch", id),
  killSession: (id: string, forget: boolean) => ipcRenderer.invoke("sessions:kill", id, forget),
  restartAllSessions: (includeBusy: boolean) => ipcRenderer.invoke("sessions:restartAll", includeBusy),
  sessionWrite: (id: string, data: string) => ipcRenderer.send("session:write", id, data),
  auditWrite: (id: string, kind: string, data: string) => ipcRenderer.send("session:audit", id, kind, data),
  sessionResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send("session:resize", id, cols, rows),
  sessionBuffer: (id: string) => ipcRenderer.invoke("session:buffer", id),
  broadcast: (req: unknown) => ipcRenderer.invoke("sessions:broadcast", req),

  renameSession: (id: string, title: string) => ipcRenderer.invoke("sessions:rename", id, title),
  renameGroup: (oldKey: string, newKey: string) =>
    ipcRenderer.invoke("sessions:renameGroup", oldKey, newKey),
  setGroup: (id: string, group: string | null) => ipcRenderer.invoke("sessions:setGroup", id, group),
  clearWaiting: (id: string) => ipcRenderer.invoke("sessions:clearWaiting", id),

  // Azure DevOps dashboard
  adoList: () => ipcRenderer.invoke("ado:list"),
  adoMe: () => ipcRenderer.invoke("ado:me"),
  connectorsStatus: () => ipcRenderer.invoke("connectors:status"),
  updateCheck: () => ipcRenderer.invoke("update:check"),
  searchTranscripts: (q: string) => ipcRenderer.invoke("transcripts:search", q),
  updateStatus: () => ipcRenderer.invoke("update:status"),
  updatePrepare: () => ipcRenderer.invoke("update:prepare"),
  updateCancel: () => ipcRenderer.invoke("update:cancel"),
  updateInstall: () => ipcRenderer.invoke("update:install"),
  updateOutcome: () => ipcRenderer.invoke("update:outcome"),
  updateSource: () => ipcRenderer.invoke("update:source"),
  onUpdateProgress: (cb: (p: unknown) => void) => {
    const h = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on("update:progress", h);
    return () => ipcRenderer.removeListener("update:progress", h);
  },
  appVersion: () => ipcRenderer.invoke("app:version"),
  collabModels: () => ipcRenderer.invoke("collab:models"),
  collabList: () => ipcRenderer.invoke("collab:list"),
  collabCreate: (spec: unknown) => ipcRenderer.invoke("collab:create", spec),
  collabRepo: (id: string, repo: string | null) => ipcRenderer.invoke("collab:repo", id, repo),
  collabResetCopy: (id: string) => ipcRenderer.invoke("collab:resetCopy", id),
  collabPermission: (id: string, reqId: string, decision: "allow" | "deny" | "always") => ipcRenderer.invoke("collab:permission", id, reqId, decision),
  collabRevokeKind: (id: string, kind: string) => ipcRenderer.invoke("collab:revokeKind", id, kind),
  collabAskTimeout: (id: string, minutes: number) => ipcRenderer.invoke("collab:askTimeout", id, minutes),
  onCollabFocus: (cb: (roomId: string) => void) => {
    const h = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on("collab:focus", h);
    return () => ipcRenderer.removeListener("collab:focus", h);
  },
  collabParticipants: (id: string, specs: unknown) => ipcRenderer.invoke("collab:participants", id, specs),
  collabDelete: (id: string) => ipcRenderer.invoke("collab:delete", id),
  collabSend: (id: string, text: string) => ipcRenderer.invoke("collab:send", id, text),
  collabRun: (id: string) => ipcRenderer.invoke("collab:run", id),
  collabStop: (id: string) => ipcRenderer.invoke("collab:stop", id),
  collabMode: (id: string, mode: string, rounds?: number) => ipcRenderer.invoke("collab:mode", id, mode, rounds),
  collabSynthesize: (id: string, key: string) => ipcRenderer.invoke("collab:synthesize", id, key),
  collabApprove: (id: string, messageId: string) => ipcRenderer.invoke("collab:approve", id, messageId),
  collabImplement: (id: string, key: string) => ipcRenderer.invoke("collab:implement", id, key),
  onCollabChanged: (cb: (room: unknown) => void) => {
    const h = (_e: unknown, r: unknown) => cb(r);
    ipcRenderer.on("collab:changed", h);
    return () => ipcRenderer.removeListener("collab:changed", h);
  },
  setupStatus: () => ipcRenderer.invoke("setup:status"),
  agentUpdate: (agent: string) => ipcRenderer.invoke("agents:update", agent),
  onUpdateAvailable: (cb: (u: unknown) => void) => {
    const h = (_e: unknown, u: unknown) => cb(u);
    ipcRenderer.on("update:available", h);
    return () => ipcRenderer.removeListener("update:available", h);
  },
  filesList: (id: string, rel: string) => ipcRenderer.invoke("files:list", id, rel),
  filesRead: (id: string, rel: string) => ipcRenderer.invoke("files:read", id, rel),
  filesChanges: (id: string, scope: string) => ipcRenderer.invoke("files:changes", id, scope),
  scmStatus: (id: string) => ipcRenderer.invoke("scm:status", id),
  scmStage: (id: string, paths: string[]) => ipcRenderer.invoke("scm:stage", id, paths),
  scmUnstage: (id: string, paths: string[]) => ipcRenderer.invoke("scm:unstage", id, paths),
  scmDiscard: (id: string, entries: { path: string; untracked: boolean }[]) => ipcRenderer.invoke("scm:discard", id, entries),
  scmCommit: (id: string, message: string) => ipcRenderer.invoke("scm:commit", id, message),
  scmPush: (id: string) => ipcRenderer.invoke("scm:push", id),
  scmDiff: (id: string, rel: string, staged: boolean, untracked: boolean) => ipcRenderer.invoke("scm:diff", id, rel, staged, untracked),
  filesDiff: (id: string, rel: string, scope: string, untracked: boolean) =>
    ipcRenderer.invoke("files:diff", id, rel, scope, untracked),
  usageGet: () => ipcRenderer.invoke("usage:get"),
  onUsageChanged: (cb: (u: unknown) => void) => {
    const h = (_e: unknown, u: unknown) => cb(u);
    ipcRenderer.on("usage:changed", h);
    return () => ipcRenderer.removeListener("usage:changed", h);
  },
  adoConfigGet: () => ipcRenderer.invoke("ado:config:get"),
  adoConfigSet: (patch: unknown) => ipcRenderer.invoke("ado:config:set", patch),
  mcpAdd: (name: string, command: string) => ipcRenderer.invoke("mcp:add", name, command),
  mcpRemove: (name: string) => ipcRenderer.invoke("mcp:remove", name),
  adoStates: (type: string) => ipcRenderer.invoke("ado:states", type),
  adoUpdate: (id: number, patch: unknown) => ipcRenderer.invoke("ado:update", id, patch),
  adoBoards: (fresh?: boolean) => ipcRenderer.invoke("ado:boards", fresh),
  adoMoveToColumn: (id: number, type: string, board: string, column: string) => ipcRenderer.invoke("ado:moveToColumn", id, type, board, column),
  adoComments: (id: number) => ipcRenderer.invoke("ado:comments", id),
  adoAddComment: (id: number, text: string) => ipcRenderer.invoke("ado:comment:add", id, text),
  openExternal: (url: string) => ipcRenderer.invoke("shell:open", url),
  pickPath: (opts?: { file?: boolean; defaultPath?: string }) => ipcRenderer.invoke("dialog:pick", opts),
  // real filesystem path for a dropped File (File.path is gone in modern Electron)
  getFilePath: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  // import from ~/.claude/projects (cmux, terminal, anywhere)
  listImportable: () => ipcRenderer.invoke("import:list"),

  // repos & worktrees
  listRepos: () => ipcRenderer.invoke("repos:list"),
  worktreeState: (wtPath: string) => ipcRenderer.invoke("worktree:state", wtPath),
  listWorktrees: () => ipcRenderer.invoke("worktrees:list"),
  removeWorktree: (repo: string, wtPath: string) => ipcRenderer.invoke("worktrees:remove", repo, wtPath),
  migrateWorktree: (repo: string, wtPath: string) => ipcRenderer.invoke("worktrees:migrate", repo, wtPath),
  worktreeCleanup: (repo: string, wtPath: string, mode: WorktreeCleanupMode) =>
    ipcRenderer.invoke("worktree:cleanup", repo, wtPath, mode),
  repoBranches: (repoPath: string) => ipcRenderer.invoke("repo:branches", repoPath),

  // CLAUDE.md
  readClaudeMd: (p: string) => ipcRenderer.invoke("claudemd:read", p),
  saveClaudeMd: (p: string, content: string) => ipcRenderer.invoke("claudemd:save", p, content),

  // hooks / settings / debriefs
  hooksInstalled: () => ipcRenderer.invoke("hooks:installed"),
  installHooks: () => ipcRenderer.invoke("hooks:install"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (s: unknown) => ipcRenderer.invoke("settings:set", s),
  runDebrief: (kind: string) => ipcRenderer.invoke("debrief:run", kind),

  // events from main
  onSessionData: (cb: (id: string, data: string) => void) => {
    const h = (_e: unknown, id: string, data: string) => cb(id, data);
    ipcRenderer.on("session:data", h);
    return () => ipcRenderer.removeListener("session:data", h);
  },
  onSessionsChanged: (cb: (sessions: unknown[]) => void) => {
    const h = (_e: unknown, s: unknown[]) => cb(s);
    ipcRenderer.on("sessions:changed", h);
    return () => ipcRenderer.removeListener("sessions:changed", h);
  },
  // tray/dock → renderer commands ("focus-session", "new-session")
  onUiCommand: (cb: (cmd: string, arg?: string) => void) => {
    const h = (_e: unknown, cmd: string, arg?: string) => cb(cmd, arg);
    ipcRenderer.on("ui:command", h);
    return () => ipcRenderer.removeListener("ui:command", h);
  },
};

contextBridge.exposeInMainWorld("mb", api);
export type MbApi = typeof api;
