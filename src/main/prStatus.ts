import { ADO_API } from "./ado";
import { currentBranch, originRemote, type RemoteRepo } from "./git";
import { adoPrUrl, adoRepo, ghError, prError, runGh, type PrDeps } from "./pullRequests";
import { quote } from "./shell";
import type { PrState, PrStatus } from "../shared/types";

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
  };
}

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
  const r = await runGh(deps, `gh pr view ${quote(branch)} --json number,url,title,state,isDraft,reviewDecision,mergeable,baseRefName,latestReviews`);
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
