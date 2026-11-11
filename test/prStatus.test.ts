import { describe, expect, it } from "vitest";
import { adoPrState, githubPrState, prStateById, prStatusFor } from "../src/main/prStatus";
import type { ShellRunner } from "../src/main/headless";
import { git, makeRepo } from "./helpers";

const ado = (over: object) => ({ pullRequestId: 7, title: "Org dropdown", targetRefName: "refs/heads/dev", status: "active", reviewers: [], ...over });
const web = "https://dev.azure.com/acme/Portal/_git/client-portal";

describe("an ADO pull request in the rail", () => {
  it("reads review votes, drafts, merges and conflicts", () => {
    expect(adoPrState(ado({}), web)).toEqual({ id: 7, url: `${web}/pullrequest/7`, title: "Org dropdown", base: "dev", state: "open", conflicts: false, reviews: [] });
    expect(adoPrState(ado({ isDraft: true }), web).state).toBe("draft");
    const approved = adoPrState(ado({ reviewers: [{ displayName: "Sam", vote: 10 }, { displayName: "Ana", vote: 0 }] }), web);
    expect(approved.state).toBe("approved");
    expect(approved.reviews).toEqual(["Sam: approved"]);
    expect(adoPrState(ado({ reviewers: [{ displayName: "Sam", vote: 10 }, { displayName: "Ana", vote: -5 }] }), web).state).toBe("changes");
    expect(adoPrState(ado({ status: "completed" }), web).state).toBe("merged");
    expect(adoPrState(ado({ status: "abandoned" }), web).state).toBe("closed");
    expect(adoPrState(ado({ mergeStatus: "conflicts" }), web).conflicts).toBe(true);
  });
});

describe("a GitHub pull request in the rail", () => {
  it("reads the review decision and merge state", () => {
    const pr = { number: 9, url: "https://github.com/o/r/pull/9", title: "x", state: "OPEN", isDraft: false, reviewDecision: "APPROVED", mergeable: "MERGEABLE", baseRefName: "main", latestReviews: [{ author: { login: "sam" }, state: "APPROVED" }] };
    expect(githubPrState(pr)).toEqual({ id: 9, url: pr.url, title: "x", base: "main", state: "approved", conflicts: false, reviews: ["sam: approved"] });
    expect(githubPrState({ ...pr, reviewDecision: "CHANGES_REQUESTED" }).state).toBe("changes");
    expect(githubPrState({ ...pr, state: "MERGED" }).state).toBe("merged");
    expect(githubPrState({ ...pr, isDraft: true, reviewDecision: "" }).state).toBe("draft");
    expect(githubPrState({ ...pr, mergeable: "CONFLICTING" }).conflicts).toBe(true);
  });
});

describe("looking up a folder's pull request", () => {
  const noRun: ShellRunner = async () => ({ code: 1, out: "unused" });
  it("finds none without a PR host", async () => {
    const repo = makeRepo();
    expect(await prStatusFor(repo, { ado: async () => ({}), run: noRun, env: {} })).toMatchObject({ branch: "main", pr: null });
  });
  it("prefers the open ADO pull request, and says why a lookup failed", async () => {
    const repo = makeRepo();
    git(repo, "remote", "add", "origin", "https://dev.azure.com/acme/Portal/_git/client-portal");
    const list = [
      { ...ado({ pullRequestId: 3, status: "completed", creationDate: "2026-09-01" }) },
      { ...ado({ pullRequestId: 5, status: "active", creationDate: "2026-08-01" }) },
    ];
    const call = async (url: string) => (url.includes("/pullrequests?") ? { value: list } : { id: "guid", webUrl: web });
    expect((await prStatusFor(repo, { ado: call, run: noRun, env: {} })).pr?.id).toBe(5);
    const denied = await prStatusFor(repo, { ado: async () => { throw new Error("Azure DevOps 401 Unauthorized: x"); }, run: noRun, env: {} });
    expect(denied.pr).toBeNull();
    expect(denied.error).toMatch(/Code \(Read & Write\)/);
  });
  it("treats gh's 'no pull requests found' as none, not a failure", async () => {
    const repo = makeRepo();
    git(repo, "remote", "add", "origin", "git@github.com:o/r.git");
    const none: ShellRunner = async () => ({ code: 1, out: 'no pull requests found for branch "main"' });
    expect(await prStatusFor(repo, { ado: async () => ({}), run: none, env: {} })).toMatchObject({ pr: null });
    const broken: ShellRunner = async () => ({ code: 1, out: "gh: To get started with GitHub CLI, please run: gh auth login" });
    expect((await prStatusFor(repo, { ado: async () => ({}), run: broken, env: {} })).error).toMatch(/gh auth login/);
  });
});

