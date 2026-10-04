/** Which coding-agent CLI a session runs. */
export type AgentKind = "claude" | "codex";

export type SessionStatus = "working" | "waiting" | "idle" | "dead";

export interface SessionInfo {
  id: string;
  title: string;
  model?: string | null; // persisted so relaunch resumes on the same model
  effort?: string | null;
  exitCode?: number | null; // set when the process ends; shown on the dead pane
  repoPath: string | null; // null for assistant/free sessions
  cwd: string; // where claude runs (worktree path, repo path, or WorkTracker)
  branch: string | null;
  ticketId: string | null;
  ticketTitle: string | null;
  taskGroup: string | null; // groups multiple sessions under one task
  status: SessionStatus;
  createdAt: number;
  kind: "work" | "assistant";
  extraDirs: string[];
  waitingReason: string | null; // hook Notification message, e.g. "permission: Bash"
  waitingSince: number | null; // ts of the waiting transition
  queuedCount?: number; // broadcasts queued for this session (live only)
  debrief?: boolean; // morning brief / wrap-up — lives on the WorkTracker tab, not the grid
  shell?: boolean; // plain terminal (no claude) — excluded from broadcasts/re-reads
  agent?: AgentKind; // absent on sessions persisted before Codex support — those are Claude
  /** The agent conversation last seen running in this pane (from its hook events) — what a relaunch resumes. */
  conversation?: { agent: AgentKind; id: string };
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

// ---- group paths -----------------------------------------------------------
// A session's taskGroup is a path: "5038" is a group, "5038/backend" is the
// "backend" workspace inside group 5038. Every producer and consumer of that
// string goes through these three helpers so the format has one definition.

/** A name typed by a user becomes one path segment — "/" is the separator. */
export function sanitizeSegment(name: string): string {
  return name.trim().replace(/\//g, "-");
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
  const t = sanitizeSegment(top);
  const s = sub ? sanitizeSegment(sub) : null;
  return s ? `${t}/${s}` : t;
}

/** Split a group key into its group and (optional) workspace. */
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
  debrief?: boolean; // marks WorkTracker debrief sessions
  baseBranch?: string; // new branch: fetch origin/<base> first and branch off it (dev/uat flow)
  initialPrompt?: string; // sent to the claude session once it's up (e.g. the ADO ticket)
  shell?: boolean; // open a plain zsh terminal instead of launching claude
  agent?: AgentKind; // which CLI to launch (default claude)
  /** Terminal sessions only: resume this conversation inside the shell, then drop back to the shell prompt. */
  shellResume?: { agent: AgentKind; id: string };
  model?: string; // claude --model (alias like "opus" or a full model id)
  effort?: string; // claude --effort (low | medium | high | xhigh | max)
}

export interface RepoBranches {
  branches: string[]; // union of local + origin branches
  defaultBase: string | null; // best guess dev/uat-style integration branch
}

export interface ImportableConversation {
  sessionId: string;
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
}

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
  error?: string;
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

export type RunStatus = "starting" | "running" | "stopping" | "stopped" | "failed";

/** One running (or last-run) service of one worktree. */
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
  /** A disposable git worktree of the repo where command-running models work; never the user's checkout. */
  workspacePath?: string | null;
  /** A model's tool calls waiting for the user to allow or deny them (gone if the app quits). */
  pending?: CollabPermissionRequest[];
  /** Kinds of call the user chose to always allow in this room, e.g. "Bash: docker exec". */
  allowKinds?: string[];
  /** How long a model's request waits for the user before it counts as no (default 10). */
  askTimeoutMin?: number;
  createdAt: number;
}

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

/** One plan rate-limit window, e.g. the 5-hour limit or the weekly one. */
export interface UsageLimit {
  label: string; // "5-hour limit", "Weekly · all models", "Weekly · Opus"
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

export interface UsageReport {
  claude: AgentUsage | null;
  codex: AgentUsage | null;
}

export const DEFAULT_SETTINGS: Settings = {
  repoRoots: ["~/Code", "~/Personal Projects"],
  workTrackerPath: "~/Code/WorkTracker",
  claudeBin: "claude",
  codexBin: "codex",
  debriefs: { enabled: false, morning: "09:00", wrapUp: "16:00" },
  notifications: true,
};

export function slugBranch(ticketId: string, ticketTitle: string): string {
  const slug = ticketTitle
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${ticketId.replace(/^#/, "")}-${slug}`;
}
