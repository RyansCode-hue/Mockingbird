import { describe, expect, it } from "vitest";
import {
  forgetPatch,
  planMoveArea,
  planMoveTile,
  planOpenWindow,
  planResizeTile,
  planResizeTo,
  planStack,
  planTidy,
  planUnstack,
  presetFor,
  resolveLayout,
  tidyRefusal,
  type AreaPlan,
  type PendingRename,
  type ResolvedLayout,
  type Tile,
} from "../src/renderer/landscapeModel";
import { AREA_GAP, AREA_HEADER, AREA_PAD, GAP, GRID, LOOSE_GROUP, applyPatch, areaKeyOf, emptyLandscape, overlaps, own, parsePatch, renameAreaPatch, reopenPatch, snap, snapUp, stackKeyOf, within, type Area, type Landscape, type LandscapePatch, type Rect } from "../src/shared/landscape";
import type { SessionInfo } from "../src/shared/types";

// The layout's promises under random gestures, from fixed seeds so a failure replays: moves, resizes, presets, stacks,
// unstacks, Tidy, forgetting, reopening, merges and renames on their way, among ghosts, places nothing draws (hidden),
// locked and collapsed areas. Areas start in a tight grid, so what grows pushes. A layout pass runs between a plan's
// patch, its groups and its `after`, as it does in the app. After every step, a pass settles what the step left, and
// these hold: areas stay AREA_GAP apart; nothing overlaps, nor lies over an area it isn't in; a workspace in an area is
// inside it; a locked area moves as a whole, its insides where they were; what was moved or resized stays where the
// plan put it; only what's drawn pushes; and what's in which area doesn't change on a second pass.

type World = { l: Landscape; live: SessionInfo[]; closed: SessionInfo[]; renames: PendingRename[] };

/** How often each gesture went ahead and each kind of thing was there, over all the seeds: a run that tried none of something proves nothing of it. */
const seen = new Map<string, number>();
const count = (what: string) => seen.set(what, (seen.get(what) ?? 0) + 1);

/** mulberry32: the same numbers from the same seed on every run. */
const randomFrom = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const session = (id: string, taskGroup: string | null, status: SessionInfo["status"] = "idle"): SessionInfo => ({
  id,
  title: id,
  repoPath: "/r",
  cwd: "/r",
  branch: null,
  ticketId: null,
  ticketTitle: null,
  taskGroup,
  status,
  createdAt: 0,
  kind: "work",
  extraDirs: [],
  waitingReason: null,
  waitingSince: null,
  agent: "claude",
});

