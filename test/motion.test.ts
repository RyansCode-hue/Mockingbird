import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { D, GHOST, REDUCED_MS, SPRING, motionMode, spring } from "../src/renderer/motion";
import { OVERLAYS } from "../src/renderer/keys";

const css = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
/** The declarations of the first rule whose selector is exactly `sel`. */
const rule = (sel: string) => css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.[\]()*>"=]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

describe("the motion setting", () => {
  it("follows macOS unless Reduce or Full is chosen, and a test can force it off", () => {
    expect(motionMode("os", false)).toBe("full");
    expect(motionMode("os", true)).toBe("reduce");
    expect(motionMode("reduce", false)).toBe("reduce");
    expect(motionMode("reduce", true)).toBe("reduce");
    expect(motionMode("full", false)).toBe("full");
    expect(motionMode("full", true)).toBe("full");
    for (const p of ["os", "reduce", "full"] as const) expect(motionMode(p, false, true)).toBe("off");
  });
});

describe("springs", () => {
  it("run from 0 to 1, settling later the more they're damped", () => {
    for (const ratio of [0.6, 0.9, 1, 1.4]) {
      const k = 700;
      const s = spring(k, 2 * ratio * Math.sqrt(k));
      const stops = s.easing.slice("linear(".length, -1).split(",").map(Number);
      expect(stops[0]).toBe(0);
      expect(stops.at(-1)).toBe(1);
      expect(s.duration).toBeGreaterThan(100);
    }
    const k = 700;
    const at = (r: number) => spring(k, 2 * r * Math.sqrt(k)).duration;
    expect(at(1)).toBeLessThan(at(1.4));
    expect(at(1.4)).toBeLessThan(at(2));
  });
  it("don't bounce at Fluid's damping, and do when under-damped", () => {
    expect(SPRING.overshoot).toBeLessThan(0.002);
    expect(SPRING.duration).toBeGreaterThan(200);
    expect(SPRING.duration).toBeLessThan(300);
    expect(spring(800, 2 * 0.6 * Math.sqrt(800)).overshoot).toBeGreaterThan(0.05);
  });
});

describe("the motion tokens", () => {
  it("are Fluid's durations and the same spring motion.ts plays", () => {
    const root = rule(":root").length ? [...css.matchAll(/(?:^|\n):root\s*\{([^}]*)\}/g)].map((m) => m[1]).join(";") : "";
    const token = (name: string) => root.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
    expect([1, 2, 3, 4].map((n) => token(`dur-${n}`))).toEqual([D.xs, D.s, D.m, D.l].map((ms) => `${ms}ms`));
    expect(token("ease-spring")).toBe(SPRING.easing);
    expect(token("dur-spring")).toBe(`${SPRING.duration}ms`);
  });
  it("shorten every duration to a fade of 120 ms or less under reduce, and to nothing when off", () => {
    const reduce = rule(':root[data-motion="reduce"]');
    for (const [, ms] of reduce.matchAll(/--dur-[\w-]+:\s*(\d+)ms/g)) expect(Number(ms)).toBeLessThanOrEqual(REDUCED_MS);
    expect(reduce).toMatch(/--rise:\s*0px/);
    expect(reduce).toMatch(/--pop:\s*1\b/);
    const off = rule(':root[data-motion="off"]');
    for (const [, ms] of off.matchAll(/--dur-[\w-]+:\s*(\d+)ms/g)) expect(Number(ms)).toBe(0);
    expect(css).toMatch(/:root\[data-motion="off"\] \*[^{]*\{\s*transition: none !important; animation: none !important;/);
  });
});

describe("the stylesheet's motion", () => {
  it("stops every endless loop under reduce", () => {
    const loops = [...css.matchAll(/(?:^|\n)([^{}\n]+?)\s*\{[^}]*animation:[^;}]*infinite/g)].map((m) => m[1].trim());
    expect(loops.length).toBeGreaterThan(3);
    for (const sel of loops)
      for (const one of sel.split(",").map((x) => x.trim())) expect(css, one).toMatch(new RegExp(`\\[data-motion="reduce"\\] ${one.replace(/[.[\]()*>"=]/g, (c) => `\\${c}`)}[^{]*\\{[^}]*animation: none`));
  });
  it("lets the waiting pulse run for about ten seconds, then hold", () => {
    const anim = rule(".dot.waiting").match(/animation:\s*([^;]+)/)?.[1] ?? "";
    const [, secs, count] = anim.match(/waitpulse ([\d.]+)s \S+ (\d+)/) ?? [];
    expect(Number(secs) * Number(count)).toBeGreaterThanOrEqual(8);
    expect(Number(secs) * Number(count)).toBeLessThanOrEqual(10);
  });
  it("never transitions a layout property, and never transitions everything", () => {
    for (const [, v] of css.matchAll(/transition:\s*([^;}]+)/g)) expect(v).not.toMatch(/\b(width|height|left|top|right|bottom|margin|padding|all)\b/);
  });
  it("keys reduced motion off the root's data-motion, so Settings can override macOS", () => {
    expect(css).not.toMatch(/prefers-reduced-motion/);
  });
});

describe("exits played on a static copy", () => {
  it("never count as an open overlay (Esc, focus return)", () => {
    for (const sel of OVERLAYS.split(",").map((x) => x.trim()))
      if (/modal-back|mb-menu/.test(sel)) expect(sel).toContain(`:not(.${GHOST})`);
    const menu = readFileSync(new URL("../src/renderer/ContextMenu.tsx", import.meta.url), "utf8");
    expect(menu).toContain(`.mb-ctx:not(.${GHOST})`);
  });
});
