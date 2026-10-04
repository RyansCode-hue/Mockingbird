import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { quote, type ShellResult } from "./shell";
import type { AgentKind } from "../shared/types";

const TIMEOUT_MS = 120_000;

/**
 * One headless turn with no tools, no MCP servers and nothing saved: what the
 * model needs is in the prompt, so it only writes. Claude runs a fast model;
 * Codex runs the user's default model at low effort, read-only.
 */
export function claudeAskCommand(bin: string, model = "haiku"): string {
  return [quote(bin), "-p", "--model", model, "--output-format", "json", "--tools", quote(""), "--strict-mcp-config", "--no-session-persistence"].join(" ");
}

export function codexAskCommand(bin: string, lastFile: string): string {
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

export type ShellRunner = (cmd: string, input: string, opts: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<ShellResult>;

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
}

/**
 * Ask an agent's CLI one question and get its reply text. It runs in a scratch
 * folder, so no project instructions or settings load.
 */
export async function askAgent(prompt: string, o: AskOptions): Promise<string> {
  if (!o.bin.includes("/")) throw new Error(`${o.agent === "codex" ? "Codex" : "Claude Code"} isn't installed`);
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), `mb-${o.tag}-`));
  const opts = { cwd: tmp, env: { ...o.env, MOCKINGBIRD_SESSION: `${o.tag}-${path.basename(tmp)}` }, timeoutMs: o.timeoutMs ?? TIMEOUT_MS };
  try {
    if (o.agent === "claude") {
      const r = await o.run(claudeAskCommand(o.bin, o.model), prompt, opts);
      let out: any;
      try {
        out = JSON.parse(r.out);
      } catch {
        throw new Error(r.out.trim().slice(0, 300) || `claude exited with code ${r.code}`);
      }
      if (r.code !== 0 || out.is_error) throw new Error(String(out.result ?? `claude exited with code ${r.code}`).slice(0, 300));
      return String(out.result ?? "");
    }
    const last = path.join(tmp, "reply.txt");
    const r = await o.run(codexAskCommand(o.bin, last), prompt, opts);
    const text = await fs.promises.readFile(last, "utf8").catch(() => "");
    if (r.code !== 0 || !text.trim()) throw new Error((r.out.split("\n").filter((l) => /error/i.test(l)).pop() ?? r.out).trim().slice(0, 300) || `codex exited with code ${r.code}`);
    return text;
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
