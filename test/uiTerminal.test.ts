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
  const json: string | null = await pageResult({ size: "1400x900", query: `motion=${motion}&scrollAudit`, outDir: path.join(tempDir("scroll"), "out"), read: `document.getElementById("mb-scroll-audit")?.textContent ?? null` });
  if (!json) throw new Error("the preview didn't finish its scroll audit");
  return JSON.parse(json);
}

type CopyAudit = {
  copies: Record<string, { cols: number; mouse: string; onSelect: string[]; copyEvent: string[] }>;
  expected: { agent: string[]; shell: string[] };
  error?: string;
};

describe.skipIf(!local)("copying a pane's selection", () => {
  it("gives an agent's long command and sentence back whole, on release and with ⌘C, and a shell's as before", async () => {
    // @ts-expect-error — a plain .mjs build script, no type declarations
    const { pageResult } = await import("../scripts/ui-preview.mjs");
    const json: string | null = await pageResult({ size: "1400x900", query: "copyAudit", outDir: path.join(tempDir("copy"), "out"), read: `document.getElementById("mb-copy-audit")?.textContent ?? null` });
    if (!json) throw new Error("the preview didn't finish its copy audit");
    const a: CopyAudit = JSON.parse(json);
    expect(a.error).toBeUndefined();
    const ids = Object.keys(a.copies);
    expect(ids).toEqual(["s1", expect.stringMatching(/^r~/), "s3", "s4"]);
    for (const id of ids) {
      const c = a.copies[id];
      // narrow enough that the agent had to cut the path, and nothing tracking the mouse: the selection is xterm's
      expect(c.cols, id).toBeLessThan(120);
      expect(c.mouse, id).toBe("none");
      const expected = id === "s4" ? a.expected.shell : a.expected.agent;
      expect(c.onSelect, id).toEqual(expected);
      expect(c.copyEvent, id).toEqual(expected);
    }
  }, 120_000);
});

describe.skipIf(!local)("terminals following their output", () => {
  for (const motion of ["full", "off"] as const) {
    it(`stay at the bottom through every action unless the user scrolled up, with nothing to scroll below the program's last line: motion ${motion}`, async () => {
      const a = await scrollAudit(motion);
      expect(a.error).toBeUndefined();
      expect(a.mode).toBe(motion);
      expect(a.shown).toEqual(expect.arrayContaining(["s1", "s4", expect.stringMatching(/^r~/)]));
      // the viewport internals cachedTerm.ts resyncs (an xterm upgrade that renames them fails here)
      expect(a.internals).toBe(true);
      expect(a.steps).toEqual(["start", "group switch", "teammate's screen grew", "side bar hidden", "side bar shown", "bottom panel shown", "bottom panel hidden", "inline frame", "scrolled up, then back", "Repaint"]);
      expect(a.problems).toEqual([]);
    }, 120_000);
  }
});

describe.skipIf(!local)("terminals in the interface", () => {
  for (const motion of ["full", "off"] as const) {
    it(`fit their holders and give their ptys that size after every action, never measuring a holder with no area: motion ${motion}`, async () => {
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
