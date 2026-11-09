import { describe, expect, it } from "vitest";
import {
  REVEAL_WAIT_MS,
  ZOOM_MAX,
  ZOOM_MIN,
  afterChange,
  areaSelectionNow,
  cameraFrom,
  centreOn,
  clampZoom,
  clearRoom,
  contentRects,
  fitAll,
  inView,
  migrationPatch,
  migrationStep,
  partialMigration,
  nearestInDirection,
  newer,
  panBy,
  planMakeArea,
  planMoveArea,
  readProblem,
  resolveLayout,
  revealTile,
  toLandscape,
  wheelPixels,
  wheelZoomFactor,
  worldTransform,
  zoomAbout,
  type ListsLoaded,
} from "../src/renderer/landscapeModel";
import { AREA_PAD, GAP, LOOSE_GROUP, MAX_COORD, WORKSPACE_CHROME, applyPatch, colsRows, emptyLandscape, overlaps, parseLandscape, presetSize, sizeFor, type Landscape, type LandscapeProblem, type LandscapeState, type Rect } from "../src/shared/landscape";
import type { SessionInfo } from "../src/shared/types";

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  title: id,
  repoPath: "/r",
  cwd: "/r",
  branch: null,
  ticketId: null,
  ticketTitle: null,
  taskGroup: null,
  status: "idle",
  createdAt: 0,
  kind: "work",
  extraDirs: [],
  waitingReason: null,
  waitingSince: null,
  agent: "claude",
  ...over,
});

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe("the landscape's camera", () => {
  it("zooms about a point: the landscape point under it stays under it", () => {
    const cam = { x: 120, y: -40, zoom: 0.8 };
    for (const p of [{ x: 0, y: 0 }, { x: 640, y: 300 }, { x: 1300, y: 820 }]) {
      for (const z of [0.25, 0.8, 1, 1.7]) {
        const next = zoomAbout(cam, p, z);
        expect(next.zoom).toBe(z);
        const a = toLandscape(cam, p);
        const b = toLandscape(next, p);
        close(a.x, b.x);
        close(a.y, b.y);
      }
    }
  });
  it("keeps the zoom between its limits, and the point fixed at the limit", () => {
    const cam = { x: 0, y: 0, zoom: 1 };
    expect(zoomAbout(cam, { x: 100, y: 100 }, 50).zoom).toBe(ZOOM_MAX);
    expect(zoomAbout(cam, { x: 100, y: 100 }, 0.001).zoom).toBe(ZOOM_MIN);
    const out = zoomAbout(cam, { x: 300, y: 200 }, -3);
    expect(out.zoom).toBe(ZOOM_MIN);
    close(toLandscape(out, { x: 300, y: 200 }).x, 300);
    expect([clampZoom(NaN), clampZoom(Infinity)]).toEqual([NaN, ZOOM_MAX]);
  });
  it("pans with the pointer: content moves the screen distance, the camera that over the zoom", () => {
    expect(panBy({ x: 10, y: 20, zoom: 0.5 }, 100, -50)).toEqual({ x: -190, y: 120, zoom: 0.5 });
    expect(panBy({ x: 10, y: 20, zoom: 2 }, 100, -50)).toEqual({ x: -40, y: 45, zoom: 2 });
  });
  it("reads a wheel's lines and pages as pixels, and zooms a notch and a pinch alike, never more than ×~2 an event", () => {
    expect(wheelPixels(3, 1, 800)).toBe(48);
    expect(wheelPixels(1, 2, 800)).toBe(800);
    expect(wheelPixels(-7.5, 0, 800)).toBe(-7.5);
    expect(wheelZoomFactor(0, true)).toBe(1);
    expect(wheelZoomFactor(-10, true)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, false)).toBeLessThan(1);
    // a pinch's ten small deltas and four notches of a wheel zoom alike
    expect(wheelZoomFactor(-10, true) ** 10).toBeCloseTo(wheelZoomFactor(-100, false) ** 4, 6);
    for (const pinch of [true, false]) {
      expect(wheelZoomFactor(-1e6, pinch)).toBeCloseTo(2, 9);
      expect(wheelZoomFactor(1e6, pinch)).toBeCloseTo(0.5, 9);
    }
  });
  it("fits everything centred, never past 100% and never below the lowest zoom", () => {
    const rects: Rect[] = [{ x: 0, y: 0, w: 1000, h: 800 }, { x: 1200, y: 900, w: 1000, h: 800 }];
    const cam = fitAll(rects, { w: 1100, h: 850 });
    expect(cam.zoom).toBeLessThan(1);
    for (const r of rects) expect(inView(cam, r, { w: 1100, h: 850 })).toBe(true);
    // the middle of everything is the middle of the view
    close(toLandscape(cam, { x: 550, y: 425 }).x, 1100);
    close(toLandscape(cam, { x: 550, y: 425 }).y, 850);
    expect(fitAll([{ x: 0, y: 0, w: 100, h: 100 }], { w: 1100, h: 850 }).zoom).toBe(1);
    expect(fitAll([{ x: 0, y: 0, w: 1e6, h: 1e6 }], { w: 1100, h: 850 }).zoom).toBe(ZOOM_MIN);
    expect(fitAll([], { w: 1100, h: 850 })).toEqual({ x: 0, y: 0, zoom: 1 });
  });
  it("centres a workspace at the zoom it's at, and says when one is wholly in view", () => {
    const r = { x: 500, y: 300, w: 200, h: 100 };
    const cam = centreOn({ x: 0, y: 0, zoom: 0.5 }, r, { w: 1000, h: 800 });
    expect(cam.zoom).toBe(0.5);
    close(toLandscape(cam, { x: 500, y: 400 }).x, 600);
    close(toLandscape(cam, { x: 500, y: 400 }).y, 350);
    expect(inView(cam, r, { w: 1000, h: 800 })).toBe(true);
    expect(inView({ x: 0, y: 0, zoom: 1 }, { x: 900, y: 0, w: 200, h: 10 }, { w: 1000, h: 800 })).toBe(false);
  });
  it("brings something into view left of a box over the view, in what's left at 1024×768 too, and in all of it when too little is", () => {
    const vp = { left: 456.23, top: 40, width: 567.77, height: 700 };
    const tray = (left: number) => ({ left, top: 44, right: left + 320, bottom: 500 });
    // the tray at 1024×768: 239.77 px beside it
    expect(clearRoom(vp, tray(696)).w).toBeCloseTo(239.77);
    expect(clearRoom(vp, tray(696)).h).toBe(700);
    // too narrow to bring anything into: all of it
    expect(clearRoom(vp, tray(456.23 + 150))).toEqual({ w: 567.77, h: 700 });
    // nothing over it
    expect(clearRoom(vp, null)).toEqual({ w: 567.77, h: 700 });
    expect(clearRoom(vp, { left: 0, top: 44, right: 400, bottom: 500 })).toEqual({ w: 567.77, h: 700 });
  });
  it("reads a kept camera only when it's one, and puts it on the world as a transform", () => {
    expect(cameraFrom({ x: 1, y: -2, zoom: 0.5 })).toEqual({ x: 1, y: -2, zoom: 0.5 });
    expect(cameraFrom({ x: 1, y: 2, zoom: 40 })).toEqual({ x: 1, y: 2, zoom: ZOOM_MAX });
    // kept inside the landscape: a camera saved past MAX_COORD comes back at its edge
    expect(cameraFrom({ x: 1e300, y: -1e300, zoom: 1 })).toEqual({ x: MAX_COORD, y: -MAX_COORD, zoom: 1 });
    for (const bad of [null, "x", { x: 1, y: 2 }, { x: NaN, y: 0, zoom: 1 }, { x: 0, y: 0, zoom: 0 }, { x: 0, y: 0, zoom: -1 }]) expect(cameraFrom(bad)).toBeNull();
    expect(worldTransform({ x: 10, y: -20, zoom: 0.5 })).toBe("scale(0.5) translate(-10px, 20px)");
  });
});

