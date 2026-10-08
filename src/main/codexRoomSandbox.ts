import * as os from "os";
import * as path from "path";
import { git } from "./git";
import { HOME_SECRETS, knownSecretFiles, notDeniedByPath, SECRET_FILE_GLOBS } from "./secrets";

/**
 * The sandbox a Codex team room session runs in (docs/team-rooms.md,
 * "Codex room sessions"): a permission profile defined and selected by -c
 * settings on that launch alone, so ~/.codex/config.toml stays untouched.
 * While a profile denies reads, Codex never runs a command outside its
 * sandbox, even once approved — so the profile itself has to allow what the
 * session needs (network, commits, package caches) and nothing that lets it
 * read a secret or push.
 */

/** The permission profile a Codex room session runs under. */
export const CODEX_ROOM_PROFILE = "mockingbird-room";

/**
 * SECRET_FILE_GLOBS that also match files tools need: CA certificate bundles
 * (/etc/ssl/cert.pem, certifi's cacert.pem). The sandbox hides a denied file
 * from every command, so denied across the disk these would break TLS; they
 * are denied only inside the session's folders. (Claude's rules gate its own
 * file tools, so they deny every pattern everywhere.)
 */
const CERT_BUNDLE_GLOBS: ReadonlySet<string> = new Set(["*.pem"]);

/**
 * Credential stores outside the secret file list that would let a command
 * push or sign in as the user: the login keychain (git's osxkeychain helper,
 * gh's token), git's XDG credential store and Codex's own sign-in. The Codex
 * CLI reads its auth.json itself, outside the sandbox.
 */
const CREDENTIAL_STORES = ["~/Library/Keychains", "~/.config/git/credentials", "~/.codex/auth.json"];

/**
 * Package and build caches in home that installs and builds write: npm, XDG
 * caches (uv, pip elsewhere), macOS caches (pip, go-build, Yarn 1, node-gyp),
 * Yarn Berry, pnpm, Go modules, NuGet, Cargo. Caches only — never a folder on
 * PATH, whose programs would later run outside the sandbox.
 */
const TOOL_CACHES = [
  "~/.npm",
  "~/.cache",
  "~/Library/Caches",
  "~/.yarn/berry/cache",
  "~/Library/pnpm/store",
  "~/.pnpm-store",
  "~/go/pkg",
  "~/.nuget/packages",
  "~/.local/share/NuGet",
  "~/.cargo/registry",
  "~/.cargo/git",
];

/** Where a session's repository keeps its git data: the shared folder, and a linked worktree's own (the same folder outside one). */
export interface RoomGitDirs {
  common: string;
  own: string;
}

/** The git folders of the repository at `cwd`; null outside a repository. */
export async function roomGitDirs(cwd: string): Promise<RoomGitDirs | null> {
  let out: string;
  try {
    out = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"]);
  } catch (err) {
    if (/not a git repository/i.test((err as Error).message)) return null;
    throw err;
  }
  const [common, own] = out.split("\n");
  return { common, own: own || common };
}

/**
 * Inside the git folders the session writes, what stays read-only: anything
 * git would run code from, or follow to another folder, when Mockingbird or
 * the user runs git outside the sandbox later — config (core.fsmonitor,
 * aliases, credential helpers), hooks, submodules' git folders, other
 * worktrees, and this worktree's own config and pointers.
 */
function gitWrites(g: RoomGitDirs): { write: string[]; read: string[] } {
  const read = ["config", "hooks", "modules", "worktrees"].map((f) => path.join(g.common, f));
  if (g.own === g.common) return { write: [g.common], read };
  return { write: [g.common, g.own], read: [...read, ...["config.worktree", "commondir", "gitdir"].map((f) => path.join(g.own, f))] };
}

export interface CodexRoomPlaces {
  workTrackerPath: string;
  /** The session's repository; null outside one. */
  git: RoomGitDirs | null;
  /** Folders inside a denied one that the session's git reads: Mockingbird's co-author hooks and their lists. */
  hooks: string[];
  /** CODEX_HOME, when it isn't ~/.codex. */
  codexHome?: string;
}

