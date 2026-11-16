import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { ASSISTANT_LIMITS, type AssistantRule, type RuleRun } from "../src/shared/assistant";
import { auditWords, type AuditEntry } from "../src/shared/team/audit";
import { RemoteAudit } from "../src/main/team/remoteAudit";
import { tempDir } from "./helpers";
import { CARD_SHOWN } from "../src/main/assistant/service";
import type { RulesStore } from "../src/main/assistant/rules";
import { fakeTool, harness } from "./assistantHarness";

describe("Assistant tiers, held by main", () => {
  it("a confirm tool's call runs nothing: it puts up a card, and only Do it runs it", async () => {
    const restart = fakeTool({ name: "restart_it", tier: "confirm", card: (a) => ({ title: `Restart ${a.session}`, detail: "Stops it and starts it again", warnings: ["It's working"] }) });
    const h = harness([restart]);
    let answer: unknown;
    const t = await h.turn("restart api", async (call) => {
      answer = await call("restart_it", { session: "api" });
      return "Put up a card to restart api.";
    });
    expect(answer).toEqual({ result: CARD_SHOWN });
    expect(restart.runs).toEqual([]);
    const step = t.steps[0];
    expect(step).toMatchObject({ tool: "restart_it", tier: "confirm", state: "proposed" });
    const card = await h.card(step.cardId!);
    expect(card).toMatchObject({ title: "Restart api", detail: "Stops it and starts it again", warnings: ["It's working"], state: "open", blocked: null, turnId: t.id });
    expect(h.audit).toEqual([]);

    const done = await h.svc.confirm(card.id);
    expect(done).toMatchObject({ state: "done", result: "restart_it ran" });
    expect(restart.runs).toEqual([{ session: "api" }]);
    expect((await h.step(step.id)).state).toBe("done");
    expect(h.audit).toEqual([expect.objectContaining({ kind: "assistant.action", tool: "restart_it", source: "card", outcome: "restart_it api: done" })]);
    // settled: a second Do it runs nothing
    expect(await h.svc.confirm(card.id)).toEqual({ error: "That card is done already" });
    expect(restart.runs).toHaveLength(1);
  });

  it("Do it checks the guard again against the state then: a no keeps the card open, saying why, and runs nothing", async () => {
    let why: string | null = null;
    const restart = fakeTool({ name: "restart_it", tier: "confirm", check: () => why });
    const h = harness([restart]);
    const t = await h.turn("restart api", async (call) => (await call("restart_it", { session: "api" }), "Card up."));
    const id = t.steps[0].cardId!;
    why = "A teammate continues it now";
    expect(await h.svc.confirm(id)).toMatchObject({ state: "open", blocked: "A teammate continues it now" });
    expect(restart.runs).toEqual([]);
    expect(h.audit).toEqual([]);
    why = null;
    expect(await h.svc.confirm(id)).toMatchObject({ state: "done", blocked: null });
    expect(restart.runs).toHaveLength(1);
  });

  it("a card its guard refuses when it's made still runs nothing, and says why on the card and to the model", async () => {
    const restart = fakeTool({ name: "restart_it", tier: "confirm", check: () => "It's being resumed" });
    const h = harness([restart]);
    let answer: any;
    const t = await h.turn("restart api", async (call) => ((answer = await call("restart_it", { session: "api" })), "Can't now."));
    expect(answer.result).toContain("It's being resumed");
    expect(answer.result).toContain("Don't propose it again");
    expect(await h.card(t.steps[0].cardId!)).toMatchObject({ state: "open", blocked: "It's being resumed" });
    expect(restart.runs).toEqual([]);
  });

  it("cards expire after cardMs, and as soon as their target changes; an expired card can't be confirmed", async () => {
    let valid = true;
    const a = fakeTool({ name: "restart_a", tier: "confirm" });
    const b = fakeTool({ name: "restart_b", tier: "confirm", stillValid: () => valid });
    const h = harness([a, b]);
    const t = await h.turn("restart both", async (call) => (await call("restart_a", { session: "a" }), await call("restart_b", { session: "b" }), "Two cards."));
    const [ca, cb] = t.steps.map((s) => s.cardId!);

    valid = false;
    h.svc.stateChanged();
    expect(await h.card(cb)).toMatchObject({ state: "expired", result: expect.stringContaining("changed") });
    expect(await h.card(ca)).toMatchObject({ state: "open" });

    h.tick(ASSISTANT_LIMITS.cardMs);
    expect(await h.svc.confirm(ca)).toMatchObject({ state: "expired", result: expect.stringContaining("30 minutes") });
    expect(await h.svc.confirm(cb)).toMatchObject({ state: "expired" });
    expect(a.runs).toEqual([]);
    expect(b.runs).toEqual([]);
  });

  it("Cancel settles a card: nothing runs, then or after", async () => {
    const restart = fakeTool({ name: "restart_it", tier: "confirm" });
    const h = harness([restart]);
    const t = await h.turn("restart api", async (call) => (await call("restart_it", { session: "api" }), "Card up."));
    const id = t.steps[0].cardId!;
    expect(h.svc.cancel(id)).toMatchObject({ state: "cancelled" });
    expect(await h.svc.confirm(id)).toEqual({ error: "That card is cancelled already" });
    expect(h.svc.cancel("nope")).toEqual({ error: expect.stringContaining("No such card") });
    expect(await h.svc.confirm(42)).toEqual({ error: expect.stringContaining("No such card") });
    expect(restart.runs).toEqual([]);
  });

  it("a read runs and keeps nothing: no Undo, nothing in the activity log", async () => {
    const list = fakeTool({ name: "list_it", tier: "read", run: () => ({ text: '{"sessions":[]}' }) });
    const h = harness([list]);
    let answer: unknown;
    const t = await h.turn("what's running?", async (call) => ((answer = await call("list_it")), "Nothing."));
    expect(answer).toEqual({ result: '{"sessions":[]}' });
    expect(t.steps[0]).toMatchObject({ state: "done", tier: "read" });
    expect(t.steps[0].undoUntil).toBeUndefined();
    expect(h.audit).toEqual([]);
  });

  it("bad arguments fail the step, naming what's wrong, and nothing runs", async () => {
    const tool = fakeTool({ name: "rename_it", tier: "direct", inputSchema: { type: "object", properties: { session: { type: "string" }, title: { type: "string", maxLength: 5 } }, required: ["session", "title"], additionalProperties: false } });
    const h = harness([tool]);
    const answers: unknown[] = [];
    const t = await h.turn("rename", async (call) => {
      answers.push(await call("rename_it", { session: "a" }));
      answers.push(await call("rename_it", { session: "a", title: "far too long" }));
      answers.push(await call("rename_it", { session: "a", title: "ok", force: true }));
      return "Couldn't.";
    });
    expect(answers).toEqual([
      { error: "The call's arguments.title is required" },
      { error: "The call's arguments.title must be at most 5 characters" },
      { error: "The call's arguments.force isn't an argument this tool takes" },
    ]);
    expect(t.steps.map((s) => s.state)).toEqual(["failed", "failed", "failed"]);
    expect(tool.runs).toEqual([]);
  });

  it("a direct step its guard refuses fails with why, unrun and unrecorded; one that throws is recorded as failed", async () => {
    const refused = fakeTool({ name: "move_it", tier: "direct", check: () => "That group is locked" });
    const broken = fakeTool({ name: "mute_it", tier: "direct", target: (a) => ({ session: String(a.session), title: "API" }), run: () => { throw new Error("the store is read-only"); } });
    const h = harness([refused, broken]);
    const answers: unknown[] = [];
    const t = await h.turn("move and mute", async (call) => (answers.push(await call("move_it", { session: "a" })), answers.push(await call("mute_it", { session: "a" })), "Neither worked."));
    expect(answers).toEqual([{ error: "That group is locked" }, { error: "the store is read-only" }]);
    expect(t.steps.map((s) => [s.state, s.error])).toEqual([
      ["failed", "That group is locked"],
      ["failed", "the store is read-only"],
    ]);
    expect(refused.runs).toEqual([]);
    expect(h.audit).toEqual([expect.objectContaining({ kind: "assistant.action", tool: "mute_it", source: "step", session: "a", title: "API", outcome: "mute_it a: failed: the store is read-only" })]);
    expect(h.log.some((l) => l.includes("running mute_it") && l.includes("read-only"))).toBe(true);
  });

  it("an Assistant turn's calls stop with its turn, and a name outside the registry is refused", async () => {
    const tool = fakeTool({ name: "focus_it", tier: "direct" });
    const h = harness([tool]);
    let identity = "";
    let unknown: unknown;
    await h.turn("focus", async (call, r) => ((identity = r.identity), (unknown = await call("send_message", { to: "x", message: "hi" })), "Done."));
    expect(unknown).toEqual({ error: "\"send_message\" isn't one of the Assistant's tools." });
    expect(await h.svc.mcpCall(identity, "focus_it", { session: "a" })).toEqual({ error: expect.stringContaining("turn has ended") });
    expect(h.svc.mcpList(identity)).toEqual({ error: expect.stringContaining("turn has ended") });
    expect(tool.runs).toEqual([]);
  });
});

