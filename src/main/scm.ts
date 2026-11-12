import { git, headCommit, MAX_DIFF_BYTES, upstreamOf } from "./git";
import { baseRef, parseNameStatus, resolveIn, withRenameSource } from "./files";
import { guardedGit, ownNetworkGit, SAFE_DIFF, WRITE_ENV } from "./safeGit";
import type { GitChange, GraphCommit, GraphRef, RoomPush, ScmGraph, ScmStatus, ScmStatusCode } from "../shared/types";

/**
 * Source control for a session's folder, like VS Code's view: what's staged,
 * what isn't, and stage / unstage / discard / commit / push. Every path is
 * checked to stay inside the folder before git sees it. What it reads goes
 * through guardedGit, so nothing the folder's config names runs for a read.
 */

const code = (c: string): ScmStatusCode => (c === "A" ? "A" : c === "D" ? "D" : c === "R" || c === "C" ? "R" : "M");

/** `git status --porcelain=v2 --branch -z` → the view's groups. */
function parseStatus(out: string): ScmStatus {
  const st: ScmStatus = { branch: null, upstream: null, published: false, ahead: 0, behind: 0, staged: [], unstaged: [], conflicted: [] };
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith("# branch.head ")) {
      const h = p.slice(14);
      st.branch = h === "(detached)" ? null : h;
    } else if (p.startsWith("# branch.upstream ")) st.upstream = p.slice(18);
    else if (p.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(p);
      if (m) [st.ahead, st.behind] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    } else if (p.startsWith("1 ") || p.startsWith("2 ")) {
      const f = p.split(" ");
      const xy = f[1];
      // ordinary: 8 fields then the path; rename/copy: 9 then the path, and the old path in the next NUL field
      const file = f.slice(p.startsWith("1 ") ? 8 : 9).join(" ");
      const from = p.startsWith("2 ") ? parts[++i] : undefined;
      if (xy[0] !== ".") st.staged.push({ path: file, ...(from ? { from } : {}), status: code(xy[0]) });
      if (xy[1] !== ".") st.unstaged.push({ path: file, status: code(xy[1]) });
    } else if (p.startsWith("u ")) {
      st.conflicted.push({ path: p.split(" ").slice(10).join(" "), status: "C" });
    } else if (p.startsWith("? ")) {
      st.unstaged.push({ path: p.slice(2), status: "U" });
    }
  }
  st.published = !!st.upstream && !!st.branch && st.upstream.slice(st.upstream.indexOf("/") + 1) === st.branch;
  return st;
}

export async function scmStatus(root: string): Promise<ScmStatus> {
  return parseStatus(await (await guardedGit(root)).status(["--porcelain=v2", "--branch", "-z", "--untracked-files=all"], { trim: false }));
}

/**
 * The files Source Control lists, each once: conflicted, staged and unstaged,
 * untracked files one by one as the list shows them. A file staged with
 * further edits since is in two groups but is one file.
 */
export const changedPaths = (st: ScmStatus): string[] => [...new Set([...st.conflicted, ...st.staged, ...st.unstaged].map((e) => e.path))];

/** How many files have uncommitted changes: what Source Control lists, counted as changedPaths does. */
export async function dirtyFileCount(root: string): Promise<number> {
  return changedPaths(await scmStatus(root)).length;
}

/** Paths checked to be inside the folder, as git wants them (relative). */
async function inside(root: string, paths: string[]): Promise<string[]> {
  if (!paths.length) throw new Error("No files given");
  for (const p of paths) await resolveIn(root, p);
  return paths;
}

export async function scmStage(root: string, paths: string[]): Promise<void> {
  await git(root, ["add", "-A", "--", ...(await inside(root, paths))], { env: WRITE_ENV });
}

export async function scmUnstage(root: string, paths: string[]): Promise<void> {
  const rel = await inside(root, paths);
  // before the first commit there's no HEAD to restore the index from
  await git(root, (await headCommit(root)) ? ["restore", "--staged", "--", ...rel] : ["rm", "--cached", "-r", "-q", "--", ...rel], { env: WRITE_ENV });
}

/**
 * Throw away unstaged changes: tracked files go back to their staged (or
 * committed) content; untracked files go to the Trash, so a mistake can be undone.
 */
