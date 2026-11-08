/**
 * Reading the grid's layout into a landscape, once (docs/landscape.md,
 * Migration). The grid's prefs stay in localStorage untouched, so an older
 * Mockingbird still opens with its grid.
 *
 * A group's split tree is read back with the grid's own rules (layoutTree.ts,
 * gridModel.ts, appModel.ts), as the grid would draw it the next time the
 * group is on screen, then turned into rectangles. Those files go with the
 * grid; what this needs of them has to move here first.
 */
import type { SessionInfo } from "./types";
import { sessionOutline } from "../renderer/appModel";
import { activeGroupOf } from "../renderer/gridModel";
import { asTree, hasLeaf, keysOf, legacyTree, reconcile, remove, rename, toGrid, type Extent, type LayoutNode, type LegacyLayout } from "../renderer/layoutTree";
import {
  AREA_GAP,
  AREA_HEADER,
  AREA_PAD,
  CELL_ESTIMATE,
  GAP,
  LOOSE_GROUP,
  areaKeyOf,
  boundsOf,
  emptyLandscape,
  fitAreaTo,
  kindOf,
  placeNew,
  presetSize,
  put,
  snapUp,
  stackKeyOf,
  type Cell,
  type Landscape,
  type Rect,
  type WorkspaceKind,
} from "./landscape";

/** The grid's layout prefs, each parsed from its localStorage key (LEGACY_PREF_KEYS); missing ones are undefined. */
export interface LegacyPrefs {
  /** The session ids on screen, in order. */
  shown?: unknown;
  /** A split tree per top-level group; leaves are session ids or "ws:<top/sub>". */
  trees?: unknown;
  /** Session ids that stayed on screen across group switches. */
  pinned?: unknown;
  /** Per group, the session ids it last had on screen. */
  groupLayouts?: unknown;
  /** The group the grid was last switched to. */
  activeGroup?: unknown;
  /** Per sub-group ("top/sub"), the session whose tab was in front. */
  wsTabs?: unknown;
  /** Before split trees: the column count, a snap-layout template per group, and the pane in each of its zones. */
  cols?: unknown;
  layout?: unknown;
  zones?: unknown;
}

export const LEGACY_PREF_KEYS: Record<keyof LegacyPrefs, string> = {
  shown: "mb.shown",
  trees: "mb.trees",
  pinned: "mb.pinned",
  groupLayouts: "mb.groupLayouts",
  activeGroup: "mb.activeGroup",
  wsTabs: "mb.wsTabs",
  cols: "mb.cols",
  layout: "mb.layout",
  zones: "mb.zones",
};

export interface Migration {
  landscape: Landscape;
  /** Prefs not in the shape the grid writes, each named with why: left out, for the caller to log. */
  ignored: string[];
  /** Ids and cell keys the prefs named that are no session now: dropped, for the caller to log. */
  stale: string[];
}

/** The grid size the old default rule split panes by: the window's default, as no grid is there to measure. */
const NOMINAL_GRID: Extent = { w: 1600, h: 1000 };
/** How wide a row of areas gets before the next area starts a new row. */
const ROW_WIDTH = 3600;

/** One thing the grid drew in a cell: a session, or a sub-group's sessions as tabs. */
interface Tile {
  key: string;
  group: string;
  stack: string | null;
  members: SessionInfo[];
}

const tileKeyOf = (s: SessionInfo): string => {
  const stack = stackKeyOf(s);
  return stack ? `ws:${stack}` : s.id;
};
const tileKind = (t: Tile): WorkspaceKind => (t.members.some((s) => kindOf(s) === "agent") ? "agent" : "terminal");
const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** Most leaves side by side along any line across the tree, in `dir`. */
function across(tree: LayoutNode, dir: "row" | "col"): number {
  if (tree.kind === "leaf") return 1;
  const n = tree.children.map((c) => across(c, dir));
  return tree.dir === dir ? sum(n) : Math.max(...n);
}

/**
 * Track sizes in pixels: `fractions` of `total`, grown until each span of
 * tracks [from, to) is at least its `need`, then each rounded up to the grid.
 * Growing a span never shrinks another, so one pass meets them all.
 */
function trackSizes(fractions: number[], total: number, needs: { from: number; to: number; need: number }[]): number[] {
  const out = fractions.map((f) => f * total);
  for (const { from, to, need } of needs) {
    const have = sum(out.slice(from, to));
    if (have > 0 && have < need) for (let i = from; i < to; i++) out[i] *= need / have;
  }
  return out.map(snapUp);
}

