import type { Terminal } from "@xterm/xterm";

/**
 * Scrolling a pane. In a teammate's session (team rooms) it only ever moves
 * this copy: whatever its terminal sends is typed into the owner's session,
 * and xterm's own wheel handling sends things — reports to a program tracking
 * the mouse, and arrow keys on the alternate screen, which a full-screen
 * program (Claude Code's fullscreen view, Codex, less, vim) scrolls by. So
 * there the wheel and PageUp/PageDown never reach xterm; the pane scrolls its
 * copy itself (TerminalPane.tsx). A copy redrawn from its owner's scrollback
 * keeps the viewer where they had scrolled to (viewAnchor, anchorLine).
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

/** Where a scrolled-up view is: its top rows' text, and how far above the bottom it sits. */
export interface ViewAnchor {
  rows: string[];
  fromBottom: number;
}

type Buf = { type: string; viewportY: number; baseY: number; length: number; getLine(y: number): { translateToString(trim?: boolean): string } | undefined };
const rowAt = (b: Buf, y: number) => b.getLine(y)?.translateToString(true) ?? "";
const ANCHOR_TEXT_ROWS = 3;

/**
 * Note where a teammate's pane is scrolled to before its copy is redrawn from
 * the owner's scrollback (a gap in its stream, Repaint, its owner back): the
 * redraw starts from a reset, which would leave the view at the bottom. Null
 * when it's at the bottom already, or on the alternate screen.
 */
export function viewAnchor(term: { buffer: { active: Buf }; rows: number }): ViewAnchor | null {
  const b = term.buffer.active;
  if (b.type !== "normal" || b.viewportY >= b.baseY) return null;
  // enough rows to hold a few with text: blank rows alone match anywhere
  const rows: string[] = [];
  let withText = 0;
  for (let y = b.viewportY; y < Math.min(b.length, b.viewportY + term.rows) && withText < ANCHOR_TEXT_ROWS; y++) {
    const r = rowAt(b, y);
    rows.push(r);
    if (r.trim()) withText++;
  }
  return withText ? { rows, fromBottom: b.baseY - b.viewportY } : null;
}

/**
 * The line to show at the top of a redrawn copy so the view stays where it
 * was: where the anchor's rows are now, nearest the distance from the bottom
 * they had (output may have arrived meanwhile). Null when they're gone — the
 * program itself reset the screen.
 */
export function anchorLine(term: { buffer: { active: Buf } }, a: ViewAnchor): number | null {
  const b = term.buffer.active;
  if (b.type !== "normal") return null;
  const at = (y: number) => a.rows.every((r, i) => rowAt(b, y + i) === r);
  const expected = Math.max(0, Math.min(b.baseY, b.baseY - a.fromBottom));
  for (let d = 0; expected - d >= 0 || expected + d <= b.baseY; d++) {
    if (expected - d >= 0 && at(expected - d)) return expected - d;
    if (d && expected + d <= b.baseY && at(expected + d)) return expected + d;
  }
  return null;
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
