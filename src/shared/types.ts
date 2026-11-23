import type { LspRange, LspTextEdit } from "./textEdits";
// team rooms: live panes
import type { RoomSandboxChange, RoomSessionTag } from "./team/livePanes";
import type { CouncilHouseTicket, CouncilTicketDrafts } from "./collabTickets";
import type { PhoneAlertSettings } from "./phoneAlerts";
import type { PermissionMode } from "./permissionModes";
import type { AssistantModel } from "./assistant";

/** Which coding-agent CLI a session runs. */
export type AgentKind = "claude" | "codex";
export const AGENT_NAME: Record<AgentKind, string> = { claude: "Claude", codex: "Codex" };

export type SessionStatus = "working" | "waiting" | "idle" | "dead";

/**
 * A session with a standing job of its own. `tasks`: the Helpdesk tasks workspace, Claude in the user's own Chrome
 * (`claude --chrome`) for requests pasted in. It has no Mockingbird MCP server, takes no messages or wires, and never
 * runs in a team room's area. `orchestrator` (W17): it reads its ticket, researches and proposes the workspaces and
 * wires as a plan (propose_plan), creating nothing and writing no code; its start tracks the ticket at BA.
 */
export type SessionRole = "tasks" | "orchestrator";

/**
 * A closed session whose folder is gone (sessions:missingFolders), and what that means for reopening it: a removed
 * worktree whose branch is still there is made again from it (`reopens`); otherwise it can't run where it ran, and `why`
 * says what's missing.
 */
export interface MissingFolder {
  id: string;
  reopens: boolean;
  /** What a ghost's status line says ("Its worktree was removed"). */
  short: string;
  why: string;
}

export interface SessionInfo {
  id: string;
  title: string;
  model?: string | null; // persisted so relaunch resumes on the same model
  effort?: string | null;
  /** Its permission mode (permissionModes.ts), kept through every relaunch as its model and effort are; absent is `default`. */
  permissionMode?: PermissionMode | null;
  /**
   * The mode its agent last reported in a hook's payload (permissionModes.ts hookMode): one switched in the pane, or
   * the agent's own settings' default. Absent until its agent reports, and on every launch until it does.
   */
  liveMode?: PermissionMode | null;
  exitCode?: number | null; // set when the process ends; shown on the dead pane
  repoPath: string | null; // null for assistant/free sessions
  cwd: string; // where claude runs (worktree path, repo path, or WorkTracker)
  branch: string | null;
  ticketId: string | null;
  ticketTitle: string | null;
  /**
   * An Orchestrator given several tickets at once (Pipeline from a ticket…, the Assistant): every one, `ticketId` first.
   * Each step of its plan works on one of them. Absent for every other session, and for an Orchestrator on one ticket.
   */
  tickets?: string[];
  taskGroup: string | null; // groups multiple sessions under one task
  status: SessionStatus;
  createdAt: number;
  kind: "work" | "assistant";
  extraDirs: string[];
  waitingReason: string | null; // hook Notification message, e.g. "permission: Bash"
  waitingSince: number | null; // ts of the waiting transition
  waitingAt?: number | null; // ts of the latest prompt's event while waiting: a second prompt, worded alike or not, moves it
  queuedCount?: number; // broadcasts queued for this session (live only)
  debrief?: boolean; // morning brief / wrap-up — lives on the WorkTracker tab, not the landscape
  shell?: boolean; // plain terminal (no claude) — excluded from broadcasts/re-reads
  agent?: AgentKind; // absent on sessions persisted before Codex support — those are Claude
  /** Its standing job (SessionRole), kept through every relaunch. */
  role?: SessionRole;
  /** The agent conversation last seen running in this pane (from its hook events) — what a relaunch resumes. */
  conversation?: { agent: AgentKind; id: string };
  /**
   * A terminal that was this agent's pane until the agent quit on its own (/exit): it reopens as a plain terminal, and
   * Resume <agent> (sessions:resumeAgent) makes it that agent pane again, on the conversation it quit from (AgentQuit).
   */
  agentQuit?: AgentQuit;
  /**
   * An agent pane whose agent quit on its own while it ran in its team room's sandbox: it's left exited, as no shell
   * starts there but on its owner's click (Open a terminal here, sessions:openTerminal), or Resume brings the agent back.
   */
  quitInSandbox?: true;
  /**
   * Its folders (cwd, extra folders) that had no repository at its first team room launch, as the disk names them:
   * every relaunch holds them to having none (gitPins.ts), so a `.git` its agent could have made there isn't trusted.
   */
  noRepo?: string[];
  /** Every conversation this pane has run (a /clear starts a new one), oldest first — what its token meter adds up. */
  conversations?: string[];
  /** The agent CLI's version when this pane started it; a newer install means it needs a restart. */
  agentVersion?: string;
  /** Working, but no output since this time: it may be stuck. */
  stalledSince?: number | null;
  /** Stalled, and its agent's hooks haven't reported once since the pane started: its status can't be trusted. */
  hooksSilent?: boolean;
  /** No notifications from this session. */
  muted?: boolean;
  /** What a reply from the user's phone did to this session last (phone alerts), shown in its pane until dismissed. */
  phoneNote?: { text: string; at: number } | null;
  /**
   * When its agent's turn last ended (its Stop hook: what the Finished notification announces), while it has been
   * idle since. Null or absent once it works or waits again, or its agent starts a new or cleared conversation. The
   * Needs you tray lists it as finished.
   */
  finishedAt?: number | null;
  /**
   * When its agent last took a prompt this launch, Mockingbird's own notices left out (main's promptCount): a summary
   * written since (finish_step, or a person's Finish step) finished the step that prompt began. Live only.
   */
  promptAt?: number | null;
  // team rooms: live panes
  /** Set in the window on a session in a shared group: its room, owner, and who's looking at it. */
  room?: RoomSessionTag;
  /**
   * Set in the window on a running session of this Mac's whose room sandbox isn't what its room asks for now, until it
   * restarts (LivePanesState.sandboxUntilRestart).
   */
  sandboxUntilRestart?: RoomSandboxChange;
  /**
   * Not started yet (PlannedStep): a record with no pty and no folder of its own. It's never resumed, relaunched,
   * published to a room or listed as closed; startPlanned starts it under its id, so its wires keep their ends.
   */
  planned?: PlannedStep;
}

/**
 * A step not started yet (docs/landscape-wires.md, W8): made by Add next step, joined by a handoff wire from the step
 * before. Its folder is made as it starts: a worktree of its own from the upstream step's commit then (section 3), or
 * another session's folder as it stands (`sharesWith`, decision 7). Its record's `cwd` is only where it would start
 * with neither (its repo, else home).
 */
export interface PlannedStep {
  /** A worktree of its own, on a new branch named after the upstream step's (its repo's; none outside one). */
  worktree: boolean;
  /** Its new branch is cut from origin's here when there's no upstream commit in its repo to start at. */
  base?: string | null;
  /** Starts in this session's folder, on its branch as it stands, as the reviewing step works in its builder's. */
  sharesWith?: string;
  /** What it's told as it starts, ahead of what its wire carries (the dialog's ticket kickoff, or its own words). */
  prompt?: string;
}

/**
 * A not-started step that started (main's startStep; Start now's answer). Its ticket's stage is moved once its pty runs,
 * so a failure there doesn't undo the start: `stageWhy` says what couldn't be done and why ("#5115 couldn't be moved
 * to Coding (…)"), else null.
 */
export interface StepStarted {
  info: SessionInfo;
  stageWhy: string | null;
}

/**
 * A change to a not-started step (steps:edit; main's PipelineEdits.editStep), checked as a session's start checks it.
 * Absent: as it is. A null model or effort is its agent's default; a null permission mode the default mode; a null or
 * empty prompt none.
 */
export interface StepEdit {
  title?: string;
  agent?: AgentKind;
  model?: string | null;
  effort?: string | null;
  permissionMode?: PermissionMode | null;
  prompt?: string | null;
}

/** A model and effort for any session (sessions:setModel). Absent: as it is; null: its agent's default. */
export interface ModelChange {
  model?: string | null;
  effort?: string | null;
}

/**
 * What sessions:setModel did: a running pane restarted in place with it (its wires, place and area kept), a not-started
 * step's spec edited, or a closed session's record changed, for its Reopen.
 */
export interface ModelSet {
  info: SessionInfo;
  did: "restarted" | "edited" | "stored";
}

/**
 * A step to insert (steps:insert): a not-started step after session `after`, ahead of session `before`, or between
 * them. Between, their handoff A→B becomes A→new→B: new→B takes A→B's settings, and A→new is a plain handoff. The step
 * goes in the area of the step it's next to, and works in a worktree of its own when that one does.
 */
export interface InsertStepRequest {
  after?: string | null;
  before?: string | null;
  title: string;
  agent: AgentKind;
  model?: string | null;
  effort?: string | null;
  prompt?: string | null;
}

/** A step inserted: its record, the wires made for it, and what didn't go as asked (`note`), else null. */
export interface StepInserted {
  info: SessionInfo;
  wires: string[];
  note: string | null;
}

