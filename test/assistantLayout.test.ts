import { describe, expect, it } from "vitest";
import type { Landscape } from "../src/shared/landscape";
import { layoutTools } from "../src/main/assistant/tools/layout";
import type { AssistantTool, ToolResult } from "../src/main/assistant/registry";
import { harness } from "./assistantHarness";
import { info, landscapeWorld, theirs, type LandscapeWorld } from "./assistantWorld";

/**
 * The Assistant's layout tools (tools/layout.ts) over a real LandscapeStore: atticus (a1, a2, the stack atticus/tabs of
 * s1 and s2, and Nick's room session), docs (d1) and frozen (f1, locked once laid out).
 */
function world(over: Parameters<typeof landscapeWorld>[1] = {}) {
  const w = landscapeWorld(
    [info("a1"), info("a2"), info("s1", { taskGroup: "atticus/tabs" }), info("s2", { taskGroup: "atticus/tabs" }), info("d1", { taskGroup: "docs" }), info("f1", { taskGroup: "frozen" })],
    { remote: [theirs("x", "atticus")], over: { wireList: () => [], ...over.over }, ...over }
  );
  w.store.update({ areas: { frozen: { locked: true } } });
  const tools = layoutTools(w.deps);
  const tool = (name: string): AssistantTool => tools.find((t) => t.name === name)!;
  return { ...w, tool, rev: () => w.store.get().rev, l: (): Landscape => structuredClone(w.store.get().landscape) };
}

/** Run `name` as the service would: its check, then its run. */
async function go(w: ReturnType<typeof world>, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const t = w.tool(name);
  const why = await t.check?.(args);
  if (why) throw new Error(`refused: ${why}`);
  return t.run(args);
}

/** A change to the landscape someone else made since (a drag, a lock): its revision moves on. */
const elsewhere = (w: LandscapeWorld) => w.store.update({ areas: { docs: { collapsed: true } } });

