import { isErr } from "../../shared/types";
import { HOUSE_PRIORITIES, statusLabel, type BuilderStatus, type HouseRow, type HouseWrite } from "../../shared/team/house";

/**
 * The room's Radley House board as columns (docs/team-rooms.md, "Radley House
 * board"): one per status in the House's flow, the House's own order within
 * each. A card dragged to another column changes its status in the House,
 * with this member's builder token, through the board's existing writes: into
 * In progress unclaimed is a claim, In progress back to Ready a release, any
 * other move a status change. The House has no rank a builder can write, so a
 * column can't be reordered: a card lands where the House's order puts it.
 */

/** The statuses that are columns, in the House's flow. */
export const HOUSE_COLUMNS = ["ready", "in_progress", "review", "validating", "done"] as const;
/** Where a ticket shows: a column, the Parked row, the Dropped column (hidden until asked), or Other for a status the board doesn't know. */
export type HousePlace = (typeof HOUSE_COLUMNS)[number] | "parked" | "dropped" | "other";

/** Only staff close a ticket: a builder's token can't move one into Done or Dropped. */
export const CLOSE_REFUSAL = "Only House staff close tickets";

/** The flow ⌥← and ⌥→ step along. */
const FLOW: HousePlace[] = ["parked", "ready", "in_progress", "review", "validating", "done"];
const KNOWN: readonly string[] = [...FLOW, "dropped"];

export const placeOf = (status: string): HousePlace => (KNOWN.includes(status) ? (status as HousePlace) : "other");
export const placeName = (p: HousePlace): string => (p === "other" ? "Other statuses" : p === "in_progress" ? "In progress" : p[0].toUpperCase() + p.slice(1));
const isClosed = (p: HousePlace) => p === "done" || p === "dropped";

/** A move on its way to the House: the card shows in its new place meanwhile. */
export interface PendingMove {
  status: string;
  /** A claim waiting for its branch, and where the card came from (it goes back there on Cancel). */
  asking?: { from: HousePlace };
  /** Written: kept until the board's next read shows it. */
  landed?: boolean;
}

/** A row's status as the board shows it: a pending move's, else the House's. */
export const shownStatus = (row: HouseRow, moves: Record<number, PendingMove>): string | null => moves[row.n]?.status ?? row.ticket?.status ?? null;

const PRIORITY_RANK = new Map<string, number>(HOUSE_PRIORITIES.map((p, i) => [p, i]));
const rank = (row: HouseRow) => PRIORITY_RANK.get(row.ticket?.priority ?? "") ?? HOUSE_PRIORITIES.length;

/**
 * The House's order: the open backlog's (as the House listed it, high
 * priority first), then a ticket outside it by priority and number, as the
 * House lists.
 */
export function houseOrder(order: readonly number[]): (a: HouseRow, b: HouseRow) => number {
  const at = new Map(order.map((n, i) => [n, i]));
  return (a, b) => {
    const ia = at.get(a.n);
    const ib = at.get(b.n);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    return rank(a) - rank(b) || (ia !== undefined ? -1 : ib !== undefined ? 1 : a.n - b.n);
  };
}

export type HouseGroups = Record<HousePlace, HouseRow[]> & {
  /** Tickets not read (yet, or at all): no status to place them by. */
  unread: HouseRow[];
};

/** The board's rows by where they show, each in the House's order. */
export function groupRows(rows: HouseRow[], order: readonly number[], moves: Record<number, PendingMove> = {}): HouseGroups {
  const g: HouseGroups = { parked: [], ready: [], in_progress: [], review: [], validating: [], done: [], dropped: [], other: [], unread: [] };
  for (const r of rows) {
    const s = shownStatus(r, moves);
    if (s === null) g.unread.push(r);
    else g[placeOf(s)].push(r);
  }
  const by = houseOrder(order);
  for (const k of Object.keys(g) as (keyof HouseGroups)[]) if (k !== "unread") g[k].sort(by);
  return g;
}

/** What's folded: the Parked row and the Done column (folded to start with), and whether Dropped shows (hidden to start with). */
export interface HouseFolds {
  parked: boolean;
  done: boolean;
  showDropped: boolean;
}
export const DEFAULT_FOLDS: HouseFolds = { parked: true, done: true, showDropped: false };

