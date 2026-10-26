import { isWorkItemId, ticketIdOf, topOfKey, totalTokens, type AgentKind, type GroupMeter, type Meters, type SessionInfo, type TokenCounts, type UsageReport } from "../shared/types";
import { weightsFor } from "../shared/contextBudget";
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
    const w = u?.limits.find((l) => l.window === "5h" && !l.note && l.resetsAt);
    if (u && w?.resetsAt && w.resetsAt > now) out[u.agent] = { start: w.resetsAt - WINDOW_MS, usedPct: w.usedPct, resetsAt: w.resetsAt };
  }
  return out;
}

/** A pane's conversations: every one it has run, or at least its current one. Oldest first; the latest is last. */
export const conversationsOf = (s: Pick<SessionInfo, "conversations" | "conversation">): string[] =>
  s.conversations?.length ? s.conversations : s.conversation ? [s.conversation.id] : [];

/** A pane's conversations once `id` is its latest: moved to the end, keeping the newest 50. */
export const withConversation = (s: Pick<SessionInfo, "conversations" | "conversation">, id: string): string[] =>
  [...conversationsOf(s).filter((c) => c !== id), id].slice(-50);

/** The ticket a session counts toward: its own, or the group it's in when that is named after a work item. */
export function ticketOfSession(s: Partial<Pick<SessionInfo, "ticketId" | "taskGroup">>): string | null {
  if (s.ticketId) return ticketIdOf(s.ticketId);
  const top = s.taskGroup ? topOfKey(s.taskGroup) : "";
  return top && isWorkItemId(top) ? top : null;
}

export function computeMeters(o: {
  /** Live and resumable sessions: a ticket's usage counts its closed-but-resumable sessions too. */
  sessions: (Pick<SessionInfo, "id" | "agent" | "conversations" | "conversation"> & Partial<Pick<SessionInfo, "taskGroup" | "ticketId">>)[];
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

  // a group's or ticket's sessions, over the union of their conversations: one two panes shared counts once
  const sum = (keyOf: (s: (typeof o.sessions)[number]) => string | null): Record<string, GroupMeter> => {
    const members = new Map<string, { n: number; convs: Set<string> }>();
    for (const s of o.sessions) {
      const key = keyOf(s);
      const convs = conversationsOf(s);
      if (!key || !convs.length) continue;
      const m = members.get(key) ?? { n: 0, convs: new Set<string>() };
      m.n++;
      convs.forEach((c) => m.convs.add(c));
      members.set(key, m);
    }
    const out: Record<string, GroupMeter> = {};
    for (const [key, m] of members) {
      const window: GroupMeter["window"] = {};
      for (const [agent, w] of Object.entries(windows) as [AgentKind, { usedPct: number }][]) {
        const inWindow = (o.windowRows[agent] ?? []).filter((r) => m.convs.has(r.conv));
        if (!inWindow.length) continue;
        const total = windowTotal[agent] ?? 0;
        const share = total > 0 ? (inWindow.reduce((n, r) => n + weighted(r), 0) / total) * w.usedPct : null;
        window[agent] = { tokens: totalTokens(inWindow.reduce(add, zero())), sharePct: share === null ? null : Math.round(share * 10) / 10 };
      }
      out[key] = { sessions: m.n, tokens: o.rows.filter((r) => m.convs.has(r.conv)).reduce(add, zero()), window };
    }
    return out;
  };
  const groups = sum((s) => (s.taskGroup ? topOfKey(s.taskGroup) : null));
  const tickets = sum(ticketOfSession);
  return { sessions, groups, tickets, today, at: o.now };
}
