import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The room's House board as columns, in the UI preview in real headless Chrome: local only (CI runners have no
// desktop); the script passes a mock keychain. ?houseBoardAudit (src/preview/stub.ts) drags cards with the events a
// browser sends, against the preview's fixture House (nothing reaches the real one), and reports what was on screen
// and which House writes were made after each step.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type Columns = Record<"Ready" | "In progress" | "Review" | "Validating", number[]>;
type Line = { owner: number | "empty"; column: string | null; height: number } | null;
type Hover = { accepted: boolean; line: Line; label: string | null; labelRefused: boolean; drop: string | null; refuseNote: string | null; lifted: number[] };
type Write = Record<string, unknown>;

async function audit(query: string, size = "1400x900"): Promise<any> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({ size, query, outDir: path.join(tempDir("house"), "out"), read: `document.getElementById("mb-house-audit")?.textContent ?? null` });
  if (!json) throw new Error("the preview didn't finish its House board audit");
  return JSON.parse(json);
}

describe.skipIf(!local)("the House board's columns", () => {
  it("shows a column per status, moves a dragged card by the House's own writes with a line where it lands, and refuses Done", async () => {
    const a: {
      start: Columns;
      heads: string[];
      folds: string[];
      parkedShown: number;
      doneCards: number;
      droppedColumn: boolean;
      across: Hover;
      dropped: { columns: Columns; line: Line; lifted: number };
      afterAcross: { columns: Columns; writes: Write[] };
      same: Hover;
      afterSame: { writes: Write[]; line: Line; label: boolean };
      done: Hover;
      afterDone: { columns: Columns; writes: Write[] };
      claim: Hover;
      asking: { columns: Columns; branch: string | null; writes: number };
      afterClaim: { columns: Columns; writes: Write[] };
      release: Hover;
      afterRelease: { columns: Columns; writes: Write[] };
      keyboard: { columns: Columns; writes: Write[]; focused: number | null };
    } = await audit("motion=off&houseBoardAudit");

    // the columns in the House's flow, each in the House's order (high priority first), with their counts; Parked
    // folded into a row above them, Done folded with its count, Dropped hidden
    expect(a.start).toEqual({ Ready: [146, 142, 148, 149], "In progress": [141, 144, 151], Review: [143], Validating: [152] });
    expect(a.heads).toEqual(["Ready4", "In progress3", "Review1", "Validating1", "Done · 1 ▸"]);
    expect(a.folds).toEqual(["Parked · 3 ▸"]);
    expect(a.parkedShown).toBe(0);
    expect(a.doneCards).toBe(0);
    expect(a.droppedColumn).toBe(false);

    // Review → Validating: the line above #152, where the House's order puts #143, and the label says what changes
    expect(a.across.accepted).toBe(true);
    expect(a.across.line).toMatchObject({ owner: 152, column: "Validating", height: 2 });
    expect(a.across.label).toMatch(/^#143 → Validating \(review → validating\)\s*esc cancels$/);
    expect(a.across.lifted).toEqual([143]);
    expect(a.dropped).toMatchObject({ line: null, lifted: 0 });
    expect(a.dropped.columns.Validating).toEqual([143, 152]);
    expect(a.afterAcross.writes).toEqual([{ kind: "event", n: 143, event: "status", status: "validating", text: "Moved from Review to Validating on the room's board." }]);
    expect(a.afterAcross.columns).toMatchObject({ Review: [], Validating: [143, 152] });

    // within its own column: no line and no drop (the House has no rank a builder can write); Esc cancels
    expect(a.same.accepted).toBe(false);
    expect(a.same.line).toBeNull();
    expect(a.same.label).toMatch(/^Moving #149 — drop it on another column/);
    expect(a.afterSame).toEqual({ writes: a.afterAcross.writes, line: null, label: false });

    // over Done (folded): refused, outlined as refused, and the label says why; the drop writes nothing
    expect(a.done).toMatchObject({ accepted: false, line: null, labelRefused: true, drop: "refused" });
    expect(a.done.label).toMatch(/^Only House staff close tickets/);
    expect(a.afterDone.writes).toEqual(a.afterAcross.writes);
    expect(a.afterDone.columns).toEqual(a.afterAcross.columns);

    // Ready → In progress, unclaimed: a claim — the branch asked on the card as the Claim button asks, then claimed
    expect(a.claim.line).toMatchObject({ owner: 144, column: "In progress" });
    expect(a.claim.label).toMatch(/^Claim #146 → In progress/);
    expect(a.asking.columns["In progress"]).toEqual([141, 146, 144, 151]);
    expect(a.asking.branch).toBe("feature/146-donor-export-skips-archived-donors");
    expect(a.asking.writes).toBe(1);
    expect(a.afterClaim.writes.slice(1)).toEqual([{ kind: "claim", n: 146, branch: "feature/146-donor-export-skips-archived-donors" }]);
    expect(a.afterClaim.columns["In progress"]).toEqual([141, 146, 144, 151]);

    // In progress → Ready, yours: a release
    expect(a.release.label).toMatch(/^Release #151 → Ready/);
    expect(a.release.line).toMatchObject({ owner: 149, column: "Ready" });
    expect(a.afterRelease.writes.slice(2)).toEqual([{ kind: "release", n: 151 }]);
    expect(a.afterRelease.columns.Ready).toEqual([142, 148, 151, 149]);

    // ⌥← on the focused card: back a column, by the same write, keeping the focus
    expect(a.keyboard.writes.slice(3)).toEqual([{ kind: "event", n: 143, event: "status", status: "review", text: "Moved from Validating to Review on the room's board." }]);
    expect(a.keyboard.columns).toMatchObject({ Review: [143], Validating: [152] });
    expect(a.keyboard.focused).toBe(143);
  }, 120_000);

  it("puts a card back, and says why, when the House refuses the move", async () => {
    const a = await audit("motion=off&houseBoardAudit=fail&houseRefuse");
    expect(a.optimistic).toMatchObject({ Review: [], Validating: [143, 152] });
    expect(a.after).toMatchObject({ Review: [143], Validating: [152] });
    expect(a.writes).toEqual([{ kind: "event", n: 143, event: "status", status: "validating", text: "Moved from Review to Validating on the room's board." }]);
    expect(a.error).toMatch(/^Couldn't move #143 to Validating — it's back in Review: The House answered 403: only the claimant moves #143 on/);
  }, 120_000);

  it("scrolls its columns sideways inside the board in a narrow window, never the dialog, which stays in the window", async () => {
    const a = await audit("motion=off&houseBoardAudit=narrow", "700x900");
    expect(a.narrow).toEqual({ modalScrolls: false, colsScroll: true, modalInWindow: true, overflowX: "auto" });
  }, 120_000);
});
