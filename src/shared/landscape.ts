/**
 * The landscape (docs/landscape.md): the surface workspaces sit on, kept in
 * ~/.mockingbird/landscape.json by the main process. This file holds its data
 * model, the pure geometry the renderer and migration share, and the patches
 * windows send to change it.
 *
 * Coordinates are landscape pixels at 100% zoom, absolute (not relative to an
 * area). Membership is never stored here: a workspace is in an area, or a
 * stack, because its session's group says so; an area's key is that group.
 *
 * Records are keyed by session ids and groups, which can be any string,
 * "constructor" and "__proto__" included: read an entry with own() and set
 * one with put(), never with `r[k]`.
 */
import type { AgentKind, SessionInfo } from "./types";
import { splitGroupKey } from "./types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Size {
  w: number;
  h: number;
}

/**
 * Where one workspace sits. A hint: a session without one is placed by
 * placeNew. Which area it's in is its session's group's to say, never where
 * the rectangle lies.
 */
export type Placement = Rect;

export interface AreaRepo {
  path: string;
  /** The branch new worktrees in the area start from; null until one is chosen (the repo's own default applies). */
  base: string | null;
}

/** A group's rectangle, keyed by its group (the sessions' top-level `taskGroup`). */
export interface Area extends Rect {
  repos: AreaRepo[];
  collapsed?: boolean;
  locked?: boolean;
  /** Phase 2: agents' proposals for workspaces are created without asking. */
  autoCreate?: boolean;
}

/**
 * A sub-group ("top/sub") shown as one card with a tab per member. Its members
 * share this one placement, so moving the stack is one write and a session
 * joining the sub-group lands in it without one.
 */
export interface Stack {
  /** The session whose tab is in front. */
  active: string;
  placement: Placement;
}

/** A closed workspace, left as a faded card where it was. */
export interface Ghost {
  title: string;
  agent: AgentKind | "terminal";
  cwd: string;
  repoPath: string | null;
  branch?: string;
  ticketId?: string;
  /** What Reopen resumes, as SessionInfo.conversation names it. */
  conversation?: { agent: AgentKind; id: string };
  summary?: string;
  /** Its worktree has been removed since: Reopen offers to start fresh. */
  worktreeRemoved?: boolean;
  placement: Placement;
  group: string;
  closedAt: string;
}

/**
 * A tool window (docs/landscape.md, Tools; design O). The first four work on a workspace: its folder (Files, Search)
 * or its worktree (Changes, Run). Artifacts and Chat work on an area (Chat only a room's).
 */
export type ToolKind = "files" | "changes" | "search" | "run" | "artifacts" | "chat";
export const TOOL_KINDS: readonly ToolKind[] = ["files", "changes", "search", "run", "artifacts", "chat"];
/** The tools scoped to a workspace; the others are scoped to an area. */
export const WORKSPACE_TOOLS: readonly ToolKind[] = ["files", "changes", "search", "run"];
export const isWorkspaceTool = (t: ToolKind): boolean => WORKSPACE_TOOLS.includes(t);

/**
 * One tool window. Docked, it sits at the window's edge and follows the selected workspace, so it has no scope or
 * place of its own. Placed, it sits in `area` (null: loose, beside a loose workspace) and moves with it, scoped to
 * `session`'s workspace (the workspace tools) or to `area` itself (Artifacts, Chat). A placed one without a
 * `placement` is placed anew in its area, as a new workspace is (an area merged into another by a rename).
 */
export interface ToolWindow {
  tool: ToolKind;
  docked: boolean;
  session?: string;
  area?: string | null;
  placement?: Placement;
}

/**
 * An artifact placed on the landscape (Place, in the Artifacts window): a card in `area` that opens or mentions
 * `artifact`, one of that area's artifacts (a room's area: the room's). Without a `placement` it's placed anew in its
 * area, as a tool window is.
 */
export interface ArtifactCard {
  area: string;
  artifact: string;
  placement?: Placement;
}

export interface Landscape {
  v: 2;
  /** Set once the grid's layout has been read in. */
  migratedAt?: string;
  tourDone?: boolean;
  /** By session id. A stack's members have none: the stack's placement is theirs. */
  workspaces: Record<string, Placement>;
  /** By top-level group key. */
  areas: Record<string, Area>;
  /** By "top/sub" group key. */
  stacks: Record<string, Stack>;
  /** By the closed session's id. */
  ghosts: Record<string, Ghost>;
  /** By window id, docked ones in the order they were docked. */
  tools: Record<string, ToolWindow>;
  /** By card id. */
  cards: Record<string, ArtifactCard>;
}

/**
 * The landscape's format. A field this version doesn't know makes a file
 * unreadable here, so a version that adds one raises this: an older
 * Mockingbird then leaves the newer file alone instead of dropping the field
 * on its next save.
 *
 * 2 added tool windows and artifact cards (`tools`, `cards`); a version 1 file is read as one with none.
 */
export const LANDSCAPE_VERSION = 2;

export const emptyLandscape = (): Landscape => ({ v: 2, workspaces: {}, areas: {}, stacks: {}, ghosts: {}, tools: {}, cards: {} });

// ---- what a session is on the landscape ---------------------------------------------

/** Workspaces outside every area: today's "ungrouped" bucket. */
export const LOOSE_GROUP = "ungrouped";

