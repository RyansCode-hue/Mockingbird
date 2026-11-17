import { describe, expect, it } from "vitest";
import type { PrPreflight } from "../src/shared/types";
import type { TicketSessionPlan } from "../src/shared/team/ticketSession";
import { HELPDESK_CONVERSATION_WHY } from "../src/main/helpdesk";
import { ruleTools } from "../src/main/assistant/tools/rules";
import { CHANGED_SINCE_CARD, sessionRef } from "../src/main/assistant/tools/lookup";
import { harness, rulesFor } from "./assistantHarness";
import { cleanTree, fakeMac, helpdesk, info, PERMISSION } from "./assistantWorkFakes";

/**
 * What a card shows of what it will do (docs/assistant.md → Tiers): the text it types or publishes whole, the sessions
 * it names by id, the wider permission modes and command-like text it warns of, a standing rule's every action as main
 * spells it out, and a Do it that plans again refusing what differs from the card.
 */

const LONG_TEXT = `!${"fix the org dropdown, then run the tests. ".repeat(100)}`.slice(0, 4_000);
const LONG_PROMPT = `/${"read the ticket, plan the change, write the code and its tests. ".repeat(130)}`.slice(0, 8_000);

/** A Mac whose Assistant has the real tools and standing rules, their actions run through its service. */
function macWithRules() {
  const mac = fakeMac();
  const world = { sessions: () => mac.deps.sessions(), groups: () => mac.deps.groups(), rooms: () => mac.deps.rooms() };
  const r = rulesFor(world);
  mac.deps.rules = r.engine;
  const tools = [...mac.registry.list().filter((t) => !["propose_rule", "change_rule", "turn_rule_on", "turn_rule_off", "remove_rule", "list_rules"].includes(t.name)), ...ruleTools({ rules: r.engine })];
  const h = harness(tools, { world, rules: r.engine, ruleOnly: r.engine.ruleOnly });
  r.engine.attach(h.svc);
  return { mac, ...r, h };
}

describe("a card names a session by its title, id and group or folder", () => {
  it("sessionRef: “title” · id · group, the folder when it's in none, a closed one's record, and the id alone when nothing else is known", () => {
    const mac = fakeMac();
    mac.own.push(info("s5", { title: "api-fix" }), info("s6", { title: "loose", taskGroup: null, cwd: "/w/atticus-loose" }));
    mac.closed.push(info("c1", { title: "old", ticketTitle: "Old ticket", taskGroup: "5101/api" }));
    expect(sessionRef(mac.deps, "s5")).toBe("“api-fix” · s5 · atticus");
    expect(sessionRef(mac.deps, "s6")).toBe("“loose” · s6 · atticus-loose");
    expect(sessionRef(mac.deps, "c1")).toBe("“Old ticket” · c1 · 5101/api");
    expect(sessionRef(mac.deps, "nope")).toBe("nope");
  });

  it("two sessions with one title are told apart on every card that names them", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "api" }), info("a2", { title: "api", taskGroup: "5101" }));
    mac.trees.set("/w/a1", cleanTree({ branch: "fix" }));
    expect((await mac.tool("restart_session").card!({ session: "a1" })).title).toBe("Restart “api” · a1 · atticus");
    expect((await mac.tool("close_session").card!({ session: "a2" })).title).toBe("Close “api” · a2 · 5101");
    expect((await mac.tool("send_to_session").card!({ session: "a2", text: "hi" })).title).toBe("Send “api” · a2 · 5101 a message");
    expect((await mac.tool("handoff_session").card!({ session: "a1" })).title).toBe("Hand “api” · a1 · atticus off to a fresh Claude session");
    expect((await mac.tool("review_branch").card!({ session: "a2" })).title).toBe("Have Codex review the branch of “api” · a2 · 5101");
    expect((await mac.tool("push_branch").card!({ session: "a1" })).title).toBe("Push fix from “api” · a1 · atticus");
    const start = await mac.tool("start_session").card!({ agent: "claude", inFolderOf: "a1" });
    expect(start.title).toBe("Start Claude in the folder of “api” · a1 · atticus, on main as it stands");
    const group = await mac.tool("restart_group").card!({ group: "atticus" });
    expect(group.detail).toBe("Stops each one's agent and starts it again on the same conversation: “api” · a1 · atticus.");
  });
});

