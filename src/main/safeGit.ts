import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { git, gitBytes, type GitOptions, withoutCredentials } from "./git";
import type { RoomPush } from "../shared/types";

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
 * under ownNetworkGit its own fetches. A fetch reads the index (for submodules), so fsmonitor off matters there too.
 * Filters stay on, as for WRITE_ENV.
 */
export const OWN_WRITE_ENV: Readonly<Record<string, string>> = configEnv([...NEUTRAL_OVERRIDES, NO_HOOKS, NO_EXT]);

/**
 * What each of Mockingbird's own network gits adds before its arguments: git's own upload-pack or receive-pack, never
 * the one a remote's config names (an override in the environment doesn't reach that: git keeps the first it reads,
 * the repository's), and no submodule's fetch or push, which would run in the submodule's own config.
 */
const OWN_FLAGS = {
  fetch: ["--upload-pack=git-upload-pack", "--recurse-submodules=no"],
  "ls-remote": ["--upload-pack=git-upload-pack"],
  push: ["--receive-pack=git-receive-pack", "--recurse-submodules=no"],
} as const;

/**
 * The values `key` has in `cwd` as git reads them there, each with its scope, in git's order (the last wins). A file
 * an `includeIf` pulls in, evaluated against `cwd`'s repository (a linked worktree's too), reports the scope of the file
 * that includes it.
 */
async function scopedValues(cwd: string, key: string, o: { path?: boolean } = {}): Promise<{ scope: string; value: string }[]> {
  // exits 1 when it's unset
  const out = await git(cwd, ["config", "-z", "--show-scope", "--includes", ...(o.path ? ["--type=path"] : []), "--get-all", key], { okCodes: [0, 1], trim: false });
  const parts = out.split("\0");
  const values: { scope: string; value: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) values.push({ scope: parts[i], value: parts[i + 1] });
  return values;
}

type Scoped = { scope: string; value: string };

/** The user's own config, not the repository's (local, worktree) or a command line's. */
const isUsers = (v: Scoped) => v.scope === "global" || v.scope === "system";

/** `s` as one word for sh. */
const shellWord = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** The program an sh command line runs: its first word after any NAME=value, unquoted. */
function programOf(command: string): string {
  let rest = command;
  for (;;) {
    const m = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(rest);
    if (!m) return "";
    rest = rest.slice(m[0].length);
    if (m[3] !== undefined && /^[A-Za-z_]\w*=/.test(m[3]) && rest.trim()) continue;
    return m[1] ?? m[2] ?? m[3];
  }
}

const realOr = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p); // a path that isn't there yet is compared as written
  }
};

/** Where `cwd`'s git runs what a setting names (its working tree's top), and each working tree of its repository. */
interface Trees {
  top: string;
  trees: string[];
}
async function treesOf(cwd: string): Promise<Trees> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const listed = await git(cwd, ["worktree", "list", "--porcelain", "-z"], { env: OWN_WRITE_ENV, trim: false });
  const trees = listed.split("\0").filter((l) => l.startsWith("worktree ")).map((l) => realOr(l.slice("worktree ".length)));
  return { top: realOr(top), trees: [...new Set([realOr(top), ...trees])] };
}

/**
 * The working tree `p` (a program or a folder a setting names) is in, when it is: relative, it's found from the top
 * of the working tree git runs in. A session's agent can write there, sandboxed or not, and Mockingbird's own gits run
 * in main, outside any sandbox.
 */
function treeHolding(p: string, t: Trees): string | null {
  const abs = realOr(path.resolve(t.top, p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p));
  return t.trees.find((tree) => abs === tree || abs.startsWith(tree + path.sep)) ?? null;
}

/** What one of Mockingbird's own network gits set aside of what the repository's config names, and why. */
export interface SetAside {
  /** The setting's value, as configured. */
  value: string;
  why: string;
}

interface OwnNetwork {
  env: Record<string, string>;
  /** The ssh run, when it's set here. */
  ssh: string | null;
  /** The core.sshCommand git would have run, set aside for `ssh`. */
  sshSetAside: SetAside | null;
  /** With `roomPush`: what the push runs, what it sets aside, and how its Git LFS files go up. */
  room: RoomPush | null;
}

