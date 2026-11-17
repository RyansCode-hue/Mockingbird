import { describe, expect, it } from "vitest";
import { put } from "../src/shared/landscape";
import type { SendReply } from "../src/shared/wires";
import { WireService } from "../src/main/wires";
import { wireDeps, wireTools } from "../src/main/assistant/tools/wires";
import type { AssistantTool, ToolResult } from "../src/main/assistant/registry";
import { harness } from "./assistantHarness";
import { info, landscapeWorld } from "./assistantWorld";

/**
 * The Assistant's wire tools (tools/wires.ts) over the real wire service and LandscapeStore: a1 and a2 are agents in
 * atticus, t1 a terminal, x1 outside its room's sandbox. The ticket pipeline and a person's Send are the test's.
 */
function world() {
  const own = [info("a1", { title: "Builder" }), info("a2", { title: "Reviewer" }), info("t1", { title: "Dev server", shell: true, agent: undefined }), info("x1", { title: "Outside" })];
  const sent: { id: string; pending: string; body: string }[] = [];
  let reply: SendReply | null = null;
  const stages: Record<string, { stage: string; title: string | null }> = { "5101": { stage: "stakeholder", title: "Org dropdowns" }, "5102": { stage: "coding", title: null } };
  const approved: string[] = [];
  const problems: string[] = [];
  let service!: WireService;
  const w = landscapeWorld(own, {
    over: {
      ...wireDeps({
        store: () => w.store,
        service: () => service,
        send: async (id, pending, body) => {
          sent.push({ id, pending, body });
          return reply ?? { state: w.store.wires() };
        },
      }),
      ticketStage: (id) => stages[id] ?? null,
      approveTicket: async (id) => {
        approved.push(id);
        stages[id] = { ...stages[id], stage: "approved" };
        return "“Builder” was told to prepare the pull request to main.";
      },
    },
  });
  service = new WireService({ store: w.store, sessions: { list: () => own, resumable: () => [], planned: () => [] }, roomOf: () => null, takenOver: () => null, outsideSandbox: (id) => id === "x1", log: (c, e) => void problems.push(`${c}: ${String(e)}`) });
  const tools = wireTools(w.deps);
  const tool = (name: string): AssistantTool => tools.find((t) => t.name === name)!;
  /** What waits at wire `id`'s gate: a pending readied as a finish readies one. */
  const ready = (id: string, body: string) =>
    w.store.editWires((book) => {
      const links = { ...book.links };
      put(links, id, { ...links[id], pending: { id: `p-${id}`, body, at: Date.UTC(2026, 10, 16, 12), flags: [] } });
      return { book: { ...book, links } };
    });
  return { ...w, service, tool, ready, sent, approved, stages, problems, setReply: (r: SendReply | null) => void (reply = r) };
}

async function go(w: ReturnType<typeof world>, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const why = await w.tool(name).check?.(args);
  if (why) throw new Error(`refused: ${why}`);
  return w.tool(name).run(args);
}

