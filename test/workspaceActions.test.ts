import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../src/shared/types";
import type { Action, MenuEntry } from "../src/renderer/ContextMenu";
import { CLOSED_BUSY_WHY, actionOf, areaActions, artifactsOf, createActions, ghostActions, ghostsActions, inSection, lockTitle, menuOf, usable, workspaceActions, type AreaEnv, type GhostEnv, type WorkspaceEnv } from "../src/renderer/workspaceActions";

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
  diffPanel: true,
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

const keys = (acts: readonly { key: string }[]) => acts.map((a) => a.key);
const enabled = (acts: readonly Action[]) => acts.filter((a) => !a.disabled).map((a) => a.key);
const rows = (menu: MenuEntry[]) => menu.map((e) => (e === "-" ? "-" : e.heading ? `# ${e.label}` : e.key));

describe("a workspace's actions", () => {
  it("are the pane header's controls and the session's actions, in menu order, every one usable on a live session of yours", () => {
    const acts = workspaceActions(sess(), env());
    expect(keys(acts)).toEqual([
      "rename", "notify", "move", "size:S", "size:M", "size:L",
      "tool:files", "tool:changes", "tool:search", "tool:run", "tool:artifacts",
      "repaint", "diff", "undo", "handoff", "brief", "review", "close",
    ]);
    expect(enabled(acts)).toEqual(keys(acts));
    expect(actionOf(acts, "size:M")?.pressed).toBe(true);
    expect(actionOf(acts, "size:S")?.pressed).toBe(false);
    expect(actionOf(acts, "handoff")?.menuLabel).toBe("Continue in Codex…");
    expect(actionOf(acts, "tool:changes")?.kbd).toBe("⌃⇧G");
    expect(actionOf(acts, "close")?.menuLabel).toBe("Close…");
  });

  it("run their own handlers: a size its preset, a tool its kind", () => {
    const e = env();
    const acts = workspaceActions(sess(), e);
    actionOf(acts, "size:L")!.onPick();
    actionOf(acts, "tool:run")!.onPick();
    actionOf(acts, "undo")!.onPick();
    expect(e.resize).toHaveBeenCalledWith("L");
    expect(e.tool).toHaveBeenCalledWith("run");
    expect(e.undo).toHaveBeenCalledOnce();
  });

  it("say why one can't be done now, rather than leaving it out", () => {
    const acts = workspaceActions(sess({ shell: true }), env({ diffPanel: false, undo: { no: "A terminal has no agent turns to undo" }, handoff: { no: "A terminal has no agent to hand on" } }));
    expect(actionOf(acts, "undo")).toMatchObject({ disabled: true, title: "A terminal has no agent turns to undo" });
    expect(actionOf(acts, "handoff")).toMatchObject({ disabled: true, title: "A terminal has no agent to hand on" });
    expect(actionOf(acts, "diff")).toMatchObject({ disabled: true, title: "The agent's diff panel isn't open" });
    expect(usable(acts, "undo")).toBeUndefined();
    expect(usable(acts, "rename")?.key).toBe("rename");
  });

  it("offer sizes only on the landscape, each refused with the reason when the workspace can't change size", () => {
    expect(keys(workspaceActions(sess(), env({ size: null }))).some((k) => k.startsWith("size:"))).toBe(false);
    const acts = workspaceActions(sess(), env({ size: { current: null, blocked: "#5101 is locked" } }));
    for (const p of ["S", "M", "L"]) expect(actionOf(acts, `size:${p}`)).toMatchObject({ disabled: true, title: "#5101 is locked", pressed: false });
  });

  it("of a session that has exited: Resume, Close & clean up, and nothing that needs it running", () => {
    const e = env();
    const acts = workspaceActions(sess({ status: "dead" }), e);
    expect(actionOf(acts, "resume")).toMatchObject({ primary: true });
    expect(actionOf(acts, "close")?.menuLabel).toBe("Close & clean up…");
    expect(actionOf(acts, "repaint")).toMatchObject({ disabled: true, title: "Its session has exited" });
    // it has no folder to open tools on; Search looks everywhere, and its area's artifacts outlive it
    expect(enabled(acts.filter((a) => a.section === "tools"))).toEqual(["tool:search", "tool:artifacts"]);
    usable(acts, "resume")!.onPick();
    expect(e.resume).toHaveBeenCalledOnce();
  });

  it("of one a teammate took over: Resume refused, saying to take it back", () => {
    const acts = workspaceActions(sess({ status: "dead" }), env({ resume: { no: "Nick continues it on their laptop: take it back rather than resuming this copy" } }));
    expect(actionOf(acts, "resume")).toMatchObject({ disabled: true, title: expect.stringMatching(/take it back/) });
    expect(usable(acts, "resume")).toBeUndefined();
    expect(usable(acts, "close")?.menuLabel).toBe("Close & clean up…");
  });

  it("of a teammate's session: theirs to rename, move and close, never resumed here, and its tools have no folder on this Mac", () => {
    const acts = workspaceActions(sess({ status: "dead" }), env({ owner: "Nick Smith" }));
    for (const k of ["rename", "move", "close"]) expect(actionOf(acts, k)).toMatchObject({ disabled: true, title: expect.stringContaining("Nick Smith's session") });
    expect(actionOf(acts, "resume")).toBeUndefined();
    for (const k of ["tool:files", "tool:changes", "tool:search", "tool:run"]) expect(actionOf(acts, k)).toMatchObject({ disabled: true, title: "Nick Smith's session has no folder on this Mac" });
    expect(usable(acts, "notify")).toBeDefined();
  });

  it("carry the team room's actions in their own section", () => {
    const takeOver: Action = { key: "takeover", label: "Take over", onPick: vi.fn() };
    const acts = workspaceActions(sess(), env({ room: [takeOver] }));
    expect(actionOf(acts, "takeover")?.section).toBe("room");
    expect(keys(acts).indexOf("takeover")).toBe(keys(acts).indexOf("close") - 1);
  });
});

