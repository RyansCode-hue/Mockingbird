/**
 * Terminal output as plain lines, for showing outside a terminal (a dead
 * pane's last words). Escape sequences are dropped, but moves along a line
 * are kept as the gaps they leave: Claude Code's renderer writes the spaces
 * between words as cursor moves (`ESC[<col>G`), so dropping those runs the
 * words together. Moves to other lines aren't followed: what's redrawn there
 * shows up as more lines.
 */
export function terminalLines(raw: string): string[] {
  const lines: string[] = [];
  let line: string[] = [];
  let col = 0;
  const put = (ch: string) => {
    while (line.length < col) line.push(" ");
    line[col++] = ch;
  };
  const csi = /^\x1b\[([0-9;?<>=]*)([ -\/]*)([@-~])/;
  const other = /^(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1bP[^\x1b]*(?:\x1b\\)?|\x1b[()][A-Za-z0-9]?|\x1b[^[\]P()])/;
  for (let i = 0; i < raw.length; ) {
    const ch = raw[i];
    if (ch === "\x1b") {
      const rest = raw.slice(i, i + 256);
      const m = csi.exec(rest);
      if (m) {
        const n = parseInt(m[1], 10);
        const count = Number.isFinite(n) && n > 0 ? n : 1;
        if (!m[1].startsWith("?") && !m[2]) {
          if (m[3] === "G") col = count - 1; // to column n
          else if (m[3] === "C") col += count; // n to the right
          else if (m[3] === "D") col = Math.max(0, col - count); // n to the left
          else if (m[3] === "K" && (m[1] === "" || m[1] === "0")) line.length = Math.min(line.length, col); // the rest of the line erased
        }
        i += m[0].length;
        continue;
      }
      const o = other.exec(rest);
      i += o ? o[0].length : 1;
      continue;
    }
    i++;
    if (ch === "\n") {
      lines.push(line.join("").trimEnd());
      line = [];
      col = 0;
    } else if (ch === "\r") col = 0;
    else if (ch === "\b") col = Math.max(0, col - 1);
    else if (ch === "\t") col = (Math.floor(col / 8) + 1) * 8;
    else if (ch >= " " && ch !== "\x7f") put(ch);
  }
  lines.push(line.join("").trimEnd());
  return lines;
}