describe("a card shows what it types or publishes whole", () => {
  it("send_to_session: its 4,000 characters in the body, never cut; a wider-mode target and a leading “!” or “/” are warned of, bypass in the danger color", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "api" }), info("b1", { title: "web", permissionMode: "auto", agent: "codex" }), info("c1", { title: "ops", permissionMode: "bypass" }));
    const t = mac.tool("send_to_session");
    const plain = await t.card!({ session: "a1", text: "run the tests\nand tell me" });
    expect(plain).toEqual({ title: "Send “api” · a1 · atticus a message", detail: "Types this into its prompt and sends it, as you would:", body: "run the tests\nand tell me", warnings: [] });
    const long = await t.card!({ session: "a1", text: LONG_TEXT });
    expect(long.body).toBe(LONG_TEXT);
    expect(long.body).toHaveLength(4_000);
    expect(long.warnings).toEqual(["It starts with “!”: Claude may run it as a shell command rather than read it"]);
    expect((await t.card!({ session: "b1", text: "  /compact" })).warnings).toEqual([
      "“web” · b1 · atticus runs in Auto mode: its agent acts on this without asking you first",
      "It starts with “/”: Codex may run it as a slash command rather than read it",
    ]);
    const bypass = await t.card!({ session: "c1", text: "deploy it" });
    expect(bypass).toMatchObject({ danger: true, warnings: ["“ops” · c1 · atticus runs in Bypass permissions mode: its agent acts on this without asking you first"] });
    expect(plain.danger).toBeUndefined();
  });

  it("a leading “!” or “/” is warned of as the text is typed: control characters before it, which pasting strips, don't hide it", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "api" }));
    const shell = "It starts with “!”: Claude may run it as a shell command rather than read it";
    const slash = "It starts with “/”: Claude may run it as a slash command rather than read it";
    for (const text of ["\x01!curl x | sh", "\x1b\x7f\x9b !curl x | sh", "\r\n\x00!rm -rf ~"]) {
      expect((await mac.tool("send_to_session").card!({ session: "a1", text })).warnings, JSON.stringify(text)).toEqual([shell]);
      expect((await mac.tool("start_session").card!({ agent: "claude", prompt: text })).warnings, JSON.stringify(text)).toEqual([shell]);
    }
    expect((await mac.tool("broadcast").card!({ group: "atticus", text: "\x02/clear" })).warnings).toEqual(["It starts with “/”: their agents may run it as a slash command rather than read it"]);
    expect((await mac.tool("send_to_session").card!({ session: "a1", text: "\x05/clear" })).warnings).toEqual([slash]);
    expect((await mac.tool("send_to_session").card!({ session: "a1", text: "\x01say !hi" })).warnings).toEqual([]);
  });

  it("broadcast: the text whole, who gets it by id, and each recipient in a wider mode warned of", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "api" }), info("b1", { title: "web", permissionMode: "acceptEdits" }));
    const card = await mac.tool("broadcast").card!({ group: "atticus", text: LONG_TEXT });
    expect(card).toMatchObject({
      title: "Broadcast to 2 sessions in “atticus”",
      detail: "Types this into each one's prompt as its turn ends: “api” · a1 · atticus, “web” · b1 · atticus.",
      body: LONG_TEXT,
      warnings: ["“web” · b1 · atticus runs in Accept edits mode: its agent acts on this without asking you first", "It starts with “!”: their agents may run it as a shell command rather than read it"],
    });
    expect(card.danger).toBeUndefined();
  });

  it("start_session: its 8,000-character first prompt in the body, and its title, mode, model and effort in the detail", async () => {
    const mac = fakeMac();
    const card = await mac.tool("start_session").card!({ agent: "codex", repo: "atticus", group: "atticus", title: "Login", permissionMode: "plan", model: "gpt-5.1-codex", effort: "high", prompt: LONG_PROMPT });
    expect(card).toEqual({
      title: "Start Codex in atticus's checkout as it is",
      detail: "Starts a new Codex session in atticus's checkout as it is, in “atticus”, titled “Login”, in Plan mode, on gpt-5.1-codex, at high effort. Its first prompt, below, is sent once it's up.",
      body: LONG_PROMPT,
      warnings: ["It starts with “/”: Codex may run it as a slash command rather than read it"],
    });
    expect(card.body).toHaveLength(8_000);
  });

  it("open_pr: the description it publishes, whole, in the body", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "Filter orgs", ticketId: "5038", ticketTitle: "Filter orgs", branch: "5038-filter-orgs" }));
    mac.deps.prPreflight = async () => preflight();
    const description = `## Summary\n${"Filters the org list by state. ".repeat(140)}`.slice(0, 4_000);
    const a = { session: "a1", title: "Filter orgs by state", description };
    const t = mac.tool("open_pr");
    expect(await t.check!(a)).toBeNull();
    const card = await t.card!(a);
    expect(card.body).toBe(description);
    expect(card.detail).toMatch(/Its description, below, is published with it\.$/);
    expect(card.warnings).toEqual(["3 commits go in it"]);
  });
});

