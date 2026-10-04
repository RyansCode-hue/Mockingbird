import * as path from "path";
import { stageLabel, type AgentKind, type TicketPipeline } from "../shared/types";

/** Messages closer together than this count as one stretch of work. */
export const GAP_MS = 10 * 60_000;
/** Each stretch also counts a minute for reading and thinking around it. */
const STRETCH_MS = 60_000;

export interface Activity {
  conv: string;
  agent: AgentKind;
  cwd: string;
  title: string;
  times: number[];
}

export interface UsageTotal {
  conv: string;
  agent: AgentKind;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionRef {
  cwd: string;
  repoPath: string | null;
  ticketId: string | null;
  ticketTitle: string | null;
  taskGroup: string | null;
}

/** Time spent in a conversation: the gaps of 10 minutes or less between its messages, plus a minute per stretch. */
export function activeMs(times: number[]): number {
  const t = [...times].sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const gap = i ? t[i] - t[i - 1] : Infinity;
    total += gap <= GAP_MS ? gap : STRETCH_MS;
  }
  return total;
}

/** Monday 00:00 of the week `weeksAgo` weeks before the one holding `now` (local time), and the next Monday. */
export function weekBounds(now: Date, weeksAgo = 0): { start: Date; end: Date } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 7 * weeksAgo);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

/**
 * The ticket a conversation worked on: the session that ran in its folder
 * (its ticket, or a numeric group), else a folder named like a ticket branch
 * ("5101-orgDropdowns").
 */
