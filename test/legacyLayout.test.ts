import { describe, expect, it } from "vitest";
import {
  activeGroupOf,
  addByDefault,
  asTree,
  cellKeyFor,
  evenGrid,
  hasLeaf,
  keysOf,
  leaf,
  legacyTree,
  normalize,
  reconcile,
  rects,
  remove,
  rename,
  split,
  toGrid,
  type LayoutNode,
  type LegacyLayout,
} from "../src/shared/legacyLayout";

// The grid's saved layout (1.6 and before), read with its own rules: what the landscape's migration reads trees with.

const WIDE = { w: 1600, h: 900 };
const TALL = { w: 700, h: 1100 };
const row = (...c: LayoutNode[]) => split("row", c)!;
const col = (...c: LayoutNode[]) => split("col", c)!;
const [a, b, c, d] = ["a", "b", "c", "d"].map(leaf);

/** A compact picture of a tree: row(a,col(b,c)) with sizes in percent where uneven. */
const pic = (t: LayoutNode | null): string => {
  if (!t) return "∅";
  if (t.kind === "leaf") return t.key;
  const even = t.sizes.every((s) => Math.abs(s - 1 / t.sizes.length) < 1e-9);
  return `${t.dir}(${t.children.map(pic).join(",")})${even ? "" : `[${t.sizes.map((s) => Math.round(s * 100)).join(",")}]`}`;
};

/** Every split normalized: 2+ children, not its parent's direction, positive sizes summing to 1. */
const normalizedEverywhere = (t: LayoutNode | null, parent?: string): boolean => {
  if (!t || t.kind === "leaf") return true;
  const sum = t.sizes.reduce((x, y) => x + y, 0);
  return (
    t.children.length >= 2 &&
    t.children.length === t.sizes.length &&
    t.dir !== parent &&
    t.sizes.every((s) => s > 0) &&
    Math.abs(sum - 1) < 1e-9 &&
    t.children.every((ch) => normalizedEverywhere(ch, t.dir))
  );
};

/** The panes' rectangles tile the grid exactly: no holes, no overlaps. */
const tiles = (t: LayoutNode | null): boolean => {
  const r = Object.values(rects(t));
  const area = r.reduce((s, x) => s + x.w * x.h, 0);
  return r.every((x) => x.x >= -1e-9 && x.y >= -1e-9 && x.x + x.w <= 1 + 1e-9 && x.y + x.h <= 1 + 1e-9) && Math.abs(area - 1) < 1e-9;
};

