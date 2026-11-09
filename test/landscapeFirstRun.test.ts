import { describe, expect, it } from "vitest";
import type { LandscapeProblem, Rect } from "../src/shared/landscape";
import {
  EMPTY_TILES,
  PROBLEM_TITLE,
  TOUR_LATER,
  TOUR_MIN_W,
  emptyStateOf,
  nothingDrawn,
  nothingToTour,
  ringAround,
  sameCamera,
  tourAreaOf,
  tourCamera,
  tourCameraFrom,
  tourCardAt,
  tourNext,
  tourSteps,
  type ListRead,
} from "../src/renderer/landscapeFirstRun";
import { fitRects, flagOnly, type ResolvedLayout } from "../src/renderer/landscapeModel";
import { SHEET_FOOT, SHORTCUTS, shortcutIds } from "../src/renderer/landscapeShortcuts";
import { actionOf, createActions } from "../src/renderer/workspaceActions";

const R = (x = 0, y = 0, w = 100, h = 100): Rect => ({ x, y, w, h });
const none = (): Pick<ResolvedLayout, "areas" | "tiles" | "ghosts" | "windows" | "cards"> => ({ areas: [], tiles: [], ghosts: [], windows: [], cards: [] });
const area = (key: string, rect: Rect, collapsed = false) => ({ key, rect: { ...rect, repos: [], collapsed } }) as ResolvedLayout["areas"][number];
const tile = (key: string, a: string, rect = R(), hidden = false) => ({ key, area: a, rect, hidden }) as ResolvedLayout["tiles"][number];

const read: ListRead = { read: true, error: null, retry: () => {} };
const lists = (over: Partial<Record<"live" | "closed" | "remote", Partial<ListRead>>> = {}) => ({
  live: { ...read, ...over.live },
  closed: { ...read, ...over.closed },
  remote: { ...read, ...over.remote },
});
const state = (o: Partial<Parameters<typeof emptyStateOf>[0]> = {}) => emptyStateOf({ layout: none(), problems: [], standIn: undefined, storeError: null, migrationFailed: null, lists: lists(), closed: 0, ...o });
const problem = (kind: LandscapeProblem["kind"], movedTo?: string): LandscapeProblem => ({ kind, message: `${kind}!`, file: "/f", ...(movedTo ? { movedTo } : {}) });

describe("what goes where the landscape would be empty", () => {
  it("nothing, once a landscape with nothing on it has been read whole", () => {
    expect(state()).toEqual({ kind: "empty", closed: 0, reset: null });
  });

  it("counts anything drawn as something, but not a docked window, which isn't on it", () => {
    expect(nothingDrawn(none())).toBe(true);
    expect(nothingDrawn({ ...none(), ghosts: [tile("g", "x")] as never })).toBe(false);
    expect(nothingDrawn({ ...none(), windows: [{ id: "w" }] as never })).toBe(false);
    expect(nothingDrawn({ ...none(), cards: [{ id: "c" }] as never })).toBe(false);
    expect(nothingDrawn({ ...none(), areas: [area("a", R())] })).toBe(false);
    expect(state({ layout: { ...none(), tiles: [tile("t", "x")] } })).toEqual({ kind: "drawn" });
    expect(state({ layout: { ...none(), ghosts: [tile("g", "x")] as never } })).toEqual({ kind: "drawn" });
    expect(state({ layout: { ...none(), docked: [{ id: "d" }] } as never })).toMatchObject({ kind: "empty" });
  });

  it("says something's drawn even while the reads behind it are failing: what's drawn speaks for itself", () => {
    expect(state({ layout: { ...none(), tiles: [tile("t", "x")] }, standIn: problem("unreadable"), lists: lists({ live: { read: false, error: "no" } }) })).toEqual({ kind: "drawn" });
  });

  it("is never empty over a file that only stands in, a read that failed or a read in", () => {
    const standIn = problem("unreadable");
    expect(state({ standIn, problems: [standIn] })).toMatchObject({ kind: "broken", title: PROBLEM_TITLE.unreadable });
    // why, in the panel itself: the banner that says it too can be put away
    expect(state({ standIn, problems: [standIn] })).toMatchObject({ why: expect.stringContaining("unreadable!") });
    expect(state({ standIn: problem("newer") })).toMatchObject({ kind: "broken", title: PROBLEM_TITLE.newer });
    expect(state({ storeError: "Couldn't read the layout: EMFILE" })).toMatchObject({ kind: "broken", why: "Couldn't read the layout: EMFILE" });
    expect(state({ migrationFailed: "It couldn't be saved" })).toMatchObject({ kind: "broken", title: "Your grid's layout wasn't read in", why: "It couldn't be saved" });
  });

  it("says which session list couldn't be read, with its retry", () => {
    const retry = () => {};
    expect(state({ lists: lists({ live: { read: false, error: "live broke", retry } }) })).toEqual({ kind: "broken", title: "Couldn't read your sessions", why: "live broke", retry });
    expect(state({ lists: lists({ closed: { read: false, error: "closed broke", retry } }) })).toMatchObject({ kind: "broken", title: "Couldn't read your closed sessions", why: "closed broke" });
    expect(state({ lists: lists({ remote: { read: false, error: "team broke", retry } }) })).toMatchObject({ kind: "broken", title: "Couldn't read teammates' sessions", why: "team broke" });
  });

  it("goes by a list's read, not a failure after it was read", () => {
    expect(state({ lists: lists({ live: { read: true, error: "later" } }) })).toMatchObject({ kind: "empty" });
  });

  it("waits, saying what for, until every list has been read", () => {
    expect(state({ lists: lists({ live: { read: false }, remote: { read: false } }) })).toEqual({ kind: "reading", why: "Reading your sessions, teammates' sessions…" });
  });

  it("names a reset apart from an empty start, and carries the Closed list's count", () => {
    expect(state({ problems: [problem("corrupt", "/f.bad")] })).toEqual({ kind: "empty", closed: 0, reset: "The old file was moved to /f.bad." });
    expect(state({ problems: [problem("corrupt")] })).toEqual({ kind: "empty", closed: 0, reset: "corrupt!" });
    expect(state({ closed: 3 })).toEqual({ kind: "empty", closed: 3, reset: null });
  });
});

