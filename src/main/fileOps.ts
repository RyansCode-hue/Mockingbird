import * as fs from "fs";
import * as path from "path";

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

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