describe("answer_prompt's card shows what the prompt asks", () => {
  async function card(mac: ReturnType<typeof fakeMac>, session: string) {
    const h = harness(mac.registry.list(), { world: mac.deps });
    const t = await h.turn("allow it", async (call) => (await call("answer_prompt", { session, answer: "allow" }), "Card up."));
    return h.card(t.steps[0].cardId!);
  }

  it("its pane's last lines as they're displayed, the terminal's escapes taken out", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "api", status: "waiting", waitingReason: PERMISSION, waitingSince: 1_000 }));
    mac.deps.output = (id) => {
      mac.did.push(`output ${id}`);
      return "\x1b[2J\x1b[1m Bash command\x1b[0m\r\n\r\n   rm -rf build && npm test\r\n\r\n Do you want to proceed?\r\n \x1b[36m❯ 1. Yes\x1b[0m\r\n   2. No\r\n";
    };
    const c = await card(mac, "a1");
    expect(c).toMatchObject({
      title: "Allow the prompt of “api” · a1 · atticus, once",
      detail: `Answers yes to “${PERMISSION}”, this once: not “always allow”. Its next prompt asks again. Its pane shows now:`,
      body: " Bash command\n\n   rm -rf build && npm test\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No",
      warnings: [],
    });
    expect(mac.did).toEqual(["output a1"]);
  });

  it("says plainly when its pane can't be read, and to answer it there: never the Helpdesk workspace's", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "api", status: "waiting", waitingReason: PERMISSION, waitingSince: 1_000 }), helpdesk("h1", { status: "waiting", waitingReason: PERMISSION, waitingSince: 1_000 }));
    mac.deps.output = () => {
      throw new Error("the pane is gone");
    };
    const broken = await card(mac, "a1");
    expect(broken.body).toBeUndefined();
    expect(broken.warnings).toEqual(["What its pane shows couldn't be read (the pane is gone): answer it in its pane, where you can see what it asks"]);
    mac.deps.output = (id) => {
      mac.did.push(`output ${id}`);
      return "secret helpdesk words";
    };
    const hd = await card(mac, "h1");
    expect(hd.body).toBeUndefined();
    expect(hd.warnings).toEqual([`What its pane shows can't be read here (${HELPDESK_CONVERSATION_WHY}): answer it in its pane, where you can see what it asks`]);
    expect(mac.did).toEqual([]);
  });
});

