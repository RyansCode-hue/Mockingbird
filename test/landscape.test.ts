import { describe, expect, it } from "vitest";
import {
  AREA_GAP,
  AREA_HEADER,
  AREA_PAD,
  CELL_ESTIMATE,
  GAP,
  LandscapeShapeError,
  SIZE_PRESETS,
  WORKSPACE_SIZES,
  applyPatch,
  areaKeyOf,
  colsRows,
  emptyLandscape,
  fitAreaTo,
  fitView,
  overlaps,
  parseLandscape,
  parsePatch,
  placeNew,
  presetSize,
  sizeFor,
  snap,
  snapUp,
  stackKeyOf,
  type Area,
  type Ghost,
  type Landscape,
  type Rect,
} from "../src/shared/landscape";
import { cellKeyFor } from "../src/renderer/appModel";

const area = (over: Partial<Area> = {}): Area => ({ x: 0, y: 0, w: 2 * AREA_PAD + 2 * 400 + GAP, h: 600, repos: [], ...over });
const inside = (r: Rect, a: Rect) => r.x >= a.x + AREA_PAD && r.y >= a.y + AREA_HEADER && r.x + r.w <= a.x + a.w - AREA_PAD;
const noneOverlap = (rs: Rect[]) => rs.every((a, i) => rs.every((b, j) => i === j || !overlaps(a, b, GAP - 1e-6)));

describe("snap", () => {
  it("rounds to the 8 px grid, up with snapUp", () => {
    expect([0, 3, 4, 13, 1000.4, 1003.9, -3, -5].map((v) => snap(v))).toEqual([0, 0, 8, 16, 1000, 1000, 0, -8]);
    expect([0, 1, 8, 8.0000000001, 9, -1].map(snapUp)).toEqual([0, 8, 8, 8, 16, 0]);
  });

  it("never gives -0, which JSON and Object.is tell apart from 0", () => {
    expect(Object.is(snap(-3), 0)).toBe(true);
    expect(Object.is(snapUp(-1), 0)).toBe(true);
  });

  it("keeps NaN NaN, so a bad input shows instead of landing at 0", () => {
    expect(snap(NaN)).toBeNaN();
    expect(snapUp(NaN)).toBeNaN();
  });
});

describe("colsRows and sizeFor", () => {
  const cells = [CELL_ESTIMATE, { w: 6.6, h: 15 }, { w: 7.2, h: 17.25 }, { w: 8.4, h: 19 }, { w: 6.02, h: 13.5 }];

  it("round-trip: the size made for cols × rows holds exactly that, for every preset and cell", () => {
    for (const cell of cells)
      for (const kind of ["agent", "terminal"] as const)
        for (const p of SIZE_PRESETS) {
          const t = WORKSPACE_SIZES[kind][p];
          const s = sizeFor(t.cols, t.rows, cell.w, cell.h);
          expect(colsRows(s.w, s.h, cell.w, cell.h)).toEqual(t);
        }
  });

  it("round-trip the other way: the size for a workspace's cols × rows fits inside it, and one more of each wouldn't", () => {
    for (const cell of cells)
      for (const [w, h] of [[800, 600], [1066, 796], [333, 211], [1999, 1201]]) {
        const t = colsRows(w, h, cell.w, cell.h);
        const back = sizeFor(t.cols, t.rows, cell.w, cell.h);
        expect(back.w).toBeLessThanOrEqual(w);
        expect(back.h).toBeLessThanOrEqual(h);
        expect(sizeFor(t.cols + 1, t.rows + 1, cell.w, cell.h).w).toBeGreaterThan(w);
        expect(sizeFor(t.cols + 1, t.rows + 1, cell.w, cell.h).h).toBeGreaterThan(h);
      }
  });

  it("never sizes a terminal below one cell", () => {
    expect(colsRows(4, 4, 7.5, 18)).toEqual({ cols: 1, rows: 1 });
  });
});

