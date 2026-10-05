import * as fs from "fs";
import * as path from "path";
import type { PrTarget, SessionInfo, Settings } from "../shared/types";
import { expandHome } from "./store";
import { pickBase } from "./pullRequests";

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
function canonical(p: string): string {
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

/**
 * Why a pull request to `target` can't merge into `base`, or null when it can:
 * the base must be a branch on origin (`bases`, from the preflight), and never
 * the other target's branch — a PR to main must not open into dev, nor one to
 * dev/UAT into main.
 */
export function prBaseProblem(target: PrTarget, base: string, bases: string[]): string | null {
  if (!bases.includes(base)) return `origin has no branch ${base} — check the branch again`;
  const other: PrTarget = target === "main" ? "dev" : "main";
  if (pickBase(other, [base])) {
    return `${base} is ${other === "main" ? "a main" : "a dev/UAT"} branch, and this pull request is to ${target === "main" ? "main" : "dev/UAT"}`;
  }
  return null;
}

/** The instruction file the CLAUDE.md editor may read and write: an absolute path to a file named CLAUDE.md. */
export function instructionFile(p: unknown): string {
  const full = expandHome(String(p ?? ""));
  if (!path.isAbsolute(full) || path.basename(full) !== "CLAUDE.md") throw new Error(`Only CLAUDE.md files can be edited here (got ${String(p)})`);
  return path.resolve(full);
}

/** Did this settings change name a different claude or codex binary? */
export function binSettingsChanged(before: Pick<Settings, "claudeBin" | "codexBin">, after: Pick<Settings, "claudeBin" | "codexBin">): boolean {
  return before.claudeBin !== after.claudeBin || before.codexBin !== after.codexBin;
}