describe("normal form", () => {
  it("collapses a one-child split into the child", () => {
    expect(normalize({ kind: "split", dir: "row", children: [a], sizes: [1] })).toEqual(a);
    expect(normalize({ kind: "split", dir: "row", children: [{ kind: "split", dir: "col", children: [b], sizes: [1] }, c], sizes: [0.5, 0.5] })).toEqual(row(b, c));
  });
  it("flattens a split into a parent running the same way, scaling its sizes", () => {
    const t = normalize({ kind: "split", dir: "row", children: [a, { kind: "split", dir: "row", children: [b, c], sizes: [0.5, 0.5] }], sizes: [0.5, 0.5] });
    expect(pic(t)).toBe("row(a,b,c)[50,25,25]");
  });
  it("makes sizes positive and sum to 1, and replaces unusable ones with equal shares", () => {
    expect((normalize({ kind: "split", dir: "row", children: [a, b], sizes: [2, 6] }) as any).sizes).toEqual([0.25, 0.75]);
    expect((normalize({ kind: "split", dir: "row", children: [a, b], sizes: [0, 1] }) as any).sizes).toEqual([0.5, 0.5]);
    expect((normalize({ kind: "split", dir: "row", children: [a, b, c], sizes: [1] }) as any).sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });
  it("reads a saved tree back, and rejects anything that isn't one", () => {
    const t = row(a, col(b, c));
    expect(asTree(JSON.parse(JSON.stringify(t)))).toEqual(t);
    expect(asTree(null)).toBeNull();
    expect(asTree({ kind: "split", dir: "diagonal", children: [a], sizes: [1] })).toBeNull();
    expect(asTree({ kind: "split", dir: "row", children: [], sizes: [] })).toBeNull();
    expect(asTree({ kind: "leaf" })).toBeNull();
  });
  it("keeps only the first of a key saved twice, so two panes never share a place", () => {
    const t = asTree({ kind: "split", dir: "row", children: [a, b, a], sizes: [1, 1, 1] });
    expect(keysOf(t)).toEqual(["a", "b"]);
  });
});

describe("the default rule", () => {
  const grow = (keys: string[], grid = WIDE) => keys.reduce<LayoutNode | null>((t, k) => addByDefault(t, k, grid), null);
  it("fills the grid: 1 pane whole, 2 halves, 3 two beside the first, 4 quadrants", () => {
    expect(pic(grow(["a"]))).toBe("a");
    expect(pic(grow(["a", "b"]))).toBe("row(a,b)");
    expect(pic(grow(["a", "b", "c"]))).toBe("row(a,col(b,c))");
    const four = grow(["a", "b", "c", "d"]);
    expect(pic(four)).toBe("row(col(a,d),col(b,c))");
    for (const r of Object.values(rects(four))) expect([r.w, r.h]).toEqual([0.5, 0.5]);
  });
  it("goes side by side first on a wide grid and stacked first on a tall one", () => {
    expect(pic(grow(["a", "b"], TALL))).toBe("col(a,b)");
  });
  it("splits the largest pane, measured in the grid's proportions", () => {
    // b is the bigger pane (1120×900, wider than tall): it splits side by side, not a
    expect(pic(addByDefault(split("row", [a, b], [0.3, 0.7]), "c", WIDE))).toBe("row(a,b,c)[30,35,35]");
    // on a tall grid the same b is taller than wide, so it splits top and bottom
    expect(pic(addByDefault(split("row", [a, b], [0.3, 0.7]), "c", TALL))).toBe("row(a,col(b,c))[30,70]");
  });
});

describe("reconciling with the panes on screen", () => {
  it("drops panes no longer shown, giving their space to their siblings, and never leaves a hole", () => {
    const t = row(a, col(b, c));
    expect(pic(reconcile(t, ["a", "c"], WIDE))).toBe("row(a,c)");
    expect(pic(reconcile(t, ["b"], WIDE))).toBe("b");
    expect(reconcile(t, [], WIDE)).toBeNull();
    for (const keys of [["a"], ["a", "b"], ["c", "a"], ["a", "b", "c", "x"], ["x", "y", "z", "w", "v"]]) {
      const r = reconcile(t, keys, WIDE);
      expect(keysOf(r).sort()).toEqual([...keys].sort());
      expect(tiles(r)).toBe(true);
      expect(normalizedEverywhere(r)).toBe(true);
    }
  });
  it("adds new panes by the default rule and leaves the rest where they were", () => {
    const t = row(b, a);
    expect(pic(reconcile(t, ["a", "b", "c"], WIDE))).toBe("row(b,col(a,c))");
  });
  it("hands a closed pane's share to its siblings in proportion", () => {
    expect(pic(remove(split("row", [a, b, c], [0.5, 0.25, 0.25]), "c"))).toBe("row(a,b)[67,33]");
  });
});

describe("renaming a pane", () => {
  it("renames a pane in place (a lone pane becoming a workspace keeps its spot)", () => {
    expect(pic(rename(row(a, col(b, c)), "b", "ws:5101/api"))).toBe("row(a,col(ws:5101/api,c))");
    // a pane already called that gives way
    expect(pic(rename(row(a, b, c), "a", "c"))).toBe("row(c,b)");
  });
});

describe("snap layouts and even grids", () => {
  const into = (id: string, keys: string[]) => legacyTree({ templates: { g: id }, seats: {}, cols: "auto", groups: [] }, "g", keys, WIDE);
  it("reads each snap layout mb.layout names as its shape, the panes in order", () => {
    const k = ["a", "b", "c", "d"];
    expect(pic(into("cols-2", k.slice(0, 2)))).toBe("row(a,b)");
    expect(pic(into("rows-2", k.slice(0, 2)))).toBe("col(a,b)");
    expect(pic(into("cols-3", k.slice(0, 3)))).toBe("row(a,b,c)");
    expect(pic(into("big-left", k.slice(0, 3)))).toBe("row(a,col(b,c))");
    expect(pic(into("big-top", k.slice(0, 3)))).toBe("col(a,row(b,c))");
    expect(pic(into("quad", k))).toBe("col(row(a,b),row(c,d))");
  });
  it("leaves out slots it has no pane for, and adds extras by the default rule", () => {
    expect(pic(into("quad", ["a", "b", "c"]))).toBe("col(row(a,b),c)");
    expect(pic(into("big-left", ["a"]))).toBe("a");
    expect(pic(into("cols-2", ["a", "b", "c"]))).toBe("row(a,col(b,c))");
  });
  it("lays panes out in rows of N, a short last row sharing the full width", () => {
    expect(pic(evenGrid(["a", "b", "c"], 2))).toBe("col(row(a,b),c)");
    expect(pic(evenGrid(["a", "b", "c", "d", "e"], 3))).toBe("col(row(a,b,c),row(d,e))");
    expect(pic(evenGrid(["a", "b"], 1))).toBe("col(a,b)");
    expect(pic(evenGrid(["a", "b"], 4))).toBe("row(a,b)");
    expect(evenGrid([], 2)).toBeNull();
  });
});

describe("rendering as one CSS grid", () => {
  it("puts tracks at pane edges and gives each pane its area", () => {
    expect(toGrid(row(a, col(b, c)))).toEqual({ cols: [0.5, 0.5], rows: [0.5, 0.5], areas: { a: "1/1/3/2", b: "1/2/2/3", c: "2/2/3/3" } });
    expect(toGrid(a)).toEqual({ cols: [1], rows: [1], areas: { a: "1/1/2/2" } });
  });
  it("adds a track where rows split at different places", () => {
    const g = toGrid(col(split("row", [a, b], [0.3, 0.7])!, split("row", [c, d], [0.6, 0.4])!));
    expect(g.cols.map((x) => Math.round(x * 100))).toEqual([30, 30, 40]);
    expect(g.areas).toEqual({ a: "1/1/2/2", b: "1/2/2/4", c: "2/1/3/3", d: "2/3/3/4" });
  });
});

describe("the layout prefs from before split trees", () => {
  const legacy: LegacyLayout = {
    templates: { "5101": "big-left", "5102": "quad" },
    seats: { "5101": [null, "s1", "ws:5101/api"] },
    cols: 3,
    groups: ["5101", "5102", "5103"],
  };
  it("turns a template with seats into that shape, seated panes in their zones and the rest filling in", () => {
    expect(pic(legacyTree(legacy, "5101", ["s1", "ws:5101/api", "s4"], WIDE))).toBe("row(s4,col(s1,ws:5101/api))");
  });
  it("drops zones nobody fills and adds panes beyond the template by the default rule", () => {
    expect(pic(legacyTree(legacy, "5102", ["x", "y", "z"], WIDE))).toBe("col(row(x,y),z)");
    expect(pic(legacyTree(legacy, "5101", ["s1"], WIDE))).toBe("s1");
  });
  it("turns the column preference into rows for a group without a template", () => {
    expect(pic(legacyTree(legacy, "5103", ["a", "b", "c", "d"], WIDE))).toBe("col(row(a,b,c),d)");
    expect(pic(legacyTree({ ...legacy, cols: "auto" }, "5103", ["a", "b", "c"], WIDE))).toBe("col(row(a,b),c)");
  });
  it("leaves groups it never knew to the default rule", () => {
    expect(legacyTree(legacy, "9999", ["a", "b"], WIDE)).toBeNull();
    expect(legacyTree(legacy, "5101", [], WIDE)).toBeNull();
  });
});

describe("the invariants hold through any sequence of changes", () => {
  it("stays normalized and tiles the grid", () => {
    let t: LayoutNode | null = null;
    const keys = ["a", "b", "c", "d", "e", "f"];
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
    for (let i = 0; i < 400; i++) {
      const k = keys[rnd(keys.length)];
      const present = keysOf(t);
      const op = rnd(5);
      if (op === 0 || !t) t = addByDefault(t, k, rnd(2) ? WIDE : TALL);
      else if (op === 1) t = remove(t, k);
      else if (op === 2 && present.length) t = rename(t, present[rnd(present.length)], k);
      else if (op === 3) t = reconcile(t, keys.filter(() => rnd(2)), rnd(2) ? WIDE : TALL);
      else if (present.length) t = asTree(JSON.parse(JSON.stringify(t)));
      expect(normalizedEverywhere(t)).toBe(true);
      if (t) expect(tiles(t)).toBe(true);
      expect(new Set(keysOf(t)).size).toBe(keysOf(t).length);
      expect(keysOf(t).every((x) => hasLeaf(t, x))).toBe(true);
    }
  });
});

describe("the group the grid showed", () => {
  const groups: Record<string, string> = { a1: "A", a2: "A", a3: "A", b1: "B", b2: "B", c1: "C" };
  const groupOf = (id: string) => groups[id];
  const none = new Set<string>();
  it("stays the group the grid was switched to while any of its panes are shown", () => {
    // a1 just moved to B: the grid is still showing A
    const moved = (id: string) => (id === "a1" ? "B" : groups[id]);
    expect(activeGroupOf(["a1", "a2"], moved, none, "A")).toBe("A");
  });
  it("follows the panes once none of the remembered group's are left", () => {
    expect(activeGroupOf(["b1"], groupOf, none, "A")).toBe("B");
  });
  it("moves on from a group whose only pane left is pinned", () => {
    expect(activeGroupOf(["a1", "b1"], groupOf, new Set(["a1"]), "A")).toBe("B");
  });
  it("is never decided by a pinned pane from another group", () => {
    expect(activeGroupOf(["c1", "a1"], groupOf, new Set(["c1"]), null)).toBe("A");
    expect(activeGroupOf(["c1"], groupOf, new Set(["c1"]), null)).toBe("C");
  });
  it("stays the last group when every pane on screen is pinned and one of them is its own", () => {
    const all = new Set(["c1", "a1"]);
    expect(activeGroupOf(["c1", "a1"], groupOf, all, "A")).toBe("A");
    expect(activeGroupOf(["c1", "a1"], groupOf, all, "B")).toBe("C");
    expect(activeGroupOf(["c1", "a1"], groupOf, all, null)).toBe("C");
  });
  it("ignores ids that aren't live, and is null for an empty grid", () => {
    expect(activeGroupOf(["gone", "b2"], groupOf, none, null)).toBe("B");
    expect(activeGroupOf([], groupOf, none, "A")).toBeNull();
  });
});

describe("a session's cell key", () => {
  it("is the workspace for a session in one, else the session itself", () => {
    expect(cellKeyFor("s1", "5038/api")).toBe("ws:5038/api");
    expect(cellKeyFor("s1", "5038")).toBe("s1");
    expect(cellKeyFor("s1", null)).toBe("s1");
    expect(cellKeyFor("s1", undefined)).toBe("s1");
  });
});
