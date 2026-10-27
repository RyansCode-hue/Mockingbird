import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { agentText, rejoinWraps, trackPrintWidths, type WrapRow } from "../src/renderer/agentWraps";
import type { AgentKind } from "../src/shared/types";

// Fixtures are real pty output, a resumed conversation replayed with no account in a throwaway HOME:
// Claude Code 2.1.311 inline (CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1) at 60 and 100 columns and full
// screen at 60, and Codex 0.156.1 inline (tui.alternate_screen="never") at 60.
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures", "agentWraps", `${name}.txt`), "utf8");
const written = (term: Terminal, data: string) => new Promise<void>((r) => term.write(data, r));

async function terminal(cols: number, rows: number, data = "") {
  const term = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 1000 });
  const widthAt = trackPrintWidths(term);
  if (data) await written(term, data);
  return { term, widthAt };
}

const rowText = (term: Terminal, y: number) => term.buffer.active.getLine(y)?.translateToString(false) ?? "";

/** What xterm's own selection copies: rows as drawn, joined only where xterm wrapped them. */
function xtermCopy(term: Terminal, start: { x: number; y: number }, end: { x: number; y: number }): string {
  const b = term.buffer.active;
  const out: string[] = [];
  for (let y = start.y; y <= end.y; y++) {
    const line = b.getLine(y)!;
    const text = line.translateToString(true, y === start.y ? start.x : 0, y === end.y ? end.x : undefined).replace(/ /g, " ");
    if (line.isWrapped && out.length) out[out.length - 1] += text;
    else out.push(text);
  }
  return out.join("\n");
}

/** Select from where `from` starts to where `to` ends (the first rows holding them, `to` at or after `from`), and copy as an agent pane does. */
function copy(t: { term: Terminal; widthAt: (y: number) => number }, agent: AgentKind, from: string, to: string): string {
  const b = t.term.buffer.active;
  let y0 = 0;
  while (y0 < b.length && !rowText(t.term, y0).includes(from)) y0++;
  let y1 = y0;
  while (y1 < b.length && !rowText(t.term, y1).includes(to)) y1++;
  if (y1 >= b.length) throw new Error(`no rows hold "${from}" … "${to}"`);
  const start = { x: rowText(t.term, y0).indexOf(from), y: y0 };
  const end = { x: rowText(t.term, y1).indexOf(to) + to.length, y: y1 };
  return agentText(b, start, end, agent, t.widthAt) ?? xtermCopy(t.term, start, end);
}

function copyAll(t: { term: Terminal; widthAt: (y: number) => number }, agent: AgentKind): string {
  const b = t.term.buffer.active;
  const start = { x: 0, y: 0 };
  const end = { x: t.term.cols, y: b.length - 1 };
  return (agentText(b, start, end, agent, t.widthAt) ?? xtermCopy(t.term, start, end)).replace(/\n+$/, "");
}

const PATH = "/private/tmp/claude-501/-Users-alex-Code-backoffice-portal/1234abcd-5678-90ef-aaaa-bbbbccccdddd/scratchpad/add-portal-users-keys.sh";
const SENTENCE = "That script reads every portal user from the database, generates a key pair for each one that doesn't have one yet, and writes the public half back so the next login picks it up";
const BASH_CALL = "⏺ Bash(git log --oneline -3 && grep -n getSelection src/renderer/TerminalPane.tsx /private/tmp/claude-501/-Users-alex-Code-backoffice-portal/scratchpad/x)";

describe("why an agent's text copies with line breaks", () => {
  it("the agents break their own lines, so xterm sees no wraps of its own and copies the rows as drawn", async () => {
    for (const [name, cols, rows] of [["claude-inline-60", 60, 50], ["claude-full-60", 60, 60], ["codex-inline-60", 60, 40]] as const) {
      const { term } = await terminal(cols, rows, fixture(name));
      const b = term.buffer.active;
      for (let y = 0; y < b.length; y++) expect(b.getLine(y)!.isWrapped, `${name} row ${y}`).toBe(false);
      const y0 = [...Array(b.length).keys()].find((y) => rowText(term, y).includes("bash /private"))!;
      const y1 = [...Array(b.length).keys()].find((y) => rowText(term, y).includes("keys.sh"))!;
      expect(y1 - y0, name).toBe(2);
      expect(xtermCopy(term, { x: 0, y: y0 }, { x: cols, y: y1 }).split("\n"), name).toHaveLength(3);
    }
  });

  it("a shell's long line is xterm's own wrap: xterm copies it whole, and there is nothing to undo", async () => {
    const t = await terminal(60, 10, `$ echo ${PATH}\r\n`);
    expect(t.term.buffer.active.getLine(1)!.isWrapped).toBe(true);
    expect(xtermCopy(t.term, { x: 0, y: 0 }, { x: 60, y: 2 })).toBe(`$ echo ${PATH}`);
    expect(agentText(t.term.buffer.active, { x: 0, y: 0 }, { x: 60, y: 2 }, "claude", t.widthAt)).toBeNull();
  });
});

