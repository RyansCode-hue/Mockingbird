import { describe, expect, it } from "vitest";
import {
  GHOST_INSET,
  MOVE_EDGES,
  SNAP_PX,
  areaCounts,
  closedIn,
  forgetPatch,
  ghostDrawnHeight,
  minWorkspace,
  newStackName,
  planMoveTile,
  planResizeTo,
  planStack,
  planTidy,
  planUnstack,
  resolveLayout,
  snapRect,
  tidyRefusal,
  undoOf,
  type AreaPlan,
} from "../src/renderer/landscapeModel";
import { AREA_HEADER, AREA_PAD, GAP, GRID, LOOSE_GROUP, applyPatch, emptyLandscape, overlaps, presetSize, type Area, type Landscape, type Rect } from "../src/shared/landscape";
import type { SessionInfo } from "../src/shared/types";

// S6b: moving and resizing by hand, stacks, Tidy and ghosts — the pure rules Landscape.tsx and main.tsx carry out.

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
const theirs = (id: string, group: string) =>
  session(id, { taskGroup: group, room: { roomId: "R", sessionId: id, owner: "nick", ownerName: "Nick", remote: true, live: true } as SessionInfo["room"] });
const area = (x: number, y: number, w: number, h: number, more: Partial<Area> = {}): Area => ({ x, y, w, h, repos: [], ...more });
const M = presetSize("agent", "M");
const T = (k: string) => k;
const inside = (r: Rect, a: Rect) => r.x >= a.x && r.y >= a.y && r.x + r.w <= a.x + a.w && r.y + r.h <= a.y + a.h;
const onGrid = (r: Rect) => [r.x, r.y, r.w, r.h].every((v) => v % GRID === 0);
const ready = (p: AreaPlan) => {
  if ("refused" in p) throw new Error(`refused: ${p.refused}`);
  return p;
};
const refusal = (p: AreaPlan) => ("refused" in p ? p.refused : null);
/** A plan carried out as main.tsx does: its patch, the sessions' groups, then `after`; and the layout that results. */
const settle = (l: Landscape, p: Exclude<AreaPlan, { refused: string }>, sessions: SessionInfo[], closed: SessionInfo[] = []) => {
  let next = p.patch ? applyPatch(l, p.patch) : l;
  const groups = new Map(p.moves.map((m) => [m.id, m.group]));
  const move = (list: SessionInfo[]) => list.map((s) => (groups.has(s.id) ? { ...s, taskGroup: groups.get(s.id) ?? null } : s));
  if (p.after) next = applyPatch(next, p.after);
  const now = move(sessions);
  const shut = move(closed);
  return { l: next, sessions: now, closed: shut, r: resolveLayout(next, now, undefined, [], null, shut) };
};
/** Area A holding a1 and a2 side by side, M each; a2 made first. */
const base = () => {
  const l = emptyLandscape();
  l.areas.A = area(0, 0, 2 * AREA_PAD + 2 * M.w + GAP, AREA_HEADER + M.h + AREA_PAD);
  l.workspaces.a1 = { x: AREA_PAD, y: AREA_HEADER, ...M };
  l.workspaces.a2 = { x: AREA_PAD + M.w + GAP, y: AREA_HEADER, ...M };
  return l;
};
const two = [session("a1", { taskGroup: "A", createdAt: 2 }), session("a2", { taskGroup: "A", createdAt: 1 })];
const rectOf = (r: ReturnType<typeof resolveLayout>, key: string) => [...r.tiles, ...r.ghosts].find((t) => t.key === key)!.rect;

