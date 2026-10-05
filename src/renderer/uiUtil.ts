/** Small helpers the App's views share. */

/** A main-process answer that failed: every IPC handler answers { error } instead of rejecting. */
export function isError(r: unknown): r is { error: string } {
  return !!r && typeof r === "object" && typeof (r as { error?: unknown }).error === "string";
}

/** How long ago `ms` was, shortest unit: "5m", "3h", "2d". */
export function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

/** A JSON value kept in localStorage, or `fallback` when it's missing or unreadable. */
export function loadLS<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
