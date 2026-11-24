import { describe, expect, it } from "vitest";
import { pipelineStages, pipelinesIn, planOpenWindow, resolveLayout, shownPipeline, stepsIn, type AreaPlan, type TidyWire } from "../src/renderer/landscapeModel";
import { AREA_HEADER, AREA_PAD, GAP, emptyLandscape, parseLandscape, presetSize, snapUp, type Area, type Landscape } from "../src/shared/landscape";
import { asOrchestrated, pipelineTemplateOf } from "../src/shared/pipelineEdit";
import type { TemplateBody } from "../src/shared/pipelineTemplates";
import type { SessionInfo } from "../src/shared/types";

// A pipeline's window (PipelinePanel.tsx): its stages as Tidy lays them out, which of an area's pipelines it shows, the
// steps a marquee picks, a template made of it, and the window's place and record.

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
const area = (x: number, y: number, w: number, h: number): Area => ({ x, y, w, h, repos: [] });
const M = presetSize("agent", "M");
const T = (k: string) => k;
const wire = (from: string, to: string, type: TidyWire["type"] = "handoff"): TidyWire => ({ from, to, type });
const ready = (p: AreaPlan) => {
  if ("refused" in p) throw new Error(`refused: ${p.refused}`);
  return p;
};
const at = (c: number, r: number) => ({ x: snapUp(AREA_PAD + c * (M.w + 200)), y: snapUp(AREA_HEADER + r * (M.h + 200)), ...M });

/**
 * Area A: an Orchestrator `o` (running) on #5152 and #5153, a Coder for each ticket (`c1`, `c2`, not started) after
 * it, a Verifier `v1` (closed) after c1 with a feedback wire back; and a second pipeline, `b` → `t` (running), made later.
 */
function scene() {
  const l: Landscape = emptyLandscape();
  l.areas.A = area(0, 0, 9 * M.w, 9 * M.h);
  l.workspaces.o = at(0, 0);
  l.workspaces.c1 = at(1, 0);
  l.workspaces.c2 = at(1, 1);
  l.workspaces.v1 = at(2, 0);
  l.workspaces.b = at(0, 3);
  l.workspaces.t = at(1, 3);
  const running = [session("o", { title: "Orchestrator", role: "orchestrator", createdAt: 1, ticketId: "5152" }), session("b", { title: "Builder", createdAt: 10 }), session("t", { title: "Tester", createdAt: 11 })];
  const closed = [
    session("c1", { title: "Coder 5152", createdAt: 2, ticketId: "5152", planned: { worktree: true } }),
    session("c2", { title: "Coder 5153", createdAt: 3, ticketId: "5153", planned: { worktree: true } }),
    session("v1", { title: "Verifier 5152", createdAt: 4, ticketId: "5152", status: "dead" }),
  ];
  const wires = [wire("o", "c1"), wire("o", "c2"), wire("c1", "v1"), wire("v1", "c1", "feedback"), wire("b", "t")];
  return { l, running, closed, wires, layout: resolveLayout(l, running, undefined, [], null, closed) };
}

describe("a pipeline's stages", () => {
  it("are its columns along its wires, as Tidy lays them out, each under the word its cards' names share", () => {
    const { layout, wires } = scene();
    const p = pipelineStages(layout, "c2", wires)!;
    expect(p.area).toBe("A");
    expect(p.key).toBe("o");
    expect(p.stages.map((st) => [st.word, st.steps.map((s) => s.id)])).toEqual([
      ["Orchestrator", ["o"]],
      ["Coder", ["c1", "c2"]],
      ["Verifier", ["v1"]],
    ]);
  });

  it("name a column whose names share no first word by its place", () => {
    const { l, running, closed, wires } = scene();
    const layout = resolveLayout(l, running, undefined, [], null, closed.map((s) => (s.id === "c2" ? { ...s, title: "Reviewer 5153" } : s)));
    expect(pipelineStages(layout, "o", wires)!.stages.map((st) => st.word)).toEqual(["Orchestrator", "Stage 2", "Verifier"]);
  });

  it("are null for a workspace no wire joins to another", () => {
    const { l, running, closed, wires } = scene();
    l.workspaces.x = at(4, 4);
    const layout = resolveLayout(l, [...running, session("x", { createdAt: 20 })], undefined, [], null, closed);
    expect(pipelineStages(layout, "x", wires)).toBeNull();
  });
});

describe("an area's pipelines, and the one a window shows", () => {
  it("are each pipeline once, in the order their first cards were made", () => {
    const { layout, wires } = scene();
    expect(pipelinesIn(layout, "A", wires).map((p) => p.tiles.map((t) => t.key))).toEqual([
      ["o", "ghost:c1", "ghost:c2", "ghost:v1"],
      ["b", "t"],
    ]);
    expect(pipelinesIn(layout, "B", wires)).toEqual([]);
  });

  it("shows the one its member is in, else the selected card's, else the first", () => {
    const { layout, wires } = scene();
    const shows = (prefer: (string | null)[]) => shownPipeline(layout, "A", wires, prefer).shown?.key;
    expect(shows(["t", "c1"])).toBe("b");
    expect(shows([null, "c1"])).toBe("o");
    expect(shows([null, "nope"])).toBe("o");
    expect(shows([])).toBe("o");
    expect(shownPipeline(layout, "A", wires, []).all).toHaveLength(2);
    expect(shownPipeline(layout, "A", [], ["o"]).shown).toBeNull();
  });
});

