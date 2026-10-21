import { afterEach, describe, expect, it, vi } from "vitest";

// xterm's fit addon looks for a browser global as it loads
vi.hoisted(() => {
  (globalThis as { self?: unknown }).self ??= globalThis;
});

import { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { attachTerm, dataPump, fitTerm, followsBottom, jumpToLatest, makeTerm, onFollowChange, repaintTerm, replay, syncViewport, termLinkHandler, REPAINT_NUDGE_MS, type CachedTerm, type SizedTerm } from "../src/renderer/cachedTerm";

const parsed = (term: Terminal) => new Promise<void>((r) => term.write("", r));
const screen = (term: Terminal) => {
  const b = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
  return out.filter(Boolean);
};

function setup() {
  const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 10 });
  const e: CachedTerm = { term, replayed: false, ready: false };
  const entries = new Map([["s1", e]]);
  let push!: (id: string, data: string) => void;
  dataPump((cb) => (push = cb), entries, (x, d) => x.term.write(d))();
  const sent: string[] = [];
  term.onData((d) => e.ready && sent.push(d)); // the pane's only path to the pty waits for ready
  let answer!: (buf: string) => void;
  const saved = new Promise<string>((r) => (answer = r));
  return { term, e, push, sent, answer, saved };
}

describe("cached terminal replay", () => {
  it("drops output already in the saved buffer and keeps output that arrives while the replay parses", async () => {
    const { term, e, push, answer, saved } = setup();
    const done = replay(e, saved, () => true);
    push("s1", "inside the buffer\r\n"); // arrived before the buffer reply: it's in it
    answer("history\r\ninside the buffer\r\n");
    await done;
    expect(e.replayed).toBe(true);
    expect(e.ready).toBe(false); // xterm hasn't parsed the replay yet
    push("s1", "live\r\n");
    await parsed(term);
    expect(e.ready).toBe(true);
    expect(screen(term)).toEqual(["history", "inside the buffer", "live"]);
  });

  it("doesn't forward xterm's answers to queries in the replayed history", async () => {
    const { term, e, sent, answer, saved } = setup();
    const done = replay(e, saved, () => true);
    answer("prompt\x1b[c\x1b[6n");
    await done;
    await parsed(term);
    expect(sent).toEqual([]);
    term.write("\x1b[6n"); // a live query is answered
    await parsed(term);
    expect(sent).toHaveLength(1);
  });

  it("writes nothing into a terminal disposed while the replay was in flight", async () => {
    const { term, e, answer, saved } = setup();
    const done = replay(e, saved, () => false);
    answer("history");
    await done;
    await parsed(term);
    expect(e.replayed).toBe(false);
    expect(screen(term)).toEqual([]);
  });

  it("still follows live output when the saved buffer can't be read, and says so", async () => {
    const { term, e, push } = setup();
    await replay(e, Promise.reject(new Error("gone")), () => true);
    push("s1", "live\r\n");
    await parsed(term);
    expect(e.ready).toBe(true);
    expect(screen(term)).toEqual(["[earlier output couldn't be loaded: gone]", "live"]);
  });
});

/**
 * A cached terminal as a pane shows it: xterm's buffer for real, and its viewport — the element that scrolls —
 * as xterm 5.5's Viewport keeps it (src/browser/Viewport.ts), in a page that behaves as the browser does. The page
 * clamps an offset to what its scroll area allows and fires a scroll event for each change on the next frame, before
 * that frame's animation callbacks; an element out of the page measures 0px tall, and comes back scrolled to 0.
 * xterm measures its viewport on a frame after its buffer grows, and reads every scroll it didn't flag as its own
 * into the buffer, as the user's.
 */
