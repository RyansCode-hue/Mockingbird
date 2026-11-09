/**
 * The ticket pipeline's types as Mockingbird 1.6.0 had them: lines 968–1021 of src/shared/types.ts at 4907cc3,
 * unchanged, for the compatibility tests (pipeline.test.ts). Never edited to match today's stages: differing from
 * them is what it's here for.
 */
// ---- ticket pipeline ----------------------------------------------------------
// Where each ticket actually is, kept locally (~/.mockingbird/pipeline.json):
// nothing reaches Azure DevOps except comments and pull requests the user
// approves one by one.

export const TICKET_STAGES = [
  { id: "ba", label: "BA" },
  { id: "coding", label: "Coding" },
  { id: "local-test", label: "Local testing" },
  { id: "pr-dev", label: "PR to dev" },
  { id: "stakeholder", label: "Stakeholder testing" },
  { id: "approved", label: "Approved" },
  { id: "pr-main", label: "PR to main" },
  { id: "prod-test", label: "Staging / prod" },
  { id: "comms", label: "Comms" },
  { id: "done", label: "Done" },
] as const;
export type TicketStage = (typeof TICKET_STAGES)[number]["id"];
export const stageLabel = (s: TicketStage): string => TICKET_STAGES.find((x) => x.id === s)?.label ?? s;

export type PrTarget = "dev" | "main";

export interface PipelinePr {
  target: PrTarget;
  provider: "ado" | "github";
  id: number;
  url: string;
  repo: string;
  branch: string;
  base: string;
  at: number;
  /** The Summary section of its description, for the ticket comment and the comms draft. */
  summary?: string;
}

/** A comment drafted when a ticket reaches a stage; it posts to ADO only when the user clicks Post. */
export interface CommentDraft {
  id: string;
  stage: TicketStage;
  text: string;
  at: number;
}

export interface TicketPipeline {
  ticketId: string;
  title?: string;
  stage: TicketStage;
  history: { at: number; stage: TicketStage; note?: string }[];
  prs: PipelinePr[];
  feedback: { at: number; text: string }[];
  drafts: CommentDraft[];
  /** Promotion-gate checklist ticks, keyed "<gate>:<item>". */
  checks: Record<string, boolean>;
}