describe("the empty landscape's tiles", () => {
  const rows = createActions({ launch: () => {}, ticket: () => {}, importIt: () => {} });
  it("each runs a row of the create menu that can be done now", () => {
    for (const t of EMPTY_TILES) {
      const a = actionOf(rows, t.row);
      expect([t.row, !!a, !!a?.disabled]).toEqual([t.row, true, false]);
    }
  });
  it("promise nothing the create menu has as coming", () => {
    for (const a of rows.filter((x) => x.disabled)) expect(EMPTY_TILES.map((t) => t.row)).not.toContain(a.key);
    expect(EMPTY_TILES.map((t) => `${t.title} ${t.sub}`).join(" ")).not.toMatch(/collab|pipeline|house/i);
  });
});

describe("the tour's steps", () => {
  it("are four, an area's first, then the ones that are one entry each", () => {
    const steps = tourSteps({ tiles: [], ghosts: [] }, "5101")!;
    expect(steps.map((s) => s.id)).toEqual(["areas", ...TOUR_LATER.map((s) => s.id)]);
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatchObject({ title: "Your groups are now areas", target: { kind: "area", key: "5101" } });
    expect(steps.map((s) => s.title)).toContain("Your sidebar's tools are windows now");
    expect(new Set(steps.map((s) => s.id)).size).toBe(4);
  });

  it("speak of workspaces, on the first one drawn, when no area is", () => {
    const rect = R(5, 6);
    const steps = tourSteps({ tiles: [tile("hid", "x", R(), true), tile("t", "x", rect)], ghosts: [] }, null)!;
    expect(steps[0]).toMatchObject({ title: "Your sessions are now workspaces", target: { kind: "place", rect } });
    expect(tourSteps({ tiles: [], ghosts: [tile("g", "x", rect)] as never }, null)![0].target).toEqual({ kind: "place", rect });
  });

  it("don't exist with nothing to show them on", () => {
    expect(tourSteps({ tiles: [], ghosts: [] }, null)).toBeNull();
    expect(nothingToTour({ areas: [], tiles: [], ghosts: [] })).toBe(true);
    expect(nothingToTour({ areas: [area("a", R())], tiles: [], ghosts: [] })).toBe(false);
  });

  it("say what comes next, and nothing on the last", () => {
    const steps = tourSteps({ tiles: [], ghosts: [] }, "a")!;
    expect(tourNext(steps, 0)).toBe("Next: zooming and focus · tool windows · what needs you");
    expect(tourNext(steps, 2)).toBe("Next: what needs you");
    expect(tourNext(steps, 3)).toBeNull();
  });
});