/** A session's top-level group: its area's key, or LOOSE_GROUP. */
export const areaKeyOf = (s: Pick<SessionInfo, "taskGroup">): string => splitGroupKey(s.taskGroup ?? LOOSE_GROUP).top;

/** The stack a session is a tab of ("top/sub"), or null when it stands alone. */
export function stackKeyOf(s: Pick<SessionInfo, "taskGroup">): string | null {
  const { top, sub } = splitGroupKey(s.taskGroup ?? LOOSE_GROUP);
  return sub ? `${top}/${sub}` : null;
}

export type WorkspaceKind = "agent" | "terminal";
export const kindOf = (s: Pick<SessionInfo, "shell">): WorkspaceKind => (s.shell ? "terminal" : "agent");

// ---- the grid ----------------------------------------------------------------------------

export const GRID = 8;
/** Between neighbouring workspaces. */
export const GAP = 16;
/** Between areas. */
export const AREA_GAP = 64;
/** An area's inside edge, left, right and bottom. */
export const AREA_PAD = 24;
/** An area's top edge, which holds its header. */
export const AREA_HEADER = 48;

// `+ 0` turns -0 into 0, which JSON and Object.is tell apart; NaN stays NaN, so a bad input still shows
/** `v` on the 8 px grid. */
export const snap = (v: number, step = GRID): number => Math.round(v / step) * step + 0;
/** `v` rounded up to the grid; float error a hair past a grid line stays on it. */
export const snapUp = (v: number): number => Math.ceil(v / GRID - 1e-9) * GRID + 0;
const snapDown = (v: number): number => Math.floor(v / GRID + 1e-9) * GRID + 0;

// ---- sizes ----------------------------------------------------------------------------

export interface TermSize {
  cols: number;
  rows: number;
}
export interface Cell {
  w: number;
  h: number;
}

export type SizePreset = "S" | "M" | "L";
export const SIZE_PRESETS: SizePreset[] = ["S", "M", "L"];
export const DEFAULT_PRESET: SizePreset = "M";

/** Workspace sizes in the terminal's own units: big enough to read a session at 100%. */
export const WORKSPACE_SIZES: Record<WorkspaceKind, Record<SizePreset, TermSize>> = {
  agent: { S: { cols: 110, rows: 32 }, M: { cols: 140, rows: 42 }, L: { cols: 180, rows: 52 } },
  terminal: { S: { cols: 90, rows: 16 }, M: { cols: 120, rows: 24 }, L: { cols: 160, rows: 36 } },
};

/**
 * A terminal cell at the landscape's 12.5 px mono and the terminals' 1.4
 * line height, for sizing before a terminal exists to measure (migration, a
 * new workspace's first placement). xterm measures it at 7.525–7.529 × 21
 * on 1× and 2× screens; the width here is a hair over that, so a preset sized
 * by it holds exactly its cols × rows at the cell the terminal really has.
 * Once a workspace has a live terminal, that cell decides cols and rows.
 */
export const CELL_ESTIMATE: Cell = { w: 7.53, h: 21 };

/** The landscape's terminal font, in px: a workspace's terminal keeps it at every zoom, which only scales it. */
export const LANDSCAPE_FONT = 12.5;

/** A workspace's header bar (design N's chips) and its footer (the rail's cells), in px at 100%. */
export const WORKSPACE_HEAD = 32;
export const WORKSPACE_FOOT = 24;
/** What a workspace's frame takes around its terminal: side padding (w), and the header bar and the footer (h). */
export const WORKSPACE_CHROME: Size = { w: 16, h: WORKSPACE_HEAD + WORKSPACE_FOOT };

/** The terminal size a workspace of `w` × `h` holds. */
export function colsRows(w: number, h: number, cellW: number, cellH: number, chrome: Size = WORKSPACE_CHROME): TermSize {
  // a hair of slack, so a size computed by sizeFor never loses a column to float error
  const fit = (px: number, cell: number) => Math.max(1, Math.floor(px / cell + 1e-6));
  return { cols: fit(w - chrome.w, cellW), rows: fit(h - chrome.h, cellH) };
}

/** The smallest workspace that holds `cols` × `rows`: colsRows's inverse. */
export function sizeFor(cols: number, rows: number, cellW: number, cellH: number, chrome: Size = WORKSPACE_CHROME): Size {
  return { w: Math.ceil(cols * cellW + chrome.w), h: Math.ceil(rows * cellH + chrome.h) };
}

/** A preset's workspace size at `cell`, rounded up to the grid: it holds at least the preset's cols × rows, and exactly that at the estimated cell. */
export function presetSize(kind: WorkspaceKind, preset: SizePreset = DEFAULT_PRESET, cell: Cell = CELL_ESTIMATE): Size {
  const t = WORKSPACE_SIZES[kind][preset];
  const s = sizeFor(t.cols, t.rows, cell.w, cell.h);
  return { w: snapUp(s.w), h: snapUp(s.h) };
}

// ---- geometry ----------------------------------------------------------------------------

/** Whether two rectangles come closer than `gap` (touching counts at gap 0 as apart). */
export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/** Whether `r` lies wholly inside `a`: a place inside an area is that area's, since areas never overlap. */
export const within = (r: Rect, a: Rect): boolean => r.x >= a.x && r.y >= a.y && r.x + r.w <= a.x + a.w && r.y + r.h <= a.y + a.h;

