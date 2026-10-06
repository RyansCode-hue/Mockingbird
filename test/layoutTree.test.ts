import { describe, expect, it } from "vitest";
import {
  addByDefault,
  arrange,
  asTree,
  canResize,
  drawTree,
  dropRegion,
  equalize,
  evenGrid,
  hasLeaf,
  insertBeside,
  keysOf,
  leaf,
  leafAt,
  legacyTree,
  maxAcross,
  normalize,
  planDrop,
  readingOrder,
  reconcile,
  rects,
  remove,
  rename,
  renameWorkspaces,
  resizePane,
  sameTree,
  split,
  swap,
  templateOf,
  toGrid,
  TEMPLATES,
  type LayoutNode,
  type LegacyLayout,
  worthSaving,
} from "../src/renderer/layoutTree";

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
    expect(sameTree(asTree(JSON.parse(JSON.stringify(t))), t)).toBe(true);
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

describe("putting a pane beside another", () => {
  it("halves a lone pane", () => {
    expect(pic(insertBeside(a, "a", "right", "b"))).toBe("row(a,b)");
    expect(pic(insertBeside(a, "a", "left", "b"))).toBe("row(b,a)");
    expect(pic(insertBeside(a, "a", "bottom", "b"))).toBe("col(a,b)");
    expect(pic(insertBeside(a, "a", "top", "b"))).toBe("col(b,a)");
  });
  it("makes thirds beside two side by side, evening out the whole split", () => {
    expect(pic(insertBeside(row(a, b), "b", "right", "c"))).toBe("row(a,b,c)");
    expect(pic(insertBeside(split("row", [a, b], [0.7, 0.3])!, "a", "right", "c"))).toBe("row(a,c,b)");
  });
  it("splits the target in half across its parent's direction", () => {
    expect(pic(insertBeside(row(a, b), "b", "bottom", "c"))).toBe("row(a,col(b,c))");
    expect(pic(insertBeside(split("row", [a, b], [0.7, 0.3])!, "b", "top", "c"))).toBe("row(a,col(c,b))[70,30]");
  });
  it("moves a pane already in the tree, closing its old place first", () => {
    expect(pic(insertBeside(row(a, b, c), "c", "bottom", "a"))).toBe("row(b,col(c,a))");
    expect(pic(insertBeside(row(a, b), "b", "bottom", "a"))).toBe("col(b,a)");
  });
  it("changes nothing for a missing target or a pane beside itself", () => {
    const t = row(a, b);
    expect(insertBeside(t, "x", "left", "c")).toBe(t);
    expect(insertBeside(t, "a", "left", "a")).toBe(t);
  });
});

describe("swapping, renaming, evening out", () => {
  it("swaps two panes, sizes staying with the places", () => {
    expect(pic(swap(split("row", [a, b], [0.7, 0.3])!, "a", "b"))).toBe("row(b,a)[70,30]");
    const t = row(a, b);
    expect(swap(t, "a", "x")).toBe(t);
  });
  it("renames a pane in place (a lone pane becoming a workspace keeps its spot)", () => {
    expect(pic(rename(row(a, col(b, c)), "b", "ws:5101/api"))).toBe("row(a,col(ws:5101/api,c))");
    // a pane already called that gives way
    expect(pic(rename(row(a, b, c), "a", "c"))).toBe("row(c,b)");
  });
  it("evens out every split", () => {
    expect(pic(equalize(split("row", [a, split("col", [b, c], [0.9, 0.1])], [0.2, 0.8])!))).toBe("row(a,col(b,c))");
  });
  it("renames workspace panes under a renamed group, leaving lookalikes alone", () => {
    const t = row(leaf("ws:5038/api"), leaf("ws:50380/x"), leaf("s1"));
    expect(keysOf(renameWorkspaces(t, "5038", "orgs"))).toEqual(["ws:orgs/api", "ws:50380/x", "s1"]);
    expect(keysOf(renameWorkspaces(t, "5038/api", "5038/web"))).toEqual(["ws:5038/web", "ws:50380/x", "s1"]);
  });
});

