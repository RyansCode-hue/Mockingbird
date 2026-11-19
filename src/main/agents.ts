import * as fs from "fs";
import * as path from "path";
import { AGENT_NAME, type AgentKind, type NewSessionRequest, type RelaunchChange, type SessionRole, type Settings } from "../shared/types";
import { isPermissionMode, PERMISSION_MODE_LABEL, WIDER_MODES, type PermissionMode } from "../shared/permissionModes";
import { expandHome } from "./store";
import { HELPDESK_MODE_WHY } from "./helpdesk";
import { usageReporterSettings } from "./usage";
import { MCP_SERVER, MCP_TOOL, claudeToolName, type McpLaunch } from "./messaging";
import { CLAUDE_PROJECTS, ROLLOUT_NAME_RE, codexRollouts } from "./agentFiles";
import { readSlice } from "./fileOps";
import { HOUSE_WRITE_TOOLS } from "../shared/team/house";
import { MIGRATION_TOOL } from "../shared/team/migrations";
import { TICKET_TOOL } from "./ticketToolSchemas";
import { WIRE_TOOL } from "./wireToolSchemas";

export interface LaunchContext {
  /** The per-session Mockingbird MCP server that lets agents message each other; absent for an agent outside messaging. */
  mcp?: McpLaunch;
  /** Claude permission rules denying file reads (a team room session's secrets), as --disallowedTools. */
  denyReads?: string[];
  /** Codex -c settings that run it in a team room's sandbox (codexRoomSandbox.ts), the user's MCP servers off. */
  codexPermissions?: string[];
  /**
   * Claude settings that run it in a team room's sandbox (claudeRoomSandbox.ts), as --settings beside the status
   * line's. With them it reads no settings but the user's and these, and runs no MCP server but Mockingbird's.
   */
  claudeSettings?: Record<string, unknown>;
  /** Environment on the agent's own command (a room's caches): sessions.ts puts it before the binary. */
  env?: Record<string, string>;
  /**
   * Instructions the agent starts with on top of its own (a team room's House
   * board and artifact tools, and Codex's room sandbox): Claude's --append-system-prompt,
   * Codex's developer_instructions.
   */
  instructions?: string;
  /**
   * More Mockingbird MCP tools the agent may call without asking (Claude;
   * Codex approves all of the server's but CODEX_ASKS_TOOLS, codexMcpSettings).
   */
  allowTools?: string[];
  /**
   * Run inline, on the terminal's normal screen, never full screen (a team
   * room's session, so teammates' copies hold its history). Claude takes it
   * from its environment instead (CLAUDE_INLINE_ENV).
   */
  inline?: boolean;
  /** Claude in Chrome (`--chrome`): the Helpdesk tasks workspace works in the user's own Chrome. Claude only. */
  chrome?: boolean;
}

/** Whether Claude Code's `--help` lists `--chrome` (Claude in Chrome); `--no-chrome` alone doesn't count. */
export const listsChromeFlag = (help: string): boolean => /(^|\s)--chrome(\s|$)/m.test(help);

/**
 * Claude Code's switch to its classic main-screen renderer: it outranks a
 * `tui: "fullscreen"` setting and CLAUDE_CODE_NO_FLICKER. In a pty's
 * environment it also reaches a claude started by hand in a terminal.
 */
export const CLAUDE_INLINE_ENV = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1" } as const;

/**
 * Claude Code's switch for its agent view: `claude agents`, `--bg`,
 * `/background`, ← at an empty prompt, and the daemon that runs background
 * sessions. A conversation moved to the background leaves its pane for a
 * worker of that daemon, outside Mockingbird: quitting ends only the pane,
 * the worker keeps the conversation (and the Mockingbird tools and room
 * settings it started with), and resuming the pane then collides with it.
 * Every Claude Mockingbird starts runs with it off.
 */
export const CLAUDE_NO_BACKGROUND_ENV = { CLAUDE_CODE_DISABLE_AGENT_VIEW: "1" } as const;

/**
 * Codex's switch to inline mode (what --no-alt-screen sets); it outranks
 * `tui.fullscreen_transcript`. A setting rather than the flag: a Codex that
 * predates it ignores an unknown setting, but refuses to start on an unknown flag.
 */
export const CODEX_INLINE_SETTING = 'tui.alternate_screen="never"';

