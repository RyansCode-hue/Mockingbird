import { ASSISTANT_LIMITS, type AssistantRule, type RuleTrigger } from "../../../shared/assistant";
import { plainLine, quoted } from "../../../shared/team/agentText";
import type { AssistantDeps } from "../deps";
import { defineTool, type AssistantTool, type JsonSchema, type ToolCard } from "../registry";
import { RULE_LABEL_MAX, triggerShape, WAITING_MAX_MINUTES, type RuleDraft } from "../rules";
import { CHANGED_SINCE_CARD, SESSION_ARG } from "./lookup";
import { cardSaw } from "./sessions";

/**
 * Standing rules (docs/assistant.md → Standing rules): listing them; making, changing or turning one on (always a
 * card showing its trigger and every action: once on, a rule acts without asking each time); turning one off or
 * removing it (direct, with Undo).
 */

type Deps = Pick<AssistantDeps, "rules">;

const RULE_ARG: JsonSchema = { type: "string", minLength: 1, maxLength: 80, description: "The rule's id, from list_rules" };
const LABEL: JsonSchema = { type: "string", minLength: 1, maxLength: RULE_LABEL_MAX, description: "One plain sentence saying what the rule does: “When tests finishes, start the review”" };
const TARGET: JsonSchema = {
  type: "object",
  description: "Exactly one of: {session: id} (this Mac's own), {group: key} (its stacks included), {any: true}",
  properties: {
    session: SESSION_ARG,
    group: { type: "string", minLength: 1, maxLength: 200, description: "A group's key, from the snapshot or list_groups" },
    any: { type: "boolean", enum: [true] },
  },
  additionalProperties: false,
};
const TRIGGER: JsonSchema = {
  type: "object",
  description:
    "What fires the rule: app state, never text. {kind: finished, target}: a turn ended. {kind: waiting, target, minutes}: it has waited on the user that long. " +
    "{kind: exited, target}: its process ended. {kind: daily, at: HH:MM, days?}: a local time, on those weekdays (0 = Sunday), every day when left out.",
  properties: {
    kind: { type: "string", enum: ["finished", "waiting", "exited", "daily"] },
    target: TARGET,
    minutes: { type: "integer", minimum: 1, maximum: WAITING_MAX_MINUTES },
    at: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
    days: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, minItems: 1, maxItems: 7 },
  },
  required: ["kind"],
  additionalProperties: false,
};
const ACTIONS: JsonSchema = {
  type: "array",
  minItems: 1,
  maxItems: ASSISTANT_LIMITS.maxRuleActions,
  description: "What it does, in order: each a tool list_rules says a rule may use, with its arguments fixed now (a message to type is fixed text).",
  items: {
    type: "object",
    properties: { tool: { type: "string", minLength: 1, maxLength: 64 }, args: { type: "object", description: "The tool's arguments, as its schema in list_rules takes them" } },
    required: ["tool", "args"],
    additionalProperties: false,
  },
};

const RUNS_WITHOUT_ASKING = "Once it's on, it does these each time without asking you.";

const noRule = (id: string) => `There's no rule with id ${quoted(id, 80)}: the ids are in list_rules`;

/** A rule as list_rules gives it. */
function listed(d: Deps, r: AssistantRule) {
  return { id: r.id, label: r.label, when: whenOf(d, r.trigger), trigger: r.trigger, actions: r.actions, on: r.on, paused: r.paused ?? null, lastRun: r.lastRun ?? null };
}

/** The trigger in plain words, or that it isn't one (a card names what it's refused for). */
const whenOf = (d: Deps, t: RuleTrigger): string => (triggerShape(t) ? "A trigger that isn't one" : d.rules.describe(t));

/** Rule `r` as a draft: what it watches and does. */
const draftOf = (r: AssistantRule): RuleDraft => ({ label: r.label, trigger: r.trigger, actions: r.actions.map((x) => ({ tool: x.tool, args: x.args })) });

/** What a card about rule `r` showed of it: the same rule changed since is another card's. */
const shapeOf = (r: AssistantRule): string => JSON.stringify([r.label, r.trigger, r.actions.map((x) => [x.tool, x.args])]);

/** shapeOf, and whether it's on and why it's paused: a change_rule card says both, and a turn_rule_off Undo puts back only over its own. */
const stateOf = (r: AssistantRule): string => JSON.stringify([shapeOf(r), r.on, r.paused ?? null]);

/**
 * A card about what a rule will do: its trigger, then each action as main spells it out from its arguments (every
 * payload whole, sessions by id, a wider mode warned of), in the danger color when any action is. `lead` comes before
 * the trigger ("From now on: "); `warnings` follow the one every rule card carries.
 */
