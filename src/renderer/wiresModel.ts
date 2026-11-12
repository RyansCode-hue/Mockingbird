/**
 * What the landscape draws of its wires (docs/landscape-wires.md, W4a), as pure functions: where each wire's ends are
 * (the tile holding the session, a ghost's card, or a collapsed area's pill), what state it shows, and its curve
 * (Main.dc.html's). WireLayer.tsx draws them and keeps them on their ends as workspaces move.
 */
import { DEFAULT_ROUNDS, ROOM_LINE, gateOf, wireEndOf, wireRefusal, wiresInOrder, type Gate, type GateContext, type Wire, type WireContext, type WireEnd, type WireState, type WireType } from "../shared/wires";
import { outsideRoomSandbox } from "../shared/team/livePanes";
import { topOfKey, type SessionInfo } from "../shared/types";
import { LOOSE_GROUP, type Rect } from "../shared/landscape";
import { areaShown, type Point, type ResolvedLayout } from "./landscapeModel";
import { titleOf } from "./appModel";

/** Where one end of a wire is drawn. `tab`: the session is a stack's tab that isn't in front, named on the wire. */
export interface WireAnchor {
  kind: "tile" | "ghost" | "pill";
  /** The tile's key, the ghost's, or the area's. */
  key: string;
  rect: Rect;
  tab: string | null;
}

/** How a wire is drawn: its look (styles.css .ls-wire.lk-*), the gate dot, and what's written on it. */
export type WireLook = "idle" | "ready" | "sending" | "sent" | "blocked" | "context" | "tree";
export interface WireLabel {
  text: string;
  tone: "ready" | "blocked" | "plain" | "quiet";
}
export interface WireView {
  id: string;
  type: WireType;
  from: WireAnchor;
  to: WireAnchor;
  look: WireLook;
  arrow: boolean;
  dot: "ready" | "blocked" | null;
  label: WireLabel | null;
  /** Why it's blocked, whole: the label says it short. */
  why: string | null;
}

/**
 * Where session `id` is drawn on `layout`: the tile it's a member of (a stack's closed tab included), its ghost, or, in
 * a collapsed area, that area's pill (areaShown). Null when it isn't on the landscape: closed with no place, or unknown.
 */
export function anchorOf(layout: Pick<ResolvedLayout, "tiles" | "ghosts" | "areas">, id: string): WireAnchor | null {
  const pill = (area: string): WireAnchor | null => {
    const a = layout.areas.find((x) => x.key === area && x.rect.collapsed);
    return a ? { kind: "pill", key: a.key, rect: areaShown(a), tab: null } : null;
  };
  for (const [kind, list] of [["tile", layout.tiles], ["ghost", layout.ghosts]] as const) {
    for (const t of list) {
      const s = t.members.find((m) => m.id === id) ?? t.closed?.find((m) => m.id === id);
      if (!s) continue;
      if (t.hidden) return pill(t.area);
      const tabs = t.members.length + (t.closed?.length ?? 0);
      return { kind, key: t.key, rect: t.rect, tab: tabs > 1 && t.front.id !== id ? titleOf(s) : null };
    }
  }
  return null;
}

/** A team room as the window knows it: the area (top-level group) it's shared as. */
export interface WireRoom {
  id: string;
  groupKey: string;
}

/**
 * A session on the landscape as the rules see it (shared/wires.ts' wireEndOf, as main's WireService.context has it), with
 * where it is as this window knows it. Its room is its area's, as main's livePanes has it (groupRoomOf): a closed
 * session has no room tag of its own; without `rooms`, its tag's. Its folder is main's, with symlinks resolved, for a
 * shared worktree wire's ends (WireState.folders), else its own.
 */
function endOf(s: SessionInfo, running: boolean, state: Pick<WireState, "folders">, rooms: readonly WireRoom[] | undefined, placed: boolean): WireEnd {
  const taken = s.room?.takenOver;
  const area = topOfKey(s.taskGroup ?? LOOSE_GROUP);
  return wireEndOf(s, {
    room: !rooms ? (s.room?.roomId ?? null) : s.debrief || taken ? null : (rooms.find((r) => r.groupKey === area)?.id ?? null),
    takenOver: taken ? (taken.back ? `“${titleOf(s)}” was taken back into another session.` : `${taken.byName} continues “${titleOf(s)}” on their laptop.`) : null,
    outsideSandbox: running && !!s.room && !s.room.remote && outsideRoomSandbox(s.shell ? null : (s.agent ?? "claude"), s.room.guards),
    running,
    placed,
    folder: (state.folders && Object.hasOwn(state.folders, s.id) ? state.folders[s.id] : null) ?? s.cwd,
  });
}

