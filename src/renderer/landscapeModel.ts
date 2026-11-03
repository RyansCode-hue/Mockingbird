/**
 * The landscape's view as pure functions (docs/landscape.md, phase 1 S2): the
 * camera, where each session's workspace sits, the nearest workspace in a
 * direction, how a window keeps its copy of the landscape in step with the
 * main process, and whether the grid's layout should be read in now.
 */
import type { SessionInfo } from "../shared/types";
import {
  AREA_GAP,
  AREA_HEADER,
  AREA_PAD,
  CELL_ESTIMATE,
  LOOSE_GROUP,
  applyPatch,
  areaKeyOf,
  boundsOf,
  fitAreaTo,
  fitView,
  MAX_COORD,
  kindOf,
  own,
  placeNew,
  presetSize,
  put,
  stackKeyOf,
  type Area,
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

const tileKind = (members: readonly SessionInfo[]): WorkspaceKind => (members.some((s) => kindOf(s) === "agent") ? "agent" : "terminal");

/**
 * Where every session's workspace sits: its stored placement (a stack's, for
 * a sub-group's sessions), and for one without, a spot from placeNew: in its
 * area, grown to hold it, or added beside the others when its group has none
 * yet; loose, just left of the first area. Everything stored stays taken,
 * ghosts and sessions waiting to be resumed included, so a session relaunched
 * under its id finds its place free. `sessions` are the ones shown, in order.
 */
export function resolveLayout(l: Landscape, sessions: readonly SessionInfo[], cell: Cell = CELL_ESTIMATE): ResolvedLayout {
  const groups = new Map<string, { area: string; stack: string | null; members: SessionInfo[] }>();
  for (const s of sessions) {
    const stack = stackKeyOf(s);
    const key = stack ? `ws:${stack}` : s.id;
    const g = groups.get(key);
    if (g) g.members.push(s);
    else groups.set(key, { area: areaKeyOf(s), stack, members: [s] });
  }

  const areas = new Map<string, Area>(Object.entries(l.areas));
  const occupied: Rect[] = [...Object.values(l.workspaces), ...Object.values(l.stacks).map((s) => s.placement), ...Object.values(l.ghosts).map((g) => g.placement)];
  const patch: Required<Pick<LandscapePatch, "workspaces" | "areas" | "stacks">> = { workspaces: {}, areas: {}, stacks: {} };

  /** A new area for `key`, right of everything: a group made since the grid's layout was read in. */
  const addArea = (key: string): Area => {
    const all = boundsOf([...areas.values(), ...occupied]);
    const top = boundsOf([...areas.values()])?.y ?? 0;
    const m = presetSize("agent", "M", cell);
    const a: Area = { x: all ? all.x + all.w + AREA_GAP : 0, y: top, w: 2 * AREA_PAD + m.w, h: AREA_HEADER + AREA_PAD, repos: [] };
    areas.set(key, a);
    put(patch.areas, key, a);
    return a;
  };
  const firstArea = (): Area | null => [...areas.values()].sort((a, b) => a.y - b.y || a.x - b.x)[0] ?? null;

  const tiles: Tile[] = [];
  for (const [key, g] of groups) {
    const stored = g.stack ? own(l.stacks, g.stack) : undefined;
    const front = (stored && g.members.find((s) => s.id === stored.active)) || g.members[0];
    // a sub-group with no stack yet sits where its first member did on its own
    let rect = stored?.placement ?? (g.stack ? g.members.map((s) => own(l.workspaces, s.id)).find(Boolean) : own(l.workspaces, front.id));
    const placed = !rect;
    if (!rect) {
      const size = presetSize(tileKind(g.members), "M", cell);
      if (g.area === LOOSE_GROUP) rect = placeNew(size, [...occupied, ...areas.values()], null, firstArea());
      else {
        const area = areas.get(g.area) ?? addArea(g.area);
        rect = placeNew(size, occupied, area);
        const grown = fitAreaTo(area, [rect]);
        if (grown !== area) {
          areas.set(g.area, grown);
          put(patch.areas, g.area, Object.hasOwn(l.areas, g.area) ? { w: grown.w, h: grown.h } : grown);
        }
      }
      occupied.push(rect);
    }
    if (g.stack && !stored) put(patch.stacks, g.stack, { active: front.id, placement: rect });
    else if (!g.stack && placed) put(patch.workspaces, front.id, rect);
    tiles.push({ key, area: g.area, stack: g.stack, members: g.members, front, rect });
  }
  const out: LandscapePatch = {};
  if (Object.keys(patch.workspaces).length) out.workspaces = patch.workspaces;
  if (Object.keys(patch.areas).length) out.areas = patch.areas;
  if (Object.keys(patch.stacks).length) out.stacks = patch.stacks;
  return { tiles, areas: [...areas].map(([key, rect]) => ({ key, rect })), patch: Object.keys(out).length ? out : null };
}

/** Everything a fit shows: the areas and the workspaces. */
export const contentRects = (r: ResolvedLayout): Rect[] => [...r.areas.map((a) => a.rect), ...r.tiles.map((t) => t.rect)];

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