/** The smallest rectangle around all of `rects`; null for none. */
export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

/**
 * Where a new workspace of `size` goes.
 *
 * In an area: the first free spot in reading order, top-left first, inside
 * the area's padding and below its header. Spots are tried at the area's
 * corner and just right of or below each occupied rectangle; one that would
 * cross the area's right edge isn't, unless nothing fits across it. When the
 * area is full the spot is below everything, and the caller grows the area to
 * take it (fitAreaTo).
 *
 * Loose (no area): a column just left of `near` (the first area), going down
 * past whatever is there; at the origin when there's no area at all.
 *
 * `occupied` is everything already placed, other areas' frames included for a
 * loose workspace.
 */
export function placeNew(size: Size, occupied: readonly Rect[], area: Rect | null, near: Rect | null = null): Placement {
  const free = (p: Rect) => !occupied.some((o) => overlaps(p, o, GAP - 1e-6));
  // edges after a rectangle round up, so the spot past the last one is always clear of it
  const below = occupied.map((o) => snapUp(o.y + o.h + GAP));
  const first = (spots: { x: number; y: number }[]): Placement => {
    const at = spots.find((p) => free({ ...p, ...size }));
    // the spot below everything is always among them and always free, so this is a bug, not a full landscape
    if (!at) throw new Error(`placeNew found no free spot for ${size.w}×${size.h} among ${occupied.length} placements`);
    return { ...at, ...size };
  };
  if (!area) {
    const x = near ? snapDown(near.x - AREA_GAP - size.w) : 0;
    const top = near ? snap(near.y) : 0;
    return first([top, ...below].filter((y) => y >= top).sort((a, b) => a - b).map((y) => ({ x, y })));
  }
  const left = snapUp(area.x + AREA_PAD);
  const top = snapUp(area.y + AREA_HEADER);
  const right = area.x + area.w - AREA_PAD;
  const xs = [left, ...occupied.map((o) => snapUp(o.x + o.w + GAP))].filter((x) => x >= left && x + size.w <= right);
  const ys = [top, ...below].filter((y) => y >= top);
  const spots = (xs.length ? xs : [left]).flatMap((x) => ys.map((y) => ({ x, y })));
  return first(spots.sort((a, b) => a.y - b.y || a.x - b.x));
}

/** `area` grown rightward and downward, never shrunk, to hold `rects` inside its padding (they lie right of and below its corner, as placeNew puts them). */
export function fitAreaTo(area: Area, rects: readonly Rect[]): Area {
  const b = boundsOf(rects);
  if (!b) return area;
  const w = Math.max(area.w, snapUp(b.x + b.w + AREA_PAD - area.x));
  const h = Math.max(area.h, snapUp(b.y + b.h + AREA_PAD - area.y));
  return w === area.w && h === area.h ? area : { ...area, w, h };
}

// ---- areas apart ---------------------------------------------------------------------------

/** `r` moved by `dx`, `dy`. */
export const shifted = <T extends Rect>(r: T, dx: number, dy: number): T => ({ ...r, x: r.x + dx, y: r.y + dy });

/** The area that holds `rects` (workspaces): its padding around them, and its header's band above, on the grid. */
export function areaAround(rects: readonly Rect[]): Rect | null {
  const b = boundsOf(rects);
  if (!b) return null;
  const x = snapDown(b.x - AREA_PAD);
  const y = snapDown(b.y - AREA_HEADER);
  return { x, y, w: snapUp(b.x + b.w + AREA_PAD) - x, h: snapUp(b.y + b.h + AREA_PAD) - y };
}

/** The most moves clearOf tries before it gives up on a near spot and goes below everything. */
const CLEAR_TRIES = 400;

/**
 * The smallest move, on the grid, that leaves `r` at least `gap` clear of every one of `others`; { 0, 0 } when it's
 * clear already. From each spot it tries each way out of every rectangle it still comes too close to, nearest
 * first (a way out of one can land on another); past CLEAR_TRIES spots, straight down below all of them, which is
 * always clear. Areas use it so that one made or moved never overlaps another.
 */
export function clearOf(r: Rect, others: readonly Rect[], gap = AREA_GAP): { dx: number; dy: number } {
  const near = (dx: number, dy: number) => others.filter((o) => overlaps(shifted(r, dx, dy), o, gap - 1e-6));
  const seen = new Set<string>();
  const queue: { dx: number; dy: number; d: number }[] = [{ dx: 0, dy: 0, d: 0 }];
  for (let tries = 0; queue.length && tries < CLEAR_TRIES; tries++) {
    queue.sort((a, b) => a.d - b.d);
    const at = queue.shift()!;
    const hit = near(at.dx, at.dy);
    if (!hit.length) return { dx: at.dx + 0, dy: at.dy + 0 };
    for (const o of hit) {
      for (const [dx, dy] of [
        [snapUp(o.x + o.w + gap) - r.x, at.dy],
        [snapDown(o.x - gap - r.w) - r.x, at.dy],
        [at.dx, snapUp(o.y + o.h + gap) - r.y],
        [at.dx, snapDown(o.y - gap - r.h) - r.y],
      ]) {
        const k = `${dx},${dy}`;
        if (seen.has(k)) continue;
        seen.add(k);
        queue.push({ dx, dy, d: Math.hypot(dx, dy) });
      }
    }
  }
  const bottom = Math.max(...others.map((o) => o.y + o.h));
  return { dx: 0, dy: snapUp(bottom + gap) - r.y };
}

