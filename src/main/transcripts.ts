import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import type { AgentKind, CollabRoom, ImportableConversation, SessionInfo, TranscriptHit } from "../shared/types";
import { ROLLOUT_NAME_RE, epochMs } from "./agentFiles";

/**
 * One searchable index over every Claude Code and Codex conversation on this
 * Mac — open in Mockingbird, closed, or never opened in it. Transcripts only
 * ever grow, so each file is read from where the last pass stopped. The work
 * runs on the main process in short slices that yield between them: it shares
 * the process with every pane's keystrokes.
 */

const SCHEMA_VERSION = 3; // 3: Codex replies' token usage
const SLICE_MS = 8;
const READ_BYTES = 512 * 1024;
const MAX_TEXT = 4000; // per message: enough to find it, without indexing whole pastes
const TITLE_CHARS = 120;

export interface ConversationRow {
  id: string;
  agent: AgentKind;
  cwd: string;
  title: string;
  started: number;
  updated: number;
  model: string | null;
}

export interface SearchHit extends ConversationRow {
  /** The best-matching passage, with \u0001…\u0002 around the matched words. */
  snippet: string;
  at: number;
  kind: "message" | "tool";
}

/** What one transcript line contributes. */
export interface Parsed {
  conv?: Partial<ConversationRow> & { id: string; firstPrompt?: string };
  /** `role` says who wrote a message (the index doesn't store it; a handoff digest uses it). */
  chunks: { text: string; at: number; kind: "message" | "tool"; role?: "user" | "assistant" }[];
  usage?: { id: string; at: number; model: string | null; input: number; output: number; cacheRead: number; cacheWrite: number };
}

const ts = (v: unknown): number => epochMs(v) ?? 0;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const firstLine = (s: string) => s.trim().split("\n").find((l) => l.trim())?.trim() ?? "";
/** Import offers the conversations active in the last 30 days, the newest 80. */
export const IMPORT_WINDOW_MS = 30 * 86_400_000;
export const IMPORT_LIMIT = 80;

/** A conversation as Import lists it: its title, else its first request, else its folder's name — one line, 70 characters at most. */
export function importTitle(cwd: string, ...candidates: (string | null | undefined)[]): string {
  return (candidates.find((c) => c?.trim()) ?? path.basename(cwd)).replace(/\s+/g, " ").trim().slice(0, 70);
}

/** Command wrappers and system notes, not something the user typed: left out of the index. */
const isNoise = (s: string) => /^\s*<(command-|local-command-|system-reminder|bash-|user-memory)/.test(s) || /^Caveat: /.test(s);
/** What can title a conversation: a request the user typed — not noise, an interruption marker or a compacted conversation's summary. */
export const isRealPrompt = (s: string) => !isNoise(s) && !/^\s*(\[Request interrupted|This session is being continued)/.test(s);

/** The searchable part of a tool call's input: the command, the file, the pattern, the URL. */
function toolInputText(name: string, input: any): string {
  if (!input || typeof input !== "object") return typeof input === "string" ? clip(input, MAX_TEXT) : "";
  const parts = [input.command, input.cmd, input.file_path, input.path, input.notebook_path, input.pattern, input.glob, input.url, input.query, input.description]
    .map((v) => (Array.isArray(v) ? v.join(" ") : v))
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return parts.length ? clip(`${name} ${parts.join(" ")}`, MAX_TEXT) : "";
}

/** One line of a Claude Code transcript (~/.claude/projects/<folder>/<session>.jsonl). */
export function parseClaudeLine(line: string, fileConv: string): Parsed {
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return { chunks: [] };
  }
  const id = String(d.sessionId ?? fileConv);
  const at = ts(d.timestamp);
  const out: Parsed = { chunks: [] };
  const conv: Parsed["conv"] = { id };
  if (d.cwd) conv.cwd = String(d.cwd);
  if (at) conv.updated = at;
  if (d.type === "ai-title" && d.aiTitle) conv.title = clip(String(d.aiTitle), TITLE_CHARS);
  if (d.type === "summary" && d.summary) conv.title = clip(String(d.summary), TITLE_CHARS);
  const m = d.message;
  if ((d.type === "user" || d.type === "assistant") && m && !d.isMeta) {
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
    for (const c of content) {
      if (c?.type === "text" && typeof c.text === "string" && c.text.trim() && !isNoise(c.text)) {
        out.chunks.push({ text: clip(c.text, MAX_TEXT), at, kind: "message", role: d.type });
        if (d.type === "user" && !d.isSidechain && isRealPrompt(c.text)) conv.firstPrompt = clip(firstLine(c.text), TITLE_CHARS);
      } else if (c?.type === "tool_use") {
        const text = toolInputText(String(c.name ?? "tool"), c.input);
        if (text) out.chunks.push({ text, at, kind: "tool" });
      }
    }
    if (d.type === "assistant") {
      if (m.model && m.model !== "<synthetic>") conv.model = String(m.model);
      const u = m.usage;
      if (u && m.id) {
        out.usage = {
          id: String(m.id),
          at,
          model: m.model ?? null,
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
        };
      }
    }
  }
  out.conv = conv;
  return out;
}

