import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// Terminals' sizes through everything that moves or re-fits them, in the UI preview in real headless Chrome: local
// only (CI runners have no desktop); the script passes a mock keychain. ?termAudit (src/preview/stub.ts) fills the
// workspaces with history, streams output, does each action, finishes its animations, and reports what was wrong after
// it; then Repaints and relaunches a workspace in place. Tests read that report, never frames caught in flight.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type Audit = {
  steps: string[];
  /** The pty sizes each step sent, as "<id> <cols>×<rows>". */
  resized: Record<string, string[]>;
  problems: string[];
  repaint: { before: { lines: number; first: string }; after: { lines: number; first: string }; size: string; sent: string[] };
  repaintAlt: { before: { screen: string; mouse: string }; after: { screen: string; mouse: string } };
  relaunch: { newTerminal: boolean; sent: string[] };
  mode: string;
  error?: string;
};

async function audit(motion: "full" | "off"): Promise<Audit> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({ size: "1400x900", query: `motion=${motion}&termAudit`, outDir: path.join(tempDir("term"), "out"), read: `document.getElementById("mb-term-audit")?.textContent ?? null` });
  if (!json) throw new Error("the preview didn't finish its terminal audit");
  return JSON.parse(json);
}

type ScrollAudit = { steps: string[]; shown: string[]; internals: boolean; problems: string[]; mode: string; error?: string };

async function scrollAudit(motion: "full" | "off"): Promise<ScrollAudit> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({ size: "3200x2000", query: `motion=${motion}&scrollAudit`, outDir: path.join(tempDir("scroll"), "out"), read: `document.getElementById("mb-scroll-audit")?.textContent ?? null` });
  if (!json) throw new Error("the preview didn't finish its scroll audit");
  return JSON.parse(json);
}

describe.skipIf(!local)("terminals following their output", () => {
  for (const motion of ["full", "off"] as const) {
    it(`stay at the bottom through every action unless the user scrolled up, with nothing to scroll below the program's last line: motion ${motion}`, async () => {
      const a = await scrollAudit(motion);
      expect(a.error).toBeUndefined();
      expect(a.mode).toBe(motion);
      expect(a.shown).toEqual(expect.arrayContaining(["s1", "s4", expect.stringMatching(/^r~/)]));
      // the viewport internals cachedTerm.ts resyncs (an xterm upgrade that renames them fails here)
      expect(a.internals).toBe(true);
      expect(a.steps).toEqual(["start", "off screen and back", "teammate's screen grew", "side bar hidden", "side bar shown", "bottom panel shown", "bottom panel hidden", "inline frame", "scrolled up, then back", "Repaint"]);
      expect(a.problems).toEqual([]);
    }, 120_000);
  }
});

describe.skipIf(!local)("terminals in the interface", () => {
  for (const motion of ["full", "off"] as const) {
    it(`take their workspaces' sizes and give their ptys that size after every action, never measuring a holder with no area: motion ${motion}`, async () => {
      const a = await audit(motion);
      expect(a.error).toBeUndefined();
      expect(a.mode).toBe(motion);
      expect(a.steps).toHaveLength(17);
      expect(a.problems).toEqual([]);

      // a pane's status banners float over its terminal: showing or clearing one re-fits nothing, so the agent
      // isn't resized into redrawing its screen
      const banners = ["waiting banner shown", "waiting banner gone", "stall banner shown", "stall banner gone"];
      expect(Object.fromEntries(banners.map((s) => [s, a.resized[s]]))).toEqual(Object.fromEntries(banners.map((s) => [s, []])));

      // Repaint keeps the scrollback (an inline session's whole history) and asks the program to redraw by a
      // resize round trip that ends at the terminal's size
      expect(a.repaint.before.lines).toBeGreaterThan(3000);
      expect(a.repaint.after).toEqual(a.repaint.before);
      const [cols, rows] = a.repaint.size.split("×").map(Number);
      expect(a.repaint.sent).toEqual([`${cols - 1}×${rows}`, `${cols}×${rows}`]);
      // ...and the modes the program set: still on the alternate screen, its mouse tracking still on
      expect(a.repaintAlt.before).toEqual({ screen: "alternate", mouse: "vt200" });
      expect(a.repaintAlt.after).toEqual(a.repaintAlt.before);

      // a session relaunched in place gets a new terminal, and its new pty is told the pane's size
      expect(a.relaunch.newTerminal).toBe(true);
      expect(a.relaunch.sent).toHaveLength(1);
    }, 120_000);
  }
});
