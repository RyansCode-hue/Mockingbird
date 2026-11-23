import { describe, expect, it } from "vitest";
import { resolveLayout, withoutGone } from "../src/shared/landscapeModel";
import type { Plan, PlanLaidOut, PlanShownAt, PlanView } from "../src/shared/plans";
import type { ModelCatalog, SessionInfo, StepEdit } from "../src/shared/types";
import { PipelineEdits, type PipelineEditDeps } from "../src/main/pipelineEdit";
import { WireService } from "../src/main/wires";
import { pipelineTools } from "../src/main/assistant/tools/pipeline";
import { wireTools } from "../src/main/assistant/tools/wires";
import { sessionTools } from "../src/main/assistant/tools/sessions";
import { diagnoseTools } from "../src/main/assistant/tools/diagnose";
import { startTools } from "../src/main/assistant/tools/start";
import type { PipelineTemplate } from "../src/shared/pipelineTemplates";
import { assistantPrompt, groupLine } from "../src/main/assistant/turns";
import { worldGroups } from "../src/main/assistant/world";
import type { AssistantTool, ToolResult } from "../src/main/assistant/registry";
import { harness } from "./assistantHarness";
import { info, landscapeWorld } from "./assistantWorld";

/**
 * The Assistant's pipeline tools (tools/pipeline.ts) over the real wire service, LandscapeStore and PipelineEdits: in
 * atticus, Planner (a1, running) hands off to Coder (p1) and Coder to Reviewer (p2), both not started; Old (c1) is
 * closed, Dev server (t1) a terminal. The sessions' records and the Orchestrator's plans are the test's.
 */

const CATALOG: ModelCatalog = {
  claude: { models: [{ id: "opus", label: "Opus (latest)" }, { id: "sonnet", label: "Sonnet (latest)" }], efforts: ["low", "medium", "high", "xhigh", "max"] },
  codex: { models: [{ id: "gpt-5.1-codex", label: "GPT-5.1 Codex" }], efforts: ["low", "medium", "high", "xhigh"] },
};

const step = (id: string, title: string, prompt: string, over: Partial<SessionInfo> = {}) => info(id, { title, planned: { worktree: false, prompt }, ...over });

