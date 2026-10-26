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

/**
 * Fluid's durations, ms: xs for small feedback, s for menus and exits, m for state, l for journeys, genie for
 * a pane flying into or out of its folder. "Relaxed": about a third longer than Fluid's first cut.
 */
export const D = { xs: 120, s: 200, m: 300, l: 460, genie: 480 } as const;
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

/** Fluid's spring: what moves on screen (the grid making room, the lid, toasts) moves on this. Stiffness 384
 * settles about 1.35× slower than 700 at the same damping ratio, matching the Relaxed durations. */
export const SPRING = spring(384, 2 * 0.9 * Math.sqrt(384));

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
    return el.animate([{ opacity: from }, { opacity: to }], { duration: Math.min(REDUCED_MS, Number(o.duration) || REDUCED_MS), easing: "linear", fill: o.fill === "forwards" || o.fill === "both" ? o.fill : "none", pseudoElement: o.pseudoElement });
  }
  return el.animate(frames, o);
}

/** The spring's timing, for el.animate. */
export const springTiming = (fill: FillMode = "none"): KeyframeAnimationOptions => ({ duration: SPRING.duration, easing: SPRING.easing, fill });

/** Things that enter and leave: dialogs (the backdrop, its box the first child), menus, toasts, and badges
 * (a small label whose content changes: the old one fades out on a copy as the new one fades in). */
export type Presence = "dialog" | "menu" | "toast" | "badge";