export interface ColumnLayout {
  place: HousePlace;
  name: string;
  count: number;
  folded: boolean;
  /** Takes a dropped card: false for Done and Dropped, which only staff move tickets into. */
  accepts: boolean;
}

/** The board's columns as they show: the five, Dropped after them when asked for. Parked and Other are rows above them. */
export function columnLayout(g: HouseGroups, folds: HouseFolds): ColumnLayout[] {
  const places: HousePlace[] = [...HOUSE_COLUMNS, ...(folds.showDropped ? (["dropped"] as const) : [])];
  return places.map((place) => ({ place, name: placeName(place), count: g[place].length, folded: place === "done" && folds.done, accepts: !isClosed(place) }));
}

/** What a drag from a card's place to `to` writes, or why it can't. Null when it wouldn't move. */
export type BoardMove = { kind: "claim" } | { kind: "release" } | { kind: "status"; status: BuilderStatus } | { refused: string } | null;

export function boardMove(row: HouseRow, from: HousePlace, to: HousePlace): BoardMove {
  if (!row.ticket || from === to) return null;
  if (isClosed(to)) return { refused: CLOSE_REFUSAL };
  if (to === "other") return { refused: "That row holds statuses the board doesn't know; it can't take a card" };
  // a ticket nobody has goes in progress by being claimed: the House records who and on which branch
  if (to === "in_progress" && !row.ticket.claim) return { kind: "claim" };
  if (from === "in_progress" && to === "ready" && row.ticket.claim) return { kind: "release" };
  return { kind: "status", status: to };
}

/** The write a move makes, as the board's own buttons make it (the House decides whether it may). */
export function moveWrite(row: HouseRow, move: Exclude<BoardMove, null | { refused: string }>, from: HousePlace, branch?: string): HouseWrite {
  if (move.kind === "claim") return { kind: "claim", n: row.n, branch: branch ?? "" };
  if (move.kind === "release") return { kind: "release", n: row.n };
  return { kind: "event", n: row.n, event: "status", status: move.status, text: `Moved from ${placeName(from)} to ${placeName(move.status)} on the room's board.` };
}

/** The place ⌥← (-1) or ⌥→ (1) moves a card to along the House's flow; null past either end or off the flow. */
export function stepPlace(from: HousePlace, dir: -1 | 1): HousePlace | null {
  const i = FLOW.indexOf(from);
  if (i < 0) return null;
  return FLOW[i + dir] ?? null;
}

/** The gap of a column (0 above its first card) where `row` lands: the House's order puts it there, wherever it's dropped. */
export function landingGap(column: HouseRow[], row: HouseRow, order: readonly number[]): number {
  const by = houseOrder(order);
  return column.filter((r) => r.n !== row.n && by(r, row) < 0).length;
}

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
 * Move a card to `to`, on the user's drop or keypress: it shows there at once
 * (`show`), then the write goes to the House. When the House refuses it, the
 * card goes back (`show` with null) and the House's message is returned.
 */
export async function moveCard(row: HouseRow, from: HousePlace, to: HousePlace, w: HouseWrite, write: (w: HouseWrite) => Promise<unknown>, show: (n: number, status: string | null) => void): Promise<{ ok: true } | { error: string }> {
  show(row.n, to);
  const err = await failure(() => write(w));
  if (err === null) return { ok: true };
  show(row.n, null);
  return { error: `Couldn't move #${row.n} to ${placeName(to)} — it's back in ${placeName(from)}: ${err}` };
}

/** "#143 → Validating (review → validating)", or the claim or release it is. */
export function moveLabel(row: HouseRow, move: Exclude<BoardMove, null | { refused: string }>, to: HousePlace): string {
  if (move.kind === "claim") return `Claim #${row.n} → In progress (asks for the branch)`;
  if (move.kind === "release") return `Release #${row.n} → Ready`;
  return `#${row.n} → ${placeName(to)} (${statusLabel(row.ticket!.status)} → ${statusLabel(move.status)})`;
}
