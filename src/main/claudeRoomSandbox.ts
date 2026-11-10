import * as path from "path";
import { CREDENTIAL_STORES, gitWrites, TOOL_CACHES, type RoomGitDirs } from "./codexRoomSandbox";
import { HOME_PRIVATE_DATA, HOME_RUNS_CODE, HOME_SECRETS, knownSecretFiles, notDeniedByPath } from "./secrets";

/**
 * The sandbox a Claude team room session runs in (docs/team-rooms.md), given with `--settings` on that launch alone,
 * so ~/.claude/settings.json stays untouched. It mirrors a Codex room session's (codexRoomSandbox.ts):
 * - Bash, and whatever it starts, writes only in the session's folders, the temp folder, the repository's git data but
 *   what git runs code from (gitWrites' read-only parts), and TOOL_CACHES. HOME_RUNS_CODE is denied by name as well,
 *   since a cache or the git data could otherwise sit above one of them.
 * - It can't read HOME_SECRETS, HOME_PRIVATE_DATA, CREDENTIAL_STORES or the known secret files, but for Mockingbird's
 *   co-author hooks, which its commits run.
 * - It can't leave the sandbox: no unsandboxed retry, and Claude won't start a session without one. Set from
 *   --settings, the no-retry makes the sandbox one the repository's own settings can't widen (excludedCommands,
 *   allowWrite, allowedDomains are ignored there).
 * - The network is open, as for Codex and Council: any domain, and local services.
 * - The file tools (Edit, Write, NotebookEdit) refuse paths outside the session's folders, and HOME_RUNS_CODE and the git
 *   folder's config and hooks by rule, in every permission mode. Hooks, the status line and MCP servers run outside the
 *   sandbox, as Mockingbird's own need to.
 * A pane's Bash still asks before each command, as it does outside the sandbox; a headless Council turn, which can't
 * ask, runs its sandboxed commands without asking (autoAllowBash).
 */

export interface ClaudeRoomPlaces {
  /** WorkTracker's folder, whose config names the Azure DevOps PAT file; absent where there's none to deny. */
  workTrackerPath?: string;
  /** The session's repository; null outside one. */
  git: RoomGitDirs | null;
  /** Folders inside a denied one that the session's git reads: Mockingbird's co-author hooks and their lists. */
  hooks: string[];
  /** Unix sockets its commands may connect to (a Council seat's Docker daemon). */
  sockets?: string[];
  autoAllowBash?: boolean;
}

/** A home pattern as a sandbox path: the folder for "~/x/**", the file otherwise. */
const sandboxPath = (p: string) => p.replace(/\/\*\*$/, "");

export function claudeRoomSettings(p: ClaudeRoomPlaces): { settings: Record<string, unknown>; problem: string | null } {
  const known = p.workTrackerPath ? knownSecretFiles(p.workTrackerPath) : { files: [], problem: null };
  const git = p.git ? gitWrites(p.git) : { write: [], read: [] };
  // Claude's denyWrite outranks allowWrite whatever their depth, so a worktree's own git folder can't sit inside a denied
  // one: the other worktrees' folders stay writable (their config.worktree is read only once the denied config says so)
  const gitDenied = git.read.filter((r) => !git.write.some((w) => w.startsWith(r + path.sep)));
  // what git would run code from: its config and hooks, wherever the repository keeps them
  const gitRuns = p.git ? [path.join(p.git.common, "config"), path.join(p.git.common, "hooks")] : [];
  return {
    settings: {
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: !!p.autoAllowBash,
        filesystem: {
          allowWrite: [...git.write, ...TOOL_CACHES],
          denyWrite: [...HOME_RUNS_CODE.map(sandboxPath), ...gitDenied],
          denyRead: [...[...HOME_SECRETS, ...HOME_PRIVATE_DATA].map(sandboxPath), ...CREDENTIAL_STORES, ...known.files.map((f) => path.resolve(f))],
          allowRead: p.hooks,
        },
        network: { allowLocalBinding: true, allowedDomains: ["*"], ...(p.sockets?.length ? { allowUnixSockets: p.sockets } : {}) },
      },
      permissions: {
        // "//" starts an absolute path in a permission rule; an Edit rule covers Write and NotebookEdit
        deny: [...HOME_RUNS_CODE.map((x) => `Edit(${x})`), ...gitRuns.flatMap((x) => [`Edit(/${x})`, `Edit(/${x}/**)`])],
        blockWritesOutsideWorkingDirectories: true,
      },
    },
    problem: notDeniedByPath(known.problem),
  };
}
