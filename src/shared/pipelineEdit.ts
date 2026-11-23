import type { AgentKind, SessionInfo } from "./types";

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
