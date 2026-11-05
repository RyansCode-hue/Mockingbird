import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../src/shared/types";
import type { PrefStore } from "../src/renderer/prefs";
import {
  AREA_HEAD_PX,
  AREA_NAME_PX,
  BAR_EXTENDED_PREF,
  BAR_GAP,
  BAR_MARGIN,
  STACK_COMING,
  areaBarItems,
  areaStatus,
  barAnchor,
  barPlace,
  escapeClears,
  foldBar,
  readBarExtended,
  saveBarExtended,
  severalBarItems,
  workspaceBarItems,
} from "../src/renderer/selectionBarModel";
import { actionOf, inSection, workspaceActions, type ModelAction, type WorkspaceEnv } from "../src/renderer/workspaceActions";

const sess = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "s1",
  title: "Org dropdowns",
  repoPath: "/Users/you/Code/backoffice",
  cwd: "/Users/you/Code/backoffice-wt/5101",
  branch: "5101-orgDropdowns",
  ticketId: null,
  ticketTitle: null,
  taskGroup: "5101",
  status: "working",
  createdAt: 0,
  kind: "work",
  extraDirs: [],
  waitingReason: null,
  waitingSince: null,
  agent: "claude",
  ...over,
});

const env = (over: Partial<WorkspaceEnv> = {}): WorkspaceEnv => ({
  owner: null,
  size: { current: "M", blocked: null },
  diffPanel: false,
  room: [],
  rename: vi.fn(),
  mute: vi.fn(),
  move: vi.fn(),
  resize: vi.fn(),
  tool: vi.fn(),
  repaint: vi.fn(),
  hidePanel: vi.fn(),
  undo: vi.fn<() => void>(),
  handoff: vi.fn<() => void>(),
  brief: vi.fn<() => void>(),
  secondOpinion: vi.fn<() => void>(),
  close: vi.fn(),
  resume: vi.fn<() => void>(),
  ...over,
});

/** An area's model as main.tsx's areaActions makes it: a room's has Chat, Board and Follow; any has Ask and Artifacts. */
function areaModel(room: boolean, h: Record<string, () => void> = {}): ModelAction[] {
  const f = (k: string) => (h[k] ??= vi.fn());
  return [
    ...inSection("area", [{ key: "rename", label: "Rename", menuLabel: "Rename…", onPick: f("rename") }]),
    ...inSection("tools", [
      { key: "tool:artifacts", label: "Artifacts", onPick: f("tool:artifacts") },
      ...(room ? [{ key: "tool:chat", label: "Chat", onPick: f("tool:chat") }] : []),
    ]),
    ...inSection("room", [
      ...(room ? [{ key: "board", label: "Board", onPick: f("board") }, { key: "follow:nick", label: "Follow Nick", onPick: f("follow:nick") }] : []),
      { key: "share", label: room ? "Invite" : "Share", onPick: f("share") },
      { key: "ask", label: "Ask for status", onPick: f("ask") },
    ]),
  ];
}

const keys = (items: readonly { key: string }[]) => items.map((i) => i.key);

