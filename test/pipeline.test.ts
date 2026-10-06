import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { PipelineStore, stageComment } from "../src/main/pipeline";
import { parseRemote } from "../src/main/git";
import { findOpenPr, prBaseProblem, openPr, pickBase, prDescriptionPrompt, prError, prPreflight, summaryOf, type AdoCall } from "../src/main/pullRequests";
import type { ShellRunner } from "../src/main/headless";
import { git, makeRepo, tempDir, write } from "./helpers";

const storeFile = () => path.join(tempDir("pipeline"), "pipeline.json");

describe("the ticket pipeline store", () => {
  it("moves a ticket through stages, drafting each stage's comment", () => {
    const s = new PipelineStore(storeFile());
    const p = s.setStage("5101", "coding", { title: "Org dropdowns" });
    expect(p.stage).toBe("coding");
    expect(p.title).toBe("Org dropdowns");
    expect(p.drafts.map((d) => d.text)).toEqual(["Development has started."]);
    s.setStage("5101", "stakeholder");
    expect(s.get("5101")!.history.map((h) => h.stage)).toEqual(["coding", "stakeholder"]);
  });
  it("starts a ticket at Coding when a session opens on it, but never moves one back", () => {
    const s = new PipelineStore(storeFile());
    expect(s.startCoding("1", "t")!.stage).toBe("coding");
    s.setStage("1", "pr-dev");
    expect(s.startCoding("1")).toBeNull();
    expect(s.get("1")!.stage).toBe("pr-dev");
  });
  it("loops stakeholder feedback back to local testing, quoting it in the draft", () => {
    const s = new PipelineStore(storeFile());
    s.setStage("7", "stakeholder");
    const p = s.addFeedback("7", "The dropdown should remember the last org");
    expect(p.stage).toBe("local-test");
    expect(p.feedback[0].text).toBe("The dropdown should remember the last org");
    expect(p.drafts.at(-1)!.text).toContain("The dropdown should remember the last org");
    expect(() => s.addFeedback("7", "  ")).toThrow(/empty/);
  });
  it("records a pull request and moves to its stage with the link in the draft", () => {
    const s = new PipelineStore(storeFile());
    const pr = { target: "dev" as const, provider: "ado" as const, id: 42, url: "https://dev.azure.com/o/p/_git/r/pullrequest/42", repo: "p/r", branch: "5101-x", base: "dev", at: 1, summary: "Adds the dropdown." };
    const p = s.addPr("5101", pr);
    expect(p.stage).toBe("pr-dev");
    expect(p.prs).toHaveLength(1);
    expect(p.drafts.at(-1)!.text).toBe("Pull request to dev opened:\n\nhttps://dev.azure.com/o/p/_git/r/pullrequest/42\n5101-x → dev\n\nAdds the dropdown.");
  });
  it("keeps checklist ticks, and edits or discards drafts", () => {
    const s = new PipelineStore(storeFile());
    s.setStage("9", "coding");
    s.setCheck("9", "dev:tests", true);
    expect(s.get("9")!.checks).toEqual({ "dev:tests": true });
    s.setCheck("9", "dev:tests", false);
    expect(s.get("9")!.checks).toEqual({});
    const d = s.get("9")!.drafts[0];
    s.editDraft("9", d.id, "Started on it.");
    expect(s.findDraft("9", d.id).text).toBe("Started on it.");
    s.dropDraft("9", d.id);
    expect(s.get("9")!.drafts).toEqual([]);
    expect(() => s.dropDraft("9", d.id)).toThrow(/No draft/);
  });
  it("persists, and keeps an unreadable file aside instead of overwriting it", () => {
    const f = storeFile();
    new PipelineStore(f).setStage("3", "approved");
    expect(new PipelineStore(f).get("3")!.stage).toBe("approved");
    fs.writeFileSync(f, "{ not json");
    expect(new PipelineStore(f).all()).toEqual({});
    expect(fs.readdirSync(path.dirname(f)).some((n) => n.startsWith("pipeline.json.corrupt-"))).toBe(true);
  });
  it("opens empty, and says so, when an unreadable file can't be moved aside", () => {
    const f = storeFile();
    fs.writeFileSync(f, "{ not json");
    fs.chmodSync(path.dirname(f), 0o500); // nothing can be renamed in here
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(new PipelineStore(f).all()).toEqual({});
      expect(errors.mock.calls.some((c) => /couldn't be moved aside/.test(String(c[0])))).toBe(true);
    } finally {
      fs.chmodSync(path.dirname(f), 0o700);
      errors.mockRestore();
    }
  });
  it("drafts nothing for stages that need no comment", () => {
    expect(stageComment("ba", {})).toBeNull();
    expect(stageComment("comms", {})).toBeNull();
  });
});

describe("pull request remotes", () => {
  it("recognises Azure DevOps and GitHub remotes", () => {
    expect(parseRemote("https://acme@dev.azure.com/acme/Back%20Office/_git/backoffice")).toEqual({ provider: "ado", base: "https://dev.azure.com/acme", project: "Back Office", repo: "backoffice" });
    expect(parseRemote("https://acme.visualstudio.com/DefaultCollection/Portal/_git/client-portal")).toEqual({ provider: "ado", base: "https://acme.visualstudio.com", project: "Portal", repo: "client-portal" });
    expect(parseRemote("git@ssh.dev.azure.com:v3/acme/Portal/client-portal")).toEqual({ provider: "ado", base: "https://dev.azure.com/acme", project: "Portal", repo: "client-portal" });
    expect(parseRemote("git@github.com:RyansCode-hue/Mockingbird.git")).toEqual({ provider: "github", owner: "RyansCode-hue", repo: "Mockingbird" });
    expect(parseRemote("https://github.com/RyansCode-hue/Mockingbird")).toEqual({ provider: "github", owner: "RyansCode-hue", repo: "Mockingbird" });
    expect(parseRemote("https://gitlab.com/a/b.git")).toBeNull();
    // names with dots keep them; only a final .git goes
    expect(parseRemote("git@github.com:socketio/socket.io.git")).toEqual({ provider: "github", owner: "socketio", repo: "socket.io" });
    expect(parseRemote("https://github.com/me/my.dotted.repo")).toEqual({ provider: "github", owner: "me", repo: "my.dotted.repo" });
    for (const u of ["ssh://git@github.com/me/app.git", "git+https://github.com/me/app.git", "git://github.com/me/app", "https://www.github.com/me/app/"]) {
      expect(parseRemote(u)).toEqual({ provider: "github", owner: "me", repo: "app" });
    }
  });
  it("picks the target's usual branch name that exists on origin", () => {
    expect(pickBase("dev", ["main", "develop"])).toBe("develop");
    expect(pickBase("dev", ["main", "dev", "uat"])).toBe("dev");
    expect(pickBase("main", ["master", "dev"])).toBe("master");
    expect(pickBase("dev", ["main"])).toBeNull();
  });
  it("won't take the other target's branch as the base", () => {
    const bases = ["develop", "uat", "master", "main", "release/2.1"];
    expect(prBaseProblem("main", "develop", bases)).toMatch(/develop is a dev\/UAT branch/);
    expect(prBaseProblem("main", "uat", bases)).toMatch(/uat is a dev\/UAT branch/);
    expect(prBaseProblem("dev", "master", bases)).toMatch(/master is a main branch/);
    expect(prBaseProblem("main", "main", bases)).toBeNull();
    expect(prBaseProblem("dev", "release/2.1", bases)).toBeNull();
  });
});

describe("opening pull requests", () => {
  const ado = { provider: "ado" as const, base: "https://dev.azure.com/acme", project: "Portal", repo: "client-portal" };
  const recorder = () => {
    const calls: { url: string; method: string; body?: any }[] = [];
    const call: AdoCall = async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (/repositories\/client-portal\?/.test(url)) return { id: "repo-guid", webUrl: "https://dev.azure.com/acme/Portal/_git/client-portal" };
      if (init?.method === "POST") return { pullRequestId: 77 };
      return { value: [{ pullRequestId: 12 }] };
    };
    return { calls, call };
  };
  const noRun: ShellRunner = async () => ({ code: 1, out: "unused" });

  it("creates an ADO pull request linked to the ticket's work item", async () => {
    const { calls, call } = recorder();
    const r = await openPr(ado, { branch: "5101-x", base: "dev", title: "#5101 Org dropdowns", description: "## Summary\nx", workItemId: "5101" }, { ado: call, run: noRun, cwd: "/", env: {} });
    expect(r).toEqual({ id: 77, url: "https://dev.azure.com/acme/Portal/_git/client-portal/pullrequest/77" });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://dev.azure.com/acme/Portal/_apis/git/repositories/repo-guid/pullrequests?api-version=7.0");
    expect(post.body).toEqual({ sourceRefName: "refs/heads/5101-x", targetRefName: "refs/heads/dev", title: "#5101 Org dropdowns", description: "## Summary\nx", workItemRefs: [{ id: "5101" }] });
  });
  it("shortens a description past ADO's 4000-character limit", async () => {
    const { calls, call } = recorder();
    await openPr(ado, { branch: "b", base: "dev", title: "t", description: "x".repeat(5000) }, { ado: call, run: noRun, cwd: "/", env: {} });
    const body = calls.find((c) => c.method === "POST")!.body;
    expect(body.description.length).toBeLessThanOrEqual(4000);
    expect(body.workItemRefs).toBeUndefined();
  });
  it("finds a pull request already open from the branch", async () => {
    const { calls, call } = recorder();
    expect(await findOpenPr(ado, "5101-x", "dev", { ado: call, run: noRun, cwd: "/", env: {} })).toEqual({ id: 12, url: "https://dev.azure.com/acme/Portal/_git/client-portal/pullrequest/12" });
    expect(calls.at(-1)!.url).toContain("searchCriteria.sourceRefName=refs%2Fheads%2F5101-x");
  });
  it("opens a GitHub pull request through gh, with the description on stdin", async () => {
    const seen: { cmd: string; input: string }[] = [];
    const run: ShellRunner = async (cmd, input) => {
      seen.push({ cmd, input });
      return { code: 0, out: "Creating pull request…\nhttps://github.com/RyansCode-hue/Mockingbird/pull/9" };
    };
    const r = await openPr({ provider: "github", owner: "RyansCode-hue", repo: "Mockingbird" }, { branch: "feat/x", base: "main", title: "Add x", description: "body" }, { ado: async () => ({}), run, cwd: "/", env: {} });
    expect(r).toEqual({ id: 9, url: "https://github.com/RyansCode-hue/Mockingbird/pull/9" });
    expect(seen[0].cmd).toBe("gh pr create --head 'feat/x' --base 'main' --title 'Add x' --body-file -");
    expect(seen[0].input).toBe("body");
  });
  it("reports a failed gh run by what it printed, or by its exit code when it printed nothing", async () => {
    const quiet: ShellRunner = async () => ({ code: 4, out: "" });
    const gh = { provider: "github" as const, owner: "me", repo: "app" };
    await expect(findOpenPr(gh, "b", "main", { ado: async () => ({}), run: quiet, cwd: "/", env: {} })).rejects.toThrow("gh: exited with code 4");
    const loud: ShellRunner = async () => ({ code: 1, out: "  To get started with GitHub CLI, please run:  gh auth login\n" });
    await expect(findOpenPr(gh, "b", "main", { ado: async () => ({}), run: loud, cwd: "/", env: {} })).rejects.toThrow(/^gh: To get started/);
  });
  it("says which PAT scope is missing when ADO refuses", () => {
    expect(prError(new Error("Azure DevOps 401 Unauthorized: x"))).toMatch(/Code \(Read & Write\)/);
    expect(prError(new Error("Azure DevOps 404 Not Found: x"))).toBe("Azure DevOps 404 Not Found: x");
  });
});

