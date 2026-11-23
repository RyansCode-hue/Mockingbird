import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { LandscapeStore } from "../src/main/landscape";
import { WireService } from "../src/main/wires";
import type { SessionInfo } from "../src/shared/types";
import type { Wire, WireReply, WireState } from "../src/shared/wires";
import { tempDir } from "./helpers";

// Wires as a pipeline is edited: moving a wire's ends, wires from not-started steps and ghosts, a forgotten step's
// chain bridged with Undo, Undo kept across a restart, and a session that carries on another's work taking its wires.

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, title: id, ticketTitle: null, repoPath: `/code/${id}`, branch: "b", taskGroup: "5038", status: "idle", agent: "claude", cwd: `/w/${id}`, kind: "work", createdAt: 1, ...over }) as SessionInfo;

function setup(opts: { dir?: string; rooms?: Record<string, string> } = {}) {
  const dir = opts.dir ?? tempDir("pipewires");
  const file = path.join(dir, "landscape.json");
  const undoFile = path.join(dir, "wire-undo.json");
  const logged: string[] = [];
  const log = (context: string, err: unknown) => void logged.push(`${context}: ${err instanceof Error ? err.message : String(err)}`);
  const store = new LandscapeStore({ file, emit: () => {}, log });
  const running = [session("a"), session("b"), session("c"), session("d"), session("term", { shell: true, cwd: "/w/a" }), session("brief", { debrief: true })];
  const closed = [session("ghost", { status: "dead" })];
  const planned = [session("p1", { planned: { worktree: false } }), session("p2", { planned: { worktree: false } })];
  const rooms = { ...opts.rooms };
  const service = new WireService({
    store,
    sessions: { list: () => running, resumable: () => closed, planned: () => planned },
    roomOf: (id) => rooms[id] ?? null,
    takenOver: () => null,
    log,
    undoFile,
  });
  store.update({ ghosts: { ghost: { title: "ghost", agent: "claude", cwd: "/w/ghost", repoPath: null, placement: { x: 0, y: 0, w: 8, h: 8 }, group: "5038", closedAt: "2026-11-01T00:00:00.000Z" } } });
  store.flush();
  return { dir, file, undoFile, store, service, running, closed, planned, rooms, logged };
}
const made = (r: WireReply): string => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.id!;
};
const refusal = (r: WireReply | { refused: string } | object) => ("refused" in r ? r.refused : `not refused: ${JSON.stringify(r)}`);
const links = (s: { service: WireService }) => s.service.get().book!.links;
const pairs = (s: { service: WireService }) =>
  Object.values(links(s))
    .map((w) => `${w.from}→${w.to}:${w.type}`)
    .sort();