describe("a workspace's terminal size", () => {
  it("is as many of the measured cell as its placement holds inside the frame, whatever the estimate said", () => {
    const measured = { w: 7.528169014084507, h: 21 };
    const m = presetSize("agent", "M");
    expect(colsRows(m.w, m.h, measured.w, measured.h)).toEqual({ cols: Math.floor((m.w - WORKSPACE_CHROME.w) / measured.w), rows: Math.floor((m.h - WORKSPACE_CHROME.h) / measured.h) });
    // the window in focus: the same frame
    expect(colsRows(1092, 745, measured.w, measured.h)).toEqual({ cols: 142, rows: 32 });
    // sizeFor's answer at the measured cell holds exactly what it was asked for, never a column less
    for (const [cols, rows] of [[140, 42], [161, 40], [1, 1]]) {
      const s = sizeFor(cols, rows, measured.w, measured.h);
      expect(colsRows(s.w, s.h, measured.w, measured.h)).toEqual({ cols, rows });
    }
    // nothing smaller than one cell
    expect(colsRows(4, 4, measured.w, measured.h)).toEqual({ cols: 1, rows: 1 });
  });
});

describe("moving between workspaces with ⌥ and the arrows", () => {
  const at = (key: string, x: number, y: number, w = 100, h = 100) => ({ key, rect: { x, y, w, h } });
  const grid = [at("a", 0, 0), at("b", 200, 0), at("c", 0, 200), at("d", 200, 200)];
  it("goes to the nearest workspace that way, along a row or a column before across", () => {
    const from = grid[0].rect;
    const others = grid.slice(1);
    expect(nearestInDirection(from, others, "right")).toBe("b");
    expect(nearestInDirection(from, others, "down")).toBe("c");
    expect(nearestInDirection(grid[3].rect, grid.slice(0, 3), "up")).toBe("b");
    expect(nearestInDirection(grid[3].rect, grid.slice(0, 3), "left")).toBe("c");
  });
  it("is null when nothing lies that way", () => {
    expect(nearestInDirection(grid[0].rect, grid.slice(1), "left")).toBeNull();
    expect(nearestInDirection(grid[0].rect, grid.slice(1), "up")).toBeNull();
    expect(nearestInDirection(grid[0].rect, [], "right")).toBeNull();
  });
  it("counts going sideways double: one far ahead beats one near but off to the side", () => {
    const from = { x: 0, y: 0, w: 100, h: 100 };
    expect(nearestInDirection(from, [at("ahead", 500, 0), at("side", 150, 250)], "right")).toBe("ahead");
    expect(nearestInDirection(from, [at("ahead", 900, 0), at("side", 150, 250)], "right")).toBe("side");
  });
  it("skips one level with it: a workspace straight below isn't to the right", () => {
    expect(nearestInDirection({ x: 0, y: 0, w: 100, h: 100 }, [at("below", 0, 300)], "right")).toBeNull();
  });
});

