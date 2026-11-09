/**
 * The grid's saved layout (1.6 and before), as the landscape's migration reads
 * it (landscapeMigrate.ts): a split tree per group, `mb.trees`, whose leaves are
 * grid cells (a session id, or "ws:<group/workspace>" for a workspace pane); a
 * split lays its children side by side ("row") or stacked ("col"), each taking
 * its share of `sizes`. The earlier prefs (`mb.layout`, `mb.zones`, `mb.cols`)
 * are read into a tree the same way the grid did.
 *
 * Every tree these functions return is normalized: a split has at least two
 * children, never the direction of its parent, and sizes that are positive and
 * sum to 1. The panes always fill the whole grid: removing one hands its space
 * to its siblings, so there is never an empty tile.
 */

import { splitGroupKey } from "./types";

type Dir = "row" | "col";
export type LayoutNode = { kind: "leaf"; key: string } | { kind: "split"; dir: Dir; children: LayoutNode[]; sizes: number[] };
type Side = "left" | "right" | "top" | "bottom";
/** A rectangle in grid fractions: x/y from the top-left, w/h of the whole grid's 1. */
interface Rect {
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

/** Each node's rectangle, visited from the root. */
function walk(tree: LayoutNode, visit: (node: LayoutNode, r: Rect) => void, r: Rect = { x: 0, y: 0, w: 1, h: 1 }): void {
  visit(tree, r);
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
    walk(c, visit, row ? { x: start, y: r.y, w: end - start, h: r.h } : { x: r.x, y: start, w: r.w, h: end - start });
  });
}

/** Each pane's rectangle in grid fractions. */
export function rects(tree: LayoutNode | null): Record<string, Rect> {
  const out: Record<string, Rect> = {};
  if (tree) walk(tree, (n, r) => n.kind === "leaf" && (out[n.key] = r));
  return out;
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

/** `from` takes the name `to` and keeps its place (a pane `to` elsewhere gives way). */
export function rename(tree: LayoutNode | null, from: string, to: string): LayoutNode | null {
  if (!tree || from === to || !hasLeaf(tree, from)) return tree;
  const t = hasLeaf(tree, to) ? remove(tree, to) : tree;
  return t && mapLeaves(t, (k) => (k === from ? to : k));
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

/** Rows of `cols` panes, in order; a short last row shares the full width. */
export function evenGrid(keys: string[], cols: number): LayoutNode | null {
  const n = Math.max(1, Math.floor(cols));
  const rows: (LayoutNode | null)[] = [];
  for (let i = 0; i < keys.length; i += n) rows.push(split("row", keys.slice(i, i + n).map(leaf)));
  return split("col", rows);
}

// ---- the snap layouts `mb.layout` names -------------------------------------------

/** A snap layout: a shape the panes were arranged into, in order. */
interface Template {
  id: string;
  slots: number;
  build: (k: (string | null)[]) => LayoutNode | null;
}

const L = (k: string | null | undefined) => (k ? leaf(k) : null);
const TEMPLATES: Template[] = [
  { id: "cols-2", slots: 2, build: ([a, b]) => split("row", [L(a), L(b)]) },
  { id: "rows-2", slots: 2, build: ([a, b]) => split("col", [L(a), L(b)]) },
  { id: "cols-3", slots: 3, build: ([a, b, c]) => split("row", [L(a), L(b), L(c)]) },
  { id: "big-left", slots: 3, build: ([a, b, c]) => split("row", [L(a), split("col", [L(b), L(c)])]) },
  { id: "big-top", slots: 3, build: ([a, b, c]) => split("col", [L(a), split("row", [L(b), L(c)])]) },
  { id: "quad", slots: 4, build: ([a, b, c, d]) => split("col", [split("row", [L(a), L(b)]), split("row", [L(c), L(d)])]) },
];

// ---- as the grid drew it ------------------------------------------------------------

/**
 * The tree as one CSS grid, as the grid drew it: tracks at every pane edge (fr
 * sizes) and each pane's grid area "row-start/col-start/row-end/col-end".
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
const autoCols = (n: number): number => (n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4);

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

/** How the grid named the cell of session `id` in `group`: "ws:<top>/<sub>" inside a workspace, else the id. */
export function cellKeyFor(id: string, group: string | null | undefined): string {
  const { top, sub } = splitGroupKey(group ?? "ungrouped");
  return sub ? `ws:${top}/${sub}` : id;
}

/**
 * The group the grid showed (`mb.activeGroup` is the one it was last switched
 * to): that one while any of its sessions are still on screen, else the first
 * unpinned pane's group (a pinned pane from another group never decided it).
 * With only pinned panes left it stays the last group if one of them belongs to
 * it, else the first pane's. `groupOf` gives a session's top-level group, or
 * undefined for an id that isn't live.
 */
export function activeGroupOf(shown: string[], groupOf: (id: string) => string | undefined, pinned: ReadonlySet<string>, last: string | null): string | null {
  if (last && shown.some((id) => groupOf(id) === last && !pinned.has(id))) return last;
  const live = shown.filter((id) => groupOf(id) !== undefined);
  const unpinned = live.find((id) => !pinned.has(id));
  if (unpinned) return groupOf(unpinned)!;
  if (last && live.some((id) => groupOf(id) === last)) return last;
  return live.length ? groupOf(live[0])! : null;
}
