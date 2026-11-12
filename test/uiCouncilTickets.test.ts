import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The Council's "Create House tickets…" review in the UI preview, in real headless Chrome: local only (CI runners
// have no desktop); the script passes a mock keychain. ?councilTicketsAudit (src/preview/stub.ts) edits, merges,
// removes and reorders the approved plan's drafts as a person would, then creates them in the preview's fixture
// House (nothing reaches the real one), and reports what was on screen after each step.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type State = { rows: string[]; label: string | null; enabled: boolean; creates: number };

async function audit(query: string, size = "1400x900"): Promise<any> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({ size, query, outDir: path.join(tempDir("council-tix"), "out"), read: `document.getElementById("mb-council-tix-audit")?.textContent ?? null` });
  if (!json) throw new Error("the preview didn't finish its council tickets audit");
  return JSON.parse(json);
}

const PLAN_TITLES = ["Streaming endpoint", "Page the donor query 5k rows at a time", "Export button in the donor list toolbar", "Timing check on the largest org", "Spike: background export job, only if the timing check times out"];

describe.skipIf(!local)("reviewing an approved plan's House tickets", () => {
  it("splits the plan by its steps, takes edits, merges, removes and reorders, and creates exactly what the button says, only on its click", async () => {
    const a: Record<string, State & Record<string, any>> = await audit("motion=off&councilTicketsAudit");
    expect(a.start).toEqual({ rows: PLAN_TITLES, label: "Create 5 tickets in atticus-backoffice", enabled: true, creates: 0 });
    expect(a.edited.rows[2]).toBe("Export button in the toolbar");
    expect(a.edited.tags).toEqual(["needs-agent", "frontend"]);
    expect(a.mergeLabel).toBe("Merge 2 selected");
    expect(a.merged.rows).toEqual([PLAN_TITLES[0], PLAN_TITLES[1], "Export button in the toolbar", PLAN_TITLES[4]]);
    expect(a.merged.detail).toMatch(/^Timing check on the largest org\n\nFrom the Council discussion “CSV export for the donor list”\.$/);
    expect(a.merged.acceptance).toBe("- a note with the timing on the ticket");
    expect(a.removed.rows).toEqual([PLAN_TITLES[0], PLAN_TITLES[1], "Export button in the toolbar"]);
    expect(a.moved).toMatchObject({ rows: [PLAN_TITLES[0], "Export button in the toolbar", PLAN_TITLES[1]], label: "Create 3 tickets in atticus-backoffice", creates: 0 });

    // one click, the drafts as reviewed
    expect(a.created.sent).toEqual([
      [
        { title: PLAN_TITLES[0], priority: "high", tags: ["needs-agent"] },
        { title: "Export button in the toolbar", priority: "medium", tags: ["needs-agent", "frontend"] },
        { title: PLAN_TITLES[1], priority: "high", tags: ["needs-agent"] },
      ],
    ]);
    expect(a.created.result).toBe(`Created in atticus-backoffice (room #5101 Org dropdowns remember the last org): #160 ${PLAN_TITLES[0]} · #161 Export button in the toolbar · #162 ${PLAN_TITLES[1]}`);
    expect(a.created.links).toEqual(["#160", "#161", "#162"]);
    expect(a.created.note).toBe(true);
    expect(a.created.rows).toEqual([]);
  });

  it("asks before using the token, and keeps what the House refused and what wasn't sent", async () => {
    const a: Record<string, State & Record<string, any>> = await audit("motion=off&councilTicketsAudit=consent&councilTicketsFail");
    expect(a.start).toMatchObject({ enabled: false, creates: 0 });
    expect(a.consentAsk).toBe("Use your atticus-backoffice builder token for room #5101 Org dropdowns remember the last org?");
    expect(a.allowed).toMatchObject({ enabled: true, asking: false, creates: 0 });
    expect(a.created.links).toEqual(["#160"]);
    expect(a.created.result).toMatch(/^Created in atticus-backoffice .*: #160 Streaming endpoint "Export button in the toolbar" wasn't created: The House answered 422: A work item titled like that already exists — and 1 after it weren't sent\. They're still here to try again\.$/);
    expect(a.created).toMatchObject({ rows: ["Export button in the toolbar", PLAN_TITLES[1]], label: "Create 2 tickets in atticus-backoffice", enabled: true });
  });
});

describe.skipIf(!local)("an approved plan's Orchestrator, in the Council's panel", () => {
  /** The panel's implement button, or its Open once the Orchestrator has started: its words and title. */
  async function button(query: string): Promise<{ text: string; title: string }> {
    // @ts-expect-error — a plain .mjs build script, no type declarations
    const { pageResult } = await import("../scripts/ui-preview.mjs");
    const json: string | null = await pageResult({
      size: "1400x900",
      query: `motion=off&${query}`,
      outDir: path.join(tempDir("council-orch"), "out"),
      read: `(() => { const b = document.querySelector(".council-implement, .council-orch-open"); return b ? JSON.stringify({ text: b.textContent.trim(), title: b.title }) : null; })()`,
    });
    if (!json) throw new Error("the preview didn't show the Council's plan");
    return JSON.parse(json);
  }

  it("offers to implement it through an Orchestrator, and once started, to open it", async () => {
    expect(await button("councilPlan")).toEqual({
      text: "Implement via Orchestrator ▾",
      title: "Start an Orchestrator with the model you pick, on a new branch in its own worktree: it reads the plan and the code, and proposes the workspaces to build it. Nothing more is made until you lay its plan out.",
    });
    expect(await button("councilPlan=open")).toEqual({ text: "Open the Orchestrator", title: "The plan's Orchestrator, in its Council's own area on the landscape" });
  });
});
