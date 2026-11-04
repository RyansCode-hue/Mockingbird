/**
 * The landscape's view as pure functions (docs/landscape.md, phase 1 S2): the
 * camera, where each session's workspace sits, the nearest workspace in a
 * direction, how a window keeps its copy of the landscape in step with the
 * main process, and whether the grid's layout should be read in now.
 */
import { isWorkItemId, splitGroupKey, type SessionInfo } from "../shared/types";
import {
  AREA_GAP,
  AREA_HEADER,
  AREA_PAD,
  CELL_ESTIMATE,
  GAP,
  LOOSE_GROUP,
  applyPatch,
  areaAround,
  areaKeyOf,
  boundsOf,
  clearOf,
  fitAreaTo,
  fixedInWay,
  fitView,
  MAX_COORD,
  kindOf,
  overlaps,
  own,
  placeNew,
  presetSize,
  pushAside,
  put,
  shifted,
  snap,
  snapUp,
  stackKeyOf,
  within,
  type Area,
  type AreaRepo,
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
} from "../shared/landscape";

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
}

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

export interface ResolvedLayout {
  tiles: Tile[];
  areas: AreaView[];
  /** Places made here for workspaces that had none, and areas added or grown to hold them; null when there were none. */
  patch: LandscapePatch | null;
}

/**
 * A group this window renamed (`from` → `to`, either a top-level group or a sub-group) whose change hasn't reached
 * everything yet: until the landscape has re-keyed it and no session shown is under `from`, resolveLayout keeps its
 * area and stacks under whichever key the landscape holds them.
 */
export interface PendingRename {
  from: string;
  to: string;
}

/** Whether a pending rename is over: the landscape holds nothing under `from` any more, and no session shown is in it. */
export function renameSettled(r: PendingRename, l: Landscape, sessions: readonly SessionInfo[]): boolean {
  const under = (k: string) => k === r.from || k.startsWith(`${r.from}/`);
  return !Object.keys(l.areas).some(under) && !Object.keys(l.stacks).some(under) && !sessions.some((s) => under(s.taskGroup ?? LOOSE_GROUP));
}

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
 * grows to hold a new workspace pushes the areas in its way aside (pushAside),
 * theirs with them, every place stored inside them included. A locked area
 * never moves: one that grows into it moves clear of everything instead.
 *
 * `renames` are this window's renames still on their way (PendingRename).
 */
