import { describe, expect, it } from "vitest";
import { LANDSCAPE_VERSION } from "../src/shared/landscape";
import {
  createdAtAfter,
  DEFAULT_ROUNDS,
  WIRE_FORMAT,
  WIRE_VERSION,
  emptyWireBook,
  finishPlan,
  freshWireRead,
  gateOf,
  keptNaming,
  linkRefusal,
  newWire,
  parseWireBook,
  parseWireSettings,
  readableKept,
  rekeyedBook,
  rekeyRefusal,
  restoredWire,
  restoreRefusal,
  ROOM_LINE,
  ROOMS_STARTING,
  settingsRefusal,
  storedWireBook,
  verdictRefusal,
  wireRefusal,
  wiresInOrder,
  withSettings,
  withoutSession,
  type GateContext,
  type SourceNote,
  type Wire,
  type WireBook,
  type WireBookRead,
  type WireEnd,
  type WireType,
} from "../src/shared/wires";

const end = (id: string, over: Partial<WireEnd> = {}): WireEnd => ({ id, title: id, kind: "agent", debrief: false, room: null, takenOver: null, where: "running", placed: true, folder: `/w/${id}`, hooksSilent: false, ...over });

function ctxOf(ends: WireEnd[], links: Record<string, Wire> = {}, notes: Record<string, SourceNote> = {}, more: Partial<GateContext> = {}): GateContext {
  const byId = new Map(ends.map((e) => [e.id, e]));
  return { end: (id) => byId.get(id) ?? null, links, notes, fileRefusal: null, ...more };
}
const wire = (from: string, to: string, type: WireType = "handoff", over: Partial<Wire> = {}): Wire => ({ ...newWire(from, to, type, 1), ...over });
const AB = [end("a"), end("b")];
const okRead = (r: WireBookRead) => r as Extract<WireBookRead, { status: "ok" }>;

