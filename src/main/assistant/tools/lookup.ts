import { quoted } from "../../../shared/team/agentText";
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