function world() {
  const own = [info("a1", { title: "Planner", model: "opus", status: "working" }), info("t1", { title: "Dev server", shell: true, agent: undefined })];
  // made once atticus's area is there, as steps are added to a pipeline laid out in it
  const ghosts: SessionInfo[] = [];
  const planned = () => ghosts.filter((s) => s.planned);
  const closed = () => ghosts.filter((s) => !s.planned);
  const all = () => [...own, ...ghosts];
  const titleOf = (id: string) => all().find((s) => s.id === id)?.title ?? id;
  const did: string[] = [];
  const problems: string[] = [];
  let made = 0;
  let service!: WireService;
  let edits!: PipelineEdits;
  const plans: PlanView[] = [];
  const dismissed: { id: string; note: string }[] = [];
  const laidOut: { id: string; shown: Plan; at: PlanShownAt }[] = [];

  const sessions = {
    list: () => own,
    resumable: closed,
    planned,
    editPlanned: (id: string, e: StepEdit) => {
      const s = planned().find((x) => x.id === id);
      if (!s) throw new Error(`“${titleOf(id)}” has started, so its spec can't change`);
      if (e.title !== undefined) s.title = e.title.trim().replace(/\s+/g, " ");
      if (e.agent !== undefined) s.agent = e.agent;
      if (e.model !== undefined) s.model = e.model ?? undefined;
      if (e.effort !== undefined) s.effort = e.effort ?? undefined;
      if (e.prompt !== undefined) s.planned = { ...s.planned!, prompt: e.prompt?.trim() ? e.prompt : undefined };
      return { ...s, planned: { ...s.planned! } };
    },
    setClosedModel: (id: string, c: { model?: string | null; effort?: string | null }) => {
      const s = closed().find((x) => x.id === id)!;
      if (c.model !== undefined) s.model = c.model ?? undefined;
      if (c.effort !== undefined) s.effort = c.effort ?? undefined;
      return { ...s };
    },
    relaunchWith: async (id: string, c: { model?: string | null; effort?: string | null }) => {
      const s = own.find((x) => x.id === id)!;
      did.push(`relaunch ${id} ${JSON.stringify(c)}`);
      if (c.model !== undefined) s.model = c.model ?? undefined;
      return { ...s };
    },
    planStep: (q: { title: string; agent: "claude" | "codex"; model?: string; effort?: string; taskGroup: string | null; worktree: boolean; prompt?: string }) => {
      const s = info(`n${++made}`, { title: q.title, agent: q.agent, model: q.model, effort: q.effort, taskGroup: q.taskGroup, planned: { worktree: q.worktree, ...(q.prompt ? { prompt: q.prompt } : {}) } });
      ghosts.push(s);
      return s;
    },
  };
  const remove = (id: string) => {
    for (const list of [own, ghosts]) {
      const k = list.findIndex((s) => s.id === id);
      if (k >= 0) list.splice(k, 1);
    }
  };

  const w = landscapeWorld(own, {
    closed: ghosts,
    over: {
      plannedSteps: planned,
      closedSessions: closed,
      record: (id) => {
        const o = own.find((s) => s.id === id);
        if (o) return { info: o, open: true };
        const c = closed().find((s) => s.id === id);
        return c ? { info: c, open: false } : null;
      },
      guards: { whyNot: () => null, closeWarnings: async () => ({ uncommitted: 2, unpushed: 0, busy: true, unread: null }), answerPrompt: () => ({ refused: "not in this test" }) },
      describeRelaunch: () => ({ blocked: null, warnings: ["It's mid-turn: restarting stops the turn it's on"] }),
      wireList: () => {
        const st = w.store.wires();
        return (st.book ? (Object.entries(st.book.links) as [string, any][]) : []).map(([id, x]) => ({ id, from: x.from, to: x.to, type: x.type, when: x.when, state: "idle", why: null, gate: x.gate ?? "ask", waiting: null, rounds: x.rounds ?? null }));
      },
      modelCatalog: async () => CATALOG,
      editStep: (id, e) => edits.editStep(id, e),
      // the window draws a step it hears of and saves where it put it: the landscape here does the same
      insertStep: async (req) => {
        const r = await edits.insertStep(req);
        place();
        return r;
      },
      setModel: (id, c, o) => edits.setModel(id, c, o),
      forgetSession: (id) => {
        const s = all().find((x) => x.id === id);
        const record = s && !s.shell ? { ...s, ...(s.planned ? { planned: { ...s.planned } } : {}) } : null;
        remove(id);
        did.push(`forget ${id}`);
        return service.forgetChain(id, record, (x) => `“${titleOf(x)}”`);
      },
      unforget: (token) => {
        const r = service.unforget(token, (rec) => void ghosts.push(rec.planned ? rec : { ...rec, status: "dead" }));
        if ("refused" in r) throw new Error(r.refused);
        return r.notes;
      },
      forgetUndoable: (token) => service.forgetUndoable(token),
      wireSettings: (id) => {
        const x = w.store.wires().book?.links[id];
        return x ? { when: x.when, gate: x.gate, ...(x.template !== undefined ? { template: x.template } : {}) } : null;
      },
      setWire: (id, s) => {
        const r = service.set(id, s);
        if ("refused" in r) throw new Error(r.refused);
      },
      repointWire: (id, ends) => {
        const r = service.repoint(id, ends);
        if ("refused" in r) throw new Error(r.refused);
      },
      unrepointWire: (id) => {
        const r = service.unrepoint(id);
        if ("refused" in r) throw new Error(r.refused);
      },
      repointUndoable: (id) => service.repointUndoable(id),
      plans: async () => plans,
      heldPlans: () => plans.map((p) => ({ id: p.id, from: p.held.from, at: p.held.at })),
      layOutPlan: async (id, shown, at): Promise<PlanLaidOut> => {
        laidOut.push({ id, shown, at });
        const k = plans.findIndex((p) => p.id === id);
        const from = plans[k].held.from;
        plans.splice(k, 1);
        const steps = shown.steps.map((s) => ({ key: s.key, ...((x) => ({ id: x.id, title: x.title }))(sessions.planStep({ title: s.name, agent: s.agent as "claude", taskGroup: "atticus", worktree: false, prompt: s.prompt })) }));
        const idOf = (k2: string) => (k2 === "me" ? from : steps.find((s) => s.key === k2)!.id);
        const wires = shown.wires.map((x) => service.add(idOf(x.from), idOf(x.to), x.type)).map((r) => ("id" in r ? r.id! : ""));
        place();
        return { steps, wires, started: null, notes: [], area: at.area };
      },
      dismissPlan: (id, note) => {
        dismissed.push({ id, note });
        plans.splice(plans.findIndex((p) => p.id === id), 1);
        return { to: "a1", title: "Planner", told: "delivered" };
      },
    },
  });
  /** What the window saves as it draws what's new: the places the layout gave what had none. */
  const place = () => {
    const st = w.store.get().landscape;
    const l = resolveLayout(withoutGone(st, all()), own, undefined, [], null, ghosts);
    if (l.patch) w.store.update(l.patch);
  };
  ghosts.push(step("p1", "Coder", "Build the org filter.\nThen add its tests, and run them all."), step("p2", "Reviewer", "Review what Coder changed"), info("c1", { title: "Old", status: "dead", model: "sonnet" }));
  place();
  service = new WireService({ store: w.store, sessions: { list: () => own, resumable: closed, planned }, roomOf: () => null, takenOver: () => null, log: (c, e) => void problems.push(`${c}: ${String(e)}`) });
  edits = new PipelineEdits({
    sessions: sessions as unknown as PipelineEditDeps["sessions"],
    wires: service,
    forget: (id) => {
      remove(id);
      service.sessionForgotten(id);
    },
    catalog: async () => CATALOG,
    log: (c, e) => void problems.push(`${c}: ${String(e)}`),
  });
  const handoff = (from: string, to: string) => {
    const r = service.add(from, to, "handoff");
    if ("refused" in r) throw new Error(r.refused);
    return r.id!;
  };
  const ap = handoff("a1", "p1");
  const pp = handoff("p1", "p2");
  const tools = pipelineTools(w.deps);
  const tool = (name: string): AssistantTool => tools.find((t) => t.name === name)!;
  const links = () => Object.entries(w.store.wires().book!.links).map(([id, x]) => `${id}:${x.from}→${x.to}`).sort();
  return { ...w, own, ghosts, planned, closed, did, problems, service, tool, links, ap, pp, plans, dismissed, laidOut, planStep: sessions.planStep, place };
}

