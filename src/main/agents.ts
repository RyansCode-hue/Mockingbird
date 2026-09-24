import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AgentKind, NewSessionRequest, Settings } from "../shared/types";
import { expandHome } from "./store";
import { usageReporterArgs } from "./usage";
import type { McpLaunch } from "./messaging";

export interface LaunchContext {
  /** The per-session Mockingbird MCP server that lets agents message each other. */
  mcp: McpLaunch;
}

/** Everything that differs between the coding-agent CLIs a session can run. */
export interface AgentAdapter {
  label: string;
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
}

const claude: AgentAdapter = {
  label: "Claude",
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
    args.push(
      "--mcp-config",
      JSON.stringify({ mcpServers: { mockingbird: { type: "stdio", ...ctx.mcp } } }),
      "--allowedTools",
      "mcp__mockingbird__list_sessions,mcp__mockingbird__send_message"
    );
    return args;
  },
  // Claude keeps transcripts under ~/.claude/projects/<cwd with separators dashed>/
  hasConversation(cwd) {
    const projects = path.join(os.homedir(), ".claude", "projects");
    const candidates = [cwd.replace(/\//g, "-"), cwd.replace(/[^A-Za-z0-9]/g, "-")];
    return candidates.some((enc) => {
      try {
        return fs.readdirSync(path.join(projects, enc)).some((f) => f.endsWith(".jsonl"));
      } catch {
        return false; // no directory → no conversation
      }
    });
  },
};

/** The cwd a Codex rollout was recorded in — the first line is a session_meta event. */
function rolloutCwd(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    // the meta line runs to tens of KB (it embeds the system prompt), so the
    // field is matched in the head rather than parsing the whole line
    const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(buf.toString("utf8", 0, n));
    return m ? (JSON.parse(m[1]) as string) : null;
  } catch {
    return null; // unreadable rollout — it cannot be resumed either
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

const codex: AgentAdapter = {
  label: "Codex",
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
    // -c values are TOML; JSON strings, arrays and this flat table are valid TOML too
    const env = Object.entries(ctx.mcp.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
    args.push(
      "-c", `mcp_servers.mockingbird.command=${JSON.stringify(ctx.mcp.command)}`,
      "-c", `mcp_servers.mockingbird.args=${JSON.stringify(ctx.mcp.args)}`,
      "-c", `mcp_servers.mockingbird.env={${env}}`,
      "-c", `mcp_servers.mockingbird.default_tools_approval_mode="approve"`
    );
    if (req.initialPrompt) args.push(req.initialPrompt); // positional — must stay last
    return args;
  },
  // Codex files rollouts by date (~/.codex/sessions/YYYY/MM/DD/), not by folder,
  // so finding one for a cwd means reading headers — newest day first.
  hasConversation(cwd) {
    const root = path.join(os.homedir(), ".codex", "sessions");
    const ls = (dir: string): string[] => {
      try {
        return fs.readdirSync(dir).sort().reverse();
      } catch {
        return [];
      }
    };
    for (const y of ls(root))
      for (const m of ls(path.join(root, y)))
        for (const d of ls(path.join(root, y, m)))
          for (const f of ls(path.join(root, y, m, d)))
            if (f.endsWith(".jsonl") && rolloutCwd(path.join(root, y, m, d, f)) === cwd) return true;
    return false;
  },
};

const ADAPTERS: Record<AgentKind, AgentAdapter> = { claude, codex };

/** Sessions persisted before agents existed carry no agent field — they were all Claude. */
export function agentFor(kind: AgentKind | null | undefined): AgentAdapter {
  return ADAPTERS[kind ?? "claude"];
}
