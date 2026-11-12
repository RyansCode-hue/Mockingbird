import { isObj } from "./landscape";
import { fencedTicket, startsAtOrchestrator, TEMPLATE_AGENTS, type LayOutReply, type TemplateAgent, type TemplateBody } from "./pipelineTemplates";
import { oneLine, quoted } from "./team/agentText";
import { isRemotePaneId } from "./team/livePanes";
import { hiddenTextRefusal } from "./hiddenText";
import { AGENT_KINDS, AGENT_NAME, type AgentKind, type ModelCatalog } from "./types";
import { carriesWork, DEFAULT_ROUNDS, linkRefusal, WIRE_GATES, WIRE_TYPES, WIRE_WHENS, type Wire, type WireGate, type WireType, type WireWhen } from "./wires";

/**
 * The Orchestrator's plan (docs/landscape-wires.md, W17; section 4, "The Orchestrator and its plan"): the workspaces and
 * wires an Orchestrator proposes with propose_plan, held in main (src/main/plans.ts) until the user lays it out from
 * the template picker, which shows all of it. Nothing exists before that click: the plan is a proposal, kept apart from
 * the wire book, and everything here is checked again in main on what the dialog sent back.
 *
 * The plan is agent-written text, read from a ticket others wrote. So it's read strictly (a field this version doesn't
 * know is refused: there's none for launch arguments, environment, extra folders or a permission mode), held to the
 * limits below, and may name only its own steps, "me" (its Orchestrator) or a workspace of this Mac's in its area that
 * a wire may reach (no teammate's, taken-over, debrief or Tasks workspace).
 */

/**
 * Section 4's limits: at most 6 new workspaces and 12 wires; a prompt as long as a message (messaging.ts' MAX_MESSAGE);
 * a name one line of 40; the summary 2,000; a feedback wire's rounds 1 to 5.
 */
export const PLAN_MAX = { steps: 6, wires: 12, prompt: 8000, name: 40, summary: 2000, rounds: 5, model: 80 } as const;

/** What a plan calls its own Orchestrator. */
export const ME = "me";

/** Where a step works: in its Orchestrator's folder (its worktree, on the ticket's branch), a worktree of its own, or an earlier step's folder. */
export type PlanFolder = "orchestrator" | "new" | { sameAs: string };

export interface PlanStep {
  key: string;
  name: string;
  agent: TemplateAgent;
  model?: string;
  effort?: string;
  /** A new worktree's repo, one of its area's; left out, its Orchestrator's. Only with folder "new". */
  repo?: string;
  folder: PlanFolder;
  /** What it's told as it starts, `{ticket}` filled in at Lay out; a terminal's command, which takes no `{ticket}`. */
  prompt: string;
}

/** A wire of the plan: its ends a step's key, ME, or an existing workspace's id in the area. */
export interface PlanWire {
  from: string;
  to: string;
  type: WireType;
  when?: WireWhen;
  gate?: WireGate;
  template?: string;
  rounds?: number;
  toolOutput?: false;
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
  wires: PlanWire[];
}

/** Why a plan, or part of one, can't be held or laid out: said as it is, to the agent or in the dialog. */
export class PlanError extends Error {
  constructor(what: string) {
    super(what);
    this.name = "PlanError";
  }
}
const bad = (what: string): never => {
  throw new PlanError(what);
};

// ---- reading -----------------------------------------------------------------------------

/** How a plan is spelled: propose_plan's arguments (same_as, tool_output), or as main holds it and the window sends it. */
type Spelling = "tool" | "window";
type Read<T> = (v: unknown, what: string) => T;
const KEY_RE = /^[A-Za-z0-9_-]{1,24}$/;
const nOf = (n: number) => n.toLocaleString("en-US");

const text =
  (max: number): Read<string> =>
  (v, what) =>
    typeof v !== "string" ? bad(`${what} isn't text.`) : v.length > max ? bad(`${what} is ${nOf(v.length)} characters; the limit is ${nOf(max)}.`) : v;
