import * as fs from "fs";
import * as path from "path";
import { ImportableConversation } from "../shared/types";
import { CLAUDE_PROJECTS } from "./agentFiles";
import { readSlice } from "./fileOps";
import { IMPORT_LIMIT, IMPORT_WINDOW_MS, importTitle, isRealPrompt } from "./transcripts";

const HEAD_BYTES = 128 * 1024;

/**
 * List recent Claude Code conversations from ~/.claude/projects — frontend-agnostic,
 * so sessions started in cmux (or a bare terminal) show up too. Each can be reopened
 * with `claude --resume <sessionId>` in its original cwd.
 */
export function listClaudeConversations(): ImportableConversation[] {
  const out: ImportableConversation[] = [];
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(CLAUDE_PROJECTS);
  } catch {
    return [];
  }
  const cutoff = Date.now() - IMPORT_WINDOW_MS;

  for (const dir of projectDirs) {
    const full = path.join(CLAUDE_PROJECTS, dir);
    let files: string[];
    try {
      files = fs.readdirSync(full).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const fp = path.join(full, f);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fp);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoff || stat.size === 0) continue;
      const parsed = parseHead(fp);
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
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, IMPORT_LIMIT);
}

function parseHead(fp: string): { sessionId: string | null; cwd: string; title: string } | null {
  let head: string;
  try {
    head = readSlice(fp, "start", HEAD_BYTES);
  } catch {
    return null;
  }

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
