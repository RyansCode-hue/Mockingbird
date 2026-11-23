import { randomUUID } from "crypto";
import { DEFAULT_ASSISTANT_MODEL, type AssistantCard, type AssistantModel, type AssistantRule, type AssistantStep, type AssistantTurn, type AssistantView, type RuleAction } from "../../shared/assistant";
import type { AuditEntry, AuditKind, AssistantSource } from "../../shared/team/audit";
import { plainLine } from "../../shared/team/agentText";
import { CardBook, type HeldCard } from "./cards";
import type { AssistantDeps } from "./deps";
import { validateArgs, type AssistantTool, type Registry, type ToolCard, type ToolResult } from "./registry";
import { describeAction, noRules, ruleDenied, type RulesStore } from "./rules";
import type { SavedThread, ThreadFile } from "./thread";
import { TurnRunner, UNAVAILABLE, type AssistantLimits, type SpawnRequest } from "./turns";
import { UndoBook } from "./undo";

/**
 * The app Assistant in main (docs/assistant.md): what the window's IPC and the Assistant's MCP calls reach. The tier
 * of every call is the registry's, enforced here and never by the model:
 * - read: runs, and returns its data;
 * - direct: checked, run, and kept with an Undo while what it changed is unchanged (undo.ts);
 * - confirm: runs nothing; it puts up a card (cards.ts), and only the user's Do it, checked again then, runs it.
 * Everything that runs from a direct step, a card, an Undo or a rule is recorded in the activity log (`assistant.action`).
 * The thread (turns and cards) is saved whenever it changes and read back at start-up (thread.ts); Undos aren't.
 */

/** A tool call answer, as messaging.ts's dispatch gives it to the MCP server. */
export type McpReply = { result: unknown } | { error: string };

export const CARD_SHOWN = "Card shown; the user decides. Don't propose it again.";

/** The calls one turn may make: a model that loops on its tools is stopped there. */
const MAX_STEPS = 40;
const SWEEP_MS = 15_000;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export interface AssistantServiceDeps {
  registry: Registry;
  /** Claude Code's binary, or null when it isn't installed. */
  claudeBin(): Promise<string | null>;
  /** One headless turn (launch.ts cliSpawner). */
  spawn(r: SpawnRequest): Promise<string>;
  /** What each turn's snapshot is read from (TurnRunnerDeps.world). */
  world: Pick<AssistantDeps, "sessions" | "groups" | "rooms"> & Partial<Pick<AssistantDeps, "heldPlans">>;
  /** The activity log (remoteAudit.ts). */
  audit: { record(kind: AuditKind, who: { session?: string; title?: string | null }, more?: Partial<AuditEntry>): void };
  /** The view changed (`assistant:changed`). */
  emit(): void;
  log(context: string, err: unknown): void;
  rules?: RulesStore;
  /** Where the thread is kept across quits (thread.ts ThreadFile); in memory only when absent. */
  thread?: Pick<ThreadFile, "load" | "save" | "problem" | "dismiss">;
  /** The model each turn runs (Settings → Assistant); Sonnet when absent. */
  model?: () => AssistantModel;
  /** Actions only a standing rule takes (ruleEngine.ts: notify, text_me): never a turn's tools, so not in the registry. */
  ruleOnly?: readonly AssistantTool[];
  now?: () => number;
  limits?: Partial<AssistantLimits>;
  spawnGraceMs?: number;
}

type Performed = { ok: true; result: ToolResult } | { ok: false; why: string; refused: boolean };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)) || "it failed without saying why";

