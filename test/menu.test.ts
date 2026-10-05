import { describe, expect, it } from "vitest";
import { placePopover } from "../src/renderer/Menu";

const view = { width: 1000, height: 800 };

describe("where a dropdown opens", () => {
  it("opens below its control when the list fits there", () => {
    expect(placePopover({ left: 100, top: 100, bottom: 120 }, { width: 220, height: 200 }, view)).toEqual({ left: 100, top: 124, maxHeight: 668 });
  });
  it("opens above when there's more room there than below", () => {
    const p = placePopover({ left: 100, top: 700, bottom: 720 }, { width: 220, height: 400 }, view);
    expect(p.top).toBe(700 - 4 - 400);
    expect(p.maxHeight).toBe(688);
  });
  it("scrolls a list taller than the room on its side instead of running off the window", () => {
    const p = placePopover({ left: 100, top: 300, bottom: 320 }, { width: 220, height: 2000 }, view);
    expect(p.top + Math.min(2000, p.maxHeight)).toBeLessThanOrEqual(view.height);
  });
  it("stays inside the window's left and right edges", () => {
    expect(placePopover({ left: 900, top: 100, bottom: 120 }, { width: 220, height: 100 }, view).left).toBe(1000 - 220 - 8);
    expect(placePopover({ left: -20, top: 100, bottom: 120 }, { width: 220, height: 100 }, view).left).toBe(8);
  });
});
