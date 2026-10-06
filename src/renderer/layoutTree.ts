/**
 * Where each pane sits in the grid: a split tree per group, in the spirit of
 * VS Code's editor groups. A leaf is a grid cell (its key is a session id, or
 * "ws:<group/workspace>" for a workspace pane); a split lays its children side
 * by side ("row") or stacked ("col"), each taking its share of `sizes`.
 *
 * Every tree these functions return is normalized: a split has at least two
 * children, never the direction of its parent, and sizes that are positive and
 * sum to 1. The panes on screen always fill the whole grid — removing one hands
 * its space to its siblings, so there is never an empty tile.
 */

export type Dir = "row" | "col";
export type LayoutNode = { kind: "leaf"; key: string } | { kind: "split"; dir: Dir; children: LayoutNode[]; sizes: number[] };
export type Side = "left" | "right" | "top" | "bottom";
export type Region = Side | "center";
/** A rectangle in grid fractions: x/y from the top-left, w/h of the whole grid's 1. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** The grid's size in pixels, or any unit — only the proportion matters. */
export interface Extent {
  w: number;
  h: number;
}

const TOLERANCE = 1e-6;

export const leaf = (key: string): LayoutNode => ({ kind: "leaf", key });

const even = (n: number): number[] => Array.from({ length: n }, () => 1 / n);

/** A split of these children (nulls skipped), normalized; equal sizes unless given. */
export function split(dir: Dir, children: (LayoutNode | null)[], sizes?: number[]): LayoutNode | null {
  const kept = children.map((c, i) => [c, sizes?.[i] ?? 1] as const).filter(([c]) => c !== null);
  if (!kept.length) return null;
  return normalize({ kind: "split", dir, children: kept.map(([c]) => c!), sizes: kept.map(([, s]) => s) });
}

/**
 * The tree in its normal form: one-child splits collapse into the child, a
 * split inside one of the same direction is flattened into it (its sizes
 * scaled by its share), and each split's sizes are positive and sum to 1 —
 * equal ones when the saved sizes are unusable.
 */
export function normalize(node: LayoutNode): LayoutNode {
  if (node.kind === "leaf") return node;
  const given = node.children.map((_, i) => node.sizes?.[i]);
  const usable = given.every((s) => typeof s === "number" && Number.isFinite(s) && s > 0);
  const base = usable ? (given as number[]) : even(node.children.length);
  const kids: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const c = normalize(child);
    if (c.kind === "split" && c.dir === node.dir) {
      c.children.forEach((g, j) => {
        kids.push(g);
        sizes.push(base[i] * c.sizes[j]);
      });
    } else {
      kids.push(c);
      sizes.push(base[i]);
    }
  });
  if (kids.length === 1) return kids[0];
  const total = sizes.reduce((a, b) => a + b, 0);
  return { kind: "split", dir: node.dir, children: kids, sizes: sizes.map((s) => s / total) };
}

/** A saved tree, checked: null when it isn't one (a hand-edited or older pref). */
export function asTree(v: unknown): LayoutNode | null {
  const ok = (n: any): boolean =>
    !!n &&
    ((n.kind === "leaf" && typeof n.key === "string") ||
      (n.kind === "split" && (n.dir === "row" || n.dir === "col") && Array.isArray(n.children) && n.children.length > 0 && Array.isArray(n.sizes) && n.children.every(ok)));
  if (!ok(v)) return null;
  // a key twice would put two panes in one place: the first one stays
  const seen = new Set<string>();
  let t: LayoutNode | null = v as LayoutNode;
  for (const k of keysOf(t)) {
    if (seen.has(k)) t = t && removeAt(t, k, true);
    seen.add(k);
  }
  return t && normalize(t);
}

/** The tree's leaf keys, depth first. */
export function keysOf(tree: LayoutNode | null): string[] {
  if (!tree) return [];
  return tree.kind === "leaf" ? [tree.key] : tree.children.flatMap(keysOf);
}

export function hasLeaf(tree: LayoutNode | null, key: string): boolean {
  if (!tree) return false;
  return tree.kind === "leaf" ? tree.key === key : tree.children.some((c) => hasLeaf(c, key));
}

/** Same structure, keys and sizes (to a hair). */
export function sameTree(a: LayoutNode | null, b: LayoutNode | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "leaf" || b.kind === "leaf") return a.kind === b.kind && (a as any).key === (b as any).key;
  return (
    a.dir === b.dir &&
    a.children.length === b.children.length &&
    a.children.every((c, i) => sameTree(c, b.children[i]) && Math.abs(a.sizes[i] - b.sizes[i]) < TOLERANCE)
  );
}

