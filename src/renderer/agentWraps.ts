import type { IBuffer, IBufferCell, IMarker, Terminal } from "@xterm/xterm";
import type { AgentKind } from "../shared/types";

/*
 * Copying text out of an agent's pane, with the agent's own line wrapping undone.
 *
 * Claude Code and Codex wrap their text themselves, at the width they were given: each wrapped row
 * ends in a real newline and the next starts with the block's indent, so xterm, which joins only
 * the rows it wrapped itself (isWrapped), copies a long command as two. That holds inline (room
 * sessions) and for a native (Option-drag) selection over Claude's full-screen frame alike. A
 * shell's long lines are xterm's own wraps and copy whole already.
 *
 * Nothing in the output marks a row break as a wrap, so it is read from the layout, the way the
 * agents' greedy wrapping makes it. Row B can continue row A only when:
 *  - both were printed at the same width E (trackPrintWidths), and neither runs past it;
 *  - B starts where A's text hangs: A's indent, or past A's list marker (`-`, `1.`, `⏺`, `⎿`…), or
 *    at the `(` of a tool call (`⏺ Bash(`); B doesn't start with a list marker of its own; and
 *    neither side of the break is box drawing (a frame's edge, a rule).
 * Then it is a wrap, undone with no space, when a word was cut: A fills the row to E and the
 * word across the break is longer than the block is wide (the only words cut mid-way); or, for
 * Codex, which also breaks after a `/` or a hyphen inside a word, A ends in one and B's first
 * piece (up to its own first such break) wouldn't have fitted on A.
 * Or a wrap at a space, undone with one: A holds more than one word (or continues the row above
 * it) and B's first word (Codex: its first piece) wouldn't have fitted after it, A's end + a space
 * + the word passing E. B's indent is dropped either way. Anything else is a real line break.
 * Two real lines are joined when the second's first word happens not to fit after the first (two
 * lines of code ending near the edge): the layout can't tell them from a wrap.
 */

/** One row of the terminal, as copying reads it. */
export interface WrapRow {
  /** One string per cell: " " for a blank, "" for the right half of a wide character. */
  cells: string[];
  /** xterm wrapped the row above onto this one (the terminal's own soft wrap). */
  wrapped: boolean;
  /** The width the program wrapped its text to when it printed this row. */
  width: number;
}

/** A selection end: a row of the rows given, and the cell column (the end is exclusive). */
export interface CellPos {
  row: number;
  col: number;
}

type Break = "\n" | " " | "";

const blank = (c: string | undefined) => c === " " || c === "\u00a0";
// a list item's or a transcript entry's leading glyph, when a blank follows it
const MARKER = /^(?:[-*+•◦▪‣●○◉▸►⏺⎿❯›>→✓✔✗✘✻✳⚠]|\d{1,3}[.)])$/;
const CALL_NAME = /^[\w.:-]$/;
// box drawing and block elements
const FRAME = /[\u2500-\u259f]/;

interface Shape {
  cells: string[];
  width: number;
  /** Past the last non-blank cell. */
  end: number;
  indent: number;
  /** The row starts with a list marker. */
  listed: boolean;
  /** Where the text after a leading list marker starts, or -1 when the row has none. */
  marked: number;
  /** Columns a continuation of this row may start at. */
  hangs: number[];
}

function shape(cells: string[], width: number): Shape {
  let end = cells.length;
  while (end > 0 && blank(cells[end - 1])) end--;
  let indent = 0;
  while (indent < end && blank(cells[indent])) indent++;
  let tokEnd = indent;
  while (tokEnd < end && !blank(cells[tokEnd])) tokEnd++;
  let after = tokEnd;
  while (after < end && blank(cells[after])) after++;
  const listed = MARKER.test(cells.slice(indent, tokEnd).join(""));
  const marked = listed && tokEnd < end ? after : -1;
  const text = marked >= 0 ? marked : indent;
  const hangs = [text];
  // a tool call's arguments hang under its "(": `⏺ Bash(git log …` continues under the "("
  let open = text;
  while (open < end && CALL_NAME.test(cells[open])) open++;
  if (open > text && cells[open] === "(") hangs.push(open);
  return { cells, width, end, indent, listed, marked, hangs };
}

/**
 * How row b follows row a: a real line break, or a wrap to undo with a space or with nothing.
 * `continued`: a itself continues the row above it, so a one-word a is the middle of a paragraph.
 */
function breakBetween(a: Shape, b: Shape, agent: AgentKind, continued: boolean): Break {
  const E = a.width;
  if (b.width !== E) return "\n";
  if (!a.end || !b.end || a.end > E || b.end > E) return "\n";
  if (b.listed || !a.hangs.includes(b.indent)) return "\n";
  // a box's edge or a rule is drawing, not text
  if (FRAME.test(a.cells[a.end - 1]) || FRAME.test(b.cells[b.indent])) return "\n";
  let lastTok = a.end;
  while (lastTok > 0 && !blank(a.cells[lastTok - 1])) lastTok--;
  let firstTok = b.indent;
  while (firstTok < b.end && !blank(b.cells[firstTok])) firstTok++;
  const firstWord = firstTok - b.indent;
  // a word longer than the block is wide starts on A, fills it, and goes on on B
  if (a.end === E && a.end - lastTok + firstWord > E - b.indent) return "";
  // up to Codex's first break after a "-" or "/" inside B's first word
  let seg = b.indent + 1;
  while (seg < firstTok && !(seg > b.indent + 1 && /[-/]/.test(b.cells[seg - 1]))) seg++;
  const firstPiece = agent === "codex" ? seg - b.indent : firstWord;
  const cut = a.cells[a.end - 1];
  if (agent === "codex" && (cut === "/" || (cut === "-" && a.end - lastTok > 1)) && a.end + firstPiece > E) return "";
  const text = Math.max(a.indent, a.marked);
  const oneWord = lastTok <= text && !continued;
  if (!oneWord && a.end + 1 + firstPiece > E) return " ";
  return "\n";
}

