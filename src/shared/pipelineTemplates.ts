import { isObj } from "./landscape";
import { oneLine } from "./team/agentText";
import { AGENT_KINDS, ticketIdOf, type AgentKind } from "./types";
import { carriesWork, linkRefusal, WIRE_GATES, WIRE_TYPES, WIRE_WHENS, type Wire, type WireGate, type WireSettings, type WireType, type WireWhen } from "./wires";

/**
 * Pipeline templates (docs/landscape-wires.md, W9): a chain of steps and the wires between them, saved from the
 * landscape (Save as template) and laid out again from a ticket (Pipeline from a ticket…). Kept in
 * `settings.pipelineTemplates`, on this Mac only. A template names no session, folder, branch, repo or ticket: a step
 * says only whether it works in a worktree of its own, the repo's checkout, or another step's folder, and its prompt's
 * `{ticket}` is filled in at Lay out. Main is the only writer: what's saved is checked and redacted there.
 *
 * Entries written by another version are read one by one: fields this one doesn't know are kept and listed, and an
 * entry that can't be read is kept as it is, refused with why.
 */

/** What a step runs: an agent, or a terminal (a shared worktree terminal on an agent step's tree, its prompt a command). */
export const TEMPLATE_AGENTS = ["claude", "codex", "terminal"] as const;
export type TemplateAgent = (typeof TEMPLATE_AGENTS)[number];
/** Where a step works: a worktree of its own, the repo's checkout as it is, or an earlier step's folder (decision 7). */
export type TemplateFolder = "new" | "checkout" | { sameAs: string };

export interface TemplateStep {
  /** Its name among the template's steps, which its wires and `sameAs` use. */
  key: string;
  name: string;
  agent: TemplateAgent;
  model?: string;
  effort?: string;
  folder: TemplateFolder;
  /** What it's told as it starts ("Tell it"), `{ticket}` filled in at Lay out; a terminal's command. */
  prompt: string;
}

/** A wire between two steps, by key, with the settings a person can set on one (WireSettings). */
export interface TemplateWire {
  from: string;
  to: string;
  type: WireType;
  when?: WireWhen;
  gate?: WireGate;
  template?: string;
  files?: string[];
  /** A feedback wire's round limit. */
  rounds?: number;
  toolOutput?: false;
}

/** What's laid out: its steps, its wires, and whether the first step starts as it's laid out (else every step waits). */
export interface TemplateBody {
  startFirst: boolean;
  steps: TemplateStep[];
  wires: TemplateWire[];
}

export interface PipelineTemplate extends TemplateBody {
  id: string;
  name: string;
  savedAt: number;
}

export const TEMPLATE_MAX = { steps: 8, wires: 16, name: 60, stepName: 80, prompt: 8000, rounds: 10, model: 80 } as const;

/** Why a template, or part of one, can't be used: said to the user as it is. */
export class TemplateError extends Error {
  constructor(what: string) {
    super(what);
    this.name = "TemplateError";
  }
}
const bad = (what: string): never => {
  throw new TemplateError(what);
};

// ---- reading -----------------------------------------------------------------------------

type Read<T> = (v: unknown, what: string) => T;
const KEY_RE = /^[A-Za-z0-9_-]{1,24}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const text =
  (max: number): Read<string> =>
  (v, what) =>
    typeof v !== "string" ? bad(`${what} isn't text.`) : v.length > max ? bad(`${what} is over ${max.toLocaleString("en-US")} characters.`) : v;
/** One line, trimmed, not empty. */
const line =
  (max: number): Read<string> =>
  (v, what) => {
    const t = text(max * 4)(v, what);
    if (/[\r\n]/.test(t)) bad(`${what} is more than one line.`);
    const s = oneLine(t, max * 4);
    return !s ? bad(`${what} is empty.`) : s.length > max ? bad(`${what} is over ${max} characters.`) : s;
  };
const key: Read<string> = (v, what) => (typeof v === "string" && KEY_RE.test(v) ? v : bad(`${what} isn't a step's key (letters, digits, - or _, up to 24).`));
const oneOf =
  <T extends string>(allowed: readonly T[]): Read<T> =>
  (v, what) =>
    allowed.includes(v as T) ? (v as T) : bad(`${what} isn't ${allowed.join(", ").replace(/, ([^,]*)$/, " or $1")}.`);
