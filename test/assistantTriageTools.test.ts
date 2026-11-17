import { describe, expect, it } from "vitest";
import { HELPDESK_CONVERSATION_WHY } from "../src/main/helpdesk";
import { PROMPT_CHANGED } from "../src/main/sessionGuards";
import { AT_PERMISSION_PROMPT } from "../src/main/assistant/tools/triage";
import { harness } from "./assistantHarness";
import { fakeMac, helpdesk, info, PERMISSION, teammate } from "./assistantWorkFakes";

const waiting = (id: string, over: Parameters<typeof info>[1] = {}) => info(id, { status: "waiting", waitingReason: PERMISSION, waitingSince: 1_000, waitingAt: 1_000, ...over });

describe("needs_you", () => {
  it("lists who's waiting (why, since when, a prompt or a question; teammates' marked), whose turn finished, and who's gone quiet", async () => {
    const mac = fakeMac();
    mac.own.push(
      waiting("a1", { title: "api", waitingSince: Date.UTC(2026, 10, 16, 12) }),
      info("q1", { title: "asks", status: "waiting", waitingReason: "Claude is waiting for your input", waitingSince: Date.UTC(2026, 10, 16, 11) }),
      info("f1", { title: "done", finishedAt: Date.UTC(2026, 10, 16, 13) }),
      info("s1", { title: "stuck", status: "working", stalledSince: Date.UTC(2026, 10, 16, 14), hooksSilent: true })
    );
    mac.remote.push(teammate("r~nick~n1", { status: "waiting", waitingReason: PERMISSION, waitingSince: Date.UTC(2026, 10, 16, 10) }));
    const out = JSON.parse((await mac.tool("needs_you").run({})).text);
    expect(out).toEqual({
      waiting: [
        { id: "r~nick~n1", title: "Nick's api", kind: "permission", reason: PERMISSION, since: "2026-11-16T10:00:00.000Z", mine: false, owner: "Nick" },
        { id: "q1", title: "asks", kind: "question", reason: "Claude is waiting for your input", since: "2026-11-16T11:00:00.000Z" },
        { id: "a1", title: "api", kind: "permission", reason: PERMISSION, since: "2026-11-16T12:00:00.000Z" },
      ],
      finished: [{ id: "f1", title: "done", at: "2026-11-16T13:00:00.000Z" }],
      stuck: [{ id: "s1", title: "stuck", quietSince: "2026-11-16T14:00:00.000Z", hooksSilent: true }],
    });
  });
});