const line =
  (max: number): Read<string> =>
  (v, what) => {
    const t = text(max * 4)(v, what);
    if (/[\r\n]/.test(t)) bad(`${what} is more than one line.`);
    const s = oneLine(t, max * 4);
    return !s ? bad(`${what} is empty.`) : s.length > max ? bad(`${what} is ${s.length} characters; the limit is ${max}.`) : s;
  };
const key: Read<string> = (v, what) =>
  typeof v === "string" && KEY_RE.test(v) ? (v === ME ? bad(`${what} is "${ME}", which names the Orchestrator itself: give the step a key of its own.`) : v) : bad(`${what} isn't a step's key (letters, digits, - or _, up to 24).`);
const end: Read<string> = (v, what) => (typeof v === "string" && v.length > 0 && v.length <= 64 && !/[\s\u0000-\u001f]/.test(v) ? v : bad(`${what} isn't a step's key, "${ME}" or a workspace's id.`));
const oneOf =
  <T extends string>(allowed: readonly T[]): Read<T> =>
  (v, what) =>
    allowed.includes(v as T) ? (v as T) : bad(`${what} isn't ${allowed.join(", ").replace(/, ([^,]*)$/, " or $1")}.`);
const rounds: Read<number> = (v, what) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= PLAN_MAX.rounds ? (v as number) : bad(`${what} isn't a whole number from 1 to ${PLAN_MAX.rounds}.`));
const onlyFalse: Read<false> = (v, what) => (v === false ? false : bad(`${what} is only ever false: a context link reads tool output unless it's set to leave it out.`));
const folderOf =
  (sp: Spelling): Read<PlanFolder> =>
  (v, what) => {
    if (v === "orchestrator" || v === "new") return v;
    const same = sp === "tool" ? "same_as" : "sameAs";
    if (isObj(v) && Object.keys(v).length === 1 && same in v) return { sameAs: key((v as Record<string, unknown>)[same], what) };
    return bad(`${what} isn't "orchestrator", "new" or { ${same}: <an earlier step's key> }.`);
  };

/** `v`'s fields by `fields`, each checked; a field it doesn't know is refused, and the required ones must be there. */
function read<T>(v: unknown, what: string, fields: Record<string, Read<unknown>>, required: readonly string[]): T {
  if (!isObj(v)) bad(`${what} isn't an object.`);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!Object.hasOwn(fields, k)) bad(`${what} has a field a plan doesn't have (${quoted(k, 40)}): it takes ${Object.keys(fields).join(", ")}, nothing else.`);
    if (x !== undefined && x !== null) out[k] = fields[k](x, `${what}'s ${k}`);
  }
  for (const k of required) if (out[k] === undefined) bad(`${what} has no ${k}.`);
  return out as T;
}

const list = (v: unknown, what: string, max: number): unknown[] => {
  if (!Array.isArray(v)) bad(`${what} aren't a list.`);
  if ((v as unknown[]).length > max) bad(`It proposes ${(v as unknown[]).length} ${what.toLowerCase().replace(/^its /, "")}: a plan has at most ${max}.`);
  return v as unknown[];
};

function readAs(v: unknown, sp: Spelling): Plan {
  const o = read<{ summary: string; steps: unknown; wires: unknown }>(v, "The plan", { summary: text(PLAN_MAX.summary), steps: (x) => x, wires: (x) => x }, ["summary", "steps", "wires"]);
  const steps = list(o.steps, "Its steps", PLAN_MAX.steps).map((s, i) =>
    read<PlanStep>(
      s,
      `Step ${i + 1}`,
      { key, name: line(PLAN_MAX.name), agent: oneOf(TEMPLATE_AGENTS), model: line(PLAN_MAX.model), effort: line(PLAN_MAX.model), repo: text(1024), folder: folderOf(sp), prompt: text(PLAN_MAX.prompt) },
      ["key", "name", "agent", "folder", "prompt"]
    )
  );
  const toolOutput = sp === "tool" ? "tool_output" : "toolOutput";
  const wires = list(o.wires, "Its wires", PLAN_MAX.wires).map((w, i) => {
    const r = read<Record<string, unknown>>(
      w,
      `Wire ${i + 1}`,
      { from: end, to: end, type: oneOf(WIRE_TYPES), when: oneOf(WIRE_WHENS), gate: oneOf(WIRE_GATES), template: text(PLAN_MAX.prompt), rounds, [toolOutput]: onlyFalse },
      ["from", "to", "type"]
    );
    const { [toolOutput]: out, ...rest } = r;
    return { ...rest, ...(out === false ? { toolOutput: false as const } : {}) } as PlanWire;
  });
  return { summary: o.summary, steps, wires };
}

