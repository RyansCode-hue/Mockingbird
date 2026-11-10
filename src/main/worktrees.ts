import type { WorktreeCleanupMode, WorktreeCleanupResult, WorktreeEntry, WorktreeStateInfo } from "../shared/types";
import { branchesOf, currentBranch, git, isAncestor, isRepo, originUrl, pickDefaultBase, upstreamOf } from "./git";
import { dirtyFileCount } from "./scm";
import { guardedGit, ownFetch, ownNetworkGit, WRITE_ENV } from "./safeGit";
import { unpinGitDirs } from "./gitPins";
import * as fs from "fs";
import * as path from "path";

/**
 * Says what a worktree or checkout was made from when origin couldn't be asked or fetched from, and it went by what
 * was last fetched or by a local branch instead: shown in the session's pane (sessions.ts). The git that failed is in
 * main's log already (ownNetworkGit).
 */
export type Warn = (text: string) => void;
const warnInConsole: Warn = (text) => console.warn(`[worktrees] ${text}`);
const why = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();

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
 * out, not made anew. When origin can't be reached the last fetch has to do
 * (logged), and `unreachable` says so.
 */
async function onOrigin(repo: string, branch: string, warn: Warn): Promise<{ has: boolean; unreachable: boolean }> {
  if (!(await originUrl(repo))) return { has: false, unreachable: false };
  try {
    // exit 2: origin has no such branch
    return { has: !!(await ownNetworkGit(repo, "ls-remote", ["--exit-code", "--heads", "origin", `refs/heads/${branch}`], { okCodes: [0, 2], timeoutMs: PROBE_TIMEOUT_MS })), unreachable: false };
  } catch (err) {
    warn(`Origin couldn't be asked whether it has ${branch}, so this went by what was last fetched: ${why(err)}`);
    return { has: !!(await git(repo, ["branch", "-r", "--list", `origin/${branch}`])), unreachable: true };
  }
}

/** Whether the last fetch kept origin's `branch`. */
const lastFetched = async (repo: string, branch: string): Promise<boolean> => !!(await git(repo, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`], { okCodes: [0, 1] }));

/** A branch that exists already, or one to create from `from` (HEAD when unset), tracking it when `track`. */
type StartPoint = { existing: true } | { existing: false; track: boolean; from?: string };

/**
 * Where a session's branch comes from, for a worktree or a checkout:
 *  - branch exists locally → itself
 *  - branch exists on origin only → fetch it and track it
 *  - new branch + base → fetch origin/<base> first and branch off it
 *    (falls back to the local base if the fetch fails, e.g. offline)
 *  - new branch, no base → branch off the repo's current HEAD
 * With `mustExist` (a relaunch, which makes a session's worktree again) the branch is never made anew: one origin no
 * longer has, or one it can't be fetched from, comes from what the last fetch kept of it (origin/<branch>), and with
 * none of that it throws, so the session isn't resumed on a branch holding none of its work: saying to try again when
 * it's origin that didn't answer, as the branch may well be there.
 */
async function startPoint(repo: string, branch: string, base: string | undefined, mustExist: boolean, warn: Warn): Promise<StartPoint> {
  if (await git(repo, ["branch", "--list", branch])) return { existing: true };
  const there = await onOrigin(repo, branch, warn);
  if (there.has) {
    if (!mustExist) await ownFetch(repo, ["origin", branch]);
    // origin just didn't answer: a fetch would only wait out its timeout to fail, and the last fetch's ref is there
    else if (!there.unreachable) {
      try {
        await ownFetch(repo, ["origin", branch]);
      } catch (err) {
        if (!(await lastFetched(repo, branch))) throw err;
        warn(`${branch} couldn't be fetched from origin, so it's as it was last fetched: ${why(err)}`);
      }
    }
    return { existing: false, track: true, from: `origin/${branch}` };
  }
  if (mustExist) {
    // with no origin remote there's nothing to track, and --track would refuse the ref
    if (await lastFetched(repo, branch)) return { existing: false, track: !!(await originUrl(repo)), from: `origin/${branch}` };
    if (there.unreachable) throw new Error(`Its branch, ${branch}, isn't here, and origin couldn't be reached to check for it: try again when you're online`);
    throw new Error(`Its branch, ${branch}, isn't here or on origin any more: start fresh`);
  }
  if (!base) return { existing: false, track: false };
  try {
    await ownFetch(repo, ["origin", base]); // freshest dev/uat
    return { existing: false, track: false, from: `origin/${base}` };
  } catch (err) {
    // offline or no origin — fall back to the local base branch, loudly
    if (!(await git(repo, ["branch", "--list", base]))) throw err;
    warn(`origin/${base} couldn't be fetched, so ${branch} was branched off the local ${base}, which may be behind origin's: ${why(err)}`);
    return { existing: false, track: false, from: base };
  }
}

