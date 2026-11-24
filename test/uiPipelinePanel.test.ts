import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// A pipeline's window, Save as template from it, a wire's end dragged to another step, and not-started steps selected,
// in the UI preview in real headless Chrome: local only (CI runners have no desktop); the script passes a mock keychain.
// ?landscapePanelAudit (src/preview/panelAudit.ts) works laidPipeline's Orchestrator and its four not-started steps
// with the page's own events and reports what it saw and what main was asked.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

async function audit(part: string, window = true, laid = ""): Promise<Record<string, any>> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({
    size: "1700x1000",
    query: `motion=off&lsWires&lsPlan=pipeline&lsLaid${laid ? `=${laid}` : ""}&lsModels${window ? "&focusTool=pipeline" : ""}&landscapePanelAudit=${part}`,
    outDir: path.join(tempDir("ls-panel"), "out"),
    read: `document.getElementById("mb-landscape-panel-audit")?.textContent ?? null`,
    limitMs: 90_000,
  });
  if (!json) throw new Error("the preview didn't finish its panel audit");
  const out = JSON.parse(json);
  expect(out.error).toBeUndefined();
  return out;
}

describe.skipIf(!local)("a pipeline's window", () => {
  it("opens from its area's ⋯ on its stages, in Tidy's order and words, and walks its rows with ↑ ↓ and Enter; a card's menu opens it too", async () => {
    const o = await audit("open", false);
    expect(o.head).toEqual(["Pipeline", "#5115"]);
    expect(o.relayoutInHead).toBe(true);
    expect(o.stages).toEqual([
      { word: "Orchestrator", rows: ["Orchestrator"] },
      { word: "Coder", rows: ["Coder 5115 – CRM keys", "Coder 5110 – CSV export"] },
      { word: "Verifier", rows: ["Verifier 5115", "Verifier 5110"] },
    ]);
    expect(o.tags).toEqual([null, "not started", "not started", "not started", "not started"]);
    expect(o.chips).toEqual(["Default ▾", "gpt-5.1-codex ▾", "gpt-5.1-codex ▾", "Sonnet ▾", "Sonnet ▾"]);
    expect(o.tabStops).toBe(1);
    expect(o.afterDown).toBe("pp-c1");
    expect(o.afterEnd).toBe("pp-v2");
    expect(o.enterOpened).toBe("true");
    expect(o.stepSelected).toBe(true);
    expect(o.cardMenu).toContain("Open pipeline");
    expect(o.windows).toBe(1);
  }, 120_000);

  it("changes a not-started step's model from its row's chip at once, and asks before restarting a running one", async () => {
    const o = await audit("model");
    expect(o.chip).toBe("gpt-5.1-codex ▾");
    expect(o.restart).toBe(false);
    expect(o.calls).toEqual([["pp-c2", { model: "gpt-5.1-codex-mini" }]]);
    expect(o.chipAfter).toBe("gpt-5.1-codex-mini ▾");
    expect(o.runNote).toBe("Restarts in place, keeps its wires");
    expect(o.runRestart).toBe(true);
  }, 120_000);

  it("moves a handoff from its row's picker, choices the rules refuse off, with Undo; + hand off to… adds one", async () => {
    const o = await audit("repoint");
    expect(o.selected).toBe(true);
    expect(o.ends).toEqual(["Coder 5115 – CRM keys", "Coder 5110 – CSV export"]);
    expect(o.options).toEqual(expect.arrayContaining([{ label: "Coder 5110 – CSV export", off: true }, { label: "Verifier 5115", off: false }]));
    expect(o.calls).toEqual([["pw0", { to: "pp-v1" }]]);
    expect(o.after).toMatchObject({ from: "pp-orch", to: "pp-v1", type: "handoff" });
    expect(o.note).toBe("Moved the wire: Orchestrator → Verifier 5115");
    expect(o.endsAfter).toEqual(["Verifier 5115", "Coder 5110 – CSV export"]);
    expect(o.undoCalls).toBe(1);
    expect(o.undone).toMatchObject({ from: "pp-orch", to: "pp-c1" });
    expect(o.addCalls).toEqual([["pp-v1", "pp-v2", "handoff"]]);
    expect(o.addNote).toBe("Verifier 5115 hands off to Verifier 5110 now");
    expect(o.v1Ends).toEqual(["Coder 5115 – CRM keys", "Verifier 5110"]);
  }, 120_000);

  it("edits a not-started step's prompt in its row; a running one's isn't kept, and says so folded", async () => {
    const o = await audit("prompt");
    expect(o.was).toMatch(/^Check the Coder's work against \{ticket\}/);
    expect(o.saveBefore).toBe(false);
    expect(o.calls).toEqual([["pp-v1", { prompt: "Check the keys against staging, then call finish_step." }]]);
    expect(o.saveAfter).toBe(false);
    expect(o.note).toBe("Saved Verifier 5115's prompt");
    expect(o.told).toEqual({ open: false, summary: "What it was started with", says: "Not kept once a step starts." });
    expect(o.orchEditable).toBe(false);
    expect(o.orchStart).toBe(false);
  }, 120_000);

  it("removes a step, its handoffs bridged, and Undo brings it back with its wires", async () => {
    const o = await audit("remove");
    expect(o.calls).toEqual([["pp-c2"]]);
    expect(o.ghost).toBe(false);
    expect(o.row).toBe(false);
    expect(o.note).toBe("Forgot Coder 5110 – CSV export. Orchestrator → Verifier 5110 hands off now.");
    expect(o.bridged).toBe(true);
    expect(o.undoCalls).toBe(1);
    expect(o.ghostBack).toBe(true);
    expect(o.rowBack).toBe(true);
    expect(o.undoneNote).toBe("Put it back, with its wires");
  }, 120_000);

  it("adds a step after the last one through the Edit dialog, prefilled from it, or after another between it and its handoff", async () => {
    const o = await audit("add");
    expect(o.afterDefault).toBe("Verifier 5110");
    expect(o.heading).toBe("A step after Verifier 5110");
    expect(o.prefill).toEqual(["Claude", "Sonnet (latest)", "Default effort"]);
    expect(o.calls).toEqual([[{ after: "pp-v2", before: null, title: "Docs 5110", agent: "claude", model: "sonnet", effort: null, prompt: "" }]]);
    expect(o.rows.at(-1)).toBe("Docs 5110");
    expect(o.heading2).toBe("A step between Coder 5115 – CRM keys and Verifier 5115");
  }, 120_000);

  it("saves the pipeline as a template, its stages that run once per ticket kept as steps that do, and saved again under its name offers Replace", async () => {
    const o = await audit("template");
    expect(o.drafted).toEqual([[["pp-orch", "pp-c1", "pp-v1"], { perTicket: ["pp-c1", "pp-v1"], others: ["pp-c2", "pp-v2"], orchestrator: true }]]);
    expect(o.notes[0]).toBe("“Coder” and “Verifier” run once per ticket here (#5115, #5110): kept as steps that run once per ticket, from #5115's row.");
    expect(o.notes[1]).toBe("It starts at an Orchestrator, kept as one: laid out, it starts alone, told the rest as its plan's starting shape.");
    // the rows are alike: nothing to choose
    expect(o.keep).toBeNull();
    expect(o.boxes).toEqual([
      ["Orchestrator", null],
      ["Coder 5115 – CRM keys", true],
      ["Verifier 5115", true],
    ]);
    expect(o.button).toMatch(/^Save template/);
    expect(o.saved).toEqual([["Orchestrated pair", ["Orchestrator (orchestrator)", "Coder 5115 – CRM keys (per ticket)", "Verifier 5115 (per ticket)"], ["handoff", "handoff", "feedback"]]]);
    expect(o.closed).toBe(true);
    expect(o.note).toBe("Saved the template “Orchestrated pair”: Pipeline from a ticket… lays it out");
    expect(o.replaceNote).toBe("There's a template called “Orchestrated pair” already: Replace writes over it, or name this one another way.");
    expect(o.replaceButton).toMatch(/^Replace/);
    expect(o.updated).toEqual([[true, "orchestrated pair"]]);
    expect(o.savedAgain).toBe(0);
    expect(o.list).toEqual(["orchestrated pair"]);
    expect(o.replacedNote).toBe("Replaced the template “orchestrated pair”: Pipeline from a ticket… lays it out");
  }, 120_000);

  it("offers which ticket's row to keep when they differ, drafts another chosen, and holds a step's Once per ticket box to the rules", async () => {
    const o = await audit("templaterows", true, "uneven");
    expect(o.notes.slice(0, 2)).toEqual([
      "“Coder” and “Verifier” run once per ticket here (#5115, #5110): kept as steps that run once per ticket, from #5115's row.",
      "Its tickets' rows differ: #5115's has Coder (Codex), Verifier (Claude) and Verifier (Claude); #5110's has Coder (Codex) and Verifier (Claude). It keeps #5115's, the fullest.",
    ]);
    expect(o.keep).toBe("#5115's row");
    expect(o.options).toEqual([
      { label: "#5115's row", off: false },
      { label: "#5110's row", off: false },
    ]);
    expect(o.boxes).toEqual([
      ["Orchestrator", null],
      ["Coder 5115 – CRM keys", true],
      ["Verifier 5115", true],
      ["Verifier 5115 – security", true],
    ]);
    expect(o.drafted).toEqual([[["pp-orch", "pp-c1", "pp-v1", "pp-v3"], { perTicket: ["pp-c1", "pp-v1", "pp-v3"], others: ["pp-c2", "pp-v2"], orchestrator: true }]]);
    // #5110's row drafted again in its place
    expect(o.redrafted).toEqual([["pp-orch", "pp-c2", "pp-v2"], { perTicket: ["pp-c2", "pp-v2"], others: ["pp-c1", "pp-v1", "pp-v3"], orchestrator: true }]);
    expect(o.notesAfter[1]).toBe("Its tickets' rows differ: #5115's has Coder (Codex), Verifier (Claude) and Verifier (Claude); #5110's has Coder (Codex) and Verifier (Claude). It keeps #5110's.");
    expect(o.boxesAfter).toEqual([
      ["Orchestrator", null],
      ["Coder 5110 – CSV export", true],
      ["Verifier 5110", true],
    ]);
    // run once in a folder there's one of for each ticket: refused, Save off saying why; ticked again, it can be saved
    expect(o.unticked).toEqual({
      rules: "“Verifier 5110” runs once, and “Coder 5110 – CSV export” runs once per ticket, so it has a folder for each ticket: give “Verifier 5110” a worktree of its own, or run it once per ticket too.",
      off: true,
      title: "“Verifier 5110” runs once, and “Coder 5110 – CSV export” runs once per ticket, so it has a folder for each ticket: give “Verifier 5110” a worktree of its own, or run it once per ticket too.",
    });
    expect(o.ticked).toEqual({ rules: null, off: false });
    expect(o.saved).toEqual([
      [
        ["Orchestrator", "orchestrator"],
        ["Coder 5110 – CSV export", "per ticket"],
        ["Verifier 5110", "per ticket"],
      ],
    ]);
    expect(o.closed).toBe(true);
  }, 120_000);
});

describe.skipIf(!local)("a wire's end dragged", () => {
  it("moves it onto the step it's dropped on, with Undo; Esc, and a drop on nothing, leave it where it was", async () => {
    const o = await audit("drag", false);
    expect(o.hotWhileDragging).toBe(true);
    expect(o.faintWhileDragging).toBe(true);
    expect(o.escCalls).toEqual([]);
    expect(o.faintAfter).toBe(false);
    expect(o.nothingCalls).toEqual([]);
    expect(o.calls).toEqual([["pw0", { to: "pp-v1" }]]);
    expect(o.after).toMatchObject({ from: "pp-orch", to: "pp-v1", type: "handoff" });
    expect(o.note).toBe("Moved the wire: Orchestrator → Verifier 5115");
    expect(o.undo).toBe(true);
  }, 120_000);
});

describe.skipIf(!local)("not-started steps in the selection", () => {
  it("are selected by a click with their bar, ⇧-click adds one, and a workspace clicked lets them go", async () => {
    const o = await audit("select", false);
    expect(o.selected).toEqual(["pp-c1"]);
    expect(o.bar).toBe("Coder 5115 – CRM keys: actions");
    expect(o.barKeys).toEqual(["edit", "model", "start", "insertAfter", "relayout", "forget"]);
    expect(o.barChip).toBe("gpt-5.1-codex ▾");
    expect(o.both).toEqual(["pp-c1", "pp-c2"]);
    expect(o.bar2).toBe("Selected steps");
    expect(o.bar2Text).toBe("2 steps selected");
    expect(o.bar2Keys).toEqual(["relayout", "forget"]);
    expect(o.afterWorkspace).toEqual([]);
    expect(o.workspaceSelected).toBe(true);
  }, 120_000);
});