/** propose_plan's arguments as a plan, read strictly (same_as, tool_output): PlanError says what's wrong. */
export const readPlanArgs = (v: unknown): Plan => readAs(v, "tool");
/** A plan as main holds it, or as the dialog sent it back at Lay out, read strictly: PlanError says what's wrong. */
export const readShownPlan = (v: unknown): Plan => readAs(v, "window");

// ---- the rules -----------------------------------------------------------------------------

/** A workspace a plan names that's there already: its Orchestrator, or one of this Mac's in its area. */
export interface PlanEnd {
  id: string;
  title: string;
  kind: "agent" | "terminal";
  agent: AgentKind | null;
  repo: string | null;
  branch: string | null;
  ticket: string | null;
  /** Why a plan can't name it (a teammate's, taken over, a debrief, the Tasks workspace), or null when it can. */
  refusal: string | null;
}

/** What a plan is checked against: its Orchestrator, its area's workspaces and repos, and this Mac's agents and models. */
export interface PlanContext {
  me: PlanEnd;
  /** The workspaces of its area, by id, besides its Orchestrator: running, closed or not started. */
  existing: Readonly<Record<string, PlanEnd>>;
  installed: readonly AgentKind[];
  /** The models and efforts this Mac's agents offer (models:catalog); null when it can't be read, when a plan can name none. */
  catalog: ModelCatalog | null;
  /** Its area's repos: a new worktree is made only in one of these. */
  repos: readonly string[];
  /** Its area is a team room's: every gate asks, and its steps are room sessions. */
  room: boolean;
  ticket: string | null;
}

export interface PlanStepOut {
  step: PlanStep;
  /** Started as it's laid out, with its prompt: nothing but its Orchestrator hands off to it. Else not started (W8), waiting for its handoff. */
  starts: boolean;
  /** The repo it works in: a new worktree's, or the folder it shares'. */
  repo: string | null;
  /** What it says of where it works and how it starts. */
  where: string;
  says: string;
  /** A terminal: laid out on its agent's tree when that's its Orchestrator or a step that starts, else not, saying why. */
  terminal: { laid: boolean; why: string } | null;
}
export interface PlanWireOut {
  wire: PlanWire;
  /** The gate it's made with: asking in a team room's area, whatever the plan says. */
  gate: WireGate;
  /** An automatic gate laid out as ask (a team room's area). */
  forced: boolean;
  /** A handoff from its Orchestrator to a step that starts: Lay out sends it, as the step's own prompt, and it's counted sent. */
  sentByLayOut: boolean;
  /** Made once its source has started: when its PR merges, or a terminal on the tree of a step that starts. */
  afterStart: boolean;
  /** Not made: a terminal's wire whose terminal isn't laid out. */
  skipped: boolean;
}
export interface PlanLayOut {
  steps: PlanStepOut[];
  wires: PlanWireOut[];
  forced: number;
}

const agentStep = (s: PlanStep): s is PlanStep & { agent: AgentKind } => s.agent !== "terminal";

/** Each piece of plan `p`'s text, and where it is, as the dialog and the agent are told of it. */
export function planTexts(p: Plan): { where: string; text: string }[] {
  return [
    { where: "Its summary", text: p.summary },
    ...p.steps.flatMap((s) => [
      { where: `Step ${s.key}'s name`, text: s.name },
      { where: `“${s.name}”'s ${s.agent === "terminal" ? "command" : "prompt"}`, text: s.prompt },
    ]),
    ...p.wires.flatMap((w, j) => (w.template === undefined ? [] : [{ where: `Wire ${j + 1}'s template`, text: w.template }])),
  ];
}

