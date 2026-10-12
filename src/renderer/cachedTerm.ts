import { Terminal, type ILinkHandler, type ITerminalOptions } from "@xterm/xterm";
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

/** A terminal in the app's terminal font and current theme, with its fit addon loaded. */
export function makeTerm(options: ITerminalOptions): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({ fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace', theme: currentTermTheme(), linkHandler: termLinkHandler, ...options });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}

/**
 * Fit a terminal to its holder and tell the pty the new size — only when the
 * geometry actually changed: every needless pty resize makes the CLI redraw
 * its frame, which leaves stale duplicated lines behind when xterm has
 * reflowed the old one.
 */
export function fitTerm(e: { term: Terminal; fit: FitAddon }, resize: (cols: number, rows: number) => void): void {
  try {
    const dims = e.fit.proposeDimensions();
    if (!dims || !dims.cols || !dims.rows) return;
    if (dims.cols === e.term.cols && dims.rows === e.term.rows) return;
    e.fit.fit();
    resize(e.term.cols, e.term.rows);
  } catch {
    /* not visible: nothing to measure */
  }
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
  syncViewport(term);
}

/**
 * Put the viewport's scroll offset back where the buffer is scrolled to. An
 * element taken out of the page (its pane unmounted, its holder display:none)
 * comes back scrolled to 0, and xterm doesn't notice until its buffer grows —
 * never, once the scrollback is full. Meanwhile it shows the right rows, but
 * the next wheel or scrollbar move is read against that 0 and jumps the view
 * to the top of the history.
 */
export function syncViewport(term: Terminal): void {
  const viewport = term.element?.querySelector<HTMLElement>(".xterm-viewport");
  const cell = cellOf(term);
  if (!viewport || !cell || !term.element?.isConnected) return;
  const want = term.buffer.active.viewportY * cell.height;
  // xterm's scroll handler reads the row back from this offset, rounding: within half a row it already agrees
  if (Math.abs(viewport.scrollTop - want) >= cell.height / 2) viewport.scrollTop = want;
}

/** xterm's cell size in CSS pixels, for its current font (not public API: null when it isn't there). */
function cellOf(term: Terminal): { width: number; height: number } | null {
  const cell = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core?._renderService?.dimensions?.css?.cell;
  return cell?.width && cell.height ? cell : null;
}

/**
 * Keep a terminal at a fixed size, fitted to its holder by its font, from now
 * on. Returns the stop, and `refit` for when the size or the largest font changes.
 */
export function followFixedSize(e: { term: Terminal }, holder: HTMLElement | null, size: () => { cols: number; rows: number }, maxFont: () => number): { stop: () => void; refit: () => void } {
  const refit = () => fitFixed(e, holder, size(), maxFont());
  refit();
  // the terminal font may still be loading: its proportions decide the fit
  void document.fonts?.ready.then(refit);
  // a holder shown again after display:none comes back scrolled to 0 (syncViewport)
  const ro = new ResizeObserver(() => {
    refit();
    syncViewport(e.term);
  });
  if (holder) ro.observe(holder);
  return { stop: () => ro.disconnect(), refit };
}

/** Keep a terminal fitted to its holder from now on; returns the stop. */
export function followSize(e: { term: Terminal; fit: FitAddon }, holder: HTMLElement | null, resize: (cols: number, rows: number) => void): () => void {
  const fit = () => fitTerm(e, resize);
  fit();
  // a holder shown again after display:none comes back scrolled to 0 (syncViewport)
  const ro = new ResizeObserver(() => {
    fit();
    syncViewport(e.term);
  });
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
