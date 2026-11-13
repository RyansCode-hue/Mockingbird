import { describe, expect, it } from "vitest";
import { PILL_SIZE, resolveLayout } from "../src/renderer/landscapeModel";
import { LANE_PX, anchorOf, commonReason, curveDistance, defaultChoice, droppedNote, mateWireNote, finishLines, finishedLine, gateContextOf, gateView, mergePrsOf, noChoice, pillBox, plannedLine, plannedShort, shiftedBox, togglePart, translateOf, whose, wireBanners, wireChoices, wireCurve, wireCurves, wireNear, unmovedNote, wireTargets, wireViews, worktreeLine, type WireView } from "../src/renderer/wiresModel";
import { chainOf, stepEnds, stepNote } from "../src/renderer/pipelineChain";
import { mergeViewOf } from "../src/main/prWatch";
import { emptyLandscape, type Landscape } from "../src/shared/landscape";
import type { PipelinePr, SessionInfo, TicketPipeline } from "../src/shared/types";
import { ROOM_LINE, gateOf, newWire, stepRefusal, type GateContext, type Wire, type WireBook, type WireState } from "../src/shared/wires";

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  title: id,
  repoPath: "/r",
  cwd: "/r/wt",
  branch: null,
  ticketId: null,
  ticketTitle: null,
  taskGroup: "a",
  status: "idle",
  createdAt: 0,
  kind: "work",
  extraDirs: [],
  waitingReason: null,
  waitingSince: null,
  agent: "claude",
  ...over,
});

// area a: builder and reviewer side by side, tester under reviewer, a stack of two (docs/notes) under builder, and a
// terminal under the stack; spike closed with its place kept (a ghost). Area b holds pathways, alone.
const running = [
  session("builder"),
  session("reviewer"),
  session("tester"),
  session("docs", { taskGroup: "a/st" }),
  session("notes", { taskGroup: "a/st" }),
  session("dev", { shell: true, agent: undefined }),
  session("pathways", { taskGroup: "b" }),
];
const closed = [session("spike", { status: "dead" }), session("gone", { status: "dead" })];
const stored = (collapsed: string[] = []): Landscape => {
  const l = emptyLandscape();
  l.areas.a = { x: 0, y: 0, w: 1600, h: 1400, repos: [] };
  l.areas.b = { x: 2000, y: 0, w: 800, h: 600, repos: [], ...(collapsed.includes("b") ? { collapsed: true } : {}) };
  l.workspaces.builder = { x: 40, y: 80, w: 400, h: 300 };
  l.workspaces.reviewer = { x: 520, y: 80, w: 400, h: 300 };
  l.workspaces.tester = { x: 520, y: 480, w: 400, h: 300 };
  l.stacks["a/st"] = { active: "docs", placement: { x: 40, y: 480, w: 400, h: 300 } };
  l.workspaces.dev = { x: 40, y: 880, w: 400, h: 200 };
  l.workspaces.spike = { x: 1000, y: 80, w: 400, h: 300 };
  l.workspaces.pathways = { x: 2040, y: 80, w: 400, h: 300 };
  return l;
};
const layoutOf = (collapsed: string[] = [], shown = running) => resolveLayout(stored(collapsed), shown, undefined, [], null, closed);
const stateOf = (links: Record<string, Wire>, notes: WireBook["notes"] = {}): WireState => ({ book: { wv: 1, links, notes }, refused: null, wiresRev: 1, problems: [] });
let t = 0;
const wire = (from: string, to: string, type: Wire["type"], over: Partial<Wire> = {}): Wire => ({ ...newWire(from, to, type, ++t), ...over });
const view = (views: WireView[], id: string) => views.find((v) => v.id === id);

describe("a wire's ends", () => {
  const layout = layoutOf();
  it("are the tile holding the session, its ghost, or nothing when it isn't on the landscape", () => {
    expect(anchorOf(layout, "builder")).toEqual({ kind: "tile", key: "builder", rect: { x: 40, y: 80, w: 400, h: 300 }, tab: null });
    expect(anchorOf(layout, "spike")).toMatchObject({ kind: "ghost", rect: { x: 1000, y: 80, w: 400, h: 300 }, tab: null });
    // closed with no place: only in the Closed sessions list; and a session this window doesn't know
    expect(anchorOf(layout, "gone")).toBeNull();
    expect(anchorOf(layout, "nobody")).toBeNull();
  });

  it("in a stack, are the stack's tile, naming a tab that isn't in front", () => {
    expect(anchorOf(layout, "docs")).toEqual({ kind: "tile", key: "ws:a/st", rect: { x: 40, y: 480, w: 400, h: 300 }, tab: null });
    expect(anchorOf(layout, "notes")).toEqual({ kind: "tile", key: "ws:a/st", rect: { x: 40, y: 480, w: 400, h: 300 }, tab: "notes" });
    // a stack's closed tab is its tile's too
    const withClosed = resolveLayout(stored(), running.filter((s) => s.id !== "notes"), undefined, [], null, [...closed, session("notes", { taskGroup: "a/st", status: "dead" })]);
    expect(anchorOf(withClosed, "notes")).toMatchObject({ kind: "tile", key: "ws:a/st", tab: "notes" });
  });

  it("in a collapsed area, are its pill", () => {
    const folded = layoutOf(["b"]);
    expect(anchorOf(folded, "pathways")).toEqual({ kind: "pill", key: "b", rect: { x: 2000, y: 0, ...PILL_SIZE }, tab: null });
    // drawn at its size on screen: held below 100%, its own size above
    expect(pillBox({ x: 2000, y: 0, ...PILL_SIZE }, { w: 300, h: 34 }, 0.5)).toEqual({ x: 2000, y: 0, w: 600, h: 68 });
    expect(pillBox({ x: 2000, y: 0, ...PILL_SIZE }, { w: 300, h: 34 }, 2)).toEqual({ x: 2000, y: 0, w: 300, h: 34 });
    expect(pillBox({ x: 2000, y: 0, ...PILL_SIZE }, null, 0.5)).toEqual({ x: 2000, y: 0, ...PILL_SIZE });
  });
});

