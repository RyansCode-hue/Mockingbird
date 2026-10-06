import * as fs from "fs";
import * as path from "path";
import { ImportableConversation } from "../shared/types";
import { CLAUDE_PROJECTS } from "./agentFiles";
import { isMissing, readSlice } from "./fileOps";
import { IMPORT_LIMIT, IMPORT_WINDOW_MS, importTitle, isRealPrompt } from "./transcripts";

const HEAD_BYTES = 128 * 1024;

/**
 * List recent Claude Code conversations from ~/.claude/projects — frontend-agnostic,
 * so sessions started in cmux (or a bare terminal) show up too. Each can be reopened
 * with `claude --resume <sessionId>` in its original cwd.
 *
 * No folder means no conversations. A folder or transcript that can't be read
 * is left out and logged; when nothing could be read at all, that's an error,
 * not an empty list.
 */
export function listClaudeConversations(): ImportableConversation[] {
  const out: ImportableConversation[] = [];
  const failed: string[] = [];
  let examined = 0; // transcripts read, or seen to be too old or empty
  const fail = (what: string, err: unknown) => {
    if (!isMissing(err)) failed.push(`${what}: ${(err as Error).message}`); // missing: removed since it was listed
  };
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return []; // no Claude history on this Mac
    throw new Error(`Couldn't read Claude's conversations in ${CLAUDE_PROJECTS}: ${(err as Error).message}`);
  }
  const cutoff = Date.now() - IMPORT_WINDOW_MS;

  for (const dir of projectDirs) {
    if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
    const full = path.join(CLAUDE_PROJECTS, dir.name);
    let files: string[];
    try {
      files = fs.readdirSync(full).filter((f) => f.endsWith(".jsonl"));
    } catch (err) {
      fail(full, err);
      continue;
    }
    for (const f of files) {
      const fp = path.join(full, f);
      let stat: fs.Stats;
      let parsed: ReturnType<typeof parseHead>;
      try {
        stat = fs.statSync(fp);
        parsed = stat.mtimeMs < cutoff || stat.size === 0 ? null : parseHead(fp);
      } catch (err) {
        fail(fp, err);
        continue;
      }
      examined++;
      if (!parsed) continue;
      if (!fs.existsSync(parsed.cwd)) continue; // worktree/repo deleted since
      out.push({
        sessionId: parsed.sessionId ?? path.basename(f, ".jsonl"),
        cwd: parsed.cwd,
        title: parsed.title,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  if (failed.length) {
    if (!examined) throw new Error(`Couldn't read Claude's conversations: ${failed.join("; ")}`);
    console.warn(`[import] left out Claude conversations that couldn't be read: ${failed.join("; ")}`);
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, IMPORT_LIMIT);
}

/** A transcript's session, folder and title, from its first lines; null when they name no folder. Unreadable throws. */
function parseHead(fp: string): { sessionId: string | null; cwd: string; title: string } | null {
  const head = readSlice(fp, "start", HEAD_BYTES);

  let cwd: string | null = null;
  let sessionId: string | null = null;
  let summary: string | null = null;
  let firstUserText: string | null = null;

  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // last line may be truncated by HEAD_BYTES
    }
    if (obj.type === "summary" && typeof obj.summary === "string" && !summary) summary = obj.summary;
    if (typeof obj.cwd === "string" && !cwd) cwd = obj.cwd;
    if (typeof obj.sessionId === "string" && !sessionId) sessionId = obj.sessionId;
    if (obj.type === "user" && !firstUserText) {
      const c = obj.message?.content;
      let text: string | null = null;
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) {
        const t = c.find((p: any) => p.type === "text" && typeof p.text === "string");
        if (t) text = t.text;
      }
      if (text && isRealPrompt(text)) firstUserText = text;
    }
    if (cwd && sessionId && (summary || firstUserText)) break;
  }

  if (!cwd) return null;
  return { sessionId, cwd, title: importTitle(cwd, summary, firstUserText) };
}
