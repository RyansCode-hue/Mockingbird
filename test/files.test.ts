import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { listDir, readFile, gitChanges, fileDiff, inside, branchStat, parseShortstatFiles } from "../src/main/files";
import { git, makeRepo, tempDir, write } from "./helpers";

describe("listDir", () => {
  it("lists folders before files, skipping .git and .DS_Store", async () => {
    const repo = makeRepo({ "b.txt": "b", "a.txt": "a", "src/x.ts": "x", ".DS_Store": "" });
    const names = (await listDir(repo, "")).map((e) => (e.dir ? `${e.name}/` : e.name));
    expect(names).toEqual(["src/", "a.txt", "b.txt"]);
  });
  it("returns paths relative to the session folder", async () => {
    const repo = makeRepo({ "src/deep/x.ts": "x" });
    expect(await listDir(repo, "src")).toEqual([{ name: "deep", path: "src/deep", dir: true }]);
  });
});

describe("readFile", () => {
  it("reads text", async () => {
    const repo = makeRepo({ "a.txt": "hello\n" });
    expect(await readFile(repo, "a.txt")).toMatchObject({ binary: false, content: "hello\n", truncated: false });
  });
  it("flags binary files instead of returning their bytes", async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "img.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    expect(await readFile(repo, "img.bin")).toMatchObject({ binary: true, content: "", size: 4 });
  });
  it("reads only the head of a very large file and says so", async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "big.txt"), "x".repeat(2_000_000));
    const r = await readFile(repo, "big.txt");
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBe(1_500_000);
  });
});

describe("the session-folder boundary", () => {
  it("refuses ../ paths", async () => {
    const repo = makeRepo();
    await expect(readFile(repo, "../outside.txt")).rejects.toThrow(/outside the session folder/);
    await expect(listDir(repo, "..")).rejects.toThrow(/outside the session folder/);
  });
  it("refuses a symlink that points outside, for files and folders", async () => {
    const repo = makeRepo();
    const outside = tempDir("secret");
    fs.writeFileSync(path.join(outside, "id_rsa"), "PRIVATE");
    fs.symlinkSync(path.join(outside, "id_rsa"), path.join(repo, "key"));
    fs.symlinkSync(outside, path.join(repo, "ssh"));
    await expect(readFile(repo, "key")).rejects.toThrow(/links outside the session folder/);
    await expect(listDir(repo, "ssh")).rejects.toThrow(/links outside the session folder/);
  });
  it("follows a symlink that stays inside", async () => {
    const repo = makeRepo({ "real/a.txt": "inside" });
    fs.symlinkSync(path.join(repo, "real", "a.txt"), path.join(repo, "alias.txt"));
    expect((await readFile(repo, "alias.txt")).content).toBe("inside");
  });
  it("works when the root itself is reached through a symlink", async () => {
    const repo = makeRepo({ "a.txt": "ok" });
    const link = path.join(tempDir("links"), "repo-link");
    fs.symlinkSync(repo, link);
    expect((await readFile(link, "a.txt")).content).toBe("ok");
  });
  it("is the same folder with or without a trailing slash", () => {
    expect(inside("/Users/you/WorkTracker/", "/Users/you/WorkTracker/session-digests/rollup.md")).toBe(true);
    expect(inside("/Users/you/WorkTracker", "/Users/you/WorkTracker/rollup.md")).toBe(true);
    expect(inside("/Users/you/WorkTracker/", "/Users/you/WorkTracker")).toBe(true);
    expect(inside("/Users/you/WorkTracker", "/Users/you/WorkTracker-old/x.md")).toBe(false);
    expect(inside("/Users/you/WorkTracker", "/Users/you/WorkTracker/../.ssh/id_rsa")).toBe(false);
  });
});