describe("wireRefusal", () => {
  it("allows two agents of this Mac's, outside any room, every type but the terminal's", () => {
    for (const type of ["handoff", "context", "feedback"] as const) expect(wireRefusal("a", "b", type, ctxOf(AB)), type).toBeNull();
  });
  it("refuses a workspace wired to itself", () => {
    expect(wireRefusal("a", "a", "handoff", ctxOf(AB))).toMatch(/to itself/);
  });
  it.each([
    ["from", "r~1234", "b"],
    ["to", "a", "r~1234"],
    ["from, as messaging names it", "s1@abcd1234", "b"],
    ["to, as messaging names it", "a", "s1@abcd1234"],
  ])("refuses a teammate's session at %s, even when something answers for its id", (_where, from, to) => {
    const ctx = ctxOf([...AB, end("r~1234"), end("s1@abcd1234")]);
    expect(wireRefusal(from, to, "handoff", ctx)).toMatch(/teammate's session: wires across Macs come later/);
  });
  it("refuses a session this Mac doesn't have, at either end", () => {
    expect(wireRefusal("gone", "b", "handoff", ctxOf(AB))).toMatch(/no session "gone"/);
    expect(wireRefusal("a", "gone", "handoff", ctxOf(AB))).toMatch(/no session "gone"/);
  });
  it("refuses a debrief at either end", () => {
    const ctx = ctxOf([end("a"), end("d", { debrief: true })]);
    expect(wireRefusal("a", "d", "context", ctx)).toMatch(/debrief/);
    expect(wireRefusal("d", "a", "context", ctx)).toMatch(/debrief/);
  });
  it("refuses the Helpdesk tasks workspace at either end, for every type", () => {
    const ctx = ctxOf([end("a"), end("h", { tasks: true, title: "Helpdesk tasks" }), end("t", { kind: "terminal", folder: "/w/h" })]);
    for (const type of ["handoff", "context", "feedback"] as const) {
      expect(wireRefusal("a", "h", type, ctx), type).toMatch(/“Helpdesk tasks” is the Helpdesk tasks workspace.*takes no wires/);
      expect(wireRefusal("h", "a", type, ctx), type).toMatch(/Helpdesk tasks workspace/);
    }
    expect(wireRefusal("h", "t", "worktree", ctx)).toMatch(/Helpdesk tasks workspace/);
  });
  it("refuses a session taken over, at either end, saying where it continues", () => {
    const ctx = ctxOf([end("a"), end("t", { takenOver: "“t” continues on Nick's laptop" })]);
    expect(wireRefusal("a", "t", "handoff", ctx)).toMatch(/continues on Nick's laptop/);
    expect(wireRefusal("t", "a", "handoff", ctx)).toMatch(/continues on Nick's laptop/);
  });
  it("refuses a room session outside the room's sandbox, at either end, until it's restarted in the room", () => {
    const joined = end("j", { room: "R1", title: "Joined", outsideSandbox: true });
    const ctx = ctxOf([end("r", { room: "R1" }), joined]);
    const why = "“Joined” isn't in its team room's sandbox (it joined the room while it was running, its sandbox didn't start, or the room's sandbox was switched on after it started): restart it in the room to wire it there.";
    expect(wireRefusal("r", "j", "handoff", ctx)).toBe(why);
    expect(wireRefusal("j", "r", "context", ctx)).toBe(why);
    // across the line it's the line that's said, naming nothing on the far side
    expect(wireRefusal("a", "j", "handoff", ctxOf([end("a"), joined]))).toBe(ROOM_LINE);
  });
  it("wants both ends in one room or neither", () => {
    const inRoom = end("r", { room: "R1" });
    const inOther = end("o", { room: "R2" });
    expect(wireRefusal("r", "a", "handoff", ctxOf([inRoom, end("a")]))).toMatch(/same team room/);
    expect(wireRefusal("a", "r", "context", ctxOf([inRoom, end("a")]))).toMatch(/same team room/);
    expect(wireRefusal("r", "o", "handoff", ctxOf([inRoom, inOther]))).toMatch(/same team room/);
    expect(wireRefusal("r", "r2", "handoff", ctxOf([inRoom, end("r2", { room: "R1" })]))).toBeNull();
  });
  it("says only that a room's line is crossed, whatever else holds at the far end, so nothing of it is named", () => {
    const far = end("r", { room: "R1", title: "Private plan", debrief: true, takenOver: "“Private plan” continues on Nick's laptop", kind: "terminal" });
    expect(wireRefusal("a", "r", "handoff", ctxOf([end("a"), far]))).toBe(ROOM_LINE);
    expect(wireRefusal("r", "a", "context", ctxOf([end("a"), far]))).toBe(ROOM_LINE);
    expect(ROOM_LINE).not.toMatch(/Private plan/);
  });
  it("refuses every wire while it can't tell which sessions are in a room, as any might cross a line", () => {
    const unknown = { roomsUnknown: ROOMS_STARTING };
    for (const type of ["handoff", "context", "feedback"] as const) expect(wireRefusal("a", "b", type, ctxOf(AB, {}, {}, unknown)), type).toBe(ROOMS_STARTING);
    expect(wireRefusal("a", "t", "worktree", ctxOf([end("a"), end("t", { kind: "terminal" })], {}, {}, unknown))).toBe(ROOMS_STARTING);
    expect(gateOf("w", wire("a", "b", "handoff", { pending: { id: "p", body: "x", at: 1, flags: [] } }), ctxOf(AB, {}, {}, unknown))).toMatchObject({ state: "blocked", why: ROOMS_STARTING });
    expect(ROOMS_STARTING).toMatch(/still starting its team rooms/);
  });
  it("counts a kept wire whose ends and type can be read as there already, but not against itself", () => {
    const kept = { k: { from: "a", to: "b", type: "feedback" as const }, h: { from: "b", to: "c", type: "handoff" as const } };
    const ends = [...AB, end("c")];
    expect(wireRefusal("b", "a", "feedback", ctxOf(ends, {}, {}, { kept }))).toMatch(/feedback wire already/);
    expect(wireRefusal("b", "c", "handoff", ctxOf(ends, {}, {}, { kept }))).toMatch(/handoff wire between these two already/);
    expect(wireRefusal("c", "a", "handoff", ctxOf(ends, { x: wire("a", "b") }, {}, { kept }))).toMatch(/cycle/);
    expect(wireRefusal("b", "a", "feedback", ctxOf(ends, {}, {}, { kept, self: "k" }))).toBeNull();
  });
  it("keeps a terminal off every wire but a shared worktree's", () => {
    const ctx = ctxOf([end("a"), end("t", { kind: "terminal" })]);
    for (const type of ["handoff", "feedback", "context"] as const) {
      expect(wireRefusal("a", "t", type, ctx), `${type} to it`).toMatch(/is a terminal/);
      expect(wireRefusal("t", "a", type, ctx), `${type} from it`).toMatch(/is a terminal/);
    }
  });
  it("wants a shared worktree wire from an agent to a terminal in the same folder", () => {
    const same = ctxOf([end("a", { folder: "/w/x" }), end("t", { kind: "terminal", folder: "/w/x" })]);
    expect(wireRefusal("a", "t", "worktree", same)).toBeNull();
    expect(wireRefusal("t", "a", "worktree", same)).toMatch(/from an agent to a terminal/);
    expect(wireRefusal("a", "b", "worktree", ctxOf(AB))).toMatch(/from an agent to a terminal/);
    expect(wireRefusal("a", "t", "worktree", ctxOf([end("a", { folder: "/w/x" }), end("t", { kind: "terminal", folder: "/w/y" })]))).toMatch(/another folder/);
  });
  it("allows one feedback wire per pair, in either direction, so a second can't start a fresh count", () => {
    const ctx = ctxOf(AB, { f: wire("a", "b", "feedback") });
    expect(wireRefusal("a", "b", "feedback", ctx)).toMatch(/feedback wire already/);
    expect(wireRefusal("b", "a", "feedback", ctx)).toMatch(/feedback wire already/);
  });
  it("refuses the same wire twice, but not a different type between the same two", () => {
    const ctx = ctxOf(AB, { h: wire("a", "b") });
    expect(wireRefusal("a", "b", "handoff", ctx)).toMatch(/already/);
    expect(wireRefusal("a", "b", "context", ctx)).toBeNull();
    expect(wireRefusal("b", "a", "context", ctx)).toBeNull();
  });
  it("refuses a cycle of handoffs, direct or along a chain", () => {
    const ends = [...AB, end("c")];
    expect(wireRefusal("b", "a", "handoff", ctxOf(ends, { x: wire("a", "b") }))).toMatch(/cycle/);
    expect(wireRefusal("c", "a", "handoff", ctxOf(ends, { x: wire("a", "b"), y: wire("b", "c") }))).toMatch(/cycle/);
  });
  it("allows a loop through a feedback wire, since its rounds stop it", () => {
    expect(wireRefusal("b", "a", "feedback", ctxOf(AB, { x: wire("a", "b") }))).toBeNull();
    expect(wireRefusal("a", "b", "handoff", ctxOf(AB, { f: wire("b", "a", "feedback") }))).toBeNull();
  });
  it("doesn't count a wire against itself when it's the one being checked", () => {
    const links = { h: wire("a", "b"), f: wire("a", "b", "feedback") };
    expect(wireRefusal("a", "b", "handoff", ctxOf(AB, links, {}, { self: "h" }))).toBeNull();
    expect(wireRefusal("a", "b", "feedback", ctxOf(AB, links, {}, { self: "f" }))).toBeNull();
    expect(linkRefusal("a", "b", "handoff", ctxOf(AB, links))).toMatch(/already/);
  });
  it("names a wire's end by its title", () => {
    expect(wireRefusal("a", "t", "handoff", ctxOf([end("a"), end("t", { kind: "terminal", title: "dev server" })]))).toMatch(/“dev server”/);
  });
});

describe("a new wire", () => {
  it("asks at its gate whatever its type", () => {
    for (const type of ["handoff", "context", "feedback", "worktree"] as const) expect(newWire("a", "t", type, 5).gate, type).toBe("ask");
  });
  it("goes when its source finishes only if it carries something", () => {
    expect(newWire("a", "b", "handoff", 5).when).toBe("finished");
    expect(newWire("a", "b", "feedback", 5).when).toBe("finished");
    expect(newWire("a", "b", "context", 5).when).toBe("manual");
    expect(newWire("a", "b", "worktree", 5).when).toBe("manual");
  });
  it("is stamped after every wire already made, so wires made within one millisecond keep their order", () => {
    expect(createdAtAfter({}, 5)).toBe(5);
    expect(createdAtAfter({ x: wire("a", "b", "handoff", { createdAt: 3 }) }, 5)).toBe(5);
    expect(createdAtAfter({ x: wire("a", "b", "handoff", { createdAt: 5 }), y: wire("a", "c", "handoff", { createdAt: 6 }) }, 5)).toBe(7);
  });
  it("counts rounds only on a feedback wire, from the default limit", () => {
    expect(newWire("a", "b", "feedback", 5).rounds).toEqual({ limit: DEFAULT_ROUNDS, used: 0 });
    expect(newWire("a", "b", "handoff", 5).rounds).toBeUndefined();
  });
});

describe("a wire's settings", () => {
  it("can't name anything that isn't settable", () => {
    for (const field of ["pending", "delivery", "rounds", "used", "from", "to", "type", "createdAt", "wv"]) {
      expect(() => parseWireSettings({ [field]: 1 }), field).toThrow(/doesn't know/);
    }
  });
  it("checks what it does name", () => {
    expect(parseWireSettings({ template: "{summary}", files: ["src/a.ts"], when: "manual", gate: "ask", limit: 5 })).toEqual({ template: "{summary}", files: ["src/a.ts"], when: "manual", gate: "ask", limit: 5 });
    expect(() => parseWireSettings({ when: "soon" })).toThrow(/when/);
    expect(() => parseWireSettings({ gate: "open" })).toThrow(/gate/);
    expect(() => parseWireSettings({ limit: 0 })).toThrow(/limit/);
    expect(() => parseWireSettings({ limit: 1.5 })).toThrow(/limit/);
    expect(() => parseWireSettings(null)).toThrow();
  });
  it.each(["/etc/passwd", "~/.ssh/id_rsa", "../secrets", "a/../../b", ""])("refuses a file outside the source's folder by its spelling: %j", (f) => {
    expect(() => parseWireSettings({ files: [f] })).toThrow();
  });
  it("allows automatic only on what carries something, with both ends outside rooms", () => {
    const ctx = ctxOf(AB);
    expect(settingsRefusal(wire("a", "b"), { gate: "automatic" }, ctx)).toBeNull();
    expect(settingsRefusal(wire("a", "b", "feedback"), { gate: "automatic" }, ctx)).toBeNull();
    expect(settingsRefusal(wire("a", "b", "context"), { gate: "automatic" }, ctx)).toMatch(/no gate/);
    expect(settingsRefusal(wire("a", "b", "worktree"), { gate: "automatic" }, ctx)).toMatch(/no gate/);
    const rooms = ctxOf([end("a", { room: "R" }), end("b", { room: "R" })]);
    expect(settingsRefusal(wire("a", "b"), { gate: "automatic" }, rooms)).toMatch(/team room/);
    expect(settingsRefusal(wire("a", "gone"), { gate: "automatic" }, ctx)).toMatch(/both ends/);
    expect(settingsRefusal(wire("a", "b"), { gate: "ask" }, rooms)).toBeNull();
  });
  it("keeps What flows and When to the wires that have them, and a limit to a feedback wire", () => {
    const ctx = ctxOf(AB);
    for (const type of ["context", "worktree"] as const) {
      expect(settingsRefusal(wire("a", "b", type), { template: "x" }, ctx), type).toMatch(/What flows/);
      expect(settingsRefusal(wire("a", "b", type), { files: ["x"] }, ctx), type).toMatch(/What flows/);
      expect(settingsRefusal(wire("a", "b", type), { when: "finished" }, ctx), type).toMatch(/When/);
    }
    expect(settingsRefusal(wire("a", "b"), { limit: 5 }, ctx)).toMatch(/feedback/);
    expect(settingsRefusal(wire("a", "b", "feedback"), { limit: 5 }, ctx)).toBeNull();
  });
  it("moves the limit and leaves what's been counted, and null clears a field", () => {
    const w = withSettings(wire("a", "b", "feedback", { rounds: { limit: 3, used: 2 }, template: "t", files: ["f"] }), { limit: 5, template: null, files: null, when: "manual", gate: "automatic" });
    expect(w.rounds).toEqual({ limit: 5, used: 2 });
    expect(w).not.toHaveProperty("template");
    expect(w).not.toHaveProperty("files");
    expect(w).toMatchObject({ when: "manual", gate: "automatic" });
  });
});

describe("reading a stored book", () => {
  it("writes back a live entry, not a kept one under the same key", () => {
    const r = okRead(parseWireBook({ wv: 1, links: { w: { from: "a", to: "b", type: "sees" } }, notes: { a: "x" } }));
    const live = wire("a", "b");
    const stored = storedWireBook({ ...r, book: { ...r.book, links: { w: live }, notes: { a: { hops: 1 } } } }) as { links: Record<string, unknown>; notes: Record<string, unknown> };
    expect(stored.links.w).toBe(live);
    expect(stored.notes.a).toEqual({ hops: 1 });
  });
  const good = { from: "a", to: "b", type: "handoff", when: "finished", gate: "ask", createdAt: 1 };
  const stored = (links: Record<string, unknown> = {}, notes: Record<string, unknown> = {}, more: Record<string, unknown> = {}) => ({ wv: 1, links, notes, ...more });

  it("reads absent as an empty book, with nothing to report", () => {
    expect(parseWireBook(undefined)).toEqual(freshWireRead());
  });
  it("reads a good book whole, and writes it back the same", () => {
    const full = stored(
      {
        h: { ...good, template: "{summary}", files: ["x"], pending: { id: "p", body: "b", at: 2, verdict: "approve", flags: ["f"] }, delivery: { id: "p", state: "failed", at: 3, why: "w" } },
        f: { ...good, type: "feedback", rounds: { limit: 3, used: 1 } },
        m: { ...good, when: "pr-merged", since: 5, fired: ["https://github.com/o/r/pull/1"], sourceRepo: { provider: "github", repo: "o/r" } },
      },
      { a: { hops: 1, verdict: "changes", summary: { text: "t", at: 4, conversation: "c" } } }
    );
    const r = parseWireBook(full);
    expect(r.status).toBe("ok");
    expect(r.problems).toEqual([]);
    expect(storedWireBook(r)).toEqual(full);
  });
  it.each([
    ["an unknown type", { ...good, type: "sees" }],
    ["an unknown field", { ...good, colour: "red" }],
    ["no createdAt", { from: "a", to: "b", type: "handoff", when: "finished", gate: "ask" }],
    ["an empty end", { ...good, from: "" }],
    ["a session to itself", { ...good, to: "a" }],
    ["a feedback wire with no rounds", { ...good, type: "feedback" }],
    ["rounds on a handoff", { ...good, rounds: { limit: 3, used: 0 } }],
    ["a bad pending", { ...good, pending: { id: "p" } }],
    ["a bad delivery state", { ...good, delivery: { id: "p", state: "lost", at: 1 } }],
    ["negative rounds", { ...good, type: "feedback", rounds: { limit: 3, used: -1 } }],
    ["a source repository that's a word", { ...good, when: "pr-merged", sourceRepo: "o/r" }],
    ["a source repository on another provider", { ...good, when: "pr-merged", sourceRepo: { provider: "gitlab", repo: "o/r" } }],
    ["a source repository with no name", { ...good, when: "pr-merged", sourceRepo: { provider: "ado", repo: "" } }],
    ["no object at all", "wire"],
    ["null", null],
  ])("keeps a wire with %s verbatim and inert, and the rest works", (_what, bad) => {
    const raw = stored({ good, bad });
    const r = okRead(parseWireBook(raw));
    expect(Object.keys(r.book.links)).toEqual(["good"]);
    expect(r.kept.links).toEqual({ bad });
    expect(r.problems).toEqual([{ kind: "entry", id: "bad", message: expect.stringMatching(/Wire "bad" .* kept as it is, and does nothing/) }]);
    expect(storedWireBook(r)).toEqual(raw);
  });
  it("keeps a bad note verbatim and inert", () => {
    const raw = stored({}, { s1: { hops: "many" }, s2: { hops: 1 } });
    const r = okRead(parseWireBook(raw));
    expect(r.book.notes).toEqual({ s2: { hops: 1 } });
    expect(r.problems).toEqual([expect.objectContaining({ kind: "note", id: "s1" })]);
    expect(storedWireBook(r)).toEqual(raw);
  });
  it("keeps a field it doesn't know, at the book's level, and says so", () => {
    const raw = stored({ good }, {}, { future: { a: 1 } });
    const r = okRead(parseWireBook(raw));
    expect(r.problems).toEqual([expect.objectContaining({ kind: "field", id: "future" })]);
    expect(storedWireBook(r)).toEqual(raw);
  });
  it("keeps entries named __proto__ as entries, polluting nothing", () => {
    const raw = JSON.parse(`{"wv":1,"links":{"__proto__":{"from":"a","to":"b","type":"handoff","when":"finished","gate":"ask","createdAt":1},"bad":{"__proto__":{"x":1}}},"notes":{"__proto__":{"hops":1}}}`);
    const r = okRead(parseWireBook(raw));
    expect(Object.keys(r.book.links)).toEqual(["__proto__"]);
    expect(({} as any).from).toBeUndefined();
    expect(Object.getPrototypeOf(r.book.links)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(storedWireBook(r)))).toEqual(raw);
  });
  it("leaves a newer book alone, whole, and uses none of it", () => {
    const raw = { wv: WIRE_VERSION + 1, links: { x: { anything: true } }, somethingNew: 1 };
    const r = parseWireBook(raw);
    expect(r.status).toBe("newer");
    expect(r.problems).toEqual([expect.objectContaining({ kind: "newer", message: expect.stringMatching(/newer Mockingbird \(wire format 2\)/) })]);
    expect(storedWireBook(r)).toBe(raw);
  });
  it.each([
    ["not an object", 5],
    ["a list", []],
    ["null", null],
    ["no wv", { links: {}, notes: {} }],
    ["a wv that isn't a whole number", { wv: 1.5, links: {}, notes: {} }],
    ["a wv of 0", { wv: 0, links: {}, notes: {} }],
    ["a wv in a string", { wv: "1", links: {}, notes: {} }],
    ["links that aren't a record", { wv: 1, links: [], notes: {} }],
    ["no notes", { wv: 1, links: {} }],
  ])("keeps a book that's %s whole, and uses none of it", (_what, raw) => {
    const r = parseWireBook(raw);
    expect(r.status).toBe("bad");
    expect(r.problems).toEqual([expect.objectContaining({ kind: "book" })]);
    expect(storedWireBook(r)).toBe(raw);
  });
});

/**
 * The book's stored format, version by version. A field added or made required changes what an older Mockingbird can
 * read: it needs WIRE_VERSION raised and the new format pinned here, or to be an entry an older build keeps verbatim.
 * A context link's toolOutput is the second kind: a build before it keeps such a link as an entry it can't parse, and
 * no release has read version 1. So are a pr-merged wire's `when`, `fired`, `since` and `sourceRepo` (W16).
 */
const FORMATS: Record<number, typeof WIRE_FORMAT> = {
  1: {
    book: { fields: ["links", "notes", "wv"], required: ["links", "notes", "wv"] },
    wire: { fields: ["createdAt", "delivery", "files", "fired", "from", "gate", "pending", "rounds", "since", "sourceRepo", "template", "to", "toolOutput", "type", "when"], required: ["createdAt", "from", "gate", "to", "type", "when"] },
    sourceRepo: { fields: ["provider", "repo"], required: ["provider", "repo"] },
    rounds: { fields: ["limit", "used"], required: ["limit", "used"] },
    pending: { fields: ["at", "body", "flags", "id", "verdict"], required: ["at", "body", "flags", "id"] },
    // attempt and automatic came before any release wrote a wire book; a W1-only dev build keeps such a wire verbatim
    delivery: { fields: ["at", "attempt", "automatic", "id", "state", "why"], required: ["at", "id", "state"] },
    // a note's stage went with W9 (stages move by W13's events, not a step finishing); no build ever wrote one
    note: { fields: ["hops", "summary", "verdict"], required: ["hops"] },
    summary: { fields: ["at", "conversation", "text"], required: ["at", "text"] },
  },
};

describe("the stored format", () => {
  it("is the one pinned for its WIRE_VERSION", () => {
    expect(WIRE_FORMAT, `the wire book's format isn't the one pinned for WIRE_VERSION ${WIRE_VERSION}`).toEqual(FORMATS[WIRE_VERSION]);
  });
  it("sits in a landscape of version 3 or later", () => {
    expect(LANDSCAPE_VERSION).toBeGreaterThanOrEqual(3);
  });
});

describe("kept entries' ends", () => {
  const kept = { links: { ok: { from: "a", to: "b", type: "context", gate: "sometimes" }, type: { from: "a", to: "b", type: "sees" }, ends: { from: 1, to: "b", type: "context" }, junk: "x", other: { from: "c", to: "a" } }, notes: { a: "x", b: "y" } };
  it("are read where they can be: both ends strings and a type this version knows", () => {
    expect(readableKept(kept)).toEqual({ ok: { from: "a", to: "b", type: "context" } });
  });
  it("name the kept entries a session is in, at either end, and its note", () => {
    expect(keptNaming(kept, "a")).toEqual({ links: ["ok", "type", "other"], notes: ["a"] });
    expect(keptNaming(kept, "c")).toEqual({ links: ["other"], notes: [] });
    expect(keptNaming(kept, "z")).toEqual({ links: [], notes: [] });
  });
});

describe("changes to the book", () => {
  const book = (links: Record<string, Wire>, notes: Record<string, SourceNote> = {}): WireBook => ({ ...emptyWireBook(), links, notes });

  describe("a rekey's refusal", () => {
    const ends = [end("old", { where: "closed" }), end("a"), end("c"), end("t", { kind: "terminal" }), end("d", { debrief: true }), end("r", { room: "R1" })];
    const check = (b: WireBook, next: string, more: Partial<GateContext> = {}) => rekeyRefusal(b, rekeyedBook(b, "old", next), "old", next, ctxOf(ends, {}, {}, more));
    it("allows a move the rules allow, and one that's blocked the same before and after", () => {
      expect(check(book({ w: wire("old", "a") }), "c")).toBeNull();
      const blocked = [end("old", { where: "closed" }), end("a", { room: "R1" }), end("c")];
      const b = book({ w: wire("old", "a") });
      expect(rekeyRefusal(b, rekeyedBook(b, "old", "c"), "old", "c", ctxOf(blocked))).toBeNull();
    });
    it("refuses one the rules would newly refuse: onto a debrief, across a room's line, onto its other end", () => {
      expect(check(book({ w: wire("old", "a") }), "d")).toMatch(/debrief interview/);
      expect(check(book({ w: wire("old", "a") }), "r")).toBe(ROOM_LINE);
      expect(check(book({ w: wire("old", "a") }), "a")).toMatch(/to itself/);
    });
    it("refuses another kind of workspace, a missing one, one sending, and what a kept wire already is", () => {
      expect(check(book({ w: wire("old", "a") }), "t")).toMatch(/same kind of workspace/);
      expect(check(book({ w: wire("old", "a") }), "nope")).toMatch(/no session "nope"/);
      expect(check(book({ w: wire("old", "a", "handoff", { delivery: { id: "p", state: "queued", at: 1 } }) }), "c")).toMatch(/sending right now/);
      expect(check(book({ w: wire("old", "a", "feedback") }), "c", { kept: { k: { from: "a", to: "c", type: "feedback" } } })).toMatch(/feedback wire already/);
    });
  });

  it("brings back a wire that was being pasted as unconfirmed, one still queued as failed (it's never pasted once its wire goes), and any other as it was", () => {
    expect(restoredWire(wire("a", "b", "handoff", { delivery: { id: "p", state: "pasting", at: 3 } })).delivery).toEqual({ id: "p", state: "unconfirmed", at: 3, why: expect.stringMatching(/may have reached the other end/) });
    expect(restoredWire(wire("a", "b", "handoff", { delivery: { id: "p", state: "queued", at: 3 } })).delivery).toEqual({ id: "p", state: "failed", at: 3, why: expect.stringMatching(/removed before it was pasted, so it never reached the other end/) });
    const sent = wire("a", "b", "handoff", { delivery: { id: "p", state: "sent", at: 3 } });
    expect(restoredWire(sent)).toBe(sent);
    const none = wire("a", "b");
    expect(restoredWire(none)).toBe(none);
  });
  it("won't restore over a wire under the same id, or what the rules refuse now", () => {
    const b = book({ w: wire("a", "b") });
    expect(restoreRefusal(b, "w", wire("a", "b", "context"), ctxOf(AB))).toBe("That wire is there already.");
    expect(restoreRefusal(b, "x", wire("a", "b"), ctxOf(AB))).toMatch(/already/);
    expect(restoreRefusal(b, "x", wire("a", "b", "context"), ctxOf(AB))).toBeNull();
  });

  it("drops a session's wires, both ways, and its note, naming what went", () => {
    const b = book({ out: wire("a", "b"), in: wire("c", "a"), rest: wire("b", "c") }, { a: { hops: 1 }, b: { hops: 2 } });
    const { book: next, dropped } = withoutSession(b, "a");
    expect(Object.keys(next.links)).toEqual(["rest"]);
    expect(Object.keys(next.notes)).toEqual(["b"]);
    expect(dropped.map((d) => d.id).sort()).toEqual(["in", "out"]);
  });
  it("hands back the same book when a session has nothing in it", () => {
    const b = book({ rest: wire("b", "c") });
    expect(withoutSession(b, "a").book).toBe(b);
  });
  it("moves a session's wires and note, keeping what they've counted and hold", () => {
    const f = wire("a", "b", "feedback", { rounds: { limit: 3, used: 2 }, pending: { id: "p", body: "b", at: 1, flags: [] } });
    const next = rekeyedBook(book({ f, in: wire("c", "a"), rest: wire("b", "c") }, { a: { hops: 2 } }), "a", "n");
    expect(next.links.f).toEqual({ ...f, from: "n" });
    expect(next.links.in).toMatchObject({ from: "c", to: "n" });
    expect(next.links.rest).toMatchObject({ from: "b", to: "c" });
    expect(next.notes).toEqual({ n: { hops: 2 } });
  });
  it("leaves the new session its own note", () => {
    expect(rekeyedBook(book({}, { a: { hops: 2 }, n: { hops: 0 } }), "a", "n").notes).toEqual({ n: { hops: 0 } });
  });
});

describe("gateOf", () => {
  const pending = { id: "p1", body: "go", at: 1, flags: [] };
  const gate = (w: Wire, ctx = ctxOf(AB)) => gateOf("w", w, ctx);

  it("is idle with nothing waiting", () => {
    expect(gate(wire("a", "b"))).toEqual({ state: "idle", gate: "ask" });
  });
  it("is ready with something waiting, naming it", () => {
    expect(gate(wire("a", "b", "handoff", { pending }))).toEqual({ state: "ready", gate: "ask", pendingId: "p1" });
  });
  it.each(["queued", "pasting"] as const)("is sending while %s, a newer pending beside it included", (state) => {
    const w = wire("a", "b", "handoff", { pending, delivery: { id: "p1", state, at: 1 } });
    expect(gate(w).state).toBe("sending");
    expect(gate(wire("a", "b", "handoff", { pending: { ...pending, id: "p2" }, delivery: { id: "p1", state, at: 1 } }))).toEqual({ state: "sending", gate: "ask", pendingId: "p2" });
  });
  it("is blocked while queued once the rules refuse the wire, or an automatic send's gate asks, as it won't be pasted; sending once it's being pasted", () => {
    const queued = wire("a", "b", "handoff", { pending, delivery: { id: "p1", state: "queued", at: 1 } });
    const roomB = ctxOf([end("a"), end("b", { room: "R1" })]);
    expect(gate(queued, roomB)).toMatchObject({ state: "blocked", why: ROOM_LINE, pendingId: "p1" });
    expect(gate(queued, ctxOf([end("a", { takenOver: "“a” continues on Nick's laptop" }), end("b")]))).toMatchObject({ state: "blocked", why: "“a” continues on Nick's laptop" });
    expect(gate(queued, ctxOf([end("a")]))).toMatchObject({ state: "blocked", why: 'This Mac has no session "b".' });
    expect(gate({ ...queued, delivery: { id: "p1", state: "pasting", at: 1 } }, roomB).state).toBe("sending");
    const auto = wire("a", "b", "handoff", { gate: "automatic", pending, delivery: { id: "p1", state: "queued", at: 1, automatic: true } });
    expect(gate(auto)).toMatchObject({ state: "sending", gate: "automatic" });
    expect(gate(auto, ctxOf([end("a", { room: "R1" }), end("b", { room: "R1" })]))).toMatchObject({ state: "blocked", why: expect.stringMatching(/Automatic is off in a team room's area/) });
    expect(gate({ ...auto, gate: "ask" })).toMatchObject({ state: "blocked", why: expect.stringMatching(/gate was set to ask/) });
    // a person's Send at a gate that asks is theirs to make
    expect(gate({ ...auto, gate: "ask", delivery: { id: "p1", state: "queued", at: 1 } }).state).toBe("sending");
  });
  it("is blocked while sending when the book can't be written, as no delivery goes further then", () => {
    const w = wire("a", "b", "handoff", { pending, delivery: { id: "p1", state: "pasting", at: 1 } });
    expect(gate(w, ctxOf(AB, {}, {}, { fileRefusal: "read-only" }))).toMatchObject({ state: "blocked", why: "read-only" });
  });
  it("is blocked while queued once its source's verdict stops it: a handoff after \"changes\", a feedback wire after \"approve\"", () => {
    const ends = [end("a"), end("b"), end("c")];
    const fb = wire("a", "c", "feedback", { pending, delivery: { id: "p1", state: "queued", at: 1 } });
    const ho = wire("a", "b", "handoff", { pending, delivery: { id: "p1", state: "queued", at: 1 } });
    const links = { w: ho, f: fb };
    expect(gateOf("w", ho, ctxOf(ends, links, { a: { hops: 0, verdict: "changes" } }))).toMatchObject({ state: "blocked", why: expect.stringMatching(/finished again with "changes"/) });
    expect(gateOf("f", fb, ctxOf(ends, links, { a: { hops: 0, verdict: "approve" } }))).toMatchObject({ state: "blocked", why: expect.stringMatching(/finished again with "approve"/) });
    expect(gateOf("w", ho, ctxOf(ends, links, { a: { hops: 0, verdict: "approve" } })).state).toBe("sending");
    expect(gateOf("f", fb, ctxOf(ends, links, { a: { hops: 0, verdict: "changes" } })).state).toBe("sending");
    expect(gateOf("f", fb, ctxOf(ends, links)).state).toBe("sending"); // no verdict known: nothing to go by
    expect(gateOf("w", ho, ctxOf(ends, { w: ho }, { a: { hops: 0, verdict: "changes" } })).state).toBe("sending"); // no feedback wire out
  });
  it("is blocked and stalled when what's queued waits at an end whose hooks aren't reporting, and sending once it's pasting", () => {
    const silent = ctxOf([end("a"), end("b", { hooksSilent: true })]);
    expect(gate(wire("a", "b", "handoff", { pending, delivery: { id: "p1", state: "queued", at: 1 } }), silent)).toMatchObject({ state: "blocked", stalled: true, pendingId: "p1", why: expect.stringMatching(/Mark it idle/) });
    expect(gate(wire("a", "b", "handoff", { pending, delivery: { id: "p1", state: "pasting", at: 1 } }), silent).state).toBe("sending");
  });
  it("is ready after an automatic gate held it, saying why", () => {
    expect(gate(wire("a", "b", "handoff", { pending, delivery: { id: "p1", state: "held", at: 1, why: "3 automatic sends in a row" } }))).toEqual({ state: "ready", gate: "ask", pendingId: "p1", why: "3 automatic sends in a row" });
  });
  it("isn't stopped at the limit by a pending whose round was counted already (it went, then failed)", () => {
    const at = { limit: 2, used: 2 };
    expect(gate(wire("a", "b", "feedback", { rounds: at, pending, delivery: { id: "p1", state: "failed", at: 1, why: "it exited" } }))).toMatchObject({ state: "ready", atLimit: true, why: "it exited" });
    expect(gate(wire("a", "b", "feedback", { rounds: at, pending, delivery: { id: "p1", state: "held", at: 1, why: "flagged" } }))).toMatchObject({ state: "blocked", atLimit: true });
    expect(gate(wire("a", "b", "feedback", { rounds: at, pending, delivery: { id: "p0", state: "failed", at: 1 } }))).toMatchObject({ state: "blocked", atLimit: true });
  });
  it("is sent once delivered, and says when it was left in the prompt", () => {
    expect(gate(wire("a", "b", "handoff", { delivery: { id: "p1", state: "sent", at: 1 } }))).toEqual({ state: "sent", gate: "ask" });
    expect(gate(wire("a", "b", "handoff", { delivery: { id: "p1", state: "placed", at: 1 } }))).toEqual({ state: "sent", gate: "ask", placed: true });
  });
  it("is ready for a newer pending than the one delivered", () => {
    expect(gate(wire("a", "b", "handoff", { pending, delivery: { id: "p0", state: "sent", at: 1 } })).state).toBe("ready");
  });
  it("is ready again after a failure, saying what went wrong", () => {
    expect(gate(wire("a", "b", "handoff", { pending, delivery: { id: "p1", state: "failed", at: 1, why: "it exited" } }))).toMatchObject({ state: "ready", why: "it exited" });
  });
  it("is blocked and unconfirmed when it may have gone, so a person says", () => {
    expect(gate(wire("a", "b", "handoff", { pending, delivery: { id: "p1", state: "unconfirmed", at: 1 } }))).toMatchObject({ state: "blocked", unconfirmed: true, pendingId: "p1", why: expect.stringMatching(/may have reached “b”/) });
  });
  it("is blocked when the book can't be saved", () => {
    expect(gate(wire("a", "b", "handoff", { pending }), ctxOf(AB, {}, {}, { fileRefusal: "landscape.json is read-only" }))).toMatchObject({ state: "blocked", why: "landscape.json is read-only" });
  });
  it("is blocked by whatever refuses a wire now, and clears when that does", () => {
    const w = wire("a", "b", "handoff", { pending });
    expect(gate(w, ctxOf([end("a")]))).toMatchObject({ state: "blocked", why: expect.stringMatching(/no session "b"/) });
    expect(gate(w, ctxOf([end("a", { room: "R" }), end("b")]))).toMatchObject({ state: "blocked", why: expect.stringMatching(/same team room/) });
    expect(gate(w, ctxOf([end("a"), end("b", { takenOver: "Nick continues it" })]))).toMatchObject({ state: "blocked", why: "Nick continues it" });
    expect(gate(w).state).toBe("ready");
  });
  it("doesn't refuse a wire for being itself", () => {
    const w = wire("a", "b");
    expect(gate(w, ctxOf(AB, { w })).state).toBe("idle");
  });
  it("is blocked when an end is closed with no place, and not when it has a ghost or merely stopped", () => {
    const w = wire("a", "b", "handoff", { pending });
    expect(gate(w, ctxOf([end("a"), end("b", { where: "closed", placed: false })]))).toMatchObject({ state: "blocked", why: expect.stringMatching(/not on the landscape/) });
    expect(gate(w, ctxOf([end("a", { where: "closed", placed: false }), end("b")])).state).toBe("blocked");
    expect(gate(w, ctxOf([end("a"), end("b", { where: "closed", placed: true })])).state).toBe("ready");
    expect(gate(w, ctxOf([end("a"), end("b", { where: "dead" })])).state).toBe("ready");
  });
  it("never lights a context or worktree wire, but blocks it the same", () => {
    const t = end("t", { kind: "terminal", folder: "/w/a" });
    expect(gate(wire("a", "b", "context", { pending })).state).toBe("idle");
    expect(gate(wire("a", "t", "worktree"), ctxOf([end("a"), t])).state).toBe("idle");
    expect(gate(wire("a", "b", "context"), ctxOf([end("a", { room: "R" }), end("b")])).state).toBe("blocked");
  });
  it("blocks a handoff with “needs approve” once a feedback wire out has come back with changes, and only then", () => {
    const h = wire("a", "b");
    const links = { w: h, f: wire("a", "c", "feedback") };
    const ends = [...AB, end("c")];
    expect(gateOf("w", h, ctxOf(ends, links, { a: { hops: 0, verdict: "changes" } }))).toMatchObject({ state: "blocked", why: "needs approve" });
    expect(gateOf("w", h, ctxOf(ends, links, { a: { hops: 0, verdict: "approve" } })).state).toBe("idle");
    expect(gateOf("w", h, ctxOf(ends, links)).state).toBe("idle");
    // with no feedback wire out, a stray verdict blocks nothing
    expect(gateOf("w", h, ctxOf(AB, { w: h }, { a: { hops: 0, verdict: "changes" } })).state).toBe("idle");
    // the feedback wire itself goes on: changes is what it's for
    expect(gateOf("f", links.f, ctxOf(ends, links, { a: { hops: 0, verdict: "changes" } })).state).toBe("idle");
  });
  it("stops at the limit once something's waiting, and only shows the limit until then", () => {
    const at = { limit: 3, used: 3 };
    expect(gate(wire("a", "b", "feedback", { rounds: at, pending }))).toMatchObject({ state: "blocked", atLimit: true, pendingId: "p1", why: expect.stringMatching(/At the limit: 3 of 3/) });
    expect(gate(wire("a", "b", "feedback", { rounds: at }))).toEqual({ state: "idle", gate: "ask", atLimit: true });
    expect(gate(wire("a", "b", "feedback", { rounds: { limit: 3, used: 2 }, pending })).state).toBe("ready");
  });
  it("is blocked when the far end's hooks aren't reporting, since a message might never go", () => {
    const w = wire("a", "b", "handoff", { pending });
    expect(gate(w, ctxOf([end("a"), end("b", { hooksSilent: true })]))).toMatchObject({ state: "blocked", why: expect.stringMatching(/hooks aren't reporting/) });
    expect(gate(w, ctxOf([end("a", { hooksSilent: true }), end("b")])).state).toBe("ready");
  });
  it("asks at an automatic gate once either end is in a room, and keeps it automatic otherwise", () => {
    const w = wire("a", "b", "handoff", { gate: "automatic" });
    expect(gate(w).gate).toBe("automatic");
    expect(gate(w, ctxOf([end("a", { room: "R" }), end("b", { room: "R" })])).gate).toBe("ask");
    expect(gate(w, ctxOf([end("a", { room: "R" }), end("b")])).gate).toBe("ask");
  });
});

describe("a context link's tool output", () => {
  it("is set on a context link alone, false leaving it out and true putting it back", () => {
    const ctx = ctxOf(AB);
    expect(settingsRefusal(wire("a", "b", "context"), parseWireSettings({ toolOutput: false }), ctx)).toBeNull();
    for (const type of ["handoff", "feedback"] as const) expect(settingsRefusal(wire("a", "b", type), { toolOutput: false }, ctx), type).toMatch(/Only a context link reads tool output/);
    const off = withSettings(wire("a", "b", "context"), { toolOutput: false });
    expect(off.toolOutput).toBe(false);
    expect(withSettings(off, { toolOutput: true })).not.toHaveProperty("toolOutput");
    expect(() => parseWireSettings({ toolOutput: "no" })).toThrow(/toolOutput is not true or false/);
  });
  it("is stored only as false, and only on a context link: anything else is kept and does nothing", () => {
    const read = okRead(parseWireBook({ wv: 1, links: { ok: wire("a", "b", "context", { toolOutput: false }), on: { ...wire("a", "b", "context"), toolOutput: true }, hand: { ...wire("a", "b"), toolOutput: false } }, notes: {} }));
    expect(Object.keys(read.book.links)).toEqual(["ok"]);
    expect(Object.keys(read.kept.links).sort()).toEqual(["hand", "on"]);
  });
});

describe("finishing a step", () => {
  const ends = [end("a"), end("b"), end("c"), end("d")];
  const pending = { id: "p1", body: "x", at: 1, flags: [] };
  it("needs a verdict only with a feedback wire out, and refuses changes without one", () => {
    expect(verdictRefusal("a", undefined, { f: wire("a", "b", "feedback") })).toMatch(/needs a verdict/);
    expect(verdictRefusal("a", "approve", { f: wire("a", "b", "feedback") })).toBeNull();
    expect(verdictRefusal("a", undefined, { f: wire("b", "a", "feedback"), h: wire("a", "c") })).toBeNull();
    expect(verdictRefusal("a", "changes", { h: wire("a", "c") })).toMatch(/has none out/);
    expect(verdictRefusal("a", "yes", {})).toMatch(/not "yes"/);
  });
  it("readies each wire out apart, keeps a manual one, and leaves context links and shared terminals out", () => {
    const links = { h1: wire("a", "b"), h2: wire("a", "c"), m: wire("a", "d", "handoff", { when: "manual" }), x: wire("a", "d", "context"), in: wire("c", "a", "context") };
    expect(finishPlan("a", undefined, ctxOf(ends, links))).toEqual([
      { wire: "h1", to: "b", type: "handoff", does: "readies" },
      { wire: "h2", to: "c", type: "handoff", does: "readies" },
      { wire: "m", to: "d", type: "handoff", does: "keeps" },
    ]);
  });
  it("on changes readies the feedback wire and holds the handoffs; on approve the reverse; each takes back what the other left", () => {
    const links = { f: wire("a", "b", "feedback", { pending }), h: wire("a", "c", "handoff", { pending: { ...pending, id: "p2" } }) };
    expect(finishPlan("a", "changes", ctxOf(ends, links))).toEqual([
      { wire: "f", to: "b", type: "feedback", does: "readies" },
      { wire: "h", to: "c", type: "handoff", does: "holds", why: "needs approve", withdraws: "p2" },
    ]);
    expect(finishPlan("a", "approve", ctxOf(ends, links))).toEqual([
      { wire: "f", to: "b", type: "feedback", does: "passes", withdraws: "p1" },
      { wire: "h", to: "c", type: "handoff", does: "readies" },
    ]);
  });
  it("goes along wires in the order they were made, whatever their ids: one that reads as an integer isn't put first", () => {
    const links = { ab12cd34: wire("a", "b", "handoff", { createdAt: 1 }), "12345678": wire("a", "c", "handoff", { createdAt: 2 }) };
    expect(Object.keys(links)).toEqual(["12345678", "ab12cd34"]); // the object's own order
    expect(finishPlan("a", undefined, ctxOf(ends, links)).map((s) => s.wire)).toEqual(["ab12cd34", "12345678"]);
    // made in the same millisecond, an older book's are in their ids' order
    expect(wiresInOrder({ b: wire("a", "b"), a: wire("a", "c"), "9": wire("a", "d", "handoff", { createdAt: 0 }) }).map(([k]) => k)).toEqual(["9", "a", "b"]);
  });
  it("takes back nothing on its way, and puts nothing on a wire the rules refuse", () => {
    const sending = wire("a", "b", "feedback", { pending, delivery: { id: "p1", state: "pasting", at: 1 } });
    expect(finishPlan("a", "approve", ctxOf(ends, { f: sending }))).toEqual([{ wire: "f", to: "b", type: "feedback", does: "passes" }]);
    const roomed = [end("a"), end("b", { room: "R" })];
    expect(finishPlan("a", undefined, ctxOf(roomed, { h: wire("a", "b") }))).toEqual([{ wire: "h", to: "b", type: "handoff", does: "refused", why: ROOM_LINE }]);
  });
});
