import { PERMISSION_MODE_LABEL, WIDER_MODES } from "../../../shared/permissionModes";
import { plainLine, quoted } from "../../../shared/team/agentText";
import type { AssistantDeps, AssistantSession } from "../deps";
import type { JsonSchema } from "../registry";

/** A tool argument naming a session: by id alone, so a card or an Undo can't come to mean another session by its title. */
export const SESSION_ARG: JsonSchema = { type: "string", minLength: 1, maxLength: 80, description: "The session's id, from the snapshot or list_sessions" };

/** The session `id` names, or null. */
export function sessionById(d: Pick<AssistantDeps, "sessions">, id: string): AssistantSession | null {
  return d.sessions().find((s) => s.id === id) ?? null;
}

/** Why there's no session `id` to act on. */
export const noSession = (id: string): string => `There's no session with id ${quoted(id, 80)}: the ids are in the snapshot and list_sessions`;

/** A session's title as a step's line names it. */
export const titleOf = (s: AssistantSession | null, id: string): string => (s ? `“${s.title}”` : quoted(id, 80));

/** Why this Mac can't act on `s` because it's a teammate's, or null when it's this Mac's own. */
export const teammates = (s: AssistantSession, what: string): string | null =>
  s.mine ? null : `${titleOf(s, s.id)} is ${s.owner ? `${s.owner}'s` : "a teammate's"} session: only its owner can ${what}`;

/** A card's Do it refused because what it would run now isn't what the card showed (a plan read again since). */
export const CHANGED_SINCE_CARD = "It changed since the card: ask again";

/** "“api-fix” · s5 · atticus": a title, an id and where it is, each left out when there's none. */
export const refLine = (title: string | null, id: string, where: string | null): string =>
  [title === null ? null : `“${plainLine(title, 120)}”`, plainLine(id, 80), where ? plainLine(where, 120) : null].filter(Boolean).join(" · ");

const folderName = (p: string | null | undefined): string | null => (p ? (p.split("/").filter(Boolean).pop() ?? null) : null);

/**
 * Session `id` as every card names it: its title, its id and its group, else its folder ("“api-fix” · s5 · atticus").
 * Titles are changed by the model, agents and teammates, and two sessions may share one; the id is what a card acts on.
 */
export function sessionRef(d: Pick<AssistantDeps, "sessions"> & Partial<Pick<AssistantDeps, "record">>, id: string): string {
  const s = sessionById(d, id);
  const r = d.record?.(id)?.info ?? null;
  const title = s ? s.title : r ? (r.ticketTitle ?? r.title) : null;
  return refLine(title, id, s?.group ?? r?.taskGroup ?? folderName(r?.cwd) ?? s?.repo ?? null);
}

/** What a card warns of text an agent takes as a command when it leads with "!" (a shell command) or "/" (a slash command). `who`: "Claude". */
export function leadWarnings(text: string, who: string): string[] {
  const lead = text.trimStart()[0];
  if (lead === "!") return [`It starts with “!”: ${who} may run it as a shell command rather than read it`];
  if (lead === "/") return [`It starts with “/”: ${who} may run it as a slash command rather than read it`];
  return [];
}

/**
 * Typing into session `s` (`ref`, as sessionRef names it) when it runs in a permission mode wider than the default:
 * its agent acts on what it's told without asking, in the danger color for bypass. `rule`: a standing rule's action,
 * which is refused while it does (typedWiderRefusal).
 */
export function widerTarget(s: Pick<AssistantSession, "permissionMode"> | null, ref: string, rule: boolean): { warnings: string[]; danger: boolean } {
  if (!s || !WIDER_MODES.has(s.permissionMode)) return { warnings: [], danger: false };
  const mode = PERMISSION_MODE_LABEL[s.permissionMode];
  return {
    warnings: [rule ? `${ref} runs in ${mode} mode now: the rule types nothing into it while it does` : `${ref} runs in ${mode} mode: its agent acts on this without asking you first`],
    danger: s.permissionMode === "bypass",
  };
}

/** Why a standing rule types nothing into session `s` (`ref`) now: it runs in a permission mode wider than the default. Null when it doesn't. */
export function typedWiderRefusal(s: Pick<AssistantSession, "permissionMode"> | null, ref: string): string | null {
  if (!s || !WIDER_MODES.has(s.permissionMode)) return null;
  return `${ref} runs in ${PERMISSION_MODE_LABEL[s.permissionMode]} mode: a standing rule types nothing into a session that acts without asking you`;
}
