/**
 * The landscape's view as pure functions (docs/landscape.md, phase 1 S2): the
 * camera, where each session's workspace sits, the nearest workspace in a
 * direction, how a window keeps its copy of the landscape in step with the
 * main process, and whether the grid's layout should be read in now.
 *
 * Shared so main plans the app Assistant's layout changes with the planners the
 * window's gestures use (docs/assistant.md → Plumbing), and refuses what they
 * refuse. The window imports it through renderer/landscapeModel.ts.
 */
import { isWorkItemId, splitGroupKey, type SessionInfo } from "./types";
import { areaShelf } from "./areaArtifacts";
import { isRemotePaneId } from "./team/livePanes";
import type { Wire } from "./wires";
import {
  AREA_GAP,
  AREA_HEADER,
  AREA_PAD,
  CELL_ESTIMATE,
  colsRows,
  sizeFor,
  GAP,
  WORKSPACE_SIZES,
  LOOSE_GROUP,
  applyPatch,
  areaAround,
  areaKeyOf,
  boundsOf,
  clearOf,
  fitAreaTo,
  fitView,
  MAX_COORD,
  kindOf,
  overlaps,
  emptyPatch,
  finishPatch as finish,
  holdingArea,
  keptIn,
  looseOf,
  NONE_LEAVING,
  own,
  placeAt,
  placeNew,
  presetSize,
  SIZE_PRESETS,
  type SizePreset,
  pushAll,
  pushAside,
  put,
  shiftKept,
  shifted,
  snap,
  snapUp,
  stackKeyOf,
  within,
  PATCH_RECORDS,
  isWorkspaceTool,
  AREA_KEY,
  LOOSE_KEY,
  apartOf,
  pushRects,
  type Area,
  type AreaRepo,
  type FullPatch,
  type Kept,
  type Pushed,
  type ArtifactCard,
  type ToolKind,
  type ToolWindow,
  type Camera,
  type Cell,
  type Landscape,
  type LandscapeChange,
  type LandscapePatch,
  type LandscapeProblem,
  type LandscapeState,
  type Rect,
  type Size,
  type WorkspaceKind,
} from "./landscape";

// ---- the camera ----------------------------------------------------------------------------

/** How far out and in the camera goes: a whole busy landscape on a laptop screen, and a terminal twice its size. */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 2;

export interface Point {
  x: number;
  y: number;
}

export const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** The landscape point under viewport point `p`. */
export const toLandscape = (cam: Camera, p: Point): Point => ({ x: cam.x + p.x / cam.zoom, y: cam.y + p.y / cam.zoom });

/** The camera at `zoom` (clamped) about viewport point `p`: the landscape point under it stays under it. */
export function zoomAbout(cam: Camera, p: Point, zoom: number): Camera {
  const z = clampZoom(zoom);
  const at = toLandscape(cam, p);
  return { x: at.x - p.x / z, y: at.y - p.y / z, zoom: z };
}

/** The camera after the landscape is dragged `dx`, `dy` screen pixels: what's under the pointer moves with it. */
export const panBy = (cam: Camera, dx: number, dy: number): Camera => ({ x: cam.x - dx / cam.zoom, y: cam.y - dy / cam.zoom, zoom: cam.zoom });

/** A wheel event's distance in pixels, whatever unit it came in (lines from a mouse wheel, pages rarely). */
export const wheelPixels = (delta: number, deltaMode: number, pageSize: number): number => (deltaMode === 1 ? delta * 16 : deltaMode === 2 ? delta * pageSize : delta);

/**
 * How much one zooming wheel event scales the view: a pinch (Electron's
 * ctrl-wheel, small deltas many times a second) and a ⌘-scroll (a mouse
 * wheel's notches) feel alike. One event never more than doubles or halves it.
 */
export function wheelZoomFactor(deltaPx: number, pinch: boolean): number {
  const k = pinch ? 0.01 : 0.0025;
  return Math.exp(Math.max(-Math.LN2, Math.min(Math.LN2, -deltaPx * k)));
}

/** Everything in view, centred: never past 100%, which is the size workspaces are for. */
export const fitAll = (rects: readonly Rect[], viewport: Size): Camera => fitView(rects, viewport, { maxZoom: 1, minZoom: ZOOM_MIN });

/** fitAll in the part of the view below a strip `top` px tall (the area switcher), which is left clear. */
export function fitBelow(rects: readonly Rect[], viewport: Size, top: number): Camera {
  const cam = fitAll(rects, { w: viewport.w, h: Math.max(1, viewport.h - top) });
  return { ...cam, y: cam.y - top / cam.zoom };
}

/** The camera at its zoom with `r` centred in the viewport. */
export const centreOn = (cam: Camera, r: Rect, viewport: Size): Camera => ({ x: r.x + r.w / 2 - viewport.w / (2 * cam.zoom), y: r.y + r.h / 2 - viewport.h / (2 * cam.zoom), zoom: cam.zoom });

/**
 * The camera at 100%, where a workspace's body is drawn and its typing ask can be answered: `r` centred, or, larger
 * than the view, shown from its top left, where its header and the ask's strip are.
 */
export function answerOn(r: Rect, viewport: Size, margin = 24): Camera {
  const c = centreOn({ x: 0, y: 0, zoom: 1 }, r, viewport);
  return {
    x: r.w + 2 * margin > viewport.w ? r.x - margin : c.x,
    y: r.h + 2 * margin > viewport.h ? r.y - margin : c.y,
    zoom: 1,
  };
}

/** Whether `r` is wholly in view. */
export function inView(cam: Camera, r: Rect, viewport: Size): boolean {
  const v = { x: cam.x, y: cam.y, w: viewport.w / cam.zoom, h: viewport.h / cam.zoom };
  return r.x >= v.x && r.y >= v.y && r.x + r.w <= v.x + v.w && r.y + r.h <= v.y + v.h;
}

/** A camera kept between launches, inside the landscape's bounds (MAX_COORD) and zoom limits; null when what was kept isn't one. */
export function cameraFrom(v: unknown): Camera | null {
  if (!v || typeof v !== "object") return null;
  const { x, y, zoom } = v as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  const bound = (n: number) => Math.min(MAX_COORD, Math.max(-MAX_COORD, n));
  return ok(x) && ok(y) && ok(zoom) && zoom > 0 ? { x: bound(x), y: bound(y), zoom: clampZoom(zoom) } : null;
}

/** The CSS transform that puts landscape point (x, y) at the viewport's top-left at `zoom`. */
export const worldTransform = (cam: Camera): string => `scale(${cam.zoom}) translate(${-cam.x}px, ${-cam.y}px)`;

// ---- semantic zoom -------------------------------------------------------------------------

/**
 * What workspaces are at a zoom (docs/landscape.md, semantic zoom): `live`, terminals the keyboard types into;
 * `readonly`, terminals still drawing live but taking no keys; `cards`, C's compact status cards, with no xterm.
 */
export type Band = "live" | "readonly" | "cards";
/** Live from this zoom up. */
export const BAND_LIVE = 0.75;
/** Read-only from this zoom up to BAND_LIVE; cards below it. */
export const BAND_CARDS = 0.35;
/**
 * A band is kept until the zoom is this share below its lower edge, while entering one takes its own edge: a pinch
 * resting on an edge can't flip it back and forth, and 75% and up is always live.
 */
export const BAND_SLACK = 0.04;
/** How long a new band waits for the zoom to stay in it: a pinch through a band and out of it again changes nothing. */
export const BAND_SETTLE_MS = 150;

const RANK: Record<Band, number> = { cards: 0, readonly: 1, live: 2 };
const FLOOR: Record<Band, number> = { cards: 0, readonly: BAND_CARDS, live: BAND_LIVE };

/** The band a zoom is in, its edges taken as they are. */
export const bandOf = (zoom: number): Band => (zoom >= BAND_LIVE ? "live" : zoom >= BAND_CARDS ? "readonly" : "cards");

/** The band at `zoom` coming from `cur`: zooming in, the band of the zoom; zooming out, `cur` until the zoom is past its edge by BAND_SLACK. */
export function nextBand(zoom: number, cur: Band | null): Band {
  const at = bandOf(zoom);
  if (!cur || RANK[at] >= RANK[cur]) return at;
  return zoom >= FLOOR[cur] * (1 - BAND_SLACK) ? cur : at;
}

/** Whether workspaces in this band have a terminal attached. */
export const attaches = (b: Band): boolean => b !== "cards";
/** Whether the keyboard reaches their terminals. */
export const takesKeys = (b: Band): boolean => b === "live";

/** Workspaces this share of the viewport past its edges count as on screen: attached before they come into view. */
export const ON_SCREEN_MARGIN = 0.25;

/** Whether any of `r` is on screen, the viewport grown by `margin` of its size on every side. */
export function onScreen(cam: Camera, viewport: Size, r: Rect, margin = ON_SCREEN_MARGIN): boolean {
  const mx = (viewport.w * margin) / cam.zoom;
  const my = (viewport.h * margin) / cam.zoom;
  const x0 = cam.x - mx;
  const y0 = cam.y - my;
  const x1 = cam.x + viewport.w / cam.zoom + mx;
  const y1 = cam.y + viewport.h / cam.zoom + my;
  return r.x < x1 && r.x + r.w > x0 && r.y < y1 && r.y + r.h > y0;
}

/** The keys of the workspaces on screen (onScreen), in layout order; a collapsed area's (`hidden`) never are. */
export const keysOnScreen = (tiles: readonly { key: string; rect: Rect; hidden?: boolean }[], cam: Camera, viewport: Size, margin = ON_SCREEN_MARGIN): string[] =>
  tiles.filter((t) => !t.hidden && onScreen(cam, viewport, t.rect, margin)).map((t) => t.key);

/** The least a workspace takes on screen, in px, to carry its edge handle (18 × 22): on a smaller card a press there moves it. */
export const HANDLE_ROOM: Size = { w: 96, h: 64 };

/** How long the pointer rests on a card or a read-only workspace before its peek opens. */
export const PEEK_HOVER_MS = 600;
/** The share of the viewport a peek may take, and how far it keeps from the viewport's edges. */
export const PEEK_SHARE = { w: 0.8, h: 0.86 };
export const PEEK_EDGE = 16;

/**
 * Where a workspace's peek goes, in viewport px: the workspace at its size at 100%, made smaller to fit
 * PEEK_SHARE of the viewport (never larger), centred on where the workspace is on screen and kept inside the
 * viewport. A peek scales the terminal; it never resizes it.
 */
export function peekBox(cam: Camera, viewport: Size, r: Rect): Rect {
  const k = Math.min(1, (viewport.w * PEEK_SHARE.w) / r.w, (viewport.h * PEEK_SHARE.h) / r.h);
  const w = Math.round(r.w * k);
  const h = Math.round(r.h * k);
  const cx = (r.x + r.w / 2 - cam.x) * cam.zoom;
  const cy = (r.y + r.h / 2 - cam.y) * cam.zoom;
  const clamp = (v: number, size: number, room: number) => Math.round(Math.min(Math.max(v, PEEK_EDGE), Math.max(PEEK_EDGE, room - size - PEEK_EDGE)));
  return { x: clamp(cx - w / 2, w, viewport.w), y: clamp(cy - h / 2, h, viewport.h), w, h };
}

// ---- moving between workspaces -------------------------------------------------------------

export type Direction = "left" | "right" | "up" | "down";

/** Going sideways costs this much more than going the way asked. */
const SIDEWAYS = 2;

/**
 * The workspace to move to from `from` going `dir`: of those whose centre
 * lies that way, the nearest, going sideways counting double. Null when
 * nothing lies that way.
 */
export function nearestInDirection(from: Rect, others: readonly { key: string; rect: Rect }[], dir: Direction): string | null {
  const cx = (r: Rect) => r.x + r.w / 2;
  const cy = (r: Rect) => r.y + r.h / 2;
  let best: { key: string; score: number } | null = null;
  for (const o of others) {
    const dx = cx(o.rect) - cx(from);
    const dy = cy(o.rect) - cy(from);
    const along = dir === "right" ? dx : dir === "left" ? -dx : dir === "down" ? dy : -dy;
    const side = Math.abs(dir === "left" || dir === "right" ? dy : dx);
    if (along <= 0.5) continue;
    const score = along + SIDEWAYS * side;
    if (!best || score < best.score) best = { key: o.key, score };
  }
  return best?.key ?? null;
}

// ---- where each session's workspace sits ------------------------------------------------------

/** One workspace on the landscape: a session, or a sub-group's sessions as a stack with a tab each. */
export interface Tile {
  /** The session's id, or "ws:<top/sub>" for a stack. */
  key: string;
  /** Its area's key (its sessions' top-level group), or LOOSE_GROUP. */
  area: string;
  /** "top/sub" for a stack. */
  stack: string | null;
  members: SessionInfo[];
  /** The member whose terminal shows: a stack's active one while it's still a member, else its first. */
  front: SessionInfo;
  rect: Rect;
  /** Its area is collapsed to a pill: it isn't drawn, and counts as off screen. */
  hidden: boolean;
  /** A stack's tabs whose sessions are closed but can be reopened: drawn as faded tabs after the others. */
  closed?: SessionInfo[];
}

/**
 * A ghost (docs/landscape.md, Ghost cards): a closed workspace of this Mac's that can still be reopened (main keeps its
 * session resumable), drawn faded where it was. Shaped as a Tile, kept apart from the layout's `tiles` so nothing that
 * works on running workspaces (selection, focus, peek, counts) takes one for one. Its place is the one landscape.json
 * keeps for its session (`workspaces`, or its stack's in `stacks`), so Reopen, which relaunches the session under its
 * id, lands it there. `members` are its closed sessions (several for a stack none of whose tabs runs).
 */
export type GhostView = Tile;

export interface AreaView {
  key: string;
  rect: Area;
}

/** How long a reveal waits for its session's workspace: a session just made reaches the layout a moment after it's picked. */
export const REVEAL_WAIT_MS = 5000;

/** A session picked to be brought into view, waiting until `until` for its workspace. */
export interface PendingReveal {
  id: string;
  until: number;
}

/** A pending reveal against the layout now: the workspace holding its session, "wait" while there's none yet, "expired" once there's been none for too long. */
export function revealTile(p: PendingReveal, tiles: readonly Tile[], now: number): Tile | "wait" | "expired" {
  const t = tiles.find((x) => x.members.some((m) => m.id === p.id));
  return t ?? (now > p.until ? "expired" : "wait");
}

/**
 * What a reveal can bring into view: the workspaces, and the cards of steps not started yet (ghosts), which the area
 * tree and ⌘K show. A step's card is only brought into view: nothing focuses or starts it from there.
 */
export function revealables(layout: Pick<ResolvedLayout, "tiles" | "ghosts">): Tile[] {
  return [...layout.tiles, ...layout.ghosts.filter((g) => g.members.some((m) => !!m.planned))];
}

/** A box on screen, in window pixels: one the view keeps what it brings into view clear of (the open Needs you tray). */
export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
/**
 * Bring a session's workspace into view: `focus` fills the window with it, `keys` gives the landscape the keyboard once
 * it's there, `avoid` is a box to keep it clear of, `answer` brings it in at 100% (a teammate waits to type in it, and
 * its strip's buttons take a click only where its body is drawn). `n` tells one ask from the next.
 */
export interface RevealAsk {
  id: string;
  n: number;
  focus?: boolean;
  keys?: boolean;
  avoid?: ScreenBox | null;
  answer?: boolean;
  /** While a workspace is in focus, this one takes its place in focus (Needs you's N and Go there) rather than focus ending. */
  stay?: boolean;
}
/** Go to an area (fit it in view), clear of `avoid`. */
export interface GoToAsk {
  area: string;
  n: number;
  avoid?: ScreenBox | null;
}

/** The narrowest room beside a box that what's brought into view is fitted into; with less, the whole view is used. */
const CLEAR_MIN_PX = 200;

/**
 * The part of the viewport (`vp`, on screen) to bring something into view in, as a size from its top-left: left of
 * `avoid` when that covers part of it and leaves room enough there, else all of it.
 */
export function clearRoom(vp: { left: number; top: number; width: number; height: number }, avoid: ScreenBox | null | undefined): Size {
  const all = { w: vp.width, h: vp.height };
  if (!avoid || avoid.right <= vp.left || avoid.left >= vp.left + vp.width || avoid.bottom <= vp.top || avoid.top >= vp.top + vp.height) return all;
  const w = avoid.left - vp.left;
  return w >= CLEAR_MIN_PX ? { w, h: vp.height } : all;
}

/** A tool window placed on the landscape: its area (null: loose) and where it sits. */
export interface WindowView {
  id: string;
  win: ToolWindow;
  area: string | null;
  rect: Rect;
  /** Its area is collapsed: it isn't drawn. */
  hidden: boolean;
}

/** An artifact's card on the landscape. */
export interface CardView {
  id: string;
  card: ArtifactCard;
  rect: Rect;
  hidden: boolean;
}

export interface ResolvedLayout {
  tiles: Tile[];
  /** Closed workspaces that can be reopened, where they were (GhostView). */
  ghosts: GhostView[];
  areas: AreaView[];
  /** Placed tool windows; docked ones are in `docked`, in the order they were docked. */
  windows: WindowView[];
  docked: { id: string; win: ToolWindow }[];
  cards: CardView[];
  /** Places made here for workspaces that had none, and areas added or grown to hold them; null when there were none. */
  patch: LandscapePatch | null;
  /** The session placed where a right-click's New workspace was clicked (`hint`), until its place is saved. */
  hinted?: string | null;
}

/**
 * Where the next workspace made from a right-click on the landscape goes: the area clicked in (LOOSE_GROUP outside
 * every area) and the point, in landscape px. It's for the first of this Mac's sessions made since `since` that lands
 * in that area; one the dialog put in another area is placed as any new one is.
 */
export interface PlaceHint {
  area: string;
  at: Point;
  since: number;
  /** A closed session whose ghost the new one takes the place of (Start fresh): it goes exactly there, and the ghost isn't drawn. */
  replaces?: string;
  /** The session placed by this hint, once one has been (ResolvedLayout.hinted). */
  took?: string;
}

/** A tool window's size when it opens, in px at 100%: as tall as the workspace it opens beside, within these. */
export const TOOL_WIDTH: Record<ToolKind, number> = { files: 360, changes: 384, search: 400, run: 440, artifacts: 384, chat: 440 };
export const TOOL_HEIGHT = { min: 480, max: 960, plain: 640 };
/** An artifact card's size at 100% (design O). */
export const CARD_SIZE: Size = { w: 240, h: 128 };
/**
 * The least a tool window's head and an artifact card take on screen zoomed out to cards, in screen px: a workspace
 * card's name over its scope (or the artifact's kind). styles.css draws them at least this big (.ls-window.compact,
 * .ls-band-cards .ls-acard).
 */
export const COMPACT_MIN = { window: { w: 136, h: 50 }, card: { w: 136, h: 52 } } as const;
/** The room kept between two of them drawn one under the other zoomed out, in screen px. */
const COMPACT_GAP = 4;