describe("a workspace's actions as a menu", () => {
  it("put each section under its heading, and Close after a separator", () => {
    const menu = rows(menuOf(workspaceActions(sess(), env({ room: [{ key: "takeover", label: "Take over", onPick: vi.fn() }] }))));
    expect(menu).toEqual([
      "# Session", "rename", "notify", "move", "size:S", "size:M", "size:L",
      "-", "# Tools", "tool:files", "tool:changes", "tool:search", "tool:run", "tool:artifacts",
      "-", "# Terminal", "repaint", "diff", "undo",
      "-", "# Hand on", "handoff", "brief", "review",
      "-", "# Team room", "takeover",
      "-", "close",
    ]);
  });

  it("keep an area's own rows in the section they're given, ready to join the model", () => {
    const area = inSection("area", [{ key: "rename", label: "Rename", onPick: vi.fn() }, "-", { key: "lock", label: "Lock", onPick: vi.fn() }]);
    expect(area.map((a) => [a.key, a.section])).toEqual([["rename", "area"], ["lock", "area"]]);
    expect(rows(menuOf(area))).toEqual(["# Area", "rename", "lock"]);
  });
});

describe("a right-click on the empty landscape", () => {
  it("offers today's ways to make a workspace, Collab and Pipeline off as coming, under New workspace", () => {
    const launch = vi.fn();
    const ticket = vi.fn();
    const importIt = vi.fn();
    const acts = createActions({ launch, ticket, importIt });
    expect(rows(menuOf(acts))).toEqual(["# New workspace", "new:claude", "new:codex", "new:shell", "new:ticket", "new:import", "new:collab", "new:pipeline"]);
    expect(acts.filter((a) => a.disabled).map((a) => [a.key, a.menuLabel])).toEqual([
      ["new:collab", "Collab… (coming)"],
      ["new:pipeline", "Pipeline from a ticket… (coming)"],
    ]);
    for (const a of acts.filter((x) => x.disabled)) expect(a.title).toMatch(/later version/);
    // each runs today's flow: the New Session dialog for its kind, the ticket popover, Import
    for (const k of ["new:claude", "new:codex", "new:shell", "new:ticket", "new:import"]) usable(acts, k)!.onPick(null as unknown as HTMLElement);
    expect(launch.mock.calls).toEqual([["claude"], ["codex"], ["shell"]]);
    expect([ticket.mock.calls.length, importIt.mock.calls.length]).toEqual([1, 1]);
  });
});

