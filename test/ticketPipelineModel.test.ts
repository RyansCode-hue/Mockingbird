import { describe, expect, it } from "vitest";
import { stageLabel, stageStep, TICKET_STAGES, type TicketStage } from "../src/shared/types";
import { nextSteps, railOf, type NextStep } from "../src/renderer/ticketPipelineModel";

const said = (steps: NextStep[]) =>
  steps.map((n) => (n.kind === "stage" ? `${n.label} → ${n.to}${n.primary ? "" : " (outline)"}` : n.kind === "pr" ? `${n.label} (PR form, ${n.target})` : `${n.label} (feedback form)`));

describe("the ticket stages", () => {
  it("are the table's, in order, with their rail steps", () => {
    expect(TICKET_STAGES.map((s) => [stageStep(s.id), s.id, stageLabel(s.id)])).toEqual([
      [1, "ba", "BA"],
      [2, "coding", "Coding"],
      [3, "local-test", "Local testing"],
      [4, "pr-dev", "PR to dev"],
      [5, "dev-test", "AI testing in dev/UAT"],
      [6, "stakeholder", "Stakeholder testing"],
      [6, "approved", "Approved"],
      [6, "pr-main", "PR to main"],
      [7, "prod-test", "AI testing in staging/prod"],
      [8, "comms", "Patch notes"],
      [9, "done", "Done"],
    ]);
  });
});

describe("the pipeline panel's rail", () => {
  it("has steps 1–8 and Done, each moving the ticket to its step's first stage", () => {
    expect(railOf(null).map((r) => [r.step, r.label, r.stage, r.state])).toEqual([
      [1, "BA", "ba", "todo"],
      [2, "Coding", "coding", "todo"],
      [3, "Local testing", "local-test", "todo"],
      [4, "PR to dev", "pr-dev", "todo"],
      [5, "AI testing in dev/UAT", "dev-test", "todo"],
      [6, "Stakeholder testing", "stakeholder", "todo"],
      [7, "AI testing in staging/prod", "prod-test", "todo"],
      [8, "Patch notes", "comms", "todo"],
      [9, "Done", "done", "todo"],
    ]);
  });
  it("marks the ticket's step, the ones before it done, and says which part of 6 it's at", () => {
    const at = (stage: TicketStage) => {
      const rail = railOf(stage);
      return { on: rail.filter((r) => r.state === "on").map((r) => r.step), done: rail.filter((r) => r.state === "done").length, sub: rail.find((r) => r.sub)?.sub ?? null };
    };
    expect(Object.fromEntries(TICKET_STAGES.map((s) => [s.id, at(s.id)]))).toEqual({
      ba: { on: [1], done: 0, sub: null },
      coding: { on: [2], done: 1, sub: null },
      "local-test": { on: [3], done: 2, sub: null },
      "pr-dev": { on: [4], done: 3, sub: null },
      "dev-test": { on: [5], done: 4, sub: null },
      stakeholder: { on: [6], done: 5, sub: null },
      approved: { on: [6], done: 5, sub: "approved" },
      "pr-main": { on: [6], done: 5, sub: "PR to main open" },
      "prod-test": { on: [7], done: 6, sub: null },
      comms: { on: [8], done: 7, sub: null },
      done: { on: [9], done: 8, sub: null },
    });
  });
  it("moves the ticket from every step but the stage it's at, so step 6 takes Approved and PR to main back to Stakeholder testing", () => {
    const still = (stage: TicketStage | null) => railOf(stage).filter((r) => !r.moves).map((r) => r.stage);
    expect(Object.fromEntries(TICKET_STAGES.map((s) => [s.id, still(s.id)]))).toEqual({
      ba: ["ba"],
      coding: ["coding"],
      "local-test": ["local-test"],
      "pr-dev": ["pr-dev"],
      "dev-test": ["dev-test"],
      stakeholder: ["stakeholder"],
      approved: [],
      "pr-main": [],
      "prod-test": ["prod-test"],
      comms: ["comms"],
      done: ["done"],
    });
    expect(railOf("approved").find((r) => r.step === 6)).toMatchObject({ state: "on", stage: "stakeholder", moves: true });
    expect(still(null)).toEqual([]);
  });
  it("marks no step for a stage id this build doesn't know, and moves it from any", () => {
    expect(railOf("uat-signoff").every((r) => r.state === "todo" && r.sub === null && r.moves)).toBe(true);
  });
  it("never throws on a stage the file holds as something other than text", () => {
    for (const odd of [5, null, { id: "x" }, ["coding"]] as unknown as string[]) {
      expect(stageLabel(odd)).toBe(String(odd));
      expect(railOf(odd).filter((r) => r.state !== "todo")).toEqual([]);
    }
    expect(nextSteps({ id: "x" } as unknown as string)).toEqual([]);
  });
});

describe("the pipeline panel's next steps", () => {
  it("are each stage's, as the table moves them", () => {
    expect(Object.fromEntries(TICKET_STAGES.map((s) => [s.id, said(nextSteps(s.id))]))).toEqual({
      ba: ["Start coding → coding"],
      coding: ["Ready for local testing → local-test"],
      "local-test": ["Create PR to dev… (PR form, dev)"],
      "pr-dev": ["Merged — AI testing in dev/UAT → dev-test"],
      "dev-test": ["Ready for stakeholder testing → stakeholder"],
      stakeholder: ["Record feedback… (feedback form)", "Approve → approved"],
      approved: ["Record feedback… (feedback form)", "Create PR to main… (PR form, main)"],
      "pr-main": ["Record feedback… (feedback form)", "Merged — AI testing in staging/prod → prod-test"],
      "prod-test": ["Write patch notes → comms"],
      comms: ["Done → done"],
      done: ["Reopen → coding (outline)"],
    });
  });
  it("start an untracked ticket at BA or Coding", () => {
    expect(said(nextSteps(null))).toEqual(["Start BA → ba (outline)", "Start coding → coding"]);
  });
  it("offer nothing at a stage id this build doesn't know", () => {
    expect(nextSteps("uat-signoff")).toEqual([]);
  });
});
