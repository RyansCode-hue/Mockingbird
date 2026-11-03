import { spawnSync } from "child_process";
import { buildSync } from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guarded } from "../src/main/handlers";
import { LANDSCAPE_SAVE_MS, LandscapeStore } from "../src/main/landscape";
import { emptyLandscape, type LandscapeChange } from "../src/shared/landscape";
import { tempDir } from "./helpers";

const placement = (x: number) => ({ x, y: 0, w: 800, h: 600 });
const AREA = { x: 0, y: 0, w: 2000, h: 1000, repos: [{ path: "/r", base: null }] };
// a folder's permissions don't stop root, so the tests that rely on them can't run as root
const asRoot = process.getuid?.() === 0;

function setup(name = "landscape") {
  const dir = tempDir(name);
  const file = path.join(dir, "landscape.json");
  const changes: LandscapeChange[] = [];
  const logged: string[] = [];
  const open = () => new LandscapeStore({ file, emit: (c) => changes.push(c), log: (context, err) => logged.push(`${context}: ${err instanceof Error ? err.message : String(err)}`) });
  return { dir, file, changes, logged, open, store: open() };
}
const onDisk = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

afterEach(() => {
  vi.useRealTimers();
});

describe("the landscape store", () => {
  it("starts empty with no file, and with no problems", () => {
    const { store, file } = setup();
    expect(store.get()).toEqual({ landscape: emptyLandscape(), rev: 0, problems: [] });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("saves and loads: what one run changed, the next run reads", () => {
    const { store, open, file } = setup();
    store.update({ workspaces: { a: placement(0) }, areas: { "5101": AREA }, migratedAt: "2026-11-03T00:00:00.000Z" });
    store.update({ stacks: { "5101/api": { active: "b", placement: placement(900) } }, areas: { "5101": { collapsed: true } } });
    store.flush();
    expect(onDisk(file).workspaces.a).toEqual(placement(0));
    const again = open().get();
    expect(again.landscape).toEqual(store.get().landscape);
    expect(again.landscape.areas["5101"].collapsed).toBe(true);
    expect(again.problems).toEqual([]);
  });

  it("writes atomically: a new file renamed over the old, nothing left beside it", () => {
    const { store, file, dir } = setup();
    store.update({ workspaces: { a: placement(0) } });
    store.flush();
    const before = fs.statSync(file).ino;
    store.update({ workspaces: { a: placement(8) } });
    store.flush();
    // the same inode would mean the file was rewritten in place, which a crash could leave half-written
    expect(fs.statSync(file).ino).not.toBe(before);
    expect(fs.readdirSync(dir)).toEqual(["landscape.json"]);
  });

  it("leaves no partial file when the app is killed mid-write: the next start reads the last whole save", () => {
    const { store, file, dir, open } = setup();
    store.update({ workspaces: { a: placement(0) }, areas: { "5101": AREA } });
    store.flush();
    const saved = fs.readFileSync(file, "utf8");

    // a copy of the app, as a plain node process, killed halfway through writing its next save
    const bundle = path.join(dir, "landscape.cjs");
    buildSync({ entryPoints: [fileURLToPath(new URL("../src/main/landscape.ts", import.meta.url))], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent" });
    const script = path.join(dir, "crash.cjs");
    const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`w${i}`, placement(8 * i)]));
    fs.writeFileSync(
      script,
      `const fs = require("fs");
const { LandscapeStore } = require(${JSON.stringify(bundle)});
const store = new LandscapeStore({ file: ${JSON.stringify(file)}, emit() {}, log(context, err) { console.error(context, err); } });
store.update(${JSON.stringify({ workspaces: many })});
const write = fs.writeFileSync;
fs.writeFileSync = (p, data) => {
  write(p, String(data).slice(0, String(data).length >> 1));
  process.kill(process.pid, "SIGKILL");
};
store.flush();
console.error("the write wasn't interrupted");
process.exit(3);
`
    );
    const run = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
    expect(run.signal, run.stderr).toBe("SIGKILL");

    // the killed write got as far as its temp file, which is left over, half written
    const leftover = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftover).toHaveLength(1);
    expect(() => JSON.parse(fs.readFileSync(path.join(dir, leftover[0]), "utf8"))).toThrow();
    // landscape.json is the last save, whole
    expect(fs.readFileSync(file, "utf8")).toBe(saved);
    const next = open();
    expect(next.get().problems).toEqual([]);
    expect(Object.keys(next.get().landscape.workspaces)).toEqual(["a"]);
    // and saving goes on as before, the leftover in no one's way
    next.update({ workspaces: { b: placement(900) } });
    next.flush();
    expect(Object.keys(onDisk(file).workspaces)).toEqual(["a", "b"]);
  });

  it("leaves the last saved file whole when a write fails, and keeps the change to try again", () => {
    const { store, file } = setup();
    store.update({ workspaces: { a: placement(0) } });
    store.flush();
    // the temp file's name taken by a folder: the write fails before anything is renamed
    const tmp = `${fs.realpathSync(file)}.${process.pid}.tmp`;
    fs.mkdirSync(tmp);
    store.update({ workspaces: { a: placement(8) } });
    expect(() => store.flush()).toThrow();
    expect(onDisk(file).workspaces.a.x).toBe(0);
    fs.rmdirSync(tmp);
    store.flush();
    expect(onDisk(file).workspaces.a.x).toBe(8);
  });

  it("gathers the changes made within the save delay into one write", () => {
    vi.useFakeTimers();
    const { store, file } = setup();
    store.update({ workspaces: { a: placement(0) } });
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS / 2);
    store.update({ workspaces: { b: placement(900) } });
    store.update({ workspaces: { a: placement(16) } });
    expect(fs.existsSync(file)).toBe(false);
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS / 2 - 1);
    expect(fs.existsSync(file)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(onDisk(file).workspaces).toEqual({ a: placement(16), b: placement(900) });
    const ino = fs.statSync(file).ino;
    vi.advanceTimersByTime(10 * LANDSCAPE_SAVE_MS);
    expect(fs.statSync(file).ino).toBe(ino); // nothing new: no second write
  });

  it("still saves during a long drag: within the save delay of the first unsaved change, however many follow", () => {
    vi.useFakeTimers();
    const { store, file } = setup();
    for (let i = 0; i < 20; i++) {
      store.update({ workspaces: { a: placement(8 * i) } });
      vi.advanceTimersByTime(LANDSCAPE_SAVE_MS / 4);
    }
    // five delays went by: the drag was saved along the way, not only once it stopped
    expect(onDisk(file).workspaces.a.x).toBeGreaterThanOrEqual(8 * 15);
  });

  it("flushes at once on quit, and the pending timer then writes nothing more", () => {
    vi.useFakeTimers();
    const { store, file, open } = setup();
    store.update({ workspaces: { a: placement(0) } });
    store.flush();
    expect(onDisk(file).workspaces.a).toEqual(placement(0));
    expect(open().get().landscape.workspaces.a).toEqual(placement(0));
    const ino = fs.statSync(file).ino;
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS * 2);
    expect(fs.statSync(file).ino).toBe(ino);
    store.flush(); // nothing unsaved: no write
    expect(fs.statSync(file).ino).toBe(ino);
  });

  it("writes nothing on quit when nothing was changed or even read", () => {
    const { store, file } = setup();
    store.flush();
    store.get();
    store.flush();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("says when a timed save fails, once, and clears it once a save works", () => {
    vi.useFakeTimers();
    const { store, file, changes, logged } = setup();
    store.update({ workspaces: { a: placement(0) } });
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS);
    const tmp = `${fs.realpathSync(file)}.${process.pid}.tmp`;
    fs.mkdirSync(tmp);
    store.update({ workspaces: { a: placement(8) } });
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS);
    store.update({ workspaces: { a: placement(16) } });
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS);
    expect(store.get().problems).toEqual([expect.objectContaining({ kind: "save", file })]);
    expect(store.get().problems[0].message).toContain(file);
    // each failed save is logged; the windows hear of the problem once, then of the next patch carrying it
    expect(logged.filter((l) => l.includes(`couldn't save ${file}`))).toHaveLength(2);
    expect(changes.filter((c) => c.patch === null)).toHaveLength(1);
    expect(changes.at(-1)).toMatchObject({ rev: 3, problems: [{ kind: "save" }] });
    fs.rmdirSync(tmp);
    store.update({ workspaces: { b: placement(900) } });
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS);
    expect(store.get().problems).toEqual([]);
    expect(changes.at(-1)).toEqual({ rev: 4, patch: null, problems: [] });
    expect(onDisk(file).workspaces).toEqual({ a: placement(16), b: placement(900) });
  });

  it.skipIf(asRoot)("reports a folder it can't write to, from the timed save and from the quit's flush, and saves once it can", () => {
    vi.useFakeTimers();
    const { store, file, dir, logged, changes } = setup();
    store.update({ workspaces: { a: placement(0) } });
    store.flush();
    fs.chmodSync(dir, 0o555);
    try {
      store.update({ workspaces: { a: placement(8) } });
      vi.advanceTimersByTime(LANDSCAPE_SAVE_MS);
      expect(store.get().problems).toEqual([expect.objectContaining({ kind: "save", file })]);
      expect(store.get().problems[0].message).toMatch(/EACCES|permission denied/i);
      expect(logged.at(-1)).toContain(`couldn't save ${file}`);
      expect(changes.at(-1)).toMatchObject({ patch: null, problems: [{ kind: "save" }] });
      expect(() => store.flush()).toThrow(/EACCES|permission denied/i);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    expect(onDisk(file).workspaces.a.x).toBe(0);
    store.flush();
    expect(onDisk(file).workspaces.a.x).toBe(8);
    expect(store.get().problems).toEqual([]);
  });

  it("makes and saves a change whose news couldn't be sent to the windows, and logs the failed send", () => {
    vi.useFakeTimers();
    const dir = tempDir("landscape");
    const file = path.join(dir, "landscape.json");
    const logged: string[] = [];
    const store = new LandscapeStore({
      file,
      emit: () => {
        throw new Error("Object has been destroyed");
      },
      log: (context, err) => logged.push(`${context}: ${(err as Error).message}`),
    });
    expect(store.update({ workspaces: { a: placement(0) } })).toMatchObject({ rev: 1, landscape: { workspaces: { a: placement(0) } } });
    expect(logged).toEqual(["landscape: couldn't send revision 1 to the windows: Object has been destroyed"]);
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS);
    expect(onDisk(file).workspaces.a).toEqual(placement(0));
  });

  it("counts, sends and writes nothing for a patch that changes nothing", () => {
    vi.useFakeTimers();
    const { store, file, changes } = setup();
    for (const p of [{}, { workspaces: {} }, { workspaces: { gone: null } }, { areas: { nope: null } }, { workspaces: { a: undefined } }]) expect(store.update(p).rev).toBe(0);
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS * 2);
    store.flush();
    expect([changes, fs.existsSync(file)]).toEqual([[], false]);

    store.update({ workspaces: { a: placement(0) }, areas: { "5101": AREA } });
    store.flush();
    const ino = fs.statSync(file).ino;
    // the same values again, an area's field set to what it is, a front tab already in front
    for (const p of [{ workspaces: { a: placement(0) } }, { areas: { "5101": { x: 0, repos: [{ path: "/r", base: null }] } } }, { areas: { "5101": { collapsed: undefined } } }]) expect(store.update(p).rev).toBe(1);
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS * 2);
    store.flush();
    expect(changes).toHaveLength(1);
    expect(fs.statSync(file).ino).toBe(ino);
  });

  it("sends every window each patch, numbered, in the order they were applied", () => {
    const { store, changes } = setup();
    store.update({ workspaces: { a: placement(0) } });
    store.update({ areas: { "5101": AREA } });
    expect(changes).toEqual([
      { rev: 1, patch: { workspaces: { a: placement(0) } }, problems: [] },
      { rev: 2, patch: { areas: { "5101": AREA } }, problems: [] },
    ]);
    expect(store.get().rev).toBe(2);
  });

  it("applies patches arriving together over IPC one at a time, in arrival order, each numbered and none lost", async () => {
    vi.useFakeTimers();
    const { store, file, changes } = setup();
    const update = guarded("landscape:update", (p) => store.update(p), (_c, err) => String(err));
    await update({ areas: { "5101": AREA } });
    // one window collapses the area and drags a workspace while the other locks it and moves another
    const answers = await Promise.all([
      update({ areas: { "5101": { collapsed: true } } }),
      update({ areas: { "5101": { locked: true } }, workspaces: { b: placement(900) } }),
      ...Array.from({ length: 10 }, (_, i) => update({ workspaces: { a: placement(8 * i) } })),
    ]);
    expect(answers.map((a) => (a as { rev: number }).rev)).toEqual(Array.from({ length: 12 }, (_, i) => i + 2));
    expect(changes.map((c) => c.rev)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS);
    const saved = onDisk(file);
    expect(saved.areas["5101"]).toEqual({ ...AREA, collapsed: true, locked: true });
    expect(saved.workspaces).toEqual({ a: placement(72), b: placement(900) });
  });

  it("refuses a patch that isn't one with the reason, changing nothing and sending nothing", async () => {
    const { store, changes } = setup();
    store.update({ workspaces: { a: placement(0) } });
    expect(() => store.update({ workspaces: { a: { x: "left" } } })).toThrow(/workspaces\["a"\]\.x is not a number/);
    expect(() => store.update({ areas: { "5102": { collapsed: true } } })).toThrow(/areas\["5102"\] isn't on the landscape/);
    expect(() => store.update({ wires: {} })).toThrow(/wires/);
    expect(store.get()).toMatchObject({ rev: 1, landscape: { workspaces: { a: placement(0) }, areas: {} } });
    expect(changes).toHaveLength(1);
    // as the window gets it: an answer naming what's wrong, and a line in the log
    const logged: string[] = [];
    const update = guarded("landscape:update", (p) => store.update(p), (c, err) => (logged.push(c), (err as Error).message));
    expect(await update({ workspaces: { a: null, b: { x: 0, y: 0, w: 0, h: 1 } } })).toEqual({ error: 'workspaces["b"].w is not above 0' });
    expect(logged).toEqual(["landscape:update"]);
    expect(store.get().landscape.workspaces.a).toEqual(placement(0));
  });
});