/** A handoff made from A to B as the step between them went (Forget's bridge). */
export interface BridgedWire {
  id: string;
  from: string;
  to: string;
}

/**
 * What forgetting a session did to its chain (sessions:forget): each A→B bridged over it, what couldn't be (why, with
 * its ends' names), and the token its Undo takes (sessions:unforget), null when there's nothing to put back.
 * `wiresLeft`: why its wires stayed in the book when it couldn't be changed (they show blocked), else null.
 */
export interface Forgotten {
  bridged: BridgedWire[];
  unbridged: string[];
  undo: string | null;
  wiresLeft: string | null;
}

/** Add next step's request (sessions:plan): a not-started step after session `after`, joined to it by a handoff wire. */
export interface PlanRequest {
  after: string;
  title: string;
  agent: AgentKind;
  model?: string;
  effort?: string;
  repoPath: string | null;
  /** Its own worktree in `repoPath`; else it runs in the repo's checkout as it is then (or home, with no repo). */
  worktree: boolean;
  base?: string | null;
  /** A top-level group: a not-started step goes in an area, never a stack. */
  taskGroup: string | null;
  ticketId?: string;
  ticketTitle?: string;
  prompt?: string;
  /** Start in `after`'s folder instead of a folder of its own (decision 7). */
  sharesFolder?: boolean;
}

/** Every agent, in the order the app lists them. */
export const AGENT_KINDS: AgentKind[] = ["claude", "codex"];

/**
 * The agent a terminal's pane ran until it quit, and the conversation it quit from: what Resume <agent> brings back,
 * whatever an agent started in the terminal by hand runs since (SessionInfo.conversation follows that).
 */
export interface AgentQuit {
  agent: AgentKind;
  conversation?: string;
}

/** Terminal `s` as the agent pane it was until its agent quit (SessionInfo.agentQuit), as Resume <agent> starts it; otherwise `s`. */
export function asQuitAgent<T extends Pick<SessionInfo, "shell" | "agent" | "agentQuit" | "conversation">>(s: T): T {
  if (!s.shell || !s.agentQuit) return s;
  const { shell: _shell, agentQuit: quit, conversation: _conversation, ...rest } = s;
  return { ...rest, agent: quit.agent, ...(quit.conversation ? { conversation: { agent: quit.agent, id: quit.conversation } } : {}) } as T;
}

/** The agent a session hands over to, or asks for a second opinion; a session without one runs Claude. */
export const otherAgent = (a: AgentKind | null | undefined): AgentKind => (a === "codex" ? "claude" : "codex");

/** An agent CLI updated under running sessions: they still run the old version until restarted. */
export interface AgentUpdateNotice {
  agent: AgentKind;
  installed: string;
  sessions: { id: string; title: string; version: string }[];
}

export interface WorktreeStateInfo {
  dirty: boolean;
  dirtyFiles: number;
  branch: string;
  /** What ahead/behind count against (e.g. origin/dev, or the branch's own remote), or null when nothing is tracked. */
  upstream: string | null;
  ahead: number;
  behind: number;
  insertions: number;
  deletions: number;
}

export type WorktreeCleanupMode = "keep" | "push" | "discard";

/** What a close-session cleanup did. `branchKept` says why a discard left the branch in place. */
export interface WorktreeCleanupResult {
  removed: boolean;
  branchKept?: string;
  /**
   * Close session's push for a team room session, on a branch with a base's name or not its own: why it waits for the
   * user's say-so. Nothing was committed, pushed or removed; asked again with `confirmBranch` naming `branch`, it goes.
   */
  confirm?: string;
  branch?: string;
}

/** What Close session says along with a cleanup: the branch it showed (`shown`), and the user's say-so to push one (`confirmBranch`). */
export interface WorktreeCleanupSay {
  shown?: string;
  confirmBranch?: string;
}

/** One entry of the worktree janitor: a `<repo>-worktrees/<name>` checkout. */
export interface WorktreeEntry {
  repoPath: string;
  repoName: string;
  path: string;
  name: string;
  branch: string;
  dirty: boolean;
  dirtyFiles: number;
  ahead: number;
  behind: number;
  ageDays: number;
  inUse: boolean; // a live session runs here
  legacy: boolean; // still in the old <repo>-worktrees/ layout
  error?: string; // not a readable git worktree
}

// ---- IPC answers -------------------------------------------------------------

/** A main-process answer: every IPC handler answers { error } instead of rejecting. */
export type IpcResult<T> = T | { error: string };

/**
 * The answer is a failure. Only a string `error` counts: an answer whose
 * `error` key is present but unset ({ error: undefined } survives IPC) is a
 * success.
 */
export function isErr(r: unknown): r is { error: string } {
  return !!r && typeof r === "object" && typeof (r as { error?: unknown }).error === "string";
}

// ---- group paths -----------------------------------------------------------
// A session's taskGroup is a path: "5038" is a group, "5038/backend" is the
// "backend" workspace inside group 5038. Every producer and consumer of that
// string goes through these helpers so the format has one definition.

