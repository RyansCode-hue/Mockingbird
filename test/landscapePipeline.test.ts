import { describe, expect, it } from "vitest";
import { STAGE_CAPTION_H, WIRED_COLUMN_GAP, pipelineOf, planRelayoutPipeline, resolveLayout, stageCaptions, undoOfPlan, type AreaPlan, type TidyWire } from "../src/renderer/landscapeModel";
import { AREA_HEADER, AREA_PAD, GAP, applyPatch, emptyLandscape, overlaps, presetSize, snapUp, type Area, type Landscape } from "../src/shared/landscape";
import type { SessionInfo } from "../src/shared/types";

// A pipeline (the wires' connected part of an area) and laying it out again in stage columns, whatever else is there.

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  title: id,
  repoPath: "/r",
  cwd: "/r",
  branch: null,
  ticketId: null,
  ticketTitle: null,
  taskGroup: "A",
  status: "idle",
  createdAt: 0,
  kind: "work",
  extraDirs: [],
  waitingReason: null,
  waitingSince: null,
  agent: "claude",
  ...over,
});
const area = (x: number, y: number, w: number, h: number, more: Partial<Area> = {}): Area => ({ x, y, w, h, repos: [], ...more });
const M = presetSize("agent", "M");
const T = (k: string) => k;
const wire = (from: string, to: string, type: TidyWire["type"] = "handoff"): TidyWire => ({ from, to, type });
const ready = (p: AreaPlan) => {
  if ("refused" in p) throw new Error(`refused: ${p.refused}`);
  return p;
};
const refusal = (p: AreaPlan) => ("refused" in p ? p.refused : null);
const col = (n: number) => AREA_PAD + n * (M.w + WIRED_COLUMN_GAP);

/**
 * Area A: an Orchestrator `o` (running), two coders `c1` `c2` (not started) after it, a verifier `v` (closed) after c1,
 * all scattered; and `x`, a running workspace no wire joins, at the area's top-left.
 */
function scene() {
  const l: Landscape = emptyLandscape();
  l.areas.A = area(0, 0, 7 * M.w, 7 * M.h);
  l.workspaces.x = { x: AREA_PAD, y: AREA_HEADER, ...M };
  l.workspaces.o = { x: snapUp(2.5 * M.w), y: snapUp(2.5 * M.h), ...M };
  l.workspaces.c1 = { x: snapUp(1.5 * M.w), y: snapUp(3.5 * M.h), ...M };
  l.workspaces.c2 = { x: snapUp(4.5 * M.w), y: snapUp(1.5 * M.h), ...M };
  l.workspaces.v = { x: snapUp(3.5 * M.w), y: snapUp(5 * M.h), ...M };
  const running = [session("x", { createdAt: 1 }), session("o", { createdAt: 2 })];
  const closed = [session("c1", { title: "Coder 5152", createdAt: 3, planned: { worktree: true } }), session("c2", { title: "Coder 5153", createdAt: 4, planned: { worktree: true } }), session("v", { createdAt: 5, status: "dead" })];
  const wires = [wire("o", "c1"), wire("o", "c2"), wire("c1", "v"), wire("v", "c1", "feedback")];
  return { l, running, closed, wires, layout: resolveLayout(l, running, undefined, [], null, closed) };
}
const rectIn = (r: ReturnType<typeof resolveLayout>, key: string) => [...r.tiles, ...r.ghosts].find((t) => t.key === key)!.rect;

describe("pipelineOf", () => {
  it("is everything wires join to a workspace in its area, ghosts and not-started steps included, found by tile key or session id", () => {
    const { layout, wires } = scene();
    const keys = (k: string) => pipelineOf(layout, k, wires)?.tiles.map((t) => t.key);
    expect(keys("o")).toEqual(["o", "ghost:c1", "ghost:c2", "ghost:v"]);
    expect(keys("ghost:v")).toEqual(["o", "ghost:c1", "ghost:c2", "ghost:v"]);
    expect(keys("c2")).toEqual(["o", "ghost:c1", "ghost:c2", "ghost:v"]);
    expect(pipelineOf(layout, "o", wires)?.area).toBe("A");
  });
  it("is null for a workspace no wire joins, or one not drawn; a wire into another area isn't followed", () => {
    const { l, running, closed, wires } = scene();
    l.areas.B = area(4000, 0, 1000, 800);
    l.workspaces.b = { x: 4000 + AREA_PAD, y: AREA_HEADER, ...M };
    const layout = resolveLayout(l, [...running, session("b", { taskGroup: "B" })], undefined, [], null, closed);
    const all = [...wires, wire("x", "b"), wire("b", "o")];
    expect(pipelineOf(layout, "x", all)).toBeNull();
    expect(pipelineOf(layout, "nope", all)).toBeNull();
    expect(pipelineOf(layout, "o", all)?.tiles.map((t) => t.key)).not.toContain("b");
  });
});

