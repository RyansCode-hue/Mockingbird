import * as fs from "fs";
import * as path from "path";
import type { SessionInfo } from "../shared/types";
import { claudeTranscriptOf, epochMs } from "./agentFiles";
import { isMissing, readJsonFile, readWindow } from "./fileOps";
import { CONTEXT_DIR, CONVERSATION_ID_RE, claudeExtras, rolloutFileOf } from "./usage";

/**
 * Which model (and Codex reasoning effort) a session's agent reported running in a launch, from the files its CLI
 * writes: Claude's transcript (each reply's message.model) and the statusline payload the reporter keeps for the
 * conversation (model.id, current as soon as a /model is typed), Codex's rollout (each turn's turn_context). Each is
 * read from its end, so a read stays bounded however long the conversation runs.
 */

/** One report of what an agent runs: its model and, from Codex, its reasoning effort (null: the model's default). */
export interface ModelReport {
  model: string;
  effort?: string | null;
}

/**
 * What an agent reported running in one launch: its first report (null: not known), the earliest of those read (its
 * first when that's known), and its latest, made at `at`.
 */
export interface LaunchModels {
  first: ModelReport | null;
  earliest: ModelReport;
  last: ModelReport;
  at: number;
}

/** How much of a file's end is read for its latest report. */
const TAIL_BYTES = 256 * 1024;
/** How much of a file's end is read, at most, for a launch's first report. */
const FIRST_BYTES = 4 * 1024 * 1024;

type Dated = { at: number; report: ModelReport };

/**
 * The reports in `file` made at or after `since`, oldest first, read from its end (`parse` gives a line's, or null).
 * With `first`, a read that doesn't reach back past them is made again further back, up to FIRST_BYTES. `whole` says
 * they're all of them: the read reached a report from before `since`, or the file's start.
 */
function reportsSince(file: string, since: number, parse: (line: string) => Dated | null, first: boolean): { reports: Dated[]; whole: boolean } {
  const sizes = first ? [TAIL_BYTES, FIRST_BYTES] : [TAIL_BYTES];
  for (let k = 0; ; k++) {
    const w = readWindow(file, "end", sizes[k]);
    const lines = w.text.split("\n");
    if (!w.whole) lines.shift(); // cut by the window
    const reports: Dated[] = [];
    let before = false;
    for (let i = lines.length - 1; i >= 0 && !before; i--) {
      const r = parse(lines[i]);
      if (!r) continue;
      if (r.at < since) before = true;
      else reports.push(r);
    }
    const whole = before || w.whole;
    if (whole || k === sizes.length - 1) return { reports: reports.reverse(), whole };
  }
}

/** A Claude transcript line's report: a reply of the conversation's own (not a subagent's) with a real model. */
function claudeReport(line: string): Dated | null {
  if (!line.includes('"type":"assistant"') || !line.includes('"model"')) return null;
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return null; // the line the agent is still writing
  }
  const model = d?.message?.model;
  const at = epochMs(d?.timestamp);
  if (d?.type !== "assistant" || d.isSidechain || typeof model !== "string" || !model.trim() || model === "<synthetic>" || at === null) return null;
  return { at, report: { model } };
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

/**
 * What session `s`'s agent reported running in its launch (since `s.createdAt`): its latest report and, asked for with
 * `first`, the launch's first when that's within reach (FIRST_BYTES of its file's end). `transcript` is the
 * conversation's file when a hook named it. Null when it reported nothing this launch. Throws when its files can't be
 * read.
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
    const { reports, whole } = reportsSince(file, s.createdAt, codexReport, opts.first);
    const last = reports.at(-1);
    return last ? { first: whole ? reports[0].report : null, earliest: reports[0].report, last: last.report, at: last.at } : null;
  }
  const file = opts.transcript || claudeTranscriptOf(conv.id, s.cwd);
  const { reports, whole } = file ? reportsSince(file, s.createdAt, claudeReport, opts.first) : { reports: [], whole: false };
  const status = statusLineReport(conv.id, opts.contextDir ?? CONTEXT_DIR);
  let last = reports.at(-1);
  if (status && status.at >= s.createdAt && (!last || status.at >= last.at)) last = status;
  if (!last) return null;
  return { first: whole && reports.length ? reports[0].report : null, earliest: (reports[0] ?? last).report, last: last.report, at: last.at };
}
