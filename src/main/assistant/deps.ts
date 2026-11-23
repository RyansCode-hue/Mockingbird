import type { AssistantWindowAction } from "../../shared/assistant";
import type { Landscape, LandscapePatch } from "../../shared/landscape";
import type { PermissionMode } from "../../shared/permissionModes";
import type { RulesApi } from "./rules";
import type { TakeoverPlan } from "../../shared/team/takeover";
import type { AgentKind, SessionInfo, SessionStatus } from "../../shared/types";
import type { GateState, WireGate, WireSettings, WireType, WireWhen } from "../../shared/wires";
import type { GuardOp } from "../sessionGuards";

/**
 * What the Assistant's tools reach the app through (index.ts makes it; tests fake it). Each group takes the part it
 * uses (Pick<AssistantDeps, …>). It carries state and actions; a session's output only through `output` and
 * `mirroredOutput`, its folder only through `folders` (sessionFiles.ts: read only, inside the folder, secrets refused),
 * and never the environment or secrets: no tool can read what isn't here.
 */

/** A session as the Assistant sees it: its state, never its output. */
export interface AssistantSession {
  id: string;
  /** Its title as the landscape shows it (its ticket's title when it has one). */
  title: string;
  agent: AgentKind | "terminal";
  status: SessionStatus;
  /** Why it waits on the user (its agent's notice), and since when (ms); null when it doesn't. */
  waitingReason: string | null;
  waitingSince: number | null;
  /** Its group's key ("atticus", "5038/api"); null when it's in none. */
  group: string | null;
  /** The team room its group is shared as, by name; null outside one. */
  room: string | null;
  /** Its repository's folder name. */
  repo: string | null;
  branch: string | null;
  model: string | null;
  /**
   * The mode it runs in, as every wider-mode warning and refusal goes by it: the wider of the one Mockingbird launched
   * it in and the one its agent last reported in a hook (a mode switched in the pane, or its own settings' default).
   */
  permissionMode: PermissionMode;
  /** This Mac's own; false for a teammate's room session, whose owner `owner` names. */
  mine: boolean;
  owner?: string;
  /** The Helpdesk tasks workspace: its status and lifecycle are the Assistant's to act on, its conversation never. */
  helpdesk: boolean;
}

/** A top-level group, as the landscape and the sessions have it. */
export interface AssistantGroup {
  key: string;
  /** Its sub-groups' keys ("5038/api"): each a stack of workspaces. */
  stacks: string[];
  /** This Mac's running sessions in it, its stacks' included. */
  sessions: number;
  /** The team room it's shared as, by name; null when it isn't. */
  room: string | null;
  /** It has an area on the landscape. */
  area: boolean;
  /** This Mac's steps in it not started yet (drawn as ghosts, each waiting for its handoff); left out when none. */
  notStarted?: number;
  /** This Mac's closed sessions in it that can be reopened (drawn as ghosts where they were); left out when none. */
  closed?: number;
}

/** A team room this install is in. */
export interface AssistantRoom {
  id: string;
  name: string;
  /** The local group it's shown as. */
  group: string;
  /** Its members' names, this install's own first. */
  members: string[];
  /** How many teammates are connected now. */
  online: number;
}

/** What every tool group shares: the world as the Assistant sees it, and its first tools' deps. */
export interface AssistantCoreDeps {
  /** Every session the landscape shows: this Mac's running ones, and teammates' room sessions. */
  sessions(): AssistantSession[];
  groups(): AssistantGroup[];
  rooms(): AssistantRoom[];
  /** A step only the window can take (`assistant:window`). */
  toWindow(action: AssistantWindowAction): void;
  /** Rename this Mac's session `id`, as the window's Rename does. Throws why not. */
  rename(id: string, title: string): void;
  /**
   * Why this Mac's session `id` can't be restarted now (a teammate continues it, it's being resumed…), or null when it
   * can. The session guards' answer for a relaunch (sessionGuards.ts whyNot).
   */
  relaunchRefusal(id: string): string | null;
  /** Restart session `id` in place: its agent stopped and started again on the same conversation. Throws why not. */
  relaunch(id: string): Promise<void>;

}

export interface AssistantRuleDeps {
  // ---- standing rules (rules.ts, ruleEngine.ts, tools/rules.ts) ----
  /** The standing rules, as the rule tools list, make, change, switch and remove them. */
  rules: RulesApi;
}

