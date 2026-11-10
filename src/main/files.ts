import { baseCandidates, branchesOf, git, MAX_DIFF_BYTES } from "./git";
import * as fs from "fs";
import { applyTextEdits, type LspTextEdit } from "../shared/textEdits";
import { lineBreakOf, splitBom } from "../shared/editorText";
import * as path from "path";
import type { BranchStat, FileEntry, FileContent, FileSave, GitChange, GitChanges, ChangeScope } from "../shared/types";
import { parseShortstat } from "./worktrees";

const MAX_FILE_BYTES = 1_500_000;

/** Is `p` the folder `root` or inside it? Both are compared as resolved paths, so a trailing slash doesn't matter. */
export function inside(root: string, p: string): boolean {
  const r = path.resolve(root);
  const f = path.resolve(p);
  return f === r || f.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * Resolve a worktree-relative path, refusing anything outside the root — both
 * lexically (`../`) and after following symlinks, since reading and listing
 * follow them. A path that doesn't exist yet is only checked lexically; the
 * read that follows reports it missing.
 */
export async function resolveIn(root: string, rel: string): Promise<string> {
  const full = path.resolve(root, rel);
  if (!inside(root, full)) throw new Error(`Path is outside the session folder: ${rel}`);
  let real: string;
  try {
    real = await fs.promises.realpath(full);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return full;
    throw err;
  }
  if (!inside(await fs.promises.realpath(root), real)) {
    throw new Error(`${rel} links outside the session folder (to ${real}) — not shown`);
  }
  return full;
}

export async function listDir(root: string, rel: string): Promise<FileEntry[]> {
  const entries = await fs.promises.readdir(await resolveIn(root, rel), { withFileTypes: true });
  const out: FileEntry[] = [];
  for (const e of entries) {
    if (e.name === ".git" || e.name === ".DS_Store") continue;
    let dir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        dir = (await fs.promises.stat(path.join(root, rel, e.name))).isDirectory();
      } catch {
        dir = false; // dangling link — listed as a file; opening it reports the real error
      }
    }
    out.push({ name: e.name, path: path.join(rel, e.name), dir });
  }
  return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

