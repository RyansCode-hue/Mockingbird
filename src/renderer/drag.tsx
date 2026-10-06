import React, { useSyncExternalStore } from "react";
import type { LayoutNode } from "./layoutTree";

/**
 * Drag-and-drop feedback shared by every drag in the app: what's being dragged,
 * the target under the cursor (outlined, or a line on the side it'll land), a
 * label on the cursor saying what the drop will do, and scrolling when the
 * cursor nears the edge of a scrolling list or board.
 *
 * HTML5 drag events only reveal the dragged data on drop, so the payload is
 * kept here too, where targets can read it while the cursor is over them.
 */

export type Side = "before" | "after";

/** Where a drop would land and what it would do. */
export interface DropTarget {
  key: string;
  outcome: string;
  side?: Side;
  /** A drop on the grid: the layout it would leave, and the pane to highlight in it. */
  preview?: { tree: LayoutNode; hot: string };
}

export interface DragState {
  type: string; // the dataTransfer type, e.g. "text/mb-session"
  payload: string;
  label: string; // what's moving, shown until the cursor is over a target
  /** Where the drag started, when one payload type can come from places that drop differently. */
  from?: string;
  /** The target under the cursor, if the drop would do something there. */
  target: DropTarget | null;
  x: number;
  y: number;
}

let state: DragState | null = null;
const listeners = new Set<() => void>();
let frame = 0;
const emit = () => {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    listeners.forEach((l) => l());
  });
};

// module-level, so React keeps one subscription per component instead of
// resubscribing on every render
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const snapshot = () => state;

export function useDrag(): DragState | null {
  return useSyncExternalStore(subscribe, snapshot);
}

/** Start dragging: sets the drag data and tells every target what's coming. */
export function beginDrag(e: React.DragEvent, type: string, payload: string, label: string, from?: string): void {
  e.dataTransfer.setData(type, payload);
  e.dataTransfer.effectAllowed = "move";
  // dragend goes to the dragged element; when the drop moved that element (a
  // session into another group re-renders its row elsewhere) it's no longer in
  // the page, so the event never bubbles to the document — listen on the element
  e.currentTarget.addEventListener("dragend", endDrag, { once: true });
  state = { type, payload, label, from, target: null, x: e.clientX, y: e.clientY };
  emit();
}

/** The dragged item, if it's of this type. */
export function dragging(type: string): string | null {
  return state && state.type === type ? state.payload : null;
}

/** Where the current drag started (see beginDrag). */
export function dragFrom(): string | undefined {
  return state?.from;
}

/**
 * Call from a target's onDragOver. With a target, the drop is allowed and the
 * cursor label says `outcome`; null means "not here" (no-op or not allowed).
 */
export function overTarget(e: React.DragEvent, target: DropTarget | null): void {
  (e.nativeEvent as any).__mbTarget = true; // this event found a target: the page-level handler leaves it alone
  if (target) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  } else {
    e.dataTransfer.dropEffect = "none";
  }
  if (!state) return;
  state = { ...state, target, x: e.clientX, y: e.clientY }; // the label follows the cursor
  emit();
}

export function endDrag(): void {
  if (!state) return;
  state = null;
  emit();
}

/** Which half of `el` the cursor is over, along the axis items are laid out on. */
export function sideOf(e: React.DragEvent, el: Element, axis: "x" | "y"): Side {
  const r = el.getBoundingClientRect();
  return (axis === "x" ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2) ? "before" : "after";
}

/** Move `src` next to `target` on the given side; the list unchanged when that's where it already is. */
export function placeBeside<T>(list: T[], src: T, target: T, side: Side): T[] {
  if (src === target) return list;
  const rest = list.filter((x) => x !== src);
  const i = rest.indexOf(target);
  if (i < 0) return list;
  rest.splice(side === "after" ? i + 1 : i, 0, src);
  return rest;
}

/** True when dropping `src` beside `target` would leave the order as it is. */
export function samePlace<T>(list: T[], src: T, target: T, side: Side): boolean {
  const next = placeBeside(list, src, target, side);
  return next.length === list.length && next.every((x, i) => x === list[i]);
}

/** The drop-cue attribute for an element: "into" (outlined) or "before"/"after" (a line on that side). */
export function cue(d: DragState | null, key: string): "into" | Side | undefined {
  if (!d?.target || d.target.key !== key) return undefined;
  return d.target.side ?? "into";
}

const EDGE = 48;
const STEP = 18;

/** The nearest ancestor that scrolls along an axis. */
function scroller(el: Element | null, axis: "x" | "y"): HTMLElement | null {
  for (let n = el as HTMLElement | null; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    const over = axis === "x" ? s.overflowX : s.overflowY;
    const more = axis === "x" ? n.scrollWidth > n.clientWidth : n.scrollHeight > n.clientHeight;
    if ((over === "auto" || over === "scroll") && more) return n;
  }
  return null;
}

/** Page-level drag handling: clear the target off any target, scroll near edges, clean up at the end. */
export function installDragListeners(): () => void {
  const over = (e: DragEvent) => {
    if (!state) return;
    for (const axis of ["x", "y"] as const) {
      const s = scroller(e.target as Element, axis);
      if (!s) continue;
      const r = s.getBoundingClientRect();
      const pos = axis === "x" ? e.clientX : e.clientY;
      const lo = axis === "x" ? r.left : r.top;
      const hi = axis === "x" ? r.right : r.bottom;
      const d = pos < lo + EDGE ? -STEP : pos > hi - EDGE ? STEP : 0;
      if (d) (axis === "x" ? s.scrollBy({ left: d }) : s.scrollBy({ top: d }));
    }
    if ((e as any).__mbTarget) return;
    if (state.target || state.x !== e.clientX || state.y !== e.clientY) {
      state = { ...state, target: null, x: e.clientX, y: e.clientY };
      emit();
    }
  };
  const done = () => endDrag();
  // after the target's own drop handler: targets stop the drop from bubbling, so
  // this listens in the capture phase and clears once the handler has run
  const dropped = () => setTimeout(endDrag, 0);
  // the mouse reports no movement during a drag, so movement means it's over
  const moved = () => state && endDrag();
  document.addEventListener("dragover", over);
  document.addEventListener("dragend", done);
  document.addEventListener("drop", dropped, true);
  document.addEventListener("mousemove", moved);
  return () => {
    document.removeEventListener("dragover", over);
    document.removeEventListener("dragend", done);
    document.removeEventListener("drop", dropped, true);
    document.removeEventListener("mousemove", moved);
  };
}

/** The label on the cursor: what the drop will do, or what's being moved. */
export function DragLabel() {
  const d = useDrag();
  if (!d) return null;
  // near the window's right edge the label sits left of the cursor, so it stays readable
  const flip = d.x > window.innerWidth - 340;
  return (
    <div className={`drag-label ${d.target ? "ok" : ""}`} style={flip ? { right: window.innerWidth - d.x + 14, top: d.y + 16 } : { left: d.x + 14, top: d.y + 16 }}>
      {d.target ? d.target.outcome : d.label}
    </div>
  );
}
