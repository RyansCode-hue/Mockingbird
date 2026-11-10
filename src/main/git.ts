import { execFile } from "child_process";
import type { PrTarget } from "../shared/types";
import { gitPinRefusal } from "./gitPins";

const LOCAL_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 120_000; // fetch / push / pull over a slow VPN
const NETWORK = new Set(["fetch", "push", "pull"]);

/** Diffs bigger than this aren't sent to the renderer: a view that size is no use, and it would cross IPC whole. */
export const MAX_DIFF_BYTES = 3_000_000;

export interface GitOptions {
  /** Exit codes that aren't failures (`diff --no-index` exits 1 when it found differences). */
  okCodes?: number[];
  /** Extra variables (a temporary GIT_INDEX_FILE, a committer identity). */
  env?: Record<string, string>;
  /** Written to git's stdin. */
  input?: string | Buffer;
  /** Instead of the default: 30s, or 2 minutes for fetch / push / pull. */
  timeoutMs?: number;
}

function run(cwd: string, args: string[], opts: GitOptions, encoding: "utf8" | "buffer", maxBuffer: number): Promise<string | Buffer> {
  // a room session's folder runs git only while its .git leads where it did when the session started (gitPins.ts)
  const pinned = gitPinRefusal(cwd);
  if (pinned) return Promise.reject(new Error(`git ${args[0]}: ${pinned}`));
  const timeout = opts.timeoutMs ?? (NETWORK.has(args[0]) ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS);
  const ok = opts.okCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-C", cwd, ...args],
      { encoding, timeout, maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(opts.env ?? {}) } },
      (err, stdout, stderr) => {
        const code = err ? (err as any).code : 0;
        if (!err || (typeof code === "number" && ok.includes(code))) return resolve(stdout);
        const why = err.killed ? `timed out after ${timeout / 1000}s` : (String(stderr) || err.message).trim();
        reject(new Error(`git ${args[0]}: ${why}`));
      }
    );
    if (opts.input !== undefined) {
      // a git that exits before reading all its input fails with its own exit
      // code and message above; the EPIPE that follows adds nothing
      child.stdin!.on("error", () => {});
      child.stdin!.end(opts.input);
    }
  });
}

/**
 * git, off the main thread. This process also carries every pane's keystrokes,
 * so a slow repo or remote must never block it. No terminal prompts: a remote
 * that wants a password fails instead of hanging. Output is trimmed unless
 * `trim` is false.
 */
export async function git(cwd: string, args: string[], opts: GitOptions & { trim?: boolean } = {}): Promise<string> {
  const out = (await run(cwd, args, opts, "utf8", 64 * 1024 * 1024)) as string;
  return opts.trim === false ? out : out.trim();
}

/** git's output as bytes, for what must reach another git unchanged (a patch with binary or non-UTF-8 content). */
export async function gitBytes(cwd: string, args: string[], opts: GitOptions = {}): Promise<Buffer> {
  return (await run(cwd, args, opts, "buffer", 256 * 1024 * 1024)) as Buffer;
}

/**
 * HEAD's commit, or null before the first commit. `rev-parse --verify -q`
 * exits 1 only for a HEAD that doesn't resolve; anything else (not a
 * repository, a timeout) throws.
 */
export async function headCommit(cwd: string): Promise<string | null> {
  return (await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"], { okCodes: [0, 1] })) || null;
}

/** The checked-out branch, even before its first commit; null when HEAD is detached. */
export async function currentBranch(cwd: string): Promise<string | null> {
  return (await git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], { okCodes: [0, 1] })) || null; // 1: detached
}

/** git's answer outside a repository; any other failure is a real error, not a "no". */
const notARepo = (err: unknown) => /not a git repository/i.test((err as Error).message);

/** Whether `cwd` is inside a git work tree. */
export async function isRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch (err) {
    if (notARepo(err)) return false;
    throw err;
  }
}

/** The top folder of the work tree `cwd` is in, or null when it isn't in a repository. */
export async function repoTop(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch (err) {
    if (notARepo(err)) return null;
    throw err;
  }
}

/** A repository's branch names: its local ones, and origin's as of the last fetch (without the origin/ prefix). */
export async function branchesOf(repo: string): Promise<{ local: string[]; origin: string[] }> {
  const refs = (await git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"])).split("\n").filter(Boolean);
  const under = (prefix: string) => refs.filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length));
  return { local: under("refs/heads/"), origin: under("refs/remotes/origin/").filter((b) => b !== "HEAD") };
}

/** The usual names of the branches work merges into, by team convention, each in the order it's preferred. */
export const BASE_NAMES: Record<PrTarget, string[]> = { dev: ["dev", "develop", "development", "uat"], main: ["main", "master"] };

/** The base branches among `branches`, as they're named there (UAT for uat), in the usual order: dev-like ones before main. */
export function baseCandidates(branches: string[]): string[] {
  const out: string[] = [];
  for (const want of [...BASE_NAMES.dev, ...BASE_NAMES.main]) for (const b of branches) if (b.toLowerCase() === want && !out.includes(b)) out.push(b);
  return out;
}

