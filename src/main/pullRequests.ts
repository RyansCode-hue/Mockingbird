import { ADO_API } from "./ado";
import { BASE_NAMES, branchesOf, currentBranch, git, originRemote, remoteName, type RemoteRepo } from "./git";
import { dirtyFileCount, scmRoomPushPlan } from "./scm";
import { guardedGit } from "./safeGit";
import { listAllFiles } from "./find";
import { quote, type ShellResult } from "./shell";
import type { ShellRunner } from "./headless";
import { ADO_DESC_MAX, isWorkItemId, prBranchProblem, unrecordedBranch, type PrPreflight, type PrTarget } from "../shared/types";

/** The PR's base: the first usual name for the target that exists on origin. */
export function pickBase(target: PrTarget, remoteBranches: string[]): string | null {
  return BASE_NAMES[target].find((b) => remoteBranches.includes(b)) ?? null;
}

/**
 * Why a pull request to `target` can't merge into `base`, or null when it can:
 * the base must be a branch on origin (`bases`, from the preflight), and never
 * one of the other target's usual names — a base picked for dev and left in
 * place after switching to main would open the "to main" PR into develop.
 */
export function prBaseProblem(target: PrTarget, base: string, bases: string[]): string | null {
  if (!bases.includes(base)) return `origin has no branch ${base} — check the branch again`;
  const other: PrTarget = target === "main" ? "dev" : "main";
  if (BASE_NAMES[other].includes(base)) {
    return `${base} is ${other === "main" ? "a main" : "a dev/UAT"} branch, and this pull request is to ${target === "main" ? "main" : "dev/UAT"}`;
  }
  return null;
}

/**
 * Why main won't push a branch and open its pull request to `target` into `base`, from what its own preflight read
 * (never the form's word), or null: the base isn't the target's, the branch is a base's (the push would land on
 * it), the branch isn't the one the session was made on (`recorded`) unless the user said to push it (`confirmed`
 * names it), uncommitted files would be left out, or one is open already.
 */
export function prCreateRefusal(pre: PrPreflight & { branch: string }, target: PrTarget, base: string, o: { recorded: string | null; confirmed?: string }): string | null {
  const wrongBase = prBaseProblem(target, base, pre.bases);
  if (wrongBase) return `Can't open this pull request: ${wrongBase}`;
  const wrongBranch = prBranchProblem(pre.branch, base);
  if (wrongBranch) return `Nothing was pushed: ${wrongBranch}`;
  const unrecorded = unrecordedBranch(pre.branch, o.recorded);
  if (unrecorded && o.confirmed !== pre.branch) return `Nothing was pushed: ${unrecorded} Tick “Push ${pre.branch} anyway” in the form to push it.`;
  if (pre.dirtyFiles) return `Commit or stash the ${pre.dirtyFiles} uncommitted file${pre.dirtyFiles === 1 ? "" : "s"} first — they wouldn't be in the pull request`;
  if (pre.existing && pre.base === base) return `A pull request is already open from ${pre.branch}: ${pre.existing.url}`;
  return null;
}

/** An ADO API call with the configured PAT (ado.adoRequest), injected so tests can stub it. */
export type AdoCall = (url: string, init?: RequestInit) => Promise<any>;

/** What finding or opening a pull request needs: ADO's API, the user's shell for gh, and the repository it runs in. */
export interface PrDeps {
  ado: AdoCall;
  run: ShellRunner;
  cwd: string;
  env: Record<string, string>;
}

/** The user's gh, run in the repository, so its sign-in applies. */
export const runGh = (deps: PrDeps, cmd: string, input = "", timeoutMs = 30_000): Promise<ShellResult> =>
  deps.run(cmd, input, { cwd: deps.cwd, env: deps.env, timeoutMs });

/** A failed gh run's error: what it printed, else its exit code. */
export const ghError = (r: ShellResult): Error => new Error(`gh: ${r.out.trim().slice(0, 300) || `exited with code ${r.code}`}`);

/** A pull request's page on Azure DevOps, from its repository's page. */
export const adoPrUrl = (webUrl: string, id: number): string => `${webUrl}/pullrequest/${id}`;

/** An Azure DevOps repository: its id, its API root (`<apiUrl>/pullrequests`…) and its page. */
export async function adoRepo(call: AdoCall, r: Extract<RemoteRepo, { provider: "ado" }>): Promise<{ id: string; apiUrl: string; webUrl: string }> {
  const project = `${r.base}/${encodeURIComponent(r.project)}`;
  const repo = await call(`${project}/_apis/git/repositories/${encodeURIComponent(r.repo)}?${ADO_API}`);
  if (!repo?.id) throw new Error(`Azure DevOps has no repository ${remoteName(r)}`);
  return { id: repo.id, apiUrl: `${project}/_apis/git/repositories/${repo.id}`, webUrl: repo.webUrl ?? `${project}/_git/${encodeURIComponent(r.repo)}` };
}

