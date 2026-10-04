import { totalTokens, type AgentKind, type Meters, type SessionInfo, type TokenCounts, type UsageReport } from "../shared/types";
import type { UsageRow } from "./transcripts";

/**
 * Token meters. Plans don't say how many tokens a 5-hour window holds — only
 * how much of it is used — so a pane's share is estimated: its usage in the
 * current window over everything this Mac's conversations used in it, times
 * the window's reported %. Usage is weighted by what each kind of token costs
 * on that model (API list prices, as relative weights), since a window fills
 * faster with Opus output than with cached Sonnet input. Use outside this Mac
 * (claude.ai, another computer) isn't in the transcripts, so shares lean high.
 */

const WINDOW_MS = 5 * 3_600_000;

// relative weights per million tokens: [input, output, cache read, cache write]
const CLAUDE_OPUS = [15, 75, 1.5, 18.75];
const CLAUDE_SONNET = [3, 15, 0.3, 3.75];
const CLAUDE_HAIKU = [1, 5, 0.1, 1.25];
const CODEX = [1.25, 10, 0.125, 1.25];

export function weightsFor(agent: AgentKind, model: string | null): number[] {
  if (agent === "codex") return CODEX;
  const m = (model ?? "").toLowerCase();
  if (/haiku/.test(m)) return CLAUDE_HAIKU;
  if (/sonnet/.test(m)) return CLAUDE_SONNET;
  return CLAUDE_OPUS; // opus, fable, and models not yet known: the dearer guess
}

export function weighted(r: UsageRow): number {
  const [i, o, cr, cw] = weightsFor(r.agent, r.model);
  return (r.input * i + r.output * o + r.cacheRead * cr + r.cacheWrite * cw) / 1e6;
}

const zero = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, replies: 0 });
const add = (t: TokenCounts, r: UsageRow) => {
  t.input += r.input;
  t.output += r.output;
  t.cacheRead += r.cacheRead;
  t.cacheWrite += r.cacheWrite;
  t.replies += r.replies;
  return t;
};

/** The 5-hour window each agent is in, from its plan usage. */
export function fiveHourWindows(report: UsageReport, now: number): Partial<Record<AgentKind, { start: number; usedPct: number; resetsAt: number }>> {
  const out: Partial<Record<AgentKind, { start: number; usedPct: number; resetsAt: number }>> = {};
  for (const u of [report.claude, report.codex]) {
    const w = u?.limits.find((l) => /5-hour/i.test(l.label) && !l.note && l.resetsAt);
    if (u && w?.resetsAt && w.resetsAt > now) out[u.agent] = { start: w.resetsAt - WINDOW_MS, usedPct: w.usedPct, resetsAt: w.resetsAt };
  }
  return out;
}

/** A pane's conversations: every one it has run, or at least its current one. */
export const conversationsOf = (s: Pick<SessionInfo, "conversations" | "conversation">): string[] =>
  s.conversations?.length ? s.conversations : s.conversation ? [s.conversation.id] : [];

export function computeMeters(o: {
  sessions: Pick<SessionInfo, "id" | "agent" | "conversations" | "conversation">[];
  /** All-time usage of the panes' conversations. */
  rows: UsageRow[];
  /** Every conversation's usage within each agent's current window. */
  windowRows: Partial<Record<AgentKind, UsageRow[]>>;
  /** Every conversation's usage since local midnight. */
  todayRows: UsageRow[];
  report: UsageReport;
  now: number;
}): Meters {
  const windows = fiveHourWindows(o.report, o.now);
  const windowTotal: Partial<Record<AgentKind, number>> = {};
  for (const [agent, rows] of Object.entries(o.windowRows) as [AgentKind, UsageRow[]][]) windowTotal[agent] = rows.reduce((n, r) => n + weighted(r), 0);

  const sessions: Meters["sessions"] = {};
  for (const s of o.sessions) {
    const convs = new Set(conversationsOf(s));
    if (!convs.size) continue;
    const mine = o.rows.filter((r) => convs.has(r.conv));
    const tokens = mine.reduce(add, zero());
    const agent: AgentKind | null = mine[0]?.agent ?? s.agent ?? null;
    let window: Meters["sessions"][string]["window"] = null;
    const w = agent ? windows[agent] : undefined;
    if (agent && w) {
      const inWindow = (o.windowRows[agent] ?? []).filter((r) => convs.has(r.conv));
      const t = inWindow.reduce(add, zero());
      const total = windowTotal[agent] ?? 0;
      const share = total > 0 ? (inWindow.reduce((n, r) => n + weighted(r), 0) / total) * w.usedPct : null;
      window = { tokens: totalTokens(t), sharePct: share === null ? null : Math.round(share * 10) / 10, usedPct: w.usedPct, resetsAt: w.resetsAt };
    }
    sessions[s.id] = { agent, tokens, window };
  }
  const today: Meters["today"] = {};
  for (const r of o.todayRows) add((today[r.agent] ??= zero()), r);
  return { sessions, today, at: o.now };
}
