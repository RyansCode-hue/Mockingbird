import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  ACCENTS,
  accentOf,
  accentsOf,
  areaCamera,
  areaCounts,
  areaInView,
  areaSummary,
  contentRects,
  fitBelow,
  flightAt,
  fromMinimap,
  keysOnScreen,
  looseStop,
  minimapFit,
  planMakeArea,
  planMoveArea,
  planMoveTile,
  resolveLayout,
  sessionsOnScreen,
  shortAreaName,
  toMinimap,
  type AreaPlan,
  type ResolvedLayout,
} from "../src/renderer/landscapeModel";
import {
  AREA_GAP,
  AREA_HEADER,
  AREA_PAD,
  GAP,
  GRID,
  LOOSE_GROUP,
  applyPatch,
  areaAround,
  clearOf,
  emptyLandscape,
  overlaps,
  parseLandscape,
  presetSize,
  pushAside,
  renameAreaPatch,
  type Area,
  type Landscape,
  type Rect,
} from "../src/shared/landscape";
import type { SessionInfo } from "../src/shared/types";
import { treeCounts, treeOf } from "../src/renderer/AreaTree";
import { backupLine, presenceLine } from "../src/renderer/team/MembersMenu";
import type { TeamRoomSummary } from "../src/shared/team/types";
import type { TakeoverView } from "../src/shared/team/takeover";
import { LandscapeStore } from "../src/main/landscape";
import { tempDir } from "./helpers";

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
/** A teammate's session in room R, as team:live merges it in. */
const theirs = (id: string, group: string) =>
  session(id, { taskGroup: group, room: { roomId: "R", sessionId: id, owner: "nick", ownerName: "Nick", remote: true, live: true } as SessionInfo["room"] });

const M = presetSize("agent", "M");
const inside = (r: Rect, a: Rect) => r.x >= a.x && r.y >= a.y && r.x + r.w <= a.x + a.w && r.y + r.h <= a.y + a.h;
const onGrid = (r: Rect) => [r.x, r.y, r.w, r.h].every((v) => v % GRID === 0);
const area = (x: number, y: number, w: number, h: number, more: Partial<Area> = {}): Area => ({ x, y, w, h, repos: [], ...more });
/** No two areas come closer than AREA_GAP. */
const apart = (r: ResolvedLayout) => {
  for (const a of r.areas) for (const b of r.areas) if (a !== b) expect(overlaps(a.rect, b.rect, AREA_GAP - 1e-6), `${a.key} and ${b.key}`).toBe(false);
};
const ready = (p: AreaPlan) => {
  if ("refused" in p) throw new Error(`refused: ${p.refused}`);
  return p;
};