describe("a workspace dragged by hand", () => {
  const nb: Rect = { x: 1000, y: 200, w: 400, h: 304 };

  it("puts an edge with no neighbour near on the 8 px grid, drawing no guide", () => {
    expect(snapRect({ x: 13, y: 21, w: 400, h: 304 }, MOVE_EDGES, [], 1)).toEqual({ rect: { x: 16, y: 24, w: 400, h: 304 }, guides: [] });
  });

  it("lines an edge up with a neighbour's, or GAP beside it, within SNAP_PX on screen, drawing the line it snapped along", () => {
    const want = { x: nb.x + nb.w + GAP + 3, y: nb.y + 4, w: 400, h: 304 };
    const { rect, guides } = snapRect(want, MOVE_EDGES, [nb], 1);
    expect(rect).toEqual({ x: nb.x + nb.w + GAP, y: nb.y, w: 400, h: 304 });
    // each guide spans the neighbour and the rect along the line
    expect(guides).toEqual([
      { axis: "x", at: nb.x + nb.w + GAP, from: nb.y, to: nb.y + nb.h },
      { axis: "y", at: nb.y, from: nb.x, to: rect.x + rect.w },
    ]);
    // SNAP_PX is on screen: 20 px off at 100% is the grid's, at 25% it's within reach
    const far = { x: nb.x + nb.w + GAP + 20, y: 600, w: 400, h: 304 };
    expect(20).toBeGreaterThan(SNAP_PX);
    expect(snapRect(far, MOVE_EDGES, [nb], 1).rect.x).toBe(1440);
    expect(snapRect(far, MOVE_EDGES, [nb], 0.25).rect.x).toBe(nb.x + nb.w + GAP);
  });

  it("lines up with its area's inside edges as with a neighbour's", () => {
    const inner = { x: AREA_PAD, y: AREA_HEADER, w: 2000, h: 1000 };
    const { rect, guides } = snapRect({ x: AREA_PAD + 3, y: AREA_HEADER + 5, w: 400, h: 304 }, MOVE_EDGES, [], 1, inner);
    expect([rect.x, rect.y]).toEqual([AREA_PAD, AREA_HEADER]);
    expect(guides.map((g) => [g.axis, g.at])).toEqual([
      ["x", AREA_PAD],
      ["y", AREA_HEADER],
    ]);
  });

  it("resized: only the edges its handle moves, snapped, keeping at least the smallest workspace", () => {
    const right = { left: false, right: true, top: false, bottom: false };
    const { rect, guides } = snapRect({ x: 104, y: 104, w: nb.x - GAP - 104 + 4, h: 304 }, right, [nb], 1);
    expect(rect).toEqual({ x: 104, y: 104, w: nb.x - GAP - 104, h: 304 });
    expect(guides).toEqual([{ axis: "x", at: nb.x - GAP, from: 104, to: nb.y + nb.h }]);
    const min = minWorkspace();
    expect(snapRect({ x: 104, y: 104, w: 10, h: 304 }, right, [], 1, null, min).rect.w).toBe(min.w);
    // the top-left handle keeps the bottom-right corner
    const tl = snapRect({ x: 205, y: 301, w: 400, h: 400 }, { left: true, right: false, top: true, bottom: false }, [], 1);
    expect(tl.rect).toEqual({ x: 208, y: 304, w: 397, h: 397 });
  });
});

describe("a workspace resized", () => {
  it("pushes what it now covers aside, its own corner kept and its area grown to hold it all", () => {
    const l = base();
    const layout = resolveLayout(l, two);
    const want = { x: AREA_PAD, y: AREA_HEADER, w: M.w + 200, h: M.h };
    const p = ready(planResizeTo(l, layout, "a1", want, T));
    expect(p.patch?.workspaces?.a1).toEqual(want);
    const { r } = settle(l, p, two);
    const a1 = rectOf(r, "a1");
    const a2 = rectOf(r, "a2");
    expect(a1).toEqual(want);
    expect(overlaps(a1, a2, GAP - 1e-6)).toBe(false);
    // the shorter way: along the row, not under it
    expect(a2.y).toBe(AREA_HEADER);
    expect(inside(a2, r.areas[0].rect)).toBe(true);
    expect(onGrid(a2)).toBe(true);
    expect(r.patch).toBeNull();
  });

  it("is on the grid, at least the smallest workspace, and inside its area's padding and under its header", () => {
    const l = base();
    const p = ready(planResizeTo(l, resolveLayout(l, two), "a1", { x: -50, y: 3, w: 33, h: 21 }, T));
    const min = minWorkspace();
    expect(p.patch?.workspaces?.a1).toEqual({ x: AREA_PAD, y: AREA_HEADER, w: min.w, h: min.h });
  });

  it("is refused in a locked area and for a teammate's workspace, saying why", () => {
    const l = base();
    l.areas.A.locked = true;
    expect(refusal(planResizeTo(l, resolveLayout(l, two), "a1", { x: AREA_PAD, y: AREA_HEADER, w: M.w + 200, h: M.h }, T))).toMatch(/is locked: unlock it to resize/);
    const m = base();
    const withNick = [...two, theirs("n1", "A")];
    const layout = resolveLayout(m, withNick);
    const n1 = rectOf(layout, "n1");
    expect(refusal(planResizeTo(m, layout, "n1", { ...n1, w: n1.w + 80 }, T))).toBe("Nick's workspace is the size their terminal is");
  });

  it("loose, is kept clear of the areas", () => {
    const l = base();
    l.workspaces.l1 = { x: l.areas.A.w + 400, y: 0, ...M };
    const shown = [...two, session("l1")];
    const p = ready(planResizeTo(l, resolveLayout(l, shown), "l1", { x: l.areas.A.w - 100, y: 0, w: M.w + 100, h: M.h }, T));
    expect(overlaps(p.patch!.workspaces!.l1!, l.areas.A, GAP - 1e-6)).toBe(false);
  });
});

