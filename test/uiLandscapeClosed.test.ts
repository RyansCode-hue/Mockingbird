import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The Closed sessions list and the S6b review's gesture and look fixes, in the UI preview, in real headless Chrome:
// local only (CI runners have no desktop); the script passes a mock keychain. ?landscapeClosedAudit and
// ?landscapeFixAudit (src/preview/stub.ts) work them as a person would and report what each step left.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type R = { x: number; y: number; w: number; h: number };

async function run<T>(audit: string, part: string, extra = "", size = "1400x900"): Promise<T> {
  const id = `mb-landscape-${audit}-audit-${part}`;
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const param = audit === "closed" ? "landscapeClosedAudit" : "landscapeFixAudit";
  const json: string | null = await pageResult({
    size,
    query: `labs=landscape&motion=off&${param}=${part}${extra}`,
    outDir: path.join(tempDir(id), "out"),
    read: `document.getElementById(${JSON.stringify(id)})?.textContent ?? null`,
  });
  if (!json) throw new Error(`the preview didn't finish ${id}`);
  return JSON.parse(json);
}

describe.skipIf(!local)("the Closed sessions list (UI preview)", () => {
  it("lists closed sessions with no ghost; reopens into their area or loose, once per press; forgets; follows the take-over rule", async () => {
    const a = await run<{
      rows: string[];
      head: string | null;
      subs: Record<string, string | null>;
      looseRow: boolean;
      relaunchTaken: unknown;
      acts: Record<string, { act: string; disabled: boolean }[]>;
      allBefore: { disabled: boolean | null; title: string | null };
      palette: string[];
      o1: { relaunch: unknown[][]; setGroup: unknown[][]; inArea: boolean; listed: string[] };
      o2: { relaunch: unknown[][]; setGroup: unknown[][]; placed: boolean; inArea: boolean; area5150: boolean; listed: string[] };
      allAfter: { disabled: boolean | null; title: string | null };
      forgot: { kill: unknown[][]; list: boolean };
      error?: string;
    }>("closed", "list", "&lsClosed=y1,s7&lsUnplaced=y1");
    expect(a.error).toBeUndefined();
    // the closed sessions with no place: o1 and o2 left in Previous, y1 closed off the landscape; the ghosts aren't listed
    expect(a.rows).toEqual(["o1", "o2", "y1"]);
    expect(a.head).toBe("Closed sessions (3)");
    expect(a.subs).toEqual({ o1: "Closed · #5102", o2: "Closed", y1: "Continued by Nick Smith on their laptop · 5110-donor-entities" });
    // y1, which Nick continues, is taken back, never reopened: as its ghost would be
    expect(a.acts.o1).toEqual([
      { act: "reopen", disabled: false },
      { act: "forget", disabled: false },
    ]);
    expect(a.acts.y1.map((x) => x.act)).toEqual(["takeback", "forget"]);
    // and the preview refuses relaunching it, as main does
    expect(a.relaunchTaken).toEqual({ error: expect.stringMatching(/continues on Nick Smith's laptop — take it back rather than running this copy again/) });
    // s7 a loose ghost with no running workspace loose: the tree still has the Loose row (its menu holds their rows)
    expect(a.looseRow).toBe(true);
    expect(a.allBefore).toMatchObject({ disabled: false });
    // ⌘K: the list's Reopen all, and each one it can reopen
    expect(a.palette).toEqual(expect.arrayContaining(["Reopen all (2) — the Closed sessions list", "Forget all (3)… — the Closed sessions list", "Reopen Tag list notes — closed session", "Reopen Export spike — closed session"]));
    expect(a.palette.some((t) => t.includes("Reopen Release"))).toBe(false);
    // pressed twice: one relaunch, placed in its area as a new workspace
    expect(a.o1).toEqual({ relaunch: [["o1"]], setGroup: [], inArea: true, listed: ["o2", "y1"] });
    // its area gone: its group let go first, placed loose, and no area made for it
    expect(a.o2).toEqual({ relaunch: [["o2"]], setGroup: [["o2", null]], placed: true, inArea: false, area5150: false, listed: ["y1"] });
    // only y1 left: Reopen all off, saying why
    expect(a.allAfter.disabled).toBe(true);
    expect(a.allAfter.title).toMatch(/^None of these can be reopened here/);
    expect(a.forgot).toEqual({ kill: [["y1", true]], list: false });
  }, 120_000);

  it("shows every closed session while the landscape has no layout yet, each one reopenable", async () => {
    const a = await run<{ rows: string[]; landscapeShown: boolean; reopened: { relaunch: unknown[][]; setGroup: unknown[][]; listed: string[] }; error?: string }>("closed", "hold", "&lsHold");
    expect(a.error).toBeUndefined();
    expect(a.landscapeShown).toBe(false);
    expect(a.rows).toEqual(["p1", "g1", "g2", "o1", "o2"]);
    expect(a.reopened).toEqual({ relaunch: [["g1"]], setGroup: [], listed: ["p1", "g2", "o1", "o2"] });
  }, 120_000);
});

describe.skipIf(!local)("the S6b review's gesture and look fixes (UI preview)", () => {
  it("orders the toolbar Tidy first; ⌘Z undoes a toolbar Tidy, but not over a later drag or lock; guides stand out; the note keeps clear", async () => {
    const a = await run<{
      toolbar: string[];
      undoKey: { tidied: boolean; focusOnButton: boolean; back: boolean };
      afterDrag: { said: string | null; unchanged: boolean };
      afterLock: { said: string | null; unchanged: boolean };
      guide: { colour: string; focus: string; border: string; past: { top: number; bottom: number }; width: number } | null;
      error?: string;
    }>("fix", "a", "&lsCamera=0,0,0.5");
    expect(a.error).toBeUndefined();
    expect(a.toolbar).toEqual(["tidy", "collapse", "lock"]);
    // the keyboard stays on the toolbar's button; ⌘Z there undoes the Tidy
    expect(a.undoKey).toEqual({ tidied: true, focusOnButton: true, back: true });
    // a drag or a lock since: Undo would lay the old places over the new, so it says it can't
    expect(a.afterDrag).toEqual({ said: expect.stringMatching(/^Can't undo tidying .*: the landscape has changed since/), unchanged: true });
    expect(a.afterLock).toEqual({ said: expect.stringMatching(/^Can't undo tidying .*: the landscape has changed since/), unchanged: true });
    // a guide in a colour of its own (not the focus outline's, nor a card's border), reaching past both workspaces
    expect(a.guide).not.toBeNull();
    expect(a.guide!.colour).not.toBe(a.guide!.focus);
    expect(a.guide!.colour).not.toBe(a.guide!.border);
    expect(a.guide!.colour).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(a.guide!.past.top).toBeGreaterThanOrEqual(12);
    expect(a.guide!.past.bottom).toBeGreaterThanOrEqual(12);
  }, 120_000);

  it("keeps the note clear of a low selection bar and of the minimap, at 1024 px with the area tree open", async () => {
    const n = await run<{ note: { said: string | null; note: R | null; bar: R | null; minimap: R | null; overBar: boolean; overMinimap: boolean; viewport: R }; error?: string }>("fix", "n", "", "1024x760");
    expect(n.error).toBeUndefined();
    expect(n.note.said).toMatch(/Pick two or more workspaces to stack them/);
    expect(n.note.bar).not.toBeNull();
    expect(n.note.minimap).not.toBeNull();
    expect(n.note).toMatchObject({ overBar: false, overMinimap: false });
  }, 120_000);

  it("brings a slipped tab to the front; a tab dragged off is put back by Undo; Esc cancels a move, a resize and a tab drag; ghosts read whole", async () => {
    const b = await run<{
      tabsBefore: string[];
      slip: { setGroup: unknown[][]; tabs: string[]; front: string; other: string };
      dragOut: { said: string | null; groups: unknown[][]; undo: boolean; back: unknown[][]; tabs: string[]; s3: R | null };
      esc: Record<"move" | "resize" | "tab", { updates: number; same?: boolean; resized?: number; setGroup?: unknown[][]; guides: number; box: boolean; dragging: number }>;
      ghosts: { status: Record<string, { text: string; whole: boolean }[]>; sizes: Record<string, number> };
      layers: { zoom: number; shadow: string };
      chip: { chip: string | null; tabs: string | null };
      error?: string;
    }>("fix", "b", "&lsCamera=0,0,0.5");
    expect(b.error).toBeUndefined();
    // a stack's layers zoomed out to 40%: every one at least 3 px out on screen
    const offsets = [...b.layers.shadow.matchAll(/(-?[\d.]+)px (-?[\d.]+)px 0px/g)].map((m) => Number(m[1])).filter((x) => x > 0);
    expect(offsets.length).toBeGreaterThan(0);
    expect(Math.min(...offsets) * b.layers.zoom).toBeGreaterThanOrEqual(2.9);
    // zoomed out to cards, its card has a stack · N chip and its tabs' names, as the boards do
    expect(b.chip.chip).toMatch(/^stack · \d+$/);
    expect(b.chip.tabs).toContain("API tests");
    // a press that slips 6 px is a click: the tab comes to the front and stays in its stack
    expect(b.slip.setGroup).toEqual([]);
    expect(b.tabsBefore.slice(0, 2)).toEqual(["s2", "s3"]);
    expect(b.slip.tabs).toEqual(b.tabsBefore);
    expect(b.slip.front).toBe(b.slip.other);
    // pulled off the header: taken out, and the note's Undo puts it back in the stack, its own place let go
    expect(b.dragOut.groups).toEqual([["s3", "5101"]]);
    expect(b.dragOut.said).toMatch(/Undo$/);
    expect(b.dragOut).toMatchObject({ undo: true, back: [["s3", "5101/api"]], tabs: b.tabsBefore, s3: null });
    // Esc mid-gesture: nothing saved or moved, and nothing of the gesture left drawn
    const clear = { guides: 0, box: false, dragging: 0 };
    expect(b.esc.move).toEqual({ updates: 0, same: true, ...clear });
    expect(b.esc.resize).toEqual({ updates: 0, same: true, resized: 0, ...clear });
    expect(b.esc.tab).toEqual({ updates: 0, setGroup: [], ...clear });
    // zoomed out to cards, a ghost's status keeps its room before its ticket · branch
    for (const [z, list] of Object.entries(b.ghosts.status)) for (const g of list) expect([z, g.text, g.whole]).toEqual([z, g.text, true]);
    // its type is 11 px on screen from 100% down through the read-only band, the same either side of 75%
    for (const [z, px] of Object.entries(b.ghosts.sizes)) expect([z, Math.abs(px - 11) < 0.3]).toEqual([z, true]);
  }, 120_000);
});