/**
 * Whether anything is at `p`. One that can't be looked at (a folder above it unreadable, a volume in trouble) throws
 * rather than reading as gone, as fs.existsSync's false would: what follows acts on a folder being gone.
 */
function folderThere(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}

/** `p` as git lists it: symlinks in what's there of it resolved, the rest as it is. */
function realOf(p: string): string {
  const parent = path.dirname(p);
  if (fs.existsSync(p)) return fs.realpathSync(p);
  return parent === p ? p : path.join(realOf(parent), path.basename(p));
}

/**
 * The branch out in `folder` when it's a checkout of its own: null for one that isn't (a plain folder, even inside
 * another repository) or whose HEAD is detached.
 */
async function branchIn(folder: string): Promise<string | null> {
  if (!(await isRepo(folder))) return null;
  if (realOf(await git(folder, ["rev-parse", "--show-toplevel"])) !== realOf(folder)) return null;
  return currentBranch(folder);
}

/**
 * Unregister the worktree git lists at `wtPath` when its folder was deleted outside git (Finder, rm), so one can be
 * added there again: `worktree add` refuses a path still registered. Only that one: `worktree prune` would also
 * unregister worktrees on volumes that aren't connected. And only when git itself calls that exact path prunable, as
 * `worktree remove` deletes a folder that's there, the files git ignores (a .env) with it: one that's locked or there
 * is left, and `worktree add` says why it can't.
 */
export async function unregisterMissing(repo: string, wtPath: string): Promise<void> {
  const real = realOf(wtPath);
  const entries = (await git(repo, ["worktree", "list", "--porcelain"])).split("\n\n").map((block) => block.split("\n"));
  const entry = entries.find((lines) => lines[0] === `worktree ${wtPath}` || lines[0] === `worktree ${real}`);
  if (!entry?.some((l) => l === "prunable" || l.startsWith("prunable "))) return;
  const listed = entry[0].slice("worktree ".length);
  console.warn(`[worktrees] ${listed} was deleted outside git but still registered: unregistering it to add it again`);
  await git(repo, ["worktree", "remove", listed]);
}

/** The latest createWorktree for each folder: the next for that folder waits for it (oneAtATime). */
const making = new Map<string, Promise<unknown>>();

/** `run` once what's under way for `key` has ended, however that went (its caller hears of a failure). */
function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const go = () => run();
  const result = (making.get(key) ?? Promise.resolve()).then(go, go);
  const ended = result.then(
    () => undefined,
    () => undefined
  );
  making.set(key, ended);
  void ended.then(() => {
    if (making.get(key) === ended) making.delete(key);
  });
  return result;
}

/**
 * Create a worktree for a session on `branch`, made as startPoint says (`mustExist`: a relaunch, which never makes
 * the branch anew), at the usual place or, with `at`, at that folder (a relaunch's own, whatever it's called). Returns
 * its path. A folder that's there is reused only if it's a checkout of `branch`: a session never runs in a folder on
 * another branch. One folder's are made one at a time: the next finds it made and reuses it. `warn` hears what it
 * went by when origin couldn't be asked or fetched from.
 */
export async function createWorktree(repoPath: string, branch: string, baseBranch?: string, opts: { mustExist?: boolean; at?: string; warn?: Warn } = {}): Promise<string> {
  const target = opts.at ?? path.join(worktreeRoot(repoPath), branch);
  return oneAtATime(target, async () => {
    // a branch can only be checked out once: if the old layout already holds it,
    // keep using that checkout rather than failing on `worktree add`
    if (!opts.at) {
      const legacy = path.join(legacyWorktreeRoot(repoPath), branch);
      if (fs.existsSync(legacy) && (await branchIn(legacy)) === branch) return legacy;
    }
    if (folderThere(target)) {
      const out = await branchIn(target);
      if (out === branch) return target; // reuse (multiple sessions per task)
      throw new Error(`${target} is there, ${out ? `on ${out}` : "but isn't a checkout of a branch"}, so a session on ${branch} can't run in it: move it, or start fresh`);
    }
    await unregisterMissing(repoPath, target);
    // a room session's earlier worktree here was held to its own git folder: this one has another
    unpinGitDirs(target);

    const sp = await startPoint(repoPath, branch, baseBranch, !!opts.mustExist, opts.warn ?? warnInConsole);
    // worktree add makes the folders above it, so a refusal leaves nothing behind
    await git(
      repoPath,
      sp.existing
        ? ["worktree", "add", target, branch]
        : ["worktree", "add", ...(sp.track ? ["--track"] : []), "-b", branch, target, ...(sp.from ? [sp.from] : [])]
    );
    return target;
  });
}