export async function readFile(root: string, rel: string): Promise<FileContent> {
  const full = await resolveIn(root, rel);
  const stat = await fs.promises.stat(full);
  if (stat.isDirectory()) throw new Error(`${rel} is a folder`);
  const fh = await fs.promises.open(full, "r");
  try {
    const len = Math.min(stat.size, MAX_FILE_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    if (buf.subarray(0, 8000).includes(0)) return { binary: true, size: stat.size, content: "", truncated: false, mtimeMs: stat.mtimeMs };
    return { binary: false, size: stat.size, content: buf.toString("utf8"), truncated: stat.size > len, mtimeMs: stat.mtimeMs };
  } finally {
    await fh.close();
  }
}

/**
 * Save a file edited in the editor. `expectedMtimeMs` is when it was last
 * read: if it has changed since (an agent edited it), nothing is written and
 * the conflict is reported, unless the save is forced. Only existing files
 * inside the folder are written; the write keeps the file's own permissions.
 */
export async function writeFile(root: string, rel: string, content: string, expectedMtimeMs: number | null): Promise<FileSave> {
  const full = await resolveIn(root, rel);
  const stat = await fs.promises.stat(full);
  if (stat.isDirectory()) throw new Error(`${rel} is a folder`);
  if (expectedMtimeMs !== null && Math.abs(stat.mtimeMs - expectedMtimeMs) > 1) return { saved: false, conflict: true, mtimeMs: stat.mtimeMs };
  await fs.promises.writeFile(full, content, "utf8");
  return { saved: true, mtimeMs: (await fs.promises.stat(full)).mtimeMs };
}

/**
 * Apply a language server's edits (a rename) to a file that isn't open in the
 * editor, keeping its line breaks and byte-order mark.
 */
export async function applyFileEdits(root: string, rel: string, edits: LspTextEdit[]): Promise<FileSave> {
  const full = await resolveIn(root, rel);
  const stat = await fs.promises.stat(full);
  const { bom, text } = splitBom(await fs.promises.readFile(full, "utf8"));
  const br = lineBreakOf(text);
  const next = applyTextEdits(text, br === "\n" ? edits : edits.map((e) => ({ ...e, newText: e.newText.replace(/\r?\n/g, br) })));
  return writeFile(root, rel, (bom ? "\ufeff" : "") + next, stat.mtimeMs);
}

// The base branches change rarely; resolving them per poll would re-list every
// ref every few seconds.
const BASE_TTL_MS = 5 * 60_000;
const baseCache = new Map<string, { names: string[]; at: number }>();
/** Per folder, the base picked for the HEAD and base tips it was picked against. */
const pickCache = new Map<string, { key: string; ref: string }>();

async function baseNamesOf(root: string): Promise<string[]> {
  const hit = baseCache.get(root);
  if (hit && Date.now() - hit.at < BASE_TTL_MS) return hit.names;
  const { local, origin } = await branchesOf(root);
  const names = baseCandidates([...local, ...origin]);
  baseCache.set(root, { names, at: Date.now() });
  return names;
}

/**
 * The base branch HEAD's work is measured against, as a ref git can read
 * (origin/<name> when the remote has it, else the local one); null when the
 * repository has none. With several (dev and UAT), the one HEAD forked from
 * last: the fewest commits on HEAD it lacks, ties going to the usual order.
 * Measured against an older base, every commit the newer one gained since
 * reads as the branch's own work.
 */
export async function baseRef(root: string): Promise<string | null> {
  const names = await baseNamesOf(root);
  if (!names.length) return null;
  const full = (n: string) => [`refs/remotes/origin/${n}`, `refs/heads/${n}`];
  const tips = new Map(
    (await git(root, ["for-each-ref", "--format=%(refname) %(objectname)", ...names.flatMap(full)]))
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" ") as [string, string])
  );
  const refs = names.flatMap((n) => {
    const r = full(n).find((x) => tips.has(x));
    return r ? [{ ref: r.startsWith("refs/remotes/") ? `origin/${n}` : n, sha: tips.get(r)! }] : [];
  });
  if (refs.length <= 1) return refs[0]?.ref ?? null;
  const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"], { okCodes: [0, 1] });
  if (!head) return refs[0].ref; // no commits yet
  const key = [head, ...refs.map((r) => `${r.ref}=${r.sha}`)].join(" ");
  const hit = pickCache.get(root);
  if (hit?.key === key) return hit.ref;
  const ahead = await Promise.all(refs.map(async (r) => Number(await git(root, ["rev-list", "--count", `${r.sha}..${head}`]))));
  let best = 0;
  for (let i = 1; i < refs.length; i++) if (ahead[i] < ahead[best]) best = i;
  pickCache.set(root, { key, ref: refs[best].ref });
  return refs[best].ref;
}

/** The commit a "branch" scope compares against: where HEAD forked from the repo's base branch. */
async function branchBase(root: string): Promise<{ sha: string; name: string }> {
  const ref = await baseRef(root);
  if (!ref) throw new Error("No dev/main-style base branch found to compare against");
  try {
    return { sha: await git(root, ["merge-base", "HEAD", ref]), name: ref };
  } catch (err) {
    throw new Error(`Cannot find a common ancestor with ${ref}: ${(err as Error).message}`);
  }
}

/** `git diff --shortstat`'s " 3 files changed, 120 insertions(+), 8 deletions(-)" ("" when nothing changed). */
export function parseShortstatFiles(out: string): { files: number } & ReturnType<typeof parseShortstat> {
  return { files: parseInt(/(\d+) files? changed/.exec(out)?.[1] ?? "0", 10), ...parseShortstat(out) };
}

/** Where HEAD and a base branch are: their commits, and the base as a ref and as it's named. */
interface HeadAndBase {
  head: string;
  tip: string;
  ref: string;
  label: string;
}

/**
 * HEAD and branch `name` in `root`, in one git: origin's `name` when the remote has it, else the local one, as Branch
 * vs base picks; full refs, so a name can't be read as an option. Throws when there's no commit yet, or neither branch.
 */
