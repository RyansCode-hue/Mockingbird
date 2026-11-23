import { describe, expect, it } from "vitest";
import { ACCENT_NAMES } from "../src/shared/landscapeModel";
import type { AssistantTool, ToolResult } from "../src/main/assistant/registry";
import { accentNamed, lookTools } from "../src/main/assistant/tools/look";
import type { WorldRoom } from "../src/main/assistant/world";
import { harness } from "./assistantHarness";
import { info, landscapeWorld, theirs } from "./assistantWorld";

/** The Assistant's look tools (tools/look.ts) over a real LandscapeStore: atticus (a1, a2, Nick's x), docs (d1), and d9 exited in docs. */
function world(o: { rooms?: WorldRoom[] } = {}) {
  const own = [info("a1"), info("a2"), info("d1", { taskGroup: "docs" }), info("d9", { taskGroup: "docs", status: "dead" })];
  const w = landscapeWorld(own, {
    remote: [theirs("x", "atticus")],
    rooms: o.rooms,
    over: {
      record: (id) => {
        const s = own.find((x) => x.id === id);
        return s ? { info: s, open: true } : null;
      },
    },
  });
  const tools = lookTools(w.deps);
  const tool = (name: string): AssistantTool => tools.find((t) => t.name === name)!;
  const windows = () => w.store.get().landscape.tools;
  return { ...w, tools, tool, windows, accent: (key: string) => w.store.get().landscape.areas[key]?.accent };
}

async function go(w: ReturnType<typeof world>, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const why = await w.tool(name).check?.(args);
  if (why) throw new Error(`refused: ${why}`);
  return w.tool(name).run(args);
}

const placed = (session: string) => ({ tool: "changes" as const, docked: false, session, area: "atticus", placement: { x: 2000, y: 2000, w: 400, h: 300 } });

describe("set_area_colour", () => {
  it("is direct, never a rule's, and names the colours as the Colour popover does", () => {
    const w = world();
    expect(w.tools.map((t) => [t.name, t.tier, !!t.rule])).toEqual([
      ["set_area_colour", "direct", false],
      ["open_tool", "direct", false],
      ["close_tool", "direct", false],
    ]);
    expect(accentNamed("Blue")).toBe(ACCENT_NAMES.indexOf("Blue"));
    expect(accentNamed(" teal ")).toBe(ACCENT_NAMES.indexOf("Teal"));
    expect(accentNamed("automatic")).toBeNull();
    expect(accentNamed("chartreuse")).toBeUndefined();
  });

  it("colours an area, and its Undo puts the colour it had back while it's still the one set", async () => {
    const w = world();
    const r = await go(w, "set_area_colour", { group: "atticus", colour: "blue" });
    expect(r.text).toBe("Coloured “atticus” Blue.");
    expect(w.accent("atticus")).toBe(ACCENT_NAMES.indexOf("Blue"));
    expect(r.stillUndoable!()).toBe(true);
    expect(await r.undo!()).toMatch(/^Put “atticus” back to Automatic \(\w+\)$/);
    expect(w.accent("atticus")).toBeUndefined();

    const red = await go(w, "set_area_colour", { group: "docs", colour: "Red" });
    const green = await go(w, "set_area_colour", { group: "docs", colour: "Green" });
    // Red's Undo lapses once Green is set over it; Green's puts Red back
    expect(red.stillUndoable!()).toBe(false);
    expect(() => red.undo!()).toThrow("changed again");
    expect(await green.undo!()).toBe("Put “docs” back to Red");
    expect(w.accent("docs")).toBe(ACCENT_NAMES.indexOf("Red"));
    const auto = await go(w, "set_area_colour", { group: "docs", colour: "Automatic" });
    expect(auto.text).toMatch(/^“docs” takes its automatic colour again \(\w+\)\.$/);
    expect(w.accent("docs")).toBeUndefined();
  });

  it("refuses a colour that isn't one, an area that isn't there, and a colour it has already", async () => {
    const w = world();
    const t = w.tool("set_area_colour");
    expect(await t.check!({ group: "atticus", colour: "chartreuse" })).toContain("isn't a colour an area can be: Automatic, Amber, Teal");
    expect(await t.check!({ group: "nowhere", colour: "Blue" })).toContain("There's no area “nowhere”");
    expect(await t.check!({ group: "atticus", colour: "Automatic" })).toMatch(/takes its automatic colour \(\w+\) already/);
    await go(w, "set_area_colour", { group: "atticus", colour: "Pink" });
    expect(await t.check!({ group: "atticus", colour: "pink" })).toBe("“atticus” is Pink already");
  });

  it("runs through the service as a direct step with an Undo, recorded in the activity log", async () => {
    const w = world();
    const h = harness(w.tools);
    const t = await h.turn("make atticus violet", async (call) => (await call("set_area_colour", { group: "atticus", colour: "Violet" }), "Done."));
    const step = t.steps[0];
    expect(step).toMatchObject({ tool: "set_area_colour", tier: "direct", state: "done", label: "Colour “atticus” Violet" });
    expect(step.undoUntil).toBeGreaterThan(0);
    expect(await h.svc.undo(step.id)).toMatchObject({ state: "undone" });
    expect(w.accent("atticus")).toBeUndefined();
    expect(h.audit.map((a) => [a.source, a.outcome])).toEqual([
      ["step", "Colour “atticus” Violet: done"],
      ["undo", expect.stringContaining("Undid Colour “atticus” Violet: Put “atticus” back to Automatic")],
    ]);
  });
});

