import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomSandboxWatch } from "../src/main/roomSandboxWatch";

/** Whether a Claude room launch's sandbox settings were taken, from what its hooks report and when. */

afterEach(() => vi.useRealTimers());

function watch(ms = 1000, now = 10_000_500) {
  const told: string[] = [];
  const w = new RoomSandboxWatch("m1", { confirmed: () => told.push("confirmed"), failed: (why) => told.push(`failed: ${why}`) }, ms, now);
  return { w, told };
}

describe("a room launch's sandbox watch", () => {
  it("is confirmed by its own marker, Mockingbird's SessionStart and Claude Code's own account of its sandbox, in any order, once", () => {
    const a = watch();
    a.w.sessionStarted();
    a.w.reported("m1", false);
    a.w.reported("m1", false);
    expect(a.w.state).toBe("starting");
    a.w.proved();
    a.w.proved();
    expect([a.w.state, a.told]).toEqual(["confirmed", ["confirmed"]]);
    const b = watch();
    b.w.proved();
    b.w.reported("m1", false);
    expect(b.w.state).toBe("starting");
    b.w.sessionStarted();
    expect(b.w.state).toBe("confirmed");
    a.w.stop();
    b.w.stop();
  });

  it("waits out a turn once the marker and the start came first: only the out-of-band account is left, which a turn can't forge", () => {
    const { w, told } = watch();
    w.reported("m1", false);
    w.sessionStarted();
    w.turn(10_001);
    expect([w.state, told]).toEqual(["starting", []]);
    w.proved();
    expect(w.state).toBe("confirmed");
    w.stop();
  });

  it("fails for good when Claude Code's own account says otherwise, whatever came before or after", () => {
    const { w, told } = watch();
    w.reported("m1", false);
    w.sessionStarted();
    w.disproved("Claude Code 2.1.318 reads the room's settings with its sandbox off");
    w.proved();
    expect([w.state, told]).toEqual(["failed", ["failed: Claude Code 2.1.318 reads the room's settings with its sandbox off"]]);
  });

  it("takes no other marker for its own", () => {
    const { w, told } = watch();
    w.sessionStarted();
    w.reported("m2", false);
    expect([w.state, told]).toEqual(["starting", []]);
    w.stop();
  });

  it("fails for good on a turn's event before both have come, but not on one stamped before its launch", () => {
    const { w, told } = watch();
    w.reported("m1", false);
    w.turn(10_000 - 1); // the pane's earlier launch's, read late
    expect(w.state).toBe("starting");
    w.turn(10_000);
    w.sessionStarted();
    expect([w.state, told]).toEqual(["failed", ["failed: its first turn began before Mockingbird's hooks reported it starting"]]);
  });

  it("fails on a marker read beside a turn's event", () => {
    const { w, told } = watch();
    w.sessionStarted();
    w.reported("m1", true);
    expect(told).toEqual(["failed: its sandbox settings reported in alongside its first turn, so Mockingbird can't tell which came first"]);
  });

  it("fails when nothing comes in time, saying which report is missing", () => {
    vi.useFakeTimers();
    const none = watch(60_000);
    vi.advanceTimersByTime(60_000);
    expect(none.told).toEqual(["failed: its sandbox settings didn't report in within 60 seconds of its start — Claude Code may have rejected them (its pane says so as it starts)"]);
    const noHooks = watch(60_000);
    noHooks.w.reported("m1", false);
    vi.advanceTimersByTime(60_000);
    expect(noHooks.told[0]).toMatch(/^failed: Mockingbird's hooks didn't report it starting within 60 seconds/);
    const noProof = watch(60_000);
    noProof.w.reported("m1", false);
    noProof.w.sessionStarted();
    vi.advanceTimersByTime(60_000);
    expect(noProof.told).toEqual(["failed: Mockingbird's check of its sandbox didn't finish within 60 seconds"]);
    // stopped (its pty ended), it says nothing
    const ended = watch(60_000);
    ended.w.stop();
    vi.advanceTimersByTime(60_000);
    expect(ended.told).toEqual([]);
  });

  it("closes a confirmed launch's line when Claude Code's account, asked again, no longer shows its sandbox on: told once, and for good", () => {
    const { w, told } = watch();
    w.reported("m1", false);
    w.sessionStarted();
    w.proved();
    expect(w.state).toBe("confirmed");
    // an account that still shows it on changes nothing
    w.proved();
    expect([w.state, told]).toEqual(["confirmed", ["confirmed"]]);
    w.disproved("after its Claude Code settings changed, it runs docker outside the sandbox");
    w.disproved("again");
    w.proved();
    expect([w.state, told]).toEqual(["failed", ["confirmed", "failed: after its Claude Code settings changed, it runs docker outside the sandbox"]]);
  });
});
