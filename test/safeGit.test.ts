import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { commitContext } from "../src/main/commitMessage";
import { changedFiles } from "../src/main/conflicts";
import { refreshBrief } from "../src/main/contextActions";
import { branchStat, fileDiff, gitChanges } from "../src/main/files";
import { listAllFiles } from "../src/main/find";
import { repoState } from "../src/main/handoff";
import { prDescriptionPrompt } from "../src/main/pullRequests";
import { ignoredCandidates } from "../src/main/runDraft";
import { driversToTurnOff, guardedGit, ownFetch, ownNetworkEnv, programOnPath } from "../src/main/safeGit";
import { scmCommit, scmCommitDiff, scmCommitFiles, scmDiff, scmDiscard, scmFetch, scmGraph, scmStage, scmStatus, scmUnstage } from "../src/main/scm";
import { dropSnapshots, leftOutIn, snapshotCommit, takeSnapshot } from "../src/main/snapshots";
import { fetchOrigin } from "../src/main/team/branchFiles";
import { excludeInRepo } from "../src/main/team/claims";
import { makeTestCopy } from "../src/main/testCopy";
import { createWorktree, worktreeState } from "../src/main/worktrees";
import type { SessionInfo } from "../src/shared/types";
import { git, makeRepo, ownGitLog, tempDir, write } from "./helpers";
import { hostileRepo, watchRepo } from "./hostileRepo";

// each makes a repository and runs a dozen gits, which a busy machine takes a while to start
describe("git run through guardedGit", { timeout: 300_000 }, () => {
  it("runs nothing the repository's config names: drivers whose names hold '=' or nothing included", async () => {
    const h = hostileRepo();
    // each does run for a plain git, so the markers prove something (a pager needs a terminal, so it's left to the env)
    const plain = spawnSync("git", ["-C", h.repo, "diff", "dev"], { encoding: "utf8" });
    expect(plain.status, plain.stderr).toBe(0);
    expect(h.ran()).toEqual(["fsmonitor", "plain", "equals", "empty", "external", "hook"]);
    h.clear();
    expect(spawnSync("git", ["-C", h.repo, "diff", "--no-ext-diff", "dev"], { encoding: "utf8" }).status).toBe(0);
    expect(h.ran()).toContain("textconv");
    h.clear();
    expect(spawnSync("git", ["-C", h.repo, "log", "-1", "--format=%s"], { encoding: "utf8" }).stdout).toContain("signed");
    expect(h.ran()).toEqual(["gpg"]);
    h.clear();

    const g = await guardedGit(h.repo);
    const diff = await g.diff(["dev"]);
    for (const line of ["+two", "+bea", "+sea", "+dea"]) expect(diff).toContain(line);
    expect(await g.status(["--porcelain"], { trim: false })).toMatch(/^ M a\.txt$/m);
    expect(h.ran()).toEqual([]);
  });

  it("runs no hook, and leaves the index to the agent's own git: a status takes no lock and writes nothing", async () => {
    const h = hostileRepo();
    const index = path.join(h.repo, ".git", "index");
    const stamp = () => {
      const st = fs.statSync(index);
      return [st.ino, st.mtimeMs];
    };
    // a plain status and diff each write the index for a file merely touched, running post-index-change from the
    // working tree's folder core.hooksPath names
    let before = stamp();
    expect(spawnSync("git", ["-C", h.repo, "status", "--porcelain"], { encoding: "utf8" }).status).toBe(0);
    expect(h.ran()).toContain("hook");
    expect(stamp()).not.toEqual(before);
    h.clear();
    h.stale();
    expect(spawnSync("git", ["-C", h.repo, "diff"], { encoding: "utf8" }).status).toBe(0);
    expect(h.ran()).toContain("hook");
    h.clear();

    h.stale();
    const g = await guardedGit(h.repo);
    before = stamp();
    expect(await g.status(["--porcelain"], { trim: false })).toMatch(/^ M a\.txt$/m);
    expect(stamp(), "the status rewrote the index, taking index.lock to do it").toEqual(before);
    // a diff still refreshes the index when it can, with no hook run
    expect(await g.diff([])).toContain("+two");
    expect(h.ran()).toEqual([]);
  });

  it("keeps the card's diff badge from running any of it, every round", async () => {
    const h = hostileRepo();
    expect(await branchStat(h.repo, "dev")).toMatchObject({ base: "dev", files: 5 });
    expect(h.ran()).toEqual([]);
  });

  it("reads no submodule's working tree for a status, so its own config runs nothing, while its commit moving still shows", async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const sub = makeRepo({ "x.txt": "x\n", ".gitattributes": "*.txt filter=subevil\n" }, "sub");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "--quiet", "add", sub, "vendor/sub");
    git(repo, "commit", "-qm", "sub");
    const inner = path.join(repo, "vendor", "sub");
    const ran = path.join(path.dirname(repo), "subclean-ran");
    const clean = path.join(path.dirname(repo), "subclean.sh");
    fs.writeFileSync(clean, `#!/bin/sh\ntouch '${ran}'\ncat\n`, { mode: 0o755 });
    git(inner, "config", "filter.subevil.clean", clean);
    // the same size, so git reads the file through its filter to tell whether it changed
    write(inner, { "x.txt": "y\n" });
    expect(spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }).stdout).toContain("vendor/sub");
    expect(fs.existsSync(ran), "a plain status asks the submodule, which runs its filter").toBe(true);
    fs.rmSync(ran);
    expect((await scmStatus(repo)).unstaged).toEqual([]);
    git(inner, "commit", "-qam", "moved");
    write(inner, { "x.txt": "z\n" });
    fs.rmSync(ran, { force: true });
    expect((await scmStatus(repo)).unstaged).toEqual([{ path: "vendor/sub", status: "M" }]);
    expect(fs.existsSync(ran)).toBe(false);
  });

  it("sets aside what a run gave when a driver was added to the config while it ran", async () => {
    const h = hostileRepo();
    const g = await guardedGit(h.repo);
    fs.appendFileSync(path.join(h.repo, ".git", "config"), `[filter "late"]\n\tclean = cat\n`);
    await expect(g.diff(["dev"])).rejects.toThrow(/filter drivers or LFS settings changed while it ran, so a command Mockingbird hadn't turned off may have run/);
  });

  it("sets it aside when an LFS extension or storage folder was set, never for the settings git-lfs writes itself", async () => {
    const h = hostileRepo();
    const config = path.join(h.repo, ".git", "config");
    let g = await guardedGit(h.repo);
    // git-lfs adds its format version on its first clean (a read's included), a server's access and lock settings on a push
    fs.appendFileSync(config, `[lfs]\n\trepositoryformatversion = 0\n[lfs "https://example.invalid/app.git/info/lfs"]\n\taccess = basic\n\tlocksverify = false\n`);
    expect(await g.diff(["dev"])).toContain("+two");
    for (const late of [`[lfs "extension.late"]\n\tclean = cat\n`, `[lfs "Extension.later"]\n\tpriority = 1\n`, `[lfs]\n\tstorage = /elsewhere\n`]) {
      g = await guardedGit(h.repo);
      fs.appendFileSync(config, late);
      await expect(g.diff(["dev"]), late).rejects.toThrow(/filter drivers or LFS settings changed while it ran/);
    }
  });

  it("throws when the config can't be read, rather than run with nothing turned off", async () => {
    const repo = makeRepo();
    fs.appendFileSync(path.join(repo, ".git", "config"), "[broken\n");
    await expect(guardedGit(repo)).rejects.toThrow(/git config/);
  });
});

