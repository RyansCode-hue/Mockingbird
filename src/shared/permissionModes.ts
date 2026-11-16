/**
 * A session's permission mode (docs/assistant.md → Permission modes): kept on its record like its model and effort,
 * and passed to its agent on every launch. `default` passes nothing, so the agent's own settings decide.
 */

export const PERMISSION_MODES = ["default", "plan", "acceptEdits", "auto", "bypass"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const isPermissionMode = (v: unknown): v is PermissionMode => typeof v === "string" && (PERMISSION_MODES as readonly string[]).includes(v);

/** What the UI and the Assistant call each mode. */
export const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = {
  default: "Ask as usual",
  plan: "Plan mode",
  acceptEdits: "Accept edits",
  auto: "Auto",
  bypass: "Bypass permissions",
};

/** Modes wider than the default: never offered to the Helpdesk workspace, and shown on a card's warnings. */
export const WIDER_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>(["acceptEdits", "auto", "bypass"]);