describe("the selection bar's buttons come from the action model", () => {
  it("a room's area: Chat, Board, Members and Follow, then Ask for status and Tools ▾", () => {
    const h: Record<string, () => void> = {};
    const items = areaBarItems(areaModel(true, h), { chatCount: "2", members: "Members ▾" });
    expect(keys(items)).toEqual(["tool:chat", "board", "members", "follow:nick", "ask", "tools"]);
    // the unread count rides on Chat, which is teal while there's any
    expect(items[0]).toMatchObject({ label: "Chat · 2", tone: "teal" });
    // the room's tools stay longest in a narrow window; Follow, Ask and Tools fold first
    expect(items.map((i) => i.rank)).toEqual([1, 1, 1, 2, 2, 2]);
    // a button runs the model row's own handler
    items.find((i) => i.key === "board")!.onPick!(null as unknown as HTMLElement);
    items.find((i) => i.key === "ask")!.onPick!(null as unknown as HTMLElement);
    expect(h.board).toHaveBeenCalledOnce();
    expect(h.ask).toHaveBeenCalledOnce();
    // Tools ▾ is the model's Tools rows, as a menu
    expect(keys(items.at(-1)!.menu!() as { key: string }[])).toEqual(["tool:artifacts", "tool:chat"]);
  });

  it("an area that isn't a room's has no room tools at all", () => {
    const items = areaBarItems(areaModel(false), { chatCount: "3", members: "Members ▾" });
    expect(keys(items)).toEqual(["ask", "tools"]);
    expect(keys(items[1].menu!() as { key: string }[])).toEqual(["tool:artifacts"]);
  });

  it("a workspace: Focus, Δ Changes and ▶ Run, then Files and Artifacts, each the model's row with its reason", () => {
    const e = env();
    const acts = workspaceActions(sess(), e);
    const focus = vi.fn();
    const artifacts: ModelAction = { section: "tools", key: "tool:artifacts", label: "Artifacts", onPick: vi.fn() };
    const items = workspaceBarItems(acts, { onFocus: focus, changes: 3, runs: 1, artifacts });
    expect(keys(items)).toEqual(["focus", "tool:changes", "tool:run", "tool:files", "tool:artifacts"]);
    expect(items.map((i) => i.label)).toEqual(["Focus", "Δ 3 Changes", "▶ 1 Run", "Files", "Artifacts"]);
    expect(items.map((i) => i.rank)).toEqual([1, 1, 1, 2, 2]);
    expect(items[0].kbd).toBe("⌘E");
    items[0].onPick!(null as unknown as HTMLElement);
    items[2].onPick!(null as unknown as HTMLElement);
    expect(focus).toHaveBeenCalledOnce();
    expect(e.tool).toHaveBeenCalledWith("run");
    // its shortcut in its tooltip, as the menu shows it
    expect(items[1].title).toMatch(/⌃⇧G/);
    // nothing to count reads plainly
    expect(workspaceBarItems(acts, { onFocus: focus, changes: 0, runs: 0, artifacts }).map((i) => i.label).slice(1, 3)).toEqual(["Δ Changes", "▶ Run"]);
    // a teammate's session: its tools are off, saying why, as its menu's rows are
    const theirs = workspaceBarItems(workspaceActions(sess({ room: { remote: true } as SessionInfo["room"] }), env({ owner: "Nick Smith" })), { onFocus: focus, changes: 0, runs: 0, artifacts });
    for (const k of ["tool:changes", "tool:run", "tool:files"]) expect(theirs.find((i) => i.key === k)).toMatchObject({ disabled: true, title: "Nick Smith's session has no folder on this Mac" });
  });

  it("several: Make area… M, Stack ⌘G (coming), Move to area ▾ and Close…", () => {
    const make = vi.fn();
    const close = vi.fn();
    const items = severalBarItems({ makeArea: make, move: () => [], close: { onPick: close } });
    expect(keys(items)).toEqual(["makeArea", "stack", "move", "close"]);
    expect(items[0]).toMatchObject({ label: "Make area…", kbd: "M" });
    expect(items[1]).toMatchObject({ disabled: true, title: STACK_COMING, kbd: "⌘G" });
    expect(items[2].menu).toBeTypeOf("function");
    items[0].onPick!(null as unknown as HTMLElement);
    items[3].onPick!(null as unknown as HTMLElement);
    expect([make.mock.calls.length, close.mock.calls.length]).toEqual([1, 1]);
    // one that can't be closed here keeps the lot's Close off, saying why
    expect(severalBarItems({ makeArea: make, move: () => [], close: { onPick: close, disabled: true, title: "Nick Smith's session: theirs to close" } })[3]).toMatchObject({ disabled: true, title: "Nick Smith's session: theirs to close" });
  });

  it("an area's status says what its sessions do, or how many workspaces it has", () => {
    expect(areaStatus({ waiting: 1, working: 1, dead: 0, workspaces: 5 })).toBe("1 waiting · 1 working");
    expect(areaStatus({ waiting: 0, working: 0, dead: 1, workspaces: 2 })).toBe("1 exited");
    expect(areaStatus({ waiting: 0, working: 0, dead: 0, workspaces: 1 })).toBe("1 workspace");
  });
});

