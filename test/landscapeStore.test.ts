import { spawnSync } from "child_process";
import { buildSync } from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guarded } from "../src/main/handlers";
import { LANDSCAPE_SAVE_MS, LandscapeStore } from "../src/main/landscape";
import { ADDITIONS_FILE, LANDSCAPE_VERSION, LANDSCAPE_WRITTEN_VERSION, PATCH_RECORDS, emptyLandscape, parsePatch, type LandscapeChange } from "../src/shared/landscape";
import { newWire, WIRE_VERSION, type WireBook, type WireChange, type WireReply, type WireState } from "../src/shared/wires";
import { tempDir } from "./helpers";

const placement = (x: number) => ({ x, y: 0, w: 800, h: 600 });
const AREA = { x: 0, y: 0, w: 2000, h: 1000, repos: [{ path: "/r", base: null }] };
// a folder's permissions don't stop root, so the tests that rely on them can't run as root
const asRoot = process.getuid?.() === 0;

function setup(name = "landscape") {
  const dir = tempDir(name);
  const file = path.join(dir, "landscape.json");
  const changes: LandscapeChange[] = [];
  const wireChanges: WireChange[] = [];
  const logged: string[] = [];
  const open = () => new LandscapeStore({ file, emit: (c) => changes.push(c), emitWires: (c) => wireChanges.push(c), log: (context, err) => logged.push(`${context}: ${err instanceof Error ? err.message : String(err)}`) });
  return { dir, file, changes, wireChanges, logged, open, store: open() };
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

  it("saves tool windows, docked or placed, and artifact cards, as the next run reads them", () => {
    const { store, open, file } = setup();
    store.update({
      areas: { "5101": AREA },
      tools: {
        w1: { tool: "run", docked: false, session: "s1", area: "5101", placement: { x: 820, y: 0, w: 440, h: 600 } },
        w2: { tool: "search", docked: true },
      },
      cards: { c1: { area: "5101", shelf: "area:5101", artifact: "Atagnotesaaaaaaaaaaaaa", placement: { x: 820, y: 620, w: 240, h: 128 } } },
    });
    // placed again from the dock: a window is replaced whole, taking the scope and place it's given
    store.update({ tools: { w2: { tool: "search", docked: false, session: "s2", area: "5101", placement: { x: 1280, y: 0, w: 420, h: 600 } } } });
    store.flush();
    expect(onDisk(file).v).toBe(LANDSCAPE_WRITTEN_VERSION);
    const again = open().get().landscape;
    expect(again.tools).toEqual({
      w1: { tool: "run", docked: false, session: "s1", area: "5101", placement: { x: 820, y: 0, w: 440, h: 600 } },
      w2: { tool: "search", docked: false, session: "s2", area: "5101", placement: { x: 1280, y: 0, w: 420, h: 600 } },
    });
    expect(again.cards.c1.placement).toEqual({ x: 820, y: 620, w: 240, h: 128 });
  });

  it("lets go of a place a session reopened keeps outside its own area, and leaves one inside it", () => {
    const { store } = setup();
    store.update({ areas: { "5101": AREA, "5102": { ...AREA, x: 5000 } }, workspaces: { a: { x: AREA.x + 24, y: AREA.y + 48, w: 400, h: 300 }, b: { x: AREA.x + 24, y: AREA.y + 400, w: 400, h: 300 } } });
    store.sessionReopened({ id: "a", taskGroup: "5101" });
    expect(store.get().landscape.workspaces.a).toBeDefined();
    store.sessionReopened({ id: "b", taskGroup: "5102" });
    expect(store.get().landscape.workspaces.b).toBeUndefined();
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
    const newer = JSON.stringify({ v: LANDSCAPE_VERSION + 1, everything: "else" });
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

describe("the wire book in the landscape's file", () => {
  const WIRE = newWire("a", "b", "handoff", 1);
  const withWire = (book: WireBook) => ({ book: { ...book, links: { ...book.links, w1: WIRE } } });
  const v2 = { v: 2, workspaces: { a: placement(8) }, areas: { "5101": AREA }, stacks: {}, ghosts: {}, tools: {}, cards: {} };
  const v3 = (wires: unknown) => ({ ...v2, v: 3, wires });
  const added = (r: WireReply) => {
    if ("refused" in r) throw new Error(r.refused);
    return r.state;
  };
  const refusedBy = (r: WireReply) => ("refused" in r ? r.refused : `not refused: ${JSON.stringify(r)}`);
  const noBook = (s: WireState) => {
    expect(s.book).toBeNull();
    expect(s.refused).toBeTruthy();
  };

  it("starts empty with no file, and asks nothing of the disk to say so", () => {
    const { store, file } = setup();
    expect(store.wires()).toEqual({ book: { wv: WIRE_VERSION, links: {}, notes: {} }, refused: null, wiresRev: 0, problems: [] });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("reads a version 2 file as one with no wires, with nothing to report, and saves it as this version", () => {
    vi.useFakeTimers();
    const { file, open } = setup();
    fs.writeFileSync(file, JSON.stringify(v2));
    const store = open();
    expect(store.get().landscape.workspaces.a).toEqual(placement(8));
    expect(store.get().problems).toEqual([]);
    expect(store.wires()).toMatchObject({ book: { links: {} }, refused: null, problems: [] });
    expect(onDisk(file).v).toBe(2); // reading writes nothing
    store.update({ tourDone: true });
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS);
    expect(onDisk(file)).toMatchObject({ v: LANDSCAPE_WRITTEN_VERSION, workspaces: { a: placement(8) }, wires: { wv: WIRE_VERSION, links: {}, notes: {} } });
  });

  it("reads a version 1 file the same way", () => {
    const { file, open } = setup();
    const { tools: _t, cards: _c, ...v1 } = { ...v2, v: 1 };
    fs.writeFileSync(file, JSON.stringify(v1));
    const store = open();
    expect(store.get().landscape).toMatchObject({ v: LANDSCAPE_VERSION, workspaces: { a: placement(8) }, tools: {}, cards: {} });
    expect(store.wires()).toMatchObject({ book: { links: {} }, refused: null, problems: [] });
  });

  it("reads a version 3 file, its wires kept, with no colour chosen, and saves it as version 3 with the colour beside it", () => {
    vi.useFakeTimers();
    const { file, open } = setup();
    fs.writeFileSync(file, JSON.stringify(v3({ wv: 1, links: { w1: WIRE }, notes: {} })));
    const store = open();
    expect(store.get().problems).toEqual([]);
    expect(store.get().landscape.areas["5101"]).toEqual(AREA);
    expect(store.wires().book!.links.w1).toEqual(WIRE);
    store.update({ areas: { "5101": { accent: 6 } } });
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS);
    expect(onDisk(file)).toMatchObject({ v: 3, areas: { "5101": AREA }, wires: { links: { w1: WIRE } } });
    expect(onDisk(file).areas["5101"]).toEqual(AREA);
    expect(onDisk(path.join(path.dirname(file), ADDITIONS_FILE))).toEqual({ v: 1, areas: { "5101": { accent: 6 } }, tools: {} });
  });

  it("reports a version 3 file with no wires as edited, as it does one of this version", () => {
    const { file, open, logged } = setup();
    fs.writeFileSync(file, JSON.stringify({ ...v2, v: 3 }));
    expect(open().wires().problems).toEqual([expect.objectContaining({ kind: "missing" })]);
    expect(logged).toEqual([expect.stringMatching(/has no wires in it/)]);
  });

  it("drops an area's colour that isn't one as it reads the file, logs it, and keeps everything else", () => {
    vi.useFakeTimers();
    const { file, open, logged } = setup();
    fs.writeFileSync(file, JSON.stringify({ ...v3({ wv: 1, links: {}, notes: {} }), v: LANDSCAPE_VERSION, areas: { "5101": { ...AREA, accent: 42, collapsed: true } } }));
    const store = open();
    expect(store.get().problems).toEqual([]);
    expect(store.get().landscape.areas["5101"]).toEqual({ ...AREA, collapsed: true });
    expect(store.get().landscape.workspaces.a).toEqual(placement(8));
    expect(logged).toEqual([`landscape: landscape.json's areas["5101"].accent is not a whole number from 0 to 9 (42): it's dropped, and the area takes its automatic colour`]);
    // the file stays as it is until the next change, which saves it without
    expect(onDisk(file).areas["5101"].accent).toBe(42);
    store.update({ tourDone: true });
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS);
    expect(onDisk(file).areas["5101"]).toEqual({ ...AREA, collapsed: true });
  });

  it("saves an area's chosen colour beside landscape.json, and Automatic takes it off disk", () => {
    const { store, open, file } = setup();
    const additions = path.join(path.dirname(file), ADDITIONS_FILE);
    store.update({ areas: { "5101": AREA } });
    store.flush();
    // nothing to add, and no file to say so in
    expect(fs.existsSync(additions)).toBe(false);
    store.update({ areas: { "5101": { accent: 9 } } });
    store.flush();
    expect(onDisk(file).areas["5101"]).toEqual(AREA);
    expect(onDisk(additions).areas["5101"]).toEqual({ accent: 9 });
    expect(open().get().landscape.areas["5101"].accent).toBe(9);
    store.update({ areas: { "5101": { accent: null } } });
    store.flush();
    expect(onDisk(file).areas["5101"]).toEqual(AREA);
    // emptied rather than left, so the colour can't come back with the next start
    expect(onDisk(additions)).toEqual({ v: 1, areas: {}, tools: {} });
    expect(open().get().landscape.areas["5101"]).toEqual(AREA);
    expect(() => store.update({ areas: { "5101": { accent: 10 } } })).toThrow(/accent is not a whole number from 0 to 9/);
  });

  it("moves aside a version 2 file holding wires, as a field that version never had", () => {
    const { file, open } = setup();
    fs.writeFileSync(file, JSON.stringify({ ...v2, wires: { wv: 1, links: {}, notes: {} } }));
    expect(open().get().problems[0]).toMatchObject({ kind: "corrupt", message: expect.stringMatching(/wires/) });
  });

  it("keeps the book out of the layout, in memory and in what a window is told", () => {
    const { store, file, open } = setup();
    fs.writeFileSync(file, JSON.stringify(v3({ wv: 1, links: { w1: WIRE }, notes: {} })));
    const again = open();
    expect(again.get().landscape).not.toHaveProperty("wires");
    expect(store.get().landscape).not.toHaveProperty("wires");
  });

  it("writes a wire change at once, before it's said to have happened, and the next run reads it", () => {
    vi.useFakeTimers();
    const { store, open, file, wireChanges } = setup();
    const state = added(store.editWires(withWire));
    // no timer has run: a wire is saved or it didn't happen
    expect(onDisk(file).wires.links.w1).toEqual(WIRE);
    expect(state.book!.links.w1).toEqual(WIRE);
    expect(state.wiresRev).toBe(1);
    expect(wireChanges).toEqual([state]);
    expect(open().wires().book!.links.w1).toEqual(WIRE);
  });

  it("leaves rev alone on a wire change, so a layout Undo survives it, and sends no landscape change", () => {
    const { store, changes } = setup();
    store.update({ workspaces: { a: placement(0) } });
    const rev = store.get().rev;
    const sent = changes.length;
    added(store.editWires(withWire));
    added(store.editWires((b) => ({ book: { ...b, links: {} } })));
    expect(store.get().rev).toBe(rev);
    expect(changes.length).toBe(sent);
    expect(store.wires().wiresRev).toBe(2);
  });

  it("leaves wiresRev alone on a layout change, and sends no wire change", () => {
    const { store, wireChanges } = setup();
    added(store.editWires(withWire));
    const sent = wireChanges.length;
    store.update({ workspaces: { a: placement(0) } });
    store.flush();
    expect(store.wires().wiresRev).toBe(1);
    expect(wireChanges.length).toBe(sent);
  });

  it("changes, writes and sends nothing when an edit changes nothing or refuses", () => {
    const { store, file, wireChanges } = setup();
    expect(store.editWires((book) => ({ book }))).toEqual({ state: store.wires() });
    expect(store.editWires(() => ({ refused: "no" }))).toEqual({ refused: "no" });
    expect(fs.existsSync(file)).toBe(false);
    expect(wireChanges).toEqual([]);
    expect(store.wires().wiresRev).toBe(0);
  });

  it("saves the layout's waiting changes with a wire's, and writes the wire with the layout's", () => {
    vi.useFakeTimers();
    const { store, file } = setup();
    store.update({ workspaces: { a: placement(0) } });
    added(store.editWires(withWire));
    expect(onDisk(file).workspaces.a).toEqual(placement(0));
    store.update({ workspaces: { b: placement(900) } });
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS);
    expect(onDisk(file)).toMatchObject({ workspaces: { b: placement(900) }, wires: { links: { w1: WIRE } } });
  });

  it("refuses a window's patch naming wires, changing nothing", () => {
    const { store } = setup();
    expect(() => parsePatch({ wires: { wv: 1, links: {}, notes: {} } })).toThrow(/doesn't know \(wires\)/);
    expect(() => store.update({ wires: { links: { w1: WIRE } } })).toThrow(/doesn't know \(wires\)/);
    expect(store.wires().book!.links).toEqual({});
  });

  it("gives Undo nothing of the book to walk, as no patch record holds it", () => {
    expect(PATCH_RECORDS).not.toContain("wires");
  });

  it("names no group or place in a wire, so a rename or a reopen leaves the book alone", () => {
    const { store, wireChanges } = setup();
    store.update({ areas: { "5101": AREA } });
    added(store.editWires(withWire));
    const sent = wireChanges.length;
    store.groupRenamed("5101", "5102", ["a"]);
    store.sessionReopened({ id: "a", taskGroup: "5102" });
    store.flush();
    expect(store.get().landscape.areas["5102"]).toBeTruthy();
    expect(store.wires().book!.links.w1).toEqual(WIRE);
    expect(wireChanges.length).toBe(sent);
  });

  it("keeps one bad wire entry verbatim and inert, reports it, and leaves the layout alone", () => {
    vi.useFakeTimers();
    const { file, open, logged } = setup();
    const bad = { from: "a", to: "b", type: "sees", at: "a later build's" };
    fs.writeFileSync(file, JSON.stringify(v3({ wv: 1, links: { good: WIRE, bad }, notes: {} })));
    const store = open();
    expect(store.get().problems).toEqual([]);
    expect(store.get().landscape.workspaces.a).toEqual(placement(8));
    const state = store.wires();
    expect(Object.keys(state.book!.links)).toEqual(["good"]);
    expect(state.refused).toBeNull();
    expect(state.problems).toEqual([expect.objectContaining({ kind: "entry", id: "bad" })]);
    expect(logged.join("\n")).toMatch(/Wire "bad"/);
    // through a layout save and a wire change it stays exactly as it was
    store.update({ workspaces: { b: placement(900) } });
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS);
    expect(onDisk(file).wires.links.bad).toEqual(bad);
    added(store.editWires(withWire));
    expect(onDisk(file).wires.links).toEqual({ good: WIRE, bad, w1: WIRE });
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".bad-"))).toEqual([]);
  });

  it("leaves a newer book alone through layout saves, and refuses it, saying so", () => {
    vi.useFakeTimers();
    const { file, open } = setup();
    const newer = { wv: WIRE_VERSION + 1, links: { x: { anything: true } }, more: [1, 2] };
    fs.writeFileSync(file, JSON.stringify(v3(newer)));
    const store = open();
    noBook(store.wires());
    expect(store.wires().refused).toMatch(/newer Mockingbird \(wire format 2\)/);
    expect(refusedBy(store.editWires(withWire))).toMatch(/newer Mockingbird/);
    expect(store.get().problems).toEqual([]);
    store.update({ workspaces: { b: placement(900) } });
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS);
    expect(onDisk(file)).toMatchObject({ workspaces: { b: placement(900) }, wires: newer });
  });

  it("keeps a book that isn't one whole through layout saves, and refuses it, leaving the layout alone", () => {
    vi.useFakeTimers();
    const { file, open } = setup();
    fs.writeFileSync(file, JSON.stringify(v3("not a book")));
    const store = open();
    expect(store.get().landscape.workspaces.a).toEqual(placement(8));
    expect(store.get().problems).toEqual([]);
    noBook(store.wires());
    expect(store.wires().refused).toMatch(/can't be read by this Mockingbird/);
    store.update({ workspaces: { b: placement(900) } });
    vi.advanceTimersByTime(LANDSCAPE_SAVE_MS);
    expect(onDisk(file).wires).toBe("not a book");
  });

  it("says when a file of this version has no book at all, and carries on with an empty one", () => {
    const { file, open } = setup();
    const { wires: _w, ...none } = v3(null) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify(none));
    const state = open().wires();
    expect(state.book).toMatchObject({ links: {} });
    expect(state.problems).toEqual([expect.objectContaining({ kind: "missing" })]);
  });

  it.each(["a wire's", "the layout's"])("stops saying the book was missing once %s save has written one", (by) => {
    vi.useFakeTimers();
    const { file, open, wireChanges } = setup();
    const { wires: _w, ...none } = v3(null) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify(none));
    const store = open();
    expect(store.wires().problems).toEqual([expect.objectContaining({ kind: "missing" })]);
    const rev = store.wires().wiresRev;
    if (by === "a wire's") added(store.editWires(withWire));
    else {
      store.update({ workspaces: { b: placement(900) } });
      vi.advanceTimersByTime(LANDSCAPE_SAVE_MS);
    }
    expect(onDisk(file).wires).toMatchObject({ wv: WIRE_VERSION });
    expect(store.wires().problems).toEqual([]);
    expect(store.wires().wiresRev).toBe(rev + 1);
    expect(wireChanges.at(-1)).toMatchObject({ problems: [] });
    expect(open().wires().problems).toEqual([]);
  });

  it("saves a live entry over a kept one under the same key, says so, and reads it back after a restart", () => {
    const { file, open, logged } = setup();
    const bad = { from: "a", to: "b", type: "sees" };
    fs.writeFileSync(file, JSON.stringify(v3({ wv: 1, links: { w1: bad, other: bad }, notes: { a: "not a note" } })));
    const store = open();
    expect(store.wires().problems.map((p) => p.id).sort()).toEqual(["a", "other", "w1"]);
    added(store.editWires((book) => ({ book: { ...book, links: { ...book.links, w1: WIRE }, notes: { a: { hops: 1 } } } })));
    expect(onDisk(file).wires).toMatchObject({ links: { w1: WIRE, other: bad }, notes: { a: { hops: 1 } } });
    expect(store.wires().problems.map((p) => p.id)).toEqual(["other"]);
    expect(logged).toEqual(
      expect.arrayContaining([
        `landscape: A wire in landscape.json that couldn't be read ("w1") was replaced by a new one under the same key, which is what's saved now.`,
        `landscape: A wire note in landscape.json that couldn't be read ("a") was replaced by a new one under the same key, which is what's saved now.`,
      ])
    );
    const again = open().wires();
    expect(again.book!.links.w1).toEqual(WIRE);
    expect(again.book!.notes.a).toEqual({ hops: 1 });
    expect(again.problems.map((p) => p.id)).toEqual(["other"]);
  });

  it.skipIf(asRoot)("refuses while the file can't be read, never answering no wires, and comes back when it can", () => {
    const { file, open, wireChanges } = setup();
    fs.writeFileSync(file, JSON.stringify(v3({ wv: 1, links: { w1: WIRE }, notes: {} })));
    fs.chmodSync(file, 0o000);
    const store = open();
    try {
      noBook(store.wires());
      expect(store.wires().refused).toMatch(/can't be read or changed right now.*EACCES/);
      expect(refusedBy(store.editWires(withWire))).toMatch(/EACCES/);
      expect(store.wiresWriteRefusal()).toMatch(/EACCES/);
      store.flush();
      expect(wireChanges).toEqual([]);
    } finally {
      fs.chmodSync(file, 0o644);
    }
    // the next call reads it again: the book's back, and windows hear of it
    const back = store.wires();
    expect(back.refused).toBeNull();
    expect(back.book!.links.w1).toEqual(WIRE);
    expect(wireChanges.at(-1)).toMatchObject({ refused: null, book: { links: { w1: WIRE } } });
    expect(onDisk(file).wires.links.w1).toEqual(WIRE);
  });

  it("refuses a file a newer Mockingbird wrote, as it does a book", () => {
    const { file, open } = setup();
    const newer = JSON.stringify({ v: LANDSCAPE_VERSION + 1, wires: { wv: 1, links: { w1: WIRE }, notes: {} } });
    fs.writeFileSync(file, newer);
    const store = open();
    noBook(store.wires());
    expect(store.wires().refused).toContain(`newer Mockingbird (landscape version ${LANDSCAPE_VERSION + 1})`);
    expect(refusedBy(store.editWires(withWire))).toMatch(/newer Mockingbird/);
    store.flush();
    expect(fs.readFileSync(file, "utf8")).toBe(newer);
  });

  it.skipIf(asRoot)("refuses a file that's corrupt and can't be moved aside, which nothing may write", () => {
    const { dir, file, open } = setup();
    fs.writeFileSync(file, "not json");
    fs.chmodSync(dir, 0o555);
    try {
      const store = open();
      noBook(store.wires());
      expect(refusedBy(store.editWires(withWire))).toMatch(/couldn't be moved aside/);
      expect(store.wires().refused).toMatch(/couldn't be moved aside/);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    expect(fs.readFileSync(file, "utf8")).toBe("not json");
  });

  it("says the wires went aside with a corrupt file, so an empty book isn't read as none ever being there", () => {
    const { file, open } = setup();
    fs.writeFileSync(file, "not json");
    const store = open();
    const state = store.wires();
    expect(store.get().problems[0].message).toMatch(/moved to .* the layout and its wires start over/);
    expect(state.book).toMatchObject({ links: {} });
    expect(state.problems).toEqual([expect.objectContaining({ kind: "aside", message: expect.stringMatching(/layout and its wires start over/) })]);
    // and it starts over: a wire can be made
    added(store.editWires(withWire));
    expect(onDisk(file).wires.links.w1).toEqual(WIRE);
  });

  it.skipIf(asRoot)("refuses a change to a read-only file but still reads it, and says why", () => {
    const { store, file, wireChanges } = setup();
    added(store.editWires(withWire));
    const sent = wireChanges.length;
    fs.chmodSync(file, 0o444);
    try {
      expect(store.wires().book!.links.w1).toEqual(WIRE);
      expect(store.wiresWriteRefusal()).toMatch(/read-only/);
      expect(refusedBy(store.editWires((b) => ({ book: { ...b, links: {} } })))).toMatch(/read-only/);
      expect(store.wires().book!.links.w1).toEqual(WIRE);
      expect(onDisk(file).wires.links.w1).toEqual(WIRE);
      expect(wireChanges.length).toBe(sent);
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });

  it.skipIf(asRoot)("leaves the book as it was, and says so, when a change can't be written", () => {
    const { dir, store, file, wireChanges, changes } = setup();
    added(store.editWires(withWire));
    const sentWires = wireChanges.length;
    const sent = changes.length;
    fs.chmodSync(dir, 0o555);
    try {
      expect(refusedBy(store.editWires((b) => ({ book: { ...b, links: {} } })))).toMatch(/couldn't be saved .* so nothing changed/);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    expect(store.wires().book!.links.w1).toEqual(WIRE);
    expect(onDisk(file).wires.links.w1).toEqual(WIRE);
    expect(wireChanges.length).toBe(sentWires);
    expect(store.wires().wiresRev).toBe(1);
    // it's the wire's refusal: no layout was waiting, so the layout has no problem to report
    expect(store.get().problems).toEqual([]);
    expect(changes.length).toBe(sent);
  });

  it("carries on when a window can't be told of a wire change: it's made and saved, and the failure logged", () => {
    const dir = tempDir("landscape");
    const file = path.join(dir, "landscape.json");
    const logged: string[] = [];
    const store = new LandscapeStore({
      file,
      emit: () => {},
      emitWires: () => {
        throw new Error("no window");
      },
      log: (context, err) => logged.push(`${context}: ${(err as Error).message}`),
    });
    added(store.editWires(withWire));
    expect(onDisk(file).wires.links.w1).toEqual(WIRE);
    expect(logged.join()).toMatch(/couldn't send wire revision 1.*no window/);
  });
});