describe("a workspace moved onto others", () => {
  it("pushes them aside and stays where it's dropped", () => {
    const l = base();
    const layout = resolveLayout(l, two);
    const drop = { x: AREA_PAD + 160, y: AREA_HEADER };
    const p = ready(planMoveTile(l, layout, "a1", drop, "A", T));
    const { r } = settle(l, p, two);
    const a1 = rectOf(r, "a1");
    expect([a1.x, a1.y]).toEqual([drop.x, drop.y]);
    expect(overlaps(a1, rectOf(r, "a2"), GAP - 1e-6)).toBe(false);
    expect(inside(rectOf(r, "a2"), r.areas[0].rect)).toBe(true);
  });
});

describe("stacking workspaces (⌘G)", () => {
  const three = [...two, session("a3", { taskGroup: "A", createdAt: 3 })];
  const base3 = () => {
    const l = base();
    l.areas.A.h += M.h + GAP;
    l.workspaces.a3 = { x: AREA_PAD, y: AREA_HEADER + M.h + GAP, ...M };
    return l;
  };

  it("makes a stack of them where the first of them was, its session in front, the others' places let go", () => {
    const l = base3();
    const p = ready(planStack(l, resolveLayout(l, three), ["a2", "a1"], T));
    expect(p.patch?.stacks?.["A/tabs"]).toEqual({ active: "a1", placement: l.workspaces.a1 });
    expect(p.moves).toEqual([
      { id: "a1", group: "A/tabs" },
      { id: "a2", group: "A/tabs" },
    ]);
    expect(p.after).toEqual({ workspaces: { a1: null, a2: null } });
    const { r } = settle(l, p, three);
    const st = r.tiles.find((t) => t.stack === "A/tabs")!;
    expect(st.members.map((m) => m.id).sort()).toEqual(["a1", "a2"]);
    expect([st.front.id, st.rect]).toEqual(["a1", l.workspaces.a1]);
    expect(rectOf(r, "a3")).toEqual(l.workspaces.a3);
  });

  it("puts more into a stack picked with them, its closed tabs staying with it", () => {
    const l = base3();
    l.stacks["A/api"] = { active: "a1", placement: l.workspaces.a1 };
    const shown = three.map((s) => (s.id === "a1" || s.id === "a2" ? { ...s, taskGroup: "A/api" } : s));
    const closed = [session("c1", { taskGroup: "A/api", status: "dead" })];
    const layout = resolveLayout(l, shown, undefined, [], null, closed);
    expect(layout.tiles.find((t) => t.stack === "A/api")!.closed?.map((s) => s.id)).toEqual(["c1"]);
    const p = ready(planStack(l, layout, ["a3", "ws:A/api"], T));
    expect(p.patch).toBeNull();
    expect(p.moves).toEqual([{ id: "a3", group: "A/api" }]);
    expect(p.after).toEqual({ workspaces: { a3: null } });
  });

  it("names a new stack apart from the area's others", () => {
    const l = base3();
    l.stacks["A/tabs"] = { active: "a1", placement: l.workspaces.a1 };
    expect(newStackName(l, resolveLayout(l, three), "A")).toBe("tabs-2");
    expect(newStackName(l, resolveLayout(l, three), "B")).toBe("tabs");
  });

  it("is refused for one, across areas, loose, or in a locked area; a teammate's stays out, saying so", () => {
    const l = base3();
    l.areas.B = area(0, l.areas.A.h + 200, 2 * AREA_PAD + M.w, AREA_HEADER + M.h + AREA_PAD);
    l.workspaces.b1 = { x: AREA_PAD, y: l.areas.B.y + AREA_HEADER, ...M };
    l.workspaces.l1 = { x: -M.w - 400, y: 0, ...M };
    const shown = [...three, session("b1", { taskGroup: "B" }), session("l1")];
    const layout = resolveLayout(l, shown);
    expect(refusal(planStack(l, layout, ["a1"], T))).toBe("Pick two or more workspaces to stack them");
    expect(refusal(planStack(l, layout, ["a1", "b1"], T))).toMatch(/different areas/);
    expect(refusal(planStack(l, layout, ["a1", "l1"], T))).toMatch(/A stack is part of an area/);
    l.areas.A.locked = true;
    expect(refusal(planStack(l, resolveLayout(l, shown), ["a1", "a2"], T))).toMatch(/is locked: unlock it to stack/);
    const m = base3();
    const withNick = [...three, theirs("n1", "A")];
    const p = ready(planStack(m, resolveLayout(m, withNick), ["a1", "a2", "n1"], T));
    expect(p.moves.map((x) => x.id)).toEqual(["a1", "a2"]);
    expect(p.note).toMatch(/1 teammate's workspace stays out of the stack/);
  });
});

describe("a tab dragged out of its stack", () => {
  const tabs = (ids: string[]) => ids.map((id, i) => session(id, { taskGroup: "A/tabs", createdAt: i }));
  const withStack = () => {
    const l = emptyLandscape();
    l.areas.A = area(0, 0, 2 * AREA_PAD + 2 * M.w + GAP, AREA_HEADER + M.h + AREA_PAD);
    l.stacks["A/tabs"] = { active: "t1", placement: { x: AREA_PAD, y: AREA_HEADER, ...M } };
    return l;
  };

  it("becomes a workspace of the area where it's dropped, the stack keeping the rest", () => {
    const l = withStack();
    const shown = tabs(["t1", "t2", "t3"]);
    const at = { x: AREA_PAD + M.w + GAP, y: AREA_HEADER };
    const p = ready(planUnstack(l, resolveLayout(l, shown), "t2", at, "A", T));
    expect(p.moves).toEqual([{ id: "t2", group: "A" }]);
    const { r } = settle(l, p, shown);
    expect(rectOf(r, "t2")).toEqual({ ...at, ...M });
    const st = r.tiles.find((t) => t.stack === "A/tabs")!;
    expect([st.front.id, st.members.map((m) => m.id)]).toEqual(["t1", ["t1", "t3"]]);
  });

  it("brings another tab to the front when the front one leaves", () => {
    const l = withStack();
    const shown = tabs(["t1", "t2", "t3"]);
    const p = ready(planUnstack(l, resolveLayout(l, shown), "t1", { x: AREA_PAD + M.w + GAP, y: AREA_HEADER }, "A", T));
    expect(p.patch?.stacks?.["A/tabs"]?.active).toBe("t2");
  });

  it("leaves a stack of one no stack: its last tab takes the stack's place, its closed tabs going with it", () => {
    const l = withStack();
    const shown = tabs(["t1", "t2"]);
    const closed = [session("c1", { taskGroup: "A/tabs", status: "dead" })];
    const p = ready(planUnstack(l, resolveLayout(l, shown, undefined, [], null, closed), "t2", { x: AREA_PAD + M.w + GAP, y: AREA_HEADER }, "A", T));
    expect(p.moves).toEqual([
      { id: "t2", group: "A" },
      { id: "t1", group: "A" },
      { id: "c1", group: "A" },
    ]);
    expect(p.after).toEqual({ stacks: { "A/tabs": null } });
    const { r } = settle(l, p, shown, closed);
    expect(r.tiles.some((t) => t.stack)).toBe(false);
    expect(rectOf(r, "t1")).toEqual({ x: AREA_PAD, y: AREA_HEADER, ...M });
  });

  it("dropped over its own stack, pushes the stack (or its last tab) aside, never landing on it", () => {
    for (const ids of [["t1", "t2", "t3"], ["t1", "t2"]]) {
      const l = withStack();
      const shown = tabs(ids);
      const at = { x: AREA_PAD + 160, y: AREA_HEADER + 80 };
      const p = ready(planUnstack(l, resolveLayout(l, shown), "t2", at, "A", T));
      const { r } = settle(l, p, shown);
      const rest = r.tiles.find((t) => t.key !== "t2")!;
      expect([ids.length, overlaps(rectOf(r, "t2"), rest.rect, GAP - 1e-6)]).toEqual([ids.length, false]);
      expect([rectOf(r, "t2").x, rectOf(r, "t2").y]).toEqual([at.x, at.y]);
    }
  });

  it("is refused loose, in a locked area, or for a teammate's tab", () => {
    const l = withStack();
    const shown = [...tabs(["t1", "t2"]), theirs("n1", "A/tabs")];
    const layout = resolveLayout(l, shown);
    expect(refusal(planUnstack(l, layout, "t2", { x: -2000, y: 0 }, LOOSE_GROUP, T))).toMatch(/stays in an area/);
    expect(refusal(planUnstack(l, layout, "n1", { x: AREA_PAD, y: AREA_HEADER }, "A", T))).toMatch(/Nick's session leaves the stack only on their Mac/);
    l.areas.A.locked = true;
    expect(refusal(planUnstack(l, resolveLayout(l, shown), "t2", { x: AREA_PAD, y: AREA_HEADER }, "A", T))).toMatch(/is locked/);
  });
});

describe("Tidy", () => {
  /** Area A, wide enough for two M in a row, holding three placed against the order they were made. */
  const messy = () => {
    const l = emptyLandscape();
    l.areas.A = area(0, 0, 2 * AREA_PAD + 2 * M.w + GAP, AREA_HEADER + 3 * M.h + 2 * GAP + AREA_PAD + 400);
    l.workspaces.a3 = { x: AREA_PAD, y: AREA_HEADER, ...M };
    l.workspaces.a1 = { x: AREA_PAD + M.w + GAP, y: AREA_HEADER + 400, ...M };
    l.workspaces.a2 = { x: AREA_PAD, y: AREA_HEADER + M.h + GAP + 400, ...M };
    return l;
  };
  const made = [session("a1", { taskGroup: "A", createdAt: 1 }), session("a2", { taskGroup: "A", createdAt: 2 }), session("a3", { taskGroup: "A", createdAt: 3 })];

  it("packs an area's workspaces in rows in the order they were made, the area fitting them, and Undo puts every place back", () => {
    const l = messy();
    const p = ready(planTidy(l, resolveLayout(l, made), "A", T));
    const { l: tidied, r } = settle(l, p, made);
    expect(rectOf(r, "a1")).toEqual({ x: AREA_PAD, y: AREA_HEADER, ...M });
    expect(rectOf(r, "a2")).toEqual({ x: AREA_PAD + M.w + GAP, y: AREA_HEADER, ...M });
    expect(rectOf(r, "a3")).toEqual({ x: AREA_PAD, y: AREA_HEADER + M.h + GAP, ...M });
    expect(r.areas[0].rect.h).toBe(AREA_HEADER + 2 * M.h + GAP + AREA_PAD);
    const back = undoOf(l, p.patch!)!;
    const undone = applyPatch(tidied, back);
    expect(undone.workspaces).toEqual(l.workspaces);
    expect(undone.areas.A).toEqual(l.areas.A);
  });

  it("packs a ghost by when its session was made, as a workspace", () => {
    const l = messy();
    const shown = made.filter((s) => s.id !== "a2");
    const closed = [{ ...made[1], status: "dead" as const }];
    const p = ready(planTidy(l, resolveLayout(l, shown, undefined, [], null, closed), "A", T));
    const { r } = settle(l, p, shown, closed);
    expect(rectOf(r, "ghost:a2")).toEqual({ x: AREA_PAD + M.w + GAP, y: AREA_HEADER, ...M });
  });

  it("is refused for a locked, collapsed or empty area, saying why", () => {
    const l = messy();
    l.areas.A.locked = true;
    expect(tidyRefusal(resolveLayout(l, made), "A", T)).toBe("A is locked: unlock it to tidy it");
    l.areas.A.locked = false;
    l.areas.A.collapsed = true;
    expect(tidyRefusal(resolveLayout(l, made), "A", T)).toBe("A is collapsed: open it to tidy it");
    const e = emptyLandscape();
    e.areas.E = area(0, 0, 800, 600);
    expect(tidyRefusal(resolveLayout(e, []), "E", T)).toBe("E has no workspaces to tidy");
    expect(refusal(planTidy(e, resolveLayout(e, []), "E", T))).toBe("E has no workspaces to tidy");
  });
});

describe("ghosts", () => {
  it("are closed sessions drawn at their kept places, apart from the workspaces, and counted as closed", () => {
    const l = base();
    const closed = [{ ...two[1], status: "dead" as const }];
    const r = resolveLayout(l, [two[0]], undefined, [], null, closed);
    expect(r.tiles.map((t) => t.key)).toEqual(["a1"]);
    expect(r.ghosts.map((g) => [g.key, g.area, g.rect])).toEqual([["ghost:a2", "A", l.workspaces.a2]]);
    expect(areaCounts(r.tiles, "A", r.ghosts)).toMatchObject({ workspaces: 1, closed: 1 });
    expect(closedIn(r, "A").map((s) => s.id)).toEqual(["a2"]);
    expect(closedIn(r, null).map((s) => s.id)).toEqual(["a2"]);
    expect(closedIn(r, LOOSE_GROUP)).toEqual([]);
  });

  it("are placed when they have no place, loose ones too, and saved there", () => {
    const l = base();
    const r = resolveLayout(l, two, undefined, [], null, [session("p1", { status: "dead" })]);
    const g = r.ghosts.find((x) => x.key === "ghost:p1")!;
    expect(g.area).toBe(LOOSE_GROUP);
    expect(r.patch?.workspaces?.p1).toEqual(g.rect);
    expect(overlaps(g.rect, l.areas.A, GAP - 1e-6)).toBe(false);
  });

  it("are pushed aside by a workspace grown over them, never pushing", () => {
    const l = base();
    const closed = [{ ...two[1], status: "dead" as const }];
    const layout = resolveLayout(l, [two[0]], undefined, [], null, closed);
    const want = { x: AREA_PAD, y: AREA_HEADER, w: M.w + 200, h: M.h };
    const p = ready(planResizeTo(l, layout, "a1", want, T));
    const { r } = settle(l, p, [two[0]], closed);
    expect(rectOf(r, "a1")).toEqual(want);
    expect(overlaps(rectOf(r, "a1"), rectOf(r, "ghost:a2"))).toBe(false);
  });

  it("taken over by a fresh session in the same spot (Start fresh) aren't drawn, the new one taking their place exactly", () => {
    const l = base();
    const closed = [{ ...two[1], status: "dead" as const }];
    const fresh = session("f1", { taskGroup: "A", createdAt: 10 });
    const hint = { area: "A", at: { x: 0, y: 0 }, since: 5, replaces: "a2" };
    const r = resolveLayout(l, [two[0], fresh], undefined, [], hint, closed);
    expect(r.ghosts).toEqual([]);
    expect(rectOf(r, "f1")).toEqual(l.workspaces.a2);
  });

  it("forgotten let their places go, and a stack's when every tab of it is forgotten", () => {
    const l = base();
    l.stacks["A/old"] = { active: "o1", placement: { x: AREA_PAD, y: AREA_HEADER + M.h + GAP, ...M } };
    const closed = [{ ...two[1], status: "dead" as const }, session("o1", { taskGroup: "A/old", status: "dead" }), session("o2", { taskGroup: "A/old", status: "dead" })];
    const r = resolveLayout(l, [two[0]], undefined, [], null, closed);
    expect(forgetPatch(l, r, ["a2"])).toEqual({ workspaces: { a2: null } });
    expect(forgetPatch(l, r, ["o1"])).toBeNull();
    expect(forgetPatch(l, r, ["o1", "o2"])).toEqual({ stacks: { "A/old": null } });
  });

  it("zoomed out, keep their foot clear of the next area's name line, unless that leaves too little of them", () => {
    const z = 0.1;
    const rect = { x: 0, y: 0, w: 1000, h: 800 };
    expect(ghostDrawnHeight(rect, z, [])).toBe(800);
    // a name line, 28 px on screen, reaching 100 px (landscape) up into the ghost's foot
    const name = { x: 0, y: 700, w: 1000, h: 280 };
    const h = ghostDrawnHeight(rect, z, [name]);
    // drawn GHOST_INSET in from that height, its foot 4 px on screen clear of the name line
    expect(rect.y + h - GHOST_INSET / z).toBeCloseTo(name.y - 4 / z, 6);
    // one beside it, or below it, changes nothing
    expect(ghostDrawnHeight(rect, z, [{ ...name, x: 1200 }])).toBe(800);
    expect(ghostDrawnHeight(rect, z, [{ ...name, y: 900 }])).toBe(800);
    // too little left of it: drawn whole, over the name line
    expect(ghostDrawnHeight(rect, z, [{ ...name, y: 120 }])).toBe(800);
  });
});
