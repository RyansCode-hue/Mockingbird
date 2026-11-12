import { randomUUID } from "crypto";
import { canonical } from "./handlers";
import { redactSecrets } from "./wirePrompt";
import { tildePath } from "../shared/paths";
import { oneLine } from "../shared/team/agentText";
import { isRemotePaneId } from "../shared/team/livePanes";
import {
  kickoffAsTicket,
  parseTemplateBody,
  readTemplates,
  TemplateError,
  TEMPLATE_MAX,
  type PipelineTemplate,
  type TemplateBody,
  type TemplateDraft,
  type TemplateFolder,
  type TemplateStep,
  type TemplateWire,
} from "../shared/pipelineTemplates";
import type { SessionInfo } from "../shared/types";
import { carriesWork, wiresInOrder, type WireBook } from "../shared/wires";

/**
 * Save as template (docs/landscape-wires.md, W9), in main: what a chain becomes as a template, and the list it's saved
 * into (`settings.pipelineTemplates`). Nothing secret and no folder of this Mac's is kept: a draft has secret-looking
 * values redacted (wirePrompt.ts' redactSecrets, as W2's tools do) and the chain's own folders taken out, and a save is
 * refused while its text holds either, so what's saved is exactly what the dialog showed.
 */

/** What a session's folder in a step's text becomes in a draft. */
export const FOLDER_MARK = "[its folder]";

