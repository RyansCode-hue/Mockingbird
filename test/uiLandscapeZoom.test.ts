import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The landscape's semantic zoom and hover peek (S3) in the UI preview, in real headless Chrome: local only (CI
// runners have no desktop); the script passes a mock keychain. The audits (src/preview/stub.ts) work the landscape
// as a person would and report once each step has settled; animations are read where they end, never mid-way.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

async function page<T>(query: string, id: string, name: string): Promise<T> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({ size: "1400x900", query, outDir: path.join(tempDir(name), "out"), read: `document.getElementById(${JSON.stringify(id)})?.textContent ?? null` });
  if (!json) throw new Error(`the preview didn't answer (${query})`);
  return JSON.parse(json);
}

interface Where {
  zoom: number;
  attached: string[];
  panes: number;
  cards: number;
  visible: string[];
  near: string[];
  selected: string | null;
  webgl: number | null;
  /** WebGL contexts made and not lost: what Chromium counts against its limit, whether a terminal still draws with it or not. */
  glAlive: number | null;
  canvases: number;
}
interface ZoomAudit {
  fit: Where;
  readonly: Where;
  live: Where;
  panned: Where;
  fitAgain: Where;
  scrollback: { id: string; atBefore: string | null; detached: boolean; same: boolean; attachedTo: string | null; inHolder: boolean; kept: boolean; added: boolean };
  crossed: string[];
  readonlyKeys: { selected: boolean; clickKeyboard: string; typedIn: boolean; wrote: string[]; keyboard: string };
  zoomedDown: { liveWrote: string[]; keyboard: string };
  said: string[];
  resizedAtAll: string[];
  cellAtFit: { w: number; h: number } | null;
  cellMeasured: { w: number; h: number } | null;
  pinchOut: { from: number; most: number; made: number; end: Where };
  ptySizes: string[];
  error?: string;
}
// one run of each audit, read by the tests below that check its parts
const zoomAudits = new Map<string, Promise<ZoomAudit>>();
const zoomAudit = (extra = "") => {
  if (!zoomAudits.has(extra)) zoomAudits.set(extra, page<ZoomAudit>(`labs=landscape&landscapeMany=30&landscapeZoomAudit${extra}`, "mb-landscape-zoom-audit", `ls-zoom${extra.replace(/\W/g, "-")}`));
  return zoomAudits.get(extra)!;
};

/** Terminals attached to exactly the workspaces on screen: every one in view, none past the margin, but the selected one. */
function onlyOnScreen(w: Where, label: string) {
  for (const k of w.visible) expect(w.attached, `${label}: ${k} is in view`).toContain(k);
  for (const k of w.attached) expect([...w.near, w.selected], `${label}: ${k} is attached`).toContain(k);
  expect(w.panes, label).toBe(w.attached.length);
}