async function headAndBranch(root: string, name: string): Promise<HeadAndBase> {
  const candidates = [[`refs/remotes/origin/${name}`, `origin/${name}`], [`refs/heads/${name}`, name]] as const;
  // exits 1 when neither branch is there; HEAD is listed all the same
  const out = await git(root, ["show-ref", "--head", ...candidates.map(([ref]) => ref)], { okCodes: [0, 1] });
  const sha = new Map(out.split("\n").filter(Boolean).map((l) => [l.slice(l.indexOf(" ") + 1), l.slice(0, l.indexOf(" "))] as const));
  const head = sha.get("HEAD");
  if (!head) throw new Error("It has no commit yet, so there's nothing to compare with its base");
  for (const [ref, label] of candidates) {
    const tip = sha.get(ref);
    if (tip) return { head, tip, ref, label };
  }
  throw new Error(`The base branch ${name} isn't in this repository (neither origin/${name} nor a local ${name})`);
}

/** HEAD and the repository's own base branch (baseRef's pick, as Branch vs base takes it). */
async function headAndOwnBase(root: string): Promise<HeadAndBase> {
  const ref = await baseRef(root);
  if (!ref) throw new Error("No dev/main-style base branch found to compare against");
  const [head, tip] = (await git(root, ["rev-parse", "HEAD", `${ref}^{commit}`])).split("\n");
  return { head, tip, ref, label: ref };
}

/** Where a worktree forked from its base, kept while neither HEAD nor the base's tip moves (a commit, a fetch): a diff read again needs no merge-base. */
const forkCache = new Map<string, { head: string; tip: string; fork: string }>();
const FORK_CACHE_MAX = 200;

async function forkOf(root: string, at: HeadAndBase): Promise<string> {
  const key = `${root}\0${at.ref}`;
  const hit = forkCache.get(key);
  if (hit && hit.head === at.head && hit.tip === at.tip) return hit.fork;
  let fork: string;
  try {
    fork = await git(root, ["merge-base", at.head, at.tip]);
  } catch (err) {
    throw new Error(`Cannot find a common ancestor with ${at.label}: ${(err as Error).message}`);
  }
  forkCache.delete(key);
  forkCache.set(key, { head: at.head, tip: at.tip, fork });
  if (forkCache.size > FORK_CACHE_MAX) forkCache.delete(forkCache.keys().next().value!);
  return fork;
}

/**
 * A queue that runs at most `parallel` jobs at once, in the order they came; a job's slot passes straight to the next
 * one waiting when it ends, so no newcomer slips in between.
 */
