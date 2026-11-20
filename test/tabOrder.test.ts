import { describe, expect, it, vi } from "vitest";
import { clampTabDrag, inTabOrder, movedTo, rerank, tabRankOf, tabShifts, tabSlot, type TabSlot } from "../src/shared/tabOrder";

const s = (id: string, taskGroup: string | null = null) => ({ id, taskGroup });

describe("a stack's tab order", () => {
  it("sorts each stack's members by the ranking, those it doesn't list after in the list's order, in the places the stack's members had", () => {
    const list = [s("a", "5101/api"), s("x", "5101"), s("b", "5101/api"), s("y"), s("c", "5101/api"), s("p", "5102/ui"), s("q", "5102/ui")];
    const out = inTabOrder(list, ["c", "a"]).map((x) => x.id);
    // a, b, c sat at 0, 2, 4: now c, a (ranked), then b (unranked); everything else where it was
    expect(out).toEqual(["c", "x", "a", "y", "b", "p", "q"]);
  });

  it("hands back the same list when the ranking changes nothing, so what's worked out from it isn't redone", () => {
    const list = [s("a", "5101/api"), s("b", "5101/api"), s("x")];
    expect(inTabOrder(list, [])).toBe(list);
    expect(inTabOrder(list, ["a", "b"])).toBe(list);
    expect(inTabOrder(list, ["x", "gone"])).toBe(list);
  });

  it("keeps a stack's order through its rename: the ranking is by session, not by stack", () => {
    const rank = ["b", "a"];
    expect(inTabOrder([s("a", "5101/api"), s("b", "5101/api")], rank).map((x) => x.id)).toEqual(["b", "a"]);
    expect(inTabOrder([s("a", "Renamed/backend"), s("b", "Renamed/backend")], rank).map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("puts a stack's new order last in the ranking and drops the sessions no longer known", () => {
    expect(rerank(["a", "gone", "b", "c"], ["c", "a"], (id) => id !== "gone")).toEqual(["b", "c", "a"]);
    // reordered again, it's the newest order that holds
    const rank = rerank(rerank([], ["a", "b", "c"], () => true), ["b", "a", "c"], () => true);
    expect(inTabOrder([s("a", "k/s"), s("b", "k/s"), s("c", "k/s")], rank).map((x) => x.id)).toEqual(["b", "a", "c"]);
  });

  it("reads only a list of session ids from the prefs, and says so in the console otherwise", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(tabRankOf(["a", "b"])).toEqual(["a", "b"]);
    expect(warn).not.toHaveBeenCalled();
    expect(tabRankOf({ a: 1 })).toEqual([]);
    expect(tabRankOf(["a", 2])).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toMatch(/tab order/);
    warn.mockRestore();
  });
});

describe("a tab dragged along its strip", () => {
  // three tabs 100, 60 and 80 wide, 2 px apart
  const slots: TabSlot[] = [
    { left: 0, width: 100 },
    { left: 102, width: 60 },
    { left: 164, width: 80 },
  ];

  it("stays between the first tab's left edge and the last one's right", () => {
    expect(clampTabDrag(slots, 0, -50)).toBe(0);
    expect(clampTabDrag(slots, 0, 500)).toBe(144);
    expect(clampTabDrag(slots, 2, -500)).toBe(-164);
    expect(clampTabDrag(slots, 1, 30)).toBe(30);
  });

  it("lands past each tab whose middle its leading edge has crossed, reaching either end whatever the widths", () => {
    // going right, the first tab's right edge (100) has to cross the second's middle (132), then the third's (204)
    expect(tabSlot(slots, 0, 31)).toBe(0);
    expect(tabSlot(slots, 0, 33)).toBe(1);
    expect(tabSlot(slots, 0, 105)).toBe(2);
    // dragged as far as it goes it's last, though it's wider than the last tab
    expect(tabSlot(slots, 0, clampTabDrag(slots, 0, 500))).toBe(2);
    // going left, the third's left edge (164) has to cross the second's middle, then the first's (50)
    expect(tabSlot(slots, 2, -31)).toBe(2);
    expect(tabSlot(slots, 2, -33)).toBe(1);
    expect(tabSlot(slots, 2, -115)).toBe(0);
    expect(tabSlot(slots, 1, 0)).toBe(1);
  });

  it("moves the tabs it has passed toward where it was, by its width and the gap", () => {
    expect(tabShifts(slots, 0, 0)).toEqual([0, 0, 0]);
    expect(tabShifts(slots, 0, 2)).toEqual([0, -102, -102]);
    expect(tabShifts(slots, 2, 1)).toEqual([0, 82, 0]);
    expect(tabShifts(slots, 2, 0)).toEqual([82, 82, 0]);
  });

  it("is dropped into its new place", () => {
    expect(movedTo(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(movedTo(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(movedTo(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
  });
});
