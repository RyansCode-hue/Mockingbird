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
  contentRects,
  fitAll,
  inView,
  migrationPatch,
  migrationStep,
  nearestInDirection,
  newer,
  panBy,
  readProblem,
  resolveLayout,
  rightClickRefusal,
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
  it("grows a hemmed-in area towards an unlocked neighbour, which moves aside, never moving the area itself; refuses with both locked", () => {
    const layout = (bLocked: boolean, cLocked: boolean) => {
      const l = emptyLandscape();
      l.migratedAt = "2026-11-01T00:00:00.000Z";
      l.areas.A = { x: 0, y: 0, w: 2400, h: 2000, repos: [] };
      l.areas.B = { x: 2464, y: 0, w: 1200, h: 2000, repos: [], locked: bLocked };
      l.areas.C = { x: 0, y: 2064, w: 2400, h: 1200, repos: [], locked: cLocked };
      l.workspaces.a1 = { x: 24, y: 48, w: 2352, h: 1928 };
      const shown = [session("a1", { taskGroup: "A" }), session("n", { taskGroup: "A", createdAt: 600 })];
      const r = resolveLayout(l, shown, undefined, [], { area: "A", at: { x: 2000, y: 900 }, since: 500 });
      return { l, r, rect: (k: string) => r.areas.find((a) => a.key === k)!.rect, n: r.tiles.find((t) => t.key === "n")!.rect };
    };
    for (const [bLocked, cLocked] of [[false, false], [false, true]]) {
      const { r, rect, n } = layout(bLocked, cLocked);
      const what = `B ${bLocked ? "locked" : "unlocked"}, C ${cLocked ? "locked" : "unlocked"}`;
      // by the click, growing A right; B moves aside, keeping the gap; A and C stay where they are
      expect(n, what).toMatchObject({ x: 2392, y: 904 });
      expect(rect("A"), what).toMatchObject({ x: 0, y: 0, h: 2000 });
      expect(rect("B").x, what).toBe(rect("A").x + rect("A").w + 64);
      expect(rect("C"), what).toMatchObject({ x: 0, y: 2064 });
      expect(r.hintRefused, what).toBeNull();
    }
    // both locked: no way out, said (main.tsx's right-click asks this first and makes nothing)
    expect(layout(true, true).r.hintRefused).toEqual({ area: "A", lockedBy: ["B", "C"] });
    const a1 = [session("a1", { taskGroup: "A" })];
    expect(rightClickRefusal(layout(true, true).l, a1, [], "A", { x: 2000, y: 900 }, false)).toEqual(["B", "C"]);
    expect(rightClickRefusal(layout(true, true).l, a1, [], "A", { x: 2000, y: 900 }, true)).toEqual(["B", "C"]);
    expect(rightClickRefusal(layout(false, true).l, a1, [], "A", { x: 2000, y: 900 }, false)).toBeNull();
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