describe("areas' rectangles", () => {
  it("makes an area around workspaces: its padding round them, its header's band above, on the grid", () => {
    const a = areaAround([
      { x: 100, y: 100, w: 300, h: 200 },
      { x: 420, y: 100, w: 300, h: 200 },
    ])!;
    expect(a).toEqual({ x: 72, y: 48, w: 672, h: 280 });
    expect(a.x).toBeLessThanOrEqual(100 - AREA_PAD);
    expect(a.y).toBeLessThanOrEqual(100 - AREA_HEADER);
    expect(areaAround([])).toBeNull();
  });

  it("moves a rectangle the least it can to clear the others by AREA_GAP, and not at all when it's clear", () => {
    const others = [area(0, 0, 400, 300)];
    expect(clearOf({ x: 352, y: 0, w: 200, h: 200 }, others)).toEqual({ dx: 112, dy: 0 });
    expect(clearOf({ x: 600, y: 0, w: 200, h: 200 }, others)).toEqual({ dx: 0, dy: 0 });
    // a way out of one that lands on another goes on until it's clear of both, the shortest such way
    const two = [area(0, 0, 400, 300), area(480, 0, 400, 1000)];
    const r = { x: 352, y: 0, w: 200, h: 200 };
    const m = clearOf(r, two);
    const moved = { ...r, x: r.x + m.dx, y: r.y + m.dy };
    for (const o of two) expect(overlaps(moved, o, AREA_GAP - 1e-6)).toBe(false);
    expect(onGrid(moved)).toBe(true);
    expect(m).toEqual({ dx: 0, dy: -264 });
  });

  it("pushes the areas in a grown one's way right or down, whichever is shorter, and those on in turn", () => {
    const rects = { a: area(0, 0, 1000, 500), b: area(1020, 0, 400, 400), c: area(1490, 0, 300, 300), d: area(0, 2000, 100, 100) };
    expect(pushAside(rects, "a")).toEqual({ b: { dx: 44, dy: 0 }, c: { dx: 38, dy: 0 } });
    expect(pushAside({ a: area(0, 0, 100, 100), b: area(400, 0, 100, 100) }, "a")).toEqual({});
  });

  it("follows a group's rename: its area, stacks and ghosts under the new name, folded and locked as they were", () => {
    const l = emptyLandscape();
    l.areas["5101"] = area(0, 0, 2000, 900, { collapsed: true, locked: true });
    l.stacks["5101/api"] = { active: "s2", placement: { x: 24, y: 48, w: 800, h: 600 } };
    l.ghosts.g1 = { title: "g", agent: "claude", cwd: "/r", repoPath: null, placement: { x: 900, y: 48, w: 800, h: 600 }, group: "5101/api", closedAt: "x" };
    l.workspaces.s1 = { x: 900, y: 700, w: 800, h: 100 };
    const p = renameAreaPatch(l, "5101", "Org", ["s1"])!;
    expect(p.areas).toEqual({ "5101": null, Org: l.areas["5101"] });
    expect(p.stacks).toEqual({ "5101/api": null, "Org/api": l.stacks["5101/api"] });
    expect(p.ghosts?.g1?.group).toBe("Org/api");
    expect(p.workspaces).toBeUndefined();
    const saved = applyPatch(l, p);
    expect(parseLandscape(saved)).toEqual(saved);
    expect(saved.areas.Org).toEqual({ ...l.areas["5101"] });
    expect(Object.hasOwn(saved.areas, "5101")).toBe(false);
  });

  it("folds a group renamed onto another's name into that area: the old area and its sessions' places go, so they're placed there", () => {
    const l = emptyLandscape();
    l.areas.A = area(0, 0, 2000, 900);
    l.areas.B = area(2100, 0, 2000, 900);
    l.workspaces.a1 = { x: 24, y: 48, w: 800, h: 600 };
    l.stacks["A/api"] = { active: "a2", placement: { x: 900, y: 48, w: 800, h: 600 } };
    const p = renameAreaPatch(l, "A", "B", ["a1"])!;
    expect(p.areas).toEqual({ A: null });
    expect(p.workspaces).toEqual({ a1: null });
    expect(p.stacks).toEqual({ "A/api": null });
    expect(renameAreaPatch(emptyLandscape(), "A", "B", [])).toBeNull();
  });
});