function paneTerm(rows = 10, rowH = 18) {
  const term = new Terminal({ allowProposedApi: true, cols: 40, rows, scrollback: 1000 });
  const core = (term as unknown as { _core: any })._core;
  const page = { scrollEvents: [] as (() => void)[], frames: [] as (() => void)[] };
  const dims = { css: { cell: { width: 8, height: rowH }, canvas: { height: rows * rowH } }, device: { cell: { height: rowH } } };
  core._renderService = { dimensions: dims, refreshRows: () => undefined };
  let holder: ReturnType<typeof holderOf> | null = null;
  const inPage = () => !!holder?.connected;
  const listeners = new Map<string, ((ev?: unknown) => void)[]>();
  const on = (type: string, fn: (ev?: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  const fire = (type: string) => (listeners.get(type) ?? []).forEach((fn) => fn());
  const viewportEl = {
    top: 0,
    area: 0,
    pending: false,
    get offsetHeight() {
      return inPage() ? dims.css.canvas.height : 0;
    },
    get clientHeight() {
      return this.offsetHeight;
    },
    get scrollHeight() {
      return inPage() ? Math.max(this.area, this.clientHeight) : 0;
    },
    get scrollTop() {
      return this.top;
    },
    set scrollTop(v: number) {
      const to = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight));
      if (to === this.top) return;
      this.top = to;
      if (this.pending) return;
      this.pending = true;
      page.scrollEvents.push(() => {
        this.pending = false;
        fire("scroll");
      });
    },
    get offsetParent() {
      return inPage() ? {} : null;
    },
    addEventListener: on,
  };
  // xterm's Viewport, as 5.5 has it
  const vp = {
    _currentRowHeight: 0,
    _lastRecordedBufferLength: 0,
    _lastRecordedViewportHeight: 0,
    _lastRecordedBufferHeight: 0,
    _lastScrollTop: 0,
    _ignoreNextScrollEvent: false,
    _refreshAnimationFrame: null as null | number,
    _refresh(immediate: boolean) {
      if (immediate) return vp._innerRefresh();
      if (vp._refreshAnimationFrame === null) vp._refreshAnimationFrame = page.frames.push(() => vp._innerRefresh());
    },
    _innerRefresh() {
      vp._currentRowHeight = dims.device.cell.height;
      vp._lastRecordedViewportHeight = viewportEl.offsetHeight;
      const h = Math.round(vp._currentRowHeight * vp._lastRecordedBufferLength) + (vp._lastRecordedViewportHeight - dims.css.canvas.height);
      if (vp._lastRecordedBufferHeight !== h) viewportEl.area = vp._lastRecordedBufferHeight = h;
      const top = term.buffer.active.viewportY * vp._currentRowHeight;
      if (viewportEl.scrollTop !== top) {
        vp._ignoreNextScrollEvent = true;
        viewportEl.scrollTop = top;
      }
      vp._refreshAnimationFrame = null;
    },
    syncScrollArea(immediate = false) {
      const b = core._bufferService.buffer;
      if (vp._lastRecordedBufferLength !== b.lines.length) {
        vp._lastRecordedBufferLength = b.lines.length;
        return vp._refresh(immediate);
      }
      if (vp._lastRecordedViewportHeight !== dims.css.canvas.height) return vp._refresh(immediate);
      if (vp._lastScrollTop !== b.ydisp * vp._currentRowHeight) return vp._refresh(immediate);
      if (dims.device.cell.height !== vp._currentRowHeight) return vp._refresh(immediate);
    },
    scrollLines(disp: number) {
      if (disp) core.scrollLines(disp, false, 1);
    },
  };
  on("scroll", () => {
    vp._lastScrollTop = viewportEl.scrollTop;
    if (!viewportEl.offsetParent) return;
    if (vp._ignoreNextScrollEvent) return void (vp._ignoreNextScrollEvent = false);
    core.scrollLines(Math.round(vp._lastScrollTop / vp._currentRowHeight) - term.buffer.active.viewportY, true, 1);
  });
  term.onScroll(() => vp.syncScrollArea());
  core.viewport = vp;
  const elListeners = new Map<string, (() => void)[]>();
  const element = {
    parentElement: null as unknown,
    get isConnected() {
      return inPage();
    },
    querySelector: (sel: string) => (sel === ".xterm-viewport" ? viewportEl : null),
    addEventListener: (type: string, fn: () => void) => elListeners.set(type, [...(elListeners.get(type) ?? []), fn]),
  };
  core.element = element;
  function holderOf(connected = true) {
    const h = {
      connected,
      get isConnected() {
        return h.connected;
      },
      getClientRects: () => (h.connected ? [{}] : []),
      clientWidth: 320,
      clientHeight: rows * rowH,
      appendChild(el: typeof element) {
        el.parentElement = h;
        holder = h;
        viewportEl.top = 0; // an element put into the page comes back scrolled to 0, with no scroll event
      },
    };
    return h;
  }
  /** One frame: the page's scroll events, then the animation callbacks. */
  const frame = () => {
    for (const fn of page.scrollEvents.splice(0)) fn();
    for (const fn of page.frames.splice(0)) fn();
  };
  const write = async (n: number, tag = "line") => {
    await new Promise<void>((r) => term.write(Array.from({ length: n }, (_, i) => `${tag} ${i}\r\n`).join(""), r));
    frame();
    frame();
  };
  const shownIn = (h: ReturnType<typeof holderOf>) => {
    attachTerm(term, h as unknown as HTMLElement);
    frame();
    frame();
  };
  /** The user turns the wheel: xterm moves the page's offset, the scroll event reads it into the buffer. */
  const wheel = (lines: number) => {
    elListeners.get("wheel")?.forEach((fn) => fn());
    viewportEl.scrollTop += lines * vp._currentRowHeight;
    frame();
  };
  const hide = () => {
    if (holder) holder.connected = false;
  };
  const state = () => ({
    behind: term.buffer.active.baseY - term.buffer.active.viewportY,
    following: !core._bufferService.isUserScrolling,
    // the line the page's offset says, which the next wheel move is read from
    pageLine: Math.round(viewportEl.scrollTop / vp._currentRowHeight),
  });
  return { term, dims, vp, viewportEl, holderOf, frame, write, shownIn, wheel, hide, state };
}

