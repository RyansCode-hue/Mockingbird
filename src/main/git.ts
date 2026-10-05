import { execFile } from "child_process";
import type { PrTarget } from "../shared/types";

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

/** Whether `cwd` is inside a git work tree. Only "not a repository" means no; other failures are real errors. */
export async function isRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch (err) {
    if (/not a git repository/i.test((err as Error).message)) return false;
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

/** The integration branch new work usually starts from: a dev-like one before main. */
export function pickDefaultBase(branches: string[]): string | null {
  return [...BASE_NAMES.dev, ...BASE_NAMES.main].find((b) => branches.includes(b)) ?? null;
}

/** origin's URL, or null when the repository has no remote called origin. */
export async function originUrl(cwd: string): Promise<string | null> {
  return (await git(cwd, ["remote", "get-url", "origin"], { okCodes: [0, 2] })) || null; // 2: no such remote
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