describe("copying from an agent's pane", () => {
  it("Claude Code inline at 60 columns: its wraps are undone, its real line breaks kept", async () => {
    const t = await terminal(60, 50, fixture("claude-inline-60"));
    expect(copyAll(t, "claude").split("\n")).toEqual([
      " ▐▛███▛█   Claude Code v2.1.311",
      "▝▜██████▀  Opus 4.5 · API Usage Billing",
      " ▝▝   ▝▝   /…/scratchpad/cc/proj",
      "",
      "⚠ Remote managed settings failed to load (authentication rejected (401)) · no remote policy applied · /status for details",
      "",
      // the prompt's box ends short of the pane's edge, so its wrap reads as a real break: kept
      "❯ How do I add the keys? Please explain it in some detail",
      "  so that the answer wraps.",
      "",
      BASH_CALL,
      // a tool's output box ends short of the edge too: the wrap before "for" is kept
      "  ⎿  e3e7ee1 Tests: the real .NET debug test gives the service a TMPDIR, which the SDK's first run needs",
      "     for its lock",
      "     … +5 lines (ctrl+o to expand)",
      "",
      "⏺ Run this to add the portal users' keys:",
      "",
      `  ! bash ${PATH}`,
      "",
      `  ${SENTENCE} without anyone needing to restart the service.`,
      "",
      "  - first bullet that is long enough to wrap across the pane width when it is narrow",
      "  - second bullet",
      "",
      "  1. Stop the portal service before running it, because the keys are cached in memory",
      "  2. Start it again",
      "",
      "  export FOO=bar",
      "  npm run build -- --mode production --out-dir /private/tmp/somewhere/really/long/for/this/example",
      "",
      "────────────────────────────────────────────────────────────",
      "❯",
      "────────────────────────────────────────────────────────────",
      "  ⏸ manual mode on · ? for shortcuts · ← for agents",
      "                                          ● high · /effort",
    ]);
  });

  it("Claude Code copies the same text at 100 columns as at 60, and full screen (an Option-drag) as inline", async () => {
    const pieces = (t: Awaited<ReturnType<typeof terminal>>) => [
      copy(t, "claude", "! bash", "keys.sh"),
      copy(t, "claude", "That script", "service."),
      copy(t, "claude", "- first", "narrow"),
      copy(t, "claude", "1. Stop", "memory"),
      copy(t, "claude", "npm run", "example"),
    ];
    const at60 = pieces(await terminal(60, 50, fixture("claude-inline-60")));
    expect(at60).toEqual([`! bash ${PATH}`, `${SENTENCE} without anyone needing to restart the service.`, "- first bullet that is long enough to wrap across the pane width when it is narrow", "1. Stop the portal service before running it, because the keys are cached in memory", "npm run build -- --mode production --out-dir /private/tmp/somewhere/really/long/for/this/example"]);
    const wide = await terminal(100, 50, fixture("claude-inline-100"));
    expect(pieces(wide)).toEqual(at60);
    expect(copy(wide, "claude", "⏺ Bash", "/x)")).toBe(BASH_CALL);
    const full = await terminal(60, 60, fixture("claude-full-60"));
    expect(full.term.buffer.active.type).toBe("alternate");
    expect(pieces(full)).toEqual(at60);
  });

  it("Codex inline: its breaks after a hyphen or a slash join with no space, its word wraps with one", async () => {
    const t = await terminal(60, 40, fixture("codex-inline-60"));
    const all = copyAll(t, "codex").split("\n");
    expect(all).toContain("  Tip: NEW: Network proxy can now be enabled from /experimental. Restart Codex after enabling it.");
    expect(all).toContain(`  bash ${PATH}`);
    expect(all).toContain(`  ${SENTENCE}.`);
    expect(all).toContain("  - first bullet that is long enough to wrap across the pane width when it is narrow");
    // its header box stays a box
    expect(all.slice(1, 7)).toEqual([
      "╭─────────────────────────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.156.1)                              │",
      "│                                                         │",
      "│ model:     GPT-6-Astra   /model to change               │",
      "│ directory: /private/tmp/claude-501/…/scratchpad/cc/proj │",
      "╰─────────────────────────────────────────────────────────╯",
    ]);
    expect(all).toContain("  - second bullet");
  });

  it("copies only what's selected: from the middle of a row to the middle of a later one", async () => {
    const t = await terminal(60, 50, fixture("claude-inline-60"));
    expect(copy(t, "claude", "/private/tmp/claude-501/-Users-alex", "d-portal-users")).toBe(PATH.replace(/-keys\.sh$/, ""));
    expect(copy(t, "claude", "database,", "public half")).toBe("database, generates a key pair for each one that doesn't have one yet, and writes the public half");
    // a selection inside one row has nothing to undo
    expect(agentText(t.term.buffer.active, { x: 2, y: 21 }, { x: 10, y: 21 }, "claude", t.widthAt)).toBeNull();
  });
});

