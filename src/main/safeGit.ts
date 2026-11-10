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

/** Overrides as git reads them from the environment: each is one key and one value, so neither is split anywhere. */
function configEnv(pairs: readonly (readonly [string, string])[]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length), GIT_PAGER: "cat" };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** Settings that run a command whatever git does and change nothing it stores: fsmonitor's on every index read, a pager. */
const NEUTRAL_OVERRIDES: readonly (readonly [string, string])[] = [
  ["core.fsmonitor", "false"],
  ["core.pager", "cat"],
];

/**
 * The environment for git that writes a session's folder (stage, commit, discard, a WIP commit, a turn's snapshot):
 * NEUTRAL_OVERRIDES alone. Filters stay on, as they define what's stored, so a write stores what it would without
 * Mockingbird. A room's worktree can't have its config written under the room's sandbox, and a local pane is trusted.
 */
export const WRITE_ENV: Readonly<Record<string, string>> = configEnv(NEUTRAL_OVERRIDES);

/** Settings that would run a command for a read: NEUTRAL_OVERRIDES', gpg for a signature, a submodule's own diff. */
const READ_OVERRIDES: readonly (readonly [string, string])[] = [
  ...NEUTRAL_OVERRIDES,
  ["diff.submodule", "short"],
  ["status.submoduleSummary", "false"],
  ["log.showSignature", "false"],
];

const COMMANDS = ["clean", "smudge", "process"] as const;
/**
 * The commands `git lfs install` sets. A driver whose every command is exactly git-lfs's own is left on: an LFS
 * repository's working files are compared as the pointers it keeps, so with it off a file merely touched reads as
 * changed. Any other command, under any name, is turned off.
 */
const LFS_COMMANDS: Readonly<Record<(typeof COMMANDS)[number], string>> = { clean: "git-lfs clean -- %f", smudge: "git-lfs smudge -- %f", process: "git-lfs filter-process" };

/** The config's filter settings as git lists them (`key\nvalue`, each ending in a NUL), to be read and compared again. */
async function filterListing(cwd: string, timeoutMs?: number): Promise<string> {
  // exits 1 when there are none
  return git(cwd, ["config", "-z", "--get-regexp", "^filter\\."], { okCodes: [0, 1], trim: false, ...(timeoutMs ? { timeoutMs } : {}) });
}

/**
 * The drivers `listing` names that are to be turned off: every one but git-lfs's own, an empty name (`[filter ""]`, which
 * git runs for `filter=` set to nothing) and a name holding "=" or dots included. Throws on a key it can't take apart,
 * so nothing runs with a driver it didn't see.
 */
export function driversToTurnOff(listing: string): string[] {
  const drivers = new Map<string, [string, string | null][]>();
  for (const entry of listing.split("\0")) {
    if (!entry) continue;
    const nl = entry.indexOf("\n");
    const key = nl < 0 ? entry : entry.slice(0, nl);
    if (!key.startsWith("filter.")) throw new Error(`git config listed ${JSON.stringify(key)} among the filter settings`);
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
  return [...drivers].flatMap(([name, s]) => (isLfs(s) ? [] : [name]));
}

/**
 * git for a folder whose repository config a session's agent can write, where git would otherwise run what that config
 * names for a read: fsmonitor's command, each filter driver's clean command on every working-tree file a diff or status
 * reads, a pager, gpg, a submodule's own diff. Its overrides go in through GIT_CONFIG_COUNT/KEY/VALUE, not `-c`: `-c`
 * splits at the first "=", so a driver named `x=y` would keep its command. Every driver the config names but git-lfs's
 * own is emptied and made optional, so git reads the files as they are. A driver added between the listing and a run
 * (a race with something writing the config) would run: the listing is read again after each run, and a change throws,
 * setting what git gave aside and saying why. Throws too when the config can't be read: then nothing would be turned off.
 */
export async function guardedGit(cwd: string, o: { timeoutMs?: number } = {}): Promise<GuardedGit> {
  const listing = await filterListing(cwd, o.timeoutMs);
  const env = configEnv([
    ...READ_OVERRIDES,
    ...driversToTurnOff(listing).flatMap((d): [string, string][] => [
      [`filter.${d}.clean`, ""],
      [`filter.${d}.smudge`, ""],
      [`filter.${d}.process`, ""],
      [`filter.${d}.required`, "false"],
    ]),
  ]);
  const checked = async <T extends string | Buffer>(args: readonly string[], opts: GitOptions, f: (cwd: string, args: string[], opts: GitOptions) => Promise<T>): Promise<T> => {
    const out = await f(cwd, [...args], { ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...opts, env: { ...opts.env, ...env } });
    if ((await filterListing(cwd, o.timeoutMs)) !== listing)
      throw new Error(`git ${args[0]}: the repository's filter drivers changed while it ran, so a driver Mockingbird hadn't turned off may have run; what it gave is set aside`);
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