describe("where each session's workspace sits", () => {
  const base = (): Landscape => {
    const l = emptyLandscape();
    l.migratedAt = "2026-11-01T00:00:00.000Z";
    l.areas.A = { x: 0, y: 0, w: 2400, h: 900, repos: [] };
    l.workspaces.a1 = { x: 24, y: 48, w: 1072, h: 800 };
    l.stacks["A/api"] = { active: "a3", placement: { x: 1112, y: 48, w: 1072, h: 800 } };
    return l;
  };
  it("uses stored placements, a stack's for its members, with its active tab in front", () => {
    const r = resolveLayout(base(), [session("a1", { taskGroup: "A" }), session("a2", { taskGroup: "A/api" }), session("a3", { taskGroup: "A/api" })]);
    expect(r.patch).toBeNull();
    expect(r.tiles.map((t) => [t.key, t.front.id, t.members.map((m) => m.id)])).toEqual([
      ["a1", "a1", ["a1"]],
      ["ws:A/api", "a3", ["a2", "a3"]],
    ]);
    expect(r.tiles[1].rect).toEqual(base().stacks["A/api"].placement);
  });
  it("puts a stack's first member in front when its active tab has left it", () => {
    const r = resolveLayout(base(), [session("a2", { taskGroup: "A/api" }), session("a4", { taskGroup: "A/api" })]);
    expect(r.tiles[0].front.id).toBe("a2");
    expect(r.patch).toBeNull();
  });
  it("places a new session in its area's first free spot, growing the area, and says what to save", () => {
    const l = base();
    const r = resolveLayout(l, [session("a1", { taskGroup: "A" }), session("n1", { taskGroup: "A" })]);
    const n1 = r.tiles.find((t) => t.key === "n1")!.rect;
    expect(n1.y).toBeGreaterThan(l.workspaces.a1.y);
    for (const t of r.tiles) if (t.key !== "n1") expect(overlaps(t.rect, n1)).toBe(false);
    expect(overlaps(n1, l.stacks["A/api"].placement)).toBe(false);
    const area = r.areas.find((a) => a.key === "A")!.rect;
    expect(n1.y + n1.h + AREA_PAD).toBeLessThanOrEqual(area.y + area.h);
    expect(r.patch).toEqual({ workspaces: { n1 }, areas: { A: { w: area.w, h: area.h } } });
    // the patch, saved, gives the same layout and nothing more to save
    const saved = applyPatch(l, r.patch!);
    expect(parseLandscape(saved)).toEqual(saved);
    expect(resolveLayout(saved, [session("a1", { taskGroup: "A" }), session("n1", { taskGroup: "A" })]).patch).toBeNull();
  });
  it("gives a group made since an area of its own, right of everything, and a sub-group its stack", () => {
    const l = base();
    const r = resolveLayout(l, [session("b1", { taskGroup: "B/x" }), session("b2", { taskGroup: "B/x", shell: true, agent: undefined })]);
    const b = r.areas.find((a) => a.key === "B")!.rect;
    expect(b.x).toBeGreaterThanOrEqual(l.areas.A.x + l.areas.A.w);
    expect(r.patch?.areas?.B).toEqual(b);
    expect(r.patch?.stacks?.["B/x"]).toEqual({ active: "b1", placement: r.tiles[0].rect });
    // an agent among its members makes it an agent-sized workspace
    expect({ w: r.tiles[0].rect.w, h: r.tiles[0].rect.h }).toEqual(presetSize("agent", "M"));
    const saved = applyPatch(l, r.patch!);
    expect(parseLandscape(saved)).toEqual(saved);
  });
  it("puts a sub-group that has no stack yet where its first member was on its own", () => {
    const l = base();
    const r = resolveLayout(l, [session("a1", { taskGroup: "A/new" }), session("n2", { taskGroup: "A/new" })]);
    expect(r.tiles[0].rect).toEqual(l.workspaces.a1);
    expect(r.patch).toEqual({ stacks: { "A/new": { active: "a1", placement: l.workspaces.a1 } } });
  });
  it("leaves stored places taken, ghosts' and resumable sessions' included, and puts a loose session left of the first area", () => {
    const l = base();
    l.ghosts.g = { title: "g", agent: "claude", cwd: "/r", repoPath: null, placement: { x: 24, y: 864, w: 1072, h: 800 }, group: "A", closedAt: "x" };
    l.workspaces.gone = { x: 1112, y: 864, w: 1072, h: 800 }; // a session waiting to be resumed
    const r = resolveLayout(l, [session("a1", { taskGroup: "A" }), session("n1", { taskGroup: "A" }), session("loose")]);
    const n1 = r.tiles.find((t) => t.key === "n1")!.rect;
    expect(overlaps(n1, l.ghosts.g.placement, GAP - 1)).toBe(false);
    expect(overlaps(n1, l.workspaces.gone, GAP - 1)).toBe(false);
    const loose = r.tiles.find((t) => t.key === "loose")!.rect;
    expect(loose.x + loose.w).toBeLessThanOrEqual(l.areas.A.x);
    expect(r.tiles.find((t) => t.key === "loose")!.area).toBe("ungrouped");
  });
  it("brings a session picked before its workspace exists into view once it does, within REVEAL_WAIT_MS", () => {
    const p = { id: "n1", until: 1000 + REVEAL_WAIT_MS };
    const before = resolveLayout(base(), [session("a1", { taskGroup: "A" })]);
    expect(revealTile(p, before.tiles, 1000)).toBe("wait");
    expect(revealTile(p, before.tiles, 1000 + REVEAL_WAIT_MS)).toBe("wait");
    const after = resolveLayout(base(), [session("a1", { taskGroup: "A" }), session("n1", { taskGroup: "A" })]);
    expect((revealTile(p, after.tiles, 1000 + REVEAL_WAIT_MS) as { key: string }).key).toBe("n1");
    // a stack's member is brought in with its stack
    const stack = resolveLayout(base(), [session("a2", { taskGroup: "A/api" }), session("a3", { taskGroup: "A/api" })]);
    expect((revealTile({ id: "a2", until: 0 }, stack.tiles, 1) as { key: string }).key).toBe("ws:A/api");
    expect(revealTile(p, before.tiles, 1001 + REVEAL_WAIT_MS)).toBe("expired");
  });
  it("keys a group or session named like Object.prototype's members as any other", () => {
    const l = emptyLandscape();
    const r = resolveLayout(l, [session("__proto__", { taskGroup: "constructor" }), session("toString", { taskGroup: "constructor/__proto__" })]);
    const saved = applyPatch(l, r.patch!);
    expect(Object.keys(saved.areas)).toEqual(["constructor"]);
    expect(Object.hasOwn(saved.workspaces, "__proto__")).toBe(true);
    expect(Object.keys(saved.stacks)).toEqual(["constructor/__proto__"]);
    expect(contentRects(resolveLayout(saved, [session("__proto__", { taskGroup: "constructor" })]))).toHaveLength(2);
  });
  it("puts the first session made since a right-click's New workspace where it was clicked, in the area clicked", () => {
    const l = base();
    const at = { x: 1300, y: 900 };
    const hint = { area: "A", at, since: 500 };
    const shown = [session("a1", { taskGroup: "A" }), session("old", { taskGroup: "A", createdAt: 100 }), session("n1", { taskGroup: "A", createdAt: 600 }), session("n2", { taskGroup: "A", createdAt: 700 })];
    const r = resolveLayout(l, shown, undefined, [], hint);
    expect(r.hinted).toBe("n1");
    const n1 = r.tiles.find((t) => t.key === "n1")!.rect;
    // on the grid at the click, up the few px that keep it inside the area, which then needn't grow for it
    expect([n1.x, n1.y]).toEqual([1304, 864]);
    const area = r.areas.find((a) => a.key === "A")!.rect;
    expect(n1.y + n1.h + AREA_PAD).toBeLessThanOrEqual(area.y + area.h);
    expect(area).toEqual(resolveLayout(l, shown).areas.find((a) => a.key === "A")!.rect);
    // the ones before it and after it go where they'd go anyway, clear of it
    const plain = resolveLayout(l, shown);
    expect(r.tiles.find((t) => t.key === "old")!.rect).toEqual(plain.tiles.find((t) => t.key === "old")!.rect);
    for (const t of r.tiles) if (t.key !== "n1") expect(overlaps(t.rect, n1)).toBe(false);
    // its place is saved like any new one's, and once saved the hint changes nothing
    const saved = applyPatch(l, r.patch!);
    expect(saved.workspaces.n1).toEqual(n1);
    expect(resolveLayout(saved, shown, undefined, [], hint).patch).toBeNull();
  });
  it("places a session by a right-click only when it's this Mac's, new since, and in the area clicked", () => {
    const l = base();
    const hint = { area: "A", at: { x: 1300, y: 900 }, since: 500 };
    const plain = (s: SessionInfo) => resolveLayout(l, [session("a1", { taskGroup: "A" }), s]).tiles.find((t) => t.key === s.id)!.rect;
    for (const s of [
      session("before", { taskGroup: "A", createdAt: 499 }),
      session("elsewhere", { taskGroup: "B", createdAt: 600 }),
      session("theirs", { taskGroup: "A", createdAt: 600, room: { remote: true } as SessionInfo["room"] }),
    ]) {
      const r = resolveLayout(l, [session("a1", { taskGroup: "A" }), s], undefined, [], hint);
      expect(r.hinted, s.id).toBeNull();
      expect(r.tiles.find((t) => t.key === s.id)!.rect, s.id).toEqual(plain(s));
    }
    // a click outside every area places a loose one where it was clicked
    const loose = resolveLayout(l, [session("a1", { taskGroup: "A" }), session("n", { createdAt: 600 })], undefined, [], { area: LOOSE_GROUP, at: { x: -1500, y: 200 }, since: 500 });
    expect(loose.hinted).toBe("n");
    expect(loose.tiles.find((t) => t.key === "n")!.rect).toMatchObject({ x: -1496, y: 200 });
  });
  it("keeps a right-clicked workspace inside the area clicked, the area beside it left where it is, locked or not", () => {
    for (const locked of [false, true]) {
      const l = emptyLandscape();
      l.migratedAt = "2026-11-01T00:00:00.000Z";
      l.areas.A = { x: 0, y: 0, w: 2400, h: 2000, repos: [] };
      l.areas.B = { x: 2464, y: 0, w: 1200, h: 2000, repos: [], locked };
      l.workspaces.a1 = { x: 24, y: 48, w: 1072, h: 800 };
      l.workspaces.b1 = { x: 2488, y: 48, w: 1072, h: 800 };
      const shown = [session("a1", { taskGroup: "A" }), session("b1", { taskGroup: "B" }), session("n", { taskGroup: "A", createdAt: 600 })];
      // near A's right edge: a workspace with its corner at the click would reach into B
      const r = resolveLayout(l, shown, undefined, [], { area: "A", at: { x: 2000, y: 900 }, since: 500 });
      expect(r.hinted, String(locked)).toBe("n");
      const n = r.tiles.find((t) => t.key === "n")!.rect;
      const rect = (k: string) => r.areas.find((a) => a.key === k)!.rect;
      expect(rect("A"), String(locked)).toMatchObject({ x: 0, y: 0, w: 2400, h: 2000 });
      expect(rect("B"), String(locked)).toMatchObject({ x: 2464, y: 0, w: 1200, h: 2000 });
      expect(n, String(locked)).toMatchObject({ x: 2400 - AREA_PAD - n.w, y: 904 });
      expect(overlaps(n, rect("B")), String(locked)).toBe(false);
    }
  });
  it("grows a hemmed-in area towards the edge nearer the click, never moving it; neighbours in the way, locked or not, move aside whole", () => {
    const layout = (bLocked: boolean, cLocked: boolean, at: { x: number; y: number }) => {
      const l = emptyLandscape();
      l.migratedAt = "2026-11-01T00:00:00.000Z";
      l.areas.A = { x: 0, y: 0, w: 2400, h: 2000, repos: [] };
      l.areas.B = { x: 2464, y: 0, w: 1200, h: 2000, repos: [], locked: bLocked };
      l.areas.C = { x: 0, y: 2064, w: 2400, h: 1200, repos: [], locked: cLocked };
      l.workspaces.a1 = { x: 24, y: 48, w: 2352, h: 1928 };
      l.workspaces.b1 = { x: 2488, y: 48, w: 1000, h: 800 };
      l.workspaces.c1 = { x: 24, y: 2112, w: 1000, h: 600 };
      const shown = [session("a1", { taskGroup: "A" }), session("b1", { taskGroup: "B" }), session("c1", { taskGroup: "C" }), session("n", { taskGroup: "A", createdAt: 600 })];
      const r = resolveLayout(l, shown, undefined, [], { area: "A", at, since: 500 });
      return { l, r, rect: (k: string) => r.areas.find((a) => a.key === k)!.rect, tile: (k: string) => r.tiles.find((t) => t.key === k)!.rect };
    };
    for (const [bLocked, cLocked] of [[false, false], [true, false], [false, true], [true, true]]) {
      for (const [at, edge] of [[{ x: 2000, y: 900 }, "right"], [{ x: 1000, y: 1800 }, "bottom"]] as const) {
        const { l, r, rect, tile } = layout(bLocked, cLocked, at);
        const what = `B ${bLocked ? "locked" : "unlocked"}, C ${cLocked ? "locked" : "unlocked"}, nearer the ${edge}`;
        const n = tile("n");
        // a new column right of a1, by the click's y; or a new row below it, by its x
        if (edge === "right") expect([n.x, Math.abs(n.y - at.y) <= n.h], what).toEqual([2392, true]);
        else expect([n.y, Math.abs(n.x - at.x) <= n.w], what).toEqual([1992, true]);
        // A never moves, and nothing is refused
        expect(rect("A"), what).toMatchObject({ x: 0, y: 0 });
        expect(r.hinted, what).toBe("n");
        // the one in the way moves aside as a whole, locked or not: its workspace where it was inside it
        for (const [k, w] of [["B", "b1"], ["C", "c1"]] as const) {
          const was = l.areas[k];
          const d = { dx: rect(k).x - was.x, dy: rect(k).y - was.y };
          expect(tile(w), `${what}: ${w} inside ${k}`).toEqual({ ...l.workspaces[w], x: l.workspaces[w].x + d.dx, y: l.workspaces[w].y + d.dy });
          expect(rect(k).locked ?? false, what).toBe(k === "B" ? bLocked : cLocked);
          expect(overlaps(rect("A"), rect(k), 64 - 1e-6), `${what}: A and ${k}`).toBe(false);
        }
        expect(rect(edge === "right" ? "B" : "C").x + rect(edge === "right" ? "B" : "C").y, what).toBeGreaterThan(edge === "right" ? 2464 : 2064);
        // no workspace on another, and each still in its area
        for (const [k, area] of [["a1", "A"], ["n", "A"], ["b1", "B"], ["c1", "C"]]) {
          const t = tile(k);
          expect(t.x >= rect(area).x && t.x + t.w <= rect(area).x + rect(area).w && t.y >= rect(area).y && t.y + t.h <= rect(area).y + rect(area).h, `${what}: ${k} in ${area}`).toBe(true);
          for (const j of ["a1", "n", "b1", "c1"]) if (j !== k) expect(overlaps(t, tile(j)), `${what}: ${k} on ${j}`).toBe(false);
        }
      }
    }
  });
  // D full along one row; A just below it and B just right of it, each holding a workspace of its own
  const hemmed = (aLocked: boolean, bLocked: boolean): Landscape => {
    const l = emptyLandscape();
    l.migratedAt = "2026-11-01T00:00:00.000Z";
    l.areas.D = { x: 0, y: 0, w: 2400, h: 600, repos: [] };
    l.areas.A = { x: 0, y: 664, w: 2400, h: 1200, repos: [], locked: aLocked };
    l.areas.B = { x: 2464, y: 0, w: 1200, h: 2000, repos: [], locked: bLocked };
    l.workspaces.d1 = { x: 24, y: 48, w: 2352, h: 528 };
    l.workspaces.a1 = { x: 24, y: 712, w: 1000, h: 600 };
    l.workspaces.b1 = { x: 2488, y: 48, w: 1000, h: 800 };
    return l;
  };
  const hemmedShown = [session("d1", { taskGroup: "D" }), session("a1", { taskGroup: "A" }), session("b1", { taskGroup: "B" })];
  const LOCKS = [[false, false], [true, false], [false, true], [true, true]] as const;
  /** Where `l` ends up: each area, and each workspace, by key. */
  const placesOf = (l: Landscape, r: ReturnType<typeof resolveLayout>) => ({
    area: (k: string) => r.areas.find((a) => a.key === k)?.rect ?? l.areas[k],
    tile: (k: string) => r.tiles.find((t) => t.key === k)?.rect ?? l.workspaces[k],
  });
  /** No workspace on another, each inside its area, the areas `AREA_GAP` apart: what any growing leaves. */
  const tidy = (l: Landscape, keys: Record<string, string>, what: string) => {
    for (const [k, a] of Object.entries(keys)) {
      const t = l.workspaces[k];
      const r = l.areas[a];
      expect(t.x >= r.x && t.x + t.w <= r.x + r.w && t.y >= r.y && t.y + t.h <= r.y + r.h, `${what}: ${k} in ${a}`).toBe(true);
      for (const j of Object.keys(keys)) if (j !== k) expect(overlaps(t, l.workspaces[j], GAP - 1e-6), `${what}: ${k} on ${j}`).toBe(false);
    }
    const areas = Object.entries(l.areas);
    for (const [k, a] of areas) for (const [j, b] of areas) if (j !== k) expect(overlaps(a, b, 64 - 1e-6), `${what}: ${k} and ${j}`).toBe(false);
  };
  it("puts New session here… in a full area with areas below and to the right in a new row just below its own, locked or not: the area never moves, the one below moves whole", () => {
    for (const [aLocked, bLocked] of LOCKS) {
      const what = `A ${aLocked ? "locked" : "unlocked"}, B ${bLocked ? "locked" : "unlocked"}`;
      const l = hemmed(aLocked, bLocked);
      const r = resolveLayout(l, [...hemmedShown, session("n", { taskGroup: "D" })]);
      const after = applyPatch(l, r.patch!);
      const n = after.workspaces.n;
      // just below d1, at D's left: never below what's in A
      expect([n.x, n.y], what).toEqual([AREA_PAD, 48 + 528 + GAP]);
      expect(after.areas.D, what).toMatchObject({ x: 0, y: 0, w: 2400, h: n.y + n.h + AREA_PAD });
      // A pushed down as a whole, a1 with it, its lock kept; B, clear of D's growing, stays
      const dy = after.areas.A.y - 664;
      expect([after.areas.A.x, dy > 0], what).toEqual([0, true]);
      expect(after.workspaces.a1, what).toEqual({ ...l.workspaces.a1, y: l.workspaces.a1.y + dy });
      expect(after.areas.A.locked ?? false, what).toBe(aLocked);
      expect(after.areas.B, what).toEqual(l.areas.B);
      tidy(after, { d1: "D", n: "D", a1: "A", b1: "B" }, what);
    }
  });
  it("places a right-click's workspace in the same full area by the click, neighbours locked since the dialog opened or not: the area never moves, those in the way move whole", () => {
    for (const [aLocked, bLocked] of LOCKS) {
      for (const at of [{ x: 1000, y: 500 }, { x: 2300, y: 300 }]) {
        const what = `A ${aLocked ? "locked" : "unlocked"}, B ${bLocked ? "locked" : "unlocked"}, click ${at.x},${at.y}`;
        const l = hemmed(aLocked, bLocked);
        const r = resolveLayout(l, [...hemmedShown, session("n", { taskGroup: "D", createdAt: 600 })], undefined, [], { area: "D", at, since: 500 });
        expect(r.hinted, what).toBe("n");
        const after = applyPatch(l, r.patch!);
        const n = after.workspaces.n;
        // by the click along the edge it grew from: a new row at its x, or a new column at its y
        expect(Math.abs(n.x - at.x) <= n.w && Math.abs(n.y - at.y) <= n.h, what).toBe(true);
        expect(after.areas.D, what).toMatchObject({ x: 0, y: 0 });
        for (const [k, w] of [["A", "a1"], ["B", "b1"]] as const) {
          const d = { dx: after.areas[k].x - l.areas[k].x, dy: after.areas[k].y - l.areas[k].y };
          expect(after.workspaces[w], `${what}: ${w} with ${k}`).toEqual({ ...l.workspaces[w], x: l.workspaces[w].x + d.dx, y: l.workspaces[w].y + d.dy });
          expect(after.areas[k].locked ?? false, what).toBe(k === "A" ? aLocked : bLocked);
        }
        tidy(after, { d1: "D", n: "D", a1: "A", b1: "B" }, what);
      }
    }
  });
  it("moves picked workspaces into the same full area in a new row just below its own, locked neighbours or not, pushing what's in the way whole", () => {
    for (const [aLocked, bLocked] of LOCKS) {
      const what = `A ${aLocked ? "locked" : "unlocked"}, B ${bLocked ? "locked" : "unlocked"}`;
      const l = hemmed(aLocked, bLocked);
      l.workspaces.x = { x: -1200, y: 0, w: 1000, h: 600 };
      const shown = [...hemmedShown, session("x")];
      const plan = planMakeArea(l, resolveLayout(l, shown), ["x"], "D", (k) => k);
      if ("refused" in plan) throw new Error(plan.refused);
      expect(plan.moves, what).toEqual([{ id: "x", group: "D" }]);
      const after = applyPatch(l, plan.patch!);
      expect(after.workspaces.x, what).toEqual({ x: AREA_PAD, y: 48 + 528 + GAP, w: 1000, h: 600 });
      expect(after.areas.D, what).toMatchObject({ x: 0, y: 0, w: 2400, h: 592 + 600 + AREA_PAD });
      const dy = after.areas.A.y - 664;
      expect(dy > 0 && after.workspaces.a1.y === l.workspaces.a1.y + dy, what).toBe(true);
      expect(after.areas.B, what).toEqual(l.areas.B);
      tidy(after, { d1: "D", x: "D", a1: "A", b1: "B" }, what);
    }
  });
  it("holds every area that grew in the same pass where it is, pushing from all of them together; of two that grow into each other, the one right-clicked stays", () => {
    // A, C and D stacked, each full; A gets a new session (a new row, which pushes C down into D), D a right-click's
    const stacked = (cH: number) => {
      const l = emptyLandscape();
      l.migratedAt = "2026-11-01T00:00:00.000Z";
      const dY = 664 + cH + 64;
      l.areas.A = { x: 0, y: 0, w: 2400, h: 600, repos: [] };
      l.areas.C = { x: 0, y: 664, w: 2400, h: cH, repos: [] };
      l.areas.D = { x: 0, y: dY, w: 2400, h: 600, repos: [] };
      l.workspaces.a1 = { x: 24, y: 48, w: 2352, h: 528 };
      l.workspaces.c1 = { x: 24, y: 712, w: 2352, h: cH - 72 };
      l.workspaces.d1 = { x: 24, y: dY + 48, w: 2352, h: 528 };
      const shown = [session("a1", { taskGroup: "A" }), session("c1", { taskGroup: "C" }), session("d1", { taskGroup: "D" }), session("n", { taskGroup: "D", createdAt: 600 }), session("m", { taskGroup: "A", createdAt: 600 })];
      const r = resolveLayout(l, shown, undefined, [], { area: "D", at: { x: 1000, y: dY + 500 }, since: 500 });
      expect(r.hinted).toBe("n");
      return { l, r, dY, ...placesOf(l, r) };
    };
    // A's new row reaches C, which goes on into D: A and D both stay, and C goes past D
    const far = stacked(900);
    expect(far.area("A")).toMatchObject({ x: 0, y: 0 });
    expect(far.area("D")).toMatchObject({ x: 0, y: far.dY });
    expect(far.area("A").h).toBeGreaterThan(600);
    expect(far.area("D").h).toBeGreaterThan(600);
    tidy(applyPatch(far.l, far.r.patch!), { a1: "A", m: "A", c1: "C", d1: "D", n: "D" }, "C between");
    // A's new row reaches D itself: D, right-clicked, stays, and A goes past it
    const near = stacked(600);
    expect(near.area("D")).toMatchObject({ x: 0, y: near.dY });
    expect(near.tile("n").y).toBeGreaterThan(near.dY + 48 + 528);
    tidy(applyPatch(near.l, near.r.patch!), { a1: "A", m: "A", c1: "C", d1: "D", n: "D" }, "D right below");
  });
  it("pushes a workspace in no area aside when an area grows over it, and it stays in none: in the layout, and for a gesture", () => {
    const l = emptyLandscape();
    l.migratedAt = "2026-11-01T00:00:00.000Z";
    l.areas.D = { x: 0, y: 0, w: 2400, h: 600, repos: [] };
    l.workspaces.d1 = { x: 24, y: 48, w: 2352, h: 528 };
    l.workspaces.x = { x: 24, y: 700, w: 800, h: 400 };
    // a session waiting to be resumed, its place loose below D too
    l.workspaces.gone = { x: 1000, y: 700, w: 800, h: 400 };
    const shown = [session("d1", { taskGroup: "D" }), session("x")];
    const r = resolveLayout(l, [...shown, session("n", { taskGroup: "D" })]);
    const after = applyPatch(l, r.patch!);
    expect(r.tiles.find((t) => t.key === "x")!.area).toBe(LOOSE_GROUP);
    for (const k of ["x", "gone"]) {
      expect(overlaps(after.workspaces[k], after.areas.D, GAP - 1e-6), k).toBe(false);
      expect([after.workspaces[k].x, after.workspaces[k].w, after.workspaces[k].h], k).toEqual([l.workspaces[k].x, 800, 400]);
    }
    expect(overlaps(after.workspaces.x, after.workspaces.gone, GAP - 1e-6)).toBe(false);
    // pushed just GAP clear of D, the gap for what's in no area (areas keep AREA_GAP between them)
    const clearBelow = (a: Rect) => Math.ceil((a.y + a.h + GAP) / 8) * 8;
    expect(after.workspaces.x.y).toBe(clearBelow(after.areas.D));
    // a gesture's growing: a loose workspace moved into D, which grows over the other
    const g = emptyLandscape();
    g.migratedAt = l.migratedAt;
    g.areas.D = l.areas.D;
    g.workspaces.d1 = l.workspaces.d1;
    g.workspaces.x = l.workspaces.x;
    g.workspaces.y = { x: -1200, y: 0, w: 1000, h: 600 };
    const gShown = [session("d1", { taskGroup: "D" }), session("x"), session("y")];
    const plan = planMakeArea(g, resolveLayout(g, gShown), ["y"], "D", (k) => k);
    if ("refused" in plan) throw new Error(plan.refused);
    const moved = applyPatch(g, plan.patch!);
    expect(overlaps(moved.workspaces.x, moved.areas.D, GAP - 1e-6)).toBe(false);
    expect(moved.workspaces.x.x).toBe(l.workspaces.x.x);
    expect(moved.workspaces.x.y).toBe(clearBelow(moved.areas.D));
    expect(plan.moves).toEqual([{ id: "y", group: "D" }]);
  });
  it("for a gesture, pushes what's kept in no area aside too, and each stays in none: a hidden session's place, a ghost, a tool window", () => {
    const g = emptyLandscape();
    g.migratedAt = "2026-11-01T00:00:00.000Z";
    g.areas.D = { x: 0, y: 0, w: 2400, h: 600, repos: [] };
    g.workspaces.d1 = { x: 24, y: 48, w: 2352, h: 528 };
    g.workspaces.y = { x: -1200, y: 0, w: 1000, h: 600 };
    g.workspaces.gone = { x: 24, y: 664, w: 600, h: 300 };
    g.ghosts.gh = { title: "g", agent: "claude", cwd: "/r", repoPath: null, placement: { x: 700, y: 664, w: 600, h: 300 }, group: LOOSE_GROUP, closedAt: "x" };
    // a loose workspace's window
    g.workspaces.z = { x: -2400, y: 0, w: 1000, h: 600 };
    g.tools.w = { tool: "files", docked: false, session: "z", area: null, placement: { x: 1400, y: 664, w: 400, h: 300 } };
    const shown = [session("d1", { taskGroup: "D" }), session("y"), session("z")];
    const plan = planMakeArea(g, resolveLayout(g, shown), ["y"], "D", (k) => k);
    if ("refused" in plan) throw new Error(plan.refused);
    const moved = applyPatch(g, plan.patch!);
    const placed = { gone: moved.workspaces.gone, gh: moved.ghosts.gh.placement, w: moved.tools.w.placement! };
    for (const [k, r] of Object.entries(placed)) {
      expect(overlaps(r, moved.areas.D, GAP - 1e-6), k).toBe(false);
      expect(r.y, k).toBeGreaterThan(664);
    }
    expect([placed.gone.x, placed.gh.x, placed.w.x]).toEqual([24, 700, 1400]);
    expect(moved.tools.w.area).toBeNull();
    expect(moved.ghosts.gh.group).toBe(LOOSE_GROUP);
  });
  it("moves what's kept in an area pushed by one that grew only with that area, once, whatever area it then reaches", () => {
    // D grows into C, which goes down into B: C's hidden place hc ends inside B's old rectangle, and stays C's
    const l = emptyLandscape();
    l.migratedAt = "2026-11-01T00:00:00.000Z";
    l.areas.D = { x: 0, y: 0, w: 2400, h: 600, repos: [] };
    l.areas.C = { x: 0, y: 664, w: 2400, h: 600, repos: [] };
    l.areas.B = { x: 0, y: 1328, w: 2400, h: 600, repos: [] };
    l.workspaces.d1 = { x: 24, y: 48, w: 2352, h: 528 };
    l.workspaces.c1 = { x: 24, y: 712, w: 1000, h: 528 };
    l.workspaces.hc = { x: 1100, y: 712, w: 800, h: 200 };
    l.workspaces.b1 = { x: 24, y: 1376, w: 1000, h: 528 };
    const shown = [session("d1", { taskGroup: "D" }), session("c1", { taskGroup: "C" }), session("b1", { taskGroup: "B" }), session("n", { taskGroup: "D" })];
    const after = applyPatch(l, resolveLayout(l, shown).patch!);
    const dC = after.areas.C.y - 664;
    expect(dC).toBeGreaterThan(0);
    expect(after.areas.B.y).toBeGreaterThan(1328);
    expect(after.workspaces.hc).toEqual({ ...l.workspaces.hc, y: l.workspaces.hc.y + dC });
    const c = after.areas.C;
    expect(after.workspaces.hc.y + after.workspaces.hc.h).toBeLessThanOrEqual(c.y + c.h);
  });
  it("lets what nobody sees be pushed, but never push: a forgotten session's place, a loose ghost and a hidden stack each go on past the area they're pushed into", () => {
    const at: Rect = { x: 24, y: 664, w: 800, h: 400 };
    const kinds: [string, (l: Landscape) => void, (l: Landscape) => Rect][] = [
      // no session has it any more
      ["place", (l) => void (l.workspaces.gone = at), (l) => l.workspaces.gone],
      ["ghost", (l) => void (l.ghosts.gh = { title: "g", agent: "claude", cwd: "/r", repoPath: null, placement: at, group: LOOSE_GROUP, closedAt: "x" }), (l) => l.ghosts.gh.placement],
      // no session shown is one of its tabs
      ["stack", (l) => void (l.stacks["Q/x"] = { active: "q", placement: at }), (l) => l.stacks["Q/x"].placement],
    ];
    for (const [kind, add, read] of kinds) {
      const l = emptyLandscape();
      l.migratedAt = "2026-11-01T00:00:00.000Z";
      l.areas.D = { x: 0, y: 0, w: 2400, h: 600, repos: [] };
      l.areas.B = { x: 0, y: 1800, w: 2400, h: 600, repos: [] };
      l.workspaces.d1 = { x: 24, y: 48, w: 2352, h: 528 };
      l.workspaces.b1 = { x: 24, y: 1848, w: 1000, h: 528 };
      add(l);
      const shown = [session("d1", { taskGroup: "D" }), session("b1", { taskGroup: "B" }), session("n", { taskGroup: "D" })];
      const after = applyPatch(l, resolveLayout(l, shown).patch!);
      expect(after.areas.B, kind).toEqual(l.areas.B);
      expect(after.workspaces.b1, kind).toEqual(l.workspaces.b1);
      const r = read(after);
      for (const k of ["D", "B"]) expect(overlaps(r, after.areas[k], GAP - 1e-6), `${kind} ${k}`).toBe(false);
      expect([r.x, r.w, r.h], kind).toEqual([24, 800, 400]);
    }
  });
  it("counts what's kept in an area formed in the same pass as that area's: a hidden place between a new group's workspaces stays in it as it grows", () => {
    // s1 and s2 were loose; now both are in G, with hp, a session not shown, stored between them, and n new in G
    const l = emptyLandscape();
    l.migratedAt = "2026-11-01T00:00:00.000Z";
    l.workspaces.s1 = { x: 24, y: 48, w: 1000, h: 528 };
    l.workspaces.hp = { x: 24, y: 592, w: 1000, h: 528 };
    l.workspaces.s2 = { x: 24, y: 1136, w: 1000, h: 528 };
    const shown = ["s1", "s2", "n"].map((id) => session(id, { taskGroup: "G" }));
    const layout = resolveLayout(l, shown);
    const after = applyPatch(l, layout.patch!);
    const g = after.areas.G;
    expect(g.h).toBeGreaterThan(1688);
    expect(after.workspaces.hp).toEqual(l.workspaces.hp);
    expect(after.workspaces.hp.y + after.workspaces.hp.h).toBeLessThanOrEqual(g.y + g.h);
    // a gesture on that layout reads it as G's too, and moves it along
    const plan = planMoveArea(after, resolveLayout(after, shown), "G", 0, 800, (k) => k);
    if ("refused" in plan) throw new Error(plan.refused);
    const moved = applyPatch(after, plan.patch!);
    expect(moved.workspaces.hp.y - after.workspaces.hp.y).toBe(moved.areas.G.y - g.y);
  });
  it("counts a window or a card naming an area that's gone, and a ghost whose group has no area, as loose, as they're drawn: pushed aside by an area growing into them", () => {
    const l = emptyLandscape();
    l.migratedAt = "2026-11-01T00:00:00.000Z";
    l.areas.D = { x: 0, y: 0, w: 2400, h: 600, repos: [] };
    l.workspaces.d1 = { x: 24, y: 48, w: 2352, h: 528 };
    l.workspaces.z = { x: -2400, y: 0, w: 1000, h: 600 };
    l.tools.w = { tool: "files", docked: false, session: "z", area: "Gone", placement: { x: 24, y: 664, w: 400, h: 300 } };
    l.cards.c = { area: "Gone", shelf: "area:Gone", artifact: "a1", placement: { x: 500, y: 664, w: 400, h: 300 } };
    l.ghosts.gh = { title: "g", agent: "claude", cwd: "/r", repoPath: null, placement: { x: 1000, y: 664, w: 400, h: 300 }, group: "Gone", closedAt: "x" };
    const shown = [session("d1", { taskGroup: "D" }), session("z"), session("n", { taskGroup: "D" })];
    const layout = resolveLayout(l, shown);
    expect(layout.windows.find((w) => w.id === "w")?.area).toBeNull();
    const after = applyPatch(l, layout.patch!);
    const placed = { w: after.tools.w.placement!, c: after.cards.c.placement!, gh: after.ghosts.gh.placement };
    for (const [k, r] of Object.entries(placed)) {
      expect(overlaps(r, after.areas.D, GAP - 1e-6), k).toBe(false);
      expect(r.y, k).toBeGreaterThan(664);
    }
    expect([after.tools.w.area, after.cards.c.area, after.ghosts.gh.group]).toEqual(["Gone", "Gone", "Gone"]);
  });
  it("grows a full area down for a right-clicked workspace rather than into the area beside it, locked or not", () => {
    for (const locked of [false, true]) {
      const l = emptyLandscape();
      l.migratedAt = "2026-11-01T00:00:00.000Z";
      l.areas.A = { x: 0, y: 0, w: 2400, h: 2000, repos: [] };
      l.areas.B = { x: 2464, y: 0, w: 1200, h: 600, repos: [], locked };
      l.workspaces.a1 = { x: 24, y: 48, w: 2352, h: 1928 };
      l.workspaces.b1 = { x: 2488, y: 48, w: 800, h: 528 };
      const shown = [session("a1", { taskGroup: "A" }), session("b1", { taskGroup: "B" }), session("n", { taskGroup: "A", createdAt: 600 })];
      const r = resolveLayout(l, shown, undefined, [], { area: "A", at: { x: 2000, y: 100 }, since: 500 });
      const rect = (k: string) => r.areas.find((a) => a.key === k)!.rect;
      const n = r.tiles.find((t) => t.key === "n")!.rect;
      // A stays where it is and keeps its width, growing down; B isn't pushed aside, and A isn't moved off a locked B
      expect(rect("A"), String(locked)).toMatchObject({ x: 0, y: 0, w: 2400 });
      expect(rect("A").h, String(locked)).toBeGreaterThan(2000);
      expect(rect("B"), String(locked)).toMatchObject({ x: 2464, y: 0, w: 1200, h: 600 });
      expect(n, String(locked)).toMatchObject({ x: 2400 - AREA_PAD - n.w, y: 1992 });
      expect(overlaps(rect("A"), rect("B"), 64 - 1e-6), String(locked)).toBe(false);
    }
  });
});