/**
 * How far down each tool window and artifact card is drawn zoomed out to cards, at `zoom`, in landscape px: none,
 * unless at its compact size (`min`, screen px, from its top-left) it would cover one drawn before it in reading order,
 * when it's drawn just under that one. A card placed beside its window then reads under it, rather than over its
 * name. Only how they're drawn: their places don't change.
 */
export function compactShifts(items: readonly { id: string; rect: Rect; min: Size }[], zoom: number): Map<string, number> {
  return new Map([...compactPlaces(items, zoom)].map(([id, p]) => [id, p.dy]));
}

/** How far a tool window or artifact card is kept inside its area's edges zoomed out to cards, in screen px. */
const COMPACT_PAD = 4;
/** The least height worth giving one squeezed under another at its area's foot: its name's line, in screen px. */
const COMPACT_SQUEEZE = 28;

/** How far in from its place's edges a ghost is drawn zoomed out to cards, in screen px: as cards are (styles.css --ci). */
export const GHOST_INSET = 5;

/**
 * How tall a ghost's place is drawn zoomed out to cards, at `zoom`, in landscape px (it's then drawn GHOST_INSET in from
 * that): its place's height, less the strip at its foot that `avoid` covers (another area's name line, kept at screen
 * size, reaches up past that area's top into the area above), COMPACT_GAP clear of it. As with windows and cards
 * (compactPlaces), one left less than COMPACT_SQUEEZE is drawn over the name line rather than squeezed out of sight.
 */
export function ghostDrawnHeight(rect: Rect, zoom: number, avoid: readonly Rect[]): number {
  const inset = GHOST_INSET / zoom;
  const box = { x: rect.x + inset, y: rect.y + inset, w: rect.w - 2 * inset, h: rect.h - 2 * inset };
  let h = rect.h;
  for (const a of avoid) {
    if (!(a.x < box.x + box.w && a.x + a.w > box.x && a.y < box.y + box.h && a.y + a.h > box.y)) continue;
    const room = a.y - COMPACT_GAP / zoom - box.y;
    if (room >= COMPACT_SQUEEZE / zoom) h = Math.min(h, room + 2 * inset);
  }
  return h;
}

/** Where a tool window or an artifact card is drawn zoomed out to cards, against its place: moved by dx, dy, w × h big (landscape px). */
export interface CompactPlace {
  dx: number;
  dy: number;
  w: number;
  h: number;
}

/**
 * Where each tool window and artifact card is drawn zoomed out to cards, at `zoom` (compactShifts' rule, kept inside
 * areas). Each is drawn at least its compact size (`min`, screen px) from its top-left; one that would then cover one
 * drawn before it in reading order goes just under that one, so a card placed beside its window reads under it.
 *
 * One in an area (`bounds`, its rectangle) stays inside it, a few px in from its edges, and clear of `avoid` (what
 * other areas draw over it zoomed out: an area's name line, kept at screen size, reaches up past its top edge into the
 * area above it). It's shrunk to fit when its area is smaller than its compact size, moved in from an edge it would
 * cross, and, when there's no room under the one it would cover, put beside it, or squeezed into what's left under
 * it; when there's no room even for that, it stays where it is inside its area, over the other. Only how they're
 * drawn changes: their places don't.
 */
export function compactPlaces(items: readonly { id: string; rect: Rect; min: Size; bounds?: Rect | null }[], zoom: number, avoid: readonly Rect[] = []): Map<string, CompactPlace> {
  const out = new Map<string, CompactPlace>();
  const drawn: Rect[] = [];
  const gap = COMPACT_GAP / zoom;
  const pad = COMPACT_PAD / zoom;
  for (const it of [...items].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)) {
    const r: Rect = { x: it.rect.x, y: it.rect.y, w: Math.max(it.rect.w, it.min.w / zoom), h: Math.max(it.rect.h, it.min.h / zoom) };
    const b = it.bounds;
    if (!b) {
      // each move puts it below one it covered, so it ends below every one it would cover
      for (let hit = drawn.find((d) => overlaps(r, d)); hit; hit = drawn.find((d) => overlaps(r, d))) r.y = hit.y + hit.h + gap;
    } else {
      const inner = { x: b.x + pad, y: b.y + pad, w: Math.max(0, b.w - 2 * pad), h: Math.max(0, b.h - 2 * pad) };
      // what another area draws over this one's foot takes that part away, never leaving less than a squeezed card's
      // height: then it's drawn over that name line rather than not at all
      for (const a of avoid) {
        if (!(a.x < inner.x + inner.w && a.x + a.w > inner.x && a.y < inner.y + inner.h && a.y + a.h > inner.y)) continue;
        const left = a.y - gap - inner.y;
        if (left >= COMPACT_SQUEEZE / zoom) inner.h = Math.min(inner.h, left);
      }
      const right = inner.x + inner.w;
      const foot = inner.y + inner.h;
      const fit = (q: Rect): Rect => {
        const w = Math.min(q.w, inner.w);
        const h = Math.min(q.h, inner.h);
        return { w, h, x: Math.max(inner.x, Math.min(q.x, right - w)), y: Math.max(inner.y, Math.min(q.y, foot - h)) };
      };
      const free = (q: Rect) => !drawn.some((d) => overlaps(q, d));
      let at = fit(r);
      for (let tries = drawn.length + 1, hit = drawn.find((d) => overlaps(at, d)); hit && tries > 0; tries--, hit = drawn.find((d) => overlaps(at, d))) {
        const under = { ...at, y: hit.y + hit.h + gap };
        const beside = [
          { ...at, x: hit.x + hit.w + gap },
          { ...at, x: hit.x - gap - at.w },
        ].filter((q) => q.x >= inner.x - 1e-6 && q.x + q.w <= right + 1e-6 && free(q));
        if (under.y + under.h <= foot + 1e-6) at = under;
        else if (beside.length) at = beside[0];
        else if (foot - under.y >= COMPACT_SQUEEZE / zoom) at = { ...under, h: foot - under.y };
        else break;
      }
      r.x = at.x;
      r.y = at.y;
      r.w = at.w;
      r.h = at.h;
    }
    drawn.push({ ...r });
    out.set(it.id, { dx: r.x - it.rect.x, dy: r.y - it.rect.y, w: r.w, h: r.h });
  }
  return out;
}

/** The size a tool window opens at: `beside`'s height (a workspace's) within TOOL_HEIGHT, on the grid. */
export const toolSize = (tool: ToolKind, beside: Rect | null): Size => ({
  w: TOOL_WIDTH[tool],
  h: snapUp(beside ? Math.min(TOOL_HEIGHT.max, Math.max(TOOL_HEIGHT.min, beside.h)) : TOOL_HEIGHT.plain),
});

/** The places tool windows and artifact cards take: what new workspaces and moved ones keep clear of. */
const extraPlaces = (l: Landscape, except?: string): Rect[] => [
  ...Object.entries(l.tools).flatMap(([id, t]) => (id !== except && !t.docked && t.placement ? [t.placement] : [])),
  ...Object.entries(l.cards).flatMap(([id, c]) => (id !== except && c.placement ? [c.placement] : [])),
];

/**
 * A group this window renamed (`from` → `to`, either a top-level group or a sub-group) whose change hasn't reached
 * everything yet: until the landscape has re-keyed it and no session shown is under `from`, resolveLayout keeps its
 * area and stacks under whichever key the landscape holds them.
 */
export interface PendingRename {
  from: string;
  to: string;
}

/**
 * The area selected as a whole (`selected`), as the layout has its areas now (`areas`): the same key while it's there;
 * the key a pending rename moves it to once it's there under that (a rename, or a merge into another area); and none
 * once it's gone (removed, or renamed away with nothing pending), so nothing is selected that can't be seen.
 */
export function areaSelectionNow(selected: string | null, areas: readonly string[], renames: readonly PendingRename[]): string | null {
  if (selected === null || areas.includes(selected)) return selected;
  return renamedKeys(selected, renames).find((k) => areas.includes(k)) ?? null;
}

/** Whether a pending rename is over: the landscape holds nothing under `from` any more, and no session shown is in it. */
export function renameSettled(r: PendingRename, l: Landscape, sessions: readonly SessionInfo[]): boolean {
  const under = (k: string) => k === r.from || k.startsWith(`${r.from}/`);
  return !Object.keys(l.areas).some(under) && !Object.keys(l.stacks).some(under) && !sessions.some((s) => under(s.taskGroup ?? LOOSE_GROUP));
}

/**
 * The pending renames still on their way, with the sessions shown and the closed ones (ghosts): main sends the renamed
 * live list before the window rereads the closed one, and a rename let go meanwhile would leave a ghost in a group the
 * landscape no longer has.
 */
export function renamesLeft(renames: readonly PendingRename[], l: Landscape, shown: readonly SessionInfo[], closed: readonly SessionInfo[]): PendingRename[] {
  const all = [...shown, ...closed];
  return renames.filter((r) => !renameSettled(r, l, all));
}

/**
 * Group key `key` on the other side of the pending renames it's under, nearest first: the new key for one under `from`,
 * the old for one under `to`, and on through a chain of them (A→B, B→C: A, B and C all name one group while they're on
 * their way). A rename back (A→B, B→A) adds nothing new. One into its own sub-group (A/b→A) makes a longer key each time
 * round, so at most RENAMED_MAX are followed: this runs in a render, and must end.
 */
export function renamedKeys(key: string, renames: readonly PendingRename[]): string[] {
  const seen = new Set([key]);
  const out: string[] = [];
  const queue = [key];
  while (queue.length && out.length < RENAMED_MAX) {
    const k = queue.shift()!;
    for (const { from, to } of renames) {
      const other = k === to || k.startsWith(`${to}/`) ? from + k.slice(to.length) : k === from || k.startsWith(`${from}/`) ? to + k.slice(from.length) : null;
      if (other === null || seen.has(other)) continue;
      seen.add(other);
      out.push(other);
      queue.push(other);
    }
  }
  return out;
}

/** The most keys renamedKeys follows: far more than renames on their way at once ever chain. */
const RENAMED_MAX = 32;

const tileKind = (members: readonly SessionInfo[]): WorkspaceKind => (members.some((s) => kindOf(s) === "agent") ? "agent" : "terminal");


/** The repos an area's sessions work in, each once, in order: what an area made around them starts with. */
const reposOf = (members: readonly SessionInfo[]): AreaRepo[] => [...new Set(members.map((s) => s.repoPath).filter((p): p is string => !!p))].map((path) => ({ path, base: null }));

/**
 * Where every session's workspace sits: its stored placement (a stack's, for
 * a sub-group's sessions), and for one without, a spot from placeNew: in its
 * area, grown to hold it, or added beside the others when its group has none
 * yet; loose, just left of the first area. Everything stored stays taken,
 * ghosts and sessions waiting to be resumed included, so a session relaunched
 * under its id finds its place free. `sessions` are the ones shown, in order.
 *
 * A group with no area whose workspaces already have places (loose ones just
 * named a group) gets its area around them. Areas never overlap: one formed so
 * is moved clear of the others (clearOf), its workspaces with it, and one that
 * grows to hold a new workspace pushes what's in its way aside (pushAside):
 * other areas, theirs with them, every place stored inside them included, and
 * what's in no area, which stays in none. A locked area is pushed too, as a
 * whole: lock keeps what's inside it where it is. An area that grows never
 * moves; of two that grow into each other, the one right-clicked stays.
 *
 * `renames` are this window's renames still on their way (PendingRename).
 *
 * `closed` are this Mac's sessions that are closed but can be reopened (main's resumable ones): one whose place (or
 * its stack's) is kept is a ghost (GhostView) there; one with none isn't drawn, and nothing is placed for it (the
 * Closed sessions list holds it: closedListOf). A closed tab of a stack that's shown is one of its `closed` tabs
 * instead. A ghost never makes an area. It's in its group's area while it lies inside it, else in the area holding it,
 * else loose (where it sits decides, so one loose isn't carried off by its group's area forming). Ghosts move with their area and are
 * pushed aside like the places of sessions not shown (passive: one pushed goes on past what it reaches rather than
 * pushing it).
 *
 * A step not started yet (SessionInfo.planned, W8) is among `closed` and drawn as a ghost, but always has a place: one
 * with none kept (just made by Add next step) is placed as a new workspace is, in its group's area while that has one
 * (else loose; it makes no area either), where `hint` says when the hint is its, and that place is saved.
 */
export function resolveLayout(
  l: Landscape,
  sessions: readonly SessionInfo[],
  cell: Cell = CELL_ESTIMATE,
  renames: readonly PendingRename[] = [],
  hint: PlaceHint | null = null,
  closed: readonly SessionInfo[] = []
): ResolvedLayout {
  /**
   * A group key under a rename still on its way: the key the landscape holds it under, the old one or the new. The
   * session list and the landscape's re-keying (main's renameAreaPatch) arrive one after the other, and a teammate's
   * room sessions take the new name later still, so for a while the two disagree; formed anew, the group's area would
   * be pushed clear of its own old one, and that place saved over the re-keyed one.
   */
  const held = (key: string, has: (k: string) => boolean): string => (has(key) ? key : (renamedKeys(key, renames).find(has) ?? key));
  const groups = new Map<string, { area: string; stack: string | null; members: SessionInfo[]; ghost: boolean; closed: SessionInfo[] }>();
  const stackOf = (s: SessionInfo) => {
    const sk = stackKeyOf(s);
    return sk && held(sk, (k) => Object.hasOwn(l.stacks, k));
  };
  const areaOfSession = (s: SessionInfo) => held(areaKeyOf(s), (k) => Object.hasOwn(l.areas, k));
  for (const s of sessions) {
    const stack = stackOf(s);
    const key = stack ? `ws:${stack}` : s.id;
    const g = groups.get(key);
    if (g) g.members.push(s);
    else groups.set(key, { area: areaOfSession(s), stack, members: [s], ghost: false, closed: [] });
  }
  const shownIds = new Set(sessions.map((s) => s.id));
  // the closed sessions: a tab of a stack that's shown, else a ghost of its own (a stack's closed tabs together) where
  // its place is kept; one with no place kept isn't drawn (the Closed sessions list holds it: closedListOf)
  for (const s of closed) {
    if (shownIds.has(s.id)) continue;
    const stack = stackOf(s);
    const shownStack = stack ? groups.get(`ws:${stack}`) : undefined;
    if (shownStack && !shownStack.ghost) {
      shownStack.closed.push(s);
      continue;
    }
    if (!(stack && Object.hasOwn(l.stacks, stack)) && !own(l.workspaces, s.id) && !s.planned) continue;
    const key = stack ? `${GHOST_KEY}ws:${stack}` : `${GHOST_KEY}${s.id}`;
    const g = groups.get(key);
    if (g) g.members.push(s);
    else groups.set(key, { area: areaOfSession(s), stack, members: [s], ghost: true, closed: [] });
  }
  /**
   * The sessions and stacks drawn, running or as ghosts: a place stored for any other (a session hidden, or forgotten)
   * stays taken, and moves with its area.
   */
  const drawnIds = new Set([...groups.values()].flatMap((g) => [...g.members, ...g.closed].map((s) => s.id)));
  const drawnStacks = new Set([...groups.values()].map((g) => g.stack).filter((k): k is string => !!k));

  const areas = new Map<string, Area>(Object.entries(l.areas));
  const patch: FullPatch = emptyPatch();
  /** An area's change: the fields that changed for one stored, the whole of a new one. */
  const setArea = (key: string, a: Area, fields: Partial<Area>) => {
    areas.set(key, a);
    put(patch.areas, key, Object.hasOwn(l.areas, key) ? { ...(own(patch.areas, key) ?? {}), ...fields } : a);
  };

  // each workspace's stored place: its stack's, else where its first member sat on its own
  const stored = new Map<string, Rect | undefined>();
  const fronts = new Map<string, SessionInfo>();
  for (const [key, g] of groups) {
    const st = g.stack ? own(l.stacks, g.stack) : undefined;
    const front = (st && g.members.find((s) => s.id === st.active)) || g.members[0];
    fronts.set(key, front);
    stored.set(key, st?.placement ?? (g.stack ? g.members.map((s) => own(l.workspaces, s.id)).find(Boolean) : own(l.workspaces, front.id)));
  }
  /** Workspaces whose stored place moved with their area, to be saved where they are now. */
  const movedTiles = new Set<string>();
  const shiftTile = (key: string, dx: number, dy: number) => {
    const r = stored.get(key);
    if (!r || (!dx && !dy)) return;
    stored.set(key, shifted(r, dx, dy));
    movedTiles.add(key);
  };

  // areas form round running workspaces only: a ghost never makes one, and one whose group has no area is drawn loose
  const live = new Set([...groups.values()].filter((g) => !g.ghost).map((g) => g.area));
  for (const key of live) {
    if (key === LOOSE_GROUP || areas.has(key)) continue;
    const keys = [...groups].filter(([, g]) => g.area === key && !g.ghost).map(([k]) => k);
    const rects = keys.map((k) => stored.get(k)).filter((r): r is Rect => !!r);
    const around = areaAround(rects);
    if (!around) continue;
    const { dx, dy } = clearOf(around, [...areas.values()]);
    const a: Area = { ...shifted(around, dx, dy), repos: reposOf(keys.flatMap((k) => groups.get(k)!.members)) };
    setArea(key, a, a);
    for (const k of keys) shiftTile(k, dx, dy);
  }
  // a ghost is in its group's area while it lies inside it; otherwise in the area holding it, or loose
  for (const [key, g] of groups) {
    if (!g.ghost) continue;
    const r = stored.get(key);
    const mine = areas.get(g.area);
    if (mine && r && within(r, mine)) continue;
    // a not-started step with no place yet is placed in its group's area, as a new workspace is
    if (mine && !r && g.members.every((s) => s.planned)) continue;
    g.area = r ? holdingArea(areas, r) : LOOSE_GROUP;
  }

  // everything stored is taken (sessions waiting to be resumed, closed ones' ghosts), where it is now
  const movedIds = new Set<string>();
  const movedStacks = new Set<string>();
  for (const k of movedTiles) {
    const g = groups.get(k)!;
    if (g.stack) movedStacks.add(g.stack);
    for (const s of g.members) movedIds.add(s.id);
  }
  const occupied: Rect[] = [
    ...Object.entries(l.workspaces).filter(([id]) => !movedIds.has(id)).map(([, r]) => r),
    ...Object.entries(l.stacks).filter(([k]) => !movedStacks.has(k)).map(([, s]) => s.placement),
    ...Object.values(l.ghosts).map((g) => g.placement),
    ...[...movedTiles].map((k) => stored.get(k)!),
    ...extraPlaces(l),
  ];

  /** A new area for `key`, right of everything: a group made since the grid's layout was read in. */
  const addArea = (key: string): Area => {
    const all = boundsOf([...areas.values(), ...occupied]);
    const top = boundsOf([...areas.values()])?.y ?? 0;
    const m = presetSize("agent", "M", cell);
    const a: Area = { x: all ? all.x + all.w + AREA_GAP : 0, y: top, w: 2 * AREA_PAD + m.w, h: AREA_HEADER + AREA_PAD, repos: [] };
    setArea(key, a, a);
    return a;
  };
  const firstArea = (): Area | null => [...areas.values()].sort((a, b) => a.y - b.y || a.x - b.x)[0] ?? null;

  /** What's kept besides the workspaces and ghosts drawn, each with the area it's in before this pass moves any: what every move below goes by. */
  const kept = keptIn(l, areas, { ids: drawnIds, stacks: drawnStacks });
  const othersOf = (key: string) => [...areas].filter(([k]) => k !== key).map(([, r]) => r);
  const grew = new Set<string>();
  const growTo = (key: string, grown: Area) => {
    setArea(key, grown, { w: grown.w, h: grown.h });
    grew.add(key);
  };
  const tiles: Tile[] = [];
  const placed = new Set<string>();
  let hinted: string | null = null;
  /**
   * The closed session whose ghost a new one took the place of (PlaceHint.replaces): not drawn, from the pass that places
   * the new one until the hint is let go (main lets the ghost's place go first, so it isn't drawn over the new one after).
   */
  let replaced: string | null = hint?.replaces && hint.took && shownIds.has(hint.took) ? hint.replaces : null;
  for (const [key, g] of groups) {
    let rect = stored.get(key);
    if (!rect) {
      const size = presetSize(tileKind(g.members), "M", cell);
      // the first of this Mac's sessions made since a right-click's New workspace (or an Add next step's step), in the area
      // clicked, goes where it was clicked
      const here = !hinted && !!hint && (!g.ghost || g.members.every((s) => s.planned)) && g.area === hint.area && g.members.some((s) => !s.room?.remote && s.createdAt >= hint.since);
      if (here) hinted = fronts.get(key)!.id;
      const instead = here && hint!.replaces ? own(l.workspaces, hint!.replaces) : undefined;
      if (instead) {
        // Start fresh: in the place of the ghost it replaces, which isn't drawn
        rect = instead;
        replaced = hint!.replaces!;
      } else if (g.area === LOOSE_GROUP) {
        const loose = [...occupied, ...areas.values()];
        rect = here ? placeAt(size, hint!.at, loose, null, firstArea()) : placeNew(size, loose, null, firstArea());
      } else {
        const area = areas.get(g.area) ?? addArea(g.area);
        rect = here ? placeAt(size, hint!.at, occupied, area, null, othersOf(g.area)) : placeNew(size, occupied, area);
        const grown = fitAreaTo(area, [rect]);
        if (grown !== area) growTo(g.area, grown);
      }
      occupied.push(rect);
      stored.set(key, rect);
      placed.add(key);
    }
    tiles.push({ key, area: g.area, stack: g.stack, members: g.members, front: fronts.get(key)!, rect, hidden: false, ...(g.closed.length ? { closed: g.closed } : {}) });
  }
  const isGhost = (key: string) => groups.get(key)!.ghost;

  /** Area `k` moved by `dx`, `dy`, with everything in it: its workspaces, and what's kept in it (`kept`). */
  const moveAreaBy = (k: string, dx: number, dy: number) => {
    const a = shifted(areas.get(k)!, dx, dy);
    setArea(k, a, { x: a.x, y: a.y });
    for (const t of tiles) if (t.area === k) shiftTile(t.key, dx, dy);
    shiftKept(patch, kept, k, dx, dy, NONE_LEAVING);
  };
  // a tool window or an artifact card with no place (its area was merged into another by a rename) is placed in its
  // area as a new workspace is; one whose area isn't here any more is placed loose
  const placeExtra = (area: string | null, size: Size): Rect => {
    const a = area === null ? undefined : areas.get(area);
    if (!a) return placeNew(size, [...occupied, ...areas.values()], null, firstArea());
    const r = placeNew(size, occupied, a);
    const grown = fitAreaTo(a, [r]);
    if (grown !== a) growTo(area!, grown);
    return r;
  };
  for (const [id, t] of Object.entries(l.tools)) {
    if (t.docked || t.placement) continue;
    const r = placeExtra(t.area ?? null, toolSize(t.tool, null));
    occupied.push(r);
    put(patch.tools, id, { ...t, placement: r });
  }
  for (const [id, c] of Object.entries(l.cards)) {
    if (c.placement) continue;
    const r = placeExtra(c.area, CARD_SIZE);
    occupied.push(r);
    put(patch.cards, id, { ...c, placement: r });
  }

  // the areas that grew stay where they are, all together (the one right-clicked first), and what's in their way moves
  // aside: other areas, each with everything in it (a locked one as a whole), and what's in no area, which stays in none
  if (grew.size) {
    const loose: Pushed[] = [
      ...tiles.filter((t) => t.area === LOOSE_GROUP).map((t) => ({ rect: stored.get(t.key)!, passive: isGhost(t.key), move: (dx: number, dy: number) => shiftTile(t.key, dx, dy) })),
      ...looseOf(patch, kept, NONE_LEAVING),
    ];
    const still = [...grew].sort((a, b) => Number(b === hint?.area) - Number(a === hint?.area));
    pushAll(areas, loose, still, moveAreaBy);
  }

  for (const t of tiles) {
    const g = groups.get(t.key)!;
    t.rect = stored.get(t.key)!;
    t.hidden = areas.get(t.area)?.collapsed === true;
    const save = placed.has(t.key) || movedTiles.has(t.key);
    if (g.stack && (!own(l.stacks, g.stack) || movedTiles.has(t.key))) put(patch.stacks, g.stack, { active: t.front.id, placement: t.rect });
    else if (!g.stack && save) put(patch.workspaces, t.front.id, t.rect);
  }

  const windows: WindowView[] = [];
  const docked: { id: string; win: ToolWindow }[] = [];
  for (const [id, stored] of Object.entries(l.tools)) {
    const win = own(patch.tools, id) ?? stored;
    if (win.docked) docked.push({ id, win });
    else if (win.placement) {
      const area = win.area && areas.has(win.area) ? win.area : null;
      windows.push({ id, win, area, rect: win.placement, hidden: !!area && areas.get(area)?.collapsed === true });
    }
  }
  const cards: CardView[] = [];
  for (const [id, stored] of Object.entries(l.cards)) {
    const card = own(patch.cards, id) ?? stored;
    if (card.placement) cards.push({ id, card, rect: card.placement, hidden: areas.get(card.area)?.collapsed === true });
  }
  return {
    tiles: tiles.filter((t) => !isGhost(t.key)),
    ghosts: tiles.filter((t) => isGhost(t.key) && !(t.members.length === 1 && t.front.id === replaced)),
    areas: [...areas].map(([key, rect]) => ({ key, rect })),
    windows,
    docked,
    cards,
    patch: finish(patch),
    hinted,
  };
}

