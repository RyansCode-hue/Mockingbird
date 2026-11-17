import { randomUUID } from "crypto";
import { ASSISTANT_LIMITS, type ActionDetail, type AssistantRule, type AssistantStep, type RuleAction, type RuleRun, type RuleTarget, type RuleTrigger } from "../../shared/assistant";
import { ALERT_MAX, alertLine, normalizeHandle, phoneSettings } from "../../shared/phoneAlerts";
import { plainLine, quoted } from "../../shared/team/agentText";
import type { Settings } from "../../shared/types";
import { inQuietHours, shouldNotify } from "../notifications";
import type { AlertSender } from "../phone/sender";
import type { AssistantDeps, AssistantSession } from "./deps";
import { defineTool, validateArgs, type AssistantTool, type JsonSchema } from "./registry";
import { describeAction, RULE_LABEL_MAX, ruleDenied, targetOf, triggerShape, type RuleBook, type RuleDraft, type RulesApi, type RulesStore } from "./rules";
import { refLine } from "./tools/lookup";

/**
 * The standing rules running in main (docs/assistant.md → Standing rules). Their triggers are app state, never text:
 * a turn's end (the agent's Stop hook), waiting on the user N minutes and the time of day (both read on main's 30 s
 * tick), and a process ending. A rule runs its actions in order, one rule at a time, each through the Assistant
 * service's runAction (its tool's guards checked then, and recorded in the activity log as the rule's), at most once
 * per trigger event and ruleRunsPerHour times an hour. ruleFailuresToPause failed runs in a row, or a target that's
 * gone, pause it, saying why. A time missed while the Mac slept or the app was closed is skipped, not caught up.
 */

export type RuleLimits = Record<"maxRules" | "maxRuleActions" | "ruleRunsPerHour" | "ruleFailuresToPause", number>;

/** What the engine runs actions through: the Assistant service (service.ts). */
export interface RuleRunner {
  /** Run one action as rule `rule`'s (its label): its tool's guards are checked, and it's recorded in the activity log. */
  runAction(a: RuleAction, rule: string): Promise<{ ok: boolean; text: string; step: AssistantStep }>;
  /** The tool an action names: a registry tool, or an action only rules take. */
  ruleTool(name: string): AssistantTool | undefined;
  /** Every tool a rule's action may name. */
  ruleTools(): AssistantTool[];
}

export interface RuleEngineDeps {
  book: RuleBook;
  world: Pick<AssistantDeps, "sessions" | "groups">;
  /** Whether this Mac still has session `id`: running, or closed and resumable. A rule whose session is neither pauses. */
  sessionKept(id: string): boolean;
  settings(): Settings;
  /** A desktop notification. */
  notify(title: string, body: string): void;
  /** The phone alerts' sender (phone/sender.ts); null in a development build, which only logs what it would send. */
  sender: AlertSender | null;
  log(context: string, err: unknown): void;
  info(line: string): void;
  now?: () => number;
  limits?: Partial<RuleLimits>;
}

/** One trigger event: what fired, once. */
interface RuleEvent {
  /** The same event never runs a rule twice. */
  key: string;
  /** "“tests” finished". */
  text: string;
}

const HOUR_MS = 3_600_000;
const RUNS_KEPT = 20;
/** A daily time is caught by a tick this soon after it (two of main's 30 s ticks); later than that it was missed. */
export const DAILY_WINDOW_MS = 90_000;
/** A process's end is told twice at most (its agent quitting, then its pty's exit): one event. */
const EXIT_COALESCE_MS = 10_000;
/** A target missing this long is gone: a session being relaunched, or the app starting, is only missing for a moment. */
export const GONE_MS = 60_000;
/** How long an event's key is remembered, so it runs a rule once. */
const FIRED_KEPT_MS = 2 * 24 * HOUR_MS;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)) || "it failed without saying why";
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Whether session `s` is one `target` watches: by id, in the group or one of its stacks, or any. */
export function targetMatches(target: RuleTarget, s: Pick<AssistantSession, "id" | "group">): boolean {
  if ("session" in target) return s.id === target.session;
  if ("group" in target) return !!s.group && (s.group === target.group || s.group.startsWith(`${target.group}/`));
  return target.any === true;
}

