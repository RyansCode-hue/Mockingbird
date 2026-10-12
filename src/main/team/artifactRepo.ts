import * as fs from "fs";
import * as path from "path";
import { git, gitBytes, hasCredentials, headCommit, originUrl, repoIdentity, repoTop } from "../git";
import { checkRepoPath } from "./artifactEvents";
import { inside } from "./artifactStore";
import { originIdentity } from "./roomSessions";
import { topOfKey, type SessionInfo } from "../../shared/types";
import type { AddRepoRequest, ArtifactAdd, ArtifactRecord, RepoResolution } from "../../shared/team/artifacts";

/**
 * Repo file references (docs/team-rooms.md, "Artifacts"): a file, and
 * optionally lines, at a commit, in a repository known by its origin — so
 * each member opens it in their own clone (matched by origin, not path),
 * in a session's folder there, or as it was at that commit.
 */

type RepoRecord = Extract<ArtifactRecord, { kind: "repo" }>;

const AT_COMMIT_MAX = 1024 * 1024;
const INDEX_TTL_MS = 5 * 60_000;
const FETCH_CAP_MS = 20_000;

export interface RepoRefsDeps {
  sessions: () => SessionInfo[];
  /** Folders that may be clones of a reference's repository (sessions' repos, the repo index). */
  knownRepos: () => string[];
  log: (context: string, err: unknown) => string;
}

const short = (commit: string) => commit.slice(0, 7);
const realpathOr = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** "Spec.ts" or "Spec.ts:12–40" (a single line: "Spec.ts:12"). */
export function repoRefName(relPath: string, lines: [number, number] | null | undefined): string {
  const base = path.posix.basename(relPath);
  if (!lines) return base;
  return lines[0] === lines[1] ? `${base}:${lines[0]}` : `${base}:${lines[0]}–${lines[1]}`;
}

/** Does commit `c` exist in `dir`'s repository? */
async function hasCommit(dir: string, c: string): Promise<boolean> {
  try {
    await git(dir, ["cat-file", "-e", `${c}^{commit}`]);
    return true;
  } catch (err) {
    if (/Not a valid object name|does not exist|bad object|could not get object info/i.test((err as Error).message)) return false;
    throw err;
  }
}

export class RepoRefs {
  private index: { at: number; byPath: Map<string, string | null> } = { at: 0, byPath: new Map() };

  constructor(private d: RepoRefsDeps) {}