describe("Assistant Undo", () => {
  /** A rename-like direct tool over one value, with an Undo while the value is still what it set. */
  function renamer() {
    const state = { title: "api" };
    const undone: string[] = [];
    const tool = fakeTool({
      name: "rename_it",
      tier: "direct",
      inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
      target: () => ({ session: "s1", title: state.title }),
      run: (a) => {
        const before = state.title;
        const title = String(a.title);
        state.title = title;
        return {
          text: `Renamed to ${title}`,
          stillUndoable: () => state.title === title,
          undo: () => {
            state.title = before;
            undone.push(before);
            return `Renamed back to ${before}`;
          },
        };
      },
    });
    return { state, undone, tool };
  }

  it("a direct step runs at once and offers Undo for undoMs; Undo puts it back once, and is recorded", async () => {
    const r = renamer();
    const h = harness([r.tool]);
    const t = await h.turn("rename to web", async (call) => (await call("rename_it", { title: "web" }), "Renamed."));
    const step = t.steps[0];
    expect(r.state.title).toBe("web");
    expect(step.undoUntil).toBe(1_000_000 + ASSISTANT_LIMITS.undoMs);
    expect(h.audit).toEqual([expect.objectContaining({ kind: "assistant.action", tool: "rename_it", source: "step", session: "s1", outcome: "rename_it: done" })]);

    expect(await h.svc.undo(step.id)).toMatchObject({ id: step.id, state: "undone" });
    expect(r.state.title).toBe("api");
    expect((await h.step(step.id)).undoUntil).toBeUndefined();
    expect(h.audit[1]).toMatchObject({ kind: "assistant.action", tool: "rename_it", source: "undo", outcome: "Undid rename_it: Renamed back to api" });
    expect(await h.svc.undo(step.id)).toEqual({ error: expect.stringContaining("has no Undo") });
    expect(r.undone).toEqual(["api"]);
  });

  it("Undo lapses after undoMs", async () => {
    const r = renamer();
    const h = harness([r.tool]);
    const t = await h.turn("rename to web", async (call) => (await call("rename_it", { title: "web" }), "Renamed."));
    h.tick(ASSISTANT_LIMITS.undoMs - 1);
    expect((await h.step(t.steps[0].id)).undoUntil).toBeDefined();
    h.tick(1);
    expect((await h.step(t.steps[0].id)).undoUntil).toBeUndefined();
    expect(await h.svc.undo(t.steps[0].id)).toEqual({ error: expect.stringContaining("has no Undo") });
    expect(r.state.title).toBe("web");
  });

  it("Undo lapses as soon as what it changed has changed again (stillUndoable)", async () => {
    const r = renamer();
    const h = harness([r.tool]);
    const t = await h.turn("rename to web", async (call) => (await call("rename_it", { title: "web" }), "Renamed."));
    r.state.title = "the user's own";
    // asked before any sweep: refused, saying why, and the Undo is gone from the step
    expect(await h.svc.undo(t.steps[0].id)).toEqual({ error: expect.stringContaining("changed again") });
    expect((await h.step(t.steps[0].id)).undoUntil).toBeUndefined();
    expect(r.state.title).toBe("the user's own");
    expect(r.undone).toEqual([]);
  });

  it("an Undo that fails says so, and is recorded as failed", async () => {
    const tool = fakeTool({ name: "mute_it", tier: "direct", run: () => ({ text: "Muted", undo: () => { throw new Error("the session closed"); } }) });
    const h = harness([tool]);
    const t = await h.turn("mute", async (call) => (await call("mute_it", { session: "a" }), "Muted."));
    expect(await h.svc.undo(t.steps[0].id)).toEqual({ error: "It couldn't be undone: the session closed" });
    expect(h.audit.at(-1)).toMatchObject({ source: "undo", outcome: "Undo of mute_it a failed: the session closed" });
  });
});