describe.skipIf(!local)("the landscape's semantic zoom", () => {
  it("with 30 workspaces attaches no xterm at fit and only those on screen at 60% and 100%, resizing no pty across bands", async () => {
    const a = await zoomAudit();
    expect(a.error).toBeUndefined();
    // fit: every workspace a card, no terminal pane mounted
    expect(a.fit.zoom).toBeLessThan(0.35);
    expect([a.fit.attached, a.fit.panes, a.fit.cards]).toEqual([[], 0, 30]);
    expect([a.fitAgain.attached, a.fitAgain.panes, a.fitAgain.cards]).toEqual([[], 0, 30]);
    // read-only at 60%, live at 100% and after a pan there: the workspaces on screen, with a margin, and far fewer than 30
    expect([a.readonly.zoom, a.live.zoom, a.panned.zoom]).toEqual([0.6, 1, 1]);
    for (const [label, w] of [["60%", a.readonly], ["100%", a.live], ["panned", a.panned]] as const) {
      onlyOnScreen(w, label);
      expect(w.attached.length, label).toBeLessThan(12);
      expect(w.cards, label).toBe(0);
    }
    expect(a.panned.attached).not.toEqual(a.live.attached);
    // fit → 60% → 100% → a pan → fit → 100% → 60% → 100% → 60% → 100% → 25%: no pty resized
    expect(a.crossed).toEqual([]);
    expect(a.resizedAtAll).toEqual([]);
  }, 120_000);

  it("sizes a card's pty by the cell its terminal measures once attached, so each pty is told one size from the start", async () => {
    const a = await zoomAudit();
    expect(a.error).toBeUndefined();
    // measured before anything was attached, and what an attached terminal measures
    expect(a.cellAtFit).not.toBeNull();
    expect(a.cellAtFit).toEqual(a.cellMeasured);
    const ids = a.ptySizes.map((r) => r.split(" ")[0]);
    expect(new Set(ids).size, a.ptySizes.join(", ")).toBe(ids.length);
    expect(ids.length).toBe(30);
  }, 120_000);

  it("attaches nothing a pinch out from 100% to 25% passes, and makes no WebGL context on the way", async () => {
    const { pinchOut: p, error } = await zoomAudit();
    expect(error).toBeUndefined();
    expect(p.from).toBeGreaterThan(0);
    // what was attached at 100%, at most, until the cards band lets them go
    expect(p.most).toBeLessThanOrEqual(p.from);
    expect(p.made).toBe(0);
    expect([p.end.zoom, p.end.attached, p.end.webgl, p.end.glAlive]).toEqual([0.25, [], 0, 0]);
  }, 120_000);

  it("detaches a terminal at fit and attaches it again with its scrollback, and what it wrote meanwhile", async () => {
    const { scrollback: s, error } = await zoomAudit();
    expect(error).toBeUndefined();
    expect(s).toEqual({ id: s.id, atBefore: s.id, detached: true, same: true, attachedTo: s.id, inHolder: true, kept: true, added: true });
  }, 120_000);

  it("in the read-only band, a click selects and keeps the keyboard, and keys never reach a terminal", async () => {
    const a = await zoomAudit();
    expect(a.error).toBeUndefined();
    expect(a.readonlyKeys).toEqual({ selected: true, clickKeyboard: "landscape", typedIn: true, wrote: [], keyboard: "landscape" });
    // at 100% the same key reaches it; zoomed back down, the landscape takes the keyboard from it
    expect(a.zoomedDown).toEqual({ liveWrote: ["\r"], keyboard: "landscape" });
  }, 120_000);

  it("draws attached terminals with WebGL, and gives each context up as its terminal detaches", async () => {
    const a = await zoomAudit();
    expect(a.error).toBeUndefined();
    for (const w of [a.readonly, a.live, a.panned]) expect(w.webgl).toBe(w.attached.length);
    expect([a.fit.webgl, a.fitAgain.webgl]).toEqual([0, 0]);
    // a context given up is lost at once, not left for the garbage collector: Chromium counts only those drawing
    for (const w of [a.fit, a.readonly, a.live, a.panned, a.fitAgain]) expect(w.glAlive).toBe(w.webgl);
    expect(a.said).toEqual([]);
  }, 120_000);

  it("past the WebGL cap, draws with the DOM renderer, says so once per terminal, and resizes nothing", async () => {
    const a = await zoomAudit("&glMax=3");
    expect(a.error).toBeUndefined();
    expect(a.readonly.attached.length).toBeGreaterThan(3);
    for (const w of [a.readonly, a.live, a.panned]) expect(w.webgl).toBe(Math.min(3, w.attached.length));
    for (const w of [a.readonly, a.live, a.panned, a.fitAgain]) expect(w.glAlive).toBe(w.webgl);
    const capped = a.said.filter((m) => m.includes("3 terminals already draw with WebGL, the most at once"));
    expect(capped.length).toBeGreaterThan(0);
    expect(capped).toEqual(a.said);
    const ids = capped.map((m) => /terminal (\S+) draws with the DOM renderer/.exec(m)?.[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(a.crossed).toEqual([]);
  }, 120_000);

  it("when no WebGL context can be made, draws with the DOM renderer, says why with the session, and leaves nothing behind", async () => {
    const a = await zoomAudit("&glFail");
    expect(a.error).toBeUndefined();
    for (const w of [a.readonly, a.live, a.panned]) {
      expect(w.webgl).toBe(0);
      // the failed renderer's own canvas, taken out again
      expect(w.canvases).toBe(0);
      expect(w.attached.length).toBeGreaterThan(0);
    }
    const ids = a.said.map((m) => /^\[mockingbird\] terminal (\S+) draws with the DOM renderer: its WebGL context couldn't be made \(.+\)$/.exec(m)?.[1]);
    expect(ids.every(Boolean)).toBe(true);
    // once each, for every terminal attached
    expect(new Set(ids).size).toBe(ids.length);
    for (const k of [...a.readonly.attached, ...a.live.attached]) expect(ids).toContain(k);
    expect(a.crossed).toEqual([]);
  }, 120_000);

  it("copies a WebGL terminal's selection on release and with ⌘C, the agent's own wrapping undone", async () => {
    type Copy = { cols: number; mouse: string; renderer: string; rows: number[]; onSelect: string[]; copyEvent: string[] };
    const a = await page<{ copies: Record<string, Copy>; expected: { agent: string[]; shell: string[] }; error?: string }>("labs=landscape&copyAudit", "mb-copy-audit", "ls-copy");
    expect(a.error).toBeUndefined();
    const ids = Object.keys(a.copies);
    expect(ids).toEqual(["s1", expect.stringMatching(/^r~/), "s4"]);
    for (const id of ids) {
      const c = a.copies[id];
      expect(c.renderer, id).toBe("webgl");
      expect(c.mouse, id).toBe("none");
      // each text took more than one row: the agent (or the terminal) had to wrap it
      for (const rows of c.rows) expect(rows, id).toBeGreaterThan(1);
      const expected = id === "s4" ? a.expected.shell : a.expected.agent;
      expect(c.onSelect, id).toEqual(expected);
      expect(c.copyEvent, id).toEqual(expected);
    }
  }, 120_000);
});

interface PeekMotion {
  animations: number;
  opacity: string | null;
  transform: string | null;
  holding: number | null;
}
interface PeekAudit {
  cards: { early: boolean; delay: number; opened: string | null; termIn: boolean; stillCard: boolean; motion: PeekMotion };
  leave: { onPeek: boolean; stays: string | null; bare: boolean; overPeek: boolean; closed: boolean };
  across: { again: string | null; to: string | null; overPeek: boolean; firstClosed: boolean; notYet: boolean; opened: string | null };
  space: { pinned: boolean; keptOpen: string | null; keptOverIt: string | null; keptOffIt: string | null; spaceClosed: boolean; other: string | null; escClosed: boolean; backFromPeek: boolean; font: number | null };
  clickKeeps: { onPeek: boolean; pinned: boolean; focused: boolean; bare: boolean; kept: string | null; outside: boolean; closed: boolean };
  readonly: {
    inNode: boolean;
    size: string;
    lent: { opened: string | null; termIn: boolean; snapshot: boolean; font: number | null; size: string; motion: PeekMotion };
    back: { closed: boolean; inNode: boolean; same: boolean; size: string; font: number | null; kept: boolean };
  };
  resized: string[];
  dblclick: { focused: string | null; peek: boolean };
  enter: { peer: string | null; pinned: boolean; selected: string | null; focused: string | null; peek: boolean };
  panning: { whileSpace: boolean };
  jump: { wid: string; selected: string | null; pinned: boolean; lent: boolean; afterJump: string; afterFocus: string; tabIndex: number; wrote: string[] };
  jumpEnter: { focused: string | null; wrote: string[] };
  overlay: { dialog: boolean; closed: boolean; peek: string | null; pinned: boolean };
  front: { ws: string; opened: string | null; front: string | null; peek: boolean; strays: number; oldIn: boolean };
  kept: { peek: string | null; mode: string | null; snap: boolean };
  scroll: { pinned: boolean; from: number; to: number; moved: boolean; wrote: string[] };
  error?: string;
}

const peekAudits = new Map<string, Promise<PeekAudit>>();
const peekAudit = (motion: "full" | "reduce") => {
  if (!peekAudits.has(motion)) peekAudits.set(motion, page<PeekAudit>(`labs=landscape&motion=${motion}&landscapePeekAudit`, "mb-landscape-peek-audit", `ls-peek-${motion}`));
  return peekAudits.get(motion)!;
};

describe.skipIf(!local)("the hover peek", () => {
  for (const motion of ["full", "reduce"] as const) {
    it(`opens on a card or a read-only workspace after a rest, lends it its terminal and hands it back, kept open by Space: motion ${motion}`, async () => {
      const a = await peekAudit(motion);
      expect(a.error).toBeUndefined();
      // not at once: after the pointer has rested PEEK_HOVER_MS (600 ms); the terminal goes into it, and the workspace stays a card
      expect(a.cards).toMatchObject({ early: false, opened: "s1", termIn: true, stillCard: true });
      expect(a.cards.delay).toBeGreaterThanOrEqual(600);
      expect(a.cards.delay).toBeLessThan(900);
      // it lands fully shown with nothing held; under reduce it appears at once, with no animation at all
      const landed = { opacity: "1", transform: "none", holding: 0 };
      for (const m of [a.cards.motion, a.readonly.lent.motion]) expect(m).toEqual({ animations: motion === "full" ? 1 : 0, ...landed });
      // Space keeps it open over another card, the bare landscape under it and off it; Space again and Esc close it,
      // and the terminal leaves it with its own font back
      expect(a.space).toEqual({ pinned: true, keptOpen: "s1", keptOverIt: "s1", keptOffIt: "s1", spaceClosed: true, other: "s5", escClosed: true, backFromPeek: true, font: 12.5 });
      // read-only at 50%: the terminal leaves its workspace for the peek, scaled by its font at its own size, and the
      // workspace shows its screen as text meanwhile; moving away hands it back, the same terminal, its history whole
      const r = a.readonly;
      expect(r.inNode).toBe(true);
      expect(r.lent).toMatchObject({ opened: "s1", termIn: true, snapshot: true, size: r.size });
      expect(r.lent.font!).toBeLessThan(12.5);
      expect(r.back).toEqual({ closed: true, inNode: true, same: true, size: r.size, font: 12.5, kept: true });
      // no peek resized a pty
      expect(a.resized).toEqual([]);
      // it never opens while Space is held to pan
      expect(a.panning).toEqual({ whileSpace: false });
    }, 120_000);
  }

  it("closes as the pointer leaves its workspace, though the peek covers it: hovering the peek holds nothing open", async () => {
    const a = await peekAudit("reduce");
    expect(a.error).toBeUndefined();
    // over the peek where it covers its card it stays; off the card, on the peek over the bare landscape, it closes
    expect(a.leave).toEqual({ onPeek: true, stays: "s1", bare: true, overPeek: true, closed: true });
    // from its card straight onto another under the peek: it closes at once, and the other's opens after its own rest
    expect(a.across.to).toBeTruthy();
    expect(a.across).toEqual({ again: "s1", to: a.across.to, overPeek: true, firstClosed: true, notYet: true, opened: a.across.to });
  }, 120_000);

  it("is kept open by a click on it as by Space, focuses on a double-click or Enter, and a kept-open one scrolls", async () => {
    const a = await peekAudit("reduce");
    // a click keeps it open (focusing nothing): leaving its card no longer closes it, and a press off it does
    expect(a.clickKeeps).toEqual({ onPeek: true, pinned: true, focused: false, bare: true, kept: "s1", outside: true, closed: true });
    // a double-click on it focuses its workspace
    expect(a.dblclick).toEqual({ focused: "s1", peek: false });
    // Enter on a kept-open one focuses its workspace, not the one selected
    expect(a.enter.peer).toBeTruthy();
    expect(a.enter).toEqual({ peer: a.enter.peer, pinned: true, selected: "s1", focused: a.enter.peer, peek: false });
    // its wheel scrolls the terminal's history up, moving neither the landscape nor writing to the session
    expect(a.error).toBeUndefined();
    expect(a.scroll.pinned).toBe(true);
    expect(a.scroll.to).toBeLessThan(a.scroll.from);
    expect(a.scroll).toMatchObject({ moved: false, wrote: [] });
  }, 120_000);

  it("never gives its terminal the keyboard: a jump to the session (⌥⇥) leaves it with the landscape, and nothing typed reaches the session", async () => {
    const a = await peekAudit("reduce");
    expect(a.error).toBeUndefined();
    const { wid } = a.jump;
    expect(wid).toBeTruthy();
    // the jump selects it, and the peek stays open with its terminal; focusing the terminal itself lands on the landscape too
    expect(a.jump).toEqual({ wid, selected: wid, pinned: true, lent: true, afterJump: "landscape", afterFocus: "landscape", tabIndex: -1, wrote: [] });
    // Enter aimed at its terminal is the kept-open peek's: it focuses the workspace, and is never typed
    expect(a.jumpEnter).toEqual({ focused: a.front.ws, wrote: [] });
    // a dialog opened over it has Space and Esc first
    expect(a.overlay).toEqual({ dialog: true, closed: true, peek: a.front.ws, pinned: true });
    // its stack bringing another tab to the front ends it, with no terminal left in it
    expect(a.front).toMatchObject({ opened: a.front.ws, peek: false, strays: 0, oldIn: false });
    expect(a.front.front).not.toBe(wid);
    // kept open from a card into the read-only band, its workspace shows the screen rather than nothing
    expect(a.kept).toEqual({ peek: "s1", mode: "snapshot", snap: true });
  }, 120_000);
});

describe.skipIf(!local)("a teammate's workspace on the landscape", () => {
  it("keeps its terminal at its owner's size as a card, peeked and attached, following each resize, and resizes no pty of theirs", async () => {
    type Remote = {
      atFit: { sizes: Record<string, string>; owners: Record<string, string>; attached: boolean };
      card: { size: string; attached: boolean; endAt: number };
      peek: { opened: string | null; inPeek: boolean; size: string; fits: boolean };
      live: { inNode: boolean; size: string; followed: string };
      away: { attached: boolean; size: string };
      resized: string[];
      error?: string;
    };
    const a = await page<Remote>("labs=landscape&landscapeRemoteAudit", "mb-landscape-remote-audit", "ls-remote");
    expect(a.error).toBeUndefined();
    // made by its card, never attached: at its owner's size from the first byte
    expect(Object.keys(a.atFit.sizes).length).toBeGreaterThan(0);
    for (const [id, size] of Object.entries(a.atFit.sizes)) expect(size, id).toBe(a.atFit.owners[id]);
    expect(a.atFit.attached).toBe(false);
    // the owner narrows their window while it's a card: it follows, and their column 90 is column 90 here
    expect(a.card).toEqual({ size: "96×28", attached: false, endAt: 89 });
    const nick = a.peek.opened!;
    expect(a.peek).toEqual({ opened: nick, inPeek: true, size: "104×30", fits: true });
    expect(a.live).toEqual({ inNode: true, size: "104×30", followed: "100×30" });
    expect(a.away).toEqual({ attached: false, size: "90×26" });
    expect(a.resized).toEqual([]);
  }, 120_000);
});

describe.skipIf(!local)("Restart all on the landscape", () => {
  it("gives the restarted sessions new terminals, and their cards follow them", async () => {
    type Restart = { restart: { label: string | null; restarted: boolean; newTerm: boolean; lineBefore: string | null; lineAfter: string | null }; error?: string };
    const a = await page<Restart>("labs=landscape&landscapeRestartAudit", "mb-landscape-restart-audit", "ls-restart");
    expect(a.error).toBeUndefined();
    expect(a.restart).toMatchObject({ restarted: true, newTerm: true, lineAfter: "⏺ After the restart: the tag list is memoized" });
    expect(a.restart.lineBefore).toContain("tag list");
  }, 120_000);
});
