import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LandscapeStore } from "../src/main/landscape";
import { Messaging, mcpLaunch, retireMcpLaunch } from "../src/main/messaging";
import { WireService } from "../src/main/wires";
import type { SessionInfo } from "../src/shared/types";
import { newWire, ROOM_LINE, type Wire, type WireChange, type WireReply, type WireState } from "../src/shared/wires";
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
  const running = [session("a"), session("b"), session("c"), session("term", { shell: true, cwd: "/w/a" }), session("brief", { debrief: true }), session("gone", { status: "dead" })];
  const closed = [session("old"), session("ghost")];
  const rooms = { ...opts.rooms };
  const takenOver = { ...opts.takenOver };
  const service = new WireService({
    store,
    sessions: { list: () => running, resumable: () => closed },
    roomOf: (id) => rooms[id] ?? null,
    takenOver: (id) => takenOver[id] ?? null,
    log,
    ...(opts.newId ? { newId: opts.newId } : {}),
  });
  store.update({ ghosts: { ghost: { title: "ghost", agent: "claude", cwd: "/w/ghost", repoPath: null, placement: { x: 0, y: 0, w: 8, h: 8 }, group: "5038", closedAt: "2026-11-01T00:00:00.000Z" } } });
  store.flush();
  return { dir, file, store, service, running, closed, rooms, takenOver, changes, logged };
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
    ["a session it doesn't know", "a", "nope", "handoff", /no session "nope"/],
    ["a debrief", "a", "brief", "context", /debrief/],
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
    service.sessionForgotten("old");
    expect(changes).toEqual([]);
  });
  it.skipIf(asRoot)("is logged when its wires can't be dropped now, and they show as blocked, their end gone", () => {
    const { service, file, closed, logged, store } = setup();
    const { id } = made(service.add("a", "old", "handoff"));
    closed.splice(closed.findIndex((s) => s.id === "old"), 1);
    fs.chmodSync(file, 0o444);
    try {
      service.sessionForgotten("old");
    } finally {
      fs.chmodSync(file, 0o644);
    }
    expect(logged.join()).toMatch(/couldn't drop the wires of forgotten session old.*read-only/);
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
  it("lists only the caller's wires, each with its direction, type and state", () => {
    const { service } = setup();
    const out = made(service.add("a", "b", "handoff")).id;
    const inn = made(service.add("c", "a", "context")).id;
    made(service.add("b", "c", "handoff"));
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
