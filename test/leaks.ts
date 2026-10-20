import { execFileSync } from "child_process";
import * as fs from "fs";

/**
 * What tests leave behind: processes still running from a test file (its
 * own children, or anything whose command line or working folder is in one
 * of its temp folders) and the temp folders themselves. Each test file
 * checks its own when it ends (test/setup.ts); the run checks all of its
 * files' when it ends (test/globalSetup.ts). Only this run's temp folders
 * count, so test runs in other sessions at the same time are never touched.
 */

export interface Stray {
  pid: number;
  pgid: number;
  command: string;
  why: string;
}

interface Row {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

/** This user's live processes (zombies, already ended, left out). */
function processRows(): Row[] {
  const uid = process.getuid!();
  const rows: Row[] = [];
  const out = execFileSync("/bin/ps", ["-A", "-ww", "-o", "uid=,pid=,ppid=,pgid=,stat=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) !== uid || m[5].startsWith("Z")) continue;
    rows.push({ pid: Number(m[2]), ppid: Number(m[3]), pgid: Number(m[4]), command: m[6] });
  }
  return rows;
}

/** Each of this user's processes' working folder, from lsof. */
function workingFolders(): Map<number, string> {
  let out: string;
  try {
    out = execFileSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-u", String(process.getuid!()), "-Fpn"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    // lsof exits 1 when a process went away while it looked; what it printed still holds
    const partial = (err as { stdout?: string }).stdout;
    if (typeof partial !== "string" || !partial) throw new Error(`lsof couldn't list working folders: ${(err as Error).message}`);
    out = partial;
  }
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/** A folder's spellings: macOS's /tmp is /private/tmp, and a process may name either. */
function spellings(root: string): string[] {
  const all = new Set([root]);
  if (root.startsWith("/tmp/")) all.add(`/private${root}`);
  if (root.startsWith("/private/tmp/")) all.add(root.slice("/private".length));
  try {
    all.add(fs.realpathSync(root));
  } catch {
    // removed already: its spellings above still name it
  }
  return [...all];
}

/** Whether `text` (a command line) names `root` or something in it — /tmp/mbt-ab isn't in /tmp/mbt-abc. */
function names(text: string, root: string): boolean {
  for (let i = text.indexOf(root); i >= 0; i = text.indexOf(root, i + 1)) {
    const next = text[i + root.length];
    if (next === undefined || next === "/" || /[\s"':=]/.test(next)) return true;
  }
  return false;
}

const inside = (dir: string, root: string) => dir === root || dir.startsWith(`${root}/`);

/** This process and its ancestors (the test runner, npm, the shell): never strays. */
function ancestry(byPid: Map<number, Row>): Set<number> {
  const mine = new Set<number>();
  for (let p: number | undefined = process.pid; p && p > 1 && !mine.has(p); p = byPid.get(p)?.ppid) mine.add(p);
  return mine;
}

/**
 * The processes running now that belong to `roots` (temp folders): named by
 * their command line or working in one; and, with `descendantsOf`, every
 * process descended from that pid. Never this process or its ancestors.
 */
export function findStrays(o: { roots: string[]; descendantsOf?: number }): Stray[] {
  const rows = processRows();
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const mine = ancestry(byPid);
  const roots = o.roots.flatMap(spellings);
  const found = new Map<number, Stray>();
  const add = (r: Row, why: string) => {
    if (!mine.has(r.pid) && !found.has(r.pid)) found.set(r.pid, { pid: r.pid, pgid: r.pgid, command: r.command, why });
  };
  if (o.descendantsOf !== undefined) {
    const children = new Map<number, Row[]>();
    for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r]);
    const todo = [o.descendantsOf];
    while (todo.length) for (const c of children.get(todo.pop()!) ?? []) (add(c, "started by this test file"), todo.push(c.pid));
  }
  for (const r of rows) {
    const root = roots.find((x) => names(r.command, x));
    if (root) add(r, `its command names ${root}`);
  }
  if (roots.length) {
    for (const [pid, cwd] of workingFolders()) {
      const r = byPid.get(pid);
      const root = r && roots.find((x) => inside(cwd, x));
      if (r && root) add(r, `it runs in ${cwd}`);
    }
  }
  return [...found.values()];
}

/** Strays still there once `graceMs` has passed (processes told to stop are often still ending). */
export async function settledStrays(o: { roots: string[]; descendantsOf?: number }, graceMs: number): Promise<Stray[]> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const left = findStrays(o);
    if (!left.length || Date.now() >= deadline) return left;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const signal = (target: number) => {
  try {
    process.kill(target, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
};

/**
 * Kill strays, each with its process group: everything a debug adapter or a
 * terminal's shell started goes with it, including what never named a temp
 * folder. A group is only killed whole when its leader is a stray or gone —
 * never the group of this process or its ancestors (the test runner's), whose
 * strays are killed one by one. Resolves once they're gone.
 */
export async function killStrays(strays: Stray[]): Promise<void> {
  if (!strays.length) return;
  const rows = processRows();
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const protectedGroups = new Set([...ancestry(byPid)].map((p) => byPid.get(p)?.pgid));
  const stray = new Set(strays.map((s) => s.pid));
  const gone = (pid: number) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
  };
  for (const g of new Set(strays.map((s) => s.pgid))) {
    if (g > 1 && !protectedGroups.has(g) && (stray.has(g) || gone(g))) signal(-g);
  }
  for (const s of strays) signal(s.pid);
  const pids = [...stray];
  for (let i = 0; i < 50; i++) {
    const live = new Set(processRows().map((r) => r.pid));
    if (!pids.some((p) => live.has(p))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  const live = new Set(processRows().map((r) => r.pid));
  throw new Error(`couldn't kill ${pids.filter((p) => live.has(p)).join(", ")}`);
}

export const describeStray = (s: Stray) => `pid ${s.pid} (group ${s.pgid}): ${s.command.length > 300 ? `${s.command.slice(0, 300)}…` : s.command} — ${s.why}`;

// ---- the run's record of its temp folders --------------------------------------------------------

/**
 * One line per event in the run's log (a file in the run's folder, which
 * every test file appends to): a temp folder made (`root`, with the HOME of
 * the file that made it), a file's tests starting and ending, and what a
 * file left behind.
 */
export type RunRecord =
  | { kind: "root"; path: string; home: string }
  | { kind: "started"; home: string; file: string }
  | { kind: "ended"; home: string }
  | { kind: "leak"; file: string; lines: string[] };

export const runLog = (runDir: string) => `${runDir}/log`;

export function record(runDir: string | undefined, r: RunRecord): void {
  if (runDir) fs.appendFileSync(runLog(runDir), `${JSON.stringify(r)}\n`);
}

export function readRun(runDir: string): RunRecord[] {
  if (!fs.existsSync(runLog(runDir))) return [];
  return fs
    .readFileSync(runLog(runDir), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunRecord);
}

/**
 * The run's last check: kills what still runs from any of its temp folders
 * and removes the folders that are left. Returns what went wrong — the
 * leaks its files already reported, and these — as lines to fail the run
 * with. A file whose tests were all skipped never runs its hooks, so its
 * HOME is still here and is removed without a word.
 */
export async function checkRun(runDir: string, graceMs = 2000): Promise<string[]> {
  const records = readRun(runDir);
  const problems: string[] = [];
  const started = new Map<string, string>();
  const ended = new Set<string>();
  const roots: { path: string; home: string }[] = [];
  for (const r of records) {
    if (r.kind === "root") roots.push(r);
    else if (r.kind === "started") started.set(r.home, r.file);
    else if (r.kind === "ended") ended.add(r.home);
    else problems.push(...r.lines.map((l) => `${r.file}: ${l}`));
  }
  const strays = await settledStrays({ roots: roots.map((r) => r.path) }, graceMs);
  for (const s of strays) problems.push(`still running when the run ended (killed now): ${describeStray(s)}`);
  await killStrays(strays);
  for (const r of roots) {
    if (!fs.existsSync(r.path)) continue;
    const file = started.get(r.home);
    let removed = "";
    try {
      await fs.promises.rm(r.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (err) {
      removed = `couldn't remove it: ${(err as Error).message}`;
    }
    if (!file && !removed) continue; // a file that ran no tests
    const how = !file ? "its file ran no tests" : ended.has(r.home) ? "its file couldn't remove it" : "its file never finished (its worker crashed or was killed)";
    problems.push(`${file ?? "a test file"}: temp folder ${r.path} was left — ${how}; ${removed || "removed now"}`);
  }
  return problems;
}

// ---- the current test file's temp folders -------------------------------------------------------

interface FileState {
  /** The run's folder, from the global setup (unset when a file runs without it). */
  run?: string;
  home: string;
  /** Temp folders outside the HOME, removed with it. */
  dirs: Set<string>;
}

/** Kept on globalThis so test/setup.ts and the helpers share it however they're loaded. */
export const thisFile: FileState = ((globalThis as { __mbTestFile?: FileState }).__mbTestFile ??= { home: "", dirs: new Set() });

/** Remove `dir` (a temp folder outside this file's HOME) when the file ends; the run checks it was. */
export function removeAtEnd(dir: string): void {
  thisFile.dirs.add(dir);
  record(thisFile.run, { kind: "root", path: dir, home: thisFile.home });
}
