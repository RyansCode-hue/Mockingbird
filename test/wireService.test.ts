import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LandscapeStore } from "../src/main/landscape";
import { Messaging, mcpLaunch, retireMcpLaunch } from "../src/main/messaging";
import { WireService, type LayOutDeps } from "../src/main/wires";
import type { StepStarted } from "../src/shared/types";
import { LayOutLeftError, type LayOutRequest, type TemplateBody } from "../src/shared/pipelineTemplates";
import { freeWorktree } from "../src/main/handlers";
import type { NewSessionRequest, PlanRequest, SessionInfo } from "../src/shared/types";
import { MESSAGE_ROOM_LINE, newWire, ROOM_LINE, ROOMS_STARTING, type Wire, type WireChange, type WireReply, type WireState } from "../src/shared/wires";
import { askAs, askRaw, startServer, testLaunch } from "./mcpClient";
import { tempDir } from "./helpers";

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, title: id, ticketTitle: null, repoPath: `/code/${id}`, branch: "b", taskGroup: "5038", status: "idle", agent: "claude", cwd: `/w/${id}`, kind: "work", ...over }) as SessionInfo;

const asRoot = process.getuid?.() === 0;

/** A landscape.json of this version holding `wires` as its book. */
const v3File = (wires: unknown) => JSON.stringify({ v: 3, workspaces: {}, areas: {}, stacks: {}, ghosts: {}, tools: {}, cards: {}, wires });

function setup(opts: { rooms?: Record<string, string>; takenOver?: Record<string, string>; wires?: unknown; newId?: () => string } = {}) {
  const dir = tempDir("wires");
  const file = path.join(dir, "landscape.json");
  if (opts.wires !== undefined) fs.writeFileSync(file, v3File(opts.wires));
  const changes: WireChange[] = [];
  const logged: string[] = [];
  const log = (context: string, err: unknown) => void logged.push(`${context}: ${err instanceof Error ? err.message : String(err)}`);
  const store = new LandscapeStore({ file, emit: () => {}, emitWires: (c) => changes.push(c), log });
  const running = [session("a"), session("b"), session("c"), session("term", { shell: true, cwd: "/w/a" }), session("brief", { debrief: true }), session("helpdesk", { role: "tasks", repoPath: null, taskGroup: "Helpdesk" }), session("gone", { status: "dead" })];
  const closed = [session("old"), session("ghost")];
  const planned: SessionInfo[] = [];
  const rooms = { ...opts.rooms };
  const takenOver = { ...opts.takenOver };
  const service = new WireService({
    store,
    sessions: { list: () => running, resumable: () => closed, planned: () => planned },
    roomOf: (id) => rooms[id] ?? null,
    takenOver: (id) => takenOver[id] ?? null,
    log,
    ...(opts.newId ? { newId: opts.newId } : {}),
  });
  store.update({ ghosts: { ghost: { title: "ghost", agent: "claude", cwd: "/w/ghost", repoPath: null, placement: { x: 0, y: 0, w: 8, h: 8 }, group: "5038", closedAt: "2026-11-01T00:00:00.000Z" } } });
  store.flush();
  return { dir, file, store, service, running, closed, planned, rooms, takenOver, changes, logged };
}
const made = (r: WireReply): { state: WireState; id: string } => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r as { state: WireState; id: string };
};
const refusal = (r: WireReply) => ("refused" in r ? r.refused : `not refused: ${JSON.stringify(r)}`);
const onDisk = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

