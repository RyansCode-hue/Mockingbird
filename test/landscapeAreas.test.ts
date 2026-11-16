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
  moveTargets,
  minimapBlocks,
  minimapFit,
  planMakeArea,
  planMoveArea,
  planMoveTile,
  renamedKeys,
  areaSelectionNow,
  renameSettled,
  resolveLayout,
  sessionsOnScreen,
  shortAreaName,
  toMinimap,
  undoOf,
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
  sameLandscape,
  renameAreaPatch,
  reopenPatch,
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

  it("holds several still at once, pushing what reaches one past it, the later of two that meet past the earlier; gaps by pair", () => {
    // a pushes b, which pushes d on into c, which stays too: d goes on past c rather than moving it
    const rects = { a: area(0, 0, 1000, 500), b: area(0, 520, 1000, 300), d: area(0, 884, 1000, 100), c: area(0, 1090, 1000, 300) };
    const m = pushAside(rects, ["a", "c"]);
    expect(m.a).toBeUndefined();
    expect(m.c).toBeUndefined();
    expect(m.b && m.d).toBeTruthy();
    const at = Object.fromEntries(Object.entries(rects).map(([k, r]) => [k, m[k] ? { ...r, x: r.x + m[k].dx, y: r.y + m[k].dy } : r]));
    for (const [j, k] of [["a", "b"], ["a", "c"], ["b", "c"], ["b", "d"], ["c", "d"], ["a", "d"]]) expect(overlaps(at[j], at[k], AREA_GAP - 1e-6), `${j} and ${k}`).toBe(false);
    // two that stay and meet: the later goes past the earlier
    expect(pushAside({ a: area(0, 0, 1000, 500), b: area(0, 520, 1000, 300) }, ["b", "a"])).toEqual({ a: { dx: 0, dy: 888 } });
    // a small gap for what's in no area, the areas' own between areas
    const gap = (j: string, k: string) => (j.startsWith("area") && k.startsWith("area") ? AREA_GAP : 16);
    expect(pushAside({ area1: area(0, 0, 1000, 500), loose: area(0, 500, 200, 100), area2: area(0, 620, 1000, 300) }, "area1", gap)).toEqual({ loose: { dx: 0, dy: 20 }, area2: { dx: 0, dy: 20 } });
  });

  it("pushes a passive one (what nobody sees) aside, which then goes on past what it reaches rather than pushing it", () => {
    const gap = (j: string, k: string) => (j === "p" || k === "p" ? 16 : AREA_GAP);
    const rects = { a: area(0, 0, 1000, 500), p: area(0, 505, 200, 130), b: area(0, 640, 1000, 300) };
    expect(pushAside(rects, "a", gap, new Set(["p"]))).toEqual({ p: { dx: 0, dy: 15 + 440 } });
    // not passive, it pushes b
    expect(pushAside(rects, "a", gap).b).toBeDefined();
  });

  it("pushes a locked area like any other, the grown one staying where it is, so they all end apart", () => {
    const rects = { a: area(0, 0, 1000, 500), b: area(1020, 0, 400, 400, { locked: true }), c: area(1490, 0, 300, 300, { locked: true }) };
    const m = pushAside(rects, "a");
    expect(m.a).toBeUndefined();
    expect(m).toEqual({ b: { dx: 44, dy: 0 }, c: { dx: 38, dy: 0 } });
    const at = Object.fromEntries(Object.entries(rects).map(([k, r]) => [k, m[k] ? { ...r, x: r.x + m[k].dx, y: r.y + m[k].dy } : r]));
    for (const [j, k] of [["a", "b"], ["a", "c"], ["b", "c"]]) expect(overlaps(at[j], at[k], AREA_GAP - 1e-6), `${j} and ${k}`).toBe(false);
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

  it("folding into another area keeps its closed sessions' places and their stacks, moved into it where they sat", () => {
    const l = emptyLandscape();
    l.areas.A = area(0, 0, 2000, 1400);
    l.areas.B = area(2100, 0, 2000, 1400);
    l.workspaces.a1 = { x: 24, y: 48, w: 800, h: 600 };
    l.workspaces.g1 = { x: 900, y: 48, w: 800, h: 600 };
    l.stacks["A/old"] = { active: "g2", placement: { x: 24, y: 700, w: 800, h: 600 } };
    const closed = [session("g1", { taskGroup: "A", status: "dead" }), session("g2", { taskGroup: "A/old", status: "dead" })];
    const p = renameAreaPatch(l, "A", "B", ["a1"], closed)!;
    expect(p.workspaces).toEqual({ a1: null, g1: { x: 3000, y: 48, w: 800, h: 600 } });
    expect(p.stacks).toEqual({ "A/old": null, "B/old": { active: "g2", placement: { x: 2124, y: 700, w: 800, h: 600 } } });
    expect(p.areas).toEqual({ A: null });
    // drawn as ghosts in B once the closed sessions follow the rename
    const merged = applyPatch(l, p);
    const r = resolveLayout(merged, [session("a1", { taskGroup: "B" })], undefined, [], null, closed.map((s) => ({ ...s, taskGroup: s.taskGroup!.replace(/^A/, "B") })));
    expect(r.ghosts.map((g) => [g.key, g.area]).sort()).toEqual([["ghost:g1", "B"], ["ghost:ws:B/old", "B"]]);
  });

  it("folding into an area with no room where they sat places them as new workspaces, the area growing and pushing what's below aside", () => {
    const l = emptyLandscape();
    const M = { w: 800, h: 600 };
    l.areas.A = area(0, 0, 2 * AREA_PAD + M.w, AREA_HEADER + M.h + AREA_PAD);
    l.areas.B = area(1000, 0, 2 * AREA_PAD + M.w, AREA_HEADER + M.h + AREA_PAD);
    l.areas.C = area(1000, l.areas.B.h + AREA_GAP, 2 * AREA_PAD + M.w, AREA_HEADER + M.h + AREA_PAD);
    l.workspaces.g1 = { x: AREA_PAD, y: AREA_HEADER, ...M };
    l.workspaces.b1 = { x: 1000 + AREA_PAD, y: AREA_HEADER, ...M };
    l.workspaces.c1 = { x: 1000 + AREA_PAD, y: l.areas.C.y + AREA_HEADER, ...M };
    const p = renameAreaPatch(l, "A", "B", [], [session("g1", { taskGroup: "A", status: "dead" })])!;
    const merged = applyPatch(l, p);
    const b = merged.areas.B;
    // a new row under b1, inside B grown to hold it
    expect(merged.workspaces.g1).toEqual({ x: 1000 + AREA_PAD, y: AREA_HEADER + M.h + GAP, ...M });
    expect(inside(merged.workspaces.g1, b)).toBe(true);
    expect(overlaps(merged.workspaces.g1, merged.workspaces.b1, GAP - 1e-6)).toBe(false);
    // C pushed clear of B, its workspace with it
    expect(merged.areas.C.y).toBeGreaterThanOrEqual(b.y + b.h + AREA_GAP);
    expect(inside(merged.workspaces.c1, merged.areas.C)).toBe(true);
  });

  /** A folds into B, whose room under b1 is too little for closed session g1: B grows down over whatever's below it. */
  const growing = () => {
    const l = emptyLandscape();
    const M = { w: 800, h: 600 };
    l.areas.A = area(0, 0, 2 * AREA_PAD + M.w, AREA_HEADER + M.h + AREA_PAD);
    l.areas.B = area(1000, 0, 2 * AREA_PAD + M.w, AREA_HEADER + M.h + AREA_PAD);
    l.workspaces.g1 = { x: AREA_PAD, y: AREA_HEADER, ...M };
    l.workspaces.b1 = { x: 1000 + AREA_PAD, y: AREA_HEADER, ...M };
    return { l, M, below: { x: 1000 + AREA_PAD, y: l.areas.B.h + AREA_GAP + 8, ...M } };
  };
  const g1 = session("g1", { taskGroup: "A", status: "dead" });

  it("folding into an area that grows never brings back a place it let go: a member's or a stack's, lying in the way", () => {
    const { l, below } = growing();
    l.workspaces.a1 = below;
    l.stacks["A/api"] = { active: "a2", placement: { ...below, x: below.x + 900 } };
    const p = renameAreaPatch(l, "A", "B", ["a1"], [g1])!;
    expect(p.workspaces?.a1).toBeNull();
    expect(p.stacks?.["A/api"]).toBeNull();
    const merged = applyPatch(l, p);
    expect(Object.hasOwn(merged.workspaces, "a1")).toBe(false);
    expect(Object.hasOwn(merged.stacks, "A/api")).toBe(false);
  });

  it("folding into an area that grows pushes loose windows and cards aside, as the layout does", () => {
    const { l, below } = growing();
    l.tools.t1 = { tool: "files", docked: false, session: "x", area: null, placement: below };
    l.cards.c1 = { area: "Nowhere", shelf: "area:Nowhere", artifact: "a", placement: { ...below, x: below.x + 900 } };
    const merged = applyPatch(l, renameAreaPatch(l, "A", "B", [], [g1])!);
    const b = merged.areas.B;
    for (const r of [merged.tools.t1.placement!, merged.cards.c1.placement!]) expect(overlaps(r, b, GAP - 1e-6)).toBe(false);
    // what's named an area that isn't there is in none, as it's drawn: pushed, and not pushed if it's clear already
    expect(merged.tools.t1.placement!.y).toBeGreaterThanOrEqual(b.y + b.h + GAP);
  });

  it("folding into an area that grows moves what's in the areas it pushes by one reading of what's in them", () => {
    const { l, below } = growing();
    l.areas.C = area(below.x - AREA_PAD, below.y, 2000, 1000);
    const c = l.areas.C;
    // inside C, each by what makes it C's: where it lies, or the area it names
    l.workspaces.c1 = { x: c.x + AREA_PAD, y: c.y + AREA_HEADER, w: 400, h: 300 };
    l.stacks["C/s"] = { active: "c2", placement: { x: c.x + 500, y: c.y + AREA_HEADER, w: 400, h: 300 } };
    l.tools.t1 = { tool: "files", docked: false, session: "x", area: "C", placement: { x: c.x + 1000, y: c.y + AREA_HEADER, w: 400, h: 300 } };
    l.cards.c1 = { area: "C", shelf: "area:C", artifact: "a", placement: { x: c.x + 1500, y: c.y + AREA_HEADER, w: 400, h: 300 } };
    const merged = applyPatch(l, renameAreaPatch(l, "A", "B", [], [g1])!);
    const [dx, dy] = [merged.areas.C.x - c.x, merged.areas.C.y - c.y];
    expect(dx + dy).toBeGreaterThan(0);
    const by = (r: { x: number; y: number }, was: { x: number; y: number }) => [r.x - was.x, r.y - was.y];
    expect(by(merged.workspaces.c1, l.workspaces.c1)).toEqual([dx, dy]);
    expect(by(merged.stacks["C/s"].placement, l.stacks["C/s"].placement)).toEqual([dx, dy]);
    expect(by(merged.tools.t1.placement!, l.tools.t1.placement!)).toEqual([dx, dy]);
    expect(by(merged.cards.c1.placement!, l.cards.c1.placement!)).toEqual([dx, dy]);
  });

  it("folding into another area keeps a closed session lying inside the old one whatever its own group, as it's that area's", () => {
    const l = emptyLandscape();
    l.areas.A = area(0, 0, 2000, 900);
    l.areas.B = area(2100, 0, 2000, 900);
    l.workspaces.other = { x: 24, y: 48, w: 800, h: 600 };
    const p = renameAreaPatch(l, "A", "B", [], [session("other", { taskGroup: "G", status: "dead" })])!;
    expect(p.workspaces?.other).toEqual({ x: 2124, y: 48, w: 800, h: 600 });
    // and main asks with every closed session, of any group, and every step not started yet
    const handler = fs.readFileSync(path.join(__dirname, "../src/main/index.ts"), "utf8").split("const renameGroup = ")[1].split('handle("sessions:renameGroup"')[0];
    expect(handler).toMatch(/const closed = \[\.\.\.sessions\.resumable\(\), \.\.\.sessions\.planned\(\)\]\.map\(/);
  });

  it("folding into another area moves another group's closed stack lying inside the old one too, and lets go of one nobody's closed in", () => {
    const l = emptyLandscape();
    l.areas.A = area(0, 0, 2000, 900);
    l.areas.B = area(2100, 0, 2000, 900);
    l.stacks["G/tabs"] = { active: "g1", placement: { x: 24, y: 48, w: 800, h: 600 } };
    l.stacks["G/other"] = { active: "g2", placement: { x: 900, y: 48, w: 800, h: 600 } };
    l.stacks["G/away"] = { active: "g3", placement: { x: 5000, y: 48, w: 800, h: 600 } };
    const p = renameAreaPatch(l, "A", "B", [], [session("g1", { taskGroup: "G/tabs", status: "dead" }), session("g3", { taskGroup: "G/away", status: "dead" })])!;
    expect(p.stacks?.["G/tabs"]).toEqual({ active: "g1", placement: { x: 2124, y: 48, w: 800, h: 600 } });
    expect(p.stacks?.["G/other"]).toBeNull();
    // one lying elsewhere stays out of it
    expect(Object.hasOwn(p.stacks ?? {}, "G/away")).toBe(false);
    const merged = applyPatch(l, p);
    expect(inside(merged.stacks["G/tabs"].placement, merged.areas.B)).toBe(true);
  });

  it("folding into another area also lets go of the places of teammates' and resumable sessions inside the old one", () => {
    const l = emptyLandscape();
    l.areas.A = area(0, 0, 2000, 900);
    l.areas.B = area(2100, 0, 2000, 900);
    l.workspaces.a1 = { x: 24, y: 48, w: 800, h: 600 };
    // Nick's room session and one waiting to be resumed: main's session list names neither
    l.workspaces.n1 = { x: 900, y: 48, w: 600, h: 400 };
    l.workspaces.prev = { x: 24, y: 700, w: 400, h: 150 };
    l.workspaces.b1 = { x: 2124, y: 48, w: 800, h: 600 };
    const p = renameAreaPatch(l, "A", "B", ["a1"])!;
    expect(p.workspaces).toEqual({ a1: null, n1: null, prev: null });
    // placed again in B, they land inside it
    const merged = applyPatch(l, p);
    const r = resolveLayout(merged, [session("a1", { taskGroup: "B" }), session("b1", { taskGroup: "B" }), theirs("n1", "B")]);
    const b = r.areas.find((x) => x.key === "B")!.rect;
    for (const t of r.tiles) expect(inside(t.rect, b)).toBe(true);
  });
});

describe("Mockingbird's overdue notice (index.ts)", () => {
  it("goes as a notice under its own key, so it isn't counted as a prompt the agent was given", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/main/index.ts"), "utf8");
    const tell = src.slice(src.indexOf("function tellOverdue("), src.indexOf("\n}\n", src.indexOf("function tellOverdue(")));
    expect(tell).toContain('sessions.deliverNotice(\n      o.from,\n      "overdue",');
    expect(tell).not.toContain("deliverAgentMessage");
  });
});

