import * as fs from "fs";
import { git, originUrl, withoutCredentials } from "./git";
import { baseRef } from "./files";
import { guardedGit } from "./safeGit";
import { transcriptLines } from "./handoff";
import { weighted } from "./meters";
import { takeoverBrief } from "./team/takeoverBrief";
import { briefTokens, rereadCost, unitsPerPct, type CostEstimate } from "../shared/contextBudget";
import type { AgentKind, ContextWindow, SessionInfo } from "../shared/types";
import type { UsageRow } from "./transcripts";

/**
 * The context warning's actions that need the main process: a fresh session's
 * brief (the take-over brief builder, in its refresh mode), and what an
 * expensive action is estimated to cost.
 */

/** Weighted units per 1% of an agent's 5-hour limit, from this Mac's use of the current window (unitsPerPct); null without a reading. */
export function planRateOf(windowRows: UsageRow[] | undefined, usedPct: number | undefined): number | null {
  if (!windowRows || usedPct === undefined) return null;
  return unitsPerPct(windowRows.reduce((n, r) => n + weighted(r), 0), usedPct);
}

export interface ResumeEstimate {
  agent: AgentKind;
  estimate: CostEstimate;
}

/**
 * What the first reply after resuming `cw`'s conversation is estimated to
 * cost. Claude's report says how many tokens a cold cache re-caches
 * (prompt_cache.recache_tokens_if_cold) and when it goes cold; otherwise the
 * whole context is re-read, cold once its last reply is five minutes old.
 * Null when the conversation's size isn't known.
 */
export function resumeEstimate(cw: ContextWindow, rate: number | null, now: number): ResumeEstimate | null {
  if (cw.state !== "reading") return null;
  const tokens = cw.cache?.recacheTokens ?? cw.tokens;
  return {
    agent: cw.agent,
    estimate: rereadCost({ agent: cw.agent, model: cw.model, tokens, cache: cw.cache ?? null, lastAt: cw.at, now, unitsPerPct: rate }),
  };
}

export interface RefreshBrief {
  brief: string;
  agent: AgentKind;
  /** What starting from it is estimated to cost (a new conversation: all of it written to the cache). */
  estimate: CostEstimate;
  /** The conversation it replaces, in tokens, when known. */
  replaces: number | null;
}

/**
 * The brief a fresh session in `s`'s worktree starts from: its branch and
 * changes, its latest plan, and the conversation's first request and last
 * turns, with the path of the whole transcript to read on demand. Built
 * without a model call. Throws when the conversation can't be read.
 */
export async function refreshBrief(
  s: SessionInfo,
  o: { files: { path: string; agent: AgentKind }[]; conversationId: string; context: ContextWindow; rate: number | null; now: number }
): Promise<RefreshBrief> {
  const agent: AgentKind = s.agent ?? "claude";
  if (!o.files.length) throw new Error("its conversation isn't in the index yet");
  const lines = (await Promise.all(o.files.map((f) => transcriptLines(f.path)))).flat();
  const main = o.files[o.files.length - 1];
  const bytes = fs.statSync(main.path).size;
  let base = await baseRef(s.cwd).catch(() => null);
  const fork = base ? await git(s.cwd, ["merge-base", "HEAD", base], { okCodes: [0, 1, 128] }).catch(() => "") : "";
  if (!fork) base = null;
  const g = await guardedGit(s.cwd);
  const [stat, untracked, origin] = await Promise.all([
    g.diff(["--stat=160", fork || "HEAD"], { okCodes: [0, 128] }),
    g.run(["ls-files", "--others", "--exclude-standard"], { okCodes: [0, 128] }),
    originUrl(s.cwd).catch(() => null),
  ]);
  const brief = takeoverBrief({
    mode: "refresh",
    owner: "you",
    taker: "the user",
    agent,
    title: s.ticketTitle ?? s.title,
    ticketId: s.ticketId ?? null,
    room: null,
    repo: origin ? withoutCredentials(origin) : s.repoPath ?? s.cwd,
    branch: s.branch ?? null,
    worktree: s.cwd,
    snapshot: null,
    base,
    changes: [...untracked.split("\n").filter(Boolean).map((f) => `${f} (new, untracked)`), ...stat.split("\n").filter(Boolean)],
    conversation: lines.length ? "full" : "none",
    lines,
    conversationId: o.conversationId,
    transcript: { path: main.path, bytes },
  });
  const model = o.context.state === "reading" ? o.context.model : null;
  return {
    brief,
    agent,
    estimate: rereadCost({ agent, model, tokens: briefTokens(brief.length), fresh: true, now: o.now, unitsPerPct: o.rate }),
    replaces: o.context.state === "reading" ? o.context.tokens : null,
  };
}
