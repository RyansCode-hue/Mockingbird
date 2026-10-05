import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { parseRefs, scmCommit, scmCommitDiff, scmCommitFiles, scmDiff, scmDiscard, scmFetch, scmGraph, scmPull, scmPush, scmStage, scmStatus, scmUnstage } from "../src/main/scm";
import { git, makeRepo, tempDir } from "./helpers";

const id = ["-c", "user.name=t", "-c", "user.email=t@t"];

describe("source control status", () => {
  it("groups staged, unstaged, untracked and renamed files like VS Code", async () => {
    const repo = makeRepo({ "a.txt": "a\n", "b.txt": "b\n", "old name.txt": "keep\n", "gone.txt": "x\n" });
    fs.writeFileSync(path.join(repo, "a.txt"), "a2\n"); // unstaged edit
    fs.writeFileSync(path.join(repo, "b.txt"), "b2\n");
    git(repo, "add", "b.txt");
    fs.writeFileSync(path.join(repo, "b.txt"), "b3\n"); // staged and further edited
    git(repo, "mv", "old name.txt", "new name.txt");
    fs.rmSync(path.join(repo, "gone.txt"));
    fs.writeFileSync(path.join(repo, "fresh.txt"), "new\n");
    const st = await scmStatus(repo);
    expect(st.branch).toBe("main");
    expect(st.staged).toEqual([
      { path: "b.txt", status: "M" },
      { path: "new name.txt", from: "old name.txt", status: "R" },
    ]);
    expect(st.unstaged).toEqual(
      expect.arrayContaining([
        { path: "a.txt", status: "M" },
        { path: "b.txt", status: "M" },
        { path: "gone.txt", status: "D" },
        { path: "fresh.txt", status: "U" },
      ])
    );
    expect(st.unstaged).toHaveLength(4);
    expect(st.conflicted).toEqual([]);
  });
});