describe("a landscape file that can't be used", () => {
  it("is moved aside when it isn't JSON, said in the log with its path, and reported for a banner", () => {
    const { file, open, logged } = setup();
    fs.writeFileSync(file, '{"v":1,"workspaces":');
    const store = open();
    const { landscape, problems } = store.get();
    expect(landscape).toEqual(emptyLandscape());
    expect(problems).toHaveLength(1);
    const [p] = problems;
    expect(p).toMatchObject({ kind: "corrupt", file });
    expect(p.readOnly).toBeUndefined();
    expect(p.movedTo).toMatch(new RegExp(`^${escape(file)}\\.bad-\\d+$`));
    expect(p.message).toContain(file);
    expect(p.message).toContain(p.movedTo);
    expect(fs.readFileSync(p.movedTo!, "utf8")).toBe('{"v":1,"workspaces":');
    expect(fs.existsSync(file)).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(file);
    expect(logged[0]).toContain(p.movedTo);
    // the layout starts over, saved fresh, and the old file is never written over
    store.update({ workspaces: { a: placement(0) } });
    store.flush();
    expect(fs.readFileSync(p.movedTo!, "utf8")).toBe('{"v":1,"workspaces":');
    expect(onDisk(file).workspaces.a).toEqual(placement(0));
    // the banner stays for the run: saving again doesn't make it go away
    expect(store.get().problems).toEqual([p]);
  });

  it("is moved aside when it's JSON but not a landscape, naming what's wrong", () => {
    const { file, open } = setup();
    fs.writeFileSync(file, JSON.stringify({ v: 1, workspaces: {}, areas: { "5101": { x: 0 } }, stacks: {}, ghosts: {} }));
    const [p] = open().get().problems;
    expect(p.kind).toBe("corrupt");
    expect(p.message).toMatch(/areas\["5101"\]\.y is missing/);
    expect(fs.existsSync(p.movedTo!)).toBe(true);
  });

  it("is moved aside when it's empty, rather than read as no layout", () => {
    const { file, open } = setup();
    fs.writeFileSync(file, "");
    expect(open().get().problems).toEqual([expect.objectContaining({ kind: "corrupt" })]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it.skipIf(asRoot)("is left alone when it can't be moved aside: changes are kept for the run but nothing is written over it", () => {
    const { dir, file, open, logged, changes } = setup();
    fs.writeFileSync(file, "not json");
    fs.chmodSync(dir, 0o555);
    try {
      const store = open();
      const [p] = store.get().problems;
      expect(p).toMatchObject({ kind: "corrupt", readOnly: true });
      expect(p.movedTo).toBeUndefined();
      expect(p.message).toContain("aren't saved");
      expect(logged.join("\n")).toContain("couldn't be moved aside");
      store.update({ workspaces: { a: placement(0) } });
      expect(store.get().landscape.workspaces.a).toEqual(placement(0));
      expect(changes.at(-1)).toMatchObject({ rev: 1, problems: [p] });
      store.flush();
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    expect(fs.readFileSync(file, "utf8")).toBe("not json");
    expect(fs.readdirSync(dir)).toEqual(["landscape.json"]);
  });

  it("is left as it is when a newer Mockingbird wrote it, and changes aren't saved over it", () => {
    vi.useFakeTimers();
    const { file, open, logged } = setup();
    const newer = JSON.stringify({ v: 2, everything: "else" });
    fs.writeFileSync(file, newer);
    const store = open();
    const [p] = store.get().problems;
    expect(p).toMatchObject({ kind: "newer", readOnly: true, file });
    expect(logged[0]).toContain(file);
    store.update({ tourDone: true });
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS * 2);
    store.flush();
    expect(fs.readFileSync(file, "utf8")).toBe(newer);
  });

  it("isn't touched until the landscape is first asked for", () => {
    const { file, open } = setup();
    fs.writeFileSync(file, "not json");
    const store = open();
    store.flush();
    expect(fs.existsSync(file)).toBe(true);
    store.get();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("reports a save that fails after it was moved aside alongside the move, not instead of it", () => {
    vi.useFakeTimers();
    const { file, open } = setup();
    fs.writeFileSync(file, "not json");
    const store = open();
    const [moved] = store.get().problems;
    fs.mkdirSync(`${path.join(fs.realpathSync(path.dirname(file)), "landscape.json")}.${process.pid}.tmp`);
    store.update({ workspaces: { a: placement(0) } });
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS);
    expect(store.get().problems.map((p) => p.kind)).toEqual(["corrupt", "save"]);
    expect(store.get().problems[0]).toEqual(moved);
  });
});
