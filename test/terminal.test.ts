import { describe, expect, it } from "vitest";
import { mousePolicyFor, selectsNatively, stripMouseEnables, type MousePolicy } from "../src/renderer/mouseModes";
import { classifyTermInput, pasteRoute } from "../src/renderer/inputGuard";

const pane = (mousePolicy: MousePolicy = "agent") => ({ mousePolicy, carry: "", wantsMouse: false, tracking: 0, buttonHeld: false });

// Claude Code 2.1.289's fullscreen TUI, as it starts up
const CLAUDE_STARTUP = "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";

describe("mouse mode tracking", () => {
  it("starts without mouse mode, so the wheel scrolls the pane's own history", () => {
    const e = pane();
    expect(stripMouseEnables(e, "plain output\r\n")).toBe("plain output\r\n");
    expect(e.wantsMouse).toBe(false);
  });
  it("records a CLI's mouse request and keeps it from the terminal, so selection keeps working", () => {
    const e = pane();
    expect(stripMouseEnables(e, "a\x1b[?1000h\x1b[?1006hb")).toBe("ab");
    expect(e.wantsMouse).toBe(true);
  });
  it("drops back when the CLI turns mouse tracking off", () => {
    const e = { ...pane(), wantsMouse: true };
    stripMouseEnables(e, "\x1b[?1000l\x1b[?1006l");
    expect(e.wantsMouse).toBe(false);
  });
  it("leaves other private modes alone (bracketed paste, focus, sync)", () => {
    const e = pane();
    expect(stripMouseEnables(e, "\x1b[?2004h\x1b[?1004h\x1b[?2026h")).toBe("\x1b[?2004h\x1b[?1004h\x1b[?2026h");
    expect(e.wantsMouse).toBe(false);
  });
  it("keeps the other modes of a combined set, such as the alternate screen", () => {
    const e = pane();
    expect(stripMouseEnables(e, "\x1b[?1049;1000;1006;2004h")).toBe("\x1b[?1049;2004h");
    expect(e.wantsMouse).toBe(true);
  });
  it("handles a request split across two chunks", () => {
    const e = pane();
    expect(stripMouseEnables(e, "x\x1b[?10")).toBe("x");
    expect(stripMouseEnables(e, "00hy")).toBe("y");
    expect(e.wantsMouse).toBe(true);
  });
  it("withholds X10 mode and leading-zero spellings too", () => {
    const e = pane();
    expect(stripMouseEnables(e, "\x1b[?9h\x1b[?01000;2004h")).toBe("\x1b[?2004h");
    expect(e.wantsMouse).toBe(true);
  });
  it("forgets the CLI's mouse request on a full terminal reset", () => {
    const e = { ...pane(), wantsMouse: true };
    expect(stripMouseEnables(e, "\x1bc")).toBe("\x1bc");
    expect(e.wantsMouse).toBe(false);
  });
  it("passes everything through untouched in shell panes, where vim and htop own the mouse", () => {
    const e = pane("shell");
    expect(stripMouseEnables(e, "\x1b[?1000h\x1b[?1003h")).toBe("\x1b[?1000h\x1b[?1003h");
  });
});

