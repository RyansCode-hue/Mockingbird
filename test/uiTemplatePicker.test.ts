import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// An Orchestrator's plan and the built-in template (W17) in the UI preview, in real headless Chrome: local only (CI
// runners have no desktop); the script passes a mock keychain. ?landscapePlanAudit (src/preview/planAudit.ts) opens
// the plan held for #5120 (?lsWires&lsPlan) from Needs you, reads its dialog, edits it and lays it out with the mouse
// and keys pressed for real by the driver, and reports what was shown against what was sent.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

interface Shown {
  head: string | null;
  provenance: string | null;
  summary: string | null;
  notes: string[];
  steps: { key: string | null; name: string | null; agent: string | null; prompt: string; whole: boolean; flags: string[]; flows: { wire: number; text: string; whole: boolean }[] }[];
  wires: { ends: string | null; type: string | null; flags: string[] }[];
  boxes: (string | null)[];
  chips: (string | null)[];
  foot: string | null;
  act: { off: boolean; title: string | null } | null;
  dismiss: { off: boolean } | null;
  blocked: string | null;
  error: string | null;
  keyboard: boolean;
}
interface Item {
  kind: string | null;
  text: string | null;
  actions: { key: string | undefined; label: string | null; title: string | null }[];
}
interface Plan {
  summary: string;
  steps: { key: string; name: string; agent: string; folder: unknown; prompt: string; model?: string; effort?: string; repo?: string }[];
  wires: { from: string; to: string; type: string; when?: string; gate?: string; template?: string; rounds?: number }[];
}

async function audit<T>(query: string, size = "1400x1100", limitMs = 90_000): Promise<T> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({
    size,
    query: `motion=off&lsWires&${query}`,
    outDir: path.join(tempDir("ls-plan"), "out"),
    read: `document.getElementById("mb-landscape-plan-audit")?.textContent ?? null`,
    limitMs,
  });
  if (!json) throw new Error("the preview didn't finish its plan audit");
  const out = JSON.parse(json);
  expect(out.error).toBeUndefined();
  return out;
}

const flagsOf = (s: Shown, key: string) => s.steps.find((x) => x.key === key)!.flags;

