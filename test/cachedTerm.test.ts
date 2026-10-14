import { afterEach, describe, expect, it, vi } from "vitest";

// xterm's fit addon looks for a browser global as it loads
vi.hoisted(() => {
  (globalThis as { self?: unknown }).self ??= globalThis;
});

import { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { attachTerm, dataPump, fitTerm, makeTerm, repaintTerm, replay, syncViewport, termLinkHandler, REPAINT_NUDGE_MS, type CachedTerm, type SizedTerm } from "../src/renderer/cachedTerm";

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
 * A cached terminal as a pane shows it, scrolled to `viewportY` with 18px rows. Holders behave as
 * the browser does: an element put into one comes back with its viewport scrolled to 0.
 */
function shownTerm(viewportY: number) {
  const viewport = { scrollTop: 0 };
  const element = { parentElement: null as unknown, isConnected: false, querySelector: (sel: string) => (sel === ".xterm-viewport" ? viewport : null) };
  const term = {
    element: undefined as typeof element | undefined,
    buffer: { active: { viewportY } },
    open(holder: ReturnType<typeof holderOf>) {
      term.element = element;
      holder.appendChild(element);
    },
    _core: { _renderService: { dimensions: { css: { cell: { width: 7, height: 18 } } } } },
  };
  const holderOf = (connected = true) => {
    const h = {
      appendChild(el: typeof element) {
        el.parentElement = h;
        el.isConnected = connected;
        viewport.scrollTop = 0;
      },
    };
    return h;
  };
  const attach = (h: ReturnType<typeof holderOf>) => attachTerm(term as unknown as Terminal, h as unknown as HTMLElement);
  return { term, viewport, holderOf, attach };
}

describe("a cached terminal shown in a pane again", () => {
  it("keeps the view it had: its viewport's offset follows the buffer, so the next scroll moves from there, not from the top", () => {
    const { term, viewport, holderOf, attach } = shownTerm(7995);
    attach(holderOf()); // first shown
    expect(viewport.scrollTop).toBe(7995 * 18);
    attach(holderOf()); // its tab switched away and back
    expect(term.element?.isConnected).toBe(true);
    expect(viewport.scrollTop).toBe(7995 * 18);
  });

  it("leaves an offset within half a row alone, and a terminal out of the page untouched", () => {
    const { term, viewport, holderOf, attach } = shownTerm(100);
    attach(holderOf());
    viewport.scrollTop = 100 * 18 + 5; // mid-scroll on a trackpad
    syncViewport(term as unknown as Terminal);
    expect(viewport.scrollTop).toBe(100 * 18 + 5);
    attach(holderOf(false));
    expect(viewport.scrollTop).toBe(0);
  });
});

/**
 * A terminal in a holder of `area` (null: out of the page or display:none), at `size`, whose holder fits `fits`.
 * fit() resizes it to what the holder fits, as the fit addon does.
 */
function fitted(size: [number, number], fits: [number, number], area: [number, number] | null = [500, 400]) {
  const holder = { isConnected: !!area, getClientRects: () => (area ? [{}] : []), clientWidth: area?.[0] ?? 0, clientHeight: area?.[1] ?? 0 };
  const term = { cols: size[0], rows: size[1], element: { parentElement: holder } };
  const fit = {
    proposeDimensions: () => ({ cols: fits[0], rows: fits[1] }),
    fit: () => ([term.cols, term.rows] = fits),
  };
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
    (e.fit as unknown as { fit: () => void }).fit = () => ([term.cols, term.rows] = [90, 30]);
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
