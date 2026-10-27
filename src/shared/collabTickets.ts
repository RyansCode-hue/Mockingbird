import { HOUSE_PRIORITIES, NEEDS_AGENT, NEEDS_HUMAN } from "./team/house";

/**
 * An approved Council plan as Radley House tickets (README, Council): the
 * plan split into drafts without a model where it has a checklist, numbered
 * steps or step-like sections; the user's edits to the drafts before anything
 * is sent; and what the main process answers about where they can go and what
 * was created.
 */

export type TicketPriority = (typeof HOUSE_PRIORITIES)[number];

export interface TicketDraft {
  id: string;
  title: string;
  detail: string;
  acceptance: string;
  priority: TicketPriority;
  tags: string[];
}

/** How the drafts were made: from the plan's checklist, its numbered steps or its sections; by a model; or by hand. */
export type SplitHow = "checklist" | "steps" | "sections" | "model" | "manual";

/** A council's drafts while the user reviews them (kept with the council, so closing the review loses nothing). */
export interface CouncilTicketDrafts {
  drafts: TicketDraft[];
  how: SplitHow;
  /** The model that split it (how: "model"). */
  by?: string;
  at: number;
}

/** A ticket made from the council's plan, linked from the discussion. */
export interface CouncilHouseTicket {
  n: number;
  title: string;
  project: string;
  /** The team room it was created through (its House project), or null for a project chosen directly. */
  roomId: string | null;
  room: string | null;
  at: number;
}

/** Whether this member's token may be used there: allowed, not asked yet, or Not now. */
export type TargetConnection = "connected" | "consent" | "declined";

/** Where a council's tickets can be created. */
export type CouncilHouseTarget =
  /** A team room working in the council's repository: its House project (none chosen yet: project null). */
  | { kind: "room"; roomId: string; room: string; project: string | null; admin: string | null; connection: TargetConnection }
  /** A project this Mac has a builder token file for (~/.config/radley-house/<project>.env). */
  | { kind: "project"; project: string; connection: TargetConnection };

export interface CouncilHouseTargets {
  targets: CouncilHouseTarget[];
  /** The council's repository is in a team room, so only its room's project is offered. */
  inRoom: boolean;
}

/** Which target a create or a consent is for, as the window names it. */
export type TicketTargetRef = { roomId: string } | { project: string };

export interface CouncilCreateResult {
  project: string;
  room: string | null;
  created: { draftId: string; n: number; title: string; tagsProblem?: string }[];
  /** The ticket the House refused (creating stops there). */
  failed: { draftId: string; title: string; error: string } | null;
  /** Drafts after the failed one, not sent. */
  notSent: { draftId: string; title: string }[];
}

export const targetKey = (t: TicketTargetRef | CouncilHouseTarget): string => ("roomId" in t ? `room:${t.roomId}` : `project:${t.project}`);
export const targetRef = (t: CouncilHouseTarget): TicketTargetRef => (t.kind === "room" ? { roomId: t.roomId } : { project: t.project });

/** "Create 5 tickets in atticus-backoffice" — what the button does, exactly. */
export function createLabel(count: number, project: string | null): string {
  return `Create ${count} ticket${count === 1 ? "" : "s"}${project ? ` in ${project}` : ""}`;
}

/** The line every draft's detail ends with, so a ticket leads back to where it was decided. */
export const councilLine = (council: string): string => `From the Council discussion “${council.replace(/\s+/g, " ").trim()}”.`;

const PRIORITY_RANK: Record<TicketPriority, number> = { high: 0, medium: 1, low: 2, investigate: 3 };
export const isPriority = (p: unknown): p is TicketPriority => HOUSE_PRIORITIES.includes(p as TicketPriority);

let seq = 0;
/** A draft id unique in this window or process. */
export const draftId = (): string => `d${Date.now().toString(36)}${(seq++).toString(36)}`;

export function blankDraft(council: string, tags: string[] = [NEEDS_AGENT]): TicketDraft {
  return { id: draftId(), title: "", detail: councilLine(council), acceptance: "", priority: "medium", tags: [...tags] };
}

// ---- splitting without a model ----------------------------------------------------------------

interface Line {
  text: string;
  indent: number;
  /** Inside a fenced code block (``` or ~~~): never structure. */
  code: boolean;
}

