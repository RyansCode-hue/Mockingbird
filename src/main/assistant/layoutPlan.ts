import type { Landscape } from "../../shared/landscape";
import { carryPlan, resolveLayout, undoOfPlan, withoutGone, type AreaPlan, type ReadyPlan, type ResolvedLayout, type Tile } from "../../shared/landscapeModel";
import type { SessionInfo } from "../../shared/types";
import type { AssistantDeps } from "./deps";
import type { ToolResult } from "./registry";

/**
 * The Assistant's landscape changes (docs/assistant.md → Plumbing), planned in main with the planners the window's
 * gestures use (shared/landscapeModel.ts) against the landscape as it is now, so main refuses what the window would.
 * A plan is carried out as the window carries one (carryPlan: its places, then its groups, then `after`), and its Undo
 * is the window's: everything put back while the landscape's revision is still the one the change made.
 */

export type PlanDeps = Pick<AssistantDeps, "landscapeState" | "layoutSessions" | "patchLandscape" | "setGroup">;

/** The landscape as a gesture is planned against it: as stored, with gone sessions' places let go, laid out. */
export interface LayoutNow {
  /** landscape.json as main holds it: what an Undo puts back. */
  stored: Landscape;
  /** `stored` without the places of sessions that are gone (withoutGone): what plans are made against. */
  placed: Landscape;
  layout: ResolvedLayout;
  rev: number;
  /** Every session there is, closed and not started included. */
  known: SessionInfo[];
  /** Each of them's group as it was then (records can change in place): what an Undo puts back. */
  groups: ReadonlyMap<string, string | null>;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)) || "it failed without saying why";

/** The landscape now, or why no change can be planned on it. */
export function layoutNow(d: PlanDeps): LayoutNow | { refused: string } {
  const st = d.landscapeState();
  if (st.problem) return { refused: `The landscape can't be changed now: ${st.problem}` };
  // until the grid's layout is read in, the window places nothing, and a place saved now would be read over
  if (!st.landscape.migratedAt) return { refused: "The landscape hasn't been laid out yet: open it once, then ask again" };
  const { shown, closed, known } = d.layoutSessions();
  const placed = withoutGone(st.landscape, known);
  const groups = new Map(known.map((s) => [s.id, s.taskGroup ?? null]));
  return { stored: st.landscape, placed, layout: resolveLayout(placed, shown, undefined, [], null, closed), rev: st.rev, known, groups };
}

/** An area's name as a step's line and a planner's refusal say it. */
export const areaName = (key: string): string => `“${key}”`;

/** The workspace session `id` is in (its own, or its stack's), or null. */
export const tileOf = (layout: ResolvedLayout, id: string): Tile | null => layout.tiles.find((t) => t.members.some((m) => m.id === id)) ?? null;

/** Why session `id`'s workspace can't be moved or sized now, or null with it. */
export function workspaceOf(now: LayoutNow, id: string): { tile: Tile } | { refused: string } {
  const t = tileOf(now.layout, id);
  if (!t) return { refused: "It has no workspace on the landscape: it's closed, or not started" };
  if (t.hidden) return { refused: `It's in ${areaName(t.area)}, which is collapsed: open it first` };
  return { tile: t };
}

/** A plan's refusal, or that it changes nothing (`unchanged` says so), or the plan. */
export function ready(plan: AreaPlan, unchanged: string): ReadyPlan | { refused: string } {
  if ("refused" in plan) return plan;
  if (!plan.patch && !plan.moves.length && !plan.after) return { refused: unchanged };
  return plan;
}

/**
 * Carry plan `plan` out (carryPlan), made against `now`: the revision it left the landscape at (null: it saved no
 * place), and its note. Throws what stopped it, once whatever it had done is put back as carryPlan puts it back.
 */
export async function carry(d: PlanDeps, now: LayoutNow, plan: ReadyPlan, what: string): Promise<{ rev: number | null; note: string | null }> {
  const said: string[] = [];
  const done = await carryPlan(plan, what, {
    before: now.stored,
    send: async (patch) => {
      try {
        return { rev: d.patchLandscape(patch) };
      } catch (err) {
        return { error: message(err) };
      }
    },
    moves: async (moves) => {
      for (const [i, m] of moves.entries()) {
        try {
          d.setGroup(m.id, m.group);
        } catch (err) {
          return { said: `${what}: ${m.id} couldn't be moved to ${m.group ?? "no group"} (${message(err)})${i ? `; ${i} of ${moves.length} were` : ""}`, moved: i };
        }
      }
      return null;
    },
    say: (text) => void said.push(text),
  });
  if (!done) throw new Error(said.join("; ") || `${what} stopped`);
  return { rev: done.rev, note: said.length ? said.join("; ") : null };
}

const groupOf = (known: readonly SessionInfo[], id: string): string | null => known.find((s) => s.id === id)?.taskGroup ?? null;

/**
 * Plan `plan`, made against `now` and carried out as `done`, as a direct step's result: `text`, with an Undo that puts
 * every place back (undoOfPlan) and the sessions it moved in their groups as they were. Offered while the landscape's
 * revision is still the one the change made and its sessions are still where it put them: after a drag, a lock or a
 * workspace placed since, putting the old places back could overlap what's there now.
 */
export function undoable(d: PlanDeps, now: LayoutNow, plan: ReadyPlan, done: { rev: number | null }, text: string, what: string, undone = `Put back ${what}`): ToolResult {
  const back = undoOfPlan(now.stored, plan);
  const before = new Map(plan.moves.map((m) => [m.id, now.groups.get(m.id) ?? null]));
  const stillUndoable = () => {
    if (done.rev !== null && d.landscapeState().rev !== done.rev) return false;
    const known = d.layoutSessions().known;
    return plan.moves.every((m) => groupOf(known, m.id) === (m.group ?? null));
  };
  return {
    text,
    stillUndoable,
    undo: async () => {
      if (!stillUndoable()) throw new Error("The landscape has changed since, so its places can't be put back");
      const again = layoutNow(d);
      if ("refused" in again) throw new Error(again.refused);
      await carry(d, again, { patch: back.patch, moves: plan.moves.map((m) => ({ id: m.id, group: before.get(m.id) ?? null })), after: back.after }, `putting back ${what}`);
      return undone;
    },
  };
}
