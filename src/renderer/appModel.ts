/**
 * The App's own rules that don't need React: how panes are numbered and named
 * in the grid, how group-keyed UI state follows a rename, and how the close
 * and broadcast flows read the main process's answers.
 */
import type { SessionInfo } from "../shared/types";
import { splitGroupKey } from "../shared/types";

/**
 * A grid cell: a plain session renders alone; a workspace (sub-group) renders
 * as one pane with a tab per member. `key` is the workspace's group path
 * ("5038/backend").
 */
export type GridCell = { kind: "session"; s: SessionInfo } | { kind: "workspace"; key: string; sub: string; list: SessionInfo[] };

/** The session a cell shows: its own, or the workspace's front tab. */
export function frontOf(cell: GridCell, wsTabs: Record<string, string>): SessionInfo {
  return cell.kind === "session" ? cell.s : cell.list.find((s) => s.id === wsTabs[cell.key]) ?? cell.list[0];
}

/** ⌘1–9 by pane, as the keys and the pane badges count: each number's session is the one it brings up. */
export function paneShortcuts(cells: GridCell[], wsTabs: Record<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  cells.slice(0, 9).forEach((c, i) => out.set(frontOf(c, wsTabs).id, i + 1));
  return out;
}

/** How zones and drops name the cell of session `id` in `group`: "ws:<top>/<sub>" inside a workspace, else the id. */
export function cellKeyFor(id: string, group: string | null | undefined): string {
  const { top, sub } = splitGroupKey(group ?? "ungrouped");
  return sub ? `ws:${top}/${sub}` : id;
}

const renamed = (key: string, oldKey: string, newKey: string): string | null =>
  key === oldKey || key.startsWith(oldKey + "/") ? newKey + key.slice(oldKey.length) : null;

/** A record keyed by group path, with `oldKey` and everything under it moved to `newKey`. */
export function remapGroupKeys<T>(rec: Record<string, T>, oldKey: string, newKey: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) out[renamed(k, oldKey, newKey) ?? k] = v;
  return out;
}

/** Zone seats across a rename: the groups they belong to, and the workspace cells ("ws:<path>") seated in them. */
export function remapSeats(seats: Record<string, (string | null)[]>, oldKey: string, newKey: string): Record<string, (string | null)[]> {
  const out = remapGroupKeys(seats, oldKey, newKey);
  for (const k of Object.keys(out)) {
    out[k] = out[k].map((v) => {
      const ws = v?.startsWith("ws:") ? renamed(v.slice(3), oldKey, newKey) : null;
      return ws === null ? v : `ws:${ws}`;
    });
  }
  return out;
}

/**
 * Reading a worktree's state failed because its folder is gone (git can't even
 * change into it). Any other failure — a held index.lock, a timeout — says
 * nothing about the work in it, so it must not be treated as nothing to lose.
 */
export function worktreeGone(error: string): boolean {
  return /cannot change to .*No such file or directory/i.test(error);
}

/**
 * What a broadcast does with a session, as SessionManager.broadcast decides it:
 * an idle one gets it now; a working one, or one waiting on a prompt (Enter would
 * answer it), gets it when its turn ends; shells, debriefs and dead panes never do.
 */
export function broadcastFate(s: Pick<SessionInfo, "status" | "shell" | "debrief">): "delivered" | "queued" | "skipped" {
  if (s.status === "dead" || s.shell || s.debrief) return "skipped";
  return s.status === "idle" ? "delivered" : "queued";
}
