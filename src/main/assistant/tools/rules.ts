import { ASSISTANT_LIMITS, type AssistantRule, type RuleTrigger } from "../../../shared/assistant";
import { plainLine, quoted } from "../../../shared/team/agentText";
import type { AssistantDeps } from "../deps";
import { defineTool, type AssistantTool, type JsonSchema, type ToolCard } from "../registry";
import { RULE_LABEL_MAX, triggerShape, WAITING_MAX_MINUTES, type RuleDraft } from "../rules";
import { SESSION_ARG } from "./lookup";

/**
 * Standing rules (docs/assistant.md → Standing rules): listing them, making or changing one (always a card: once on,
 * a rule acts without asking each time), and turning one on or off or removing it (direct, with Undo).
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

/** "When “tests” finishes a turn: Focus “review”; then Notify me: “Tests done”." */
function sentence(d: Deps, draft: RuleDraft): string {
  const actions = Array.isArray(draft.actions) ? d.rules.actions(draft).map((a) => a.label) : [];
  return `${whenOf(d, draft.trigger)}: ${actions.join("; then ") || "nothing"}.`;
}

export function ruleTools(d: Deps): AssistantTool[] {
  /** change_rule's draft: what it names, over what the rule has. */
  const changed = (a: { rule: string; label?: string; trigger?: RuleTrigger; actions?: RuleDraft["actions"] }, r: AssistantRule): RuleDraft => ({
    label: a.label ?? r.label,
    trigger: a.trigger ?? r.trigger,
    actions: a.actions ?? r.actions.map((x) => ({ tool: x.tool, args: x.args })),
  });

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
      card: (a): ToolCard => ({ title: `Make the rule “${plainLine(a.label, 120)}”`, detail: sentence(d, a), warnings: [RUNS_WITHOUT_ASKING] }),
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
        return d.rules.refusal(changed(a, r), a.rule);
      },
      card: (a): ToolCard => {
        const r = d.rules.get(a.rule);
        if (!r) return { title: `Change the rule ${quoted(a.rule, 80)}`, detail: noRule(a.rule), warnings: [] };
        const next = changed(a, r);
        const renamed = plainLine(next.label, RULE_LABEL_MAX) !== r.label ? ` It's renamed “${plainLine(next.label, 120)}”.` : "";
        return {
          title: `Change the rule “${r.label}”`,
          detail: `From now on: ${sentence(d, next)}${renamed}`,
          warnings: [RUNS_WITHOUT_ASKING, ...(r.on ? [] : ["It's off, and stays off until you turn it on."])],
        };
      },
      stillValid: (a) => !!d.rules.get(a.rule),
      run: (a) => {
        const r = d.rules.get(a.rule);
        if (!r) throw new Error(noRule(a.rule));
        const after = d.rules.change(a.rule, changed(a, r));
        return { text: `Changed the rule “${after.label}”.` };
      },
    }),
    defineTool<{ rule: string; on: boolean }>({
      name: "set_rule_on",
      tier: "direct",
      description: "Turn one of the user's standing rules on or off. Turning a paused rule on clears its pause. The user can Undo it.",
      inputSchema: { type: "object", properties: { rule: RULE_ARG, on: { type: "boolean" } }, required: ["rule", "on"], additionalProperties: false },
      label: (a) => `Turn ${nameOf(d, a.rule)} ${a.on ? "on" : "off"}`,
      check: (a) => {
        const r = d.rules.get(a.rule);
        if (!r) return noRule(a.rule);
        if (a.on && r.on && !r.paused) return "It's on already";
        if (!a.on && !r.on) return "It's off already";
        return null;
      },
      run: (a) => {
        const before = d.rules.get(a.rule);
        const after = d.rules.setOn(a.rule, a.on);
        if (!before || !after) throw new Error(noRule(a.rule));
        const was = { on: before.on, paused: before.paused ?? null };
        return {
          text: `Turned “${after.label}” ${a.on ? "on" : "off"}.`,
          // put back only over its own switch: a rule switched, paused or changed again since is as it is now
          stillUndoable: () => {
            const r = d.rules.get(a.rule);
            return !!r && r.on === after.on && (r.paused ?? null) === (after.paused ?? null);
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
