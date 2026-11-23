import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { headCommit, isRepo } from "../git";
import { inside, resolveIn } from "../files";
import { SKIP_DIRS } from "../find";
import { globRegex } from "../lsp/watchedFiles";
import { guardedGit, type GuardedGit } from "../safeGit";
import { SECRET_FILE_GLOBS, secretPathspecs } from "../secrets";
import { holdsPrivateKey } from "../team/artifactStore";
import { readHead, redactSecrets, shapeDiff } from "../wirePrompt";

/**
 * A session's folder as the Assistant reads it (docs/assistant.md → What the Assistant can read): read only, and only
 * inside the folder. A path is taken relative to the folder, never absolute and never climbing out with `..`; the folder
 * and the file are both resolved through their links and the file must still be inside (resolveIn), and it's opened
 * without following a link (readHead). Refused, saying why: secret-shaped names at any depth (secretWhy), this Mac's
 * known secret files, home's credential folders and Mockingbird's, Claude Code's and Codex's own data, git's own files,
 * whatever git ignores, binary files, files over FOLDER_LIMITS.readBytes, and text holding a private key. What's read is
 * redacted (redactSecrets) and cut to size, saying so. git runs through guardedGit: nothing the repository configures
 * runs.
 */

export const FOLDER_LIMITS = {
  /** A file bigger than this isn't read. */
  readBytes: 200_000,
  /** Lines one read gives. */
  readLines: 2_000,
  /** Characters one read gives: Claude Code cuts a tool's answer much past this. */
  readChars: 60_000,
  /** Files one listing gives. */
  listFiles: 500,
  /** Files a folder outside git is walked for before the walk stops. */
  walkFiles: 20_000,
} as const;

/**
 * Names the Assistant never reads, at any depth, beyond SECRET_FILE_GLOBS (the list room sandboxes and backups go by,
 * which these would make too wide there): any env file, ssh keys, package and netrc credentials, and anything named for
 * credentials or secrets.
 */
export const MORE_SECRET_GLOBS: readonly string[] = [".env*", "id_*", ".npmrc", ".netrc", ".pypirc", ".git-credentials", "*credentials*", "*secret*"];

const globName = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
const SECRET_NAMES = [...SECRET_FILE_GLOBS, ...MORE_SECRET_GLOBS].map((g) => ({ g, re: globName(g) }));

/** Home's folders and files that are never read, whatever the session's folder: credentials, and apps' own data. */
const PRIVATE_IN_HOME: readonly [string, string][] = [
  [".ssh", "it holds ssh keys"],
  [".aws", "it holds cloud credentials"],
  [".gnupg", "it holds signing keys"],
  [".config/gh", "it holds GitHub's sign-in"],
  [".mockingbird", "it's Mockingbird's own data"],
  [".claude", "it's Claude Code's own data"],
  [".codex", "it's Codex's own data"],
  ["Library", "it's apps' own data (Messages, Mail, keychains)"],
];

/** Why path `rel` (relative to a session's folder) is never read by one of its names at any depth, or null. */
export function secretWhy(rel: string): string | null {
  for (const seg of rel.split(/[/\\]/)) {
    if (!seg) continue;
    if (seg.toLowerCase() === ".git") return "it's git's own data: git_diff shows a session's changes";
    const hit = SECRET_NAMES.find((n) => n.re.test(seg));
    if (hit) return `${seg === rel ? "its name" : `“${seg}” in its path`} looks like a secret's (${hit.g}): env files, keys, certificates and credentials are never read`;
  }
  return null;
}

/** Why the real path `real` is never read because of where it is in the home folder (`home`, resolved), or null. */
function privateWhy(real: string, home: string): string | null {
  for (const [p, why] of PRIVATE_IN_HOME) if (inside(path.join(home, p), real)) return `it's in ~/${p}, and ${why}`;
  return null;
}

/** A refusal: what can't be read and why, said to the model as it is. */
export class FolderRefusal extends Error {}
const refuse = (why: string): never => {
  throw new FolderRefusal(why);
};

