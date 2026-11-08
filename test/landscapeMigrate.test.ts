import { describe, expect, it } from "vitest";
import {
  AREA_GAP,
  AREA_HEADER,
  AREA_PAD,
  GAP,
  areaKeyOf,
  kindOf,
  overlaps,
  own,
  parseLandscape,
  presetSize,
  stackKeyOf,
  type Landscape,
  type Rect,
} from "../src/shared/landscape";
import { LEGACY_PREF_KEYS, migrateLayout, type LegacyPrefs } from "../src/shared/landscapeMigrate";
import type { SessionInfo } from "../src/shared/types";
import { remotePaneId, type RoomSessionTag } from "../src/shared/team/livePanes";
import { cellKeyFor } from "../src/renderer/appModel";
import { layoutToRemember, switchTo } from "../src/renderer/gridModel";
import { insertBeside, reconcile, resizePane, type LayoutNode } from "../src/renderer/layoutTree";
import { readPref, writePref, type PrefStore } from "../src/renderer/prefs";

const REPO = "/Users/you/Code/backoffice";
const sess = (id: string, taskGroup: string | null, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  title: id,
  repoPath: REPO,
  cwd: REPO,
  branch: null,
  ticketId: null,
  ticketTitle: null,
  taskGroup,
  status: "idle",
  createdAt: 0,
  kind: "work",
  extraDirs: [],
  waitingReason: null,
  waitingSince: null,
  agent: "claude",
  ...over,
});
const NICK = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const SAM = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const tag = (over: Partial<RoomSessionTag>): RoomSessionTag => ({
  roomId: "R5101aaaaaaaaaaaaaaaaa",
  sessionId: "",
  owner: NICK,
  ownerName: "Nick",
  remote: true,
  online: true,
  live: true,
  lookers: [],
  cols: 120,
  rows: 32,
  git: null,
  repo: null,
  repoName: null,
  guards: { secrets: true, coauthors: true },
  ...over,
});
/** A teammate's session as the window lists it (livePanes.ts): no repo here, the room's group. */
const remote = (owner: string, id: string, taskGroup: string) => sess(remotePaneId(owner, id), taskGroup, { repoPath: null, cwd: `(on ${owner}'s Mockingbird)`, room: tag({ owner, sessionId: id }) });

const leaf = (key: string): LayoutNode => ({ kind: "leaf", key });
const row = (keys: (string | LayoutNode)[], sizes?: number[]): LayoutNode => ({ kind: "split", dir: "row", children: keys.map((k) => (typeof k === "string" ? leaf(k) : k)), sizes: sizes ?? keys.map(() => 1 / keys.length) });
const col = (keys: (string | LayoutNode)[], sizes?: number[]): LayoutNode => ({ ...(row(keys, sizes) as Extract<LayoutNode, { kind: "split" }>), dir: "col" });

const NOW = new Date("2026-11-03T12:00:00.000Z");
const M = presetSize("agent", "M");
const S = presetSize("agent", "S");
const ST = presetSize("terminal", "S");

/** The areas in the order they're laid out: row by row, left to right. */
const laidOut = (l: Landscape) => Object.keys(l.areas).sort((a, b) => own(l.areas, a)!.y - own(l.areas, b)!.y || own(l.areas, a)!.x - own(l.areas, b)!.x);
const contains = (a: Rect | undefined, r: Rect) => !!a && r.x >= a.x + AREA_PAD && r.y >= a.y + AREA_HEADER && r.x + r.w <= a.x + a.w - AREA_PAD && r.y + r.h <= a.y + a.h - AREA_PAD;

function migrate(prefs: LegacyPrefs, sessions: SessionInfo[]) {
  const m = migrateLayout(prefs, sessions, { now: NOW });
  checkInvariants(m.landscape, sessions);
  return { l: m.landscape, ignored: m.ignored, stale: m.stale };
}

/**
 * What every migrated landscape holds to: it reads back as a landscape; every
 * session (debriefs aside) has exactly one place, its own or its stack's;
 * nothing overlaps; everything is on the grid and at least preset S; each
 * group is an area holding its sessions' repos once each, and its workspaces
 * sit inside it, pinned ones too; ungrouped ones sit outside every area.
 */
