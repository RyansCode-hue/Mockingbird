import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { ASSISTANT_LIMITS, assistantModelOf, type AssistantModel } from "../src/shared/assistant";
import { QUIT_CARD_RAN, QUIT_EXPIRED, QUIT_STOPPED, ThreadFile, parseThread, revive, threadText } from "../src/main/assistant/thread";
import { fakeTool, harness } from "./assistantHarness";
import { tempDir } from "./helpers";

/** The thread's file in this test file's HOME, and what ThreadFile logged. */
function threadOn(file = path.join(tempDir("thread"), "assistant-turns.json"), o: { maxBytes?: number } = {}) {
  const log: string[] = [];
  const make = () => new ThreadFile({ file, log: (c, e) => void log.push(`${c}: ${e instanceof Error ? e.message : String(e)}`), now: () => 1_700_000_000_000, maxBytes: o.maxBytes });
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  return { file, log, make, read };
}

/** A promise and the means to settle it. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

const pause = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("the Assistant's thread across quits", () => {
  it("is saved whole as it changes, atomically and owner-only, keeping the last 20 turns", async () => {
    const t = threadOn();
    const h = harness([], { thread: t.make() });
    const first = await h.turn("what's waiting on me?", async () => "Nothing is.");
    expect(t.read()).toMatchObject({ version: 1, turns: [{ id: first.id, text: "what's waiting on me?", state: "done", reply: "Nothing is." }], cards: [] });
    expect(fs.statSync(t.file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(t.file))).toEqual(["assistant-turns.json"]);
    for (let i = 0; i < ASSISTANT_LIMITS.turnsKept + 3; i++) await h.turn(`question ${i}`, async () => `answer ${i}`);
    const saved = t.read();
    expect(saved.turns).toHaveLength(ASSISTANT_LIMITS.turnsKept);
    expect(saved.turns.at(-1)).toMatchObject({ text: `question ${ASSISTANT_LIMITS.turnsKept + 2}`, reply: `answer ${ASSISTANT_LIMITS.turnsKept + 2}` });
    expect(t.log).toEqual([]);
  });

  it("loads at start-up, and what a quit cut short loads stopped: a running or queued turn, a running step", async () => {
    const t = threadOn();
    const gate = deferred<string>();
    const before = harness([fakeTool({ name: "look", tier: "read", run: () => new Promise(() => {}) })], { thread: t.make() });
    const done = await before.turn("first", async () => "One.");
    before.setModel(async (call) => {
      void call("look", { session: "s1" });
      return gate.promise;
    });
    const running = await before.svc.ask("second");
    const queued = await before.svc.ask("third");
    if ("error" in running || "error" in queued) throw new Error("asking failed");
    await pause();
    expect(t.read().turns.map((x: { state: string }) => x.state)).toEqual(["done", "thinking", "queued"]);

    // Mockingbird quits here, and starts again over the same file
    const after = harness([], { thread: t.make() });
    const v = await after.svc.view();
    expect(v.turns.map((x) => [x.id, x.text, x.state, x.reply])).toEqual([
      [done.id, "first", "done", "One."],
      [running.turnId, "second", "error", QUIT_STOPPED],
      [queued.turnId, "third", "error", QUIT_STOPPED],
    ]);
    expect(v.turns[1].steps).toEqual([expect.objectContaining({ label: "look s1", state: "failed", error: QUIT_STOPPED })]);
    expect(v.busy).toBe(false);
    expect(v.threadProblem).toBeUndefined();
    // saved as it loaded: stopped
    expect(t.read().turns.map((x: { state: string }) => x.state)).toEqual(["done", "error", "error"]);
    // and the thread goes on from there: the next turn's prompt carries the earlier ones
    await after.turn("fourth", async () => "Four.");
    expect(after.spawned[0].prompt).toContain("User: first\nAssistant: One.");
    expect(after.spawned[0].prompt).toContain(`User: second\nAssistant (the turn failed): ${QUIT_STOPPED}`);
    gate.resolve("late");
  });

  it("loads a card left waiting on Do it as expired, which Do it can't run, and offers no Undo", async () => {
    const t = threadOn();
    const restart = fakeTool({ name: "restart", tier: "confirm" });
    const rename = fakeTool({ name: "rename", tier: "direct", run: () => ({ text: "renamed", undo: () => "put back" }) });
    const cancelled = fakeTool({ name: "close", tier: "confirm" });
    const before = harness([restart, rename, cancelled], { thread: t.make() });
    const turn = await before.turn("restart s1, close s2 and rename s3", async (call) => {
      await call("restart", { session: "s1" });
      await call("close", { session: "s2" });
      await call("rename", { session: "s3" });
      return "Put two up for you.";
    });
    const [restartStep, closeStep, renameStep] = turn.steps;
    expect(renameStep.undoUntil).toBeGreaterThan(0);
    before.svc.cancel(closeStep.cardId);

    const after = harness([restart, rename, cancelled], { thread: t.make() });
    const v = await after.svc.view();
    const card = (id?: string) => v.cards.find((c) => c.id === id);
    expect(card(restartStep.cardId)).toMatchObject({ state: "expired", result: QUIT_EXPIRED, blocked: null });
    expect(card(closeStep.cardId)).toMatchObject({ state: "cancelled" });
    expect(v.turns[0].steps.find((s) => s.id === renameStep.id)).toMatchObject({ state: "done" });
    expect(v.turns[0].steps.find((s) => s.id === renameStep.id)?.undoUntil).toBeUndefined();
    expect(await after.svc.confirm(restartStep.cardId)).toMatchObject({ state: "expired" });
    expect(after.svc.cancel(restartStep.cardId)).toEqual({ error: "That card is expired already" });
    expect(await after.svc.undo(renameStep.id)).toEqual({ error: expect.stringMatching(/has no Undo/) });
    expect(restart.runs).toEqual([]);
  });

  it("clears the file with Clear: finished turns and settled cards go, an open card stays", async () => {
    const t = threadOn();
    const tool = fakeTool({ name: "restart", tier: "confirm" });
    const h = harness([tool], { thread: t.make() });
    const a = await h.turn("restart s1", async (call) => (await call("restart", { session: "s1" }), "Up for you."));
    const b = await h.turn("restart s2", async (call) => (await call("restart", { session: "s2" }), "Up for you."));
    h.svc.cancel(a.steps[0].cardId);
    h.svc.clear();
    const saved = t.read();
    expect(saved.turns).toEqual([]);
    expect(saved.cards.map((c: { id: string; state: string }) => [c.id, c.state])).toEqual([[b.steps[0].cardId, "open"]]);
    // nothing more from before comes back after a quit
    const after = harness([tool], { thread: t.make() });
    const v = await after.svc.view();
    expect(v.turns).toEqual([]);
    expect(v.cards.map((c) => [c.id, c.state])).toEqual([[b.steps[0].cardId, "expired"]]);
  });

  it("keeps, on Clear, a turn still running and the cards it put up, settled or not", async () => {
    const t = threadOn();
    const tool = fakeTool({ name: "restart", tier: "confirm" });
    const gate = deferred<string>();
    const h = harness([tool], { thread: t.make() });
    await h.turn("done already", async () => "Done.");
    h.setModel(async (call) => {
      await call("restart", { session: "s1" });
      return gate.promise;
    });
    const running = await h.svc.ask("still running");
    if ("error" in running) throw new Error(running.error);
    await pause();
    const cardId = (await h.svc.view()).cards[0].id;
    h.svc.cancel(cardId);
    h.svc.clear();
    const v = await h.svc.view();
    expect(v.turns.map((x) => [x.text, x.state])).toEqual([["still running", "thinking"]]);
    expect(v.cards.map((c) => [c.id, c.state])).toEqual([[cardId, "cancelled"]]);
    expect(t.read().cards.map((c: { id: string }) => c.id)).toEqual([cardId]);
    gate.resolve("Put it up.");
    await h.finished(running.turnId);
  });

  it("moves a file it can't read aside, logs it, says so in the tab until Clear, and starts empty", async () => {
    for (const [text, why] of [
      ["{ not json", /isn't valid JSON/],
      [JSON.stringify({ version: 1, turns: [{ id: "t-1", at: 1, text: "hi", state: "pondering", steps: [] }], cards: [] }), /turn t-1 has no state/],
      [JSON.stringify({ version: 1, turns: "none", cards: [] }), /doesn't hold a thread/],
      [JSON.stringify({ version: 9, turns: [], cards: [] }), /a newer Mockingbird wrote it \(version 9\)/],
    ] as const) {
      const t = threadOn();
      fs.writeFileSync(t.file, text);
      const h = harness([], { thread: t.make() });
      const v = await h.svc.view();
      expect(v.turns).toEqual([]);
      expect(v.threadProblem).toMatch(why);
      expect(v.threadProblem).toMatch(/It's kept as .*assistant-turns\.json\.corrupt-1700000000000\.$/);
      expect(fs.readFileSync(`${t.file}.corrupt-1700000000000`, "utf8")).toBe(text);
      expect(t.log).toEqual([expect.stringMatching(why)]);
      // a fresh thread is saved in its place, and Clear says no more about the old one
      expect(t.read()).toEqual({ version: 1, turns: [], cards: [] });
      await h.turn("hello", async () => "Hi.");
      expect(t.read().turns).toHaveLength(1);
      h.svc.clear();
      expect((await h.svc.view()).threadProblem).toBeUndefined();
    }
  });

  it("names a save that failed in the tab, logs it once, and clears that once a save works", async () => {
    const dir = tempDir("thread-ro");
    const t = threadOn(path.join(dir, "assistant-turns.json"));
    const h = harness([], { thread: t.make() });
    // the folder can't be written to: the atomic write's temporary file can't be made
    fs.chmodSync(dir, 0o500);
    try {
      await h.turn("one", async () => "1");
      await h.turn("two", async () => "2");
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    const v = await h.svc.view();
    expect(v.turns).toHaveLength(2);
    expect(v.threadProblem).toMatch(/^The thread couldn't be saved to .*thread-ro-\w+\/assistant-turns\.json \(.*EACCES.*\): what's new in it holds only until Mockingbird quits\.$/);
    expect(t.log).toHaveLength(1);
    expect(t.read().turns).toEqual([]);
    await h.turn("three", async () => "3");
    expect((await h.svc.view()).threadProblem).toBeUndefined();
    expect(t.read().turns).toHaveLength(3);
  });

  it("caps the file: past it the oldest turns, then settled cards, are left out, and that's logged once", async () => {
    const t = threadOn(undefined, { maxBytes: 2_000 });
    const h = harness([], { thread: t.make() });
    for (let i = 0; i < 6; i++) await h.turn(`question ${i} ${"x".repeat(300)}`, async () => `answer ${i}`);
    const saved = t.read();
    expect(fs.statSync(t.file).size).toBeLessThanOrEqual(2_000);
    expect(saved.turns.length).toBeLessThan(6);
    expect(saved.turns.at(-1).reply).toBe("answer 5");
    // the view keeps every turn: only the file leaves the oldest out
    expect((await h.svc.view()).turns).toHaveLength(6);
    expect(t.log.length).toBeGreaterThanOrEqual(1);
    expect(t.log[0]).toMatch(/over 2 KB: its oldest \d+ turns and 0 cards aren't saved/);
    // past it, cards go oldest settled first: an open one stays while a settled one can go
    const cards = [card("c1", "open"), card("c2", "done"), card("c3", "expired")];
    const fits = Buffer.byteLength(threadText({ turns: [], cards: [cards[0], cards[2]] }).text);
    const left = threadText({ turns: [], cards }, fits);
    expect(JSON.parse(left.text).cards.map((c: { id: string }) => c.id)).toEqual(["c1", "c3"]);
    expect(left.left).toEqual({ turns: 0, cards: 1 });
  });

  it("reads back only a thread's shape: fields it doesn't know are dropped, and a running card loads failed with its step", () => {
    const parsed = parseThread({
      version: 1,
      turns: [{ id: "t-1", at: 5, text: "go", state: "done", reply: "ok", extra: "x", steps: [{ id: "st-1", tool: "restart", tier: "confirm", label: "Restart", state: "proposed", cardId: "c-1", undoUntil: 9, more: 1 }, { id: "st-2", tool: "close", tier: "confirm", label: "Close s2", state: "proposed", cardId: "c-gone" }] }],
      cards: [{ ...card("c-1", "running"), turnId: "t-1", junk: true }],
    });
    if (typeof parsed === "string") throw new Error(parsed);
    expect(parsed.turns[0]).not.toHaveProperty("extra");
    expect(parsed.cards[0]).not.toHaveProperty("junk");
    const r = revive(parsed);
    expect(r.cards[0]).toMatchObject({ id: "c-1", state: "failed", result: QUIT_CARD_RAN });
    expect(r.turns[0].steps[0]).toEqual({ id: "st-1", tool: "restart", tier: "confirm", label: "Restart", state: "failed", error: QUIT_CARD_RAN, cardId: "c-1" });
    // a step left proposed whose card wasn't kept gets an expired one in its place
    expect(r.cards[1]).toMatchObject({ id: "c-gone", turnId: "t-1", title: "Close s2", state: "expired", result: QUIT_EXPIRED });
  });
});

describe("the Assistant's model (Settings → Assistant)", () => {
  it("runs each turn on the model settings name as it starts, Sonnet unless told otherwise, and shows it in the view", async () => {
    let model: AssistantModel = "opus";
    const h = harness([], { model: () => model });
    expect((await h.svc.view()).model).toBe("opus");
    await h.turn("one", async () => "1");
    model = "sonnet";
    const before = h.emits();
    h.svc.modelChanged();
    expect(h.emits()).toBe(before + 1);
    expect((await h.svc.view()).model).toBe("sonnet");
    await h.turn("two", async () => "2");
    expect(h.spawned.map((r) => r.model)).toEqual(["opus", "sonnet"]);

    expect([assistantModelOf({}), assistantModelOf({ assistantModel: "opus" }), assistantModelOf({ assistantModel: "gpt-9" })]).toEqual(["sonnet", "opus", "sonnet"]);
    const plain = harness([]);
    expect((await plain.svc.view()).model).toBe("sonnet");
    await plain.turn("three", async () => "3");
    expect(plain.spawned[0].model).toBe("sonnet");
  });
});

function card(id: string, state: "open" | "running" | "done" | "failed" | "cancelled" | "expired") {
  return { id, turnId: "t-x", tool: "restart", title: `Card ${id}`, detail: "d".repeat(40), warnings: [], blocked: null, state, expiresAt: 10 };
}
