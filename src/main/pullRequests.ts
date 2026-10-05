import { git } from "./git";
import { listAllFiles } from "./find";
import { quote } from "./shell";
import type { ShellRunner } from "./headless";
import type { PrPreflight, PrTarget } from "../shared/types";

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
 * https://github.com/owner/repo(.git), git@github.com:owner/repo(.git).
 */
export function parseRemote(url: string): RemoteRepo | null {
  const u = url.trim();
  let m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i.exec(u);
  if (m) return { provider: "ado", base: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  m = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i.exec(u);
  if (m) return { provider: "ado", base: `https://${m[1]}.visualstudio.com`, project: dec(m[2]), repo: dec(m[3]) };
  m = /^(?:ssh:\/\/)?[^@]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):(?:\d+\/)?v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i.exec(u);
  if (m) return { provider: "ado", base: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(u);
  if (m) return { provider: "github", owner: m[1], repo: m[2] };
  return null;
}

export const remoteName = (r: RemoteRepo) => (r.provider === "ado" ? `${r.project}/${r.repo}` : `${r.owner}/${r.repo}`);

/** The usual names of each target branch, in the order they're preferred. */
const BASES: Record<PrTarget, string[]> = { dev: ["dev", "develop", "development", "uat"], main: ["main", "master"] };

/** The PR's base: the first usual name for the target that exists on origin. */
export function pickBase(target: PrTarget, remoteBranches: string[]): string | null {
  return BASES[target].find((b) => remoteBranches.includes(b)) ?? null;
}

/**
 * Whether a pull request for `target` may merge into `base`: any branch but
 * one of the other target's usual names — a base picked for dev and left in
 * place after switching to main would open the "to main" PR into develop.
 */
export function baseMatchesTarget(target: PrTarget, base: string): boolean {
  return !BASES[target === "dev" ? "main" : "dev"].includes(base);
}

/** An ADO API call with the configured PAT (ado.adoRequest), injected so tests can stub it. */
export type AdoCall = (url: string, init?: RequestInit) => Promise<any>;

const API = "api-version=7.0";
const adoRepoUrl = (r: Extract<RemoteRepo, { provider: "ado" }>) => `${r.base}/${encodeURIComponent(r.project)}/_apis/git/repositories/${encodeURIComponent(r.repo)}`;

async function adoRepo(call: AdoCall, r: Extract<RemoteRepo, { provider: "ado" }>): Promise<{ id: string; webUrl: string }> {
  const repo = await call(`${adoRepoUrl(r)}?${API}`);
  if (!repo?.id) throw new Error(`Azure DevOps has no repository ${remoteName(r)}`);
  return { id: repo.id, webUrl: repo.webUrl ?? `${r.base}/${encodeURIComponent(r.project)}/_git/${encodeURIComponent(r.repo)}` };
}

/** An open pull request from `branch` into `base`, if there is one. */
export async function findOpenPr(
  remote: RemoteRepo,
  branch: string,
  base: string,
  deps: { ado: AdoCall; run: ShellRunner; cwd: string; env: Record<string, string> }
): Promise<{ id: number; url: string } | null> {
  if (remote.provider === "ado") {
    const repo = await adoRepo(deps.ado, remote);
    const q = `searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${branch}`)}&searchCriteria.targetRefName=${encodeURIComponent(`refs/heads/${base}`)}&searchCriteria.status=active`;
    const r = await deps.ado(`${remote.base}/${encodeURIComponent(remote.project)}/_apis/git/repositories/${repo.id}/pullrequests?${q}&${API}`);
    const pr = (r?.value ?? [])[0];
    return pr ? { id: pr.pullRequestId, url: `${repo.webUrl}/pullrequest/${pr.pullRequestId}` } : null;
  }
  const r = await deps.run(`gh pr list --head ${quote(branch)} --base ${quote(base)} --state open --json number,url --limit 1`, "", { cwd: deps.cwd, env: deps.env, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`gh: ${r.out.trim().slice(0, 300)}`);
  const list = JSON.parse(r.out || "[]");
  return list[0] ? { id: list[0].number, url: list[0].url } : null;
}

/** ADO caps a pull request description at 4000 characters. */
const ADO_DESC_MAX = 4000;

/**
 * Open a pull request. On Azure DevOps the ticket's work item is linked to it;
 * on GitHub it goes through the user's `gh`, so its sign-in applies.
 */
export async function openPr(
  remote: RemoteRepo,
  pr: { branch: string; base: string; title: string; description: string; workItemId?: string },
  deps: { ado: AdoCall; run: ShellRunner; cwd: string; env: Record<string, string> }
): Promise<{ id: number; url: string }> {
  if (remote.provider === "ado") {
    const repo = await adoRepo(deps.ado, remote);
    const desc = pr.description.length > ADO_DESC_MAX ? `${pr.description.slice(0, ADO_DESC_MAX - 20)}\n\n(shortened)` : pr.description;
    const r = await deps.ado(`${remote.base}/${encodeURIComponent(remote.project)}/_apis/git/repositories/${repo.id}/pullrequests?${API}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRefName: `refs/heads/${pr.branch}`,
        targetRefName: `refs/heads/${pr.base}`,
        title: pr.title,
        description: desc,
        ...(pr.workItemId && /^\d+$/.test(pr.workItemId) ? { workItemRefs: [{ id: pr.workItemId }] } : {}),
      }),
    });
    if (!r?.pullRequestId) throw new Error("Azure DevOps didn't return the new pull request");
    return { id: r.pullRequestId, url: `${repo.webUrl}/pullrequest/${r.pullRequestId}` };
  }
  const r = await deps.run(`gh pr create --head ${quote(pr.branch)} --base ${quote(pr.base)} --title ${quote(pr.title)} --body-file -`, pr.description, {
    cwd: deps.cwd,
    env: deps.env,
    timeoutMs: 60_000,
  });
  const url = r.out.split("\n").map((l) => l.trim()).find((l) => /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(l));
  if (r.code !== 0 || !url) throw new Error(`gh: ${r.out.trim().slice(0, 300) || `exited with code ${r.code}`}`);
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
 * report their failure rather than hide it.
 */