describe("the steps a marquee picks", () => {
  it("are the not-started steps whose cards it touches, never a closed one", () => {
    const { layout } = scene();
    const box = (c: number, r: number, w = 1, h = 1) => ({ x: at(c, r).x - 10, y: at(c, r).y - 10, w: w * (M.w + 200), h: h * (M.h + 200) });
    expect(stepsIn(layout.ghosts, box(1, 0, 1, 2))).toEqual(["c1", "c2"]);
    expect(stepsIn(layout.ghosts, box(2, 0))).toEqual([]);
    expect(stepsIn(layout.ghosts, box(5, 5))).toEqual([]);
  });
});

describe("a pipeline as a template", () => {
  const st = (id: string, ticketId: string | null, more: Partial<SessionInfo> = {}) => ({ id, title: id, ticketId, ...more });

  it("keeps a fanned stage as one step that runs once per ticket, from one ticket's row, its Orchestrator as one, each said", () => {
    const p = pipelineTemplateOf([
      { word: "Orchestrator", steps: [st("o", "5152", { role: "orchestrator" })] },
      { word: "Coder", steps: [st("c1", "5152", { agent: "codex" }), st("c2", "5153", { agent: "codex" })] },
      { word: "Verifier", steps: [st("v2", "5153"), st("v1", "5152")] },
    ]);
    expect(p.ids).toEqual(["o", "c1", "v1"]);
    expect(p.perTicket).toEqual(["c1", "v1"]);
    expect(p.others).toEqual(["c2", "v2"]);
    expect(p.orchestrator).toBe(true);
    expect(p.differ).toBe(false);
    expect(p.ticket).toBe("5152");
    expect(p.rows).toEqual([
      { ticket: "5152", says: "Coder (Codex) and Verifier (Claude)", size: 2 },
      { ticket: "5153", says: "Coder (Codex) and Verifier (Claude)", size: 2 },
    ]);
    // nothing left out: the other ticket's row is what the kept one is made as on it
    expect(p.simplified).toEqual([
      "“Coder” and “Verifier” run once per ticket here (#5152, #5153): kept as steps that run once per ticket, from #5152's row.",
      "It starts at an Orchestrator, kept as one: laid out, it starts alone, told the rest as its plan's starting shape.",
    ]);
  });

  it("keeps shared stages single around a fan, so their wires fan out and in again", () => {
    const p = pipelineTemplateOf([
      { word: "Planner", steps: [st("plan", "1")] },
      { word: "Coder", steps: [st("c1", "1"), st("c2", "2"), st("c3", "3")] },
      { word: "Merger", steps: [st("merge", "1")] },
    ]);
    expect(p.ids).toEqual(["plan", "c1", "merge"]);
    expect(p.perTicket).toEqual(["c1"]);
    expect(p.others).toEqual(["c2", "c3"]);
    expect(p.simplified).toEqual(["“Coder” runs once per ticket here (#1, #2, #3): kept as steps that run once per ticket, from #1's row."]);
  });

  it("keeps the fullest row when tickets' rows differ, says how, and keeps another ticket's when asked", () => {
    const stages = [
      { word: "Coder", steps: [st("c1", "1"), st("c2", "2", { agent: "codex" })] },
      { word: "Verifier", steps: [st("v2", "2")] },
      { word: "Docs", steps: [st("d1", "1"), st("d2", "2"), st("e2", "2")] },
    ];
    const p = pipelineTemplateOf(stages);
    expect(p.differ).toBe(true);
    expect(p.ticket).toBe("2");
    expect(p.ids).toEqual(["c2", "v2", "d2", "e2"]);
    expect(p.perTicket).toEqual(["c2", "d2", "e2"]);
    expect(p.others).toEqual(["c1", "d1"]);
    expect(p.simplified).toEqual([
      "“Coder” and “Docs” run once per ticket here (#1, #2): kept as steps that run once per ticket, from #2's row.",
      "Its tickets' rows differ: #1's has Coder (Claude) and Docs (Claude); #2's has Coder (Codex), Docs (Claude) and Docs (Claude). It keeps #2's, the fullest.",
    ]);
    // the Verifier on one ticket is a stage of its own: kept once, as it's shared
    const one = pipelineTemplateOf(stages, "#1");
    expect(one.ticket).toBe("1");
    expect(one.ids).toEqual(["c1", "v2", "d1"]);
    expect(one.simplified[1]).toBe("Its tickets' rows differ: #1's has Coder (Claude) and Docs (Claude); #2's has Coder (Codex), Docs (Claude) and Docs (Claude). It keeps #1's.");
    expect(() => pipelineTemplateOf(stages, "9")).toThrow("#9 has no row in this pipeline: its rows are #1 and #2.");
  });

  it("counts a row short of a stage as the leaner one, its missing stage the difference", () => {
    const p = pipelineTemplateOf([
      { word: "Coder", steps: [st("c1", "1"), st("c2", "2")] },
      { word: "Verifier", steps: [st("v1", "1"), st("v3", "3")] },
    ]);
    expect(p.rows.map((r) => [r.ticket, r.size])).toEqual([
      ["1", 2],
      ["2", 1],
      ["3", 1],
    ]);
    expect(p.ticket).toBe("1");
    expect(p.ids).toEqual(["c1", "v1"]);
    expect(pipelineTemplateOf([{ word: "Coder", steps: [st("c1", "1"), st("c2", "2")] }, { word: "Verifier", steps: [st("v1", "1"), st("v3", "3")] }], "3").ids).toEqual(["v3"]);
  });

  it("keeps every step of a stage on one ticket, or on none, as they are: a template holds steps side by side", () => {
    const p = pipelineTemplateOf([
      { word: "Builder", steps: [st("b", "5101")] },
      { word: "Stage 2", steps: [st("r1", "5101"), st("r2", "5101")] },
      { word: "Docs", steps: [st("d1", null), st("d2", null)] },
    ]);
    expect(p).toEqual({ ids: ["b", "r1", "r2", "d1", "d2"], orchestrator: false, simplified: [], perTicket: [], others: [], rows: [], differ: false, ticket: null });
    expect(() => pipelineTemplateOf([{ word: "Builder", steps: [st("b", "5101")] }], "5101")).toThrow("No stage of this pipeline runs once per ticket");
  });

  it("makes a draft's first step its Orchestrator: in a worktree of its own, started as it's laid out", () => {
    const body: TemplateBody = {
      startFirst: false,
      steps: [
        { key: "s1", name: "Orchestrator", agent: "claude", folder: "checkout", prompt: "" },
        { key: "s2", name: "Coder", agent: "codex", folder: { sameAs: "s1" }, prompt: "Implement {ticket}." },
      ],
      wires: [{ from: "s1", to: "s2", type: "handoff" }],
    };
    const out = asOrchestrated(body);
    expect(out.startFirst).toBe(true);
    expect(out.steps[0]).toEqual({ key: "s1", name: "Orchestrator", agent: "claude", folder: "new", prompt: "", role: "orchestrator" });
    expect(out.steps[1]).toBe(body.steps[1]);
    expect(asOrchestrated({ ...body, steps: [] })).toEqual({ ...body, steps: [] });
    // an Orchestrator runs once, planning for every ticket
    expect(asOrchestrated({ ...body, steps: [{ ...body.steps[0], perTicket: true }, body.steps[1]] }).steps[0].perTicket).toBeUndefined();
  });
});

