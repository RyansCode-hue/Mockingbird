import { spawnSync } from "child_process";
import { buildSync } from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { LandscapeStore } from "../src/main/landscape";
import {
  ADDITIONS_FILE,
  LANDSCAPE_VERSION,
  TOOL_KINDS,
  WRITTEN_TOOL_KINDS,
  isWorkspaceTool,
  sameLandscape,
  type Area,
  type ArtifactCard,
  type Ghost,
  type Landscape,
  type LandscapePatch,
  type ToolWindow,
} from "../src/shared/landscape";
import { newWire, type WireBook } from "../src/shared/wires";
import { LANDSCAPE_VERSION as LANDSCAPE_VERSION_183, TOOL_KINDS as TOOL_KINDS_183, parseLandscape as parseLandscape183 } from "./fixtures/landscape-1.8.3/landscape";
import { LandscapeStore as LandscapeStore183 } from "./fixtures/landscape-1.8.3/store";
import { tempDir } from "./helpers";

/**
 * landscape.json between this version and 1.8.3 (test/fixtures/landscape-1.8.3, its parser and store frozen): this
 * version writes the file in the format 1.8.3 reads, and what that format can't hold beside it in
 * landscape-additions.json, which 1.8.3 never touches; what 1.8.3 changes in landscape.json meanwhile is read back
 * with the additions checked against it.
 */

const rect = (x: number, y: number, w = 400, h = 300) => ({ x, y, w, h });
// a folder's permissions don't stop root, so the tests that rely on them can't run as root
const asRoot = process.getuid?.() === 0;

function setup(name = "compat") {
  const dir = tempDir(name);
  const file = path.join(dir, "landscape.json");
  const additions = path.join(dir, ADDITIONS_FILE);
  const logged: string[] = [];
  const log = (context: string, err: unknown) => logged.push(`${context}: ${err instanceof Error ? err.message : String(err)}`);
  const open = (sessionKnown?: (id: string) => boolean) => new LandscapeStore({ file, emit() {}, log, ...(sessionKnown ? { sessionKnown } : {}) });
  const open183 = () => new LandscapeStore183({ file, emit() {}, log });
  return { dir, file, additions, logged, open, open183 };
}
const onDisk = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const withWire = (book: WireBook) => ({ book: { ...book, links: { ...book.links, w1: newWire("s1", "s2", "handoff", 1) } } });

/** What 1.8.3's model holds of `l`: no colours, no Pipeline windows. */
function as183(l: Landscape) {
  const areas = Object.fromEntries(Object.entries(l.areas).map(([k, { accent: _a, ...a }]) => [k, a]));
  const tools = Object.fromEntries(Object.entries(l.tools).filter(([, w]) => WRITTEN_TOOL_KINDS.includes(w.tool)));
  return { ...l, v: 3, areas, tools };
}

// Every field each part of the model has: Required<> makes a field added to the model a type error here until it's
// given a sample, so the file written below always holds every feature there is.
const AREA_A: Required<Area> = { ...rect(0, 0, 4000, 2000), repos: [{ path: "/r", base: "main" }], collapsed: false, locked: true, autoCreate: true, accent: 7 };
const AREA_B: Required<Area> = { ...rect(5000, 0, 3000, 2000), repos: [], collapsed: true, locked: false, autoCreate: false, accent: 0 };
const GHOST: Required<Ghost> = {
  title: "Old",
  agent: "codex",
  cwd: "/r",
  repoPath: "/r",
  branch: "b",
  ticketId: "123",
  conversation: { agent: "codex", id: "c1" },
  summary: "did things",
  worktreeRemoved: true,
  placement: rect(1000, 1000),
  group: "A",
  closedAt: "2026-11-01T00:00:00.000Z",
};
const CARDS: Record<string, Required<ArtifactCard>> = {
  c1: { area: "A", shelf: "area:A", artifact: "notes", placement: rect(3000, 1500, 240, 128) },
  c2: { area: "B", shelf: "Aaaaaaaaaaaaaaaaaaaaaa", artifact: "spec", placement: rect(5100, 100, 240, 128) },
};

