import * as fs from "fs";
import * as path from "path";

/** The error of a file or folder that isn't there: "nothing yet", unlike every other failure. */
export const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Replace a file's contents in one step: written next to it, then renamed over
 * it, so a crash mid-write never leaves it truncated and a reader never sees it
 * half-written. A symlinked file (a dotfiles-managed config) stays a symlink:
 * its target is the file replaced. An existing file keeps its permissions;
 * `mode` sets them.
 */
export function writeFileAtomic(file: string, content: string, mode?: number): void {
  let target = file;
  let keepMode = mode;
  try {
    target = fs.realpathSync(file);
    keepMode ??= fs.statSync(target).mode & 0o7777;
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    if (keepMode !== undefined) fs.chmodSync(tmp, keepMode);
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * A JSON file's contents, or `fallback` when there is no file or it holds
 * nothing but whitespace. A file that can't be read or isn't JSON throws,
 * naming the file: "nothing configured" and "couldn't tell" must not look the
 * same to the caller. Nothing is moved or rewritten — the file may be the
 * user's own (their agent settings); for Mockingbird's own stores see
 * readJsonOrSetAside.
 */
export function readJsonFile(file: string, fallback: unknown): any {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (isMissing(err)) return fallback;
    throw err;
  }
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message})`);
  }
}

/**
 * A JSON file's contents, or `fallback` when there is no file. An unreadable
 * file isn't a missing one: it is moved aside (`<file>.corrupt-<time>`) so
 * what it held stays recoverable instead of being overwritten by the next
 * save, and the reason is logged. Stores are opened at startup, so a file that
 * can't be moved aside is logged too, never thrown.
 */
export function readJsonOrSetAside(file: string, fallback: unknown, what = file): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (isMissing(err)) return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
      console.error(`[mockingbird] ${what} was unreadable (${(err as Error).message}); moved to ${backup}.`);
    } catch (moveErr) {
      console.error(`[mockingbird] ${what} was unreadable (${(err as Error).message}) and couldn't be moved aside:`, moveErr);
    }
    return fallback;
  }
}

/**
 * Keep a file Mockingbird generates (a hook script, the MCP server) current:
 * rewritten, atomically, only when its content or mode differs — other
 * processes may be running it at that moment. Returns whether it was written.
 */
export function writeGenerated(file: string, content: string, mode?: number): boolean {
  try {
    const same = fs.readFileSync(file, "utf8") === content;
    if (same && (mode === undefined || (fs.statSync(file).mode & 0o777) === mode)) return false;
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  writeFileAtomic(file, content, mode);
  return true;
}

// ---- files inside folders agents write -----------------------------------------------------------
//
// A worktree or a session's folder is the agent's to write: it can turn a
// folder on the way to one of Mockingbird's files there, or the file itself,
// into a symbolic link to somewhere else (~/.zshrc). So inside such a `root`,
// nothing is resolved or followed: each folder under `root` is checked with
// lstat (a link, or something that isn't a folder, is refused), a file is
// read only when it is a regular file, and it is written as a new file beside
// its name (O_EXCL | O_NOFOLLOW) then renamed over it — a rename replaces a
// name, never a link's target. `root` itself is trusted: it is the worktree or
// session folder Mockingbird chose. Node has no openat, so a folder swapped
// for a link between the check and the write isn't caught; one already there
// always is.

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_APPEND, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

const linkRefused = (p: string, root: string) => new Error(`${p} is a symbolic link: Mockingbird doesn't write through links inside ${root}`);

/**
 * The folder `relDir` under `root`, every step of it a real folder; missing
 * steps are made with `createMode` when it's given, else the answer is null.
 * Throws when a step is a link or not a folder.
 */
export function dirInside(root: string, relDir: string, createMode?: number): string | null {
  let dir = root;
  for (const seg of relDir.split(/[\\/]+/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") throw new Error(`${relDir} leaves ${root}`);
    dir = path.join(dir, seg);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(dir);
    } catch (err) {
      if (!isMissing(err)) throw err;
      if (createMode === undefined) return null;
      try {
        fs.mkdirSync(dir, { mode: createMode });
      } catch (mkErr) {
        if ((mkErr as NodeJS.ErrnoException).code !== "EEXIST") throw mkErr;
      }
      st = fs.lstatSync(dir);
    }
    if (st.isSymbolicLink()) throw linkRefused(dir, root);
    if (!st.isDirectory()) throw new Error(`${dir} isn't a folder`);
  }
  return dir;
}

/** A regular file's text and mode, never through a link; null when there's no file. Throws for a link or anything else. */
export function readRegularFile(file: string, root = path.dirname(file)): { text: string; mode: number } | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  if (st.isSymbolicLink()) throw linkRefused(file, root);
  if (!st.isFile()) throw new Error(`${file} isn't a regular file`);
  // O_NONBLOCK: a FIFO swapped in after the lstat can't stall the read
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const now = fs.fstatSync(fd);
    if (!now.isFile()) throw new Error(`${file} isn't a regular file`);
    return { text: fs.readFileSync(fd, "utf8"), mode: now.mode & 0o7777 };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * writeGenerated for a file inside a folder agents write (see above): `rel`
 * under `root`, rewritten only when its content or mode differs, its folders
 * made (`dirMode`) where missing. Returns whether it was written.
 */
export function writeGeneratedInside(root: string, rel: string, content: string, mode?: number, dirMode = 0o777): boolean {
  const dir = dirInside(root, path.dirname(rel), dirMode)!;
  const file = path.join(dir, path.basename(rel));
  const current = readRegularFile(file, root);
  if (current && current.text === content && (mode === undefined || (current.mode & 0o777) === mode)) return false;
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    try {
      fs.writeSync(fd, content);
      fs.fchmodSync(fd, mode ?? current?.mode ?? 0o644);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return true;
}

/** Remove the file (or link — never its target) `rel` under `root`, its folders checked. Returns whether there was one. */
export function removeInside(root: string, rel: string): boolean {
  const dir = dirInside(root, path.dirname(rel));
  if (!dir) return false;
  const file = path.join(dir, path.basename(rel));
  try {
    if (fs.lstatSync(file).isDirectory()) throw new Error(`${file} is a folder`);
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

/** Append to a file that may sit where agents write (.git/info/exclude): never through a link, its folder checked. */
export function appendNoFollow(file: string, text: string): void {
  const parent = path.dirname(file);
  const st = fs.lstatSync(parent);
  if (st.isSymbolicLink()) throw linkRefused(parent, path.dirname(parent));
  if (!st.isDirectory()) throw new Error(`${parent} isn't a folder`);
  const fd = fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o644);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${file} isn't a regular file`);
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Up to `bytes` of a file's text, from its start or from its end — all of it
 * when the file is smaller. The line the window cuts is the caller's to drop.
 */
export function readSlice(file: string, from: "start" | "end", bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, from === "start" ? 0 : size - len);
    return buf.toString("utf8", 0, n);
  } finally {
    fs.closeSync(fd);
  }
}
