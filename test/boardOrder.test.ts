import { describe, expect, it, vi } from "vitest";
import { gapAt, placeCard, placeItem, placeLabel, placement, stepGap } from "../src/renderer/boardOrder";
import type { AdoWorkItem } from "../src/shared/types";

const item = (id: number, boardColumn = "In Progress", state = "Active"): AdoWorkItem => ({ id, title: `#${id}`, state, type: "Bug", assignedTo: "", changed: "", description: "", url: "", tags: [], boardColumn });

describe("the gap a dragged card is over", () => {
  // three cards whose middles are at 50, 150 and 250
  const mids = [50, 150, 250];
  it("is above the first card until the pointer passes its middle, and below the last after its middle", () => {
    expect(gapAt(mids, -20)).toBe(0); // over the column's header
    expect(gapAt(mids, 49)).toBe(0);
    expect(gapAt(mids, 51)).toBe(1);
    expect(gapAt(mids, 200)).toBe(2);
    expect(gapAt(mids, 251)).toBe(3);
    expect(gapAt(mids, 9999)).toBe(3);
    expect(gapAt([], 40)).toBe(0); // an empty column has one gap
  });
});

describe("where a dropped card lands: the cards it goes between", () => {
  const column = [1, 2, 3, 4];
  it("at the top of its column: before the first card, after none", () => {
    expect(placement(column, 3, 0)).toEqual({ previousId: 0, nextId: 1, order: [3, 1, 2, 4] });
  });
  it("in the middle, moving up or down past its neighbours", () => {
    expect(placement(column, 4, 2)).toEqual({ previousId: 2, nextId: 3, order: [1, 2, 4, 3] });
    expect(placement(column, 1, 3)).toEqual({ previousId: 3, nextId: 4, order: [2, 3, 1, 4] });
  });
  it("at the bottom: after the last card, before none", () => {
    expect(placement(column, 1, 4)).toEqual({ previousId: 4, nextId: 0, order: [2, 3, 4, 1] });
  });
  it("nowhere new just above or below itself, so nothing is offered or written", () => {
    expect(placement(column, 2, 1)).toBeNull();
    expect(placement(column, 2, 2)).toBeNull();
  });
  it("into an empty column: between nothing, so only the move is written", () => {
    expect(placement([], 7, 0)).toEqual({ previousId: 0, nextId: 0, order: [7] });
  });
  it("into another column, between that column's cards", () => {
    expect(placement([10, 11], 3, 0)).toEqual({ previousId: 0, nextId: 10, order: [3, 10, 11] });
    expect(placement([10, 11], 3, 1)).toEqual({ previousId: 10, nextId: 11, order: [10, 3, 11] });
    expect(placement([10, 11], 3, 2)).toEqual({ previousId: 11, nextId: 0, order: [10, 11, 3] });
  });
  it("clamps a gap past either end", () => {
    expect(placement(column, 3, -1)?.nextId).toBe(1);
    expect(placement(column, 1, 9)?.previousId).toBe(4);
  });
  it("says where in words", () => {
    expect(placeLabel({ previousId: 2, nextId: 3 })).toBe("between #2 and #3");
    expect(placeLabel({ previousId: 0, nextId: 1 })).toBe("above #1");
    expect(placeLabel({ previousId: 4, nextId: 0 })).toBe("below #4");
    expect(placeLabel({ previousId: 0, nextId: 0 })).toBe("");
  });
});

describe("⌥↑ / ⌥↓ on a card", () => {
  const column = [1, 2, 3];
  it("moves it one place up or down its column", () => {
    expect(placement(column, 2, stepGap(column, 2, -1)!)).toMatchObject({ previousId: 0, nextId: 1 });
    expect(placement(column, 2, stepGap(column, 2, 1)!)).toMatchObject({ previousId: 3, nextId: 0 });
    expect(placement(column, 3, stepGap(column, 3, -1)!)).toMatchObject({ previousId: 1, nextId: 2 });
  });
  it("does nothing at the end it's already at", () => {
    expect(stepGap(column, 1, -1)).toBeNull();
    expect(stepGap(column, 3, 1)).toBeNull();
    expect(stepGap(column, 9, 1)).toBeNull();
  });
});

describe("the board's items with a card put in its place", () => {
  const items = [item(1), item(2, "New"), item(3), item(4)];
  it("sits right after the card it goes after, or right before the one it goes before", () => {
    expect(placeItem(items, 4, 1, 3).map((i) => i.id)).toEqual([1, 4, 2, 3]);
    expect(placeItem(items, 1, 0, 4).map((i) => i.id)).toEqual([2, 3, 1, 4]);
  });
  it("takes its new column and state", () => {
    const moved = placeItem(items, 2, 3, 4, { boardColumn: "In Progress", state: "Active" });
    expect(moved.map((i) => i.id)).toEqual([1, 3, 2, 4]);
    expect(moved[2]).toMatchObject({ id: 2, boardColumn: "In Progress", state: "Active" });
  });
  it("keeps its place with nothing to sit beside", () => {
    expect(placeItem(items, 2, 0, 0, { boardColumn: "Testing" }).map((i) => [i.id, i.boardColumn])).toEqual([[1, "In Progress"], [2, "Testing"], [3, "In Progress"], [4, "In Progress"]]);
  });
});

