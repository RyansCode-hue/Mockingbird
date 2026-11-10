/**
 * Arming: a surface that takes typed keys as commands (the landscape: its letters, ?, Enter, Space, Esc, ⌥ keys, and
 * its peek's keys; any key without ⌘ or Ctrl, `typed`) acts on them only while it's armed. The keyboard landing on it
 * isn't enough: it lands there on its own too (a terminal or a field that went, a hand-back, a band change, the tour
 * ending), and whatever is typed on then was meant for somewhere else, often another session's prompt.
 *
 * Only an act of the user's aimed at the surface arms it:
 * - a press on it (`armOnPress`: the canvas, a card, a button of its own, anything of it but a terminal or a field);
 * - a command that leaves a terminal for it (⌘E, ⌘Esc), or goes to it (Go there, ⌘E with nothing selected), and its
 *   tab's button pressed (`tabChosen`) or the window opening on it before any input (`untouched`) (`armFocus`);
 * - the user leaving what they opened from it while it was armed (`userLeft`: Esc, or a press): a palette, a dialog, a
 *   menu, the shortcuts sheet, which then give the keyboard back armed (Modal.tsx's `useDialogFocus`, ContextMenu.tsx).
 *
 * Anything else that gives it the keyboard leaves it disarmed, and the keyboard going anywhere else disarms it,
 * however that happens: a terminal or a field taking it, a dialog opening, focus falling to the page. A disarmed
 * surface swallows typed keys (Tab too, so a burst can't walk onto a button and press it); ⌘ and Ctrl chords still
 * work. Every key handler of such a surface asks `isArmed` before acting on a typed key.
 *
 * Nowhere: when what had the keyboard goes (removed, hidden, blurred) it isn't left on the page, where Tab would walk
 * on from the place of what went, into the controls beside it, and a burst typed on would press them. It goes to an
 * inert holder (`toNowhere`), never armed, which swallows typed keys, Tab and Shift+Tab, Space and Enter included; Esc
 * still reaches what closes on it, and ⌘ and Ctrl chords work. Said as `KEYS_SWALLOWED`. A press on anything leaves
 * it. A press on nothing (a bare stretch of the side bar or the top bar) isn't nowhere: the user put the keyboard on the
 * page there, and Tab goes on from the press, as in any browser. `keyboardNowhere` is the one test for nothing having
 * the keyboard, the page and the holder alike.
 */

let armed: Element | null = null;
/** A press on a surface, until the keyboard arrives there as the press's own focus move (in the same task). */
let pressed: Element | null = null;
/** The user's last key, or null after a press. */
let lastKey: string | null = null;
/** When the user last pressed a key (performance.now()). */
let lastKeyAt = -Infinity;
/** Whether the user has pressed anything, key or pointer, since the window opened. */
let touched = false;
/** A pointer press is being dispatched: a focus move to nothing now is the press's own. */
let pressing = false;
/** The page has the keyboard because the user pressed on nothing: Tab goes on from the press. */
let placedByPress = false;
/** Said on `document` each time a key is swallowed because the keyboard is nowhere. */
export const KEYS_SWALLOWED = "mb-keys-swallowed";
let holderEl: HTMLElement | null = null;

/** The keyboard's place when nothing has it: focusable by code only, out of sight, taking no pointer. */
function holder(): HTMLElement {
  if (!holderEl) {
    holderEl = document.createElement("div");
    holderEl.className = "mb-keys-nowhere";
    holderEl.tabIndex = -1;
    holderEl.setAttribute("aria-label", "Nothing has the keyboard: click where you want to type");
    Object.assign(holderEl.style, { position: "fixed", left: "0", top: "0", width: "1px", height: "1px", opacity: "0", pointerEvents: "none", outline: "none" });
  }
  if (!holderEl.isConnected) document.body.appendChild(holderEl);
  return holderEl;
}

/** `el` is nowhere for the keyboard: nothing, the page, or the holder. */
export const isNowhere = (el: Element | null | undefined): boolean => !el || el === document.body || el === holderEl;
/** Nothing has the keyboard: the page, or the holder. */
export const keyboardNowhere = (): boolean => isNowhere(document.activeElement);

/** The keyboard nowhere, on purpose (the tour's hold at its cap). */
export function toNowhere(): void {
  holder().focus({ preventScroll: true });
}

