import * as fs from "fs";
import * as path from "path";
import { onDisk as real } from "./handlers";

/**
 * Room sessions' folders, held to the git data they started on. A room session's agent writes its folder; were the
 * `.git` there (a linked worktree's pointer file) to lead elsewhere, every git Mockingbird runs in the folder — the
 * status poll, the per-turn snapshot, stage, commit, discard, a closing worktree's WIP commit — would take that other
 * git folder's config and hooks, and run what they name. So a room launch pins its folder's git folders (pinGitDirs),
 * and git.ts asks gitPinRefusal before every git it runs: one in a pinned folder whose `.git` no longer leads where it
 * did, or with a new `.git` between it and the pinned top, is refused. Only the filesystem is read for this, never git,
 * which would follow the pointer it's checking.
 *
 * A folder with no repository at its room launch is pinned as having none, at that launch and every relaunch of its
 * session (SessionInfo.noRepo): a `.git` git would find from it later, in it or above it, is one its agent could have
 * made, config and all, so git there is refused. A repository inside any room session's folder that isn't its own
 * repository's is refused the same way; a launch refuses a folder holding one (nestedRepoRefusal).
 *
 * Any folder, pinned or not, whose `.git` is a folder holding a `commondir` is refused too (strayCommondir): git
 * follows that pointer from a main checkout as from a linked worktree's folder, and a room session's agent shares the
 * main checkout's git folder with every session there, local ones included.
 */

/** Where a repository's git data is: the shared folder, and a linked worktree's own (the same folder outside one). */
export interface GitFolders {
  common: string;
  own: string;
}

interface Pin {
  /** The folder holding `.git` (a folder with none: the session's own), as given and resolved. */
  top: string;
  real: string;
  /** Its git folders, resolved; that there were none; or why git is never run there. */
  dirs: GitFolders | { none: true } | { bad: string };
  /** Those folders' device and inode (folderIds), so one swapped in under the same path is told apart. */
  ids?: string;
}

const pins = new Map<string, Pin>();
const listeners = new Set<(top: string, why: string) => void>();
/** Each folder's refusal is told once (onGitPinRefused) until it's pinned again. */
const toldFor = new Set<string>();
/** The unpinned folders whose stray commondir has been told, until git there is let run again. */
const strayTold = new Set<string>();

/** `d`'s folders as the disk knows them, device and inode: a folder moved away and another put in its place differs. */
const folderIds = (d: GitFolders): string =>
  [d.common, d.own]
    .map((p) => {
      const st = fs.statSync(p);
      return `${st.dev}:${st.ino}`;
    })
    .join(" ");

