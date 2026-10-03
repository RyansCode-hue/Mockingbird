import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { checkoutBranch, createWorktree, listWorktrees, migrateWorktree, pickDefaultBase, worktreeRoot, legacyWorktreeRoot, worktreeState } from "../src/main/worktrees";
import { git, makeRepo } from "./helpers";

describe("pickDefaultBase", () => {
  it("prefers the team's integration branch over main", () => {
    expect(pickDefaultBase(["main", "dev", "feature/x"])).toBe("dev");
    expect(pickDefaultBase(["master", "uat"])).toBe("uat");
    expect(pickDefaultBase(["feature/x"])).toBeNull();
  });
});

describe("worktree janitor", () => {
  it("lists worktrees whose branch names contain slashes, in both layouts", async () => {
    const repo = makeRepo();
    git(repo, "worktree", "add", "-q", path.join(worktreeRoot(repo), "fix/login"), "-b", "fix/login");
    git(repo, "worktree", "add", "-q", path.join(worktreeRoot(repo), "plain"), "-b", "plain");
    git(repo, "worktree", "add", "-q", path.join(legacyWorktreeRoot(repo), "feat/old"), "-b", "feat/old");
    const list = await listWorktrees([{ name: "repo", path: repo }], [path.join(worktreeRoot(repo), "plain")]);
    expect(list.map((w) => [w.name, w.branch, w.legacy, w.inUse, !!w.error])).toEqual(
      expect.arrayContaining([
        ["fix/login", "fix/login", false, false, false],
        ["plain", "plain", false, true, false],
        ["feat/old", "feat/old", true, false, false],
      ])
    );
    expect(list).toHaveLength(3);
  });
  it("reports dirty files and unpushed state", async () => {
    const repo = makeRepo();
    const wt = path.join(worktreeRoot(repo), "dirty");
    git(repo, "worktree", "add", "-q", wt, "-b", "dirty");
    fs.writeFileSync(path.join(wt, "scratch.txt"), "x");
    const [w] = await listWorktrees([{ name: "repo", path: repo }], []);
    expect(w).toMatchObject({ name: "dirty", dirty: true, dirtyFiles: 1 });
  });
  it("moves an old-layout worktree keeping its branch path, and tidies the old folders", async () => {
    const repo = makeRepo();
    const old = path.join(legacyWorktreeRoot(repo), "feat/old");
    git(repo, "worktree", "add", "-q", old, "-b", "feat/old");
    const dest = await migrateWorktree(repo, old);
    expect(dest).toBe(path.join(worktreeRoot(repo), "feat/old"));
    expect(fs.existsSync(path.join(dest, ".git"))).toBe(true);
    expect(fs.existsSync(legacyWorktreeRoot(repo))).toBe(false);
  });
  it("refuses to move a folder that isn't in the old layout", async () => {
    const repo = makeRepo();
    await expect(migrateWorktree(repo, "/tmp/elsewhere")).rejects.toThrow(/is not under/);
  });
});

describe("git without blocking", () => {
  it("keeps the event loop running while git works — panes keep taking keystrokes", async () => {
    const repo = makeRepo();
    let ticks = 0;
    const tick = setInterval(() => ticks++, 1);
    await createWorktree(repo, "feat/async");
    clearInterval(tick);
    expect(ticks).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(worktreeRoot(repo), "feat/async", ".git"))).toBe(true);
  });

  it("shares one status read between panes polling the same folder", async () => {
    const repo = makeRepo();
    const a = worktreeState(repo);
    const b = worktreeState(repo);
    expect(b).toBe(a);
    expect(await a).toMatchObject({ dirty: false, branch: "main", ahead: 0, behind: 0 });
  });

  it("counts commits ahead of and behind the upstream", async () => {
    const origin = makeRepo({ "a.txt": "1" }, "origin");
    const clone = path.join(path.dirname(origin), "clone");
    git(path.dirname(origin), "clone", "-q", origin, clone);
    git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "mine");
    git(origin, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "theirs");
    git(clone, "fetch", "-q");
    expect(await worktreeState(clone)).toMatchObject({ ahead: 1, behind: 1 });
  });

  it("refuses to switch a checkout that has uncommitted changes, with the reason", async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
    await expect(checkoutBranch(repo, "feat/x")).rejects.toThrow(/1 uncommitted change on main/);
  });
});
