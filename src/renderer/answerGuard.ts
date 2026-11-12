import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { QUIET_KEYS, afterPause, typed } from "./keyArm";

/**
 * Answers a click gives (a teammate's ask to type, in the Needs you tray and on its workspace's strip) are let go when
 * the click wasn't aimed at them: a row that just arrived or moved under the pointer, or that the landscape's camera
 * just carried there, or the second click of a double click landing on whatever took the answered row's place. A click
 * let go shows: its button is off until a click there would count (`useHeldOff`). Only Deny, the safe answer, is also
 * given from the keyboard (a key's click); allowing takes the pointer.
 */

/** A row that arrived or moved this recently takes no answer: the click was aimed at what was there before. */
export const ANSWER_SETTLE_MS = 500;
/** A click this soon after an answer (or a Dismiss) is a double click's second, landing on whatever slid under the pointer. */
export const ANSWER_GUARD_MS = 450;

/** A click with no pointer behind it: a key's (Enter or Space) on a focused button, or one made by code. */
export const keyClick = (e: { detail: number }): boolean => e.detail === 0;

/** When the landscape's camera last moved (a pan, a zoom, a flight), carrying what's drawn on it under a resting pointer. */
let cameraAt = -Infinity;
export function cameraMoved(): void {
  cameraAt = Date.now();
}
/** How long until the camera has been still ANSWER_SETTLE_MS (0: it has), so a strip it carried has stopped there. */
export const cameraWait = (): number => Math.max(0, ANSWER_SETTLE_MS - (Date.now() - cameraAt));

/**
 * Where each row of `list` (`rows`, keyed by `idOf`) is (`where`: its top in the list, unless given), and since when,
 * recorded after every render: how long until row `id` has stayed where it is ANSWER_SETTLE_MS (0: it has). A row
 * never seen waits the whole of it.
 */
export function useSettledRows(
  list: RefObject<HTMLElement | null>,
  rows: string,
  idOf: (el: HTMLElement) => string | undefined,
  where: (el: HTMLElement) => number = (el) => el.offsetTop
): (id: string) => number {
  const placed = useRef(new Map<string, { pos: number; at: number }>());
  useLayoutEffect(() => {
    const now = Date.now();
    const next = new Map<string, { pos: number; at: number }>();
    for (const el of list.current?.querySelectorAll<HTMLElement>(rows) ?? []) {
      const id = idOf(el);
      if (!id) continue;
      const was = placed.current.get(id);
      const pos = where(el);
      next.set(id, was && was.pos === pos ? was : { pos, at: now });
    }
    placed.current = next;
  });
  return (id) => {
    const p = placed.current.get(id);
    return p ? Math.max(0, ANSWER_SETTLE_MS - (Date.now() - p.at)) : ANSWER_SETTLE_MS;
  };
}

/**
 * A button whose click was let go, shown off (disabled) for as long as a click there would be let go too: `holdOff(key,
 * ms)` after letting one go, `heldOff(key)` for the button's `disabled`. One at a time.
 */
export function useHeldOff(): { holdOff: (key: string, ms: number) => void; heldOff: (key: string) => boolean } {
  const [held, setHeld] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const holdOff = useCallback((key: string, ms: number) => {
    clearTimeout(timer.current);
    setHeld(key);
    timer.current = setTimeout(() => setHeld(null), ms);
  }, []);
  return { holdOff, heldOff: (key) => held === key };
}

/**
 * A dialog opened by a click or a key aimed at something else (a handle's click, a menu row): for ANSWER_SETTLE_MS, and
 * never a double click's second, a click in it is let go before it reaches a control, which shows off meanwhile
 * (`heldOff("settle")`, for its main button's `disabled` and its backdrop); and keys of a burst typed as it opened were
 * typed for what was there before, so none reaches it until a pause, or a press in it. `box`: the dialog's element,
 * read once it has rendered; none (`on` false) for a dialog opened by its own button.
 */
