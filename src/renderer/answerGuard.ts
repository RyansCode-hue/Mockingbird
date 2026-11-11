import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Answers a click gives (a teammate's ask to type, in the Needs you tray and on its workspace's strip) are let go when
 * the click wasn't aimed at them: a row that just arrived or moved under the pointer, the second click of a double
 * click landing on whatever took the answered row's place, or a key's click on a focused button.
 */

/** A row that arrived or moved this recently takes no answer: the click was aimed at what was there before. */
export const ANSWER_SETTLE_MS = 500;
/** A click this soon after an answer (or a Dismiss) is a double click's second, landing on whatever slid under the pointer. */
export const ANSWER_GUARD_MS = 450;

/** A click with no pointer behind it: a key's (Enter or Space) on a focused button, or one made by code. */
export const keyClick = (e: { detail: number }): boolean => e.detail === 0;

/**
 * Where each row of `list` (`rows`, keyed by `idOf`) is, and since when, recorded after every render: `settled(id)`
 * once it has stayed where it is ANSWER_SETTLE_MS. A row never seen isn't settled.
 */
export function useSettledRows(list: RefObject<HTMLElement | null>, rows: string, idOf: (el: HTMLElement) => string | undefined): (id: string) => boolean {
  const placed = useRef(new Map<string, { top: number; at: number }>());
  useLayoutEffect(() => {
    const now = Date.now();
    const next = new Map<string, { top: number; at: number }>();
    for (const el of list.current?.querySelectorAll<HTMLElement>(rows) ?? []) {
      const id = idOf(el);
      if (!id) continue;
      const was = placed.current.get(id);
      next.set(id, was && was.top === el.offsetTop ? was : { top: el.offsetTop, at: now });
    }
    placed.current = next;
  });
  return (id) => {
    const p = placed.current.get(id);
    return !!p && Date.now() - p.at >= ANSWER_SETTLE_MS;
  };
}
