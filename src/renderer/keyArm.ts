import { OVERLAYS, ownsKeys } from "./keys";

/**
 * Arming: a surface that takes typed keys as commands (the landscape: its letters, ?, Enter, Space, Esc, ⌥ keys, and
 * its peek's keys; any key without ⌘ or Ctrl, `typed`) acts on them only while it's armed. The keyboard landing on it
 * isn't enough: it lands there on its own too (a terminal or a field that went, a hand-back, a band change, the tour
 * ending), and whatever is typed on then was meant for somewhere else, often another session's prompt.
 *
 * Only an act of the user's aimed at the surface arms it:
 * - a press on it (`armOnPress`: the canvas, a card, anything of it but a terminal or a field), or on a button of its
 *   own while it or nothing has the keyboard (a terminal or a field being typed in keeps it);
 * - a command that leaves a terminal for it (⌘E, ⌘Esc), or goes to it (Go there, ⌘E with nothing selected), and its
 *   tab's button pressed (`tabChosen`) or the window opening on it before any input (`untouched`) (`armFocus`);
 * - the user leaving what they opened from it while it was armed (`userLeft`: Esc, or a press): a palette, a dialog, a
 *   menu, the shortcuts sheet, which then give the keyboard back armed (Modal.tsx's `useDialogFocus`, ContextMenu.tsx).
 *
 * Anything else that gives it the keyboard leaves it disarmed, and the keyboard going anywhere else disarms it,
 * however that happens: a terminal or a field taking it, a dialog opening, focus falling to the page. A disarmed
 * surface swallows typed keys (Tab too, so a burst can't walk onto a button and press it); ⌘ and Ctrl chords still
 * work. Once keys have paused (`afterPause`), Tab and Shift+Tab leave it, past all it holds (`tabPast`), so the
 * keyboard alone gets on. Every key handler of such a surface asks `isArmed` before acting on a typed key. A move of the keyboard that
 * waits on something (a reveal or a jump waiting for main) is dropped if the user did anything meanwhile, or a dialog
 * opened (`inputStamp`). What closing gives the keyboard back armed asks `userLeft`, which holds only while the user's
 * own key or press is being handled: a dialog going on its own, later, isn't the user leaving it.
 *
 * Nowhere: a terminal or a text field being typed in, or a surface marked `data-holds-keys` (the landscape, focus's
 * frame), that goes from under the user (removed, hidden) while the landscape is up (`holdNowhere`) doesn't leave the
 * keyboard on the page, where Tab would walk on from where it was,
 * into the controls beside it, and a burst typed on would press them. It goes to an inert holder (`toNowhere`), never
 * armed, which swallows typed keys, Tab, Shift+Tab, Space and Enter included, and says why once (`KEYS_SWALLOWED`); Esc
 * and ⌘ and Ctrl chords go through. Once keys have paused (`TYPING_MS`), Tab and Shift+Tab leave it for a fixed start,
 * the top bar's first or last control (`setKeyboardStart`), never the place of what went. A press anywhere leaves it.
 * Nothing else goes there: the window opening, a dialog or the palette closing, a press on nothing, a button that goes,
 * a tab without the landscape all leave the keyboard on the page, as any browser does. `keyboardNowhere` is the one
 * test for nothing having the keyboard, the page and the holder alike.
 */

/** Keys closer together than this are typing: a pause this long ends a burst. */
export const TYPING_MS = 1000;
/** A modifier pressed on its own: no key of a burst (Shift goes down just before Shift+Tab's Tab). */
const MODIFIERS: ReadonlySet<string> = new Set(["Shift", "Alt", "Meta", "Control", "CapsLock", "Fn"]);
/** Keys that call for no word when swallowed: a modifier on its own, and Esc, which closes things rather than typing. */
export const QUIET_KEYS: ReadonlySet<string> = new Set([...MODIFIERS, "Escape"]);
/** Said on `document` (detail: the key) the first time a key is swallowed with the keyboard on the holder, each time it goes there. */
export const KEYS_SWALLOWED = "mb-keys-swallowed";
/** Said on `document` as a dialog opens (Modal.tsx's `useDialogFocus`, which says what it hands back). */
export const DIALOG_OPENED = "mb-dialog-opened";
/** A surface that takes the keyboard itself: losing it by going (removed, hidden) puts it on the holder, as a terminal's does. */
export const HOLDS_KEYS = "data-holds-keys";
/** What a typing target lost can have been inside and not count: a dialog, the palette, a menu, the tour. */
const OVER = `${OVERLAYS}, .palette, .mb-ctx, .ls-tour-card`;