/**
 * The text from `start` to `end` with the agent's wraps undone, or null when there was nothing to
 * undo (copy xterm's own text then). `rows` hold whole logical lines: xterm's own wraps included.
 */
export function rejoinWraps(rows: WrapRow[], start: CellPos, end: CellPos, agent: AgentKind): string | null {
  const raw: { cells: string[]; width: number }[] = [];
  const at: { line: number; offset: number }[] = [];
  for (const r of rows) {
    const last = raw[raw.length - 1];
    if (r.wrapped && last) {
      at.push({ line: raw.length - 1, offset: last.cells.length });
      last.cells.push(...r.cells);
    } else {
      at.push({ line: raw.length, offset: 0 });
      raw.push({ cells: [...r.cells], width: r.width });
    }
  }
  const s = at[start.row];
  const e = at[end.row];
  if (!s || !e) return null;
  const lines = raw.map((l) => shape(l.cells, l.width));
  const breaks: Break[] = [];
  for (let i = s.line; i < e.line; i++) breaks.push(breakBetween(lines[i], lines[i + 1], agent, i > s.line && breaks[breaks.length - 1] !== "\n"));
  if (breaks.every((b) => b === "\n")) return null;
  let out = "";
  for (let i = s.line; i <= e.line; i++) {
    const l = lines[i];
    const brk = i > s.line ? breaks[i - s.line - 1] : "\n";
    let from = i === s.line ? s.offset + start.col : 0;
    if (brk !== "\n") from = Math.max(from, l.indent);
    const to = i === e.line ? e.offset + end.col : l.cells.length;
    const text = l.cells.slice(from, to).join("").replace(/\u00a0/g, " ").trimEnd();
    if (i > s.line && (brk === "\n" || (text && out))) out += brk;
    out += text;
  }
  return out;
}

/** Buffer rows `from` to `to` (inclusive), as copying reads them. */
export function bufferRows(buffer: IBuffer, from: number, to: number, widthAt: (line: number) => number): WrapRow[] {
  const rows: WrapRow[] = [];
  let cell: IBufferCell | undefined;
  for (let y = from; y <= to; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    const cells: string[] = [];
    for (let x = 0; x < line.length; x++) {
      cell = line.getCell(x, cell);
      if (!cell) break;
      cells.push(cell.getWidth() === 0 ? "" : cell.getChars() || " ");
    }
    rows.push({ cells, wrapped: line.isWrapped, width: widthAt(y) });
  }
  return rows;
}

/**
 * The active buffer's text from `start` to `end` (0-based cell and row, the end exclusive) with
 * the agent's wraps undone, or null when there were none: copy xterm's own text then.
 */
export function agentText(buffer: IBuffer, start: { x: number; y: number }, end: { x: number; y: number }, agent: AgentKind, widthAt: (line: number) => number): string | null {
  let first = start.y;
  let last = end.y;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  while (buffer.getLine(last + 1)?.isWrapped) last++;
  const rows = bufferRows(buffer, first, last, widthAt);
  return rejoinWraps(rows, { row: start.y - first, col: start.x }, { row: end.y - first, col: end.x }, agent);
}

/** The terminal's selection with the agent's wraps undone, or null when there were none or there's no selection. */
export function agentSelection(term: Terminal, agent: AgentKind, widthAt: (line: number) => number): string | null {
  // xterm reports its model's selection: 0-based, the end exclusive (its typings say 1-based)
  const pos = term.getSelectionPosition();
  return pos ? agentText(term.buffer.active, pos.start, pos.end, agent, widthAt) : null;
}

/**
 * What width each row of the normal screen was printed at, from the terminal's resizes. Claude
 * Code and Codex reprint their transcript from the top of the screen when the width changes, so
 * rows from there on are at the new width; rows above keep the width they were printed at, though
 * xterm reflows them. Output from before this terminal existed (a replay) counts as printed at the
 * width it was replayed at. A full reset starts over at the current width. The alternate screen is
 * redrawn at every resize, so all of it is at the terminal's width.
 */
export function trackPrintWidths(term: Terminal): (line: number) => number {
  let base = term.cols;
  let recorded = term.cols;
  let changes: { top: IMarker; cols: number }[] = [];
  const note = () => {
    if (term.buffer.active.type !== "normal" || term.cols === recorded) return;
    recorded = term.cols;
    // changes scrolled out of the scrollback leave their width to the rows after them
    while (changes.length && changes[0].top.isDisposed) base = changes.shift()!.cols;
    const top = term.registerMarker(-term.buffer.active.cursorY);
    if (top) changes.push({ top, cols: recorded });
    else base = recorded;
  };
  term.onResize(note);
  term.buffer.onBufferChange(note);
  // RIS (ESC c) empties the buffer but leaves markers where they were
  term.parser.registerEscHandler({ final: "c" }, () => {
    for (const c of changes) c.top.dispose();
    changes = [];
    base = recorded = term.cols;
    return false;
  });
  return (line) => {
    if (term.buffer.active.type !== "normal") return term.cols;
    let width = base;
    for (const c of changes) {
      if (!c.top.isDisposed && line < c.top.line) break;
      width = c.cols;
    }
    return width;
  };
}