describe("the area the tour points at", () => {
  const cam = { x: 0, y: 0, zoom: 1 };
  const view = { w: 1000, h: 800 };
  it("is an open one on screen with the most in it", () => {
    const l = {
      areas: [area("off", R(5000, 0)), area("few", R(0, 0)), area("many", R(200, 0)), area("pill", R(400, 0), true)],
      tiles: [tile("1", "many"), tile("2", "many"), tile("3", "few"), tile("4", "off"), tile("5", "off"), tile("6", "off")],
      ghosts: [],
    };
    expect(tourAreaOf(l, cam, view)).toBe("many");
  });
  it("counts ghosts, prefers off screen over a pill, and is null with no area", () => {
    expect(tourAreaOf({ areas: [area("a", R(0, 0)), area("b", R(200, 0))], tiles: [], ghosts: [tile("g", "b")] as never }, cam, view)).toBe("b");
    expect(tourAreaOf({ areas: [area("pill", R(0, 0), true), area("off", R(9000, 0))], tiles: [], ghosts: [] }, cam, view)).toBe("off");
    expect(tourAreaOf({ areas: [], tiles: [], ghosts: [] }, cam, view)).toBeNull();
  });
});

describe("moving the camera for the tour", () => {
  const view = { w: 1000, h: 800 };
  const rect = R(0, 0, 400, 300);
  it("leaves one wholly in view and big enough", () => {
    expect(tourCamera(rect, { x: 10, y: 10, w: 400, h: 300 }, view, 0)).toBeNull();
  });
  it("moves for one partly off, under the switcher's strip, or too small to read", () => {
    expect(tourCamera(rect, { x: 800, y: 10, w: 400, h: 300 }, view, 0)).not.toBeNull();
    expect(tourCamera(rect, { x: 10, y: 10, w: 400, h: 300 }, view, 56)).not.toBeNull();
    expect(tourCamera(rect, { x: 10, y: 10, w: TOUR_MIN_W - 1, h: 300 }, view, 0)).not.toBeNull();
  });
});

describe("where the tour's card goes", () => {
  const card = { w: 360, h: 250 };
  const view = { w: 1440, h: 900 };
  const clear = (p: { x: number; y: number }, b: Rect) => p.x + card.w <= b.x || b.x + b.w <= p.x || p.y + card.h <= b.y || b.y + b.h <= p.y;

  it("goes to the right of an area with room there, its foot level with the area's, as the design has it", () => {
    const b = { x: 52, y: 122, w: 536, h: 316 };
    expect(tourCardAt(b, card, view, 48)).toEqual({ x: b.x + b.w + 16, y: b.y + b.h - card.h });
  });
  it("goes left of one at the window's right edge", () => {
    const b = { x: 900, y: 120, w: 520, h: 300 };
    const p = tourCardAt(b, card, view, 48);
    expect(p.x + card.w).toBe(b.x - 16);
  });
  it("goes under the Needs you button and over the zoom's buttons, inside the window", () => {
    const needs = { x: 1180, y: 8, w: 96, h: 24 };
    const under = tourCardAt(needs, card, view, 48);
    expect(under.y).toBe(needs.y + needs.h + 16);
    expect(under.x + card.w).toBeLessThanOrEqual(view.w - 8);
    const hud = { x: 800, y: 830, w: 140, h: 30 };
    const over = tourCardAt(hud, card, view, 48);
    expect(over.y + card.h).toBe(hud.y - 16);
  });
  it("goes over the corner of what fills the view, leaving most of it showing", () => {
    const b = { x: 310, y: 45, w: 1120, h: 820 };
    const p = tourCardAt(b, card, view, 48);
    expect(p.x + card.w).toBeLessThanOrEqual(b.x + b.w);
    expect(p.y + card.h).toBeLessThanOrEqual(b.y + b.h);
    expect(p.x).toBeGreaterThan(b.x);
  });
  it("is in the window's middle with nothing to point at", () => {
    expect(tourCardAt(null, card, view, 48)).toEqual({ x: 540, y: 325 });
  });
  it("stays inside any window, under the top bar, and clear of a target with room to be", () => {
    for (const v of [{ w: 1440, h: 900 }, { w: 1024, h: 768 }, { w: 800, h: 600 }, { w: 500, h: 420 }])
      for (const b of [R(10, 50, 60, 200), R(v.w - 100, 8, 90, 24), R(v.w / 2 - 70, v.h - 40, 140, 30), R(20, 60, v.w - 40, v.h - 80), R(v.w / 2, v.h / 2, 80, 60)]) {
        const p = tourCardAt(b, card, v, 48);
        expect(p.x).toBeGreaterThanOrEqual(8);
        expect(p.x + card.w).toBeLessThanOrEqual(v.w - 8);
        expect(p.y).toBeGreaterThanOrEqual(48);
        expect(p.y + card.h).toBeLessThanOrEqual(v.h - 8);
        const room = v.w - b.w >= 2 * card.w + 48 || v.h - b.h >= 2 * card.h + 100;
        if (room) expect(clear(p, b)).toBe(true);
      }
  });
});

