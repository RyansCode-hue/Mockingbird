import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  asShown,
  hiddenTextProblems,
  kickoffAsTicket,
  LAY_OUT_MAX,
  layOutPlan,
  moreTicketsOf,
  parseTemplateBody,
  perTicketBody,
  readTemplates,
  roomAsked,
  runsPerTicket,
  TemplateError,
  templateRefusal,
  ticketedLayOutPlan,
  ticketKickoffPrompt,
  ticketLine,
  ticketsLine,
  ticketsTaken,
  wireSettingsOf,
  withTicket,
  type TemplateBody,
  type TemplateStep,
  type TemplateWire,
} from "../src/shared/pipelineTemplates";
import { orchestratorKickoff } from "../src/shared/plans";
import { tempDir } from "./helpers";

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

  it("won't lay out text holding control or invisible characters, saying where: a terminal's command is typed into a shell", () => {
    const b = chain();
    const dev = b.steps.findIndex((s) => s.agent === "terminal");
    b.steps[dev] = { ...b.steps[dev], prompt: "npm run dev\u0015rm -rf ." };
    b.steps[0] = { ...b.steps[0], prompt: `${b.steps[0].prompt}\u202e` };
    const p = layOutPlan(b, { room: false, ticket: true });
    expect(p.problems).toEqual([
      `“${b.steps[0].name}”'s prompt holds invisible characters, which can hide or reorder text where you read it: retype it.`,
      `“${b.steps[dev].name}”'s command holds control characters, which a terminal or an agent acts on rather than shows: retype it.`,
    ]);
    expect(hiddenTextProblems(chain())).toEqual([]);
  });

  it("lays out a prompt's emoji as shown, and not a terminal command's emoji or tab", () => {
    const emoji = "\u2705\ufe0f \ud83d\udc68\u200d\ud83d\udcbb \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb 1\ufe0f\u20e3";
    const b = chain();
    const dev = b.steps.findIndex((s) => s.agent === "terminal");
    b.steps[0] = { ...b.steps[0], prompt: `${b.steps[0].prompt} ${emoji}` };
    expect(layOutPlan(b, { room: false, ticket: true }).problems).toEqual([]);
    b.steps[dev] = { ...b.steps[dev], prompt: "npm run dev\t" };
    expect(hiddenTextProblems(b)).toEqual([`\u201c${b.steps[dev].name}\u201d's command holds a tab, which a shell takes as completion rather than a space: use spaces.`]);
    b.steps[dev] = { ...b.steps[dev], prompt: "npm run dev \u2705\ufe0f" };
    expect(hiddenTextProblems(b)).toEqual([`\u201c${b.steps[dev].name}\u201d's command holds invisible characters, which can hide or reorder text where you read it: retype it.`]);
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
    // an emptied What flows sends the default, its When's
    const emptied = { ...b, wires: b.wires.map((w, i) => (i === 0 ? { ...w, template: "" } : i === 2 ? { ...w, template: " \n " } : w)) };
    expect(asShown(emptied).wires.map((w) => w.template ?? null)).toEqual(["{summary}", "{summary}", "{pr}\n\n{summary}", null, null]);
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
    expect(line).toBe(`#5115 (its title, the ticket's own words: "Stream the donor export")`);
    expect(withTicket("Implement {ticket}. Then {ticket} again.", line)).toBe(`Implement ${line}. Then ${line} again.`);
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

// ---- steps that run once per ticket --------------------------------------------------------------

/**
 * Planner (once, its own worktree) → Coder (once per ticket, its own worktree) → Verifier (once per ticket, in Coder's
 * folder) → Merger (once); Verifier's feedback to Coder; Dev server on Coder's tree, per ticket with it.
 */
const fanned = (over: { startFirst?: boolean; steps?: (s: TemplateStep[]) => TemplateStep[]; wires?: TemplateWire[] } = {}): TemplateBody => {
  const steps = [
    step("plan", { name: "Planner", prompt: "Plan {ticket}." }),
    step("code", { name: "Coder", agent: "codex", prompt: "Implement {ticket}.", perTicket: true }),
    step("verify", { name: "Verifier", folder: { sameAs: "code" }, prompt: "Verify {ticket}.", perTicket: true }),
    step("merge", { name: "Merger", prompt: "Merge {ticket}." }),
    step("dev", { name: "Dev server", agent: "terminal", folder: { sameAs: "code" }, prompt: "npm run dev", perTicket: true }),
  ];
  return {
    startFirst: over.startFirst ?? true,
    steps: over.steps ? over.steps(steps) : steps,
    wires: over.wires ?? [
      { from: "plan", to: "code", type: "handoff" },
      { from: "code", to: "verify", type: "handoff", gate: "automatic" },
      { from: "verify", to: "code", type: "feedback", rounds: 3 },
      { from: "verify", to: "merge", type: "handoff" },
      { from: "code", to: "dev", type: "worktree" },
    ],
  };
};
const edit = (b: TemplateBody, key: string, patch: Partial<TemplateStep>): TemplateBody => ({ ...b, steps: b.steps.map((s) => (s.key === key ? { ...s, ...patch } : s)) });

describe("a step that runs once per ticket (perTicket)", () => {
  it("reads whole, its wires fanning out from a step run once and in again", () => {
    expect(parseTemplateBody(fanned())).toEqual(fanned());
    expect(runsPerTicket(fanned())).toBe(true);
    expect(runsPerTicket(chain())).toBe(false);
  });

  it.each<[string, (b: TemplateBody) => unknown, RegExp]>([
    ["perTicket false", (b) => edit(b, "plan", { perTicket: false as unknown as true }), /Step 1's perTicket is only ever true: a step without it runs once/],
    ["an Orchestrator that runs once per ticket", (b) => edit(b, "plan", { role: "orchestrator", perTicket: true }), /“Planner” is an Orchestrator, which runs once and plans for every ticket/],
    ["a terminal apart from its agent", (b) => edit(b, "dev", { perTicket: undefined }), /“Dev server” is a terminal on “Coder”'s tree, so it runs once per ticket just when “Coder” does/],
    ["one in the repo's checkout", (b) => edit(b, "code", { folder: "checkout" }), /“Coder” runs once per ticket, each on its ticket's branch, so the repo's checkout can't hold them: say new/],
    ["one in a once-run step's folder", (b) => edit(b, "code", { folder: { sameAs: "plan" } }), /“Coder” runs once per ticket, each on its ticket's branch, and “Planner” runs once: give it a worktree of its own/],
    ["a once-run step in one's folder", (b) => edit(b, "merge", { folder: { sameAs: "code" } }), /“Merger” runs once, and “Coder” runs once per ticket, so it has a folder for each ticket/],
  ])("refuses %s, saying why", (_what, change, re) => {
    expect(why(() => parseTemplateBody(change(fanned())))).toMatch(re);
    expect(templateRefusal(change(fanned()) as TemplateBody)).toMatch(re);
  });

  it("may work in its Orchestrator's folder: the plan places each copy", () => {
    const b = edit(edit(fanned(), "plan", { role: "orchestrator" }), "code", { folder: { sameAs: "plan" } });
    expect(templateRefusal(b)).toBeNull();
  });

  it("holds the wire rules on every ticket's copy: a second feedback either way, a loop of handoffs", () => {
    expect(why(() => parseTemplateBody({ ...fanned(), wires: [...fanned().wires, { from: "code", to: "verify", type: "feedback" }] }))).toMatch(/Coder → Verifier: These two have a feedback wire already/);
    expect(why(() => parseTemplateBody({ ...fanned(), wires: [...fanned().wires, { from: "merge", to: "plan", type: "handoff" }] }))).toMatch(/Merger → Planner: That would make a cycle/);
  });

  it("is kept by a version that doesn't read it as a field it lists and passes over: a template it lays out once", async () => {
    // this version reads it
    const saved = { id: "tpl-9", name: "Fanned", savedAt: 9, ...fanned() };
    expect(readTemplates([saved]).templates).toEqual([{ template: saved, unknown: [] }]);
    // 1.9.0's reader, from history: a clone without it (a shallow one) can't check this, and says so
    const at = "ea854c4e2ab9afe063782a50a6299c0771e0449d";
    let old: string;
    try {
      old = execFileSync("git", ["show", `${at}:src/shared/pipelineTemplates.ts`], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      console.warn("[pipelineTemplates.test] 1.9.0 isn't in this clone's history: its reader of perTicket isn't checked");
      return;
    }
    const shared = path.resolve(__dirname, "../src/shared");
    const file = path.join(tempDir("reader-1.9.0"), "pipelineTemplates.ts");
    fs.writeFileSync(file, old.replace(/from "\.\/([^"]+)"/g, (_m, mod: string) => `from ${JSON.stringify(path.join(shared, mod))}`));
    const v190 = (await import(file)) as typeof import("../src/shared/pipelineTemplates");
    const read = v190.readTemplates([saved]);
    expect(read.refused).toEqual([]);
    expect(read.templates[0].unknown).toEqual(["steps[1].perTicket", "steps[2].perTicket", "steps[4].perTicket"]);
    expect(read.templates[0].template.steps.some((s) => "perTicket" in s)).toBe(false);
    // and it lays every step out once
    expect(v190.layOutPlan(read.templates[0].template, { room: false, ticket: true }).steps).toHaveLength(5);
  });
});

describe("laid out on several tickets (perTicketBody, ticketedLayOutPlan)", () => {
  it("is the template itself on one ticket, or none, its plan layOutPlan's", () => {
    const b = fanned();
    expect(perTicketBody(b, 1).body).toBe(b);
    expect(perTicketBody(b, 0).body).toBe(b);
    expect([...perTicketBody(b, 1).of]).toEqual([
      ["plan", { key: "plan", ticket: null }],
      ["code", { key: "code", ticket: 0 }],
      ["verify", { key: "verify", ticket: 0 }],
      ["merge", { key: "merge", ticket: null }],
      ["dev", { key: "dev", ticket: 0 }],
    ]);
    expect(ticketedLayOutPlan(b, { room: false, ticket: true }, 1).plan).toEqual(layOutPlan(b, { room: false, ticket: true }));
  });

  it("makes each step that runs once per ticket for each, its folder its ticket's copy's, and fans its wires out and in", () => {
    const { body, of } = perTicketBody(fanned(), 3);
    expect(body.steps.map((s) => [s.key, typeof s.folder === "object" ? s.folder.sameAs : s.folder])).toEqual([
      ["plan", "new"],
      ["code@1", "new"],
      ["code@2", "new"],
      ["code@3", "new"],
      ["verify@1", "code@1"],
      ["verify@2", "code@2"],
      ["verify@3", "code@3"],
      ["merge", "new"],
      ["dev@1", "code@1"],
      ["dev@2", "code@2"],
      ["dev@3", "code@3"],
    ]);
    expect(of.get("verify@2")).toEqual({ key: "verify", ticket: 1 });
    expect(of.get("merge")).toEqual({ key: "merge", ticket: null });
    expect(body.wires.map((w) => `${w.from}→${w.to} ${w.type}`)).toEqual([
      "plan→code@1 handoff",
      "plan→code@2 handoff",
      "plan→code@3 handoff",
      "code@1→verify@1 handoff",
      "code@2→verify@2 handoff",
      "code@3→verify@3 handoff",
      "verify@1→code@1 feedback",
      "verify@2→code@2 feedback",
      "verify@3→code@3 feedback",
      "verify@1→merge handoff",
      "verify@2→merge handoff",
      "verify@3→merge handoff",
      "code@1→dev@1 worktree",
      "code@2→dev@2 worktree",
      "code@3→dev@3 worktree",
    ]);
    // each copy's wire keeps its settings
    expect(body.wires[3]).toMatchObject({ gate: "automatic" });
    expect(body.wires[6]).toMatchObject({ rounds: 3 });
  });

  it("starts each copy of a first step that runs once per ticket, its terminal and PR-merged wires made as each starts", () => {
    const b = fanned({
      steps: (s) => [s[1], s[4], s[3]],
      wires: [
        { from: "code", to: "merge", type: "handoff", when: "pr-merged" },
        { from: "code", to: "dev", type: "worktree" },
      ],
    });
    const { plan } = ticketedLayOutPlan(b, { room: false, ticket: true }, 2);
    expect(plan.problems).toEqual([]);
    expect(plan.steps.map((p) => [p.step.key, p.starts, p.terminal?.laid ?? null])).toEqual([
      ["code@1", true, null],
      ["code@2", true, null],
      ["dev@1", false, true],
      ["dev@2", false, true],
      ["merge", false, null],
    ]);
    expect(plan.wires.map((w) => [w.wire.from, w.wire.to, w.afterStart])).toEqual([
      ["code@1", "merge", true],
      ["code@2", "merge", true],
      ["code@1", "dev@1", true],
      ["code@2", "dev@2", true],
    ]);
  });

  it("says once what stops it on every ticket, and counts each automatic gate a room makes ask", () => {
    const pr = fanned({ wires: [...fanned().wires.filter((w) => w.from !== "verify" || w.to !== "merge"), { from: "verify", to: "merge", type: "handoff", when: "pr-merged" }] });
    const { plan } = ticketedLayOutPlan(pr, { room: false, ticket: true }, 3);
    expect(plan.problems).toEqual(["Verifier → Merger goes when “Verifier”'s pull request merges, which needs “Verifier” started on a ticket's branch, and “Verifier” isn't the first step, so it waits as this is laid out."]);
    expect(ticketedLayOutPlan(fanned(), { room: true, ticket: true }, 3).plan.forced).toBe(3);
  });

  it("takes as many tickets as its steps can be made for in one lay-out", () => {
    expect(ticketsTaken(chain())).toBe(1);
    // 2 run once, 3 once per ticket: (24 − 2) / 3 is past the most tickets one takes
    expect(ticketsTaken(fanned())).toBe(LAY_OUT_MAX.tickets);
    expect(ticketsTaken({ steps: [...Array(8).keys()].map((i) => step(`s${i}`, { perTicket: true })) })).toBe(3);
  });

  it("fills a step run once with every ticket, and reads its other tickets strictly", () => {
    expect(ticketsLine([{ id: "1", title: "One" }, { id: "2", title: "Two" }, { id: "3", title: null }])).toBe(
      `#1 (its title, the ticket's own words: "One"), #2 (its title, the ticket's own words: "Two") and #3`
    );
    expect(ticketsLine([{ id: "5", title: "Five" }])).toBe(ticketLine("5", "Five"));
    expect(ticketsLine([])).toBe("");
    const t = (ticketId: unknown, ticketTitle = "T") => ({ ticketId, ticketTitle, ticketDescription: "" });
    expect(moreTicketsOf([t("#2"), t("3")], "1", 6, "too many")).toEqual([
      { ticketId: "2", title: "T", description: "" },
      { ticketId: "3", title: "T", description: "" },
    ]);
    expect(() => moreTicketsOf([t("1")], "1", 6, "too many")).toThrow("#1 is chosen twice.");
    expect(() => moreTicketsOf([t("x")], "1", 6, "too many")).toThrow("Its ticket 2 isn't a work item.");
    expect(() => moreTicketsOf([t("2"), t("3")], "1", 2, "too many")).toThrow("too many");
    expect(() => moreTicketsOf("2", "1", 6, "too many")).toThrow("Its other tickets aren't a list.");
  });

  it("is told to an Orchestrator on several tickets by key, as its starting shape names them", () => {
    const b = edit(edit(fanned(), "plan", { role: "orchestrator" }), "code", { folder: { sameAs: "plan" } });
    const more = [{ ticketId: "2", title: "Two", description: "" }];
    expect(orchestratorKickoff({ ticketId: "1", title: "One", description: "", told: "", template: b, more, makeNonce: () => "n" })).toContain(
      `repeat or change it to fit these tickets, then propose it with propose_plan. In it, the steps keyed "code", "verify" and "dev" run once per ticket: give every ticket one of each, on that ticket. The other steps run once. In propose_plan's terms:`
    );
    expect(orchestratorKickoff({ ticketId: "1", title: "One", description: "", told: "", template: b, makeNonce: () => "n" })).not.toContain("once per ticket");
  });
});
