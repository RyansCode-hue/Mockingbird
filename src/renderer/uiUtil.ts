/** Small helpers the App's views share. */
import { isErr } from "../shared/types";

/** Open a link in the browser; a refused or failed open is shown, never dropped. */
export async function openLink(url: string): Promise<void> {
  const r = await (window as unknown as { mb: { openExternal: (url: string) => Promise<unknown> } }).mb.openExternal(url);
  if (isErr(r)) alert(`Couldn't open ${url}: ${r.error}`);
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
