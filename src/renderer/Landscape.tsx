import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatTokens, sanitizeSegment, totalTokens, type SessionInfo, type SessionMeter } from "../shared/types";
import { AREA_HEADER, AREA_PAD, CELL_ESTIMATE, GAP, LANDSCAPE_FONT, LOOSE_GROUP, boundsOf, colsRows, type Camera, type Landscape as Stored, type LandscapePatch, type LandscapeProblem, type Rect, type Size } from "../shared/landscape";
import type { LandscapeSave, Migrating } from "./useLandscape";
import {
  BAND_SETTLE_MS,
  PEEK_HOVER_MS,
  REVEAL_WAIT_MS,
  ZOOM_MAX,
  ZOOM_MIN,
  accentOf,
  accentsOf,
  areaAt,
  areaShown,
  areaCamera,
  areaCounts,
  areaInView,
  areaSummary,
  attaches,
  cameraFrom,
  cameraForOpened,
  answerOn,
  centreOn,
  compactPlaces,
  ghostDrawnHeight,
  COMPACT_MIN,
  centredAt,
  contentRects,
  fitBelow,
  fitRects,
  flightAt,
  fromMinimap,
  inView,
  keysOnScreen,
  looseStop,
  minimapBlocks,
  minimapFit,
  moveTargets,
  nearestInDirection,
  nextBand,
  panBy,
  peekBox,
  carryPlan,
  planDockWindow,
  planMakeArea,
  planMoveArea,
  planMoveExtra,
  planMoveTile,
  planResizeTo,
  planStack,
  planUnstack,
  snapRect,
  MOVE_EDGES,
  minWorkspace,
  type Edges,
  type Guide,
  rectFrom,
  revealTile,
  clearRoom,
  sessionsOnScreen,
  shortAreaName,
  takesKeys,
  tilesIn,
  toLandscape,
  toMinimap,
  undoOfPlan,
  notePlacement,
  wheelPixels,
  wheelZoomFactor,
  worldTransform,
  zoomAbout,
  type AreaCounts,
  type AreaView,
  type Band,
  type CardView,
  type Direction,
  type GoToAsk,
  type GroupMove,
  type MovesFailed,
  type PendingReveal,
  type ReadyPlan,
  type RevealAsk,
  type ScreenBox,
  type Point,
  type ResolvedLayout,
  type Tile,
  type WindowView,
} from "./landscapeModel";
import { WorkspaceNode, edgesOf, ownTermHasKeys, type NodeMode, type ResizeEdge, type WorkspaceChrome } from "./WorkspaceNode";
import { ToolWindow } from "./ToolWindow";
import { LiftOut } from "./lift";
import { actionOf, menuOf, severalActions, severalMenu, type ModelAction } from "./workspaceActions";
import { GhostCard } from "./GhostCard";
import { kindLabel } from "./WorkspaceCard";
import { AreaFrame } from "./AreaFrame";
import { AreaSwitcher } from "./AreaTree";
import { menuHeading, tidyMenu, useContextMenu, type MenuEntry } from "./ContextMenu";
import { AreaBar, SeveralBar, WorkspaceBar, type BarPlace } from "./SelectionBar";
import { AREA_NAME_PX, areaStatus, barAnchor, escapeClears, readBarExtended, saveBarExtended, severalBarItems, type BarChrome, type BarTarget } from "./selectionBarModel";
import { focusTerm, lendTerm, screenText, scrollTerm, termHasKeys } from "./TerminalPane";
import { StatusDot } from "./StatusDot";
import { titleOf } from "./appModel";
import { D, EASE, fromKeyboard, motion, play } from "./motion";
import { OVERLAYS, OVER_TOUR, escapeLeavesFullscreen, ownsKeys } from "./keys";
import { keyboardClaimed, useKeyboardHome } from "./Modal";
import { HOLDS_KEYS, KEYS_SWALLOWED, QUIET_KEYS, TYPING_MS, afterPause, armFocus, armOnPress, holdNowhere, inputStamp, isArmed, isNowhere, keyboardNowhere, keyboardSpell, sinceKey, swallowedNote, tabPast, takeTabChoice, toNowhere, typed, untouched } from "./keyArm";
import { LandscapeEmpty } from "./LandscapeEmpty";
import { LandscapeTour } from "./LandscapeTour";
import { PROBLEM_TITLE, nothingDrawn, sameCamera, tourAreaOf, tourCamera, tourCameraFrom, tourSteps, type Box, type EmptyState, type TourTarget } from "./landscapeFirstRun";
import { readPref, writePref } from "./prefs";
import { isRemote } from "./team/RoomLive";
import { typingAsksOf } from "./needsYouModel";
import { cameraMoved } from "./answerGuard";
import { WireLayer, rereadWires, useWires, type WireLayerHandle } from "./WireLayer";
import { wireBanners, wireViews, type WireRoom } from "./wiresModel";

/** Where this window's camera was, kept between launches: a view preference, never part of landscape.json. */
export const CAMERA_PREF = "mb.landscape.camera";
/**
 * Where the tour moved the camera from and to, while it's up: kept with the camera, so a tab away or a restart in the
 * middle of it still puts the camera back, and saves the camera it came from as this window's, not the tour's.
 */
export const TOUR_CAMERA_PREF = "mb.landscape.tourCamera";
/** The landscape has been on screen in this window: once it has, it's mounted again armed only by its tab pressed. */
let landscapeShownBefore = false;
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
  /**
   * What its selection bar shows: its actions (the model its ⋯ renders), its room's id when it's a room's (whose
   * unread chat the Chat button counts), and the room's Members ▾ (the header's, with the same handlers).
   */
  bar: (key: string) => { actions: ModelAction[]; roomId: string | null; members: React.ReactNode };
  /** The kinds of workspace a right-click on empty landscape makes, placed at `at` (landscape px), in area `area` when it's in one. */
  create: (area: string | null, at: Point) => ModelAction[];
}


/** How often a tour that's due looks again for what's open over the app (What's new after an update) having closed. */
const TOUR_WAIT_MS = 400;
/**
 * How long after the tour (or its last key) a terminal that had the keyboard is waited for, while the camera goes back
 * and the band follows it.
 */
const TOUR_KEYS_BACK_MS = 2000;

/** A gesture's plan that can be carried out. */
/** An area's actions its hover toolbar shows (AreaFrame.tsx), in this order: Tidy first, as the Zoomed board has it. */
const ARRANGE = ["tidy", "collapse", "lock"];

/** A button beside a note over the landscape: Tidy's Undo. */
export interface NoteAction {
  label: string;
  run: () => void;
}
/** Something said over the landscape; a new `n` says it again. */
export interface LandscapeNote {
  text: string;
  n: number;
  action?: NoteAction;
}

/** How far a press moves before it's a drag (a marquee, a workspace or an area moving) rather than a click. */
const DRAG_PX = 4;
/**
 * How far a stack's tab is pulled before it leaves its stack while the pointer is still on its workspace's header: a
 * click on a tab that slips a few px brings it to the front rather than taking it out.
 */
const TAB_DRAG_PX = 14;
/** How far off its header, in screen px, a press on a tab can slip and stay a click, however thin the header is zoomed out. */
const TAB_SLIP_PX = 8;
/** How far a snap guide runs past the edges it lines up, in screen px. */
const GUIDE_PAST_PX = 16;
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
  /** `resize`: a workspace by an edge or corner (`edges`); `tab`: a stack's tab (`sid`) dragged out of it. */
  kind: "marquee" | "tile" | "area" | "window" | "card" | "resize" | "tab";
  id: number;
  x0: number;
  y0: number;
  /** The workspace's or the area's key, a window's or a card's id ("" for a marquee). */
  key: string;
  /** A marquee with Shift held adds to the selection, `base` as it was when it started. */
  add: boolean;
  base: string[];
  on: boolean;
  els: HTMLElement[];
  edges?: Edges;
  sid?: string;
  /** A tab's workspace header, in the viewport: pulled off it, the tab leaves its stack sooner than TAB_DRAG_PX. */
  strip?: DOMRect;
  /** Where a workspace being moved or resized (or a tab dragged out) lands now: snapped to the grid and its neighbours. */
  snapped?: Rect;
}

/** A drop waiting for the layout: its elements keep their drag offset until `moved` says the layout has them there. */
interface Settling {
  els: HTMLElement[];
  moved: () => boolean;
}