describe.skipIf(!local)("an Orchestrator's plan in the template picker", () => {
  it("shows all of it, editable, and Lay out sends exactly what's shown, once", async () => {
    const t = await audit<{
      item: Item;
      early: { layOuts: number; open: boolean };
      shown: Shown;
      laid: { before: Shown; calls: number; id: string | null; sent: Plan | null; at: { area: string; room: string | null } | null; open: boolean; note: string | null; item: boolean; planned: string[]; running: string[] };
      again: { error?: string };
    }>("lsPlan&landscapePlanAudit=plan");
    // its Needs you item: Open, and Dismiss… asking for a note
    expect(t.item).toEqual({
      kind: "Plan · #5120",
      text: "Orchestrator proposes 3 workspaces · #5120",
      actions: [
        { key: "open", label: "Open", title: "Open the plan in the template picker, all of it editable: nothing is made until you lay it out" },
        { key: "dismissRequest", label: "Dismiss…", title: "Turn the plan down, with a note for its Orchestrator: nothing is made" },
      ],
    });
    // opened with a ⌘↵ and a click on Lay out straight after: neither taken, the dialog open
    expect(t.early).toEqual({ layOuts: 0, open: true });
    // who wrote it, and that the ticket it read is others' words, said as its provenance
    expect(t.shown).toMatchObject({ head: "Orchestrator's plan", provenance: "Proposed by Orchestrator's agent, which read #5120, written by others", foot: "in #5120 · 3 steps · 6 wires", act: { off: false }, blocked: null, error: null, keyboard: true });
    expect(t.shown.summary).toMatch(/^Stream the donor export in pages of 500/);
    // how old it is and that it replaced one, what redaction took out, a link, and the workspaces there already
    expect(t.shown.notes).toEqual([
      "age: Proposed 6m ago, replacing its earlier plan. Nothing of it exists until you lay it out, and any of it can be changed first.",
      // what {ticket} becomes: the title quoted as the ticket's own words
      `ticket: {ticket} in a prompt is “#5120 (its title, the ticket's own words: "Stream the donor export")”.`,
      "plan: 1 secret-looking value was replaced with [redacted] as the plan was held. Redaction is a net, not a guarantee: read it before laying it out.",
      "plan: “Verifier”'s prompt has a link: https://dev.backoffice.example/health. Check where it goes before laying it out.",
      "plan: It wires to “Tester”, “Reviewer”, which are there already.",
    ]);
    // the sketch: its Orchestrator and the workspaces there already beside its steps, the automatic gate chipped
    expect([...t.shown.boxes].sort()).toEqual(["Codercodex", "Dev server", "Orchestratorclaude", "Reviewerclaude", "Testerclaude", "Verifierclaude"]);
    expect(t.shown.chips).toEqual(["↺ 3 rounds", "automatic"]);
    // every step whole and editable: where it works, how it starts, a terminal's command flagged as one
    expect(t.shown.steps.map((s) => [s.key, s.name, s.agent, s.whole])).toEqual([
      ["coder", "Coder", "Codex", true],
      ["verifier", "Verifier", "Claude", true],
      ["dev", "Dev server", "Terminal", true],
    ]);
    expect(t.shown.steps[0].prompt).toMatch(/^Implement \{ticket\}: DonorExportController.*\(the ticket pasted one: \[redacted\]\)\..*with request_pr\.$/s);
    expect(flagsOf(t.shown, "coder")).toEqual(["where: In Orchestrator's folder, on 5120-donor-export.", "start: Starts as it's laid out, with this prompt: Lay out sends Orchestrator's handoff to it."]);
    expect(flagsOf(t.shown, "verifier")).toEqual(["where: In “Coder”'s folder.", "start: Waits, not started: it starts when Coder's handoff is sent."]);
    expect(flagsOf(t.shown, "dev")).toEqual(["where: On Orchestrator's tree.", "terminal: Runs this as a command. It's made on Orchestrator's tree as the plan is laid out."]);
    expect(t.shown.steps.find((s) => s.key === "verifier")!.flows).toEqual([{ wire: 1, text: "{pr}\n\n{summary}", whole: true }]);
    // every wire: its ends (one there already said so), type and gate; the handoff Lay out sends said as sent
    expect(t.shown.wires).toEqual([
      { ends: "Orchestrator → Coder", type: "handoff", flags: ["sent: Lay out sends it: “Coder” starts with its prompt above, and this handoff counts as sent.", "ask: After that, it asks: you send it from its gate."] },
      { ends: "Coder → Verifier", type: "handoff", flags: ["ask: Asks: you send it from its gate."] },
      { ends: "Verifier → Coder", type: "feedback", flags: ["ask: Asks: you send it from its gate."] },
      { ends: "Verifier → Tester (there already)", type: "handoff", flags: ["automatic: Sends without asking once Verifier finishes.Make it ask"] },
      // a context link says which side reads which, and whether tool output is included, with a way to leave it out
      { ends: "Reviewer (there already) → Coder", type: "context", flags: ["context: “Coder” can read “Reviewer”, its tool output included. Nothing is pushed.Include tool output"] },
      { ends: "Orchestrator → Dev server", type: "worktree", flags: [] },
    ]);
    // the Coder's prompt typed into and Make it ask pressed, then Lay out: sent once, exactly as shown
    const before = t.laid.before;
    expect(before.steps[0].prompt.endsWith("with request_pr. Keep the diff small")).toBe(true);
    expect(before.wires[3].flags).toEqual(["ask: Asks: you send it from its gate."]);
    // with the area and room it was shown in, which main checks are still so
    expect(t.laid).toMatchObject({ calls: 1, id: "pl-5120", at: { area: "5120", room: null }, open: false, item: false });
    expect(t.laid.sent!.steps.map((s) => s.prompt)).toEqual(before.steps.map((s) => s.prompt));
    expect(t.laid.sent!.steps.map((s) => s.name)).toEqual(before.steps.map((s) => s.name));
    expect(t.laid.sent!.summary).toBe(before.summary);
    expect(t.laid.sent!.wires).toEqual([
      { from: "me", to: "coder", type: "handoff" },
      { from: "coder", to: "verifier", type: "handoff", when: "pr-merged", gate: "ask" },
      { from: "verifier", to: "coder", type: "feedback", gate: "ask", rounds: 3 },
      { from: "verifier", to: "wb-tester", type: "handoff", gate: "ask" },
      { from: "wb-reviewer", to: "coder", type: "context" },
      { from: "me", to: "dev", type: "worktree" },
    ]);
    // Coder started, Verifier waiting for its handoff, Dev server made on the Orchestrator's tree, nothing there moved
    expect(t.laid.planned).toEqual(["Verifier"]);
    expect(t.laid.running.filter((x) => x === "Coder" || x === "Dev server").sort()).toEqual(["Coder", "Dev server", "Dev server"]);
    expect(t.laid.note).toBe("Laid out the plan in #5120: 3 steps, Coder started. They went where there was room in #5120, and nothing already in it moved: Tidy in its ⋯ lines them up along their wires, with Undo.");
    // the same id sent again, as a second dialog would: refused, nothing made twice
    expect(t.again).toEqual({ error: "That plan was laid out already." });
  }, 200_000);

  it("Dismiss… from the tray: the note typed, sent to its Orchestrator, nothing made", async () => {
    const t = await audit<{ opened: Shown; dismissed: { calls: unknown[][]; open: boolean; note: string | null; item: boolean; layOuts: number } }>("lsPlan&landscapePlanAudit=dismiss");
    // opened on the note, Lay out not offered while it's asked
    expect(t.opened).toMatchObject({ act: null, dismiss: { off: false } });
    expect(t.dismissed).toEqual({ calls: [["pl-5120", "Split it per endpoint"]], open: false, note: "Plan dismissed: nothing was made. Told Orchestrator (delivered, with your note).", item: false, layOuts: 0 });
  }, 200_000);

  it("a plan let go while its dialog is open: Lay out off, saying why", async () => {
    const t = await audit<{ shown: Shown; after: Shown }>("lsPlan=gone&landscapePlanAudit=gone");
    expect(t.shown).toMatchObject({ act: { off: false }, blocked: null });
    const why = "This plan isn't held any more: it was replaced, laid out or dismissed.";
    expect(t.after).toMatchObject({ act: { off: true, title: why }, blocked: why });
  }, 200_000);

  it("in a team room's area: every gate asks, said in the dialog and its foot, and sent asking", async () => {
    const t = await audit<{ shown: Shown; laid: Laid }>("lsPlan=room&landscapePlanAudit=room");
    expect(t.shown.notes).toContain("room: #5120 is a team room's area: its steps start as room sessions, under the room's guardrails, and your teammates will see them. Every gate asks.");
    expect(t.shown.notes).toContain("plan: In a team room's area every gate asks, so its automatic gate is laid out asking.");
    expect(t.shown.wires[3].flags).toEqual(["asks: It asks, not automatic. In a team room's area every gate asks."]);
    expect(t.shown.chips).toEqual(["↺ 3 rounds"]);
    expect(t.shown.foot).toBe("in #5120 · 3 steps · 6 wires · team room: gates ask");
    // Lay out sends each gate as shown: the forced one as ask, with the room it was shown in
    expect(t.laid).toMatchObject({ calls: 1, gates: [null, "ask", "ask", "ask", null, null], at: { area: "5120", room: "R5120ccccccccccccccccc" }, open: false, error: null });
  }, 200_000);

  it("its area stops being a team room's while the dialog is open: Lay out is refused, saying to reopen it", async () => {
    const t = await audit<{ shown: Shown; laid: Laid }>("lsPlan=roomgone&landscapePlanAudit=roomgone");
    expect(t.shown.foot).toBe("in #5120 · 3 steps · 6 wires · team room: gates ask");
    expect(t.laid).toMatchObject({ calls: 1, gates: [null, "ask", "ask", "ask", null, null], at: { area: "5120", room: "R5120ccccccccccccccccc" }, open: true });
    expect(t.laid.error).toBe(
      "The plan can't be laid out as it was shown: its area isn't a team room's any more, as it was when the plan was shown: its steps wouldn't be room sessions, and its gates would be as the plan says. Reopen it to see where it would go now."
    );
  }, 200_000);

  it("a newer plan proposed while it's open waits, and the dialog says so", async () => {
    const t = await audit<{ shown: Shown; after: Shown }>("lsPlan=newer&landscapePlanAudit=newer");
    expect(t.shown.notes.some((n) => n.startsWith("newer:"))).toBe(false);
    expect(t.after.notes).toContain(
      "newer: Orchestrator proposed a newer plan just now. It waits while this one is open, so your edits stay: closing this replaces it with that one; laying this one out or dismissing it keeps that one for later."
    );
    expect(t.after.act).toEqual({ off: false, title: null });
  }, 200_000);

  it("a Council's Orchestrator's plan, on no ticket: the Council named where a ticket would be, Coder → Verifier on finished, no PR-merged When offered", async () => {
    const t = await audit<{ item: Item; shown: Shown & { sections: string[]; whens: (string | null)[] }; whenOptions: string[] }>("lsPlan=council&landscapePlanAudit=council");
    expect(t.item.text).toBe("Orchestrator proposes 2 workspaces");
    expect(t.shown.provenance).toBe("Proposed by Orchestrator's agent, which read the Council's approved plan");
    expect(t.shown.sections.map((s) => s.split(":")[0])).toEqual(["Council", "Summary"]);
    expect(t.shown.sections[0]).toBe("Council: CSV export for the donor list · no ticket, so no stages, pull requests or PR-merged wires");
    expect(t.shown.wires.map((w) => [w.ends, w.type])).toEqual([
      ["Orchestrator → Coder", "handoff"],
      ["Coder → Verifier", "handoff"],
      ["Verifier → Coder", "feedback"],
    ]);
    expect(t.shown.whens).toEqual(["When it finishes", "When it finishes", "When it finishes"]);
    expect(t.whenOptions).toEqual(["When it finishes", "When you send it"]);
    expect(t.shown).toMatchObject({ act: { off: false }, blocked: null, foot: "in Council — CSV export for the donor list · 2 steps · 3 wires" });
  }, 200_000);
});