describe("source control actions", () => {
  it("stages and unstages, including before the first commit", async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
    await scmStage(repo, ["a.txt"]);
    expect((await scmStatus(repo)).staged).toEqual([{ path: "a.txt", status: "M" }]);
    await scmUnstage(repo, ["a.txt"]);
    expect((await scmStatus(repo)).staged).toEqual([]);

    const empty = path.join(tempDir("empty"), "r");
    fs.mkdirSync(empty, { recursive: true });
    git(empty, "init", "-q");
    fs.writeFileSync(path.join(empty, "first.txt"), "1\n");
    await scmStage(empty, ["first.txt"]);
    await scmUnstage(empty, ["first.txt"]);
    expect((await scmStatus(empty)).unstaged).toEqual([{ path: "first.txt", status: "U" }]);
  });

  it("discards an edit back to the staged copy, and sends untracked files to the trash", async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    fs.writeFileSync(path.join(repo, "a.txt"), "oops\n");
    fs.writeFileSync(path.join(repo, "scratch.txt"), "tmp\n");
    const trashed: string[] = [];
    await scmDiscard(repo, [{ path: "a.txt", untracked: false }, { path: "scratch.txt", untracked: true }], async (abs) => {
      trashed.push(abs);
    });
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("a\n");
    expect(trashed).toEqual([path.join(repo, "scratch.txt")]);
  });

  it("refuses paths outside the session's folder", async () => {
    const repo = makeRepo();
    await expect(scmStage(repo, ["../../etc/passwd"])).rejects.toThrow(/outside the session folder/);
    await expect(scmDiscard(repo, [{ path: "../x", untracked: true }], async () => {})).rejects.toThrow(/outside the session folder/);
  });

  it("commits what's staged — and says so when nothing is", async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    git(repo, "config", "user.name", "t");
    git(repo, "config", "user.email", "t@t");
    await expect(scmCommit(repo, "nothing")).rejects.toThrow(/Nothing is staged/);
    fs.writeFileSync(path.join(repo, "a.txt"), "b\n");
    await scmStage(repo, ["a.txt"]);
    await expect(scmCommit(repo, "  ")).rejects.toThrow(/Write a commit message/);
    const { sha } = await scmCommit(repo, "Change a");
    expect(sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(git(repo, "log", "-1", "--format=%s")).toBe("Change a");
  });

  it("pushes, setting the upstream the first time, and counts what's ahead", async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const remote = path.join(tempDir("remote"), "r.git");
    git(path.dirname(remote), "init", "-q", "--bare", remote);
    git(repo, "remote", "add", "origin", remote);
    git(repo, ...id, "commit", "-q", "--allow-empty", "-m", "more");
    expect((await scmStatus(repo)).upstream).toBeNull();
    expect(await scmPush(repo)).toEqual({ upstream: "origin/main" });
    git(repo, ...id, "commit", "-q", "--allow-empty", "-m", "again");
    expect(await scmStatus(repo)).toMatchObject({ upstream: "origin/main", ahead: 1, behind: 0 });
    await scmPush(repo);
    expect((await scmStatus(repo)).ahead).toBe(0);
  });

  it("diffs a staged file against HEAD and an unstaged one against the index", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    await scmStage(repo, ["a.txt"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "three\n");
    expect(await scmDiff(repo, "a.txt", true, false)).toMatch(/-one\n\+two/);
    expect(await scmDiff(repo, "a.txt", false, false)).toMatch(/-two\n\+three/);
    fs.writeFileSync(path.join(repo, "n.txt"), "new\n");
    expect(await scmDiff(repo, "n.txt", false, true)).toMatch(/\+new/);
  });

  it("diffs a staged rename as a rename", async () => {
    const repo = makeRepo({ "old.txt": "one\ntwo\nthree\nfour\n" });
    git(repo, "mv", "old.txt", "new.txt");
    const d = await scmDiff(repo, "new.txt", true, false);
    expect(d).toMatch(/rename from old\.txt\nrename to new\.txt/);
    expect(d).not.toMatch(/new file mode/);
  });

  it("refuses a diff too large to show, new file or not", async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const big = "x".repeat(100) + "\n";
    fs.writeFileSync(path.join(repo, "huge.txt"), big.repeat(40_000));
    await expect(scmDiff(repo, "huge.txt", false, true)).rejects.toThrow(/too large/);
    fs.writeFileSync(path.join(repo, "a.txt"), big.repeat(40_000));
    await expect(scmDiff(repo, "a.txt", false, false)).rejects.toThrow(/too large/);
  });
});

/** A repo with a bare origin whose dev branch has moved on, and a feature branch made from origin/dev the way Mockingbird makes worktrees. */
function featureFromDev() {
  const remote = path.join(tempDir("origin"), "o.git");
  git(path.dirname(remote), "init", "-q", "--bare", remote);
  const repo = makeRepo({ "a.txt": "a\n" });
  git(repo, "branch", "-M", "dev");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "-u", "origin", "dev");
  git(repo, "checkout", "-q", "-b", "feature/x", "origin/dev"); // tracks origin/dev
  // someone else lands two commits on dev
  const other = path.join(tempDir("other"), "o");
  git(path.dirname(other), "clone", "-q", "-b", "dev", remote, other);
  git(other, ...id, "commit", "-q", "--allow-empty", "-m", "dev one");
  git(other, ...id, "commit", "-q", "--allow-empty", "-m", "dev two");
  git(other, "push", "-q", "origin", "dev");
  return { repo, remote };
}