let armed: Element | null = null;
/** A press on a surface, until the keyboard arrives there as the press's own focus move (in the same task). */
let pressed: Element | null = null;
/** The user's last key, or null after a press. */
let lastKey: string | null = null;
/** When the user last pressed a key (performance.now()). */
let lastKeyAt = -Infinity;
/** The key being handled came after a pause in typing (`TYPING_MS`): it's no part of a burst. */
let keyPaused = true;
/** Whether the user has pressed anything, key or pointer, since the window opened. */
let touched = false;
/** A pointer press is being dispatched: a focus move to nothing now is the press's own. */
let pressing = false;
/** Keys, presses and dialogs opened so far: a deferred move of the keyboard made before a change of this is out of date. */
let inputs = 0;
/** The user's key or press (or the click it ends in) is being handled: from its dispatch to the task after it. */
let acting = false;
let actingTimer: ReturnType<typeof setTimeout> | undefined;
function act(): void {
  acting = true;
  clearTimeout(actingTimer);
  actingTimer = setTimeout(() => (acting = false), 0);
}
/** Moves of the keyboard so far: a surface says why it swallowed keys once for each place the keyboard comes to. */
let spells = 0;
/** The holder's spell already said why it swallowed keys. */
let saidSpell = -1;
/** How many surfaces want a typing target that goes caught by the holder (the landscape, while it's up). */
let holders = 0;
/** The fixed start Tab and Shift+Tab leave the holder for. */
let start: (() => HTMLElement[]) | null = null;
let holderEl: HTMLElement | null = null;

/** The keyboard's place when nothing has it: focusable by code only, out of sight, taking no pointer. */
function holder(): HTMLElement {
  if (!holderEl) {
    holderEl = document.createElement("div");
    holderEl.className = "mb-keys-nowhere";
    holderEl.tabIndex = -1;
    holderEl.setAttribute("aria-label", "Nothing has the keyboard: click where you want to type, or Tab to the top bar");
    Object.assign(holderEl.style, { position: "fixed", left: "0", top: "0", width: "1px", height: "1px", opacity: "0", pointerEvents: "none", outline: "none" });
  }
  if (!holderEl.isConnected) document.body.appendChild(holderEl);
  return holderEl;
}

/** `el` is nowhere for the keyboard: nothing, the page, or the holder. */
export const isNowhere = (el: Element | null | undefined): boolean => !el || el === document.body || el === holderEl;
/** Nothing has the keyboard: the page, or the holder. */
export const keyboardNowhere = (): boolean => isNowhere(document.activeElement);

/**
 * The keyboard to the holder, on purpose: the tour hid the terminal being typed in, or its hold ran to its cap.
 * `quiet`: what it swallows says nothing (the tour's hold, which gives the keyboard back itself).
 */
export function toNowhere(quiet = false): void {
  holder().focus({ preventScroll: true });
  saidSpell = quiet ? spells : -1;
}

/** A surface wants a typing target that goes from under the user caught by the holder while it's up; returns its release. */
export function holdNowhere(): () => void {
  holders++;
  return () => {
    holders--;
    // no surface left to hold it for: the keyboard goes back to the page, as on any other tab
    if (!holders && holderEl && document.activeElement === holderEl) holderEl.blur();
  };
}

/** Where Tab (the first) and Shift+Tab (the last) go from the holder; returns its release. */
export function setKeyboardStart(get: () => HTMLElement[]): () => void {
  start = get;
  return () => {
    if (start === get) start = null;
  };
}

/** Tab or Shift+Tab off the holder, to the fixed start: whether there was one to go to. */
function leaveHolder(back: boolean): boolean {
  const all = (start?.() ?? []).filter((el) => el.isConnected && el.getClientRects().length > 0 && !(el as HTMLButtonElement).disabled);
  const to = back ? all[all.length - 1] : all[0];
  to?.focus();
  return !!to && document.activeElement === to;
}