/** Claude Code's `--permission-mode` for each mode but the default, which passes nothing. */
const CLAUDE_MODE: Record<Exclude<PermissionMode, "default">, string> = { plan: "plan", acceptEdits: "acceptEdits", auto: "auto", bypass: "bypassPermissions" };

/**
 * Codex's flags for each mode but the default, as codex-cli 0.156.1 lists them for both `codex` and `codex resume`.
 * Every one of them picks Codex's sandbox: `-s` names it, `--approve-for-me` runs workspace-write with approvals sent
 * to its automatic review (Codex's counterpart of Claude's auto), and the bypass drops it. It has no `--full-auto` any
 * more, and an unknown flag stops it starting.
 */
const CODEX_MODE: Record<Exclude<PermissionMode, "default">, string[]> = {
  plan: ["-s", "read-only"],
  acceptEdits: ["-s", "workspace-write", "-a", "on-request"],
  auto: ["--approve-for-me"],
  bypass: ["--dangerously-bypass-approvals-and-sandbox"],
};

/** An agent's command-line flags for permission mode `mode`; none for the default. */
export function modeArgs(agent: AgentKind, mode: PermissionMode | null | undefined): string[] {
  if (!mode || mode === "default") return [];
  if (!isPermissionMode(mode)) throw new Error(`“${String(mode)}” isn't a permission mode`);
  return agent === "codex" ? [...CODEX_MODE[mode]] : ["--permission-mode", CLAUDE_MODE[mode]];
}

/**
 * Why `agent` can't launch in permission mode `mode`, or null when it can. The Helpdesk tasks workspace (role `tasks`)
 * takes nothing wider than the default. A launch in its team room's sandbox (`roomSandboxed`) takes only a mode that
 * tightens it: bypass would leave it, Claude's accept edits and auto approve what the room has it ask about (its House
 * writes among them), and every Codex mode picks Codex's own sandbox, which would replace the room's permission profile.
 */
export function permissionModeRefusal(agent: AgentKind, mode: PermissionMode | null | undefined, where: { role?: SessionRole | null; roomSandboxed: boolean }): string | null {
  if (!mode || mode === "default") return null;
  if (!isPermissionMode(mode)) return `“${String(mode)}” isn't a permission mode`;
  if (where.role === "tasks" && WIDER_MODES.has(mode)) return HELPDESK_MODE_WHY;
  if (!where.roomSandboxed) return null;
  const label = PERMISSION_MODE_LABEL[mode];
  if (agent === "codex") return `Codex's ${label} picks its own sandbox (${CODEX_MODE[mode].join(" ")}), which would replace the team room's: a Codex session in the room's sandbox runs Ask as usual`;
  if (WIDER_MODES.has(mode)) return `${label} would loosen the team room's sandbox, where a mode may only tighten it: Ask as usual or Plan mode`;
  return null;
}

/** What a confirm card says of a mode wider than the default (WIDER_MODES): what its agent then does without asking. */
export function widerModeWarning(mode: PermissionMode, agent: AgentKind): string {
  if (mode === "acceptEdits") return "Accept edits: it changes files without asking you first";
  if (mode === "auto") return agent === "codex" ? "Auto: Codex's automatic review answers its approval requests, not you" : "Auto: it decides for itself which actions to take without asking you";
  return agent === "codex" ? "Bypass permissions: Codex runs every command without asking, and outside its sandbox" : "Bypass permissions: it runs every tool without asking you first";
}

/** Claude Code's effort levels (its `--effort`), what a relaunch with changes takes. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** The levels of CLAUDE_EFFORTS Codex has as its `model_reasoning_effort`, by the same names. */
export const CODEX_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh"];
/**
 * What a model id or alias is made of: Claude's "opus" or "claude-opus-4-7[1m]", Codex's "gpt-5.1-codex". It starts
 * with a letter, digit or _, so it can't be read as a flag of its own.
 */
const MODEL_ID = /^\w[\w.\-[\]]{0,79}$/;

