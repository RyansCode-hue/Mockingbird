import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { quote, type ShellResult } from "./shell";
import type { AgentKind } from "../shared/types";
import { agentLabel, claudeMcpConfig, isInstalledBin } from "./agents";
import type { McpLaunch } from "./messaging";

const TIMEOUT_MS = 120_000;

/** Mockingbird's MCP server for one Claude run, and the only tools of it the run may call, as Claude names them. */
export interface AskMcp {
  launch: McpLaunch;
  allowedTools: string[];
}

/**
 * One headless turn with no built-in tools and nothing saved: what the model needs is in the prompt, so it only
 * writes. Its only MCP server is `o.mcp`'s when given, with only `o.mcp.allowedTools` allowed; without it, none.
 * `o.system` is added to Claude's own system prompt. Claude runs a fast model unless told otherwise; Codex runs the
 * user's default model at low effort, read-only.
 */
export function claudeAskCommand(bin: string, model = "haiku", o: { mcp?: AskMcp; system?: string } = {}): string {
  if (o.mcp && !o.mcp.allowedTools.length) throw new Error("A headless run's MCP server needs the tools it may call");
  return [
    quote(bin),
    "-p",
    "--model", quote(model),
    "--output-format", "json",
    "--tools", quote(""),
    "--strict-mcp-config",
    ...(o.mcp ? ["--mcp-config", quote(claudeMcpConfig(o.mcp.launch)), "--allowedTools", quote(o.mcp.allowedTools.join(","))] : []),
    ...(o.system ? ["--append-system-prompt", quote(o.system)] : []),
    "--no-session-persistence",
  ].join(" ");
}

function codexAskCommand(bin: string, lastFile: string): string {
  return [
    quote(bin),
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s read-only",
    "--disable apps --disable plugins",
    `-c ${quote("mcp_servers={}")}`,
    `-c ${quote('approval_policy="never"')}`,
    `-c ${quote('model_reasoning_effort="low"')}`,
    `-o ${quote(lastFile)}`,
    "-",
  ].join(" ");
}

export type ShellRunner = (cmd: string, input: string, opts: { cwd: string; env: Record<string, string>; timeoutMs: number; onSpawn?: (pid: number) => void }) => Promise<ShellResult>;

export interface AskOptions {
  agent: AgentKind;
  bin: string;
  run: ShellRunner;
  env: Record<string, string>;
  /** Names the run in MOCKINGBIRD_SESSION ("commit-message", "pr-description"…), so its hook events are never mistaken for a pane's. */
  tag: string;
  /** Claude's model; defaults to the fast one. */
  model?: string;
  timeoutMs?: number;
  /** Claude only: Mockingbird's MCP server for this run, and which of its tools it may call (claudeAskCommand). */
  mcp?: AskMcp;
  /** Claude only: added to its system prompt. */
  system?: string;
  /** The run's shell, as soon as it's spawned: what an MCP launch's token is bound to (bindMcpLaunch). */
  onSpawn?: (pid: number) => void;
}

/**
 * What a `claude -p --output-format json` run replied: its text, and the
 * conversation it ran in. A failed run throws the CLI's own error.
 */
export function parseClaudeJson(r: ShellResult, maxError = 300): { text: string; sessionId: string | null } {
  let out: any;
  try {
    out = JSON.parse(r.out);
  } catch {
    throw new Error(r.out.trim().slice(0, maxError) || `claude exited with code ${r.code}`);
  }
  if (r.code !== 0 || out.is_error) throw new Error(String(out.result ?? `claude exited with code ${r.code}`).slice(0, maxError));
  return { text: String(out.result ?? ""), sessionId: typeof out.session_id === "string" ? out.session_id : null };
}

/** The error a failed `codex exec` run reports: its last line that names one, else its output. */
export function codexError(r: ShellResult, maxError = 300): Error {
  return new Error((r.out.split("\n").filter((l) => /error/i.test(l)).pop() ?? r.out).trim().slice(0, maxError) || `codex exited with code ${r.code}`);
}

/** A `codex exec -o <lastFile>` run's reply, read from that file. A failed run, or one that wrote nothing, throws its error. */
export async function readCodexReply(lastFile: string, r: ShellResult, maxError = 300): Promise<string> {
  let text = "";
  try {
    text = await fs.promises.readFile(lastFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (r.code !== 0 || !text.trim()) throw codexError(r, maxError);
  return text;
}

/**
 * Ask an agent's CLI one question and get its reply text. It runs in a scratch
 * folder, so no project instructions or settings load.
 */
export async function askAgent(prompt: string, o: AskOptions): Promise<string> {
  if (!isInstalledBin(o.bin)) throw new Error(`${agentLabel(o.agent)} isn't installed`);
  if (o.agent !== "claude" && (o.mcp || o.system)) throw new Error("Only a Claude run takes an MCP server or a system prompt");
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), `mb-${o.tag}-`));
  const opts = { cwd: tmp, env: { ...o.env, MOCKINGBIRD_SESSION: `${o.tag}-${path.basename(tmp)}` }, timeoutMs: o.timeoutMs ?? TIMEOUT_MS, ...(o.onSpawn ? { onSpawn: o.onSpawn } : {}) };
  try {
    if (o.agent === "claude") return parseClaudeJson(await o.run(claudeAskCommand(o.bin, o.model, { mcp: o.mcp, system: o.system }), prompt, opts)).text;
    const last = path.join(tmp, "reply.txt");
    return await readCodexReply(last, await o.run(codexAskCommand(o.bin, last), prompt, opts));
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

/** The reply alone: models sometimes wrap it in a fence or quotes, or label it. */
export function cleanReply(raw: string, labels: RegExp = /^(commit message|message)\s*:\s*/i): string {
  let s = raw.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(s);
  if (fence) s = fence[1].trim();
  s = s.replace(labels, "");
  if (/^["'`].*["'`]$/s.test(s) && !s.slice(1, -1).includes(s[0])) s = s.slice(1, -1).trim();
  return s;
}