/** A name typed by a user becomes one path segment — "/" is the separator. */
export function sanitizeSegment(name: string): string {
  return name.trim().replace(/\//g, "-");
}

/** The key of group `top`, or of workspace `sub` inside it: ("5038", "backend") → "5038/backend". */
export function groupKey(top: string, sub?: string | null): string {
  const t = sanitizeSegment(top);
  const s = sub ? sanitizeSegment(sub) : "";
  return s ? `${t}/${s}` : t;
}

/** A top-level group that can be shared as a team room: a named one, not the sidebar's ungrouped or assistant bucket. */
export function isShareableGroup(key: string): boolean {
  return !!key && key !== "ungrouped" && key !== "assistant";
}

/** Top-level group of a group key ("5038/backend" → "5038"). */
export function topOfKey(key: string): string {
  return splitGroupKey(key).top;
}

/**
 * Canonicalize a group value typed by a user or seeded by the UI. Path syntax is
 * intentional: "5038/backend" means the backend workspace inside group 5038.
 * Anything past the first "/" collapses into the workspace segment.
 */
export function normalizeGroupPath(value: string): string {
  const v = value.trim();
  if (!v) return "";
  const { top, sub } = splitGroupKey(v);
  return groupKey(top, sub);
}

/**
 * Naming the "ungrouped" bucket makes it a real group: each session in it moves
 * to `name`, keeping its workspace (a session with a literal "ungrouped/x" group
 * goes to "name/x").
 */
export function groupUngrouped(sessions: { id: string; taskGroup?: string | null }[], name: string): { id: string; group: string }[] {
  return sessions
    .filter((s) => topOfKey(s.taskGroup ?? "ungrouped") === "ungrouped")
    .map((s) => {
      const sub = s.taskGroup ? splitGroupKey(s.taskGroup).sub : null;
      return { id: s.id, group: sub ? `${name}/${sub}` : name };
    });
}

/** Split a group key into its group and (optional) workspace. */
export function splitGroupKey(key: string): { top: string; sub: string | null } {
  const i = key.indexOf("/");
  if (i < 0) return { top: key || "ungrouped", sub: null };
  const top = key.slice(0, i) || "ungrouped";
  const sub = key.slice(i + 1).trim();
  return { top, sub: sub || null };
}

export interface AdoWorkItem {
  id: number;
  title: string;
  state: string;
  type: string; // Task | User Story | Bug | …
  assignedTo: string; // display name; "" = unassigned
  changed: string; // ISO date of last change
  description: string; // flattened plain text
  url: string; // browser link to the work item
  boardColumn?: string; // the column it sits in on the team's board (System.BoardColumn)
  tags: string[]; // System.Tags, split
  /** Values, by reference name, of the fields card rules and blocked detection read (Microsoft.VSTS.CMMI.Blocked…), where the process has them. */
  fields?: Record<string, string>;
  /** Its place in the team's backlog order (Stack Rank or Backlog Priority): lower comes first. Unset when unranked or unknown. */
  rank?: number;
}

/** One condition of a board's card rule, as Azure DevOps stores it: `field op value`, joined to the one before by `logic`. */
export interface AdoCardRuleClause {
  field: string; // reference name
  op: "=" | "contains";
  value: string;
  logic: "and" | "or";
}

/** A card rule that fills the cards it matches (team settings → Cards → Styles). */
export interface AdoFillRule {
  name: string;
  clauses: AdoCardRuleClause[];
  background: string; // #rrggbb as set in Azure DevOps
  /** It marks blocked work: named for it, or it tests a blocked tag or the Blocked field. */
  blocked: boolean;
}

/** A tag's colour (team settings → Cards → Tag colors). */
export interface AdoTagStyle {
  tag: string;
  background: string; // #rrggbb
}

/** A board's card styling, as far as Mockingbird can apply it; `ignored` says which rules it can't, and why. */
export interface AdoCardRules {
  fill: AdoFillRule[];
  tags: AdoTagStyle[];
  ignored: string[];
}

/** One column of a team's Azure Boards board, and the state each work item type has there. */
export interface AdoBoardColumn {
  name: string;
  type: "incoming" | "inProgress" | "outgoing";
  stateMappings: Record<string, string>; // work item type → state
}

/** A team's board as Azure DevOps defines it — the columns the team actually uses. */
export interface AdoBoard {
  id: string;
  name: string;
  columns: AdoBoardColumn[];
  columnField: string | null; // the Kanban column field: tells columns that share a state apart
  cardRules: AdoCardRules | { error: string }; // the board's card styles, or why they couldn't be read
}

export interface AdoComment {
  id: number;
  author: string;
  date: string; // ISO
  text: string; // flattened plain text
}

export interface RepoEntry {
  path: string;
  name: string;
  root: string;
}

export interface NewSessionRequest {
  repoPath: string | null;
  ticketId?: string;
  ticketTitle?: string;
  branchName?: string; // if empty and ticket given, derived
  useWorktree: boolean;
  taskGroup?: string;
  extraDirs?: string[];
  resume?: boolean; // claude --continue in cwd
  resumeSessionId?: string; // claude --resume <id> (imports)
  title?: string; // explicit title override
  reuseId?: string; // keep a relaunched session's id so grid layout/groups survive restarts
  /** Open in this existing folder as it is — continuing another session's worktree: no new worktree, no branch switch. */
  cwd?: string;
  debrief?: boolean; // marks WorkTracker debrief sessions
  baseBranch?: string; // new branch: fetch origin/<base> first and branch off it (dev/uat flow)
  /** A new worktree's branch starts at this commit, nothing fetched: a not-started step's upstream's (startPlanned). */
  startAt?: string;
  initialPrompt?: string; // sent to the claude session once it's up (e.g. the ADO ticket)
  shell?: boolean; // open a plain zsh terminal instead of launching claude
  agent?: AgentKind; // which CLI to launch (default claude)
  /** Terminal sessions only: resume this conversation inside the shell, then drop back to the shell prompt. */
  shellResume?: { agent: AgentKind; id: string };
  model?: string; // claude --model (alias like "opus" or a full model id)
  effort?: string; // claude --effort (low | medium | high | xhigh | max)
  /** Its agent's permission mode (agents.ts modeArgs); absent or `default` passes nothing. */
  permissionMode?: PermissionMode;
  /** A session with a standing job (SessionRole): `tasks` runs in ~/Helpdesk, on no repository. */
  role?: SessionRole;
  /** An Orchestrator's several tickets (SessionInfo.tickets), `ticketId` first: refused for any other session. */
  tickets?: string[];
}

/**
 * What a restart with changes changes (sessions:relaunchWith, agents.ts readRelaunchChange). Absent: as it is. A null
 * model or effort: the agent's own default.
 */
export interface RelaunchChange {
  permissionMode?: PermissionMode;
  model?: string | null;
  effort?: string | null;
}

export interface RepoBranches {
  branches: string[]; // union of local + origin branches
  defaultBase: string | null; // best guess dev/uat-style integration branch
}

export interface ImportableConversation {
  sessionId: string;
  /** Which CLI resumes it; absent means Claude. */
  agent?: AgentKind;
  cwd: string;
  title: string;
  mtimeMs: number;
}

export interface Settings {
  repoRoots: string[];
  workTrackerPath: string;
  claudeBin: string;
  codexBin: string;
  setupDone?: boolean; // the first-run wizard was finished or skipped
  agentMessagesSubmit?: boolean; // agent-to-agent messages auto-send (default) or wait in the prompt
  debriefs: { enabled: boolean; morning: string; wrapUp: string }; // "HH:MM"
  notifications: boolean;
  updateSource?: string | null; // the clone in-app updates pull and build; found under repoRoots when unset
  /** Top-bar tabs turned off in Settings; they can still open from a notification or a search result. */
  hiddenTabs?: OptionalTab[];
  /** One-click session setups. */
  presets?: SessionPreset[];
  /**
   * Pipeline templates (W9): kept as written, read entry by entry (shared/pipelineTemplates.ts' readTemplates), as one
   * written by another version may hold what this one can't read. Main is their only writer (templates:save).
   */
  pipelineTemplates?: unknown[];
  /** Per group (top-level key), overriding agentMessagesSubmit for messages to that group's sessions. */
  agentMessagesByGroup?: Record<string, MessageMode>;
  /** No session notifications between these times (they can span midnight). */
  quietHours?: QuietHours;
  /** Notify when a session finishes its turn, not only when it needs you (default on). */
  notifyFinished?: boolean;
  /** iMessages to the user's own handle while they're away from the Mac (src/shared/phoneAlerts.ts). */
  phoneAlerts?: PhoneAlertSettings;
  /** Team rooms: the name teammates see (default: the macOS user name). */
  teamName?: string;
  /** Team rooms: the signaling Worker's URL (signaling/README.md); new rooms use it, invite codes carry it. */
  signalingUrl?: string;
  /**
   * Team rooms: this Mac's room sessions run Claude Code and Codex inline, on
   * the terminal's normal screen, so teammates' copies hold their history and
   * scroll it (default on). Off: they run as the agent is set up, which may be
   * full screen.
   */
  roomSessionsInline?: boolean;
  /**
   * Team rooms whose sessions run without the room's sandbox on this Mac (Settings → Team, per room), by room id:
   * their Claude and Codex sessions start as this Mac's own do, with the user's credentials, MCP servers and home
   * folder. A room not listed, or anything here that isn't a list of ids, keeps its sandbox (roomSandboxOff). Never
   * sent to teammates; leaving a room drops its id.
   */
  roomsUnsandboxed?: string[];
  /** The model the app Assistant's turns run (Settings → Assistant); Sonnet when unset (assistantModelOf). */
  assistantModel?: AssistantModel;
}

export interface QuietHours {
  enabled: boolean;
  from: string; // "HH:MM"
  to: string; // "HH:MM"
}

/**
 * A recurring session setup started in one click: what to launch, where, on
 * which branch, and what to tell it first (a shell runs its kickoff as a command).
 */
export interface SessionPreset {
  id: string;
  name: string;
  launch: "claude" | "codex" | "shell";
  repoPath: string | null;
  /**
   * checkout: the repo's checkout as it is. existing: switch to (or open a
   * worktree of) that branch. new: a fresh branch named from `pattern`
   * ({date} = YYYYMMDD, {time} = HHMM), cut from origin/`base`.
   */
  branch: { mode: "checkout" } | { mode: "existing"; name: string } | { mode: "new"; pattern: string; base?: string };
  useWorktree: boolean;
  group?: string;
  kickoff?: string;
  model?: string;
  effort?: string;
  /** The session's standing job: only the built-in HELPDESK_PRESET has one. */
  role?: SessionRole;
}

/** The Helpdesk tasks workspace's area. */
export const HELPDESK_GROUP = "Helpdesk";

/** Why the Helpdesk tasks workspace doesn't go in a team room's area. */
export const HELPDESK_IN_ROOM = "The Helpdesk tasks workspace never runs in a team room's area: teammates would see your admin consoles and could type into it";
/** Why it isn't started there (main's refusal, and the preview's). */
export const HELPDESK_START_IN_ROOM = `${HELPDESK_IN_ROOM}. Start it in an area that isn't shared.`;
/** Why a second one isn't started: one at a time on this Mac, and the window shows the one there is. */
export const HELPDESK_STARTING = "The Helpdesk tasks workspace is being started already";
export const helpdeskOpenAlready = (title: string): string => `The Helpdesk tasks workspace is open already, as “${title}”: New workspace → Helpdesk tasks… shows it`;

/** The built-in preset that starts the Helpdesk tasks workspace: first in New session's presets, never in Settings'. */
export const HELPDESK_PRESET: SessionPreset = {
  id: "builtin:helpdesk",
  name: "Helpdesk tasks",
  launch: "claude",
  repoPath: null,
  branch: { mode: "checkout" },
  useWorktree: false,
  group: HELPDESK_GROUP,
  role: "tasks",
};

/** The top-bar tabs that can be turned off. Sessions and Settings always show. */
export type OptionalTab = "dashboard" | "worktracker" | "collaborate";
export const OPTIONAL_TABS: OptionalTab[] = ["dashboard", "worktracker", "collaborate"];

/** M modified · A added · D deleted · R renamed · U untracked · C conflicted */
export type ScmStatusCode = "M" | "A" | "D" | "R" | "U" | "C";
/** A ref shown on a commit in the graph. */
export interface GraphRef {
  name: string;
  kind: "head" | "local" | "remote" | "tag";
}

export interface GraphCommit {
  sha: string;
  parents: string[];
  refs: GraphRef[];
  subject: string;
  author: string;
  /** Commit time, ms. */
  at: number;
}

/** The commit graph Source Control shows: HEAD, its upstream and the base branch, newest first. */
export interface ScmGraph {
  commits: GraphCommit[];
  head: string | null;
  /** The refs drawn, e.g. ["HEAD", "origin/dev"]. */
  refs: string[];
  more: boolean;
}

export interface ScmEntry {
  path: string;
  from?: string;
  status: ScmStatusCode;
}
/** A session folder's git state, grouped like VS Code's Source Control view. */
export interface ScmStatus {
  branch: string | null;
  upstream: string | null;
  /**
   * The upstream is this branch's own remote branch. A branch made from
   * origin/dev tracks origin/dev until it's published: it can pull from dev, but
   * pushing must go to its own name, never into dev.
   */
  published: boolean;
  ahead: number;
  behind: number;
  staged: ScmEntry[];
  unstaged: ScmEntry[];
  conflicted: ScmEntry[];
}

/** A model a CLI can run, as the CLI itself describes it. */
export interface ModelChoice {
  id: string; // what --model gets: an alias ("opus"), or a full id
  label: string;
  description?: string;
  efforts?: string[]; // this model's own effort/reasoning levels (Codex lists them)
  defaultEffort?: string;
  group?: string; // "Latest", "Your account", "Codex models", "Recently used"
}

/** Every model and effort level each CLI offers on this Mac. */
export interface ModelCatalog {
  claude: { models: ModelChoice[]; efforts: string[] };
  codex: { models: ModelChoice[]; efforts: string[] };
}

/** A conversation that matched a search across every transcript on this Mac, and how to open it. */
export interface TranscriptHit {
  id: string; // the agent's conversation id
  agent: AgentKind;
  cwd: string;
  title: string;
  started: number;
  updated: number;
  model: string | null;
  snippet: string; // \u0001…\u0002 mark the matched words
  at: number;
  kind: "message" | "tool";
  /** pane: it's open · previous: a closed Mockingbird session that resumes it · room: a Collaborate model's · resume: open it as a new session */
  open: { how: "pane" | "previous"; sessionId: string } | { how: "room"; roomId: string; roomTitle: string } | { how: "resume" };
}

/** A transcript search's hits, and how far the index behind them has got. */
export interface TranscriptSearchResult {
  hits: TranscriptHit[];
  conversations: number;
  files: number;
  /** Set while the index is still reading transcripts. */
  indexing: { done: number; total: number } | null;
  lastSync: number;
  /** Why the index can't be trusted right now, if it can't. */
  problem: string | null;
}

/** The newest version on GitHub, against the one running. */
export interface UpdateInfo {
  current: string;
  latest: string;
  url: string;
  newer: boolean;
  /** Where "latest" came from: a published GitHub release, or the version on the default branch. */
  source: "release" | "branch";
}

export type UpdateStepId = "check" | "node" | "pull" | "install" | "build" | "verify";

export const UPDATE_STEPS: { id: UpdateStepId; label: string }[] = [
  { id: "check", label: "Check your clone" },
  { id: "node", label: "Check Node" },
  { id: "pull", label: "Pull the latest code" },
  { id: "install", label: "Install dependencies" },
  { id: "build", label: "Build the app" },
  { id: "verify", label: "Check the new build" },
];

/** An in-app update: pulling and building in the user's clone, then restarting into it. */
export interface UpdateProgress {
  state: "idle" | "preparing" | "ready" | "failed" | "installing";
  step?: UpdateStepId; // running, or where it failed
  done: UpdateStepId[];
  /** Why it failed. Never `error`: isErr would take a failed update's progress for a call that failed. */
  problem?: string;
  log: string[]; // the tail of the steps' output
  clone?: string;
  version?: string; // the built version, once ready
  appPath?: string; // the built bundle, once ready
}

/** How the update this launch follows went; the sessions open before it come back. */
export interface UpdateOutcome {
  ok: boolean;
  from: string;
  to: string;
  message: string;
  sessions: string[];
  logPath: string;
}

/** What the tray, the Dock and notifications ask the window to do (the "ui:command" channel). */
export const UI_COMMANDS = { focusSession: "focus-session", newSession: "new-session", update: "update" } as const;
export type UiCommand = (typeof UI_COMMANDS)[keyof typeof UI_COMMANDS];

export interface BroadcastRequest {
  message: string;
  sessionIds: string[]; // empty = all live work sessions
  whenIdle: boolean; // queue for busy sessions, deliver on Stop
}

// ---- in-app file explorer ----------------------------------------------------
export interface FileEntry {
  name: string;
  path: string; // relative to the session folder
  dir: boolean;
}

export interface FileContent {
  binary: boolean;
  size: number;
  content: string;
  truncated: boolean; // only the head of a very large file was read
  /** When it was last written — a save checks it, so a change made since (by an agent) isn't overwritten unseen. */
  mtimeMs: number;
}

/** A save: written, or refused because the file changed on disk after it was opened. */
export type FileSave = { saved: true; mtimeMs: number } | { saved: false; conflict: true; mtimeMs: number };

/** M modified · A added · D deleted · R renamed · U untracked */
export type GitChangeStatus = "M" | "A" | "D" | "R" | "U";

export interface GitChange {
  path: string;
  from?: string; // previous path of a rename
  status: GitChangeStatus;
}

/** "working" = uncommitted vs HEAD · "branch" = everything since the fork from the base branch */
export type ChangeScope = "working" | "branch";

/** Every file in a session's folder (⌘P). `unreadable`: folders a non-git walk couldn't open. */
export interface FileList {
  files: string[];
  truncated: boolean;
  unreadable?: number;
}

export interface FileSearchOptions {
  regex: boolean;
  matchCase: boolean;
}

export interface FileHit {
  path: string;
  line: number;
  text: string;
}

/** A text search over a session's folder; `stopped` says it ended early (too many matches, or too slow). */
export interface FileSearch {
  hits: FileHit[];
  files: number;
  stopped: "limit" | "time" | null;
  warning: string | null;
}

export interface GitChanges {
  changes: GitChange[];
  base: string; // what the changes are measured against
}

/** How much a worktree changed since it forked from its base: `git diff --shortstat` from the merge base (a card's diff badge). */
export interface BranchStat {
  /** The ref it's measured against: origin/dev, or a local branch. */
  base: string;
  files: number;
  insertions: number;
  deletions: number;
}

/** The first line of an agent's latest message in its conversation (a card's "what it did"); null: it hasn't said anything yet. */
export interface LastReply {
  line: string | null;
  at: number | null;
  /** Why `line` is null though the agent may have said something: the part of its transcript read held no message of its. */
  why?: string;
}

// ---- run ----------------------------------------------------------------------

/** A port a service listens on: `base` is its standard number (slot 0); other slots add slot × step. */
export interface RunPort {
  name: string;
  base: number;
  /** What to open in a browser, with ${port} for the slot's number, e.g. "https://localhost:${port}". */
  url?: string;
}

export interface RunService {
  name: string;
  /** "process": a command on its own terminal. "compose": `docker compose up` with a per-worktree override. */
  kind: "process" | "compose";
  /** Relative to the worktree. */
  cwd: string;
  /** A shell command; ${port:<name>}, ${slot} and ${worktree} are filled in when it starts. */
  command: string;
  env?: Record<string, string>;
  /** Relative to the worktree; read as KEY=VALUE lines into the environment. */
  envFiles?: string[];
  ports?: RunPort[];
  /** Services that must be ready first. */
  dependsOn?: string[];
  /** When it counts as up: a port accepting connections, or a log line matching a pattern. */
  ready?: { port?: string; log?: string };
  compose?: { file: string; services?: string[] };
  /** How to run it under the debugger, when it can be. */
  debug?: RunDebug;
}

export interface RunProfile {
  /** The repository's main checkout; every worktree of it shares this profile. */
  repo: string;
  services: RunService[];
  prepare?: {
    /** Gitignored files or globs to copy from the main checkout into a worktree that lacks them. */
    copy?: string[];
    /** Setup commands, each run only while its `ifMissing` path doesn't exist. */
    commands?: { cwd: string; command: string; ifMissing: string }[];
  };
  sideBySide?: { slots: number; step: number };
  /** Things that stop this repo running side by side, with the change that fixes each. */
  blockers?: { what: string; fix: string }[];
  /** Origins sign-in must allow for each slot (Entra/B2C redirect URIs), listed for the user to register. */
  notes?: string[];
}

/** A session's run setup: its worktree, the main checkout whose profile it shares, and the profile's file. */
export interface RunProfileInfo {
  worktree: string;
  repo: string;
  file: string;
  profile: RunProfile | null;
}

export type RunStatus = "starting" | "running" | "stopping" | "stopped" | "failed";

/** One running (or last-run) service of one worktree. */
/** Someone else listening on a port a service needs. */
export interface PortConflict {
  port: number;
  service: string;
  pid: number | null;
  command: string;
}

export interface RunServiceState {
  id: string;
  service: string;
  worktree: string;
  repo: string;
  slot: number;
  status: RunStatus;
  ports: { name: string; port: number; url?: string }[];
  pid: number | null;
  exitCode: number | null;
  startedAt: number;
  /** Why it failed or stopped, when not by request. */
  error?: string;
  /** The debug session it runs under, when started with Debug. */
  debug?: string;
}

// ---- debugging ------------------------------------------------------------------

/** How a service runs under the debugger. Ports and paths may use the same ${…} placeholders as its command. */
export type RunDebug =
  | { type: "python"; module?: string; program?: string; args?: string[]; python?: string; justMyCode?: boolean }
  | { type: "node"; program?: string; runtimeExecutable?: string; runtimeArgs?: string[]; args?: string[] }
  | { type: "chrome"; url: string; webRoot?: string }
  /** `browser`: also open the app's page in a debug browser — with `blazor`, through the Blazor WebAssembly debug proxy. */
  | { type: "dotnet"; program: string; args?: string[]; build?: string; browser?: { url: string; blazor?: boolean; webRoot?: string } }
  /**
   * Attach to a Python process already listening with debugpy (e.g. in a container, started with
   * `python -m debugpy --listen 0.0.0.0:5678 …`). `port` names the service port it's published on;
   * for a compose service, `container` is the compose service to mount debugpy into and publish from.
   */
  | { type: "python-attach"; port: string; pathMappings?: { localRoot: string; remoteRoot: string }[]; container?: string };

export interface DebugSessionInfo {
  id: string;
  /** Set for a child session an adapter started (a browser page, a subprocess). */
  parentId: string | null;
  name: string;
  worktree: string;
  repo: string;
  service: string;
  state: "starting" | "running" | "stopped" | "ended";
  stopped?: { threadId: number; reason: string; description?: string; text?: string };
  threads: { id: number; name: string }[];
  error?: string;
}

export interface DebugFrame {
  id: number;
  name: string;
  /** Absolute; null for frames without source (native, generated). */
  path: string | null;
  line: number;
  column: number;
}

export interface DebugScope {
  name: string;
  ref: number;
  expensive: boolean;
}

export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
  /** Non-zero when it has children to expand. */
  ref: number;
}

