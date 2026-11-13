import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The pipeline strip in focus (W6) in the UI preview, in real headless Chrome: local only (CI runners have no desktop);
// the script passes a mock keychain. ?landscapeStripAudit (src/preview/stripAudit.ts) works it as a person would, keys
// and the mouse pressed for real through Chrome, over the wires board with ?wires=fanout (src/preview/wiresAudit.ts):
// Shape export handed on to Builder, Builder sending to Reviewer, whose changes are ready to go back and whose handoff
// to Tester waits for approve; Builder also hands on to Spike (closed) and Docs (a stack's tab behind Fixtures).
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type Moved = { focused: string | null; keyboard: string; wrote?: number };
type Typed = Moved & { toReviewer: number; toTester: number };
interface StripAudit {
  noWires: { focused: string | null; strip: boolean; sent: string | null; want: string };
  noWiresKey: Moved & { note: string | null };
  wired: { focused: string | null; strip: number | null; nodeTop: number; sent: string | null; want: string; keyboard: string };
  steps: string[];
  arrows: string[];
  attached: string[];
  inView: string[];
  fresh: { focused: string | null; heldOff: boolean };
  fold: { strip: number | null; nodeTop: number; sent: string[]; want: string; pref: string | null };
  unfold: { strip: number | null; sent: string[]; want: string; pref: string | null };
  inTerminal: Moved;
  byCode: Moved;
  altRight: Moved & { pressed: string };
  inViewOn: string[];
  altLeft: Moved;
  soonAfter: Moved & { stayed: boolean; heldOff: boolean };
  cmdRight: Moved & { before: string };
  cmdLeft: Moved;
  held: Typed;
  noTerm: Moved;
  more: string[];
  stackTab: Moved & { back: string | null };
  ghost: Moved;
  dbl: Typed & { under: string | null };
  clicked: Moved;
  inField: Moved;
  nothingBack: { back: (string | null)[]; note: string | null; overFocus: boolean };
  error?: string;
}

async function run(): Promise<StripAudit> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({
    size: "1440x900",
    query: "motion=off&wires=fanout&landscapeStripAudit",
    outDir: path.join(tempDir("strip"), "out"),
    read: `document.getElementById("mb-landscape-strip-audit")?.textContent ?? null`,
  });
  if (!json) throw new Error("the preview didn't finish the strip audit");
  return JSON.parse(json);
}

describe.skipIf(!local)("the pipeline strip", () => {
  it("shows only with wires, takes its height off the pty's rows, folds with one resize, takes its keys only when armed, and its clicks only when aimed", async () => {
    const r = await run();
    // case by case, so a run that went wrong fails on the first case it did, before what it couldn't do after
    expect(r.noWires).toMatchObject({ focused: "s1", strip: false });
    expect(r.noWires.sent).toBe(r.noWires.want);
    // an arrow there says there's nothing to move along, rather than doing nothing
    expect(r.noWiresKey).toEqual({ keyboard: "terminal s1", focused: "s1", note: "No wires reach this workspace: there's no pipeline to move along", wrote: 0 });
    expect(r.wired).toMatchObject({ focused: "wb-builder", strip: 64, nodeTop: 64, keyboard: "terminal wb-builder" });
    expect(r.wired.sent).toBe(r.wired.want);
    expect(r.steps).toEqual(["wb-shape: claude · handed on", "wb-builder: codex · working · you're here", "wb-reviewer: changes ready · ↺ 2 of 3", "wb-tester: waits for approve"]);
    // each wire between steps in its gate's state, as the drawn wires have it
    expect(r.arrows).toEqual(["wb-sent: sent", "wb-sending: sending", "wb-held: blocked"]);
    expect(r.attached).toEqual(["wb-dev", "s5"]);
    // with the side bar narrowing it, Attached gives up its room first (its context link's "· context", then its titles
    // to their floor), so from Builder both neighbours show whole, clear of the fades; and from Reviewer
    expect(r.inView).toEqual(["wb-shape", "wb-builder", "wb-reviewer"]);
    expect(r.inViewOn).toEqual(["wb-builder", "wb-reviewer", "wb-tester"]);
    // a click on a step only just shown is let go, the step off a moment
    expect(r.fresh).toEqual({ focused: "wb-builder", heldOff: true });
    expect(r.fold).toMatchObject({ strip: 28, nodeTop: 28, sent: [r.fold.want], pref: "true" });
    expect(r.unfold).toMatchObject({ strip: 64, sent: [r.unfold.want], pref: "false" });

    // its keys: never typed into a terminal, never on a frame the user didn't arm
    expect(r.inTerminal).toEqual({ keyboard: "terminal wb-builder", focused: "wb-builder", wrote: 1 });
    expect(r.byCode).toEqual({ keyboard: "frame", focused: "wb-builder", wrote: 0 });
    // armed by a press: along the chain, the keyboard kept on the frame
    expect(r.altRight).toEqual({ pressed: "frame", focused: "wb-reviewer", keyboard: "frame" });
    expect(r.altLeft).toEqual({ focused: "wb-builder", keyboard: "frame", wrote: 0 });
    // a click straight after a move is let go, even on what stayed where it was
    expect(r.soonAfter).toEqual({ focused: "wb-reviewer", stayed: true, heldOff: true, keyboard: "frame" });
    // ⌘⌥ from inside a terminal: taken before the terminal sees it
    expect(r.cmdRight).toEqual({ before: "terminal wb-builder", focused: "wb-reviewer", keyboard: "terminal wb-reviewer", wrote: 0 });
    expect(r.cmdLeft).toEqual({ focused: "wb-builder", keyboard: "terminal wb-builder", wrote: 0 });
    // held, ⌘⌥→ moves once: its repeats don't walk on, so what's typed next goes where it stopped
    expect(r.held).toEqual({ focused: "wb-reviewer", keyboard: "terminal wb-reviewer", toReviewer: 1, toTester: 0 });
    // a step whose terminal can't take the keyboard leaves it with focus's frame, not a terminal out of sight
    expect(r.noTerm).toEqual({ focused: "wb-reviewer", keyboard: "frame" });
    // the +2 list: a stack's tab behind comes to the front with the frame armed; a closed one leaves focus for its ghost
    expect(r.more).toEqual(["# Also from Builder", "Spike: streaming · claude · closed", "Docs · claude · idle", "# ⌥→ takes Reviewer; click for one of these"]);
    expect(r.stackTab).toEqual({ focused: "wb-docs", keyboard: "frame", back: "wb-builder" });
    expect(r.ghost).toMatchObject({ focused: null, keyboard: expect.stringContaining("ls-viewport") });
    // a double click on Reviewer goes to Reviewer: its second click, on Tester's step come under the pointer, is let go
    expect(r.dbl).toEqual({ under: "wb-tester", focused: "wb-reviewer", keyboard: "terminal wb-reviewer", toReviewer: 1, toTester: 0 });
    expect(r.clicked).toEqual({ focused: "wb-tester", keyboard: "terminal wb-tester" });
    // nor from a field elsewhere in the window
    expect(r.inField).toEqual({ focused: "wb-tester", keyboard: "strip-audit-field" });
    // walking back to the top, then once more: said over focus
    expect(r.nothingBack).toEqual({ back: ["wb-reviewer", "wb-builder", "wb-shape", "wb-shape"], note: "Nothing hands work on to this workspace", overFocus: true });
    expect(r.error).toBeUndefined();
  }, 120_000);
});