/** The prefix of a ghost's key (GhostView), apart from the keys of running workspaces (a session's id, "ws:<top/sub>"). */
export const GHOST_KEY = "ghost:";


/** How big a collapsed area's pill counts for fitting the view and the minimap, in landscape px at 100%. */
export const PILL_SIZE: Size = { w: 320, h: 48 };

/** What an area takes on the landscape as drawn: its rectangle, or its pill while it's collapsed. */
export const areaShown = (a: AreaView): Rect => (a.rect.collapsed ? { x: a.rect.x, y: a.rect.y, ...PILL_SIZE } : a.rect);

/** Everything a fit shows: the areas (a collapsed one's pill) and the workspaces and ghosts drawn. */
export const contentRects = (r: ResolvedLayout): Rect[] => [...r.areas.map(areaShown), ...[...r.tiles, ...r.ghosts].filter((t) => !t.hidden).map((t) => t.rect)];

/** What a fit goes by: contentRects or, when tool windows and artifact cards are all that's drawn, those, so they're brought into view too. */
export function fitRects(r: ResolvedLayout): Rect[] {
  const rects = contentRects(r);
  return rects.length ? rects : [...r.windows, ...r.cards].filter((x) => !x.hidden).map((x) => x.rect);
}

// ---- keeping a window's landscape in step -------------------------------------------------------

/**
 * A window's landscape once `change` (landscape:changed) arrives: the next
 * revision applied; one it already has (its own update answered first) kept,
 * with the problems as they are now. Null when a revision was missed, or the
 * patch can't be applied here: the window reads the landscape again.
 */
export function afterChange(cur: LandscapeState, change: LandscapeChange): LandscapeState | null {
  if (change.rev < cur.rev) return cur;
  if (change.landscape) return { landscape: change.landscape, rev: change.rev, problems: change.problems };
  if (change.rev === cur.rev) return { ...cur, problems: change.problems };
  if (change.rev !== cur.rev + 1 || !change.patch) return null;
  try {
    return { landscape: applyPatch(cur.landscape, change.patch), rev: change.rev, problems: change.problems };
  } catch (err) {
    console.error(`[mockingbird] couldn't apply landscape revision ${change.rev} here; reading the landscape again:`, err);
    return null;
  }
}

/**
 * A patch that sets only a flag (tourDone): it changes nothing anyone could undo, so an Undo offered for the change
 * before it still applies (LandscapeStore.revNow).
 */
export function flagOnly(p: LandscapePatch | null | undefined): boolean {
  if (!p || p.migratedAt !== undefined || p.tourDone === undefined) return false;
  return PATCH_RECORDS.every((k) => !p[k] || !Object.keys(p[k]!).length);
}

/** An update's answer, or a get's: taken unless it's older than what the window has. */
export const newer = (cur: LandscapeState | null, next: LandscapeState): LandscapeState => (!cur || next.rev >= cur.rev ? next : cur);

// ---- reading the grid's layout in ---------------------------------------------------------------

/**
 * Problems reading landscape.json that leave what's shown standing in for the
 * file: while one stands, nothing is migrated or placed into it. A corrupt
 * file that was moved aside isn't one: the layout really starts over, and is
 * saved; only one that couldn't be moved is left in place, read-only.
 */
const standsIn = (p: LandscapeProblem): boolean => p.kind === "unreadable" || p.kind === "newer" || (p.kind === "corrupt" && !p.movedTo);

/** The problem reading landscape.json, while there is one that blocks reading in and saving places. */
export const readProblem = (state: LandscapeState | null): LandscapeProblem | undefined => state?.problems.find(standsIn);

/** The session lists migration reads: this Mac's live sessions, the previous run's resumable ones, and teammates'. */
export interface ListsLoaded {
  live: boolean;
  resumable: boolean;
  remote: boolean;
}

export type MigrationStep =
  /** Read in already: migratedAt is set. */
  | { kind: "done" }
  /** Not yet: the landscape or a session list hasn't loaded. */
  | { kind: "wait"; why: string }
  /** Not while the file has a read problem: what's shown stands in for it. */
  | { kind: "blocked"; why: string; problem: LandscapeProblem }
  | { kind: "run" };

/**
 * Whether the grid's layout is read in now, the first time the landscape is
 * shown: once the landscape and every session list have loaded (a session
 * missing from them would lose its place), never into a landscape standing in
 * for a file that couldn't be read, and never again once migratedAt is set.
 */
export function migrationStep(state: LandscapeState | null, lists: ListsLoaded): MigrationStep {
  if (!state) return { kind: "wait", why: "the layout is loading" };
  if (state.landscape.migratedAt) return { kind: "done" };
  const problem = readProblem(state);
  if (problem) return { kind: "blocked", why: problem.message, problem };
  const missing = [!lists.live && "your sessions", !lists.resumable && "the previous run's sessions", !lists.remote && "teammates' sessions"].filter((x): x is string => !!x);
  if (missing.length) return { kind: "wait", why: `waiting for ${missing.join(", ")}` };
  return { kind: "run" };
}

/**
 * What a migration read in without, in words: prefs it couldn't read (`unreadable`, by key) and prefs not in the grid's
 * shape (`ignored`, each with why). Null when it read everything that was there. Sessions don't depend on them: every
 * one still gets a place, in its group's area.
 */
export function partialMigration(unreadable: readonly string[], ignored: readonly string[]): string | null {
  const parts = [...unreadable.map((key) => `${key} couldn't be read`), ...ignored];
  return parts.length ? `${parts.join("; ")}. Every session is on the landscape, in its group's area: what those prefs would have placed is where there was room.` : null;
}

/**
 * Whether a patch only brings stacks' tabs to the front (a stack's `active`, with the place it's shown at) or opens,
 * collapses, locks or unlocks areas: nothing that moves a workspace, and what reading the grid's layout in gives anew
 * (every stack it makes is given whole), so it's saved while that read-in has failed.
 */
export function viewOnlyPatch(p: LandscapePatch): boolean {
  const only = (rec: Record<string, unknown> | undefined, fields: readonly string[]) =>
    !!rec && Object.values(rec).every((v) => !!v && typeof v === "object" && Object.keys(v).every((f) => fields.includes(f)));
  const parts = Object.entries(p).filter(([, v]) => v !== undefined);
  return parts.length > 0 && parts.every(([k]) => (k === "stacks" ? only(p.stacks, ["active", "placement"]) : k === "areas" ? only(p.areas, ["collapsed", "locked"]) : false));
}

/** A migrated landscape as the patch that puts it in: placements, areas, stacks and migratedAt; whatever else is there stays. */
export function migrationPatch(m: Landscape): LandscapePatch {
  return { workspaces: m.workspaces, areas: m.areas, stacks: m.stacks, migratedAt: m.migratedAt ?? new Date().toISOString() };
}

// ---- areas (S4) -------------------------------------------------------------------------------

/** How many accent colours areas take turns with: AreaFrame draws accent n with `--ls-a<n>`. */
export const ACCENTS = 6;

/** An area's accent colour: the same for the same key in every window and launch (a rename may change it). */
export function accentOf(key: string): number {
  // FNV-1a: a stable spread over a handful of colours, not a secure hash
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) % ACCENTS;
}

/**
 * The areas' accents, all different while there are no more areas than ACCENTS: each key takes accentOf's unless a
 * key sorting before it has it, then the next one free. Sorted, so every window with the same areas agrees, and an
 * area's colour changes only when one sorting before it that wanted the same colour comes or goes.
 */
export function accentsOf(keys: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  for (const k of [...keys].sort()) {
    let c = accentOf(k);
    if (taken.size < ACCENTS) while (taken.has(c)) c = (c + 1) % ACCENTS;
    taken.add(c);
    out.set(k, c);
  }
  return out;
}

/** An area's name where there's little room (the switcher): a ticket's number, else its title. */
export const shortAreaName = (key: string, title: string): string => (isWorkItemId(key) ? `#${key}` : title);

/** What an area's sessions are doing. Statuses count this Mac's sessions only: a teammate's waiting one waits on them. */
export interface AreaCounts {
  working: number;
  waiting: number;
  idle: number;
  dead: number;
  /** Workspaces, a stack once, teammates' included. */
  workspaces: number;
  /** Closed sessions that can be reopened: its ghosts' and its stacks' closed tabs. */
  closed: number;
  /** Steps not started yet (SessionInfo.planned), drawn as ghosts are but never counted closed. */
  planned?: number;
}

export function areaCounts(tiles: readonly Tile[], key: string, ghosts: readonly GhostView[] = []): AreaCounts {
  const c: AreaCounts = { working: 0, waiting: 0, idle: 0, dead: 0, workspaces: 0, closed: 0 };
  const closedOne = (s: SessionInfo) => (s.planned ? (c.planned = (c.planned ?? 0) + 1) : c.closed++);
  for (const t of tiles) {
    if (t.area !== key) continue;
    c.workspaces++;
    for (const s of t.closed ?? []) closedOne(s);
    for (const s of t.members) if (!s.room?.remote) c[s.status]++;
  }
  for (const g of ghosts) if (g.area === key) for (const s of g.members) closedOne(s);
  return c;
}

/**
 * The closed sessions of area `key` (LOOSE_GROUP: in no area; null: every one) that the layout draws: its ghosts', then
 * its stacks' closed tabs. Not-started steps aren't closed (plannedIn): Reopen all and Clear ghosts never take one.
 */
export function closedIn(layout: Pick<ResolvedLayout, "tiles" | "ghosts">, key: string | null): SessionInfo[] {
  const here = (t: { area: string }) => key === null || t.area === key;
  return [...layout.ghosts.filter(here).flatMap((g) => g.members), ...layout.tiles.filter(here).flatMap((t) => t.closed ?? [])].filter((s) => !s.planned);
}

/** The steps not started yet that the layout draws in area `key` (LOOSE_GROUP: in no area; null: every one). */
export function plannedIn(layout: Pick<ResolvedLayout, "tiles" | "ghosts">, key: string | null): SessionInfo[] {
  const here = (t: { area: string }) => key === null || t.area === key;
  return [...layout.ghosts.filter(here).flatMap((g) => g.members), ...layout.tiles.filter(here).flatMap((t) => t.closed ?? [])].filter((s) => !!s.planned);
}

/**
 * The Closed sessions list: the closed sessions the layout doesn't draw (no place kept for them on the landscape), in
 * the order given; every one while there's no layout yet (the landscape is still being read in, or has no file), so
 * a closed session can always be reached.
 */
export function closedListOf(closed: readonly SessionInfo[], layout: Pick<ResolvedLayout, "tiles" | "ghosts"> | null): SessionInfo[] {
  if (!layout) return [...closed];
  const drawn = new Set(closedIn(layout, null).map((s) => s.id));
  return closed.filter((s) => !drawn.has(s.id));
}

/**
 * Landscape `l` without the places of sessions that are gone: a workspace whose session is neither among `known` (this
 * Mac's live and resumable sessions and teammates' room sessions) nor a teammate's, and a stack none of `known` is in.
 * Placing new workspaces and Tidy go by this, so those places take no room. Null `known` (the lists haven't all been
 * read yet, and a session missing from one may only not be read yet) keeps every place. Nothing is removed from the file.
 *
 * A stack is known by its key on either side of a rename still on its way (`renames`): the sessions and the
 * landscape's re-keying arrive one after the other, and a stack passed over meanwhile would be placed anew and saved.
 */
export function withoutGone(l: Landscape, known: readonly SessionInfo[] | null, renames: readonly PendingRename[] = []): Landscape {
  if (!known) return l;
  const ids = new Set(known.map((s) => s.id));
  const stacks = new Set(known.map(stackKeyOf).filter((k): k is string => !!k));
  const goneIds = Object.keys(l.workspaces).filter((id) => !ids.has(id) && !isRemotePaneId(id));
  const goneStacks = Object.keys(l.stacks).filter((k) => !stacks.has(k) && !renamedKeys(k, renames).some((o) => stacks.has(o)));
  if (!goneIds.length && !goneStacks.length) return l;
  const workspaces = { ...l.workspaces };
  for (const id of goneIds) delete workspaces[id];
  const kept = { ...l.stacks };
  for (const k of goneStacks) delete kept[k];
  return { ...l, workspaces, stacks: kept };
}

/**
 * An area's summary line: "Shared room with Nick · 1 waiting · 2 working · 5 workspaces". `shared` leads it for a
 * room's area; `workspaces: false` leaves the count out (the header bar, whose workspaces are under it).
 */