// ---- first-run setup ---------------------------------------------------------
export interface AgentCheck {
  found: boolean;
  path: string | null;
  version: string | null;
  signedIn: boolean | null; // null = could not tell (detail says why)
  detail?: string;
}

export interface SetupStatus {
  claude: AgentCheck;
  codex: AgentCheck;
  hooks: { claude: boolean; codex: boolean | null }; // codex null = Codex not set up on this Mac
  repoRoots: { path: string; exists: boolean; repos: number }[];
  workTrackerPath: string;
  ado: { connected: boolean; display?: string; detail: string };
}

// ---- Collaborate: rooms where several models discuss an idea -----------------

/** How a room advances: one round per click, N rounds, or until every model agrees. */
export type CollabMode = "step" | "auto" | "consensus";

export interface CollabModel {
  key: string; // "gpt6", "opus", "fable"
  label: string; // "GPT-6 Astra"
  agent: AgentKind;
  model: string; // the CLI's model id
}

/** A seat in a room as the user configures it. */
export interface CollabParticipantSpec {
  key?: string; // an existing participant's key; omitted for a new seat
  label: string;
  agent: AgentKind;
  model: string;
  effort: string | null; // the CLI's effort / reasoning level; null = its default
  readsCode: boolean; // may read the room's repository
  runsCommands?: boolean; // may run tests/builds in the room's disposable copy of the repo (implies readsCode)
  usesDocker?: boolean; // may also use Docker, which reaches past the sandbox (implies runsCommands)
}

