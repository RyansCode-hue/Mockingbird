import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { electronBin } from "./appInstance";

/**
 * A GitHub for the app tests that never reaches GitHub: origin is `git@github.com:<repo>.git`, so Mockingbird takes it
 * for a GitHub repository, and
 * - git's ssh (GIT_SSH_COMMAND, set in the app's environment, which main's own gits keep) is a stand-in that runs
 *   upload-pack or receive-pack on a bare repository here instead;
 * - `gh`, which Mockingbird runs in the user's login shell, is fakeGh.cjs: the HOME's ~/.zshrc puts its shim first on
 *   PATH, ahead of any real gh the system's paths hold (`ghResolved` checks it before the app starts).
 */

const SCRIPT = path.join(__dirname, "fakeGh.cjs");
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface FakeGithub {
  /** The URL origin is set to. */
  origin: string;
  /** For the app's environment: git's ssh, the stand-in. */
  env: { GIT_SSH_COMMAND: string };
  /** Where the shims are. */
  bin: string;
}

/** The stand-ins for `repo` ("owner/name"), whose origin is the bare repository `bare`, written into `dir` and `home`. */
export function fakeGithub(dir: string, home: string, repo: string, bare: string): FakeGithub {
  const gh = path.join(dir, "gh");
  fs.writeFileSync(gh, `#!/bin/bash\nELECTRON_RUN_AS_NODE=1 exec ${q(electronBin ?? "electron")} ${q(SCRIPT)} "$@"\n`, { mode: 0o755 });
  const ssh = path.join(dir, "ssh");
  // git runs it as `ssh [options] git@github.com "git-upload-pack 'owner/name.git'"`: the last argument is the command
  fs.writeFileSync(
    ssh,
    `#!/bin/bash
cmd="\${@: -1}"
printf '%s\\n' "$*" >> "$HOME/fake-gh/ssh.log"
case "$cmd" in
  ${q(`git-upload-pack '${repo}.git'`)}) exec git upload-pack ${q(bare)} ;;
  ${q(`git-receive-pack '${repo}.git'`)}) exec git receive-pack ${q(bare)} ;;
  *) echo "fake ssh: $* isn't stood in for" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 }
  );
  fs.mkdirSync(path.join(home, "fake-gh"), { recursive: true });
  fs.writeFileSync(path.join(home, "fake-gh", "config.json"), JSON.stringify({ repo, bare }));
  // read after /etc/zprofile's path_helper, so it comes first whatever the system's paths hold
  fs.writeFileSync(path.join(home, ".zshrc"), `export PATH=${q(dir)}:"$PATH"\n`);
  return { origin: `git@github.com:${repo}.git`, env: { GIT_SSH_COMMAND: ssh }, bin: dir };
}

/** The gh the user's login shell finds in `home`, as Mockingbird runs it (an interactive login zsh), with `env`. */
export function ghResolved(home: string, env: Record<string, string> = {}): string {
  return execFileSync("/bin/zsh", ["-ilc", "command -v gh"], { cwd: home, env: { HOME: home, USER: process.env.USER ?? "", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...env }, encoding: "utf8" })
    .trim()
    .split("\n")
    .at(-1)!;
}

export interface FakePr {
  number: number;
  url: string;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "OPEN" | "MERGED";
  headSha: string;
  mergeCommit?: string;
  mergedAt?: string;
}

const stateOf = (home: string): { next: number; prs: FakePr[] } => {
  const f = path.join(home, "fake-gh", "state.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { next: 1, prs: [] };
};

/** The pull requests the stand-in gh has opened. */
export const ghPrs = (home: string): FakePr[] => stateOf(home).prs;

/** Each call made of the stand-in gh: its arguments, where it ran, and the body it read. */
export function ghCalls(home: string): { args: string[]; cwd: string; body?: string }[] {
  const f = path.join(home, "fake-gh", "calls.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** What git ran through the stand-in ssh, a line each. */
export function sshCalls(home: string): string[] {
  const f = path.join(home, "fake-gh", "ssh.log");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
}

/**
 * Pull request `number` merged on "GitHub": its base fast-forwarded to its branch's head in the bare repository, and the
 * stand-in gh says so from now on, with that commit as its merge commit. The commit.
 */
export function mergePr(home: string, number: number): string {
  const state = stateOf(home);
  const pr = state.prs.find((p) => p.number === number);
  if (!pr || pr.state !== "OPEN") throw new Error(`the stand-in GitHub has no open pull request ${number}`);
  const { bare } = JSON.parse(fs.readFileSync(path.join(home, "fake-gh", "config.json"), "utf8"));
  const sha = execFileSync("git", ["--git-dir", bare, "rev-parse", `refs/heads/${pr.head}`], { encoding: "utf8" }).trim();
  execFileSync("git", ["--git-dir", bare, "merge-base", "--is-ancestor", `refs/heads/${pr.base}`, sha]);
  execFileSync("git", ["--git-dir", bare, "update-ref", `refs/heads/${pr.base}`, sha]);
  Object.assign(pr, { state: "MERGED", mergeCommit: sha, mergedAt: new Date().toISOString() });
  const f = path.join(home, "fake-gh", "state.json");
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${f}.tmp`, f);
  return sha;
}
