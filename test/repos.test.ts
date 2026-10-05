import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { indexRepos } from "../src/main/repos";
import { makeRepo, tempDir } from "./helpers";

describe("indexRepos", () => {
  it("skips a folder whose .git is a dangling link, says so, and still finds the rest", () => {
    const root = tempDir("roots");
    const good = makeRepo({ "a.txt": "a\n" }, "good");
    fs.renameSync(good, path.join(root, "good"));
    fs.mkdirSync(path.join(root, "broken"));
    fs.symlinkSync(path.join(root, "nowhere"), path.join(root, "broken", ".git"));
    const skipped: string[] = [];
    const repos = indexRepos([root], (dir) => skipped.push(dir));
    expect(repos.map((r) => r.name)).toEqual(["good"]);
    expect(skipped).toEqual([path.join(root, "broken")]);
  });

  it("finds a repository named like a build folder, and skips dependency and worktree folders", () => {
    const root = tempDir("roots");
    for (const name of ["bin", "out"]) fs.renameSync(makeRepo({ "a.txt": "a\n" }, name), path.join(root, name));
    fs.mkdirSync(path.join(root, "proj", "node_modules"), { recursive: true });
    fs.renameSync(makeRepo({ "a.txt": "a\n" }, "pkg"), path.join(root, "proj", "node_modules", "pkg"));
    fs.mkdirSync(path.join(root, "worktrees"));
    fs.renameSync(makeRepo({ "a.txt": "a\n" }, "copy"), path.join(root, "worktrees", "copy"));
    expect(indexRepos([root], () => {}).map((r) => r.name)).toEqual(["bin", "out"]);
  });

  it("skips worktree checkouts, whose .git is a file", () => {
    const root = tempDir("roots");
    fs.mkdirSync(path.join(root, "wt"));
    fs.writeFileSync(path.join(root, "wt", ".git"), "gitdir: /elsewhere\n");
    expect(indexRepos([root], () => {})).toEqual([]);
  });
});
