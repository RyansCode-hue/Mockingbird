import * as fs from "fs";
import * as path from "path";
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

/** Files under `root` matching a glob, walked from the glob's literal folder. */
function matchGlob(root: string, glob: string): string[] {
  const re = globToRegex(glob);
  const literal = glob.slice(0, glob.search(/[*?]/));
  const start = literal.includes("/") ? literal.slice(0, literal.lastIndexOf("/")) : "";
  const named = new Set(glob.split("/"));
  const out: string[] = [];
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
      if (++seen > MAX_WALK) return;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) || named.has(e.name)) walk(p);
      } else if (re.test(p)) out.push(p);
    }
  };
  walk(start);
  return out;
}

export interface PrepareCopy {
  copied: string[];
  kept: string[];
  missing: string[];
}

/**
 * Copy the files a worktree needs but git doesn't carry (env files, local
 * certs) from the main checkout. A file the worktree already has is kept — it
 * may have been changed on purpose. Paths are checked to stay inside both folders.
 */
export function copyPrepared(main: string, worktree: string, patterns: string[]): PrepareCopy {
  const res: PrepareCopy = { copied: [], kept: [], missing: [] };
  if (path.resolve(main) === path.resolve(worktree)) return res; // the main checkout already has them
  for (const pat of patterns) {
    if (path.isAbsolute(pat) || pat.split("/").includes("..")) throw new Error(`"${pat}" must be a path inside the repository`);
    const files = isGlob(pat) ? matchGlob(main, pat) : fs.existsSync(path.join(main, pat)) ? [pat] : [];
    if (!files.length) {
      res.missing.push(pat);
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
