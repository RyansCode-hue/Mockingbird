import { isTicketStage, stageStep, ticketOfSession, TICKET_STAGES, type AgentTold, type CommentDraft, type PipelinePr, type PipelineRequest, type PrTarget, type SessionInfo, type StoredStage, type TicketPipeline, type TicketStage } from "../shared/types";
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
  | { kind: "feedback"; label: string }
  /** Stage 6's approval (pipeline:approve): Approved, and the agent that asked for the PR to dev told to prepare main's. */
  | { kind: "approve"; label: string };

const move = (label: string, to: TicketStage, primary = true): NextStep => ({ kind: "stage", label, to, primary });

/** What each stage offers next. AI testing in dev/UAT is reached by hand here until a PR merging moves it (W16). */
const NEXT: Record<TicketStage, NextStep[]> = {
  ba: [move("Start coding", "coding")],
  coding: [move("Ready for local testing", "local-test")],
  "local-test": [{ kind: "pr", label: "Create PR to dev…", target: "dev" }],
  "pr-dev": [move("Merged — AI testing in dev/UAT", "dev-test")],
  "dev-test": [move("Ready for stakeholder testing", "stakeholder")],
  stakeholder: [{ kind: "feedback", label: "Record feedback…" }, { kind: "approve", label: "Approve" }],
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

/** "PR 4231 to dev", "#9 to main". */
export const prLabel = (pr: Pick<PipelinePr, "provider" | "id" | "target">): string => `${pr.provider === "ado" ? `PR ${pr.id}` : `#${pr.id}`} to ${pr.target}`;

/**
 * What Mark merged… asks first: it's the user's word for a merge Mockingbird can't see, and the ticket and its wires act
 * on it. It names the repository too: a ticket can have pull requests to the same target from several.
 */
export function markMergedQuestion(pr: Pick<PipelinePr, "provider" | "id" | "target" | "repo" | "closedAt" | "watch">): string {
  const why = pr.closedAt ? "Its provider says it was closed without merging." : "Mockingbird can't read whether it merged.";
  return `Mark ${prLabel(pr)}${pr.repo ? ` in ${pr.repo}` : ""} merged? ${why} The ticket moves on as for a merge, and its wires get it, saying you marked it; their gates ask before anything is sent.`;
}

/** The checklist a pull request to `target` is opened against: dev's before dev/UAT, staging's before main (request_pr's gate_notes). */
export const gateOfPr = (target: PrTarget): "dev" | "staging" => (target === "dev" ? "dev" : "staging");

/** The stages patch notes are written at (write_patch_notes' own): AI testing in staging/prod and Patch notes. */
export const notesStage = (stage: StoredStage | undefined): boolean => stage === "prod-test" || stage === "comms";

/**
 * The agent's patch notes draft (write_patch_notes) while the ticket is at a stage they're written at, or undefined: a
 * Patch notes draft an agent wrote (`by`), which the user hasn't edited (an edit makes it theirs). There's one at most:
 * a newer one replaces it.
 */
export const agentPatchNotes = (p: Pick<TicketPipeline, "drafts" | "stage">): CommentDraft | undefined =>
  notesStage(p.stage) ? (p.drafts ?? []).filter((d) => d.stage === "comms" && !!d.by).at(-1) : undefined;

/** Who heard the user's word (pipeline:approve, pipeline:request:dismiss), as main answered it: told, or why nobody was. */
export const toldLine = (t: AgentTold): string => ("told" in t ? `Told ${t.title} (${t.told}).` : t.notTold || "No agent was told.");

/**
 * Why the session that asked for a pull request (`s`, looked up among all the window's, null when it's gone) can't be
 * the one the PR form picks for the user, or null when it can: closed, a teammate's copy, taken over by a teammate,
 * or moved off the ticket (main's own reading, ticketOfSession). The user then picks the session to push from.
 */
export function askerProblem(req: Pick<PipelineRequest, "fromTitle">, ticketId: string, s: SessionInfo | null | undefined): string | null {
  const name = s?.title || req.fromTitle || "The workspace that asked";
  const why = !s
    ? "isn't open here"
    : s.room?.remote
      ? "is a teammate's copy"
      : s.room?.takenOver
        ? "was taken over by a teammate and continues on their laptop"
        : ticketOfSession(s) !== ticketId
          ? ticketOfSession(s)
            ? `is on #${ticketOfSession(s)} now`
            : "isn't on a ticket now"
          : s.status === "dead"
            ? "isn't running"
            : null;
  return why && `${name} ${why}: pick the session the pull request comes from.`;
}