function enterFrames(kind: Presence, el: HTMLElement): Animation[] {
  const out: (Animation | null)[] = [];
  if (kind === "dialog") {
    out.push(play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: D.s, easing: "linear" }));
    const box = el.firstElementChild;
    if (box && mode === "full") out.push(play(box, [{ transform: "translateY(6px) scale(0.95)" }, { transform: "none" }], springTiming()));
  } else if (kind === "menu") {
    out.push(play(el, [{ transform: "scale(0.96)" }, { transform: "none" }], { duration: D.s, easing: EASE.enter }));
    out.push(play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: D.xs, easing: "linear" }));
  } else if (kind === "badge") {
    out.push(play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: D.m, easing: "linear" }));
    out.push(play(el, [{ transform: "scale(0.8)" }, { transform: "none" }], springTiming()));
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
  } else if (kind === "badge") {
    out.push(play(el, [{ opacity: 1 }, { opacity: 0 }], { duration: D.s, easing: "linear", fill: "forwards" }));
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
  // a toast's list goes when its last toast does: its copy waits in the body (toasts are fixed, styled on their own).
  // A badge's copy waits there too: in a row sliding to its new place, a transformed ancestor would carry it off.
  if (kind === "toast" || kind === "badge") {
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
 * Rows of a list (matched by `selector`, told apart by their `attr`) slide to their new places when `change`
 * changes, and rows new to it fade up in. Nothing moves when `context` changed too: a filter typed, a group
 * folded or unfolded, a different view — those redraw at once. Positions are layout offsets, read after every
 * render, so a row that's mid-slide is measured where it really is.
 */
export function useFlipRows(ref: RefObject<HTMLElement>, selector: string, attr: string, change: string, context: string): void {
  const last = useRef<{ at: Map<string, number>; change: string; context: string }>({ at: new Map(), change, context });
  useLayoutEffect(() => {
    const root = ref.current;
    const prev = last.current;
    const animate = !!root && prev.at.size > 0 && change !== prev.change && context === prev.context;
    const at = new Map<string, number>();
    for (const el of root?.querySelectorAll<HTMLElement>(selector) ?? []) {
      const key = el.getAttribute(attr);
      if (!key) continue;
      const y = el.offsetTop;
      at.set(key, y);
      if (!animate) continue;
      const was = prev.at.get(key);
      if (was === undefined) play(el, [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: D.s, easing: EASE.enter });
      else if (Math.abs(was - y) > 0.5) play(el, [{ transform: `translateY(${was - y}px)` }, { transform: "none" }], { ...springTiming(), composite: "add" });
    }
    last.current = { at, change, context };
  });
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

/**
 * A ref for a badge rendered with a `key` of what it says: when that changes, the old badge fades out on a copy
 * while the new one fades in. Its first showing doesn't animate (a pane or view opening shows what's there).
 */
export function useCrossfade<T extends HTMLElement>(): (el: T | null) => void {
  const shown = useRef(false);
  return usePresence<T>("badge", {
    instant: () => {
      const first = !shown.current;
      shown.current = true;
      return first;
    },
  });
}

// ---- values that change in place: bars, presence, arrivals, a session changing hands ----

/** Nothing plays into a hidden window: its animations would all be finished, unseen, when it's shown. */
const visible = () => mode !== "off" && hasDom && !document.hidden;

/** The smallest change of a bar (in percentage points) that animates; smaller ones just land, unseen. */
export const FILL_STEP = 1;

/** A bar going from `was` to `now` (0–100) moves visibly: not its first reading, nor a poll that changed nothing. */
export const fillMoves = (was: number | null, now: number): boolean => was !== null && Math.abs(now - was) >= FILL_STEP;

/** The scaleX a running animation has an element at, or null when none is running. */
function runningScaleX(el: Element): number | null {
  if (!el.getAnimations().some((a) => a.playState === "running")) return null;
  const m = getComputedStyle(el).transform.match(/^matrix\(([^,]+)/);
  return m ? Number(m[1]) : null;
}

/**
 * A bar's fill (sized by width, always at its value) springs there from its old value when it changes by
 * FILL_STEP or more while showing the same thing: `of` names it, so another session's context window lands at
 * once. The motion is a transform from the old width, so nothing is laid out again as it plays. Under reduce a
 * bar just lands.
 */
export function useFill<T extends HTMLElement>(pct: number, of = ""): RefObject<T> {
  const ref = useRef<T>(null);
  const last = useRef<{ pct: number; of: string } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const prev = last.current;
    last.current = el ? { pct, of } : null;
    if (!el || !prev || prev.of !== of || !fillMoves(prev.pct, pct) || !visible()) return;
    // one already moving starts from where it is: its scale is of the old width
    const from = prev.pct * (runningScaleX(el) ?? 1);
    for (const a of el.getAnimations()) a.cancel();
    if (pct <= 0) return; // an empty bar has no width to scale
    play(el, [{ transform: `scaleX(${from / pct})` }, { transform: "none" }], springTiming());
  }, [pct, of]);
  return ref;
}

/**
 * A teammate coming online: their presence dot grows in and fades up, and their row eases in. Going offline,
 * the dot settles to grey from slightly smaller; the row stays put. `pseudo` when the dot is the row's ::before.
 */
export function presenceTurn(row: HTMLElement, dot: HTMLElement | null, on: boolean, pseudo?: string): void {
  if (!visible()) return;
  const target = dot ?? row;
  const o = pseudo ? { pseudoElement: pseudo } : {};
  if (on) {
    play(target, [{ opacity: 0, transform: "scale(0.4)" }, { opacity: 1, transform: "none" }], { ...springTiming(), ...o });
    play(row, [{ opacity: 0.5, transform: "translateX(-4px)" }, { opacity: 1, transform: "none" }], { duration: D.m, easing: EASE.enter });
  } else {
    play(target, [{ opacity: 0.4, transform: "scale(0.7)" }, { opacity: 1, transform: "none" }], { duration: D.m, easing: EASE.move, ...o });
  }
}

/**
 * Items of a list (matched by `selector`, told apart by their `attr`) that are on or off — a teammate connected
 * or not — call `turn` when that flips. Never on the first render, nor for an item new to the list: whoever is
 * already there when a view opens doesn't move. Read after every render, so it needs no deps.
 */
export function useTurns(ref: RefObject<HTMLElement>, selector: string, attr: string, isOn: (el: HTMLElement) => boolean, turn: (el: HTMLElement, on: boolean) => void): void {
  const last = useRef<Map<string, boolean> | null>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return void (last.current = null);
    const prev = last.current;
    const now = new Map<string, boolean>();
    for (const el of root.querySelectorAll<HTMLElement>(selector)) {
      const key = el.getAttribute(attr);
      if (!key) continue;
      const on = isOn(el);
      now.set(key, on);
      const was = prev?.get(key);
      if (was !== undefined && was !== on) turn(el, on);
    }
    last.current = now;
  });
}