describe("what a wire shows", () => {
  const layout = layoutOf();
  const views = wireViews(
    stateOf(
      {
        idle: wire("builder", "reviewer", "handoff"),
        ready: wire("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 1 }, pending: { id: "p1", body: "2 changes", at: 1, verdict: "changes", flags: [] } }),
        held: wire("reviewer", "tester", "handoff"),
        sending: wire("tester", "spike", "handoff", { pending: { id: "p2", body: "go", at: 1, flags: [] }, delivery: { id: "p2", state: "queued", at: 1 } }),
        sent: wire("docs", "tester", "handoff", { delivery: { id: "p3", state: "sent", at: 1 } }),
        placed: wire("builder", "tester", "handoff", { delivery: { id: "p4", state: "placed", at: 1 } }),
        context: wire("tester", "notes", "context"),
        tree: wire("builder", "dev", "worktree"),
        looped: wire("tester", "pathways", "feedback", { rounds: { limit: 3, used: 2 } }),
        offscreen: wire("builder", "gone", "handoff"),
        oneStack: wire("docs", "notes", "context"),
      },
      { reviewer: { verdict: "changes", hops: 0 } }
    ),
    layout
  );

  it("is each state Inbox.dc.html draws, with its label", () => {
    expect(view(views, "idle")).toMatchObject({ look: "idle", arrow: true, dot: null, label: null });
    expect(view(views, "ready")).toMatchObject({ look: "ready", dot: "ready", label: { text: "Ready · round 2 of 3", tone: "ready" } });
    // a handoff out of a reviewer whose last verdict was "changes" waits for approve
    expect(view(views, "held")).toMatchObject({ look: "blocked", dot: "blocked", label: { text: "needs approve", tone: "blocked" }, why: "needs approve" });
    expect(view(views, "sending")).toMatchObject({ look: "sending", label: { text: "sending…", tone: "quiet" } });
    expect(view(views, "sent")).toMatchObject({ look: "sent", label: null });
    expect(view(views, "placed")).toMatchObject({ look: "sent", label: { text: "in its prompt" } });
    expect(view(views, "context")).toMatchObject({ look: "context", arrow: false, label: null });
    expect(view(views, "tree")).toMatchObject({ look: "tree", arrow: false });
    expect(view(views, "looped")).toMatchObject({ look: "idle", label: { text: "loop 2 of 3", tone: "plain" } });
  });

  it("names a stacked tab at its end, and draws nothing with an end off the landscape or both ends in one tile", () => {
    expect(view(views, "context")?.to).toMatchObject({ key: "ws:a/st", tab: "notes" });
    expect(view(views, "sent")?.from).toMatchObject({ key: "ws:a/st", tab: null });
    expect(view(views, "sending")?.to.kind).toBe("ghost");
    expect(view(views, "offscreen")).toBeUndefined();
    expect(view(views, "oneStack")).toBeUndefined();
    expect(views.map((v) => v.id)).toEqual(["idle", "ready", "held", "sending", "sent", "placed", "context", "tree", "looped"]);
  });

  it("ends at a collapsed area's pill, and isn't drawn with both ends in one", () => {
    const folded = layoutOf(["b"], [...running, session("map", { taskGroup: "b" })]);
    const v = wireViews(stateOf({ out: wire("tester", "pathways", "context"), inside: wire("pathways", "map", "context") }), folded);
    expect(v.map((x) => [x.id, x.to.kind, x.to.key])).toEqual([["out", "pill", "b"]]);
  });

  it("blocks by a room as main does: a closed session's room is its area's", () => {
    const tag = { roomId: "R1", sessionId: "builder", owner: "me", ownerName: "You", remote: false, online: true, live: true, lookers: [], cols: 80, rows: 24, git: null, repo: null, repoName: null, guards: { secrets: true, coauthors: true } };
    const roomed = resolveLayout(stored(), running.map((s) => (s.id === "builder" ? { ...s, room: tag } : s)), undefined, [], null, closed);
    const state = stateOf({ w: wire("builder", "spike", "handoff") });
    expect(wireViews(state, roomed, [{ id: "R1", groupKey: "a" }])[0]).toMatchObject({ look: "idle" });
    // by its tag alone, the ghost has no room, and the wire would cross the line
    expect(wireViews(state, roomed)[0]).toMatchObject({ look: "blocked", why: ROOM_LINE, label: { text: "across a room's line" } });
  });

  it("is none while the book can't be read, and the banners say why", () => {
    const refused: WireState = { book: null, refused: "The wires in landscape.json were written by a newer Mockingbird.", wiresRev: 0, problems: [{ kind: "newer", message: "newer" }] };
    expect(wireViews(refused, layout)).toEqual([]);
    expect(wireViews(null, layout)).toEqual([]);
    expect(wireBanners({ state: refused, error: null })).toEqual([refused.refused, "newer"]);
    expect(wireBanners({ state: null, error: "boom" })).toEqual(["The wires couldn't be read (boom), so none are drawn."]);
    expect(wireBanners({ state: stateOf({}), error: null })).toEqual([]);
  });

  it("is blocked by main's merge view of a pr-merged wire: a closed pull request, and one that can't be read", () => {
    const w = wire("builder", "reviewer", "handoff", { when: "pr-merged" });
    const drawn = (merges?: WireState["merges"]) => wireViews({ ...stateOf({ w }), ...(merges ? { merges } : {}) }, layout)[0];
    const closedPr = "PR 12 to dev was closed without merging.";
    expect(drawn({ w: { blocked: closedPr } })).toMatchObject({ look: "blocked", label: { text: "PR 12 to dev was closed without merging", tone: "blocked" }, why: closedPr });
    const unread = "Can't tell whether PR 12 to dev merged (3 tries): Azure DevOps 401 Unauthorized: TF400813";
    expect(drawn({ w: { blocked: unread } })).toMatchObject({ look: "blocked", label: { text: "Can't tell whether PR 12 to dev merged (3 tries)" }, why: unread });
    // waiting on one, or with nothing from main, it's idle
    expect(drawn({ w: { waits: "Waits for PR 12 to dev to merge." } })).toMatchObject({ look: "idle", label: null });
    expect(drawn()).toMatchObject({ look: "idle" });
  });

  it("refuses ends as main's rules do: the Helpdesk tasks workspace, a terminal, another folder unless main resolves it to the same", () => {
    const extra = [
      session("helpdesk", { taskGroup: "c", role: "tasks", title: "Helpdesk" }),
      session("spike2", { taskGroup: "c", shell: true, agent: undefined, title: "Spike: streaming" }),
      session("bump", { taskGroup: "c", shell: true, agent: undefined, cwd: "/r/link", title: "Bump to v1.8" }),
    ];
    const laid = resolveLayout(stored(), [...running, ...extra], undefined, [], null, closed);
    const state = stateOf({ tasks: wire("builder", "helpdesk", "handoff"), term: wire("builder", "spike2", "handoff"), tree: wire("builder", "bump", "worktree") });
    const label = (views: WireView[], id: string) => view(views, id)?.label?.text;
    const views = wireViews(state, laid);
    expect(label(views, "tasks")).toBe("“Helpdesk” is the Helpdesk tasks workspace");
    // a quoted title is kept whole
    expect(label(views, "term")).toBe("“Spike: streaming” is a terminal");
    expect(label(views, "tree")).toBe("“Bump to v1.8” runs in another folder");
    // /r/link is a symlink to /r/wt, as main reads the disk
    expect(view(wireViews({ ...state, folders: { builder: "/r/wt", bump: "/r/wt" } }, laid), "tree")).toMatchObject({ look: "tree", label: null });
  });

  it("names a closed session with no place, for the pipeline strip, as main does: blocked till it's reopened", () => {
    const state = stateOf({ off: wire("builder", "gone", "handoff") });
    const why = (ctx: GateContext | null) => gateOf("off", state.book!.links.off, ctx!).why;
    expect(why(gateContextOf(layout, state))).toBe('This Mac has no session "gone".');
    expect(why(gateContextOf(layout, state, undefined, closed))).toBe("“gone” is closed and not on the landscape: reopen it from Closed sessions.");
  });

  it("is what the pipeline strip says on the step it leads to: one gate for both", () => {
    const state = { ...stateOf({ pr: wire("builder", "reviewer", "handoff", { when: "pr-merged" }) }), merges: { pr: { blocked: "PR 12 to dev was closed without merging." } } };
    const gates = gateContextOf(layout, state)!;
    const chain = chainOf("builder", gates.links, stepEnds({ open: running, ghosts: [], closed: [] }), (id, w) => gateOf(id, w, gates))!;
    expect(stepNote(chain.down[0], "down")).toMatchObject({ text: view(wireViews(state, layout), "pr")!.label!.text, tone: "blocked" });
  });
});

describe("a wire's curve", () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  it("runs side to side to a box on the right, straight where they overlap across it, stopping 2 screen px short", () => {
    const c = wireCurve(a, { x: 200, y: 50, w: 100, h: 100 }, 1)!;
    expect(c).toMatchObject({ from: { x: 100, y: 75 }, to: { x: 198, y: 75 }, fromSide: "right", toSide: "left", bend: "h" });
    expect(c.d).toBe("M100 75 C150 75, 150 75, 198 75");
    expect(c.mid).toEqual({ x: 149.75, y: 75 });
    // at 50% a screen px is 2 landscape px
    expect(wireCurve(a, { x: 200, y: 50, w: 100, h: 100 }, 2)!.to.x).toBe(196);
    // not overlapping: each side's middle
    expect(wireCurve(a, { x: 300, y: 200, w: 100, h: 100 }, 1)).toMatchObject({ from: { x: 100, y: 50 }, to: { x: 298, y: 250 } });
  });

  it("runs top to bottom to a box above or below, and loops under both back to one on the left", () => {
    expect(wireCurve(a, { x: 0, y: 300, w: 100, h: 100 }, 1)).toMatchObject({ from: { x: 50, y: 100 }, to: { x: 50, y: 298 }, fromSide: "bottom", toSide: "top", bend: "v" });
    expect(wireCurve(a, { x: 20, y: -300, w: 100, h: 100 }, 1)).toMatchObject({ from: { x: 60, y: 0 }, to: { x: 60, y: -198 }, fromSide: "top", toSide: "bottom", bend: "v" });
    const back = wireCurve({ x: 300, y: 0, w: 100, h: 100 }, a, 1)!;
    expect(back).toMatchObject({ from: { x: 340, y: 100 }, to: { x: 75, y: 102 }, fromSide: "bottom", toSide: "bottom", bend: "u" });
    // at least 32 screen px under the lower box
    expect(back.d).toBe("M340 100 C340 200, 75 200, 75 102");
    expect(back.mid.y).toBeGreaterThan(100);
  });

  it("isn't drawn between boxes that overlap", () => {
    expect(wireCurve(a, { x: 50, y: 50, w: 100, h: 100 }, 1)).toBeNull();
  });

  it("follows a box moved by a drag, drawn in from its edges zoomed out", () => {
    expect(translateOf("12px 30.5px")).toEqual({ x: 12, y: 30.5 });
    expect(translateOf("-8px")).toEqual({ x: -8, y: 0 });
    expect(translateOf("")).toBeUndefined();
    expect(shiftedBox(a, { x: 12, y: 30 }, 0)).toEqual({ x: 12, y: 30, w: 100, h: 100 });
    expect(shiftedBox(a, undefined, 5)).toEqual({ x: 5, y: 5, w: 90, h: 90 });
  });

  it("runs beside another between the same two boxes rather than on it, its gate dot a dot's width from the other's", () => {
    const a = { x: 0, y: 0, w: 200, h: 100 };
    const right = { x: 300, y: 0, w: 200, h: 100 };
    const below = { x: 0, y: 300, w: 200, h: 100 };
    const left = { x: -400, y: 0, w: 200, h: 100 };
    const run = (id: string, from: string, to: string, ra: typeof a, rb: typeof a) => ({ id, from, to, a: ra, b: rb });
    // a handoff and a context link one way side to side: either side of the line one alone takes
    const side = wireCurves([run("h", "A", "B", a, right), run("c", "A", "B", a, right), run("x", "A", "C", a, below)]);
    const alone = wireCurve(a, right)!;
    expect(side.get("h")!.from.y).toBe(alone.from.y - LANE_PX / 2);
    expect(side.get("c")!.from.y).toBe(alone.from.y + LANE_PX / 2);
    expect(side.get("x")).toEqual(wireCurve(a, below));
    const apart = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
    expect(apart(side.get("h")!.mid, side.get("c")!.mid)).toBeGreaterThanOrEqual(LANE_PX - 0.01);
    // down and back up take one line top to bottom: they're spread too
    const updown = wireCurves([run("d", "A", "C", a, below), run("u", "C", "A", below, a)]);
    expect(updown.get("d")!.from.x).toBe(100 - LANE_PX / 2);
    expect(updown.get("u")!.from.x).toBe(100 + LANE_PX / 2);
    // a wire forward and a loop back don't lie on one another: each runs as it would alone
    const back = wireCurves([run("f", "A", "B", a, right), run("b", "B", "A", right, a)]);
    expect(back.get("f")).toEqual(wireCurve(a, right));
    expect(back.get("b")).toEqual(wireCurve(right, a));
    // two loops back: one inside the other, apart where their dots are; at a zoom, by screen px
    const loops = wireCurves([run("l1", "A", "L", a, left), run("l2", "A", "L", a, left)], 2);
    expect(apart(loops.get("l1")!.mid, loops.get("l2")!.mid)).toBeGreaterThanOrEqual(LANE_PX * 2);
    // an end kept on its box however far its lane moves it
    const thin = wireCurves([0, 1, 2, 3, 4].map((i) => run(`t${i}`, "A", "B", { x: 0, y: 0, w: 200, h: 20 }, right)));
    for (const c of thin.values()) {
      expect(c!.from.y).toBeGreaterThanOrEqual(0);
      expect(c!.from.y).toBeLessThanOrEqual(20);
    }
  });

  it("is found by a point near its line, the nearest of two, and not by one farther than it reaches", () => {
    const side = wireCurve(a, { x: 300, y: 0, w: 100, h: 100 }, 1)!;
    const down = wireCurve(a, { x: 0, y: 300, w: 100, h: 100 }, 1)!;
    expect(curveDistance(side, { x: 200, y: 50 })).toBeLessThan(0.5);
    expect(curveDistance(side, { x: 200, y: 56 })).toBeCloseTo(6, 0);
    const curves = new Map([["side", side], ["down", down]]);
    expect(wireNear(curves, { x: 200, y: 54 }, 6)).toBe("side");
    expect(wireNear(curves, { x: 54, y: 200 }, 6)).toBe("down");
    expect(wireNear(curves, { x: 200, y: 60 }, 6)).toBeNull();
    expect(wireNear(new Map(), { x: 0, y: 0 }, 6)).toBeNull();
  });
});

