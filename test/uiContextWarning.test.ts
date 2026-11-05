import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The context warning and the cost check before a resume, driven in the UI preview in real headless Chrome: local
// only (CI runners have no desktop); the script passes a mock keychain. ?ctxAudit (src/preview/stub.ts) clicks
// through it and reports what it found; nothing real runs (the preview's sessions are fixtures).
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

async function audit(query: string): Promise<Record<string, any>> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({ size: "1400x900", query: `motion=off&${query}`, outDir: path.join(tempDir("ctxwarn"), "out"), read: `document.getElementById("mb-ctx-audit")?.textContent ?? null` });
  if (!json) throw new Error("the preview didn't finish its context-warning audit");
  return JSON.parse(json);
}

describe.skipIf(!local)("a pane's context warning", () => {
  it("of a session a teammate took over: its brief, its header's Undo and Codex, ⌘K's and the Changes tool's Second opinion all off, saying why", async () => {
    const a = await audit("shown=y1,s1&view=scm&ctxAudit=takenOver");
    const TAKE_BACK = /^Nick Smith continues it on their laptop: take it back/;
    expect(a.shown).toBe(true);
    expect(a.brief).toEqual({ disabled: true, title: expect.stringMatching(TAKE_BACK) });
    // its pane header: Undo and Codex there, off, each saying why; a session of this Mac's own beside it has them on
    expect(a.controls.y1, JSON.stringify(a)).toEqual([
      { t: "Undo", off: true, why: expect.stringMatching(TAKE_BACK) },
      { t: "Codex", off: true, why: expect.stringMatching(TAKE_BACK) },
    ]);
    expect(a.controls.s1).toEqual([
      { t: "Undo", off: false, why: null },
      { t: "Codex", off: false, why: null },
    ]);
    // ⌘K: the same two, off with the reason beside them; s1's on
    expect(a.palette.y1).toEqual([
      { label: expect.stringMatching(/^Undo a turn of Donor entity model/), off: expect.stringMatching(TAKE_BACK) },
      { label: expect.stringMatching(/^Continue in Codex — /), off: expect.stringMatching(TAKE_BACK) },
    ]);
    expect(a.palette.s1).toEqual([
      { label: expect.stringMatching(/^Undo a turn of /), off: null },
      { label: expect.stringMatching(/^Continue in Codex — /), off: null },
    ]);
    // its off row chosen, by Enter as the first row and by a click: nothing runs, the palette stays open
    const stayed = { palette: true, undoDialog: false, turnsList: 0 };
    expect(a.chosenOff).toEqual({ row: { label: expect.stringMatching(/^Undo a turn of Donor entity model/), off: true, sel: true }, enter: stayed, click: stayed });
    // the Changes tool's Second opinion: off for it, saying why; on for s1
    expect(a.review).toEqual({ y1: { off: true, why: expect.stringMatching(TAKE_BACK) }, s1: { off: false, why: null } });
  }, 120_000);

  it("past 75% and idle: an amber chip in the pane header; its popover's Compact sends /compact on the click only, and the chip goes once the context drops", async () => {
    const a = await audit("shown=s5&ctxAudit=idle");
    expect(a.shown).toBe(true);
    expect(a.inHeader).toBe(true);
    expect(a.tone).toBe("heads");
    expect(a.chip).toBe("ctx 79%");
    expect(a.popBeforeClick).toBe(false); // nothing opens by itself
    expect(a.popTone).toBe("heads");
    expect(a.headline).toBe("Context 79% full");
    expect(a.sub).toMatch(/^760k of 967k used\. Near the limit, Claude compacts by itself and keeps only its own summary\.$/);
    expect(a.hasBrief).toBe(true);
    expect(a.note).toBeNull();
    expect(a.compactDisabled).toBe(false);
    expect(a.sentBeforeClick).toBe(0); // nothing reaches the session by itself
    expect(a.typedBeforeClick).toBe(0);
    expect(a.sentAfterClick).toBe(1);
    expect(a.compactingChip).toBe("compacting…");
    expect(a.clearedAfterCompact).toBe(true);
  }, 120_000);

  it("past 90% while asking for permission: a red chip, Compact held back with the reason; Dismiss hides it at that level", async () => {
    const a = await audit("shown=s2,s1&ctxAudit=waiting");
    expect(a.tone).toBe("firm");
    expect(a.chip).toBe("ctx 91%");
    expect(a.popTone).toBe("firm");
    expect(a.headline).toBe("Context 91% full: it compacts by itself soon");
    expect(a.sub).toMatch(/^152k of 167k used\./);
    expect(a.compactDisabled).toBe(true);
    expect(a.compactTitle).toMatch(/asking for permission/);
    expect(a.note).toBe("Compact waits: it's asking for permission: answer that first.");
    expect(a.sentAfterClick).toBe(0);
    expect(a.dismissedGone).toBe(true);
    expect(a.dismissal).toEqual({ s2: { level: 2 } });
  }, 120_000);
});

describe.skipIf(!local)("resuming a big conversation whose cache is cold", () => {
  it("asks first with the estimate in plain words; Cancel leaves it, Continue resumes it", async () => {
    const a = await audit("shown=s6&ctxAudit=resume");
    expect(a.asked).toBe(true);
    expect(a.say).toBe("Resuming this re-reads about 380k tokens, roughly 7.5% of your 5-hour limit.");
    expect(a.why).toMatch(/^Cold: its cache went cold 3 hr ago, so they're written to the cache again at about 1\.25× the input price/);
    expect(a.afterCancel).toEqual({ dialog: false, killed: 0, relaunched: 0 });
    expect(a.afterContinue).toEqual({ dialog: false, relaunched: 1 });
  }, 120_000);
});