/** Today's slot of daily trigger `t` (when it falls, and which day), when `now` is within DAILY_WINDOW_MS after it. */
export function dailySlot(t: Extract<RuleTrigger, { kind: "daily" }>, now: number): { at: number; day: string } | null {
  const [h, m] = t.at.split(":").map(Number);
  const d = new Date(now);
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
  if (t.days && !t.days.includes(at.getDay())) return null;
  if (now < at.getTime() || now >= at.getTime() + DAILY_WINDOW_MS) return null;
  return { at: at.getTime(), day: ymd(at) };
}

export class RuleEngine implements RulesStore, RulesApi {
  /** Actions only a standing rule takes: never a turn's tools (the service holds them apart from its registry). */
  readonly ruleOnly: AssistantTool[];
  private runner: RuleRunner | null = null;
  private readonly limits: RuleLimits;
  private readonly now: () => number;
  private readonly recent: RuleRun[] = [];
  private readonly listeners: (() => void)[] = [];
  private readonly fired = new Map<string, number>();
  private readonly started = new Map<string, number[]>();
  private readonly limited = new Set<string>();
  private readonly failures = new Map<string, number>();
  private readonly missing = new Map<string, number>();
  private readonly exits = new Map<string, number>();
  private readonly titles = new Map<string, string>();
  /** When a rule was last changed or turned on: a time of day before then isn't its to catch. Its creation, else. */
  private readonly armed = new Map<string, number>();
  private queue: { ruleId: string; event: RuleEvent }[] = [];
  private running = false;
  private drained: Promise<void> = Promise.resolve();
  /** The run in progress: runs are one at a time, so the rule-only actions read what fired them here. */
  private current: { rule: AssistantRule; event: RuleEvent } | null = null;
  private stopped = false;

  constructor(private readonly d: RuleEngineDeps) {
    this.now = d.now ?? Date.now;
    this.limits = { ...ASSISTANT_LIMITS, ...d.limits };
    this.ruleOnly = this.ruleOnlyTools();
  }

  /** Run actions through `runner` from now on: until then a rule that fires fails, saying so. */
  attach(runner: RuleRunner): void {
    this.runner = runner;
  }

  /** No rule runs from now on (quitting: the panes' ptys end next, and their exits mustn't fire rules). */
  stop(): void {
    this.stopped = true;
    this.queue = [];
  }

  /** Resolves once every run that's queued has finished. */
  async settled(): Promise<void> {
    while (this.running || this.queue.length) await this.drained;
  }

  // ---- RulesStore (the sheet) ----------------------------------------------------------------

  list(): AssistantRule[] {
    return this.d.book.list();
  }

  runs(): RuleRun[] {
    return structuredClone(this.recent);
  }

  onChanged(cb: () => void): void {
    this.listeners.push(cb);
  }

  problem(): string | null {
    return this.d.book.problem();
  }

  /** Turning a rule on clears its pause and its failures: it starts over. Turning one off holds even unsaved (RuleBook.relax). */
  setOn(id: string, on: boolean): AssistantRule | null {
    if (!this.d.book.get(id)) return null;
    const edit = (rules: AssistantRule[]) => {
      const r = rules.find((x) => x.id === id)!;
      r.on = on;
      if (on) r.paused = null;
    };
    if (on) this.d.book.change(edit);
    else this.d.book.relax([id], edit);
    if (on) {
      this.restart(id);
      this.armed.set(id, this.now());
    }
    this.changed();
    return this.d.book.get(id);
  }

  remove(id: string): boolean {
    return !!this.take(id);
  }

  // ---- RulesApi (tools/rules.ts) -------------------------------------------------------------

  get(id: string): AssistantRule | null {
    return this.d.book.get(id);
  }

