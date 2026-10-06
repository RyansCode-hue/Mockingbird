/** How times, spans and counts read, wherever the app shows them. */

const MINUTE = 60_000;

/**
 * How long ago `ms` was in its largest unit ("4m", "3h", "5d"); "" under a
 * minute, and null past a month, when a date reads better. A clock slightly
 * ahead counts as now, never as a negative span.
 */
function span(ms: number, now: number): string | null {
  const m = Math.max(0, Math.round((now - ms) / MINUTE));
  if (m < 1) return "";
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.round(m / 60)}h`;
  if (m < 30 * 24 * 60) return `${Math.round(m / (24 * 60))}d`;
  return null;
}

/** "Mar 4", or "Mar 4, 2025" for another year. */
function dateOf(ms: number, now: number): string {
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}

/** "just now", "4m ago", "3h ago", "5d ago", or the date for anything older than a month. */
export function ago(ms: number, now = Date.now()): string {
  const s = span(ms, now);
  return s === null ? dateOf(ms, now) : s ? `${s} ago` : "just now";
}

/** `ago` for a narrow column: "now", "4m", "3h", "5d", or the date. */
export function agoShort(ms: number, now = Date.now()): string {
  const s = span(ms, now);
  return s === null ? dateOf(ms, now) : s || "now";
}

/**
 * How long something has been going: "45s", "12m" ("12m 05s" with
 * `seconds`), "1h 05m".
 */
export function fmtElapsed(fromMs: number, seconds = false, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return seconds ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "1 file", "3 files". */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
