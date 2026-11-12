import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseNameStatus } from "./files";
import { git, headCommit, repoTop } from "./git";
import { guardedGit, keptByFilters, OWN_WRITE_ENV, roomFilters, withFiltersOff } from "./safeGit";
import { SNAPSHOT_MAX_FILE_BYTES, type TurnChange, type TurnSnapshot } from "../shared/types";

/**
 * Undo an agent's turn. When a prompt is submitted, the worktree's files are
 * recorded as a commit under refs/mockingbird/snapshots/<session>/<n>, built
 * with a temporary index: the branch, the real index and the history are
 * never touched. Gitignored files aren't recorded, nor any file over
 * SNAPSHOT_MAX_FILE_BYTES (named in the snapshot so the user knows). Git stores only what changed, so
 * a turn costs a few KB. The last 10 per session are kept.
 *
 * `room`: a team room session's folder, which its agent writes. Its snapshot gits (each turn's, take-over's backups
 * and copies, an Undo's) run nothing its agent could have named: refused, with no snapshot, when the repository's
 * config comes partly from a file the agent can write, and with every filter driver but git-lfs's turned off
 * (roomFilters). A changed file one of those filters keeps is left out, and named (`filtered`), as a big file is:
 * stored without its filter it would be stored unfiltered, a git-crypt file's plaintext in a snapshot that take-over's
 * backups push.
 */

/** Asked of a snapshot function for a team room session's folder (see above). */
export interface RoomSnapshot {
  room?: boolean;
}

/** The filter drivers a snapshot in `top` turns off: none for a local session's folder, roomFilters' (which refuses config its agent can write) for a room session's. */
const filtersOffFor = async (top: string, o: RoomSnapshot): Promise<string[] | null> => (o.room ? roomFilters(top) : null);
const REF_ROOT = "refs/mockingbird/snapshots";
export const KEEP = 10;
const BEFORE_UNDO = "(before an undo)";

const IDENTITY = {
  GIT_AUTHOR_NAME: "Mockingbird",
  GIT_AUTHOR_EMAIL: "mockingbird@localhost",
  GIT_COMMITTER_NAME: "Mockingbird",
  GIT_COMMITTER_EMAIL: "mockingbird@localhost",
};

const safeId = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error(`"${id}" isn't a session id`);
  return id;
};

/**
 * A throwaway index, removed once `fn` is done with it. Its gits write, on Mockingbird's own, so they run with
 * OWN_WRITE_ENV, and with filter drivers `filtersOff` turned off (filtersOffFor's).
 */
async function withIndex<T>(fn: (env: Record<string, string>) => Promise<T>, filtersOff: readonly string[] | null = null): Promise<T> {
  const file = path.join(os.tmpdir(), `mb-snapshot-${crypto.randomBytes(6).toString("hex")}.index`);
  const env = { ...OWN_WRITE_ENV, GIT_INDEX_FILE: file, ...IDENTITY };
  try {
    return await fn(filtersOff ? withFiltersOff(env, filtersOff) : env);
  } finally {
    await fs.promises.rm(file, { force: true });
  }
}

/**
 * Start a temporary index as a copy of the repository's own. Its stat data lets
 * `ls-files -m` and `add -A` pass over every file unchanged since git last
 * looked, so only what changed is read and hashed. git rereads any entry as
 * new as the index file itself ("racily clean"), so the copy is dated a second
 * before the original: that can only make git check more, never less.
 */
async function seedIndex(top: string, file: string): Promise<void> {
  const real = path.resolve(top, await git(top, ["rev-parse", "--git-path", "index"]));
  // dated before copying: an index rewritten in between is then checked more, not less
  const st = await fs.promises.stat(real).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null; // nothing added yet in a new repository: start empty
    throw err;
  });
  if (!st) return;
  await fs.promises.copyFile(real, file);
  const earlier = (st.mtimeMs - 1000) / 1000;
  await fs.promises.utimes(file, earlier, earlier);
}

/**
 * The worktree's files as a tree object, leaving out ignored files and big ones
 * (which are returned). Files `secrets` (pathspecs) matches are never taken
 * from the worktree or the index: they are as commit `base` has them, or
 * absent when it has none (or there's no `base`). So a secret that is only
 * staged, or edited since `base`, never reaches the tree, and a diff against
 * `base` never shows one. With `filtersOff` (a room session's folder: `env`
 * has them off), a changed file one of them keeps is left out too, as the
 * index has it (`filtered`); its deletion is recorded, having no content.
 */
