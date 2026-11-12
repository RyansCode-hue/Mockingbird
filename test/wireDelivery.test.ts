import * as fs from "fs";
import * as path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LandscapeStore } from "../src/main/landscape";
import { Messaging, mcpLaunch, retireMcpLaunch } from "../src/main/messaging";
import { SessionManager } from "../src/main/sessions";
import { AUTOMATIC_HOPS, START_WAIT_MS, WireDelivery, type FrameWire, type OfferHow } from "../src/main/wireDelivery";
import { WireTools, type PendingsMade } from "../src/main/wireTools";
import { WireService } from "../src/main/wires";
import type { SessionInfo } from "../src/shared/types";
import { gateOf, ROOM_LINE, WIRE_BODY_MAX, type FinishedStep, type FinishOutcome, type SendReply, type Wire, type WireReply, type WireVerdict } from "../src/shared/wires";
import { askAs, startServer } from "./mcpClient";
import { git, makeRepo, tempDir, write } from "./helpers";

/** Every pty the manager starts, which session it's for, what was written to it, and the wire's delivery on disk at each write. */
type FakePty = { session: string; writes: string[]; onDisk: (string | undefined)[]; killed: boolean; emit(d: string): void; exit(code: number): void };
const ptys: FakePty[] = [];
/** What a write to a pty notes of the file then: the delivery state of the wire named here. */
const watching: { file: string; wire: string } = { file: "", wire: "" };
const deliveryOnDisk = (): string | undefined => {
  if (!watching.file || !fs.existsSync(watching.file)) return undefined;
  return JSON.parse(fs.readFileSync(watching.file, "utf8")).wires?.links?.[watching.wire]?.delivery?.state;
};
vi.mock("node-pty", () => ({
  spawn: (_file: string, _args: string[], opts: { env: Record<string, string> }) => {
    let onData: (d: string) => void = () => {};
    let onExit: (e: { exitCode: number }) => void = () => {};
    const p: FakePty = { session: opts.env.MOCKINGBIRD_SESSION, writes: [], onDisk: [], killed: false, emit: (d) => onData(d), exit: (exitCode) => onExit({ exitCode }) };
    ptys.push(p);
    return {
      onData: (cb: any) => ((onData = cb), { dispose() {} }),
      onExit: (cb: any) => ((onExit = cb), { dispose() {} }),
      write: (d: string) => {
        p.writes.push(d.replace(/\x1b\[20[01]~/g, "|"));
        p.onDisk.push(deliveryOnDisk());
      },
      resize() {},
      kill: () => void (p.killed = true),
      pid: 1,
    };
  },
}));
vi.mock("../src/main/shell", async (original) => ({
  ...(await original<typeof import("../src/main/shell")>()),
  which: (bin: string) => Promise.resolve(`/found/${bin}`),
  whichSync: (bin: string) => `/found/${bin}`,
}));

/** The stand-in for W2's label and fence: which way it went, from whom, then the body. */
const frame: FrameWire = ({ from, to, body, automatic }) => `[${automatic ? "automatic" : "sent"} from ${from.title} to ${to.title}] ${body}`;

const v3File = (wires: unknown, ghosts: Record<string, unknown> = {}) => JSON.stringify({ v: 3, workspaces: {}, areas: {}, stacks: {}, ghosts, tools: {}, cards: {}, wires });
const ghost = (title: string) => ({ title, agent: "claude", cwd: "/w", repoPath: null, placement: { x: 0, y: 0, w: 8, h: 8 }, group: "Wires", closedAt: "2026-11-01T00:00:00.000Z" });

interface Setup {
  /** Sessions already on record (closed), as a run before this one left them. */
  records?: SessionInfo[];
  /** landscape.json as a run before this one left it. */
  file?: string;
  /** What the other end is sent: the stand-in below, or "real" for W2's label and fence (WireTools.messageFor). */
  frame?: FrameWire | "real";
  /** How a closed session is reopened; the manager's relaunch unless a test holds it back. */
  reopen?: (id: string, m: SessionManager) => Promise<SessionInfo | null>;
  /** Each new wire's id, in turn; random ones otherwise. */
  ids?: string[];
}

function setup(o: Setup = {}) {
  const dir = tempDir("delivery");
  const file = path.join(dir, "landscape.json");
  if (o.file) fs.writeFileSync(file, o.file);
  watching.file = file;
  const saved: SessionInfo[] = [...(o.records ?? [])];
  const sessionStore = {
    settings: { claudeBin: "/bin/echo", codexBin: "/bin/echo", workTrackerPath: tempDir("worktracker") },
    state: { sessions: saved },
    upsertSession(i: SessionInfo) {
      const k = saved.findIndex((x) => x.id === i.id);
      if (k >= 0) saved[k] = i;
      else saved.push(i);
    },
    removeSession(id: string) {
      const k = saved.findIndex((x) => x.id === id);
      if (k >= 0) saved.splice(k, 1);
    },
    save() {},
  };
  const m = new SessionManager(sessionStore as any);
  m.scrollbackDir = path.join(dir, "scrollback");
  const logged: string[] = [];
  const log = (context: string, err: unknown) => void logged.push(`${context}: ${err instanceof Error ? err.message : String(err)}`);
  const store = new LandscapeStore({ file, emit: () => {}, log });
  const rooms: Record<string, string> = {};
  const takenOver: Record<string, string> = {};
  const ids = [...(o.ids ?? [])];
  const service: WireService = new WireService({
    store,
    sessions: m,
    roomOf: (id) => rooms[id] ?? null,
    takenOver: (id) => (takenOver[id] ? `${takenOver[id]} — take it back rather than wiring it` : null),
    log,
    delivery: { withdraw: (id, w) => d.withdraw(id, w), restoring: (w) => d.restoring(w), restored: (id) => d.restored(id) },
    ...(o.ids ? { newId: () => ids.shift() ?? `w${Math.random().toString(16).slice(2, 9)}` } : {}),
  });
  const told: { id: string; title: string; body: string }[] = [];
  const made: PendingsMade[] = [];
  const opts = { submit: true };
  const reopened: string[] = [];
  const d: WireDelivery = new WireDelivery({
    store,
    context: (book) => service.context(book),
    sessions: m,
    reopen: async (id) => {
      reopened.push(id);
      return o.reopen ? o.reopen(id, m) : m.relaunch(id);
    },
    submits: () => opts.submit,
    frame:
      o.frame === "real"
        ? ({ wireId, body, automatic }) => {
            const r = tools.messageFor(wireId, body, { automatic });
            if ("refused" in r) throw new Error(r.refused);
            return r.text;
          }
        : (o.frame ?? frame),
    takenOver: () => (sid, doing) => (takenOver[sid] ? `${takenOver[sid]} — take it back rather than ${doing}` : null),
    log,
    notify: (id, title, body) => void told.push({ id, title, body }),
  });
  // W2's finishing, which plans and fills a finish and has delivery write it: the one way a pending lands
  const tools: WireTools = new WireTools({
    store,
    rules: service,
    sessions: m,
    conversationFiles: () => ({ agent: "claude", files: [], refused: null }),
    submitOnDelivery: () => opts.submit,
    offer: (me, f, how, prompt) => d.offer(me, f, how, prompt),
    promptOf: (id) => d.promptOf(id),
    onPendings: (e) => void made.push(e),
    log,
  });

  const pane = async (title: string, over: Record<string, unknown> = {}) => m.create({ repoPath: null, useWorktree: false, agent: "claude", title, ...over });
  const ptyOf = (id: string) => ptys.filter((p) => p.session === id).at(-1)!;
  const idle = (id: string, more: Record<string, unknown> = {}) => m.statusFromHook({ paneId: id, status: "idle", ...more });
  const add = (from: string, to: string, type: "handoff" | "feedback" | "context" = "handoff", settings?: Record<string, unknown>) => {
    const r = service.add(from, to, type, settings);
    if ("refused" in r) throw new Error(r.refused);
    watching.wire = r.id!;
    return r.id!;
  };
  const book = () => store.wires().book!;
  const wireOf = (id: string) => book().links[id];
  const gate = (id: string) => gateOf(id, wireOf(id), service.context(book()));
  /**
   * Finish wire `wire`'s source's step with `body` as its summary (the wire's template is the summary alone): as its agent
   * (finish_step), a person (Finish step), or a merge (delivery's offer with the fill, as W16 will). What it did along `wire`.
   */
  const finishing = async (wire: string, body = "the summary", how: OfferHow = { origin: "agent" }, more: { verdict?: WireVerdict } = {}): Promise<FinishedStep> => {
    const from = wireOf(wire).from;
    const me = [...m.list(), ...m.resumable()].find((s) => s.id === from)!;
    // a feedback wire readies on "changes", which its source's finish says unless told otherwise
    const verdict = more.verdict ?? (wireOf(wire).type === "feedback" ? "changes" : undefined);
    const raw = { summary: body, ...(verdict ? { verdict } : {}) };
    let r: FinishOutcome;
    if (how.origin === "merge") {
      const prompt = d.promptOf(me.id);
      const fill = await tools.planFinish(me, raw);
      if ("refused" in fill) throw new Error(fill.refused);
      r = d.offer(me, fill, how, prompt);
    } else r = await tools.finish(me, raw, how.origin === "person" ? "you" : "agent");
    if ("refused" in r) throw new Error(r.refused);
    return r.steps.find((x) => x.wire === wire)!;
  };
  /** The same, answering the pending it readied on `wire`. */
  const offer = async (wire: string, body = "the summary", how: OfferHow = { origin: "agent" }, more: { verdict?: WireVerdict } = {}): Promise<string> => {
    const step = await finishing(wire, body, how, more);
    if (!step.pending) throw new Error(`not readied: ${JSON.stringify(step)}`);
    return step.pending.id;
  };
  const onDisk = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const placeGhost = (id: string, title: string) => {
    store.update({ ghosts: { [id]: ghost(title) } });
    store.flush();
  };
  return { dir, file, m, store, service, d, tools, finishing, made, rooms, takenOver, told, logged, opts, reopened, pane, ptyOf, idle, add, book, wireOf, gate, offer, onDisk, placeGhost };
}

const refusal = (r: WireReply | SendReply | { refused: string } | { offered: unknown }) => ("refused" in r ? r.refused : `not refused: ${JSON.stringify(r).slice(0, 200)}`);
const asRoot = process.getuid?.() === 0;

/** Two panes, B at its prompt, and a handoff from A to B with something waiting. */
async function ready(o: Setup = {}, type: "handoff" | "feedback" = "handoff", settings?: Record<string, unknown>) {
  const t = setup(o);
  const a = await t.pane("Builder");
  const b = await t.pane("Reviewer");
  t.idle(b.id);
  const w = t.add(a.id, b.id, type, settings);
  const p = await t.offer(w);
  return { ...t, a, b, w, p };
}

beforeAll(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }));
afterAll(() => vi.useRealTimers());
afterEach(() => {
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.restoreAllMocks();
  watching.file = watching.wire = "";
});

