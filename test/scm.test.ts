import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { scmCommit, scmDiff, scmDiscard, scmPush, scmStage, scmStatus, scmUnstage } from "../src/main/scm";
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
});
