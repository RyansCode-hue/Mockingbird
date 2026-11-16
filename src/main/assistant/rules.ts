import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AssistantRule, RuleAction, RuleRun, RuleTarget, RuleTrigger } from "../../shared/assistant";
import { isMissing, writeFileAtomic } from "../fileOps";
import type { JsonSchema } from "./registry";

/**
 * The Assistant's standing rules (docs/assistant.md → Standing rules): what the service reads and changes (RulesStore),
 * their shape, the actions a rule may never take, and the file they're kept in (RuleBook). ruleEngine.ts watches their
 * triggers and runs them; each action goes through AssistantService.runAction, which checks the tool's guards and
 * records it in the activity log.
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
  /** Why the rules file couldn't be read as it was, and where it was kept: shown in the sheet. Null when it could. */
  problem?(): string | null;
}

/** No rules, and nowhere to keep one. */
export function noRules(): RulesStore {
  return { list: () => [], runs: () => [], setOn: () => null, remove: () => false };
}

// ---- what the rule tools (tools/rules.ts) reach -------------------------------------------------

/** A rule as propose_rule and change_rule name it. Each action's label is main's, from its tool, never the model's. */
export interface RuleDraft {
  label: string;
  trigger: RuleTrigger;
  actions: { tool: string; args: Record<string, unknown> }[];
}

/** The standing rules as the rule tools list, make, change, switch and remove them (ruleEngine.ts). */
export interface RulesApi {
  list(): AssistantRule[];
  get(id: string): AssistantRule | null;
  /** Why `draft` can't be a rule now (its trigger, its target, an action, the limits), or null. `replacing`: the rule it changes. */
  refusal(draft: RuleDraft, replacing?: string): string | null;
  /** The trigger in plain words: "When “tests” finishes a turn". */
  describe(trigger: RuleTrigger): string;
  /** The draft's actions as the rule keeps them: each with its tool's label (an unknown tool's is its name). */
  actions(draft: RuleDraft): RuleAction[];
  /** Save `draft` as a new rule, on. Throws why not. */
  add(draft: RuleDraft): AssistantRule;
  /** Replace rule `id`'s label, trigger and actions with the draft's; it stays on or off as it was, and unpaused. Throws why not. */
  change(id: string, draft: RuleDraft): AssistantRule;
  /** As RulesStore.setOn. */
  setOn(id: string, on: boolean): AssistantRule | null;
  /** Rule `id` on or off and paused as `state` says: an Undo of setOn. Throws why not. */
  putBack(id: string, state: { on: boolean; paused: string | null }): AssistantRule;
  /** Remove rule `id`: it and where it was, or null when there's no such rule. Throws when it can't be saved. */
  take(id: string): { rule: AssistantRule; index: number } | null;
  /** Put a removed rule back where it was: an Undo of take. Throws why not. */
  restore(rule: AssistantRule, index: number): void;
  /** The tools a rule's action may name, with what each takes. */
  usable(): { tool: string; description: string; inputSchema: JsonSchema }[];
}

// ---- never a rule's action ---------------------------------------------------------------------

/**
 * What a standing rule may never do, whatever a tool's `rule` says (docs/assistant.md → Standing rules). A rule acts
 * without asking each time, so nothing here may be one of its actions: each is either a standing yes to whatever a
 * session asks next, or can't be taken back. Matched by tool name (each family's names, so a tool named a little
 * differently is still caught) and by arguments, wherever they appear.
 */
export const RULE_DENY_LIST: readonly { what: string; tool?: RegExp; args?: (args: Record<string, unknown>) => boolean }[] = [
  { what: "answering prompts (that would be a standing yes to every prompt)", tool: /^(answer|allow|deny|approve)_(a_)?(prompt|permission)s?$/ },
  { what: "restarting or starting a session in bypass mode", args: (a) => [a.mode, a.permissionMode].some((m) => m === "bypass" || m === "bypassPermissions") },
  { what: "closing a session with forget", args: (a) => a.forget === true },
  { what: "cleaning up a worktree", tool: /^(clean_?up|remove|delete)_worktrees?$/ },
  { what: "pushing", tool: /(^|_)push(_|$)/ },
  { what: "opening a pull request", tool: /(^|_)(pr|prs|pull_request|pull_requests)$|^(open|create|make)_(pr|pull_request)(_|$)/ },
  { what: "leaving a room", tool: /^leave_(the_)?room$/ },
  { what: "taking over a session", tool: /^take_?over(_|$)/ },
];

/** Why `tool` with `args` can never be a standing rule's action, or null when the deny list allows it. */
export function ruleDenied(tool: string, args: Record<string, unknown>): string | null {
  for (const d of RULE_DENY_LIST) {
    if ((d.tool && d.tool.test(tool)) || (d.args && d.args(args))) return `A standing rule can't do this (${d.what})`;
  }
  return null;
}