/** Calls `onChange(was, now)` when `value` changes after the first render (compared with Object.is). */
export function useChange<V>(value: V, onChange: (was: V, now: V) => void): void {
  const last = useRef<{ v: V } | null>(null);
  const f = useRef(onChange);
  f.current = onChange;
  useLayoutEffect(() => {
    const prev = last.current;
    last.current = { v: value };
    if (prev && !Object.is(prev.v, value)) f.current(prev.v, value);
  }, [value]);
}

/** More than this many entries at once is catching up (a reconnect, a sync), not someone talking: they just appear. */
export const ARRIVALS_MAX = 3;

/**
 * Which entries of a chat arrived since it was last drawn and should slide in: those after the last entry seen,
 * written by someone else. None the first time it's drawn (that's history), none of one's own (sent, it's
 * there at once), none when the list was replaced, and none when more than ARRIVALS_MAX came together.
 */
export function chatArrivals(seen: readonly string[] | null, entries: readonly { id: string; author: string }[], self: string): string[] {
  if (!seen) return [];
  const at = seen.length ? entries.findIndex((e) => e.id === seen[seen.length - 1]) : -1;
  if (seen.length && at < 0) return [];
  const known = new Set(seen);
  const fresh = entries.slice(at + 1).filter((e) => !known.has(e.id));
  if (fresh.length > ARRIVALS_MAX) return [];
  return fresh.filter((e) => e.author !== self).map((e) => e.id);
}

/**
 * A chat's new entries slide up and fade in (chatArrivals says which). `entries` is null until the chat has been
 * read; each entry's element carries `data-entry` with its id.
 */
export function useChatArrivals(ref: RefObject<HTMLElement>, entries: readonly { id: string; author: string }[] | null, self: string): void {
  const seen = useRef<string[] | null>(null);
  useLayoutEffect(() => {
    if (!entries) return;
    const ids = chatArrivals(seen.current, entries, self);
    seen.current = entries.map((e) => e.id);
    const root = ref.current;
    if (!root || !ids.length || !visible()) return;
    for (const id of ids) {
      const el = root.querySelector<HTMLElement>(`[data-entry="${CSS.escape(id)}"]`);
      if (el) play(el, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: D.m, easing: EASE.enter });
    }
  }, [entries, entries?.length, entries?.at(-1)?.id, self]); // a list added to in place is still news
}

/** How long after a session changes hands its pane still marks it when first drawn (it may be shown a moment later). */
export const HANDOVER_FRESH_MS = 15_000;

/** A hand-over at `at` is news for a pane drawn at `now`: it happened moments ago, not before the app opened. */
export const handoverFresh = (at: number | null | undefined, now: number): at is number => typeof at === "number" && now - at >= -1000 && now - at < HANDOVER_FRESH_MS;

/**
 * A session that just changed hands (taken over, or handed over): its pane's ring pulses once and the note
 * saying so (`[data-handover]`) eases in. The ring is the pane's ::after, over everything: the terminal under
 * it never moves. Under reduce, only the note fades in.
 */
export function handoverPulse(pane: HTMLElement): void {
  if (!visible()) return;
  if (mode === "full") play(pane, [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration: D.l, easing: "linear", pseudoElement: "::after" });
  for (const note of pane.querySelectorAll<HTMLElement>("[data-handover]")) play(note, [{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: D.m, easing: EASE.enter });
}

/** The pane (by `ref`) marks a hand-over at `at` once, while it's fresh (handoverFresh). */
export function useHandover(ref: RefObject<HTMLElement>, at: number | null | undefined): void {
  const played = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!handoverFresh(at, Date.now()) || played.current === at) return;
    played.current = at;
    if (ref.current) handoverPulse(ref.current);
  }, [at]);
}
