import type { QuietHours, SessionInfo, Settings } from "../shared/types";

const minutes = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h < 24 && mm < 60 ? h * 60 + mm : null;
};

/** Whether `now` falls in the quiet hours; a span like 18:00–08:00 runs past midnight. */
export function inQuietHours(q: QuietHours | undefined, now: Date): boolean {
  if (!q?.enabled) return false;
  const from = minutes(q.from);
  const to = minutes(q.to);
  if (from === null || to === null || from === to) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return from < to ? t >= from && t < to : t >= from || t < to;
}

/**
 * Whether a session notification shows: notifications on, the session not
 * muted, outside quiet hours, and — for a finished turn — finished turns
 * wanted. "Needs you" always counts as wanted.
 */
export function shouldNotify(o: { settings: Settings; session?: Pick<SessionInfo, "muted">; kind: "waiting" | "finished" | "other"; now: Date }): boolean {
  if (!o.settings.notifications) return false;
  if (o.session?.muted) return false;
  if (inQuietHours(o.settings.quietHours, o.now)) return false;
  if (o.kind === "finished" && o.settings.notifyFinished === false) return false;
  return true;
}
