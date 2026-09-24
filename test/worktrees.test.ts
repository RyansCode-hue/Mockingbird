import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { listWorktrees, migrateWorktree, pickDefaultBase, worktreeRoot, legacyWorktreeRoot } from "../src/main/worktrees";
import { git, makeRepo } from "./helpers";

describe("pickDefaultBase", () => {
  it("prefers the team's integration branch over main", () => {
    expect(pickDefaultBase(["main", "dev", "feature/x"])).toBe("dev");
    expect(pickDefaultBase(["master", "uat"])).toBe("uat");
    expect(pickDefaultBase(["feature/x"])).toBeNull();
  });
});

describe("worktree janitor", () => {
  it("lists worktrees whose branch names contain slashes, in both layouts", () => {
    const repo = makeRepo();
    git(repo, "worktree", "add", "-q", path.join(worktreeRoot(repo), "fix/login"), "-b", "fix/login");
    git(repo, "worktree", "add", "-q", path.join(worktreeRoot(repo), "plain"), "-b", "plain");
    git(repo, "worktree", "add", "-q", path.join(legacyWorktreeRoot(repo), "feat/old"), "-b", "feat/old");
    const list = listWorktrees([{ name: "repo", path: repo }], [path.join(worktreeRoot(repo), "plain")]);
    expect(list.map((w) => [w.name, w.branch, w.legacy, w.inUse, !!w.error])).toEqual(
      expect.arrayContaining([
        ["fix/login", "fix/login", false, false, false],
        ["plain", "plain", false, true, false],
        ["feat/old", "feat/old", true, false, false],
      ])
    );
    expect(list).toHaveLength(3);
  });
  it("reports dirty files and unpushed state", () => {
    const repo = makeRepo();
    const wt = path.join(worktreeRoot(repo), "dirty");
    git(repo, "worktree", "add", "-q", wt, "-b", "dirty");
    fs.writeFileSync(path.join(wt, "scratch.txt"), "x");
    const [w] = listWorktrees([{ name: "repo", path: repo }], []);
    expect(w).toMatchObject({ name: "dirty", dirty: true, dirtyFiles: 1 });
  });
  it("moves an old-layout worktree keeping its branch path, and tidies the old folders", () => {
    const repo = makeRepo();
    const old = path.join(legacyWorktreeRoot(repo), "feat/old");
    git(repo, "worktree", "add", "-q", old, "-b", "feat/old");
    const dest = migrateWorktree(repo, old);
    expect(dest).toBe(path.join(worktreeRoot(repo), "feat/old"));
    expect(fs.existsSync(path.join(dest, ".git"))).toBe(true);
    expect(fs.existsSync(legacyWorktreeRoot(repo))).toBe(false);
  });
  it("refuses to move a folder that isn't in the old layout", () => {
    const repo = makeRepo();
    expect(() => migrateWorktree(repo, "/tmp/elsewhere")).toThrow(/is not under/);
  });
});