describe("making a wire", () => {
  it("saves it with its defaults, tells the windows, and answers its id", () => {
    const { service, file, changes } = setup();
    const { id, state } = made(service.add("a", "b", "handoff"));
    expect(state.book!.links[id]).toMatchObject({ from: "a", to: "b", type: "handoff", when: "finished", gate: "ask" });
    expect(onDisk(file).wires.links[id]).toEqual(state.book!.links[id]);
    expect(changes.at(-1)).toEqual(state);
  });
  it("takes settings with it, the same rules holding", () => {
    const { service, rooms } = setup();
    const { id, state } = made(service.add("a", "b", "feedback", { limit: 5, template: "{summary}" }));
    expect(state.book!.links[id]).toMatchObject({ rounds: { limit: 5, used: 0 }, template: "{summary}" });
    rooms.a = rooms.c = "R1";
    expect(refusal(service.add("a", "c", "handoff", { gate: "automatic" }))).toMatch(/team room/);
    expect(refusal(service.add("b", "c", "handoff", { rounds: { limit: 1, used: 0 } }))).toMatch(/doesn't know/);
  });
  it.each([
    ["itself", "a", "a", "handoff", /to itself/],
    ["a teammate's session", "a", "r~abc", "handoff", /teammate's session/],
    ["a teammate's workspace as the landscape names it, a wire dropped on it", "a", "r~0f1e2d3c4b5a~n1", "context", /teammate's session/],
    ["a session it doesn't know", "a", "nope", "handoff", /no session "nope"/],
    ["a debrief", "a", "brief", "context", /debrief/],
    ["the Helpdesk tasks workspace, as its target", "a", "helpdesk", "handoff", /Helpdesk tasks workspace/],
    ["the Helpdesk tasks workspace, as its source", "helpdesk", "a", "context", /Helpdesk tasks workspace/],
    ["a terminal for a handoff", "a", "term", "handoff", /is a terminal/],
    ["an unknown type", "a", "b", "sees", /no wire type "sees"/],
  ])("refuses %s, changing nothing", (_what, from, to, type, why) => {
    const { service, file, changes } = setup();
    expect(refusal(service.add(from, to, type))).toMatch(why);
    expect(service.get().book!.links).toEqual({});
    expect(onDisk(file).wires.links).toEqual({});
    expect(changes).toEqual([]);
  });
  it("wires a closed session and a dead one: a wire outlives its pane", () => {
    const { service } = setup();
    expect(made(service.add("a", "ghost", "handoff")).id).toBeTruthy();
    expect(made(service.add("gone", "a", "context")).id).toBeTruthy();
    expect(made(service.add("a", "old", "context")).id).toBeTruthy();
  });
  it("checks a shared worktree by the folder as the filesystem knows it", () => {
    const { service, running, dir } = setup();
    const real = path.join(dir, "real");
    const link = path.join(dir, "link");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    running.find((s) => s.id === "a")!.cwd = real;
    running.find((s) => s.id === "term")!.cwd = link;
    expect(made(service.add("a", "term", "worktree")).id).toBeTruthy();
    // and tells the windows, which can't read the disk, the folders it went by
    expect(service.get().folders).toEqual({ a: fs.realpathSync(real), term: fs.realpathSync(real) });
    running.find((s) => s.id === "term")!.cwd = dir;
    const other = setup();
    expect(refusal(other.service.add("b", "term", "worktree"))).toMatch(/another folder/);
  });
  it("applies the room rule and the take-over when it's made, and goes by them again on the way", () => {
    const { service, rooms, takenOver } = setup();
    rooms.b = "R1";
    expect(refusal(service.add("a", "b", "handoff"))).toMatch(/same team room/);
    rooms.a = "R1";
    expect(made(service.add("a", "b", "handoff")).id).toBeTruthy();
    takenOver.b = takenOver.c = "it continues on Nick's laptop";
    expect(refusal(service.add("b", "a", "context"))).toMatch(/continues on Nick's laptop/);
    // across the line the room rule comes first, so nothing about the far end is said
    expect(refusal(service.add("a", "c", "context"))).toBe(ROOM_LINE);
  });
});

describe("a next step (Add next step)", () => {
  /** setup()'s, with `plan` making a not-started step as SessionManager.plan would and `forget` letting it go. */
  function steps(opts: Parameters<typeof setup>[0] = {}) {
    const t = setup(opts);
    let n = 0;
    const plan = vi.fn((req: PlanRequest) => {
      const s = session(`p${++n}`, { title: req.title, taskGroup: req.taskGroup, planned: { worktree: req.worktree } });
      t.planned.push(s);
      return s;
    });
    const forget = vi.fn((id: string) => void t.planned.splice(t.planned.findIndex((s) => s.id === id), 1));
    const req = (after: string): PlanRequest => ({ after, title: "Tester", agent: "claude", repoPath: null, worktree: true, taskGroup: "5038" });
    return { ...t, plan, forget, req };
  }

  it("makes the step, then a handoff into it, saved", () => {
    const t = steps();
    const r = t.service.addStep(t.req("a"), t);
    expect(r.info).toMatchObject({ id: "p1", title: "Tester" });
    expect(onDisk(t.file).wires.links[r.wire]).toMatchObject({ from: "a", to: "p1", type: "handoff", gate: "ask" });
    expect(t.forget).not.toHaveBeenCalled();
  });

  it("is refused before any step is made after a terminal, a debrief, the Helpdesk tasks workspace or one taken over", () => {
    const t = steps({ takenOver: { c: "“c” continues on Nick's laptop" } });
    expect(() => t.service.addStep(t.req("term"), t)).toThrow(/is a terminal/);
    expect(() => t.service.addStep(t.req("brief"), t)).toThrow(/debrief/);
    expect(() => t.service.addStep(t.req("helpdesk"), t)).toThrow(/Helpdesk tasks workspace/);
    expect(() => t.service.addStep(t.req("c"), t)).toThrow(/continues on Nick's laptop/);
    expect(() => t.service.addStep(t.req("nobody"), t)).toThrow(/no session "nobody"/);
    expect(t.plan).not.toHaveBeenCalled();
    expect(t.planned).toEqual([]);
  });

  it("lets the step go when its wire is refused once it's made, saying why", () => {
    const t = steps();
    // made in another room than the one it follows: the handoff can't cross
    t.plan.mockImplementationOnce((req: PlanRequest) => {
      const s = session("p9", { title: req.title, planned: { worktree: true } });
      t.planned.push(s);
      t.rooms.p9 = "R1";
      return s;
    });
    expect(() => t.service.addStep(t.req("a"), t)).toThrow(/same team room/);
    expect(t.forget).toHaveBeenCalledWith("p9");
    expect(t.planned).toEqual([]);
    expect(Object.keys(onDisk(t.file).wires?.links ?? {})).toEqual([]);
  });

  it("says both the wire's refusal and that the step stays when it can't be forgotten, and logs it", () => {
    const t = steps();
    t.plan.mockImplementationOnce((req: PlanRequest) => {
      const s = session("p9", { title: req.title, planned: { worktree: true } });
      t.planned.push(s);
      t.rooms.p9 = "R1";
      return s;
    });
    t.forget.mockImplementationOnce(() => {
      throw new Error("state.json couldn't be written");
    });
    expect(() => t.service.addStep(t.req("a"), t)).toThrow(
      `${ROOM_LINE} “Tester” was made, and couldn't be taken back, so it's there with no wire into it: forget it from its menu (state.json couldn't be written)`,
    );
    expect(t.planned.map((s) => s.id)).toEqual(["p9"]);
    expect(t.logged).toContain("wires: not-started step p9 wasn't wired from a, and couldn't be forgotten: state.json couldn't be written");
  });
});

describe("a terminal on its tree", () => {
  /** setup()'s, with `create` making a terminal as main's would (running from then on) and `forget` taking it away. */
  function tree(opts: Parameters<typeof setup>[0] = {}) {
    const t = setup(opts);
    const asked: NewSessionRequest[] = [];
    const forgot: string[] = [];
    let during = () => {};
    const create = async (req: NewSessionRequest) => {
      asked.push(req);
      const made = session(`t${asked.length}`, { shell: true, agent: undefined, title: req.title!, cwd: req.cwd!, repoPath: req.repoPath, branch: req.branchName ?? null, taskGroup: req.taskGroup ?? null });
      t.running.push(made);
      during();
      return made;
    };
    const forget = (id: string) => {
      forgot.push(id);
      t.running.splice(t.running.findIndex((x) => x.id === id), 1);
    };
    const agent = (id: string) => t.running.find((x) => x.id === id)!;
    return { ...t, asked, forgot, agent, d: { create, forget }, meanwhile: (f: () => void) => (during = f) };
  }

  it("starts in the agent's folder and group, on its branch, and is wired to it there", async () => {
    const { service, file, asked, agent, d } = tree();
    agent("a").ticketTitle = "Donor export";
    const t = await service.addTerminal(agent("a"), d);
    expect(asked).toEqual([{ repoPath: "/code/a", cwd: "/w/a", branchName: "b", useWorktree: false, taskGroup: "5038", shell: true, title: "Donor export · terminal" }]);
    expect(Object.values(onDisk(file).wires.links)).toEqual([expect.objectContaining({ from: "a", to: t.id, type: "worktree" })]);
    expect(service.onTree(t.id)).toBe(true);
    expect(service.onTree("a")).toBe(false);
  });

  it.each([
    ["a terminal", "term", undefined, /from an agent to a terminal/],
    ["a debrief", "brief", undefined, /debrief/],
    ["the Helpdesk tasks workspace", "helpdesk", undefined, /Helpdesk tasks workspace/],
    ["a copy a teammate took over", "a", { takenOver: { a: "it continues on Nick's laptop" } }, /continues on Nick's laptop/],
  ])("is refused for %s before anything starts", async (_what, from, opts, why) => {
    const { service, agent, asked, changes, d } = tree(opts);
    await expect(service.addTerminal(agent(from), d)).rejects.toThrow(why);
    expect(asked).toEqual([]);
    expect(changes).toEqual([]);
  });

  it.skipIf(asRoot)("is refused before it starts while the book can't be written", async () => {
    const { service, file, agent, asked, d } = tree();
    fs.chmodSync(file, 0o444);
    try {
      await expect(service.addTerminal(agent("a"), d)).rejects.toThrow(/read-only/);
    } finally {
      fs.chmodSync(file, 0o644);
    }
    expect(asked).toEqual([]);
  });

  it("is stopped and forgotten when its wire is refused once it has started, saying why", async () => {
    const { service, agent, takenOver, forgot, running, d, meanwhile } = tree();
    meanwhile(() => (takenOver.a = "it continues on Nick's laptop"));
    await expect(service.addTerminal(agent("a"), d)).rejects.toThrow(/continues on Nick's laptop/);
    expect(forgot).toEqual(["t1"]);
    expect(running.some((x) => x.id === "t1")).toBe(false);
    expect(service.get().book!.links).toEqual({});
  });

  it("wires an existing terminal only in its agent's own folder, as the filesystem resolves it", () => {
    const { service, agent, dir } = tree();
    const wt = path.join(dir, "wt");
    const other = path.join(dir, "wt-other");
    fs.mkdirSync(path.join(other, "src"), { recursive: true });
    fs.mkdirSync(wt);
    fs.symlinkSync(other, path.join(dir, "wt-link"));
    agent("a").cwd = wt;
    // a link that reads like a worktree's, to another one
    agent("term").cwd = path.join(dir, "wt-link");
    expect(refusal(service.add("a", "term", "worktree"))).toMatch(/runs in another folder/);
    // a folder inside the agent's isn't the agent's
    agent("a").cwd = path.join(dir, "wt-link");
    agent("term").cwd = path.join(other, "src");
    expect(refusal(service.add("a", "term", "worktree"))).toMatch(/runs in another folder/);
    // the agent through the link and the terminal in the folder it names are one folder
    agent("term").cwd = other;
    expect(made(service.add("a", "term", "worktree")).id).toBeTruthy();
  });
});

describe("a worktree's cleanup", () => {
  /** setup()'s, with a worktree at `wt` its agent `a` was closed in, as the close dialog closes it before cleaning up. */
  function worktree(opts: Parameters<typeof setup>[0] = {}) {
    const t = setup(opts);
    const wt = path.join(t.dir, "wt");
    fs.mkdirSync(wt);
    const at = (id: string, over: Partial<SessionInfo>) => Object.assign(t.running.find((x) => x.id === id)!, { cwd: wt, ...over });
    at("a", {});
    at("term", {});
    const closed: string[] = [];
    const free = (folder = wt) => freeWorktree(folder, { sessions: t.running, onTree: (id) => t.service.onTree(id), close: (id) => closed.push(id) });
    return { ...t, wt, at, closed, free };
  }

  it("closes the terminals on its tree first, however its path is spelled; one that has exited is left as it is", () => {
    const { service, running, at, closed, free, wt, dir } = worktree();
    made(service.add("a", "term", "worktree"));
    at("a", { status: "dead" });
    running.push(session("old-term", { shell: true, cwd: wt, status: "dead" }));
    fs.symlinkSync(wt, path.join(dir, "wt-link"));
    free(path.join(dir, "wt-link"));
    expect(closed).toEqual(["term"]);
  });

  it("is still refused by any other session there, closing nothing: the agent, a terminal not on its tree, a companion", () => {
    const { service, running, at, closed, free, wt } = worktree();
    const { id } = made(service.add("a", "term", "worktree"));
    expect(() => free()).toThrow(`"a" is still running in that worktree — close it first`);
    at("a", { status: "dead" });
    running.push(session("dev", { shell: true, cwd: wt, title: "Dev server" }));
    expect(() => free()).toThrow(`"Dev server" is still running in that worktree`);
    running.pop();
    running.push(session("review", { cwd: wt, ticketTitle: "Review · Donor export" }));
    expect(() => free()).toThrow(`"Review · Donor export" is still running in that worktree`);
    running.pop();
    // its wire gone, it's a terminal there like any other
    made(service.remove(id));
    expect(() => free()).toThrow(`"term" is still running in that worktree`);
    expect(closed).toEqual([]);
  });

  it("goes by the session as well as the book: an agent a book names as a worktree wire's terminal, or a terminal at the end of another kind, still holds it", () => {
    const wires = { wv: 1, links: { odd: { from: "a", to: "b", type: "worktree", when: "manual", gate: "ask", createdAt: 1 }, other: { from: "a", to: "term", type: "context", when: "manual", gate: "ask", createdAt: 2 } }, notes: {} };
    const { at, closed, free } = worktree({ wires });
    at("a", { status: "dead" });
    at("b", {});
    expect(() => free()).toThrow(`"b" is still running in that worktree`);
    at("b", { status: "dead" });
    expect(() => free()).toThrow(`"term" is still running in that worktree`);
    expect(closed).toEqual([]);
  });
});

describe("a wire's settings", () => {
  it("change what a person can change, and say when there's no such wire", () => {
    const { service, file } = setup();
    const { id } = made(service.add("a", "b", "feedback"));
    const r = made(service.set(id, { gate: "automatic", limit: 7, files: ["x.txt"] }) as any);
    expect(r.state.book!.links[id]).toMatchObject({ gate: "automatic", rounds: { limit: 7, used: 0 }, files: ["x.txt"] });
    expect(onDisk(file).wires.links[id]).toMatchObject({ gate: "automatic" });
    expect(refusal(service.set("nope", { gate: "ask" }))).toMatch(/no wire "nope"/);
  });
  it("can't change what it has counted, holds or delivered, or its ends", () => {
    const { service } = setup();
    const { id } = made(service.add("a", "b", "feedback"));
    for (const raw of [{ rounds: { limit: 9, used: 0 } }, { used: 0 }, { pending: { id: "p", body: "b", at: 1, flags: [] } }, { delivery: { id: "p", state: "sent", at: 1 } }, { from: "c" }, { to: "c" }, { type: "handoff" }]) {
      expect(refusal(service.set(id, raw)), JSON.stringify(raw)).toMatch(/doesn't know/);
    }
  });
  it("refuses automatic once the wire's in a room", () => {
    const { service, rooms } = setup();
    const { id } = made(service.add("a", "b", "handoff"));
    rooms.a = rooms.b = "R1";
    expect(refusal(service.set(id, { gate: "automatic" }))).toMatch(/team room/);
  });
  it("doesn't count or write a change that changes nothing", () => {
    const { service, changes } = setup();
    const { id } = made(service.add("a", "b", "handoff"));
    const sent = changes.length;
    made(service.set(id, { gate: "ask" }) as any);
    expect(changes.length).toBe(sent);
  });
});

describe("removing and restoring a wire", () => {
  it("restores the record whole, counter and waiting text included", () => {
    const { service, store } = setup();
    const { id } = made(service.add("a", "b", "feedback"));
    const counted: Partial<Wire> = { rounds: { limit: 3, used: 2 }, pending: { id: "p", body: "go", at: 1, flags: [] } };
    store.editWires((book) => ({ book: { ...book, links: { ...book.links, [id]: { ...book.links[id], ...counted } } } }));
    const before = service.get().book!.links[id];
    expect(made(service.remove(id) as any).state.book!.links).toEqual({});
    expect(made(service.restore(id) as any).state.book!.links[id]).toEqual(before);
  });
  it("restores only what it removed: a window has no way to supply the record, or to restore twice", () => {
    const { service } = setup();
    expect(refusal(service.restore("nope"))).toMatch(/can't be restored/);
    const { id } = made(service.add("a", "b", "handoff"));
    service.remove(id);
    made(service.restore(id) as any);
    expect(refusal(service.restore(id))).toMatch(/can't be restored/);
  });
  it("won't restore what the rules refuse now, and keeps it to try again", () => {
    const { service, rooms } = setup();
    const { id } = made(service.add("a", "b", "feedback"));
    service.remove(id);
    made(service.add("b", "a", "feedback"));
    expect(refusal(service.restore(id))).toMatch(/feedback wire already/);
    const other = setup();
    const w = made(other.service.add("a", "b", "handoff")).id;
    other.service.remove(w);
    other.rooms.a = "R1";
    expect(refusal(other.service.restore(w))).toMatch(/same team room/);
    delete other.rooms.a;
    expect(made(other.service.restore(w) as any).state.book!.links[w]).toBeTruthy();
    void rooms;
  });
  it("won't restore a wire to a session forgotten since", () => {
    const { service, closed } = setup();
    const { id } = made(service.add("a", "old", "context"));
    service.remove(id);
    closed.splice(closed.findIndex((s) => s.id === "old"), 1);
    expect(refusal(service.restore(id))).toMatch(/no session "old"/);
  });
  it("says when there's nothing to remove", () => {
    expect(refusal(setup().service.remove("nope"))).toMatch(/no wire "nope"/);
  });
  it("won't restore over a wire made since under the same id", () => {
    const ids = ["w1", "w1", "w2"];
    const { service } = setup({ newId: () => ids.shift()! });
    expect(made(service.add("a", "b", "handoff")).id).toBe("w1");
    service.remove("w1");
    expect(made(service.add("a", "c", "context")).id).toBe("w1");
    expect(refusal(service.restore("w1"))).toBe("That wire is there already.");
    expect(service.get().book!.links.w1).toMatchObject({ to: "c" });
  });
  it("keeps the last 50 removed to restore, and no more", () => {
    const { service } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) {
      ids.push(made(service.add("a", "b", "context")).id);
      service.remove(ids[i]);
    }
    expect(refusal(service.restore(ids[0]))).toMatch(/can't be restored any more/);
    expect(made(service.restore(ids[1]) as any).state.book!.links[ids[1]]).toBeTruthy();
  });
  it("counts a wire removed again under an id it had before as the latest removed", () => {
    const next = ["x", ...Array.from({ length: 49 }, (_, i) => `y${i}`), "x", "z"];
    const { service } = setup({ newId: () => next.shift()! });
    for (let i = 0; i < 52; i++) service.remove(made(service.add("a", "b", "context")).id);
    expect(made(service.restore("x") as any).state.book!.links.x).toBeTruthy();
    expect(refusal(service.restore("y0"))).toMatch(/can't be restored any more/);
  });
  it("brings back a wire removed while its message was on the way as unconfirmed, for a person to settle", () => {
    const { service, store } = setup();
    const { id } = made(service.add("a", "b", "handoff"));
    const sent = made(service.add("a", "c", "handoff")).id;
    const deliver = (k: string, state: "pasting" | "sent") =>
      store.editWires((book) => ({ book: { ...book, links: { ...book.links, [k]: { ...book.links[k], delivery: { id: "p", state, at: 1 } } } } }));
    deliver(id, "pasting");
    deliver(sent, "sent");
    service.remove(id);
    service.remove(sent);
    expect(made(service.restore(id) as any).state.book!.links[id].delivery).toEqual({ id: "p", state: "unconfirmed", at: 1, why: "It was being sent when its wire was removed, so it may have reached the other end." });
    expect(made(service.restore(sent) as any).state.book!.links[sent].delivery).toEqual({ id: "p", state: "sent", at: 1 });
  });
});

describe("kept entries", () => {
  /** A book with entries this version can't read: two whose ends and type it can, one it can't at all, and a note. */
  const KEPT = {
    wv: 1,
    links: { odd: { from: "old", to: "a", type: "handoff", gate: "sometimes" }, fb: { from: "a", to: "b", type: "feedback", gate: "sometimes" }, junk: "not a wire" },
    notes: { old: "not a note" },
  };
  it("count as wires already there where their ends and type can be read", () => {
    const { service } = setup({ wires: KEPT });
    expect(service.get().problems.map((p) => p.id).sort()).toEqual(["fb", "junk", "odd", "old"]);
    expect(refusal(service.add("b", "a", "feedback"))).toMatch(/feedback wire already/);
    expect(refusal(service.add("old", "a", "handoff"))).toMatch(/handoff wire between these two already/);
    expect(refusal(service.add("a", "old", "handoff"))).toMatch(/cycle of handoffs/);
    expect(made(service.add("a", "c", "handoff")).id).toBeTruthy();
  });
  it("count as there already when a removed wire would come back beside one", () => {
    const { service, store } = setup({ wires: KEPT });
    // put there past the rules, as a book from before them could hold it
    store.editWires((book) => ({ book: { ...book, links: { ...book.links, live: newWire("b", "a", "feedback", 1) } } }));
    service.remove("live");
    expect(refusal(service.restore("live"))).toMatch(/feedback wire already/);
  });
  it("never give their key to a new wire", () => {
    const ids = ["odd", "junk", "fresh"];
    const { service, file } = setup({ wires: KEPT, newId: () => ids.shift()! });
    expect(made(service.add("a", "c", "context")).id).toBe("fresh");
    expect(onDisk(file).wires.links).toMatchObject({ odd: KEPT.links.odd, junk: "not a wire", fresh: { from: "a", to: "c" } });
  });
  it("go with a session that's forgotten when they name it, logged, and stay gone after a restart", () => {
    const { service, file, logged, changes } = setup({ wires: KEPT });
    service.sessionForgotten("old");
    expect(Object.keys(onDisk(file).wires.links).sort()).toEqual(["fb", "junk"]);
    expect(onDisk(file).wires.notes).toEqual({});
    expect(service.get().problems.map((p) => p.id).sort()).toEqual(["fb", "junk"]);
    expect(changes.at(-1)!.problems.map((p) => p.id).sort()).toEqual(["fb", "junk"]);
    expect(logged).toEqual(
      expect.arrayContaining([
        'landscape: A wire in landscape.json that couldn\'t be read ("odd") named session old, which was forgotten, and went with it.',
        'landscape: A wire note in landscape.json that couldn\'t be read ("old") named session old, which was forgotten, and went with it.',
      ])
    );
    const again = new LandscapeStore({ file, emit: () => {}, log: () => {} });
    expect(again.wires().problems.map((p) => p.id).sort()).toEqual(["fb", "junk"]);
  });
});

describe("a session forgotten", () => {
  it("takes its wires and note with it, naming them to the windows, what was waiting included", () => {
    const { service, store, changes, file } = setup();
    const out = made(service.add("old", "a", "handoff")).id;
    const inn = made(service.add("b", "old", "context")).id;
    const rest = made(service.add("a", "b", "handoff")).id;
    store.editWires((book) => ({ book: { ...book, notes: { old: { hops: 1 }, a: { hops: 0 } }, links: { ...book.links, [out]: { ...book.links[out], pending: { id: "p", body: "go", at: 1, flags: [] } } } } }));
    service.sessionForgotten("old");
    expect(Object.keys(service.get().book!.links)).toEqual([rest]);
    expect(Object.keys(service.get().book!.notes)).toEqual(["a"]);
    expect(changes.at(-1)!.dropped!.map((d) => d.id).sort()).toEqual([inn, out].sort());
    expect(changes.at(-1)!.dropped!.find((d) => d.id === out)!.wire.pending!.body).toBe("go");
    expect(onDisk(file).wires.links[out]).toBeUndefined();
  });
  it("writes nothing and tells nobody when it had no wires", () => {
    const { service, changes } = setup();
    expect(service.sessionForgotten("old")).toBeNull();
    expect(changes).toEqual([]);
  });
  it.skipIf(asRoot)("is logged when its wires can't be dropped now, and they show as blocked, their end gone", () => {
    const { service, file, closed, logged, store } = setup();
    const { id } = made(service.add("a", "old", "handoff"));
    closed.splice(closed.findIndex((s) => s.id === "old"), 1);
    fs.chmodSync(file, 0o444);
    let why: string | null = null;
    try {
      why = service.sessionForgotten("old");
    } finally {
      fs.chmodSync(file, 0o644);
    }
    expect(logged.join()).toMatch(/couldn't drop the wires of forgotten session old.*read-only/);
    // and answered, for a caller that says what it left
    expect(why).toMatch(/read-only/);
    expect(store.wires().book!.links[id]).toBeTruthy();
    const r = service.linksFor(session("a")) as { result: any };
    expect(r.result.links[0]).toMatchObject({ wire: id, state: "blocked", other: { id: "old", gone: true }, why: expect.stringMatching(/no session "old"/) });
  });
});

describe("Start fresh's rekey", () => {
  it("moves wires, both directions, and the note, keeping counters and what's waiting", () => {
    const { service, store, file } = setup();
    const out = made(service.add("old", "a", "feedback")).id;
    const inn = made(service.add("b", "old", "context")).id;
    store.editWires((book) => ({ book: { ...book, notes: { old: { hops: 2 } }, links: { ...book.links, [out]: { ...book.links[out], rounds: { limit: 3, used: 2 }, pending: { id: "p", body: "go", at: 1, flags: [] } } } } }));
    const { state } = made(service.rekey("old", "c") as any);
    expect(state.book!.links[out]).toMatchObject({ from: "c", to: "a", rounds: { used: 2 }, pending: { id: "p" } });
    expect(state.book!.links[inn]).toMatchObject({ from: "b", to: "c" });
    expect(state.book!.notes).toEqual({ c: { hops: 2 } });
    expect(onDisk(file).wires.links[out].from).toBe("c");
  });
  it("leaves them there for a forget that follows, which then has nothing to drop", () => {
    const { service, changes } = setup();
    const { id } = made(service.add("old", "a", "handoff"));
    made(service.rekey("old", "c") as any);
    const sent = changes.length;
    service.sessionForgotten("old");
    expect(changes.length).toBe(sent);
    expect(service.get().book!.links[id].from).toBe("c");
  });
  it("moves all or none: it refuses what would break the rules, and changes nothing", () => {
    const { service } = setup();
    made(service.add("old", "a", "handoff"));
    const before = service.get().book;
    expect(refusal(service.rekey("old", "a"))).toMatch(/to itself/);
    expect(refusal(service.rekey("old", "nope"))).toMatch(/no session "nope"/);
    expect(refusal(service.rekey("old", "term"))).toMatch(/same kind/);
    expect(service.get().book).toEqual(before);
  });
  it("refuses a move that would make a cycle of handoffs, or a second feedback wire for a pair", () => {
    const { service } = setup();
    made(service.add("old", "a", "handoff"));
    made(service.add("a", "c", "handoff"));
    expect(refusal(service.rekey("old", "c"))).toMatch(/cycle/);
    const other = setup();
    made(other.service.add("old", "a", "feedback"));
    made(other.service.add("a", "c", "feedback"));
    expect(refusal(other.service.rekey("old", "c"))).toMatch(/feedback wire already/);
  });
  it("moves a wire that's blocked now, since moving it changes nothing about why", () => {
    const { service, rooms } = setup();
    const { id } = made(service.add("old", "a", "handoff"));
    rooms.a = "R1";
    expect(made(service.rekey("old", "c") as any).state.book!.links[id].from).toBe("c");
  });
  it("refuses a move the rules would newly refuse: onto a debrief, or across a room's line", () => {
    const { service, rooms } = setup();
    made(service.add("old", "a", "handoff"));
    const before = service.get().book;
    expect(refusal(service.rekey("old", "brief"))).toMatch(/debrief interview/);
    rooms.c = "R1";
    expect(refusal(service.rekey("old", "c"))).toBe(ROOM_LINE);
    expect(service.get().book).toEqual(before);
  });
  it("counts a kept wire it can read as there already", () => {
    const { service } = setup({ wires: { wv: 1, links: { odd: { from: "a", to: "c", type: "feedback", gate: "sometimes" } }, notes: {} } });
    made(service.add("old", "a", "feedback"));
    expect(refusal(service.rekey("old", "c"))).toMatch(/feedback wire already/);
  });
  it("refuses a session taken over, as it stays where it is", () => {
    const { service, takenOver } = setup();
    made(service.add("old", "a", "handoff"));
    takenOver.old = "“old” continues on Nick's laptop";
    expect(refusal(service.rekey("old", "c"))).toMatch(/continues on Nick's laptop/);
  });
  it("refuses while one of the wires is sending", () => {
    const { service, store } = setup();
    const { id } = made(service.add("a", "old", "handoff"));
    store.editWires((book) => ({ book: { ...book, links: { ...book.links, [id]: { ...book.links[id], delivery: { id: "p", state: "pasting", at: 1 } } } } }));
    expect(refusal(service.rekey("old", "c"))).toMatch(/sending right now/);
  });
  it("is nothing to do for a session with no wires", () => {
    const { service, changes } = setup();
    made(service.rekey("old", "c") as any);
    made(service.rekey("a", "a") as any);
    expect(changes).toEqual([]);
  });
});

describe("the wires:* calls when the file can't be used", () => {
  it.skipIf(asRoot)("refuse saying so, and never answer as if there were no wires", () => {
    const { service, file, store } = setup();
    made(service.add("a", "b", "handoff"));
    fs.chmodSync(file, 0o000);
    const reread = new LandscapeStore({ file, emit: () => {}, log: () => {} });
    const blind = new WireService({ store: reread, sessions: { list: () => [session("a"), session("b")], resumable: () => [] }, roomOf: () => null, takenOver: () => null, log: () => {} });
    try {
      expect(blind.get()).toMatchObject({ book: null, refused: expect.stringMatching(/can't be read or changed right now/) });
      for (const r of [blind.add("a", "b", "context"), blind.set("x", { gate: "ask" }), blind.remove("x"), blind.rekey("a", "b"), blind.restore("x")]) expect("refused" in r).toBe(true);
      expect(blind.add("a", "b", "context")).toEqual({ refused: expect.stringMatching(/EACCES/) });
      const links = blind.linksFor(session("a"));
      expect(links).toEqual({ error: expect.stringMatching(/can't be read or changed right now.*EACCES/) });
      expect(JSON.stringify(links)).not.toMatch(/no wires/i);
    } finally {
      fs.chmodSync(file, 0o644);
    }
    expect(store.wires().book).toBeTruthy();
  });
  it("refuse a book this version can't read, as list_links does", () => {
    const dir = tempDir("wires");
    const file = path.join(dir, "landscape.json");
    fs.writeFileSync(file, JSON.stringify({ v: 3, workspaces: {}, areas: {}, stacks: {}, ghosts: {}, tools: {}, cards: {}, wires: { wv: 99, links: {}, notes: {} } }));
    const blind = new WireService({ store: new LandscapeStore({ file, emit: () => {}, log: () => {} }), sessions: { list: () => [session("a"), session("b")], resumable: () => [] }, roomOf: () => null, takenOver: () => null, log: () => {} });
    expect(blind.get()).toMatchObject({ book: null, refused: expect.stringMatching(/newer Mockingbird/) });
    expect(blind.linksFor(session("a"))).toEqual({ error: expect.stringMatching(/newer Mockingbird/) });
    expect(refusal(blind.add("a", "b", "handoff"))).toMatch(/newer Mockingbird/);
  });
});

describe("list_links", () => {
  it("says there are none when there are none, in so many words", () => {
    expect(setup().service.linksFor(session("a"))).toEqual({ result: { you: { id: "a", title: "a" }, links: [], note: "This workspace has no wires." } });
  });
  it("lists only the caller's wires, each with its direction, type and state, in the order they were made", () => {
    // the second id reads as an integer, which the book's own key order puts first
    const ids = ["ab12cd34", "12345678", "cd34ef56"];
    const { service } = setup({ newId: () => ids.shift()! });
    const out = made(service.add("a", "b", "handoff")).id;
    const inn = made(service.add("c", "a", "context")).id;
    made(service.add("b", "c", "handoff"));
    expect(Object.keys(service.get().book!.links)[0]).toBe(inn);
    const r = service.linksFor(session("a")) as { result: any };
    expect(r.result.links).toEqual([
      { wire: out, direction: "out", type: "handoff", other: { id: "b", title: "b", where: "running" }, state: "idle" },
      { wire: inn, direction: "in", type: "context", other: { id: "c", title: "c", where: "running" }, state: "idle" },
    ]);
    expect(r.result).not.toHaveProperty("note");
  });
  it("names nothing across a room's line but the far end's id, from either side", () => {
    const { service, rooms, running } = setup();
    running.find((s) => s.id === "b")!.ticketTitle = "Private plan";
    const ab = made(service.add("a", "b", "handoff")).id;
    const ac = made(service.add("a", "c", "context")).id;
    rooms.b = "R1";
    const mine = (service.linksFor(session("a")) as { result: any }).result.links;
    expect(mine.find((l: any) => l.wire === ab)).toEqual({ wire: ab, direction: "out", type: "handoff", other: { id: "b", outside: "in a team room" }, state: "blocked", why: ROOM_LINE });
    expect(mine.find((l: any) => l.wire === ac).other).toEqual({ id: "c", title: "c", where: "running" });
    expect(JSON.stringify(mine)).not.toContain("Private plan");
    const theirs = (service.linksFor(session("b", { ticketTitle: "Private plan" })) as { result: any }).result.links;
    expect(theirs).toEqual([{ wire: ab, direction: "in", type: "handoff", other: { id: "a", outside: "outside this room" }, state: "blocked", why: ROOM_LINE }]);
    rooms.a = "R2";
    expect((service.linksFor(session("a")) as { result: any }).result.links.find((l: any) => l.wire === ab).other).toEqual({ id: "b", outside: "outside this room" });
    rooms.a = "R1";
    expect((service.linksFor(session("a")) as { result: any }).result.links.find((l: any) => l.wire === ab).other).toEqual({ id: "b", title: "Private plan", where: "running" });
  });
  it("names a wire's state and why, and an end that's closed", () => {
    const { service, rooms } = setup();
    const { id } = made(service.add("a", "ghost", "handoff"));
    made(service.add("a", "b", "context"));
    rooms.b = "R1";
    const { links } = (service.linksFor(session("a")) as { result: any }).result;
    expect(links.find((l: any) => l.wire === id)).toMatchObject({ other: { id: "ghost", where: "closed" }, state: "idle" });
    expect(links.find((l: any) => l.wire !== id)).toMatchObject({ state: "blocked", why: expect.stringMatching(/same team room/) });
  });
  it("says so when some of the book couldn't be read, as those may be the caller's", () => {
    const dir = tempDir("wires");
    const file = path.join(dir, "landscape.json");
    fs.writeFileSync(file, JSON.stringify({ v: 3, workspaces: {}, areas: {}, stacks: {}, ghosts: {}, tools: {}, cards: {}, wires: { wv: 1, links: { bad: { from: "a", to: "b", type: "sees" } }, notes: {} } }));
    const service = new WireService({ store: new LandscapeStore({ file, emit: () => {}, log: () => {} }), sessions: { list: () => [session("a")], resumable: () => [] }, roomOf: () => null, takenOver: () => null, log: () => {} });
    const { result } = service.linksFor(session("a")) as { result: any };
    expect(result.links).toEqual([]);
    expect(result.incomplete).toEqual([expect.stringMatching(/Wire "bad"/)]);
    expect(result).not.toHaveProperty("note");
  });
  it("says wires went aside with a corrupt file, rather than that there are none", () => {
    const dir = tempDir("wires");
    const file = path.join(dir, "landscape.json");
    fs.writeFileSync(file, "not json");
    const service = new WireService({ store: new LandscapeStore({ file, emit: () => {}, log: () => {} }), sessions: { list: () => [session("a")], resumable: () => [] }, roomOf: () => null, takenOver: () => null, log: () => {} });
    const { result } = service.linksFor(session("a")) as { result: any };
    expect(result.incomplete).toEqual([expect.stringMatching(/layout and its wires start over/)]);
    expect(result).not.toHaveProperty("note");
  });
});

describe("list_links through the real MCP server", () => {
  const running = [session("a", { ticketTitle: "Filter orgs" }), session("b"), session("c")];
  const closed: SessionInfo[] = [];
  const sock = mcpLaunch("unused").env.MOCKINGBIRD_SOCK;
  const dir = tempDir("wires");
  const store = new LandscapeStore({ file: path.join(dir, "landscape.json"), emit: () => {}, log: () => {} });
  const service = new WireService({ store, sessions: { list: () => running, resumable: () => closed }, roomOf: () => null, takenOver: () => null, log: () => {} });
  const relay = new Messaging({ list: () => running, deliverAgentMessage: () => "delivered" } as any, () => true, () => {});

  beforeAll(async () => {
    relay.start();
    for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 20));
  });
  afterAll(() => fs.rmSync(sock, { force: true }));

  it("says it isn't ready before the book's registered, never that there are none", async () => {
    expect((await askAs(sock, { from: "a", op: "list_links" })).error).toMatch(/aren't ready yet/);
  });
  it("answers for the token's session alone, whatever a forged `from` says", async () => {
    relay.setWires(service);
    const ab = made(service.add("a", "b", "handoff")).id;
    const bc = made(service.add("b", "c", "context")).id;
    const launch = testLaunch("a");
    const server = startServer(launch);
    try {
      const r = JSON.parse((await server.call("list_links", { from: "b" })).content[0].text);
      expect(r.you).toEqual({ id: "a", title: "Filter orgs" });
      expect(r.links.map((l: any) => l.wire)).toEqual([ab]);
    } finally {
      await server.stop();
      retireMcpLaunch(launch);
    }
    expect((await askAs(sock, { from: "c", op: "list_links" })).result.links.map((l: any) => l.wire)).toEqual([bc]);
    expect((await askRaw(sock, JSON.stringify({ op: "list_links", from: "a" }))).error).toMatch(/^Mockingbird doesn.t recognise this tool server/);
  });
  it("has no tool that writes a wire", async () => {
    const launch = testLaunch("a");
    const server = startServer(launch);
    try {
      const names: string[] = (await server.request("tools/list")).result.tools.map((t: any) => t.name);
      expect(names).toContain("list_links");
      expect(names.filter((n) => /wire|gate|round|link/i.test(n))).toEqual(["list_links"]);
    } finally {
      await server.stop();
      retireMcpLaunch(launch);
    }
    for (const op of ["wires:add", "wires:set", "add_wire", "set_gate"]) expect((await askAs(sock, { from: "a", op })).error, op).toMatch(/Unknown tool/);
  });
  it("keeps send_message and list_sessions to the caller's side of a team room's line, as wires are, and to none while the line can't be seen", async () => {
    let known = false;
    const rooms: Record<string, string | null> = { a: "R1", b: "R1", c: null };
    const lined = new WireService({ store, sessions: { list: () => running, resumable: () => closed }, roomOf: (id) => rooms[id] ?? null, roomsKnown: () => known, takenOver: () => null, log: () => {} });
    relay.setWires(lined);
    try {
      const send = (from: string, to: string) => askAs(sock, { from, op: "send_message", args: { to, message: "hello" } });
      const listed = async (from: string) => (await askAs(sock, { from, op: "list_sessions" })).result;
      expect(await listed("a")).toMatchObject({ sessions: [], note: ROOMS_STARTING });
      expect((await send("a", "b")).error).toBe(ROOMS_STARTING);
      known = true;
      // a room session reaches its own room's sessions only, and a session outside the room none in it
      expect((await listed("a")).sessions.map((s: any) => s.id)).toEqual(["b"]);
      expect(await listed("a")).not.toHaveProperty("note");
      expect((await listed("c")).sessions).toEqual([]);
      expect((await send("a", "c")).error).toBe(MESSAGE_ROOM_LINE);
      expect((await send("c", "a")).error).toBe(MESSAGE_ROOM_LINE);
      expect((await send("a", "b")).result).toMatch(/^Delivered to/);
      // a session that moves out of the room is on the other side from then on
      rooms.b = null;
      expect((await send("a", "b")).error).toBe(MESSAGE_ROOM_LINE);
      expect((await listed("c")).sessions.map((s: any) => s.id)).toEqual(["b"]);
    } finally {
      relay.setWires(service);
    }
  });
});

describe("the token folder", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("is cleared of what an earlier run left when the app starts, and of nothing a live launch needs", () => {
    const launch = testLaunch("a");
    const live = launch.env.MOCKINGBIRD_TOKEN_FILE;
    const stray = path.join(path.dirname(live), "f".repeat(32));
    fs.writeFileSync(stray, "an earlier run's", { mode: 0o600 });
    new Messaging({ list: () => [], deliverAgentMessage: () => "delivered" } as any, () => true, () => {}).start();
    expect(fs.existsSync(stray)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    retireMcpLaunch(launch);
    expect(path.dirname(live)).toBe(path.join(os.homedir(), ".mockingbird", "mcp-tokens"));
  });
});

describe("laying a template out (W9)", () => {
  /** Builder (own worktree) → Reviewer (Builder's folder) → Tester, Reviewer's feedback to Builder, Dev server on Builder's tree. */
  const chainBody = (over: Partial<TemplateBody> = {}): TemplateBody => ({
    startFirst: true,
    steps: [
      { key: "s1", name: "Builder", agent: "codex", model: "gpt-5.5", folder: "new", prompt: "Implement {ticket}." },
      { key: "s2", name: "Reviewer", agent: "claude", folder: { sameAs: "s1" }, prompt: "Review {ticket}." },
      { key: "s3", name: "Tester", agent: "claude", folder: "new", prompt: "" },
      { key: "s4", name: "Dev server", agent: "terminal", folder: { sameAs: "s1" }, prompt: "dotnet watch" },
    ],
    wires: [
      { from: "s1", to: "s2", type: "handoff", when: "finished", gate: "ask" },
      { from: "s2", to: "s1", type: "feedback", when: "finished", gate: "ask", rounds: 3 },
      { from: "s2", to: "s3", type: "handoff", when: "finished", gate: "automatic" },
      { from: "s1", to: "s4", type: "worktree" },
    ],
    ...over,
  });
  const request = (over: Partial<LayOutRequest> = {}): LayOutRequest => ({ name: "Build, review, test", template: chainBody(), ticketId: "5115", ticketTitle: "Stream the donor export", repoPath: "/code/backoffice", base: "dev", area: "5115", ...over });

  /** setup()'s, with the sessions' side of a lay-out as main's is: steps planned, started, forgotten, and a terminal. */
  function laying(opts: Parameters<typeof setup>[0] & { groupRooms?: Record<string, string> } = {}) {
    const t = setup(opts);
    const groupRooms = { ...opts.groupRooms };
    const roomOfGroup = (g: string) => groupRooms[g] ?? null;
    const asked: Parameters<LayOutDeps["planStep"]>[0][] = [];
    const created: NewSessionRequest[] = [];
    let n = 0;
    const planStep = vi.fn((req: Parameters<LayOutDeps["planStep"]>[0]): SessionInfo => {
      asked.push(req);
      const id = `p${++n}`;
      const shares = req.sharesWith ? t.planned.find((s) => s.id === req.sharesWith) : undefined;
      const s = session(id, {
        title: req.title,
        agent: req.agent,
        taskGroup: req.taskGroup,
        repoPath: shares ? shares.repoPath : req.repoPath,
        cwd: shares ? shares.cwd : `/w/${id}`,
        branch: null,
        planned: { worktree: req.worktree, ...(req.sharesWith ? { sharesWith: req.sharesWith } : {}), ...(req.prompt ? { prompt: req.prompt } : {}) },
      });
      const room = roomOfGroup(req.taskGroup ?? "");
      if (room) t.rooms[id] = room;
      t.planned.push(s);
      return s;
    });
    const forget = vi.fn((id: string): string | null => {
      for (const list of [t.planned, t.running]) if (list.some((s) => s.id === id)) list.splice(list.findIndex((s) => s.id === id), 1);
      return t.service.sessionForgotten(id);
    });
    const start = vi.fn(async (id: string, _title?: string | null): Promise<StepStarted> => {
      const p = t.planned.splice(t.planned.findIndex((s) => s.id === id), 1)[0];
      const { planned: _step, ...rest } = p;
      const s = { ...rest, status: "working", branch: `5115-${id}` } as SessionInfo;
      t.running.push(s);
      return { info: s, stageWhy: null };
    });
    const create = async (req: NewSessionRequest) => {
      created.push(req);
      const m = session(`t${created.length}`, { shell: true, agent: undefined, title: req.title!, cwd: req.cwd!, repoPath: req.repoPath, branch: req.branchName ?? null, taskGroup: req.taskGroup ?? null });
      const room = roomOfGroup(req.taskGroup ?? "");
      if (room) t.rooms[m.id] = room;
      t.running.push(m);
      return m;
    };
    const addTerminal = vi.fn((agent: SessionInfo, as: { title: string; command: string }) => t.service.addTerminal(agent, { create, forget }, as));
    const d: LayOutDeps = { planStep, forget, start, addTerminal, roomOfGroup };
    const links = () => (Object.values(onDisk(t.file).wires?.links ?? {}) as Wire[]).sort((a, b) => a.createdAt - b.createdAt);
    return { ...t, groupRooms, asked, created, d, planStep, forget, start, addTerminal, links };
  }

  it("makes its steps not started, joined by its wires, starts the first with its terminal on its tree, all in its area", async () => {
    const t = laying();
    const r = await t.service.layOut(request(), t.d);
    // each step planned in the area, on the ticket, its prompt's {ticket} filled in; the ticket's title in no step's name
    expect(t.asked).toEqual([
      { title: "Builder", agent: "codex", model: "gpt-5.5", repoPath: "/code/backoffice", worktree: true, base: "dev", taskGroup: "5115", ticketId: "5115", prompt: "Implement #5115 (its title, the ticket's own words: \"Stream the donor export\")." },
      { title: "Reviewer", agent: "claude", repoPath: null, worktree: false, taskGroup: "5115", ticketId: "5115", prompt: "Review #5115 (its title, the ticket's own words: \"Stream the donor export\").", sharesWith: "p1" },
      { title: "Tester", agent: "claude", repoPath: "/code/backoffice", worktree: true, base: "dev", taskGroup: "5115", ticketId: "5115" },
    ]);
    expect(r).toEqual({ steps: [{ key: "s1", id: "p1", title: "Builder" }, { key: "s2", id: "p2", title: "Reviewer" }, { key: "s3", id: "p3", title: "Tester" }, { key: "s4", id: "t1", title: "Dev server" }], wires: [expect.any(String), expect.any(String), expect.any(String)], started: "p1", notes: [] });
    expect(t.start).toHaveBeenCalledWith("p1", "Stream the donor export");
    // its terminal: on Builder's tree as it started, running its command
    expect(t.created).toEqual([expect.objectContaining({ shell: true, title: "Dev server", initialPrompt: "dotnet watch", cwd: "/w/p1", taskGroup: "5115" })]);
    expect(t.links().map((w) => [w.from, w.to, w.type, w.gate, w.rounds?.limit ?? null])).toEqual([
      ["p1", "p2", "handoff", "ask", null],
      ["p2", "p1", "feedback", "ask", 3],
      ["p2", "p3", "handoff", "automatic", null],
      ["p1", "t1", "worktree", "ask", null],
    ]);
    expect(t.forget).not.toHaveBeenCalled();
  });

  it("makes every gate ask in a team room's area, its steps made in the room, and says so", async () => {
    const t = laying({ groupRooms: { "5110": "R1" } });
    const r = await t.service.layOut(request({ ticketId: "5110", area: "5110" }), t.d);
    expect(t.links().filter((w) => w.type === "handoff").map((w) => w.gate)).toEqual(["ask", "ask"]);
    expect(r.notes).toEqual(["In a team room's area every gate asks, so its automatic gate was laid out asking."]);
    expect(t.asked.every((a) => a.taskGroup === "5110")).toBe(true);
  });

  it("leaves every step waiting when the first doesn't start, and makes no terminal: none can wait", async () => {
    const t = laying();
    const r = await t.service.layOut(request({ template: chainBody({ startFirst: false }) }), t.d);
    expect(t.start).not.toHaveBeenCalled();
    expect(t.addTerminal).not.toHaveBeenCalled();
    expect(r.started).toBeNull();
    expect(r.steps.map((s) => s.title)).toEqual(["Builder", "Reviewer", "Tester"]);
    expect(r.notes).toEqual([expect.stringMatching(/^“Dev server” isn't laid out: a terminal takes no handoff/)]);
    expect(t.links().map((w) => w.type)).toEqual(["handoff", "feedback", "handoff"]);
  });

  it.each<[string, Partial<LayOutRequest>, RegExp]>([
    ["a template that isn't one", { template: { ...chainBody(), steps: [] } }, /“Build, review, test” can't be laid out: It has no steps/],
    ["a field this version doesn't know", { template: { ...chainBody(), colour: "teal" } as TemplateBody }, /doesn't know \(colour\)/],
    ["no area", { area: " " }, /Choose the area/],
    ["a stack for its area", { area: "5115/api" }, /an area, not a stack/],
    ["worktrees with no repo", { repoPath: null }, /“Builder”, “Tester” work in a worktree of their own, which needs a repo/],
    ["a PR-merged wire with no ticket", { ticketId: null, template: chainBody({ wires: [...chainBody().wires.slice(0, 2), { from: "s1", to: "s3", type: "handoff", when: "pr-merged" }, chainBody().wires[3]] }) }, /pull request merges.*no ticket is chosen/],
  ])("is refused whole for %s, before any step is made", async (_what, over, re) => {
    const t = laying();
    await expect(t.service.layOut(request(over), t.d)).rejects.toThrow(re);
    expect(t.planStep).not.toHaveBeenCalled();
    expect(t.links()).toEqual([]);
  });

  it("takes back every step made when one is then refused: nothing is left", async () => {
    const t = laying();
    t.planStep.mockImplementationOnce(t.planStep.getMockImplementation()!).mockImplementationOnce(() => {
      throw new Error("/code/backoffice isn't a git repo");
    });
    await expect(t.service.layOut(request(), t.d)).rejects.toThrow("Couldn't lay out “Build, review, test”: “Reviewer” was refused: /code/backoffice isn't a git repo. Nothing was left.");
    expect(t.forget).toHaveBeenCalledWith("p1");
    expect(t.planned).toEqual([]);
    expect(t.start).not.toHaveBeenCalled();
  });

  it("says so when a step taken back leaves its wires behind, rather than that nothing was left", async () => {
    const t = laying();
    t.planStep.mockImplementationOnce(t.planStep.getMockImplementation()!).mockImplementationOnce(() => {
      throw new Error("/code/backoffice isn't a git repo");
    });
    t.forget.mockImplementationOnce(((impl) => (id: string): string | null => {
      impl(id);
      return "landscape.json is read-only";
    })(t.forget.getMockImplementation()!));
    const e = await t.service.layOut(request(), t.d).catch((x: unknown) => x);
    expect((e as Error).message).toBe(
      "Couldn't lay out “Build, review, test”: “Reviewer” was refused: /code/backoffice isn't a git repo. Its wires couldn't be taken back (landscape.json is read-only): remove them from their right-click."
    );
    // no step left: nothing for its area to be kept for
    expect(e).not.toBeInstanceOf(LayOutLeftError);
  });

  it("takes back its steps and wires when a wire is refused once they're made, naming what couldn't be", async () => {
    const t = laying();
    // Tester made across a team room's line from Reviewer: the handoff into it can't cross
    t.planStep.mockImplementation(((impl) => (req: Parameters<LayOutDeps["planStep"]>[0]) => {
      const s = impl(req);
      if (req.title === "Tester") t.rooms[s.id] = "R1";
      return s;
    })(t.planStep.getMockImplementation()!));
    t.forget.mockImplementation(((impl) => (id: string): string | null => {
      if (id === "p2") throw new Error("sessions.json is read-only");
      return impl(id);
    })(t.forget.getMockImplementation()!));
    const e = await t.service.layOut(request(), t.d).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/^Couldn't lay out “Build, review, test”: Reviewer → Tester was refused: .*team room.*\. “Reviewer” couldn't be taken back: forget it from its menu\.$/);
    // the step left, by id, for its area to be kept for (TemplateLayOuts)
    expect(e).toBeInstanceOf(LayOutLeftError);
    expect((e as LayOutLeftError).left).toEqual(["p2"]);
    expect(t.forget.mock.calls.map((c) => c[0])).toEqual(["p3", "p2", "p1"]);
    expect(t.links().filter((w) => w.from !== "p2" && w.to !== "p2")).toEqual([]);
    expect(t.logged.some((l) => /step p2 couldn't be taken back: sessions.json is read-only/.test(l))).toBe(true);
  });

  it("keeps its steps when the first then fails to start, saying so and what waits on it", async () => {
    const t = laying();
    t.start.mockRejectedValueOnce(new Error("origin/dev isn't there"));
    const r = await t.service.layOut(request(), t.d);
    expect(r.started).toBeNull();
    expect(r.notes).toEqual([
      "“Builder” didn't start: origin/dev isn't there. Its 3 steps are laid out and wait: start it with Start now in its menu.",
      "“Dev server” wasn't made, as it runs on “Builder”'s tree: once that has started, Add terminal on its tree makes one.",
    ]);
    expect(t.addTerminal).not.toHaveBeenCalled();
    expect(t.planned.map((s) => s.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("logs under the step's id what it says once the steps are made: the first not starting", async () => {
    const t = laying();
    t.start.mockRejectedValueOnce(new Error("origin/dev isn't there"));
    await t.service.layOut(request(), t.d);
    expect(t.logged).toContain(
      "wires: laying out “Build, review, test”, session p1: “Builder” didn't start: origin/dev isn't there. Its 3 steps are laid out and wait: start it with Start now in its menu.: origin/dev isn't there"
    );
  });

  /** chainBody with Tester waiting for Builder's PR to merge rather than for Reviewer: a wire made once Builder starts. */
  const prBody = () => chainBody({ wires: [...chainBody().wires.slice(0, 2), { from: "s1", to: "s3", type: "handoff", when: "pr-merged", gate: "ask" }, chainBody().wires[3]] });

  it("says a first step started whose ticket's stage couldn't be moved, and still makes its terminal and its PR-merged wire", async () => {
    const t = laying();
    t.start.mockImplementationOnce(async (id: string) => ({ ...(await t.start.getMockImplementation()!(id)), stageWhy: "#5115 couldn't be moved to Coding (pipeline.json is read-only)" }));
    const r = await t.service.layOut(request({ template: prBody() }), t.d);
    expect(r.started).toBe("p1");
    expect(r.notes).toEqual(["“Builder” started, but #5115 couldn't be moved to Coding (pipeline.json is read-only)."]);
    expect(t.addTerminal).toHaveBeenCalledTimes(1);
    expect(t.links().map((w) => [w.from, w.to, w.type, w.when])).toEqual([
      ["p1", "p2", "handoff", "finished"],
      ["p2", "p1", "feedback", "finished"],
      ["p1", "p3", "handoff", "pr-merged"],
      ["p1", "t1", "worktree", "manual"],
    ]);
  });

  it("logs under the started step's id a terminal that wasn't made on its tree, and a wire refused once it started", async () => {
    const t = laying();
    t.addTerminal.mockRejectedValueOnce(new Error("the pty couldn't be opened"));
    // the started step taken over: the PR-merged wire out of it is refused as it's made
    t.start.mockImplementationOnce(async (id: string) => {
      const r = await t.start.getMockImplementation()!(id);
      t.takenOver[id] = "“Builder” continues on Nick's laptop";
      return r;
    });
    const r = await t.service.layOut(request({ template: prBody() }), t.d);
    expect(r.notes).toEqual(["Builder → Tester wasn't made: “Builder” continues on Nick's laptop", "“Dev server” wasn't made on “Builder”'s tree: the pty couldn't be opened"]);
    expect(t.logged).toContain("wires: laying out “Build, review, test”, session p1: “Dev server” wasn't made on “Builder”'s tree: the pty couldn't be opened: the pty couldn't be opened");
    expect(t.logged).toContain("wires: laying out “Build, review, test”, session p1: Builder → Tester wasn't made: “Builder” continues on Nick's laptop: “Builder” continues on Nick's laptop");
  });

  /**
   * Planner (once) → Coder (once per ticket, its own worktree) → Verifier (once per ticket, in Coder's folder) → Merger
   * (once), Verifier's feedback to Coder, Dev server on each Coder's tree.
   */
  const fanBody = (): TemplateBody => ({
    startFirst: true,
    steps: [
      { key: "plan", name: "Planner", agent: "claude", folder: "new", prompt: "Plan {ticket}." },
      { key: "code", name: "Coder", agent: "codex", folder: "new", prompt: "Implement {ticket}.", perTicket: true },
      { key: "verify", name: "Verifier", agent: "claude", folder: { sameAs: "code" }, prompt: "Verify {ticket}.", perTicket: true },
      { key: "merge", name: "Merger", agent: "claude", folder: "new", prompt: "Merge {ticket}." },
      { key: "dev", name: "Dev server", agent: "terminal", folder: { sameAs: "code" }, prompt: "npm run dev", perTicket: true },
    ],
    wires: [
      { from: "plan", to: "code", type: "handoff" },
      { from: "code", to: "verify", type: "handoff", gate: "automatic" },
      { from: "verify", to: "code", type: "feedback", rounds: 3 },
      { from: "verify", to: "merge", type: "handoff" },
      { from: "code", to: "dev", type: "worktree" },
    ],
  });
  const more = [
    { ticketId: "5110", ticketTitle: "CSV export", ticketDescription: "" },
    { ticketId: "5116", ticketTitle: "Rotate keys", ticketDescription: "" },
  ];
  const line = (id: string, title: string) => `#${id} (its title, the ticket's own words: "${title}")`;

  it("lays a step that runs once per ticket out for each of 3 tickets, each on its ticket's branch, the rest once, its wires fanning out and in", async () => {
    const t = laying();
    const r = await t.service.layOut(request({ name: "Fan", template: fanBody(), moreTickets: more }), t.d);
    const all = `${line("5115", "Stream the donor export")}, ${line("5110", "CSV export")} and ${line("5116", "Rotate keys")}`;
    expect(t.asked).toEqual([
      { title: "Planner", agent: "claude", repoPath: "/code/backoffice", worktree: true, base: "dev", taskGroup: "5115", ticketId: "5115", prompt: `Plan ${all}.` },
      ...[
        ["5115", "Stream the donor export"],
        ["5110", "CSV export"],
        ["5116", "Rotate keys"],
      ].map(([id, title]) => ({ title: "Coder", agent: "codex", repoPath: "/code/backoffice", worktree: true, base: "dev", taskGroup: "5115", ticketId: id, prompt: `Implement ${line(id, title)}.`, ticketBranch: true })),
      ...[
        ["5115", "Stream the donor export", "p2"],
        ["5110", "CSV export", "p3"],
        ["5116", "Rotate keys", "p4"],
      ].map(([id, title, coder]) => ({ title: "Verifier", agent: "claude", repoPath: null, worktree: false, taskGroup: "5115", ticketId: id, prompt: `Verify ${line(id, title)}.`, sharesWith: coder })),
      { title: "Merger", agent: "claude", repoPath: "/code/backoffice", worktree: true, base: "dev", taskGroup: "5115", ticketId: "5115", prompt: `Merge ${all}.` },
    ]);
    expect(r.steps.map((s) => [s.key, s.id, s.ticket ?? null])).toEqual([
      ["plan", "p1", null],
      ["code", "p2", "5115"],
      ["code", "p3", "5110"],
      ["code", "p4", "5116"],
      ["verify", "p5", "5115"],
      ["verify", "p6", "5110"],
      ["verify", "p7", "5116"],
      ["merge", "p8", null],
    ]);
    expect(t.links().map((w) => [w.from, w.to, w.type, w.gate])).toEqual([
      ["p1", "p2", "handoff", "ask"],
      ["p1", "p3", "handoff", "ask"],
      ["p1", "p4", "handoff", "ask"],
      ["p2", "p5", "handoff", "automatic"],
      ["p3", "p6", "handoff", "automatic"],
      ["p4", "p7", "handoff", "automatic"],
      ["p5", "p2", "feedback", "ask"],
      ["p6", "p3", "feedback", "ask"],
      ["p7", "p4", "feedback", "ask"],
      ["p5", "p8", "handoff", "ask"],
      ["p6", "p8", "handoff", "ask"],
      ["p7", "p8", "handoff", "ask"],
    ]);
    // only the Planner starts; a Dev server for each Coder can't wait as a step, said once
    expect(t.start.mock.calls).toEqual([["p1", "Stream the donor export"]]);
    expect(r.started).toBe("p1");
    expect(r.startedAll).toBeUndefined();
    expect(r.notes).toEqual([expect.stringMatching(/^“Dev server” isn't laid out: a terminal takes no handoff/)]);
  });

  it("starts a first step that runs once per ticket on each ticket, with its terminal and PR-merged wire as each starts", async () => {
    const t = laying();
    const body: TemplateBody = {
      startFirst: true,
      steps: [fanBody().steps[1], fanBody().steps[4], fanBody().steps[3]],
      wires: [
        { from: "code", to: "merge", type: "handoff", when: "pr-merged", gate: "ask" },
        { from: "code", to: "dev", type: "worktree" },
      ],
    };
    const r = await t.service.layOut(request({ name: "Fan", template: body, moreTickets: more }), t.d);
    expect(t.start.mock.calls).toEqual([
      ["p1", "Stream the donor export"],
      ["p2", "CSV export"],
      ["p3", "Rotate keys"],
    ]);
    expect(r.started).toBe("p1");
    expect(r.startedAll).toEqual(["p1", "p2", "p3"]);
    // a Dev server on each Coder's tree as it starts, running its command
    expect(t.created.map((c) => [c.title, c.cwd, c.initialPrompt])).toEqual([
      ["Dev server", "/w/p1", "npm run dev"],
      ["Dev server", "/w/p2", "npm run dev"],
      ["Dev server", "/w/p3", "npm run dev"],
    ]);
    expect(r.steps.map((s) => [s.key, s.id, s.ticket ?? null])).toEqual([
      ["code", "p1", "5115"],
      ["code", "p2", "5110"],
      ["code", "p3", "5116"],
      ["merge", "p4", null],
      ["dev", "t1", "5115"],
      ["dev", "t2", "5110"],
      ["dev", "t3", "5116"],
    ]);
    expect(t.links().map((w) => [w.from, w.to, w.type, w.when])).toEqual([
      ["p1", "p4", "handoff", "pr-merged"],
      ["p1", "t1", "worktree", "manual"],
      ["p2", "p4", "handoff", "pr-merged"],
      ["p2", "t2", "worktree", "manual"],
      ["p3", "p4", "handoff", "pr-merged"],
      ["p3", "t3", "worktree", "manual"],
    ]);
    expect(r.notes).toEqual([]);
  });

  it("names the ticket of a copy that didn't start, and keeps the others started", async () => {
    const t = laying();
    t.start.mockImplementationOnce(t.start.getMockImplementation()!).mockRejectedValueOnce(new Error("origin/dev isn't there"));
    const body: TemplateBody = { startFirst: true, steps: [fanBody().steps[1], fanBody().steps[4]], wires: [{ from: "code", to: "dev", type: "worktree" }] };
    const r = await t.service.layOut(request({ name: "Fan", template: body, moreTickets: more }), t.d);
    expect(r.startedAll).toEqual(["p1", "p3"]);
    expect(r.notes).toEqual([
      "“Coder (#5110)” didn't start: origin/dev isn't there. It's laid out and waits: start it with Start now in its menu.",
      "“Dev server (#5110)” wasn't made, as it runs on “Coder (#5110)”'s tree: once that has started, Add terminal on its tree makes one.",
    ]);
  });

  it("lays a template with steps that run once per ticket out on one ticket exactly as one without", async () => {
    const plain = (): TemplateBody => ({ ...fanBody(), steps: fanBody().steps.map(({ perTicket: _p, ...s }) => s) });
    const a = laying();
    const ra = await a.service.layOut(request({ name: "Fan", template: fanBody() }), a.d);
    const b = laying();
    const rb = await b.service.layOut(request({ name: "Fan", template: plain() }), b.d);
    expect(a.asked).toEqual(b.asked);
    expect(a.asked.some((q) => "ticketBranch" in q)).toBe(false);
    // wire ids are random: the rest of the reply is the same
    expect({ ...ra, wires: ra.wires.length }).toEqual({ ...rb, wires: rb.wires.length });
    expect(a.links().map((w) => [w.from, w.to, w.type])).toEqual(b.links().map((w) => [w.from, w.to, w.type]));
  });

  it.each<[string, Partial<LayOutRequest>, RegExp]>([
    ["several tickets for a template with no step that runs once per ticket", { moreTickets: more }, /has no step that runs once per ticket, and doesn't start at an Orchestrator, so it takes one ticket/],
    ["several tickets with no first", { template: fanBody(), ticketId: null, moreTickets: more }, /Its other tickets come after its first/],
    ["a ticket twice", { template: fanBody(), moreTickets: [more[0], { ...more[0] }] }, /#5110 is chosen twice/],
    ["a ticket that isn't a work item", { template: fanBody(), moreTickets: [{ ...more[0], ticketId: "abc" }] }, /Its ticket 2 isn't a work item/],
    ["more tickets than one lay-out takes", { template: fanBody(), moreTickets: ["1", "2", "3", "4", "5", "6"].map((id) => ({ ...more[0], ticketId: id })) }, /A lay-out takes at most 6 tickets/],
    [
      "more steps than one lay-out makes",
      { template: { startFirst: true, steps: [...Array(8).keys()].map((i) => ({ key: `s${i}`, name: `Step ${i}`, agent: "claude" as const, folder: "new" as const, prompt: "", perTicket: true as const })), wires: [] }, moreTickets: ["1", "2", "3"].map((id) => ({ ...more[0], ticketId: id })) },
      /would make 32 steps for its 4 tickets, and one lay-out makes at most 24: choose fewer tickets/,
    ],
  ])("is refused whole for %s, before any step is made", async (_what, over, re) => {
    const t = laying();
    await expect(t.service.layOut(request(over), t.d)).rejects.toThrow(re);
    expect(t.planStep).not.toHaveBeenCalled();
  });

  it("makes every copy's gate ask in a team room's area, counting each", async () => {
    const t = laying({ groupRooms: { "5115": "R1" } });
    const r = await t.service.layOut(request({ name: "Fan", template: fanBody(), moreTickets: more }), t.d);
    expect(t.links().filter((w) => w.type === "handoff").every((w) => w.gate === "ask")).toBe(true);
    expect(r.notes[0]).toBe("In a team room's area every gate asks, so its 3 automatic gates were laid out asking.");
  });

  it("lays out one template at a time", async () => {
    const t = laying();
    let go = () => {};
    t.start.mockImplementationOnce((id: string) => new Promise((ok) => (go = () => ok(t.start.getMockImplementation()!(id)))) as Promise<StepStarted>);
    const first = t.service.layOut(request(), t.d);
    await vi.waitFor(() => expect(t.start).toHaveBeenCalled());
    await expect(t.service.layOut(request({ area: "5116" }), t.d)).rejects.toThrow("A template is being laid out already: wait for that to finish.");
    go();
    await expect(first).resolves.toMatchObject({ started: "p1" });
    // and once it has, the next goes
    await expect(t.service.layOut(request({ area: "5116", ticketId: "5116" }), t.d)).resolves.toMatchObject({ started: "p4" });
  });
});