/**
 * The -c settings a Codex room session starts with. CODEX_ROOM_PROFILE
 * extends Codex's :workspace sandbox (writes in the session's folders and
 * temp folders; .git and .codex there read-only) with:
 * - the network on, through Codex's network proxy (an approval can't turn
 *   it on): any domain, and local services, but only over TCP. Without the
 *   proxy the sandbox lets commands open Unix sockets — an SSH agent that
 *   signs a push, a Docker daemon that mounts any folder — and connect
 *   anywhere directly;
 * - writes to the repository's git data (commits, branches, stashes,
 *   fetches), all but gitWrites' read-only parts, and to TOOL_CACHES;
 * - SECRET_FILE_GLOBS denied in the session's folders and, but for
 *   certificate bundles, anywhere on disk, plus the credential folders in
 *   home, CREDENTIAL_STORES and the known secret files. Denied means
 *   neither read nor written.
 * `problem` as in roomSecretReads.
 */
export function codexRoomPermissions(p: CodexRoomPlaces): { config: string[]; problem: string | null } {
  const known = knownSecretFiles(p.workTrackerPath);
  const gitDirs = p.git ? gitWrites(p.git) : { write: [], read: [] };
  const codexAuth = p.codexHome ? [path.join(p.codexHome, "auth.json")] : [];
  // keys are TOML strings; a JSON string is a valid one
  const entries = (access: string, paths: readonly string[]) => paths.map((x) => `${JSON.stringify(x)}="${access}"`);
  const filesystem = [
    `":workspace_roots"=${inline(entries("deny", SECRET_FILE_GLOBS.map((g) => `**/${g}`)))}`,
    ...entries("write", [...gitDirs.write, ...TOOL_CACHES]),
    ...entries("read", [...gitDirs.read, ...p.hooks]),
    ...entries("deny", SECRET_FILE_GLOBS.filter((g) => !CERT_BUNDLE_GLOBS.has(g)).map((g) => `/**/${g}`)),
    ...entries("deny", [...HOME_SECRETS.map((x) => x.replace(/\/\*\*$/, "")), ...CREDENTIAL_STORES, ...codexAuth]),
    ...entries("deny", known.files.map((f) => path.resolve(f))),
  ];
  const profile = [
    `description=${JSON.stringify("Mockingbird team room: no secrets, no pushing")}`,
    `extends=":workspace"`,
    `network={enabled=true, domains={"*"="allow"}, allow_local_binding=true}`,
    `filesystem=${inline(filesystem)}`,
  ];
  return {
    // -c splits its key on every dot, so the paths go in as an inline table's keys
    config: [
      `default_permissions=${JSON.stringify(CODEX_ROOM_PROFILE)}`,
      "features.network_proxy=true",
      `permissions.${CODEX_ROOM_PROFILE}=${inline(profile)}`,
    ],
    problem: notDeniedByPath(known.problem),
  };
}

const inline = (pairs: string[]) => `{${pairs.join(", ")}}`;

/** CODEX_HOME as a room session's Codex sees it, when it isn't ~/.codex. */
export function codexHomeOf(env: Record<string, string | undefined>): string | undefined {
  const home = env.CODEX_HOME?.trim();
  return home && path.resolve(home) !== path.join(os.homedir(), ".codex") ? path.resolve(home) : undefined;
}

/**
 * What a Codex room session is told about its sandbox, so it doesn't ask for
 * approvals that can't help.
 */
export const CODEX_ROOM_SANDBOX_NOTE =
  "This Mockingbird team room session runs every command in the room's sandbox, and approving a command doesn't lift it. " +
  "Secret files (.env files, keys, certificates, credential files) and logins (SSH keys, the keychain, git and GitHub credentials) can't be read. " +
  "Commands can write this folder, temp folders, package caches and this repository's git data, so commits, branches and stashes work — but not git config or hooks. " +
  "Nothing that needs a login works from here: pushing, or fetching from a private remote. When work is ready to push, tell the user, who pushes from Mockingbird's Source Control or with a `!` command in this pane. " +
  "Don't request escalation for any of this.";
