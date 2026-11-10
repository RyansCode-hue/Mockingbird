import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { git } from "./git";
import { HOME_PRIVATE_DATA, HOME_SECRETS, knownSecretFiles, notDeniedByPath, SECRET_FILE_GLOBS } from "./secrets";

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
export const CREDENTIAL_STORES = ["~/Library/Keychains", "~/.config/git/credentials", "~/.codex/auth.json"];

/**
 * Where a room's sessions keep their package and build caches: a folder per room, outside ~/.mockingbird, that nothing
 * outside a room session's agent uses. The caches in home (~/.npm, ~/.cache, ~/Library/Caches, Go's, Cargo's, NuGet's)
 * hold code that tools run later without checking it again — npx's packages, unpacked sources, corepack's package
 * managers, a shell's cached prompt — so a room session never writes them: its agent is pointed here instead
 * (roomCacheEnv), and its sandbox writes nowhere else of the kind.
 */
export const ROOM_CACHES_DIR = path.join(os.homedir(), "Library", "Caches", "mockingbird-room-caches");

/** The cache folder of room `roomId`, under `base`. */
export function roomCachesFolder(roomId: string, base = ROOM_CACHES_DIR): string {
  return path.join(base, roomId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

/**
 * The environment that points an agent's package managers and build tools at `folder`: npm (and npx), Yarn, pnpm,
 * corepack, node-gyp, Electron's downloads, Playwright's browsers, pip, uv and the XDG caches, Go's modules and builds,
 * Cargo and NuGet. It goes on the agent's own command, not its pane's shell, whose startup may read a cache too.
 */
export function roomCacheEnv(folder: string): Record<string, string> {
  const at = (...p: string[]) => path.join(folder, ...p);
  return {
    npm_config_cache: at("npm"),
    YARN_CACHE_FOLDER: at("yarn"),
    npm_config_store_dir: at("pnpm-store"),
    COREPACK_HOME: at("corepack"),
    npm_config_devdir: at("node-gyp"),
    electron_config_cache: at("electron"),
    PLAYWRIGHT_BROWSERS_PATH: at("playwright"),
    XDG_CACHE_HOME: at("xdg"),
    PIP_CACHE_DIR: at("pip"),
    UV_CACHE_DIR: at("uv"),
    GOMODCACHE: at("go", "mod"),
    GOCACHE: at("go", "build"),
    CARGO_HOME: at("cargo"),
    NUGET_PACKAGES: at("nuget", "packages"),
    NUGET_HTTP_CACHE_PATH: at("nuget", "http"),
  };
}

/**
 * What a room session's commands may not write inside the folders they may write, because something outside the
 * sandbox would run it later: git's own folder or the pointer to it, the editors', Claude's and Codex's project settings,
 * a project's MCP servers, direnv's `.envrc`, and the shell and tool rc files a shell started there reads. Folders end
 * in "/": their rules cover the name too, so a linked worktree's `.git` file is one of them.
 */
export const IN_FOLDER_RUNS_CODE = [
  ".git/",
  ".claude/",
  ".codex/",
  ".vscode/",
  ".idea/",
  ".mcp.json",
  ".envrc",
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".profile",
  ".ripgreprc",
];

/**
 * IN_FOLDER_RUNS_CODE as entries of a Codex profile's `:workspace_roots` table: read-only at a session folder's top, and
 * denied in the folders below, since Codex's globs only deny (one there can't be read either). `.git` is `:workspace`'s
 * own, made writable but its config by gitWrites.
 */
function inFolderEntries(): string[] {
  return IN_FOLDER_RUNS_CODE.filter((name) => name !== ".git/").flatMap((name) => {
    const folder = name.endsWith("/");
    const n = folder ? name.slice(0, -1) : name;
    const below = folder ? [`*/**/${n}`, `*/**/${n}/**`] : [`*/**/${n}`];
    return [`${JSON.stringify(n)}="read"`, ...below.map((g) => `${JSON.stringify(g)}="deny"`)];
  });
}

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
 * worktrees, the attributes that pick a config's drivers for files, and this
 * worktree's own config and pointers.
 */
export function gitWrites(g: RoomGitDirs): { write: string[]; read: string[] } {
  const read = ["config", "hooks", "modules", "worktrees", path.join("info", "attributes")].map((f) => path.join(g.common, f));
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
  /** The room's cache folder (roomCachesFolder), the one cache it writes; none when absent. */
  caches?: string;
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
 *   fetches), all but gitWrites' read-only parts, and to the room's own
 *   caches (ROOM_CACHES_DIR), never the ones in home;
 * - SECRET_FILE_GLOBS denied in the session's folders and, but for
 *   certificate bundles, anywhere on disk, plus the credential folders in
 *   home, CREDENTIAL_STORES, Messages and Mail (HOME_PRIVATE_DATA) and the
 *   known secret files. Denied means neither read nor written.
 * `problem` as in roomSecretReads.
 */
export function codexRoomPermissions(p: CodexRoomPlaces): { config: string[]; problem: string | null } {
  const known = knownSecretFiles(p.workTrackerPath);
  const gitDirs = p.git ? gitWrites(p.git) : { write: [], read: [] };
  const codexAuth = p.codexHome ? [path.join(p.codexHome, "auth.json")] : [];
  // keys are TOML strings; a JSON string is a valid one
  const entries = (access: string, paths: readonly string[]) => paths.map((x) => `${JSON.stringify(x)}="${access}"`);
  const filesystem = [
    `":workspace_roots"=${inline([...entries("deny", SECRET_FILE_GLOBS.map((g) => `**/${g}`)), ...inFolderEntries()])}`,
    ...entries("write", [...gitDirs.write, ...(p.caches ? [p.caches] : [])]),
    ...entries("read", [...gitDirs.read, ...p.hooks]),
    ...entries("deny", SECRET_FILE_GLOBS.filter((g) => !CERT_BUNDLE_GLOBS.has(g)).map((g) => `/**/${g}`)),
    ...entries("deny", [...[...HOME_SECRETS, ...HOME_PRIVATE_DATA].map((x) => x.replace(/\/\*\*$/, "")), ...CREDENTIAL_STORES, ...codexAuth]),
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

/**
 * Codex's features whose tools act outside its sandbox: apps (ChatGPT's connectors, acting on the user's accounts),
 * plugins (which bring their own MCP servers), computer and browser use, and a skill installing the MCP servers it
 * names into the user's config. Unknown names are ignored by Codex, so an older one starts all the same.
 */
export const CODEX_OUTSIDE_FEATURES = ["apps", "plugins", "computer_use", "browser_use", "browser_use_external", "skill_mcp_dependency_install"];

/**
 * The folders whose `.codex` folder a Codex session in `cwd` would read as project config: each from the repository's
 * top (`top`; cwd itself outside one) down to cwd, as given and as resolved (Codex knows its folder resolved).
 */
export function codexProjectFolders(cwd: string, top: string | null): string[] {
  const out = new Set<string>();
  const end = top ? path.resolve(top) : path.resolve(cwd);
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    out.add(dir);
    try {
      out.add(fs.realpathSync(dir));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (dir === end || path.dirname(dir) === dir) break;
  }
  return [...out];
}

/**
 * -c settings that keep a Codex launch working in `folders` (codexProjectFolders) from running what a repository commits
 * or its agent picks outside the sandbox, on that launch alone:
 * - each folder named untrusted, so no `.codex` folder there is read: its config (MCP servers, hooks, model providers,
 *   a permission profile merged into the room's), rules or hooks. A folder Codex would trust (the user said so, or the
 *   repository's main checkout is trusted) would read them, and they run outside the sandbox. The cost: Codex also
 *   leaves out the repository's AGENTS.md (CODEX_AGENTS_NOTE has the agent read it), an interactive Codex opens with a
 *   "Folder access" notice to dismiss, and with no approval_policy of the user's it would ask before every command
 *   (CODEX_ROOM_APPROVALS);
 * - `notify`, the program the user's config runs after each turn with the turn's last message;
 * - CODEX_OUTSIDE_FEATURES.
 * The user's own MCP servers are switched off by name (codexMcpOff).
 */
export function codexOutsideOff(folders: readonly string[]): string[] {
  // -c splits its key on every dot, so the folders go in as an inline table's keys; tables merge with the config's
  const untrusted = folders.map((f) => `${JSON.stringify(f)}={trust_level="untrusted"}`);
  return [...(untrusted.length ? [`projects={${untrusted.join(", ")}}`] : []), "notify=[]", ...CODEX_OUTSIDE_FEATURES.map((f) => `features.${f}=false`)];
}

/**
 * A room session's approvals: what Codex gives a folder it trusts. An untrusted folder would otherwise ask before every
 * command; an approval can't lift the room's sandbox either way. It outranks the user's own approval_policy.
 */
export const CODEX_ROOM_APPROVALS = 'approval_policy="on-request"';

/** What a Codex session in an untrusted folder is told, since Codex leaves out the repository's AGENTS.md there. */
export const CODEX_AGENTS_NOTE =
  "Codex hasn't loaded this repository's AGENTS.md files: Mockingbird runs this folder as untrusted, so nothing the repository commits to a .codex folder can run outside the sandbox. " +
  "Before you start, read any AGENTS.md from the repository's top folder down to this one, and follow them as the project's instructions.";

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
  "Secret files (.env files, keys, certificates, credential files), logins (SSH keys, the keychain, git and GitHub credentials) and the user's Messages and Mail can't be read. " +
  "Commands can write this folder, temp folders, package caches and this repository's git data, so commits, branches and stashes work — but not git config or hooks, nor the editors', agents' and shells' settings files here (.vscode, .claude, .codex, .mcp.json, .envrc, rc files: read-only in this folder, hidden in the folders below). " +
  "Nothing that needs a login works from here: pushing, or fetching from a private remote. When work is ready to push, tell the user, who pushes from Mockingbird's Source Control or with a `!` command in this pane. " +
  "Don't request escalation for any of this.\n\n" +
  CODEX_AGENTS_NOTE;
