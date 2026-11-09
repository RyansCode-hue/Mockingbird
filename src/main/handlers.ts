import * as fs from "fs";
import * as path from "path";
import type { SessionInfo, Settings } from "../shared/types";
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

/** A session still running in `folder`, if any — worktrees are shared by a handoff's or review's companion session. */
export function liveSessionIn(sessions: SessionInfo[], folder: string): SessionInfo | undefined {
  const want = canonical(folder);
  return sessions.find((s) => s.status !== "dead" && canonical(s.cwd) === want);
}

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