/** The integration branch new work usually starts from: a dev-like one before main. */
export function pickDefaultBase(branches: string[]): string | null {
  return baseCandidates(branches)[0] ?? null;
}

/** origin's URL, or null when the repository has no remote called origin. */
export async function originUrl(cwd: string): Promise<string | null> {
  return (await git(cwd, ["remote", "get-url", "origin"], { okCodes: [0, 2] })) || null; // 2: no such remote
}

/** Where a repository's origin lives, read from its remote URL. */
export type RemoteRepo =
  | { provider: "ado"; base: string; project: string; repo: string }
  | { provider: "github"; owner: string; repo: string };

const dec = (s: string) => decodeURIComponent(s);

/**
 * Recognise Azure DevOps and GitHub remotes (HTTPS and SSH):
 * https://[user@]dev.azure.com/org/project/_git/repo,
 * https://org.visualstudio.com/[DefaultCollection/]project/_git/repo,
 * git@ssh.dev.azure.com:v3/org/project/repo, org@vs-ssh.visualstudio.com:v3/org/project/repo,
 * https://github.com/owner/repo(.git), git@github.com:owner/repo(.git), and the
 * same with ssh://, git://, git+https:// (package.json's form) or no scheme.
 * A repository's name may hold dots (socket.io); only a final .git is dropped.
 */
export function parseRemote(url: string): RemoteRepo | null {
  const u = url.trim();
  let m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i.exec(u);
  if (m) return { provider: "ado", base: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  m = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i.exec(u);
  if (m) return { provider: "ado", base: `https://${m[1]}.visualstudio.com`, project: dec(m[2]), repo: dec(m[3]) };
  m = /^(?:ssh:\/\/)?[^@]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):(?:\d+\/)?v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i.exec(u);
  if (m) return { provider: "ado", base: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  m = /^(?:(?:git\+)?(?:https?|ssh|git):\/\/)?(?:[^@/]+@)?(?:www\.)?github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(u);
  if (m) return { provider: "github", owner: m[1], repo: m[2] };
  return null;
}

export const remoteName = (r: RemoteRepo) => (r.provider === "ado" ? `${r.project}/${r.repo}` : `${r.owner}/${r.repo}`);

/** Where `cwd`'s origin lives, or null when there's no origin or it's neither Azure DevOps nor GitHub. */
export async function originRemote(cwd: string): Promise<RemoteRepo | null> {
  const url = await originUrl(cwd);
  return url ? parseRemote(url) : null;
}

/** The remote branch `cwd`'s branch tracks (e.g. origin/dev), or null when it tracks none or HEAD is detached. */
export async function upstreamOf(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])) || null;
  } catch (err) {
    if (/no upstream|does not point to a branch|HEAD does not point|no such branch|bad revision/i.test((err as Error).message)) return null;
    throw err;
  }
}

/** Whether commit `a` is `b` or one of its ancestors. */
export async function isAncestor(repo: string, a: string, b: string): Promise<boolean> {
  // an ancestor is its own merge base with a descendant; exit 1: no common history
  const [base, full] = await Promise.all([git(repo, ["merge-base", a, b], { okCodes: [0, 1] }), git(repo, ["rev-parse", "--verify", `${a}^{commit}`])]);
  return base === full;
}

/** A remote URL without the user name or password it may carry (https://user:token@host/…): safe to show or share. */
export function publicUrl(url: string): string {
  return url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
}

/** Whether a remote URL carries a user name or password: what publicUrl takes out. */
export const hasCredentials = (url: string): boolean => publicUrl(url) !== url.trim();

/** Text from git (an error) with any credentials in the URLs it quotes taken out. */
export function withoutCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^@/\s'"]*@/gi, "$1");
}

/**
 * One name for a repository however its remote URL is spelled — HTTPS or SSH,
 * with or without a user, a trailing .git or slash — so two laptops' clones of
 * it match: "github.com/owner/repo", "dev.azure.com/org/project/repo", or for
 * other hosts "host/path". A local path (a bare repository on disk) is itself.
 * Hosted names ignore case, as the hosts do.
 */
export function repoIdentity(url: string): string {
  const u = url.trim();
  const r = parseRemote(u);
  if (r?.provider === "github") return `github.com/${r.owner}/${r.repo}`.toLowerCase();
  if (r?.provider === "ado") {
    const org = /^https:\/\/dev\.azure\.com\/([^/]+)$/i.exec(r.base)?.[1] ?? /^https:\/\/([^.]+)\.visualstudio\.com$/i.exec(r.base)?.[1] ?? r.base;
    return `dev.azure.com/${org}/${r.project}/${r.repo}`.toLowerCase();
  }
  if (/^file:\/\//i.test(u)) return decodeURIComponent(u.replace(/^file:\/\//i, "")).replace(/\/+$/, "").replace(/\.git$/, "");
  if (u.startsWith("/") || u.startsWith("~")) return u.replace(/\/+$/, "").replace(/\.git$/, "");
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(u);
  return m ? `${m[1]}/${m[2].replace(/^\/+/, "")}`.toLowerCase() : u.toLowerCase();
}