describe("a standing rule's card and the Rules list show every action as main spells it out", () => {
  it("each action's full text, prompt, mode, model and group, and the sessions it names by id; the sheet's Rules list the same", async () => {
    const t = macWithRules();
    t.mac.own.push(info("s1", { title: "tests" }), info("a1", { title: "api", agent: "codex" }));
    const actions = [
      { tool: "send_to_session", args: { session: "a1", text: LONG_TEXT } },
      { tool: "start_session", args: { agent: "claude", repo: "atticus", group: "atticus", permissionMode: "plan", model: "opus", prompt: LONG_PROMPT } },
      { tool: "notify", args: { text: "Done" } },
    ];
    const turn = await t.h.turn("when tests finishes, tell api and start a planner", async (call) => (await call("propose_rule", { label: "When tests finishes, carry on", trigger: { kind: "finished", target: { session: "s1" } }, actions }), "Card up."));
    const card = await t.h.card(turn.steps[0].cardId!);
    expect(card).toMatchObject({
      title: "Make the rule “When tests finishes, carry on”",
      detail: "When “tests” · s1 · atticus finishes a turn, it does these 3, in order:",
      blocked: null,
      actions: [
        { line: "Type this into the prompt of “api” · a1 · atticus and send it", body: LONG_TEXT, warnings: ["It starts with “!”: Codex may run it as a shell command rather than read it"] },
        { line: "Start a new Claude session in atticus's checkout as it is, in “atticus”, in Plan mode, on opus, with this first prompt", body: LONG_PROMPT, warnings: ["It starts with “/”: Claude may run it as a slash command rather than read it"] },
        { line: "Notify me: “Done”", warnings: [] },
      ],
    });
    expect(card.actions![0].body).toHaveLength(4_000);
    expect(card.actions![1].body).toHaveLength(8_000);
    expect(await t.h.svc.confirm(card.id)).toMatchObject({ state: "done" });

    // the sheet's Rules list: main's account of each action, not only the model's label
    const [rule] = (await t.h.svc.view()).rules;
    expect(rule.actions.map((a) => a.detail)).toEqual(card.actions);
    // never saved: the file keeps the call, and main spells it out again each time
    expect(t.book.list()[0].actions.map((a) => a.detail)).toEqual([undefined, undefined, undefined]);
  });

  it("refuses a permission mode wider than the default in any action, the card showing it with its warning, bypass in the danger color", async () => {
    const t = macWithRules();
    t.mac.own.push(info("s1", { title: "tests" }));
    const card = async (action: { tool: string; args: Record<string, unknown> }) => {
      const turn = await t.h.turn("make a rule", async (call) => (await call("propose_rule", { label: "When tests finishes, go", trigger: { kind: "finished", target: { session: "s1" } }, actions: [action] }), "Card up."));
      return t.h.card(turn.steps[0].cardId!);
    };
    const wider = /^Its action 1 \("(start_session|restart_session)"\): A standing rule can't do this \(restarting or starting a session in a permission mode wider than the default/;
    const auto = await card({ tool: "start_session", args: { agent: "claude", permissionMode: "auto", prompt: "go" } });
    expect(auto.blocked).toMatch(wider);
    expect(auto.actions![0]).toMatchObject({ line: expect.stringContaining("in Auto"), warnings: [expect.stringMatching(/^Auto: /)] });
    expect(auto.danger).toBeUndefined();
    const edits = await card({ tool: "restart_session", args: { session: "s1", permissionMode: "acceptEdits" } });
    expect(edits.blocked).toMatch(wider);
    expect(edits.actions![0]).toMatchObject({ line: "Restart “tests” · s1 · atticus in Accept edits", warnings: ["Accept edits: it changes files without asking you first"] });
    const bypass = await card({ tool: "start_session", args: { agent: "claude", permissionMode: "bypass" } });
    expect(bypass).toMatchObject({ danger: true, blocked: expect.stringMatching(wider) });
    for (const c of [auto, edits, bypass]) expect(await t.h.svc.confirm(c.id)).toMatchObject({ state: "open", blocked: expect.stringMatching(wider) });
    // plan and the default are a rule's to give
    expect((await card({ tool: "restart_session", args: { session: "s1", permissionMode: "plan" } })).blocked).toBeNull();
    expect(t.engine.list()).toEqual([]);
  });

  it("at run time types nothing into a session in a wider mode, and leaves it out of a broadcast, saying why", async () => {
    const t = macWithRules();
    const api = info("a1", { title: "api" });
    t.mac.own.push(info("s1", { title: "tests", taskGroup: "ci" }), api, info("b1", { title: "web" }));
    t.engine.add({ label: "Tell api", trigger: { kind: "finished", target: { session: "s1" } }, actions: [{ tool: "send_to_session", args: { session: "a1", text: "carry on" } }] });
    t.engine.add({ label: "Tell everyone", trigger: { kind: "finished", target: { session: "s1" } }, actions: [{ tool: "broadcast", args: { group: "atticus", text: "carry on" } }] });
    // made while api asked as usual; it's in Auto mode by the time the rules run
    api.permissionMode = "auto";
    const view = await t.h.svc.view();
    expect(view.rules[0].actions[0].detail!.warnings).toEqual(["“api” · a1 · atticus runs in Auto mode now: the rule types nothing into it while it does"]);
    t.engine.finished("s1", 1);
    await t.engine.settled();
    const [tell, everyone] = t.engine.runs();
    expect(tell).toMatchObject({ ok: false, text: expect.stringContaining("“api” · a1 · atticus runs in Auto mode: a standing rule types nothing into a session that acts without asking you") });
    expect(everyone).toMatchObject({ ok: true, text: expect.stringContaining("Left out “api” (“api” · a1 · atticus runs in Auto mode") });
    expect(t.mac.did).toEqual(["broadcast b1 carry on"]);
    // a card's Do it is the user's: it types into api, having warned of its mode
    const turn = await t.h.turn("tell api", async (call) => (await call("send_to_session", { session: "a1", text: "carry on" }), "Card up."));
    const card = await t.h.card(turn.steps[0].cardId!);
    expect(card.warnings).toContain("“api” · a1 · atticus runs in Auto mode: its agent acts on this without asking you first");
    expect(await t.h.svc.confirm(card.id)).toMatchObject({ state: "done" });
    expect(t.mac.did).toEqual(["broadcast b1 carry on", "broadcast a1 carry on"]);
  });
});