/**
 * Rectangles moved out of the way of `key`'s, which stays where it is (an area that grew): each that comes closer
 * than `gap` to one that's fixed or already moved goes right or down, whichever is the shorter way, and pushes on in
 * turn. Those in `fixed` (locked areas) never move: one pushed into them, or back into `key`'s, goes on past. Only rightward
 * and downward, so it always ends. The moves made, by key; none when nothing was in the way. `key`'s own rectangle
 * coming too close to a fixed one is the caller's to prevent (fixedInWay).
 */
export function pushAside(rects: Readonly<Record<string, Rect>>, key: string, gap = AREA_GAP, fixed: ReadonlySet<string> = new Set()): Record<string, { dx: number; dy: number }> {
  const at: Record<string, Rect> = {};
  for (const [k, r] of Object.entries(rects)) put(at, k, r);
  const moves: Record<string, { dx: number; dy: number }> = {};
  const push = (j: string, dx: number, dy: number) => {
    put(at, j, shifted(own(at, j)!, dx, dy));
    const m = own(moves, j) ?? { dx: 0, dy: 0 };
    put(moves, j, { dx: m.dx + dx, dy: m.dy + dy });
  };
  /** The shorter way, right or down, that takes `b` clear of `a`. */
  const away = (a: Rect, b: Rect): [number, number] => {
    const right = snapUp(a.x + a.w + gap) - b.x;
    const down = snapUp(a.y + a.h + gap) - b.y;
    return right <= down ? [right, 0] : [0, down];
  };
  const queue = [key];
  for (let n = 0; queue.length; n++) {
    // every push moves a rectangle right or down past another, so this ends; a loop that doesn't is a bug here
    if (n > 100 * (Object.keys(at).length + 1)) throw new Error(`pushAside didn't settle pushing ${Object.keys(at).length} rectangles away from ${key}`);
    const k = queue.shift()!;
    const a = own(at, k)!;
    for (const j of Object.keys(at)) {
      if (j === k) continue;
      const b = own(at, j)!;
      if (!overlaps(a, b, gap - 1e-6)) continue;
      if (j === key || fixed.has(j)) {
        if (k === key || fixed.has(k)) continue;
        // pushed into one that stays (a fixed one, or `key`'s): on past it, and it pushes on from there
        push(k, ...away(b, a));
        queue.push(k);
        break;
      }
      push(j, ...away(a, b));
      queue.push(j);
    }
  }
  return moves;
}

/** The first of `fixed` (locked areas) other than `key` that `key`'s rectangle comes closer than `gap` to: pushAside can't move it. */
export function fixedInWay(rects: Readonly<Record<string, Rect>>, key: string, fixed: ReadonlySet<string>, gap = AREA_GAP): string | null {
  const r = own(rects, key);
  return (r && [...fixed].find((k) => k !== key && Object.hasOwn(rects, k) && overlaps(r, own(rects, k)!, gap - 1e-6))) || null;
}

/** The view: the landscape point at the viewport's top-left, and the zoom (1 = 100%). */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/**
 * The camera that shows all of `rects` in a `viewport`, centred, with
 * `padding` screen pixels around them, never zoomed in past `maxZoom` or out
 * past `minZoom`.
 */
export function fitView(rects: readonly Rect[], viewport: Size, opts: { padding?: number; maxZoom?: number; minZoom?: number } = {}): Camera {
  const { padding = 48, maxZoom = 1, minZoom = 0.05 } = opts;
  const b = boundsOf(rects);
  if (!b) return { x: 0, y: 0, zoom: 1 };
  const fitZoom = Math.min((viewport.w - 2 * padding) / Math.max(b.w, 1), (viewport.h - 2 * padding) / Math.max(b.h, 1));
  const zoom = Math.min(maxZoom, Math.max(minZoom, fitZoom));
  return { x: b.x + b.w / 2 - viewport.w / (2 * zoom), y: b.y + b.h / 2 - viewport.h / (2 * zoom), zoom };
}

// ---- records keyed by ids and groups ------------------------------------------------------

/**
 * An entry of a record keyed by a session id or a group, or undefined. Any
 * string can be one, "constructor" or "__proto__" included, and `r[k]` on a
 * plain object finds what Object.prototype has under those names.
 */
export const own = <T>(r: Readonly<Record<string, T>>, k: string): T | undefined => (Object.hasOwn(r, k) ? r[k] : undefined);

/** Set `r[k]` as an entry of its own: `r[k] = v` with k "__proto__" would replace the record's prototype instead. */
export function put<T>(r: Record<string, T>, k: string, v: T): void {
  Object.defineProperty(r, k, { value: v, writable: true, enumerable: true, configurable: true });
}

// ---- checking what comes from disk or another process ----------------------------------

/** A landscape, or a patch for one, that isn't one: the message names the field. */
export class LandscapeShapeError extends Error {
  constructor(where: string, what: string) {
    super(`${where} ${what}`);
    this.name = "LandscapeShapeError";
  }
}

