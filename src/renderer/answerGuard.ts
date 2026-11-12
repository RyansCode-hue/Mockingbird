import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

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
