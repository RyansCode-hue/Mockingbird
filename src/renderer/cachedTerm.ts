import { Terminal, type IBufferCell, type IBufferLine, type ILinkHandler, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { externalUrlAllowed } from "../shared/links";
import { openLink } from "./uiUtil";

/** A terminal kept for the life of the window, so leaving and coming back keeps its scrollback. */
export interface CachedTerm {
  term: Terminal;
  /** The saved output has been handed to xterm: live output may be written after it. */
  replayed: boolean;
  /** xterm has parsed the saved output, so what it emits from now on answers live output. */
  ready: boolean;
}

const TERM_THEMES = {
  dark: {
    background: "#201f1c",
    foreground: "#c9c3b8",
    cursor: "#e0a34a",
    cursorAccent: "#201f1c",
    // translucent white, like stock xterm — the old #3a372f was near-invisible
    // against the pane background, so selections looked broken even when live
    selectionBackground: "rgba(255, 255, 255, 0.35)",
    selectionInactiveBackground: "rgba(255, 255, 255, 0.22)",
  },
  light: {
    background: "#fbf9f5",
    foreground: "#4f4a3f",
    cursor: "#a06a12",
    cursorAccent: "#fbf9f5",
    selectionBackground: "rgba(30, 60, 110, 0.25)",
    selectionInactiveBackground: "rgba(30, 60, 110, 0.15)",
  },
};
type TermTheme = (typeof TERM_THEMES)["dark"];

export function currentTermTheme(): TermTheme {
  return document.documentElement.dataset.theme === "light" ? TERM_THEMES.light : TERM_THEMES.dark;
}

/** Each terminal cache restyles its terminals here when the app theme flips. */
export const termThemeListeners = new Set<(theme: TermTheme) => void>();

/** Restyle every live terminal when the app theme flips. */
export function applyTermTheme(light: boolean): void {
  const theme = light ? TERM_THEMES.light : TERM_THEMES.dark;
  for (const l of termThemeListeners) l(theme);
}

/**
 * Links in a terminal's output (OSC 8: a teammate's session's too) open in the
 * browser, never in the app: https only, and only once the address they
 * really go to has been shown and agreed to, since the text on screen can say
 * anything.
 */
export const termLinkHandler: ILinkHandler = {
  activate(_event, url) {
    if (!externalUrlAllowed(url)) return void alert(`Only https links open in the browser (got ${url.slice(0, 200)})`);
    if (confirm(`Open this link in your browser?\n\n${url}`)) void openLink(url);
  },
};

/**
 * A terminal in the app's terminal font and current theme, with its fit addon loaded. Output colours too faint
 * for the theme's background are pushed to 4.5:1 (xterm halves that for SGR-dim text).
 */
export function makeTerm(options: ITerminalOptions): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({ fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace', theme: currentTermTheme(), linkHandler: termLinkHandler, minimumContrastRatio: 4.5, ...options });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}

/** A terminal whose program's pty this renderer sizes: `ptySize` is what the pty was last told. */
export interface SizedTerm {
  term: Terminal;
  fit: FitAddon;
  ptySize?: { cols: number; rows: number };
}

/** Whether a terminal's holder is laid out with an area to measure: not out of the page, not display:none, not squeezed to nothing. */
function holderHasArea(term: Terminal): boolean {
  const holder = term.element?.parentElement;
  return !!holder?.isConnected && holder.getClientRects().length > 0 && holder.clientWidth > 0 && holder.clientHeight > 0;
}

/**
 * The size a terminal fits its holder at: the fit addon's, with no more rows
 * than the holder's content box holds. The addon measures the holder's
 * border box, so its rows run into the holder's padding — the last of them
 * drawn under the pane's edge.
 */
export function fitSize(e: SizedTerm): { cols: number; rows: number } | null {
  const dims = e.fit.proposeDimensions();
  if (!dims || !dims.cols || !dims.rows) return null;
  const holder = e.term.element?.parentElement;
  const cell = cellOf(e.term);
  if (!holder || !cell) return dims;
  const pad = getComputedStyle(holder);
  const content = holder.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom);
  return { cols: dims.cols, rows: Math.max(1, Math.min(dims.rows, Math.floor(content / cell.height))) };
}

/**
 * Fit a terminal to its holder and tell the pty its size whenever the pty
 * doesn't have it yet: the first fit after the terminal is made, and every
 * change since. A pty is told nothing otherwise — every needless resize makes
 * the CLI redraw its frame, which leaves stale duplicated lines behind when
 * xterm has reflowed the old one. A holder with no area is never measured:
 * fitting to it would give the program a two-column, one-row screen.
 */
export function fitTerm(e: SizedTerm, resize: (cols: number, rows: number) => void): void {
  if (!holderHasArea(e.term)) return;
  const dims = fitSize(e);
  if (!dims) return;
  if (dims.cols !== e.term.cols || dims.rows !== e.term.rows) e.term.resize(dims.cols, dims.rows);
  const { cols, rows } = e.term;
  if (e.ptySize?.cols === cols && e.ptySize.rows === rows) return;
  e.ptySize = { cols, rows };
  resize(cols, rows);
}

/** How long a Repaint holds the pty one column narrower before giving it its size back. */
export const REPAINT_NUDGE_MS = 80;

/**
 * Have a terminal's program draw its screen again, keeping everything the
 * terminal holds: its scrollback (an inline session's whole history) and the
 * modes the program set (the alternate screen, mouse tracking, bracketed
 * paste). A full reset would wipe both, and the program, never told, would go
 * on drawing into the normal screen with the wheel no longer reaching it.
 *
 * The program is made to redraw by a resize round trip (a SIGWINCH each way);
 * the size given back is the terminal's own at that moment, so a fit made in
 * between isn't undone. A full-screen program redraws all of its screen, so
 * the alternate screen is cleared first; the normal screen is left as it is,
 * since what's on it is the newest history. xterm repaints its rows from the
 * buffer either way.
 */
export function repaintTerm(e: SizedTerm, resize: (cols: number, rows: number) => void, later: (fn: () => void, ms: number) => unknown = setTimeout): void {
  const { term } = e;
  if (term.buffer.active.type === "alternate") term.write("\x1b[2J");
  term.refresh(0, term.rows - 1);
  syncViewport(term);
  resize(Math.max(2, term.cols - 1), term.rows);
  later(() => {
    e.ptySize = { cols: term.cols, rows: term.rows };
    resize(term.cols, term.rows);
  }, REPAINT_NUDGE_MS);
}

/**
 * Show a terminal at a size decided elsewhere — a teammate's session renders
 * at its owner's size, and never resizes their pty. The font shrinks to fit
 * the holder (down to `minFont`); past that the holder scrolls.
 */
export function fitFixed(e: { term: Terminal }, holder: HTMLElement | null, size: { cols: number; rows: number }, maxFont: number, minFont = 6): void {
  const { term } = e;
  if (term.cols !== size.cols || term.rows !== size.rows) term.resize(size.cols, size.rows);
  if (!holder?.clientWidth || !holder.clientHeight) return;
  const pad = getComputedStyle(holder);
  const w = holder.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
  const h = holder.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom);
  // xterm measures its cell as soon as the font changes, but draws the screen a frame or two later:
  // the cell is what to go by
  const fits = (f: number): boolean | null => {
    if (term.options.fontSize !== f) term.options.fontSize = f;
    const cell = cellOf(term);
    return cell ? size.cols * cell.width <= w && size.rows * cell.height <= h : null;
  };
  let font = Math.min(maxFont, Math.max(minFont, term.options.fontSize ?? maxFont));
  let ok = fits(font);
  if (ok === null) return; // not drawn yet: fitted again once its holder has a size
  while (!ok && font > minFont) ok = fits((font -= 0.5));
  while (ok && font + 0.5 <= maxFont) {
    if (fits(font + 0.5)) font += 0.5;
    else {
      fits(font);
      break;
    }
  }
}

/**
 * Put a cached terminal in a pane's holder: opened there the first time, moved
 * there when another pane (a tab switched back to, a group shown again) shows it.
 */
export function attachTerm(term: Terminal, holder: HTMLElement | null): void {
  if (!holder) return;
  if (!term.element) term.open(holder);
  else if (term.element.parentElement !== holder) holder.appendChild(term.element);
  followOutput(term);
  syncViewport(term);
}

/** The parts of xterm's viewport (the element that scrolls) this module keeps in step with the page: not public API. */
interface XtermViewport {
  /** Records the buffer's length and refreshes when anything it measured changed. */
  syncScrollArea(immediate?: boolean): void;
  /** Measures the viewport as laid out now, sizes its scroll area to the buffer and puts its offset at the view's row. */
  _innerRefresh(): void;
}

let missingViewport = false;
function viewportOf(term: Terminal): XtermViewport | null {
  const v = (term as unknown as { _core?: { viewport?: Partial<XtermViewport> } })._core?.viewport;
  if (v && typeof v.syncScrollArea === "function" && typeof v._innerRefresh === "function") return v as XtermViewport;
  if (term.element && !missingViewport) {
    missingViewport = true;
    console.error("[mockingbird] xterm's viewport has no syncScrollArea/_innerRefresh: terminals can't resync their scroll offsets (an xterm upgrade?)");
  }
  return null;
}

/**
 * Bring xterm's viewport in step with the page, and a view that follows its
 * output back to the bottom.
 *
 * xterm measures its viewport on the frame after its buffer grows, also while
 * the terminal is out of the page (its pane hidden, output still arriving).
 * Measured there, the viewport is 0px tall, and the scroll area it sizes from
 * that is a screen short. Shown again, the page can't scroll to the bottom:
 * the offset is clamped a screen up, and xterm reads that scroll as the user's,
 * stops following output, and once its scrollback is full drifts further up
 * with every line. An offset computed here from the cell's CSS height, not the
 * row height xterm reads offsets in (they differ after a font change until
 * xterm's next refresh, and by a fraction of a pixel at some row counts),
 * moves the view the same way. And an element put back into the page comes
 * back scrolled to 0, where the next wheel move would be read from. So xterm
 * measures again itself, now that the holder is laid out, and sets the offset
 * in its own row height.
 */
export function syncViewport(term: Terminal): void {
  if (!term.element?.isConnected || !holderHasArea(term)) return;
  const vp = viewportOf(term);
  if (vp) {
    vp.syncScrollArea(true);
    vp._innerRefresh();
  }
  if (follows.get(term)?.atBottom && !atBottom(term)) toBottom(term);
}

/**
 * Terminals whose newest-output view ends at their program's last content
 * rather than at the bottom of the screen (an agent's pane; see bottomLine).
 */
const anchored = new WeakSet<Terminal>();

/** From now on, this terminal's view of its newest output ends at its program's content (bottomLine). */
export function anchorToContent(term: Terminal): void {
  anchored.add(term);
}

/** A row with nothing drawn in it: no text, and no background or inverse colour behind its spaces (a renderer clears cells by writing spaces). */
function blankRow(line: IBufferLine, cell: IBufferCell): boolean {
  if (line.translateToString(true).trim()) return false;
  for (let x = 0; x < line.length; x++) {
    const c = line.getCell(x, cell);
    if (c && (!c.isBgDefault() || c.isInverse())) return false;
  }
  return true;
}

/**
 * The first line of a terminal's view when it shows its newest output: the
 * screen's, or for a terminal anchored to its content, up by the blank rows
 * below both its program's last drawn row and its cursor, as far as there is
 * history to show above.
 *
 * An inline agent CLI (Claude Code's classic renderer) draws its frame
 * relative to the cursor, which it parks in its input box, and keeps the rows
 * its frame gives up: when the frame shrinks it erases them and moves up,
 * after a full redraw it paints the frame from the screen's top row, and when
 * the terminal gets taller it draws nothing while xterm adds the new rows
 * blank below the frame (xterm brings back scrollback only for a cursor on
 * the last row). The screen's bottom rows then hold nothing, and a view of the
 * screen shows them below the input box. A full-screen program fills its
 * screen, and has no scrollback to show instead (bottomLine is its baseY).
 * Only the view moves: the program's screen stays as it drew it, so its
 * cursor-relative drawing lands where it expects.
 */
export function bottomLine(term: Pick<Terminal, "buffer" | "rows" | "modes">): number {
  const b = term.buffer.active;
  if (!anchored.has(term as Terminal) || b.type !== "normal" || term.modes.mouseTrackingMode !== "none") return b.baseY;
  const cell = b.getNullCell();
  let last = b.cursorY;
  for (let y = term.rows - 1; y > last; y--) {
    const line = b.getLine(b.baseY + y);
    if (line && !blankRow(line, cell)) last = y;
  }
  return Math.max(0, b.baseY - (term.rows - 1 - last));
}

/** Show a terminal's newest output (bottomLine). */
function toBottom(term: Terminal): void {
  const y = bottomLine(term);
  if (y === term.buffer.active.baseY) term.scrollToBottom();
  else if (term.buffer.active.viewportY !== y) term.scrollToLine(y);
}

/** xterm's cell size in CSS pixels, for its current font (not public API: null when it isn't there). */
function cellOf(term: Terminal): { width: number; height: number } | null {
  const cell = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core?._renderService?.dimensions?.css?.cell;
  return cell?.width && cell.height ? cell : null;
}

/** How long after a wheel, touch or key a scroll counts as the user's. */
export const USER_SCROLL_MS = 300;

interface Follow {
  /** The user left the view at the bottom (or never moved it): it follows output there. */
  atBottom: boolean;
  /** When the user last wheeled, touched or pressed a key in the terminal; a held pointer (a selection drag) counts until it's let go. */
  userAt: number;
  holding: boolean;
  listeners: Set<(atBottom: boolean) => void>;
}
const follows = new WeakMap<Terminal, Follow>();
const atBottom = (term: Terminal) => term.buffer.active.viewportY >= bottomLine(term);

/**
 * Keep a terminal's view on its newest output while the user leaves it
 * there, and where they put it when they scroll up. xterm alone follows the
 * bottom until any scroll of its viewport it didn't make itself, which it
 * takes for the user's: a layout change (an offset clamped or reset by the
 * page) stops it following. Here only a scroll right after the user's wheel,
 * touch, key or held pointer decides that the view left the bottom; any other
 * scroll away from it, while it was following, goes back. Reaching the bottom
 * by any means follows again. A terminal anchored to its content never shows
 * the blank rows below it (bottomLine): a scroll down into them goes back up,
 * and a following view keeps the content's last row at the bottom as output
 * and resizes move it. Needs the terminal opened; once.
 */
export function followOutput(term: Terminal): void {
  const el = term.element;
  if (follows.has(term) || !el) return;
  const f: Follow = { atBottom: atBottom(term), userAt: 0, holding: false, listeners: new Set() };
  follows.set(term, f);
  const user = () => (f.userAt = Date.now());
  for (const ev of ["wheel", "touchstart", "touchmove", "keydown"]) el.addEventListener(ev, user, { capture: true, passive: true });
  const release = () => {
    f.holding = false;
    user();
    window.removeEventListener("pointerup", release, true);
    window.removeEventListener("pointercancel", release, true);
  };
  el.addEventListener(
    "pointerdown",
    () => {
      user();
      f.holding = true;
      window.addEventListener("pointerup", release, true);
      window.addEventListener("pointercancel", release, true);
    },
    true
  );
  const check = () => {
    // below the content's last row there is nothing to see: back up (that scroll checks again)
    if (term.buffer.active.viewportY > bottomLine(term)) return toBottom(term);
    const bottom = atBottom(term);
    const theirs = f.holding || Date.now() - f.userAt < USER_SCROLL_MS;
    if (!bottom && !theirs) {
      if (f.atBottom) toBottom(term);
      return;
    }
    if (bottom === f.atBottom) return;
    f.atBottom = bottom;
    for (const l of f.listeners) l(bottom);
  };
  // registered after xterm's own listener, which has read the scroll into the buffer by then
  el.querySelector(".xterm-viewport")?.addEventListener("scroll", check);
  term.onScroll(check);
  // xterm follows the screen's bottom itself; the content's moves with what the program draws and with resizes
  if (anchored.has(term)) {
    const follow = () => void (f.atBottom && toBottom(term));
    term.onWriteParsed(follow);
    term.onResize(follow);
  }
}

/** The user moved this terminal's view themselves (a teammate's copy scrolls without xterm seeing the wheel or key). */
export function noteUserScroll(term: Pick<Terminal, "buffer">): void {
  const f = follows.get(term as Terminal);
  if (f) f.userAt = Date.now();
}

/** Told whether the view follows the bottom whenever that changes; returns the unsubscribe. */
export function onFollowChange(term: Terminal, cb: (atBottom: boolean) => void): () => void {
  const f = follows.get(term);
  if (!f) return () => undefined;
  f.listeners.add(cb);
  return () => void f.listeners.delete(cb);
}

/** Whether the view follows the bottom (true for a terminal not followed yet). */
export function followsBottom(term: Terminal): boolean {
  return follows.get(term)?.atBottom ?? true;
}

/** Back to the newest output, following it again. */
export function jumpToLatest(term: Terminal): void {
  noteUserScroll(term);
  toBottom(term);
}

/**
 * Keep a terminal at a fixed size, fitted to its holder by its font, from now
 * on. Returns the stop, and `refit` for when the size or the largest font changes.
 */
export function followFixedSize(e: { term: Terminal }, holder: HTMLElement | null, size: () => { cols: number; rows: number }, maxFont: () => number): { stop: () => void; refit: () => void } {
  // a new font changes the row height the viewport's offsets are read in, and a holder shown again after
  // display:none comes back scrolled to 0 (syncViewport)
  const refit = () => {
    fitFixed(e, holder, size(), maxFont());
    syncViewport(e.term);
  };
  refit();
  // the terminal font may still be loading: its proportions decide the fit
  void document.fonts?.ready.then(refit);
  const ro = new ResizeObserver(refit);
  if (holder) ro.observe(holder);
  return { stop: () => ro.disconnect(), refit };
}

/** Keep a terminal fitted to its holder from now on; returns the stop. */
export function followSize(e: SizedTerm, holder: HTMLElement | null, resize: (cols: number, rows: number) => void): () => void {
  // a re-fit changes what the viewport measured, and a holder shown again after display:none comes back
  // scrolled to 0 (syncViewport)
  const fit = () => {
    fitTerm(e, resize);
    syncViewport(e.term);
  };
  fit();
  const ro = new ResizeObserver(fit);
  if (holder) ro.observe(holder);
  return () => ro.disconnect();
}

/**
 * Replay a terminal's saved output, then let live output follow it.
 *
 * The main process appends each chunk to its buffer and sends it in the same
 * step, so a chunk that arrives before the buffer does is already inside it
 * (the pump drops it) and every later one isn't (the pump writes it). xterm
 * parses writes in the order they're made, so live output may follow as soon
 * as the replay is queued. Input waits for `ready`: while xterm parses the
 * replay it answers the queries in that history, and those answers must not
 * reach the program.
 */
export function replay(e: CachedTerm, saved: Promise<string>, current: () => boolean, prepare: (s: string) => string = (s) => s): Promise<void> {
  return saved.then(
    (buf) => {
      if (!current()) return; // disposed while in flight
      e.replayed = true;
      const text = buf ? prepare(buf) : "";
      if (text) e.term.write(text, () => (e.ready = true));
      else e.ready = true;
    },
    (err: unknown) => {
      if (!current()) return;
      console.error("[mockingbird] scrollback replay failed", err);
      // live output and input still work; say why the history is missing
      e.term.write(`\x1b[2m[earlier output couldn't be loaded: ${err instanceof Error ? err.message : String(err)}]\x1b[0m\r\n`);
      e.replayed = e.ready = true;
    }
  );
}

// every path a human's input takes into xterm: physical keys, IME composition,
// dictation/autofill (input events), and paste
const INPUT_EVENTS = ["keydown", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend", "paste"];

/**
 * Note when the user last typed into a terminal, so what xterm sends right
 * after counts as theirs (inputGuard.ts). Needs the terminal opened; once.
 */
export function trackUserInput(e: { term: Terminal; lastInput: number; inputWired?: boolean }): void {
  const area = e.term.textarea;
  if (e.inputWired || !area) return;
  e.inputWired = true;
  for (const ev of INPUT_EVENTS) area.addEventListener(ev, () => (e.lastInput = Date.now()), true);
}

/**
 * One subscription for a kind of terminal output, feeding every cached
 * terminal whether or not it's on screen (a hidden one would otherwise miss
 * output and look frozen on return). Returns the function that wires it, once.
 */
export function dataPump<E extends CachedTerm>(
  subscribe: (cb: (id: string, data: string) => void) => void,
  entries: ReadonlyMap<string, E>,
  write: (e: E, data: string) => void
): () => void {
  let wired = false;
  return () => {
    if (wired) return;
    wired = true;
    subscribe((id, data) => {
      const e = entries.get(id);
      if (e?.replayed) write(e, data);
    });
  };
}