export function areaSummary(c: AreaCounts, o: { shared?: string | null; workspaces?: boolean } = {}): string {
  const parts = [o.shared ?? null, c.waiting ? `${c.waiting} waiting` : null, c.working ? `${c.working} working` : null, c.dead ? `${c.dead} exited` : null];
  if (o.workspaces !== false) parts.push(`${c.workspaces} workspace${c.workspaces === 1 ? "" : "s"}`);
  if (c.closed) parts.push(`${c.closed} closed`);
  if (c.planned) parts.push(`${c.planned} not started`);
  return parts.filter(Boolean).join(" · ");
}

/** The area at landscape point `p`: a drop's target. A collapsed area is a pill, which takes nothing. */
export const areaAt = (areas: readonly AreaView[], p: Point): AreaView | null =>
  areas.find((a) => !a.rect.collapsed && p.x >= a.rect.x && p.x <= a.rect.x + a.rect.w && p.y >= a.rect.y && p.y <= a.rect.y + a.rect.h) ?? null;

/** The area most of the view shows, or null when it shows none: the switcher's current one. */
export function areaInView(areas: readonly AreaView[], cam: Camera, viewport: Size): string | null {
  const v = { x: cam.x, y: cam.y, w: viewport.w / cam.zoom, h: viewport.h / cam.zoom };
  let best: { key: string; seen: number } | null = null;
  for (const a of areas) {
    const r = areaShown(a);
    const w = Math.min(r.x + r.w, v.x + v.w) - Math.max(r.x, v.x);
    const h = Math.min(r.y + r.h, v.y + v.h) - Math.max(r.y, v.y);
    if (w > 0 && h > 0 && (!best || w * h > best.seen)) best = { key: a.key, seen: w * h };
  }
  return best?.key ?? null;
}

/** The loose workspaces as one more stop for the area switcher, keyed LOOSE_GROUP and as big as they are together; null while none is loose. */
export function looseStop(tiles: readonly Tile[]): AreaView | null {
  const r = boundsOf(tiles.filter((t) => t.area === LOOSE_GROUP).map((t) => t.rect));
  return r && { key: LOOSE_GROUP, rect: { ...r, repos: [] } };
}

/** The camera that shows an area whole, centred below a strip `top` px tall, never past 100%: a collapsed one's pill. */
export const areaCamera = (a: AreaView, viewport: Size, top = 0): Camera => fitBelow([areaShown(a)], viewport, top);

/** The rectangle between two points, either way round: a marquee. */
export const rectFrom = (a: Point, b: Point): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

/** The workspaces a marquee touches, in layout order: any part of one inside it picks it, as in Figma. */
export const tilesIn = (tiles: readonly Tile[], box: Rect): string[] => tiles.filter((t) => !t.hidden && overlaps(t.rect, box)).map((t) => t.key);

/**
 * The sessions on screen, for teamLiveView (which decides what teammates stream here): every session of each
 * workspace on screen (`seen`, keysOnScreen's), a stack's tabs included, and of the one in focus; never one in a
 * collapsed area.
 */
export function sessionsOnScreen(tiles: readonly Tile[], seen: ReadonlySet<string>, focus: string | null): string[] {
  return tiles.filter((t) => !t.hidden && (seen.has(t.key) || t.key === focus)).flatMap((t) => t.members.map((s) => s.id));
}

/**
 * The camera `t` (0–1, eased by the caller) of the way through a fly from `from` to `to`: the view's centre moves
 * in a straight line while the zoom changes by the same factor each step, so zooming in and out reads as even.
 */
export function flightAt(from: Camera, to: Camera, viewport: Size, t: number): Camera {
  if (t >= 1) return to;
  if (t <= 0) return from;
  const zoom = from.zoom * Math.pow(to.zoom / from.zoom, t);
  const at = (c: Camera, axis: "x" | "y") => c[axis] + (axis === "x" ? viewport.w : viewport.h) / (2 * c.zoom);
  const cx = at(from, "x") + (at(to, "x") - at(from, "x")) * t;
  const cy = at(from, "y") + (at(to, "y") - at(from, "y")) * t;
  return { x: cx - viewport.w / (2 * zoom), y: cy - viewport.h / (2 * zoom), zoom };
}

/** The camera at `cam`'s zoom with landscape point `p` in the middle of the view. */
export const centredAt = (cam: Camera, p: Point, viewport: Size): Camera => ({ x: p.x - viewport.w / (2 * cam.zoom), y: p.y - viewport.h / (2 * cam.zoom), zoom: cam.zoom });

/** How the minimap draws the landscape: landscape point p is at (p.x × k + ox, p.y × k + oy) in its box. */
export interface MinimapFit {
  k: number;
  ox: number;
  oy: number;
}

/** `bounds` fitted into `box`, centred, at least `pad` px from its edges. */
export function minimapFit(bounds: Rect, box: Size, pad = 6): MinimapFit {
  const k = Math.min((box.w - 2 * pad) / Math.max(bounds.w, 1), (box.h - 2 * pad) / Math.max(bounds.h, 1));
  return { k, ox: (box.w - bounds.w * k) / 2 - bounds.x * k, oy: (box.h - bounds.h * k) / 2 - bounds.y * k };
}
export const toMinimap = (f: MinimapFit, p: Point): Point => ({ x: p.x * f.k + f.ox, y: p.y * f.k + f.oy });
export const fromMinimap = (f: MinimapFit, p: Point): Point => ({ x: (p.x - f.ox) / f.k, y: (p.y - f.oy) / f.k });

/** One of the minimap's blocks: an area (`key` its key), or a workspace or stack in no area (`key` its tile's). */
export interface MinimapBlock {
  key: string;
  loose: boolean;
  rect: Rect;
}

/** What the minimap draws: each area as it's shown (a collapsed one's pill), then each workspace and ghost in no area at its place. */
export function minimapBlocks(r: ResolvedLayout): MinimapBlock[] {
  const areas = new Set(r.areas.map((a) => a.key));
  return [
    ...r.areas.map((a) => ({ key: a.key, loose: false, rect: areaShown(a) })),
    ...[...r.tiles, ...r.ghosts].filter((t) => !areas.has(t.area) && !t.hidden).map((t) => ({ key: t.key, loose: true, rect: t.rect })),
  ];
}

// ---- changing areas: what a gesture asks of the store and the sessions -----------------------------------

/** A session's group to set (null: out of every group), as setGroup takes it. */
export interface GroupMove {
  id: string;
  group: string | null;
}

/**
 * What a gesture does: a landscape patch, then groups set, then `after` (a stack's old key let go once its sessions
 * have left it); or why it can't be done. `note` says what was left out.
 *
 * Every workspace's new place is in `patch`, written before its group changes: one whose group changed first would be
 * placed anew (resolveLayout) and that place saved, racing the gesture's. A stack keeps its old key's place until its
 * last session has left it, for the same reason.
 */
export type AreaPlan = { patch: LandscapePatch | null; moves: GroupMove[]; after: LandscapePatch | null; note?: string } | { refused: string };
/** A gesture's plan that can be carried out. */
export type ReadyPlan = Exclude<AreaPlan, { refused: string }>;

/** Setting a gesture's groups stopped: what to say, and how many of its moves were made first. */
export interface MovesFailed {
  said: string;
  moved: number;
}

/** What carrying a plan out needs: the landscape as it is, the store, the sessions' groups, and where to say what stopped it. */
export interface PlanHands {
  before: Landscape;
  send: (patch: LandscapePatch, what: string) => Promise<{ rev: number } | { error: string }>;
  moves: (moves: readonly GroupMove[], what: string) => Promise<MovesFailed | null>;
  say: (text: string) => void;
  /** Its places have been sent, or weren't there to send (`error` is why they weren't saved). */
  patched?: (error: string | null, sent: boolean) => void;
}

/**
 * Plan `plan` carried out: its places, then its groups, then `after`. Groups that can't all be set put back the places
 * of the sessions still in their old ones, or they'd sit in an area they aren't in. The revision its places made
 * (null: there were none); null when it stopped, which has been said.
 */
export async function carryPlan(plan: ReadyPlan, what: string, h: PlanHands): Promise<{ rev: number | null } | null> {
  let rev: number | null = null;
  const send = async (patch: LandscapePatch, doing: string): Promise<string | null> => {
    const r = await h.send(patch, doing);
    if ("error" in r) return r.error;
    rev = r.rev;
    return null;
  };
  const error = plan.patch ? await send(plan.patch, what) : null;
  h.patched?.(error, !!plan.patch);
  if (error) {
    h.say(`${what}: not saved, ${error}`);
    return null;
  }
  if (plan.moves.length) {
    const failed = await h.moves(plan.moves, what);
    if (failed) {
      const back = plan.patch && undoOf(h.before, plan.patch, failed.moved ? plan.moves.slice(failed.moved).map((m) => m.id) : undefined);
      const undoError = back ? await send(back, `${what} (putting it back)`) : null;
      h.say(undoError ? `${failed.said}; and its places couldn't be put back: ${undoError}` : failed.said);
      return null;
    }
  }
  const afterError = plan.after ? await send(plan.after, what) : null;
  if (afterError) h.say(`${what}: its stack's old place wasn't let go, ${afterError}`);
  if (plan.note) h.say(plan.note);
  return afterError ? null : { rev };
}

/**
 * keptIn for a gesture on `layout`: its areas, the workspaces it shows, and the places it gave windows and cards. Its
 * ghosts are kept too, each in the area the layout drew it in (its group's, as a running workspace's), passive, at the
 * place the layout drew it at when landscape.json has none for it yet.
 */
function keptOf(l: Landscape, layout: ResolvedLayout): Kept[] {
  const laid = new Map<string, Rect>([...layout.windows.map((w): [string, Rect] => [`tool:${w.id}`, w.rect]), ...layout.cards.map((c): [string, Rect] => [`card:${c.id}`, c.rect])]);
  const areas = new Map(layout.areas.map((a) => [a.key, a.rect]));
  return [...keptIn(l, areas, shownIn(layout), laid), ...layout.ghosts.map((g) => ghostKept(g, areas.has(g.area) ? g.area : LOOSE_GROUP))];
}

/** Ghost `g` as something kept in area `area`: passive, at its place in `p`, else where the layout drew it. */
function ghostKept(g: GhostView, area: string): Kept {
  const id = g.front.id;
  if (g.stack) {
    const sk = g.stack;
    return { key: `stack:${sk}`, area, passive: true, at: (p) => own(p.stacks, sk)?.placement ?? g.rect, to: (p, to) => put(p.stacks, sk, { active: own(p.stacks, sk)?.active ?? id, placement: to }) };
  }
  return { key: `place:${id}`, area, passive: true, at: (p) => own(p.workspaces, id) ?? g.rect, to: (p, to) => put(p.workspaces, id, to) };
}

/**
 * What puts back what `patch` changed in `l`: each workspace, area, stack and ghost it touched as `l` had it, or gone
 * where `l` had none. Limited to `ids` (session ids), only those sessions' own places: what a gesture takes back for
 * the sessions whose group couldn't be set, when others' was.
 */
export function undoOf(l: Landscape, patch: LandscapePatch, ids?: readonly string[]): LandscapePatch | null {
  const p = emptyPatch();
  for (const k of PATCH_RECORDS) {
    const from = patch[k];
    if (!from || (ids && k !== "workspaces")) continue;
    const had = l[k] as Record<string, unknown>;
    for (const key of Object.keys(from)) if (!ids || ids.includes(key)) put(p[k] as Record<string, unknown>, key, own(had, key) ?? null);
  }
  return finish(p);
}

/** The note's distance above the viewport's bottom, its gutter at the sides, and its widest, in screen px. */
export const NOTE_BOTTOM = 58;
const NOTE_GUTTER = 16;
const NOTE_MAX_W = 560;
/** How far the note keeps clear of the minimap and the selection bar. */
const NOTE_CLEAR = 8;
/**
 * Where the landscape's note goes, in viewport px (`left`, and `bottom` up from the viewport's bottom): centred, in the
 * room left of the minimap (`maxWidth` keeps it there), and lifted clear above the selection bar where the bar is low
 * enough to be under it. `note` is its size at that width.
 */
export function notePlacement(view: Size, note: Size, minimap: Rect | null, bar: Rect | null): { left: number; bottom: number; maxWidth: number } {
  const right = minimap ? minimap.x - NOTE_CLEAR : view.w - NOTE_GUTTER;
  const maxWidth = Math.max(120, Math.min(NOTE_MAX_W, right - NOTE_GUTTER));
  const w = Math.min(note.w, maxWidth);
  const left = Math.max(NOTE_GUTTER, Math.min((view.w - w) / 2, right - w));
  const top = view.h - NOTE_BOTTOM - note.h;
  const under = !!bar && bar.y < view.h - NOTE_BOTTOM && bar.y + bar.h > top && bar.x < left + w && bar.x + bar.w > left;
  return { left, bottom: under ? view.h - bar!.y + NOTE_CLEAR : NOTE_BOTTOM, maxWidth };
}

/**
 * What puts back everything plan `p` changed in `l` (its patch, then its `after`, as undoOf does for one patch), as a
 * plan's two patches: `patch` puts back what it changed or let go (a dissolved stack's entry, what it pushed aside),
 * to be saved before the sessions' groups go back; `after` lets go of the places it made (the tabs' own), saved once
 * they have. In that order nothing is drawn with no place in between, which the layout would place and save.
 */
export function undoOfPlan(l: Landscape, p: { patch: LandscapePatch | null; after: LandscapePatch | null }): { patch: LandscapePatch | null; after: LandscapePatch | null } {
  const a = p.patch ? undoOf(l, p.patch) : null;
  const b = p.after ? undoOf(l, p.after) : null;
  const first = emptyPatch();
  const then = emptyPatch();
  for (const k of PATCH_RECORDS) Object.assign(first[k], a?.[k] ?? {}, b?.[k] ?? {});
  for (const [id, r] of Object.entries(first.workspaces)) {
    if (r !== null) continue;
    delete first.workspaces[id];
    put(then.workspaces, id, null);
  }
  return { patch: finish(first), after: finish(then) };
}