const releaseEls = (els: readonly HTMLElement[]) => {
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
/** A tool window's key among what's on screen (`seen`), apart from the workspaces'. */
const WIN_SEEN = "win:";

export function Landscape({
  layout,
  stored,
  selected,
  onSelect,
  selectedArea,
  onSelectArea,
  onCloseMany,
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
  revNow,
  onMoves,
  askAreaName,
  onSeen,
  switcher,
  onShowTree,
  treeHidden,
  actionsFor,
  chromeFor,
  windowFor,
  onCloseWindow,
  cardFor,
  notice,
  ghostActions,
  ghostStatus,
  needs,
  onNeeds,
  keysTo = { n: 0, armed: false },
  emptyState,
  onJoinRoom,
  onShortcuts,
  newAsk = 0,
  tour,
  rooms,
}: {
  layout: ResolvedLayout;
  /** landscape.json as this window has it: what gestures' plans are made against. */
  stored: Stored;
  /** The selected session (the window's focused one); its workspace is selected. */
  selected: string | null;
  /** A workspace selected (its session's id), or null: none is. */
  onSelect: (id: string | null) => void;
  /** The area selected as a whole (its patch, name or tree row clicked), or null; the selection bar shows its actions. */
  selectedArea: string | null;
  onSelectArea: (key: string | null) => void;
  /** Close these sessions (several selected): asked first, then each as its own Close would. */
  onCloseMany: (ids: string[]) => void;
  onTab: (tile: Tile, id: string) => void;
  /** Bring this session's workspace into view (in front, if it's a stack's tab), with `focus` filling the window with it. */
  reveal: RevealAsk | null;
  /** Fly to this area. */
  goTo: GoToAsk | null;
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
  /** Change landscape.json (LandscapeStore.save): the revision it made, or why it was refused (also in the banners). */
  onPatch: (patch: LandscapePatch, what: string) => Promise<LandscapeSave>;
  /** The landscape's newest revision here (LandscapeStore.revNow): a note's Undo is offered while it's the one its change made. */
  revNow: () => number | null;
  /** Set these sessions' groups, in order, stopping at the first that can't be: what to say and how many were, or null. */
  onMoves: (moves: readonly GroupMove[], what: string) => Promise<MovesFailed | null>;
  /** A name for the area Make area… makes of `count` workspaces; null when it's cancelled. */
  askAreaName: (count: number) => Promise<string | null>;
  /** The sessions on screen, for teamLiveView: each workspace's on screen and the one in focus, never a collapsed area's. */
  onSeen: (ids: string[]) => void;
  /** The area switcher over the landscape, while the area tree is hidden (design M). */
  switcher: boolean;
  onShowTree: () => void;
  /** The area tree isn't showing: the side bar is hidden, or shows Team rooms in its place. */
  treeHidden: boolean;
  /** A workspace's actions (its front session's): what its chips, ⋯ and right-click offer, in every band. */
  /** A workspace's actions: its front session's, or `s`'s, one of its stack's tabs (a right-click on that tab). */
  actionsFor: (t: Tile, s?: SessionInfo) => ModelAction[];
  /** Something to say over the landscape, as a gesture's refusal is said (a resize or a tool window refused); a new `n` says it again. */
  notice: LandscapeNote | null;
  /**
   * A closed session's actions: what a ghost's buttons, ⋯ and right-click offer (`tabs` a stack ghost's closed tabs, which
   * Reopen and Forget act on together), and a stack's closed tab's.
   */
  ghostActions: (s: SessionInfo, tabs?: readonly SessionInfo[]) => ModelAction[];
  /** A ghost's status line (closedStatus). */
  ghostStatus: (s: SessionInfo) => string;
  /** What a workspace's header chips and footer show. */
  chromeFor: (s: SessionInfo) => WorkspaceChrome;
  /**
   * A placed tool window's scope, as its title names it, what it hosts, and what its head counts zoomed out (an
   * Artifacts window's artifacts). `seen`: it's on screen in the live band, so what it shows is being looked at.
   */
  windowFor: (w: WindowView, seen: boolean) => { scope: string | null; body: React.ReactNode; count?: React.ReactNode };
  onCloseWindow: (id: string) => void;
  /** An artifact card's face. */
  cardFor: (c: CardView) => React.ReactNode;
  /** What needs you in each area (S7, needsYouModel.ts): a collapsed area's pill and the switcher count it. */
  needs?: ReadonlyMap<string, number>;
  /** N (1) and ⇧N (-1): the view to the next or previous thing that needs you. */
  onNeeds?: (dir: 1 | -1) => void;
  /**
   * Going up gives the landscape the keyboard: a prompt shown from the Needs you tray has closed, the tray long gone.
   * Armed only when the user closed it (a press, Esc); the prompt going on its own, or Enter, gives it disarmed.
   */
  keysTo?: { n: number; armed: boolean };
  /** What's known of a landscape with nothing drawn on it (emptyStateOf). */
  emptyState: EmptyState;
  /** The dialog to join a teammate's room. */
  onJoinRoom: () => void;
  /** `?`: the shortcuts sheet, opened or closed. */
  onShortcuts: () => void;
  /** Going up opens the create menu at the view's centre (the top bar's + New). */
  newAsk?: number;
  /** The migration tour: due (shown once nothing else is open over the app, and not behind focus), and its end, however it came. */
  tour: { due: boolean; onEnd: () => void };
  /** The team rooms and the areas they're shared as: a wire's ends' rooms, for what it shows (wiresModel). */
  rooms?: readonly WireRoom[];
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
  const asks = useRef({ onPatch, onMoves, askAreaName, areaTitle, onSeen, onHandled, selected, selectedArea });
  asks.current = { onPatch, onMoves, askAreaName, areaTitle, onSeen, onHandled, selected, selectedArea };

  // areas: the marquee's selection, the area a dragged workspace would join, and a note on the last gesture
  const [picked, setPickedState] = useState<string[]>([]);
  const pickedNow = useRef(picked);
  pickedNow.current = picked;
  /** The picked set, kept current at once: two Shift-clicks before a render each add to what the one before left. */
  const setPicked = (next: string[] | ((p: string[]) => string[])) => {
    const v = typeof next === "function" ? next(pickedNow.current) : next;
    pickedNow.current = v;
    setPickedState(v);
  };
  const [hot, setHot] = useState<string | null>(null);
  const [note, setNote] = useState<LandscapeNote | null>(null);
  const noteNow = useRef(note);
  noteNow.current = note;
  const say = (text: string, action?: NoteAction) => setNote((p) => ({ text, n: (p?.n ?? 0) + 1, action }));
  // a workspace's ⋯ and right-click, and an area's right-click on its patch zoomed out
  const ctx = useContextMenu("Landscape");
  // a notice said while this landscape is up; one from before it mounted was said where it happened, not here
  const noticeAtMount = useRef(notice?.n);
  useEffect(() => {
    if (notice && notice.n !== noticeAtMount.current) say(notice.text, notice.action);
  }, [notice?.n]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note?.n]);
  // the note in the room left of the minimap, above the selection bar when the bar is low (notePlacement)
  const noteEl = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = noteEl.current;
    const vp = viewport.current;
    if (!el || !vp) return;
    const box = vp.getBoundingClientRect();
    const inVp = (q: string): Rect | null => {
      const r = vp.querySelector<HTMLElement>(q)?.getBoundingClientRect();
      return r && r.width ? { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height } : null;
    };
    const view = { w: box.width, h: box.height };
    const minimap = inVp(".ls-minimap");
    el.style.maxWidth = `${notePlacement(view, { w: 0, h: 0 }, minimap, null).maxWidth}px`;
    const at = notePlacement(view, { w: el.offsetWidth, h: el.offsetHeight }, minimap, inVp(".ls-selbar"));
    Object.assign(el.style, { left: `${at.left}px`, bottom: `${at.bottom}px` });
  }, [note?.n]);
  // ⌘Z: the note's action (Tidy's Undo, a tab's) while it's up, wherever the keyboard is but what reads keys itself (a
  // terminal, a text field, the code editor: ownsKeys), a menu or a dialog: a Tidy from the hover toolbar or a menu
  // leaves the keyboard on the button, not the landscape
  useEffect(() => {
    if (!note?.action) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== "z") return;
      if (ownsKeys(e.target as Element | null) || document.querySelector(OVERLAYS)) return;
      const a = noteNow.current?.action;
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      setNote(null);
      a.run();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [note?.n, !!note?.action]);
  const gesture = useRef<Gesture | null>(null);
  /** Where the last drag was let go, until the pointer moves on from it: no peek opens on what it left there. */
  const droppedAt = useRef<{ x: number; y: number } | null>(null);
  const marquee = useRef<HTMLDivElement>(null);
  /** While a workspace is moved or resized: the guides it snapped along, and (resizing, or a tab dragged out) where it lands. */
  const guidesEl = useRef<HTMLDivElement>(null);
  const sizeBox = useRef<HTMLDivElement>(null);
  const settling = useRef<Settling[]>([]);
  const wiresRef = useRef<WireLayerHandle>(null);
  /** Elements a drag moved, back where the layout has them; their wires with them. */
  const release = (els: readonly HTMLElement[]) => {
    releaseEls(els);
    wiresRef.current?.follow();
  };
  /** No drag going and no drop settling: the selection bar shows again (styles.css hides it under .ls-dragging). */
  const dragDone = () => {
    if (!gesture.current?.on && !settling.current.length) viewport.current?.classList.remove("ls-dragging");
  };
  // a flight to an area: the clock animation whose progress moves the camera, and the frame that reads it
  const flight = useRef<{ anim: Animation; raf: number; to: Camera } | null>(null);
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
    // and the tool windows on screen: what a window shows counts as seen only there (a room's chat marks read, and
    // holds its mentions, only while it's seen)
    const wins = layoutNow.current.windows.map((w) => ({ key: `${WIN_SEEN}${w.id}`, rect: w.rect, hidden: w.hidden }));
    const keys = [...keysOnScreen(layoutNow.current.tiles, cam.current, v), ...keysOnScreen(wins, cam.current, v, 0)].join("\n");
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
   * Areas' outlines, headers and names, pills, cards' type, and tool windows' and artifact cards' heads zoomed out
   * keep their screen size: --ls-inv is 1/zoom, and --ls-hs that never below 1 (an area's header and pill, which don't
   * shrink past 100% zoomed in). Set on each, never on the world, whose terminals would all have their styles
   * recalculated; each is drawn with the value of its render, which this keeps current as the camera moves. A stack's
   * workspace has it too, for the layers behind it (a few terminals, where every one would be too many).
   */
  const paintScale = (zoom: number) => {
    const inv = String(1 / zoom);
    const hs = String(Math.max(1, 1 / zoom));
    for (const el of world.current?.querySelectorAll<HTMLElement>(".ls-area, .ls-area-pill, .ls-node.card, .ls-node.stack, .ls-window, .ls-acard, .ls-ghost, .ls-wires, .ls-wire-labels") ?? []) {
      el.style.setProperty("--ls-inv", inv);
      el.style.setProperty("--ls-hs", hs);
    }
    if (bandNow.current === "cards") paintCompact(zoom);
  };
  /**
   * Zoomed out to cards, windows and cards are drawn at least their compact size, so one may reach over another or
   * past its area: each is drawn under those before it and kept inside its area, clear of the next area's name line
   * (compactPlaces), by --ls-dx, --ls-dy, --ls-cw and --ls-ch, which React never sets. Outside the cards band they're
   * unused (styles.css).
   */
  const paintCompact = (zoom: number) => {
    const l = layoutNow.current;
    const areaRect = (key: string | null) => (key === null ? null : (l.areas.find((a) => a.key === key && !a.rect.collapsed)?.rect ?? null));
    const names = l.areas.filter((a) => !a.rect.collapsed).map((a) => ({ x: a.rect.x, y: a.rect.y - AREA_NAME_PX / zoom, w: a.rect.w, h: AREA_NAME_PX / zoom }));
    const places = compactPlaces(
      [
        ...l.windows.filter((w) => !w.hidden).map((w) => ({ id: `w:${w.id}`, rect: w.rect, min: COMPACT_MIN.window, bounds: areaRect(w.area) })),
        ...l.cards.filter((c) => !c.hidden).map((c) => ({ id: `c:${c.id}`, rect: c.rect, min: COMPACT_MIN.card, bounds: areaRect(c.card.area) })),
      ],
      zoom,
      names
    );
    for (const el of world.current?.querySelectorAll<HTMLElement>(".ls-window[data-win], .ls-acard[data-card]") ?? []) {
      const p = places.get(el.dataset.win ? `w:${el.dataset.win}` : `c:${el.dataset.card}`);
      if (!p) continue;
      el.style.setProperty("--ls-dx", `${p.dx}px`);
      el.style.setProperty("--ls-dy", `${p.dy}px`);
      el.style.setProperty("--ls-cw", `${p.w}px`);
      el.style.setProperty("--ls-ch", `${p.h}px`);
    }
    // a ghost keeps to its place, its foot clear of the next area's name line (--ls-gh, styles.css)
    const ghosts = new Map(l.ghosts.map((g) => [g.key, g.rect]));
    for (const el of world.current?.querySelectorAll<HTMLElement>(".ls-ghost[data-ghost]") ?? []) {
      const r = ghosts.get(el.dataset.ghost ?? "");
      if (r) el.style.setProperty("--ls-gh", `${ghostDrawnHeight(r, zoom, names)}px`);
    }
  };
  /** The tour is up (set as it renders, below). */
  const tourUpNow = useRef(false);
  /**
   * While it's up: a jump took the view elsewhere (`jumped`), and the session whose terminal was asked for the keyboard
   * since (`asked`: a jump to it), which is where the keyboard goes when the tour ends.
   */
  const tourJump = useRef<{ jumped: boolean; asked: string | null }>({ jumped: false, asked: null });
  /** Where the tour moved the camera from and to, kept while it's up (TOUR_CAMERA_PREF). */
  const tourMoved = () => tourCameraFrom(readPref<unknown>(TOUR_CAMERA_PREF, null));
  /** The camera is where the tour put it, or on its way there. */
  const tourHolds = (m: { to: Camera }) => sameCamera(cam.current, m.to) || (!!flight.current && sameCamera(flight.current.to, m.to));
  /** This window's camera as it's saved: while the tour holds it, the one it moved it from. */
  const userCamera = (): Camera => {
    const m = tourUpNow.current ? tourMoved() : null;
    return m && tourHolds(m) ? m.from : cam.current;
  };
  const apply = useCallback((next: Camera) => {
    const was = cam.current;
    cam.current = next;
    if (was.x !== next.x || was.y !== next.y || was.zoom !== next.zoom) cameraMoved();
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
    saveTimer.current = setTimeout(() => writePref(CAMERA_PREF, userCamera()), CAMERA_SAVE_MS);
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
      writePref(CAMERA_PREF, userCamera());
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
    const f = { anim, raf: 0, to };
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
    const rects = fitRects(layoutNow.current);
    if (rects.length && vpNow.current.w) apply(fitBelow(rects, vpNow.current, topNow.current));
  }, []);
  // a window that has never shown the landscape starts with everything in view
  const anythingToFit = fitRects(layout).length > 0;
  useEffect(() => {
    if (placed.current || !vp || !anythingToFit) return;
    placed.current = true;
    fit();
  }, [vp, anythingToFit]);

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
    dragDone();
  }, [layout]);
  useLayoutEffect(() => paintScale(cam.current.zoom), [band]);

  const zoomTo = (zoom: number, at?: { x: number; y: number }) => {
    stopFly();
    apply(zoomAbout(cam.current, at ?? { x: vpNow.current.w / 2, y: vpNow.current.h / 2 }, zoom));
  };

  // ---- the selection: one workspace (the window's selected session), one area, or several workspaces (`picked`) ----
  // One at a time, as in Figma: selecting one kind lets the others go, and the selection bar shows its actions.
  const select = (t: Tile) => {
    onSelect(t.front.id);
    onSelectArea(null);
    if (pickedNow.current.length) setPicked([]);
  };
  const selectArea = (key: string) => {
    onSelectArea(key);
    if (pickedNow.current.length) setPicked([]);
  };
  /** Several picked (a marquee, Shift-clicks): the workspace and the area selected before are let go. */
  const pickTiles = (keys: string[]) => {
    setPicked(keys);
    if (!keys.length) return;
    if (asks.current.selected) onSelect(null);
    if (asks.current.selectedArea) onSelectArea(null);
  };
  /** Nothing selected: Esc, or a click on the bare landscape outside every area. */
  const clearSelection = () => {
    if (pickedNow.current.length) setPicked([]);
    if (asks.current.selected) onSelect(null);
    if (asks.current.selectedArea) onSelectArea(null);
  };
  const selRefs = useRef({ pickTiles, selectArea, clearSelection });
  selRefs.current = { pickTiles, selectArea, clearSelection };
  // a workspace or an area selected from elsewhere (its terminal clicked into, the tree, a notification, N) is the
  // selection now: the several picked before are let go, so there's only ever one selection
  useEffect(() => {
    if ((selected || selectedArea) && pickedNow.current.length) setPicked([]);
  }, [selected, selectedArea]);
  /** What takes the landscape's keys: the surface, or in focus the focused workspace's frame (so Esc reaches it). */
  const surfaceEl = () => (focusNow.current ? overlay.current : viewport.current);
  /**
   * The keyboard to the landscape, disarmed (keyArm.ts): what's typed there does nothing until the user arms it. Every
   * move of the keyboard here that isn't the user's own command (a band change, a terminal that took no keys, a reveal).
   */
  const surface = () => surfaceEl()?.focus({ preventScroll: true });
  /**
   * The workspaces the last two presses anywhere in the window were on (null: none). A double-click focuses a workspace
   * only when both its presses were on it: one whose first press was elsewhere (Go there in the tray, say) lands its
   * second on whatever flew in under the pointer, which it wasn't aimed at.
   */
  const pressedOn = useRef<[string | null, string | null]>([null, null]);
  useEffect(() => {
    const onPress = (e: PointerEvent) => {
      const at = (e.target as Element | null)?.closest?.<HTMLElement>(".ls-node[data-ws], .ls-peek[data-peek]");
      pressedOn.current = [pressedOn.current[1], at ? (at.dataset.ws ?? at.dataset.peek ?? null) : null];
    };
    document.addEventListener("pointerdown", onPress, true);
    return () => document.removeEventListener("pointerdown", onPress, true);
  }, []);
  /** Both presses of the double-click just made were on workspace `key`. */
  const pairOn = (key: string) => pressedOn.current[0] === key && pressedOn.current[1] === key;
  // focus, its own terminal and leaving it, are always the user's commands (Enter, ⌘E, ⌘Esc, a double-click, Focus)
  const enterFocus = (t: Tile) => {
    stopHover();
    setPeek(null);
    setFocusKey(t.key);
    select(t);
    // your own terminal takes the keyboard; a teammate's waits for a click
    setTimeout(() => (!isRemote(t.front) && t.front.status !== "dead" ? focusTerm(t.front.id) : armFocus(overlay.current)), 50);
  };
  const leaveFocus = () => {
    setFocusKey(null);
    // the terminal's element moves back into its workspace on the next render; the keyboard comes back here
    setTimeout(() => armFocus(viewport.current), 0);
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
  // its workspace left or exited, its stack brought another tab to the front, its session got a new terminal, or a
  // teammate asks to type in it (the peek draws only the terminal, over the ask's strip and the card's badge)
  const peekGone = !!peek && (!peekTile || peekTile.front.status === "dead" || peekTile.front.id !== peek.front || termKey(peek.front) !== peek.gen || typingAsksOf(peekTile.front).length > 0);
  useEffect(() => {
    if (peekGone) setPeek(null);
  }, [peekGone]);

  /**
   * Open a workspace's peek: below 75%, not in focus, and never for one that has exited (it has no live terminal) or
   * one a teammate asks to type in, whose strip (and card badge) the peek would cover.
   */
  const openPeek = (key: string) => {
    const t = layoutNow.current.tiles.find((x) => x.key === key);
    if (!t || takesKeys(bandNow.current) || focusNow.current || t.front.status === "dead" || typingAsksOf(t.front).length || !vpNow.current.w) return;
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
  /**
   * The pending reveal gives the landscape the keyboard once there (Go there), keeps clear of a box on screen (the
   * tray), and lands at 100% where a typing ask can be answered.
   */
  const revealOpts = useRef<{ keys: boolean; avoid: ScreenBox | null; answer: boolean }>({ keys: false, avoid: null, answer: false });
  /** The reveal whose stack tab was asked to the front, waiting for the layout to have it there. */
  const fronting = useRef<PendingReveal | null>(null);
  /** The view's size to bring something into view in: the part of it clear of `avoid`. */
  const roomClearOf = (avoid: ScreenBox | null) => {
    const box = viewport.current?.getBoundingClientRect();
    return box && avoid ? clearRoom({ left: box.left, top: box.top, width: vpNow.current.w, height: vpNow.current.h }, avoid) : vpNow.current;
  };
  const gaveUp = (p: PendingReveal) => console.warn(`[mockingbird] the landscape couldn't bring ${p.id} into view: no workspace holds it after ${REVEAL_WAIT_MS} ms`);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The user's keys and presses as the pending reveal was asked for (keyArm.ts's `inputStamp`). */
  const revealStamp = useRef(0);
  useEffect(() => () => void (revealTimer.current && clearTimeout(revealTimer.current)), []);
  useEffect(() => {
    if (!reveal) return;
    // taken up: the owner lets go of it, so this landscape mounted again (another tab and back) doesn't repeat it
    asks.current.onHandled(reveal.n);
    // A jump during the tour (⌘K, the side bar, a notification) takes the view: the tour's camera no longer goes back
    // when it ends (a later step moves from here), and the terminal that had the keyboard as it came up doesn't get it.
    if (tourUpNow.current) {
      writePref(TOUR_CAMERA_PREF, null);
      tourJump.current.jumped = true;
      // a jump placing the keyboard (keyboardMoves) is for its session's terminal, which the tour holds it from till then
      if (keyboardClaimed()) tourJump.current.asked = reveal.id;
    }
    revealFocus.current = !!reveal.focus;
    revealOpts.current = { keys: !!reveal.keys, avoid: reveal.avoid ?? null, answer: !!reveal.answer };
    const p = (pendingReveal.current = { id: reveal.id, until: Date.now() + REVEAL_WAIT_MS });
    revealStamp.current = inputStamp();
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
      void asks.current.onPatch({ areas: { [t.area]: { collapsed: false } } }, `${title} opened`).then((r) => {
        const error = "error" in r ? r.error : null;
        if (!error || pendingReveal.current !== p) return;
        pendingReveal.current = null;
        opening.current = null;
        say(`${title} couldn't be opened to show the workspace: ${error}`);
      });
      return;
    }
    if (t !== "expired" && t.stack && t.front.id !== p.id) {
      // a stack's tab behind another comes to the front first, so the workspace shown (its terminal, its focus) is its
      if (fronting.current === p) return;
      fronting.current = p;
      void asks.current.onPatch({ stacks: { [t.stack]: { active: p.id, placement: t.rect } } }, "the stack's front tab").then((r) => {
        if (!("error" in r) || pendingReveal.current !== p) return;
        pendingReveal.current = null;
        fronting.current = null;
        say(`The stack couldn't bring that tab to the front: ${r.error}`);
      });
      return;
    }
    pendingReveal.current = null;
    opening.current = null;
    fronting.current = null;
    if (t === "expired") return gaveUp(p);
    const room = roomClearOf(revealOpts.current.avoid);
    const seen = !vpNow.current.w || inView(cam.current, t.rect, room);
    // The user did something while it waited (main slow to bring a stack's tab to the front, or to open an area), or a
    // dialog opened (inputStamp counts those too), or one is open now: it moves no keyboard and enters no focus, which
    // would take what's being typed now, or the dialog's keys. It's still brought into view, unless that would move the
    // view from under a terminal or a field being typed in.
    if (inputStamp() !== revealStamp.current || document.querySelector(OVERLAYS)) {
      if (!seen && !ownsKeys(document.activeElement)) flyTo(centreOn(cam.current, t.rect, room));
      return;
    }
    if (revealFocus.current) {
      // under the focus overlay, so there's no flight to see: the landscape is there when focus ends
      if (!seen) {
        stopFly();
        apply(centreOn(cam.current, t.rect, vpNow.current));
      }
      return enterFocus(t);
    }
    const keys = revealOpts.current.keys;
    const leaving = !!focusNow.current && focusNow.current !== t.key;
    if (leaving) {
      // surface would pick the focus overlay, which is about to go
      if (keys) leaveFocus();
      else setFocusKey(null);
    }
    if (revealOpts.current.answer && (!seen || !mouseAt(cam.current.zoom))) flyTo(answerOn(t.rect, room));
    else if (!seen) flyTo(centreOn(cam.current, t.rect, room));
    // Go there: the user's command to go to the landscape
    if (keys && !leaving) armFocus(surfaceEl());
  }, [reveal?.n, layout]);

  // after Go there's join request, answered
  const keysGiven = useRef(keysTo.n);
  useEffect(() => {
    if (keysGiven.current === keysTo.n) return;
    keysGiven.current = keysTo.n;
    if (keysTo.armed) armFocus(surfaceEl());
    else surfaceEl()?.focus({ preventScroll: true });
  }, [keysTo.n]);

  // a tool window just opened or placed again comes into view, with its workspace when both fit
  const placedWindows = useRef<Set<string> | null>(null);
  useEffect(() => {
    const before = placedWindows.current;
    placedWindows.current = new Set(layout.windows.map((w) => w.id));
    if (!before || !vpNow.current.w || focusNow.current) return;
    const to = cameraForOpened(before, layout, cam.current, vpNow.current);
    if (to) flyTo(to);
  }, [layout]);

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
    flyTo(areaCamera(a, roomClearOf(goTo.avoid ?? null), topNow.current));
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
    void onPatch({ areas: { [key]: flag === "collapsed" ? { collapsed: on } : { locked: on } } }, what).then((r) => "error" in r && say(`${what}: not saved, ${r.error}`));
  };
  /**
   * A plan carried out: its patch, the sessions' groups, then `after` (AreaPlan). `settle`, a drop's elements, keeps
   * them where they were dropped until the layout has them there. Whatever fails is said, and nothing after it is done:
   * null. Done, the revision its last change to the landscape made (null: it made none), for an Undo to go by.
   */
  const carryOut = (plan: ReadyPlan, what: string, settle?: Settling): Promise<{ rev: number | null } | null> => {
    const unsettle = () => {
      if (!settle) return;
      settling.current = settling.current.filter((s) => s !== settle);
      release(settle.els);
      dragDone();
    };
    if (settle) settling.current.push(settle);
    return carryPlan(plan, what, {
      before: storedNow.current,
      send: (patch, doing) => asks.current.onPatch(patch, doing),
      moves: (moves, doing) => asks.current.onMoves(moves, doing),
      say,
      patched: (error, sent) => {
        if (error || !sent) unsettle();
        else setTimeout(unsettle, SETTLE_MS);
      },
    });
  };
  /**
   * Tab `s` taken out of stack `t` (planUnstack), said with an Undo that puts it back in the stack and what it pushed
   * aside back where it was, while the landscape's revision is still the one the unstack made (revNow). Undo puts the
   * stack's entry back first, then the groups, then lets the tabs' own places go (undoOfPlan), so nothing is ever drawn
   * with no place in between (which the layout would place, and save).
   */
  const unstack = async (plan: ReadyPlan, s: SessionInfo, t: Tile) => {
    const before = storedNow.current;
    const groups = new Map([...t.members, ...(t.closed ?? [])].map((m) => [m.id, m.taskGroup ?? null]));
    const done = await carryOut(plan, `taking ${titleOf(s)} out of the stack`);
    if (!done) return;
    const back = undoOfPlan(before, plan);
    const undo = () => {
      if (done.rev === null || revNow() !== done.rev) return say(`Can't put ${titleOf(s)} back in its stack: the landscape has changed since`);
      void carryOut({ patch: back.patch, moves: plan.moves.map((m) => ({ id: m.id, group: groups.get(m.id) ?? null })), after: back.after }, `putting ${titleOf(s)} back in its stack`);
    };
    say(plan.note ?? `Took ${titleOf(s)} out of its stack`, { label: "Undo", run: undo });
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

  /** A model's row `key` run as its button would, or its reason said when it can't be done now. */
  const runRow = (actions: readonly ModelAction[], key: string) => {
    const a = actionOf(actions, key);
    if (!a) {
      // a shortcut whose row isn't in its model is a bug here, not something to drop quietly
      console.error(`[landscape] no "${key}" row to run among`, actions.map((x) => x.key));
      return say(`That shortcut has nothing to run here (no ${key} row)`);
    }
    if (a.disabled) say(a.title ?? `${a.label} can't be done now`);
    else a.onPick();
  };
  /** Why typed keys did nothing here, naming the terminal ⌘E types in: the selected workspace's front tab, as it is now. */
  const sayWhy = () => {
    const tile = selKey.current ? layoutNow.current.tiles.find((x) => x.key === selKey.current) : undefined;
    say(swallowedNote(tile ? titleOf(tile.front) : null));
  };
  /**
   * Typed keys the landscape swallowed, disarmed, say why: once each time the keyboard comes to it, never on each key,
   * nor during the tour's hold, which gives the keyboard back itself. The holder's (keyArm.ts) say it once each time
   * the keyboard goes there, here while the landscape is up, and in the status bar elsewhere (main.tsx).
   */
  const hintedAt = useRef(-1);
  const hintKeys = (key: string) => {
    if (QUIET_KEYS.has(key) || tourHold.current || hintedAt.current === keyboardSpell()) return;
    hintedAt.current = keyboardSpell();
    sayWhy();
  };
  const sayWhyNow = useRef(sayWhy);
  sayWhyNow.current = sayWhy;
  /**
   * Tab or Shift+Tab on the landscape disarmed: once keys have paused it leaves the landscape, for the first stop after
   * it or the last before it, so the keyboard alone gets past it; in a burst it's swallowed with the rest.
   */
  const tabbedOff = (e: React.KeyboardEvent) => e.key === "Tab" && !e.altKey && afterPause() && !!viewport.current && tabPast(viewport.current, e.shiftKey);
  useEffect(() => {
    // a terminal or a field being typed in that goes from under the user leaves the keyboard on the holder, not the page
    const release = holdNowhere();
    const on = () => sayWhyNow.current();
    document.addEventListener(KEYS_SWALLOWED, on);
    return () => {
      document.removeEventListener(KEYS_SWALLOWED, on);
      release();
    };
  }, []);
  // the surface's own keys: only while it has the keyboard itself, and what's typed only while the user armed it
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== viewport.current || focusNow.current) return;
    const cmd = e.metaKey && !e.ctrlKey && !e.altKey;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (typed(e) && !isArmed(viewport.current)) {
      handled();
      if (tabbedOff(e)) return;
      return hintKeys(e.key);
    }
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
    } else if (cmd && !e.shiftKey && e.key.toLowerCase() === "g" && pickedNow.current.length) {
      // ⌘G: the several's Stack row, as its button and right-click run it
      handled();
      runRow(pickedActions(), "stack");
    } else if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "t") {
      // T: the selected area's Tidy row (or the selected workspace's area's), as its ⋯ and toolbar run it
      handled();
      const key = selectedArea ?? (sel && sel.area !== LOOSE_GROUP ? sel.area : null);
      if (!key) return say("Select an area, or a workspace in one, to tidy it");
      runRow(areaHooks.bar(key).actions, "tidy");
    } else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "n" && onNeeds) {
      handled();
      onNeeds(e.shiftKey ? -1 : 1);
    } else if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      handled();
      onShortcuts();
    } else if (e.key === "Escape" && !e.metaKey && escapeClears({ selected: !!(pickedNow.current.length || selected || selectedArea), peek: !!peekNow.current, overlay: !!document.querySelector(OVERLAYS) })) {
      handled();
      clearSelection();
    }
  };
  // Mounted, the landscape takes the keyboard when nothing else has it, or a tab's button does (a palette or a menu
  // gives it back there). Armed, so `?` and the letters work without a click first, only when the user chose it: its
  // tab's button pressed (keyArm.ts's `tabChosen`, never read from where the keyboard is), or the window opening on it
  // before any input. Never with a reveal or a jump on its way, which place the keyboard themselves. Any other way (a
  // jump from another tab, ⌘K's Landscape row), disarmed. What closes over the app gives the keyboard back to the
  // landscape (or focus), disarmed, when nothing that had it is left.
  useEffect(() => {
    const chosen = takeTabChoice("sessions") || (!landscapeShownBefore && untouched());
    landscapeShownBefore = true;
    if (!keyboardNowhere() && !document.activeElement?.closest(".topbar .tabs")) return;
    if (chosen && !reveal && !keyboardClaimed()) armFocus(viewport.current);
    else viewport.current?.focus({ preventScroll: true });
  }, []);
  useKeyboardHome(surfaceEl);

  // A peek's keys, while the landscape is armed or the peek itself has the keyboard (never a terminal elsewhere, never
  // with the keyboard nowhere), and no menu or dialog is open: Space keeps it open, and closes it once kept; Esc closes
  // it; Enter focuses a kept-open one's workspace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const p = peekNow.current;
      if (!p || e.metaKey || e.ctrlKey || e.altKey || (e.key !== " " && e.key !== "Escape" && !(e.key === "Enter" && p.pinned))) return;
      if (!(isArmed(viewport.current) || document.activeElement?.closest(".ls-peek")) || document.querySelector(OVERLAYS)) return;
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

  // ⌘E focuses a workspace, or leaves focus, from anywhere in the window: from inside a
  // workspace (its terminal, say) that one, from anywhere else (the side bar just picked a session) the selected
  // one; with none, it arms the landscape. ⌘Esc leaves focus from anywhere. Both are taken before xterm sees them,
  // which would type Esc.
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
      if (!focused && !tile) {
        // nothing to focus: ⌘E arms the landscape itself, unless what has the keyboard reads keys itself
        if (ownsKeys(e.target as Element | null)) return;
        e.preventDefault();
        e.stopPropagation();
        armFocus(viewport.current);
        return;
      }
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

  // ---- first run: + New's menu, and the migration tour ----
  const newGiven = useRef(newAsk);
  useEffect(() => {
    if (newGiven.current === newAsk) return;
    newGiven.current = newAsk;
    const box = viewport.current?.getBoundingClientRect();
    if (!box) return;
    const at = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    // In focus the landscape behind isn't what's in view: what's made goes into the focused workspace's area, beside
    // it. Otherwise it's the area at the view's centre, where the menu opens over it.
    const f = focusNow.current ? layoutNow.current.tiles.find((t) => t.key === focusNow.current) : undefined;
    if (f) {
      const beside = { x: f.rect.x + f.rect.w + GAP, y: f.rect.y };
      ctx.openAt(at, menuOf(areaHooks.create(f.area === LOOSE_GROUP ? null : f.area, beside)));
      return;
    }
    const p = toLandscape(cam.current, { x: at.x - box.left, y: at.y - box.top });
    ctx.openAt(at, menuOf(areaHooks.create(areaAt(layoutNow.current.areas, p)?.key ?? null, p)));
  }, [newAsk]);
  /** A create-menu row run for a workspace placed at the view's centre: a tile of the empty landscape. */
  const runTile = (row: string) => {
    const v = vpNow.current;
    runRow(areaHooks.create(null, toLandscape(cam.current, { x: v.w / 2, y: v.h / 2 })), row);
  };

  // Due, the tour comes up once nothing else is open over the app (What's new after an update, the setup wizard): those
  // hold Esc, and it goes under them. It waits out focus, whose overlay covers what it points at, and picks up there.
  const tourWanted = tour.due && hasSize && !focusTile;
  /** The session whose terminal had the keyboard as the tour came up. */
  const tourTerm = useRef<string | null>(null);
  const [tourUp, setTourUp] = useState(false);
  tourUpNow.current = tourUp;
  const [tourAt, setTourAt] = useState(0);
  useEffect(() => {
    if (!tourWanted) return setTourUp(false);
    const ready = () => {
      if (document.querySelector(OVER_TOUR)) return false;
      const a = document.activeElement;
      tourTerm.current = a?.closest(".ls-world .xterm") ? (a.closest<HTMLElement>(".ls-node")?.dataset.front ?? null) : null;
      tourJump.current = { jumped: false, asked: null };
      tourHold.current?.();
      setTourUp(true);
      stopHover();
      closePeek();
      return true;
    };
    if (ready()) return;
    const t = setInterval(() => ready() && clearInterval(t), TOUR_WAIT_MS);
    return () => clearInterval(t);
  }, [tourWanted]);
  const tourArea = useRef<string | null>(null);
  if (tourUp && !layout.areas.some((a) => a.key === tourArea.current)) tourArea.current = tourAreaOf(layout, cam.current, vpNow.current);
  const tourList = tourUp ? tourSteps(layout, tourArea.current) : null;
  const tourStep = tourList ? Math.min(tourAt, tourList.length - 1) : 0;
  /** What a step on the landscape spotlights, as the camera has it now, in the view's px with what's drawn above it. */
  const tourPlace = (t: Exclude<TourTarget, { kind: "chrome" }>): { rect: Rect; box: Box } | null => {
    if (t.kind === "place") return { rect: t.rect, box: barAnchor(t.rect, cam.current, "none") };
    const a = layoutNow.current.areas.find((x) => x.key === t.key);
    if (!a) return null;
    return { rect: areaShown(a), box: barAnchor(areaShown(a), cam.current, a.rect.collapsed ? "pill" : bandNow.current === "cards" ? "areaName" : "areaHeader") };
  };
  const tourTarget = tourList?.[tourStep].target;
  const tourTargetKey = tourTarget && (tourTarget.kind === "chrome" ? null : tourTarget.kind === "area" ? `area:${tourTarget.key}` : `at:${tourTarget.rect.x},${tourTarget.rect.y}`);
  useEffect(() => {
    if (!tourTarget || tourTarget.kind === "chrome" || !vpNow.current.w) return;
    const at = tourPlace(tourTarget);
    const to = at && tourCamera(at.rect, at.box, vpNow.current, topNow.current);
    if (!to) return;
    // an earlier step's move, or one kept from before a tab away or a restart (the camera then is the one it came from)
    const kept = tourMoved();
    const from = kept && (tourHolds(kept) || sameCamera(cam.current, kept.from)) ? kept.from : cam.current;
    writePref(TOUR_CAMERA_PREF, { from, to });
    placed.current = true;
    flyTo(to);
  }, [tourTargetKey]);
  /** The camera goes back where the tour found it, unless something has moved it since: a flight still on its way to the tour's place is the tour's. */
  const endTour = () => {
    const moved = tourMoved();
    if (moved && tourHolds(moved)) flyTo(moved.from);
    writePref(TOUR_CAMERA_PREF, null);
    tour.onEnd();
  };
  /** A terminal on the landscape asked for the keyboard while the tour holds it (a jump to its session). */
  const tourKeysAsked = (el: Element) => {
    const id = el.closest<HTMLElement>(".ls-world .ls-node")?.dataset.front;
    if (id) tourJump.current.asked = id;
  };
  /** Ends the hold on the keyboard after the tour (tourClosed), while it's on. */
  const tourHold = useRef<(() => void) | null>(null);
  useEffect(() => () => tourHold.current?.(), []);
  /**
   * The tour has gone. The terminal that had the keyboard as it came up gets it back, or the one a jump during it asked
   * for it; a jump that asked for none leaves it nowhere, as does a view the terminal takes no keys in and isn't on its
   * way back to. It gets it back only once keys pause (TYPING_MS, as the card has it) and the camera is back in the
   * band where terminals take keys: till then the tour's hold swallows what's typed, so a burst typed through the end
   * reaches nothing, never its tail. A press, or the keyboard going anywhere, ends the hold; with the camera still not
   * there by the cap (from the end, or the last key) the keyboard is left nowhere, said in the log. None of it ever arms
   * the landscape (keyArm.ts).
   */
  const tourClosed = () => {
    const { jumped, asked } = tourJump.current;
    const id = asked ?? (jumped ? null : tourTerm.current);
    // the tour came up over a terminal being typed in, or one asked for the keyboard under it: with nothing to give it
    // back to yet, it waits on the holder (keyArm.ts), never the page, where Tab walks on from the tour's card
    const hid = tourTerm.current !== null || asked !== null;
    const park = (quiet: boolean) => void (hid && keyboardNowhere() && toNowhere(quiet));
    tourTerm.current = null;
    tourJump.current = { jumped: false, asked: null };
    if (!id || !layoutNow.current.tiles.some((t) => t.members.some((m) => m.id === id))) return park(false);
    const coming = () => takesKeys(bandNow.current) || !!flight.current || !!bandWait.current;
    const there = () => takesKeys(bandNow.current) && !bandWait.current && !flight.current;
    if (!coming()) return park(false);
    park(true);
    const closedAt = performance.now();
    let keyAt = closedAt - sinceKey();
    const onKey = (e: KeyboardEvent) => {
      keyAt = performance.now();
      if (!typed(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    // the keyboard given anywhere (its terminal included) ends the hold; the holder, where it waits, doesn't
    const onFocus = (e: FocusEvent) => void (!isNowhere(e.target as Element | null) && stop());
    const stop = () => {
      clearInterval(wait);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", stop, true);
      document.removeEventListener("focusin", onFocus, true);
      if (tourHold.current === stop) tourHold.current = null;
    };
    const tick = () => {
      const now = performance.now();
      if (now - keyAt >= TYPING_MS && there()) {
        focusTerm(id);
        if (termHasKeys(id)) return stop();
      }
      if (!coming()) {
        stop();
        return park(false);
      }
      if (now - Math.max(keyAt, closedAt) < TOUR_KEYS_BACK_MS) return;
      stop();
      toNowhere();
      console.warn(`[mockingbird] the tour couldn't give ${id}'s terminal its keyboard back within ${TOUR_KEYS_BACK_MS} ms of the last key: it's left nowhere`);
    };
    const wait = setInterval(tick, 50);
    tourHold.current?.();
    tourHold.current = stop;
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", stop, true);
    document.addEventListener("focusin", onFocus, true);
  };

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
    if (g.kind === "window" || g.kind === "card") {
      const v = g.kind === "window" ? l.windows.find((x) => x.id === g.key) : l.cards.find((x) => x.id === g.key);
      if (!v) return false;
      const key = "win" in v ? v.area : v.card.area;
      const a = key === null ? undefined : l.areas.find((x) => x.key === key);
      if (a?.rect.locked) {
        say(`${areaTitle(a.key)} is locked: unlock it to move what's in it`);
        return false;
      }
      const el = world.current?.querySelector<HTMLElement>(g.kind === "window" ? `.ls-window[data-win="${CSS.escape(g.key)}"]` : `.ls-acard[data-card="${CSS.escape(g.key)}"]`);
      g.els = el ? [el] : [];
    } else if (g.kind === "tile" || g.kind === "resize" || g.kind === "tab") {
      const t = l.tiles.find((x) => x.key === g.key);
      const a = t && l.areas.find((x) => x.key === t.area);
      if (!t) return false;
      if (a?.rect.locked) {
        say(`${areaTitle(a.key)} is locked: unlock it to ${g.kind === "resize" ? "resize" : g.kind === "tab" ? "take tabs out of" : "move"} its workspaces`);
        return false;
      }
      const theirs = g.kind === "resize" ? t.members.find(isRemote) : g.kind === "tab" ? t.members.find((m) => m.id === g.sid && isRemote(m)) : undefined;
      if (theirs) {
        say(g.kind === "resize" ? `${theirs.room?.ownerName ?? "A teammate"}'s workspace is the size their terminal is` : `${theirs.room?.ownerName ?? "A teammate"}'s session leaves the stack only on their Mac`);
        return false;
      }
      // a resize and a tab show where they'd land (sizeBox); the workspace itself moves only when it's dragged
      g.els = g.kind === "tile" ? [nodeEl(t.key)].filter((x): x is HTMLElement => !!x) : [];
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
      const far = Math.hypot(dx, dy);
      if (far < DRAG_PX) return;
      const s = g.strip;
      if (g.kind === "tab" && far < TAB_DRAG_PX && s && e.clientX >= s.left && e.clientX <= s.right && e.clientY >= s.top - TAB_SLIP_PX && e.clientY <= s.bottom + TAB_SLIP_PX) return;
      if (!begin(g)) return endGesture();
      g.on = true;
      // the selection bar is put away while anything is dragged, and comes back where the drop leaves its selection
      viewport.current?.classList.add("ls-dragging");
    }
    e.preventDefault();
    if (g.kind === "marquee") {
      const r = viewport.current!.getBoundingClientRect();
      const box = rectFrom({ x: g.x0 - r.left, y: g.y0 - r.top }, { x: e.clientX - r.left, y: e.clientY - r.top });
      const m = marquee.current;
      if (m) Object.assign(m.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
      const keys = tilesIn(layoutNow.current.tiles, rectFrom(atPoint({ clientX: g.x0, clientY: g.y0 }), atPoint(e)));
      const next = g.add ? [...new Set([...g.base, ...keys])] : keys;
      if (next.join("\n") !== pickedNow.current.join("\n")) pickTiles(next);
      return;
    }
    const z = cam.current.zoom;
    if (g.kind === "tile" || g.kind === "resize" || g.kind === "tab") {
      const l = layoutNow.current;
      const t = l.tiles.find((x) => x.key === g.key);
      if (!t) return;
      const target = dropArea(e);
      // snapped to the grid and to the edges of what's near, in the area it's over (its inside edges too)
      const inner = innerOf(g.kind === "resize" ? t.area : target);
      const others = snapTargets(t.key);
      const ddx = dx / z;
      const ddy = dy / z;
      if (g.kind === "resize") {
        const ed = g.edges!;
        const want: Rect = {
          x: ed.left ? t.rect.x + ddx : t.rect.x,
          y: ed.top ? t.rect.y + ddy : t.rect.y,
          w: t.rect.w + (ed.right ? ddx : ed.left ? -ddx : 0),
          h: t.rect.h + (ed.bottom ? ddy : ed.top ? -ddy : 0),
        };
        const s = snapRect(want, ed, others, z, inner, minWorkspace());
        g.snapped = s.rect;
        const held = colsRows(s.rect.w, s.rect.h, CELL_ESTIMATE.w, CELL_ESTIMATE.h);
        showBox(s.rect, `${held.cols} × ${held.rows}`);
        drawGuides(s.guides);
        return;
      }
      const s = snapRect({ ...t.rect, x: t.rect.x + ddx, y: t.rect.y + ddy }, MOVE_EDGES, others, z, inner);
      g.snapped = s.rect;
      drawGuides(s.guides);
      if (g.kind === "tab") {
        const m = t.members.find((x) => x.id === g.sid);
        showBox(s.rect, m ? titleOf(m) : "");
      } else {
        for (const el of g.els) el.style.translate = `${s.rect.x - t.rect.x}px ${s.rect.y - t.rect.y}px`;
        wiresRef.current?.follow();
      }
      const a = l.areas.find((x) => x.key === target);
      setHot(a && (target !== t.area || g.kind === "tab") && !a.rect.locked ? target : null);
      return;
    }
    for (const el of g.els) el.style.translate = `${dx / z}px ${dy / z}px`;
    wiresRef.current?.follow();
  };
  /** What a workspace moved or resized snaps to: everything else drawn (workspaces, ghosts, windows, cards) but `except`. */
  const snapTargets = (except: string): Rect[] => {
    const l = layoutNow.current;
    return [
      ...l.tiles.filter((t) => !t.hidden && t.key !== except).map((t) => t.rect),
      ...l.ghosts.filter((g) => !g.hidden).map((g) => g.rect),
      ...l.windows.filter((w) => !w.hidden).map((w) => w.rect),
      ...l.cards.filter((c) => !c.hidden).map((c) => c.rect),
    ];
  };
  /** Area `key`'s inside (inside its padding, under its header): what's dropped or resized in it lines up with; null for none, or a collapsed one. */
  const innerOf = (key: string): Rect | null => {
    const a = layoutNow.current.areas.find((x) => x.key === key && !x.rect.collapsed)?.rect;
    return a ? { x: a.x + AREA_PAD, y: a.y + AREA_HEADER, w: a.w - 2 * AREA_PAD, h: a.h - AREA_HEADER - AREA_PAD } : null;
  };
  /** The guides a drag snapped along, drawn in the world at a screen px wide; none takes them away. Never through a render. */
  const drawGuides = (guides: readonly Guide[]) => {
    const el = guidesEl.current;
    if (!el) return;
    // 1 px on screen, running GUIDE_PAST_PX past both ends, so it reads as a line apart from the edges it lines up
    const w = 1 / cam.current.zoom;
    const past = GUIDE_PAST_PX * w;
    el.replaceChildren(
      ...guides.map((g) => {
        const d = document.createElement("div");
        d.className = "ls-guide";
        d.dataset.axis = g.axis;
        const from = g.from - past;
        const len = g.to - g.from + 2 * past;
        Object.assign(d.style, g.axis === "x" ? { left: `${g.at - w / 2}px`, top: `${from}px`, width: `${w}px`, height: `${len}px` } : { left: `${from}px`, top: `${g.at - w / 2}px`, width: `${len}px`, height: `${w}px` });
        return d;
      })
    );
  };
  /** Where a resize or a tab dragged out would land, with what it says (cols × rows, the tab's name); null hides it. */
  const showBox = (r: Rect | null, label = "") => {
    const el = sizeBox.current;
    if (!el) return;
    el.hidden = !r;
    if (!r) return;
    Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    el.style.setProperty("--ls-inv", String(1 / cam.current.zoom));
    el.dataset.size = `${r.w}x${r.h}`;
    const span = el.firstElementChild as HTMLElement | null;
    if (span) span.textContent = label;
  };
  const gestureUp = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.id) return;
    endGesture();
    if (g.on) droppedAt.current = { x: e.clientX, y: e.clientY };
    if (e.type === "pointercancel") return release(g.els);
    const l = layoutNow.current;
    const z = cam.current.zoom;
    const dx = (e.clientX - g.x0) / z;
    const dy = (e.clientY - g.y0) / z;
    if (g.kind === "marquee") {
      // a click on the bare landscape selects the area it's in, as a click on a section does in Figma; outside every
      // area it lets the selection go
      if (!g.on && !g.add) {
        const a = areaAt(l.areas, atPoint(e));
        if (a) selectArea(a.key);
        else clearSelection();
      }
      return;
    }
    if (!g.on) {
      // a click on an area's bare header, or its name zoomed out, selects it; a drag moves it
      if (g.kind === "area") selectArea(g.key);
      else if (g.kind === "tab") {
        // a tab pressed and let go without being dragged out is a click on it, however the pointer slipped: the
        // browser's click lands where the press and the release meet (its header, or past it), so it's brought to the
        // front here and that click taken
        swallowClick();
        const t = l.tiles.find((x) => x.key === g.key);
        if (t && g.sid && t.front.id !== g.sid && t.members.some((m) => m.id === g.sid)) onTab(t, g.sid);
      }
      return;
    }
    if (g.kind === "window" || g.kind === "card") {
      const v = g.kind === "window" ? l.windows.find((x) => x.id === g.key) : l.cards.find((x) => x.id === g.key);
      if (!v) return release(g.els);
      const plan = planMoveExtra(storedNow.current, l, g.kind, g.key, { x: v.rect.x + dx, y: v.rect.y + dy }, dropArea(e), areaTitle);
      if ("refused" in plan) {
        release(g.els);
        return say(plan.refused);
      }
      const from = v.rect;
      const id = g.key;
      void carryOut(plan, g.kind === "window" ? "the window's place" : "the card's place", {
        els: g.els,
        moved: () => {
          const now = (g.kind === "window" ? layoutNow.current.windows : layoutNow.current.cards).find((x) => x.id === id);
          return !now || now.rect.x !== from.x || now.rect.y !== from.y;
        },
      });
      return;
    }
    if (g.kind === "resize") {
      const t = l.tiles.find((x) => x.key === g.key);
      if (!t || !g.snapped) return;
      const plan = planResizeTo(storedNow.current, l, t.key, g.snapped, areaTitle);
      if ("refused" in plan) return say(plan.refused);
      void carryOut(plan, `${titleOf(t.front)}'s size`);
      return;
    }
    if (g.kind === "tab") {
      // a tab dragged out leaves its stack where it's dropped; the click its release would make doesn't switch to it
      swallowClick();
      const t = l.tiles.find((x) => x.key === g.key);
      const s = t?.members.find((m) => m.id === g.sid);
      if (!t || !s || !g.snapped) return;
      const plan = planUnstack(storedNow.current, l, s.id, { x: g.snapped.x, y: g.snapped.y }, dropArea(e), areaTitle);
      if ("refused" in plan) return say(plan.refused);
      void unstack(plan, s, t);
      return;
    }
    if (g.kind === "tile") {
      const t = l.tiles.find((x) => x.key === g.key);
      if (!t) return release(g.els);
      const to = g.snapped ?? { x: t.rect.x + dx, y: t.rect.y + dy };
      const plan = planMoveTile(storedNow.current, l, t.key, { x: to.x, y: to.y }, dropArea(e), areaTitle);
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
  /** The click a drag's release would make (a tab's: switching to it) is taken before it reaches anything. */
  function swallowClick() {
    const stop = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    window.addEventListener("click", stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
  }
  function endGesture() {
    gesture.current = null;
    if (marquee.current) marquee.current.hidden = true;
    drawGuides([]);
    showBox(null);
    setHot(null);
    viewport.current?.classList.remove("ls-gesture");
    // a drop's settling starts as it's carried out, just after this: the bar waits for it
    requestAnimationFrame(dragDone);
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
      // a button drawn over the terminal (a typing ask's Allow and Deny, Jump to latest, an exited session's Resume)
      // takes the mouse at any zoom: only the terminal waits for 100%, where its cells are where xterm puts them
      if (t?.closest?.("button") && !t.closest(".term-holder")) return null;
      return t?.closest?.(".ls-world .ls-term") ? t.closest<HTMLElement>(".ls-node") : null;
    };
    const onWheel = (e: WheelEvent) => {
      if (inFocus(e.target)) return;
      const zooming = e.ctrlKey || e.metaKey;
      const node = (e.target as Element | null)?.closest?.(".ls-node") as HTMLElement | null;
      // a tool window's body scrolls itself in the live band, as a side bar view would; zoomed out the wheel pans
      if (!zooming && takesKeys(bandNow.current) && (e.target as Element | null)?.closest?.(".ls-world .ls-win-body")) return;
      // the selected workspace's terminal scrolls its own history while it takes the mouse; any other wheel moves the landscape
      if (!zooming && mouseAt(cam.current.zoom) && node && node.dataset.ws === selKey.current && (e.target as Element).closest(".term-holder")) return;
      // the empty landscape's words, taller than a short view, scroll themselves (LandscapeEmpty)
      if (!zooming && (e.target as Element | null)?.closest?.(".ls-empty[data-scrolls]")) return;
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
      // A press on the landscape arms it (keyArm.ts): at once if it has the keyboard, or as the press gives it it. A
      // press that gives the keyboard to something of its own (a terminal, a button) arms nothing.
      if (inFocus(e.target)) return armOnPress(overlay.current);
      armOnPress(viewport.current);
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
      // Shift adds to the selection, as in Figma: to those picked, or to the one workspace selected
      const base = pickedNow.current.length || !e.shiftKey || !selKey.current ? pickedNow.current : [selKey.current];
      const toggled = (key: string) => (base.includes(key) ? base.filter((k) => k !== key) : [...base, key]);
      if (off) {
        // the terminal never sees it: its workspace is selected (Shift: picked, or let go, as a Shift-click on its
        // header does), and the keyboard goes to its terminal as a click on it would, while the band lets terminals
        // take keys; below that the landscape keeps it
        e.preventDefault();
        e.stopPropagation();
        if (e.button !== 0) return;
        const tile = layoutNow.current.tiles.find((x) => x.key === off.dataset.ws);
        if (!tile) return;
        if (e.shiftKey) return selRefs.current.pickTiles(toggled(tile.key));
        selectRef.current(tile);
        // the press's own: the landscape keeps the keyboard armed
        setTimeout(() => (tile.front.status !== "dead" && takesKeys(bandNow.current) ? focusTerm(tile.front.id) : armFocus(viewport.current)), 0);
        return;
      }
      if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const node = t.closest<HTMLElement>(".ls-world .ls-node");
        const press = { id: e.pointerId, x0: e.clientX, y0: e.clientY, add: e.shiftKey, base };
        const win = t.closest<HTMLElement>(".ls-world .ls-window");
        const card = t.closest<HTMLElement>(".ls-world .ls-acard");
        const rz = t.closest<HTMLElement>(".ls-world .ls-rz");
        const tab = t.closest<HTMLElement>(".ls-world .ls-tab[data-sid]");
        if (node && rz && !e.shiftKey) {
          // an edge or a corner resizes it
          e.stopPropagation();
          startRef.current({ ...press, kind: "resize", key: node.dataset.ws!, edges: edgesOf(rz.dataset.edge as ResizeEdge) });
        } else if (node && tab && !e.shiftKey) {
          // a tab dragged out leaves its stack; a click on it (no drag) still brings it to the front
          startRef.current({ ...press, kind: "tab", key: node.dataset.ws!, sid: tab.dataset.sid, strip: (tab.closest(".ls-head") ?? tab).getBoundingClientRect() });
        } else if (node && (node.classList.contains("card") || t.closest(".ls-head")) && !t.closest("button")) {
          const key = node.dataset.ws!;
          // Shift-click picks it, or lets it go, and selects nothing else (its own press would select it alone);
          // otherwise its header (or its card) moves it
          if (e.shiftKey) {
            e.stopPropagation();
            selRefs.current.pickTiles(toggled(key));
          } else startRef.current({ ...press, kind: "tile", key });
        } else if (win && (win.classList.contains("compact") || t.closest(".ls-win-head")) && !t.closest("button")) {
          // a tool window moves by its head (or, zoomed out, by its whole compact self)
          startRef.current({ ...press, kind: "window", key: win.dataset.win! });
        } else if (card && !t.closest("button, a, input")) {
          startRef.current({ ...press, kind: "card", key: card.dataset.card! });
        } else if (!node && !win && !card && !t.closest(".ls-hud, .ls-banners, .ls-peek, .ls-ah, .ls-area-title, .ls-area-tools, .ls-area-pill, .ls-switcher, .ls-minimap, .ls-selbar, .ls-note, .ls-empty, .ls-ghost button")) {
          // a ghost isn't selected: a press on it is one on the landscape where it lies, its buttons aside
          startRef.current({ ...press, kind: "marquee", key: "" });
        }
      }
      // a press on the landscape between workspaces gives it the keyboard
      if (e.button === 0 && !t.closest(".ls-node, .ls-window, .ls-acard, .ls-hud, .ls-banners, .ls-peek, .ls-switcher, .ls-minimap, .ls-selbar")) surface();
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
      // a marquee or a drag holds the peek off while it lasts, and what a drop leaves under the pointer (a tab taken out,
      // a workspace moved) doesn't peek until the pointer moves on
      if (gesture.current) return;
      const dropped = droppedAt.current;
      if (dropped && Math.hypot(e.clientX - dropped.x, e.clientY - dropped.y) < DRAG_PX) return;
      droppedAt.current = null;
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
      if (tile && pairOn(tile.key)) enterRef.current(tile);
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
    // A press on a button of the landscape's own (the zoom HUD's, the selection bar's, a header's, a ghost's) never
    // gives the button the keyboard, where a Space meant for a peek would press it again. A terminal or a field being
    // typed in keeps it (the press is the button's, and what's typed next is still the terminal's: Esc still reaches
    // Claude in focus); from the landscape itself, or from nowhere, the press arms the landscape, or focus's frame, as
    // a press beside it does. Tab still reaches the buttons from the armed landscape.
    const onButtonDown = (e: MouseEvent) => {
      const at = e.button === 0 ? (e.target as Element | null) : null;
      // the bare header of the workspace whose terminal is being typed in is the same: the keyboard stays there, and a
      // drag by it still moves the workspace. Another workspace's header selects it and arms the landscape, as before
      if (at?.closest?.(".ls-head") && !at.closest("button, [role=button], a[href]") && ownTermHasKeys(at)) return e.preventDefault();
      const b = at?.closest?.("button, [role=button], a[href]");
      if (!b || b.closest(".xterm, .ls-peek, input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      const a = document.activeElement;
      if (ownsKeys(a) || (!keyboardNowhere() && !v.contains(a))) return;
      armFocus(inFocus(b) ? overlay.current : viewport.current);
    };
    v.addEventListener("wheel", onWheel, { capture: true, passive: false });
    v.addEventListener("pointerdown", onDown, true);
    v.addEventListener("keydown", offKeys, true);
    v.addEventListener("auxclick", onAux, true);
    v.addEventListener("mousedown", onButtonDown, true);
    for (const type of MOUSE) v.addEventListener(type, offMouse, true);
    v.addEventListener("pointerover", onOver);
    v.addEventListener("pointermove", onPeekMove);
    v.addEventListener("pointerleave", onLeave);
    return () => {
      v.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      v.removeEventListener("pointerdown", onDown, true);
      v.removeEventListener("keydown", offKeys, true);
      v.removeEventListener("auxclick", onAux, true);
      v.removeEventListener("mousedown", onButtonDown, true);
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
  const areaViews = layout.areas.map((a) => ({ a, accent: accents.get(a.key) ?? accentOf(a.key), counts: areaCounts(layout.tiles, a.key, layout.ghosts), title: areaTitle(a.key), info: areaHooks.info(a.key) }));
  const loose = useMemo(() => (switcher ? looseStop(layout.tiles) : null), [switcher, layout]);
  const stops = useMemo(() => (loose ? [...layout.areas, loose] : layout.areas), [loose, layout]);
  const wireBook = useWires().state;
  const wireList = useMemo(() => wireViews(wireBook, layout, rooms), [wireBook, layout, rooms]);

  const tileActions = (t: Tile): ModelAction[] => actionsFor(t);
  /** The picked workspaces still drawn, in layout order. */
  const pickedTiles = (): Tile[] => layoutNow.current.tiles.filter((t) => !t.hidden && pickedNow.current.includes(t.key));
  /** The picked workspaces stacked into one card with a tab each (planStack): its front tab is selected once it's made. */
  const stackPicked = async () => {
    const keys = pickedNow.current;
    const plan = planStack(storedNow.current, layoutNow.current, keys, asks.current.areaTitle);
    if ("refused" in plan) return say(plan.refused);
    const front = layoutNow.current.tiles.filter((t) => keys.includes(t.key)).sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)[0]?.front.id ?? null;
    if (await carryOut(plan, "stacking them")) {
      setPicked([]);
      if (front) onSelect(front);
    }
  };
  /** The picked workspaces moved into area `key`, as Make area… with that area's name does (planMakeArea). */
  const moveTo = async (key: string) => {
    const keys = pickedNow.current;
    if (!keys.length) return;
    const plan = planMakeArea(storedNow.current, layoutNow.current, keys, key, asks.current.areaTitle);
    if ("refused" in plan) return say(plan.refused);
    if (await carryOut(plan, `moving them to ${asks.current.areaTitle(key)}`)) setPicked([]);
  };
  /**
   * The picked workspaces' actions, one model their bar and their right-click render: Move to area's rows say why an
   * area can't take them as moving them would (planMakeArea, tried first), and Close… closes every one of this Mac's
   * sessions in them, a stack's tabs included (a teammate's tab is theirs to close).
   */
  const pickedActions = (): ModelAction[] => {
    const tiles = pickedTiles();
    const ids = tiles.flatMap((t) => t.members.filter((m) => !isRemote(m)).map((m) => m.id));
    const stackPlan = planStack(storedNow.current, layoutNow.current, pickedNow.current, asks.current.areaTitle);
    return severalActions({
      makeArea: () => void makeArea(),
      stack: "refused" in stackPlan ? { no: stackPlan.refused } : () => void stackPicked(),
      areas: moveTargets(storedNow.current, layoutNow.current, pickedNow.current, asks.current.areaTitle).map((a) => ({ ...a, pick: () => void moveTo(a.key) })),
      close: ids.length ? () => onCloseMany(ids) : { no: tiles.length ? "They're teammates' sessions: theirs to close" : "Nothing to close" },
    });
  };
  /** Several picked: their actions as a menu (a right-click on one of them, or on their bar). */
  const pickedMenu = (): MenuEntry[] => severalMenu(pickedTiles().length, pickedActions());
  /**
   * A right-click on the bare landscape at landscape point `p`: what can be made there (placed where it was clicked),
   * and inside an area that area's own actions, its New session row aside (the kinds above make one there).
   */
  const emptyMenu = (area: string | null, p: Point): MenuEntry[] => {
    const create = menuOf(areaHooks.create(area, p));
    if (!area) return create;
    return tidyMenu([...create, "-", ...menuOf(areaHooks.bar(area).actions.filter((a) => a.key !== "new"))]);
  };
  /**
   * Right-click anywhere on the landscape that has no menu of its own: on a workspace (header, footer, card, or its
   * terminal while that doesn't take the mouse), its actions, or the several's when it's one of those picked; on the
   * bare landscape, what can be made there, and inside an area (which it selects) the area's actions too.
   */
  const onContextMenu = (e: React.MouseEvent) => {
    const t = e.target as Element;
    const ghostEl = t.closest<HTMLElement>(".ls-world .ls-ghost");
    if (ghostEl) {
      // a ghost's right-click: its actions, as its ⋯ has them
      const g = layout.ghosts.find((x) => x.key === ghostEl.dataset.ghost);
      if (!g) return;
      e.preventDefault();
      ctx.openAt({ x: e.clientX, y: e.clientY }, menuOf(ghostActions(g.front, g.members)));
      return;
    }
    const el = t.closest<HTMLElement>(".ls-node");
    if (el) {
      // a terminal that takes the mouse (at 100%, and in focus) keeps its own right-click
      if ((mouseAt(cam.current.zoom) || el.closest(".ls-focus")) && t.closest(".term-holder")) return;
      const inFocus = focusNow.current && el.closest(".ls-focus");
      const tile = (inFocus ? layout.tiles.find((x) => x.key === focusNow.current) : null) ?? layout.tiles.find((x) => x.key === el.dataset.ws);
      if (!tile) return;
      e.preventDefault();
      // a stack's tab is its own session's: its rename, close, resume and take-over, not the front one's
      const closedTab = t.closest<HTMLElement>(".ls-tab.closed[data-closed]");
      const closed = closedTab && tile.closed?.find((m) => m.id === closedTab.dataset.closed);
      if (closed) return ctx.openAt({ x: e.clientX, y: e.clientY }, menuOf(ghostActions(closed)));
      const tab = t.closest<HTMLElement>(".ls-tab[data-sid]");
      const of = tab ? tile.members.find((m) => m.id === tab.dataset.sid) : undefined;
      // a picked stack's front tab is the stack, as its header is: the picked ones' menu
      if (!inFocus && !(of && of.id !== tile.front.id) && pickedNow.current.includes(tile.key)) return ctx.openAt({ x: e.clientX, y: e.clientY }, pickedMenu());
      select(tile);
      ctx.openAt({ x: e.clientX, y: e.clientY }, menuOf(of && of.id !== tile.front.id ? actionsFor(tile, of) : tileActions(tile)));
      return;
    }
    if (t.closest(".ls-window, .ls-acard, .ls-hud, .ls-minimap, .ls-switcher, .ls-peek, .ls-selbar, .ls-banners, .ls-focus, .ls-note")) return;
    e.preventDefault();
    const p = atPoint(e);
    const a = areaAt(layout.areas, p);
    if (a) selectArea(a.key);
    ctx.openAt({ x: e.clientX, y: e.clientY }, emptyMenu(a?.key ?? null, p));
  };
  const dockWindow = (id: string) => {
    const plan = planDockWindow(storedNow.current, id);
    if ("refused" in plan) return say(plan.refused);
    void carryOut(plan, "docking the window");
  };

  // ---- the selection bar (designs Q and Q2): the selection's actions at normal size, whatever the zoom ----
  const [barExtended, setBarExtended] = useState(readBarExtended);
  const extendBar = (on: boolean) => {
    setBarExtended(on);
    saveBarExtended(on);
  };
  /**
   * The bar over what's selected: several picked workspaces, else an area, else a workspace. Not in focus, which fills
   * the window with the workspace and its header; nor for a workspace in the live band, whose header carries Focus,
   * its chips and ⋯ near full size, and is typed in there (the bar would cover the row above it, often its area's
   * header). Put away while anything is dragged (styles.css, .ls-dragging).
   */
  const selectionBar = () => {
    if (!vp || focusTile) return null;
    const place = (rect: Rect, chrome: BarChrome, within?: BarTarget["within"]): BarPlace => ({
      target: { rect, chrome, within },
      listeners: listeners.current,
      cam,
      vp,
      minTop: topNow.current,
      // the minimap, bottom right (styles.css .ls-minimap): shown whenever there's a selection to have a bar for
      avoid: { x: vp.w - MINIMAP_INSET - MINIMAP.w, y: vp.h - MINIMAP_INSET - MINIMAP.h, ...MINIMAP },
      extended: barExtended,
      onExtended: extendBar,
      onClear: () => {
        clearSelection();
        surface();
      },
    });
    // workspaces' bar goes above their area's name line or header, rather than on it, when they're in its first row
    const areaChrome: BarChrome = band === "cards" ? "areaName" : "areaHeader";
    const within = (top: Tile): BarTarget["within"] => {
      const a = layout.areas.find((x) => x.key === top.area);
      return a && !a.rect.collapsed ? { rect: a.rect, chrome: areaChrome } : undefined;
    };
    const several = layout.tiles.filter((t) => !t.hidden && pickedSet.has(t.key));
    if (several.length) {
      const top = several.reduce((m, t) => (t.rect.y < m.rect.y ? t : m));
      return <SeveralBar key="several" count={several.length} items={severalBarItems(pickedActions())} menu={pickedMenu} place={place(boundsOf(several.map((t) => t.rect))!, "none", within(top))} />;
    }
    const a = selectedArea ? layout.areas.find((x) => x.key === selectedArea) : undefined;
    if (a) {
      const b = areaHooks.bar(a.key);
      const title = areaTitle(a.key);
      return (
        <AreaBar
          key={`area:${a.key}`}
          name={shortAreaName(a.key, title)}
          title={title}
          accent={accents.get(a.key) ?? accentOf(a.key)}
          status={areaStatus(areaCounts(layout.tiles, a.key, layout.ghosts))}
          actions={b.actions}
          roomId={b.roomId}
          members={b.members}
          place={place(a.rect, a.rect.collapsed ? "pill" : areaChrome)}
        />
      );
    }
    if (!sel || sel.hidden || band === "live") return null;
    const t = sel;
    return <WorkspaceBar key={`ws:${t.key}`} session={t.front} actions={tileActions(t)} runs={chromeFor(t.front).chips.runCount ?? 0} onFocus={() => enterFocus(t)} place={place(t.rect, "none", within(t))} />;
  };

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
      onFocus={(tile, doubled) => (!doubled || pairOn(tile.key)) && enterFocus(tile)}
      onBack={leaveFocus}
      onTab={onTab}
      actions={tileActions(t)}
      chrome={chromeFor(t.front)}
      onMore={(tile, from) => {
        select(tile);
        ctx.openBelow(from, menuOf(tileActions(tile)));
      }}
      onClosedTab={(s, from) => ctx.openBelow(from, menuOf(ghostActions(s)))}
      body={(s, sz) => body(s, sz, mode === "focus" ? { w: t.rect.w, h: t.rect.h } : null)}
    />
  );

  return (
    <div className="ls-wrap">
      <div
        ref={viewport}
        className="ls-viewport"
        {...{ [HOLDS_KEYS]: "" }}
        tabIndex={0}
        aria-label="Landscape — scroll to pan, ⌘-scroll or pinch to zoom, ⌘0 fits everything, ⌘1 is 100%, ⌥-arrows move between workspaces, Enter focuses"
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
        onBlur={(e) => e.target === viewport.current && space.current && dropSpace()}
      >
        <LiftOut.Provider value={true}>
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
              needs={needs?.get(a.key) ?? 0}
              hot={hot === a.key}
              selected={selectedArea === a.key && !pickedCount}
              onSelect={() => selectArea(a.key)}
              menu={() => areaHooks.menu(a.key)}
              arrange={a.rect.collapsed ? [] : ((acts) => ARRANGE.flatMap((k) => acts.filter((t) => t.key === k)))(areaHooks.bar(a.key).actions)}
              onCollapse={(on) => setAreaFlag(a.key, "collapsed", on)}
              onGrab={(e) => grabArea(a.key, e)}
            />
          ))}
          <WireLayer ref={wiresRef} views={wireList} band={band} cam={cam} listeners={listeners.current} />
          {layout.ghosts.map((g) => (
            <GhostCard
              key={g.key}
              ghost={g}
              band={band}
              actions={ghostActions(g.front, g.members)}
              status={ghostStatus(g.front)}
              inv={1 / cam.current.zoom}
              onMore={(from) => ctx.openBelow(from, menuOf(ghostActions(g.front, g.members)))}
            />
          ))}
          {layout.tiles.map((t) => node(t, modeOf(t), { w: t.rect.w, h: t.rect.h }))}
          {layout.windows.map((w) => {
            if (w.hidden) return null;
            const { scope, body: inner, count } = windowFor(w, band === "live" && seenSet.has(`${WIN_SEEN}${w.id}`));
            return (
              <ToolWindow
                key={w.id}
                id={w.id}
                tool={w.win.tool}
                scope={scope}
                docked={false}
                compact={band === "cards"}
                count={count}
                style={{ left: w.rect.x, top: w.rect.y, width: w.rect.w, height: w.rect.h, ["--ls-inv" as string]: 1 / cam.current.zoom }}
                onDock={() => dockWindow(w.id)}
                onClose={() => onCloseWindow(w.id)}
              >
                {inner}
              </ToolWindow>
            );
          })}
          {layout.cards.map((c) =>
            c.hidden ? null : (
              <div key={c.id} className="ls-acard" data-card={c.id} style={{ left: c.rect.x, top: c.rect.y, width: c.rect.w, height: c.rect.h, ["--ls-inv" as string]: 1 / cam.current.zoom }}>
                {cardFor(c)}
              </div>
            )
          )}
          <div ref={sizeBox} className="ls-sizebox" hidden aria-hidden="true">
            <span />
          </div>
          <div ref={guidesEl} className="ls-guides" aria-hidden="true" />
        </div>
        </LiftOut.Provider>
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
            onFocus={() => pairOn(peekTile.key) && enterFocus(peekTile)}
            onKeys={surface}
          />
        )}
        {emptyState.kind !== "drawn" && <LandscapeEmpty state={emptyState} onTile={runTile} onJoinRoom={onJoinRoom} treeHidden={treeHidden} onShowTree={onShowTree} />}
        {switcher && (
          <LiveSwitcher
            stops={stops}
            listeners={listeners.current}
            cam={cam}
            vp={vp}
            areas={[
              ...areaViews.map(({ a, accent, title }) => ({ key: a.key, name: shortAreaName(a.key, title), title, accent, waiting: needs?.get(a.key) ?? 0 })),
              ...(loose ? [{ key: LOOSE_GROUP, name: "Loose", title: "the workspaces in no area", accent: null, waiting: needs?.get(LOOSE_GROUP) ?? 0 }] : []),
            ]}
            onArea={(key) => {
              const a = stops.find((x) => x.key === key);
              if (a && vpNow.current.w) flyTo(areaCamera(a, vpNow.current, topNow.current));
            }}
            onShowTree={onShowTree}
          />
        )}
        {selectionBar()}
        {note && (
          <div key={note.n} ref={noteEl} className="ls-note" role="status">
            {note.text}
            {note.action && (
              <button
                type="button"
                className="ls-note-act"
                onClick={() => {
                  note.action!.run();
                  setNote(null);
                }}
              >
                {note.action.label}
              </button>
            )}
          </div>
        )}
        {!nothingDrawn(layout) && <CameraHud listeners={listeners.current} cam={cam} onFit={fit} onZoom={zoomTo} />}
        {ctx.menu}
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
            {...{ [HOLDS_KEYS]: "" }}
            onKeyDown={(e) => {
              if (!typed(e)) return;
              // on the frame itself, what's typed counts only while the user armed it (keyArm.ts)
              if (e.target === overlay.current && !isArmed(overlay.current)) {
                e.preventDefault();
                e.stopPropagation();
                tabbedOff(e);
                return;
              }
              if (e.key !== "Escape" || !escapeLeavesFullscreen(e.target as Element, !!document.querySelector(OVERLAYS))) return;
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
      {tourList && (
        <LandscapeTour
          steps={tourList}
          at={tourStep}
          listeners={listeners.current}
          worldBox={(t) => {
            const v = viewport.current?.getBoundingClientRect();
            const pill = t.kind === "area" ? world.current?.querySelector(`.ls-area-pill[data-area="${CSS.escape(t.key)}"]`)?.getBoundingClientRect() : null;
            const at = tourPlace(t);
            if (!v || !at) return null;
            const within = { x: v.left, y: v.top, w: v.width, h: v.height };
            return { box: pill ? { x: pill.left, y: pill.top, w: pill.width, h: pill.height } : { ...at.box, x: at.box.x + v.left, y: at.box.y + v.top }, within };
          }}
          onNext={() => (tourStep === tourList.length - 1 ? endTour() : setTourAt(tourStep + 1))}
          onSkip={endTour}
          onClosed={tourClosed}
          onKeysAsked={tourKeysAsked}
        />
      )}
    </div>
  );
}

/**
 * What's wrong with the layout, over the landscape: landscape.json's problems as the main process reports
 * them, a change it refused, and how reading the grid's layout in is going. Each can be put away for this
 * window; one that changes comes back.
 */
/** `onKeep`: the landscape kept as it's shown, the grid's layout given up on (Migrating.keep). */
export function LandscapeBanners({ problems, error, onReload, migration, onKeep }: { problems: LandscapeProblem[]; error: string | null; onReload: () => void; migration: Migrating; onKeep: () => void }) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const step = migration.step;
  const wires = useWires();
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
    // the wire book: none of it usable (refused), or what of it couldn't be read; its read failing outright, the one
    // line there is without a book, and asked for again
    ...wireBanners(wires).map((text) => ({
      key: `wires:${text}`,
      tone: "bad" as const,
      title: "Wires",
      text,
      actions: wires.state ? undefined : [{ label: "Read it again", run: rereadWires }],
    })),
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
    ...(migration.partial ? [{ key: `partial:${migration.partial}`, tone: "info" as const, title: "Part of your grid's layout wasn't read in", text: migration.partial }] : []),
    ...(migration.failed
      ? [{
          key: `migration:${migration.failed}`,
          tone: "bad" as const,
          title: "Your grid's layout wasn't read in",
          text: `${migration.failed}. Workspaces are placed where there's room meanwhile, and nothing moved, resized or arranged is saved until it's read in, or until you keep them where they are: the grid's layout is then never read in.`,
          actions: [
            { label: "Try again", run: migration.retry },
            { label: "Keep them where they are", run: onKeep },
          ],
        }]
      : []),
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
/** How far the minimap sits in from the view's right and bottom edges (styles.css .ls-minimap). */
const MINIMAP_INSET = 12;

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