/** A window of every kind, docked and placed (an area's in A, a Pipeline window naming its member), in dock order. */
function everyWindow(): Record<string, ToolWindow> {
  const tools: Record<string, ToolWindow> = {};
  TOOL_KINDS.forEach((tool, i) => {
    tools[`d-${tool}`] = { tool, docked: true };
    const placed: Required<ToolWindow> = { tool, docked: false, session: "s1", area: "A", placement: rect(100 + 450 * i, 600) };
    if (!isWorkspaceTool(tool) && tool !== "pipeline") delete (placed as Partial<ToolWindow>).session;
    tools[`p-${tool}`] = placed;
  });
  // one after the last kind's, so every docked Pipeline window has a window of landscape.json's after it
  tools["d-last"] = { tool: "files", docked: true };
  return tools;
}

/** Every feature on the landscape at once: each record's fields, every tool kind, both kinds of shelf. */
function everything(): Required<Omit<LandscapePatch, "areas">> & { areas: Record<string, Area> } {
  return {
    migratedAt: "2026-11-03T00:00:00.000Z",
    tourDone: true,
    workspaces: { s1: rect(100, 100), s2: rect(600, 100) },
    areas: { A: AREA_A, B: AREA_B },
    stacks: { "A/api": { active: "s3", placement: rect(1100, 100) } },
    ghosts: { s4: GHOST },
    tools: everyWindow(),
    cards: CARDS,
  };
}

/** A store of this version that saved everything, a wire included, to `file`. */
function savedEverything(o: ReturnType<typeof setup>): Landscape {
  const store = o.open();
  store.update(everything());
  const r = store.editWires(withWire);
  if ("refused" in r) throw new Error(r.refused);
  store.flush();
  return store.get().landscape;
}

describe("a landscape.json this version saved, opened by 1.8.3", () => {
  it("holds what 1.8.3's format does: the tool kinds it knows, and the version it writes", () => {
    expect(WRITTEN_TOOL_KINDS).toEqual(TOOL_KINDS_183);
    expect(LANDSCAPE_VERSION_183).toBe(3);
  });

  it("opens as 1.8.3's own with every feature of this version in use: not read-only, nothing set aside, every place as saved", () => {
    const o = setup();
    const l = savedEverything(o);
    // what's tested is everything: every colour and kind of window is in the model
    expect(Object.values(l.areas).every((a) => a.accent !== undefined)).toBe(true);
    expect(new Set(Object.values(l.tools).map((w) => w.tool))).toEqual(new Set(TOOL_KINDS));

    const text = fs.readFileSync(o.file, "utf8");
    expect(() => parseLandscape183(JSON.parse(text))).not.toThrow();
    const old = o.open183();
    const got = old.get();
    expect(got.problems).toEqual([]);
    expect(got.landscape).toEqual(as183(l));
    expect(Object.keys(got.landscape.tools)).toEqual(Object.keys(as183(l).tools));
    expect(old.wires()).toMatchObject({ refused: null, problems: [], book: { links: { w1: { from: "s1", to: "s2", type: "handoff" } } } });
    expect(o.logged).toEqual([]);
    expect(fs.readFileSync(o.file, "utf8")).toBe(text); // opening it changed nothing
  });

  it("is changed and saved by 1.8.3, and read back here with its change and what 1.8.3 couldn't hold, in place and in order", () => {
    const o = setup();
    const l = savedEverything(o);
    const additions = fs.readFileSync(o.additions, "utf8");
    const old = o.open183();
    old.update({ workspaces: { s1: rect(200, 120) }, areas: { A: { collapsed: true } } });
    old.flush();
    expect(onDisk(o.file).v).toBe(3);
    expect(fs.readFileSync(o.additions, "utf8")).toBe(additions); // 1.8.3 never touches it

    const back = o.open().get();
    expect(back.problems).toEqual([]);
    expect(back.landscape).toEqual({ ...l, workspaces: { ...l.workspaces, s1: rect(200, 120) }, areas: { ...l.areas, A: { ...l.areas.A, collapsed: true } } });
    expect(Object.keys(back.landscape.tools)).toEqual(Object.keys(l.tools));
    expect(o.logged).toEqual([]);
  });
});