/** Each node's rectangle, visited from the root: `path` is the child indexes leading to it. */
function walk(tree: LayoutNode, visit: (node: LayoutNode, r: Rect, path: number[]) => void, r: Rect = { x: 0, y: 0, w: 1, h: 1 }, path: number[] = []): void {
  visit(tree, r, path);
  if (tree.kind === "leaf") return;
  const row = tree.dir === "row";
  const span = row ? r.w : r.h;
  const origin = row ? r.x : r.y;
  let off = 0;
  tree.children.forEach((c, i) => {
    const start = origin + off * span;
    off += tree.sizes[i];
    // the last child ends exactly at the parent's edge, so shared edges compare equal
    const end = i === tree.children.length - 1 ? origin + span : origin + off * span;
    walk(c, visit, row ? { x: start, y: r.y, w: end - start, h: r.h } : { x: r.x, y: start, w: r.w, h: end - start }, [...path, i]);
  });
}

/** Each pane's rectangle in grid fractions. */
export function rects(tree: LayoutNode | null): Record<string, Rect> {
  const out: Record<string, Rect> = {};
  if (tree) walk(tree, (n, r) => n.kind === "leaf" && (out[n.key] = r));
  return out;
}

/** The leaf keys top-left first, row by row — the order the pane numbers (⌘1–9) follow. */
export function readingOrder(tree: LayoutNode | null): string[] {
  const r = rects(tree);
  return keysOf(tree).sort((a, b) => (Math.abs(r[a].y - r[b].y) > TOLERANCE ? r[a].y - r[b].y : r[a].x - r[b].x));
}

/** Most panes side by side along any line across the grid: the old "column count", for pane density. */
export function maxAcross(tree: LayoutNode | null): number {
  if (!tree) return 0;
  if (tree.kind === "leaf") return 1;
  const counts = tree.children.map(maxAcross);
  return tree.dir === "row" ? counts.reduce((a, b) => a + b, 0) : Math.max(...counts);
}

function mapLeaves(tree: LayoutNode, f: (key: string) => string): LayoutNode {
  if (tree.kind === "leaf") {
    const key = f(tree.key);
    return key === tree.key ? tree : leaf(key);
  }
  return { ...tree, children: tree.children.map((c) => mapLeaves(c, f)) };
}

function removeAt(tree: LayoutNode, key: string, lastOnly = false): LayoutNode | null {
  let skip = lastOnly ? keysOf(tree).filter((k) => k === key).length - 1 : 0;
  const rm = (n: LayoutNode): LayoutNode | null => {
    if (n.kind === "leaf") {
      if (n.key !== key) return n;
      return skip-- > 0 ? n : null;
    }
    const kids: LayoutNode[] = [];
    const sizes: number[] = [];
    n.children.forEach((c, i) => {
      const r = rm(c);
      if (r) {
        kids.push(r);
        sizes.push(n.sizes[i]);
      }
    });
    return kids.length ? normalize({ kind: "split", dir: n.dir, children: kids, sizes }) : null;
  };
  return rm(tree);
}

/** The tree without `key`'s pane: its share goes to its siblings. Null when it was the last pane. */
export function remove(tree: LayoutNode | null, key: string): LayoutNode | null {
  if (!tree || !hasLeaf(tree, key)) return tree;
  return removeAt(tree, key);
}

/** `a` and `b` trade places (sizes stay with the places). */
export function swap(tree: LayoutNode, a: string, b: string): LayoutNode {
  if (a === b || !hasLeaf(tree, a) || !hasLeaf(tree, b)) return tree;
  return mapLeaves(tree, (k) => (k === a ? b : k === b ? a : k));
}

/** `from` takes the name `to` and keeps its place (a pane `to` elsewhere gives way). */
export function rename(tree: LayoutNode | null, from: string, to: string): LayoutNode | null {
  if (!tree || from === to || !hasLeaf(tree, from)) return tree;
  const t = hasLeaf(tree, to) ? remove(tree, to) : tree;
  return t && mapLeaves(t, (k) => (k === from ? to : k));
}

/** Every split's children the same size. */
export function equalize(tree: LayoutNode): LayoutNode {
  if (tree.kind === "leaf") return tree;
  return { ...tree, children: tree.children.map(equalize), sizes: even(tree.children.length) };
}

