import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 200 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args[0]} failed: ${(stderr || err.message).trim()}`)) : resolve(stdout)
    );
    if (input !== undefined) child.stdin!.end(input);
  });
}

/**
 * A throwaway copy of `repo` at `dest`: its HEAD plus the uncommitted work —
 * tracked changes and untracked files that aren't ignored. Ignored files
 * (node_modules, build output) are left out; installing them is the copy's business.
 *
 * It's a clone, not a worktree: a worktree keeps its git state inside the real
 * repo's .git, which a sandbox confined to the copy can't write. --shared reads
 * the repo's objects in place instead of hard-linking them — a hard link would
 * let a write in the copy reach the real repo's files. Returns a one-line summary.
 */
export async function makeTestCopy(repo: string, dest: string): Promise<string> {
  const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await git(path.dirname(dest), ["clone", "--quiet", "--shared", "--no-checkout", repo, dest]);
    await git(dest, ["checkout", "--quiet", "--detach", head]);
    const diff = await git(repo, ["diff", "--binary", "HEAD"]);
    if (diff.trim()) await git(dest, ["apply", "--whitespace=nowarn", "-"], diff);
    const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    for (const rel of untracked) {
      fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
      fs.cpSync(path.join(repo, rel), path.join(dest, rel), { verbatimSymlinks: true });
    }
    const extras = [diff.trim() && "uncommitted changes", untracked.length && `${untracked.length} untracked file${untracked.length === 1 ? "" : "s"}`].filter(Boolean);
    return `${head.slice(0, 7)}${extras.length ? ` + ${extras.join(" and ")}` : ""}`;
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true }); // half-made copies are never reused
    throw err;
  }
}