const yesNo: Read<boolean> = (v, what) => (typeof v === "boolean" ? v : bad(`${what} isn't true or false.`));
const when: Read<number> = (v, what) => (typeof v === "number" && Number.isFinite(v) ? v : bad(`${what} isn't a time.`));
const folder: Read<TemplateFolder> = (v, what) => {
  if (v === "new" || v === "checkout") return v;
  if (isObj(v) && Object.keys(v).length === 1 && "sameAs" in v) return { sameAs: key(v.sameAs, what) };
  return bad(`${what} isn't new, checkout or another step's folder.`);
};
/** A path inside the source's folder as far as its spelling goes, as a wire's files are (shared/wires.ts' insideFile). */
const inside: Read<string> = (v, what) => {
  const f = text(500)(v, what);
  return !f || f.startsWith("/") || f.startsWith("~") || f.split("/").includes("..") ? bad(`${what} (${JSON.stringify(f)}) isn't a path inside the step's folder.`) : f;
};
const files: Read<string[]> = (v, what) => (Array.isArray(v) ? v.map((f, i) => inside(f, `${what} ${i + 1}`)) : bad(`${what} isn't a list.`));
const rounds: Read<number> = (v, what) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= TEMPLATE_MAX.rounds ? (v as number) : bad(`${what} isn't a whole number from 1 to ${TEMPLATE_MAX.rounds}.`));
const onlyFalse: Read<false> = (v, what) => (v === false ? false : bad(`${what} is only ever false.`));

interface Spec {
  fields: Record<string, Read<unknown>>;
  required: readonly string[];
}
const STEP: Spec = {
  fields: { key, name: line(TEMPLATE_MAX.stepName), agent: oneOf(TEMPLATE_AGENTS), model: line(TEMPLATE_MAX.model), effort: line(TEMPLATE_MAX.model), folder, prompt: text(TEMPLATE_MAX.prompt) } satisfies Record<keyof TemplateStep, Read<unknown>>,
  required: ["key", "name", "agent", "folder", "prompt"],
};
const WIRE: Spec = {
  fields: {
    from: key,
    to: key,
    type: oneOf(WIRE_TYPES),
    when: oneOf(WIRE_WHENS),
    gate: oneOf(WIRE_GATES),
    template: text(TEMPLATE_MAX.prompt),
    files,
    rounds,
    toolOutput: onlyFalse,
  } satisfies Record<keyof TemplateWire, Read<unknown>>,
  required: ["from", "to", "type"],
};

/**
 * `v`'s fields by `spec`: each one there checked, the required ones there. A field it doesn't know is refused, or, with
 * `unknown`, kept out of what's returned and named there (`at` its place), for an entry another version wrote.
 */
function read<T>(v: unknown, what: string, spec: Spec, unknown: string[] | null, at: string): T {
  if (!isObj(v)) bad(`${what} isn't an object.`);
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) {
    if (!Object.hasOwn(spec.fields, k)) {
      if (!unknown) bad(`${what} has a field this version doesn't know (${k}).`);
      unknown!.push(at ? `${at}.${k}` : k);
      continue;
    }
    if (x !== undefined) out[k] = spec.fields[k](x, `${what}'s ${k}`);
  }
  for (const k of spec.required) if (out[k] === undefined) bad(`${what} has no ${k}.`);
  return out as T;
}
const BODY: Spec = { fields: { startFirst: yesNo, steps: (v) => v, wires: (v) => v }, required: ["startFirst", "steps", "wires"] };

