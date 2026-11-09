import type { Camera, LandscapeProblem, Rect, Size } from "../shared/landscape";
import { areaShown, fitBelow, type ResolvedLayout } from "./landscapeModel";

/**
 * First run on the landscape (docs/landscape.md, First run and empty landscape), the rules apart from the drawing:
 * what the empty landscape's place says, when the migration tour is due, its steps, and where its card goes.
 */

/** What landscape.json's problems are called, on the banners and in the empty landscape's place. */
export const PROBLEM_TITLE: Record<LandscapeProblem["kind"], string> = {
  corrupt: "The layout was reset",
  unreadable: "The layout file can't be read",
  newer: "A newer Mockingbird's layout",
  save: "The layout isn't saved",
  dropped: "Layout changes were dropped",
};

type Drawn = Pick<ResolvedLayout, "areas" | "tiles" | "ghosts" | "windows" | "cards">;

/** Nothing is drawn on the landscape. A docked tool window isn't on it: it's in the column beside it. */
export const nothingDrawn = (l: Drawn): boolean => !l.areas.length && !l.tiles.length && !l.ghosts.length && !l.windows.length && !l.cards.length;

/** Nothing the tour's first step could be about: no group that became an area, no session that became a workspace. */
export const nothingToTour = (l: Pick<ResolvedLayout, "areas" | "tiles" | "ghosts">): boolean => !l.areas.length && !l.tiles.length && !l.ghosts.length;

/**
 * What goes where the landscape would be empty:
 * - `drawn`: something is on it, nothing to say;
 * - `empty`: really nothing, with `closed` sessions listed in the side bar, and `reset` when a corrupt file was moved
 *   aside for it (its banner says where), which the words mustn't pass off as an empty start;
 * - `broken`: it can't be told, because something couldn't be read: never said to be empty;
 * - `reading`: it can't be told yet.
 */
export type EmptyState =
  | { kind: "drawn" }
  | { kind: "empty"; closed: number; reset: boolean }
  | { kind: "broken"; title: string; why: string; retry?: () => void }
  | { kind: "reading"; why: string };

/** A session list's read: whether it's been read, why its last read failed, and asking again. */
export interface ListRead {
  read: boolean;
  error: string | null;
  retry: () => void;
}

export function emptyStateOf(o: {
  layout: Drawn;
  /** landscape.json's problems. */
  problems: readonly LandscapeProblem[];
  /** The problem that means what's held only stands in for the file (readProblem). */
  standIn: LandscapeProblem | undefined;
  /** Why the layout couldn't be read, or a change to it couldn't be made. */
  storeError: string | null;
  /** Why the grid's layout couldn't be read in. */
  migrationFailed: string | null;
  lists: { live: ListRead; closed: ListRead; remote: ListRead };
  /** Closed sessions with no ghost on the landscape: the side bar's Closed list. */
  closed: number;
}): EmptyState {
  if (!nothingDrawn(o.layout)) return { kind: "drawn" };
  if (o.standIn) return { kind: "broken", title: PROBLEM_TITLE[o.standIn.kind], why: "What's on the landscape isn't known until it can be read: the note above says why." };
  if (o.storeError) return { kind: "broken", title: "The layout has a problem", why: o.storeError };
  if (o.migrationFailed) return { kind: "broken", title: "Your grid's layout wasn't read in", why: o.migrationFailed };
  const lists: [ListRead, string][] = [
    [o.lists.live, "your sessions"],
    [o.lists.closed, "your closed sessions"],
    [o.lists.remote, "teammates' sessions"],
  ];
  const failed = lists.find(([l]) => !l.read && l.error);
  if (failed) return { kind: "broken", title: `Couldn't read ${failed[1]}`, why: failed[0].error!, retry: failed[0].retry };
  const waiting = lists.filter(([l]) => !l.read).map(([, what]) => what);
  if (waiting.length) return { kind: "reading", why: `Reading ${waiting.join(", ")}…` };
  return { kind: "empty", closed: o.closed, reset: o.problems.some((p) => p.kind === "corrupt") };
}

// ---- the empty landscape's tiles ---------------------------------------------------------------

