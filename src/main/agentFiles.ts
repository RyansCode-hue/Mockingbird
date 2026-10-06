import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isMissing } from "./fileOps";

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

/**
 * Codex rollout files, newest first (by their date folders, then name), at
 * most `limit` of them. A folder that isn't there holds none. One that can't
 * be listed is left out and logged; when that leaves nothing at all, it throws.
 */
export function* codexRollouts(limit = Infinity): Generator<string> {
  const failed: string[] = [];
  const ls = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).sort().reverse();
    } catch (err) {
      if (!isMissing(err) && (err as NodeJS.ErrnoException).code !== "ENOTDIR") failed.push(`${dir}: ${(err as Error).message}`);
      return []; // missing, or a stray file where a date folder goes: no rollouts there
    }
  };
  let n = 0;
  try {
    for (const y of ls(CODEX_SESSIONS))
      for (const m of ls(path.join(CODEX_SESSIONS, y)))
        for (const d of ls(path.join(CODEX_SESSIONS, y, m)))
          for (const f of ls(path.join(CODEX_SESSIONS, y, m, d))) {
            if (!f.endsWith(".jsonl")) continue;
            if (n >= limit) return;
            n++;
            yield path.join(CODEX_SESSIONS, y, m, d, f);
          }
  } finally {
    if (failed.length && n) console.warn(`[codex] left out rollouts in folders that couldn't be listed: ${failed.join("; ")}`);
  }
  if (failed.length && !n) throw new Error(`Couldn't list Codex's sessions: ${failed.join("; ")}`);
}

/** A timestamp as epoch ms: an ISO string, or a number in seconds or milliseconds. Null when it isn't one. */
export function epochMs(v: unknown): number | null {
  const n = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
