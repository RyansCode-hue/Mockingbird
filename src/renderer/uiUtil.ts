/** Small helpers the App's views share. */
import { isErr } from "../shared/types";

/** Open a link in the browser; a refused or failed open is shown, never dropped. */
export async function openLink(url: string): Promise<void> {
  const r = await window.mb.openExternal(url);
  if (isErr(r)) alert(`Couldn't open ${url}: ${r.error}`);
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