/**
 * Plan `p` held to the rules with its context `ctx`, and how it's laid out: throws PlanError saying the first thing
 * wrong. Every step is one of this Mac's agents, installed, with a model and effort its catalog offers; a new worktree
 * is in a repo of the area's; a step shares only its Orchestrator's folder or an earlier agent step's; a terminal runs
 * on one agent's tree (its Orchestrator's or a step's), joined by that agent's shared worktree wire, its command taking
 * no `{ticket}`. Each wire has a step at one end, names nothing outside its area or that a wire can't reach, and holds
 * to the wire rules (shared/wires.ts' linkRefusal: no duplicate, no second feedback wire, no handoff cycle). A wire that
 * goes when its PR merges starts at its Orchestrator or a step that starts, on a ticket. In a team room's area every
 * automatic gate is laid out asking.
 */
export function checkPlan(p: Plan, ctx: PlanContext): PlanLayOut {
  // laid out as it shows: no text the user can't see, nor what a terminal or an agent acts on rather than shows
  for (const t of planTexts(p)) {
    const why = hiddenTextRefusal(t.where, t.text);
    if (why) bad(why);
  }
  if (!p.summary.trim()) bad("Its summary is empty: say what the plan does and why.");
  if (!p.steps.length) bad("It proposes no workspaces: a plan has at least one step.");
  if (p.steps.length > PLAN_MAX.steps) bad(`It proposes ${p.steps.length} workspaces: a plan has at most ${PLAN_MAX.steps}.`);
  if (p.wires.length > PLAN_MAX.wires) bad(`It has ${p.wires.length} wires: a plan has at most ${PLAN_MAX.wires}.`);
  const at = new Map<string, number>();
  const names = new Set<string>();
  p.steps.forEach((s, i) => {
    if (at.has(s.key)) bad(`Two steps have the key ${s.key}.`);
    if (Object.hasOwn(ctx.existing, s.key) || s.key === ctx.me.id) bad(`Step ${i + 1}'s key, ${s.key}, is a workspace's id already: give it a key of its own.`);
    at.set(s.key, i);
    if (names.has(s.name.toLowerCase())) bad(`Two steps are called “${s.name}”.`);
    names.add(s.name.toLowerCase());
  });
  const step = (k: string) => (at.has(k) ? p.steps[at.get(k)!] : null);
  // what Lay out sends: a handoff from the Orchestrator that goes when it finishes, whose step starts with its prompt
  const sentNow = (w: PlanWire) => w.type === "handoff" && w.from === ME && (w.when ?? "finished") === "finished";
  const startsAt = (k: string) => {
    const s = step(k);
    return !!s && agentStep(s) && p.wires.every((w) => w.type !== "handoff" || w.to !== k || sentNow(w));
  };
  const nameOf = (k: string) => (k === ME ? ctx.me.title : (step(k)?.name ?? ctx.existing[k]?.title ?? k));
  const label = (w: Pick<PlanWire, "from" | "to">) => `${nameOf(w.from)} → ${nameOf(w.to)}`;

  const steps = p.steps.map((s, i): PlanStepOut => {
    const n = `“${s.name}”`;
    if (s.repo !== undefined && s.folder !== "new") bad(`${n} works in another workspace's folder, and so in its repo: leave repo out.`);
    const shares = typeof s.folder === "object" ? s.folder.sameAs : s.folder === "orchestrator" ? ME : null;
    const other = shares === ME ? null : shares ? step(shares) : null;
    if (shares && shares !== ME) {
      if (!other) bad(`${n} works in the folder of a step the plan doesn't have (${shares}).`);
      if (other!.key === s.key) bad(`${n} works in its own folder: say "new" for a worktree of its own.`);
      if (!agentStep(other!)) bad(`${n} works in “${other!.name}”'s folder, and that's a terminal: a step shares an agent's folder.`);
      if (at.get(shares)! > i) bad(`${n} works in “${other!.name}”'s folder, which comes after it: a step shares the folder of one before it.`);
    }
    if (!s.prompt.trim()) bad(`${n} has no ${s.agent === "terminal" ? "command" : "prompt"}: say what it's ${s.agent === "terminal" ? "to run" : "told as it starts"}.`);
    if (s.agent === "terminal") {
      if (!shares) bad(`${n} is a terminal: it runs on an agent's tree, so its folder is "orchestrator" or an agent step's.`);
      if (s.model || s.effort) bad(`${n} is a terminal: it has no model or effort.`);
      // a ticket's title is text others wrote: typed into a shell, it would run
      if (s.prompt.includes("{ticket}")) bad(`${n} is a terminal, whose command doesn't take {ticket}: a ticket's text typed into a shell would run.`);
      if (!p.wires.some((w) => w.type === "worktree" && w.from === shares && w.to === s.key)) bad(`${n} is a terminal with no shared worktree wire from ${shares === ME ? "me" : `“${other!.name}”`}, whose tree it runs on.`);
      const laid = shares === ME || startsAt(shares!);
      return {
        step: s,
        starts: false,
        repo: shares === ME ? ctx.me.repo : (other!.repo ?? null),
        where: `On ${shares === ME ? `${ctx.me.title}'s` : `“${other!.name}”'s`} tree.`,
        says: "Runs this as a command.",
        terminal: laid
          ? { laid, why: shares === ME ? `It's made on ${ctx.me.title}'s tree as the plan is laid out.` : `It's made on “${other!.name}”'s tree as “${other!.name}” starts.` }
          : { laid, why: `It isn't laid out: a terminal takes no handoff, so it can't wait as a step, and “${other!.name}” waits for one. Once it has started, Add terminal on its tree makes one; run this there.` },
      };
    }
    if (!AGENT_KINDS.includes(s.agent)) bad(`${n} runs ${quoted(s.agent, 20)}: a step runs Claude, Codex or a terminal.`);
    const agent = s.agent as AgentKind;
    if (!ctx.installed.includes(agent)) bad(`${n} runs ${AGENT_NAME[agent]}, which isn't installed on this Mac.`);
    const offered = ctx.catalog?.[agent];
    if (s.model !== undefined) {
      if (!offered) bad(`${n} names a model, and the models this Mac offers can't be read now: leave it out for ${AGENT_NAME[agent]}'s default.`);
      if (!offered!.models.some((m) => m.id === s.model)) bad(`${n}'s model, ${quoted(s.model, 80)}, isn't one this Mac's ${AGENT_NAME[agent]} offers: leave it out for its default, or name one it lists.`);
    }
    if (s.effort !== undefined) {
      if (!offered) bad(`${n} names an effort, and the efforts this Mac's ${AGENT_NAME[agent]} takes can't be read now: leave it out.`);
      if (!offered!.efforts.includes(s.effort)) bad(`${n}'s effort, ${quoted(s.effort, 40)}, isn't one ${AGENT_NAME[agent]} takes (${offered!.efforts.join(", ")}).`);
    }
    let repo: string | null;
    let where: string;
    if (s.folder === "new") {
      repo = s.repo ?? ctx.me.repo;
      if (!repo) bad(`${n} works in a worktree of its own, which needs a repo, and ${ctx.me.title} is in none: name one of its area's.`);
      if (!ctx.repos.includes(repo!)) bad(`${n}'s repo, ${quoted(repo, 200)}, isn't one of its area's${ctx.repos.length ? ` (${ctx.repos.join(", ")})` : ""}: a plan makes worktrees only in those.`);
      where = `A new worktree of ${repo!.split("/").pop()}${repo === ctx.me.repo ? `, from ${ctx.me.title}'s commit` : ""}.`;
    } else if (shares === ME) {
      repo = ctx.me.repo;
      where = `In ${ctx.me.title}'s folder${ctx.me.branch ? `, on ${ctx.me.branch}` : ""}.`;
    } else {
      repo = null;
      where = `In “${other!.name}”'s folder.`;
    }
    const starts = startsAt(s.key);
    if (starts && other && !startsAt(other.key)) bad(`${n} starts as the plan is laid out, in “${other.name}”'s folder, and “${other.name}” waits for a handoff, so it has no folder yet.`);
    const ins = p.wires.filter((w) => w.type === "handoff" && w.to === s.key);
    const says = starts
      ? ins.length
        ? `Starts as it's laid out, with this prompt: Lay out sends ${ctx.me.title}'s handoff to it.`
        : "Starts as it's laid out, with this prompt."
      : `Waits, not started: it starts when ${ins.filter((w) => !sentNow(w)).map((w) => `${nameOf(w.from)}'s`).join(" or ")} handoff is sent.`;
    return { step: s, starts, repo, where, says, terminal: null };
  });

  const made: Record<string, Wire> = {};
  let forced = 0;
  const wires = p.wires.map((w, j): PlanWireOut => {
    for (const e of [w.from, w.to]) {
      if (e === ME || step(e)) continue;
      if (isRemotePaneId(e)) bad(`Wire ${j + 1} names a teammate's session: wires across Macs come later.`);
      const x = Object.hasOwn(ctx.existing, e) ? ctx.existing[e] : null;
      if (!x) bad(`Wire ${j + 1} names ${quoted(e, 64)}, which isn't one of the plan's steps, "${ME}" (this Orchestrator) or a workspace in its area.`);
      if (x!.refusal) bad(`Wire ${j + 1} names “${x!.title}”, which a plan can't name: ${x!.refusal}`);
      if (x!.kind === "terminal") bad(`Wire ${j + 1} names “${x!.title}”, a terminal: a plan wires only its own terminals.`);
    }
    if (!step(w.from) && !step(w.to)) bad(`Wire ${j + 1} (${label(w)}) joins no step of the plan's: a plan's wires reach its own steps.`);
    const l = label(w);
    const a = step(w.from);
    const z = step(w.to);
    if (w.type === "worktree") {
      if ((a && !agentStep(a)) || (!a && w.from !== ME) || !z || agentStep(z)) bad(`${l}: a shared worktree wire runs from an agent (the Orchestrator or a step) to a terminal step.`);
      const on = typeof z!.folder === "object" ? z!.folder.sameAs : z!.folder === "orchestrator" ? ME : null;
      if (on !== w.from) bad(`${l}: “${z!.name}” runs on another agent's tree.`);
    } else {
      for (const s of [a, z]) if (s && !agentStep(s)) bad(`${l}: “${s.name}” is a terminal, and only a shared worktree wire reaches one.`);
    }
    if (!carriesWork(w.type)) {
      if (w.when !== undefined || w.template !== undefined) bad(`${l}: a ${w.type} wire carries nothing, so it has no when or template.`);
      if (w.gate === "automatic") bad(`${l}: a ${w.type} wire has no gate to make automatic.`);
    }
    if (w.rounds !== undefined && w.type !== "feedback") bad(`${l}: only a feedback wire counts rounds.`);
    if (w.toolOutput !== undefined && w.type !== "context") bad(`${l}: only a context link reads tool output.`);
    if (w.when === "pr-merged") {
      if (w.type !== "handoff") bad(`${l}: only a handoff goes when its pull request merges.`);
      if (!ctx.ticket) bad(`${l} goes when a pull request merges, and ${ctx.me.title} is on no ticket, so there's none to wait for.`);
      if (a && !startsAt(a.key)) bad(`${l} goes when “${a.name}”'s pull request merges, and “${a.name}” waits for a handoff, so it has no branch yet: such a wire starts at "${ME}" or a step that starts as the plan is laid out.`);
    }
    const why = linkRefusal(w.from, w.to, w.type, { end: () => null, links: made });
    if (why) bad(`${l}: ${why}`);
    made[String(j)] = { from: w.from, to: w.to, type: w.type, when: w.when ?? "finished", gate: w.gate ?? "ask", createdAt: j };
    const asks = w.gate === "automatic" && ctx.room;
    if (asks) forced++;
    const toTerminal = w.type === "worktree" ? steps[at.get(w.to)!].terminal! : null;
    return {
      wire: w,
      gate: asks ? "ask" : (w.gate ?? "ask"),
      forced: asks,
      sentByLayOut: sentNow(w) && !!z && startsAt(z.key),
      afterStart: (w.when === "pr-merged" && w.from !== ME && !!a) || (!!toTerminal && toTerminal.laid && w.from !== ME),
      skipped: !!toTerminal && !toTerminal.laid,
    };
  });
  return { steps, wires, forced };
}