if (typeof document !== "undefined") {
  // first on the window, so nothing else sees a key typed with the keyboard nowhere; listeners on the window itself
  // still run (⌥⇥ goes on to the waiting sessions), but nothing in the page does
  window.addEventListener(
    "keydown",
    (e) => {
      lastKey = e.key;
      lastKeyAt = performance.now();
      touched = true;
      // a key goes to what has the keyboard, so for one typed these are the same; one dispatched by code at an element
      // (the preview's) is that element's
      if (!keyboardNowhere() || !isNowhere(e.target as Element | null)) return;
      if (placedByPress && document.activeElement === document.body) return;
      if (document.activeElement !== holderEl) toNowhere();
      if (!typed(e) || e.key === "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent(KEYS_SWALLOWED, { detail: e.key }));
    },
    true
  );
  document.addEventListener(
    "pointerdown",
    () => {
      lastKey = null;
      touched = true;
      pressing = true;
      setTimeout(() => (pressing = false), 0);
    },
    true
  );
  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target as Element | null;
      if (t && t === pressed) armed = t;
      else if (t !== armed) armed = null;
      pressed = null;
      placedByPress = false;
    },
    true
  );
  // to nothing while the window is in front: the keyboard fell to the page, and goes to the holder once the move is
  // over (a frame or a webview taking it shows only then), unless a press on nothing put it there. A window going
  // behind another keeps it.
  document.addEventListener(
    "focusout",
    (e) => {
      if (e.relatedTarget || !document.hasFocus()) return;
      armed = null;
      if (pressing) return void (placedByPress = true);
      setTimeout(() => {
        if (document.hasFocus() && keyboardNowhere() && document.activeElement !== holderEl) toNowhere();
      }, 0);
    },
    true
  );
}

/** A key a surface acts on only while armed: anything typed, so everything but ⌘ and Ctrl chords. */
export const typed = (e: { metaKey: boolean; ctrlKey: boolean }): boolean => !e.metaKey && !e.ctrlKey;

/** `el` has the keyboard, and the user gave it it. */
export const isArmed = (el: Element | null | undefined): boolean => !!el && armed === el && document.activeElement === el;

/** How many times something has been armed: a surface that swallowed keys says why once per change of this. */
let armings = 0;
export const armingCount = (): number => armings;

/** The keyboard to `el`, armed: for a user's command that goes to it. */
export function armFocus(el: HTMLElement | null | undefined): void {
  if (!el?.isConnected) return;
  el.focus({ preventScroll: true });
  if (document.activeElement === el) arm(el);
}

function arm(el: Element): void {
  if (armed !== el) armings++;
  armed = el;
}

/**
 * What's closing now was left by the user: Esc, ? (the shortcuts sheet's own key), or a press (Cancel, ×, outside it).
 * Not run with Enter or typed past, after which keys may still be coming for what it made.
 */
export const userLeft = (): boolean => lastKey === null || lastKey === "Escape" || lastKey === "?";

/** Milliseconds since the user's last key. */
export const sinceKey = (): number => performance.now() - lastKeyAt;

/** Nothing pressed yet, key or pointer, since the window opened: what it opens on is what the user came back to. */
export const untouched = (): boolean => !touched;

/** The user pressed on `el`: armed if it has the keyboard, or as soon as the press itself gives it it. */
export function armOnPress(el: Element | null | undefined): void {
  if (!el) return;
  if (document.activeElement === el) {
    arm(el);
    return;
  }
  pressed = el;
  // a press that gives the keyboard nothing (or something else) arms nothing later
  setTimeout(() => {
    if (pressed === el) pressed = null;
  }, 0);
}

/**
 * A tab's button pressed (or its row in »): the user chose that tab, which a surface mounting for it takes up as its
 * arming (`takeTabChoice`). Read from the press, never from where the keyboard is: a palette or a menu gives the
 * keyboard back to a tab's button too. Kept a moment, for the mount that follows it.
 */
let choice: { tab: string; at: number } | null = null;
const CHOICE_MS = 1000;
export function tabChosen(tab: string): void {
  choice = { tab, at: performance.now() };
}
export function takeTabChoice(tab: string): boolean {
  const c = choice;
  choice = null;
  return !!c && c.tab === tab && performance.now() - c.at < CHOICE_MS;
}
