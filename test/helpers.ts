import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A fresh directory inside this test file's temp home. */
export function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.homedir(), `${name}-`));
}

/** A git repo on `main` with the given files committed. */
export function makeRepo(files: Record<string, string> = { "README.md": "hello\n" }, name = "repo"): string {
  const dir = path.join(tempDir("code"), name);
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