const T = (k: string) => k;
const apply = (l: Landscape, p: LandscapePatch | null) => (p ? applyPatch(l, parsePatch(p)) : l);
const pass = (w: World) => resolveLayout(w.l, w.live, undefined, w.renames, null, w.closed);
const drawnTiles = (r: ResolvedLayout) => [...r.tiles, ...r.ghosts];
/** What stands for a tile across steps: its stack's key, else its session's id. A stack's key changes only when it moves area. */
const idOf = (t: Tile) => t.stack ?? t.front.id;
const hull = (a: Rect, b: Rect): Rect => {
  const [x, y] = [Math.min(a.x, b.x), Math.min(a.y, b.y)];
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** A layout pass, saved as the app saves it. */
function midPass(w: World): void {
  w.l = apply(w.l, pass(w).patch);
}

/** A world's layout pass, saved, and the pass after it: what settling is. */
function settle(w: World): ResolvedLayout {
  const first = pass(w);
  w.l = apply(w.l, first.patch);
  const second = pass(w);
  const areasOf = (r: ResolvedLayout) => new Map(drawnTiles(r).map((t) => [idOf(t), t.area]));
  expect(second.patch, "one layout pass settles: the next has nothing to save").toBeNull();
  expect([...areasOf(second)], "what's in which area is the same on a second pass").toEqual([...areasOf(first)]);
  return second;
}

/** Everything that holds of a settled layout, whatever got it there. */
function assertSound(r: ResolvedLayout, l: Landscape): void {
  const areas = r.areas.map((a) => [a.key, a.rect] as const);
  for (let i = 0; i < areas.length; i++) {
    for (let j = i + 1; j < areas.length; j++) {
      expect(overlaps(areas[i][1], areas[j][1], AREA_GAP - 1e-6), `areas ${areas[i][0]} and ${areas[j][0]} keep AREA_GAP apart: ${JSON.stringify([areas[i][1], areas[j][1]])}`).toBe(false);
    }
  }
  // what's stored but not drawn counts too: a session resumed later comes back at its place
  const shownIds = new Set(drawnTiles(r).flatMap((t) => [...t.members, ...(t.closed ?? [])].map((x) => x.id)));
  const shownStacks = new Set(drawnTiles(r).map((t) => t.stack));
  const hiddenPlaces = Object.entries(l.workspaces).filter(([id]) => !shownIds.has(id));
  const hiddenStacks = Object.entries(l.stacks).filter(([k]) => !shownStacks.has(k));
  const drawn: [string, Rect][] = [
    ...drawnTiles(r).map((t): [string, Rect] => [`${t.key} (${t.area})`, t.rect]),
    ...r.windows.map((w): [string, Rect] => [`window ${w.id}`, w.rect]),
    ...r.cards.map((c): [string, Rect] => [`card ${c.id}`, c.rect]),
    ...hiddenPlaces.map(([id, x]): [string, Rect] => [`hidden place ${id}`, x]),
    ...hiddenStacks.map(([k, x]): [string, Rect] => [`hidden stack ${k}`, x.placement]),
  ];
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      expect(overlaps(drawn[i][1], drawn[j][1]), `${drawn[i][0]} and ${drawn[j][0]} don't overlap: ${JSON.stringify([drawn[i][1], drawn[j][1]])}`).toBe(false);
    }
  }
  const areaOf = Object.fromEntries(areas);
  for (const t of drawnTiles(r)) {
    const a = own(areaOf, t.area);
    if (a) expect(within(t.rect, a), `${t.key} is inside ${t.area}: ${JSON.stringify([t.rect, a])}`).toBe(true);
    else expect(areas.filter(([, x]) => overlaps(t.rect, x)).map(([k]) => k), `${t.key}, in no area, is over none: ${JSON.stringify(t.rect)}`).toEqual([]);
  }
}

/** A locked area's rect and what's in it, drawn or not, by what stands for each. */
function lockedNow(w: World, r: ResolvedLayout): Map<string, { rect: Area; items: Map<string, Rect> }> {
  const out = new Map<string, { rect: Area; items: Map<string, Rect> }>();
  for (const a of r.areas) {
    if (!a.rect.locked) continue;
    const items = new Map<string, Rect>();
    for (const t of drawnTiles(r)) if (t.area === a.key) items.set(idOf(t), t.rect);
    for (const c of r.cards) if (c.card.area === a.key) items.set(`card:${c.id}`, c.rect);
    for (const v of r.windows) if (v.area === a.key) items.set(`tool:${v.id}`, v.rect);
    for (const [id, p] of Object.entries(w.l.workspaces)) if (!items.has(id) && within(p, a.rect)) items.set(id, p);
    for (const [k, s] of Object.entries(w.l.stacks)) if (!items.has(k) && within(s.placement, a.rect)) items.set(k, s.placement);
    out.set(a.key, { rect: a.rect, items });
  }
  return out;
}

/** A locked area, if it's still there and locked: moved as a whole, each thing still in it where it was inside it. */
function assertLockedKept(before: ReturnType<typeof lockedNow>, after: ReturnType<typeof lockedNow>, op: Step): void {
  for (const [key, was] of before) {
    const now = after.get(key);
    if (!now) continue;
    const [dx, dy] = [now.rect.x - was.rect.x, now.rect.y - was.rect.y];
    if ((dx || dy) && was.items.size) count("locked area moved with things in it");
    // only what comes to rest in it makes it grow (a session placed there, a closed one of a merge), never smaller
    if (op.grows !== key) expect([now.rect.w, now.rect.h], `locked ${key} keeps its size`).toEqual([was.rect.w, was.rect.h]);
    for (const [id, r] of was.items) {
      const moved = now.items.get(id);
      if (moved) expect([moved.x - r.x, moved.y - r.y, moved.w, moved.h], `${id} stays put inside locked ${key}, moved ${dx}, ${dy}`).toEqual([dx, dy, r.w, r.h]);
    }
  }
}

