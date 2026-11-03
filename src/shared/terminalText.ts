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

/** Box-drawing characters: frames, rules and the sides of an input box. */
const BOX = /[\u2500-\u257f]/g;
/** A line that is only a rule, or a box's top or bottom edge. */
const RULE = /^[\s\u2500-\u257f]*[\u2500-\u257f]{8,}[\s\u2500-\u257f]*$/;
/** How far up from an agent's last line its prompt box (or the rule over its input) may start. */
const FRAME_ROWS = 14;

/** The lowest rule from `from` up, at most FRAME_ROWS lines up; -1 when there's none. */
function ruleAbove(lines: readonly string[], from: number): number {
  for (let y = from; y >= 0 && y > from - FRAME_ROWS; y--) if (RULE.test(lines[y])) return y;
  return -1;
}

/**
 * The last line of a terminal's output worth showing on its own (a landscape card's "what it did" line): the
 * newest with a letter or a digit in it, so blank lines, spinner-only lines (a frame of Claude Code's ✻ or a
 * braille spinner), rules and empty boxes are passed over. For an agent, its CLI's own frame at the bottom (the
 * prompt box or the rules around its input, and the hints under it) is left out first, so the line is the
 * agent's output rather than its prompt. Box sides around the line are trimmed off; null when nothing qualifies.
 */
export function lastMeaningfulLine(lines: readonly string[], o: { agent?: boolean } = {}): string | null {
  let end = lines.length;
  if (o.agent) {
    let last = end - 1;
    while (last >= 0 && !lines[last].trim()) last--;
    // the lowest rule near the bottom ends the output, or the one over it when the input sits between two
    const low = ruleAbove(lines, last);
    if (low >= 0) {
      const top = ruleAbove(lines, low - 1);
      end = top >= 0 ? top : low;
    }
  }
  for (let y = end - 1; y >= 0; y--) {
    const text = lines[y].replace(/^[\s\u2500-\u257f]+|[\s\u2500-\u257f]+$/g, "");
    if (/[\p{L}\p{N}]/u.test(text.replace(BOX, ""))) return text;
  }
  return null;
}