/**
 * Each pane's rectangle from its group's tree, in the area's own frame (its
 * corner at 0, 0): the tree's fractions times the area's size, on the grid,
 * every pane at least preset S. The area is as many M workspaces wide, and
 * tall, as the tree had panes side by side, and stacked (M agents, or M
 * terminals for a tree of only terminals); a share too small to hold S widens
 * its tracks. A pane whose share collapsed to nothing (a hand-edited pref)
 * gets no rectangle here, so the caller places it.
 */
function treeRects(tree: LayoutNode, kindOfKey: (key: string) => WorkspaceKind, cell: Cell): { rects: Map<string, Rect>; w: number; h: number } {
  // toGrid keeps panes in a plain object, where a pane keyed "__proto__" would be lost: it reads the tree under
  // stand-in names, which no session id has (a NUL in them)
  const keys = keysOf(tree);
  let named: LayoutNode = tree;
  keys.forEach((k, i) => (named = rename(named, k, `\u0000${i}`)!));
  const g = toGrid(named);
  const m = presetSize(keys.some((k) => kindOfKey(k) === "agent") ? "agent" : "terminal", "M", cell);
  const spans = Object.entries(g.areas).map(([alias, a]) => {
    const key = keys[Number(alias.slice(1))];
    const [r0, c0, r1, c1] = a.split("/").map((n) => Number(n) - 1);
    return { key, r0, c0, r1, c1, min: presetSize(kindOfKey(key), "S", cell) };
  });
  const cols = trackSizes(g.cols, across(tree, "row") * (m.w + GAP), spans.map((s) => ({ from: s.c0, to: s.c1, need: s.min.w + GAP })));
  const rows = trackSizes(g.rows, across(tree, "col") * (m.h + GAP), spans.map((s) => ({ from: s.r0, to: s.r1, need: s.min.h + GAP })));
  const edge = (sizes: number[], i: number) => sum(sizes.slice(0, i));
  const rects = new Map<string, Rect>();
  for (const s of spans) {
    const r = { x: AREA_PAD + edge(cols, s.c0), y: AREA_HEADER + edge(rows, s.r0), w: edge(cols, s.c1) - edge(cols, s.c0) - GAP, h: edge(rows, s.r1) - edge(rows, s.r0) - GAP };
    if (r.w >= s.min.w && r.h >= s.min.h) rects.set(s.key, r);
  }
  return { rects, w: 2 * AREA_PAD + sum(cols) - GAP, h: AREA_HEADER + sum(rows) - GAP + AREA_PAD };
}

/**
 * The landscape the grid's layout becomes:
 * - each group is an area, the areas in rows in today's group order (the
 *   sidebar's, then room groups only a teammate's sessions are in);
 * - a group's split tree gives its workspaces' rectangles: its fractions
 *   times the area's size, snapped, every workspace at least preset S;
 * - sub-groups are stacks, one placement for all their members, their front
 *   tab from `wsTabs`;
 * - ungrouped sessions are loose workspaces, kept in their tree's shape, just
 *   left of the first area;
 * - pinned panes go in their own area like any other: everything is on the
 *   landscape at once, so pinning means nothing there;
 * - sessions the layout doesn't name are placed with placeNew in their area;
 * - ids that name no session are dropped (`stale`).
 *
 * Groups are never changed. `sessions` are every session the layout can name:
 * the live ones, the previous run's resumable ones (a relaunch brings them
 * back under the same id, so they aren't stale) and teammates' room sessions,
 * in the sidebar's order. Debriefs live on the WorkTracker tab and are left
 * out. Every other session gets a place, but for the closed ones (`closed`,
 * main's resumable ids) the layout doesn't name: those were in the grid's
 * Previous, not on screen, and the landscape lists them (Closed sessions)
 * rather than drawing ghosts of them, so no area is made for them either.
 */