describe("snap layouts and even grids", () => {
  it("arranges the panes in order into each template", () => {
    const k = ["a", "b", "c", "d"];
    expect(pic(arrange("cols-2", k.slice(0, 2), WIDE))).toBe("row(a,b)");
    expect(pic(arrange("rows-2", k.slice(0, 2), WIDE))).toBe("col(a,b)");
    expect(pic(arrange("cols-3", k.slice(0, 3), WIDE))).toBe("row(a,b,c)");
    expect(pic(arrange("big-left", k.slice(0, 3), WIDE))).toBe("row(a,col(b,c))");
    expect(pic(arrange("big-top", k.slice(0, 3), WIDE))).toBe("col(a,row(b,c))");
    expect(pic(arrange("quad", k, WIDE))).toBe("col(row(a,b),row(c,d))");
  });
  it("leaves out slots it has no pane for, and adds extras by the default rule", () => {
    expect(pic(arrange("quad", ["a", "b", "c"], WIDE))).toBe("col(row(a,b),c)");
    expect(pic(arrange("big-left", ["a"], WIDE))).toBe("a");
    expect(pic(arrange("cols-2", ["a", "b", "c"], WIDE))).toBe("row(a,col(b,c))");
  });
  it("knows which template the panes look like, if any", () => {
    for (const t of TEMPLATES) expect(templateOf(arrange(t.id, ["p", "q", "r", "s"].slice(0, t.slots), WIDE))).toBe(t.id);
    expect(templateOf(a)).toBeNull();
    expect(templateOf(row(a, b, c, d))).toBeNull();
    // the default rule's four panes are two columns of two: quadrants all the same
    expect(templateOf(row(col(a, d), col(b, c)))).toBe("quad");
    // resized, two columns are still two columns
    expect(templateOf(split("row", [a, b], [0.7, 0.3]))).toBe("cols-2");
    // but quadrants whose rows no longer line up aren't quadrants
    expect(templateOf(split("row", [split("col", [a, d], [0.4, 0.6])!, col(b, c)]))).toBeNull();
  });
  it("lays panes out in rows of N, a short last row sharing the full width", () => {
    expect(pic(evenGrid(["a", "b", "c"], 2))).toBe("col(row(a,b),c)");
    expect(pic(evenGrid(["a", "b", "c", "d", "e"], 3))).toBe("col(row(a,b,c),row(d,e))");
    expect(pic(evenGrid(["a", "b"], 1))).toBe("col(a,b)");
    expect(pic(evenGrid(["a", "b"], 4))).toBe("row(a,b)");
    expect(evenGrid([], 2)).toBeNull();
  });
});

