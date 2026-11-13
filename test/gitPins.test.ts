import { execFileSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { git } from "../src/main/git";
import { clearGitPins, gitPinRefusal, onGitPinRefused, pinGitDirs, readGitPointer, unpinGitDirs } from "../src/main/gitPins";
import { roomGitDirs } from "../src/main/codexRoomSandbox";
import { worktreeState } from "../src/main/worktrees";
import { guardedGit, logOwnGitFailuresTo, ownFetch, ownNetworkGit, OWN_WRITE_ENV, roomFilters, WRITE_ENV } from "../src/main/safeGit";
import { takeSnapshot } from "../src/main/snapshots";
import { searchFiles } from "../src/main/find";
import { tempDir } from "./helpers";

/** git in a room session's folder held to the git data it started on, whatever its agent writes there. */

afterEach(() => clearGitPins());

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-C", cwd, ...args], { encoding: "utf8" });

/** A repository with a linked worktree, and a git folder elsewhere whose config runs a program on every status. */
function setup() {
  const dir = fs.realpathSync(tempDir("pins"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const wt = path.join(dir, "wt");
  sh(repo, "worktree", "add", "-q", "-b", "5110", wt);
  // the agent's git folder: a copy of the worktree's own, its commondir leading to a copy of the shared one with core.fsmonitor
  const ran = path.join(dir, "FSMONITOR-RAN");
  const fsm = path.join(dir, "fsm.sh");
  fs.writeFileSync(fsm, `#!/bin/sh\necho ran >> "${ran}"\nexit 1\n`, { mode: 0o755 });
  const evilCommon = path.join(dir, "evilcommon");
  fs.cpSync(path.join(repo, ".git"), evilCommon, { recursive: true });
  sh(repo, "config", "-f", path.join(evilCommon, "config"), "core.fsmonitor", fsm);
  const evilOwn = path.join(dir, "evilwt");
  fs.cpSync(path.join(repo, ".git", "worktrees", "wt"), evilOwn, { recursive: true });
  fs.writeFileSync(path.join(evilOwn, "commondir"), evilCommon + "\n");
  const rewrite = () => fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${evilOwn}\n`);
  return { dir, repo, wt, ran, rewrite };
}

describe("git in a room session's folder", () => {
  it("runs while its .git leads where it did at launch, and is refused once it's rewritten — the other git folder's fsmonitor never runs", async () => {
    const t = setup();
    expect(pinGitDirs(t.wt, (await roomGitDirs(t.wt))!, t.repo)).toBeNull();
    expect(readGitPointer(t.wt)).toEqual({ common: path.join(t.repo, ".git"), own: path.join(t.repo, ".git", "worktrees", "wt") });
    expect((await worktreeState(t.wt)).branch).toBe("5110");
    expect(await (await guardedGit(t.wt)).status(["--porcelain"])).toBe("");
    const told: string[] = [];
    const off = onGitPinRefused((top, why) => told.push(`${top}: ${why}`));

    t.rewrite();
    // every git main runs there goes through git.ts: the status poll, a commit, a discard alike
    await expect(git(t.wt, ["status", "--porcelain"])).rejects.toThrow(/won't run git in .*its \.git now leads to .*evilwt/);
    await expect(git(t.wt, ["commit", "--allow-empty", "-m", "x"])).rejects.toThrow(/won't run git/);
    await expect(git(path.join(t.wt), ["checkout", "--", "."])).rejects.toThrow(/won't run git/);
    // guarded reads, and writes with the repository's settings overridden, as well
    await expect(guardedGit(t.wt).then((g) => g.status(["--porcelain"]))).rejects.toThrow(/won't run git/);
    await expect(git(t.wt, ["add", "-A"], { env: WRITE_ENV })).rejects.toThrow(/won't run git/);
    await expect(git(t.wt, ["fetch", "origin"], { env: OWN_WRITE_ENV })).rejects.toThrow(/won't run git/);
    // Mockingbird's own fetches, ls-remotes and pushes, each failure logged where the app logs them
    const ownLogged: string[] = [];
    const before = logOwnGitFailuresTo((context, err) => ownLogged.push(`${context}: ${err}`));
    try {
      await expect(ownFetch(t.wt, ["origin"])).rejects.toThrow(/won't run git/);
      await expect(ownNetworkGit(t.wt, "ls-remote", ["origin"])).rejects.toThrow(/won't run git/);
      await expect(ownNetworkGit(t.wt, "push", ["origin", "HEAD"], { roomPush: { lfs: { remote: "origin", refs: ["HEAD"] } } })).rejects.toThrow(/won't run git/);
    } finally {
      logOwnGitFailuresTo(before);
    }
    expect(ownLogged).toHaveLength(3);
    expect(ownLogged.every((l) => l.includes("won't run git"))).toBe(true);
    // the one git main starts itself, Find's streamed git grep, waits on isRepo's git, which is refused
    await expect(searchFiles(t.wt, "x", { regex: false, matchCase: false })).rejects.toThrow(/won't run git/);
    expect(fs.existsSync(t.ran)).toBe(false);
    expect(told).toHaveLength(1);
    off();

    // as git itself would have done without the check: the program runs
    execFileSync("git", ["-C", t.wt, "status", "--porcelain"], { stdio: "ignore" });
    expect(fs.existsSync(t.ran)).toBe(true);
  });

  it("refuses a new .git between the folder it's asked in and the pinned top, which git would find first", async () => {
    const t = setup();
    pinGitDirs(t.wt, (await roomGitDirs(t.wt))!, t.repo);
    const sub = path.join(t.wt, "src");
    fs.mkdirSync(sub);
    expect(gitPinRefusal(sub)).toBeNull();
    fs.writeFileSync(path.join(sub, ".git"), "gitdir: /elsewhere\n");
    expect(gitPinRefusal(sub)).toMatch(/there's a \.git in .*src that git would find before/);
    // the top itself is still as it was
    expect(gitPinRefusal(t.wt)).toBeNull();
  });

  it("isn't pinned to a .git rewritten before its launch: one that doesn't lead into the session's repository is refused from the start", async () => {
    const t = setup();
    t.rewrite();
    const found = await roomGitDirs(t.wt);
    expect(found!.common).toContain("evilcommon");
    expect(pinGitDirs(t.wt, found!, t.repo)).toMatch(/isn't one of .*evilcommon's worktrees|not to .*repo's git data/);
    await expect(git(t.wt, ["status"])).rejects.toThrow(/won't run git/);
    expect(fs.existsSync(t.ran)).toBe(false);
  });

  it("holds a pin to the session's repository: a worktree folder of another repository, or one outside its repository's worktrees, is refused", async () => {
    const t = setup();
    // a worktree folder made inside another repository's git folder, its commondir leading there
    const other = path.join(t.dir, "other");
    fs.mkdirSync(other);
    sh(other, "init", "-q", "-b", "main");
    sh(other, "commit", "-q", "--allow-empty", "-m", "init");
    const foreign = path.join(other, ".git", "worktrees", "wt");
    fs.cpSync(path.join(t.repo, ".git", "worktrees", "wt"), foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, "commondir"), "../..\n");
    fs.writeFileSync(path.join(t.wt, ".git"), `gitdir: ${foreign}\n`);
    expect(pinGitDirs(t.wt, (await roomGitDirs(t.wt))!, t.repo)).toMatch(/not to .*repo's git data/);
    // a folder outside the repository's worktrees whose commondir leads to the session's own repository
    const stray = path.join(t.dir, "stray");
    fs.cpSync(path.join(t.repo, ".git", "worktrees", "wt"), stray, { recursive: true });
    fs.writeFileSync(path.join(stray, "commondir"), path.join(t.repo, ".git") + "\n");
    fs.writeFileSync(path.join(t.wt, ".git"), `gitdir: ${stray}\n`);
    clearGitPins(); // a launch reads the folder afresh
    expect(pinGitDirs(t.wt, (await roomGitDirs(t.wt))!, t.repo)).toMatch(/isn't one of .*worktrees/);
    await expect(git(t.wt, ["status"])).rejects.toThrow(/won't run git/);
  });

  it("refuses a main checkout's .git folder once it holds a commondir, which git would follow to the other folder's config: its fsmonitor never runs", async () => {
    const t = setup();
    expect(pinGitDirs(t.repo, (await roomGitDirs(t.repo))!, t.repo)).toBeNull();
    expect(await git(t.repo, ["status", "--porcelain"])).toBe("");
    // the agent's commondir in the shared folder, leading to a copy of it whose config has core.fsmonitor
    const evil = path.join(t.dir, "evilcommon");
    fs.writeFileSync(path.join(t.repo, ".git", "commondir"), evil + "\n");
    expect(() => readGitPointer(t.repo)).toThrow(/holds a commondir, which would lead git to another folder's git data/);
    await expect(git(t.repo, ["status", "--porcelain"])).rejects.toThrow(/won't run git in .*its \.git couldn't be read \(.*holds a commondir/);
    await expect(guardedGit(t.repo).then((g) => g.status(["--porcelain"]))).rejects.toThrow(/won't run git/);
    expect(fs.existsSync(t.ran)).toBe(false);
    // one written before the launch is refused from the start: the launch's own git, and the pin
    clearGitPins();
    await expect(roomGitDirs(t.repo)).rejects.toThrow(/won't run git in .*its \.git holds a commondir/);
    expect(pinGitDirs(t.repo, { common: path.join(t.repo, ".git"), own: path.join(t.repo, ".git") }, t.repo)).toMatch(/holds a commondir/);
    // as git itself does without the check: it reads the other folder's config, and the program runs
    execFileSync("git", ["-C", t.repo, "status", "--porcelain"], { stdio: "ignore" });
    expect(fs.existsSync(t.ran)).toBe(true);
  });

  it("refuses a pinned .git folder another was put in place of, under the same path: its fsmonitor never runs", async () => {
    const t = setup();
    expect(pinGitDirs(t.repo, (await roomGitDirs(t.repo))!, t.repo)).toBeNull();
    // the agent's: the git folder moved away, and a copy whose config has core.fsmonitor put in its place
    const fsm = path.join(t.dir, "fsm.sh");
    fs.renameSync(path.join(t.repo, ".git"), path.join(t.repo, ".git-old"));
    fs.cpSync(path.join(t.repo, ".git-old"), path.join(t.repo, ".git"), { recursive: true });
    sh(t.repo, "config", "core.fsmonitor", fsm);
    expect(readGitPointer(t.repo)).toEqual({ common: path.join(t.repo, ".git"), own: path.join(t.repo, ".git") });
    await expect(git(t.repo, ["status", "--porcelain"])).rejects.toThrow(/won't run git in .*its git folder .*\.git isn't the one its room session started with/);
    expect(fs.existsSync(t.ran)).toBe(false);
  });

  it("refuses git in a folder no room session pinned whose .git holds a commondir: a local session's snapshot, a room's config check and a room repository's push run nothing the other folder's config names", async () => {
    const dir = fs.realpathSync(tempDir("stray"));
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="t"' });
      res.end();
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
    onTestFinished(() => void server.close());
    const main = path.join(dir, "main");
    fs.mkdirSync(main);
    sh(main, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(main, "README"), "x\n");
    sh(main, "add", "-A");
    sh(main, "commit", "-q", "-m", "base");
    sh(main, "remote", "add", "origin", `http://127.0.0.1:${(server.address() as { port: number }).port}/repo.git`);
    // the agent's: a commondir to a folder of its own under .git, whose config names a filter for every file and a credential helper
    const mark = (n: string) => path.join(dir, `RAN-${n}`);
    const fake = path.join(main, ".git", "fake");
    fs.mkdirSync(path.join(fake, "info"), { recursive: true });
    for (const d of ["objects", "refs", "logs"]) fs.symlinkSync(`../${d}`, path.join(fake, d));
    const config = fs.readFileSync(path.join(main, ".git", "config"), "utf8");
    fs.writeFileSync(path.join(fake, "config"), `${config}[filter "evil"]\n\tclean = "echo x >> '${mark("filter")}'; cat"\n[credential]\n\thelper = "!f() { echo x >> '${mark("helper")}'; }; f"\n`);
    fs.writeFileSync(path.join(fake, "info", "attributes"), "* filter=evil\n");
    fs.writeFileSync(path.join(main, ".git", "commondir"), "fake\n");
    fs.appendFileSync(path.join(main, "README"), "edit\n");

    const told: string[] = [];
    const off = onGitPinRefused((top, why) => told.push(`${top}: ${why}`));
    const refused = `Mockingbird won't run git in ${main}: its .git holds a commondir, which would lead git to another folder's config`;
    const before = logOwnGitFailuresTo(() => {});
    try {
      await expect(takeSnapshot(main, "local1", "a local turn")).rejects.toThrow(refused);
      await expect(takeSnapshot(main, "room1", "a room turn", { room: true })).rejects.toThrow(refused);
      await expect(roomFilters(main)).rejects.toThrow(refused);
      await expect(ownNetworkGit(main, "push", ["--no-verify", "-q", "origin", "HEAD:refs/mockingbird/x"], { roomRepo: true, timeoutMs: 20_000 })).rejects.toThrow(refused);
      await expect(git(main, ["status", "--porcelain"])).rejects.toThrow(refused);
    } finally {
      logOwnGitFailuresTo(before);
      off();
    }
    expect(fs.existsSync(mark("filter"))).toBe(false);
    expect(fs.existsSync(mark("helper"))).toBe(false);
    expect(told).toEqual([expect.stringContaining(refused)]); // told once
    // with it gone, git runs there again
    fs.rmSync(path.join(main, ".git", "commondir"));
    expect(await git(main, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    // as git itself does without the check: it reads the other folder's config, and the filter runs
    fs.writeFileSync(path.join(main, ".git", "commondir"), "fake\n");
    execFileSync("git", ["-C", main, "add", "-A"], { stdio: "ignore" });
    expect(fs.existsSync(mark("filter"))).toBe(true);
  });

  it("refuses a room's git when git takes a .git folder's data from elsewhere, as GIT_COMMON_DIR makes it", async () => {
    const t = setup();
    const fake = path.join(t.repo, ".git", "fake");
    fs.mkdirSync(fake);
    for (const d of ["objects", "refs", "logs"]) fs.symlinkSync(`../${d}`, path.join(fake, d));
    fs.copyFileSync(path.join(t.repo, ".git", "config"), path.join(fake, "config"));
    vi.stubEnv("GIT_COMMON_DIR", fake);
    onTestFinished(() => void vi.unstubAllEnvs());
    await expect(roomFilters(t.repo)).rejects.toThrow(`Mockingbird won't run git in ${t.repo}: git reads its git data from ${fake}, not from its .git folder`);
  });

  it("leaves every other folder alone", async () => {
    const t = setup();
    pinGitDirs(t.wt, (await roomGitDirs(t.wt))!, t.repo);
    t.rewrite();
    expect(gitPinRefusal(t.repo)).toBeNull();
    expect(await git(t.repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });
});

describe("git in a room session's folder that had no repository at launch", () => {
  /** A folder with no repository, pinned as a room launch pins it, in `dir`, with a marker an agent's program writes. */
  const launched = async () => {
    const dir = fs.realpathSync(tempDir("norepo"));
    const folder = path.join(dir, "notes");
    fs.mkdirSync(folder);
    const found = await roomGitDirs(folder);
    expect(found).toBeNull();
    expect(pinGitDirs(folder, found, null)).toBeNull();
    return { dir, folder, ran: path.join(dir, "RAN") };
  };

  it("refuses a repository its agent made there after: its core.sshCommand never runs, a room push included", async () => {
    const t = await launched();
    // the agent, in a sandbox that let it write .git there: a repository with an ssh origin and a command of its own for it
    sh(t.folder, "init", "-q", "-b", "main");
    sh(t.folder, "commit", "-q", "--allow-empty", "-m", "a");
    sh(t.folder, "remote", "add", "origin", "ssh://git@example.invalid/x/y.git");
    sh(t.folder, "config", "core.sshCommand", `sh -c 'echo "$*" >> ${t.ran}; exit 1' --`);
    const told: string[] = [];
    const off = onGitPinRefused((_top, why) => told.push(why));
    const refused = `Mockingbird won't run git in ${t.folder}: it had no repository when its room session started, and now git would find ${path.join(t.folder, ".git")}, which that session's agent could have made, config and all.`;
    const before = logOwnGitFailuresTo(() => {});
    try {
      expect(gitPinRefusal(t.folder)).toContain(refused);
      await expect(ownNetworkGit(t.folder, "push", ["origin", "main"], { roomPush: { lfs: { remote: "origin", refs: ["refs/heads/main"] } } })).rejects.toThrow(refused);
      await expect(roomFilters(t.folder)).rejects.toThrow(refused);
      await expect(git(path.join(t.folder), ["status", "--porcelain"])).rejects.toThrow(refused);
    } finally {
      logOwnGitFailuresTo(before);
      off();
    }
    expect(told).toEqual([expect.stringContaining(refused)]);
    expect(fs.existsSync(t.ran)).toBe(false);
    // the session launched again reads the folder afresh, as livePanes does: its pin let go of first
    unpinGitDirs(t.folder);
    expect(pinGitDirs(t.folder, await roomGitDirs(t.folder), null)).toBeNull();
    expect(await git(t.folder, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("refuses a repository made above it, which git would find from it, till a launch pins the folder again", async () => {
    const t = await launched();
    sh(t.dir, "init", "-q", "-b", "main");
    sh(t.dir, "commit", "-q", "--allow-empty", "-m", "a");
    await expect(git(t.folder, ["status", "--porcelain"])).rejects.toThrow(`now git would find ${path.join(t.dir, ".git")}`);
    // pinned again (git's own answer read here, as the old pin refuses Mockingbird's), it replaces what it had
    const gitDir = path.join(t.dir, ".git");
    expect(pinGitDirs(t.folder, { common: gitDir, own: gitDir }, null)).toBeNull();
    expect(gitPinRefusal(t.folder)).toBeNull();
    expect(await git(t.folder, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("leaves a repository inside it as any other, and a room session pinned there to its own pin", async () => {
    const t = await launched();
    expect(gitPinRefusal(t.folder)).toBeNull();
    const nested = path.join(t.folder, "app");
    fs.mkdirSync(nested);
    sh(nested, "init", "-q", "-b", "main");
    sh(nested, "commit", "-q", "--allow-empty", "-m", "a");
    expect(await git(nested, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(pinGitDirs(nested, await roomGitDirs(nested), null)).toBeNull();
    expect(await git(path.join(nested), ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    // the outer folder still has none, as git finds from it
    await expect(git(t.folder, ["rev-parse", "--git-dir"])).rejects.toThrow(/not a git repository/);
    // the nested one's own pin holds it: another .git folder put in its place is refused
    fs.renameSync(path.join(nested, ".git"), path.join(t.dir, "old-git"));
    fs.cpSync(path.join(t.dir, "old-git"), path.join(nested, ".git"), { recursive: true });
    await expect(git(nested, ["status", "--porcelain"])).rejects.toThrow(/isn't the one its room session started with: another was put in its place/);
  });
});

describe("a folder made to look like a bare repository", () => {
  it("is never git's: in a folder below a repository's top, the config its agent wrote there runs nothing", async () => {
    const dir = fs.realpathSync(tempDir("bare"));
    const ran = path.join(dir, "RAN");
    const evil = path.join(dir, "evil.sh");
    fs.writeFileSync(evil, `#!/bin/sh\necho "$*" >> "${ran}"\nexit 1\n`, { mode: 0o755 });
    const mono = path.join(dir, "mono");
    const x = path.join(mono, "packages", "x");
    fs.mkdirSync(x, { recursive: true });
    fs.writeFileSync(path.join(x, "a"), "needle\n");
    sh(mono, "init", "-q", "-b", "main");
    sh(mono, "add", "-A");
    sh(mono, "commit", "-q", "-m", "mono's");
    // the agent, writing only packages/x: what makes a folder a git folder, with a config naming a gpg.program a
    // signed commit's log runs
    fs.writeFileSync(path.join(x, "HEAD"), "ref: refs/heads/main\n");
    fs.mkdirSync(path.join(x, "objects"));
    fs.mkdirSync(path.join(x, "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(x, "config"), `[core]\n\tbare = true\n[log]\n\tshowSignature = true\n[gpg]\n\tprogram = ${evil}\n`);
    const tree = execFileSync("git", ["mktree"], { cwd: x, input: "", encoding: "utf8" }).trim();
    const signed = `tree ${tree}\nauthor t <t@t> 0 +0000\ncommitter t <t@t> 0 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n x\n -----END PGP SIGNATURE-----\n\nthe agent's\n`;
    const commit = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: x, input: signed, encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(x, "refs", "heads", "main"), `${commit}\n`);
    // git as it is: the folder is a repository of its own, and a plain log runs the agent's program
    execFileSync("git", ["log", "-1", "--format=%s"], { cwd: x, stdio: "ignore" });
    expect(fs.readFileSync(ran, "utf8")).not.toBe("");
    fs.rmSync(ran);

    // Mockingbird's: refused by git, saying why
    const refused = `cannot use bare repository '${x}' (safe.bareRepository is 'explicit')`;
    await expect(git(x, ["log", "-1", "--format=%s"])).rejects.toThrow(refused);
    await expect(searchFiles(x, "needle", { regex: false, matchCase: true })).rejects.toThrow(refused);
    expect(fs.existsSync(ran)).toBe(false);
    // the repository's top, and the folders with no such files, are git's as before
    expect(await git(path.dirname(x), ["log", "-1", "--format=%s"])).toBe("mono's");
  });
});
