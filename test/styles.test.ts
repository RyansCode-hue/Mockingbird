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

  it("lets the status bar's popovers open upward out of it", () => {
    // plan usage and the session counts open above the bar: a bar that clips its y axis hides them whole
    const decls = [...css.matchAll(/^\.statusbar\s*\{([^}]*)\}/gm)].map((m) => m[1]).join(";");
    const overflow = (prop: string) => [...decls.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, "g"))].map((m) => m[1].trim());
    expect(decls).not.toBe("");
    for (const v of overflow("overflow")) expect(v.split(/\s+/).at(-1)).toBe("visible");
    for (const v of overflow("overflow-y")) expect(v).toBe("visible");
  });
});
