import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { FIND_BY_DOT_GIT, isRepo } from "./git";
import { gitPinRefusal } from "./gitPins";
import { guardedGit } from "./safeGit";
import type { FileHit, FileList, FileSearch, FileSearchOptions } from "../shared/types";

const MAX_FILES = 50_000;
const MAX_HITS = 2_000;
const SEARCH_TIMEOUT_MS = 20_000;
const MAX_TEXT = 240; // a minified line is cut to a window around its match
/**
 * Dependency and build-output folders: huge, generated, and never opened by
 * name. Listing and searching a folder outside git skips them (and .git), and
 * so does any other walk for the files people edit.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", "vendor", "venv", ".venv", "__pycache__", "dist", "build", "out", "target", "bin", "obj", ".next"]);

/**
 * Every file in a session's folder, relative to it, for ⌘P. In a repository
 * that's what git knows plus untracked files it doesn't ignore; elsewhere a
 * walk that skips hidden folders and dependency/build folders.
 */
export async function listAllFiles(root: string): Promise<FileList> {
  if (await isRepo(root)) {
    const out = await (await guardedGit(root)).run(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { trim: false });
    const files = [...new Set(out.split("\0").filter(Boolean))];
    return { files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
  }
  const files: string[] = [];
  const queue = [""];
  let unreadable = 0;
  while (queue.length && files.length < MAX_FILES) {
    const rel = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!rel || (code !== "EACCES" && code !== "EPERM")) throw err;
      unreadable++; // counted and reported; one locked folder shouldn't hide the rest
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(p);
      } else if (e.isFile()) files.push(p);
    }
  }
  return { files: files.slice(0, MAX_FILES), truncated: files.length >= MAX_FILES || queue.length > 0, unreadable };
}

/** The line, or a window of it around the first match when it's too long to show. */
export function clipLine(text: string, query: string, opts: FileSearchOptions): string {
  if (text.length <= MAX_TEXT) return text;
  let at = -1;
  if (opts.regex) {
    try {
      at = new RegExp(query, opts.matchCase ? "" : "i").exec(text)?.index ?? -1;
    } catch {
      at = -1; // git's regex dialect isn't JavaScript's; the window then starts at the line's start
    }
  } else at = opts.matchCase ? text.indexOf(query) : text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, at - 60);
  return (start > 0 ? "…" : "") + text.slice(start, start + MAX_TEXT) + "…";
}

/** git grep's `path\0line\0text` and grep's `./path\0line:text`, one output line each. */
export function parseGrepLine(line: string, fromGit: boolean): { path: string; line: number; text: string } | null {
  const a = line.indexOf("\0");
  if (a < 0) return null;
  const file = line.slice(0, a);
  const rest = line.slice(a + 1);
  const sep = fromGit ? rest.indexOf("\0") : rest.indexOf(":");
  if (sep < 0) return null;
  const n = parseInt(rest.slice(0, sep), 10);
  if (!Number.isFinite(n)) return null;
  return { path: file.replace(/^\.\//, ""), line: n, text: rest.slice(sep + 1) };
}

/**
 * Search the text of every file in a session's folder (⌘⇧F, Files). git grep in
 * a repository — tracked and untracked files, .gitignore respected — and grep
 * elsewhere. Output is streamed and the search stopped at MAX_HITS matches or
 * SEARCH_TIMEOUT_MS, so a common word in a large repo can't flood the process;
 * `stopped` says when that happened.
 */
export async function searchFiles(root: string, query: string, opts: FileSearchOptions): Promise<FileSearch> {
  if (!query) return { hits: [], files: 0, stopped: null, warning: null };
  const repo = await isRepo(root);
  const mode = opts.regex ? "-E" : "-F";
  const caseFlag = opts.matchCase ? [] : ["-i"];
  const [cmd, args] = repo
    ? ["git", [...FIND_BY_DOT_GIT, "-C", root, "grep", "-n", "-I", "--untracked", "--no-color", "-z", ...caseFlag, mode, "-e", query]]
    : ["grep", ["-rnIs", "--null", ...caseFlag, mode, ...[".git", ...SKIP_DIRS].map((d) => `--exclude-dir=${d}`), "-e", query, "--", "."]];
  // started here, not through git.ts, so held to a room session's git folders here (gitPins.ts), as it starts
  const pinned = repo ? gitPinRefusal(root) : null;
  if (pinned) throw new Error(`git grep: ${pinned}`);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd as string, args as string[], { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const hits: FileHit[] = [];
    const files = new Set<string>();
    let stopped: FileSearch["stopped"] = null;
    let buf = "";
    let stderr = "";
    const stop = (why: "limit" | "time") => {
      if (stopped) return;
      stopped = why;
      child.kill();
    };
    const timer = setTimeout(() => stop("time"), SEARCH_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stopped) return;
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const hit = parseGrepLine(buf.slice(0, nl), repo);
        buf = buf.slice(nl + 1);
        if (!hit) continue;
        files.add(hit.path);
        hits.push({ ...hit, text: clipLine(hit.text, query, opts) });
        if (hits.length >= MAX_HITS) return stop("limit");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // 0: matches, 1: none; anything else is an error unless we stopped it ourselves
      if (stopped || code === 0 || code === 1) return resolve({ hits, files: files.size, stopped, warning: stderr.trim() || null });
      const why = stderr.trim() || `${cmd} exited with ${code}`;
      if (hits.length) return resolve({ hits, files: files.size, stopped, warning: why });
      reject(new Error(why.replace(/^fatal: /, "")));
    });
  });
}
