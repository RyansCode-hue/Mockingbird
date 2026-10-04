/**
 * What a file's text needs kept as it was when the editor saves it: a UTF-8
 * byte-order mark (common in C# files) and Windows line endings — the editor
 * works in "\n", and a save that silently converted them would rewrite every
 * line in the diff.
 */
export function splitBom(text: string): { bom: boolean; text: string } {
  return text.charCodeAt(0) === 0xfeff ? { bom: true, text: text.slice(1) } : { bom: false, text };
}

/** "\r\n" when most line breaks are, else "\n". */
export function lineBreakOf(text: string): "\r\n" | "\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

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
export function toFileText(lines: string, lineBreak: "\r\n" | "\n", bom: boolean): string {
  const body = lineBreak === "\n" ? lines : lines.replace(/\n/g, "\r\n");
  return bom ? `﻿${body}` : body;
}