  refusal(draft: RuleDraft, replacing?: string): string | null {
    if (replacing !== undefined && !this.d.book.get(replacing)) return `There's no rule with id ${quoted(replacing, 80)}: the ids are in list_rules`;
    if (typeof draft.label !== "string" || !plainLine(draft.label, RULE_LABEL_MAX)) return "The rule needs a label: one plain sentence saying what it does";
    const shape = triggerShape(draft.trigger);
    if (shape) return `The rule's ${shape}`;
    const target = targetOf(draft.trigger);
    if (target) {
      const why = this.targetRefusal(target);
      if (why) return why;
    }
    if (!Array.isArray(draft.actions) || !draft.actions.length) return "A rule needs at least one action";
    if (draft.actions.length > this.limits.maxRuleActions) return `A rule takes at most ${this.limits.maxRuleActions} actions`;
    for (const [i, a] of draft.actions.entries()) {
      const why = this.actionRefusal(a);
      if (why) return `Its action ${i + 1} (${quoted(a?.tool, 64)}): ${why}`;
    }
    const count = this.d.book.list().length;
    if (replacing === undefined && count >= this.limits.maxRules) return `Mockingbird keeps at most ${plural(this.limits.maxRules, "rule")}, and there are ${count}: remove one first`;
    return null;
  }

  describe(t: RuleTrigger): string {
    if (t.kind === "daily") {
      const days = t.days ? [...t.days].sort((a, b) => a - b) : null;
      if (!days || days.length === 7) return `Every day at ${t.at}`;
      if (days.join() === "1,2,3,4,5") return `At ${t.at} on weekdays`;
      if (days.join() === "0,6") return `At ${t.at} on weekends`;
      return `At ${t.at} on ${days.map((d) => DAY_NAMES[d]).join(", ")}`;
    }
    const who = this.targetName(t.target);
    if (t.kind === "finished") return `When ${who} finishes a turn`;
    if (t.kind === "exited") return `When ${who} exits`;
    return `When ${who} has waited on you ${plural(t.minutes, "minute")}`;
  }

  details(draft: RuleDraft): ActionDetail[] {
    const actions = Array.isArray(draft.actions) ? draft.actions : [];
    // a draft's actions are the model's, unchecked: one that isn't an object is described as naming no tool
    return actions.map((a) => describeAction(typeof a?.tool === "string" ? this.runner?.ruleTool(a.tool) : undefined, a ?? { tool: "", args: {} }, this.d.world, this.d.log));
  }

  actions(draft: RuleDraft): RuleAction[] {
    return draft.actions.map((a) => {
      const tool = this.runner?.ruleTool(a.tool);
      // refusal() says why such an action can't be a rule's; a card still names it
      if (!tool) return { tool: a.tool, args: structuredClone(a.args), label: plainLine(a.tool, 64) || "an action" };
      let label: string;
      try {
        label = plainLine(tool.label(a.args), 160) || tool.name;
      } catch (err) {
        this.d.log(`assistant rules: labelling a ${tool.name} action`, err);
        label = tool.name;
      }
      return { tool: tool.name, args: structuredClone(a.args), label };
    });
  }

  add(draft: RuleDraft): AssistantRule {
    const why = this.refusal(draft);
    if (why) throw new Error(why);
    const rule: AssistantRule = {
      id: `r-${randomUUID()}`,
      label: plainLine(draft.label, RULE_LABEL_MAX),
      trigger: structuredClone(draft.trigger),
      actions: this.actions(draft),
      on: true,
      createdAt: this.now(),
      paused: null,
      lastRun: null,
    };
    this.d.book.change((rules) => void rules.push(rule));
    this.changed();
    return this.d.book.get(rule.id)!;
  }

  change(id: string, draft: RuleDraft): AssistantRule {
    const why = this.refusal(draft, id);
    if (why) throw new Error(why);
    const actions = this.actions(draft);
    this.d.book.change((rules) => {
      const r = rules.find((x) => x.id === id)!;
      r.label = plainLine(draft.label, RULE_LABEL_MAX);
      r.trigger = structuredClone(draft.trigger);
      r.actions = actions;
      r.paused = null;
    });
    this.restart(id);
    this.armed.set(id, this.now());
    this.changed();
    return this.d.book.get(id)!;
  }

