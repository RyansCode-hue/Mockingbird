import * as pty from "node-pty";
import { randomUUID } from "crypto";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { WebContents } from "electron";
import { SessionInfo, SessionStatus, NewSessionRequest, asQuitAgent, type AgentQuit, type RelaunchChange, slugBranch, stepSlug, ticketIdOf, ticketOfSession, AgentKind, AGENT_KINDS, HELPDESK_IN_ROOM, HELPDESK_START_IN_ROOM, HELPDESK_STARTING, helpdeskOpenAlready, type AgentUpdateNotice, type BroadcastOutcome, type MissingFolder, type PlannedStep, type PlanRequest, type SessionRole } from "../shared/types";
import { Store, expandHome, MB_DIR } from "./store";
import { createWorktree, checkoutBranch, dropNewWorktree, isBranchName, worktreeRoot } from "./worktrees";
import { dirtyFileCount } from "./scm";
import { BASE_NAMES, branchesOf, currentBranch, git } from "./git";
import { uniqueBranch } from "./presets";
import { roomFolderRefusal, samePath } from "./handlers";
import { adoEnv } from "./ado";
import { agentFor, agentLabel, AgentAdapter, listsChromeFlag, permissionModeRefusal, readRelaunchChange, type LaunchContext } from "./agents";
import { isPermissionMode, WIDER_MODES, type PermissionMode } from "../shared/permissionModes";
import { HELPDESK_FOLDER_ONLY, HELPDESK_RULES, helpdeskFolder, inHelpdeskFolder, readClaudeHelp } from "./helpdesk";
import { which, whichSync, quote } from "./shell";
import { bindMcpLaunch, mcpLaunch, retireMcpLaunch, type McpLaunch } from "./messaging";
import { RoomSandboxWatch, SANDBOX_REPORT_MS } from "./roomSandboxWatch";
import { probeRoomSandbox, writtenSandbox, type SandboxProbe, type SandboxVerdict } from "./claudeSandboxProbe";
import { BinPins, readVersionAt } from "./binPins";
import { claudeSandboxSources, SettingsWatch, SETTINGS_POLL_MS, SETTINGS_SETTLE_MS } from "./claudeSettingsWatch";
import { CodexFolderNotice } from "./codexFolderNotice";
import { conversationsOf, withConversation } from "./meters";
import { writeFileAtomic } from "./fileOps";
import { compactBlocker } from "../shared/contextBudget";
import { tildePath } from "../shared/paths";
import { isRemotePaneId, type PaneSnapshot, type RoomSandboxChange } from "../shared/team/livePanes";

const BUFFER_MAX = 400_000; // bytes of scrollback kept per session for re-render
/** How much of a closed session's saved output its ghost card reads: its last screens, far more than its last line needs. */
export const CLOSED_OUTPUT_MAX = 32_000;

/** A tail cut from mid-line, from just after its first line break where one comes before its end (no half line, no split escape). */
const fromLineStart = (cut: string): string => {
  const nl = cut.indexOf("\n");
  return nl >= 0 && nl < cut.length - 1 ? cut.slice(nl + 1) : cut;
};
/** The end of `text`, at most `max` characters, from the start of a line where one starts within it. */
export function tailOf(text: string, max: number): string {
  return text.length <= max ? text : fromLineStart(text.slice(-max));
}
/** How long after an agent's start hook its prompt is ready to take a queued message. */
const STARTED_SETTLE_MS = 1500;
/** What of a teammate's typing is held while a Codex's folder notice is up (writeFromTeammate). */
const MAX_HELD_INPUT = 64 * 1024;

/**
 * Where a relaunched pane's earlier output ends: cursor shown and attributes
 * reset (whatever the old program left on), then a dim divider line. Leaving
 * the alternate screen also restores the cursor saved on entering it, so it's
 * only sent when the earlier output is still in there — otherwise the cursor
 * would jump to the top and the divider overwrite the history.
 */
/**
 * When a pane's turn last ended, after a hook moves it to `ev.status`: a Stop (`finished`) marks it, once (a second
 * Stop while it's still idle keeps the first time); any other status clears it, and so does an agent starting, since
 * a new or cleared conversation has finished nothing; the idle reminder leaves it as it was.
 */
export function finishedAtAfter(prev: Pick<SessionInfo, "status" | "finishedAt">, ev: { status: SessionStatus; finished?: boolean; started?: boolean }, now: number): number | null {
  if (ev.status !== "idle" || ev.started) return null;
  if (ev.finished) return prev.status === "idle" && prev.finishedAt ? prev.finishedAt : now;
  return prev.finishedAt ?? null;
}

/** `what`: what happened to the earlier output's program, said on the divider; when it restarted otherwise. */
export function restartDivider(at: Date, earlier: string, what?: string): string {
  const entered = Math.max(earlier.lastIndexOf("\x1b[?1049h"), earlier.lastIndexOf("\x1b[?1047h"), earlier.lastIndexOf("\x1b[?47h"));
  const left = Math.max(earlier.lastIndexOf("\x1b[?1049l"), earlier.lastIndexOf("\x1b[?1047l"), earlier.lastIndexOf("\x1b[?47l"));
  const when = at.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `${entered > left ? "\x1b[?1049l" : ""}\r\n\x1b[?25h\x1b[0m\x1b[2m── ${what ?? `restarted ${when}`} · earlier output above ──\x1b[0m\r\n\r\n`;
}

/** Something Mockingbird did while starting a pane that its user should know about, as the pane shows it above the agent's output. */
/**
 * A message's text as it may be pasted into an agent's prompt: lines and tabs
 * kept, every other control character gone — ESC above all, so nothing in it
 * can end the bracketed paste (ESC [ 201 ~) and go on as keys typed into the
 * pane, and no carriage return can press Enter inside it. C1 controls go
 * too (0x9b is a one-byte CSI to a terminal that reads 8-bit controls).
 */
export function pasteText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export const paneNotice = (text: string): string => `\x1b[0m\x1b[33m${text.replace(/\r?\n/g, "\r\n")}\x1b[0m\r\n\r\n`;

/**
 * The app's environment minus any Claude Code session markers. When Mockingbird
 * is started from inside a Claude Code session, those markers (CLAUDECODE,
 * CLAUDE_CODE_CHILD_SESSION, the parent's session id and messaging socket)
 * would make every pane a child of that session: transcripts go unsaved, so
 * nothing can be resumed. Panes start login shells, which re-apply anything the
 * user sets in their own profile.
 */
export function paneEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === "CLAUDECODE" || /^CLAUDE_(CODE_|PID$|EFFORT$|AGENT_SDK_|PREVIEW_)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

/** The terminal type every pty Mockingbird starts reports: xterm.js speaks xterm-256color's sequences. */
export const PTY_TERM = "xterm-256color";

/**
 * paneEnv for a process running on one of Mockingbird's terminals. xterm.js
 * draws 24-bit colour (still held to the theme's minimum contrast), so programs
 * are told so; a login shell's profile or a launch's own env can still set
 * COLORTERM otherwise.
 */
export function terminalEnv(): Record<string, string> {
  return { ...paneEnv(), COLORTERM: "truecolor" };
}

/** How a queued message ended: submitted, left in the prompt unsent, or never submitted. */
export type QueueOutcome = "sent" | "placed" | "failed";

/**
 * What a queued message's sender hears of it (a wire's delivery, wireDelivery.ts). `pasting` is asked just before its
 * paste, so the sender can write that down first: false keeps it out of the pane, and nothing more is told. Then
 * `settled` once, with why for placed and failed. A message with a receipt is never kept for a later launch: closing,
 * restarting or replacing its pane, or its agent exiting, fails it.
 */
export interface QueueReceipt {
  pasting(): boolean;
  settled(outcome: QueueOutcome, why?: string): void;
}

/** A pane as a receipt's reason names it. */
const paneName = (i: Pick<SessionInfo, "title" | "ticketTitle">): string => `“${i.ticketTitle ?? i.title}”`;

/** A message waiting for its pane's turn to end; `from` is the local session that sent it, `at` when. */
/**
 * `key`: Mockingbird's own notice (deliverNotice), which a newer one under the same key replaces while it waits.
 * `receipt`: what becomes of it is told there (QueueReceipt).
 */
type Queued = { text: string; submit: boolean; at: number; from?: string; overdueTold?: boolean; key?: string; receipt?: QueueReceipt };

/** A queued agent message that has waited longer than it should (see SessionManager.overdueMessages). */
export interface OverdueMessage {
  from: string;
  to: string;
  toTitle: string;
  toStatus: SessionStatus;
  /** The target's status can't be trusted: its agent's hooks never reported (SessionInfo.hooksSilent). */
  hooksSilent: boolean;
  waitedMs: number;
  /** The target is a terminal now, this agent having quit: the message waits for that agent's next launch. */
  quit?: AgentKind;
}

/**
 * Teammates' room sessions shown in this window (team rooms): they run on
 * their owners' Mockingbirds, so typing, scrollback and muting go there.
 */
export interface RemotePanes {
  has(id: string): boolean;
  write(id: string, data: string): void;
  buffer(id: string): Promise<string>;
  setMuted(id: string, muted: boolean): void;
}

/** What a session in a room's shared group is started with (team rooms). */
export interface RoomLaunch {
  env: Record<string, string>;
  /** Claude permission rules denying file reads (--disallowedTools). */
  denyReads: string[];
  /** Codex -c settings that run it in the room's sandbox (codexRoomSandbox.ts). */
  codexPermissions: string[];
  /** Claude --settings that run it in the room's sandbox (claudeRoomSandbox.ts); null for anything but Claude. */
  claudeSettings: Record<string, unknown> | null;
  /** What the agent starts knowing about the room (its House board and artifact tools, and Codex its sandbox); null for a terminal, or when there's nothing. */
  instructions: string | null;
  /** Mockingbird MCP tools the agent may call without asking (the House board's and the room artifacts'). */
  allowTools: string[];
  /** Codex runs inline (Claude's switch is in env): teammates' copies hold its history. */
  inline: boolean;
  /**
   * secrets: it runs under the room's settings (Claude: its sandbox and deny rules, or with the room's sandbox switched
   * off, its deny rules alone; Codex: its permission profile).
   * starting: a Claude launch whose sandbox hasn't reported in yet (RoomSandboxWatch), shown only on this Mac.
   * unsandboxed: an agent pane started with its room's sandbox switched off on this Mac (Settings.roomsUnsandboxed).
   * outside: guardsOf only, an unsandboxed launch whose room has its sandbox on now (outsideRoomSandbox).
   */
  guards: { secrets: boolean; coauthors: boolean; starting?: boolean; unsandboxed?: true; outside?: true };
  /** The marker a Claude launch's sandbox settings report with (RoomSandboxWatch); null when none is awaited. */
  sandboxMarker: string | null;
  /** Environment on the agent's own command, not its pane's shell: the room's caches (roomCacheEnv). */
  agentEnv: Record<string, string>;
  /** A Codex that opens its folders untrusted, so with its folder notice to answer first (CodexFolderNotice). */
  codexFolderNotice: boolean;
  /** Its folders held to having no repository, kept on its record for every relaunch (SessionInfo.noRepo). */
  noRepo?: string[];
}

/** Where a session would run, for deciding its room launch. */
export interface LaunchTarget {
  id: string;
  /** Its group key ("5110", "5110/api"), or null. */
  group: string | null;
  /** null for a terminal. */
  agent: AgentKind | null;
  /** A terminal's: the agent whose conversation it brings back, which runs under the room's settings too. */
  resumes?: AgentKind | null;
  /** The agent CLI's installed version (a terminal's: the one it brings back), when it could be read. */
  agentVersion: string | null;
  /** The folder it starts in. */
  cwd: string;
  /** The repository it was opened on (its worktree's, when it has one); null outside one. */
  repoPath?: string | null;
  /** More folders it works in (--add-dir). */
  extraDirs?: string[];
  /** Its folders that had no repository at its first room launch, as its record keeps them (SessionInfo.noRepo). */
  noRepo?: string[];
}

interface LiveSession {
  /** Its MCP server's launch, whose token goes when this pty does; terminals have none. */
  mcp?: McpLaunch;
  info: SessionInfo;
  proc: pty.IPty;
  buffer: string;
  queued: Queued[]; // messages to deliver when idle
  lastInput: number; // ms of the user's last write into this pane, or of a message placed there for them to send
  draft: boolean; // the prompt holds unsent text: typed since the user's last Enter, or a message placed for them
  flushTimer: NodeJS.Timeout | null; // retry while the user is typing
  lastOutput: number; // ms of the pty's last output — a working pane that goes quiet may be stuck
  outputs: number; // chunks of output so far
  saved: number; // `outputs` when its scrollback was last written to disk
  epoch: string; // this pty's id: a relaunch under the same session id is a new epoch
  total: number; // characters this pty's buffer has taken in, including what it started with
  cols: number;
  rows: number;
  guards: RoomLaunch["guards"] | null; // set when it was started as a room session
  roomSandboxed: boolean; // an agent pane started with a room's sandbox settings (Claude's --settings, Codex's profile)
  sandbox: RoomSandboxWatch | null; // a Claude room launch's sandbox, until and once it reports in
  sandboxCheck: SandboxProbe | null; // how its sandbox is checked, asked again when Claude Code's settings change, while it runs
  folderNotice: CodexFolderNotice | null; // a Codex room launch's folder notice: nothing is typed in while it holds
  heldInput: string[]; // a teammate's typing while the folder notice holds, typed once it's gone
  hookEvents: number; // hook events routed to this pty since it started
  transcripts: Map<string, string>; // conversation id → the transcript file its hooks named, the newest few
  kickoff: boolean; // its initial prompt is still to be typed in
  startTimer: NodeJS.Timeout | null; // delivers queued messages once a just-started agent has drawn its prompt
  compactSentAt: number | null; // when Compact (usage warnings) last sent /compact here
  prompts: number; // prompts its agent has taken this launch (UserPromptSubmit), Mockingbird's own notices not counted
  ownPrompts: number; // notices submitted whose UserPromptSubmit hasn't come yet: those prompts aren't counted
  promptAt: number | null; // when the latest of those prompts came (SessionInfo.promptAt)
  toTerminal: boolean; // its agent quit and the terminal it becomes is starting (toTerminal): its pty has exited
}

/** Why a pane can't be resumed, relaunched or restarted while a resume of it is under way (SessionManager.resume). */
const BEING_RESUMED = "It's being resumed already";
/** Why a pane can't be relaunched, resumed, restarted or forgotten while a relaunch of it is under way (SessionManager.relaunch). */
const BEING_RELAUNCHED = "It's being reopened already";
/** Why a not-started step can't be started again, reopened or forgotten while its start is under way (SessionManager.startPlanned). */
const BEING_STARTED = "It's being started already";
/** Why a not-started step can't go in a stack's group: a stack holds running sessions' tabs, and a step has none to show. */
const STEP_NOT_IN_STACK = "A not-started step goes in an area, not a stack";
/** A session's name as what's said about it quotes it. */
const titled = (s: Pick<SessionInfo, "title" | "ticketTitle">): string => `“${s.ticketTitle ?? s.title}”`;
const lowerFirst = (s: string): string => (s.startsWith("“") ? s : s.charAt(0).toLowerCase() + s.slice(1));
/** What a running session in a folder a step would share is doing, as Start now's confirm says it. */
const STATUS_WORD: Record<Exclude<SessionStatus, "dead">, string> = { working: "working", waiting: "waiting for you", idle: "idle" };
/** Where a not-started step starts (SessionManager.stepPlace): create()'s say in it. */
type StepWhere = Pick<NewSessionRequest, "repoPath" | "cwd" | "branchName" | "useWorktree" | "baseBranch" | "startAt">;
/** A session a not-started step starts from (its folder, or its commit), and what of it: "in “Builder”'s folder". */
type StepUse = { id: string; what: string };
/** The commit a not-started step starts at, from the step before it (SessionManager.upstreamCommit), or why there's none. */
type UpstreamCommit = { sha: string; branch: string | null; of: string; dirty: number | { unread: string }; gone: boolean } | { why: string };

/** What a confirm card says of a mode wider than the default (WIDER_MODES): what its agent then does without asking. */
export function widerModeWarning(mode: PermissionMode, agent: AgentKind): string {
  if (mode === "acceptEdits") return "Accept edits: it changes files without asking you first";
  if (mode === "auto") return agent === "codex" ? "Auto: Codex's automatic review answers its approval requests, not you" : "Auto: it decides for itself which actions to take without asking you";
  return agent === "codex" ? "Bypass permissions: Codex runs every command without asking, and outside its sandbox" : "Bypass permissions: it runs every tool without asking you first";
}

/** Why not-started step `s` can't be reopened, resumed or restarted: it has no conversation or folder to go back to. */
export const notStartedWhy = (s: Pick<SessionInfo, "title" | "ticketTitle">): string =>
  `“${s.ticketTitle ?? s.title}” hasn't started yet: it starts when the handoff into it is sent, or with Start now in its menu`;

/**
 * What closed session `s`'s missing folder means for reopening it (SessionManager.missingFolders). A worktree session
 * is one relaunch makes again (launchAgain): from its branch while that's still here, on origin, or as origin last had
 * it (createWorktree's mustExist); with none of those a relaunch is refused rather than making the branch anew.
 */