/** The files an apply_patch touched — `*** Update File: src/a.ts` and friends. */
function patchFiles(patch: string): string {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim()).join(" ");
}

/** One line of a Codex rollout (~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl). */
export function parseCodexLine(line: string, fileConv: string): Parsed {
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return { chunks: [] };
  }
  const p = d.payload ?? {};
  const at = ts(d.timestamp ?? p.timestamp);
  const out: Parsed = { chunks: [], conv: { id: fileConv, ...(at ? { updated: at } : {}) } };
  if (d.type === "session_meta") {
    out.conv = { id: String(p.id ?? p.session_id ?? fileConv), ...(p.cwd ? { cwd: String(p.cwd) } : {}), ...(at ? { started: at, updated: at } : {}) };
    return out;
  }
  if (d.type === "turn_context" && p.model) out.conv!.model = String(p.model);
  if (d.type === "event_msg" && p.type === "token_count") {
    // one turn's usage; the same event repeats without new tokens, so the running total names it
    const last = p.info?.last_token_usage;
    const total = p.info?.total_token_usage?.total_tokens;
    if (last && typeof total === "number" && total > 0) {
      const cached = last.cached_input_tokens ?? 0;
      out.usage = {
        id: `${fileConv}:${total}`,
        at,
        model: null,
        // Codex counts cached input inside input_tokens
        input: Math.max(0, (last.input_tokens ?? 0) - cached),
        output: last.output_tokens ?? 0,
        cacheRead: cached,
        cacheWrite: last.cache_write_input_tokens ?? 0,
      };
    }
    return out;
  }
  if (d.type !== "response_item") return out;
  if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
    for (const c of Array.isArray(p.content) ? p.content : []) {
      const text = typeof c?.text === "string" ? c.text : "";
      if (!text.trim() || isNoise(text) || /^<(environment_context|user_instructions|permissions)/.test(text.trim())) continue;
      out.chunks.push({ text: clip(text, MAX_TEXT), at, kind: "message", role: p.role });
      if (p.role === "user" && isRealPrompt(text)) out.conv!.firstPrompt = clip(firstLine(text), TITLE_CHARS);
    }
  } else if (p.type === "function_call" || p.type === "local_shell_call") {
    let args: any = p.arguments ?? p.action;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        /* free-form arguments: indexed as they are */
      }
    }
    const text = toolInputText(String(p.name ?? "shell"), args);
    if (text) out.chunks.push({ text, at, kind: "tool" });
  } else if (p.type === "custom_tool_call") {
    const files = typeof p.input === "string" ? patchFiles(p.input) : "";
    const text = files ? `${p.name ?? "apply_patch"} ${files}` : toolInputText(String(p.name ?? "tool"), p.input);
    if (text) out.chunks.push({ text: clip(text, MAX_TEXT), at, kind: "tool" });
  }
  return out;
}

