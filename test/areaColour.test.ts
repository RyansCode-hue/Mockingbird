import { describe, expect, it } from "vitest";
import { COLOUR_COLUMNS, colourStep } from "../src/renderer/AreaColour";
import { ACCENT_COUNT } from "../src/shared/landscape";

// The Colour popover's choices: 0 is Automatic, then the swatches in rows of COLOUR_COLUMNS.
const LAST = ACCENT_COUNT;

describe("the Colour popover's keys", () => {
  it("walk the choices in order with ← and →, stopping at either end", () => {
    expect(colourStep(0, "ArrowLeft")).toBe(0);
    expect(colourStep(0, "ArrowRight")).toBe(1);
    expect(colourStep(1, "ArrowLeft")).toBe(0);
    expect(colourStep(COLOUR_COLUMNS, "ArrowRight")).toBe(COLOUR_COLUMNS + 1);
    expect(colourStep(LAST, "ArrowRight")).toBe(LAST);
  });

  it("move between the swatches' rows with ↑ and ↓, ↑ from the top row to Automatic and ↓ from it to the first swatch", () => {
    expect(colourStep(0, "ArrowDown")).toBe(1);
    expect(colourStep(0, "ArrowUp")).toBe(0);
    for (let i = 1; i <= COLOUR_COLUMNS; i++) {
      expect(colourStep(i, "ArrowUp"), String(i)).toBe(0);
      expect(colourStep(i, "ArrowDown"), String(i)).toBe(i + COLOUR_COLUMNS);
      expect(colourStep(i + COLOUR_COLUMNS, "ArrowUp"), String(i)).toBe(i);
      expect(colourStep(i + COLOUR_COLUMNS, "ArrowDown"), String(i)).toBe(i + COLOUR_COLUMNS);
    }
  });

  it("go to the first and last choice with Home and End, and take no other key", () => {
    expect(colourStep(7, "Home")).toBe(0);
    expect(colourStep(3, "End")).toBe(LAST);
    for (const key of ["Enter", " ", "Tab", "Escape", "a"]) expect(colourStep(4, key), key).toBeNull();
  });
});