export function useOpenSettle(box: () => HTMLElement | null | undefined, on = true): { heldOff: (key: string) => boolean } {
  const { holdOff, heldOff } = useHeldOff();
  useLayoutEffect(() => {
    const el = on ? box() : null;
    if (!el) return;
    const opened = Date.now();
    holdOff("settle", ANSWER_SETTLE_MS);
    let fresh = true;
    const aimed = (e: MouseEvent) => {
      if (e.detail < 2 && (e.detail < 1 || Date.now() - opened >= ANSWER_SETTLE_MS)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const pressed = () => void (fresh = false);
    const key = (e: globalThis.KeyboardEvent) => {
      if (!fresh || QUIET_KEYS.has(e.key)) return;
      if (afterPause() && !e.repeat) return void (fresh = false);
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener("click", aimed, true);
    el.addEventListener("pointerdown", pressed, true);
    el.addEventListener("keydown", key, true);
    return () => {
      el.removeEventListener("click", aimed, true);
      el.removeEventListener("pointerdown", pressed, true);
      el.removeEventListener("keydown", key, true);
    };
  }, [on, holdOff]);
  return { heldOff };
}

/** What a surface that swallowed early keys (`useAimedKeys`) says. */
export const EARLY_KEYS_HINT = "Keys typed just before this opened don't press anything here: pause, then go on.";

/**
 * Keys aimed at what just opened over the user (a popover, a dialog): ones typed in a burst that began before it opened,
 * or held down, press nothing in it (`onKeyDown` swallows them, Tab too, and `stale` says so) until a key comes after a
 * pause (keyArm's TYPING_MS); from then on they're the user's. Esc and a modifier on its own always go through, and a
 * modifier never ends a burst. `keyAimed(e)`: a click made by a key counts only from Enter or Space pressed (not held) on
 * that very button (`buttons`); a pointer's always does, for the caller to settle.
 */
export function useAimedKeys(buttons = "button"): {
  onKeyDown: (e: KeyboardEvent) => void;
  keyAimed: (e: { detail: number; currentTarget: EventTarget }) => boolean;
  stale: boolean;
} {
  const mine = useRef(false);
  const keyed = useRef<Element | null>(null);
  const [stale, setStale] = useState(false);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!typed(e) || QUIET_KEYS.has(e.key)) return;
    if (afterPause() && !e.repeat) mine.current = true;
    if (!mine.current) {
      e.preventDefault();
      e.stopPropagation();
      keyed.current = null;
      return setStale(true);
    }
    setStale(false);
    const b = (e.target as Element).closest?.(buttons) ?? null;
    keyed.current = (e.key === "Enter" || e.key === " ") && !e.repeat && b ? b : null;
  };
  const keyAimed = (e: { detail: number; currentTarget: EventTarget }) => {
    if (!keyClick(e)) return true;
    const aimed = keyed.current === e.currentTarget;
    keyed.current = null;
    return aimed;
  };
  return { onKeyDown, keyAimed, stale };
}

/** Whether a click on what appeared (or changed) at `since` wasn't aimed at it: too soon after, or past a double click's first. */
export const arrivalClick = (e: { detail: number }, since: number, now = Date.now()): boolean => e.detail > 1 || now - since < ANSWER_GUARD_MS;

/**
 * A component's buttons that only take a click aimed at them (`guard(handler)` wraps one): none within ANSWER_GUARD_MS
 * of the component appearing, or of `key` changing (the words under its buttons replaced), and none that's a double
 * click's second or later (`detail > 1`). A dialog opened from Needs you lands its buttons where the tray's were, so the
 * second click of a double click on Open would otherwise approve, post or move a ticket. A key's click (detail 0) after
 * that is a person's. `guard.aimed(e)` is the same test, for a control whose change isn't its click's (a checkbox).
 */
export interface ArrivalGuard {
  <E extends { detail: number }>(handler: (e: E) => void): (e: E) => void;
  aimed: (e: { detail: number }) => boolean;
}
export function useArrivalGuard(key: unknown = null): ArrivalGuard {
  const at = useRef({ key, since: Date.now() });
  if (at.current.key !== key) at.current = { key, since: Date.now() };
  const aimed = (e: { detail: number }) => !arrivalClick(e, at.current.since);
  return Object.assign(<E extends { detail: number }>(handler: (e: E) => void) => (e: E) => void (aimed(e) && handler(e)), { aimed });
}