describe("mouse modes in Claude panes", () => {
  it("gives the terminal presses, drags and SGR encoding, withholding only any-motion tracking", () => {
    const e = pane("claude");
    expect(stripMouseEnables(e, CLAUDE_STARTUP)).toBe("\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    expect(e.wantsMouse).toBe(true);
  });
  it("rewrites a combined set down to its allowed modes", () => {
    const e = pane("claude");
    expect(stripMouseEnables(e, "a\x1b[?1049;1002;1003;1006hb")).toBe("a\x1b[?1049;1002;1006hb");
    expect(stripMouseEnables(e, "\x1b[?1003h")).toBe("");
    expect(stripMouseEnables(e, "\x1b[?01003h")).toBe("");
  });
  it("passes resets through, so the terminal stops reporting when Claude does", () => {
    const e = { ...pane("claude"), wantsMouse: true };
    expect(stripMouseEnables(e, "\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?1049l")).toBe(
      "\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?1049l"
    );
    expect(e.wantsMouse).toBe(false);
  });
  it("drops a re-sent lower tracking mode while a button is held, so the drag keeps reporting", () => {
    const e = pane("claude");
    stripMouseEnables(e, CLAUDE_STARTUP);
    e.buttonHeld = true;
    // the set Claude re-sends while a button is held
    expect(stripMouseEnables(e, "\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h")).toBe("\x1b[?2004h\x1b[?1002h\x1b[?1006h");
    expect(stripMouseEnables(e, "\x1b[?1000;1002;1006h")).toBe("\x1b[?1002;1006h");
    expect(stripMouseEnables(e, "\x1b[?10")).toBe("");
    expect(stripMouseEnables(e, "00h")).toBe("");
    expect(e.tracking).toBe(3);
  });
  it("lets the last tracking mode set win outside a gesture, as xterm does", () => {
    const e = pane("claude");
    stripMouseEnables(e, CLAUDE_STARTUP);
    expect(stripMouseEnables(e, "\x1b[?1000h")).toBe("\x1b[?1000h");
    expect(e.tracking).toBe(2);
  });
  it("lets a lower tracking mode through mid-gesture once tracking was reset", () => {
    const e = pane("claude");
    stripMouseEnables(e, CLAUDE_STARTUP);
    e.buttonHeld = true;
    expect(stripMouseEnables(e, "\x1b[?1002l\x1b[?1000h")).toBe("\x1b[?1002l\x1b[?1000h");
    expect(e.tracking).toBe(2);
    stripMouseEnables(e, "\x1b[?1002h");
    expect(stripMouseEnables(e, "\x1bc\x1b[?1000h")).toBe("\x1bc\x1b[?1000h");
    expect(e.tracking).toBe(2);
    stripMouseEnables(e, "\x1b[?1002h\x1b[?9l");
    expect(stripMouseEnables(e, "\x1b[?1000h")).toBe("\x1b[?1000h");
  });
  it("withholds any-motion tracking when the request is split across chunks", () => {
    const e = pane("claude");
    expect(stripMouseEnables(e, "x\x1b[?100")).toBe("x");
    expect(stripMouseEnables(e, "3hy")).toBe("y");
    expect(stripMouseEnables(e, "\x1b[?1049;10")).toBe("");
    expect(stripMouseEnables(e, "03;1006h")).toBe("\x1b[?1049;1006h");
  });
});

describe("mouse policy per session", () => {
  it("treats sessions without an agent as Claude, and terminals as shells", () => {
    expect(mousePolicyFor({})).toBe("claude");
    expect(mousePolicyFor({ agent: "claude" })).toBe("claude");
    expect(mousePolicyFor({ agent: "codex" })).toBe("agent");
    expect(mousePolicyFor({ shell: true })).toBe("shell");
  });
});

describe("selection ownership at the press", () => {
  const plain = { altKey: false, shiftKey: false };
  const option = { altKey: true, shiftKey: false };
  const shift = { altKey: false, shiftKey: true };
  it("selects natively whenever the program isn't tracking the mouse", () => {
    expect(selectsNatively("none", plain, true, true)).toBe(true);
    expect(selectsNatively("none", plain, false, false)).toBe(true);
  });
  it("leaves a plain press to the program while it tracks the mouse", () => {
    expect(selectsNatively("drag", plain, true, true)).toBe(false);
    expect(selectsNatively("vt200", plain, false, false)).toBe(false);
  });
  it("forces native selection with Option on macOS only when the pane enables it", () => {
    expect(selectsNatively("drag", option, true, true)).toBe(true);
    expect(selectsNatively("drag", option, true, false)).toBe(false);
    expect(selectsNatively("drag", shift, true, true)).toBe(false);
  });
  it("forces native selection with Shift elsewhere", () => {
    expect(selectsNatively("drag", shift, false, false)).toBe(true);
    expect(selectsNatively("drag", option, false, true)).toBe(false);
  });
});

describe("terminal input guard", () => {
  const LONG_AGO = 5_000;
  it("attributes anything shortly after a keystroke or press to the user", () => {
    expect(classifyTermInput("ls\r", 100, "none")).toBe("user");
    expect(classifyTermInput("\x1b[<32;9;4M", 100, "drag")).toBe("user");
  });
  it("passes complete SGR reports while tracking is on, however long the gesture has run", () => {
    expect(classifyTermInput("\x1b[<32;12;7M", LONG_AGO, "drag")).toBe("mouse"); // drag motion
    expect(classifyTermInput("\x1b[<0;12;7m", LONG_AGO, "drag")).toBe("mouse"); // release
    expect(classifyTermInput("\x1b[<64;1;1M", LONG_AGO, "any")).toBe("mouse"); // wheel
    expect(classifyTermInput("\x1b[<35;120;40M", LONG_AGO, "vt200")).toBe("mouse");
  });
  it("gives no exemption to reports while tracking is off", () => {
    expect(classifyTermInput("\x1b[<0;12;7M", LONG_AGO, "none")).toBe("unattributed");
  });
  it("gives no exemption to malformed reports or reports carrying other text", () => {
    for (const d of [
      "\x1b[<0;12M",
      "\x1b[<0;12;7",
      "\x1b[<0;12;7Mx",
      "rm -rf ~\r\x1b[<0;12;7M",
      "\x1b[<0;12;7M\x1b[<0;12;7m",
      "\x1b[<a;12;7M",
      "\x1b[M #!", // legacy X10 encoding
    ]) {
      expect(classifyTermInput(d, LONG_AGO, "drag"), JSON.stringify(d)).toBe("unattributed");
    }
  });
  it("still lets query answers through and drops other unattributed input", () => {
    expect(classifyTermInput("\x1b[12;40R", LONG_AGO, "drag")).toBe("reply");
    expect(classifyTermInput("\x1b[I", LONG_AGO, "none")).toBe("reply");
    expect(classifyTermInput("/clear\r", LONG_AGO, "drag")).toBe("unattributed");
  });
});

describe("paste routing", () => {
  it("lets xterm paste text even when the clipboard also has an image", () => {
    expect(pasteRoute(["text/plain", "image/png"])).toBe("xterm");
    expect(pasteRoute(["text/plain", "text/html", "Files", "image/tiff"])).toBe("xterm");
  });
  it("sends an image-only clipboard to the CLI's own image paste", () => {
    expect(pasteRoute(["Files", "image/png"])).toBe("image");
  });
  it("leaves plain text and empty clipboards to xterm", () => {
    expect(pasteRoute(["text/plain"])).toBe("xterm");
    expect(pasteRoute([])).toBe("xterm");
  });
});