describe("size presets", () => {
  it("are on the grid and hold exactly their cols × rows at the estimated cell", () => {
    for (const kind of ["agent", "terminal"] as const)
      for (const p of SIZE_PRESETS) {
        const s = presetSize(kind, p);
        expect([s.w % 8, s.h % 8]).toEqual([0, 0]);
        expect(colsRows(s.w, s.h, CELL_ESTIMATE.w, CELL_ESTIMATE.h)).toEqual(WORKSPACE_SIZES[kind][p]);
      }
  });

  it("hold at least their cols × rows at any cell", () => {
    for (const cell of [{ w: 6.02, h: 13.5 }, { w: 9.1, h: 21 }])
      for (const p of SIZE_PRESETS) {
        const s = presetSize("agent", p, cell);
        const t = colsRows(s.w, s.h, cell.w, cell.h);
        expect(t.cols).toBeGreaterThanOrEqual(WORKSPACE_SIZES.agent[p].cols);
        expect(t.rows).toBeGreaterThanOrEqual(WORKSPACE_SIZES.agent[p].rows);
      }
  });

  it("default to M: an agent of 140 × 42, about 1050 × 760 px", () => {
    expect(presetSize("agent")).toEqual(presetSize("agent", "M"));
    const m = presetSize("agent");
    expect(m.w).toBeGreaterThan(1050);
    expect(m.w).toBeLessThan(1100);
    expect(m.h).toBeGreaterThan(760);
    expect(m.h).toBeLessThan(820);
    expect(WORKSPACE_SIZES.terminal.M).toEqual({ cols: 120, rows: 24 });
  });
});

describe("placeNew", () => {
  const size = { w: 400, h: 304 };

  it("puts the first workspace in an empty area at its top-left, inside the padding and below the header", () => {
    expect(placeNew(size, [], area({ x: 64, y: 128 }))).toEqual({ x: 64 + AREA_PAD, y: 128 + AREA_HEADER, ...size });
  });

  it("fills an area in reading order: across first, then the next row", () => {
    const a = area();
    const placed: Rect[] = [];
    for (let i = 0; i < 4; i++) placed.push(placeNew(size, placed, a));
    expect(placed.map((p) => [p.x, p.y])).toEqual([
      [AREA_PAD, AREA_HEADER],
      [AREA_PAD + 400 + GAP, AREA_HEADER],
      [AREA_PAD, AREA_HEADER + 304 + GAP],
      [AREA_PAD + 400 + GAP, AREA_HEADER + 304 + GAP],
    ]);
  });

  it("takes the first free spot around what's already there, never overlapping it", () => {
    const a = area();
    const right = { x: AREA_PAD + 400 + GAP, y: AREA_HEADER, w: 400, h: 304 };
    expect(placeNew(size, [right], a)).toEqual({ x: AREA_PAD, y: AREA_HEADER, ...size });
    const corner = { x: AREA_PAD, y: AREA_HEADER, w: 200, h: 100 };
    const p = placeNew(size, [corner], a);
    expect(overlaps(p, corner, GAP - 1e-6)).toBe(false);
    expect(p.y).toBe(AREA_HEADER);
  });

  it("keeps the gap from rectangles off the grid, and stays on it", () => {
    const odd = { x: AREA_PAD + 3, y: AREA_HEADER + 5, w: 397, h: 301 };
    const p = placeNew(size, [odd], area());
    expect(overlaps(p, odd, GAP - 1e-6)).toBe(false);
    expect([p.x % 8, p.y % 8]).toEqual([0, 0]);
  });

  it("never overlaps anything, whatever is placed and in whatever sizes", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const a = area({ w: 1600 });
    const placed: Rect[] = [];
    for (let i = 0; i < 40; i++) {
      const p = placeNew({ w: 8 * Math.ceil(10 + rnd() * 80), h: 8 * Math.ceil(10 + rnd() * 50) }, placed, a);
      expect(inside(p, a)).toBe(true);
      placed.push(p);
    }
    expect(noneOverlap(placed)).toBe(true);
  });

  it("goes below everything when the area is full, for the caller to grow it", () => {
    const a = area({ h: AREA_HEADER + 304 + AREA_PAD });
    const placed = [placeNew(size, [], a)];
    placed.push(placeNew(size, placed, a));
    const third = placeNew(size, placed, a);
    expect(third).toEqual({ x: AREA_PAD, y: AREA_HEADER + 304 + GAP, ...size });
    expect(fitAreaTo(a, [...placed, third]).h).toBe(AREA_HEADER + 2 * 304 + GAP + AREA_PAD);
  });

  it("puts a workspace wider than the area at its left edge, below everything", () => {
    const a = area();
    const first = placeNew(size, [], a);
    const wide = placeNew({ w: 2000, h: 100 }, [first], a);
    expect(wide.x).toBe(AREA_PAD);
    expect(wide.y).toBeGreaterThanOrEqual(first.y + first.h + GAP);
  });

  it("stays clear of what's in the area from elsewhere: another area's workspace, a loose one", () => {
    const a = area({ x: 0, y: 0, w: 2000, h: 2000 });
    const visitor = { x: 0, y: 0, w: 900, h: 500 };
    const p = placeNew(size, [visitor], a);
    expect(overlaps(p, visitor, GAP - 1e-6)).toBe(false);
    expect(p.y).toBe(AREA_HEADER);
  });

  it("puts a loose workspace in a column just left of the first area, going down past what's there", () => {
    const a = area({ x: 0, y: 0 });
    const one = placeNew(size, [a], null, a);
    expect(one.x + one.w).toBeLessThanOrEqual(a.x - AREA_GAP);
    expect(one.y).toBe(0);
    const two = placeNew(size, [a, one], null, a);
    expect(two.x).toBe(one.x);
    expect(two.y).toBe(one.y + one.h + GAP);
  });

  it("puts a loose workspace at the origin when there's no area, and below the others", () => {
    const one = placeNew(size, [], null, null);
    expect(one).toEqual({ x: 0, y: 0, ...size });
    expect(placeNew(size, [one], null, null).y).toBe(304 + GAP);
  });
});

