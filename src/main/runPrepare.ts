import * as fs from "fs";
import * as path from "path";
import { insideRepo } from "./runProfile";
import { quote } from "./shell";
import type { RunProfile } from "../shared/types";

// folders a glob walk never enters unless the pattern names them: huge, and never where env files live
const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "bin", "obj", "dist", "build", "__pycache__", ".next", "target"]);
const MAX_WALK = 20_000;

/** `**` crosses folders, `*` and `?` stay within one. */
export function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const isGlob = (p: string) => /[*?]/.test(p);

/**
 * Files and folders under `root` matching a glob, walked from the glob's
 * literal folder; a matching folder is taken whole. `truncated` when the walk
 * gave up after `limit` entries.
 */
function matchGlob(root: string, glob: string, limit: number): { files: string[]; truncated: boolean } {
  const re = globToRegex(glob);
  const literal = glob.slice(0, glob.search(/[*?]/));
  const start = literal.includes("/") ? literal.slice(0, literal.lastIndexOf("/")) : "";
  const named = new Set(glob.split("/"));
  const files: string[] = [];
  let seen = 0;
  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const e of entries) {
      if (++seen > limit) return;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (re.test(p)) files.push(p);
      else if (e.isDirectory() && (!SKIP.has(e.name) || named.has(e.name))) walk(p);
    }
  };
  walk(start);
  return { files, truncated: seen > limit };
}

export interface PrepareCopy {
  copied: string[];
  kept: string[];
  missing: string[];
  /** Globs whose search gave up in a folder too large to finish (what it found before is copied). */
  truncated: string[];
}

/**
 * Copy the files a worktree needs but git doesn't carry (env files, local
 * certs) from the main checkout. A file the worktree already has is kept — it
 * may have been changed on purpose. Paths are checked to stay inside both folders.
 * A glob's search looks at no more than `limit` entries.
 */
export function copyPrepared(main: string, worktree: string, patterns: string[], limit = MAX_WALK): PrepareCopy {
  const res: PrepareCopy = { copied: [], kept: [], missing: [], truncated: [] };
  if (path.resolve(main) === path.resolve(worktree)) return res; // the main checkout already has them
  for (const pat of patterns) {
    if (!insideRepo(pat)) throw new Error(`"${pat}" must be a path inside the repository`);
    const { files, truncated } = isGlob(pat) ? matchGlob(main, pat, limit) : { files: fs.existsSync(path.join(main, pat)) ? [pat] : [], truncated: false };
    if (truncated) res.truncated.push(pat);
    if (!files.length) {
      if (!truncated) res.missing.push(pat);
      continue;
    }
    for (const rel of files) {
      const dst = path.join(worktree, rel);
      if (fs.existsSync(dst)) {
        res.kept.push(rel);
        continue;
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(path.join(main, rel), dst, { recursive: true, verbatimSymlinks: true });
      res.copied.push(rel);
    }
  }
  return res;
}

/** The setup commands a worktree still needs (their `ifMissing` path is absent), as one shell command; null when none. */
export function setupCommand(worktree: string, prepare: RunProfile["prepare"]): string | null {
  const todo = (prepare?.commands ?? []).filter((c) => !fs.existsSync(path.join(worktree, c.cwd, c.ifMissing)));
  if (!todo.length) return null;
  return todo.map((c) => `(cd ${quote(c.cwd)} && ${c.command})`).join(" && ");
}
