import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// Terminals' sizes through everything that moves or re-fits them, in the UI preview in real headless Chrome: local
// only (CI runners have no desktop); the script passes a mock keychain. ?termAudit (src/preview/stub.ts) fills the
// panes with history, streams output, does each action, finishes its animations, and reports what was wrong after
// it; then Repaints and relaunches a pane in place. Tests read that report, never frames caught in flight.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type Audit = {
  steps: string[];
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

describe.skipIf(!local)("terminals in the interface", () => {
  for (const motion of ["full", "off"] as const) {
    it(`fit their holders and give their ptys that size after every action, never measuring a holder with no area: motion ${motion}`, async () => {
      const a = await audit(motion);
      expect(a.error).toBeUndefined();
      expect(a.mode).toBe(motion);
      expect(a.steps).toHaveLength(15);
      expect(a.problems).toEqual([]);

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
