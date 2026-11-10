import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { onTestFinished } from "vitest";
import { logOwnGitFailuresTo } from "../src/main/safeGit";
import { removeAtEnd } from "./leaks";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A fresh directory inside this test file's temp home, removed with it. */
export function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.homedir(), `${name}-`));
}

/** A fresh directory outside this test file's temp home (in the system's temp folder), removed when the file ends. */
export function scratchDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  removeAtEnd(dir);
  return dir;
}

/** A git repo on `main` with the given files committed, in `parent` (a fresh temp folder by default). */
export function makeRepo(files: Record<string, string> = { "README.md": "hello\n" }, name = "repo", parent = tempDir("code")): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", dir]);
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

export function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

/**
 * What Mockingbird's own network gits log (logOwnGitFailuresTo) for the rest of the test, each as "<context>: <what>":
 * their failures, and what they set aside.
 */
export function ownGitLog(): string[] {
  const lines: string[] = [];
  const before = logOwnGitFailuresTo((context, err) => lines.push(`${context}: ${err instanceof Error ? err.message : String(err)}`));
  onTestFinished(() => void logOwnGitFailuresTo(before));
  return lines;
}
