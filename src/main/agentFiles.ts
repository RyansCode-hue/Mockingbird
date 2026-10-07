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
export function* codexRollouts(limit = Infinity, root = CODEX_SESSIONS): Generator<string> {
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
    for (const y of ls(root))
      for (const m of ls(path.join(root, y)))
        for (const d of ls(path.join(root, y, m)))
          for (const f of ls(path.join(root, y, m, d))) {
            if (!f.endsWith(".jsonl")) continue;
            if (n >= limit) return;
            n++;
            yield path.join(root, y, m, d, f);
          }
  } finally {
    if (failed.length && n) console.warn(`[codex] left out rollouts in folders that couldn't be listed: ${failed.join("; ")}`);
  }
  if (failed.length && !n) throw new Error(`Couldn't list Codex's sessions: ${failed.join("; ")}`);
}

/**
 * The folder Claude Code keeps a working directory's conversations in: the
 * directory's path with every character but letters and digits made a dash.
 */
export function claudeProjectDir(cwd: string, root = CLAUDE_PROJECTS): string {
  return path.join(root, cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

/** A Claude conversation's transcript: in its working directory's folder when `cwd` is given, else in whichever folder has it. Null when none does. */
export function claudeTranscriptOf(id: string, cwd: string | null, root = CLAUDE_PROJECTS): string | null {
  const name = `${id}.jsonl`;
  if (cwd) {
    for (const dir of new Set([cwd, realpathOr(cwd)])) {
      const f = path.join(claudeProjectDir(dir, root), name);
      if (fs.existsSync(f)) return f;
    }
  }
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch (err) {
    if (isMissing(err)) return null; // no Claude history on this machine
    throw err;
  }
  for (const d of dirs) {
    const f = path.join(root, d, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** A Codex conversation's rollout file, among the newest `limit`; null when none is named for it. */
export function codexRolloutOf(id: string, root = CODEX_SESSIONS, limit = 2000): string | null {
  for (const file of codexRollouts(limit, root)) if (ROLLOUT_NAME_RE.exec(path.basename(file))?.[1] === id) return file;
  return null;
}

/** Where a rollout file named `rollout-<YYYY-MM-DD>T…-<id>.jsonl` belongs: its date's folder. */
export function codexRolloutPath(fileName: string, root = CODEX_SESSIONS): string {
  const m = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(fileName);
  if (!m || !ROLLOUT_NAME_RE.test(fileName)) throw new Error(`"${fileName}" isn't a Codex rollout's name`);
  return path.join(root, m[1], m[2], m[3], fileName);
}

/** The folder with symbolic links resolved (what a process started there sees as its directory), or itself when it can't be. */
export function realpathOr(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch (err) {
    if (isMissing(err)) return dir; // not made yet: nothing to resolve
    throw err;
  }
}

/** A timestamp as epoch ms: an ISO string, or a number in seconds or milliseconds. Null when it isn't one. */
export function epochMs(v: unknown): number | null {
  const n = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
