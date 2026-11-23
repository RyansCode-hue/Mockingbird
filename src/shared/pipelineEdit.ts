import type { AgentKind, SessionInfo } from "./types";
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

/** What Save as template keeps of a pipeline (pipelineTemplateOf), for templates:draft to make the template of. */
export interface PipelineTemplatePlan {
  /** Its steps' sessions, stage by stage: what the draft keeps, with the wires among them. */
  ids: string[];
  /** It starts at an Orchestrator, which the template keeps as one (asOrchestrated). */
  orchestrator: boolean;
  /** What the template can't hold as the pipeline has it, said in the dialog. */
  simplified: string[];
}

type StageStep = Pick<SessionInfo, "id" | "title" | "ticketId" | "role">;

/**
 * A pipeline's stages (pipelineStages) as a template keeps them, as nearly as the template format can: its steps in
 * stage order, and the wires among them (feedback and context links too) follow in the draft. A template is laid out
 * for one ticket, so a stage that runs once per ticket (an Orchestrator's steps on several tickets) keeps one ticket's
 * step: the ticket the first such stage's first step is on, followed through the stages after it. A first stage that's
 * an Orchestrator alone is kept as one (laid out, it starts alone and proposes the rest). Each change is said.
 */
export function pipelineTemplateOf(stages: readonly { word: string; steps: readonly StageStep[] }[]): PipelineTemplatePlan {
  let ticket: string | null = null;
  const ids: string[] = [];
  const fanned: string[] = [];
  const left: string[] = [];
  const tickets = new Set<string>();
  for (const st of stages) {
    const on = new Set(st.steps.map((s) => s.ticketId ?? ""));
    if (st.steps.length < 2 || on.size < 2) {
      ids.push(...st.steps.map((s) => s.id));
      continue;
    }
    ticket ??= st.steps[0].ticketId ?? "";
    const kept = st.steps.filter((s) => (s.ticketId ?? "") === ticket);
    const keep = kept.length ? kept : [st.steps[0]];
    ids.push(...keep.map((s) => s.id));
    fanned.push(st.word);
    for (const s of st.steps) {
      if (s.ticketId) tickets.add(s.ticketId);
      if (!keep.includes(s)) left.push(s.title);
    }
  }
  const simplified: string[] = [];
  if (fanned.length) {
    const named = fanned.map((w) => `“${w}”`).join(" and ");
    const list = [...tickets].map((t) => `#${t}`).join(", ");
    simplified.push(`${named} ${fanned.length === 1 ? "runs" : "run"} once per ticket here (${list}): a template is laid out for one ticket, so it keeps ${ticket ? `#${ticket}'s` : "one"}. Left out: ${left.join(", ")}.`);
  }
  const first = stages[0]?.steps;
  const orchestrator = first?.length === 1 && first[0].role === "orchestrator";
  if (orchestrator) simplified.push("It starts at an Orchestrator, kept as one: laid out, it starts alone, told the rest as its plan's starting shape.");
  return { ids, orchestrator, simplified };
}

/**
 * A draft's body with its first step an Orchestrator (TemplateStep.role), as pipelineTemplateOf says: in a worktree of
 * its own and started as it's laid out, which an Orchestrator always is.
 */
export function asOrchestrated(body: TemplateBody): TemplateBody {
  const [first, ...rest] = body.steps;
  if (!first || first.agent === "terminal") return body;
  return { ...body, startFirst: true, steps: [{ ...first, role: "orchestrator", folder: "new" }, ...rest] };
}
