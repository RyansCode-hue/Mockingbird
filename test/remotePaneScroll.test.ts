import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { mousePolicyFor, stripMouseEnables } from "../src/renderer/mouseModes";
import { hasOwnHistory, pageKey, scrollCopy, wheelLines } from "../src/renderer/paneScroll";

// A teammate's session (team rooms) is a copy of its owner's terminal: whatever
// the copy's terminal sends is typed into the owner's session.

const parsed = (term: Terminal, data = "") => new Promise<void>((r) => term.write(data, r));
const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${from + i}`).join("\r\n") + "\r\n";

// how the agent TUIs start: Claude Code's fullscreen view, and Codex (alternate screen, pointer capture, alternate scroll)
const CLAUDE_STARTUP = "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";
const CODEX_STARTUP = "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1003h\x1b[?1007h";

/** A copy's terminal fed what the owner's program printed, through the pane's mouse policy; and what it would send. */
async function copyOf(policy: ReturnType<typeof mousePolicyFor>, ...output: string[]) {
  const e = { mousePolicy: policy, carry: "", wantsMouse: false, tracking: 0, buttonHeld: false };
  const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 10, scrollback: 1000 });
  const sent: string[] = [];
  term.onData((d) => sent.push(d));
  for (const o of output) await parsed(term, stripMouseEnables(e, o));
  return { e, term, sent };
}

describe("a teammate's pane and the mouse", () => {
  it("is never given mouse tracking, whatever the owner's program asks for, so the wheel and clicks can't become reports", async () => {
    expect(mousePolicyFor({ agent: "claude" }, true)).toBe("remote");
    expect(mousePolicyFor({ agent: "codex" }, true)).toBe("remote");
    expect(mousePolicyFor({ shell: true }, true)).toBe("remote");
    for (const startup of [CLAUDE_STARTUP, CODEX_STARTUP, "\x1b[?1049;1000;1006h", "\x1b[?9h"]) {
      const { e, term } = await copyOf(mousePolicyFor({ agent: "claude" }, true), startup);
      expect(term.modes.mouseTrackingMode, JSON.stringify(startup)).toBe("none");
      // nor does the pane deliver the wheel or a click on the program's behalf
      expect(e.wantsMouse).toBe(false);
    }
  });

  it("still shows the owner's full-screen program on the alternate screen, drawn as it draws it", async () => {
    const { term } = await copyOf("remote", lines(30), CLAUDE_STARTUP, "\x1b[H\x1b[2J\x1b[3;5Hthe transcript\x1b[10;1H> prompt");
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.buffer.active.getLine(2)?.translateToString(true)).toBe("    the transcript");
    expect(term.buffer.active.getLine(9)?.translateToString(true)).toBe("> prompt");
  });

  it("leaves the owner's own pane as it was: Claude Code still gets presses, drags and the wheel", async () => {
    const { e, term } = await copyOf(mousePolicyFor({ agent: "claude" }), CLAUDE_STARTUP);
    expect(term.modes.mouseTrackingMode).toBe("drag");
    expect(e.wantsMouse).toBe(true);
  });
});

/** The terminal as scrollCopy sees it, recording the scrolls (an unopened xterm scrolls only through its DOM viewport). */
const viewOf = (term: Terminal) => {
  const scrolled: number[] = [];
  return { scrolled, view: { buffer: term.buffer, options: term.options, scrollLines: (n: number) => void scrolled.push(n) } };
};
/** Scroll as the viewport does when the person scrolls it (xterm's ScrollSource.VIEWPORT). */
const userScroll = (term: Terminal, n: number) => (term as unknown as { _core: { scrollLines(n: number, quiet: boolean, source: number): void } })._core.scrollLines(n, false, 1);

describe("scrolling a teammate's pane", () => {
  it("scrolls the copy's own history, and its terminal sends nothing", async () => {
    const { term, sent } = await copyOf("remote", lines(50));
    const { view, scrolled } = viewOf(term);
    expect(scrollCopy(view, -5)).toBe("scrolled");
    expect(scrollCopy(view, 2)).toBe("scrolled");
    expect(scrolled).toEqual([-5, 2]);
    expect(sent).toEqual([]);
  });

  it("stays where the viewer scrolled to while the owner's output keeps coming", async () => {
    const { term } = await copyOf("remote", lines(50));
    userScroll(term, -10);
    const at = term.buffer.active.viewportY;
    expect(at).toBe(term.buffer.active.baseY - 10);
    const top = term.buffer.active.getLine(at)?.translateToString(true);
    await parsed(term, lines(20, 51));
    expect(term.buffer.active.viewportY).toBe(at);
    expect(term.buffer.active.getLine(term.buffer.active.viewportY)?.translateToString(true)).toBe(top);
    expect(term.buffer.active.baseY).toBeGreaterThan(at + 10);
  });

  it("has nothing to scroll on the alternate screen: the full-screen program keeps its history on the owner's screen", async () => {
    const { term, sent } = await copyOf("remote", lines(50), CODEX_STARTUP, "frame");
    const { view, scrolled } = viewOf(term);
    expect(hasOwnHistory(term)).toBe(false);
    expect(scrollCopy(view, -3)).toBe("full-screen");
    expect(scrolled).toEqual([]);
    expect(sent).toEqual([]);
    // back on the normal screen, its history is there to scroll again
    await parsed(term, "\x1b[?1049l");
    expect(scrollCopy(view, -3)).toBe("scrolled");
    expect(scrolled).toEqual([-3]);
  });

  it("pages with PageUp and PageDown, Shift or not; Ctrl+PageUp/PageDown stay keys for the program", () => {
    const key = (k: string, ctrlKey = false) => ({ key: k, ctrlKey });
    expect(pageKey(key("PageUp"))).toBe(-1);
    expect(pageKey(key("PageDown"))).toBe(1);
    expect(pageKey(key("PageUp", true))).toBe(0);
    expect(pageKey(key("ArrowUp"))).toBe(0);
    expect(pageKey(key("a"))).toBe(0);
  });
});

describe("wheel to lines", () => {
  it("adds a trackpad's small pixel deltas up to whole lines and carries the rest", () => {
    const acc = { wheelAcc: 0 };
    const px = (deltaY: number) => wheelLines(acc, { deltaY, deltaMode: 0 }, 16, 160);
    expect([px(6), px(6), px(6), px(30)]).toEqual([0, 0, 1, 2]);
    expect(acc.wheelAcc).toBe(0);
    expect(px(-10)).toBe(0); // a change of direction starts over
    expect(px(-10)).toBe(-1);
  });
  it("takes line and page deltas as they come", () => {
    expect(wheelLines({ wheelAcc: 0 }, { deltaY: 3, deltaMode: 1 }, 16, 160)).toBe(3);
    expect(wheelLines({ wheelAcc: 0 }, { deltaY: -1, deltaMode: 2 }, 16, 160)).toBe(-10);
  });
});