function checkInvariants(l: Landscape, sessions: SessionInfo[]): void {
  expect(parseLandscape(JSON.parse(JSON.stringify(l)))).toEqual(l);
  for (const r of [l.workspaces, l.areas, l.stacks, l.ghosts]) expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
  const live = sessions.filter((s) => !s.debrief);
  const placeOf = (s: SessionInfo): Rect | undefined => {
    const stack = stackKeyOf(s);
    return stack ? own(l.stacks, stack)?.placement : own(l.workspaces, s.id);
  };
  for (const s of live) {
    expect(placeOf(s), `${s.id} has no place`).toBeDefined();
    if (stackKeyOf(s)) expect(own(l.workspaces, s.id), `${s.id} is a stack's tab and has a placement of its own`).toBeUndefined();
  }
  for (const [k, st] of Object.entries(l.stacks)) expect(live.some((s) => s.id === st.active && stackKeyOf(s) === k), `${k}'s front tab ${st.active} isn't in it`).toBe(true);
  const ids = new Set(live.map((s) => s.id));
  for (const id of Object.keys(l.workspaces)) expect(ids.has(id), `${id} isn't a session`).toBe(true);

  const places = [...Object.values(l.workspaces), ...Object.values(l.stacks).map((s) => s.placement)];
  places.forEach((a, i) => places.forEach((b, j) => i < j && expect(overlaps(a, b, GAP - 1e-6), `${JSON.stringify(a)} overlaps ${JSON.stringify(b)}`).toBe(false)));
  const areas = Object.values(l.areas);
  areas.forEach((a, i) => areas.forEach((b, j) => i < j && expect(overlaps(a, b, AREA_GAP - 1e-6), "areas overlap").toBe(false)));
  for (const r of [...places, ...areas]) expect([r.x % 8, r.y % 8, r.w % 8, r.h % 8].map(Math.abs), `${JSON.stringify(r)} is off the grid`).toEqual([0, 0, 0, 0]);

  expect(Object.keys(l.areas).sort()).toEqual([...new Set(live.map(areaKeyOf))].filter((g) => g !== "ungrouped").sort());
  for (const [g, a] of Object.entries(l.areas)) expect(a.repos).toEqual([...new Set(live.filter((s) => areaKeyOf(s) === g && s.repoPath).map((s) => s.repoPath))].map((path) => ({ path, base: null })));
  for (const s of live) {
    const p = placeOf(s)!;
    const members = live.filter((x) => (stackKeyOf(s) ? stackKeyOf(x) === stackKeyOf(s) : x.id === s.id));
    const min = presetSize(members.some((x) => kindOf(x) === "agent") ? "agent" : "terminal", "S");
    expect(p.w >= min.w && p.h >= min.h, `${s.id} is smaller than preset S`).toBe(true);
    if (areaKeyOf(s) === "ungrouped") expect(areas.some((a) => overlaps(a, p)), `loose ${s.id} is in an area`).toBe(false);
    else expect(contains(own(l.areas, areaKeyOf(s)), p), `${s.id} isn't inside its area`).toBe(true);
  }
}

