import { describe, expect, it } from "vitest";
import { createEscapeStack } from "../src/renderer/useEscape";

const key = (k: string, defaultPrevented = false) => {
  const e = { key: k, defaultPrevented, preventDefault: () => (e.defaultPrevented = true) };
  return e;
};

describe("Esc over open layers", () => {
  it("closes only the newest layer — a menu inside a dialog before the dialog", () => {
    const stack = createEscapeStack();
    const closed: string[] = [];
    stack.push({ close: () => closed.push("dialog") });
    const offMenu = stack.push({ close: () => closed.push("menu") });
    expect(stack.press(key("Escape"))).toBe(true);
    expect(closed).toEqual(["menu"]);
    offMenu();
    stack.press(key("Escape"));
    expect(closed).toEqual(["menu", "dialog"]);
  });
  it("marks the key handled, so nothing else acts on it", () => {
    const stack = createEscapeStack();
    stack.push({ close: () => {} });
    const e = key("Escape");
    stack.press(e);
    expect(e.defaultPrevented).toBe(true);
  });
  it("leaves a key the terminal, editor or an open dropdown already handled", () => {
    const stack = createEscapeStack();
    const closed: string[] = [];
    stack.push({ close: () => closed.push("dialog") });
    expect(stack.press(key("Escape", true))).toBe(false);
    expect(closed).toEqual([]);
  });
  it("ignores other keys, and Esc with nothing open", () => {
    const stack = createEscapeStack();
    expect(stack.press(key("Escape"))).toBe(false);
    const closed: string[] = [];
    stack.push({ close: () => closed.push("dialog") });
    expect(stack.press(key("Enter"))).toBe(false);
    expect(closed).toEqual([]);
  });
  it("forgets a layer that closed out of order", () => {
    const stack = createEscapeStack();
    const closed: string[] = [];
    const offA = stack.push({ close: () => closed.push("a") });
    stack.push({ close: () => closed.push("b") });
    offA();
    stack.press(key("Escape"));
    stack.press(key("Escape"));
    expect(closed).toEqual(["b", "b"]);
  });
});