/** Hear the first refusal in each pinned folder; returns the way to stop. */
export function onGitPinRefused(cb: (top: string, why: string) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * The git folders `.git` in `top` leads to, read from the filesystem: a folder is the repository's own; a file names a
 * linked worktree's folder (`gitdir: …`), whose `commondir` names the shared one. Throws, saying why, when they can't
 * be read; a link is refused, as git would follow it too, and so is a folder holding a `commondir`, which git follows
 * from a main checkout's `.git` as from a linked worktree's folder, to another folder's config, hooks and attributes.
 * Given as the disk has them, links resolved and each name in its own case, as roomGitDirs gives them.
 */
export function readGitPointer(top: string): GitFolders {
  const dotGit = path.join(top, ".git");
  const st = fs.lstatSync(dotGit);
  if (st.isSymbolicLink()) throw new Error(`${dotGit} is a link`);
  if (st.isDirectory()) {
    let pointer: fs.Stats | null = null;
    try {
      pointer = fs.lstatSync(path.join(dotGit, "commondir"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (pointer) throw new Error(`${dotGit} holds a commondir, which would lead git to another folder's git data`);
    const r = fs.realpathSync.native(dotGit);
    return { common: r, own: r };
  }
  if (!st.isFile()) throw new Error(`${dotGit} isn't a folder or a file`);
  const m = /^gitdir: (.+?)\r?\n?$/.exec(fs.readFileSync(dotGit, "utf8"));
  if (!m) throw new Error(`${dotGit} doesn't name a git folder`);
  const own = fs.realpathSync.native(path.resolve(top, m[1]));
  let common = own;
  try {
    common = fs.realpathSync.native(path.resolve(own, fs.readFileSync(path.join(own, "commondir"), "utf8").trim()));
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
 * git is refused there, and why is returned; null when pinned. Outside a repository, `cwd` is pinned as having none.
 * What an earlier launch pinned at `cwd` is replaced.
 */
export function pinGitDirs(cwd: string, found: GitFolders | null, repoPath?: string | null): string | null {
  const at = path.resolve(cwd);
  for (const [k, p] of pins) if (k === at || p.real === real(at)) pins.delete(k);
  let top: string | null;
  try {
    top = gitTop(cwd);
  } catch (err) {
    const why = `its .git couldn't be read (${(err as Error).message})`;
    pins.set(at, { top: at, real: real(at), dirs: { bad: why } });
    toldFor.add(at);
    return why;
  }
  if (!top) {
    pinNoRepo(cwd);
    return null;
  }
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
  let ids: string | undefined;
  if (!why && dirs) {
    try {
      ids = folderIds(dirs);
    } catch (err) {
      why = `its git folders couldn't be looked at (${(err as Error).message})`;
    }
  }
  pins.set(top, { top, real: real(top), dirs: why || !dirs ? { bad: why ?? "its git data couldn't be read" } : dirs, ids });
  // refused from the start: the caller tells why, so its refusals aren't told again
  if (why) toldFor.add(top);
  else toldFor.delete(top);
  return why;
}

/**
 * Pin `folder` as having no repository, whatever is there now, replacing what was pinned there: a room session's folder
 * with none at its launch, or (relaunched) at its first launch (SessionInfo.noRepo), so a `.git` that appeared since is
 * never taken for its repository.
 */
export function pinNoRepo(folder: string): void {
  const at = path.resolve(folder);
  for (const [k, p] of pins) if (k === at || p.real === real(at)) pins.delete(k);
  pins.set(at, { top: at, real: real(at), dirs: { none: true } });
  toldFor.delete(at);
}

/** Let git run in `top` as in any folder (a new worktree made there). */
export function unpinGitDirs(top: string): void {
  for (const [k, p] of pins) if (k === path.resolve(top) || p.real === real(top)) pins.delete(k);
}

/** `dir` is `top` or a folder in it. */
const within = (dir: string, top: string): boolean => dir === top || dir.startsWith(top + path.sep);

/** The pins `cwd` is under, outermost first: the last, the innermost, speaks for its folder. */
function pinsOver(cwd: string): Pin[] {
  if (!pins.size) return [];
  const at = path.resolve(cwd);
  const r = real(at);
  return [...pins.values()].filter((p) => within(at, p.top) || within(r, p.real)).sort((a, b) => a.real.length - b.real.length);
}

/**
 * Whether the `.git` in `top` is repository `dirs`' own, leading only where the room's agent can't write: a `gitdir:`
 * file naming either a linked worktree's folder, one already in `<common>/worktrees/` (not deeper) whose `commondir`
 * leads back to `dirs.common`, or a submodule's git folder under `modules/` (the shared folder's, or the worktree's
 * own). The rest of the shared folder its agent can write, so a git folder made there, config and all, is no more
 * its repository's than one anywhere else; and a `.git` folder is always a repository of its own.
 */
function ofRepository(dirs: GitFolders, top: string): boolean {
  try {
    if (!fs.lstatSync(path.join(top, ".git")).isFile()) return false;
    const to = readGitPointer(top);
    if (path.dirname(to.own) === path.join(dirs.common, "worktrees")) return to.common === dirs.common;
    return [dirs.common, dirs.own].some((d) => {
      const modules = path.join(d, "modules");
      return to.own !== modules && within(to.own, modules) && within(to.common, modules);
    });
  } catch {
    return false;
  }
}

/**
 * Why git mustn't run in `cwd` now, or null: it's in a pinned folder whose `.git` leads elsewhere than when its room
 * session started, or there's a `.git` between `cwd` and that folder's top that git would find first; in a folder
 * pinned as having no repository, git would now find one, in it, at it or above it; or the `.git` it would find is
 * inside another room session's folder, and isn't that session's repository's, so its agent could have made or
 * rewritten it.
 */
export function gitPinRefusal(cwd: string): string | null {
  const over = pinsOver(cwd);
  if (!over.length) return strayCommondir(cwd);
  let p = over[over.length - 1];
  let why: string | null = null;
  if ("bad" in p.dirs) why = p.dirs.bad;
  else {
    try {
      const top = gitTop(cwd);
      const found = top ? real(top) : null;
      const outer = found ? over.slice(0, -1).find((q) => found !== q.real && within(found, q.real) && !("common" in q.dirs && ofRepository(q.dirs, top!))) : undefined;
      if (outer) {
        p = outer;
        why = `there's a .git in ${top}, inside it, ${"none" in outer.dirs ? "which had no repository when its room session started" : "that isn't its room session's repository's"}, so that session's agent could have made it or rewritten its config`;
      } else if ("none" in p.dirs) {
        if (found && found !== p.real && within(found, p.real)) why = `there's a .git in ${top}, inside it, which had no repository when its room session started, so that session's agent could have made it, config and all`;
        else if (top) why = `it had no repository when its room session started, and now git would find ${path.join(top, ".git")}, which that session's agent could have made, config and all`;
      } else if (!top || (found !== p.real && !(within(found!, p.real) && ofRepository(p.dirs, top)))) {
        // its own repository's below its top (a submodule, a linked worktree) leads into git data the room keeps read-only
        why = `there's a .git in ${top ?? cwd} that git would find before ${p.top}'s`;
      } else {
        const now = readGitPointer(p.top);
        if (!same(now, p.dirs)) why = `its .git now leads to ${now.own}, not ${p.dirs.own} as when its room session started`;
        else if (p.ids !== undefined && folderIds(now) !== p.ids) why = `its git folder ${now.own} isn't the one its room session started with: another was put in its place`;
      }
    } catch (err) {
      why = `its .git couldn't be read (${(err as Error).message})`;
    }
  }
  if (!why) return null;
  // a folder held to having none stays so through restarts and in new sessions there (SessionInfo.noRepo)
  const next = "none" in p.dirs ? "Delete it if you didn't make it: restarting its session, or opening another there, holds the folder to having none all the same, until the room sessions that started there without one are forgotten." : "Check the folder; restarting its session reads it again.";
  const refusal = `Mockingbird won't run git in ${p.top}: ${why}. A room session's agent can write that folder, and git would run what a config it wrote names. ${next}`;
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

/** How far a room launch looks for other repositories in its folders before refusing for what it couldn't look at. */
export const NESTED_SCAN_LIMITS = { entries: 300_000, ms: 10_000 };

/** One of a room launch's folders, as nestedRepoRefusal looks through it. */
export interface ScannedFolder {
  path: string;
  /** An extra folder (--add-dir), not its cwd. */
  extra: boolean;
  /** Held to having no repository (SessionInfo.noRepo): any `.git` at its top is one its agent could have made. */
  held: boolean;
}

/**
 * Why a room session can't work in `folders`, or null: one holds a repository that isn't the session's own (`own`, as
 * pinned; one whose `.git` leads into its shared git folder is: a submodule's, a linked worktree's), anywhere below
 * its top, or at an extra folder's top. The room's sandboxes let its agent write there, `.git` and all, so it could
 * rewrite that repository's config and hooks, and git, Mockingbird's and the user's own in a terminal, would run what
 * they name. A folder held to having none is refused for a `.git` at its top too. The cwd's own `.git` is the pins'
 * to judge. Only the filesystem is read: links aren't followed, nor `.git` entered. Past `limits` it's refused, as
 * what wasn't looked at can't be vouched for.
 */
export async function nestedRepoRefusal(folders: readonly ScannedFolder[], own: GitFolders | null, limits = NESTED_SCAN_LIMITS): Promise<string | null> {
  const theirs = (dir: string) => !!own && ofRepository(own, dir);
  const started = Date.now();
  let seen = 0;
  for (const f of folders) {
    const root = real(f.path);
    const where = f.extra ? `be given ${f.path} as an extra folder` : `work in ${f.path}`;
    const holding = (dir: string) =>
      `A team room's session can't ${where}: it holds another repository, at ${dir} (its .git), whose config and hooks the room's sandbox would let its agent rewrite, and git, Mockingbird's and yours in a terminal, would run what they name. ${f.extra ? "Leave it out, or open a session in that repository." : `Open the session in that repository, or move it out of ${f.path}.`}`;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // gone, or not a folder: it holds nothing; kept from Mockingbird by macOS's privacy settings: from its agent too.
        // A folder its permissions keep unread can still be written and entered, or its owner can change them.
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EPERM") continue;
        if (code === "EACCES") return `A team room's session can't ${where}: Mockingbird isn't allowed to list ${dir}, so it couldn't look there for other repositories its agent could rewrite, though its agent may be able to write there. Make it readable or move it out, then start the session again.`;
        return `A team room's session can't ${where}: Mockingbird couldn't look through ${dir} for other repositories its agent could rewrite (${(err as Error).message}).`;
      }
      for (const e of entries) {
        if (++seen > limits.entries || Date.now() - started > limits.ms) {
          return `A team room's session can't ${where}: Mockingbird looks through a room session's folders for other repositories its agent could rewrite, and gave up past ${limits.entries.toLocaleString("en-US")} entries or ${limits.ms / 1000} s, so what it didn't look at can't be vouched for. Choose a smaller folder for it.`;
        }
        const at = path.join(dir, e.name);
        // git takes `.GIT` and the like for `.git` on a volume that ignores case, as macOS's do by default
        if (e.name.toLowerCase() === ".git") {
          if (dir !== root) {
            if (!theirs(dir)) return holding(dir);
          } else if (f.held) {
            return `A team room's session can't ${where}: it had no repository when a room session first started there, and now has one (${at}), which that session's agent could have made, config and all. Delete it if you didn't make it; to work in it as a repository, forget the room sessions that started there without one, then open a new session there.`;
          } else if (f.extra && !theirs(dir)) return holding(dir);
          continue;
        }
        if (e.isDirectory()) stack.push(at);
      }
    }
  }
  return null;
}

/**
 * Why git mustn't run in `cwd`, a folder no room session pinned: the `.git` git would find there is a folder holding a
 * `commondir` (readGitPointer's refusal), which would lead it to another folder's config, hooks and attributes. Told
 * (logged and to onGitPinRefused) once per folder, until git there is let run again. Null otherwise; and when no
 * `.git` can be looked for above `cwd`, as git then finds no repository either and says so itself.
 */
function strayCommondir(cwd: string): string | null {
  let top: string | null;
  try {
    top = gitTop(cwd);
  } catch {
    return null;
  }
  if (!top) return null;
  const dotGit = path.join(top, ".git");
  let why: string | null = null;
  try {
    if (fs.lstatSync(dotGit).isDirectory() && fs.lstatSync(path.join(dotGit, "commondir"))) why = "its .git holds a commondir";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") why = `its .git couldn't be checked for a commondir (${(err as Error).message})`;
  }
  if (!why) {
    strayTold.delete(top);
    return null;
  }
  const refusal = `Mockingbird won't run git in ${top}: ${why}, which would lead git to another folder's config, hooks and attributes and run what they name. A team room session's agent may have written it; a checkout's own .git has none. Check ${path.join(dotGit, "commondir")}.`;
  if (!strayTold.has(top)) {
    strayTold.add(top);
    console.warn(`[git] ${refusal}`);
    for (const cb of listeners) {
      try {
        cb(top, refusal);
      } catch (err) {
        console.error(`[git] telling the user git was refused in ${top} failed:`, err);
      }
    }
  }
  return refusal;
}

/** Forget every pin (tests). */
export function clearGitPins(): void {
  pins.clear();
  toldFor.clear();
  strayTold.clear();
}