describe("migrating one group", () => {
  const sessions = [sess("a", "5101"), sess("b", "5101", { repoPath: "/Users/you/Code/attune" }), sess("c", "5101", { repoPath: null })];

  it("makes the group an area holding its tree as the grid drew it, each pane M or more", () => {
    const { l, ignored, stale } = migrate({ shown: ["a", "b", "c"], activeGroup: "5101", trees: { "5101": row(["a", col(["b", "c"])]) } }, sessions);
    expect([ignored, stale]).toEqual([[], []]);
    expect(Object.keys(l.areas)).toEqual(["5101"]);
    expect([l.areas["5101"].x, l.areas["5101"].y]).toEqual([0, 0]);
    const { a, b, c } = l.workspaces;
    // a on the left, the full height; b over c on the right
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBe(c.x);
    expect(b.y).toBeLessThan(c.y);
    expect(a.y).toBe(b.y);
    expect(a.h).toBe(c.y + c.h - b.y);
    for (const p of [a, b, c]) expect([p.w >= M.w, p.h >= M.h]).toEqual([true, true]);
    expect(l.migratedAt).toBe(NOW.toISOString());
    expect(l.stacks).toEqual({});
  });

  it("starts the area with its sessions' repos, once each, in order", () => {
    const { l } = migrate({}, [...sessions, sess("d", "5101")]);
    expect(l.areas["5101"].repos).toEqual([
      { path: REPO, base: null },
      { path: "/Users/you/Code/attune", base: null },
    ]);
  });

  it("keeps the tree's proportions: its fractions times the area's size", () => {
    const { l } = migrate({ shown: ["a", "b"], activeGroup: "5101", trees: { "5101": row(["a", "b"], [0.6, 0.4]) } }, sessions.slice(0, 2));
    const { a, b } = l.workspaces;
    // shares of the width, a gap counted with each pane, to within the grid
    expect((a.w + GAP) / (a.w + b.w + 2 * GAP)).toBeCloseTo(0.6, 2);
    expect([a.y, a.h]).toEqual([b.y, b.h]);
  });

  it("grows a pane too small to read to preset S, without blowing the rest of the area up", () => {
    const list = [sess("a", "5101"), sess("b", "5101")];
    const { l } = migrate({ shown: ["a", "b"], activeGroup: "5101", trees: { "5101": row(["a", "b"], [0.95, 0.05]) } }, list);
    const { a, b } = l.workspaces;
    expect([b.w, b.h]).toEqual([S.w, M.h]);
    // a keeps its share of the area's two M widths; only b's column grew
    expect(a.w).toBe(Math.ceil((0.95 * 2 * (M.w + GAP)) / 8) * 8 - GAP);
    expect(l.areas["5101"].w).toBeLessThan(3 * (M.w + GAP));
  });

  it("sizes a tree of only terminals by the terminal's M, a mixed one by the agent's", () => {
    const terms = [sess("t1", "5101", { shell: true }), sess("t2", "5101", { shell: true })];
    const T = presetSize("terminal", "M");
    const only = migrate({ shown: ["t1", "t2"], activeGroup: "5101", trees: { "5101": row(["t1", "t2"]) } }, terms).l.workspaces;
    expect([only.t1.w, only.t1.h, only.t2.w]).toEqual([T.w, T.h, T.w]);
    const mixed = migrate({ shown: ["t1", "a"], activeGroup: "5101", trees: { "5101": row(["t1", "a"]) } }, [terms[0], sess("a", "5101")]).l.workspaces;
    expect([mixed.t1.w, mixed.t1.h]).toEqual([M.w, M.h]);
  });

  it("makes a terminal at least a terminal's preset S, in a corner the tree gave almost nothing", () => {
    const list = [sess("a", "5101"), sess("t", "5101", { shell: true, agent: undefined })];
    const { l } = migrate({ shown: ["a", "t"], activeGroup: "5101", trees: { "5101": row(["a", col(["t", "x"], [0.05, 0.95])], [0.95, 0.05]) } }, list);
    // x is gone: t has the column to itself
    expect(l.workspaces.t.w).toBeGreaterThanOrEqual(ST.w);
    expect(l.workspaces.t.h).toBe(l.workspaces.a.h);
  });
});

describe("migrating several groups", () => {
  const sessions = [sess("a", "5101"), sess("b", "5101"), sess("c", "5102"), sess("d", "5110"), sess("e", "5102")];

  it("lays the areas out in rows, in the sidebar's group order, without overlapping", () => {
    const { l } = migrate(
      { shown: ["a", "b"], activeGroup: "5101", trees: { "5101": row(["a", "b"]), "5102": col(["e", "c"]) }, groupLayouts: { "5101": ["a", "b"], "5102": ["e", "c"], "5110": ["d"] } },
      sessions
    );
    expect(Object.keys(l.areas)).toEqual(["5101", "5102", "5110"]);
    const [x1, x2, x3] = [l.areas["5101"], l.areas["5102"], l.areas["5110"]];
    expect([x2.x, x2.y]).toEqual([x1.x + x1.w + AREA_GAP, x1.y]);
    // the third doesn't fit the row: it starts the next one, below the tallest
    expect([x3.x, x3.y]).toEqual([0, Math.max(x1.h, x2.h) + AREA_GAP]);
    // a group that wasn't on screen keeps its own tree: e above c
    expect(l.workspaces.e.y).toBeLessThan(l.workspaces.c.y);
    expect(l.workspaces.e.x).toBe(l.workspaces.c.x);
  });

  it("reads a group off screen as it'll show next: the panes it remembered, in its tree", () => {
    const { l } = migrate({ shown: ["a"], activeGroup: "5101", trees: { "5102": row(["c", "e"]) }, groupLayouts: { "5102": ["c"] } }, sessions);
    // e wasn't among the panes 5102 remembered: c has the tree to itself, e goes below it
    expect(l.workspaces.e.y).toBeGreaterThan(l.workspaces.c.y + l.workspaces.c.h);
  });

  it("leaves ungrouped sessions loose, in their tree's shape, just left of the first area", () => {
    const { l } = migrate({ trees: { ungrouped: row(["u1", "u2"]) }, groupLayouts: { ungrouped: ["u1", "u2"] } }, [sess("u1", null), sess("u2", null), ...sessions]);
    expect(Object.keys(l.areas)).not.toContain("ungrouped");
    const { u1, u2 } = l.workspaces;
    expect(u1.x).toBeLessThan(u2.x);
    expect(u1.y).toBe(u2.y);
    expect(u2.x + u2.w).toBe(l.areas["5101"].x - AREA_GAP);
    expect(u1.y).toBe(l.areas["5101"].y);
  });

  it("puts loose workspaces at the origin when there's no area", () => {
    const { l } = migrate({}, [sess("u1", null), sess("u2", null)]);
    expect(l.areas).toEqual({});
    expect([l.workspaces.u1.x, l.workspaces.u1.y]).toEqual([0, 0]);
  });

  it("leaves debriefs out: they live on the WorkTracker tab", () => {
    const { l } = migrate({ shown: ["brief", "a"] }, [...sessions, sess("brief", "assistant", { debrief: true })]);
    expect(l.workspaces.brief).toBeUndefined();
    expect(l.areas.assistant).toBeUndefined();
  });
});

