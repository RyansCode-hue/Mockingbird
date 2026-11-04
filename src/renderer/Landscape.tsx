import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatTokens, totalTokens, type SessionInfo, type SessionMeter } from "../shared/types";
import { LANDSCAPE_FONT, type Camera, type LandscapeProblem, type Rect, type Size } from "../shared/landscape";
import type { Migrating } from "./useLandscape";
import {
  BAND_SETTLE_MS,
  PEEK_HOVER_MS,
  REVEAL_WAIT_MS,
  ZOOM_MAX,
  ZOOM_MIN,
  attaches,
  cameraFrom,
  centreOn,
  contentRects,
  fitAll,
  inView,
  keysOnScreen,
  nearestInDirection,
  nextBand,
  panBy,
  peekBox,
  revealTile,
  takesKeys,
  wheelPixels,
  wheelZoomFactor,
  worldTransform,
  zoomAbout,
  type Band,
  type Direction,
  type PendingReveal,
  type ResolvedLayout,
  type Tile,
} from "./landscapeModel";
import { WorkspaceNode, type NodeMode } from "./WorkspaceNode";
import { kindLabel } from "./WorkspaceCard";
import { focusTerm, lendTerm, screenText } from "./TerminalPane";
import { StatusDot } from "./StatusDot";
import { titleOf } from "./appModel";
import { D, EASE, motion, play } from "./motion";
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

