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
  type ResolvedLayout,
  type Tile,
} from "../src/renderer/landscapeModel";
import { AREA_GAP, AREA_HEADER, AREA_PAD, GRID, LOOSE_GROUP, applyPatch, areaKeyOf, emptyLandscape, overlaps, own, parsePatch, renameAreaPatch, snap, snapUp, stackKeyOf, within, type Area, type Landscape, type LandscapePatch, type Rect } from "../src/shared/landscape";
import type { SessionInfo } from "../src/shared/types";

// The layout's promises under random gestures, from fixed seeds so a failure replays: moves, resizes, presets, stacks,
// unstacks, Tidy, forgetting, reopening and merges, among ghosts, places nothing draws (hidden) and locked areas. After
// every step, a layout pass settles what the step left, and these hold: areas stay AREA_GAP apart; nothing drawn
// overlaps; a workspace in an area is inside it; a locked area moves as a whole, its insides where they were; the
// workspace moved or resized stays where it was put; and what's in which area doesn't change on a second pass.

type World = { l: Landscape; live: SessionInfo[]; closed: SessionInfo[] };

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
const pass = (w: World) => resolveLayout(w.l, w.live, undefined, [], null, w.closed);
const drawnTiles = (r: ResolvedLayout) => [...r.tiles, ...r.ghosts];
/** What stands for a tile across steps: its stack's key, else its session's id. A stack's key changes only when it moves area. */
const idOf = (t: Tile) => t.stack ?? t.front.id;

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
  for (const t of r.tiles) {
    const a = own(Object.fromEntries(areas), t.area);
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

/** What a step did: said for a failure's log. `mover`: the session it moved or resized, which stays where the plan put it. `at`: where the step asked for it, which a drop in an area keeps to its inside. `grows`: the locked area it may grow. */
type Step = { say: string; mover?: string; at?: Rect; grows?: string };

/** A plan carried out as main.tsx does: its patch, the sessions' groups, then `after`. False when it was refused. */
function carry(w: World, p: AreaPlan): boolean {
  if ("refused" in p) return false;
  w.l = apply(w.l, p.patch);
  const groups = new Map(p.moves.map((m) => [m.id, m.group]));
  const move = (list: SessionInfo[]) => list.map((s) => (groups.has(s.id) ? { ...s, taskGroup: groups.get(s.id) ?? null } : s));
  w.live = move(w.live);
  w.closed = move(w.closed);
  w.l = apply(w.l, p.after);
  return true;
}

/** Where `id` is stored now: its stack's place while it's a tab, else its own. */
function storedPlace(w: World, id: string): Rect | undefined {
  const s = [...w.live, ...w.closed].find((x) => x.id === id);
  const sk = s ? stackKeyOf(s) : null;
  return (sk ? own(w.l.stacks, sk)?.placement : undefined) ?? own(w.l.workspaces, id);
}

/** One run of `steps` random steps from `seed`. */
function run(seed: number, steps: number): void {
  const rnd = randomFrom(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <V>(xs: readonly V[]): V | undefined => xs[Math.floor(rnd() * xs.length)];
  let made = 0;
  const fresh = (prefix = "s") => `${prefix}${++made}`;

  const w: World = { l: emptyLandscape(), live: [], closed: [] };
  // four areas in a row, then sessions placed by the layout, as new ones are
  ["A", "B", "C", "D"].forEach((k, i) => (w.l.areas[k] = { x: i * 1600, y: 0, w: 1400, h: 900, repos: [] }));
  for (const k of ["A", "B", "C", "D"]) for (let i = int(1, 3); i > 0; i--) w.live.push(session(fresh(), k));
  w.live.push(session(fresh(), null));
  settle(w);
  // ghosts, and places nothing draws (a session that's gone from both lists, its place kept)
  for (let i = 0; i < 2 && w.live.length > 3; i++) {
    const s = pick(w.live)!;
    w.live = w.live.filter((x) => x !== s);
    w.closed.push({ ...s, status: "dead" });
  }
  const hide = pick(w.live)!;
  w.live = w.live.filter((x) => x !== hide);
  w.l.areas.B.locked = rnd() < 0.5 || undefined;
  if (!w.l.areas.B.locked) delete w.l.areas.B.locked;
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

  add(6, (r) => {
    const t = pick(r.tiles);
    if (!t) return null;
    const target = rnd() < 0.7 ? t.area : rnd() < 0.8 ? pick(areaKeys())! : LOOSE_GROUP;
    const a = target === LOOSE_GROUP ? null : rectOfArea(target);
    const at = point(a, t.rect);
    const want = a ? { x: Math.max(at.x, snapUp(a.x + AREA_PAD)), y: Math.max(at.y, snapUp(a.y + AREA_HEADER)), w: t.rect.w, h: t.rect.h } : undefined;
    const before = w.l.stacks;
    if (!carry(w, planMoveTile(w.l, r, t.key, at, target, T))) return { say: `move ${t.key} to ${target}: refused` };
    // a stack of its name there already takes its tabs in where that one is
    const joined = !!t.stack && target !== t.area && Object.hasOwn(before, `${target}/${t.stack.slice(t.stack.indexOf("/") + 1)}`);
    return { say: `move ${t.key} from ${t.area} to ${target} at ${at.x},${at.y}${joined ? ", joining its namesake" : ""}`, mover: t.front.id, at: joined ? undefined : want };
  });
  add(3, (r) => {
    const t = pick(r.tiles);
    if (!t) return null;
    const to = { x: t.rect.x + GRID * int(-20, 20), y: t.rect.y + GRID * int(-20, 20), w: t.rect.w + GRID * int(-30, 30), h: t.rect.h + GRID * int(-30, 30) };
    if (!carry(w, planResizeTo(w.l, r, t.key, to, T))) return { say: `resize ${t.key}: refused` };
    return { say: `resize ${t.key} in ${t.area} to ${JSON.stringify(to)}`, mover: t.front.id };
  });
  add(2, (r) => {
    const t = pick(r.tiles);
    if (!t) return null;
    const preset = pick(["S", "M", "L"] as const)!;
    if (!carry(w, planResizeTile(w.l, r, t.key, presetFor(t, preset), T))) return { say: `preset ${preset} on ${t.key}: refused` };
    return { say: `preset ${preset} on ${t.key} in ${t.area}`, mover: t.front.id };
  });
  add(2, (r) => {
    const a = pick(r.tiles);
    const b = pick(r.tiles.filter((t) => a && t.area === a.area && t !== a));
    if (!a || !b) return null;
    const done = carry(w, planStack(w.l, r, [a.key, b.key], T));
    return { say: `stack ${a.key} and ${b.key} in ${a.area}${done ? "" : ": refused"}` };
  });
  add(2, (r) => {
    const t = pick(r.tiles.filter((x) => x.stack && x.members.length > 1));
    const s = t && pick(t.members);
    if (!t || !s) return null;
    const target = rnd() < 0.7 ? t.area : pick(areaKeys())!;
    const a = own(Object.fromEntries(r.areas.map((x) => [x.key, x.rect])), target);
    if (!a) return null;
    const at = point(a, t.rect);
    if (!carry(w, planUnstack(w.l, r, s.id, at, target, T))) return { say: `unstack ${s.id}: refused` };
    return { say: `unstack ${s.id} from ${t.key} to ${target} at ${at.x},${at.y}`, mover: s.id };
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
    return { say: `${s.id} goes from both lists, its place kept` };
  });
  add(2, () => {
    const k = rnd() < 0.8 ? pick(areaKeys()) : undefined;
    const s = session(fresh(), k ?? null);
    w.live.push(s);
    return { say: `new ${s.id} in ${k ?? "no area"}`, grows: k };
  });
  add(1, () => {
    const [from, to] = [pick(areaKeys()), pick(areaKeys())];
    if (!from || !to || from === to || now.areas.length < 3) return null;
    const remap = (s: SessionInfo) => (areaKeyOf(s) === from ? { ...s, taskGroup: to + s.taskGroup!.slice(from.length) } : s);
    const members = w.live.filter((s) => areaKeyOf(s) === from).map((s) => s.id);
    w.l = apply(w.l, renameAreaPatch(w.l, from, to, members, w.closed.map((s) => ({ id: s.id, taskGroup: s.taskGroup }))));
    w.live = w.live.map(remap);
    w.closed = w.closed.map(remap);
    return { say: `merge ${from} into ${to}`, grows: to };
  });
  add(1, () => {
    const from = pick(areaKeys());
    if (!from) return null;
    const to = fresh("N");
    const remap = (s: SessionInfo) => (areaKeyOf(s) === from ? { ...s, taskGroup: to + s.taskGroup!.slice(from.length) } : s);
    const members = w.live.filter((s) => areaKeyOf(s) === from).map((s) => s.id);
    w.l = apply(w.l, renameAreaPatch(w.l, from, to, members, w.closed.map((s) => ({ id: s.id, taskGroup: s.taskGroup }))));
    w.live = w.live.map(remap);
    w.closed = w.closed.map(remap);
    return { say: `rename ${from} to ${to}` };
  });
  add(1, (r) => {
    const k = pick(areaKeys());
    if (!k) return null;
    const locked = !rectOfArea(k).locked;
    w.l = apply(w.l, { areas: { [k]: { locked } } });
    void r;
    return { say: `${locked ? "lock" : "unlock"} ${k}` };
  });
  add(2, (r) => {
    const k = pick(areaKeys());
    if (!k) return null;
    const [dx, dy] = [GRID * int(-100, 100), GRID * int(-100, 100)];
    const done = carry(w, planMoveArea(w.l, r, k, dx, dy, T));
    return { say: `move area ${k} by ${dx},${dy}${done ? "" : ": refused"}` };
  });
  add(1, (r) => {
    const t = pick(r.tiles);
    const k = pick(areaKeys());
    const id = fresh("t");
    if (t && rnd() < 0.5) return carry(w, planOpenWindow(w.l, r, id, "files", { session: t.front.id }, T)) ? { say: `window ${id} beside ${t.key}` } : { say: `window ${id}: refused` };
    if (k) return carry(w, planOpenWindow(w.l, r, id, "artifacts", { area: k }, T)) ? { say: `window ${id} in ${k}` } : { say: `window ${id}: refused` };
    return null;
  });

  for (let i = 0; i < steps; i++) {
    const lockedBefore = lockedNow(w, now);
    const step = pick(ops)!();
    if (!step) continue;
    log.push(step.say);
    if (!step.say.endsWith(": refused")) count(step.say.startsWith("move area") ? "move area" : /^s\d+ goes/.test(step.say) ? "hide" : step.say.split(" ")[0]);
    const replay = () => `seed ${seed}, step ${i}:\n  ${log.slice(-6).join("\n  ")}`;
    try {
      const placed = step.mover ? storedPlace(w, step.mover) : undefined;
      now = settle(w);
      assertSound(now, w.l);
      if (now.ghosts.length) count("step with ghosts");
      if (now.areas.some((a) => a.rect.locked)) count("step with a locked area");
      if (Object.keys(w.l.workspaces).some((id) => ![...w.live, ...w.closed].some((x) => x.id === id))) count("step with a hidden place");
      assertLockedKept(lockedBefore, lockedNow(w, now), step);
      if (step.mover && placed) {
        const t = now.tiles.find((x) => x.members.some((m) => m.id === step.mover));
        expect(t?.rect, `${step.mover} stays where the plan put it`).toEqual(placed);
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

  it("tried every gesture, among ghosts, hidden places and locked areas", () => {
    for (const what of ["move", "move area", "resize", "preset", "stack", "unstack", "tidy", "forget", "reopen", "close", "hide", "new", "merge", "rename", "lock", "unlock", "window", "locked area moved with things in it"]) {
      expect(seen.get(what) ?? 0, what).toBeGreaterThanOrEqual(10);
    }
    for (const what of ["step with ghosts", "step with a locked area", "step with a hidden place"]) expect(seen.get(what) ?? 0, what).toBeGreaterThanOrEqual(1000);
  });
});
