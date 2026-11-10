import * as fs from "fs";
import * as path from "path";
import { currentBranch, isRepo } from "./git";
import { guardedGit } from "./safeGit";
import { isSidechainFile, parseClaudeLine, parseCodexLine } from "./transcripts";
import type { AgentKind, LastReply } from "../shared/types";
import { isMissing } from "./fileOps";
import { agentLabel } from "./agents";
import { realpathOr } from "./agentFiles";
import { inside } from "./files";

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 6 * 1024 * 1024;
const ENTRY_CHARS = 2000;

/** How a transcript file is opened to read: what's read is what's checked, on the one handle (see openTranscript). */
const TRANSCRIPT_OPEN = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

/**
 * A transcript file, open for reading: a link or a FIFO swapped in since the file was picked is refused, and O_NONBLOCK
 * keeps a FIFO from holding the open until something writes to it.
 */
async function openTranscript(file: string): Promise<{ fh: fs.promises.FileHandle; size: number; mtime: number }> {
  const fh = await fs.promises.open(file, TRANSCRIPT_OPEN);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error(`${file} isn't a regular file`);
    return { fh, size: st.size, mtime: st.mtimeMs };
  } catch (err) {
    await fh.close();
    throw err;
  }
}

/**
 * A transcript's lines without reading all of a long one: its start (where
 * the task was set) and its most recent part. A line cut by either window is
 * dropped.
 */
export async function transcriptLines(file: string): Promise<string[]> {
  const { fh, size } = await openTranscript(file);
  try {
    if (size <= HEAD_BYTES + TAIL_BYTES) return (await tailOf(fh, size, size)).filter(Boolean);
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(head, 0, HEAD_BYTES, 0);
    const h = head.toString("utf8", 0, bytesRead).split("\n").slice(0, -1);
    return [...h, ...(await tailOf(fh, size, TAIL_BYTES))].filter(Boolean);
  } finally {
    await fh.close();
  }
}

/**
 * What a digest keeps of the tools: the calls (what ran, as today's handoffs read it), the calls and what each gave
 * back (a context link's read, by default), or neither (a link set to leave tool output out).
 */
export type DigestTools = "calls" | "all" | "none";

/**
 * A conversation condensed for another agent to read: who said what, and the
 * tools that ran. It keeps the first request (the task) and as much of the
 * end as fits, with a marker where the middle was left out. `entry` rewrites each entry's text before it's cut to
 * size (redaction, which then sees a secret whole).
 */
