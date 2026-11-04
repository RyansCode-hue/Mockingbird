import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatTokens, sanitizeSegment, totalTokens, type SessionInfo, type SessionMeter } from "../shared/types";
import { LANDSCAPE_FONT, LOOSE_GROUP, boundsOf, type Camera, type Landscape as Stored, type LandscapePatch, type LandscapeProblem, type Rect, type Size } from "../shared/landscape";
import type { Migrating } from "./useLandscape";
import {
  BAND_SETTLE_MS,
  PEEK_HOVER_MS,
  REVEAL_WAIT_MS,
  ZOOM_MAX,
  ZOOM_MIN,
  accentOf,
  accentsOf,
  areaAt,
  areaCamera,
  areaCounts,
  areaInView,
  areaSummary,
  attaches,
  cameraFrom,
  centreOn,
  centredAt,
  contentRects,
  fitBelow,
  flightAt,
  fromMinimap,
  inView,
  keysOnScreen,
  looseStop,
  minimapBlocks,
  minimapFit,
  nearestInDirection,
  nextBand,
  panBy,
  peekBox,
  planMakeArea,
  planMoveArea,
  planMoveTile,
  rectFrom,
  revealTile,
  sessionsOnScreen,
  shortAreaName,
  takesKeys,
  tilesIn,
  toLandscape,
  toMinimap,
  undoOf,
  wheelPixels,
  wheelZoomFactor,
  worldTransform,
  zoomAbout,
  type AreaCounts,
  type AreaPlan,
  type AreaView,
  type Band,
  type Direction,
  type GroupMove,
  type PendingReveal,
  type Point,
  type ResolvedLayout,
  type Tile,
} from "./landscapeModel";
import { WorkspaceNode, type NodeMode } from "./WorkspaceNode";
import { kindLabel } from "./WorkspaceCard";
import { AreaFrame } from "./AreaFrame";
import { AreaSwitcher } from "./AreaTree";
import type { MenuEntry } from "./ContextMenu";
import { focusTerm, lendTerm, screenText, scrollTerm } from "./TerminalPane";
import { StatusDot } from "./StatusDot";
import { titleOf } from "./appModel";
import { D, EASE, fromKeyboard, motion, play } from "./motion";
import { OVERLAYS, escapeLeavesFullscreen } from "./keys";
import { readPref, writePref } from "./prefs";
import { isRemote } from "./team/RoomLive";

/** Where this window's camera was, kept between launches: a view preference, never part of landscape.json. */
export const CAMERA_PREF = "mb.landscape.camera";
const CAMERA_SAVE_MS = 250;
const ARROWS: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
/**
 * Whether a workspace's terminal takes the mouse at `zoom`: only at 100%. Scaled, xterm would put a press on the
 * wrong cell (it measures the scaled screen against its unscaled cell), so a selection or a click reported to the
 * program would land elsewhere; a press there selects the workspace instead, and focus gives the mouse back.
 */
export const mouseAt = (zoom: number): boolean => Math.abs(zoom - 1) <= 0.001;
/** The dot grid's spacing in landscape px; four times that when zoomed far out, so it stays a texture. */
const DOTS = 32;

type CameraListener = (cam: Camera) => void;

/** What the landscape asks its owner (main.tsx) for each area: the group's own bar and chips, and its ⋯ menu. */
export interface AreaHooks {
  /** Its header bar (GroupBar.tsx's AreaHeader); a press on its bare part calls `onGrab`, which moves the area. */
  header: (a: AreaView, counts: AreaCounts, onGrab: (e: React.PointerEvent) => void) => React.ReactNode;
  /** Beside its name zoomed out: its ticket's "#5101 · Local test", and "Shared room with Nick" for a room's. */
  info: (key: string) => { ticketChip: string | null; shared: string | null };
  menu: (key: string) => MenuEntry[];
}

/** A gesture's plan that can be carried out. */
export type ReadyPlan = Exclude<AreaPlan, { refused: string }>;

/** Setting a gesture's groups stopped: what to say, and how many of its moves were made first. */
export interface MovesFailed {
  said: string;
  moved: number;
}

/** How far a press moves before it's a drag (a marquee, a workspace or an area moving) rather than a click. */
const DRAG_PX = 4;
/** The area switcher's strip along the view's top (styles.css .ls-switcher: 14px down, 32px tall), and a gap under it. */
const SWITCHER_STRIP = 56;
/** How long a note about a gesture (why it was refused, what it left out) stays up. */
const NOTE_MS = 5000;
/** How long a dropped workspace or area waits, where it was dropped, for the layout that has it there. */
const SETTLE_MS = 1500;

/**
 * A press that may become a drag: a marquee over the bare landscape, a workspace by its header (or a card), or an
 * area by its header. `on` once it has moved DRAG_PX; `els` are what move with it until the layout has them there.
 */
interface Gesture {
  kind: "marquee" | "tile" | "area";
  id: number;
  x0: number;
  y0: number;
  /** The workspace's or the area's key ("" for a marquee). */
  key: string;
  /** A marquee with Shift held adds to the selection, `base` as it was when it started. */
  add: boolean;
  base: string[];
  on: boolean;
  els: HTMLElement[];
}

/** A drop waiting for the layout: its elements keep their drag offset until `moved` says the layout has them there. */
interface Settling {
  els: HTMLElement[];
  moved: () => boolean;
}

const release = (els: readonly HTMLElement[]) => {
  for (const el of els) {
    el.style.translate = "";
    el.classList.remove("dragging");
  }
};

/**
 * A workspace's peek: its box in the viewport as it was when it opened and, while the band attaches terminals, the
 * screen as text for the workspace to show meanwhile. It's of one terminal: a stack's front changing, or the session
 * given a new terminal (termKey), ends it.
 */
interface Peeked {
  key: string;
  front: string;
  gen: string;
  /** Space kept it open: moving away no longer closes it. */
  pinned: boolean;
  box: Rect;
  snap: string | null;
}

/**
 * The landscape (docs/landscape.md): the Sessions tab's surface, panned and
 * zoomed. The world is one layer moved by a CSS transform, written straight
 * to the element: the camera isn't React state, so panning and zooming never
 * re-render a workspace, and a transform changes no layout, so no terminal is
 * re-fitted and no pty resized. Its keys work only while the surface itself
 * has the keyboard, never while a terminal does, except ⌘E and ⌘Esc (no
 * terminal program gets ⌘ keys) to focus and leave focus.
 *
 * Semantic zoom (S3): the zoom's band decides what workspaces are, and only
 * a band change or a workspace coming on screen or leaving it re-renders
 * them. Terminals are attached only to workspaces on screen in the live and
 * read-only bands; the rest are cards or bare frames, their terminals kept
 * current by the data pump and at their workspaces' sizes (holdSize), so
 * attaching one again is instant and resizes nothing.
 *
 * Areas (S4): each group's area is drawn by AreaFrame, its header the group's
 * bar; it collapses to a pill (its workspaces then off screen) and locks. A
 * marquee over the bare landscape picks workspaces for Make area… (M); a
 * workspace dragged by its header, or an area by its own, moves, and a
 * workspace dropped in another area joins its group. Going to an area flies
 * the camera there through `apply`, so the band and what's on screen follow
 * it; the minimap and the switcher (with the area tree hidden) go there too.
 */
