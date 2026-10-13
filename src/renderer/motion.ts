import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type MutableRefObject, type RefObject } from "react";
import { readPref, writePref } from "./prefs";

/**
 * Motion: one personality ("Fluid": critically damped, no bounce) for the whole app, the reduced-motion rules,
 * and the small helpers every animated piece goes through.
 *
 * Rules the helpers keep:
 * - Only transform and opacity move (clip-path on View Transition pseudo-elements). Never layout properties.
 * - Nothing waits on an animation: state changes apply at once and exits play on a static copy (exitGhost).
 * - Under "reduce" every animation is a fade of 120 ms or less and no View Transition runs; under "off"
 *   (tests and screenshots) nothing animates at all.
 * - Terminals never animate: grid changes run as View Transitions, which move compositor snapshots.
 */

/** The Settings → Motion choice. */
export type MotionPref = "os" | "reduce" | "full";
/** What the app does: full motion, fades only, or nothing (forced by tests and screenshots). */
export type MotionMode = "full" | "reduce" | "off";

/** The mode a choice gives, given macOS's Reduce motion and whether a test forced motion off. */
export function motionMode(pref: MotionPref, osReduce: boolean, forcedOff = false): MotionMode {
  if (forcedOff) return "off";
  if (pref === "full" || pref === "reduce") return pref;
  return osReduce ? "reduce" : "full";
}

/** Fluid's durations, ms: xs for small feedback, s for menus and exits, m for state, l for journeys. */
export const D = { xs: 90, s: 150, m: 220, l: 340 } as const;
/** The longest any animation runs under reduce. */
export const REDUCED_MS = 120;
export const EASE = {
  /** Entering: M3 emphasized-decelerate. */
  enter: "cubic-bezier(0.05, 0.7, 0.1, 1)",
  /** Exiting: M3 emphasized-accelerate. */
  exit: "cubic-bezier(0.3, 0, 0.8, 0.15)",
  /** Moving on screen, where a spring doesn't fit. */
  move: "cubic-bezier(0.2, 0, 0, 1)",
} as const;

/**
 * A spring (mass 1) from 0 to 1, sampled into a CSS linear() easing, with the time it takes to settle and how
 * far it overshoots. Fluid's is stiffness 700, damping ratio 0.9 (M3's standard default spatial spring).
 */
export function spring(stiffness: number, damping: number): { easing: string; duration: number; overshoot: number } {
  const dt = 1 / 1000;
  const samples: number[] = [];
  let x = 0;
  let v = 0;
  let t = 0;
  let settledAt: number | null = null;
  while (t < 2) {
    const a = -stiffness * (x - 1) - damping * v;
    v += a * dt;
    x += v * dt;
    t += dt;
    samples.push(x);
    if (Math.abs(x - 1) < 0.004 && Math.abs(v) < 0.05) settledAt ??= t;
    else settledAt = null;
    if (settledAt !== null && t - settledAt > 0.03) break;
  }
  const duration = Math.round((settledAt ?? t) * 1000);
  const n = 40;
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const idx = Math.min(samples.length - 1, Math.round((i / n) * (duration - 1)));
    pts.push(i === n ? 1 : +samples[idx].toFixed(3));
  }
  pts[0] = 0;
  return { easing: `linear(${pts.join(", ")})`, duration, overshoot: Math.max(0, Math.max(...samples) - 1) };
}

/** Fluid's spring: what moves on screen (the grid making room, the lid, toasts) moves on this. */
export const SPRING = spring(700, 2 * 0.9 * Math.sqrt(700));

// ---- the live mode ----

const hasDom = typeof window !== "undefined" && typeof document !== "undefined";
let pref: MotionPref = "os";
let mode: MotionMode = "full";
let osQuery: MediaQueryList | null = null;
const subs = new Set<() => void>();

/** A test or screenshot asked for no motion at all (the UI preview sets this before the app loads). */
const forcedOff = () => hasDom && (globalThis as { __mbMotion?: string }).__mbMotion === "off";

function apply() {
  mode = motionMode(pref, !!osQuery?.matches, forcedOff());
  if (hasDom) document.documentElement.dataset.motion = mode;
  for (const f of subs) f();
}

let lastKey = 0;
let lastPointer = 0;