describe("answer_prompt", () => {
  /** The Assistant over the fake Mac, and a turn that asks to answer `session`'s prompt `answer`: its card. */
  async function proposed(mac: ReturnType<typeof fakeMac>, session: string, answer: "allow" | "deny") {
    const h = harness(mac.registry.list(), { world: mac.deps });
    const t = await h.turn("allow it", async (call) => (await call("answer_prompt", { session, answer }), "Card up."));
    expect(t.steps[0]).toMatchObject({ tool: "answer_prompt", state: "proposed" });
    return { h, card: await h.card(t.steps[0].cardId!) };
  }

  it("allows the prompt it was shown once, with Claude's one-time key, on Do it", async () => {
    const mac = fakeMac();
    mac.own.push(waiting("a1", { title: "api" }));
    const { h, card } = await proposed(mac, "a1", "allow");
    expect(card).toMatchObject({ title: "Allow the prompt of “api” · a1 · atticus, once", detail: expect.stringMatching(new RegExp(`^Answers yes to “${PERMISSION}”, this once: not “always allow”\\. Its next prompt asks again\\.`)), blocked: null });
    expect(mac.typed).toEqual([]);
    expect(await h.svc.confirm(card.id)).toMatchObject({ state: "done", result: "Answered “api”'s prompt: allow once." });
    expect(mac.typed).toEqual([["a1", "1"]]);
  });

  it("expires once the prompt it was about isn't the one showing (answered, or another came), and types nothing", async () => {
    const mac = fakeMac();
    const a1 = waiting("a1");
    mac.own.push(a1);
    const { h, card } = await proposed(mac, "a1", "allow");
    // a second prompt, worded alike
    a1.waitingAt = 2_000;
    expect(await h.svc.confirm(card.id)).toMatchObject({ state: "expired", result: "Expired: what it was about has changed since" });
    expect(mac.typed).toEqual([]);

    // answered in its pane since: it's working again
    const b1 = waiting("b1", { agent: "codex" });
    mac.own.push(b1);
    const second = await proposed(mac, "b1", "deny");
    b1.status = "working";
    expect((await second.h.svc.view()).cards.find((c) => c.id === second.card.id)?.state).toBe("expired");
    expect(await second.h.svc.confirm(second.card.id)).toMatchObject({ state: "expired" });
    expect(mac.typed).toEqual([]);
  });

  it("types nothing when the guards find the prompt changed at the last moment", () => {
    const mac = fakeMac();
    const a1 = waiting("a1");
    mac.own.push(a1);
    const t = mac.tool("answer_prompt");
    const args = { session: "a1", answer: "deny" };
    void t.card!(args);
    a1.waitingReason = "Claude needs your permission to use Write";
    expect(() => t.run(args)).toThrow(PROMPT_CHANGED);
    expect(mac.typed).toEqual([]);
  });

  it("refuses the Helpdesk workspace, a teammate's, a copy a teammate took over, a question and one not waiting", async () => {
    const mac = fakeMac();
    mac.own.push(waiting("h1", { role: "tasks", taskGroup: "Helpdesk", repoPath: null }), waiting("k1"), info("q1", { status: "waiting", waitingReason: "Claude is waiting for your input" }), info("i1"));
    mac.remote.push(teammate("r~nick~n1", { status: "waiting", waitingReason: PERMISSION }));
    mac.taken.add("k1");
    const t = mac.tool("answer_prompt");
    expect(await t.check!({ session: "h1", answer: "allow" })).toBe(HELPDESK_CONVERSATION_WHY);
    expect(await t.check!({ session: "r~nick~n1", answer: "allow" })).toBe("“Nick's api” is Nick's session: only its owner can answer its prompt");
    expect(await t.check!({ session: "k1", answer: "allow" })).toBe("“k1” continues on Nick's laptop — take it back rather than typing into this copy");
    expect(await t.check!({ session: "q1", answer: "allow" })).toBe("It's asking a question, not for permission: answer it in its pane");
    expect(await t.check!({ session: "i1", answer: "allow" })).toBe("It isn't waiting on a prompt");
    // a card the guards refuse runs nothing, even when Do it is pressed
    const { h, card } = await proposed(mac, "h1", "allow");
    expect(card.blocked).toBe(HELPDESK_CONVERSATION_WHY);
    await h.svc.confirm(card.id);
    expect(mac.typed).toEqual([]);
  });
});