describe("migrating sub-groups", () => {
  const sessions = [sess("a", "5101"), sess("b", "5101/api"), sess("c", "5101/api", { agent: "codex" }), sess("t", "5101/api", { shell: true })];

  it("makes each sub-group a stack: one placement for all its members, its front tab from wsTabs", () => {
    const { l } = migrate({ shown: ["a", "b", "c"], activeGroup: "5101", trees: { "5101": row(["a", "ws:5101/api"]) }, wsTabs: { "5101/api": "c" } }, sessions);
    expect(Object.keys(l.stacks)).toEqual(["5101/api"]);
    const st = l.stacks["5101/api"];
    expect(st.active).toBe("c");
    expect(st.placement.x).toBeGreaterThan(l.workspaces.a.x);
    expect(st.placement.y).toBe(l.workspaces.a.y);
    expect(Object.keys(l.workspaces)).toEqual(["a"]);
    // the sub-group is a stack inside its group's area, not an area of its own
    expect(Object.keys(l.areas)).toEqual(["5101"]);
  });

  it("puts the first member in front when wsTabs names none, or a session that isn't in the stack", () => {
    expect(migrate({ trees: { "5101": row(["a", "ws:5101/api"]) } }, sessions).l.stacks["5101/api"].active).toBe("b");
    expect(migrate({ wsTabs: { "5101/api": "a" } }, sessions).l.stacks["5101/api"].active).toBe("b");
  });

  it("reads a tree leaf naming a session that has joined a sub-group since as its stack, in the same place", () => {
    const { l } = migrate({ groupLayouts: { "5101": ["b", "a"] }, trees: { "5101": col(["b", "a"]) } }, sessions);
    expect(l.stacks["5101/api"].placement.y).toBeLessThan(l.workspaces.a.y);
    expect(l.stacks["5101/api"].placement.x).toBe(l.workspaces.a.x);
  });

  it("makes a stack of terminals a terminal's size, and one with an agent an agent's", () => {
    const { l } = migrate({}, [sess("x", "5101/tests", { shell: true }), sess("y", "5101/tests", { shell: true }), ...sessions]);
    expect(l.stacks["5101/tests"].placement.h).toBe(presetSize("terminal").h);
    expect(l.stacks["5101/api"].placement.h).toBe(M.h);
  });
});

describe("migrating pinned panes", () => {
  const sessions = [sess("a", "5101"), sess("b", "5101"), sess("p", "5102"), sess("q", null), sess("r", "5102")];

  it("puts them in their own areas like any other: everything is on the landscape at once", () => {
    const { l } = migrate({ shown: ["a", "p", "b", "q"], pinned: ["p", "q"], activeGroup: "5101", trees: { "5101": row(["a", "p", "b", "q"]), "5102": row(["p", "r"]) }, groupLayouts: { "5102": ["p", "r"] } }, sessions);
    const { p, q, a, b, r } = l.workspaces;
    // 5101's tree without the visitors from other groups: a and b share it half and half
    expect(b.x).toBeGreaterThan(a.x);
    expect(a.w).toBe(b.w);
    // p in 5102's tree, where its own group had it; q loose, as ungrouped
    expect(contains(l.areas["5102"], p)).toBe(true);
    expect([p.x < r.x, p.y]).toEqual([true, r.y]);
    expect(Object.values(l.areas).some((x) => overlaps(x, q))).toBe(false);
  });

  it("keeps a pinned stack member's stack in its area", () => {
    const { l } = migrate({ pinned: ["s2"] }, [sess("a", "5101"), sess("s1", "5101/x"), sess("s2", "5101/x")]);
    expect(contains(l.areas["5101"], l.stacks["5101/x"].placement)).toBe(true);
  });

  it("still reads which group the grid showed as the grid did: a pinned visitor doesn't make its group the one on screen", () => {
    // 5102 was last shown, but only its pinned p is on screen now: 5101 is the group on screen, with c as the grid has it
    const { l } = migrate({ shown: ["p", "a", "b"], pinned: ["p"], activeGroup: "5102", trees: { "5101": row(["b", "a"]) }, groupLayouts: { "5101": ["a"] } }, sessions);
    expect(l.workspaces.b.x).toBeLessThan(l.workspaces.a.x);
  });
});

