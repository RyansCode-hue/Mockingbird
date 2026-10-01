import type { CollabMessage, CollabParticipant, CollabRoom } from "../shared/types";

const isModel = (m: CollabMessage) => m.speaker !== "you" && m.speaker !== "system";

/** Messages long enough to fold in the thread (the newest one never folds). */
export function isLong(text: string): boolean {
  return text.length > 900 || text.split("\n").length > 14;
}

/** The first meaningful line of a message, without markdown markers — a rounds-grid cell's summary. */
export function summaryOf(text: string, max = 160): string {
  const line =
    text
      .split("\n")
      .map((l) => l.replace(/^\s*(#+|[-*>]|\d+[.)])\s*/, "").replace(/\*+|`|(^|\s)_+|_+(?=\s|$)/g, "$1").trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export type ThreadItem = { type: "divider"; round: number } | { type: "message"; message: CollabMessage };

/** The transcript with a "Round N" divider before the first model message of each round. */
export function threadItems(messages: CollabMessage[]): ThreadItem[] {
  const out: ThreadItem[] = [];
  let shown = 0;
  for (const m of messages) {
    if (isModel(m) && m.round > 0 && m.round !== shown) {
      out.push({ type: "divider", round: m.round });
      shown = m.round;
    }
    out.push({ type: "message", message: m });
  }
  return out;
}

/** How many of the room's models agreed in the latest round anyone took a stance in. */
export function agreement(room: CollabRoom): { round: number; agree: number; of: number } | null {
  const seated = room.participants.filter((p) => !p.removed);
  const stances = room.messages.filter((m) => isModel(m) && m.stance);
  if (!stances.length || !seated.length) return null;
  const round = Math.max(...stances.map((m) => m.round));
  const agree = seated.filter((p) => stances.some((m) => m.round === round && m.speaker === p.key && m.stance === "agree")).length;
  return { round, agree, of: seated.length };
}

export interface RoundRow {
  round: number;
  /** The user's messages sent before this round started. */
  before: CollabMessage[];
  /** Each model's messages in this round (its turn, lookups it answered, a plan, an error). */
  cells: Record<string, CollabMessage[]>;
}

/**
 * The discussion as a grid: a column per model (seated ones, then any that left
 * but spoke), a row per round. A user message carries the number of rounds done
 * when it was sent, so it sits before the next round.
 */
export function roundsGrid(room: CollabRoom): { columns: CollabParticipant[]; rows: RoundRow[]; after: CollabMessage[] } {
  const spoke = new Set(room.messages.filter(isModel).map((m) => m.speaker));
  const columns = [...room.participants.filter((p) => !p.removed), ...room.participants.filter((p) => p.removed && spoke.has(p.key))];
  const modelRounds = room.messages.filter(isModel).map((m) => m.round);
  const last = Math.max(room.round + (room.running ? 1 : 0), ...modelRounds, 0);
  const rows: RoundRow[] = Array.from({ length: last }, (_, i) => ({ round: i + 1, before: [], cells: {} }));
  const after: CollabMessage[] = [];
  for (const m of room.messages) {
    if (m.speaker === "system") continue;
    if (m.speaker === "you") {
      const row = rows[m.round]; // sent after m.round rounds → before round m.round + 1
      (row ? row.before : after).push(m);
      continue;
    }
    const row = rows[Math.max(m.round, 1) - 1];
    if (row) (row.cells[m.speaker] ??= []).push(m);
  }
  return { columns, rows, after };
}

/** "0:42" — how long a permission request has waited. */
export function waited(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Two letters for a room in the collapsed rail. */
export function initials(title: string): string {
  const words = title.replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !/^(a|an|the|to|of|and|for|how|on|in)$/i.test(w));
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}