/** Replace the leaf `target` with `with(target)`. */
function replaceLeaf(tree: LayoutNode, target: string, by: (l: LayoutNode) => LayoutNode): LayoutNode {
  if (tree.kind === "leaf") return tree.key === target ? by(tree) : tree;
  return normalize({ ...tree, children: tree.children.map((c) => replaceLeaf(c, target, by)) });
}

const dirOf = (side: Side): Dir => (side === "left" || side === "right" ? "row" : "col");
const after = (side: Side) => side === "right" || side === "bottom";

/** Split the pane `target` in two on `side`, half each; the other half is `key`'s. */
function splitLeaf(tree: LayoutNode, target: string, side: Side, key: string): LayoutNode {
  return replaceLeaf(tree, target, (l) => normalize({ kind: "split", dir: dirOf(side), children: after(side) ? [l, leaf(key)] : [leaf(key), l], sizes: [0.5, 0.5] }));
}

/**
 * Put `key` beside the pane `target`, on `side`. A pane already in the tree
 * moves (its own place closes first). Beside a split running the same way, it
 * joins that split and every pane in it gets an equal share — two panes side
 * by side plus one dropped on the right make thirds; otherwise the target is
 * split in half. Unchanged when `target` isn't in the tree.
 */
export function insertBeside(tree: LayoutNode, target: string, side: Side, key: string): LayoutNode {
  if (key === target || !hasLeaf(tree, target)) return tree;
  const t = remove(tree, key);
  if (!t) return tree; // key was the only pane, so target wasn't in it
  if (t.kind === "leaf") return splitLeaf(t, target, side, key);
  const dir = dirOf(side);
  const into = (n: LayoutNode): LayoutNode => {
    if (n.kind === "leaf") return n;
    const i = n.children.findIndex((c) => c.kind === "leaf" && c.key === target);
    if (i < 0) return { ...n, children: n.children.map(into) };
    if (n.dir !== dir) return { ...n, children: n.children.map((c, j) => (j === i ? splitLeaf(c, target, side, key) : c)) };
    const children = n.children.slice();
    children.splice(after(side) ? i + 1 : i, 0, leaf(key));
    return { ...n, children, sizes: even(children.length) };
  };
  return normalize(into(t));
}

/**
 * Add `key` by the default rule: split the largest pane along its longer side,
 * measured in the grid's real proportions, so a wide grid goes side by side
 * first. Among equal largest panes the last one splits, which keeps the first
 * pane big: 1 pane is the whole grid, 2 are halves, 3 put two beside the
 * first, 4 are quadrants.
 */
export function addByDefault(tree: LayoutNode | null, key: string, grid: Extent): LayoutNode {
  if (!tree) return leaf(key);
  if (hasLeaf(tree, key)) return tree;
  const r = rects(tree);
  let best: string | null = null;
  let bestArea = -1;
  for (const k of keysOf(tree)) {
    const area = r[k].w * grid.w * r[k].h * grid.h;
    if (area >= bestArea * (1 - TOLERANCE)) {
      best = k;
      bestArea = Math.max(area, bestArea);
    }
  }
  const b = r[best!];
  return splitLeaf(tree, best!, b.w * grid.w >= b.h * grid.h ? "right" : "bottom", key);
}

/**
 * The tree for exactly `keys`: panes no longer on screen leave (their space
 * goes to their siblings) and new ones are added by the default rule, in order.
 * Null for no keys.
 */
export function reconcile(tree: LayoutNode | null, keys: string[], grid: Extent): LayoutNode | null {
  const want = new Set(keys);
  let t = tree;
  for (const k of keysOf(tree)) if (!want.has(k)) t = remove(t, k);
  for (const k of keys) t = addByDefault(t, k, grid);
  return t;
}

/** Where a pane that's about to appear lands, instead of by the default rule; `at` is when it was set. */
export interface Landing {
  at: number;
  place: (t: LayoutNode | null) => LayoutNode | null;
}

/**
 * The tree to draw for `keys`: the saved one, with each pane that isn't in it
 * yet placed by its landing (one set within `maxAge` of `now`), then
 * reconciled — so a pane renamed or moved by a change the main process makes
 * lands where it was meant to, on the render where its key first appears.
 */
