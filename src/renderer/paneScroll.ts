import type { Terminal } from "@xterm/xterm";

/**
 * Scrolling a pane. In a teammate's session (team rooms) it only ever moves
 * this copy: whatever its terminal sends is typed into the owner's session,
 * and xterm's own wheel handling sends things — reports to a program tracking
 * the mouse, and arrow keys on the alternate screen, which a full-screen
 * program (Claude Code's fullscreen view, Codex, less, vim) scrolls by. So
 * there the wheel and PageUp/PageDown never reach xterm; the pane scrolls its
 * copy itself (TerminalPane.tsx).
 */

/** Whole lines a wheel event scrolls, carrying the remainder: trackpads send many tiny pixel deltas. */
export function wheelLines(acc: { wheelAcc: number }, ev: { deltaY: number; deltaMode: number }, cellH: number, pageH: number): number {
  // deltaMode: 0 = pixels, 1 = lines, 2 = pages
  const px = ev.deltaMode === 1 ? ev.deltaY * cellH : ev.deltaMode === 2 ? ev.deltaY * pageH : ev.deltaY;
  if (Math.sign(px) !== Math.sign(acc.wheelAcc)) acc.wheelAcc = 0; // direction flip
  acc.wheelAcc += px;
  const lines = Math.trunc(acc.wheelAcc / cellH) || 0; // never -0
  acc.wheelAcc -= lines * cellH;
  return lines;
}

/** PageUp (-1) or PageDown (1), with or without Shift; Ctrl+PageUp/PageDown are keys of their own to a program. */
export function pageKey(ev: { key: string; ctrlKey: boolean }): -1 | 0 | 1 {
  if (ev.ctrlKey) return 0;
  return ev.key === "PageUp" ? -1 : ev.key === "PageDown" ? 1 : 0;
}

/**
 * Whether a terminal holds history of its own to scroll. On the alternate
 * screen it doesn't: a full-screen program keeps its history itself and
 * redraws one screen of it, so a teammate's copy shows only that screen.
 */
export function hasOwnHistory(term: Pick<Terminal, "buffer" | "options">): boolean {
  return term.buffer.active.type === "normal" && (term.options.scrollback ?? 0) > 0;
}

/**
 * Scroll a teammate's pane by lines (negative: up) — this copy only.
 * "full-screen" when it has no history of its own to scroll.
 */
export function scrollCopy(term: Pick<Terminal, "buffer" | "options" | "scrollLines">, lines: number): "scrolled" | "full-screen" {
  if (!hasOwnHistory(term)) return "full-screen";
  if (lines) term.scrollLines(lines);
  return "scrolled";
}
