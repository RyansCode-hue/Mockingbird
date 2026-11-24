import { describe, expect, it } from "vitest";
import { chainSketch, type Sketch, type SketchBox } from "../src/renderer/TemplatePicker";
import type { LayOutPlan, TemplateBody, TemplateStep, TemplateWire } from "../src/shared/pipelineTemplates";

const step = (key: string, agent: TemplateStep["agent"] = "claude", folder: TemplateStep["folder"] = "new"): TemplateStep => ({ key, name: key, agent, folder, prompt: "" });
const plan = (wires: TemplateWire[], automatic: number[] = []): LayOutPlan => ({
  steps: [],
  wires: wires.map((wire, i) => ({ wire, gate: automatic.includes(i) ? "automatic" : "ask", forced: false, afterStart: false, skipped: false, problem: null })),
  forced: 0,
  problems: [],
});

// a chip is about 16 high and, at 10.5px, about 6px a character plus its padding
const chipRect = (c: NonNullable<Sketch["paths"][number]["chip"]>) => {
  const w = c.text.length * 6 + 14;
  return { l: c.x - w / 2, r: c.x + w / 2, t: c.y, b: c.y + 16 };
};
const hits = (c: ReturnType<typeof chipRect>, b: SketchBox) => c.l < b.x + b.w && c.r > b.x && c.t < b.y + b.h && c.b > b.y;
const chipsOnBoxes = (s: Sketch) => s.paths.flatMap((p) => (p.chip ? s.boxes.filter((b) => hits(chipRect(p.chip!), b)).map((b) => `${p.chip!.text} on ${b.key}`) : []));

describe("the chain drawn small", () => {
  it("keeps a loop's chip off the steps when steps stack in a column", () => {
    // Orchestrator → Coder → Verifier, a second Verifier under the first, the first sending notes back to Coder
    const wires: TemplateWire[] = [
      { from: "orch", to: "coder", type: "handoff" },
      { from: "coder", to: "verifier", type: "handoff" },
      { from: "verifier", to: "coder", type: "feedback", rounds: 3 },
      { from: "coder", to: "security", type: "handoff" },
    ];
    const body: TemplateBody = { startFirst: true, steps: [step("orch"), step("coder", "codex"), step("verifier"), step("security")], wires };
    const s = chainSketch(body, plan(wires), 560);
    const box = (k: string) => s.boxes.find((b) => b.key === k)!;
    expect(box("security").x).toBe(box("verifier").x);
    expect(box("security").y).toBeGreaterThan(box("verifier").y);
    expect(chipsOnBoxes(s)).toEqual([]);
    // the loop between two top-row steps goes over them, inside the sketch
    const loop = s.paths.find((p) => p.kind === "feedback")!;
    expect(loop.chip!.text).toBe("↺ 3 rounds");
    expect(loop.chip!.y).toBeLessThan(box("verifier").y);
    expect(loop.chip!.y).toBeGreaterThanOrEqual(0);
  });

  it("keeps the one-row loop under the steps, its chip centred between their middles", () => {
    const wires: TemplateWire[] = [
      { from: "coder", to: "reviewer", type: "handoff" },
      { from: "reviewer", to: "coder", type: "feedback", rounds: 5 },
    ];
    const s = chainSketch({ startFirst: true, steps: [step("coder"), step("reviewer")], wires }, plan(wires), 400);
    const [coder, reviewer] = s.boxes;
    expect(coder.y).toBe(2);
    const loop = s.paths.find((p) => p.kind === "feedback")!;
    expect(loop.chip).toMatchObject({ text: "↺ 5 rounds", x: (coder.x + coder.w / 2 + reviewer.x + reviewer.w / 2) / 2 });
    expect(loop.chip!.y).toBeGreaterThan(coder.y + coder.h);
    expect(chipsOnBoxes(s)).toEqual([]);
    expect(s.h).toBeGreaterThanOrEqual(chipRect(loop.chip!).b);
  });

  it("draws a loop from a lower row under every step, clear of the terminals below", () => {
    const wires: TemplateWire[] = [
      { from: "coder", to: "a", type: "handoff" },
      { from: "coder", to: "b", type: "handoff" },
      { from: "b", to: "coder", type: "feedback" },
      { from: "a", to: "dev", type: "context" },
    ];
    const body: TemplateBody = { startFirst: true, steps: [step("coder"), step("a"), step("b"), step("dev", "terminal", { sameAs: "a" })], wires };
    const s = chainSketch(body, plan(wires, [0]), 480);
    expect(chipsOnBoxes(s)).toEqual([]);
    const agentsBottom = Math.max(...s.boxes.filter((b) => !b.terminal).map((b) => b.y + b.h));
    const loop = s.paths.find((p) => p.kind === "feedback")!;
    expect(loop.chip!.y).toBeGreaterThanOrEqual(agentsBottom);
    // an automatic handoff in the top row keeps its chip above the row below
    const auto = s.paths.find((p) => p.chip?.text === "automatic")!;
    expect(auto).toBeTruthy();
  });
});