describe("the Assistant's wire tools", () => {
  it("fix their tiers, and none is rule-able", () => {
    const w = world();
    expect(Object.fromEntries(wireTools(w.deps).map((t) => [t.name, t.tier]))).toEqual({ list_wires: "read", add_wire: "direct", remove_wire: "direct", send_handoff: "confirm", approve_gate: "confirm" });
    expect(wireTools(w.deps).filter((t) => t.rule)).toEqual([]);
  });

  it("add_wire draws a wire through the wire service's checks, and its Undo removes it while it's that wire", async () => {
    const w = world();
    const add = w.tool("add_wire");
    expect(add.label({ from: "a1", to: "a2", type: "handoff" })).toBe("Draw a handoff from “Builder” to “Reviewer”");
    // the service's own rules: a session outside its room's sandbox, a wire to itself; and the guards'
    expect(await add.check!({ from: "a1", to: "x1", type: "handoff" })).toContain("isn't in its team room's sandbox");
    expect(await add.check!({ from: "a1", to: "a1", type: "handoff" })).toEqual(expect.any(String));
    w.refuse.set("focus a2", "A teammate continues it on their laptop");
    expect(await add.check!({ from: "a1", to: "a2", type: "handoff" })).toBe("A teammate continues it on their laptop");
    w.refuse.clear();
    const r = await go(w, "add_wire", { from: "a1", to: "a2", type: "handoff" });
    const [made] = w.deps.wireList();
    expect(made).toMatchObject({ from: "a1", to: "a2", type: "handoff", when: "finished", state: "idle", waiting: null });
    expect(r.text).toBe(`Drew a handoff from “Builder” to “Reviewer” (wire ${made.id}).`);
    expect(r.stillUndoable!()).toBe(true);
    expect(await r.undo!()).toBe("Removed the handoff from “Builder” to “Reviewer”");
    expect(w.deps.wireList()).toEqual([]);
    expect(r.stillUndoable!()).toBe(false);
  });

  it("remove_wire removes one, and its Undo restores it while the service still holds it", async () => {
    const w = world();
    const id = w.deps.addWire("a1", "a2", "context");
    expect(await w.tool("remove_wire").check!({ wire: "nope" })).toContain("no wire");
    const r = await go(w, "remove_wire", { wire: id });
    expect(w.deps.wireList()).toEqual([]);
    expect(r.stillUndoable!()).toBe(true);
    expect(await r.undo!()).toBe("Put the context link from “Builder” to “Reviewer” back");
    expect(w.deps.wireList().map((x) => x.id)).toEqual([id]);
    // restored, it isn't held any more: a second removal's Undo is its own
    expect(r.stillUndoable!()).toBe(false);
    await expect(Promise.resolve().then(() => r.undo!())).rejects.toThrow("can't be put back");
  });

  it("list_wires gives ends, gates and what waits by id and length, never its text", async () => {
    const w = world();
    const id = w.deps.addWire("a1", "a2", "handoff");
    w.ready(id, "SECRET summary of the work");
    const out = JSON.parse((await w.tool("list_wires").run({})).text).wires;
    expect(out).toEqual([
      expect.objectContaining({ id, from: "a1", fromTitle: "Builder", to: "a2", toTitle: "Reviewer", type: "handoff", state: "ready", gate: "ask", waiting: { pending: `p-${id}`, since: "2026-11-16T12:00:00.000Z", chars: 26 } }),
    ]);
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("send_handoff is a card: nothing is sent until Do it, which sends the pending as it was readied", async () => {
    const w = world();
    const id = w.deps.addWire("a1", "a2", "handoff");
    const send = w.tool("send_handoff");
    expect(await send.check!({ wire: id, pending: `p-${id}` })).toContain("Nothing with that id waits");
    w.ready(id, "the summary");
    const h = harness([send]);
    const t = await h.turn("send the handoff", async (call) => (await call("send_handoff", { wire: id, pending: `p-${id}` }), "Card up."));
    expect(w.sent).toEqual([]);
    const card = await h.card(t.steps[0].cardId!);
    expect(card).toMatchObject({ title: "Send what waits on the handoff from “Builder” · a1 · atticus to “Reviewer” · a2 · atticus", detail: expect.stringContaining("11 characters"), state: "open", blocked: null });
    expect(await h.svc.confirm(card.id)).toMatchObject({ state: "done" });
    expect(w.sent).toEqual([{ id, pending: `p-${id}`, body: "the summary" }]);
  });

  it("send_handoff's card expires once another message waits instead, and a refused send fails, saying why", async () => {
    const w = world();
    const id = w.deps.addWire("a1", "a2", "handoff");
    w.ready(id, "first");
    const send = w.tool("send_handoff");
    expect(send.stillValid!({ wire: id, pending: `p-${id}` })).toBe(true);
    w.store.editWires((book) => ({ book: { ...book, links: { ...book.links, [id]: { ...book.links[id], pending: { id: "p-next", body: "second", at: 1, flags: [] } } } } }));
    expect(send.stillValid!({ wire: id, pending: `p-${id}` })).toBe(false);
    w.setReply({ refused: "“Reviewer” is closed.", start: "reopen" });
    await expect(send.run({ wire: id, pending: "p-next" })).rejects.toThrow("“Reviewer” is closed. Send it from the wire's popover, which asks before starting it.");
    // its other end is typed into: the session guards' write check
    w.refuse.set("write a2", "It's a terminal: what's typed into it runs as commands");
    expect(await send.check!({ wire: id, pending: "p-next" })).toBe("It's a terminal: what's typed into it runs as commands");
  });

  it("approve_gate approves a ticket at stakeholder testing only, as a card", async () => {
    const w = world();
    const approve = w.tool("approve_gate");
    expect(await approve.check!({ ticket: "5102" })).toBe("#5102 is at Coding: Approve is for a ticket in stakeholder testing");
    expect(await approve.check!({ ticket: "9" })).toBe("#9 isn't tracked in the ticket pipeline");
    expect(await approve.card!({ ticket: "5101" })).toMatchObject({ title: "Approve #5101 “Org dropdowns” in stakeholder testing" });
    expect(w.approved).toEqual([]);
    const h = harness([approve]);
    const t = await h.turn("approve 5101", async (call) => (await call("approve_gate", { ticket: "5101" }), "Card up."));
    expect(w.approved).toEqual([]);
    expect(await h.svc.confirm(t.steps[0].cardId!)).toMatchObject({ state: "done", result: "Approved #5101. “Builder” was told to prepare the pull request to main." });
    expect(w.approved).toEqual(["5101"]);
    expect(approve.stillValid!({ ticket: "5101" })).toBe(false);
  });

  it("the wire service logged nothing going wrong", () => {
    const w = world();
    w.deps.addWire("a1", "a2", "handoff");
    expect(w.problems).toEqual([]);
  });
});