/** A workspace's peek: its box in the viewport and, for a read-only one, its screen as text for the workspace to show meanwhile; both as they were when it opened. */
interface Peeked {
  key: string;
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
 */
export function Landscape({
  layout,
  selected,
  onSelect,
  onTab,
  reveal,
  areaTitle,
  stackName,
  meters,
  body,
}: {
  layout: ResolvedLayout;
  /** The selected session (the window's focused one); its workspace is selected. */
  selected: string | null;
  onSelect: (id: string) => void;
  onTab: (tile: Tile, id: string) => void;
  /** Bring this session's workspace into view and select it; `n` repeats it. */
  reveal: { id: string; n: number } | null;
  areaTitle: (key: string) => string;
  stackName: (stack: string) => string;
  meters?: Record<string, SessionMeter>;
  /** A session's terminal at `size`; in focus, filling the window, `home` is its workspace's own size, which it goes back to. */
  body: (s: SessionInfo, size: Size, home: Size | null) => React.ReactNode;
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

  // semantic zoom: the band the camera's zoom is in, changed only once a new one has held for a moment
  const [band, setBand] = useState<Band>(() => nextBand(cam.current.zoom, null));
  const bandNow = useRef(band);
  const bandWait = useRef<{ want: Band; timer: ReturnType<typeof setTimeout> } | null>(null);
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
    if (!takesKeys(b) && document.activeElement?.closest(".ls-world .xterm")) viewport.current?.focus({ preventScroll: true });
    if (b === "live" && peekNow.current) setPeek(null);
    setBand(b);
  };
  /**
   * Into cards at once: that only lets terminals go, and waiting would attach every workspace a zoom-out brought on
   * screen for nothing (a first fit, ⌘0). Into a band with terminals once the zoom has stayed in it (BAND_SETTLE_MS),
   * so a pinch through it attaches nothing until it rests.
   */
  const settleBand = (zoom: number) => {
    const want = nextBand(zoom, bandNow.current);
    const w = bandWait.current;
    if (w && w.want === want) return;
    if (w) clearTimeout(w.timer);
    bandWait.current = null;
    if (want === bandNow.current) return;
    if (!attaches(want)) return commitBand(want);
    bandWait.current = {
      want,
      timer: setTimeout(() => {
        bandWait.current = null;
        commitBand(nextBand(cam.current.zoom, bandNow.current));
      }, BAND_SETTLE_MS),
    };
  };
  const looked = () => {
    const v = vpNow.current;
    // before a window's first fit the camera is a stand-in: nothing is on screen until it's placed
    if (!v.w || !placed.current) return;
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

  const apply = useCallback((next: Camera) => {
    cam.current = next;
    const w = world.current;
    const v = viewport.current;
    if (w) {
      w.style.transform = worldTransform(next);
      // areas' outlines and names, and cards' type, keep their screen size; set on each, never the world, whose
      // terminals would all have their styles recalculated
      for (const a of w.querySelectorAll<HTMLElement>(".ls-area, .ls-node.card")) a.style.setProperty("--ls-inv", String(1 / next.zoom));
    }
    if (v) {
      v.classList.toggle("ls-mouse-off", !mouseAt(next.zoom));
      const step = DOTS * next.zoom * (next.zoom < 0.4 ? 4 : 1);
      v.style.backgroundSize = `${step}px ${step}px`;
      v.style.backgroundPosition = `${-next.x * next.zoom}px ${-next.y * next.zoom}px`;
    }
    settleBand(next.zoom);
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
      if (bandWait.current) clearTimeout(bandWait.current.timer);
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

  const fit = useCallback(() => {
    const rects = contentRects(layoutNow.current);
    if (rects.length && vpNow.current.w) apply(fitAll(rects, vpNow.current));
  }, []);
  // a window that has never shown the landscape starts with everything in view
  useEffect(() => {
    if (placed.current || !vp || !layout.tiles.length) return;
    placed.current = true;
    fit();
  }, [vp, layout.tiles.length]);

  // workspaces added, moved or resized come on screen or leave it
  useLayoutEffect(looked, [layout]);

  const zoomTo = (zoom: number, at?: { x: number; y: number }) => apply(zoomAbout(cam.current, at ?? { x: vpNow.current.w / 2, y: vpNow.current.h / 2 }, zoom));

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
  useEffect(() => {
    if (peek && (!peekTile || peekTile.front.status === "dead")) setPeek(null);
  }, [peek, peekTile]);

  /** Open a workspace's peek: below 75%, not in focus, and never for one that has exited (it has no live terminal). */
  const openPeek = (key: string) => {
    const t = layoutNow.current.tiles.find((x) => x.key === key);
    if (!t || takesKeys(bandNow.current) || focusNow.current || t.front.status === "dead" || !vpNow.current.w) return;
    setPeek({ key, pinned: false, box: peekBox(cam.current, vpNow.current, t.rect), snap: attaches(bandNow.current) ? screenText(t.front.id) : null });
  };
  const openPeekRef = useRef(openPeek);
  openPeekRef.current = openPeek;

  // reveal: the sidebar, ⌘K or a notification picked a session. One made a moment ago may not be in the layout
  // yet: the reveal waits for it, tried again as the layout changes, and is given up (and said) after a while.
  const pendingReveal = useRef<PendingReveal | null>(null);
  const gaveUp = (p: PendingReveal) => console.warn(`[mockingbird] the landscape couldn't bring ${p.id} into view: no workspace holds it after ${REVEAL_WAIT_MS} ms`);
  useEffect(() => {
    if (!reveal) return;
    const p = (pendingReveal.current = { id: reveal.id, until: Date.now() + REVEAL_WAIT_MS });
    const t = setTimeout(() => {
      if (pendingReveal.current !== p) return;
      pendingReveal.current = null;
      gaveUp(p);
    }, REVEAL_WAIT_MS + 50);
    return () => clearTimeout(t);
  }, [reveal?.n]);
  useEffect(() => {
    const p = pendingReveal.current;
    if (!p) return;
    const t = revealTile(p, layout.tiles, Date.now());
    if (t === "wait") return;
    pendingReveal.current = null;
    if (t === "expired") return gaveUp(p);
    if (focusNow.current && focusNow.current !== t.key) setFocusKey(null);
    if (vpNow.current.w && !inView(cam.current, t.rect, vpNow.current)) apply(centreOn(cam.current, t.rect, vpNow.current));
  }, [reveal?.n, layout]);

  const move = (dir: Direction) => {
    const tiles = layoutNow.current.tiles;
    const v = vpNow.current;
    const from = sel?.rect ?? { x: cam.current.x + v.w / (2 * cam.current.zoom), y: cam.current.y + v.h / (2 * cam.current.zoom), w: 0, h: 0 };
    const key = nearestInDirection(from, tiles.filter((t) => t.key !== sel?.key), dir);
    const t = key ? tiles.find((x) => x.key === key) : undefined;
    if (!t) return;
    select(t);
    apply(centreOn(cam.current, t.rect, v));
  };

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
    }
  };

  // A peek's keys, wherever the keyboard is but a text field: Space keeps it open (or lets it go again), Esc closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const p = peekNow.current;
      if (!p || e.metaKey || e.ctrlKey || e.altKey || (e.key !== " " && e.key !== "Escape")) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest("input, textarea:not(.xterm-helper-textarea), select, [contenteditable]")) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") setPeek(null);
      else if (!e.repeat) setPeek({ ...p, pinned: !p.pinned });
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
      // a press on its peek focuses the workspace (the peek's click); anywhere else ends the peek, kept or not
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
      // a press on the landscape between workspaces gives it the keyboard
      if (e.button === 0 && !t.closest(".ls-node, .ls-hud, .ls-banners, .ls-peek")) surface();
    };
    // Below 75% a terminal on the landscape takes no keys: one that still has the keyboard (it had it as the zoom
    // went down) gives it to the landscape, before xterm sees the key.
    const offKeys = (e: KeyboardEvent) => {
      if (takesKeys(bandNow.current) || !(e.target as Element | null)?.closest?.(".ls-world .xterm")) return;
      e.preventDefault();
      e.stopPropagation();
      surface();
    };
    // The peek: the pointer resting on a card or a read-only workspace opens it, never while dragging, panning or a
    // button is held; moving onto another workspace or the bare landscape closes it, unless Space kept it open.
    const onHover = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.(".ls-peek")) {
        if (hover.current.timer) clearTimeout(hover.current.timer);
        hover.current = { key: peekNow.current?.key ?? null, timer: null };
        return;
      }
      const key = t?.closest?.<HTMLElement>(".ls-world .ls-node")?.dataset.ws ?? null;
      if (key === hover.current.key) return;
      stopHover();
      hover.current.key = key;
      const p = peekNow.current;
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
    // a middle-button press would otherwise paste (Linux) or start autoscroll
    const onAux = (e: MouseEvent) => e.button === 1 && !inFocus(e.target) && e.preventDefault();
    v.addEventListener("wheel", onWheel, { capture: true, passive: false });
    v.addEventListener("pointerdown", onDown, true);
    v.addEventListener("keydown", offKeys, true);
    v.addEventListener("auxclick", onAux, true);
    for (const type of MOUSE) v.addEventListener(type, offMouse, true);
    v.addEventListener("pointerover", onOver);
    v.addEventListener("pointerleave", onLeave);
    return () => {
      v.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      v.removeEventListener("pointerdown", onDown, true);
      v.removeEventListener("keydown", offKeys, true);
      v.removeEventListener("auxclick", onAux, true);
      for (const type of MOUSE) v.removeEventListener(type, offMouse, true);
      v.removeEventListener("pointerover", onOver);
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
    if (peek?.key === t.key) return band === "cards" ? "card" : "snapshot";
    if (focusNow.current) return "still";
    if (attaches(band) && (seenSet.has(t.key) || (takesKeys(band) && t.key === sel?.key))) return "live";
    return band === "cards" && seenSet.has(t.key) ? "card" : "still";
  };
  const node = (t: Tile, mode: NodeMode, size: Size) => (
    <WorkspaceNode
      key={mode === "focus" ? `focus:${t.key}` : t.key}
      tile={t}
      name={t.stack ? stackName(t.stack) : null}
      mode={mode}
      size={size}
      selected={sel?.key === t.key}
      meters={meters}
      snapshot={mode === "snapshot" ? peek?.snap : null}
      inv={1 / cam.current.zoom}
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
          {layout.areas.map((a) => (
            <div key={a.key} className="ls-area" data-area={a.key} style={{ left: a.rect.x, top: a.rect.y, width: a.rect.w, height: a.rect.h, ["--ls-inv" as string]: 1 / cam.current.zoom }}>
              <span className="ls-area-name">{areaTitle(a.key)}</span>
            </div>
          ))}
          {layout.tiles.map((t) => node(t, modeOf(t), { w: t.rect.w, h: t.rect.h }))}
        </div>
        {peek && peekTile && !focusTile && (
          <Peek
            key={peek.key}
            tile={peekTile}
            box={peek.box}
            pinned={peek.pinned}
            meters={meters}
            onFocus={() => enterFocus(peekTile)}
          />
        )}
        {!layout.tiles.length && (
          <div className="ls-empty">
            <div>No sessions on the landscape yet</div>
            <div className="dim">New sessions land in their group's area.</div>
          </div>
        )}
        <CameraHud listeners={listeners.current} cam={cam} onFit={fit} onZoom={zoomTo} />
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

/**
 * A workspace's hover peek: a large, read-only live view of it over the landscape, below 75%. Its cached terminal
 * is lent here at its own size, its font fitted to the box (lendTerm), so its pty is never resized; a click
 * focuses the workspace. It appears at once under reduced motion.
 */
function Peek({ tile, box, pinned, meters, onFocus }: { tile: Tile; box: Rect; pinned: boolean; meters?: Record<string, SessionMeter>; onFocus: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const back = useRef<(() => void) | null>(null);
  const [missing, setMissing] = useState(false);
  const s = tile.front;
  // lent once the workspace's own pane has let the terminal go (its cleanup is a passive effect's, and runs first),
  // and handed back while the peek is still in the page (a layout effect's cleanup), where xterm can measure the font
  // it gets back
  useEffect(() => {
    back.current = holder.current ? lendTerm(s.id, holder.current, LANDSCAPE_FONT) : null;
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
      onClick={onFocus}
    >
      <div className="ls-peek-head">
        <StatusDot status={s.status} />
        <span className="ls-title">{titleOf(s)}</span>
        <span className="chip ls-kind">{kindLabel(s)}</span>
        {tokens > 0 && <span className="ls-tokens">{formatTokens(tokens)}</span>}
        <span className="ls-spacer" />
        <span className="ls-peek-keys">{pinned ? "Kept open · Space or Esc closes" : "Space keeps it open · click to focus"}</span>
      </div>
      {missing && <div className="ls-away">Nothing to show yet</div>}
      <div className="ls-peek-term" ref={holder} />

    </div>
  );
}