describe("a round trip in this version", () => {
  it("reads back exactly what it saved, the dock's order included", () => {
    const o = setup();
    const l = savedEverything(o);
    const again = o.open();
    expect(again.get().landscape).toEqual(l);
    expect(sameLandscape(again.get().landscape, l)).toBe(true);
    expect(Object.keys(again.get().landscape.tools)).toEqual(Object.keys(l.tools));
    expect(again.wires().book!.links.w1).toMatchObject({ from: "s1", to: "s2" });
    expect(o.logged).toEqual([]);
  });

  it("writes landscape.json without colours or Pipeline windows, and those beside it, keyed by area and window", () => {
    const o = setup();
    savedEverything(o);
    const file = onDisk(o.file);
    expect(file.v).toBe(3);
    expect(Object.values(file.areas).some((a) => Object.hasOwn(a as object, "accent"))).toBe(false);
    expect(Object.values(file.tools).some((w) => (w as ToolWindow).tool === "pipeline")).toBe(false);
    expect(onDisk(o.additions)).toEqual({
      v: 1,
      areas: { A: { accent: 7 }, B: { accent: 0 } },
      tools: {
        "d-pipeline": { window: { tool: "pipeline", docked: true }, before: "d-last" },
        "p-pipeline": { window: { tool: "pipeline", docked: false, session: "s1", area: "A", placement: rect(100 + 450 * 6, 600) }, areaAt: rect(0, 0, 4000, 2000), before: "d-last" },
      },
    });
  });

  it("writes landscape-additions.json atomically, and only when what it holds changes", () => {
    const o = setup();
    const store = o.open();
    store.update({ areas: { A: { ...AREA_A, accent: 1 } } });
    store.flush();
    const first = fs.statSync(o.additions).ino;
    store.update({ workspaces: { s1: rect(100, 100) } });
    store.flush();
    expect(fs.statSync(o.additions).ino).toBe(first);
    store.update({ areas: { A: { accent: 2 } } });
    store.flush();
    // a new file renamed over the old, never one rewritten in place
    expect(fs.statSync(o.additions).ino).not.toBe(first);
    expect(fs.readdirSync(o.dir).sort()).toEqual([ADDITIONS_FILE, "landscape.json"]);
  });
});

describe("a version 4 landscape.json, as 1.9.0's first build wrote it", () => {
  const v4 = () => ({
    v: 4,
    workspaces: { s1: rect(100, 100) },
    areas: { A: { ...rect(0, 0, 4000, 2000), repos: [], accent: 3 } },
    stacks: {},
    ghosts: {},
    tools: { d1: { tool: "files", docked: true }, dp: { tool: "pipeline", docked: true }, pw: { tool: "pipeline", docked: false, session: "s1", area: "A", placement: rect(500, 500) }, d2: { tool: "run", docked: true } },
    cards: {},
    wires: { wv: 1, links: {}, notes: {} },
  });

  it("is read as it is, and moves its colours and Pipeline windows beside it at the next save, which 1.8.3 then opens", () => {
    const o = setup();
    fs.writeFileSync(o.file, JSON.stringify(v4()));
    const store = o.open();
    const l = store.get().landscape;
    expect(store.get().problems).toEqual([]);
    expect(l.areas.A.accent).toBe(3);
    expect(Object.keys(l.tools)).toEqual(["d1", "dp", "pw", "d2"]);
    expect(onDisk(o.file).v).toBe(4); // reading writes nothing
    expect(fs.existsSync(o.additions)).toBe(false);

    store.update({ tourDone: true });
    store.flush();
    expect(onDisk(o.file)).toMatchObject({ v: 3, areas: { A: { ...rect(0, 0, 4000, 2000), repos: [] } }, tools: { d1: { tool: "files", docked: true }, d2: { tool: "run", docked: true } } });
    expect(onDisk(o.file).areas.A.accent).toBeUndefined();
    expect(onDisk(o.additions)).toMatchObject({ areas: { A: { accent: 3 } }, tools: { dp: { before: "d2" }, pw: { before: "d2", areaAt: rect(0, 0, 4000, 2000) } } });
    expect(o.open183().get().problems).toEqual([]);
    const again = o.open().get().landscape;
    expect(again).toEqual({ ...l, tourDone: true });
    expect(Object.keys(again.tools)).toEqual(["d1", "dp", "pw", "d2"]);
    expect(o.logged).toEqual([]);
  });

  it("is left read-only by 1.8.3, as before: it's this version's next save that opens it to 1.8.3", () => {
    const o = setup();
    fs.writeFileSync(o.file, JSON.stringify(v4()));
    expect(o.open183().get().problems).toEqual([expect.objectContaining({ kind: "newer", readOnly: true })]);
  });
});

