import * as fs from "fs";
import * as path from "path";
import { CREDENTIAL_STORES, gitWrites, IN_FOLDER_RUNS_CODE, type RoomGitDirs } from "./codexRoomSandbox";
import { HOME_PRIVATE_DATA, HOME_RUNS_CODE, HOME_SECRETS, knownSecretFiles, notDeniedByPath } from "./secrets";

/**
 * The sandbox a Claude team room session runs in (docs/team-rooms.md), given with `--settings` on that launch alone,
 * so ~/.claude/settings.json stays untouched. It mirrors a Codex room session's (codexRoomSandbox.ts):
 * - Bash, and whatever it starts, writes only in the session's folders, the temp folder, the repository's git data but
 *   what git runs code from (gitWrites' read-only parts, and the other worktrees' folders), and the room's own caches.
 *   HOME_RUNS_CODE is denied by name as well, since the git data could otherwise sit above one of them, and so is
 *   IN_FOLDER_RUNS_CODE inside the session's folders.
 * - It can't read HOME_SECRETS, HOME_PRIVATE_DATA, CREDENTIAL_STORES or the known secret files, but for Mockingbird's
 *   co-author hooks, which its commits run.
 * - It can't leave the sandbox: no unsandboxed retry, and Claude won't start a session without one. Set from
 *   --settings, the no-retry makes the sandbox one the repository's own settings can't widen (excludedCommands,
 *   allowWrite, allowedDomains are ignored there) — and the launch reads no settings but the user's and these
 *   (agents.ts), so the repository's hooks and MCP servers, which would run outside the sandbox, never start.
 * - The network is open, as for Codex and Council: any domain, and local services.
 * - The file tools (Edit, Write, NotebookEdit) refuse paths outside the session's folders, HOME_RUNS_CODE and the git
 *   folder's config, hooks and attributes, and inside the session's folders IN_FOLDER_RUNS_CODE: by rule, in every
 *   permission mode. Hooks, the status line and MCP servers run outside
 *   the sandbox, as Mockingbird's own need to.
 * - Its own SessionStart hook (`marker`) tells Mockingbird the settings were taken: a settings file Claude Code
 *   rejects is dropped whole, sandbox and all, and runs none of its hooks (roomSandboxWatch.ts).
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
  /** The folders the session works in: its cwd and any --add-dir. */
  folders?: string[];
  /** The room's cache folder (roomCachesFolder), the one cache it writes. */
  caches?: string;
  /** Unix sockets its commands may connect to (a Council seat's Docker daemon). */
  sockets?: string[];
  autoAllowBash?: boolean;
  /** The command of the SessionStart hook that reports this launch's settings were taken (sandboxMarkerCommand). */
  marker?: string;
}

/** A home pattern as a sandbox path: the folder for "~/x/**", the file otherwise. */
export const sandboxPath = (p: string) => p.replace(/\/\*\*$/, "");

/** Edit rules for an absolute path: "//" starts one in a permission rule; a folder's contents, as well as its name. */
const editDeny = (abs: string, folder: boolean): string[] => (folder ? [`Edit(/${abs})`, `Edit(/${abs}/**)`] : [`Edit(/${abs})`]);

/** IN_FOLDER_RUNS_CODE in `dir` and in any folder below it, as Edit rules. */
function inFolderDenies(dir: string): string[] {
  return IN_FOLDER_RUNS_CODE.flatMap((name) => {
    const folder = name.endsWith("/");
    const n = folder ? name.slice(0, -1) : name;
    return [...editDeny(path.join(dir, n), folder), ...editDeny(path.join(dir, "**", n), folder)];
  });
}

/**
 * IN_FOLDER_RUNS_CODE in `dir` and below, as the sandbox's denyWrite paths (globs hold on macOS), so Bash is kept from
 * them by these settings rather than by Claude Code's own list, which lacks some (`.envrc`, `.codex`). `.git` stays
 * with gitWrites: a main checkout's commits write it.
 */
function inFolderWriteDenies(dir: string): string[] {
  return IN_FOLDER_RUNS_CODE.filter((name) => name !== ".git/").flatMap((name) => {
    const folder = name.endsWith("/");
    const n = folder ? name.slice(0, -1) : name;
    const at = [path.join(dir, n), path.join(dir, "**", n)];
    return folder ? [...at, ...at.map((p) => `${p}/**`)] : at;
  });
}

/**
 * The other worktrees' own git folders, as they are at launch: a linked worktree writes its own, and Claude's
 * denyWrite outranks allowWrite whatever their depth, so the folder that holds them all can't be denied whole.
 */
function otherWorktrees(g: RoomGitDirs): string[] {
  const all = path.join(g.common, "worktrees");
  if (g.own === g.common || path.dirname(g.own) !== all) return [];
  let names: string[];
  try {
    names = fs.readdirSync(all);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.filter((n) => n !== path.basename(g.own)).map((n) => path.join(all, n));
}

export function claudeRoomSettings(p: ClaudeRoomPlaces): { settings: Record<string, unknown>; problem: string | null } {
  const known = p.workTrackerPath ? knownSecretFiles(p.workTrackerPath) : { files: [], problem: null };
  const git = p.git ? gitWrites(p.git) : { write: [], read: [] };
  let problem = notDeniedByPath(known.problem);
  let siblings: string[] = [];
  try {
    siblings = p.git ? otherWorktrees(p.git) : [];
  } catch (err) {
    problem = [problem, `the repository's other worktrees couldn't be listed, so its commands could write their git folders (${(err as Error).message})`].filter(Boolean).join("; ");
  }
  // Claude's denyWrite outranks allowWrite whatever their depth, so a worktree's own git folder can't sit inside a denied
  // one: the other worktrees' folders are denied one by one instead (their config.worktree is read only once the
  // denied config says so)
  const gitDenied = [...git.read.filter((r) => !git.write.some((w) => w.startsWith(r + path.sep))), ...siblings];
  // what git would run code from: its config and hooks, and the attributes that choose a config's drivers
  const gitRuns = p.git ? [path.join(p.git.common, "config"), path.join(p.git.common, "hooks"), path.join(p.git.common, "info", "attributes")] : [];
  return {
    settings: {
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: !!p.autoAllowBash,
        filesystem: {
          allowWrite: [...git.write, ...(p.caches ? [p.caches] : [])],
          denyWrite: [...HOME_RUNS_CODE.map(sandboxPath), ...gitDenied, ...(p.folders ?? []).flatMap((d) => inFolderWriteDenies(path.resolve(d)))],
          denyRead: [...[...HOME_SECRETS, ...HOME_PRIVATE_DATA].map(sandboxPath), ...CREDENTIAL_STORES, ...known.files.map((f) => path.resolve(f))],
          allowRead: p.hooks,
        },
        network: { allowLocalBinding: true, allowedDomains: ["*"], ...(p.sockets?.length ? { allowUnixSockets: p.sockets } : {}) },
      },
      permissions: {
        // an Edit rule covers Write and NotebookEdit
        deny: [
          ...HOME_RUNS_CODE.map((x) => `Edit(${x})`),
          ...gitRuns.flatMap((x) => editDeny(x, true)),
          ...(p.folders ?? []).flatMap((d) => inFolderDenies(path.resolve(d))),
        ],
        blockWritesOutsideWorkingDirectories: true,
      },
      ...(p.marker ? { hooks: { SessionStart: [{ hooks: [{ type: "command", command: p.marker }] }] } } : {}),
    },
    problem,
  };
}