describe("a cached terminal's view of its output", () => {
  it("still follows its output when its pane is shown again after output arrived while it was hidden", async () => {
    const t = paneTerm();
    t.shownIn(t.holderOf());
    await t.write(300);
    expect(t.state()).toEqual({ behind: 0, following: true, pageLine: t.term.buffer.active.baseY });
    t.hide(); // its group switched away: output still arrives, and xterm measures a viewport 0px tall
    await t.write(50, "while hidden");
    expect(t.viewportEl.area).toBe(t.term.buffer.active.length * 18 - 10 * 18); // a screen short
    t.shownIn(t.holderOf()); // shown again while its program is idle
    expect(t.state()).toEqual({ behind: 0, following: true, pageLine: t.term.buffer.active.baseY });
    await t.write(30, "after");
    expect(t.state()).toEqual({ behind: 0, following: true, pageLine: t.term.buffer.active.baseY });
  });

  it("keeps its place when the font changes, though xterm's row height catches up a frame later", async () => {
    const t = paneTerm();
    t.shownIn(t.holderOf());
    await t.write(300);
    // a teammate's copy re-fitted at a smaller font: the cell is measured at once, the viewport on its next frame
    t.dims.css.cell.height = t.dims.device.cell.height = 9;
    t.dims.css.canvas.height = 10 * 9;
    syncViewport(t.term); // the holder's resize observer, after the re-fit
    t.frame();
    t.frame();
    expect(t.state()).toEqual({ behind: 0, following: true, pageLine: t.term.buffer.active.baseY });
  });

  it("goes back to the bottom after a scroll the user didn't make, and follows on", async () => {
    const t = paneTerm();
    t.shownIn(t.holderOf());
    await t.write(300);
    t.viewportEl.scrollTop -= 40 * 18; // the page moved the offset: a clamp, a layout change
    t.frame();
    expect(t.state()).toMatchObject({ behind: 0, following: true });
    await t.write(20);
    expect(t.state()).toMatchObject({ behind: 0, following: true });
  });

  it("stays where the user scrolled it while output goes on, says so, and jumps back to the newest output", async () => {
    const t = paneTerm();
    t.shownIn(t.holderOf());
    await t.write(300);
    const told: boolean[] = [];
    onFollowChange(t.term, (atBottom) => told.push(atBottom));
    t.wheel(-40);
    const top = t.term.buffer.active.viewportY;
    expect(t.state().behind).toBe(40);
    expect(followsBottom(t.term)).toBe(false);
    expect(told).toEqual([false]);
    await t.write(30, "more");
    expect(t.term.buffer.active.viewportY).toBe(top);
    t.hide();
    await t.write(10, "hidden");
    t.shownIn(t.holderOf()); // a tab switched away and back keeps the place too
    expect(t.term.buffer.active.viewportY).toBe(top);
    expect(t.state().pageLine).toBe(top);
    jumpToLatest(t.term);
    t.frame();
    expect(t.state()).toEqual({ behind: 0, following: true, pageLine: t.term.buffer.active.baseY });
    expect(followsBottom(t.term)).toBe(true);
    expect(told).toEqual([false, true]);
    await t.write(10);
    expect(t.state().behind).toBe(0);
  });

  it("follows again once the user scrolls back down to the bottom", async () => {
    const t = paneTerm();
    t.shownIn(t.holderOf());
    await t.write(300);
    t.wheel(-5);
    expect(followsBottom(t.term)).toBe(false);
    t.wheel(5);
    expect(followsBottom(t.term)).toBe(true);
    await t.write(10);
    expect(t.state().behind).toBe(0);
  });

  it("leaves a terminal out of the page alone", async () => {
    const t = paneTerm();
    t.shownIn(t.holderOf());
    await t.write(300);
    t.shownIn(t.holderOf(false));
    expect(t.viewportEl.scrollTop).toBe(0);
  });
});

