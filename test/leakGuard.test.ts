import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { alive } from "./e2e/processes";
import { git, makeRepo, tempDir } from "./helpers";
import { checkRun, findStrays, killStrays, record } from "./leaks";

const root = path.resolve(__dirname, "..");

/** Process groups these tests started, each killed whole when its test ends. */
const groups: number[] = [];
afterEach(() => {
  for (const g of groups.splice(0)) {
    try {
      process.kill(-g, "SIGKILL");
    } catch {
      // ended already
    }
  }
});

/** `script` under /bin/sh in a process group of its own, left to run on; resolves with the pids it echoes before its last line, ".". */
async function orphans(script: string, cwd: string): Promise<number[]> {
  const sh = spawn("/bin/sh", ["-c", script], { cwd, detached: true, stdio: ["ignore", "pipe", "ignore"] });
  sh.unref();
  groups.push(sh.pid!);
  let out = "";
  await new Promise<void>((resolve) => sh.stdout!.on("data", (d) => ((out += d), out.endsWith("\n.\n") && resolve())));
  sh.stdout!.destroy();
  return out.split("\n").filter((l) => /^\d+$/.test(l)).map(Number);
}

const gone = async (pids: number[]) => {
  for (let i = 0; i < 50 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 20));
  return pids.filter(alive);
};

describe("finding what tests left running", () => {
  it("finds a process working in, or naming, a temp folder, and nothing in a folder that only starts the same", async () => {
    const dir = tempDir("strays");
    const sibling = `${dir}-other`;
    fs.mkdirSync(sibling);
    const [inside] = await orphans("sleep 60 & echo $!; echo .", dir);
    const [naming] = await orphans(`/bin/sh -c 'sleep 61; true' ${dir}/x & echo $!; echo .`, "/");
    const [next] = await orphans("sleep 62 & echo $!; echo .", sibling);
    const found = findStrays({ roots: [dir] });
    expect(found.map((s) => s.pid).sort()).toEqual([inside, naming].sort());
    expect(found.find((s) => s.pid === inside)?.why).toMatch(/^it runs in .*strays-/);
    expect(found.find((s) => s.pid === naming)?.why).toBe(`its command names ${dir}`);
    expect(findStrays({ roots: [sibling] }).map((s) => s.pid)).toEqual([next]);
  });

  it("finds this file's children by ancestry, wherever they run", async () => {
    const child = spawn("/bin/sleep", ["60"], { cwd: "/", stdio: "ignore" });
    expect(findStrays({ roots: [] }).map((s) => s.pid)).not.toContain(child.pid);
    expect(findStrays({ roots: [], descendantsOf: process.pid }).find((s) => s.pid === child.pid)?.why).toBe("started by this test file");
    child.kill("SIGKILL");
  });

  it("kills a stray with its process group, taking what never named the folder too", async () => {
    const dir = tempDir("group");
    // the shell names the folder; the sleep it started doesn't, and runs in /
    const [shell, sleep] = await orphans(`echo $$; cd /; sleep 60 & echo $!; echo .; wait # ${dir}`, "/");
    const found = findStrays({ roots: [dir] });
    expect(found.map((s) => s.pid)).toEqual([shell]);
    await killStrays(found);
    expect(await gone([shell, sleep])).toEqual([]);
  });
});

describe("the run's last check", () => {
  it("removes a skipped file's home quietly, and reports a crashed file's home and what still runs in it", async () => {
    const run = tempDir("run");
    const finished = tempDir("finished");
    const skipped = tempDir("skipped");
    const crashed = tempDir("crashed");
    fs.writeFileSync(path.join(crashed, "work.txt"), "unfinished");
    record(run, { kind: "root", path: finished, home: finished });
    record(run, { kind: "started", home: finished, file: "finished.test.ts" });
    record(run, { kind: "leak", file: "finished.test.ts", lines: ["left running (killed now): pid 1234"] });
    record(run, { kind: "ended", home: finished });
    fs.rmSync(finished, { recursive: true });
    record(run, { kind: "root", path: skipped, home: skipped });
    record(run, { kind: "root", path: crashed, home: crashed });
    record(run, { kind: "started", home: crashed, file: "crashed.test.ts" });
    const [sleep] = await orphans("sleep 60 & echo $!; echo .", crashed);

    const problems = await checkRun(run, 0);
    expect(problems).toEqual([
      "finished.test.ts: left running (killed now): pid 1234",
      expect.stringMatching(new RegExp(`^still running when the run ended \\(killed now\\): pid ${sleep} \\(group \\d+\\): sleep 60 — it runs in `)),
      `crashed.test.ts: temp folder ${crashed} was left — its file never finished (its worker crashed or was killed); removed now`,
    ]);
    expect(await gone([sleep])).toEqual([]);
    expect([skipped, crashed].filter((d) => fs.existsSync(d))).toEqual([]);
  });

  it("fails a real run with what its files left: a process from a file that passed, a crashed file's process and home", () => {
    const out = path.join(tempDir("fixture-out"), "left.txt");
    fs.writeFileSync(out, "");
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MB_E2E_APP|VITEST|NODE_OPTIONS)/.test(k)));
    const r = spawnSync(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", "test/fixtures/leaks/vitest.config.mts"], {
      cwd: root,
      env: { ...env, CI: "true", MB_LEAK_FIXTURE_OUT: out },
      encoding: "utf8",
      timeout: 60_000,
    });
    const output = r.stdout + r.stderr;
    const left = fs.readFileSync(out, "utf8").trim().split("\n");
    expect(r.status, output).toBe(1);
    expect(left).toHaveLength(4);
    const home = left.find((l) => l.startsWith("home:"))!.slice(5);
    const scratch = left.find((l) => l.startsWith("dir:"))!.slice(4);
    const pids = left.filter((l) => l.startsWith("pid:")).map((l) => Number(l.slice(4)));
    // the passing file fails, naming what it left; the run's own check lists that, and the crashed file's
    expect(output).toMatch(/leaves\.fixture\.ts left things behind:\n\s+left running \(killed now\): pid \d+ \(group \d+\): \/bin\/sleep 600 — started by this test file/);
    expect(output).toContain("The test run left things behind:");
    expect(output).toMatch(new RegExp(`still running when the run ended \\(killed now\\): pid \\d+ \\(group \\d+\\): /bin/sleep 600 — it runs in (/private)?${home}`));
    expect(output).toContain(`crashes.fixture.ts: temp folder ${home} was left — its file never finished (its worker crashed or was killed); removed now`);
    expect(pids.filter(alive)).toEqual([]);
    expect([home, scratch].filter((d) => fs.existsSync(d))).toEqual([]);
  }, 60_000);
});

describe("a fixture repo", () => {
  it("starts no detached git maintenance when it commits, which would hold a lock in .git/objects as it's copied and could outlive the file", () => {
    const repo = makeRepo();
    expect(git(repo, "config", "--get", "maintenance.auto")).toBe("false");
    const commit = spawnSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "again"], { encoding: "utf8", env: { ...process.env, GIT_TRACE: "1" } });
    expect(commit.status).toBe(0);
    expect(commit.stderr).toContain("built-in: git commit");
    expect(commit.stderr).not.toContain("maintenance");
  });
});