describe("putting a card in a new place", () => {
  const items = [item(1), item(2), item(3), item(5, "New", "New")];
  /** The board as the view shows it after each update. */
  const board = () => {
    let now = items;
    const seen: number[][] = [];
    return {
      update: (f: (i: AdoWorkItem[]) => AdoWorkItem[]) => {
        now = f(now);
        seen.push(now.map((i) => i.id));
      },
      seen,
      now: () => now,
    };
  };

  it("shows it there at once, then writes its place", async () => {
    const b = board();
    const reorder = vi.fn(async () => ({ id: 3, rank: 1500 }));
    const r = await placeCard(items, items[2], { previousId: 0, nextId: 1 }, { move: null, reorder }, b.update);
    expect(r).toEqual({ ok: true });
    expect(reorder).toHaveBeenCalledWith(3, 0, 1);
    expect(b.seen).toEqual([[3, 1, 2, 5]]);
  });

  it("puts it back where it was, and says why, when Azure DevOps refuses the reorder", async () => {
    const b = board();
    const r = await placeCard(items, items[0], { previousId: 3, nextId: 0 }, { move: null, reorder: async () => ({ error: "Azure DevOps 403 Forbidden" }) }, b.update);
    expect(b.seen).toEqual([[2, 3, 1, 5], [1, 2, 3, 5]]);
    expect(b.now()).toEqual(items);
    expect(r).toEqual({ error: "Couldn't put #1 below #3 — it's back where it was: Azure DevOps 403 Forbidden", wrote: false });
  });

  it("treats a write that throws like one that's refused", async () => {
    const b = board();
    const r = await placeCard(items, items[0], { previousId: 2, nextId: 3 }, { move: null, reorder: () => Promise.reject(new Error("IPC gone")) }, b.update);
    expect(b.seen.at(-1)).toEqual([1, 2, 3, 5]);
    expect(r).toMatchObject({ error: expect.stringMatching(/IPC gone$/), wrote: false });
  });

  it("into another column: moves it, then places it between its new neighbours", async () => {
    const b = board();
    const order: string[] = [];
    const r = await placeCard(
      items,
      items[3],
      { previousId: 1, nextId: 2, column: "In Progress", patch: { boardColumn: "In Progress", state: "Active" } },
      { move: async () => (order.push("move"), { id: 5, state: "Active" }), reorder: async () => (order.push("reorder"), { id: 5, rank: 1 }) },
      b.update
    );
    expect(r).toEqual({ ok: true });
    expect(order).toEqual(["move", "reorder"]);
    expect(b.now().map((i) => [i.id, i.boardColumn])).toEqual([[1, "In Progress"], [5, "In Progress"], [2, "In Progress"], [3, "In Progress"]]);
  });

  it("into an empty column: only the move, as there's nothing to place it beside", async () => {
    const reorder = vi.fn();
    const r = await placeCard(items, items[0], { previousId: 0, nextId: 0, column: "Testing", patch: { boardColumn: "Testing" } }, { move: async () => ({ id: 1, state: "Resolved" }), reorder }, board().update);
    expect(r).toEqual({ ok: true });
    expect(reorder).not.toHaveBeenCalled();
  });

  it("when the move is refused: nothing written, it's back in its column and place", async () => {
    const b = board();
    const reorder = vi.fn();
    const r = await placeCard(items, items[3], { previousId: 0, nextId: 1, column: "In Progress", patch: { boardColumn: "In Progress", state: "Active" } }, { move: async () => ({ error: "TF401320: rule violation" }), reorder }, b.update);
    expect(reorder).not.toHaveBeenCalled();
    expect(b.now()).toEqual(items);
    expect(r).toEqual({ error: "Couldn't move #5 to In Progress — it's back where it was: TF401320: rule violation", wrote: false });
  });

  it("when the move works but the reorder doesn't: says it moved but isn't placed, for the view to re-read where it is", async () => {
    const b = board();
    const r = await placeCard(items, items[3], { previousId: 1, nextId: 2, column: "In Progress", patch: { boardColumn: "In Progress", state: "Active" } }, { move: async () => ({ id: 5, state: "Active" }), reorder: async () => ({ error: "Azure DevOps 500" }) }, b.update);
    expect(r).toEqual({ error: "Moved #5 to In Progress, but couldn't put it between #1 and #2 — it's where Azure DevOps keeps it: Azure DevOps 500", wrote: true });
    expect(b.now().find((i) => i.id === 5)?.boardColumn).toBe("In Progress");
  });
});
