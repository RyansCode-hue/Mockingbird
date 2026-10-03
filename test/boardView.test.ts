import { describe, expect, it } from "vitest";
import { cardMove, columnOf, orderColumns, pickBoard } from "../src/renderer/boardView";
import type { AdoBoard, AdoWorkItem } from "../src/shared/types";

// shaped like a real team's "Backlog items" board: three columns share Bug:New
const backlog: AdoBoard = {
  id: "b1",
  name: "Backlog items",
  columnField: "WEF_X_Kanban.Column",
  columns: [
    { name: "Idea", type: "incoming", stateMappings: { Bug: "New", "Product Backlog Item": "Idea" } },
    { name: "Approved (Do)", type: "inProgress", stateMappings: { Bug: "New", "Product Backlog Item": "New" } },
    { name: "Planning", type: "inProgress", stateMappings: { Bug: "New", "Product Backlog Item": "On Deck" } },
    { name: "In Progress", type: "inProgress", stateMappings: { Bug: "In Progress", "Product Backlog Item": "In Development" } },
    { name: "Done", type: "outgoing", stateMappings: { Bug: "Done", "Product Backlog Item": "Done" } },
  ],
};
const features: AdoBoard = { id: "b2", name: "Features", columnField: null, columns: [{ name: "New", type: "incoming", stateMappings: { Feature: "New" } }] };
const item = (id: number, type: string, state: string, boardColumn?: string): AdoWorkItem =>
  ({ id, type, state, title: "", assignedTo: "", changed: "", description: "", url: "", ...(boardColumn ? { boardColumn } : {}) }) as AdoWorkItem;

describe("the team's board", () => {
  it("puts a card in the column ADO recorded — the only way to tell columns that share a state apart", () => {
    expect(columnOf(item(1, "Bug", "New", "Planning"), backlog)).toBe("Planning");
    expect(columnOf(item(2, "Bug", "New"), backlog)).toBe("Idea"); // no record: the first column with its state
    expect(columnOf(item(3, "Product Backlog Item", "In Development", "In Progress"), backlog)).toBe("In Progress");
    expect(columnOf(item(4, "Feature", "New"), backlog)).toBeNull(); // belongs on another board
  });
  it("shows the board most of the work items belong on", () => {
    expect(pickBoard([item(1, "Bug", "New"), item(2, "Product Backlog Item", "Idea"), item(3, "Feature", "New")], [features, backlog])).toBe(backlog);
    expect(pickBoard([], [])).toBeNull();
  });
  it("says what a drop changes: the column, and the state only when it differs", () => {
    const bug = item(1, "Bug", "New", "Idea");
    expect(cardMove(bug, backlog, "Planning")).toEqual({ state: "New", stateChanges: false });
    expect(cardMove(bug, backlog, "In Progress")).toEqual({ state: "In Progress", stateChanges: true });
    expect(cardMove(bug, backlog, "Idea")).toBeNull(); // already there
    expect(cardMove(item(4, "Feature", "New"), backlog, "Idea")).toBeNull(); // no column for its type
  });
  it("keeps your column order, adding columns the board gained in the board's order", () => {
    expect(orderColumns(["Idea", "Planning", "Done", "QA"], ["Done", "Idea", "Gone"])).toEqual(["Done", "Idea", "Planning", "QA"]);
  });
});