export function transcriptDigest(lines: string[], agent: AgentKind, conv: string, maxChars = 40_000, o: { tools?: DigestTools; entry?: (text: string) => string } = {}): string {
  const parse = agent === "codex" ? parseCodexLine : parseClaudeLine;
  const tools = o.tools ?? "calls";
  const entries: string[] = [];
  for (const line of lines) {
    for (const c of parse(line, conv, { outputs: tools === "all" }).chunks) {
      if (c.sidechain) continue; // a subagent's, not the conversation's
      if (c.kind !== "message" && tools === "none") continue;
      const who = c.kind === "tool" ? "TOOL" : c.kind === "output" ? "OUTPUT" : c.role === "user" ? "USER" : "AGENT";
      const said = o.entry ? o.entry(c.text) : c.text;
      const text = said.length > ENTRY_CHARS ? `${said.slice(0, ENTRY_CHARS)} …` : said;
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

/**
 * How much of a transcript's end is read for its latest message: the last 1 MB, which holds a reply and what followed
 * it almost always, then, when a turn's tool output filled that, the last 8 MB.
 */
export const REPLY_WINDOWS = [1024 * 1024, 8 * 1024 * 1024];

/** A message's first line as a card says it: its leading heading or quote marks and inline emphasis let go. */
const plainLine = (s: string) =>
  s
    .replace(/^(#{1,6}|>)\s+/, "")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .trim();

/**
 * The first line of the agent's latest message among a transcript's `lines` (oldest first), as the digests read
 * them, and when it was written; null when the agent hasn't said anything in them. Tool calls and the user's
 * messages don't count.
 */
export function lastReplyLine(lines: string[], agent: AgentKind, conv: string): LastReply | null {
  const parse = agent === "codex" ? parseCodexLine : parseClaudeLine;
  for (let i = lines.length - 1; i >= 0; i--) {
    const chunks = parse(lines[i], conv).chunks;
    for (let j = chunks.length - 1; j >= 0; j--) {
      const c = chunks[j];
      // a subagent's lines in the conversation's own transcript aren't what the agent said
      if (c.kind !== "message" || c.role !== "assistant" || c.sidechain) continue;
      const first = c.text.split("\n").map(plainLine).find(Boolean);
      if (first) return { line: first.length > 300 ? `${first.slice(0, 299)}…` : first, at: c.at || null };
    }
  }
  return null;
}

/**
 * The agent's latest message among a transcript's `lines` (oldest first), whole: its text blocks from the last one back
 * to the tool call or the user's message before them, and when it was written; null when the agent hasn't said
 * anything in them. What a step's summary is drafted from when the agent didn't give one (Finish step).
 */
export function lastReplyWhole(lines: string[], agent: AgentKind, conv: string): { text: string; at: number | null } | null {
  const parse = agent === "codex" ? parseCodexLine : parseClaudeLine;
  const said: string[] = [];
  let at: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const chunks = parse(lines[i], conv, { maxText: Infinity }).chunks;
    for (let j = chunks.length - 1; j >= 0; j--) {
      const c = chunks[j];
      if (c.sidechain) continue; // a subagent's lines in the conversation's own transcript aren't what the agent said
      if (c.kind === "message" && c.role === "assistant") {
        said.unshift(c.text.trim());
        at ??= c.at || null;
      } else if (said.length) return { text: said.join("\n\n"), at };
    }
  }
  return said.length ? { text: said.join("\n\n"), at } : null;
}

/**
 * What `pick` finds in the end of one transcript file, the newest of it: its last 1 MB first, then its last 8 MB
 * (REPLY_WINDOWS). `cut` says the file goes further back than was read, and what was read held nothing.
 */
async function pickFromEnd<T>(file: string, pick: (lines: string[]) => T | null): Promise<{ found: T | null; cut: boolean; size: number; mtime: number }> {
  const { fh, size, mtime } = await openTranscript(file);
  try {
    let found: T | null = null;
    for (const bytes of REPLY_WINDOWS) {
      found = pick(await tailOf(fh, size, bytes));
      if (found || bytes >= size) break;
    }
    return { found, cut: !found && size > REPLY_WINDOWS[REPLY_WINDOWS.length - 1], size, mtime };
  } finally {
    await fh.close();
  }
}

const cutWhy = () => `no message from the agent in the last ${Math.round(REPLY_WINDOWS[REPLY_WINDOWS.length - 1] / 1024 / 1024)} MB of its transcript, which a long tool output filled`;

/**
 * Conversation `conv`'s latest agent message, whole (lastReplyWhole), from its transcript files (oldest first): the
 * newest file first, an older one only when the newest holds no message at all. `text: null` when it hasn't said
 * anything yet, with `why` when the newest file was read only in part; a file that can't be read throws.
 */
export async function latestMessageOf(files: { path: string; agent: AgentKind }[], conv: string): Promise<{ text: string | null; at: number | null; why?: string }> {
  for (const f of [...files].reverse()) {
    const r = await pickFromEnd(f.path, (lines) => lastReplyWhole(lines, f.agent, conv));
    if (r.found) return r.found;
    if (r.cut) return { text: null, at: null, why: cutWhy() };
  }
  return { text: null, at: null };
}

/** An open file's last `bytes` as whole lines, read without blocking: a window that starts mid-file drops the line it cuts. */
async function tailOf(fh: fs.promises.FileHandle, size: number, bytes: number): Promise<string[]> {
  const n = Math.min(size, bytes);
  const buf = Buffer.alloc(n);
  const { bytesRead } = await fh.read(buf, 0, n, size - n);
  const lines = buf.toString("utf8", 0, bytesRead).split("\n");
  return (n < size ? lines.slice(1) : lines).filter(Boolean);
}

/** One file's answer, kept while the file is unchanged (its size and modified time), so a card shown again reads nothing. */
const replyCache = new Map<string, { size: number; mtime: number; found: LastReply | null }>();
const REPLY_CACHE_MAX = 300;

/**
 * The agent's latest message in one transcript file: its last 1 MB first, then its last 8 MB (REPLY_WINDOWS). Null
 * when the whole file holds none; `{ line: null, why }` when the part read held none but the file goes further back.
 */
async function lastReplyIn(f: { path: string; agent: AgentKind }, conv: string): Promise<LastReply | null> {
  const seen = await fs.promises.stat(f.path);
  const key = `${f.path}\0${conv}`;
  const hit = replyCache.get(key);
  if (hit && hit.size === seen.size && hit.mtime === seen.mtimeMs) return hit.found;
  const r = await pickFromEnd(f.path, (lines) => lastReplyLine(lines, f.agent, conv));
  const found: LastReply | null = r.found ?? (r.cut ? { line: null, at: null, why: cutWhy() } : null);
  replyCache.delete(key);
  replyCache.set(key, { size: r.size, mtime: r.mtime, found });
  if (replyCache.size > REPLY_CACHE_MAX) replyCache.delete(replyCache.keys().next().value!);
  return found;
}

/**
 * Conversation `conv`'s latest agent message, from its transcript files (a Codex conversation can span several,
 * oldest first): the newest file first, an older one only when the newest holds no message at all (a resumed
 * conversation that hasn't answered yet). `{ line: null }` when it hasn't said anything yet; `why` says when the
 * newest file was read only in part and held none; a file that can't be read throws.
 */
export async function lastReplyOf(files: { path: string; agent: AgentKind }[], conv: string): Promise<LastReply> {
  for (const f of [...files].reverse()) {
    const found = await lastReplyIn(f, conv);
    if (found) return found;
  }
  return { line: null, at: null };
}

/**
 * The transcript files to read a conversation's latest message from now, oldest first, without waiting for the index
 * to catch up (it syncs after a few quiet seconds, and can lag minutes behind): the file the agent's hooks name
 * (`hook`), then the index's, then `locate` (its project folder's `<conv>.jsonl`, or the newest rollout named for
 * it). A Claude conversation is its own `<conv>.jsonl` only, never a subagent's file; a Codex one is every rollout
 * named for it, by their timestamped names.
 */
export function replyFiles(
  agent: AgentKind,
  conv: string,
  o: { hook: string | null; indexed: readonly { path: string }[]; locate: () => string | null; exists?: (file: string) => boolean }
): { path: string; agent: AgentKind }[] {
  const exists = o.exists ?? isRegularFile;
  const usable = (p: string | null | undefined): p is string => !!p && !isSidechainFile(p) && exists(p);
  if (agent === "claude") {
    const own = (p: string | null | undefined): p is string => usable(p) && path.basename(p) === `${conv}.jsonl`;
    const known = [o.hook, ...o.indexed.map((f) => f.path)].find(own);
    const file = known ?? o.locate();
    return own(file) ? [{ path: file, agent }] : [];
  }
  const files = new Set(o.indexed.map((f) => f.path).filter(usable));
  if (usable(o.hook)) files.add(o.hook);
  else {
    const found = o.locate();
    if (usable(found)) files.add(found);
  }
  return [...files].sort((a, b) => path.basename(a).localeCompare(path.basename(b))).map((p) => ({ path: p, agent }));
}

/** A file that opening can't hang on: a FIFO would hold a thread until something writes to it. */
function isRegularFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

const hookRefusalsSaid = new Set<string>();

/**
 * The transcript path a hook named (`file`), as a path main may open: a regular file inside one of `roots` with links
 * followed, as `path`. The path comes from the events file the hooks write to, so whatever can write there could name
 * any file main can read: anything else is `refused`, with why, logged once for each reason, and so is one that can't
 * be looked at (a link loop, no permission). Only one that isn't there is neither (a new conversation's file isn't
 * written yet).
 */
export function hookTranscript(file: string | null, roots: readonly string[], log: (context: string, err: unknown) => string): { path: string | null; refused: string | null } {
  if (!file) return { path: null, refused: null };
  let real: string | null = null;
  let why: string | null = null;
  try {
    real = fs.realpathSync(file);
    const at = real;
    if (!roots.some((root) => inside(realpathOr(root), at))) why = `outside ${roots.join(" and ")}, the folders Mockingbird reads transcripts from`;
    else if (!fs.statSync(at).isFile()) why = "not a regular file";
  } catch (err) {
    if (isMissing(err)) return { path: null, refused: null };
    why = `unreadable (${(err as Error).message})`;
  }
  if (!why) return { path: real, refused: null };
  const refused = `its transcript, ${file}, is ${why}`;
  if (!hookRefusalsSaid.has(refused)) {
    hookRefusalsSaid.add(refused);
    log("not reading the transcript a hook named", refused);
  }
  return { path: null, refused };
}

/**
 * Conversation `conv`'s latest agent message, found now (replyFiles), the path its hooks named (`hook`) only when it's
 * inside `roots` (hookTranscript). When that was refused and nothing else held a message, `why` says so, rather than
 * looking like an agent that hasn't said anything (an agent with its own config folder keeps its transcripts elsewhere).
 */
export async function replyOfConversation(agent: AgentKind, conv: string, o: ConversationLookup): Promise<LastReply> {
  const { files, refused } = conversationFiles(agent, conv, o);
  const reply = await lastReplyOf(files, conv);
  return refused && !reply.line && !reply.why ? { ...reply, why: refused } : reply;
}

/** Where a conversation's transcript files are looked for (conversationFiles). */
export interface ConversationLookup {
  /** The file the pane's hooks named for it, or null. */
  hook: string | null;
  /** The folders transcripts are read from: a hook's path anywhere else is refused. */
  roots: readonly string[];
  indexed: readonly { path: string }[];
  locate: () => string | null;
  log: (context: string, err: unknown) => string;
}

/**
 * Conversation `conv`'s transcript files to read now, oldest first (replyFiles), the path its hooks named used only
 * when it's inside `roots` (hookTranscript): `refused` says why it wasn't, so a caller that finds nothing can say so
 * rather than look like a conversation with nothing in it.
 */
export function conversationFiles(agent: AgentKind, conv: string, o: ConversationLookup): { files: { path: string; agent: AgentKind }[]; refused: string | null } {
  const hook = hookTranscript(o.hook, o.roots, o.log);
  return { files: replyFiles(agent, conv, { hook: hook.path, indexed: o.indexed, locate: o.locate }), refused: hook.refused };
}

/** The worktree as it stands: branch, uncommitted files, recent commits. */
export async function repoState(cwd: string): Promise<string> {
  if (!(await isRepo(cwd))) return "(not a git repository)";
  const g = await guardedGit(cwd);
  const [branch, status, log, stat] = await Promise.all([
    currentBranch(cwd),
    // untrimmed: the first line's leading space is its "unstaged" column
    g.status(["--short"], { trim: false }).then((o) => o.trimEnd()),
    g.run(["log", "--oneline", "-10"], { okCodes: [0, 128] }),
    g.diff(["--stat", "HEAD"], { okCodes: [0, 128] }),
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
