import { isNewer } from "../shared/versions";

/** The last version whose What's new was seen (opened and dismissed, or the version a fresh install started on). */
export const LAST_SEEN_KEY = "mb.whatsNew.lastSeen";

/**
 * Is this the first launch on a newer version? Yes when the last version seen is older than this one, or —
 * with none recorded (before What's new existed) — when this launch is the end of an in-app update to it.
 * A first install, a downgrade and a relaunch on the same version are not updates.
 */
export function justUpdated(current: string, lastSeen: string | null, outcome?: { ok: boolean; to: string } | null): boolean {
  if (!current) return false;
  if (lastSeen) return lastSeen !== current && isNewer(lastSeen, current);
  return !!outcome?.ok && outcome.to === current;
}

/**
 * What to record as seen now: nothing while an update's notes wait to be dismissed (the dismissal records it),
 * otherwise this version when it isn't recorded yet — so a later update is measured from here.
 */
export function seenNow(current: string, lastSeen: string | null, updated: boolean): string | null {
  if (!current || updated || lastSeen === current) return null;
  return current;
}

/** The top bar's label: "Updated to 1.4.11" until the update's notes are dismissed, then "v1.4.11". */
export function versionLabel(current: string, updated: boolean): string {
  return updated ? `Updated to ${current}` : `v${current}`;
}
