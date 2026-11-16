import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, onTestFinished } from "vitest";
import { ASSISTANT_LIMITS, type AssistantRule, type RuleTrigger } from "../src/shared/assistant";
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/types";
import type { AssistantGroup, AssistantSession } from "../src/main/assistant/deps";
import type { AssistantTool } from "../src/main/assistant/registry";
import { DAILY_WINDOW_MS, GONE_MS, dailySlot, targetMatches, type RuleLimits } from "../src/main/assistant/ruleEngine";
import { RuleBook, ruleDenied, type RuleDraft } from "../src/main/assistant/rules";
import { CARD_SHOWN } from "../src/main/assistant/service";
import { ruleTools } from "../src/main/assistant/tools/rules";
import { SendError, type AlertSender } from "../src/main/phone/sender";
import { tempDir } from "./helpers";
import { fakeTool, harness, rulesFor } from "./assistantHarness";

const sess = (id: string, over: Partial<AssistantSession> = {}): AssistantSession => ({
  id,
  title: id,
  agent: "claude",
  status: "idle",
  waitingReason: null,
  waitingSince: null,
  group: null,
  room: null,
  repo: "repo",
  branch: "main",
  model: null,
  permissionMode: "default",
  mine: true,
  helpdesk: false,
  ...over,
});

const group = (key: string, stacks: string[] = []): AssistantGroup => ({ key, stacks, sessions: 1, room: null, area: true });

/** A rule-able tool over one session, as layout's focus is. */
const focusTool = () => fakeTool({ name: "focus_it", tier: "direct", rule: true, label: (a) => `Focus ${String(a.session)}` });

/**
 * Standing rules over `sessions` and `groups`, their actions run by the Assistant service, whose registry holds the
 * rule tools and `tools`.
 */
function setup(o: { sessions?: AssistantSession[]; groups?: AssistantGroup[]; tools?: AssistantTool[]; settings?: () => Settings; sender?: AlertSender | null; kept?: (id: string) => boolean; limits?: Partial<RuleLimits>; file?: string } = {}) {
  const sessions = o.sessions ?? [];
  const groups = o.groups ?? [];
  const world = { sessions: () => sessions, groups: () => groups, rooms: () => [] };
  const r = rulesFor(world, { settings: o.settings, sender: o.sender, kept: o.kept, limits: o.limits, file: o.file });
  const h = harness([...ruleTools({ rules: r.engine }), ...(o.tools ?? [])], { world, rules: r.engine, ruleOnly: r.engine.ruleOnly });
  r.engine.attach(h.svc);
  return { ...r, h, sessions, groups };
}

const finishedOf = (session: string): RuleTrigger => ({ kind: "finished", target: { session } });
const draft = (over: Partial<RuleDraft> = {}): RuleDraft => ({ label: "When tests finishes, focus review", trigger: finishedOf("s1"), actions: [{ tool: "focus_it", args: { session: "s2" } }], ...over });
const local = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => new Date(y, mo, d, h, mi, s).getTime();
// Monday 16 November 2026, local time
const MON = (h: number, mi: number, s = 0) => local(2026, 10, 16, h, mi, s);

