/**
 * The app Assistant's contract between main and the window (docs/assistant.md). Ask in its side bar tab (or ⌘K); the
 * tab shows the work. Main's registry fixes each tool's tier, never the model: reads run, "direct" changes run and keep
 * an Undo, "confirm" changes become cards that run only on the user's Do it.
 */

export type AssistantTier = "read" | "direct" | "confirm";

/** One tool call of a turn (or a rule run), as the tab shows it. */
export interface AssistantStep {
  id: string;
  tool: string;
  tier: AssistantTier;
  /** A plain line: "Moved 3 workspaces to atticus", "Restart api-fix in plan mode". */
  label: string;
  state: "running" | "done" | "failed" | "proposed" | "undone";
  /** failed: why, in plain words. */
  error?: string;
  /** A direct step that changed something: its Undo is offered until then (ms since epoch). */
  undoUntil?: number;
  /** A confirm step: the card it put up. */
  cardId?: string;
}

/** A change the Assistant wants to make, waiting on the user's Do it. */
export interface AssistantCard {
  id: string;
  /** The turn that proposed it. */
  turnId: string;
  tool: string;
  /** "Restart api-fix in plan mode". */
  title: string;
  /** What happens, in one or two plain sentences. */
  detail: string;
  /** What to know before saying yes: uncommitted changes, unpushed commits, mid-turn, a wider permission mode. */
  warnings: string[];
  /** Shown in the danger color: bypass permissions, deleting a worktree. */
  danger?: boolean;
  /** The text it types, sends or publishes, whole: the tab shows it as plain text, never as HTML. */
  body?: string;
  /** A standing rule's card: each of its actions as main spells it out from its arguments. */
  actions?: ActionDetail[];
  /** open: why it can't be done now (Do it stays but answers with this); null when it can. */
  blocked?: string | null;
  state: "open" | "running" | "done" | "failed" | "cancelled" | "expired";
  /** done, failed or expired: the outcome, in plain words. */
  result?: string;
  /** An open card expires then (ms since epoch), or sooner when its target changes. */
  expiresAt: number;
}

export interface AssistantTurn {
  id: string;
  at: number;
  /** The user's words, as typed. */
  text: string;
  state: "queued" | "thinking" | "done" | "error";
  /** The reply (plain text, light markdown), or what went wrong. */
  reply?: string;
  steps: AssistantStep[];
}

/** What a standing rule watches: a session, every session of a group, or any session. */
export type RuleTarget = { session: string } | { group: string } | { any: true };

/** What fires a standing rule: app state only, never text a session printed. */
export type RuleTrigger =
  /** A turn of the target ended (its agent's Stop). */
  | { kind: "finished"; target: RuleTarget }
  /** The target has waited on the user this long. */
  | { kind: "waiting"; target: RuleTarget; minutes: number }
  /** The target's process ended. */
  | { kind: "exited"; target: RuleTarget }
  /** Local time HH:MM, on these weekdays (0 = Sunday); every day when absent. */
  | { kind: "daily"; at: string; days?: number[] };

/**
 * One call as main spells it out from its validated arguments, never in the model's words: a rule's card and the
 * tab's Rules list show each action so.
 */
export interface ActionDetail {
  /** "Start Claude in atticus's checkout as it is, in “atticus”, in Plan mode, on opus". */
  line: string;
  /** The text it types or sends, whole, when the line can't hold it as it is. */
  body?: string;
  /** What to know about it: a wider permission mode, text an agent may run as a command. */
  warnings: string[];
  /** Shown in the danger color: bypass permissions. */
  danger?: boolean;
}

/** One action of a rule: a registry tool with its arguments, fixed when the rule is made, checked again each run. */
export interface RuleAction {
  tool: string;
  args: Record<string, unknown>;
  /** "Start the review session". */
  label: string;
  /** The tab's view only, never saved: main's account of it now (ActionDetail). */
  detail?: ActionDetail;
}