/** A tile of the empty landscape: its words, and the create menu's row it runs (createActions), so it's that row's flow. */
export interface EmptyTile {
  row: string;
  title: string;
  sub: string;
}

/** The tiles, in order, one entry each: a tile joins when its flow is a row of the create menu that isn't "coming". */
export const EMPTY_TILES: readonly EmptyTile[] = [
  { row: "new:ticket", title: "Start from a ticket", sub: "From your ADO board" },
  { row: "new:claude", title: "New workspace", sub: "Claude, Codex, terminal" },
  { row: "new:import", title: "Import a conversation", sub: "From anywhere on this Mac" },
];

// ---- the tour ----------------------------------------------------------------------------------

/** What a step spotlights: an area, a loose workspace or ghost (by its rectangle), or something in the window's chrome. */
export type TourTarget = { kind: "area"; key: string } | { kind: "place"; rect: Rect } | { kind: "chrome"; selector: string };

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** What it's called in the "Next:" line of the steps before it. */
  next: string;
  target: TourTarget;
}

/**
 * The steps after the first, in order, one entry each. They spotlight chrome that's always there, so none depends on
 * what's on the landscape. Each says only what this build does: its keys are the ones the sheet lists.
 */
export const TOUR_LATER: readonly TourStep[] = [
  {
    id: "zoom",
    title: "Zoom out to see it all, focus to work",
    body: "⌘-scroll or pinch zooms, ⌘0 fits everything and ⌘1 is 100%. Zoomed out, workspaces are cards: rest the pointer on one to peek. Enter or ⌘E fills the window with the selected workspace, and ⌘E takes you back.",
    next: "zooming and focus",
    target: { kind: "chrome", selector: ".ls-hud" },
  },
  {
    id: "tools",
    title: "Your sidebar's tools are windows now",
    body: "Files, Changes, Search and Run & debug open as windows on the landscape, beside the workspace they work on. Their buttons are on this rail, and in a workspace's ⋯ menu and its selection bar.",
    next: "tool windows",
    target: { kind: "chrome", selector: ".activitybar .ab-btn" },
  },
  {
    id: "needs",
    title: "What needs you is in one place",
    body: "Needs you lists permission prompts, questions, join requests and sessions that finished, and turns amber while anything does. N goes to the next, ⇧N back. ? shows every shortcut.",
    next: "what needs you",
    target: { kind: "chrome", selector: ".ny-btn" },
  },
];

/** The card's "Next:" line after step `i`; null on the last. */
export const tourNext = (steps: readonly TourStep[], i: number): string | null =>
  i + 1 < steps.length
    ? `Next: ${steps
        .slice(i + 1)
        .map((s) => s.next)
        .join(" · ")}`
    : null;

/**
 * The area the first step spotlights: an open one in preference to a pill, wholly on screen in preference to one that
 * would move the camera, then the one with the most in it. Null when no area is drawn.
 */
export function tourAreaOf(l: Pick<ResolvedLayout, "areas" | "tiles" | "ghosts">, cam: Camera, view: Size): string | null {
  const v = { x: cam.x, y: cam.y, w: view.w / cam.zoom, h: view.h / cam.zoom };
  const seen = (r: Rect) => r.x >= v.x && r.y >= v.y && r.x + r.w <= v.x + v.w && r.y + r.h <= v.y + v.h;
  const inIt = (key: string) => [...l.tiles, ...l.ghosts].filter((t) => t.area === key).length;
  const rank = (a: (typeof l.areas)[number]) => [a.rect.collapsed ? 0 : 1, seen(areaShown(a)) ? 1 : 0, inIt(a.key)];
  let best: (typeof l.areas)[number] | null = null;
  for (const a of l.areas) {
    if (!best) best = a;
    else {
      const [x, y] = [rank(a), rank(best)];
      if (x[0] > y[0] || (x[0] === y[0] && (x[1] > y[1] || (x[1] === y[1] && x[2] > y[2])))) best = a;
    }
  }
  return best?.key ?? null;
}

/**
 * The tour on this landscape: its first step, about an area (`areaKey`) or, with none drawn, the first loose workspace
 * or ghost, then TOUR_LATER. Null when there's neither (nothingToTour).
 */
