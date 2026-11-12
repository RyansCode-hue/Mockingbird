import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { canonical, onDisk } from "./handlers";
import { redactSecrets } from "./wirePrompt";
import { tildePath } from "../shared/paths";
import { oneLine } from "../shared/team/agentText";
import { CONTROL_RE, hiddenTextRefusal, INVISIBLE_RE } from "../shared/hiddenText";
import { isRemotePaneId } from "../shared/team/livePanes";
import {
  kickoffAsTicket,
  ticketLine,
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
import { AGENT_NAME, ticketIdOf, type SessionInfo } from "../shared/types";
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
  /** A ticket's title as this Mac knows it (its pipeline record), for one a step's record names by id only. */
  ticketTitleOf?(id: string): string | null;
  /** The home folder, which is never a chain's folder; os.homedir() unless a test says otherwise. */
  home?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `s`'s name was made from its ticket or its branch ("#5115 — Stream the donor export", "5115-donor-export"):
 * a step named so would carry them to every ticket it's laid out for.
 */
function namedForTicket(s: SessionInfo, ticketTitle: string | null): boolean {
  const t = s.title.trim().toLowerCase();
  if (!t) return false;
  if (/#\d+/.test(t)) return true;
  const id = s.ticketId ? ticketIdOf(s.ticketId) : "";
  if (id && new RegExp(`(^|\\D)${escapeRe(id)}(\\D|$)`).test(t)) return true;
  const tt = (s.ticketTitle ?? ticketTitle)?.trim().toLowerCase();
  if (tt && tt.length >= 4 && t.includes(tt)) return true;
  const b = s.branch?.trim().toLowerCase();
  const slug = t.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return !!b && b.length >= 4 && /[\d/_-]/.test(b) && (t.includes(b) || slug === b);
}

/** Whether `f` is the home folder or holds it: never a chain's folder, so nothing under home becomes "[its folder]". */
const holdsHome = (f: string, home: string): boolean => {
  const h = onDisk(home);
  const c = onDisk(f);
  return c === h || h.startsWith(c.endsWith("/") ? c : `${c}/`);
};

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
  const home = d.home ?? os.homedir();

  // its folders, longest first so a worktree inside a repo goes whole, in each spelling a prompt might use; never the
  // home folder or one holding it (a step with no repo runs at home), which would turn any path there into its folder
  const folders = [
    ...new Set(
      all
        .flatMap((s) => [s.cwd, s.repoPath ?? ""])
        .filter((f) => f.length > 1 && !holdsHome(f, home))
        .flatMap((f) => [f, canonical(f), tildePath(f)])
    ),
  ].sort((a, b) => b.length - a.length);
  let redacted = 0;
  let pathsOut = 0;
  let hidden = 0;
  const clean = (t: string): string => {
    // what a template is laid out with is what's read: invisible and control characters go, said
    const seen = t.replace(INVISIBLE_RE, "").replace(CONTROL_RE, "");
    hidden += [...t].length - [...seen].length;
    let out = seen;
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
  const renamed: string[] = [];
  const ticketTitleOf = (s: SessionInfo): string | null => s.ticketTitle ?? (s.ticketId ? (d.ticketTitleOf?.(s.ticketId) ?? null) : null);
  const nameOf = (s: SessionInfo): string => {
    const neutral = s.shell ? "Terminal" : AGENT_NAME[s.agent ?? "claude"];
    const ticketed = namedForTicket(s, ticketTitleOf(s));
    if (ticketed) renamed.push(s.title);
    const base = (ticketed ? "" : oneLine(s.title, TEMPLATE_MAX.stepName - 3)) || neutral;
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
  const stillNamed: string[] = [];
  /**
   * What `s` was told, with each ticket kickoff and each "#id — title" its ticket filled `{ticket}` with (a step laid
   * out from a template) as `{ticket}` again. The ticket still named otherwise is said, as it may be on purpose.
   */
  const toldOf = (s: SessionInfo, name: string): string => {
    const k = kickoffAsTicket(s.planned?.prompt ?? "");
    kickoffs += k.count;
    let text = k.text;
    if (!s.ticketId) return text;
    const title = ticketTitleOf(s);
    const line = ticketLine(s.ticketId, title);
    if (title && text.includes(line)) {
      kickoffs += text.split(line).length - 1;
      text = text.split(line).join("{ticket}");
    }
    if (new RegExp(`#${escapeRe(ticketIdOf(s.ticketId))}(?!\\d)`).test(text)) stillNamed.push(`“${name}”`);
    return text;
  };
  const steps: TemplateStep[] = all.map((s, i) => {
    const name = nameOf(s);
    const told = toldOf(s, name);
    if (!s.planned && !s.shell) unsaid.push(name);
    const model = s.shell ? "" : oneLine(s.model ?? "", TEMPLATE_MAX.model);
    const effort = s.shell ? "" : oneLine(s.effort ?? "", TEMPLATE_MAX.model);
    return {
      key: keyOf.get(s.id)!,
      name,
      agent: s.shell ? "terminal" : (s.agent ?? "claude"),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      folder: folderOf(s, i),
      prompt: clean(told).slice(0, TEMPLATE_MAX.prompt),
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

  if (renamed.length)
    notes.push(
      `${renamed.map((t) => `“${t}”`).join(", ")} ${renamed.length === 1 ? "was named for its ticket or branch, so it's named for its agent" : "were named for their tickets or branches, so they're named for their agents"} here: name ${renamed.length === 1 ? "it for what it does" : "them for what they do"}.`
    );
  if (kickoffs) notes.push(`The ticket ${kickoffs === 1 ? "kickoff a step was told is" : "kickoffs its steps were told are"} {ticket} here: it's filled in with the ticket it's laid out for.`);
  if (redacted) notes.push(`${plural(redacted, "secret-looking value was", "secret-looking values were")} replaced with [redacted]: redaction is a net, so read what's below before saving it.`);
  if (pathsOut) notes.push(`${plural(pathsOut, "mention")} of the chain's folders became ${FOLDER_MARK}: a template is laid out in other folders.`);
  if (hidden) notes.push(`${plural(hidden, "invisible or control character was", "invisible or control characters were")} taken out: they hide text where you read it, or act in a terminal rather than show.`);
  if (stillNamed.length) notes.push(`${stillNamed.join(", ")} still ${stillNamed.length === 1 ? "names its ticket" : "name their tickets"} by number: say {ticket} where it's the ticket a lay-out is for.`);
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
  const chainName = steps.filter((s) => s.agent !== "terminal").map((s) => oneLine(s.name, 30)).join(" → ");
  const name = chainName.length <= TEMPLATE_MAX.name ? chainName : `${chainName.slice(0, TEMPLATE_MAX.name - 1)}…`;
  // what save refuses, said before anything's typed: home paths aren't the chain's folders, so they stay as they were
  const homeAt = textsOf(name, body).flatMap(({ where, text }) => (text && namesHome(text, home) ? [where] : []));
  if (homeAt.length) notes.push(`${homeAt.join(", ")} ${homeAt.length === 1 ? "names" : "name"} a folder in your home folder: a template is laid out in other folders, so take ${homeAt.length === 1 ? "it" : "them"} out before saving.`);
  return { name, body, notes };
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

/**
 * Whether `text` names `home` or a folder in it: spelled whole (not as the start of a longer name), as $HOME or
 * ${HOME}, or with a tilde: "~/x", "~sam/x" or "cd ~", wherever a shell would expand it (after a space, a quote, a
 * bracket, a comma, a redirect…), but not "~5 minutes".
 */
function namesHome(text: string, home: string): boolean {
  if (/\$\{?HOME\b/.test(text)) return true;
  if (/(^|[^\w~$])~([A-Za-z_][\w.-]*)?(?=$|[/\s"'`)\]},;:|&<>])/.test(text)) return true;
  if (home.length < 2) return false;
  // in any case: this Mac's volumes don't tell /USERS/sam from /Users/sam
  const t = text.toLowerCase();
  const h = home.toLowerCase();
  for (let at = t.indexOf(h); at >= 0; at = t.indexOf(h, at + 1)) {
    const next = t[at + h.length];
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
  if (read.broken) throw new Error(`${read.broken} Set them aside from Pipeline from a ticket… to start the list again.`);
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
    const hiddenWhy = hiddenTextRefusal(where, text);
    if (hiddenWhy) throw new Error(hiddenWhy);
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
  if (read.broken) throw new Error(`${read.broken} Set them aside from Pipeline from a ticket… to start the list again.`);
  if (!Array.isArray(stored)) throw new Error("That template isn't saved any more: there are no saved templates.");
  const hit = read.templates.find((t) => t.template.id === id)?.template.name ?? read.refused.find((r) => r.id === id)?.name ?? null;
  const at = (stored as unknown[]).findIndex((v) => !!v && typeof v === "object" && (v as { id?: unknown }).id === id);
  if (at < 0) throw new Error("That template isn't saved any more.");
  return { list: (stored as unknown[]).filter((_v, i) => i !== at), name: hit ?? "the template" };
}

/**
 * The saved templates set aside when they can't be read as a list (readTemplates' `broken`), which stops every save
 * and remove: a copy kept as it was, in `dir`, readable only by you, so the list can start again empty. Refused when
 * the list reads fine. Answers the copy's path.
 */
export function setAsideTemplates(stored: unknown, d: { dir: string; now?: () => number }): string {
  if (!readTemplates(stored).broken) throw new Error("The saved templates read as a list: there's nothing to set aside.");
  const stamp = new Date((d.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-");
  const file = path.join(d.dir, `pipelineTemplates-set-aside-${stamp}.json`);
  fs.mkdirSync(d.dir, { recursive: true });
  // a copy already there under this name stays: the write fails rather than replace it
  fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return file;
}