/** An open pull request from `branch` into `base`, if there is one. */
export async function findOpenPr(
  remote: RemoteRepo,
  branch: string,
  base: string,
  deps: PrDeps
): Promise<{ id: number; url: string } | null> {
  if (remote.provider === "ado") {
    const repo = await adoRepo(deps.ado, remote);
    const q = `searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${branch}`)}&searchCriteria.targetRefName=${encodeURIComponent(`refs/heads/${base}`)}&searchCriteria.status=active`;
    const r = await deps.ado(`${repo.apiUrl}/pullrequests?${q}&${ADO_API}`);
    const pr = (r?.value ?? [])[0];
    return pr ? { id: pr.pullRequestId, url: adoPrUrl(repo.webUrl, pr.pullRequestId) } : null;
  }
  const r = await runGh(deps, `gh pr list --head ${quote(branch)} --base ${quote(base)} --state open --json number,url --limit 1`);
  if (r.code !== 0) throw ghError(r);
  const list = JSON.parse(r.out || "[]");
  return list[0] ? { id: list[0].number, url: list[0].url } : null;
}

/**
 * Open a pull request. On Azure DevOps the ticket's work item is linked to it;
 * on GitHub it goes through the user's `gh`, so its sign-in applies.
 */
export async function openPr(
  remote: RemoteRepo,
  pr: { branch: string; base: string; title: string; description: string; workItemId?: string },
  deps: PrDeps
): Promise<{ id: number; url: string }> {
  if (remote.provider === "ado") {
    const repo = await adoRepo(deps.ado, remote);
    const desc = pr.description.length > ADO_DESC_MAX ? `${pr.description.slice(0, ADO_DESC_MAX - 20)}\n\n(shortened)` : pr.description;
    const r = await deps.ado(`${repo.apiUrl}/pullrequests?${ADO_API}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRefName: `refs/heads/${pr.branch}`,
        targetRefName: `refs/heads/${pr.base}`,
        title: pr.title,
        description: desc,
        ...(pr.workItemId && isWorkItemId(pr.workItemId) ? { workItemRefs: [{ id: pr.workItemId }] } : {}),
      }),
    });
    if (!r?.pullRequestId) throw new Error("Azure DevOps didn't return the new pull request");
    return { id: r.pullRequestId, url: adoPrUrl(repo.webUrl, r.pullRequestId) };
  }
  const r = await runGh(deps, `gh pr create --head ${quote(pr.branch)} --base ${quote(pr.base)} --title ${quote(pr.title)} --body-file -`, pr.description, 60_000);
  const url = r.out.split("\n").map((l) => l.trim()).find((l) => /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(l));
  if (r.code !== 0 || !url) throw ghError(r);
  return { id: Number(url.split("/").pop()), url };
}

/** Explain an ADO refusal in terms of what to fix (the PAT's scopes, most often). */
export function prError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/Azure DevOps 40[13]/.test(m)) {
    return `${m}\n\nCreating pull requests needs the PAT's Code (Read & Write) scope, as well as Work Items. Add it in Azure DevOps → User settings → Personal access tokens.`;
  }
  return m;
}

/**
 * Everything the PR form shows before anything is pushed: the branch and its
 * base, uncommitted files, commits to merge, where origin lives, the ticket's
 * docs, and any pull request already open. Lookups that need the network
 * report their failure rather than hide it. A branch with a base's name is
 * said (`branchProblem`); with `own` (a team room session's push, scmPush's),
 * so is the hooks folder that push sets aside.
 */
export async function prPreflight(
  root: string,
  ticketId: string,
  target: PrTarget,
  deps: Omit<PrDeps, "cwd">,
  o: { own?: boolean } = {}
): Promise<PrPreflight & { lookupError: string | null }> {
  const branch = await currentBranch(root);
  const remoteBranches = (await branchesOf(root)).origin;
  const base = pickBase(target, remoteBranches);
  const dirtyFiles = await dirtyFileCount(root);
  const commits = base ? Number(await git(root, ["rev-list", "--count", `origin/${base}..HEAD`])) : 0;
  const remote = await originRemote(root);
  const { files } = await listAllFiles(root);
  const docs = files.find((f) => f.split("/").pop()?.toLowerCase() === `${ticketId}-description.md`.toLowerCase()) ?? null;
  let existing: { id: number; url: string } | null = null;
  let lookupError: string | null = null;
  if (remote && branch && base) {
    try {
      existing = await findOpenPr(remote, branch, base, { ...deps, cwd: root });
    } catch (err) {
      lookupError = prError(err);
    }
  }
  return {
    branch,
    base,
    bases: [...new Set([...BASE_NAMES[target].filter((b) => remoteBranches.includes(b)), ...remoteBranches])],
    dirtyFiles,
    commits,
    remote: remote ? { provider: remote.provider, repo: remoteName(remote) } : null,
    docs,
    existing,
    lookupError,
    branchProblem: branch && base ? prBranchProblem(branch, base) : null,
    ...(o.own ? { roomPush: await scmRoomPushPlan(root) } : {}),
  };
}

const MAX_DIFF = 50_000;

/** The prompt for a pull request description: the branch's commits and diff against its base. */
export async function prDescriptionPrompt(root: string, base: string, ticket: { id: string; title: string }): Promise<string> {
  const range = `origin/${base}...HEAD`;
  const g = await guardedGit(root);
  const [log, stat, diff] = await Promise.all([
    g.run(["log", "--format=- %s%n%b", `origin/${base}..HEAD`]),
    g.diff(["--stat", range]),
    g.diff([range], { trim: false }),
  ]);
  if (!log.trim()) throw new Error(`The branch has no commits that aren't on ${base} yet`);
  return [
    `Write the description of a pull request for ticket #${ticket.id} "${ticket.title}".`,
    "Use Markdown with exactly these sections:",
    "## Summary — two to four sentences: what changed and why.",
    "## Changes — short bullets, grouped by area.",
    "## Testing — how it was verified, only from what the commits say; write \"Not stated\" when they don't.",
    "Reply with the description only: no preamble and no code fences around it.",
    "",
    "Commits:",
    log,
    "",
    "Files:",
    stat,
    "",
    diff.slice(0, MAX_DIFF),
    diff.length > MAX_DIFF ? "\n(The diff was cut short; describe what's shown, the commits and the file list.)" : "",
  ].join("\n");
}

/** The Summary section of a generated description, for the ticket comment. */
export function summaryOf(description: string): string {
  const m = /##\s*Summary\s*\n([\s\S]*?)(?=\n##\s|$)/i.exec(description);
  return (m ? m[1] : description).trim();
}