export interface CollabParticipant extends CollabModel {
  effort: string | null;
  readsCode: boolean;
  runsCommands?: boolean;
  usesDocker?: boolean;
  removed?: boolean; // left the room; kept so its past messages keep their name
  color: number; // palette slot, stable for the room's life
  conversationId: string | null; // the model's own CLI conversation, resumed every turn
  lookupConversationId?: string | null; // a code reader's separate thread for answering others' questions
  lastSeen: number; // index into messages: everything before it has been shown to this model
}

/** How many seat colours a room has: styles.css defines .c-0 … .c-5; seats past that share them. */
export const SEAT_PALETTE_SIZE = 6;

export interface CollabMessage {
  id: string;
  speaker: string; // "you", "system", or a participant key
  text: string;
  round: number; // 0 for the brief and messages between rounds
  at: number;
  stance?: "agree" | "continue"; // a model's closing STANCE line
  kind?: "plan" | "error" | "lookup"; // lookup: a code reader answering another model's question
  askedBy?: string; // lookup: the participant who asked
}

export interface CollabRoom {
  id: string;
  title: string;
  brief: string;
  repoPath: string | null; // readable during discussion; edited only after a plan is approved
  participants: CollabParticipant[];
  messages: CollabMessage[];
  mode: CollabMode;
  maxRounds: number; // auto: rounds per run · consensus: safety cap
  round: number; // rounds completed
  running: boolean;
  speaking: string | null; // participant key mid-turn
  plan: { text: string; by: string; approved: boolean; at: number } | null;
  implementedIn: string | null; // session id started from the approved plan
  /** The area its Orchestrator started in (W18); absent for a Council implemented before, whose session went in "Council". */
  implementedArea?: string;
  /** A disposable git worktree of the repo where command-running models work; never the user's checkout. */
  workspacePath?: string | null;
  /** A model's tool calls waiting for the user to allow or deny them (gone if the app quits). */
  pending?: CollabPermissionRequest[];
  /** Kinds of call the user chose to always allow in this room, e.g. "Bash: docker exec". */
  allowKinds?: string[];
  /** How long a model's request waits for the user before it counts as no (default 10). */
  askTimeoutMin?: number;
  /** The approved plan split into House ticket drafts, while the user reviews them before creating them. */
  ticketDrafts?: CouncilTicketDrafts | null;
  /** House tickets created from the approved plan, linked from the discussion. */
  houseTickets?: CouncilHouseTicket[];
  createdAt: number;
}

/**
 * How long a room's requests may wait for the user, in minutes: the choices,
 * and the default. A turn that runs commands is cut off at 30 minutes, so a
 * wait can't be allowed to take most of it.
 */
export const ASK_TIMEOUTS_MIN = [5, 10, 15, 20];
export const DEFAULT_ASK_TIMEOUT_MIN = 10;

/** A Claude model asking, mid-turn, to use a tool its permissions don't already cover. */
export interface CollabPermissionRequest {
  id: string;
  seat: string; // participant key
  tool: string; // Bash, Write, WebFetch…
  detail: string; // the command, the path, or the call's input
  description?: string; // the model's own one-line account of the call
  kind: string | null; // what "always allow" would cover; null when that would be unsafe to generalise
  at: number;
}

/** A Collaborate room file that couldn't be loaded: left on disk as it was, and not listed. */
export interface CollabLoadProblem {
  file: string;
  error: string;
}

/** One plan rate-limit window, e.g. the 5-hour limit or the weekly one. */
export interface UsageLimit {
  label: string; // for display: "5-hour limit", "Weekly · all models", "Weekly · Opus"
  /** Which window it is, for code to match on rather than the label. Every limit the main process reports has it. */
  window?: "5h" | "week" | "other";
  /** The one model a window counts ("Opus"); absent when it counts them all. */
  model?: string;
  usedPct: number; // 0-100
  resetsAt: number | null; // epoch ms
  /** Shown instead of a percentage when there's no reading for this window. */
  note?: string;
}

/** An agent's plan usage (account-wide), as last reported by any of its sessions. */
export interface AgentUsage {
  agent: AgentKind;
  plan: string | null; // "Max", "Plus" — null when the CLI didn't say
  limits: UsageLimit[];
  at: number; // epoch ms of the report
}

/**
 * How full one session's context window is, as its agent last reported it.
 * "none": nothing to show, and `why` says so plainly; "error": the report
 * couldn't be read (the main process logged it).
 */
export type ContextWindow =
  | {
      state: "reading";
      agent: AgentKind;
      tokens: number;
      window: number;
      at: number;
      /** The model of the last reply, when the agent reports it. */
      model?: string;
      /** Claude's prompt cache as of the last reply: warm, and when it goes cold (ms). */
      cache?: { warm: boolean; expiresAt: number | null; recacheTokens: number | null };
      /** Claude's own running cost of the CLI process (statusline cost.total_cost_usd, API list prices): a resume starts it over. */
      costUsd?: number;
    }
  | { state: "none"; why: string }
  | { state: "error"; why: string };

export interface UsageReport {
  claude: AgentUsage | null;
  codex: AgentUsage | null;
}

/** Tokens summed over replies. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  replies: number;
}

/** A pane's token meter: all its conversations, and its estimated share of the plan's current 5-hour window. */
export interface SessionMeter {
  agent: AgentKind | null;
  tokens: TokenCounts;
  window: {
    tokens: number;
    /** Estimated % of the 5-hour limit this pane used in the current window; null when nothing on this Mac used it. */
    sharePct: number | null;
    /** The whole window's reported use, % of the limit. */
    usedPct: number;
    resetsAt: number;
  } | null;
}

export const totalTokens = (t: TokenCounts) => t.input + t.output + t.cacheRead + t.cacheWrite;

/** 1.2M, 340k, 980. */
export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/** A share of the limit: whole numbers from 10%, one decimal below, and "<0.1%" for a sliver. */
export function formatShare(pct: number): string {
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 0.1) return `${(Math.round(pct * 10) / 10).toFixed(1)}%`;
  return pct > 0 ? "<0.1%" : "0%";
}