describe("the rules file", () => {
  it("round-trips: what's saved is what the next start reads, written whole, readable only by the user", () => {
    const t = setup({ sessions: [sess("s1"), sess("s2")], tools: [focusTool()] });
    const a = t.engine.add(draft());
    const b = t.engine.add(draft({ label: "At nine on weekdays, tell me", trigger: { kind: "daily", at: "09:00", days: [1, 2, 3, 4, 5] }, actions: [{ tool: "notify", args: { text: "Standup" } }] }));
    t.engine.setOn(b.id, false);
    const again = new RuleBook({ file: t.file, log: () => {} });
    expect(again.list()).toEqual(t.engine.list());
    expect(again.list().map((r) => [r.id, r.on])).toEqual([
      [a.id, true],
      [b.id, false],
    ]);
    expect(again.problem()).toBeNull();
    expect(JSON.parse(fs.readFileSync(t.file, "utf8"))).toMatchObject({ version: 1, rules: [{ id: a.id }, { id: b.id }] });
    expect(fs.statSync(t.file).mode & 0o777).toBe(0o600);
  });

  it("a file that isn't JSON is kept aside, never overwritten, logged, and shown in the sheet", async () => {
    const file = path.join(tempDir("rules"), "assistant-rules.json");
    fs.writeFileSync(file, '{"version":1,"rules":[{"id":"r1"');
    const t = setup({ file, sessions: [sess("s1"), sess("s2")], tools: [focusTool()] });
    expect(t.engine.list()).toEqual([]);
    const aside = fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith("assistant-rules.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), aside[0]), "utf8")).toBe('{"version":1,"rules":[{"id":"r1"');
    const problem = t.engine.problem()!;
    expect(problem).toContain("isn't valid JSON");
    expect(problem).toContain(aside[0]);
    expect(problem).toContain("Mockingbird started with no rules");
    expect(t.log.some((l) => l.includes("assistant rules") && l.includes("isn't valid JSON"))).toBe(true);
    expect((await t.h.svc.view()).rulesProblem).toBe(problem);
    // a new rule is saved in a new file; the one kept aside is untouched
    t.engine.add(draft());
    expect(fs.readFileSync(path.join(path.dirname(file), aside[0]), "utf8")).toBe('{"version":1,"rules":[{"id":"r1"');
  });

  it("a rule that isn't one is left out; the rest are kept, and the file as it was is kept aside", () => {
    const file = path.join(tempDir("rules"), "assistant-rules.json");
    const good = { id: "r1", label: "When s1 finishes, tell me", trigger: finishedOf("s1"), actions: [{ tool: "notify", args: { text: "Done" }, label: "Notify me" }], on: true, createdAt: 5, paused: null, lastRun: null };
    const bad = { id: "r2", label: "Bad", trigger: { kind: "whenever" }, actions: [], on: true, createdAt: 5 };
    const raw = JSON.stringify({ version: 1, rules: [good, bad] });
    fs.writeFileSync(file, raw);
    const book = new RuleBook({ file, log: () => {} });
    expect(book.list()).toEqual([good]);
    expect(book.problem()).toMatch(/1 of its 2 rules couldn't be read \(rule r2's trigger\.kind must be one of/);
    expect(book.problem()).toContain("The 1 rule that could be read is kept");
    const aside = fs.readdirSync(path.dirname(file)).find((n) => n.includes(".corrupt-"))!;
    expect(fs.readFileSync(path.join(path.dirname(file), aside), "utf8")).toBe(raw);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).rules).toEqual([good]);
  });

  it("a file that can't be set aside leaves the rules unchangeable, so nothing can overwrite it", async () => {
    const dir = tempDir("rules");
    const file = path.join(dir, "assistant-rules.json");
    fs.writeFileSync(file, "not json");
    fs.chmodSync(dir, 0o500);
    onTestFinished(() => fs.chmodSync(dir, 0o700));
    const t = setup({ file, sessions: [sess("s1"), sess("s2")], tools: [focusTool()] });
    expect(t.engine.problem()).toMatch(/couldn't be moved aside either .*rules can't be changed until it's fixed or removed/);
    expect(() => t.engine.add(draft())).toThrow(/Rules can't be changed now/);
    fs.chmodSync(dir, 0o700);
    expect(fs.readFileSync(file, "utf8")).toBe("not json");
  });

  it("turning a paused rule on clears its pause, from the sheet; a rule that's gone, or a save that fails, says so", async () => {
    const t = setup({ sessions: [sess("s1"), sess("s2")], tools: [focusTool()] });
    const r = t.engine.add(draft());
    t.book.note(r.id, { paused: "3 runs failed in a row: Focus s2: it's gone" });
    expect(t.h.svc.ruleOn(r.id, true)).toMatchObject({ id: r.id, on: true, paused: null });
    expect(new RuleBook({ file: t.file, log: () => {} }).get(r.id)).toMatchObject({ on: true, paused: null });
    expect(t.h.svc.ruleOn("nope", true)).toEqual({ error: "No such rule" });
    fs.chmodSync(path.dirname(t.file), 0o500);
    onTestFinished(() => fs.chmodSync(path.dirname(t.file), 0o700));
    expect(t.h.svc.ruleOn(r.id, false)).toEqual({ error: expect.stringContaining("It couldn't be saved") });
    expect(t.engine.get(r.id)!.on).toBe(true);
    expect(t.h.svc.ruleRemove(r.id)).toEqual({ error: expect.stringContaining("It couldn't be saved") });
    expect(t.engine.get(r.id)).not.toBeNull();
  });
});

describe("rule triggers", () => {
  it("finished: a Stop of the session it watches runs it, once per event; another session's doesn't", async () => {
    const focus = focusTool();
    const t = setup({ sessions: [sess("s1", { title: "tests" }), sess("s2", { title: "review" })], tools: [focus] });
    const rule = t.engine.add(draft());
    t.engine.finished("s2", 5);
    await t.engine.settled();
    expect(focus.runs).toEqual([]);
    t.engine.finished("s1", 10);
    // the same Stop told twice is one event
    t.engine.finished("s1", 10);
    await t.engine.settled();
    expect(focus.runs).toEqual([{ session: "s2" }]);
    t.engine.finished("s1", 20);
    await t.engine.settled();
    expect(focus.runs).toHaveLength(2);
    expect(t.engine.runs().map((r) => [r.ruleId, r.ok, r.text])).toEqual([
      [rule.id, true, "focus_it ran · “tests” finished"],
      [rule.id, true, "focus_it ran · “tests” finished"],
    ]);
    expect(t.engine.get(rule.id)!.lastRun).toEqual({ at: t.now(), ok: true, text: "focus_it ran · “tests” finished" });
    expect((await t.h.svc.view()).runs).toHaveLength(2);
  });

  it("waiting N minutes: read from waitingSince on the tick, once per spell of waiting", async () => {
    const focus = focusTool();
    const s1 = sess("s1", { title: "api", group: "atticus/api" });
    const t = setup({ sessions: [s1, sess("s2")], groups: [group("atticus", ["atticus/api"])], tools: [focus] });
    t.engine.add(draft({ trigger: { kind: "waiting", target: { group: "atticus" }, minutes: 10 } }));
    Object.assign(s1, { status: "waiting", waitingSince: t.now(), waitingReason: "Claude needs your permission to use Bash" });
    t.tick(10 * 60_000 - 1);
    t.engine.tick();
    await t.engine.settled();
    expect(focus.runs).toEqual([]);
    t.tick(1);
    t.engine.tick();
    t.tick(30_000);
    t.engine.tick();
    await t.engine.settled();
    expect(focus.runs).toHaveLength(1);
    expect(t.engine.runs()[0].text).toBe("focus_it ran · “api” waited 10 minutes");
    // answered, then waiting again: a new spell
    Object.assign(s1, { status: "waiting", waitingSince: t.now() });
    t.tick(10 * 60_000);
    t.engine.tick();
    await t.engine.settled();
    expect(focus.runs).toHaveLength(2);
  });

  it("exited: a process's end runs it once, though it's told by its agent quitting and its pty's exit", async () => {
    const focus = focusTool();
    const t = setup({ sessions: [sess("s1", { title: "tests" }), sess("s2")], tools: [focus] });
    t.engine.add(draft({ trigger: { kind: "exited", target: { session: "s1" } } }));
    t.engine.finished("s1", 1);
    t.engine.exited("s1");
    t.engine.exited("s1");
    await t.engine.settled();
    expect(focus.runs).toHaveLength(1);
    expect(t.engine.runs()[0].text).toBe("focus_it ran · “tests” exited");
    t.tick(11_000);
    t.engine.exited("s1");
    await t.engine.settled();
    expect(focus.runs).toHaveLength(2);
  });

  it("daily HH:MM on chosen days: caught by the tick at its time, once; a time missed asleep, or before the rule was made, is skipped", async () => {
    const focus = focusTool();
    const t = setup({ sessions: [sess("s2")], tools: [focus] });
    t.setNow(MON(8, 0));
    t.engine.add(draft({ trigger: { kind: "daily", at: "09:00", days: [1, 2, 3, 4, 5] } }));
    const at = async (when: number) => {
      t.setNow(when);
      t.engine.tick();
      await t.engine.settled();
      return focus.runs.length;
    };
    expect(await at(MON(8, 59, 50))).toBe(0);
    expect(await at(MON(9, 0, 10))).toBe(1);
    expect(await at(MON(9, 0, 40))).toBe(1);
    expect(await at(MON(9, 1, 10))).toBe(1);
    expect(t.engine.runs()[0].text).toBe("focus_it ran · At 09:00");
    // Tuesday: on
    expect(await at(local(2026, 10, 17, 9, 0, 5))).toBe(2);
    // Wednesday, the Mac asleep until 9:05: skipped, not caught up
    expect(await at(local(2026, 10, 18, 9, 5))).toBe(2);
    expect(await at(local(2026, 10, 18, 9, 30))).toBe(2);
    // Saturday isn't one of its days
    expect(await at(local(2026, 10, 21, 9, 0, 5))).toBe(2);
    // a rule made at 9:00:20 doesn't catch 9:00 that day
    t.setNow(local(2026, 10, 23, 9, 0, 20));
    t.engine.add(draft({ label: "Late", trigger: { kind: "daily", at: "09:00" } }));
    expect(await at(local(2026, 10, 23, 9, 0, 40))).toBe(3);
    expect(t.engine.runs().map((r) => r.ruleId)).not.toContain(t.engine.list()[1].id);
  });

  it("nothing fires once it's stopped (quitting, before the panes' ptys end)", async () => {
    const focus = focusTool();
    const t = setup({ sessions: [sess("s1"), sess("s2")], tools: [focus] });
    t.engine.add(draft({ trigger: { kind: "exited", target: { any: true } } }));
    t.engine.stop();
    t.engine.exited("s1");
    t.engine.finished("s1", 1);
    t.engine.tick();
    await t.engine.settled();
    expect(focus.runs).toEqual([]);
    expect(t.engine.runs()).toEqual([]);
  });

  it("a daily time's window is two ticks long", () => {
    const t: Extract<RuleTrigger, { kind: "daily" }> = { kind: "daily", at: "09:00" };
    expect(dailySlot(t, MON(8, 59, 59))).toBeNull();
    expect(dailySlot(t, MON(9, 0))).toEqual({ at: MON(9, 0), day: "2026-11-16" });
    expect(dailySlot(t, MON(9, 0) + DAILY_WINDOW_MS - 1)).not.toBeNull();
    expect(dailySlot(t, MON(9, 0) + DAILY_WINDOW_MS)).toBeNull();
    expect(dailySlot({ ...t, days: [0, 6] }, MON(9, 0, 5))).toBeNull();
  });
});

describe("rule targets", () => {
  it("a session by id, a group with its stacks, or any session", () => {
    expect(targetMatches({ session: "s1" }, { id: "s1", group: null })).toBe(true);
    expect(targetMatches({ session: "s1" }, { id: "s10", group: null })).toBe(false);
    expect(targetMatches({ group: "5038" }, { id: "a", group: "5038" })).toBe(true);
    expect(targetMatches({ group: "5038" }, { id: "a", group: "5038/api" })).toBe(true);
    expect(targetMatches({ group: "5038" }, { id: "a", group: "50381" })).toBe(false);
    expect(targetMatches({ group: "5038/api" }, { id: "a", group: "5038" })).toBe(false);
    expect(targetMatches({ group: "5038" }, { id: "a", group: null })).toBe(false);
    expect(targetMatches({ any: true }, { id: "a", group: null })).toBe(true);
  });

  it("a group or any target watches only this Mac's sessions; a teammate's can't be a rule's", async () => {
    const focus = focusTool();
    const nick = sess("n1", { title: "nick's", group: "5101", mine: false, owner: "Nick" });
    const t = setup({ sessions: [sess("s1", { group: "5101/api" }), sess("s2"), nick], groups: [group("5101", ["5101/api"])], tools: [focus] });
    t.engine.add(draft({ trigger: { kind: "finished", target: { group: "5101" } } }));
    t.engine.add(draft({ label: "Any", trigger: { kind: "exited", target: { any: true } } }));
    t.engine.finished("n1", 1);
    t.engine.exited("n1");
    await t.engine.settled();
    expect(focus.runs).toEqual([]);
    t.engine.finished("s1", 2);
    t.engine.exited("s2");
    await t.engine.settled();
    expect(focus.runs).toHaveLength(2);
    expect(t.engine.refusal(draft({ trigger: finishedOf("n1") }))).toBe("“nick's” is Nick's session: a rule watches only this Mac's own");
  });
});

describe("what a rule may never do", () => {
  it("the deny list names each family, by tool and by arguments", () => {
    for (const name of ["answer_prompt", "allow_prompt", "deny_prompt", "cleanup_worktree", "remove_worktree", "push", "push_branch", "git_push", "open_pr", "create_pull_request", "leave_room", "take_over", "takeover"]) {
      expect(ruleDenied(name, {}), name).toMatch(/^A standing rule can't do this/);
    }
    expect(ruleDenied("relaunch_session", { session: "s1", mode: "bypass" })).toMatch(/bypass mode/);
    expect(ruleDenied("start_session", { permissionMode: "bypassPermissions" })).toMatch(/bypass mode/);
    expect(ruleDenied("close_session", { session: "s1", forget: true })).toMatch(/forget/);
    for (const [name, args] of [
      ["focus_session", { session: "s1" }],
      ["relaunch_session", { session: "s1", mode: "plan" }],
      ["close_session", { session: "s1", forget: false }],
      ["pr_status", {}],
      ["notify", { text: "push it, then open a PR" }],
    ] as const) {
      expect(ruleDenied(name, args), name).toBeNull();
    }
  });

  it("a tool marked rule: true that's on the deny list is never usable, never proposed and never run", async () => {
    const answer = fakeTool({ name: "answer_prompt", tier: "confirm", rule: true });
    const restart = fakeTool({ name: "relaunch_it", tier: "confirm", rule: true, inputSchema: { type: "object", properties: { session: { type: "string" }, mode: { type: "string" } }, additionalProperties: false } });
    const t = setup({ sessions: [sess("s1"), sess("s2")], tools: [answer, restart, focusTool()] });
    expect(t.engine.usable().map((u) => u.tool)).toEqual(["relaunch_it", "focus_it", "notify", "text_me"]);
    expect(t.engine.refusal(draft({ actions: [{ tool: "answer_prompt", args: { session: "s1" } }] }))).toBe(
      'Its action 1 ("answer_prompt"): A standing rule can\'t do this (answering prompts (that would be a standing yes to every prompt))'
    );
    expect(t.engine.refusal(draft({ actions: [{ tool: "relaunch_it", args: { session: "s1", mode: "bypass" } }] }))).toMatch(/bypass mode/);
    expect(t.engine.refusal(draft({ actions: [{ tool: "relaunch_it", args: { session: "s1", mode: "plan" } }] }))).toBeNull();

    // a rule that reached the file without a card (written by hand) is refused as it runs
    t.book.change((rules) =>
      rules.push({
        id: "r9",
        label: "Hand-written",
        trigger: finishedOf("s1"),
        actions: [
          { tool: "relaunch_it", args: { session: "s1", mode: "bypass" }, label: "Restart in bypass" },
          { tool: "answer_prompt", args: { session: "s1" }, label: "Allow it" },
        ],
        on: true,
        createdAt: 0,
      })
    );
    t.engine.finished("s1", 1);
    await t.engine.settled();
    expect(restart.runs).toEqual([]);
    expect(answer.runs).toEqual([]);
    expect(t.engine.runs()[0]).toMatchObject({ ok: false, text: expect.stringMatching(/^Restart in bypass: A standing rule can't do this \(restarting or starting a session in bypass mode\)/) });
    expect(t.engine.runs()[0].steps.map((s) => [s.state, s.error])).toEqual([
      ["failed", expect.stringContaining("bypass mode")],
      ["failed", "Not run: the action before it failed"],
    ]);
    // runAction refuses it whoever calls it
    expect(await t.h.svc.runAction({ tool: "answer_prompt", args: { session: "s1" }, label: "Allow" }, "r")).toMatchObject({ ok: false, text: expect.stringContaining("answering prompts") });
    expect(answer.runs).toEqual([]);
    expect(t.h.audit).toEqual([]);
  });
});

describe("rule limits", () => {
  it(`runs at most ${ASSISTANT_LIMITS.ruleRunsPerHour} times an hour: the next is noted once, not run, and it runs again an hour on`, async () => {
    const focus = focusTool();
    const t = setup({ sessions: [sess("s1"), sess("s2")], tools: [focus] });
    const rule = t.engine.add(draft());
    for (let i = 0; i < ASSISTANT_LIMITS.ruleRunsPerHour + 2; i++) {
      t.engine.finished("s1", i);
      await t.engine.settled();
      t.tick(60_000);
    }
    expect(focus.runs).toHaveLength(ASSISTANT_LIMITS.ruleRunsPerHour);
    const runs = t.engine.runs();
    expect(runs).toHaveLength(ASSISTANT_LIMITS.ruleRunsPerHour + 1);
    expect(runs.at(-1)).toMatchObject({ ok: false, text: "Not run · “s1” finished: it ran 6 times in the last hour, the most a rule may. It can run again in 54 minutes" });
    expect(t.engine.get(rule.id)!.paused).toBeNull();
    t.tick(60 * 60_000);
    t.engine.finished("s1", 100);
    await t.engine.settled();
    expect(focus.runs).toHaveLength(ASSISTANT_LIMITS.ruleRunsPerHour + 1);
  });

  it(`pauses after ${ASSISTANT_LIMITS.ruleFailuresToPause} failed runs in a row, saying why; turning it on starts it over`, async () => {
    let broken = true;
    const mute = fakeTool({ name: "mute_it", tier: "direct", rule: true, run: () => (broken ? (() => { throw new Error("the store is read-only"); })() : { text: "Muted." }) });
    const t = setup({ sessions: [sess("s1", { title: "tests" })], tools: [mute] });
    const rule = t.engine.add(draft({ actions: [{ tool: "mute_it", args: { session: "s1" } }] }));
    for (let i = 0; i < 4; i++) t.engine.finished("s1", i);
    await t.engine.settled();
    expect(t.engine.runs().map((r) => r.ok)).toEqual([false, false, false]);
    expect(t.engine.runs()[0].text).toBe("mute_it s1: the store is read-only · “tests” finished");
    expect(t.engine.get(rule.id)).toMatchObject({ on: true, paused: "3 runs failed in a row: mute_it s1: the store is read-only", lastRun: { ok: false, text: "mute_it s1: the store is read-only · “tests” finished" } });
    expect((await t.h.svc.view()).rules[0].paused).toContain("3 runs failed in a row");
    expect(t.h.svc.ruleOn(rule.id, true)).toMatchObject({ paused: null });
    t.engine.finished("s1", 10);
    await t.engine.settled();
    expect(t.engine.get(rule.id)!.paused).toBeNull();
    broken = false;
    t.engine.finished("s1", 11);
    await t.engine.settled();
    expect(t.engine.runs().at(-1)).toMatchObject({ ok: true, text: "Muted · “tests” finished" });
  });

  it("pauses once its target has been gone a minute: a session closed and forgotten, a group that's gone", async () => {
    let kept = true;
    const groups = [group("atticus")];
    const t = setup({ sessions: [sess("s1", { title: "tests" }), sess("s2")], groups, kept: () => kept, tools: [focusTool()] });
    const bySession = t.engine.add(draft());
    const byGroup = t.engine.add(draft({ label: "Group", trigger: { kind: "finished", target: { group: "atticus" } } }));
    t.engine.tick();
    kept = false;
    groups.length = 0;
    t.engine.tick();
    t.tick(GONE_MS - 1);
    t.engine.tick();
    expect(t.engine.list().map((r) => r.paused)).toEqual([null, null]);
    // the session back for a moment (a relaunch): its minute starts over
    kept = true;
    t.engine.tick();
    kept = false;
    t.engine.tick();
    t.tick(1);
    t.engine.tick();
    expect(t.engine.get(bySession.id)!.paused).toBeNull();
    expect(t.engine.get(byGroup.id)!.paused).toBe('Its group "atticus" is gone');
    t.tick(GONE_MS - 1);
    t.engine.tick();
    expect(t.engine.get(bySession.id)!.paused).toBe("Its session “tests” is gone: closed and forgotten");
    t.engine.finished("s1", 1);
    await t.engine.settled();
    expect(t.engine.runs()).toEqual([]);
  });

  it(`takes at most ${ASSISTANT_LIMITS.maxRules} rules and ${ASSISTANT_LIMITS.maxRuleActions} actions each`, () => {
    const t = setup({ sessions: [sess("s1"), sess("s2")], tools: [focusTool()], limits: { maxRules: 2 } });
    const six = Array.from({ length: ASSISTANT_LIMITS.maxRuleActions + 1 }, () => ({ tool: "focus_it", args: { session: "s2" } }));
    expect(t.engine.refusal(draft({ actions: six }))).toBe(`A rule takes at most ${ASSISTANT_LIMITS.maxRuleActions} actions`);
    const first = t.engine.add(draft());
    t.engine.add(draft());
    expect(t.engine.refusal(draft())).toBe("Mockingbird keeps at most 2 rules, and there are 2: remove one first");
    // changing one doesn't add one
    expect(t.engine.refusal(draft({ label: "Changed" }), first.id)).toBeNull();
  });
});

describe("rule-only actions", () => {
  const at = (h: number) => local(2026, 10, 16, h, 0);
  const settings = (over: Partial<Settings> = {}) => () => ({ ...DEFAULT_SETTINGS, ...over });

  it("notify shows a desktop notification of what fired it, and none in quiet hours or with notifications off", async () => {
    let s: Partial<Settings> = {};
    const t = setup({ sessions: [sess("s1", { title: "tests" })], settings: () => ({ ...DEFAULT_SETTINGS, ...s }) });
    t.setNow(at(12));
    t.engine.add(draft({ label: "When tests finishes, tell me", actions: [{ tool: "notify", args: { text: "Tests done" } }] }));
    t.engine.finished("s1", 1);
    await t.engine.settled();
    expect(t.notified).toEqual([{ title: "Tests done", body: "“tests” finished · When tests finishes, tell me" }]);
    expect(t.engine.runs()[0]).toMatchObject({ ok: true, text: "Notified you · “tests” finished" });

    // what a run reads is the settings as it runs
    s = { quietHours: { enabled: true, from: "11:00", to: "13:00" } };
    t.engine.finished("s1", 2);
    await t.engine.settled();
    s = { notifications: false };
    t.engine.finished("s1", 3);
    await t.engine.settled();
    // past quiet hours, and notifications on: shown
    t.setNow(at(14));
    s = { quietHours: { enabled: true, from: "11:00", to: "13:00" } };
    t.engine.finished("s1", 4);
    await t.engine.settled();
    expect(t.notified).toHaveLength(2);
    expect(t.engine.runs().map((r) => [r.ok, r.text])).toEqual([
      [true, "Notified you · “tests” finished"],
      [true, "Not shown: it's quiet hours · “tests” finished"],
      [true, "Not shown: notifications are off · “tests” finished"],
      [true, "Notified you · “tests” finished"],
    ]);
  });

  it("text_me goes through the phone alerts' sender to the user's own handle, outside quiet hours", async () => {
    const sent: { handle: string; text: string }[] = [];
    let fail: Error | null = null;
    const sender: AlertSender = {
      send: async (handle, text) => {
        if (fail) throw fail;
        sent.push({ handle, text });
      },
    };
    let quiet = false;
    const t = setup({
      sessions: [sess("s1", { title: "tests" })],
      sender,
      settings: () => ({ ...DEFAULT_SETTINGS, phoneAlerts: { enabled: true, handle: "Me@Example.com", idleMinutes: 10, finished: true, replies: false }, quietHours: { enabled: quiet, from: "11:00", to: "13:00" } }),
    });
    t.setNow(at(12));
    t.engine.add(draft({ label: "When tests finishes, text me", actions: [{ tool: "text_me", args: { text: "Tests done" } }] }));
    t.engine.finished("s1", 1);
    await t.engine.settled();
    expect(sent).toEqual([{ handle: "me@example.com", text: "Mockingbird: Tests done · “tests” finished · When tests finishes, text me" }]);
    expect(t.engine.runs()[0]).toMatchObject({ ok: true, text: "Texted you · “tests” finished" });
    quiet = true;
    t.engine.finished("s1", 2);
    await t.engine.settled();
    expect(sent).toHaveLength(1);
    expect(t.engine.runs()[1]).toMatchObject({ ok: true, text: "Not sent: it's quiet hours · “tests” finished" });
    quiet = false;
    fail = new SendError("automation-denied", "Mockingbird isn't allowed to control Messages.");
    t.engine.finished("s1", 3);
    await t.engine.settled();
    expect(t.engine.runs()[2]).toMatchObject({ ok: false, text: "Text me: “Tests done”: Mockingbird isn't allowed to control Messages. · “tests” finished" });
  });

  it("text_me in a development build only logs it, and fails clearly when phone alerts aren't set up or are off", async () => {
    let phone = { enabled: true, handle: "+1 555 123 4567", idleMinutes: 10, finished: true, replies: false };
    const t = setup({ sessions: [sess("s1", { title: "tests" })], sender: null, settings: () => ({ ...DEFAULT_SETTINGS, phoneAlerts: phone }) });
    t.engine.add(draft({ label: "Text me", actions: [{ tool: "text_me", args: { text: "Tests done" } }] }));
    t.engine.finished("s1", 1);
    await t.engine.settled();
    expect(t.engine.runs()[0]).toMatchObject({ ok: true, text: "Logged, not sent: a development build never sends iMessages · “tests” finished" });
    expect(t.log).toContain('assistant rules: text_me (a development build: logged, not sent): "Mockingbird: Tests done · “tests” finished · Text me"');

    // what a run reads is the settings as it runs
    phone = { ...phone, handle: "" };
    t.engine.finished("s1", 2);
    await t.engine.settled();
    phone = { ...phone, handle: "+15551234567", enabled: false };
    t.engine.finished("s1", 3);
    await t.engine.settled();
    expect(t.engine.runs().slice(1).map((r) => [r.ok, r.text])).toEqual([
      [false, "Text me: “Tests done”: Phone alerts aren't set up: enter your iMessage handle in Settings → Notifications → Phone alerts · “tests” finished"],
      [false, "Text me: “Tests done”: Phone alerts are off: turn them on in Settings → Notifications → Phone alerts · “tests” finished"],
    ]);
  });
});

describe("the rule tools", () => {
  it("propose_rule puts up a card naming the trigger, each action, and that it runs without asking; only Do it saves it, on", async () => {
    const t = setup({ sessions: people(), tools: [focusTool()] });
    let answer: unknown;
    const args = { label: "When tests finishes, focus review", trigger: finishedOf("s1"), actions: [{ tool: "focus_it", args: { session: "s2" } }, { tool: "notify", args: { text: "Tests done" } }] };
    const turn = await t.h.turn("when tests finishes, focus review and tell me", async (call) => ((answer = await call("propose_rule", args)), "Card up."));
    expect(answer).toEqual({ result: CARD_SHOWN });
    expect(t.engine.list()).toEqual([]);
    expect(fs.existsSync(t.file)).toBe(false);
    const card = await t.h.card(turn.steps[0].cardId!);
    expect(card).toMatchObject({
      title: "Make the rule “When tests finishes, focus review”",
      detail: "When “tests” finishes a turn: Focus s2; then Notify me: “Tests done”.",
      warnings: ["Once it's on, it does these each time without asking you."],
      blocked: null,
      state: "open",
    });
    expect(await t.h.svc.confirm(card.id)).toMatchObject({ state: "done", result: expect.stringMatching(/^Made the rule “When tests finishes, focus review” \(r-.*\): it's on\.$/) });
    const [rule] = t.engine.list();
    expect(rule).toMatchObject({
      label: "When tests finishes, focus review",
      trigger: finishedOf("s1"),
      on: true,
      paused: null,
      actions: [
        { tool: "focus_it", args: { session: "s2" }, label: "Focus s2" },
        { tool: "notify", args: { text: "Tests done" }, label: "Notify me: “Tests done”" },
      ],
    });
    expect(new RuleBook({ file: t.file, log: () => {} }).list()).toEqual([rule]);
    expect(t.h.audit).toEqual([expect.objectContaining({ kind: "assistant.action", tool: "propose_rule", source: "card", outcome: "Make the rule “When tests finishes, focus review”: done" })]);
  });

  it("propose_rule is checked when the card is made, and again on Do it", async () => {
    const plain = fakeTool({ name: "close_it", tier: "confirm" });
    const sessions = [...people(), sess("n1", { title: "nick's", mine: false, owner: "Nick" })];
    const t = setup({ sessions, groups: [group("atticus")], tools: [focusTool(), plain] });
    const cases: [Partial<RuleDraft>, string][] = [
      [{ trigger: { kind: "finished" } as RuleTrigger }, "The rule's trigger.target must name a session, a group, or any session"],
      [{ trigger: { kind: "waiting", target: { session: "s1" } } as RuleTrigger }, "The rule's trigger.minutes must be a whole number of minutes, 1 to 1440"],
      [{ trigger: { kind: "finished", target: { session: "s1", any: true } } as unknown as RuleTrigger }, "The rule's trigger.target must name exactly one of: a session, a group, or any session"],
      [{ trigger: { kind: "daily", at: "09:00", days: [1, 1] } }, "The rule's trigger.days lists a weekday twice"],
      [{ trigger: finishedOf("nope") }, 'There\'s no session with id "nope": the ids are in the snapshot and list_sessions'],
      [{ trigger: { kind: "exited", target: { group: "nope" } } }, 'There\'s no group "nope": the groups are in the snapshot and list_groups'],
      [{ trigger: finishedOf("n1") }, "“nick's” is Nick's session: a rule watches only this Mac's own"],
      [{ actions: [{ tool: "close_it", args: { session: "s1" } }] }, 'Its action 1 ("close_it"): that tool can\'t be a standing rule\'s action: list_rules says which can'],
      [{ actions: [{ tool: "nothing_here", args: {} }] }, 'Its action 1 ("nothing_here"): there\'s no such tool'],
      [{ actions: [{ tool: "focus_it", args: { session: 5 } }] }, 'Its action 1 ("focus_it"): its args.session must be a string'],
      [{ actions: [{ tool: "notify", args: {} }] }, 'Its action 1 ("notify"): its args.text is required'],
      [{ label: "  " }, "The rule needs a label: one plain sentence saying what it does"],
    ];
    for (const [over, why] of cases) {
      const turn = await t.h.turn("make a rule", async (call) => (await call("propose_rule", { ...draft(), ...over }), "Card up."));
      const card = await t.h.card(turn.steps[0].cardId!);
      expect(card.blocked, why).toBe(why);
      expect(await t.h.svc.confirm(card.id)).toMatchObject({ state: "open", blocked: why });
    }
    expect(t.engine.list()).toEqual([]);

    // fine when the card is made; its session closed and forgotten before Do it
    const turn = await t.h.turn("make a rule", async (call) => (await call("propose_rule", { ...draft() }), "Card up."));
    sessions.splice(0, 1);
    expect(await t.h.svc.confirm(turn.steps[0].cardId!)).toMatchObject({ state: "open", blocked: 'There\'s no session with id "s1": the ids are in the snapshot and list_sessions' });
    expect(t.engine.list()).toEqual([]);
    expect(t.h.audit).toEqual([]);
  });

  it("change_rule shows what the rule will do from now on; Do it changes it, keeping it off when it was, its pause cleared", async () => {
    const t = setup({ sessions: people(), tools: [focusTool()] });
    const r = t.engine.add(draft());
    t.engine.setOn(r.id, false);
    t.book.note(r.id, { paused: "3 runs failed in a row: x" });
    const turn = await t.h.turn("make it run when tests exits", async (call) => (await call("change_rule", { rule: r.id, trigger: { kind: "exited", target: { session: "s1" } } }), "Card up."));
    const card = await t.h.card(turn.steps[0].cardId!);
    expect(card).toMatchObject({
      title: "Change the rule “When tests finishes, focus review”",
      detail: "From now on: When “tests” exits: Focus s2.",
      warnings: ["Once it's on, it does these each time without asking you.", "It's off, and stays off until you turn it on."],
      blocked: null,
    });
    expect(t.engine.get(r.id)!.trigger.kind).toBe("finished");
    expect(await t.h.svc.confirm(card.id)).toMatchObject({ state: "done" });
    expect(t.engine.get(r.id)).toMatchObject({ id: r.id, on: false, paused: null, trigger: { kind: "exited" }, actions: r.actions, label: r.label });

    const none = await t.h.turn("change it", async (call) => (await call("change_rule", { rule: r.id }), "Card up."));
    expect((await t.h.card(none.steps[0].cardId!)).blocked).toBe("Say what to change: its label, trigger or actions");
    // a card about a rule that's removed since expires
    const gone = await t.h.turn("rename it", async (call) => (await call("change_rule", { rule: r.id, label: "Renamed" }), "Card up."));
    t.engine.remove(r.id);
    t.h.svc.stateChanged();
    expect(await t.h.card(gone.steps[0].cardId!)).toMatchObject({ state: "expired" });
  });

  it("set_rule_on and remove_rule act at once, with an Undo that puts back what was", async () => {
    const t = setup({ sessions: people(), tools: [focusTool()] });
    const a = t.engine.add(draft({ label: "A" }));
    const b = t.engine.add(draft({ label: "B" }));
    t.book.note(a.id, { paused: "3 runs failed in a row: x" });
    const on = await t.h.turn("turn A back on", async (call) => (await call("set_rule_on", { rule: a.id, on: true }), "On."));
    expect(on.steps[0]).toMatchObject({ state: "done", label: "Turn “A” on", undoUntil: expect.any(Number) });
    expect(t.engine.get(a.id)).toMatchObject({ on: true, paused: null });
    expect(await t.h.svc.undo(on.steps[0].id)).toMatchObject({ state: "undone" });
    expect(t.engine.get(a.id)).toMatchObject({ on: true, paused: "3 runs failed in a row: x" });

    const off = await t.h.turn("turn B off", async (call) => (await call("set_rule_on", { rule: b.id, on: false }), "Off."));
    expect(t.engine.get(b.id)!.on).toBe(false);
    // switched again from the sheet since: Undo would undo that too
    t.h.svc.ruleOn(b.id, true);
    expect(await t.h.svc.undo(off.steps[0].id)).toEqual({ error: expect.stringContaining("changed again") });
    expect(t.engine.get(b.id)!.on).toBe(true);

    const already = await t.h.turn("turn B on", async (call) => (await call("set_rule_on", { rule: b.id, on: true }), "Already."));
    expect(already.steps[0]).toMatchObject({ state: "failed", error: "It's on already" });

    const before = t.engine.list();
    const removed = await t.h.turn("remove A", async (call) => (await call("remove_rule", { rule: a.id }), "Removed."));
    expect(t.engine.list().map((r) => r.label)).toEqual(["B"]);
    expect(await t.h.svc.undo(removed.steps[0].id)).toMatchObject({ state: "undone" });
    expect(t.engine.list()).toEqual(before);
    expect(new RuleBook({ file: t.file, log: () => {} }).list()).toEqual(before);
    expect(t.h.audit.map((e) => [e.tool, e.source])).toEqual([
      ["set_rule_on", "step"],
      ["set_rule_on", "undo"],
      ["set_rule_on", "step"],
      ["remove_rule", "step"],
      ["remove_rule", "undo"],
    ]);
  });

  it("list_rules gives the rules, the tools a rule may use and the limits", async () => {
    const t = setup({ sessions: people(), tools: [focusTool(), fakeTool({ name: "close_it", tier: "confirm" })] });
    const r = t.engine.add(draft());
    let answer: any;
    await t.h.turn("what rules do I have?", async (call) => ((answer = await call("list_rules")), "One."));
    const listed = JSON.parse(answer.result);
    expect(listed.rules).toEqual([{ id: r.id, label: r.label, when: "When “tests” finishes a turn", trigger: r.trigger, actions: r.actions, on: true, paused: null, lastRun: null }]);
    expect(listed.usable.map((u: { tool: string }) => u.tool)).toEqual(["focus_it", "notify", "text_me"]);
    expect(listed.limits).toEqual({ rules: 20, actionsPerRule: 5, runsPerHour: 6, failuresToPause: 3 });
  });
});

describe("rule runs in the activity log", () => {
  it("each action is recorded as the rule's, with its tool, target and outcome", async () => {
    const focus = fakeTool({ name: "focus_it", tier: "direct", rule: true, label: (a) => `Focus ${String(a.session)}`, target: (a) => ({ session: String(a.session), title: "review" }) });
    const broken = fakeTool({ name: "mute_it", tier: "direct", rule: true, run: () => { throw new Error("it's gone"); } });
    const t = setup({ sessions: people(), tools: [focus, broken] });
    t.engine.add(draft({ label: "When tests finishes, focus review", actions: [{ tool: "focus_it", args: { session: "s2" } }, { tool: "notify", args: { text: "Done" } }, { tool: "mute_it", args: { session: "s1" } }] }));
    t.engine.finished("s1", 1);
    await t.engine.settled();
    expect(t.h.audit).toEqual([
      expect.objectContaining({ kind: "assistant.action", tool: "focus_it", source: "rule", session: "s2", title: "review", outcome: "Rule “When tests finishes, focus review”: Focus s2: done" }),
      expect.objectContaining({ kind: "assistant.action", tool: "notify", source: "rule", outcome: "Rule “When tests finishes, focus review”: Notify me: “Done”: done" }),
      expect.objectContaining({ kind: "assistant.action", tool: "mute_it", source: "rule", outcome: "Rule “When tests finishes, focus review”: mute_it s1: failed: it's gone" }),
    ]);
    expect(t.engine.runs()[0]).toMatchObject({ ok: false, text: "mute_it s1: it's gone · “tests” finished" });
  });
});

/** The test's two sessions: "tests" (s1), and "review" (s2). */
function people(): AssistantSession[] {
  return [sess("s1", { title: "tests" }), sess("s2", { title: "review" })];
}