function readBody(o: Record<string, unknown>, unknown: string[] | null): TemplateBody {
  if (!Array.isArray(o.steps)) bad("Its steps aren't a list.");
  if (!Array.isArray(o.wires)) bad("Its wires aren't a list.");
  const steps = (o.steps as unknown[]).map((s, i) => read<TemplateStep>(s, `Step ${i + 1}`, STEP, unknown, `steps[${i}]`));
  const named = (k: string) => steps.find((s) => s.key === k)?.name ?? k;
  const wires = (o.wires as unknown[]).map((w, i) => {
    const ends = isObj(w) && typeof w.from === "string" && typeof w.to === "string" ? ` (${named(w.from)} → ${named(w.to)})` : "";
    return read<TemplateWire>(w, `Wire ${i + 1}${ends}`, WIRE, unknown, `wires[${i}]`);
  });
  const body: TemplateBody = { startFirst: o.startFirst as boolean, steps, wires };
  bodyRules(body);
  return body;
}

/**
 * A template's steps and wires as a window sent them (Lay out, Save), checked whole: a field this version doesn't know
 * is refused, as are the rules bodyRules holds. Throws TemplateError saying why.
 */
export function parseTemplateBody(v: unknown): TemplateBody {
  const o = read<Record<string, unknown>>(v, "The template", BODY, null, "");
  return readBody(o, null);
}

/** A template as it's kept: its id, name and when it was saved, beside its body. */
const STORED: Spec = { fields: { id: (v, what) => (typeof v === "string" && ID_RE.test(v) ? v : bad(`${what} isn't an id.`)), name: line(TEMPLATE_MAX.name), savedAt: when, ...BODY.fields }, required: ["id", "name", "savedAt", ...BODY.required] };

/** A kept template that this version can use, and the fields of it this version doesn't read (kept as they are). */
export interface ReadTemplate {
  template: PipelineTemplate;
  /** Where each field this version doesn't know is ("color", "steps[1].color"): it's kept, and nothing here acts on it. */
  unknown: string[];
}
/** A kept entry that can't be used here: kept as it is, and said with why. */
export interface RefusedTemplate {
  /** Its place in the list. */
  index: number;
  /** Its name, when that much can be read. */
  name: string | null;
  id: string | null;
  why: string;
}
export interface TemplateList {
  templates: ReadTemplate[];
  refused: RefusedTemplate[];
  /** The list itself can't be read (it isn't one): nothing in it is used, nothing is saved over it, and this says why. */
  broken?: string;
}

/** `settings.pipelineTemplates` as this version reads it, entry by entry. */
export function readTemplates(raw: unknown): TemplateList {
  if (raw === undefined || raw === null) return { templates: [], refused: [] };
  if (!Array.isArray(raw)) return { templates: [], refused: [], broken: "The saved templates aren't a list, so none of them can be read; they're kept as they are, and nothing is saved over them." };
  const out: TemplateList = { templates: [], refused: [] };
  raw.forEach((v, index) => {
    const unknown: string[] = [];
    try {
      const o = read<Record<string, unknown>>(v, "The template", STORED, unknown, "");
      const body = readBody(o, unknown);
      out.templates.push({ template: { id: o.id as string, name: o.name as string, savedAt: o.savedAt as number, ...body }, unknown });
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      const o = isObj(v) ? v : {};
      out.refused.push({ index, name: typeof o.name === "string" ? oneLine(o.name, TEMPLATE_MAX.name) || null : null, id: typeof o.id === "string" && ID_RE.test(o.id) ? o.id : null, why: err.message });
    }
  });
  return out;
}

// ---- the rules -----------------------------------------------------------------------------

const label = (b: TemplateBody, w: Pick<TemplateWire, "from" | "to">): string => {
  const n = (k: string) => b.steps.find((s) => s.key === k)?.name ?? k;
  return `${n(w.from)} → ${n(w.to)}`;
};

/**
 * What every template holds to, as the wire rules (shared/wires.ts) would hold its wires once its steps are sessions:
 * - a first step that's an agent, keys and names each once, at most TEMPLATE_MAX of each;
 * - a step working in another's folder works in an earlier agent step's;
 * - a terminal works on one agent step's tree, joined to it by that step's shared worktree wire, and takes no other
 *   wire: a message typed into a terminal would run as a command;
 * - each wire between two of its steps, with only the settings its type has, and no second wire of a type between the
 *   same two, no second feedback wire either way, and no cycle of handoffs (linkRefusal).
 */