describe("send_to_session", () => {
  it("types the text in as the broadcast box does: sent at a prompt, queued mid-turn, the card showing the text and the wait", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "api" }), info("w1", { title: "busy", status: "working" }));
    const t = mac.tool("send_to_session");
    expect(await t.check!({ session: "a1", text: "run the tests" })).toBeNull();
    expect(await t.card!({ session: "w1", text: "run the tests" })).toEqual({
      title: "Send “busy” · w1 · atticus a message",
      detail: "Types this into its prompt and sends it, as you would:",
      body: "run the tests",
      warnings: ["It's mid-turn: the message goes in when the turn ends"],
    });
    expect((await t.run({ session: "a1", text: "run the tests" })).text).toBe("Sent to “api”.");
    expect((await t.run({ session: "w1", text: "run the tests" })).text).toBe("Queued for “busy”: it goes in when its turn ends.");
    expect(mac.did).toEqual(["broadcast a1 run the tests", "broadcast w1 run the tests"]);
  });

  it("refuses a session at a permission prompt, whose prompt what's typed could answer, on the card and again at Do it", async () => {
    const mac = fakeMac();
    const a1 = info("a1", { title: "api" });
    mac.own.push(waiting("w1"), info("q1", { status: "waiting", waitingReason: "Claude is waiting for your input" }), a1);
    const t = mac.tool("send_to_session");
    expect(await t.check!({ session: "w1", text: "1" })).toBe(AT_PERMISSION_PROMPT);
    // a question isn't a permission prompt: the message waits for it to be answered
    expect(await t.check!({ session: "q1", text: "hi" })).toBeNull();
    expect((await t.card!({ session: "q1", text: "hi" })).warnings).toEqual(["It's asking you a question: the message goes in once that's answered"]);

    const h = harness(mac.registry.list(), { world: mac.deps });
    const turn = await h.turn("tell api yes", async (call) => (await call("send_to_session", { session: "a1", text: "y" }), "Card up."));
    const card = await h.card(turn.steps[0].cardId!);
    expect(card.blocked).toBeNull();
    Object.assign(a1, { status: "waiting", waitingReason: PERMISSION, waitingSince: 5, waitingAt: 5 });
    expect(await h.svc.confirm(card.id)).toMatchObject({ state: "open", blocked: AT_PERMISSION_PROMPT });
    expect(mac.did).toEqual([]);
    expect(mac.typed).toEqual([]);
  });

  it("goes by the mode its agent reports when that's wider than its launch's: the card warns of it, a standing rule types nothing into it", async () => {
    const mac = fakeMac();
    // launched asking as usual; switched to bypass in its pane (Shift+Tab), as its hooks say
    const a1 = info("a1", { title: "api", liveMode: "bypass" });
    mac.own.push(a1);
    const t = mac.tool("send_to_session");
    const card = await t.card!({ session: "a1", text: "run the tests" });
    expect(card).toMatchObject({ danger: true, warnings: ["“api” · a1 · atticus runs in Bypass permissions mode: its agent acts on this without asking you first"] });
    expect(await t.check!({ session: "a1", text: "run the tests" }, { rule: true })).toBe(
      "“api” · a1 · atticus runs in Bypass permissions mode: a standing rule types nothing into a session that acts without asking you"
    );
    // reported narrower than its launch: the launch's mode still holds
    Object.assign(a1, { permissionMode: "acceptEdits", liveMode: "default" });
    expect((await t.card!({ session: "a1", text: "hi" })).warnings).toEqual(["“api” · a1 · atticus runs in Accept edits mode: its agent acts on this without asking you first"]);
    Object.assign(a1, { permissionMode: undefined, liveMode: null });
    expect(await t.check!({ session: "a1", text: "hi" }, { rule: true })).toBeNull();
  });

  it("refuses the Helpdesk workspace, a teammate's, a taken-over copy, an exited pane and a terminal", async () => {
    const mac = fakeMac();
    mac.own.push(helpdesk(), info("k1"), info("d1", { status: "dead" }), info("t1", { shell: true }));
    mac.remote.push(teammate());
    mac.taken.add("k1");
    const t = mac.tool("send_to_session");
    const check = (session: string) => t.check!({ session, text: "hi" });
    expect(await check("h1")).toBe(HELPDESK_CONVERSATION_WHY);
    expect(await check("r~nick~n1")).toBe("“Nick's api” is Nick's session: only its owner can type into it");
    expect(await check("k1")).toBe("“k1” continues on Nick's laptop — take it back rather than typing into this copy");
    expect(await check("d1")).toBe("It isn't running");
    expect(await check("t1")).toBe("It's a terminal: what's typed into it runs as commands");
    expect(mac.did).toEqual([]);
  });
});