// wrap-ansi's word wrap with { hard: true }, which Ink's Text uses at its box's width: greedy at
// spaces, and a word longer than the box cut at its edge (started on the current row when that
// doesn't cost a row)
function inkWrap(text: string, columns: number): string[] {
  const rows = [""];
  text.split(" ").forEach((word, i) => {
    rows[rows.length - 1] = rows[rows.length - 1].trimStart();
    let used = rows[rows.length - 1].length;
    if (i > 0 && used > 0) {
      rows[rows.length - 1] += " ";
      used++;
    }
    if (word.length > columns) {
      const thisRow = 1 + Math.floor((word.length - (columns - used) - 1) / columns);
      const nextRow = Math.floor((word.length - 1) / columns);
      if (nextRow < thisRow) rows.push("");
      let visible = rows[rows.length - 1].length;
      [...word].forEach((ch, k) => {
        if (visible + 1 <= columns) rows[rows.length - 1] += ch;
        else {
          rows.push(ch);
          visible = 0;
        }
        visible++;
        if (visible === columns && k < word.length - 1) {
          rows.push("");
          visible = 0;
        }
      });
      return;
    }
    if (used + word.length > columns && used > 0 && word.length > 0) rows.push("");
    rows[rows.length - 1] += word;
  });
  return rows.map((r) => r.trimEnd());
}

/** A Claude-style block: `text` wrapped at the pane's width less its indent and marker, continuation rows hanging under the text. */
function block(text: string, cols: number, indent: number, marker = ""): string[] {
  const hang = " ".repeat(indent + marker.length);
  return inkWrap(text, cols - hang.length).map((r, i) => (i ? hang : " ".repeat(indent) + marker) + r);
}

const rowsOf = (lines: string[], cols: number): WrapRow[] => lines.map((l) => ({ cells: [...l.padEnd(cols)], wrapped: false, width: cols }));
const copyRows = (lines: string[], cols: number, agent: AgentKind = "claude") =>
  rejoinWraps(rowsOf(lines, cols), { row: 0, col: 0 }, { row: lines.length - 1, col: cols }, agent) ?? lines.map((l) => l.trimEnd()).join("\n");