// ---- shape -------------------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const AT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const RULE_LABEL_MAX = 160;
const KINDS = ["finished", "waiting", "exited", "daily"] as const;
/** The longest a waiting trigger waits: a day. */
export const WAITING_MAX_MINUTES = 1440;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const extra = (o: Record<string, unknown>, allowed: string[], at: string): string | null => {
  const bad = Object.keys(o).find((k) => !allowed.includes(k));
  return bad ? `${at}.${bad} isn't part of it` : null;
};

/** Why `t` isn't a rule target (a session, a group, or any session), or null. */
export function targetShape(t: unknown, at = "trigger.target"): string | null {
  if (!isObject(t)) return `${at} must name a session, a group, or any session`;
  const keys = Object.keys(t);
  if (keys.length !== 1) return `${at} must name exactly one of: a session, a group, or any session`;
  if ("session" in t) return typeof t.session === "string" && ID_RE.test(t.session) ? null : `${at}.session must be a session's id`;
  if ("group" in t) return typeof t.group === "string" && t.group.trim().length > 0 && t.group.length <= 200 ? null : `${at}.group must be a group's key`;
  if ("any" in t) return t.any === true ? null : `${at}.any must be true`;
  return `${at} must name a session, a group, or any session`;
}

/** Why `t` isn't a rule trigger, or null. Triggers are app state only: a turn finished, waiting N minutes, exited, a time of day. */
export function triggerShape(t: unknown, at = "trigger"): string | null {
  if (!isObject(t)) return `${at} must be an object`;
  if (!KINDS.includes(t.kind as (typeof KINDS)[number])) return `${at}.kind must be one of ${KINDS.join(", ")}`;
  switch (t.kind) {
    case "finished":
    case "exited":
      return extra(t, ["kind", "target"], at) ?? targetShape(t.target, `${at}.target`);
    case "waiting":
      if (typeof t.minutes !== "number" || !Number.isInteger(t.minutes) || t.minutes < 1 || t.minutes > WAITING_MAX_MINUTES) return `${at}.minutes must be a whole number of minutes, 1 to ${WAITING_MAX_MINUTES}`;
      return extra(t, ["kind", "target", "minutes"], at) ?? targetShape(t.target, `${at}.target`);
    case "daily": {
      if (typeof t.at !== "string" || !AT_RE.test(t.at)) return `${at}.at must be a time as HH:MM (24-hour)`;
      if (t.days !== undefined) {
        const days = t.days;
        if (!Array.isArray(days) || !days.length || days.length > 7) return `${at}.days must list 1 to 7 weekdays`;
        if (days.some((d) => typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 6)) return `${at}.days must be weekdays 0 (Sunday) to 6 (Saturday)`;
        if (new Set(days).size !== days.length) return `${at}.days lists a weekday twice`;
      }
      return extra(t, ["kind", "at", "days"], at);
    }
  }
  return null;
}

/** The trigger's target, or null for a daily trigger. */
export const targetOf = (t: RuleTrigger): RuleTarget | null => (t.kind === "daily" ? null : t.target);

/** `raw` as a rule read from the file, or why it isn't one. */
export function parseRule(raw: unknown): AssistantRule | string {
  if (!isObject(raw)) return "a rule isn't an object";
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) return "a rule has no usable id";
  const at = `rule ${raw.id}`;
  if (typeof raw.label !== "string" || !raw.label.trim() || raw.label.length > RULE_LABEL_MAX * 2) return `${at} has no label`;
  const why = triggerShape(raw.trigger, `${at}'s trigger`);
  if (why) return why;
  if (!Array.isArray(raw.actions) || !raw.actions.length) return `${at} has no actions`;
  for (const a of raw.actions) {
    if (!isObject(a) || typeof a.tool !== "string" || !TOOL_RE.test(a.tool) || !isObject(a.args) || typeof a.label !== "string") return `${at} has an action that isn't one`;
  }
  if (typeof raw.on !== "boolean") return `${at} isn't on or off`;
  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) return `${at} has no creation time`;
  if (raw.paused !== undefined && raw.paused !== null && typeof raw.paused !== "string") return `${at}'s pause isn't a reason`;
  const last = raw.lastRun;
  if (last !== undefined && last !== null && (!isObject(last) || typeof last.at !== "number" || typeof last.ok !== "boolean" || typeof last.text !== "string")) return `${at}'s last run isn't one`;
  return {
    id: raw.id,
    label: raw.label,
    trigger: structuredClone(raw.trigger) as RuleTrigger,
    actions: (raw.actions as Record<string, unknown>[]).map((a) => ({ tool: a.tool as string, args: structuredClone(a.args) as Record<string, unknown>, label: a.label as string })),
    on: raw.on,
    createdAt: raw.createdAt,
    paused: (raw.paused as string | null | undefined) ?? null,
    lastRun: last ? { at: last.at as number, ok: last.ok as boolean, text: last.text as string } : null,
  };
}