  putBack(id: string, state: { on: boolean; paused: string | null }): AssistantRule {
    if (!this.d.book.get(id)) throw new Error("That rule has been removed since");
    const edit = (rules: AssistantRule[]) => {
      const r = rules.find((x) => x.id === id)!;
      r.on = state.on;
      r.paused = state.paused;
    };
    // putting a rule back on must be saved; putting it back off or paused stops it, which holds unsaved
    if (state.on && !state.paused) this.d.book.change(edit);
    else this.d.book.relax([id], edit);
    this.changed();
    return this.d.book.get(id)!;
  }

  take(id: string): { rule: AssistantRule; index: number } | null {
    const all = this.d.book.list();
    const index = all.findIndex((r) => r.id === id);
    if (index < 0) return null;
    this.d.book.relax([id], (rules) => void rules.splice(index, 1));
    this.restart(id);
    this.queue = this.queue.filter((j) => j.ruleId !== id);
    this.changed();
    return { rule: all[index], index };
  }

  restore(rule: AssistantRule, index: number): void {
    const all = this.d.book.list();
    if (all.some((r) => r.id === rule.id)) throw new Error("That rule is back already");
    if (all.length >= this.limits.maxRules) throw new Error(`Mockingbird keeps at most ${plural(this.limits.maxRules, "rule")}, and there are ${all.length} now: remove one first`);
    this.d.book.change((rules) => void rules.splice(Math.min(index, rules.length), 0, structuredClone(rule)));
    this.changed();
  }