describe("areas in the layout", () => {
  it("gives a group whose workspaces have places, but no area, an area around them, clear of the others", () => {
    const l = emptyLandscape();
    l.areas.A = area(0, 0, 1200, 900);
    l.workspaces.a1 = { x: 24, y: 48, w: 1000, h: 800 };
    // loose until just now, overlapping A's right edge
    l.workspaces.n1 = { x: 1100, y: 100, w: 600, h: 400 };
    l.workspaces.n2 = { x: 1720, y: 100, w: 600, h: 400 };
    const r = resolveLayout(l, [session("a1", { taskGroup: "A" }), session("n1", { taskGroup: "N" }), session("n2", { taskGroup: "N" })]);
    const n = r.areas.find((a) => a.key === "N")!.rect;
    apart(r);
    for (const id of ["n1", "n2"]) expect(inside(r.tiles.find((t) => t.key === id)!.rect, n)).toBe(true);
    // moved with its area, so both were saved where they are now
    expect(Object.keys(r.patch?.workspaces ?? {}).sort()).toEqual(["n1", "n2"]);
    expect(r.patch?.areas?.N).toEqual(n);
    const saved = applyPatch(l, r.patch!);
    expect(resolveLayout(saved, [session("a1", { taskGroup: "A" }), session("n1", { taskGroup: "N" }), session("n2", { taskGroup: "N" })]).patch).toBeNull();
  });

  it("gives a renamed group its old area and stacks, folded and locked as they were, when the rename's own change hasn't come", () => {
    const l = emptyLandscape();
    l.areas.Old = area(0, 0, 2000, 900, { collapsed: true });
    l.areas.Other = area(2100, 0, 1000, 900);
    l.workspaces.s1 = { x: 24, y: 48, w: 800, h: 600 };
    l.stacks["Old/api"] = { active: "s2", placement: { x: 900, y: 48, w: 800, h: 600 } };
    l.ghosts.g = { title: "g", agent: "claude", cwd: "/r", repoPath: null, placement: { x: 24, y: 700, w: 400, h: 100 }, group: "Old", closedAt: "x" };
    l.workspaces.o1 = { x: 2124, y: 48, w: 800, h: 600 };
    const shown = [session("s1", { taskGroup: "New" }), session("s2", { taskGroup: "New/api" }), session("s3", { taskGroup: "New/api" }), session("o1", { taskGroup: "Other" })];
    const r = resolveLayout(l, shown);
    expect(r.areas.find((a) => a.key === "New")?.rect).toEqual(l.areas.Old);
    expect(r.areas.some((a) => a.key === "Old")).toBe(false);
    expect(r.tiles.find((t) => t.key === "ws:New/api")!.rect).toEqual(l.stacks["Old/api"].placement);
    expect(r.tiles.every((t) => t.area !== "New" || t.hidden)).toBe(true);
    expect(r.patch?.areas).toEqual({ Old: null, New: l.areas.Old });
    expect(r.patch?.stacks).toEqual({ "New/api": { active: "s2", placement: l.stacks["Old/api"].placement }, "Old/api": null });
    expect(r.patch?.ghosts?.g?.group).toBe("New");
    // saved, it's settled: nothing more to save, and the rename's own change, coming after, changes nothing more
    const saved = applyPatch(l, r.patch!);
    expect(resolveLayout(saved, shown).patch).toBeNull();
    const late = renameAreaPatch(saved, "Old", "New", ["s1", "s2", "s3"]);
    expect(late === null || !late.areas).toBe(true);
  });

  it("doesn't take a stack's old place for a sub-group of the same name moved to another area", () => {
    const l = emptyLandscape();
    l.areas.A = area(0, 0, 2000, 900);
    l.areas.C = area(2100, 0, 2000, 900);
    l.workspaces.a1 = { x: 24, y: 48, w: 800, h: 600 };
    l.workspaces.c1 = { x: 2124, y: 48, w: 800, h: 600 };
    l.stacks["A/api"] = { active: "s2", placement: { x: 900, y: 48, w: 800, h: 600 } };
    const r = resolveLayout(l, [session("a1", { taskGroup: "A" }), session("c1", { taskGroup: "C" }), session("s2", { taskGroup: "C/api" }), session("s3", { taskGroup: "C/api" })]);
    const t = r.tiles.find((x) => x.key === "ws:C/api")!;
    expect(inside(t.rect, r.areas.find((a) => a.key === "C")!.rect)).toBe(true);
    expect(r.patch?.stacks?.["A/api"]).toBeUndefined();
  });

  it("moves the areas in a growing one's way aside, their workspaces and ghosts with them", () => {
    const l = emptyLandscape();
    const tight = area(0, 0, 2 * AREA_PAD + M.w, AREA_HEADER + M.h + AREA_PAD);
    l.areas.A = tight;
    l.workspaces.a1 = { x: AREA_PAD, y: AREA_HEADER, ...M };
    l.areas.B = area(0, tight.h + AREA_GAP, tight.w, tight.h);
    l.workspaces.b1 = { x: AREA_PAD, y: l.areas.B.y + AREA_HEADER, ...M };
    l.ghosts.gb = { title: "g", agent: "claude", cwd: "/r", repoPath: null, placement: { x: AREA_PAD, y: l.areas.B.y + AREA_HEADER, w: 100, h: 100 }, group: "B", closedAt: "x" };
    const r = resolveLayout(l, [session("a1", { taskGroup: "A" }), session("a2", { taskGroup: "A" }), session("b1", { taskGroup: "B" })]);
    apart(r);
    const a = r.areas.find((x) => x.key === "A")!.rect;
    expect(a.h).toBeGreaterThan(tight.h);
    const b = r.areas.find((x) => x.key === "B")!.rect;
    const [dx, dy] = [b.x - l.areas.B.x, b.y - l.areas.B.y];
    expect(dx || dy).not.toBe(0);
    const b1 = r.tiles.find((t) => t.key === "b1")!.rect;
    expect([b1.x, b1.y]).toEqual([l.workspaces.b1.x + dx, l.workspaces.b1.y + dy]);
    expect(inside(b1, b)).toBe(true);
    expect(r.patch?.workspaces?.b1).toEqual(b1);
    const g = r.patch!.ghosts!.gb!.placement;
    expect([g.x, g.y]).toEqual([l.ghosts.gb.placement.x + dx, l.ghosts.gb.placement.y + dy]);
    expect(r.patch?.areas?.B).toEqual({ x: b.x, y: b.y });
    const saved = applyPatch(l, r.patch!);
    expect(resolveLayout(saved, [session("a1", { taskGroup: "A" }), session("a2", { taskGroup: "A" }), session("b1", { taskGroup: "B" })]).patch).toBeNull();
  });

  it("hides a collapsed area's workspaces: off screen, out of a fit, never streamed; its pill fits instead", () => {
    const l = emptyLandscape();
    l.areas.A = area(0, 0, 2000, 900, { collapsed: true });
    l.workspaces.a1 = { x: 24, y: 48, w: 800, h: 600 };
    l.workspaces.loose = { x: -900, y: 0, w: 800, h: 600 };
    const r = resolveLayout(l, [session("a1", { taskGroup: "A" }), session("loose")]);
    expect(r.tiles.find((t) => t.key === "a1")!.hidden).toBe(true);
    expect(r.tiles.find((t) => t.key === "loose")!.hidden).toBe(false);
    expect(keysOnScreen(r.tiles, { x: -1000, y: -100, zoom: 0.2 }, { w: 2000, h: 1000 })).toEqual(["loose"]);
    expect(contentRects(r)).toEqual([{ x: 0, y: 0, w: 320, h: 48 }, l.workspaces.loose]);
    expect(sessionsOnScreen(r.tiles, new Set(["a1", "loose"]), null)).toEqual(["loose"]);
  });
});