export function ticketOf(cwd: string, sessions: SessionRef[]): { id: string; title: string | null } | null {
  const s = sessions.find((x) => x.cwd === cwd && (x.ticketId || /^\d+/.test(x.taskGroup ?? "")));
  if (s) return { id: (s.ticketId ?? (s.taskGroup ?? "").split("/")[0]).replace(/^#/, ""), title: s.ticketTitle };
  const m = /^(\d{3,})[-_]/.exec(path.basename(cwd));
  return m ? { id: m[1], title: null } : null;
}

const hm = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
};
const day = (ms: number) => new Date(ms).toLocaleDateString([], { weekday: "short" });
const tokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
/** Tokens a reply processed fresh (cache reads are counted apart: they dwarf everything else and cost a tenth). */
const fresh = (u: UsageTotal) => u.input + u.output + u.cacheWrite;

export interface RollupInput {
  start: Date;
  end: Date;
  activity: Activity[];
  usage: UsageTotal[];
  sessions: SessionRef[];
  pipelines: Record<string, TicketPipeline>;
  /** The daily digest files written that week (names like 2026-09-28.md). */
  digests: string[];
  generated: Date;
}

/** The week as Markdown: totals, then each ticket's time, stages and PRs, then work outside tickets. */
export function composeRollup(i: RollupInput): string {
  const inWeek = (t: number) => t >= i.start.getTime() && t < i.end.getTime();

  type Bucket = { title: string | null; ms: number; byDay: Map<string, number>; convs: { title: string; agent: AgentKind; ms: number }[] };
  const tickets = new Map<string, Bucket>();
  const other = new Map<string, Bucket>(); // by repository or folder name
  let allMs = 0;
  const byAgent: Record<string, number> = {};
  for (const a of i.activity) {
    const times = a.times.filter(inWeek);
    if (!times.length) continue;
    const ms = activeMs(times);
    allMs += ms;
    byAgent[a.agent] = (byAgent[a.agent] ?? 0) + ms;
    const t = ticketOf(a.cwd, i.sessions);
    const key = t ? t.id : path.basename(i.sessions.find((s) => s.cwd === a.cwd)?.repoPath ?? a.cwd) || "home";
    const map = t ? tickets : other;
    const b: Bucket = map.get(key) ?? { title: t?.title ?? null, ms: 0, byDay: new Map(), convs: [] };
    b.ms += ms;
    b.title ??= t?.title ?? null;
    for (const d of [...new Set(times.map(day))]) b.byDay.set(d, (b.byDay.get(d) ?? 0) + activeMs(times.filter((x) => day(x) === d)));
    b.convs.push({ title: a.title.replace(/\s+/g, " ").slice(0, 80) || "(untitled)", agent: a.agent, ms });
    map.set(key, b);
  }
  // tickets that moved this week, even with no conversations in the index
  for (const p of Object.values(i.pipelines)) {
    if (p.history.some((h) => inWeek(h.at)) && !tickets.has(p.ticketId)) tickets.set(p.ticketId, { title: p.title ?? null, ms: 0, byDay: new Map(), convs: [] });
  }

  const tokensByAgent: Record<string, number> = {};
  for (const u of i.usage) tokensByAgent[u.agent] = (tokensByAgent[u.agent] ?? 0) + fresh(u);
  const allTokens = Object.values(tokensByAgent).reduce((a, b) => a + b, 0);
  const cacheReads = i.usage.reduce((a, u) => a + u.cacheRead, 0);
  const prs = Object.values(i.pipelines).flatMap((p) => p.prs.filter((r) => inWeek(r.at)).map((r) => ({ p, r })));
  const moved = Object.values(i.pipelines).filter((p) => p.history.some((h) => inWeek(h.at)));
  const agentName = (a: string) => (a === "codex" ? "Codex" : "Claude");
  const split = (rec: Record<string, number>, fmt: (n: number) => string) =>
    Object.entries(rec)
      .sort((a, b) => b[1] - a[1])
      .map(([a, n]) => `${agentName(a)} ${fmt(n)}`)
      .join(", ");

  const lastDay = new Date(i.end.getTime() - 1);
  const range = `${i.start.toLocaleDateString([], { month: "short", day: "numeric" })} – ${lastDay.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;
  const out: string[] = [
    `# Weekly rollup — ${range}`,
    `Generated ${i.generated.toLocaleString()} from Mockingbird's conversation index, sessions and ticket pipeline. Time is active time: messages less than 10 minutes apart, plus a minute per stretch.`,
    "",
    "## Summary",
    `- Active time: ${hm(allMs)} across ${i.activity.filter((a) => a.times.some(inWeek)).length} conversations${allMs ? ` (${split(byAgent, hm)})` : ""}`,
    `- Tokens: ${tokens(allTokens)}${allTokens ? ` (${split(tokensByAgent, tokens)})` : ""}${cacheReads ? `, plus ${tokens(cacheReads)} read from cache` : ""}`,
    `- Tickets: ${tickets.size} worked on, ${moved.length} moved stage, ${prs.length} pull request${prs.length === 1 ? "" : "s"} opened`,
  ];

  if (tickets.size) {
    out.push("", "## Tickets");
    for (const [id, b] of [...tickets].sort((x, y) => y[1].ms - x[1].ms)) {
      const p = i.pipelines[id];
      out.push("", `### #${id}${b.title ?? p?.title ? ` ${b.title ?? p?.title}` : ""}${p ? ` — now: ${stageLabel(p.stage)}` : ""}`);
      if (b.ms) out.push(`- Time: ${hm(b.ms)} (${[...b.byDay].map(([d, ms]) => `${d} ${hm(ms)}`).join(", ")})`);
      const steps = p?.history.filter((h) => inWeek(h.at)) ?? [];
      if (steps.length) out.push(`- Stages: ${steps.map((h) => `${stageLabel(h.stage)} (${day(h.at)})`).join(" → ")}`);
      for (const { r } of prs.filter((x) => x.p.ticketId === id)) out.push(`- Pull request: ${r.url} (${r.branch} → ${r.base})`);
      for (const f of p?.feedback.filter((f) => inWeek(f.at)) ?? []) out.push(`- Feedback (${day(f.at)}): ${f.text.replace(/\s+/g, " ").slice(0, 160)}`);
      for (const c of b.convs.sort((x, y) => y.ms - x.ms).slice(0, 6)) out.push(`- ${agentName(c.agent)}: "${c.title}" — ${hm(c.ms)}`);
    }
  }
  if (other.size) {
    out.push("", "## Other work");
    for (const [name, b] of [...other].sort((x, y) => y[1].ms - x[1].ms)) {
      out.push("", `### ${name} — ${hm(b.ms)}`);
      for (const c of b.convs.sort((x, y) => y.ms - x.ms).slice(0, 6)) out.push(`- ${agentName(c.agent)}: "${c.title}" — ${hm(c.ms)}`);
    }
  }
  const digests = i.digests.filter((d) => /^\d{4}-\d{2}-\d{2}\.md$/.test(d)).sort();
  if (digests.length) out.push("", "## Daily digests", ...digests.map((d) => `- ${day(new Date(`${d.slice(0, 10)}T12:00:00`).getTime())}: session-digests/${d}`));
  return out.join("\n") + "\n";
}