const kb = (n: number) => `${Math.ceil(n / 1000).toLocaleString("en-US")} KB`;
const errCode = (err: unknown) => (err as NodeJS.ErrnoException).code;

/**
 * A path as the model gives it, relative to the folder: never absolute, never climbing out, never secret-shaped. ""
 * and "." are the folder itself. The path's own words, normalized, with "/" between its parts.
 */
export function relPath(given: string): string {
  const p = given.trim().replace(/\\/g, "/");
  if (path.isAbsolute(p) || /^~/.test(p)) refuse(`${JSON.stringify(given.slice(0, 200))} is an absolute path: give it relative to the session's folder (src/index.ts)`);
  const norm = path.posix.normalize(p || ".");
  if (norm === ".." || norm.startsWith("../")) refuse(`${JSON.stringify(given.slice(0, 200))} climbs out of the session's folder (..): only what's inside it is read`);
  const rel = norm === "." ? "" : norm.replace(/\/+$/, "");
  const why = rel ? secretWhy(rel) : null;
  if (why) refuse(`${rel} isn't read: ${why}`);
  return rel;
}

export interface FolderReaderDeps {
  /** This Mac's known secret files (knownSecretFiles: the ADO PAT file), refused by their real path. */
  secretFiles(): readonly string[];
  /** The home folder (os.homedir()): it, what's above it and its private folders are never read. */
  home?: () => string;
}

export interface FileRead {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
  /** Where it stopped short of what was asked, and how to read on. */
  cut?: string;
  redacted: number;
}

export interface FileListing {
  folder: string;
  files: string[];
  /** Files that matched before the cap. */
  total: number;
  cut?: string;
  /** What was left out, and why. */
  leftOut?: string[];
  /** Folders a walk outside git couldn't open. */
  unreadable?: number;
}

export interface DiffRead {
  against: string;
  diff: string;
  /** Files changed but not in the diff, and why each. */
  leftOut: string[];
  /** Untracked files, by name (read_file reads them). */
  untracked: string[];
  notes: string[];
  redacted: number;
}

