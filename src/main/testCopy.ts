import * as fs from "fs";
import * as path from "path";
import { git, gitBytes } from "./git";

// a large repository's checkout can take minutes on a slow disk
const COPY_TIMEOUT_MS = 5 * 60_000;

/**
 * A throwaway copy of `repo` at `dest`: its HEAD plus the uncommitted work —
 * tracked changes and untracked files that aren't ignored. Ignored files
 * (node_modules, build output) are left out; installing them is the copy's business.
 *
 * It's a clone, not a worktree: a worktree keeps its git state inside the real
 * repo's .git, which a sandbox confined to the copy can't write. --shared reads
 * the repo's objects in place instead of hard-linking them — a hard link would
 * let a write in the copy reach the real repo's files. Returns a one-line summary.
 *
 * The uncommitted changes travel as a patch from `diff-index`, a plumbing
 * command: unlike `git diff` it ignores the user's diff settings (colour,
 * prefixes, external diff tools, textconv), so the patch is always one `git
 * apply` takes. It's passed on as bytes, so files that aren't UTF-8 arrive intact.
 */
export async function makeTestCopy(repo: string, dest: string): Promise<string> {
  const head = await git(repo, ["rev-parse", "HEAD"]);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await git(path.dirname(dest), ["clone", "--quiet", "--shared", "--no-checkout", repo, dest], { timeoutMs: COPY_TIMEOUT_MS });
    await git(dest, ["checkout", "--quiet", "--detach", head], { timeoutMs: COPY_TIMEOUT_MS });
    const patch = await gitBytes(repo, ["diff-index", "-p", "--binary", "HEAD"], { timeoutMs: COPY_TIMEOUT_MS });
    if (patch.length) await git(dest, ["apply", "--whitespace=nowarn", "-"], { input: patch, timeoutMs: COPY_TIMEOUT_MS });
    const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"], { trim: false })).split("\0").filter(Boolean);
    for (const rel of untracked) {
      fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
      fs.cpSync(path.join(repo, rel), path.join(dest, rel), { verbatimSymlinks: true });
    }
    const extras = [patch.length && "uncommitted changes", untracked.length && `${untracked.length} untracked file${untracked.length === 1 ? "" : "s"}`].filter(Boolean);
    return `${head.slice(0, 7)}${extras.length ? ` + ${extras.join(" and ")}` : ""}`;
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true }); // half-made copies are never reused
    throw err;
  }
}
