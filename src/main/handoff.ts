import * as fs from "fs";
import { git } from "./git";
import { parseClaudeLine, parseCodexLine } from "./transcripts";
import type { AgentKind } from "../shared/types";

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 6 * 1024 * 1024;
const ENTRY_CHARS = 2000;

/**
 * A transcript's lines without reading all of a long one: its start (where
 * the task was set) and its most recent part. A line cut by either window is
 * dropped.
 */
export async function transcriptLines(file: string): Promise<string[]> {
  const fh = await fs.promises.open(file, "r");
  try {
    const { size } = await fh.stat();
    if (size <= HEAD_BYTES + TAIL_BYTES) return (await fh.readFile("utf8")).split("\n").filter(Boolean);
    const head = Buffer.alloc(HEAD_BYTES);
    const tail = Buffer.alloc(TAIL_BYTES);
    await fh.read(head, 0, HEAD_BYTES, 0);
    await fh.read(tail, 0, TAIL_BYTES, size - TAIL_BYTES);
    const h = head.toString("utf8").split("\n").slice(0, -1);
    const t = tail.toString("utf8").split("\n").slice(1);
    return [...h, ...t].filter(Boolean);
  } finally {
    await fh.close();
  }
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
  const isRepo = (await git(cwd, ["rev-parse", "--is-inside-work-tree"], { okCodes: [0, 128] })) === "true";
  if (!isRepo) return "(not a git repository)";
  const [branch, status, log, stat] = await Promise.all([
    git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], { okCodes: [0, 1] }),
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

const AGENT_NAME: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex" };

/** The prompt that turns a conversation and the repository's state into a handoff. */
export function handoffPrompt(o: { from: AgentKind; to: AgentKind; cwd: string; title: string; digest: string; repo: string }): string {
  return [
    `A ${AGENT_NAME[o.from]} session working in ${o.cwd} ("${o.title}") is handing its task to ${AGENT_NAME[o.to]}, usually because it ran out of usage or got stuck.`,
    `Write the handoff ${AGENT_NAME[o.to]} will start from, addressed to it, with these sections:`,
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

/** What the new session is told first: it's taking over, and from what. */
export function handoffKickoff(from: AgentKind, handoff: string): string {
  return [
    `You're taking over a task from a ${AGENT_NAME[from]} session that was working in this folder. Its handoff:`,
    "",
    handoff.trim(),
    "",
    "Check the files as they are now before relying on the handoff, then carry on with the next steps. Ask me if anything in it is unclear.",
  ].join("\n");
}