describe("making and moving areas", () => {
  const base = () => {
    const l = emptyLandscape();
    l.areas.A = area(0, 0, 2 * AREA_PAD + 2 * M.w + GAP, AREA_HEADER + M.h + AREA_PAD);
    l.workspaces.a1 = { x: AREA_PAD, y: AREA_HEADER, ...M };
    l.stacks["A/api"] = { active: "a2", placement: { x: AREA_PAD + M.w + GAP, y: AREA_HEADER, ...M } };
    l.workspaces.loose1 = { x: -2 * M.w - 200, y: 0, ...M };
    l.workspaces.loose2 = { x: -M.w - 120, y: 0, ...M };
    return l;
  };
  const shown = [
    session("a1", { taskGroup: "A" }),
    session("a2", { taskGroup: "A/api" }),
    session("a3", { taskGroup: "A/api" }),
    session("loose1"),
    session("loose2"),
  ];
  const settle = (l: Landscape, p: Exclude<AreaPlan, { refused: string }>, moves = shown) => {
    let next = p.patch ? applyPatch(l, p.patch) : l;
    const groups = new Map(p.moves.map((m) => [m.id, m.group]));
    const after = moves.map((s) => (groups.has(s.id) ? { ...s, taskGroup: groups.get(s.id) ?? null } : s));
    if (p.after) next = applyPatch(next, p.after);
    return { l: next, sessions: after, r: resolveLayout(next, after) };
  };

  it("makes an area of loose workspaces around them, then sets their groups, nothing left to save", () => {
    const l = base();
    const layout = resolveLayout(l, shown);
    const p = ready(planMakeArea(l, layout, ["loose1", "loose2"], "Spike", (k) => k));
    expect(p.moves).toEqual([
      { id: "loose1", group: "Spike" },
      { id: "loose2", group: "Spike" },
    ]);
    expect(p.after).toBeNull();
    const done = settle(l, p);
    apart(done.r);
    const spike = done.r.areas.find((a) => a.key === "Spike")!.rect;
    for (const id of ["loose1", "loose2"]) expect(inside(done.r.tiles.find((t) => t.key === id)!.rect, spike)).toBe(true);
    expect(done.r.patch).toBeNull();
  });

  it("takes a stack out of its area with its tabs, letting its old key go after the sessions have moved", () => {
    const l = base();
    const layout = resolveLayout(l, shown);
    const p = ready(planMakeArea(l, layout, ["ws:A/api"], "Api", (k) => k));
    expect(p.moves).toEqual([
      { id: "a2", group: "Api/api" },
      { id: "a3", group: "Api/api" },
    ]);
    // the old key stays until its sessions have left it, so it's never placed anew meanwhile
    expect(p.patch?.stacks?.["A/api"]).toBeUndefined();
    expect(p.after).toEqual({ stacks: { "A/api": null } });
    const done = settle(l, p);
    apart(done.r);
    const api = done.r.areas.find((a) => a.key === "Api")!.rect;
    expect(inside(done.r.tiles.find((t) => t.key === "ws:Api/api")!.rect, api)).toBe(true);
    expect(Object.hasOwn(done.l.stacks, "A/api")).toBe(false);
    expect(done.r.patch).toBeNull();
  });

  it("puts workspaces joining an area that exists where it has room, growing it, as new workspaces are placed", () => {
    const l = base();
    const layout = resolveLayout(l, shown);
    const p = ready(planMakeArea(l, layout, ["loose1", "loose2"], "A", (k) => k));
    const done = settle(l, p);
    apart(done.r);
    const a = done.r.areas.find((x) => x.key === "A")!.rect;
    const tiles = done.r.tiles.filter((t) => t.area === "A");
    expect(tiles.map((t) => t.key).sort()).toEqual(["a1", "loose1", "loose2", "ws:A/api"]);
    for (const t of tiles) expect(inside(t.rect, a)).toBe(true);
    for (const t of tiles) for (const u of tiles) if (t !== u) expect(overlaps(t.rect, u.rect)).toBe(false);
    expect(a.h).toBeGreaterThan(l.areas.A.h);
    expect(done.r.patch).toBeNull();
  });

  it("leaves teammates' workspaces and locked areas' where they are, says so, and refuses when nothing's left", () => {
    const l = base();
    l.areas.A.locked = true;
    l.areas.R = area(0, 2000, 2000, 900);
    l.workspaces[ "n7" ] = { x: 24, y: 2048, w: 800, h: 600 };
    const all = [...shown, theirs("n7", "R")];
    const layout = resolveLayout(l, all);
    const p = ready(planMakeArea(l, layout, ["loose1", "a1", "n7"], "Mixed", (k) => k));
    expect(p.moves).toEqual([{ id: "loose1", group: "Mixed" }]);
    expect(p.note).toMatch(/1 teammate's workspace stays in its room; 1 in a locked area stays there/);
    expect(planMakeArea(l, layout, ["a1", "n7"], "Mixed", (k) => k)).toEqual({ refused: expect.stringMatching(/^Nothing to move/) });
    expect(planMakeArea(l, layout, ["loose1"], "A", (k) => `area ${k}`)).toEqual({ refused: "area A is locked: unlock it to add workspaces" });
    expect(planMakeArea(l, layout, ["loose1"], "", (k) => k)).toEqual({ refused: "An area needs a name" });
    expect(planMakeArea(l, layout, ["loose1"], "ungrouped", (k) => k)).toHaveProperty("refused");
    expect(planMakeArea(l, layout, ["a1"], "A", (k) => k)).toEqual({ refused: "They're in A already" });
  });

  it("moves a workspace within its area on the grid, kept inside its padding and under its header", () => {
    const l = base();
    const layout = resolveLayout(l, shown);
    const p = ready(planMoveTile(l, layout, "a1", { x: -50, y: 13 }, "A", (k) => k));
    expect(p.moves).toEqual([]);
    expect(p.patch?.workspaces?.a1).toEqual({ ...M, x: AREA_PAD, y: AREA_HEADER });
    const q = ready(planMoveTile(l, layout, "a1", { x: 61, y: 3000 }, "A", (k) => k));
    const r = q.patch!.workspaces!.a1!;
    expect(onGrid(r)).toBe(true);
    // past the bottom: the area grows to hold it
    expect(q.patch?.areas?.A?.h).toBeGreaterThanOrEqual(r.y + r.h + AREA_PAD);
  });

  it("moves a workspace dropped in another area into its group, and a stack with its tabs", () => {
    const l = base();
    l.areas.B = area(l.areas.A.w + AREA_GAP, 0, 2 * AREA_PAD + M.w, AREA_HEADER + M.h + AREA_PAD);
    const layout = resolveLayout(l, shown);
    const p = ready(planMoveTile(l, layout, "a1", { x: l.areas.B.x + 30, y: 60 }, "B", (k) => k));
    expect(p.moves).toEqual([{ id: "a1", group: "B" }]);
    const done = settle(l, p);
    apart(done.r);
    expect(inside(done.r.tiles.find((t) => t.key === "a1")!.rect, done.r.areas.find((a) => a.key === "B")!.rect)).toBe(true);
    expect(done.r.patch).toBeNull();
    const s = ready(planMoveTile(l, layout, "ws:A/api", { x: l.areas.B.x + 30, y: 60 }, "B", (k) => k));
    expect(s.moves).toEqual([
      { id: "a2", group: "B/api" },
      { id: "a3", group: "B/api" },
    ]);
    expect(s.after).toEqual({ stacks: { "A/api": null } });
    expect(settle(l, s).r.patch).toBeNull();
  });

  it("refuses a move out of or into a locked area, a teammate's to another area, and a stack going loose", () => {
    const l = base();
    l.areas.R = area(0, 2000, 2000, 900);
    l.workspaces.n7 = { x: 24, y: 2048, w: 800, h: 600 };
    const all = [...shown, theirs("n7", "R")];
    const layout = resolveLayout(l, all);
    expect(planMoveTile(l, layout, "n7", { x: 24, y: 60 }, "A", (k) => k)).toEqual({ refused: "Nick's workspace moves to another area only on their Mac" });
    // within its own area it moves, as any does
    expect(ready(planMoveTile(l, layout, "n7", { x: 400, y: 2100 }, "R", (k) => k)).moves).toEqual([]);
    expect(planMoveTile(l, layout, "ws:A/api", { x: -3000, y: 0 }, "ungrouped", (k) => k)).toHaveProperty("refused");
    l.areas.A.locked = true;
    const locked = resolveLayout(l, all);
    expect(planMoveTile(l, locked, "a1", { x: 400, y: 60 }, "A", (k) => `area ${k}`)).toEqual({ refused: "area A is locked: unlock it to move its workspaces" });
    expect(planMoveTile(l, locked, "loose1", { x: 400, y: 60 }, "A", (k) => `area ${k}`)).toEqual({ refused: "area A is locked: unlock it to add workspaces" });
  });

  it("keeps a workspace dropped loose clear of every area", () => {
    const l = base();
    const layout = resolveLayout(l, shown);
    const p = ready(planMoveTile(l, layout, "loose1", { x: -M.w / 2, y: 100 }, "ungrouped", (k) => k));
    const r = p.patch!.workspaces!.loose1!;
    expect(overlaps(r, l.areas.A, GAP - 1e-6)).toBe(false);
    expect(p.moves).toEqual([]);
  });

  it("moves an area on the grid with its workspaces and ghosts, clear of the others, and not while it's locked", () => {
    const l = base();
    l.areas.B = area(l.areas.A.w + 400, 0, 1000, 900);
    l.ghosts.g ={ title: "g", agent: "claude", cwd: "/r", repoPath: null, placement: { x: 24, y: 900, w: 100, h: 100 }, group: "A", closedAt: "x" };
    const layout = resolveLayout(l, shown);
    const p = ready(planMoveArea(l, layout, "A", 13, -21, (k) => k));
    expect(p.patch?.areas?.A).toEqual({ x: 16, y: -24 });
    expect(p.patch?.workspaces?.a1).toEqual({ ...l.workspaces.a1, x: l.workspaces.a1.x + 16, y: l.workspaces.a1.y - 24 });
    expect(p.patch?.stacks?.["A/api"]?.placement?.x).toBe(l.stacks["A/api"].placement.x + 16);
    expect(p.patch?.ghosts?.g?.placement.y).toBe(900 - 24);
    // dropped over B: pushed clear of it
    const q = ready(planMoveArea(l, layout, "A", 500, 0, (k) => k));
    expect(apartAfter(l, q)).toBe(true);
    expect(planMoveArea(l, layout, "A", 0, 3, (k) => k)).toEqual({ patch: null, moves: [], after: null });
    l.areas.A.locked = true;
    expect(planMoveArea(l, resolveLayout(l, shown), "A", 100, 0, (k) => `area ${k}`)).toEqual({ refused: "area A is locked: unlock it to move it" });
    function apartAfter(l0: Landscape, plan: Exclude<AreaPlan, { refused: string }>) {
      const n = applyPatch(l0, plan.patch!);
      return !overlaps(n.areas.A, n.areas.B, AREA_GAP - 1e-6);
    }
  });
});

describe("flying, the minimap and the switcher", () => {
  const vp = { w: 1200, h: 800 };
  it("flies with the centre on a straight line and the zoom changing by the same factor each step", () => {
    const from = { x: 0, y: 0, zoom: 1 };
    const to = { x: 4000, y: 1000, zoom: 0.25 };
    expect(flightAt(from, to, vp, 0)).toEqual(from);
    expect(flightAt(from, to, vp, 1)).toEqual(to);
    const mid = flightAt(from, to, vp, 0.5);
    expect(mid.zoom).toBeCloseTo(0.5, 10);
    const centre = (c: { x: number; y: number; zoom: number }) => ({ x: c.x + vp.w / (2 * c.zoom), y: c.y + vp.h / (2 * c.zoom) });
    expect(centre(mid).x).toBeCloseTo((centre(from).x + centre(to).x) / 2, 6);
    expect(centre(mid).y).toBeCloseTo((centre(from).y + centre(to).y) / 2, 6);
  });

  it("goes to an area whole, centred, below the switcher's strip, never past 100%", () => {
    const a = { key: "A", rect: area(1000, 500, 600, 400) };
    const cam = areaCamera(a, vp);
    expect(cam.zoom).toBe(1);
    const strip = areaCamera(a, vp, 56);
    expect(strip.zoom).toBe(1);
    // the strip's height is left above it
    expect(strip.y).toBeCloseTo(cam.y - 28, 6);
    const fit = fitBelow([area(0, 0, 4000, 2000)], vp, 56);
    expect(2000 * fit.zoom).toBeLessThanOrEqual(vp.h - 56);
    expect((0 - fit.y) * fit.zoom).toBeGreaterThanOrEqual(56 - 1e-6);
  });

  it("draws the landscape into the minimap's box and reads a press there back", () => {
    const f = minimapFit({ x: -500, y: 200, w: 5000, h: 2000 }, { w: 196, h: 124 });
    for (const p of [{ x: -500, y: 200 }, { x: 4500, y: 2200 }]) {
      const m = toMinimap(f, p);
      expect(m.x).toBeGreaterThanOrEqual(0);
      expect(m.x).toBeLessThanOrEqual(196);
      expect(m.y).toBeGreaterThanOrEqual(0);
      expect(m.y).toBeLessThanOrEqual(124);
      const back = fromMinimap(f, m);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it("knows which area most of the view shows", () => {
    const areas = [
      { key: "A", rect: area(0, 0, 1000, 800) },
      { key: "B", rect: area(1100, 0, 1000, 800) },
    ];
    expect(areaInView(areas, { x: 0, y: 0, zoom: 1 }, vp)).toBe("A");
    expect(areaInView(areas, { x: 1000, y: 0, zoom: 1 }, vp)).toBe("B");
    expect(areaInView(areas, { x: 0, y: 5000, zoom: 1 }, vp)).toBeNull();
  });

  it("makes the loose workspaces one more stop for the switcher, gone once none is loose", () => {
    const l = emptyLandscape();
    l.areas.A = area(0, 0, 1200, 900);
    l.workspaces.a1 = { x: 24, y: 48, w: 1000, h: 800 };
    l.workspaces.l1 = { x: -1400, y: 0, w: 600, h: 400 };
    l.workspaces.l2 = { x: -1400, y: 480, w: 600, h: 400 };
    const shown = [session("a1", { taskGroup: "A" }), session("l1"), session("l2")];
    const stop = looseStop(resolveLayout(l, shown).tiles);
    expect(stop).toEqual({ key: LOOSE_GROUP, rect: { x: -1400, y: 0, w: 600, h: 880, repos: [] } });
    // the switcher's current stop and its flight treat it as an area
    expect(areaInView([...resolveLayout(l, shown).areas, stop!], { x: -1500, y: 0, zoom: 1 }, vp)).toBe(LOOSE_GROUP);
    expect(areaCamera(stop!, vp, 56).zoom).toBeLessThanOrEqual(1);
    expect(looseStop(resolveLayout(l, [session("a1", { taskGroup: "A" })]).tiles)).toBeNull();
  });
});

describe("what an area says about itself", () => {
  it("keeps the same accent for the same name, one of ACCENTS, spread over names", () => {
    const keys = Array.from({ length: 24 }, (_, i) => `${5100 + i}`);
    for (const k of keys) {
      expect(accentOf(k)).toBe(accentOf(k));
      expect(accentOf(k)).toBeGreaterThanOrEqual(0);
      expect(accentOf(k)).toBeLessThan(ACCENTS);
    }
    expect(new Set(keys.map(accentOf)).size).toBeGreaterThanOrEqual(4);
  });

  it("gives the areas on a landscape different accents while there are no more than ACCENTS, the same in any order", () => {
    // 5101 and 5110 want the same colour
    expect(accentOf("5101")).toBe(accentOf("5110"));
    const keys = ["5101", "5102", "5110", "Spike", "Pathways", "Mockingbird"];
    const a = accentsOf(keys);
    expect(new Set(a.values()).size).toBe(keys.length);
    // the first by name keeps its own; the order the areas come in doesn't matter
    expect(a.get("5101")).toBe(accentOf("5101"));
    expect(accentsOf([...keys].reverse())).toEqual(a);
    // an area sorting after the others leaves their colours alone
    const more = accentsOf([...keys, "zz"]);
    for (const k of keys) expect(more.get(k)).toBe(a.get(k));
    // past ACCENTS they repeat, each still one of them
    const many = accentsOf(Array.from({ length: 9 }, (_, i) => `${6000 + i}`));
    expect([...many.values()].every((c) => c >= 0 && c < ACCENTS)).toBe(true);
  });

  it("counts its workspaces (a stack once) and this Mac's sessions' statuses, and says so in a line", () => {
    const l = emptyLandscape();
    l.areas.A = area(0, 0, 4000, 2000);
    const r = resolveLayout(l, [
      session("a1", { taskGroup: "A", status: "waiting" }),
      session("a2", { taskGroup: "A/api", status: "working" }),
      session("a3", { taskGroup: "A/api", status: "dead" }),
      theirs("n1", "A"),
    ]);
    const c = areaCounts(r.tiles, "A");
    expect(c).toEqual({ working: 1, waiting: 1, idle: 0, dead: 1, workspaces: 3 });
    expect(areaSummary(c)).toBe("1 waiting · 1 working · 1 exited · 3 workspaces");
    expect(areaSummary(c, { shared: "Shared room with Nick", workspaces: false })).toBe("Shared room with Nick · 1 waiting · 1 working · 1 exited");
    expect(shortAreaName("5101", "#5101 Org dropdowns")).toBe("#5101");
    expect(shortAreaName("Spike", "Spike")).toBe("Spike");
  });

  it("lists the area tree in the landscape's order, a stack once with its tabs, loose last", () => {
    const sessions = [session("l1"), session("b1", { taskGroup: "B" }), session("a1", { taskGroup: "A/api", status: "waiting" }), session("a2", { taskGroup: "A/api" }), session("a3", { taskGroup: "A" })];
    const tree = treeOf(sessions, ["A", "B", "Empty"]);
    expect(tree.map((g) => [g.key, g.items.map((it) => it.key)])).toEqual([
      ["A", ["ws:A/api", "a3"]],
      ["B", ["b1"]],
      ["Empty", []],
      ["ungrouped", ["l1"]],
    ]);
    expect(treeCounts(tree[0].items)).toEqual({ working: 0, waiting: 1, idle: 2, dead: 0, workspaces: 2 });
  });
});

describe("a room area's Members ▾", () => {
  const room = {
    id: "R",
    name: "5101",
    groupKey: "5101",
    members: [
      { id: "me", name: "Ryan E", self: true },
      { id: "nick", name: "Nick Smith", self: false },
      { id: "sam", name: "Sam Lee", self: false },
    ],
    online: ["nick"],
    signalingUrl: "wss://x",
    signaling: "online",
  } as TeamRoomSummary;
  it("says where each teammate is: what they're watching, or how long they've been offline", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    const views = [{ member: "nick", name: "Nick Smith", focused: "s1", shown: [] }] as never;
    const peers = [{ id: "sam", state: "offline", since: now - 2 * 3600_000 }] as never;
    expect(presenceLine(room, room.members[1], views, peers, [session("s1", { title: "Builder" })], now)).toBe("online · watching Builder");
    expect(presenceLine(room, room.members[2], views, peers, [], now)).toBe("offline 2h");
    expect(presenceLine(room, room.members[0], views, peers, [], now)).toBe("");
  });
  it("says where the room's backups go and when this Mac's newest was taken", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    const view = {
      rooms: [{ roomId: "R", toOrigin: true, consent: true, remote: "origin" }],
      sessions: [{ roomId: "R", self: true, latest: { takenAt: now - 60_000 } }],
    } as unknown as TakeoverView;
    expect(backupLine(room, view, now)).toBe("Backups go to teammates and origin · last 1m ago");
    expect(backupLine(room, { ...view, sessions: [] } as TakeoverView, now)).toBe("Backups go to teammates and origin · none of yours yet");
    expect(backupLine(room, null, now)).toBeNull();
    expect(backupLine(room, { error: "no" }, now)).toBeNull();
  });
});

describe("the landscape store following a group's rename", () => {
  it("re-keys the area once it's been read, says so to every window, and leaves a stand-in alone", () => {
    const dir = tempDir("landscape-rename");
    const file = path.join(dir, "landscape.json");
    const changes: unknown[] = [];
    const store = new LandscapeStore({ file, emit: (c) => changes.push(c), log: (context, err) => changes.push(`${context}: ${String(err)}`) });
    store.update({ areas: { A: area(0, 0, 2000, 900, { locked: true }) }, workspaces: { a1: { x: 24, y: 48, w: 800, h: 600 } } });
    const before = changes.length;
    store.groupRenamed("A", "Org", ["a1"]);
    const l = store.get().landscape;
    expect(l.areas.Org).toEqual(area(0, 0, 2000, 900, { locked: true }));
    expect(Object.hasOwn(l.areas, "A")).toBe(false);
    expect(l.workspaces.a1).toEqual({ x: 24, y: 48, w: 800, h: 600 });
    expect(changes.length).toBe(before + 1);
    // on disk too, once it's written
    store.flush();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).areas.Org).toEqual(area(0, 0, 2000, 900, { locked: true }));
    // a group with no area: nothing to change, nothing said
    const n = changes.length;
    store.groupRenamed("Nope", "Still", []);
    expect(changes.length).toBe(n);
  });
});