function bodyRules(b: TemplateBody): void {
  if (!b.steps.length) bad("It has no steps.");
  if (b.steps.length > TEMPLATE_MAX.steps) bad(`It has ${b.steps.length} steps: a template has at most ${TEMPLATE_MAX.steps}.`);
  if (b.wires.length > TEMPLATE_MAX.wires) bad(`It has ${b.wires.length} wires: a template has at most ${TEMPLATE_MAX.wires}.`);
  const at = new Map<string, number>();
  const names = new Set<string>();
  b.steps.forEach((s, i) => {
    if (at.has(s.key)) bad(`Two steps have the key ${s.key}.`);
    at.set(s.key, i);
    if (names.has(s.name.toLowerCase())) bad(`Two steps are called “${s.name}”.`);
    names.add(s.name.toLowerCase());
  });
  if (b.steps[0].agent === "terminal") bad(`Its first step, “${b.steps[0].name}”, is a terminal: a pipeline starts at an agent.`);
  for (const [i, s] of b.steps.entries()) {
    const shares = typeof s.folder === "object" ? s.folder.sameAs : null;
    const other = shares === null ? null : b.steps[at.get(shares) ?? -1];
    if (s.agent === "terminal") {
      if (!other || other.agent === "terminal") bad(`“${s.name}” is a terminal: it runs on an agent step's tree, so its folder is that step's.`);
      if (!b.wires.some((w) => w.type === "worktree" && w.from === shares && w.to === s.key)) bad(`“${s.name}” is a terminal with no shared worktree wire from “${other!.name}”, whose tree it runs on.`);
      if (s.model || s.effort) bad(`“${s.name}” is a terminal: it has no model or effort.`);
      // a ticket's title is text others wrote: typed into a shell, it would run
      if (s.prompt.includes("{ticket}")) bad(`“${s.name}” is a terminal, whose command doesn't take {ticket}: a ticket's text typed into a shell would run.`);
      continue;
    }
    if (shares === null) continue;
    if (!other) bad(`“${s.name}” works in the folder of a step it doesn't have (${shares}).`);
    if (other!.key === s.key) bad(`“${s.name}” works in its own folder: say new or checkout.`);
    if (other!.agent === "terminal") bad(`“${s.name}” works in “${other!.name}”'s folder, and that's a terminal: a step shares an agent step's.`);
    if (at.get(shares)! > i) bad(`“${s.name}” works in “${other!.name}”'s folder, which comes after it: a step shares the folder of one before it.`);
  }
  const made: Record<string, Wire> = {};
  b.wires.forEach((w, j) => {
    const a = b.steps[at.get(w.from) ?? -1];
    const z = b.steps[at.get(w.to) ?? -1];
    if (!a || !z) bad(`Wire ${j + 1} runs ${!a ? "from" : "to"} a step it doesn't have (${!a ? w.from : w.to}).`);
    const l = label(b, w);
    if (w.type === "worktree") {
      if (a.agent === "terminal" || z.agent !== "terminal") bad(`${l}: a shared worktree wire runs from an agent to a terminal.`);
      if (typeof z.folder !== "object" || z.folder.sameAs !== a.key) bad(`${l}: “${z.name}” runs on another step's tree.`);
    } else {
      for (const e of [a, z]) if (e.agent === "terminal") bad(`${l}: “${e.name}” is a terminal, and only a shared worktree wire reaches one.`);
    }
    if (!carriesWork(w.type)) {
      if (w.when !== undefined || w.template !== undefined || w.files !== undefined) bad(`${l}: a ${w.type} wire carries nothing, so it has no When or What flows.`);
      if (w.gate === "automatic") bad(`${l}: a ${w.type} wire has no gate to make automatic.`);
    }
    if (w.rounds !== undefined && w.type !== "feedback") bad(`${l}: only a feedback wire counts rounds.`);
    if (w.toolOutput !== undefined && w.type !== "context") bad(`${l}: only a context link reads tool output.`);
    if (w.when === "pr-merged" && w.type !== "handoff") bad(`${l}: only a handoff goes when its pull request merges.`);
    const why = linkRefusal(w.from, w.to, w.type, { end: () => null, links: made });
    if (why) bad(`${l}: ${why}`);
    made[String(j)] = { from: w.from, to: w.to, type: w.type, when: w.when ?? "finished", gate: w.gate ?? "ask", createdAt: j };
  });
}