/** Plan `p` read and checked whole, as main does both at propose_plan and at Lay out. */
export function parsePlan(v: unknown, spelling: Spelling, ctx: PlanContext): { plan: Plan; layout: PlanLayOut } {
  const plan = readAs(v, spelling);
  return { plan, layout: checkPlan(plan, ctx) };
}

/** A plan as main holds it: everything propose_plan sent, in this spelling, after its own redaction. */
export const shownPlan = (p: Plan): Plan => JSON.parse(JSON.stringify(p)) as Plan;

const LINK_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

/**
 * What the dialog flags over a plan, beside what main said when it held it (`held`: secret-looking values replaced):
 * links in its text, the existing workspaces it wires to, a team room's gates asking.
 */
export function planFlags(p: Plan, layout: PlanLayOut, ctx: Pick<PlanContext, "existing" | "room" | "me">, held: readonly string[] = []): string[] {
  const out = [...held];
  const texts: [string, string][] = [
    ["Its summary", p.summary],
    ...p.steps.map((s): [string, string] => [`“${s.name}”'s ${s.agent === "terminal" ? "command" : "prompt"}`, s.prompt]),
    ...p.wires.flatMap((w): [string, string][] => (w.template ? [[`What ${w.from === ME ? ctx.me.title : (p.steps.find((s) => s.key === w.from)?.name ?? w.from)} sends`, w.template]] : [])),
  ];
  for (const [where, t] of texts) {
    const links = [...new Set(t.match(LINK_RE) ?? [])];
    if (links.length) out.push(`${where} has ${links.length === 1 ? "a link" : `${links.length} links`}: ${links.slice(0, 3).join(", ")}${links.length > 3 ? ", …" : ""}. Check where ${links.length === 1 ? "it goes" : "they go"} before laying it out.`);
  }
  const named = [...new Set(p.wires.flatMap((w) => [w.from, w.to]).filter((e) => Object.hasOwn(ctx.existing, e)))];
  if (named.length) out.push(`It wires to ${named.map((e) => `“${ctx.existing[e].title}”`).join(", ")}, which ${named.length === 1 ? "is there" : "are there"} already.`);
  if (layout.forced) out.push(`In a team room's area every gate asks, so ${layout.forced === 1 ? "its automatic gate is" : `its ${layout.forced} automatic gates are`} laid out asking.`);
  return out;
}