describe("open_tool", () => {
  it("asks the window to open the tool beside a session's workspace, in an area, or docked", async () => {
    const w = world({ rooms: [{ id: "R1", name: "Atticus team", groupKey: "atticus", members: [{ name: "Ryan", self: true }, { name: "Nick", self: false }], online: [] }] });
    await go(w, "open_tool", { kind: "changes", session: "a1" });
    await go(w, "open_tool", { kind: "chat", group: "atticus" });
    await go(w, "open_tool", { kind: "files", docked: true });
    await go(w, "open_tool", { kind: "search", session: "d9" });
    expect(w.did.filter((x) => x.startsWith("window"))).toEqual([
      `window ${JSON.stringify({ kind: "openTool", tool: "changes", session: "a1" })}`,
      `window ${JSON.stringify({ kind: "openTool", tool: "chat", area: "atticus" })}`,
      `window ${JSON.stringify({ kind: "openTool", tool: "files", docked: true })}`,
      `window ${JSON.stringify({ kind: "openTool", tool: "search", session: "d9" })}`,
    ]);
  });

  it("refuses what the window's own buttons would, and a window that's open there already", async () => {
    const w = world();
    const t = w.tool("open_tool");
    expect(await t.check!({ kind: "files", session: "r~nick~x" })).toContain("Nick's session: it has no folder on this Mac for Files");
    expect(await t.check!({ kind: "changes", session: "d9" })).toContain("has exited: only Search opens on it");
    expect(await t.check!({ kind: "files", session: "zz" })).toContain("no session with id");
    expect(await t.check!({ kind: "chat", group: "docs" })).toBe("“docs” isn't a team room's area: Chat is a room's");
    expect(await t.check!({ kind: "artifacts", group: "nowhere" })).toContain("There's no area “nowhere”");
    expect(await t.check!({ kind: "files", group: "atticus" })).toContain("Files opens beside a session's workspace: name the session");
    expect(await t.check!({ kind: "artifacts", session: "a1" })).toContain("Artifacts opens in an area: name its group");
    expect(await t.check!({ kind: "files", session: "a1", docked: true })).toContain("A docked window follows the selected workspace");
    w.store.update({ tools: { w1: placed("a1"), w2: { tool: "run", docked: true } } });
    expect(await t.check!({ kind: "changes", session: "a1" })).toBe("Changes is open beside “a1” already");
    expect(await t.check!({ kind: "run", docked: true })).toBe("Run & debug is docked already");
    w.store.update({ areas: { docs: { collapsed: true } } });
    expect(await t.check!({ kind: "files", session: "d1" })).toContain("which is collapsed: open it first");
    expect(w.did.filter((x) => x.startsWith("window"))).toEqual([]);
  });

  it("keeps an Undo that closes the window it opened, once the window has placed it, and lapses when it never did", async () => {
    const w = world();
    const r = await go(w, "open_tool", { kind: "changes", session: "a1" });
    expect(r.text).toBe("Opening Changes beside “a1”: the window docks it instead if there's no room there.");
    // before the window has placed it, the landscape is as it was
    expect(r.stillUndoable!()).toBe(true);
    w.store.update({ tools: { wNew: placed("a1") } });
    expect(r.stillUndoable!()).toBe(true);
    expect(await r.undo!()).toBe("Closed Changes again");
    expect(w.windows()).toEqual({});

    const never = await go(w, "open_tool", { kind: "files", session: "a2" });
    w.store.update({ areas: { docs: { locked: true } } });
    expect(never.stillUndoable!()).toBe(false);
    expect(() => never.undo!()).toThrow("Files didn't open, so there's nothing to close");
  });

  it("with the tool docked, shows the workspace there and opens nothing new", async () => {
    const w = world();
    w.store.update({ tools: { d: { tool: "changes", docked: true } } });
    const r = await go(w, "open_tool", { kind: "changes", session: "a2" });
    expect(r.text).toBe("Changes is docked, so it shows “a2” there now.");
    expect(r.undo).toBeUndefined();
    expect(w.did.filter((x) => x.startsWith("window"))).toEqual([`window ${JSON.stringify({ kind: "openTool", tool: "changes", session: "a2" })}`]);
  });
});

describe("close_tool", () => {
  it("closes the window where it's open, and its Undo puts it back while the landscape is unchanged", async () => {
    const w = world();
    w.store.update({ tools: { w1: placed("a1"), w2: { tool: "changes", docked: true } } });
    const r = await go(w, "close_tool", { kind: "changes", session: "a1" });
    expect(r.text).toBe("Closed Changes beside “a1”.");
    expect(Object.keys(w.windows())).toEqual(["w2"]);
    expect(await r.undo!()).toBe("Put Changes back");
    expect(w.windows().w1).toEqual(placed("a1"));

    const docked = await go(w, "close_tool", { kind: "changes", docked: true });
    expect(Object.keys(w.windows())).toEqual(["w1"]);
    w.store.update({ areas: { docs: { locked: true } } });
    expect(docked.stillUndoable!()).toBe(false);
    expect(() => docked.undo!()).toThrow("The landscape has changed since");
  });

  it("says when it isn't open there, and where it is", async () => {
    const w = world();
    w.store.update({ tools: { d: { tool: "search", docked: true } } });
    expect(await w.tool("close_tool").check!({ kind: "search", session: "a1" })).toBe("Search isn't open beside “a1”: it's docked, which close_tool with docked closes");
    expect(await w.tool("close_tool").check!({ kind: "artifacts", group: "docs" })).toBe("Artifacts isn't open in “docs”");
  });
});