export function Landscape({
  layout,
  stored,
  selected,
  onSelect,
  onTab,
  reveal,
  goTo,
  onHandled,
  areaTitle,
  stackName,
  areas: areaHooks,
  meters,
  termKey,
  body,
  onPatch,
  onMoves,
  askAreaName,
  onSeen,
  switcher,
  onShowTree,
}: {
  layout: ResolvedLayout;
  /** landscape.json as this window has it: what gestures' plans are made against. */
  stored: Stored;
  /** The selected session (the window's focused one); its workspace is selected. */
  selected: string | null;
  onSelect: (id: string) => void;
  onTab: (tile: Tile, id: string) => void;
  /** Bring this session's workspace into view and select it, with `focus` filling the window with it. */
  reveal: { id: string; n: number; focus?: boolean } | null;
  /** Fly to this area. */
  goTo: { area: string; n: number } | null;
  /** A reveal or a go-to (by its `n`) has been taken up: the owner lets go of it, so a landscape mounted again doesn't repeat it. */
  onHandled: (n: number) => void;
  areaTitle: (key: string) => string;
  stackName: (stack: string) => string;
  areas: AreaHooks;
  meters?: Record<string, SessionMeter>;
  /** A session's terminal's generation: it changes when a restart gives the session a new terminal. */
  termKey: (id: string) => string;
  /** A session's terminal at `size`; in focus, filling the window, `home` is its workspace's own size, which it goes back to. */
  body: (s: SessionInfo, size: Size, home: Size | null) => React.ReactNode;
  /** Change landscape.json; why it was refused (also in the banners), or null once it's made. */
  onPatch: (patch: LandscapePatch, what: string) => Promise<string | null>;
  /** Set these sessions' groups, in order, stopping at the first that can't be: what to say and how many were, or null. */
  onMoves: (moves: readonly GroupMove[], what: string) => Promise<MovesFailed | null>;
  /** A name for the area Make area… makes of `count` workspaces; null when it's cancelled. */
  askAreaName: (count: number) => Promise<string | null>;
  /** The sessions on screen, for teamLiveView: each workspace's on screen and the one in focus, never a collapsed area's. */
  onSeen: (ids: string[]) => void;
  /** The area switcher over the landscape, while the area tree is hidden (design M). */
  switcher: boolean;
  onShowTree: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const [saved] = useState(() => cameraFrom(readPref<unknown>(CAMERA_PREF, null)));
  const cam = useRef<Camera>(saved ?? { x: 0, y: 0, zoom: 1 });
  const placed = useRef(saved !== null);
  const listeners = useRef(new Set<CameraListener>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [vp, setVp] = useState<Size | null>(null);
  const vpNow = useRef<Size>({ w: 0, h: 0 });
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const space = useRef(false);
  /** The hand cursor: ready while Space is held, on while dragging. A class on the viewport, not state: it re-renders nothing. */
  const grab = (state: "" | "ready" | "on") => {
    const v = viewport.current;
    v?.classList.toggle("grab-ready", state === "ready");
    v?.classList.toggle("grab-on", state === "on");
  };

  const tileOf = (id: string | null): Tile | undefined => (id ? layout.tiles.find((t) => t.members.some((m) => m.id === id)) : undefined);
  const sel = tileOf(selected);
  const selKey = useRef<string | null>(null);
  selKey.current = sel?.key ?? null;
  const focusTile = focusKey ? layout.tiles.find((t) => t.key === focusKey) : undefined;
  const focusNow = useRef<string | null>(null);
  focusNow.current = focusTile ? focusKey : null;
  const layoutNow = useRef(layout);
  layoutNow.current = layout;
  const storedNow = useRef(stored);
  storedNow.current = stored;
  const asks = useRef({ onPatch, onMoves, askAreaName, areaTitle, onSeen, onHandled });
  asks.current = { onPatch, onMoves, askAreaName, areaTitle, onSeen, onHandled };

  // areas: the marquee's selection, the area a dragged workspace would join, and a note on the last gesture
  const [picked, setPicked] = useState<string[]>([]);
  const pickedNow = useRef(picked);
  pickedNow.current = picked;
  const [hot, setHot] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; n: number } | null>(null);
  const say = (text: string) => setNote((p) => ({ text, n: (p?.n ?? 0) + 1 }));
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note?.n]);
  const gesture = useRef<Gesture | null>(null);
  const marquee = useRef<HTMLDivElement>(null);
  const settling = useRef<Settling[]>([]);
  // a flight to an area: the clock animation whose progress moves the camera, and the frame that reads it
  const flight = useRef<{ anim: Animation; raf: number } | null>(null);
  const clock = useRef<HTMLDivElement>(null);

  // semantic zoom: the band the camera's zoom is in, changed only once a new one has held for a moment
  const [band, setBand] = useState<Band>(() => nextBand(cam.current.zoom, null));
  const bandNow = useRef(band);
  /** The zoom is moving: the timer that settles the band, and looks at what's on screen, once it rests. */
  const bandWait = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomWas = useRef(cam.current.zoom);
  // the workspaces on screen (with a margin), as one string so a pan that changes nothing re-renders nothing
  const [seen, setSeen] = useState("");
  const seenNow = useRef(seen);
  const seenSet = useMemo(() => new Set(seen.split("\n")), [seen]);
  const [peek, setPeek] = useState<Peeked | null>(null);
  const peekNow = useRef(peek);
  peekNow.current = peek;
  /** The workspace the pointer is on, and the timer that opens its peek once it has rested there. */
  const hover = useRef<{ key: string | null; timer: ReturnType<typeof setTimeout> | null }>({ key: null, timer: null });

  /** The band's class on the viewport, set here rather than rendered: the viewport's other classes are set the same way. */
  const markBand = (b: Band) => {
    const v = viewport.current;
    for (const x of ["live", "readonly", "cards"] as const) v?.classList.toggle(`ls-band-${x}`, x === b);
  };
  const commitBand = (b: Band) => {
    if (b === bandNow.current) return;
    bandNow.current = b;
    markBand(b);
    // a terminal that had the keyboard keeps it no longer: the landscape takes it
    if (!takesKeys(b) && document.activeElement?.closest(".ls-world .xterm, .ls-peek .xterm")) viewport.current?.focus({ preventScroll: true });
    const p = peekNow.current;
    // a peek kept open across the change: its workspace's stand-in is the screen while terminals attach, a card otherwise
    if (p) setPeek(b === "live" ? null : { ...p, snap: attaches(b) ? screenText(p.front) : null });
    setBand(b);
  };
  /**
   * The zoom changed. Into cards at once: that only lets terminals go, and waiting would attach every workspace a
   * zoom-out brought on screen for nothing (a first fit, ⌘0). Any other band once the zoom has rested for
   * BAND_SETTLE_MS since it last moved, and only then is what's on screen looked at (`looked`): a pinch attaches
   * nothing it passes, in any band, until it rests.
   */
  const zoomed = (zoom: number) => {
    const want = nextBand(zoom, bandNow.current);
    if (!attaches(want)) commitBand(want);
    if (bandWait.current) clearTimeout(bandWait.current);
    bandWait.current = setTimeout(() => {
      bandWait.current = null;
      commitBand(nextBand(cam.current.zoom, bandNow.current));
      looked();
    }, BAND_SETTLE_MS);
  };
  const looked = () => {
    const v = vpNow.current;
    // before a window's first fit the camera is a stand-in: nothing is on screen until it's placed
    if (!v.w || !placed.current) return;
    // cards cost no terminal, so they follow a zoom or a flight as it moves; terminals wait for it to rest
    if ((bandWait.current || flight.current) && attaches(bandNow.current)) return;
    const keys = keysOnScreen(layoutNow.current.tiles, cam.current, v).join("\n");
    if (keys === seenNow.current) return;
    seenNow.current = keys;
    setSeen(keys);
  };
  const closePeek = () => {
    if (peekNow.current) setPeek(null);
  };
  const stopHover = () => {
    if (hover.current.timer) clearTimeout(hover.current.timer);
    hover.current = { key: null, timer: null };
  };

  /**
   * Areas' outlines, headers and names, pills, and cards' type keep their screen size: --ls-inv is 1/zoom, and
   * --ls-hs that never below 1 (an area's header and pill, which don't shrink past 100% zoomed in). Set on each,
   * never on the world, whose terminals would all have their styles recalculated.
   */
  const paintScale = (zoom: number) => {
    const inv = String(1 / zoom);
    const hs = String(Math.max(1, 1 / zoom));
    for (const el of world.current?.querySelectorAll<HTMLElement>(".ls-area, .ls-area-pill, .ls-node.card") ?? []) {
      el.style.setProperty("--ls-inv", inv);
      el.style.setProperty("--ls-hs", hs);
    }
  };
  const apply = useCallback((next: Camera) => {
    cam.current = next;
    const w = world.current;
    const v = viewport.current;
    if (w) {
      w.style.transform = worldTransform(next);
      paintScale(next.zoom);
    }
    if (v) {
      v.classList.toggle("ls-mouse-off", !mouseAt(next.zoom));
      const step = DOTS * next.zoom * (next.zoom < 0.4 ? 4 : 1);
      v.style.backgroundSize = `${step}px ${step}px`;
      v.style.backgroundPosition = `${-next.x * next.zoom}px ${-next.y * next.zoom}px`;
    }
    if (next.zoom !== zoomWas.current) {
      zoomWas.current = next.zoom;
      zoomed(next.zoom);
    }
    looked();
    // a peek belongs to where the pointer rested: moving the landscape ends it, unless Space kept it
    stopHover();
    if (peekNow.current && !peekNow.current.pinned) closePeek();
    for (const l of listeners.current) l(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => writePref(CAMERA_PREF, cam.current), CAMERA_SAVE_MS);
  }, []);
  useEffect(
    () => () => {
      if (bandWait.current) clearTimeout(bandWait.current);
      stopHover();
    },
    []
  );
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      writePref(CAMERA_PREF, cam.current);
    },
    []
  );
  useLayoutEffect(() => {
    markBand(bandNow.current);
    apply(cam.current);
  }, []);

  // the viewport's size: what fitting, centring and focus fill, and what's on screen
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => {
      if (!el.clientWidth || !el.clientHeight) return;
      const next = { w: el.clientWidth, h: el.clientHeight };
      vpNow.current = next;
      setVp((p) => (p && p.w === next.w && p.h === next.h ? p : next));
      looked();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- flying: going to an area, or to a workspace out of view ----
  const endFlight = () => {
    const f = flight.current;
    if (!f) return null;
    flight.current = null;
    cancelAnimationFrame(f.raf);
    viewport.current?.removeAttribute("data-flying");
    return f;
  };
  /** A flight stopped where it is: the user took the camera (a wheel, a press, a key). */
  const stopFly = () => {
    const f = endFlight();
    if (!f) return;
    f.anim.cancel();
    looked();
  };
  /**
   * Move the camera to `to` through `apply`, eased over D.l: the band and what's on screen follow it, and a band that
   * attaches terminals attaches only where it ends (looked waits, and the band waits for the zoom to rest). Under
   * reduced motion, or after a key (the palette, the switcher by keyboard), it's there at once. The camera follows a
   * clock animation's progress, so finishing that animation (as the motion audit does) ends the flight at `to`.
   */
  const flyTo = (to: Camera) => {
    stopFly();
    const v = vpNow.current;
    const el = clock.current;
    if (!el || !v.w || motion() !== "full" || fromKeyboard() || document.hidden || typeof el.animate !== "function") return apply(to);
    const from = cam.current;
    const anim = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: D.l, easing: EASE.move });
    const f = { anim, raf: 0 };
    flight.current = f;
    viewport.current?.setAttribute("data-flying", "");
    const step = () => {
      if (flight.current !== f) return;
      const p = anim.effect?.getComputedTiming().progress;
      apply(flightAt(from, to, v, typeof p === "number" ? p : 0));
      f.raf = requestAnimationFrame(step);
    };
    f.raf = requestAnimationFrame(step);
    // cancelled by stopFly or a newer flight, which left the camera where it wanted it; cancelled by anything else
    // (the animation taken away), it ends at `to` as finishing would
    const done = () => {
      if (flight.current !== f) return;
      endFlight();
      apply(to);
    };
    anim.finished.then(done, done);
  };
  const flyRef = useRef(flyTo);
  flyRef.current = flyTo;
  const stopFlyRef = useRef(stopFly);
  stopFlyRef.current = stopFly;
  useEffect(() => () => void endFlight()?.anim.cancel(), []);

  /** The strip along the view's top that fitting and going to an area leave clear: the area switcher's, while it shows. */
  const topNow = useRef(0);
  topNow.current = switcher ? SWITCHER_STRIP : 0;
  const fit = useCallback(() => {
    stopFlyRef.current();
    const rects = contentRects(layoutNow.current);
    if (rects.length && vpNow.current.w) apply(fitBelow(rects, vpNow.current, topNow.current));
  }, []);
  // a window that has never shown the landscape starts with everything in view
  useEffect(() => {
    if (placed.current || !vp || !layout.tiles.length) return;
    placed.current = true;
    fit();
  }, [vp, layout.tiles.length]);

  // workspaces and areas added, moved, resized, collapsed or opened: what's on screen, their type's scale, and drops
  // the layout now has where they were dropped
  useLayoutEffect(() => {
    paintScale(cam.current.zoom);
    looked();
    settling.current = settling.current.filter((s) => {
      if (!s.moved()) return true;
      release(s.els);
      return false;
    });
  }, [layout]);
  useLayoutEffect(() => paintScale(cam.current.zoom), [band]);

  const zoomTo = (zoom: number, at?: { x: number; y: number }) => {
    stopFly();
    apply(zoomAbout(cam.current, at ?? { x: vpNow.current.w / 2, y: vpNow.current.h / 2 }, zoom));
  };

  const select = (t: Tile) => onSelect(t.front.id);
  /** The keyboard to the landscape: the surface, or in focus the focused workspace's frame (so Esc reaches it). */
  const surface = () => (focusNow.current ? overlay.current : viewport.current)?.focus({ preventScroll: true });
  const enterFocus = (t: Tile) => {
    stopHover();
    setPeek(null);
    setFocusKey(t.key);
    select(t);
    // your own terminal takes the keyboard; a teammate's waits for a click, as it does in the grid
    setTimeout(() => (!isRemote(t.front) && t.front.status !== "dead" ? focusTerm(t.front.id) : overlay.current?.focus({ preventScroll: true })), 50);
  };
  const leaveFocus = () => {
    setFocusKey(null);
    // the terminal's element moves back into its workspace on the next render; the keyboard comes back here
    setTimeout(() => viewport.current?.focus({ preventScroll: true }), 0);
  };
  const selectRef = useRef(select);
  selectRef.current = select;
  const enterRef = useRef(enterFocus);
  enterRef.current = enterFocus;
  const leaveRef = useRef(leaveFocus);
  leaveRef.current = leaveFocus;
  // a workspace that leaves (closed, or merged into a stack) ends its focus, and its peek
  useEffect(() => {
    if (focusKey && !focusTile) setFocusKey(null);
  }, [focusKey, focusTile]);
  const peekTile = peek ? layout.tiles.find((t) => t.key === peek.key) : undefined;
  // its workspace left or exited, its stack brought another tab to the front, or its session got a new terminal
  const peekGone = !!peek && (!peekTile || peekTile.front.status === "dead" || peekTile.front.id !== peek.front || termKey(peek.front) !== peek.gen);
  useEffect(() => {
    if (peekGone) setPeek(null);
  }, [peekGone]);

  /** Open a workspace's peek: below 75%, not in focus, and never for one that has exited (it has no live terminal). */
  const openPeek = (key: string) => {
    const t = layoutNow.current.tiles.find((x) => x.key === key);
    if (!t || takesKeys(bandNow.current) || focusNow.current || t.front.status === "dead" || !vpNow.current.w) return;
    const front = t.front.id;
    setPeek({ key, front, gen: termKey(front), pinned: false, box: peekBox(cam.current, vpNow.current, t.rect), snap: attaches(bandNow.current) ? screenText(front) : null });
  };
  const openPeekRef = useRef(openPeek);
  openPeekRef.current = openPeek;

  // reveal: the sidebar, ⌘K or a notification picked a session. One made a moment ago may not be in the layout
  // yet: the reveal waits for it, tried again as the layout changes, and is given up (and said) after a while.
  const pendingReveal = useRef<PendingReveal | null>(null);
  /** The pending reveal ends in focus. */
  const revealFocus = useRef(false);
  const gaveUp = (p: PendingReveal) => console.warn(`[mockingbird] the landscape couldn't bring ${p.id} into view: no workspace holds it after ${REVEAL_WAIT_MS} ms`);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (revealTimer.current && clearTimeout(revealTimer.current)), []);
  useEffect(() => {
    if (!reveal) return;
    // taken up: the owner lets go of it, so this landscape mounted again (another tab and back) doesn't repeat it
    asks.current.onHandled(reveal.n);
    revealFocus.current = !!reveal.focus;
    const p = (pendingReveal.current = { id: reveal.id, until: Date.now() + REVEAL_WAIT_MS });
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(() => {
      if (pendingReveal.current !== p) return;
      pendingReveal.current = null;
      gaveUp(p);
    }, REVEAL_WAIT_MS + 50);
  }, [reveal?.n]);
  /** The collapsed area a reveal opened, while the layout doesn't have it open yet. */
  const opening = useRef<string | null>(null);
  useEffect(() => {
    const p = pendingReveal.current;
    if (!p) return;
    const t = revealTile(p, layout.tiles, Date.now());
    if (t === "wait") return;
    if (t !== "expired" && t.hidden) {
      // in a collapsed area: the area opens, and the reveal goes on once the layout has it open
      if (opening.current === t.area) return;
      opening.current = t.area;
      const title = asks.current.areaTitle(t.area);
      void asks.current.onPatch({ areas: { [t.area]: { collapsed: false } } }, `${title} opened`).then((error) => {
        if (!error || pendingReveal.current !== p) return;
        pendingReveal.current = null;
        opening.current = null;
        say(`${title} couldn't be opened to show the workspace: ${error}`);
      });
      return;
    }
    pendingReveal.current = null;
    opening.current = null;
    if (t === "expired") return gaveUp(p);
    const seen = !vpNow.current.w || inView(cam.current, t.rect, vpNow.current);
    if (revealFocus.current) {
      // under the focus overlay, so there's no flight to see: the landscape is there when focus ends
      if (!seen) {
        stopFly();
        apply(centreOn(cam.current, t.rect, vpNow.current));
      }
      return enterFocus(t);
    }
    if (focusNow.current && focusNow.current !== t.key) setFocusKey(null);
    if (!seen) flyTo(centreOn(cam.current, t.rect, vpNow.current));
  }, [reveal?.n, layout]);

  // going to an area: the tree, the switcher, ⌘K. One asked from another tab waits for this landscape's size; taken
  // up, the owner lets go of it
  const hasSize = vp !== null;
  useEffect(() => {
    if (!goTo || !hasSize) return;
    asks.current.onHandled(goTo.n);
    const a = layoutNow.current.areas.find((x) => x.key === goTo.area);
    if (!a) return console.warn(`[mockingbird] the landscape has no area ${goTo.area} to go to`);
    placed.current = true;
    if (focusNow.current) setFocusKey(null);
    flyTo(areaCamera(a, vpNow.current, topNow.current));
  }, [goTo?.n, hasSize]);

  // what's on screen, for teamLiveView
  const seenIds = useMemo(() => sessionsOnScreen(layout.tiles, seenSet, focusTile ? focusTile.key : null).join("\n"), [layout.tiles, seenSet, focusTile?.key]);
  useEffect(() => asks.current.onSeen(seenIds ? seenIds.split("\n") : []), [seenIds]);

  const move = (dir: Direction) => {
    const tiles = layoutNow.current.tiles;
    const v = vpNow.current;
    const from = sel?.rect ?? { x: cam.current.x + v.w / (2 * cam.current.zoom), y: cam.current.y + v.h / (2 * cam.current.zoom), w: 0, h: 0 };
    const key = nearestInDirection(from, tiles.filter((t) => t.key !== sel?.key && !t.hidden), dir);
    const t = key ? tiles.find((x) => x.key === key) : undefined;
    if (!t) return;
    select(t);
    stopFly();
    apply(centreOn(cam.current, t.rect, v));
  };

  // ---- areas: collapse and lock, the marquee's Make area…, and carrying out a gesture's plan ----
  const setAreaFlag = (key: string, flag: "collapsed" | "locked", on: boolean) => {
    const title = areaTitle(key);
    const what = flag === "collapsed" ? `${title} ${on ? "collapsed" : "opened"}` : `${title} ${on ? "locked" : "unlocked"}`;
    void onPatch({ areas: { [key]: flag === "collapsed" ? { collapsed: on } : { locked: on } } }, what).then((error) => error && say(`${what}: not saved, ${error}`));
  };
  /**
   * A plan carried out: its patch, the sessions' groups, then `after` (AreaPlan). `settle`, a drop's elements, keeps
   * them where they were dropped until the layout has them there. Whatever fails is said, and nothing after it is done.
   */
  const carryOut = async (plan: ReadyPlan, what: string, settle?: Settling): Promise<boolean> => {
    const unsettle = () => {
      if (!settle) return;
      settling.current = settling.current.filter((s) => s !== settle);
      release(settle.els);
    };
    if (settle) settling.current.push(settle);
    const before = storedNow.current;
    const error = plan.patch ? await asks.current.onPatch(plan.patch, what) : null;
    if (error || !plan.patch) unsettle();
    else setTimeout(unsettle, SETTLE_MS);
    if (error) {
      say(`${what}: not saved, ${error}`);
      return false;
    }
    if (plan.moves.length) {
      const failed = await asks.current.onMoves(plan.moves, what);
      if (failed) {
        // the places went first: put back those of the sessions still in their old groups (everything, when none moved),
        // or they'd sit in an area they aren't in
        const back = plan.patch && undoOf(before, plan.patch, failed.moved ? plan.moves.slice(failed.moved).map((m) => m.id) : undefined);
        const undoError = back ? await asks.current.onPatch(back, `${what} (putting it back)`) : null;
        say(undoError ? `${failed.said}; and its places couldn't be put back: ${undoError}` : failed.said);
        return false;
      }
    }
    const afterError = plan.after ? await asks.current.onPatch(plan.after, what) : null;
    if (afterError) say(`${what}: its stack's old place wasn't let go, ${afterError}`);
    if (plan.note) say(plan.note);
    return !afterError;
  };
  const makeArea = async () => {
    const keys = pickedNow.current;
    if (!keys.length) return;
    const name = await asks.current.askAreaName(keys.length);
    if (name === null) return;
    const key = sanitizeSegment(name);
    const plan = planMakeArea(storedNow.current, layoutNow.current, keys, key, asks.current.areaTitle);
    if ("refused" in plan) return say(plan.refused);
    if (await carryOut(plan, `the area ${key}`)) setPicked([]);
  };
  const makeRef = useRef(makeArea);
  makeRef.current = makeArea;

  // the surface's own keys: only while it has the keyboard itself
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== viewport.current || focusNow.current) return;
    const cmd = e.metaKey && !e.ctrlKey && !e.altKey;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
      handled();
      if (!space.current) grab("ready");
      space.current = true;
    } else if (cmd && e.key === "0") {
      handled();
      fit();
    } else if (cmd && e.key === "1") {
      handled();
      zoomTo(1);
    } else if (cmd && (e.key === "=" || e.key === "+")) {
      handled();
      zoomTo(cam.current.zoom * 1.25);
    } else if (cmd && e.key === "-") {
      handled();
      zoomTo(cam.current.zoom / 1.25);
    } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && sel) {
      handled();
      enterFocus(sel);
    } else if (e.altKey && !e.metaKey && !e.ctrlKey && ARROWS[e.key]) {
      handled();
      move(ARROWS[e.key]);
    } else if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "m" && pickedNow.current.length) {
      handled();
      void makeArea();
    } else if (e.key === "Escape" && !e.metaKey && pickedNow.current.length) {
      handled();
      setPicked([]);
    }
  };

  // A peek's keys, wherever the keyboard is but a text field, a menu or a dialog: Space keeps it open, and closes it
  // once kept; Esc closes it; Enter focuses a kept-open one's workspace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const p = peekNow.current;
      if (!p || e.metaKey || e.ctrlKey || e.altKey || (e.key !== " " && e.key !== "Escape" && !(e.key === "Enter" && p.pinned))) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest("input, textarea:not(.xterm-helper-textarea), select, [contenteditable]") || document.querySelector(OVERLAYS)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") setPeek(null);
      else if (e.key === "Enter") {
        const tile = layoutNow.current.tiles.find((x) => x.key === p.key);
        if (tile) enterRef.current(tile);
      } else if (!e.repeat) setPeek(p.pinned ? null : { ...p, pinned: true });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // ⌘E focuses a workspace, or leaves focus, from anywhere in the window, as the grid's does: from inside a
  // workspace (its terminal, say) that one, from anywhere else (the side bar just picked a session) the selected
  // one. ⌘Esc leaves focus from anywhere. Both are taken before xterm sees them, which would type Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const esc = e.key === "Escape";
      if (!esc && e.key.toLowerCase() !== "e") return;
      if (document.querySelector(OVERLAYS)) return;
      const focused = focusNow.current;
      if (esc && !focused) return;
      const within = (e.target instanceof Element ? e.target : null)?.closest<HTMLElement>(".ls-world .ls-node");
      const key = within?.dataset.ws ?? selKey.current;
      const tile = focused ? null : layoutNow.current.tiles.find((x) => x.key === key);
      if (!focused && !tile) return;
      e.preventDefault();
      e.stopPropagation();
      if (focused) leaveRef.current();
      else if (tile) enterRef.current(tile);
    };
    const offSpace = (e: KeyboardEvent) => {
      if (e.key === " " && space.current) dropSpace();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", offSpace, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", offSpace, true);
    };
  }, []);

  // ---- gestures: the marquee, and moving a workspace or an area ----
  /** A client point in landscape px. */
  const atPoint = (e: { clientX: number; clientY: number }): Point => {
    const r = viewport.current!.getBoundingClientRect();
    return toLandscape(cam.current, { x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const nodeEl = (key: string) => world.current?.querySelector<HTMLElement>(`.ls-node[data-ws="${CSS.escape(key)}"]`) ?? null;
  /** Where a dragged workspace would go: the area under the pointer, LOOSE_GROUP over the bare landscape. */
  const dropArea = (e: PointerEvent): string => areaAt(layoutNow.current.areas, atPoint(e))?.key ?? LOOSE_GROUP;
  /** A drag starting: what moves with it, or false when it can't (said). */
  const begin = (g: Gesture): boolean => {
    const l = layoutNow.current;
    if (g.kind === "marquee") {
      if (marquee.current) marquee.current.hidden = false;
      return true;
    }
    if (g.kind === "tile") {
      const t = l.tiles.find((x) => x.key === g.key);
      const a = t && l.areas.find((x) => x.key === t.area);
      if (!t) return false;
      if (a?.rect.locked) {
        say(`${areaTitle(a.key)} is locked: unlock it to move its workspaces`);
        return false;
      }
      g.els = [nodeEl(t.key)].filter((x): x is HTMLElement => !!x);
    } else {
      const a = l.areas.find((x) => x.key === g.key);
      if (!a) return false;
      if (a.rect.locked) {
        say(`${areaTitle(a.key)} is locked: unlock it to move it`);
        return false;
      }
      const frame = world.current?.querySelector<HTMLElement>(`.ls-area[data-area="${CSS.escape(a.key)}"]`);
      g.els = [frame, ...l.tiles.filter((t) => t.area === a.key).map((t) => nodeEl(t.key))].filter((x): x is HTMLElement => !!x);
    }
    for (const el of g.els) el.classList.add("dragging");
    return true;
  };
  const gestureMove = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.on) {
      if (Math.hypot(dx, dy) < DRAG_PX) return;
      if (!begin(g)) return endGesture();
      g.on = true;
    }
    e.preventDefault();
    if (g.kind === "marquee") {
      const r = viewport.current!.getBoundingClientRect();
      const box = rectFrom({ x: g.x0 - r.left, y: g.y0 - r.top }, { x: e.clientX - r.left, y: e.clientY - r.top });
      const m = marquee.current;
      if (m) Object.assign(m.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
      const keys = tilesIn(layoutNow.current.tiles, rectFrom(atPoint({ clientX: g.x0, clientY: g.y0 }), atPoint(e)));
      const next = g.add ? [...new Set([...g.base, ...keys])] : keys;
      if (next.join("\n") !== pickedNow.current.join("\n")) setPicked(next);
      return;
    }
    const z = cam.current.zoom;
    for (const el of g.els) el.style.translate = `${dx / z}px ${dy / z}px`;
    if (g.kind === "tile") {
      const t = layoutNow.current.tiles.find((x) => x.key === g.key);
      const target = dropArea(e);
      const a = layoutNow.current.areas.find((x) => x.key === target);
      setHot(t && a && target !== t.area && !a.rect.locked ? target : null);
    }
  };
  const gestureUp = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.id) return;
    endGesture();
    if (e.type === "pointercancel") return release(g.els);
    const l = layoutNow.current;
    const z = cam.current.zoom;
    const dx = (e.clientX - g.x0) / z;
    const dy = (e.clientY - g.y0) / z;
    if (g.kind === "marquee") {
      // a click on the bare landscape lets the selection go
      if (!g.on && !g.add) setPicked([]);
      return;
    }
    if (!g.on) return;
    if (g.kind === "tile") {
      const t = l.tiles.find((x) => x.key === g.key);
      if (!t) return release(g.els);
      const plan = planMoveTile(storedNow.current, l, t.key, { x: t.rect.x + dx, y: t.rect.y + dy }, dropArea(e), areaTitle);
      if ("refused" in plan) {
        release(g.els);
        return say(plan.refused);
      }
      const from = t.rect;
      const front = t.front.id;
      void carryOut(plan, `${titleOf(t.front)}'s place`, {
        els: g.els,
        moved: () => {
          const now = layoutNow.current.tiles.find((x) => x.members.some((m) => m.id === front));
          return !now || now.rect.x !== from.x || now.rect.y !== from.y;
        },
      });
      return;
    }
    const a = l.areas.find((x) => x.key === g.key);
    if (!a) return release(g.els);
    const plan = planMoveArea(storedNow.current, l, a.key, dx, dy, areaTitle);
    if ("refused" in plan) {
      release(g.els);
      return say(plan.refused);
    }
    const from = a.rect;
    void carryOut(plan, `${areaTitle(a.key)}'s place`, {
      els: g.els,
      moved: () => {
        const now = layoutNow.current.areas.find((x) => x.key === a.key);
        return !now || now.rect.x !== from.x || now.rect.y !== from.y;
      },
    });
  };
  const gestureKey = (e: KeyboardEvent) => {
    const g = gesture.current;
    if (e.key !== "Escape" || !g?.on) return;
    e.preventDefault();
    e.stopPropagation();
    endGesture();
    release(g.els);
    if (g.kind === "marquee" && !g.add) setPicked([]);
  };
  const handlers = useRef({ move: gestureMove, up: gestureUp, key: gestureKey });
  handlers.current = { move: gestureMove, up: gestureUp, key: gestureKey };
  // the window's listeners for a gesture, the same functions for its whole life so they can be taken off again
  const [listen] = useState(() => ({
    move: (e: PointerEvent) => handlers.current.move(e),
    up: (e: PointerEvent) => handlers.current.up(e),
    key: (e: KeyboardEvent) => handlers.current.key(e),
  }));
  function endGesture() {
    gesture.current = null;
    if (marquee.current) marquee.current.hidden = true;
    setHot(null);
    viewport.current?.classList.remove("ls-gesture");
    window.removeEventListener("pointermove", listen.move, true);
    window.removeEventListener("pointerup", listen.up, true);
    window.removeEventListener("pointercancel", listen.up, true);
    window.removeEventListener("keydown", listen.key, true);
  }
  /** A press that may become a drag. It holds the peek off while it lasts: a press already ended any peek and its hover. */
  const startGesture = (g: Omit<Gesture, "on" | "els">) => {
    if (gesture.current) {
      release(gesture.current.els);
      endGesture();
    }
    stopFly();
    stopHover();
    closePeek();
    gesture.current = { ...g, on: false, els: [] };
    viewport.current?.classList.add("ls-gesture");
    window.addEventListener("pointermove", listen.move, true);
    window.addEventListener("pointerup", listen.up, true);
    window.addEventListener("pointercancel", listen.up, true);
    window.addEventListener("keydown", listen.key, true);
  };
  const startRef = useRef(startGesture);
  startRef.current = startGesture;
  useEffect(() => () => endGesture(), []);
  const grabArea = (key: string, e: React.PointerEvent) => {
    if (e.button !== 0 || space.current || e.shiftKey) return;
    startGesture({ kind: "area", id: e.pointerId, x0: e.clientX, y0: e.clientY, key, add: false, base: [] });
  };

  // pan and zoom: the wheel and pointer, taken before a terminal sees them
  useEffect(() => {
    const v = viewport.current;
    if (!v) return;
    const inFocus = (t: EventTarget | null) => !!(t as Element | null)?.closest?.(".ls-focus");
    /** The workspace whose terminal `e` is on, while terminals on the landscape don't take the mouse (mouseAt). */
    const offTerm = (e: MouseEvent): HTMLElement | null => {
      if (mouseAt(cam.current.zoom)) return null;
      const t = e.target as Element | null;
      return t?.closest?.(".ls-world .ls-term") ? t.closest<HTMLElement>(".ls-node") : null;
    };
    const onWheel = (e: WheelEvent) => {
      if (inFocus(e.target)) return;
      const zooming = e.ctrlKey || e.metaKey;
      const node = (e.target as Element | null)?.closest?.(".ls-node") as HTMLElement | null;
      // the selected workspace's terminal scrolls its own history while it takes the mouse; any other wheel moves the landscape
      if (!zooming && mouseAt(cam.current.zoom) && node && node.dataset.ws === selKey.current && (e.target as Element).closest(".term-holder")) return;
      e.preventDefault();
      e.stopPropagation();
      const page = vpNow.current.h || 800;
      // a kept-open peek scrolls its terminal's history; a zoom over it is the landscape's
      const p = peekNow.current;
      if (!zooming && p?.pinned && (e.target as Element | null)?.closest?.(".ls-peek")) {
        scrollTerm(p.front, wheelPixels(e.deltaY, e.deltaMode, page));
        return;
      }
      stopFlyRef.current();
      if (zooming) {
        const r = v.getBoundingClientRect();
        const c = cam.current;
        apply(zoomAbout(c, { x: e.clientX - r.left, y: e.clientY - r.top }, c.zoom * wheelZoomFactor(wheelPixels(e.deltaY, e.deltaMode, page), e.ctrlKey && !e.metaKey)));
      } else apply(panBy(cam.current, -wheelPixels(e.deltaX, e.deltaMode, page), -wheelPixels(e.deltaY, e.deltaMode, page)));
    };
    // a drag is followed on the window, so it carries on over the side bar and past the window's edge
    let drag: { id: number; x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      apply(panBy(cam.current, e.clientX - drag.x, e.clientY - drag.y));
      drag = { ...drag, x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      grab(space.current ? "ready" : "");
    };
    const onDown = (e: PointerEvent) => {
      if (inFocus(e.target)) return;
      stopHover();
      // a press takes the camera from a flight, and ends a gesture still going (its release never came)
      stopFlyRef.current();
      const g = gesture.current;
      if (g) {
        release(g.els);
        endGesture();
      }
      // a press on its peek is the peek's (a click keeps it open, a double-click focuses); anywhere else ends it, kept or not
      const onPeek = !!(e.target as Element | null)?.closest?.(".ls-peek");
      if (!onPeek) closePeek();
      if (e.button === 1 || (e.button === 0 && space.current)) {
        e.preventDefault();
        e.stopPropagation();
        if (!drag) {
          window.addEventListener("pointermove", onMove, true);
          window.addEventListener("pointerup", onUp, true);
          window.addEventListener("pointercancel", onUp, true);
        }
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
        grab("on");
        return;
      }
      const t = e.target as Element;
      const off = offTerm(e);
      if (off) {
        // the terminal never sees it: its workspace is selected, and the keyboard goes to its terminal as a click on
        // it would, while the band lets terminals take keys; below that the landscape keeps it
        e.preventDefault();
        e.stopPropagation();
        if (e.button !== 0) return;
        const tile = layoutNow.current.tiles.find((x) => x.key === off.dataset.ws);
        if (!tile) return;
        selectRef.current(tile);
        setTimeout(() => (tile.front.status !== "dead" && takesKeys(bandNow.current) ? focusTerm(tile.front.id) : surface()), 0);
        return;
      }
      if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const node = t.closest<HTMLElement>(".ls-world .ls-node");
        const press = { id: e.pointerId, x0: e.clientX, y0: e.clientY, add: e.shiftKey, base: pickedNow.current };
        if (node && (node.classList.contains("card") || t.closest(".ls-head")) && !t.closest("button")) {
          const key = node.dataset.ws!;
          // Shift-click picks it for Make area…, or lets it go; otherwise its header (or its card) moves it
          if (e.shiftKey) setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
          else startRef.current({ ...press, kind: "tile", key });
        } else if (!node && !t.closest(".ls-hud, .ls-banners, .ls-peek, .ls-ah, .ls-area-title, .ls-area-tools, .ls-area-pill, .ls-switcher, .ls-minimap, .ls-pickbar, .ls-note, .ls-empty")) {
          startRef.current({ ...press, kind: "marquee", key: "" });
        }
      }
      // a press on the landscape between workspaces gives it the keyboard
      if (e.button === 0 && !t.closest(".ls-node, .ls-hud, .ls-banners, .ls-peek, .ls-switcher, .ls-minimap, .ls-pickbar")) surface();
    };
    // Below 75% a terminal on the landscape takes no keys, nor ever one lent to a peek: one that still has the
    // keyboard (it had it as the zoom went down) gives it to the landscape, before xterm sees the key.
    const offKeys = (e: KeyboardEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest?.(".ls-peek .xterm") && (takesKeys(bandNow.current) || !t?.closest?.(".ls-world .xterm"))) return;
      e.preventDefault();
      e.stopPropagation();
      surface();
    };
    // The peek: the pointer resting on a card or a read-only workspace opens it, never while dragging, panning or a
    // button is held. Until it's kept open (Space, or a click on it) the pointer leaving that workspace closes it.
    // It covers its workspace, so over it what counts is what's under it at the pointer: hovering it holds nothing
    // open, and moving across it onto another workspace closes it and starts that one's rest. A kept-open one stays.
    const onHover = (e: PointerEvent) => {
      // a marquee or a drag holds the peek off while it lasts
      if (gesture.current) return;
      const p = peekNow.current;
      const over = e.target as Element | null;
      const t = p && !p.pinned && over?.closest?.(".ls-peek") ? (document.elementsFromPoint(e.clientX, e.clientY).find((el) => !el.closest(".ls-peek")) ?? null) : over;
      if (t?.closest?.(".ls-peek")) {
        if (hover.current.timer) clearTimeout(hover.current.timer);
        hover.current = { key: p?.key ?? null, timer: null };
        return;
      }
      const key = t?.closest?.<HTMLElement>(".ls-world .ls-node")?.dataset.ws ?? null;
      if (key === hover.current.key) return;
      stopHover();
      hover.current.key = key;
      if (p && !p.pinned && p.key !== key) closePeek();
      if (!key || p?.key === key || p?.pinned || takesKeys(bandNow.current) || focusNow.current || drag || space.current || e.buttons) return;
      hover.current.timer = setTimeout(() => {
        hover.current.timer = null;
        if (hover.current.key === key && !drag && !space.current) openPeekRef.current(key);
      }, PEEK_HOVER_MS);
    };
    const offHover = () => {
      stopHover();
      if (peekNow.current && !peekNow.current.pinned) closePeek();
    };
    // the rest of a press on a terminal that doesn't take the mouse: nothing reaches xterm or the pane, so nothing is
    // selected, reported to the program or clicked; a double-click focuses the workspace, as on its header
    const offMouse = (e: MouseEvent) => {
      const off = offTerm(e);
      if (!off) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type !== "dblclick" || e.button !== 0) return;
      const tile = layoutNow.current.tiles.find((x) => x.key === off.dataset.ws);
      if (tile) enterRef.current(tile);
    };
    const MOUSE = ["mousedown", "mouseup", "click", "dblclick", "auxclick"] as const;
    // the hint for a terminal that doesn't take the mouse, while the pointer is over one
    const onOver = (e: PointerEvent) => {
      v.classList.toggle("ls-term-hover", !!(e.target as Element | null)?.closest?.(".ls-world .ls-term"));
      onHover(e);
    };
    const onLeave = () => {
      v.classList.remove("ls-term-hover");
      offHover();
    };
    // moving over a peek not kept open: it fires no pointerover while the pointer stays on one of its elements
    const onPeekMove = (e: PointerEvent) => {
      if (peekNow.current && !peekNow.current.pinned && (e.target as Element | null)?.closest?.(".ls-peek")) onHover(e);
    };
    // a middle-button press would otherwise paste (Linux) or start autoscroll
    const onAux = (e: MouseEvent) => e.button === 1 && !inFocus(e.target) && e.preventDefault();
    v.addEventListener("wheel", onWheel, { capture: true, passive: false });
    v.addEventListener("pointerdown", onDown, true);
    v.addEventListener("keydown", offKeys, true);
    v.addEventListener("auxclick", onAux, true);
    for (const type of MOUSE) v.addEventListener(type, offMouse, true);
    v.addEventListener("pointerover", onOver);
    v.addEventListener("pointermove", onPeekMove);
    v.addEventListener("pointerleave", onLeave);
    return () => {
      v.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      v.removeEventListener("pointerdown", onDown, true);
      v.removeEventListener("keydown", offKeys, true);
      v.removeEventListener("auxclick", onAux, true);
      for (const type of MOUSE) v.removeEventListener(type, offMouse, true);
      v.removeEventListener("pointerover", onOver);
      v.removeEventListener("pointermove", onPeekMove);
      v.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, []);

  const pick = (t: Tile, header: boolean) => {
    select(t);
    if (header) setTimeout(surface, 0);
  };
  /** Space let go, or the surface lost the keyboard: a drag already going carries on to its release. */
  const dropSpace = () => {
    space.current = false;
    if (!viewport.current?.classList.contains("grab-on")) grab("");
  };
  /**
   * What a workspace on the landscape shows. A terminal is attached only in a band that attaches them, and only to a
   * workspace on screen (or the selected one, while terminals take keys: the keyboard stays in it as it's panned
   * away); everything behind focus waits, and a workspace whose terminal is lent to its peek shows a stand-in.
   */
  const modeOf = (t: Tile): NodeMode => {
    if (t.key === focusNow.current) return "placeholder";
    // in a collapsed area: not drawn, and nothing attached
    if (t.hidden) return "still";
    if (peek?.key === t.key && !peekGone) return band === "cards" ? "card" : "snapshot";
    if (focusNow.current) return "still";
    if (attaches(band) && (seenSet.has(t.key) || (takesKeys(band) && t.key === sel?.key))) return "live";
    return band === "cards" && seenSet.has(t.key) ? "card" : "still";
  };
  const pickedSet = useMemo(() => new Set(picked), [picked]);
  // a workspace picked that has left (closed, or its area collapsed) is no longer in the selection
  const pickable = useMemo(() => new Set(layout.tiles.filter((t) => !t.hidden).map((t) => t.key)), [layout.tiles]);
  const pickedCount = picked.filter((k) => pickable.has(k)).length;
  useEffect(() => {
    if (picked.some((k) => !pickable.has(k))) setPicked((p) => p.filter((k) => pickable.has(k)));
  }, [pickable]);
  const accents = useMemo(() => accentsOf(layout.areas.map((a) => a.key)), [layout.areas]);
  const areaViews = layout.areas.map((a) => ({ a, accent: accents.get(a.key) ?? accentOf(a.key), counts: areaCounts(layout.tiles, a.key), title: areaTitle(a.key), info: areaHooks.info(a.key) }));
  const loose = useMemo(() => (switcher ? looseStop(layout.tiles) : null), [switcher, layout]);
  const stops = useMemo(() => (loose ? [...layout.areas, loose] : layout.areas), [loose, layout]);

  const node = (t: Tile, mode: NodeMode, size: Size) => (
    <WorkspaceNode
      key={mode === "focus" ? `focus:${t.key}` : t.key}
      tile={t}
      name={t.stack ? stackName(t.stack) : null}
      mode={mode}
      size={size}
      selected={sel?.key === t.key}
      picked={mode !== "focus" && pickedSet.has(t.key)}
      meters={meters}
      snapshot={mode === "snapshot" ? peek?.snap : null}
      inv={1 / cam.current.zoom}
      gen={termKey(t.front.id)}
      onSelect={pick}
      onFocus={enterFocus}
      onBack={leaveFocus}
      onTab={onTab}
      body={(s, sz) => body(s, sz, mode === "focus" ? { w: t.rect.w, h: t.rect.h } : null)}
    />
  );

  return (
    <div className="ls-wrap">
      <div
        ref={viewport}
        className="ls-viewport"
        tabIndex={0}
        aria-label="Landscape — scroll to pan, ⌘-scroll or pinch to zoom, ⌘0 fits everything, ⌘1 is 100%, ⌥-arrows move between workspaces, Enter focuses"
        onKeyDown={onKeyDown}
        onBlur={(e) => e.target === viewport.current && space.current && dropSpace()}
      >
        <div ref={world} className="ls-world">
          {areaViews.map(({ a, accent, counts, title, info }) => (
            <AreaFrame
              key={a.key}
              area={a}
              accent={accent}
              band={band}
              title={title}
              header={band === "cards" || a.rect.collapsed ? null : areaHooks.header(a, counts, (e) => grabArea(a.key, e))}
              ticketChip={info.ticketChip}
              shared={info.shared}
              summary={areaSummary(counts)}
              counts={counts}
              hot={hot === a.key}
              menu={() => areaHooks.menu(a.key)}
              onCollapse={(on) => setAreaFlag(a.key, "collapsed", on)}
              onLock={(on) => setAreaFlag(a.key, "locked", on)}
              onGrab={(e) => grabArea(a.key, e)}
            />
          ))}
          {layout.tiles.map((t) => node(t, modeOf(t), { w: t.rect.w, h: t.rect.h }))}
        </div>
        <div ref={marquee} className="ls-marquee" hidden aria-hidden="true" />
        <div ref={clock} className="ls-clock" aria-hidden="true" />
        {peek && peekTile && !peekGone && !focusTile && (
          <Peek
            key={peek.key}
            tile={peekTile}
            box={peek.box}
            pinned={peek.pinned}
            meters={meters}
            onKeep={() => setPeek((p) => (p && p.key === peekTile.key && !p.pinned ? { ...p, pinned: true } : p))}
            onFocus={() => enterFocus(peekTile)}
            onKeys={surface}
          />
        )}
        {!layout.tiles.length && (
          <div className="ls-empty">
            <div>No sessions on the landscape yet</div>
            <div className="dim">New sessions land in their group's area.</div>
          </div>
        )}
        {switcher && (
          <LiveSwitcher
            stops={stops}
            listeners={listeners.current}
            cam={cam}
            vp={vp}
            areas={[
              ...areaViews.map(({ a, accent, counts, title }) => ({ key: a.key, name: shortAreaName(a.key, title), title, accent, waiting: counts.waiting })),
              ...(loose ? [{ key: LOOSE_GROUP, name: "Loose", title: "the workspaces in no area", accent: null, waiting: areaCounts(layout.tiles, LOOSE_GROUP).waiting }] : []),
            ]}
            onArea={(key) => {
              const a = stops.find((x) => x.key === key);
              if (a && vpNow.current.w) flyTo(areaCamera(a, vpNow.current, topNow.current));
            }}
            onShowTree={onShowTree}
          />
        )}
        {pickedCount > 0 && (
          <div className="ls-pickbar" role="toolbar" aria-label="Selected workspaces">
            <span className="n">{pickedCount} selected</span>
            <button type="button" className="primary" onClick={() => void makeArea()} title="Make an area of them (M)">
              Make area… <kbd>M</kbd>
            </button>
            <button type="button" className="icon" aria-label="Clear the selection" title="Clear the selection (Esc)" onClick={() => setPicked([])}>
              ✕
            </button>
          </div>
        )}
        {note && (
          <div key={note.n} className="ls-note" role="status">
            {note.text}
          </div>
        )}
        <CameraHud listeners={listeners.current} cam={cam} onFit={fit} onZoom={zoomTo} />
        <Minimap
          layout={layout}
          accents={accents}
          listeners={listeners.current}
          cam={cam}
          vp={vp}
          onCentre={(p) => {
            stopFly();
            apply(centredAt(cam.current, p, vpNow.current));
          }}
        />
        <div className="ls-hint" aria-hidden="true">
          Zoom to 100% or focus to select text
        </div>
        {focusTile && vp && (
          <div
            ref={overlay}
            className="ls-focus"
            onKeyDown={(e) => {
              if (e.key !== "Escape" || e.metaKey || !escapeLeavesFullscreen(e.target as Element, !!document.querySelector(OVERLAYS))) return;
              e.preventDefault();
              e.stopPropagation();
              leaveFocus();
            }}
            tabIndex={-1}
          >
            {node(focusTile, "focus", vp)}
          </div>
        )}
      </div>
    </div>
  );
}