const isTheirs = (s: SessionInfo) => !!s.room?.remote;
const subOf = (t: Tile) => splitGroupKey(t.stack!).sub!;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The sessions and stacks a layout draws, running or as ghosts (a stack's closed tabs too). A place stored for any
 * other (a session hidden, or forgotten) stays taken, and moves with the area it's in.
 */
function shownIn(layout: ResolvedLayout): { ids: Set<string>; stacks: Set<string> } {
  const ids = new Set<string>();
  const stacks = new Set<string>();
  for (const t of [...layout.tiles, ...layout.ghosts]) {
    for (const s of [...t.members, ...(t.closed ?? [])]) ids.add(s.id);
    if (t.stack) stacks.add(t.stack);
  }
  return { ids, stacks };
}

/** The places of what isn't a running workspace: those stored for sessions and stacks the layout doesn't draw, and its ghosts'. Taken, as resolveLayout keeps them. */
const unshownPlaces = (l: Landscape, layout: ResolvedLayout): Rect[] => {
  const shown = shownIn(layout);
  return [
    ...Object.entries(l.workspaces).filter(([id]) => !shown.ids.has(id)).map(([, r]) => r),
    ...Object.entries(l.stacks).filter(([k]) => !shown.stacks.has(k)).map(([, s]) => s.placement),
    ...layout.ghosts.map((g) => g.rect),
  ];
};

/**
 * Move area `key` by `dx`, `dy` in `p`, with everything in it: its workspaces (a collapsed one's too) and what's kept
 * in it (`kept`: ghosts, windows, cards, and the places of sessions and stacks not shown, so a session resumed later
 * comes back inside it), never what's in `leaving` (tile keys, "tool:<id>", "card:<id>": moving elsewhere).
 */
function moveArea(p: FullPatch, layout: ResolvedLayout, kept: readonly Kept[], key: string, dx: number, dy: number, leaving: ReadonlySet<string> = NONE_LEAVING): void {
  const a = layout.areas.find((x) => x.key === key)!.rect;
  const was = own(p.areas, key);
  put(p.areas, key, { ...(was ?? {}), x: (was?.x ?? a.x) + dx, y: (was?.y ?? a.y) + dy });
  for (const t of layout.tiles) if (t.area === key && !leaving.has(t.key)) moveTile(p, t, dx, dy);
  shiftKept(p, kept, key, dx, dy, leaving);
}

/** Workspace `t` moved by `dx`, `dy` in `p`, from where `p` has it already. */
function moveTile(p: FullPatch, t: Tile, dx: number, dy: number): void {
  const r = shifted((t.stack ? own(p.stacks, t.stack)?.placement : own(p.workspaces, t.front.id)) ?? t.rect, dx, dy);
  if (t.stack) put(p.stacks, t.stack, { active: t.front.id, placement: r });
  else put(p.workspaces, t.front.id, r);
}

/**
 * Area `key` now `grown`: what's in its way pushed aside (pushAside), other areas (a locked one too, as a whole) with
 * everything in them, and what's in no area, which stays in none; but not what's in `leaving` (tile keys,
 * "tool:<id>", "card:<id>"), which is moving into it and has its place in `p` already. What's in which area is read
 * once, from `l` and `layout` as stored (keptOf), never from what `p` has moved so far.
 */
function growArea(p: FullPatch, l: Landscape, layout: ResolvedLayout, key: string, grown: Area, leaving: ReadonlySet<string>): void {
  put(p.areas, key, { ...(own(p.areas, key) ?? {}), w: grown.w, h: grown.h });
  const kept = keptOf(l, layout);
  const areas = layout.areas.map((a): [string, Rect] => [a.key, a.key === key ? grown : a.rect]);
  pushAll(areas, looseThings(p, layout, kept, leaving), [key], (k, dx, dy) => moveArea(p, layout, kept, k, dx, dy, leaving));
}

/** What's in no area, as pushAll pushes it: the workspaces and what's kept (`kept`), but what's in `leaving`. */
function looseThings(p: FullPatch, layout: ResolvedLayout, kept: readonly Kept[], leaving: ReadonlySet<string>): Pushed[] {
  return [
    ...layout.tiles.filter((t) => t.area === LOOSE_GROUP && !leaving.has(t.key)).map((t) => ({ rect: t.rect, passive: false, move: (dx: number, dy: number) => moveTile(p, t, dx, dy) })),
    ...looseOf(p, kept, leaving),
  ];
}

const STILL_KEY = "still\n";

/**
 * A workspace now at `r` in area `key` (LOOSE_GROUP: in none), moved, resized or taken out of a stack there: what's in
 * its way is pushed aside, and it never moves (docs/landscape-phase1.md, S6b). In an area: what else is in it (its
 * workspaces, and what it keeps: ghosts, windows, cards, the places of sessions not shown) goes right or down,
 * whichever is shorter, pushing on in turn, and the area grows to hold it all, pushing the areas in its way aside (a
 * locked one as a whole) and what's in no area (growArea). Loose: the loose things in its way go aside, and one pushed
 * into an area goes on past it. What nobody sees (ghosts, places of sessions not shown) is pushed but pushes nothing.
 * `leaving` (tile keys) and `leavingKept` (Kept keys) are what the gesture moves itself: never in the way. What's in
 * which area is read once from `l` and `layout` as stored (keptOf), never from what `p` has moved so far.
 */
function pushFrom(p: FullPatch, l: Landscape, layout: ResolvedLayout, key: string, r: Rect | readonly Rect[], leaving: ReadonlySet<string>, leavingKept: ReadonlySet<string> = NONE_LEAVING): void {
  const stills = Array.isArray(r) ? (r as readonly Rect[]) : [r as Rect];
  const kept = keptOf(l, layout).filter((k) => !leavingKept.has(k.key));
  type Item = { rect: Rect; passive: boolean; move: (dx: number, dy: number) => void };
  const items: Item[] = [
    ...layout.tiles.filter((t) => t.area === key && !leaving.has(t.key)).map((t) => ({ rect: t.rect, passive: false, move: (dx: number, dy: number) => moveTile(p, t, dx, dy) })),
    ...kept.flatMap((k): Item[] => {
      const at = k.area === key ? k.at(p) : null;
      return at ? [{ rect: at, passive: k.passive, move: (dx, dy) => k.to(p, shifted(k.at(p)!, dx, dy)) }] : [];
    }),
  ];
  const rects: Record<string, Rect> = {};
  const stillKeys = stills.map((_, i) => (i ? `${STILL_KEY}${i}` : STILL_KEY));
  stills.forEach((x, i) => put(rects, stillKeys[i], x));
  items.forEach((x, i) => put(rects, LOOSE_KEY + i, x.rect));
  const passive = new Set(items.flatMap((x, i) => (x.passive ? [LOOSE_KEY + i] : [])));
  const area = key === LOOSE_GROUP ? undefined : layout.areas.find((a) => a.key === key);
  if (!area) {
    // loose: the areas stay where they are, and a loose thing pushed into one goes on past it
    for (const a of layout.areas) put(rects, AREA_KEY + a.key, a.rect);
    const still = [...stillKeys, ...layout.areas.map((a) => AREA_KEY + a.key)];
    const gap = (a: string, b: string) => (a.startsWith(AREA_KEY) && b.startsWith(AREA_KEY) ? 0 : GAP);
    for (const [k, m] of Object.entries(pushAside(rects, still, gap, passive))) if (k.startsWith(LOOSE_KEY)) items[Number(k.slice(LOOSE_KEY.length))].move(m.dx, m.dy);
    return;
  }
  const moved: Rect[] = [...stills];
  for (const [k, m] of Object.entries(pushAside(rects, stillKeys, GAP, passive))) {
    const i = Number(k.slice(LOOSE_KEY.length));
    items[i].move(m.dx, m.dy);
    moved.push(shifted(items[i].rect, m.dx, m.dy));
  }
  const grown = fitAreaTo(area.rect, moved);
  if (grown !== area.rect) growArea(p, l, layout, key, grown, leaving);
}

/** A stack moving to area `area`: its new key, and its old one let go after the move (AreaPlan). */
function restack(p: FullPatch, after: FullPatch, l: Landscape, t: Tile, area: string, r: Rect): void {
  const sk = `${area}/${subOf(t)}`;
  // a stack of that name there already takes these tabs in where it is
  if (!own(l.stacks, sk)) put(p.stacks, sk, { active: t.front.id, placement: r });
  put(after.stacks, t.stack!, null);
}

/**
 * Make an area `key` (a sanitized group name) of the marquee's workspaces `picked`. A new one forms around them, moved
 * clear of the other areas with them (areas never overlap or nest); with an area of that name already, they join it
 * where it has room, as new workspaces do, and it grows to hold them. A stack keeps its tabs ("key/sub"). Teammates'
 * workspaces (only their owner moves them) and ones in locked areas stay where they are, and `note` says so.
 */
export function planMakeArea(l: Landscape, layout: ResolvedLayout, picked: readonly string[], key: string, titleOf: (key: string) => string): AreaPlan {
  if (!key) return { refused: "An area needs a name" };
  if (key === LOOSE_GROUP || key.includes("/")) return { refused: `“${key}” can't name an area: pick another name` };
  const areaOf = (k: string) => layout.areas.find((a) => a.key === k);
  const chosen = layout.tiles.filter((t) => picked.includes(t.key) && !t.hidden && t.area !== key);
  const theirs = chosen.filter((t) => t.members.some(isTheirs));
  const locked = chosen.filter((t) => !theirs.includes(t) && areaOf(t.area)?.rect.locked);
  const tiles = chosen.filter((t) => !theirs.includes(t) && !locked.includes(t));
  const left = [
    theirs.length ? `${theirs.length} teammate's ${plural(theirs.length, "workspace stays", "workspaces stay")} in ${plural(theirs.length, "its room", "their rooms")}` : "",
    locked.length ? `${locked.length} in a locked area ${plural(locked.length, "stays", "stay")} there` : "",
  ].filter(Boolean);
  if (!tiles.length) {
    const there = layout.tiles.some((t) => picked.includes(t.key) && t.area === key);
    return { refused: left.length ? `Nothing to move: ${left.join("; ")}` : there ? `They're in ${titleOf(key)} already` : "No workspace is selected" };
  }
  const target = areaOf(key);
  if (target?.rect.locked) return { refused: `${titleOf(key)} is locked: unlock it to add workspaces` };
  const p = emptyPatch();
  const after = emptyPatch();
  const place = (t: Tile, r: Rect) => (t.stack ? restack(p, after, l, t, key, r) : put(p.workspaces, t.front.id, r));
  if (target) {
    // each placed in it as a new workspace is, among everything that stays where it is
    const moving = new Set(tiles.map((t) => t.key));
    const occupied = [...layout.tiles.filter((t) => !moving.has(t.key)).map((t) => t.rect), ...unshownPlaces(l, layout), ...Object.values(l.ghosts).map((g) => g.placement), ...extraPlaces(l)];
    let area: Area = target.rect;
    for (const t of tiles) {
      const r = placeNew({ w: t.rect.w, h: t.rect.h }, occupied, area);
      occupied.push(r);
      area = fitAreaTo(area, [r]);
      place(t, r);
    }
    if (area !== target.rect) growArea(p, l, layout, key, area, moving);
  } else {
    const around = areaAround(tiles.map((t) => t.rect))!;
    const { dx, dy } = clearOf(around, layout.areas.map((a) => a.rect));
    // the repos its workspaces work in, with the base branch their areas had for each
    const bases = new Map(layout.areas.flatMap((a) => a.rect.repos.map((r): [string, string | null] => [r.path, r.base])));
    const repos = [...new Set(tiles.flatMap((t) => t.members.map((s) => s.repoPath).filter((x): x is string => !!x)))].map((path) => ({ path, base: bases.get(path) ?? null }));
    put(p.areas, key, { ...shifted(around, dx, dy), repos });
    for (const t of tiles) if (t.stack || dx || dy) place(t, shifted(t.rect, dx, dy));
  }
  // a stack's closed tabs go along with it
  const moves = tiles.flatMap((t) => [...t.members.filter((s) => !isTheirs(s)), ...(t.closed ?? [])].map((s) => ({ id: s.id, group: t.stack ? `${key}/${subOf(t)}` : key })));
  return { patch: finish(p), moves, after: finish(after), note: left.length ? left.join("; ") : undefined };
}

/**
 * Move to area's targets for the picked workspaces `picked`: each area, with the reason moving them there would be
 * refused (planMakeArea, tried without carrying it out), or null when it would go ahead.
 */
export function moveTargets(l: Landscape, layout: ResolvedLayout, picked: readonly string[], titleOf: (key: string) => string): { key: string; title: string; refused: string | null }[] {
  return layout.areas.map((a) => {
    const plan = planMakeArea(l, layout, picked, a.key, titleOf);
    return { key: a.key, title: titleOf(a.key), refused: "refused" in plan ? plan.refused : null };
  });
}

/**
 * A workspace dragged to `at` (its new corner) and dropped over area `target` (LOOSE_GROUP: no area). Its place
 * snaps to the grid; in an area it stays inside the padding and under the header (dropped across the left or top
 * edge it comes in), and one past the right or bottom edge grows the area, which pushes the areas in its way aside.
 * Into another area its group follows: refused for a teammate's (only its owner moves it), into or out of a locked
 * area, and for a stack going loose (a stack is a sub-group of an area).
 */
export function planMoveTile(l: Landscape, layout: ResolvedLayout, tileKey: string, at: Point, target: string, titleOf: (key: string) => string): AreaPlan {
  const t = layout.tiles.find((x) => x.key === tileKey);
  if (!t) return { refused: "That workspace isn't on the landscape any more" };
  const areaOf = (k: string) => (k === LOOSE_GROUP ? undefined : layout.areas.find((a) => a.key === k)?.rect);
  const from = areaOf(t.area);
  const into = areaOf(target);
  if (target !== LOOSE_GROUP && !into) return { refused: `${titleOf(target)} isn't on the landscape any more` };
  const crossing = target !== t.area;
  if (from?.locked) return { refused: `${titleOf(t.area)} is locked: unlock it to move its workspaces` };
  if (crossing && into?.locked) return { refused: `${titleOf(target)} is locked: unlock it to add workspaces` };
  const theirs = t.members.find(isTheirs);
  if (crossing && theirs) return { refused: `${theirs.room!.ownerName}'s workspace moves to another area only on their Mac` };
  if (crossing && t.stack && target === LOOSE_GROUP) return { refused: "A stack can't be loose: drop it in an area, or take its sessions out of it first" };
  let r: Rect = { ...t.rect, x: snap(at.x), y: snap(at.y) };
  const p = emptyPatch();
  const after = emptyPatch();
  if (into) r = { ...r, x: Math.max(r.x, snapUp(into.x + AREA_PAD)), y: Math.max(r.y, snapUp(into.y + AREA_HEADER)) };
  else {
    // a loose workspace stays out of every area, a collapsed one's whole rectangle too (it's all there once it opens):
    // one dropped partly over an area's edge is moved clear of it
    const { dx, dy } = clearOf(r, layout.areas.map((a) => a.rect), GAP);
    r = shifted(r, dx, dy);
  }
  // back where it started, there's nothing to save or to wait for
  if (!crossing && r.x === t.rect.x && r.y === t.rect.y) return { patch: null, moves: [], after: null };
  // what it's dropped on is pushed aside, and its area grows to hold it all (it never moves itself)
  pushFrom(p, l, layout, target, r, new Set([t.key]));
  if (t.stack && crossing) restack(p, after, l, t, target, r);
  else if (t.stack) put(p.stacks, t.stack, { active: t.front.id, placement: r });
  else put(p.workspaces, t.front.id, r);
  const group = target === LOOSE_GROUP ? null : t.stack ? `${target}/${subOf(t)}` : target;
  // a stack's closed tabs go along with it
  return { patch: finish(p), moves: crossing ? [...t.members, ...(t.closed ?? [])].map((s) => ({ id: s.id, group })) : [], after: finish(after) };
}

/**
 * Area `key` dragged by `dx`, `dy`: snapped, moved clear of the others (clearOf), its workspaces and ghosts with it, and
 * what's in no area pushed aside where it lands (one pushed into another area goes on past it, which stays). Refused
 * while it's locked.
 */
export function planMoveArea(l: Landscape, layout: ResolvedLayout, key: string, dx: number, dy: number, titleOf: (key: string) => string): AreaPlan {
  const a = layout.areas.find((x) => x.key === key);
  if (!a) return { refused: `${titleOf(key)} isn't on the landscape any more` };
  if (a.rect.locked) return { refused: `${titleOf(key)} is locked: unlock it to move it` };
  const want = shifted(a.rect, snap(dx), snap(dy));
  const clear = clearOf(want, layout.areas.filter((x) => x.key !== key).map((x) => x.rect));
  const mx = snap(dx) + clear.dx;
  const my = snap(dy) + clear.dy;
  if (!mx && !my) return { patch: null, moves: [], after: null };
  const p = emptyPatch();
  const kept = keptOf(l, layout);
  moveArea(p, layout, kept, key, mx, my);
  const areas = layout.areas.map((x): [string, Rect] => [x.key, x.key === key ? shifted(a.rect, mx, my) : x.rect]);
  pushAll(areas, looseThings(p, layout, kept, NONE_LEAVING), [key, ...layout.areas.filter((x) => x.key !== key).map((x) => x.key)], (k, ddx, ddy) => moveArea(p, layout, kept, k, ddx, ddy));
  return { patch: finish(p), moves: [], after: null };
}

// ---- tool windows, artifact cards and a workspace's size (S5) ---------------------------------------------------

/** Everything placed but `except` (a window's or a card's id, or a workspace's key): what something placed keeps clear of. */
function placedBut(l: Landscape, layout: ResolvedLayout, except: string | null): Rect[] {
  return [...layout.tiles.filter((t) => t.key !== except).map((t) => t.rect), ...unshownPlaces(l, layout), ...Object.values(l.ghosts).map((g) => g.placement), ...extraPlaces(l, except ?? undefined)];
}

/** Something placed in an area, and how a patch moves it: what making room beside a workspace shifts along. */
type Placed = { rect: Rect; move: (p: FullPatch, r: Rect) => void };

/** Everything placed in area `key` but workspace `except`: its workspaces, and what's kept in it (keptOf). */
function placedIn(l: Landscape, layout: ResolvedLayout, key: string, except: string): Placed[] {
  const out: Placed[] = [];
  for (const t of layout.tiles) {
    if (t.area !== key || t.key === except) continue;
    out.push({ rect: t.rect, move: (p, r) => (t.stack ? put(p.stacks, t.stack, { active: t.front.id, placement: r }) : put(p.workspaces, t.front.id, r)) });
  }
  const none = emptyPatch();
  for (const k of keptOf(l, layout)) {
    const r = k.area === key ? k.at(none) : null;
    if (r) out.push({ rect: r, move: k.to });
  }
  return out;
}

/**
 * Room for `size` just right of workspace `t`, top-aligned, in its (unlocked) area, made by moving along what's to its
 * right: what starts at or past its right edge and is in the way, and what that then runs into, all by the same step
 * so they keep their places relative to each other. Written into `p`; the spot made, or null when something reaching
 * in from the left is in the way, which moving right can't clear.
 */
function makeRoomRight(p: FullPatch, l: Landscape, layout: ResolvedLayout, t: Tile, size: Size): Rect | null {
  const spot: Rect = { x: snapUp(t.rect.x + t.rect.w + GAP), y: t.rect.y, ...size };
  const edge = t.rect.x + t.rect.w;
  const items = placedIn(l, layout, t.area, t.key);
  const inWay = (r: Rect) => overlaps(r, spot, GAP - 1e-6);
  if (items.some((i) => i.rect.x < edge && inWay(i.rect))) return null;
  const right = items.filter((i) => i.rect.x >= edge);
  const blocking = right.filter((i) => inWay(i.rect));
  if (!blocking.length) return spot;
  const dx = snapUp(spot.x + spot.w + GAP - Math.min(...blocking.map((i) => i.rect.x)));
  const moved = new Set(blocking);
  for (let more = true; more; ) {
    more = false;
    for (const i of right) {
      if (moved.has(i) || ![...moved].some((m) => overlaps(shifted(m.rect, dx, 0), i.rect, GAP - 1e-6))) continue;
      moved.add(i);
      more = true;
    }
  }
  for (const i of moved) i.move(p, shifted(i.rect, dx, 0));
  return spot;
}

/**
 * Where something of `size` goes in `area` (null: loose) beside `beside`, the workspace it serves: just right of it,
 * top-aligned; else just below it; else the area's first free spot, as a new workspace's (placeNew), the area growing
 * to take it. Loose: right of `beside`, moved clear of every area (`others`). In a locked area only a spot inside it
 * will do: null when there's none.
 */
function spotBeside(occupied: readonly Rect[], area: Area | null, size: Size, beside: Rect | null, others: readonly Rect[], makeRoom?: () => Rect | null): Rect | null {
  const free = (r: Rect) => !occupied.some((o) => overlaps(r, o, GAP - 1e-6));
  const candidates: Rect[] = beside
    ? [
        { x: snapUp(beside.x + beside.w + GAP), y: beside.y, ...size },
        { x: beside.x, y: snapUp(beside.y + beside.h + GAP), ...size },
      ]
    : [];
  if (!area) {
    for (const c of candidates) {
      const { dx, dy } = clearOf(c, others, GAP);
      const r = shifted(c, dx, dy);
      if (free(r)) return r;
    }
    return placeNew(size, [...occupied, ...others], null, others[0] ?? null);
  }
  const room = { x: area.x + AREA_PAD, y: area.y + AREA_HEADER, w: area.w - 2 * AREA_PAD, h: area.h - AREA_HEADER - AREA_PAD };
  const inside = (r: Rect) => r.x >= room.x && r.y >= room.y;
  for (const c of candidates) if (inside(c) && free(c) && (!area.locked || within(c, room))) return c;
  const made = !area.locked && makeRoom ? makeRoom() : null;
  if (made) return made;
  const r = placeNew(size, occupied, area);
  return !area.locked || within(r, room) ? r : null;
}

/**
 * Workspace `t`'s size as its Size S/M/L offer it: the preset its placement is (null when none is), and why it can't
 * be resized here (a teammate's, the size their terminal is; one in a locked area), or null.
 */
export function tileSize(t: Tile, layout: ResolvedLayout, titleOf: (key: string) => string): { current: SizePreset | null; blocked: string | null } {
  const kind = tileKind(t.members);
  // a preset is its terminal's cols × rows, so a workspace holding exactly those is at it whatever its pixels (a size
  // rounded differently, or a hair over); one a row short of it (sized before the footer took its 16 px) isn't
  const held = colsRows(t.rect.w, t.rect.h, CELL_ESTIMATE.w, CELL_ESTIMATE.h);
  const current = SIZE_PRESETS.find((p) => WORKSPACE_SIZES[kind][p].cols === held.cols && WORKSPACE_SIZES[kind][p].rows === held.rows);
  const theirs = t.members.find(isTheirs);
  const area = t.area === LOOSE_GROUP ? undefined : layout.areas.find((a) => a.key === t.area);
  const blocked = theirs ? `${theirs.room!.ownerName}'s workspace is the size their terminal is` : area?.rect.locked ? `${titleOf(area.key)} is locked: unlock it to resize its workspaces` : null;
  return { current: current ?? null, blocked };
}

/** A new id for a tool window ("w…") or a card ("c…"), unique among the landscape's. */
export function newExtraId(l: Landscape, prefix: "w" | "c", rand: () => number = Math.random): string {
  for (;;) {
    const id = `${prefix}${Date.now().toString(36)}${Math.floor(rand() * 36 ** 4).toString(36)}`;
    if (!Object.hasOwn(l.tools, id) && !Object.hasOwn(l.cards, id)) return id;
  }
}

/** What a tool window opens on: a workspace's session (the workspace tools), or an area (Artifacts, Chat). */
export type ToolScope = { session: string } | { area: string };

/**
 * Open tool window `id` (new, or a docked one placed again) as `tool` on `scope`. A workspace's window opens beside
 * its workspace, in its area (grown to take it, pushing the areas in its way aside, as a workspace dropped past its
 * edge does), or loose beside a loose one. With its right and below taken, what's to its right moves along to make
 * room (not in a locked area). An area's opens in its first free spot. A locked area takes it only where it has
 * room: refused otherwise, so the caller can dock it instead.
 */
export function planOpenWindow(l: Landscape, layout: ResolvedLayout, id: string, tool: ToolKind, scope: ToolScope, titleOf: (key: string) => string): AreaPlan {
  if ("session" in scope !== isWorkspaceTool(tool)) return { refused: `${tool} is ${isWorkspaceTool(tool) ? "a workspace's" : "an area's"} tool` };
  const tile = "session" in scope ? layout.tiles.find((t) => t.members.some((m) => m.id === scope.session)) : undefined;
  if ("session" in scope && !tile) return { refused: "That workspace isn't on the landscape any more" };
  const key = tile ? (tile.area === LOOSE_GROUP ? null : tile.area) : (scope as { area: string }).area;
  const area = key === null ? null : layout.areas.find((a) => a.key === key);
  if (key !== null && !area) return { refused: `${titleOf(key)} isn't on the landscape any more` };
  if (area?.rect.collapsed) return { refused: `${titleOf(area.key)} is collapsed: open it to place a window in it` };
  const size = toolSize(tool, tile?.rect ?? null);
  const p = emptyPatch();
  const makeRoom = tile && area ? () => makeRoomRight(p, l, layout, tile, size) : undefined;
  const r = spotBeside(placedBut(l, layout, id), area?.rect ?? null, size, tile?.rect ?? null, layout.areas.map((a) => a.rect), makeRoom);
  if (!r) return { refused: `${titleOf(area!.key)} is locked and has no room for the window` };
  put(p.tools, id, { tool, docked: false, ...("session" in scope ? { session: scope.session } : {}), area: key, placement: r });
  if (area) {
    const movedAlong = [...Object.values(p.workspaces), ...Object.values(p.stacks).map((s) => s?.placement), ...Object.values(p.tools).map((w) => w?.placement), ...Object.values(p.cards).map((c) => c?.placement), ...Object.values(p.ghosts).map((g) => g?.placement)];
    const grown = fitAreaTo(area.rect, [r, ...movedAlong.filter((x): x is Rect => !!x)]);
    if (grown !== area.rect) growArea(p, l, layout, area.key, grown, new Set([`tool:${id}`]));
  }
  return { patch: finish(p), moves: [], after: null };
}

/**
 * Where the camera goes to show a tool window just opened or placed again: one in `layout` that `before` (the ids
 * placed before) didn't have. Its workspace comes into view with it when both fit; null when it's in view already, or
 * nothing is new.
 */
export function cameraForOpened(before: ReadonlySet<string>, layout: ResolvedLayout, cam: Camera, viewport: Size): Camera | null {
  const w = layout.windows.find((x) => !before.has(x.id) && !x.hidden);
  if (!w || inView(cam, w.rect, viewport)) return null;
  const t = w.win.session ? layout.tiles.find((x) => x.members.some((m) => m.id === w.win.session)) : undefined;
  const both = t ? boundsOf([w.rect, t.rect]) : null;
  const fits = !!both && both.w * cam.zoom <= viewport.w && both.h * cam.zoom <= viewport.h;
  return centreOn(cam, fits ? both! : w.rect, viewport);
}

/** Dock tool window `id` to the window's edge: it gives up its scope and place, and follows the selected workspace. */
export function planDockWindow(l: Landscape, id: string): AreaPlan {
  const t = own(l.tools, id);
  if (!t) return { refused: "That window isn't open any more" };
  return t.docked ? { patch: null, moves: [], after: null } : { patch: { tools: { [id]: { tool: t.tool, docked: true } } }, moves: [], after: null };
}

/**
 * A placed window or card (`kind`) dragged to `at` and dropped over area `target` (LOOSE_GROUP: no area), as a
 * workspace is (planMoveTile): snapped, kept inside the area's padding, and growing it past its right or bottom edge.
 * A card, and an area's window (Artifacts, Chat), are the area's: they stay in it. A workspace's window may go to
 * another area or loose. Nothing moves into, out of or within a locked area.
 */
export function planMoveExtra(l: Landscape, layout: ResolvedLayout, kind: "window" | "card", id: string, at: Point, target: string, titleOf: (key: string) => string): AreaPlan {
  const w = kind === "window" ? layout.windows.find((x) => x.id === id) : undefined;
  const c = kind === "card" ? layout.cards.find((x) => x.id === id) : undefined;
  if (!w && !c) return { refused: `That ${kind} isn't on the landscape any more` };
  const fromKey = w ? w.area : c!.card.area;
  const rect = w ? w.rect : c!.rect;
  const areaOf = (k: string | null) => (k === null ? undefined : layout.areas.find((a) => a.key === k)?.rect);
  const toKey = target === LOOSE_GROUP ? null : target;
  const into = areaOf(toKey);
  if (toKey !== null && !into) return { refused: `${titleOf(toKey)} isn't on the landscape any more` };
  const crossing = toKey !== fromKey;
  if (crossing && (c || !isWorkspaceTool(w!.win.tool))) {
    const what = c ? "An artifact's card" : `${titleOf(fromKey!)}'s ${w!.win.tool === "chat" ? "chat" : "artifacts"}`;
    return { refused: `${what} stays in ${titleOf(fromKey!)}${w ? ": dock it to take it along" : ""}` };
  }
  if (areaOf(fromKey)?.locked) return { refused: `${titleOf(fromKey!)} is locked: unlock it to move what's in it` };
  if (crossing && into?.locked) return { refused: `${titleOf(toKey!)} is locked: unlock it to add to it` };
  let r: Rect = { ...rect, x: snap(at.x), y: snap(at.y) };
  const p = emptyPatch();
  if (into) {
    r = { ...r, x: Math.max(r.x, snapUp(into.x + AREA_PAD)), y: Math.max(r.y, snapUp(into.y + AREA_HEADER)) };
    const grown = fitAreaTo(into, [r]);
    if (grown !== into) growArea(p, l, layout, toKey!, grown, new Set([`${w ? "tool" : "card"}:${id}`]));
  } else {
    const { dx, dy } = clearOf(r, layout.areas.map((a) => a.rect), GAP);
    r = shifted(r, dx, dy);
  }
  if (w) put(p.tools, id, { ...w.win, area: toKey, placement: r });
  else put(p.cards, id, { ...c!.card, placement: r });
  return { patch: finish(p), moves: [], after: null };
}

/**
 * Place artifact `artifact` of area `key` as card `id` (Place, in the Artifacts window): beside `beside` (the window
 * it was placed from) when there's room, else in the area's first free spot, the area growing to take it. Refused in
 * a collapsed area, and in a locked one with no room.
 */
export function planPlaceCard(l: Landscape, layout: ResolvedLayout, id: string, key: string, shelf: string, artifact: string, beside: Rect | null, titleOf: (key: string) => string): AreaPlan {
  const area = layout.areas.find((a) => a.key === key);
  if (!area) return { refused: `${titleOf(key)} isn't on the landscape any more` };
  if (area.rect.collapsed) return { refused: `${titleOf(key)} is collapsed: open it to place the artifact` };
  const r = spotBeside(placedBut(l, layout, id), area.rect, CARD_SIZE, beside, layout.areas.map((a) => a.rect));
  if (!r) return { refused: `${titleOf(key)} is locked and has no room for the card` };
  const p = emptyPatch();
  put(p.cards, id, { area: key, shelf, artifact, placement: r });
  const grown = fitAreaTo(area.rect, [r]);
  if (grown !== area.rect) growArea(p, l, layout, key, grown, new Set([`card:${id}`]));
  return { patch: finish(p), moves: [], after: null };
}

/**
 * Where the selection goes so a docked window shows area `key`, which refused it a place (collapsed, or locked and
 * full): nowhere when the selected session is in it already (`select` null), else one of its workspaces' front
 * session. Null when it has none, so no docked window can show it.
 */
export function selectionFor(layout: ResolvedLayout, key: string, selected: SessionInfo | null): { select: string | null } | null {
  if (selected && areaKeyOf(selected) === key) return { select: null };
  const t = layout.tiles.find((x) => x.area === key);
  return t ? { select: t.front.id } : null;
}

/** Whether two tool scopes are the same workspace or area (none and none are). */
export const sameScope = (a: ToolScope | null, b: ToolScope | null): boolean =>
  !a || !b ? a === b : "session" in a ? "session" in b && a.session === b.session : "area" in b && a.area === b.area;

/**
 * Who an artifact of shelf `shelf`, in area `area`, is mentioned to: the selected session `s`, when its agent reads
 * that shelf. That's one of this Mac's in the area, the shelf being the one the area shows now (`areaShelf`: its room's
 * while it's shared as room `roomId`, else its own on this Mac), and in a room's area one of the room's sessions (an
 * agent outside the room reads none of its artifacts). Else why not, to say.
 */
export function mentionTarget(
  s: SessionInfo | null,
  area: string,
  shelf: string,
  areaShelf: string,
  roomId: string | null,
  titleOf: (key: string) => string,
  nameOf: (s: SessionInfo) => string
): { session: string } | { no: string } {
  if (!s || isTheirs(s)) return { no: "select one of this Mac's workspaces to mention it to" };
  const its = areaKeyOf(s);
  if (its !== area) return { no: `${nameOf(s)} is ${its === LOOSE_GROUP ? "in no area" : `in ${titleOf(its)}`}, not ${titleOf(area)}: select a workspace there` };
  if (shelf !== areaShelf)
    return { no: roomId ? `it's kept on this Mac, and ${titleOf(area)}'s agents read the room's artifacts: add it to the room first` : `it was a room's, and ${titleOf(area)} isn't shared as that room now` };
  if (roomId && s.room?.roomId !== roomId) return { no: `${nameOf(s)} isn't one of the room's sessions, so its agent can't read the room's artifacts` };
  return { session: s.id };
}

/** The shelf a card reads its artifact from (a room's, or its area's on this Mac), or why it can't any more. */
export type CardShelf = { shelf: { id: string; groupKey: string; local: boolean } } | { gone: string };

/**
 * Where card `c` reads its artifact: the shelf it was placed from. `rooms`: the ids of the rooms this Mac is in, or
 * null when they can't be said (the team status isn't read yet, or failed), when a room's shelf is read and what it
 * says is shown.
 */
export function cardShelf(c: ArtifactCard, rooms: ReadonlySet<string> | null): CardShelf {
  if (c.shelf === areaShelf(c.area)) return { shelf: { id: c.shelf, groupKey: c.area, local: true } };
  if (rooms && !rooms.has(c.shelf)) return { gone: "You left the room it was shared in: its artifacts went with it" };
  return { shelf: { id: c.shelf, groupKey: c.area, local: false } };
}

/**
 * Sharing area `key` as room `roomId` copied its artifacts (`ids`: each one's id in the room): its cards placed from
 * this Mac's shelf move to the room's copy, so they show what teammates see. The cards of artifacts it didn't copy
 * keep reading this Mac's. Null when no card moves.
 */
export function cardsAfterShare(l: Landscape, key: string, roomId: string, ids: Readonly<Record<string, string>>): LandscapePatch | null {
  const cards: Record<string, ArtifactCard> = {};
  for (const [id, c] of Object.entries(l.cards)) {
    const to = c.area === key && c.shelf === areaShelf(key) ? own(ids, c.artifact) : undefined;
    if (to) put(cards, id, { ...c, shelf: roomId, artifact: to });
  }
  return Object.keys(cards).length ? { cards } : null;
}

/**
 * Workspace `key` at a preset's `size` (Size S/M/L), its corner where it is: planResizeTo's rules. Its terminal follows
 * its new size.
 */
export function planResizeTile(l: Landscape, layout: ResolvedLayout, key: string, size: Size, titleOf: (key: string) => string): AreaPlan {
  const t = layout.tiles.find((x) => x.key === key);
  if (!t) return { refused: "That workspace isn't on the landscape any more" };
  return planResizeTo(l, layout, key, { ...t.rect, ...size }, titleOf);
}

/** The smallest a workspace is resized to: a terminal of this many columns and rows. */
export const MIN_TERM: { cols: number; rows: number } = { cols: 40, rows: 8 };
/** MIN_TERM's workspace, on the grid. */
export const minWorkspace = (cell: Cell = CELL_ESTIMATE): Size => {
  const s = sizeFor(MIN_TERM.cols, MIN_TERM.rows, cell.w, cell.h);
  return { w: snapUp(s.w), h: snapUp(s.h) };
};

/**
 * Workspace `key` resized to `to` (an edge dragged, or a size preset): on the grid, at least minWorkspace, in an area
 * kept inside its padding and under its header, and what it now covers pushed aside, its area growing to hold it all
 * (pushFrom); the workspace itself stays where it's put. Loose, it's kept clear of the areas, as a loose drop is. Its
 * terminal follows its new size (zooming never resizes it). Refused in a locked area, and for a teammate's workspace,
 * which is the size its owner's terminal is.
 */
export function planResizeTo(l: Landscape, layout: ResolvedLayout, key: string, to: Rect, titleOf: (key: string) => string): AreaPlan {
  const t = layout.tiles.find((x) => x.key === key);
  if (!t) return { refused: "That workspace isn't on the landscape any more" };
  const theirs = t.members.find(isTheirs);
  if (theirs) return { refused: `${theirs.room!.ownerName}'s workspace is the size their terminal is` };
  const area = t.area === LOOSE_GROUP ? undefined : layout.areas.find((a) => a.key === t.area);
  if (area?.rect.locked) return { refused: `${titleOf(t.area)} is locked: unlock it to resize its workspaces` };
  const min = minWorkspace();
  let r: Rect = { x: snap(to.x), y: snap(to.y), w: snap(to.w), h: snap(to.h) };
  if (area) {
    // a left or top edge dragged past the area's inside edge stops there; the opposite edge stays where it was put
    const left = snapUp(area.rect.x + AREA_PAD);
    const top = snapUp(area.rect.y + AREA_HEADER);
    if (r.x < left) r = { ...r, x: left, w: r.x + r.w - left };
    if (r.y < top) r = { ...r, y: top, h: r.y + r.h - top };
  }
  r = { ...r, w: Math.max(min.w, r.w), h: Math.max(min.h, r.h) };
  if (!area) {
    const { dx, dy } = clearOf(r, layout.areas.map((a) => a.rect), GAP);
    r = shifted(r, dx, dy);
  }
  if (r.x === t.rect.x && r.y === t.rect.y && r.w === t.rect.w && r.h === t.rect.h) return { patch: null, moves: [], after: null };
  const p = emptyPatch();
  pushFrom(p, l, layout, t.area, r, new Set([key]));
  if (t.stack) put(p.stacks, t.stack, { active: t.front.id, placement: r });
  else put(p.workspaces, t.front.id, r);
  return { patch: finish(p), moves: [], after: null };
}

// ---- moving and resizing by hand: snapping and guides (S6b) -------------------------------------------------------

/** How near, in screen px, an edge comes to a neighbour's before it snaps to it. */
export const SNAP_PX = 6;

/**
 * A guide drawn while dragging: the line an edge snapped along. `axis` "x" is a vertical line at x = `at` from y =
 * `from` to `to`; "y" a horizontal one at y = `at` from x = `from` to `to`. Landscape px.
 */
export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

/** Which edges a drag moves: all four (moving it), or those of a resize handle. */
export interface Edges {
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
}
export const MOVE_EDGES: Edges = { left: true, right: true, top: true, bottom: true };

/** A snap candidate on one axis: where the moving edge goes, and the line its guide is drawn along with the rect it lines up with. */
type Candidate = { pos: number; line: number; other: Rect };

/** The nearest candidate within `within` of `want`, or null. */
const nearestOf = (cands: readonly Candidate[], want: number, within: number): Candidate | null => {
  let best: Candidate | null = null;
  for (const c of cands) if (Math.abs(c.pos - want) <= within && (!best || Math.abs(c.pos - want) < Math.abs(best.pos - want))) best = c;
  return best;
};

/**
 * A rect dragged to `want` (moved, or resized by the `edges` its handle moves), snapped: each moving edge to the
 * nearest neighbour edge within SNAP_PX on screen (`zoom`): lined up with one of `others`' edges, or GAP beside it,
 * and to `inner` (its area's inside edges, the padding and the header's line) the same way; an edge with none near is
 * on the 8 px grid. A move keeps its size; a resize keeps at least `min`. The guides are the lines it snapped along, one
 * per neighbour it lines up with on that line, spanning both.
 */
export function snapRect(want: Rect, edges: Edges, others: readonly Rect[], zoom: number, inner: Rect | null = null, min: Size = { w: 1, h: 1 }): { rect: Rect; guides: Guide[] } {
  const within = SNAP_PX / zoom;
  const moving = edges.left && edges.right;
  // never to a spot past the inside's left or top, which a drop moves it back in from (past its right or bottom the
  // area grows to hold it): what's lined up with there, a loose ghost's edge say, would put it through the header
  const keepsIn = (p: "x" | "y") => (c: Candidate) => !inner || c.pos >= inner[p] - 1e-6;
  // nor the plain grid: what's drawn while dragging is where a drop leaves it (planMoveTile, planResizeTo)
  const onGrid = (p: "x" | "y", v: number) => (inner ? Math.max(snap(v), snapUp(inner[p])) : snap(v));
  const targets: Rect[] = [...others];
  // the area's inside lines up like a neighbour's edges, without the gap beside it
  const insideCands = (lo: number, hi: number, len: number, start: boolean, end: boolean): Candidate[] => {
    if (!inner) return [];
    const o: Rect = inner;
    return [...(start ? [{ pos: lo, line: lo, other: o }] : []), ...(end ? [{ pos: hi - len, line: hi, other: o }] : [])];
  };
  const axis = (x: "x" | "y") => {
    const p = x === "x" ? "x" : "y";
    const s = x === "x" ? "w" : "h";
    const lo = x === "x" ? edges.left : edges.top;
    const hi = x === "x" ? edges.right : edges.bottom;
    const r = want;
    const innerLo = inner ? inner[p] : 0;
    const innerHi = inner ? inner[p] + inner[s] : 0;
    if (moving) {
      // the rect's start edge: lined up with a start or an end, GAP past an end or before a start; its end edge likewise
      const cands: Candidate[] = [
        ...targets.flatMap((o) => [
          { pos: o[p], line: o[p], other: o },
          { pos: o[p] + o[s] - r[s], line: o[p] + o[s], other: o },
          { pos: o[p] + o[s] + GAP, line: o[p] + o[s] + GAP, other: o },
          { pos: o[p] - GAP - r[s], line: o[p] - GAP, other: o },
        ]),
        ...insideCands(innerLo, innerHi, r[s], true, true),
      ].filter(keepsIn(p));
      const c = nearestOf(cands, r[p], within);
      return { start: c ? c.pos : onGrid(p, r[p]), size: r[s], guide: c };
    }
    if (lo) {
      const end = r[p] + r[s];
      const cands: Candidate[] = [...targets.flatMap((o) => [{ pos: o[p], line: o[p], other: o }, { pos: o[p] + o[s] + GAP, line: o[p] + o[s] + GAP, other: o }]), ...(inner ? [{ pos: innerLo, line: innerLo, other: inner }] : [])].filter(keepsIn(p));
      const c = nearestOf(cands, r[p], within);
      const start = Math.min(c ? c.pos : onGrid(p, r[p]), end - min[s]);
      return { start, size: end - start, guide: c && c.pos === start ? c : null };
    }
    if (hi) {
      const cands: Candidate[] = [...targets.flatMap((o) => [{ pos: o[p] + o[s], line: o[p] + o[s], other: o }, { pos: o[p] - GAP, line: o[p] - GAP, other: o }]), ...(inner ? [{ pos: innerHi, line: innerHi, other: inner }] : [])];
      const c = nearestOf(cands, r[p] + r[s], within);
      const end = Math.max(c ? c.pos : snap(r[p] + r[s]), r[p] + min[s]);
      return { start: r[p], size: end - r[p], guide: c && c.pos === end ? c : null };
    }
    return { start: r[p], size: r[s], guide: null };
  };
  const ax = axis("x");
  const ay = axis("y");
  const rect: Rect = { x: ax.start, y: ay.start, w: ax.size, h: ay.size };
  const guides: Guide[] = [];
  // every neighbour lined up along the snapped line gets its own guide, spanning it and the rect
  const along = (g: Candidate | null, a: "x" | "y") => {
    if (!g) return;
    const cross = a === "x" ? "y" : "x";
    const len = a === "x" ? "h" : "w";
    for (const o of [...targets, ...(inner ? [inner] : [])]) {
      const lines = a === "x" ? [o.x, o.x + o.w, o.x - GAP, o.x + o.w + GAP] : [o.y, o.y + o.h, o.y - GAP, o.y + o.h + GAP];
      if (!lines.some((v) => Math.abs(v - g.line) < 1e-6)) continue;
      guides.push({ axis: a, at: g.line, from: Math.min(o[cross], rect[cross]), to: Math.max(o[cross] + o[len], rect[cross] + rect[len]) });
    }
  };
  along(ax.guide, "x");
  along(ay.guide, "y");
  return { rect, guides };
}

/** The size preset `p` for workspace `t`: an agent's, or a terminal's when it holds only terminals. */
export const presetFor = (t: Tile, p: SizePreset): Size => presetSize(tileKind(t.members), p);

// ---- Tidy and ghosts (S6b) ---------------------------------------------------------------------------------------

/** The first of "tabs", "tabs-2", "tabs-3"… that isn't among `taken`: a new stack's sub-group name. */
export function freeSubName(taken: Iterable<string | null | undefined>): string {
  const has = new Set(taken);
  if (!has.has("tabs")) return "tabs";
  let i = 2;
  while (has.has(`tabs-${i}`)) i++;
  return `tabs-${i}`;
}

/** A sub-group name for a new stack in area `area` that no stack there has (freeSubName). */
export function newStackName(l: Landscape, layout: Pick<ResolvedLayout, "tiles" | "ghosts">, area: string): string {
  const keys = [...Object.keys(l.stacks), ...[...layout.tiles, ...layout.ghosts].flatMap((t) => [...t.members, ...(t.closed ?? [])].map((s) => s.taskGroup ?? ""))];
  return freeSubName(keys.map((k) => splitGroupKey(k)).filter((k) => k.top === area).map((k) => k.sub));
}

/**
 * Stack the picked workspaces `picked` into one card with a tab each (⌘G): a sub-group of their area ("area/sub"),
 * which rooms and usage already read. The first stack among them (in reading order) takes the others in;
 * with none, a new one ("tabs", "tabs-2"…) forms in the place of the first of them, its session in front. The others
 * leave their places, which stay free. A stack's closed tabs go along with it. Refused unless two or more are picked
 * in one area that isn't locked; a teammate's workspace (only its owner moves it, a stack holding one too) stays out,
 * and `note` says so.
 */
export function planStack(l: Landscape, layout: ResolvedLayout, picked: readonly string[], titleOf: (key: string) => string): AreaPlan {
  const chosen = layout.tiles.filter((t) => picked.includes(t.key) && !t.hidden).sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  if (chosen.length < 2) return { refused: "Pick two or more workspaces to stack them" };
  const areasOf = new Set(chosen.map((t) => t.area));
  if (areasOf.has(LOOSE_GROUP)) return { refused: "A stack is part of an area: make an area of them first (M), or move them into one" };
  if (areasOf.size > 1) return { refused: "They're in different areas: move them into one area first" };
  const key = chosen[0].area;
  const area = layout.areas.find((a) => a.key === key);
  if (!area) return { refused: `${titleOf(key)} isn't on the landscape any more` };
  if (area.rect.locked) return { refused: `${titleOf(key)} is locked: unlock it to stack its workspaces` };
  const target = chosen.find((t) => t.stack);
  const others = chosen.filter((t) => t !== target);
  const theirs = others.filter((t) => t.members.some(isTheirs));
  const moving = others.filter((t) => !theirs.includes(t));
  const note = theirs.length ? `${theirs.length} teammate's ${plural(theirs.length, "workspace stays", "workspaces stay")} out of the stack: only ${plural(theirs.length, "its owner moves it", "their owners move them")}` : undefined;
  if (!target && moving.length < 2) return { refused: theirs.length ? `Only one of them is this Mac's: ${note}` : "Pick two or more workspaces to stack them" };
  if (!moving.length) return { refused: `Nothing to stack: ${note}` };
  const p = emptyPatch();
  const after = emptyPatch();
  const sk = target?.stack ?? `${key}/${newStackName(l, layout, key)}`;
  if (!target) put(p.stacks, sk, { active: moving[0].front.id, placement: moving[0].rect });
  const moves: GroupMove[] = [];
  for (const t of moving) {
    for (const s of [...t.members, ...(t.closed ?? [])]) moves.push({ id: s.id, group: sk });
    if (t.stack) put(after.stacks, t.stack, null);
    else if (own(l.workspaces, t.front.id)) put(after.workspaces, t.front.id, null);
  }
  return { patch: finish(p), moves, after: finish(after), note };
}

/**
 * Take session `id` out of its stack (a tab dragged out, or Unstack): dropped at `at` (its corner) over area
 * `target` (LOOSE_GROUP: none), as a workspace moved there would be (planMoveTile's rules: kept inside the area's
 * padding, growing it past its right or bottom edge and pushing what's in its way aside). It's the size the stack is.
 * Its group becomes the area's own; a stack left with one tab and no closed tabs stops being one, that tab taking the
 * stack's place (one with closed tabs stays a stack, so they keep its place rather than scattering as ghosts), and a
 * stack whose front tab left brings another to the front. Refused for a teammate's tab, a tab of a locked area,
 * into a locked area, and loose (a stack's tab stays in an area).
 */
export function planUnstack(l: Landscape, layout: ResolvedLayout, id: string, at: Point, target: string, titleOf: (key: string) => string): AreaPlan {
  const t = layout.tiles.find((x) => x.stack && x.members.some((m) => m.id === id));
  if (!t) return { refused: "That tab isn't in a stack on the landscape any more" };
  const s = t.members.find((m) => m.id === id)!;
  if (isTheirs(s)) return { refused: `${s.room!.ownerName}'s session leaves the stack only on their Mac` };
  if (t.members.length < 2) return { refused: "A stack's only tab: there's nothing to take it out of" };
  const from = layout.areas.find((a) => a.key === t.area)?.rect;
  if (from?.locked) return { refused: `${titleOf(t.area)} is locked: unlock it to take tabs out of its stacks` };
  if (target === LOOSE_GROUP) return { refused: "A stack's tab stays in an area: drop it inside one" };
  const into = layout.areas.find((a) => a.key === target)?.rect;
  if (!into) return { refused: `${titleOf(target)} isn't on the landscape any more` };
  if (target !== t.area && into.locked) return { refused: `${titleOf(target)} is locked: unlock it to add workspaces` };
  const theirsIn = target !== t.area && t.members.some((m) => m.id !== id && isTheirs(m)) && t.members.length === 2;
  // the one left behind would leave the stack, and a teammate's session moves only on their Mac
  if (theirsIn) return { refused: `${t.members.find((m) => m.id !== id)!.room!.ownerName}'s session would be left alone in the stack: take it out on their Mac` };
  const p = emptyPatch();
  const after = emptyPatch();
  let r: Rect = { x: snap(at.x), y: snap(at.y), w: t.rect.w, h: t.rect.h };
  r = { ...r, x: Math.max(r.x, snapUp(into.x + AREA_PAD)), y: Math.max(r.y, snapUp(into.y + AREA_HEADER)) };
  put(p.workspaces, id, r);
  // the stack stays where it is, unless the tab is dropped over it: then it's pushed aside as anything in the way is
  pushFrom(p, l, layout, target, r, NONE_LEAVING, new Set([`place:${id}`]));
  const stackAt = own(p.stacks, t.stack!)?.placement ?? t.rect;
  const rest = t.members.filter((m) => m.id !== id);
  const moves: GroupMove[] = [{ id, group: target }];
  if (rest.length === 1 && !isTheirs(rest[0]) && !t.closed?.length) {
    // a stack of one is no stack: its last tab takes its place as a workspace of its own
    delete p.stacks[t.stack!];
    put(p.workspaces, rest[0].id, stackAt);
    moves.push({ id: rest[0].id, group: t.area });
    put(after.stacks, t.stack!, null);
  } else if (t.front.id === id) put(p.stacks, t.stack!, { active: rest[0].id, placement: stackAt });
  return { patch: finish(p), moves, after: finish(after) };
}

/**
 * Why stack `stack` can't be unstacked now, or null: the one rule its row and the Team view's ✕ keep. Not one in a locked
 * area, nor one whose tabs are all teammates' (only their owners move those).
 */
export function unstackRefusal(layout: Pick<ResolvedLayout, "areas" | "tiles">, stack: string, titleOf: (key: string) => string): string | null {
  const t = layout.tiles.find((x) => x.stack === stack);
  if (!t) return "That stack isn't on the landscape any more";
  if (layout.areas.find((a) => a.key === t.area)?.rect.locked) return `${titleOf(t.area)} is locked: unlock it to take tabs out of its stacks`;
  if (t.members.every(isTheirs)) return `${t.members[0].room!.ownerName}'s sessions leave the stack only on their Mac`;
  return null;
}

/**
 * Every tab of this Mac's out of stack `stack`, up into its area (Unstack): the one in front takes the stack's place, the
 * others are placed as any new workspace is (resolveLayout, which grows the area to hold them). With a teammate's tab in
 * it the stack stays where it is, holding theirs, and every one of this Mac's goes where there's room. Its closed tabs
 * go with it and, with no place, are in the Closed sessions list. The front tab moves last, so it never sits on the
 * stack's place beside the stack it left.
 */
export function planUnstackAll(layout: Pick<ResolvedLayout, "areas" | "tiles">, stack: string, titleOf: (key: string) => string): AreaPlan {
  const refused = unstackRefusal(layout, stack, titleOf);
  if (refused) return { refused };
  const t = layout.tiles.find((x) => x.stack === stack)!;
  const group = t.area === LOOSE_GROUP ? null : t.area;
  const mine = t.members.filter((s) => !isTheirs(s));
  const keeps = mine.length < t.members.length;
  const p = emptyPatch();
  const after = emptyPatch();
  const front = keeps ? null : (mine.find((s) => s.id === t.front.id) ?? mine[0]);
  if (front) {
    put(p.workspaces, front.id, t.rect);
    put(after.stacks, stack, null);
  }
  const closed = keeps ? [] : (t.closed ?? []);
  const moves: GroupMove[] = [...closed, ...mine.filter((s) => s !== front), ...(front ? [front] : [])].map((s) => ({ id: s.id, group }));
  return { patch: finish(p), moves, after: finish(after), note: closed.length ? `${closed.length === 1 ? "Its closed tab is" : `Its ${closed.length} closed tabs are`} in the Closed sessions list` : undefined };
}

/**
 * New session `next` (in stack `stack`, which it has just started) and workspace `lone` made one card, in `lone`'s place:
 * `next` in front, as a new tab is. Refused when `lone` has no workspace on the landscape.
 */
export function planJoinStack(layout: Pick<ResolvedLayout, "tiles">, lone: string, next: string, stack: string): AreaPlan {
  const t = layout.tiles.find((x) => !x.stack && x.front.id === lone);
  if (!t) return { refused: "That workspace isn't on the landscape any more" };
  const p = emptyPatch();
  const after = emptyPatch();
  put(p.stacks, stack, { active: next, placement: t.rect });
  put(after.workspaces, lone, null);
  return { patch: finish(p), moves: [{ id: lone, group: stack }], after: finish(after) };
}

/**
 * Why area `key` can't be tidied now, or null: the one rule its Tidy row, T and the hover toolbar keep. Not a locked
 * area (its layout is frozen), nor a collapsed one, nor one with no workspace or ghost in it.
 */
export function tidyRefusal(layout: Pick<ResolvedLayout, "areas" | "tiles" | "ghosts">, key: string, titleOf: (key: string) => string): string | null {
  const area = layout.areas.find((a) => a.key === key);
  if (!area) return `${titleOf(key)} isn't on the landscape any more`;
  if (area.rect.locked) return `${titleOf(key)} is locked: unlock it to tidy it`;
  if (area.rect.collapsed) return `${titleOf(key)} is collapsed: open it to tidy it`;
  if (![...layout.tiles, ...layout.ghosts].some((t) => t.area === key)) return `${titleOf(key)} has no workspaces to tidy`;
  return null;
}

/** When a workspace or ghost was made: its earliest session's. */
const madeAt = (t: Tile) => Math.min(...t.members.map((s) => s.createdAt));

/** A wire as Tidy reads it: its ends' sessions and its type. */
export type TidyWire = Pick<Wire, "from" | "to" | "type">;

/**
 * The space Tidy leaves between a chain's columns, which handoffs cross, so a wire and its label have room to run:
 * Zoomed.dc.html's 50 px between cards at 45%, on the grid. Everything else stays GAP apart.
 */
export const WIRED_COLUMN_GAP = 112;

/**
 * The room Tidy leaves over a chain that fans out (a column of two or more, an Orchestrator's steps on several
 * tickets), for each column's caption: what its workspaces are (stageCaptions).
 */
export const STAGE_CAPTION_H = 24;

/** A column caption over a chain Tidy laid out along its wires: the word its workspaces' names share, placed over them. */
export interface StageCaption {
  area: string;
  x: number;
  y: number;
  w: number;
  text: string;
}

/** The first word every one of `tiles`' names starts with ("Coder 5152 – …", "Coder 5153 – …": Coder), or null. */
export function stageWord(tiles: readonly Tile[]): string | null {
  const words = tiles.map((t) => (t.front.title.trim().split(/[\s–—:·]+/)[0] ?? "").replace(/[^\p{L}\p{N}-]+$/u, ""));
  const first = words[0];
  return first && words.every((w) => w.toLowerCase() === first.toLowerCase()) ? first : null;
}

/** Whether a chain fans out: it has columns, one of which holds two or more, so its columns are captioned. */
const fans = (band: readonly Tile[][]) => band.length > 1 && band.some((column) => column.length > 1);

/**
 * The captions over each fanning chain laid out in columns along `wires` (Tidy, or a plan laid out): a chain whose
 * columns still line up, each at one left edge and left of the next, gets the word each column of two or more
 * workspaces' names share over it. A chain moved out of its columns gets none, as does a column whose names share no
 * first word.
 */
export function stageCaptions(layout: Pick<ResolvedLayout, "areas" | "tiles" | "ghosts">, wires: readonly TidyWire[]): StageCaption[] {
  const out: StageCaption[] = [];
  for (const a of layout.areas) {
    if (a.rect.collapsed) continue;
    const tiles = [...layout.tiles, ...layout.ghosts].filter((t) => t.area === a.key && !t.hidden).sort((x, y) => madeAt(x) - madeAt(y) || x.rect.y - y.rect.y || x.rect.x - y.rect.x);
    for (const band of alongWires(tiles, wires)?.bands ?? []) {
      const columns = band.filter((c) => c?.length);
      if (!fans(columns)) continue;
      const lined = columns.every((c, i) => c.every((t) => Math.abs(t.rect.x - c[0].rect.x) < 1) && (i === 0 || c[0].rect.x > Math.max(...columns[i - 1].map((t) => t.rect.x + t.rect.w))));
      if (!lined) continue;
      // one workspace's column needs none: its own name says it
      for (const c of columns.filter((x) => x.length > 1)) {
        const text = stageWord(c);
        if (text) out.push({ area: a.key, x: c[0].rect.x, y: Math.min(...c.map((t) => t.rect.y)) - STAGE_CAPTION_H, w: Math.max(...c.map((t) => t.rect.w)), text });
      }
    }
  }
  return out;
}

/** Something Tidy places: a workspace, a ghost, a tool window or a card, and how its place is set in a patch. */
type TidyItem = { key: string; rect: Rect; move: (p: FullPatch, r: Rect) => void };

/**
 * Chains laid out along their wires (alongWires' `bands`) from (`left`, `top`) down: each chain's columns left to right
 * WIRED_COLUMN_GAP apart, one chain under another, a chain that fans out leaving room over its columns for their
 * captions; in a column a workspace, the terminals sharing its worktree, then their tool windows (`windowsOf`, by tile
 * key). Each is put where it goes with `place`. Answers the y under them all.
 */
function placeBands(
  along: NonNullable<ReturnType<typeof alongWires>>,
  windowsOf: ReadonlyMap<string, TidyItem[]>,
  itemOf: (t: Tile) => TidyItem,
  place: (it: TidyItem, x: number, y: number) => void,
  left: number,
  top: number
): number {
  let y = top;
  for (const band of along.bands) {
    if (fans(band.filter(Boolean))) y = snapUp(y + STAGE_CAPTION_H);
    let x = left;
    let below = y;
    for (const column of band) {
      const stacked = column.flatMap((t) => {
        const block = [t, ...(along.under.get(t) ?? [])];
        return [...block.map(itemOf), ...block.flatMap((u) => windowsOf.get(u.key) ?? [])];
      });
      let cy = y;
      for (const it of stacked) {
        place(it, x, cy);
        cy = snapUp(cy + it.rect.h + GAP);
      }
      below = Math.max(below, cy);
      // every column after the first has a handoff in from the one before it (the longest path)
      x = snapUp(x + Math.max(...stacked.map((it) => it.rect.w)) + WIRED_COLUMN_GAP);
    }
    y = below;
  }
  return y;
}

/** The workspaces and ghosts of one pipeline (pipelineOf): its area, and its tiles in the order they were made. */
export interface Pipeline {
  area: string;
  tiles: Tile[];
}

/**
 * The pipeline `key` is part of: the workspaces and ghosts (not-started steps and closed ones among them) in its area
 * that wires join to it, whatever their type, through one another. `key` is a tile's key (a ghost's too) or one of its
 * sessions' ids. A wire to another area's workspace isn't followed: a pipeline is laid out in its area. Null when it
 * isn't drawn, or no wire joins it to another there.
 */
export function pipelineOf(layout: Pick<ResolvedLayout, "tiles" | "ghosts">, key: string, wires: readonly TidyWire[]): Pipeline | null {
  const all = [...layout.tiles, ...layout.ghosts].filter((t) => !t.hidden);
  const idsOf = (t: Tile) => [...t.members, ...(t.closed ?? [])].map((s) => s.id);
  const start = all.find((t) => t.key === key) ?? all.find((t) => idsOf(t).includes(key));
  if (!start) return null;
  const tileOf = new Map<string, Tile>();
  for (const t of all.filter((x) => x.area === start.area)) for (const id of idsOf(t)) tileOf.set(id, t);
  const next = new Map<Tile, Set<Tile>>();
  for (const w of wires) {
    const a = tileOf.get(w.from);
    const b = tileOf.get(w.to);
    if (!a || !b || a === b) continue;
    next.set(a, (next.get(a) ?? new Set()).add(b));
    next.set(b, (next.get(b) ?? new Set()).add(a));
  }
  const seen = new Set<Tile>([start]);
  const queue = [start];
  while (queue.length) for (const n of next.get(queue.shift()!) ?? []) if (!seen.has(n)) seen.add(n) && queue.push(n);
  if (seen.size < 2) return null;
  return { area: start.area, tiles: [...seen].sort((a, b) => madeAt(a) - madeAt(b) || a.rect.y - b.rect.y || a.rect.x - b.rect.x) };
}

/**
 * Re-lay out the pipeline `key` is part of (pipelineOf) in stage columns along its wires, as Tidy lays a chain out
 * (alongWires, placeBands), at any time: only its workspaces and ghosts and their tool windows move, anchored at the
 * pipeline's top-left as it lies now (its first stage's), with room over fanning columns for their captions. What else
 * is in the area stays where it is unless the new block lands on it; then it's pushed aside as a drag pushes what's in
 * its way (pushFrom), and the area grows to hold it all. Refused while the area is locked or collapsed, or when `key`
 * isn't wired to anything in it. `undoOfPlan(l, plan)` puts every place back.
 */
export function planRelayoutPipeline(l: Landscape, layout: ResolvedLayout, key: string, titleOf: (key: string) => string, wires: readonly TidyWire[]): AreaPlan {
  const pipe = pipelineOf(layout, key, wires);
  if (!pipe) return { refused: "It isn't wired to another workspace in its area, so there's no pipeline to lay out" };
  const area = layout.areas.find((a) => a.key === pipe.area);
  if (!area) return { refused: "Its pipeline isn't in an area: move it into one to lay it out" };
  if (area.rect.locked) return { refused: `${titleOf(pipe.area)} is locked: unlock it to lay its pipeline out` };
  if (area.rect.collapsed) return { refused: `${titleOf(pipe.area)} is collapsed: open it to lay its pipeline out` };
  const along = alongWires(pipe.tiles, wires);
  if (!along) return { refused: "It isn't wired to another workspace in its area, so there's no pipeline to lay out" };
  const members = new Set(pipe.tiles);
  const none = emptyPatch();
  const windowsOf = new Map<string, TidyItem[]>();
  const leavingKept = new Set<string>();
  for (const k of keptOf(l, layout)) {
    if (k.area !== pipe.area) continue;
    const ghost = pipe.tiles.find((g) => layout.ghosts.includes(g) && (k.key === `place:${g.front.id}` || (g.stack && k.key === `stack:${g.stack}`)));
    if (ghost) {
      leavingKept.add(k.key);
      continue;
    }
    const w = k.key.startsWith("tool:") ? layout.windows.find((x) => `tool:${x.id}` === k.key) : undefined;
    const owner = w?.win.session ? pipe.tiles.find((t) => [...t.members, ...(t.closed ?? [])].some((m) => m.id === w.win.session)) : undefined;
    const r = owner ? k.at(none) : null;
    if (!owner || !r) continue;
    leavingKept.add(k.key);
    windowsOf.set(owner.key, [...(windowsOf.get(owner.key) ?? []), { key: k.key, rect: r, move: k.to }]);
  }
  const itemOf = (t: Tile): TidyItem => ({ key: t.key, rect: t.rect, move: (p, r) => (t.stack ? put(p.stacks, t.stack, { active: own(p.stacks, t.stack)?.active ?? t.front.id, placement: r }) : put(p.workspaces, t.front.id, r)) });
  const fanning = along.bands.some((band) => fans(band.filter(Boolean)));
  const left = snapUp(Math.max(area.rect.x + AREA_PAD, Math.min(...pipe.tiles.map((t) => t.rect.x))));
  const tilesTop = snapUp(Math.max(area.rect.y + AREA_HEADER + (fanning ? STAGE_CAPTION_H : 0), Math.min(...pipe.tiles.map((t) => t.rect.y))));
  const p = emptyPatch();
  const placed: Rect[] = [];
  placeBands(along, windowsOf, itemOf, (it, x, y) => {
    const r = { ...it.rect, x, y };
    placed.push(r);
    if (r.x !== it.rect.x || r.y !== it.rect.y) it.move(p, r);
  }, left, fanning ? tilesTop - STAGE_CAPTION_H : tilesTop);
  const leaving = new Set(layout.tiles.filter((t) => members.has(t)).map((t) => t.key));
  pushFrom(p, l, layout, pipe.area, placed, leaving, leavingKept);
  return { patch: finish(p), moves: [], after: null, note: `Laid out the pipeline in ${titleOf(pipe.area)} along its wires` };
}

/** Where a step can be put in between two stage columns (stageGaps): handoff `wire` from `from` to `to`, at (`x`, `y`). */
export interface StageGap {
  area: string;
  wire: string;
  from: string;
  to: string;
  x: number;
  y: number;
}

/**
 * The places a step can be inserted in a pipeline laid out in stage columns: for each handoff from a workspace in one
 * column to one in the next, the middle of the gap between those columns, level with the middle of the one it goes to
 * (a column that fans out has one for each). Only while the chain's columns still line up, as stageCaptions has them.
 */
export function stageGaps(layout: Pick<ResolvedLayout, "areas" | "tiles" | "ghosts">, wires: readonly (TidyWire & { id: string })[]): StageGap[] {
  const out: StageGap[] = [];
  for (const a of layout.areas) {
    if (a.rect.collapsed) continue;
    const tiles = [...layout.tiles, ...layout.ghosts].filter((t) => t.area === a.key && !t.hidden).sort((x, y) => madeAt(x) - madeAt(y) || x.rect.y - y.rect.y || x.rect.x - y.rect.x);
    const tileOf = new Map<string, Tile>();
    for (const t of tiles) for (const s of [...t.members, ...(t.closed ?? [])]) tileOf.set(s.id, t);
    for (const band of alongWires(tiles, wires)?.bands ?? []) {
      const columns = band.filter((c) => c?.length);
      const lined = columns.every((c, i) => c.every((t) => Math.abs(t.rect.x - c[0].rect.x) < 1) && (i === 0 || c[0].rect.x > Math.max(...columns[i - 1].map((t) => t.rect.x + t.rect.w))));
      if (!lined || columns.length < 2) continue;
      const colOf = new Map<Tile, number>();
      columns.forEach((c, i) => c.forEach((t) => colOf.set(t, i)));
      for (const w of wires) {
        if (w.type !== "handoff") continue;
        const from = tileOf.get(w.from);
        const to = tileOf.get(w.to);
        const i = from ? colOf.get(from) : undefined;
        if (!from || !to || i === undefined || colOf.get(to) !== i + 1) continue;
        const right = Math.max(...columns[i].map((t) => t.rect.x + t.rect.w));
        out.push({ area: a.key, wire: w.id, from: w.from, to: w.to, x: (right + to.rect.x) / 2, y: to.rect.y + to.rect.h / 2 });
      }
    }
  }
  return out;
}

/**
 * An area's workspaces and ghosts (`tiles`, in the order they were made) along `wires` (earliest first), for Tidy; null
 * when none runs between two of them. A stack is one: a wire to any of its tabs is a wire to it, and one between two
 * of its tabs runs nowhere. A shared worktree's terminal goes `under` its agent (the first wire's, when there are
 * several), and its wires are its agent's. Tiles any wire joins, whatever its type, are one chain, a `band`; its
 * columns are layers by the longest path of handoffs into each. A feedback or context wire joins but never orders, and
 * a handoff that would close a loop of handoffs is passed over. In a column, a tile goes by the highest of the
 * tiles handing off to it, then as it was made. `wired` is every tile placed so, terminals included.
 */
function alongWires(tiles: readonly Tile[], wires: readonly TidyWire[]): { bands: Tile[][][]; under: Map<Tile, Tile[]>; wired: Set<Tile> } | null {
  const tileOf = new Map<string, Tile>();
  for (const t of tiles) for (const s of [...t.members, ...(t.closed ?? [])]) tileOf.set(s.id, t);
  const inside = wires.flatMap((w) => {
    const a = tileOf.get(w.from);
    const b = tileOf.get(w.to);
    return a && b && a !== b ? [{ a, b, type: w.type }] : [];
  });
  if (!inside.length) return null;
  const host = new Map<Tile, Tile>();
  const under = new Map<Tile, Tile[]>();
  for (const { a, b, type } of inside) {
    if (type !== "worktree" || host.has(a) || host.has(b) || under.has(b)) continue;
    host.set(b, a);
    under.set(a, [...(under.get(a) ?? []), b]);
  }
  const up = (t: Tile) => host.get(t) ?? t;
  // each chain by one of its tiles: two joined, the second's chain becomes the first's
  const joined = new Map<Tile, Tile>();
  const chainOf = (t: Tile): Tile => {
    const j = joined.get(t);
    return j ? chainOf(j) : t;
  };
  const into = new Map<Tile, Tile[]>();
  const outOf = new Map<Tile, Tile[]>();
  const reaches = (from: Tile, to: Tile, seen = new Set<Tile>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (outOf.get(from) ?? []).some((n) => reaches(n, to, seen));
  };
  const nodes = new Set<Tile>();
  for (const e of inside) {
    const a = up(e.a);
    const b = up(e.b);
    nodes.add(a).add(b);
    if (chainOf(a) !== chainOf(b)) joined.set(chainOf(b), chainOf(a));
    if (e.type !== "handoff" || reaches(b, a)) continue;
    outOf.set(a, [...(outOf.get(a) ?? []), b]);
    into.set(b, [...(into.get(b) ?? []), a]);
  }
  const layer = new Map<Tile, number>();
  const layerOf = (t: Tile): number => {
    const known = layer.get(t);
    if (known !== undefined) return known;
    const n = Math.max(0, ...(into.get(t) ?? []).map((u) => layerOf(u) + 1));
    layer.set(t, n);
    return n;
  };
  // a chain's place among the others is its first tile's, a tile's in its column first its sources' rows
  const made = new Map(tiles.map((t, i) => [t, i]));
  const chains = new Map<Tile, Tile[][]>();
  for (const t of tiles.filter((x) => nodes.has(x)).sort((a, b) => layerOf(a) - layerOf(b))) {
    const columns = chains.get(chainOf(t)) ?? [];
    chains.set(chainOf(t), columns);
    (columns[layerOf(t)] ??= []).push(t);
  }
  const row = new Map<Tile, number>();
  const by = (t: Tile) => {
    const from = into.get(t);
    return from ? Math.min(...from.map((u) => row.get(u)!)) : 0;
  };
  for (const columns of chains.values()) {
    for (const column of columns) {
      column.sort((a, b) => by(a) - by(b) || made.get(a)! - made.get(b)!);
      column.forEach((t, i) => row.set(t, i));
    }
  }
  return { bands: [...chains.values()], under, wired: new Set([...nodes, ...host.keys()]) };
}

/**
 * An empty area for group `key`, right of everything and level with the topmost area, as resolveLayout makes one for a
 * group with no area: what a template's steps are laid out in (W9), as not-started steps make no area of their own.
 * Null when `key` has one already.
 */
export function newAreaPatch(l: Landscape, key: string, repo: { path: string; base: string | null } | null, cell: Cell = CELL_ESTIMATE): LandscapePatch | null {
  if (own(l.areas, key)) return null;
  const areas = Object.values(l.areas);
  const all = boundsOf([...areas, ...Object.values(l.workspaces), ...Object.values(l.stacks).map((s) => s.placement), ...Object.values(l.ghosts).map((g) => g.placement), ...extraPlaces(l)]);
  const m = presetSize("agent", "M", cell);
  const area: Area = { x: all ? all.x + all.w + AREA_GAP : 0, y: boundsOf(areas)?.y ?? 0, w: 2 * AREA_PAD + m.w, h: AREA_HEADER + AREA_PAD, repos: repo ? [repo] : [] };
  return { areas: { [key]: area } };
}

/**
 * Tidy area `key` (T, or its ⋯): everything in it packed in rows, left to right in the order it was made, from its
 * top-left inside the padding and under the header, each row as wide as the area is inside. Its workspaces and ghosts
 * go by when their sessions were made; a workspace's tool window right after it; then what else it keeps (its own
 * windows and cards, the places of sessions not shown) as they lie, in reading order. The area then fits what it
 * holds: smaller, or larger, when it pushes what's in its way aside as any area that grows does. Refused while it's
 * locked or collapsed. `undoOf(l, patch)` puts every place back.
 *
 * Given `only` (a lay-out's sessions), it's refused unless every workspace and ghost in the area is one of them, they're
 * joined by wires, and the area keeps nothing else: a lay-out into an area there already tidies only its own.
 *
 * Given `wires` (the book's, earliest first), it lays the area out along those between two of its workspaces or ghosts
 * instead, with a note saying so (alongWires): each chain left to right in columns WIRED_COLUMN_GAP apart, one
 * chain under another, its workspaces' tool windows under them; then, below, in rows as above, what no wire joins and
 * what else it keeps. A wire to another area's workspace is passed over. With none inside it, it's laid out in rows as
 * above.
 */
export function planTidy(l: Landscape, layout: ResolvedLayout, key: string, titleOf: (key: string) => string, wires: readonly TidyWire[] = [], opts: { only?: ReadonlySet<string> } = {}): AreaPlan {
  const refused = tidyRefusal(layout, key, titleOf);
  if (refused) return { refused };
  const area = layout.areas.find((a) => a.key === key)!;
  const kept = keptOf(l, layout).filter((k) => k.area === key);
  const none = emptyPatch();
  type Item = TidyItem;
  const tiles = [...layout.tiles, ...layout.ghosts].filter((t) => t.area === key).sort((a, b) => madeAt(a) - madeAt(b) || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const windowsOf = new Map<string, Item[]>();
  const rest: Item[] = [];
  for (const k of kept) {
    const r = k.at(none);
    if (!r || layout.ghosts.some((g) => g.area === key && (k.key === `place:${g.front.id}` || (g.stack && k.key === `stack:${g.stack}`)))) continue;
    const item = { key: k.key, rect: r, move: k.to };
    const w = k.key.startsWith("tool:") ? layout.windows.find((x) => `tool:${x.id}` === k.key) : undefined;
    const owner = w?.win.session ? tiles.find((t) => [...t.members, ...(t.closed ?? [])].some((m) => m.id === w.win.session)) : undefined;
    if (owner) windowsOf.set(owner.key, [...(windowsOf.get(owner.key) ?? []), item]);
    else rest.push(item);
  }
  const itemOf = (t: Tile): Item => ({ key: t.key, rect: t.rect, move: (p, r) => (t.stack ? put(p.stacks, t.stack, { active: own(p.stacks, t.stack)?.active ?? t.front.id, placement: r }) : put(p.workspaces, t.front.id, r)) });
  const along = alongWires(tiles, wires);
  const items: Item[] = [];
  for (const t of tiles) {
    if (along?.wired.has(t)) continue;
    items.push(itemOf(t));
    items.push(...(windowsOf.get(t.key) ?? []));
  }
  items.push(...rest.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x));
  if (!items.length && !along) return { refused: `${titleOf(key)} has nothing in it to tidy` };
  // `only`: a lay-out's sessions, tidied only when the area holds nothing else of its own, which would move
  if (opts.only && (!along || items.length || tiles.some((t) => ![...t.members, ...(t.closed ?? [])].some((m) => opts.only!.has(m.id)))))
    return { refused: `${titleOf(key)} holds more than what was laid out, which Tidy would move` };
  const left = snapUp(area.rect.x + AREA_PAD);
  const top = snapUp(area.rect.y + AREA_HEADER);
  const p = emptyPatch();
  const placed: Rect[] = [];
  const keys = new Set<string>();
  const place = (it: Item, x: number, y: number) => {
    const r = { ...it.rect, x, y };
    placed.push(r);
    keys.add(it.key);
    if (r.x !== it.rect.x || r.y !== it.rect.y) it.move(p, r);
  };
  let y = along ? placeBands(along, windowsOf, itemOf, place, left, top) : top;
  const wide = Math.max(0, ...placed.map((r) => r.x + r.w - left));
  const inner = Math.max(area.rect.w - 2 * AREA_PAD, wide, ...items.map((i) => i.rect.w));
  let x = left;
  let rowH = 0;
  for (const it of items) {
    if (x > left && x + it.rect.w > left + inner) {
      x = left;
      y = snapUp(y + rowH + GAP);
      rowH = 0;
    }
    place(it, x, y);
    x = snapUp(x + it.rect.w + GAP);
    rowH = Math.max(rowH, it.rect.h);
  }
  const b = boundsOf(placed)!;
  const w = snapUp(b.x + b.w + AREA_PAD - area.rect.x);
  const h = snapUp(b.y + b.h + AREA_PAD - area.rect.y);
  if (w !== area.rect.w || h !== area.rect.h) {
    const grown = { ...area.rect, w, h };
    // larger either way: what's in its way is pushed aside; only smaller: nothing else moves
    if (w > area.rect.w || h > area.rect.h) growArea(p, l, layout, key, grown, keys);
    else put(p.areas, key, { w, h });
  }
  return { patch: finish(p), moves: [], after: null, ...(along ? { note: `Tidied ${titleOf(key)} along its wires` } : {}) };
}

/**
 * What forgetting sessions `ids` lets go of on the landscape: each one's place, and the place of a stack whose every
 * tab, running or closed, is one of them. They can't come back, so a place left behind would only take room nobody
 * sees (it would pile up as sessions are forgotten). Read from the layout before they go: a stack's tabs are in it
 * until then. Null when nothing is kept for them.
 */
export function forgetPatch(l: Landscape, layout: Pick<ResolvedLayout, "tiles" | "ghosts">, ids: readonly string[]): LandscapePatch | null {
  const p = emptyPatch();
  for (const id of ids) if (own(l.workspaces, id)) put(p.workspaces, id, null);
  for (const t of [...layout.tiles, ...layout.ghosts]) {
    if (t.stack && own(l.stacks, t.stack) && [...t.members, ...(t.closed ?? [])].every((s) => ids.includes(s.id))) put(p.stacks, t.stack, null);
  }
  return finish(p);
}