async function go(w: ReturnType<typeof world>, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const why = await w.tool(name).check?.(args);
  if (why) throw new Error(`refused: ${why}`);
  return w.tool(name).run(args);
}
const json = (r: ToolResult) => JSON.parse(r.text);

const view = (over: Partial<PlanView> = {}): PlanView => ({
  id: "plan1",
  held: {
    from: "a1",
    ticket: "5101",
    at: 1_700_000_000_000,
    plan: {
      summary: "Split the work: one codes, one reviews.",
      steps: [
        { key: "code", name: "Coder 5101", agent: "claude", folder: "orchestrator", prompt: "Code #5101's filter" },
        { key: "review", name: "Reviewer 5101", agent: "codex", folder: "orchestrator", prompt: "Review the filter" },
      ],
      wires: [
        { from: "me", to: "code", type: "handoff" },
        { from: "code", to: "review", type: "handoff" },
      ],
    },
  },
  me: { id: "a1", title: "Planner", kind: "agent", agent: "claude", repo: "/code/atticus", branch: "main", ticket: "5101", refusal: null },
  ticketTitle: "Org dropdowns",
  tickets: [{ id: "5101", title: "Org dropdowns" }],
  area: "atticus",
  room: null,
  existing: {},
  installed: ["claude", "codex"],
  repos: ["/code/atticus"],
  problem: null,
  newer: null,
  ...over,
});