/** Furthest a position goes from the origin, and the largest size: well past any real layout, short of what breaks the arithmetic. */
export const MAX_COORD = 1e7;
export const MAX_EXTENT = 1e5;

type Check<T> = (v: unknown, where: string) => T;
/** The fields one part of the stored format has, how each is checked, and which it must have. */
interface Part {
  checks: Record<string, Check<unknown>>;
  required: readonly string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const fail = (where: string, what: string): never => {
  throw new LandscapeShapeError(where, what);
};
const num: Check<number> = (v, where) => (typeof v === "number" && Number.isFinite(v) ? v : fail(where, "is not a number"));
const coord: Check<number> = (v, where) => (Math.abs(num(v, where)) <= MAX_COORD ? (v as number) : fail(where, `is beyond ±${MAX_COORD}`));
const extent: Check<number> = (v, where) => {
  const n = num(v, where);
  return n <= 0 ? fail(where, "is not above 0") : n > MAX_EXTENT ? fail(where, `is over ${MAX_EXTENT}`) : n;
};
const str: Check<string> = (v, where) => (typeof v === "string" ? v : fail(where, "is not a string"));
const name: Check<string> = (v, where) => (str(v, where) ? (v as string) : fail(where, "is empty"));
const bool: Check<boolean> = (v, where) => (typeof v === "boolean" ? v : fail(where, "is not true or false"));
const agentKind: Check<AgentKind> = (v, where) => (v === "claude" || v === "codex" ? v : fail(where, "is not claude or codex"));
const orNull =
  <T>(each: Check<T>): Check<T | null> =>
  (v, where) =>
    v === null ? null : each(v, where);

/** An object to read entries from: an empty key is never a session or a group. */
function record(v: unknown, where: string): Record<string, unknown> {
  if (!isObj(v)) fail(where, "is not an object");
  for (const k of Object.keys(v as object)) if (!k) fail(where, `has a key that can't be used (${JSON.stringify(k)})`);
  return v as Record<string, unknown>;
}

/**
 * An object with exactly the part's fields: each one there is checked, the
 * required ones must be, and one this version doesn't know is refused rather
 * than dropped. An undefined field counts as absent. `where` is its path for
 * its fields' errors ("" at the top), `self` its name in its own.
 */
function fields<T>(v: unknown, where: string, part: Part, partial = false, self = where): T {
  const at = (k: string) => (where ? `${where}.${k}` : k);
  const o = record(v, self);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) {
    if (!Object.hasOwn(part.checks, k)) fail(self, `has a field this version doesn't know (${k})`);
    if (x !== undefined) out[k] = part.checks[k](x, at(k));
  }
  if (!partial) for (const k of part.required) if (out[k] === undefined) fail(at(k), "is missing");
  return out as T;
}

const list =
  <T>(each: Check<T>): Check<T[]> =>
  (v, where) =>
    Array.isArray(v) ? v.map((x, i) => each(x, `${where}[${i}]`)) : fail(where, "is not a list");

/** A record's keys: what they must be, as `check` says; any non-empty string when there's none. */
type KeyCheck = (k: string) => string | null;
/** An area's key is a top-level group: no sub-group in it, and not the loose bucket. */
const areaKey: KeyCheck = (k) => (k.includes("/") ? "has a sub-group in it" : k === LOOSE_GROUP ? `is ${LOOSE_GROUP}, which is loose, not an area` : null);
/** A stack's key is a "top/sub" group, as stackKeyOf writes it. */
const stackKey: KeyCheck = (k) => (stackKeyOf({ taskGroup: k }) === k ? null : 'isn\'t a "group/sub-group"');

/**
 * A record of entries, each checked, keyed as the error names them. An
 * undefined entry counts as absent, as an undefined field does.
 */
function entries<T>(v: unknown, where: string, each: Check<T>, key?: KeyCheck): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, x] of Object.entries(record(v, where))) {
    const bad = key?.(k);
    if (bad) fail(where, `has a key that ${bad} (${JSON.stringify(k)})`);
    if (x !== undefined) put(out, k, each(x, `${where}[${JSON.stringify(k)}]`));
  }
  return out;
}

const RECT_CHECKS = { x: coord, y: coord, w: extent, h: extent } satisfies Record<keyof Rect, Check<unknown>>;
const PLACEMENT: Part = { checks: RECT_CHECKS, required: ["x", "y", "w", "h"] };
const rect: Check<Rect> = (v, where) => fields(v, where, PLACEMENT);

const REPO: Part = { checks: { path: name, base: orNull(name) } satisfies Record<keyof AreaRepo, Check<unknown>>, required: ["path", "base"] };
const repos: Check<AreaRepo[]> = (v, where) => {
  const out = list<AreaRepo>((x, w) => fields(x, w, REPO))(v, where);
  const seen = new Set<string>();
  for (const r of out) {
    if (seen.has(r.path)) fail(where, `lists ${r.path} twice`);
    seen.add(r.path);
  }
  return out;
};
const AREA: Part = {
  checks: { ...RECT_CHECKS, repos, collapsed: bool, locked: bool, autoCreate: bool } satisfies Record<keyof Area, Check<unknown>>,
  required: [...PLACEMENT.required, "repos"],
};
const area: Check<Area> = (v, where) => fields(v, where, AREA);