export function drawTree(saved: LayoutNode | null, keys: string[], grid: Extent, landings: ReadonlyMap<string, Landing>, now: number, maxAge: number): LayoutNode | null {
  let t = saved;
  for (const k of keys) {
    const l = landings.get(k);
    if (l && now - l.at < maxAge && !hasLeaf(t, k)) t = l.place(t);
  }
  return reconcile(t, keys, grid);
}

/**
 * Whether the tree as drawn should replace the saved one. Not when all it did
 * was lose panes awaiting a relaunch: those come back under the same keys, and
 * find their places still saved.
 */
export function worthSaving(saved: LayoutNode | null, drawn: LayoutNode, awaiting: ReadonlySet<string>): boolean {
  if (sameTree(saved, drawn)) return false;
  if (!saved || keysOf(drawn).some((k) => !hasLeaf(saved, k))) return true;
  return !keysOf(saved).every((k) => hasLeaf(drawn, k) || awaiting.has(k));
}

/** Rows of `cols` panes, in order; a short last row shares the full width. */
export function evenGrid(keys: string[], cols: number): LayoutNode | null {
  const n = Math.max(1, Math.floor(cols));
  const rows: (LayoutNode | null)[] = [];
  for (let i = 0; i < keys.length; i += n) rows.push(split("row", keys.slice(i, i + n).map(leaf)));
  return split("col", rows);
}

// ---- snap layouts ---------------------------------------------------------------

/** A snap layout: a shape the current panes are arranged into once, in order. */
export interface Template {
  id: string;
  label: string;
  slots: number;
  build: (k: (string | null)[]) => LayoutNode | null;
}

const L = (k: string | null | undefined) => (k ? leaf(k) : null);
export const TEMPLATES: Template[] = [
  { id: "cols-2", label: "Two columns", slots: 2, build: ([a, b]) => split("row", [L(a), L(b)]) },
  { id: "rows-2", label: "Two rows", slots: 2, build: ([a, b]) => split("col", [L(a), L(b)]) },
  { id: "cols-3", label: "Three columns", slots: 3, build: ([a, b, c]) => split("row", [L(a), L(b), L(c)]) },
  { id: "big-left", label: "Big left, two stacked", slots: 3, build: ([a, b, c]) => split("row", [L(a), split("col", [L(b), L(c)])]) },
  { id: "big-top", label: "Big top, two below", slots: 3, build: ([a, b, c]) => split("col", [L(a), split("row", [L(b), L(c)])]) },
  { id: "quad", label: "Four quadrants", slots: 4, build: ([a, b, c, d]) => split("col", [split("row", [L(a), L(b)]), split("row", [L(c), L(d)])]) },
];

/** A template filled with placeholder keys "0", "1", … — for drawing its thumbnail. */
export const templateTree = (t: Template): LayoutNode => t.build(Array.from({ length: t.slots }, (_, i) => String(i)))!;

/**
 * Arrange `keys` into a template, in order: fewer panes than slots leave the
 * unused slots out (no empty tiles); extras are added by the default rule.
 */
export function arrange(id: string, keys: string[], grid: Extent): LayoutNode | null {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return reconcile(null, keys, grid);
  return reconcile(t.build(Array.from({ length: t.slots }, (_, i) => keys[i] ?? null)), keys, grid);
}

/**
 * The template the panes on screen look like, if any: panes in the same grid
 * cells, whatever the tree's nesting (two columns of two and two rows of two
 * are both quadrants) or the sizes they've been dragged to — as long as the
 * edges still line up the same way.
 */
export function templateOf(tree: LayoutNode | null): string | null {
  const look = (t: LayoutNode | null) => Object.values(toGrid(t).areas).sort().join(" ");
  const mine = look(tree);
  return TEMPLATES.find((t) => look(templateTree(t)) === mine)?.id ?? null;
}

// ---- rendering --------------------------------------------------------------------

/**
 * The tree as one CSS grid: tracks at every pane edge (fr sizes) and each
 * pane's grid area "row-start/col-start/row-end/col-end". Every pane stays a
 * direct child of the same grid container, so a layout change never remounts one.
 */