describe("a person's Send, by where the other end is", () => {
  it("idle with nothing typed: written ahead, pasted with its paste written down first, then Enter, and sent", async () => {
    const t = await ready();
    expect(t.gate(t.w)).toMatchObject({ state: "ready", pendingId: t.p });
    const r = await t.d.send(t.w, t.p, "the summary, as you left it");
    expect(r).not.toHaveProperty("refused");
    const pty = t.ptyOf(t.b.id);
    expect(pty.writes).toEqual(["|[sent from Builder to Reviewer] the summary, as you left it|"]);
    // the paste was written down before it was made
    expect(pty.onDisk).toEqual(["pasting"]);
    vi.advanceTimersByTime(150);
    expect(pty.writes.at(-1)).toBe("\r");
    expect(t.wireOf(t.w)).toMatchObject({ delivery: { id: t.p, state: "sent" } });
    expect(t.wireOf(t.w).pending).toBeUndefined();
    expect(t.onDisk().wires.links[t.w].delivery.state).toBe("sent");
    expect(t.gate(t.w).state).toBe("sent");
    expect(t.book().notes[t.b.id]).toEqual({ hops: 0 });
    expect(t.told).toEqual([]);
  });

  it("idle with your unsent text there: held while you type, then put after it with no Enter, and placed", async () => {
    const t = await ready();
    t.m.write(t.b.id, "half a thought");
    await t.d.send(t.w, t.p, "the summary");
    const pty = t.ptyOf(t.b.id);
    expect(pty.writes).toEqual(["half a thought"]);
    expect(t.gate(t.w).state).toBe("sending");
    vi.advanceTimersByTime(121_000);
    expect(pty.writes).toEqual(["half a thought", "|[sent from Builder to Reviewer] the summary|"]);
    vi.advanceTimersByTime(500);
    expect(pty.writes).not.toContain("\r");
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "placed", why: expect.stringMatching(/unsent text in “Reviewer”'s prompt/) });
    expect(t.gate(t.w)).toMatchObject({ state: "sent", placed: true });
    expect(t.told).toEqual([expect.objectContaining({ id: t.b.id, title: "Waiting in “Reviewer”'s prompt" })]);
  });

  it("mid-turn: queued, nothing pasted until its turn ends, then sent", async () => {
    const t = await ready();
    t.m.statusFromHook({ paneId: t.b.id, status: "working", prompted: true });
    await t.d.send(t.w, t.p, "the summary");
    expect(t.ptyOf(t.b.id).writes).toEqual([]);
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "queued" });
    expect(t.gate(t.w).state).toBe("sending");
    t.d.reconcile(); // what's really on its way is left to go
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "queued" });
    t.idle(t.b.id, { finished: true });
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(t.b.id).writes).toEqual(["|[sent from Builder to Reviewer] the summary|", "\r"]);
    expect(t.wireOf(t.w).delivery!.state).toBe("sent");
  });

  it("on a permission prompt: never pasted while it asks, its Enter would answer it; sent once it's answered", async () => {
    const t = await ready();
    t.m.statusFromHook({ paneId: t.b.id, status: "waiting", reason: "Claude needs your permission to use Bash" });
    await t.d.send(t.w, t.p, "the summary");
    vi.advanceTimersByTime(60_000);
    expect(t.ptyOf(t.b.id).writes).toEqual([]);
    expect(t.wireOf(t.w).delivery!.state).toBe("queued");
    t.idle(t.b.id);
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(t.b.id).writes).toEqual(["|[sent from Builder to Reviewer] the summary|", "\r"]);
    expect(t.wireOf(t.w).delivery!.state).toBe("sent");
  });

  it("a permission prompt coming up in the moment before its Enter: no Enter, left in the prompt, and placed", async () => {
    const t = await ready();
    await t.d.send(t.w, t.p, "the summary");
    t.m.statusFromHook({ paneId: t.b.id, status: "waiting", reason: "Claude needs your permission to use Bash" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(t.b.id).writes).toEqual(["|[sent from Builder to Reviewer] the summary|"]);
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "placed", why: expect.stringMatching(/asking for permission/) });
  });

  it("just starting: queued until its prompt is drawn, then sent", async () => {
    const t = setup();
    const a = await t.pane("Builder");
    const b = await t.pane("Reviewer"); // working from its start, no hook yet
    const w = t.add(a.id, b.id);
    const p = await t.offer(w);
    await t.d.send(w, p, "the summary");
    expect(t.ptyOf(b.id).writes).toEqual([]);
    t.idle(b.id, { started: true });
    vi.advanceTimersByTime(1000);
    expect(t.ptyOf(b.id).writes).toEqual([]);
    vi.advanceTimersByTime(520); // its prompt settled: pasted, its Enter 120 ms later
    expect(t.ptyOf(b.id).writes).toEqual(["|[sent from Builder to Reviewer] the summary|"]);
    vi.advanceTimersByTime(150);
    expect(t.wireOf(w).delivery!.state).toBe("sent");
  });

  it("exited: resumed in its pane first, then sent once its prompt is drawn", async () => {
    const t = await ready();
    t.ptyOf(t.b.id).exit(0);
    expect(t.m.list().find((s) => s.id === t.b.id)!.status).toBe("dead");
    expect(t.gate(t.w).state).toBe("ready");
    const before = ptys.length;
    // starting it costs a reread of its conversation: the window asks first, then sends with { start: true }
    expect(await t.d.send(t.w, t.p, "the summary")).toEqual({ refused: expect.stringMatching(/“Reviewer” isn't running: sending this resumes it/), start: "resume" });
    expect(ptys.length).toBe(before);
    expect(t.wireOf(t.w).delivery).toBeUndefined();
    await t.d.send(t.w, t.p, "the summary", { start: true });
    expect(ptys.length).toBe(before + 1);
    expect(t.reopened).toEqual([]); // resumed, not reopened: it's still on the landscape
    t.idle(t.b.id, { started: true });
    vi.advanceTimersByTime(1520);
    expect(t.ptyOf(t.b.id).writes).toEqual(["|[sent from Builder to Reviewer] the summary|"]);
    vi.advanceTimersByTime(150);
    expect(t.wireOf(t.w).delivery!.state).toBe("sent");
  });

  it("closed with a ghost: reopened first, then sent; closed with no place: refused, saying where to reopen it", async () => {
    const t = await ready();
    t.m.kill(t.b.id, false);
    expect(t.gate(t.w)).toMatchObject({ state: "blocked", why: expect.stringMatching(/not on the landscape/) });
    expect(refusal(await t.d.send(t.w, t.p, "the summary"))).toMatch(/not on the landscape: reopen it from Closed sessions/);
    expect(t.reopened).toEqual([]);
    t.placeGhost(t.b.id, "Reviewer");
    expect(await t.d.send(t.w, t.p, "the summary")).toMatchObject({ start: "reopen" });
    expect(t.reopened).toEqual([]);
    await t.d.send(t.w, t.p, "the summary", { start: true });
    expect(t.reopened).toEqual([t.b.id]);
    t.idle(t.b.id, { started: true });
    vi.advanceTimersByTime(1520);
    expect(t.ptyOf(t.b.id).writes).toEqual(["|[sent from Builder to Reviewer] the summary|"]);
  });

  it("closed, and it can't be reopened: failed with why, ready to send again", async () => {
    const t = await ready();
    t.m.kill(t.b.id, false);
    t.placeGhost(t.b.id, "Reviewer");
    t.m.relaunchGuard = () => "“Reviewer” continues on Nick's laptop";
    expect(refusal(await t.d.send(t.w, t.p, "the summary", { start: true }))).toMatch(/Couldn't reopen it: “Reviewer” continues on Nick's laptop/);
    expect(t.wireOf(t.w).delivery).toMatchObject({ id: t.p, state: "failed", why: expect.stringMatching(/continues on Nick's laptop/) });
    expect(t.gate(t.w)).toMatchObject({ state: "ready", why: expect.stringMatching(/continues on Nick's laptop/) });
    expect(t.told.at(-1)).toMatchObject({ title: "Not sent along a wire" });
  });

  it("with its hooks silent: what's queued there shows stalled until it's marked idle, and what waits next is refused", async () => {
    const t = setup();
    const a = await t.pane("Builder");
    const b = await t.pane("Reviewer"); // working from its start, and its hooks never report
    const w = t.add(a.id, b.id);
    const p = await t.offer(w);
    await t.d.send(w, p, "the summary");
    expect(t.gate(w).state).toBe("sending");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    t.m.checkStalls(Date.now() + 10 * 60_000, 5 * 60_000);
    expect(t.gate(w)).toMatchObject({ state: "blocked", stalled: true, why: expect.stringMatching(/hooks aren't reporting, so what's queued for it may never go\. Mark it idle/) });
    expect(refusal(await t.d.send(w, p, "again"))).toMatch(/on its way/);
    t.m.clearWaiting(b.id);
    vi.advanceTimersByTime(150);
    expect(t.wireOf(w).delivery!.state).toBe("sent");
    const p2 = await t.offer(w);
    expect(t.gate(w)).toMatchObject({ state: "blocked", why: expect.stringMatching(/hooks aren't reporting, so a message might never go/) });
    expect(refusal(await t.d.send(w, p2, "the next"))).toMatch(/hooks aren't reporting/);
  });

  it("a terminal, a debrief, a teammate's session or one taken over: refused, and nothing is written ahead", async () => {
    const t = setup();
    const a = await t.pane("Builder");
    const term = await t.pane("shell", { shell: true });
    vi.spyOn(console, "error").mockImplementation(() => {}); // a debrief starts without Azure DevOps here
    const brief = await t.pane("Debrief", { debrief: true });
    const b = await t.pane("Reviewer");
    t.idle(b.id);
    const handBuilt = (to: string): Wire => ({ from: a.id, to, type: "handoff", when: "finished", gate: "ask", pending: { id: "p", body: "x", at: 1, flags: [] }, createdAt: 1 });
    t.store.editWires((bk) => ({ book: { ...bk, links: { t: handBuilt(term.id), d: handBuilt(brief.id), r: handBuilt("r~abc") } } }));
    expect(refusal(await t.d.send("t", "p", "x"))).toMatch(/is a terminal/);
    expect(refusal(await t.d.send("d", "p", "x"))).toMatch(/debrief/);
    expect(refusal(await t.d.send("r", "p", "x"))).toMatch(/teammate's session/);
    const w = t.add(a.id, b.id);
    const p = await t.offer(w);
    t.takenOver[b.id] = "“Reviewer” continues on Nick's laptop";
    expect(refusal(await t.d.send(w, p, "x"))).toBe("“Reviewer” continues on Nick's laptop — take it back rather than sending along this copy's wire");
    for (const id of ["t", "d", "r", w]) expect(t.wireOf(id).delivery).toBeUndefined();
    expect(ptys.filter((x) => [term.id, brief.id, b.id].includes(x.session)).flatMap((x) => x.writes)).toEqual([]);
  });

  it("refuses a context wire, a body that's empty or too long, or one that isn't text", async () => {
    const t = await ready();
    const ctxWire = t.add(t.a.id, t.b.id, "context");
    expect(refusal(await t.d.send(ctxWire, "p", "x"))).toMatch(/context wire carries nothing/);
    expect(refusal(await t.d.send(t.w, t.p, "  "))).toMatch(/nothing to send/);
    expect(refusal(await t.d.send(t.w, t.p, "x".repeat(WIRE_BODY_MAX + 1)))).toBe(`It's ${WIRE_BODY_MAX + 1} characters; the limit is ${WIRE_BODY_MAX}.`);
    expect(refusal(await t.d.send(t.w, t.p, 42))).toMatch(/isn't text/);
  });
});

describe("receipts: every way a queued message ends is told, never left as queued", () => {
  it("its pane closed with it queued: failed, saying so, and not kept for a relaunch", async () => {
    const t = await ready();
    t.m.statusFromHook({ paneId: t.b.id, status: "working" });
    await t.d.send(t.w, t.p, "the summary");
    t.m.kill(t.b.id, false);
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "failed", why: "“Reviewer” was closed before this reached it" });
    expect(t.gate(t.w)).toMatchObject({ state: "blocked" }); // closed with no place
    t.placeGhost(t.b.id, "Reviewer");
    expect(t.gate(t.w)).toMatchObject({ state: "ready", why: "“Reviewer” was closed before this reached it" });
    // reopening it doesn't deliver it behind your back
    await t.m.relaunch(t.b.id);
    t.idle(t.b.id);
    vi.advanceTimersByTime(200);
    expect(t.ptyOf(t.b.id).writes).toEqual([]);
  });

  it("its agent exiting with it queued: failed", async () => {
    const t = await ready();
    t.m.statusFromHook({ paneId: t.b.id, status: "working" });
    await t.d.send(t.w, t.p, "the summary");
    t.ptyOf(t.b.id).exit(1);
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "failed", why: "“Reviewer” stopped running before this reached it" });
    expect(t.gate(t.w).state).toBe("ready");
  });

  it("its pane forgotten with it queued: failed, then the wire goes with it", async () => {
    const t = await ready();
    t.m.statusFromHook({ paneId: t.b.id, status: "working" });
    await t.d.send(t.w, t.p, "the summary");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    t.m.kill(t.b.id, true);
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "failed" });
    t.service.sessionForgotten(t.b.id);
    expect(t.book().links).toEqual({});
  });

  it("its pane closed between its paste and its Enter: failed, as it was never submitted", async () => {
    const t = await ready();
    await t.d.send(t.w, t.p, "the summary");
    expect(t.wireOf(t.w).delivery!.state).toBe("pasting");
    t.m.kill(t.b.id, false);
    vi.advanceTimersByTime(150);
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "failed", why: expect.stringMatching(/stopped after this was pasted and before its Enter/) });
  });

  it("its area leaving agents' messages in the prompt: an automatic send is placed; a person's always submits", async () => {
    const t = await ready({}, "handoff");
    t.opts.submit = false;
    t.service.set(t.w, { gate: "automatic" });
    const p2 = await t.offer(t.w, "automatic");
    expect(p2).toBeTruthy();
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "placed", why: expect.stringMatching(/leaves agents' messages there/) });
    t.m.write(t.b.id, "\r"); // the person sends what was left there
    t.idle(t.b.id);
    t.service.set(t.w, { gate: "ask" });
    const p3 = await t.offer(t.w, "by hand");
    await t.d.send(t.w, p3, "by hand");
    vi.advanceTimersByTime(150);
    expect(t.wireOf(t.w).delivery).toMatchObject({ id: p3, state: "sent" });
  });
});

describe("no double sends", () => {
  it("Send twice sends once: the second finds it on its way, then sent; an older id is refused", async () => {
    const t = await ready();
    t.m.statusFromHook({ paneId: t.b.id, status: "working" });
    const [one, two] = await Promise.all([t.d.send(t.w, t.p, "the summary"), t.d.send(t.w, t.p, "the summary")]);
    expect(one).not.toHaveProperty("refused");
    expect(refusal(two)).toMatch(/on its way to “Reviewer” already/);
    t.idle(t.b.id);
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(t.b.id).writes.filter((x) => x !== "\r")).toHaveLength(1);
    expect(refusal(await t.d.send(t.w, t.p, "the summary"))).toMatch(/sent to “Reviewer” already/);
    const p2 = await t.offer(t.w, "newer");
    const p3 = await t.offer(t.w, "newest");
    expect(refusal(await t.d.send(t.w, p2, "newer"))).toMatch(/replaced by something newer/);
    expect(refusal(await t.d.send(t.w, "made-up", "x"))).toMatch(/replaced by something newer/);
    expect((await t.d.send(t.w, p3, "newest")) as object).not.toHaveProperty("refused");
  });

  it("what comes while one is on its way waits beside it: the gate says sending, its Send is refused, and the first one's end doesn't take it", async () => {
    const t = await ready();
    t.m.statusFromHook({ paneId: t.b.id, status: "working" });
    await t.d.send(t.w, t.p, "first");
    const p2 = await t.offer(t.w, "second");
    expect(t.gate(t.w)).toMatchObject({ state: "sending", pendingId: p2 });
    expect(refusal(await t.d.send(t.w, p2, "second"))).toMatch(/still on its way/);
    t.idle(t.b.id);
    vi.advanceTimersByTime(150);
    expect(t.wireOf(t.w)).toMatchObject({ delivery: { id: t.p, state: "sent" }, pending: { id: p2, body: "second" } });
    expect(t.gate(t.w)).toMatchObject({ state: "ready", pendingId: p2 });
  });

  it("a book that can't be written ahead sends nothing", async () => {
    if (asRoot) return;
    const t = await ready();
    fs.chmodSync(t.file, 0o444);
    try {
      expect(refusal(await t.d.send(t.w, t.p, "the summary"))).toMatch(/read-only/);
    } finally {
      fs.chmodSync(t.file, 0o644);
    }
    expect(t.ptyOf(t.b.id).writes).toEqual([]);
    expect(t.wireOf(t.w).delivery).toBeUndefined();
    // the folder refusing the write (a full disk, say), though the file itself is writable
    fs.chmodSync(t.dir, 0o555);
    try {
      expect(refusal(await t.d.send(t.w, t.p, "the summary"))).toMatch(/^Nothing was sent: The wire couldn't be saved/);
    } finally {
      fs.chmodSync(t.dir, 0o755);
    }
    expect(t.ptyOf(t.b.id).writes).toEqual([]);
    expect(t.wireOf(t.w).delivery).toBeUndefined();
    expect(t.wireOf(t.w).rounds).toBeUndefined();
  });

  it("a paste that can't be written down first isn't made; it's settled as never pasted once the book can be written", async () => {
    if (asRoot) return;
    const t = await ready();
    t.m.statusFromHook({ paneId: t.b.id, status: "working" });
    await t.d.send(t.w, t.p, "the summary");
    vi.spyOn(console, "error").mockImplementation(() => {});
    fs.chmodSync(t.dir, 0o555);
    try {
      t.idle(t.b.id);
      vi.advanceTimersByTime(150);
      expect(t.ptyOf(t.b.id).writes).toEqual([]);
      expect(t.told.at(-1)).toMatchObject({ id: t.b.id, title: "Not sent along a wire", body: expect.stringMatching(/couldn't be written down before its paste/) });
      t.d.reconcile(); // can't yet: said once
      t.d.reconcile();
      expect(t.logged.filter((l) => l.includes("couldn't be settled"))).toHaveLength(1);
    } finally {
      fs.chmodSync(t.dir, 0o755);
    }
    expect(t.wireOf(t.w).delivery!.state).toBe("queued");
    t.d.reconcile();
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "failed", why: expect.stringMatching(/never pasted into “Reviewer”/) });
    expect(t.gate(t.w).state).toBe("ready");
  });

  it("a wire removed while its message is queued: never pasted, and Undo brings it back failed, ready to send", async () => {
    const t = await ready();
    t.m.statusFromHook({ paneId: t.b.id, status: "working" });
    await t.d.send(t.w, t.p, "the summary");
    t.service.remove(t.w);
    t.idle(t.b.id);
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(t.b.id).writes).toEqual([]);
    t.service.restore(t.w);
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "failed", why: expect.stringMatching(/removed before it was pasted/) });
    expect(t.gate(t.w).state).toBe("ready");
  });
});

describe("across a restart: nothing is sent as the app starts", () => {
  /** A source and a target per wire, closed with ghosts, as the last run left them: the rules hold for each wire alone. */
  const pairs = ["ask", "auto", "queued", "pasting", "sent", "placed"];
  // each record says its hooks were silent, as a pane's last launch may have left it: a closed session's next launch starts afresh
  const record = (id: string, title: string, cwd: string) => ({ id, title, ticketTitle: null, repoPath: null, cwd, branch: null, taskGroup: null, status: "idle", agent: "claude", kind: "assistant", hooksSilent: true }) as unknown as SessionInfo;
  const pending = { id: "p1", body: "from the last run", at: 1, flags: [] };
  const link = (k: string, over: Record<string, unknown>) => ({ from: `${k}-a`, to: `${k}-b`, type: "handoff", when: "finished", gate: "ask", createdAt: 1, ...over });
  const book = {
    wv: 1,
    links: {
      ask: link("ask", { pending }),
      auto: link("auto", { gate: "automatic", type: "feedback", rounds: { limit: 3, used: 2 }, pending }),
      queued: link("queued", { type: "feedback", rounds: { limit: 3, used: 1 }, pending, delivery: { id: "p1", state: "queued", at: 1 } }),
      pasting: link("pasting", { type: "feedback", rounds: { limit: 3, used: 1 }, pending, delivery: { id: "p1", state: "pasting", at: 1 } }),
      sent: link("sent", { delivery: { id: "p0", state: "sent", at: 1 } }),
      placed: link("placed", { delivery: { id: "p0", state: "placed", at: 1 } }),
    },
    notes: { "auto-b": { hops: 2 } },
  };
  const lastRun = () => {
    const cwd = tempDir("closed");
    const records = pairs.flatMap((k) => [record(`${k}-a`, `Source ${k}`, cwd), record(`${k}-b`, `Target ${k}`, cwd)]);
    const ghosts = Object.fromEntries(records.map((r) => [r.id, ghost(r.title)]));
    return setup({ records, file: v3File(book, ghosts) });
  };

  it("settles each state: ready stays, automatic asks saying why, queued never reached, pasting may have; counts and hops hold", () => {
    const t = lastRun();
    t.d.reconcile();
    const links = t.book().links;
    expect(links.ask.delivery).toBeUndefined();
    expect(t.gate("ask")).toMatchObject({ state: "ready", pendingId: "p1" });
    expect(links.auto.delivery).toMatchObject({ id: "p1", state: "held", why: expect.stringMatching(/waiting from before Mockingbird started/) });
    expect(t.gate("auto")).toMatchObject({ state: "ready", gate: "automatic", why: expect.stringMatching(/from before/) });
    expect(links.queued.delivery).toMatchObject({ state: "failed", why: "Mockingbird stopped before this was pasted into “Target queued”, so it never reached it." });
    expect(t.gate("queued").state).toBe("ready");
    expect(links.pasting.delivery).toMatchObject({ state: "unconfirmed", why: expect.stringMatching(/may have reached it\. Send it again, or mark it sent/) });
    expect(t.gate("pasting")).toMatchObject({ state: "blocked", unconfirmed: true });
    expect(links.sent).toEqual(book.links.sent);
    expect(links.placed).toEqual(book.links.placed);
    expect([links.auto.rounds, links.queued.rounds, links.pasting.rounds]).toEqual([{ limit: 3, used: 2 }, { limit: 3, used: 1 }, { limit: 3, used: 1 }]);
    expect(t.book().notes).toEqual({ "auto-b": { hops: 2 } });
    expect(ptys.filter((p) => p.session.includes("-"))).toEqual([]);
    expect(t.told.map((x) => x.title).sort()).toEqual(["May have reached “Target pasting”", "Not sent to “Target queued”"]);
    // settled once: a second pass changes nothing
    const disk = fs.readFileSync(t.file, "utf8");
    t.d.reconcile();
    expect(fs.readFileSync(t.file, "utf8")).toBe(disk);
  });

  it("what never reached its end goes again under its own id without counting another round", async () => {
    const t = lastRun();
    t.d.reconcile();
    expect(refusal(await t.d.sendAgain("queued", "p1", "x"))).toMatch(/can simply be sent/);
    const r = await t.d.send("queued", "p1", "from the last run", { start: true });
    expect(r).not.toHaveProperty("refused");
    expect(t.reopened).toEqual(["queued-b"]);
    expect(t.wireOf("queued")).toMatchObject({ rounds: { limit: 3, used: 1 }, delivery: { id: "p1", state: "queued" } });
  });

  it("what may have reached its end is refused a plain Send: Mark sent settles it", async () => {
    const t = lastRun();
    t.d.reconcile();
    expect(refusal(await t.d.send("pasting", "p1", "x"))).toMatch(/may have reached “Target pasting” already: send it again, or mark it sent/);
    expect(t.d.markSent("pasting", "p1")).not.toHaveProperty("refused");
    expect(t.wireOf("pasting")).toMatchObject({ delivery: { id: "p1", state: "sent", why: "Marked sent by you." } });
    expect(t.wireOf("pasting").pending).toBeUndefined();
    expect(refusal(t.d.markSent("pasting", "p1"))).toMatch(/Only what may have reached/);
    expect(refusal(t.d.markSent("queued", "p1"))).toMatch(/Only what may have reached/);
  });

  it("Send again makes a new pending, counts a new round, and sends it", async () => {
    const t = lastRun();
    t.d.reconcile();
    const r = await t.d.sendAgain("pasting", "p1", "from the last run, again", { start: true });
    expect(r).not.toHaveProperty("refused");
    const w = t.wireOf("pasting");
    expect(w.pending).toMatchObject({ body: "from the last run, again" });
    expect(w.pending!.id).not.toBe("p1");
    expect(w.delivery).toMatchObject({ id: w.pending!.id, state: "queued" });
    expect(w.rounds).toEqual({ limit: 3, used: 2 });
    expect(refusal(await t.d.sendAgain("pasting", "p1", "x"))).toMatch(/on its way/);
  });
});

describe("the round limit", () => {
  it("is counted in main before the send, written ahead, once per pending; at the limit Send is off until a person allows another", async () => {
    const t = await ready({}, "feedback", { limit: 1 });
    t.m.statusFromHook({ paneId: t.b.id, status: "working" });
    await t.d.send(t.w, t.p, "round one");
    expect(t.onDisk().wires.links[t.w].rounds).toEqual({ limit: 1, used: 1 });
    // it fails before it's pasted: sent again under its id, not counted again
    t.ptyOf(t.b.id).exit(1);
    expect(t.wireOf(t.w).delivery!.state).toBe("failed");
    expect(t.gate(t.w).state).toBe("ready");
    await t.d.send(t.w, t.p, "round one", { start: true });
    expect(t.wireOf(t.w).rounds).toEqual({ limit: 1, used: 1 });
    t.idle(t.b.id, { started: true });
    vi.advanceTimersByTime(1700 + 150);
    expect(t.wireOf(t.w).delivery!.state).toBe("sent");
    // the next round is past the limit
    const p2 = await t.offer(t.w, "round two");
    expect(t.gate(t.w)).toMatchObject({ state: "blocked", atLimit: true });
    expect(refusal(await t.d.send(t.w, p2, "round two"))).toMatch(/At the limit: 1 of 1/);
    expect(refusal(t.d.resetRounds("nope"))).toMatch(/no wire/);
    expect(refusal(t.d.moreRounds(t.add(t.a.id, t.b.id, "context")))).toMatch(/Only a feedback wire/);
    expect(t.d.moreRounds(t.w)).not.toHaveProperty("refused");
    expect(t.wireOf(t.w).rounds).toEqual({ limit: 2, used: 1 });
    expect(refusal(t.d.moreRounds(t.w))).toMatch(/rounds left/);
    await t.d.send(t.w, p2, "round two");
    expect(t.wireOf(t.w).rounds).toEqual({ limit: 2, used: 2 });
    expect(t.d.resetRounds(t.w)).not.toHaveProperty("refused");
    expect(t.wireOf(t.w).rounds).toEqual({ limit: 2, used: 0 });
  });

  it("Mark sent, One more round and Reset rounds are refused while a teammate has either end, and change nothing", async () => {
    const t = await ready({}, "feedback", { limit: 1 });
    t.store.editWires((bk) => ({ book: { ...bk, links: { ...bk.links, [t.w]: { ...bk.links[t.w], rounds: { limit: 1, used: 1 }, delivery: { id: t.p, state: "unconfirmed", at: 1 } } } } }));
    const before = t.wireOf(t.w);
    t.takenOver[t.b.id] = "“Reviewer” continues on Nick's laptop";
    expect(refusal(t.d.markSent(t.w, t.p))).toBe("“Reviewer” continues on Nick's laptop — take it back rather than settling what this copy's wire sent");
    expect(refusal(t.d.moreRounds(t.w))).toBe("“Reviewer” continues on Nick's laptop — take it back rather than allowing this copy's wire another round");
    expect(refusal(t.d.resetRounds(t.w))).toBe("“Reviewer” continues on Nick's laptop — take it back rather than resetting this copy's wire's rounds");
    delete t.takenOver[t.b.id];
    t.takenOver[t.a.id] = "“Builder” continues on Nick's laptop";
    expect(refusal(t.d.moreRounds(t.w))).toMatch(/^“Builder” continues on Nick's laptop/);
    expect(t.wireOf(t.w)).toEqual(before);
    // taken back, each goes
    delete t.takenOver[t.a.id];
    expect(t.d.moreRounds(t.w)).not.toHaveProperty("refused");
    expect(t.d.resetRounds(t.w)).not.toHaveProperty("refused");
    expect(t.d.markSent(t.w, t.p)).not.toHaveProperty("refused");
    expect(t.wireOf(t.w)).toMatchObject({ rounds: { limit: 2, used: 0 }, delivery: { state: "sent" } });
  });

  it("isn't reset by a relaunch, a restart or the counter being in a newer pending", async () => {
    const t = await ready({}, "feedback", { limit: 2 });
    await t.d.send(t.w, t.p, "round one");
    vi.advanceTimersByTime(150);
    await t.m.restart(t.b.id);
    await t.offer(t.w, "round two");
    expect(t.wireOf(t.w).rounds).toEqual({ limit: 2, used: 1 });
    const again = new WireDelivery({ store: new LandscapeStore({ file: t.file, emit: () => {}, log: () => {} }), context: (bk) => t.service.context(bk), sessions: t.m, reopen: async () => null, submits: () => true, frame, takenOver: () => null, log: () => {}, notify: () => {} });
    again.reconcile();
    expect(JSON.parse(fs.readFileSync(t.file, "utf8")).wires.links[t.w].rounds).toEqual({ limit: 2, used: 1 });
  });
});

describe("an automatic gate", () => {
  async function chain(n: number) {
    const t = setup();
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const s = await t.pane(`Step ${i}`);
      t.idle(s.id);
      ids.push(s.id);
    }
    const wires = ids.slice(1).map((to, i) => t.add(ids[i], to, "handoff", { gate: "automatic" }));
    return { ...t, ids, wires };
  }

  it("sends what its source finished with no one pressing Send, as Mockingbird's own, and counts the hop", async () => {
    const t = await chain(2);
    const p = await t.offer(t.wires[0], "done");
    expect(t.ptyOf(t.ids[1]).writes).toEqual(["|[automatic from Step 0 to Step 1] done|"]);
    vi.advanceTimersByTime(150);
    expect(t.wireOf(t.wires[0]).delivery).toMatchObject({ id: p, state: "sent" });
    expect(t.book().notes[t.ids[1]]).toEqual({ hops: 1 });
  });

  it(`stops after ${AUTOMATIC_HOPS} automatic hops in a row, and a person's Send starts the count again`, async () => {
    const t = await chain(5);
    for (let i = 0; i < 4; i++) {
      await t.offer(t.wires[i], `step ${i}`);
      vi.advanceTimersByTime(150);
    }
    expect(t.wires.slice(0, 3).map((w) => t.wireOf(w).delivery!.state)).toEqual(["sent", "sent", "sent"]);
    expect(t.wireOf(t.wires[3]).delivery).toMatchObject({ state: "held", why: `${AUTOMATIC_HOPS} automatic sends in a row led to “Step 3”: the next one waits for you.` });
    expect(t.gate(t.wires[3])).toMatchObject({ state: "ready", why: expect.stringMatching(/in a row/) });
    expect(t.ptyOf(t.ids[4]).writes).toEqual([]);
    await t.d.send(t.wires[3], t.wireOf(t.wires[3]).pending!.id, "step 3");
    expect(t.book().notes[t.ids[4]]).toEqual({ hops: 0 });
  }, 60_000); // five panes: slow on a loaded machine

  it("never reopens a stopped workspace: exited or closed, it waits for a person, saying why", async () => {
    const t = await chain(3);
    t.ptyOf(t.ids[1]).exit(0);
    await t.offer(t.wires[0]);
    expect(t.wireOf(t.wires[0]).delivery).toMatchObject({ state: "held", why: expect.stringMatching(/“Step 1” isn't running: an automatic gate never reopens a workspace/) });
    t.m.kill(t.ids[2], false);
    t.placeGhost(t.ids[2], "Step 2");
    await t.offer(t.wires[1]);
    expect(t.wireOf(t.wires[1]).delivery).toMatchObject({ state: "held", why: expect.stringMatching(/never reopens/) });
    expect(t.reopened).toEqual([]);
    expect(ptys.filter((p) => p.session === t.ids[1] || p.session === t.ids[2])).toHaveLength(2);
  });

  it("sends once per prompt its source took: a second finish without a new prompt waits; one after a new prompt goes", async () => {
    const t = await chain(2);
    await t.offer(t.wires[0], "first");
    vi.advanceTimersByTime(150);
    t.idle(t.ids[1]);
    // no prompt reported since (its hooks silent, or it called finish_step twice in one turn): the second asks
    await t.offer(t.wires[0], "again, same prompt");
    expect(t.wireOf(t.wires[0]).delivery).toMatchObject({ state: "held", why: expect.stringMatching(/finished again without a new prompt/) });
    t.m.statusFromHook({ paneId: t.ids[0], status: "working", prompted: true });
    await t.offer(t.wires[0], "after a new prompt");
    vi.advanceTimersByTime(150);
    expect(t.wireOf(t.wires[0]).delivery!.state).toBe("sent");
    expect(t.ptyOf(t.ids[1]).writes.filter((x) => x !== "\r")).toEqual(["|[automatic from Step 0 to Step 1] first|", "|[automatic from Step 0 to Step 1] after a new prompt|"]);
    // a person's Finish step is theirs, not the agent's: no prompt to go by
    t.idle(t.ids[1]);
    await t.offer(t.wires[0], "a person finished it", { origin: "person" });
    vi.advanceTimersByTime(150);
    expect(t.wireOf(t.wires[0]).delivery!.state).toBe("sent");
    // three automatic arrivals at Step 1 now: a person's Send starts its count again
    t.idle(t.ids[1]);
    const yours = await t.offer(t.wires[0], "yours", { origin: "agent", hold: "for you" });
    await t.d.send(t.wires[0], yours, "yours");
    vi.advanceTimersByTime(150);
    expect(t.book().notes[t.ids[1]]).toEqual({ hops: 0 });
    // relaunched, its prompts count from nothing again, as a new launch
    await t.m.restart(t.ids[0]);
    t.idle(t.ids[1]);
    await t.offer(t.wires[0], "after a restart");
    vi.advanceTimersByTime(150);
    expect(t.wireOf(t.wires[0]).delivery!.state).toBe("sent");
  });

  it("holds what redaction flagged, what came while blocked, and what a merge after a start brings; what the rules refuse isn't readied", async () => {
    const t = await chain(2);
    await t.offer(t.wires[0], "used DB_PASSWORD=hunter2xx to test");
    expect(t.wireOf(t.wires[0]).delivery).toMatchObject({ state: "held", why: expect.stringMatching(/^It was flagged \(.*secret-looking/) });
    t.m.statusFromHook({ paneId: t.ids[0], status: "working", prompted: true });
    await t.offer(t.wires[0], "merged", { origin: "merge", hold: "Its PR merged while Mockingbird was closed, so it asks." });
    expect(t.wireOf(t.wires[0]).delivery).toMatchObject({ state: "held", why: "Its PR merged while Mockingbird was closed, so it asks." });
    // an end whose hooks never reported: what comes then is held, saying the wire was blocked
    const silent = await t.pane("Silent");
    const toSilent = t.add(t.ids[1], silent.id, "handoff", { gate: "automatic" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    t.m.checkStalls(Date.now() + 10 * 60_000, 5 * 60_000);
    t.m.statusFromHook({ paneId: t.ids[1], status: "working", prompted: true });
    await t.offer(toSilent, "while it's blocked");
    expect(t.wireOf(toSilent).delivery).toMatchObject({ state: "held", why: expect.stringMatching(/came while this wire was blocked \(“Silent”: its hooks aren't reporting/) });
    t.takenOver[t.ids[1]] = "“Step 1” continues on Nick's laptop";
    expect(await t.finishing(t.wires[0], "taken")).toMatchObject({ does: "refused", why: expect.stringMatching(/continues on Nick's laptop/) });
    expect(t.ptyOf(t.ids[1]).writes).toEqual([]);
  });

  it("is never automatic in a room's area: it asks, and nothing is written", async () => {
    const t = await chain(2);
    t.rooms[t.ids[0]] = t.rooms[t.ids[1]] = "R1";
    const p = await t.offer(t.wires[0]);
    expect(t.gate(t.wires[0])).toMatchObject({ state: "ready", gate: "ask", pendingId: p });
    expect(t.wireOf(t.wires[0]).delivery).toBeUndefined();
    expect(t.ptyOf(t.ids[1]).writes).toEqual([]);
    // out of the room again, what waits from this run isn't taken for what waited before a start
    delete t.rooms[t.ids[0]];
    delete t.rooms[t.ids[1]];
    expect(t.gate(t.wires[0])).toMatchObject({ state: "ready", gate: "automatic" });
    t.d.reconcile();
    expect(t.wireOf(t.wires[0]).delivery).toBeUndefined();
  });

  it("one at a time: what comes while one's on its way goes once that's settled", async () => {
    const t = await chain(2);
    t.m.statusFromHook({ paneId: t.ids[1], status: "working" });
    await t.offer(t.wires[0], "first");
    t.m.statusFromHook({ paneId: t.ids[0], status: "working", prompted: true });
    const p2 = await t.offer(t.wires[0], "second");
    expect(t.wireOf(t.wires[0]).delivery!.state).toBe("queued");
    expect(t.gate(t.wires[0]).state).toBe("sending");
    t.idle(t.ids[1]); // the first is pasted
    vi.advanceTimersByTime(150); // its Enter: sent, and the second is tried once that's done
    t.idle(t.ids[1]);
    await Promise.resolve();
    expect(t.wireOf(t.wires[0]).delivery).toMatchObject({ id: p2, state: "pasting" });
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(t.ids[1]).writes.filter((x) => x !== "\r")).toEqual(["|[automatic from Step 0 to Step 1] first|", "|[automatic from Step 0 to Step 1] second|"]);
  });

  it(`sends at most ${AUTOMATIC_HOPS} in a row to one session however often its source's prompts are reported; a person's Send starts the count again`, async () => {
    const t = await chain(2);
    const states: string[] = [];
    for (let i = 0; i < 6; i++) {
      // a prompt reported each time, as a hook event written by the source's own shell would be
      t.m.statusFromHook({ paneId: t.ids[0], status: "working", prompted: true });
      await t.offer(t.wires[0], `round ${i}`);
      vi.advanceTimersByTime(150);
      states.push(t.wireOf(t.wires[0]).delivery!.state);
      t.idle(t.ids[1], { finished: true });
    }
    expect(states).toEqual(["sent", "sent", "sent", "held", "held", "held"]);
    expect(t.wireOf(t.wires[0]).delivery!.why).toBe(`${AUTOMATIC_HOPS} automatic sends in a row reached “Step 1”: the next one waits for you.`);
    expect(t.book().notes[t.ids[1]]).toEqual({ hops: AUTOMATIC_HOPS });
    await t.d.send(t.wires[0], t.wireOf(t.wires[0]).pending!.id, "round 5");
    vi.advanceTimersByTime(150);
    expect(t.book().notes[t.ids[1]]).toEqual({ hops: 0 });
    t.idle(t.ids[1], { finished: true });
    t.m.statusFromHook({ paneId: t.ids[0], status: "working", prompted: true });
    await t.offer(t.wires[0], "after yours");
    vi.advanceTimersByTime(150);
    expect(t.wireOf(t.wires[0]).delivery!.state).toBe("sent");
  });

  it("what comes while the one on its way is blocked waits for it, rather than being lost", async () => {
    const t = setup();
    const a = await t.pane("Step 0");
    const b = await t.pane("Step 1"); // working from its start, and its hooks never report
    const w = t.add(a.id, b.id, "handoff", { gate: "automatic" });
    await t.offer(w, "first");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    t.m.checkStalls(Date.now() + 10 * 60_000, 5 * 60_000);
    expect(t.gate(w)).toMatchObject({ state: "blocked", stalled: true });
    t.m.statusFromHook({ paneId: a.id, status: "working", prompted: true });
    const p2 = await t.offer(w, "second");
    expect(t.wireOf(w).delivery).toMatchObject({ state: "queued" });
    t.m.clearWaiting(b.id);
    vi.advanceTimersByTime(150);
    await Promise.resolve();
    expect(t.wireOf(w).delivery).toMatchObject({ id: p2 });
  });

  it("what came while one's paste couldn't be written down goes once reconcile settles that one", async () => {
    if (asRoot) return;
    const t = await chain(2);
    t.m.statusFromHook({ paneId: t.ids[1], status: "working", prompted: true });
    await t.offer(t.wires[0], "first");
    t.m.statusFromHook({ paneId: t.ids[0], status: "working", prompted: true });
    const p2 = await t.offer(t.wires[0], "second");
    vi.spyOn(console, "error").mockImplementation(() => {});
    fs.chmodSync(t.dir, 0o555);
    try {
      t.idle(t.ids[1], { finished: true });
      vi.advanceTimersByTime(150);
      await Promise.resolve();
    } finally {
      fs.chmodSync(t.dir, 0o755);
    }
    expect(t.wireOf(t.wires[0]).delivery!.state).toBe("queued");
    t.d.reconcile();
    await Promise.resolve();
    expect(t.wireOf(t.wires[0]).delivery).toMatchObject({ id: p2, state: "pasting" });
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(t.ids[1]).writes.filter((x) => x !== "\r")).toEqual(["|[automatic from Step 0 to Step 1] second|"]);
  });
});

describe("races", () => {
  it("a take-over heard while the other end reopens: nothing is delivered, and the wire says why", async () => {
    const t = await ready();
    t.m.kill(t.b.id, false);
    t.placeGhost(t.b.id, "Reviewer");
    const sending = t.d.send(t.w, t.p, "the summary", { start: true });
    t.takenOver[t.b.id] = "“Reviewer” continues on Nick's laptop";
    const r = await sending;
    expect(refusal(r)).toMatch(/continues on Nick's laptop/);
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "failed" });
    t.idle(t.b.id);
    vi.advanceTimersByTime(200);
    expect(t.ptyOf(t.b.id).writes).toEqual([]);
  });

  it("your own Reopen racing a Send's: one reopens it, the other fails saying so, and nothing is lost", async () => {
    const t = await ready();
    t.m.kill(t.b.id, false);
    t.placeGhost(t.b.id, "Reviewer");
    const yours = t.m.relaunch(t.b.id);
    const r = await t.d.send(t.w, t.p, "the summary", { start: true });
    await yours;
    expect(refusal(r)).toMatch(/being reopened already/);
    expect(t.gate(t.w)).toMatchObject({ state: "ready", why: expect.stringMatching(/being reopened already/) });
    t.idle(t.b.id);
    await t.d.send(t.w, t.p, "the summary");
    vi.advanceTimersByTime(150);
    expect(t.wireOf(t.w).delivery!.state).toBe("sent");
  });

  it("a take-over once it's queued: the copy stops here, its message fails, and the wire is blocked saying why", async () => {
    const t = await ready();
    t.m.statusFromHook({ paneId: t.b.id, status: "working" });
    await t.d.send(t.w, t.p, "the summary");
    t.takenOver[t.b.id] = "“Reviewer” continues on Nick's laptop";
    t.m.stop(t.b.id); // as the take-over host stops it
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "failed", why: "“Reviewer” stopped running before this reached it" });
    expect(t.gate(t.w)).toMatchObject({ state: "blocked", why: expect.stringMatching(/continues on Nick's laptop/) });
    expect(refusal(await t.d.send(t.w, t.p, "the summary"))).toMatch(/continues on Nick's laptop — take it back rather than sending along this copy's wire/);
    expect(t.ptyOf(t.b.id).writes).toEqual([]);
  });
});

describe("what's queued answers to its own send", () => {
  const queued = (t: { m: SessionManager }, id: string) => t.m.list().find((s) => s.id === id)!.queuedCount;

  it("a wire removed and put back while its message is queued: that message comes out of the queue, and a Send of what you edited pastes only that, once", async () => {
    const t = await ready();
    t.m.statusFromHook({ paneId: t.b.id, status: "working", prompted: true });
    await t.d.send(t.w, t.p, "the first draft");
    expect(queued(t, t.b.id)).toBe(1);
    t.service.remove(t.w);
    expect(queued(t, t.b.id)).toBe(0);
    t.service.restore(t.w);
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "failed", why: expect.stringMatching(/removed before it was pasted/) });
    expect(await t.d.send(t.w, t.p, "edited, the secret taken out")).not.toHaveProperty("refused");
    for (let i = 0; i < 2; i++) {
      t.idle(t.b.id, { finished: true });
      vi.advanceTimersByTime(150);
    }
    expect(t.ptyOf(t.b.id).writes).toEqual(["|[sent from Builder to Reviewer] edited, the secret taken out|", "\r"]);
    expect(t.wireOf(t.w).delivery).toMatchObject({ id: t.p, state: "sent" });
  });

  it("a removal whose queued message can't be taken back out is still a removal, logged, and Undo still restores it", async () => {
    const t = await ready();
    const logged: string[] = [];
    const failing = new WireService({ store: t.store, sessions: t.m, roomOf: () => null, takenOver: () => null, log: (c, e) => void logged.push(`${c}: ${(e as Error).message}`), delivery: { withdraw: () => {
      throw new Error("the queue is gone");
    }, restoring: (w) => t.d.restoring(w), restored: () => {} } });
    t.m.statusFromHook({ paneId: t.b.id, status: "working", prompted: true });
    await t.d.send(t.w, t.p, "the summary");
    expect(failing.remove(t.w)).not.toHaveProperty("refused");
    expect(logged).toEqual([`wires: ${t.w} was removed, but what it had queued couldn't be taken back out: the queue is gone`]);
    expect(failing.restore(t.w)).not.toHaveProperty("refused");
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "failed" });
    t.idle(t.b.id, { finished: true });
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(t.b.id).writes).toEqual([]);
  });

  it("an earlier send's message never passes for a later send of the same pending, even left in the queue", async () => {
    const t = await ready();
    // removes and restores without taking anything out of a queue
    const bare = new WireService({ store: t.store, sessions: t.m, roomOf: () => null, takenOver: () => null, log: () => {} });
    t.m.statusFromHook({ paneId: t.b.id, status: "working", prompted: true });
    await t.d.send(t.w, t.p, "the first draft");
    bare.remove(t.w);
    bare.restore(t.w);
    await t.d.send(t.w, t.p, "edited");
    expect(queued(t, t.b.id)).toBe(2);
    for (let i = 0; i < 2; i++) {
      t.idle(t.b.id, { finished: true });
      vi.advanceTimersByTime(150);
    }
    expect(t.ptyOf(t.b.id).writes).toEqual(["|[sent from Builder to Reviewer] edited|", "\r"]);
    expect(t.logged).toContainEqual(expect.stringMatching(/wasn't pasted into .*: it was settled meanwhile/));
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "sent" });
  });

  it("a send that ends after its wire was removed, put back and sent again doesn't write over the newer send", async () => {
    const t = await ready();
    await t.d.send(t.w, t.p, "first"); // pasted, its Enter 120 ms away
    expect(t.wireOf(t.w).delivery!.state).toBe("pasting");
    t.service.remove(t.w);
    t.service.restore(t.w);
    expect(t.wireOf(t.w).delivery!.state).toBe("unconfirmed");
    expect(await t.d.sendAgain(t.w, t.p, "again")).not.toHaveProperty("refused");
    vi.advanceTimersByTime(150); // the first one's Enter
    t.d.reconcile(); // what's on its way now is the newer send, left to go
    const w = t.wireOf(t.w);
    expect(w.delivery).toMatchObject({ id: w.pending!.id, state: "queued" });
    // being pasted when its wire went, the first was past taking back, and nothing says it was taken
    expect(t.logged.filter((l) => l.includes("was removed with"))).toEqual([]);
    t.idle(t.b.id, { finished: true });
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(t.b.id).writes.filter((x) => x !== "\r")).toEqual(["|[sent from Builder to Reviewer] first|", "|[sent from Builder to Reviewer] again|"]);
    expect(t.wireOf(t.w).delivery!.state).toBe("sent");
  });

  it("what anything else settled in the book while it was queued isn't pasted", async () => {
    const t = await ready();
    t.m.statusFromHook({ paneId: t.b.id, status: "working", prompted: true });
    await t.d.send(t.w, t.p, "the summary");
    t.store.editWires((bk) => ({ book: { ...bk, links: { ...bk.links, [t.w]: { ...bk.links[t.w], delivery: { ...bk.links[t.w].delivery!, state: "failed", why: "settled elsewhere" } } } } }));
    t.idle(t.b.id, { finished: true });
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(t.b.id).writes).toEqual([]);
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "failed", why: "settled elsewhere" });
  });

  it("its wire removed and put back while the other end reopens: nothing is queued once it has, and the wire keeps what Undo said", async () => {
    let started: (s: SessionInfo | null) => void = () => {};
    const t = await ready({ reopen: () => new Promise((r) => (started = r)) });
    t.m.kill(t.b.id, false);
    t.placeGhost(t.b.id, "Reviewer");
    const sending = t.d.send(t.w, t.p, "the summary", { start: true });
    t.service.remove(t.w);
    t.service.restore(t.w);
    started(await t.m.relaunch(t.b.id));
    expect(refusal(await sending)).toMatch(/settled meanwhile/);
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "failed", why: expect.stringMatching(/removed before it was pasted/) });
    expect(queued(t, t.b.id)).toBe(0);
  });

  it(`a reopen that never returns: failed after ${START_WAIT_MS / 1000} s, ready to send again, and a start that comes later is only logged`, async () => {
    let started: (s: SessionInfo | null) => void = () => {};
    const t = await ready({ reopen: () => new Promise((r) => (started = r)) });
    t.m.kill(t.b.id, false);
    t.placeGhost(t.b.id, "Reviewer");
    const sending = t.d.send(t.w, t.p, "the summary", { start: true });
    expect(t.gate(t.w).state).toBe("sending");
    vi.advanceTimersByTime(START_WAIT_MS - 1);
    expect(t.wireOf(t.w).delivery!.state).toBe("queued");
    vi.advanceTimersByTime(1);
    expect(refusal(await sending)).toBe(`It didn't start within ${START_WAIT_MS / 1000} s, so nothing was sent: send it again once it's running.`);
    expect(t.gate(t.w)).toMatchObject({ state: "ready", why: expect.stringMatching(/didn't start within/) });
    expect(t.told.at(-1)).toMatchObject({ title: "Not sent along a wire" });
    started(await t.m.relaunch(t.b.id));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(t.logged).toContainEqual(expect.stringMatching(/started after .* gave up waiting for it/));
    expect(queued(t, t.b.id)).toBe(0);
    t.idle(t.b.id);
    expect(await t.d.send(t.w, t.p, "the summary")).not.toHaveProperty("refused");
    vi.advanceTimersByTime(150);
    expect(t.wireOf(t.w).delivery!.state).toBe("sent");
  });

  it("the queue failing once it holds the message isn't a failed send: its receipt says what became of it; one failing before it does is", async () => {
    const t = await ready();
    t.m.statusFromHook({ paneId: t.b.id, status: "working", prompted: true });
    const real = t.m.deliverAgentMessage.bind(t.m);
    const spy = vi.spyOn(t.m, "deliverAgentMessage").mockImplementation((...args) => {
      real(...args);
      throw new Error("the queue failed after taking it");
    });
    expect(await t.d.send(t.w, t.p, "the summary")).not.toHaveProperty("refused");
    expect(t.told).toEqual([]);
    expect(t.logged).toContainEqual(expect.stringMatching(/reached .*'s queue, which failed after; its receipt says what became of it: the queue failed after taking it/));
    spy.mockRestore();
    t.idle(t.b.id, { finished: true });
    vi.advanceTimersByTime(150);
    expect(t.wireOf(t.w).delivery!.state).toBe("sent");
    const p2 = await t.offer(t.w, "next");
    vi.spyOn(t.m, "deliverAgentMessage").mockImplementation(() => {
      throw new Error("refused before queueing");
    });
    expect(refusal(await t.d.send(t.w, p2, "next"))).toBe("refused before queueing");
    expect(t.wireOf(t.w).delivery).toMatchObject({ id: p2, state: "failed" });
  });

  it("state.json failing as the pane is marked working after its paste: still sent, and you aren't told it wasn't", async () => {
    const t = await ready();
    const store = (t.m as any).store;
    const real = store.upsertSession.bind(store);
    let armed = true;
    store.upsertSession = (i: SessionInfo) => {
      if (armed && i.id === t.b.id && i.status === "working") {
        armed = false;
        throw new Error("ENOSPC: state.json");
      }
      return real(i);
    };
    expect(await t.d.send(t.w, t.p, "the summary")).not.toHaveProperty("refused");
    expect(t.told).toEqual([]);
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(t.b.id).writes.at(-1)).toBe("\r");
    expect(t.wireOf(t.w).delivery!.state).toBe("sent");
  });
});

describe("the rules, again just before the paste", () => {
  it("its other end moved into a team room while it waits: the gate says why, nothing is pasted, and it's failed saying so", async () => {
    const t = await ready();
    t.m.statusFromHook({ paneId: t.b.id, status: "working", prompted: true });
    await t.d.send(t.w, t.p, "private text");
    t.rooms[t.b.id] = "room-1";
    expect(t.gate(t.w)).toMatchObject({ state: "blocked", why: ROOM_LINE });
    t.idle(t.b.id, { finished: true });
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(t.b.id).writes).toEqual([]);
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "failed", why: `It wasn't pasted, as the rules changed while it waited: ${ROOM_LINE}` });
    expect(t.told.at(-1)).toMatchObject({ id: t.b.id, title: "Not sent along a wire" });
  });

  it("its source taken over while it waits: nothing is pasted", async () => {
    const t = await ready();
    t.m.statusFromHook({ paneId: t.b.id, status: "working", prompted: true });
    await t.d.send(t.w, t.p, "from the builder");
    t.takenOver[t.a.id] = "“Builder” continues on Nick's laptop";
    expect(t.gate(t.w)).toMatchObject({ state: "blocked", why: expect.stringMatching(/continues on Nick's laptop/) });
    t.idle(t.b.id, { finished: true });
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(t.b.id).writes).toEqual([]);
    expect(t.wireOf(t.w).delivery).toMatchObject({ state: "failed", why: expect.stringMatching(/rules changed while it waited: “Builder” continues on Nick's laptop/) });
  });

  it("an automatic send whose ends both went into a room's area, or whose gate was set to ask, while it waits: nothing is pasted", async () => {
    for (const change of ["room", "ask"] as const) {
      const t = setup();
      const a = await t.pane("Builder");
      const b = await t.pane("Reviewer");
      t.m.statusFromHook({ paneId: b.id, status: "working", prompted: true });
      const w = t.add(a.id, b.id, "handoff", { gate: "automatic" });
      await t.offer(w, "by itself");
      expect(t.wireOf(w).delivery).toMatchObject({ state: "queued", automatic: true });
      if (change === "room") t.rooms[a.id] = t.rooms[b.id] = "R1";
      else expect(t.service.set(w, { gate: "ask" })).not.toHaveProperty("refused");
      expect(t.gate(w).state).toBe("blocked");
      t.idle(b.id, { finished: true });
      vi.advanceTimersByTime(150);
      expect(t.ptyOf(b.id).writes).toEqual([]);
      expect(t.wireOf(w).delivery).toMatchObject({ state: "failed", why: expect.stringMatching(change === "room" ? /Automatic is off in a team room's area/ : /gate was set to ask/) });
    }
  });
});

describe("finishing a step, through the one writer", () => {
  it("an automatic handoff, end to end: finish_step writes it, its gate sends it with Mockingbird's label, and it's pasted once", async () => {
    const t = setup({ frame: "real" });
    const a = await t.pane("Builder");
    const b = await t.pane("Reviewer");
    t.idle(b.id);
    const w = t.add(a.id, b.id, "handoff", { gate: "automatic" });
    t.m.statusFromHook({ paneId: a.id, status: "working", prompted: true });
    const reply = await t.tools.call(t.m.list().find((s) => s.id === a.id)!, "finish_step", { summary: "Built the org filter." });
    expect(reply).toEqual({ result: expect.stringMatching(/^Step finished.*\n- the handoff wire to "Reviewer": readied\. Its gate sent it, and it's on its way\.$/) });
    const writes = t.ptyOf(b.id).writes;
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("Built the org filter.");
    expect(writes[0]).toMatch(/Builder/);
    expect(t.ptyOf(b.id).onDisk).toEqual(["pasting"]);
    vi.advanceTimersByTime(150);
    expect(writes.slice(1)).toEqual(["\r"]);
    expect(t.wireOf(w)).toMatchObject({ delivery: { state: "sent", automatic: true } });
    expect(t.wireOf(w).pending).toBeUndefined();
    expect(t.book().notes[a.id]).toMatchObject({ summary: { text: "Built the org filter." } });
    expect(t.book().notes[b.id]).toEqual({ hops: 1 });
    expect(t.made).toEqual([]); // sent by its gate: nothing waits for the user
    // nothing more goes for it: a second finish in the same prompt waits
    t.idle(b.id);
    await t.offer(w, "again");
    expect(t.wireOf(w).delivery).toMatchObject({ state: "held", why: expect.stringMatching(/without a new prompt/) });
    expect(writes.filter((x) => x !== "\r")).toHaveLength(1);
  });

  it("finish_step's answer says what each gate did: sent and on its way, held with its reason, or waiting for the user", async () => {
    const t = setup();
    const a = await t.pane("Builder");
    const [b, c, e] = [await t.pane("Reviewer"), await t.pane("Tester"), await t.pane("Deployer")];
    t.idle(b.id);
    t.idle(e.id);
    t.add(a.id, b.id, "handoff", { gate: "automatic" });
    t.add(a.id, c.id, "handoff", { gate: "automatic" });
    t.add(a.id, e.id, "handoff");
    t.ptyOf(c.id).exit(0); // Tester has exited: an automatic gate never resumes it
    t.m.statusFromHook({ paneId: a.id, status: "working", prompted: true });
    const reply = (await t.tools.call(t.m.list().find((s) => s.id === a.id)!, "finish_step", { summary: "Built it." })) as { result: string };
    expect(reply.result.split("\n")).toEqual([
      "Step finished: Mockingbird keeps your summary. Along this workspace's wires:",
      '- the handoff wire to "Reviewer": readied. Its gate sent it, and it\'s on its way.',
      '- the handoff wire to "Tester": readied. It waits at the wire\'s gate for the user to send: “Tester” isn\'t running: an automatic gate never reopens a workspace, so this waits for you to send it.',
      '- the handoff wire to "Deployer": readied. It waits at the wire\'s gate for the user to send.',
    ]);
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(b.id).writes.at(-1)).toBe("\r");
  });

  it("finish_step goes along its wires in the order they were made, an id that reads as an integer included", async () => {
    const t = setup({ ids: ["ab12cd34", "12345678", "cd34ef56"] });
    const a = await t.pane("Builder");
    const [b, c, e] = [await t.pane("Reviewer"), await t.pane("Tester"), await t.pane("Deployer")];
    for (const x of [b, c, e]) t.add(a.id, x.id, "handoff");
    expect(Object.keys(t.book().links)[0]).toBe("12345678"); // the object's own order
    t.m.statusFromHook({ paneId: a.id, status: "working", prompted: true });
    const reply = (await t.tools.call(t.m.list().find((s) => s.id === a.id)!, "finish_step", { summary: "Built it." })) as { result: string };
    expect(reply.result.split("\n").slice(1).map((l) => /"(\w+)"/.exec(l)?.[1])).toEqual(["Reviewer", "Tester", "Deployer"]);
    const listed = t.service.linksFor(t.m.list().find((s) => s.id === a.id)!) as { result: { links: { wire: string }[] } };
    expect(listed.result.links.map((l) => l.wire)).toEqual(["ab12cd34", "12345678", "cd34ef56"]);
  });

  it("a gate that fails on one wire holds that one, saying why, and the finish is saved and the other wires' gates still run", async () => {
    const t = setup();
    const a = await t.pane("Builder");
    const [b, c] = [await t.pane("Reviewer"), await t.pane("Tester")];
    t.idle(b.id);
    t.idle(c.id);
    const wb = t.add(a.id, b.id, "handoff", { gate: "automatic" });
    const wc = t.add(a.id, c.id, "handoff", { gate: "automatic" });
    t.m.statusFromHook({ paneId: a.id, status: "working", prompted: true });
    const gate = t.d as unknown as { automatic: (...args: unknown[]) => void };
    const real = gate.automatic.bind(t.d);
    let first = true;
    vi.spyOn(gate, "automatic").mockImplementation((...args: unknown[]) => {
      if (first) {
        first = false;
        throw new Error("the gate broke");
      }
      return real(...args);
    });
    const reply = (await t.tools.call(t.m.list().find((s) => s.id === a.id)!, "finish_step", { summary: "Built it." })) as { result?: string; error?: string };
    expect(reply.error).toBeUndefined();
    expect(reply.result).toMatch(/^Step finished: Mockingbird keeps your summary/);
    expect(reply.result).toContain('- the handoff wire to "Reviewer": readied. It waits at the wire\'s gate for the user to send: Its gate failed as this step finished (the gate broke), so it waits for you.');
    expect(reply.result).toContain('- the handoff wire to "Tester": readied. Its gate sent it, and it\'s on its way.');
    expect(t.wireOf(wb).delivery).toMatchObject({ state: "held", why: "Its gate failed as this step finished (the gate broke), so it waits for you." });
    expect(t.logged).toContainEqual(expect.stringMatching(/finish readied .* on .*, and its gate failed: the gate broke/));
    expect(t.book().notes[a.id]).toMatchObject({ summary: { text: "Built it." } });
    vi.advanceTimersByTime(150);
    expect(t.wireOf(wc).delivery!.state).toBe("sent");
    expect(t.ptyOf(b.id).writes).toEqual([]);
  });

  it("a fan-out where one branch is refused: the others are readied and go, and each is answered", async () => {
    const t = setup();
    const a = await t.pane("Builder");
    const [b, c, e] = [await t.pane("Reviewer"), await t.pane("Tester"), await t.pane("Deployer")];
    for (const s of [b, c, e]) t.idle(s.id);
    const [wb, wc, we] = [b, c, e].map((s) => t.add(a.id, s.id, "handoff", { gate: "automatic" }));
    t.takenOver[e.id] = "“Deployer” continues on Nick's laptop";
    t.m.statusFromHook({ paneId: a.id, status: "working", prompted: true });
    const r = await t.tools.finish(t.m.list().find((s) => s.id === a.id)!, { summary: "one finish" }, "agent");
    if ("refused" in r) throw new Error(r.refused);
    const steps = new Map(r.steps.map((s) => [s.wire, s]));
    expect(steps.get(wb)).toMatchObject({ does: "readies", gate: "automatic" });
    expect(steps.get(wc)).toMatchObject({ does: "readies", gate: "automatic" });
    expect(steps.get(we)).toMatchObject({ does: "refused", why: expect.stringMatching(/continues on Nick's laptop/) });
    vi.advanceTimersByTime(150);
    expect([t.wireOf(wb).delivery!.state, t.wireOf(wc).delivery!.state]).toEqual(["sent", "sent"]);
    expect(t.wireOf(we).pending).toBeUndefined();
    expect(t.ptyOf(e.id).writes).toEqual([]);
  });

  it('"changes" holds the handoffs and readies the feedback in one write: never one without the other', async () => {
    const t = setup();
    const a = await t.pane("Reviewer");
    const [back, on] = [await t.pane("Builder"), await t.pane("Deployer")];
    const fb = t.add(a.id, back.id, "feedback");
    const ho = t.add(a.id, on.id, "handoff");
    await t.offer(ho, "looks fine", { origin: "agent" }, { verdict: "approve" });
    expect(t.wireOf(ho).pending).toBeDefined();
    const real = t.store.editWires.bind(t.store);
    const written: { handoff: unknown; feedback: unknown }[] = [];
    vi.spyOn(t.store, "editWires").mockImplementation((fn) => {
      const r = real(fn);
      const links = t.onDisk().wires.links;
      written.push({ handoff: links[ho].pending, feedback: links[fb].pending });
      return r;
    });
    const step = await t.finishing(fb, "fix the null case", { origin: "agent" }, { verdict: "changes" });
    expect(step).toMatchObject({ does: "readies" });
    expect(written).toEqual([{ handoff: undefined, feedback: expect.objectContaining({ body: "fix the null case", verdict: "changes" }) }]);
    expect(t.gate(ho)).toMatchObject({ state: "blocked", why: "needs approve" });
    expect(t.book().notes[a.id]).toMatchObject({ verdict: "changes" });
  });

  it("a {diff} body filled in near the limit is readied and sent whole", async () => {
    const repo = makeRepo({ "big.txt": "start\n" });
    git(repo, "switch", "-q", "-c", "4182-big");
    write(repo, { "big.txt": Array.from({ length: 3000 }, (_, i) => `changed line ${i} of the big file, long enough to count`).join("\n") });
    const t = setup({ frame: "real" });
    const a = await t.pane("Builder", { cwd: repo });
    const b = await t.pane("Reviewer");
    t.idle(b.id);
    const w = t.add(a.id, b.id, "handoff", { template: "{diff}" });
    const p = await t.offer(w, "the diff");
    const body = t.wireOf(w).pending!.body;
    expect(body.length).toBeGreaterThan(WIRE_BODY_MAX - 2_000);
    expect(body.length).toBeLessThanOrEqual(WIRE_BODY_MAX);
    expect(await t.d.send(w, p, body)).not.toHaveProperty("refused");
    expect(t.ptyOf(b.id).writes[0]).toContain(body.slice(-200));
    vi.advanceTimersByTime(150);
    expect(t.wireOf(w).delivery!.state).toBe("sent");
  });

  it("Mockingbird's own notices aren't prompts: two of them, then two more finishes in that prompt, send nothing more", async () => {
    const t = setup();
    const a = await t.pane("Builder");
    const b = await t.pane("Reviewer");
    t.idle(b.id);
    const w = t.add(a.id, b.id, "handoff", { gate: "automatic" });
    t.m.statusFromHook({ paneId: a.id, status: "working", prompted: true });
    await t.offer(w, "the work");
    vi.advanceTimersByTime(150);
    expect(t.wireOf(w).delivery!.state).toBe("sent");
    for (const n of [1, 2]) {
      t.idle(a.id);
      t.idle(b.id);
      t.m.deliverNotice(a.id, n === 1 ? "wires" : "overdue", `[Mockingbird: notice ${n}]`, true);
      vi.advanceTimersByTime(150); // its Enter
      t.m.statusFromHook({ paneId: a.id, status: "working", prompted: true }); // its hooks report that prompt
      t.idle(a.id);
      await t.offer(w, `finished again ${n}`);
      expect(t.wireOf(w).delivery).toMatchObject({ state: "held", why: expect.stringMatching(/without a new prompt/) });
    }
    expect(t.ptyOf(b.id).writes.filter((x) => x !== "\r")).toHaveLength(1);
    // a prompt it was given counts
    t.m.statusFromHook({ paneId: a.id, status: "working", prompted: true });
    t.idle(b.id);
    await t.offer(w, "after a real prompt");
    vi.advanceTimersByTime(150);
    expect(t.wireOf(w).delivery!.state).toBe("sent");
  });

  it("a prompt that comes in while a finish is being filled in isn't that finish's: it answers the prompt it began in", async () => {
    const t = setup();
    const a = await t.pane("Builder");
    const b = await t.pane("Reviewer");
    t.idle(b.id);
    const w = t.add(a.id, b.id, "handoff", { gate: "automatic" });
    t.m.statusFromHook({ paneId: a.id, status: "working", prompted: true });
    await t.offer(w, "the work");
    vi.advanceTimersByTime(150);
    t.idle(b.id);
    const me = t.m.list().find((s) => s.id === a.id)!;
    const finishing = t.tools.finish(me, { summary: "finished again" }, "agent");
    t.m.statusFromHook({ paneId: a.id, status: "working", prompted: true }); // while its template is filled in
    expect(await finishing).toMatchObject({ steps: [{ does: "readies" }] });
    expect(t.wireOf(w).delivery).toMatchObject({ state: "held", why: expect.stringMatching(/without a new prompt/) });
    expect(t.ptyOf(b.id).writes.filter((x) => x !== "\r")).toHaveLength(1);
  });

  it('a verdict reversed takes back what the last one queued: "changes" stops a queued handoff, "approve" a queued feedback', async () => {
    const t = setup();
    const a = await t.pane("Reviewer");
    const back = await t.pane("Builder");
    const on = await t.pane("Deployer");
    const fb = t.add(a.id, back.id, "feedback");
    const ho = t.add(a.id, on.id, "handoff");
    for (const s of [on, back]) t.m.statusFromHook({ paneId: s.id, status: "working", prompted: true });
    const p = await t.offer(ho, "approved: ship it", { origin: "agent" }, { verdict: "approve" });
    expect(t.made.at(-1)?.pendings).toEqual([expect.objectContaining({ wire: ho, pending: p })]); // it waits for you
    expect(await t.d.send(ho, p, "approved: ship it")).not.toHaveProperty("refused");
    expect(t.m.list().find((s) => s.id === on.id)!.queuedCount).toBe(1);
    const changes = await t.tools.finish(t.m.list().find((s) => s.id === a.id)!, { summary: "wait, the null case is broken", verdict: "changes" }, "agent");
    expect(changes).toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ wire: ho, does: "holds", withdraws: p })]) });
    expect(t.wireOf(ho).delivery).toMatchObject({ id: p, state: "failed", why: 'It was taken back before it was pasted: this step finished again with "changes".' });
    expect(t.wireOf(ho).pending).toBeUndefined();
    expect(t.m.list().find((s) => s.id === on.id)!.queuedCount).toBe(0);
    t.idle(on.id, { finished: true });
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(on.id).writes).toEqual([]);
    // the other way: "changes" queued for the builder, then "approve"
    const fp = t.wireOf(fb).pending!.id;
    expect(await t.d.send(fb, fp, "wait, the null case is broken")).not.toHaveProperty("refused");
    await t.tools.finish(t.m.list().find((s) => s.id === a.id)!, { summary: "it's fine after all", verdict: "approve" }, "agent");
    expect(t.wireOf(fb).delivery).toMatchObject({ id: fp, state: "failed", why: 'It was taken back before it was pasted: this step finished again with "approve".' });
    t.idle(back.id, { finished: true });
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(back.id).writes).toEqual([]);
    expect(t.wireOf(ho).pending).toBeDefined(); // the approve readied the handoff again
  });

  it("a verdict written by anything else while a message is queued stops it at the paste all the same", async () => {
    const t = setup();
    const a = await t.pane("Reviewer");
    const back = await t.pane("Builder");
    const on = await t.pane("Deployer");
    t.add(a.id, back.id, "feedback");
    const ho = t.add(a.id, on.id, "handoff");
    t.m.statusFromHook({ paneId: on.id, status: "working", prompted: true });
    const p = await t.offer(ho, "approved", { origin: "agent" }, { verdict: "approve" });
    await t.d.send(ho, p, "approved");
    t.store.editWires((bk) => ({ book: { ...bk, notes: { ...bk.notes, [a.id]: { ...bk.notes[a.id], verdict: "changes" } } } }));
    expect(t.gate(ho)).toMatchObject({ state: "blocked", why: expect.stringMatching(/finished again with "changes"/) });
    t.idle(on.id, { finished: true });
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(on.id).writes).toEqual([]);
    expect(t.wireOf(ho).delivery).toMatchObject({ state: "failed", why: expect.stringMatching(/rules changed while it waited: Its source's step finished again with "changes"/) });
  });

  it("a feedback wire drawn while a finish was filled in: the verdict it now needs is checked in the write, and nothing is finished", async () => {
    const t = setup();
    const a = await t.pane("Builder");
    const c = await t.pane("Deployer");
    const x = await t.pane("Reviewer");
    const ho = t.add(a.id, c.id, "handoff");
    const me = t.m.list().find((s) => s.id === a.id)!;
    const fill = await t.tools.planFinish(me, { summary: "done" });
    if ("refused" in fill) throw new Error(fill.refused);
    const fb = t.add(a.id, x.id, "feedback");
    expect(t.tools.applyFinish(me, fill, "agent")).toEqual({ refused: expect.stringMatching(/^This workspace's wires changed while its step was being finished, so nothing was: This workspace has a feedback wire out, so finishing its step needs a verdict/) });
    expect([t.wireOf(ho).pending, t.wireOf(fb).pending, t.book().notes[a.id]]).toEqual([undefined, undefined, undefined]);
    expect(t.made).toEqual([]);
  });

  it("what came to an automatic gate behind a message whose wire was removed goes once Undo puts the wire back", async () => {
    const t = setup();
    const a = await t.pane("Builder");
    const b = await t.pane("Reviewer");
    const w = t.add(a.id, b.id, "handoff", { gate: "automatic" });
    t.m.statusFromHook({ paneId: b.id, status: "working", prompted: true });
    t.m.statusFromHook({ paneId: a.id, status: "working", prompted: true });
    await t.offer(w, "first");
    t.m.statusFromHook({ paneId: a.id, status: "working", prompted: true });
    const p2 = await t.offer(w, "second");
    t.service.remove(w);
    await Promise.resolve(); // Undo comes later, in a call of its own
    t.idle(b.id, { finished: true });
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(b.id).writes).toEqual([]);
    t.service.restore(w);
    await Promise.resolve();
    expect(t.wireOf(w).delivery).toMatchObject({ id: p2, state: "pasting" });
    vi.advanceTimersByTime(150);
    expect(t.ptyOf(b.id).writes.filter((x) => x !== "\r")).toEqual(["|[automatic from Builder to Reviewer] second|"]);
  });

  it("a finish's pending is known as this run's: the reconcile tick never holds it as one from before, even once its gate turns automatic", async () => {
    const t = await ready();
    expect(t.wireOf(t.w).pending).toBeDefined();
    expect(t.service.set(t.w, { gate: "automatic" })).not.toHaveProperty("refused");
    t.d.reconcile();
    expect(t.wireOf(t.w).delivery).toBeUndefined();
    expect(t.gate(t.w)).toMatchObject({ state: "ready", gate: "automatic", pendingId: t.p });
  });

  it("refuses a body over the limit on its wire alone, and a framing that refuses fails the send with its reason", async () => {
    const t = await ready();
    const me = t.m.list().find((s) => s.id === t.a.id)!;
    const fill = await t.tools.planFinish(me, { summary: "fits" });
    if ("refused" in fill) throw new Error(fill.refused);
    const over = { ...fill, fills: fill.fills.map((x) => ({ ...x, body: { ...x.body, text: "x".repeat(WIRE_BODY_MAX + 1) } })) };
    const r = t.d.offer(me, over, { origin: "person" }, null);
    expect(r).toMatchObject({ steps: [{ wire: t.w, does: "refused", why: `It's ${WIRE_BODY_MAX + 1} characters; the limit is ${WIRE_BODY_MAX}.` }] });
    const u = await ready({
      frame: () => {
        throw new Error("“Reviewer” can't be labelled now");
      },
    });
    expect(refusal(await u.d.send(u.w, u.p, "the summary"))).toBe("“Reviewer” can't be labelled now");
    expect(u.wireOf(u.w).delivery).toMatchObject({ state: "failed", why: "“Reviewer” can't be labelled now" });
    expect(u.ptyOf(u.b.id).writes).toEqual([]);
  });
});

describe("what an agent can reach", () => {
  const sock = mcpLaunch("unused").env.MOCKINGBIRD_SOCK;
  const running = [
    { id: "rev", title: "Reviewer", ticketTitle: null, status: "idle", agent: "claude", repoPath: null, branch: null, taskGroup: null, cwd: "/w" },
    { id: "bld", title: "Builder", ticketTitle: null, status: "idle", agent: "claude", repoPath: null, branch: null, taskGroup: null, cwd: "/w" },
    { id: "oth", title: "Other", ticketTitle: null, status: "idle", agent: "claude", repoPath: null, branch: null, taskGroup: null, cwd: "/w" },
  ] as unknown as SessionInfo[];
  const delivered: string[] = [];
  const messages: { to: string; outcome: string; refused?: boolean }[] = [];
  const dir = tempDir("agent-paths");
  const store = new LandscapeStore({ file: path.join(dir, "landscape.json"), emit: () => {}, log: () => {} });
  const service = new WireService({ store, sessions: { list: () => running, resumable: () => [] }, roomOf: () => null, takenOver: () => null, log: () => {} });
  const relay = new Messaging({ list: () => running, deliverAgentMessage: (to: string) => (delivered.push(to), "delivered") } as any, () => true, () => {}, (m) => void messages.push(m));
  relay.setWires(service);

  beforeAll(async () => {
    vi.useRealTimers();
    relay.start();
    for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 20));
  });
  afterAll(() => {
    fs.rmSync(sock, { force: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });

  it("send_message between a feedback wire's two ends is refused both ways, saying to finish the step; between others it goes", async () => {
    const f = service.add("rev", "bld", "feedback");
    expect(f).not.toHaveProperty("refused");
    for (const [from, to] of [["rev", "bld"], ["bld", "rev"]]) {
      const r = await askAs(sock, { from, op: "send_message", args: { to, message: "fix the null check" } });
      expect(r.error, `${from} → ${to}`).toMatch(/two ends of a feedback wire, so send_message between them is off: finish your step with finish_step/);
    }
    expect(delivered).toEqual([]);
    expect(messages.map((m) => [m.to, m.refused])).toEqual([["bld", true], ["rev", true]]);
    expect((await askAs(sock, { from: "rev", op: "send_message", args: { to: "oth", message: "hello" } })).result).toMatch(/^Delivered/);
    expect(delivered).toEqual(["oth"]);
  });

  it("has no tool that sends, settles or counts along a wire", async () => {
    const launch = mcpLaunch("rev");
    const server = startServer(launch);
    try {
      const names: string[] = (await server.request("tools/list")).result.tools.map((t: any) => t.name);
      expect(names.filter((n) => /wire|gate|round|link|send|deliver|mark|pending|offer/i.test(n)).sort()).toEqual(["list_links", "send_message"]);
    } finally {
      await server.stop();
      retireMcpLaunch(launch);
    }
    for (const op of ["wires:send", "wires:sendAgain", "wires:markSent", "wires:moreRounds", "wires:resetRounds", "send", "offer", "mark_sent", "more_rounds"]) {
      expect((await askAs(sock, { from: "rev", op, args: { wire: "x", pending: "p", body: "b" } })).error, op).toMatch(/Unknown tool/);
    }
  });
});
