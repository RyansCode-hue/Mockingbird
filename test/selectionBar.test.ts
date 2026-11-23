import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../src/shared/types";
import type { PrefStore } from "../src/renderer/prefs";
import {
  AREA_HEAD_PX,
  AREA_NAME_PX,
  BAR_EXTENDED_PREF,
  BAR_GAP,
  BAR_MARGIN,
  areaBarItems,
  areaStatus,
  barAnchor,
  barAnchorFor,
  barPlace,
  escapeClears,
  foldBar,
  readBarExtended,
  saveBarExtended,
  severalBarItems,
  workspaceBarItems,
} from "../src/renderer/selectionBarModel";
import { actionOf, areaActions, paneRow, severalActions, severalMenu, TAKEN_BACK_WHY, takenOverWhy, workspaceActions, type AreaEnv, type ModelAction, type WorkspaceEnv } from "../src/renderer/workspaceActions";
import type { MenuEntry } from "../src/renderer/ContextMenu";

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
  stack: null,
  newTab: vi.fn<() => void>(),
  diffPanel: false,
  room: [],
  rename: vi.fn(),
  mute: vi.fn(),
  move: vi.fn(),
  resize: vi.fn(),
  tool: vi.fn(),
  artifacts: vi.fn<() => void>(),
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

/** An area's env as main.tsx's areaActions makes it, every handler a spy. */
const areaEnv = (over: Partial<AreaEnv> = {}): AreaEnv => ({
  title: "#5101 Org dropdowns",
  stored: { collapsed: false, locked: false },
  room: true,
  empty: false,
  messages: { mode: undefined, defaultSend: true, set: vi.fn(), log: vi.fn() },
  follow: { leader: null, candidates: [{ member: "m2", name: "Nick Smith" }], stop: vi.fn(), start: vi.fn() },
  rename: vi.fn(),
  colour: vi.fn(),
  collapse: vi.fn(),
  lock: vi.fn(),
  tidy: null,
  ghosts: null,
  artifacts: vi.fn(),
  chat: vi.fn(),
  board: vi.fn(),
  share: vi.fn(),
  newSession: vi.fn(),
  ask: vi.fn(),
  remove: vi.fn(),
  ...over,
});

const keys = (items: readonly { key: string }[]) => items.map((i) => i.key);
const rows = (menu: MenuEntry[]) => menu.map((e) => (e === "-" ? "-" : e.heading ? `# ${e.label}` : (e.menuLabel ?? e.label)));