describe("a workspace's Artifacts", () => {
  it("is in its Tools, its area's window, off saying why for a loose one, and absent off the landscape", () => {
    const e = env();
    const row = actionOf(workspaceActions(sess(), e), "tool:artifacts")!;
    expect(row).toMatchObject({ section: "tools", label: "Artifacts" });
    row.onPick();
    expect(e.artifacts).toHaveBeenCalledOnce();
    expect(actionOf(workspaceActions(sess(), env({ artifacts: { no: "It's in no area: artifacts are kept by area" } })), "tool:artifacts")).toMatchObject({ disabled: true, title: "It's in no area: artifacts are kept by area" });
    expect(actionOf(workspaceActions(sess(), env({ artifacts: null })), "tool:artifacts")).toBeUndefined();
  });

  it("opens the area its tile is in, or its session's while it has no tile yet; a loose one's is off", () => {
    const show = vi.fn<(area: string) => void>();
    const run = (c: ReturnType<typeof artifactsOf>) => (typeof c === "function" ? c() : c);
    expect(run(artifactsOf({ area: "5102" }, { taskGroup: "5101" }, show))).toBeUndefined();
    expect(show).toHaveBeenLastCalledWith("5102");
    expect(run(artifactsOf(null, { taskGroup: "5101/api" }, show))).toBeUndefined();
    expect(show).toHaveBeenLastCalledWith("5101");
    expect(run(artifactsOf(undefined, { taskGroup: null }, show))).toEqual({ no: "It's in no area: artifacts are kept by area" });
    expect(run(artifactsOf({ area: "ungrouped" }, { taskGroup: "5101" }, show))).toEqual({ no: "It's in no area: artifacts are kept by area" });
    expect(show).toHaveBeenCalledTimes(2);
  });
});