describe("making a wire", () => {
  const layout = layoutOf();
  const end = (id: string) => ({ id, title: id });
  const ctxOf = (links: Record<string, Wire> = {}, shown = layout) => gateContextOf(shown, stateOf(links), undefined, [], ["builder", "reviewer", "tester", "dev", "spike", "docs", "notes", "r~0f1e2d3c4b5a~n1"])!;

  it("offers the four types, each with what it does, Handoff first and taken by ↵", () => {
    const c = wireChoices(end("builder"), end("tester"), ctxOf());
    expect(c.map((x) => [x.type, x.name, x.from, x.to, x.refused])).toEqual([
      ["handoff", "Handoff", "builder", "tester", null],
      ["context", "Context link", "builder", "tester", null],
      ["feedback", "Feedback loop", "builder", "tester", null],
      ["worktree", "Shared worktree", "builder", "tester", "A shared worktree wire runs from an agent to a terminal."],
    ]);
    expect(c.map((x) => x.line).slice(0, 3)).toEqual(["builder's result becomes tester's next prompt.", "tester can read builder. Nothing is pushed.", "builder's notes go back to tester, 3 rounds at most."]);
    expect(defaultChoice(c)?.type).toBe("handoff");
    expect(noChoice(c)).toBeNull();
  });

  it("says why a type can't be made between these two, as main's rules do, and ↵ takes the first that can", () => {
    // a handoff already there, and one back would be a cycle
    const c = wireChoices(end("tester"), end("builder"), ctxOf({ h: wire("builder", "tester", "handoff") }));
    expect(c.find((x) => x.type === "handoff")?.refused).toMatch(/cycle of handoffs/);
    expect(defaultChoice(c)?.type).toBe("context");
    // a terminal takes only a shared worktree, which runs from the agent to it whichever way it was dragged
    const toTerm = wireChoices(end("builder"), end("dev"), ctxOf());
    expect(toTerm.filter((x) => !x.refused).map((x) => [x.type, x.from, x.to])).toEqual([["worktree", "builder", "dev"]]);
    expect(toTerm[0].refused).toBe("“dev” is a terminal: only a shared worktree wire can reach one.");
    const fromTerm = wireChoices(end("dev"), end("builder"), ctxOf());
    expect(fromTerm.filter((x) => !x.refused).map((x) => [x.type, x.from, x.to, x.line])).toEqual([["worktree", "builder", "dev", worktreeLine("builder", "dev")]]);
    expect(defaultChoice(fromTerm)?.type).toBe("worktree");
  });

  it("is refused outright onto a teammate's workspace, saying why: no type can be made, and main refuses it too", () => {
    const c = wireChoices(end("builder"), end("r~0f1e2d3c4b5a~n1"), ctxOf());
    expect(c.every((x) => x.refused === "That's a teammate's session: wires across Macs come later.")).toBe(true);
    expect(noChoice(c)).toBe("That's a teammate's session: wires across Macs come later.");
    expect(defaultChoice(c)).toBeNull();
    // and from one
    expect(noChoice(wireChoices(end("r~0f1e2d3c4b5a~n1"), end("builder"), ctxOf()))).toMatch(/teammate's session/);
  });

  it("says, when no type can be made, that the one they can have is there, or else the reason most of them give", () => {
    // dev already shares builder's worktree: that's said, though the other three are refused as a terminal
    expect(noChoice(wireChoices(end("dev"), end("builder"), ctxOf({ t: wire("builder", "dev", "worktree") })))).toBe("There's a worktree wire between these two already.");
    expect(wireChoices(end("dev"), end("builder"), ctxOf({ t: wire("builder", "dev", "worktree") })).map((c) => c.exists)).toEqual([false, false, false, true]);
    // a feedback wire is there either way round
    expect(wireChoices(end("reviewer"), end("builder"), ctxOf({ f: wire("builder", "reviewer", "feedback") })).find((c) => c.type === "feedback")?.exists).toBe(true);
    expect(commonReason(["b", "a", "a"])).toBe("a");
    expect(commonReason(["a", "b"])).toBe("a");
    expect(commonReason(["a", null])).toBeNull();
    expect(commonReason([])).toBeNull();
  });

  it("goes to closed workspaces too: a ghost, and a stack's tabs each", () => {
    expect(noChoice(wireChoices(end("builder"), end("spike"), ctxOf()))).toBeNull();
    expect(noChoice(wireChoices(end("builder"), end("notes"), ctxOf()))).toBeNull();
  });

  it("lists, for Connect…, every other session the rules take, its own area's first, each area's closed tabs and ghosts after its workspaces", () => {
    const t = wireTargets(layout, "tester");
    expect(t.map((x) => [x.s.id, x.area, x.closed, x.mate])).toEqual([
      ["builder", "a", false, false],
      ["reviewer", "a", false, false],
      ["docs", "a", false, false],
      ["notes", "a", false, false],
      ["dev", "a", false, false],
      ["spike", "a", true, false],
      ["pathways", "b", false, false],
    ]);
    // a stack's tab lists its own stack-mates first, as the rules take them (an agent stacked with its terminal shares
    // its worktree), but never itself; a collapsed area's aren't drawn
    expect(wireTargets(layout, "docs").slice(0, 1).map((x) => [x.s.id, x.mate])).toEqual([["notes", true]]);
    expect(wireTargets(layout, "docs").map((x) => x.s.id)).not.toContain("docs");
    expect(noChoice(wireChoices(end("docs"), end("notes"), ctxOf()))).toBeNull();
    // a stack's closed tab, which a drag can drop on, is listed too: a closed tab of its own stack among its mates
    const withClosed = resolveLayout(stored(), running.filter((s) => s.id !== "notes"), undefined, [], null, [...closed, session("notes", { taskGroup: "a/st", status: "dead" })]);
    expect(wireTargets(withClosed, "tester").filter((x) => x.s.id === "notes").map((x) => [x.closed, x.mate])).toEqual([[true, false]]);
    expect(wireTargets(withClosed, "docs").map((x) => [x.s.id, x.closed, x.mate]).slice(0, 1)).toEqual([["notes", true, true]]);
    expect(mateWireNote("Builder", "Dev server", "worktree")).toBe("Builder → Dev server (shared worktree) is made. They're tabs of one stack, so it isn't drawn on the landscape: the pipeline strip shows it in focus");
    expect(wireTargets(layoutOf(["b"]), "tester").map((x) => x.s.id)).not.toContain("pathways");
    expect(wireTargets(layoutOf(["b"]), "pathways")[0].area).toBe("a");
  });

  it("lets a next step follow an agent of this Mac's, refusing one from a terminal or a teammate's workspace as the wire would be", () => {
    expect(stepRefusal("builder", ctxOf())).toBeNull();
    expect(stepRefusal("spike", ctxOf())).toBeNull();
    expect(stepRefusal("dev", ctxOf())).toBe("“dev” is a terminal: only a shared worktree wire can reach one.");
    expect(stepRefusal("r~0f1e2d3c4b5a~n1", ctxOf())).toBe("That's a teammate's session: wires across Macs come later.");
  });

  it("to a step not started yet: a handoff waits for it, no shared worktree can be made from it, and its card says what starts it", () => {
    const qa = session("qa", { planned: { worktree: true } });
    const drawn = resolveLayout(stored(), running, undefined, [], null, [...closed, qa]);
    const links = { h: wire("tester", "qa", "handoff", { pending: { id: "p1", body: "done", at: 1, flags: [] } }) };
    const ctx = gateContextOf(drawn, stateOf(links), undefined, [], ["dev"])!;
    expect(ctx.end("qa")).toMatchObject({ where: "planned", placed: true });
    expect(gateOf("h", links.h, ctx)).toMatchObject({ state: "ready", pendingId: "p1" });
    // the send popover's ready face: sending starts it (no cost to ask, unlike a reopen or resume)
    expect(gateView(links.h, gateOf("h", links.h, ctx), ctx.end("qa"), null)).toMatchObject({ face: "ready", pendingId: "p1", starts: "start" });
    expect(wireChoices({ id: "qa", title: "qa" }, { id: "dev", title: "dev" }, ctx).find((c) => c.type === "worktree")?.refused).toBe("“qa” hasn't started, so it has no worktree yet.");
    const titleOf = (id: string) => ({ tester: "Tester", reviewer: "Reviewer" })[id] ?? null;
    expect(plannedLine("qa", links, titleOf)).toBe("Not started. Starts when Tester hands off.");
    expect(plannedLine("qa", links, titleOf, (w) => w === "h")).toBe("Not started. Starts when Tester approves.");
    expect(plannedLine("qa", { c: wire("tester", "qa", "context") }, titleOf)).toBe("Not started. Nothing hands off to it yet: wire a step to it, or start it now.");
    // zoomed out, a line short enough to leave room for its foot
    expect(plannedShort("qa", links)).toBe("Waits for its handoff");
    expect(plannedShort("qa", links, (w) => w === "h")).toBe("Waits for approve");
    expect(plannedShort("qa", { c: wire("tester", "qa", "context") })).toBe("Nothing hands off to it");
  });

  it("names its ends as a possessive reads", () => {
    expect(whose("Builder")).toBe("Builder's");
    expect(whose("Fixtures")).toBe("Fixtures'");
  });
});

describe("a wire's template chips", () => {
  it("add a placeholder on a line of its own, and take it out with the line it leaves", () => {
    expect(togglePart("{summary}", "diff")).toBe("{summary}\n{diff}");
    expect(togglePart("", "ticket")).toBe("{ticket}");
    expect(togglePart("Fix these:\n{summary}\n\n{diff}", "summary")).toBe("Fix these:\n\n{diff}");
    expect(togglePart("{summary}\n{diff}", "diff")).toBe("{summary}");
    expect(togglePart("Review {diff} please", "diff")).toBe("Review please");
  });
});

describe("wires that went with a forgotten session", () => {
  const titles: Record<string, string> = { old: "Spike", fix: "Fixtures", rev: "Reviewer" };
  const name = (id: string) => titles[id] ?? null;
  const toOld = { id: "w1", wire: wire("fix", "old", "handoff") };
  const back = { id: "w2", wire: wire("old", "rev", "feedback", { pending: { id: "p1", body: "notes", at: 1, flags: [] } }) };

  it("names the session forgotten and each wire by its ends and type, with what was waiting", () => {
    expect(droppedNote([toOld], "old", name)).toBe("“Spike” was forgotten, and its wire went with it: Fixtures → Spike (handoff).");
    expect(droppedNote([toOld, back], "old", name)).toBe("“Spike” was forgotten, and its 2 wires went with it: Fixtures → Spike (handoff); Spike → Reviewer (feedback loop, with what was waiting).");
  });

  it("says so when the forgotten session, or another end, isn't known any more", () => {
    expect(droppedNote([toOld], "old", (id) => (id === "old" ? null : name(id)))).toBe("A forgotten session's wire went with it: Fixtures → the forgotten session (handoff).");
    expect(droppedNote([toOld], null, (id) => (id === "fix" ? null : name(id)))).toBe("A forgotten session's wire went with it: a session not here any more → Spike (handoff).");
  });

  it("says why a Start fresh's session didn't take them first", () => {
    const why = "“Shell” isn't the same kind of workspace as “Spike”, so its wires can't move there.";
    expect(unmovedNote("Spike", why)).toBe("“Spike”'s wires couldn't move to the fresh session: “Shell” isn't the same kind of workspace as “Spike”, so its wires can't move there");
    expect(droppedNote([toOld], "old", name, why)).toBe(`${unmovedNote("Spike", why)}. Its wire went with it: Fixtures → Spike (handoff).`);
  });
});

describe("the send popover's face", () => {
  const waiting = (id: string) => ({ pending: { id, body: "Done.", at: 1, flags: [] } });
  const faceOf = (links: Record<string, Wire>, id: string, o: { merges?: WireState["merges"]; shown?: SessionInfo[]; notes?: WireBook["notes"] } = {}) => {
    const state = { ...stateOf(links, o.notes), ...(o.merges ? { merges: o.merges } : {}) };
    const ctx = gateContextOf(layoutOf([], o.shown), state)!;
    const w = links[id];
    return gateView(w, gateOf(id, w, ctx), ctx.end(w.to), ctx.mergeView!(w));
  };

  it("is what waits, with its round on a feedback loop, and says when sending starts its other end", () => {
    expect(faceOf({ h: wire("builder", "reviewer", "handoff", waiting("p1")) }, "h")).toEqual({ face: "ready", kind: "handoff · ready", why: null, pendingId: "p1", starts: null, merge: null });
    expect(faceOf({ f: wire("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 1 }, ...waiting("p2") }) }, "f")).toMatchObject({ face: "ready", kind: "feedback loop · round 2 of 3" });
    // spike is closed with its place (a ghost): sending reopens it; tester exited: sending resumes it
    expect(faceOf({ g: wire("builder", "spike", "handoff", waiting("p3")) }, "g")).toMatchObject({ face: "ready", starts: "reopen" });
    const exited = running.map((s) => (s.id === "tester" ? { ...s, status: "dead" as const } : s));
    expect(faceOf({ t: wire("builder", "tester", "handoff", waiting("p4")) }, "t", { shown: exited })).toMatchObject({ face: "ready", starts: "resume" });
  });

  it("is at the limit, or what may have arrived, each with what waits", () => {
    expect(faceOf({ f: wire("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 3 }, ...waiting("p1") }) }, "f")).toEqual({
      face: "limit",
      kind: "feedback loop · at the limit · 3 of 3",
      why: "At the limit: 3 of 3 rounds.",
      pendingId: "p1",
      starts: null,
      merge: null,
    });
    const maybe = wire("builder", "reviewer", "handoff", { ...waiting("p2"), delivery: { id: "p2", state: "unconfirmed", at: 1, why: "It may have reached “reviewer”." } });
    expect(faceOf({ u: maybe }, "u")).toMatchObject({ face: "unconfirmed", kind: "handoff · may have arrived", why: "It may have reached “reviewer”.", pendingId: "p2" });
  });

  it("shows a pending sent again as the round it already counted, never past the limit, ready", () => {
    // round 3 went and failed: sending it again counts nothing, so it's still round 3 of 3
    const retry = wire("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 3 }, ...waiting("p1"), delivery: { id: "p1", state: "failed", at: 1, why: "The paste failed." } });
    expect(faceOf({ f: retry }, "f")).toMatchObject({ face: "ready", kind: "feedback loop · round 3 of 3", why: "The paste failed.", pendingId: "p1" });
    expect(faceOf({ f: { ...retry, rounds: { limit: 3, used: 2 } } }, "f")).toMatchObject({ face: "ready", kind: "feedback loop · round 2 of 3" });
    // the limit lowered under what's been counted: capped at it
    expect(faceOf({ f: { ...retry, rounds: { limit: 2, used: 3 } } }, "f")).toMatchObject({ face: "ready", kind: "feedback loop · round 2 of 2" });
    // held by an automatic gate, it never went, so it's the next round
    expect(faceOf({ f: { ...retry, rounds: { limit: 3, used: 1 }, delivery: { id: "p1", state: "held", at: 1, why: "Asks." } } }, "f")).toMatchObject({ kind: "feedback loop · round 2 of 3" });
  });

  it("gives a wire at the limit blocked for its end's silent hooks that reason, without One more round", () => {
    const silent = running.map((s) => (s.id === "builder" ? { ...s, hooksSilent: true } : s));
    const retry = wire("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 3 }, ...waiting("p1"), delivery: { id: "p1", state: "failed", at: 1 } });
    expect(faceOf({ f: retry }, "f", { shown: silent })).toMatchObject({ face: "settings", kind: "feedback loop · blocked", why: expect.stringMatching(/its hooks aren't reporting, so a message might never go/) });
    // queued for that end, a newer pending beside it
    const stalled = wire("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 3 }, ...waiting("p2"), delivery: { id: "p1", state: "queued", at: 1 } });
    expect(faceOf({ f: stalled }, "f", { shown: silent })).toMatchObject({ face: "settings", why: expect.stringMatching(/what's queued for it may never go/) });
    // the limit itself, hooks silent or not, offers One more round
    const fresh = wire("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 3 }, ...waiting("p3") });
    expect(faceOf({ f: fresh }, "f", { shown: silent })).toMatchObject({ face: "limit", why: "At the limit: 3 of 3 rounds." });
  });

  it("is otherwise its settings, saying why it's blocked or what it waits for, a merge that can't be read with Check now", () => {
    const pr = wire("builder", "reviewer", "handoff", { when: "pr-merged" });
    const unread = "Can't tell whether PR 12 to dev merged (3 tries): 503";
    expect(faceOf({ pr }, "pr", { merges: { pr: { blocked: unread, prs: ["u/12"] } } })).toEqual({ face: "settings", kind: "handoff · blocked", why: unread, pendingId: null, starts: null, merge: { prs: ["u/12"] } });
    // a view from before main named them: Check now, and no pull request to mark
    expect(faceOf({ pr }, "pr", { merges: { pr: { blocked: unread } } })).toMatchObject({ merge: { prs: [] } });
    expect(faceOf({ pr }, "pr", { merges: { pr: { waits: "Waits for PR 12 to dev to merge." } } })).toMatchObject({ face: "settings", kind: "handoff · idle", why: "Waits for PR 12 to dev to merge.", merge: null });
    // blocked for another reason first: no Check now
    const held = { h: wire("reviewer", "tester", "handoff", { when: "pr-merged" }), f: wire("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 1 } }) };
    expect(faceOf(held, "h", { merges: { h: { blocked: unread } }, notes: { reviewer: { verdict: "changes", hops: 0 } } })).toMatchObject({ face: "settings", why: "needs approve", merge: null });
    // on its way: nothing to send from here
    expect(faceOf({ q: wire("builder", "reviewer", "handoff", { ...waiting("p1"), delivery: { id: "p1", state: "queued", at: 1 } }) }, "q")).toMatchObject({ face: "settings", kind: "handoff · sending", pendingId: null });
  });

  it("names, for Mark merged…, exactly the pull requests main's merge view is blocked on: its source's repository and branch, the latest to each target, none fired", () => {
    const at = 1_000_000;
    const pr = (id: number, over: Partial<PipelinePr> = {}): PipelinePr => ({ target: "dev", provider: "ado", id, url: `u/${id}`, repo: "api", branch: "4182-x", base: "dev", at: at + id, ...over });
    const p = (prs: PipelinePr[]): TicketPipeline => ({ ticketId: "4182", stage: "pr-dev", history: [], prs, feedback: [], drafts: [], checks: {} });
    const failing = { watch: { failures: 3, why: "503", at } };
    const w = wire("builder", "reviewer", "handoff", { when: "pr-merged" });
    const source = { title: "Builder", ticket: "4182", branch: "4182-x" };
    const api = { provider: "ado", repo: "api" } as const;
    const blockedOn = (prs: PipelinePr[], wire = w) => {
      const view = mergeViewOf(wire, source, p(prs), api);
      return view && "blocked" in view ? mergePrsOf(p(prs), view.prs ?? []).map((x) => x.url) : view;
    };
    // the same branch in another repository, closed and newer, isn't this source's
    expect(blockedOn([pr(11, failing), pr(30, { repo: "ui", closedAt: at })])).toEqual(["u/11"]);
    // the latest to dev replaces an older one; one to main is its own
    expect(blockedOn([pr(11, failing), pr(12, failing), pr(13, { target: "main", closedAt: at })])).toEqual(["u/12", "u/13"]);
    // fired for already: behind it, so nothing to mark
    expect(blockedOn([pr(11, failing)], { ...w, fired: ["u/11"] })).toMatchObject({ waits: expect.any(String) });
    // read fine: waits, nothing to mark
    expect(blockedOn([pr(11)])).toEqual({ waits: "Waits for PR 11 to dev to merge." });
    expect(mergePrsOf(undefined, ["u/11"])).toEqual([]);
  });
});

describe("Finish step's lines (W5)", () => {
  // reviewer: a feedback loop back to builder (round 2 of 3 next), a handoff on to tester, and spike closed with its place
  const links = (over: { loop?: Partial<Wire>; on?: Partial<Wire>; ghost?: Partial<Wire> } = {}) => ({
    loop: wire("reviewer", "builder", "feedback", { rounds: { limit: 3, used: 1 }, ...over.loop }),
    on: wire("reviewer", "tester", "handoff", over.on),
    ghost: wire("reviewer", "spike", "handoff", over.ghost),
    read: wire("reviewer", "pathways", "context"),
  });
  const lines = (verdict: "changes" | "approve" | undefined, l = links(), notes: WireBook["notes"] = {}) => finishLines("reviewer", verdict, gateContextOf(layoutOf(), stateOf(l, notes))!).map((x) => [x.to, x.text, x.tone]);

  it("says where each wire out goes and what finishing does along it, by the verdict, before anything moves", () => {
    expect(lines("changes")).toEqual([
      ["builder", "its gate opens · round 2 of 3", "ready"],
      ["tester", "blocked till approve, then its gate opens", "held"],
      ["spike", "blocked till approve, then its gate opens", "held"],
    ]);
    expect(lines("approve")).toEqual([
      ["builder", "nothing goes back on approve", "quiet"],
      ["tester", "its gate opens", "ready"],
      ["spike", "its gate opens", "ready"],
    ]);
  });

  it("says an automatic gate sends itself, but never to an end it would have to start, and what waits at a loop's limit", () => {
    const auto = links({ on: { gate: "automatic" }, ghost: { gate: "automatic" }, loop: { gate: "automatic", rounds: { limit: 3, used: 3 } } });
    expect(lines("approve", auto).slice(1)).toEqual([
      ["tester", "sends itself", "ready"],
      ["spike", "its gate opens: an automatic gate never reopens it", "ready"],
    ]);
    expect(lines("changes", auto)).toEqual([
      ["builder", "waits at its limit · 3 of 3 rounds", "held"],
      ["tester", "blocked till approve, then sends itself", "held"],
      ["spike", "blocked till approve, then sends itself", "held"],
    ]);
  });

  it("says what a readied gate will do: blocked where the other end's hooks are silent, asking after too many automatic sends in a row", () => {
    const auto = links({ on: { gate: "automatic" } });
    const silent = running.map((s) => (s.id === "tester" ? { ...s, hooksSilent: true } : s));
    const ctx = gateContextOf(resolveLayout(stored(), silent, undefined, [], null, closed), stateOf(auto))!;
    expect(finishLines("reviewer", "approve", ctx)[1]).toMatchObject({ to: "tester", tone: "held", text: "waits, blocked: hooks not reporting" });
    // three automatic sends in a row reached tester, or led to reviewer: its gate asks, as main's holds
    expect(lines("approve", auto, { tester: { hops: 3 } })[1]).toEqual(["tester", "its gate opens: after 3 automatic sends in a row, it asks", "ready"]);
    expect(lines("approve", auto, { reviewer: { hops: 3 } })[1]).toEqual(["tester", "its gate opens: after 3 automatic sends in a row, it asks", "ready"]);
    // the verdict the finish leaves on its note, not the one before: "changes" before, approve now, the handoff goes
    expect(lines("approve", auto, { reviewer: { hops: 0, verdict: "changes" } })[1]).toEqual(["tester", "sends itself", "ready"]);
    // a closed end not on the landscape blocks it
    const base = gateContextOf(layoutOf(), stateOf(links()))!;
    const ctxGone = { ...base, end: (id: string) => (id === "tester" ? { ...base.end(id)!, where: "closed" as const, placed: false } : base.end(id)) };
    const toTester = finishLines("reviewer", "approve", ctxGone).find((l) => l.wire === "on");
    expect(toTester).toMatchObject({ tone: "held", text: "waits, blocked: closed" });
  });

  it("says what finishing does to what's already there: replaces what waits, takes back what's on its way, sends again what was sent", () => {
    const p = { id: "p1", body: "earlier", at: 1, flags: [] };
    const over = (verdict: "changes" | "approve", l: ReturnType<typeof links>) => finishLines("reviewer", verdict, gateContextOf(layoutOf(), stateOf(l))!).map((x) => [x.to, x.over]);
    // something waiting: replaced where it readies, taken back where it's held or passes
    expect(over("changes", links({ loop: { pending: p }, on: { pending: p } }))).toEqual([
      ["builder", "replaces what waits"],
      ["tester", "takes back what waits"],
      ["spike", null],
    ]);
    expect(over("approve", links({ loop: { pending: p } }))[0]).toEqual(["builder", "takes back what waits"]);
    // something queued at the other end: taken back where it's held; one being pasted can't be
    const queued = { pending: p, delivery: { id: "p1", state: "queued" as const, at: 1 } };
    expect(over("changes", links({ on: queued }))[1]).toEqual(["tester", "takes back what's on its way"]);
    expect(over("changes", links({ on: { ...queued, delivery: { ...queued.delivery, state: "pasting" as const } } }))[1]).toEqual(["tester", "what's being pasted can't be taken back"]);
    // readied while something's on its way: it waits behind it
    expect(finishLines("reviewer", "approve", gateContextOf(layoutOf(), stateOf(links({ on: queued })))!)[1]).toMatchObject({ text: "waits behind what's on its way", over: null, tone: "held" });
    // sent already: this sends again, said with when
    const at = new Date(2026, 10, 12, 14, 32).getTime();
    const sent = over("approve", links({ on: { delivery: { id: "p0", state: "sent", at } } }))[1];
    expect(sent[0]).toBe("tester");
    expect(sent[1]).toBe("already sent at 14:32: this sends again");
    expect(over("approve", links({ on: { delivery: { id: "p0", state: "unconfirmed", at } } }))[1]).toEqual(["tester", "what was sent may have arrived: this sends again"]);
  });

  it("says a wire that doesn't light, and why one is refused", () => {
    const quiet = links({ on: { when: "manual" }, ghost: { when: "pr-merged", since: 1 } });
    expect(lines("approve", quiet).slice(1)).toEqual([
      ["tester", "doesn't light: a manual wire goes only when a person sends it", "quiet"],
      ["spike", "doesn't light: it goes when its pull request merges", "quiet"],
    ]);
    // tester taken over by a teammate: the take-over's words
    const taken = running.map((s) => (s.id === "tester" ? { ...s, room: { takenOver: { by: "n", byName: "Nick", at: 1 } } as SessionInfo["room"] } : s));
    const ctx = gateContextOf(resolveLayout(stored(), taken, undefined, [], null, closed), stateOf(links()))!;
    expect(finishLines("reviewer", "approve", ctx)[1]).toMatchObject({ to: "tester", tone: "refused", text: "Nick continues “tester” on their laptop." });
  });

  it("says once it's done what each wire did, in main's words", () => {
    expect(
      finishedLine("Reviewer", [
        { wire: "loop", to: "builder", type: "feedback", does: "readies", toTitle: "Builder", pending: { id: "p", flags: [] }, went: { state: "ready" } },
        { wire: "on", to: "tester", type: "handoff", does: "holds", toTitle: "Tester" },
        { wire: "go", to: "docs", type: "handoff", does: "readies", toTitle: "Docs", went: { state: "sending" } },
        { wire: "x", to: "spike", type: "handoff", does: "refused", why: "It was changed while this step was being finished: finish again to ready it.", toTitle: "Spike" },
      ])
    ).toBe("Finished Reviewer's step: Builder: waits at its gate; Tester: blocked till approve; Docs: on its way; Spike: refused (It was changed while this step was being finished: finish again to ready it.).");
  });
});