/** A tree with nothing in it: what a repository without a commit is diffed against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export class FolderReader {
  constructor(private readonly d: FolderReaderDeps) {}

  /** The home folder resolved through its links, as the real paths it's compared with are. */
  private async home(): Promise<string> {
    const home = this.d.home?.() ?? os.homedir();
    try {
      return await fs.promises.realpath(home);
    } catch (err) {
      // a home that can't be resolved is compared as it's given: its private folders' paths are still refused
      if (errCode(err) === "ENOENT") return path.resolve(home);
      throw err;
    }
  }

  /** The folder `root`, resolved through its links: refused when it isn't there, is the home folder or above it, or is a private one. */
  async root(root: string): Promise<string> {
    let real: string;
    try {
      real = await fs.promises.realpath(root);
    } catch (err) {
      return refuse(errCode(err) === "ENOENT" ? `Its folder, ${root}, isn't there any more` : `Its folder, ${root}, can't be read (${errCode(err) ?? (err as Error).message})`);
    }
    const home = await this.home();
    if (inside(real, home)) refuse(`Its folder is ${real === home ? "your home folder" : `${real}, which holds your home folder`}: that's every file you have, so it isn't read`);
    const priv = privateWhy(real, home);
    if (priv) refuse(`Its folder isn't read: ${priv}`);
    return real;
  }

  /**
   * File `rel` inside `real` (a root this reader resolved): its full path, once every check that doesn't need its
   * content has passed. Refused when it's a link out of the folder, a private or known secret file, a secret-shaped
   * name where its link leads, or ignored by git.
   */
  private async place(real: string, rel: string, repo: GuardedGit | null): Promise<{ full: string; target: string }> {
    let full: string;
    try {
      full = await resolveIn(real, rel);
    } catch (err) {
      return refuse(/links outside/.test((err as Error).message) ? `${rel} is a link that leads outside the session's folder, so it isn't read` : `${rel} can't be reached (${(err as Error).message})`);
    }
    let target: string;
    try {
      target = await fs.promises.realpath(full);
    } catch (err) {
      return refuse(errCode(err) === "ENOENT" ? `There's no ${rel} in the session's folder` : `${rel} can't be read (${errCode(err) ?? (err as Error).message})`);
    }
    const priv = privateWhy(target, await this.home());
    if (priv) refuse(`${rel} isn't read: ${priv}`);
    if (this.d.secretFiles().some((f) => sameFile(f, target))) refuse(`${rel} isn't read: it's one of this Mac's secret files`);
    const realRel = path.relative(real, target);
    if (realRel !== rel) {
      const why = secretWhy(realRel);
      if (why) refuse(`${rel} isn't read: it leads to ${realRel}, and ${why}`);
    }
    // a folder outside git can still hold a repository: what that one ignores is refused as well
    const dir = path.dirname(target);
    const asked = repo ? { g: repo, paths: realRel === rel ? [rel] : [rel, realRel] } : (await isRepo(dir)) ? { g: await guardedGit(dir), paths: [path.basename(target)] } : null;
    if (asked && (await ignoredOf(asked.g, asked.paths)).size) refuse(`${rel} isn't read: git ignores it (.gitignore), which keeps out dependencies, build output and local secrets`);
    return { full, target };
  }

  /** Lines `start` to `end` (1-based, as far as FOLDER_LIMITS allow) of file `given` in folder `root`, redacted. */
  async read(root: string, given: string, o: { startLine?: number; endLine?: number } = {}): Promise<FileRead> {
    const real = await this.root(root);
    const rel = relPath(given);
    if (!rel) refuse("Name a file: list_files lists the folder");
    const repo = (await isRepo(real)) ? await guardedGit(real) : null;
    const { target } = await this.place(real, rel, repo);
    const st = await fs.promises.stat(target);
    if (st.isDirectory()) refuse(`${rel} is a folder: list_files lists it`);
    if (!st.isFile()) refuse(`${rel} isn't a regular file`);
    if (st.size > FOLDER_LIMITS.readBytes) refuse(`${rel} is ${kb(st.size)}: the Assistant reads files up to ${kb(FOLDER_LIMITS.readBytes)}`);
    let head: { content: Buffer; size: number };
    try {
      head = await readHead(target, FOLDER_LIMITS.readBytes);
    } catch (err) {
      return refuse(errCode(err) === "ELOOP" ? `${rel} turned into a link as it was read, so it isn't` : `${rel} couldn't be read (${errCode(err) ?? (err as Error).message})`);
    }
    if (head.size > FOLDER_LIMITS.readBytes) refuse(`${rel} is ${kb(head.size)}: the Assistant reads files up to ${kb(FOLDER_LIMITS.readBytes)}`);
    if (head.content.subarray(0, 8000).includes(0)) refuse(`${rel} is a binary file: only text files are read`);
    const raw = head.content.toString("utf8");
    if (holdsPrivateKey(raw)) refuse(`${rel} holds a private key, so it isn't read`);
    const r = redactSecrets(raw);
    const lines = r.text.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;
    const start = Math.max(1, Math.floor(o.startLine ?? 1));
    if (start > Math.max(total, 1)) refuse(`${rel} has ${total} line${total === 1 ? "" : "s"}: there's no line ${start}`);
    const asked = Math.min(total, Math.max(start, Math.floor(o.endLine ?? total)));
    // whole lines up to the caps, the first always, so a line longer than readChars still reads (cut)
    let end = start - 1;
    let chars = 0;
    while (end < asked && end - start + 1 < FOLDER_LIMITS.readLines) {
      const next = (lines[end] ?? "").length + 1;
      if (end >= start && chars + next > FOLDER_LIMITS.readChars) break;
      chars += next;
      end++;
    }
    let text = lines.slice(start - 1, end).join("\n");
    const longLine = text.length > FOLDER_LIMITS.readChars;
    if (longLine) text = text.slice(0, FOLDER_LIMITS.readChars);
    const read: FileRead = { path: rel, startLine: start, endLine: end, totalLines: total, text, redacted: r.count };
    const caps = `at most ${FOLDER_LIMITS.readLines.toLocaleString("en-US")} lines or ${FOLDER_LIMITS.readChars.toLocaleString("en-US")} characters at a time`;
    if (longLine) read.cut = `Line ${start} is longer than ${FOLDER_LIMITS.readChars.toLocaleString("en-US")} characters: only its start is given`;
    else if (end < asked) read.cut = `Stopped at line ${end} of the ${asked} asked for (${caps}): read on from line ${end + 1}`;
    return read;
  }

  /**
   * The files under folder `given` of `root`, at every depth, that `glob` matches (by name, or by path when it has a
   * "/"): what git tracks and the untracked files it doesn't ignore, or outside git a walk that skips hidden, dependency
   * and build folders. Secret-shaped names are left out and counted.
   */
  async list(root: string, given = "", glob?: string): Promise<FileListing> {
    const real = await this.root(root);
    const rel = relPath(given);
    const repo = (await isRepo(real)) ? await guardedGit(real) : null;
    if (rel) {
      const { target } = await this.place(real, rel, repo);
      if (!(await fs.promises.stat(target)).isDirectory()) refuse(`${rel} is a file: read_file reads it`);
    }
    let all: string[];
    let unreadable = 0;
    let walkCut = false;
    if (repo) {
      const out = await repo.run(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", rel ? `:(literal)${rel}` : "."], { trim: false });
      all = [...new Set(out.split("\0").filter(Boolean))];
    } else {
      const w = await walk(real, rel);
      all = w.files;
      unreadable = w.unreadable;
      walkCut = w.cut;
    }
    const re = glob ? globRegex(glob) : null;
    const matches = (f: string) => !re || re.test(glob!.includes("/") ? f : path.posix.basename(f));
    let secret = 0;
    const files: string[] = [];
    for (const f of all.sort()) {
      if (!matches(f)) continue;
      if (secretWhy(f)) {
        secret++;
        continue;
      }
      files.push(f);
    }
    const listing: FileListing = { folder: rel || ".", files: files.slice(0, FOLDER_LIMITS.listFiles), total: files.length };
    if (files.length > FOLDER_LIMITS.listFiles) listing.cut = `Showing the first ${FOLDER_LIMITS.listFiles} of ${files.length.toLocaleString("en-US")} files: name a folder or a glob to see the rest`;
    else if (walkCut) listing.cut = `The folder has more than ${FOLDER_LIMITS.walkFiles.toLocaleString("en-US")} files, and the walk stopped there: name a folder to see the rest`;
    const leftOut: string[] = [];
    if (secret) leftOut.push(`${secret} file${secret === 1 ? " whose name looks" : "s whose names look"} like a secret's (env files, keys, certificates, credentials)`);
    leftOut.push(repo ? "whatever git ignores" : "hidden folders, and dependency and build folders");
    listing.leftOut = leftOut;
    if (unreadable) listing.unreadable = unreadable;
    return listing;
  }

  /**
   * The folder's uncommitted changes against its last commit (`staged`: only what's staged), or one file's: through
   * guardedGit, secret files left out by name in any case (secretPathspecs) and by secretWhy file by file. A file whose
   * diff holds a private key is withheld; the rest is redacted and cut by shapeDiff.
   */
  async diff(root: string, o: { path?: string; staged?: boolean } = {}): Promise<DiffRead> {
    const real = await this.root(root);
    const rel = o.path === undefined ? "" : relPath(o.path);
    if (!(await isRepo(real))) refuse("Its folder isn't a git repository, so it has no diff");
    const g = await guardedGit(real);
    if (rel) {
      // a deleted file is in the diff but not in the folder: only a link out of it is refused here
      try {
        await resolveIn(real, rel);
      } catch (err) {
        refuse(`${rel} is a link that leads outside the session's folder, so it isn't read (${(err as Error).message})`);
      }
    }
    const head = await headCommit(real);
    const base = o.staged ? ["--cached", ...(head ? [] : [EMPTY_TREE])] : [head ?? EMPTY_TREE];
    const scope = rel ? `:(literal)${rel}` : ".";
    // git leaves out secret files itself: SECRET_FILE_GLOBS and this Mac's known ones (secretPathspecs), and
    // MORE_SECRET_GLOBS, each as a file's name or a folder's at any depth, in any case
    const exclude = [
      ...secretPathspecs(real, this.d.secretFiles()).map((p) => p.replace(/^:\(/, ":(exclude,")),
      ...MORE_SECRET_GLOBS.flatMap((p) => [`:(exclude,glob,icase)**/${p}`, `:(exclude,glob,icase)**/${p}/**`]),
    ];
    const namesOf = async (specs: string[]) => (await g.diff(["--relative", "--name-only", "-z", ...base, "--", scope, ...specs], { trim: false })).split("\0").filter(Boolean);
    const [all, shown] = await Promise.all([namesOf([]), namesOf(exclude)]);
    const kept = new Set(shown);
    const leftOut = all.filter((f) => !kept.has(f)).map((f) => `${f}: ${secretWhy(f) ?? "it's one of this Mac's secret files"}`);
    const notes: string[] = [];
    const raw = shown.length ? await g.diff(["--relative", ...base, "--", scope, ...exclude], { trim: false }) : "";
    // a second net, file by file: a secret-shaped path the pathspecs missed, or a diff holding a private key, is left out whole
    const chunks: string[] = [];
    for (const chunk of raw.split(/^(?=diff --git )/m)) {
      if (!chunk) continue;
      const file = /^diff --git "?a\/(.+?)"? "?b\//.exec(chunk)?.[1] ?? null;
      const why = file ? secretWhy(file) : null;
      if (why) leftOut.push(`${file}: ${why}`);
      else if (holdsPrivateKey(chunk)) leftOut.push(`${file ?? "a file"}: its diff holds a private key`);
      else chunks.push(chunk);
    }
    const shaped = shapeDiff(chunks.join(""));
    notes.push(...shaped.flags);
    let untracked: string[] = [];
    if (!o.staged) {
      const out = await g.run(["ls-files", "-z", "--others", "--exclude-standard", "--", rel ? `:(literal)${rel}` : "."], { trim: false });
      for (const f of out.split("\0").filter(Boolean)) {
        const why = secretWhy(f);
        if (why) leftOut.push(`${f} (untracked): ${why}`);
        else untracked.push(f);
      }
      if (untracked.length > FOLDER_LIMITS.listFiles) {
        notes.push(`${untracked.length} untracked files: the first ${FOLDER_LIMITS.listFiles} are named`);
        untracked = untracked.slice(0, FOLDER_LIMITS.listFiles);
      }
    }
    const against = o.staged ? "what's staged, against its last commit" : head ? "its last commit (staged and unstaged together)" : "nothing: its repository has no commit yet";
    return { against, diff: chunks.length ? shaped.text : "(No changes.)", leftOut, untracked, notes, redacted: shaped.redacted };
  }
}

/** Whether `a` and real path `b` are one file (by real path; one that isn't there isn't `b`). */
function sameFile(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === b;
  } catch {
    return path.resolve(a) === b;
  }
}

/** Which of `rels` git ignores (check-ignore: a tracked file isn't). */
async function ignoredOf(g: GuardedGit, rels: string[]): Promise<Set<string>> {
  const out = await g.run(["check-ignore", "-z", "--stdin"], { input: rels.join("\0") + "\0", okCodes: [0, 1], trim: false });
  return new Set(out.split("\0").filter(Boolean));
}

/** The files under `rel` of a folder outside git, as listAllFiles walks one: hidden, dependency and build folders skipped, links not followed. */
async function walk(real: string, rel: string): Promise<{ files: string[]; unreadable: number; cut: boolean }> {
  const files: string[] = [];
  const queue = [rel];
  let unreadable = 0;
  while (queue.length && files.length < FOLDER_LIMITS.walkFiles) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(real, dir), { withFileTypes: true });
    } catch (err) {
      const code = errCode(err);
      if (dir === rel || (code !== "EACCES" && code !== "EPERM")) throw err;
      unreadable++;
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(p);
      } else if (e.isFile()) files.push(p);
    }
  }
  return { files, unreadable, cut: queue.length > 0 || files.length >= FOLDER_LIMITS.walkFiles };
}
