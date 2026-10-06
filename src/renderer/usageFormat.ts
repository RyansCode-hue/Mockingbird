import type { UsageLimit } from "../shared/types";

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
