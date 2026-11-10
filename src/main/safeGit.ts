import * as fs from "fs";
import * as path from "path";
import { git, gitBytes, type GitOptions } from "./git";

/**
 * What every diff run through GuardedGit adds: no colour, no external diff, no text conversion, a submodule shown as
 * its commit line, and a submodule's own working tree left unread (a submodule's config is its own, out of reach of
 * the overrides here). Its commits moving still show.
 */
export const SAFE_DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--submodule=short", "--ignore-submodules=dirty"] as const;
/** What every status run through GuardedGit adds: a submodule's own working tree left unread, as SAFE_DIFF. */
export const SAFE_STATUS = ["--ignore-submodules=dirty"] as const;

/** git in one folder with nothing its repository's config names run: see guardedGit. */
export interface GuardedGit {
  run(args: readonly string[], opts?: GitOptions & { trim?: boolean }): Promise<string>;
  /** `git diff` with SAFE_DIFF before `args`. */
  diff(args: readonly string[], opts?: GitOptions & { trim?: boolean }): Promise<string>;
  /** `git status` with SAFE_STATUS before `args`. */
  status(args: readonly string[], opts?: GitOptions & { trim?: boolean }): Promise<string>;
  /** run's output as bytes, as gitBytes gives it. */
  bytes(args: readonly string[], opts?: GitOptions): Promise<Buffer>;
}

type Pair = readonly [string, string];

/** Overrides as git reads them from the environment: each is one key and one value, so neither is split anywhere. */
function configEnv(pairs: readonly Pair[]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length), GIT_PAGER: "cat" };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** Settings that run a command whatever git does and change nothing it stores: fsmonitor's on every index read, a pager. */
const NEUTRAL_OVERRIDES: readonly Pair[] = [
  ["core.fsmonitor", "false"],
  ["core.pager", "cat"],
];

/** No hooks, wherever core.hooksPath points (a folder in the working tree, say): git finds none under /dev/null. */
const NO_HOOKS: Pair = ["core.hooksPath", "/dev/null"];

/**
 * The environment for git that writes a session's folder when someone asks (stage, commit, discard, a WIP commit, a
 * pull or fetch): NEUTRAL_OVERRIDES alone. Filters stay on, as they define what's stored, so a write stores what it
 * would without Mockingbird, and hooks stay on, as they're the user's own. A room's worktree can't have its config
 * written under the room's sandbox, and a local pane is trusted.
 */
export const WRITE_ENV: Readonly<Record<string, string>> = configEnv(NEUTRAL_OVERRIDES);

/** No `ext::` transport: its URL names a command, which a repository's `url.*.insteadOf` could make of any remote. */
const NO_EXT: Pair = ["protocol.ext.allow", "never"];

/**
 * WRITE_ENV with no hooks and no `ext::` transport: for the writes Mockingbird makes on its own, which nobody asked to
 * run a hook for: a turn's snapshot (its throwaway index, its refs), take-over's own refs (backups, pins, copies), and
 * under ownNetworkEnv its own fetches. A fetch reads the index (for submodules), so fsmonitor off matters there too.
 * Filters stay on, as for WRITE_ENV.
 */
export const OWN_WRITE_ENV: Readonly<Record<string, string>> = configEnv([...NEUTRAL_OVERRIDES, NO_HOOKS, NO_EXT]);

/**
 * What each fetch Mockingbird makes on its own adds: git's own upload-pack, never the one a remote's config names (an
 * override in the environment doesn't reach that: git keeps the first it reads, the repository's), and no submodule's
 * fetch, which would run in the submodule's own config.
 */
export const OWN_FETCH = ["--upload-pack=git-upload-pack", "--recurse-submodules=no"] as const;
/** What each ls-remote Mockingbird makes on its own adds: git's own upload-pack, as OWN_FETCH. */
export const OWN_LS_REMOTE = ["--upload-pack=git-upload-pack"] as const;
/** What each push Mockingbird makes on its own adds: git's own receive-pack, as OWN_FETCH, and no submodule's push. */
export const OWN_PUSH = ["--receive-pack=git-receive-pack", "--recurse-submodules=no"] as const;

/**
 * A setting as the user's own config has it, global or system (their includes followed, an `includeIf` on `cwd`'s
 * repository among them), never the repository's: null when it's unset.
 */
async function userSetting(cwd: string, scope: "--global" | "--system", key: string, o: { path?: boolean } = {}): Promise<string | null> {
  // exits 1 when it's unset
  const out = await git(cwd, ["config", scope, "--includes", ...(o.path ? ["--type=path"] : []), "--get", key], { okCodes: [0, 1] });
  return out || null;
}

/** `s` as one word for sh. */
const shellWord = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * The ssh Mockingbird's own network gits run in `cwd`: the user's own, never a command the repository's config names.
 * GIT_SSH_COMMAND in main's environment wins over any config already; otherwise core.sshCommand from their global or
 * system config, else GIT_SSH from main's environment, else plain ssh, as git would choose with no local config.
 */
