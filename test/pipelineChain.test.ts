import { describe, expect, it } from "vitest";
import { newWire, type Gate, type Wire, type WireType } from "../src/shared/wires";
import { chainOf, noStepNote, stepNote, type Chain, type StepEnd } from "../src/renderer/pipelineChain";

// The pipeline strip's chain (W6): upstream as one chain, downstream the first branch with the others beside it, the
// attached workspaces, and what each step says.

let made = 0;
const wire = (from: string, to: string, type: WireType = "handoff", more: Partial<Wire> = {}): Wire => ({
  ...newWire(from, to, type, ++made),
  ...(type === "feedback" ? { rounds: { limit: 3, used: 0 } } : {}),
  ...more,
});
const open = (id: string): StepEnd => ({ title: id.toUpperCase(), agent: "claude", status: "idle", where: "open" });
const idle: Gate = { state: "idle", gate: "ask" };
const chain = (here: string, links: Record<string, Wire>, ends: Record<string, StepEnd | null> = {}, gate: (id: string) => Gate = () => idle): Chain | null =>
  chainOf(here, links, (id) => (id in ends ? ends[id] : open(id)), (id) => gate(id));
const ids = (c: Chain | null) => c && { up: c.up.map((s) => s.id), here: c.here.id, down: c.down.map((s) => s.id) };

