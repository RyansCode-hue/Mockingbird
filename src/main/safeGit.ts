import { git, type GitOptions } from "./git";

/** What every diff run through GuardedGit adds: no colour, no external diff, no text conversion, no submodule. */
export const SAFE_DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"] as const;

/** git in one folder with nothing its repository's config names run: see guardedGit. */
export interface GuardedGit {
  run(args: readonly string[], opts?: GitOptions & { trim?: boolean }): Promise<string>;
  /** `git diff` with SAFE_DIFF before `args`. */
  diff(args: readonly string[], opts?: GitOptions & { trim?: boolean }): Promise<string>;
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

/** The filter drivers the config at `cwd` names (`filter.<name>.<setting>`), whatever their names hold. */
async function filterDrivers(cwd: string, timeoutMs?: number): Promise<string[]> {
  // exits 1 when there are none; -z ends each key with a NUL
  const out = await git(cwd, ["config", "-z", "--name-only", "--get-regexp", "^filter\\."], { okCodes: [0, 1], trim: false, ...(timeoutMs ? { timeoutMs } : {}) });
  const names = out
    .split(/[\0\n]/)
    .filter(Boolean)
    .map((k) => k.slice("filter.".length, k.lastIndexOf(".")));
  return [...new Set(names.filter(Boolean))];
}

/**
 * git for a folder whose repository config a session's agent can write, where git would otherwise run what that config
 * names: fsmonitor's command on every status-like read, each filter driver's clean command on every working-tree file
 * a diff reads, a pager. Its overrides go in through GIT_CONFIG_COUNT/KEY/VALUE, not `-c`: `-c` splits at the first
 * "=", so a driver named `x=y` would keep its command. Every driver the config names is emptied and made optional, so
 * git reads the files as they are; a submodule's own config is out of reach, which is why SAFE_DIFF leaves submodules
 * out. Throws when the config can't be read: then nothing would be turned off.
 */
export async function guardedGit(cwd: string, o: { timeoutMs?: number } = {}): Promise<GuardedGit> {
  const drivers = await filterDrivers(cwd, o.timeoutMs);
  const env = configEnv([
    ["core.fsmonitor", "false"],
    ["core.pager", "cat"],
    ...drivers.flatMap((d): [string, string][] => [
      [`filter.${d}.clean`, ""],
      [`filter.${d}.smudge`, ""],
      [`filter.${d}.process`, ""],
      [`filter.${d}.required`, "false"],
    ]),
  ]);
  const run = (args: readonly string[], opts: GitOptions & { trim?: boolean } = {}) => git(cwd, [...args], { ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...opts, env: { ...opts.env, ...env } });
  return { run, diff: (args, opts) => run(["diff", ...SAFE_DIFF, ...args], opts) };
}