describe("migrating an empty layout", () => {
  it("is an empty landscape, marked migrated, when there's nothing at all", () => {
    const { l, ignored, stale } = migrate({}, []);
    expect(l).toEqual({ v: 2, migratedAt: NOW.toISOString(), workspaces: {}, areas: {}, stacks: {}, ghosts: {}, tools: {}, cards: {} });
    expect([ignored, stale]).toEqual([[], []]);
  });

  it("places every session with placeNew when the grid never laid any out: M-sized, two across, in order", () => {
    const sessions = [sess("a", "5101"), sess("b", "5101"), sess("c", "5101"), sess("t", "5101", { shell: true })];
    const { l } = migrate({}, sessions);
    const { a, b, c, t } = l.workspaces;
    expect([a.w, a.h]).toEqual([M.w, M.h]);
    expect([t.w, t.h]).toEqual([presetSize("terminal").w, presetSize("terminal").h]);
    expect(a.y).toBe(b.y);
    expect(b.x).toBe(a.x + a.w + GAP);
    expect(c.y).toBeGreaterThan(a.y);
  });

  it("reads an empty grid (nothing on screen, no trees) the same way", () => {
    const sessions = [sess("a", "5101"), sess("b", "5101")];
    expect(migrate({ shown: [], trees: {}, pinned: [], groupLayouts: {}, activeGroup: null, wsTabs: {} }, sessions).l).toEqual(migrate({}, sessions).l);
  });
});

describe("migrating the earlier layout prefs", () => {
  const sessions = [sess("a", "5101"), sess("b", "5101"), sess("c", "5101"), sess("d", "5101")];

  it("reads mb.cols as even rows of that many panes", () => {
    const { l } = migrate({ cols: 1, groupLayouts: { "5101": ["a", "b", "c"] } }, sessions.slice(0, 3));
    const { a, b, c } = l.workspaces;
    expect([a.x, b.x]).toEqual([c.x, c.x]);
    expect(a.y).toBeLessThan(b.y);
    expect(b.y).toBeLessThan(c.y);
  });

  it("reads mb.cols 'auto' as the old automatic count: four panes are two by two", () => {
    const { l } = migrate({ cols: "auto", groupLayouts: { "5101": ["a", "b", "c", "d"] } }, sessions);
    const { a, b, c, d } = l.workspaces;
    expect([a.y === b.y, c.y === d.y, a.x === c.x, b.x === d.x, a.y < c.y, a.x < b.x]).toEqual([true, true, true, true, true, true]);
  });

  it("reads mb.layout and mb.zones: the template, with each seated pane in its zone", () => {
    const { l } = migrate({ layout: { "5101": "big-left" }, zones: { "5101": ["c", "a", "b"] }, groupLayouts: { "5101": ["a", "b", "c"] } }, sessions.slice(0, 3));
    const { a, b, c } = l.workspaces;
    expect(c.x).toBeLessThan(a.x);
    expect(a.x).toBe(b.x);
    expect(a.y).toBeLessThan(b.y);
    expect(c.h).toBe(b.y + b.h - a.y);
  });

  it("reads mb.zones alone for a group with no other record of its panes", () => {
    const { l } = migrate({ layout: { "5101": "rows-2" }, zones: { "5101": ["b", null, 7] } }, sessions.slice(0, 2));
    expect(l.workspaces.b.y).toBeLessThan(l.workspaces.a.y);
  });

  it("prefers the split tree over the earlier prefs when the group has one", () => {
    const { l } = migrate({ cols: 1, layout: { "5101": "rows-2" }, trees: { "5101": row(["a", "b"]) }, groupLayouts: { "5101": ["a", "b"] } }, sessions.slice(0, 2));
    expect(l.workspaces.a.y).toBe(l.workspaces.b.y);
  });

  it("names prefs that aren't in the shape the grid wrote, and goes on without them", () => {
    const { l, ignored } = migrate(
      { shown: "a", trees: { "5101": { kind: "bogus" }, "5102": row(["c"]) }, groupLayouts: { "5101": [1, 2] }, cols: -2, wsTabs: { "5101/x": 4 }, activeGroup: 3, pinned: {}, layout: { "5101": 9 }, zones: { "5101": "a" } },
      sessions.slice(0, 2)
    );
    expect(ignored).toEqual([
      'mb.trees["5101"] isn\'t a layout tree',
      'mb.groupLayouts["5101"] isn\'t a list of session ids',
      'mb.wsTabs["5101/x"] isn\'t a session id',
      "mb.activeGroup isn't a group",
      "mb.cols isn't a column count",
      'mb.layout["5101"] isn\'t a layout\'s name',
      'mb.zones["5101"] isn\'t a list of zones',
      "mb.shown isn't a list of session ids",
      "mb.pinned isn't a list of session ids",
    ]);
    expect(Object.keys(l.workspaces).sort()).toEqual(["a", "b"]);
  });

  it("names each pref by the localStorage key the grid keeps it under", () => {
    expect(LEGACY_PREF_KEYS).toEqual({ shown: "mb.shown", trees: "mb.trees", pinned: "mb.pinned", groupLayouts: "mb.groupLayouts", activeGroup: "mb.activeGroup", wsTabs: "mb.wsTabs", cols: "mb.cols", layout: "mb.layout", zones: "mb.zones" });
  });
});

