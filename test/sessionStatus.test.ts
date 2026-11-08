import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

// every pane's pty: what was typed into it
const typed = new Map<number, string[]>();
let pids = 0;
vi.mock("node-pty", () => ({
  spawn: () => {
    const pid = ++pids;
    typed.set(pid, []);
    return { pid, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write: (d: string) => typed.get(pid)!.push(d), resize() {}, kill() {} };
  },
}));

const { SessionManager, finishedAtAfter } = await import("../src/main/sessions");
const { installHooks, watchEvents } = await import("../src/main/hooks");

const script = path.join(os.homedir(), ".mockingbird", "hook.sh");
const pane = (m: InstanceType<typeof SessionManager>, id: string) => (m as any).live.get(id);
const typedInto = (m: InstanceType<typeof SessionManager>, id: string) => typed.get(pane(m, id).proc.pid)!.join("");

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

function manager() {
  const store = { settings: { claudeBin: "/bin/echo", codexBin: "/bin/echo" }, state: { sessions: [] as any[] }, upsertSession(i: any) { const at = this.state.sessions.findIndex((s: any) => s.id === i.id); if (at >= 0) this.state.sessions[at] = { ...i }; else this.state.sessions.push({ ...i }); }, removeSession() {}, save() {} };
  const m = new SessionManager(store as any);
  stops.push(watchEvents(m, () => {}));
  return m;
}

/** An agent's hook, through the installed hook.sh, as the agent in pane `id` runs it. */
function hook(event: string, id: string, payload: object = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(script, [event], { env: { ...process.env, MOCKINGBIRD_SESSION: id }, timeout: 5000 }, (err) => (err ? reject(err) : resolve()));
    child.stdin!.end(JSON.stringify({ session_id: `conv-${id}`, cwd: os.homedir(), hook_event_name: event, ...payload }));
  });
}

