import type { AssistantRule, RuleRun } from "../../shared/assistant";

/**
 * The Assistant's standing rules (docs/assistant.md → Standing rules), as the service reads and changes them. The
 * rules themselves, their file and their runner come in their own change; until then noRules() has none, so turning a
 * rule on or off, or removing one, answers that there's no such rule. A runner carries out each action through
 * AssistantService.runAction, which checks the tool's guards and records it in the activity log.
 */
export interface RulesStore {
  list(): AssistantRule[];
  /** The last runs, oldest first. */
  runs(): RuleRun[];
  /** Turn rule `id` on or off: the rule as it is now, or null when there's no such rule. Throws when it can't be saved. */
  setOn(id: string, on: boolean): AssistantRule | null;
  /** Remove rule `id`: false when there's no such rule. Throws when it can't be saved. */
  remove(id: string): boolean;
  /** Called whenever list() or runs() changes, so the sheet hears of it. */
  onChanged?(cb: () => void): void;
}

/** No rules, and nowhere to keep one. */
export function noRules(): RulesStore {
  return { list: () => [], runs: () => [], setOn: () => null, remove: () => false };
}
