import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LANDSCAPE_SAVE_MS, LandscapeStore } from "../src/main/landscape";
import { emptyLandscape, type LandscapeChange } from "../src/shared/landscape";
import { emptyWireBook } from "../src/shared/wires";
import { tempDir } from "./helpers";

// reads of a file named here fail with these error codes, one per read, then read it as it is
const reads = vi.hoisted(() => ({ failing: new Map<string, string[]>() }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const readFileSync = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const code = typeof p === "string" ? reads.failing.get(p)?.shift() : undefined;
    if (code) throw Object.assign(new Error(`${code}: the read failed, open '${String(p)}'`), { code });
    return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

const placement = (x: number) => ({ x, y: 0, w: 800, h: 600 });
const asRoot = process.getuid?.() === 0;
const SAVED = { ...emptyLandscape(), migratedAt: "2026-11-01T00:00:00.000Z", workspaces: { a: placement(0) } };
/** The file as this version writes it: the layout, and the wire book beside it. */
const ON_DISK = { ...SAVED, wires: emptyWireBook() };

function setup() {
  const dir = tempDir("landscape-read");
  const file = path.join(dir, "landscape.json");
  fs.writeFileSync(file, JSON.stringify(ON_DISK, null, 2));
  const text = fs.readFileSync(file, "utf8");
  const changes: LandscapeChange[] = [];
  const logged: string[] = [];
  const store = new LandscapeStore({ file, emit: (c) => changes.push(c), log: (context, err) => logged.push(`${context}: ${err instanceof Error ? err.message : String(err)}`) });
  const fail = (...codes: string[]) => reads.failing.set(file, codes);
  /** The file as it was written, alone in its folder: never moved, never saved over. */
  const untouched = () => {
    reads.failing.delete(file);
    expect(fs.readFileSync(file, "utf8")).toBe(text);
    expect(fs.readdirSync(dir)).toEqual(["landscape.json"]);
  };
  return { dir, file, store, changes, logged, fail, untouched };
}

afterEach(() => {
  reads.failing.clear();
  vi.useRealTimers();
});

describe("a landscape file that can't be read just now", () => {
  it("is left where it is: an empty stand-in is shown, kept in memory and never saved, even on quit", () => {
    vi.useFakeTimers();
    const { store, file, changes, logged, fail, untouched } = setup();
    fail("EMFILE", "EMFILE");
    const got = store.get();
    expect(got.landscape).toEqual(emptyLandscape());
    expect(got.problems).toEqual([expect.objectContaining({ kind: "unreadable", file, readOnly: true })]);
    expect(got.problems[0].movedTo).toBeUndefined();
    expect(got.problems[0].message).toContain(file);
    expect(got.problems[0].message).toContain("EMFILE");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(file);
    // the stand-in takes changes, and every window hears of them
    expect(store.update({ workspaces: { b: placement(900) } }).landscape.workspaces).toEqual({ b: placement(900) });
    expect(changes.map((c) => c.rev)).toEqual([1]);
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS * 4);
    store.flush();
    untouched();
  });

  it("is read again with the next change, and its layout replaces the stand-in, whose changes are dropped and said so", () => {
    vi.useFakeTimers();
    const { store, file, changes, logged, fail, untouched } = setup();
    fail("EMFILE", "EIO", "EIO");
    store.get();
    store.update({ workspaces: { b: placement(900) } });
    const still = store.update({ areas: { "5101": { x: 0, y: 0, w: 2000, h: 1000, repos: [] } } });
    expect(still.problems).toEqual([expect.objectContaining({ kind: "unreadable", message: expect.stringContaining("EIO") })]);
    expect(Object.keys(still.landscape.workspaces)).toEqual(["b"]);
    // the file reads now
    const back = store.get();
    expect(back.landscape).toEqual(SAVED);
    expect(back.rev).toBe(3);
    expect(back.problems).toEqual([expect.objectContaining({ kind: "dropped", file })]);
    expect(back.problems[0].message).toContain("2 layout changes");
    expect(changes.at(-1)).toEqual({ rev: 3, patch: null, landscape: SAVED, problems: back.problems });
    expect(logged.at(-1)).toContain("could be read again; dropped 2 layout changes");
    untouched();
    // and saving goes on from the file's layout, without the stand-in's changes
    store.update({ workspaces: { c: placement(1800) } });
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ...ON_DISK, workspaces: { a: placement(0), c: placement(1800) } });
  });

  it("drops a patch made against the stand-in that arrives just as the file reads again", () => {
    const { store, changes, fail } = setup();
    fail("EAGAIN");
    store.get();
    const answer = store.update({ workspaces: { b: placement(900) } });
    expect(answer.landscape).toEqual(SAVED);
    expect(answer.problems).toEqual([expect.objectContaining({ kind: "dropped", message: expect.stringContaining("1 layout change made") })]);
    expect(changes).toEqual([{ rev: 1, patch: null, landscape: SAVED, problems: answer.problems }]);
  });

  it("comes back quietly when nothing was changed meanwhile: the windows get the file's layout, and no problem stays", () => {
    const { store, changes, fail } = setup();
    fail("EMFILE");
    store.get();
    // a patch that wouldn't have changed the stand-in drops nothing
    const answer = store.update({ workspaces: { gone: null } });
    expect([answer.landscape, answer.problems]).toEqual([SAVED, []]);
    expect(changes).toEqual([{ rev: 1, patch: null, landscape: SAVED, problems: [] }]);
  });

  it("logs a read that keeps failing once for each reason, not on every retry", () => {
    const { store, logged, fail } = setup();
    fail("EMFILE", "EMFILE", "EMFILE", "EIO", "EIO");
    for (let i = 0; i < 5; i++) store.get();
    expect(logged.map((l) => l.match(/E[A-Z]+:/)?.[0])).toEqual(["EMFILE:", "EIO:"]);
  });

  it("is left alone when it's a folder, which no retry reads", () => {
    const { dir, file } = setup();
    fs.rmSync(file);
    fs.mkdirSync(file);
    const store = new LandscapeStore({ file, emit: () => {}, log: () => {} });
    expect(store.get().problems).toEqual([expect.objectContaining({ kind: "unreadable", message: expect.stringMatching(/EISDIR/) })]);
    store.update({ workspaces: { a: placement(0) } });
    store.flush();
    expect(store.get().problems.map((p) => p.kind)).toEqual(["unreadable"]);
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["landscape.json"]);
  });

  it.skipIf(asRoot)("is left alone when its permissions keep it from being read, and read once they're fixed", () => {
    const { store, file, untouched } = setup();
    fs.chmodSync(file, 0o000);
    try {
      expect(store.get().problems).toEqual([expect.objectContaining({ kind: "unreadable", message: expect.stringMatching(/EACCES|permission denied/i) })]);
      store.flush();
    } finally {
      fs.chmodSync(file, 0o644);
    }
    expect(store.get()).toMatchObject({ landscape: SAVED, problems: [] });
    untouched();
  });
});