describe("a branch made from origin/dev", () => {
  it("isn't published until pushed — and Push publishes it under its own name, never into dev", async () => {
    const { repo, remote } = featureFromDev();
    const st = await scmStatus(repo);
    expect(st).toMatchObject({ branch: "feature/x", upstream: "origin/dev", published: false });
    git(repo, ...id, "commit", "-q", "--allow-empty", "-m", "mine");
    expect(await scmPush(repo)).toEqual({ upstream: "origin/feature/x" });
    expect(git(remote, "log", "-1", "--format=%s", "dev")).not.toBe("mine");
    expect(git(remote, "log", "-1", "--format=%s", "feature/x")).toBe("mine");
    expect(await scmStatus(repo)).toMatchObject({ upstream: "origin/feature/x", published: true });
  });

  it("pulls dev's new commits by fast-forward after a fetch", async () => {
    const { repo } = featureFromDev();
    await scmFetch(repo);
    expect((await scmStatus(repo)).behind).toBe(2);
    await scmPull(repo);
    expect(git(repo, "log", "-1", "--format=%s")).toBe("dev two");
    expect((await scmStatus(repo)).behind).toBe(0);
  });

  it("refuses to pull when both sides moved, explaining why, and changes nothing", async () => {
    const { repo } = featureFromDev();
    git(repo, ...id, "commit", "-q", "--allow-empty", "-m", "mine");
    const before = git(repo, "rev-parse", "HEAD");
    await expect(scmPull(repo)).rejects.toThrow(/both moved/);
    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("the commit graph", () => {
  it("shows HEAD, its upstream and the base with their refs, newest first", async () => {
    const { repo } = featureFromDev();
    await scmFetch(repo);
    git(repo, ...id, "commit", "-q", "--allow-empty", "-m", "mine");
    const g = await scmGraph(repo);
    expect(g.refs).toEqual(["HEAD", "origin/dev"]);
    expect(g.commits.map((c) => c.subject)).toEqual(expect.arrayContaining(["mine", "dev two", "dev one", "initial"]));
    const mine = g.commits.find((c) => c.subject === "mine")!;
    expect(mine.refs).toEqual([{ name: "feature/x", kind: "head" }]);
    expect(g.commits.find((c) => c.subject === "dev two")!.refs).toContainEqual({ name: "origin/dev", kind: "remote" });
    expect(g.head).toBe(mine.sha);
  });

  it("lists a commit's files and diffs one of them", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
    git(repo, "add", "-A");
    git(repo, ...id, "commit", "-q", "-m", "change");
    const sha = git(repo, "rev-parse", "HEAD");
    expect(await scmCommitFiles(repo, sha)).toEqual([{ path: "a.txt", status: "M" }, { path: "b.txt", status: "A" }]);
    expect(await scmCommitDiff(repo, sha, "a.txt")).toMatch(/-one\n\+two/);
    const first = git(repo, "rev-list", "--max-parents=0", "HEAD");
    expect(await scmCommitFiles(repo, first)).toEqual([{ path: "a.txt", status: "A" }]);
    await expect(scmCommitFiles(repo, "HEAD; rm -rf /")).rejects.toThrow(/Not a commit/);
  });

  it("shows a committed rename as a rename, not a whole new file", async () => {
    const repo = makeRepo({ "old.txt": "one\ntwo\nthree\nfour\nfive\n" });
    git(repo, "mv", "old.txt", "new.txt");
    fs.appendFileSync(path.join(repo, "new.txt"), "six\n");
    git(repo, "add", "-A");
    git(repo, ...id, "commit", "-q", "-m", "rename");
    const d = await scmCommitDiff(repo, git(repo, "rev-parse", "HEAD"), "new.txt");
    expect(d).toMatch(/rename from old\.txt\nrename to new\.txt/);
    expect(d).toMatch(/\+six/);
    expect(d).not.toMatch(/new file mode/);
  });

  it("is an error outside a repository, not an empty history", async () => {
    await expect(scmGraph(tempDir("plain"))).rejects.toThrow(/not a git repository/);
  });

  it("reads decorations into kinds", () => {
    expect(parseRefs("HEAD -> feature/x, origin/feature/x, origin/HEAD, tag: v1.2, dev", ["origin"])).toEqual([
      { name: "feature/x", kind: "head" },
      { name: "origin/feature/x", kind: "remote" },
      { name: "v1.2", kind: "tag" },
      { name: "dev", kind: "local" },
    ]);
  });
});
