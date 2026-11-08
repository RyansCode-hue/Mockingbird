import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

// WCAG contrast of the design tokens in styles.css, computed from the tokens themselves: every text colour on every
// surface it's drawn on (tinted chips over the surfaces they sit on), in both themes, at least 4.5:1.
const css = fs.readFileSync(path.join(__dirname, "../src/renderer/styles.css"), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`styles.css has no "${selector} {" block`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const dark = block(":root");
const themes = { dark, light: { ...dark, ...block(':root[data-theme="light"]') } };

type RGBA = [number, number, number, number];
function parse(value: string): RGBA {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as RGBA;
  const rgba = value.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const [r, g, b, a = 1] = rgba[1].split(",").map(Number);
    return [r, g, b, a];
  }
  throw new Error(`can't read the colour "${value}"`);
}
/** `top` (possibly translucent) laid over the opaque `under`. */
const over = (top: RGBA, under: RGBA): RGBA => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as RGBA;
const luminance = ([r, g, b]: RGBA) => {
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
export const contrast = (a: RGBA, b: RGBA) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// the surfaces text sits on: the plain ones, a selected row or tab, and a plain chip's fill
const surfaces = ["--bg-app", "--bg-chrome", "--bg-sidebar", "--bg-pane", "--bg-pane-header", "--bg-pane-header-focus", "--bg-rail", "--bg-assist", "--bg-pane-waiting"];
const layered: [string, string][] = [
  ["--fill-selected", "--bg-sidebar"],
  ["--fill-selected", "--bg-chrome"],
  ["--fill-subtle", "--bg-pane-header"],
  ["--fill-subtle", "--bg-sidebar"],
  ["--fill-blocked", "--bg-pane"], // a blocked work item's card, and the header's blocked filter when on
  ["--fill-blocked", "--bg-pane-header"], // the blocked note in a work item's detail
];
const text = ["--text-1", "--text-1-warm", "--text-2", "--text-3", "--text-4", "--amber-ink", "--amber-text", "--amber-text-dim", "--teal-text", "--red", "--git-add", "--git-mod", "--m-0", "--m-1", "--m-2", "--m-3", "--m-4", "--m-5"];
// a tinted chip: its text on its own tint, over the surfaces chips sit on
const tinted: [string, string][] = [
  ["--amber-text", "--fill-waiting"],
  ["--amber-ink", "--fill-waiting-glow"], // .wait-banner
  ["--teal-text", "rgba(79, 179, 165, .12)"], // .chip.teal, .chip.stage
  ["--red", "rgba(207, 106, 90, .12)"], // .chip.overlap
];
const chipGrounds = ["--bg-pane", "--bg-pane-header", "--bg-pane-waiting", "--bg-chrome", "--bg-sidebar"];
// filled controls: their label on their fill
const filled: [string, string][] = [
  ["--on-primary", "--primary"],
  ["--on-primary", "--primary-hover"],
  ["--chip-on-fg", "--chip-on-bg"],
  ["--on-amber", "--amber"],
  ["--on-teal", "--teal"],
];

function failures(t: Record<string, string>): string[] {
  const color = (v: string) => parse(v.startsWith("--") ? t[v] : v);
  const grounds = [
    ...surfaces.map((s) => [s, color(s)] as const),
    ...layered.map(([fill, base]) => [`${fill} on ${base}`, over(color(fill), color(base))] as const),
  ];
  const bad: string[] = [];
  const check = (fg: string, bgName: string, bg: RGBA, min = 4.5) => {
    const r = contrast(color(fg), bg);
    if (r < min) bad.push(`${fg} on ${bgName}: ${r.toFixed(2)}`);
  };
  for (const fg of text) for (const [name, bg] of grounds) check(fg, name, bg);
  for (const [fg, tint] of tinted) for (const g of chipGrounds) check(fg, `${tint} on ${g}`, over(color(tint), color(g)));
  for (const [fg, bg] of filled) check(fg, bg, color(bg));
  return bad;
}

// non-text marks (WCAG 1.4.11), at least 3:1 against what's on either side of them
/** The colour token a rule's `property` uses, read from styles.css. */
function ruleColor(selector: string, property: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`styles.css has no "${selector} {" rule`);
  const m = css.slice(start, css.indexOf("}", start)).match(new RegExp(`${property}:[^;]*var\\((--[a-z0-9-]+)\\)`));
  if (!m) throw new Error(`"${selector}" sets no ${property} colour from a token`);
  return m[1];
}
const paneGrounds = ["--bg-app", "--bg-pane", "--bg-pane-header", "--bg-pane-header-focus", "--bg-pane-waiting"];
const marks: [string, string[]][] = [
  // a pane's outline while a teammate can type, and the typing strip's edge: the app's ground outside, the pane and
  // its header inside, a waiting pane's header
  [ruleColor(".pane.typing-on::after", "border"), paneGrounds],
  [ruleColor(".typing-ask", "border-bottom"), paneGrounds],
];
// the typing strip's words and buttons on its teal tint over the pane
const strip = "rgba(79, 179, 165, .14)";

