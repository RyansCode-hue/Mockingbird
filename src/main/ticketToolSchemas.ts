import { GATES } from "../shared/types";

/**
 * The agents' ticket tools as the MCP server lists them (docs/landscape-wires.md, W14). Kept apart from ticketTools.ts,
 * which answers them, as wireToolSchemas.ts is: messaging.ts builds the server's script from these and agents.ts
 * allows them, and neither may wait on what ticketTools.ts imports.
 *
 * Each acts on the caller's own ticket, which no argument names. set_stage writes the ticket's stage, within the
 * refusals in pipeline.ts' stageRefusal; request_pr and write_patch_notes hold records the user's click acts on. None
 * pushes, opens a pull request or posts to Azure DevOps.
 */

export const TICKET_TOOL = {
  setStage: "set_stage",
  requestPr: "request_pr",
  writePatchNotes: "write_patch_notes",
} as const;

export type TicketTool = (typeof TICKET_TOOL)[keyof typeof TICKET_TOOL];

const NAMES: readonly string[] = Object.values(TICKET_TOOL);
export const isTicketTool = (op: unknown): op is TicketTool => typeof op === "string" && NAMES.includes(op);

/** How long patch notes may be. */
export const PATCH_NOTES_MAX = 4000;
/** How long a pull request's title and description may be, as an agent writes them. */
export const PR_TITLE_MAX = 200;
export const PR_DESCRIPTION_MAX = 8000;
/** How long set_stage's note may be. */
export const STAGE_NOTE_MAX = 4000;
/** How long one gate item's note may be. */
export const GATE_NOTE_MAX = 1000;

/** What patch notes are, in the words the window's Write patch notes (pipeline:comms) asks its agent for too. */
export const PATCH_NOTES_GUIDANCE = "Plain language, no internal jargon, branch names or ticket numbers; 3 to 6 sentences: what changed, who it affects, and anything they need to do.";

/** Every gate item as gate_notes names it, "<gate>:<item>", and those that record a person's act, which no agent ticks. */
export const GATE_ITEM_KEYS: readonly string[] = GATES.flatMap((g) => g.items.map((i) => `${g.id}:${i.key}`));
export const PERSON_GATE_ITEMS: readonly string[] = GATES.flatMap((g) => g.items.filter((i) => i.person).map((i) => `${g.id}:${i.key}`));

/** The stages set_stage can ever move a ticket to: the rest are the user's, a PR's opening or its merge. */
export const AGENT_STAGES = ["coding", "local-test", "stakeholder", "comms"] as const;

const gateNotes = (which: string) => ({
  type: "array",
  maxItems: GATE_ITEM_KEYS.length,
  description:
    `Your report against ${which}: for each item, what you did and its evidence (the command and what it gave, the file). ` +
    "done: true ticks it, marked as your tick; the user can untick it. " +
    `Items that record a person's act (${PERSON_GATE_ITEMS.join(", ")}) can't be ticked by an agent: say in note what's ready for them.`,
  items: {
    type: "object",
    properties: {
      item: { type: "string", enum: GATE_ITEM_KEYS, description: "The checklist item, <gate>:<item>" },
      note: { type: "string", description: `What you did for it, and the evidence: at most ${GATE_NOTE_MAX} characters` },
      done: { type: "boolean", description: "true when you've done the item: it's ticked as yours" },
    },
    required: ["item", "note"],
    additionalProperties: false,
  },
});

export const TICKET_TOOL_SCHEMAS = [
  {
    name: TICKET_TOOL.setStage,
    description:
      "Move this workspace's ticket on Mockingbird's ticket pipeline (always this workspace's own ticket). Forward one step at a time: " +
      "Coding to local-test when the work is done and committed; AI testing in dev/UAT to stakeholder once you've tested it there; " +
      "AI testing in staging/prod to comms (patch notes) once that passes. Or back to coding, with note saying the feedback that sends it back. " +
      "Approving stakeholder testing, Done, and the PR and merge stages are the user's or the provider's: ask for a pull request with request_pr. " +
      "Mockingbird drafts the stage's comment for the ticket; only the user posts it. It answers at once.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        stage: { type: "string", enum: AGENT_STAGES, description: "The stage to move it to" },
        note: { type: "string", description: `Why: required when sending it back to coding, the feedback that does. At most ${STAGE_NOTE_MAX} characters` },
        gate_notes: gateNotes("the checklist of the stage it's at or moves to"),
      },
      required: ["stage"],
      additionalProperties: false,
    },
  },
  {
    name: TICKET_TOOL.requestPr,
    description:
      "Ask the user to open a pull request for this workspace's ticket: to dev from Coding or Local testing, to main once the user has approved stakeholder testing. " +
      "Commit your work first. Mockingbird holds the request with your title and description; the user reviews and edits them, and Mockingbird pushes the branch " +
      "and opens the pull request only at their click. This tool pushes nothing and opens nothing. A newer request for the same target replaces the older. " +
      "Secret-looking values are replaced with [redacted]. It answers at once.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["dev", "main"], description: "Where it merges: dev (dev/UAT) or main" },
        title: { type: "string", description: `The pull request's title, one line: at most ${PR_TITLE_MAX} characters` },
        description: { type: "string", description: `Its description, in Markdown: what changed and how it was tested. At most ${PR_DESCRIPTION_MAX} characters` },
        gate_notes: gateNotes("the checklist before that pull request (dev: the dev/UAT gate; main: the staging gate)"),
      },
      required: ["target", "title", "description"],
      additionalProperties: false,
    },
  },
  {
    name: TICKET_TOOL.writePatchNotes,
    description:
      "Write the patch notes for this workspace's ticket, at AI testing in staging/prod or Patch notes: a short announcement for the people who use the system. " +
      `${PATCH_NOTES_GUIDANCE} Mockingbird keeps it as the ticket's patch notes draft, marked as yours, replacing an earlier agent's; the user reads it and posts it. ` +
      "Secret-looking values are replaced with [redacted], and text holding a private key is refused. It answers at once.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: `The patch notes: at most ${PATCH_NOTES_MAX} characters` },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];