export async function folderGone(s: Pick<SessionInfo, "cwd" | "repoPath" | "branch">): Promise<Omit<MissingFolder, "id">> {
  const volume = /^\/Volumes\/([^/]+)\//.exec(s.cwd);
  if (volume && !fs.existsSync(`/Volumes/${volume[1]}`)) return { reopens: false, short: "Its volume isn't connected", why: `Its folder is on ${volume[1]}, which isn't connected: connect it to reopen it` };
  const repo = s.repoPath ? expandHome(s.repoPath) : null;
  if (!s.branch || !repo || s.cwd === repo) return { reopens: false, short: "Its folder is gone", why: `Its folder, ${s.cwd}, isn't there any more: start fresh instead` };
  if (!fs.existsSync(repo)) return { reopens: false, short: "Its repository is gone", why: `Its repository, ${repo}, isn't there any more: start fresh instead` };
  const has = async (ref: string) => !!(await git(repo, ["rev-parse", "--verify", "-q", ref], { okCodes: [0, 1] }));
  try {
    if ((await has(`refs/heads/${s.branch}`)) || (await has(`refs/remotes/origin/${s.branch}`))) {
      return { reopens: true, short: "Its worktree was removed · its branch is kept", why: `Its worktree was removed: reopening makes it again from its branch, ${s.branch}` };
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.error(`[sessions] couldn't tell whether ${s.branch} is still in ${repo}:`, err);
    return { reopens: false, short: "Its worktree was removed", why: `Its worktree was removed, and whether its branch is still there couldn't be read: ${why}` };
  }
  return { reopens: false, short: "Its worktree was removed", why: "Its worktree was removed, and its branch with it, so it can't run where it ran: start fresh instead" };
}

/** What SessionManager.create is told besides the request, by main's own callers only. */
type CreateOptions = {
  notice?: string;
  beforeSpawn?: () => void;
  /** A terminal started where agent pane `agent` quit (SessionInfo.agentQuit), for Resume <agent>. */
  agentQuit?: AgentQuit;
  /** A terminal's SessionInfo.conversation, carried from the pane it was before. */
  conversation?: { agent: AgentKind; id: string };
  /** What the divider above the earlier output says happened (restartDivider). */
  divider?: string;
};

/** What SessionManager.toTerminal changes on a pane's record besides its status, put back when it can't become a terminal. */
const QUIT_FLIP = ["shell", "agent", "agentVersion", "agentQuit", "quitInSandbox", "exitCode", "finishedAt", "waitingReason", "waitingSince", "waitingAt", "stalledSince", "hooksSilent"] as const;
type BeforeFlip = Pick<SessionInfo, (typeof QUIT_FLIP)[number]>;
/** Put `was`'s fields back on `i`; one that wasn't set is taken off again. */
function putBack(i: SessionInfo, was: BeforeFlip): void {
  for (const k of QUIT_FLIP) {
    if (was[k] === undefined) delete (i as Partial<SessionInfo>)[k];
    else (i as unknown as Record<string, unknown>)[k] = was[k];
  }
}

/** Where a persisted session runs again (SessionManager.whereAgain), and what to tell it when its folder has moved to another branch. */
type PlaceAgain = { where: Pick<NewSessionRequest, "cwd" | "branchName" | "useWorktree">; moved?: string; warnings?: string[] };

/** What relaunching a persisted session resumes (relaunchPlan). */
type RelaunchPlan = {
  /** Its last conversation, while that's still on disk. */
  conv: { agent: AgentKind; id: string } | null;
  /** `conv` is its own agent's, resumed by id. */
  sameAgent: boolean;
  /** Resume its folder's latest conversation instead (--continue). */
  resume: boolean;
  /** The conversation resumed by id, which something outside the pane may be running (freeConversation). */
  freeing: { agent: AgentKind; id: string } | null;
};

/**
 * What relaunching `old` resumes: the exact conversation it last ran when that's still on disk; otherwise its
 * folder's most recent, which is ambiguous when several chats started in one folder (home, WorkTracker), and none
 * when the folder has no conversation yet (a session that died at startup relaunches fresh, as --continue would exit).
 * A terminal its agent quit into resumes nothing: its conversation waits for Resume <agent> (asQuitAgent).
 */
function relaunchPlan(old: SessionInfo): RelaunchPlan {
  const conv = old.conversation && !old.agentQuit && agentFor(old.conversation.agent).conversationExists(old.conversation.id) ? old.conversation : null;
  const sameAgent = !!conv && conv.agent === (old.agent ?? "claude");
  return {
    conv,
    sameAgent,
    resume: !old.shell && !sameAgent && agentFor(old.agent).hasConversation(old.cwd),
    freeing: old.shell || sameAgent ? conv : null,
  };
}

export class SessionManager {
  private live = new Map<string, LiveSession>();
  /**
   * Panes being resumed now (resume), until each has relaunched or failed: a second Resume, a relaunch or a restart
   * of one is refused meanwhile, and it isn't listed as resumable (Previous), where Reopen would launch it again.
   */
  private resuming = new Set<string>();
  /**
   * Sessions being relaunched now (relaunch), until each is live again or its relaunch failed: create() takes over
   * whatever pty holds the id, so a second relaunch would kill the first one's fresh agent, and forgetting one meanwhile
   * would drop a record that create() then writes back with no history. Both are refused while it's here.
   */
  private relaunching = new Set<string>();
  /** Not-started steps being started now (startPlanned), until each runs or has failed: a second start, a relaunch or a forget meanwhile is refused. */
  private starting = new Set<string>();
  /** A Helpdesk tasks workspace is being started (create), until it runs or has failed: another start meanwhile is refused. */
  private tasksStarting = false;
  /** Every pty that hasn't exited yet, closed panes' included, with its exit: quitting waits for them (shutdown). */
  private running = new Map<pty.IPty, Promise<void>>();
  /** Set by shutdown: ptys ending now are the app quitting, which leaves each pane's saved state as it was. */
  private quitting = false;
  /** Messages a pane closed to resume hadn't been given yet; its relaunch delivers them. */
  private undelivered = new Map<string, Queued[]>();
  /** Each pane's scrollback is kept here, so a relaunched pane shows its earlier output. */
  scrollbackDir = path.join(MB_DIR, "scrollback");
  private wc: WebContents | null = null;
  /** Each agent CLI's installed version, as last read; new panes record it (see AgentUpdateNotice). */
  agentVersions: Partial<Record<AgentKind, string>> = {};
  /** Reads an agent CLI's installed version now; null when it can't be told (the app's `<bin> --version`). */
  readVersion: ((kind: AgentKind) => Promise<string | null>) | null = null;
  private versionReads = new Map<AgentKind, Promise<void>>();

  private resolvedBins = new Map<string, string>();
  /** Bumped by resetBinCache, so a lookup started before a Settings change can't cache the old binary. */
  private binGeneration = 0;

  /** Called whenever the session list changes — drives the tray + Dock badge. */
  onChanged: (() => void) | null = null;

  /** Teammates' sessions shown here (team rooms); their I/O is routed to their owners. */
  remote: RemotePanes | null = null;
  /** Extra launch settings for a session in a shared group (team rooms); null outside rooms. */
  roomLaunch: ((target: LaunchTarget) => Promise<RoomLaunch | null>) | null = null;
  /** The team room a group is shared as, or null (team rooms): what keeps the Helpdesk tasks workspace out of one. */
  roomOfGroup: ((group: string) => string | null) | null = null;
  /**
   * Whether the team room group `group` is shared as has its sandbox switched off on this Mac now (Settings → Team);
   * null when the group isn't a room's. What a launch there would get: a running one keeps what it started with.
   */
  roomSandboxOff: ((group: string) => boolean | null) | null = null;
  /**
   * Whether the git that makes or checks out a folder for a session in `group` fires only the user's own hooks
   * (worktrees.ts's `own`): main's pushesOwnHooks rule, by group. Unset (a test's Sessions), the repository's run.
   */
  ownHooksFor: ((group: string | null) => boolean) | null = null;
  /** Claude Code's `--help` (helpdesk.ts); a test's stand-in otherwise. */
  readClaudeHelp: (bin: string) => Promise<string> = readClaudeHelp;
  /** Whether a Claude Code lists `--chrome`, by binary and version; one that couldn't be read is asked again next time. */
  private chromeFlags = new Map<string, Promise<boolean>>();
  /** A Claude room launch whose sandbox didn't report in (RoomSandboxWatch): told once per launch. */
  sandboxLost: ((info: SessionInfo, why: string) => void) | null = null;
  /** A Codex room launch's folder notice: answered (for the log), or left to the user (told once, why). */
  folderNoticeSeen: ((info: SessionInfo, what: "answered" | "asking", why?: string) => void) | null = null;
  /** A Codex room launch's folder-notice timings (CodexFolderNotice's defaults unless a test says otherwise). */
  folderNoticeTiming: { waitMs?: number; settleMs?: number; retryMs?: number; stallMs?: number } = {};
  /** How long a room launch's sandbox has to report in; SANDBOX_REPORT_MS unless a test says otherwise. */
  sandboxReportMs = SANDBOX_REPORT_MS;
  /** Asks Claude Code for its own account of a room launch's sandbox (claudeSandboxProbe.ts); a test's stand-in otherwise. */
  sandboxProbe: (p: SandboxProbe) => Promise<SandboxVerdict> = (p) => probeRoomSandbox(p);
  /** Reads the version of the file a Claude room launch runs, by running it (binPins.ts); a test's stand-in otherwise. */
  readVersionAt: (file: string) => Promise<string | null> = readVersionAt;
  private readonly binPins = new BinPins((file) => this.readVersionAt(file));
  /** How often the settings a room pane takes are looked at, and how long they settle (a test's own otherwise). */
  settingsTiming = { pollMs: SETTINGS_POLL_MS, settleMs: SETTINGS_SETTLE_MS };
  /** The user's and an administrator's Claude Code settings, watched while a room pane's sandbox is to be kept checked. */
  private settingsWatch: SettingsWatch | null = null;
  /**
   * What an agent pane's launch is told on top of its own instructions, beside a room's: its wires (wireTools.ts), so a
   * relaunched workspace knows to finish its step with finish_step, and an Orchestrator's rules (its `role`, and the
   * ticket it's on, ticketOfSession's, or null). Null when it has nothing to say.
   */
  launchInstructions: ((id: string, role?: SessionRole, ticket?: string | null) => string | null) | null = null;
  /** Why a session mustn't run again here (a teammate continues it: team rooms' take-over), or null when it may. */
  relaunchGuard: ((id: string) => string | null) | null = null;
  /**
   * Why not-started step `step` mustn't start from session `other` (the folder it shares, or the commit it starts at):
   * the rules on a handoff between the two as they stand now (WireService.startRefusal: the room line, a copy a
   * teammate continues), or null when it may. Unset, only relaunchGuard is asked.
   */
  startGuard: ((step: string, other: string) => string | null) | null = null;
  /**
   * Makes a conversation free for a relaunch to resume, when the agent's own
   * background sessions hold it (claudeBackground.ts). Returns what the pane
   * should say about it, or null when there was nothing to do; throws when it
   * can't be freed.
   */
  freeConversation: ((conversation: { agent: AgentKind; id: string }) => Promise<string | null>) | null = null;
  private watchers = new Set<() => void>();
  private outputListeners = new Set<(id: string, data: string, end: number, epoch: string) => void>();
  private statusListeners = new Set<(info: SessionInfo, before: SessionStatus) => void>();
  private quitListeners = new Set<(info: SessionInfo) => void>();

  /**
   * An agent pane's agent quit on its own (agentQuit), or its owner opens a terminal where one quit in its room's
   * sandbox (openTerminal): told with it still the agent pane, before any shell starts. One that throws keeps it from
   * becoming a terminal: it's left exited instead.
   */
  onAgentQuit(cb: (info: SessionInfo) => void): () => void {
    this.quitListeners.add(cb);
    return () => this.quitListeners.delete(cb);
  }

  /** Told whenever a session is added, removed or changed (status, title, group, terminal size). */
  watch(cb: () => void): () => void {
    this.watchers.add(cb);
    return () => this.watchers.delete(cb);
  }

  /** Every pane's output as it arrives, with where it ends in its pty's output (see paneOutput). */
  onOutput(cb: (id: string, data: string, end: number, epoch: string) => void): () => void {
    this.outputListeners.add(cb);
    return () => this.outputListeners.delete(cb);
  }

  /** A session's status changed (from its hooks, a delivered message, a dismissal, its exit). */
  onStatusChanged(cb: (info: SessionInfo, before: SessionStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  private tell<A extends unknown[]>(what: string, listeners: Iterable<(...a: A) => void>, ...args: A): void {
    for (const l of listeners) {
      try {
        l(...args);
      } catch (err) {
        console.error(`[sessions] a ${what} listener failed:`, err);
      }
    }
  }

  constructor(private store: Store) {}

  /** launchInstructions for session `id`: one that fails is logged, and the agent starts without what it would have said. */
  private launchNotes(id: string, role: SessionRole | undefined, ticket: string | null): string | null {
    try {
      return this.launchInstructions?.(id, role, ticket) ?? null;
    } catch (err) {
      console.error(`[sessions] ${id} starts without its wires' instructions, which couldn't be worked out:`, err);
      return null;
    }
  }

  private emitChanged(): void {
    this.wc?.send("sessions:changed", this.list());
    this.onChanged?.();
    this.tell("change", this.watchers);
  }

  /** Drop the cached binary paths so a Settings change takes effect immediately. */
  resetBinCache(): void {
    this.resolvedBins.clear();
    this.binGeneration++;
  }

  /** The binary a fresh session of this agent would launch. */
  binFor(kind: AgentKind): string {
    return this.resolveBin(agentFor(kind));
  }

  /**
   * Look up every agent's binary without blocking — at startup and after a
   * Settings change — so binFor() is a cache hit by the time a session starts.
   */
  async warmBins(): Promise<void> {
    for (const agent of [agentFor("claude"), agentFor("codex")]) {
      const bin = this.store.settings[agent.binSetting];
      if (this.resolvedBins.has(agent.binSetting) || bin.includes("/")) continue;
      const generation = this.binGeneration;
      const found = await which(bin);
      if (generation !== this.binGeneration) continue; // looked up for settings since replaced
      // a bare name means "not found", as in resolveBin — cached too, so nothing looks it up again
      if (!this.resolvedBins.has(agent.binSetting)) this.resolvedBins.set(agent.binSetting, found ?? bin);
    }
  }

  private resolveBin(agent: AgentAdapter): string {
    const cached = this.resolvedBins.get(agent.binSetting);
    if (cached) return cached;
    // cold: warmBins() hasn't finished (or found nothing) — look it up now
    const bin = this.store.settings[agent.binSetting];
    let resolved = bin;
    if (bin.includes("/")) resolved = expandHome(bin);
    else {
      // a bare name means "not found" to callers; the pane's own shell reports it on launch
      resolved = whichSync(bin) ?? bin;
    }
    this.resolvedBins.set(agent.binSetting, resolved);
    return resolved;
  }

  attach(wc: WebContents): void {
    this.wc = wc;
  }

  list(): SessionInfo[] {
    // a terminal's count is what waits for its agent's next launch (toTerminal)
    return [...this.live.values()].map((s) => ({ ...s.info, queuedCount: s.queued.length + (this.undelivered.get(s.info.id)?.length ?? 0), promptAt: s.promptAt }));
  }

  /**
   * Sessions persisted from a previous app run that aren't live now. A pane being resumed is among them between its
   * pty let go and its relaunch: main reads list() and resumable() together as every session this Mac has, and a
   * reopen meanwhile is refused (notResuming).
   */
  resumable(): SessionInfo[] {
    const liveIds = new Set(this.live.keys());
    // a not-started step (planned) has nothing to resume, and what reads this (rooms publishing, Reopen, the Closed
    // sessions list, missingFolders) must never take one for a closed session
    return this.store.state.sessions.filter((s) => !liveIds.has(s.id) && !s.planned);
  }

  /**
   * The steps not started yet (SessionInfo.planned): the landscape draws them where their places are kept, as it does
   * closed sessions' ghosts, and startPlanned starts one. Never among resumable(), so nothing reopens or publishes one.
   */
  planned(): SessionInfo[] {
    return this.store.state.sessions.filter((s) => !!s.planned && !this.live.has(s.id));
  }

  /**
   * The end of closed session `id`'s saved output, at most `max` bytes cut at a line's start: what its ghost card on the
   * landscape reads its last line from. "" when it has none saved (it never wrote any, or it was forgotten). Only a
   * resumable session's: a live pane's output is its terminal's (paneBuffer). Throws when the file can't be read.
   */
  closedOutput(id: string, max = CLOSED_OUTPUT_MAX): string {
    if (this.live.has(id)) throw new Error(`${id} is running: its output is its pane's`);
    const rec = this.recordOf(id);
    if (!rec) throw new Error(`${id} isn't one of this Mac's closed sessions`);
    if (rec.planned) throw new Error(`${id} hasn't started, so it has no output`);
    const held = this.debriefScrollback.get(id);
    if (held !== undefined) return tailOf(held, max);
    let fd: number;
    try {
      fd = fs.openSync(this.scrollbackFile(id), "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
    try {
      const size = fs.fstatSync(fd).size;
      const n = Math.min(size, max);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      // the last `max` bytes, which may start mid-line (or mid-character): from the next line's start
      return n < size ? fromLineStart(buf.toString("utf8")) : buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * The closed sessions (resumable) whose folder is gone, each with whether Reopen can still run it (MissingFolder): a
   * removed worktree whose branch is still here, or on origin as last fetched, is made again from it by relaunch
   * (createWorktree); one whose branch went too, a folder that isn't there, or one on a volume that isn't connected can't.
   */
  async missingFolders(): Promise<MissingFolder[]> {
    const out: MissingFolder[] = [];
    for (const s of this.resumable()) if (s.role !== "tasks" && !fs.existsSync(s.cwd)) out.push({ id: s.id, ...(await folderGone(s)) });
    return out;
  }

  /**
   * Start a pane. `notice` is shown in it above the agent's output (see paneNotice). `beforeSpawn` runs as the pty is
   * about to start, after every await in preparing it: what it throws is the launch's failure, nothing having started.
   * `agentQuit`: a terminal that an agent pane became when its agent quit (SessionInfo.agentQuit).
   */
  async create(req: NewSessionRequest, opts: CreateOptions = {}): Promise<SessionInfo> {
    if (req.role !== "tasks") return this.createPane(req, opts);
    // One Helpdesk tasks workspace on this Mac: another start while one is open or starting (a double click, the menu
    // and Settings' Start at once) is refused; its own relaunch, under its id, isn't.
    if (this.tasksStarting) throw new Error(HELPDESK_STARTING);
    const open = [...this.live.values()].find((s) => s.info.role === "tasks" && s.info.id !== req.reuseId);
    if (open) throw new Error(helpdeskOpenAlready(open.info.title));
    this.tasksStarting = true;
    try {
      return await this.createPane(req, opts);
    } finally {
      this.tasksStarting = false;
    }
  }

  private async createPane(req: NewSessionRequest, opts: CreateOptions): Promise<SessionInfo> {
    this.refuseWhileQuitting();
    const tasks = req.role === "tasks";
    if (req.permissionMode !== undefined && !isPermissionMode(req.permissionMode)) throw new Error(`“${String(req.permissionMode).slice(0, 40)}” isn't a permission mode`);
    // refused before a worktree's made: by its role, and by its room's sandbox when the room's switch has it on
    const roomGroup = req.taskGroup ?? req.ticketId ?? null;
    const modeFirst = req.shell && !req.shellResume ? null : permissionModeRefusal(req.shell ? req.shellResume!.agent : req.agent ?? "claude", req.permissionMode, { role: req.role, roomSandboxed: !req.debrief && !tasks && !!roomGroup && this.roomSandboxOff?.(roomGroup) === false });
    if (modeFirst) throw new Error(modeFirst);
    if (tasks) await this.mayStartTasks(req);
    const settings = this.store.settings;
    let cwd: string;
    let branch: string | null = null;
    let repoPath = req.repoPath ? expandHome(req.repoPath) : null;
    // what the branch was made from when origin couldn't be asked or fetched from: shown in the pane, with opts.notice
    // (the git that failed is logged by ownNetworkGit)
    const warnings: string[] = [];
    const warn = (text: string) => void warnings.push(text);

    const wanted =
      req.branchName?.trim() ||
      (req.ticketId && req.ticketTitle ? slugBranch(req.ticketId, req.ticketTitle) : null);
    const own = !!this.ownHooksFor?.(req.taskGroup ?? req.ticketId ?? null);
    // a plain terminal runs no agent and no sandbox, so its folders grant it nothing it hasn't already
    const runsAgent = !req.shell || !!req.shellResume;
    const extraDirs = (req.extraDirs ?? []).map(expandHome);
    // a room session's extra folders, and a repo's checkout when that's its folder: refused before a worktree's made or
    // a checkout's branch is changed, as its folder is once it's known below
    if (!tasks && !req.debrief && runsAgent) this.refuseRoomFolder(req.taskGroup ?? req.ticketId ?? null, !req.cwd && repoPath && !req.useWorktree ? repoPath : null, extraDirs);
    if (tasks) {
      cwd = helpdeskFolder();
      repoPath = null;
    } else if (req.cwd) {
      cwd = expandHome(req.cwd);
      if (!fs.existsSync(cwd)) throw new Error(`${cwd} doesn't exist any more`);
      branch = req.branchName?.trim() || null;
    } else if (repoPath && req.useWorktree) {
      branch = wanted || `mb-${Date.now().toString(36)}`;
      cwd = await createWorktree(repoPath, branch, req.baseBranch, { warn, own, ...(req.startAt ? { startAt: req.startAt } : {}) });
    } else if (repoPath && wanted) {
      // ticket branch in the checkout itself — one branch per checkout, so
      // another live session there on a different branch blocks this. One with
      // no branch of its own runs on whatever's out, and would be moved all the same
      const other = [...this.live.values()].find((s) => s.info.cwd === repoPath && s.info.status !== "dead" && s.info.branch !== wanted);
      const occupiedBy = other && (other.info.branch ?? (await currentBranch(repoPath)) ?? "a detached HEAD");
      await checkoutBranch(repoPath, wanted, req.baseBranch, occupiedBy === wanted ? undefined : occupiedBy, warn, { own });
      branch = wanted;
      cwd = repoPath;
    } else {
      // repo-less: claude sessions run in the WorkTracker (assistant), plain
      // terminals just open at home
      // repo-less: debrief assistants live in the WorkTracker folder (their
      // instructions and digests are there); plain chats and shells run in
      // home — which is also where claude finds conversations started from a
      // bare terminal, so --continue/--resume can pick those up
      cwd = repoPath ?? (req.debrief ? expandHome(settings.workTrackerPath) : os.homedir());
    }
    // any other agent there (a resumed conversation, a handoff, a brief, a review) would carry the Helpdesk tasks
    // workspace's conversations to a session with Mockingbird's tools; a plain terminal runs no agent
    if (!tasks && runsAgent && inHelpdeskFolder(cwd)) throw new Error(HELPDESK_FOLDER_ONLY);
    if (!tasks && !req.debrief && runsAgent) this.refuseRoomFolder(req.taskGroup ?? req.ticketId ?? null, cwd);

    const agent = agentFor(req.agent);

    // Spawn via a login shell: /bin/zsh always execs cleanly under posix_spawnp,
    // handles claude being a wrapper script, and brings the user's PATH along.
    // shell sessions skip claude entirely — just an interactive zsh in the cwd.
    const shellArgs = ["-il"];
    let claudeArgs: string[] = shellArgs;
    const id = req.reuseId ?? randomUUID().slice(0, 8);
    // a session in a room's shared group starts with the room's protections,
    // which for Codex depend on its version
    const group = req.taskGroup ?? req.ticketId ?? null;
    const targetAgent = req.shell ? null : req.agent ?? "claude";
    // a terminal bringing a conversation back runs that agent under the room's settings too
    const resumes = req.shell ? req.shellResume?.agent ?? null : null;
    const versioned = targetAgent ?? resumes;
    const roomed = !!versioned && !!group && !!this.roomLaunch && !req.debrief && !tasks;
    // a Claude room launch's protections, its pane and its sandbox check are all the one file its link names now
    const pinned = roomed && versioned === "claude" ? await this.binPins.pin(this.resolveBin(agentFor("claude"))) : null;
    const agentVersion = !roomed ? null : pinned ? pinned.version : await this.versionOf(versioned!);
    // the file the link names now is the installed one: a pane started on it isn't behind it (updateNotices)
    if (pinned?.version && pinned.version !== this.agentVersions.claude) this.setAgentVersions({ claude: pinned.version });
    const binOf = (a: AgentAdapter) => (pinned && a.binSetting === "claudeBin" ? pinned.bin : this.resolveBin(a));
    // a relaunch keeps the folders its first room launch found no repository in, so a .git made there since isn't trusted
    const noRepo = req.reuseId ? this.store.state.sessions.find((x) => x.id === req.reuseId)?.noRepo : undefined;
    const room = req.debrief || tasks ? null : ((await this.roomLaunch?.({ id, group, agent: targetAgent, resumes, agentVersion, cwd, repoPath, extraDirs, ...(noRepo?.length ? { noRepo } : {}) })) ?? null);
    // the launch's own room settings decide: a mode may only tighten a room's sandbox (permissionModeRefusal)
    const modeWhy = runsAgent ? permissionModeRefusal(versioned ?? "claude", req.permissionMode, { role: req.role, roomSandboxed: !!room?.claudeSettings || !!room?.codexPermissions.length }) : null;
    if (modeWhy) throw new Error(modeWhy);
    const instructions = tasks ? HELPDESK_RULES : [room?.instructions, req.shell || req.debrief ? null : this.launchNotes(id, req.role, ticketOfSession({ ticketId: req.ticketId, taskGroup: group }))].filter(Boolean).join("\n\n");
    const roomCtx: LaunchContext = {
      ...(room?.denyReads.length ? { denyReads: room.denyReads } : {}),
      ...(room?.codexPermissions.length ? { codexPermissions: room.codexPermissions } : {}),
      ...(room?.claudeSettings ? { claudeSettings: room.claudeSettings } : {}),
      ...(instructions ? { instructions } : {}),
      ...(room?.allowTools.length ? { allowTools: room.allowTools } : {}),
      ...(room?.inline ? { inline: true } : {}),
      ...(room && Object.keys(room.agentEnv).length ? { env: room.agentEnv } : {}),
    };
    const envFirst = (env?: Record<string, string>) => (env ? ["/usr/bin/env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`)] : []);
    const commandFor = (a: AgentAdapter, r: NewSessionRequest, ctx: LaunchContext, args = a.launchArgs(r, ctx)) => [...envFirst(ctx.env), binOf(a), ...args].map(quote).join(" ");
    // an agent pane's own arguments: a room launch's sandbox is checked with the very --settings it was given
    let paneArgs: string[] = [];
    // the agent this pty runs: an agent pane's, or the one a terminal brings back
    const runs = req.shell ? req.shellResume?.agent : req.agent ?? "claude";
    let proc: pty.IPty;
    this.refuseWhileQuitting(); // shutdown may have begun while this launch was being prepared
    // a teammate may have taken the session over meanwhile: stopping it then found nothing live to stop
    if (req.reuseId) this.mayRun(req.reuseId);
    opts.beforeSpawn?.();
    // this launch's messaging tools and the token they're known by, which go with the launch if it fails from here on.
    // The Helpdesk tasks workspace has none: it can't message, read or be wired, and its hooks still report its status
    const mcp = req.shell || tasks ? undefined : mcpLaunch(id);
    const paneEnv = {
      ...terminalEnv(),
      MOCKINGBIRD: "1",
      // inherited by the agent and its hooks — including an agent the user
      // starts by hand inside a terminal pane — so every hook event names
      // its pane exactly; a folder alone is ambiguous (see statusFromHook)
      MOCKINGBIRD_SESSION: id,
      ...(runs ? agentFor(runs).launchEnv : {}),
      // debriefs get PAT auth for the az DevOps CLI (AZURE_DEVOPS_EXT_PAT)
      // so ticket/PR queries work without az login or an MCP server
      ...(req.debrief ? adoEnv(this.store) : {}),
      ...(room?.env ?? {}),
    } as Record<string, string>;
    try {
      if (!req.shell) {
        const paneCtx: LaunchContext = { ...(mcp ? { mcp } : {}), ...(tasks ? { chrome: true } : {}), ...roomCtx };
        paneArgs = agent.launchArgs(req, paneCtx);
        claudeArgs = ["-ilc", `exec ${commandFor(agent, req, paneCtx, paneArgs)}`];
      } else if (req.shellResume) {
        // a terminal that had an agent running in it: bring the conversation
        // back, and leave the user at the shell prompt when they quit it. It
        // gets no messaging tools: terminals are outside agent messaging, since
        // a message typed in once the agent has quit would run as a command.
        const a = agentFor(req.shellResume.agent);
        claudeArgs = ["-ilc", `${commandFor(a, { ...req, shell: false, resumeSessionId: req.shellResume.id }, roomCtx)}; exec /bin/zsh -il`];
      }
      proc = pty.spawn("/bin/zsh", claudeArgs, {
        name: PTY_TERM,
        cols: 120,
        rows: 32,
        cwd,
        env: paneEnv,
      });
    } catch (err) {
      retireMcpLaunch(mcp);
      throw new Error(
        `Failed to launch ${req.shell ? "a terminal" : `"${binOf(agent)}"`} in ${cwd}: ${err instanceof Error ? err.message : err}. ` +
          `If it isn't found, set its full path in Settings → ${agentLabel(req.agent).toLowerCase()} binary.`
      );
    }
    bindMcpLaunch(mcp, proc.pid);
    let exited!: () => void;
    this.running.set(proc, new Promise<void>((resolve) => (exited = resolve)));
    // its end is handled from the moment it runs, whatever happens below: the pty, and its token, always go with it.
    // Once it's no longer the live session for its id, its end touches nothing else (its replacement's).
    let started: LiveSession | undefined;
    proc.onExit(({ exitCode, signal }) => {
      this.running.delete(proc);
      exited();
      retireMcpLaunch(mcp);
      started?.sandbox?.stop();
      if (started?.sandboxCheck) {
        started.sandboxCheck = null;
        this.watchSettingsWhileChecked();
      }
      started?.folderNotice?.stop();
      if (started?.heldInput.length) {
        const bytes = started.heldInput.reduce((n, d) => n + Buffer.byteLength(d), 0);
        console.warn(`[sessions] ${started.info.id} exited with a teammate's typing (${bytes} bytes) still held for its Codex's folder notice: it wasn't typed`);
        started.heldInput = [];
      }
      if (this.quitting || !started || this.live.get(started.info.id) !== started) return;
      // node-pty reports a process ended by a signal with exit code 0: only one that exited by itself has quit
      if (exitCode === 0 && !signal && this.agentQuit(started)) return;
      started.info.exitCode = exitCode;
      this.setStatus(started.info.id, "dead");
    });

    const info: SessionInfo = {
      id,
      title:
        req.title ??
        (req.ticketId && req.ticketTitle
          ? `#${ticketIdOf(req.ticketId)} — ${req.ticketTitle}`
          : branch ?? (repoPath ? repoPath.split("/").pop()! : req.shell ? "terminal" : "assistant")),
      repoPath,
      cwd,
      branch,
      ticketId: req.ticketId ?? null,
      ticketTitle: req.ticketTitle ?? null,
      taskGroup: group,
      status: req.shell ? "idle" : "working", // shells have no hooks — grey until claude runs inside
      createdAt: Date.now(),
      kind: repoPath ? "work" : "assistant",
      extraDirs: req.extraDirs ?? [],
      waitingReason: null,
      waitingSince: null,
      debrief: req.debrief || undefined,
      shell: req.shell || undefined,
      role: req.role || undefined,
      model: req.model || undefined,
      effort: req.effort || undefined,
      permissionMode: req.permissionMode && req.permissionMode !== "default" ? req.permissionMode : undefined,
      agent: req.shell ? undefined : req.agent ?? "claude",
      conversation: req.shellResume ?? (req.shell ? opts.conversation : undefined) ?? (req.resumeSessionId ? { agent: req.agent ?? "claude", id: req.resumeSessionId } : undefined),
      agentQuit: req.shell && !req.shellResume ? opts.agentQuit : undefined,
    };
    // a relaunched pane keeps its history of conversations (its token meter adds them up)
    const before = (req.reuseId ? this.store.state.sessions.find((x) => x.id === req.reuseId) : undefined) ?? {};
    const history = info.conversation ? withConversation(before, info.conversation.id) : conversationsOf(before);
    if (history.length) info.conversations = history;
    // held across launches outside a room too, for when it's in one again
    const held = room?.noRepo ?? noRepo;
    if (held?.length) info.noRepo = held;

    // reuseId re-creates an existing id (relaunch): kill the old pty first or it
    // keeps running, unreachable, still pumping data under the same id
    const prior = this.live.get(info.id);
    if (prior) {
      retireMcpLaunch(prior.mcp);
      try {
        prior.proc.kill();
      } catch {
        /* already dead */
      }
    }
    if (!req.shell) info.agentVersion = pinned ? (pinned.version ?? undefined) : this.agentVersions[req.agent ?? "claude"];
    // a relaunch (same id) starts with what the pane showed before, and still
    // owes the messages that were waiting for it
    const earlier = req.reuseId ? this.readScrollback(req.reuseId) : "";
    const owed = [...this.withoutReceipts(prior?.queued ?? [], `${paneName(info)} was started again before this reached it`), ...(this.undelivered.get(info.id) ?? [])];
    this.undelivered.delete(info.id);
    // a terminal is never given an agent's messages, where one typed would run as a command: they wait for the
    // session's next agent launch (Resume <agent>)
    if (req.shell && owed.length) this.undelivered.set(info.id, owed.splice(0));
    const notice = [opts.notice, ...warnings].filter(Boolean).join("\n");
    const lead = (earlier ? earlier + restartDivider(new Date(), earlier, opts.divider) : "") + (notice ? paneNotice(notice) : "");
    const sess: LiveSession = {
      info,
      proc,
      buffer: lead.slice(-BUFFER_MAX),
      queued: owed,
      lastInput: 0,
      draft: false,
      flushTimer: null,
      lastOutput: Date.now(),
      outputs: 0,
      saved: 0,
      epoch: randomUUID().slice(0, 8),
      total: 0,
      cols: 120,
      rows: 32,
      guards: room?.guards ?? null,
      roomSandboxed: !req.shell && (!!room?.claudeSettings || !!room?.codexPermissions.length),
      sandbox: null,
      sandboxCheck: null,
      folderNotice: null,
      heldInput: [],
      hookEvents: 0,
      transcripts: new Map(),
      kickoff: false,
      startTimer: null,
      compactSentAt: null,
      prompts: 0,
      ownPrompts: 0,
      promptAt: null,
      toTerminal: false,
      mcp,
    };
    sess.total = sess.buffer.length;
    if (room?.sandboxMarker) sess.sandbox = this.watchSandbox(sess, room.sandboxMarker);
    if (sess.sandbox) {
      const at = paneArgs.indexOf("--settings");
      if (at < 0 || !room?.claudeSettings) sess.sandbox.disproved("its launch carried no room sandbox settings to check");
      else {
        sess.sandboxCheck = {
          bin: binOf(agent),
          settingsJson: paneArgs[at + 1],
          extraDirs,
          cwd,
          version: agentVersion,
          written: writtenSandbox(room.claudeSettings),
          env: paneEnv,
          ...(roomCtx.env ? { envFirst: roomCtx.env } : {}),
        };
        this.proveSandbox(sess, sess.sandboxCheck);
      }
    }
    if (room?.codexFolderNotice) sess.folderNotice = this.watchFolderNotice(sess);
    started = sess;
    this.live.set(info.id, sess);
    const records = [...this.store.state.sessions];
    try {
      this.store.upsertSession(info);
    } catch (err) {
      // one that can't be saved isn't left running unrecorded: it's stopped as kill() stops one, its exit still awaited
      // at quit, and the records are as they were. What it took over for its launch is put back for the next one: the
      // messages it owes (their senders were told they're queued) and a debrief's held scrollback.
      this.store.state.sessions = records;
      this.live.delete(info.id);
      retireMcpLaunch(mcp);
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
      const kept = [...(this.undelivered.get(info.id) ?? []), ...sess.queued];
      if (kept.length) this.undelivered.set(info.id, kept);
      if (info.debrief && req.reuseId && earlier) this.debriefScrollback.set(info.id, earlier);
      console.warn(
        `[sessions] ${info.id} couldn't be saved, so it was stopped: ${kept.length} message(s) it owes${info.debrief && earlier ? " and its interview so far" : ""} are kept for its next launch`
      );
      this.emitChanged();
      throw new Error(`${req.shell ? "The terminal" : `“${info.title}”`} couldn't be saved (${err instanceof Error ? err.message : err}), so it was stopped`, { cause: err });
    }

    // outlives kill(), as onExit does: ignored once this pty is no longer the live session for that id
    proc.onData((data) => {
      if (this.quitting || this.live.get(info.id) !== sess) return;
      sess.buffer = (sess.buffer + data).slice(-BUFFER_MAX);
      sess.total += data.length;
      sess.lastOutput = Date.now();
      sess.outputs++;
      if (info.stalledSince) {
        info.stalledSince = null;
        this.emitChanged();
      }
      this.wc?.send("session:data", info.id, data);
      this.tell("output", this.outputListeners, info.id, data, sess.total, sess.epoch);
      sess.folderNotice?.output(data);
    });
    // kickoff prompt (e.g. the ADO ticket) — sent once claude has had time to boot
    if (req.initialPrompt && !req.shell && !agent.promptInArgs) {
      const prompt = req.initialPrompt;
      sess.kickoff = true;
      setTimeout(() => {
        sess.kickoff = false;
        this.sendMessage(info.id, prompt);
      }, 6000);
    }
    // a terminal's kickoff is a command (a preset's "npm test -- --watch"): typed
    // once the login shell has had time to start, and run
    if (req.initialPrompt && req.shell && !req.shellResume) {
      const command = req.initialPrompt.replace(/\r?\n/g, " ; ");
      setTimeout(() => {
        if (this.live.get(info.id) === sess) proc.write(`${command}\r`);
      }, 1500);
    }

    this.emitChanged();
    return info;
  }

  /**
   * Restart claude sessions in place — same id, same grid slot, conversation
   * resumed with --continue. This is what you want after the CLI prints
   * "Update installed · Restart to update": every pane picks up the new binary
   * without losing its history. Shells and dead panes are left alone.
   */
  async restartAll(includeBusy: boolean): Promise<{
    restarted: string[];
    skipped: string[];
    failed: { id: string; error: string }[];
  }> {
    const restarted: string[] = [];
    const skipped: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const s of [...this.live.values()]) {
      const { id, status, shell } = s.info;
      if (shell || status === "dead") continue;
      if (!includeBusy && (status === "working" || status === "waiting")) {
        skipped.push(id); // mid-turn: killing it would drop the answer in flight
        continue;
      }
      try {
        await this.restart(id);
        restarted.push(id);
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.emitChanged();
    return { restarted, skipped, failed };
  }

  private scrollbackFile = (id: string) => path.join(this.scrollbackDir, `${id.replace(/[^\w-]/g, "_")}.log`);

  /**
   * Debriefs don't outlive the app (their records are dropped at startup), so
   * their scrollback never goes to disk: it is held here from closing one to
   * resume until its relaunch.
   */
  private debriefScrollback = new Map<string, string>();

  private readScrollback(id: string): string {
    const held = this.debriefScrollback.get(id);
    if (held !== undefined) {
      this.debriefScrollback.delete(id);
      return held;
    }
    try {
      return fs.readFileSync(this.scrollbackFile(id), "utf8").slice(-BUFFER_MAX);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[sessions] couldn't read scrollback for ${id}:`, err);
      return "";
    }
  }

  private writeScrollback(s: LiveSession): void {
    if (!s.buffer) return;
    if (s.info.debrief) {
      this.debriefScrollback.set(s.info.id, s.buffer);
      return;
    }
    writeFileAtomic(this.scrollbackFile(s.info.id), s.buffer);
    s.saved = s.outputs;
  }

  private dropScrollback(id: string): void {
    this.debriefScrollback.delete(id);
    fs.rmSync(this.scrollbackFile(id), { force: true });
  }

  /**
   * Ends every pty before the app quits, and waits for them to exit. A pty
   * still running when Electron tears Node down exits during that teardown,
   * and node-pty's exit callback, which can no longer call into JS, aborts the
   * app. Each pane's saved status and scrollback stay as they were, so its
   * session resumes on the next launch just as if the app had simply closed.
   */
  async shutdown(graceMs = 3000): Promise<void> {
    this.quitting = true;
    this.settingsWatch?.stop();
    const signal = (sig?: string) => {
      for (const p of this.running.keys()) {
        try {
          p.kill(sig);
        } catch (err) {
          console.warn(`[sessions] couldn't signal pty ${p.pid} while quitting: ${err instanceof Error ? err.message : err}`);
        }
      }
    };
    const allExitWithin = (ms: number) => {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
      return Promise.race([Promise.all(this.running.values()).then(() => true), late]).finally(() => clearTimeout(timer));
    };
    signal(); // SIGHUP, as the terminal closing would send
    if (await allExitWithin(graceMs)) return;
    signal("SIGKILL");
    if (!(await allExitWithin(1000))) console.warn(`[sessions] ${this.running.size} pty(s) still running as the app quits`);
  }

  /**
   * Kills every pty at once: a quit being forced. A pty's spawn-helper that
   * hasn't opened its terminal yet when the app's side of it closes waits for
   * it forever, so none is left to the app's exit.
   */
  killAll(): void {
    this.quitting = true;
    this.settingsWatch?.stop();
    for (const p of this.running.keys()) {
      try {
        p.kill("SIGKILL");
      } catch (err) {
        console.warn(`[sessions] couldn't kill pty ${p.pid} while quitting: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** A pty started once shutdown has signalled the others would be left running, or waiting forever to start, after the app. */
  private refuseWhileQuitting(): void {
    if (this.quitting) throw new Error("Mockingbird is quitting");
  }

  /** Write every pane's scrollback that changed since it was last written (and all of them when quitting). */
  saveScrollback(all = false): void {
    for (const s of this.live.values()) {
      if (s.info.debrief || (!all && s.saved === s.outputs)) continue;
      try {
        this.writeScrollback(s);
      } catch (err) {
        console.error(`[sessions] couldn't save scrollback for ${s.info.id}:`, err);
      }
    }
  }

  /** Mute or unmute a session's notifications; kept across restarts. */
  setMuted(id: string, muted: boolean): void {
    const s = this.live.get(id);
    if (!s && this.remote?.has(id)) return this.remote.setMuted(id, muted);
    if (!s) throw new Error("Session is no longer running");
    s.info.muted = muted || undefined;
    this.store.upsertSession(s.info);
    this.emitChanged();
  }

  /** What a reply from the user's phone did to this session (phone alerts), for its pane; null clears it. */
  setPhoneNote(id: string, text: string | null): void {
    const s = this.live.get(id);
    if (!s) return;
    s.info.phoneNote = text ? { text, at: Date.now() } : null;
    this.emitChanged();
  }

  /** A teammate's session runs on their Mockingbird: why only its owner can do `what` to it, or null for this Mac's. */
  ownRefusal(id: string, what: string): string | null {
    return isRemotePaneId(id) ? `That's a teammate's session: only its owner can ${what}` : null;
  }

  private ownOnly(id: string, what: string): void {
    const why = this.ownRefusal(id, what);
    if (why) throw new Error(why);
  }

  private mayRun(id: string): void {
    const refusal = this.relaunchGuard?.(id);
    if (refusal) throw new Error(refusal);
  }

  private notResuming(id: string): void {
    const why = this.reopeningRefusal(id);
    if (why) throw new Error(why);
  }

  /** Why `id` can't be reopened now: it's being resumed, relaunched or started already. */
  private reopeningRefusal(id: string): string | null {
    if (this.resuming.has(id)) return BEING_RESUMED;
    if (this.relaunching.has(id)) return BEING_RELAUNCHED;
    if (this.starting.has(id)) return BEING_STARTED;
    return null;
  }

  /**
   * End a live session's process and leave its pane: dead, its scrollback
   * kept, nothing in its folder touched. Returns whether it was running.
   */
  stop(id: string): boolean {
    this.ownOnly(id, "stop it");
    const s = this.live.get(id);
    if (!s || s.info.status === "dead") return false;
    try {
      s.proc.kill();
    } catch (err) {
      // node-pty throws for a process that has already exited; the pane is dead either way
      console.warn(`[sessions] ${id}: stopping a process that had already exited: ${err instanceof Error ? err.message : err}`);
    }
    this.setStatus(id, "dead");
    return true;
  }

  /**
   * Agent pane `s`'s agent quit on its own (/exit, Ctrl-D: its pty ended with code 0, and nothing of Mockingbird's
   * stopped it, which would have closed it, marked it exited or replaced its pty first). It becomes a terminal in its
   * folder under its id (toTerminal), its place, scrollback and conversation kept for Resume <agent>. One that ran in
   * its team room's sandbox is left exited instead (quitInSandbox): a teammate allowed to type could /exit it, and a
   * login shell starting by itself would run this Mac's shell profile on a folder its sandboxed agent could write to; its
   * owner opens a terminal there with a click (openTerminal), or resumes the agent. Debriefs and the Helpdesk tasks
   * workspace exit as any pane does. False when it isn't one of these, for its exit to leave it dead.
   *
   * Its turn's end is told first, with it still the agent pane, as an exit tells it (a room session's backup follows).
   * Then what ends with its agent does (onAgentQuit: every teammate's typing grant); one that can't leaves it exited.
   */
  private agentQuit(s: LiveSession): boolean {
    const i = s.info;
    if (i.shell || i.debrief || i.role === "tasks" || i.status === "dead") return false;
    const agent = i.agent ?? "claude";
    if (i.status !== "idle") {
      try {
        this.setStatus(i.id, "idle", undefined, null);
      } catch (err) {
        console.error(`[sessions] ${i.id}: its turn's end, as its ${agentLabel(agent)} quit, couldn't be saved:`, err);
      }
    }
    const ended = this.endWithAgent(i);
    if (ended) {
      this.exited(s, 0, `${agentLabel(agent)} exited, and no terminal opened here: what ends with it couldn't be ended (${ended})`);
      return true;
    }
    if (s.guards && !s.guards.unsandboxed) {
      i.quitInSandbox = true;
      this.exited(s, 0);
      return true;
    }
    void this.toTerminal(s, agent);
    return true;
  }

  /** Tell onAgentQuit's listeners that agent pane `i`'s agent quit: why one of them failed, or null when none did. */
  private endWithAgent(i: SessionInfo): string | null {
    for (const l of this.quitListeners) {
      try {
        l(i);
      } catch (err) {
        console.error(`[sessions] ${i.id}'s agent quit, and what ends with it couldn't be ended:`, err);
        return err instanceof Error ? err.message : String(err);
      }
    }
    return null;
  }

  /** Show `text` in pane `s`, after what it shows, as Mockingbird's own line (paneNotice). */
  private say(s: LiveSession, text: string): void {
    const note = paneNotice(text);
    s.buffer = (s.buffer + note).slice(-BUFFER_MAX);
    s.total += note.length;
    s.outputs++;
    this.wc?.send("session:data", s.info.id, note);
    this.tell("output", this.outputListeners, s.info.id, note, s.total, s.epoch);
  }

  /** Leave pane `s` exited with `exitCode`, saying `note` in it. Never throws (a pty's exit calls it): a save that fails is logged. */
  private exited(s: LiveSession, exitCode: number, note?: string): void {
    if (note) this.say(s, note);
    s.info.exitCode = exitCode;
    try {
      if (s.info.status !== "dead") return this.setStatus(s.info.id, "dead");
      this.store.upsertSession(s.info);
      this.emitChanged();
    } catch (err) {
      console.error(`[sessions] ${s.info.id} is exited, and that couldn't be saved:`, err);
      s.info.status = "dead";
      this.emitChanged();
    }
  }

  /**
   * Agent pane `s`, whose agent quit, becomes a terminal: its record says so (shell, no agent, the agent and the
   * conversation it quit from kept as agentQuit) and is saved, and what waited for its agent is taken off it, all
   * before anything awaits; then becomeTerminal starts its shell. A record that can't be saved is put back and the pane
   * left exited, saying why. Resolves to the terminal, or why there's none (which the pane says too).
   */
  private toTerminal(s: LiveSession, agent: AgentKind): Promise<{ info: SessionInfo } | { why: string }> {
    const i = s.info;
    const was = Object.fromEntries(QUIT_FLIP.map((k) => [k, i[k]])) as BeforeFlip;
    const before = i.status;
    delete i.agent;
    delete i.agentVersion;
    delete i.quitInSandbox;
    delete i.exitCode;
    Object.assign(i, {
      shell: true,
      agentQuit: { agent, ...(i.conversation?.agent === agent ? { conversation: i.conversation.id } : {}) },
      status: "idle",
      finishedAt: null,
      waitingReason: null,
      waitingSince: null,
      waitingAt: null,
      stalledSince: null,
      hooksSilent: false,
    });
    try {
      this.store.upsertSession(i);
    } catch (err) {
      putBack(i, was);
      i.status = before;
      const why = err instanceof Error ? err.message : String(err);
      console.error(`[sessions] ${i.id}'s ${agentLabel(agent)} quit, and its record as a terminal couldn't be saved, so it's left exited:`, err);
      this.exited(s, 0, `${agentLabel(agent)} exited, and a terminal couldn't open here: it couldn't be saved (${why})`);
      return Promise.resolve({ why });
    }
    s.toTerminal = true;
    if (s.flushTimer) clearTimeout(s.flushTimer);
    if (s.startTimer) clearTimeout(s.startTimer);
    s.flushTimer = s.startTimer = null;
    const kept = this.withoutReceipts(s.queued, `${paneName(i)}'s ${agentLabel(agent)} quit before this reached it: it's a terminal now`);
    s.queued = [];
    if (kept.length) {
      // still owed, and still counted (queuedCount, overdueMessages): its agent's next launch delivers them
      this.undelivered.set(i.id, [...(this.undelivered.get(i.id) ?? []), ...kept]);
      console.warn(`[sessions] ${i.id}'s ${agentLabel(agent)} quit with ${kept.length} message(s) waiting for it: they're delivered if it's resumed as an agent`);
    }
    this.emitChanged();
    if (before !== "idle") this.tell("status", this.statusListeners, i, before);
    return this.becomeTerminal(s, agent, was);
  }

  /**
   * Start the terminal pane `s` becomes (toTerminal): a login shell in its folder under its id, what its agent showed
   * kept above the prompt with a line saying so. It doesn't start once the pane has been closed or stopped meanwhile.
   * One that can't start (or can't be saved once it has) leaves the pane the agent pane it was (`was`), exited, saying
   * why in it.
   */
  private async becomeTerminal(s: LiveSession, agent: AgentKind, was: BeforeFlip): Promise<{ info: SessionInfo } | { why: string }> {
    const i = s.info;
    const id = i.id;
    const name = agentLabel(agent);
    this.relaunching.add(id);
    // what ended the switch-over before its shell started, and whether its shell did start
    let cut = null as "stopped" | "closed" | null;
    let spawned = false as boolean;
    try {
      try {
        this.writeScrollback(s);
      } catch (err) {
        console.error(`[sessions] ${id}: couldn't save its scrollback, so its terminal starts without what its agent showed:`, err);
      }
      if (!fs.existsSync(i.cwd)) throw new Error(`its folder, ${i.cwd}, isn't there any more`);
      const place = await this.whereAgain(i);
      const info = await this.create(
        {
          repoPath: i.repoPath,
          ...place.where,
          ticketId: i.ticketId ?? undefined,
          ticketTitle: i.ticketTitle ?? undefined,
          taskGroup: i.taskGroup ?? undefined,
          extraDirs: i.extraDirs,
          title: i.title,
          shell: true,
          role: i.role,
          model: i.model ?? undefined,
          effort: i.effort ?? undefined,
          permissionMode: i.permissionMode ?? undefined,
          reuseId: id,
        },
        {
          notice: [`${name} exited — this is now a terminal in ${tildePath(i.cwd)}.`, place.moved].filter(Boolean).join("\n"),
          divider: `${name} exited`,
          agentQuit: i.agentQuit,
          conversation: i.conversation,
          beforeSpawn: () => {
            cut = this.live.get(id) !== s ? "closed" : i.status === "dead" ? "stopped" : null;
            if (cut) throw new Error(`it was ${cut} first`);
            spawned = true;
          },
        }
      );
      if (i.muted) {
        info.muted = true;
        this.store.upsertSession(info);
        this.emitChanged();
      }
      return { info };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (this.quitting) {
        // the app quitting leaves its record as it was: a terminal that reopens as one
        console.warn(`[sessions] ${id}: the terminal its ${name} quit into didn't start, as Mockingbird is quitting: ${why}`);
        return { why };
      }
      // its shell started and took its place, then the launch couldn't be saved, which stopped the shell and took the pane
      // out: the pane comes back, exited, saying so
      if (spawned && !this.live.has(id)) this.live.set(id, s);
      if (this.live.get(id) !== s) {
        console.warn(`[sessions] ${id} was closed before the terminal its ${name} quit into started`);
        return { why };
      }
      putBack(i, was);
      s.toTerminal = false;
      if (cut === "stopped") {
        console.log(`[sessions] ${id} was stopped before the terminal its ${name} quit into started`);
        this.exited(s, 0, `${name} exited, and it was stopped before its terminal opened.`);
      } else {
        console.error(`[sessions] ${id}'s ${name} quit, and the terminal it was to become couldn't start, so it's left exited:`, err);
        this.exited(s, 0, `${name} exited, and a terminal couldn't open here: ${why}`);
      }
      return { why };
    } finally {
      this.relaunching.delete(id);
    }
  }

  /**
   * Open a terminal in agent pane `id`, whose agent quit in its team room's sandbox (SessionInfo.quitInSandbox): it
   * becomes the terminal an agent quitting outside a room's sandbox becomes at once (toTerminal), on its owner's click.
   * Refused, saying why, for any other pane, while it's being reopened, or when a teammate continues it. What ends with
   * its agent is ended again first (a typing grant given since), and one that can't be refuses it too.
   */
  async openTerminal(id: string): Promise<SessionInfo | { refused: string }> {
    if (isRemotePaneId(id)) return { refused: "That's a teammate's session: only its owner can open a terminal in it" };
    if (this.resuming.has(id)) return { refused: BEING_RESUMED };
    if (this.relaunching.has(id)) return { refused: BEING_RELAUNCHED };
    const pane = this.live.get(id);
    if (!pane) return { refused: "It isn't open here" };
    if (!pane.info.quitInSandbox || pane.info.status !== "dead" || pane.info.shell) return { refused: "Only a pane whose agent quit in its room's sandbox opens a terminal this way" };
    const guard = this.relaunchGuard?.(id);
    if (guard) return { refused: guard };
    this.refuseWhileQuitting();
    const ended = this.endWithAgent(pane.info);
    if (ended) return { refused: `What ends with its agent couldn't be ended (${ended}), so no terminal opened` };
    const r = await this.toTerminal(pane, pane.info.agent ?? "claude");
    if ("why" in r) throw new Error(`A terminal couldn't open in ${paneName(pane.info)}: ${r.why}`);
    return r.info;
  }

  /** Restart one pane in place: same id, its conversation resumed. */
  async restart(id: string): Promise<SessionInfo> {
    return this.restartWith(id, undefined);
  }

  /**
   * Why `id` can't be restarted now, or null: it's a teammate's, it's being reopened already, it hasn't started, or it
   * mayn't run again here (relaunchGuard). Checks only, as restart makes them.
   */
  restartRefusal(id: string): string | null {
    const own = this.ownRefusal(id, "restart it");
    if (own) return own;
    const reopening = this.reopeningRefusal(id);
    if (reopening) return reopening;
    const planned = !this.live.has(id) && this.recordOf(id)?.planned ? this.recordOf(id) : undefined;
    if (planned) return notStartedWhy(planned);
    return this.relaunchGuard?.(id) ?? null;
  }

  private async restartWith(id: string, change: RelaunchChange | undefined): Promise<SessionInfo> {
    const why = this.restartRefusal(id);
    if (why) throw new Error(why);
    this.kill(id, false); // keep the store entry so relaunch can resume it
    const info = await this.relaunch(id, change);
    if (!info) throw new Error("no persisted session to resume");
    return info;
  }

  /**
   * Restart pane `id` in place with `raw`'s changes (RelaunchChange: its permission mode, model or effort), resuming
   * its conversation as a restart does. Refused, saying why with nothing stopped, as restart is (restartRefusal), for a
   * pane that isn't open here or is a terminal, for changes that aren't valid for its agent (readRelaunchChange), and
   * for a mode its role or its room's sandbox doesn't take (relaunchChangeRefusal). The new values are its record's
   * once it runs with them: a launch that fails after it was stopped leaves it closed with the ones it had.
   */
  async relaunchWith(id: string, raw: unknown): Promise<SessionInfo> {
    const { change, blocked } = this.readChange(id, raw);
    if (blocked) throw new Error(blocked);
    return this.restartWith(id, change);
  }

  /**
   * What relaunchWith(id, raw) would meet now: why it's refused (`blocked`, null when it would run), and what to know
   * before it runs (`warnings`): it's mid-turn or waiting on a prompt, or its mode lets its agent do more without
   * asking. A confirm card's account of it: nothing is changed.
   */
  describeRelaunch(id: string, raw: unknown): { blocked: string | null; warnings: string[] } {
    const { change, blocked } = this.readChange(id, raw);
    const s = this.live.get(id)?.info;
    if (blocked || !s) return { blocked: blocked ?? "It isn't open here", warnings: [] };
    const warnings: string[] = [];
    if (s.status === "working") warnings.push("It's mid-turn: restarting stops the turn it's on");
    if (s.status === "waiting") warnings.push("It's waiting on you: restarting drops the prompt it's showing");
    const mode = change.permissionMode ?? s.permissionMode ?? "default";
    if (WIDER_MODES.has(mode)) warnings.push(widerModeWarning(mode, s.agent ?? "claude"));
    return { blocked: null, warnings };
  }

  /** `raw` read for pane `id`'s agent, and why relaunchWith refuses it now: its checks, but for what the launch makes. */
  private readChange(id: string, raw: unknown): { change: RelaunchChange; blocked: string | null } {
    const refused = this.restartRefusal(id);
    if (refused) return { change: {}, blocked: refused };
    const pane = this.live.get(id);
    if (!pane) return { change: {}, blocked: "It isn't open here: reopen it first, then restart it with changes" };
    if (pane.info.shell) return { change: {}, blocked: "It's a terminal: it has no agent to restart with a permission mode, model or effort" };
    let change: RelaunchChange;
    try {
      change = readRelaunchChange(raw, pane.info.agent ?? "claude");
    } catch (err) {
      return { change: {}, blocked: err instanceof Error ? err.message : String(err) };
    }
    return { change, blocked: this.relaunchChangeRefusal(pane, change) };
  }

  /**
   * Why `pane` can't run in `change`'s mode (permissionModeRefusal): by its role, and by its room's sandbox, as it runs
   * in it now or would at its next launch (the room's switch on). create() asks again with the launch's own room
   * settings, before anything starts.
   */
  private relaunchChangeRefusal(pane: LiveSession, change: RelaunchChange): string | null {
    const i = pane.info;
    const roomSandboxed = pane.roomSandboxed || (!!i.taskGroup && this.roomSandboxOff?.(i.taskGroup) === false);
    return permissionModeRefusal(i.agent ?? "claude", change.permissionMode ?? i.permissionMode, { role: i.role, roomSandboxed });
  }

  /**
   * Flag working panes whose terminal has been quiet for `quietMs` (an agent's
   * screen redraws constantly while it works, so silence means it may be
   * stuck). Output clears the flag. Returns whether anything changed.
   */
  checkStalls(now: number, quietMs: number): boolean {
    let changed = false;
    for (const s of this.live.values()) {
      const stalled = s.info.status === "working" && !s.info.shell && now - s.lastOutput >= quietMs;
      if (stalled && !s.info.stalledSince) {
        s.info.stalledSince = s.lastOutput;
        changed = true;
      } else if (!stalled && s.info.stalledSince) {
        s.info.stalledSince = null;
        changed = true;
      }
      // "working" since launch with nothing from the agent's hooks: the status is a guess
      const silent = stalled && s.hookEvents === 0;
      if (silent !== !!s.info.hooksSilent) {
        s.info.hooksSilent = silent;
        changed = true;
        if (silent) {
          console.warn(
            `[sessions] ${s.info.id} (${s.info.title}): no hook event from its ${agentLabel(s.info.agent)} since it started ` +
              `${Math.round((now - s.info.createdAt) / 60_000)} min ago — its status can't be trusted; are Mockingbird's hooks installed?`
          );
        }
      }
    }
    if (changed) this.emitChanged();
    return changed;
  }

  /**
   * Refuses a Helpdesk tasks workspace that can't start as one, saying why: it's Claude's alone, never in a team room's
   * area, and needs a Claude Code with Claude in Chrome (`--chrome` in its `--help`, read once per version).
   */
  private async mayStartTasks(req: NewSessionRequest): Promise<void> {
    if (req.shell || (req.agent ?? "claude") !== "claude") throw new Error("The Helpdesk tasks workspace runs Claude only: it works in your Chrome through Claude in Chrome");
    const group = req.taskGroup ?? req.ticketId ?? null;
    if (group && this.roomOfGroup?.(group)) throw new Error(HELPDESK_START_IN_ROOM);
    const bin = this.resolveBin(agentFor("claude"));
    const version = await this.versionOf("claude");
    const key = `${bin}\0${version}`;
    let check = version ? this.chromeFlags.get(key) : undefined;
    if (!check) {
      const reading = this.readClaudeHelp(bin).then(listsChromeFlag);
      // an unknown version isn't kept, and neither is a read that failed
      if (version) {
        this.chromeFlags.set(key, reading);
        reading.catch(() => this.chromeFlags.get(key) === reading && this.chromeFlags.delete(key));
      }
      check = reading;
    }
    let has: boolean;
    try {
      has = await check;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      console.warn(`[sessions] couldn't read ${bin} --help to see whether it has Claude in Chrome: ${why}`);
      throw new Error(`Couldn't check that Claude Code has Claude in Chrome (${bin} --help: ${why}), so the Helpdesk tasks workspace didn't start`);
    }
    if (!has) {
      throw new Error(`${version ? `Claude Code ${version}` : "This Claude Code"} has no --chrome, which the Helpdesk tasks workspace needs to work in your Chrome: update Claude Code (Settings → Agents → Update), then start it again`);
    }
  }

  /** An agent CLI's installed version: as last read, else read now (one read at a time per agent). */
  async versionOf(kind: AgentKind): Promise<string | null> {
    if (!this.agentVersions[kind] && this.readVersion) {
      let read = this.versionReads.get(kind);
      if (!read) {
        read = this.readVersion(kind)
          .then((v) => {
            if (v) this.setAgentVersions({ [kind]: v });
          })
          .catch((err) => console.warn(`[sessions] couldn't read the ${agentLabel(kind)} CLI's version: ${(err as Error).message}`))
          .finally(() => this.versionReads.delete(kind));
        this.versionReads.set(kind, read);
      }
      await read;
    }
    return this.agentVersions[kind] ?? null;
  }

  /** Read the installed versions; panes started before a version was known take the first one read. */
  setAgentVersions(v: Partial<Record<AgentKind, string>>): void {
    this.agentVersions = { ...this.agentVersions, ...v };
    for (const s of this.live.values()) {
      const kind = s.info.agent ?? "claude";
      if (!s.info.shell && !s.info.agentVersion && v[kind]) s.info.agentVersion = v[kind];
    }
  }

  /** Agents installed at a newer version than some running panes started with. */
  updateNotices(): AgentUpdateNotice[] {
    const out: AgentUpdateNotice[] = [];
    for (const kind of ["claude", "codex"] as AgentKind[]) {
      const installed = this.agentVersions[kind];
      if (!installed) continue;
      const behind = [...this.live.values()]
        .map((s) => s.info)
        .filter((i) => !i.shell && i.status !== "dead" && (i.agent ?? "claude") === kind && i.agentVersion && i.agentVersion !== installed)
        .map((i) => ({ id: i.id, title: i.ticketTitle ?? i.title, version: i.agentVersion! }));
      if (behind.length) out.push({ agent: kind, installed, sessions: behind });
    }
    return out;
  }

  /**
   * Why exited pane `id` can't be resumed now, or null: it's a teammate's, isn't an exited pane here, is being resumed
   * already (but by the resume asking: `asking`), is running, may not run again (a teammate continues it:
   * relaunchGuard), or its record is gone. Checks only: nothing is waited on. `toAgent`: pane `id` is to go back to the
   * agent that quit into it (resumeAgent), so it's a terminal of this Mac's that one quit into, running or exited.
   */
  private resumeRefusal(id: string, asking = false, toAgent = false): string | null {
    if (isRemotePaneId(id)) return "That's a teammate's session: only its owner can resume it";
    if (!asking && this.resuming.has(id)) return BEING_RESUMED;
    if (this.relaunching.has(id)) return BEING_RELAUNCHED;
    if (this.starting.has(id)) return BEING_STARTED;
    const pane = this.live.get(id);
    const planned = !pane && this.recordOf(id)?.planned ? this.recordOf(id) : undefined;
    if (planned) return notStartedWhy(planned);
    if (toAgent) {
      if (!pane) return "It isn't open here: reopen it from its ghost card or Closed sessions first";
      if (!pane.info.shell || !pane.info.agentQuit) return "It isn't a terminal an agent quit into";
    } else if (!pane) return "It isn't an exited pane here: reopen it from its ghost card or Closed sessions";
    else if (pane.info.status !== "dead") return "It's running already";
    const refusal = this.relaunchGuard?.(id);
    if (refusal) return refusal;
    if (!this.recordOf(id)) return "Its saved record is gone, so there's nothing to resume: close the pane";
    return null;
  }

  /** Why exited pane `id` can't be resumed now (resumeRefusal), or null: checks only. */
  whyNotResume(id: string): string | null {
    return this.resumeRefusal(id);
  }

  /**
   * Resume an exited pane: refused, saying why, before anything is undone (resumeRefusal). A conversation it resumes
   * by id that something outside the pane holds (freeConversation) is let go first, the pane kept, and refused with
   * why when it can't be; the checks are then made again. Its dead pty is let go, its record kept, and it's
   * relaunched, nothing waited on between the last checks and letting the pty go, so a take-over heard meanwhile can't
   * come between them. A relaunch that fails after that throws, the session resumable (Previous).
   */
  async resume(id: string): Promise<SessionInfo | { refused: string }> {
    return this.resumeAs(id, false);
  }

  /**
   * Make terminal `id`, which an agent pane became when its agent quit (SessionInfo.agentQuit), that agent pane again
   * under its id: its conversation resumed as an exited pane's Resume resumes it, and refused as that is, saying why.
   * Its shell, running or exited, is ended for it.
   */
  async resumeAgent(id: string): Promise<SessionInfo | { refused: string }> {
    return this.resumeAs(id, true);
  }

  private async resumeAs(id: string, toAgent: boolean): Promise<SessionInfo | { refused: string }> {
    const refusal = this.resumeRefusal(id, false, toAgent);
    if (refusal) return { refused: refusal };
    const as = (r: SessionInfo) => (toAgent ? asQuitAgent(r) : r);
    const record = as(this.recordOf(id)!);
    const plan = relaunchPlan(record);
    this.resuming.add(id);
    try {
      let notice: string | undefined;
      let place: PlaceAgain | undefined;
      if (plan.freeing && this.freeConversation) {
        // its folder first: a conversation isn't let go for a session that has nowhere to run
        try {
          place = await this.whereAgain(record);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          console.warn(`[sessions] ${id}: not resumed, it has nowhere to run: ${why}`);
          return { refused: why };
        }
        try {
          notice = (await this.freeConversation(plan.freeing)) ?? undefined;
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          console.warn(`[sessions] ${id}: not resumed, its conversation couldn't be let go: ${why}`);
          return { refused: why };
        }
        const again = this.resumeRefusal(id, true, toAgent);
        if (again) {
          // what letting it go did (a background session stopped) is said with the refusal, not lost
          if (notice) console.warn(`[sessions] ${id}: not resumed after its conversation was let go: ${notice}`);
          return { refused: notice ? `${again}. Meanwhile, letting its conversation go: ${notice}` : again };
        }
      }
      this.kill(id, false);
      const saved = this.recordOf(id);
      if (!saved) throw new Error("its saved record went while it was being resumed");
      const old = as(saved);
      return await this.launchAgain(old, plan, place ?? (await this.whereAgain(old)), notice);
    } finally {
      this.resuming.delete(id);
    }
  }

  /**
   * Relaunch a persisted session in its old cwd, resuming the conversation. Refused while it's being resumed or
   * relaunched already, and while it runs: create() would kill the running agent to take its id.
   */
  async relaunch(id: string, change?: RelaunchChange): Promise<SessionInfo | null> {
    this.ownOnly(id, "relaunch it");
    this.notResuming(id);
    const pane = this.live.get(id);
    if (pane && pane.info.status !== "dead") throw new Error("It's running already");
    const old = this.recordOf(id);
    // a not-started step has no conversation or folder to go back to: it's started, never reopened (startPlanned)
    if (old?.planned && !pane) throw new Error(notStartedWhy(old));
    this.mayRun(id);
    if (!old) return null;
    this.relaunching.add(id);
    try {
      const plan = relaunchPlan(old);
      // its folder first: a conversation isn't let go for a session that has nowhere to run
      const place = await this.whereAgain(old);
      const notice = (plan.freeing && (await this.freeConversation?.(plan.freeing))) || undefined;
      return await this.launchAgain(old, plan, place, notice, change);
    } finally {
      this.relaunching.delete(id);
    }
  }

  private recordOf(id: string): SessionInfo | undefined {
    return this.store.state.sessions.find((s) => s.id === id);
  }

  /**
   * A step not started yet after session `req.after` (Add next step, docs/landscape-wires.md W8): saved as a record with
   * no pty and no folder (`planned`), drawn by the landscape where its place is kept, as a ghost is, and started under
   * its id by startPlanned. Refused, saving nothing, for what can't be one: an unknown or teammate's session to follow,
   * a group that's a stack's, a repo that isn't there, a folder to share that's gone. The wire into it is the caller's.
   */
  plan(req: PlanRequest): SessionInfo {
    this.refuseWhileQuitting();
    const after = String(req?.after ?? "");
    this.ownOnly(after, "add a step after it");
    const up = this.live.get(after)?.info ?? this.recordOf(after);
    if (!up) throw new Error(`This Mac has no session "${after}" to add a step after`);
    if (req.sharesFolder) {
      if (up.planned) throw new Error(`${titled(up)} hasn't started, so it has no folder to share yet: give this step a folder of its own`);
      if (!fs.existsSync(up.cwd)) throw new Error(`“${up.ticketTitle ?? up.title}”'s folder, ${up.cwd}, isn't there any more, so a step can't work in it`);
    }
    // what Add next step sends, field by field: anything else on the request (a sharesWith) isn't the window's to say
    return this.planStep({
      title: req.title,
      agent: req.agent,
      model: req.model,
      effort: req.effort,
      repoPath: req.repoPath,
      worktree: req.worktree,
      base: req.base,
      taskGroup: req.taskGroup,
      ticketId: req.ticketId,
      ticketTitle: req.ticketTitle,
      prompt: req.prompt,
      ...(req.sharesFolder ? { sharesWith: up.id } : {}),
    });
  }

  /** Refuses a session in a team room's group `group` working in `cwd`, or given `extraDirs`, when roomFolderRefusal says so. */
  private refuseRoomFolder(group: string | null, cwd: string | null, extraDirs: readonly string[] = []): void {
    if (!group || !this.roomOfGroup?.(group)) return;
    const why = roomFolderRefusal(cwd, extraDirs, os.homedir(), this.roomSandboxOff?.(group) !== true);
    if (why) throw new Error(why);
  }

  /**
   * A not-started step's record (`plan`'s, and a template's Lay out's, W9), saved and said. `sharesWith`: it works in that
   * session's folder (decision 7), which may be a step not started yet itself (a template's reviewing step in its
   * builder's): stepPlace refuses to start it until that one has. Refused, saving nothing, as `plan` says.
   */
  planStep(req: Omit<PlanRequest, "after" | "sharesFolder"> & { sharesWith?: string }): SessionInfo {
    this.refuseWhileQuitting();
    const title = String(req.title ?? "").trim().replace(/\s+/g, " ");
    if (!title) throw new Error("Name the step");
    if (title.length > 120) throw new Error("A step's name is at most 120 characters");
    if (!AGENT_KINDS.includes(req.agent)) throw new Error(`There's no agent ${JSON.stringify(req.agent)}: a step runs Claude or Codex`);
    const group = req.taskGroup?.trim() || null;
    if (group?.includes("/")) throw new Error(STEP_NOT_IN_STACK);
    let repoPath: string | null;
    let cwd: string;
    let sharesWith: string | undefined;
    if (req.sharesWith) {
      this.ownOnly(req.sharesWith, "add a step in its folder");
      const other = this.live.get(req.sharesWith)?.info ?? this.recordOf(req.sharesWith);
      if (!other) throw new Error(`This Mac has no session "${req.sharesWith}" whose folder a step could work in`);
      ({ repoPath, cwd } = other);
      sharesWith = other.id;
    } else {
      repoPath = req.repoPath ? expandHome(req.repoPath) : null;
      if (repoPath && !fs.existsSync(repoPath)) throw new Error(`${repoPath} isn't there`);
      if (req.worktree && !repoPath) throw new Error("A worktree needs a repo");
      cwd = repoPath ?? os.homedir();
    }
    this.refuseRoomFolder(group ?? (req.ticketId?.trim() || null), cwd);
    let id = randomUUID().slice(0, 8);
    while (this.live.has(id) || this.recordOf(id)) id = randomUUID().slice(0, 8);
    const prompt = req.prompt?.trim();
    const planned: PlannedStep = {
      worktree: !sharesWith && !!repoPath && !!req.worktree,
      ...(!sharesWith && repoPath && req.base ? { base: req.base } : {}),
      ...(sharesWith ? { sharesWith } : {}),
      ...(prompt ? { prompt } : {}),
    };
    const ticketId = req.ticketId?.trim() || null;
    const info: SessionInfo = {
      id,
      title,
      repoPath,
      cwd,
      branch: null,
      ticketId,
      ticketTitle: (ticketId && req.ticketTitle?.trim()) || null,
      // as create() would group it: its group, else its ticket's
      taskGroup: group ?? ticketId,
      status: "idle",
      createdAt: Date.now(),
      kind: repoPath ? "work" : "assistant",
      extraDirs: [],
      waitingReason: null,
      waitingSince: null,
      agent: req.agent,
      ...(req.model?.trim() ? { model: req.model.trim() } : {}),
      ...(req.effort?.trim() ? { effort: req.effort.trim() } : {}),
      planned,
    };
    this.store.upsertSession(info);
    this.emitChanged();
    return info;
  }

  /**
   * Start not-started step `id` under its id, so its wires keep their ends: create() with reuseId, the running session's
   * record taking its place, where `stepPlace` says, the pane saying how it came to start there. A worktree made for it
   * is taken back when the start then fails, so starting it again gets the same branch. Refused, nothing started and
   * its record kept, when it can't be started now (`startable`) or where it would start can't be used (`stepPlace`),
   * asked again as its pty is about to start (`stillStartable`).
   */
  async startPlanned(id: string, upstream?: string | null): Promise<SessionInfo> {
    const rec = this.startable(id);
    // the area its launch is prepared for: a move meanwhile changes the record in place
    const group = rec.taskGroup ?? null;
    this.starting.add(id);
    try {
      const { where, notes, uses } = await this.stepPlace(rec, upstream ?? null);
      const repo = where.useWorktree && where.repoPath ? expandHome(where.repoPath) : null;
      // a room step's worktree is made, and taken back, as a team room session's (create's own)
      const own = !!this.ownHooksFor?.(group ?? rec.ticketId ?? null);
      const made = repo && where.branchName ? { repo, folder: path.join(worktreeRoot(repo), where.branchName), branch: where.branchName, own } : null;
      const fresh = !!made && !fs.existsSync(made.folder);
      try {
        return await this.create(
          {
            ...where,
            ticketId: rec.ticketId ?? undefined,
            ticketTitle: rec.ticketTitle ?? undefined,
            taskGroup: group ?? undefined,
            extraDirs: rec.extraDirs,
            title: rec.title,
            agent: rec.agent ?? "claude",
            model: rec.model ?? undefined,
            effort: rec.effort ?? undefined,
            permissionMode: rec.permissionMode ?? undefined,
            ...(rec.planned!.prompt ? { initialPrompt: rec.planned!.prompt } : {}),
            reuseId: id,
          },
          { notice: notes.join("\n") || undefined, beforeSpawn: () => this.stillStartable(rec, group, uses) }
        );
      } catch (err) {
        if (made && fresh) await this.takeBackStart(id, made, err);
        throw err;
      }
    } finally {
      this.starting.delete(id);
    }
  }

  /** Where not-started step `id` would start now, as its Start now confirm says it; refused as starting it would be. */
  async describeStart(id: string, upstream?: string | null): Promise<string> {
    return (await this.stepPlace(this.startable(id), upstream ?? null)).says;
  }

  /** Not-started step `id`'s record, when it may be started now; else why not, thrown. */
  private startable(id: string): SessionInfo {
    this.ownOnly(id, "start it");
    this.refuseWhileQuitting();
    this.notResuming(id);
    if (this.live.has(id)) throw new Error("It's running already");
    const rec = this.recordOf(id);
    if (!rec) throw new Error("Its saved record is gone, so there's nothing to start");
    if (!rec.planned) throw new Error("It has started already: reopen it instead");
    this.mayRun(id);
    return rec;
  }

  /**
   * What `stepPlace` checked of the sessions step `rec` starts from (`uses`), checked again as its pty is about to start:
   * they, or the step, may have crossed a team room's line or been taken over while its git was read and its launch
   * prepared. Also refused when the step moved to another area meanwhile, as its launch was prepared for `group`.
   */
  private stillStartable(rec: SessionInfo, group: string | null, uses: readonly StepUse[]): void {
    for (const u of uses) {
      const other = this.live.get(u.id)?.info ?? this.recordOf(u.id);
      if (!other) throw new Error(`${titled(rec)} can't start ${u.what}: that session was forgotten as it started`);
      this.stepMayUse(rec, other, u.what);
    }
    if ((this.recordOf(rec.id)?.taskGroup ?? null) !== group) throw new Error(`${titled(rec)} moved to another area as it started, so it wasn't started: start it again`);
  }

  /** Whether step `rec` may start `what` ("in “Builder”'s folder", "from “Builder”'s commit") of session `other`; thrown if not. */
  private stepMayUse(rec: SessionInfo, other: SessionInfo, what: string): void {
    const why = this.startGuard?.(rec.id, other.id) ?? this.relaunchGuard?.(other.id) ?? null;
    if (why) throw new Error(`${titled(rec)} can't start ${what}: ${why}`);
  }

  /** A failed start's worktree and branch, made for it, removed; one that can't be is said with the start's failure. */
  private async takeBackStart(id: string, made: { repo: string; folder: string; branch: string; own: boolean }, failed: unknown): Promise<void> {
    try {
      await dropNewWorktree(made.repo, made.folder, made.branch, { own: made.own });
    } catch (err) {
      console.error(`[sessions] ${id}'s start failed, and what it made couldn't all be taken back:`, err);
      throw new Error(`${failed instanceof Error ? failed.message : String(failed)}. What it made is still there: ${err instanceof Error ? err.message : err}`, { cause: failed });
    }
  }

  /**
   * Where not-started step `rec` starts now, the notes its pane shows, and what its Start now confirm says:
   * - the folder it shares (`sharesWith`, decision 7), on its branch as it stands;
   * - else a worktree of its own on a new branch led by the step before's (never a base branch's name): at the commit
   *   `upId`'s folder is on now, never origin's, when that's in its repo; otherwise cut from its base, or at the repo's
   *   HEAD with none, saying why;
   * - else its repo's checkout, or home with no repo.
   * Refused, nothing made, when what it starts from is across a team room's line from it or continued by a teammate
   * (startGuard, relaunchGuard), not started itself, forgotten, or gone. `uses`: the sessions it starts from, checked so.
   */
  private async stepPlace(rec: SessionInfo, upId: string | null): Promise<{ where: StepWhere; notes: string[]; says: string; uses: StepUse[] }> {
    const step = rec.planned!;
    const name = titled(rec);
    const uses: StepUse[] = [];
    const mayUse = (other: SessionInfo, what: string) => {
      this.stepMayUse(rec, other, what);
      uses.push({ id: other.id, what });
    };
    if (step.sharesWith) {
      const other = this.live.get(step.sharesWith)?.info ?? this.recordOf(step.sharesWith);
      if (!other) throw new Error(`${name} works in another session's folder, and that session was forgotten: forget this step and add it again`);
      if (other.planned) throw new Error(`${name} works in ${titled(other)}'s folder, and ${titled(other)} hasn't started: start it first`);
      mayUse(other, `in ${titled(other)}'s folder`);
      if (!fs.existsSync(other.cwd)) throw new Error(`${name} works in ${titled(other)}'s folder, ${other.cwd}, which isn't there any more`);
      const status = this.live.get(other.id)?.info.status;
      const beside = status ? (status === "dead" ? `, where ${titled(other)} has exited` : `, while ${titled(other)} is ${STATUS_WORD[status]}`) : "";
      return {
        where: { repoPath: other.repoPath, cwd: other.cwd, branchName: other.branch ?? undefined, useWorktree: false },
        notes: [],
        says: `It starts in ${titled(other)}'s folder, ${tildePath(other.cwd)}${other.branch ? `, on ${other.branch}` : ""}${beside}.`,
        uses,
      };
    }
    if (!step.worktree || !rec.repoPath) {
      return {
        where: { repoPath: rec.repoPath, useWorktree: false },
        notes: [],
        says: rec.repoPath ? `It starts in ${path.basename(expandHome(rec.repoPath))}'s checkout, on whatever's out there.` : "It starts in your home folder, with no repo.",
        uses,
      };
    }
    const repo = expandHome(rec.repoPath);
    const notes: string[] = [];
    const from = await this.upstreamCommit(repo, upId, mayUse);
    let at: Pick<NewSessionRequest, "startAt" | "baseBranch">;
    let how: string;
    if ("sha" in from) {
      const left =
        typeof from.dirty === "object"
          ? `: its uncommitted files couldn't be counted (${from.dirty.unread}), and none are carried`
          : from.dirty === 1
            ? ": its uncommitted file isn't carried"
            : from.dirty
              ? `: its ${from.dirty} uncommitted files aren't carried`
              : "";
      how = from.gone ? `at ${from.of}'s branch ${from.branch} (${from.sha.slice(0, 7)}): its folder is gone` : `at ${from.of}'s commit ${from.sha.slice(0, 7)}${left}`;
      at = { startAt: from.sha };
    } else {
      console.warn(`[sessions] not-started step ${rec.id} in ${repo}: ${from.why}`);
      if (step.base) {
        how = `cut from ${step.base}, as a new worktree is: ${lowerFirst(from.why)}`;
        at = { baseBranch: step.base };
      } else {
        const head = await git(repo, ["rev-parse", "--verify", "HEAD"]);
        how = `at ${path.basename(repo)}'s HEAD, ${head.slice(0, 7)}: ${lowerFirst(from.why)}`;
        at = { startAt: head };
      }
    }
    notes.push(`Started ${how}.`);
    const branch = await this.stepBranch(repo, rec, "sha" in from ? from.branch : null, notes);
    return { where: { repoPath: rec.repoPath, useWorktree: true, branchName: branch, ...at }, notes, says: `It starts in a new worktree, ${branch}, ${how}.`, uses };
  }

  /**
   * A not-started step's new branch in `repo`: the step's name led by the branch of the step before (`lead`), or by
   * "step" with none or one git wouldn't take as a branch's name (said in `notes`), unique among the repo's. Refused
   * when that would be a base branch's name.
   */
  private async stepBranch(repo: string, rec: SessionInfo, lead: string | null, notes: string[]): Promise<string> {
    let head = lead;
    if (head && !(await isBranchName(repo, head))) {
      notes.push(`The branch it follows, ${JSON.stringify(head)}, can't lead a branch's name, so its own starts "step".`);
      head = null;
    }
    const name = `${head ?? "step"}-${stepSlug(rec.title)}`;
    const bases = [...BASE_NAMES.dev, ...BASE_NAMES.main, ...(rec.planned?.base ? [rec.planned.base] : [])].map((b) => b.toLowerCase());
    if (bases.includes(name.toLowerCase())) throw new Error(`${titled(rec)} would start on ${name}, a base branch's name: rename the step`);
    const { local, origin } = await branchesOf(repo);
    return uniqueBranch(name, [...local, ...origin]);
  }

  /**
   * The commit a not-started step's new worktree in `repo` starts at: the one upstream session `upId`'s folder is on now
   * (its branch's tip when its folder is gone, `gone`), with that branch and how many files there are uncommitted (or
   * why they couldn't be counted: the count only informs the pane, so a status that fails doesn't stop the start). Else
   * why there's none to start at in `repo`: nothing hands off to it, the step before it was forgotten or hasn't started
   * itself, works in another repository or none, or its folder and branch are gone. `mayUse` refuses (throws) an
   * upstream whose commit mustn't be used; so does a commit that can't be read.
   */
  private async upstreamCommit(repo: string, upId: string | null, mayUse: (up: SessionInfo, what: string) => void): Promise<UpstreamCommit> {
    if (!upId) return { why: "Nothing hands off to it" };
    const up = this.live.get(upId)?.info ?? this.recordOf(upId);
    if (!up) return { why: "The step before it was forgotten" };
    const of = titled(up);
    if (up.planned) return { why: `${of} hasn't started, so it has no commit to start at` };
    if (!up.repoPath || !samePath(expandHome(up.repoPath), repo)) return { why: `${of} works ${up.repoPath ? "in another repository" : "outside any repository"}` };
    mayUse(up, `from ${of}'s commit`);
    try {
      if (fs.existsSync(up.cwd)) {
        const sha = await git(up.cwd, ["rev-parse", "--verify", "HEAD"]);
        const branch = await currentBranch(up.cwd);
        let dirty: number | { unread: string };
        try {
          // a guarded status: the upstream's folder may be a team room session's, whose config could name what a status runs
          dirty = await dirtyFileCount(up.cwd);
        } catch (err) {
          const unread = err instanceof Error ? err.message : String(err);
          console.warn(`[sessions] ${of}'s uncommitted files in ${up.cwd} couldn't be counted for a step's start at ${sha.slice(0, 7)}:`, err);
          dirty = { unread };
        }
        return { sha, branch, of, dirty, gone: false };
      }
      if (!up.branch) return { why: `${of}'s folder is gone` };
      const sha = await git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${up.branch}`], { okCodes: [0, 1] });
      if (!sha) return { why: `${of}'s folder and its branch, ${up.branch}, are gone` };
      return { sha, branch: up.branch, of, dirty: 0, gone: true };
    } catch (err) {
      throw new Error(`Couldn't read the commit ${of} is on: ${err instanceof Error ? err.message : err}`, { cause: err });
    }
  }

  /**
   * Where closed session `old` runs again: always its own folder, as its conversation's transcript is kept by folder. A
   * relaunch never switches a branch, so it runs on whatever's out there now, says so (`moved`) when that isn't what it
   * was on, and is labelled with it, as what a session says it's on is what stops another switching a checkout under it
   * and what reviewing it reads. A worktree that's gone is made again there, from its branch, never made anew
   * (createWorktree's mustExist); any other folder that's gone throws. So when this returns it has somewhere to run.
   */
  private async whereAgain(old: SessionInfo): Promise<PlaceAgain> {
    // the Helpdesk tasks workspace always runs in ~/Helpdesk, which create() makes again when it's gone
    if (old.role === "tasks") return { where: { useWorktree: false } };
    const repo = old.repoPath ? expandHome(old.repoPath) : null;
    if (!fs.existsSync(old.cwd)) {
      if (!repo || old.cwd === repo || !old.branch) throw new Error(`${old.cwd} doesn't exist any more`);
      const warnings: string[] = [];
      const own = !!this.ownHooksFor?.(old.taskGroup ?? null);
      const cwd = await createWorktree(repo, old.branch, undefined, { mustExist: true, at: old.cwd, warn: (text) => warnings.push(text), own });
      return { where: { cwd, branchName: old.branch, useWorktree: false }, ...(warnings.length ? { warnings } : {}) };
    }
    const where = { cwd: old.cwd, useWorktree: false };
    // a folder with no branch on record, in the repo's own place or in none, may be no repository at all
    if (!repo || (old.cwd === repo && !old.branch)) return { where };
    let out: string | null;
    try {
      out = await currentBranch(old.cwd);
    } catch (err) {
      console.error(`[sessions] ${old.id}: couldn't read the branch out in ${old.cwd}, going by its record:`, err);
      return { where: { ...where, branchName: old.branch ?? undefined } };
    }
    const moved = old.branch && out !== old.branch ? `This session was on ${old.branch}. Its folder is on ${out ?? "a detached HEAD"} now.` : undefined;
    return { where: { ...where, branchName: out ?? undefined }, moved };
  }

  /**
   * Start persisted session `old` again under its id, resuming what `plan` says, where `place` says; `freed` and where
   * it's moved are shown in its pane. `change` (relaunchWith) replaces what it names of its mode, model and effort.
   */
  private async launchAgain(old: SessionInfo, plan: RelaunchPlan, place: PlaceAgain, freed: string | undefined, change: RelaunchChange = {}): Promise<SessionInfo> {
    const notice = [freed, place.moved, ...(place.warnings ?? [])].filter(Boolean).join("\n") || undefined;
    if (notice) console.warn(`[sessions] ${old.id}: ${notice}`);
    const { conv, sameAgent, resume } = plan;
    // create() re-adds the record; only forget the old one once it has, or a
    // failed relaunch (missing worktree, spawn error) erases the session for good
    const info = await this.create({
      repoPath: old.repoPath,
      ticketId: old.ticketId ?? undefined,
      ticketTitle: old.ticketTitle ?? undefined,
      ...place.where,
      taskGroup: old.taskGroup ?? undefined,
      extraDirs: old.extraDirs,
      resume,
      ...(old.shell ? (conv ? { shellResume: conv } : {}) : sameAgent ? { resumeSessionId: conv!.id } : {}),
      reuseId: old.id, // same id → persisted grid position and group still apply
      title: old.title,
      debrief: old.debrief,
      shell: old.shell,
      role: old.role,
      model: (change.model !== undefined ? change.model : old.model) ?? undefined,
      effort: (change.effort !== undefined ? change.effort : old.effort) ?? undefined,
      permissionMode: change.permissionMode ?? old.permissionMode ?? undefined,
      agent: old.agent,
    }, { notice, ...(old.shell && old.agentQuit ? { agentQuit: old.agentQuit, conversation: old.conversation } : {}) });
    // a muted pane stays muted through restarts
    if (old.muted) {
      info.muted = true;
      this.store.upsertSession(info);
    }
    return info;
  }

  /**
   * Passive snapshot of every live coding session for the daily digest:
   * metadata plus the ANSI-stripped tail of the terminal buffer. Reads only —
   * nothing is ever written to a pty, so no session is interrupted.
   */
  digest(): { info: SessionInfo; tail: string }[] {
    const ansi = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>]|\r/g;
    return [...this.live.values()]
      // nothing the Helpdesk tasks workspace read (requests, admin pages) becomes another agent's prompt
      .filter((s) => !s.info.debrief && s.info.role !== "tasks")
      .map((s) => ({
        info: { ...s.info },
        tail: s.buffer
          .replace(ansi, "")
          .split("\n")
          .map((l) => l.trimEnd())
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .slice(-3000),
      }));
  }

  /** Manual override for a stale waiting or working state — marks the session idle, and delivers what waited for that. */
  clearWaiting(id: string): void {
    this.ownOnly(id, "mark it as idle");
    const s = this.live.get(id);
    if (!s || (s.info.status !== "waiting" && s.info.status !== "working")) return;
    this.setStatus(id, "idle");
    this.flushQueued(s);
  }

  /** Move a session (live or previous) to a task group; null removes it from its group. */
  setGroup(id: string, group: string | null): void {
    if (!this.live.has(id) && this.remote?.has(id)) throw new Error("That's a teammate's session: only its owner can move it to another group");
    const g = group?.trim() || null;
    const s = this.live.get(id);
    if (g && this.roomOfGroup?.(g) && (s?.info ?? this.recordOf(id))?.role === "tasks") throw new Error(`${HELPDESK_IN_ROOM}.`);
    if (g?.includes("/") && !s && this.recordOf(id)?.planned) throw new Error(STEP_NOT_IN_STACK);
    if (s) {
      s.info.taskGroup = g;
      this.store.upsertSession(s.info);
    } else {
      const p = this.store.state.sessions.find((x) => x.id === id);
      if (p) {
        p.taskGroup = g;
        this.store.save();
      }
    }
    this.emitChanged();
  }

  rename(id: string, title: string): void {
    if (!this.live.has(id) && this.remote?.has(id)) throw new Error("That's a teammate's session: only its owner can rename it");
    const s = this.live.get(id);
    if (s) {
      s.info.title = title;
      s.info.ticketTitle = s.info.ticketTitle ? title : s.info.ticketTitle;
      this.store.upsertSession(s.info);
    } else {
      const p = this.store.state.sessions.find((x) => x.id === id);
      if (p) {
        p.title = title;
        this.store.save();
      }
    }
    this.emitChanged();
  }

  renameGroup(oldKey: string, newKey: string): void {
    // prefix-aware: renaming group "5101" must carry "5101/etl" → "X/etl"
    const remap = (g: string | null): string | null =>
      g === oldKey ? newKey : g && g.startsWith(oldKey + "/") ? newKey + g.slice(oldKey.length) : g;
    const records = [...[...this.live.values()].map((s) => s.info), ...this.store.state.sessions];
    if (this.roomOfGroup?.(newKey) && records.some((s) => s.role === "tasks" && remap(s.taskGroup) !== s.taskGroup)) throw new Error(`${HELPDESK_IN_ROOM}.`);
    for (const s of this.live.values()) {
      const n = remap(s.info.taskGroup);
      if (n !== s.info.taskGroup) {
        s.info.taskGroup = n;
        this.store.upsertSession(s.info);
      }
    }
    for (const p of this.store.state.sessions) {
      const n = remap(p.taskGroup);
      if (n !== p.taskGroup) p.taskGroup = n;
    }
    this.store.save();
    this.emitChanged();
  }

  write(id: string, data: string): void {
    const s = this.live.get(id);
    if (!s) {
      if (this.remote?.has(id)) this.remote.write(id, data);
      return;
    }
    // between its agent's exit and its terminal's start, nothing runs in it to take a key
    if (s.toTerminal) return;
    s.lastInput = Date.now();
    // a room launch's sandbox report already written is read before an Enter could start its first turn
    if (s.sandbox?.state === "starting" && data.includes("\r")) this.catchUpHooks();
    // Enter sends the draft and Ctrl-C clears it; escape sequences (arrows, focus
    // reports) don't add text — except a bracketed paste, which is text.
    // Anything else leaves unsent text in the prompt.
    // Keys pressed while the agent asks for permission answer it, and leave nothing in its prompt.
    if (/[\r\x03]/.test(data) && !data.startsWith("\x1b[200~")) s.draft = false;
    else if (s.info.status === "waiting") return void s.proc.write(data);
    else if (!data.startsWith("\x1b") || data.startsWith("\x1b[200~")) s.draft = true;
    s.proc.write(data);
  }

  /**
   * A teammate's typing (allowed to type, LivePanes.answerInput). While a Codex's folder notice holds, it's held and typed
   * in order once Codex has opened: typed into the notice, a "2" or Esc would answer it. The pane's owner types through
   * `write`, never held. "full" when what's held would pass MAX_HELD_INPUT.
   */
  writeFromTeammate(id: string, data: string): "typed" | "held" | "full" {
    const s = this.live.get(id);
    if (!s?.folderNotice?.holding()) {
      this.write(id, data);
      return "typed";
    }
    const held = s.heldInput.reduce((n, d) => n + d.length, 0);
    if (held + data.length > MAX_HELD_INPUT) return "full";
    s.heldInput.push(data);
    return "held";
  }

  /** Resize a pane's pty. A teammate's session is never resized from here: its owner's window decides its size. */
  resize(id: string, cols: number, rows: number): void {
    const s = this.live.get(id);
    if (!s) return;
    try {
      s.proc.resize(cols, rows);
    } catch {
      return; // dead pty
    }
    if (s.cols === cols && s.rows === rows) return;
    s.cols = cols;
    s.rows = rows;
    this.tell("change", this.watchers);
  }

  buffer(id: string): string {
    return this.live.get(id)?.buffer ?? "";
  }

  /**
   * A live pane's output from the start of a line: a buffer kept to BUFFER_MAX starts wherever that cut fell, and a
   * line cut through (`…WORD=value`) reads as something it isn't. What a closed pane's saved output gives, as closedOutput.
   */
  bufferFromLine(id: string): string {
    const b = this.buffer(id);
    return b.length >= BUFFER_MAX ? fromLineStart(b) : b;
  }

  /** What a pane's terminal starts from: its scrollback, or for a teammate's session, its owner's. */
  paneBuffer(id: string): string | Promise<string> {
    if (!this.live.has(id) && this.remote?.has(id)) return this.remote.buffer(id);
    return this.buffer(id);
  }

  /** A live pane's output so far, where it ends in its pty's output, and its pty's size (what a teammate's copy starts from). */
  paneOutput(id: string): PaneSnapshot | null {
    const s = this.live.get(id);
    return s ? { data: s.buffer, epoch: s.epoch, end: s.total, cols: s.cols, rows: s.rows } : null;
  }

  /**
   * What a live session was started with as a room session; null when it wasn't started in a room. A Claude launch is
   * `starting` until its sandbox reports in, and without secrets once it didn't (RoomSandboxWatch). One started with
   * its room's sandbox switched off is `outside` it, without secrets, once its room has it on (roomSandboxChange).
   */
  guardsOf(id: string): RoomLaunch["guards"] | null {
    const s = this.live.get(id);
    if (!s?.guards) return null;
    const state = s.sandbox?.state;
    const g = state === "failed" ? { ...s.guards, secrets: false } : state === "starting" ? { ...s.guards, starting: true } : s.guards;
    return this.roomSandboxChange(id) === "missing" ? { ...g, secrets: false, outside: true } : g;
  }

  /**
   * How live session `id`'s room sandbox differs from what its group's room asks for now (RoomSandboxChange): a room's
   * sandbox settings are read at launch only, so it lasts until a restart. Null when they agree, or it's no room launch.
   * Only a sandbox known to be on is one it keeps: a Claude launch's once it confirmed (RoomSandboxWatch), a Codex
   * one's when it was guarded; one that didn't start or hasn't yet says so through its guards instead.
   */
  roomSandboxChange(id: string): RoomSandboxChange | null {
    const s = this.live.get(id);
    if (!s?.guards) return null;
    const off = s.info.taskGroup ? (this.roomSandboxOff?.(s.info.taskGroup) ?? null) : null;
    if (s.guards.unsandboxed) return off === false ? "missing" : null;
    const confirmed = s.roomSandboxed && s.guards.secrets && (s.sandbox ? s.sandbox.state === "confirmed" : s.info.agent === "codex");
    return confirmed && off !== false ? "kept" : null;
  }

  /** A room launch's sandbox settings reported in for pane `id` (hooks.ts): `late`, beside one of its turn's events. */
  roomSandboxReported(id: string, marker: string, late: boolean): void {
    this.live.get(id)?.sandbox?.reported(marker, late);
  }

  private watchSandbox(sess: LiveSession, marker: string): RoomSandboxWatch {
    const current = () => this.live.get(sess.info.id) === sess;
    return new RoomSandboxWatch(
      marker,
      {
        confirmed: () => {
          if (current()) this.emitChanged();
        },
        failed: (why) => {
          if (!current()) return;
          console.warn(`[sessions] ${sess.info.id} isn't in its team room's sandbox: ${why}`);
          this.watchSettingsWhileChecked();
          this.emitChanged();
          try {
            this.sandboxLost?.(sess.info, why);
          } catch (err) {
            console.error(`[sessions] telling the user ${sess.info.id} isn't in its room's sandbox failed:`, err);
          }
        },
      },
      this.sandboxReportMs
    );
  }

  /**
   * Claude Code's own account of a room launch's sandbox, asked beside the pane (it doesn't wait for it): the room's
   * line opens only once it shows the sandbox on as the room wrote it (RoomSandboxWatch). It's asked `again` when the
   * settings the pane also takes change (recheckSandboxes), and closes the line then if it no longer does. Each verdict
   * is logged.
   */
  private proveSandbox(sess: LiveSession, p: SandboxProbe, again = false): void {
    const current = () => this.live.get(sess.info.id) === sess;
    // from before it's asked, so a change it didn't see is one the watch does
    this.settingsWatch ??= new SettingsWatch(claudeSandboxSources(), () => this.recheckSandboxes(), this.settingsTiming);
    this.settingsWatch.start();
    this.sandboxProbe(p)
      .catch((err): SandboxVerdict => ({ ok: false, why: `Mockingbird's check of its sandbox failed (${(err as Error).message})`, log: `refused: the check threw: ${(err as Error).message}` }))
      .then((v) => {
        if (!current() || !sess.sandbox) return;
        const what = again ? "sandbox re-check" : "sandbox check";
        if (v.ok) console.log(`[sessions] ${sess.info.id}: ${what} ${v.log}`);
        else console.warn(`[sessions] ${sess.info.id}: ${what} ${v.log}`);
        if (v.ok) sess.sandbox.proved();
        else {
          const why = v.why ?? "Mockingbird's check of its sandbox failed";
          sess.sandbox.disproved(again ? `after its Claude Code settings changed, ${why}` : why);
        }
      });
  }

  /** Room panes whose sandbox is still to be kept checked: running, and not already outside it. */
  private checkedSandboxes(): LiveSession[] {
    return [...this.live.values()].filter((s) => s.sandboxCheck && s.sandbox && s.sandbox.state !== "failed");
  }

  /** The settings a room pane takes are watched while one runs whose sandbox is checked (proveSandbox starts it). */
  private watchSettingsWhileChecked(): void {
    if (!this.checkedSandboxes().length) this.settingsWatch?.stop();
  }

  /** The user's or an administrator's Claude Code settings changed: each running room pane's sandbox is asked again. */
  private recheckSandboxes(): void {
    const panes = this.checkedSandboxes();
    if (!panes.length) return this.watchSettingsWhileChecked();
    console.log(`[sessions] Claude Code's settings changed: checking the sandbox of ${panes.length} room pane(s) again`);
    for (const s of panes) this.proveSandbox(s, s.sandboxCheck!, true);
  }

  /** A Codex room launch's folder notice, answered when it's exactly the one to answer (CodexFolderNotice). */
  private watchFolderNotice(sess: LiveSession): CodexFolderNotice {
    const current = () => this.live.get(sess.info.id) === sess;
    const tell = (what: "answered" | "asking", why?: string) => {
      try {
        this.folderNoticeSeen?.(sess.info, what, why);
      } catch (err) {
        console.error(`[sessions] telling the user about ${sess.info.id}'s folder notice failed:`, err);
      }
    };
    return new CodexFolderNotice({
      press: () => {
        if (current()) sess.proc.write("\r");
      },
      answered: (press) => {
        if (!current()) return;
        console.log(`[sessions] ${sess.info.id}: answered its Codex's folder notice with “Open restricted” (Enter, press ${press})`);
        tell("answered");
      },
      asking: (why) => {
        if (!current()) return;
        console.warn(`[sessions] ${sess.info.id}: its Codex's folder notice is left to the user: ${why}`);
        tell("asking", why);
      },
      cleared: (by) => {
        if (!current()) return;
        for (const data of sess.heldInput.splice(0)) this.write(sess.info.id, data);
        // a hook's event goes on to deliver what waited as its status says (statusFromHook): flushed here too, a second
        // message would go while the first one's turn runs
        if (by !== "hook" && sess.info.status === "idle") this.flushQueued(sess);
        this.emitChanged();
      },
      ...this.folderNoticeTiming,
    });
  }

  /**
   * Close a pane. Unless `forget`, it stays resumable: its scrollback and undelivered messages are kept for its relaunch.
   * Forgetting one that's being resumed or relaunched is refused: its relaunch would write its record back, history gone.
   */
  kill(id: string, forget = false): void {
    this.ownOnly(id, "close it");
    if (forget && this.resuming.has(id)) throw new Error(`${BEING_RESUMED}: forget it once it has opened`);
    if (forget && this.relaunching.has(id)) throw new Error(`${BEING_RELAUNCHED}: forget it once it has opened`);
    if (forget && this.starting.has(id)) throw new Error(`${BEING_STARTED}: forget it once it has opened`);
    const s = this.live.get(id);
    if (s) {
      retireMcpLaunch(s.mcp); // now, not at its exit: the same id may run again before this pty has gone
      try {
        s.proc.kill();
      } catch {
        /* already dead */
      }
      if (s.flushTimer) clearTimeout(s.flushTimer);
      if (s.startTimer) clearTimeout(s.startTimer);
      this.live.delete(id);
    }
    const owed = [...(this.undelivered.get(id) ?? []), ...(s ? this.withoutReceipts(s.queued, `${paneName(s.info)} was closed before this reached it`) : [])];
    this.undelivered.delete(id);
    if (owed.length && !forget) this.undelivered.set(id, owed);
    else if (owed.length) {
      console.warn(`[sessions] ${id} closed with ${owed.length} undelivered message(s): ${owed.map((m) => JSON.stringify(m.text.slice(0, 100))).join(", ")}`);
    }
    // the pane is closed whether or not its scrollback can be saved
    try {
      if (forget) this.dropScrollback(id);
      else if (s) this.writeScrollback(s);
    } catch (err) {
      console.error(`[sessions] couldn't ${forget ? "remove" : "save"} scrollback for ${id}:`, err);
    }
    if (forget) this.store.removeSession(id);
    this.emitChanged();
  }

  /**
   * Inject a chat message into a session (paste, then submit unless told not
   * to). Callers paste only into a pane at its prompt; should its agent start
   * asking for permission before the Enter, the Enter isn't sent — it would
   * answer that — and the message waits in the prompt as a draft. `receipt` hears how it went (QueueReceipt); `placed`
   * says why a message not submitted was left there. Returns whether it was pasted.
   */
  sendMessage(id: string, message: string, submit = true, receipt?: QueueReceipt, placed?: string): boolean {
    const s = this.live.get(id);
    if (!s) {
      this.settle(receipt, "failed", "its pane isn't running");
      return false;
    }
    // a terminal runs what's typed: a message meant for an agent (a kickoff due after its agent quit) never goes in
    if (s.info.shell || s.toTerminal) {
      console.warn(`[sessions] ${id} is a terminal now: a message for its agent wasn't typed into it`);
      this.settle(receipt, "failed", `${paneName(s.info)} is a terminal now, so this wasn't typed into it`);
      return false;
    }
    if (receipt && !this.mayPaste(receipt, id)) return false;
    // bracketed paste so multi-line messages arrive as one prompt
    s.proc.write(`\x1b[200~${pasteText(message)}\x1b[201~`);
    if (!submit) {
      this.settle(receipt, "placed", placed ?? `It's in ${paneName(s.info)}'s prompt for you to send: its area leaves agents' messages there`);
      return true;
    }
    setTimeout(() => {
      // hook events reach main every POLL_MS: read what's written so far, so a permission prompt that came up since the
      // paste is seen before its Enter would answer it
      this.catchUpHooks();
      // quitting ends every pane and leaves its status as it was (onExit), so the check below can't see this one going:
      // an Enter now reaches an agent being ended, or none, and nothing submitted it
      if (this.quitting) {
        this.settle(receipt, "failed", `Mockingbird quit after this was pasted into ${paneName(s.info)} and before its Enter, so it wasn't submitted`);
        return;
      }
      if (this.live.get(id) !== s || s.info.status === "dead" || s.toTerminal) {
        this.settle(receipt, "failed", `${paneName(s.info)} stopped after this was pasted and before its Enter, so it wasn't submitted`);
        return;
      }
      if (s.info.status === "waiting") {
        s.draft = true;
        s.lastInput = Date.now();
        console.warn(`[sessions] ${id} started asking for permission as a message was pasted: it stays in the prompt, unsent`);
        this.settle(receipt, "placed", `${paneName(s.info)} started asking for permission as this was pasted, so it's in its prompt unsent: press Enter there once that's answered`);
        return;
      }
      s.proc.write("\r");
      this.settle(receipt, "sent");
    }, 120);
    return true;
  }

  /**
   * Mockingbird's own notice going in as a prompt: once its Enter has gone, the prompt its hooks report next is that
   * notice, not one its agent was given, so it isn't counted (promptCount: an automatic wire sends once per prompt).
   */
  private ownPrompt(s: LiveSession, inner?: QueueReceipt): QueueReceipt {
    return {
      pasting: () => (inner ? inner.pasting() : true),
      settled: (outcome, why) => {
        if (outcome === "sent") s.ownPrompts++;
        inner?.settled(outcome, why);
      },
    };
  }

  /** Reads the hook events written so far, at once (hooks.ts's watcher sets it while it runs). */
  hooksCatchUp: (() => void) | null = null;

  private catchUpHooks(): void {
    try {
      this.hooksCatchUp?.();
    } catch (err) {
      console.error("[sessions] couldn't read hook events before a message's Enter:", err);
    }
  }

  /** Take the queued message with `receipt` out of session `id`'s queue, unpasted: whether it was there. */
  withdraw(id: string, receipt: QueueReceipt): boolean {
    const s = this.live.get(id);
    const i = s?.queued.findIndex((m) => m.receipt === receipt) ?? -1;
    if (!s || i < 0) return false;
    s.queued.splice(i, 1);
    this.emitChanged();
    return true;
  }

  /** Whether session `id`'s queue holds the message with `receipt`, still unpasted. */
  holds(id: string, receipt: QueueReceipt): boolean {
    return !!this.live.get(id)?.queued.some((m) => m.receipt === receipt);
  }

  /** Whether a receipt lets its message be pasted now; one that throws doesn't, and is logged. */
  private mayPaste(receipt: QueueReceipt, id: string): boolean {
    try {
      return receipt.pasting() === true;
    } catch (err) {
      console.error(`[sessions] ${id}: a message's receipt failed as it was to be pasted, so it wasn't:`, err);
      return false;
    }
  }

  /** Tell a receipt how its message ended; one that throws is logged, never the queue's problem. */
  private settle(receipt: QueueReceipt | undefined, outcome: QueueOutcome, why?: string): void {
    if (!receipt) return;
    try {
      receipt.settled(outcome, why);
    } catch (err) {
      console.error(`[sessions] a message's receipt failed hearing it was ${outcome}:`, err);
    }
  }

  /** `queue` without the messages that have receipts, each failed with `why`: those are never kept for a later launch. */
  private withoutReceipts(queue: Queued[], why: string): Queued[] {
    for (const m of queue) if (m.receipt) this.settle(m.receipt, "failed", why);
    return queue.filter((m) => !m.receipt);
  }

  /**
   * Deliver a message from another agent session. An idle session gets it now;
   * a busy or blocked one gets it when its turn ends (Enter would otherwise answer
   * a pending permission prompt). While the user has unsent text in that prompt
   * it waits for them to send it; see flushQueued. With a `receipt`, what becomes of it is told there (QueueReceipt),
   * and a pane that has exited refuses it, as nothing would deliver it.
   */
  deliverAgentMessage(id: string, message: string, submit: boolean, from?: string, receipt?: QueueReceipt): string {
    return this.enqueue(id, { text: message, submit, at: Date.now(), ...(from ? { from } : {}), ...(receipt ? { receipt } : {}) });
  }

  /** Whether Mockingbird's notice under `key` still waits in session `id`'s queue (deliverNotice). */
  noticeWaiting(id: string, key: string): boolean {
    return !!this.live.get(id)?.queued.some((m) => m.key === key);
  }

  /**
   * Mockingbird's own notice to session `id`, under `key`: one still waiting in its queue is replaced where it waits, so
   * what's said while the agent works reaches it as one prompt at its next idle. Otherwise as deliverAgentMessage.
   */
  deliverNotice(id: string, key: string, message: string, submit: boolean): string {
    const s = this.live.get(id);
    if (!s) throw new Error(`session ${id} is not running`);
    const waiting = s.queued.find((m) => m.key === key);
    if (!waiting) return this.enqueue(id, { text: message, submit, at: Date.now(), key });
    waiting.text = message;
    waiting.submit = submit;
    this.emitChanged();
    return "queued, with what was already waiting for it";
  }

  private enqueue(id: string, m: Queued): string {
    const s = this.live.get(id);
    if (!s) throw new Error(`session ${id} is not running`);
    // typed into a shell, a message would run as a command (an agent pane whose agent quit is one now)
    if (s.info.shell) throw new Error(`${paneName(s.info)} is a terminal: agent messages are never typed into terminals`);
    if (s.info.status === "dead" && m.receipt) throw new Error(`${paneName(s.info)} has exited`);
    s.queued.push(m);
    if (s.info.status === "dead") {
      this.emitChanged();
      return "queued: it has exited, and it's delivered if it's reopened";
    }
    if (s.folderNotice?.holding()) {
      this.emitChanged();
      return "queued until its Codex has opened its folder (its folder notice is still up)";
    }
    if (s.info.status === "idle") {
      this.flushQueued(s);
      this.emitChanged();
      return s.queued.length ? "queued — the user has an unsent draft in that pane" : m.submit ? "delivered" : "placed in its prompt for the user to send";
    }
    this.emitChanged();
    // pasted now, its Enter would answer the prompt
    if (s.info.status === "waiting") return "queued: its agent is asking for permission, and it's delivered once that's answered";
    return "queued until its current turn ends";
  }

  /** Why Compact can't go to a session now (compactBlocker), or null when it can. */
  compactRefusal(id: string): string | null {
    if (isRemotePaneId(id)) return compactBlocker({ status: "idle", remote: true });
    const s = this.live.get(id);
    if (!s) return "The session isn't running";
    return compactBlocker({
      status: s.info.status,
      shell: !!s.info.shell,
      draft: s.draft,
      starting: s.kickoff || !!s.startTimer || !!s.folderNotice?.holding(),
      compactSentAt: s.compactSentAt,
    });
  }

  /**
   * Send /compact to a session, on the user's click — never queued: refused
   * unless the session is idle at its prompt with nothing typed there
   * (compactBlocker). A compaction reports no turn of its own (no Stop, and
   * its SessionStart says nothing), so the session's status is left as it is.
   */
  compact(id: string): void {
    const refusal = this.compactRefusal(id);
    if (refusal) throw new Error(refusal);
    const s = this.live.get(id)!;
    s.compactSentAt = Date.now();
    this.sendMessage(id, "/compact", true);
    console.log(`[sessions] ${id}: /compact sent from its context warning`);
  }

  /** Broadcast to sessions; queue for busy ones (delivered on the next idle).
   *  Shell sessions are always skipped — a broadcast typed into a shell would
   *  execute as commands — and so are debriefs, which are mid-interview.
   *  `skipHelpdesk` (the app Assistant's): the Helpdesk tasks workspace is skipped too, as nothing the Assistant
   *  sends reaches its conversation. */
  broadcast(message: string, sessionIds: string[], whenIdle: boolean, opts: { skipHelpdesk?: boolean } = {}): BroadcastOutcome[] {
    const targets = sessionIds.length
      ? sessionIds
      : [...this.live.values()]
          .filter((s) => s.info.kind === "work" && !s.info.shell)
          .map((s) => s.info.id);
    const outcomes: BroadcastOutcome[] = [];
    for (const id of targets) {
      const s = this.live.get(id);
      if (!s || s.info.status === "dead" || s.info.shell || s.info.debrief || (opts.skipHelpdesk && s.info.role === "tasks")) {
        outcomes.push({ id, outcome: "skipped" });
        continue;
      }
      // sent now into a Codex's folder notice, it would answer it: it waits with the queue for the notice's end
      if (!whenIdle && !s.folderNotice?.holding()) {
        this.sendMessage(id, message);
        outcomes.push({ id, outcome: "delivered" });
        continue;
      }
      // "waiting" counts as busy: sendMessage ends with Enter, which would
      // answer whatever prompt is blocking the session — including a pending
      // permission request the user has not looked at yet. An idle pane goes
      // through the queue too, which holds it while the user has unsent text
      // in the prompt (Enter would send that along with it).
      s.queued.push({ text: message, submit: true, at: Date.now() });
      if (s.info.status === "idle") this.flushQueued(s);
      outcomes.push({ id, outcome: s.queued.length ? "queued" : "delivered" });
    }
    this.emitChanged();
    return outcomes;
  }

  /**
   * Which prompt live pane `id`'s agent is on: its pty's epoch and the prompts its hooks have reported this launch (0
   * when they never do), Mockingbird's own notices left out. An automatic wire sends once per prompt by it
   * (wireDelivery.ts). Null when it isn't running.
   */
  promptCount(id: string): { epoch: string; seq: number } | null {
    const s = this.live.get(id);
    return s && s.info.status !== "dead" ? { epoch: s.epoch, seq: s.prompts } : null;
  }

  /** The transcript file a live pane's hooks named for conversation `conv`, or null when they haven't. */
  transcriptOf(id: string, conv: string): string | null {
    return this.live.get(id)?.transcripts.get(conv) ?? null;
  }

  /**
   * Called by the hooks watcher. Every pane exports MOCKINGBIRD_SESSION, which
   * its agent's hooks inherit, so an event names its pane exactly. Events
   * without it (a pane started by an older build) fall back to the agent's own
   * conversation id, then to the folder — which is ambiguous: two panes can
   * share a folder, and an agent that cd's reports the new folder.
   */
  statusFromHook(ev: {
    status: SessionStatus;
    cwd?: string;
    reason?: string;
    conversationId?: string;
    agent?: AgentKind;
    paneId?: string;
    /** The agent has just started (or resumed, or cleared): it is drawing its prompt. */
    started?: boolean;
    /** Its turn ended (the Stop hook). */
    finished?: boolean;
    /** It took a prompt (the UserPromptSubmit hook). */
    prompted?: boolean;
    /** The transcript file the agent is writing the conversation to (the hook's `transcript_path`). */
    transcriptPath?: string;
    /** When the hook wrote it (its `ts`, whole seconds). */
    at?: number;
  }): SessionInfo | null {
    // a tagged event that names no live pane comes from something else Mockingbird
    // runs (a Collaborate room) or a closed pane — never guess a pane for it
    const s = ev.paneId ? this.live.get(ev.paneId) ?? null : this.matchSession(ev.cwd, ev.conversationId);
    // events arrive up to a poll late: one written just before the agent exited
    // must not bring its dead pane back to life
    if (!s || s.info.status === "dead") return null;
    // so must one its agent wrote before quitting into a terminal: that terminal's status is its own, until an agent
    // started in it reports (an event written after its shell started; `at` is whole seconds)
    if (s.toTerminal || (s.info.agentQuit && ev.at !== undefined && ev.at <= Math.floor(s.info.createdAt / 1000))) return null;
    // nor one from the conversation it quit from running elsewhere (resumed in another terminal), as an exited pane hears
    // none: an agent running in this pane reports under its own id
    if (s.info.agentQuit?.conversation && ev.paneId !== s.info.id && ev.conversationId === s.info.agentQuit.conversation) return null;
    s.hookEvents++;
    // only the pane's own events speak for its launch's sandbox: one matched by folder may be another agent's
    if (s.sandbox && ev.paneId === s.info.id) {
      if (ev.started) s.sandbox.sessionStarted();
      else s.sandbox.turn(ev.at);
    }
    // Codex fires no hook until its folder notice is answered: its own event says it's past it
    if (s.folderNotice && ev.paneId === s.info.id) s.folderNotice.hookEvent();
    if (ev.prompted) {
      if (s.ownPrompts > 0) s.ownPrompts--;
      else {
        s.prompts++;
        s.promptAt = Date.now();
      }
    }
    if (s.info.hooksSilent) {
      s.info.hooksSilent = false;
      this.emitChanged();
    }
    if (ev.conversationId) this.noteConversation(s, ev.agent ?? s.info.agent ?? "claude", ev.conversationId);
    if (ev.conversationId && ev.transcriptPath) {
      s.transcripts.delete(ev.conversationId);
      s.transcripts.set(ev.conversationId, ev.transcriptPath);
      if (s.transcripts.size > 8) s.transcripts.delete(s.transcripts.keys().next().value!);
    }
    // a starting agent that is about to be given its kickoff prompt is about to work
    if (ev.started && s.kickoff) return s.info;
    this.setStatus(s.info.id, ev.status, ev.reason, finishedAtAfter(s.info, ev, Date.now()));
    if (ev.status !== "idle") return s.info;
    // deliver queued broadcasts whenever the session frees up (a session can
    // reach idle from waiting too — e.g. a declined permission, or the idle
    // reminder — and those queues used to strand forever). The start hook runs
    // while the agent is still drawing its prompt: what's typed then can be lost.
    if (!ev.started) this.flushQueued(s);
    else if (s.queued.length && !s.startTimer) {
      s.startTimer = setTimeout(() => {
        s.startTimer = null;
        if (this.live.get(s.info.id) === s && s.info.status === "idle") this.flushQueued(s);
      }, STARTED_SETTLE_MS);
    }
    return s.info;
  }

  /**
   * Queued agent messages that have waited `ms` or more, each reported once:
   * the sender is told its message hasn't arrived (a pane whose turn never
   * ends, or whose status is wrong, would otherwise hold it with no word).
   */
  overdueMessages(now: number, ms: number): OverdueMessage[] {
    const out: OverdueMessage[] = [];
    for (const s of this.live.values()) {
      // a terminal's messages wait for its agent's next launch (toTerminal)
      for (const m of [...s.queued, ...(this.undelivered.get(s.info.id) ?? [])]) {
        if (!m.from || m.overdueTold || now - m.at < ms) continue;
        m.overdueTold = true;
        const quit = s.info.shell ? s.info.agentQuit?.agent : undefined;
        out.push({ from: m.from, to: s.info.id, toTitle: s.info.ticketTitle ?? s.info.title, toStatus: s.info.status, hooksSilent: !!s.info.hooksSilent, waitedMs: now - m.at, ...(quit ? { quit } : {}) });
      }
    }
    return out;
  }

  /** The pane's current conversation is what a relaunch resumes; /clear starts a new one. */
  private noteConversation(s: LiveSession, agent: AgentKind, id: string): void {
    const cur = s.info.conversation;
    if (cur?.id === id && cur.agent === agent && conversationsOf(s.info).includes(id)) return;
    s.info.conversations = withConversation(s.info, id);
    s.info.conversation = { agent, id };
    this.store.upsertSession(s.info);
  }

  /**
   * The pane an untagged event belongs to: the one running its conversation,
   * wherever that has cd'd to since; else one in its folder. statusFromHook
   * then records the conversation as that pane's.
   */
  private matchSession(cwd: string | undefined, conversationId?: string): LiveSession | null {
    const all = [...this.live.values()];
    if (conversationId) {
      const bound = all.find((s) => s.info.conversation?.id === conversationId);
      if (bound) return bound;
    }
    if (!cwd) return null;
    const inCwd = all.filter((s) => s.info.cwd === cwd);
    if (!inCwd.length) return null;
    if (conversationId) {
      // a pane with no conversation yet takes it; when every pane here runs
      // another one (the CLI was restarted inside a pane), the newest does
      return inCwd.find((s) => !s.info.conversation) ?? inCwd[inCwd.length - 1];
    }
    return inCwd[0];
  }

  /**
   * Deliver messages queued while a session was busy. Pasting next to an
   * unsent draft would send the user's half-written prompt with it, so a
   * pending draft holds the queue until the user sends it (their turn then
   * ends in idle, which flushes). A draft left untouched for DRAFT_GIVE_UP_MS
   * gets the messages placed after it without Enter, for the user to see and
   * send themselves.
   *
   * Enter submits everything in the prompt, so one message is submitted per
   * turn — the pane is then working, and the rest wait for it to end.
   * Messages meant to be left for the user go once none are left to submit,
   * and the text they leave in the prompt then counts as a draft.
   */
  private flushQueued(s: LiveSession): void {
    if (!s.queued.length || s.info.status === "dead") return;
    // typed into Codex's folder notice, a message would answer it (a "2" quits): the notice's end flushes instead
    if (s.folderNotice?.holding()) return;
    const DRAFT_GIVE_UP_MS = 120_000;
    const RECHECK_MS = 5_000;
    const idleFor = Date.now() - s.lastInput;
    if (s.draft) {
      if (idleFor < DRAFT_GIVE_UP_MS) {
        if (s.flushTimer) clearTimeout(s.flushTimer);
        s.flushTimer = setTimeout(() => {
          s.flushTimer = null;
          if (this.live.get(s.info.id) === s && s.info.status === "idle") this.flushQueued(s);
        }, Math.min(RECHECK_MS, DRAFT_GIVE_UP_MS - idleFor));
        return;
      }
      const after = `You had unsent text in ${paneName(s.info)}'s prompt, so this was put after it, unsent: press Enter there to send both`;
      for (const m of s.queued.splice(0)) this.sendMessage(s.info.id, m.text, false, m.receipt, after);
      this.emitChanged();
      return;
    }
    // one submitted per turn; one its receipt kept out of the pane (it couldn't be written down) leaves the turn to the next
    for (let next = s.queued.findIndex((m) => m.submit); next >= 0; next = s.queued.findIndex((m) => m.submit)) {
      const [m] = s.queued.splice(next, 1);
      if (!this.sendMessage(s.info.id, m.text, true, m.key ? this.ownPrompt(s, m.receipt) : m.receipt)) continue;
      this.setStatus(s.info.id, "working");
      return;
    }
    let placed = false;
    for (const m of s.queued.splice(0)) placed = this.sendMessage(s.info.id, m.text, false, m.receipt) || placed;
    if (placed) {
      s.draft = true;
      s.lastInput = Date.now();
    }
    this.emitChanged();
  }

  /** `finishedAt` (finishedAtAfter): when its turn ended, for a hook's change; left out, an idle pane keeps its own. */
  private setStatus(id: string, status: SessionStatus, reason?: string, finishedAt?: number | null): void {
    const s = this.live.get(id);
    if (!s || s.info.status === "dead") return; // its pty has exited; only a relaunch (a new pty) revives it
    const finished = status !== "idle" ? null : finishedAt !== undefined ? finishedAt : (s.info.finishedAt ?? null);
    if (s.info.status === status && (status !== "waiting" || !reason)) {
      // the same status, its turn's end marked or cleared (a Stop, a /clear while idle): no status change to announce
      if ((s.info.finishedAt ?? null) === finished) return;
      s.info.finishedAt = finished;
      this.store.upsertSession(s.info);
      this.emitChanged();
      return;
    }
    const before = s.info.status;
    s.info.status = status;
    s.info.finishedAt = finished;
    // nothing delivers to an exited agent until a relaunch, which a message with a receipt doesn't wait for
    if (status === "dead") s.queued = this.withoutReceipts(s.queued, `${paneName(s.info)} stopped running before this reached it`);
    if (status !== "working") s.info.stalledSince = null;
    if (status === "waiting") {
      s.info.waitingReason = reason ?? s.info.waitingReason ?? null;
      s.info.waitingSince = s.info.waitingSince ?? Date.now();
      // each prompt's own event (a Notification, a PermissionRequest) says a new prompt is up, worded alike or not
      if (reason) s.info.waitingAt = Date.now();
      else s.info.waitingAt ??= s.info.waitingSince;
    } else {
      s.info.waitingReason = null;
      s.info.waitingSince = null;
      s.info.waitingAt = null;
    }
    this.store.upsertSession(s.info);
    this.emitChanged();
    this.tell("status", this.statusListeners, s.info, before);
  }
}
