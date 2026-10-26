import { describe, expect, it } from "vitest";
import { councilLine, createLabel, draftProblems, mergeDrafts, moveDraft, parseTags, removeDrafts, splitPlan, updateDraft, type TicketDraft } from "../src/shared/collabTickets";

const COUNCIL = "CSV export for the donor list";
const titles = (r: { drafts: TicketDraft[] } | null) => r?.drafts.map((d) => d.title);

// the shape a Council write-up takes (collab.ts asks for goal, decisions, steps, files, risks, verification)
const WRITE_UP = `# Plan: CSV export for the donor list

## Goal
Export the donor list to CSV, respecting the user's filters, for up to 200k rows.

## Decisions
1. Stream for everyone — no background job unless timing says so.
2. Reuse the list's filter DTO.

## Steps to implement
1. **Streaming endpoint** — GET /api/donors/export.csv takes the filter DTO and streams rows (high).
   - Keyset pagination on (org_id, id)
   - Acceptance: every filter the list has is honoured
2. Page the donor query 5k rows at a time
   Memory stays flat over 200k rows.
3. Export button in the donor list toolbar (P3)
4. Spike: background export job, only if the timing check times out

## Files likely involved
- src/donors/exportCsv.ts
- src/donors/DonorList.tsx

## Risks
1. Timeouts behind the load balancer
2. Excel and UTF-8

## How to verify
- Export the biggest org's list and time it
`;

describe("splitting an approved plan into drafts, without a model", () => {
  it("takes the numbered steps of a write-up, leaving its goal, decisions, files, risks and checks out", () => {
    const r = splitPlan(WRITE_UP, { council: COUNCIL });
    expect(r?.how).toBe("steps");
    expect(titles(r)).toEqual(["Streaming endpoint", "Page the donor query 5k rows at a time", "Export button in the donor list toolbar", "Spike: background export job, only if the timing check times out"]);
    const [a, b, c, d] = r!.drafts;
    // a bold lead is the title, the rest of its line starts the detail; a priority written in is taken out of the text
    expect(a).toMatchObject({ priority: "high", tags: ["needs-agent"], acceptance: "- every filter the list has is honoured" });
    expect(a.detail).toBe(`GET /api/donors/export.csv takes the filter DTO and streams rows.\n- Keyset pagination on (org_id, id)\n\n${councilLine(COUNCIL)}`);
    expect(b.detail).toBe(`Memory stays flat over 200k rows.\n\n${councilLine(COUNCIL)}`);
    expect(b.priority).toBe("medium");
    expect(c.priority).toBe("low");
    expect(d.priority).toBe("investigate");
    expect(new Set(r!.drafts.map((x) => x.id)).size).toBe(4);
  });

  it("makes each box of a checklist a ticket", () => {
    const r = splitPlan("Do these:\n\n- [ ] Add the endpoint\n  with streaming\n- [x] Wire the button\n- [ ] Write the tests\n\n## Risks\n- [ ] not a ticket", { council: COUNCIL });
    expect(r?.how).toBe("checklist");
    expect(titles(r)).toEqual(["Add the endpoint", "Wire the button", "Write the tests"]);
    expect(r!.drafts[0].detail).toBe(`with streaming\n\n${councilLine(COUNCIL)}`);
  });

  it("makes step-like sections tickets, with their acceptance sub-sections as criteria", () => {
    const plan = "# Export\n\n## Step 1 — Streaming endpoint\nStream rows.\n\n### Acceptance\n- Filters honoured\n- 200k rows\n\n## Step 2: Export button\nIn the toolbar.\n\n## Risks\nTimeouts.";
    const r = splitPlan(plan, { council: COUNCIL });
    expect(r?.how).toBe("sections");
    expect(titles(r)).toEqual(["Streaming endpoint", "Export button"]);
    expect(r!.drafts[0].acceptance).toBe("- Filters honoured\n- 200k rows");
    expect(r!.drafts[0].detail).toBe(`Stream rows.\n\n${councilLine(COUNCIL)}`);
  });

  it("takes the sub-sections of a section about the work, but not its risks", () => {
    const plan = "## Implementation\n\n### Backend\nAn endpoint.\n\n### Frontend\nA button.\n\n### Risks\nNone.";
    expect(titles(splitPlan(plan, { council: COUNCIL }))).toEqual(["Backend", "Frontend"]);
  });

  it("finds nothing to split in prose, a single step, or lists that are only context", () => {
    expect(splitPlan("We should stream the export and measure the biggest org first. If it times out, add a job.", { council: COUNCIL })).toBeNull();
    expect(splitPlan("## Steps\n1. Do it all", { council: COUNCIL })).toBeNull();
    expect(splitPlan("## Risks\n1. Timeouts\n2. Encoding\n\n## Files\n- a.ts\n- b.ts", { council: COUNCIL })).toBeNull();
    // a numbered list inside a code block isn't structure
    expect(splitPlan("```\n1. one\n2. two\n```", { council: COUNCIL })).toBeNull();
  });

  it("uses the plan's one numbered list when no heading names the work", () => {
    expect(titles(splitPlan("First:\n\n1. Endpoint\n2. Button\n3. Tests", { council: COUNCIL }))).toEqual(["Endpoint", "Button", "Tests"]);
  });

  it("keeps a long step's first sentence as its title and the rest as detail", () => {
    const long = `${"Stream the donor list to the browser as CSV using the existing filter DTO and keyset pagination".padEnd(110, " x")}. Then more words follow here.`;
    const r = splitPlan(`## Steps\n1. ${long}\n2. Button`, { council: COUNCIL })!;
    expect(r.drafts[0].title.length).toBeLessThanOrEqual(120);
    expect(r.drafts[0].detail.startsWith("Then more words follow here.")).toBe(true);
  });
});

