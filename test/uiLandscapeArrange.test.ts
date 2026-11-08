import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { overlaps } from "../src/shared/landscape";

// Moving, resizing, stacks and Tidy (S6b) in the UI preview, in real headless Chrome: local only (CI runners have no
// desktop); the script passes a mock keychain. ?landscapeArrangeAudit (src/preview/stub.ts) drags headers, edges and
// tabs, picks and stacks with ⌘G and tidies with T as a person would, and reports what each step left.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type R = { x: number; y: number; w: number; h: number };
type Box = { size: string | null; label: string | null } | null;

async function run<T>(part: string): Promise<T> {
  const id = `mb-landscape-arrange-audit-${part}`;
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({
    size: "1400x900",
    query: `labs=landscape&motion=off&lsCamera=0,0,0.5&landscapeArrangeAudit=${part}`,
    outDir: path.join(tempDir(id), "out"),
    read: `document.getElementById(${JSON.stringify(id)})?.textContent ?? null`,
  });
  if (!json) throw new Error(`the preview didn't finish ${id}`);
  return JSON.parse(json);
}

describe.skipIf(!local)("arranging the landscape by hand (UI preview)", () => {
  it("moves by the header and resizes by an edge, snapped with guides; a locked area refuses both, saying why", async () => {
    const a = await run<{
      move: { during: { guides: string[]; box: Box }; guidesAfter: number; updates: number; s8: R; apiX: number };
      resize: { during: { box: Box; resized: number; guides: string[] }; boxAfter: Box; updates: number; before: R; after: R };
      locked: { updates: number; moveSaid: string | null; resizeSaid: string | null };
      error?: string;
    }>("a");
    expect(a.error).toBeUndefined();
    // dropped 2 px off the api stack's left edge: a guide along it while dragging, and the place snapped to it
    expect(a.move.during.guides).toContain("x");
    expect(a.move.during.box).toBeNull();
    expect(a.move).toMatchObject({ guidesAfter: 0, updates: 1 });
    expect(a.move.s8.x).toBe(a.move.apiX);
    expect(a.move.s8.y % 8).toBe(0);
    // its right edge: the size box says the terminal it would hold while dragging, the pty untouched until the drop
    expect(a.resize.during.box?.label).toMatch(/^\d+ × \d+$/);
    expect(a.resize.during.resized).toBe(0);
    expect(a.resize.boxAfter).toBeNull();
    expect(a.resize.updates).toBe(1);
    expect(a.resize.after).toEqual({ ...a.resize.before, w: a.resize.before.w + 120 });
    expect(a.resize.during.box?.size).toBe(`${a.resize.after.w}x${a.resize.after.h}`);
    // 5102 locked: nothing saved, and the note says why
    expect(a.locked.updates).toBe(0);
    expect(a.locked.moveSaid).toMatch(/is locked: unlock it to move its workspaces/);
    expect(a.locked.resizeSaid).toMatch(/is locked: unlock it to resize its workspaces/);
  }, 120_000);

  it("stacks with ⌘G, switches by tab, unstacks a tab dragged out, and tidies with T, Undo putting it back", async () => {
    const b = await run<{
      picked: string[];
      stacked: { groups: unknown[][]; tabs: string[]; front: string | null; stored: { active: string; placement: R } | null; s4: R | null; s8: R | null };
      switched: { to: string; front: string | null; stored: string | null };
      unstacked: { during: { box: Box }; groups: unknown[][]; stack: boolean; stored: unknown; s8: boolean; s4: boolean; placed: Record<string, R | null>; api: R | null };
      tidy: { said: string | null; tidied: boolean; updates: number; undo: boolean; back: boolean };
      error?: string;
    }>("b");
    expect(b.error).toBeUndefined();
    expect(b.picked).toEqual(["s4", "s8"]);
    // one stack in 5101's own sub-group, where s4 was, s4 in front; their own places let go
    expect(b.stacked.groups).toEqual([
      ["s4", "5101/tabs"],
      ["s8", "5101/tabs"],
    ]);
    expect(b.stacked).toMatchObject({ tabs: ["s4", "s8"], front: "s4", stored: { active: "s4" }, s4: null, s8: null });
    // its other tab brings s8 to the front, and it's kept
    expect(b.switched).toEqual({ to: "s8", front: "s8", stored: "s8" });
    // s8's tab dragged out: the box shows where it would land; s8 is 5101's own again, the stack of one let go with s4
    // taking its place; what s8 landed on pushed aside, nothing overlapping
    expect(b.unstacked.during.box?.label).toBe("Release notes for #5101");
    expect(b.unstacked).toMatchObject({ groups: [["s8", "5101"], ["s4", "5101"]], stack: false, stored: null, s8: true, s4: true });
    const rects = [...Object.values(b.unstacked.placed), b.unstacked.api].filter((r): r is R => !!r);
    expect(rects).toHaveLength(4);
    for (const r of rects) for (const o of rects) if (r !== o) expect(overlaps(r, o)).toBe(false);
    // T tidies the selected area and says so with Undo, which puts every place back
    expect(b.tidy).toMatchObject({ tidied: true, updates: 2, undo: true, back: true });
    expect(b.tidy.said).toMatch(/^Tidied #5101 .* in the order its workspaces were made/);
  }, 120_000);
});
