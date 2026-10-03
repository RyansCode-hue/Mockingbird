import type { WorktreeCleanupMode, WorktreeEntry } from "../shared/types";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

const LOCAL_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 120_000; // fetch / push over a slow VPN

/**
 * git, off the main thread. This process also carries every pane's keystrokes,
 * so a slow repo or remote must never block it. No terminal prompts: a remote
 * that wants a password fails instead of hanging.
 */
function git(repo: string, args: string[]): Promise<string> {
  const timeout = args[0] === "fetch" || args[0] === "push" ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS;
  return new Promise((resolve, reject) =>
    execFile(
      "git",
      ["-C", repo, ...args],
      { encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout.trim());
        const why = err.killed ? `timed out after ${timeout / 1000}s` : (stderr || err.message).trim();
        reject(new Error(`git ${args.join(" ")} (in ${repo}): ${why}`));
      }
    )
  );
}

/** Worktrees live in one folder beside the repos: `<parent>/worktrees/<repo>/<branch>`. */
export function worktreeRoot(repoPath: string): string {
  return path.join(path.dirname(repoPath), "worktrees", path.basename(repoPath));
}
/** The earlier layout, `<parent>/<repo>-worktrees/<branch>` — still read, never written. */
export function legacyWorktreeRoot(repoPath: string): string {
  return path.join(path.dirname(repoPath), `${path.basename(repoPath)}-worktrees`);
}

/**
 * Create a worktree for a session. Returns the worktree path.
 *  - branch exists locally → check it out in the worktree
 *  - branch exists on origin only → fetch it and track it
 *  - new branch + baseBranch → fetch origin/<base> first and branch off it
 *    (falls back to the local base if the fetch fails, e.g. offline)
 *  - new branch, no base → branch off the repo's current HEAD (legacy behavior)
 */
export async function createWorktree(repoPath: string, branch: string, baseBranch?: string): Promise<string> {
  // a branch can only be checked out once: if the old layout already holds it,
  // keep using that checkout rather than failing on `worktree add`
  const legacy = path.join(legacyWorktreeRoot(repoPath), branch);
  if (fs.existsSync(legacy)) return legacy;
  const wtRoot = worktreeRoot(repoPath);
  fs.mkdirSync(wtRoot, { recursive: true });
  const wtPath = path.join(wtRoot, branch);
  if (fs.existsSync(wtPath)) return wtPath; // reuse (multiple sessions per task)

  const hasLocal = (await git(repoPath, ["branch", "--list", branch])).length > 0;
  const hasRemote = (await git(repoPath, ["branch", "-r", "--list", `origin/${branch}`])).length > 0;

  if (hasLocal) {
    await git(repoPath, ["worktree", "add", wtPath, branch]);
  } else if (hasRemote) {
    await git(repoPath, ["fetch", "origin", branch]);
    await git(repoPath, ["worktree", "add", "--track", "-b", branch, wtPath, `origin/${branch}`]);
  } else if (baseBranch) {
    let base = `origin/${baseBranch}`;
    try {
      await git(repoPath, ["fetch", "origin", baseBranch]); // freshest dev/uat
    } catch (err) {
      // offline or no origin — fall back to the local base branch, loudly
      if ((await git(repoPath, ["branch", "--list", baseBranch])).length === 0) throw err;
      console.error(`[worktrees] fetch origin/${baseBranch} failed, branching off local ${baseBranch}:`, err);
      base = baseBranch;
    }
    await git(repoPath, ["worktree", "add", "-b", branch, wtPath, base]);
  } else {
    await git(repoPath, ["worktree", "add", "-b", branch, wtPath]);
  }
  return wtPath;
}

/** The integration branch new work usually starts from, by team convention. */
export function pickDefaultBase(branches: string[]): string | null {
  const preferred = ["dev", "develop", "development", "uat", "main", "master"];
  return preferred.find((b) => branches.includes(b)) ?? null;
}

