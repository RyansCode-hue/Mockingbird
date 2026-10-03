import { git } from "./git";
import { resolveIn } from "./files";
import type { ScmEntry, ScmStatus, ScmStatusCode } from "../shared/types";

/**
 * Source control for a session's folder, like VS Code's view: what's staged,
 * what isn't, and stage / unstage / discard / commit / push. Every path is
 * checked to stay inside the folder before git sees it.
 */

const code = (c: string): ScmStatusCode => (c === "A" ? "A" : c === "D" ? "D" : c === "R" || c === "C" ? "R" : "M");

/** `git status --porcelain=v2 --branch -z` → the view's groups. */
export function parseStatus(out: string): ScmStatus {
  const st: ScmStatus = { branch: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], conflicted: [] };
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
  return st;
}

export async function scmStatus(root: string): Promise<ScmStatus> {
  return parseStatus(await git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], { trim: false }));
}

/** Paths checked to be inside the folder, as git wants them (relative). */
async function inside(root: string, paths: string[]): Promise<string[]> {
  if (!paths.length) throw new Error("No files given");
  for (const p of paths) await resolveIn(root, p);
  return paths;
}

export async function scmStage(root: string, paths: string[]): Promise<void> {
  await git(root, ["add", "-A", "--", ...(await inside(root, paths))]);
}

export async function scmUnstage(root: string, paths: string[]): Promise<void> {
  const rel = await inside(root, paths);
  const hasHead = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).then(() => true, () => false);
  // before the first commit there's no HEAD to restore the index from
  await git(root, hasHead ? ["restore", "--staged", "--", ...rel] : ["rm", "--cached", "-r", "-q", "--", ...rel]);
}

/**
 * Throw away unstaged changes: tracked files go back to their staged (or
 * committed) content; untracked files go to the Trash, so a mistake can be undone.
 */
export async function scmDiscard(root: string, entries: { path: string; untracked: boolean }[], trash: (abs: string) => Promise<void>): Promise<void> {
  const tracked = entries.filter((e) => !e.untracked).map((e) => e.path);
  const untracked = entries.filter((e) => e.untracked).map((e) => e.path);
  if (tracked.length) await git(root, ["restore", "--worktree", "--", ...(await inside(root, tracked))]);
  for (const p of untracked) await trash(await resolveIn(root, p));
}

export async function scmCommit(root: string, message: string): Promise<{ sha: string }> {
  const msg = message.trim();
  if (!msg) throw new Error("Write a commit message first");
  const staged = (await scmStatus(root)).staged.length;
  if (!staged) throw new Error("Nothing is staged — stage the changes to commit first");
  await git(root, ["commit", "-q", "-m", msg]);
  return { sha: await git(root, ["rev-parse", "--short", "HEAD"]) };
}

/** Push the branch, setting its upstream on origin the first time. */
export async function scmPush(root: string): Promise<{ upstream: string }> {
  const st = await scmStatus(root);
  if (!st.branch) throw new Error("Not on a branch (detached HEAD) — nothing to push to");
  await git(root, st.upstream ? ["push", "-q"] : ["push", "-q", "-u", "origin", "HEAD"]);
  return { upstream: st.upstream ?? `origin/${st.branch}` };
}

/** The diff for one file as the view shows it: staged against HEAD, or unstaged against the index. */
export async function scmDiff(root: string, rel: string, staged: boolean, untracked: boolean): Promise<string> {
  await resolveIn(root, rel);
  if (untracked) return git(root, ["diff", "--no-index", "--", "/dev/null", rel], { okCodes: [0, 1], trim: false });
  return git(root, ["diff", ...(staged ? ["--cached"] : []), "-M", "--", rel], { trim: false });
}
