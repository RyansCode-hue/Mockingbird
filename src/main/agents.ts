import * as fs from "fs";
import * as path from "path";
import { AGENT_NAME, type AgentKind, type NewSessionRequest, type Settings } from "../shared/types";
import { expandHome } from "./store";
import { usageReporterArgs } from "./usage";
import { MCP_SERVER, MCP_TOOL, claudeToolName, type McpLaunch } from "./messaging";
import { CLAUDE_PROJECTS, ROLLOUT_NAME_RE, codexRollouts } from "./agentFiles";
import { readSlice } from "./fileOps";

export interface LaunchContext {
  /** The per-session Mockingbird MCP server that lets agents message each other; absent for an agent outside messaging. */
  mcp?: McpLaunch;
  /**
   * Permission rules denying file reads (a team room session's secrets).
   * Claude takes them as --disallowedTools. Codex ignores them: its
   * deny-read rules live in a permission profile in ~/.codex/config.toml,
   * which replaces its sandbox settings, so they aren't set from here.
   */
  denyReads?: string[];
}

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
      args.push("--mcp-config", claudeMcpConfig(ctx.mcp), "--allowedTools", [MCP_TOOL.listSessions, MCP_TOOL.sendMessage].map(claudeToolName).join(","));
    }
    if (ctx.denyReads?.length) args.push("--disallowedTools", ...ctx.denyReads);
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
 * Codex's -c settings for the Mockingbird MCP server, its tools pre-approved.
 * -c values are TOML; JSON strings, arrays and this flat table are valid TOML
 * too. `toolTimeoutSec` raises Codex's limit for a tool that can take minutes.
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