describe("re-laying out a pipeline", () => {
  it("lays only its members out in stage columns from its top-left, captioned, and Undo puts every place back", () => {
    const { l, running, closed, wires, layout } = scene();
    const p = ready(planRelayoutPipeline(l, layout, "o", T, wires));
    const next = applyPatch(l, p.patch!);
    const r = resolveLayout(next, running, undefined, [], null, closed);
    // its top-left as it lay: the leftmost member's x (c1's), the topmost's y (c2's), with room over the fanning columns
    const left = snapUp(1.5 * M.w);
    const top = snapUp(1.5 * M.h);
    expect(rectIn(r, "o")).toMatchObject({ x: left, y: top });
    expect(rectIn(r, "ghost:c1")).toMatchObject({ x: left + M.w + WIRED_COLUMN_GAP, y: top });
    expect(rectIn(r, "ghost:c2")).toMatchObject({ x: left + M.w + WIRED_COLUMN_GAP, y: top + M.h + GAP });
    expect(rectIn(r, "ghost:v")).toMatchObject({ x: left + 2 * (M.w + WIRED_COLUMN_GAP), y: top });
    // x, which no wire joins and nothing landed on, stays
    expect(rectIn(r, "x")).toEqual(rectIn(layout, "x"));
    expect(stageCaptions(r, wires).map((c) => c.y)).toEqual([top - STAGE_CAPTION_H]);
    const undone = undoOfPlan(l, p);
    const back = applyPatch(applyPatch(next, undone.patch!), undone.after ?? {});
    expect(back.workspaces).toEqual(l.workspaces);
    expect(back.areas).toEqual(l.areas);
  });

  it("is the same laid out again: it works at any time, not only after a lay-out", () => {
    const { l, running, closed, wires, layout } = scene();
    const once = applyPatch(l, ready(planRelayoutPipeline(l, layout, "o", T, wires)).patch!);
    const again = planRelayoutPipeline(once, resolveLayout(once, running, undefined, [], null, closed), "ghost:c2", T, wires);
    expect(ready(again).patch).toBeNull();
  });

  it("pushes aside what the new block lands on, as a drag would, and grows the area to hold it", () => {
    const { l, running, closed, wires } = scene();
    // the pipeline's top-left at o's, and x just where c1's column goes; the area only as wide as two columns
    const y0 = AREA_HEADER + STAGE_CAPTION_H + 2 * (M.h + GAP);
    l.workspaces.o = { x: AREA_PAD, y: y0, ...M };
    l.workspaces.c1 = { x: AREA_PAD, y: y0 + M.h + GAP, ...M };
    l.workspaces.c2 = { x: AREA_PAD, y: y0 + 2 * (M.h + GAP), ...M };
    l.workspaces.v = { x: AREA_PAD, y: y0 + 3 * (M.h + GAP), ...M };
    l.workspaces.x = { x: col(1), y: y0 + 40, ...M };
    l.areas.A = area(0, 0, col(1) + M.w + AREA_PAD, y0 + 4 * (M.h + GAP) + AREA_PAD);
    const layout = resolveLayout(l, running, undefined, [], null, closed);
    const p = ready(planRelayoutPipeline(l, layout, "o", T, wires));
    const r = resolveLayout(applyPatch(l, p.patch!), running, undefined, [], null, closed);
    const members = ["o", "ghost:c1", "ghost:c2", "ghost:v"].map((k) => rectIn(r, k));
    const x = rectIn(r, "x");
    expect(x).not.toEqual(rectIn(layout, "x"));
    for (const m of members) expect(overlaps(m, x)).toBe(false);
    const a = r.areas.find((z) => z.key === "A")!.rect;
    for (const m of [...members, x]) expect(m.x + m.w <= a.x + a.w && m.y + m.h <= a.y + a.h).toBe(true);
  });

  it("is refused for a workspace no wire joins, and in a locked or collapsed area", () => {
    const { l, layout, wires, running, closed } = scene();
    expect(refusal(planRelayoutPipeline(l, layout, "x", T, wires))).toMatch(/isn't wired to another workspace/);
    l.areas.A = { ...l.areas.A, locked: true };
    expect(refusal(planRelayoutPipeline(l, resolveLayout(l, running, undefined, [], null, closed), "o", T, wires))).toMatch(/A is locked/);
  });
});