const until = async (what: string, done: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("a pane's status from its agent's hooks", () => {
  installHooks(null);

  it("is idle once its agent has started at its prompt, and a message queued for it then arrives", async () => {
    const m = manager();
    const s = await m.create({ repoPath: null, useWorktree: false, agent: "claude", title: "Data Migration" });
    expect(s.status).toBe("working"); // nothing has said where the agent is yet
    expect(m.deliverAgentMessage(s.id, "hand-off: run the backfill", true, "sender")).toMatch(/queued until its current turn ends/);
    await hook("SessionStart", s.id, { source: "startup" });
    await until("the pane to go idle", () => pane(m, s.id).info.status === "idle");
    await until("the message to be typed in", () => typedInto(m, s.id).includes("hand-off: run the backfill"));
    expect(pane(m, s.id).info.status).toBe("working"); // submitted: its turn runs
  });

  it("delivers what a relaunched pane was owed once it has resumed, with no turn run in it", async () => {
    const m = manager();
    const s = await m.create({ repoPath: null, useWorktree: false, agent: "claude", title: "Data Migration" });
    m.deliverAgentMessage(s.id, "while you were out", true, "sender");
    m.kill(s.id); // the app quitting: the pane is closed to be resumed
    const again = await m.create({ repoPath: null, useWorktree: false, agent: "claude", title: "Data Migration", reuseId: s.id });
    expect(again.status).toBe("working");
    await hook("SessionStart", s.id, { source: "resume" });
    await until("the owed message to be typed in", () => typedInto(m, s.id).includes("while you were out"));
  });

  it("goes idle when a turn ends, and a message queued during the turn arrives then", async () => {
    const m = manager();
    const s = await m.create({ repoPath: null, useWorktree: false, agent: "claude", title: "busy" });
    await hook("UserPromptSubmit", s.id, { prompt: "go" });
    await hook("PreToolUse", s.id, { tool_name: "Bash" });
    await new Promise((r) => setTimeout(r, 700));
    expect(pane(m, s.id).info.status).toBe("working");
    m.deliverAgentMessage(s.id, "after your turn", true, "sender");
    await hook("Stop", s.id);
    await until("the message to be typed in", () => typedInto(m, s.id).includes("after your turn"));
  });

  it("marks when its turn ended (what Needs you lists as finished) until it works, waits or starts again", async () => {
    const m = manager();
    const s = await m.create({ repoPath: null, useWorktree: false, agent: "claude", title: "finishing" });
    const info = () => pane(m, s.id).info;
    await hook("SessionStart", s.id, { source: "startup" });
    await until("the pane to go idle", () => info().status === "idle");
    expect(info().finishedAt ?? null).toBeNull(); // started at its prompt: it has finished nothing
    await hook("UserPromptSubmit", s.id, { prompt: "go" });
    await until("the turn to start", () => info().status === "working");
    const before = Date.now();
    await hook("Stop", s.id);
    await until("the turn's end to be marked", () => !!info().finishedAt);
    expect(info().status).toBe("idle");
    const at = info().finishedAt!;
    expect(at).toBeGreaterThanOrEqual(before);
    // the idle reminder, and a second Stop while it's still idle, leave the first time
    await hook("Notification", s.id, { message: "Claude is waiting for your input" });
    await hook("Stop", s.id);
    await new Promise((r) => setTimeout(r, 700));
    expect(info().finishedAt).toBe(at);
    // asking for permission is waiting, not finished
    await hook("Notification", s.id, { message: "Claude needs your permission to use Bash" });
    await until("the pane to wait", () => info().status === "waiting");
    expect(info().finishedAt).toBeNull();
    await hook("Stop", s.id);
    await until("the next turn's end to be marked", () => !!info().finishedAt);
    // a /clear starts a new conversation at its prompt: the mark goes with the old one
    await hook("SessionStart", s.id, { source: "clear" });
    await until("the mark to clear", () => info().finishedAt === null);
    expect(info().status).toBe("idle");
  });

  it("works out the turn's end from the status before and the hook", () => {
    const idleAt = (finishedAt: number | null) => ({ status: "idle" as const, finishedAt });
    expect(finishedAtAfter({ status: "working" }, { status: "idle", finished: true }, 5)).toBe(5);
    expect(finishedAtAfter(idleAt(3), { status: "idle", finished: true }, 5)).toBe(3);
    expect(finishedAtAfter(idleAt(3), { status: "idle" }, 5)).toBe(3); // the idle reminder
    expect(finishedAtAfter({ status: "waiting", finishedAt: null }, { status: "idle" }, 5)).toBeNull(); // a declined prompt, the reminder
    expect(finishedAtAfter(idleAt(3), { status: "idle", started: true }, 5)).toBeNull();
    expect(finishedAtAfter(idleAt(3), { status: "working" }, 5)).toBeNull();
    expect(finishedAtAfter(idleAt(3), { status: "waiting" }, 5)).toBeNull();
  });

  it("waits for a kickoff prompt rather than taking its start for idle", async () => {
    const m = manager();
    const s = await m.create({ repoPath: null, useWorktree: false, agent: "claude", title: "kicked off", initialPrompt: "the ticket" });
    m.deliverAgentMessage(s.id, "not before the kickoff", true, "sender");
    m.statusFromHook({ paneId: s.id, status: "idle", started: true });
    expect(pane(m, s.id).info.status).toBe("working");
    await new Promise((r) => setTimeout(r, 1700));
    expect(typedInto(m, s.id)).not.toContain("not before the kickoff");
  });
});

describe("a pane whose status can't be trusted", () => {
  it("says so when it has been 'working' with no hook event and no output since it started, and stops once one arrives", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = manager();
    const s = await m.create({ repoPath: null, useWorktree: false, agent: "claude", title: "silent" });
    const now = Date.now();
    m.checkStalls(now + 10 * 60_000, 5 * 60_000);
    expect(m.list().find((x) => x.id === s.id)).toMatchObject({ status: "working", hooksSilent: true });
    expect(warn.mock.calls.flat().join(" ")).toMatch(/no hook event from its Claude since it started/);
    m.statusFromHook({ paneId: s.id, status: "working" });
    expect(m.list().find((x) => x.id === s.id)!.hooksSilent).toBe(false);
    m.checkStalls(now + 20 * 60_000, 5 * 60_000);
    expect(m.list().find((x) => x.id === s.id)).toMatchObject({ hooksSilent: false, stalledSince: expect.any(Number) }); // stalled, but its hooks do report
    warn.mockRestore();
  });

  it("can be marked idle by hand, which delivers what waited for it", async () => {
    const m = manager();
    const s = await m.create({ repoPath: null, useWorktree: false, agent: "claude", title: "stuck" });
    m.deliverAgentMessage(s.id, "finally", true, "sender");
    m.clearWaiting(s.id);
    await until("the message to be typed in", () => typedInto(m, s.id).includes("finally"));
  });

  it("tells a message's sender, once, when it has waited too long", async () => {
    const m = manager();
    const s = await m.create({ repoPath: null, useWorktree: false, agent: "claude", title: "Data Migration" });
    m.deliverAgentMessage(s.id, "hand-off", true, "sender");
    m.deliverAgentMessage(s.id, "a broadcast has no sender to tell", true);
    const now = Date.now();
    expect(m.overdueMessages(now + 60_000, 15 * 60_000)).toEqual([]);
    m.checkStalls(now + 16 * 60_000, 5 * 60_000);
    expect(m.overdueMessages(now + 16 * 60_000, 15 * 60_000)).toEqual([
      { from: "sender", to: s.id, toTitle: "Data Migration", toStatus: "working", hooksSilent: true, waitedMs: expect.any(Number) },
    ]);
    expect(m.overdueMessages(now + 30 * 60_000, 15 * 60_000)).toEqual([]); // told once
  });
});

// keep the fake HOME's hook events from leaking into another test file's run
afterEach(() => fs.rmSync(path.join(os.homedir(), ".mockingbird", "events"), { recursive: true, force: true }));
