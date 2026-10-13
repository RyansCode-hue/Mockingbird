import { flushSync } from "react-dom";
import { D, SPRING, fromKeyboard, motion, play, springTiming } from "./motion";

/**
 * The grid's motion: panes opening, closing, going fullscreen, swapping groups, and flying into (and out of)
 * their sidebar folder. Every one runs as a View Transition, so what moves is the compositor's snapshot of a
 * pane and never the live terminal: xterm lays out and fits once, at the new size. Under reduce there's no
 * View Transition: the change is instant and new panes fade in; under off, nothing moves.
 */

export type Rect = { x: number; y: number; w: number; h: number };

/** Where a minimized pane flies: its folder (or row), the edge of the list it's scrolled behind, the rail's Sessions icon, or nowhere. */
export type FlyTo = { to: Rect; via: "target" | "edge" | "rail" } | { to: null; via: "none" };

/**
 * Picks the flight's end. The target counts when the Sessions list is showing and it's inside the list's
 * visible part; scrolled out, the pane goes to the list's edge on that side; with the side bar collapsed or
 * on another view, to the rail's Sessions icon; with none of those, it just fades where it is.
 */
export function flyTarget(o: { target: Rect | null; list: Rect | null; listShown: boolean; rail: Rect | null }): FlyTo {
  if (o.listShown && o.target && o.list) {
    const t = o.target;
    const l = o.list;
    if (t.y >= l.y - 1 && t.y + t.h <= l.y + l.h + 1) return { to: t, via: "target" };
    return { to: { ...t, y: t.y < l.y ? l.y : l.y + l.h - t.h }, via: "edge" };
  }
  if (o.rail) return { to: o.rail, via: "rail" };
  return { to: null, via: "none" };
}

/** One element's keyframes and timing, by which part of the flying snapshot it drives. */
export type FlightPart = { frames: Keyframe[]; easing: string };

/**
 * The genie funnel between a pane at `p` and the icon at `t` ("in": into the icon). The side facing the icon
 * pinches to the icon's height while the pane hardly moves, then the pane is drawn in along that funnel,
 * fading over the last fifth. `group` moves it across (x); `pair` carries it down and shrinks it; `image`
 * holds the funnel's clip and the fade. "out" is the same path backwards on entering curves.
 */
export function genieFlight(p: Rect, t: Rect, dir: "in" | "out"): { group: FlightPart; pair: FlightPart; image: FlightPart } {
  const dx = t.x - p.x;
  const dy = t.y - p.y;
  const sx = t.w / p.w;
  const sy = t.h / p.h;
  const ty = Math.max(0, Math.min(100, ((t.y + t.h / 2 - p.y) / p.h) * 100));
  const a = Math.max(0, ty - 6);
  const b = Math.min(100, ty + 6);
  const at = (x: number) => `translate(${p.x + x}px, ${p.y}px)`;
  const size = { width: `${p.w}px`, height: `${p.h}px` };
  const group: Keyframe[] = [
    { transform: at(0), ...size },
    { transform: at(dx * 0.08), ...size, offset: 0.4 },
    { transform: at(dx), ...size },
  ];
  const pair: Keyframe[] = [
    { transform: "none" },
    { transform: `translateY(${dy * 0.15}px) scale(0.92, 0.97)`, offset: 0.4 },
    { transform: `translateY(${dy}px) scale(${sx}, ${sy})` },
  ];
  const image: Keyframe[] = [
    { clipPath: "polygon(0 0, 100% 0, 100% 100%, 0 100%)", opacity: 1 },
    { clipPath: `polygon(0 ${a}%, 100% 0, 100% 100%, 0 ${b}%)`, offset: 0.4 },
    { opacity: 1, offset: 0.78 },
    { clipPath: `polygon(0 ${a}%, 100% ${a - 4}%, 100% ${b + 4}%, 0 ${b}%)`, opacity: 0 },
  ];
  const rev = (frames: Keyframe[]) => frames.slice().reverse().map((f) => (f.offset == null ? { ...f } : { ...f, offset: 1 - (f.offset as number) }));
  const way = (frames: Keyframe[]) => (dir === "in" ? frames : rev(frames));
  return {
    group: { frames: way(group), easing: dir === "in" ? "cubic-bezier(0.55, 0, 0.75, 0.2)" : "cubic-bezier(0.25, 0.8, 0.45, 1)" },
    pair: { frames: way(pair), easing: dir === "in" ? "cubic-bezier(0.5, 0, 0.75, 0.25)" : "cubic-bezier(0.25, 0.75, 0.5, 1)" },
    image: { frames: way(image), easing: dir === "in" ? "cubic-bezier(0.5, 0, 0.75, 0.25)" : "cubic-bezier(0.25, 0.75, 0.5, 1)" },
  };
}

/** Which way a group swap moves: down (1) to a group listed below the current one, up (-1) to one above. */
export function switchDir(order: readonly string[], from: string, to: string): 1 | -1 {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  return a >= 0 && b >= 0 && b < a ? -1 : 1;
}

// ---- the View Transition plumbing ----

type VT = { ready: Promise<void>; finished: Promise<void>; updateCallbackDone: Promise<void>; skipTransition(): void };
type StartVT = (cb: () => void | Promise<void>) => VT;

const names = new Map<string, string>();
let nameCount = 0;
/** A View Transition name for a grid cell: stable per cell, a valid identifier whatever the key holds. */
const nameOf = (key: string) => {
  let n = names.get(key);
  if (!n) names.set(key, (n = `mb-pane-${++nameCount}`));
  return n;
};
const FLY = "mb-fly";

