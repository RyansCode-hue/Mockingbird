import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { NewSessionRequest, SessionInfo, Settings } from "../shared/types";
import { expandHome } from "./store";

/**
 * The rules index.ts's IPC handlers apply, kept apart from Electron so they can
 * be tested on their own.
 */

/**
 * An IPC handler that answers `{ error }` instead of rejecting, so the window
 * can show what went wrong, and logs the failure under `channel`.
 */
export function guarded<A extends unknown[]>(channel: string, fn: (...args: A) => unknown, log: (context: string, err: unknown) => string) {
  return async (...args: A): Promise<unknown> => {
    try {
      return await fn(...args);
    } catch (err) {
      return { error: log(channel, err) };
    }
  };
}

/** A folder as the filesystem knows it: symlinks resolved, no trailing slash. */
export function canonical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p); // gone already: compare by spelling
  }
}

export const samePath = (a: string, b: string) => canonical(a) === canonical(b);

/**
 * canonical, spelled as the disk spells it: on a case-insensitive volume realpathSync keeps the case it was given, so
 * "/USERS/sam" and "/Users/sam" would read as different folders.
 */
export function onDisk(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p); // gone already: compare by spelling
  }
}

/**
 * Whether Mockingbird's git and gh for `folder` go by a team room session's rules: when any session there, live or
 * closed but resumable (`sessions`), is a room's (`isRoom`), or none is found there, as a forgotten one's agent may
 * have written it all the same.
 */
export function roomRulesFor(folder: string, sessions: readonly Pick<SessionInfo, "id" | "cwd">[], isRoom: (id: string) => boolean): boolean {
  const there = sessions.filter((s) => samePath(s.cwd, folder));
  return !there.length || there.some((s) => isRoom(s.id));
}

/**
 * Why a session in a team room's group can't work in `cwd`, or be given `extraDirs`: the home folder, or a folder
 * holding it, all of which the room's sandbox would let its agent write across (bar the names it denies). Null when
 * it can. A plain terminal isn't asked: it runs no agent and no sandbox.
 */
export function roomFolderRefusal(cwd: string | null, extraDirs: readonly string[] = [], home = os.homedir()): string | null {
  const h = onDisk(home);
  const why = (folder: string, extra: boolean): string | null => {
    const c = onDisk(folder);
    const home = c === h;
    if (!home && !h.startsWith(c === "/" ? "/" : `${c}/`)) return null;
    const across = "the room's sandbox would let it write across everything there.";
    if (extra) return `A team room's session can't be given ${home ? "your home folder" : `${folder}, which holds your home folder,`} as an extra folder: ${across} Leave it out.`;
    return `A team room's session can't work in ${home ? "your home folder" : `${folder}, which holds your home folder`}: ${across} Choose a repo for it.`;
  };
  return (cwd === null ? null : why(cwd, false)) ?? extraDirs.map((d) => why(d, true)).find((w) => w !== null) ?? null;
}

/** The sessions still running in `folder` — worktrees are shared by a handoff's or review's companion session. */
export function liveSessionsIn(sessions: SessionInfo[], folder: string): SessionInfo[] {
  const want = canonical(folder);
  return sessions.filter((s) => s.status !== "dead" && canonical(s.cwd) === want);
}

/**
 * Make worktree `folder` free to remove or move. A session still running there holds it, since removing it from under
 * one breaks it, and is refused, closing nothing. A terminal on its agent's tree (`onTree`: a shared worktree wire's
 * terminal) is the worktree's own, so it's closed (`close`) instead, keeping its ghost as a closed session does.
 */
export function freeWorktree(folder: string, d: { sessions: SessionInfo[]; onTree: (id: string) => boolean; close: (id: string) => void }): void {
  const here = liveSessionsIn(d.sessions, folder);
  const holds = here.find((s) => !(s.shell && d.onTree(s.id)));
  if (holds) throw new Error(`"${holds.ticketTitle ?? holds.title}" is still running in that worktree — close it first`);
  for (const s of here) d.close(s.id);
}

/**
 * A session in `s`'s folder and group, on its branch as it stands (no worktree of its own): a handoff's, brief's or
 * review's, or a terminal on its tree. In its group, it launches under its team room's rules as `s` did.
 */
export const companionRequest = (s: SessionInfo, rest: Omit<NewSessionRequest, "repoPath" | "useWorktree">): NewSessionRequest => ({
  repoPath: s.repoPath,
  cwd: s.cwd,
  branchName: s.branch ?? undefined,
  useWorktree: false,
  taskGroup: s.taskGroup ?? undefined,
  ...rest,
});

/** The instruction file the CLAUDE.md editor may read and write: an absolute path to a file named CLAUDE.md. */
export function instructionFile(p: unknown): string {
  const full = expandHome(String(p ?? ""));
  if (!path.isAbsolute(full) || path.basename(full) !== "CLAUDE.md") throw new Error(`Only CLAUDE.md files can be edited here (got ${String(p)})`);
  return path.resolve(full);
}

/**
 * `load`'s answer, asked for once and then remembered. No answer (null) and a
 * failure aren't remembered — a failure goes to `onError` — so the next call
 * asks again. `forget()` drops what was remembered.
 */
export function rememberAnswer<T>(load: () => Promise<T | null>, onError: (err: unknown) => void): { get(): Promise<T | null>; forget(): void } {
  let answer: Promise<T | null> | null = null;
  return {
    get() {
      if (!answer) {
        const asked: Promise<T | null> = load().then(
          (v) => {
            if (v === null && answer === asked) answer = null;
            return v;
          },
          (err) => {
            if (answer === asked) answer = null;
            onError(err);
            return null;
          }
        );
        answer = asked;
      }
      return answer;
    },
    forget() {
      answer = null;
    },
  };
}

/** Did this settings change name a different claude or codex binary? */
export function binSettingsChanged(before: Pick<Settings, "claudeBin" | "codexBin">, after: Pick<Settings, "claudeBin" | "codexBin">): boolean {
  return before.claudeBin !== after.claudeBin || before.codexBin !== after.codexBin;
}
