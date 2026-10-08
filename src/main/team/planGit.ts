import { git, originUrl, parseRemote, publicUrl } from "../git";
import { baseRef } from "../files";
import { PLAN_BRANCH } from "../../shared/team/plan";

/**
 * The plan board in git: its own branch, mockingbird/plan, holding plan.md and
 * claims.json and nothing else. Commits are built with plumbing (hash-object,
 * mktree, commit-tree, update-ref), so the checked-out branch, the index and
 * the working tree are never touched. Pushes are fast-forwards only: when
 * origin moved meanwhile (a teammate pushed), the files are rendered again
 * from the room log, never merged as text, and committed on top.
 *
 * Also here: reading the branches teammates pushed, for the cross-machine
 * overlap check.
 */

export const PLAN_REF = `refs/heads/${PLAN_BRANCH}`;
const REMOTE_REF = `refs/remotes/origin/${PLAN_BRANCH}`;
const MAX_ATTEMPTS = 5;

/** The plan files as rendered from the room log, with the commit message for this change. */
export interface PlanRender {
  files: Record<string, string>;
  message: string;
}

export interface PublishResult {
  commit: string;
  /** Whether a new commit was made (false: the branch already had these files). */
  committed: boolean;
  /** Whether origin has it (false: the clone has no origin). */
  pushed: boolean;
  /** Pushes refused because origin had moved, each followed by a fresh render. */
  retries: number;
}

export interface PublishOptions {
  /** The room the branch must belong to: a branch claims.json naming another room is never overwritten. */
  roomId: string;
  /** Who the commit is by, when the repo has no user.name/user.email of its own. */
  author: { name: string; email?: string };
  /** Runs just before each push (tests: another member pushes first). */
  beforePush?: () => Promise<void>;
}

/** A canonical form of a remote URL, so two members' clones of one repo match whatever form each cloned with. */
export function originKey(url: string): string {
  const r = parseRemote(url);
  if (r?.provider === "github") return `github:${r.owner}/${r.repo}`.toLowerCase();
  if (r?.provider === "ado") return `ado:${r.base}/${r.project}/${r.repo}`.toLowerCase();
  return publicUrl(url)
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

const isRejection = (msg: string) => /\[rejected\]|non-fast-forward|fetch first|updates were rejected|cannot lock ref|failed to update ref/i.test(msg);
const noRemoteRef = (msg: string) => /couldn't find remote ref|could not find remote ref|no such ref/i.test(msg);

async function revParse(repo: string, ref: string): Promise<string | null> {
  return (await git(repo, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], { okCodes: [0, 1] })) || null;
}

/** origin's plan branch, fetched now; null when origin has none. */
async function fetchPlanTip(repo: string): Promise<string | null> {
  try {
    await git(repo, ["fetch", "-q", "--no-tags", "origin", `+${PLAN_REF}:${REMOTE_REF}`]);
  } catch (err) {
    if (noRemoteRef((err as Error).message)) return null;
    throw err;
  }
  return revParse(repo, REMOTE_REF);
}

/** A file's content at a commit, or null when it doesn't have it. */
async function fileAt(repo: string, commit: string, file: string): Promise<string | null> {
  const sha = await git(repo, ["rev-parse", "--verify", "-q", `${commit}:${file}`], { okCodes: [0, 1] });
  return sha ? git(repo, ["cat-file", "blob", sha], { trim: false }) : null;
}

/** Refuses a branch that holds another room's plan. */
async function checkRoom(repo: string, commit: string, roomId: string): Promise<void> {
  const raw = await fileAt(repo, commit, "claims.json");
  if (raw === null) return;
  let rooms: { roomId?: string }[] = [];
  try {
    rooms = JSON.parse(raw)?.rooms ?? [];
  } catch {
    throw new Error(`${PLAN_BRANCH} at ${commit.slice(0, 8)} has a claims.json that isn't JSON; Mockingbird won't overwrite it`);
  }
  const other = rooms.find((r) => r.roomId && r.roomId !== roomId);
  if (other) throw new Error(`${PLAN_BRANCH} in this repo holds another team room's plan (${other.roomId}); Mockingbird won't overwrite it`);
}

/** The worktree that has the plan branch checked out, if any: moving it would desync that checkout. */
async function checkedOutAt(repo: string): Promise<string | null> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  let wt = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) wt = line.slice(9);
    else if (line === `branch ${PLAN_REF}`) return wt;
  }
  return null;
}

async function sameFiles(repo: string, commit: string, files: Record<string, string>): Promise<boolean> {
  const names = (await git(repo, ["ls-tree", "--name-only", "-z", commit], { trim: false })).split("\0").filter(Boolean).sort();
  if (names.join("\n") !== Object.keys(files).sort().join("\n")) return false;
  for (const [name, content] of Object.entries(files)) if ((await fileAt(repo, commit, name)) !== content) return false;
  return true;
}

