import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../src/shared/types";
import type { Action, MenuEntry } from "../src/renderer/ContextMenu";
import { actionOf, inSection, menuOf, usable, workspaceActions, type WorkspaceEnv } from "../src/renderer/workspaceActions";

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
      "tool:files", "tool:changes", "tool:search", "tool:run",
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
    // it has no folder to open tools on; Search looks everywhere
    expect(enabled(acts.filter((a) => a.section === "tools"))).toEqual(["tool:search"]);
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
      "-", "# Tools", "tool:files", "tool:changes", "tool:search", "tool:run",
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