function ruleCard(d: Deps, draft: RuleDraft, title: string, lead: string, warnings: string[]): ToolCard {
  const actions = Array.isArray(draft.actions) ? d.rules.details(draft) : [];
  return {
    title,
    detail: `${lead}${whenOf(d, draft.trigger)}, it does ${actions.length === 1 ? "this" : `these ${actions.length}, in order`}:`,
    actions,
    warnings: [RUNS_WITHOUT_ASKING, ...warnings],
    ...(actions.some((a) => a.danger) ? { danger: true } : {}),
  };
}

export function ruleTools(d: Deps): AssistantTool[] {
  /** change_rule's draft: what it names, over what the rule has. */
  const changed = (a: { rule: string; label?: string; trigger?: RuleTrigger; actions?: RuleDraft["actions"] }, r: AssistantRule): RuleDraft => ({
    label: a.label ?? r.label,
    trigger: a.trigger ?? r.trigger,
    actions: a.actions ?? r.actions.map((x) => ({ tool: x.tool, args: x.args })),
  });
  const onSaw = cardSaw<string>();
  const changeSaw = cardSaw<string>();

  return [
    defineTool<Record<string, never>>({
      name: "list_rules",
      tier: "read",
      description:
        "The user's standing rules: each with its id, label, trigger (and in words), actions, whether it's on, why Mockingbird paused it, and its last run. " +
        "Also the tools a rule's action may use, with the arguments each takes, and the limits.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      label: () => "Listed the standing rules",
      run: () => ({
        text: JSON.stringify({
          rules: d.rules.list().map((r) => listed(d, r)),
          usable: d.rules.usable(),
          limits: { rules: ASSISTANT_LIMITS.maxRules, actionsPerRule: ASSISTANT_LIMITS.maxRuleActions, runsPerHour: ASSISTANT_LIMITS.ruleRunsPerHour, failuresToPause: ASSISTANT_LIMITS.ruleFailuresToPause },
        }),
      }),
    }),
    defineTool<RuleDraft>({
      name: "propose_rule",
      tier: "confirm",
      description:
        "Make a standing rule: when its trigger fires, Mockingbird runs its actions without asking. Call list_rules first for the tools a rule may use. " +
        "This puts a card in front of the user; the rule is made, on, only when they confirm.",
      inputSchema: { type: "object", properties: { label: LABEL, trigger: TRIGGER, actions: ACTIONS }, required: ["label", "trigger", "actions"], additionalProperties: false },
      label: (a) => `Make the rule “${plainLine(a.label, 120)}”`,
      check: (a) => d.rules.refusal(a),
      card: (a): ToolCard => ruleCard(d, a, `Make the rule “${plainLine(a.label, 120)}”`, "", []),
      run: (a) => {
        const r = d.rules.add(a);
        return { text: `Made the rule “${r.label}” (${r.id}): it's on.` };
      },
    }),
    defineTool<{ rule: string; label?: string; trigger?: RuleTrigger; actions?: RuleDraft["actions"] }>({
      name: "change_rule",
      tier: "confirm",
      description:
        "Change a standing rule's label, trigger or actions (what's left out stays as it is). It stays on or off as it was, and a pause is cleared. " +
        "This puts a card in front of the user; it changes only when they confirm.",
      inputSchema: { type: "object", properties: { rule: RULE_ARG, label: LABEL, trigger: TRIGGER, actions: ACTIONS }, required: ["rule"], additionalProperties: false },
      label: (a) => `Change the rule ${nameOf(d, a.rule)}`,
      check: (a) => {
        const r = d.rules.get(a.rule);
        if (!r) return noRule(a.rule);
        if (a.label === undefined && a.trigger === undefined && a.actions === undefined) return "Say what to change: its label, trigger or actions";
        // Do it: what's left out is taken from the rule as it is then, so it must be the rule the card showed
        const saw = changeSaw.get(a);
        if (saw !== undefined && saw !== stateOf(r)) return CHANGED_SINCE_CARD;
        return d.rules.refusal(changed(a, r), a.rule);
      },
      card: (a): ToolCard => {
        const r = d.rules.get(a.rule);
        if (!r) return { title: `Change the rule ${quoted(a.rule, 80)}`, detail: noRule(a.rule), warnings: [] };
        changeSaw.set(a, stateOf(r));
        const next = changed(a, r);
        const renamed = plainLine(next.label, RULE_LABEL_MAX) !== r.label ? `It's renamed “${plainLine(next.label, 120)}”. ` : "";
        return ruleCard(d, next, `Change the rule “${r.label}”`, `${renamed}From now on: `, [
          ...(r.on ? [] : ["It's off, and stays off until you turn it on."]),
          ...(r.paused ? [`Mockingbird paused it (${plainLine(r.paused, 200)}): changing it clears that${r.on ? ", so it runs again" : ""}.`] : []),
        ]);
      },
      stillValid: (a) => {
        const r = d.rules.get(a.rule);
        const saw = changeSaw.get(a);
        return !!r && (saw === undefined || saw === stateOf(r));
      },
      run: (a) => {
        const r = d.rules.get(a.rule);
        if (!r) throw new Error(noRule(a.rule));
        const saw = changeSaw.get(a);
        if (saw !== undefined && saw !== stateOf(r)) throw new Error(CHANGED_SINCE_CARD);
        const after = d.rules.change(a.rule, changed(a, r));
        return { text: `Changed the rule “${after.label}”.` };
      },
    }),
    // turning a rule on is a card, as making one is: once on it acts without asking, and a paused one's pause goes
    defineTool<{ rule: string }>({
      name: "turn_rule_on",
      tier: "confirm",
      description:
        "Turn one of the user's standing rules on, or a paused one on again (its pause is cleared). " +
        "This puts a card in front of the user showing its trigger and every action; it's on only when they confirm.",
      inputSchema: { type: "object", properties: { rule: RULE_ARG }, required: ["rule"], additionalProperties: false },
      label: (a) => `Turn ${nameOf(d, a.rule)} on`,
      check: (a) => {
        const r = d.rules.get(a.rule);
        if (!r) return noRule(a.rule);
        if (r.on && !r.paused) return "It's on already";
        // Do it: the rule it turns on must be the one the card showed
        const saw = onSaw.get(a);
        if (saw !== undefined && saw !== shapeOf(r)) return CHANGED_SINCE_CARD;
        return d.rules.refusal(draftOf(r), a.rule);
      },
      card: (a): ToolCard => {
        const r = d.rules.get(a.rule);
        if (!r) return { title: `Turn on the rule ${quoted(a.rule, 80)}`, detail: noRule(a.rule), warnings: [] };
        onSaw.set(a, shapeOf(r));
        return ruleCard(d, draftOf(r), `Turn on the rule “${r.label}”`, "", r.paused ? [`Mockingbird paused it (${plainLine(r.paused, 200)}): turning it on clears that.`] : []);
      },
      stillValid: (a) => {
        const r = d.rules.get(a.rule);
        const saw = onSaw.get(a);
        return !!r && (saw === undefined || saw === shapeOf(r));
      },
      run: (a) => {
        const after = d.rules.setOn(a.rule, true);
        if (!after) throw new Error(noRule(a.rule));
        return { text: `Turned “${after.label}” on.` };
      },
    }),
    defineTool<{ rule: string }>({
      name: "turn_rule_off",
      tier: "direct",
      description: "Turn one of the user's standing rules off: it runs no more until it's turned on again. The user can Undo it.",
      inputSchema: { type: "object", properties: { rule: RULE_ARG }, required: ["rule"], additionalProperties: false },
      label: (a) => `Turn ${nameOf(d, a.rule)} off`,
      check: (a) => {
        const r = d.rules.get(a.rule);
        if (!r) return noRule(a.rule);
        return r.on ? null : "It's off already";
      },
      run: (a) => {
        const before = d.rules.get(a.rule);
        const after = d.rules.setOn(a.rule, false);
        if (!before || !after) throw new Error(noRule(a.rule));
        const was = { on: before.on, paused: before.paused ?? null };
        const left = stateOf(after);
        return {
          text: `Turned “${after.label}” off.`,
          // put back only over its own switch: a rule switched, paused or changed again since is as it is now
          stillUndoable: () => {
            const r = d.rules.get(a.rule);
            return !!r && stateOf(r) === left;
          },
          undo: () => {
            d.rules.putBack(a.rule, was);
            return `Turned “${after.label}” back ${was.on ? "on" : "off"}${was.paused ? ", paused" : ""}`;
          },
        };
      },
    }),
    defineTool<{ rule: string }>({
      name: "remove_rule",
      tier: "direct",
      description: "Remove one of the user's standing rules. The user can Undo it, which puts it back as it was.",
      inputSchema: { type: "object", properties: { rule: RULE_ARG }, required: ["rule"], additionalProperties: false },
      label: (a) => `Remove the rule ${nameOf(d, a.rule)}`,
      check: (a) => (d.rules.get(a.rule) ? null : noRule(a.rule)),
      run: (a) => {
        const took = d.rules.take(a.rule);
        if (!took) throw new Error(noRule(a.rule));
        return {
          text: `Removed the rule “${took.rule.label}”.`,
          stillUndoable: () => !d.rules.get(a.rule),
          undo: () => {
            d.rules.restore(took.rule, took.index);
            return `Put back the rule “${took.rule.label}”`;
          },
        };
      },
    }),
  ];
}

const nameOf = (d: Deps, id: string): string => {
  const r = d.rules.get(id);
  return r ? `“${r.label}”` : quoted(id, 80);
};
