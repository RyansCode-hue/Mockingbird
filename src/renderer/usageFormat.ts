import type { SessionInfo, UsageLimit } from "../shared/types";

/** "Resets in 4 hr 18 min" within a day, else "Resets Sun 2:00 PM". */
export function resetText(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return "";
  const mins = Math.round((resetsAt - now) / 60_000);
  if (mins <= 0) return "Reset";
  if (mins < 60) return `Resets in ${mins} min`;
  if (mins < 24 * 60) return `Resets in ${Math.floor(mins / 60)} hr ${mins % 60} min`;
  return `Resets ${new Date(resetsAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

/** A window whose reset has passed starts over at 0 until the next report says otherwise. */
export const pctNow = (l: UsageLimit, now: number) => (l.resetsAt !== null && l.resetsAt <= now ? 0 : l.usedPct);

/** A limit's short name in the status bar — "5h", or "wk" for a weekly window over every model — or null for one only the details list. */
export function headlineOf(l: UsageLimit): "5h" | "wk" | null {
  if (l.window === "5h") return "5h";
  if (l.window === "week" && !l.model) return "wk";
  return null;
}

/** A count of context tokens to a tenth: "275.6k", "200k", "1M", "1.5M". */
export function contextTokens(n: number): string {
  const tenthsOfK = Math.round(n / 100);
  if (tenthsOfK >= 10_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000 || tenthsOfK >= 10) return `${tenthsOfK / 10}k`;
  return String(Math.round(n));
}

/** How full a context window is, 0–100. */
export const contextPct = (tokens: number, window: number): number => (window > 0 ? Math.min(100, Math.max(0, (tokens / window) * 100)) : 0);

/** "275.6k / 1M (28%)" */
export const contextLine = (tokens: number, window: number): string =>
  `${contextTokens(tokens)} / ${contextTokens(window)} (${Math.round(contextPct(tokens, window))}%)`;

/**
 * Which session's context window the usage popover asks about — the focused
 * pane's — or why there's none to ask about.
 */
export function contextTarget(s: Pick<SessionInfo, "id" | "shell" | "room"> | null): { id: string } | { why: string } {
  if (!s) return { why: "No agent session focused" };
  if (s.room?.remote) return { why: `Not available for a teammate's session: it runs on ${s.room.ownerName}'s Mac` };
  if (s.shell) return { why: "The focused pane is a terminal: no context window" };
  return { id: s.id };
}