describe("Assistant actions in the activity log", () => {
  it("are written by the remote audit log as assistant.action, with tool, target, outcome and source, and read in plain words", async () => {
    const file = path.join(tempDir("audit"), "audit.log");
    const log = new RemoteAudit({ file, log: () => {} });
    const rename = fakeTool({ name: "rename_it", tier: "direct", target: (a) => ({ session: String(a.session), title: "API fix" }), run: () => ({ text: "Renamed", undo: () => "Renamed back" }) });
    const restart = fakeTool({ name: "restart_it", tier: "confirm", target: (a) => ({ session: String(a.session), title: "API fix" }) });
    const h = harness([rename, restart], { audit: log });
    const t =await h.turn("rename and restart", async (call) => (await call("rename_it", { session: "a1" }), await call("restart_it", { session: "a1" }), "Done."));
    await h.svc.undo(t.steps[0].id);
    await h.svc.confirm(t.steps[1].cardId!);
    const entries = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as AuditEntry);
    expect(entries.map((e) => [e.kind, e.tool, e.source, e.session, e.title, e.outcome])).toEqual([
      ["assistant.action", "rename_it", "step", "a1", "API fix", "rename_it a1: done"],
      ["assistant.action", "rename_it", "undo", "a1", "API fix", "Undid rename_it a1: Renamed back"],
      ["assistant.action", "restart_it", "card", "a1", "API fix", "restart_it a1: done"],
    ]);
    expect(entries.map(auditWords)).toEqual(["Assistant (asked): rename_it a1: done", "Assistant (Undo): Undid rename_it a1: Renamed back", "Assistant (you confirmed): restart_it a1: done"]);
  });
});