/**
 * The rules' view of what's drawn, for gateOf: running sessions are tiles' members, closed ones a stack's closed tabs
 * and ghosts', each named by a wire (or in `also`, the ends of one being made) made into an end. A pr-merged wire's
 * merge view is main's (WireState.merges): the merge watch is main's. Main's view also knows its file's write access
 * and whether team rooms have started; a wire that's blocked only for those draws as its state otherwise is, and main
 * refuses what's tried on it, saying why. A session's take-over is read from its room tag, which a closed one doesn't
 * have. `closed`: closed sessions with no place (the Closed sessions list), which the pipeline strip names and nothing
 * draws; a wire to one is blocked till it's reopened.
 */
export function gateContextOf(
  layout: Pick<ResolvedLayout, "tiles" | "ghosts">,
  state: Pick<WireState, "book" | "merges" | "folders">,
  rooms?: readonly WireRoom[],
  closed: readonly SessionInfo[] = [],
  also: readonly string[] = []
): GateContext | null {
  const book = state.book;
  if (!book) return null;
  const named = new Set([...Object.values(book.links).flatMap((w) => [w.from, w.to]), ...also]);
  const ends = new Map<string, WireEnd>();
  const add = (s: SessionInfo, running: boolean, placed = true) => named.has(s.id) && !ends.has(s.id) && ends.set(s.id, endOf(s, running, state, rooms, placed));
  if (named.size) {
    for (const t of layout.tiles) {
      for (const s of t.members) add(s, true);
      for (const s of t.closed ?? []) add(s, false);
    }
    for (const g of layout.ghosts) for (const s of g.members) add(s, false);
    for (const s of closed) add(s, false, false);
  }
  const ids = new Map(Object.entries(book.links).map(([id, w]) => [w, id]));
  const merges = state.merges ?? {};
  return {
    end: (id) => ends.get(id) ?? null,
    links: book.links,
    notes: book.notes,
    fileRefusal: null,
    mergeView: (w) => {
      const id = ids.get(w);
      return id !== undefined && Object.hasOwn(merges, id) ? merges[id] : null;
    },
  };
}