describe("migrating sessions the layout doesn't name", () => {
  it("places them with placeNew in their area, below the tree", () => {
    const sessions = [sess("a", "5101"), sess("b", "5101"), sess("new", "5101", { shell: true })];
    const { l } = migrate({ shown: ["a", "b"], activeGroup: "5101", trees: { "5101": row(["a", "b"]) } }, sessions);
    const { a, new: n } = l.workspaces;
    expect(n.y).toBe(a.y + a.h + GAP);
    expect(n.x).toBe(a.x);
  });

  it("places a whole group the grid never showed, its sub-group as a stack", () => {
    const { l } = migrate({ shown: ["a"], activeGroup: "5101", trees: { "5101": leaf("a") } }, [sess("a", "5101"), sess("x", "5199"), sess("y", "5199/sub")]);
    expect(l.workspaces.x).toBeDefined();
    expect(l.stacks["5199/sub"]).toBeDefined();
  });

  it("gives no place to a closed session the grid didn't show (its Previous), nor an area to a group of only those", () => {
    const shown = [sess("a", "5101", { status: "dead" })];
    const previous = [sess("p", "5101", { status: "dead" }), sess("q", "5199", { status: "dead" }), sess("r", null, { status: "dead" })];
    const m = migrateLayout({ shown: ["a"], activeGroup: "5101", trees: { "5101": leaf("a") } }, [...shown, ...previous], { now: NOW, closed: new Set(["a", "p", "q", "r"]) });
    expect(Object.keys(m.landscape.workspaces)).toEqual(["a"]);
    expect(Object.keys(m.landscape.areas)).toEqual(["5101"]);
    expect(m.stale).toEqual([]);
  });

  it("keeps the places of the previous run's sessions, which a relaunch brings back under the same ids", () => {
    const resumable = [sess("a", "5101", { status: "dead" }), sess("b", "5101", { status: "dead" })];
    const { l, stale } = migrate({ shown: ["b", "a"], activeGroup: "5101", trees: { "5101": row(["b", "a"]) } }, resumable);
    expect(l.workspaces.b.x).toBeLessThan(l.workspaces.a.x);
    expect(stale).toEqual([]);
  });
});

describe("migrating a stale layout", () => {
  it("drops panes, stacks and pins naming sessions that no longer exist, names them, and gives their space to the rest", () => {
    const { l, stale } = migrate(
      { shown: ["a", "gone"], pinned: ["gone2"], activeGroup: "5101", trees: { "5101": row(["a", "gone", "ws:5101/old"]), "5199": row(["x"]) }, wsTabs: { "5101/old": "gone3" }, groupLayouts: { "5199": ["x"] } },
      [sess("a", "5101")]
    );
    expect(Object.keys(l.workspaces)).toEqual(["a"]);
    expect(l.stacks).toEqual({});
    expect(Object.keys(l.areas)).toEqual(["5101"]);
    expect(stale).toEqual(["gone", "gone2", "gone3", "ws:5101/old", "x"]);
    // a fills the area alone, at M
    expect([l.workspaces.a.w, l.workspaces.a.h]).toEqual([M.w, M.h]);
  });

  it("moves a pane that has changed group since into its new group's area", () => {
    const { l } = migrate({ shown: ["a", "m"], activeGroup: "5101", trees: { "5101": row(["a", "m"]) } }, [sess("a", "5101"), sess("m", "5102")]);
    expect(contains(l.areas["5102"], l.workspaces.m)).toBe(true);
    expect([l.workspaces.a.w, l.workspaces.a.h]).toEqual([M.w, M.h]);
  });
});

