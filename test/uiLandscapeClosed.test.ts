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
  it("lists closed sessions with no ghost; reopens into their area, formed again if it's gone, once per press, never changing the group; forgets; follows the take-over rule", async () => {
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
      o2fail: { relaunch: unknown[][]; setGroup: unknown[][]; group: string | null; said: string | null; listed: string[] };
      o2throw: { relaunch: unknown[][]; group: string | null; said: string | null; enabled: boolean };
      o2: { relaunch: unknown[][]; setGroup: unknown[][]; group: string | null; inItsArea: boolean; listed: string[] };
      allAfter: { disabled: boolean | null; title: string | null };
      forgot: { kill: unknown[][]; list: boolean };
      error?: string;
    }>("closed", "list", "&lsClosed=y1,s7&lsUnplaced=y1&lsRelaunchFails=o2");
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
    // its area gone, and its relaunch failing: said, its group unchanged, still listed
    expect(a.o2fail).toEqual({ relaunch: [["o2"]], setGroup: [], group: "5150", said: expect.stringMatching(/^Couldn't reopen Export spike: Its terminal couldn't start/), listed: ["o2", "y1"] });
    // the call itself breaking: said, logged, and its Reopen on again
    expect(a.o2throw).toEqual({ relaunch: [["o2"]], group: "5150", said: expect.stringMatching(/^Couldn't finish reopening Export spike: the relaunch call broke off/), enabled: true });
    // reopened: placed in 5150's area, formed around it again as for any running session; its group never changed
    expect(a.o2).toEqual({ relaunch: [["o2"]], setGroup: [], group: "5150", inItsArea: true, listed: ["y1"] });
    // only y1 left: Reopen all off, saying why
    expect(a.allAfter.disabled).toBe(true);
    expect(a.allAfter.title).toMatch(/^None of these can be reopened here/);
    expect(a.forgot).toEqual({ kill: [["y1", true]], list: false });
  }, 120_000);

  it("says a failed read of the closed sessions and tries it again until they're read", async () => {
    const a = await run<{ early: { rows: number; error: string | null; reads: number }; later: { rows: string[]; error: string | null; reads: number }; error?: string }>("closed", "retry", "&lsClosedReadFails=2");
    expect(a.error).toBeUndefined();
    expect(a.early).toMatchObject({ rows: 0, error: expect.stringMatching(/Couldn't read the previous sessions: sessions\.json couldn't be read/) });
    // tried again (after 1 s, then 2): read on the third try, the list there and the error gone
    expect(a.later.rows).toEqual(["o1", "o2"]);
    expect(a.later.error).toBeNull();
    expect(a.later.reads).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it("keeps a long list's header on one line, rings each row as a ghost, titles it with its status, and offers Forget all from a ⋯ headed as the list", async () => {
    const a = await run<{
      rows: string[];
      head: { text: string | null; height: number; wrap: string | null; ellipsis: string | null; countShown: boolean };
      ring: { cls: string; border: string; fill: string } | null;
      titles: { y1: string | null; o1: string | null };
      more: string[];
      rowMenu: string[];
      asked: string[];
      error?: string;
    }>("closed", "many", "&lsClosed=y1,s7&lsUnplaced=y1&lsManyClosed=12");
    expect(a.error).toBeUndefined();
    expect(a.rows.length).toBe(15);
    // a two-digit count: one line, the words cut with an ellipsis if they must be, the count always shown
    expect(a.head).toMatchObject({ text: "Closed sessions (15)", wrap: "nowrap", ellipsis: "ellipsis", countShown: true });
    expect(a.head.height).toBeLessThan(20);
    // closed reads as the ghost's hollow ring, not the red dot of an exited workspace
    expect(a.ring).toEqual({ cls: "lg-dot", border: "solid", fill: "rgba(0, 0, 0, 0)" });
    // its status in full on hover, as Take it back leaves the line little room
    expect(a.titles.y1).toContain("Continued by Nick Smith on their laptop");
    expect(a.titles.o1).toContain("Closed · #5102");
    // the header's ⋯: the list's Reopen all and Forget all, headed as the list, never "Ghosts"
    expect(a.more[0]).toBe("Closed sessions");
    expect(a.more).toEqual(expect.arrayContaining([expect.stringMatching(/^Reopen all \(\d+\)$/), "Forget all (15)…"]));
    expect([...a.more, ...a.rowMenu]).not.toContain("Ghosts");
    expect(a.rowMenu).toEqual(expect.arrayContaining(["Reopen", "Forget it"]));
    // Forget all asks in a plain sentence that agrees in number
    expect(a.asked).toEqual(["Forget all 15 closed sessions? They can't be reopened after."]);
  }, 120_000);

  it("shows every closed session while the landscape has no layout yet, each one reopenable; Reopen all asks once about what it costs", async () => {
    const a = await run<{
      rows: string[];
      landscapeShown: boolean;
      reopened: { relaunch: unknown[][]; setGroup: unknown[][]; listed: string[] };
      reopenAll: { dialogs: number; title: string | null; note: string | null; relaunchedMeanwhile: number; dialogsAfter: number; relaunch: unknown[]; said: string[] };
      error?: string;
    }>("closed", "hold", "&lsHold&lsBigResume=o1,o2");
    expect(a.error).toBeUndefined();
    expect(a.landscapeShown).toBe(false);
    expect(a.rows).toEqual(["p1", "g1", "g2", "o1", "o2"]);
    expect(a.reopened).toEqual({ relaunch: [["g1"]], setGroup: [], listed: ["p1", "g2", "o1", "o2"] });
    // the three it can reopen (g2's folder is gone), two of them big to resume: one question, nothing started until Continue
    expect(a.reopenAll).toEqual({
      dialogs: 1,
      title: "Reopen 3 sessions?",
      note: "Big to resume: Tag list notes, Export spike",
      relaunchedMeanwhile: 0,
      dialogsAfter: 0,
      relaunch: ["p1", "o1", "o2"],
      said: [expect.stringMatching(/^Reopened 3 of 4 · 1 left closed/)],
    });
  }, 120_000);
});

describe.skipIf(!local)("the S6b review's gesture and look fixes (UI preview)", () => {
  it("orders the toolbar Tidy first; ⌘Z undoes a toolbar Tidy, but not over a later drag or lock; guides stand out; the note keeps clear", async () => {
    const a = await run<{
      toolbar: string[];
      undoKey: { tidied: boolean; focusOnButton: boolean; editorKept: boolean; back: boolean };
      afterDrag: { said: string | null; unchanged: boolean };
      afterLock: { said: string | null; unchanged: boolean };
      afterRace: { raced: boolean; said: string | null; unchanged: boolean };
      guide: { colour: string; focus: string; border: string; past: { top: number; bottom: number }; width: number } | null;
      error?: string;
    }>("fix", "a", "&lsCamera=0,0,0.5");
    expect(a.error).toBeUndefined();
    expect(a.toolbar).toEqual(["tidy", "collapse", "lock"]);
    // the keyboard stays on the toolbar's button; ⌘Z there undoes the Tidy, but not in the code editor (its own undo)
    expect(a.undoKey).toEqual({ tidied: true, focusOnButton: true, editorKept: true, back: true });
    // a drag or a lock since: Undo would lay the old places over the new, so it says it can't
    expect(a.afterDrag).toEqual({ said: expect.stringMatching(/^Can't undo tidying .*: the landscape has changed since/), unchanged: true });
    expect(a.afterLock).toEqual({ said: expect.stringMatching(/^Can't undo tidying .*: the landscape has changed since/), unchanged: true });
    // another window's change told before the Tidy's save answered: Undo goes by the revision that save made
    expect(a.afterRace).toEqual({ raced: true, said: expect.stringMatching(/^Can't undo tidying .*: the landscape has changed since/), unchanged: true });
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
    // the bar really is low: its foot in the band a note 58 px up from the view's foot takes
    const bar = n.note.bar!;
    expect(bar.y + bar.h).toBeGreaterThan(n.note.viewport.y + n.note.viewport.h - 58 - 30);
    expect(n.note).toMatchObject({ overBar: false, overMinimap: false });
    // and the bar itself keeps clear of the minimap
    const mm = n.note.minimap!;
    expect(bar.x + bar.w <= mm.x || mm.x + mm.w <= bar.x || bar.y + bar.h <= mm.y || mm.y + mm.h <= bar.y).toBe(true);
  }, 120_000);

  it("brings a slipped tab to the front; a tab dragged off is put back by Undo; Esc cancels a move, a resize and a tab drag; ghosts read whole", async () => {
    const b = await run<{
      tabsBefore: string[];
      slip: { setGroup: unknown[][]; tabs: string[]; half: { id: string; front: string | null }; full: { id: string; front: string | null } };
      dragOut: { peekAtDrop: boolean; peekMovedOn: boolean; said: string | null; groups: unknown[][]; undo: boolean; back: unknown[][]; tabs: string[]; s3: R | null };
      esc: Record<"move" | "resize" | "tab", { updates: number; same?: boolean; resized?: number; setGroup?: unknown[][]; guides: number; box: boolean; dragging: number }>;
      ghosts: { status: Record<string, { text: string; whole: boolean }[]>; sizes: Record<string, number> };
      layers: { zoom: number; shadow: string };
      chip: Record<"fit" | "at30", { zoom: number; chip: string | null; first: string | null; needs: string | null; names: string[]; title: string | null; seen: number }>;
      error?: string;
    }>("fix", "b", "&lsCamera=0,0,0.5");
    expect(b.error).toBeUndefined();
    // a stack's layers zoomed out to 40%: every one at least 3 px out on screen
    const offsets = [...b.layers.shadow.matchAll(/(-?[\d.]+)px (-?[\d.]+)px 0px/g)].map((m) => Number(m[1])).filter((x) => x > 0);
    expect(offsets.length).toBeGreaterThan(0);
    expect(Math.min(...offsets) * b.layers.zoom).toBeGreaterThanOrEqual(2.9);
    // zoomed out to cards, at Fit and at 30%: a stack · N chip in its title row, and its other tabs' names on a row of
    // their own (never the front one's, which is the title), the one waiting on you counted first, and readable on screen
    expect(b.chip.fit.zoom).toBeLessThan(0.25);
    for (const c of [b.chip.fit, b.chip.at30]) {
      expect(c.chip).toMatch(/^stack · \d+$/);
      expect(c.first).toBe("ls-card-needs");
      expect(c.needs).toBe("1 needs you");
      expect(c.names.length).toBeGreaterThan(0);
      expect(c.names).not.toContain(c.title);
      expect(c.seen).toBeGreaterThanOrEqual(40);
    }
    // a press that slips (6 px at 50%, 12 px down at 100%) is a click on the tab, wherever the browser's click lands: it
    // comes to the front and stays in its stack
    expect(b.slip.setGroup).toEqual([]);
    expect(b.tabsBefore.slice(0, 2)).toEqual(["s2", "s3"]);
    expect(b.slip.tabs).toEqual(b.tabsBefore);
    expect(b.slip.half.front).toBe(b.slip.half.id);
    expect(b.slip.full.front).toBe(b.slip.full.id);
    expect(b.slip.full.id).not.toBe(b.slip.half.id);
    // pulled off the header: taken out, and the note's Undo puts it back in the stack, its own place let go
    expect(b.dragOut.groups).toEqual([["s3", "5101"]]);
    expect(b.dragOut.said).toMatch(/Undo$/);
    // no peek over what the drop left under the resting pointer; once it moves on, a peek opens as ever
    expect(b.dragOut).toMatchObject({ peekAtDrop: false, peekMovedOn: true });
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
