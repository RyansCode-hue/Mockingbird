import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { parseRefs, scmCommit, scmCommitDiff, scmCommitFiles, scmDiff, scmDiscard, scmFetch, scmGraph, scmPull, scmPush, scmStage, scmStatus, scmUnstage } from "../src/main/scm";
import { ownNetworkGit, programOnPath } from "../src/main/safeGit";
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

/**
 * A repo with a bare origin, a commit to push, and what runs code on a push: Husky's pre-push in `.husky/_` (core.hooksPath
 * in the repository's own config), a pre-push in `.git/hooks`, and a receive-pack the config names. Each leaves its
 * name in `ran` when it runs.
 */
function pushRunsCode() {
  const repo = makeRepo({ "a.txt": "a\n" });
  const dir = tempDir("remote");
  const remote = path.join(dir, "r.git");
  git(dir, "init", "-q", "--bare", remote);
  git(repo, "remote", "add", "origin", remote);
  git(repo, ...id, "commit", "-q", "--allow-empty", "-m", "to push");
  const log = path.join(dir, "ran");
  const script = (file: string, name: string, then = "") => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\necho ${name} >> '${log}'\n${then}`, { mode: 0o755 });
  };
  script(path.join(repo, ".husky", "_", "pre-push"), "husky");
  git(repo, "config", "core.hooksPath", ".husky/_");
  script(path.join(repo, ".git", "hooks", "pre-push"), "git-hooks");
  const receivePack = path.join(dir, "receive-pack.sh");
  script(receivePack, "receive-pack", 'exec git-receive-pack "$@"\n');
  git(repo, "config", "remote.origin.receivepack", receivePack);
  return { repo, remote, log, ran: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []) };
}

describe("a push's hooks: a room session's and a local one's", () => {
  it("runs none of the repository's hooks for a room session's push, its .git/hooks nor the folder its config names, nor the receive-pack it names, and says what it set aside", async () => {
    const t = pushRunsCode();
    expect(await scmPush(t.repo, { own: true })).toEqual({
      upstream: "origin/main",
      roomPush: { runs: null, skipped: { value: ".husky/_", why: "hooks in the working tree can be changed by the session" }, lfs: "none" },
    });
    expect(t.ran()).toEqual([]);
    expect(git(t.remote, "log", "-1", "--format=%s", "main")).toBe("to push");
  });

  it("runs a local session's push as git would: Husky's pre-push and the configured receive-pack included", async () => {
    const t = pushRunsCode();
    expect(await scmPush(t.repo)).toEqual({ upstream: "origin/main" });
    expect(t.ran().sort()).toEqual(["husky", "receive-pack"]);
    expect(git(t.remote, "log", "-1", "--format=%s", "main")).toBe("to push");
  });

  it("never runs a hook manager's pre-push in .git/hooks for a room session's push from a linked worktree: what the agent wrote there stays unrun", async () => {
    const t = hookManager();
    expect(await scmPush(t.wt, { own: true })).toMatchObject({
      upstream: "origin/5101-x",
      roomPush: { runs: null, skipped: { value: t.shownHooks, why: "this repository's hooks can run files its agent writes (a hook manager's config, its scripts)" }, lfs: "none" },
    });
    expect(t.ran()).toEqual([]);
    expect(git(t.remote, "log", "-1", "--format=%s", "5101-x")).toBe("the agent's work");
    // the same hook, on a local session's push, runs the agent's entry: the probe is real
    git(t.wt, ...id, "commit", "-q", "--allow-empty", "-m", "more");
    await scmPush(t.wt);
    expect(t.ran()).toEqual(["agent's entry ran"]);
  });

  it("runs the user's own global pre-push for a room session's push, only while it's outside every working tree of the repository", async () => {
    const t = pushRunsCode();
    const userHooks = tempDir("user-hooks");
    fs.writeFileSync(path.join(userHooks, "pre-push"), `#!/bin/sh\necho user >> '${t.log}'\n`, { mode: 0o755 });
    const global = path.join(tempDir("global"), "gitconfig");
    fs.writeFileSync(global, `[core]\n\thooksPath = ${userHooks}\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", global);
    try {
      expect((await scmPush(t.repo, { own: true })).roomPush).toEqual({
        runs: `~/${path.basename(userHooks)}`,
        skipped: { value: ".husky/_", why: "hooks in the working tree can be changed by the session" },
        lfs: "none",
      });
      expect(t.ran()).toEqual(["user"]);
      // one the user's config names inside the worktree is the agent's to write: none runs
      fs.writeFileSync(global, "[core]\n\thooksPath = .husky/_\n");
      git(t.repo, "config", "--unset", "core.hooksPath");
      git(t.repo, ...id, "commit", "-q", "--allow-empty", "-m", "again");
      expect((await scmPush(t.repo, { own: true })).roomPush).toEqual({ runs: null, skipped: { value: ".husky/_", why: "hooks in the working tree can be changed by the session" }, lfs: "none" });
      expect(t.ran()).toEqual(["user"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/**
 * A clone whose .git/hooks/pre-push is a hook manager's (as pre-commit's generated hook is): it runs the command named in
 * `.mgr-config.yaml` at the top of the working tree it runs in. A session's linked worktree, on 5101-x, where its agent
 * wrote that file.
 */
function hookManager() {
  const repo = makeRepo({ "a.txt": "a\n" });
  const dir = tempDir("remote");
  const remote = path.join(dir, "r.git");
  git(dir, "init", "-q", "--bare", remote);
  git(repo, "remote", "add", "origin", remote);
  const log = path.join(dir, "ran");
  const hooks = path.join(repo, ".git", "hooks");
  fs.writeFileSync(path.join(hooks, "pre-push"), `#!/bin/sh\n[ -f .mgr-config.yaml ] && sh -c "$(sed -n 's/^entry: //p' .mgr-config.yaml)"\nexit 0\n`, { mode: 0o755 });
  const wt = path.join(tempDir("worktrees"), "5101-x");
  git(repo, "worktree", "add", "-q", "-b", "5101-x", wt);
  fs.writeFileSync(path.join(wt, ".mgr-config.yaml"), `entry: echo "agent's entry ran" >> '${log}'\n`);
  git(wt, "add", ".mgr-config.yaml");
  git(wt, ...id, "commit", "-q", "-m", "the agent's work");
  const home = fs.realpathSync(os.homedir());
  return { repo, wt, remote, shownHooks: `~/${path.relative(home, fs.realpathSync(hooks))}`, ran: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []) };
}

