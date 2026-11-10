import * as fs from "fs";
import * as path from "path";

/**
 * Room sessions' folders, held to the git data they started on. A room session's agent writes its folder; were the
 * `.git` there (a linked worktree's pointer file) to lead elsewhere, every git Mockingbird runs in the folder — the
 * status poll, the per-turn snapshot, stage, commit, discard, a closing worktree's WIP commit — would take that other
 * git folder's config and hooks, and run what they name. So a room launch pins its folder's git folders (pinGitDirs),
 * and git.ts asks gitPinRefusal before every git it runs: one in a pinned folder whose `.git` no longer leads where it
 * did, or with a new `.git` between it and the pinned top, is refused. Only the filesystem is read for this, never git,
 * which would follow the pointer it's checking.
 */

/** Where a repository's git data is: the shared folder, and a linked worktree's own (the same folder outside one). */
export interface GitFolders {
  common: string;
  own: string;
}

interface Pin {
  /** The folder holding `.git`, as given and resolved. */
  top: string;
  real: string;
  /** Its git folders, resolved; or why git is never run there. */
  dirs: GitFolders | { bad: string };
}

const pins = new Map<string, Pin>();
const listeners = new Set<(top: string, why: string) => void>();
/** Each folder's refusal is told once (onGitPinRefused) until it's pinned again. */
const toldFor = new Set<string>();

/** Hear the first refusal in each pinned folder; returns the way to stop. */
export function onGitPinRefused(cb: (top: string, why: string) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * The git folders `.git` in `top` leads to, read from the filesystem: a folder is the repository's own; a file names a
 * linked worktree's folder (`gitdir: …`), whose `commondir` names the shared one. Throws, saying why, when they can't
 * be read; a link is refused, as git would follow it too.
 */
export function readGitPointer(top: string): GitFolders {
  const dotGit = path.join(top, ".git");
  const st = fs.lstatSync(dotGit);
  if (st.isSymbolicLink()) throw new Error(`${dotGit} is a link`);
  if (st.isDirectory()) {
    const r = fs.realpathSync(dotGit);
    return { common: r, own: r };
  }
  if (!st.isFile()) throw new Error(`${dotGit} isn't a folder or a file`);
  const m = /^gitdir: (.+?)\r?\n?$/.exec(fs.readFileSync(dotGit, "utf8"));
  if (!m) throw new Error(`${dotGit} doesn't name a git folder`);
  const own = fs.realpathSync(path.resolve(top, m[1]));
  let common = own;
  try {
    common = fs.realpathSync(path.resolve(own, fs.readFileSync(path.join(own, "commondir"), "utf8").trim()));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { common, own };
}

/** The folder at or above `cwd` that holds `.git`, as git would find it; null when there's none. */
export function gitTop(cwd: string): string | null {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    try {
      fs.lstatSync(path.join(dir, ".git"));
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" && (err as NodeJS.ErrnoException).code !== "ENOTDIR") throw err;
    }
    if (path.dirname(dir) === dir) return null;
  }
}

const same = (a: GitFolders, b: GitFolders) => a.common === b.common && a.own === b.own;

/**
 * Pin the git folders of the repository at `cwd`, as a room launch finds them (`found`: git's own answer, from
 * roomGitDirs). They're held only when the filesystem says the same, and, given `repoPath` (the repository the session
 * was opened on), when they're that repository's: its shared folder, and a worktree's own folder inside it. Otherwise
 * git is refused there, and why is returned; null when pinned.
 */
export function pinGitDirs(cwd: string, found: GitFolders | null, repoPath?: string | null): string | null {
  let top: string | null;
  try {
    top = gitTop(cwd);
  } catch (err) {
    const why = `its .git couldn't be read (${(err as Error).message})`;
    top = path.resolve(cwd);
    pins.set(top, { top, real: real(top), dirs: { bad: why } });
    toldFor.add(top);
    return why;
  }
  if (!top) return null; // no repository: nothing for git to be led away from
  let why: string | null = null;
  let dirs: GitFolders | null = null;
  try {
    dirs = readGitPointer(top);
    const asGit = found && { common: real(found.common), own: real(found.own) };
    if (!asGit) why = `it has a .git, but git found no repository there`;
    else if (!same(dirs, asGit)) why = `git found its data at ${asGit.own}, but its .git leads to ${dirs.own}`;
    else if (dirs.own !== dirs.common && path.dirname(dirs.own) !== path.join(dirs.common, "worktrees")) why = `its .git leads to ${dirs.own}, which isn't one of ${dirs.common}'s worktrees`;
    else if (repoPath) {
      const repoTop = gitTop(repoPath);
      const repo = repoTop ? readGitPointer(repoTop) : null;
      if (repo && repo.common !== dirs.common) why = `its .git leads to ${dirs.common}, not to ${repoPath}'s git data (${repo.common})`;
    }
  } catch (err) {
    why = `its git data couldn't be read (${(err as Error).message})`;
  }
  pins.set(top, { top, real: real(top), dirs: why || !dirs ? { bad: why ?? "its git data couldn't be read" } : dirs });
  // refused from the start: the caller tells why, so its refusals aren't told again
  if (why) toldFor.add(top);
  else toldFor.delete(top);
  return why;
}

/** Let git run in `top` as in any folder (a new worktree made there). */
export function unpinGitDirs(top: string): void {
  for (const [k, p] of pins) if (k === path.resolve(top) || p.real === real(top)) pins.delete(k);
}

/** The pin `cwd` is under, if any. */
function pinOf(cwd: string): Pin | null {
  if (!pins.size) return null;
  const at = path.resolve(cwd);
  const r = real(at);
  for (const p of pins.values()) {
    for (const [dir, top] of [[at, p.top], [r, p.real]]) if (dir === top || dir.startsWith(top + path.sep)) return p;
  }
  return null;
}

/**
 * Why git mustn't run in `cwd` now, or null: it's in a pinned folder whose `.git` leads elsewhere than when its room
 * session started, or there's a `.git` between `cwd` and that folder's top that git would find first.
 */
export function gitPinRefusal(cwd: string): string | null {
  const p = pinOf(cwd);
  if (!p) return null;
  let why: string | null = null;
  if ("bad" in p.dirs) why = p.dirs.bad;
  else {
    try {
      const top = gitTop(cwd);
      if (!top || real(top) !== p.real) why = `there's a .git in ${top ?? cwd} that git would find before ${p.top}'s`;
      else {
        const now = readGitPointer(p.top);
        if (!same(now, p.dirs)) why = `its .git now leads to ${now.own}, not ${p.dirs.own} as when its room session started`;
      }
    } catch (err) {
      why = `its .git couldn't be read (${(err as Error).message})`;
    }
  }
  if (!why) return null;
  const refusal = `Mockingbird won't run git in ${p.top}: ${why}. A room session's agent can write that folder, and git would run what another git folder's config names. Check the folder; restarting its session reads it again.`;
  if (!toldFor.has(p.top)) {
    toldFor.add(p.top);
    console.warn(`[git] ${refusal}`);
    for (const cb of listeners) {
      try {
        cb(p.top, refusal);
      } catch (err) {
        console.error(`[git] telling the user git was refused in ${p.top} failed:`, err);
      }
    }
  }
  return refusal;
}

/** Forget every pin (tests). */
export function clearGitPins(): void {
  pins.clear();
  toldFor.clear();
}
