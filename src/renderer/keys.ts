/**
 * Who a keystroke belongs to, for the window-level shortcuts. A shortcut must
 * not take a key that an open dialog, popover or menu, or the focused text
 * field, terminal or code editor, handles itself.
 */

/** As much of a key event's target as these checks read (an Element, in the app). */
export interface KeyTarget {
  tagName?: string;
  isContentEditable?: boolean;
  closest?(selectors: string): unknown;
}

/** Dialogs, popovers and menus: while one is open, Escape is its to close. */
export const OVERLAYS = ".modal-back, .scrim, .who-back, .mb-menu";

const FIELDS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Focus is in something that reads keys itself: a text field, the terminal (xterm) or the code editor. */
export function ownsKeys(t: KeyTarget | null | undefined): boolean {
  if (!t) return false;
  if (t.isContentEditable || FIELDS.has((t.tagName ?? "").toUpperCase())) return true;
  return !!t.closest?.(".xterm, .cm-editor");
}

/** Inside the code editor, whose own keymap has ⌘/ (toggle comment) and Escape (close its panels). */
export function inEditor(t: KeyTarget | null | undefined): boolean {
  return !!t?.closest?.(".cm-editor");
}

/** Escape leaves fullscreen only when nothing open or focused wants it. */
export function escapeLeavesFullscreen(t: KeyTarget | null | undefined, overlayOpen: boolean): boolean {
  return !overlayOpen && !ownsKeys(t);
}

/**
 * Enter confirms a dialog unless focus is on one of its controls — Cancel, the
 * confirm button (whose own click confirms), a field. Choice rows (`.opt`)
 * aren't: picking one and pressing Enter confirms that choice.
 */
export function enterConfirms(t: KeyTarget | null | undefined): boolean {
  if (!t?.closest || t.closest(".opt")) return true;
  return !t.closest("button, input, textarea, select, a");
}