/** `raw` as a RelaunchChange for an `agent` session, or throws saying what's wrong with it. Nothing else on it is kept. */
export function readRelaunchChange(raw: unknown, agent: AgentKind): RelaunchChange {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("A relaunch's changes are a permission mode, a model and an effort");
  const r = raw as Record<string, unknown>;
  const out: RelaunchChange = {};
  if (r.permissionMode !== undefined) {
    if (!isPermissionMode(r.permissionMode)) throw new Error(`“${String(r.permissionMode).slice(0, 40)}” isn't a permission mode: ${Object.values(PERMISSION_MODE_LABEL).join(", ")}`);
    out.permissionMode = r.permissionMode;
  }
  if (r.model !== undefined) {
    if (r.model !== null && (typeof r.model !== "string" || !MODEL_ID.test(r.model))) throw new Error("A model is a name of at most 80 letters, digits and . _ - [ ]");
    out.model = r.model;
  }
  if (r.effort !== undefined) {
    if (r.effort !== null && (typeof r.effort !== "string" || !(CLAUDE_EFFORTS as readonly string[]).includes(r.effort))) throw new Error(`An effort is one of ${CLAUDE_EFFORTS.join(", ")}`);
    if (agent === "codex" && typeof r.effort === "string" && !CODEX_EFFORTS.includes(r.effort)) throw new Error(`Codex has no ${r.effort} reasoning effort: ${CODEX_EFFORTS.join(", ")}`);
    out.effort = r.effort;
  }
  return out;
}

/** A launch's mode flags, refused (permissionModeRefusal) where they'd widen the Helpdesk or leave a room's sandbox. */
function launchMode(agent: AgentKind, req: NewSessionRequest, roomSandboxed: boolean): string[] {
  const why = permissionModeRefusal(agent, req.permissionMode, { role: req.role, roomSandboxed });
  if (why) throw new Error(why);
  return modeArgs(agent, req.permissionMode);
}

/**
 * Settings every Claude pane runs with, over the user's and a room's. Claude Code's own messaging between the sessions
 * on this Mac can't be limited by sender, so a pane takes none of it: agents reach each other with Mockingbird's
 * send_message, which keeps to their group. From --settings, this outranks the user's own crossSessionInbound.
 */
export const CLAUDE_PANE_SETTINGS = { crossSessionInbound: "refuse" } as const;

/**
 * Claude Code tools a pane goes without. ListAgents lists every Claude session on this Mac, and every other pane in it
 * refuses what it would send them, unseen by the sender; list_sessions shows the ones it can reach. SendMessage stays,
 * for the pane's own subagents and teammates.
 */
export const CLAUDE_PANE_DENIED = ["ListAgents"] as const;

/** Everything that differs between the coding-agent CLIs a session can run. */
export interface AgentAdapter {
  /** The Settings field holding this agent's binary name or path. */
  binSetting: keyof Pick<Settings, "claudeBin" | "codexBin">;
  launchArgs(req: NewSessionRequest, ctx: LaunchContext): string[];
  /** Environment the pty running this agent gets on top of the pane's. */
  launchEnv: Readonly<Record<string, string>>;
  /**
   * Whether a resume would find a conversation in this cwd. Both CLIs exit (or
   * open a picker) when asked to resume nothing, so such a session starts fresh.
   */
  hasConversation(cwd: string): boolean;
  /** True when the kickoff prompt travels in launchArgs instead of being typed in after boot. */
  promptInArgs: boolean;
  /** Whether this agent still has the conversation with this id on disk (so `--resume <id>` will find it). */
  conversationExists(id: string): boolean;
}