export interface AssistantWorkDeps {
  // ---- sessions, start work, triage, git and diagnose (tools/sessions.ts, start.ts, triage.ts, git.ts, diagnose.ts) ----
  /** Main's checks on what may be done to a session on someone's behalf: whyNot, closeWarnings, answerPrompt. */
  guards: Pick<import("../sessionGuards").SessionGuards, "whyNot" | "closeWarnings" | "answerPrompt">;
  /** Why `call` can't be done from session `id` because a teammate took this copy over (takenOverGuard.ts), or null. */
  takenOver(id: string, call: import("../takenOverGuard").UntakenCall): string | null;
  /** This Mac's session `id` as main keeps it, and whether it's open here (a pane, exited or not) or closed; null for neither. */
  record(id: string): { info: import("../../shared/types").SessionInfo; open: boolean } | null;
  /** What relaunchWith(id, change) would meet now (SessionManager.describeRelaunch). */
  describeRelaunch(id: string, change: import("../../shared/types").RelaunchChange): { blocked: string | null; warnings: string[] };
  /** Restart session `id` with `change` (sessions:relaunchWith). Throws why not. */
  relaunchWith(id: string, change: import("../../shared/types").RelaunchChange): Promise<void>;
  /** Close session `id`, kept to reopen (sessions:kill, not forgotten). Throws why not. */
  close(id: string): void;
  /** Resume exited pane `id` (sessions:resume). Throws why not. */
  resume(id: string): Promise<void>;
  /** Reopen closed session `id` (sessions:relaunch). Throws why not. */
  reopen(id: string): Promise<void>;
  /** A fresh session of the same agent from a brief of session `id`'s conversation (usage:brief, then usage:briefStart). Throws why not. */
  briefStart(id: string): Promise<import("../../shared/types").SessionInfo>;
  /** A session of the other agent from a handoff its agent writes from session `id`'s conversation (handoff:draft, then handoff:start). */
  handoffStart(id: string): Promise<import("../../shared/types").SessionInfo>;
  /** The presets New session offers: the built-in Helpdesk one first, then the user's. */
  presets(): import("../../shared/types").SessionPreset[];
  /** Start preset `id` (presets:start). */
  startPreset(id: string): Promise<import("../../shared/types").SessionInfo>;
  /** The templates the picker offers (the built-in one first), and why any saved one can't be read. */
  templates(): { templates: import("../../shared/pipelineTemplates").PipelineTemplate[]; refused: string[] };
  /** Lay template `req` out (templates:layOut). */
  layOut(req: import("../../shared/pipelineTemplates").LayOutRequest): Promise<import("../../shared/pipelineTemplates").LayOutReply>;
  /** The repositories this Mac knows (the repo index of Settings → General's folders). */
  repos(): import("../../shared/types").RepoEntry[];
  /** New session's start (sessions:create). */
  createSession(req: import("../../shared/types").NewSessionRequest): Promise<import("../../shared/types").SessionInfo>;
  /**
   * Each team room's House board, as its cache has it (house:get): nothing is fetched or written. A room whose board
   * couldn't be read is there too, with why, so a listing says so rather than leaving it out.
   */
  houseBoards(): (import("../../shared/team/house").HouseView | HouseBoardUnread)[];
  /** The Azure DevOps work items the Dashboard lists (ado:list): read only. */
  adoItems(): Promise<{ items: import("../../shared/types").AdoWorkItem[]; total: number; me: string }>;
  /** What starting a session from House ticket `n` of room `roomId` would do (house:sessionPlan). */
  ticketPlan(roomId: string, n: number): Promise<import("../../shared/team/ticketSession").TicketSessionPlan>;
  /** Claim House ticket `req.n`, make its worktree and start an agent there (house:startSession). */
  startTicket(roomId: string, req: import("../../shared/team/ticketSession").TicketSessionRequest): Promise<import("../../shared/team/ticketSession").TicketSessionResult>;
  /** The other agent reviewing session `id`'s branch, in its folder (review:start). */
  startReview(id: string): Promise<import("../../shared/types").SessionInfo>;
  /** Type `text` into each of `ids` as the window's broadcast box does, queued while busy; the Helpdesk workspace always skipped. */
  broadcast(text: string, ids: string[]): import("../../shared/types").BroadcastOutcome[];
  /** The first line of session `id`'s agent's latest message (transcripts:lastReply). */
  lastReply(id: string): Promise<import("../../shared/types").LastReply>;
  /** Folder `folder`'s git state (worktree:state). Throws why it can't be read. */
  worktreeState(folder: string): Promise<import("../../shared/types").WorktreeStateInfo>;
  /** Every worktree under the known repositories' worktree folders (worktrees:list). */
  worktrees(): Promise<import("../../shared/types").WorktreeEntry[]>;
  /** Remove worktree folder `folder` of `repo`, its branch kept (worktrees:remove): refused while a session runs in it. */
  removeWorktree(repo: string, folder: string): Promise<void>;
  /** Session `id`'s branch against its base (git:branchStat). */
  branchStat(id: string): Promise<import("../../shared/types").BranchStat>;
  /** Session `id`'s branch's pull request (pr:status). */
  prStatus(id: string): Promise<import("../../shared/types").PrStatus>;
  /** Why a push from session `id` would wait for the user to name its branch (a team room session's on a base's name, or not its own), or null; and the branch. */
  pushAsk(id: string): Promise<{ branch: string | null; why: string | null }>;
  /** Push session `id`'s branch `branch` (scm:push), never forced: refused when it's moved off `branch`. */
  push(id: string, branch: string): Promise<{ upstream: string }>;
  /** What opening a pull request from session `id` for ticket `ticketId` into `target` would meet (pipeline:pr:preflight). */
  prPreflight(id: string, ticketId: string, target: import("../../shared/types").PrTarget): Promise<import("../../shared/types").PrPreflight>;
  /** Push session `id`'s branch and open its pull request for ticket `ticketId` (pipeline:pr:create); its url. */
  openPr(id: string, ticketId: string, req: { target: import("../../shared/types").PrTarget; base: string; title: string; description: string; ticketTitle: string | null }): Promise<{ url: string }>;
  /**
   * What this Mac's session `id` has shown: a pane's buffer, running or exited, or a closed one's saved output (raw
   * terminal text). Its readers (session_detail, session_output, an allow/deny card) ask guards.whyNot("readOutput") first.
   */
  output(id: string): string;
  /** Plan usage, as each agent last reported it (usage:get). */
  usage(): import("../../shared/types").UsageReport;
  /** The token meters (meters:get). Throws when the conversation index isn't available. */
  meters(): import("../../shared/types").Meters;
  /** Files each session's worktree changes that another's does too (overlaps:get). */
  overlaps(): import("../../shared/types").OverlapReport;
  /** The files session `id`'s worktree changed since its first turn's snapshot (`since: "first"`) or its latest (turns:changes). */
  turnFiles(id: string, since: "first" | "last"): Promise<string[]>;
  /** Every Claude and Codex conversation on this Mac matching `q`, each tied to the session that runs it (transcripts:search). */
  searchTranscripts(q: string): import("../../shared/types").TranscriptHit[];
}