// ---- the file ----------------------------------------------------------------------------------

/** Where the rules are kept. */
export const rulesFile = (): string => path.join(os.homedir(), ".mockingbird", "assistant-rules.json");

const FILE_VERSION = 1;
const tilde = (p: string): string => (p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p);
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The rules as `~/.mockingbird/assistant-rules.json` keeps them, written whole and atomically on every change. A file
 * that can't be read, isn't JSON, or holds a rule that isn't one is never overwritten: it's renamed aside
 * (`<file>.corrupt-<time>`), logged, and named in the sheet (problem()); whatever rules in it could be read are kept.
 * A file that can't even be moved aside leaves the rules unchangeable, so no save can replace it.
 */
export class RuleBook {
  private rules: AssistantRule[] = [];
  private trouble: string | null = null;
  private stuck = false;

  constructor(private readonly o: { file: string; log: (context: string, err: unknown) => void; now?: () => number }) {
    this.load();
  }

  /** Why the file couldn't be read as it was, and where it went; null when it could. */
  problem(): string | null {
    return this.trouble;
  }

  list(): AssistantRule[] {
    return structuredClone(this.rules);
  }

  get(id: string): AssistantRule | null {
    const r = this.rules.find((x) => x.id === id);
    return r ? structuredClone(r) : null;
  }

  /** Change the rules with `edit` (on a copy), then save: the change is kept only once it's saved. Throws why not. */
  change(edit: (rules: AssistantRule[]) => void): void {
    if (this.stuck) throw new Error(`Rules can't be changed now: ${this.trouble}`);
    const next = structuredClone(this.rules);
    edit(next);
    this.save(next);
    this.rules = next;
  }

  /**
   * Rule `id`'s run record or pause, which Mockingbird writes as rules run: kept in memory even when it can't be saved
   * (the sheet shows it), and the failed save logged; the next save that works writes it.
   */
  note(id: string, patch: Pick<Partial<AssistantRule>, "paused" | "lastRun">): AssistantRule | null {
    const r = this.rules.find((x) => x.id === id);
    if (!r) return null;
    Object.assign(r, structuredClone(patch));
    if (this.stuck) return structuredClone(r);
    try {
      this.save(this.rules);
    } catch (err) {
      this.o.log(`assistant rules: saving rule ${id}'s last run in ${this.o.file}`, err);
    }
    return structuredClone(r);
  }

  private save(rules: AssistantRule[]): void {
    writeFileAtomic(this.o.file, `${JSON.stringify({ version: FILE_VERSION, rules }, null, 2)}\n`, 0o600);
  }

  private load(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.o.file, "utf8");
    } catch (err) {
      if (isMissing(err)) return;
      return this.setAside(`it couldn't be read (${message(err)})`, []);
    }
    if (!text.trim()) return;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return this.setAside(`it isn't valid JSON (${message(err)})`, []);
    }
    if (!isObject(data) || !Array.isArray(data.rules)) return this.setAside("it doesn't hold a list of rules", []);
    if (typeof data.version === "number" && data.version > FILE_VERSION) return this.setAside(`a newer Mockingbird wrote it (version ${data.version})`, []);
    const kept: AssistantRule[] = [];
    const bad: string[] = [];
    for (const raw of data.rules) {
      const r = parseRule(raw);
      if (typeof r === "string") bad.push(r);
      else if (kept.some((k) => k.id === r.id)) bad.push(`rule ${r.id} is in it twice`);
      else kept.push(r);
    }
    if (bad.length) return this.setAside(`${bad.length} of its ${data.rules.length} rules couldn't be read (${bad[0]})`, kept);
    this.rules = kept;
  }

  /** The file as it is, renamed aside; `kept` (what could be read of it) saved in its place. */
  private setAside(why: string, kept: AssistantRule[]): void {
    const aside = `${this.o.file}.corrupt-${(this.o.now ?? Date.now)()}`;
    this.rules = kept;
    const read = kept.length ? `The ${kept.length} rule${kept.length === 1 ? "" : "s"} that could be read ${kept.length === 1 ? "is" : "are"} kept` : "Mockingbird started with no rules";
    try {
      fs.renameSync(this.o.file, aside);
    } catch (err) {
      this.stuck = true;
      this.trouble = `Your rules file (${tilde(this.o.file)}) couldn't be read: ${why}. It couldn't be moved aside either (${message(err)}), so rules can't be changed until it's fixed or removed.`;
      this.o.log("assistant rules", new Error(this.trouble));
      return;
    }
    this.trouble = `Your rules file couldn't be read: ${why}. It's kept as ${tilde(aside)}. ${read}.`;
    this.o.log("assistant rules", new Error(this.trouble));
    if (!kept.length) return;
    try {
      this.save(kept);
    } catch (err) {
      this.o.log(`assistant rules: saving the rules that could be read to ${this.o.file}`, err);
    }
  }
}
