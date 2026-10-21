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

  it("clips a terminal's hidden input to the terminal, so no pane scrolls below its last line to reach it", () => {
    const rule = css.match(/^\.term-holder \.xterm\s*\{([^}]*)\}/m)?.[1] ?? "";
    // clip, not hidden: the browser still scrolls a hidden overflow to show a focused element
    expect(rule).toMatch(/overflow:\s*clip/);
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

  it("floats a pane's status banners over its terminal, out of the layout, each on an opaque ground", () => {
    const rule = (sel: string) => css.match(new RegExp(`^${sel.replace(/[.>*]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`, "m"))?.[1] ?? "";
    expect(rule(".term-area")).toMatch(/position:\s*relative/);
    expect(rule(".pane-notes")).toMatch(/position:\s*absolute/);
    expect(rule(".pane-notes")).toMatch(/pointer-events:\s*none/);
    expect(rule(".pane-notes > *")).toMatch(/pointer-events:\s*auto/);
    // tints alone are translucent: over the terminal's text they'd be unreadable
    for (const banner of [".wait-banner", ".stall-banner", ".team-pane-note"]) expect(rule(banner), banner).toMatch(/background:[^;]*var\(--bg-pane\)/);
  });
});