export interface AssistantLayoutDeps {
  // ---- layout, groups, wires, rooms and settings (tools/layout.ts, wires.ts, rooms.ts, settings.ts) -------------

  /** Why `op` can't be done to session `id` now, or null when it can (sessionGuards.ts whyNot). */
  guard(op: GuardOp, id: string): string | null;
  /** landscape.json as main holds it (LandscapeStore.get): the layout, its revision, and what stops it being saved. */
  landscapeState(): { landscape: Landscape; rev: number; problem: string | null };
  /**
   * What the landscape lays out, as the window gives resolveLayout: the sessions shown (this Mac's, debriefs left out,
   * then teammates' room sessions), the closed ones and the steps not started (drawn as ghosts), and every session
   * there is (withoutGone's `known`).
   */
  layoutSessions(): { shown: SessionInfo[]; closed: SessionInfo[]; known: SessionInfo[] };
  /** Save `patch` to landscape.json (landscape:update): the revision it made. Throws why not. */
  patchLandscape(patch: LandscapePatch): number;
  /** Put session `id` in `group` (null: in none), as sessions:setGroup does. Throws why not. */
  setGroup(id: string, group: string | null): void;
  /** Rename group `from` to `to`, as sessions:renameGroup does: its area, room and artifacts follow. Throws why not. */
  renameGroup(from: string, to: string): void;
  /** Mute or unmute session `id`'s notifications, as sessions:mute does. Throws why not. */
  setMuted(id: string, muted: boolean): void;
  /** Whether session `id` is muted now; null when it isn't open here. */
  muted(id: string): boolean | null;