export function resolveLayout(l: Landscape, sessions: readonly SessionInfo[], cell: Cell = CELL_ESTIMATE, renames: readonly PendingRename[] = []): ResolvedLayout {
  /**
   * A group key under a rename still on its way: the key the landscape holds it under, the old one or the new. The
   * session list and the landscape's re-keying (main's renameAreaPatch) arrive one after the other, and a teammate's
   * room sessions take the new name later still, so for a while the two disagree; formed anew, the group's area would
   * be pushed clear of its own old one, and that place saved over the re-keyed one.
   */
  const held = (key: string, has: (k: string) => boolean): string => {
    if (has(key)) return key;
    for (const { from, to } of renames) {
      const other = key === to || key.startsWith(`${to}/`) ? from + key.slice(to.length) : key === from || key.startsWith(`${from}/`) ? to + key.slice(from.length) : null;
      if (other !== null && has(other)) return other;
    }
    return key;
  };
  const groups = new Map<string, { area: string; stack: string | null; members: SessionInfo[] }>();
  for (const s of sessions) {
    const sk = stackKeyOf(s);
    const stack = sk && held(sk, (k) => Object.hasOwn(l.stacks, k));
    const key = stack ? `ws:${stack}` : s.id;
    const g = groups.get(key);
    if (g) g.members.push(s);
    else groups.set(key, { area: held(areaKeyOf(s), (k) => Object.hasOwn(l.areas, k)), stack, members: [s] });
  }
  /** The sessions and stacks shown: a place stored for any other (a session waiting to be resumed) stays taken, and moves with its area. */
  const shownIds = new Set(sessions.map((s) => s.id));
  const shownStacks = new Set([...groups.values()].map((g) => g.stack).filter((k): k is string => !!k));

  const areas = new Map<string, Area>(Object.entries(l.areas));
  const patch: Required<Pick<LandscapePatch, "workspaces" | "areas" | "stacks" | "ghosts">> = { workspaces: {}, areas: {}, stacks: {}, ghosts: {} };
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

  const live = new Set([...groups.values()].map((g) => g.area));
  for (const key of live) {
    if (key === LOOSE_GROUP || areas.has(key)) continue;
    const keys = [...groups].filter(([, g]) => g.area === key).map(([k]) => k);
    const rects = keys.map((k) => stored.get(k)).filter((r): r is Rect => !!r);
    const around = areaAround(rects);
    if (!around) continue;
    const { dx, dy } = clearOf(around, [...areas.values()]);
    const a: Area = { ...shifted(around, dx, dy), repos: reposOf(keys.flatMap((k) => groups.get(k)!.members)) };
    setArea(key, a, a);
    for (const k of keys) shiftTile(k, dx, dy);
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

  const grew = new Set<string>();
  const tiles: Tile[] = [];
  const placed = new Set<string>();
  for (const [key, g] of groups) {
    let rect = stored.get(key);
    if (!rect) {
      const size = presetSize(tileKind(g.members), "M", cell);
      if (g.area === LOOSE_GROUP) rect = placeNew(size, [...occupied, ...areas.values()], null, firstArea());
      else {
        const area = areas.get(g.area) ?? addArea(g.area);
        rect = placeNew(size, occupied, area);
        const grown = fitAreaTo(area, [rect]);
        if (grown !== area) {
          setArea(g.area, grown, { w: grown.w, h: grown.h });
          grew.add(g.area);
        }
      }
      occupied.push(rect);
      stored.set(key, rect);
      placed.add(key);
    }
    tiles.push({ key, area: g.area, stack: g.stack, members: g.members, front: fronts.get(key)!, rect, hidden: false });
  }

  /** Area `k` moved by `dx`, `dy`, with everything in it: its workspaces, its ghosts, and the places stored inside it for sessions not shown. */
  const moveAreaBy = (k: string, dx: number, dy: number) => {
    const was = areas.get(k)!;
    const a = shifted(was, dx, dy);
    setArea(k, a, { x: a.x, y: a.y });
    for (const t of tiles) if (t.area === k) shiftTile(t.key, dx, dy);
    for (const [id, gh] of Object.entries(l.ghosts)) {
      if (areaKeyOf({ taskGroup: gh.group }) === k) put(patch.ghosts, id, { ...gh, placement: shifted(own(patch.ghosts, id)?.placement ?? gh.placement, dx, dy) });
    }
    for (const [id, r] of Object.entries(l.workspaces)) {
      const at = own(patch.workspaces, id) ?? r;
      if (!shownIds.has(id) && within(at, was)) put(patch.workspaces, id, shifted(at, dx, dy));
    }
    for (const [sk, st] of Object.entries(l.stacks)) {
      const at = own(patch.stacks, sk)?.placement ?? st.placement;
      if (!shownStacks.has(sk) && within(at, was)) put(patch.stacks, sk, { ...st, placement: shifted(at, dx, dy) });
    }
  };
  // an area that grew moves the ones in its way aside, with everything in them; a locked one stays where it is, and an
  // area that grew into one moves clear of everything instead
  const locked = new Set([...areas].filter(([, a]) => a.locked).map(([k]) => k));
  for (const key of grew) {
    const rects: Record<string, Rect> = {};
    for (const [k, a] of areas) put(rects, k, a);
    if (fixedInWay(rects, key, locked)) {
      const { dx, dy } = clearOf(areas.get(key)!, [...areas].filter(([k]) => k !== key).map(([, a]) => a));
      moveAreaBy(key, dx, dy);
      continue;
    }
    for (const [k, m] of Object.entries(pushAside(rects, key, AREA_GAP, locked))) moveAreaBy(k, m.dx, m.dy);
  }

  for (const t of tiles) {
    const g = groups.get(t.key)!;
    t.rect = stored.get(t.key)!;
    t.hidden = areas.get(t.area)?.collapsed === true;
    const save = placed.has(t.key) || movedTiles.has(t.key);
    if (g.stack && (!own(l.stacks, g.stack) || movedTiles.has(t.key))) put(patch.stacks, g.stack, { active: t.front.id, placement: t.rect });
    else if (!g.stack && save) put(patch.workspaces, t.front.id, t.rect);
  }
  const out: LandscapePatch = {};
  for (const k of ["workspaces", "areas", "stacks", "ghosts"] as const) if (Object.keys(patch[k]).length) Object.assign(out, { [k]: patch[k] });
  return { tiles, areas: [...areas].map(([key, rect]) => ({ key, rect })), patch: Object.keys(out).length ? out : null };
}

/** How big a collapsed area's pill counts for fitting the view and the minimap, in landscape px at 100%. */
export const PILL_SIZE: Size = { w: 320, h: 48 };

/** What an area takes on the landscape as drawn: its rectangle, or its pill while it's collapsed. */
export const areaShown = (a: AreaView): Rect => (a.rect.collapsed ? { x: a.rect.x, y: a.rect.y, ...PILL_SIZE } : a.rect);

/** Everything a fit shows: the areas (a collapsed one's pill) and the workspaces drawn. */
export const contentRects = (r: ResolvedLayout): Rect[] => [...r.areas.map(areaShown), ...r.tiles.filter((t) => !t.hidden).map((t) => t.rect)];

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
}