describe("the Assistant's layout tools", () => {
  it("fix their tiers, and only set_group, mute_session and unmute are rule-able", () => {
    const w = world();
    const all = layoutTools(w.deps);
    expect(Object.fromEntries(all.map((t) => [t.name, t.tier]))).toMatchObject({
      landscape: "read",
      move_workspace: "direct",
      stack_workspaces: "direct",
      unstack: "direct",
      size_workspace: "direct",
      tidy_area: "direct",
      set_group: "direct",
      create_group: "direct",
      rename_group: "direct",
      mute_session: "direct",
      unmute: "direct",
    });
    expect(all.filter((t) => t.rule).map((t) => t.name).sort()).toEqual(["mute_session", "set_group", "unmute"]);
  });

  it("landscape reads the areas, stacks, sizes and places, compactly, and keeps nothing", async () => {
    const w = world();
    const r = await w.tool("landscape").run({});
    const out = JSON.parse(r.text);
    expect(out.areas.map((a: { key: string }) => a.key).sort()).toEqual(["atticus", "docs", "frozen"]);
    expect(out.areas.find((a: { key: string }) => a.key === "frozen")).toMatchObject({ locked: true });
    const stack = out.workspaces.find((x: { stack?: string }) => x.stack === "atticus/tabs");
    expect(stack).toMatchObject({ sessions: ["s1", "s2"], front: "s1", area: "atticus" });
    expect(out.workspaces.find((x: { sessions: string[] }) => x.sessions[0] === "a1")).toMatchObject({ area: "atticus", size: "M", x: expect.any(Number), w: expect.any(Number) });
    expect(out.workspaces.find((x: { sessions: string[] }) => x.sessions[0] === "r~nick~x")).toMatchObject({ area: "atticus" });
    expect(r.undo).toBeUndefined();
  });

  it("refuses every change while the landscape can't be saved or isn't laid out yet", async () => {
    const w = world({ over: { landscapeState: () => ({ landscape: { v: 3, workspaces: {}, areas: {}, stacks: {}, ghosts: {}, tools: {}, cards: {} }, rev: 1, problem: null }) } });
    expect(await w.tool("move_workspace").check!({ session: "a1", area: "docs" })).toContain("hasn't been laid out yet");
    const v = world({ over: { landscapeState: () => ({ ...w.store.get(), problem: "landscape.json couldn't be read" }) } });
    expect(await v.tool("tidy_area").check!({ area: "atticus" })).toBe("The landscape can't be changed now: landscape.json couldn't be read");
  });

  describe("move_workspace", () => {
    it("moves a workspace into an area, its group following, with an Undo that puts its place and group back", async () => {
      const w = world();
      const before = w.l();
      const r = await go(w, "move_workspace", { session: "a1", area: "docs" });
      expect(r.text).toBe("Moved “a1” into “docs”.");
      expect(w.groupOf("a1")).toBe("docs");
      expect(w.l().workspaces.a1).not.toEqual(before.workspaces.a1);
      expect(w.did.filter((x) => x.startsWith("group"))).toEqual(["group a1 docs"]);
      expect(r.stillUndoable!()).toBe(true);
      expect(await r.undo!()).toBe("Put back “a1”'s place");
      expect(w.groupOf("a1")).toBe("atticus");
      expect(w.l().workspaces.a1).toEqual(before.workspaces.a1);
      expect(w.l().areas.docs).toEqual(before.areas.docs);
    });

    it("puts a workspace next to another, in that one's area, just right of it", async () => {
      const w = world();
      const d1 = w.l().workspaces.d1;
      await go(w, "move_workspace", { session: "a2", next_to: "d1" });
      expect(w.groupOf("a2")).toBe("docs");
      expect(w.l().workspaces.a2).toMatchObject({ x: d1.x + d1.w + 16, y: d1.y });
    });

    it("refuses what the landscape's drag refuses, saving nothing: into or out of a locked area, a stack loose, a teammate's", async () => {
      const w = world();
      const rev = w.rev();
      const move = w.tool("move_workspace");
      // the planners' own refusals (planMakeArea, planMoveTile)
      expect(await move.check!({ session: "a1", area: "frozen" })).toBe("“frozen” is locked: unlock it to add workspaces");
      expect(await move.check!({ session: "a1", next_to: "f1" })).toBe("“frozen” is locked: unlock it to add workspaces");
      expect(await move.check!({ session: "f1", next_to: "a1" })).toBe("“frozen” is locked: unlock it to move its workspaces");
      // the session guards' and the Assistant's own
      expect(await move.check!({ session: "r~nick~x", area: "docs" })).toContain("teammate's session");
      expect(await move.check!({ session: "a1", area: "nowhere" })).toBe("There's no area “nowhere” on the landscape: create_group makes one");
      expect(await move.check!({ session: "a1", area: "atticus" })).toBe("They're in “atticus” already");
      expect(await move.check!({ session: "a1", area: "docs", next_to: "d1" })).toContain("one of them");
      expect(await move.check!({ session: "zz", area: "docs" })).toContain("no session with id");
      w.refuse.set("group a1", "It's being resumed");
      expect(await move.check!({ session: "a1", area: "docs" })).toBe("It's being resumed");
      // the run plans again against the landscape as it is then, and refuses the same, saving nothing
      await expect(move.run({ session: "a1", next_to: "f1" })).rejects.toThrow("“frozen” is locked");
      expect(w.rev()).toBe(rev);
      expect(w.did.filter((x) => x.startsWith("patch") || x.startsWith("group"))).toEqual([]);
    });

    it("its Undo lapses once the landscape's revision moves on", async () => {
      const w = world();
      const r = await go(w, "move_workspace", { session: "a1", area: "docs" });
      elsewhere(w);
      expect(r.stillUndoable!()).toBe(false);
      await expect(r.undo!()).rejects.toThrow("changed since");
      expect(w.groupOf("a1")).toBe("docs");
    });
  });

  describe("stack_workspaces and unstack", () => {
    it("stacks workspaces of one area into a new stack, and its Undo puts them back apart", async () => {
      const w = world();
      const before = w.l();
      const r = await go(w, "stack_workspaces", { sessions: ["a1", "a2"] });
      expect(w.groupOf("a1")).toBe("atticus/tabs-2");
      expect(w.groupOf("a2")).toBe("atticus/tabs-2");
      expect(w.l().stacks["atticus/tabs-2"]).toMatchObject({ active: "a1", placement: before.workspaces.a1 });
      expect(r.stillUndoable!()).toBe(true);
      await r.undo!();
      expect([w.groupOf("a1"), w.groupOf("a2")]).toEqual(["atticus", "atticus"]);
      expect(w.l().workspaces.a1).toEqual(before.workspaces.a1);
      expect(w.l().workspaces.a2).toEqual(before.workspaces.a2);
      expect(w.l().stacks["atticus/tabs-2"]).toBeUndefined();
    });

    it("refuses what ⌘G refuses: different areas, one workspace, a locked area", async () => {
      const w = world();
      const stack = w.tool("stack_workspaces");
      expect(await stack.check!({ sessions: ["a1", "d1"] })).toBe("They're in different areas: move them into one area first");
      expect(await stack.check!({ sessions: ["s1", "s2"] })).toBe("Pick two or more workspaces to stack them");
      expect(await stack.check!({ sessions: ["a1", "r~nick~x"] })).toContain("teammate's session");
    });

    it("takes a tab out of its stack beside it; a stack left with one tab stops being one; Undo puts both back", async () => {
      const w = world();
      const before = w.l();
      const r = await go(w, "unstack", { session: "s1" });
      expect(w.groupOf("s1")).toBe("atticus");
      expect(w.groupOf("s2")).toBe("atticus");
      expect(w.l().workspaces.s1).toMatchObject({ x: before.stacks["atticus/tabs"].placement.x + before.stacks["atticus/tabs"].placement.w + 16 });
      await r.undo!();
      expect([w.groupOf("s1"), w.groupOf("s2")]).toEqual(["atticus/tabs", "atticus/tabs"]);
      expect(w.l().stacks["atticus/tabs"]).toEqual(before.stacks["atticus/tabs"]);
      expect(await w.tool("unstack").check!({ session: "a1" })).toBe("It isn't in a stack");
    });
  });

  describe("size_workspace", () => {
    it("sizes a workspace to a preset, refusing the size it is and a locked area's, with an Undo", async () => {
      const w = world();
      const was = w.l().workspaces.a1;
      const size = w.tool("size_workspace");
      expect(await size.check!({ session: "a1", size: "M" })).toBe("It's M already");
      expect(await size.check!({ session: "f1", size: "L" })).toBe("“frozen” is locked: unlock it to resize its workspaces");
      const r = await go(w, "size_workspace", { session: "a1", size: "L" });
      expect(w.l().workspaces.a1.w).toBeGreaterThan(was.w);
      expect(JSON.parse((await w.tool("landscape").run({})).text).workspaces.find((x: { sessions: string[] }) => x.sessions[0] === "a1").size).toBe("L");
      await r.undo!();
      expect(w.l().workspaces.a1).toEqual(was);
    });

    it("its Undo lapses once the landscape's revision moves on", async () => {
      const w = world();
      const r = await go(w, "size_workspace", { session: "a1", size: "S" });
      elsewhere(w);
      expect(r.stillUndoable!()).toBe(false);
    });
  });

  describe("tidy_area", () => {
    it("tidies an area as T does, refusing a tidy one and a locked one, with an Undo", async () => {
      const w = world();
      const tidy = w.tool("tidy_area");
      expect(await tidy.check!({ area: "frozen" })).toBe("“frozen” is locked: unlock it to tidy it");
      // a workspace dragged off to the far side of its area
      const a = w.l().areas.atticus;
      w.store.update({ areas: { atticus: { w: a.w + 2000 } }, workspaces: { a2: { ...w.l().workspaces.a2, x: a.x + a.w + 1000 } } });
      const untidy = w.l();
      const r = await go(w, "tidy_area", { area: "atticus" });
      expect(r.text).toBe("Tidied “atticus”.");
      expect(w.l().workspaces.a2.x).toBeLessThan(untidy.workspaces.a2.x);
      expect(await tidy.check!({ area: "atticus" })).toBe("“atticus” is tidy already");
      await r.undo!();
      expect(w.l().workspaces.a2).toEqual(untidy.workspaces.a2);
      expect(w.l().areas.atticus).toEqual(untidy.areas.atticus);
    });

    it("lays out in rows, saying so, when the wire book can't be read", async () => {
      const w = world({ over: { wireList: () => { throw new Error("landscape.json is newer"); } } });
      const a = w.l().areas.atticus;
      w.store.update({ areas: { atticus: { w: a.w + 2000 } }, workspaces: { a2: { ...w.l().workspaces.a2, x: a.x + a.w + 1000 } } });
      const r = await go(w, "tidy_area", { area: "atticus" });
      expect(r.text).toBe("Tidied “atticus”: its wires couldn't be read (landscape.json is newer), so it's laid out in rows.");
      elsewhere(w);
      expect(r.stillUndoable!()).toBe(false);
    });
  });

  describe("groups", () => {
    it("set_group moves a session to a group or out of every one, with an Undo that only puts back its own move", async () => {
      const w = world();
      const set = w.tool("set_group");
      expect(await set.check!({ session: "a1", group: "atticus" })).toBe("It's in “atticus” already");
      expect(await set.check!({ session: "r~nick~x", group: "docs" })).toContain("teammate's session");
      w.refuse.set("group a2", "Helpdesk can't be in a room");
      expect(await set.check!({ session: "a2", group: "docs" })).toBe("Helpdesk can't be in a room");
      const r = await go(w, "set_group", { session: "a1", group: " docs / api " });
      expect(w.groupOf("a1")).toBe("docs/api");
      expect(r.stillUndoable!()).toBe(true);
      expect(await r.undo!()).toBe("Moved it back to “atticus”");
      expect(w.groupOf("a1")).toBe("atticus");
      const out = await go(w, "set_group", { session: "a1", group: "" });
      expect(w.groupOf("a1")).toBe(null);
      w.deps.setGroup("a1", "elsewhere");
      expect(out.stillUndoable!()).toBe(false);
      expect(() => out.undo!()).toThrow("moved again");
    });

    it("create_group makes an area around sessions, or an empty one, refusing a name that's taken; Undo takes it away", async () => {
      const w = world();
      const create = w.tool("create_group");
      expect(await create.check!({ name: "docs" })).toBe("There's a group “docs” already: move workspaces into it with move_workspace");
      expect(await create.check!({ name: "ungrouped" })).toContain("can't name a group");
      const before = w.l();
      const r = await go(w, "create_group", { name: "review", sessions: ["a1", "a2"] });
      expect([w.groupOf("a1"), w.groupOf("a2")]).toEqual(["review", "review"]);
      expect(w.l().areas.review).toBeDefined();
      await r.undo!();
      expect([w.groupOf("a1"), w.groupOf("a2")]).toEqual(["atticus", "atticus"]);
      expect(w.l().areas.review).toBeUndefined();
      expect(w.l().workspaces.a1).toEqual(before.workspaces.a1);
      const empty = await go(w, "create_group", { name: "later" });
      expect(w.l().areas.later).toMatchObject({ repos: [] });
      elsewhere(w);
      expect(empty.stillUndoable!()).toBe(false);
    });

    it("rename_group renames a group, refusing a name that's taken, with an Undo while nothing renamed it again", async () => {
      const w = world();
      const rename = w.tool("rename_group");
      expect(await rename.check!({ group: "atticus", name: "docs" })).toContain("would merge the two");
      expect(await rename.check!({ group: "nope", name: "x" })).toContain("no group “nope”");
      expect(await rename.check!({ group: "atticus", name: "atticus" })).toBe("It's called “atticus” already");
      const r = await go(w, "rename_group", { group: "docs", name: "docs 2" });
      expect(w.did).toContain("renameGroup docs docs 2");
      expect(w.groupOf("d1")).toBe("docs 2");
      expect(w.l().areas["docs 2"]).toBeDefined();
      expect(r.stillUndoable!()).toBe(true);
      expect(await r.undo!()).toBe("Renamed back to “docs”");
      expect(w.groupOf("d1")).toBe("docs");
      expect(w.l().areas.docs).toBeDefined();
      const sub = await go(w, "rename_group", { group: "atticus/tabs", name: "pair" });
      expect(w.groupOf("s2")).toBe("atticus/pair");
      w.deps.renameGroup("atticus/pair", "atticus/other");
      expect(sub.stillUndoable!()).toBe(false);
    });
  });

  describe("mute_session and unmute", () => {
    it("mute and unmute a session of this Mac's, each with an Undo that lapses when it's changed again", async () => {
      const w = world();
      const r = await go(w, "mute_session", { session: "a1" });
      expect(w.deps.muted("a1")).toBe(true);
      expect(await w.tool("mute_session").check!({ session: "a1" })).toBe("It's muted already");
      expect(await r.undo!()).toBe("Unmuted it");
      expect(w.deps.muted("a1")).toBe(false);
      expect(await w.tool("unmute").check!({ session: "a1" })).toBe("It's unmuted already");
      await go(w, "mute_session", { session: "a1" });
      const u = await go(w, "unmute", { session: "a1" });
      expect(w.deps.muted("a1")).toBe(false);
      w.deps.setMuted("a1", true);
      expect(u.stillUndoable!()).toBe(false);
      expect(await w.tool("mute_session").check!({ session: "r~nick~x" })).toContain("teammate's session");
    });
  });

  it("focus_session and rename_session ask the session guards about this Mac's own", async () => {
    const w = world();
    w.refuse.set("focus a1", "It isn't on this Mac");
    w.refuse.set("rename a2", "A teammate continues it");
    expect(await w.tool("focus_session").check!({ session: "a1" })).toBe("It isn't on this Mac");
    expect(await w.tool("focus_session").check!({ session: "r~nick~x" })).toBeNull();
    expect(await w.tool("rename_session").check!({ session: "a2", title: "b" })).toBe("A teammate continues it");
  });

  it("through the service: a move's step keeps its Undo until the landscape's revision moves on", async () => {
    const w = world();
    const h = harness(layoutTools(w.deps));
    const t = await h.turn("put a1 with the docs", async (call) => (await call("move_workspace", { session: "a1", area: "docs" }), "Moved."));
    const step = t.steps[0];
    expect(step).toMatchObject({ state: "done", tier: "direct", undoUntil: expect.any(Number) });
    expect(h.audit).toEqual([expect.objectContaining({ kind: "assistant.action", tool: "move_workspace", source: "step", outcome: "Move “a1” into “docs”: done" })]);
    elsewhere(w);
    h.svc.stateChanged();
    expect((await h.step(step.id)).undoUntil).toBeUndefined();
    expect(await h.svc.undo(step.id)).toEqual({ error: expect.stringContaining("has no Undo") });
    expect(w.groupOf("a1")).toBe("docs");
  });
});
