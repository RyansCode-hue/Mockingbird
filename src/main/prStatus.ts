import { ADO_API } from "./ado";
import { currentBranch, originRemote, parseRemote, publicUrl, remoteName, type RemoteRepo } from "./git";
import { adoPrUrl, adoRepo, ghError, prError, runGh, type PrDeps } from "./pullRequests";
import { guardedGit } from "./safeGit";
import { quote } from "./shell";
import type { PipelinePr, PrState, PrStatus } from "../shared/types";

/** A commit id as a provider gives one: anything else isn't kept, so it never reaches a prompt ({pr}). */
const COMMIT = /^[0-9a-f]{7,64}$/i;
/** A provider's time as a number, or nothing when it isn't one. */
const timeOf = (v: unknown): number | undefined => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) && t > 0 ? t : undefined;
};
/** A merged or closed pull request's commit and times, where the provider gave them. */
function ended(state: PrState["state"], commit: unknown, mergedAt: unknown, closedAt: unknown): Pick<PrState, "mergeCommit" | "mergedAt" | "closedAt"> {
  if (state === "merged") {
    const at = timeOf(mergedAt);
    return { ...(typeof commit === "string" && COMMIT.test(commit) ? { mergeCommit: commit.toLowerCase() } : {}), ...(at ? { mergedAt: at } : {}) };
  }
  const at = state === "closed" ? timeOf(closedAt) : undefined;
  return at ? { closedAt: at } : {};
}

/** ADO's reviewer votes: 10 approved, 5 approved with suggestions, 0 none, -5 waiting for the author, -10 rejected. */
const VOTE: Record<number, string> = { 10: "approved", 5: "approved with suggestions", [-5]: "waiting for author", [-10]: "rejected" };