/** "max" → "Max". */
export const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The local calendar day as yyyy-mm-dd — what dated files are named by (toISOString would give the UTC day). */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The sessions of a group or ticket, summed over their conversations (each counted once). */
export interface GroupMeter {
  sessions: number;
  tokens: TokenCounts;
  /** By agent: tokens in its current 5-hour window, and their estimated share of its limit. */
  window: Partial<Record<AgentKind, { tokens: number; sharePct: number | null }>>;
}

export interface Meters {
  /** By pane (session id). */
  sessions: Record<string, SessionMeter>;
  /** By top-level group (its key). Optional: a meter from before groups were summed has none. */
  groups?: Record<string, GroupMeter>;
  /** By ticket id (without "#"): sessions with that ticket, or in a group named after it. */
  tickets?: Record<string, GroupMeter>;
  /** Since local midnight, per agent. */
  today: Partial<Record<AgentKind, TokenCounts>>;
  at: number;
}

export const DEFAULT_SETTINGS: Settings = {
  repoRoots: ["~/Code", "~/Personal Projects"],
  workTrackerPath: "~/Code/WorkTracker",
  claudeBin: "claude",
  codexBin: "codex",
  debriefs: { enabled: false, morning: "09:00", wrapUp: "16:00" },
  notifications: true,
};