export function tourSteps(l: Pick<ResolvedLayout, "tiles" | "ghosts">, areaKey: string | null): TourStep[] | null {
  const loose = l.tiles.find((t) => !t.hidden) ?? l.ghosts.find((t) => !t.hidden);
  if (!areaKey && !loose) return null;
  const first: TourStep = areaKey
    ? {
        id: "areas",
        title: "Your groups are now areas",
        body: "Each group you had is an area, with its sessions laid out the way its grid had them. Drag a workspace into another area to change its group.",
        next: "areas",
        target: { kind: "area", key: areaKey },
      }
    : {
        id: "areas",
        title: "Your sessions are now workspaces",
        body: "Each session is a workspace on the landscape, where the grid had it. Drag a box around a few and press M to make an area of them, as a group was.",
        next: "workspaces",
        target: { kind: "place", rect: loose!.rect },
      };
  return [first, ...TOUR_LATER];
}

/** A box in the window, in px. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How small, in screen px, an area or a workspace can be and still be spotlighted where it is. */
export const TOUR_MIN_W = 160;

/**
 * The camera that brings a step's target (`box` in the view's px) into view, or null when it's wholly in view (under a
 * strip `top` px tall, the area switcher's) and big enough to read: the tour moves nothing it doesn't have to.
 */
export function tourCamera(rect: Rect, box: Box, view: Size, top: number): Camera | null {
  const whole = box.x >= 0 && box.y >= top && box.x + box.w <= view.w && box.y + box.h <= view.h;
  return whole && box.w >= TOUR_MIN_W ? null : fitBelow([rect], view, top);
}

/** How much more room to the left or above it takes for the card not to go to a target's right. */
const RIGHT_BIAS = 1.5;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, Math.max(lo, hi)));

/**
 * Where the tour's card goes, `card` big, for a target at `box` in a window `view` big: beside the target on whichever
 * side has the most room for it, clear of the top bar (`minTop`) and inside the window. A target too big to go beside
 * (an area filling the view) has it over its lower right corner, so most of the target still shows.
 */
export function tourCardAt(box: Box | null, card: Size, view: Size, minTop: number, gap = 16, margin = 8): { x: number; y: number } {
  const x = (n: number) => clamp(n, margin, view.w - card.w - margin);
  const y = (n: number) => clamp(n, minTop, view.h - card.h - margin);
  if (!box) return { x: x((view.w - card.w) / 2), y: y((view.h - card.h) / 2) };
  const room = {
    right: view.w - margin - (box.x + box.w + gap),
    left: box.x - gap - margin,
    below: view.h - margin - (box.y + box.h + gap),
    above: box.y - gap - minTop,
  };
  const sides: { fits: number; at: { x: number; y: number } }[] = [
    // to its right by preference, as the design has it, when that's about as good
    { fits: room.right < card.w ? 0 : (RIGHT_BIAS * room.right) / card.w, at: { x: box.x + box.w + gap, y: y(box.y + box.h - card.h) } },
    { fits: room.below / card.h, at: { x: x(box.x + box.w / 2 - card.w / 2), y: box.y + box.h + gap } },
    { fits: room.left / card.w, at: { x: box.x - gap - card.w, y: y(box.y + box.h - card.h) } },
    { fits: room.above / card.h, at: { x: x(box.x + box.w / 2 - card.w / 2), y: box.y - gap - card.h } },
  ];
  const best = sides.filter((s) => s.fits >= 1).sort((a, b) => b.fits - a.fits)[0];
  if (best) return best.at;
  // inside the box's part of the window, lower right
  const right = Math.min(box.x + box.w, view.w - margin);
  const bottom = Math.min(box.y + box.h, view.h - margin);
  return { x: x(right - card.w - gap), y: y(bottom - card.h - gap) };
}

/** `box` grown by `pad` and kept inside `within` (the ring around a target, never past the view it's in). */
export function ringAround(box: Box, pad: number, within: Box): Box | null {
  const left = Math.max(box.x - pad, within.x);
  const top = Math.max(box.y - pad, within.y);
  const right = Math.min(box.x + box.w + pad, within.x + within.w);
  const bottom = Math.min(box.y + box.h + pad, within.y + within.h);
  return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null;
}