describe("the selection bar folds in a narrow window", () => {
  // a room's area bar as measured: its name, Chat, Board, Members, Follow, Ask for status, Tools and ⋯
  const room = [
    { key: "$id", w: 190, rank: 0 },
    { key: "tool:chat", w: 62, rank: 1 },
    { key: "board", w: 50, rank: 1 },
    { key: "members", w: 84, rank: 1 },
    { key: "follow:nick", w: 84, rank: 2 },
    { key: "ask", w: 98, rank: 2 },
    { key: "tools", w: 70, rank: 2 },
    { key: "$dots", w: 26, rank: 0 },
  ];
  const width = (items: readonly { w: number }[], gap = 6) => items.reduce((n, i) => n + i.w, 0) + gap * (items.length - 1);

  it("keeps every button when they fit: the bar is as wide as its buttons", () => {
    expect(foldBar(room, width(room), 70, 6)).toEqual({ shown: keys(room), folded: [] });
  });

  it("folds Tools, Ask for status and Follow first, the rightmost first, before the room's own tools; ⋯ never", () => {
    const one = foldBar(room, width(room) - 1, 70, 6);
    expect(one.folded).toEqual(["ask", "tools"]);
    const more = foldBar(room, width(room) - 120, 70, 6);
    expect(more.folded).toEqual(["follow:nick", "ask", "tools"]);
    expect(more.shown).toEqual(["$id", "tool:chat", "board", "members", "$dots"]);
    // what's left and » fit
    expect(width([...room.filter((i) => more.shown.includes(i.key)), { w: 70 }])).toBeLessThanOrEqual(width(room) - 120);
    // narrower still, the room's own tools go too, Members first; the name and ⋯ never do
    const tight = foldBar(room, 300, 70, 6);
    expect(tight.shown).toEqual(["$id", "$dots"]);
    expect(tight.folded).toEqual(["tool:chat", "board", "members", "follow:nick", "ask", "tools"]);
  });

  it("folds a workspace's Files and Artifacts before Focus, Changes and Run", () => {
    const ws = [
      { key: "$id", w: 160, rank: 0 },
      { key: "focus", w: 70, rank: 1 },
      { key: "tool:changes", w: 90, rank: 1 },
      { key: "tool:run", w: 60, rank: 1 },
      { key: "tool:files", w: 46, rank: 2 },
      { key: "tool:artifacts", w: 70, rank: 2 },
      { key: "$dots", w: 26, rank: 0 },
    ];
    expect(foldBar(ws, width(ws) - 10, 70, 6).folded).toEqual(["tool:files", "tool:artifacts"]);
  });

  it("remembers the second row for this window, and works without storage", () => {
    const kept = new Map<string, string>();
    const store: PrefStore = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v) };
    expect(readBarExtended(store)).toBe(false);
    expect(saveBarExtended(true, store)).toBe(true);
    expect(kept.get(BAR_EXTENDED_PREF)).toBe("true");
    expect(readBarExtended(store)).toBe(true);
    // storage that can't be read or written: the default, and the choice lasts this run only, said in the console
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken: PrefStore = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readBarExtended(broken)).toBe(false);
    expect(saveBarExtended(true, broken)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    // a value some other version left that isn't a yes is a no
    kept.set(BAR_EXTENDED_PREF, JSON.stringify("yes"));
    expect(readBarExtended(store)).toBe(false);
  });
});

