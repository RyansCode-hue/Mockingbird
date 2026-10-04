import { git } from "./git";
import * as fs from "fs";
import { applyTextEdits, type LspTextEdit } from "../shared/textEdits";
import { lineBreakOf, splitBom } from "../shared/editorText";
import * as path from "path";
import type { FileEntry, FileContent, FileSave, GitChange, GitChanges, ChangeScope } from "../shared/types";
import { pickDefaultBase } from "./worktrees";

const MAX_FILE_BYTES = 1_500_000;
const MAX_DIFF_BYTES = 3_000_000;

const inside = (root: string, p: string) => p === root || p.startsWith(root + path.sep);

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

// The base branch changes rarely; resolving it per poll would re-list every ref
// every few seconds.
const BASE_TTL_MS = 5 * 60_000;
const baseCache = new Map<string, { name: string | null; at: number }>();

async function defaultBaseOf(root: string): Promise<string | null> {
  const hit = baseCache.get(root);
  if (hit && Date.now() - hit.at < BASE_TTL_MS) return hit.name;
  const refs = await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"]);
  const branches = refs.split("\n").filter(Boolean).map((b) => b.replace(/^origin\//, ""));
  const name = pickDefaultBase(branches);
  baseCache.set(root, { name, at: Date.now() });
  return name;
}

/** The base branch as a ref git can read — origin/dev when the remote has it, else the local one; null when there's none. */
export async function baseRef(root: string): Promise<string | null> {
  const name = await defaultBaseOf(root);
  if (!name) return null;
  for (const ref of [`origin/${name}`, name]) {
    if (await git(root, ["rev-parse", "--verify", "-q", ref]).then(() => true, () => false)) return ref;
  }
  return null;
}

/** The commit a "branch" scope compares against: where HEAD forked from the repo's base branch. */
async function branchBase(root: string): Promise<{ sha: string; name: string }> {
  const defaultBase = await defaultBaseOf(root);
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
  const out = untracked
    ? await git(root, ["diff", "--no-index", "--", "/dev/null", rel], { okCodes: [0, 1], trim: false })
    : await git(root, ["diff", "-M", scope === "branch" ? (await branchBase(root)).sha : "HEAD", "--", rel], { trim: false });
  if (out.length > MAX_DIFF_BYTES) throw new Error("Diff is too large to display");
  return out;
}
