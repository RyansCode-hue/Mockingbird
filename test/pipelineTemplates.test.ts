import { describe, expect, it } from "vitest";
import {
  asShown,
  kickoffAsTicket,
  layOutPlan,
  parseTemplateBody,
  readTemplates,
  roomAsked,
  TemplateError,
  ticketKickoffPrompt,
  ticketLine,
  wireSettingsOf,
  withTicket,
  type TemplateBody,
  type TemplateStep,
  type TemplateWire,
} from "../src/shared/pipelineTemplates";

const step = (key: string, over: Partial<TemplateStep> = {}): TemplateStep => ({ key, name: key.toUpperCase(), agent: "claude", folder: "new", prompt: "", ...over });
/** Builder → Reviewer (in its folder) → Tester, Reviewer's feedback to Builder, Dev server on Builder's tree. */
const chain = (over: { startFirst?: boolean; wires?: TemplateWire[] } = {}): TemplateBody => ({
  startFirst: over.startFirst ?? true,
  steps: [
    step("s1", { name: "Builder", agent: "codex", prompt: "Implement {ticket}." }),
    step("s2", { name: "Reviewer", folder: { sameAs: "s1" }, prompt: "Review {ticket}." }),
    step("s3", { name: "Tester" }),
    step("s4", { name: "Dev server", agent: "terminal", folder: { sameAs: "s1" }, prompt: "dotnet watch" }),
  ],
  wires: over.wires ?? [
    { from: "s1", to: "s2", type: "handoff", when: "finished", gate: "ask" },
    { from: "s2", to: "s1", type: "feedback", when: "finished", gate: "ask", rounds: 3 },
    { from: "s2", to: "s3", type: "handoff", when: "finished", gate: "automatic" },
    { from: "s1", to: "s4", type: "worktree" },
  ],
});
const stored = (over: Record<string, unknown> = {}) => ({ id: "tpl-1", name: "Build, review, test", savedAt: 5, ...chain(), ...over });
const why = (f: () => unknown): string => {
  try {
    f();
  } catch (err) {
    expect(err).toBeInstanceOf(TemplateError);
    return (err as Error).message;
  }
  return "not refused";
};