const STACK: Part = { checks: { active: name, placement: rect } satisfies Record<keyof Stack, Check<unknown>>, required: ["active", "placement"] };
const stack: Check<Stack> = (v, where) => fields(v, where, STACK);

const CONVERSATION: Part = { checks: { agent: agentKind, id: name } satisfies Record<keyof NonNullable<Ghost["conversation"]>, Check<unknown>>, required: ["agent", "id"] };
const ghostAgent: Check<Ghost["agent"]> = (v, where) => (v === "terminal" ? v : v === "claude" || v === "codex" ? v : fail(where, "is not claude, codex or terminal"));
const GHOST: Part = {
  checks: {
    title: str,
    agent: ghostAgent,
    cwd: str,
    repoPath: orNull(str),
    branch: str,
    ticketId: str,
    conversation: (v, where) => fields(v, where, CONVERSATION),
    summary: str,
    worktreeRemoved: bool,
    placement: rect,
    group: name,
    closedAt: str,
  } satisfies Record<keyof Ghost, Check<unknown>>,
  required: ["title", "agent", "cwd", "repoPath", "placement", "group", "closedAt"],
};
const ghost: Check<Ghost> = (v, where) => fields(v, where, GHOST);

const toolKind: Check<ToolKind> = (v, where) => (TOOL_KINDS.includes(v as ToolKind) ? (v as ToolKind) : fail(where, `is not one of ${TOOL_KINDS.join(", ")}`));
/** An area's key where one is named: a top-level group, never the loose bucket. */
const areaName: Check<string> = (v, where) => {
  const k = name(v, where);
  const bad = areaKey(k);
  return bad ? fail(where, bad) : k;
};
const TOOL: Part = {
  checks: { tool: toolKind, docked: bool, session: name, area: orNull(areaName), placement: rect } satisfies Record<keyof ToolWindow, Check<unknown>>,
  required: ["tool", "docked"],
};
/**
 * A tool window, its fields and what they say together: a docked one has no scope or place (it follows the
 * selection), and a placed one has its scope, a workspace tool its session and an area tool its area.
 */
const toolWindow: Check<ToolWindow> = (v, where) => {
  const t = fields<ToolWindow>(v, where, TOOL);
  if (t.docked) {
    if (t.session !== undefined || t.area !== undefined || t.placement !== undefined) fail(where, "is docked, so it has no session, area or placement");
  } else if (isWorkspaceTool(t.tool)) {
    if (t.session === undefined) fail(`${where}.session`, "is missing");
    if (t.area === undefined) fail(`${where}.area`, "is missing");
  } else if (typeof t.area !== "string") fail(`${where}.area`, t.area === null ? `is null, but ${t.tool} is an area's` : "is missing");
  else if (t.session !== undefined) fail(where, `is an area's ${t.tool}, so it has no session`);
  return t;
};
const CARD: Part = {
  checks: { area: areaName, artifact: name, placement: rect } satisfies Record<keyof ArtifactCard, Check<unknown>>,
  required: ["area", "artifact"],
};
const card: Check<ArtifactCard> = (v, where) => fields(v, where, CARD);

/** The version a stored landscape says it is, when it says: a newer one can't be read here, and isn't corrupt. */
export function versionOf(v: unknown): number | null {
  return isObj(v) && typeof v.v === "number" ? v.v : null;
}

const version =
  (want: number): Check<number> =>
  (v, where) =>
    v === want ? want : fail(where, `is ${JSON.stringify(v)}, not ${want}`);
const V1_CHECKS = {
  v: version(1),
  migratedAt: str,
  tourDone: bool,
  workspaces: (v: unknown, where: string) => entries(v, where, rect),
  areas: (v: unknown, where: string) => entries(v, where, area, areaKey),
  stacks: (v: unknown, where: string) => entries(v, where, stack, stackKey),
  ghosts: (v: unknown, where: string) => entries(v, where, ghost),
};
/** Version 1's landscape: what a file written before tool windows holds, and nothing more. */
const LANDSCAPE_V1: Part = { checks: V1_CHECKS, required: ["v", "workspaces", "areas", "stacks", "ghosts"] };
const LANDSCAPE: Part = {
  checks: {
    ...V1_CHECKS,
    v: version(LANDSCAPE_VERSION),
    tools: (v, where) => entries(v, where, toolWindow),
    cards: (v, where) => entries(v, where, card),
  } satisfies Record<keyof Landscape, Check<unknown>>,
  required: [...LANDSCAPE_V1.required, "tools", "cards"],
};

/**
 * The stored format as this version checks it: each part's fields and the
 * ones it requires. A test pins it under LANDSCAPE_VERSION, so the format
 * can't change without the version being raised.
 */
export const LANDSCAPE_FORMAT: Record<string, { fields: string[]; required: string[] }> = Object.fromEntries(
  Object.entries({ landscape: LANDSCAPE, placement: PLACEMENT, area: AREA, repo: REPO, stack: STACK, ghost: GHOST, conversation: CONVERSATION, tool: TOOL, card: CARD }).map(([k, p]) => [
    k,
    { fields: Object.keys(p.checks).sort(), required: [...p.required].sort() },
  ])
);

