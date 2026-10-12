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

  it("puts a teammate's copy at the bottom of a pane taller than its owner's screen, still scrollable from its top", () => {
    const rule = (sel: string) => css.match(new RegExp(`^${sel.replace(/[.>]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`, "m"))?.[1] ?? "";
    expect(rule(".term-holder.fixed")).toMatch(/display:\s*flex/);
    expect(rule(".term-holder.fixed")).toMatch(/flex-direction:\s*column/);
    expect(rule(".term-holder.fixed")).toMatch(/overflow:\s*auto/);
    // an auto margin, not justify-content: flex-end, which would cut off the top of a copy taller than the pane
    expect(rule(".term-holder.fixed > .terminal")).toMatch(/margin-top:\s*auto/);
    expect(rule(".term-holder.fixed")).not.toMatch(/justify-content/);
  });
});
