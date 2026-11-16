import type { AgentTold, IpcResult, MissingFolder, PlanRequest, RelaunchChange, SessionInfo, StepStarted, TicketPipeline, UiCommand, WorktreeCleanupMode, WorktreeCleanupSay } from "../shared/types";
import type { LandscapeChange, LandscapePatch, LandscapeState } from "../shared/landscape";
import type { LayOutReply, LayOutRequest, TemplateBody, TemplateDraft, TemplateList } from "../shared/pipelineTemplates";
import type { Plan, PlanLaidOut, PlanShownAt, PlanView } from "../shared/plans";
import type { FinishOutcome, LatestMessage, SendReply, WireChange, WireReply, WireSettings, WireState, WireType, WireVerdict } from "../shared/wires";
import { ASSISTANT_IPC, type AssistantCard, type AssistantRule, type AssistantStep, type AssistantView, type AssistantWindowAction } from "../shared/assistant";
import { contextBridge, ipcRenderer, webUtils } from "electron";

const api = {
  // sessions
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  resumableSessions: () => ipcRenderer.invoke("sessions:resumable"),
  /** A closed session's saved output, its end only: what its ghost card's last line comes from. */
  closedOutput: (id: string): Promise<IpcResult<string>> => ipcRenderer.invoke("sessions:closedOutput", id),
  /** The closed sessions whose folders are gone: their ghosts offer to start fresh. */
  missingFolders: (): Promise<IpcResult<MissingFolder[]>> => ipcRenderer.invoke("sessions:missingFolders"),
  createSession: (req: unknown) => ipcRenderer.invoke("sessions:create", req),
  relaunchSession: (id: string) => ipcRenderer.invoke("sessions:relaunch", id),
  /** The steps not started yet (SessionManager.planned): drawn where their places are kept, never among the closed ones. */
  plannedSessions: (): Promise<IpcResult<SessionInfo[]>> => ipcRenderer.invoke("sessions:planned"),
  /** Add next step: a not-started step after `req.after`, joined to it by a handoff wire (WireService.addStep). */
  planSession: (req: PlanRequest): Promise<IpcResult<SessionInfo>> => ipcRenderer.invoke("sessions:plan", req),
  /** Start not-started step `id` now, from the commit the step before it is on (Start now). */
  startPlanned: (id: string): Promise<IpcResult<StepStarted>> => ipcRenderer.invoke("sessions:startPlanned", id),
  /** Where Start now would start not-started step `id`, said for its confirm; refused as the start would be. */
  describeStart: (id: string): Promise<IpcResult<string>> => ipcRenderer.invoke("sessions:describeStart", id),
  /** Pipeline templates (W9): the saved ones as this version reads them, each refused one with why. */
  templatesList: (): Promise<IpcResult<TemplateList>> => ipcRenderer.invoke("templates:list"),
  /** Save as template's draft of chain `ids` (first to last): what it keeps, redacted, and what it leaves out. */
  templatesDraft: (ids: string[]): Promise<IpcResult<TemplateDraft>> => ipcRenderer.invoke("templates:draft", ids),
  /** Save template `name`, refused while its text holds a secret-looking value or a home folder's path. */
  templatesSave: (name: string, body: TemplateBody): Promise<IpcResult<TemplateList>> => ipcRenderer.invoke("templates:save", name, body),
  /** Remove template `id`, one this version can't read too; the list as it is then. */
  templatesRemove: (id: string): Promise<IpcResult<TemplateList>> => ipcRenderer.invoke("templates:remove", id),
  /** Saved templates that aren't a list, set aside: a copy kept at `file`, and the list started empty. */
  templatesSetAside: (): Promise<IpcResult<{ file: string; list: TemplateList }>> => ipcRenderer.invoke("templates:setAside"),
  /** Lay out: the template as the picker shows it, as not-started steps and their wires (WireService.layOut). */
  templatesLayOut: (req: LayOutRequest): Promise<IpcResult<LayOutReply>> => ipcRenderer.invoke("templates:layOut", req),
  /** The Orchestrators' held plans (W17), each checked again on the sessions now: nothing of them exists until Lay out. */
  plansList: (): Promise<IpcResult<PlanView[]>> => ipcRenderer.invoke("plans:list"),
  /**
   * Lay out held plan `id` as the dialog shows it (`shown`, each gate as shown) in the area and room it showed (`at`):
   * main reads and checks it again, once per plan, and refuses it when its area or room is no longer that.
   */
  plansLayOut: (id: string, shown: Plan, at: PlanShownAt): Promise<IpcResult<PlanLaidOut>> => ipcRenderer.invoke("plans:layOut", id, shown, at),
  /** Dismiss held plan `id`, its Orchestrator told, with the note. */
  plansDismiss: (id: string, note: string): Promise<IpcResult<{ told: AgentTold }>> => ipcRenderer.invoke("plans:dismiss", id, note),
  /** The plan dialog opened on plan `id`, or closed (null): a plan proposed while it's open waits for it to close. */
  plansViewing: (id: string | null): Promise<IpcResult<void>> => ipcRenderer.invoke("plans:viewing", id),
  /** Resume exited session `id` (SessionManager.resume): `{ refused }` before anything is undone, `{ error }` for a relaunch that failed after its pty was let go. */
  resumeSession: (id: string): Promise<SessionInfo | { refused: string } | { error: string }> => ipcRenderer.invoke("sessions:resume", id),
  /** Make terminal `id`, which its agent quit into, that agent pane again (SessionManager.resumeAgent): answered as resumeSession is. */
  resumeAgent: (id: string): Promise<SessionInfo | { refused: string } | { error: string }> => ipcRenderer.invoke("sessions:resumeAgent", id),
  /** Open a terminal in pane `id`, whose agent quit in its room's sandbox (SessionManager.openTerminal): answered as resumeSession is. */
  openTerminal: (id: string): Promise<SessionInfo | { refused: string } | { error: string }> => ipcRenderer.invoke("sessions:openTerminal", id),
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
  suggestPrepare: () => ipcRenderer.invoke("suggest:prepare"),
  suggestPost: (draft: { title: string; body: string }) => ipcRenderer.invoke("suggest:post", draft),
  suggestList: (fresh?: boolean) => ipcRenderer.invoke("suggest:list", fresh === true),
  onUpdateProgress: (cb: (p: unknown) => void) => {
    const h = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on("update:progress", h);
    return () => ipcRenderer.removeListener("update:progress", h);
  },
  appVersion: () => ipcRenderer.invoke("app:version"),
  collabModels: () => ipcRenderer.invoke("collab:models"),
  collabList: () => ipcRenderer.invoke("collab:list"),
  /** Room files that couldn't be loaded: [{ file, error }]. */
  collabProblems: () => ipcRenderer.invoke("collab:problems"),
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
  collabTicketDrafts: (id: string) => ipcRenderer.invoke("collab:ticketDrafts", id),
  collabSaveTicketDrafts: (id: string, drafts: unknown) => ipcRenderer.invoke("collab:saveTicketDrafts", id, drafts),
  collabWholePlanTicket: (id: string) => ipcRenderer.invoke("collab:wholePlanTicket", id),
  collabSplitWithModel: (id: string, key: string) => ipcRenderer.invoke("collab:splitWithModel", id, key),
  collabTicketTargets: (id: string) => ipcRenderer.invoke("collab:ticketTargets", id),
  collabTicketConsent: (id: string, target: unknown, allow: boolean) => ipcRenderer.invoke("collab:ticketConsent", id, target, allow),
  collabCreateTickets: (id: string, target: unknown, drafts: unknown, track: boolean) => ipcRenderer.invoke("collab:createTickets", id, target, drafts, track),
  collabOpenTicket: (id: string, n: number) => ipcRenderer.invoke("collab:openTicket", id, n),
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
  /** A landscape card's diff badge: the session's worktree against `base` (its area repo's base; null: the repository's own). */
  branchStat: (id: string, base: string | null) => ipcRenderer.invoke("git:branchStat", id, base),
  /** A landscape card's "what it did": the first line of the session's agent's latest message. */
  lastReply: (id: string) => ipcRenderer.invoke("transcripts:lastReply", id),
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
  scmPush: (id: string, confirmBranch?: string) => ipcRenderer.invoke("scm:push", id, confirmBranch),
  scmDiff: (id: string, rel: string, staged: boolean, untracked: boolean) => ipcRenderer.invoke("scm:diff", id, rel, staged, untracked),
  filesDiff: (id: string, rel: string, scope: string, untracked: boolean) =>
    ipcRenderer.invoke("files:diff", id, rel, scope, untracked),
  usageGet: () => ipcRenderer.invoke("usage:get"),
  contextWindow: (sessionId: string) => ipcRenderer.invoke("usage:context", sessionId),
  contextCompact: (sessionId: string) => ipcRenderer.invoke("usage:compact", sessionId),
  resumeCost: (sessionId: string) => ipcRenderer.invoke("usage:resumeCost", sessionId),
  contextBrief: (sessionId: string) => ipcRenderer.invoke("usage:brief", sessionId),
  contextBriefStart: (sessionId: string, brief: string) => ipcRenderer.invoke("usage:briefStart", sessionId, brief),
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
  adoSetTags: (id: number, change: { add?: string[]; remove?: string[] }) => ipcRenderer.invoke("ado:setTags", id, change),
  adoProjectTags: () => ipcRenderer.invoke("ado:projectTags"),
  adoBoards: (fresh?: boolean) => ipcRenderer.invoke("ado:boards", fresh),
  adoMoveToColumn: (id: number, type: string, board: string, column: string) => ipcRenderer.invoke("ado:moveToColumn", id, type, board, column),
  adoReorder: (id: number, previousId: number, nextId: number) => ipcRenderer.invoke("ado:reorder", id, previousId, nextId),
  adoComments: (id: number) => ipcRenderer.invoke("ado:comments", id),
  adoAddComment: (id: number, text: string) => ipcRenderer.invoke("ado:comment:add", id, text),
  reviewStart: (sessionId: string) => ipcRenderer.invoke("review:start", sessionId),
  messagesList: () => ipcRenderer.invoke("messages:list"),
  messagesGroupMode: (group: string, mode: string | null) => ipcRenderer.invoke("messages:groupMode", group, mode),
  groupStatusCheck: (group: string) => ipcRenderer.invoke("group:statusCheck", group),
  onMessagesChanged: (cb: (m: unknown) => void) => {
    const h = (_e: unknown, m: unknown) => cb(m);
    ipcRenderer.on("messages:changed", h);
    return () => ipcRenderer.removeListener("messages:changed", h);
  },
  healthUpdates: () => ipcRenderer.invoke("health:updates"),
  onHealthUpdates: (cb: (n: unknown) => void) => {
    const h = (_e: unknown, n: unknown) => cb(n);
    ipcRenderer.on("health:updates", h);
    return () => ipcRenderer.removeListener("health:updates", h);
  },
  sessionRestart: (id: string) => ipcRenderer.invoke("sessions:restart", id),
  relaunchWith: (id: string, change: RelaunchChange): Promise<IpcResult<SessionInfo>> => ipcRenderer.invoke("sessions:relaunchWith", id, change),
  sessionMute: (id: string, muted: boolean) => ipcRenderer.invoke("sessions:mute", id, muted),
  overlapsGet: () => ipcRenderer.invoke("overlaps:get"),
  onOverlapsChanged: (cb: (o: unknown) => void) => {
    const h = (_e: unknown, o: unknown) => cb(o);
    ipcRenderer.on("overlaps:changed", h);
    return () => ipcRenderer.removeListener("overlaps:changed", h);
  },
  turnsList: (sessionId: string) => ipcRenderer.invoke("turns:list", sessionId),
  turnsChanges: (sessionId: string, n: number) => ipcRenderer.invoke("turns:changes", sessionId, n),
  turnsRestore: (sessionId: string, n: number) => ipcRenderer.invoke("turns:restore", sessionId, n),
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
  // stage 6's Approve, telling the agent that asked for the PR to dev to prepare the one to main; an agent's PR request dismissed
  pipelineApprove: (id: string): Promise<IpcResult<{ pipeline: TicketPipeline; told: AgentTold }>> => ipcRenderer.invoke("pipeline:approve", id),
  pipelineRequestDismiss: (id: string, requestId: string, note?: string): Promise<IpcResult<{ pipeline: TicketPipeline; told: AgentTold }>> =>
    ipcRenderer.invoke("pipeline:request:dismiss", id, requestId, note),
  // the merge watch (W16): read a ticket's pull request now (each it has that hasn't merged or closed, without `url`), or
  // mark one merged, the user's act its wires' gates then name
  pipelinePrCheck: (id: string, url?: string): Promise<IpcResult<TicketPipeline>> => ipcRenderer.invoke("pipeline:pr:check", id, url),
  pipelinePrMarkMerged: (id: string, url: string, asked: string): Promise<IpcResult<TicketPipeline>> => ipcRenderer.invoke("pipeline:pr:markMerged", id, url, asked),
  pipelinePrPreflight: (sessionId: string, ticketId: string, target: string) => ipcRenderer.invoke("pipeline:pr:preflight", sessionId, ticketId, target),
  pipelinePrDescribe: (sessionId: string, ticketId: string, title: string, base: string) => ipcRenderer.invoke("pipeline:pr:describe", sessionId, ticketId, title, base),
  pipelinePrCreate: (sessionId: string, ticketId: string, req: unknown) => ipcRenderer.invoke("pipeline:pr:create", sessionId, ticketId, req),
  pipelineComms: (ticketId: string, title: string, details: string) => ipcRenderer.invoke("pipeline:comms", ticketId, title, details),
  // the landscape: where workspaces and areas sit
  landscapeGet: (): Promise<IpcResult<LandscapeState>> => ipcRenderer.invoke("landscape:get"),
  landscapeUpdate: (patch: LandscapePatch): Promise<IpcResult<LandscapeState>> => ipcRenderer.invoke("landscape:update", patch),
  onLandscapeChanged: (cb: (change: LandscapeChange) => void) => {
    const h = (_e: unknown, change: LandscapeChange) => cb(change);
    ipcRenderer.on("landscape:changed", h);
    return () => ipcRenderer.removeListener("landscape:changed", h);
  },
  // wires: typed links between workspaces. A change answers { refused } when it wasn't made, saying why
  wiresGet: (): Promise<IpcResult<WireState>> => ipcRenderer.invoke("wires:get"),
  wiresAdd: (from: string, to: string, type: WireType, settings?: WireSettings): Promise<IpcResult<WireReply>> => ipcRenderer.invoke("wires:add", from, to, type, settings),
  wiresSet: (id: string, settings: WireSettings): Promise<IpcResult<WireReply>> => ipcRenderer.invoke("wires:set", id, settings),
  wiresRemove: (id: string): Promise<IpcResult<WireReply>> => ipcRenderer.invoke("wires:remove", id),
  wiresRestore: (id: string): Promise<IpcResult<WireReply>> => ipcRenderer.invoke("wires:restore", id),
  wiresRekey: (old: string, next: string): Promise<IpcResult<WireReply>> => ipcRenderer.invoke("wires:rekey", old, next),
  // "Add terminal on its tree": a terminal in the session's folder and group, wired to it by a shared worktree wire
  wiresAddTerminal: (sessionId: string): Promise<IpcResult<SessionInfo>> => ipcRenderer.invoke("wires:addTerminal", sessionId),
  // a person's Finish step: the summary as the popover shows it, from the session's latest message (wiresLastMessage)
  wiresFinish: (id: string, summary: string, verdict?: WireVerdict): Promise<IpcResult<FinishOutcome>> => ipcRenderer.invoke("wires:finish", id, summary, verdict),
  wiresLastMessage: (id: string): Promise<IpcResult<LatestMessage>> => ipcRenderer.invoke("wires:lastMessage", id),
  // a person's acts at a gate (wireDelivery.ts): Send what's waiting as shown, Send again or Mark sent what may have arrived, rounds.
  // A stopped other end is started only with { start: true }, once its cost is agreed (renderer/wireSend.ts).
  wiresSend: (id: string, pendingId: string, body: string, opts?: { start?: boolean }): Promise<IpcResult<SendReply>> => ipcRenderer.invoke("wires:send", id, pendingId, body, opts),
  wiresSendAgain: (id: string, pendingId: string, body: string, opts?: { start?: boolean }): Promise<IpcResult<SendReply>> => ipcRenderer.invoke("wires:sendAgain", id, pendingId, body, opts),
  wiresMarkSent: (id: string, pendingId: string): Promise<IpcResult<WireReply>> => ipcRenderer.invoke("wires:markSent", id, pendingId),
  wiresMoreRounds: (id: string): Promise<IpcResult<WireReply>> => ipcRenderer.invoke("wires:moreRounds", id),
  wiresResetRounds: (id: string): Promise<IpcResult<WireReply>> => ipcRenderer.invoke("wires:resetRounds", id),
  onWiresChanged: (cb: (change: WireChange) => void) => {
    const h = (_e: unknown, change: WireChange) => cb(change);
    ipcRenderer.on("wires:changed", h);
    return () => ipcRenderer.removeListener("wires:changed", h);
  },
  onPipelineChanged: (cb: (all: unknown) => void) => {
    const h = (_e: unknown, all: unknown) => cb(all);
    ipcRenderer.on("pipeline:changed", h);
    return () => ipcRenderer.removeListener("pipeline:changed", h);
  },
  /** A plan was held, replaced, laid out or dismissed: plansList says how they are now. */
  onPlansChanged: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on("plans:changed", h);
    return () => ipcRenderer.removeListener("plans:changed", h);
  },
  openExternal: (url: string) => ipcRenderer.invoke("shell:open", url),
  revealFile: (file: string) => ipcRenderer.invoke("shell:reveal", file),
  rollupWrite: (weeksAgo: number) => ipcRenderer.invoke("rollup:write", weeksAgo),
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
  worktreeCleanup: (repo: string, wtPath: string, mode: WorktreeCleanupMode, say?: WorktreeCleanupSay) =>
    ipcRenderer.invoke("worktree:cleanup", repo, wtPath, mode, say),
  repoBranches: (repoPath: string) => ipcRenderer.invoke("repo:branches", repoPath),

  // CLAUDE.md
  readClaudeMd: (p: string) => ipcRenderer.invoke("claudemd:read", p),
  saveClaudeMd: (p: string, content: string) => ipcRenderer.invoke("claudemd:save", p, content),

  // team rooms
  teamStatus: () => ipcRenderer.invoke("team:status"),
  /** Share a top-level group as a room (or a fresh invite when it already is one): { roomId, invite }. */
  teamShareGroup: (groupKey: string, title: string) => ipcRenderer.invoke("team:share", groupKey, title),
  teamCreateInvite: (roomId: string) => ipcRenderer.invoke("team:invite", roomId),
  teamJoin: (code: string) => ipcRenderer.invoke("team:join", code),
  teamCancelJoin: (roomId: string) => ipcRenderer.invoke("team:cancelJoin", roomId),
  /** Leave a room: teammates hear it, the Worker cuts this install off, and the room is deleted here (LeaveOutcome). */
  teamLeaveRoom: (roomId: string) => ipcRenderer.invoke("team:leaveRoom", roomId),
  /** Remove a teammate from a room (its admin only): RemoveOutcome. Again for someone removed: the Worker is asked again. */
  teamRemoveMember: (roomId: string, memberId: string) => ipcRenderer.invoke("team:removeMember", roomId, memberId),
  /** Accept or decline someone's request to join a room (its admin only): JoinAnswerOutcome. */
  teamAnswerJoin: (roomId: string, joinerId: string, accept: boolean) => ipcRenderer.invoke("team:answerJoin", roomId, joinerId, accept),
  /** Make a teammate an admin of a room, or take the role back (its owner only). */
  teamSetAdmin: (roomId: string, memberId: string, admin: boolean) => ipcRenderer.invoke("team:setAdmin", roomId, memberId, admin),
  /** Hand ownership of a room to a teammate (its owner only); you stay an admin. */
  teamHandOver: (roomId: string, memberId: string) => ipcRenderer.invoke("team:handOver", roomId, memberId),
  /** Claim ownership of a room whose owner hasn't been heard from for 14 days (its longest-standing admin only). */
  teamClaimOwnership: (roomId: string) => ipcRenderer.invoke("team:claimOwnership", roomId),
  /** Take back ownership a claim took from you. */
  teamContestClaim: (roomId: string) => ipcRenderer.invoke("team:contestClaim", roomId),
  teamDismissNotice: (id: string) => ipcRenderer.invoke("team:dismissNotice", id),
  teamCheckSignaling: (url: string) => ipcRenderer.invoke("team:checkSignaling", url),
  onTeamChanged: (cb: (status: unknown) => void) => {
    const h = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on("team:changed", h);
    return () => ipcRenderer.removeListener("team:changed", h);
  },
  // team rooms: the Radley House board
  houseGet: (roomId: string) => ipcRenderer.invoke("house:get", roomId),
  /** The board dialog opened (true) or closed: an open board keeps the House read. Answers the board (HouseView). */
  houseWatch: (roomId: string, open: boolean) => ipcRenderer.invoke("house:watch", roomId, open),
  houseRefresh: (roomId: string) => ipcRenderer.invoke("house:refresh", roomId),
  /** One ticket with its history (HouseTicketView). */
  houseTicket: (roomId: string, n: number) => ipcRenderer.invoke("house:ticket", roomId, n),
  /** A change (HouseWrite) made in the House as this member, or to the room's board. */
  houseWrite: (roomId: string, w: unknown) => ipcRenderer.invoke("house:write", roomId, w),
  /** Open the ticket in the House's web UI. */
  houseOpen: (roomId: string, n: number) => ipcRenderer.invoke("house:open", roomId, n),
  /** What Start session on ticket `n` would do (TicketSessionPlan): who has it, its branch, the clones to start in. */
  houseSessionPlan: (roomId: string, n: number) => ipcRenderer.invoke("house:sessionPlan", roomId, n),
  /** Claim the ticket, make its worktree and start an agent there briefed on it (TicketSessionRequest → TicketSessionResult). */
  houseStartSession: (roomId: string, req: unknown) => ipcRenderer.invoke("house:startSession", roomId, req),
  /** This member's answer to "use your builder token for this room's project?" (kept on this Mac). Answers the board. */
  houseConsent: (roomId: string, allow: boolean) => ipcRenderer.invoke("house:consent", roomId, allow),
  /** The rooms whose House project this member hasn't answered for (HouseConsentAsk[]). */
  housePendingConsents: () => ipcRenderer.invoke("house:pendingConsents"),
  onHouseConsent: (cb: (ask: unknown) => void) => {
    const h = (_e: unknown, a: unknown) => cb(a);
    ipcRenderer.on("house:consent", h);
    return () => ipcRenderer.removeListener("house:consent", h);
  },
  onHouseChanged: (cb: (view: unknown) => void) => {
    const h = (_e: unknown, v: unknown) => cb(v);
    ipcRenderer.on("house:changed", h);
    return () => ipcRenderer.removeListener("house:changed", h);
  },
  onHouseWarning: (cb: (notice: unknown) => void) => {
    const h = (_e: unknown, n: unknown) => cb(n);
    ipcRenderer.on("house:warning", h);
    return () => ipcRenderer.removeListener("house:warning", h);
  },
  // the app Assistant (docs/assistant.md)
  assistantView: (): Promise<IpcResult<AssistantView>> => ipcRenderer.invoke(ASSISTANT_IPC.view),
  assistantAsk: (text: string): Promise<IpcResult<{ turnId: string }>> => ipcRenderer.invoke(ASSISTANT_IPC.ask, text),
  assistantConfirm: (cardId: string): Promise<IpcResult<AssistantCard>> => ipcRenderer.invoke(ASSISTANT_IPC.confirm, cardId),
  assistantCancel: (cardId: string): Promise<IpcResult<AssistantCard>> => ipcRenderer.invoke(ASSISTANT_IPC.cancel, cardId),
  assistantUndo: (stepId: string): Promise<IpcResult<AssistantStep>> => ipcRenderer.invoke(ASSISTANT_IPC.undo, stepId),
  assistantRuleOn: (ruleId: string, on: boolean): Promise<IpcResult<AssistantRule>> => ipcRenderer.invoke(ASSISTANT_IPC.ruleOn, ruleId, on),
  assistantRuleRemove: (ruleId: string): Promise<IpcResult<{ ok: true }>> => ipcRenderer.invoke(ASSISTANT_IPC.ruleRemove, ruleId),
  assistantClear: (): Promise<IpcResult<{ ok: true }>> => ipcRenderer.invoke(ASSISTANT_IPC.clear),
  onAssistantChanged: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on(ASSISTANT_IPC.changed, h);
    return () => ipcRenderer.removeListener(ASSISTANT_IPC.changed, h);
  },
  onAssistantWindow: (cb: (action: AssistantWindowAction) => void) => {
    const h = (_e: unknown, action: AssistantWindowAction) => cb(action);
    ipcRenderer.on(ASSISTANT_IPC.window, h);
    return () => ipcRenderer.removeListener(ASSISTANT_IPC.window, h);
  },
  // team rooms: team chat
  teamChatView: (roomId: string) => ipcRenderer.invoke("teamChat:view", roomId),
  teamChatPost: (roomId: string, text: string) => ipcRenderer.invoke("teamChat:post", roomId, text),
  teamChatRead: (roomId: string) => ipcRenderer.invoke("teamChat:read", roomId),
  teamChatUnread: () => ipcRenderer.invoke("teamChat:unread"),
  /** The room the window shows (null: none): its mentions don't notify while the window has focus. */
  teamChatViewing: (roomIds: string[]) => ipcRenderer.invoke("teamChat:viewing", roomIds),
  onTeamChatChanged: (cb: (roomId: string) => void) => {
    const h = (_e: unknown, roomId: string) => cb(roomId);
    ipcRenderer.on("teamChat:changed", h);
    return () => ipcRenderer.removeListener("teamChat:changed", h);
  },
  /** A mention notification was clicked: show that room's chat. */
  onTeamChatOpen: (cb: (roomId: string) => void) => {
    const h = (_e: unknown, roomId: string) => cb(roomId);
    ipcRenderer.on("teamChat:open", h);
    return () => ipcRenderer.removeListener("teamChat:open", h);
  },

  // team rooms: take-over
  /** Room sessions' backups as this Mac knows them (TakeoverView). */
  teamTakeover: () => ipcRenderer.invoke("team:takeover"),
  /** What taking over a teammate's session would use (TakeoverPlan); `clonePath` when the user chose their clone. */
  teamTakeoverPlan: (roomId: string, sessionId: string, clonePath?: string | null) => ipcRenderer.invoke("team:takeoverPlan", roomId, sessionId, clonePath ?? null),
  teamTakeOver: (roomId: string, sessionId: string, clonePath?: string | null) => ipcRenderer.invoke("team:takeOver", roomId, sessionId, clonePath ?? null),
  /** Answer a teammate's request to continue one of this Mac's sessions. */
  teamTakeoverAnswer: (askId: string, answer: "handover" | "keep") => ipcRenderer.invoke("team:takeoverAnswer", askId, answer),
  /** Count again what a copy a teammate continued has that they lack. */
  teamTakeoverCheckLeft: (roomId: string, sessionId: string) => ipcRenderer.invoke("team:takeoverCheckLeft", roomId, sessionId),
  /** Send that copy's changes to whoever runs the session now. */
  teamTakeoverSendLeft: (roomId: string, sessionId: string) => ipcRenderer.invoke("team:takeoverSendLeft", roomId, sessionId),
  /** Changes a teammate sent: their patch, to review; applied to the session's worktree; forgotten. */
  teamTakeoverReceivedPatch: (roomId: string, id: string) => ipcRenderer.invoke("team:takeoverReceivedPatch", roomId, id),
  teamTakeoverApplyReceived: (roomId: string, id: string) => ipcRenderer.invoke("team:takeoverApplyReceived", roomId, id),
  teamTakeoverDismissReceived: (roomId: string, id: string) => ipcRenderer.invoke("team:takeoverDismissReceived", roomId, id),
  /** Turn a room's backups to origin on or off (its admin only; off by default: peer to peer). */
  teamSetBackupsToOrigin: (roomId: string, on: boolean) => ipcRenderer.invoke("team:setBackupsToOrigin", roomId, on),
  /** Whether this Mac runs room `roomId`'s sessions in the room's sandbox (Settings → Team); refused for a room this Mac isn't in. */
  teamSetRoomSandbox: (roomId: string, sandboxed: boolean) => ipcRenderer.invoke("team:setRoomSandbox", roomId, sandboxed),
  /** This member allows (or stops) backing up their own sessions in a room to origin, once its admin made that available. */
  teamSetBackupConsent: (roomId: string, allow: boolean) => ipcRenderer.invoke("team:setBackupConsent", roomId, allow),
  /** Allow take-overs of this member's sessions in a room while they're away (`sessions`: null for all), for `hours`; null stops. */
  onTeamTakeoverChanged: (cb: (view: unknown) => void) => {
    const h = (_e: unknown, v: unknown) => cb(v);
    ipcRenderer.on("team:takeoverChanged", h);
    return () => ipcRenderer.removeListener("team:takeoverChanged", h);
  },
  // team rooms: migration number reservations
  /** A room's live reservations, its migration folders and the admin's setting: MigrationsView. */
  teamChangesView: (roomId: string) => ipcRenderer.invoke("teamChanges:view", roomId),
  /** Hold back agents' unreserved new migrations in a room, or not (its admin only; on by default). */
  teamChangesSetCheck: (roomId: string, on: boolean) => ipcRenderer.invoke("teamChanges:setCheck", roomId, on),
  /** The admin's migration folders for a repository (origin key); none: back to detection. */
  teamChangesSetFolders: (roomId: string, key: string, folders: string[]) => ipcRenderer.invoke("teamChanges:setFolders", roomId, key, folders),
  onTeamChangesChanged: (cb: (view: unknown) => void) => {
    const h = (_e: unknown, v: unknown) => cb(v);
    ipcRenderer.on("teamChanges:changed", h);
    return () => ipcRenderer.removeListener("teamChanges:changed", h);
  },
  // team rooms: live panes
  /** Teammates' room sessions, tags for this install's own, and teammates' views: LivePanesState. */
  teamLive: () => ipcRenderer.invoke("team:live"),
  /** What this window shows and which pane it's in, for teammates' presence initials and Follow. */
  teamLiveView: (view: { shown: string[]; focused: string | null }) => ipcRenderer.invoke("team:liveView", view),
  /** Fetch a teammate's session's scrollback again and redraw its pane. */
  teamPaneResync: (id: string) => ipcRenderer.invoke("team:paneResync", id),
  /** Ask a teammate to let this Mac type into their session (its pane id here). */
  teamAskToType: (id: string) => ipcRenderer.invoke("team:askToType", id),
  /** Answer a teammate asking to type into one of this Mac's sessions, or take typing back. */
  teamDecideTyping: (sessionId: string, member: string, choice: "session" | "minutes" | "deny" | "revoke") => ipcRenderer.invoke("team:decideTyping", sessionId, member, choice),
  /** The audit log's last `n` entries, newest first: AuditEntry[]. */
  teamAuditRecent: (n: number) => ipcRenderer.invoke("team:auditRecent", n),
  // team rooms' and areas' artifacts (src/shared/team/artifacts.ts); every call answers { error } on failure.
  // `roomId` names the shelf: a room's id, or `area:<key>` for an area's on this Mac (src/shared/areaArtifacts.ts)
  artifactsList: (roomId: string) => ipcRenderer.invoke("artifacts:list", roomId),
  /** A file picker for files to add; null when cancelled. */
  artifactsPickFiles: () => ipcRenderer.invoke("artifacts:pickFiles"),
  artifactsAddFiles: (roomId: string, paths: string[], confirmSecret?: boolean) => ipcRenderer.invoke("artifacts:addFiles", roomId, paths, confirmSecret),
  /** A file without a path on disk (a pasted screenshot, a dropped image from a browser). */
  artifactsAddBytes: (roomId: string, name: string, bytes: Uint8Array, confirmSecret?: boolean) => ipcRenderer.invoke("artifacts:addBytes", roomId, name, bytes, confirmSecret),
  artifactsAddNote: (roomId: string, name: string, text: string, confirmSecret?: boolean) => ipcRenderer.invoke("artifacts:addNote", roomId, name, text, confirmSecret),
  artifactsAddRepo: (roomId: string, req: unknown) => ipcRenderer.invoke("artifacts:addRepo", roomId, req),
  artifactsAddLink: (roomId: string, url: string, title: string) => ipcRenderer.invoke("artifacts:addLink", roomId, url, title),
  artifactsRename: (roomId: string, id: string, name: string) => ipcRenderer.invoke("artifacts:rename", roomId, id, name),
  artifactsRemove: (roomId: string, id: string) => ipcRenderer.invoke("artifacts:remove", roomId, id),
  artifactsSaveNote: (roomId: string, id: string, text: string, base: string, mode: "save" | "overwrite" | "copy", confirmSecret?: boolean) => ipcRenderer.invoke("artifacts:saveNote", roomId, id, text, base, mode, confirmSecret),
  artifactsRead: (roomId: string, id: string) => ipcRenderer.invoke("artifacts:read", roomId, id),
  /** Fetch a file now (it jumps the queue), or retry one that failed. */
  artifactsDownload: (roomId: string, id: string) => ipcRenderer.invoke("artifacts:download", roomId, id),
  artifactsResolveRepo: (roomId: string, id: string, preferSessionId: string | null) => ipcRenderer.invoke("artifacts:resolveRepo", roomId, id, preferSessionId),
  /** Quick Look, Reveal in Finder and Save as act on paths main builds itself. */
  artifactsQuickLook: (roomId: string, id: string) => ipcRenderer.invoke("artifacts:quickLook", roomId, id),
  artifactsReveal: (roomId: string, id: string) => ipcRenderer.invoke("artifacts:reveal", roomId, id),
  artifactsSaveAs: (roomId: string, id: string) => ipcRenderer.invoke("artifacts:saveAs", roomId, id),
  artifactsDismissNotice: (roomId: string, noticeId: string) => ipcRenderer.invoke("artifacts:dismissNotice", roomId, noticeId),
  /** Copy area `key`'s artifacts on this Mac into room `roomId` (it was just shared as that room): { shared, refused }. */
  artifactsShareArea: (key: string, roomId: string) => ipcRenderer.invoke("artifacts:shareArea", key, roomId),
  onArtifactsChanged: (cb: (roomId: string) => void) => {
    const h = (_e: unknown, roomId: string) => cb(roomId);
    ipcRenderer.on("artifacts:changed", h);
    return () => ipcRenderer.removeListener("artifacts:changed", h);
  },
  onTeamLive: (cb: (state: unknown) => void) => {
    const h = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on("team:liveChanged", h);
    return () => ipcRenderer.removeListener("team:liveChanged", h);
  },

  // hooks / settings / debriefs
  hooksInstalled: () => ipcRenderer.invoke("hooks:installed"),
  installHooks: () => ipcRenderer.invoke("hooks:install"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (s: unknown) => ipcRenderer.invoke("settings:set", s),
  runDebrief: (kind: string) => ipcRenderer.invoke("debrief:run", kind),

  // phone alerts (src/shared/phoneAlerts.ts); every call answers { error } on failure
  /** Away, the last alert sent, whether replies can be read: PhoneStatus. */
  phoneStatus: () => ipcRenderer.invoke("phone:status"),
  /** Send one test iMessage now (a development build only logs it). */
  phoneTest: () => ipcRenderer.invoke("phone:test"),
  /** Check again whether Messages can be read (after granting Full Disk Access). */
  phoneCheckReplies: () => ipcRenderer.invoke("phone:checkReplies"),
  phoneOpenPrivacy: (which: "automation" | "fullDiskAccess") => ipcRenderer.invoke("phone:openPrivacy", which),
  clearPhoneNote: (id: string) => ipcRenderer.invoke("sessions:clearPhoneNote", id),
  onPhoneChanged: (cb: (s: unknown) => void) => {
    const h = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on("phone:changed", h);
    return () => ipcRenderer.removeListener("phone:changed", h);
  },

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
  // tray, Dock and notifications → the window (UI_COMMANDS)
  onUiCommand: (cb: (cmd: UiCommand, arg?: string) => void) => {
    const h = (_e: unknown, cmd: UiCommand, arg?: string) => cb(cmd, arg);
    ipcRenderer.on("ui:command", h);
    return () => ipcRenderer.removeListener("ui:command", h);
  },
};

contextBridge.exposeInMainWorld("mb", api);
export type MbApi = typeof api;