describe("gitChanges and fileDiff", () => {
  it("lists uncommitted modified, added, deleted and untracked files", async () => {
    const repo = makeRepo({ "keep.txt": "1\n", "gone.txt": "x\n", "edit.txt": "old\n" });
    fs.writeFileSync(path.join(repo, "edit.txt"), "new\n");
    fs.rmSync(path.join(repo, "gone.txt"));
    write(repo, { "staged.txt": "s\n", "loose.txt": "u\n" });
    git(repo, "add", "staged.txt");
    const { changes, base } = await gitChanges(repo, "working");
    expect(base).toBe("HEAD");
    expect(changes).toEqual([
      { path: "edit.txt", status: "M" },
      { path: "gone.txt", status: "D" },
      { path: "loose.txt", status: "U" },
      { path: "staged.txt", status: "A" },
    ]);
  });
  it("reports renames with their old path", async () => {
    const repo = makeRepo({ "old-name.txt": "same content that is long enough to match\n" });
    git(repo, "mv", "old-name.txt", "new-name.txt");
    const { changes } = await gitChanges(repo, "working");
    expect(changes).toEqual([{ path: "new-name.txt", from: "old-name.txt", status: "R" }]);
  });
  it("in branch scope, includes commits since the fork from the base branch", async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    git(repo, "switch", "-q", "-c", "feature");
    write(repo, { "committed.txt": "c\n" });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feature work");
    write(repo, { "a.txt": "changed\n" });
    const branch = await gitChanges(repo, "branch");
    expect(branch.base).toBe("main");
    expect(branch.changes.map((c) => `${c.status} ${c.path}`)).toEqual(["M a.txt", "A committed.txt"]);
    const working = await gitChanges(repo, "working");
    expect(working.changes.map((c) => c.path)).toEqual(["a.txt"]);
  });
  it("says so when there is no base branch to compare against", async () => {
    const repo = makeRepo();
    git(repo, "branch", "-m", "main", "trunk");
    await expect(gitChanges(repo, "branch")).rejects.toThrow(/No dev\/main-style base branch/);
  });
  it("diffs tracked and untracked files", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    write(repo, { "a.txt": "two\n", "new.txt": "fresh\n" });
    expect(await fileDiff(repo, "a.txt", "working", false)).toMatch(/-one\n\+two/);
    expect(await fileDiff(repo, "new.txt", "working", true)).toMatch(/\+fresh/);
  });
  it("diffs a renamed file as a rename, not a whole new file", async () => {
    const repo = makeRepo({ "old.txt": "one\ntwo\nthree\nfour\n" });
    git(repo, "mv", "old.txt", "new.txt");
    const d = await fileDiff(repo, "new.txt", "working", false);
    expect(d).toMatch(/rename from old\.txt\nrename to new\.txt/);
    expect(d).not.toMatch(/new file mode/);
  });
});

describe("branchStat (a card's diff badge)", () => {
  /** A repo on main with a `dev` branch, and a feature branch off dev with a commit and an uncommitted change. */
  const featureRepo = () => {
    const repo = makeRepo({ "a.txt": "one\ntwo\nthree\n", "b.txt": "b\n" });
    git(repo, "branch", "dev");
    git(repo, "switch", "-q", "-c", "feature", "dev");
    write(repo, { "c.txt": "c1\nc2\n" });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feature work");
    write(repo, { "a.txt": "one\nTWO\nthree\nfour\n" });
    return repo;
  };
  it("counts the commits and the uncommitted changes since the fork from the area repo's base", async () => {
    const repo = featureRepo();
    // c.txt's 2 lines committed; a.txt's line changed (+1 −1) and one added, uncommitted
    expect(await branchStat(repo, "dev")).toEqual({ base: "dev", files: 2, insertions: 4, deletions: 1 });
  });
  it("takes the repository's own base when the area names none, as Branch vs base does", async () => {
    const repo = featureRepo();
    expect((await branchStat(repo, null)).base).toMatch(/^(dev|main)$/);
  });
  it("is nothing for a branch with no work of its own", async () => {
    const repo = makeRepo();
    git(repo, "branch", "dev");
    expect(await branchStat(repo, "dev")).toEqual({ base: "dev", files: 0, insertions: 0, deletions: 0 });
  });
  it("fails, saying which, for a base branch the repository doesn't have, and never reads it as an option", async () => {
    const repo = featureRepo();
    await expect(branchStat(repo, "uat")).rejects.toThrow(/The base branch uat isn't in this repository/);
    await expect(branchStat(repo, "--output=/tmp/x")).rejects.toThrow(/isn't in this repository/);
  });
  it("parses git's summary line", () => {
    expect(parseShortstatFiles(" 3 files changed, 120 insertions(+), 8 deletions(-)")).toEqual({ files: 3, insertions: 120, deletions: 8 });
    expect(parseShortstatFiles(" 1 file changed, 1 deletion(-)")).toEqual({ files: 1, insertions: 0, deletions: 1 });
    expect(parseShortstatFiles("")).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });
});

describe("saving an edited file", () => {
  it("writes it, and refuses when it changed on disk since it was read", async () => {
    const { writeFile } = await import("../src/main/files");
    const repo = makeRepo({ "a.txt": "one\n" });
    const first = await readFile(repo, "a.txt");
    expect(await writeFile(repo, "a.txt", "two\n", first.mtimeMs)).toMatchObject({ saved: true });
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("two\n");
    // an agent edits it meanwhile
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(repo, "a.txt"), "agent\n");
    const r = await writeFile(repo, "a.txt", "mine\n", first.mtimeMs);
    expect(r).toMatchObject({ saved: false, conflict: true });
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("agent\n");
    // saving anyway is a choice
    expect(await writeFile(repo, "a.txt", "mine\n", null)).toMatchObject({ saved: true });
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("mine\n");
  });

  it("only writes existing files inside the folder", async () => {
    const { writeFile } = await import("../src/main/files");
    const repo = makeRepo();
    await expect(writeFile(repo, "../escape.txt", "x", null)).rejects.toThrow(/outside the session folder/);
    await expect(writeFile(repo, "new.txt", "x", null)).rejects.toThrow(/ENOENT/);
  });
});
