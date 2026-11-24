import { AGENT_NAME, ticketIdOf, type AgentKind, type SessionInfo } from "./types";
import type { TemplateBody } from "./pipelineTemplates";

/** What a step inserted next to sessions takes from them when its spec doesn't say: its agent, model and effort. */
export interface StepDefaults {
  agent: AgentKind;
  model: string | null;
  effort: string | null;
}

/**
 * A step inserted after `a` and ahead of `b` (either may be missing) runs as the step before it does, else as the one
 * after it, as a template's new step keeps its neighbour's agent: the same agent, model and effort. A terminal
 * neighbour has none to give, so Claude at its defaults.
 */
export function insertDefaults(a: Pick<SessionInfo, "agent" | "model" | "effort" | "shell"> | null | undefined, b?: Pick<SessionInfo, "agent" | "model" | "effort" | "shell"> | null): StepDefaults {
  const from = [a, b].find((s) => s && !s.shell);
  return { agent: from?.agent ?? "claude", model: from?.model ?? null, effort: from?.effort ?? null };
}

/** A model's short name for a card's chip: "opus" as "Opus", "claude-sonnet-4-5[1m]" as "Sonnet 4.5", "gpt-5.1-codex" as is. */
export function modelChipText(model: string | null | undefined, label?: string | null): string {
  if (!model) return "Default";
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(model);
  if (claude) return `${cap(claude[1])} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}${claude[4] ? " 1M" : ""}`;
  if (/^[a-z]+$/.test(model)) return cap(model);
  return label?.replace(/ \(latest\)$/, "") || model;
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** One ticket's steps in a pipeline's stages that run once per ticket (pipelineTemplateOf): its row, as Tidy lays it out. */
export interface TicketRow {
  /** Its ticket's id; "" for steps on none. */
  ticket: string;
  /** Its steps by stage and agent, as the dialog says them: "Coder (Codex) and Verifier (Claude)". */
  says: string;
  size: number;
}

/** What Save as template keeps of a pipeline (pipelineTemplateOf), for templates:draft to make the template of. */
export interface PipelineTemplatePlan {
  /** Its steps' sessions, stage by stage: what the draft keeps, with the wires among them. */
  ids: string[];
  /** It starts at an Orchestrator, which the template keeps as one (asOrchestrated). */
  orchestrator: boolean;
  /** What the template can't hold as the pipeline has it, said in the dialog. */
  simplified: string[];
  /** Of `ids`, those that run once per ticket (DraftShape.perTicket): the kept row's. */
  perTicket: string[];
  /** The other tickets' rows' steps, which the kept row's stand for (DraftShape.others). */
  others: string[];
  /** Each ticket's row, in the order they first show; none when no stage runs once per ticket. */
  rows: TicketRow[];
  /** Whether the rows differ (different steps): then which one is kept is a choice, said and offered. */
  differ: boolean;
  /** The row kept; null with none. */
  ticket: string | null;
}

type StageStep = Pick<SessionInfo, "id" | "title" | "ticketId" | "role" | "agent">;

const listed = (xs: readonly string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : (xs[0] ?? ""));
/** A row's ticket as said: "#5115", or for steps on no ticket, "no ticket". */
const rowName = (t: string) => (t ? `#${t}` : "no ticket");

/**
 * A pipeline's stages (pipelineStages) as a template keeps them: its steps in stage order, and the wires among them
 * (feedback and context links too) follow in the draft. A stage of two or more steps on two or more tickets runs once
 * per ticket (an Orchestrator's steps on several tickets): each ticket's steps across such stages are its row, and the
 * template keeps one row as steps that run once per ticket (TemplateStep.perTicket), its wires to the stages that run
 * once fanning out and in again as it's laid out. The row kept is `ticket`'s, else the fullest (the first of those);
 * when rows differ, which was kept is said. A first stage that's an Orchestrator alone is kept as one (laid out, it
 * starts alone and proposes the rest). Throws when `ticket` has no row.
 */
export function pipelineTemplateOf(stages: readonly { word: string; steps: readonly StageStep[] }[], ticket?: string | null): PipelineTemplatePlan {
  const tk = (s: StageStep) => s.ticketId ?? "";
  const fans = stages.map((st) => st.steps.length > 1 && new Set(st.steps.map(tk)).size > 1);
  const order = [...new Set(stages.flatMap((st, i) => (fans[i] ? st.steps.map(tk) : [])))];
  const rows = order.map((t) => {
    const mine = stages.flatMap((st, i) => (fans[i] ? st.steps.filter((s) => tk(s) === t).map((s) => ({ i, word: st.word, agent: s.agent ?? "claude" })) : []));
    return { ticket: t, says: listed(mine.map((m) => `${m.word} (${AGENT_NAME[m.agent]})`)), size: mine.length, sig: mine.map((m) => `${m.i}:${m.agent}`).sort().join() };
  });
  const differ = new Set(rows.map((r) => r.sig)).size > 1;
  const asked = ticket === undefined || ticket === null ? null : ticketIdOf(ticket.trim());
  if (asked !== null && !rows.some((r) => r.ticket === asked))
    throw new Error(rows.length ? `${rowName(asked)} has no row in this pipeline: its rows are ${listed(rows.map((r) => rowName(r.ticket)))}.` : "No stage of this pipeline runs once per ticket, so it has no rows to choose from.");
  const kept = asked ?? (rows.length ? rows.reduce((a, b) => (b.size > a.size ? b : a)).ticket : null);
  const ids: string[] = [];
  const perTicket: string[] = [];
  const others: string[] = [];
  stages.forEach((st, i) => {
    if (!fans[i]) return void ids.push(...st.steps.map((s) => s.id));
    for (const s of st.steps) (tk(s) === kept ? [ids, perTicket] : [others]).forEach((into) => into.push(s.id));
  });
  const simplified: string[] = [];
  if (rows.length) {
    const words = stages.filter((_st, i) => fans[i]).map((st) => `“${st.word}”`);
    simplified.push(`${listed(words)} ${words.length === 1 ? "runs" : "run"} once per ticket here (${order.filter(Boolean).map((t) => `#${t}`).join(", ")}): kept as steps that run once per ticket, from ${rowName(kept!)}'s row.`);
  }
  if (differ) simplified.push(`Its tickets' rows differ: ${rows.map((r) => `${rowName(r.ticket)}'s has ${r.says}`).join("; ")}. It keeps ${rowName(kept!)}'s${asked === null ? ", the fullest" : ""}.`);
  const first = stages[0]?.steps;
  const orchestrator = first?.length === 1 && first[0].role === "orchestrator";
  if (orchestrator) simplified.push("It starts at an Orchestrator, kept as one: laid out, it starts alone, told the rest as its plan's starting shape.");
  return { ids, orchestrator, simplified, perTicket, others, rows: rows.map(({ sig: _sig, ...r }) => r), differ, ticket: kept };
}

/**
 * A draft's body with its first step an Orchestrator (TemplateStep.role), as pipelineTemplateOf says: in a worktree of
 * its own and started as it's laid out, which an Orchestrator always is; once, as it plans for every ticket.
 */
export function asOrchestrated(body: TemplateBody): TemplateBody {
  const [first, ...rest] = body.steps;
  if (!first || first.agent === "terminal") return body;
  const { perTicket: _once, ...step } = first;
  return { ...body, startFirst: true, steps: [{ ...step, role: "orchestrator", folder: "new" }, ...rest] };
}
