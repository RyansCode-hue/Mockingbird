import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// Editing a laid-out pipeline on the canvas, in the UI preview in real headless Chrome: local only (CI runners have no
// desktop); the script passes a mock keychain. ?landscapePipelineAudit (src/preview/pipelineAudit.ts) works laidPipeline's
// Orchestrator and its four not-started steps with the page's own events and reports what it saw and what main was asked.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

async function audit(part: string): Promise<Record<string, any>> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({
    size: "1700x1000",
    query: `motion=off&lsWires&lsPlan=pipeline&lsLaid&lsModels&landscapePipelineAudit=${part}`,
    outDir: path.join(tempDir("ls-pipeline"), "out"),
    read: `document.getElementById("mb-landscape-pipeline-audit")?.textContent ?? null`,
    limitMs: 90_000,
  });
  if (!json) throw new Error("the preview didn't finish its pipeline audit");
  const out = JSON.parse(json);
  expect(out.error).toBeUndefined();
  return out;
}

describe.skipIf(!local)("a laid-out pipeline edited on the canvas", () => {
  it("shows each step's model on a chip whose popover picks one at once, and asks before restarting a running one", async () => {
    const o = await audit("chip");
    expect(o.stepChip).toBe("gpt-5.1-codex ▾");
    expect(o.stepRows).toEqual(["Default model", "GPT-5.1 Codex", "GPT-5.1 Codex mini"]);
    expect(o.stepRestart).toBe(false);
    expect(o.stepCalls).toEqual([["pp-c1", { model: "gpt-5.1-codex-mini" }]]);
    expect(o.stepOpen).toBe(false);
    expect(o.stepChipAfter).toBe("gpt-5.1-codex-mini ▾");
    expect(o.runNote).toBe("Restarts in place, keeps its wires");
    expect(o.runOffFirst).toBe(true);
    expect(o.runCallsBefore).toBe(0);
    expect(o.runOffAfterPick).toBe(false);
    expect(o.runCalls).toEqual([["pp-orch", { model: "opus" }]]);
    expect(o.note).toMatch(/^Restarted Orchestrator with opus, its wires kept/);
  }, 120_000);

  it("edits a not-started step from its menu's Edit…, and Enter on the step opens it too", async () => {
    const o = await audit("edit");
    expect(o.menu).toEqual(expect.arrayContaining(["Edit…", "Connect…", "Insert step after…", "Re-lay out pipeline", "Start now…", "Forget it"]));
    expect(o.heading).toBe("Edit Verifier 5115");
    expect(o.nameWas).toBe("Verifier 5115");
    expect(o.promptWas).toMatch(/^Check the Coder's work/);
    expect(o.calls).toEqual([["pp-v1", { title: "Verifier 5115 – API keys", agent: "claude", model: "sonnet", effort: null, prompt: "Check the keys work against staging." }]]);
    expect(o.closed).toBe(true);
    expect(o.title).toBe("Verifier 5115 – API keys");
    expect(o.focusable).toBe(true);
    expect(o.enterHeading).toBe("Edit Coder 5110 – CSV export");
  }, 120_000);

  it("re-lays out the pipeline in stage columns from its menu, with a + between them, and Undo puts it back", async () => {
    const o = await audit("relayout");
    const a = o.after;
    expect(a["pp-orch"].x).toBeLessThan(a["pp-c1"].x);
    expect(a["pp-c1"].x).toBe(a["pp-c2"].x);
    expect(a["pp-v1"].x).toBe(a["pp-v2"].x);
    expect(a["pp-c1"].x).toBeLessThan(a["pp-v1"].x);
    expect(a["pp-orch"].y).toBe(a["pp-c1"].y);
    expect(o.note).toBe("Laid out the pipeline in #5115 along its wires");
    expect(o.gaps).toBe(4);
    expect(o.captions).toEqual(expect.arrayContaining(["Coder", "Verifier"]));
    expect(o.undone).toEqual(o.before);
  }, 120_000);

  it("inserts a step from the + between two stage columns, prefilled from the step before, and lays the pipeline out again", async () => {
    const o = await audit("insert");
    expect(o.label).toBe("Insert a step between Coder 5115 – CRM keys and Verifier 5115");
    expect(o.heading).toBe("A step between Coder 5115 – CRM keys and Verifier 5115");
    expect(o.prefill).toEqual(["Codex", "GPT-5.1 Codex", "Default effort"]);
    expect(o.calls).toEqual([[{ after: "pp-c1", before: "pp-v1", title: "Reviewer 5115", agent: "codex", model: "gpt-5.1-codex", effort: null, prompt: "" }]]);
    expect(o.drawn).toBe(true);
    expect(o.wireIntoB).toEqual({ from: "new", to: "pp-v1" });
    expect(o.intoNew).toEqual(["pp-c1"]);
    expect(o.note).toBe("Inserted Reviewer 5115. Laid out the pipeline in #5115 along its wires");
    expect(o.columns.c1).toBeLessThan(o.columns.made);
    expect(o.columns.made).toBeLessThan(o.columns.v1);
  }, 120_000);

  it("moves a wire's end with its Settings' To picker, each choice the rules refuse off, and Undo moves it back", async () => {
    const o = await audit("repoint");
    expect(o.ends).toEqual(["Orchestrator", "Coder 5115 – CRM keys"]);
    expect(o.toOptions).toEqual(expect.arrayContaining([{ label: "Coder 5110 – CSV export", off: true }, { label: "Verifier 5115", off: false }]));
    expect(o.calls).toEqual([[expect.any(String), { to: "pp-v1" }]]);
    expect(o.after).toMatchObject({ from: "pp-orch", to: "pp-v1", type: "handoff" });
    expect(o.note).toBe("Moved the wire: Orchestrator → Verifier 5115");
    expect(o.undoCalls).toBe(1);
    expect(o.undone).toMatchObject({ from: "pp-orch", to: "pp-c1" });
  }, 120_000);

  it("drags not-started steps and a closed card as workspaces are: within an area, one of two selected alone, and into another area with its group", async () => {
    const o = await audit("drag");
    // a step within its area: its place saved where it was dropped, on the grid, its group left alone, its wire on it
    expect(o.step.area).toBe("5115");
    expect(o.step.after).toEqual({ ...o.step.before, x: o.step.free.x, y: o.step.free.y });
    expect(o.step.setGroup).toEqual([]);
    expect(o.step.saves).toBe(1);
    expect(o.step.translate).toBe("");
    expect(o.step.wire).toBeLessThanOrEqual(4);
    // two selected, the one pressed dragged: it alone moves, as a workspace dragged from several picked does, and it's
    // the selection after
    expect(o.several.picked).toEqual(["pp-c2", "pp-v2"]);
    expect(o.several.v2.after).toEqual({ ...o.several.v2.before, x: o.step.before.x, y: o.step.before.y });
    expect(o.several.c2.after).toEqual(o.several.c2.before);
    expect(o.several.selected).toEqual(["pp-v2"]);
    expect(o.several.setGroup).toEqual([]);
    // the closed Spike from 5120 into 5115: its place, then its record's group, drawn there with its wire attached
    expect(o.closed.after).toEqual({ ...o.closed.before, x: o.closed.into.x, y: o.closed.into.y });
    expect(o.closed.inside).toBe(true);
    expect(o.closed.setGroup).toEqual([["wb-spike", "5115"]]);
    expect(o.closed.group).toBe("5115");
    expect(o.closed.drawnIn).toBe("5115");
    expect(o.closed.translate).toBe("");
    expect(o.closed.wire).toBeLessThanOrEqual(4);
    // a step from 5115 into 5120: the not-started step's record follows too
    expect(o.across.inside).toBe(true);
    expect(o.across.setGroup).toEqual([["pp-v1", "5120"]]);
    expect(o.across.group).toBe("5120");
    expect(o.across.drawnIn).toBe("5120");
    expect(o.across.wire).toBeLessThanOrEqual(4);
    // a click on the closed card selects the area it lies in, saving nothing
    expect(o.click).toEqual({ area: "5115", saves: 0 });
  }, 120_000);
});
