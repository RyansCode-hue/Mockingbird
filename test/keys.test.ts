import { describe, expect, it } from "vitest";
import { enterConfirms, escapeLeavesFullscreen, inEditor, ownsKeys } from "../src/renderer/keys";

/** A stand-in element: its tag, and the selectors `closest` finds an ancestor for. */
const el = (tagName: string, inside: string[] = [], isContentEditable = false) => ({
  tagName,
  isContentEditable,
  closest: (sel: string) => (sel.split(",").some((s) => inside.includes(s.trim())) ? {} : null),
});

describe("who owns a keystroke", () => {
  const body = el("BODY");
  const term = el("TEXTAREA", [".xterm"]);
  const editor = el("DIV", [".cm-editor"], true);

  it("leaves fullscreen on Escape only when nothing open or focused wants the key", () => {
    expect(escapeLeavesFullscreen(body, false)).toBe(true);
    expect(escapeLeavesFullscreen(el("DIV", [".pane"]), false)).toBe(true);
    // a dialog, popover or menu closes first
    expect(escapeLeavesFullscreen(body, true)).toBe(false);
  });
  it("lets the terminal, the editor and text fields have Escape", () => {
    expect(escapeLeavesFullscreen(term, false)).toBe(false);
    expect(escapeLeavesFullscreen(el("SPAN", [".xterm"]), false)).toBe(false);
    expect(escapeLeavesFullscreen(editor, false)).toBe(false);
    expect(escapeLeavesFullscreen(el("INPUT"), false)).toBe(false);
    expect(escapeLeavesFullscreen(el("textarea"), false)).toBe(false);
    expect(escapeLeavesFullscreen(el("DIV", [], true), false)).toBe(false);
    expect(ownsKeys(null)).toBe(false);
  });
  it("knows the editor, which keeps ⌘/ for toggling comments", () => {
    expect(inEditor(editor)).toBe(true);
    expect(inEditor(term)).toBe(false);
    expect(inEditor(body)).toBe(false);
  });
});

describe("Enter in a confirm dialog", () => {
  it("confirms from the dialog itself or a chosen option row", () => {
    expect(enterConfirms(el("BODY"))).toBe(true);
    expect(enterConfirms(el("DIV", [".modal"]))).toBe(true);
    expect(enterConfirms(el("BUTTON", ["button", ".opt"]))).toBe(true);
    expect(enterConfirms(el("SPAN", ["button", ".opt"]))).toBe(true);
  });
  it("leaves Enter to a focused button (Cancel clicks Cancel) or field", () => {
    expect(enterConfirms(el("BUTTON", ["button"]))).toBe(false);
    expect(enterConfirms(el("SPAN", ["button"]))).toBe(false);
    expect(enterConfirms(el("INPUT", ["input"]))).toBe(false);
  });
});