describe("broadcast", () => {
  it("reaches the group's agent sessions, leaving out (and saying so) the Helpdesk workspace and a taken-over copy", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "api" }), info("a2", { title: "web", status: "working", taskGroup: "atticus/ui" }), helpdesk("h1", { taskGroup: "atticus" }), info("k1", { title: "copy" }), info("t1", { shell: true }));
    mac.remote.push(teammate("r~nick~n1", { taskGroup: "atticus" }));
    mac.taken.add("k1");
    const t = mac.tool("broadcast");
    const a = { group: "atticus", text: "status?" };
    expect(await t.check!(a)).toBeNull();
    expect(await t.card!(a)).toEqual({
      title: "Broadcast to 2 sessions in “atticus”",
      detail: "Types this into each one's prompt as its turn ends: “api” · a1 · atticus, “web” · a2 · atticus/ui.",
      body: "status?",
      warnings: [`“Helpdesk tasks” · h1 · atticus is left out: ${HELPDESK_CONVERSATION_WHY}`, "“copy” · k1 · atticus is left out: “k1” continues on Nick's laptop — take it back rather than sending this copy a broadcast"],
    });
    expect((await t.run(a)).text).toBe("Sent to “api”. Queued for “web”.");
    expect(mac.did).toEqual(["broadcast a1 status?", "broadcast a2 status?"]);
    // a session joining since makes it another card
    mac.own.push(info("a3"));
    expect(t.stillValid!(a)).toBe(false);
  });

  it("skips a session at a permission prompt, on the card and again at Do it", async () => {
    const mac = fakeMac();
    const a2 = info("a2", { title: "web" });
    mac.own.push(info("a1", { title: "api" }), a2, waiting("w1", { title: "asking" }));
    const t = mac.tool("broadcast");
    const a = { group: "atticus", text: "1" };
    expect(await t.card!(a)).toMatchObject({ title: "Broadcast to 2 sessions in “atticus”", warnings: [`“asking” · w1 · atticus is left out: ${AT_PERMISSION_PROMPT}`] });
    // reached a prompt after the card was made: left out of the run all the same
    Object.assign(a2, { status: "waiting", waitingReason: PERMISSION, waitingSince: 5, waitingAt: 5 });
    expect((await t.run(a)).text).toBe("Sent to “api”.");
    expect(mac.did).toEqual(["broadcast a1 1"]);
  });

  it("refuses a group none of whose sessions can take it", async () => {
    const mac = fakeMac();
    mac.own.push(helpdesk("h1", { taskGroup: "atticus" }));
    expect(await mac.tool("broadcast").check!({ group: "atticus", text: "hi" })).toBe(`No session in “atticus” can take it: “Helpdesk tasks” · h1 · atticus: ${HELPDESK_CONVERSATION_WHY}`);
  });
});

describe("recent_activity", () => {
  it("says what finished (what its agent said, its last turn's files), came up and exited, never the Helpdesk workspace's words", async () => {
    const mac = fakeMac();
    const now = Date.now();
    mac.own.push(
      info("f1", { title: "done", finishedAt: now - 60_000 }),
      helpdesk("h1", { finishedAt: now - 60_000 }),
      info("old", { finishedAt: now - 5 * 60 * 60_000 }),
      waiting("w1", { title: "asks", waitingSince: now - 30_000 }),
      info("d1", { title: "gone", status: "dead", exitCode: 137 })
    );
    const read: string[] = [];
    mac.deps.lastReply = async (id) => (read.push(id), { line: "Fixed it. token=ghp_abcdefghijklmnopqrstuvwxyz0123456789", at: now });
    mac.deps.turnFiles = async (id, since) => (read.push(`${id} ${since}`), ["src/a.ts", "src/b.ts"]);
    const out = JSON.parse((await mac.tool("recent_activity").run({ since: 120 })).text);
    expect(out.finished).toEqual([
      { id: "f1", title: "done", at: new Date(now - 60_000).toISOString(), said: expect.stringMatching(/^Fixed it\. token=.*redacted/), lastTurnFiles: { count: 2, some: ["src/a.ts", "src/b.ts"] } },
      { id: "h1", title: "Helpdesk tasks", at: new Date(now - 60_000).toISOString() },
    ]);
    expect(JSON.stringify(out)).not.toContain("ghp_");
    expect(read).toEqual(["f1", "f1 last"]);
    expect(out.waiting).toEqual([{ id: "w1", title: "asks", reason: PERMISSION, since: new Date(now - 30_000).toISOString() }]);
    expect(out.exited).toEqual([{ id: "d1", title: "gone", exitCode: 137 }]);
  });
});
