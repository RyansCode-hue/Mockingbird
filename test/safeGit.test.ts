import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { commitContext } from "../src/main/commitMessage";
import { changedFiles } from "../src/main/conflicts";
import { refreshBrief } from "../src/main/contextActions";
import { branchStat, fileDiff, gitChanges } from "../src/main/files";
import { listAllFiles } from "../src/main/find";
import { repoState } from "../src/main/handoff";
import { prDescriptionPrompt } from "../src/main/pullRequests";
import { ignoredCandidates } from "../src/main/runDraft";
import { driversToTurnOff, guardedGit } from "../src/main/safeGit";
import { scmCommitDiff, scmCommitFiles, scmDiff, scmGraph, scmStatus } from "../src/main/scm";
import { skippedIn } from "../src/main/snapshots";
import { excludeInRepo } from "../src/main/team/claims";
import { makeTestCopy } from "../src/main/testCopy";
import { worktreeState } from "../src/main/worktrees";
import type { SessionInfo } from "../src/shared/types";
import { git, makeRepo, tempDir, write } from "./helpers";
import { hostileRepo } from "./hostileRepo";

// each makes a repository and runs a dozen gits, which a busy machine takes a while to start
describe("git run through guardedGit", { timeout: 300_000 }, () => {
  it("runs nothing the repository's config names: drivers whose names hold '=' or nothing included", async () => {
    const h = hostileRepo();
    // each does run for a plain git, so the markers prove something (a pager needs a terminal, so it's left to the env)
    const plain = spawnSync("git", ["-C", h.repo, "diff", "dev"], { encoding: "utf8" });
    expect(plain.status, plain.stderr).toBe(0);
    expect(h.ran()).toEqual(["fsmonitor", "plain", "equals", "empty", "external"]);
    h.clear();
    expect(spawnSync("git", ["-C", h.repo, "diff", "--no-ext-diff", "dev"], { encoding: "utf8" }).status).toBe(0);
    expect(h.ran()).toContain("textconv");
    h.clear();
    expect(spawnSync("git", ["-C", h.repo, "log", "-1", "--format=%s"], { encoding: "utf8" }).stdout).toContain("signed");
    expect(h.ran()).toEqual(["gpg"]);
    h.clear();

    const g = await guardedGit(h.repo);
    const diff = await g.diff(["dev"]);
    for (const line of ["+two", "+bea", "+sea", "+dea"]) expect(diff).toContain(line);
    expect(await g.status(["--porcelain"], { trim: false })).toMatch(/^ M a\.txt$/m);
    expect(h.ran()).toEqual([]);
  });

  it("keeps the card's diff badge from running any of it, every round", async () => {
    const h = hostileRepo();
    expect(await branchStat(h.repo, "dev")).toMatchObject({ base: "dev", files: 5 });
    expect(h.ran()).toEqual([]);
  });

  it("reads no submodule's working tree for a status, so its own config runs nothing, while its commit moving still shows", async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const sub = makeRepo({ "x.txt": "x\n", ".gitattributes": "*.txt filter=subevil\n" }, "sub");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "--quiet", "add", sub, "vendor/sub");
    git(repo, "commit", "-qm", "sub");
    const inner = path.join(repo, "vendor", "sub");
    const ran = path.join(path.dirname(repo), "subclean-ran");
    const clean = path.join(path.dirname(repo), "subclean.sh");
    fs.writeFileSync(clean, `#!/bin/sh\ntouch '${ran}'\ncat\n`, { mode: 0o755 });
    git(inner, "config", "filter.subevil.clean", clean);
    // the same size, so git reads the file through its filter to tell whether it changed
    write(inner, { "x.txt": "y\n" });
    expect(spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }).stdout).toContain("vendor/sub");
    expect(fs.existsSync(ran), "a plain status asks the submodule, which runs its filter").toBe(true);
    fs.rmSync(ran);
    expect((await scmStatus(repo)).unstaged).toEqual([]);
    git(inner, "commit", "-qam", "moved");
    write(inner, { "x.txt": "z\n" });
    fs.rmSync(ran, { force: true });
    expect((await scmStatus(repo)).unstaged).toEqual([{ path: "vendor/sub", status: "M" }]);
    expect(fs.existsSync(ran)).toBe(false);
  });

  it("sets aside what a run gave when a driver was added to the config while it ran", async () => {
    const h = hostileRepo();
    const g = await guardedGit(h.repo);
    fs.appendFileSync(path.join(h.repo, ".git", "config"), `[filter "late"]\n\tclean = cat\n`);
    await expect(g.diff(["dev"])).rejects.toThrow(/filter drivers changed while it ran, so a driver Mockingbird hadn't turned off may have run/);
  });

  it("throws when the config can't be read, rather than run with nothing turned off", async () => {
    const repo = makeRepo();
    fs.appendFileSync(path.join(repo, ".git", "config"), "[broken\n");
    await expect(guardedGit(repo)).rejects.toThrow(/git config/);
  });
});

