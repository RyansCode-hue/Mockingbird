import { describe, expect, it } from "vitest";
import { activeGroupOf, layoutToRemember, pruneToGroup, switchTo } from "../src/renderer/gridModel";

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
