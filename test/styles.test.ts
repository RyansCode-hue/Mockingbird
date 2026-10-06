import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { SEAT_PALETTE_SIZE } from "../src/shared/types";

const css = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");

describe("the stylesheet", () => {
  it("colours exactly as many Collaborate seats as rooms hand out", () => {
    const slots = [...new Set([...css.matchAll(/\.c-(\d+)\b/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
    expect(slots).toEqual([...Array(SEAT_PALETTE_SIZE).keys()]);
    for (const n of slots) {
      expect(css).toContain(`.c-${n} .who`);
      expect(css).toContain(`.collab-msg.c-${n}`);
      expect(css).toContain(`.seat-dot.c-${n}`);
    }
  });
});