describe("main-process reads of a session's folder", { timeout: 300_000 }, () => {
  it("run nothing its config names: Source Control, Changes, the worktree card, handoffs, commit and PR drafts, test copies", async () => {
    const h = hostileRepo();
    const root = git(h.repo, "rev-list", "--max-parents=0", "HEAD");
    const attributes = git(h.repo, "rev-parse", "HEAD~1");
    git(h.repo, "update-ref", "refs/remotes/origin/dev", "dev");
    git(h.repo, "add", "b.md");
    write(h.repo, { "u.txt": "new\n" });
    const transcript = path.join(tempDir("transcript"), "t.jsonl");
    fs.writeFileSync(transcript, "");
    h.clear();
    const reads: [string, () => Promise<unknown>][] = [
      ["scmStatus", () => scmStatus(h.repo)],
      ["scmDiff unstaged", () => scmDiff(h.repo, "a.txt", false, false)],
      ["scmDiff staged", () => scmDiff(h.repo, "b.md", true, false)],
      ["scmDiff untracked", () => scmDiff(h.repo, "u.txt", false, true)],
      ["scmGraph", () => scmGraph(h.repo)],
      ["scmCommitFiles", () => scmCommitFiles(h.repo, attributes)],
      ["scmCommitFiles of the root", () => scmCommitFiles(h.repo, root)],
      ["scmCommitDiff", () => scmCommitDiff(h.repo, attributes, ".gitattributes")],
      ["scmCommitDiff of the root", () => scmCommitDiff(h.repo, root, "c.bin")],
      ["gitChanges", () => gitChanges(h.repo, "branch")],
      ["fileDiff", () => fileDiff(h.repo, "c.bin", "working", false)],
      ["fileDiff untracked", () => fileDiff(h.repo, "u.txt", "working", true)],
      ["worktreeState", () => worktreeState(h.repo)],
      ["changedFiles", () => changedFiles(h.repo)],
      ["repoState", () => repoState(h.repo)],
      ["commitContext", () => commitContext(h.repo)],
      ["prDescriptionPrompt", () => prDescriptionPrompt(h.repo, "dev", { id: "1", title: "t" })],
      ["makeTestCopy", () => makeTestCopy(h.repo, path.join(tempDir("copy"), "c"))],
      ["skippedIn", () => skippedIn(h.repo, "HEAD")],
      ["listAllFiles", () => listAllFiles(h.repo)],
      ["ignoredCandidates", () => ignoredCandidates(h.repo)],
      ["excludeInRepo", () => excludeInRepo(h.repo, { dir: "mb-plan", line: "/mb-plan/", comment: "a test's", what: "a test's copy" })],
      ["refreshBrief", () => refreshBrief({ cwd: h.repo, title: "t" } as SessionInfo, { files: [{ path: transcript, agent: "claude" }], conversationId: "c", context: { state: "none", why: "" }, rate: null, now: 0 })],
    ];
    const ran: [string, string[]][] = [];
    for (const [name, read] of reads) {
      await read();
      ran.push([name, [...h.ran()]]);
      h.clear();
    }
    expect(ran.filter(([, r]) => r.length)).toEqual([]);
    expect(await scmDiff(h.repo, "a.txt", false, false)).toContain("+two");
    expect(await scmCommitDiff(h.repo, root, "c.bin")).toContain("+see");
    expect((await scmStatus(h.repo)).staged).toEqual([{ path: "b.md", status: "M" }]);
  });

  it("give what plain git gives a repository with nothing planted", async () => {
    const repo = makeRepo({ "a.txt": "one\n", "old.txt": "moved\nwhole\n" });
    const root = git(repo, "rev-parse", "HEAD");
    write(repo, { "later.txt": "x\n" });
    git(repo, "add", "later.txt");
    git(repo, "commit", "-qm", "later");
    const later = git(repo, "rev-parse", "HEAD");
    git(repo, "mv", "old.txt", "new.txt");
    write(repo, { "a.txt": "two\n", "u.txt": "new\n" });
    const plain = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }).stdout;
    expect(await scmDiff(repo, "a.txt", false, false)).toBe(plain("diff", "-M", "--", "a.txt"));
    expect(await scmDiff(repo, "new.txt", true, false)).toBe(plain("diff", "--cached", "-M", "--", "old.txt", "new.txt"));
    expect(await scmDiff(repo, "u.txt", false, true)).toBe(plain("diff", "--no-index", "--", "/dev/null", "u.txt"));
    expect(await fileDiff(repo, "a.txt", "working", false)).toBe(plain("diff", "-M", "HEAD", "--", "a.txt"));
    expect(await scmCommitDiff(repo, root, "a.txt")).toBe(plain("show", "--format=", root, "--", "a.txt"));
    expect(await scmCommitDiff(repo, later, "later.txt")).toBe(plain("diff", "-M", `${later}^1`, later, "--", "later.txt"));
    const status = ["--porcelain=v2", "--branch", "-z", "--untracked-files=all"];
    expect(await (await guardedGit(repo)).status(status, { trim: false })).toBe(plain("status", ...status));
  });
});