/**
 * The ssh for Mockingbird's own network gits: the core.sshCommand git would run (the last of any scope, an includeIf
 * for the folder among them, the repository's own too: its config is written by the user's own tools, as room agents
 * are kept off it), unless its program is in one of the repository's working trees, relative paths included. Then the
 * one before it, and so on; with none, GIT_SSH from main's environment, quoted, else plain ssh, as git would choose.
 */
async function ownSsh(cwd: string): Promise<{ command: string; setAside: SetAside | null }> {
  const values = await scopedValues(cwd, "core.sshCommand");
  let t: Trees | null = null;
  let setAside: SetAside | null = null;
  for (const v of [...values].reverse()) {
    const program = programOf(v.value);
    // a bare name is found on PATH, as for any command main runs
    const tree = program.includes("/") ? treeHolding(program, (t ??= await treesOf(cwd))) : null;
    if (!tree) return { command: v.value, setAside };
    setAside ??= { value: v.value, why: `its program, ${program}, is in ${tree}, a working tree of this repository, which a session there can change` };
  }
  return { command: process.env.GIT_SSH ? shellWord(process.env.GIT_SSH) : "ssh", setAside };
}

/** `p` as a person reads it: from the working tree's top when it's in it, from ~ when it's in the home folder. */
function shownPath(p: string, top: string): string {
  const abs = realOr(p);
  if (abs.startsWith(top + path.sep)) return path.relative(top, abs);
  const home = realOr(os.homedir());
  return abs.startsWith(home + path.sep) ? `~/${path.relative(home, abs)}` : abs;
}

/** Whether `folder` holds a pre-push hook git would find. */
const holdsPrePush = (folder: string): boolean => fs.existsSync(path.join(folder, "pre-push"));

/**
 * The hooks for a team room session's push (a take-over backup's, the PR form's, Source Control's), which main makes as
 * the user, outside any sandbox, from a worktree the room's agent can write: the user's own core.hooksPath (the last
 * global or system value, an includeIf for the folder among them) when it's outside every working tree of the
 * repository, else none (`/dev/null`). Never the repository's own, its config's folder (Husky's `.husky/_`) nor its
 * `.git/hooks`: git runs a hook from the working tree's top, so a hook manager there (pre-commit, lefthook, Husky v4),
 * or any hook running `npm test`, `make` or a script, runs what the agent wrote. `runs` is the user's folder when it
 * holds a pre-push; `skipped` the folder git would have run one from (the one the config names, else .git/hooks) when
 * it holds one and isn't the user's; `repoHooks` that folder, where git-lfs's own pre-push is found.
 */
async function ownHooks(cwd: string): Promise<{ folder: string; runs: string | null; skipped: SetAside | null; repoHooks: string }> {
  const values = await scopedValues(cwd, "core.hooksPath", { path: true });
  const t = await treesOf(cwd);
  const users = values.filter(isUsers).at(-1);
  const folder = users && !treeHolding(users.value, t) ? users.value : NO_HOOKS[1];
  const runs = folder !== NO_HOOKS[1] && holdsPrePush(folder) ? shownPath(folder, t.top) : null;
  const wanted = values.at(-1);
  const repoHooks = wanted ? realOr(path.resolve(t.top, wanted.value)) : path.join(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "hooks");
  if ((folder !== NO_HOOKS[1] && repoHooks === realOr(folder)) || !holdsPrePush(repoHooks)) return { folder, runs, skipped: null, repoHooks };
  const why =
    wanted && treeHolding(wanted.value, t)
      ? "hooks in the working tree can be changed by the session"
      : "this repository's hooks can run files its agent writes (a hook manager's config, its scripts)";
  return { folder, runs, skipped: { value: wanted ? wanted.value : shownPath(repoHooks, t.top), why }, repoHooks };
}

/**
 * How a room session's push gets the repository's Git LFS files to the remote, with none of its hooks run (git-lfs's
 * own pre-push among them): "none" when it keeps none (no git-lfs pre-push in `repoHooks`, no `filter=lfs` on a file
 * in the index), "push" when main can upload them itself first (git lfs push), under W2's rules for running git-lfs:
 * found on main's PATH through absolute folders only, and no lfs.extension.* or lfs.storage set. Otherwise why it
 * can't: then nothing is pushed, rather than a branch whose LFS files never reached the remote.
 */
