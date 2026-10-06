import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseNameStatus } from "./files";
import { git, headCommit, repoTop } from "./git";
import { SNAPSHOT_MAX_FILE_BYTES, type TurnChange, type TurnSnapshot } from "../shared/types";

/**
 * Undo an agent's turn. When a prompt is submitted, the worktree's files are
 * recorded as a commit under refs/mockingbird/snapshots/<session>/<n>, built
 * with a temporary index: the branch, the real index and the history are
 * never touched. Gitignored files aren't recorded, nor any file over
 * SNAPSHOT_MAX_FILE_BYTES (named in the snapshot so the user knows). Git stores only what changed, so
 * a turn costs a few KB. The last 10 per session are kept.
 */
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

/** A throwaway index, removed once `fn` is done with it. */
async function withIndex<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const file = path.join(os.tmpdir(), `mb-snapshot-${crypto.randomBytes(6).toString("hex")}.index`);
  try {
    return await fn({ GIT_INDEX_FILE: file, ...IDENTITY });
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

/** The worktree's files as a tree object, leaving out ignored files and big ones (which are returned). */
async function treeOfWorktree(top: string, env: Record<string, string>): Promise<{ tree: string; skipped: string[] }> {
  await seedIndex(top, env.GIT_INDEX_FILE);
  const changed = (await git(top, ["ls-files", "-z", "-m", "-o", "--exclude-standard"], { env, trim: false })).split("\0").filter(Boolean);
  const skipped: string[] = [];
  for (const f of changed) {
    const st = await fs.promises.stat(path.join(top, f)).catch(() => null); // deleted files have nothing to measure
    if (st && st.isFile() && st.size > SNAPSHOT_MAX_FILE_BYTES) skipped.push(f);
  }
  await git(top, ["add", "-A", "--", ".", ...skipped.map((f) => `:(exclude,literal)${f}`)], { env });
  return { tree: await git(top, ["write-tree"], { env }), skipped };
}

function parseMessage(body: string): { prompt: string; skipped: string[] } {
  const prompt = /^prompt: ([\s\S]*?)(?:\nskipped: |$)/m.exec(body)?.[1]?.trim() ?? "";
  const skipped = /^skipped: (.*)$/m.exec(body)?.[1];
  return { prompt, skipped: skipped ? JSON.parse(skipped) : [] };
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
      return { n: Number(ref.split("/").pop()), sha, at: Number(at) * 1000, prompt: meta.prompt, skipped: meta.skipped, beforeUndo: meta.prompt === BEFORE_UNDO };
    })
    .filter((s) => Number.isFinite(s.n))
    .sort((a, b) => b.n - a.n);
}

/**
 * Record the worktree before a turn. Returns null outside a git repository.
 * Calls for one session run one after another, whichever of its folders they
 * name: each numbers its snapshot from the ones before it.
 */
const queues = new Map<string, Promise<unknown>>();
export function takeSnapshot(cwd: string, sessionId: string, prompt: string): Promise<TurnSnapshot | null> {
  const run = (queues.get(sessionId) ?? Promise.resolve()).then(() => snapshotNow(cwd, sessionId, prompt));
  // the chain only orders the calls; each caller still gets its own failure from `run`
  const tail = run.catch(() => {});
  queues.set(sessionId, tail);
  void tail.then(() => {
    if (queues.get(sessionId) === tail) queues.delete(sessionId);
  });
  return run;
}

async function snapshotNow(cwd: string, sessionId: string, prompt: string): Promise<TurnSnapshot | null> {
  const top = await repoTop(cwd);
  if (!top) return null;
  const id = safeId(sessionId);
  const prior = await listSnapshots(top, id);
  const latest = prior[0];
  return withIndex(async (env) => {
    const { tree, skipped } = await treeOfWorktree(top, env);
    const message = [`Mockingbird: the files before a turn of session ${id}`, "", `prompt: ${prompt.replace(/\s+/g, " ").slice(0, 300)}`, ...(skipped.length ? [`skipped: ${JSON.stringify(skipped)}`] : [])].join("\n");
    const parent = latest?.sha ?? (await headCommit(top));
    const sha = await git(top, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], { env });
    const n = (latest?.n ?? 0) + 1;
    await git(top, ["update-ref", `${REF_ROOT}/${id}/${n}`, sha]);
    for (const old of [{ n, sha }, ...prior].slice(KEEP)) await git(top, ["update-ref", "-d", `${REF_ROOT}/${id}/${old.n}`]);
    return { n, sha, at: Date.now(), prompt: prompt.trim(), skipped, beforeUndo: prompt === BEFORE_UNDO };
  });
}

/** What restoring a snapshot would do to the worktree as it is now. */
export async function changesSince(cwd: string, sessionId: string, n: number): Promise<TurnChange[]> {
  const top = await repoTop(cwd);
  if (!top) throw new Error("Not a git repository");
  const snap = (await listSnapshots(top, sessionId)).find((s) => s.n === n);
  if (!snap) throw new Error("That snapshot is gone");
  const tree = await withIndex(async (env) => (await treeOfWorktree(top, env)).tree);
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
 * changed.
 */
export async function restoreSnapshot(cwd: string, sessionId: string, n: number): Promise<{ restored: number; removed: number; undo: TurnSnapshot | null }> {
  const top = await repoTop(cwd);
  if (!top) throw new Error("Not a git repository");
  const snap = (await listSnapshots(top, sessionId)).find((s) => s.n === n);
  if (!snap) throw new Error("That snapshot is gone");
  const undo = await takeSnapshot(top, sessionId, BEFORE_UNDO);
  if (!undo) throw new Error("Couldn't record the files before restoring");
  const changes = await diffTrees(top, snap.sha, undo.sha);
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
      await git(top, ["read-tree", snap.sha], { env });
      // a file can't be written where a folder of ignored files now stands
      for (const p of restore) await clearWay(top, p);
      // in batches, so a long list can't overflow the command line
      for (let i = 0; i < restore.length; i += 200) await git(top, ["checkout-index", "-f", "--", ...restore.slice(i, i + 200)], { env });
    });
  }
  return { restored: restore.length, removed: remove.length, undo };
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
  for (const s of await listSnapshots(top, sessionId)) await git(top, ["update-ref", "-d", `${REF_ROOT}/${safeId(sessionId)}/${s.n}`]);
}