export async function scmDiscard(root: string, entries: { path: string; untracked: boolean }[], trash: (abs: string) => Promise<void>): Promise<void> {
  const tracked = entries.filter((e) => !e.untracked).map((e) => e.path);
  const untracked = entries.filter((e) => e.untracked).map((e) => e.path);
  if (tracked.length) await git(root, ["restore", "--worktree", "--", ...(await inside(root, tracked))], { env: WRITE_ENV });
  for (const p of untracked) await trash(await resolveIn(root, p));
}

export async function scmCommit(root: string, message: string): Promise<{ sha: string }> {
  const msg = message.trim();
  if (!msg) throw new Error("Write a commit message first");
  const staged = (await scmStatus(root)).staged.length;
  if (!staged) throw new Error("Nothing is staged — stage the changes to commit first");
  await git(root, ["commit", "-q", "-m", msg], { env: WRITE_ENV });
  return { sha: await git(root, ["rev-parse", "--short", "HEAD"]) };
}

/**
 * Push the branch to its own name on origin. The first push publishes it and
 * makes that its upstream — including a branch that so far tracked the branch
 * it was made from (origin/dev), which a plain `git push` would aim at dev.
 *
 * `own`: a team room session's push. Main makes it, as the user, for a worktree the room's agent (sandboxed, or steered
 * by a teammate typing) can write, so it goes through ownNetworkGit's room push: a pre-push only from the user's global
 * core.hooksPath outside every working tree, never the repository's (its `.git/hooks` or Husky's `.husky/_`), the
 * repository's Git LFS files uploaded first (git lfs push, to the remote the push goes to), git's own receive-pack, no
 * submodule's push and no ext:: transport. `roomPush` says what ran. A local session's push stays a plain one, the
 * repository's hooks (Husky's, git-lfs's) running: its agent is trusted.
 */
export async function scmPush(root: string, o: { own?: boolean } = {}): Promise<{ upstream: string; roomPush?: RoomPush }> {
  const st = await scmStatus(root);
  if (!st.branch) throw new Error("Not on a branch (detached HEAD) — nothing to push to");
  const args = st.published ? ["-q"] : ["-q", "-u", "origin", "HEAD"];
  const upstream = st.published ? st.upstream! : `origin/${st.branch}`;
  if (!o.own) {
    await git(root, ["push", ...args]);
    return { upstream };
  }
  let roomPush: RoomPush | undefined;
  // a plain `git push` goes to the upstream's remote (a branch's pushRemote aside, which this repository's config sets)
  const remote = st.published ? upstream.slice(0, upstream.indexOf("/")) : "origin";
  await ownNetworkGit(root, "push", args, { roomPush: { lfs: { remote, refs: ["HEAD"] }, pushes: "a room session's pushes", told: (p) => (roomPush = p) } });
  return { upstream, roomPush };
}

/**
 * Bring in what the upstream has that this branch doesn't — fast-forward only,
 * so a pull never makes a merge commit, rewrites anything, or stops halfway in
 * conflicts. When both sides have moved, or local edits are in the way, git's
 * refusal is passed on and nothing changes.
 */
export async function scmPull(root: string): Promise<void> {
  const st = await scmStatus(root);
  if (!st.branch) throw new Error("Not on a branch (detached HEAD) — nothing to pull into");
  if (!st.upstream) throw new Error("This branch doesn't track a remote branch yet, so there's nothing to pull");
  try {
    await git(root, ["pull", "--ff-only", "-q"], { env: WRITE_ENV });
  } catch (err) {
    const msg = (err as Error).message;
    if (/not possible to fast-forward|diverg/i.test(msg)) {
      throw new Error(
        `This branch and ${st.upstream} have both moved, so they can't be fast-forwarded. Ask the session to merge or rebase ${st.upstream}, then come back.`
      );
    }
    throw err;
  }
}

/** Update the remote branches (what ↑/↓ and the graph compare against), dropping deleted ones. */
export async function scmFetch(root: string): Promise<void> {
  await git(root, ["fetch", "--prune", "-q"], { env: WRITE_ENV });
}

const SEP = "\x1f";
const END = "\x1e";

/** `%D` decorations → refs: the checked-out branch, other local branches, remote branches, tags. */
export function parseRefs(decoration: string, remotes: string[]): GraphRef[] {
  const out: GraphRef[] = [];
  for (const raw of decoration.split(", ").map((r) => r.trim()).filter(Boolean)) {
    if (raw.startsWith("HEAD -> ")) out.push({ name: raw.slice(8), kind: "head" });
    else if (raw === "HEAD") out.push({ name: "HEAD", kind: "head" });
    else if (raw.startsWith("tag: ")) out.push({ name: raw.slice(5), kind: "tag" });
    else if (raw.endsWith("/HEAD")) continue; // origin/HEAD just points at the default branch
    else if (remotes.some((r) => raw.startsWith(`${r}/`))) out.push({ name: raw, kind: "remote" });
    else out.push({ name: raw, kind: "local" });
  }
  return out;
}