async function treeOfWorktree(
  top: string,
  env: Record<string, string>,
  secrets: string[] = [],
  base: string | null = null,
  filtersOff: readonly string[] | null = null
): Promise<{ tree: string; skipped: string[]; filtered: string[] }> {
  await seedIndex(top, env.GIT_INDEX_FILE);
  const notSecret = secrets.map(excluding);
  const changed = (await git(top, ["ls-files", "-z", "-m", "-o", "--exclude-standard", "--", ".", ...notSecret], { env, trim: false })).split("\0").filter(Boolean);
  const skipped: string[] = [];
  const there: string[] = [];
  for (const f of changed) {
    const st = await fs.promises.stat(path.join(top, f)).catch(() => null); // deleted files have nothing to measure
    if (st && st.isFile() && st.size > SNAPSHOT_MAX_FILE_BYTES) skipped.push(f);
    else if (st) there.push(f);
  }
  const filtered = filtersOff ? (await keptByFilters(top, there, filtersOff)).map((k) => k.file) : [];
  await git(top, ["add", "-A", "--", ".", ...[...skipped, ...filtered].map((f) => `:(exclude,literal)${f}`), ...notSecret], { env });
  // the index was seeded from the repository's, so its secrets are still whatever was staged there
  if (secrets.length) {
    if (base) await git(top, ["reset", "-q", base, "--", ...secrets], { env });
    else await git(top, ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", ...secrets], { env });
  }
  return { tree: await git(top, ["write-tree"], { env }), skipped, filtered };
}

/** What a snapshot's message says it left out: `skipped` (too big) and `filtered` (kept through a filter a room's git turns off), each a line when there are any. */
const leftOutLines = (o: { skipped: string[]; filtered: string[] }): string[] => [
  ...(o.skipped.length ? [`skipped: ${JSON.stringify(o.skipped)}`] : []),
  ...(o.filtered.length ? [`filtered: ${JSON.stringify(o.filtered)}`] : []),
];

/** A pathspec, plain or with long-form magic such as `:(glob)`, as one that excludes what it matches. */
const excluding = (spec: string) => (spec.startsWith(":(") ? `:(exclude,${spec.slice(2)}` : `:(exclude)${spec}`);

export interface WorktreeSnapshot {
  sha: string;
  tree: string;
  /** HEAD when it was taken: the snapshot's parent. Null before the first commit. */
  parent: string | null;
  skipped: string[];
  /** Left out for a filter a room's git turns off (`room`). */
  filtered: string[];
}

/**
 * The worktree's files as a commit on top of HEAD, under no ref (the caller
 * names it): the branch, the index and the history are untouched. Ignored and
 * big files are left out, as for Undo turn, and for `room` the files a
 * turned-off filter keeps; files `secrets` matches are as HEAD has them. Null
 * outside a git repository.
 */
export async function snapshotCommit(cwd: string, message: string, opts: { secrets?: string[] } & RoomSnapshot = {}): Promise<WorktreeSnapshot | null> {
  const top = await repoTop(cwd);
  if (!top) return null;
  const off = await filtersOffFor(top, opts);
  return withIndex(async (env) => {
    const parent = await headCommit(top);
    const { tree, skipped, filtered } = await treeOfWorktree(top, env, opts.secrets, parent, off);
    const left = leftOutLines({ skipped, filtered });
    const body = [message, ...(left.length ? ["", ...left] : [])].join("\n");
    const sha = await git(top, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", body], { env });
    return { sha, tree, parent, skipped, filtered };
  }, off);
}

/**
 * The worktree's files as a tree object (ignored and big files left out, and
 * for `room` the files a turned-off filter keeps; files `secrets` matches as
 * commit `base` has them, HEAD by default), without making a commit or
 * touching the index. Null outside a git repository.
 */
export async function worktreeTree(
  cwd: string,
  opts: { secrets?: string[]; base?: string } & RoomSnapshot = {}
): Promise<{ top: string; tree: string; skipped: string[]; filtered: string[] } | null> {
  const top = await repoTop(cwd);
  if (!top) return null;
  const base = opts.base ?? (await headCommit(top));
  const off = await filtersOffFor(top, opts);
  return withIndex(async (env) => ({ top, ...(await treeOfWorktree(top, env, opts.secrets, base, off)) }), off);
}

/**
 * The worktree's files as a commit on top of `parent` (any commit, not
 * necessarily HEAD), under no ref: its diff against `parent` is what the
 * worktree changed since. Ignored and big files are left out, and for `room`
 * the files a turned-off filter keeps; files `secrets` matches are as
 * `parent` has them, so the diff never shows one.
 */
export async function worktreeCommitOn(cwd: string, parent: string, message: string, opts: { secrets?: string[] } & RoomSnapshot = {}): Promise<WorktreeSnapshot> {
  const top = await repoTop(cwd);
  if (!top) throw new Error(`${cwd} isn't in a git repository`);
  const off = await filtersOffFor(top, opts);
  return withIndex(async (env) => {
    const { tree, skipped, filtered } = await treeOfWorktree(top, env, opts.secrets, parent, off);
    const left = leftOutLines({ skipped, filtered });
    const body = [message, ...(left.length ? ["", ...left] : [])].join("\n");
    const sha = await git(top, ["commit-tree", tree, "-p", parent, "-m", body], { env });
    return { sha, tree, parent, skipped, filtered };
  }, off);
}

/** The files a snapshot commit left out (from its message): too big, and kept through a filter a room's git turns off. */
export async function leftOutIn(cwd: string, sha: string): Promise<{ skipped: string[]; filtered: string[] }> {
  const { skipped, filtered } = parseMessage(await (await guardedGit(cwd)).run(["show", "-s", "--format=%B", sha]));
  return { skipped, filtered };
}

/**
 * Make the worktree's files those of snapshot commit `sha` (from any
 * repository sharing these objects): changed and deleted files come back, new
 * ones go. The index, branch and history are untouched, so files the snapshot
 * adds show as untracked and its edits as unstaged changes against HEAD.
 * Ignored files aren't touched. For `room` (a take-over's copy), with no
 * filter but git-lfs's run: a file another keeps is written as it's stored.
 */
export async function checkoutSnapshotFiles(cwd: string, sha: string, opts: RoomSnapshot = {}): Promise<{ restored: number; removed: number }> {
  const top = await repoTop(cwd);
  if (!top) throw new Error(`${cwd} isn't in a git repository`);
  const off = await filtersOffFor(top, opts);
  const now = await withIndex(async (env) => (await treeOfWorktree(top, env, [], null, off)).tree, off);
  return putFiles(top, sha, await diffTrees(top, sha, now), off);
}

function parseMessage(body: string): { prompt: string; skipped: string[]; filtered: string[] } {
  const prompt = /^prompt: ([\s\S]*?)(?:\nskipped: |$)/m.exec(body)?.[1]?.trim() ?? "";
  const skipped = /^skipped: (.*)$/m.exec(body)?.[1];
  const filtered = /^filtered: (.*)$/m.exec(body)?.[1];
  return { prompt, skipped: skipped ? JSON.parse(skipped) : [], filtered: filtered ? JSON.parse(filtered) : [] };
}

/** A session's snapshots, newest first. */
export async function listSnapshots(cwd: string, sessionId: string): Promise<TurnSnapshot[]> {
  const top = await repoTop(cwd);
  if (!top) return [];
  const out = await git(top, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(creatordate:unix)%00%(contents)%01", `${REF_ROOT}/${safeId(sessionId)}/`], { trim: false });
  return out
    .split("\x01")
    .map((rec) => rec.replace(/^\n/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [ref, sha, at, body] = rec.split("\0");
      const meta = parseMessage(body ?? "");
      return { n: Number(ref.split("/").pop()), sha, at: Number(at) * 1000, prompt: meta.prompt, skipped: meta.skipped, filtered: meta.filtered, beforeUndo: meta.prompt === BEFORE_UNDO };
    })
    .filter((s) => Number.isFinite(s.n))
    .sort((a, b) => b.n - a.n);
}

/**
 * Record the worktree before a turn. Returns null outside a git repository.
 * Calls for one session run one after another, whichever of its folders they
 * name: each numbers its snapshot from the ones before it. For `room`, as the
 * top of this file says: refused with no snapshot, or with files left out.
 */
const queues = new Map<string, Promise<unknown>>();
export function takeSnapshot(cwd: string, sessionId: string, prompt: string, opts: RoomSnapshot = {}): Promise<TurnSnapshot | null> {
  const run = (queues.get(sessionId) ?? Promise.resolve()).then(() => snapshotNow(cwd, sessionId, prompt, opts));
  // the chain only orders the calls; each caller still gets its own failure from `run`
  const tail = run.catch(() => {});
  queues.set(sessionId, tail);
  void tail.then(() => {
    if (queues.get(sessionId) === tail) queues.delete(sessionId);
  });
  return run;
}

/**
 * A turn's snapshot (takeSnapshot), its failure kept in `errors` under the session for the pane's Undo turn to say,
 * and cleared by the next one that works. A failure is logged with the session id once per cause: a refusal that
 * stands (a room session's config) fails every turn the same way.
 */
export function snapshotTurn(
  cwd: string,
  sessionId: string,
  prompt: string,
  opts: RoomSnapshot,
  errors: Map<string, string>,
  log: (context: string, err: unknown) => void
): Promise<void> {
  return takeSnapshot(cwd, sessionId, prompt, opts).then(
    () => void errors.delete(sessionId),
    (err) => {
      const why = err instanceof Error ? err.message : String(err);
      if (errors.get(sessionId) !== why) log(`snapshot ${sessionId}`, err);
      errors.set(sessionId, why);
    }
  );
}

async function snapshotNow(cwd: string, sessionId: string, prompt: string, opts: RoomSnapshot): Promise<TurnSnapshot | null> {
  const top = await repoTop(cwd);
  if (!top) return null;
  const id = safeId(sessionId);
  const off = await filtersOffFor(top, opts);
  const prior = await listSnapshots(top, id);
  const latest = prior[0];
  return withIndex(async (env) => {
    const { tree, skipped, filtered } = await treeOfWorktree(top, env, [], null, off);
    const message = [`Mockingbird: the files before a turn of session ${id}`, "", `prompt: ${prompt.replace(/\s+/g, " ").slice(0, 300)}`, ...leftOutLines({ skipped, filtered })].join("\n");
    const parent = latest?.sha ?? (await headCommit(top));
    const sha = await git(top, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], { env });
    const n = (latest?.n ?? 0) + 1;
    await git(top, ["update-ref", `${REF_ROOT}/${id}/${n}`, sha], { env: OWN_WRITE_ENV });
    for (const old of [{ n, sha }, ...prior].slice(KEEP)) await git(top, ["update-ref", "-d", `${REF_ROOT}/${id}/${old.n}`], { env: OWN_WRITE_ENV });
    return { n, sha, at: Date.now(), prompt: prompt.trim(), skipped, filtered, beforeUndo: prompt === BEFORE_UNDO };
  }, off);
}

/** What restoring a snapshot would do to the worktree as it is now (`room`: built as its snapshots are). */
export async function changesSince(cwd: string, sessionId: string, n: number, opts: RoomSnapshot = {}): Promise<TurnChange[]> {
  const top = await repoTop(cwd);
  if (!top) throw new Error("Not a git repository");
  const snap = (await listSnapshots(top, sessionId)).find((s) => s.n === n);
  if (!snap) throw new Error("That snapshot is gone");
  const off = await filtersOffFor(top, opts);
  const tree = await withIndex(async (env) => (await treeOfWorktree(top, env, [], null, off)).tree, off);
  return diffTrees(top, snap.sha, tree);
}

/** Files that differ: "restore" (changed or deleted since — its old content comes back) or "remove" (new since). */
async function diffTrees(top: string, from: string, to: string): Promise<TurnChange[]> {
  const out = await git(top, ["diff", "--no-renames", "--name-status", "-z", from, to], { trim: false });
  return parseNameStatus(out).map((c) => ({ path: c.path, action: c.status === "A" ? "remove" : "restore" }));
}

/**
 * Put the worktree's files back as snapshot `n` had them. The current state is
 * snapshotted first, so the restore can itself be undone. The index, branch
 * and history are untouched; ignored files and skipped big files aren't
 * changed. For `room`, nothing is restored when a file to put back is kept
 * through a filter a room's git turns off: it would be written as it's stored.
 */
export async function restoreSnapshot(cwd: string, sessionId: string, n: number, opts: RoomSnapshot = {}): Promise<{ restored: number; removed: number; undo: TurnSnapshot | null }> {
  const top = await repoTop(cwd);
  if (!top) throw new Error("Not a git repository");
  const snap = (await listSnapshots(top, sessionId)).find((s) => s.n === n);
  if (!snap) throw new Error("That snapshot is gone");
  const off = await filtersOffFor(top, opts);
  const refuseKept = async (changes: TurnChange[]): Promise<void> => {
    const [kept] = off ? await keptByFilters(top, changes.filter((c) => c.action === "restore").map((c) => c.path), off) : [];
    if (kept) {
      throw new Error(
        `Nothing was restored: ${kept.file} is kept through the "${kept.filter}" filter, which Mockingbird doesn't run for a team room session's git, as a filter runs as you, from the working tree the session's agent writes, and can load code from there. Without it, ${kept.file} would be written back as it's stored.`
      );
    }
  };
  // before the undo's own snapshot, so a refusal leaves none in the list; again after it, for files changed meanwhile
  if (off) await refuseKept(await diffTrees(top, snap.sha, await withIndex(async (env) => (await treeOfWorktree(top, env, [], null, off)).tree, off)));
  const undo = await takeSnapshot(top, sessionId, BEFORE_UNDO, opts);
  if (!undo) throw new Error("Couldn't record the files before restoring");
  const changes = await diffTrees(top, snap.sha, undo.sha);
  await refuseKept(changes);
  return { ...(await putFiles(top, snap.sha, changes, off)), undo };
}

/** Apply `changes` (from diffTrees(top, sha, now)): restore files from `sha`, remove the ones it doesn't have; with filter drivers `filtersOff` turned off. */
async function putFiles(top: string, sha: string, changes: TurnChange[], filtersOff: readonly string[] | null = null): Promise<{ restored: number; removed: number }> {
  const restore = changes.filter((c) => c.action === "restore").map((c) => c.path);
  const remove = changes.filter((c) => c.action === "remove").map((c) => c.path);
  // removals first: a file that took its folder's place (a/b became a) is gone before the folder comes back
  for (const p of remove) {
    const full = path.join(top, p);
    if (!full.startsWith(top + path.sep)) continue;
    await fs.promises.rm(full, { force: true });
    await pruneEmptyDirs(top, path.dirname(full));
  }
  if (restore.length) {
    await withIndex(async (env) => {
      await git(top, ["read-tree", sha], { env });
      // a file can't be written where a folder of ignored files now stands
      for (const p of restore) await clearWay(top, p);
      // in batches, so a long list can't overflow the command line
      for (let i = 0; i < restore.length; i += 200) await git(top, ["checkout-index", "-f", "--", ...restore.slice(i, i + 200)], { env });
    }, filtersOff);
  }
  return { restored: restore.length, removed: remove.length };
}

async function clearWay(top: string, rel: string): Promise<void> {
  const full = path.join(top, rel);
  const st = await fs.promises.lstat(full).catch(() => null);
  if (st?.isDirectory()) await fs.promises.rm(full, { recursive: true, force: true });
}

async function pruneEmptyDirs(top: string, dir: string): Promise<void> {
  for (let d = dir; d.startsWith(top + path.sep); d = path.dirname(d)) {
    const entries = await fs.promises.readdir(d).catch(() => null);
    if (!entries || entries.length) return;
    // tidying only: a folder that can't go stays, and the restore has already succeeded
    await fs.promises.rmdir(d).catch(() => {});
  }
}

/** Drop a closed session's snapshots. */
export async function dropSnapshots(cwd: string, sessionId: string): Promise<void> {
  const top = await repoTop(cwd);
  if (!top) return;
  for (const s of await listSnapshots(top, sessionId)) await git(top, ["update-ref", "-d", `${REF_ROOT}/${safeId(sessionId)}/${s.n}`], { env: OWN_WRITE_ENV });
}