/** An ADO pull request as the rail shows it. */
export function adoPrState(pr: any, webUrl: string): PrState {
  const votes: number[] = (pr.reviewers ?? []).map((r: any) => Number(r.vote) || 0);
  const state: PrState["state"] =
    pr.status === "completed"
      ? "merged"
      : pr.status === "abandoned"
        ? "closed"
        : votes.some((v) => v < 0)
          ? "changes"
          : pr.isDraft
            ? "draft"
            : votes.some((v) => v > 0)
              ? "approved"
              : "open";
  return {
    id: pr.pullRequestId,
    url: adoPrUrl(webUrl, pr.pullRequestId),
    title: String(pr.title ?? ""),
    base: String(pr.targetRefName ?? "").replace(/^refs\/heads\//, ""),
    state,
    conflicts: pr.mergeStatus === "conflicts",
    reviews: (pr.reviewers ?? []).filter((r: any) => Number(r.vote)).map((r: any) => `${r.displayName}: ${VOTE[Number(r.vote)] ?? r.vote}`),
    // ADO's closedDate is when it completed (merged) or was abandoned
    ...ended(state, pr.lastMergeCommit?.commitId, pr.closedDate, pr.closedDate),
  };
}

/** A GitHub pull request (`gh pr view --json …`) as the rail shows it. */
export function githubPrState(pr: any): PrState {
  const state: PrState["state"] =
    pr.state === "MERGED"
      ? "merged"
      : pr.state === "CLOSED"
        ? "closed"
        : pr.reviewDecision === "CHANGES_REQUESTED"
          ? "changes"
          : pr.isDraft
            ? "draft"
            : pr.reviewDecision === "APPROVED"
              ? "approved"
              : "open";
  return {
    id: pr.number,
    url: pr.url,
    title: String(pr.title ?? ""),
    base: String(pr.baseRefName ?? ""),
    state,
    conflicts: pr.mergeable === "CONFLICTING",
    reviews: (pr.latestReviews ?? []).map((r: any) => `${r.author?.login ?? "?"}: ${String(r.state ?? "").toLowerCase().replace(/_/g, " ")}`),
    ...ended(state, pr.mergeCommit?.oid, pr.mergedAt, pr.closedAt),
  };
}

const GH_FIELDS = "number,url,title,state,isDraft,reviewDecision,mergeable,baseRefName,latestReviews";

/** The newest pull request from `branch`: an open one first, else the latest merged or closed. */
async function findPr(remote: RemoteRepo, branch: string, deps: PrDeps): Promise<PrState | null> {
  if (remote.provider === "ado") {
    const repo = await adoRepo(deps.ado, remote);
    const q = `searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${branch}`)}&searchCriteria.status=all&$top=10`;
    const r = await deps.ado(`${repo.apiUrl}/pullrequests?${q}&${ADO_API}`);
    const list: any[] = r?.value ?? [];
    const pick = list.find((p) => p.status === "active") ?? list.sort((a, b) => String(b.creationDate).localeCompare(String(a.creationDate)))[0];
    return pick ? adoPrState(pick, repo.webUrl) : null;
  }
  const r = await runGh(deps, `gh pr view ${quote(branch)} --json ${GH_FIELDS}`);
  if (r.code !== 0) {
    if (/no pull requests found/i.test(r.out)) return null;
    throw ghError(r);
  }
  return githubPrState(JSON.parse(r.out));
}

/** The pull request of the branch checked out in `cwd`. A lookup that fails says why instead of reporting none. */
export async function prStatusFor(cwd: string, deps: Omit<PrDeps, "cwd">): Promise<PrStatus> {
  const at = Date.now();
  const branch = await currentBranch(cwd);
  if (!branch) return { branch, pr: null, at };
  const remote = await originRemote(cwd);
  if (!remote) return { branch, pr: null, at };
  try {
    return { branch, pr: await findPr(remote, branch, { ...deps, cwd }), at };
  } catch (err) {
    return { branch, pr: null, error: prError(err), at };
  }
}

/**
 * One pull request by its id, with its merge commit and when it merged or closed: what the merge watch reads
 * (prWatch.ts), in the folder `deps.cwd`. That folder's origin, read through guardedGit, has to be the repository the PR
 * was recorded in; then ADO's `pullrequests/{id}` or `gh pr view <id>`, through the calls the pane's lookup makes.
 * Whatever doesn't answer for that PR throws, saying why, so a failed read never passes for "not merged".
 */
export async function prStateById(pr: Pick<PipelinePr, "provider" | "id" | "repo">, deps: PrDeps): Promise<PrState> {
  if (!Number.isSafeInteger(pr.id) || pr.id <= 0) throw new Error(`${JSON.stringify(pr.id)} isn't a pull request id`);
  const url = await (await guardedGit(deps.cwd)).run(["remote", "get-url", "origin"], { okCodes: [0, 2] }); // 2: no such remote
  const remote = url ? parseRemote(url) : null;
  if (!remote) throw new Error(url ? `origin (${publicUrl(url)}) isn't on Azure DevOps or GitHub` : `${deps.cwd} has no origin remote`);
  if (remote.provider !== pr.provider || remoteName(remote) !== pr.repo) throw new Error(`origin in ${deps.cwd} is ${remoteName(remote)}, not ${pr.repo}, where the pull request is`);
  let st: PrState;
  if (remote.provider === "ado") {
    const repo = await adoRepo(deps.ado, remote);
    const r = await deps.ado(`${repo.apiUrl}/pullrequests/${pr.id}?${ADO_API}`);
    if (!r || typeof r !== "object") throw new Error(`Azure DevOps returned nothing for pull request ${pr.id}`);
    st = adoPrState(r, repo.webUrl);
  } else {
    const r = await runGh(deps, `gh pr view ${pr.id} --repo ${quote(remoteName(remote))} --json ${GH_FIELDS},mergeCommit,mergedAt,closedAt`);
    if (r.code !== 0) throw ghError(r);
    let out: unknown;
    try {
      out = JSON.parse(r.out);
    } catch {
      throw new Error(`gh's answer for pull request ${pr.id} wasn't JSON: ${r.out.trim().slice(0, 200)}`);
    }
    if (!out || typeof out !== "object") throw new Error(`gh returned nothing for pull request ${pr.id}`);
    st = githubPrState(out);
  }
  if (st.id !== pr.id) throw new Error(`${remote.provider === "ado" ? "Azure DevOps" : "GitHub"} answered with pull request ${JSON.stringify(st.id)}, not ${pr.id}`);
  return st;
}