function parseLog(out: string, remotes: string[]): GraphCommit[] {
  return out
    .split(END)
    .map((r) => r.replace(/^\n/, ""))
    .filter(Boolean)
    .map((r) => {
      const [sha, parents, refs, subject, author, at] = r.split(SEP);
      return { sha, parents: parents ? parents.split(" ") : [], refs: parseRefs(refs, remotes), subject, author, at: parseInt(at, 10) * 1000 };
    });
}

/**
 * The commit graph: HEAD, the branch it tracks and the base branch it was made
 * from (origin/dev), newest first in topological order — so the branch's own
 * commits, what's new on dev, and where they forked all show.
 */
export async function scmGraph(root: string, limit = 150): Promise<ScmGraph> {
  const head = await headCommit(root);
  if (!head) return { commits: [], head: null, refs: [], more: false };
  const [upstream, base, remotes] = await Promise.all([
    upstreamOf(root),
    baseRef(root),
    git(root, ["remote"]).then((r) => r.split("\n").filter(Boolean)),
  ]);
  const refs = [...new Set(["HEAD", upstream, base].filter((r): r is string => !!r))];
  // guarded for log.showSignature, which runs the config's gpg.program for every signed commit, whatever the format
  const out = await (await guardedGit(root)).run(["log", "--topo-order", `-n${limit + 1}`, `--format=%H${SEP}%P${SEP}%D${SEP}%s${SEP}%an${SEP}%at${END}`, ...refs, "--"], { trim: false });
  const commits = parseLog(out, remotes);
  return { commits: commits.slice(0, limit), head, refs, more: commits.length > limit };
}

const SHA = /^[0-9a-f]{7,40}$/;

/** What a commit's changes are shown against: its first parent (a merge's too, as VS Code shows it), or null for a root commit. */
async function firstParent(root: string, sha: string): Promise<string | null> {
  if (!SHA.test(sha)) throw new Error(`Not a commit: ${sha}`);
  const isRoot = (await git(root, ["rev-list", "--parents", "-n1", sha])).split(" ").length === 1;
  return isRoot ? null : `${sha}^1`;
}

/** The files a commit changed. */
export async function scmCommitFiles(root: string, sha: string): Promise<GitChange[]> {
  const parent = await firstParent(root, sha);
  const g = await guardedGit(root);
  const out = parent
    ? await g.diff(["--name-status", "-z", "-M", parent, sha], { trim: false })
    : await g.run(["diff-tree", ...SAFE_DIFF, "--root", "--no-commit-id", "-r", "-M", "--name-status", "-z", sha], { trim: false });
  return parseNameStatus(out);
}

function capped(diff: string): string {
  if (diff.length > MAX_DIFF_BYTES) throw new Error("Diff is too large to display");
  return diff;
}

/** One file's change in a commit. */
export async function scmCommitDiff(root: string, sha: string, rel: string): Promise<string> {
  const parent = await firstParent(root, sha);
  await resolveIn(root, rel);
  const g = await guardedGit(root);
  if (!parent) return capped(await g.run(["show", ...SAFE_DIFF, "--format=", sha, "--", rel], { trim: false }));
  const range = [parent, sha];
  return capped(await g.diff(["-M", ...range, "--", ...(await withRenameSource(g, range, rel))], { trim: false }));
}

/** The diff for one file as the view shows it: staged against HEAD, or unstaged against the index. */
export async function scmDiff(root: string, rel: string, staged: boolean, untracked: boolean): Promise<string> {
  await resolveIn(root, rel);
  const g = await guardedGit(root);
  if (untracked) return capped(await g.diff(["--no-index", "--", "/dev/null", rel], { okCodes: [0, 1], trim: false }));
  // renames show only between HEAD and the index; unstaged, a moved file is a deletion and an untracked file
  const paths = staged ? await withRenameSource(g, ["--cached"], rel) : [rel];
  return capped(await g.diff([...(staged ? ["--cached"] : []), "-M", "--", ...paths], { trim: false }));
}
