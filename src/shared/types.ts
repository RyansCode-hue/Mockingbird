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
  ahead: number;
  behind: number;
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
}

/** M modified · A added · D deleted · R renamed · U untracked */
export type GitChangeStatus = "M" | "A" | "D" | "R" | "U";

export interface GitChange {
  path: string;
  from?: string; // previous path of a rename
  status: GitChangeStatus;
}

/** "working" = uncommitted vs HEAD · "branch" = everything since the fork from the base branch */
export type ChangeScope = "working" | "branch";

export interface GitChanges {
  changes: GitChange[];
  base: string; // what the changes are measured against
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

/** One plan rate-limit window, e.g. the 5-hour limit or the weekly one. */
export interface UsageLimit {
  label: string; // "5-hour limit", "Weekly · all models", "Weekly · Opus"
  usedPct: number; // 0-100
  resetsAt: number | null; // epoch ms
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