// ---- held, and across the window and main ----------------------------------------------------

/** A plan as plans.json holds it: whose, on which ticket, when, the one it replaced, and what main said as it held it. */
export interface HeldPlan {
  /** Its Orchestrator's session id. */
  from: string;
  ticket: string | null;
  at: number;
  /** The id of the plan of its Orchestrator's it replaced. */
  replaces?: string;
  plan: Plan;
  /** What main said as it held it: secret-looking values it replaced. */
  notes?: string[];
  /**
   * Proposed while its Orchestrator's plan `waitsFor` was open in the dialog: it waits, so the user's edits aren't lost
   * under them, and replaces that plan once the dialog closes (or follows it when it's laid out or dismissed).
   */
  waitsFor?: string;
}

/** Where the dialog showed a plan going: main refuses a Lay out when its area or room is no longer that. */
export interface PlanShownAt {
  area: string;
  room: string | null;
}

/** A held plan as the window is told it (plans:list): what the dialog shows, and the context it checks edits against. */
export interface PlanView {
  id: string;
  held: HeldPlan;
  /** Its Orchestrator, as an end of its wires. */
  me: PlanEnd;
  ticketTitle: string | null;
  /** The area its steps go in: its Orchestrator's. */
  area: string;
  /** The team room its area is shared as, or null. */
  room: string | null;
  /** Its area's other workspaces, by id, each with why a plan can't name it. */
  existing: Record<string, PlanEnd>;
  installed: AgentKind[];
  repos: string[];
  /** Why it can't be laid out as it stands now (the rules checked again on the sessions now), or null. */
  problem: string | null;
  /** A newer plan its Orchestrator proposed while this one was open, waiting for the dialog to close; null when none. */
  newer: { at: number } | null;
}

