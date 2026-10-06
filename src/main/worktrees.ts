import type { WorktreeCleanupMode, WorktreeCleanupResult, WorktreeEntry, WorktreeStateInfo } from "../shared/types";
import { branchesOf, currentBranch, git, originUrl, pickDefaultBase, upstreamOf } from "./git";
import { dirtyFileCount } from "./scm";
import * as fs from "fs";
import * as path from "path";

/** Worktrees live in one folder beside the repos: `<parent>/worktrees/<repo>/<branch>`. */
export function worktreeRoot(repoPath: string): string {
  return path.join(path.dirname(repoPath), "worktrees", path.basename(repoPath));
}
/** The earlier layout, `<parent>/<repo>-worktrees/<branch>` — still read, never written. */
export function legacyWorktreeRoot(repoPath: string): string {
  return path.join(path.dirname(repoPath), `${path.basename(repoPath)}-worktrees`);
}

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Whether origin has `branch`, asked of origin itself: remote-tracking refs are
 * only as fresh as the last fetch, and a branch pushed since must be checked
 * out, not made anew. When origin can't be reached the last fetch has to do (logged).
 */
async function onOrigin(repo: string, branch: string): Promise<boolean> {
  if (!(await originUrl(repo))) return false;
  try {
    // exit 2: origin has no such branch
    return !!(await git(repo, ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`], { okCodes: [0, 2], timeoutMs: PROBE_TIMEOUT_MS }));
  } catch (err) {
    console.error(`[worktrees] couldn't ask origin about ${branch}, going by the last fetch:`, err);
    return !!(await git(repo, ["branch", "-r", "--list", `origin/${branch}`]));
  }
}

/** A branch that exists already, or one to create from `from` (HEAD when unset), tracking it when `track`. */
type StartPoint = { existing: true } | { existing: false; track: boolean; from?: string };

/**
 * Where a session's branch comes from, for a worktree or a checkout:
 *  - branch exists locally → itself
 *  - branch exists on origin only → fetch it and track it
 *  - new branch + base → fetch origin/<base> first and branch off it
 *    (falls back to the local base if the fetch fails, e.g. offline)
 *  - new branch, no base → branch off the repo's current HEAD
 */
async function startPoint(repo: string, branch: string, base?: string): Promise<StartPoint> {
  if (await git(repo, ["branch", "--list", branch])) return { existing: true };
  if (await onOrigin(repo, branch)) {
    await git(repo, ["fetch", "origin", branch]);
    return { existing: false, track: true, from: `origin/${branch}` };
  }
  if (!base) return { existing: false, track: false };
  try {
    await git(repo, ["fetch", "origin", base]); // freshest dev/uat
    return { existing: false, track: false, from: `origin/${base}` };
  } catch (err) {
    // offline or no origin — fall back to the local base branch, loudly
    if (!(await git(repo, ["branch", "--list", base]))) throw err;
    console.error(`[worktrees] fetch origin/${base} failed, branching off local ${base}:`, err);
    return { existing: false, track: false, from: base };
  }
}

/** Create a worktree for a session on `branch`, made as startPoint says. Returns the worktree path. */
export async function createWorktree(repoPath: string, branch: string, baseBranch?: string): Promise<string> {
  // a branch can only be checked out once: if the old layout already holds it,
  // keep using that checkout rather than failing on `worktree add`
  const legacy = path.join(legacyWorktreeRoot(repoPath), branch);
  if (fs.existsSync(legacy)) return legacy;
  const wtRoot = worktreeRoot(repoPath);
  fs.mkdirSync(wtRoot, { recursive: true });
  const wtPath = path.join(wtRoot, branch);
  if (fs.existsSync(wtPath)) return wtPath; // reuse (multiple sessions per task)

  const sp = await startPoint(repoPath, branch, baseBranch);
  await git(
    repoPath,
    sp.existing
      ? ["worktree", "add", wtPath, branch]
      : ["worktree", "add", ...(sp.track ? ["--track"] : []), "-b", branch, wtPath, ...(sp.from ? [sp.from] : [])]
  );
  return wtPath;
}

/** Local + origin branches for a repo, with a best-guess dev/uat base branch. */
export async function listBranches(repoPath: string): Promise<{ branches: string[]; defaultBase: string | null }> {
  const { local, origin } = await branchesOf(repoPath);
  const branches = [...new Set([...origin, ...local])].sort();
  return { branches, defaultBase: pickDefaultBase(branches) };
}

/** `git diff --shortstat`'s " 3 files changed, 120 insertions(+), 8 deletions(-)". */
export function parseShortstat(out: string): { insertions: number; deletions: number } {
  return {
    insertions: parseInt(/(\d+) insertions?\(\+\)/.exec(out)?.[1] ?? "0", 10),
    deletions: parseInt(/(\d+) deletions?\(-\)/.exec(out)?.[1] ?? "0", 10),
  };
}

async function readState(wtPath: string): Promise<WorktreeStateInfo> {
  const [dirtyFiles, branch, { upstream, counts }, stat] = await Promise.all([
    dirtyFileCount(wtPath),
    currentBranch(wtPath).then((b) => b ?? "HEAD"),
    // what the counts are against (a branch made from origin/dev tracks it until
    // published), then "<behind> <ahead>" in one call — nothing to count without one
    upstreamOf(wtPath).then(async (upstream) => ({
      upstream,
      counts: upstream ? await git(wtPath, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]) : "0 0",
    })),
    // before the first commit there's no HEAD to diff against: nothing to count yet
    git(wtPath, ["diff", "--shortstat", "HEAD"]).catch((err: Error) => {
      if (/bad revision|unknown revision|ambiguous argument 'HEAD'/i.test(err.message)) return "";
      throw err;
    }),
  ]);
  const [behind, ahead] = counts.split(/\s+/).map((n) => parseInt(n, 10) || 0);
  return { dirty: dirtyFiles > 0, dirtyFiles, branch, upstream, ahead: ahead ?? 0, behind: behind ?? 0, ...parseShortstat(stat) };
}

const STATE_TTL_MS = 3_000;

/** Drop a folder's cached state — its files just changed, so the next read must be fresh. */
export function forgetState(wtPath: string): void {
  stateCache.delete(wtPath);
}
const stateCache = new Map<string, { at: number; state: Promise<WorktreeStateInfo> }>();

/**
 * A worktree's git state, shared: every pane in a folder polls it, so calls
 * while a read is running — or within a few seconds of one — get that read
 * instead of starting another round of git processes. A failed read isn't kept.
 */
export function worktreeState(wtPath: string): Promise<WorktreeStateInfo> {
  const hit = stateCache.get(wtPath);
  if (hit && Date.now() - hit.at < STATE_TTL_MS) return hit.state;
  const state = readState(wtPath);
  stateCache.set(wtPath, { at: Date.now(), state });
  state.catch(() => {
    if (stateCache.get(wtPath)?.state === state) stateCache.delete(wtPath);
  });
  return state;
}

/**
 * Close-session worktree cleanup (design 1e).
 *  - keep:    leave the worktree untouched
 *  - push:    commit WIP if dirty, push the branch, then remove the worktree
 *  - discard: remove the worktree and delete its branch — not recoverable
 */
export async function cleanupWorktree(repoPath: string, wtPath: string, mode: WorktreeCleanupMode): Promise<WorktreeCleanupResult> {
  if (mode === "keep") return { removed: false };

  const st = await readState(wtPath); // fresh: this decides what gets committed or deleted
  stateCache.delete(wtPath);
  if (mode === "push") {
    if (st.dirty) {
      await git(wtPath, ["add", "-A"]);
      await git(wtPath, ["commit", "--no-verify", "-m", `WIP: ${st.branch} (closed from Mockingbird)`]);
    }
    await git(wtPath, ["push", "-u", "origin", "HEAD"]);
    await git(repoPath, ["worktree", "remove", "--force", wtPath]);
    return { removed: true };
  }

  // discard
  await git(repoPath, ["worktree", "remove", "--force", wtPath]);
  if (st.branch === "HEAD") return { removed: true, branchKept: "The worktree wasn't on a branch (detached HEAD), so no branch was deleted" };
  try {
    await git(repoPath, ["branch", "-D", st.branch]);
  } catch (err) {
    // e.g. the branch is checked out in another folder too
    console.error(`[worktrees] removed ${wtPath} but kept branch ${st.branch}:`, err);
    return { removed: true, branchKept: `${st.branch} wasn't deleted: ${(err as Error).message}` };
  }
  return { removed: true };
}

/**
 * Checkouts under a worktree root, as paths relative to it. A branch like
 * `fix/login` nests a folder, so a directory without a `.git` entry is
 * descended into rather than reported. An unreadable root means that layout has
 * no folder for the repo.
 */
function findCheckouts(wtRoot: string, rel = "", depth = 0): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(wtRoot, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  if (rel && entries.some((e) => e.name === ".git")) return [rel];
  if (depth >= 4) return rel ? [rel] : []; // too deep to be a branch path — report it as-is
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .flatMap((e) => findCheckouts(wtRoot, rel ? path.join(rel, e.name) : e.name, depth + 1));
}

/**
 * Every checkout under the given repos' worktree roots, in both layouts, with
 * enough state to decide whether it is a stray: branch, dirt, ahead/behind,
 * age, and whether a live session currently runs in it. A folder that is not
 * a readable git worktree is reported with `error` rather than skipped.
 */
export async function listWorktrees(repos: { name: string; path: string }[], liveCwds: string[]): Promise<WorktreeEntry[]> {
  const live = new Set(liveCwds);
  const found: { repo: { name: string; path: string }; wtPath: string; name: string; legacy: boolean }[] = [];
  for (const repo of repos) {
    for (const [wtRoot, legacy] of [[worktreeRoot(repo.path), false], [legacyWorktreeRoot(repo.path), true]] as const) {
      for (const name of findCheckouts(wtRoot)) found.push({ repo, wtPath: path.join(wtRoot, name), name, legacy });
    }
  }
  const out = await inBatches(found, 6, async ({ repo, wtPath, name, legacy }): Promise<WorktreeEntry> => {
    let ageDays = 0;
    try {
      ageDays = Math.floor((Date.now() - fs.statSync(wtPath).mtimeMs) / 86_400_000);
    } catch {
      /* keep 0 */
    }
    const base = { repoPath: repo.path, repoName: repo.name, path: wtPath, name, ageDays, inUse: live.has(wtPath), legacy };
    try {
      const st = await worktreeState(wtPath);
      return { ...base, branch: st.branch, dirty: st.dirty, dirtyFiles: st.dirtyFiles, ahead: st.ahead, behind: st.behind };
    } catch (err) {
      return { ...base, branch: "", dirty: false, dirtyFiles: 0, ahead: 0, behind: 0, error: err instanceof Error ? err.message.split("\n")[0] : String(err) };
    }
  });
  return out.sort((a, b) => a.repoName.localeCompare(b.repoName) || b.ageDays - a.ageDays);
}

/** fn over items, `size` at a time — a janitor scan of many worktrees shouldn't start hundreds of gits at once. */
async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/** Remove a worktree folder (the branch is kept). */
export async function removeWorktree(repoPath: string, wtPath: string): Promise<void> {
  await git(repoPath, ["worktree", "remove", "--force", wtPath]);
  await git(repoPath, ["worktree", "prune"]);
  stateCache.delete(wtPath);
}

/**
 * Check a branch out in the repo checkout itself (no worktree), so VS Code
 * debug/launch configs on the repo just work. Refuses loudly when the checkout
 * cannot safely switch: uncommitted changes, or another live session already
 * on a different branch there (a checkout has one branch at a time — that is
 * the one thing worktrees exist to solve). The branch is made as startPoint says.
 */
export async function checkoutBranch(repoPath: string, branch: string, baseBranch?: string, occupiedBy?: string): Promise<void> {
  if (occupiedBy) {
    throw new Error(
      `${path.basename(repoPath)} is already checked out on ${occupiedBy} by a running session. ` +
        `Close that session, or tick "isolated worktree" to work on both at once.`
    );
  }
  const current = await currentBranch(repoPath);
  if (current === branch) return;
  const n = await dirtyFileCount(repoPath);
  if (n) {
    throw new Error(
      `${path.basename(repoPath)} has ${n} uncommitted change${n === 1 ? "" : "s"} on ${current ?? "a detached HEAD"}. ` +
        `Commit or stash before switching to ${branch}, or tick "isolated worktree".`
    );
  }
  const sp = await startPoint(repoPath, branch, baseBranch);
  await git(repoPath, sp.existing ? ["switch", branch] : ["switch", ...(sp.track ? ["--track"] : []), "-c", branch, ...(sp.from ? [sp.from] : [])]);
}

/** Move an old-layout worktree into `worktrees/<repo>/`; returns its new path. */
export async function migrateWorktree(repoPath: string, oldPath: string): Promise<string> {
  const legacyRoot = legacyWorktreeRoot(repoPath);
  const rel = path.relative(legacyRoot, oldPath); // keeps a `fix/` prefix intact
  if (!rel || rel.startsWith("..")) throw new Error(`${oldPath} is not under ${legacyRoot}`);
  const dest = path.join(worktreeRoot(repoPath), rel);
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await git(repoPath, ["worktree", "move", oldPath, dest]);
  // drop folders the move emptied, up to and including <repo>-worktrees
  for (let dir = path.dirname(oldPath); dir.startsWith(legacyRoot); dir = path.dirname(dir)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      break; // other worktrees still live there
    }
  }
  return dest;
}