export function toGrid(tree: LayoutNode | null): { cols: number[]; rows: number[]; areas: Record<string, string> } {
  const r = rects(tree);
  const q = (v: number) => Math.round(v * 1e4) / 1e4;
  const edges = (pick: (x: Rect) => [number, number]) => [...new Set(Object.values(r).flatMap((x) => pick(x).map(q)))].sort((a, b) => a - b);
  const xs = edges((x) => [x.x, x.x + x.w]);
  const ys = edges((x) => [x.y, x.y + x.h]);
  const tracks = (e: number[]) => e.slice(1).map((v, i) => v - e[i]);
  const areas: Record<string, string> = {};
  for (const [k, x] of Object.entries(r)) {
    areas[k] = `${ys.indexOf(q(x.y)) + 1}/${xs.indexOf(q(x.x)) + 1}/${ys.indexOf(q(x.y + x.h)) + 1}/${xs.indexOf(q(x.x + x.w)) + 1}`;
  }
  return { cols: tracks(xs), rows: tracks(ys), areas };
}

// ---- resizing -------------------------------------------------------------------------

type Axis = "x" | "y";

function nodeAt(tree: LayoutNode, path: number[]): LayoutNode {
  return path.reduce((n, i) => (n as Extract<LayoutNode, { kind: "split" }>).children[i], tree);
}

function pathTo(tree: LayoutNode, key: string): number[] | null {
  let found: number[] | null = null;
  walk(tree, (n, _r, path) => {
    if (!found && n.kind === "leaf" && n.key === key) found = path;
  });
  return found;
}

/**
 * The boundary on `key`'s right (x) or bottom (y) edge: the nearest split
 * running that way in which the pane's branch isn't the last child.
 */
function edgeOf(tree: LayoutNode, key: string, axis: Axis): { path: number[]; index: number } | null {
  const path = pathTo(tree, key);
  if (!path) return null;
  const dir: Dir = axis === "x" ? "row" : "col";
  for (let d = path.length - 1; d >= 0; d--) {
    const n = nodeAt(tree, path.slice(0, d));
    if (n.kind === "split" && n.dir === dir && path[d] < n.children.length - 1) return { path: path.slice(0, d), index: path[d] };
  }
  return null;
}

/** Whether the pane has an edge on that side to drag (not the grid's own edge). */
export const canResize = (tree: LayoutNode | null, key: string, axis: Axis): boolean => !!tree && !!edgeOf(tree, key, axis);

/** The least extent a node can shrink to along an axis, panes being at least `min`. */
function minExtent(n: LayoutNode, axis: Axis, min: { x: number; y: number }): number {
  if (n.kind === "leaf") return min[axis];
  const m = n.children.map((c) => minExtent(c, axis, min));
  return n.dir === (axis === "x" ? "row" : "col") ? m.reduce((a, b) => a + b, 0) : Math.max(...m);
}

/**
 * Drag `key`'s right (x) or bottom (y) edge by `delta` (grid fractions): the
 * two sides of that boundary trade size, neither going below `min` per pane
 * (grid fractions too). Unchanged when the pane has no such edge or the two
 * sides can't both fit.
 */
export function resizePane(tree: LayoutNode, key: string, axis: Axis, delta: number, min: { x: number; y: number }): LayoutNode {
  const e = edgeOf(tree, key, axis);
  if (!e) return tree;
  let span = 1;
  walk(tree, (_n, r, path) => {
    if (path.length === e.path.length && path.every((p, i) => p === e.path[i])) span = axis === "x" ? r.w : r.h;
  });
  const s = nodeAt(tree, e.path) as Extract<LayoutNode, { kind: "split" }>;
  const i = e.index;
  const [a, b] = [s.sizes[i], s.sizes[i + 1]];
  const minA = minExtent(s.children[i], axis, min) / span;
  const minB = minExtent(s.children[i + 1], axis, min) / span;
  if (a + b < minA + minB) return tree;
  const na = Math.min(Math.max(a + delta / span, minA), a + b - minB);
  const sizes = s.sizes.map((v, j) => (j === i ? na : j === i + 1 ? a + b - na : v));
  const put = (n: LayoutNode, depth: number): LayoutNode => {
    if (n.kind === "leaf") return n;
    if (depth === e.path.length) return { ...n, sizes };
    return { ...n, children: n.children.map((c, j) => (j === e.path[depth] ? put(c, depth + 1) : c)) };
  };
  return put(tree, 0);
}

// ---- dragging onto the grid --------------------------------------------------------------

/**
 * Which part of a pane a point is over: the middle third both ways is
 * "center"; the rest belongs to the nearest edge, split by the pane's
 * diagonals (an X from corner to corner).
 */
