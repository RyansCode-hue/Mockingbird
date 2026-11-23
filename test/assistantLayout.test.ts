import { describe, expect, it } from "vitest";
import type { Landscape } from "../src/shared/landscape";
import { layoutTools } from "../src/main/assistant/tools/layout";
import type { AssistantTool, ToolResult } from "../src/main/assistant/registry";
import { harness } from "./assistantHarness";
import type { WorldRoom } from "../src/main/assistant/world";
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
  it("fix their tiers, move_across_room the one card, and only set_group, mute_session and unmute are rule-able", () => {
    const w = world();
    const all = layoutTools(w.deps);
    expect(Object.fromEntries(all.map((t) => [t.name, t.tier]))).toMatchObject({
      move_across_room: "confirm",
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
    const w = world({ over: { landscapeState: () => ({ landscape: { v: 4, workspaces: {}, areas: {}, stacks: {}, ghosts: {}, tools: {}, cards: {} }, rev: 1, problem: null }) } });
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

const ATTICUS_ROOM: WorldRoom = { id: "R1", name: "Atticus team", groupKey: "atticus", members: [{ name: "Ryan", self: true }, { name: "Nick", self: false }], online: ["nick"] };
const DOCS_ROOM: WorldRoom = { id: "R2", name: "Docs team", groupKey: "docs", members: [{ name: "Ryan", self: true }], online: [] };
const room = (id: string, groupKey: string): WorldRoom => ({ id, name: `${groupKey[0].toUpperCase()}${groupKey.slice(1)}`, groupKey, members: [{ name: "Ryan", self: true }], online: [] });

/** The layout world with team rooms: atticus is shared as “Atticus team” unless `rooms` says otherwise; each room's sandbox on unless `unsandboxed`. */
function roomWorld(rooms: WorldRoom[] = [ATTICUS_ROOM]) {
  const unsandboxed = new Set<string>();
  const w = world({ rooms, over: { wireList: () => [], roomSandboxed: (id) => (rooms.some((r) => r.id === id) ? !unsandboxed.has(id) : null) } });
  const mine = (id: string) => w.own.find((s) => s.id === id)!;
  return { ...w, rooms, unsandboxed, mine };
}

const across = (title: string, where: string) => `That would move “${title}” ${where}, which changes what teammates see: only move_across_room does that, on a card the user confirms`;

/** Make move_across_room's card through the service and press Do it: the card as it was shown, and as it settled. */
async function acrossConfirmed(w: ReturnType<typeof roomWorld>, args: Record<string, unknown>) {
  const h = harness([w.tool("move_across_room")]);
  const t = await h.turn("move it", async (call) => (await call("move_across_room", args), "Card up."));
  const card = await h.card(t.steps[0].cardId!);
  const before = { group: w.groupOf(String(args.session)), did: [...w.did] };
  return { card, before, done: await h.svc.confirm(card.id) };
}

describe("team rooms' boundaries", () => {
  it("set_group refuses a move into a room's group, out of one, or between two, naming move_across_room, in its check and its run", async () => {
    const w = roomWorld([ATTICUS_ROOM, DOCS_ROOM]);
    const set = w.tool("set_group");
    expect(await set.check!({ session: "f1", group: "atticus" })).toBe(across("f1", "into the team room “Atticus team”"));
    expect(await set.check!({ session: "f1", group: "atticus/tabs" })).toBe(across("f1", "into the team room “Atticus team”"));
    expect(await set.check!({ session: "a1", group: "frozen" })).toBe(across("a1", "out of the team room “Atticus team”"));
    expect(await set.check!({ session: "a1", group: "" })).toBe(across("a1", "out of the team room “Atticus team”"));
    expect(await set.check!({ session: "a1", group: "docs" })).toBe(across("a1", "out of the team room “Atticus team” and into “Docs team”"));
    expect(() => set.run({ session: "f1", group: "atticus" })).toThrow(across("f1", "into the team room “Atticus team”"));
    expect(w.did).toEqual([]);
    // inside one room, and between groups no room shares, it goes ahead
    expect(await set.check!({ session: "a1", group: "atticus/tabs" })).toBeNull();
    expect(await set.check!({ session: "f1", group: "elsewhere" })).toBeNull();
    // a teammate's session is the guard's to refuse first
    expect(await set.check!({ session: "r~nick~x", group: "docs" })).toContain("teammate's session");
  });

  it("move_workspace and create_group refuse a plan that moves a session across a room's boundary, and save nothing", async () => {
    const w = roomWorld();
    const rev = w.rev();
    expect(await w.tool("move_workspace").check!({ session: "d1", area: "atticus" })).toBe(across("d1", "into the team room “Atticus team”"));
    expect(await w.tool("move_workspace").check!({ session: "d1", next_to: "a1" })).toBe(across("d1", "into the team room “Atticus team”"));
    expect(await w.tool("move_workspace").check!({ session: "a1", area: "docs" })).toBe(across("a1", "out of the team room “Atticus team”"));
    expect(await w.tool("create_group").check!({ name: "misc", sessions: ["a1"] })).toBe(across("a1", "out of the team room “Atticus team”"));
    // run without its check, as nothing in the service does: carry refuses before saving a place
    await expect(Promise.resolve(w.tool("move_workspace").run({ session: "d1", area: "atticus" }))).rejects.toThrow(across("d1", "into the team room “Atticus team”"));
    await expect(Promise.resolve(w.tool("create_group").run({ name: "misc", sessions: ["a1"] }))).rejects.toThrow(across("a1", "out of the team room “Atticus team”"));
    expect(w.did).toEqual([]);
    expect(w.rev()).toBe(rev);
    expect(w.groupOf("d1")).toBe("docs");
    // what stays inside a room, or outside every room, goes ahead
    await go(w, "unstack", { session: "s1" });
    expect(w.groupOf("s1")).toBe("atticus");
    await go(w, "create_group", { name: "misc", sessions: ["d1"] });
    expect(w.groupOf("d1")).toBe("misc");
  });

  it("refuses an Undo that would cross a room's boundary: the group was shared as a room since", async () => {
    const w = roomWorld();
    const made = await go(w, "create_group", { name: "misc", sessions: ["d1"] });
    const set = await go(w, "set_group", { session: "f1", group: "elsewhere" });
    w.rooms.push(room("R3", "elsewhere"), room("R4", "misc"));
    expect(() => set.undo!()).toThrow(across("f1", "out of the team room “Elsewhere”"));
    expect(made.stillUndoable!()).toBe(true);
    await expect(Promise.resolve(made.undo!())).rejects.toThrow(across("d1", "out of the team room “Misc”"));
    expect(w.groupOf("f1")).toBe("elsewhere");
    expect(w.groupOf("d1")).toBe("misc");
  });

  it("a standing rule's set_group meets the same refusal on every run; move_across_room is never a rule's", async () => {
    const w = roomWorld();
    const h = harness(layoutTools(w.deps));
    expect(await h.svc.runAction({ tool: "set_group", args: { session: "d1", group: "atticus" }, label: "Move d1 to atticus" }, "Gather")).toMatchObject({
      ok: false,
      text: across("d1", "into the team room “Atticus team”"),
    });
    expect(await h.svc.runAction({ tool: "move_across_room", args: { session: "d1", group: "atticus" }, label: "Move d1 to atticus" }, "Gather")).toMatchObject({
      ok: false,
      text: "move_across_room can't be a standing rule's action",
    });
    expect(w.groupOf("d1")).toBe("docs");
    expect(await h.svc.runAction({ tool: "set_group", args: { session: "d1", group: "elsewhere" }, label: "Move d1" }, "Gather")).toMatchObject({ ok: true });
  });

  it("move_across_room's card says what teammates in the room will see, warns of a running session and a mode the room's sandbox wouldn't allow, and moves it only on Do it", async () => {
    const w = roomWorld();
    w.mine("d1").permissionMode = "bypass";
    const { card, before, done } = await acrossConfirmed(w, { session: "d1", group: "atticus" });
    expect(card).toMatchObject({
      tool: "move_across_room",
      title: "Move “d1” · d1 · docs into the team room “Atticus team”",
      detail:
        "Puts it in “atticus”. Teammates in “Atticus team” will see its terminal and scrollback, and their agents can message it. Moving it out again doesn't take back what they've seen.",
      warnings: [
        "It's running, so it joins as it started, outside the room's settings: teammates see its terminal from now, but nothing crosses the room's line for it (their agents' messages, wires, the House) until it's restarted in the room.",
        "“Atticus team”'s sandbox wouldn't allow the mode it runs in (Bypass permissions would loosen the team room's sandbox, where a mode may only tighten it: Ask as usual or Plan mode). It keeps that mode until it's restarted, and can't restart in the room in it.",
      ],
      danger: true,
    });
    expect(before).toEqual({ group: "docs", did: [] });
    expect(done).toMatchObject({ state: "done", result: "Moved “d1” to “atticus”: teammates in “Atticus team” see it now." });
    expect(w.did).toEqual(["group d1 atticus"]);
  });

  it("move_across_room names the session by its id as well as its title, two sharing one told apart, and warns of the mode its agent reports when that's wider", async () => {
    const w = roomWorld();
    w.own.push(info("d2", { taskGroup: "docs" }));
    w.mine("d1").title = "notes";
    w.mine("d2").title = "notes";
    const tool = w.tool("move_across_room");
    expect((await tool.card!({ session: "d1", group: "atticus" })).title).toBe("Move “notes” · d1 · docs into the team room “Atticus team”");
    expect((await tool.card!({ session: "d2", group: "atticus" })).title).toBe("Move “notes” · d2 · docs into the team room “Atticus team”");
    // launched asking as usual, switched to Auto in its pane: the room's sandbox wouldn't allow that
    Object.assign(w.mine("d2"), { status: "dead", liveMode: "auto" });
    expect((await tool.card!({ session: "d2", group: "atticus" })).warnings).toEqual([expect.stringMatching(/^“Atticus team”'s sandbox wouldn't allow the mode it runs in \(Auto would loosen/)]);
  });

  it("move_across_room out of a room says its teammates lose it; between rooms it says both; a Codex's every mode but the default is warned of", async () => {
    const w = roomWorld([ATTICUS_ROOM, DOCS_ROOM]);
    const tool = w.tool("move_across_room");
    w.rooms.splice(1, 1);
    expect(await tool.card!({ session: "a1", group: "docs" })).toEqual({
      title: "Move “a1” · a1 · atticus out of the team room “Atticus team”",
      detail: "Puts it in “docs”. Teammates in “Atticus team” lose it: it goes from their landscapes, and their agents can't message it any more.",
      warnings: [],
    });
    w.rooms.push(DOCS_ROOM);
    const between = await tool.card!({ session: "a1", group: "docs" });
    expect(between).toMatchObject({ title: "Move “a1” · a1 · atticus into the team room “Docs team” from “Atticus team”", danger: true });
    expect(between.detail).toBe(
      "Puts it in “docs”. Teammates in “Atticus team” lose it: it goes from their landscapes, and their agents can't message it any more. " +
        "Teammates in “Docs team” will see its terminal and scrollback, and their agents can message it. Moving it out again doesn't take back what they've seen."
    );
    Object.assign(w.mine("a1"), { agent: "codex", permissionMode: "plan", status: "dead" });
    expect((await tool.card!({ session: "a1", group: "docs" })).warnings).toEqual([expect.stringMatching(/^“Docs team”'s sandbox wouldn't allow the mode it runs in \(Codex's Plan mode picks its own sandbox/)]);
    // with the room's sandbox switched off on this Mac, the mode is the session's own
    w.unsandboxed.add("R2");
    expect((await tool.card!({ session: "a1", group: "docs" })).warnings).toEqual([]);
  });

  it("move_across_room shares a terminal saying it can read any file, refuses what isn't a crossing, the Helpdesk and a teammate's session", async () => {
    const w = roomWorld();
    const tool = w.tool("move_across_room");
    w.own.push(info("t1", { shell: true, taskGroup: "docs" }), info("h1", { taskGroup: "help", role: "tasks" }));
    expect(await tool.card!({ session: "t1", group: "atticus" })).toMatchObject({
      detail: "Puts it in “atticus”. Teammates in “Atticus team” will see its terminal and scrollback, and can ask you to let them type into it. Moving it out again doesn't take back what they've seen.",
      warnings: ["A terminal can read any file you can, .env files included, and teammates see whatever it prints."],
    });
    expect(await tool.check!({ session: "d1", group: "elsewhere" })).toBe("That move doesn't cross a team room's boundary: set_group makes it, with an Undo");
    expect(await tool.check!({ session: "a1", group: "atticus/tabs" })).toBe("That move doesn't cross a team room's boundary: set_group makes it, with an Undo");
    expect(await tool.check!({ session: "h1", group: "atticus" })).toBe("The Helpdesk tasks workspace never runs in a team room's area: teammates would see your admin consoles and could type into it.");
    expect(await tool.check!({ session: "r~nick~x", group: "docs" })).toBe("“r~nick~x” is Nick's session: only its owner can move it to another group");
    w.refuse.set("group d1", "It's being resumed");
    expect(await tool.check!({ session: "d1", group: "atticus" })).toBe("It's being resumed");
    expect(w.did).toEqual([]);
  });

  it("move_across_room's card expires when the move it showed changes: the session's group, a room, its mode or the room's sandbox", async () => {
    const w = roomWorld();
    const tool = w.tool("move_across_room");
    const fresh = async () => {
      const a = { session: "d1", group: "atticus" };
      await tool.card!(a);
      return a;
    };
    let a = await fresh();
    expect(tool.stillValid!(a)).toBe(true);
    w.mine("d1").permissionMode = "plan";
    expect(tool.stillValid!(a)).toBe(false);
    a = await fresh();
    w.unsandboxed.add("R1");
    expect(tool.stillValid!(a)).toBe(false);
    a = await fresh();
    w.mine("d1").taskGroup = "elsewhere";
    expect(tool.stillValid!(a)).toBe(false);
    a = await fresh();
    w.rooms.splice(0, 1);
    expect(tool.stillValid!(a)).toBe(false);
  });
});
