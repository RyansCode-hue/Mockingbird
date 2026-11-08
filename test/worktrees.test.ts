import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { checkoutBranch, cleanupWorktree, createWorktree, forgetState, listBranches, listWorktrees, migrateWorktree, parseShortstat, removeWorktree, unregisterMissing, worktreeRoot, legacyWorktreeRoot, worktreeState } from "../src/main/worktrees";
import { pickDefaultBase } from "../src/main/git";
import { changedPaths, scmStatus } from "../src/main/scm";
import { git, makeRepo } from "./helpers";

describe("pickDefaultBase", () => {
  it("prefers the team's integration branch over main", () => {
    expect(pickDefaultBase(["main", "dev", "feature/x"])).toBe("dev");
    expect(pickDefaultBase(["master", "uat"])).toBe("uat");
    expect(pickDefaultBase(["feature/x"])).toBeNull();
    expect(pickDefaultBase(["main", "UAT"])).toBe("UAT"); // by name, whatever its case
  });
  it("lists local and origin branches once each, without origin/HEAD", async () => {
    const origin = makeRepo({ "a.txt": "1" }, "origin");
    git(origin, "branch", "dev");
    const clone = path.join(path.dirname(origin), "clone");
    git(path.dirname(origin), "clone", "-q", origin, clone);
    git(clone, "branch", "feat/local");
    expect(await listBranches(clone)).toEqual({ branches: ["dev", "feat/local", "main"], defaultBase: "dev" });
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

  it("fails rather than report nothing unpushed when the counts can't be read", async () => {
    const origin = makeRepo({ "a.txt": "1" }, "origin");
    const clone = path.join(path.dirname(origin), "clone");
    git(path.dirname(origin), "clone", "-q", origin, clone);
    git(clone, "pack-refs", "--all");
    // the upstream names an object the clone doesn't have
    fs.writeFileSync(path.join(clone, ".git/refs/remotes/origin/main"), "0123456789012345678901234567890123456789\n");
    await expect(worktreeState(clone)).rejects.toThrow(/git rev-list/);
  });

  it("refuses to switch a checkout that has uncommitted changes, with the reason", async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
    await expect(checkoutBranch(repo, "feat/x")).rejects.toThrow(/1 uncommitted change on main/);
  });

  it("knows the branch a checkout is on before its first commit, and says when HEAD is detached", async () => {
    const fresh = fs.mkdtempSync(path.join(require("os").homedir(), "unborn-"));
    git(fresh, "-c", "init.defaultBranch=main", "init", "-q");
    await expect(checkoutBranch(fresh, "main")).resolves.toBeUndefined(); // already on it
    const repo = makeRepo();
    git(repo, "checkout", "-q", "--detach");
    fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
    await expect(checkoutBranch(repo, "feat/x")).rejects.toThrow(/on a detached HEAD/);
  });
});

describe("branches on origin", () => {
  /** A bare origin with main, a clone that has fetched it, and a branch someone pushed to origin since. */
  function pushedSinceFetch() {
    const seed = makeRepo({ "a.txt": "a\n" }, "seed");
    const origin = path.join(path.dirname(seed), "origin.git");
    git(path.dirname(seed), "clone", "-q", "--bare", seed, origin);
    const mine = path.join(path.dirname(seed), "mine");
    const theirs = path.join(path.dirname(seed), "theirs");
    git(path.dirname(seed), "clone", "-q", origin, mine);
    git(path.dirname(seed), "clone", "-q", origin, theirs);
    git(theirs, "checkout", "-q", "-b", "feat/shared");
    git(theirs, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "their work");
    git(theirs, "push", "-q", "origin", "feat/shared");
    return { mine, pushed: git(theirs, "rev-parse", "HEAD") };
  }

  it("a new worktree checks out a branch pushed since the last fetch instead of making it anew off the base", async () => {
    const { mine, pushed } = pushedSinceFetch();
    const wt = await createWorktree(mine, "feat/shared", "main");
    expect(git(wt, "rev-parse", "HEAD")).toBe(pushed);
    expect(git(wt, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feat/shared");
  });

  it("so does switching the checkout itself", async () => {
    const { mine, pushed } = pushedSinceFetch();
    await checkoutBranch(mine, "feat/shared", "main");
    expect(git(mine, "rev-parse", "HEAD")).toBe(pushed);
  });
});

describe("a worktree's folder gone, or seeming to be", () => {
  /** A worktree on `branch` holding a file git ignores, as a .env is. */
  async function withIgnored(branch: string) {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, ".git", "info", "exclude"), ".env\n");
    const wt = await createWorktree(repo, branch);
    const env = path.join(wt, ".env");
    fs.writeFileSync(env, "KEY=1\n");
    return { repo, wt, env, listed: () => git(repo, "worktree", "list", "--porcelain").includes(`/${branch}\n`) };
  }

  it("unregisters only a path git itself calls prunable: one that's there keeps its registration and its files, ignored ones too", async () => {
    const { repo, wt, env, listed } = await withIgnored("keep");
    await unregisterMissing(repo, wt);
    expect(fs.existsSync(env)).toBe(true);
    expect(listed()).toBe(true);
  });

  it("takes a folder it can't look at for neither there nor gone: it refuses, unregistering nothing", async () => {
    const { repo, env, listed } = await withIgnored("shut");
    const root = worktreeRoot(repo);
    fs.chmodSync(root, 0o000);
    try {
      await expect(createWorktree(repo, "shut")).rejects.toThrow(/EACCES/);
    } finally {
      fs.chmodSync(root, 0o755);
    }
    expect(fs.existsSync(env)).toBe(true);
    expect(listed()).toBe(true);
  });

  it("leaves one locked alone, its folder gone: git says why it can't be added", async () => {
    const { repo, wt, listed } = await withIgnored("locked");
    git(repo, "worktree", "lock", wt);
    fs.rmSync(wt, { recursive: true, force: true });
    await expect(createWorktree(repo, "locked")).rejects.toThrow(/locked/);
    expect(listed()).toBe(true);
  });

  it("makes one folder's worktree one at a time: several at once on a stale registration all get it, and it's there", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { repo, wt } = await withIgnored("race");
    fs.rmSync(wt, { recursive: true, force: true });
    const all = await Promise.all([createWorktree(repo, "race"), createWorktree(repo, "race"), createWorktree(repo, "race")]);
    expect(all).toEqual([wt, wt, wt]);
    expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("race");
    expect(warn.mock.calls.filter((c) => /still registered/.test(String(c[0])))).toHaveLength(1);
    warn.mockRestore();
    // one that failed doesn't hold up the next, and tells its own caller
    const [failed, next] = await Promise.allSettled([createWorktree(repo, "gone", undefined, { mustExist: true }), createWorktree(repo, "gone")]);
    expect(failed).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/isn't here or on origin/) }) });
    expect(next).toMatchObject({ status: "fulfilled" });
    expect(fs.existsSync(path.join(worktreeRoot(repo), "gone"))).toBe(true);
  });
});

