import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { listDir, readFile, gitChanges, fileDiff } from "../src/main/files";
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
});