describe("the Assistant's pipeline tools", () => {
  it("fix their tiers, and none is rule-able", () => {
    const w = world();
    expect(Object.fromEntries(pipelineTools(w.deps).map((t) => [t.name, t.tier]))).toEqual({
      pipeline: "read",
      list_plans: "read",
      edit_step: "direct",
      insert_step: "direct",
      repoint_wire: "direct",
      relayout_pipeline: "direct",
      set_model: "direct",
      restart_with_model: "confirm",
      wire_settings: "direct",
      automate_wire: "confirm",
      remove_step: "direct",
      forget_session: "confirm",
      lay_out_plan: "confirm",
      dismiss_plan: "confirm",
    });
    expect(pipelineTools(w.deps).filter((t) => t.rule)).toEqual([]);
  });

  it("pipeline reads a session's stages in order: states, models and a not-started step's prompt, whole only when asked, and the wires between", async () => {
    const w = world();
    const out = json(await go(w, "pipeline", { session: "p2" }));
    expect(out.area).toBe("atticus");
    expect(out.pipeline.stages.map((s: { id: string }[]) => s.map((x) => x.id))).toEqual([["a1"], ["p1"], ["p2"]]);
    expect(out.pipeline.stages[0][0]).toEqual({ id: "a1", title: "Planner", state: "working", agent: "claude", model: "opus", effort: null });
    expect(out.pipeline.stages[1][0]).toMatchObject({ id: "p1", title: "Coder", state: "not started", promptStart: "Build the org filter. Then add its tests, and run them all.", promptChars: 59 });
    expect(out.pipeline.stages[1][0].prompt).toBeUndefined();
    expect(out.pipeline.wires).toEqual([
      { id: w.ap, from: "a1", to: "p1", type: "handoff", when: "finished", gate: "ask", state: "idle" },
      { id: w.pp, from: "p1", to: "p2", type: "handoff", when: "finished", gate: "ask", state: "idle" },
    ]);
    const full = json(await go(w, "pipeline", { session: "a1", full_prompts: true }));
    expect(full.pipeline.stages[1][0].prompt).toBe("Build the org filter.\nThen add its tests, and run them all.");
    // a group: each pipeline in its area, and how many of its workspaces no wire joins
    const g = json(await go(w, "pipeline", { group: "atticus" }));
    expect(g.pipelines).toHaveLength(1);
    expect(g.unwired).toBe("1 workspace isn't wired to another in it");
    expect(json(await go(w, "pipeline", { session: "t1" }))).toMatchObject({ pipeline: null });
    expect(await w.tool("pipeline").check!({ session: "a1", group: "atticus" })).toBe("Name a session or a group (one of them)");
  });

  it("the snapshot counts not-started steps and closed sessions per group and the held plans, and lists none of them", () => {
    const w = world();
    const groups = worldGroups({ own: w.own, remote: [], areas: ["atticus"], stacks: [], rooms: [], planned: w.planned(), closed: w.closed() });
    expect(groups).toEqual([{ key: "atticus", stacks: [], sessions: 2, room: null, area: true, notStarted: 2, closed: 1 }]);
    expect(groupLine(groups[0])).toBe("- atticus · 2 running sessions · 2 not started · 1 closed");
    const prompt = assistantPrompt({ question: "?", thread: [], snapshot: { sessions: [], groups, rooms: [], plans: [{ id: "plan1", from: "a1", at: 1 }], now: 0 } });
    expect(prompt).toContain("### Held plans\n1 Orchestrator plan waits to be laid out or dismissed: list_plans reads it");
    expect(prompt).not.toContain("Coder");
    expect(prompt).not.toContain("Build the org filter");
    // none held: no line
    expect(assistantPrompt({ question: "?", thread: [], snapshot: { sessions: [], groups, rooms: [], plans: [], now: 0 } })).not.toContain("Held plans");
  });

  it("list_wires names a not-started step's and a closed session's ends; list_sessions and session_detail show them as such", async () => {
    const w = world();
    w.service.add("c1", "p2", "context");
    const wires = wireTools(w.deps).find((t) => t.name === "list_wires")!;
    const out = JSON.parse((await wires.run({})).text).wires;
    expect(out.map((x: { fromTitle: string; toTitle: string }) => `${x.fromTitle}→${x.toTitle}`)).toEqual(["Planner→Coder", "Coder→Reviewer", "Old→Reviewer"]);
    const listed = JSON.parse((await sessionTools(w.deps).find((t) => t.name === "list_sessions")!.run({})).text);
    expect(listed.sessions.map((s: { id: string }) => s.id)).toEqual(["a1", "t1"]);
    expect(listed.notRunning).toEqual([
      { id: "p1", title: "Coder", agent: "claude", state: "not started", group: "atticus", model: null, effort: null },
      { id: "p2", title: "Reviewer", agent: "claude", state: "not started", group: "atticus", model: null, effort: null },
      { id: "c1", title: "Old", agent: "claude", state: "closed", group: "atticus", model: "sonnet", effort: null },
    ]);
    const detail = JSON.parse((await diagnoseTools(w.deps).find((t) => t.name === "session_detail")!.run({ session: "p1" })).text);
    expect(detail).toMatchObject({ id: "p1", state: "not started", promptChars: 59, worktree: false });
  });

  it("edit_step edits a step that hasn't started, its Undo putting it back while it's as it left it; a started step, an unknown model and nothing to change are refused", async () => {
    const w = world();
    const edit = w.tool("edit_step");
    expect(await edit.check!({ session: "a1", model: "sonnet" })).toContain("has started");
    expect(await edit.check!({ session: "c1", title: "x" })).toContain("has started");
    expect(await edit.check!({ session: "nope", title: "x" })).toContain("There's no session");
    expect(await edit.check!({ session: "p1" })).toBe("Say what to change: its title, agent, model, effort or prompt");
    expect(await edit.check!({ session: "p1", model: "gpt-9" })).toBe("Claude on this Mac doesn't offer “gpt-9”: pick one it lists, or leave the model out for its default.");
    expect(await edit.check!({ session: "p1", agent: "codex", model: "opus" })).toContain("Codex on this Mac doesn't offer “opus”");
    const r = await go(w, "edit_step", { session: "p1", title: "Coder two", model: "sonnet", prompt: "Just the filter" });
    expect(r.text).toBe("Edited “Coder two”: title Coder two, model sonnet, prompt (15 characters).");
    expect(w.planned()[0]).toMatchObject({ title: "Coder two", model: "sonnet", planned: { prompt: "Just the filter" } });
    expect(r.stillUndoable!()).toBe(true);
    expect(await r.undo!()).toBe("Put “Coder” back as it was");
    expect(w.planned()[0]).toMatchObject({ title: "Coder", model: undefined, planned: { prompt: "Build the org filter.\nThen add its tests, and run them all." } });
    // edited again since: its Undo isn't offered
    const r2 = await go(w, "edit_step", { session: "p1", effort: "high" });
    await go(w, "edit_step", { session: "p1", effort: "low" });
    expect(r2.stillUndoable!()).toBe(false);
  });

  it("insert_step splices a step between two, the wire into the second keeping its id, lays the pipeline out again, and its Undo takes it all back", async () => {
    const w = world();
    const ins = w.tool("insert_step");
    expect(await ins.check!({ title: "Tester" })).toBe("Say where it goes: after a session, ahead of one, or both");
    expect(await ins.check!({ after: "a1", before: "p2", title: "Tester" })).toBe("There's no handoff from “Planner” to “Reviewer” to put a step in: name only after or before");
    expect(await ins.check!({ after: "a1", before: "p1", title: "Tester", model: "gpt-9" })).toContain("doesn't offer “gpt-9”");
    expect(await ins.check!({ after: "r~nick~x", title: "Tester" })).toContain("There's no session");
    const before = w.links();
    const lsBefore = JSON.stringify(w.store.get().landscape.workspaces);
    const r = await go(w, "insert_step", { after: "a1", before: "p1", title: "Tester", prompt: "Write the tests first" });
    const made = w.planned().find((s) => s.title === "Tester")!;
    expect(made).toMatchObject({ agent: "claude", model: "opus", planned: { prompt: "Write the tests first" } });
    expect(r.text).toBe(`Inserted “Tester” (${made.id}) after “Planner” and ahead of “Coder”; it waits for its handoff. Laid out the pipeline in “atticus” along its wires.`);
    const wires = w.store.wires().book!.links;
    expect(wires[w.ap]).toMatchObject({ from: made.id, to: "p1" });
    expect(Object.values(wires).some((x) => x.from === "a1" && x.to === made.id)).toBe(true);
    // its stages now: Planner, Tester, Coder, Reviewer
    expect(json(await go(w, "pipeline", { session: "a1" })).pipeline.stages.map((s: { id: string }[]) => s[0].id)).toEqual(["a1", made.id, "p1", "p2"]);
    expect(r.stillUndoable!()).toBe(true);
    expect(await r.undo!()).toBe("Took “Tester” back out: “Planner” hands off to “Coder” again");
    expect(w.links()).toEqual(before);
    expect(w.planned().map((s) => s.id)).toEqual(["p1", "p2"]);
    expect(JSON.stringify(w.store.get().landscape.workspaces)).toBe(lsBefore);
    expect(w.problems).toEqual([]);
  });

  it("repoint_wire moves a wire's end, its Undo moving it back; a wire to itself, no change and an unknown wire are refused", async () => {
    const w = world();
    const re = w.tool("repoint_wire");
    expect(await re.check!({ wire: w.pp, to: "p1" })).toBe("A wire can't run from a session to itself");
    expect(await re.check!({ wire: w.pp, to: "p2" })).toBe("It runs between those two already");
    expect(await re.check!({ wire: "nope", to: "p2" })).toContain("There's no wire");
    expect(await re.check!({ wire: w.pp })).toBe("Say which end moves: from, to or both");
    const r = await go(w, "repoint_wire", { wire: w.pp, to: "c1" });
    expect(r.text).toBe("Moved the handoff from “Coder” to “Reviewer”: it runs from “Coder” to “Old” now.");
    expect(w.store.wires().book!.links[w.pp]).toMatchObject({ from: "p1", to: "c1" });
    expect(r.stillUndoable!()).toBe(true);
    expect(await r.undo!()).toBe("Moved the handoff from “Coder” to “Old” back to run from “Coder” to “Reviewer”");
    expect(w.store.wires().book!.links[w.pp]).toMatchObject({ from: "p1", to: "p2" });
    expect(r.stillUndoable!()).toBe(false);
    // a loop of handoffs: the service's refusal, said as the step's failure
    await expect(Promise.resolve().then(() => re.run({ wire: w.pp, to: "a1" }))).rejects.toThrow(/loop/);
  });

  it("relayout_pipeline lays a pipeline out in stage columns, ghosts with the rest, its Undo putting every place back", async () => {
    const w = world();
    const before = JSON.stringify(w.store.get().landscape);
    const r = await go(w, "relayout_pipeline", { session: "p2" });
    expect(r.text).toBe("Laid out the pipeline in “atticus” along its wires.");
    const ws = w.store.get().landscape.workspaces;
    expect(ws.a1.x).toBeLessThan(ws.p1.x);
    expect(ws.p1.x).toBeLessThan(ws.p2.x);
    expect(await w.tool("relayout_pipeline").check!({ session: "a1" })).toBe("Its pipeline is laid out already");
    expect(r.stillUndoable!()).toBe(true);
    expect(await r.undo!()).toBe("Put back its pipeline's places");
    expect(JSON.stringify(w.store.get().landscape)).toBe(before);
    expect(await w.tool("relayout_pipeline").check!({ session: "t1" })).toBe("It isn't wired to another workspace in its area, so there's no pipeline to lay out");
    w.store.update({ areas: { atticus: { ...w.store.get().landscape.areas.atticus, collapsed: true } } });
    expect(await w.tool("relayout_pipeline").check!({ session: "p1" })).toBe("It's in “atticus”, which is collapsed: open it first");
  });

  it("set_model sets a not-started step's or a closed session's model with an Undo; a running one's is restart_with_model's card, which keeps its wires", async () => {
    const w = world();
    const set = w.tool("set_model");
    expect(await set.check!({ session: "a1", model: "sonnet" })).toBe("“Planner” is running: restart_with_model restarts it on that model, on a card");
    expect(await set.check!({ session: "p1", model: "gpt-9" })).toContain("doesn't offer “gpt-9”");
    expect(await set.check!({ session: "t1", model: "opus" })).toBe("“Dev server” is a terminal: it has no agent to run a model");
    expect(await set.check!({ session: "p1" })).toBe("Say the model, the effort or both");
    const r = await go(w, "set_model", { session: "p1", model: "sonnet", effort: "high" });
    expect(r.text).toBe("“Coder” will run sonnet at high effort when it starts.");
    expect(w.planned()[0]).toMatchObject({ model: "sonnet", effort: "high" });
    expect(await r.undo!()).toBe("Put “Coder” back on its default model at its default effort");
    expect(w.planned()[0].model).toBeUndefined();
    const c = await go(w, "set_model", { session: "c1", model: "opus" });
    expect(c.text).toBe("“Old” runs opus when it's reopened.");
    expect(w.closed()[0].model).toBe("opus");

    const restart = w.tool("restart_with_model");
    expect(await restart.check!({ session: "p1", model: "opus" })).toBe("“Coder” isn't running: set_model changes it, with an Undo");
    const h = harness([restart]);
    const t = await h.turn("put the planner on sonnet", async (call) => (await call("restart_with_model", { session: "a1", model: "sonnet" }), "Card up."));
    expect(w.did.filter((x) => x.startsWith("relaunch"))).toEqual([]);
    const card = await h.card(t.steps[0].cardId!);
    expect(card).toMatchObject({ title: "Restart “Planner” · a1 · atticus on sonnet", detail: expect.stringContaining("keeping its id, its wires, its place and its area"), warnings: ["It's mid-turn: restarting stops the turn it's on"] });
    expect(await h.svc.confirm(card.id)).toMatchObject({ state: "done" });
    expect(w.did).toContain('relaunch a1 {"model":"sonnet"}');
    expect(w.store.wires().book!.links[w.ap]).toMatchObject({ from: "a1", to: "p1" });
  });

  it("wire_settings changes when a wire sends with an Undo; making it send without asking is automate_wire's card", async () => {
    const w = world();
    const ws = w.tool("wire_settings");
    expect(await ws.check!({ wire: w.ap })).toBe("Say what to change");
    expect(await ws.check!({ wire: w.ap, gate: "automatic" })).toBe("That makes it send without asking: automate_wire puts that on a card");
    const r = await go(w, "wire_settings", { wire: w.ap, when: "manual" });
    expect(r.text).toBe("Set the handoff from “Planner” to “Coder”: it sends only when you send.");
    expect(w.store.wires().book!.links[w.ap].when).toBe("manual");
    // automatic, but only when the user sends: nothing goes unasked
    const g = await go(w, "wire_settings", { wire: w.ap, gate: "automatic" });
    expect(w.store.wires().book!.links[w.ap].gate).toBe("automatic");
    expect(await ws.check!({ wire: w.ap, when: "finished" })).toBe("That makes it send without asking: automate_wire puts that on a card");
    expect(await g.undo!()).toBe("Put the handoff from “Planner” to “Coder”'s settings back");
    expect(await r.undo!()).toBe("Put the handoff from “Planner” to “Coder”'s settings back");
    expect(w.store.wires().book!.links[w.ap]).toMatchObject({ when: "finished", gate: "ask" });

    const auto = w.tool("automate_wire");
    expect(await auto.check!({ wire: w.ap, when: "manual" })).toBe("That doesn't make it send without asking: wire_settings changes it, with an Undo");
    const h = harness([auto]);
    const t = await h.turn("let it hand off by itself", async (call) => (await call("automate_wire", { wire: w.ap, gate: "automatic" }), "Card up."));
    expect(w.store.wires().book!.links[w.ap].gate).toBe("ask");
    const card = await h.card(t.steps[0].cardId!);
    expect(card.title).toBe("Let the handoff from “Planner” · a1 · atticus to “Coder” · p1 · atticus send without asking");
    expect(card.detail).toContain("what “Planner” hands off goes to “Coder” without waiting for your Send");
    expect(await h.svc.confirm(card.id)).toMatchObject({ state: "done" });
    expect(w.store.wires().book!.links[w.ap].gate).toBe("automatic");
  });

  it("remove_step takes out a not-started step, joining its chain up, and its Undo brings it back with its wires and place; a running or closed one is forget_session's card", async () => {
    const w = world();
    const rm = w.tool("remove_step");
    expect(await rm.check!({ session: "a1" })).toBe("“Planner” is running: forget_session puts forgetting it on a card");
    expect(await rm.check!({ session: "c1" })).toBe("“Old” is closed: forget_session puts forgetting it on a card");
    const place = w.store.get().landscape.workspaces.p1;
    expect(place).toBeTruthy();
    const r = await go(w, "remove_step", { session: "p1" });
    expect(r.text).toBe("Removed “Coder”. “Planner” → “Reviewer” hands off now.");
    expect(w.planned().map((s) => s.id)).toEqual(["p2"]);
    expect(w.links()).toEqual([expect.stringMatching(/:a1→p2$/)]);
    expect(w.store.get().landscape.workspaces.p1).toBeUndefined();
    expect(r.stillUndoable!()).toBe(true);
    expect(await r.undo!()).toBe("Put “Coder” back, with its wires.");
    expect(w.planned().map((s) => s.id).sort()).toEqual(["p1", "p2"]);
    expect(w.links()).toEqual([`${w.ap}:a1→p1`, `${w.pp}:p1→p2`].sort());
    expect(w.store.get().landscape.workspaces.p1).toEqual(place);
    expect(r.stillUndoable!()).toBe(false);

    const fg = w.tool("forget_session");
    expect(await fg.check!({ session: "p1" })).toBe("“Coder” hasn't started: remove_step takes it out, with an Undo");
    const h = harness([fg]);
    const t = await h.turn("forget the planner", async (call) => (await call("forget_session", { session: "a1" }), "Card up."));
    const card = await h.card(t.steps[0].cardId!);
    expect(card).toMatchObject({ title: "Forget “Planner” · a1 · atticus", detail: expect.stringContaining("Closes its pane, stops its agent and forgets it") });
    expect(card.warnings.join(" ")).toContain("2");
    expect(w.did).not.toContain("forget a1");
    expect(await h.svc.confirm(card.id)).toMatchObject({ state: "done" });
    expect(w.did).toContain("forget a1");
  });

  it("list_plans reads held plans; lay_out_plan lays one out as held on a card, then lays its pipeline out; dismiss_plan tells its Orchestrator, with the note", async () => {
    const w = world();
    w.plans.push(view());
    const listed = json(await go(w, "list_plans", {}));
    expect(listed.plans[0]).toMatchObject({
      id: "plan1",
      orchestrator: { id: "a1", title: "Planner" },
      area: "atticus",
      summary: "Split the work: one codes, one reviews.",
      steps: [expect.objectContaining({ key: "code", name: "Coder 5101", promptStart: "Code #5101's filter" }), expect.objectContaining({ key: "review", agent: "codex" })],
      wires: [{ from: "orchestrator", to: "code", type: "handoff", when: "finished", gate: "ask" }, expect.objectContaining({ from: "code", to: "review" })],
      problem: null,
    });

    const lay = w.tool("lay_out_plan");
    expect(await lay.check!({ plan: "nope" })).toContain("There's no held plan");
    w.plans[0] = view({ problem: "Codex isn't installed on this Mac" });
    expect(await lay.check!({ plan: "plan1" })).toBe("It can't be laid out now: Codex isn't installed on this Mac");
    w.plans[0] = view();
    const h = harness([lay, w.tool("dismiss_plan")]);
    const t = await h.turn("lay it out", async (call) => (await call("lay_out_plan", { plan: "plan1" }), "Card up."));
    const card = await h.card(t.steps[0].cardId!);
    expect(card).toMatchObject({ title: "Lay out the plan from “Planner” · a1 · atticus in “atticus”", detail: "Makes Coder 5101 (Claude), Reviewer 5101 (Codex). Coder 5101 starts now with its prompt; the rest wait for their handoffs.", body: "Split the work: one codes, one reviews." });
    expect(w.laidOut).toEqual([]);
    expect(await h.svc.confirm(card.id)).toMatchObject({ state: "done" });
    expect(w.laidOut).toEqual([{ id: "plan1", shown: view().held.plan, at: { area: "atticus", room: null } }]);
    // its steps joined the Orchestrator's pipeline, laid out along its wires
    const made = w.planned().filter((s) => s.title.endsWith("5101"));
    const ws = w.store.get().landscape.workspaces;
    expect(made.map((s) => ws[s.id].x > ws.a1.x)).toEqual([true, true]);
    expect((await h.card(card.id)).result).toBe("Laid out the plan in “atticus”: Coder 5101 (n1), Reviewer 5101 (n2). Laid out the pipeline in “atticus” along its wires.");

    w.plans.push(view({ id: "plan2" }));
    const t2 = await h.turn("dismiss it", async (call) => (await call("dismiss_plan", { plan: "plan2", note: "Do it in one step" }), "Card up."));
    const c2 = await h.card(t2.steps[0].cardId!);
    expect(c2).toMatchObject({ title: "Dismiss the plan from “Planner” · a1 · atticus", body: "Do it in one step" });
    expect(await h.svc.confirm(c2.id)).toMatchObject({ state: "done" });
    expect(w.dismissed).toEqual([{ id: "plan2", note: "Do it in one step" }]);
    w.plans.push(view({ id: "plan3" }));
    const dismiss = w.tool("dismiss_plan");
    const args = { plan: "plan3" };
    await dismiss.card!(args);
    expect(dismiss.stillValid!(args)).toBe(true);
    // a newer plan held in its place expires the card
    w.plans[0] = view({ id: "plan3", held: { ...view().held, at: 1_700_000_000_001 } });
    expect(dismiss.stillValid!(args)).toBe(false);
  });

  it("lay_out_template lays the new pipeline out in stage columns once the window has drawn its steps", async () => {
    const w = world();
    const tpl: PipelineTemplate = {
      id: "t-build",
      name: "Build → Review",
      savedAt: 1,
      startFirst: false,
      steps: [
        { key: "build", name: "Builder", agent: "claude", folder: "new", prompt: "Build it" },
        { key: "review", name: "Reviewer", agent: "codex", folder: { sameAs: "build" }, prompt: "Review it" },
      ],
      wires: [{ from: "build", to: "review", type: "handoff" }],
    };
    const deps = {
      ...w.deps,
      templates: () => ({ templates: [tpl], refused: [] }),
      repos: () => [{ name: "atticus", path: "/code/atticus", root: "/code" }],
      layOut: async () => {
        const a = w.planStep({ title: "Builder", agent: "claude", taskGroup: "atticus", worktree: true, prompt: "Build it" });
        const b = w.planStep({ title: "Reviewer", agent: "codex", taskGroup: "atticus", worktree: false, prompt: "Review it" });
        const r = w.service.add(a.id, b.id, "handoff");
        // the window draws them a moment later, and saves where it put them
        setTimeout(() => w.place(), 150);
        return { steps: [{ key: "build", id: a.id, title: "Builder" }, { key: "review", id: b.id, title: "Reviewer" }], wires: ["id" in r ? r.id! : ""], started: null, notes: [] };
      },
    };
    const t = startTools(deps).find((x) => x.name === "lay_out_template")!;
    const a = { template: "t-build", area: "atticus", repo: "atticus" };
    expect(await t.check!(a)).toBeNull();
    const r = await t.run(a);
    expect(r.text).toBe("Laid out “Build → Review” in “atticus”: Builder (n1), Reviewer (n2). Laid out the pipeline in “atticus” along its wires.");
    const ws = w.store.get().landscape.workspaces;
    expect(ws.n1.x).toBeLessThan(ws.n2.x);
    expect(ws.n1.y).toBe(ws.n2.y);
  });
});