describe("a Do it that plans again refuses what differs from its card", () => {
  it("open_pr: more commits, another branch or base since the card, and a card that showed no plan, run nothing", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "Filter orgs", ticketId: "5038", ticketTitle: "Filter orgs", branch: "5038-filter-orgs" }));
    let pre = preflight();
    mac.deps.prPreflight = async () => pre;
    const h = harness(mac.registry.list(), { world: mac.deps });
    const propose = async () => {
      const t = await h.turn("open the PR", async (call) => (await call("open_pr", { session: "a1", title: "Filter orgs by state" }), "Card up."));
      return h.card(t.steps[0].cardId!);
    };
    const c1 = await propose();
    pre = preflight({ commits: 4 });
    expect(await h.svc.confirm(c1.id)).toMatchObject({ state: "open", blocked: CHANGED_SINCE_CARD });
    const c2 = await propose();
    pre = preflight({ commits: 4, base: "main" });
    expect(await h.svc.confirm(c2.id)).toMatchObject({ state: "open", blocked: CHANGED_SINCE_CARD });
    // a card made while it couldn't be planned showed nothing to open
    pre = preflight({ commits: 0 });
    const c3 = await propose();
    expect(c3.blocked).toBe("5038-filter-orgs has no commits that aren't on dev");
    pre = preflight();
    expect(await h.svc.confirm(c3.id)).toMatchObject({ state: "open", blocked: CHANGED_SINCE_CARD });
    expect(mac.did).toEqual([]);
    // unchanged since the card: it opens
    const c4 = await propose();
    expect(await h.svc.confirm(c4.id)).toMatchObject({ state: "done" });
    expect(mac.did).toEqual(["openPr a1 5038"]);
  });

  it("start_from_ticket: a ticket claimed, a branch or a clone changed since the card, runs nothing", async () => {
    const mac = fakeMac();
    mac.rooms.push({ id: "R1", name: "Atticus team", groupKey: "atticus", members: [{ name: "Ryan", self: true }], online: [] });
    let p = plan();
    mac.deps.ticketPlan = async () => p;
    const started: unknown[] = [];
    mac.deps.startTicket = async (roomId, req) => (started.push([roomId, req]), { session: info("n1"), claimed: true, branch: p.branch, message: "Started" });
    const h = harness(mac.registry.list(), { world: mac.deps });
    const propose = async () => {
      const t = await h.turn("start #12", async (call) => (await call("start_from_ticket", { room: "Atticus team", ticket: 12 }), "Card up."));
      return h.card(t.steps[0].cardId!);
    };
    const c1 = await propose();
    p = plan({ branch: "feature/12-other" });
    expect(await h.svc.confirm(c1.id)).toMatchObject({ state: "open", blocked: CHANGED_SINCE_CARD });
    const c2 = await propose();
    p = plan({ branch: "feature/12-other", holder: { state: "yours" } });
    expect(await h.svc.confirm(c2.id)).toMatchObject({ state: "open", blocked: CHANGED_SINCE_CARD });
    const c3 = await propose();
    p = plan({ branch: "feature/12-other", holder: { state: "yours" }, repos: [{ path: "/code/atticus", name: "atticus", base: "main" }] });
    expect(await h.svc.confirm(c3.id)).toMatchObject({ state: "open", blocked: CHANGED_SINCE_CARD });
    expect(started).toEqual([]);
    const c4 = await propose();
    expect(await h.svc.confirm(c4.id)).toMatchObject({ state: "done" });
    expect(started).toEqual([["R1", { n: 12, agent: "claude", repoPath: "/code/atticus" }]]);
  });
});

const preflight = (over: Partial<PrPreflight> = {}): PrPreflight => ({
  branch: "5038-filter-orgs",
  base: "dev",
  bases: ["dev"],
  dirtyFiles: 0,
  commits: 3,
  remote: { provider: "ado", repo: "Atticus/atticus" },
  docs: null,
  existing: null,
  branchProblem: null,
  ...over,
});

const plan = (over: Partial<TicketSessionPlan> = {}): TicketSessionPlan => ({
  roomId: "R1",
  room: "Atticus team",
  group: "atticus",
  project: "atticus",
  n: 12,
  title: "Export API",
  holder: { state: "free" },
  branch: "feature/12-export-api",
  branchFrom: "new",
  repos: [{ path: "/code/atticus", name: "atticus", base: "dev" }],
  repoNote: null,
  ...over,
});