describe("the area selected as a whole", () => {
  it("follows a rename or a merge to the key it's under now, and is let go once its area is gone", () => {
    expect(areaSelectionNow("A", ["A", "B"], [])).toBe("A");
    // renamed, while the rename is still pending and once the layout has it under its new name
    expect(areaSelectionNow("A", ["Pathways", "B"], [{ from: "A", to: "Pathways" }])).toBe("Pathways");
    // merged into B
    expect(areaSelectionNow("A", ["B"], [{ from: "A", to: "B" }])).toBe("B");
    // removed, or renamed away with nothing pending: nothing selected that can't be seen
    expect(areaSelectionNow("A", ["B"], [])).toBeNull();
    expect(areaSelectionNow("A", ["B"], [{ from: "C", to: "A" }])).toBeNull();
    expect(areaSelectionNow("A", ["B"], [{ from: "A", to: "Gone" }])).toBeNull();
    expect(areaSelectionNow(null, ["A"], [])).toBeNull();
  });
});

describe("a window's copy of the landscape", () => {
  const state = (rev: number, l = emptyLandscape(), problems: LandscapeProblem[] = []): LandscapeState => ({ landscape: l, rev, problems });
  const area = { x: 0, y: 0, w: 100, h: 100, repos: [] };
  it("applies the next revision, keeps one it already has, and reads again after a gap", () => {
    const cur = state(3);
    const next = afterChange(cur, { rev: 4, patch: { areas: { A: area } }, problems: [] });
    expect(next?.rev).toBe(4);
    expect(next?.landscape.areas.A).toEqual(area);
    // its own update answered first
    expect(afterChange(next!, { rev: 4, patch: { areas: { A: area } }, problems: [] })).toEqual(next);
    expect(afterChange(next!, { rev: 2, patch: { areas: { B: area } }, problems: [] })).toBe(next);
    expect(afterChange(cur, { rev: 5, patch: { areas: { A: area } }, problems: [] })).toBeNull();
  });
  it("takes a whole landscape (the file read again), and problems that changed alone", () => {
    const l = emptyLandscape();
    l.migratedAt = "x";
    const save: LandscapeProblem = { kind: "save", message: "disk full", file: "f" };
    expect(afterChange(state(3), { rev: 4, patch: null, landscape: l, problems: [] })).toEqual(state(4, l));
    expect(afterChange(state(3), { rev: 3, patch: null, problems: [save] })).toEqual(state(3, emptyLandscape(), [save]));
    // a problems-only change past what it has: it missed one
    expect(afterChange(state(3), { rev: 5, patch: null, problems: [save] })).toBeNull();
  });
  it("reads again when a patch can't be applied here", () => {
    expect(afterChange(state(1), { rev: 2, patch: { stacks: { "A/x": { active: "s" } } }, problems: [] })).toBeNull();
  });
  it("takes an answer unless it's older than what it has", () => {
    expect(newer(null, state(2))).toEqual(state(2));
    expect(newer(state(5), state(2)).rev).toBe(5);
    expect(newer(state(5), state(5, emptyLandscape(), [{ kind: "save", message: "m", file: "f" }])).problems).toHaveLength(1);
  });
});