describe("reading order and density", () => {
  it("numbers panes top-left first, row by row", () => {
    expect(readingOrder(row(col(a, d), col(b, c)))).toEqual(["a", "b", "d", "c"]);
    expect(readingOrder(row(a, col(b, c)))).toEqual(["a", "b", "c"]);
    expect(readingOrder(col(row(c, a), b))).toEqual(["c", "a", "b"]);
  });
  it("counts the most panes side by side, as the old column count did", () => {
    expect(maxAcross(row(a, col(b, c)))).toBe(2);
    expect(maxAcross(col(row(a, b, c), d))).toBe(3);
    expect(maxAcross(a)).toBe(1);
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

describe("resizing from a pane's edge", () => {
  const min = { x: 0.05, y: 0.05 };
  it("moves the nearest boundary on that side: the two sides trade size", () => {
    const t = row(a, col(b, c));
    expect(pic(resizePane(t, "a", "x", 0.1, min))).toBe("row(a,col(b,c))[60,40]");
    // b's bottom edge is the b|c boundary, inside the right half
    expect(pic(resizePane(t, "b", "y", -0.2, min))).toBe("row(a,col(b,c)[30,70])");
  });
  it("reaches past splits running the other way to the boundary that's there", () => {
    const t = col(row(a, b), row(c, d));
    expect(pic(resizePane(t, "b", "y", 0.1, min))).toBe("col(row(a,b),row(c,d))[60,40]");
  });
  it("has no handle on the grid's own edges", () => {
    const t = row(a, col(b, c));
    expect(canResize(t, "a", "x")).toBe(true);
    expect(canResize(t, "b", "x")).toBe(false); // b's right edge is the grid's
    expect(canResize(t, "c", "y")).toBe(false);
    expect(canResize(t, "b", "y")).toBe(true);
    expect(resizePane(t, "c", "y", 0.1, min)).toBe(t);
  });
  it("stops at the minimum size, counting every pane the side holds", () => {
    const t = row(a, b, c);
    const r = resizePane(t, "a", "x", 0.9, min) as any;
    expect(r.sizes[1]).toBeCloseTo(0.05);
    // the right half holds two panes side by side, so it keeps two minimums
    const nested = split("row", [a, split("col", [row(b, c), d])], [0.5, 0.5])!;
    expect((resizePane(nested, "a", "x", 0.9, min) as any).sizes[1]).toBeCloseTo(0.1);
  });
});

describe("dropping onto a pane", () => {
  const r = { x: 0.5, y: 0, w: 0.5, h: 1 };
  it("finds the center (the middle third both ways) and each edge by the diagonals", () => {
    expect(dropRegion(r, { x: 0.75, y: 0.5 })).toBe("center");
    expect(dropRegion(r, { x: 0.98, y: 0.5 })).toBe("right");
    expect(dropRegion(r, { x: 0.52, y: 0.5 })).toBe("left");
    expect(dropRegion(r, { x: 0.75, y: 0.05 })).toBe("top");
    expect(dropRegion(r, { x: 0.75, y: 0.95 })).toBe("bottom");
    // near the top-right corner the nearer edge wins
    expect(dropRegion(r, { x: 0.99, y: 0.1 })).toBe("right");
    expect(dropRegion(r, { x: 0.9, y: 0.01 })).toBe("top");
  });
  it("finds the pane under the pointer, or the nearest one in a gap", () => {
    const t = row(a, col(b, c));
    expect(leafAt(t, { x: 0.2, y: 0.9 })).toBe("a");
    expect(leafAt(t, { x: 0.7, y: 0.7 })).toBe("c");
    expect(leafAt(t, { x: 1.01, y: 0.1 })).toBe("b");
  });
  it("splits one pane in half for a new session, and makes thirds beside two", () => {
    expect(pic(planDrop(a, { key: "b", from: null }, "a", "right")!.tree)).toBe("row(a,b)");
    expect(pic(planDrop(a, { key: "b", from: null }, "a", "bottom")!.tree)).toBe("col(a,b)");
    expect(pic(planDrop(row(a, b), { key: "c", from: null }, "b", "right")!.tree)).toBe("row(a,b,c)");
  });
  it("moves a pane on screen, or swaps it in the center", () => {
    expect(pic(planDrop(row(a, b, c), { key: "a", from: "a" }, "c", "bottom")!.tree)).toBe("row(b,col(c,a))");
    const s = planDrop(row(a, b), { key: "a", from: "a" }, "b", "center")!;
    expect([s.kind, pic(s.tree)]).toEqual(["swap", "row(b,a)"]);
  });
  it("makes a session that isn't a pane of its own a tab in the center", () => {
    const t = row(a, b);
    expect(planDrop(t, { key: "x", from: null }, "b", "center")).toEqual({ kind: "tab", tree: t, target: "b" });
  });
  it("splits a workspace for one of its own tabs dragged to its edge", () => {
    expect(pic(planDrop(leaf("ws:g/w"), { key: "s2", from: null, tabOf: "ws:g/w" }, "ws:g/w", "right")!.tree)).toBe("row(ws:g/w,s2)");
  });
  it("offers nothing that wouldn't change the layout", () => {
    expect(planDrop(row(a, b), { key: "a", from: "a" }, "a", "right")).toBeNull();
    expect(planDrop(row(a, b), { key: "a", from: "a" }, "b", "left")).toBeNull(); // already left of b
    expect(planDrop(row(a, b), { key: "x", from: null, tabOf: "b" }, "b", "center")).toBeNull();
    expect(planDrop(row(a, b), { key: "x", from: null }, "gone", "left")).toBeNull();
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

describe("panes the main process is about to add or rekey", () => {
  const now = 1_000_000;
  const land = (place: (t: LayoutNode | null) => LayoutNode | null, at = now) => ({ at, place });
  it("land where they were meant to on the render their key appears, not by the default rule", () => {
    // a tab dragged out of a workspace to the left of b: its own key appears with its new group
    const landings = new Map([["s3", land((t) => t && insertBeside(t, "b", "left", "s3"))]]);
    expect(pic(drawTree(row(a, b), ["a", "b", "s3"], WIDE, landings, now, 10_000))).toBe("row(a,s3,b)");
    expect(pic(drawTree(row(a, b), ["a", "b", "s3"], WIDE, new Map(), now, 10_000))).toBe("row(a,col(b,s3))");
  });
  it("keep a lone pane's place when it becomes a workspace", () => {
    const landings = new Map([["ws:g/tabs", land((t) => rename(t, "b", "ws:g/tabs"))]]);
    // b's key is gone and the workspace's has appeared, in the same render
    expect(pic(drawTree(row(b, a), ["ws:g/tabs", "a"], WIDE, landings, now, 10_000))).toBe("row(ws:g/tabs,a)");
  });
  it("wait while the key hasn't appeared, and lapse after a while", () => {
    const place = (t: LayoutNode | null) => t && insertBeside(t, "a", "left", "s3");
    expect(pic(drawTree(row(a, b), ["a", "b"], WIDE, new Map([["s3", land(place)]]), now, 10_000))).toBe("row(a,b)");
    expect(pic(drawTree(row(a, b), ["a", "b", "s3"], WIDE, new Map([["s3", land(place, now - 20_000)]]), now, 10_000))).toBe("row(a,col(b,s3))");
  });
});

describe("saving the tree as drawn", () => {
  const none = new Set<string>();
  it("saves panes added by the default rule, and panes that left", () => {
    expect(worthSaving(row(a, b), row(a, col(b, c)), none)).toBe(true);
    expect(worthSaving(row(a, b), a, none)).toBe(true);
    expect(worthSaving(null, a, none)).toBe(true);
    expect(worthSaving(row(a, b), row(a, b), none)).toBe(false);
  });
  it("keeps the places of panes awaiting a relaunch, which come back under the same keys", () => {
    expect(worthSaving(row(a, col(b, c)), row(a, b), new Set(["c"]))).toBe(false);
    // anything else changing saves, and then they come back by the default rule
    expect(worthSaving(row(a, col(b, c)), row(a, d), new Set(["b", "c"]))).toBe(true);
  });
});

describe("the invariants hold through any sequence of changes", () => {
  it("stays normalized and tiles the grid", () => {
    let t: LayoutNode | null = null;
    const keys = ["a", "b", "c", "d", "e", "f"];
    const sides = ["left", "right", "top", "bottom"] as const;
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
    for (let i = 0; i < 400; i++) {
      const k = keys[rnd(keys.length)];
      const present = keysOf(t);
      const op = rnd(5);
      if (op === 0 || !t) t = addByDefault(t, k, rnd(2) ? WIDE : TALL);
      else if (op === 1) t = remove(t, k);
      else if (op === 2 && present.length) t = insertBeside(t, present[rnd(present.length)], sides[rnd(4)], k);
      else if (op === 3 && present.length > 1) t = swap(t, present[0], present[present.length - 1]);
      else if (t) t = resizePane(t, present[rnd(present.length)], rnd(2) ? "x" : "y", (rnd(41) - 20) / 100, { x: 0.02, y: 0.02 });
      expect(normalizedEverywhere(t)).toBe(true);
      if (t) expect(tiles(t)).toBe(true);
      expect(new Set(keysOf(t)).size).toBe(keysOf(t).length);
      expect(keysOf(t).every((x) => hasLeaf(t, x))).toBe(true);
    }
  });
});