export async function prPreflight(
  root: string,
  ticketId: string,
  target: PrTarget,
  deps: { ado: AdoCall; run: ShellRunner; env: Record<string, string> }
): Promise<PrPreflight & { lookupError: string | null }> {
  const branch = (await git(root, ["symbolic-ref", "--short", "-q", "HEAD"], { okCodes: [0, 1] })) || null;
  const remoteBranches = (await git(root, ["branch", "-r", "--format=%(refname:short)"]))
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("origin/") && b !== "origin/HEAD" && b !== "origin")
    .map((b) => b.slice("origin/".length));
  const base = pickBase(target, remoteBranches);
  const dirtyFiles = (await git(root, ["status", "--porcelain"])).split("\n").filter(Boolean).length;
  const commits = base ? Number(await git(root, ["rev-list", "--count", `origin/${base}..HEAD`])) : 0;
  let remote: RemoteRepo | null = null;
  const url = await git(root, ["remote", "get-url", "origin"], { okCodes: [0, 2] }); // 2: no origin
  if (url) remote = parseRemote(url);
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
    bases: [...new Set([...BASES[target].filter((b) => remoteBranches.includes(b)), ...remoteBranches])],
    dirtyFiles,
    commits,
    remote: remote ? { provider: remote.provider, repo: remoteName(remote) } : null,
    docs,
    existing,
    lookupError,
  };
}

const MAX_DIFF = 50_000;

/** The prompt for a pull request description: the branch's commits and diff against its base. */
export async function prDescriptionPrompt(root: string, base: string, ticket: { id: string; title: string }): Promise<string> {
  const range = `origin/${base}...HEAD`;
  const [log, stat, diff] = await Promise.all([
    git(root, ["log", "--format=- %s%n%b", `origin/${base}..HEAD`]),
    git(root, ["diff", "--stat", range]),
    git(root, ["diff", range], { trim: false }),
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
