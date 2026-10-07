import * as fs from "fs";
import { currentBranch, git, isRepo } from "./git";
import { parseClaudeLine, parseCodexLine } from "./transcripts";
import type { AgentKind } from "../shared/types";
import { readSlice } from "./fileOps";
import { agentLabel } from "./agents";

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 6 * 1024 * 1024;
const ENTRY_CHARS = 2000;

/**
 * A transcript's lines without reading all of a long one: its start (where
 * the task was set) and its most recent part. A line cut by either window is
 * dropped.
 */
export async function transcriptLines(file: string): Promise<string[]> {
  const { size } = await fs.promises.stat(file);
  if (size <= HEAD_BYTES + TAIL_BYTES) return (await fs.promises.readFile(file, "utf8")).split("\n").filter(Boolean);
  const h = readSlice(file, "start", HEAD_BYTES).split("\n").slice(0, -1);
  const t = readSlice(file, "end", TAIL_BYTES).split("\n").slice(1);
  return [...h, ...t].filter(Boolean);
}

/**
 * A conversation condensed for another agent to read: who said what, and the
 * tools that ran. It keeps the first request (the task) and as much of the
 * end as fits, with a marker where the middle was left out.
 */
export function transcriptDigest(lines: string[], agent: AgentKind, conv: string, maxChars = 40_000): string {
  const parse = agent === "codex" ? parseCodexLine : parseClaudeLine;
  const entries: string[] = [];
  for (const line of lines) {
    for (const c of parse(line, conv).chunks) {
      const who = c.kind === "tool" ? "TOOL" : c.role === "user" ? "USER" : "AGENT";
      const text = c.text.length > ENTRY_CHARS ? `${c.text.slice(0, ENTRY_CHARS)} …` : c.text;
      entries.push(`${who}: ${text.trim()}`);
    }
  }
  if (!entries.length) return "";
  const firstAsk = entries.findIndex((e) => e.startsWith("USER: "));
  const head = firstAsk >= 0 ? entries[firstAsk] : "";
  let budget = maxChars - head.length;
  const tail: string[] = [];
  for (let i = entries.length - 1; i > firstAsk && budget > 0; i--) {
    if (entries[i].length > budget) break;
    tail.unshift(entries[i]);
    budget -= entries[i].length + 1;
  }
  const skipped = entries.length - tail.length - (head ? 1 : 0);
  return [head, skipped > 0 ? `[… ${skipped} earlier entries left out …]` : "", ...tail].filter(Boolean).join("\n");
}

/** The worktree as it stands: branch, uncommitted files, recent commits. */
export async function repoState(cwd: string): Promise<string> {
  if (!(await isRepo(cwd))) return "(not a git repository)";
  const [branch, status, log, stat] = await Promise.all([
    currentBranch(cwd),
    // untrimmed: the first line's leading space is its "unstaged" column
    git(cwd, ["status", "--short"], { trim: false }).then((o) => o.trimEnd()),
    git(cwd, ["log", "--oneline", "-10"], { okCodes: [0, 128] }),
    git(cwd, ["diff", "--stat", "HEAD"], { okCodes: [0, 128] }),
  ]);
  return [
    `Branch: ${branch || "(detached)"}`,
    status ? `Uncommitted files:\n${status}` : "No uncommitted changes.",
    stat ? `Uncommitted diff size:\n${stat}` : "",
    log ? `Recent commits:\n${log}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The prompt that turns a conversation and the repository's state into a handoff. */
export function handoffPrompt(o: { from: AgentKind; to: AgentKind; cwd: string; title: string; digest: string; repo: string }): string {
  return [
    `A ${agentLabel(o.from)} session working in ${o.cwd} ("${o.title}") is handing its task to ${agentLabel(o.to)}, usually because it ran out of usage or got stuck.`,
    `Write the handoff ${agentLabel(o.to)} will start from, addressed to it, with these sections:`,
    "## Goal — what the user asked for, in their terms.",
    "## Done — what's finished, naming files and commands.",
    "## In progress — what was underway when it stopped, and the state it's in.",
    "## Next steps — a short numbered list.",
    "## Watch out for — decisions made, constraints the user gave, approaches that failed.",
    "Be specific and brief. Say so when the conversation doesn't show something rather than guessing.",
    "You're only writing this text: your own working directory is a scratch folder and isn't part of the task.",
    "Reply with the handoff only.",
    "",
    "The repository now:",
    o.repo,
    "",
    "The conversation (USER is the person, AGENT the session, TOOL its tool calls):",
    o.digest || "(no conversation was found)",
  ].join("\n");
}

/**
 * What a session continued on a teammate's laptop is told first when its own
 * conversation didn't reach that laptop whole: whose work it is, that the
 * conversation is missing (or missing its end), what of it did arrive, and the
 * files as they are. The agent is asked to say so before carrying on.
 */
export function takeoverKickoff(o: { owner: string; taker: string; agent: AgentKind; title: string; digest: string; repo: string; partial: boolean }): string {
  return [
    `You're continuing "${o.title}", a ${agentLabel(o.agent)} session ${o.owner} was running on their laptop. ${o.taker} took it over on this one, from a snapshot of ${o.owner}'s files.`,
    o.partial
      ? `Only part of that session's conversation reached this laptop — its most recent turns are missing. What did arrive, condensed (USER is the person, AGENT the session, TOOL its tool calls):`
      : `That session's conversation didn't reach this laptop, so you're starting without it.`,
    ...(o.partial ? ["", o.digest, ""] : []),
    "The repository now:",
    o.repo,
    "",
    `First tell ${o.taker} in one line that you're working from ${o.partial ? "a partial conversation" : "the files alone, without the conversation"}. Then check the files and the recent commits to work out where things stand, say what you think was in progress, and ask before going further.`,
  ].join("\n");
}

/** What the new session is told first: it's taking over, and from what. */
export function handoffKickoff(from: AgentKind, handoff: string): string {
  return [
    `You're taking over a task from a ${agentLabel(from)} session that was working in this folder. Its handoff:`,
    "",
    handoff.trim(),
    "",
    "Check the files as they are now before relying on the handoff, then carry on with the next steps. Ask me if anything in it is unclear.",
  ].join("\n");
}