  /** The wire book as the Assistant reads it (wiresSeen): ends, types, gates; never what a wire carries. Throws when it can't be read. */
  wireList(): AssistantWire[];
  /** Why a wire `type` from `from` to `to` can't be made now (wireRefusal, and whether the book can be saved), or null. */
  wireAddRefusal(from: string, to: string, type: WireType): string | null;
  /** Make a wire, as wires:add does: its id. Throws why not. */
  addWire(from: string, to: string, type: WireType): string;
  /** Remove wire `id`, as wires:remove does. Throws why not. */
  removeWire(id: string): void;
  /** Put removed wire `id` back, as wires:restore does. Throws why not. */
  restoreWire(id: string): void;
  /** Whether wire `id` was removed and is still held to be restored. */
  wireRestorable(id: string): boolean;
  /**
   * Send what waits at wire `id`'s gate (its pending `pendingId`, as it was readied), as a person's Send does
   * (wires:send). A stopped other end isn't started. Resolves to a note to pass on, or null; throws why not.
   */
  sendWaiting(id: string, pendingId: string): Promise<string | null>;
  /** Ticket `id`'s place in the ticket pipeline, or null when it isn't tracked. */
  ticketStage(id: string): { stage: string; title: string | null } | null;
  /** Approve ticket `id` in stakeholder testing, as pipeline:approve does: what its agent was told. Throws why not. */
  approveTicket(id: string): Promise<string>;

  /** Room `roomId`'s House board in plain text (HouseService.boardSummary); null when the room has no House project. */
  houseBoard(roomId: string): Promise<string | null>;
  /** Why group `group` can't be shared as a team room (team:share's own checks: a named group, no Helpdesk in it), or null. */
  shareRefusal(group: string): string | null;
  /** Share group `group` as a team room, as team:share does (its checks included). Never the invite code. Throws why not. */
  shareGroup(group: string, title: string): Promise<{ roomId: string; created: boolean; warning?: string }>;
  /** Leave room `roomId`, as team:leaveRoom does: who was told, in a line. Throws why not. */
  leaveRoom(roomId: string): Promise<string>;
  /** The room, the owner's id for it and the title of teammate's room session `id` (a live pane), or null. */
  takeoverTarget(id: string): { roomId: string; sessionId: string; title: string; owner: string } | null;
  /** What taking it over would use (team:takeoverPlan). Throws why it can't be planned. */
  takeoverPlan(roomId: string, sessionId: string): Promise<TakeoverPlan>;
  /** Take it over (team:takeOver): the new session's id. Throws why not. */
  takeOver(roomId: string, sessionId: string): Promise<string>;
  /** Whether room `roomId`'s sessions run in its sandbox on this Mac; null when this Mac isn't in it. */
  roomSandboxed(roomId: string): boolean | null;
  /** Switch room `roomId`'s sandbox on this Mac, as team:setRoomSandbox does. Throws why not. */
  setRoomSandbox(roomId: string, on: boolean): void;
  /** Claim or release a House ticket in room `roomId`, as the board's house:write does: what the House said. Throws why not. */
  houseWrite(roomId: string, w: { kind: "claim"; n: number; branch: string } | { kind: "release"; n: number }): Promise<string>;

  /**
   * Settings as main keeps them. The settings tools show and change only what their table (tools/settings.ts
   * SETTINGS_TABLE) allows of them: never a credentials path or the phone handle.
   */
  settings(): import("../../shared/types").Settings;
  /** Change settings through settings:set's path (changeSettings), every part that reads them told. Throws why not. */
  changeSettings(patch: Partial<import("../../shared/types").Settings>): void;
}

export interface AssistantFileDeps {
  // ---- reading sessions' output and folders (tools/diagnose.ts session_output, tools/files.ts) ----
  /**
   * What this Mac holds of teammate's room session `id`'s output: the copy its open terminal mirrors (livePanes), or
   * null when no terminal here has it. Nothing is fetched from the teammate.
   */
  mirroredOutput(id: string): string | null;
  /** Sessions' folders, read only and confined to them (sessionFiles.ts FolderReader). */
  folders: Pick<import("./sessionFiles").FolderReader, "list" | "read" | "diff">;
}