describe("reading the grid's layout in on first use", () => {
  const all: ListsLoaded = { live: true, resumable: true, remote: true };
  const loaded = (over: Partial<Landscape> = {}, problems: LandscapeProblem[] = []): LandscapeState => ({ landscape: { ...emptyLandscape(), ...over }, rev: 0, problems });
  it("waits for the landscape and for every session list, naming what it waits for", () => {
    expect(migrationStep(null, all)).toEqual({ kind: "wait", why: "the layout is loading" });
    expect(migrationStep(loaded(), { live: true, resumable: false, remote: false })).toEqual({ kind: "wait", why: "waiting for the previous run's sessions, teammates' sessions" });
    expect(migrationStep(loaded(), { live: false, resumable: true, remote: true }).kind).toBe("wait");
    expect(migrationStep(loaded(), all)).toEqual({ kind: "run" });
  });
  it("never reads it into a landscape standing in for a file with a read problem", () => {
    for (const kind of ["unreadable", "corrupt", "newer"] as const) {
      const p: LandscapeProblem = { kind, message: `${kind}!`, file: "f" };
      expect(migrationStep(loaded({}, [p]), all)).toEqual({ kind: "blocked", why: `${kind}!`, problem: p });
    }
    // a failed save, or a stand-in's changes dropped once the file read again, aren't read problems
    for (const kind of ["save", "dropped"] as const) expect(migrationStep(loaded({}, [{ kind, message: "m", file: "f" }]), all)).toEqual({ kind: "run" });
  });
  it("reads it in, and saves places, when a corrupt file was moved aside, but not when it couldn't be", () => {
    const moved: LandscapeProblem = { kind: "corrupt", message: "moved", file: "f", movedTo: "f.bad-1" };
    expect(migrationStep(loaded({}, [moved]), all)).toEqual({ kind: "run" });
    expect(readProblem(loaded({}, [moved]))).toBeUndefined();
    const stuck: LandscapeProblem = { kind: "corrupt", message: "stuck", file: "f", readOnly: true };
    expect(migrationStep(loaded({}, [stuck]), all)).toEqual({ kind: "blocked", why: "stuck", problem: stuck });
    expect(readProblem(loaded({}, [moved, stuck]))).toBe(stuck);
  });
  it("doesn't read it in again once migratedAt is set", () => {
    expect(migrationStep(loaded({ migratedAt: "2026-11-01T00:00:00.000Z" }), all)).toEqual({ kind: "done" });
    expect(migrationStep(loaded({ migratedAt: "2026-11-01T00:00:00.000Z" }), { live: false, resumable: false, remote: false })).toEqual({ kind: "done" });
  });
  it("puts a migration in as a patch that sets migratedAt and keeps what's there", () => {
    const m = emptyLandscape();
    m.migratedAt = "2026-11-02T00:00:00.000Z";
    m.areas.A = { x: 0, y: 0, w: 100, h: 100, repos: [] };
    m.workspaces.s = { x: 24, y: 48, w: 8, h: 8 };
    const cur = emptyLandscape();
    cur.ghosts.g = { title: "g", agent: "claude", cwd: "/r", repoPath: null, placement: { x: 0, y: 0, w: 8, h: 8 }, group: "A", closedAt: "x" };
    const after = applyPatch(cur, migrationPatch(m));
    expect(after.migratedAt).toBe(m.migratedAt);
    expect(after.areas).toEqual(m.areas);
    expect(after.workspaces).toEqual(m.workspaces);
    expect(after.ghosts).toEqual(cur.ghosts);
    expect(migrationStep({ landscape: after, rev: 1, problems: [] }, all)).toEqual({ kind: "done" });
  });
});

describe("what a migration read in without", () => {
  it("is nothing when it read everything there", () => {
    expect(partialMigration([], [])).toBeNull();
  });

  it("names prefs it couldn't read and prefs not in the grid's shape, and says every session is placed all the same", () => {
    const said = partialMigration(["mb.trees"], ["mb.shown isn't a list"]);
    expect(said).toMatch(/^mb\.trees couldn't be read; mb\.shown isn't a list\. Every session is on the landscape/);
  });
});