/**
 * A fresh worktree at commit `base`, to continue a session from another
 * laptop: on `branch` when that's free here — absent, or checked out nowhere
 * and at or behind `base` (then moved up to it) — else on `<branch>-takeover`
 * (then -takeover-2, …), so no local work is ever moved or lost. Detached when
 * `branch` is null. The folder is always new.
 */
export async function worktreeAt(repoPath: string, branch: string | null, base: string): Promise<{ path: string; branch: string | null; renamedFrom: string | null }> {
  const root = worktreeRoot(repoPath);
  const freshFolder = (name: string): string => {
    for (let i = 1; ; i++) {
      const p = path.join(root, i === 1 ? name : `${name}-${i}`);
      if (!p.startsWith(root + path.sep)) throw new Error(`"${name}" can't name a worktree folder`);
      if (!fs.existsSync(p)) return p;
    }
  };
  if (!branch) {
    const p = freshFolder(`takeover-${base.slice(0, 8)}`);
    await git(repoPath, ["worktree", "add", "--detach", p, base]);
    return { path: p, branch: null, renamedFrom: null };
  }
  await git(repoPath, ["check-ref-format", "--branch", branch]); // throws on a name git won't take
  const checkedOut = new Set(
    (await git(repoPath, ["worktree", "list", "--porcelain"]))
      .split("\n")
      .filter((l) => l.startsWith("branch refs/heads/"))
      .map((l) => l.slice("branch refs/heads/".length))
  );
  for (let i = 0; ; i++) {
    const name = i === 0 ? branch : i === 1 ? `${branch}-takeover` : `${branch}-takeover-${i}`;
    const tip = await git(repoPath, ["rev-parse", "--verify", "-q", `refs/heads/${name}`], { okCodes: [0, 1] });
    if (tip && (checkedOut.has(name) || !(await isAncestor(repoPath, tip, base)))) continue; // in use, or holds commits `base` lacks
    const p = freshFolder(name);
    if (!tip) await git(repoPath, ["worktree", "add", "-b", name, p, base]);
    else {
      if (tip !== base) await git(repoPath, ["branch", "-f", name, base]);
      await git(repoPath, ["worktree", "add", p, name]);
    }
    return { path: p, branch: name, renamedFrom: name === branch ? null : branch };
  }
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

/** Promise.all that lets every one settle before it throws the first failure, so no git is left running behind it. */
async function allSettledOrThrow<T extends unknown[] | []>(ps: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const rs = await Promise.allSettled(ps as readonly Promise<unknown>[]);
  for (const r of rs) if (r.status === "rejected") throw r.reason;
  return rs.map((r) => (r as PromiseFulfilledResult<unknown>).value) as T;
}

async function readState(wtPath: string): Promise<WorktreeStateInfo> {
  const [dirtyFiles, branch, { upstream, counts }, stat] = await allSettledOrThrow([
    dirtyFileCount(wtPath),
    currentBranch(wtPath).then((b) => b ?? "HEAD"),
    // what the counts are against (a branch made from origin/dev tracks it until
    // published), then "<behind> <ahead>" in one call — nothing to count without one
    upstreamOf(wtPath).then(async (upstream) => ({
      upstream,
      counts: upstream ? await git(wtPath, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]) : "0 0",
    })),
    // before the first commit there's no HEAD to diff against: nothing to count yet
    guardedGit(wtPath).then((g) => g.diff(["--shortstat", "HEAD"])).catch((err: Error) => {
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
      await git(wtPath, ["add", "-A"], { env: WRITE_ENV });
      await git(wtPath, ["commit", "--no-verify", "-m", `WIP: ${st.branch} (closed from Mockingbird)`], { env: WRITE_ENV });
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
  stateCache.delete(wtPath);
}

/**
 * Check a branch out in the repo checkout itself (no worktree), so VS Code
 * debug/launch configs on the repo just work. Refuses loudly when the checkout
 * cannot safely switch: uncommitted changes, or another live session already
 * on a different branch there (a checkout has one branch at a time — that is
 * the one thing worktrees exist to solve). The branch is made as startPoint says.
 */
export async function checkoutBranch(repoPath: string, branch: string, baseBranch?: string, occupiedBy?: string, warn: Warn = warnInConsole): Promise<void> {
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
  const sp = await startPoint(repoPath, branch, baseBranch, false, warn);
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