describe("the design tokens' contrast", () => {
  for (const [name, t] of Object.entries(themes)) {
    it(`keeps outlines at 3:1 and the typing strip's text at 4.5:1: ${name}`, () => {
      const color = (v: string) => parse(v.startsWith("--") ? t[v] : v);
      const bad: string[] = [];
      for (const [mark, grounds] of marks) {
        for (const g of grounds) {
          const r = contrast(over(color(mark), color(g)), color(g)); // a translucent mark as it's drawn on that ground
          if (r < 3) bad.push(`${mark} on ${g}: ${r.toFixed(2)}`);
        }
      }
      const ground = over(color(strip), color("--bg-pane"));
      for (const fg of ["--text-1", "--text-2", "--red"]) if (contrast(color(fg), ground) < 4.5) bad.push(`${fg} on the typing strip: ${contrast(color(fg), ground).toFixed(2)}`);
      expect(bad).toEqual([]);
    });
  }

  for (const [name, tokens] of Object.entries(themes)) {
    it(`keeps every text colour at 4.5:1 or more on the surfaces it sits on: ${name}`, () => {
      expect(failures(tokens)).toEqual([]);
    });
  }

  it("draws a dragged Dashboard card's drop line, in --primary, at 3:1 or more on its column: both themes", () => {
    const rule = css.slice(css.indexOf('.bcard[data-gap="above"]::before, '), css.indexOf("}", css.indexOf('.bcard[data-gap="above"]::before, ')));
    expect(rule).toContain("background: var(--primary)");
    for (const t of Object.values(themes)) expect(contrast(parse(t["--primary"]), parse(t["--bg-sidebar"]))).toBeGreaterThanOrEqual(3);
  });

  it("draws snap guides in a colour no area accent is near (CIE76 ΔE 50 or more), so a guide never reads as an area's edge: both themes", () => {
    const lab = ([r, g, b]: RGBA) => {
      const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const [R, G, B] = [lin(r), lin(g), lin(b)];
      const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
      const [x, y, z] = [(R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, R * 0.2126 + G * 0.7152 + B * 0.0722, (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883].map(f);
      return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
    };
    const dE = (a: string, b: string) => Math.hypot(...lab(parse(a)).map((v, i) => v - lab(parse(b))[i]));
    // what areas are drawn in: --ls-a0, --ls-a1… each naming a theme's token
    const accents = [...css.matchAll(/--ls-a\d:\s*var\((--[\w-]+)\)/g)].map((m) => m[1]);
    expect(accents).toEqual(["--amber", "--teal", "--git-mod", "--m-2", "--m-4", "--m-5"]);
    for (const t of Object.values(themes)) {
      expect(accents.filter((k) => dE(t["--snap-guide"], t[k]) < 50).map((k) => `${k} ΔE ${Math.round(dE(t["--snap-guide"], t[k]))}`)).toEqual([]);
    }
  });

  it("reads the colours it checks", () => {
    expect(contrast(parse("#000000"), parse("#ffffff"))).toBeCloseTo(21, 5);
    expect(contrast(over(parse("rgba(0, 0, 0, .5)"), parse("#ffffff")), parse("#ffffff"))).toBeGreaterThan(3);
    for (const tokens of Object.values(themes)) for (const s of surfaces) expect(parse(tokens[s])[3]).toBe(1);
  });
});
