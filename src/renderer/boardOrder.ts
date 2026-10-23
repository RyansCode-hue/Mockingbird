import { isErr, type AdoWorkItem } from "../shared/types";

/**
 * Reordering the Dashboard's cards. A column's order is the team's backlog
 * order (Azure DevOps ranks every work item once, and each board column shows
 * its cards in that order), so placing a card means naming the cards it goes
 * between; ADO picks a rank between theirs.
 *
 * A "gap" is a place between a column's cards as they're shown, the dragged
 * card among them when it's from that column: 0 is above the first card, n
 * below the last.
 */

/** The gap a pointer at `y` is nearest: how many cards' middles (top to bottom) are above it. */
export function gapAt(mids: number[], y: number): number {
  let g = 0;
  while (g < mids.length && y > mids[g]) g++;
  return g;
}

export interface Placement {
  /** The card it goes after, and before; 0 for none. */
  previousId: number;
  nextId: number;
  /** The column's cards, top to bottom, once it's there. */
  order: number[];
}

/**
 * Where card `id` lands when dropped in gap `gap` of a column whose cards are
 * `column`, top to bottom. Null when it's already there: a card dropped just
 * above or below itself stays put.
 */
export function placement(column: number[], id: number, gap: number): Placement | null {
  const g = Math.max(0, Math.min(gap, column.length));
  const from = column.indexOf(id);
  if (from >= 0 && (g === from || g === from + 1)) return null;
  const above = column.slice(0, g).filter((x) => x !== id);
  const below = column.slice(g).filter((x) => x !== id);
  return { previousId: above[above.length - 1] ?? 0, nextId: below[0] ?? 0, order: [...above, id, ...below] };
}

/** The gap one place up (-1) or down (1) from card `id` in its column; null when it's already at that end. */
export function stepGap(column: number[], id: number, dir: -1 | 1): number | null {
  const i = column.indexOf(id);
  if (i < 0) return null;
  const g = dir < 0 ? i - 1 : i + 2;
  return g < 0 || g > column.length ? null : g;
}

/** Where a placement puts the card, in words: "between #1 and #2", "above #2", "below #1", or "" in an empty column. */
export function placeLabel(p: Pick<Placement, "previousId" | "nextId">): string {
  if (p.previousId && p.nextId) return `between #${p.previousId} and #${p.nextId}`;
  if (p.nextId) return `above #${p.nextId}`;
  if (p.previousId) return `below #${p.previousId}`;
  return "";
}

/**
 * The board's work items with `id` moved to sit right after `previousId` (or,
 * without one, right before `nextId`) and `patch` applied. With neither, or
 * neither among the items, it keeps its place. The columns show the items in
 * this order, each its own cards.
 */
export function placeItem(items: AdoWorkItem[], id: number, previousId: number, nextId: number, patch: Partial<AdoWorkItem> = {}): AdoWorkItem[] {
  const from = items.findIndex((i) => i.id === id);
  if (from < 0) return items;
  const moved = { ...items[from], ...patch };
  const rest = items.filter((i) => i.id !== id);
  const after = previousId ? rest.findIndex((i) => i.id === previousId) : -1;
  const before = nextId ? rest.findIndex((i) => i.id === nextId) : -1;
  const at = after >= 0 ? after + 1 : before >= 0 ? before : from;
  rest.splice(at, 0, moved);
  return rest;
}

/** The writes a placement makes: a move to another column (null when it stays), and the reorder. */
export interface PlaceCalls {
  move: ((id: number) => Promise<unknown>) | null;
  reorder: (id: number, previousId: number, nextId: number) => Promise<unknown>;
}

export type PlaceResult = { ok: true } | { error: string; wrote: boolean };

/** A write's answer as an error message, or null when it worked; a write that throws counts as one that failed. */
async function failure(write: () => Promise<unknown>): Promise<string | null> {
  try {
    const r = await write();
    return isErr(r) ? r.error : null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Put a card in a new place, on the user's drop or keypress. The card shows
 * there at once (`patch` holds its new column and state when it changes
 * column). Then it's written: the move first, as the order API only orders,
 * then the place between its neighbours. When nothing could be written the
 * card goes back where it was, and `wrote` is false; when the move worked but
 * the reorder didn't, `wrote` is true, and the error says the card moved but
 * isn't placed. The view re-reads the board after any write, so the card ends
 * where Azure DevOps has it.
 */
export async function placeCard(
  items: AdoWorkItem[],
  item: AdoWorkItem,
  to: { previousId: number; nextId: number; column?: string; patch?: Partial<AdoWorkItem> },
  calls: PlaceCalls,
  update: (f: (items: AdoWorkItem[]) => AdoWorkItem[]) => void
): Promise<PlaceResult> {
  const from = items.findIndex((i) => i.id === item.id);
  const back = { previousId: items[from - 1]?.id ?? 0, nextId: items[from + 1]?.id ?? 0 };
  const revert = () => update((now) => placeItem(now, item.id, back.previousId, back.nextId, item));
  update((now) => placeItem(now, item.id, to.previousId, to.nextId, to.patch));
  if (calls.move) {
    const moveErr = await failure(() => calls.move!(item.id));
    if (moveErr !== null) {
      revert();
      return { error: `Couldn't move #${item.id}${to.column ? ` to ${to.column}` : ""} — it's back where it was: ${moveErr}`, wrote: false };
    }
  }
  if (!to.previousId && !to.nextId) return { ok: true };
  const orderErr = await failure(() => calls.reorder(item.id, to.previousId, to.nextId));
  if (orderErr === null) return { ok: true };
  if (calls.move) return { error: `Moved #${item.id}${to.column ? ` to ${to.column}` : ""}, but couldn't put it ${placeLabel(to)} — it's where Azure DevOps keeps it: ${orderErr}`, wrote: true };
  revert();
  return { error: `Couldn't put #${item.id} ${placeLabel(to)} — it's back where it was: ${orderErr}`, wrote: false };
}
