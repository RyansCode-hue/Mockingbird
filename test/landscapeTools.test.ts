import { describe, expect, it } from "vitest";
import {
  CARD_SIZE,
  cameraForOpened,
  inView,
  TOOL_HEIGHT,
  TOOL_WIDTH,
  newExtraId,
  planDockWindow,
  planMoveArea,
  planMoveExtra,
  planOpenWindow,
  planPlaceCard,
  planResizeTile,
  resolveLayout,
  cardShelf,
  cardsAfterShare,
  compactShifts,
  mentionTarget,
  sameScope,
  tileSize,
  toolSize,
  type AreaPlan,
} from "../src/renderer/landscapeModel";
import {
  AREA_GAP,
  AREA_HEADER,
  AREA_PAD,
  GAP,
  applyPatch,
  emptyLandscape,
  overlaps,
  parseLandscape,
  parsePatch,
  presetSize,
  renameAreaPatch,
  WORKSPACE_CHROME,
  type Area,
  type Landscape,
  type Rect,
} from "../src/shared/landscape";
import type { SessionInfo } from "../src/shared/types";

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  title: id,
  repoPath: "/r",
  cwd: "/r",
  branch: null,
  ticketId: null,
  ticketTitle: null,
  taskGroup: null,
  status: "idle",
  createdAt: 0,
  kind: "work",
  extraDirs: [],
  waitingReason: null,
  waitingSince: null,
  agent: "claude",
  ...over,
});
const theirs = (id: string, group: string) =>
  session(id, { taskGroup: group, room: { roomId: "R", sessionId: id, owner: "nick", ownerName: "Nick", remote: true, live: true } as SessionInfo["room"] });

const M = presetSize("agent", "M");
const S = presetSize("agent", "S");
const area = (x: number, y: number, w: number, h: number, more: Partial<Area> = {}): Area => ({ x, y, w, h, repos: [], ...more });
const inside = (r: Rect, a: Rect) => r.x >= a.x && r.y >= a.y && r.x + r.w <= a.x + a.w && r.y + r.h <= a.y + a.h;
const title = (k: string) => k;
const ready = (p: AreaPlan) => {
  if ("refused" in p) throw new Error(`refused: ${p.refused}`);
  return p;
};
const apply = (l: Landscape, p: AreaPlan) => applyPatch(l, parsePatch(ready(p).patch ?? {}));

/** Area "a" holding workspace s1 at its top-left, and area "b" to its right. */
function twoAreas(more: Partial<Area> = {}): { l: Landscape; sessions: SessionInfo[] } {
  const a = area(0, 0, M.w + 2 * AREA_PAD, M.h + AREA_HEADER + AREA_PAD, more);
  const l: Landscape = {
    ...emptyLandscape(),
    areas: { a, b: area(a.w + 400, 0, 1200, 1200) },
    workspaces: { s1: { x: AREA_PAD, y: AREA_HEADER, ...M } },
  };
  return { l, sessions: [session("s1", { taskGroup: "a" })] };
}

describe("a tool window's size", () => {
  it("is its tool's width and as tall as the workspace beside it, within bounds", () => {
    expect(toolSize("files", { x: 0, y: 0, ...M })).toEqual({ w: TOOL_WIDTH.files, h: M.h });
    expect(toolSize("run", { x: 0, y: 0, w: 100, h: 100 }).h).toBe(TOOL_HEIGHT.min);
    expect(toolSize("run", { x: 0, y: 0, w: 100, h: 5000 }).h).toBe(TOOL_HEIGHT.max);
    expect(toolSize("artifacts", null)).toEqual({ w: TOOL_WIDTH.artifacts, h: TOOL_HEIGHT.plain });
  });
});