if (typeof document !== "undefined") {
  // first on the window, so nothing else sees a key typed on the holder; listeners on the window itself still run (⌥⇥
  // goes on to the waiting sessions), but nothing in the page does
  window.addEventListener(
    "keydown",
    (e) => {
      const paused = performance.now() - lastKeyAt >= TYPING_MS;
      lastKey = e.key;
      if (!MODIFIERS.has(e.key)) {
        keyPaused = paused;
        lastKeyAt = performance.now();
      }
      touched = true;
      inputs++;
      act();
      // a key goes to what has the keyboard, so for one typed these are the same; one dispatched by code at an element
      // (the preview's) is that element's
      if (!holderEl || document.activeElement !== holderEl || e.target !== holderEl) return;
      if (!typed(e) || e.key === "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Tab" && paused && leaveHolder(e.shiftKey)) return;
      if (saidSpell === spells || QUIET_KEYS.has(e.key)) return;
      saidSpell = spells;
      document.dispatchEvent(new CustomEvent(KEYS_SWALLOWED, { detail: e.key }));
    },
    true
  );
  document.addEventListener(
    "pointerdown",
    () => {
      lastKey = null;
      touched = true;
      inputs++;
      act();
      pressing = true;
      setTimeout(() => (pressing = false), 0);
    },
    true
  );
  // a press's click is the same act as its press, in a task of its own
  document.addEventListener("click", act, true);
  document.addEventListener(DIALOG_OPENED, () => void inputs++);
  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target as Element | null;
      if (t && t === pressed) armed = t;
      else if (t !== armed) armed = null;
      pressed = null;
      spells++;
    },
    true
  );
  // To nothing while the window is in front. A terminal or a field being typed in, or a surface that holds the keyboard
  // (`HOLDS_KEYS`), that went from under the user (a task later it's gone or hidden, and nothing took the keyboard: a
  // frame or a webview taking it shows only then) puts it on the holder while a surface holds for it. A press's own
  // move, something inside a dialog, the palette, a menu or the tour, and anything else, leave it on the page. A window
  // going behind another keeps it.
  document.addEventListener(
    "focusout",
    (e) => {
      if (e.relatedTarget || !document.hasFocus()) return;
      armed = null;
      const t = e.target as HTMLElement | null;
      if (pressing || !holders || !t || !(ownsKeys(t) || t.hasAttribute(HOLDS_KEYS)) || t.closest(OVER)) return;
      setTimeout(() => {
        if (!holders || !document.hasFocus() || !keyboardNowhere() || document.activeElement === holderEl) return;
        if (t.isConnected && t.getClientRects().length > 0) return;
        toNowhere();
      }, 0);
    },
    true
  );
}

/** What swallowed keys say on the landscape: how to get its keys, and whose terminal ⌘E types in (`typesIn`), if any. */
export const swallowedNote = (typesIn: string | null): string =>
  typesIn ? `Click the landscape to use its keys; ⌘E types in ${typesIn}` : "Click the landscape, or press ⌘E, to use its keys";

/** A key a surface acts on only while armed: anything typed, so everything but ⌘ and Ctrl chords. */
export const typed = (e: { metaKey: boolean; ctrlKey: boolean }): boolean => !e.metaKey && !e.ctrlKey;

/** `el` has the keyboard, and the user gave it it. */
export const isArmed = (el: Element | null | undefined): boolean => !!el && armed === el && document.activeElement === el;

/** Which place the keyboard is in, counted: changes each time it moves (a surface says why it swallows keys once per). */
export const keyboardSpell = (): number => spells;

/** Keys and presses so far: a deferred keyboard move made at one count is out of date at another. */
export const inputStamp = (): number => inputs;

/** The keyboard to `el`, armed: for a user's command that goes to it. */
export function armFocus(el: HTMLElement | null | undefined): void {
  if (!el?.isConnected) return;
  el.focus({ preventScroll: true });
  if (document.activeElement === el) armed = el;
}

/**
 * What's closing now was left by the user: their Esc, ? (the shortcuts sheet's own key), or press (Cancel, ×, outside
 * it) is being handled now. Not with Enter or typed past, after which keys may still be coming for what it made, nor
 * for what closes on its own later (a request answered elsewhere), whatever the user did last.
 */
export const userLeft = (): boolean => acting && (lastKey === null || lastKey === "Escape" || lastKey === "?");

/**
 * What's closing now was left by the user's own key for leaving (Esc, or ? for the shortcuts sheet), being handled now:
 * the one way back to a terminal a hand-back takes (Modal.tsx's useDialogFocus). A press, Enter, or closing on its own
 * isn't.
 */
export const userEscaped = (): boolean => acting && (lastKey === "Escape" || lastKey === "?");

/** The key being handled came after keys had paused (`TYPING_MS`), so it's no part of a burst. */
export const afterPause = (): boolean => keyPaused;

/** The page's Tab stops, in its order. */
const STOPS = "button, a[href], input, select, textarea, [tabindex]";

/**
 * Tab (Shift+Tab: `back`) past `el` and all it holds: the keyboard to the first stop after it in the page's order, or
 * the last before it, wrapping round as a browser does. Whether a stop took it.
 */
export function tabPast(el: Element, back: boolean): boolean {
  const all = [...document.querySelectorAll<HTMLElement>(STOPS)].filter(
    (x) => !el.contains(x) && !x.contains(el) && x.tabIndex >= 0 && !(x as HTMLButtonElement).disabled && x.getClientRects().length > 0 && !x.closest("[inert], .mb-ghost")
  );
  const after = (x: Element) => !!(el.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING);
  const to = back ? (all.filter((x) => !after(x)).pop() ?? all[all.length - 1]) : (all.find(after) ?? all[0]);
  to?.focus();
  return !!to && document.activeElement === to;
}

/** Milliseconds since the user's last key. */
export const sinceKey = (): number => performance.now() - lastKeyAt;

/** Nothing pressed yet, key or pointer, since the window opened: what it opens on is what the user came back to. */
export const untouched = (): boolean => !touched;

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
