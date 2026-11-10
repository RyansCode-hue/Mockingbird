import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../src/main/git";
import { clearGitPins, gitPinRefusal, onGitPinRefused, pinGitDirs, readGitPointer } from "../src/main/gitPins";
import { roomGitDirs } from "../src/main/codexRoomSandbox";
import { worktreeState } from "../src/main/worktrees";
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
    const told: string[] = [];
    const off = onGitPinRefused((top, why) => told.push(`${top}: ${why}`));

    t.rewrite();
    // every git main runs there goes through git.ts: the status poll, a commit, a discard alike
    await expect(git(t.wt, ["status", "--porcelain"])).rejects.toThrow(/won't run git in .*its \.git now leads to .*evilwt/);
    await expect(git(t.wt, ["commit", "--allow-empty", "-m", "x"])).rejects.toThrow(/won't run git/);
    await expect(git(path.join(t.wt), ["checkout", "--", "."])).rejects.toThrow(/won't run git/);
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

  it("leaves every other folder alone", async () => {
    const t = setup();
    pinGitDirs(t.wt, (await roomGitDirs(t.wt))!, t.repo);
    t.rewrite();
    expect(gitPinRefusal(t.repo)).toBeNull();
    expect(await git(t.repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });
});