export class AssistantService {
  private readonly registry: Registry;
  private readonly runner: TurnRunner;
  private readonly cards: CardBook;
  private readonly undos: UndoBook;
  private readonly rules: RulesStore;
  private readonly thread: AssistantServiceDeps["thread"] | null;
  private readonly ruleOnly: Map<string, AssistantTool>;
  private readonly now: () => number;
  private unavailable: string | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: AssistantServiceDeps) {
    this.registry = d.registry;
    this.now = d.now ?? Date.now;
    this.runner = new TurnRunner({
      claudeBin: d.claudeBin,
      spawn: d.spawn,
      world: d.world,
      toolNames: () => this.registry.names(),
      model: d.model,
      cardState: (id) => this.cards.get(id)?.card.state ?? null,
      changed: () => this.changed(),
      log: d.log,
      now: this.now,
      limits: d.limits,
      spawnGraceMs: d.spawnGraceMs,
    });
    this.cards = new CardBook({ now: this.now, cardMs: this.runner.limits.cardMs });
    this.undos = new UndoBook({ now: this.now, log: d.log });
    this.rules = d.rules ?? noRules();
    this.ruleOnly = new Map((d.ruleOnly ?? []).map((t) => [t.name, t]));
    for (const name of this.ruleOnly.keys()) if (this.registry.has(name)) throw new Error(`${name} is both an Assistant tool and a rule-only action`);
    this.rules.onChanged?.(() => this.changed());
    this.thread = d.thread ?? null;
    if (this.thread) {
      const saved = this.thread.load();
      this.runner.restore(saved.turns);
      this.cards.restore(saved.cards, (cardId) => this.runner.list().flatMap((t) => t.steps).find((s) => s.cardId === cardId)?.id);
      // what a quit cut short is saved as it loaded: stopped
      this.save();
    }
  }

  /** Expire cards and lapse Undos on a timer as well as on every change (stateChanged). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The app's state changed (sessions, groups, rooms): cards whose target changed expire, Undos that can't apply lapse. */
  stateChanged(): void {
    this.sweep();
  }

  // ---- the window (ASSISTANT_IPC) --------------------------------------------------------------

  async view(): Promise<AssistantView> {
    await this.checkAvailable();
    this.sweep();
    const rulesProblem = this.rules.problem?.() ?? null;
    const threadProblem = this.thread?.problem() ?? null;
    return {
      turns: structuredClone(this.runner.list()),
      cards: this.cards.view(),
      // each action as main spells it out now, from its arguments: the Rules list never shows only the model's label
      rules: this.rules.list().map((r) => ({ ...r, actions: r.actions.map((a) => ({ ...a, detail: describeAction(this.ruleTool(a.tool), a, this.d.world, this.d.log) })) })),
      runs: this.rules.runs(),
      busy: this.runner.busy(),
      ...(this.unavailable ? { unavailable: this.unavailable } : {}),
      ...(rulesProblem ? { rulesProblem } : {}),
      ...(threadProblem ? { threadProblem } : {}),
      model: this.d.model?.() ?? DEFAULT_ASSISTANT_MODEL,
    };
  }

  /** Settings → Assistant's model changed: the tab shows the one the next turn runs. */
  modelChanged(): void {
    this.changed();
  }

  async ask(text: unknown): Promise<{ turnId: string } | { error: string }> {
    if (typeof text !== "string") return { error: "Ask in words" };
    if (await this.checkAvailable()) return { error: this.unavailable! };
    return this.runner.ask(text);
  }

  /** The user's Do it: card `cardId`'s call is checked against the state now, and run. */
  async confirm(cardId: unknown): Promise<AssistantCard | { error: string }> {
    const h = this.heldCard(cardId);
    if ("error" in h) return h;
    // a card whose time ran out or whose target changed expires here, before anything can run
    this.sweep();
    if (h.card.state !== "open") return h.card.state === "expired" ? structuredClone(h.card) : { error: `That card is ${h.card.state} already` };
    const tool = this.registry.get(h.card.tool);
    if (!tool) return this.settleCard(h, "failed", `Mockingbird has no ${h.card.tool} tool any more, so nothing ran`);
    h.card.state = "running";
    h.card.blocked = null;
    this.changed();
    const r = await this.perform(tool, h.args, "card");
    if (r.ok) return this.settleCard(h, "done", plainLine(r.result.text, 300) || "Done");
    if (r.refused) {
      // the check says no now: the card stays, saying why, for the user to try again or cancel
      h.card.state = "open";
      h.card.blocked = r.why;
      this.changed();
      return structuredClone(h.card);
    }
    return this.settleCard(h, "failed", r.why);
  }

  cancel(cardId: unknown): AssistantCard | { error: string } {
    const h = this.heldCard(cardId);
    if ("error" in h) return h;
    if (h.card.state === "running") return { error: "It's running already" };
    if (h.card.state !== "open") return { error: `That card is ${h.card.state} already` };
    return this.settleCard(h, "cancelled", "Cancelled: nothing ran");
  }

  /** Put back what direct step `stepId` changed, while its Undo is offered. */
  async undo(stepId: unknown): Promise<AssistantStep | { error: string }> {
    if (typeof stepId !== "string" || !ID_RE.test(stepId)) return { error: "No such step" };
    const step = this.findStep(stepId);
    if (!step) return { error: "No such step: it may have been cleared" };
    let entry;
    try {
      entry = this.undos.take(stepId);
    } catch (err) {
      if (step.undoUntil !== undefined) {
        delete step.undoUntil;
        this.changed();
      }
      return { error: message(err) };
    }
    delete step.undoUntil;
    this.changed();
    try {
      const line = plainLine(await entry.undo(), 200);
      step.state = "undone";
      this.record(entry.tool, entry.target, "undo", `Undid ${entry.label}: ${line}`);
      this.changed();
      return { ...step };
    } catch (err) {
      this.d.log(`assistant: undoing step ${stepId} (${entry.tool})`, err);
      this.record(entry.tool, entry.target, "undo", `Undo of ${entry.label} failed: ${message(err)}`);
      this.changed();
      return { error: `It couldn't be undone: ${message(err)}` };
    }
  }

  ruleOn(ruleId: unknown, on: unknown): AssistantRule | { error: string } {
    if (typeof ruleId !== "string" || !ID_RE.test(ruleId)) return { error: "No such rule" };
    if (typeof on !== "boolean") return { error: "A rule is turned on or off" };
    let rule: AssistantRule | null;
    try {
      rule = this.rules.setOn(ruleId, on);
    } catch (err) {
      this.d.log(`assistant: turning rule ${ruleId} ${on ? "on" : "off"}`, err);
      return { error: `It couldn't be saved: ${message(err)}` };
    }
    if (!rule) return { error: "No such rule" };
    this.changed();
    return rule;
  }

  ruleRemove(ruleId: unknown): { ok: true } | { error: string } {
    if (typeof ruleId !== "string" || !ID_RE.test(ruleId)) return { error: "No such rule" };
    let removed: boolean;
    try {
      removed = this.rules.remove(ruleId);
    } catch (err) {
      this.d.log(`assistant: removing rule ${ruleId}`, err);
      return { error: `It couldn't be saved: ${message(err)}` };
    }
    if (!removed) return { error: "No such rule" };
    this.changed();
    return { ok: true };
  }

  /**
   * A fresh thread: finished turns go (a running or queued one stays), their Undos and settled cards with them; open
   * cards stay. The saved thread is cleared alike, and why an earlier one couldn't be read is said no more.
   */
  clear(): { ok: true } {
    this.runner.clear();
    const left = new Set(this.runner.list().map((t) => t.id));
    this.cards.clearSettled((c) => left.has(c.turnId));
    this.undos.clear((stepId) => !!this.findStep(stepId));
    this.thread?.dismiss();
    this.changed();
    return { ok: true };
  }

  // ---- the Assistant's MCP caller (messaging.ts) -------------------------------------------------

  /** Whether `op` is one of the Assistant's tools: messaging refuses those to every other caller. */
  owns(op: string): boolean {
    return this.registry.has(op);
  }

  /** tools/list for the turn MCP caller `identity` is for, while it runs. */
  mcpList(identity: string): McpReply {
    if (!this.runner.running(identity)) return { error: "This Assistant turn has ended, so its tools have stopped." };
    return { result: { tools: this.registry.mcpTools() } };
  }

  /** One tool call of the running turn `identity` is for: by its tier, never by what the model asks. */
  async mcpCall(identity: string, op: string, args: Record<string, unknown>): Promise<McpReply> {
    const turn = this.runner.running(identity);
    if (!turn) return { error: "This Assistant turn has ended, so its tools have stopped." };
    const tool = this.registry.get(op);
    if (!tool) return { error: `${JSON.stringify(plainLine(op, 60))} isn't one of the Assistant's tools.` };
    if (turn.steps.length >= MAX_STEPS) return { error: `This turn has made ${MAX_STEPS} calls, the most one turn may: stop, and tell the user where things stand.` };
    const bad = validateArgs(tool.inputSchema, args);
    const step: AssistantStep = { id: `st-${randomUUID()}`, tool: tool.name, tier: tool.tier, label: bad ? tool.name : this.labelOf(tool, args), state: "running" };
    turn.steps.push(step);
    this.changed();
    if (bad) return this.failStep(step, `The call's ${bad}`);
    if (tool.tier === "confirm") return this.propose(turn, step, tool, args);
    const r = await this.perform(tool, args, tool.tier === "direct" ? "step" : null);
    if (!r.ok) return this.failStep(step, r.why);
    step.state = "done";
    if (tool.tier === "direct") this.keepUndo(step, tool, args, r.result);
    else if (r.result.undo) this.d.log("assistant", `the read tool ${tool.name} returned an Undo, which only direct tools keep`);
    this.changed();
    return { result: r.result.text };
  }

  // ---- standing rules' actions ---------------------------------------------------------------

  /**
   * A standing rule's action, run as the rule's (ruleEngine.ts): only a tool marked `rule` that the deny list doesn't
   * name (rules.ts RULE_DENY_LIST), or a rule-only action, its arguments checked against its schema and its guards
   * checked now, those a tool keeps for a rule's run among them (CallContext), and recorded in the activity log as
   * rule `rule`'s (its label). No card: the rule was made through one.
   */
  async runAction(a: RuleAction, rule?: string): Promise<{ ok: boolean; text: string; step: AssistantStep }> {
    const tool = this.ruleTool(a.tool);
    const step: AssistantStep = { id: `st-${randomUUID()}`, tool: a.tool, tier: tool?.tier ?? "confirm", label: plainLine(a.label, 160) || a.tool, state: "running" };
    const fail = (why: string) => {
      step.state = "failed";
      step.error = why;
      return { ok: false, text: why, step };
    };
    if (!tool) return fail(`Mockingbird has no ${a.tool} tool any more`);
    if (!tool.rule) return fail(`${tool.name} can't be a standing rule's action`);
    const bad = validateArgs(tool.inputSchema, a.args);
    if (bad) return fail(`The rule's ${bad}`);
    const denied = ruleDenied(tool.name, a.args);
    if (denied) return fail(denied);
    const r = await this.perform(tool, a.args, "rule", rule ? `Rule “${plainLine(rule, 80)}”: ` : "");
    if (!r.ok) return fail(r.why);
    step.state = "done";
    return { ok: true, text: r.result.text, step };
  }

  /** The tool a standing rule's action names: a registry tool, or an action only rules take. */
  ruleTool(name: string): AssistantTool | undefined {
    return this.registry.get(name) ?? this.ruleOnly.get(name);
  }

  /** Every tool a standing rule may use: those marked `rule` that the deny list doesn't name, and the rule-only actions. */
  ruleTools(): AssistantTool[] {
    return [...this.registry.list(), ...this.ruleOnly.values()].filter((t) => t.rule && !ruleDenied(t.name, {}));
  }

  // ---- inside --------------------------------------------------------------------------------

  private async checkAvailable(): Promise<boolean> {
    let bin: string | null;
    try {
      bin = await this.d.claudeBin();
    } catch (err) {
      this.d.log("assistant: looking for Claude Code", err);
      bin = null;
    }
    const was = this.unavailable;
    this.unavailable = bin ? undefined : UNAVAILABLE;
    if (was !== this.unavailable) this.changed();
    return !!this.unavailable;
  }

  /** A confirm call: nothing runs. Its guards are checked so the card can say why it can't be done now. */
  private async propose(turn: AssistantTurn, step: AssistantStep, tool: AssistantTool, args: Record<string, unknown>): Promise<McpReply> {
    let blocked: string | null;
    let card: ToolCard;
    try {
      blocked = (await tool.check?.(args, { rule: false })) ?? null;
      card = tool.card ? await tool.card(args) : { title: step.label, detail: step.label, warnings: [] };
    } catch (err) {
      this.d.log(`assistant: making a card for ${tool.name}`, err);
      return this.failStep(step, `Its card couldn't be made: ${message(err)}`);
    }
    const c = this.cards.open({ turnId: turn.id, stepId: step.id, tool: tool.name, args, card, blocked });
    step.state = "proposed";
    step.cardId = c.id;
    this.changed();
    return { result: blocked ? `Card shown, though it can't be done now: ${blocked}. The user decides. Don't propose it again.` : CARD_SHOWN };
  }

  /**
   * Check, then run, one call. Recorded in the activity log as from `source` once it runs (a read, `source` null, isn't),
   * its outcome after `prefix` (a rule's name).
   */
  private async perform(tool: AssistantTool, args: Record<string, unknown>, source: AssistantSource | null, prefix = ""): Promise<Performed> {
    const ctx = { rule: source === "rule" };
    let why: string | null;
    try {
      why = (await tool.check?.(args, ctx)) ?? null;
    } catch (err) {
      this.d.log(`assistant: checking ${tool.name}`, err);
      return { ok: false, why: `Mockingbird couldn't check whether it can be done: ${message(err)}`, refused: false };
    }
    if (why) return { ok: false, why, refused: true };
    const label = this.labelOf(tool, args);
    const target = this.targetOf(tool, args);
    try {
      const result = await tool.run(args, ctx);
      if (typeof result?.text !== "string") throw new Error(`${tool.name} answered without saying what it did`);
      if (source) this.record(tool.name, target, source, `${prefix}${label}: done`);
      return { ok: true, result };
    } catch (err) {
      this.d.log(`assistant: running ${tool.name}`, err);
      if (source) this.record(tool.name, target, source, `${prefix}${label}: failed: ${message(err)}`);
      return { ok: false, why: message(err), refused: false };
    }
  }

  private keepUndo(step: AssistantStep, tool: AssistantTool, args: Record<string, unknown>, r: ToolResult): void {
    if (!r.undo) return;
    const until = this.now() + this.runner.limits.undoMs;
    this.undos.add(step.id, { tool: tool.name, label: step.label, target: this.targetOf(tool, args), until, undo: r.undo, stillUndoable: r.stillUndoable });
    // a change that was put back already (or never stuck) has nothing to undo
    if (this.undos.refusal(step.id)) {
      this.undos.sweep();
      return;
    }
    step.undoUntil = until;
  }

  private failStep(step: AssistantStep, why: string): McpReply {
    step.state = "failed";
    step.error = why;
    this.changed();
    return { error: why };
  }

  private settleCard(h: HeldCard, state: "done" | "failed" | "cancelled" | "expired", result: string): AssistantCard {
    const card = this.cards.settle(h.card.id, state, result)!;
    const step = this.findStep(h.stepId);
    if (step && (state === "done" || state === "failed")) {
      step.state = state;
      if (state === "failed") step.error = result;
    }
    this.changed();
    return structuredClone(card);
  }

  private heldCard(cardId: unknown): HeldCard | { error: string } {
    const h = typeof cardId === "string" && ID_RE.test(cardId) ? this.cards.get(cardId) : undefined;
    return h ?? { error: "No such card: it may have been settled and cleared" };
  }

  private findStep(stepId: string): AssistantStep | undefined {
    for (const t of this.runner.list()) {
      const s = t.steps.find((x) => x.id === stepId);
      if (s) return s;
    }
    return undefined;
  }

  private stillValid(tool: AssistantTool, args: Record<string, unknown>): boolean {
    if (!tool.stillValid) return true;
    try {
      return tool.stillValid(args);
    } catch (err) {
      this.d.log(`assistant: checking whether a ${tool.name} card still applies`, err);
      return false;
    }
  }

  private labelOf(tool: AssistantTool, args: Record<string, unknown>): string {
    try {
      return plainLine(tool.label(args), 160) || tool.name;
    } catch (err) {
      this.d.log(`assistant: labelling a ${tool.name} step`, err);
      return tool.name;
    }
  }

  private targetOf(tool: AssistantTool, args: Record<string, unknown>) {
    try {
      return tool.target?.(args) ?? null;
    } catch (err) {
      this.d.log(`assistant: naming a ${tool.name} step's target`, err);
      return null;
    }
  }

  private record(tool: string, target: { session: string; title?: string | null } | null, source: AssistantSource, outcome: string): void {
    try {
      this.d.audit.record("assistant.action", target ? { session: target.session, title: target.title ?? null } : {}, { tool, source, outcome: plainLine(outcome, 300) });
    } catch (err) {
      this.d.log(`assistant: recording ${tool} in the activity log`, err);
    }
  }

  /** Expire cards and lapse Undos whose time or target has passed; tell the window when any did. */
  private sweep(): void {
    let changed =
      this.cards.sweep((h) => {
        const tool = this.registry.get(h.card.tool);
        return !!tool && this.stillValid(tool, h.args);
      }).length > 0;
    for (const stepId of this.undos.sweep()) {
      const step = this.findStep(stepId);
      if (step?.undoUntil !== undefined) {
        delete step.undoUntil;
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  /** The thread as it's saved: what the window shows of it, Undos aside. */
  private saved(): SavedThread {
    return { turns: this.runner.list(), cards: this.cards.view() };
  }

  /** Save the thread (ThreadFile.save logs and names its own failures; anything else it throws is logged here). */
  private save(): void {
    try {
      this.thread?.save(this.saved());
    } catch (err) {
      this.d.log("assistant: saving the thread", err);
    }
  }

  private changed(): void {
    this.save();
    try {
      this.d.emit();
    } catch (err) {
      this.d.log("assistant: telling the window its view changed", err);
    }
  }
}