async function userSsh(cwd: string): Promise<Record<string, string>> {
  if (process.env.GIT_SSH_COMMAND) return {};
  const ssh = (await userSetting(cwd, "--global", "core.sshCommand")) ?? (await userSetting(cwd, "--system", "core.sshCommand")) ?? (process.env.GIT_SSH ? shellWord(process.env.GIT_SSH) : "ssh");
  return { GIT_SSH_COMMAND: ssh };
}

/**
 * The environment for Mockingbird's own network gits in `cwd` (with OWN_FETCH, OWN_LS_REMOTE or OWN_PUSH): OWN_WRITE_ENV,
 * with the user's ssh (userSsh). Hooks stay off, unless `prePush` is set, for a push whose pre-push is to run (a
 * backup's, which a secret scanner reads first): then from the user's global core.hooksPath, else from the
 * repository's own hooks folder, never a folder its config names. Credential helpers stay as they are: a remote may
 * need them.
 */
export async function ownNetworkEnv(cwd: string, o: { prePush?: boolean } = {}): Promise<Record<string, string>> {
  const ssh = await userSsh(cwd);
  if (!o.prePush) return { ...OWN_WRITE_ENV, ...ssh };
  const hooks = (await userSetting(cwd, "--global", "core.hooksPath", { path: true })) ?? path.join(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "hooks");
  return { ...configEnv([...NEUTRAL_OVERRIDES, ["core.hooksPath", hooks], NO_EXT]), ...ssh };
}

/** `git fetch` as Mockingbird makes it on its own, in `cwd`: OWN_FETCH before `args`, with ownNetworkEnv. */
export async function ownFetch(cwd: string, args: readonly string[], opts: GitOptions = {}): Promise<string> {
  return git(cwd, ["fetch", ...OWN_FETCH, ...args], { ...opts, env: { ...opts.env, ...(await ownNetworkEnv(cwd)) } });
}

/**
 * Settings that would run a command for a read: NEUTRAL_OVERRIDES', a hook (post-index-change, when a diff refreshes
 * the index), gpg for a signature, a submodule's own diff.
 */
const READ_OVERRIDES: readonly Pair[] = [
  ...NEUTRAL_OVERRIDES,
  NO_HOOKS,
  ["diff.submodule", "short"],
  ["status.submoduleSummary", "false"],
  ["log.showSignature", "false"],
];

const COMMANDS = ["clean", "smudge", "process"] as const;
/**
 * The commands `git lfs install` sets. A driver whose every command is exactly git-lfs's own is left on when git-lfs
 * can run safely (driversToTurnOff): an LFS repository's working files are compared as the pointers it keeps, so with
 * it off a file merely touched reads as changed. Any other command, under any name, is turned off.
 */
const LFS_COMMANDS: Readonly<Record<(typeof COMMANDS)[number], string>> = { clean: "git-lfs clean -- %f", smudge: "git-lfs smudge -- %f", process: "git-lfs filter-process" };

/**
 * Whether a setting decides what a guarded read runs: a filter driver's, an LFS extension's (in any case: git spells a
 * subsection as written), or LFS's storage folder. git-lfs writes others of its own while it runs (its format version
 * on its first clean, a server's access and lock settings on a push), which mustn't set a read aside.
 */
function decidesWhatRuns(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith("filter.") || k.startsWith("lfs.extension.") || k === "lfs.storage";
}

/**
 * The config's settings that decide what a guarded read runs (decidesWhatRuns) as git lists them (`key\nvalue`, each
 * ending in a NUL), to be read and compared again.
 */
async function guardedListing(cwd: string, timeoutMs?: number): Promise<string> {
  // exits 1 when there are none
  const out = await git(cwd, ["config", "-z", "--get-regexp", "^(filter|lfs)\\."], { okCodes: [0, 1], trim: false, ...(timeoutMs ? { timeoutMs } : {}) });
  return out
    .split("\0")
    .filter((entry) => entry && decidesWhatRuns(entry.split("\n", 1)[0]))
    .map((entry) => `${entry}\0`)
    .join("");
}

/**
 * Whether `program` is what sh finds on `pathVar`: an executable file in one of its folders, looked at in order. An
 * empty or relative entry before it is looked up from where git runs a filter, the repository's own working tree, where
 * an agent could put a `git-lfs` of its own: then it's not found.
 */