describe("fitAreaTo", () => {
  it("grows an area to hold its workspaces inside the padding, and never shrinks it", () => {
    const a = area({ h: 100 });
    const p = { x: AREA_PAD, y: AREA_HEADER, w: 400, h: 304 };
    const grown = fitAreaTo(a, [p]);
    expect(grown.h).toBe(AREA_HEADER + 304 + AREA_PAD);
    expect(grown.w).toBe(a.w);
    expect(fitAreaTo(grown, [{ ...p, h: 10 }])).toBe(grown);
  });
});

describe("fitView", () => {
  it("shows every rectangle, centred, inside the padding", () => {
    const rects = [
      { x: 0, y: 0, w: 1000, h: 800 },
      { x: 3000, y: 2000, w: 1000, h: 800 },
    ];
    const cam = fitView(rects, { w: 1600, h: 1000 }, { padding: 40 });
    const screen = (x: number, y: number) => [(x - cam.x) * cam.zoom, (y - cam.y) * cam.zoom];
    const [x0, y0] = screen(0, 0);
    const [x1, y1] = screen(4000, 2800);
    expect(Math.min(x0, y0)).toBeGreaterThanOrEqual(40 - 1e-6);
    expect(x1).toBeLessThanOrEqual(1600 - 40 + 1e-6);
    expect(y1).toBeLessThanOrEqual(1000 - 40 + 1e-6);
    // centred: the same margin either side of the axis that doesn't decide the zoom
    expect(x0).toBeCloseTo(1600 - x1);
  });

  it("doesn't zoom past 100% for something small, nor out past the floor for something huge", () => {
    expect(fitView([{ x: 0, y: 0, w: 100, h: 100 }], { w: 1600, h: 1000 }).zoom).toBe(1);
    expect(fitView([{ x: 0, y: 0, w: 1e7, h: 100 }], { w: 1600, h: 1000 }, { minZoom: 0.1 }).zoom).toBe(0.1);
  });

  it("starts at the origin, at 100%, with nothing to show", () => {
    expect(fitView([], { w: 1600, h: 1000 })).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});

describe("a session's place", () => {
  it("names stacks the way the grid named its workspace cells", () => {
    for (const g of [null, "5101", "5101/api", "ungrouped/x", "/x", "5101/", "5101/ api "]) {
      const stack = stackKeyOf({ taskGroup: g });
      expect(stack ? `ws:${stack}` : "s").toBe(cellKeyFor("s", g));
    }
    expect(areaKeyOf({ taskGroup: "5101/api" })).toBe("5101");
    expect(areaKeyOf({ taskGroup: null })).toBe("ungrouped");
  });
});

// ---- patches ---------------------------------------------------------------------------

const ghost = (over: Partial<Ghost> = {}): Ghost => ({
  title: "closed",
  agent: "claude",
  cwd: "/r",
  repoPath: "/r",
  placement: { x: 0, y: 0, w: 100, h: 100 },
  group: "5101",
  closedAt: "2026-11-01T00:00:00.000Z",
  ...over,
});
const base = (): Landscape => ({
  ...emptyLandscape(),
  workspaces: { a: { x: 0, y: 0, w: 100, h: 100 } },
  areas: { "5101": { x: 0, y: 0, w: 500, h: 400, repos: [{ path: "/r", base: "dev" }] } },
  stacks: { "5101/api": { active: "b", placement: { x: 200, y: 0, w: 100, h: 100 } } },
});
const patched = (l: Landscape, p: unknown) => applyPatch(l, parsePatch(p));

describe("patches", () => {
  it("replace a placement whole, add one, and remove one with null", () => {
    const l = patched(base(), { workspaces: { a: { x: 8, y: 16, w: 200, h: 120 }, c: { x: 400, y: 0, w: 100, h: 100 } } });
    expect(l.workspaces).toEqual({ a: { x: 8, y: 16, w: 200, h: 120 }, c: { x: 400, y: 0, w: 100, h: 100 } });
    expect(patched(l, { workspaces: { a: null } }).workspaces).toEqual({ c: { x: 400, y: 0, w: 100, h: 100 } });
  });

  it("merge an area field by field: collapsing it keeps its rectangle and repos", () => {
    const l = patched(base(), { areas: { "5101": { collapsed: true } } });
    expect(l.areas["5101"]).toEqual({ x: 0, y: 0, w: 500, h: 400, repos: [{ path: "/r", base: "dev" }], collapsed: true });
    const moved = patched(l, { areas: { "5101": { x: 64 } } });
    expect(moved.areas["5101"]).toMatchObject({ x: 64, collapsed: true, repos: [{ path: "/r", base: "dev" }] });
  });

  it("merge a stack: switching its front tab keeps its placement", () => {
    expect(patched(base(), { stacks: { "5101/api": { active: "c" } } }).stacks["5101/api"]).toEqual({ active: "c", placement: { x: 200, y: 0, w: 100, h: 100 } });
  });

  it("add a whole new area or stack", () => {
    const l = patched(base(), { areas: { "5102": { x: 600, y: 0, w: 400, h: 300, repos: [] } }, stacks: { "5102/x": { active: "z", placement: { x: 640, y: 48, w: 100, h: 100 } } } });
    expect(Object.keys(l.areas)).toEqual(["5101", "5102"]);
    expect(l.stacks["5102/x"].active).toBe("z");
  });

  it("take ids the landscape doesn't have: a placement for a session it hasn't seen, and removing what isn't there", () => {
    const l = patched(base(), { workspaces: { "r~0f1e2d3c4b5a~n7": { x: 0, y: 200, w: 100, h: 100 }, gone: null }, areas: { nope: null }, stacks: { "x/y": null }, ghosts: { g: null } });
    expect(Object.keys(l.workspaces)).toEqual(["a", "r~0f1e2d3c4b5a~n7"]);
    expect(Object.keys(l.areas)).toEqual(["5101"]);
  });

  it("refuse a change to an area or stack that isn't there unless it comes whole, saying so", () => {
    const l = base();
    expect(() => patched(l, { areas: { "5102": { collapsed: true } } })).toThrow(/areas\["5102"\] isn't on the landscape, so the patch has to give all of it \(areas\["5102"\]\.x is missing\)/);
    expect(() => patched(l, { stacks: { "5102/x": { active: "z" } } })).toThrow(/placement is missing/);
    expect(l).toEqual(base());
  });

  it("refuse a change that leaves an entry wrong, changing nothing", () => {
    const l = base();
    expect(() => patched(l, { areas: { "5101": { w: 0 } } })).toThrow(/areas\["5101"\]\.w is not above 0/);
    expect(() => patched(l, { areas: { "5101": { repos: [{ path: "/r", base: null }, { path: "/r", base: "main" }] } } })).toThrow(/lists \/r twice/);
    expect(() => patched(l, { stacks: { "5101/api": { active: "" } } })).toThrow(/active is empty/);
    expect(l).toEqual(base());
  });

  it("never change the landscape they're applied to", () => {
    const l = base();
    const copy = JSON.parse(JSON.stringify(l));
    patched(l, { workspaces: { a: null }, areas: { "5101": { locked: true } }, ghosts: { g: ghost() }, tourDone: true });
    expect(l).toEqual(copy);
  });

  it("add and remove ghosts, and set or clear the migration and tour marks", () => {
    let l = patched(base(), { ghosts: { g: ghost({ conversation: { agent: "codex", id: "c1" }, worktreeRemoved: true }) }, migratedAt: "2026-11-02T00:00:00.000Z", tourDone: true });
    expect(l.ghosts.g.conversation).toEqual({ agent: "codex", id: "c1" });
    expect(l).toMatchObject({ migratedAt: "2026-11-02T00:00:00.000Z", tourDone: true });
    l = patched(l, { ghosts: { g: null }, migratedAt: null });
    expect(l.ghosts).toEqual({});
    expect("migratedAt" in l).toBe(false);
  });

  it("apply in order, so later ones win and earlier ones to other entries stay", () => {
    let l = base();
    for (const p of [{ workspaces: { a: { x: 8, y: 0, w: 100, h: 100 } } }, { areas: { "5101": { locked: true } } }, { workspaces: { a: { x: 16, y: 0, w: 100, h: 100 } } }]) l = patched(l, p);
    expect(l.workspaces.a.x).toBe(16);
    expect(l.areas["5101"].locked).toBe(true);
  });

  it("refuse what isn't a patch, naming the field and why", () => {
    const refused: [unknown, RegExp][] = [
      [null, /the patch is not an object/],
      [[], /the patch is not an object/],
      [{ wires: {} }, /the patch has a field this version doesn't know \(wires\)/],
      [{ workspaces: [] }, /workspaces is not an object/],
      [{ workspaces: { a: { x: "1", y: 0, w: 1, h: 1 } } }, /workspaces\["a"\]\.x is not a number/],
      [{ workspaces: { a: { x: NaN, y: 0, w: 1, h: 1 } } }, /x is not a number/],
      [{ workspaces: { a: { x: Infinity, y: 0, w: 1, h: 1 } } }, /x is not a number/],
      [{ workspaces: { a: { x: 0, y: 0, w: 0, h: 1 } } }, /w is not above 0/],
      [{ workspaces: { a: { x: 0, y: 0, w: 1 } } }, /workspaces\["a"\]\.h is missing/],
      [{ workspaces: { a: { x: 0, y: 0, w: 1, h: 1, z: 3 } } }, /workspaces\["a"\] has a field this version doesn't know \(z\)/],
      [{ workspaces: { "": { x: 0, y: 0, w: 1, h: 1 } } }, /key that can't be used/],
      [JSON.parse('{"workspaces":{"__proto__":{"x":0,"y":0,"w":1,"h":1}}}'), /key that can't be used \("__proto__"\)/],
      [{ areas: { "5101": { collapsed: "yes" } } }, /areas\["5101"\]\.collapsed is not true or false/],
      [{ areas: { "5101": { colour: "red" } } }, /areas\["5101"\] has a field this version doesn't know \(colour\)/],
      [{ areas: { "5101": { repos: "/r" } } }, /repos is not a list/],
      [{ areas: { "5101": { repos: [{ path: "/r" }] } } }, /repos\[0\]\.base is missing/],
      [{ stacks: { "5101/api": { placement: { x: 0 } } } }, /stacks\["5101\/api"\]\.placement\.y is missing/],
      [{ ghosts: { g: { ...ghost(), agent: "gpt" } } }, /ghosts\["g"\]\.agent is not claude, codex or terminal/],
      [{ ghosts: { g: { ...ghost(), conversation: { agent: "claude" } } } }, /conversation\.id is missing/],
      [{ tourDone: "yes" }, /tourDone is not true or false/],
      [{ migratedAt: 5 }, /migratedAt is not a string/],
    ];
    for (const [p, why] of refused) {
      expect(() => parsePatch(p), JSON.stringify(p)).toThrow(LandscapeShapeError);
      expect(() => parsePatch(p), JSON.stringify(p)).toThrow(why);
    }
  });

  it("check what a typed caller hands applyPatch too, not only what came over IPC", () => {
    expect(() => applyPatch(base(), { workspaces: { a: { x: 0, y: 0, w: -1, h: 1 } } })).toThrow(/w is not above 0/);
    const proto = JSON.parse('{"__proto__":{"x":0,"y":0,"w":1,"h":1}}');
    expect(() => applyPatch(base(), { workspaces: proto })).toThrow(/key that can't be used/);
  });
});

describe("a stored landscape", () => {
  it("reads back what was written", () => {
    const l = patched(base(), { ghosts: { g: ghost({ branch: "b", summary: "s" }) }, migratedAt: "2026-11-02T00:00:00.000Z", tourDone: false });
    expect(parseLandscape(JSON.parse(JSON.stringify(l)))).toEqual(l);
  });

  it("is refused whole, naming the first field that's wrong", () => {
    expect(() => parseLandscape(null)).toThrow(/the landscape is not an object/);
    expect(() => parseLandscape({ ...base(), v: 2 })).toThrow(/^v is 2, not 1$/);
    expect(() => parseLandscape({ ...base(), areas: { "5101": { x: 0, y: 0, w: 1, h: 1 } } })).toThrow(/areas\["5101"\]\.repos is missing/);
    expect(() => parseLandscape({ v: 1, workspaces: {}, areas: {}, stacks: {} })).toThrow(/ghosts is missing/);
  });

  it("is refused with a field this version doesn't know, rather than losing it on the next save", () => {
    expect(() => parseLandscape({ ...base(), wires: {} })).toThrow(/the landscape has a field this version doesn't know \(wires\)/);
    expect(() => parseLandscape({ ...base(), areas: { "5101": { ...base().areas["5101"], budget: 5 } } })).toThrow(/budget/);
  });
});
