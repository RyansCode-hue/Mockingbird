import { describe, expect, it } from "vitest";
import { PILL_SIZE, resolveLayout } from "../src/renderer/landscapeModel";
import { anchorOf, gateContextOf, pillBox, shiftedBox, translateOf, wireBanners, wireCurve, wireViews, type WireView } from "../src/renderer/wiresModel";
import { chainOf, stepEnds, stepNote } from "../src/renderer/pipelineChain";
import { emptyLandscape, type Landscape } from "../src/shared/landscape";
import type { SessionInfo } from "../src/shared/types";
import { ROOM_LINE, gateOf, newWire, type GateContext, type Wire, type WireBook, type WireState } from "../src/shared/wires";

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
});