/** What plans:layOut answers: the steps and wires made, its area, and what's said. */
export interface PlanLaidOut extends LayOutReply {
  area: string;
}

/** Who wrote a plan, as the dialog's head says it (section 4): an agent that read a ticket others wrote. */
export const provenanceOf = (v: Pick<PlanView, "me" | "held">): string =>
  `Proposed by ${v.me.title}'s agent${v.held.ticket ? `, which read #${v.held.ticket}, written by others` : ", from what it read"}`;

// ---- an Orchestrator's start ----------------------------------------------------------------

/** How much of a ticket's description an Orchestrator's kickoff carries: past it, it's cut, saying how much. */
export const KICKOFF_DESCRIPTION_MAX = 20_000;

/**
 * The rest of an Orchestrator template, after its Orchestrator, as propose_plan spells a plan: its plan's starting
 * shape. A step working in the Orchestrator's folder works in "orchestrator", the Orchestrator's own ends are "me", and a
 * step in the repo's checkout (which a plan has no word for) works in a worktree of its own.
 */
export function startingShape(b: TemplateBody): { steps: Record<string, unknown>[]; wires: Record<string, unknown>[] } {
  const first = b.steps[0].key;
  const endOf = (k: string) => (k === first ? ME : k);
  return {
    steps: b.steps.slice(1).map((s) => ({
      key: s.key,
      name: s.name,
      agent: s.agent,
      ...(s.model ? { model: s.model } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
      folder: typeof s.folder === "object" ? (s.folder.sameAs === first ? "orchestrator" : { same_as: s.folder.sameAs }) : "new",
      prompt: s.prompt,
    })),
    wires: b.wires.map((w) => ({
      from: endOf(w.from),
      to: endOf(w.to),
      type: w.type,
      ...(w.when ? { when: w.when } : {}),
      ...(w.gate ? { gate: w.gate } : {}),
      ...(w.template !== undefined ? { template: w.template } : {}),
      ...(w.rounds !== undefined ? { rounds: Math.min(w.rounds, PLAN_MAX.rounds) } : {}),
      ...(w.toolOutput === false ? { tool_output: false } : {}),
    })),
  };
}

/**
 * What an Orchestrator is told as it starts: its own Tell it (`told`, `{ticket}` filled in), the ticket's title and
 * description fenced as text others wrote, and the rest of its template as its plan's starting shape, which is the
 * user's. Its rules are its system prompt's (Mockingbird's provider), not this.
 */
export function orchestratorKickoff(o: { ticketId: string; title: string; description: string; told: string; template: TemplateBody; makeNonce?: () => string }): string {
  const d = o.description.trim();
  const description = d.length > KICKOFF_DESCRIPTION_MAX ? `${d.slice(0, KICKOFF_DESCRIPTION_MAX)}\n[cut: ${nOf(d.length - KICKOFF_DESCRIPTION_MAX)} more characters]` : d;
  const shape = startsAtOrchestrator(o.template) && o.template.steps.length > 1 ? startingShape(o.template) : null;
  return [
    `You're the Orchestrator for Azure DevOps ticket #${o.ticketId}, in Mockingbird.`,
    ...(o.told.trim() ? [o.told.trim()] : []),
    fencedTicket(o.title, description, o.makeNonce),
    ...(shape
      ? [
          "The user's template gives your plan's starting shape: change it to fit the ticket, then propose it with propose_plan. In propose_plan's terms:",
          "```json\n" + JSON.stringify(shape, null, 2) + "\n```",
        ]
      : ["Propose the workspaces and wires to do it with propose_plan."]),
  ].join("\n\n");
}