/** What's drawn and pushes (workspaces, windows, cards) in area `key`, by what stands for each. */
function pushersIn(r: ResolvedLayout, key: string, mover: string): Map<string, Rect> {
  const out = new Map<string, Rect>();
  for (const t of r.tiles) if (t.area === key && !t.members.some((m) => m.id === mover)) out.set(idOf(t), t.rect);
  for (const v of r.windows) if ((v.area ?? LOOSE_GROUP) === key) out.set(`tool:${v.id}`, v.rect);
  for (const c of r.cards) if (r.areas.some((a) => a.key === c.card.area) ? c.card.area === key : key === LOOSE_GROUP) out.set(`card:${c.id}`, c.rect);
  return out;
}

/**
 * Only what's drawn pushes. Each thing that moved in area `key` when `mover` came to rest at `at` was reached by it, or
 * by something else drawn that moved (from where it was to where it went): one that nothing drawn reached was pushed by
 * a ghost or a place nobody sees.
 */
function assertOnlyDrawnPushed(before: ResolvedLayout, after: ResolvedLayout, key: string, mover: string, at: Rect): void {
  const a = before.areas.find((x) => x.key === key)?.rect;
  const b = after.areas.find((x) => x.key === key)?.rect;
  if (a && (!b || a.x !== b.x || a.y !== b.y)) return;
  const was = pushersIn(before, key, mover);
  const now = pushersIn(after, key, mover);
  const moved = [...was].filter(([id, r]) => {
    const n = now.get(id);
    return n && (n.x !== r.x || n.y !== r.y);
  });
  const reach: Rect[] = [at];
  // a tab taken out of a stack: what's left of the stack is drawn too, and pushes as it goes
  const stack = before.tiles.find((t) => t.members.length > 1 && t.members.some((m) => m.id === mover));
  const rest = stack && after.tiles.find((t) => t.members.some((m) => m.id !== mover && stack.members.some((x) => x.id === m.id)));
  if (stack && rest) reach.push(hull(stack.rect, rest.rect));
  const left = new Map(moved);
  for (let found = true; found; ) {
    found = false;
    for (const [id, r] of left) {
      if (!reach.some((f) => overlaps(f, r, GAP - 1e-6))) continue;
      reach.push(hull(r, now.get(id)!));
      left.delete(id);
      found = true;
    }
  }
  expect([...left.keys()], `only what's drawn pushes: nothing drawn reached these in ${key} when ${mover} came to rest at ${JSON.stringify(at)}`).toEqual([]);
  if (moved.length) count("step that pushed what's drawn");
}

/**
 * What a step did: said for a failure's log. `kind`: what it's counted as, when that isn't its first word. `mover`: the
 * session it moved or resized, `planned` where the plan put it, which it stays at, `at` where it was asked for, which a
 * drop in an area keeps to its inside, and `into` the area it came to rest in. `grows`: the locked area it may grow.
 */
type Step = { say: string; kind?: string; mover?: string; planned?: Rect; at?: Rect; into?: string; grows?: string };

/** Where `id` is stored now: its stack's place while it's a tab, else its own. */
function storedPlace(w: Pick<World, "l" | "live" | "closed">, id: string): Rect | undefined {
  const s = [...w.live, ...w.closed].find((x) => x.id === id);
  const sk = s ? stackKeyOf(s) : null;
  return (sk ? own(w.l.stacks, sk)?.placement : undefined) ?? own(w.l.workspaces, id);
}

/** A plan carried out as main.tsx does, a layout pass after each part as in the app: its patch, the sessions' groups, then `after`. Refused: not done. `planned`: where it puts `mover`, before any pass has had a say. */
function carry(w: World, p: AreaPlan, mover?: string): { done: boolean; planned?: Rect } {
  if ("refused" in p) return { done: false };
  const groups = new Map(p.moves.map((m) => [m.id, m.group]));
  const move = (list: SessionInfo[]) => list.map((s) => (groups.has(s.id) ? { ...s, taskGroup: groups.get(s.id) ?? null } : s));
  const planned = mover ? storedPlace({ l: apply(apply(w.l, p.patch), p.after), live: move(w.live), closed: move(w.closed) }, mover) : undefined;
  w.l = apply(w.l, p.patch);
  midPass(w);
  w.live = move(w.live);
  w.closed = move(w.closed);
  midPass(w);
  w.l = apply(w.l, p.after);
  return { done: true, planned };
}

