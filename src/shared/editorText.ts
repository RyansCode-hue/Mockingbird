/**
 * What a file's text needs kept as it was when the editor saves it: a UTF-8
 * byte-order mark (common in C# files) and Windows line endings — the editor
 * works in "\n", and a save that silently converted them would rewrite every
 * line in the diff.
 */
export function splitBom(text: string): { bom: boolean; text: string } {
  return text.charCodeAt(0) === 0xfeff ? { bom: true, text: text.slice(1) } : { bom: false, text };
}

export type LineBreak = "\r\n" | "\n" | "\r";

/** The file's most common line break ("\n" when there are none, or a tie with it). */
export function lineBreakOf(text: string): LineBreak {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const cr = (text.match(/\r/g) ?? []).length - crlf;
  if (cr > lf && cr > crlf) return "\r";
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * The text in the editor's "\n" form. Every break CodeMirror splits lines at
 * ("\r\n", a lone "\r", "\n") becomes "\n", so the buffer's text and the text
 * it's compared with for unsaved changes are the same.
 */
export const toEditorText = (text: string) => text.replace(/\r\n?/g, "\n");

/** The indentation the file already uses: a tab, or the most common step of leading spaces (2 or 4). */
export function guessIndent(text: string): string {
  let tabs = 0;
  const steps: Record<number, number> = {};
  let prev = 0;
  for (const line of text.split("\n").slice(0, 2000)) {
    if (!line.trim()) continue;
    if (line.startsWith("\t")) {
      tabs++;
      continue;
    }
    const n = line.length - line.trimStart().length;
    const d = Math.abs(n - prev);
    if (d === 2 || d === 4) steps[d] = (steps[d] ?? 0) + 1;
    prev = n;
  }
  const spaces = (steps[2] ?? 0) + (steps[4] ?? 0);
  if (tabs > spaces) return "\t";
  return (steps[2] ?? 0) > (steps[4] ?? 0) ? "  " : "    ";
}

/** The file's text as saved: the editor's lines joined with the file's own line break, its BOM restored. */
export function toFileText(lines: string, lineBreak: LineBreak, bom: boolean): string {
  const body = lineBreak === "\n" ? lines : lines.replace(/\n/g, lineBreak);
  return bom ? `﻿${body}` : body;
}
