import * as fs from "fs";
import * as path from "path";
import { RepoEntry } from "../shared/types";
import { expandHome } from "./store";

// Not find.ts's SKIP_DIRS: a repository can be named bin, out or vendor, and
// the scan must still find it. It skips only what never holds one to work in —
// dependencies, build output, macOS's Library and the worktree folders (each
// checkout there is a branch of a repository already found). Hidden folders,
// .git and .Trash among them, are skipped anyway.
const SKIP = new Set(["node_modules", "dist", "build", "Library", "worktrees"]);

/** A folder the scan couldn't read is skipped, and said so here; the rest of the scan carries on. */
export type SkipReport = (dir: string, err: unknown) => void;

const warnSkip: SkipReport = (dir, err) => console.warn(`[repos] skipped ${dir}: ${err instanceof Error ? err.message : String(err)}`);

/** Scan configured roots (depth <= 3) for git repos. */
export function indexRepos(roots: string[], onSkip: SkipReport = warnSkip): RepoEntry[] {
  const found: RepoEntry[] = [];
  for (const rootRaw of roots) {
    const root = expandHome(rootRaw);
    if (!fs.existsSync(root)) continue;
    walk(root, root, 0, found, onSkip);
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

function walk(root: string, dir: string, depth: number, out: RepoEntry[], onSkip: SkipReport): void {
  if (depth > 3) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    onSkip(dir, err);
    return;
  }
  if (entries.some((e) => e.name === ".git")) {
    // skip worktree checkouts (their .git is a file pointing at the main repo)
    let isWorktree: boolean;
    try {
      isWorktree = fs.statSync(path.join(dir, ".git")).isFile();
    } catch (err) {
      onSkip(dir, err); // a dangling .git link: not a repository git can use
      return;
    }
    if (!isWorktree) out.push({ path: dir, name: path.basename(dir), root });
    return; // don't descend into repos
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name)) continue;
    if (e.name.endsWith("-worktrees")) continue;
    walk(root, path.join(dir, e.name), depth + 1, out, onSkip);
  }
}