describe("Assistant standing rules, before they're built", () => {
  it("turning a rule on or off, or removing one, answers that there's no such rule", async () => {
    const h = harness([]);
    expect(h.svc.ruleOn("r1", true)).toEqual({ error: "No such rule" });
    expect(h.svc.ruleRemove("r1")).toEqual({ error: "No such rule" });
    expect(h.svc.ruleOn("r1", "yes")).toEqual({ error: "A rule is turned on or off" });
    expect((await h.svc.view()).rules).toEqual([]);
  });

  it("a rules store's rules are the view's; a rule's action runs only a rule tool, checked, and is recorded as the rule's", async () => {
    const rule: AssistantRule = { id: "r1", label: "When tests finishes, focus review", trigger: { kind: "finished", target: { session: "s1" } }, actions: [], on: false, createdAt: 1 };
    const runs: RuleRun[] = [];
    const store: RulesStore = { list: () => [rule], runs: () => runs, setOn: (id, on) => (id === "r1" ? ((rule.on = on), rule) : null), remove: (id) => id === "r1" };
    const ruleTool = fakeTool({ name: "focus_it", tier: "direct", rule: true });
    const plain = fakeTool({ name: "allow_it", tier: "confirm" });
    const h = harness([ruleTool, plain], { rules: store });
    expect((await h.svc.view()).rules).toEqual([rule]);
    expect(h.svc.ruleOn("r1", true)).toMatchObject({ on: true });
    expect(h.svc.ruleRemove("r1")).toEqual({ ok: true });

    expect(await h.svc.runAction({ tool: "allow_it", args: { session: "s1" }, label: "Allow it" })).toMatchObject({ ok: false, text: "allow_it can't be a standing rule's action" });
    expect(plain.runs).toEqual([]);
    expect(await h.svc.runAction({ tool: "focus_it", args: { session: "s1", extra: 1 }, label: "Focus" })).toMatchObject({ ok: false });
    const ran = await h.svc.runAction({ tool: "focus_it", args: { session: "s1" }, label: "Focus review" });
    expect(ran).toMatchObject({ ok: true, text: "focus_it ran", step: { state: "done", label: "Focus review" } });
    expect(h.audit).toEqual([expect.objectContaining({ tool: "focus_it", source: "rule", outcome: "focus_it s1: done" })]);
  });
});
