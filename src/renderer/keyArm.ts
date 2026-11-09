/**
 * Arming: a surface that takes typed keys as commands (the landscape: its letters, ?, Enter, Space, Esc, ⌥ keys, and
 * its peek's keys; any key without ⌘ or Ctrl, `typed`) acts on them only while it's armed. The keyboard landing on it
 * isn't enough: it lands there on its own too (a terminal or a field that went, a hand-back, a band change, the tour
 * ending), and whatever is typed on then was meant for somewhere else, often another session's prompt.
 *
 * Only an act of the user's aimed at the surface arms it:
 * - a press on it (`armOnPress`: the canvas, a card, anything of it that doesn't take the keyboard itself);
 * - a command that leaves a terminal for it (⌘E, ⌘Esc), or goes to it (Go there), and the window opening on it or its
 *   tab clicked (`armFocus`);
 * - the user leaving what they opened from it while it was armed (`userLeft`: Esc, or a press): a palette, a dialog, a
 *   menu, the shortcuts sheet, which then give the keyboard back armed (Modal.tsx's `useDialogFocus`, ContextMenu.tsx).
 *
 * Anything else that gives it the keyboard leaves it disarmed, and the keyboard going anywhere else disarms it,
 * however that happens: a terminal or a field taking it, a dialog opening, focus falling to the page. A disarmed
 * surface swallows typed keys (Tab too, so a burst can't walk onto a button and press it); ⌘ and Ctrl chords still
 * work. Every key handler of such a surface asks `isArmed` before acting on a typed key.
 */

let armed: Element | null = null;
/** A press on a surface, until the keyboard arrives there as the press's own focus move (in the same task). */
let pressed: Element | null = null;
/** The user's last key, or null after a press. */
let lastKey: string | null = null;

if (typeof document !== "undefined") {
  document.addEventListener("keydown", (e) => void (lastKey = e.key), true);
  document.addEventListener("pointerdown", () => void (lastKey = null), true);
  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target as Element | null;
      if (t && t === pressed) armed = t;
      else if (t !== armed) armed = null;
      pressed = null;
    },
    true
  );
  // to nothing while the window is in front: the keyboard fell to the page. A window going behind another keeps it.
  document.addEventListener("focusout", (e) => void (!e.relatedTarget && document.hasFocus() && (armed = null)), true);
}

/** A key a surface acts on only while armed: anything typed, so everything but ⌘ and Ctrl chords. */
export const typed = (e: { metaKey: boolean; ctrlKey: boolean }): boolean => !e.metaKey && !e.ctrlKey;

/** `el` has the keyboard, and the user gave it it. */
export const isArmed = (el: Element | null | undefined): boolean => !!el && armed === el && document.activeElement === el;

/** The keyboard to `el`, armed: for a user's command that goes to it. */
export function armFocus(el: HTMLElement | null | undefined): void {
  if (!el?.isConnected) return;
  el.focus({ preventScroll: true });
  if (document.activeElement === el) armed = el;
}

/**
 * What's closing now was left by the user: Esc, ? (the shortcuts sheet's own key), or a press (Cancel, ×, outside it).
 * Not run with Enter or typed past, after which keys may still be coming for what it made.
 */
export const userLeft = (): boolean => lastKey === null || lastKey === "Escape" || lastKey === "?";

/** The user pressed on `el`: armed if it has the keyboard, or as soon as the press itself gives it it. */
export function armOnPress(el: Element | null | undefined): void {
  if (!el) return;
  if (document.activeElement === el) {
    armed = el;
    return;
  }
  pressed = el;
  // a press that gives the keyboard nothing (or something else) arms nothing later
  setTimeout(() => {
    if (pressed === el) pressed = null;
  }, 0);
}