describe("migrating a team room's group", () => {
  const n1 = remote(NICK, "n1", "5101");
  const n7 = remote(NICK, "n7", "5110");
  const m1 = remote(SAM, "m1", "5101/api");
  const mine = [sess("a", "5101", { room: tag({ owner: "me", sessionId: "a", remote: false }) }), sess("b", "5101/api"), sess("c", "5102")];

  it("is an area like any other: teammates' sessions in it keep their places in its tree", () => {
    const { l } = migrate({ shown: ["a", n1.id, "b"], activeGroup: "5101", trees: { "5101": row(["a", n1.id, "ws:5101/api"]) } }, [...mine, n1, m1]);
    const { a } = l.workspaces;
    const n = l.workspaces[n1.id];
    expect(a.x).toBeLessThan(n.x);
    expect(n.x).toBeLessThan(l.stacks["5101/api"].placement.x);
    // the teammate's own sub-group session is a tab of the same stack
    expect(Object.keys(l.stacks)).toEqual(["5101/api"]);
    // teammates' repos are on their Macs: the area keeps this Mac's
    expect(l.areas["5101"].repos).toEqual([{ path: REPO, base: null }]);
  });

  it("places teammates' sessions the layout doesn't name in the room's area, and a room only a teammate is in after this Mac's groups", () => {
    const { l } = migrate({ shown: ["c"], activeGroup: "5102" }, [n7, sess("d", "5199"), ...mine, n1]);
    // 5110 holds only a teammate's session, so it comes after this Mac's groups though its session is listed first
    expect(laidOut(l)).toEqual(["5199", "5101", "5102", "5110"]);
    expect(l.areas["5110"].repos).toEqual([]);
    expect(contains(l.areas["5110"], l.workspaces[n7.id])).toBe(true);
    expect(contains(l.areas["5101"], l.workspaces[n1.id])).toBe(true);
  });
});

describe("migrating groups and sessions named like Object.prototype members", () => {
  const NAMES = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];
  /** Prefs as localStorage hands them back: JSON, so a key named __proto__ is a key, not a prototype. */
  const prefsOf = (v: unknown): LegacyPrefs => JSON.parse(JSON.stringify(v).replaceAll("PROTO", "__proto__"));
  const as = (k: string) => (k === "__proto__" ? "PROTO" : k);

  it("makes each such group an area, keeps its tree, stacks and front tab, and loses no session", () => {
    for (const g of NAMES) {
      const sessions = [sess("a", g), sess("b", g), sess("s1", `${g}/${g}`), sess("s2", `${g}/${g}`), sess("o", "5101")];
      const prefs = prefsOf({ shown: ["b", "a", "s1"], activeGroup: as(g), trees: { [as(g)]: row(["b", "a", `ws:${as(g)}/${as(g)}`]) }, groupLayouts: { [as(g)]: ["b", "a", "s1"] }, wsTabs: { [`${as(g)}/${as(g)}`]: "s2" } });
      const { l, ignored, stale } = migrate(prefs, sessions);
      expect([ignored, stale], g).toEqual([[], []]);
      expect(laidOut(l), g).toEqual([g, "5101"]);
      const { a, b } = { a: own(l.workspaces, "a")!, b: own(l.workspaces, "b")! };
      expect(b.x, g).toBeLessThan(a.x);
      expect(own(l.stacks, `${g}/${g}`)?.active, g).toBe("s2");
      expect(own(l.stacks, `${g}/${g}`)!.placement.x, g).toBeGreaterThan(a.x);
    }
  });

  it("places each such session id from the tree, as a stack's front tab, and as a pin", () => {
    for (const id of NAMES) {
      const sessions = [sess(id, "5101"), sess("a", "5101"), sess(`${id}-tab`, "5101/x"), sess(id === "__proto__" ? "p2" : "__proto__", "5101/x")];
      const prefs = prefsOf({ shown: ["a", as(id)], pinned: [as(id)], activeGroup: "5101", trees: { "5101": row(["a", as(id)]) }, wsTabs: { "5101/x": `${as(id)}-tab` } });
      const { l } = migrate(prefs, sessions);
      expect(Object.keys(l.workspaces).sort(), id).toEqual(["a", id].sort());
      expect(own(l.workspaces, id)!.x, id).toBeGreaterThan(own(l.workspaces, "a")!.x);
      expect(own(l.stacks, "5101/x")?.active, id).toBe(`${id}-tab`);
    }
  });
});