async function identity(repo: string, fallback: PublishOptions["author"]): Promise<Record<string, string>> {
  const name = (await git(repo, ["config", "user.name"], { okCodes: [0, 1] })) || fallback.name;
  const email = (await git(repo, ["config", "user.email"], { okCodes: [0, 1] })) || fallback.email || "mockingbird@localhost";
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

async function commitFiles(repo: string, parent: string | null, r: PlanRender, env: Record<string, string>): Promise<string> {
  const entries: string[] = [];
  for (const [name, content] of Object.entries(r.files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!/^[\w.-]+$/.test(name)) throw new Error(`not a plan file name: ${name}`);
    const blob = await git(repo, ["hash-object", "-w", "--stdin"], { input: content });
    entries.push(`100644 blob ${blob}\t${name}\n`);
  }
  const tree = await git(repo, ["mktree"], { input: entries.join("") });
  return git(repo, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", r.message], { env });
}

/**
 * Bring `repo`'s mockingbird/plan (and origin's) in line with `render()`:
 * commit on top of origin's tip and push; when origin moved meanwhile, render
 * again and retry. A branch that already holds the rendered files gets no new
 * commit. Throws when origin can't be reached or refuses for another reason.
 */
export async function publishPlan(repo: string, render: () => PlanRender, o: PublishOptions): Promise<PublishResult> {
  const busy = await checkedOutAt(repo);
  if (busy) throw new Error(`${PLAN_BRANCH} is checked out in ${busy}; Mockingbird won't move a checked-out branch — switch that worktree to another branch`);
  const hasOrigin = !!(await originUrl(repo));
  const env = await identity(repo, o.author);
  let retries = 0;
  for (let attempt = 1; ; attempt++) {
    const remote = hasOrigin ? await fetchPlanTip(repo) : null;
    const local = await revParse(repo, PLAN_REF);
    const parent = remote ?? local;
    if (parent) await checkRoom(repo, parent, o.roomId);
    const r = render();
    const committed = !parent || !(await sameFiles(repo, parent, r.files));
    const commit = committed ? await commitFiles(repo, parent, r, env) : parent!;
    if (commit !== local) await git(repo, ["update-ref", "-m", "mockingbird: plan", PLAN_REF, commit, local ?? ""]);
    if (!hasOrigin) return { commit, committed, pushed: false, retries };
    if (commit === remote) return { commit, committed: false, pushed: true, retries };
    await o.beforePush?.();
    try {
      await git(repo, ["push", "-q", "--no-verify", "origin", `${commit}:${PLAN_REF}`]);
      await git(repo, ["update-ref", REMOTE_REF, commit]);
      return { commit, committed, pushed: true, retries };
    } catch (err) {
      const msg = (err as Error).message;
      if (!isRejection(msg) || attempt >= MAX_ATTEMPTS) throw new Error(`pushing ${PLAN_BRANCH} failed${attempt > 1 ? ` after ${attempt} tries` : ""}: ${msg}`);
      retries++;
    }
  }
}

/** The plan files on origin's branch as last fetched (or the local branch), for reading back. */
export async function planFilesAt(repo: string, ref: "local" | "origin" = "local"): Promise<Record<string, string> | null> {
  const commit = await revParse(repo, ref === "local" ? PLAN_REF : REMOTE_REF);
  if (!commit) return null;
  const out: Record<string, string> = {};
  for (const name of (await git(repo, ["ls-tree", "--name-only", "-z", commit], { trim: false })).split("\0").filter(Boolean)) {
    out[name] = (await fileAt(repo, commit, name)) ?? "";
  }
  return out;
}

// ---- teammates' branches ---------------------------------------------------------------------

/** Fetch origin's branches into the clone (remote-tracking refs only). */
export async function fetchOrigin(repo: string): Promise<void> {
  await git(repo, ["fetch", "-q", "--prune", "--no-tags", "origin"]);
}

/**
 * The files a pushed branch changes against the repo's base branch (as
 * origin/<branch> was last fetched): a commit since it forked. `tip` lets a
 * caller skip branches that haven't moved.
 */
export async function pushedBranchFiles(repo: string, branch: string): Promise<{ tip: string; files: string[] } | { problem: string }> {
  const tip = await revParse(repo, `refs/remotes/origin/${branch}`);
  if (!tip) return { problem: `${branch} isn't on origin (not pushed yet)` };
  const base = await baseRef(repo);
  if (!base) return { problem: "no dev/main-style base branch to compare it with" };
  try {
    const out = await git(repo, ["diff", "--name-only", "-z", `${base}...${tip}`], { trim: false });
    return { tip, files: out.split("\0").filter(Boolean).sort() };
  } catch (err) {
    return { problem: `couldn't compare it with ${base}: ${(err as Error).message}` };
  }
}