export interface AssistantPipelineDeps {
  // ---- pipelines: their not-started steps, editing them, and the Orchestrator's held plans (tools/pipeline.ts) ----
  /** This Mac's steps not started yet (SessionManager.planned), each waiting for its handoff or Start now. */
  plannedSteps(): SessionInfo[];
  /** This Mac's closed sessions that can be reopened (SessionManager.resumable). */
  closedSessions(): SessionInfo[];
  /** The models and efforts this Mac's agents offer (models:catalog); null when they can't be read. */
  modelCatalog(): Promise<import("../../shared/types").ModelCatalog | null>;
  /** Edit not-started step `id`'s spec, as its Edit… does (steps:edit, PipelineEdits.editStep). Throws why not. */
  editStep(id: string, edit: import("../../shared/types").StepEdit): Promise<SessionInfo>;
  /** Insert a not-started step after, ahead of or between sessions (steps:insert, PipelineEdits.insertStep). Throws why not. */
  insertStep(req: import("../../shared/types").InsertStepRequest): Promise<import("../../shared/types").StepInserted>;
  /** Session `id`'s model and effort wherever it is (sessions:setModel, PipelineEdits.setModel): an open one restarts in place. Throws why not. */
  setModel(id: string, change: import("../../shared/types").ModelChange): Promise<import("../../shared/types").ModelSet>;
  /** Forget session `id` (sessions:forget): its chain bridged over it, its record held for unforget. Throws why not. */
  forgetSession(id: string): import("../../shared/types").Forgotten;
  /** Undo Forget `token` (sessions:unforget): what couldn't come back, in lines. Throws why not. */
  unforget(token: string): string[];
  /** Whether Forget `token` can still be undone. */
  forgetUndoable(token: string): boolean;
  /** A wire's settings as a person set them (settingsOf), what it sends included: for its Undo and its tier, never shown. Null when there's no such wire. */
  wireSettings(id: string): WireSettings | null;
  /** Change wire `id`'s settings, as its Settings… does (wires:set). Throws why not. */
  setWire(id: string, settings: WireSettings): void;
  /** Move wire `id`'s ends, keeping its type and settings (wires:repoint). Throws why not. */
  repointWire(id: string, ends: { from?: string; to?: string }): void;
  /** Undo wire `id`'s last move (wires:unrepoint). Throws why not. */
  unrepointWire(id: string): void;
  /** Whether wire `id`'s last move can still be undone. */
  repointUndoable(id: string): boolean;
  /** The Orchestrators' held plans as the window's dialog shows them (plans:list), each checked again now. */
  plans(): Promise<import("../../shared/plans").PlanView[]>;
  /** The plans held now, read without checking them: what the snapshot counts and a card goes by. */
  heldPlans(): { id: string; from: string; at: number }[];
  /** Lay held plan `id` out as `shown`, going where `at` says (plans:layOut). Throws why not. */
  layOutPlan(id: string, shown: import("../../shared/plans").Plan, at: import("../../shared/plans").PlanShownAt): Promise<import("../../shared/plans").PlanLaidOut>;
  /** Dismiss held plan `id`, its Orchestrator told with `note` (plans:dismiss). Throws why not. */
  dismissPlan(id: string, note: string): import("../../shared/types").AgentTold;
}

/** Everything the tools reach, one block per tool group. */
export interface AssistantDeps extends AssistantCoreDeps, AssistantRuleDeps, AssistantWorkDeps, AssistantLayoutDeps, AssistantFileDeps, AssistantPipelineDeps {}

/** A team room whose House board couldn't be read (houseBoards): its id, its name and why. */
export interface HouseBoardUnread {
  roomId: string;
  room: string;
  error: string;
}

/** A wire as the Assistant reads it: never its pending's text, a summary or a template. */
export interface AssistantWire {
  id: string;
  from: string;
  to: string;
  type: WireType;
  when: WireWhen;
  /** What its gate shows now (gateOf), and why when it's blocked. */
  state: GateState;
  why: string | null;
  /** The gate in force: "ask" waits for the user's Send. */
  gate: WireGate;
  /** What waits at its gate, by id, when it was readied and how long it is; null when nothing does. */
  waiting: { pendingId: string; at: number; chars: number } | null;
  /** A feedback wire's rounds. */
  rounds: { used: number; limit: number } | null;
}
