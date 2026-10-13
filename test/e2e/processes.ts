import type { ChildProcess } from "child_process";
import { execFileSync } from "child_process";
import { afterAll, afterEach } from "vitest";

/**
 * The processes a test starts outlive no test: each one tracked here is
 * killed, with everything it started, once its test ends — passed, failed or
 * timed out (a timed-out test's body runs on, and never reaches its own
 * cleanup before the test process goes).
 */

/** Every process running now, as pid → parent pid (from ps). */
function processTable(): Map<number, number> {
  const table = new Map<number, number>();
  for (const line of execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid) table.set(pid, ppid);
  }
  return table;
}

/** The processes descended from `pid`, now. */
export function descendants(pid: number): number[] {
  const children = new Map<number, number[]>();
  for (const [p, parent] of processTable()) children.set(parent, [...(children.get(parent) ?? []), p]);
  const found: number[] = [];
  const todo = [pid];
  while (todo.length) for (const c of children.get(todo.pop()!) ?? []) (found.push(c), todo.push(c));
  return found;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function kill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // gone already
  }
}

/** Kill `pid` and everything it started (found before the kill, as they're orphaned by it). */
export function killTree(pid: number): void {
  const tree = descendants(pid);
  kill(pid);
  for (const p of tree) kill(p);
}

/**
 * Of `pids` (a process's descendants, taken while it ran), those still
 * running now that it's gone: orphans, adopted by launchd. They're killed,
 * and returned so a test can say what was left.
 */
export function killOrphans(pids: number[]): number[] {
  const table = processTable();
  const left = pids.filter((p) => table.get(p) === 1);
  for (const p of left) kill(p);
  return left;
}

const tracked = new Set<ChildProcess>();

/** Kill `child` and what it started when the current test ends, unless it has exited by then. */
export function track(child: ChildProcess): void {
  tracked.add(child);
  child.once("exit", () => tracked.delete(child));
}

function killTracked(): void {
  for (const child of tracked) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      console.warn(`[e2e] killing pid ${child.pid}, still running after its test`);
      killTree(child.pid);
    }
    tracked.delete(child);
  }
}

afterEach(killTracked);
afterAll(killTracked);