/** Local + origin branches for a repo, with a best-guess dev/uat base branch. */
export async function listBranches(repoPath: string): Promise<{ branches: string[]; defaultBase: string | null }> {
  const locals = (await git(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]))
    .split("\n")
    .filter(Boolean);
  const remotes = (await git(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]))
    .split("\n")
    .filter(Boolean)
    .map((b) => b.replace(/^origin\//, ""))
    .filter((b) => b !== "HEAD");
  const branches = [...new Set([...remotes, ...locals])].sort();
  return { branches, defaultBase: pickDefaultBase(branches) };
}

export interface WorktreeState {
  dirty: boolean;
  dirtyFiles: number;
  branch: string;
  ahead: number;
  behind: number;
}

async function readState(wtPath: string): Promise<WorktreeState> {
  const [porcelain, branch, counts] = await Promise.all([
    git(wtPath, ["status", "--porcelain"]),
    git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    // "<behind> <ahead>" in one call; fails when the branch has no upstream
    git(wtPath, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]).catch(() => "0 0"),
  ]);
  const dirtyFiles = porcelain ? porcelain.split("\n").length : 0;
  const [behind, ahead] = counts.split(/\s+/).map((n) => parseInt(n, 10) || 0);
  return { dirty: dirtyFiles > 0, dirtyFiles, branch, ahead: ahead ?? 0, behind: behind ?? 0 };
}

export const STATE_TTL_MS = 3_000;
const stateCache = new Map<string, { at: number; state: Promise<WorktreeState> }>();

/**
 * A worktree's git state, shared: every pane in a folder polls it, so calls
 * while a read is running — or within a few seconds of one — get that read
 * instead of starting another round of git processes. A failed read isn't kept.
 */
export function worktreeState(wtPath: string): Promise<WorktreeState> {
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
export async function cleanupWorktree(repoPath: string, wtPath: string, mode: WorktreeCleanupMode): Promise<{ removed: boolean }> {
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
  try {
    await git(repoPath, ["branch", "-D", st.branch]);
  } catch {
    /* branch may be checked out elsewhere or already gone */
  }
  return { removed: true };
}

/**
 * Every `<repo>-worktrees/<name>` checkout beside the given repos, with enough
 * state to decide whether it is a stray: branch, dirt, ahead/behind, age, and
 * whether a live session currently runs in it. A folder that is not a readable
 * git worktree is reported with `error` rather than skipped.
 */
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
 * the one thing worktrees exist to solve).
 *  - branch exists locally → switch to it
 *  - branch exists on origin only → fetch and track it
 *  - new branch → fetch origin/<base> (dev/uat) and branch off it; falls back
 *    to the local base if the fetch fails
 */
export async function checkoutBranch(repoPath: string, branch: string, baseBranch?: string, occupiedBy?: string): Promise<void> {
  if (occupiedBy) {
    throw new Error(
      `${path.basename(repoPath)} is already checked out on ${occupiedBy} by a running session. ` +
        `Close that session, or tick "isolated worktree" to work on both at once.`
    );
  }
  const current = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current === branch) return;
  const dirty = await git(repoPath, ["status", "--porcelain"]);
  if (dirty) {
    const n = dirty.split("\n").length;
    throw new Error(
      `${path.basename(repoPath)} has ${n} uncommitted change${n === 1 ? "" : "s"} on ${current}. ` +
        `Commit or stash before switching to ${branch}, or tick "isolated worktree".`
    );
  }
  const hasLocal = (await git(repoPath, ["branch", "--list", branch])).length > 0;
  const hasRemote = (await git(repoPath, ["branch", "-r", "--list", `origin/${branch}`])).length > 0;
  if (hasLocal) {
    await git(repoPath, ["switch", branch]);
  } else if (hasRemote) {
    await git(repoPath, ["fetch", "origin", branch]);
    await git(repoPath, ["switch", "--track", "-c", branch, `origin/${branch}`]);
  } else if (baseBranch) {
    let base = `origin/${baseBranch}`;
    try {
      await git(repoPath, ["fetch", "origin", baseBranch]);
    } catch (err) {
      if ((await git(repoPath, ["branch", "--list", baseBranch])).length === 0) throw err;
      console.error(`[worktrees] fetch origin/${baseBranch} failed, branching off local ${baseBranch}:`, err);
      base = baseBranch;
    }
    await git(repoPath, ["switch", "-c", branch, base]);
  } else {
    await git(repoPath, ["switch", "-c", branch]);
  }
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