export function areaCounts(tiles: readonly Tile[], key: string): AreaCounts {
  const c: AreaCounts = { working: 0, waiting: 0, idle: 0, dead: 0, workspaces: 0 };
  for (const t of tiles) {
    if (t.area !== key) continue;
    c.workspaces++;
    for (const s of t.members) if (!s.room?.remote) c[s.status]++;
  }
  return c;
}

/**
 * An area's summary line: "Shared room with Nick · 1 waiting · 2 working · 5 workspaces". `shared` leads it for a
 * room's area; `workspaces: false` leaves the count out (the header bar, whose workspaces are under it).
 */
export function areaSummary(c: AreaCounts, o: { shared?: string | null; workspaces?: boolean } = {}): string {
  const parts = [o.shared ?? null, c.waiting ? `${c.waiting} waiting` : null, c.working ? `${c.working} working` : null, c.dead ? `${c.dead} exited` : null];
  if (o.workspaces !== false) parts.push(`${c.workspaces} workspace${c.workspaces === 1 ? "" : "s"}`);
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

/** What the minimap draws: each area as it's shown (a collapsed one's pill), then each workspace in no area at its place. */
export function minimapBlocks(r: ResolvedLayout): MinimapBlock[] {
  const areas = new Set(r.areas.map((a) => a.key));
  return [
    ...r.areas.map((a) => ({ key: a.key, loose: false, rect: areaShown(a) })),
    ...r.tiles.filter((t) => !areas.has(t.area) && !t.hidden).map((t) => ({ key: t.key, loose: true, rect: t.rect })),
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

type FullPatch = Required<Pick<LandscapePatch, "workspaces" | "areas" | "stacks" | "ghosts">>;
const emptyPatch = (): FullPatch => ({ workspaces: {}, areas: {}, stacks: {}, ghosts: {} });
const finish = (p: FullPatch): LandscapePatch | null => {
  const out: LandscapePatch = {};
  for (const k of ["workspaces", "areas", "stacks", "ghosts"] as const) if (Object.keys(p[k]).length) Object.assign(out, { [k]: p[k] });
  return Object.keys(out).length ? out : null;
};
/**
 * What puts back what `patch` changed in `l`: each workspace, area, stack and ghost it touched as `l` had it, or gone
 * where `l` had none. Limited to `ids` (session ids), only those sessions' own places: what a gesture takes back for
 * the sessions whose group couldn't be set, when others' was.
 */
export function undoOf(l: Landscape, patch: LandscapePatch, ids?: readonly string[]): LandscapePatch | null {
  const p = emptyPatch();
  for (const k of ["workspaces", "areas", "stacks", "ghosts"] as const) {
    const from = patch[k];
    if (!from || (ids && k !== "workspaces")) continue;
    const had = l[k] as Record<string, unknown>;
    for (const key of Object.keys(from)) if (!ids || ids.includes(key)) put(p[k] as Record<string, unknown>, key, own(had, key) ?? null);
  }
  return finish(p);
}

const isTheirs = (s: SessionInfo) => !!s.room?.remote;
const subOf = (t: Tile) => splitGroupKey(t.stack!).sub!;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The sessions and stacks a layout shows. A place stored for any other (a session waiting to be resumed) stays taken, and moves with the area it's in. */
function shownIn(layout: ResolvedLayout): { ids: Set<string>; stacks: Set<string> } {
  const ids = new Set<string>();
  const stacks = new Set<string>();
  for (const t of layout.tiles) {
    for (const s of t.members) ids.add(s.id);
    if (t.stack) stacks.add(t.stack);
  }
  return { ids, stacks };
}

/** The places stored for sessions and stacks the layout doesn't show: taken, as resolveLayout keeps them. */
const unshownPlaces = (l: Landscape, layout: ResolvedLayout): Rect[] => {
  const shown = shownIn(layout);
  return [...Object.entries(l.workspaces).filter(([id]) => !shown.ids.has(id)).map(([, r]) => r), ...Object.entries(l.stacks).filter(([k]) => !shown.stacks.has(k)).map(([, s]) => s.placement)];
};

/**
 * Move area `key` by `dx`, `dy` in `p`, with everything in it: its workspaces (a collapsed one's too, never those in
 * `leaving`), its ghosts, and the places stored inside it for sessions and stacks not shown, so a session resumed
 * later comes back inside it.
 */
function moveArea(p: FullPatch, l: Landscape, layout: ResolvedLayout, key: string, dx: number, dy: number, leaving: ReadonlySet<string> = new Set()): void {
  const a = layout.areas.find((x) => x.key === key)!.rect;
  const was = own(p.areas, key);
  put(p.areas, key, { ...(was ?? {}), x: (was?.x ?? a.x) + dx, y: (was?.y ?? a.y) + dy });
  for (const t of layout.tiles) {
    if (t.area !== key || leaving.has(t.key)) continue;
    const r = shifted((t.stack ? own(p.stacks, t.stack)?.placement : own(p.workspaces, t.front.id)) ?? t.rect, dx, dy);
    if (t.stack) put(p.stacks, t.stack, { active: t.front.id, placement: r });
    else put(p.workspaces, t.front.id, r);
  }
  for (const [id, g] of Object.entries(l.ghosts)) {
    if (areaKeyOf({ taskGroup: g.group }) !== key) continue;
    put(p.ghosts, id, { ...g, placement: shifted(own(p.ghosts, id)?.placement ?? g.placement, dx, dy) });
  }
  const shown = shownIn(layout);
  for (const [id, r] of Object.entries(l.workspaces)) {
    if (!shown.ids.has(id) && within(r, a)) put(p.workspaces, id, shifted(own(p.workspaces, id) ?? r, dx, dy));
  }
  for (const [sk, st] of Object.entries(l.stacks)) {
    if (!shown.stacks.has(sk) && within(st.placement, a)) put(p.stacks, sk, { ...st, placement: shifted(own(p.stacks, sk)?.placement ?? st.placement, dx, dy) });
  }
}

/**
 * Area `key` now `grown`: the areas in its way pushed aside (pushAside), with everything in them, but not the
 * workspaces in `leaving`, which are moving into it and have their places in `p` already. A locked area doesn't move:
 * growing into one is refused, with the locked area's key returned; null once it's done.
 */
function growArea(p: FullPatch, l: Landscape, layout: ResolvedLayout, key: string, grown: Area, leaving: ReadonlySet<string>): string | null {
  const rects: Record<string, Rect> = {};
  for (const a of layout.areas) put(rects, a.key, a.key === key ? grown : a.rect);
  const locked = new Set(layout.areas.filter((a) => a.rect.locked).map((a) => a.key));
  const blocked = fixedInWay(rects, key, locked);
  if (blocked) return blocked;
  put(p.areas, key, { ...(own(p.areas, key) ?? {}), w: grown.w, h: grown.h });
  for (const [k, m] of Object.entries(pushAside(rects, key, AREA_GAP, locked))) moveArea(p, l, layout, k, m.dx, m.dy, leaving);
  return null;
}
/** Why a growth into a locked area is refused. */
const lockedInWay = (titleOf: (key: string) => string, locked: string, key: string) => `${titleOf(locked)} is locked, so ${titleOf(key)} can't grow into its space: drop it further in, or unlock ${titleOf(locked)}`;

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
    const occupied = [...layout.tiles.filter((t) => !moving.has(t.key)).map((t) => t.rect), ...unshownPlaces(l, layout), ...Object.values(l.ghosts).map((g) => g.placement)];
    let area: Area = target.rect;
    for (const t of tiles) {
      const r = placeNew({ w: t.rect.w, h: t.rect.h }, occupied, area);
      occupied.push(r);
      area = fitAreaTo(area, [r]);
      place(t, r);
    }
    const blocked = area !== target.rect ? growArea(p, l, layout, key, area, moving) : null;
    if (blocked) return { refused: lockedInWay(titleOf, blocked, key) };
  } else {
    const around = areaAround(tiles.map((t) => t.rect))!;
    const { dx, dy } = clearOf(around, layout.areas.map((a) => a.rect));
    // the repos its workspaces work in, with the base branch their areas had for each
    const bases = new Map(layout.areas.flatMap((a) => a.rect.repos.map((r): [string, string | null] => [r.path, r.base])));
    const repos = [...new Set(tiles.flatMap((t) => t.members.map((s) => s.repoPath).filter((x): x is string => !!x)))].map((path) => ({ path, base: bases.get(path) ?? null }));
    put(p.areas, key, { ...shifted(around, dx, dy), repos });
    for (const t of tiles) if (t.stack || dx || dy) place(t, shifted(t.rect, dx, dy));
  }
  const moves = tiles.flatMap((t) => t.members.filter((s) => !isTheirs(s)).map((s) => ({ id: s.id, group: t.stack ? `${key}/${subOf(t)}` : key })));
  return { patch: finish(p), moves, after: finish(after), note: left.length ? left.join("; ") : undefined };
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
  if (into) {
    r = { ...r, x: Math.max(r.x, snapUp(into.x + AREA_PAD)), y: Math.max(r.y, snapUp(into.y + AREA_HEADER)) };
    const grown = fitAreaTo(into, [r]);
    const blocked = grown !== into ? growArea(p, l, layout, target, grown, new Set([t.key])) : null;
    if (blocked) return { refused: lockedInWay(titleOf, blocked, target) };
  } else {
    // a loose workspace stays out of every area, a collapsed one's whole rectangle too (it's all there once it opens):
    // one dropped partly over an area's edge is moved clear of it
    const { dx, dy } = clearOf(r, layout.areas.map((a) => a.rect), GAP);
    r = shifted(r, dx, dy);
  }
  if (t.stack && crossing) restack(p, after, l, t, target, r);
  else if (t.stack) put(p.stacks, t.stack, { active: t.front.id, placement: r });
  else put(p.workspaces, t.front.id, r);
  const group = target === LOOSE_GROUP ? null : t.stack ? `${target}/${subOf(t)}` : target;
  return { patch: finish(p), moves: crossing ? t.members.map((s) => ({ id: s.id, group })) : [], after: finish(after) };
}

/** Area `key` dragged by `dx`, `dy`: snapped, moved clear of the others (clearOf), its workspaces and ghosts with it. Refused while it's locked. */
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
  moveArea(p, l, layout, key, mx, my);
  return { patch: finish(p), moves: [], after: null };
}