describe("opening a tool window", () => {
  it("puts a workspace's beside it, in its area, top-aligned, the area growing to take it", () => {
    const { l, sessions } = twoAreas();
    const layout = resolveLayout(l, sessions);
    const p = ready(planOpenWindow(l, layout, "w1", "files", { session: "s1" }, title));
    const next = apply(l, p);
    const w = next.tools.w1;
    expect(w).toMatchObject({ tool: "files", docked: false, session: "s1", area: "a" });
    expect(w.placement).toMatchObject({ y: AREA_HEADER, w: TOOL_WIDTH.files, h: M.h });
    expect(w.placement!.x).toBeGreaterThanOrEqual(AREA_PAD + M.w + GAP);
    expect(inside(w.placement!, next.areas.a)).toBe(true);
    // area b was in the grown area's way: pushed aside, never overlapped
    expect(overlaps(next.areas.a, next.areas.b, AREA_GAP - 1e-6)).toBe(false);
  });

  it("puts an area's in the area's first free spot, and refuses a tool opened on the wrong kind of scope", () => {
    const { l, sessions } = twoAreas();
    const layout = resolveLayout(l, sessions);
    const next = apply(l, planOpenWindow(l, layout, "w1", "artifacts", { area: "b" }, title));
    expect(next.tools.w1).toMatchObject({ tool: "artifacts", area: "b" });
    expect(next.tools.w1.session).toBeUndefined();
    expect(inside(next.tools.w1.placement!, next.areas.b)).toBe(true);
    expect(planOpenWindow(l, layout, "w2", "files", { area: "b" }, title)).toEqual({ refused: expect.stringMatching(/workspace's tool/) });
    expect(planOpenWindow(l, layout, "w2", "chat", { session: "s1" }, title)).toEqual({ refused: expect.stringMatching(/area's tool/) });
    expect(planOpenWindow(l, layout, "w2", "files", { session: "gone" }, title)).toEqual({ refused: expect.stringMatching(/isn't on the landscape/) });
  });

  it("makes room beside a workspace hemmed in on its right and below, moving what's right of it along together", () => {
    // s1 | s2 | w0 on the top row, s3 below s1, s4 below s2: nothing free beside s1
    const top = AREA_HEADER;
    const col = (i: number) => AREA_PAD + i * (M.w + GAP);
    const a = area(0, 0, col(2) + 400 + AREA_PAD, top + 2 * M.h + GAP + AREA_PAD);
    const l: Landscape = {
      ...emptyLandscape(),
      areas: { a, b: area(a.w + AREA_GAP, 0, 800, 800) },
      workspaces: { s1: { x: col(0), y: top, ...M }, s2: { x: col(1), y: top, ...M }, s3: { x: col(0), y: top + M.h + GAP, ...M }, s4: { x: col(1), y: top + M.h + GAP, ...M } },
      tools: { w0: { tool: "run", docked: false, session: "s2", area: "a", placement: { x: col(2), y: top, w: 400, h: M.h } } },
    };
    const sessions = ["s1", "s2", "s3", "s4"].map((id) => session(id, { taskGroup: "a" }));
    const layout = resolveLayout(l, sessions);
    const next = apply(l, planOpenWindow(l, layout, "w1", "files", { session: "s1" }, title));
    const w = next.tools.w1.placement!;
    expect(w).toEqual({ x: col(0) + M.w + GAP, y: top, w: TOOL_WIDTH.files, h: M.h });
    // s2 moved along, and the window right of it with it, since s2 would otherwise sit over it: by the same step, so
    // they keep their gap. The row below isn't in the way, so s3 and s4 stay, as s1 does
    const dx = next.workspaces.s2.x - col(1);
    expect(dx).toBeGreaterThanOrEqual(TOOL_WIDTH.files + GAP);
    expect(next.tools.w0.placement!.x - col(2)).toBe(dx);
    for (const id of ["s1", "s3", "s4"]) expect(next.workspaces[id]).toEqual(l.workspaces[id]);
    const placed = [w, ...Object.values(next.workspaces), next.tools.w0.placement!];
    for (const r of placed) for (const o of placed) if (r !== o) expect(overlaps(r, o, GAP - 1e-6)).toBe(false);
    for (const r of placed) expect(inside(r, next.areas.a)).toBe(true);
    expect(overlaps(next.areas.a, next.areas.b, AREA_GAP - 1e-6)).toBe(false);
    // locked, it moves nothing: it takes the one free spot left inside, under the Run window
    const locked = { ...l, areas: { ...l.areas, a: { ...a, locked: true } } };
    const p = ready(planOpenWindow(locked, resolveLayout(locked, sessions), "w1", "files", { session: "s1" }, title));
    expect(Object.keys(p.patch!)).toEqual(["tools"]);
    expect(p.patch!.tools!.w1!.placement).toMatchObject({ x: col(2), y: top + M.h + GAP });
  });

  it("in a locked area takes only room it has, and is refused when it has none", () => {
    const { l, sessions } = twoAreas({ locked: true });
    const layout = resolveLayout(l, sessions);
    expect(planOpenWindow(l, layout, "w1", "files", { session: "s1" }, title)).toEqual({ refused: expect.stringMatching(/locked and has no room/) });
  });

  it("beside a loose workspace stays loose, clear of every area", () => {
    const l: Landscape = { ...emptyLandscape(), areas: { b: area(M.w + 200, 0, 800, 800) }, workspaces: { s1: { x: 0, y: 0, ...M } } };
    const layout = resolveLayout(l, [session("s1")]);
    const next = apply(l, planOpenWindow(l, layout, "w1", "changes", { session: "s1" }, title));
    expect(next.tools.w1.area).toBeNull();
    expect(overlaps(next.tools.w1.placement!, next.areas.b, GAP - 1e-6)).toBe(false);
  });
});

describe("a window just opened", () => {
  it("is brought into view with its workspace when both fit, alone when they don't, and left be when it's in view", () => {
    const { l, sessions } = twoAreas();
    const opened = apply(l, planOpenWindow(l, resolveLayout(l, sessions), "w1", "files", { session: "s1" }, title));
    const layout = resolveLayout(opened, sessions);
    const w = opened.tools.w1.placement!;
    const s1 = opened.workspaces.s1;
    const away = { x: 20_000, y: 20_000, zoom: 0.5 };
    const wide = { w: 2400, h: 1200 };
    const to = cameraForOpened(new Set(), layout, away, wide)!;
    expect(to.zoom).toBe(0.5);
    for (const r of [w, s1]) expect(inView(to, r, wide)).toBe(true);
    // too narrow for both: the window alone, centred
    const narrow = { w: 400, h: 600 };
    const alone = cameraForOpened(new Set(), layout, away, narrow)!;
    expect(alone.x + narrow.w / (2 * alone.zoom)).toBeCloseTo(w.x + w.w / 2);
    // nothing new, or new and in view already: the camera stays
    expect(cameraForOpened(new Set(["w1"]), layout, away, wide)).toBeNull();
    expect(cameraForOpened(new Set(), layout, to, wide)).toBeNull();
  });
});

describe("docking and placing again", () => {
  it("docks a window, dropping its scope and place, and places it again from the dock", () => {
    const { l, sessions } = twoAreas();
    const opened = apply(l, planOpenWindow(l, resolveLayout(l, sessions), "w1", "files", { session: "s1" }, title));
    const docked = apply(opened, planDockWindow(opened, "w1"));
    expect(docked.tools.w1).toEqual({ tool: "files", docked: true });
    const layout = resolveLayout(docked, sessions);
    expect(layout.docked.map((d) => d.id)).toEqual(["w1"]);
    expect(layout.windows).toEqual([]);
    const again = apply(docked, planOpenWindow(docked, layout, "w1", "files", { session: "s1" }, title));
    expect(again.tools.w1).toMatchObject({ docked: false, session: "s1", area: "a" });
    expect(planDockWindow(docked, "w1")).toEqual({ patch: null, moves: [], after: null });
    expect(planDockWindow(docked, "nope")).toEqual({ refused: expect.any(String) });
  });
});

describe("a placed window or card", () => {
  it("moves with its area when the area is dragged", () => {
    const { l, sessions } = twoAreas();
    let next = apply(l, planOpenWindow(l, resolveLayout(l, sessions), "w1", "files", { session: "s1" }, title));
    next = apply(next, planPlaceCard(next, resolveLayout(next, sessions), "c1", "a", "area:a", "A".repeat(22), null, title));
    const [w, c, a] = [next.tools.w1.placement!, next.cards.c1.placement!, next.areas.a];
    const moved = apply(next, planMoveArea(next, resolveLayout(next, sessions), "a", 0, 2000, title));
    const dy = moved.areas.a.y - a.y;
    expect(dy).toBeGreaterThan(0);
    expect(moved.tools.w1.placement).toEqual({ ...w, y: w.y + dy });
    expect(moved.cards.c1.placement).toEqual({ ...c, y: c.y + dy });
  });

  it("is placed again in its area when a rename merges its area into another", () => {
    const { l, sessions } = twoAreas();
    let next = apply(l, planOpenWindow(l, resolveLayout(l, sessions), "w1", "artifacts", { area: "b" }, title));
    next = apply(next, planPlaceCard(next, resolveLayout(next, sessions), "c1", "b", "area:b", "A".repeat(22), next.tools.w1.placement!, title));
    const before = { w: next.tools.w1.placement!, c: next.cards.c1.placement! };
    // a rename that merges b into a: b's window and card lose their places, and the layout places them again in a
    const merged = applyPatch(next, parsePatch(renameAreaPatch(next, "b", "a", [])!));
    expect(merged.tools.w1).toMatchObject({ area: "a" });
    expect(merged.tools.w1.placement).toBeUndefined();
    expect(merged.cards.c1).toEqual({ area: "a", shelf: "area:a", artifact: "A".repeat(22) });
    const layout = resolveLayout(merged, sessions);
    const w = layout.windows.find((x) => x.id === "w1")!;
    const c = layout.cards.find((x) => x.id === "c1")!;
    const grown = layout.areas.find((x) => x.key === "a")!.rect;
    expect(inside(w.rect, grown) && inside(c.rect, grown)).toBe(true);
    expect(overlaps(w.rect, c.rect, GAP - 1e-6)).toBe(false);
    expect(before.w).not.toEqual(w.rect);
  });

  it("is dragged within its area, growing it past an edge; an area's window and a card never leave their area", () => {
    const { l, sessions } = twoAreas();
    let next = apply(l, planOpenWindow(l, resolveLayout(l, sessions), "w1", "files", { session: "s1" }, title));
    next = apply(next, planOpenWindow(next, resolveLayout(next, sessions), "w2", "artifacts", { area: "a" }, title));
    next = apply(next, planPlaceCard(next, resolveLayout(next, sessions), "c1", "a", "area:a", "A".repeat(22), null, title));
    const layout = resolveLayout(next, sessions);
    const b = next.areas.b;
    // a workspace's window may go to another area
    const moved = apply(next, planMoveExtra(next, layout, "window", "w1", { x: b.x + 100, y: b.y + 100 }, "b", title));
    expect(moved.tools.w1.area).toBe("b");
    expect(inside(moved.tools.w1.placement!, moved.areas.b)).toBe(true);
    expect(planMoveExtra(next, layout, "window", "w2", { x: b.x + 100, y: b.y + 100 }, "b", title)).toEqual({ refused: expect.stringMatching(/stays in a: dock it/) });
    expect(planMoveExtra(next, layout, "card", "c1", { x: b.x + 100, y: b.y + 100 }, "b", title)).toEqual({ refused: expect.stringMatching(/card stays in a/) });
    // past a's right edge: a grows to take it
    const a = next.areas.a;
    const far = apply(next, planMoveExtra(next, layout, "card", "c1", { x: a.x + a.w + 200, y: a.y + 100 }, "a", title));
    expect(inside(far.cards.c1.placement!, far.areas.a)).toBe(true);
    expect(far.areas.a.w).toBeGreaterThan(a.w);
  });

  it("stays put in a locked area, and won't be dropped into one", () => {
    const { l, sessions } = twoAreas();
    let next = apply(l, planOpenWindow(l, resolveLayout(l, sessions), "w1", "files", { session: "s1" }, title));
    next = { ...next, areas: { ...next.areas, b: { ...next.areas.b, locked: true } } };
    const layout = resolveLayout(next, sessions);
    expect(planMoveExtra(next, layout, "window", "w1", { x: next.areas.b.x + 50, y: next.areas.b.y + 80 }, "b", title)).toEqual({ refused: expect.stringMatching(/b is locked/) });
    next = { ...next, areas: { ...next.areas, a: { ...next.areas.a, locked: true } } };
    expect(planMoveExtra(next, resolveLayout(next, sessions), "window", "w1", { x: 10, y: 10 }, "a", title)).toEqual({ refused: expect.stringMatching(/a is locked/) });
  });
});

describe("a workspace's size", () => {
  it("changes where it is when that's clear, else moves to a free spot; never for a teammate's or in a locked area", () => {
    const { l, sessions } = twoAreas();
    const layout = resolveLayout(l, sessions);
    const small = apply(l, planResizeTile(l, layout, "s1", S, title));
    expect(small.workspaces.s1).toEqual({ x: AREA_PAD, y: AREA_HEADER, ...S });
    expect(planResizeTile(l, layout, "s1", M, title)).toEqual({ patch: null, moves: [], after: null });
    // grown into a neighbour: moved clear of it
    const two: Landscape = { ...l, workspaces: { s1: { x: AREA_PAD, y: AREA_HEADER, ...S }, s2: { x: AREA_PAD + S.w + GAP, y: AREA_HEADER, ...S } } };
    const both = [...sessions, session("s2", { taskGroup: "a" })];
    const grown = apply(two, planResizeTile(two, resolveLayout(two, both), "s1", M, title));
    expect(overlaps(grown.workspaces.s1, grown.workspaces.s2, GAP - 1e-6)).toBe(false);
    expect(inside(grown.workspaces.s1, grown.areas.a)).toBe(true);
    const locked = { ...l, areas: { ...l.areas, a: { ...l.areas.a, locked: true } } };
    expect(planResizeTile(locked, resolveLayout(locked, sessions), "s1", S, title)).toEqual({ refused: expect.stringMatching(/locked/) });
    const nick = { ...emptyLandscape(), workspaces: { t1: { x: 0, y: 0, ...M } } };
    expect(planResizeTile(nick, resolveLayout(nick, [theirs("t1", "x")]), "t1", S, title)).toEqual({ refused: expect.stringMatching(/Nick's workspace/) });
  });
});

describe("a workspace's size preset", () => {
  it("is the one whose cols × rows it holds, not its exact pixels", () => {
    const { l, sessions } = twoAreas();
    const at = (h: number, w = M.w) => {
      const next = { ...l, workspaces: { s1: { x: AREA_PAD, y: AREA_HEADER, w, h } } };
      const layout = resolveLayout(next, sessions);
      return tileSize(layout.tiles[0], layout, title).current;
    };
    expect(at(M.h)).toBe("M");
    // a few px over M (a different rounding) holds M's cols × rows still
    expect(at(M.h + 5, M.w + 3)).toBe("M");
    // one sized when the frame took 16 px less holds a row fewer: no preset
    expect(at(M.h - 16)).toBe(null);
    expect(WORKSPACE_CHROME.h).toBe(56);
    expect(at(S.h, S.w)).toBe("S");
  });
});

describe("an artifact card's shelf", () => {
  const card = (shelf: string) => ({ area: "a", shelf, artifact: "X".repeat(22) });
  const room = "R".repeat(22);
  it("is the one it was placed from: its area's on this Mac, a room's while this Mac is in it", () => {
    expect(cardShelf(card("area:a"), new Set([room]))).toEqual({ shelf: { id: "area:a", groupKey: "a", local: true } });
    expect(cardShelf(card(room), new Set([room]))).toEqual({ shelf: { id: room, groupKey: "a", local: false } });
    // the room left: gone, and said why
    expect(cardShelf(card(room), new Set())).toEqual({ gone: expect.stringMatching(/You left the room/) });
    // the rooms not known yet: the room's is read, and what it says shown
    expect(cardShelf(card(room), null)).toEqual({ shelf: { id: room, groupKey: "a", local: false } });
  });
  it("moves to the room's copy when its area is shared, for the artifacts copied only", () => {
    const l: Landscape = {
      ...emptyLandscape(),
      cards: {
        c1: { area: "a", shelf: "area:a", artifact: "A".repeat(22) },
        c2: { area: "a", shelf: "area:a", artifact: "B".repeat(22) },
        c3: { area: "b", shelf: "area:b", artifact: "A".repeat(22) },
      },
    };
    const patch = cardsAfterShare(l, "a", room, { ["A".repeat(22)]: "N".repeat(22) });
    expect(patch).toEqual({ cards: { c1: { area: "a", shelf: room, artifact: "N".repeat(22) } } });
    expect(parseLandscape(JSON.parse(JSON.stringify(applyPatch(l, parsePatch(patch!))))).cards).toEqual({ ...l.cards, c1: { area: "a", shelf: room, artifact: "N".repeat(22) } });
    expect(cardsAfterShare(l, "a", room, {})).toBe(null);
    // an id named like Object's own isn't a copy
    expect(cardsAfterShare({ ...l, cards: { c1: { area: "a", shelf: "area:a", artifact: "constructor" } } }, "a", room, {})).toBe(null);
  });
});

describe("mentioning an artifact", () => {
  const name = (s: SessionInfo) => s.title ?? s.id;
  it("goes to the selected session when it's this Mac's, in the artifact's area, and its agent reads that shelf", () => {
    const s1 = session("s1", { taskGroup: "a" });
    expect(mentionTarget(s1, "a", true, false, title, name)).toEqual({ session: "s1" });
    expect(mentionTarget(s1, "a", false, true, title, name)).toEqual({ session: "s1" });
    expect(mentionTarget(null, "a", true, false, title, name)).toEqual({ no: expect.stringMatching(/select one of this Mac's/) });
    expect(mentionTarget(theirs("t1", "a"), "a", false, true, title, name)).toEqual({ no: expect.stringMatching(/select one of this Mac's/) });
    expect(mentionTarget(session("s2", { taskGroup: "b" }), "a", true, false, title, name)).toEqual({ no: expect.stringMatching(/is in b, not a/) });
    expect(mentionTarget(session("s3"), "a", true, false, title, name)).toEqual({ no: expect.stringMatching(/in no area/) });
    // a room's area's agents read the room's: this Mac's copy isn't theirs
    expect(mentionTarget(s1, "a", true, true, title, name)).toEqual({ no: expect.stringMatching(/agents read the room's/) });
  });
});

describe("windows and cards zoomed out to cards", () => {
  const min = { w: 136, h: 50 };
  it("are drawn under one they'd cover at their compact size, never moved where they're clear", () => {
    const win = { id: "w", rect: { x: 0, y: 0, w: 384, h: 640 }, min };
    const card = { id: "c", rect: { x: 400, y: 0, w: 240, h: 128 }, min };
    // at 50% both fit their places: nothing moves
    expect([...compactShifts([card, win], 0.5)]).toEqual([["w", 0], ["c", 0]]);
    // at 13% the window reaches over the card beside it: the card is drawn just under the window
    const at13 = compactShifts([card, win], 0.13);
    expect(at13.get("w")).toBe(0);
    expect(at13.get("c")).toBeCloseTo(640 + 4 / 0.13, 6);
    // a second card under the first is drawn under it in turn; one far off isn't moved
    const card2 = { id: "c2", rect: { x: 400, y: 144, w: 240, h: 128 }, min };
    const far = { id: "f", rect: { x: 5000, y: 0, w: 240, h: 128 }, min };
    const s = compactShifts([win, card, card2, far], 0.13);
    const top = (id: string, y: number) => y + s.get(id)!;
    expect(top("c2", 144)).toBeGreaterThanOrEqual(top("c", 0) + 52 / 0.13);
    expect(s.get("f")).toBe(0);
  });
});

describe("tool scopes", () => {
  it("are the same workspace or area, none and none", () => {
    expect(sameScope(null, null)).toBe(true);
    expect(sameScope({ session: "s1" }, { session: "s1" })).toBe(true);
    expect(sameScope({ session: "s1" }, { session: "s2" })).toBe(false);
    expect(sameScope({ area: "a" }, { area: "a" })).toBe(true);
    expect(sameScope({ area: "a" }, { session: "a" })).toBe(false);
    expect(sameScope({ area: "a" }, null)).toBe(false);
  });
});

describe("stored tool windows and cards", () => {
  it("are checked together: a docked one has no scope or place, a placed one its scope", () => {
    const ok = { ...emptyLandscape(), tools: { w1: { tool: "files", docked: true }, w2: { tool: "chat", docked: false, area: "a", placement: { x: 0, y: 0, w: 10, h: 10 } } } };
    expect(parseLandscape(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
    for (const bad of [
      { tool: "files", docked: true, session: "s1" },
      { tool: "files", docked: false, area: "a", placement: { x: 0, y: 0, w: 1, h: 1 } },
      { tool: "chat", docked: false, session: "s1", area: "a" },
      { tool: "terminal", docked: true },
      { tool: "files", docked: false, session: "s1", area: "../x" },
    ])
      expect(() => parseLandscape({ ...emptyLandscape(), tools: { w: bad } }), JSON.stringify(bad)).toThrow();
    expect(() => parseLandscape({ ...emptyLandscape(), cards: { c: { area: "a", shelf: "area:a" } } })).toThrow(/artifact is missing/);
    expect(() => parseLandscape({ ...emptyLandscape(), cards: { c: { area: "a", shelf: "area:b", artifact: "A".repeat(22) } } })).toThrow(/neither a room.s nor area:a/);
  });

  it("from a version 1 file: every placement kept, and no windows or cards", () => {
    const v1 = { v: 1, workspaces: { s1: { x: 8, y: 16, w: 400, h: 300 } }, areas: { a: { x: 0, y: 0, w: 600, h: 400, repos: [] } }, stacks: {}, ghosts: {}, migratedAt: "2026-01-01T00:00:00.000Z" };
    const l = parseLandscape(v1);
    expect(l).toEqual({ ...v1, v: 2, tools: {}, cards: {} });
    // a version 1 file with a field only version 2 has is wrong, not read
    expect(() => parseLandscape({ ...v1, tools: {} })).toThrow(/tools/);
  });

  it("follow an area's rename, and lose their area when it becomes a sub-group", () => {
    const { l } = twoAreas();
    const with2: Landscape = {
      ...l,
      tools: { w1: { tool: "files", docked: false, session: "s1", area: "a", placement: { x: 0, y: 0, w: 10, h: 10 } }, w2: { tool: "artifacts", docked: false, area: "a", placement: { x: 20, y: 0, w: 10, h: 10 } }, w3: { tool: "files", docked: true } },
      cards: {
        c1: { area: "a", shelf: "area:a", artifact: "A".repeat(22), placement: { x: 40, y: 0, w: 10, h: 10 } },
        c2: { area: "a", shelf: "R".repeat(22), artifact: "B".repeat(22), placement: { x: 60, y: 0, w: 10, h: 10 } },
      },
    };
    const renamed = applyPatch(with2, parsePatch(renameAreaPatch(with2, "a", "z", ["s1"])!));
    expect([renamed.tools.w1.area, renamed.tools.w2.area, renamed.cards.c1.area]).toEqual(["z", "z", "z"]);
    // an area's own artifacts move with it, a room's stay the room's
    expect([renamed.cards.c1.shelf, renamed.cards.c2.shelf]).toEqual(["area:z", "R".repeat(22)]);
    expect(renamed.tools.w1.placement).toEqual(with2.tools.w1.placement);
    expect(renamed.tools.w3).toEqual({ tool: "files", docked: true });
    const sub = applyPatch(with2, parsePatch(renameAreaPatch(with2, "a", "b/a", ["s1"])!));
    expect(sub.tools.w1.area).toBeNull();
    expect(sub.tools.w2).toBeUndefined();
    expect(sub.cards.c1).toBeUndefined();
  });

  it("get ids of their own", () => {
    const l = { ...emptyLandscape(), tools: { w: { tool: "files" as const, docked: true } } };
    const ids = new Set(Array.from({ length: 50 }, () => newExtraId(l, "w")));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^w[0-9a-z]+$/);
    expect(newExtraId(l, "c")).toMatch(/^c/);
    expect(CARD_SIZE).toEqual({ w: 240, h: 128 });
  });
});