const claude: AgentAdapter = {
  binSetting: "claudeBin",
  launchEnv: CLAUDE_NO_BACKGROUND_ENV,
  promptInArgs: false,
  launchArgs(req, ctx) {
    const args: string[] = [];
    if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
    else if (req.resume) args.push("--continue");
    if (req.model) args.push("--model", req.model);
    if (req.effort) args.push("--effort", req.effort);
    args.push(...launchMode("claude", req, !!ctx.claudeSettings));
    for (const d of req.extraDirs ?? []) args.push("--add-dir", expandHome(d));
    // one --settings, carrying the status line and a room's sandbox. Hooks from every settings file run, and outside
    // the sandbox, as do the MCP servers a project's .mcp.json starts: a room launch reads only the user's settings
    // (Mockingbird's own hooks are there) and runs only Mockingbird's server
    args.push("--settings", JSON.stringify({ ...usageReporterSettings(), ...ctx.claudeSettings, ...CLAUDE_PANE_SETTINGS }));
    if (ctx.claudeSettings) args.push("--setting-sources", "user", "--strict-mcp-config");
    // --mcp-config adds to the user's own servers (outside a room); the allow
    // rule spares a permission prompt on every message
    if (ctx.mcp) {
      const tools = [...new Set<string>([MCP_TOOL.listSessions, MCP_TOOL.sendMessage, MCP_TOOL.listLinks, ...Object.values(WIRE_TOOL), ...Object.values(TICKET_TOOL), ...(ctx.allowTools ?? [])])];
      args.push("--mcp-config", claudeMcpConfig(ctx.mcp), "--allowedTools", tools.map(claudeToolName).join(","));
    }
    args.push("--disallowedTools", ...(ctx.denyReads ?? []), ...CLAUDE_PANE_DENIED);
    if (ctx.chrome) args.push("--chrome");
    if (ctx.instructions) args.push("--append-system-prompt", ctx.instructions);
    return args;
  },
  conversationExists(id) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(CLAUDE_PROJECTS);
    } catch {
      return false; // no Claude history on this machine
    }
    return dirs.some((d) => fs.existsSync(path.join(CLAUDE_PROJECTS, d, `${id}.jsonl`)));
  },
  // Claude keeps transcripts under ~/.claude/projects/<cwd with separators dashed>/
  hasConversation(cwd) {
    const candidates = [cwd.replace(/\//g, "-"), cwd.replace(/[^A-Za-z0-9]/g, "-")];
    return candidates.some((enc) => {
      try {
        return fs.readdirSync(path.join(CLAUDE_PROJECTS, enc)).some((f) => f.endsWith(".jsonl"));
      } catch {
        return false; // no directory → no conversation
      }
    });
  },
};

/**
 * The cwd of an interactive Codex rollout, or null. The first line is a
 * session_meta event; only `source: "cli"` (the TUI Mockingbird runs) counts —
 * `codex resume --last` skips `exec` runs, and desktop-app threads aren't
 * CLI conversations.
 */
function rolloutCwd(file: string): string | null {
  try {
    // the meta line runs to tens of KB (it embeds the system prompt), so the
    // field is matched in the head rather than parsing the whole line
    const head = readSlice(file, "start", 2048);
    if (!/"source":"cli"/.test(head)) return null;
    const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(head);
    return m ? (JSON.parse(m[1]) as string) : null;
  } catch {
    return null; // unreadable rollout — it cannot be resumed either
  }
}

const ROLLOUT_SCAN_LIMIT = 2000; // newest files read per index; older conversations start fresh
const INDEX_TTL_MS = 30_000;
let cwdIndex: { cwds: Set<string>; at: number } | null = null;

/** Folders that have an interactive Codex conversation to resume. */
function codexCwds(): Set<string> {
  if (cwdIndex && Date.now() - cwdIndex.at < INDEX_TTL_MS) return cwdIndex.cwds;
  const cwds = new Set<string>();
  try {
    for (const file of codexRollouts(ROLLOUT_SCAN_LIMIT)) {
      const cwd = rolloutCwd(file);
      if (cwd) cwds.add(cwd);
    }
  } catch (err) {
    console.warn(`[agents] can't tell which folders have a Codex conversation to resume, so they start fresh: ${(err as Error).message}`);
  }
  cwdIndex = { cwds, at: Date.now() };
  return cwds;
}

const codex: AgentAdapter = {
  binSetting: "codexBin",
  launchEnv: {},
  promptInArgs: true,
  launchArgs(req, ctx) {
    const args: string[] = [];
    if (req.resumeSessionId) args.push("resume", req.resumeSessionId);
    else if (req.resume) args.push("resume", "--last"); // scoped to the cwd by codex itself
    if (req.model) args.push("--model", req.model);
    // -c values are parsed as TOML, so the string needs its quotes
    if (req.effort) args.push("-c", `model_reasoning_effort="${req.effort}"`);
    args.push(...launchMode("codex", req, !!ctx.codexPermissions?.length));
    for (const d of req.extraDirs ?? []) args.push("--add-dir", expandHome(d));
    // before Mockingbird's server's settings: the room's switch off the user's servers with one table (codexMcpOff),
    // which would replace the dotted keys given before it
    for (const c of ctx.codexPermissions ?? []) args.push("-c", c);
    if (ctx.mcp) args.push(...codexMcpSettings(ctx.mcp).flatMap((c) => ["-c", c]));
    if (ctx.inline) args.push("-c", CODEX_INLINE_SETTING);
    // a JSON string is a valid TOML basic string
    if (ctx.instructions) args.push("-c", `developer_instructions=${JSON.stringify(ctx.instructions)}`);
    // positional, last, after "--": a prompt starting with "-" is not an option
    if (req.initialPrompt) args.push("--", req.initialPrompt);
    return args;
  },
  // Codex files rollouts by date (~/.codex/sessions/YYYY/MM/DD/), not by folder,
  // so finding one for a cwd means reading headers, newest first. Bounded, and
  // one index read serves a whole restore-all burst.
  hasConversation(cwd) {
    return codexCwds().has(cwd);
  },
  // the conversation id ends the rollout's file name; bounded like the cwd index
  conversationExists(id) {
    try {
      for (const file of codexRollouts(ROLLOUT_SCAN_LIMIT)) if (ROLLOUT_NAME_RE.exec(path.basename(file))?.[1] === id) return true;
    } catch (err) {
      console.warn(`[agents] can't look for Codex conversation ${id}, so the session starts fresh: ${(err as Error).message}`);
    }
    return false;
  },
};

const ADAPTERS: Record<AgentKind, AgentAdapter> = { claude, codex };

/** Claude's --mcp-config value for the Mockingbird MCP server. */
export function claudeMcpConfig(mcp: McpLaunch): string {
  return JSON.stringify({ mcpServers: { [MCP_SERVER]: { type: "stdio", ...mcp } } });
}

/**
 * The Mockingbird MCP tools Codex asks the user about before every call: the
 * House's writes (made with the user's token) and reserving a migration
 * number (a room event every teammate's agents are held to).
 */
export const CODEX_ASKS_TOOLS: string[] = [...HOUSE_WRITE_TOOLS, MIGRATION_TOOL.reserve];

/**
 * Codex's -c settings for the Mockingbird MCP server: its tools pre-approved
 * but for CODEX_ASKS_TOOLS, which ask before every call ("prompt" offers no
 * approve-for-the-session; with approval_policy "never" Codex refuses the
 * call instead). -c values are TOML; JSON strings, arrays and this flat
 * table are valid TOML too. `toolTimeoutSec` raises Codex's limit for a tool
 * that can take minutes.
 */
export function codexMcpSettings(mcp: McpLaunch, opts: { toolTimeoutSec?: number } = {}): string[] {
  const key = `mcp_servers.${MCP_SERVER}`;
  const env = Object.entries(mcp.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
  return [
    `${key}.command=${JSON.stringify(mcp.command)}`,
    `${key}.args=${JSON.stringify(mcp.args)}`,
    `${key}.env={${env}}`,
    `${key}.default_tools_approval_mode="approve"`,
    ...(opts.toolTimeoutSec ? [`${key}.tool_timeout_sec=${opts.toolTimeoutSec}`] : []),
    ...CODEX_ASKS_TOOLS.map((tool) => `${key}.tools.${tool}.approval_mode="prompt"`),
  ];
}

/**
 * Codex's -c setting that switches off each MCP server in `names` (the user's: CodexMcpNames) but Mockingbird's own.
 * One inline table, so a name with dots stays one key; it merges with the config's servers, keeping their other
 * settings. Within the command line a table given whole replaces the dotted keys given before it, so this comes
 * before codexMcpSettings.
 */
export function codexMcpOff(names: readonly string[]): string[] {
  const off = names.filter((n) => n !== MCP_SERVER);
  return off.length ? [`mcp_servers={${off.map((n) => `${JSON.stringify(n)}={enabled=false}`).join(", ")}}`] : [];
}

/** Sessions persisted before agents existed carry no agent field — they were all Claude. */
export function agentFor(kind: AgentKind | null | undefined): AgentAdapter {
  return ADAPTERS[kind ?? "claude"];
}

/** An agent's name as people see it: "Claude", "Codex" (sessions saved before agents existed are Claude's). */
export const agentLabel = (kind: AgentKind | null | undefined): string => AGENT_NAME[kind ?? "claude"];

/**
 * Whether a binary from SessionManager.binFor is an installed CLI: once the
 * user's shell has found it, it is a path; a bare name means it wasn't found.
 */
export const isInstalledBin = (bin: string): boolean => bin.includes("/");

/** An agent CLI's version, e.g. "2.1.5" from "2.1.5 (Claude Code)" or "codex-cli 0.46.0". */
export function cliVersion(out: string): string | null {
  return /(\d+\.\d+\.\d+[\w.+-]*)/.exec(out)?.[1] ?? null;
}