/** A blocked wire's reason, short enough to sit on it; the whole of it is `why`. */
export function shortWhy(gate: Gate, w: Pick<Wire, "rounds">): string {
  const why = gate.why ?? "blocked";
  if (gate.atLimit && w.rounds) return `at the limit · ${w.rounds.used} of ${w.rounds.limit}`;
  if (gate.unconfirmed) return "may have arrived";
  if (gate.stalled || /hooks aren't reporting/.test(why)) return "hooks not reporting";
  if (/is closed and not on the landscape/.test(why)) return "closed";
  if (why === ROOM_LINE) return "across a room's line";
  if (/team room's sandbox/.test(why)) return "outside its room's sandbox";
  if (/continues “|was taken back/.test(why)) return "taken over";
  // its first clause, a quoted title kept whole: “Spike: streaming” is a terminal: … → “Spike: streaming” is a terminal
  return why.replace(/^((?:“[^”]*”|[^.:“])*)[.:].*$/s, "$1");
}

/** How wire `w`, showing `gate`, is drawn (Inbox.dc.html's states and labels). */
export function lookOf(w: Wire, gate: Gate): Pick<WireView, "look" | "arrow" | "dot" | "label" | "why"> {
  const arrow = w.type !== "context" && w.type !== "worktree";
  if (gate.state === "blocked") return { look: "blocked", arrow, dot: "blocked", label: { text: shortWhy(gate, w), tone: "blocked" }, why: gate.why ?? null };
  if (w.type === "context") return { look: "context", arrow, dot: null, label: null, why: null };
  if (w.type === "worktree") return { look: "tree", arrow, dot: null, label: null, why: null };
  const round = (n: number) => (w.rounds ? ` · round ${n} of ${w.rounds.limit}` : "");
  const loop = w.rounds && w.rounds.used > 0 ? ({ text: `loop ${w.rounds.used} of ${w.rounds.limit}`, tone: "plain" } as const) : null;
  switch (gate.state) {
    case "ready":
      return { look: "ready", arrow, dot: "ready", label: { text: `Ready${round((w.rounds?.used ?? 0) + 1)}`, tone: "ready" }, why: null };
    case "sending":
      return { look: "sending", arrow, dot: null, label: { text: "sending…", tone: "quiet" }, why: null };
    case "sent":
      return { look: "sent", arrow, dot: null, label: gate.placed ? { text: "in its prompt", tone: "quiet" } : loop, why: null };
    default:
      return { look: "idle", arrow, dot: null, label: loop, why: null };
  }
}

/**
 * The wires to draw: each whose ends are both on the landscape, in the order they were made. None while the book
 * can't be read (the banner says why). A wire whose ends are drawn as one thing (two tabs of a stack, two workspaces
 * in one collapsed area) has nowhere to run, and isn't drawn.
 */
export function wireViews(state: WireState | null, layout: Pick<ResolvedLayout, "tiles" | "ghosts" | "areas">, rooms?: readonly WireRoom[]): WireView[] {
  if (!state?.book || !Object.keys(state.book.links).length) return [];
  const ctx = gateContextOf(layout, state, rooms);
  if (!ctx) return [];
  return wiresInOrder(state.book.links).flatMap(([id, w]): WireView[] => {
    const from = anchorOf(layout, w.from);
    const to = anchorOf(layout, w.to);
    if (!from || !to || (from.kind === to.kind && from.key === to.key)) return [];
    return [{ id, type: w.type, from, to, ...lookOf(w, gateOf(id, w, ctx)) }];
  });
}

// ---- curves -------------------------------------------------------------------------------

export type Side = "left" | "right" | "top" | "bottom";
/** h: side to side; v: top to bottom; u: under both, for a wire running back to the left (a feedback loop). */
export type Bend = "h" | "v" | "u";
export interface WireCurve {
  d: string;
  from: Point;
  to: Point;
  fromSide: Side;
  toSide: Side;
  /** Halfway along it: the gate dot and the label's place. */
  mid: Point;
  bend: Bend;
  /** Its control points: `d` is from, c1, c2, to. */
  c1: Point;
  c2: Point;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
/** The middle of where two ranges overlap, or null when they don't. */
const shared = (lo1: number, hi1: number, lo2: number, hi2: number): number | null => {
  const lo = Math.max(lo1, lo2);
  const hi = Math.min(hi1, hi2);
  return lo <= hi ? (lo + hi) / 2 : null;
};

/**
 * The curve from box `a` to box `b` (Main.dc.html:67–73): side to side when `b` is beside `a` to the right, top to
 * bottom when it's above or below, and a loop under both when it's to the left, so a wire back doesn't lie on the one
 * forward. Ends face each other where the boxes overlap across the wire, and are each side's middle otherwise. `px`
 * is a screen pixel in landscape px: the end stops 2 of them short of `b`, under its arrow, and a loop drops at least
 * 32 below. Null when the boxes overlap: there's nowhere to draw it.
 */
export function wireCurve(a: Rect, b: Rect, px = 1): WireCurve | null {
  const ar = a.x + a.w;
  const ab = a.y + a.h;
  const br = b.x + b.w;
  const bb = b.y + b.h;
  const gx = b.x >= ar ? b.x - ar : a.x >= br ? a.x - br : -1;
  const gy = b.y >= ab ? b.y - ab : a.y >= bb ? a.y - bb : -1;
  if (gx < 0 && gy < 0) return null;
  const gap = 2 * px;
  let p0: Point, c1: Point, c2: Point, p3: Point;
  let fromSide: Side, toSide: Side, bend: Bend;
  if (gx >= 0 && gx >= gy && b.x >= ar) {
    const y = shared(a.y, ab, b.y, bb);
    const k = gx / 2;
    p0 = { x: ar, y: y ?? a.y + a.h / 2 };
    p3 = { x: b.x - gap, y: y ?? b.y + b.h / 2 };
    c1 = { x: ar + k, y: p0.y };
    c2 = { x: b.x - k, y: p3.y };
    [fromSide, toSide, bend] = ["right", "left", "h"];
  } else if (gx >= 0 && gx >= gy) {
    const low = Math.max(ab, bb) + Math.max(gx / 2, 32 * px);
    // left of the middle, so it leaves apart from a wire down from the middle (Inbox.dc.html: Reviewer's two)
    p0 = { x: a.x + (a.w * 2) / 5, y: ab };
    p3 = { x: b.x + (b.w * 3) / 4, y: bb + gap };
    c1 = { x: p0.x, y: low };
    c2 = { x: p3.x, y: low };
    [fromSide, toSide, bend] = ["bottom", "bottom", "u"];
  } else {
    const x = shared(a.x, ar, b.x, br);
    const down = b.y >= ab;
    const k = gy / 2;
    p0 = { x: x ?? a.x + a.w / 2, y: down ? ab : a.y };
    p3 = { x: x ?? b.x + b.w / 2, y: down ? b.y - gap : bb + gap };
    c1 = { x: p0.x, y: down ? ab + k : a.y - k };
    c2 = { x: p3.x, y: down ? b.y - k : bb + k };
    [fromSide, toSide, bend] = down ? ["bottom", "top", "v"] : ["top", "bottom", "v"];
  }
  const mid = { x: (p0.x + 3 * c1.x + 3 * c2.x + p3.x) / 8, y: (p0.y + 3 * c1.y + 3 * c2.y + p3.y) / 8 };
  const d = `M${r1(p0.x)} ${r1(p0.y)} C${r1(c1.x)} ${r1(c1.y)}, ${r1(c2.x)} ${r1(c2.y)}, ${r1(p3.x)} ${r1(p3.y)}`;
  return { d, from: p0, to: p3, fromSide, toSide, mid, bend, c1, c2 };
}

/** How far from point `p` curve `c` passes, found along it in steps: near enough for a right-click on a thin line. */
export function curveDistance(c: Pick<WireCurve, "from" | "c1" | "c2" | "to">, p: Point): number {
  let best = Infinity;
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const u = 1 - t;
    const x = u * u * u * c.from.x + 3 * u * u * t * c.c1.x + 3 * u * t * t * c.c2.x + t * t * t * c.to.x;
    const y = u * u * u * c.from.y + 3 * u * u * t * c.c1.y + 3 * u * t * t * c.c2.y + t * t * t * c.to.y;
    best = Math.min(best, Math.hypot(x - p.x, y - p.y));
  }
  return best;
}

/** The wire whose curve passes nearest `p`, within `within` (landscape px), or null: what a right-click there is on. */
export function wireNear(curves: ReadonlyMap<string, WireCurve>, p: Point, within: number): string | null {
  let best: { id: string; d: number } | null = null;
  for (const [id, c] of curves) {
    const d = curveDistance(c, p);
    if (d <= within && (!best || d < best.d)) best = { id, d };
  }
  return best?.id ?? null;
}

/** Box `r` moved by `by` and drawn `inset` in from its edges (a card's, zoomed out to cards). */
export const shiftedBox = (r: Rect, by: Point | undefined, inset: number): Rect => ({
  x: r.x + (by?.x ?? 0) + inset,
  y: r.y + (by?.y ?? 0) + inset,
  w: Math.max(0, r.w - 2 * inset),
  h: Math.max(0, r.h - 2 * inset),
});

/**
 * A collapsed area's pill as drawn at a zoom, from its place `at` (areaShown): its size on screen held (--ls-hs, never
 * below 1), `size` before that. Without its size (it isn't drawn yet), `at` as it is.
 */
export const pillBox = (at: Rect, size: { w: number; h: number } | null, zoom: number): Rect => {
  const hs = Math.max(1, 1 / zoom);
  return size ? { x: at.x, y: at.y, w: size.w * hs, h: size.h * hs } : at;
};

/** An element's `translate` as a drag sets it ("12px 30px"), or none. */
export function translateOf(v: string): Point | undefined {
  const m = /^(-?[\d.e+-]+)px(?:\s+(-?[\d.e+-]+)px)?$/.exec(v.trim());
  return m ? { x: Number(m[1]), y: Number(m[2] ?? 0) } : undefined;
}

/**
 * What's wrong with the wire book, for the landscape's banners: why none of it can be used, what of it couldn't be
 * read (kept as it is, doing nothing), or the read itself failing, so no wires drawn is never taken for none made.
 */
export function wireBanners(r: { state: Pick<WireState, "refused" | "problems"> | null; error: string | null }): string[] {
  const out = new Set<string>();
  if (r.error && !r.state) out.add(`The wires couldn't be read (${r.error}), so none are drawn.`);
  if (r.state?.refused) out.add(r.state.refused);
  for (const p of r.state?.problems ?? []) out.add(p.message);
  return [...out];
}

// ---- making a wire ------------------------------------------------------------------------

/** Each type's name, as the type picker and a wire's settings say it. */
export const WIRE_TYPE_NAME: Record<WireType, string> = { handoff: "Handoff", context: "Context link", feedback: "Feedback loop", worktree: "Shared worktree" };

/** One row of the type picker (WireTypePicker.dc.html A): the wire it makes, what it does in a line, or why it can't be made. */
export interface WireChoice {
  type: WireType;
  name: string;
  line: string;
  /** The ends it makes the wire between: a shared worktree runs from the agent to the terminal, whichever was dragged from. */
  from: string;
  to: string;
  refused: string | null;
}

/** What a wire's template can name, as the chips under it add or take out (wirePrompt.ts fills them in as it goes). */
export const TEMPLATE_PARTS = ["summary", "ticket", "diff", "files"] as const;
export const hasPart = (t: string, p: string): boolean => t.includes(`{${p}}`);
/** Template `t` with placeholder `p` put at its end on a line of its own, or taken out with the blank line it leaves. */
export function togglePart(t: string, p: string): string {
  if (!hasPart(t, p)) return t.trim() ? `${t.replace(/\s+$/, "")}\n{${p}}` : `{${p}}`;
  return t
    .split(` {${p}}`)
    .join("")
    .split(`{${p}}`)
    .join("")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** `name`'s, as a possessive reads: Builder's, Fixtures'. */
export const whose = (name: string): string => (/s$/i.test(name) ? `${name}'` : `${name}'s`);
/** What a shared worktree wire does, said the same in the picker and the wire's settings. */
export const worktreeLine = (agent: string, terminal: string): string => `${terminal} runs in ${whose(agent)} worktree, and ${agent} reads its output.`;

/** A session as the picker names it. */
export interface ChoiceEnd {
  id: string;
  title: string;
}

/**
 * The four types a wire dragged from `a` to `b` can be, each with why it can't be made between them now (wireRefusal,
 * which main checks again as it makes it). A shared worktree dragged from a terminal to an agent runs from the agent.
 */
export function wireChoices(a: ChoiceEnd, b: ChoiceEnd, ctx: WireContext): WireChoice[] {
  const back = ctx.end(a.id)?.kind === "terminal" && ctx.end(b.id)?.kind === "agent";
  const [agent, term] = back ? [b, a] : [a, b];
  const row = (type: WireType, line: string, from = a, to = b): WireChoice => ({ type, name: WIRE_TYPE_NAME[type], line, from: from.id, to: to.id, refused: wireRefusal(from.id, to.id, type, ctx) });
  return [
    row("handoff", `${whose(a.title)} result becomes ${whose(b.title)} next prompt.`),
    row("context", `${b.title} can read ${a.title}. Nothing is pushed.`),
    row("feedback", `${whose(a.title)} notes go back to ${b.title}, ${DEFAULT_ROUNDS} rounds at most.`),
    row("worktree", worktreeLine(agent.title, term.title), agent, term),
  ];
}

/** The row ↵ takes: Handoff, or the first that can be made; null when none can. */
export const defaultChoice = (choices: readonly WireChoice[]): WireChoice | null => choices.find((c) => c.type === "handoff" && !c.refused) ?? choices.find((c) => !c.refused) ?? null;

/** When every one of `reasons` is a refusal, the one given most (the first of those tied); null when any is null. */
export function commonReason(reasons: readonly (string | null)[]): string | null {
  if (!reasons.length || reasons.some((r) => r === null)) return null;
  const count = new Map<string, number>();
  for (const r of reasons as string[]) count.set(r, (count.get(r) ?? 0) + 1);
  return [...count].reduce((best, c) => (c[1] > best[1] ? c : best))[0];
}

/** Why no wire at all can be made between two workspaces (every row refused): the reason most rows give. Null when one can. */
export const noChoice = (choices: readonly WireChoice[]): string | null => commonReason(choices.map((c) => c.refused));

/** A session a wire can be made to from the landscape: a workspace's (each tab of a stack), or a ghost's. */
export interface WireTarget {
  s: SessionInfo;
  area: string;
  closed: boolean;
}

/**
 * Every session drawn on the landscape but those in `from`'s own workspace: what Connect… lists, area by area, `from`'s
 * own area first, each area's running workspaces before its ghosts, in layout order.
 */
export function wireTargets(layout: Pick<ResolvedLayout, "tiles" | "ghosts">, from: string): WireTarget[] {
  const own = layout.tiles.find((t) => t.members.some((m) => m.id === from));
  const all = [
    ...layout.tiles.filter((t) => t !== own && !t.hidden).flatMap((t) => t.members.map((s) => ({ s, area: t.area, closed: false }))),
    ...layout.ghosts.filter((g) => !g.hidden).flatMap((g) => g.members.map((s) => ({ s, area: g.area, closed: true }))),
  ];
  const order = [...new Set([...(own ? [own.area] : []), ...all.map((t) => t.area)])];
  return order.flatMap((a) => all.filter((t) => t.area === a));
}
