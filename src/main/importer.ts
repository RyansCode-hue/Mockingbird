import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ImportableConversation } from "../shared/types";

const MAX_AGE_DAYS = 30;
const HEAD_BYTES = 128 * 1024;

/**
 * List recent Claude Code conversations from ~/.claude/projects — frontend-agnostic,
 * so sessions started in cmux (or a bare terminal) show up too. Each can be reopened
 * with `claude --resume <sessionId>` in its original cwd.
 */
export function listClaudeConversations(): ImportableConversation[] {
  const root = path.join(os.homedir(), ".claude", "projects");
  const out: ImportableConversation[] = [];
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000;

  for (const dir of projectDirs) {
    const full = path.join(root, dir);
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
  return out.slice(0, 80);
}

/** Skip synthetic/meta messages (caveats, command wrappers) when picking a display title. */
function isRealPrompt(text: string): boolean {
  const t = text.trimStart();
  return !(
    t.startsWith("<") ||
    t.startsWith("Caveat:") ||
    t.startsWith("[Request interrupted") ||
    t.startsWith("This session is being continued")
  );
}

function parseHead(fp: string): { sessionId: string | null; cwd: string; title: string } | null {
  let head: string;
  try {
    const fd = fs.openSync(fp, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    fs.closeSync(fd);
    head = buf.toString("utf8", 0, n);
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
  const title = (summary ?? firstUserText ?? path.basename(cwd)).replace(/\s+/g, " ").trim().slice(0, 70);
  return { sessionId, cwd, title };
}