describe("chainOf", () => {
  it("is null for a workspace with no wires, so no strip shows", () => {
    expect(chain("a", {})).toBeNull();
    expect(chain("a", { w1: wire("b", "c") })).toBeNull();
  });

  it("walks upstream and downstream along handoffs, each step reached by its wire", () => {
    const c = chain("b", { w1: wire("a", "b"), w2: wire("b", "c"), w3: wire("c", "d") });
    expect(ids(c)).toEqual({ up: ["a"], here: "b", down: ["c", "d"] });
    expect(c!.up[0].hop?.wire).toBe("w1");
    expect(c!.down.map((s) => s.hop?.wire)).toEqual(["w2", "w3"]);
    expect(c!.here.hop).toBeNull();
  });

  it("closes a feedback loop on the step it leaves from, and never walks a workspace twice", () => {
    // builder → reviewer → tester, the reviewer's feedback going back to the builder
    const links = { w1: wire("ticket", "builder"), w2: wire("builder", "reviewer"), w3: wire("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 1 } }), w4: wire("reviewer", "tester") };
    const c = chain("builder", links);
    expect(ids(c)).toEqual({ up: ["ticket"], here: "builder", down: ["reviewer", "tester"] });
    expect(c!.down[0].back).toMatchObject({ wire: "w3", to: "builder", rounds: { limit: 3, used: 1 } });
    expect(c!.down[0].also).toEqual([]);
    // from the reviewer the same chain, its loop on itself
    expect(ids(chain("reviewer", links))).toEqual({ up: ["ticket", "builder"], here: "reviewer", down: ["tester"] });
    expect(chain("reviewer", links)!.here.back?.to).toBe("builder");
    // a feedback wire back to a workspace further up is still the loop, not the way on
    const far = { w1: wire("ticket", "builder"), w2: wire("builder", "reviewer"), w3: wire("reviewer", "ticket", "feedback") };
    expect(ids(chain("builder", far))).toEqual({ up: ["ticket"], here: "builder", down: ["reviewer"] });
    expect(chain("builder", far)!.down[0].back?.to).toBe("ticket");
    // a cycle of handoffs a damaged book could hold ends where it would come round, upstream as it hands on to this one
    const cycle = chain("a", { w1: wire("a", "b"), w2: wire("b", "c"), w3: wire("c", "a") });
    expect(ids(cycle)).toEqual({ up: ["b", "c"], here: "a", down: [] });
    expect(cycle!.here.back?.to).toBe("b");
  });

  it("says, with no step after this one, that it hands work on to nothing, or round to a step before it in a cycle", () => {
    const line = chain("b", { w1: wire("a", "b") })!;
    expect(noStepNote(line, false)).toBe("This workspace hands work on to nothing");
    expect(noStepNote(chain("a", { w1: wire("a", "b") })!, true)).toBe("Nothing hands work on to this workspace");
    // a feedback loop back isn't handing work on
    const loop = chain("b", { w1: wire("a", "b"), w2: wire("b", "a", "feedback") })!;
    expect(ids(loop)!.down).toEqual([]);
    expect(noStepNote(loop, false)).toBe("This workspace hands work on to nothing");
    // a damaged cycle of handoffs: a hands on to b, which comes before it here
    const cycle = chain("a", { w1: wire("a", "b"), w2: wire("b", "c"), w3: wire("c", "a") })!;
    expect(noStepNote(cycle, false)).toBe("This workspace hands work on to “B”, which comes before it: its handoffs run in a circle");
    expect(noStepNote(chain("a", { w1: wire("a", "b"), w2: wire("b", "a") }, { b: null })!, false)).toBe(
      "This workspace hands work on to a workspace that's gone, which comes before it: its handoffs run in a circle"
    );
  });

  it("takes the first branch of a fan-out, the others beside it as its +n", () => {
    const links = { w1: wire("builder", "reviewer"), w2: wire("builder", "tester"), w3: wire("builder", "docs"), w4: wire("reviewer", "notes") };
    const c = chain("builder", links);
    expect(ids(c)).toEqual({ up: [], here: "builder", down: ["reviewer", "notes"] });
    expect(c!.down[0].also.map((s) => [s.id, s.hop?.wire])).toEqual([
      ["tester", "w2"],
      ["docs", "w3"],
    ]);
    expect(c!.down[1].also).toEqual([]);
    // handoffs before feedback, whatever order they were made in
    const fb = chain("builder", { w1: wire("builder", "x", "feedback"), w2: wire("builder", "y") });
    expect(ids(fb)!.down).toEqual(["y"]);
    expect(fb!.down[0].also.map((s) => s.id)).toEqual(["x"]);
    // upstream is one chain: a second workspace handing on to this one is beside the first
    const fanIn = chain("c", { w1: wire("a", "c"), w2: wire("b", "c") });
    expect(ids(fanIn)).toEqual({ up: ["a"], here: "c", down: [] });
    expect(fanIn!.up[0].also.map((s) => s.id)).toEqual(["b"]);
  });

  it("lists each other workspace in a +n once, and never the step taken, when two wires join the same two", () => {
    // a handoff and a feedback wire the same way: the step taken isn't beside itself, and y is named once
    const links = { w1: wire("builder", "reviewer"), w2: wire("builder", "reviewer", "feedback"), w3: wire("builder", "y"), w4: wire("builder", "y", "feedback") };
    const c = chain("builder", links);
    expect(ids(c)!.down).toEqual(["reviewer"]);
    expect(c!.down[0].also.map((s) => [s.id, s.hop?.wire])).toEqual([["y", "w3"]]);
    // upstream too
    const up = chain("c", { w1: wire("a", "c"), w2: wire("a", "c", "feedback"), w3: wire("b", "c"), w4: wire("b", "c", "feedback") });
    expect(ids(up)!.up).toEqual(["a"]);
    expect(up!.up[0].also.map((s) => s.id)).toEqual(["b"]);
  });

  it("names a ghost, a not-started step and one that's gone as their ends say", () => {
    const ends = { ghost: { ...open("ghost"), where: "ghost" as const }, planned: { ...open("planned"), where: "planned" as const }, gone: null };
    const c = chain("a", { w1: wire("a", "ghost"), w2: wire("ghost", "planned"), w3: wire("a", "gone") }, ends);
    expect(ids(c)).toEqual({ up: [], here: "a", down: ["ghost", "planned"] });
    expect(c!.down.map((s) => s.end?.where)).toEqual(["ghost", "planned"]);
    expect(c!.down[0].also[0]).toMatchObject({ id: "gone", end: null });
    expect(c!.down.map((s) => stepNote(s, "down"))).toEqual([
      { text: "claude · closed", tone: "dim" },
      { text: "claude · not started", tone: "dim" },
    ]);
    expect(stepNote(c!.down[0].also[0], "down")).toMatchObject({ text: "gone", tone: "blocked" });
  });

  it("attaches shared worktree terminals and context links, at either end", () => {
    const c = chain("a", { w1: wire("a", "term", "worktree"), w2: wire("b", "a", "context"), w3: wire("a", "c", "context") });
    expect(ids(c)).toEqual({ up: [], here: "a", down: [] });
    expect(c!.attached.map((x) => [x.id, x.type, x.reads])).toEqual([
      ["term", "worktree", false],
      ["b", "context", true],
      ["c", "context", false],
    ]);
  });
});

describe("stepNote", () => {
  const gates: Record<string, Gate> = {
    w1: { state: "sent", gate: "ask" },
    w2: { state: "idle", gate: "ask" },
    w3: { state: "ready", gate: "ask", pendingId: "p" },
    w4: { state: "blocked", gate: "ask", why: "needs approve" },
  };
  const links = { w1: wire("ticket", "builder"), w2: wire("builder", "reviewer"), w3: wire("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 1 } }), w4: wire("reviewer", "tester") };

  it("says what each step's wires say, as the board has it", () => {
    const c = chain("builder", links, { builder: { ...open("builder"), agent: "codex", status: "working" } }, (id) => gates[id])!;
    expect(stepNote(c.up[0], "up")).toEqual({ text: "claude · handed on", tone: "done" });
    expect(stepNote(c.here, "here")).toEqual({ text: "codex · working · you're here", tone: "here" });
    expect(stepNote(c.down[0], "down")).toEqual({ text: "changes ready · ↺ 2 of 3", tone: "ready" });
    expect(stepNote(c.down[1], "down")).toEqual({ text: "waits for approve", tone: "blocked", why: "needs approve" });
  });
});
