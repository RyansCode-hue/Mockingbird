import type { SessionInfo } from "./types";
import { stackKeyOf } from "./landscape";

/**
 * A stack's tab order, kept on this Mac as one ranking of session ids (the renderer's prefs): a stack's tabs sort by
 * where their sessions are in it, and those it doesn't list come after, in the order the session list has them. One
 * ranking rather than one per stack, so it holds through a stack's or its area's rename.
 */

/**
 * The sessions with each stack's members in their tab order. A stack's members take the places in the list its
 * members had, so every other session, and the order stacks and areas first appear in, stay as they were.
 */
export function inTabOrder<T extends Pick<SessionInfo, "id" | "taskGroup">>(sessions: readonly T[], rank: readonly string[]): readonly T[] {
  if (!rank.length) return sessions;
  const at = new Map(rank.map((id, i) => [id, i]));
  const rankOf = (s: T) => at.get(s.id) ?? rank.length;
  const places = new Map<string, number[]>();
  sessions.forEach((s, i) => {
    const k = stackKeyOf(s);
    if (!k) return;
    const p = places.get(k);
    if (p) p.push(i);
    else places.set(k, [i]);
  });
  let out: T[] | null = null;
  for (const idx of places.values()) {
    if (idx.length < 2) continue;
    // a stable sort: the sessions the ranking doesn't list keep the list's order among themselves
    const sorted = idx.map((i) => sessions[i]).sort((a, b) => rankOf(a) - rankOf(b));
    if (sorted.every((s, j) => s === sessions[idx[j]])) continue;
    out ??= [...sessions];
    idx.forEach((i, j) => (out![i] = sorted[j]));
  }
  return out ?? sessions;
}

/** The ranking with a stack's tabs (`ids`, in their new order) put last, and what `keep` doesn't hold (sessions gone) dropped. */
export function rerank(rank: readonly string[], ids: readonly string[], keep: (id: string) => boolean): string[] {
  const moved = new Set(ids);
  return [...rank.filter((id) => !moved.has(id) && keep(id)), ...ids];
}

/** The ranking as the prefs held it: a list of session ids, else none, and the console says why. */
export function tabRankOf(v: unknown): string[] {
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
  console.warn("[mockingbird] the saved tab order isn't a list of session ids; stacks show their tabs in the order they were made:", v);
  return [];
}

/** A tab's place along its strip, on screen. */
export interface TabSlot {
  left: number;
  width: number;
}

/** How far tab `from` can be dragged by `dx`: no further than the first tab's left edge and the last one's right. */
export function clampTabDrag(slots: readonly TabSlot[], from: number, dx: number): number {
  const me = slots[from];
  const first = slots[0];
  const last = slots[slots.length - 1];
  return Math.min(Math.max(dx, first.left - me.left), last.left + last.width - (me.left + me.width));
}

/**
 * Where tab `from`, dragged by `dx`, lands: past each tab whose middle its leading edge has crossed (its right edge
 * going right, its left going left), so it reaches either end whatever the tabs' widths.
 */
export function tabSlot(slots: readonly TabSlot[], from: number, dx: number): number {
  const mid = (s: TabSlot) => s.left + s.width / 2;
  const left = slots[from].left + dx;
  const right = left + slots[from].width;
  let to = from;
  slots.forEach((s, i) => {
    if (i > from && right > mid(s)) to++;
    if (i < from && left < mid(s)) to--;
  });
  return to;
}

/**
 * Each tab's shift while tab `from` is over slot `to`: the tabs it has passed move toward where it was, by its width
 * and the gap between tabs; the rest, and the dragged tab itself, by nothing.
 */
export function tabShifts(slots: readonly TabSlot[], from: number, to: number): number[] {
  const gap = slots.length > 1 ? slots[1].left - (slots[0].left + slots[0].width) : 0;
  const by = slots[from].width + gap;
  return slots.map((_, i) => (from < to && i > from && i <= to ? -by : to < from && i >= to && i < from ? by : 0));
}

/** `ids` with the one at `from` moved to `to`. */
export function movedTo<T>(ids: readonly T[], from: number, to: number): T[] {
  const out = [...ids];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}