/**
 * A landscape read from disk, checked whole: throws LandscapeShapeError naming the first field that's wrong. A
 * version 1 file is checked as version 1 (a field only a later version has makes it wrong) and read as this version's
 * with no tool windows or cards: every placement it holds is kept as it is.
 */
export function parseLandscape(v: unknown): Landscape {
  if (versionOf(v) === 1) {
    const old = fields<Omit<Landscape, "v" | "tools" | "cards">>(v, "", LANDSCAPE_V1, false, "the landscape");
    return { ...old, v: LANDSCAPE_VERSION, tools: {}, cards: {} };
  }
  return fields(v, "", LANDSCAPE, false, "the landscape");
}

// ---- patches ----------------------------------------------------------------------------

/**
 * One change to the landscape, as a window sends it: only what changed.
 * A null entry removes it (one that isn't there is left as it is), and an
 * undefined entry or field changes nothing. Areas and stacks merge field by
 * field (collapsing an area leaves its repos alone), so a new one has to come
 * whole; a placement, a ghost, a tool window or a card is replaced whole.
 * `migratedAt: null` clears it, so the grid's layout is read in again.
 */
export interface LandscapePatch {
  workspaces?: Record<string, Placement | null>;
  areas?: Record<string, Partial<Area> | null>;
  stacks?: Record<string, Partial<Stack> | null>;
  ghosts?: Record<string, Ghost | null>;
  tools?: Record<string, ToolWindow | null>;
  cards?: Record<string, ArtifactCard | null>;
  migratedAt?: string | null;
  tourDone?: boolean;
}

/** The records a patch changes entry by entry, in the order a patch is applied. */
export const PATCH_RECORDS = ["workspaces", "areas", "stacks", "ghosts", "tools", "cards"] as const;

const PATCH: Part = {
  checks: {
    workspaces: (v, where) => entries(v, where, orNull(rect)),
    areas: (v, where) => entries(v, where, orNull((x, w) => fields<Partial<Area>>(x, w, AREA, true)), areaKey),
    stacks: (v, where) => entries(v, where, orNull((x, w) => fields<Partial<Stack>>(x, w, STACK, true)), stackKey),
    ghosts: (v, where) => entries(v, where, orNull(ghost)),
    tools: (v, where) => entries(v, where, orNull(toolWindow)),
    cards: (v, where) => entries(v, where, orNull(card)),
    migratedAt: orNull(str),
    tourDone: bool,
  } satisfies Record<keyof LandscapePatch, Check<unknown>>,
  required: [],
};

/** A patch from another process, checked: throws LandscapeShapeError naming what's wrong. Whether a new area or stack is whole is applyPatch's to check. */
export function parsePatch(v: unknown): LandscapePatch {
  return fields(v, "", PATCH, true, "the patch");
}

const defined = (o: object): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function merged<T>(cur: Record<string, T>, changes: Record<string, unknown> | undefined, where: string, check: Check<T>, partial: boolean, key?: KeyCheck): Record<string, T> {
  if (!changes) return cur;
  const out = { ...cur };
  for (const [k, change] of Object.entries(record(changes, where))) {
    const at = `${where}[${JSON.stringify(k)}]`;
    const bad = key?.(k);
    if (bad) fail(where, `has a key that ${bad} (${JSON.stringify(k)})`);
    if (change === undefined) continue;
    if (change === null) delete out[k];
    else if (!partial) put(out, k, check(change, at));
    else if (Object.hasOwn(out, k)) put(out, k, check({ ...out[k], ...defined(record(change, at)) }, at));
    else {
      try {
        put(out, k, check(defined(record(change, at)), at));
      } catch (err) {
        if (!(err instanceof LandscapeShapeError)) throw err;
        throw new LandscapeShapeError(at, `isn't on the landscape, so the patch has to give all of it (${err.message})`);
      }
    }
  }
  return out;
}

/**
 * The landscape after `patch`, as a new object (the old one is untouched).
 * Every entry it makes or changes is checked whole; throws
 * LandscapeShapeError, changing nothing, when one isn't: a new area needs its
 * rectangle and repos, a new stack its tab and placement. Undefined entries
 * and fields change nothing, as they do once parsePatch has read them.
 */
export function applyPatch(l: Landscape, patch: LandscapePatch): Landscape {
  const out: Landscape = {
    ...l,
    workspaces: merged(l.workspaces, patch.workspaces, "workspaces", rect, false),
    areas: merged(l.areas, patch.areas, "areas", area, true, areaKey),
    stacks: merged(l.stacks, patch.stacks, "stacks", stack, true, stackKey),
    ghosts: merged(l.ghosts, patch.ghosts, "ghosts", ghost, false),
    tools: merged(l.tools, patch.tools, "tools", toolWindow, false),
    cards: merged(l.cards, patch.cards, "cards", card, false),
  };
  if (patch.migratedAt === null) delete out.migratedAt;
  else if (patch.migratedAt !== undefined) out.migratedAt = str(patch.migratedAt, "migratedAt");
  if (patch.tourDone !== undefined) out.tourDone = bool(patch.tourDone, "tourDone");
  return out;
}

