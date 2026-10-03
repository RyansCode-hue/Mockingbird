import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { git } from "./git";
import { quote, type ShellResult } from "./shell";
import type { AgentKind } from "../shared/types";

const MAX_DIFF_CHARS = 60_000;
const MAX_NEW_FILE_CHARS = 8_000;
const TIMEOUT_MS = 120_000;

export interface CommitContext {
  /** "staged" when something is staged; otherwise "all" — what Commit would stage and commit. */
  scope: "staged" | "all";
  stat: string;
  diff: string;
  newFiles: string[];
  recent: string[];
  truncated: boolean;
}

const noHead = (err: unknown) => /bad revision|unknown revision|ambiguous argument 'HEAD'|does not have any commits/i.test((err as Error).message);

/**
 * What a commit message has to describe: the staged change, or — when nothing
 * is staged — everything Commit would stage, new files included (their text,
 * while it fits). The repository's recent subjects come along to match its style.
 */
export async function commitContext(root: string): Promise<CommitContext> {
  const stagedStat = await git(root, ["diff", "--cached", "--stat"]);
  const scope = stagedStat ? "staged" : "all";
  let stat = stagedStat;
  let diff: string;
  let newFiles: string[] = [];
  if (scope === "staged") diff = await git(root, ["diff", "--cached"], { trim: false });
  else {
    try {
      [stat, diff] = await Promise.all([git(root, ["diff", "HEAD", "--stat"]), git(root, ["diff", "HEAD"], { trim: false })]);
    } catch (err) {
      if (!noHead(err)) throw err;
      [stat, diff] = ["", ""]; // before the first commit everything is a new file
    }
    newFiles = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], { trim: false })).split("\0").filter(Boolean);
  }
  if (!stat && !diff && !newFiles.length) throw new Error("There are no changes to describe");

  let budget = MAX_DIFF_CHARS;
  let truncated = diff.length > budget;
  diff = diff.slice(0, budget);
  budget -= diff.length;
  for (const f of newFiles) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    let text: string;
    try {
      const buf = await fs.promises.readFile(path.join(root, f));
      if (buf.subarray(0, 8000).includes(0)) continue; // binary: its name is enough
      text = buf.toString("utf8").slice(0, Math.min(MAX_NEW_FILE_CHARS, budget));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EISDIR" || (err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    diff += `\n--- new file: ${f}\n${text}\n`;
    budget -= text.length;
  }

  let recent: string[] = [];
  try {
    recent = (await git(root, ["log", "-12", "--format=%s"])).split("\n").filter(Boolean);
  } catch (err) {
    if (!noHead(err)) throw err; // no commits yet: no style to match
  }
  return { scope, stat, diff, newFiles, recent, truncated };
}

export function commitPrompt(c: CommitContext): string {
  return [
    "Write a git commit message for the change below.",
    "- First line: an imperative summary of at most 72 characters, no trailing period.",
    "- Add a blank line and a short body (wrapped at 72 columns) only when the change needs explaining: what changed and why, not how.",
    c.recent.length ? `- Match the style of this repository's recent commit subjects:\n${c.recent.map((s) => `  ${s}`).join("\n")}` : "",
    "- Reply with the commit message only: no preamble, no quotes, no code fences.",
    "",
    c.scope === "staged" ? "The staged change:" : "The change (nothing is staged, so this is everything that would be committed):",
    c.stat,
    c.newFiles.length ? `New files: ${c.newFiles.join(", ")}` : "",
    "",
    c.diff,
    c.truncated ? "\n(The diff was cut short; describe what's shown and the file list above.)" : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** The message alone: models sometimes wrap it in fences or quotes, or label it. */
export function cleanMessage(raw: string): string {
  let s = raw.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(s);
  if (fence) s = fence[1].trim();
  s = s.replace(/^(commit message|message)\s*:\s*/i, "");
  if (/^["'`].*["'`]$/s.test(s) && !s.slice(1, -1).includes(s[0])) s = s.slice(1, -1).trim();
  return s;
}

/**
 * One headless turn with no tools, no MCP servers and nothing saved: the diff
 * is in the prompt, so the model only writes. Claude runs a fast model; Codex
 * runs the user's default model at low effort, read-only.
 */
export function claudeCommitCommand(bin: string): string {
  return [quote(bin), "-p", "--model", "haiku", "--output-format", "json", "--tools", quote(""), "--strict-mcp-config", "--no-session-persistence"].join(" ");
}

export function codexCommitCommand(bin: string, lastFile: string): string {
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

/**
 * Ask an agent's CLI for a commit message. It runs in a scratch folder, so no
 * project instructions or settings load, tagged so its hook events are never
 * mistaken for a pane's.
 */
export async function generateCommitMessage(root: string, agent: AgentKind, bin: string, run: ShellRunner, env: Record<string, string>): Promise<{ message: string; scope: CommitContext["scope"] }> {
  if (!bin.includes("/")) throw new Error(`${agent === "codex" ? "Codex" : "Claude Code"} isn't installed`);
  const ctx = await commitContext(root);
  const prompt = commitPrompt(ctx);
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mb-commit-"));
  const opts = { cwd: tmp, env: { ...env, MOCKINGBIRD_SESSION: `commit-message-${path.basename(tmp)}` }, timeoutMs: TIMEOUT_MS };
  try {
    let text: string;
    if (agent === "claude") {
      const r = await run(claudeCommitCommand(bin), prompt, opts);
      let out: any;
      try {
        out = JSON.parse(r.out);
      } catch {
        throw new Error(r.out.trim().slice(0, 300) || `claude exited with code ${r.code}`);
      }
      if (r.code !== 0 || out.is_error) throw new Error(String(out.result ?? `claude exited with code ${r.code}`).slice(0, 300));
      text = String(out.result ?? "");
    } else {
      const last = path.join(tmp, "message.txt");
      const r = await run(codexCommitCommand(bin, last), prompt, opts);
      text = await fs.promises.readFile(last, "utf8").catch(() => "");
      if (r.code !== 0 || !text.trim()) throw new Error((r.out.split("\n").filter((l) => /error/i.test(l)).pop() ?? r.out).trim().slice(0, 300) || `codex exited with code ${r.code}`);
    }
    const message = cleanMessage(text);
    if (!message) throw new Error("The model returned an empty message");
    return { message, scope: ctx.scope };
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}
