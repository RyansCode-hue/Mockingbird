import { describe, expect, it } from "vitest";
import { cue, placeBeside, samePlace } from "../src/renderer/drag";

describe("placing a dragged item", () => {
  const cols = ["New", "Active", "Testing", "Done"];
  it("lands before or after the target — so an item can move one place right, or to the end", () => {
    expect(placeBeside(cols, "New", "Active", "after")).toEqual(["Active", "New", "Testing", "Done"]);
    expect(placeBeside(cols, "New", "Done", "after")).toEqual(["Active", "Testing", "Done", "New"]);
    expect(placeBeside(cols, "Done", "New", "before")).toEqual(["Done", "New", "Active", "Testing"]);
    expect(placeBeside(cols, "New", "zzz", "after")).toBe(cols);
  });
  it("knows when a drop would change nothing, so the target isn't offered", () => {
    expect(samePlace(cols, "New", "Active", "before")).toBe(true); // already just before Active
    expect(samePlace(cols, "Active", "New", "after")).toBe(true);
    expect(samePlace(cols, "New", "Active", "after")).toBe(false);
  });
  it("marks only the target under the cursor: outlined, or a line on one side", () => {
    const d = { type: "t", payload: "p", label: "l", x: 0, y: 0 };
    expect(cue({ ...d, target: { key: "c:Active", outcome: "o", side: "after" } }, "c:Active")).toBe("after");
    expect(cue({ ...d, target: { key: "g:5101", outcome: "o" } }, "g:5101")).toBe("into");
    expect(cue({ ...d, target: { key: "g:5101", outcome: "o" } }, "g:other")).toBeUndefined();
    expect(cue(null, "g:5101")).toBeUndefined();
  });
});