export function migrateLayout(prefs: LegacyPrefs, sessions: readonly SessionInfo[], opts: { now?: Date; cell?: Cell; closed?: ReadonlySet<string> } = {}): Migration {
  const cell = opts.cell ?? CELL_ESTIMATE;
  const ignored: string[] = [];
  const read = readPrefs(prefs, ignored);
  const byId = new Map<string, SessionInfo>();
  for (const s of sessions) if (!s.debrief && !byId.has(s.id)) byId.set(s.id, s);
  const named = new Set(read.named());
  const onScreen = (s: SessionInfo) => {
    const stack = stackKeyOf(s);
    return !opts.closed?.has(s.id) || named.has(s.id) || (!!stack && named.has(`ws:${stack}`));
  };
  const list = [...byId.values()].filter(onScreen);

  const tiles = new Map<string, Tile>();
  for (const s of list) {
    const key = tileKeyOf(s);
    let t = tiles.get(key);
    if (!t) tiles.set(key, (t = { key, group: areaKeyOf(s), stack: stackKeyOf(s), members: [] }));
    t.members.push(s);
  }
  /** The tile a saved id or cell key names now: a session's own, its stack's, or a "ws:" key's; undefined when it's gone. */
  const tileNamed = (k: string): Tile | undefined => {
    if (k.startsWith("ws:")) return tiles.get(k);
    const s = byId.get(k);
    return s && tiles.get(tileKeyOf(s));
  };

  // the group the grid shows, as it decides it: a pinned pane visiting from another group never makes that one active
  const active = activeGroupOf(read.shown, (id) => (byId.has(id) ? areaKeyOf(byId.get(id)!) : undefined), new Set(read.pinned), read.activeGroup);
  const groups = unique([...sessionOutline(list, [], false).flatMap((e) => (e.kind === "group" ? [e.key] : [])), ...list.map(areaKeyOf)]);

  /** A saved tree with each leaf under its tile's key now (a session that joined a sub-group is its stack's cell); leaves naming nothing stay, for reconcile to drop. */
  const canonical = (tree: LayoutNode): LayoutNode | null => {
    let t: LayoutNode | null = tree;
    for (const k of keysOf(tree)) {
      const tile = tileNamed(k);
      if (t && tile && tile.key !== k) t = hasLeaf(t, tile.key) ? remove(t, k) : rename(t, k, tile.key);
    }
    return t;
  };

  /** A group's workspaces laid out in its own frame (corner at 0, 0): its tree's, then the rest by placeNew below them. */
  const layOut = (g: string): { frame: Rect; at: Map<string, Rect> } => {
    const mine = [...tiles.values()].filter((t) => t.group === g);
    const mineKeys = new Set(mine.map((t) => t.key));
    const ownOf = (ids: readonly string[]) => unique(ids.flatMap((id) => tileNamed(id)?.key ?? []).filter((k) => mineKeys.has(k)));
    const saved = read.trees[g] ? canonical(read.trees[g]) : null;
    // the panes on screen the next time the group is: the grid's now for the group it shows, else the ones it last had
    const keys = [g === active ? ownOf(read.shown) : [], ownOf(read.groupLayouts[g] ?? []), ownOf(keysOf(saved)), ownOf(read.seatsOf(g))].find((k) => k.length) ?? [];
    const tree = keys.length ? reconcile(saved ?? legacyTree(read.legacy, g, keys, NOMINAL_GRID), keys, NOMINAL_GRID) : null;

    const m = presetSize("agent", "M", cell);
    // without a tree, two M agents across, or one for a lone workspace
    let frame: Rect = { x: 0, y: 0, w: 2 * AREA_PAD + Math.min(Math.max(mine.length, 1), 2) * (m.w + GAP) - GAP, h: AREA_HEADER + AREA_PAD };
    let at = new Map<string, Rect>();
    if (tree) {
      const r = treeRects(tree, (k) => tileKind(tiles.get(k)!), cell);
      at = r.rects;
      frame = { x: 0, y: 0, w: r.w, h: r.h };
    }
    for (const t of mine) {
      if (at.has(t.key)) continue;
      const r = placeNew(presetSize(tileKind(t), "M", cell), [...at.values()], frame);
      at.set(t.key, r);
      // grown for each, as placeNew needs: its next row starts below what's in the area
      const { x, y, w, h } = fitAreaTo({ ...frame, repos: [] }, [r]);
      frame = { x, y, w, h };
    }
    const { x, y, w, h } = fitAreaTo({ ...frame, repos: [] }, [...at.values()]);
    return { frame: { x, y, w, h }, at };
  };

  const out = emptyLandscape();
  out.migratedAt = (opts.now ?? new Date()).toISOString();
  const placed = new Map<string, Rect>();
  const move = (at: Map<string, Rect>, dx: number, dy: number) => {
    for (const [k, p] of at) placed.set(k, { ...p, x: p.x + dx, y: p.y + dy });
  };

  let row = { x: 0, y: 0, h: 0 };
  for (const g of groups) {
    if (g === LOOSE_GROUP) continue;
    const { frame, at } = layOut(g);
    if (row.x > 0 && row.x + frame.w > ROW_WIDTH) row = { x: 0, y: row.y + row.h + AREA_GAP, h: 0 };
    put(out.areas, g, { x: row.x, y: row.y, w: frame.w, h: frame.h, repos: unique(list.filter((s) => areaKeyOf(s) === g && s.repoPath).map((s) => s.repoPath!)).map((path) => ({ path, base: null })) });
    move(at, row.x, row.y);
    row = { x: row.x + frame.w + AREA_GAP, y: row.y, h: Math.max(row.h, frame.h) };
  }

  // ungrouped workspaces are loose, in their tree's shape, just left of the first area (at the origin when there's none)
  const first = groups.find((g) => g !== LOOSE_GROUP);
  const near = first === undefined ? null : out.areas[first];
  if (groups.includes(LOOSE_GROUP)) {
    const { at } = layOut(LOOSE_GROUP);
    const b = boundsOf([...at.values()]);
    if (b) move(at, near ? near.x - AREA_GAP - (b.x + b.w) : -b.x, near ? near.y - b.y : -b.y);
  }

  for (const t of tiles.values()) {
    const p = placed.get(t.key);
    // every tile's group is laid out above: one without a place is a bug here, never a session to lose quietly
    if (!p) throw new Error(`migrateLayout gave ${t.key} (group ${t.group}) no place`);
    if (!t.stack) put(out.workspaces, t.members[0].id, p);
    else {
      const front = read.wsTabs[t.stack];
      put(out.stacks, t.stack, { active: t.members.some((s) => s.id === front) ? front : t.members[0].id, placement: p });
    }
  }
  const stale = unique(read.named()).filter((k) => !tileNamed(k)).sort();
  return { landscape: out, ignored, stale };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

interface ReadPrefs {
  shown: string[];
  pinned: string[];
  trees: Record<string, LayoutNode>;
  groupLayouts: Record<string, string[]>;
  activeGroup: string | null;
  wsTabs: Record<string, string>;
  legacy: LegacyLayout;
  /** The panes seated in a group's zones (the earlier prefs). */
  seatsOf: (group: string) => string[];
  /** Every id and cell key the prefs name. */
  named: () => string[];
}

/** The prefs in the shapes the grid wrote them; anything else is left out and named in `ignored`. */
function readPrefs(p: LegacyPrefs, ignored: string[]): ReadPrefs {
  const skip = (field: keyof LegacyPrefs, why: string, sub?: string) => ignored.push(`${LEGACY_PREF_KEYS[field]}${sub === undefined ? "" : `[${JSON.stringify(sub)}]`} ${why}`);
  const strings = (field: keyof LegacyPrefs, v: unknown, sub?: string): string[] => {
    if (v === undefined || v === null) return [];
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
    skip(field, "isn't a list of session ids", sub);
    return [];
  };
  const rec = (field: keyof LegacyPrefs): Record<string, unknown> => {
    const v = p[field];
    if (v === undefined || v === null) return {};
    if (isRecord(v)) return v;
    skip(field, "isn't an object");
    return {};
  };

  // null-prototype records: a group named "constructor" or "__proto__" is a key like any other
  const trees: Record<string, LayoutNode> = Object.create(null);
  for (const [g, t] of Object.entries(rec("trees"))) {
    const tree = asTree(t);
    if (tree) trees[g] = tree;
    else skip("trees", "isn't a layout tree", g);
  }
  const groupLayouts: Record<string, string[]> = Object.create(null);
  for (const [g, ids] of Object.entries(rec("groupLayouts"))) groupLayouts[g] = strings("groupLayouts", ids, g);
  const wsTabs: Record<string, string> = Object.create(null);
  for (const [k, id] of Object.entries(rec("wsTabs"))) {
    if (typeof id === "string") wsTabs[k] = id;
    else skip("wsTabs", "isn't a session id", k);
  }
  let activeGroup: string | null = null;
  if (typeof p.activeGroup === "string") activeGroup = p.activeGroup;
  else if (p.activeGroup !== undefined && p.activeGroup !== null) skip("activeGroup", "isn't a group");
  let cols: number | "auto" = "auto";
  if (typeof p.cols === "number" && p.cols >= 1) cols = p.cols;
  else if (p.cols !== undefined && p.cols !== null && p.cols !== "auto") skip("cols", "isn't a column count");
  // read as the grid's readLegacyLayout reads them: an empty zone is null
  const templates: Record<string, string> = Object.create(null);
  for (const [g, id] of Object.entries(rec("layout"))) {
    if (typeof id === "string") templates[g] = id;
    else skip("layout", "isn't a layout's name", g);
  }
  const seats: Record<string, (string | null)[]> = Object.create(null);
  for (const [g, z] of Object.entries(rec("zones"))) {
    if (Array.isArray(z)) seats[g] = z.map((k) => (typeof k === "string" ? k : null));
    else skip("zones", "isn't a list of zones", g);
  }
  const shown = strings("shown", p.shown);
  const pinned = strings("pinned", p.pinned);
  const seatsOf = (g: string) => (seats[g] ?? []).filter((k): k is string => k !== null);
  return {
    shown,
    pinned,
    trees,
    groupLayouts,
    activeGroup,
    wsTabs,
    legacy: { templates, seats, cols, groups: Object.keys(groupLayouts) },
    seatsOf,
    named: () => [...shown, ...pinned, ...Object.values(trees).flatMap(keysOf), ...Object.values(groupLayouts).flat(), ...Object.values(wsTabs), ...Object.keys(seats).flatMap(seatsOf)],
  };
}