describe("what 1.8.3 changed in landscape.json since the additions were saved", () => {
  /** Areas A, B and C, each coloured, each with a Pipeline window; docked windows with a Pipeline window between. */
  function seeded(o: ReturnType<typeof setup>) {
    const store = o.open();
    const pipe = (area: string, at: number, session?: string): ToolWindow => ({ tool: "pipeline", docked: false, ...(session ? { session } : {}), area, placement: rect(at + 100, 100) });
    store.update({
      areas: { A: { ...rect(0, 0, 2000, 1000), repos: [], accent: 1 }, B: { ...rect(3000, 0, 2000, 1000), repos: [], accent: 2 }, C: { ...rect(6000, 0, 2000, 1000), repos: [], accent: 3 } },
      tools: { d1: { tool: "files", docked: true }, dp: { tool: "pipeline", docked: true }, d2: { tool: "changes", docked: true }, pA: pipe("A", 0, "s1"), pB: pipe("B", 3000), pC: pipe("C", 6000) },
    });
    store.flush();
    o.logged.length = 0;
    return store.get().landscape;
  }

  it("drops a colour and a window whose area 1.8.3 renamed, and says so", () => {
    const o = setup();
    seeded(o);
    const old = o.open183();
    old.groupRenamed("A", "A2", []);
    old.flush();
    expect(Object.keys(onDisk(o.file).areas)).toEqual(["B", "C", "A2"]);
    const l = o.open().get().landscape;
    expect(l.areas.A2.accent).toBeUndefined();
    expect(l.tools.pA).toBeUndefined();
    expect(l.areas.B.accent).toBe(2);
    expect(o.logged).toEqual([
      `landscape: ${ADDITIONS_FILE}: the colour of area "A" is dropped: landscape.json has no area "A" now (it was renamed or removed since)`,
      `landscape: ${ADDITIONS_FILE}: the Pipeline window "pA" is dropped: landscape.json has no area "A" now (it was renamed or removed since)`,
    ]);
  });

  it("drops a colour and a window whose area 1.8.3 removed, and leaves the rest as saved", () => {
    const o = setup();
    const before = seeded(o);
    const old = o.open183();
    old.update({ areas: { C: null } });
    old.flush();
    const l = o.open().get().landscape;
    const { C: _c, ...areas } = before.areas;
    const { pC: _p, ...tools } = before.tools;
    expect(l).toEqual({ ...before, areas, tools });
    expect(o.logged).toHaveLength(2);
    expect(o.logged.join("\n")).toMatch(/colour of area "C" is dropped/);
    expect(o.logged.join("\n")).toMatch(/Pipeline window "pC" is dropped/);
  });

  it("moves a window with its area when 1.8.3 moved the area, and places it anew when the area shrank past it", () => {
    const o = setup();
    const before = seeded(o);
    const old = o.open183();
    old.update({ areas: { B: { x: 3600, y: 400 }, C: { w: 50 } } });
    old.flush();
    const l = o.open().get().landscape;
    expect(l.tools.pB).toEqual({ ...before.tools.pB, placement: rect(3700, 500) });
    const { placement: _gone, ...placedAnew } = before.tools.pC;
    expect(l.tools.pC).toEqual(placedAnew);
    expect(l.tools.pA).toEqual(before.tools.pA);
    expect(o.logged).toEqual([`landscape: ${ADDITIONS_FILE}: the Pipeline window "pC" is placed anew in area "C": the area changed since, and its place doesn't fit in it now`]);
  });

  it("drops a window whose id 1.8.3 gave a window of its own, which is kept", () => {
    const o = setup();
    seeded(o);
    const old = o.open183();
    old.update({ tools: { pB: { tool: "search", docked: true } } });
    old.flush();
    const l = o.open().get().landscape;
    expect(l.tools.pB).toEqual({ tool: "search", docked: true });
    expect(o.logged).toEqual([`landscape: ${ADDITIONS_FILE}: the Pipeline window "pB" is dropped: landscape.json has a window or card under its id now`]);
  });

  it("lets a Pipeline window's member go when that session is gone, keeping the window", () => {
    const o = setup();
    const before = seeded(o);
    const l = o.open((id) => id !== "s1").get().landscape;
    const { session: _s, ...rest } = before.tools.pA;
    expect(l.tools.pA).toEqual(rest);
    expect(o.logged).toEqual([`landscape: ${ADDITIONS_FILE}: the Pipeline window "pA" lets go of session "s1", which is gone: it shows another of its area's pipelines`]);
    // a session still known keeps its place as the window's member
    o.logged.length = 0;
    expect(o.open(() => true).get().landscape.tools.pA).toEqual(before.tools.pA);
    expect(o.logged).toEqual([]);
  });

  it("puts a docked window back in the dock's order among 1.8.3's, and after them all when the one it preceded is gone", () => {
    const o = setup();
    seeded(o);
    const old = o.open183();
    old.update({ tools: { d3: { tool: "search", docked: true } } });
    old.flush();
    expect(Object.keys(o.open().get().landscape.tools).filter((k) => k.startsWith("d"))).toEqual(["d1", "dp", "d2", "d3"]);
    old.update({ tools: { d2: null } });
    old.flush();
    expect(Object.keys(o.open().get().landscape.tools).filter((k) => k.startsWith("d"))).toEqual(["d1", "d3", "dp"]);
    expect(o.logged).toEqual([]);
  });
});