const cellsNow = () => [...document.querySelectorAll<HTMLElement>(".grid > [data-cell]")];
const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

function nameCells(fly: string | null) {
  for (const el of cellsNow()) {
    const key = el.dataset.cell!;
    el.style.setProperty("view-transition-name", key === fly ? FLY : nameOf(key));
    el.style.setProperty("view-transition-class", key === fly ? "" : "mb-pane");
  }
}
function unnameCells() {
  for (const el of document.querySelectorAll<HTMLElement>("[data-cell]")) {
    el.style.removeProperty("view-transition-name");
    el.style.removeProperty("view-transition-class");
  }
}

let running: VT | null = null;
let warned = false;
/** Inside a change's update: a change it makes along the way (a group swap within a restore) is part of it. */
let updating = 0;
const inUpdate = (update: () => void) => {
  updating++;
  try {
    flushSync(update);
  } finally {
    updating--;
  }
};

/** What a grid change is, for its animation. */
export type GridMove =
  | { kind: "open" }
  | { kind: "layout" }
  | { kind: "close" }
  | { kind: "zoom" }
  | { kind: "switch"; dir: 1 | -1 }
  /** A pane leaving for its folder or row: `target` finds that icon once the change is made. */
  | { kind: "minimize"; cell: string; target: () => FlyTo; onLanded?: (via: FlyTo["via"]) => void }
  /** A pane coming back out of the icon at `from` (measured before the change) into cell `cell`. */
  | { kind: "restore"; cell: string; from: FlyTo; onOut?: () => void };

/**
 * Makes a grid change, animated. `update` sets the state; it runs inside flushSync so the new grid is in the
 * page when its snapshot is taken. Never waits on anything before the change: a transition still running is
 * skipped to its end first, and a failed transition leaves the change made (and says so once).
 */
export function gridChange(move: GridMove, update: () => void): void {
  if (updating) return update();
  const mode = motion();
  const start = (document as unknown as { startViewTransition?: StartVT }).startViewTransition?.bind(document);
  running?.skipTransition();
  if (mode !== "full" || !start || document.hidden || (move.kind === "switch" && fromKeyboard()) || (!cellsNow().length && move.kind !== "restore")) {
    const before = new Set(cellsNow().map((el) => el.dataset.cell));
    inUpdate(update);
    if (mode === "reduce") for (const el of cellsNow()) if (!before.has(el.dataset.cell)) play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: D.m, easing: "linear" });
    if (move.kind === "minimize") move.onLanded?.("none");
    if (move.kind === "restore") move.onOut?.();
    return;
  }
  const root = document.documentElement;
  root.dataset.gridMove = move.kind === "switch" ? (move.dir > 0 ? "down" : "up") : move.kind;
  const flyKey = move.kind === "minimize" ? move.cell : null;
  nameCells(flyKey);
  let fly: { p: Rect; t: FlyTo } | null = null;
  if (move.kind === "minimize") {
    const el = cellsNow().find((c) => c.dataset.cell === move.cell);
    fly = el ? { p: rectOf(el), t: { to: null, via: "none" } } : null;
  }
  const t = start(() => {
    inUpdate(update);
    if (move.kind === "minimize" && fly) fly.t = move.target();
    // the pane coming out of the folder takes the flight's name; the rest keep theirs
    nameCells(move.kind === "restore" && move.from.via !== "none" ? move.cell : null);
    if (move.kind === "minimize" && fly?.t.via === "none") {
      // nowhere to fly: it leaves like a closing pane
      root.dataset.gridMove = "close";
    }
  });
  running = t;
  t.ready
    .then(() => {
      if (move.kind === "minimize" && fly && fly.t.to) flight(fly.p, fly.t.to, "in", "old");
      if (move.kind === "restore" && move.from.to) {
        const el = cellsNow().find((c) => c.dataset.cell === move.cell);
        if (el) flight(rectOf(el), move.from.to, "out", "new");
      }
    })
    .catch(() => {});
  t.finished
    .catch((err: unknown) => {
      if (!warned && !(err instanceof DOMException && err.name === "AbortError")) {
        warned = true;
        console.warn("[mockingbird] a grid animation failed; the change is made without it:", err);
      }
    })
    .finally(() => {
      if (running === t) running = null;
      unnameCells();
      delete root.dataset.gridMove;
      if (move.kind === "minimize") move.onLanded?.(fly?.t.via ?? "none");
      if (move.kind === "restore") move.onOut?.();
    });
}

/** Drives the flying snapshot's pseudo-elements along the genie path (the pane's own snapshot: `side`). */
function flight(p: Rect, t: Rect, dir: "in" | "out", side: "old" | "new") {
  const g = genieFlight(p, t, dir);
  const root = document.documentElement;
  const run = (part: FlightPart, pseudo: string) =>
    root.animate(part.frames, { duration: D.l, easing: part.easing, fill: "both", pseudoElement: `::view-transition-${pseudo}(${FLY})` });
  run(g.group, "group");
  run(g.pair, "image-pair");
  run(g.image, side);
}

/** The folder's gulp as a pane lands in it (or the rail icon's, collapsed): squash and back, on the spring. */
export function gulp(icon: Element | null): void {
  if (!icon) return;
  play(icon, [{ transform: "none" }, { transform: "scale(1.28, 0.72)", offset: 0.3 }, { transform: "none" }], springTiming());
}

/** How long the lid takes to open before a pane comes out of the folder. */
export const LID_MS = SPRING.duration;
