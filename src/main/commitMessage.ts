import * as fs from "fs";
import * as path from "path";
import { git } from "./git";
import { askAgent, cleanReply, type ShellRunner } from "./headless";
import type { AgentKind } from "../shared/types";

export type { ShellRunner } from "./headless";

const MAX_DIFF_CHARS = 60_000;
const MAX_NEW_FILE_CHARS = 8_000;

export interface CommitContext {
  /** "staged" when something is staged; otherwise "all" — what Commit would stage and commit. */
  scope: "staged" | "all";
  stat: string;
  diff: string;
  newFiles: string[];
  recent: string[];
  truncated: boolean;
}

async function readStart(file: string, bytes: number): Promise<Buffer> {
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
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
      // only the start is read: enough to tell binary from text, and all a new file can show
      const head = await readStart(path.join(root, f), MAX_NEW_FILE_CHARS);
      if (head.includes(0)) continue; // binary: its name is enough
      text = head.toString("utf8").replace(/�$/, "").slice(0, Math.min(MAX_NEW_FILE_CHARS, budget));
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
  return cleanReply(raw);
}

/** Ask an agent's CLI for a commit message (see askAgent). */
export async function generateCommitMessage(root: string, agent: AgentKind, bin: string, run: ShellRunner, env: Record<string, string>): Promise<{ message: string; scope: CommitContext["scope"] }> {
  if (!bin.includes("/")) throw new Error(`${agent === "codex" ? "Codex" : "Claude Code"} isn't installed`);
  const ctx = await commitContext(root);
  const message = cleanMessage(await askAgent(commitPrompt(ctx), { agent, bin, run, env, tag: "commit-message" }));
  if (!message) throw new Error("The model returned an empty message");
  return { message, scope: ctx.scope };
}