describe("a crash between the two writes", () => {
  it("is never between landscape.json and nothing: the additions are written first, so a version 4 file's colours survive it", () => {
    const o = setup();
    fs.writeFileSync(
      o.file,
      JSON.stringify({ v: 4, workspaces: {}, areas: { A: { ...rect(0, 0, 2000, 1000), repos: [], accent: 5 } }, stacks: {}, ghosts: {}, tools: { pw: { tool: "pipeline", docked: false, area: "A", placement: rect(100, 100) } }, cards: {}, wires: { wv: 1, links: {}, notes: {} } })
    );
    const v4 = fs.readFileSync(o.file, "utf8");

    // a copy of the app, as a plain node process, killed as it renames its new landscape.json into place
    const bundle = path.join(o.dir, "landscape.cjs");
    buildSync({ entryPoints: [fileURLToPath(new URL("../src/main/landscape.ts", import.meta.url))], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent" });
    const script = path.join(o.dir, "crash.cjs");
    fs.writeFileSync(
      script,
      `const fs = require("fs");
const path = require("path");
const { LandscapeStore } = require(${JSON.stringify(bundle)});
const store = new LandscapeStore({ file: ${JSON.stringify(o.file)}, emit() {}, log(context, err) { console.error(context, err); } });
store.update({ tourDone: true });
const rename = fs.renameSync;
const order = [];
fs.renameSync = (from, to) => {
  order.push(path.basename(to));
  if (path.basename(to) === "landscape.json") {
    console.error(order.join(" "));
    process.kill(process.pid, "SIGKILL");
  }
  return rename(from, to);
};
store.flush();
console.error("the write wasn't interrupted");
process.exit(3);
`
    );
    const run = spawnSync(process.execPath, [script], { cwd: o.dir, encoding: "utf8" });
    expect(run.signal, run.stderr).toBe("SIGKILL");
    expect(run.stderr.trim()).toBe(`${ADDITIONS_FILE} landscape.json`);
    for (const leftover of fs.readdirSync(o.dir).filter((f) => f.endsWith(".tmp"))) fs.rmSync(path.join(o.dir, leftover));

    // landscape.json is the version 4 file still, and the colour and window are beside it already
    expect(fs.readFileSync(o.file, "utf8")).toBe(v4);
    expect(onDisk(o.additions)).toMatchObject({ areas: { A: { accent: 5 } }, tools: { pw: { window: { tool: "pipeline" } } } });
    const next = o.open();
    expect(next.get().problems).toEqual([]);
    expect(next.get().landscape.areas.A.accent).toBe(5);
    expect(next.get().landscape.tools.pw).toEqual({ tool: "pipeline", docked: false, area: "A", placement: rect(100, 100) });
    expect(o.logged).toEqual([]);
    // and the next save finishes what the crash cut short
    next.update({ tourDone: true });
    next.flush();
    expect(onDisk(o.file).v).toBe(3);
    expect(o.open183().get().problems).toEqual([]);
    expect(o.open().get().landscape.areas.A.accent).toBe(5);
  });

  it("reads the additions written and landscape.json not: what the additions name that landscape.json lacks is dropped, said", () => {
    const o = setup();
    const store = o.open();
    store.update({ areas: { A: { ...rect(0, 0, 2000, 1000), repos: [], accent: 1 } }, tools: { pA: { tool: "pipeline", docked: false, area: "A", placement: rect(100, 100) }, gone: { tool: "pipeline", docked: true } } });
    store.flush();
    const saved = fs.readFileSync(o.file, "utf8");
    // the next save: a new area with its colour and window, and a window closed; only the additions reach the disk
    store.update({ areas: { N: { ...rect(3000, 0, 2000, 1000), repos: [], accent: 4 } }, tools: { pN: { tool: "pipeline", docked: false, area: "N", placement: rect(3100, 100) }, gone: null } });
    store.flush();
    fs.writeFileSync(o.file, saved);

    const l = o.open().get();
    expect(l.problems).toEqual([]);
    expect(l.landscape.areas).toEqual({ A: { ...rect(0, 0, 2000, 1000), repos: [], accent: 1 } });
    expect(Object.keys(l.landscape.tools)).toEqual(["pA"]);
    expect(o.logged.join("\n")).toMatch(/the colour of area "N" is dropped/);
    expect(o.logged.join("\n")).toMatch(/the Pipeline window "pN" is dropped/);
    expect(o.logged).toHaveLength(2);
  });

  it("reads landscape.json written and the additions not, as it reads one 1.8.3 changed alone", () => {
    const o = setup();
    const store = o.open();
    store.update({ areas: { A: { ...rect(0, 0, 2000, 1000), repos: [], accent: 1 }, B: { ...rect(3000, 0, 2000, 1000), repos: [], accent: 2 } }, tools: { pB: { tool: "pipeline", docked: false, area: "B", placement: rect(3100, 100) } } });
    store.flush();
    const additions = fs.readFileSync(o.additions, "utf8");
    store.update({ areas: { B: null, A: { accent: 6 } }, tools: { pB: null } });
    store.flush();
    fs.writeFileSync(o.additions, additions);

    const l = o.open().get();
    expect(l.problems).toEqual([]);
    // A's colour is the one saved before (the newer one was lost with the crash); B's colour and window went with B
    expect(l.landscape.areas).toEqual({ A: { ...rect(0, 0, 2000, 1000), repos: [], accent: 1 } });
    expect(l.landscape.tools).toEqual({});
    expect(o.logged).toHaveLength(2);
  });
});

describe("a landscape-additions.json that can't be used", () => {
  const saved = (o: ReturnType<typeof setup>) => {
    const store = o.open();
    store.update({ workspaces: { s1: rect(100, 100) }, areas: { A: { ...rect(0, 0, 2000, 1000), repos: [], accent: 1 } } });
    store.flush();
    o.logged.length = 0;
  };

  it("is moved aside when it isn't JSON, said in the log and for a banner, and the layout is read without it", () => {
    const o = setup();
    saved(o);
    fs.writeFileSync(o.additions, "not json");
    const store = o.open();
    const { landscape, problems } = store.get();
    expect(landscape.workspaces.s1).toEqual(rect(100, 100));
    expect(landscape.areas.A.accent).toBeUndefined();
    expect(problems).toEqual([expect.objectContaining({ kind: "additions", file: o.additions, movedTo: expect.stringContaining(`${o.additions}.bad-`) })]);
    expect(problems[0].message).toMatch(/isn't valid JSON/);
    expect(o.logged).toEqual([expect.stringContaining(`${o.additions} isn't valid JSON`)]);
    expect(fs.readFileSync(problems[0].movedTo!, "utf8")).toBe("not json");
    // they start over: the next colour chosen is saved in a new file
    store.update({ areas: { A: { accent: 8 } } });
    store.flush();
    expect(onDisk(o.additions).areas.A).toEqual({ accent: 8 });
  });

  it("is moved aside when it's JSON but not additions, naming what's wrong", () => {
    for (const bad of [{ v: 1, areas: {}, tools: {}, extra: 1 }, { v: 1, areas: { A: { accent: 1, colour: "red" } }, tools: {} }, { v: 1, areas: {}, tools: { w: { window: { tool: "files", docked: true } } } }, [], null]) {
      const o = setup();
      saved(o);
      fs.writeFileSync(o.additions, JSON.stringify(bad));
      const [p] = o.open().get().problems;
      expect(p, JSON.stringify(bad)).toMatchObject({ kind: "additions", movedTo: expect.any(String) });
      expect(p.message, JSON.stringify(bad)).toMatch(/isn't landscape additions \(/);
    }
  });

  it("drops a colour that isn't one, saying so, and reads the rest", () => {
    const o = setup();
    saved(o);
    fs.writeFileSync(o.additions, JSON.stringify({ v: 1, areas: { A: { accent: 99 } }, tools: { p: { window: { tool: "pipeline", docked: true } } } }));
    const { landscape, problems } = o.open().get();
    expect(problems).toEqual([]);
    expect(landscape.areas.A.accent).toBeUndefined();
    expect(landscape.tools.p).toEqual({ tool: "pipeline", docked: true });
    expect(o.logged).toEqual([`landscape: ${ADDITIONS_FILE}'s areas["A"].accent is not a whole number from 0 to 9 (99): it's dropped, and the area takes its automatic colour`]);
  });

  it("is left as it is when a newer Mockingbird wrote it: not read, never written over, and the layout still saved", () => {
    const o = setup();
    saved(o);
    const newer = JSON.stringify({ v: 2, areas: { A: { accent: 1, pattern: "dots" } }, tools: {} });
    fs.writeFileSync(o.additions, newer);
    const store = o.open();
    expect(store.get().problems).toEqual([expect.objectContaining({ kind: "additions", file: o.additions })]);
    expect(store.get().problems[0].message).toMatch(/newer Mockingbird \(additions version 2\)/);
    expect(store.get().landscape.areas.A.accent).toBeUndefined();
    store.update({ workspaces: { s1: rect(200, 100) }, areas: { A: { accent: 3 } } });
    store.flush();
    expect(fs.readFileSync(o.additions, "utf8")).toBe(newer);
    expect(onDisk(o.file).workspaces.s1).toEqual(rect(200, 100));
  });

  it("is left as it is when it can't be read, and not written this run", () => {
    const o = setup();
    saved(o);
    fs.rmSync(o.additions);
    fs.mkdirSync(o.additions);
    const store = o.open();
    expect(store.get().problems).toEqual([expect.objectContaining({ kind: "additions", message: expect.stringMatching(/couldn't be read/) })]);
    store.update({ areas: { A: { accent: 3 } } });
    store.flush();
    expect(fs.statSync(o.additions).isDirectory()).toBe(true);
    expect(o.logged).toEqual([expect.stringContaining(`${o.additions} couldn't be read`)]);
  });

  it.skipIf(asRoot)("is left as it is when it isn't additions and can't be moved aside, and not written this run", () => {
    const o = setup();
    saved(o);
    fs.writeFileSync(o.additions, "not json");
    fs.chmodSync(o.dir, 0o555);
    try {
      const store = o.open();
      expect(store.get().problems).toEqual([expect.objectContaining({ kind: "additions", message: expect.stringMatching(/couldn't be moved aside/) })]);
      expect(store.get().problems[0].movedTo).toBeUndefined();
    } finally {
      fs.chmodSync(o.dir, 0o755);
    }
    expect(fs.readFileSync(o.additions, "utf8")).toBe("not json");
  });

  it("is a save problem when it can't be written, as landscape.json's is, and landscape.json is left as it was", () => {
    const o = setup();
    saved(o);
    const store = o.open();
    const tmp = `${fs.realpathSync(o.additions)}.${process.pid}.tmp`;
    fs.mkdirSync(tmp);
    store.update({ workspaces: { s1: rect(300, 100) }, areas: { A: { accent: 2 } } });
    expect(() => store.flush()).toThrow(new RegExp(`${ADDITIONS_FILE} couldn't be written`));
    expect(store.get().problems).toEqual([expect.objectContaining({ kind: "save", file: o.file })]);
    expect(store.get().problems[0].message).toContain(o.additions);
    expect(o.logged.at(-1)).toContain(`couldn't save ${o.file}`);
    expect(onDisk(o.file).workspaces.s1).toEqual(rect(100, 100));
    expect(onDisk(o.additions).areas.A).toEqual({ accent: 1 });
    fs.rmdirSync(tmp);
    store.flush();
    expect(store.get().problems).toEqual([]);
    expect(onDisk(o.file).workspaces.s1).toEqual(rect(300, 100));
    expect(onDisk(o.additions).areas.A).toEqual({ accent: 2 });
  });
});

describe("the in-memory model", () => {
  it("keeps this version's whole model, whatever file it came from", () => {
    expect(LANDSCAPE_VERSION).toBe(4);
    const o = setup();
    savedEverything(o);
    expect(o.open().get().landscape.v).toBe(LANDSCAPE_VERSION);
  });
});