/** Reads the saved choice, follows macOS's Reduce motion live, and marks the root `data-motion`. Once. */
export function initMotion(): void {
  if (!hasDom || osQuery) return;
  const saved = readPref<MotionPref>("mb.motion", "os");
  pref = saved === "reduce" || saved === "full" ? saved : "os";
  osQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  osQuery.addEventListener("change", apply);
  window.addEventListener("keydown", () => (lastKey = performance.now()), true);
  window.addEventListener("pointerdown", () => (lastPointer = performance.now()), true);
  apply();
}

export function setMotionPref(p: MotionPref): void {
  pref = p;
  writePref("mb.motion", p);
  apply();
}

/** The current mode, for code deciding whether (and how) to animate. */
export const motion = (): MotionMode => mode;

/** The Settings control's view: the choice, what it gives, and what macOS says. */
export function useMotionPref(): { pref: MotionPref; mode: MotionMode; osReduce: boolean; set: (p: MotionPref) => void } {
  const snap = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => `${pref}|${mode}|${osQuery?.matches ? 1 : 0}`
  );
  const [p, m, os] = snap.split("|");
  return { pref: p as MotionPref, mode: m as MotionMode, osReduce: os === "1", set: setMotionPref };
}

/** The last thing the user did was press a key (a shortcut, the palette): keyboard-driven changes don't animate. */
export const fromKeyboard = (): boolean => lastKey > lastPointer && performance.now() - lastKey < 1000;

// ---- playing ----

/** el.animate unless motion is off; reduce turns any animation into a fade of at most 120 ms. */
export function play(el: Element, frames: Keyframe[], o: KeyframeAnimationOptions): Animation | null {
  if (mode === "off" || !hasDom || typeof el.animate !== "function") return null;
  if (mode === "reduce") {
    const fades = frames.some((f) => f.opacity !== undefined);
    if (!fades) return null;
    const from = frames[0].opacity ?? 1;
    const to = frames[frames.length - 1].opacity ?? 1;
    return el.animate([{ opacity: from }, { opacity: to }], { duration: Math.min(REDUCED_MS, Number(o.duration) || REDUCED_MS), easing: "linear", fill: o.fill === "forwards" || o.fill === "both" ? o.fill : "none" });
  }
  return el.animate(frames, o);
}

/** The spring's timing, for el.animate. */
export const springTiming = (fill: FillMode = "none"): KeyframeAnimationOptions => ({ duration: SPRING.duration, easing: SPRING.easing, fill });

/** Things that enter and leave: dialogs (the backdrop, its box the first child), menus, and toasts. */
export type Presence = "dialog" | "menu" | "toast";

function enterFrames(kind: Presence, el: HTMLElement): Animation[] {
  const out: (Animation | null)[] = [];
  if (kind === "dialog") {
    out.push(play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: D.s, easing: "linear" }));
    const box = el.firstElementChild;
    if (box && mode === "full") out.push(play(box, [{ transform: "translateY(6px) scale(0.95)" }, { transform: "none" }], springTiming()));
  } else if (kind === "menu") {
    out.push(play(el, [{ transform: "scale(0.96)" }, { transform: "none" }], { duration: D.s, easing: EASE.enter }));
    out.push(play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: D.xs, easing: "linear" }));
  } else {
    out.push(play(el, [{ transform: "translateY(16px)" }, { transform: "none" }], springTiming()));
    out.push(play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: D.s, easing: "linear" }));
  }
  return out.filter((a): a is Animation => !!a);
}