/** A ticket id without the "#" it may be typed or kept with: "#5038" → "5038". */
export const ticketIdOf = (id: string): string => id.replace(/^#/, "");

/** An Azure DevOps work item id: digits only, as a group named after a ticket is. */
export const isWorkItemId = (id: string): boolean => /^\d+$/.test(id);

/** The ticket a session counts toward: its own, or its group's when that's named after a work item (as the meters count). */
export function ticketOfSession(s: Partial<Pick<SessionInfo, "ticketId" | "taskGroup">>): string | null {
  if (s.ticketId) return ticketIdOf(s.ticketId);
  const top = s.taskGroup ? topOfKey(s.taskGroup) : "";
  return top && isWorkItemId(top) ? top : null;
}

/** Every ticket a session works on: an Orchestrator's several (SessionInfo.tickets), else ticketOfSession's one, else none. */
export function ticketsOfSession(s: Partial<Pick<SessionInfo, "ticketId" | "taskGroup" | "tickets">>): string[] {
  if (s.tickets?.length) return [...new Set(s.tickets.map(ticketIdOf))];
  const one = ticketOfSession(s);
  return one ? [one] : [];
}

export function slugBranch(ticketId: string, ticketTitle: string): string {
  const slug = ticketTitle
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${ticketIdOf(ticketId)}-${slug}`;
}

/** "Filter orgs by foundation" → "filterOrgsByFoundation" (branch-friendly): a ticket's short name, as its branch's. */
export function suggestTicketName(title: string): string {
  const words = title.replace(/[^a-zA-Z0-9 ]+/g, " ").trim().split(/\s+/).slice(0, 5);
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join("");
}

/** A not-started step's title as its branch name's last part (`<the step before's branch>-<this>`): "Run e2e tests" → "run-e2e-tests". */
export function stepSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "step";
}

// ---- ticket pipeline ----------------------------------------------------------
// Where each ticket actually is, kept locally (~/.mockingbird/pipeline.json):
// nothing reaches Azure DevOps except comments and pull requests the user
// approves one by one.

/**
 * The delivery stages, in order. `step` is a stage's place on the rail: 1–8, then Done (9). Stakeholder testing's
 * approval and its PR to main are stages of their own inside step 6. An id keeps its meaning for good, because
 * pipeline.json is never migrated: a build reads the ids it knows and shows any other as itself.
 */
export const TICKET_STAGES = [
  { id: "ba", label: "BA", step: 1 },
  { id: "coding", label: "Coding", step: 2 },
  { id: "local-test", label: "Local testing", step: 3 },
  { id: "pr-dev", label: "PR to dev", step: 4 },
  { id: "dev-test", label: "AI testing in dev/UAT", step: 5 },
  { id: "stakeholder", label: "Stakeholder testing", step: 6 },
  { id: "approved", label: "Approved", step: 6 },
  { id: "pr-main", label: "PR to main", step: 6 },
  { id: "prod-test", label: "AI testing in staging/prod", step: 7 },
  { id: "comms", label: "Patch notes", step: 8 },
  { id: "done", label: "Done", step: 9 },
] as const;
export type TicketStage = (typeof TICKET_STAGES)[number]["id"];
/** A stage id as pipeline.json holds it: one of TICKET_STAGES, or a newer build's, which is kept as it is. */
export type StoredStage = TicketStage | (string & {});
export const isTicketStage = (s: unknown): s is TicketStage => TICKET_STAGES.some((x) => x.id === s);
/** A stage's name; an id this build doesn't know is shown as itself, as text whatever the file held. */
export const stageLabel = (s: StoredStage): string => TICKET_STAGES.find((x) => x.id === s)?.label ?? String(s);
/** A stage's place on the rail (1–8, Done 9), or null for an id this build doesn't know. */
export const stageStep = (s: StoredStage): number | null => TICKET_STAGES.find((x) => x.id === s)?.step ?? null;
/** `by` for a move or a tick made in the window. */
export const BY_YOU = "you";
/** `by` for a move a pull request merging made (prWatch.ts): neither the user's nor an agent's. */
export const BY_MERGE = "merge";
/** `by` for an agent's change: its workspace's title (one plain line), as an agent's, so it never reads as the user's. */
export const agentNamed = (title: string): string => `${title || "an unnamed workspace"}'s agent`;

export type PrTarget = "dev" | "main";

export interface PipelinePr {
  target: PrTarget;
  provider: "ado" | "github";
  id: number;
  url: string;
  repo: string;
  branch: string;
  base: string;
  at: number;
  /** The Summary section of its description, for the ticket comment and the comms draft. */
  summary?: string;
  /**
   * The session that asked for it, by id: the one whose request_pr it answered, else the one it was opened from. Its
   * approval's line goes there (pipeline:approve). Absent on PRs from before it was kept.
   */
  by?: string;
  /** The folder it was opened from, where the merge watch reads it (prWatch.ts). Absent on PRs from before W16. */
  root?: string;
  /** When it merged, as its provider says (or when the user marked it merged), and its merge commit when that's known. */
  mergedAt?: number;
  /** The provider gave no time: `mergedAt` is when the merge watch saw it merged, so a wire takes it as old. */
  mergedAtUnknown?: true;
  mergeCommit?: string;
  /** Set when the user marked it merged (BY_YOU) rather than the provider saying so. */
  mergedBy?: string;
  /** When it was closed without merging. */
  closedAt?: number;
  /** The merge watch's failed reads in a row, the last one's reason and when: gone once a read works. */
  watch?: PrWatchFailure;
}

/** The merge watch couldn't read a pull request: how many times in a row, why the last time, and when. */
export interface PrWatchFailure {
  failures: number;
  why: string;
  at: number;
}

/** Whether `x` is a failure as the merge watch keeps one: a hand-edited or older shape isn't, and is let go on reading. */
export const isPrWatchFailure = (x: unknown): x is PrWatchFailure =>
  !!x && typeof x === "object" && Number.isInteger((x as PrWatchFailure).failures) && (x as PrWatchFailure).failures >= 1 && typeof (x as PrWatchFailure).why === "string" && Number.isFinite((x as PrWatchFailure).at);

/** Failed reads in a row after which a pull request the merge watch can't read needs the user (Needs you, a notice). */
export const PR_WATCH_NEEDS_YOU = 3;

/** A pull request's repository as pipeline.json records it: a ticket can span repositories, each with the ticket's branch name. */
export type PrRepo = Pick<PipelinePr, "provider" | "repo">;

/** Whether two pull requests come from the same repository and branch. */
export const samePrPlace = (a: Pick<PipelinePr, "provider" | "repo" | "branch">, b: Pick<PipelinePr, "provider" | "repo" | "branch">): boolean =>
  a.provider === b.provider && a.repo === b.repo && a.branch === b.branch;

/**
 * The latest pull request to `target` among `prs` that `of` keeps (by when it was opened), or null. The ticket's latest
 * to a target is the one whose merge moves it on; an older one's merge is history.
 */
export function latestPr(prs: readonly PipelinePr[], target: PrTarget, of: (pr: PipelinePr) => boolean = () => true): PipelinePr | null {
  let best: PipelinePr | null = null;
  for (const x of prs) if (x.target === target && of(x) && (!best || x.at > best.at)) best = x;
  return best;
}

/**
 * Whether pull request `pr` on ticket `p` needs the user: the merge watch failed to read it PR_WATCH_NEEDS_YOU times in a
 * row, or it was closed without merging and no later one from its repository and branch to its target has replaced it.
 * Check now and Mark merged… are its actions (its row in the pipeline panel, pipelinePrCheck, pipelinePrMarkMerged). A
 * Done ticket's never do.
 */
export function prNeedsYou(p: TicketPipeline, pr: PipelinePr): boolean {
  if (p.stage === "done" || pr.mergedAt) return false;
  if ((pr.watch?.failures ?? 0) >= PR_WATCH_NEEDS_YOU) return true;
  return !!pr.closedAt && latestPr(p.prs, pr.target, (x) => samePrPlace(x, pr)) === pr;
}

/**
 * What Mark merged… asks about pull request `pr` (markMergedQuestion): `closed:<when>` once its provider said it was
 * closed without merging, else `unread` while the watch can't read it, else null. The window sends what it asked, and
 * main marks only while it's still that: a read in between (a Check now queued ahead) refuses the mark.
 */
export function prAskedState(pr: Pick<PipelinePr, "mergedAt" | "closedAt" | "watch">): string | null {
  if (pr.mergedAt) return null;
  if (pr.closedAt) return `closed:${pr.closedAt}`;
  return pr.watch ? "unread" : null;
}

/** An agent's request for a pull request (request_pr), held until the user opens it or dismisses it. One per target. */
export interface PipelineRequest {
  id: string;
  target: PrTarget;
  /** The session that asked, by id, and its title then. */
  from: string;
  fromTitle: string;
  /** Written by the agent, redacted. */
  title: string;
  description: string;
  at: number;
}

/** An agent's report on a gate item (gate_notes): what it did, and its evidence. */
export interface GateNote {
  by: string;
  note: string;
  at: number;
}

/**
 * Who a window call's line to an agent reached (pipeline:approve, pipeline:request:dismiss): `told` is how it went,
 * as deliverAgentMessage says; `notTold` why nobody was, and `reopen` when reopening the session would let it hear.
 */
export type AgentTold = { to: string; title: string; told: string } | { to: string | null; title: string | null; notTold: string; reopen?: true };

/** A comment drafted when a ticket reaches a stage; it posts to ADO only when the user clicks Post. */
export interface CommentDraft {
  id: string;
  stage: StoredStage;
  text: string;
  at: number;
  /**
   * Who wrote it, when an agent did ("Verifier's agent"), or whose move drafted it: an ADO comment is read by others.
   * The user's edit makes it theirs, so both go.
   */
  by?: string;
  /** The session whose agent wrote it, by id (write_patch_notes). */
  from?: string;
}

/** Who ticked a gate's item, and when. */
export interface GateTick {
  by: string;
  at: number;
}

/**
 * One ticket's record in pipeline.json. Every field added after 1.6.0 is optional, and a build keeps fields and
 * stage ids it doesn't know, so 1.6.0 and later builds read and write the same file.
 */
export interface TicketPipeline {
  ticketId: string;
  title?: string;
  stage: StoredStage;
  /** Every move; `by` is who made it (BY_YOU for the window), absent on moves from before it was kept. */
  history: { at: number; stage: StoredStage; note?: string; by?: string }[];
  prs: PipelinePr[];
  /** `by`: who wrote it, when it isn't the user (an agent's move back to Coding). */
  feedback: { at: number; text: string; by?: string }[];
  drafts: CommentDraft[];
  /** Promotion-gate checklist ticks, keyed "<gate>:<item>". Only `true` is kept: unticking deletes the key. */
  checks: Record<string, boolean>;
  /**
   * Who ticked each item, beside `checks` rather than in it so 1.6.0 still reads `checks` as booleans. An entry
   * counts only while its item is ticked (tickOf), since 1.6.0 unticks without touching it.
   */
  checkedBy?: Record<string, GateTick>;
  /** Agents' reports against the checklists, keyed "<gate>:<item>" as `checks` (gate_notes). */
  gateNotes?: Record<string, GateNote>;
  /** Items the user unticked, keyed as `checks`, and the stage then: no agent ticks them again until the user ticks them or moves the ticket. */
  unticked?: Record<string, { at: number; stage: StoredStage }>;
  /** Agents' pull request requests waiting for the user (request_pr): one per target. */
  requests?: PipelineRequest[];
}

/** Who ticked a gate item that's ticked; null for one that isn't, or one ticked before authors were kept. */
export const tickOf = (p: TicketPipeline, key: string): GateTick | null => (p.checks?.[key] ? (p.checkedBy?.[key] ?? null) : null);

/**
 * The promotion gates (local → dev/UAT → staging → production) and what each
 * should have before a ticket moves on, plus the clean-code review.
 */
export const GATES: { id: "dev" | "staging" | "prod"; title: string; at: TicketStage; items: { key: string; label: string; person?: true; short?: string }[] }[] = [
  {
    id: "dev",
    title: "Before the PR to dev/UAT",
    at: "local-test",
    items: [
      { key: "tests", label: "Tests pass" },
      { key: "smoke", label: "Smoke-tested the feature locally" },
      { key: "security-doc", label: "Security considerations doc drafted" },
      { key: "silent-failures", label: "No silent failures: every catch logs, rethrows or surfaces" },
      { key: "dry", label: "No duplicated logic; existing helpers reused" },
      { key: "comments", label: "Comments explain the code, not the conversation" },
    ],
  },
  {
    id: "staging",
    title: "Before the PR to main",
    at: "approved",
    items: [
      { key: "peer-review", label: "Peer review completed", person: true, short: "peer review" },
      { key: "security-reviewed", label: "Security considerations doc reviewed, not just drafted", person: true, short: "security doc reviewed" },
      { key: "endpoints", label: "New endpoints verified for the right auth state" },
      { key: "secrets", label: "No hardcoded secrets, credentials or environment-specific values" },
    ],
  },
  {
    id: "prod",
    title: "Before production",
    at: "prod-test",
    items: [
      { key: "inventory", label: "Endpoint inventory updated for new routes" },
      { key: "sign-off", label: "Approver sign-off obtained", person: true, short: "sign-off" },
      { key: "rollback", label: "Rollback plan noted, if the change is high risk" },
    ],
  },
];

/** The gate keys ("<gate>:<item>") that are ticked; a gate this build doesn't know isn't counted. */
const gateKeysTicked = (p: TicketPipeline): string[] => Object.keys(p.checks ?? {}).filter((k) => p.checks[k] && GATES.some((g) => k.startsWith(`${g.id}:`)));

/** How many gate items are ticked. */
export const gateTicks = (p: TicketPipeline): number => gateKeysTicked(p).length;

/**
 * Whether a move from `from` to `to` clears the gates' ticks: going back to Coding from anywhere past BA means the
 * work changes, so ticks taken before it would read as evidence about work that isn't there any more.
 */
export const clearsGates = (from: StoredStage, to: TicketStage): boolean => to === "coding" && from !== "ba" && from !== "coding";

/**
 * Untick every gate item and forget who ticked it and agents' notes on it, for a ticket going back to Coding. Keys of
 * gates this build doesn't know are left alone. Returns the line its history entry keeps, or null when nothing was
 * ticked.
 */
export function clearGateTicks(p: TicketPipeline): string | null {
  const counts = GATES.map((g) => {
    const prefix = `${g.id}:`;
    const ticked = gateKeysTicked(p).filter((k) => k.startsWith(prefix)).length;
    for (const k of Object.keys(p.checks)) if (k.startsWith(prefix)) delete p.checks[k];
    for (const k of Object.keys(p.checkedBy ?? {})) if (k.startsWith(prefix)) delete p.checkedBy![k];
    for (const k of Object.keys(p.gateNotes ?? {})) if (k.startsWith(prefix)) delete p.gateNotes![k];
    return { title: g.title, ticked };
  }).filter((c) => c.ticked > 0);
  return counts.length ? `Gate ticks cleared: ${counts.map((c) => `${c.title} (${c.ticked})`).join(", ")}` : null;
}

/** The person items ticked on `p`, by their short names: they vouch for code a rework will change. */
export const personTicks = (p: TicketPipeline): string[] =>
  GATES.flatMap((g) => g.items.filter((i) => i.person && p.checks?.[`${g.id}:${i.key}`]).map((i) => i.short ?? i.label));

/** What the user is asked about the person ticks an agent's move back kept, or null when none is ticked. */
export const keptTicksLine = (kept: readonly string[]): string | null =>
  kept.length ? `Your ticks were kept: ${kept.join(", ")}; untick them if the rework needs a new review.` : null;

/**
 * An agent's move back to Coding: only agents' ticks go, and agents' notes on every item, as evidence about work that's
 * changing. The user's ticks stay, as do a person's items' and those from before authors were kept, which no agent
 * made. Returns the line its history entry keeps, naming each tick cleared and whose it was and the person ticks kept,
 * or null when there's neither.
 */
export function clearAgentTicks(p: TicketPipeline): string | null {
  const cleared: string[] = [];
  for (const g of GATES) {
    for (const i of g.items) {
      const key = `${g.id}:${i.key}`;
      const tick = tickOf(p, key);
      if (!tick || tick.by === BY_YOU || i.person) continue;
      delete p.checks[key];
      delete p.checkedBy![key];
      cleared.push(`"${i.label}" (ticked by ${tick.by})`);
    }
  }
  for (const k of Object.keys(p.gateNotes ?? {})) if (GATES.some((g) => k.startsWith(`${g.id}:`))) delete p.gateNotes![k];
  return [cleared.length ? `Agents' ticks cleared: ${cleared.join(", ")}.` : null, keptTicksLine(personTicks(p))].filter(Boolean).join(" ") || null;
}

/** What creating a pull request needs to know about a session's worktree. */
export interface PrPreflight {
  branch: string | null;
  /** The branch the PR merges into, as it exists on origin (null when none of the usual names do). */
  base: string | null;
  bases: string[];
  dirtyFiles: number;
  /** Commits on the branch that aren't on the base. */
  commits: number;
  remote: { provider: "ado" | "github"; repo: string } | null;
  /** The ticket's Description.md, when one exists in the worktree. */
  docs: string | null;
  /** A pull request already open from this branch to the base. */
  existing: { id: number; url: string } | null;
  /** Why the branch can't be pushed into `base` (prBranchProblem), or null. */
  branchProblem?: string | null;
  /**
   * The branch main recorded for the session when it was made (SessionInfo.branch), when the worktree is on another:
   * pushing that one takes the user's say-so (PrCreate's `confirmBranch`). Absent while they're the same.
   */
  recordedBranch?: string | null;
  /** What a team room session's push would run (scmPush's `own`). Absent for a local session, whose push runs the user's hooks. */
  roomPush?: RoomPush;
}

/**
 * What a team room session's push runs (scmPush's `own`, a take-over backup's), said before it (the PR form) and after
 * it (Source Control): the user's global hooks folder whose pre-push runs (null: none does), the repository's folder
 * git would have run a pre-push from, set aside, and why (null: it holds none), and the repository's Git LFS files:
 * "none" kept, "push" (main uploads them first, git lfs push), or why it can't, when nothing is pushed.
 */
export interface RoomPush {
  runs: string | null;
  skipped: { value: string; why: string } | null;
  lfs: "none" | "push" | { refused: string };
}

/** RoomPush in the window's words, or null when there's nothing to say: no pre-push either way, and no LFS files. */
export function roomPushLine(p: RoomPush): string | null {
  const lfs = p.lfs === "push" ? " Its Git LFS files are uploaded first, with git lfs push." : "";
  const hooks =
    p.runs && p.skipped
      ? `Your global pre-push in ${p.runs} runs; the one in ${p.skipped.value} doesn't, for a room session's push: ${p.skipped.why}.`
      : p.runs
        ? `Your global pre-push in ${p.runs} runs for a room session's push; this repository's hooks don't.`
        : p.skipped
          ? `No pre-push runs for a room session's push: the one in ${p.skipped.value} doesn't, as ${p.skipped.why}.`
          : "";
  return `${hooks}${lfs}`.trim() || null;
}

/** The usual names of the branches work merges into, by team convention, each in the order it's preferred. */
export const BASE_NAMES: Record<PrTarget, string[]> = { dev: ["dev", "develop", "development", "uat"], main: ["main", "master"] };

/**
 * What Source Control's Push gives: where it pushed (and, for a team room session, what ran), or, for a room session
 * on a branch with a base's name or not its own, why it waits for the user's say-so: asked again with `branch`, it goes.
 */
export type ScmPushResult = { upstream: string; roomPush?: RoomPush } | { confirm: string; branch: string };

/** Azure DevOps keeps this many characters of a pull request's description: openPr shortens a longer one to fit. */
export const ADO_DESC_MAX = 4000;

/**
 * Why `branch` can't be pushed for a pull request into `base`, or null: it's the base, or it has a base's name
 * (BASE_NAMES, either target's, in any case: Azure DevOps reads branch names so). The push goes to origin under the
 * branch's own name, so it would land on that base directly. The worktree's agent picks the branch it's on.
 */
export function prBranchProblem(branch: string, base: string): string | null {
  const b = branch.toLowerCase();
  if (b !== base.toLowerCase() && ![...BASE_NAMES.dev, ...BASE_NAMES.main].includes(b)) return null;
  return `The worktree is on ${branch}, a base branch's name: pushing it would update origin's ${branch} directly. Move the work to a branch of its own first.`;
}

/**
 * Why pushing `branch` for a pull request takes the user's say-so, or null: it isn't `recorded`, the branch main made
 * the session on (SessionInfo.branch), or the session has none recorded. A `staging`, a `release/x` or a teammate's
 * branch fetched into the worktree would be pushed straight to origin under its own name.
 */
export function unrecordedBranch(branch: string, recorded: string | null): string | null {
  if (branch === recorded) return null;
  return `The worktree is on ${branch}, ${recorded ? `not ${recorded}, the branch this session was made on` : "and this session has no branch of its own recorded"}: pushing it updates origin's ${branch}.`;
}

/** A branch's pull request as the pane rail shows it. */
export interface PrState {
  id: number;
  url: string;
  title: string;
  base: string;
  state: "draft" | "open" | "approved" | "changes" | "merged" | "closed";
  /** It can't merge cleanly into its base. */
  conflicts: boolean;
  /** Reviewers and where each stands, e.g. "Sam: approved". */
  reviews: string[];
  /** Merged: its merge commit (ADO's lastMergeCommit, GitHub's mergeCommit) and when, where the provider says. */
  mergeCommit?: string;
  mergedAt?: number;
  /** Closed without merging: when, where the provider says. */
  closedAt?: number;
}

/** The lookup for a pane: its PR, none (`pr: null`), or why it couldn't be checked. */
export interface PrStatus {
  branch: string | null;
  pr: PrState | null;
  error?: string;
  at: number;
}

// ---- editor intelligence (language servers) -------------------------------------

export type LspServerId = "typescript" | "python" | "csharp";

/** What the editor knows about a file's language server. */
export interface LspFileState {
  /** No server covers this kind of file. */
  server: { id: LspServerId; label: string } | null;
  /** ready: running; install: not downloaded yet (the user is asked); missing: a prerequisite isn't on the Mac; failed: it didn't start. */
  state: "ready" | "install" | "missing" | "failed" | "none";
  /** Why it's missing or failed; for install, what would be downloaded ("pyright 1.1.414"). */
  message?: string;
}

/** A problem in a file, from its language server. */
export interface LspDiagnostic {
  range: LspRange;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
}

export interface LspCompletion {
  label: string;
  kind?: string;
  detail?: string;
  insertText: string;
  /** The range the completion replaces, when the server says (else the word before the cursor). */
  range?: LspRange;
  sortText?: string;
}

/** A place in a file, absolute. */
export interface LspLocation {
  path: string;
  line: number; // 1-based
  character: number; // 0-based UTF-16
}

/** Edits a rename makes, per absolute path. */
export interface LspFileEdits {
  path: string;
  edits: LspTextEdit[];
}

// ---- undo an agent's turn ---------------------------------------------------------

/** A turn's snapshot leaves out files bigger than this (named in `skipped`). */
export const SNAPSHOT_MAX_FILE_BYTES = 5 * 1024 * 1024;

/** The worktree's files as they were before one of a session's turns. */
export interface TurnSnapshot {
  n: number;
  sha: string;
  at: number;
  /** The prompt that started the turn. */
  prompt: string;
  /** Files over SNAPSHOT_MAX_FILE_BYTES that weren't recorded. */
  skipped: string[];
  /**
   * A team room session's changed files that weren't recorded because a filter Mockingbird doesn't run for a room
   * session keeps them (their filter attribute names one): stored without it, they'd be stored unfiltered.
   */
  filtered: string[];
  /** Taken just before a restore, so the restore can be undone. */
  beforeUndo: boolean;
}

/** What restoring a snapshot does to a file: put its old content back, or remove it (it's new since). */
export interface TurnChange {
  path: string;
  action: "restore" | "remove";
}

/** Files this session's worktree and another's (same repository) have both changed: a merge conflict waiting to happen. */
export interface FileOverlap {
  other: string;
  otherTitle: string;
  otherBranch: string | null;
  files: string[];
  // team rooms: set when the other side is a teammate's pushed branch (`other` is then no session here)
  /** The teammate whose pushed branch it is, and the room it's shared in. */
  teammate?: {
    id: string;
    name: string;
    roomId: string;
    /** Of `files`, those the teammate's session changed in uncommitted work (its snapshot, shared peer to peer). */
    uncommitted?: string[];
  };
}

/** Overlaps as the window shows them (overlaps:get, overlaps:changed). */
export interface OverlapReport {
  /** Per session: the other worktrees, and teammates' branches, that change files its worktree changes. */
  bySession: Record<string, FileOverlap[]>;
  /**
   * Per session: how many live worktrees of its repository, its own included, couldn't be read, so overlaps with them
   * are unknown rather than none. Absent when every one was read.
   */
  unread: Record<string, number>;
}

/** One agent-to-agent message, as the message log shows it. */
export interface AgentMessage {
  at: number;
  from: string;
  fromTitle: string;
  to: string;
  toTitle: string;
  text: string;
  /** How it was delivered ("submitted", "left in the prompt", "queued …"), or why it was refused. */
  outcome: string;
  refused?: boolean;
}

/** How agent messages arrive in a group's sessions: sent as a prompt, or typed in and left for the user. */
export type MessageMode = "send" | "prompt";

/**
 * What a broadcast did in one pane: submitted now, queued (the pane is busy,
 * or the user has unsent text in its prompt) until its turn ends, or skipped
 * (gone, a terminal, or a debrief).
 */
export interface BroadcastOutcome {
  id: string;
  outcome: "delivered" | "queued" | "skipped";
}