describe("the selection bar floats over its selection", () => {
  const view = { w: 1000, h: 700 };
  const bar = { w: 420, h: 38 };

  it("sits just above the selection, lined up with its left edge, whatever the selection's width", () => {
    // a small area far out: the bar overhangs it
    expect(barPlace({ x: 300, y: 300, w: 60, h: 40 }, bar, view)).toEqual({ x: 300, y: 300 - BAR_GAP - 38 });
  });

  it("slides along the view's edges to stay inside it, never jumping", () => {
    expect(barPlace({ x: 800, y: 300, w: 60, h: 40 }, bar, view).x).toBe(1000 - 420 - BAR_MARGIN);
    expect(barPlace({ x: -500, y: 300, w: 60, h: 40 }, bar, view).x).toBe(BAR_MARGIN);
    // no room above: along the top edge, over the selection's top, never below it
    expect(barPlace({ x: 100, y: 20, w: 200, h: 100 }, bar, view)).toEqual({ x: 100, y: BAR_MARGIN });
    expect(barPlace({ x: 100, y: -200, w: 200, h: 2000 }, bar, view)).toEqual({ x: 100, y: BAR_MARGIN });
    // panned up a pixel at a time, it moves a pixel at a time until it meets the edge, then stays there
    const ys = [120, 80, 60, 54, 40, 0, -400].map((y) => barPlace({ x: 100, y, w: 200, h: 100 }, bar, view).y);
    expect(ys).toEqual([120 - 46, 80 - 46, 60 - 46, BAR_MARGIN, BAR_MARGIN, BAR_MARGIN, BAR_MARGIN]);
    // off screen below: along the bottom edge
    expect(barPlace({ x: 100, y: 1500, w: 200, h: 100 }, bar, view).y).toBe(700 - 38 - BAR_MARGIN);
    // never over the strip the area switcher takes
    expect(barPlace({ x: 100, y: 160, w: 200, h: 100 }, bar, view, 56).y).toBe(160 - BAR_GAP - 38);
    expect(barPlace({ x: 100, y: 60, w: 200, h: 100 }, bar, view, 56).y).toBe(56);
    expect(barPlace({ x: 100, y: -200, w: 200, h: 2000 }, bar, view, 56).y).toBe(56);
    // wider than the view: its left edge stays in
    expect(barPlace({ x: 300, y: 300, w: 60, h: 40 }, { w: 1200, h: 38 }, view).x).toBe(BAR_MARGIN);
  });

  it("goes above an area's header, or its name line zoomed out, or its pill", () => {
    const r = { x: 100, y: 200, w: 1000, h: 800 };
    // below 100% the header stays 38 px on screen, its bottom just inside the area's top edge (39 - 38 × zoom over it)
    expect(barAnchor(r, { x: 0, y: 0, zoom: 0.5 }, "areaHeader")).toEqual({ x: 50, y: 100 - (39 - 19), w: 500, h: 400 + 20 });
    expect(barAnchor(r, { x: 0, y: 0, zoom: 0.5 }, "areaHeader").y).toBe(100 - (AREA_HEAD_PX + 1 - AREA_HEAD_PX * 0.5));
    // at 100% and past it the header is inside the area, bar its pixel over the edge
    expect(barAnchor(r, { x: 0, y: 0, zoom: 2 }, "areaHeader").y).toBe(400 - 1);
    expect(barAnchor(r, { x: 0, y: 0, zoom: 1 }, "areaHeader").y).toBe(200 - 1);
    expect(barAnchor(r, { x: 0, y: 0, zoom: 0.2 }, "areaName")).toEqual({ x: 20, y: 40 - AREA_NAME_PX, w: 200, h: 160 + AREA_NAME_PX });
    expect(barAnchor(r, { x: 0, y: 0, zoom: 0.2 }, "pill")).toEqual({ x: 20, y: 40, w: 200, h: 34 });
    expect(barAnchor(r, { x: 50, y: 50, zoom: 0.5 }, "none")).toEqual({ x: 25, y: 75, w: 500, h: 400 });
  });
});

describe("Esc", () => {
  it("clears the selection only after a peek, a menu or a dialog over it have had it", () => {
    expect(escapeClears({ selected: true, peek: false, overlay: false })).toBe(true);
    expect(escapeClears({ selected: true, peek: true, overlay: false })).toBe(false);
    expect(escapeClears({ selected: true, peek: false, overlay: true })).toBe(false);
    expect(escapeClears({ selected: false, peek: false, overlay: false })).toBe(false);
  });
});

describe("a session a teammate took over", () => {
  it("is taken back, never worked on here: its turns, hand-on and resume are off in its model, saying why", () => {
    const took = sess({ status: "dead", room: { roomId: "r", remote: false, takenOver: { by: "m2", byName: "Nick Smith", at: 0 } } as unknown as SessionInfo["room"] });
    const acts = workspaceActions(took, env());
    for (const k of ["undo", "handoff", "brief", "review", "resume"]) {
      expect(actionOf(acts, k), k).toMatchObject({ disabled: true, title: expect.stringMatching(/^Nick Smith continues it on their laptop: take it back/) });
    }
    // its Take it back and Close stay
    expect(actionOf(acts, "close")?.disabled).toBeFalsy();
    // one not taken over does them as before
    for (const k of ["undo", "handoff", "brief", "review", "resume"]) expect(actionOf(workspaceActions(sess({ status: "dead" }), env()), k)?.disabled, k).toBeFalsy();
  });
});