describe("pull request preflight", () => {
  /** A clone whose origin has main and dev, on a ticket branch with one commit and a dirty file. */
  const setup = () => {
    const upstream = makeRepo({ "a.txt": "a\n" }, "upstream");
    git(upstream, "branch", "dev");
    const clone = path.join(tempDir("clone"), "repo");
    git(path.dirname(clone), "clone", "-q", upstream, clone);
    git(clone, "checkout", "-q", "-b", "5101-org-dropdowns", "origin/dev");
    write(clone, { "doc/features/5101-orgDropdowns/5101-Description.md": "# 5101\n", "b.txt": "b\n" });
    git(clone, "add", "-A");
    git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "Add org dropdowns");
    write(clone, { "a.txt": "changed\n" });
    return clone;
  };
  it("reports branch, base, commits, uncommitted files and the ticket docs", async () => {
    const clone = setup();
    const p = await prPreflight(clone, "5101", "dev", { ado: async () => ({}), run: async () => ({ code: 0, out: "" }), env: {} });
    expect(p.branch).toBe("5101-org-dropdowns");
    expect(p.base).toBe("dev");
    expect(p.bases.slice(0, 1)).toEqual(["dev"]);
    expect(p.bases).toContain("main");
    expect(p.commits).toBe(1);
    expect(p.dirtyFiles).toBe(1);
    expect(p.docs).toBe("doc/features/5101-orgDropdowns/5101-Description.md");
    expect(p.remote).toBeNull(); // a local path isn't a PR host
    expect(p.existing).toBeNull();
    expect(p.lookupError).toBeNull();
  });
  it("builds a description prompt from the branch's commits and diff", async () => {
    const clone = setup();
    const prompt = await prDescriptionPrompt(clone, "dev", { id: "5101", title: "Org dropdowns" });
    expect(prompt).toContain('ticket #5101 "Org dropdowns"');
    expect(prompt).toContain("- Add org dropdowns");
    expect(prompt).toContain("b.txt");
    await expect(prDescriptionPrompt(clone, "main", { id: "5101", title: "x" }).then((p) => p.length)).resolves.toBeGreaterThan(0);
  });
  it("takes the Summary section for the ticket comment", () => {
    expect(summaryOf("## Summary\nAdds x.\n\n## Changes\n- y")).toBe("Adds x.");
    expect(summaryOf("No sections here")).toBe("No sections here");
  });
});

describe("a pull request's base", () => {
  const bases = ["dev", "main", "release/2.0"];
  it("is the target's own branch, or another branch on origin", () => {
    expect(prBaseProblem("dev", "dev", bases)).toBeNull();
    expect(prBaseProblem("main", "main", bases)).toBeNull();
    expect(prBaseProblem("dev", "release/2.0", bases)).toBeNull();
  });
  it("is never the other target's branch", () => {
    expect(prBaseProblem("main", "dev", bases)).toMatch(/dev is a dev\/UAT branch, and this pull request is to main/);
    expect(prBaseProblem("dev", "main", bases)).toMatch(/main is a main branch/);
    expect(prBaseProblem("main", "develop", ["develop", "main"])).toMatch(/develop is a dev\/UAT branch/);
  });
  it("must be on origin", () => {
    expect(prBaseProblem("dev", "gone", bases)).toMatch(/origin has no branch gone/);
  });
});
