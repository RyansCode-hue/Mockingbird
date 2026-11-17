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

/** How far each mode lets an agent act without asking: plan least, bypass most. */
const MODE_RANK: Record<PermissionMode, number> = { plan: 0, default: 1, acceptEdits: 2, auto: 3, bypass: 4 };

/**
 * The mode a hook's payload reports (`permission_mode`: Claude Code fills it with its live mode, Shift+Tab and its own
 * settings' default included; Codex sends it on its turn events), as Mockingbird names it. Null for dontAsk, which
 * denies what isn't pre-approved: narrower than the default, so it never widens a session's mode. Undefined when the
 * payload names no mode Mockingbird knows, which says nothing either way.
 */
export function hookMode(raw: unknown): PermissionMode | null | undefined {
  if (raw === "bypassPermissions") return "bypass";
  if (raw === "dontAsk") return null;
  return isPermissionMode(raw) ? raw : undefined;
}

/**
 * The wider of the mode a session was launched in and the one its agent last reported (hookMode): what the Assistant's
 * wider-mode warnings and refusals go by, since a mode switched in the pane, or the agent's own default, can be wider
 * than what Mockingbird launched it with.
 */
export function widerMode(launched: PermissionMode, reported: PermissionMode | null | undefined): PermissionMode {
  return reported && MODE_RANK[reported] > MODE_RANK[launched] ? reported : launched;
}
