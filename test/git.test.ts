import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { currentBranch, isRepo, originUrl, repoTop } from "../src/main/git";
import { git, makeRepo, tempDir } from "./helpers";

describe("asking git about a folder", () => {
  it("tells a repository (and a folder inside one) from a plain folder", async () => {
    const repo = makeRepo({ "src/a.txt": "a\n" });
    const plain = tempDir("plain");
    expect(await isRepo(repo)).toBe(true);
    expect(await isRepo(path.join(repo, "src"))).toBe(true);
    expect(await isRepo(plain)).toBe(false);
    expect(await repoTop(path.join(repo, "src"))).toBe(fs.realpathSync(repo));
    expect(await repoTop(plain)).toBeNull();
  });

  it("fails, rather than answering no, when git can't look at the folder", async () => {
    const missing = path.join(tempDir("gone"), "nowhere");
    await expect(isRepo(missing)).rejects.toThrow(/git rev-parse/);
    await expect(repoTop(missing)).rejects.toThrow(/git rev-parse/);
  });

  it("reads origin, or null without one; and the branch, even before the first commit", async () => {
    const repo = makeRepo();
    expect(await originUrl(repo)).toBeNull();
    git(repo, "remote", "add", "origin", "git@github.com:me/my.app.git");
    expect(await originUrl(repo)).toBe("git@github.com:me/my.app.git");
    expect(await currentBranch(repo)).toBe("main");
    const fresh = tempDir("unborn");
    git(fresh, "-c", "init.defaultBranch=trunk", "init", "-q");
    expect(await currentBranch(fresh)).toBe("trunk");
    git(repo, "checkout", "-q", "--detach");
    expect(await currentBranch(repo)).toBeNull();
  });
});