describe("moving a wire's ends (repoint)", () => {
  it("moves either end or both, keeping its id, type and settings, and letting go of what it held for its old ends", () => {
    const s = setup();
    const id = made(s.service.add("a", "b", "feedback", { template: "Review: {summary}", limit: 5 }));
    // as though a round had run
    s.store.editWires((book) => ({ book: { ...book, links: { ...book.links, [id]: { ...book.links[id], rounds: { limit: 5, used: 2 }, pending: { id: "p", body: "x", at: 1, flags: [] } } } } }));
    made(s.service.repoint(id, { to: "c" }));
    expect(links(s)[id]).toMatchObject({ from: "a", to: "c", type: "feedback", template: "Review: {summary}", rounds: { limit: 5, used: 0 }, pending: { id: "p" } });
    made(s.service.repoint(id, { from: "d" }));
    expect(links(s)[id]).toMatchObject({ from: "d", to: "c", template: "Review: {summary}" });
    expect(links(s)[id].pending).toBeUndefined();
    made(s.service.repoint(id, { from: "a", to: "b" }));
    expect(links(s)[id]).toMatchObject({ from: "a", to: "b" });
  });

  it("is refused as making it there would be: to itself, a second of its kind, a loop of handoffs, a terminal, a room's line", () => {
    const s = setup({ rooms: { d: "R1" } });
    const ab = made(s.service.add("a", "b", "handoff"));
    made(s.service.add("b", "c", "handoff"));
    made(s.service.add("a", "c", "handoff"));
    expect(refusal(s.service.repoint(ab, { to: "a" }))).toMatch(/wired to itself/);
    expect(refusal(s.service.repoint(ab, { to: "c" }))).toMatch(/handoff wire between these two already/);
    expect(refusal(s.service.repoint(ab, { from: "c", to: "a" }))).toMatch(/cycle of handoffs/);
    expect(refusal(s.service.repoint(ab, { to: "term" }))).toMatch(/is a terminal/);
    expect(refusal(s.service.repoint(ab, { to: "d" }))).toMatch(/same team room/);
    expect(refusal(s.service.repoint(ab, { to: "b" }))).toMatch(/between those two already/);
    expect(refusal(s.service.repoint(ab, {}))).toMatch(/Say which end moves/);
    expect(refusal(s.service.repoint("nope", { to: "c" }))).toMatch(/no wire "nope"/);
    expect(links(s)[ab]).toMatchObject({ from: "a", to: "b" });
  });

  it("checks its settings from its new source: automatic is off in a room", () => {
    const s = setup({ rooms: { c: "R1", d: "R1" } });
    const id = made(s.service.add("a", "b", "handoff", { gate: "automatic" }));
    expect(refusal(s.service.repoint(id, { from: "c", to: "d" }))).toMatch(/Automatic is off in a team room's area/);
  });

  it("is undone whole, counters included, while it still runs where repoint put it", () => {
    const s = setup();
    const id = made(s.service.add("a", "b", "feedback"));
    s.store.editWires((book) => ({ book: { ...book, links: { ...book.links, [id]: { ...book.links[id], rounds: { limit: 3, used: 2 } } } } }));
    const before = links(s)[id];
    made(s.service.repoint(id, { to: "c" }));
    expect(s.service.repointUndoable(id)).toBe(true);
    made(s.service.unrepoint(id));
    expect(links(s)[id]).toEqual(before);
    expect(refusal(s.service.unrepoint(id))).toMatch(/can't be undone any more/);
    made(s.service.repoint(id, { to: "c" }));
    made(s.service.repoint(id, { to: "d" }));
    expect(s.service.unrepoint(id)).not.toHaveProperty("refused");
    made(s.service.repoint(id, { to: "d" }));
    s.service.remove(id);
    expect(refusal(s.service.unrepoint(id))).toMatch(/removed since/);
  });
});

describe("wires from a not-started step or a ghost", () => {
  it("start from either, as they end on either", () => {
    const s = setup();
    made(s.service.add("p1", "p2", "handoff"));
    made(s.service.add("ghost", "a", "handoff"));
    made(s.service.add("p1", "ghost", "context"));
    const w = made(s.service.add("a", "b", "handoff"));
    made(s.service.repoint(w, { from: "p2" }));
    expect(pairs(s)).toEqual(["ghost→a:handoff", "p1→ghost:context", "p1→p2:handoff", "p2→b:handoff"]);
  });
});

describe("a forgotten step's chain", () => {
  it("is bridged A→B with the out-wire's settings, said, and its Undo puts the step's record and wires back and the bridge away", () => {
    const s = setup();
    made(s.service.add("a", "p1", "handoff"));
    made(s.service.add("p1", "b", "handoff", { template: "Verify: {summary}", gate: "ask" }));
    made(s.service.add("p1", "c", "context"));
    const before = pairs(s);
    const rec = s.planned.splice(0, 1)[0];
    const r = s.service.forgetChain("p1", rec, (id) => `“${id}”`);
    expect(r.bridged).toEqual([{ id: r.bridged[0].id, from: "a", to: "b" }]);
    expect(r.unbridged).toEqual([]);
    expect(links(s)[r.bridged[0].id]).toMatchObject({ from: "a", to: "b", type: "handoff", template: "Verify: {summary}" });
    expect(pairs(s)).toEqual(["a→b:handoff"]);
    const restored: SessionInfo[] = [];
    const back = s.service.unforget(r.undo, (x) => {
      restored.push(x);
      s.planned.push(x);
    });
    expect(back).toMatchObject({ notes: [] });
    expect(restored.map((x) => x.id)).toEqual(["p1"]);
    expect(pairs(s)).toEqual(before);
    expect(refusal(s.service.unforget(r.undo, () => {}))).toMatch(/can't be undone any more/);
  });

  it("bridges each way in to each way out, makes none that's there already, and says one the rules refuse", () => {
    const s = setup();
    made(s.service.add("a", "p1", "handoff"));
    made(s.service.add("b", "p1", "handoff"));
    made(s.service.add("p1", "c", "handoff"));
    made(s.service.add("p1", "d", "handoff"));
    made(s.service.add("a", "c", "handoff"));
    const r = s.service.forgetChain("p1", null, (id) => `“${id}”`);
    // a→c is there already
    expect(r.bridged.map((b) => `${b.from}→${b.to}`)).toEqual(["a→d", "b→c", "b→d"]);
    const t = setup({ rooms: { d: "R1", p2: "R1" } });
    made(t.service.add("d", "p2", "handoff"));
    delete t.rooms.p2;
    made(t.service.add("p2", "b", "handoff"));
    t.rooms.p2 = "R1";
    const q = t.service.forgetChain("p2", null, (id) => `“${id}”`);
    expect(q.bridged).toEqual([]);
    expect(q.unbridged).toEqual([expect.stringMatching(/^“d” → “b”: Both ends have to be in the same team room/)]);
  });

  it("holds no Undo for a session that took nothing with it and kept no record", () => {
    const s = setup();
    expect(s.service.forgetChain("c", null, (id) => id)).toEqual({ bridged: [], unbridged: [], undo: null, wiresLeft: null });
  });
});

describe("Undo across a restart", () => {
  it("keeps a removed wire, a repoint and a Forget for a new WireService on the same files", () => {
    const s = setup();
    const ab = made(s.service.add("a", "b", "handoff", { template: "x" }));
    const bc = made(s.service.add("b", "c", "handoff"));
    made(s.service.add("c", "p2", "handoff"));
    s.service.remove(ab);
    made(s.service.repoint(bc, { to: "d" }));
    const rec = s.planned.splice(1, 1)[0];
    const f = s.service.forgetChain("p2", rec, (id) => id);
    const again = setup({ dir: s.dir });
    again.planned.splice(1, 1);
    expect(again.service.restorable(ab)).toBe(true);
    made(again.service.restore(ab));
    expect(links(again)[ab]).toMatchObject({ from: "a", to: "b", template: "x" });
    made(again.service.unrepoint(bc));
    expect(links(again)[bc]).toMatchObject({ from: "b", to: "c" });
    expect(again.service.unforget(f.undo, (x) => void again.planned.push(x))).toMatchObject({ notes: [] });
    expect(pairs(again)).toContain("c→p2:handoff");
  });

  it("drops an entry it can't read, logged, and sets aside a file that isn't JSON, never stopping", () => {
    const s = setup();
    const id = made(s.service.add("a", "b", "handoff"));
    s.service.remove(id);
    const onDisk = JSON.parse(fs.readFileSync(s.undoFile, "utf8"));
    onDisk.entries["removed:zz"] = { kind: "removed", wire: { from: "a" }, at: 1 };
    onDisk.entries["what"] = { kind: "nonsense", at: 1 };
    fs.writeFileSync(s.undoFile, JSON.stringify(onDisk));
    const again = setup({ dir: s.dir });
    expect(again.service.restorable(id)).toBe(true);
    expect(again.service.restorable("zz")).toBe(false);
    expect(again.logged.filter((l) => /Undo entry/.test(l))).toHaveLength(2);
    fs.writeFileSync(s.undoFile, "{ not json");
    const third = setup({ dir: s.dir });
    expect(third.service.restorable(id)).toBe(false);
    expect(fs.readdirSync(s.dir).some((f) => f.startsWith("wire-undo.json.corrupt-"))).toBe(true);
  });

  it("keeps the last 50 removed, as it did in memory", () => {
    const s = setup();
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) {
      const id = made(s.service.add(i % 2 ? "a" : "b", i % 2 ? "b" : "a", "context"));
      s.service.remove(id);
      ids.push(id);
    }
    const again = setup({ dir: s.dir });
    expect(ids.filter((id) => again.service.restorable(id))).toEqual(ids.slice(2));
  });
});

describe("a session that carries on another's work (a brief's, Continue in Codex)", () => {
  it("takes its wires and note, as Start fresh does; when it can't, they stay, logged", () => {
    const s = setup();
    s.running.push(session("fresh", { agent: "codex" }));
    made(s.service.add("a", "b", "handoff"));
    made(s.service.add("b", "c", "context"));
    expect(s.service.carryOn("b", "fresh")).toBeNull();
    expect(pairs(s)).toEqual(["a→fresh:handoff", "fresh→c:context"]);
    // a debrief takes no wires: they stay where they were
    expect(s.service.carryOn("fresh", "brief")).toMatch(/debrief/);
    expect(pairs(s)).toEqual(["a→fresh:handoff", "fresh→c:context"]);
    expect(s.logged.at(-1)).toMatch(/fresh's wires stayed on it/);
  });
});

describe("main's wiring", () => {
  it("moves a brief's and a Continue in Codex's session's wires, and forgets through the bridging path", () => {
    const index = fs.readFileSync(path.join(__dirname, "../src/main/index.ts"), "utf8");
    expect(index).toMatch(/async function startFromBrief[\s\S]*?carryWires\(s, await companionSession/);
    expect(index).toMatch(/async function startFromHandoff[\s\S]*?carryWires\(s, await companionSession/);
    expect(index).toMatch(/handle\("sessions:kill", \(id, forget\) => \{\s*if \(forget\) \{\s*forgetSession/);
    expect(index).toMatch(/undoFile: path\.join\(MB_DIR, "wire-undo\.json"\)/);
  });
});

// unused-type guard: the reply shapes the renderer reads
export type _Shapes = [Wire, WireState];