export interface DraftDeps {
  /** A session of this Mac's, running, closed or not started, by id. */
  sessionOf(id: string): SessionInfo | undefined;
  /** The wire book, or why it can't be read. */
  book(): WireBook | { refused: string };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The chain `ids` (the pipeline strip's path, chainOf, first to last) as a template: its steps' agents, names, models,
 * prompts and folder choices, the terminals on their trees, and the wires among them with their settings. A
 * not-started step's prompt is its "Tell it"; a running one's isn't kept anywhere, so it's empty for the user to fill
 * in. A ticket kickoff in a prompt becomes `{ticket}`, the chain's folders become FOLDER_MARK, and secret-looking values
 * are redacted, each said in `notes`. Throws saying why when it can't be one.
 */
export function draftTemplate(idsRaw: unknown, d: DraftDeps): TemplateDraft {
  if (!Array.isArray(idsRaw) || !idsRaw.length) throw new Error("There's no chain to save: Save as template saves the workspaces a chain of wires joins.");
  const ids = [...new Set(idsRaw.map((x) => String(x)))];
  const book = d.book();
  if ("refused" in book) throw new Error(book.refused);
  const sessionOf = (id: string): SessionInfo => {
    if (isRemotePaneId(id)) throw new Error("That's a teammate's session: a template is saved from your own workspaces.");
    const s = d.sessionOf(id);
    if (!s) throw new Error(`This Mac has no session "${id}" any more.`);
    if (s.debrief || s.role === "tasks") throw new Error(`“${s.ticketTitle ?? s.title}” takes no wires, so it's in no chain.`);
    return s;
  };
  const agents = ids.map(sessionOf);
  for (const s of agents) if (s.shell) throw new Error(`“${s.title}” is a terminal: a chain's steps are agents, and a terminal goes with the agent whose tree it shares.`);
  const links = wiresInOrder(book.links);
  // the terminals on the chain's trees, after its agents
  const terminals = [...new Set(links.filter(([, w]) => w.type === "worktree" && ids.includes(w.from) && !ids.includes(w.to)).map(([, w]) => w.to))].flatMap((id) => {
    const s = d.sessionOf(id);
    return s?.shell ? [s] : [];
  });
  const all = [...agents, ...terminals];
  if (all.length > TEMPLATE_MAX.steps) throw new Error(`The chain has ${all.length} workspaces with its terminals: a template has at most ${TEMPLATE_MAX.steps}.`);
  const keyOf = new Map(all.map((s, i) => [s.id, `s${i + 1}`]));
  const notes: string[] = [];

  // its folders, longest first so a worktree inside a repo goes whole, in each spelling a prompt might use
  const folders = [...new Set(all.flatMap((s) => [s.cwd, s.repoPath ?? ""]).filter((f) => f.length > 1).flatMap((f) => [f, canonical(f), tildePath(f)]))].sort((a, b) => b.length - a.length);
  let redacted = 0;
  let pathsOut = 0;
  const clean = (t: string): string => {
    let out = t;
    for (const f of folders) {
      const parts = out.split(f);
      pathsOut += parts.length - 1;
      out = parts.join(FOLDER_MARK);
    }
    const r = redactSecrets(out);
    redacted += r.count;
    return r.text;
  };

  const names = new Set<string>();
  const nameOf = (s: SessionInfo): string => {
    const base = oneLine(s.title, TEMPLATE_MAX.stepName - 3) || (s.shell ? "Terminal" : "Step");
    let n = base;
    for (let i = 2; names.has(n.toLowerCase()); i++) n = `${base} ${i}`;
    names.add(n.toLowerCase());
    return n;
  };
  const folderOf = (s: SessionInfo, i: number): TemplateFolder => {
    if (s.shell) {
      const agent = links.find(([, w]) => w.type === "worktree" && w.to === s.id)![1].from;
      return { sameAs: keyOf.get(agent)! };
    }
    if (s.planned) {
      const shares = s.planned.sharesWith;
      if (shares) {
        const at = agents.findIndex((x) => x.id === shares);
        if (at >= 0 && at < i) return { sameAs: keyOf.get(shares)! };
        notes.push(`“${s.title}” works in the folder of a workspace outside the chain: it's saved with a worktree of its own.`);
        return "new";
      }
      return s.planned.worktree ? "new" : "checkout";
    }
    const here = canonical(s.cwd);
    const before = agents.slice(0, i).find((x) => !x.planned && canonical(x.cwd) === here);
    if (before) return { sameAs: keyOf.get(before.id)! };
    return s.repoPath && here !== canonical(s.repoPath) ? "new" : "checkout";
  };

  let kickoffs = 0;
  const unsaid: string[] = [];
  const steps: TemplateStep[] = all.map((s, i) => {
    const told = s.planned?.prompt ?? "";
    const k = kickoffAsTicket(told);
    kickoffs += k.count;
    if (!s.planned && !s.shell) unsaid.push(s.title);
    const model = s.shell ? "" : oneLine(s.model ?? "", TEMPLATE_MAX.model);
    const effort = s.shell ? "" : oneLine(s.effort ?? "", TEMPLATE_MAX.model);
    return {
      key: keyOf.get(s.id)!,
      name: nameOf(s),
      agent: s.shell ? "terminal" : (s.agent ?? "claude"),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      folder: folderOf(s, i),
      prompt: clean(k.text).slice(0, TEMPLATE_MAX.prompt),
    };
  });

  let outside = 0;
  const wires: TemplateWire[] = [];
  for (const [, w] of links) {
    const from = keyOf.get(w.from);
    const to = keyOf.get(w.to);
    if (!from || !to) {
      if (keyOf.has(w.from) || keyOf.has(w.to)) outside++;
      continue;
    }
    wires.push({
      from,
      to,
      type: w.type,
      ...(carriesWork(w.type) ? { when: w.when, gate: w.gate } : {}),
      ...(w.template !== undefined ? { template: clean(w.template).slice(0, TEMPLATE_MAX.prompt) } : {}),
      ...(w.files?.length ? { files: w.files } : {}),
      ...(w.rounds ? { rounds: Math.min(TEMPLATE_MAX.rounds, w.rounds.limit) } : {}),
      ...(w.toolOutput === false ? { toolOutput: false as const } : {}),
    });
  }

  if (kickoffs) notes.push(`The ticket ${kickoffs === 1 ? "kickoff a step was told is" : "kickoffs its steps were told are"} {ticket} here: it's filled in with the ticket it's laid out for.`);
  if (redacted) notes.push(`${plural(redacted, "secret-looking value was", "secret-looking values were")} replaced with [redacted]: redaction is a net, so read what's below before saving it.`);
  if (pathsOut) notes.push(`${plural(pathsOut, "mention")} of the chain's folders became ${FOLDER_MARK}: a template is laid out in other folders.`);
  if (outside) notes.push(`${plural(outside, "wire")} to workspaces outside the chain ${outside === 1 ? "isn't" : "aren't"} kept.`);
  if (unsaid.length) notes.push(`What ${unsaid.map((t) => `“${t}”`).join(", ")} ${unsaid.length === 1 ? "was" : "were"} told as ${unsaid.length === 1 ? "it" : "they"} started isn't kept once running: say it here${terminals.length ? `, and what ${terminals.length === 1 ? "its terminal runs" : "each terminal runs"}` : ""}.`);
  else if (terminals.length) notes.push(`What ${terminals.length === 1 ? "its terminal runs" : "its terminals run"} isn't kept: say it here.`);

  const body: TemplateBody = { startFirst: true, steps, wires };
  try {
    parseTemplateBody(body);
  } catch (err) {
    if (err instanceof TemplateError) throw new Error(`This chain can't be a template: ${err.message}`, { cause: err });
    throw err;
  }
  const chainName = agents.map((s) => oneLine(s.title, 30)).join(" → ");
  return { name: chainName.length <= TEMPLATE_MAX.name ? chainName : `${chainName.slice(0, TEMPLATE_MAX.name - 1)}…`, body, notes };
}

/** Each piece of text a template keeps, with where it is for what's said. */
function textsOf(name: string, b: TemplateBody): { where: string; text: string }[] {
  const n = (k: string) => b.steps.find((s) => s.key === k)?.name ?? k;
  return [
    { where: "Its name", text: name },
    ...b.steps.flatMap((s) => [
      { where: `“${s.name}”'s name`, text: s.name },
      { where: `“${s.name}”'s ${s.agent === "terminal" ? "command" : "prompt"}`, text: s.prompt },
      { where: `“${s.name}”'s model`, text: s.model ?? "" },
      { where: `“${s.name}”'s effort`, text: s.effort ?? "" },
    ]),
    ...b.wires.flatMap((w) => [
      { where: `${n(w.from)} → ${n(w.to)}'s What flows`, text: w.template ?? "" },
      ...(w.files ?? []).map((f) => ({ where: `${n(w.from)} → ${n(w.to)}'s files`, text: f })),
    ]),
  ];
}

/** Whether `text` names `home` or a folder in it: spelled whole (not as the start of a longer name), or with "~/". */
function namesHome(text: string, home: string): boolean {
  if (/(^|[\s"'`(=:])~\//.test(text)) return true;
  if (home.length < 2) return false;
  for (let at = text.indexOf(home); at >= 0; at = text.indexOf(home, at + 1)) {
    const next = text[at + home.length];
    if (next === undefined || !/[\w.-]/.test(next)) return true;
  }
  return false;
}

export interface SaveDeps {
  home: string;
  now?: () => number;
  newId?: () => string;
}

/**
 * `stored` (settings.pipelineTemplates as it is) with template `name`, `body` added: refused, saying why, for a list that
 * can't be read, a name another template has, a body that isn't one, and text holding a secret-looking value or naming
 * a folder in the home folder. Every entry already there is kept as it is, ones this version can't read included.
 */
export function savedTemplates(nameRaw: unknown, bodyRaw: unknown, stored: unknown, d: SaveDeps): { list: unknown[]; template: PipelineTemplate } {
  const read = readTemplates(stored);
  if (read.broken) throw new Error(read.broken);
  const raw = typeof nameRaw === "string" ? nameRaw : "";
  if (/[\r\n]/.test(raw)) throw new Error("A template's name is one line.");
  const name = oneLine(raw, TEMPLATE_MAX.name * 4);
  if (!name) throw new Error("Name the template.");
  if (name.length > TEMPLATE_MAX.name) throw new Error(`A template's name is at most ${TEMPLATE_MAX.name} characters.`);
  const taken = [...read.templates.map((t) => t.template.name), ...read.refused.flatMap((r) => (r.name ? [r.name] : []))];
  if (taken.some((t) => t.toLowerCase() === name.toLowerCase())) throw new Error(`There's a template called “${name}” already: name this one another way, or remove that one first.`);
  let body: TemplateBody;
  try {
    body = parseTemplateBody(bodyRaw);
  } catch (err) {
    if (err instanceof TemplateError) throw new Error(`It can't be saved: ${err.message}`, { cause: err });
    throw err;
  }
  for (const { where, text } of textsOf(name, body)) {
    if (!text) continue;
    const r = redactSecrets(text);
    if (r.count) throw new Error(`${where} holds ${plural(r.count, "secret-looking value")}: take ${r.count === 1 ? "it" : "them"} out, as a template is kept in Mockingbird's settings and laid out for other tickets.`);
    if (namesHome(text, d.home)) throw new Error(`${where} names a folder in your home folder: a template is laid out in other folders, so it names none of this Mac's. Say “${FOLDER_MARK}”, or take it out.`);
  }
  const ids = new Set([...read.templates.map((t) => t.template.id), ...read.refused.flatMap((r) => (r.id ? [r.id] : []))]);
  let id = "";
  do id = d.newId?.() ?? `tpl-${randomUUID().slice(0, 8)}`;
  while (ids.has(id));
  const template: PipelineTemplate = { id, name, savedAt: (d.now ?? Date.now)(), ...body };
  return { list: [...(Array.isArray(stored) ? stored : []), template], template };
}

/** `stored` without template `id`: one this version can't read too, when its id can be. Refused when there's none. */
export function removedTemplate(idRaw: unknown, stored: unknown): { list: unknown[]; name: string } {
  const id = String(idRaw ?? "");
  const read = readTemplates(stored);
  if (read.broken) throw new Error(read.broken);
  const hit = read.templates.find((t) => t.template.id === id)?.template.name ?? read.refused.find((r) => r.id === id)?.name ?? null;
  const at = (stored as unknown[]).findIndex((v) => !!v && typeof v === "object" && (v as { id?: unknown }).id === id);
  if (at < 0) throw new Error("That template isn't saved any more.");
  return { list: (stored as unknown[]).filter((_v, i) => i !== at), name: hit ?? "the template" };
}
