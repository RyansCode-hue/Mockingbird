import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// An area's Colour popover in the UI preview, in real headless Chrome: local only (CI runners have no desktop); the
// script passes a mock keychain. ?landscapeColourAudit (src/preview/colourAudit.ts) opens it from an area's bar dot,
// its ⋯, its tree square and its header as a person would, picks with the keyboard and the mouse, and reports what each
// step drew and saved (window.__mbCalls), once it settled.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type Drawn = { bar: number | null; area: number | null; tree: number | null };
type Seen = { label: string | null; choices: string[]; checked: string[]; tabbable: string[]; keyboard: string; below: boolean; inWindow: boolean } | null;
type Patch = { areas?: Record<string, Record<string, unknown> | null> };
interface A {
  before: { drawn: Drawn; stored: number | null };
  opened: Seen;
  walk: string[];
  picked: { open: boolean; updates: Patch[]; stored: number | null; drawn: Drawn; keyboard: string };
  escaped: { again: Seen; open: boolean; updates: Patch[]; keyboard: string; drawn: Drawn };
  automatic: { fromMenu: Seen; open: boolean; updates: Patch[]; hasAccent: boolean; drawn: Drawn };
  treeBefore: number | null;
  tree: { fromTree: Seen; open: boolean; updates: Patch[]; stored: number | null; square: number | null; area: number | null; keyboard: string };
  treeEscaped: { again: Seen; open: boolean; updates: Patch[]; keyboard: string };
  error?: string;
}
interface B {
  opened: Seen;
  escaped: { open: boolean; updates: Patch[]; keyboard: string };
  error?: string;
}

async function run<T>(part: string, query = ""): Promise<T> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const id = `mb-landscape-colour-audit-${part}`;
  const json: string | null = await pageResult({
    size: "1400x900",
    query: `motion=off&landscapeColourAudit=${part}${query ? `&${query}` : ""}`,
    outDir: path.join(tempDir(id), "out"),
    read: `document.getElementById(${JSON.stringify(id)})?.textContent ?? null`,
  });
  if (!json) throw new Error(`the preview didn't finish ${id}`);
  return JSON.parse(json);
}

/** The popover's choices in order: Automatic with the colour it gives, then the swatches round the wheel. */
const choices = (auto: string) => [`Automatic (${auto})`, "Red", "Amber", "Brown", "Olive", "Green", "Teal", "Blue", "Slate", "Violet", "Pink"];

describe.skipIf(!local)("an area's Colour popover", () => {
  it("opens from the area's bar dot, its ⋯ and its tree square, picks by keyboard and mouse, saves the area's record and redraws it; Esc changes nothing", async () => {
    const a = await run<A>("a");
    expect(a.error).toBeUndefined();

    // 5102 takes Teal automatically, drawn alike on its bar, its patch and its tree square
    expect(a.before).toEqual({ drawn: { bar: 1, area: 1, tree: 1 }, stored: null });

    // its bar's dot: a radio group under the dot, in the window, Automatic marked and the keyboard on it
    expect(a.opened).toEqual({
      label: "#5102 Pathways quick view freezes: colour",
      choices: choices("Teal"),
      checked: ["auto"],
      tabbable: ["auto"],
      keyboard: "choice auto",
      below: true,
      inWindow: true,
    });
    // ↓ to the first swatch, → along the row, ↓ to the row below
    expect(a.walk).toEqual(["choice 6", "choice 0", "choice 2"]);
    // Enter picks Blue: one patch to the area's record, drawn everywhere. A press on the landscape's own button left the
    // keyboard with the landscape, so that's where it goes back
    expect(a.picked).toEqual({ open: false, updates: [{ areas: { "5102": { accent: 2 } } }], stored: 2, drawn: { bar: 2, area: 2, tree: 2 }, keyboard: "landscape" });

    // Esc: closed with nothing saved, Blue still drawn, the keyboard back with the landscape, armed as the user left it
    expect(a.escaped.again).toMatchObject({ checked: ["2"], keyboard: "choice 2", below: true });
    expect(a.escaped).toMatchObject({ open: false, updates: [], keyboard: "landscape, armed", drawn: { bar: 2, area: 2, tree: 2 } });

    // ⋯'s Colour…: the same popover over the bar's dot, Blue marked; Automatic takes the colour off the record
    expect(a.automatic.fromMenu).toMatchObject({ checked: ["2"], keyboard: "choice 2", below: true, inWindow: true });
    expect(a.automatic).toMatchObject({ open: false, updates: [{ areas: { "5102": { accent: null } } }], hasAccent: false, drawn: { bar: 1, area: 1, tree: 1 } });

    // 5110, a room's area, Red in the fixture: from its tree square, Red marked; Green clicked is saved to this Mac's record
    expect(a.treeBefore).toBe(6);
    expect(a.tree.fromTree).toMatchObject({ choices: choices("Olive"), checked: ["6"], keyboard: "choice 6", below: true, inWindow: true });
    expect(a.tree).toMatchObject({ open: false, updates: [{ areas: { "5110": { accent: 7 } } }], stored: 7, square: 7, area: 7, keyboard: "dot 5110 in the tree" });
    // the square, outside the landscape, had the keyboard: Esc gives it back there, nothing saved
    expect(a.treeEscaped.again).toMatchObject({ checked: ["7"], keyboard: "choice 7", below: true });
    expect(a.treeEscaped).toMatchObject({ open: false, updates: [], keyboard: "dot 5110 in the tree" });
  }, 120_000);

  it("opens from the area's header dot, and Esc gives the keyboard back to the landscape, which had it", async () => {
    const b = await run<B>("b", "lsCamera=-100,-200,0.6");
    expect(b.error).toBeUndefined();
    expect(b.opened).toMatchObject({ label: "#5101 Org dropdowns remember the last org: colour", checked: ["auto"], keyboard: "choice auto", below: true, inWindow: true });
    expect(b.escaped).toEqual({ open: false, updates: [], keyboard: "landscape, armed" });
  }, 120_000);
});
