import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Where the agent CLIs keep their files, and how to read their timestamps.
 * A module of its own so that everything reading those files (agents, usage,
 * hooks, the importer) can share it without importing each other.
 */

/** Claude Code's transcripts: one folder per working directory, one .jsonl per conversation. */
export const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");
export const CLAUDE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
export const CODEX_DIR = path.join(os.homedir(), ".codex");
/** Codex's rollouts, filed by date: YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<conversation id>.jsonl */
export const CODEX_SESSIONS = path.join(CODEX_DIR, "sessions");
export const ROLLOUT_NAME_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;

/** Codex rollout files, newest first (by their date folders, then name), at most `limit` of them. */
export function* codexRollouts(limit = Infinity): Generator<string> {
  const ls = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).sort().reverse();
    } catch {
      return []; // no Codex history (yet) at this level
    }
  };
  let n = 0;
  for (const y of ls(CODEX_SESSIONS))
    for (const m of ls(path.join(CODEX_SESSIONS, y)))
      for (const d of ls(path.join(CODEX_SESSIONS, y, m)))
        for (const f of ls(path.join(CODEX_SESSIONS, y, m, d))) {
          if (!f.endsWith(".jsonl")) continue;
          if (n++ >= limit) return;
          yield path.join(CODEX_SESSIONS, y, m, d, f);
        }
}

/** A timestamp as epoch ms: an ISO string, or a number in seconds or milliseconds. Null when it isn't one. */
export function epochMs(v: unknown): number | null {
  const n = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