describe("migrating prefs as the grid writes them", () => {
  /** localStorage as the window has it: what writePref stored, read back by readPref. */
  const prefStore = (): PrefStore & { keys: () => string[] } => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), keys: () => [...m.keys()] };
  };

  it("reads a session of using the grid: two groups, a sub-group, a split and a resize, a pin and a teammate", () => {
    const n1 = remote(NICK, "n1", "5101");
    const sessions = [sess("s1", "5101"), sess("s2", "5101/api"), sess("s3", "5101/api", { agent: "codex" }), sess("s4", "5101", { shell: true, agent: undefined }), sess("s5", "5102"), sess("s6", "5102"), sess("s7", null, { kind: "assistant", repoPath: null }), n1];
    const groupOf = (id: string) => {
      const s = sessions.find((x) => x.id === id);
      return s ? areaKeyOf(s) : undefined;
    };
    const cellsOf = (shown: string[]) => [...new Set(shown.map((id) => cellKeyFor(id, sessions.find((s) => s.id === id)!.taskGroup)))];
    const grid = { w: 1336, h: 900 };

    // 5101 on screen: its panes added by the default rule, the terminal dropped below s1, s1's edge dragged right
    let shown = ["s1", "s2", "s3", n1.id];
    let t5101: LayoutNode = reconcile(null, cellsOf(shown), grid)!;
    shown = [...shown, "s4"];
    t5101 = insertBeside(t5101, "s1", "bottom", "s4");
    t5101 = resizePane(t5101, "s1", "x", 0.1, { x: 0.1, y: 0.1 });
    const wsTabs = { "5101/api": "s3" };
    // the assistant pinned: it stays on screen across the switch
    shown = [...shown, "s7"];
    const pinned = ["s7"];
    // switched to 5102: 5101 remembers its own panes, 5102 gets the default rule
    const groupLayouts = { "5101": layoutToRemember(shown, groupOf, "5101") };
    shown = switchTo(shown, new Set(pinned), ["s5", "s6"]);
    const t5102 = reconcile(null, cellsOf(shown), grid)!;

    const store = prefStore();
    writePref("mb.shown", shown, store);
    writePref("mb.trees", { "5101": t5101, "5102": t5102 }, store);
    writePref("mb.pinned", pinned, store);
    writePref("mb.groupLayouts", groupLayouts, store);
    writePref("mb.activeGroup", "5102", store);
    writePref("mb.wsTabs", wsTabs, store);
    const prefs = Object.fromEntries(Object.entries(LEGACY_PREF_KEYS).map(([field, key]) => [field, readPref<unknown>(key, undefined, store)])) as LegacyPrefs;

    const { l, ignored, stale } = migrate(prefs, sessions);
    expect([ignored, stale]).toEqual([[], []]);
    expect(Object.keys(l.areas)).toEqual(["5101", "5102"]);
    const w = l.workspaces;
    const api = l.stacks["5101/api"];
    expect(api.active).toBe("s3");
    // 5101 as it was left: s1 over s4 on the left, wider than its neighbours after the drag; the stack and Nick's beside it
    expect(w.s1.x).toBe(w.s4.x);
    expect(w.s1.y).toBeLessThan(w.s4.y);
    expect(w.s1.w).toBeGreaterThan(api.placement.w);
    expect(api.placement.x).toBeGreaterThan(w.s1.x);
    expect(w[n1.id].x).toBeGreaterThan(w.s1.x);
    // 5102, the group on screen, side by side as the default rule split a wide grid
    expect(w.s5.y).toBe(w.s6.y);
    expect(w.s5.x).toBeLessThan(w.s6.x);
    // the pinned assistant, loose by the first area
    expect(w.s7.x + w.s7.w).toBe(l.areas["5101"].x - AREA_GAP);
    // the legacy keys are only read
    expect(store.keys().sort()).toEqual(["mb.activeGroup", "mb.groupLayouts", "mb.pinned", "mb.shown", "mb.trees", "mb.wsTabs"]);
  });
});