describe("the drivers turned off", () => {
  const listing = (...entries: [string, string][]) => entries.map(([k, v]) => `${k}\n${v}\0`).join("");
  const LFS = [
    ["filter.lfs.clean", "git-lfs clean -- %f"],
    ["filter.lfs.smudge", "git-lfs smudge -- %f"],
    ["filter.lfs.process", "git-lfs filter-process"],
    ["filter.lfs.required", "true"],
  ] as [string, string][];
  it("are every one the config names, whatever its name holds", () => {
    expect(driversToTurnOff(listing(["filter.plain.clean", "x"], ["filter.x=y.clean", "x"], ["filter..clean", "x"], ["filter.a.b.smudge", "x"], ["filter.Caps.process", "x"]))).toEqual(["plain", "x=y", "", "a.b", "Caps"]);
  });
  it("leave git-lfs's own on, as LFS repositories can't be read without it, and nothing that only looks like it", () => {
    expect(driversToTurnOff(listing(...LFS))).toEqual([]);
    expect(driversToTurnOff(listing(...LFS, ["filter.lfs.process", "sh -c evil"]))).toEqual(["lfs"]);
    expect(driversToTurnOff(listing(["filter.lfs.clean", "git-lfs clean -- %f; sh evil.sh"], ...LFS.slice(1)))).toEqual(["lfs"]);
    expect(driversToTurnOff(listing(["filter.other.clean", "git-lfs clean -- %f"], ["filter.other.smudge", "sh evil.sh"]))).toEqual(["other"]);
    expect(driversToTurnOff(listing(["filter.lfs.required", "true"]))).toEqual(["lfs"]);
  });
  it("name nothing for a [filter] setting with no driver, and refuse a listing they can't take apart", () => {
    expect(driversToTurnOff("filter.clean\nx\0")).toEqual([]);
    expect(driversToTurnOff("")).toEqual([]);
    expect(() => driversToTurnOff("core.fsmonitor\nx\0")).toThrow(/among the filter settings/);
  });
});