describe("an area's actions", () => {
  const area = (over: Partial<AreaEnv> = {}): AreaEnv => ({
    title: "#5102 Pathways",
    stored: { collapsed: false, locked: false },
    room: false,
    landscape: true,
    empty: false,
    messages: { mode: undefined, defaultSend: true, set: vi.fn(), log: vi.fn() },
    follow: { leader: null, candidates: [], stop: vi.fn(), start: vi.fn() },
    rename: vi.fn(),
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
  const labels = (a: AreaEnv) => menuOf(areaActions(a)).map((e) => (e === "-" ? "-" : e.heading ? `# ${e.label}` : `${e.menuLabel ?? e.label}${e.pressed ? " ✓" : ""}`));

  it("say what Lock does now: the layout frozen, the area still pushed aside whole", () => {
    expect(actionOf(areaActions(area()), "lock")?.title).toMatch(/^Lock its layout: its workspaces keep their places, and none move in or out; it's still pushed aside whole/);
    expect(actionOf(areaActions(area({ stored: { collapsed: false, locked: true } })), "lock")?.title).toMatch(/^Unlock: /);
    expect(lockTitle(false)).not.toMatch(/around it/);
  });

  it("group an area that isn't a room's with no Team room heading: its sessions under Sessions, sharing on its own", () => {
    expect(labels(area())).toEqual([
      "# Area", "Rename…", "Collapse to a pill", "Lock its layout",
      "-", "# Tools", "Artifacts",
      "-", "# Agent messages", "As in Settings (auto-send) ✓", "Always auto-send", "Always leave in prompt", "Agent message log…",
      "-", "# Sessions", "New session here…", "Ask for status",
      "-", "Share as a team room…",
    ]);
  });

  it("put a room's tools under Team room, and only a room's", () => {
    const room = labels(area({ room: true, follow: { leader: null, candidates: [{ member: "m2", name: "Nick Smith" }], stop: vi.fn(), start: vi.fn() } }));
    expect(room.slice(room.indexOf("# Sessions"))).toEqual(["# Sessions", "New connected session here…", "Ask for status", "-", "# Team room", "House board…", "Follow Nick", "Invite a teammate…"]);
    expect(room).toContain("Chat");
  });

  it("offer agents' messages as three different choices, the one in force marked, none reading as another", () => {
    for (const defaultSend of [true, false]) {
      for (const mode of [undefined, "send", "prompt"] as const) {
        const rows = areaActions(area({ messages: { mode, defaultSend, set: vi.fn(), log: vi.fn() } })).filter((a) => a.key.startsWith("msg:"));
        const words = rows.map((r) => r.label.replace(/\s*\(.*\)$/, "").toLowerCase());
        expect(new Set(words).size, `${defaultSend} ${mode}`).toBe(3);
        expect(rows.filter((r) => r.pressed).map((r) => r.key)).toEqual([`msg:${mode ?? "default"}`]);
      }
    }
  });

  it("can be removed only once it has no sessions and a place on the landscape", () => {
    expect(actionOf(areaActions(area({ empty: true })), "remove")).toMatchObject({ section: "end", danger: true });
    expect(actionOf(areaActions(area({ empty: true, stored: null })), "remove")).toBeUndefined();
    expect(actionOf(areaActions(area()), "remove")).toBeUndefined();
  });

  it("offer Tidy (T) with the area's own rows, off saying why it can't be done, and none off the landscape", () => {
    const tidy = vi.fn();
    const on = actionOf(areaActions(area({ tidy })), "tidy")!;
    expect(on).toMatchObject({ section: "area", label: "Tidy", kbd: "T" });
    on.onPick();
    expect(tidy).toHaveBeenCalledOnce();
    expect(actionOf(areaActions(area({ tidy: { no: "#5102 Pathways is locked: unlock it to tidy it" } })), "tidy")).toMatchObject({ disabled: true, title: "#5102 Pathways is locked: unlock it to tidy it" });
    expect(actionOf(areaActions(area()), "tidy")).toBeUndefined();
  });

  it("offer Reopen all and Clear ghosts under Ghosts, counted, off with none to act on, none reopenable, or one under way", () => {
    const reopenAll = vi.fn();
    const clear = vi.fn();
    const acts = areaActions(area({ ghosts: { count: 2, reopenable: 2, running: false, reopenAll, clear } }));
    expect(menuOf(acts.filter((a) => a.section === "ghosts")).map((e) => (e === "-" ? "-" : e.heading ? `# ${e.label}` : (e.menuLabel ?? e.label)))).toEqual(["# Ghosts", "Reopen all (2)", "Clear ghosts (2)…"]);
    expect(actionOf(acts, "clearGhosts")?.danger).toBe(true);
    usable(acts, "reopenAll")!.onPick();
    usable(acts, "clearGhosts")!.onPick();
    expect([reopenAll.mock.calls.length, clear.mock.calls.length]).toEqual([1, 1]);
    expect(ghostsActions({ count: 0, reopenable: 0, running: false, reopenAll, clear }).map((a) => [a.key, a.disabled, a.title])).toEqual([
      ["reopenAll", true, "No closed workspaces here"],
      ["clearGhosts", true, "No closed workspaces here"],
    ]);
    // two closed, neither reopenable here (taken over, or their folders gone): Reopen all is off, saying why; Clear isn't
    expect(actionOf(ghostsActions({ count: 2, reopenable: 2, running: false, reopenAll, clear }, { what: "closed session" }), "clearGhosts")?.title).toBe("Forget all the closed sessions here: they can't be reopened after");
    const stuck = ghostsActions({ count: 2, reopenable: 0, running: false, reopenAll, clear });
    expect([actionOf(stuck, "reopenAll")?.disabled, actionOf(stuck, "reopenAll")?.menuLabel, actionOf(stuck, "reopenAll")?.title]).toEqual([true, "Reopen all", expect.stringMatching(/^None of these can be reopened here/)]);
    expect(usable(stuck, "clearGhosts")).toBeDefined();
    // three closed, one reopenable: it counts the one
    expect(actionOf(ghostsActions({ count: 3, reopenable: 1, running: false, reopenAll, clear }), "reopenAll")?.menuLabel).toBe("Reopen all (1)");
    // while one runs, neither starts again
    const running = ghostsActions({ count: 2, reopenable: 2, running: true, reopenAll, clear });
    expect(running.map((a) => [a.key, a.disabled, a.title])).toEqual([
      ["reopenAll", true, "Reopening them already"],
      ["clearGhosts", true, "Wait for Reopen all to finish"],
    ]);
  });
});

describe("a ghost's actions", () => {
  const genv = (over: Partial<GhostEnv> = {}): GhostEnv => ({ gone: null, tabs: 1, reopenable: 1, busy: false, room: [], reopen: vi.fn(), fresh: vi.fn(), forget: vi.fn(), ...over });
  const removed = { reopens: false, short: "Its worktree was removed", why: "Its worktree was removed, and its branch with it, so it can't run where it ran: start fresh instead" };
  const closed = sess({ status: "dead" });

  it("are Reopen, first and primary, then Forget, each running its own handler", () => {
    const e = genv();
    const acts = ghostActions(closed, e);
    expect(keys(acts)).toEqual(["reopen", "forget"]);
    expect(actionOf(acts, "reopen")).toMatchObject({ primary: true });
    expect(actionOf(acts, "forget")).toMatchObject({ danger: true, menuLabel: "Forget it" });
    usable(acts, "reopen")!.onPick();
    usable(acts, "forget")!.onPick();
    expect([vi.mocked(e.reopen).mock.calls.length, vi.mocked(e.forget).mock.calls.length]).toEqual([1, 1]);
  });

  it("of one whose worktree and branch were removed: Reopen off saying why, and Start fresh", () => {
    const acts = ghostActions(closed, genv({ gone: removed }));
    expect(actionOf(acts, "reopen")).toMatchObject({ disabled: true, title: removed.why });
    expect(usable(acts, "fresh")).toMatchObject({ label: "Start fresh", menuLabel: "Start fresh…" });
  });

  it("of one whose worktree was removed but whose branch is still there: Reopen, saying it's made again from the branch", () => {
    const why = "Its worktree was removed: reopening makes it again from its branch, 5101-x";
    const acts = ghostActions(closed, genv({ gone: { reopens: true, short: "Its worktree was removed · its branch is kept", why } }));
    expect(usable(acts, "reopen")).toMatchObject({ title: why });
    expect(actionOf(acts, "fresh")).toBeUndefined();
  });

  it("while it's being reopened or forgotten: Reopen and Forget off until that's done", () => {
    const acts = ghostActions(closed, genv({ busy: true }));
    expect([actionOf(acts, "reopen"), actionOf(acts, "forget")].map((a) => [a?.disabled, a?.title])).toEqual([
      [true, CLOSED_BUSY_WHY],
      [true, CLOSED_BUSY_WHY],
    ]);
  });

  it("of a stack's ghost none of whose tabs can be reopened here: Reopen off, saying why; Forget still offered", () => {
    const acts = ghostActions(closed, genv({ tabs: 3, reopenable: 0 }));
    expect(actionOf(acts, "reopen")).toMatchObject({ disabled: true, title: "None of its 3 tabs can be reopened here: taken over by a teammate, their folders gone, or being reopened or forgotten" });
    expect(usable(acts, "forget")).toBeDefined();
    expect(usable(ghostActions(closed, genv({ tabs: 3, reopenable: 1 })), "reopen")).toBeDefined();
  });

  it("of a stack's ghost of several tabs: Reopen and Forget name the tabs they act on", () => {
    const acts = ghostActions(closed, genv({ tabs: 3, reopenable: 3 }));
    expect([actionOf(acts, "reopen")?.menuLabel, actionOf(acts, "forget")?.menuLabel]).toEqual(["Reopen its 3 tabs", "Forget its 3 tabs"]);
    expect(actionOf(acts, "forget")?.title).toBe("Let this stack's 3 closed tabs go for good: they can't be reopened after");
  });

  it("of one a teammate continues: Reopen off by the take-over rule, its room's Take it back offered, never Start fresh", () => {
    const taken = sess({ status: "dead", room: { roomId: "R", sessionId: "s1", owner: "me", ownerName: "Ryan", takenOver: { by: "m2", byName: "Nick", at: 0 } } as SessionInfo["room"] });
    const back = vi.fn();
    const acts = ghostActions(taken, genv({ gone: removed, room: [{ key: "takeback", label: "Take it back", onPick: back }] }));
    expect(actionOf(acts, "reopen")).toMatchObject({ disabled: true, title: expect.stringMatching(/take it back rather than reopening this copy/) });
    expect(actionOf(acts, "fresh")).toBeUndefined();
    expect(usable(acts, "takeback")).toMatchObject({ section: "room", label: "Take it back" });
  });
});