const lfsHere = programOnPath("git-lfs", process.env.PATH);

describe("a room session's push and Git LFS", () => {
  /** A repository keeping big.bin in Git LFS (git lfs install --local: its filter and its pre-push), with a bare origin. */
  function lfsRepo() {
    const repo = makeRepo({ "a.txt": "a\n" });
    git(repo, "lfs", "install", "--local");
    git(repo, "lfs", "track", "*.bin");
    fs.writeFileSync(path.join(repo, "big.bin"), "x".repeat(4000));
    git(repo, "add", "-A");
    git(repo, ...id, "commit", "-q", "-m", "an LFS file");
    const remote = path.join(tempDir("remote"), "r.git");
    git(path.dirname(remote), "init", "-q", "--bare", remote);
    git(repo, "remote", "add", "origin", remote);
    const objects = () => (fs.existsSync(path.join(remote, "lfs", "objects")) ? fs.readdirSync(path.join(remote, "lfs", "objects"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length : 0);
    return { repo, remote, objects };
  }

  it.skipIf(!lfsHere)("uploads its LFS files first, with git lfs push, though git-lfs's own pre-push doesn't run", async () => {
    const t = lfsRepo();
    expect(await scmPush(t.repo, { own: true })).toEqual({ upstream: "origin/main", roomPush: { runs: null, skipped: { value: ".git/hooks", why: expect.any(String) }, lfs: "push" } });
    expect(t.objects()).toBe(1);
    expect(git(t.remote, "log", "-1", "--format=%s", "main")).toBe("an LFS file");
  });

  it.skipIf(!lfsHere)("uploads a take-over backup's LFS files first too: its push of a snapshot to a backup ref", async () => {
    const t = lfsRepo();
    fs.writeFileSync(path.join(t.repo, "more.bin"), "y".repeat(4000));
    git(t.repo, "add", "-A");
    git(t.repo, ...id, "commit", "-q", "-m", "another LFS file");
    const sha = git(t.repo, "rev-parse", "HEAD");
    await ownNetworkGit(t.repo, "push", ["--quiet", "origin", `${sha}:refs/mockingbird/backup`], { roomPush: { lfs: { remote: "origin", refs: [sha] } } });
    expect(t.objects()).toBe(2);
    expect(git(t.remote, "rev-parse", "refs/mockingbird/backup")).toBe(sha);
  });

  it("sends a take-over backup's own snapshot's LFS files, to origin, where its push goes", () => {
    // the snapshot holds the worktree's uncommitted files too: HEAD's LFS files wouldn't be all of them
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "main", "team", "takeover.ts"), "utf8");
    expect(src).toMatch(/ownNetworkGit\(top, "push", \["--quiet", `--force-with-lease=\$\{ref\}:\$\{expect\}`, "origin", `\$\{rec\.sha\}:\$\{ref\}`\], \{[^}]*roomPush: \{ lfs: \{ remote: "origin", refs: \[rec\.sha\] \}, told \}/);
  });

  it.skipIf(!lfsHere)("pushes nothing when git-lfs can't be run safely: an lfs.storage set", async () => {
    const t = lfsRepo();
    git(t.repo, "config", "lfs.storage", path.join(tempDir("lfs-store"), "s"));
    await expect(scmPush(t.repo, { own: true })).rejects.toThrow(
      "Nothing was pushed: this repository keeps files in Git LFS, and a room session's push runs none of its hooks, git-lfs's included: its git config sets lfs.extension or lfs.storage, which Mockingbird doesn't run git-lfs with."
    );
    expect(git(t.remote, "for-each-ref")).toBe("");
  });

  it.skipIf(!fs.existsSync("/usr/bin/git"))("pushes nothing when git-lfs isn't on Mockingbird's PATH, for a repository whose attributes keep files in it", async () => {
    const repo = makeRepo({ ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n", "big.bin": "raw\n" });
    const remote = path.join(tempDir("remote"), "r.git");
    git(path.dirname(remote), "init", "-q", "--bare", remote);
    git(repo, "remote", "add", "origin", remote);
    vi.stubEnv("PATH", "/usr/bin:/bin");
    try {
      await expect(scmPush(repo, { own: true })).rejects.toThrow(
        "Nothing was pushed: this repository keeps files in Git LFS, and a room session's push runs none of its hooks, git-lfs's included: git-lfs isn't on Mockingbird's PATH, so it can't upload them itself."
      );
    } finally {
      vi.unstubAllEnvs();
    }
    expect(git(remote, "for-each-ref")).toBe("");
    // a local session's push is git's own, as ever
    expect(await scmPush(repo)).toEqual({ upstream: "origin/main" });
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