export interface AssistantRule {
  id: string;
  /** A plain sentence: "When tests finishes, start the review". */
  label: string;
  trigger: RuleTrigger;
  actions: RuleAction[];
  on: boolean;
  createdAt: number;
  /** Paused by Mockingbird (3 failed runs in a row, or a target that's gone): why. Cleared by turning it on again. */
  paused?: string | null;
  lastRun?: { at: number; ok: boolean; text: string } | null;
  /** The tab's view only: its off or pause holds only until Mockingbird quits, as the rules file couldn't be saved. Says so. */
  unsaved?: string;
}

/** A rule's run, in the tab. */
export interface RuleRun {
  id: string;
  ruleId: string;
  at: number;
  ok: boolean;
  /** "Started review · tests finished". */
  text: string;
  steps: AssistantStep[];
}

/** Everything the tab shows. */
export interface AssistantView {
  /** Oldest first; the last 20. */
  turns: AssistantTurn[];
  /** Open cards, then the last 20 settled ones. */
  cards: AssistantCard[];
  rules: AssistantRule[];
  /** Oldest first; the last 20. */
  runs: RuleRun[];
  /** A turn is running or queued. */
  busy: boolean;
  /** Why asking can't work on this Mac (Claude Code isn't installed); absent when it can. */
  unavailable?: string;
  /** The rules file couldn't be read as it was: why, and where it was kept. Absent when it could. */
  rulesProblem?: string;
  /** The thread's file couldn't be read (where it was kept) or saved: why. Absent when neither; Clear dismisses it. */
  threadProblem?: string;
  /** The model the next turn runs (Settings → Assistant). */
  model: AssistantModel;
}

/** The Claude models the Assistant runs on, by Claude Code's alias (Settings → Assistant). */
export type AssistantModel = "sonnet" | "opus";
export const ASSISTANT_MODELS: readonly { id: AssistantModel; label: string; note: string }[] = [
  { id: "sonnet", label: "Sonnet", note: "faster" },
  { id: "opus", label: "Opus", note: "smarter" },
];
export const DEFAULT_ASSISTANT_MODEL: AssistantModel = "sonnet";
/** The model settings choose; anything that isn't one (unset, or written by hand) is the default. */
export const assistantModelOf = (s: { assistantModel?: unknown }): AssistantModel => ASSISTANT_MODELS.find((m) => m.id === s.assistantModel)?.id ?? DEFAULT_ASSISTANT_MODEL;
/** "Sonnet", "Opus". */
export const assistantModelLabel = (m: AssistantModel): string => ASSISTANT_MODELS.find((x) => x.id === m)?.label ?? m;

/** A step only the window can carry out: going to a session, or showing the Assistant's tab. */
export type AssistantWindowAction = { kind: "focus"; sessionId: string } | { kind: "openTab" };

/** IPC channel names (preload.ts ↔ main). Every invoke answers IpcResult<…>: `{ error }` on failure. */
export const ASSISTANT_IPC = {
  /** () → AssistantView */
  view: "assistant:view",
  /** (text) → { turnId } */
  ask: "assistant:ask",
  /** (cardId) → AssistantCard */
  confirm: "assistant:confirm",
  /** (cardId) → AssistantCard */
  cancel: "assistant:cancel",
  /** (stepId) → AssistantStep */
  undo: "assistant:undo",
  /** (ruleId, on) → AssistantRule */
  ruleOn: "assistant:ruleOn",
  /** (ruleId) → { ok: true } */
  ruleRemove: "assistant:ruleRemove",
  /** () → { ok: true }: starts a fresh thread (open cards stay) */
  clear: "assistant:clear",
  /** main → window: the view changed */
  changed: "assistant:changed",
  /** main → window: AssistantWindowAction */
  window: "assistant:window",
} as const;

/** Limits (docs/assistant.md). */
export const ASSISTANT_LIMITS = {
  turnsKept: 20,
  turnsInPrompt: 8,
  maxQuestion: 4_000,
  maxReply: 8_000,
  turnTimeoutMs: 180_000,
  undoMs: 10 * 60_000,
  cardMs: 30 * 60_000,
  maxRules: 20,
  maxRuleActions: 5,
  ruleRunsPerHour: 6,
  ruleFailuresToPause: 3,
} as const;
