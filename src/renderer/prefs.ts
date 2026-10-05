import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/**
 * UI state the window remembers between launches — layout, open panels, last
 * choices — kept in localStorage as JSON under "mb.…" keys. Storage can be
 * unreadable, full or switched off: then the default applies, or the change
 * lasts this run only, and the console says which key and why.
 */

/** As much of localStorage as prefs use. */
export interface PrefStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The value saved under `key`, or `fallback` when there's none or it can't be read. */
export function readPref<T>(key: string, fallback: T, store?: PrefStore): T {
  try {
    const v = (store ?? localStorage).getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch (err) {
    console.warn(`[mockingbird] couldn't read the saved ${key}; using the default:`, err);
    return fallback;
  }
}

/** Saves `value` under `key`; false (and a console warning) when it couldn't be. */
export function writePref(key: string, value: unknown, store?: PrefStore): boolean {
  try {
    (store ?? localStorage).setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn(`[mockingbird] couldn't save ${key}; it lasts until the app restarts:`, err);
    return false;
  }
}

/** useState kept under `key`: read once when the view mounts, saved on every change. */
export function usePersisted<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readPref(key, typeof initial === "function" ? (initial as () => T)() : initial));
  useEffect(() => {
    writePref(key, value);
  }, [key, value]);
  return [value, setValue];
}
