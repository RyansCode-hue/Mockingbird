import * as fs from "fs";
import * as path from "path";
import type { SessionInfo } from "../shared/types";
import { claudeTranscriptOf, epochMs } from "./agentFiles";
import { isMissing, readJsonFile, readWindow } from "./fileOps";
import { CONTEXT_DIR, CONVERSATION_ID_RE, claudeExtras, rolloutFileOf } from "./usage";

/**
 * Which model (and Codex reasoning effort) a session's agent reported running in a launch, from the files its CLI
 * writes: Claude's transcript (each reply's message.model, and the output of a `/model` typed in its pane) and the
 * statusline payload the reporter keeps for the conversation (model.id, current as soon as a /model is typed), Codex's
 * rollout (each turn's turn_context). Each is read from its end, so a read stays bounded however long the conversation
 * runs.
 */

/** One report of what an agent runs: its model and, from Codex, its reasoning effort (null: the model's default). */
export interface ModelReport {
  model: string;
  effort?: string | null;
}

/**
 * What a Claude `/model` typed in a pane set it to: the alias it named when that's one whose line covers several models
 * (opusplan), else the model it ran after the command. `named` says the command's output named what it set, so that's
 * exactly what was picked; when its output couldn't be read, an alias covering the model ran after it may be what was.
 */
export interface ChosenModel {
  model: string;
  named: boolean;
}

/**
 * What an agent reported running in one launch: its first report (null: not known), the earliest of those read (its
 * first when that's known), and its latest, made at `at`. `chosen` is Claude's: what its latest `/model` this launch set
 * it to, or null when none within reach set it — a change it reports without one is its own (a fallback at a plan
 * limit, plan mode's model), not a choice. Codex has none: its model changes only when one is picked.
 */
export interface LaunchModels {
  first: ModelReport | null;
  earliest: ModelReport;
  last: ModelReport;
  at: number;
  chosen?: ChosenModel | null;
}

/** How much of a file's end is read for its latest report. */
const TAIL_BYTES = 256 * 1024;
/** How much of a file's end is read, at most, for a launch's first report. */
const FIRST_BYTES = 4 * 1024 * 1024;

/** A line's report of the model running, or (`set`) what a model switch typed in the pane says it set. */
type Dated = { at: number; report?: ModelReport; set?: string };

/**
 * What `file` says at or after `since`, oldest first, read from its end (`parse` gives a line's, or null). With
 * `first`, a read that doesn't reach back past it is made again further back, up to FIRST_BYTES. `whole` says it's all
 * of it: the read reached a line from before `since`, or the file's start.
 */
function seenSince(file: string, since: number, parse: (line: string) => Dated | null, first: boolean): { seen: Dated[]; whole: boolean } {
  const sizes = first ? [TAIL_BYTES, FIRST_BYTES] : [TAIL_BYTES];
  for (let k = 0; ; k++) {
    const w = readWindow(file, "end", sizes[k]);
    const lines = w.text.split("\n");
    if (!w.whole) lines.shift(); // cut by the window
    const seen: Dated[] = [];
    let before = false;
    for (let i = lines.length - 1; i >= 0 && !before; i--) {
      const r = parse(lines[i]);
      if (!r) continue;
      if (r.at < since) before = true;
      else seen.push(r);
    }
    const whole = before || w.whole;
    if (whole || k === sizes.length - 1) return { seen: seen.reverse(), whole };
  }
}

/**
 * A model switch's output as Claude Code records a local command's: "Set model to `<what>` for this session only" (or
 * "… and saved as your default"), from `/model` (or `/config`), in a user entry or, for 2.1.3xx, a system entry of
 * subtype local_command. "Kept model as …" is a cancelled picker, and other output a refusal: neither sets anything.
 */
const SET_MODEL = /<local-command-stdout>(?:\x1b\[[0-9;]*m)*Set model to\b([^<]*)<\/local-command-stdout>/;
const ANSI = /\x1b\[[0-9;]*m/g;

/** The text of a transcript entry: a system entry's content, or a user message's (a string, or its text blocks). */
function entryTexts(d: any): string[] {
  const c = d?.type === "system" ? d.content : d?.message?.content;
  if (typeof c === "string") return [c];
  return Array.isArray(c) ? c.filter((b) => typeof b?.text === "string").map((b) => b.text as string) : [];
}

/** A Claude transcript line's say: a reply of the conversation's own (not a subagent's) with a real model, or a model switch. */
function claudeLine(line: string): Dated | null {
  const reply = line.includes('"type":"assistant"') && line.includes('"model"');
  if (!reply && !line.includes("Set model to")) return null;
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return null; // the line the agent is still writing
  }
  const at = epochMs(d?.timestamp);
  if (at === null || d?.isSidechain) return null;
  if (d.type === "assistant") {
    const model = d.message?.model;
    return typeof model === "string" && model.trim() && model !== "<synthetic>" ? { at, report: { model } } : null;
  }
  if (d.type !== "user" && d.type !== "system") return null;
  for (const text of entryTexts(d)) {
    const m = SET_MODEL.exec(text);
    if (m) return { at, set: m[1].replace(ANSI, "").trim() };
  }
  return null;
}

/** A Codex rollout line's report: a turn's turn_context, with its model and reasoning effort. */
function codexReport(line: string): Dated | null {
  if (!line.includes('"turn_context"')) return null;
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return null; // the line the agent is still writing
  }
  const p = d?.payload;
  const at = epochMs(d?.timestamp ?? p?.timestamp);
  if (d?.type !== "turn_context" || typeof p?.model !== "string" || !p.model.trim() || at === null) return null;
  return { at, report: { model: p.model, effort: typeof p.effort === "string" ? p.effort : null } };
}