export function programOnPath(program: string, pathVar: string | undefined): boolean {
  for (const dir of (pathVar ?? "").split(":")) {
    if (!path.isAbsolute(dir)) return false;
    const file = path.join(dir, program);
    try {
      if (fs.statSync(file).isFile()) {
        fs.accessSync(file, fs.constants.X_OK);
        return true;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // not in this folder, or not runnable there: sh would look on
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES" && code !== "ELOOP") throw err;
    }
  }
  return false;
}

let lfsLookup: { pathVar: string | undefined; found: boolean } | null = null;
/**
 * Whether git-lfs is on main's PATH, where git's filter looks for it: an app opened from the Dock has only the system's
 * folders, and a read with git-lfs's driver on would then fail ("git-lfs: command not found"). Looked up once per PATH.
 */
function gitLfsOnPath(): boolean {
  const pathVar = process.env.PATH;
  if (!lfsLookup || lfsLookup.pathVar !== pathVar) lfsLookup = { pathVar, found: programOnPath("git-lfs", pathVar) };
  return lfsLookup.found;
}

/**
 * The drivers `listing` (guardedListing's) names that are to be turned off: every one but git-lfs's own, an empty name
 * (`[filter ""]`, which git runs for `filter=` set to nothing) and a name holding "=" or dots included. git-lfs's own is
 * turned off too unless `lfsOnPath` (gitLfsOnPath's), and whenever the listing sets an `lfs.extension.*` (a command
 * git-lfs's clean runs on every file it reads) or `lfs.storage` (where that clean writes). Throws on a key it can't
 * take apart, so nothing runs with a driver it didn't see.
 */
export function driversToTurnOff(listing: string, lfsOnPath: boolean): string[] {
  const drivers = new Map<string, [string, string | null][]>();
  let lfsRuns = lfsOnPath;
  for (const entry of listing.split("\0")) {
    if (!entry) continue;
    const nl = entry.indexOf("\n");
    const key = nl < 0 ? entry : entry.slice(0, nl);
    // git spells a section and a setting in lower case, a subsection as written: `[lfs "Extension.x"]` is one too
    const lower = key.toLowerCase();
    if (lower.startsWith("lfs.")) {
      if (lower.startsWith("lfs.extension.") || lower === "lfs.storage") lfsRuns = false;
      continue;
    }
    if (!key.startsWith("filter.")) throw new Error(`git config listed ${JSON.stringify(key)} among the filter and LFS settings`);
    const rest = key.slice("filter.".length);
    const dot = rest.lastIndexOf(".");
    if (dot < 0) continue; // `[filter]` with no driver's name names no driver
    const name = rest.slice(0, dot);
    const settings = drivers.get(name) ?? [];
    settings.push([rest.slice(dot + 1), nl < 0 ? null : entry.slice(nl + 1)]);
    drivers.set(name, settings);
  }
  const isLfs = (s: [string, string | null][]) =>
    s.some(([k]) => (COMMANDS as readonly string[]).includes(k)) && s.every(([k, v]) => !(COMMANDS as readonly string[]).includes(k) || v === LFS_COMMANDS[k as (typeof COMMANDS)[number]]);
  return [...drivers].flatMap(([name, s]) => (lfsRuns && isLfs(s) ? [] : [name]));
}

/**
 * git for a folder whose repository config a session's agent can write, where git would otherwise run what that config
 * names for a read: fsmonitor's command, each filter driver's clean command on every working-tree file a diff or status
 * reads, a hook, a pager, gpg, a submodule's own diff. Its overrides go in through GIT_CONFIG_COUNT/KEY/VALUE, not `-c`:
 * `-c` splits at the first "=", so a driver named `x=y` would keep its command. Every driver the config names but
 * git-lfs's own is emptied and made optional, so git reads the files as they are (see driversToTurnOff for when
 * git-lfs's own goes too). GIT_OPTIONAL_LOCKS=0 keeps a status from rewriting the index, and so from taking index.lock
 * from the agent's own git; a diff still refreshes it when it can, with no hook run. A setting added between the listing
 * and a run (a race with something writing the config) would run: the listing is read again after each run, and a
 * change throws, setting what git gave aside and saying why. Throws too when the config can't be read: then nothing
 * would be turned off.
 */
export async function guardedGit(cwd: string, o: { timeoutMs?: number } = {}): Promise<GuardedGit> {
  const listing = await guardedListing(cwd, o.timeoutMs);
  const env = {
    ...configEnv([
      ...READ_OVERRIDES,
      ...driversToTurnOff(listing, gitLfsOnPath()).flatMap((d): Pair[] => [
        [`filter.${d}.clean`, ""],
        [`filter.${d}.smudge`, ""],
        [`filter.${d}.process`, ""],
        [`filter.${d}.required`, "false"],
      ]),
    ]),
    GIT_OPTIONAL_LOCKS: "0",
  };
  const checked = async <T extends string | Buffer>(args: readonly string[], opts: GitOptions, f: (cwd: string, args: string[], opts: GitOptions) => Promise<T>): Promise<T> => {
    const out = await f(cwd, [...args], { ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...opts, env: { ...opts.env, ...env } });
    if ((await guardedListing(cwd, o.timeoutMs)) !== listing)
      throw new Error(`git ${args[0]}: the repository's filter drivers or LFS settings changed while it ran, so a command Mockingbird hadn't turned off may have run; what it gave is set aside`);
    return out;
  };
  const run = (args: readonly string[], opts: GitOptions & { trim?: boolean } = {}) => checked(args, opts, git);
  return {
    run,
    diff: (args, opts) => run(["diff", ...SAFE_DIFF, ...args], opts),
    status: (args, opts) => run(["status", ...SAFE_STATUS, ...args], opts),
    bytes: (args, opts = {}) => checked(args, opts, gitBytes),
  };
}
