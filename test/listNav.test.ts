import { describe, expect, it } from "vitest";
import { clampIndex } from "../src/renderer/listNav";

describe("a list's keyboard selection", () => {
  it("never goes below the first row, even on an empty list", () => {
    expect(clampIndex(-1, 0)).toBe(0); // ↓ pressed while the list was still loading
    expect(clampIndex(1, 0)).toBe(0);
    expect(clampIndex(-1, 5)).toBe(0);
  });
  it("stays on the last row when the list shrinks under it", () => {
    expect(clampIndex(7, 3)).toBe(2);
    expect(clampIndex(2, 3)).toBe(2);
  });
});