describe("a closed session reopened", () => {
  const withAreas = () => {
    const l = emptyLandscape();
    l.areas.G = area(0, 0, 1000, 900);
    l.areas.B = area(1100, 0, 1000, 900);
    return l;
  };
  const inG = { x: 24, y: 48, w: 400, h: 300 };
  const inB = { x: 1124, y: 48, w: 400, h: 300 };
  const loose = { x: 5000, y: 0, w: 400, h: 300 };

  it("keeps a place inside its own area", () => {
    const l = withAreas();
    l.workspaces.s = inG;
    expect(reopenPatch(l, { id: "s", taskGroup: "G" })).toBeNull();
    l.stacks["G/tabs"] = { active: "s", placement: inG };
    expect(reopenPatch(l, { id: "s", taskGroup: "G/tabs" })).toBeNull();
  });

  it("lets go of a place in another area, so it's placed anew in its own, where dragging that takes it along", () => {
    const l = withAreas();
    l.workspaces.s = inB;
    const p = reopenPatch(l, { id: "s", taskGroup: "G" })!;
    expect(p).toEqual({ workspaces: { s: null } });
    const r = resolveLayout(applyPatch(l, p), [session("s", { taskGroup: "G" })]);
    expect(r.tiles[0].area).toBe("G");
    expect(inside(r.tiles[0].rect, r.areas.find((a) => a.key === "G")!.rect)).toBe(true);
  });

  it("lets go of a place outside its own area, a stack's too", () => {
    const l = withAreas();
    l.workspaces.s = loose;
    expect(reopenPatch(l, { id: "s", taskGroup: "G" })).toEqual({ workspaces: { s: null } });
    l.stacks["G/tabs"] = { active: "t", placement: inB };
    expect(reopenPatch(l, { id: "t", taskGroup: "G/tabs" })).toEqual({ stacks: { "G/tabs": null } });
  });

  it("with no area of its own, keeps a place that's free, for one to form round, and lets go of one inside another", () => {
    const l = withAreas();
    l.workspaces.s = loose;
    expect(reopenPatch(l, { id: "s", taskGroup: "New" })).toBeNull();
    l.workspaces.s = inB;
    expect(reopenPatch(l, { id: "s", taskGroup: "New" })).toEqual({ workspaces: { s: null } });
  });

  it("loose, keeps a place in no area, and lets go of one in an area", () => {
    const l = withAreas();
    l.workspaces.s = loose;
    expect(reopenPatch(l, { id: "s", taskGroup: null })).toBeNull();
    l.workspaces.s = inB;
    expect(reopenPatch(l, { id: "s", taskGroup: null })).toEqual({ workspaces: { s: null } });
  });

  it("with no place has nothing to let go; and main asks each time one reopens", () => {
    expect(reopenPatch(withAreas(), { id: "s", taskGroup: "G" })).toBeNull();
    // the window's Reopen and a wire's Send to a closed session both go through reopenSession
    const src = fs.readFileSync(path.join(__dirname, "../src/main/index.ts"), "utf8");
    expect(src).toMatch(/\bhandle\(\s*"sessions:relaunch"\s*,\s*\(id\)\s*=>\s*reopenSession\(id\)\s*\)/);
    expect(src).toMatch(/\breopen:\s*reopenSession\b/);
    const reopen = src.split("async function reopenSession(")[1].split("\n}\n")[0];
    expect(reopen).toContain("await sessions.relaunch(id)");
    expect(reopen).toContain("landscape.sessionReopened(info)");
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

  it("follows a chain of renames on their way: A→B then B→C all name one group", () => {
    const chain = [{ from: "A", to: "B" }, { from: "B", to: "C" }];
    expect(renamedKeys("C", chain)).toEqual(["B", "A"]);
    expect(renamedKeys("A/api", chain)).toEqual(["B/api", "C/api"]);
    expect(renamedKeys("B", chain)).toEqual(["A", "C"]);
    // back to where it began: it ends
    expect(renamedKeys("A", [{ from: "A", to: "B" }, { from: "B", to: "A" }])).toEqual(["B"]);
    expect(renamedKeys("Z", chain)).toEqual([]);
    // one into its own sub-group makes a longer key each time round: it's cut short, as this runs in a render
    const longer = renamedKeys("A", [{ from: "A/b", to: "A" }]);
    expect(longer.length).toBeGreaterThan(1);
    expect(longer.length).toBeLessThanOrEqual(32);
    // the session list has C; the landscape still has A, and its stack under A: nothing's formed, nothing's saved
    const l = emptyLandscape();
    l.areas.A = area(0, 0, 2000, 900);
    l.workspaces.s1 = { x: 24, y: 48, w: 800, h: 600 };
    l.stacks["A/api"] = { active: "s2", placement: { x: 900, y: 48, w: 800, h: 600 } };
    const r = resolveLayout(l, [session("s1", { taskGroup: "C" }), session("s2", { taskGroup: "C/api" })], undefined, chain);
    expect(r.areas.map((a) => a.key)).toEqual(["A"]);
    expect(r.tiles.map((t) => [t.key, t.area])).toEqual([["s1", "A"], ["ws:A/api", "A"]]);
    expect(r.patch).toBeNull();
    // an area selected follows it too
    expect(areaSelectionNow("A", ["C"], chain)).toBe("C");
    expect(areaSelectionNow("A", ["D"], chain)).toBeNull();
  });

  it("keeps a group renamed here in its area while the rename's changes arrive, whichever comes first, saving nothing", () => {
    const l = emptyLandscape();
    l.areas.Old = area(0, 0, 2000, 900, { collapsed: true });
    l.areas.Other = area(2100, 0, 1000, 900);
    l.workspaces.s1 = { x: 24, y: 48, w: 800, h: 600 };
    l.workspaces.n1 = { x: 24, y: 700, w: 400, h: 150 };
    l.stacks["Old/api"] = { active: "s2", placement: { x: 900, y: 48, w: 800, h: 600 } };
    l.ghosts.g = { title: "g", agent: "claude", cwd: "/r", repoPath: null, placement: { x: 500, y: 700, w: 400, h: 100 }, group: "Old", closedAt: "x" };
    l.workspaces.o1 = { x: 2124, y: 48, w: 800, h: 600 };
    const renames = [{ from: "Old", to: "New" }];
    const mine = [session("s1", { taskGroup: "New" }), session("s2", { taskGroup: "New/api" }), session("s3", { taskGroup: "New/api" }), session("o1", { taskGroup: "Other" })];
    // the session list first, a teammate's room session still under the old name: all of it stays in the old area
    const lagging = [...mine, theirs("n1", "Old")];
    const first = resolveLayout(l, lagging, undefined, renames);
    expect(first.patch).toBeNull();
    expect(first.tiles.filter((t) => t.key !== "o1").map((t) => [t.key, t.area, t.hidden])).toEqual([
      ["s1", "Old", true],
      ["ws:Old/api", "Old", true],
      ["n1", "Old", true],
    ]);
    // then main's re-keying: the same, under the new name, the teammate's still lagging
    const rekeyed = applyPatch(l, renameAreaPatch(l, "Old", "New", ["s1", "s2", "s3"])!);
    const second = resolveLayout(rekeyed, lagging, undefined, renames);
    expect(second.patch).toBeNull();
    expect(second.tiles.filter((t) => t.key !== "o1").map((t) => [t.key, t.area, t.rect])).toEqual([
      ["s1", "New", l.workspaces.s1],
      ["ws:New/api", "New", l.stacks["Old/api"].placement],
      ["n1", "New", l.workspaces.n1],
    ]);
    expect(renameSettled(renames[0], rekeyed, lagging)).toBe(false);
    // and the teammate's: settled
    const all = [...mine, theirs("n1", "New")];
    expect(resolveLayout(rekeyed, all, undefined, renames).patch).toBeNull();
    expect(renameSettled(renames[0], rekeyed, all)).toBe(true);
    // without knowing of the rename, the renamed group's own area would be formed clear of the old one, moving its
    // workspaces out and saving that over the re-keyed area: the race the pending rename prevents
    const blind = resolveLayout(l, lagging);
    expect(blind.patch?.areas?.New).toBeDefined();
    expect(inside(blind.tiles.find((t) => t.key === "s1")!.rect, l.areas.Old)).toBe(false);
  });

  it("forms the area of a group a workspace was moved to clear of the old one, which keeps its ghosts, lock and folds", () => {
    const l = emptyLandscape();
    l.areas.A = area(0, 0, 1000, 800, { locked: true, collapsed: true, repos: [{ path: "/r", base: "dev" }] });
    l.workspaces.w1 = { x: 24, y: 48, w: 800, h: 600 };
    l.ghosts.g1 = { title: "g", agent: "claude", cwd: "/r", repoPath: null, placement: { x: 24, y: 660, w: 400, h: 100 }, group: "A", closedAt: "x" };
    const r = resolveLayout(l, [session("w1", { taskGroup: "B" })]);
    expect(r.patch?.areas?.A).toBeUndefined();
    expect(r.patch?.ghosts).toBeUndefined();
    const b = r.areas.find((a) => a.key === "B")!.rect;
    expect(b.locked).toBeUndefined();
    expect(b.collapsed).toBeUndefined();
    expect(overlaps(b, l.areas.A, AREA_GAP - 1)).toBe(false);
    expect(inside(r.tiles[0].rect, b)).toBe(true);
    apart(r);
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

  it("offers Move to area's targets each with the reason a move there would be refused, tried without being made", () => {
    const l = base();
    l.areas.A.locked = true;
    l.areas.R = area(0, 2000, 2000, 900);
    l.areas.C = area(2400, 2000, 1200, 900);
    l.workspaces["n7"] = { x: 24, y: 2048, w: 800, h: 600 };
    const layout = resolveLayout(l, [...shown, theirs("n7", "R")]);
    const before = structuredClone(l);
    const targets = (picked: string[]) => Object.fromEntries(moveTargets(l, layout, picked, (k) => `area ${k}`).map((t) => [t.key, t.refused]));
    // a teammate's workspace alone: no area takes it, an open one either, each saying why as Make area would
    const theirsOnly = targets(["n7"]);
    expect(Object.keys(theirsOnly).sort()).toEqual(["A", "C", "R"]);
    for (const [k, why] of Object.entries(theirsOnly)) expect(why, k).toBe((planMakeArea(l, layout, ["n7"], k, (x) => `area ${x}`) as { refused: string }).refused);
    expect(theirsOnly.C).toMatch(/^Nothing to move/);
    expect(theirsOnly.R).toBe("They're in area R already");
    // a loose one: the locked area refuses it, the others take it
    expect(targets(["loose1"])).toEqual({ A: "area A is locked: unlock it to add workspaces", R: null, C: null });
    // nothing is moved or saved by asking
    expect(l).toEqual(before);
  });

  it("moves a workspace within its area on the grid, kept inside its padding and under its header", () => {
    const l = base();
    l.workspaces.a1 = { ...l.workspaces.a1, x: AREA_PAD + 16, y: AREA_HEADER + 16 };
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

  it("moves the places of an area's sessions waiting to be resumed with it, so one relaunched comes back inside it", () => {
    const l = base();
    l.areas.A.h += M.h + GAP;
    // `prev` (closed, to be resumed) and the stack `A/old` (none of whose sessions run) aren't shown
    l.workspaces.prev = { x: AREA_PAD, y: AREA_HEADER + M.h + GAP, ...M };
    l.stacks["A/old"] = { active: "x1", placement: { x: AREA_PAD + M.w + GAP, y: AREA_HEADER + M.h + GAP, ...M } };
    const layout = resolveLayout(l, shown);
    const p = ready(planMoveArea(l, layout, "A", 3000, 0, (k) => k));
    const moved = applyPatch(l, p.patch!);
    expect(moved.workspaces.prev).toEqual({ ...l.workspaces.prev, x: l.workspaces.prev.x + 3000 });
    expect(moved.stacks["A/old"].placement.x).toBe(l.stacks["A/old"].placement.x + 3000);
    // relaunched under its id, it's where it was in the area
    const back = resolveLayout(moved, [...shown, session("prev", { taskGroup: "A" })]);
    expect(inside(back.tiles.find((t) => t.key === "prev")!.rect, moved.areas.A)).toBe(true);
    expect(back.patch).toBeNull();
  });

  it("moves the places of sessions not shown with an area pushed aside, and joins workspaces clear of them", () => {
    const l = emptyLandscape();
    const tight = area(0, 0, 2 * AREA_PAD + M.w, AREA_HEADER + M.h + AREA_PAD);
    l.areas.A = tight;
    l.workspaces.a1 = { x: AREA_PAD, y: AREA_HEADER, ...M };
    l.areas.B = area(0, tight.h + AREA_GAP, tight.w, tight.h);
    l.workspaces.prev = { x: AREA_PAD, y: l.areas.B.y + AREA_HEADER, ...M };
    // a new session in A grows it, which pushes B with the place `prev` keeps in it
    const r = resolveLayout(l, [session("a1", { taskGroup: "A" }), session("a2", { taskGroup: "A" })]);
    const b = r.areas.find((x) => x.key === "B")!.rect;
    expect(r.patch?.workspaces?.prev).toBeDefined();
    expect(inside(r.patch!.workspaces!.prev!, b)).toBe(true);
    // joining B: placed clear of `prev`'s place, which stays taken
    const l2 = emptyLandscape();
    l2.areas.B = area(0, 0, 2 * AREA_PAD + 2 * M.w + GAP, AREA_HEADER + M.h + AREA_PAD);
    l2.workspaces.prev = { x: AREA_PAD, y: AREA_HEADER, ...M };
    l2.workspaces.loose1 = { x: -M.w - 200, y: 0, ...M };
    const layout2 = resolveLayout(l2, [session("loose1")]);
    const p = ready(planMakeArea(l2, layout2, ["loose1"], "B", (k) => k));
    expect(overlaps(p.patch!.workspaces!.loose1!, l2.workspaces.prev)).toBe(false);
  });

  it("pushes a locked area aside as a whole, what's in it kept where it is in it: a drop that grows into one, and an area growing into one", () => {
    const l = base();
    const a = l.areas.A;
    l.areas.L = area(a.x + a.w + AREA_GAP, 0, 1000, a.h, { locked: true });
    l.workspaces.l1 = { x: l.areas.L.x + AREA_PAD, y: AREA_HEADER, ...M };
    const both = [...shown, session("l1", { taskGroup: "L" })];
    const layout = resolveLayout(l, both);
    // dropped past A's right edge: A grows into L's space, and L moves right with l1 the same way, still locked
    const drop = ready(planMoveTile(l, layout, "loose1", { x: a.x + a.w - 100, y: AREA_HEADER }, "A", (k) => `area ${k}`));
    const after = applyPatch(l, drop.patch!);
    expect(after.areas.A).toMatchObject({ x: a.x, y: a.y });
    const dx = after.areas.L.x - l.areas.L.x;
    expect(dx).toBeGreaterThan(0);
    expect(after.areas.L).toMatchObject({ y: l.areas.L.y, w: l.areas.L.w, h: l.areas.L.h, locked: true });
    expect(after.workspaces.l1).toEqual({ ...l.workspaces.l1, x: l.workspaces.l1.x + dx });
    expect(overlaps(after.areas.A, after.areas.L, AREA_GAP - 1e-6)).toBe(false);
    // a new session in a full A grows it downward, into locked L below: A stays, L moves down with l1
    l.areas.L = area(0, a.y + a.h + AREA_GAP, a.w, a.h, { locked: true });
    l.workspaces.l1 = { x: AREA_PAD, y: l.areas.L.y + AREA_HEADER, ...M };
    const grown = resolveLayout(l, [...both, session("a9", { taskGroup: "A" })]);
    apart(grown);
    const ga = grown.areas.find((x) => x.key === "A")!.rect;
    expect(ga).toMatchObject({ x: a.x, y: a.y });
    expect(ga.h).toBeGreaterThan(a.h);
    const gl = grown.areas.find((x) => x.key === "L")!.rect;
    const dy = gl.y - l.areas.L.y;
    expect(dy).toBeGreaterThan(0);
    expect(gl).toMatchObject({ x: l.areas.L.x, locked: true });
    expect(grown.tiles.find((t) => t.key === "l1")!.rect).toEqual({ ...l.workspaces.l1, y: l.workspaces.l1.y + dy });
    for (const t of grown.tiles.filter((x) => x.area === "A")) expect(inside(t.rect, ga)).toBe(true);
  });

  it("keeps a workspace dropped loose clear of a collapsed area's whole rectangle, not only its pill", () => {
    const l = base();
    l.areas.A.collapsed = true;
    const layout = resolveLayout(l, shown);
    // over A's rectangle, below its pill: areaAt doesn't see a collapsed area there, so the drop is loose
    const p = ready(planMoveTile(l, layout, "loose1", { x: AREA_PAD, y: AREA_HEADER + 40 }, "ungrouped", (k) => k));
    expect(overlaps(p.patch!.workspaces!.loose1!, l.areas.A, GAP - 1e-6)).toBe(false);
  });

  it("puts back what a plan changed when the groups couldn't be set: all of it, or the places of those not moved", () => {
    const l = base();
    l.areas.B = area(l.areas.A.w + AREA_GAP, 0, 2 * AREA_PAD + M.w, AREA_HEADER + M.h + AREA_PAD);
    const layout = resolveLayout(l, shown);
    // a drop past B's edge: places, B grown, nothing else
    const p = ready(planMakeArea(l, layout, ["loose1", "loose2"], "B", (k) => k));
    const undo = undoOf(l, p.patch!)!;
    expect(sameLandscape(applyPatch(applyPatch(l, p.patch!), undo), l)).toBe(true);
    // a new area put back is gone again
    const q = ready(planMakeArea(l, layout, ["loose1"], "Spike", (k) => k));
    expect(Object.hasOwn(applyPatch(applyPatch(l, q.patch!), undoOf(l, q.patch!)!).areas, "Spike")).toBe(false);
    // limited to the sessions not moved: only their own places
    expect(undoOf(l, p.patch!, ["loose2"])).toEqual({ workspaces: { loose2: l.workspaces.loose2 } });
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

  it("draws each area as a block in the minimap, and a block of its own only for each workspace or stack in no area", () => {
    const l = emptyLandscape();
    l.areas.A = area(0, 0, 1200, 900);
    l.areas.B = area(1300, 0, 1200, 900, { collapsed: true });
    l.workspaces.a1 = { x: 24, y: 48, w: 1000, h: 800 };
    l.workspaces.b1 = { x: 1324, y: 48, w: 1000, h: 800 };
    l.workspaces.l1 = { x: -1400, y: 0, w: 600, h: 400 };
    const r = resolveLayout(l, [session("a1", { taskGroup: "A" }), session("b1", { taskGroup: "B" }), session("l1")]);
    const looseStack = { ...r.tiles.find((t) => t.key === "l1")!, key: "ws:x/y", stack: "x/y", rect: { x: -1400, y: 480, w: 600, h: 400 } };
    const rectOf = (key: string) => r.areas.find((a) => a.key === key)!.rect;
    // a collapsed area is its pill; the workspaces in areas, folded or not, have none of their own
    expect(minimapBlocks({ ...r, tiles: [...r.tiles, looseStack] })).toEqual([
      { key: "A", loose: false, rect: rectOf("A") },
      { key: "B", loose: false, rect: { x: 1300, y: 0, w: 320, h: 48 } },
      { key: "l1", loose: true, rect: l.workspaces.l1 },
      { key: "ws:x/y", loose: true, rect: looseStack.rect },
    ]);
    // none loose: the areas only
    expect(minimapBlocks(resolveLayout(l, [session("a1", { taskGroup: "A" })])).map((b) => b.key)).toEqual(["A", "B"]);
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
    expect(c).toEqual({ working: 1, waiting: 1, idle: 0, dead: 1, workspaces: 3, closed: 0 });
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
    expect(treeCounts(tree[0].items)).toEqual({ working: 0, waiting: 1, idle: 2, dead: 0, workspaces: 2, closed: 0 });
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

  it("re-keys the area even when no window has read the landscape this run, and writes nothing when there's no file", () => {
    const dir = tempDir("landscape-rename-unread");
    const file = path.join(dir, "landscape.json");
    const saved = emptyLandscape();
    saved.areas.A = area(0, 0, 2000, 900);
    saved.workspaces.a1 = { x: 24, y: 48, w: 800, h: 600 };
    fs.writeFileSync(file, JSON.stringify(saved));
    const store = new LandscapeStore({ file, emit: () => {}, log: () => {} });
    store.groupRenamed("A", "Org", ["a1"]);
    store.flush();
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk.areas.Org).toEqual(saved.areas.A);
    expect(Object.hasOwn(onDisk.areas, "A")).toBe(false);
    const none = path.join(dir, "none.json");
    const empty = new LandscapeStore({ file: none, emit: () => {}, log: () => {} });
    empty.groupRenamed("A", "Org", []);
    empty.flush();
    expect(fs.existsSync(none)).toBe(false);
  });
});