describe("a folder that's there, reused for a session on a branch", () => {
  /** Branches feat and other, and `<root>/feat` out on other with a file of the user's in it. */
  function feastOnOther() {
    const repo = makeRepo();
    git(repo, "branch", "feat");
    const folder = path.join(worktreeRoot(repo), "feat");
    git(repo, "worktree", "add", "-q", "-b", "other", folder);
    const theirs = path.join(folder, "theirs.txt");
    fs.writeFileSync(theirs, "uncommitted");
    return { repo, folder, theirs };
  }

  it("is refused when it's on another branch, the session never put in it", async () => {
    const { repo, folder, theirs } = feastOnOther();
    await expect(createWorktree(repo, "feat")).rejects.toThrow(`${folder} is there, on other, so a session on feat can't run in it`);
    await expect(createWorktree(repo, "feat", undefined, { mustExist: true })).rejects.toThrow(/on other/);
    expect(git(folder, "rev-parse", "--abbrev-ref", "HEAD")).toBe("other");
    expect(fs.existsSync(theirs)).toBe(true);
  });

  it("is refused when it's a plain folder, or one with a detached HEAD", async () => {
    const repo = makeRepo();
    const plain = path.join(worktreeRoot(repo), "feat");
    fs.mkdirSync(plain, { recursive: true });
    await expect(createWorktree(repo, "feat")).rejects.toThrow(/isn't a checkout of a branch/);
    const detached = path.join(worktreeRoot(repo), "gone");
    git(repo, "worktree", "add", "-q", "--detach", detached);
    await expect(createWorktree(repo, "gone")).rejects.toThrow(/isn't a checkout of a branch/);
  });

  it("is refused when it's a plain folder inside another repository, whatever that one has out", async () => {
    const outer = makeRepo({ "a.txt": "1" }, "outer");
    const repo = path.join(outer, "inner");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first");
    const plain = path.join(worktreeRoot(repo), "main");
    fs.mkdirSync(plain, { recursive: true });
    await expect(createWorktree(repo, "main")).rejects.toThrow(/isn't a checkout of a branch/);
  });

  it("is reused when it's on that branch", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "feat");
    expect(await createWorktree(repo, "feat")).toBe(wt);
  });

  it("in the old layout is used only while it holds the branch: on another, the worktree's made at the usual place", async () => {
    const repo = makeRepo();
    const legacy = path.join(legacyWorktreeRoot(repo), "feat");
    git(repo, "worktree", "add", "-q", "-b", "feat", legacy);
    expect(await createWorktree(repo, "feat")).toBe(legacy);
    git(legacy, "switch", "-q", "-c", "other");
    const wt = await createWorktree(repo, "feat");
    expect(wt).toBe(path.join(worktreeRoot(repo), "feat"));
    expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat");
    expect(git(legacy, "rev-parse", "--abbrev-ref", "HEAD")).toBe("other");
  });

  it("isn't looked for in the old layout when it's asked for at a folder of its own", async () => {
    const repo = makeRepo();
    git(repo, "branch", "feat");
    fs.mkdirSync(path.join(legacyWorktreeRoot(repo), "feat"), { recursive: true });
    const at = path.join(worktreeRoot(repo), "a", "own-name");
    expect(await createWorktree(repo, "feat", undefined, { at })).toBe(at);
    expect(git(at, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat");
  });
});

describe("removing a worktree", () => {
  it("leaves every other registered, one it can't look at (as on a volume that's gone) included", async () => {
    const repo = makeRepo();
    const shutIn = await createWorktree(repo, "shut/in");
    const other = await createWorktree(repo, "other");
    const shut = path.dirname(shutIn);
    fs.chmodSync(shut, 0o000);
    try {
      await removeWorktree(repo, other);
    } finally {
      fs.chmodSync(shut, 0o755);
    }
    const listed = git(repo, "worktree", "list", "--porcelain");
    expect(listed).toContain("/shut/in\n");
    expect(listed).not.toContain("/other\n");
    expect(git(shutIn, "rev-parse", "--abbrev-ref", "HEAD")).toBe("shut/in");
  });
});

describe("a worktree refused", () => {
  it("leaves no folder behind", async () => {
    const repo = makeRepo();
    await expect(createWorktree(repo, "nowhere", undefined, { mustExist: true })).rejects.toThrow(/isn't here or on origin/);
    expect(fs.existsSync(worktreeRoot(repo))).toBe(false);
    const plain = path.join(path.dirname(repo), "plain");
    fs.mkdirSync(plain);
    await expect(createWorktree(plain, "feat")).rejects.toThrow(/not a git repository/);
    expect(fs.existsSync(worktreeRoot(plain))).toBe(false);
  });
});

describe("a relaunch's worktree, its branch only on origin", () => {
  /** A clone that's fetched origin's `feat`, with no local branch of it. */
  function fetched() {
    const origin = makeRepo({ "a.txt": "1" }, "origin");
    const clone = path.join(path.dirname(origin), "clone");
    git(path.dirname(origin), "clone", "-q", origin, clone);
    git(origin, "branch", "feat");
    git(clone, "fetch", "-q", "origin");
    return { origin, clone, head: git(clone, "rev-parse", "origin/feat") };
  }

  it("is made from the last fetch when origin can't be reached, without trying a fetch that would only time out", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { origin, clone, head } = fetched();
    fs.renameSync(origin, `${origin}-moved`);
    const wt = await createWorktree(clone, "feat", undefined, { mustExist: true });
    expect(git(wt, "rev-parse", "HEAD")).toBe(head);
    expect(git(wt, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feat");
    expect(log.mock.calls.some((c) => /couldn't ask origin about feat/.test(String(c[0])))).toBe(true);
    expect(log.mock.calls.some((c) => /couldn't fetch/.test(String(c[0])))).toBe(false);
    log.mockRestore();
  });

  it("is made from the last fetch when origin answers but the fetch fails, and says so; a new session's fetch still fails aloud", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { clone, head } = fetched();
    // a fetch can't write what it fetched; asking origin needs no such thing
    const fetchHead = path.join(clone, ".git", "FETCH_HEAD");
    fs.writeFileSync(fetchHead, "");
    fs.chmodSync(fetchHead, 0o444);
    await expect(createWorktree(clone, "feat")).rejects.toThrow(/FETCH_HEAD/);
    const wt = await createWorktree(clone, "feat", undefined, { mustExist: true });
    expect(git(wt, "rev-parse", "HEAD")).toBe(head);
    expect(log.mock.calls.some((c) => /couldn't fetch feat, going by the last fetch/.test(String(c[0])))).toBe(true);
    log.mockRestore();
  });

  it("says to try again, not to start fresh, when it's not here and origin couldn't be asked", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { origin, clone } = fetched();
    git(origin, "branch", "never-fetched");
    fs.renameSync(origin, `${origin}-moved`);
    await expect(createWorktree(clone, "never-fetched", undefined, { mustExist: true })).rejects.toThrow("Its branch, never-fetched, isn't here, and origin couldn't be reached to check for it: try again when you're online");
    log.mockRestore();
  });

  it("is made from a ref left by a remote that's gone, tracking nothing, as there's nothing to track", async () => {
    const repo = makeRepo();
    git(repo, "update-ref", "refs/remotes/origin/feat", "HEAD");
    const wt = await createWorktree(repo, "feat", undefined, { mustExist: true });
    expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat");
    expect(() => git(wt, "config", "--get", "branch.feat.remote")).toThrow();
  });
});

describe("closing a worktree", () => {
  it("discarding deletes the worktree and its branch", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "feat/gone");
    expect(await cleanupWorktree(repo, wt, "discard")).toEqual({ removed: true });
    expect(git(repo, "branch", "--list", "feat/gone")).toBe("");
  });

  it("says so when the branch stays: checked out elsewhere, or no branch at all", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feat/both");
    const wt = path.join(worktreeRoot(repo), "feat/both");
    git(repo, "worktree", "add", "-q", "--force", wt, "feat/both");
    const r = await cleanupWorktree(repo, wt, "discard");
    expect(r).toMatchObject({ removed: true, branchKept: expect.stringMatching(/^feat\/both wasn't deleted/) });
    expect(git(repo, "branch", "--list", "feat/both")).not.toBe("");
    expect(log).toHaveBeenCalled();
    log.mockRestore();

    const detached = path.join(worktreeRoot(repo), "detached");
    git(repo, "worktree", "add", "-q", "--detach", detached);
    expect(await cleanupWorktree(repo, detached, "discard")).toMatchObject({ removed: true, branchKept: expect.stringMatching(/detached HEAD/) });
  });
});

describe("a folder's uncommitted lines", () => {
  it("counts lines added and removed in tracked files, and forgets a cached read on request", async () => {
    const repo = makeRepo({ "a.txt": "one\ntwo\nthree\n" });
    expect(await worktreeState(repo)).toMatchObject({ dirty: false, insertions: 0, deletions: 0 });
    fs.writeFileSync(path.join(repo, "a.txt"), "one\nTWO\nthree\nfour\n");
    fs.writeFileSync(path.join(repo, "new.txt"), "x\n");
    forgetState(repo); // what a folder-change notice does
    expect(await worktreeState(repo)).toMatchObject({ dirtyFiles: 2, insertions: 2, deletions: 1 });
  });

  it("counts the files Source Control lists: each file in a new folder, and a staged file with more edits once", async () => {
    const repo = makeRepo({ "a.txt": "one\n", "b.txt": "two\n" });
    fs.mkdirSync(path.join(repo, "newdir"));
    fs.writeFileSync(path.join(repo, "newdir", "x.txt"), "x\n");
    fs.writeFileSync(path.join(repo, "newdir", "y.txt"), "y\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "one!\n");
    git(repo, "add", "a.txt");
    fs.writeFileSync(path.join(repo, "a.txt"), "one!!\n"); // staged, then edited again
    fs.writeFileSync(path.join(repo, "b.txt"), "two!\n");
    const listed = changedPaths(await scmStatus(repo));
    expect(listed.sort()).toEqual(["a.txt", "b.txt", "newdir/x.txt", "newdir/y.txt"]);
    expect((await worktreeState(repo)).dirtyFiles).toBe(listed.length);
  });

  it("reads git's shortstat wording, singular or plural", () => {
    expect(parseShortstat(" 3 files changed, 120 insertions(+), 8 deletions(-)")).toEqual({ insertions: 120, deletions: 8 });
    expect(parseShortstat(" 1 file changed, 1 insertion(+)")).toEqual({ insertions: 1, deletions: 0 });
    expect(parseShortstat("")).toEqual({ insertions: 0, deletions: 0 });
  });

  it("names the branch, or HEAD when detached", async () => {
    const repo = makeRepo();
    expect((await worktreeState(repo)).branch).toBe("main");
    git(repo, "checkout", "-q", "--detach");
    forgetState(repo);
    expect((await worktreeState(repo)).branch).toBe("HEAD");
  });

  it("counts nothing before the first commit instead of failing", async () => {
    const dir = fs.mkdtempSync(path.join(require("os").homedir(), "fresh-"));
    git(dir, "init", "-q");
    fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
    expect(await worktreeState(dir)).toMatchObject({ dirtyFiles: 1, insertions: 0, deletions: 0 });
  });
});
