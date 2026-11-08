import { describe, expect, it } from "vitest";
import {
  GHOST_INSET,
  MOVE_EDGES,
  SNAP_PX,
  areaCounts,
  closedIn,
  closedListOf,
  forgetPatch,
  ghostDrawnHeight,
  minWorkspace,
  newStackName,
  notePlacement,
  NOTE_BOTTOM,
  planMoveArea,
  planMoveTile,
  planResizeTo,
  planStack,
  planTidy,
  planUnstack,
  renamesLeft,
  resolveLayout,
  snapRect,
  tidyRefusal,
  undoOf,
  undoOfPlan,
  withoutGone,
  type AreaPlan,
} from "../src/renderer/landscapeModel";
import { AREA_GAP, AREA_HEADER, AREA_PAD, GAP, GRID, LOOSE_GROUP, applyPatch, emptyLandscape, overlaps, presetSize, renameAreaPatch, type Area, type Landscape, type Rect } from "../src/shared/landscape";
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

  it("never snaps past its area's inside top or left: an edge there (a loose ghost's) would put it through the header", () => {
    const inner = { x: 0, y: 100, w: 1000, h: 800 };
    const ghost = { x: 500, y: 96, w: 200, h: 200 };
    const s = snapRect({ x: 100, y: 97, w: 300, h: 200 }, MOVE_EDGES, [ghost], 1, inner);
    expect(s.rect.y).toBe(inner.y);
    // without its area, it lines up with the ghost
    expect(snapRect({ x: 100, y: 97, w: 300, h: 200 }, MOVE_EDGES, [ghost], 1).rect.y).toBe(ghost.y);
    // resizing the top edge likewise
    expect(snapRect({ x: 100, y: 97, w: 300, h: 300 }, { left: false, right: false, top: true, bottom: false }, [ghost], 1, inner).rect.y).toBe(inner.y);
  });

  it("keeps to its area's inside on the plain grid too, drawn where a drop would leave it", () => {
    const inner = { x: 20, y: 100, w: 1000, h: 800 };
    const moved = snapRect({ x: -200, y: 30, w: 300, h: 200 }, MOVE_EDGES, [], 1, inner);
    expect([moved.rect.x, moved.rect.y]).toEqual([24, 104]);
    expect(moved.guides).toEqual([]);
    // its top or left edge dragged past stops there; the opposite edge stays where it was
    const resized = snapRect({ x: 100, y: 30, w: 300, h: 500 }, { left: false, right: false, top: true, bottom: false }, [], 1, inner);
    expect([resized.rect.y, resized.rect.y + resized.rect.h]).toEqual([104, 530]);
    // with no area to keep to, the grid's it
    expect(snapRect({ x: -200, y: 30, w: 300, h: 200 }, MOVE_EDGES, [], 1).rect).toMatchObject({ x: -200, y: 32 });
    // what's held while dragging is where a drop leaves it
    const l = base();
    const layout = resolveLayout(l, two);
    const a = layout.areas[0].rect;
    const held = snapRect({ ...rectOf(layout, "a2"), y: -40 }, MOVE_EDGES, [], 1, { x: a.x + AREA_PAD, y: a.y + AREA_HEADER, w: a.w - 2 * AREA_PAD, h: a.h - AREA_HEADER - AREA_PAD }).rect;
    const { r } = settle(l, ready(planMoveTile(l, layout, "a2", held, "A", T)), two);
    expect([rectOf(r, "a2").x, rectOf(r, "a2").y]).toEqual([held.x, held.y]);
  });

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

  it("dragged by its left or top edge past the area's inside edge, stops there with its opposite edge kept", () => {
    const l = base();
    const a1 = l.workspaces.a1;
    const right = a1.x + a1.w;
    const bottom = a1.y + a1.h;
    // the left handle dragged 96 px past the padding: the right edge stays put
    const wide = ready(planResizeTo(l, resolveLayout(l, two), "a1", { x: a1.x - 96, y: a1.y, w: a1.w + 96, h: a1.h }, T)).patch?.workspaces?.a1;
    expect(wide).toBeUndefined();
    const lefter = ready(planResizeTo(l, resolveLayout(l, two), "a1", { x: a1.x - 96, y: a1.y, w: a1.w + 40, h: a1.h }, T)).patch!.workspaces!.a1!;
    expect([lefter.x, lefter.x + lefter.w]).toEqual([AREA_PAD, right - 56]);
    // the top handle dragged up into the header: the bottom edge stays put
    const higher = ready(planResizeTo(l, resolveLayout(l, two), "a1", { x: a1.x, y: a1.y - 200, w: a1.w, h: a1.h + 120 }, T)).patch!.workspaces!.a1!;
    expect([higher.y, higher.y + higher.h]).toEqual([AREA_HEADER, bottom - 80]);
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

describe("an area dragged over what's in no area", () => {
  it("pushes it aside and on past any other area, moving nothing else", () => {
    const l = base();
    const a = l.areas.A;
    const end = a.x + 2800 + a.w;
    // loose, under A's right end where it lands, and a third area just past that
    l.workspaces.loose = { x: end - 500, y: AREA_HEADER, w: 400, h: 200 };
    l.areas.B = area(end + AREA_GAP, 0, 1000, 1000);
    const live = [...two, session("loose")];
    const layout = resolveLayout(l, live);
    const p = ready(planMoveArea(l, layout, "A", 2800, 0, T));
    const { r } = settle(l, p, live);
    const moved = r.areas.find((x) => x.key === "A")!.rect;
    expect(moved.x).toBe(a.x + 2800);
    const loose = rectOf(r, "loose");
    expect(overlaps(loose, moved, GAP - 1e-6)).toBe(false);
    expect(overlaps(loose, l.areas.B)).toBe(false);
    expect(r.tiles.find((t) => t.key === "loose")!.area).toBe(LOOSE_GROUP);
    // the other area stays; A's own come with it
    expect(r.areas.find((x) => x.key === "B")!.rect.x).toBe(l.areas.B.x);
    expect(rectOf(r, "a1").x).toBe(l.workspaces.a1.x + 2800);
  });
});

describe("a workspace moved onto others", () => {
  it("let go where it started has nothing to save, so nothing waits to see it land", () => {
    const l = base();
    const layout = resolveLayout(l, two);
    const none = { patch: null, moves: [], after: null };
    expect(planMoveTile(l, layout, "a1", { x: AREA_PAD, y: AREA_HEADER }, "A", T)).toEqual(none);
    // past the inside's top or left, the drop comes back to the same place
    expect(planMoveTile(l, layout, "a1", { x: AREA_PAD - 40, y: AREA_HEADER - 40 }, "A", T)).toEqual(none);
    // in another area it's a move, even at the same spot
    l.areas.B = area(l.areas.A.w + 400, 0, 1000, 1000);
    const two2 = resolveLayout(l, two);
    expect(ready(planMoveTile(l, two2, "a1", { x: AREA_PAD, y: AREA_HEADER }, "B", T)).moves).toEqual([{ id: "a1", group: "B" }]);
  });

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

  it("leaves a stack of one no stack: its last tab takes the stack's place", () => {
    const l = withStack();
    const shown = tabs(["t1", "t2"]);
    const p = ready(planUnstack(l, resolveLayout(l, shown), "t2", { x: AREA_PAD + M.w + GAP, y: AREA_HEADER }, "A", T));
    expect(p.moves).toEqual([
      { id: "t2", group: "A" },
      { id: "t1", group: "A" },
    ]);
    expect(p.after).toEqual({ stacks: { "A/tabs": null } });
    const { r } = settle(l, p, shown);
    expect(r.tiles.some((t) => t.stack)).toBe(false);
    expect(rectOf(r, "t1")).toEqual({ x: AREA_PAD, y: AREA_HEADER, ...M });
  });

  it("keeps a stack with closed tabs a stack when one running tab is left, its closed tabs in its place, not scattered", () => {
    const l = withStack();
    const shown = tabs(["t1", "t2"]);
    const closed = [session("c1", { taskGroup: "A/tabs", status: "dead" })];
    const p = ready(planUnstack(l, resolveLayout(l, shown, undefined, [], null, closed), "t2", { x: AREA_PAD + M.w + GAP, y: AREA_HEADER }, "A", T));
    expect(p.moves).toEqual([{ id: "t2", group: "A" }]);
    expect(p.after).toBeNull();
    const { r } = settle(l, p, shown, closed);
    const st = r.tiles.find((t) => t.stack === "A/tabs")!;
    expect([st.members.map((m) => m.id), st.closed?.map((c) => c.id), st.rect]).toEqual([["t1"], ["c1"], { x: AREA_PAD, y: AREA_HEADER, ...M }]);
    expect(r.ghosts).toEqual([]);
  });

  it("is put back by its Undo: the stack's entry and what it pushed, then the groups, then the tabs' own places let go, nothing saved between", () => {
    for (const ids of [["t1", "t2", "t3"], ["t1", "t2"]]) {
      const l = withStack();
      const shown = tabs(ids);
      const p = ready(planUnstack(l, resolveLayout(l, shown), "t2", { x: AREA_PAD + 160, y: AREA_HEADER + 80 }, "A", T));
      const out = settle(l, p, shown);
      // as Landscape's unstack carries Undo out: undoOfPlan's patch, the groups back, then its after
      const groups = new Map(shown.map((s) => [s.id, s.taskGroup]));
      const u = undoOfPlan(l, p);
      const moves = p.moves.map((m) => ({ id: m.id, group: groups.get(m.id) ?? null }));
      const back = settle(out.l, { patch: u.patch, moves, after: u.after }, out.sessions);
      expect([ids.length, back.l]).toEqual([ids.length, l]);
      expect(back.r.tiles.find((t) => t.stack === "A/tabs")!.members.map((m) => m.id)).toEqual(ids);
      // each step's layout, as the window renders it between them, has nothing to place and save (a two-tab stack that
      // dissolved included: its entry is back before its tabs are)
      const first = u.patch ? applyPatch(out.l, u.patch) : out.l;
      const regrouped = out.sessions.map((s) => (groups.has(s.id) ? { ...s, taskGroup: groups.get(s.id) ?? null } : s));
      expect([ids.length, resolveLayout(first, out.sessions).patch]).toEqual([ids.length, null]);
      expect([ids.length, resolveLayout(first, regrouped).patch]).toEqual([ids.length, null]);
    }
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

describe("the note over the landscape", () => {
  const view = { w: 1024, h: 760 };
  const minimap = { x: 1024 - 12 - 200, y: 760 - 12 - 130, w: 200, h: 130 };
  it("is centred in the room left of the minimap, never reaching it", () => {
    // a landscape 800 px wide (the area tree open at 1024): centred, a long note would reach over the minimap
    const narrow = { w: 800, h: 760 };
    const mm = { ...minimap, x: narrow.w - 12 - 200 };
    const at = notePlacement(narrow, { w: 700, h: 30 }, mm, null);
    expect(at.maxWidth).toBeLessThanOrEqual(mm.x - 8 - 16);
    expect(at.left + Math.min(700, at.maxWidth)).toBeLessThanOrEqual(mm.x - 8);
    expect(at.left).toBeGreaterThanOrEqual(16);
    // a short one is centred in the viewport while that's clear of the minimap
    const short = notePlacement(view, { w: 200, h: 30 }, minimap, null);
    expect(short.left).toBe((view.w - 200) / 2);
    expect(short.bottom).toBe(NOTE_BOTTOM);
  });

  it("goes above a selection bar low enough to be under it, and stays put for one higher up", () => {
    const note = { w: 300, h: 30 };
    const low = { x: 300, y: view.h - 66, w: 420, h: 38 };
    const at = notePlacement(view, note, minimap, low);
    // its bottom edge clear above the bar's top
    expect(view.h - at.bottom).toBeLessThanOrEqual(low.y - 8 + 1e-9);
    expect(notePlacement(view, note, minimap, { ...low, y: 200 }).bottom).toBe(NOTE_BOTTOM);
    // one beside it, not under it, leaves it where it is
    expect(notePlacement(view, note, minimap, { ...low, x: 10, w: 100 }).bottom).toBe(NOTE_BOTTOM);
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

  it("are only closed sessions with a place kept: one with none isn't drawn or placed, and the Closed sessions list holds it", () => {
    const l = base();
    const closed = [session("p1", { status: "dead" }), session("p2", { taskGroup: "A", status: "dead" }), session("p3", { taskGroup: "Gone", status: "dead" })];
    const r = resolveLayout(l, two, undefined, [], null, closed);
    expect(r.ghosts).toEqual([]);
    expect(r.patch).toBeNull();
    expect(r.areas.map((a) => a.key)).toEqual(["A"]);
    expect(closedListOf(closed, r).map((s) => s.id)).toEqual(["p1", "p2", "p3"]);
    // a ghost isn't listed; with no layout yet (still being read in), every closed session is
    l.workspaces.p2 = { x: AREA_PAD, y: AREA_HEADER + M.h + GAP, ...M };
    const drawn = resolveLayout(l, two, undefined, [], null, closed);
    expect(drawn.ghosts.map((g) => g.key)).toEqual(["ghost:p2"]);
    expect(closedListOf(closed, drawn).map((s) => s.id)).toEqual(["p1", "p3"]);
    expect(closedListOf(closed, null).map((s) => s.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("whose group has no area are drawn loose where they were, never making one", () => {
    const l = base();
    const at = { x: 3000, y: 0, ...M };
    l.workspaces.g1 = at;
    const r = resolveLayout(l, two, undefined, [], null, [session("g1", { taskGroup: "Gone", status: "dead" })]);
    expect(r.ghosts.map((g) => [g.key, g.area, g.rect])).toEqual([["ghost:g1", LOOSE_GROUP, at]]);
    expect(r.areas.map((a) => a.key)).toEqual(["A"]);
    expect(r.patch).toBeNull();
    expect(closedIn(r, LOOSE_GROUP).map((s) => s.id)).toEqual(["g1"]);
  });

  it("are in the area they lie in: loose ones stay put when their group's area forms, and one inside another area is that area's", () => {
    const l = base();
    // g1 loose far right; G's running workspace g0 has a place but no area yet, and its area would form over there
    l.workspaces.g0 = { x: 4000, y: 2000, ...M };
    const loose = { x: 6000, y: 0, ...M };
    l.workspaces.g1 = loose;
    // h1, in group G too, lies inside A
    l.areas.A.h += M.h + GAP;
    l.workspaces.h1 = { x: AREA_PAD, y: AREA_HEADER + M.h + GAP, ...M };
    const live = [...two, session("g0", { taskGroup: "G" })];
    const shut = [session("g1", { taskGroup: "G", status: "dead" }), session("h1", { taskGroup: "G", status: "dead" })];
    const r = resolveLayout(l, live, undefined, [], null, shut);
    expect(r.areas.map((a) => a.key).sort()).toEqual(["A", "G"]);
    expect(r.ghosts.map((g) => [g.key, g.area, g.rect])).toEqual([
      ["ghost:g1", LOOSE_GROUP, loose],
      ["ghost:h1", "A", l.workspaces.h1],
    ]);
    // nothing saved for either: neither moved with G's area as it formed
    expect(Object.keys(r.patch?.workspaces ?? {})).not.toContain("g1");
    expect(Object.keys(r.patch?.workspaces ?? {})).not.toContain("h1");
  });

  it("stay in an area renamed, or merged into another, until the closed list follows the rename", () => {
    for (const merge of [false, true]) {
      const l = base();
      l.workspaces.g1 = { x: AREA_PAD, y: AREA_HEADER + M.h + GAP, ...M };
      l.areas.A.h += M.h + GAP;
      // a merge: into B, there already, right of A
      if (merge) l.areas.B = area(l.areas.A.w + 200, 0, l.areas.A.w, l.areas.A.h);
      const stale = [session("g1", { taskGroup: "A", status: "dead" })];
      // main re-keyed the landscape (renameAreaPatch), and the live list followed
      const renamed = applyPatch(l, renameAreaPatch(l, "A", "B", two.map((s) => s.id), stale)!);
      const live = two.map((s) => ({ ...s, taskGroup: "B" }));
      const pending = [{ from: "A", to: "B" }];
      // the closed list is reread after the live one: the rename stays on its way while a ghost is in A
      expect(renamesLeft(pending, renamed, live, stale)).toEqual(pending);
      const r = resolveLayout(renamed, live, undefined, renamesLeft(pending, renamed, live, stale), null, stale);
      expect(r.areas.map((a) => a.key)).toEqual(["B"]);
      expect(r.ghosts.map((g) => [g.key, g.area])).toEqual([["ghost:g1", "B"]]);
      // the ghost keeps the place the rename gave it; in a merge, a1 and a2 are placed anew in B
      expect(Object.keys(r.patch?.workspaces ?? {}).sort()).toEqual(merge ? ["a1", "a2"] : []);
      expect(inside(rectOf(r, "ghost:g1"), r.areas[0].rect)).toBe(true);
      // once it follows, the rename is over
      expect(renamesLeft(pending, renamed, live, [{ ...stale[0], taskGroup: "B" }])).toEqual([]);
    }
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
    // once the new one's place is saved, the ghost stays hidden while the hint stands (main lets its place go first)
    const saved = applyPatch(l, r.patch!);
    const after = resolveLayout(saved, [two[0], fresh], undefined, [], { ...hint, took: "f1" }, closed);
    expect(after.ghosts).toEqual([]);
    // with its place let go, it isn't drawn even once the hint is gone: a failed forget leaves it in the list, not over f1
    const letGo = applyPatch(saved, forgetPatch(saved, after, ["a2"])!);
    const r2 = resolveLayout(letGo, [two[0], fresh], undefined, [], null, closed);
    expect([r2.ghosts, closedListOf(closed, r2).map((s) => s.id)]).toEqual([[], ["a2"]]);
  });

  it("forgotten let their places go, and a stack's when every tab of it is forgotten", () => {
    const l = base();
    l.stacks["A/old"] = { active: "o1", placement: { x: AREA_PAD, y: AREA_HEADER + M.h + GAP, ...M } };
    const closed = [{ ...two[1], status: "dead" as const }, session("o1", { taskGroup: "A/old", status: "dead" }), session("o2", { taskGroup: "A/old", status: "dead" })];
    const r = resolveLayout(l, [two[0]], undefined, [], null, closed);
    expect(forgetPatch(l, r, ["a2"])).toEqual({ workspaces: { a2: null } });
    expect(forgetPatch(l, r, ["o1"])).toBeNull();
    expect(forgetPatch(l, r, ["o1", "o2"])).toEqual({ stacks: { "A/old": null } });
    // a running stack's closed tabs count too: its place goes only with its last tab, running or closed
    const m = base();
    m.stacks["A/tabs"] = { active: "a1", placement: m.workspaces.a1 };
    const tabs = [{ ...two[0], taskGroup: "A/tabs" }];
    const shut = [session("c1", { taskGroup: "A/tabs", status: "dead" })];
    const s = resolveLayout(m, tabs, undefined, [], null, shut);
    expect(forgetPatch(m, s, ["a1"])?.stacks).toBeUndefined();
    expect(forgetPatch(m, s, ["a1", "c1"])?.stacks).toEqual({ "A/tabs": null });
  });

  it("forgotten elsewhere leave places nothing reads: Tidy and placing new workspaces pass over them", () => {
    const l = base();
    // f1 was forgotten (neither live nor closed) with its place left in A, where the next new workspace would go
    l.areas.A.h += M.h + GAP;
    l.workspaces.f1 = { x: AREA_PAD, y: AREA_HEADER + M.h + GAP, ...M };
    l.stacks["A/old"] = { active: "f2", placement: { x: AREA_PAD + M.w + GAP, y: AREA_HEADER + M.h + GAP, ...M } };
    const known = [...two, theirs("r~nick~n1", "A")];
    const placed = withoutGone(l, known);
    expect(Object.keys(placed.workspaces).sort()).toEqual(["a1", "a2"]);
    expect(placed.stacks).toEqual({});
    // until every list has been read, nothing is passed over
    expect(withoutGone(l, null)).toBe(l);
    // a teammate's place is theirs to let go of
    expect(Object.keys(withoutGone({ ...l, workspaces: { ...l.workspaces, "r~nick~gone": l.workspaces.f1 } }, known).workspaces)).toContain("r~nick~gone");
    // a new workspace takes the room f1 left
    const fresh = session("n1", { taskGroup: "A", createdAt: 5 });
    expect(rectOf(resolveLayout(placed, [...two, fresh]), "n1")).toEqual(l.workspaces.f1);
    // Tidy packs only what's there
    const p = ready(planTidy(placed, resolveLayout(placed, two), "A", T));
    expect(p.patch?.areas?.A?.h).toBe(AREA_HEADER + M.h + AREA_PAD);
  });

  it("forgotten elsewhere never include a stack a rename on its way keys differently in the landscape and the sessions", () => {
    const pending = [{ from: "A", to: "B" }];
    const at = { x: AREA_PAD, y: AREA_HEADER, ...M };
    for (const sessionsFirst of [true, false]) {
      const l = emptyLandscape();
      const [held, sent] = sessionsFirst ? ["A", "B"] : ["B", "A"];
      l.areas[held] = area(0, 0, 2 * AREA_PAD + M.w, AREA_HEADER + M.h + AREA_PAD);
      l.stacks[`${held}/tabs`] = { active: "a1", placement: at };
      const tabs = [session("a1", { taskGroup: `${sent}/tabs` }), session("a2", { taskGroup: `${sent}/tabs` })];
      const placed = withoutGone(l, tabs, pending);
      expect(Object.keys(placed.stacks)).toEqual([`${held}/tabs`]);
      const r = resolveLayout(placed, tabs, undefined, pending);
      expect(r.tiles.map((t) => [t.stack, t.rect])).toEqual([[`${held}/tabs`, at]]);
      expect(r.patch).toBeNull();
      // with nothing on its way, a stack no session is in is passed over
      expect(withoutGone(l, tabs).stacks).toEqual({});
    }
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
