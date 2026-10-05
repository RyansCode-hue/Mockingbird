import { describe, expect, it } from "vitest";
import { activeGroupOf, dropInZone, layoutToRemember, overflowArea, placeInZones, pruneToGroup, seating, switchTo } from "../src/renderer/gridModel";

const groups: Record<string, string> = { a1: "A", a2: "A", a3: "A", b1: "B", b2: "B", c1: "C" };
const groupOf = (id: string) => groups[id];
const none = new Set<string>();

describe("the active group", () => {
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

describe("one group at a time, with pinned exceptions", () => {
  it("drops panes of other groups unless pinned, and keeps ids awaiting a relaunch", () => {
    expect(pruneToGroup(["a1", "b1", "c1", "gone"], groupOf, new Set(["c1"]), "A")).toEqual(["a1", "c1", "gone"]);
  });
  it("returns the same list when nothing changes", () => {
    const shown = ["a1", "a2"];
    expect(pruneToGroup(shown, groupOf, none, "A")).toBe(shown);
  });
  it("keeps a pinned pane in its slot when switching groups", () => {
    expect(switchTo(["a1", "c1", "a2"], new Set(["c1"]), ["b1", "b2"])).toEqual(["b1", "c1", "b2"]);
    expect(switchTo(["a1", "a2", "c1"], new Set(["c1"]), ["b1"])).toEqual(["b1", "c1"]);
  });
  it("doesn't duplicate a pinned pane that belongs to the group being opened", () => {
    expect(switchTo(["b2", "a1"], new Set(["b2"]), ["b1", "b2"])).toEqual(["b2", "b1"]);
  });
  it("remembers a group's own panes, not pinned visitors", () => {
    expect(layoutToRemember(["a1", "c1", "a2"], groupOf, "A")).toEqual(["a1", "a2"]);
  });
});

describe("snap-layout zones", () => {
  it("fills zones in order, leaves the rest empty, and sends extras below", () => {
    expect(placeInZones(["x", "y"], 4, [])).toEqual({ zoneOf: [0, 1], empty: [2, 3], overflow: [] });
    expect(placeInZones(["x", "y", "z"], 2, [])).toEqual({ zoneOf: [0, 1, -1], empty: [], overflow: [2] });
  });
  it("keeps a placed pane in its zone and fills around it", () => {
    expect(placeInZones(["x", "y"], 3, [null, null, "x"])).toEqual({ zoneOf: [2, 0], empty: [1], overflow: [] });
  });
  it("ignores placements for panes that are gone or zones past the template", () => {
    expect(placeInZones(["y"], 2, ["gone", null, "y"]).zoneOf).toEqual([0]);
  });
  it("swaps two seated panes", () => {
    expect(dropInZone(["x", "y", null], "x", 1)).toEqual(["y", "x", null]);
  });
  it("seats a pane from below or outside the grid, displacing the occupant", () => {
    const seats = dropInZone(["x", "y"], "z", 0);
    expect(seats).toEqual(["z", "y"]);
    // x flows to the next free place — here, below the template
    expect(placeInZones(["x", "y", "z"], 2, seats)).toEqual({ zoneOf: [-1, 1, 0], empty: [], overflow: [0] });
  });
  it("moves a pane into an empty zone", () => {
    const keys = ["x", "y"];
    const zoning = placeInZones(keys, 4, []);
    expect(dropInZone(seating(keys, zoning, 4), "x", 3)).toEqual([null, "y", null, "x"]);
  });
  it("lays extras out in rows below the template", () => {
    expect(overflowArea(0, 2, 2)).toBe("3/1/4/2");
    expect(overflowArea(3, 2, 2)).toBe("4/2/5/3");
  });
  it("stretches the last pane below the template across the rest of its row", () => {
    expect(overflowArea(0, 3, 1, true)).toBe("2/1/3/4");
    expect(overflowArea(1, 3, 1, true)).toBe("2/2/3/4");
  });
});
