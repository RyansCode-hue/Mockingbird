import type { Landscape } from "../../shared/landscape";
import { carryPlan, planRelayoutPipeline, resolveLayout, undoOfPlan, withoutGone, type AreaPlan, type ReadyPlan, type ResolvedLayout, type Tile } from "../../shared/landscapeModel";
import type { SessionInfo } from "../../shared/types";
import type { AssistantDeps, AssistantRoom } from "./deps";
import type { ToolResult } from "./registry";
import { roomOfGroup } from "./tools/lookup";

/**
 * The Assistant's landscape changes (docs/assistant.md → Plumbing), planned in main with the planners the window's
 * gestures use (shared/landscapeModel.ts) against the landscape as it is now, so main refuses what the window would.
 * A plan is carried out as the window carries one (carryPlan: its places, then its groups, then `after`), and its Undo
 * is the window's: everything put back while the landscape's revision is still the one the change made.
 */

export type PlanDeps = Pick<AssistantDeps, "landscapeState" | "layoutSessions" | "patchLandscape" | "setGroup" | "rooms">;

// ---- team rooms' boundaries ----

/** The one tool that moves a session into a team room's group, out of one, or between two: a card the user confirms. */
export const ACROSS_ROOM_TOOL = "move_across_room";

/** The rooms a session leaves (`out`) and joins (`into`) moving from group `from` to `to`; null when it stays in the same room, or in none. */
export function roomCrossing(d: Pick<AssistantDeps, "rooms">, from: string | null, to: string | null): { out: AssistantRoom | null; into: AssistantRoom | null } | null {
  const out = roomOfGroup(d, from);
  const into = roomOfGroup(d, to);
  return (out?.id ?? null) === (into?.id ?? null) ? null : { out, into };
}

/**
 * Why a direct change can't move session `title` from group `from` to `to`, or null when it stays on its side of every
 * room's boundary. A session in a room's group is a room session: teammates are streamed its terminal and scrollback,
 * which no Undo takes back, and their agents can message it. So only ACROSS_ROOM_TOOL's card crosses one.
 */
export function roomBoundary(d: Pick<AssistantDeps, "rooms">, title: string, from: string | null, to: string | null): string | null {
  const c = roomCrossing(d, from, to);
  if (!c) return null;
  const where = c.out && c.into ? `out of the team room “${c.out.name}” and into “${c.into.name}”` : c.into ? `into the team room “${c.into.name}”` : `out of the team room “${c.out!.name}”`;
  return `That would move ${title} ${where}, which changes what teammates see: only ${ACROSS_ROOM_TOOL} does that, on a card the user confirms`;
}

/** Why plan `plan`, made against `now`, can't be carried out directly: the first of its group moves that crosses a room's boundary. */
export function planBoundary(d: Pick<AssistantDeps, "rooms">, now: LayoutNow, plan: ReadyPlan): string | null {
  for (const m of plan.moves) {
    const s = now.known.find((x) => x.id === m.id);
    const why = roomBoundary(d, s ? `“${s.ticketTitle ?? s.title}”` : m.id, now.groups.get(m.id) ?? null, m.group ?? null);
    if (why) return why;
  }
  return null;
}

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

/**
 * The tile session `id` is drawn in: its workspace, or the ghost a not-started step or a closed session is drawn as
 * (a pipeline's members, which Re-lay out pipeline moves with the rest); null when it isn't drawn.
 */
export const drawnOf = (layout: ResolvedLayout, id: string): Tile | null =>
  tileOf(layout, id) ?? layout.ghosts.find((t) => t.members.some((m) => m.id === id)) ?? null;

const LAID_ALREADY = "Its pipeline is laid out already";

/** How long laying a pipeline out waits for the window to place what was just made. */
export const PLACED_WAIT_MS = 3_000;
const PLACED_POLL_MS = 100;

/**
 * The landscape once each of `ids` is drawn with its place saved (the window saves a new workspace's or step's place as
 * it first draws it), waiting up to `ms`; after that, as it is then. A place saved over the window's would be put back
 * by its own save of where it drew it.
 */
