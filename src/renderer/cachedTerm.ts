import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

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

/** A terminal in the app's terminal font and current theme, with its fit addon loaded. */
export function makeTerm(options: ITerminalOptions): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({ fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace', theme: currentTermTheme(), ...options });
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

/** Keep a terminal fitted to its holder from now on; returns the stop. */
export function followSize(e: { term: Terminal; fit: FitAddon }, holder: HTMLElement | null, resize: (cols: number, rows: number) => void): () => void {
  const fit = () => fitTerm(e, resize);
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