interface Section {
  level: number;
  title: string;
  /** Index of the heading line (-1: the text before the first heading). */
  at: number;
  /** Lines after the heading up to the next heading of the same or a higher level. */
  start: number;
  end: number;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const CHECK = /^[-*+]\s+\[[ xX]\]\s+(.*)$/;
const NUMBERED = /^\d{1,3}[.)]\s+(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;
/** A heading over the work itself. */
const WORK_HEADING = /\b(steps?|implementation|implement|tasks?|work|phases?|milestones?|tickets?|to-?dos?|order|rollout|plan)\b/i;
/** A heading over everything around the work: never split into tickets. */
const CONTEXT_HEADING = /\b(goals?|acceptance|done when|decisions?|risks?|files?|verif\w*|testing|tests?|questions?|non-goals?|out of scope|summary|background|context|why|disagree\w*|recommend\w*|alternatives?|notes?|assumptions?)\b/i;
/** A heading that is itself a step: "Step 2 — …", "Phase 1: …", "3. …". */
const STEP_HEADING = /^(?:(?:step|phase|part|milestone|stage|ticket)\s*\d+\b|\d{1,3}[.)]\s)/i;
const ACCEPTANCE_LEAD = /^(?:acceptance(?:\s+criteria)?|done when|definition of done|verify|verified by|tests?|test plan|how to verify)\s*[:—–-]\s*/i;
const ACCEPTANCE_HEADING = /^(?:acceptance(?:\s+criteria)?|done when|definition of done|verif\w*|how to verify|tests?)\b/i;