export function dropRegion(r: Rect, p: { x: number; y: number }): Region {
  const u = (p.x - r.x) / r.w;
  const v = (p.y - r.y) / r.h;
  if (u >= 1 / 3 && u <= 2 / 3 && v >= 1 / 3 && v <= 2 / 3) return "center";
  const belowMain = v > u; // below the top-left → bottom-right diagonal
  const belowAnti = v > 1 - u; // below the bottom-left → top-right diagonal
  if (!belowMain && !belowAnti) return "top";
  if (belowMain && belowAnti) return "bottom";
  return belowMain ? "left" : "right";
}

/** The pane under a point (grid fractions): the one containing it, else the nearest. */
export function leafAt(tree: LayoutNode | null, p: { x: number; y: number }): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const [k, r] of Object.entries(rects(tree))) {
    const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
    const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
    const d = dx * dx + dy * dy;
    if (d < bestD) [best, bestD] = [k, d];
  }
  return best;
}

/**
 * What's being dragged, as the grid sees it. `key` is the pane it will be
 * after the drop; `from` is its pane on screen now, which moves (null when it
 * isn't on screen as a pane of its own); `tabOf` is the workspace pane on
 * screen it's a tab of, when it's being dragged out of one.
 */
export interface DragSource {
  key: string;
  from: string | null;
  tabOf?: string | null;
}

/** A drop on a pane's body, and the layout it would leave. */
export type DropPlan =
  | { kind: "split"; tree: LayoutNode; target: string; side: Side; key: string }
  | { kind: "swap"; tree: LayoutNode; target: string; key: string }
  | { kind: "tab"; tree: LayoutNode; target: string };

/**
 * A drop on `target`'s body in `region`. An edge splits the target there for
 * the dragged pane (moving it when it's on screen); the center swaps an
 * on-screen pane with the target, and makes anything else a tab of it. Null
 * when the drop would change nothing.
 */
export function planDrop(tree: LayoutNode, src: DragSource, target: string, region: Region): DropPlan | null {
  if (!hasLeaf(tree, target) || src.from === target) return null;
  if (region === "center") {
    if (src.from) return { kind: "swap", tree: swap(tree, src.from, target), target, key: src.from };
    return src.tabOf === target ? null : { kind: "tab", tree, target };
  }
  const next = insertBeside(tree, target, region, src.from ?? src.key);
  return sameTree(next, tree) ? null : { kind: "split", tree: next, target, side: region, key: src.from ?? src.key };
}

// ---- earlier layout prefs ----------------------------------------------------------------

/**
 * The layout prefs before split trees: a snap-layout template per group with
 * the pane seated in each zone (null for an empty one), and a column count
 * ("auto" grew with the panes). `groups` are the groups that existed then.
 */
export interface LegacyLayout {
  templates: Record<string, string>;
  seats: Record<string, (string | null)[]>;
  cols: number | "auto";
  groups: string[];
}

/** The old automatic column count for n panes. */
export const autoCols = (n: number): number => (n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4);

/**
 * A group's tree from the earlier prefs, the first time it's shown: its
 * template with each seated pane in its zone and the others filling the free
 * zones in order (zones left over are dropped, extra panes follow the default
 * rule); without a template, the column count as even rows. Null for a group
 * the earlier prefs never knew.
 */
export function legacyTree(legacy: LegacyLayout, group: string, keys: string[], grid: Extent): LayoutNode | null {
  if (!keys.length) return null;
  const tpl = TEMPLATES.find((t) => t.id === legacy.templates[group]);
  if (tpl) {
    const seats: (string | null)[] = Array.from({ length: tpl.slots }, (_, z) => {
      const k = legacy.seats[group]?.[z];
      return typeof k === "string" && keys.includes(k) ? k : null;
    });
    seats.forEach((k, z) => k && seats.indexOf(k) !== z && (seats[z] = null));
    const rest = keys.filter((k) => !seats.includes(k));
    return reconcile(tpl.build(seats.map((k) => k ?? rest.shift() ?? null)), keys, grid);
  }
  if (!legacy.groups.includes(group)) return null;
  return evenGrid(keys, legacy.cols === "auto" ? autoCols(keys.length) : legacy.cols);
}

/** Leaf keys across a group rename: workspace panes ("ws:<path>") under `oldKey` move to `newKey`. */
export function renameWorkspaces(tree: LayoutNode, oldKey: string, newKey: string): LayoutNode {
  return mapLeaves(tree, (k) => {
    if (!k.startsWith("ws:")) return k;
    const p = k.slice(3);
    return p === oldKey || p.startsWith(oldKey + "/") ? `ws:${newKey}${p.slice(oldKey.length)}` : k;
  });
}