export async function placedNow(d: PlanDeps, ids: readonly string[], ms = PLACED_WAIT_MS): Promise<LayoutNow | { refused: string }> {
  const until = Date.now() + ms;
  for (;;) {
    const now = layoutNow(d);
    if ("refused" in now) return now;
    const waiting = ids.filter((id) => !drawnOf(now.layout, id) || Object.hasOwn(now.layout.patch?.workspaces ?? {}, id));
    if (!waiting.length || Date.now() >= until) return now;
    await new Promise((r) => setTimeout(r, PLACED_POLL_MS));
  }
}

/**
 * The plan that lays out the pipeline session `id` is part of in stage columns along its wires (planRelayoutPipeline),
 * as the window's Re-lay out pipeline does, against `now`: places the layout gave what had none yet saved first (a step
 * just made, which the window hasn't drawn), then the pipeline's. Its refusal, or that it's laid out already.
 */
export function relayoutPlan(d: Pick<AssistantDeps, "wireList">, now: LayoutNow, id: string): ReadyPlan | { refused: string } {
  const t = drawnOf(now.layout, id);
  if (!t) return { refused: "It isn't on the landscape" };
  if (t.hidden) return { refused: `It's in ${areaName(t.area)}, which is collapsed: open it first` };
  let wires: ReturnType<typeof d.wireList>;
  try {
    wires = d.wireList();
  } catch (err) {
    return { refused: `Its wires couldn't be read (${message(err)}), so its stages can't be worked out` };
  }
  const plan = planRelayoutPipeline(now.placed, now.layout, id, areaName, wires);
  if ("refused" in plan) return plan;
  return ready({ patch: now.layout.patch, moves: [], after: plan.patch, note: plan.note }, LAID_ALREADY);
}

/** A plan's refusal, or that it changes nothing (`unchanged` says so), or the plan. */
export function ready(plan: AreaPlan, unchanged: string): ReadyPlan | { refused: string } {
  if ("refused" in plan) return plan;
  if (!plan.patch && !plan.moves.length && !plan.after) return { refused: unchanged };
  return plan;
}

/**
 * Carry plan `plan` out (carryPlan), made against `now`: the revision it left the landscape at (null: it saved no
 * place), and its note. Throws what stopped it, once whatever it had done is put back as carryPlan puts it back; and,
 * before doing anything, when one of its moves would cross a team room's boundary (planBoundary).
 */
export async function carry(d: PlanDeps, now: LayoutNow, plan: ReadyPlan, what: string): Promise<{ rev: number | null; note: string | null }> {
  // every direct layout change, and every Undo of one, comes through here
  const across = planBoundary(d, now, plan);
  if (across) throw new Error(across);
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

/**
 * Lay the pipeline session `key` is part of out again once `ids` (what was just made: an inserted step, a lay-out's
 * steps) are drawn and placed, as the window does after an insert: what to say of it, and the result whose Undo puts
 * its places back (null when nothing was laid out). It never throws: what stopped it is said.
 */
export async function layOutAgain(d: PlanDeps & Pick<AssistantDeps, "wireList">, ids: readonly string[], key: string): Promise<{ said: string; done: ToolResult | null }> {
  const not = (why: string) => ({ said: why === LAID_ALREADY ? `${LAID_ALREADY}.` : `Its pipeline wasn't laid out again: ${why}.`, done: null });
  try {
    const now = await placedNow(d, ids);
    if ("refused" in now) return not(now.refused);
    const plan = relayoutPlan(d, now, key);
    if ("refused" in plan) return not(plan.refused);
    // what carrying it out said ends with the plan's own note
    const done = await carry(d, now, plan, "laying its pipeline out");
    const said = `${done.note ?? "Laid its pipeline out"}.`;
    return { said, done: undoable(d, now, plan, done, said, "its pipeline's places") };
  } catch (err) {
    return not(message(err));
  }
}