/** What Claude conversation `id` runs as the reporter last saw it (its statusline payload's model), and when. */
function statusLineReport(id: string, dir: string): Dated | null {
  if (!CONVERSATION_ID_RE.test(id)) return null;
  const file = path.join(dir, `${id}.json`);
  const payload = readJsonFile(file, null);
  const model = payload ? claudeExtras(payload).model : undefined;
  if (!model) return null;
  try {
    return { at: fs.statSync(file).mtimeMs, report: { model } };
  } catch (err) {
    if (isMissing(err)) return null; // replaced between the read and the stat: the next report has it
    throw err;
  }
}

/** Claude Code's aliases whose line covers several models, as a model switch's output names them. */
const COVERING_ALIASES: [RegExp, string][] = [[/opusplan|opus plan|plan mode/i, "opusplan"]];

/** What a switch's output names, from "`Opus 4.7 (1M context)` for this session only": null when it can't be read. */
function namedIn(set: string): string | null {
  const ticked = /`([^`]+)`/.exec(set)?.[1];
  const named = (ticked ?? set.split(/\s+(?:for this session|and saved|·|with)\b/)[0]).trim();
  return named || null;
}

/** A model name without its 1M-context suffix, as reports of one model compare. */
const bareModel = (m: string): string => m.trim().toLowerCase().replace(/\[1m\]$/, "");

/**
 * What the switch `sw` set (ChosenModel): the covering alias it names, else the first model reported after it that
 * isn't the one running just before it (a reply of a turn under way when it was typed is the old model's; a later
 * change, a fallback's). Null when nothing reported since runs another: it set what was running.
 */
function chosenBy(sw: Dated, reports: Dated[]): ChosenModel | null {
  const named = namedIn(sw.set!);
  const alias = named ? COVERING_ALIASES.find(([re]) => re.test(named))?.[1] : undefined;
  if (alias) return { model: alias, named: true };
  const before = reports.filter((r) => r.at < sw.at).at(-1)?.report?.model;
  const landed = reports.find((r) => r.at >= sw.at && (!before || bareModel(r.report!.model) !== bareModel(before)));
  return landed ? { model: landed.report!.model, named: named !== null } : null;
}

/**
 * What session `s`'s agent reported running in its launch (since `s.createdAt`): its latest report and, asked for with
 * `first`, the launch's first when that's within reach (FIRST_BYTES of its file's end), and Claude's latest /model
 * (LaunchModels.chosen). `transcript` is the conversation's file when a hook named it. Null when it reported nothing
 * this launch. Throws when its files can't be read.
 */
export function readLaunchModels(
  s: Pick<SessionInfo, "shell" | "agent" | "conversation" | "cwd" | "createdAt">,
  opts: { first: boolean; transcript?: string | null; contextDir?: string }
): LaunchModels | null {
  const conv = s.conversation;
  const agent = s.agent ?? "claude";
  if (s.shell || !conv || conv.agent !== agent) return null;
  if (agent === "codex") {
    const file = opts.transcript || rolloutFileOf(conv.id);
    if (!file) return null;
    const { seen, whole } = seenSince(file, s.createdAt, codexReport, opts.first);
    const last = seen.at(-1);
    return last ? { first: whole ? seen[0].report! : null, earliest: seen[0].report!, last: last.report!, at: last.at } : null;
  }
  const file = opts.transcript || claudeTranscriptOf(conv.id, s.cwd);
  const { seen, whole } = file ? seenSince(file, s.createdAt, claudeLine, opts.first) : { seen: [], whole: false };
  const reports = seen.filter((x) => x.report);
  const status = statusLineReport(conv.id, opts.contextDir ?? CONTEXT_DIR);
  if (status && status.at >= s.createdAt && (!reports.length || status.at >= reports.at(-1)!.at)) reports.push(status);
  const last = reports.at(-1);
  if (!last) return null;
  const sw = seen.filter((x) => x.set !== undefined).at(-1);
  const replies = reports.filter((r) => r !== status);
  return {
    first: whole && replies.length ? replies[0].report! : null,
    earliest: reports[0].report!,
    last: last.report!,
    at: last.at,
    chosen: sw ? chosenBy(sw, reports) : null,
  };
}
