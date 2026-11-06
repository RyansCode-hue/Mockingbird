import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { createActions } from "../src/renderer/useAction";
import { isErr } from "../src/shared/types";
import { UpdateRunner, findSourceClone, loginShellExec, remoteMatches, startInstaller, takeUpdateOutcome, newestBuild, type Exec } from "../src/main/selfUpdate";
import type { UpdateProgress } from "../src/shared/types";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.homedir(), p));
const gitRepo = (dir: string, origin?: string) => {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q"]);
  if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  return dir;
};
const until = async (ok: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe("finding the clone", () => {
  it("recognises the repository by its origin, https or ssh", () => {
    expect(remoteMatches("https://github.com/RyansCode-hue/Mockingbird.git", "RyansCode-hue", "Mockingbird")).toBe(true);
    expect(remoteMatches("git@github.com:ryanscode-hue/mockingbird.git", "RyansCode-hue", "Mockingbird")).toBe(true);
    expect(remoteMatches("https://github.com/RyansCode-hue/Mockingbird-fork", "RyansCode-hue", "Mockingbird")).toBe(false);
    expect(remoteMatches("https://gitlab.com/RyansCode-hue/Mockingbird", "RyansCode-hue", "Mockingbird")).toBe(false);
    expect(remoteMatches("ssh://git@github.com/me/my.app.git", "me", "my.app")).toBe(true);
    expect(remoteMatches("https://github.com/me/my.app", "me", "my")).toBe(false);
  });

  it("finds it under the repo folders, or uses the folder chosen in Settings (which must be it)", async () => {
    const root = tmp("roots-");
    gitRepo(path.join(root, "other"), "https://github.com/me/other.git");
    const clone = gitRepo(path.join(root, "Mockingbird"), "git@github.com:me/app.git");
    expect(await findSourceClone({ roots: [root], owner: "me", repo: "app" })).toBe(clone);
    expect(await findSourceClone({ roots: [tmp("empty-")], owner: "me", repo: "app" })).toBeNull();
    expect(await findSourceClone({ configured: clone, roots: [], owner: "me", repo: "app" })).toBe(clone);
    await expect(findSourceClone({ configured: path.join(root, "other"), roots: [root], owner: "me", repo: "app" })).rejects.toThrow(/isn't a clone of me\/app/);
  });

  it("says a folder isn't the clone only when git says so — not when git itself can't run", async () => {
    const plain = tmp("plain-"); // not a repository
    const noOrigin = gitRepo(tmp("no-origin-"));
    await expect(findSourceClone({ configured: plain, roots: [], owner: "me", repo: "app" })).rejects.toThrow(/isn't a clone of me\/app/);
    await expect(findSourceClone({ configured: noOrigin, roots: [], owner: "me", repo: "app" })).rejects.toThrow(/isn't a clone of me\/app/);
    const clone = gitRepo(tmp("clone-"), "git@github.com:me/app.git");
    const PATH = process.env.PATH;
    process.env.PATH = "/nonexistent"; // no git to run
    try {
      const err = await findSourceClone({ configured: clone, roots: [], owner: "me", repo: "app" }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toMatch(/isn't a clone/);
      expect((err as Error).message).toMatch(/git/);
    } finally {
      process.env.PATH = PATH;
    }
  });
});

/** A fake shell: the first matching pattern answers; everything else succeeds silently. */
function fakeExec(answers: [RegExp, { code?: number; out?: string } | ((signal: AbortSignal) => Promise<{ code: number; out: string }>)][]) {
  const ran: string[] = [];
  const exec: Exec = async (cmd, _cwd, onOut, signal) => {
    ran.push(cmd);
    const hit = answers.find(([re]) => re.test(cmd))?.[1];
    if (typeof hit === "function") return hit(signal);
    const r = { code: hit?.code ?? 0, out: hit?.out ?? "" };
    if (r.out) onOut(r.out);
    return r;
  };
  return { exec, ran };
}

function cloneWithBuild(): string {
  const clone = tmp("clone-");
  fs.mkdirSync(path.join(clone, "release", "mac-arm64", "Mockingbird.app", "Contents"), { recursive: true });
  return clone;
}

const happy = (): Parameters<typeof fakeExec>[0] => [
  [/^git status/, { out: "" }],
  [/rev-parse --abbrev-ref/, { out: "main" }],
  [/symbolic-ref/, { out: "origin/main" }],
  [/^node -v/, { out: "v22.22.3" }],
  [/^plutil/, { out: "1.2.0" }],
];

function runner(exec: Exec, clone: string | null, current = "1.1.5") {
  const seen: UpdateProgress[] = [];
  const r = new UpdateRunner({ exec, currentVersion: current, findClone: async () => clone, onProgress: (p) => seen.push(p) });
  return { r, seen };
}

describe("preparing an update", () => {
  it("checks, pulls, installs and builds in order, then waits ready with the new build", async () => {
    const clone = cloneWithBuild();
    const { exec, ran } = fakeExec(happy());
    const { r } = runner(exec, clone);
    const p = await r.prepare();
    expect(p).toMatchObject({ state: "ready", version: "1.2.0", appPath: path.join(clone, "release", "mac-arm64", "Mockingbird.app"), clone });
    expect(p.done).toEqual(["check", "node", "pull", "install", "build", "verify"]);
    expect(ran.filter((c) => !/^git (status|rev-parse|symbolic-ref)/.test(c))).toEqual([
      "node -v",
      "git fetch origin 'main'",
      "git merge --ff-only origin/'main'",
      "npm ci", // installs what package-lock.json pins without rewriting it
      "npm run package:app",
      `plutil -extract CFBundleShortVersionString raw '${path.join(clone, "release", "mac-arm64", "Mockingbird.app", "Contents", "Info.plist")}'`,
    ]);
  });

  it("stops before touching anything when the clone has uncommitted changes or is on another branch", async () => {
    const clone = cloneWithBuild();
    const dirty = runner(fakeExec([[/^git status/, { out: " M src/a.ts\n M src/b.ts" }]]).exec, clone);
    expect(await dirty.r.prepare()).toMatchObject({ state: "failed", step: "check", problem: expect.stringMatching(/uncommitted changes \(2 file/) });
    const branch = runner(fakeExec([[/rev-parse --abbrev-ref/, { out: "feature/x" }], [/symbolic-ref/, { out: "origin/main" }]]).exec, clone);
    expect((await branch.r.prepare()).problem).toMatch(/on the branch "feature\/x"\. Switch it to main/);
  });

  it("never has a failed update's progress taken for a call that failed: the window says it once, as the update's", async () => {
    const clone = cloneWithBuild();
    const failed = await runner(fakeExec([[/^git status/, { out: " M src/a.ts" }]]).exec, clone).r.prepare();
    expect(failed.state).toBe("failed");
    // what main.tsx's unlessError and the panel's useAction both go by: the panel's own error line stays empty, and
    // the reason shows once, as the update's (progress.problem)
    expect(isErr(failed)).toBe(false);
    const errors: string[] = [];
    await createActions(() => {}, (e) => e && errors.push(e)).run("prepare", () => failed);
    expect(errors).toEqual([]);
    expect(failed.problem).toMatch(/uncommitted changes/);
  });

  it("explains a missing clone, old Node, and a clone that can't fast-forward", async () => {
    expect((await runner(fakeExec([]).exec, null).r.prepare()).problem).toMatch(/No clone of Mockingbird was found/);
    const clone = cloneWithBuild();
    const old = runner(fakeExec([[/^node -v/, { out: "v18.20.8" }], ...happy()]).exec, clone);
    expect(await old.r.prepare()).toMatchObject({ step: "node", problem: expect.stringMatching(/needs Node 22; your shell has v18\.20\.8/) });
    const diverged = runner(fakeExec([[/merge --ff-only/, { code: 128, out: "fatal: Not possible to fast-forward" }], ...happy()]).exec, clone);
    expect(await diverged.r.prepare()).toMatchObject({ step: "pull", problem: expect.stringMatching(/commits GitHub's main doesn't/) });
  });

  it("refuses a build that isn't newer than what's running", async () => {
    const clone = cloneWithBuild();
    const { r } = runner(fakeExec(happy()).exec, clone, "1.2.0");
    expect(await r.prepare()).toMatchObject({ state: "failed", step: "verify", problem: expect.stringMatching(/nothing newer to install/) });
  });

  it("can be cancelled mid-step, leaving nothing installed", async () => {
    const clone = cloneWithBuild();
    const npm = (signal: AbortSignal) => new Promise<{ code: number; out: string }>((res) => signal.addEventListener("abort", () => res({ code: 1, out: "cancelled" })));
    const { r } = runner(fakeExec([[/^npm ci/, npm], ...happy()]).exec, clone);
    const done = r.prepare();
    await until(() => r.progress.step === "install");
    r.cancel();
    expect(await done).toMatchObject({ state: "failed", step: "install", problem: "Cancelled — nothing was installed." });
  });

  it("stays ready to install when the restart is called off", async () => {
    const clone = cloneWithBuild();
    const { r } = runner(fakeExec(happy()).exec, clone);
    await r.prepare();
    r.markInstalling();
    expect(r.progress.state).toBe("installing");
    r.installAborted();
    expect(r.progress).toMatchObject({ state: "ready", version: "1.2.0" });
    r.installAborted(); // only an install in progress goes back
    expect(r.progress.state).toBe("ready");
  });

  it("parses each step's own output, not the banners the user's shell prints", async () => {
    fs.writeFileSync(path.join(os.homedir(), ".zshrc"), `echo "Welcome back"\necho "nvm: using node v22" >&2\n`);
    try {
      const clean = gitRepo(tmp("clean-"));
      const exec = loginShellExec(process.env);
      const logged: string[] = [];
      const ac = new AbortController();
      expect(await exec("git status --porcelain --untracked-files=no", clean, (s) => logged.push(s), ac.signal)).toEqual({ code: 0, out: "" });
      expect(await exec("printf 'v22.3.0'", clean, (s) => logged.push(s), ac.signal)).toEqual({ code: 0, out: "v22.3.0" });
      expect(logged.join("")).toContain("Welcome back"); // the log shows everything
      const failed = await exec("echo building; echo 'npm ERR! missing script' >&2; exit 1", clean, () => {}, ac.signal);
      expect(failed.code).toBe(1);
      expect(failed.out).toMatch(/building[\s\S]*npm ERR! missing script/); // a failure explains itself from stderr too
    } finally {
      fs.rmSync(path.join(os.homedir(), ".zshrc"), { force: true });
    }
  });

  it("picks the newest app under release/", () => {
    const clone = tmp("rel-");
    expect(newestBuild(clone)).toBeNull();
    fs.mkdirSync(path.join(clone, "release", "mac", "Mockingbird.app"), { recursive: true });
    fs.mkdirSync(path.join(clone, "release", "mac-arm64", "Mockingbird.app"), { recursive: true });
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(clone, "release", "mac-arm64", "Mockingbird.app"), later, later);
    expect(newestBuild(clone)).toBe(path.join(clone, "release", "mac-arm64", "Mockingbird.app"));
  });
});

/** A fake .app whose executable prints `label`. */
function fakeApp(at: string, label: string | null): string {
  fs.mkdirSync(path.join(at, "Contents", "MacOS"), { recursive: true });
  if (label !== null) fs.writeFileSync(path.join(at, "Contents", "MacOS", "Mockingbird"), `#!/bin/sh\necho ${label}\n`, { mode: 0o755 });
  return at;
}

describe("the installer", () => {
  async function install(newLabel: string | null) {
    const dir = tmp("inst-");
    const mbDir = path.join(dir, "mb");
    const target = fakeApp(path.join(dir, "Applications", "Mockingbird.app"), "old");
    const built = fakeApp(path.join(dir, "clone", "release", "mac-arm64", "Mockingbird.app"), newLabel);
    const opened = path.join(dir, "opened.txt");
    const open = path.join(dir, "open.sh");
    fs.writeFileSync(open, `#!/bin/sh\necho "$1" > '${opened}'\n`, { mode: 0o755 });
    const running = spawn("sleep", ["30"]); // stands in for the app that has to quit first
    startInstaller({ mbDir, pid: running.pid!, builtApp: built, targetApp: target, from: "1.1.5", to: "1.2.0", sessions: ["s1", "s2"], open });
    await new Promise((r) => setTimeout(r, 700));
    expect(fs.existsSync(path.join(mbDir, "update-result.txt"))).toBe(false); // still waiting for the app to quit
    running.kill();
    await until(() => fs.existsSync(opened));
    const run = (app: string) => execFileSync(path.join(app, "Contents", "MacOS", "Mockingbird"), { encoding: "utf8" }).trim();
    return { mbDir, target, opened: fs.readFileSync(opened, "utf8").trim(), result: fs.readFileSync(path.join(mbDir, "update-result.txt"), "utf8").trim(), now: run(target), dir };
  }

  it("waits for the app to quit, swaps the new build in and reopens it", async () => {
    const r = await install("new");
    expect(r.result).toBe("ok");
    expect(r.now).toBe("new");
    expect(r.opened).toBe(r.target);
    expect(fs.existsSync(path.join(r.dir, "Applications", "Mockingbird.previous.app"))).toBe(false);
    expect(takeUpdateOutcome(r.mbDir, "1.2.0")).toMatchObject({ ok: true, message: "Updated to 1.2.0.", sessions: ["s1", "s2"] });
  }, 30_000);

  it("keeps the old app, and says why, when the new build is broken", async () => {
    const r = await install(null);
    expect(r.result).toMatch(/^failed: the new build is missing/);
    expect(r.now).toBe("old");
    expect(r.opened).toBe(r.target);
    expect(takeUpdateOutcome(r.mbDir, "1.1.5")).toMatchObject({ ok: false, message: expect.stringMatching(/^Update to 1\.2\.0 failed: the new build is missing/), sessions: ["s1", "s2"] });
  }, 30_000);

  it("won't replace something that isn't an app bundle", () => {
    expect(() => startInstaller({ mbDir: tmp("x-"), pid: 1, builtApp: "/b.app", targetApp: "/usr/local/bin/electron", from: "1", to: "2", sessions: [] })).toThrow(/isn't an installed app/);
  });
});

describe("after the restart", () => {
  const pending = (mbDir: string, at = Date.now()) => {
    fs.mkdirSync(mbDir, { recursive: true });
    fs.writeFileSync(path.join(mbDir, "update-pending.json"), JSON.stringify({ from: "1.1.5", to: "1.2.0", sessions: ["a"], at }));
  };
  it("is read once, then forgotten", () => {
    const mbDir = tmp("out-");
    expect(takeUpdateOutcome(mbDir, "1.2.0")).toBeNull();
    pending(mbDir);
    fs.writeFileSync(path.join(mbDir, "update-result.txt"), "ok\n");
    expect(takeUpdateOutcome(mbDir, "1.2.0")).toMatchObject({ ok: true });
    expect(takeUpdateOutcome(mbDir, "1.2.0")).toBeNull();
  });
  it("reports an installer that never finished, or a version that didn't change", () => {
    const mbDir = tmp("out-");
    pending(mbDir);
    expect(takeUpdateOutcome(mbDir, "1.1.5")).toMatchObject({ ok: false, message: expect.stringMatching(/didn't finish — see .*update\.log/) });
    pending(mbDir);
    fs.writeFileSync(path.join(mbDir, "update-result.txt"), "ok\n");
    expect(takeUpdateOutcome(mbDir, "1.1.5")).toMatchObject({ ok: false, message: "The installer finished, but this is still 1.1.5 (expected 1.2.0)." });
  });
  it("ignores a marker left from long ago", () => {
    const mbDir = tmp("out-");
    pending(mbDir, Date.now() - 2 * 24 * 3_600_000);
    expect(takeUpdateOutcome(mbDir, "1.2.0")).toBeNull();
  });
  it("says so once when its record is unreadable, then clears it", () => {
    const mbDir = tmp("out-");
    fs.writeFileSync(path.join(mbDir, "update-pending.json"), '{"from": "1.1.5", "to":');
    fs.writeFileSync(path.join(mbDir, "update-result.txt"), "ok\n");
    expect(takeUpdateOutcome(mbDir, "1.2.0")).toMatchObject({ ok: false, sessions: [], message: expect.stringMatching(/update-pending\.json\) couldn't be read/) });
    expect(fs.existsSync(path.join(mbDir, "update-pending.json"))).toBe(false);
    expect(fs.existsSync(path.join(mbDir, "update-result.txt"))).toBe(false);
    expect(takeUpdateOutcome(mbDir, "1.2.0")).toBeNull();
  });
});