describe("a template's body", () => {
  it("reads a chain whole", () => {
    expect(parseTemplateBody(chain())).toEqual(chain());
  });

  it.each<[string, (b: TemplateBody) => unknown, RegExp]>([
    ["a field this version doesn't know", (b) => ({ ...b, colour: "teal" }), /doesn't know \(colour\)/],
    ["a step's field it doesn't know", (b) => ({ ...b, steps: [{ ...b.steps[0], icon: "x" }, ...b.steps.slice(1)] }), /Step 1 has a field this version doesn't know \(icon\)/],
    ["no steps", (b) => ({ ...b, steps: [], wires: [] }), /has no steps/],
    ["steps that aren't a list", (b) => ({ ...b, steps: "three" }), /steps aren't a list/],
    ["a terminal first", (b) => ({ ...b, steps: [b.steps[3], ...b.steps.slice(0, 3)] }), /first step, “Dev server”, is a terminal/],
    ["two steps of one name", (b) => ({ ...b, steps: b.steps.map((s) => (s.key === "s3" ? { ...s, name: "builder" } : s)) }), /Two steps are called “builder”/],
    ["a step in its own folder by key", (b) => ({ ...b, steps: b.steps.map((s) => (s.key === "s3" ? { ...s, folder: { sameAs: "s3" } } : s)) }), /works in its own folder/],
    ["a folder of a step after it", (b) => ({ ...b, steps: b.steps.map((s) => (s.key === "s2" ? { ...s, folder: { sameAs: "s3" } } : s)) }), /“Reviewer” works in “Tester”'s folder, which comes after it/],
    ["a terminal with no worktree wire to it", (b) => ({ ...b, wires: b.wires.filter((w) => w.type !== "worktree") }), /terminal with no shared worktree wire from “Builder”/],
    ["{ticket} in a terminal's command", (b) => ({ ...b, steps: b.steps.map((s) => (s.key === "s4" ? { ...s, prompt: "echo {ticket}" } : s)) }), /a ticket's text typed into a shell would run/],
    ["a handoff into a terminal", (b) => ({ ...b, wires: [...b.wires, { from: "s3", to: "s4", type: "handoff" }] }), /only a shared worktree wire reaches one/],
    ["a cycle of handoffs", (b) => ({ ...b, wires: [...b.wires, { from: "s3", to: "s1", type: "handoff" }] }), /Tester → Builder:/],
    ["a second wire of a type between two", (b) => ({ ...b, wires: [...b.wires, { from: "s1", to: "s2", type: "handoff" }] }), /Builder → Reviewer:/],
    ["rounds on a handoff", (b) => ({ ...b, wires: b.wires.map((w, i) => (i === 0 ? { ...w, rounds: 2 } : w)) }), /only a feedback wire counts rounds/],
    ["a file outside its step's folder", (b) => ({ ...b, wires: b.wires.map((w, i) => (i === 0 ? { ...w, files: ["../.env"] } : w)) }), /isn't a path inside the step's folder/],
    ["an automatic context link", (b) => ({ ...b, wires: [...b.wires, { from: "s3", to: "s2", type: "context", gate: "automatic" }] }), /has no gate to make automatic/],
  ])("refuses %s, saying why", (_what, change, re) => {
    expect(why(() => parseTemplateBody(change(chain())))).toMatch(re);
  });
});

describe("the saved list (settings.pipelineTemplates)", () => {
  it("is empty when there's none", () => {
    expect(readTemplates(undefined)).toEqual({ templates: [], refused: [] });
  });

  it("keeps a newer version's fields, listed, and uses the rest", () => {
    const newer = stored({ colour: "teal", steps: chain().steps.map((s, i) => (i === 1 ? { ...s, icon: "eye" } : s)) });
    const r = readTemplates([newer]);
    expect(r.refused).toEqual([]);
    expect(r.templates).toEqual([{ template: { id: "tpl-1", name: "Build, review, test", savedAt: 5, ...chain() }, unknown: ["colour", "steps[1].icon"] }]);
  });

  it("refuses a malformed entry by itself, saying why, and reads the others", () => {
    const r = readTemplates([stored({ id: "tpl-bad", name: "Ticket → build", steps: "three" }), stored({ id: "tpl-2", name: "Fine" }), 7]);
    expect(r.templates.map((t) => t.template.id)).toEqual(["tpl-2"]);
    expect(r.refused).toEqual([
      { index: 0, name: "Ticket → build", id: "tpl-bad", why: "Its steps aren't a list." },
      { index: 2, name: null, id: null, why: "The template isn't an object." },
    ]);
  });

  it("reads nothing from a list that isn't one, saying so", () => {
    expect(readTemplates({ a: 1 }).broken).toMatch(/aren't a list.*nothing is saved over them/);
  });
});

describe("laying one out (layOutPlan)", () => {
  it("starts the first step, makes its terminal as it starts, and keeps each gate", () => {
    const p = layOutPlan(chain(), { room: false, ticket: true });
    expect(p.problems).toEqual([]);
    expect(p.forced).toBe(0);
    expect(p.steps.map((s) => [s.step.key, s.starts, s.terminal?.laid ?? null])).toEqual([["s1", true, null], ["s2", false, null], ["s3", false, null], ["s4", false, true]]);
    expect(p.wires.map((w) => [w.wire.type, w.gate, w.afterStart, w.skipped])).toEqual([["handoff", "ask", false, false], ["feedback", "ask", false, false], ["handoff", "automatic", false, false], ["worktree", "ask", true, false]]);
  });

  it("makes every gate ask in a team room's area, counting what it forced", () => {
    const p = layOutPlan(chain(), { room: true, ticket: true });
    expect(p.wires.map((w) => [w.gate, w.forced])).toEqual([["ask", false], ["ask", false], ["ask", true], ["ask", false]]);
    expect(p.forced).toBe(1);
    expect(roomAsked(1)).toBe("In a team room's area every gate asks, so its automatic gate was laid out asking.");
    expect(roomAsked(2)).toBe("In a team room's area every gate asks, so its 2 automatic gates were laid out asking.");
  });

  it("flags a terminal whose agent doesn't start, and makes none: a terminal can't wait as a step", () => {
    const p = layOutPlan(chain({ startFirst: false }), { room: false, ticket: false });
    expect(p.steps[3].terminal).toEqual({ laid: false, why: expect.stringMatching(/^It isn't laid out: a terminal takes no handoff, so it can't wait as a step, and “Builder” doesn't start/) });
    expect(p.wires[3]).toMatchObject({ skipped: true, afterStart: false });
    expect(p.steps.every((s) => !s.starts)).toBe(true);
  });

  it("lays a wire that goes when a PR merges only from the first step, starting on a ticket", () => {
    const merged = (from: string, to: string): TemplateWire => ({ from, to, type: "handoff", when: "pr-merged", gate: "ask" });
    const fromFirst = chain({ wires: [merged("s1", "s3"), { from: "s1", to: "s4", type: "worktree" }] });
    expect(layOutPlan(fromFirst, { room: false, ticket: true })).toMatchObject({ problems: [] });
    expect(layOutPlan(fromFirst, { room: false, ticket: true }).wires[0]).toMatchObject({ afterStart: true });
    expect(layOutPlan(fromFirst, { room: false, ticket: false }).problems).toEqual(["Builder → Tester goes when “Builder”'s pull request merges, which needs “Builder” started on a ticket's branch, and no ticket is chosen."]);
    const later = chain({ wires: [{ from: "s1", to: "s2", type: "handoff" }, merged("s2", "s3"), { from: "s1", to: "s4", type: "worktree" }] });
    expect(layOutPlan(later, { room: false, ticket: true }).problems[0]).toMatch(/“Reviewer” isn't the first step, so it waits as this is laid out\.$/);
  });

  it("writes out what each wire carries as it's shown, a default included, leaving a link's and a tree's alone", () => {
    const b = chain({ wires: [...chain().wires.slice(0, 2), { from: "s2", to: "s3", type: "handoff", when: "pr-merged", gate: "ask" }, { from: "s3", to: "s2", type: "context" }, chain().wires[3]] });
    expect(asShown(b).wires.map((w) => w.template ?? null)).toEqual(["{summary}", "{summary}", "{pr}\n\n{summary}", null, null]);
    const edited = { ...b, wires: b.wires.map((w, i) => (i === 0 ? { ...w, template: "Only the diff: {diff}" } : w)) };
    expect(asShown(edited).wires[0].template).toBe("Only the diff: {diff}");
    expect(parseTemplateBody(asShown(b))).toEqual(asShown(b));
  });

  it("gives a wire its settings as wires:add takes them", () => {
    const [h, f, , t] = chain().wires;
    expect(wireSettingsOf(h, "ask")).toEqual({ when: "finished", gate: "ask" });
    expect(wireSettingsOf(f, "ask")).toEqual({ when: "finished", gate: "ask", limit: 3 });
    expect(wireSettingsOf(t, "ask")).toEqual({});
  });
});

describe("{ticket}", () => {
  it("is the ticket's line, or nothing with no ticket", () => {
    const line = ticketLine("5115", "Stream the donor export");
    expect(line).toBe("#5115 — Stream the donor export");
    expect(withTicket("Implement {ticket}. Then {ticket} again.", line)).toBe("Implement #5115 — Stream the donor export. Then #5115 — Stream the donor export again.");
    expect(ticketLine(null, "x")).toBe("");
    expect(withTicket("Fix {ticket}.", "")).toBe("Fix .");
  });

  it("stands for a ticket kickoff a step was told, with or without its description", () => {
    const told = `${ticketKickoffPrompt(4182, "Stream the donor export", "It times out\n\nat 40k donors.")}\n\nThen run the tests.`;
    expect(kickoffAsTicket(told)).toEqual({ text: "{ticket}\n\nThen run the tests.", count: 1 });
    expect(kickoffAsTicket(ticketKickoffPrompt(7, "Short", ""))).toEqual({ text: "{ticket}", count: 1 });
    expect(kickoffAsTicket("Nothing of a ticket here.")).toEqual({ text: "Nothing of a ticket here.", count: 0 });
  });
});