// ---- laying one out ------------------------------------------------------------------------

/** `{ticket}` in a step's prompt, as a wire's `{ticket}` is: "#4182 — Stream the donor export", or nothing with no ticket. */
export const ticketLine = (id: string | null | undefined, title: string | null | undefined): string =>
  id?.trim() ? oneLine(`#${ticketIdOf(id.trim())}${title?.trim() ? ` — ${title.trim()}` : ""}`) : "";
export const withTicket = (prompt: string, line: string): string => prompt.replace(/\{ticket\}/g, line);

/** What a person's ticket kickoff (ticketKickoffPrompt) reads as, from its first line to its last. */
const KICKOFF_RE = /You're picking up Azure DevOps ticket #[^\n]*\n\n(?:Ticket description:\n[\s\S]*?\n\n)?Get familiar with the relevant code first and propose an approach before making changes\./g;

/** Kickoff prompt for a session started from an Azure DevOps ticket. */
export function ticketKickoffPrompt(id: number | string, title: string, description: string): string {
  return (
    `You're picking up Azure DevOps ticket #${id}: ${title}.\n\n` +
    (description.trim() ? `Ticket description:\n${description.trim()}\n\n` : "") +
    `Get familiar with the relevant code first and propose an approach before making changes.`
  );
}

/** `prompt` with each ticket kickoff in it (a step told its ticket as it was added) as `{ticket}`: a template is for any ticket. */
export const kickoffAsTicket = (prompt: string): { text: string; count: number } => {
  let count = 0;
  return { text: prompt.replace(KICKOFF_RE, () => (count++, "{ticket}")), count };
};

/** Where it's laid out, as far as the template's rules go: a team room's area, and whether it's on a ticket. */
export interface LayOutWhere {
  room: boolean;
  ticket: boolean;
}

export interface PlannedStep {
  step: TemplateStep;
  /** The first step, starting as it's laid out. */
  starts: boolean;
  /** A terminal step: laid out on its agent's tree as that starts at Lay out (`laid`), or not laid out, saying why. */
  terminal: { laid: boolean; why: string } | null;
}
export interface PlannedWire {
  wire: TemplateWire;
  /** The gate it's made with: asking in a team room's area, whatever the template says. */
  gate: WireGate;
  /** An automatic gate laid out as ask (a team room's area). */
  forced: boolean;
  /** Made once the first step has started: one that needs its branch (when its PR merges), or its terminal's. */
  afterStart: boolean;
  /** Not made: a terminal's wire whose terminal isn't laid out. */
  skipped: boolean;
  /** Why it can't be laid out as it is: Lay out is refused while any wire has one. */
  problem: string | null;
}
export interface LayOutPlan {
  steps: PlannedStep[];
  wires: PlannedWire[];
  /** Automatic gates laid out as ask. */
  forced: number;
  /** What stops Lay out, each said. */
  problems: string[];
}

/** Said of a team room's area: its gates all ask (W4b's rule, settingsRefusal). */
export const ROOM_ASKS = "In a team room's area every gate asks";
/** What a lay-out says of the `n` automatic gates it laid out asking, in a team room's area. */
export const roomAsked = (n: number) => `${ROOM_ASKS}, so ${n === 1 ? "its automatic gate was" : `its ${n} automatic gates were`} laid out asking.`;

/**
 * How `b` is laid out `where`: which step starts, which terminals are laid out, each wire's gate (automatic asks in a
 * team room's area), which wires wait for the first step's start, and what can't be laid out as it is:
 * - a wire that goes when its source's PR merges needs that source on a ticket's branch, so only the first step,
 *   starting as it's laid out on a ticket, can be its source;
 * - a terminal takes no handoff, so it can't wait as a step: it's made on its agent's tree (W7's terminal) as that
 *   agent starts at Lay out, and otherwise isn't laid out, saying how to add it once the agent has started.
 */