describe("the tour's ring", () => {
  const view = { x: 300, y: 40, w: 800, h: 600 };
  it("stands off its target, inside what it's in", () => {
    expect(ringAround({ x: 400, y: 100, w: 100, h: 50 }, 8, view)).toEqual({ x: 392, y: 92, w: 116, h: 66 });
    expect(ringAround({ x: 200, y: 0, w: 2000, h: 2000 }, 8, view)).toEqual(view);
  });
  it("is nothing while its target is wholly out of view", () => {
    expect(ringAround({ x: 5000, y: 100, w: 100, h: 50 }, 8, view)).toBeNull();
  });
});

describe("what a fit goes by", () => {
  it("brings tool windows and cards into view when they're all that's drawn, leaving a hidden one out", () => {
    const l = { ...none(), docked: [], patch: null, windows: [{ id: "w", rect: R(1), hidden: false }, { id: "x", rect: R(2), hidden: true }], cards: [{ id: "c", rect: R(3), hidden: false }] } as unknown as ResolvedLayout;
    expect(fitRects(l)).toEqual([R(1), R(3)]);
  });
  it("otherwise goes by what it always did", () => {
    const l = { ...none(), docked: [], patch: null, tiles: [tile("t", "x", R(7))], windows: [{ id: "w", rect: R(1), hidden: false }] } as unknown as ResolvedLayout;
    expect(fitRects(l)).toEqual([R(7)]);
  });
});

describe("the shortcuts sheet's rows", () => {
  it("are in three sections, each row with its words and keys, every id once", () => {
    expect(SHORTCUTS.map((s) => s.title)).toEqual(["Move around", "Work", "Build"]);
    const ids = shortcutIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of SHORTCUTS.flatMap((s) => s.rows)) {
      expect(r.what.trim()).not.toBe("");
      expect(r.keys.trim()).not.toBe("");
    }
  });
  it("name nothing this build doesn't have", () => {
    const words = SHORTCUTS.flatMap((s) => s.rows.map((r) => `${r.what} ${r.keys}`)).join("\n");
    expect(words).not.toMatch(/connect|wire|pipeline|next step|double-click|collab|⌥←|⌥→/i);
    expect(SHEET_FOOT).not.toMatch(/any time/i);
  });
  it("include what the design lacks: ⇧N, ⌘= and ⌘-, and the windows' keys", () => {
    const keys = SHORTCUTS.flatMap((s) => s.rows.map((r) => r.keys)).join("\n");
    for (const k of ["⇧N", "⌘=", "⌘-", "⌘\\", "⇧⌘F", "⌃⇧G", "⇧⌘D", "⌘B"]) expect(keys).toContain(k);
  });
});

describe("the tour's camera, kept", () => {
  it("reads back only a from and a to that are cameras", () => {
    const from = { x: 1, y: 2, zoom: 0.5 };
    const to = { x: 300, y: 40, zoom: 1 };
    expect(tourCameraFrom({ from, to })).toEqual({ from, to });
    expect(tourCameraFrom(null)).toBe(null);
    expect(tourCameraFrom({ from })).toBe(null);
    expect(tourCameraFrom({ from, to: { x: 1, y: 2 } })).toBe(null);
  });
  it("takes a camera that rounding moved by less than half a pixel for the same one", () => {
    expect(sameCamera({ x: 10, y: 10, zoom: 1 }, { x: 10.3, y: 9.8, zoom: 1.00001 })).toBe(true);
    expect(sameCamera({ x: 10, y: 10, zoom: 1 }, { x: 11, y: 10, zoom: 1 })).toBe(false);
    expect(sameCamera({ x: 10, y: 10, zoom: 1 }, { x: 10, y: 10, zoom: 1.01 })).toBe(false);
  });
});

describe("a patch that only sets a flag", () => {
  it("is tourDone alone, empty records aside", () => {
    expect(flagOnly({ tourDone: true })).toBe(true);
    expect(flagOnly({ tourDone: true, workspaces: {}, areas: {} })).toBe(true);
    expect(flagOnly({ tourDone: true, workspaces: { s1: { x: 0, y: 0, w: 1, h: 1 } } })).toBe(false);
    expect(flagOnly({ tourDone: true, migratedAt: "2026-11-09" })).toBe(false);
    expect(flagOnly({ workspaces: {} })).toBe(false);
    expect(flagOnly(null)).toBe(false);
  });
});
