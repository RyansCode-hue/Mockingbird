import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import pkg from "../package.json";

// Layout, measured in the UI preview in real headless Chrome: local only (CI runners have no desktop); the
// script passes a mock keychain. Each check renders a screen with ?measure=<selector> and reads the boxes back.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type Box = { x: number; y: number; w: number; h: number; text: string };

async function render(size: string, query: string, measure: string[] = []): Promise<{ html: string; boxes: Record<string, Box[]> }> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageDom } = await import("../scripts/ui-preview.mjs");
  const q = [query, ...measure.map((m) => `measure=${encodeURIComponent(m)}`)].filter(Boolean).join("&");
  const html: string = await pageDom({ size, query: q, outDir: path.join(tempDir("layout"), "out") });
  const json = html.match(/<script type="application\/json" id="mb-measure">([\s\S]*?)<\/script>/)?.[1];
  return { html, boxes: json ? JSON.parse(json) : {} };
}

const shown = (b: Box) => b.w > 0 && b.h > 0;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
/** Every pair of a box in `over` and one in `under` that overlap, by their text. */
const collisions = (over: Box[], under: Box[]) =>
  over.filter(shown).flatMap((a) => under.filter(shown).filter((b) => overlaps(a, b)).map((b) => `${a.text || "(actions)"} × ${b.text}`));

describe.skipIf(!local)("the interface's layout", () => {
  // ?paneControls shows every row's actions at once, as a hover shows one row's
  const rowParts = [".sess-item .sr-acts", ".sess-item .nm", ".sess-item .name > .br", ".sess-item .name button:not(.lbtn)"];
  for (const [where, query] of [
    ["the Sessions view", "paneControls"],
    ["a room in the Team view", "view=room&paneControls"],
  ] as const) {
    for (const size of ["1500x900", "1000x700"]) {
      it(`keeps a row's actions on its title line, clear of its name and the lines and buttons under it: ${where}, ${size}`, async () => {
        const { boxes } = await render(size, query, rowParts);
        const [acts, names, lines, buttons] = rowParts.map((s) => boxes[s] ?? []);
        expect(acts.filter(shown).length).toBeGreaterThan(3);
        expect(lines.filter(shown).length).toBeGreaterThan(3);
        expect(collisions(acts, [...names, ...lines, ...buttons])).toEqual([]);
        // on the title line: level with a name
        for (const a of acts.filter(shown)) expect(names.some((n) => Math.abs(n.y + n.h / 2 - (a.y + a.h / 2)) < 4)).toBe(true);
      }, 90_000);
    }
  }

  const councilControls = [".collab-inspector-wrap", ".collab-head .seg", ".collab-panel-toggle", ".collab-controls button", ".collab-bar textarea"];
  for (const size of ["1000x700", "760x700"]) {
    it(`keeps a council's Thread/Rounds switch, details toggle, composer, Run and Send clear of its inspector at ${size}`, async () => {
      const { boxes } = await render(size, "tab=collaborate", councilControls);
      const [inspector, ...controls] = councilControls.map((s) => boxes[s] ?? []);
      expect(inspector.filter(shown)).toHaveLength(1);
      expect(controls.flat().filter(shown).length).toBeGreaterThan(5);
      expect(collisions(inspector, controls.flat())).toEqual([]);
    }, 90_000);
  }

  it("fills the CLAUDE.md editor from the fixture, and shows a read that failed outright", async () => {
    const parts = [".control .editor .path", ".control .editor .err-inline"];
    const ok = await render("1200x800", "section=control", parts);
    expect(ok.boxes[parts[0]].map((b) => b.text)).toEqual(["/Users/you/.claude/CLAUDE.md"]);
    expect(ok.boxes[parts[1]]).toEqual([]);
    const failed = await render("1200x800", "section=control&claudeMd=error", parts);
    expect(failed.boxes[parts[1]][0]?.text).toMatch(/^Couldn't read ~\/\.claude\/CLAUDE\.md: .*EACCES/);
  }, 120_000);

  it("shows the version being built", async () => {
    const { html } = await render("1200x800", "");
    expect(html).toContain(`v${pkg.version}`);
  }, 90_000);
});
