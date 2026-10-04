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
  modelCatalog: () => ipcRenderer.invoke("models:catalog"),
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
  filesWrite: (id: string, rel: string, content: string, expectedMtimeMs: number | null) => ipcRenderer.invoke("files:write", id, rel, content, expectedMtimeMs),
  filesChanges: (id: string, scope: string) => ipcRenderer.invoke("files:changes", id, scope),
  filesAll: (id: string) => ipcRenderer.invoke("files:all", id),
  watchFolders: (ids: string[]) => ipcRenderer.invoke("folders:watch", ids),
  runProfile: (id: string) => ipcRenderer.invoke("run:profile", id),
  runSaveProfile: (id: string, profile: unknown) => ipcRenderer.invoke("run:saveProfile", id, profile),
  runDraft: (id: string) => ipcRenderer.invoke("run:draft", id),
  runStart: (id: string, opts: { mode: "swap" | "side"; services?: string[]; debug?: string[] }) => ipcRenderer.invoke("run:start", id, opts),
  runStopListeners: (id: string, pids: number[]) => ipcRenderer.invoke("run:stopListeners", id, pids),
  runStop: (id: string, services?: string[]) => ipcRenderer.invoke("run:stop", id, services),
  runPrepare: (id: string) => ipcRenderer.invoke("run:prepare", id),
  runStates: () => ipcRenderer.invoke("run:states"),
  metersGet: () => ipcRenderer.invoke("meters:get"),
  onMetersChanged: (cb: (m: unknown) => void) => {
    const h = (_e: unknown, m: unknown) => cb(m);
    ipcRenderer.on("meters:changed", h);
    return () => ipcRenderer.removeListener("meters:changed", h);
  },
  runBuffer: (runId: string) => ipcRenderer.invoke("run:buffer", runId),
  runClear: (runId: string) => ipcRenderer.invoke("run:clear", runId),
  runStopById: (runId: string) => ipcRenderer.invoke("run:stopById", runId),
  onRunProgress: (cb: (worktree: string, msg: string) => void) => {
    const h = (_e: unknown, w: string, m: string) => cb(w, m);
    ipcRenderer.on("run:progress", h);
    return () => ipcRenderer.removeListener("run:progress", h);
  },
  debugBreakpoints: (id: string) => ipcRenderer.invoke("debug:breakpoints", id),
  debugSetBreakpoints: (id: string, rel: string, lines: number[]) => ipcRenderer.invoke("debug:setBreakpoints", id, rel, lines),
  debugSessions: () => ipcRenderer.invoke("debug:sessions"),
  debugControl: (sid: string, op: string, threadId?: number) => ipcRenderer.invoke("debug:control", sid, op, threadId),
  debugStack: (sid: string, threadId: number) => ipcRenderer.invoke("debug:stack", sid, threadId),
  debugScopes: (sid: string, frameId: number) => ipcRenderer.invoke("debug:scopes", sid, frameId),
  debugVariables: (sid: string, ref: number) => ipcRenderer.invoke("debug:variables", sid, ref),
  debugEvaluate: (sid: string, expr: string, frameId: number | undefined, context: string) => ipcRenderer.invoke("debug:evaluate", sid, expr, frameId, context),
  debugStop: (sid: string) => ipcRenderer.invoke("debug:stop", sid),
  debugPrune: () => ipcRenderer.invoke("debug:prune"),
  onDebugChanged: (cb: (sessions: unknown) => void) => {
    const h = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on("debug:changed", h);
    return () => ipcRenderer.removeListener("debug:changed", h);
  },
  onDebugOutput: (cb: (sid: string, category: string, text: string) => void) => {
    const h = (_e: unknown, sid: string, c: string, t: string) => cb(sid, c, t);
    ipcRenderer.on("debug:output", h);
    return () => ipcRenderer.removeListener("debug:output", h);
  },
  onDebugStopped: (cb: (sid: string, at: unknown) => void) => {
    const h = (_e: unknown, sid: string, at: unknown) => cb(sid, at);
    ipcRenderer.on("debug:stopped", h);
    return () => ipcRenderer.removeListener("debug:stopped", h);
  },
  onBreakpointsChanged: (cb: (repo: string) => void) => {
    const h = (_e: unknown, r: string) => cb(r);
    ipcRenderer.on("debug:breakpointsChanged", h);
    return () => ipcRenderer.removeListener("debug:breakpointsChanged", h);
  },
  runWrite: (runId: string, data: string) => ipcRenderer.send("run:write", runId, data),
  runResize: (runId: string, cols: number, rows: number) => ipcRenderer.send("run:resize", runId, cols, rows),
  onRunChanged: (cb: (states: unknown) => void) => {
    const h = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on("run:changed", h);
    return () => ipcRenderer.removeListener("run:changed", h);
  },
  onRunData: (cb: (id: string, data: string) => void) => {
    const h = (_e: unknown, id: string, d: string) => cb(id, d);
    ipcRenderer.on("run:data", h);
    return () => ipcRenderer.removeListener("run:data", h);
  },
  onFolderChanged: (cb: (root: string) => void) => {
    const h = (_e: unknown, root: string) => cb(root);
    ipcRenderer.on("folder:changed", h);
    return () => ipcRenderer.removeListener("folder:changed", h);
  },
  filesSearch: (id: string, query: string, opts: { regex: boolean; matchCase: boolean }) => ipcRenderer.invoke("files:search", id, query, opts),
  scmStatus: (id: string) => ipcRenderer.invoke("scm:status", id),
  scmCommitMessage: (id: string) => ipcRenderer.invoke("scm:commitMessage", id),
  scmPull: (id: string) => ipcRenderer.invoke("scm:pull", id),
  scmFetch: (id: string) => ipcRenderer.invoke("scm:fetch", id),
  scmGraph: (id: string, limit: number) => ipcRenderer.invoke("scm:graph", id, limit),
  scmCommitFiles: (id: string, sha: string) => ipcRenderer.invoke("scm:commitFiles", id, sha),
  scmCommitDiff: (id: string, sha: string, rel: string) => ipcRenderer.invoke("scm:commitDiff", id, sha, rel),
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
  handoffDraft: (sessionId: string) => ipcRenderer.invoke("handoff:draft", sessionId),
  handoffStart: (sessionId: string, handoff: string) => ipcRenderer.invoke("handoff:start", sessionId, handoff),
  presetStart: (id: string) => ipcRenderer.invoke("presets:start", id),
  prStatus: (cwd: string, fresh?: boolean) => ipcRenderer.invoke("pr:status", cwd, fresh),
  lspOpen: (id: string, rel: string, text: string) => ipcRenderer.invoke("lsp:open", id, rel, text),
  lspInstall: (server: string) => ipcRenderer.invoke("lsp:install", server),
  lspChange: (id: string, rel: string, text: string) => ipcRenderer.invoke("lsp:change", id, rel, text),
  lspSaved: (id: string, rel: string) => ipcRenderer.invoke("lsp:saved", id, rel),
  lspClose: (id: string, rel: string) => ipcRenderer.invoke("lsp:close", id, rel),
  lspHover: (id: string, rel: string, line: number, ch: number) => ipcRenderer.invoke("lsp:hover", id, rel, line, ch),
  lspComplete: (id: string, rel: string, line: number, ch: number, prefix: string, trigger?: string) => ipcRenderer.invoke("lsp:complete", id, rel, line, ch, prefix, trigger),
  lspDefinition: (id: string, rel: string, line: number, ch: number) => ipcRenderer.invoke("lsp:definition", id, rel, line, ch),
  lspRename: (id: string, rel: string, line: number, ch: number, name: string) => ipcRenderer.invoke("lsp:rename", id, rel, line, ch, name),
  lspFormat: (id: string, rel: string, tabSize: number, insertSpaces: boolean) => ipcRenderer.invoke("lsp:format", id, rel, tabSize, insertSpaces),
  lspApplyEdits: (id: string, rel: string, edits: unknown) => ipcRenderer.invoke("lsp:applyEdits", id, rel, edits),
  onLspDiagnostics: (cb: (file: string, d: unknown) => void) => {
    const h = (_e: unknown, file: string, d: unknown) => cb(file, d);
    ipcRenderer.on("lsp:diagnostics", h);
    return () => ipcRenderer.removeListener("lsp:diagnostics", h);
  },
  onLspStatus: (cb: (s: unknown) => void) => {
    const h = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on("lsp:status", h);
    return () => ipcRenderer.removeListener("lsp:status", h);
  },
  pipelineAll: () => ipcRenderer.invoke("pipeline:all"),
  pipelineStage: (id: string, stage: string, title?: string) => ipcRenderer.invoke("pipeline:stage", id, stage, title),
  pipelineFeedback: (id: string, text: string) => ipcRenderer.invoke("pipeline:feedback", id, text),
  pipelineCheck: (id: string, key: string, value: boolean) => ipcRenderer.invoke("pipeline:check", id, key, value),
  pipelineDraftAdd: (id: string, stage: string, text: string) => ipcRenderer.invoke("pipeline:draft:add", id, stage, text),
  pipelineDraftEdit: (id: string, draftId: string, text: string) => ipcRenderer.invoke("pipeline:draft:edit", id, draftId, text),
  pipelineDraftDrop: (id: string, draftId: string) => ipcRenderer.invoke("pipeline:draft:drop", id, draftId),
  pipelineDraftPost: (id: string, draftId: string) => ipcRenderer.invoke("pipeline:draft:post", id, draftId),
  pipelinePrPreflight: (sessionId: string, ticketId: string, target: string) => ipcRenderer.invoke("pipeline:pr:preflight", sessionId, ticketId, target),
  pipelinePrDescribe: (sessionId: string, ticketId: string, title: string, base: string) => ipcRenderer.invoke("pipeline:pr:describe", sessionId, ticketId, title, base),
  pipelinePrCreate: (sessionId: string, ticketId: string, req: unknown) => ipcRenderer.invoke("pipeline:pr:create", sessionId, ticketId, req),
  pipelineComms: (ticketId: string, title: string, details: string) => ipcRenderer.invoke("pipeline:comms", ticketId, title, details),
  onPipelineChanged: (cb: (all: unknown) => void) => {
    const h = (_e: unknown, all: unknown) => cb(all);
    ipcRenderer.on("pipeline:changed", h);
    return () => ipcRenderer.removeListener("pipeline:changed", h);
  },
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
