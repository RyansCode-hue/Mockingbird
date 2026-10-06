import type { AdoBoard, AdoWorkItem } from "../shared/types";
import { readPref } from "./prefs";

/** Column order and hidden columns, per board ("board:<name>"), or "states" when there's no board. */
export type ColumnPrefs = Record<string, { order: string[]; hidden: string[] }>;
export const COLUMN_PREFS_KEY = "mb.board.prefs";

/** Column prefs as the first layout kept them — one order and one hidden list — which become the "states" entry. */
export const legacyColumnPrefs = (): ColumnPrefs => ({
  states: { order: readPref<string[]>("mb.board.colOrder", []), hidden: readPref<string[]>("mb.board.hidden", []) },
});

/** The work item types a board has columns for (PBIs and Bugs on "Backlog items", Features on "Features"…). */
function boardTypes(board: AdoBoard): Set<string> {
  return new Set(board.columns.flatMap((c) => Object.keys(c.stateMappings)));
}

/**
 * The column a work item sits in on this board: the column Azure DevOps recorded
 * for it (columns can share a state, so only that tells Idea from Planning),
 * else the first column whose state for its type matches; null when its type
 * isn't on this board.
 */
export function columnOf(it: AdoWorkItem, board: AdoBoard): string | null {
  if (!boardTypes(board).has(it.type)) return null;
  if (it.boardColumn && board.columns.some((c) => c.name === it.boardColumn)) return it.boardColumn;
  return board.columns.find((c) => c.stateMappings[it.type] === it.state)?.name ?? null;
}

/** The board most of these work items belong on (the team's backlog board, usually). */
export function pickBoard(items: AdoWorkItem[], boards: AdoBoard[]): AdoBoard | null {
  let best: { board: AdoBoard; n: number } | null = null;
  for (const b of boards) {
    const types = boardTypes(b);
    const n = items.filter((i) => types.has(i.type)).length;
    if (!best || n > best.n) best = { board: b, n };
  }
  return best?.board ?? null;
}

/** Columns in the order you set, then any the board gained since, in the board's own order. */
export function orderColumns(names: string[], custom: string[]): string[] {
  const kept = custom.filter((c) => names.includes(c));
  return [...kept, ...names.filter((c) => !kept.includes(c))];
}

/** What dropping a card on a column would change, or null if it can't go there. */
export function cardMove(it: AdoWorkItem, board: AdoBoard, column: string): { state: string; stateChanges: boolean } | null {
  if (columnOf(it, board) === column) return null;
  const state = board.columns.find((c) => c.name === column)?.stateMappings[it.type];
  return state ? { state, stateChanges: state !== it.state } : null;
}