/**
 * What renaming group `from` to `to` does to the landscape, as renameGroup renames (prefix-aware: "from/sub" becomes
 * "to/sub"): its area and stacks are keyed by the new name where they sit, and its ghosts' groups follow. Renaming
 * onto a group that has an area already merges into it: `from`'s area goes, and the places of its workspaces and
 * stacks are dropped, so each is placed in the area it joined as a new one is. Those are `members` (the sessions that
 * were in it, wherever they sit) and every place inside its area: teammates' sessions and ones waiting to be resumed,
 * which `members` can't name, included. A name that can't key an area (loose, or a sub-group) drops the area and
 * leaves the places. Null when the landscape holds nothing of `from`'s.
 *
 * Its placed tool windows and artifact cards go with it: their area is the new name, and in a merge they're placed
 * anew in the area they joined. Where the new name can't key an area, its cards and its Artifacts and Chat windows
 * go (they're the area's), and its other windows stay where they are, loose.
 */
export function renameAreaPatch(l: Landscape, from: string, to: string, members: readonly string[]): LandscapePatch | null {
  const remap = (g: string) => (g === from ? to : g.startsWith(`${from}/`) ? to + g.slice(from.length) : g);
  const patch: Required<Pick<LandscapePatch, (typeof PATCH_RECORDS)[number]>> = { workspaces: {}, areas: {}, stacks: {}, ghosts: {}, tools: {}, cards: {} };
  const area = own(l.areas, from);
  const merge = !!area && Object.hasOwn(l.areas, to);
  if (area && from !== to) {
    put(patch.areas, from, null);
    if (!merge && areaKey(to) === null) put(patch.areas, to, area);
    if (merge) for (const [id, r] of Object.entries(l.workspaces)) if (members.includes(id) || within(r, area)) put(patch.workspaces, id, null);
  }
  for (const [k, s] of Object.entries(l.stacks)) {
    const nk = remap(k);
    if (nk === k) continue;
    put(patch.stacks, k, null);
    if (!merge && stackKeyOf({ taskGroup: nk }) === nk && !Object.hasOwn(l.stacks, nk)) put(patch.stacks, nk, s);
  }
  for (const [id, g] of Object.entries(l.ghosts)) {
    const ng = remap(g.group);
    if (ng !== g.group) put(patch.ghosts, id, { ...g, group: ng });
  }
  if (from !== to) {
    const keyable = areaKey(to) === null;
    const rehome = <T extends { placement?: Placement }>(x: T): T => {
      if (!merge) return x;
      const { placement: _, ...rest } = x;
      return rest as T;
    };
    for (const [id, t] of Object.entries(l.tools)) {
      if (t.docked || t.area !== from) continue;
      if (keyable) put(patch.tools, id, rehome({ ...t, area: to }));
      else put(patch.tools, id, isWorkspaceTool(t.tool) ? { ...t, area: null } : null);
    }
    for (const [id, c] of Object.entries(l.cards)) {
      if (c.area !== from) continue;
      put(patch.cards, id, keyable ? rehome({ ...c, area: to }) : null);
    }
  }
  const out: LandscapePatch = {};
  for (const k of PATCH_RECORDS) if (Object.keys(patch[k]).length) Object.assign(out, { [k]: patch[k] });
  return Object.keys(out).length ? out : null;
}

/** The same value: objects by their entries in any order, arrays in order. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (!isObj(a) || !isObj(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
}

/** Whether two landscapes hold the same: a patch that leaves one so changes nothing. */
export const sameLandscape = (a: Landscape, b: Landscape): boolean => same(a, b);

// ---- what crosses IPC ---------------------------------------------------------------------

/**
 * Something wrong with landscape.json that the window shows as a banner:
 * - corrupt: it wasn't a landscape; it was moved to `movedTo` and the layout starts over;
 * - unreadable: reading it failed (the disk, or too many open files): it's left as it is, read again with the
 *   next change, and the layout shown meanwhile is a stand-in, empty, whose changes aren't saved; nothing should
 *   be migrated into it;
 * - dropped: it could be read again, and the changes made to the stand-in were dropped for the file's layout;
 * - newer: a newer Mockingbird wrote it; it's left as it is;
 * - save: the latest changes couldn't be written; they're kept and tried again with the next change and on quit.
 * With `readOnly`, the file is left as it is: changes this run are kept in memory and never written.
 */
export interface LandscapeProblem {
  kind: "corrupt" | "unreadable" | "dropped" | "newer" | "save";
  message: string;
  file: string;
  movedTo?: string;
  readOnly?: boolean;
}

/**
 * `landscape:get`'s answer, and `landscape:update`'s. `rev` counts the
 * changes made since the app started. `problems` holds at most one problem
 * from reading the file, one from dropping a stand-in's changes, and one
 * from the latest save.
 */
export interface LandscapeState {
  landscape: Landscape;
  rev: number;
  problems: LandscapeProblem[];
}

/**
 * `landscape:changed`, sent to every window. Revision `rev` was made by
 * `patch` (applied with applyPatch, in order), or by replacing the landscape
 * whole with `landscape` (the file read again); with neither, only `problems`
 * changed. A window that sees a gap in `rev` has missed one and gets the
 * landscape again.
 */
export interface LandscapeChange {
  rev: number;
  patch: LandscapePatch | null;
  landscape?: Landscape;
  problems: LandscapeProblem[];
}
