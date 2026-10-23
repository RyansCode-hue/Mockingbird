import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// Reordering the Dashboard's cards, in the UI preview in real headless Chrome: local only (CI runners have no
// desktop); the script passes a mock keychain. ?boardAudit (src/preview/stub.ts) drags cards with the events a
// browser sends, finishes each animation rather than waiting on it, and reports what was on screen at each gap and
// the board after each drop. Tests read that report, never frames caught in flight.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type Box = { top: number; bottom: number } | null;
type Line = { owner: number | "empty"; y: number; height: number; color: string; width: number } | null;
type Hover = { line: Line; above: Box; below: Box; shifts: Record<string, number>; label: string | null; lifted: number[] };
type Columns = Record<"New" | "In Progress" | "Testing", number[]>;
type Write = [string, ...unknown[]];
type Audit = {
  mode: string;
  start: Columns;
  top: Hover;
  middle: Hover;
  readsBefore: number;
  dropped: { columns: Columns; line: Line; lifted: number };
  afterDrop: { columns: Columns; writes: Write[]; reads: number };
  bottom: Hover;
  cancelled: { columns: Columns; writes: Write[]; reads: number; line: Line; lifted: number; label: boolean };
  empty: Hover;
  afterEmpty: { columns: Columns; writes: Write[] };
  across: Hover;
  afterAcross: { columns: Columns; writes: Write[] };
  keyboard: { moved: number; columns: Columns; writes: Write[]; focused: number | null; outline: string | null };
  optimistic: Columns;
  after: Columns;
  error: string | null;
  writes: Write[];
};

async function audit(query: string): Promise<Audit> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({ size: "1400x900", query, outDir: path.join(tempDir("board"), "out"), read: `document.getElementById("mb-board-audit")?.textContent ?? null` });
  if (!json) throw new Error("the preview didn't finish its board audit");
  return JSON.parse(json);
}

/** The line sits in the gap: below the card above it and above the card below it, as they are on screen. */
const inGap = (h: Hover) => {
  expect(h.line).not.toBeNull();
  if (h.above) expect(h.line!.y).toBeGreaterThan(h.above.bottom);
  if (h.below) expect(h.line!.y).toBeLessThan(h.below.top);
};

describe.skipIf(!local)("reordering the Dashboard's cards", () => {
  for (const motion of ["full", "reduce"] as const) {
    it(`marks the gap a dragged card would land in with a line, puts it there on drop, and cancels on Esc: motion ${motion}`, async () => {
      const a = await audit(`motion=${motion}&boardAudit`);
      expect(a.mode).toBe(motion);
      expect(a.start["In Progress"]).toEqual([5101, 5102, 5115]);

      // over the top of the column: the line is above the first card, which the card being dragged stays behind, faded
      expect(a.top.line).toMatchObject({ owner: 5101, height: 2 });
      expect(a.top.line!.width).toBeGreaterThan(200);
      inGap(a.top);
      expect(a.top.lifted).toEqual([5115]);
      expect(a.top.label).toMatch(/^Put #5115 above #5101\s*esc cancels$/);
      // between two cards: the line between them; under full motion they part to open the gap, otherwise only the line
      expect(a.middle.line?.owner).toBe(5102);
      inGap(a.middle);
      expect(a.middle.label).toMatch(/^Put #5115 between #5101 and #5102/);
      const open = motion === "full" ? 4 : 0;
      expect(a.middle.shifts).toEqual({ "5101": open ? -open : 0, "5102": open, "5115": 0 });

      // dropped: there at once, written once, and still there after the board is re-read
      expect(a.dropped.columns["In Progress"]).toEqual([5101, 5115, 5102]);
      expect(a.dropped.line).toBeNull();
      expect(a.dropped.lifted).toBe(0);
      expect(a.afterDrop.writes).toEqual([["adoReorder", 5115, 5101, 5102]]);
      expect(a.afterDrop.reads).toBe(a.readsBefore + 1);
      expect(a.afterDrop.columns["In Progress"]).toEqual([5101, 5115, 5102]);

      // the bottom of the column, then Esc: no line, nothing lifted, nothing written or re-read, nothing moved
      expect(a.bottom.line?.owner).toBe(5102);
      inGap(a.bottom);
      expect(a.bottom.label).toMatch(/below #5102/);
      expect(a.cancelled).toEqual({ columns: a.afterDrop.columns, writes: a.afterDrop.writes, reads: a.afterDrop.reads, line: null, lifted: 0, label: false });

      // into a column showing no cards: a line at its top, and a move with no reorder
      expect(a.empty.line?.owner).toBe("empty");
      expect(a.empty.label).toMatch(/^#5110 → Testing \(New → Resolved\)/);
      expect(a.afterEmpty.columns.Testing).toEqual([5110]);
      expect(a.afterEmpty.writes.slice(1)).toEqual([["adoMoveToColumn", 5110, "User Story", "Stories", "Testing"]]);

      // into the middle of another column: moved, then placed between its new neighbours
      expect(a.across.line?.owner).toBe(5115);
      inGap(a.across);
      expect(a.across.label).toMatch(/^#5120 → In Progress, between #5101 and #5115/);
      expect(a.afterAcross.writes.slice(2)).toEqual([
        ["adoMoveToColumn", 5120, "Bug", "Stories", "In Progress"],
        ["adoReorder", 5120, 5101, 5115],
      ]);
      expect(a.afterAcross.columns).toEqual({ New: [], "In Progress": [5101, 5120, 5115, 5102], Testing: [5110] });

      // ⌥↑ on the focused bottom card: one place up, by the same write, and it keeps the focus, which shows
      expect(a.keyboard.moved).toBe(5102);
      expect(a.keyboard.writes.slice(4)).toEqual([["adoReorder", 5102, 5120, 5115]]);
      expect(a.keyboard.columns["In Progress"]).toEqual([5101, 5120, 5102, 5115]);
      expect(a.keyboard.focused).toBe(5102);
      expect(a.keyboard.outline).toBe("solid");
    }, 120_000);
  }

  it("puts a card back, and says why, when Azure DevOps refuses the reorder", async () => {
    const a = await audit("motion=off&boardAudit=fail&reorderFail");
    expect(a.optimistic["In Progress"]).toEqual([5115, 5101, 5102]);
    expect(a.after["In Progress"]).toEqual([5101, 5102, 5115]);
    expect(a.writes).toEqual([["adoReorder", 5115, 0, 5101]]);
    expect(a.error).toMatch(/^Couldn't put #5115 above #5101 — it's back where it was: Azure DevOps 403 Forbidden/);
  }, 120_000);
});