type Laid = { calls: number; gates: (string | null)[] | null; at: { area: string; room: string | null } | null; open: boolean; error: string | null; note: string | null };

describe.skipIf(!local)("the built-in Orchestrator → Coder → Verifier", () => {
  it("lays out only its Orchestrator, told the rest as its plan's starting shape", async () => {
    const t = await audit<{
      items: { t: string | null; s: string | null; sel: boolean }[];
      folded: { shut: boolean; prompt: boolean; fold: string | null }[];
      chosen: { steps: { name: string | null; agent: string | null; whole: boolean; flags: string[] }[]; foot: string | null; act: { off: boolean; title: string | null } | null };
      laid: { calls: number; first: Record<string, unknown> | null; steps: number; ticket: string | null; description: boolean; open: boolean; note: string | null; orchestrators: [string, string][]; planned: number };
    }>("landscapePlanAudit=builtin");
    // offered first, and chosen when nothing's saved
    expect(t.items).toEqual([{ t: "Orchestrator → Coder → Verifier", s: "Built in · 3 steps", sel: true }]);
    // each step folded to its line, its prompt a click away
    expect(t.folded).toEqual(Array(3).fill({ shut: true, prompt: false, fold: "Prompt" }));
    const shape = "shape: Not laid out now: the Orchestrator is told it as its plan's starting shape, and proposes the steps. Nothing more is made until you lay its plan out.";
    expect(t.chosen.steps.map((s) => [s.name, s.agent, s.whole, s.flags])).toEqual([
      ["Orchestrator", "Claude", true, ["start: An Orchestrator: it starts as it's laid out, in a worktree on the ticket's branch, reads the ticket and proposes the rest as its plan. It creates nothing and writes no code."]],
      ["Coder", "Codex", true, [shape]],
      ["Verifier", "Claude", true, [shape]],
    ]);
    expect(t.chosen).toMatchObject({ foot: "new area #5115 · worktree from origin/dev", act: { off: false } });
    // sent with its ticket's description, which main fences in the Orchestrator's kickoff
    expect(t.laid).toMatchObject({ calls: 1, steps: 3, ticket: "5115", description: true, open: false, orchestrators: [["Orchestrator", "5115"]], planned: 0 });
    expect(t.laid.first).toMatchObject({ key: "orchestrator", role: "orchestrator", agent: "claude", folder: "new" });
    expect(t.laid.note).toBe("Laid out “Orchestrator → Coder → Verifier” in #5115: Orchestrator started. It reads #5115 and proposes the rest as its plan, which comes to Needs you: nothing more is made until you lay it out.");
    expect(t.laid).toMatchObject({ more: null, tickets: [null] });
  }, 200_000);

  it("takes more tickets for its one Orchestrator, ticked on the list: the first ticked is the lead, which can be changed, all of them sent", async () => {
    const t = await audit<{
      more: { two: { ticked: (string | null)[]; foot: string | null; off: boolean | null }; swapped: (string | null)[]; back: (string | null)[]; filtered: (string | null)[] };
      laid: { calls: number; ticket: string | null; more: string[] | null; tickets: (string[] | null)[]; note: string | null };
    }>("landscapePlanAudit=builtinmany");
    const ticked = (lead: "5115" | "5110") => [`✓#5110Export donors to CSV${lead === "5110" ? "lead" : "Make lead"}`, `✓#5115Donor sync waits on the CRM's API keys${lead === "5115" ? "lead" : "Make lead"}`];
    // #5115 ticked first is the lead, its branch holding the Orchestrator's folder, as the foot says
    expect(t.more.two).toEqual({ ticked: ticked("5115"), foot: "2 tickets · Orchestrator on #5115's branch · new area #5115 · worktree from origin/dev", off: false });
    // Make lead on #5110 swaps them, and on #5115 swaps them back
    expect(t.more.swapped).toEqual(ticked("5110"));
    expect(t.more.back).toEqual(ticked("5115"));
    // a filter that matches nothing still shows what's ticked
    expect(t.more.filtered).toEqual(["5110", "5115"]);
    // laid out with both, one Orchestrator holding both
    expect(t.laid).toMatchObject({ calls: 1, ticket: "5115", more: ["5110"], tickets: [["5115", "5110"]] });
    expect(t.laid.note).toMatch(/It reads #5115 and #5110 and proposes the rest as its plan/);
  }, 200_000);
});

describe.skipIf(!local)("an Orchestrator's plan on several tickets", () => {
  it("shows every ticket and each step's own, refuses a step where another ticket's branch is, and lays each out on its ticket", async () => {
    const t = await audit<{
      shown: { provenance: string | null; tickets: (string | null)[]; on: [string | null, string | null][]; ticketNote: string | null; blocked: string | null };
      moved: { on: [string | null, string | null][]; blocked: string | null };
      laid: { calls: number; tickets: [string, string | null][] | null; made: [string, string | null, boolean][]; open: boolean };
    }>("lsPlan=tickets&landscapePlanAudit=tickets");
    expect(t.shown.provenance).toBe("Proposed by Orchestrator's agent, which read #5120, #5110, written by others");
    expect(t.shown.tickets).toEqual(["#5120 · Stream the donor export", "#5110 · Export donors to CSV"]);
    expect(t.shown.on).toEqual([
      ["coder", "On #5120"],
      ["export", "On #5110"],
      ["verifier", "On #5120"],
    ]);
    expect(t.shown.ticketNote).toMatch(/^\{ticket\} in a step's prompt names the ticket it's on/);
    expect(t.shown.blocked).toBeNull();
    expect(t.moved.blocked).toBe("“Verifier” is on #5110, and “Coder” is on #5120: a step shares only the folder of a step on its own ticket.");
    expect(t.laid).toMatchObject({
      calls: 1,
      tickets: [
        ["coder", "5120"],
        ["export", "5110"],
        ["verifier", "5120"],
      ],
      open: false,
    });
    expect(t.laid.made).toEqual([
      ["Coder", "5120", false],
      ["Export coder", "5110", false],
      ["Verifier", "5120", true],
    ]);
  }, 200_000);
});