  /** The tools a rule's action may name, as list_rules gives them to the model. */
  usable(): { tool: string; description: string; inputSchema: JsonSchema }[] {
    return (this.runner?.ruleTools() ?? []).map((t) => ({ tool: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  // ---- triggers ------------------------------------------------------------------------------

  /** Session `id`'s turn ended (its agent's Stop hook); `at` is when, from the hook, so a repeated event is one event. */
  finished(id: string, at?: number | null): void {
    this.event("finished", id, (name) => ({ key: `finished:${id}:${at ?? this.now()}`, text: `${name} finished` }));
  }

  /** Session `id`'s process ended: its pty exited, or its agent quit (told both ways, once). */
  exited(id: string): void {
    const now = this.now();
    const last = this.exits.get(id);
    if (last !== undefined && now - last < EXIT_COALESCE_MS) return;
    this.exits.set(id, now);
    this.event("exited", id, (name) => ({ key: `exited:${id}:${now}`, text: `${name} exited` }));
  }

  /** Main's 30 s tick: waiting and daily triggers, and targets that are gone. */
  tick(): void {
    if (this.stopped) return;
    const now = this.now();
    for (const [k, at] of this.fired) if (now - at > FIRED_KEPT_MS) this.fired.delete(k);
    const sessions = this.mine();
    for (const s of sessions) this.titles.set(s.id, s.title);
    for (const rule of this.d.book.list()) {
      if (!rule.on || rule.paused) continue;
      if (this.pauseIfGone(rule, now)) continue;
      const t = rule.trigger;
      if (t.kind === "waiting") {
        for (const s of sessions) {
          if (s.status !== "waiting" || s.waitingSince === null || now - s.waitingSince < t.minutes * 60_000 || !targetMatches(t.target, s)) continue;
          this.fire(rule, { key: `waiting:${s.id}:${s.waitingSince}`, text: `“${s.title}” waited ${plural(t.minutes, "minute")}` });
        }
      } else if (t.kind === "daily") {
        const slot = dailySlot(t, now);
        if (slot && (this.armed.get(rule.id) ?? rule.createdAt) <= slot.at) this.fire(rule, { key: `daily:${slot.day}`, text: `At ${t.at}` });
      }
    }
  }

  // ---- inside --------------------------------------------------------------------------------

  /** This Mac's own sessions: only they have hooks, statuses and exits a rule can watch. */
  private mine(): AssistantSession[] {
    return this.d.world.sessions().filter((s) => s.mine);
  }

  private event(kind: "finished" | "exited", id: string, make: (name: string) => RuleEvent): void {
    if (this.stopped) return;
    const s = this.mine().find((x) => x.id === id) ?? null;
    if (s) this.titles.set(s.id, s.title);
    const ev = make(s ? `“${s.title}”` : quoted(id, 80));
    for (const rule of this.d.book.list()) {
      const target = rule.trigger.kind === kind ? targetOf(rule.trigger) : null;
      if (!rule.on || rule.paused || !target) continue;
      // a session the world doesn't show (a debrief) is watched only when a rule names it
      if ("session" in target ? target.session === id : !!s && targetMatches(target, s)) this.fire(rule, ev);
    }
  }

  private fire(rule: AssistantRule, ev: RuleEvent): void {
    const key = `${rule.id}|${ev.key}`;
    if (this.fired.has(key)) return;
    this.fired.set(key, this.now());
    this.queue.push({ ruleId: rule.id, event: ev });
    if (!this.running) this.drained = this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const job = this.queue.shift()!;
        try {
          await this.run(job.ruleId, job.event);
        } catch (err) {
          this.d.log(`assistant rules: running rule ${job.ruleId}`, err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async run(ruleId: string, event: RuleEvent): Promise<void> {
    const rule = this.d.book.get(ruleId);
    if (!rule || !rule.on || rule.paused) return;
    const now = this.now();
    const hour = (this.started.get(ruleId) ?? []).filter((t) => now - t < HOUR_MS);
    this.started.set(ruleId, hour);
    if (hour.length >= this.limits.ruleRunsPerHour) {
      // said once per spell, so a rule that keeps firing doesn't fill the sheet
      if (this.limited.has(ruleId)) return;
      this.limited.add(ruleId);
      const next = Math.ceil((hour[0] + HOUR_MS - now) / 60_000);
      return this.record(rule, false, `Not run · ${event.text}: it ran ${plural(hour.length, "time")} in the last hour, the most a rule may. It can run again in ${plural(next, "minute")}`, [], null);
    }
    this.limited.delete(ruleId);
    hour.push(now);
    const runner = this.runner;
    if (!runner) return this.record(rule, false, `Nothing ran · ${event.text}: the Assistant isn't running`, [], "the Assistant isn't running");
    const steps: AssistantStep[] = [];
    const did: string[] = [];
    let failed: string | null = null;
    this.current = { rule, event };
    try {
      for (const a of rule.actions) {
        if (failed === null && this.stopped) failed = `${a.label}: not run, as Mockingbird is quitting`;
        if (failed !== null) {
          steps.push({ id: `st-${randomUUID()}`, tool: a.tool, tier: runner.ruleTool(a.tool)?.tier ?? "direct", label: a.label, state: "failed", error: this.stopped ? "Not run: Mockingbird is quitting" : "Not run: the action before it failed" });
          continue;
        }
        let r: { ok: boolean; text: string; step: AssistantStep };
        try {
          r = await runner.runAction(a, rule.label);
        } catch (err) {
          this.d.log(`assistant rules: rule ${rule.id}'s ${a.tool}`, err);
          r = { ok: false, text: message(err), step: { id: `st-${randomUUID()}`, tool: a.tool, tier: "direct", label: a.label, state: "failed", error: message(err) } };
        }
        steps.push(r.step);
        if (!r.ok) failed = `${a.label}: ${plainLine(r.text, 200)}`;
        else did.push(plainLine(r.text, 120).replace(/\.$/, "") || a.label);
      }
    } finally {
      this.current = null;
    }
    if (failed !== null) return this.record(rule, false, `${failed} · ${event.text}`, steps, failed);
    return this.record(rule, true, `${did.join("; ")} · ${event.text}`, steps, null);
  }

  /** A run, in the sheet and as the rule's last run. `failure`: why it failed, which counts toward pausing it. */
  private record(rule: AssistantRule, ok: boolean, text: string, steps: AssistantStep[], failure: string | null): void {
    const at = this.now();
    const line = plainLine(text, 300);
    this.recent.push({ id: `rr-${randomUUID()}`, ruleId: rule.id, at, ok, text: line, steps });
    if (this.recent.length > RUNS_KEPT) this.recent.splice(0, this.recent.length - RUNS_KEPT);
    let paused: string | null = null;
    if (ok) this.failures.delete(rule.id);
    else if (failure !== null) {
      const n = (this.failures.get(rule.id) ?? 0) + 1;
      this.failures.set(rule.id, n);
      if (n >= this.limits.ruleFailuresToPause) paused = plainLine(`${n} runs failed in a row: ${failure}`, 300);
    }
    this.d.book.note(rule.id, { lastRun: { at, ok, text: line }, ...(paused ? { paused } : {}) });
    if (paused) {
      this.failures.delete(rule.id);
      this.d.info(`assistant rules: paused “${rule.label}” (${rule.id}): ${paused}`);
    }
    this.changed();
  }

  /** Pause `rule` once its target has been gone GONE_MS: true when it did. */
  private pauseIfGone(rule: AssistantRule, now: number): boolean {
    const target = targetOf(rule.trigger);
    const why = target ? this.gone(target) : null;
    if (!why) {
      this.missing.delete(rule.id);
      return false;
    }
    const since = this.missing.get(rule.id) ?? now;
    this.missing.set(rule.id, since);
    if (now - since < GONE_MS) return false;
    this.missing.delete(rule.id);
    this.d.book.note(rule.id, { paused: why });
    this.d.info(`assistant rules: paused “${rule.label}” (${rule.id}): ${why}`);
    this.changed();
    return true;
  }

  /** Why `target` is gone from this Mac, or null while it's here. */
  private gone(target: RuleTarget): string | null {
    if ("session" in target) {
      if (this.d.sessionKept(target.session)) return null;
      const title = this.titles.get(target.session);
      return `Its session ${title ? `“${title}”` : quoted(target.session, 80)} is gone: closed and forgotten`;
    }
    if ("group" in target) return this.groupKnown(target.group) ? null : `Its group ${quoted(target.group, 120)} is gone`;
    return null;
  }

  private groupKnown(key: string): boolean {
    return this.d.world.groups().some((g) => g.key === key || g.stacks.includes(key));
  }

  private targetRefusal(target: RuleTarget): string | null {
    if ("session" in target) {
      const s = this.d.world.sessions().find((x) => x.id === target.session);
      if (s && !s.mine) return `“${s.title}” is ${s.owner ? `${s.owner}'s` : "a teammate's"} session: a rule watches only this Mac's own`;
      if (!s && !this.d.sessionKept(target.session)) return `There's no session with id ${quoted(target.session, 80)}: the ids are in the snapshot and list_sessions`;
      return null;
    }
    if ("group" in target) return this.groupKnown(target.group) ? null : `There's no group ${quoted(target.group, 120)}: the groups are in the snapshot and list_groups`;
    return null;
  }

  private actionRefusal(a: { tool: string; args: Record<string, unknown> } | undefined): string | null {
    if (!a || typeof a !== "object" || typeof a.tool !== "string") return "it doesn't name a tool";
    const args = a.args ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) return "its args must be an object";
    const denied = ruleDenied(a.tool, args);
    if (denied) return denied;
    if (!this.runner) return "the Assistant isn't running, so its tools can't be checked";
    const tool = this.runner.ruleTool(a.tool);
    if (!tool) return "there's no such tool";
    if (!tool.rule) return "that tool can't be a standing rule's action: list_rules says which can";
    const bad = validateArgs(tool.inputSchema, args, "args");
    return bad ? `its ${bad}` : null;
  }

  private targetName(t: RuleTarget): string {
    if ("session" in t) {
      // named as every card names a session: a title alone can be changed, or be another's too
      const s = this.d.world.sessions().find((x) => x.id === t.session);
      return refLine(s?.title ?? this.titles.get(t.session) ?? null, t.session, s?.group ?? null);
    }
    if ("group" in t) return `any session in ${t.group}`;
    return "any session";
  }

  /** A rule turned on again, changed or removed starts over: no failures counted, no limit spell, no missing target. */
  private restart(id: string): void {
    this.failures.delete(id);
    this.limited.delete(id);
    this.missing.delete(id);
  }

  private changed(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        this.d.log("assistant rules: telling the sheet the rules changed", err);
      }
    }
  }

  /** notify and text_me: what only a rule's action can be (no turn calls them; they aren't in the registry). */
  private ruleOnlyTools(): AssistantTool[] {
    const TEXT: JsonSchema = { type: "string", minLength: 1, maxLength: 200, description: "What it says, fixed when the rule is made" };
    const schema = { type: "object" as const, properties: { text: TEXT }, required: ["text"], additionalProperties: false };
    /** What fired the run, for the notice: "“tests” finished · When tests finishes, tell me". */
    const context = () => (this.current ? `${this.current.event.text} · ${plainLine(this.current.rule.label, 120)}` : "A standing rule");
    /** The text whole on its line, and in a body too when the line can't show it as it is (a line break, a hidden character). */
    const said = (verb: string, text: string) => {
      const one = plainLine(text, TEXT.maxLength);
      return { line: `${verb}: “${one}”`, ...(one === text ? {} : { body: text }) };
    };
    return [
      defineTool<{ text: string }>({
        name: "notify",
        tier: "direct",
        rule: true,
        description: "A standing rule's action only: a desktop notification saying `text`, shown as the user's notification settings and quiet hours allow.",
        inputSchema: schema,
        label: (a) => `Notify me: “${plainLine(a.text, 80)}”`,
        describe: (a) => said("Notify me", a.text),
        run: (a) => {
          const at = new Date(this.now());
          const settings = this.d.settings();
          // as team chat's notices: notifications off or quiet hours mean none, and that's not a failure
          if (!shouldNotify({ settings, kind: "other", now: at })) return { text: inQuietHours(settings.quietHours, at) ? "Not shown: it's quiet hours" : "Not shown: notifications are off" };
          this.d.notify(plainLine(a.text, 120), context());
          return { text: "Notified you" };
        },
      }),
      defineTool<{ text: string }>({
        name: "text_me",
        tier: "direct",
        rule: true,
        description: "A standing rule's action only: an iMessage saying `text` to the user's own handle, through phone alerts (Settings → Notifications → Phone alerts), outside quiet hours.",
        inputSchema: schema,
        label: (a) => `Text me: “${plainLine(a.text, 80)}”`,
        describe: (a) => said("Text me", a.text),
        check: () => {
          const p = phoneSettings(this.d.settings().phoneAlerts);
          if (!normalizeHandle(p.handle)) return "Phone alerts aren't set up: enter your iMessage handle in Settings → Notifications → Phone alerts";
          if (!p.enabled) return "Phone alerts are off: turn them on in Settings → Notifications → Phone alerts";
          return null;
        },
        run: async (a) => {
          const settings = this.d.settings();
          if (inQuietHours(settings.quietHours, new Date(this.now()))) return { text: "Not sent: it's quiet hours" };
          const handle = normalizeHandle(phoneSettings(settings.phoneAlerts).handle);
          if (!handle) throw new Error("Phone alerts aren't set up: enter your iMessage handle in Settings → Notifications → Phone alerts");
          const text = alertLine(`Mockingbird: ${a.text} · ${context()}`, ALERT_MAX);
          if (!this.d.sender) {
            this.d.info(`assistant rules: text_me (a development build: logged, not sent): ${JSON.stringify(text)}`);
            return { text: "Logged, not sent: a development build never sends iMessages" };
          }
          await this.d.sender.send(handle, text);
          return { text: "Texted you" };
        },
      }),
    ];
  }
}
