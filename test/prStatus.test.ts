import { describe, expect, it } from "vitest";
import { adoPrState, githubPrState, prStatusFor } from "../src/main/prStatus";
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
