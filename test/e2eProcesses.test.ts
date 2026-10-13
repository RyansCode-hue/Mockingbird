import { spawn, type ChildProcess } from "child_process";
import { describe, expect, it } from "vitest";
import { alive, descendants, killOrphans, killTree, track } from "./e2e/processes";

/** A shell running two sleeps; resolves once both have started, with their pids. */
async function tree(): Promise<{ sh: ChildProcess; sleeps: number[] }> {
  const sh = spawn("/bin/sh", ["-c", "sleep 60 & echo $!; sleep 60 & echo $!; wait"], { stdio: ["ignore", "pipe", "ignore"] });
  const sleeps: number[] = [];
  await new Promise<void>((resolve) =>
    sh.stdout!.on("data", (d) => {
      sleeps.push(...String(d).trim().split(/\s+/).map(Number));
      if (sleeps.length === 2) resolve();
    })
  );
  return { sh, sleeps };
}

const gone = async (pids: number[]) => {
  for (let i = 0; i < 50 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 20));
  return pids.filter(alive);
};

describe("the e2e harness's processes", () => {
  it("kills a process and everything it started", async () => {
    const { sh, sleeps } = await tree();
    expect(descendants(sh.pid!).sort()).toEqual([...sleeps].sort());
    killTree(sh.pid!);
    expect(await gone([sh.pid!, ...sleeps])).toEqual([]);
  });

  it("finds and kills what a process left running when it exited", async () => {
    const sh = spawn("/bin/sh", ["-c", "sleep 60 & echo $!; sleep 1"], { stdio: ["ignore", "pipe", "ignore"] });
    const left = await new Promise<number>((resolve) => sh.stdout!.once("data", (d) => resolve(Number(String(d).trim()))));
    const started = descendants(sh.pid!);
    await new Promise((r) => sh.once("exit", r));
    expect(killOrphans(started)).toEqual([left]);
    expect(await gone([left])).toEqual([]);
  });

  let unended: number[] = [];
  it("(leaves a tracked process running, as a timed-out test would)", async () => {
    const { sh, sleeps } = await tree();
    track(sh);
    unended = [sh.pid!, ...sleeps];
  });

  it("kills a tracked process, and what it started, once its test is over", async () => {
    expect(unended).toHaveLength(3);
    expect(await gone(unended)).toEqual([]);
  });
});
