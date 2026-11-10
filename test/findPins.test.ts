import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearGitPins, pinGitDirs } from "../src/main/gitPins";
import { roomGitDirs } from "../src/main/codexRoomSandbox";
import { searchFiles } from "../src/main/find";
import { tempDir } from "./helpers";

// isRepo answering without git, so the check where Find starts its own git grep is the only one between it and git
vi.mock("../src/main/git", async (original) => ({ ...(await original<typeof import("../src/main/git")>()), isRepo: async () => true }));

afterEach(() => clearGitPins());

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-C", cwd, ...args], { encoding: "utf8" });

describe("Find's git grep in a room session's folder", () => {
  it("starts only while the folder's .git leads where it did at launch", async () => {
    const dir = fs.realpathSync(tempDir("findpins"));
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    sh(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "needle\n");
    sh(repo, "add", "a.txt");
    sh(repo, "commit", "-q", "-m", "init");
    const wt = path.join(dir, "wt");
    sh(repo, "worktree", "add", "-q", "-b", "5110", wt);
    expect(pinGitDirs(wt, (await roomGitDirs(wt))!, repo)).toBeNull();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await searchFiles(wt, "needle", { regex: false, matchCase: true })).hits.map((h) => h.path)).toEqual(["a.txt"]);

    // its .git rewritten to a copy of its own git folder: git grep would run there, and find the same
    const copy = path.join(dir, "copy");
    fs.cpSync(path.join(repo, ".git", "worktrees", "wt"), copy, { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${copy}\n`);
    await expect(searchFiles(wt, "needle", { regex: false, matchCase: true })).rejects.toThrow(/^git grep: Mockingbird won't run git in .*its \.git now leads to .*copy/);
    expect(warned).toHaveBeenCalledTimes(1);
  });
});