const PROBLEM_TITLE: Record<LandscapeProblem["kind"], string> = {
  corrupt: "The layout was reset",
  unreadable: "The layout file can't be read",
  newer: "A newer Mockingbird's layout",
  save: "The layout isn't saved",
  dropped: "Layout changes were dropped",
};

/**
 * What's wrong with the layout, over the landscape: landscape.json's problems as the main process reports
 * them, a change it refused, and how reading the grid's layout in is going. Each can be put away for this
 * window; one that changes comes back.
 */
export function LandscapeBanners({ problems, error, onReload, migration }: { problems: LandscapeProblem[]; error: string | null; onReload: () => void; migration: Migrating }) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const step = migration.step;
  type Action = { label: string; run: () => void };
  const rows: { key: string; tone: "bad" | "info"; title: string; text: string; actions?: Action[] }[] = [
    ...problems.map((p) => ({
      key: `${p.kind}:${p.message}`,
      tone: "bad" as const,
      title: PROBLEM_TITLE[p.kind],
      text: p.message,
      actions: p.kind === "unreadable" ? [{ label: "Read it again", run: onReload }] : undefined,
    })),
    ...(error ? [{ key: `error:${error}`, tone: "bad" as const, title: "Layout", text: error, actions: [{ label: "Read it again", run: onReload }] }] : []),
    ...(migration.remoteFailed
      ? [{
          key: `remote:${migration.remoteFailed}`,
          tone: "bad" as const,
          title: "Teammates' sessions didn't load",
          text: `${migration.remoteFailed}. Reading your grid's layout in waits for them; without them, their workspaces are placed where there's room as they come.`,
          actions: [
            { label: "Try again", run: migration.retryRemote },
            { label: "Continue without teammates' sessions", run: migration.withoutRemote },
          ],
        }]
      : []),
    ...(migration.failed ? [{ key: `migration:${migration.failed}`, tone: "bad" as const, title: "Your grid's layout wasn't read in", text: `${migration.failed}. Workspaces are placed where there's room meanwhile, and those places aren't saved until it's read in.`, actions: [{ label: "Try again", run: migration.retry }] }] : []),
    ...(step.kind === "blocked" ? [{ key: `blocked:${step.why}`, tone: "info" as const, title: "Your grid's layout isn't read in yet", text: "Not while the layout file has the problem above: workspaces are placed where there's room meanwhile, and their places aren't saved." }] : []),
  ];
  const shown = rows.filter((r) => !hidden.has(r.key));
  if (!shown.length) return null;
  return (
    <div className="ls-banners" role="status">
      {shown.map((r) => (
        <div key={r.key} className={`ls-banner ${r.tone}`}>
          <span className="t">{r.title}</span>
          <span className="m">{r.text}</span>
          {r.actions?.map((a) => (
            <button key={a.label} className="outline" onClick={a.run}>
              {a.label}
            </button>
          ))}
          <button className="icon" aria-label="Dismiss" title="Hide this until it changes" onClick={() => setHidden((h) => new Set([...h, r.key]))}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/** How far a teammate's workspace's font may grow in focus, where it's scaled to fill the window (its pty never resized). */
export const FOCUS_MAX_FONT = 16;

/** The zoom readout and its buttons, following the camera without re-rendering the landscape. */
function CameraHud({ listeners, cam, onFit, onZoom }: { listeners: Set<CameraListener>; cam: React.MutableRefObject<Camera>; onFit: () => void; onZoom: (z: number) => void }) {
  const [zoom, setZoom] = useState(cam.current.zoom);
  useEffect(() => {
    const l: CameraListener = (c) => setZoom(c.zoom);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, [listeners]);
  return (
    <div className="ls-hud">
      <button className="ls-hud-btn" aria-label="Zoom out" disabled={zoom <= ZOOM_MIN + 1e-6} onClick={() => onZoom(cam.current.zoom / 1.25)}>
        −
      </button>
      <button className="ls-hud-btn pct" data-tip="100% (⌘1)" onClick={() => onZoom(1)}>
        {Math.round(zoom * 100)}%
      </button>
      <button className="ls-hud-btn" aria-label="Zoom in" disabled={zoom >= ZOOM_MAX - 1e-6} onClick={() => onZoom(cam.current.zoom * 1.25)}>
        +
      </button>
      <button className="ls-hud-btn" data-tip="Fit everything (⌘0)" onClick={onFit}>
        Fit
      </button>
    </div>
  );
}

/** The area switcher (AreaTree.tsx), its current stop the one most of the view shows, followed without re-rendering the landscape. */
function LiveSwitcher({
  stops,
  listeners,
  cam,
  vp,
  ...rest
}: { stops: readonly AreaView[]; listeners: Set<CameraListener>; cam: React.MutableRefObject<Camera>; vp: Size | null } & Omit<React.ComponentProps<typeof AreaSwitcher>, "current">) {
  const here = (c: Camera) => (vp ? areaInView(stops, c, vp) : null);
  const [current, setCurrent] = useState(() => here(cam.current));
  useEffect(() => {
    setCurrent(here(cam.current));
    const l: CameraListener = (c) => setCurrent(here(c));
    listeners.add(l);
    return () => void listeners.delete(l);
  }, [listeners, stops, vp]);
  return <AreaSwitcher {...rest} current={current} />;
}

/** The minimap's box, in px. */
const MINIMAP: Size = { w: 196, h: 124 };

/**
 * The minimap (bottom right): areas as blocks in their accents, each workspace in no area as a neutral block of its
 * own, and the view as a rectangle. A press or a drag on it moves the view there. The view's rectangle follows the
 * camera directly, so panning re-renders none of it.
 */
function Minimap({ layout, accents, listeners, cam, vp, onCentre }: { layout: ResolvedLayout; accents: Map<string, number>; listeners: Set<CameraListener>; cam: React.MutableRefObject<Camera>; vp: Size | null; onCentre: (p: Point) => void }) {
  const view = useRef<SVGRectElement>(null);
  const bounds = useMemo(() => boundsOf(contentRects(layout)), [layout]);
  const fit = useMemo(() => (bounds ? minimapFit(bounds, MINIMAP) : null), [bounds]);
  useEffect(() => {
    if (!fit || !vp) return;
    const draw: CameraListener = (c) => {
      const el = view.current;
      if (!el) return;
      const at = toMinimap(fit, { x: c.x, y: c.y });
      el.setAttribute("x", String(at.x));
      el.setAttribute("y", String(at.y));
      el.setAttribute("width", String((vp.w / c.zoom) * fit.k));
      el.setAttribute("height", String((vp.h / c.zoom) * fit.k));
    };
    draw(cam.current);
    listeners.add(draw);
    return () => void listeners.delete(draw);
  }, [fit, vp, listeners]);
  if (!fit || !vp) return null;
  const centre = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onCentre(fromMinimap(fit, { x: e.clientX - r.left, y: e.clientY - r.top }));
  };
  return (
    <svg
      className="ls-minimap"
      width={MINIMAP.w}
      height={MINIMAP.h}
      role="img"
      aria-label="Minimap: click or drag to move the view"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        centre(e);
      }}
      onPointerMove={(e) => e.buttons === 1 && e.currentTarget.hasPointerCapture(e.pointerId) && centre(e)}
    >
      {minimapBlocks(layout).map(({ key, loose, rect: r }) => {
        const p = toMinimap(fit, r);
        const at = { x: p.x, y: p.y, width: Math.max(2, r.w * fit.k), height: Math.max(2, r.h * fit.k), rx: 2 };
        return loose ? <rect key={`loose:${key}`} className="loose" data-ws={key} {...at} /> : <rect key={key} className={`area a${accents.get(key) ?? accentOf(key)}`} data-area={key} {...at} />;
      })}
      <rect ref={view} className="view" rx={2} />
    </svg>
  );
}

/**
 * A workspace's hover peek: a large, read-only live view of it over the landscape, below 75%. Its cached terminal
 * is lent here at its own size, its font fitted to the box (lendTerm), so its pty is never resized, and it never
 * takes the keyboard: whatever asks for it (a jump to the session, say) gives it to `onKeys`. A click keeps it open
 * (`onKeep`, as Space does) and a double-click focuses the workspace. It appears at once under reduced motion.
 */
function Peek({ tile, box, pinned, meters, onKeep, onFocus, onKeys }: { tile: Tile; box: Rect; pinned: boolean; meters?: Record<string, SessionMeter>; onKeep: () => void; onFocus: () => void; onKeys: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const back = useRef<(() => void) | null>(null);
  const [missing, setMissing] = useState(false);
  const s = tile.front;
  // lent once the workspace's own pane has let the terminal go (its cleanup is a passive effect's, and runs first),
  // and handed back while the peek is still in the page (a layout effect's cleanup), where xterm can measure the font
  // it gets back
  useEffect(() => {
    back.current = holder.current ? lendTerm(s.id, holder.current, LANDSCAPE_FONT, onKeys) : null;
    if (!back.current) {
      console.warn(`[mockingbird] the peek of ${s.id} found no terminal to show`);
      setMissing(true);
    }
  }, [s.id]);
  useLayoutEffect(
    () => () => {
      back.current?.();
      back.current = null;
    },
    [s.id]
  );
  useLayoutEffect(() => {
    if (el.current && motion() === "full") play(el.current, [{ opacity: 0, transform: "scale(0.97)" }, { opacity: 1, transform: "none" }], { duration: D.s, easing: EASE.enter });
  }, []);
  const meter = meters?.[s.id];
  const tokens = meter ? totalTokens(meter.tokens) : 0;
  return (
    <div
      ref={el}
      className={`ls-peek ${pinned ? "pinned" : ""}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      data-peek={tile.key}
      role="dialog"
      aria-label={`Peek at ${titleOf(s)}`}
      onClick={onKeep}
      onDoubleClick={onFocus}
    >
      <div className="ls-peek-head">
        <StatusDot status={s.status} />
        <span className="ls-title">{titleOf(s)}</span>
        <span className="chip ls-kind">{kindLabel(s)}</span>
        {tokens > 0 && <span className="ls-tokens">{formatTokens(tokens)}</span>}
        <span className="ls-spacer" />
        <span className="ls-peek-keys">{pinned ? "Kept open · Enter or double-click focuses · Space or Esc closes" : "Click or Space keeps it open · double-click focuses"}</span>
      </div>
      {missing && <div className="ls-away">Nothing to show yet</div>}
      <div className="ls-peek-term" ref={holder} />

    </div>
  );
}