async function lfsPlan(cwd: string, repoHooks: string): Promise<RoomPush["lfs"]> {
  let hook = "";
  try {
    hook = fs.readFileSync(path.join(repoHooks, "pre-push"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" && (err as NodeJS.ErrnoException).code !== "ENOTDIR") throw err;
  }
  const g = await guardedGit(cwd);
  if (!/\bgit[- ]lfs\b/.test(hook) && !(await g.run(["ls-files", "-z", "--", ":(attr:filter=lfs)"], { trim: false }))) return "none";
  const keeps = "this repository keeps files in Git LFS, and a room session's push runs none of its hooks, git-lfs's included";
  if (!gitLfsOnPath()) return { refused: `${keeps}: git-lfs isn't on Mockingbird's PATH, so it can't upload them itself` };
  if (lfsSettingsUnsafe(await guardedListing(cwd))) return { refused: `${keeps}: its git config sets lfs.extension or lfs.storage, which Mockingbird doesn't run git-lfs with` };
  return "push";
}

/**
 * The environment for Mockingbird's own network gits in `cwd`: OWN_WRITE_ENV, with ssh as ownSsh says (GIT_SSH_COMMAND
 * in main's environment wins over any config already, and is left as it is). Hooks stay off, unless `roomPush` is set,
 * for a room session's push, whose pre-push runs from the user's own folder only (ownHooks): a secret scanner there
 * reads what's pushed first. Credential helpers stay as they are: a remote may need them.
 */
async function ownNetwork(cwd: string, o: { roomPush?: boolean } = {}): Promise<OwnNetwork> {
  const ssh = process.env.GIT_SSH_COMMAND ? null : await ownSsh(cwd);
  const sshEnv: Record<string, string> = ssh ? { GIT_SSH_COMMAND: ssh.command } : {};
  const common = { ssh: ssh?.command ?? null, sshSetAside: ssh?.setAside ?? null };
  if (!o.roomPush) return { env: { ...OWN_WRITE_ENV, ...sshEnv }, ...common, room: null };
  const hooks = await ownHooks(cwd);
  const room: RoomPush = { runs: hooks.runs, skipped: hooks.skipped, lfs: await lfsPlan(cwd, hooks.repoHooks) };
  return { env: { ...configEnv([...NEUTRAL_OVERRIDES, ["core.hooksPath", hooks.folder], NO_EXT]), ...sshEnv }, ...common, room };
}

/** ownNetwork's environment, for a test to read. */
export const ownNetworkEnv = async (cwd: string, o: { roomPush?: boolean } = {}): Promise<Record<string, string>> => (await ownNetwork(cwd, o)).env;

/** What a room session's push from `cwd` would run, set aside and do with Git LFS files (ownHooks, lfsPlan): what a form says before it. */
export async function roomPushPlan(cwd: string): Promise<RoomPush> {
  const hooks = await ownHooks(cwd);
  return { runs: hooks.runs, skipped: hooks.skipped, lfs: await lfsPlan(cwd, hooks.repoHooks) };
}

type OwnGitLog = (context: string, err: unknown) => void;
let ownGitLog: OwnGitLog = (context, err) => console.error(`[git] ${context}:`, err);
/** Where each failure of Mockingbird's own network gits is logged, and what they set aside: main's log, once the app says so. Gives the one it replaces. */
export function logOwnGitFailuresTo(log: OwnGitLog): OwnGitLog {
  const before = ownGitLog;
  ownGitLog = log;
  return before;
}

/** What was set aside, logged once a folder: it's the same at every turn. */
const toldOf = new Set<string>();
function tellOnce(cwd: string, note: string): void {
  const key = `${cwd}\n${note}`;
  if (toldOf.has(key)) return;
  toldOf.add(key);
  ownGitLog(`Mockingbird's own git in ${cwd}`, note);
}

/** A failure of one of Mockingbird's own network gits, logged already (ownNetworkGit): its caller reports it, without logging it again. */
export class OwnGitError extends Error {}
export const loggedAlready = (err: unknown): boolean => err instanceof OwnGitError;
/** A failure as a user is shown it: on one line, with no credentials a URL in it carried. */
export const shownFailure = (err: unknown): string => withoutCredentials(err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();

/** What a pre-push set aside says, on a backup's status and in the log; `pushes` names the pushes it wasn't run for. */
export const prePushNote = (s: SetAside, pushes = "backups"): string => `pre-push in ${s.value} not run for ${pushes}: ${s.why}`;

/** A team room session's push through ownNetworkGit: its hooks the user's own only (ownHooks), its LFS files sent first. */
export interface RoomPushOpts {
  /** Where its Git LFS files go before the push, when the repository keeps any: git lfs push `remote` `refs`. */
  lfs: { remote: string; refs: readonly string[] };
  /** Told what the push runs, sets aside and does with LFS files, at each run, before it's made. */
  told?: (p: RoomPush) => void;
  /** The pushes the log's note names ("backups" unless said). */
  pushes?: string;
}

/**
 * One of Mockingbird's own network gits in `cwd`: `command` with its OWN_FLAGS before `args`, under ownNetwork. What
 * it set aside is logged once (logOwnGitFailuresTo). With `roomPush`, a room session's push: what it runs is told to
 * `roomPush.told`, its Git LFS files are uploaded first (git lfs push, which a push with the repository's hooks off
 * doesn't do), and when they can't be, nothing is pushed. A failure is logged with the folder and the whole command,
 * then thrown in git's own words (OwnGitError); when it looks like ssh's and a core.sshCommand was set aside, it says
 * which and why.
 */
export async function ownNetworkGit(
  cwd: string,
  command: keyof typeof OWN_FLAGS,
  args: readonly string[],
  opts: GitOptions & { trim?: boolean; roomPush?: RoomPushOpts } = {}
): Promise<string> {
  const { roomPush, ...gitOpts } = opts;
  let all = [command, ...OWN_FLAGS[command], ...args];
  let n: OwnNetwork | null = null;
  try {
    n = await ownNetwork(cwd, { roomPush: !!roomPush });
    if (n.sshSetAside) tellOnce(cwd, `core.sshCommand ${n.sshSetAside.value} set aside for ${n.ssh}: ${n.sshSetAside.why}`);
    if (roomPush && n.room) {
      if (n.room.skipped) tellOnce(cwd, prePushNote(n.room.skipped, roomPush.pushes));
      roomPush.told?.(n.room);
      if (typeof n.room.lfs === "object") throw new Error(`Nothing was pushed: ${n.room.lfs.refused}.`);
      if (n.room.lfs === "push") {
        const lfs = ["lfs", "push", roomPush.lfs.remote, ...roomPush.lfs.refs];
        await git(cwd, lfs, { ...gitOpts, env: { ...gitOpts.env, ...n.env } }).catch((err: unknown) => {
          all = lfs;
          throw new Error(`Nothing was pushed: its Git LFS files couldn't be uploaded first: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
    return await git(cwd, all, { ...gitOpts, env: { ...gitOpts.env, ...n.env } });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    const note =
      n?.sshSetAside && /ssh|publickey|could not read from remote/i.test(why)
        ? ` (Mockingbird ran ${n.ssh}, not this repository's core.sshCommand, ${n.sshSetAside.value}: ${n.sshSetAside.why})`
        : "";
    ownGitLog(`Mockingbird's own git in ${cwd}: git ${all.join(" ")}`, `${why}${note}`);
    throw new OwnGitError(`${why}${note}`);
  }
}

/** `git fetch` as Mockingbird makes it on its own (ownNetworkGit). */
export const ownFetch = (cwd: string, args: readonly string[], opts: GitOptions = {}): Promise<string> => ownNetworkGit(cwd, "fetch", args, opts);

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
/** A setting git-lfs runs a command for (an extension) or writes where it names (its storage), in git's lower case. */
const lfsUnsafeKey = (lower: string): boolean => lower.startsWith("lfs.extension.") || lower === "lfs.storage";

/** Whether `listing` (guardedListing's) sets lfsUnsafeKey's settings: then Mockingbird runs no git-lfs. */
const lfsSettingsUnsafe = (listing: string): boolean => listing.split("\0").some((entry) => lfsUnsafeKey(entry.split("\n", 1)[0].toLowerCase()));

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
      if (lfsUnsafeKey(lower)) lfsRuns = false;
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
