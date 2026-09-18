import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { FileEntry, FileContent, GitChange, GitChanges, ChangeScope } from "../shared/types";
import { listBranches } from "./worktrees";

const MAX_FILE_BYTES = 1_500_000;
const MAX_DIFF_BYTES = 3_000_000;

/** Resolve a worktree-relative path, refusing anything that climbs out of the root. */
function resolveIn(root: string, rel: string): string {
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`Path is outside the session folder: ${rel}`);
  }
  return full;
}

/** git with its exit code exposed — `diff --no-index` exits 1 when it found differences. */
function git(root: string, args: string[], okCodes: number[] = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", root, ...args],
      { encoding: "utf8", maxBuffer: MAX_DIFF_BYTES * 2 },
      (err, stdout, stderr) => {
        const code = err ? ((err as any).code as number | string | undefined) : 0;
        if (!err || (typeof code === "number" && okCodes.includes(code))) return resolve(stdout);
        reject(new Error((stderr || err.message).trim()));
      }
    );
  });
}

export async function listDir(root: string, rel: string): Promise<FileEntry[]> {
  const entries = await fs.promises.readdir(resolveIn(root, rel), { withFileTypes: true });
  const out: FileEntry[] = [];
  for (const e of entries) {
    if (e.name === ".git" || e.name === ".DS_Store") continue;
    let dir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        dir = (await fs.promises.stat(resolveIn(root, path.join(rel, e.name)))).isDirectory();
      } catch {
        dir = false; // dangling link — listed as a file; opening it reports the real error
      }
    }
    out.push({ name: e.name, path: path.join(rel, e.name), dir });
  }
  return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

export async function readFile(root: string, rel: string): Promise<FileContent> {
  const full = resolveIn(root, rel);
  const stat = await fs.promises.stat(full);
  if (stat.isDirectory()) throw new Error(`${rel} is a folder`);
  const fh = await fs.promises.open(full, "r");
  try {
    const len = Math.min(stat.size, MAX_FILE_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    if (buf.subarray(0, 8000).includes(0)) return { binary: true, size: stat.size, content: "", truncated: false };
    return { binary: false, size: stat.size, content: buf.toString("utf8"), truncated: stat.size > len };
  } finally {
    await fh.close();
  }
}

/** The commit a "branch" scope compares against: where HEAD forked from the repo's base branch. */
async function branchBase(root: string): Promise<{ sha: string; name: string }> {
  const { defaultBase } = listBranches(root);
  if (!defaultBase) throw new Error("No dev/main-style base branch found to compare against");
  for (const ref of [`origin/${defaultBase}`, defaultBase]) {
    try {
      return { sha: (await git(root, ["merge-base", "HEAD", ref])).trim(), name: ref };
    } catch {
      /* ref missing (no remote / no local copy) — try the next spelling */
    }
  }
  throw new Error(`Cannot find a common ancestor with ${defaultBase}`);
}

function parseNameStatus(z: string): GitChange[] {
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
    git(root, ["diff", "--name-status", "-z", "-M", base.sha]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const changes = parseNameStatus(tracked);
  for (const p of untracked.split("\0").filter(Boolean)) changes.push({ path: p, status: "U" });
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { changes, base: base.name };
}

export async function fileDiff(root: string, rel: string, scope: ChangeScope, untracked: boolean): Promise<string> {
  resolveIn(root, rel);
  const out = untracked
    ? await git(root, ["diff", "--no-index", "--", "/dev/null", rel], [0, 1])
    : await git(root, ["diff", "-M", scope === "branch" ? (await branchBase(root)).sha : "HEAD", "--", rel]);
  if (out.length > MAX_DIFF_BYTES) throw new Error("Diff is too large to display");
  return out;
}