/**
 * A terminal in a holder of `area` (null: out of the page or display:none), at `size`, whose holder fits `fits`.
 * fit() resizes it to what the holder fits, as the fit addon does.
 */
function fitted(size: [number, number], fits: [number, number], area: [number, number] | null = [500, 400]) {
  const holder = { isConnected: !!area, getClientRects: () => (area ? [{}] : []), clientWidth: area?.[0] ?? 0, clientHeight: area?.[1] ?? 0 };
  const term = { cols: size[0], rows: size[1], element: { parentElement: holder }, resize: (cols: number, rows: number) => ([term.cols, term.rows] = [cols, rows]) };
  const fit = { proposeDimensions: () => ({ cols: fits[0], rows: fits[1] }) };
  const e = { term, fit } as unknown as SizedTerm;
  const sent: string[] = [];
  const resize = (cols: number, rows: number) => void sent.push(`${cols}×${rows}`);
  return { e, term, holder, sent, resize };
}

describe("fitting a terminal to its pane", () => {
  it("tells a new pty its size on the first fit, even when the terminal already had that size, then only what changes", () => {
    // a relaunched session's pty starts at its default size, whatever size the terminal shows
    const { e, term, holder, sent, resize } = fitted([80, 24], [80, 24]);
    fitTerm(e, resize);
    expect(sent).toEqual(["80×24"]);
    fitTerm(e, resize); // the holder observed again at the same size
    expect(sent).toEqual(["80×24"]);
    (e.fit as unknown as { proposeDimensions: () => unknown }).proposeDimensions = () => ({ cols: 90, rows: 30 });
    holder.clientWidth = 560;
    fitTerm(e, resize);
    expect(sent).toEqual(["80×24", "90×30"]);
  });

  it("never measures a holder out of the page, hidden or squeezed to nothing", () => {
    for (const area of [null, [0, 0], [500, 0]] as const) {
      // the fit addon still proposes its two-column, one-row minimum for an empty holder
      const { e, term, sent, resize } = fitted([80, 24], [2, 1], area as [number, number] | null);
      fitTerm(e, resize);
      expect(sent).toEqual([]);
      expect([term.cols, term.rows]).toEqual([80, 24]);
    }
  });

  it("gives it no more rows than its holder's content box holds: the fit addon's run into the holder's padding", () => {
    vi.stubGlobal("getComputedStyle", () => ({ paddingTop: "9px", paddingBottom: "3px" }));
    try {
      // 806px tall with 12px of padding: 41 rows of 19.5px by the border box, 40 in the 794px inside it
      const { e, term, sent, resize } = fitted([80, 24], [100, 41], [800, 806]);
      (term as unknown as { _core: unknown })._core = { _renderService: { dimensions: { css: { cell: { width: 8, height: 19.5 } } } } };
      fitTerm(e, resize);
      expect(sent).toEqual(["100×40"]);
      expect(term.rows * 19.5).toBeLessThanOrEqual(794);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Repaint", () => {
  function repainting(rows = 10) {
    const term = new Terminal({ allowProposedApi: true, cols: 40, rows, scrollback: 1000 });
    const e = { term, fit: {} as FitAddon } as SizedTerm;
    const sent: string[] = [];
    const resize = (cols: number, r: number) => void sent.push(`${cols}×${r}`);
    let restore: (() => void) | null = null;
    const later = (fn: () => void) => void (restore = fn);
    return { term, e, sent, resize, later, restore: () => restore?.() };
  }
  const lines = (term: Terminal) => {
    const b = term.buffer.active;
    return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? "");
  };

  it("keeps the scrollback: an inline session's history stays where it was", async () => {
    const { term, e, resize, later, restore } = repainting();
    await new Promise<void>((r) => term.write(Array.from({ length: 200 }, (_, i) => `history ${i}\r\n`).join("") + "> ", r));
    const before = lines(term);
    repaintTerm(e, resize, later);
    restore();
    await parsed(term);
    expect(term.buffer.active.type).toBe("normal");
    expect(lines(term)).toEqual(before);
  });

  it("keeps the program's alternate screen and mouse tracking, clearing only that screen for its redraw", async () => {
    const { term, e, resize, later, restore } = repainting();
    await new Promise<void>((r) => term.write("shell history\r\n\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[Hgarbled frame", r));
    repaintTerm(e, resize, later);
    restore();
    await parsed(term);
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.modes.mouseTrackingMode).toBe("vt200");
    expect(screen(term)).toEqual([]);
    expect(term.buffer.normal.getLine(0)?.translateToString(true)).toBe("shell history");
  });

  it("makes the program redraw by a resize round trip, given back at the terminal's size when it ends", () => {
    const { term, e, sent, resize, later, restore } = repainting(12);
    repaintTerm(e, resize, later);
    expect(sent).toEqual(["39×12"]);
    term.resize(60, 20); // the pane re-fitted during the round trip
    restore();
    expect(sent).toEqual(["39×12", "60×20"]);
    expect(e.ptySize).toEqual({ cols: 60, rows: 20 });
    expect(REPAINT_NUDGE_MS).toBeGreaterThan(0);
  });
});

describe("links in terminal output", () => {
  afterEach(() => vi.unstubAllGlobals());

  function browser(answer: boolean) {
    const opened: string[] = [];
    const asked: string[] = [];
    const alerts: string[] = [];
    vi.stubGlobal("window", { mb: { openExternal: async (url: string) => void opened.push(url) } });
    vi.stubGlobal("confirm", (msg: string) => (asked.push(msg), answer));
    vi.stubGlobal("alert", (msg: string) => void alerts.push(msg));
    return { opened, asked, alerts };
  }
  const click = async (url: string) => {
    termLinkHandler.activate(new Event("click") as MouseEvent, url, { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } });
    await new Promise((r) => setTimeout(r, 0));
  };

  it("open in the browser, never the app, once the real address has been shown and agreed to", async () => {
    const yes = browser(true);
    await click("https://evil.example/login");
    expect(yes.asked).toEqual([expect.stringContaining("https://evil.example/login")]);
    expect(yes.opened).toEqual(["https://evil.example/login"]);
    const no = browser(false);
    await click("https://evil.example/login");
    expect(no.opened).toEqual([]);
  });

  it("go nowhere unless they're https, and say so", async () => {
    const b = browser(true);
    for (const url of ["http://evil.example", "file:///etc/passwd", "javascript:alert(1)"]) await click(url);
    expect(b.asked).toEqual([]);
    expect(b.opened).toEqual([]);
    expect(b.alerts).toHaveLength(3);
    expect(b.alerts[0]).toMatch(/Only https links open in the browser/);
  });

  it("is every app terminal's handler", () => {
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    expect(makeTerm({}).term.options.linkHandler).toBe(termLinkHandler);
  });
});