describe("one pull request by its id, for the merge watch", () => {
  const noRun: ShellRunner = async () => ({ code: 1, out: "unused" });
  const withOrigin = (url: string) => {
    const repo = makeRepo();
    git(repo, "remote", "add", "origin", url);
    return repo;
  };
  const adoAt = (repo: string, pr: object | null, urls: string[] = []) => ({
    ado: async (url: string) => {
      urls.push(url);
      return url.includes("/pullrequests/7?") ? pr : { id: "guid", webUrl: web };
    },
    run: noRun,
    env: {},
    cwd: repo,
  });
  const ADO_PR = { provider: "ado" as const, id: 7, repo: "Portal/client-portal", url: `${web}/pullrequest/7` };
  const GH_PR = { provider: "github" as const, id: 9, repo: "o/r", url: "https://github.com/o/r/pull/9" };

  it("reads an ADO pull request at pullrequests/{id}, with its merge commit and when it merged or closed", async () => {
    const repo = withOrigin("https://dev.azure.com/acme/Portal/_git/client-portal");
    const urls: string[] = [];
    const merged = ado({ status: "completed", closedDate: "2026-11-11T14:02:00Z", lastMergeCommit: { commitId: "ABCDEF1234567890ABCDEF1234567890ABCDEF12" } });
    expect(await prStateById(ADO_PR, adoAt(repo, merged, urls))).toMatchObject({ id: 7, state: "merged", mergeCommit: "abcdef1234567890abcdef1234567890abcdef12", mergedAt: Date.parse("2026-11-11T14:02:00Z") });
    expect(urls.at(-1)).toBe("https://dev.azure.com/acme/Portal/_apis/git/repositories/guid/pullrequests/7?api-version=7.0");
    const abandoned = await prStateById(ADO_PR, adoAt(repo, ado({ status: "abandoned", closedDate: "2026-11-10T09:00:00Z" })));
    expect(abandoned).toMatchObject({ state: "closed", closedAt: Date.parse("2026-11-10T09:00:00Z") });
    expect(abandoned.mergeCommit).toBeUndefined();
    const open = await prStateById(ADO_PR, adoAt(repo, ado({ lastMergeCommit: { commitId: "abcdef1234567" } })));
    expect(open).toEqual({ id: 7, url: `${web}/pullrequest/7`, title: "Org dropdown", base: "dev", state: "open", conflicts: false, reviews: [] });
    // a commit id that isn't one is never kept, so it can't reach a prompt
    expect((await prStateById(ADO_PR, adoAt(repo, ado({ status: "completed", lastMergeCommit: { commitId: "$(rm -rf /)" } })))).mergeCommit).toBeUndefined();
  });

  it("reads a GitHub pull request with gh pr view <n>, naming the repository it was recorded in", async () => {
    const repo = withOrigin("git@github.com:o/r.git");
    const cmds: { cmd: string; cwd?: string }[] = [];
    const run: ShellRunner = async (cmd, _input, opts) => {
      cmds.push({ cmd, cwd: opts?.cwd });
      return { code: 0, out: JSON.stringify({ number: 9, url: "https://github.com/o/r/pull/9", title: "x", state: "MERGED", baseRefName: "main", mergeCommit: { oid: "0123456789abcdef0123456789abcdef01234567" }, mergedAt: "2026-11-11T15:00:00Z" }) };
    };
    const st = await prStateById(GH_PR, { ado: async () => ({}), run, env: {}, cwd: repo });
    expect(st).toMatchObject({ id: 9, state: "merged", base: "main", mergeCommit: "0123456789abcdef0123456789abcdef01234567", mergedAt: Date.parse("2026-11-11T15:00:00Z") });
    expect(cmds).toEqual([{ cmd: expect.stringMatching(/^gh pr view 9 --repo 'o\/r' --json \S*,mergeCommit,mergedAt,closedAt$/), cwd: repo }]);
    const closed: ShellRunner = async () => ({ code: 0, out: JSON.stringify({ number: 9, url: "https://github.com/O/R/pull/9/", state: "CLOSED", closedAt: "2026-11-10T08:00:00Z" }) });
    expect(await prStateById(GH_PR, { ado: async () => ({}), run: closed, env: {}, cwd: repo })).toMatchObject({ state: "closed", closedAt: Date.parse("2026-11-10T08:00:00Z") });
  });

  it("throws, saying why, rather than answer as if it hadn't merged", async () => {
    const gh = withOrigin("https://github.com/o/r.git");
    const at = (run: ShellRunner) => prStateById(GH_PR, { ado: async () => ({}), run, env: {}, cwd: gh });
    await expect(at(async () => ({ code: 1, out: "HTTP 401: Bad credentials" }))).rejects.toThrow(/gh: HTTP 401: Bad credentials/);
    await expect(at(async () => ({ code: 0, out: "<html>" }))).rejects.toThrow(/gh's answer for pull request 9 wasn't JSON/);
    await expect(at(async () => ({ code: 0, out: JSON.stringify({ number: 8, state: "MERGED" }) }))).rejects.toThrow(/GitHub answered with pull request 8, not 9/);
    // the answer has to be for the PR's own page
    await expect(at(async () => ({ code: 0, out: JSON.stringify({ number: 9, url: "https://github.com/o/fork/pull/9", state: "MERGED" }) }))).rejects.toThrow(/GitHub answered for https:\/\/github.com\/o\/fork\/pull\/9, not https:\/\/github.com\/o\/r\/pull\/9/);
    // the folder's origin has to be the repository the PR was recorded in, on its provider
    await expect(prStateById({ ...GH_PR, repo: "o/other" }, { ado: async () => ({}), run: noRun, env: {}, cwd: gh })).rejects.toThrow(/origin in .* is o\/r, not o\/other/);
    await expect(prStateById({ ...GH_PR, provider: "ado" }, { ado: async () => ({}), run: noRun, env: {}, cwd: gh })).rejects.toThrow(/is o\/r, not o\/r, where the pull request is/);
    await expect(prStateById(GH_PR, { ado: async () => ({}), run: noRun, env: {}, cwd: makeRepo() })).rejects.toThrow(/has no origin remote/);
    await expect(prStateById({ ...GH_PR, id: 0 }, { ado: async () => ({}), run: noRun, env: {}, cwd: gh })).rejects.toThrow(/isn't a pull request id/);
    const az = withOrigin("https://dev.azure.com/acme/Portal/_git/client-portal");
    const denied = async () => {
      throw new Error("Azure DevOps 401 Unauthorized: x");
    };
    await expect(prStateById(ADO_PR, { ...adoAt(az, {}), ado: denied })).rejects.toThrow(/401/);
    await expect(prStateById(ADO_PR, adoAt(az, ado({ pullRequestId: 6 })))).rejects.toThrow(/Azure DevOps answered with pull request 6, not 7/);
    await expect(prStateById(ADO_PR, adoAt(az, null))).rejects.toThrow(/Azure DevOps returned nothing for pull request 7/);
    // the same project and repository in another ADO organization isn't the PR's
    const otherOrg = async (url: string) => (url.includes("/pullrequests/7?") ? ado({}) : { id: "guid", webUrl: "https://dev.azure.com/other/Portal/_git/client-portal" });
    await expect(prStateById(ADO_PR, { ...adoAt(az, {}), ado: otherOrg })).rejects.toThrow(/Azure DevOps answered for https:\/\/dev.azure.com\/other\/.*, not https:\/\/dev.azure.com\/acme\//);
  });
});