describe("main-process reads of a session's folder", { timeout: 300_000 }, () => {
  it("run nothing its config names: Source Control, Changes, the worktree card, handoffs, commit and PR drafts, test copies", async () => {
    const h = hostileRepo();
    const root = git(h.repo, "rev-list", "--max-parents=0", "HEAD");
    const attributes = git(h.repo, "rev-parse", "HEAD~1");
    git(h.repo, "update-ref", "refs/remotes/origin/dev", "dev");
    git(h.repo, "add", "b.md");
    write(h.repo, { "u.txt": "new\n" });
    const transcript = path.join(tempDir("transcript"), "t.jsonl");
    fs.writeFileSync(transcript, "");
    h.clear();
    const reads: [string, () => Promise<unknown>][] = [
      ["scmStatus", () => scmStatus(h.repo)],
      ["scmDiff unstaged", () => scmDiff(h.repo, "a.txt", false, false)],
      ["scmDiff staged", () => scmDiff(h.repo, "b.md", true, false)],
      ["scmDiff untracked", () => scmDiff(h.repo, "u.txt", false, true)],
      ["scmGraph", () => scmGraph(h.repo)],
      ["scmCommitFiles", () => scmCommitFiles(h.repo, attributes)],
      ["scmCommitFiles of the root", () => scmCommitFiles(h.repo, root)],
      ["scmCommitDiff", () => scmCommitDiff(h.repo, attributes, ".gitattributes")],
      ["scmCommitDiff of the root", () => scmCommitDiff(h.repo, root, "c.bin")],
      ["gitChanges", () => gitChanges(h.repo, "branch")],
      ["fileDiff", () => fileDiff(h.repo, "c.bin", "working", false)],
      ["fileDiff untracked", () => fileDiff(h.repo, "u.txt", "working", true)],
      ["worktreeState", () => worktreeState(h.repo)],
      ["changedFiles", () => changedFiles(h.repo)],
      ["repoState", () => repoState(h.repo)],
      ["commitContext", () => commitContext(h.repo)],
      ["prDescriptionPrompt", () => prDescriptionPrompt(h.repo, "dev", { id: "1", title: "t" })],
      ["makeTestCopy", () => makeTestCopy(h.repo, path.join(tempDir("copy"), "c"))],
      ["leftOutIn", () => leftOutIn(h.repo, "HEAD")],
      ["listAllFiles", () => listAllFiles(h.repo)],
      ["ignoredCandidates", () => ignoredCandidates(h.repo)],
      ["excludeInRepo", () => excludeInRepo(h.repo, { dir: "mb-plan", line: "/mb-plan/", comment: "a test's", what: "a test's copy" })],
      ["refreshBrief", () => refreshBrief({ cwd: h.repo, title: "t" } as SessionInfo, { files: [{ path: transcript, agent: "claude" }], conversationId: "c", context: { state: "none", why: "" }, rate: null, now: 0 })],
    ];
    const ran: [string, string[]][] = [];
    for (const [name, read] of reads) {
      await read();
      ran.push([name, [...h.ran()]]);
      h.clear();
    }
    expect(ran.filter(([, r]) => r.length)).toEqual([]);
    expect(await scmDiff(h.repo, "a.txt", false, false)).toContain("+two");
    expect(await scmCommitDiff(h.repo, root, "c.bin")).toContain("+see");
    expect((await scmStatus(h.repo)).staged).toEqual([{ path: "b.md", status: "M" }]);
  });

  it("give what plain git gives a repository with nothing planted", async () => {
    const repo = makeRepo({ "a.txt": "one\n", "old.txt": "moved\nwhole\n" });
    const root = git(repo, "rev-parse", "HEAD");
    write(repo, { "later.txt": "x\n" });
    git(repo, "add", "later.txt");
    git(repo, "commit", "-qm", "later");
    const later = git(repo, "rev-parse", "HEAD");
    git(repo, "mv", "old.txt", "new.txt");
    write(repo, { "a.txt": "two\n", "u.txt": "new\n" });
    const plain = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }).stdout;
    expect(await scmDiff(repo, "a.txt", false, false)).toBe(plain("diff", "-M", "--", "a.txt"));
    expect(await scmDiff(repo, "new.txt", true, false)).toBe(plain("diff", "--cached", "-M", "--", "old.txt", "new.txt"));
    expect(await scmDiff(repo, "u.txt", false, true)).toBe(plain("diff", "--no-index", "--", "/dev/null", "u.txt"));
    expect(await fileDiff(repo, "a.txt", "working", false)).toBe(plain("diff", "-M", "HEAD", "--", "a.txt"));
    expect(await scmCommitDiff(repo, root, "a.txt")).toBe(plain("show", "--format=", root, "--", "a.txt"));
    expect(await scmCommitDiff(repo, later, "later.txt")).toBe(plain("diff", "-M", `${later}^1`, later, "--", "later.txt"));
    const status = ["--porcelain=v2", "--branch", "-z", "--untracked-files=all"];
    expect(await (await guardedGit(repo)).status(status, { trim: false })).toBe(plain("status", ...status));
  });
});