describe("the review's edits", () => {
  const base = (): TicketDraft[] => splitPlan(WRITE_UP, { council: COUNCIL })!.drafts;

  it("edits one draft's fields and leaves the others", () => {
    const ds = base();
    const out = updateDraft(ds, ds[1].id, { title: "Paged query", priority: "low", tags: parseTags("orgs, needs-agent  orgs") });
    expect(out[1]).toMatchObject({ title: "Paged query", priority: "low", tags: ["orgs", "needs-agent"] });
    expect(out[0]).toBe(ds[0]);
  });

  it("removes and reorders, staying in the list", () => {
    const ds = base();
    expect(removeDrafts(ds, [ds[0].id, ds[2].id]).map((d) => d.id)).toEqual([ds[1].id, ds[3].id]);
    expect(moveDraft(ds, ds[2].id, -1).map((d) => d.id)).toEqual([ds[0].id, ds[2].id, ds[1].id, ds[3].id]);
    expect(moveDraft(ds, ds[0].id, -1)).toBe(ds);
    expect(moveDraft(ds, ds[3].id, 5)).toBe(ds);
  });

  it("merges into the first chosen, where it stands: every detail and criterion, the highest priority, the council line once", () => {
    const ds = base();
    const out = mergeDrafts(ds, [ds[2].id, ds[0].id], COUNCIL);
    expect(out.map((d) => d.id)).toEqual([ds[0].id, ds[1].id, ds[3].id]);
    const m = out[0];
    expect(m.title).toBe("Streaming endpoint");
    expect(m.priority).toBe("high");
    expect(m.acceptance).toBe("- every filter the list has is honoured");
    expect(m.detail).toBe(`GET /api/donors/export.csv takes the filter DTO and streams rows.\n- Keyset pagination on (org_id, id)\n\nExport button in the donor list toolbar\n\n${councilLine(COUNCIL)}`);
    expect(m.detail.split(councilLine(COUNCIL)).length).toBe(2);
    // a question for a person wins over a hand-back to an agent
    const tagged = updateDraft(ds, ds[1].id, { tags: ["needs-human"] });
    expect(mergeDrafts(tagged, [ds[0].id, ds[1].id], COUNCIL)[0].tags).toEqual(["needs-human"]);
    expect(mergeDrafts(ds, [ds[0].id], COUNCIL)).toBe(ds);
  });

  it("says what stops a draft being sent, and the button says exactly what it creates", () => {
    const ds = base();
    const bad = updateDraft(updateDraft(ds, ds[0].id, { title: "  " }), ds[1].id, { tags: ["needs-human", "needs-agent"] });
    const p = draftProblems(bad);
    expect(p.get(ds[0].id)).toBe("needs a title");
    expect(p.get(ds[1].id)).toMatch(/both needs-human and needs-agent/);
    expect(p.has(ds[2].id)).toBe(false);
    expect(createLabel(5, "atticus-backoffice")).toBe("Create 5 tickets in atticus-backoffice");
    expect(createLabel(1, "atticus-backoffice")).toBe("Create 1 ticket in atticus-backoffice");
  });
});