export function layOutPlan(b: TemplateBody, where: LayOutWhere): LayOutPlan {
  const first = b.steps[0];
  const named = (k: string) => b.steps.find((s) => s.key === k)!;
  const startsNow = (k: string) => b.startFirst && k === first.key;
  const steps: PlannedStep[] = b.steps.map((s) => {
    if (s.agent !== "terminal") return { step: s, starts: startsNow(s.key), terminal: null };
    const agent = named((s.folder as { sameAs: string }).sameAs);
    const laid = startsNow(agent.key);
    const why = laid
      ? `It's made on “${agent.name}”'s tree as “${agent.name}” starts.`
      : `It isn't laid out: a terminal takes no handoff, so it can't wait as a step, and “${agent.name}” doesn't start as this is laid out. Once it has, Add terminal on its tree makes one; run this there.`;
    return { step: s, starts: false, terminal: { laid, why } };
  });
  let forced = 0;
  const wires = b.wires.map((w): PlannedWire => {
    const automatic = w.gate === "automatic";
    const asks = automatic && where.room;
    if (asks) forced++;
    const to = named(w.to);
    const skipped = w.type === "worktree" && !steps.find((p) => p.step.key === to.key)!.terminal!.laid;
    let problem: string | null = null;
    if (w.when === "pr-merged") {
      const from = named(w.from);
      const why = !where.ticket ? "no ticket is chosen" : !startsNow(from.key) ? `“${from.name}” ${from.key === first.key ? "waits" : "isn't the first step, so it waits"} as this is laid out` : null;
      if (why) problem = `${from.name} → ${to.name} goes when “${from.name}”'s pull request merges, which needs “${from.name}” started on a ticket's branch, and ${why}.`;
    }
    return { wire: w, gate: asks ? "ask" : (w.gate ?? "ask"), forced: asks, afterStart: w.when === "pr-merged" || (w.type === "worktree" && !skipped), skipped, problem };
  });
  return { steps, wires, forced, problems: wires.flatMap((w) => (w.problem ? [w.problem] : [])) };
}

/** A template wire's settings as wires:add takes them (WireSettings), its gate `gate`. */
export function wireSettingsOf(w: TemplateWire, gate: WireGate): WireSettings {
  return {
    ...(w.template !== undefined ? { template: w.template } : {}),
    ...(w.files !== undefined ? { files: w.files } : {}),
    ...(w.when !== undefined ? { when: w.when } : {}),
    ...(carriesWork(w.type) ? { gate } : {}),
    ...(w.rounds !== undefined ? { limit: w.rounds } : {}),
    ...(w.toolOutput === false ? { toolOutput: false } : {}),
  };
}

/** How many of a template's gates are automatic: the picker's "1 automatic". */
export const automaticGates = (b: Pick<TemplateBody, "wires">): number => b.wires.filter((w) => w.gate === "automatic").length;

/** An agent step's agent, as a session runs it. */
export const agentOf = (s: Pick<TemplateStep, "agent">): AgentKind | null => (AGENT_KINDS.includes(s.agent as AgentKind) ? (s.agent as AgentKind) : null);

// ---- across the window and main ----------------------------------------------------------------

/** Lay out's request (templates:layOut): the template as the picker shows it, and where. */
export interface LayOutRequest {
  /** The template's name, for what's said. */
  name: string;
  template: TemplateBody;
  ticketId?: string | null;
  ticketTitle?: string | null;
  /** The repo its steps' worktrees (and checkouts) are in; none: their checkouts are home. */
  repoPath: string | null;
  /** A new worktree with nothing to start from is cut from origin's branch of this name. */
  base?: string | null;
  /** The area its steps go in: a top-level group. */
  area: string;
}
export interface LayOutReply {
  /** Each step made, by its key: its session's id and title. */
  steps: { key: string; id: string; title: string }[];
  /** Each wire made, by its id. */
  wires: string[];
  /** The first step's id, when it started. */
  started: string | null;
  /** What was forced, left out, or didn't go after the steps were made, each said. */
  notes: string[];
}

/** Save as template's first half (templates:draft): the chain as a template would keep it, and what that leaves out. */
export interface TemplateDraft {
  /** A name to start from. */
  name: string;
  body: TemplateBody;
  /** What was redacted, replaced or left out, each said. */
  notes: string[];
}
