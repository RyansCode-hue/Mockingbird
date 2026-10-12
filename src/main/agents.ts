import * as fs from "fs";
import * as path from "path";
import { AGENT_NAME, type AgentKind, type NewSessionRequest, type Settings } from "../shared/types";
import { expandHome } from "./store";
import { usageReporterArgs } from "./usage";
import { MCP_SERVER, MCP_TOOL, claudeToolName, type McpLaunch } from "./messaging";
import { CLAUDE_PROJECTS, ROLLOUT_NAME_RE, codexRollouts } from "./agentFiles";
import { readSlice } from "./fileOps";
import { HOUSE_WRITE_TOOLS } from "../shared/team/house";

export interface LaunchContext {
  /** The per-session Mockingbird MCP server that lets agents message each other; absent for an agent outside messaging. */
  mcp?: McpLaunch;
  /** Claude permission rules denying file reads (a team room session's secrets), as --disallowedTools. */
  denyReads?: string[];
  /** Codex -c settings that run it in a team room's sandbox (codexRoomSandbox.ts). */
  codexPermissions?: string[];
  /**
   * Instructions the agent starts with on top of its own (a team room's House
   * board and artifact tools, and Codex's room sandbox): Claude's --append-system-prompt,
   * Codex's developer_instructions.
   */
  instructions?: string;
  /**
   * More Mockingbird MCP tools the agent may call without asking (Claude;
   * Codex approves all of the server's but the House's writes, codexMcpSettings).
   */
  allowTools?: string[];
  /**
   * Run inline, on the terminal's normal screen, never full screen (a team
   * room's session, so teammates' copies hold its history). Claude takes it
   * from its environment instead (CLAUDE_INLINE_ENV).
   */
  inline?: boolean;
}

/**
 * Claude Code's switch to its classic main-screen renderer: it outranks a
 * `tui: "fullscreen"` setting and CLAUDE_CODE_NO_FLICKER. In a pty's
 * environment it also reaches a claude started by hand in a terminal.
 */
export const CLAUDE_INLINE_ENV = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1" } as const;

/**
 * Codex's switch to inline mode (what --no-alt-screen sets); it outranks
 * `tui.fullscreen_transcript`. A setting rather than the flag: a Codex that
 * predates it ignores an unknown setting, but refuses to start on an unknown flag.
 */
export const CODEX_INLINE_SETTING = 'tui.alternate_screen="never"';

/** Everything that differs between the coding-agent CLIs a session can run. */
export interface AgentAdapter {
  /** The Settings field holding this agent's binary name or path. */
  binSetting: keyof Pick<Settings, "claudeBin" | "codexBin">;
  launchArgs(req: NewSessionRequest, ctx: LaunchContext): string[];
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
  promptInArgs: false,
  launchArgs(req, ctx) {
    const args: string[] = [];
    if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
    else if (req.resume) args.push("--continue");
    if (req.model) args.push("--model", req.model);
    if (req.effort) args.push("--effort", req.effort);
    for (const d of req.extraDirs ?? []) args.push("--add-dir", expandHome(d));
    args.push(...usageReporterArgs());
    // --mcp-config adds to the user's own servers; the allow rule spares a
    // permission prompt on every message
    if (ctx.mcp) {
      const tools = [...new Set<string>([MCP_TOOL.listSessions, MCP_TOOL.sendMessage, ...(ctx.allowTools ?? [])])];
      args.push("--mcp-config", claudeMcpConfig(ctx.mcp), "--allowedTools", tools.map(claudeToolName).join(","));
    }
    if (ctx.denyReads?.length) args.push("--disallowedTools", ...ctx.denyReads);
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
  promptInArgs: true,
  launchArgs(req, ctx) {
    const args: string[] = [];
    if (req.resumeSessionId) args.push("resume", req.resumeSessionId);
    else if (req.resume) args.push("resume", "--last"); // scoped to the cwd by codex itself
    if (req.model) args.push("--model", req.model);
    // -c values are parsed as TOML, so the string needs its quotes
    if (req.effort) args.push("-c", `model_reasoning_effort="${req.effort}"`);
    for (const d of req.extraDirs ?? []) args.push("--add-dir", expandHome(d));
    if (ctx.mcp) args.push(...codexMcpSettings(ctx.mcp).flatMap((c) => ["-c", c]));
    for (const c of ctx.codexPermissions ?? []) args.push("-c", c);
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
 * Codex's -c settings for the Mockingbird MCP server: its tools pre-approved
 * but for the House's writes, which ask before every call ("prompt" offers no
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
    ...HOUSE_WRITE_TOOLS.map((tool) => `${key}.tools.${tool}.approval_mode="prompt"`),
  ];
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