describe("a Pipeline window's place and record", () => {
  it("opens beside its pipeline's cards on its member, and with none names none", () => {
    const { l, layout } = scene();
    const beside = { x: at(0, 0).x, y: at(0, 0).y, w: at(2, 0).x + M.w - at(0, 0).x, h: M.h };
    const p = ready(planOpenWindow(l, layout, "w1", "pipeline", { area: "A", member: "c2" }, T, beside));
    const w = p.patch!.tools!.w1!;
    expect(w).toMatchObject({ tool: "pipeline", docked: false, area: "A", session: "c2" });
    expect(w.placement).toMatchObject({ x: snapUp(beside.x + beside.w + GAP), y: beside.y, w: 400 });
    const none = ready(planOpenWindow(l, layout, "w2", "pipeline", { area: "A" }, T)).patch!.tools!.w2!;
    expect(none.session).toBeUndefined();
    // another area's tool takes no member
    expect(ready(planOpenWindow(l, layout, "w3", "artifacts", { area: "A", member: "c2" }, T)).patch!.tools!.w3!.session).toBeUndefined();
  });

  it("is kept with the member it shows; an Artifacts or Chat window naming a session is refused as before", () => {
    const l = emptyLandscape();
    l.areas.A = area(0, 0, 2000, 1200);
    const raw = (tool: string, more: object) => JSON.parse(JSON.stringify({ ...l, tools: { w: { tool, docked: false, area: "A", placement: { x: 24, y: 48, w: 400, h: 640 }, ...more } } }));
    expect(parseLandscape(raw("pipeline", { session: "c2" })).tools.w).toMatchObject({ tool: "pipeline", session: "c2" });
    expect(parseLandscape(raw("pipeline", {})).tools.w.session).toBeUndefined();
    expect(() => parseLandscape(raw("artifacts", { session: "c2" }))).toThrow(/is an area's artifacts, so it has no session/);
    expect(() => parseLandscape(raw("pipeline", { area: null }))).toThrow(/is null, but pipeline is an area's/);
  });
});
