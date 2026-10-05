import { useEffect, useState, type KeyboardEvent } from "react";

/** A row index kept inside a list of `count` rows (0 for an empty list). */
export const clampIndex = (i: number, count: number) => Math.max(0, Math.min(i, count - 1));

/**
 * ↑↓ through a list of `count` rows, back to the top whenever one of `resetOn`
 * changes. The selection is clamped to the rows there are, so a list that
 * shrinks, or fills in after ↓ was pressed on it empty, never leaves ↵ on
 * nothing.
 */
export function useListNav(count: number, resetOn: unknown[]) {
  const [sel, setSel] = useState(0);
  useEffect(() => setSel(0), resetOn);
  const at = clampIndex(sel, count);
  /** Moves on ↑ or ↓; true when the key was one of them. */
  const onArrow = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return false;
    e.preventDefault();
    setSel(clampIndex(at + (e.key === "ArrowDown" ? 1 : -1), count));
    return true;
  };
  return { sel: at, setSel, onArrow };
}