describe("undoing Ink's wraps at any width", () => {
  const cases: [string, number, string][] = [
    [`! bash ${PATH}`, 2, ""],
    [`${SENTENCE}, without anyone needing to restart the service.`, 2, ""],
    ["Run the script at /private/tmp/claude-501/scratchpad/add-portal-users-keys.sh once the service is stopped, then start it again.", 2, ""],
    ["first bullet that is long enough to wrap across the pane width when it is narrow", 2, "- "],
    ["Stop the portal service before running it, because the keys are cached in memory", 2, "12. "],
    ["e3e7ee1 Tests: the real .NET debug test gives the service a TMPDIR, which the SDK's first run needs for its lock", 2, "⎿  "],
    // a tool call's arguments hang under its "("
    ["(git log --oneline -3 && grep -n getSelection src/renderer/TerminalPane.tsx)", 0, "⏺ Bash"],
  ];
  for (const [text, indent, marker] of cases) {
    it(`gives back "${(marker + text).slice(0, 40)}…" from 30 to 160 columns`, () => {
      const wrong: string[] = [];
      for (let cols = 30; cols <= 160; cols++) {
        // a word exactly as wide as the block reads as cut (pinned below)
        if (text.split(" ").some((w) => w.length === cols - indent - marker.length)) continue;
        const lines = block(text, cols, indent, marker);
        const got = copyRows(lines, cols);
        if (got !== " ".repeat(indent) + marker + text) wrong.push(`${cols}: ${JSON.stringify(got)}`);
      }
      expect(wrong).toEqual([]);
    });
  }

  it("keeps the real line breaks of code, lists, listings and short lines, narrow and wide", () => {
    for (const cols of [40, 60, 120]) {
      const code = ["  ```", "  export FOO=bar", "  if [ -n \"$FOO\" ]; then", "    echo \"$FOO\"", "  fi", "  ```"];
      expect(copyRows(code, cols), `code at ${cols}`).toBe(code.join("\n"));
      const list = ["  - first", "  - second item", "    - nested", "  1. one", "  2. two"];
      expect(copyRows(list, cols), `list at ${cols}`).toBe(list.join("\n"));
      const listing = ["  ⎿  src/renderer/agentWraps.ts", "     test/fixtures/agentWraps/claude-inline-60.txt", "     src/renderer/TerminalPane.tsx"];
      expect(copyRows(listing, cols), `listing at ${cols}`).toBe(listing.join("\n"));
      const short = ["⏺ Done.", "", "  Two short lines", "  stay two."];
      expect(copyRows(short, cols), `short at ${cols}`).toBe(short.join("\n"));
    }
  });

  it("joins only rows hanging at the same place: a deeper or shallower next row is a new line", () => {
    const cols = 40;
    const deeper = ["  if (thisConditionIsLong && thatOneToo)", "      return somethingElseEntirely;"];
    expect(copyRows(deeper, cols)).toBe(deeper.join("\n"));
    const shallower = ["    a line that runs right up to the edge", "  next"];
    expect(copyRows(shallower, cols)).toBe(shallower.join("\n"));
  });

  // the limits of reading wraps from the layout, pinned so a change to them is deliberate
  it("joins two real lines when the second's first word wouldn't have fitted after the first: the layout can't tell them apart", () => {
    expect(copyRows(["  const total = items.reduce((a, b) => a + b, 0);", "  return total;"], 52)).toBe("  const total = items.reduce((a, b) => a + b, 0); return total;");
  });

  it("reads a word exactly as wide as its block, filling its row, as a word cut there", () => {
    const path = "/private/tmp/claude-501/scratchpad/add-portal-users-keys.sh";
    const lines = block(`Run the script at ${path} once the service is stopped.`, path.length + 2, 2);
    expect(lines[1]).toBe(`  ${path}`);
    expect(copyRows(lines, path.length + 2)).toBe(`  Run the script at ${path}once the service is stopped.`);
  });
});

describe("the width a row was printed at", () => {
  it("rows printed before a resize keep their width, through xterm reflowing them narrower or leaving them wider", async () => {
    // the agents reprint from the top of the screen at the new width; what scrolled off stays as printed
    const reprint = (cols: number) => "\x1b[H\x1b[J" + block(SENTENCE, cols, 2).join("\r\n") + "\r\n";
    const t = await terminal(60, 6, block(SENTENCE, 60, 2).join("\r\n") + "\r\n" + "\r\n".repeat(6));
    const expected = `  ${SENTENCE}`;
    expect(copy(t, "claude", "That", "picks it up")).toBe(SENTENCE);
    t.term.resize(40, 6); // xterm reflows the 60-column rows in the scrollback
    await written(t.term, reprint(40));
    expect(t.term.buffer.active.getLine(1)!.isWrapped).toBe(true);
    expect(t.widthAt(0)).toBe(60);
    expect(copyAll(t, "claude").split("\n").filter(Boolean)).toEqual([expected, expected]);
    await written(t.term, "\r\n".repeat(6)); // later output scrolls the 40-column copy off the screen
    t.term.resize(100, 6);
    await written(t.term, reprint(100));
    expect(copyAll(t, "claude").split("\n").filter(Boolean)).toEqual([expected, expected, expected]);
  });

  it("a full reset starts over at the current width, and the alternate screen is always at the terminal's", async () => {
    const t = await terminal(60, 6, "old\r\n".repeat(3));
    t.term.resize(80, 6);
    await written(t.term, "\x1bc" + block(SENTENCE, 80, 2).join("\r\n"));
    expect(t.widthAt(0)).toBe(80);
    expect(copyAll(t, "claude")).toBe(`  ${SENTENCE}`);
    await written(t.term, "\x1b[?1049h");
    t.term.resize(50, 6);
    expect(t.widthAt(0)).toBe(50);
  });
});