export function turns(parallel: number): <T>(job: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (job) => {
    if (running < parallel) running++;
    else await new Promise<void>((go) => waiting.push(go));
    try {
      return await job();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}
/** The diff badges' rounds of git: a screen of cards on many worktrees doesn't start them all together. */
const statTurn = turns(3);

const STAT_TTL_MS = 3_000;
const statCache = new Map<string, { at: number; stat: Promise<BranchStat> }>();

/** A folder's diffs read again on their next ask: its files changed (the folder watch says so), so what was read is out of date. */
export function forgetBranchStat(root: string): void {
  for (const key of statCache.keys()) if (key.startsWith(`${root}\0`)) statCache.delete(key);
}

/** Each folder and base's round of git running now, and the one to follow it, shared by whoever asks while it runs. */
const statRounds = new Map<string, { stat: Promise<BranchStat>; next: Promise<BranchStat> | null }>();

/**
 * Where the work at `root` forked from `base` (null: the repository's own base branch, as Branch vs base takes it), and
 * the base's name: what a card's diff badge (branchStat) and a wire's {diff} count from. Throws when there's no base, or
 * no commit yet.
 */
export async function branchFork(root: string, base: string | null): Promise<{ fork: string; label: string }> {
  const at = base ? await headAndBranch(root, base) : await headAndOwnBase(root);
  return { fork: await forkOf(root, at), label: at.label };
}

function statRound(key: string, root: string, base: string | null): Promise<BranchStat> {
  const stat = statTurn(async (): Promise<BranchStat> => {
    const { fork, label } = await branchFork(root, base);
    return { base: label, ...parseShortstatFiles(await git(root, ["diff", "--shortstat", fork])) };
  });
  const round = { stat, next: null as Promise<BranchStat> | null };
  statRounds.set(key, round);
  statCache.set(key, { at: Date.now(), stat });
  const ended = () => {
    if (!round.next && statRounds.get(key) === round) statRounds.delete(key);
  };
  stat.then(ended, () => {
    if (statCache.get(key)?.stat === stat) statCache.delete(key);
    ended();
  });
  return stat;
}

/**
 * How much the work at `root` changed since it forked from `base`, a card's diff badge: `git diff --shortstat` from
 * the merge base to the working tree, its commits and its uncommitted changes to tracked files together. `base` is
 * the area repo's base branch; null takes the repository's own, as Branch vs base does. Shared for a few seconds (or
 * until the folder changes, forgetBranchStat), so every card on one folder starts one round of git; a failed read
 * isn't kept. A round is two gits (where HEAD and the base are, the diff), and merge-base when either moved. A busy
 * folder runs one round and at most one more: asked while one runs (its answer may be out of date by then), the next
 * starts when it ends, and everyone who asks meanwhile shares that.
 */
export function branchStat(root: string, base: string | null): Promise<BranchStat> {
  const key = `${root}\0${base ?? ""}`;
  const hit = statCache.get(key);
  if (hit && Date.now() - hit.at < STAT_TTL_MS) return hit.stat;
  const round = statRounds.get(key);
  if (!round) return statRound(key, root, base);
  const start = () => statRound(key, root, base);
  return (round.next ??= round.stat.then(start, start));
}

/**
 * The paths a one-file diff over `range` needs: a file renamed within it is
 * diffed together with its old path, so -M shows the rename rather than a
 * whole new file.
 */
export async function withRenameSource(root: string, range: string[], rel: string): Promise<string[]> {
  const from = parseNameStatus(await git(root, ["diff", "--name-status", "-z", "-M", ...range], { trim: false })).find((c) => c.path === rel)?.from;
  return from ? [from, rel] : [rel];
}

export function parseNameStatus(z: string): GitChange[] {
  const parts = z.split("\0").filter(Boolean);
  const out: GitChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++][0];
    if (code === "R" || code === "C") {
      const from = parts[i++];
      out.push({ path: parts[i++], from, status: "R" });
    } else {
      out.push({ path: parts[i++], status: code === "A" ? "A" : code === "D" ? "D" : "M" });
    }
  }
  return out;
}

/**
 * Changed files. "working" = uncommitted work against HEAD; "branch" = everything
 * since the branch forked from its base, commits and uncommitted work together.
 */
export async function gitChanges(root: string, scope: ChangeScope): Promise<GitChanges> {
  const base = scope === "branch" ? await branchBase(root) : { sha: "HEAD", name: "HEAD" };
  const [tracked, untracked] = await Promise.all([
    git(root, ["diff", "--name-status", "-z", "-M", base.sha], { trim: false }),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"], { trim: false }),
  ]);
  const changes = parseNameStatus(tracked);
  for (const p of untracked.split("\0").filter(Boolean)) changes.push({ path: p, status: "U" });
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { changes, base: base.name };
}

export async function fileDiff(root: string, rel: string, scope: ChangeScope, untracked: boolean): Promise<string> {
  await resolveIn(root, rel);
  let out: string;
  if (untracked) out = await git(root, ["diff", "--no-index", "--", "/dev/null", rel], { okCodes: [0, 1], trim: false });
  else {
    const range = [scope === "branch" ? (await branchBase(root)).sha : "HEAD"];
    out = await git(root, ["diff", "-M", ...range, "--", ...(await withRenameSource(root, range, rel))], { trim: false });
  }
  if (out.length > MAX_DIFF_BYTES) throw new Error("Diff is too large to display");
  return out;
}