describe("main-process writes of a session's folder", { timeout: 300_000 }, () => {
  it("run with fsmonitor and the pager off, and the repository's filters still on, as they define what's stored", async () => {
    const control = hostileRepo();
    git(control.repo, "add", "a.txt");
    expect(control.ran(), "a plain add runs fsmonitor and the file's filter").toEqual(expect.arrayContaining(["fsmonitor", "plain"]));
    const h = hostileRepo();
    const origin = path.join(tempDir("origin"), "origin.git");
    git(path.dirname(origin), "clone", "-q", "--bare", h.repo, origin);
    git(h.repo, "remote", "add", "origin", origin);
    h.clear();
    const writes: [string, () => Promise<unknown>][] = [
      ["scmStage", () => scmStage(h.repo, ["a.txt"])],
      ["scmUnstage", () => scmUnstage(h.repo, ["a.txt"])],
      ["scmStage again", () => scmStage(h.repo, ["a.txt", "b.md"])],
      ["scmCommit", () => scmCommit(h.repo, "staged")],
      ["scmDiscard", () => scmDiscard(h.repo, [{ path: "c.bin", untracked: false }], async () => {})],
      ["snapshotCommit", () => snapshotCommit(h.repo, "backup")],
      ["takeSnapshot", () => takeSnapshot(h.repo, "s1", "a prompt")],
      ["takeSnapshot again", () => takeSnapshot(h.repo, "s1", "another")],
      ["dropSnapshots", () => dropSnapshots(h.repo, "s1")],
      // a fetch reads the index, for submodules: the first makes origin's refs, which runs reference-transaction
      ["fetchOrigin", () => fetchOrigin(h.repo)],
      ["scmFetch", () => scmFetch(h.repo)],
    ];
    const ran: [string, string[]][] = [];
    for (const [name, write] of writes) {
      h.stale();
      await write();
      ran.push([name, [...h.ran()]]);
      h.clear();
    }
    expect(ran.filter(([, r]) => r.includes("fsmonitor") || r.includes("pager"))).toEqual([]);
    expect(ran.find(([n]) => n === "scmStage")![1]).toContain("plain");
    expect(ran.find(([n]) => n === "snapshotCommit")![1]).toContain("empty");
    // the user's own stage and commit keep their hooks; what Mockingbird writes on its own (a turn's snapshot, a room's
    // fetch) runs none
    expect(ran.find(([n]) => n === "scmStage")![1]).toContain("hook");
    expect(ran.find(([n]) => n === "scmCommit")![1]).toContain("refhook");
    expect(ran.filter(([n, r]) => /snapshot|fetchOrigin/i.test(n) && (r.includes("hook") || r.includes("refhook")))).toEqual([]);
    expect(git(h.repo, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/")).toContain("refs/remotes/origin/feature");
    expect(git(h.repo, "for-each-ref", "refs/mockingbird/")).toBe("");
    expect(git(h.repo, "show", "HEAD:a.txt")).toBe("two");
  });
});

describe("Mockingbird's own network gits", { timeout: 300_000 }, () => {
  /** A bare origin and a clone of it, watched. */
  function watchedClone() {
    const seed = makeRepo({ "a.txt": "a\n" }, "seed");
    const origin = path.join(path.dirname(seed), "origin.git");
    git(path.dirname(seed), "clone", "-q", "--bare", seed, origin);
    const clone = path.join(path.dirname(seed), "clone");
    git(path.dirname(seed), "clone", "-q", origin, clone);
    return { origin, clone, w: watchRepo(clone) };
  }
  const plainFetch = (clone: string) => spawnSync("git", ["-C", clone, "fetch", "-q", "origin"], { encoding: "utf8" });

  it("run git's own upload-pack, never the one the clone's config names, for a fetch and an ls-remote", async () => {
    const { clone, w } = watchedClone();
    git(clone, "config", "remote.origin.uploadpack", w.plant("uploadpack", 'exec git-upload-pack "$@"'));
    expect(plainFetch(clone).status).toBe(0);
    expect(w.ran()).toContain("uploadpack");
    w.clear();
    await fetchOrigin(clone);
    // a new worktree asks origin for its branch (ls-remote), then fetches its base
    await createWorktree(clone, "feat/x", "main");
    expect(w.ran()).not.toContain("uploadpack");
    expect(w.ranBy(/ (fetch|ls-remote) /)).toEqual([]);
  });

  it("refuse an ext:: transport, which runs the command its URL names, made of origin by the clone's config", async () => {
    const { origin, clone, w } = watchedClone();
    git(clone, "config", "protocol.ext.allow", "always");
    git(clone, "config", `url.ext::${w.plant("ext", "exit 1")} %S.insteadOf`, origin);
    plainFetch(clone);
    expect(w.ran()).toContain("ext");
    w.clear();
    await expect(fetchOrigin(clone)).rejects.toThrow(/transport 'ext' not allowed/);
    expect(w.ran()).not.toContain("ext");
  });

  it("fetch no submodule, which would run in the submodule's own config, out of the overrides' reach", async () => {
    const subSeed = makeRepo({ "s.txt": "s\n" }, "sub-seed");
    const subOrigin = path.join(path.dirname(subSeed), "sub.git");
    git(path.dirname(subSeed), "clone", "-q", "--bare", subSeed, subOrigin);
    const seed = makeRepo({ "a.txt": "a\n" }, "super-seed");
    git(seed, "-c", "protocol.file.allow=always", "submodule", "--quiet", "add", subOrigin, "sub");
    git(seed, "commit", "-qm", "sub");
    const origin = path.join(path.dirname(seed), "super.git");
    git(path.dirname(seed), "clone", "-q", "--bare", seed, origin);
    const clone = path.join(tempDir("clone"), "super");
    git(path.dirname(clone), "-c", "protocol.file.allow=always", "clone", "-q", "--recurse-submodules", origin, clone);
    const w = watchRepo(path.join(clone, "sub"));
    // the submodule moves upstream, and the superproject's pointer with it
    write(subSeed, { "s.txt": "s2\n" });
    git(subSeed, "commit", "-qam", "s2");
    git(subSeed, "push", "-q", subOrigin, "HEAD:main");
    git(path.join(seed, "sub"), "-c", "protocol.file.allow=always", "pull", "-q", "origin", "main");
    git(seed, "commit", "-qam", "move sub");
    git(seed, "push", "-q", origin, "HEAD:main");
    await fetchOrigin(clone);
    expect(w.ran()).toEqual([]);
    // a plain fetch goes on into the submodule, for the commits its new pointer names, running its fsmonitor
    git(clone, "update-ref", "refs/remotes/origin/main", "HEAD");
    expect(spawnSync("git", ["-C", clone, "fetch", "-q", "origin"], { encoding: "utf8" }).status).toBe(0);
    expect(w.ranBy(/ fetch .*--submodule-prefix=sub\//).map((l) => l.split("\t")[0])).toContain("fsmonitor");
  });

  /** A watched clone whose origin is reached over ssh, so a fetch runs the ssh the config gives, and a global config of the test's own. */
  function overSsh() {
    const c = watchedClone();
    git(c.clone, "config", "url.ssh://git@example.invalid/app.git.insteadOf", c.origin);
    const global = path.join(tempDir("global"), "gitconfig");
    fs.writeFileSync(global, "");
    vi.stubEnv("GIT_SSH_COMMAND", undefined);
    vi.stubEnv("GIT_SSH", undefined);
    vi.stubEnv("GIT_CONFIG_GLOBAL", global);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    onTestFinished(() => void vi.unstubAllEnvs());
    return { ...c, global };
  }
  const unreachable = /Could not read from remote repository/;

  it("run the ssh git would, the repository's own too, but never a program in one of its working trees", async () => {
    const { clone, w, global } = overSsh();
    const userSsh = w.plant("userssh", "exit 1");
    fs.writeFileSync(global, `[core]\n\tsshCommand = ${userSsh}\n`);
    // the repository's own, set by the user's tools for a second account: git's choice, and Mockingbird's
    git(clone, "config", "core.sshCommand", `${w.plant("localssh", "exit 1")} -i ~/.ssh/work`);
    await expect(fetchOrigin(clone)).rejects.toThrow(unreachable);
    expect(w.ran()).toEqual(["localssh"]);
    w.clear();
    // a program in the working tree, which the session's agent can write: by a relative path or a whole one
    const own = ownGitLog();
    w.plant("treessh", "exit 1", path.join(clone, "tools", "ssh"));
    for (const named of ["./tools/ssh", "tools/ssh -v", path.join(fs.realpathSync(clone), "tools", "ssh")]) {
      git(clone, "config", "core.sshCommand", named);
      await expect(fetchOrigin(clone)).rejects.toThrow(unreachable);
      expect(w.ran(), named).toEqual(["userssh"]);
      w.clear();
    }
    // or in another of its working trees, wherever that is
    const linked = path.join(tempDir("elsewhere"), "linked");
    git(clone, "worktree", "add", "-q", "-b", "linked", linked);
    w.clear();
    const inLinked = w.plant("linkedssh", "exit 1", path.join(linked, "ssh"));
    git(clone, "config", "core.sshCommand", inLinked);
    expect((await ownNetworkEnv(clone)).GIT_SSH_COMMAND).toBe(userSsh);
    // each set aside is logged once, however often it's run
    await expect(fetchOrigin(clone)).rejects.toThrow(unreachable);
    await expect(fetchOrigin(clone)).rejects.toThrow(unreachable);
    const setAside = own.filter((l) => / set aside /.test(l));
    expect(setAside).toHaveLength(4);
    expect(setAside[0]).toBe(`Mockingbird's own git in ${clone}: core.sshCommand ./tools/ssh set aside for ${userSsh}: its program, ./tools/ssh, is in ${fs.realpathSync(clone)}, a working tree of this repository, which a session there can change`);
    expect(setAside[3]).toContain(`its program, ${inLinked}, is in ${fs.realpathSync(linked)}`);
    // with none the user's own: GIT_SSH, quoted, else ssh itself, as git picks them
    git(clone, "config", "--unset", "core.sshCommand");
    fs.writeFileSync(global, "");
    expect((await ownNetworkEnv(clone)).GIT_SSH_COMMAND).toBe("ssh");
    git(clone, "config", "core.sshCommand", "./tools/ssh");
    vi.stubEnv("GIT_SSH", "/opt/my ssh/ssh");
    expect((await ownNetworkEnv(clone)).GIT_SSH_COMMAND).toBe("'/opt/my ssh/ssh'");
    // main's own GIT_SSH_COMMAND wins over any config already
    vi.stubEnv("GIT_SSH_COMMAND", "ssh -i key");
    expect((await ownNetworkEnv(clone)).GIT_SSH_COMMAND).toBeUndefined();
  });

  it("run the ssh a global includeIf gives this folder, for the clone and its linked worktrees, and a worktree's own", async () => {
    const { clone, w, global } = overSsh();
    const linked = path.join(tempDir("elsewhere"), "linked");
    git(clone, "worktree", "add", "-q", "-b", "linked", linked);
    const personal = makeRepo({ "p.txt": "p\n" }, "personal");
    // a work identity: the global config's own ssh for everything, a work key's for this clone's folder
    const workSsh = w.plant("workssh", "exit 1");
    const included = path.join(path.dirname(global), "work.gitconfig");
    fs.writeFileSync(included, `[core]\n\tsshCommand = ${workSsh}\n`);
    const defaultSsh = w.plant("defaultssh", "exit 1");
    fs.writeFileSync(global, `[core]\n\tsshCommand = ${defaultSsh}\n[includeIf "gitdir:${fs.realpathSync(clone)}/"]\n\tpath = ${included}\n`);
    w.clear();
    await expect(fetchOrigin(clone)).rejects.toThrow(unreachable);
    expect(w.ran()).toEqual(["workssh"]);
    w.clear();
    // a linked worktree is matched by its clone's .git, wherever the worktree is
    await expect(fetchOrigin(linked)).rejects.toThrow(unreachable);
    expect(w.ran()).toEqual(["workssh"]);
    // a worktree's own setting is the repository's own config, and git's last word for it
    git(clone, "config", "extensions.worktreeConfig", "true");
    const worktreeSsh = w.plant("worktreessh", "exit 1");
    git(linked, "config", "--worktree", "core.sshCommand", worktreeSsh);
    expect((await ownNetworkEnv(linked)).GIT_SSH_COMMAND).toBe(worktreeSsh);
    expect((await ownNetworkEnv(clone)).GIT_SSH_COMMAND).toBe(workSsh);
    // and a folder the includeIf doesn't match gets the global config's own
    expect((await ownNetworkEnv(personal)).GIT_SSH_COMMAND).toBe(defaultSsh);
  });

  it("set an ssh aside that's set in a file in one of the repository's working trees, whatever its program: one the config includes from there", async () => {
    const { clone, w, global } = overSsh();
    const userSsh = w.plant("userssh", "exit 1");
    fs.writeFileSync(global, `[core]\n\tsshCommand = ${userSsh}\n`);
    // a team's tracked .gitconfig, which the repository's own config includes: the session's agent writes it
    fs.writeFileSync(path.join(clone, "team.gitconfig"), `[core]\n\tsshCommand = ssh -o ProxyCommand='${w.plant("proxied", "exit 1")}'\n`);
    git(clone, "config", "include.path", "../team.gitconfig");
    const own = ownGitLog();
    expect((await ownNetworkEnv(clone)).GIT_SSH_COMMAND).toBe(userSsh);
    // and no credential manager's window, which nobody is watching for
    expect((await ownNetworkEnv(clone)).GCM_INTERACTIVE).toBe("never");
    await expect(ownFetch(clone, ["-q", "origin"])).rejects.toThrow(unreachable);
    expect(w.ran()).toEqual(["userssh"]);
    expect(own.find((l) => / set aside /.test(l))).toContain(`: it's set in team.gitconfig, a file in ${fs.realpathSync(clone)}, a working tree of this repository, which a session there can change`);
    // a room's git, a team room feature's fetch among them, runs none of it: that file names what it may
    w.clear();
    await expect(fetchOrigin(clone)).rejects.toThrow(`Mockingbird runs none of a team room session's git with this repository's config: team.gitconfig, a file in ${fs.realpathSync(clone)}`);
    await expect(ownNetworkEnv(clone, { room: true })).rejects.toThrow("sets core.sshcommand");
    expect(w.ran()).toEqual([]);
    // the repository's own config, in its .git, is the user's tools': an ssh set there runs
    git(clone, "config", "--unset", "include.path");
    const localSsh = w.plant("localssh", "exit 1");
    git(clone, "config", "core.sshCommand", localSsh);
    expect((await ownNetworkEnv(clone)).GIT_SSH_COMMAND).toBe(localSsh);
    expect((await ownNetworkEnv(clone, { room: true })).GCM_INTERACTIVE).toBe("never");
  });

  it("log a failure with the repository, the whole command and git's words, and say which ssh was set aside and why", async () => {
    const { clone, w, global } = overSsh();
    const userSsh = w.plant("userssh", "echo 'Permission denied (publickey).' >&2; exit 255");
    fs.writeFileSync(global, `[core]\n\tsshCommand = ${userSsh}\n`);
    w.plant("treessh", "exit 1", path.join(clone, "tools", "ssh"));
    git(clone, "config", "core.sshCommand", "./tools/ssh");
    const own = ownGitLog();
    const failure = await fetchOrigin(clone).then(
      () => null,
      (err: Error) => err.message
    );
    expect(failure).toMatch(/Permission denied \(publickey\)/);
    expect(failure).toContain(`(Mockingbird ran ${userSsh}, not this repository's core.sshCommand, ./tools/ssh: its program, ./tools/ssh, is in ${fs.realpathSync(clone)}`);
    const failed = own.filter((l) => / git fetch /.test(l));
    expect(failed).toHaveLength(1);
    expect(failed[0].startsWith(`Mockingbird's own git in ${clone}: git fetch --upload-pack=git-upload-pack --recurse-submodules=no -q --prune --no-tags origin: git fetch: `)).toBe(true);
    expect(failed[0]).toMatch(/Permission denied \(publickey\)[\s\S]*not this repository's core\.sshCommand/);
    // a failure with nothing set aside is git's words alone
    git(clone, "config", "--unset", "core.sshCommand");
    own.length = 0;
    await expect(fetchOrigin(clone)).rejects.toThrow(/Permission denied \(publickey\)/);
    expect(own).toHaveLength(1);
    expect(own[0]).not.toContain("core.sshCommand");
  });
});

/** The filter settings `git lfs install` makes. */
const LFS_INSTALL: [string, string][] = [
  ["filter.lfs.clean", "git-lfs clean -- %f"],
  ["filter.lfs.smudge", "git-lfs smudge -- %f"],
  ["filter.lfs.process", "git-lfs filter-process"],
  ["filter.lfs.required", "true"],
];

/** A repository whose big.bin is under git-lfs's driver, set as `git lfs install` sets it once `configure` is done. */
function lfsRepo(configureFirst: boolean): string {
  const repo = makeRepo({ "a.txt": "a\n" });
  const configure = () => {
    for (const [k, v] of LFS_INSTALL) git(repo, "config", k, v);
  };
  if (configureFirst) configure();
  write(repo, { ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n", "big.bin": "binary one\n" });
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "lfs");
  if (!configureFirst) configure();
  return repo;
}

/** A file dated anew, its content the same: a status reads it through its filter to tell whether it changed. */
let dated = 1_600_000_000;
const touch = (file: string) => {
  dated += 10;
  fs.utimesSync(file, dated, dated);
};

describe("git-lfs's own driver", { timeout: 300_000 }, () => {
  // what an app opened from the Dock has, with this run's git first
  const dockPath = (bin: string) => `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
  it.skipIf(programOnPath("git-lfs", "/usr/bin:/bin:/usr/sbin:/sbin"))("is turned off when git-lfs isn't on main's PATH, so a read doesn't fail for want of it", async () => {
    const repo = lfsRepo(false);
    write(repo, { "big.bin": "binary two\n" });
    const bin = tempDir("bin");
    const realGit = (process.env.PATH ?? "").split(":").map((d) => path.join(d, "git")).find((f) => path.isAbsolute(f) && fs.existsSync(f));
    fs.symlinkSync(realGit!, path.join(bin, "git"));
    vi.stubEnv("PATH", dockPath(bin));
    try {
      const plain = spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
      expect(plain.status).not.toBe(0);
      expect(plain.stderr).toMatch(/git-lfs/);
      const g = await guardedGit(repo);
      expect(await g.status(["--porcelain"], { trim: false })).toBe(" M big.bin\n");
      expect(await g.diff([])).toContain("+binary two");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // needs git-lfs itself: what's under test is what it runs
  it.skipIf(!programOnPath("git-lfs", process.env.PATH))("stays on only with no lfs.extension or lfs.storage set, so neither's command or folder is used", async () => {
    const repo = lfsRepo(true);
    const big = path.join(repo, "big.bin");
    expect(git(repo, "cat-file", "-p", "HEAD:big.bin")).toMatch(/^version https:\/\/git-lfs/);
    touch(big);
    const g = await guardedGit(repo);
    expect(await g.status(["--porcelain"]), "on: a file merely touched reads as its pointer, unchanged").toBe("");

    const marker = path.join(path.dirname(repo), "extension-ran");
    const ext = path.join(path.dirname(repo), "extension.sh");
    fs.writeFileSync(ext, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
    git(repo, "config", "lfs.extension.planted.clean", `${ext} %f`);
    git(repo, "config", "lfs.extension.planted.smudge", `${ext} %f`);
    git(repo, "config", "lfs.extension.planted.priority", "0");
    touch(big);
    expect(spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }).status).toBe(0);
    expect(fs.existsSync(marker), "git-lfs runs an extension's clean for a plain status").toBe(true);
    fs.rmSync(marker);
    touch(big);
    expect(await (await guardedGit(repo)).status(["--porcelain"]), "off: the file is read as it is").toBe("M big.bin");
    expect(fs.existsSync(marker)).toBe(false);

    git(repo, "config", "--remove-section", "lfs.extension.planted");
    const elsewhere = path.join(path.dirname(repo), "elsewhere");
    git(repo, "config", "lfs.storage", elsewhere);
    write(repo, { "big.bin": "binary two\n" });
    expect(await (await guardedGit(repo)).status(["--porcelain"])).toBe("M big.bin");
    expect(fs.existsSync(elsewhere), "git-lfs's clean writes its objects where lfs.storage says").toBe(false);
  });
});

describe("where a program is found", () => {
  it("is where sh finds it, from absolute folders alone: one in the repository's own folder isn't git-lfs", () => {
    const a = tempDir("bin-a");
    const b = tempDir("bin-b");
    fs.writeFileSync(path.join(a, "tool"), "#!/bin/sh\n", { mode: 0o644 }); // not runnable: looked past
    fs.mkdirSync(path.join(a, "other"));
    fs.writeFileSync(path.join(b, "tool"), "#!/bin/sh\n", { mode: 0o755 });
    expect(programOnPath("tool", `${a}:${b}`)).toBe(true);
    expect(programOnPath("tool", `${b}:.`)).toBe(true);
    expect(programOnPath("tool", a)).toBe(false);
    expect(programOnPath("other", a)).toBe(false);
    expect(programOnPath("tool", `.:${b}`)).toBe(false);
    expect(programOnPath("tool", `:${b}`)).toBe(false);
    expect(programOnPath("tool", `bin:${b}`)).toBe(false);
    expect(programOnPath("tool", undefined)).toBe(false);
  });
});

describe("the drivers turned off", () => {
  const listing = (...entries: [string, string][]) => entries.map(([k, v]) => `${k}\n${v}\0`).join("");
  const LFS = [
    ["filter.lfs.clean", "git-lfs clean -- %f"],
    ["filter.lfs.smudge", "git-lfs smudge -- %f"],
    ["filter.lfs.process", "git-lfs filter-process"],
    ["filter.lfs.required", "true"],
  ] as [string, string][];
  it("are every one the config names, whatever its name holds", () => {
    expect(driversToTurnOff(listing(["filter.plain.clean", "x"], ["filter.x=y.clean", "x"], ["filter..clean", "x"], ["filter.a.b.smudge", "x"], ["filter.Caps.process", "x"]), true)).toEqual(["plain", "x=y", "", "a.b", "Caps"]);
  });
  it("leave git-lfs's own on, as LFS repositories can't be read without it, and nothing that only looks like it", () => {
    expect(driversToTurnOff(listing(...LFS), true)).toEqual([]);
    expect(driversToTurnOff(listing(...LFS, ["filter.lfs.process", "sh -c evil"]), true)).toEqual(["lfs"]);
    expect(driversToTurnOff(listing(["filter.lfs.clean", "git-lfs clean -- %f; sh evil.sh"], ...LFS.slice(1)), true)).toEqual(["lfs"]);
    expect(driversToTurnOff(listing(["filter.other.clean", "git-lfs clean -- %f"], ["filter.other.smudge", "sh evil.sh"]), true)).toEqual(["other"]);
    expect(driversToTurnOff(listing(["filter.lfs.required", "true"]), true)).toEqual(["lfs"]);
  });
  it("turn git-lfs's own off too when git-lfs isn't on main's PATH, or the config names an extension's command or a storage folder", () => {
    expect(driversToTurnOff(listing(...LFS), false)).toEqual(["lfs"]);
    expect(driversToTurnOff(listing(...LFS, ["lfs.extension.x.clean", "sh evil.sh"]), true)).toEqual(["lfs"]);
    expect(driversToTurnOff(listing(["lfs.extension.x.priority", "0"], ...LFS), true)).toEqual(["lfs"]);
    expect(driversToTurnOff(listing(...LFS, ["lfs.Extension.x.clean", "sh evil.sh"]), true)).toEqual(["lfs"]);
    expect(driversToTurnOff(listing(...LFS, ["lfs.storage", "/elsewhere"]), true)).toEqual(["lfs"]);
    // settings that name no command leave it on
    expect(driversToTurnOff(listing(...LFS, ["lfs.url", "https://lfs.example.invalid"], ["lfs.fetchinclude", "a"], ["lfs.storage.x", "y"]), true)).toEqual([]);
  });
  it("name nothing for a [filter] setting with no driver, and refuse a listing they can't take apart", () => {
    expect(driversToTurnOff("filter.clean\nx\0", true)).toEqual([]);
    expect(driversToTurnOff("", true)).toEqual([]);
    expect(() => driversToTurnOff("core.fsmonitor\nx\0", true)).toThrow(/among the filter and LFS settings/);
  });
});