/** One run of `steps` random steps from `seed`. */
function run(seed: number, steps: number): void {
  const rnd = randomFrom(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <V>(xs: readonly V[]): V | undefined => xs[Math.floor(rnd() * xs.length)];
  let made = 0;
  const fresh = (prefix = "s") => `${prefix}${++made}`;

  const w: World = { l: emptyLandscape(), live: [], closed: [], renames: [] };
  // four areas in a tight grid, then sessions placed by the layout, as new ones are
  const [AW, AH] = [1400, 900];
  ["A", "B", "C", "D"].forEach((k, i) => (w.l.areas[k] = { x: (i % 2) * (AW + AREA_GAP), y: Math.floor(i / 2) * (AH + AREA_GAP), w: AW, h: AH, repos: [] }));
  // lying in another group's area, as ghosts and places can: a closed session and a closed stack of D's inside A, and places under A's and B's names inside D and C
  const inA = (dx: number): Rect => ({ x: AREA_PAD + dx, y: AREA_HEADER, w: 400, h: 240 });
  w.l.workspaces.other = inA(0);
  w.closed.push(session("other", "D", "dead"));
  w.l.stacks["D/old"] = { active: "otab", placement: inA(440) };
  w.closed.push(session("otab", "D/old", "dead"));
  w.l.stacks["A/away"] = { active: "gone", placement: { x: w.l.areas.D.x + AREA_PAD, y: w.l.areas.D.y + AREA_HEADER, w: 400, h: 240 } };
  w.l.stacks["B/away"] = { active: "gone", placement: { x: w.l.areas.C.x + AREA_PAD, y: w.l.areas.C.y + AREA_HEADER, w: 400, h: 240 } };
  for (const k of ["A", "B", "C", "D"]) for (let i = int(1, 3); i > 0; i--) w.live.push(session(fresh(), k));
  w.live.push(session(fresh(), null));
  const looseOne = session(fresh(), null);
  w.live.push(looseOne);
  settle(w);
  // ghosts, one of them loose, and places nothing draws (a session that's gone from both lists, its place kept)
  w.live = w.live.filter((x) => x !== looseOne);
  w.closed.push({ ...looseOne, status: "dead" });
  for (let i = 0; i < 2 && w.live.length > 3; i++) {
    const s = pick(w.live)!;
    w.live = w.live.filter((x) => x !== s);
    w.closed.push({ ...s, status: "dead" });
  }
  const hide = pick(w.live)!;
  w.live = w.live.filter((x) => x !== hide);
  if (rnd() < 0.5) w.l.areas.B.locked = true;
  w.l.tools.t0 = { tool: "artifacts", docked: false, area: "C" };
  w.l.tools.t1 = { tool: "files", docked: false, session: "s1", area: null, placement: { x: -3000, y: -3000, w: 800, h: 400 } };
  w.l.cards.c0 = { area: "D", shelf: "area:D", artifact: "a" };
  w.l.ghosts.g0 = { title: "g0", agent: "claude", cwd: "/r", repoPath: null, placement: { x: 3000, y: 3000, w: 400, h: 300 }, group: "C", closedAt: "x" };
  settle(w);

  const log: string[] = [];
  const point = (a: Rect | null, tile: Rect) => {
    if (a) return { x: snap(a.x + int(-200, a.w)), y: snap(a.y + int(-200, a.h)) };
    return { x: snap(tile.x + int(-1600, 1600)), y: snap(tile.y + int(-1200, 1200)) };
  };

  const ops: (() => Step | null)[] = [];
  const add = (weight: number, op: (r: ResolvedLayout) => Step | null) => {
    for (let i = 0; i < weight; i++) ops.push(() => op(now));
  };
  let now = settle(w);
  const areaKeys = () => now.areas.map((a) => a.key);
  const rectOfArea = (k: string) => now.areas.find((a) => a.key === k)!.rect;
  const gesturable = (r: ResolvedLayout) => r.tiles.filter((t) => !t.hidden);
  const remapped = (list: SessionInfo[], from: string, to: string) => list.map((s) => (areaKeyOf(s) === from ? { ...s, taskGroup: to + s.taskGroup!.slice(from.length) } : s));
  const forRename = () => w.closed.map((s) => ({ id: s.id, taskGroup: s.taskGroup }));

  add(6, (r) => {
    const t = pick(gesturable(r));
    if (!t) return null;
    const target = rnd() < 0.7 ? t.area : rnd() < 0.8 ? pick(areaKeys())! : LOOSE_GROUP;
    const a = target === LOOSE_GROUP ? null : rectOfArea(target);
    const at = point(a, t.rect);
    const want = a ? { x: Math.max(at.x, snapUp(a.x + AREA_PAD)), y: Math.max(at.y, snapUp(a.y + AREA_HEADER)), w: t.rect.w, h: t.rect.h } : undefined;
    // a stack of its name there already takes its tabs in where that one is
    const joined = !!t.stack && target !== t.area && Object.hasOwn(w.l.stacks, `${target}/${t.stack.slice(t.stack.indexOf("/") + 1)}`);
    const { done, planned } = carry(w, planMoveTile(w.l, r, t.key, at, target, T), t.front.id);
    if (!done) return { say: `move ${t.key} to ${target}: refused` };
    return { say: `move ${t.key} from ${t.area} to ${target} at ${at.x},${at.y}${joined ? ", joining its namesake" : ""}`, mover: t.front.id, planned, at: joined ? undefined : want, into: joined ? undefined : target };
  });
  add(3, (r) => {
    const t = pick(gesturable(r));
    if (!t) return null;
    const to = { x: t.rect.x + GRID * int(-20, 20), y: t.rect.y + GRID * int(-20, 20), w: t.rect.w + GRID * int(-30, 30), h: t.rect.h + GRID * int(-30, 30) };
    const { done, planned } = carry(w, planResizeTo(w.l, r, t.key, to, T), t.front.id);
    if (!done) return { say: `resize ${t.key}: refused` };
    return { say: `resize ${t.key} in ${t.area} to ${JSON.stringify(to)}`, mover: t.front.id, planned, into: t.area };
  });
  add(2, (r) => {
    const t = pick(gesturable(r));
    if (!t) return null;
    const preset = pick(["S", "M", "L"] as const)!;
    const { done, planned } = carry(w, planResizeTile(w.l, r, t.key, presetFor(t, preset), T), t.front.id);
    if (!done) return { say: `preset ${preset} on ${t.key}: refused` };
    return { say: `preset ${preset} on ${t.key} in ${t.area}`, mover: t.front.id, planned, into: t.area };
  });
  add(2, (r) => {
    const a = pick(gesturable(r));
    const b = pick(gesturable(r).filter((t) => a && t.area === a.area && t !== a));
    if (!a || !b) return null;
    const { done } = carry(w, planStack(w.l, r, [a.key, b.key], T));
    return { say: `stack ${a.key} and ${b.key} in ${a.area}${done ? "" : ": refused"}` };
  });
  add(2, (r) => {
    const t = pick(gesturable(r).filter((x) => x.stack && x.members.length > 1));
    const s = t && pick(t.members);
    if (!t || !s) return null;
    const target = rnd() < 0.7 ? t.area : pick(areaKeys())!;
    const a = own(Object.fromEntries(r.areas.map((x) => [x.key, x.rect])), target);
    if (!a) return null;
    const at = point(a, t.rect);
    const { done, planned } = carry(w, planUnstack(w.l, r, s.id, at, target, T), s.id);
    if (!done) return { say: `unstack ${s.id}: refused` };
    return { say: `unstack ${s.id} from ${t.key} to ${target} at ${at.x},${at.y}`, mover: s.id, planned, into: target };
  });
  add(1, (r) => {
    const k = pick(areaKeys());
    if (!k || tidyRefusal(r, k, T)) return null;
    carry(w, planTidy(w.l, r, k, T));
    return { say: `tidy ${k}` };
  });
  add(1, (r) => {
    const s = pick(w.closed);
    if (!s) return null;
    w.l = apply(w.l, forgetPatch(w.l, r, [s.id]));
    w.closed = w.closed.filter((x) => x !== s);
    return { say: `forget ${s.id}` };
  });
  add(2, () => {
    const s = pick(w.closed);
    if (!s) return null;
    w.closed = w.closed.filter((x) => x !== s);
    w.live.push({ ...s, status: "idle" });
    // as main does on a reopen: a place outside its own area goes
    w.l = apply(w.l, reopenPatch(w.l, s));
    return { say: `reopen ${s.id}`, grows: areaKeyOf(s) };
  });
  add(2, () => {
    const s = pick(w.live);
    if (!s) return null;
    w.live = w.live.filter((x) => x !== s);
    w.closed.push({ ...s, status: "dead" });
    return { say: `close ${s.id}` };
  });
  add(1, () => {
    const s = pick(w.live);
    if (!s) return null;
    w.live = w.live.filter((x) => x !== s);
    return { say: `${s.id} goes from both lists, its place kept`, kind: "hide" };
  });
  add(2, () => {
    const k = rnd() < 0.8 ? pick(areaKeys()) : undefined;
    const s = session(fresh(), k ?? null);
    w.live.push(s);
    return { say: `new ${s.id} in ${k ?? "no area"}`, grows: k };
  });
  add(2, () => {
    const [from, to] = [pick(areaKeys()), pick(areaKeys())];
    if (!from || !to || from === to || now.areas.length < 3) return null;
    const a = rectOfArea(from);
    // the closed sessions lying inside it, of any group: what a merge keeps
    const keep = w.closed.filter((s) => {
      const p = storedPlace(w, s.id);
      return p && within(p, a);
    });
    const members = w.live.filter((s) => areaKeyOf(s) === from).map((s) => s.id);
    w.l = apply(w.l, renameAreaPatch(w.l, from, to, members, forRename()));
    w.live = remapped(w.live, from, to);
    w.closed = remapped(w.closed, from, to);
    for (const s of keep) {
      const p = storedPlace(w, s.id);
      expect(p, `merging ${from} into ${to} keeps closed ${s.id}'s place`).toBeDefined();
      expect(within(p!, w.l.areas[to]), `closed ${s.id} is inside ${to} after merging ${from} into it: ${JSON.stringify([p, w.l.areas[to]])}`).toBe(true);
    }
    expect(Object.keys(w.l.stacks).filter((k) => k === from || k.startsWith(`${from}/`)), `nothing's left under ${from}'s name after it's merged into ${to}`).toEqual([]);
    for (const id of members) if (!Object.hasOwn(w.l.workspaces, id)) count("member's place let go by a merge");
    return { say: `merge ${from} into ${to}`, grows: to };
  });
  add(1, () => {
    const from = pick(areaKeys());
    if (!from) return null;
    const to = fresh("N");
    const members = w.live.filter((s) => areaKeyOf(s) === from).map((s) => s.id);
    w.l = apply(w.l, renameAreaPatch(w.l, from, to, members, forRename()));
    w.live = remapped(w.live, from, to);
    w.closed = remapped(w.closed, from, to);
    return { say: `rename ${from} to ${to}` };
  });
  // a rename on its way: the session list and the landscape's re-keying arrive one after the other, in either order,
  // and a second rename can follow before the first has arrived. Meanwhile nothing's saved or formed
  add(2, () => {
    const from = pick(areaKeys());
    if (!from) return null;
    const to = fresh("N");
    const then = rnd() < 0.5 ? fresh("N") : null;
    const names = new Set([...areaKeys(), to, ...(then ? [then] : [])]);
    const calm = (when: string) => {
      const r = pass(w);
      expect(r.patch, `nothing's saved while ${from}'s rename is on its way (${when})`).toBeNull();
      expect(r.areas.map((a) => a.key).filter((k) => !names.has(k)), `no area forms while ${from}'s rename is on its way (${when})`).toEqual([]);
    };
    const sessions = () => {
      w.live = remapped(w.live, from, to);
      w.closed = remapped(w.closed, from, to);
      if (then) {
        w.live = remapped(w.live, to, then);
        w.closed = remapped(w.closed, to, then);
      }
    };
    const rekey = () => {
      w.l = apply(w.l, renameAreaPatch(w.l, from, to, [], []));
      if (then) w.l = apply(w.l, renameAreaPatch(w.l, to, then, [], []));
    };
    w.renames = then ? [{ from, to }, { from: to, to: then }] : [{ from, to }];
    if (rnd() < 0.5) {
      sessions();
      calm("the sessions first");
      rekey();
    } else {
      rekey();
      calm("the landscape first");
      sessions();
    }
    calm("both there");
    w.renames = [];
    return { say: `rename ${from} to ${to}${then ? ` then ${then}` : ""}, on its way`, kind: then ? "chained rename on its way" : "rename on its way" };
  });
  add(1, (r) => {
    const k = pick(areaKeys());
    if (!k) return null;
    const locked = !rectOfArea(k).locked;
    w.l = apply(w.l, { areas: { [k]: { locked } } });
    void r;
    return { say: `${locked ? "lock" : "unlock"} ${k}` };
  });
  add(1, () => {
    const k = pick(areaKeys());
    if (!k) return null;
    const collapsed = !rectOfArea(k).collapsed;
    w.l = apply(w.l, { areas: { [k]: { collapsed } } });
    return { say: `${collapsed ? "collapse" : "open"} ${k}`, kind: "collapse" };
  });
  add(2, (r) => {
    const k = pick(areaKeys());
    if (!k) return null;
    const [dx, dy] = [GRID * int(-100, 100), GRID * int(-100, 100)];
    const { done } = carry(w, planMoveArea(w.l, r, k, dx, dy, T));
    return { say: `move area ${k} by ${dx},${dy}${done ? "" : ": refused"}`, kind: "move area" };
  });
  add(2, (r) => {
    const g = pick(r.ghosts.filter((x) => x.area === LOOSE_GROUP));
    const a = pick(r.areas.filter((x) => !x.rect.locked));
    if (!g || !a) return null;
    // its right end coming to rest over the ghost
    const [dx, dy] = [g.rect.x + g.rect.w / 2 - (a.rect.x + a.rect.w), g.rect.y - a.rect.y];
    const { done } = carry(w, planMoveArea(w.l, r, a.key, dx, dy, T));
    return { say: `move area ${a.key} over ghost ${g.key}${done ? "" : ": refused"}`, kind: "move area over a ghost" };
  });
  add(1, (r) => {
    const t = pick(gesturable(r));
    const k = pick(r.areas.filter((a) => !a.rect.collapsed).map((a) => a.key));
    const id = fresh("t");
    if (t && rnd() < 0.5) return carry(w, planOpenWindow(w.l, r, id, "files", { session: t.front.id }, T)).done ? { say: `window ${id} beside ${t.key}` } : { say: `window ${id}: refused` };
    if (k) return carry(w, planOpenWindow(w.l, r, id, "artifacts", { area: k }, T)).done ? { say: `window ${id} in ${k}` } : { say: `window ${id}: refused` };
    return null;
  });

  for (let i = 0; i < steps; i++) {
    const before = now;
    const lockedBefore = lockedNow(w, now);
    const replay = () => `seed ${seed}, step ${i}:\n  ${log.slice(-6).join("\n  ")}`;
    try {
      const step = pick(ops)!();
      if (!step) continue;
      log.push(step.say);
      if (!step.say.endsWith(": refused")) count(step.kind ?? step.say.split(" ")[0]);
      now = settle(w);
      assertSound(now, w.l);
      assertLockedKept(lockedBefore, lockedNow(w, now), step);
      if (now.ghosts.length) count("step with ghosts");
      if (now.areas.some((a) => a.rect.locked)) count("step with a locked area");
      if (now.areas.some((a) => a.rect.collapsed)) count("step with a collapsed area");
      if (Object.keys(w.l.workspaces).some((id) => ![...w.live, ...w.closed].some((x) => x.id === id))) count("step with a hidden place");
      if (step.mover && step.planned) {
        const t = now.tiles.find((x) => x.members.some((m) => m.id === step.mover));
        expect(t?.rect, `${step.mover} stays where the plan put it`).toEqual(step.planned);
        if (step.into) assertOnlyDrawnPushed(before, now, step.into, step.mover, step.planned);
      }
      if (step.mover && step.at) expect(storedPlace(w, step.mover), `${step.mover} is where it was dropped, inside its area`).toEqual(step.at);
    } catch (err) {
      (err as Error).message = `${replay()}\n${(err as Error).message}`;
      throw err;
    }
  }
}

describe("the landscape's layout under random gestures", () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`keeps its promises from seed ${seed}`, () => run(seed, 120));
  }

  it("tried every gesture, among ghosts, hidden places, and locked and collapsed areas", () => {
    for (const what of ["move", "move area", "move area over a ghost", "resize", "preset", "stack", "unstack", "tidy", "forget", "reopen", "close", "hide", "new", "merge", "rename", "rename on its way", "chained rename on its way", "lock", "unlock", "collapse", "window", "locked area moved with things in it", "step that pushed what's drawn"]) {
      expect(seen.get(what) ?? 0, what).toBeGreaterThanOrEqual(10);
    }
    for (const what of ["step with ghosts", "step with a locked area", "step with a collapsed area", "step with a hidden place"]) expect(seen.get(what) ?? 0, what).toBeGreaterThanOrEqual(500);
  });
});
