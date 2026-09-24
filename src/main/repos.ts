import * as fs from "fs";
import * as path from "path";
import { RepoEntry } from "../shared/types";
import { expandHome } from "./store";

const SKIP = new Set(["node_modules", ".git", "dist", "build", "Library", ".Trash", "worktrees"]);

/** Scan configured roots (depth <= 3) for git repos. */
export function indexRepos(roots: string[]): RepoEntry[] {
  const found: RepoEntry[] = [];
  for (const rootRaw of roots) {
    const root = expandHome(rootRaw);
    if (!fs.existsSync(root)) continue;
    walk(root, root, 0, found);
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

function walk(root: string, dir: string, depth: number, out: RepoEntry[]): void {
  if (depth > 3) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.name === ".git")) {
    // skip worktree checkouts (their .git is a file pointing at the main repo)
    const gitPath = path.join(dir, ".git");
    const isWorktree = fs.statSync(gitPath).isFile();
    if (!isWorktree) out.push({ path: dir, name: path.basename(dir), root });
    return; // don't descend into repos
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name)) continue;
    if (e.name.endsWith("-worktrees")) continue;
    walk(root, path.join(dir, e.name), depth + 1, out);
  }
}
