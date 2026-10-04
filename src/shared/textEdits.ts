/**
 * LSP text edits on plain text. Positions are a line and a UTF-16 column (the
 * protocol's default, and JavaScript's string indexing); a line ends at
 * "\r\n", "\r" or "\n", none of which the column counts.
 */
export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

/** Where each line starts in `text`. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) starts.push(i + 1);
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

/** A position as an offset into `text`; a column past the line's end lands at its end. */
export function offsetAt(text: string, starts: number[], p: LspPosition): number {
  if (p.line >= starts.length) return text.length;
  const lineStart = starts[p.line];
  let lineEnd = p.line + 1 < starts.length ? starts[p.line + 1] : text.length;
  while (lineEnd > lineStart && (text.charCodeAt(lineEnd - 1) === 10 || text.charCodeAt(lineEnd - 1) === 13)) lineEnd--;
  return Math.min(lineStart + Math.max(0, p.character), lineEnd);
}

/**
 * Apply edits (from one response, so they don't overlap) to `text`. Edits at
 * the same place apply in the order given, as the protocol says, so they're
 * applied back to front with later ones first.
 */
export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  const starts = lineStarts(text);
  const spans = edits
    .map((e, i) => ({ i, from: offsetAt(text, starts, e.range.start), to: offsetAt(text, starts, e.range.end), insert: e.newText }))
    .sort((a, b) => b.from - a.from || b.i - a.i);
  let out = text;
  for (const s of spans) out = out.slice(0, s.from) + s.insert + out.slice(s.to);
  return out;
}