function lines(text: string): Line[] {
  let code = false;
  return text.replace(/\r\n?/g, "\n").split("\n").map((raw) => {
    const t = raw.replace(/\t/g, "    ");
    const fence = /^\s*(```|~~~)/.test(t);
    const line = { text: t.trim(), indent: t.length - t.trimStart().length, code: code || fence };
    if (fence) code = !code;
    return line;
  });
}

function sections(ls: Line[]): Section[] {
  const heads = ls.flatMap((l, i) => {
    const m = !l.code && l.indent < 4 ? HEADING.exec(l.text) : null;
    return m ? [{ level: m[1].length, title: m[2], at: i }] : [];
  });
  return heads.map((h, k) => {
    const next = heads.slice(k + 1).find((x) => x.level <= h.level);
    return { ...h, start: h.at + 1, end: next ? next.at : ls.length };
  });
}

/** Markdown emphasis off a title: **bold**, __bold__, a trailing colon. */
const plain = (s: string): string => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/^\*(.+)\*$/, "$1").replace(/[:：]\s*$/, "").trim();

/** A priority written into the text ("(high)", "priority: low", "P1"), and the text without it. */
function priorityIn(text: string): { priority: TicketPriority | null; rest: string } {
  const pats: [RegExp, (m: RegExpExecArray) => TicketPriority][] = [
    [/\s*[([]\s*(?:priority[:\s]+)?(high|medium|low|investigate)(?:\s+priority)?\s*[)\]]/i, (m) => m[1].toLowerCase() as TicketPriority],
    [/\s*[—–-]?\s*\bpriority[:\s]+(high|medium|low|investigate)\b/i, (m) => m[1].toLowerCase() as TicketPriority],
    [/\s*[([]?\bP([0-3])\b[)\]]?/, (m) => (["high", "high", "medium", "low"] as const)[Number(m[1])]],
  ];
  for (const [re, pick] of pats) {
    const m = re.exec(text);
    if (m) return { priority: pick(m), rest: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\s{2,}/g, " ").trim() };
  }
  return { priority: null, rest: text };
}

/**
 * One item's first line as a title, and what doesn't fit in one: a bold lead
 * ("**Endpoint** — streams rows") keeps the lead; a long line keeps its first
 * sentence; the rest starts the detail.
 */
function titleOf(first: string): { title: string; more: string } {
  const lead = /^(\*\*|__)(.+?)\1\s*(?:[:—–-]\s*)?(.*)$/.exec(first);
  if (lead && lead[3]) return { title: plain(lead[2]), more: lead[3].trim() };
  const t = plain(first);
  if (t.length <= 120) return { title: t, more: "" };
  const stop = t.slice(0, 120).search(/[.;](\s|$)(?=.)/);
  if (stop > 20) return { title: t.slice(0, stop).trim(), more: t.slice(stop + 1).trim() };
  return { title: `${t.slice(0, 196).trimEnd()}…`, more: t };
}

/** A part of the plan that becomes one ticket: its first line, then its body (dedented). */
function draftOf(first: string, body: string[], council: string, defaultTags: string[]): TicketDraft {
  const { priority, rest } = priorityIn(first);
  const { title, more } = titleOf(rest);
  const detail: string[] = [];
  const acceptance: string[] = [];
  let inAcceptance = false;
  for (const raw of body) {
    const l = raw.trim();
    const item = BULLET.exec(l) ?? NUMBERED.exec(l);
    const lead = ACCEPTANCE_LEAD.exec(item ? item[1] : l);
    const head = HEADING.exec(l);
    if (head) {
      inAcceptance = ACCEPTANCE_HEADING.test(head[2]);
      if (!inAcceptance) detail.push(raw);
      continue;
    }
    if (lead) {
      const said = (item ? item[1] : l).slice(lead[0].length).trim();
      if (said) acceptance.push(`- ${said}`);
      inAcceptance = !said; // "Acceptance:" alone: the lines under it are the criteria
      continue;
    }
    if (inAcceptance && l) acceptance.push(item ? `- ${item[1]}` : l);
    else detail.push(raw);
  }
  const body2 = [more, dedent(detail).trim()].filter(Boolean).join("\n");
  const p = priority ?? (/^(spike|investigate|explore|research)\b/i.test(title) ? "investigate" : "medium");
  return {
    id: draftId(),
    title: title.slice(0, 200),
    detail: [body2, councilLine(council)].filter(Boolean).join("\n\n"),
    acceptance: acceptance.join("\n"),
    priority: p,
    tags: [...defaultTags],
  };
}

function dedent(ls: string[]): string {
  const ind = ls.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const min = ind.length ? Math.min(...ind) : 0;
  return ls.map((l) => l.slice(Math.min(min, l.length - l.trimStart().length))).join("\n").replace(/\n{3,}/g, "\n\n");
}

/** The items of the list at its shallowest level within [start, end): each item's first line and the lines under it. */
function listItems(ls: Line[], start: number, end: number, match: (l: Line) => RegExpExecArray | null): { first: string; body: string[] }[] | null {
  const hits = [];
  for (let i = start; i < end; i++) if (!ls[i].code && match(ls[i])) hits.push(i);
  if (!hits.length) return null;
  const top = Math.min(...hits.map((i) => ls[i].indent));
  const items = hits.filter((i) => ls[i].indent === top);
  if (items.length < 2) return null;
  return items.map((at, k) => {
    // an item runs to the next one, or to the first line back at (or left of) its own indent that isn't part of it
    const stop = items[k + 1] ?? end;
    const body: string[] = [];
    let blank = false;
    for (let i = at + 1; i < stop; i++) {
      const l = ls[i];
      if (!l.text) {
        blank = true;
        body.push("");
        continue;
      }
      if (!l.code && l.indent <= top && (blank || HEADING.test(l.text))) break;
      blank = false;
      body.push(" ".repeat(Math.max(0, l.indent - top)) + l.text);
    }
    return { first: match(ls[at])![1], body };
  });
}

/**
 * Split an approved plan into ticket drafts without a model, when the plan
 * says where the tickets are: a checklist (each box a ticket), numbered steps
 * under a heading about the work (or the plan's only numbered list), or
 * step-like sections ("## Step 1 — …", "### Phase 2: …", or the sub-sections
 * of a "Steps" section). Goals, decisions, risks, files and verification are
 * never tickets. Null when it can't tell: the review then offers a model's
 * split, or one ticket written by hand.
 */
export function splitPlan(plan: string, o: { council: string; tags?: string[] }): { drafts: TicketDraft[]; how: Exclude<SplitHow, "model" | "manual"> } | null {
  const ls = lines(plan);
  const secs = sections(ls);
  const tags = o.tags ?? [NEEDS_AGENT];
  const make = (items: { first: string; body: string[] }[]) => items.map((it) => draftOf(it.first, it.body, o.council, tags));
  const contextual = (i: number) => secs.some((s) => i >= s.start && i < s.end && CONTEXT_HEADING.test(s.title) && !WORK_HEADING.test(s.title));

  // a checklist anywhere outside the context sections
  const checks = listItems(ls, 0, ls.length, (l) => (contextual(ls.indexOf(l)) ? null : CHECK.exec(l.text)));
  if (checks) return { drafts: make(checks), how: "checklist" };

  // the sections about the work, the most specific first ("## Steps" before the "# Plan" around it):
  // their sub-sections (but goals, risks… and other work sections), else their list
  const work = secs.filter((x) => WORK_HEADING.test(x.title) && !STEP_HEADING.test(x.title) && !CONTEXT_HEADING.test(x.title.replace(WORK_HEADING, ""))).sort((a, b) => b.level - a.level);
  for (const s of work) {
    const inside = secs.filter((x) => x.at > s.at && x.at < s.end);
    const children = inside.filter((x) => x.level === Math.min(...inside.map((y) => y.level)));
    const subs = children.filter((x) => !CONTEXT_HEADING.test(x.title));
    if (!subs.some((x) => work.includes(x)) && subs.length >= 2) return { drafts: subs.map((x) => draftOf(x.title, ls.slice(x.start, x.end).map((l) => " ".repeat(l.indent) + l.text), o.council, tags)), how: "sections" };
    const own = (re: RegExp) => (l: Line) => (contextual(ls.indexOf(l)) ? null : re.exec(l.text));
    const items = listItems(ls, s.start, s.end, own(NUMBERED)) ?? listItems(ls, s.start, s.end, own(BULLET));
    if (items) return { drafts: make(items), how: "steps" };
  }

  // headings that are steps themselves
  const stepHeads = secs.filter((s) => STEP_HEADING.test(s.title));
  const level = stepHeads.length ? Math.min(...stepHeads.map((s) => s.level)) : 0;
  const steps = stepHeads.filter((s) => s.level === level);
  if (steps.length >= 2) return { drafts: steps.map((x) => draftOf(x.title.replace(/^(?:(?:step|phase|part|milestone|stage|ticket)\s*\d+\s*[:.—–-]?\s*|\d{1,3}[.)]\s+)/i, "") || x.title, ls.slice(x.start, x.end).map((l) => " ".repeat(l.indent) + l.text), o.council, tags)), how: "sections" };

  // the plan's numbered list, outside the context sections
  const numbered = listItems(ls, 0, ls.length, (l) => (contextual(ls.indexOf(l)) ? null : NUMBERED.exec(l.text)));
  if (numbered) return { drafts: make(numbered), how: "steps" };
  return null;
}

// ---- the review's edits -----------------------------------------------------------------------

export function updateDraft(drafts: TicketDraft[], id: string, patch: Partial<Omit<TicketDraft, "id">>): TicketDraft[] {
  return drafts.map((d) => (d.id === id ? { ...d, ...patch } : d));
}

export function removeDrafts(drafts: TicketDraft[], ids: Iterable<string>): TicketDraft[] {
  const gone = new Set(ids);
  return drafts.filter((d) => !gone.has(d.id));
}

/** Move a draft by `by` places (−1 up, +1 down), staying in the list. */
export function moveDraft(drafts: TicketDraft[], id: string, by: number): TicketDraft[] {
  const from = drafts.findIndex((d) => d.id === id);
  if (from < 0) return drafts;
  const to = Math.max(0, Math.min(drafts.length - 1, from + by));
  if (to === from) return drafts;
  const out = drafts.slice();
  const [d] = out.splice(from, 1);
  out.splice(to, 0, d);
  return out;
}

/**
 * Merge drafts into the first of them (in list order), where it stands: its
 * title; every detail, the others' under their titles; all acceptance
 * criteria; the highest priority; every tag (needs-human wins over
 * needs-agent, never both). The council line appears once, at the end.
 */
export function mergeDrafts(drafts: TicketDraft[], ids: Iterable<string>, council: string): TicketDraft[] {
  const pick = new Set(ids);
  const parts = drafts.filter((d) => pick.has(d.id));
  if (parts.length < 2) return drafts;
  const line = councilLine(council);
  const strip = (s: string) => s.split("\n").filter((l) => l.trim() !== line).join("\n").trim();
  const [head, ...rest] = parts;
  const detail = [strip(head.detail), ...rest.map((d) => [d.title, strip(d.detail)].filter(Boolean).join("\n"))].filter(Boolean).join("\n\n");
  const hadLine = parts.some((d) => d.detail.includes(line));
  const tags = [...new Set(parts.flatMap((d) => d.tags))];
  const merged: TicketDraft = {
    id: head.id,
    title: head.title,
    detail: [detail, hadLine ? line : ""].filter(Boolean).join("\n\n"),
    acceptance: parts.map((d) => d.acceptance.trim()).filter(Boolean).join("\n"),
    priority: parts.map((d) => d.priority).sort((a, b) => PRIORITY_RANK[a] - PRIORITY_RANK[b])[0],
    tags: tags.includes(NEEDS_HUMAN) ? tags.filter((t) => t !== NEEDS_AGENT) : tags,
  };
  return drafts.flatMap((d) => (d.id === head.id ? [merged] : pick.has(d.id) ? [] : [d]));
}

/** Tags typed as "a, b c": trimmed, de-duplicated, never empty. */
export const parseTags = (text: string): string[] => [...new Set(text.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean))];

/** What stops a draft being sent, per draft id; the House's own limits are checked again when it's sent. */
export function draftProblems(drafts: TicketDraft[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of drafts) {
    if (!d.title.trim()) out.set(d.id, "needs a title");
    else if (d.title.length > 200) out.set(d.id, `title is ${d.title.length} characters; the House takes 200`);
    else if (!d.detail.trim()) out.set(d.id, "needs some detail");
    else if (d.tags.includes(NEEDS_HUMAN) && d.tags.includes(NEEDS_AGENT)) out.set(d.id, `can't be both ${NEEDS_HUMAN} and ${NEEDS_AGENT}`);
  }
  return out;
}

/** A draft as the window or a model sent it, checked: null when it isn't one. */
export function asDraft(v: unknown): TicketDraft | null {
  const x = v as Partial<TicketDraft> | null;
  if (!x || typeof x !== "object") return null;
  if (typeof x.id !== "string" || typeof x.title !== "string" || typeof x.detail !== "string" || typeof x.acceptance !== "string") return null;
  if (!isPriority(x.priority) || !Array.isArray(x.tags) || !x.tags.every((t) => typeof t === "string")) return null;
  return { id: x.id.slice(0, 40), title: x.title, detail: x.detail, acceptance: x.acceptance, priority: x.priority, tags: x.tags };
}

/** The most tickets a model's split may make (a plan that needs more is split by hand). */
export const MAX_MODEL_TICKETS = 30;

/** The whole plan as one draft: what the review offers when the plan has no steps to split by. */
export function wholePlanDraft(plan: string, council: string, tags: string[] = [NEEDS_AGENT]): TicketDraft {
  return { id: draftId(), title: council.replace(/\s+/g, " ").trim().slice(0, 200), detail: `${plan.trim()}\n\n${councilLine(council)}`, acceptance: "", priority: "medium", tags: [...tags] };
}

/**
 * A model's split, read as the JSON list it was asked for (a fenced block or
 * prose around it is allowed): each ticket's title, detail, acceptance and
 * priority, as drafts with the council line and the default tags. Throws,
 * saying what was wrong, when it isn't such a list.
 */
export function draftsFromModel(reply: string, council: string, tags: string[] = [NEEDS_AGENT]): TicketDraft[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("The model didn't answer with a list of tickets");
  let list: unknown;
  try {
    list = JSON.parse(reply.slice(start, end + 1));
  } catch (err) {
    throw new Error(`The model's list of tickets isn't valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(list) || !list.length) throw new Error("The model's answer has no tickets in it");
  if (list.length > MAX_MODEL_TICKETS) throw new Error(`The model split the plan into ${list.length} tickets; at most ${MAX_MODEL_TICKETS} can be reviewed at once`);
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => `- ${x}`).join("\n") : "");
  return list.map((t, i) => {
    const x = (t ?? {}) as Record<string, unknown>;
    const title = str(x.title).replace(/\s+/g, " ");
    if (!title) throw new Error(`Ticket ${i + 1} in the model's answer has no title`);
    const p = typeof x.priority === "string" ? x.priority.toLowerCase().trim() : "";
    return {
      id: draftId(),
      title: title.slice(0, 200),
      detail: [str(x.detail ?? x.description), councilLine(council)].filter(Boolean).join("\n\n"),
      acceptance: str(x.acceptance ?? x.acceptance_criteria),
      priority: isPriority(p) ? p : "medium",
      tags: [...tags],
    };
  });
}