function exitFrames(kind: Presence, el: HTMLElement): Animation[] {
  const out: (Animation | null)[] = [];
  if (kind === "dialog") {
    out.push(play(el, [{ opacity: 1 }, { opacity: 0 }], { duration: D.s, easing: "linear", fill: "forwards" }));
    const box = el.firstElementChild;
    if (box && mode === "full") out.push(play(box, [{ transform: "none" }, { transform: "scale(0.98)" }], { duration: D.s, easing: EASE.exit, fill: "forwards" }));
  } else if (kind === "menu") {
    out.push(play(el, [{ opacity: 1 }, { opacity: 0 }], { duration: D.xs, easing: "linear", fill: "forwards" }));
  } else {
    out.push(play(el, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(14px)" }], { duration: D.s, easing: EASE.exit, fill: "forwards" }));
  }
  return out.filter((a): a is Animation => !!a);
}

/** Plays an element's entrance. */
export function enter(kind: Presence, el: HTMLElement): void {
  if (mode === "off" || (hasDom && document.hidden)) return;
  enterFrames(kind, el);
}

/** Marks a static copy left behind to play an exit; overlay checks skip it (keys.ts OVERLAYS). */
export const GHOST = "mb-ghost";

/**
 * An element leaving plays its exit on a static copy, so nothing waits for it: the copy sits where the
 * element was, inert and hidden from assistive tech, and goes when its animation ends. Called while the
 * element is still in the page (a ref being detached).
 */
export function exitGhost(kind: Presence, node: HTMLElement): void {
  if (mode === "off" || !hasDom || document.hidden || !node.isConnected || !node.parentNode) return;
  const r = node.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const ghost = node.cloneNode(true) as HTMLElement;
  for (const el of [ghost, ...ghost.querySelectorAll("[id]")]) el.removeAttribute("id");
  ghost.classList.add(GHOST);
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  Object.assign(ghost.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px`, right: "auto", bottom: "auto", width: `${r.width}px`, height: `${r.height}px`, margin: "0", pointerEvents: "none" });
  // a toast's list goes when its last toast does: its copy waits in the body (toasts are fixed, styled on their own)
  if (kind === "toast") {
    // stacked as its list was, so the toasts sliding over its place don't hide it
    for (let up = node.parentElement; up && up !== document.body; up = up.parentElement) {
      const z = getComputedStyle(up).zIndex;
      if (z !== "auto") {
        ghost.style.zIndex = z;
        break;
      }
    }
    document.body.appendChild(ghost);
  }
  else node.parentNode.insertBefore(ghost, node.nextSibling);
  const anims = exitFrames(kind, ghost);
  const done = () => ghost.remove();
  if (!anims.length) return done();
  void Promise.allSettled(anims.map((a) => a.finished)).then(done);
}

/**
 * A ref for an element that enters and leaves: it plays its entrance when it mounts, and its exit on a static
 * copy when it unmounts. `instant()` true at mount (a menu opened from the keyboard) skips the entrance.
 * `also` receives the element too, for components that keep their own ref.
 */
export function usePresence<T extends HTMLElement>(kind: Presence, opts: { instant?: () => boolean; also?: MutableRefObject<T | null> } = {}) {
  const last = useRef<T | null>(null);
  const o = useRef(opts);
  o.current = opts;
  return useCallback(
    (el: T | null) => {
      if (o.current.also) o.current.also.current = el;
      if (el) {
        last.current = el;
        if (!o.current.instant?.()) enter(kind, el);
      } else if (last.current) {
        exitGhost(kind, last.current);
        last.current = null;
      }
    },
    [kind]
  );
}

/**
 * Children that move when the list changes slide from where they were (FLIP, transform only). Call after
 * every render of the list's owner, with its container; positions are the container's place plus layout
 * offsets, so a running animation never skews the next measurement (the container itself mustn't move).
 */
export function flipChildren(container: HTMLElement | null, last: Map<Element, number>): void {
  if (!container) return;
  // the container's own place counts: a stack anchored at its bottom grows upward, moving every toast in it
  const base = container.getBoundingClientRect().top;
  const seen = new Set<Element>();
  for (const child of container.children) {
    if (!(child instanceof HTMLElement) || child.classList.contains(GHOST)) continue;
    seen.add(child);
    const now = base + child.offsetTop;
    const was = last.get(child);
    last.set(child, now);
    if (was !== undefined && Math.abs(was - now) > 0.5) play(child, [{ transform: `translateY(${was - now}px)` }, { transform: "none" }], { ...springTiming(), composite: "add" });
  }
  for (const k of [...last.keys()]) if (!seen.has(k)) last.delete(k);
}

/** Each child of `ref`'s element slides to its new place when the list changes (flipChildren, after every render). */
export function useFlip(ref: RefObject<HTMLElement>): void {
  const last = useRef(new Map<Element, number>());
  useLayoutEffect(() => flipChildren(ref.current, last.current));
}

/**
 * usePresence for the items of a list: `refFor(key)` is each item's ref, the same function for the same key
 * on every render, so an item plays its entrance once and its exit when it leaves.
 */
export function usePresenceRefs<T extends HTMLElement>(kind: Presence): (key: string | number) => (el: T | null) => void {
  const refs = useRef(new Map<string | number, (el: T | null) => void>());
  return useCallback(
    (key) => {
      let f = refs.current.get(key);
      if (!f) {
        let last: T | null = null;
        f = (el) => {
          if (el) {
            last = el;
            enter(kind, el);
          } else if (last) {
            exitGhost(kind, last);
            last = null;
            refs.current.delete(key);
          }
        };
        refs.current.set(key, f);
      }
      return f;
    },
    [kind]
  );
}