  /**
   * The reference to a file in a session's folder, at the session's HEAD.
   * Refuses a file that isn't committed (teammates couldn't open it); warns
   * when it has uncommitted changes (the reference is HEAD), and when HEAD
   * isn't on any remote branch (teammates can't fetch it yet).
   */
  async reference(session: SessionInfo, req: AddRepoRequest): Promise<{ body: Extract<ArtifactAdd, { kind: "repo" }>; warnings: string[] }> {
    const cwd = realpathOr(session.cwd);
    const top = await repoTop(cwd);
    if (!top) throw new Error(`${session.ticketTitle ?? session.title}'s folder isn't in a git repository`);
    const url = await originUrl(top);
    const origin = url ? originIdentity(url) : null;
    if (!url) throw new Error("The repository has no origin, so teammates couldn't find their clone of it");
    if (!origin || hasCredentials(origin)) throw new Error("The repository's origin URL can't be shared");
    const commit = await headCommit(cwd);
    if (!commit) throw new Error("The repository has no commits yet");
    const abs = path.resolve(cwd, String(req.path ?? ""));
    const realTop = realpathOr(top);
    if (!inside(realTop, abs) || abs === realTop) throw new Error(`${req.path} isn't a file in ${path.basename(top)}`);
    const rel = checkRepoPath(path.relative(realTop, abs).split(path.sep).join("/"));
    let lines: [number, number] | undefined;
    if (req.lines) {
      const [a, b] = req.lines;
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < a || b > 10_000_000) throw new Error("Lines run from the first to the last, starting at 1");
      lines = [a, b];
    }
    try {
      await git(realTop, ["cat-file", "-e", `${commit}:${rel}`]);
    } catch (err) {
      if (/does not exist|exists on disk, but not in|Not a valid object name/i.test((err as Error).message)) throw new Error(`${rel} isn't committed: commit it first, so teammates can open it`);
      throw err;
    }
    const warnings: string[] = [];
    if (await git(realTop, ["diff", "--name-only", commit, "--", rel])) warnings.push(`${rel} has uncommitted changes: the reference is HEAD ${short(commit)}, without them`);
    if (!(await git(realTop, ["branch", "-r", "--contains", commit]))) warnings.push(`${short(commit)} isn't on any remote branch: teammates can't see it until you push`);
    const name = (req.name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) || repoRefName(rel, lines);
    return { body: { kind: "repo", name, origin, path: rel, commit, ...(lines ? { lines } : {}) }, warnings };
  }

  /**
   * Where a reference opens on this Mac: a clone of its repository (by
   * origin), a live session's folder in it holding the file (`prefer` first,
   * then the room's group's sessions, then any), whether the commit is here
   * (fetching once when it isn't), whether the file changed since, and the
   * file as it was then.
   */
  async resolve(rec: RepoRecord, o: { prefer: string | null; groupKey: string | null }): Promise<RepoResolution> {
    const lines = rec.lines ?? null;
    const out: RepoResolution = { origin: rec.origin, path: rec.path, commit: rec.commit, lines, clone: null, open: null, commitPresent: false, changedSince: null, atCommit: null, problem: null };
    const want = repoIdentity(rec.origin);
    const live = this.d.sessions().filter((s) => s.status !== "dead" && s.repoPath);
    const rank = (s: SessionInfo) => (s.id === o.prefer ? 0 : o.groupKey && topOfKey(s.taskGroup ?? "ungrouped") === o.groupKey ? 1 : s.shell ? 3 : 2);
    let worktree: string | null = null;
    for (const s of [...live].sort((a, b) => rank(a) - rank(b))) {
      if ((await this.identityOf(s.repoPath!)) !== want) continue;
      let top: string | null;
      try {
        top = await repoTop(s.cwd);
      } catch (err) {
        this.d.log(`room artifacts: the repository of session ${s.id}`, err);
        continue;
      }
      if (!top) continue;
      out.clone ??= s.repoPath!;
      const abs = path.join(realpathOr(top), ...rec.path.split("/"));
      const root = realpathOr(s.cwd);
      if (!inside(root, abs)) continue;
      out.open = { sessionId: s.id, root: s.cwd, path: path.relative(root, abs), line: lines?.[0] ?? null };
      worktree = top;
      break;
    }
    if (!out.clone) out.clone = await this.cloneOf(want);
    if (!out.clone) {
      out.problem = `No clone of ${want} on this Mac`;
      return out;
    }
    const dir = worktree ?? out.clone;
    out.commitPresent = await hasCommit(dir, rec.commit);
    if (!out.commitPresent) {
      try {
        await git(dir, ["fetch", "origin"], { timeoutMs: FETCH_CAP_MS });
      } catch (err) {
        this.d.log(`room artifacts: fetching ${want} for ${short(rec.commit)}`, err);
      }
      out.commitPresent = await hasCommit(dir, rec.commit);
    }
    if (!out.commitPresent) {
      out.problem = `Commit ${short(rec.commit)} isn't in your clone — not pushed yet?`;
      return out;
    }
    try {
      out.changedSince = !!(await git(dir, ["diff", "--name-only", rec.commit, "--", rec.path]));
    } catch (err) {
      this.d.log(`room artifacts: comparing ${rec.path} with ${short(rec.commit)}`, err);
    }
    try {
      const bytes = await gitBytes(dir, ["show", `${rec.commit}:${rec.path}`]);
      if (bytes.subarray(0, 8000).includes(0)) out.problem = `${path.posix.basename(rec.path)} is a binary file`;
      else out.atCommit = { text: bytes.subarray(0, AT_COMMIT_MAX).toString("utf8"), truncated: bytes.length > AT_COMMIT_MAX };
    } catch (err) {
      out.problem = /does not exist|exists on disk, but not in/i.test((err as Error).message) ? `${rec.path} isn't in commit ${short(rec.commit)}` : `${rec.path} at ${short(rec.commit)} couldn't be read: ${(err as Error).message}`;
    }
    return out;
  }

  /** The repository's identity (repoIdentity of its origin), or null without one; remembered a few minutes. */
  private async identityOf(repo: string): Promise<string | null> {
    if (Date.now() - this.index.at > INDEX_TTL_MS) this.index = { at: Date.now(), byPath: new Map() };
    if (this.index.byPath.has(repo)) return this.index.byPath.get(repo)!;
    let id: string | null = null;
    try {
      const url = fs.existsSync(repo) ? await originUrl(repo) : null;
      id = url ? repoIdentity(url) : null;
    } catch (err) {
      this.d.log(`room artifacts: reading ${repo}'s origin`, err);
    }
    this.index.byPath.set(repo, id);
    return id;
  }

  /** This Mac's clone of the repository known as `identity`, if any. */
  private async cloneOf(identity: string): Promise<string | null> {
    for (const repo of new Set(this.d.knownRepos())) if ((await this.identityOf(repo)) === identity) return repo;
    return null;
  }
}