/** Free text → an FTS5 query: every word must appear; the last one may be a prefix. */
export function ftsQuery(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}_]+(?:[./:-][\p{L}\p{N}_]+)*/gu) ?? [];
  if (!words.length) return null;
  return words.map((w, i) => `"${w.replace(/"/g, '""')}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

export interface UsageRow {
  conv: string;
  agent: AgentKind;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  replies: number;
}

export class TranscriptIndex {
  private db: DatabaseSync;
  private running: Promise<void> | null = null;
  private rerun = false;
  lastSync = 0;
  progress: { done: number; total: number } | null = null;

  constructor(
    dbPath: string,
    private roots: { claude: string; codex: string },
    private sliceMs = SLICE_MS
  ) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version !== SCHEMA_VERSION) {
      // an index from another layout is rebuilt from the transcripts, which stay the source of truth
      this.db.exec("DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS conversations; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS usage;");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, agent TEXT NOT NULL, conv TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, offset INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, agent TEXT NOT NULL, cwd TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', first_prompt TEXT NOT NULL DEFAULT '', started INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0, model TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(text, conv UNINDEXED, file UNINDEXED, at UNINDEXED, kind UNINDEXED, tokenize = 'porter unicode61');
      CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, conv TEXT NOT NULL, file TEXT NOT NULL, at INTEGER NOT NULL, model TEXT, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER);
      CREATE INDEX IF NOT EXISTS usage_conv ON usage (conv);
      CREATE INDEX IF NOT EXISTS usage_at ON usage (at);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
    this.stmt = {
      upsertConv: this.db.prepare(
        `INSERT INTO conversations (id, agent, cwd, title, first_prompt, started, updated, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cwd = CASE WHEN conversations.cwd = '' THEN excluded.cwd ELSE conversations.cwd END,
           title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE conversations.title END,
           first_prompt = CASE WHEN conversations.first_prompt = '' THEN excluded.first_prompt ELSE conversations.first_prompt END,
           started = CASE WHEN conversations.started = 0 OR (excluded.started > 0 AND excluded.started < conversations.started) THEN excluded.started ELSE conversations.started END,
           updated = MAX(conversations.updated, excluded.updated),
           model = COALESCE(excluded.model, conversations.model)`
      ),
      chunk: this.db.prepare("INSERT INTO chunks (text, conv, file, at, kind) VALUES (?, ?, ?, ?, ?)"),
      usage: this.db.prepare("INSERT OR IGNORE INTO usage (id, conv, file, at, model, input, output, cache_read, cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    };
  }

  private stmt: Record<"upsertConv" | "chunk" | "usage", ReturnType<DatabaseSync["prepare"]>>;

  /** Bring the index up to date. Calls during a pass are folded into one more pass after it. */
  sync(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.rerun = false;
          await this.pass();
        } while (this.rerun);
        this.lastSync = Date.now();
      } finally {
        this.running = null;
        this.progress = null;
      }
    })();
    return this.running;
  }

  get indexing(): boolean {
    return this.running !== null;
  }

  private async pass(): Promise<void> {
    const files = [...listJsonl(this.roots.claude, "claude"), ...listJsonl(this.roots.codex, "codex")];
    const known = new Map(
      (this.db.prepare("SELECT path, size, mtime, offset FROM files").all() as { path: string; size: number; mtime: number; offset: number }[]).map((r) => [r.path, r])
    );
    const todo = files.filter((f) => {
      const k = known.get(f.path);
      return !k || k.size !== f.size || k.mtime !== f.mtime;
    });
    this.progress = { done: 0, total: todo.length };
    for (const f of todo) {
      const k = known.get(f.path);
      // smaller than what was read means the file was replaced, not appended: read it again
      const from = k && f.size >= k.offset ? k.offset : 0;
      try {
        if (k && from === 0) this.forgetFile(f.path);
        await this.ingest(f, from);
      } catch (err) {
        // one transcript never stops the rest: Claude deletes old ones on its
        // own schedule, so a file can vanish between listing and reading
        if ((err as NodeJS.ErrnoException).code === "ENOENT") this.forgetFile(f.path);
        else this.reportSkipped(f.path, err);
      }
      this.progress = { done: this.progress.done + 1, total: todo.length };
    }
  }

  private skipped = new Map<string, string>();
  /** A transcript that couldn't be read is retried every pass; each new reason is logged once. */
  private reportSkipped(file: string, err: unknown): void {
    const why = err instanceof Error ? err.message : String(err);
    if (this.skipped.get(file) === why) return;
    this.skipped.set(file, why);
    console.error(`[transcripts] couldn't index ${file}; skipped:`, err);
  }

  private forgetFile(file: string): void {
    this.db.prepare("DELETE FROM chunks WHERE file = ?").run(file);
    this.db.prepare("DELETE FROM usage WHERE file = ?").run(file);
    this.db.prepare("DELETE FROM files WHERE path = ?").run(file);
  }

  /**
   * Index a transcript from byte `from` on. Lines are cut at newline bytes
   * (never inside a multibyte character), and the file's offset is saved in
   * the same transaction as the rows it covers, so stopping anywhere — a quit,
   * an error — resumes without reading a line twice or skipping one.
   */
  private async ingest(f: { path: string; agent: AgentKind; conv: string; size: number; mtime: number }, from: number): Promise<void> {
    const parse = f.agent === "claude" ? parseClaudeLine : parseCodexLine;
    const saveOffset = this.db.prepare(
      "INSERT INTO files (path, agent, conv, size, mtime, offset) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET conv = excluded.conv, size = excluded.size, mtime = excluded.mtime, offset = excluded.offset"
    );
    const fh = await fs.promises.open(f.path, "r");
    let readTo = from;
    let done = from;
    let carry = Buffer.alloc(0);
    let convId = f.conv;
    try {
      for (;;) {
        const buf = Buffer.alloc(READ_BYTES);
        const { bytesRead } = await fh.read(buf, 0, READ_BYTES, readTo);
        if (!bytesRead) break;
        readTo += bytesRead;
        const text = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        const start = readTo - text.length; // the file offset of text[0]
        // a line still being written waits for the next pass
        const end = text.lastIndexOf(0x0a) + 1;
        carry = Buffer.from(text.subarray(end));
        let pos = 0;
        while (pos < end) {
          const until = Date.now() + this.sliceMs;
          this.db.exec("BEGIN");
          try {
            do {
              const nl = text.indexOf(0x0a, pos);
              const line = text.toString("utf8", pos, nl);
              pos = nl + 1;
              if (line.trim()) convId = this.apply(parse(line, convId), f.agent, f.path) ?? convId;
            } while (pos < end && Date.now() < until);
            // size -1 marks the file part-read: the next pass resumes it even if it hasn't changed
            saveOffset.run(f.path, f.agent, convId, -1, f.mtime, start + pos);
            this.db.exec("COMMIT");
          } catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
          }
          done = start + pos;
          await yieldNow();
        }
        if (bytesRead < READ_BYTES) break;
      }
    } finally {
      await fh.close();
    }
    saveOffset.run(f.path, f.agent, convId, f.size, f.mtime, done);
  }

  /** Write one line's contribution; returns the conversation it belongs to. */
  private apply(p: Parsed, agent: AgentKind, file: string): string | undefined {
    const c = p.conv;
    if (!c) return undefined;
    this.stmt.upsertConv.run(c.id, agent, c.cwd ?? "", c.title ?? "", c.firstPrompt ?? "", c.started ?? c.updated ?? 0, c.updated ?? 0, c.model ?? null);
    for (const k of p.chunks) this.stmt.chunk.run(k.text, c.id, file, k.at, k.kind);
    if (p.usage) {
      const u = p.usage;
      this.stmt.usage.run(u.id, c.id, file, u.at, u.model, u.input, u.output, u.cacheRead, u.cacheWrite);
    }
    return c.id;
  }

  /** The best passage per conversation for a free-text query, best first. */
  search(q: string, limit = 40): SearchHit[] {
    const match = ftsQuery(q);
    if (!match) return [];
    // each conversation's best chunk, best conversations first: `rank` is
    // bm25, and MIN's bare rowid comes from the row holding the minimum
    const best = this.db
      .prepare(
        `SELECT rowid AS rid, MIN(rank) AS best FROM chunks
         WHERE chunks MATCH ? AND conv IN (SELECT id FROM conversations)
         GROUP BY conv ORDER BY best LIMIT ?`
      )
      .all(match, limit) as { rid: number }[];
    if (!best.length) return [];
    const passages = new Map(
      (
        this.db
          .prepare(
            `SELECT rowid AS rid, conv, at, kind, snippet(chunks, 0, char(1), char(2), '…', 14) AS snip
             FROM chunks WHERE chunks MATCH ? AND rowid IN (${best.map(() => "?").join(",")})`
          )
          .all(match, ...best.map((b) => b.rid)) as { rid: number; conv: string; at: number; kind: "message" | "tool"; snip: string }[]
      ).map((p) => [p.rid, p])
    );
    const getConv = this.db.prepare("SELECT id, agent, cwd, title, first_prompt, started, updated, model FROM conversations WHERE id = ?");
    const hits: SearchHit[] = [];
    for (const { rid } of best) {
      const p = passages.get(rid);
      const c = p && (getConv.get(p.conv) as any);
      if (!c) continue;
      hits.push({
        id: c.id,
        agent: c.agent,
        cwd: c.cwd,
        title: c.title || c.first_prompt || "(untitled conversation)",
        started: c.started,
        updated: c.updated,
        model: c.model ?? null,
        snippet: p.snip,
        at: p.at,
        kind: p.kind,
      });
    }
    return hits;
  }

  /**
   * Both agents' conversations active since `since`, newest first, whose
   * folder still exists — what Import offers to reopen (`claude --resume` /
   * `codex resume` with the id, in that folder).
   */
  recentConversations(since = Date.now() - IMPORT_WINDOW_MS, limit = IMPORT_LIMIT): ImportableConversation[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent, cwd, title, first_prompt, updated FROM conversations c
         WHERE updated >= ? AND cwd <> '' AND EXISTS (SELECT 1 FROM files f WHERE f.conv = c.id)
         ORDER BY updated DESC`
      )
      .all(since) as { id: string; agent: AgentKind; cwd: string; title: string; first_prompt: string; updated: number }[];
    const out: ImportableConversation[] = [];
    for (const r of rows) {
      if (out.length >= limit) break;
      if (!fs.existsSync(r.cwd)) continue; // worktree or repo deleted since
      out.push({ sessionId: r.id, agent: r.agent, cwd: r.cwd, title: importTitle(r.cwd, r.title, r.first_prompt), mtimeMs: r.updated });
    }
    return out;
  }

  /** The models this agent's conversations used lately, most recent first. */
  recentModels(agent: AgentKind, since = Date.now() - 30 * 86_400_000): string[] {
    const rows = this.db
      .prepare("SELECT model, MAX(updated) AS last FROM conversations WHERE agent = ? AND model IS NOT NULL AND updated >= ? GROUP BY model ORDER BY last DESC")
      .all(agent, since) as { model: string }[];
    return rows.map((r) => r.model);
  }

  /**
   * Token usage summed per conversation and model (with the conversation's
   * agent): for the given conversations, or every conversation; from `since`.
   * A Codex reply has no model of its own, so its conversation's model is used.
   */
  usage(opts: { convs?: string[]; since?: number; until?: number } = {}): UsageRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.convs) {
      if (!opts.convs.length) return [];
      where.push(`u.conv IN (${opts.convs.map(() => "?").join(",")})`);
      args.push(...opts.convs);
    }
    if (opts.since !== undefined) {
      where.push("u.at >= ?");
      args.push(opts.since);
    }
    if (opts.until !== undefined) {
      where.push("u.at < ?");
      args.push(opts.until);
    }
    return (
      this.db
        .prepare(
          `SELECT u.conv AS conv, c.agent AS agent, COALESCE(u.model, c.model) AS model,
                  SUM(u.input) AS input, SUM(u.output) AS output, SUM(u.cache_read) AS cacheRead, SUM(u.cache_write) AS cacheWrite, COUNT(*) AS replies
           FROM usage u JOIN conversations c ON c.id = u.conv
           ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           GROUP BY u.conv, COALESCE(u.model, c.model)`
        )
        .all(...args) as unknown as UsageRow[]
    ).map((r) => ({ ...r, model: r.model ?? null }));
  }

  /**
   * When each conversation was active in [since, until): the times of its
   * messages and tool calls, with the conversation's agent, folder and title.
   */
  activity(since: number, until: number): { conv: string; agent: AgentKind; cwd: string; title: string; times: number[] }[] {
    const rows = this.db
      .prepare(
        `SELECT ch.conv AS conv, c.agent AS agent, c.cwd AS cwd, COALESCE(NULLIF(c.title, ''), c.first_prompt) AS title, ch.at AS at
         FROM chunks ch JOIN conversations c ON c.id = ch.conv
         WHERE ch.at >= ? AND ch.at < ? ORDER BY ch.conv, ch.at`
      )
      .all(since, until) as { conv: string; agent: AgentKind; cwd: string; title: string; at: number }[];
    const out = new Map<string, { conv: string; agent: AgentKind; cwd: string; title: string; times: number[] }>();
    for (const r of rows) {
      const cur = out.get(r.conv) ?? { conv: r.conv, agent: r.agent, cwd: r.cwd, title: r.title, times: [] };
      cur.times.push(Number(r.at));
      out.set(r.conv, cur);
    }
    return [...out.values()];
  }

  /** The transcript files of a conversation (a Codex conversation can span several). */
  filesOf(conv: string): { path: string; agent: AgentKind }[] {
    return this.db.prepare("SELECT path, agent FROM files WHERE conv = ? ORDER BY path").all(conv) as { path: string; agent: AgentKind }[];
  }

  stats(): { conversations: number; files: number } {
    const conversations = (this.db.prepare("SELECT count(*) AS n FROM conversations").get() as { n: number }).n;
    const files = (this.db.prepare("SELECT count(*) AS n FROM files").get() as { n: number }).n;
    return { conversations, files };
  }

  close(): void {
    this.db.close();
  }
}

const paneByConv = (list: SessionInfo[]) => new Map(list.flatMap((s) => (s.conversation ? [[s.conversation.id, s.id] as const] : [])));

function roomByConv(rooms: CollabRoom[]): Map<string, { roomId: string; roomTitle: string }> {
  const room = new Map<string, { roomId: string; roomTitle: string }>();
  for (const r of rooms) {
    for (const p of r.participants) for (const id of [p.conversationId, p.lookupConversationId]) if (id) room.set(id, { roomId: r.id, roomTitle: r.title });
  }
  return room;
}

/** Conversations to offer for import: not running in a live pane or a Collaborate room, where a second copy would fork them. */
export function importable(convs: ImportableConversation[], live: SessionInfo[], rooms: CollabRoom[]): ImportableConversation[] {
  const pane = paneByConv(live);
  const room = roomByConv(rooms);
  return convs.filter((c) => !pane.has(c.sessionId) && !room.has(c.sessionId));
}

/** How each hit opens: its live pane, the closed session that resumes it, its Collaborate room, or a new session. */
export function linkHits(hits: SearchHit[], live: SessionInfo[], previous: SessionInfo[], rooms: CollabRoom[]): TranscriptHit[] {
  const pane = paneByConv(live);
  const before = paneByConv(previous);
  const room = roomByConv(rooms);
  return hits.map((h): TranscriptHit => {
    const p = pane.get(h.id);
    if (p) return { ...h, open: { how: "pane", sessionId: p } };
    const b = before.get(h.id);
    if (b) return { ...h, open: { how: "previous", sessionId: b } };
    const r = room.get(h.id);
    if (r) return { ...h, open: { how: "room", ...r } };
    return { ...h, open: { how: "resume" } };
  });
}

/** Every .jsonl under a root, with the conversation id its name implies. */
function listJsonl(root: string, agent: AgentKind): { path: string; agent: AgentKind; conv: string; size: number; mtime: number }[] {
  const out: { path: string; agent: AgentKind; conv: string; size: number; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no transcripts from this agent (yet)
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4) walk(p, depth + 1);
      } else if (e.name.endsWith(".jsonl")) {
        let st: fs.Stats;
        try {
          st = fs.statSync(p);
        } catch {
          continue; // removed while listing
        }
        const stem = e.name.replace(/\.jsonl$/, "");
        const conv = agent === "codex" ? ROLLOUT_NAME_RE.exec(e.name)?.[1] ?? stem : stem;
        out.push({ path: p, agent, conv, size: st.size, mtime: Math.floor(st.mtimeMs) });
      }
    }
  };
  walk(root, 0);
  return out;
}
