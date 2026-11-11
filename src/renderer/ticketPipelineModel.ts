import { isTicketStage, stageStep, TICKET_STAGES, type PipelinePr, type PrTarget, type StoredStage, type TicketStage } from "../shared/types";
import { ago, plural } from "../shared/format";

/**
 * The pipeline panel's plain logic (TicketPipeline.tsx): the rail and each
 * stage's next steps. A stage id this build doesn't know (a newer build's)
 * sits at no step and offers no next step; the rail still moves it to a stage
 * this build knows.
 */

/** A place on the rail: steps 1–8, then Done. */
export interface RailStep {
  step: number;
  /** Where a click moves the ticket: the step's first stage. */
  stage: TicketStage;
  label: string;
  state: "done" | "on" | "todo";
  /** Step 6's stage after stakeholder testing, while the ticket is at it. */
  sub: string | null;
  /** Whether a click moves the ticket: not when it's at `stage` already. Step 6 at Approved or PR to main moves it back to Stakeholder testing. */
  moves: boolean;
}

/** Each step's first stage, which names it on the rail. */
const RAIL = TICKET_STAGES.filter((s, i, all) => all.findIndex((x) => x.step === s.step) === i);

const SUB: Partial<Record<TicketStage, string>> = { approved: "approved", "pr-main": "PR to main open" };

export function railOf(stage: StoredStage | null): RailStep[] {
  const at = stage === null ? null : stageStep(stage);
  return RAIL.map((s) => ({
    step: s.step,
    stage: s.id,
    label: s.label,
    state: at === null ? "todo" : s.step < at ? "done" : s.step === at ? "on" : "todo",
    sub: s.step === at && isTicketStage(stage) ? (SUB[stage] ?? null) : null,
    moves: stage !== s.id,
  }));
}

export type NextStep =
  | { kind: "stage"; label: string; to: TicketStage; primary: boolean }
  | { kind: "pr"; label: string; target: PrTarget }
  | { kind: "feedback"; label: string };

const move = (label: string, to: TicketStage, primary = true): NextStep => ({ kind: "stage", label, to, primary });

/** What each stage offers next. AI testing in dev/UAT is reached by hand here until a PR merging moves it (W16). */
const NEXT: Record<TicketStage, NextStep[]> = {
  ba: [move("Start coding", "coding")],
  coding: [move("Ready for local testing", "local-test")],
  "local-test": [{ kind: "pr", label: "Create PR to dev…", target: "dev" }],
  "pr-dev": [move("Merged — AI testing in dev/UAT", "dev-test")],
  "dev-test": [move("Ready for stakeholder testing", "stakeholder")],
  stakeholder: [{ kind: "feedback", label: "Record feedback…" }, move("Approve", "approved")],
  approved: [{ kind: "feedback", label: "Record feedback…" }, { kind: "pr", label: "Create PR to main…", target: "main" }],
  "pr-main": [{ kind: "feedback", label: "Record feedback…" }, move("Merged — AI testing in staging/prod", "prod-test")],
  "prod-test": [move("Write patch notes", "comms")],
  comms: [move("Done", "done")],
  done: [move("Reopen", "coding", false)],
};

/** A ticket's next steps, from its stage (null: not tracked yet). */
export const nextSteps = (stage: StoredStage | null): NextStep[] =>
  stage === null ? [move("Start BA", "ba", false), move("Start coding", "coding")] : isTicketStage(stage) ? NEXT[stage] : [];

/**
 * What a pull request's row says of its merge (W16), or null while nothing's known beyond its opening: merged and when
 * (marked by the user, where they did), closed without merging, or the merge watch's failed reads; `problem` marks the
 * last two.
 */
export function prMergeNote(pr: Pick<PipelinePr, "mergedAt" | "mergedBy" | "closedAt" | "watch">, now = Date.now()): { text: string; problem: boolean } | null {
  if (pr.mergedAt) return { text: `merged ${ago(pr.mergedAt, now)}${pr.mergedBy ? ", marked by you" : ""}`, problem: false };
  if (pr.closedAt) return { text: "closed without merging", problem: true };
  if (pr.watch) return { text: `can't tell whether it merged (${plural(pr.watch.failures, "failed read")}): ${pr.watch.why}`, problem: true };
  return null;
}
