import { describe, expect, it } from "vitest";
import { stripMouseEnables } from "../src/renderer/mouseModes";

const pane = () => ({ stripMouse: true, carry: "", wantsMouse: false });

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
  it("handles a request split across two chunks", () => {
    const e = pane();
    expect(stripMouseEnables(e, "x\x1b[?10")).toBe("x");
    expect(stripMouseEnables(e, "00hy")).toBe("y");
    expect(e.wantsMouse).toBe(true);
  });
  it("passes everything through untouched in shell panes, where vim and htop own the mouse", () => {
    const e = { ...pane(), stripMouse: false };
    expect(stripMouseEnables(e, "\x1b[?1000h")).toBe("\x1b[?1000h");
  });
});