describe("the selection bar's buttons come from the action model", () => {
  it("a room's area: Chat, Board, Members and Follow, then Ask for status and Tools ▾", () => {
    const e = areaEnv();
    const items = areaBarItems(areaActions(e), { chatCount: "2", members: "Members ▾" });
    expect(keys(items)).toEqual(["tool:chat", "board", "members", "follow:m2", "ask", "tools"]);
    // the unread count rides on Chat, which is teal while there's any
    expect(items[0]).toMatchObject({ label: "Chat · 2", tone: "teal" });
    expect(items[3].label).toBe("Follow Nick");
    // the room's tools stay longest in a narrow window; Follow, Ask and Tools fold first
    expect(items.map((i) => i.rank)).toEqual([1, 1, 1, 2, 2, 2]);
    // a button runs the model row's own handler
    items.find((i) => i.key === "board")!.onPick!(null as unknown as HTMLElement);
    items.find((i) => i.key === "ask")!.onPick!(null as unknown as HTMLElement);
    items.find((i) => i.key === "follow:m2")!.onPick!(null as unknown as HTMLElement);
    expect(e.board).toHaveBeenCalledOnce();
    expect(e.ask).toHaveBeenCalledOnce();
    expect(e.follow.start).toHaveBeenCalledWith("m2");
    // Tools ▾ is the model's Tools rows, as a menu
    expect(keys(items.at(-1)!.menu!() as { key: string }[])).toEqual(["tool:artifacts", "tool:chat"]);
  });

  it("an area that isn't a room's has no room tools at all, while following a teammate too", () => {
    for (const leader of [null, "Nick Smith"]) {
      const acts = areaActions(areaEnv({ room: false, follow: { leader, candidates: [{ member: "m2", name: "Nick Smith" }], stop: vi.fn(), start: vi.fn() } }));
      expect(acts.filter((a) => /^(tool:chat|board|follow:)/.test(a.key)), String(leader)).toEqual([]);
      const items = areaBarItems(acts, { chatCount: "3", members: "Members ▾" });
      expect(keys(items), String(leader)).toEqual(["ask", "tools"]);
      expect(keys(items[1].menu!() as { key: string }[])).toEqual(["tool:artifacts"]);
    }
    // in a room's area, following: Stop following, and no one else to follow
    const following = areaActions(areaEnv({ follow: { leader: "Nick Smith", candidates: [{ member: "m2", name: "Nick Smith" }], stop: vi.fn(), start: vi.fn() } }));
    expect(following.filter((a) => a.key.startsWith("follow:")).map((a) => a.label)).toEqual(["Stop following Nick"]);
  });

  it("a workspace: Focus, Δ Changes and ▶ Run, then Files and Artifacts, each the model's row with its reason", () => {
    const e = env();
    const acts = workspaceActions(sess(), e);
    const focus = vi.fn();
    const items = workspaceBarItems(acts, { onFocus: focus, changes: 3, runs: 1 });
    expect(keys(items)).toEqual(["focus", "tool:changes", "tool:run", "tool:files", "tool:artifacts"]);
    expect(items.map((i) => i.label)).toEqual(["Focus", "Δ 3 Changes", "▶ 1 Run", "Files", "Artifacts"]);
    expect(items.map((i) => i.rank)).toEqual([1, 1, 1, 2, 2]);
    expect(items[0].kbd).toBe("⌘E");
    items[0].onPick!(null as unknown as HTMLElement);
    items[2].onPick!(null as unknown as HTMLElement);
    items[4].onPick!(null as unknown as HTMLElement);
    expect(focus).toHaveBeenCalledOnce();
    expect(e.tool).toHaveBeenCalledWith("run");
    expect(e.artifacts).toHaveBeenCalledOnce();
    // its shortcut in its tooltip, as the menu shows it
    expect(items[1].title).toMatch(/⌃⇧G/);
    // nothing to count reads plainly
    expect(workspaceBarItems(acts, { onFocus: focus, changes: 0, runs: 0 }).map((i) => i.label).slice(1, 3)).toEqual(["Δ Changes", "▶ Run"]);
    // a teammate's session: its tools are off, saying why, as its menu's rows are
    const theirs = workspaceBarItems(workspaceActions(sess({ room: { remote: true } as SessionInfo["room"] }), env({ owner: "Nick Smith" })), { onFocus: focus, changes: 0, runs: 0 });
    for (const k of ["tool:changes", "tool:run", "tool:files"]) expect(theirs.find((i) => i.key === k)).toMatchObject({ disabled: true, title: "Nick Smith's session has no folder on this Mac" });
    // a loose one's Artifacts is off, saying why
    const loose = workspaceBarItems(workspaceActions(sess(), env({ artifacts: { no: "It's in no area: artifacts are kept by area" } })), { onFocus: focus, changes: 0, runs: 0 });
    expect(loose.at(-1)).toMatchObject({ key: "tool:artifacts", disabled: true, title: "It's in no area: artifacts are kept by area" });
  });

  it("a workspace whose changes couldn't be read says so, never as no changes", () => {
    const items = workspaceBarItems(workspaceActions(sess(), env()), { onFocus: vi.fn(), changes: { error: "EACCES: permission denied" }, runs: 0 });
    expect(items[1]).toMatchObject({ key: "tool:changes", label: "Δ ?", title: "Couldn't read its changes: EACCES: permission denied" });
    expect(items[1].disabled).toBeFalsy();
  });

  it("several: Make area… M, Stack ⌘G, Move to area ▾ and Close…, one model with their right-click", () => {
    const make = vi.fn();
    const close = vi.fn();
    const to = vi.fn();
    const stack = vi.fn();
    const acts = severalActions({
      makeArea: make,
      stack,
      areas: [
        { key: "5101", title: "#5101", refused: "They're in #5101 already", pick: vi.fn() },
        { key: "5102", title: "#5102", refused: null, pick: to },
      ],
      close,
    });
    const items = severalBarItems(acts);
    expect(keys(items)).toEqual(["makeArea", "stack", "move", "close"]);
    expect(items[0]).toMatchObject({ label: "Make area…", kbd: "M", title: "Make an area of them (M)" });
    expect(items[1]).toMatchObject({ label: "Stack", kbd: "⌘G", title: "Stack them into one card with a tab each (⌘G)" });
    expect(items[1].disabled).toBeFalsy();
    expect(items[3]).toMatchObject({ label: "Close…", tone: "danger" });
    items[0].onPick!(null as unknown as HTMLElement);
    items[1].onPick!(null as unknown as HTMLElement);
    items[3].onPick!(null as unknown as HTMLElement);
    expect([make.mock.calls.length, stack.mock.calls.length, close.mock.calls.length]).toEqual([1, 1, 1]);
    // Move to area ▾ is the model's Move rows, the area they're in off saying why
    const moves = items[2].menu!() as ModelAction[];
    expect(moves.map((m) => [m.label, !!m.disabled, m.title ?? null])).toEqual([
      ["#5101", true, "They're in #5101 already"],
      ["#5102", false, null],
    ]);
    moves[1].onPick();
    expect(to).toHaveBeenCalledOnce();
    // their right-click: the same rows and titles, under how many are picked
    expect(rows(severalMenu(3, acts))).toEqual(["# 3 selected", "Make area…", "Stack", "-", "# Move to area", "#5101", "#5102", "-", "Close…"]);
    expect(actionOf(acts, "makeArea")!.title).toBe("Make an area of them");
    // none that can be closed here: Close is off, saying why
    expect(severalBarItems(severalActions({ makeArea: make, stack, areas: [], close: { no: "They're teammates' sessions: theirs to close" } })).at(-1)).toMatchObject({ disabled: true, title: "They're teammates' sessions: theirs to close" });
    // several that can't be stacked: Stack is off, saying why (planStack's refusal)
    expect(severalBarItems(severalActions({ makeArea: make, stack: { no: "They're in different areas" }, areas: [], close })).find((i) => i.key === "stack")).toMatchObject({ disabled: true, title: "They're in different areas" });
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

  it("keeps clear of the minimap: left of it at the same height, or above it when the view has no room left of it", () => {
    const minimap = { x: 1000 - 12 - 196, y: 700 - 12 - 124, w: 196, h: 124 };
    // a selection low and right, whose bar would lie over the minimap
    const at = barPlace({ x: 700, y: 640, w: 200, h: 40 }, bar, view, 0, BAR_MARGIN, BAR_GAP, minimap);
    expect(at).toEqual({ x: minimap.x - BAR_GAP - bar.w, y: 640 - BAR_GAP - 38 });
    // one clear of it is where it'd be anyway
    expect(barPlace({ x: 100, y: 640, w: 200, h: 40 }, bar, view, 0, BAR_MARGIN, BAR_GAP, minimap)).toEqual(barPlace({ x: 100, y: 640, w: 200, h: 40 }, bar, view));
    // a bar too wide to go left of it goes above it
    const wide = { w: 900, h: 38 };
    expect(barPlace({ x: 50, y: 680, w: 200, h: 10 }, wide, view, 0, BAR_MARGIN, BAR_GAP, minimap).y).toBe(minimap.y - BAR_GAP - 38);
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

  it("goes above the area's name line or header, never onto it, over workspaces at the area's top", () => {
    const area = { x: 0, y: 0, w: 2400, h: 1200 };
    const ws = { x: 24, y: 48, w: 1072, h: 800 };
    const cards = { x: 0, y: 0, zoom: 0.3 };
    const t = { rect: ws, chrome: "none" as const, within: { rect: area, chrome: "areaName" as const } };
    // above the workspace the bar would reach past the area's top edge onto its name line: it goes above that
    const a = barAnchorFor(t, cards, 38);
    expect(a.y).toBe(-AREA_NAME_PX);
    expect(a.y + a.h).toBeCloseTo((48 + 800) * 0.3, 9);
    // one further down has room above it inside the area: just above it, as before
    const low = { ...t, rect: { ...ws, y: 600 } };
    expect(barAnchorFor(low, cards, 38)).toEqual(barAnchor(low.rect, cards, "none"));
    // at 100% the header is inside the area: a workspace just under it has the bar above the header, not over it
    const live = { ...t, within: { rect: area, chrome: "areaHeader" as const } };
    expect(barAnchorFor(live, { x: 0, y: 0, zoom: 1 }, 38).y).toBe(-1);
    expect(barAnchorFor({ ...live, rect: { ...ws, y: 200 } }, { x: 0, y: 0, zoom: 1 }, 38).y).toBe(200);
    // below 100%, the header reaching up past the area's edge: above that
    expect(barAnchorFor(live, { x: 0, y: 0, zoom: 0.5 }, 38).y).toBe(barAnchor(area, { x: 0, y: 0, zoom: 0.5 }, "areaHeader").y);
    // in no area: as before
    expect(barAnchorFor({ rect: ws, chrome: "none" }, cards, 38)).toEqual(barAnchor(ws, cards, "none"));
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

  it("taken back since into another session here: the same rows off, saying that one goes on with it — Nick no longer continues it", () => {
    const back = sess({ status: "dead", room: { roomId: "r", remote: false, takenOver: { by: "m2", byName: "Nick Smith", at: 0, back: true } } as unknown as SessionInfo["room"] });
    const acts = workspaceActions(back, env());
    for (const k of ["undo", "handoff", "brief", "review", "resume"]) expect(actionOf(acts, k), k).toMatchObject({ disabled: true, title: TAKEN_BACK_WHY });
    expect(takenOverWhy(back, "rather than resuming this copy")).not.toMatch(/Nick/);
  });

  it("in the grid's pane header and ⌘K: off with the take-over's reason only where the row would otherwise show", () => {
    const tag = { roomId: "r", remote: false, takenOver: { by: "m2", byName: "Nick Smith", at: 0 } } as unknown as SessionInfo["room"];
    const outsideGit = env({ undo: { no: "It isn't in a git repository, so its turns can't be put back" } });
    const terminal = env({ undo: { no: "A terminal has no agent turns to undo" }, handoff: { no: "A terminal has no agent to hand on" } });
    // taken over, in git: off, saying to take it back
    for (const k of ["undo", "handoff"]) expect(paneRow(sess({ room: tag }), env(), k), k).toMatchObject({ disabled: true, title: expect.stringMatching(/^Nick Smith continues it on their laptop: take it back/) });
    // taken over where it never applies: not shown, as without the take-over
    expect(paneRow(sess({ room: tag, repoPath: null }), outsideGit, "undo")).toBeUndefined();
    expect(paneRow(sess({ room: tag }), outsideGit, "handoff")).toMatchObject({ disabled: true });
    for (const k of ["undo", "handoff"]) expect(paneRow(sess({ room: tag, shell: true }), terminal, k), k).toBeUndefined();
    // no one took it over: shown while it can be done, never off
    for (const k of ["undo", "handoff"]) expect(paneRow(sess(), env(), k)?.disabled, k).toBeFalsy();
    expect(paneRow(sess({ repoPath: null }), outsideGit, "undo")).toBeUndefined();
    for (const k of ["undo", "handoff"]) expect(paneRow(sess({ shell: true }), terminal, k), k).toBeUndefined();
  });
});
