import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers";
import { tildePath } from "../src/shared/paths";
import { wireEndOf, wireRefusal, type WireContext } from "../src/shared/wires";
import type { SessionInfo, SessionStatus } from "../src/shared/types";
import type { QueueReceipt } from "../src/main/sessions";

/** Every pty the manager starts: what it runs, where, with what environment, what was written to it, and a way to end it. */
type FakePty = { args: string[]; cwd: string; env: Record<string, string>; writes: string[]; killed: boolean; emit(d: string): void; exit(code: number, signal?: number): void };
const ptys: FakePty[] = [];
const spawnFails = vi.hoisted(() => ({ next: false }));
vi.mock("node-pty", () => ({
  spawn: (_file: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => {
    if (spawnFails.next) {
      spawnFails.next = false;
      throw new Error("posix_spawnp failed.");
    }
    let onData: (d: string) => void = () => {};
    let onExit: (e: { exitCode: number; signal?: number }) => void = () => {};
    const p: FakePty = { args, cwd: opts.cwd, env: opts.env, writes: [], killed: false, emit: (d) => onData(d), exit: (exitCode, signal) => onExit({ exitCode, signal }) };
    ptys.push(p);
    return {
      onData: (cb: any) => ((onData = cb), { dispose() {} }),
      onExit: (cb: any) => ((onExit = cb), { dispose() {} }),
      write: (d: string) => p.writes.push(d),
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

const ptyOf = (id: string) => ptys.filter((p) => p.env.MOCKINGBIRD_SESSION === id).at(-1)!;

/** A session manager over `saved` (a store's records), as main builds one; a second over the same records is the app started again. */
async function manager(saved: SessionInfo[] = []) {
  const { SessionManager } = await import("../src/main/sessions");
  const store = {
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
  const m = new SessionManager(store as any);
  m.scrollbackDir = scrollback;
  const statuses: SessionStatus[] = [];
  m.onStatusChanged((info) => statuses.push(info.status));
  return { m, saved, statuses };
}
const scrollback = path.join(tempDir("sb"), "scrollback");

/** A Claude conversation on disk, as `--resume <id>` would find it. */
function transcript(id: string): void {
  const dir = path.join(os.homedir(), ".claude", "projects", "-Users-you-Code-app");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), "{}\n");
}

const folder = tempDir("app");
const agentPane = { repoPath: null, cwd: folder, useWorktree: false, agent: "claude" as const, title: "builder", model: "opus" };

/** An agent pane running conversation `conv`, which has drawn some output. */
async function running(m: Awaited<ReturnType<typeof manager>>["m"], conv = "conv-1") {
  transcript(conv);
  const s = await m.create(agentPane);
  m.statusFromHook({ paneId: s.id, conversationId: conv, agent: "claude", status: "idle", started: true });
  ptyOf(s.id).emit("⏺ The org picker remembers the last org now.\r\n> /exit\r\n");
  return s;
}
const info = (m: Awaited<ReturnType<typeof manager>>["m"], id: string) => m.list().find((s) => s.id === id);
/** Waits for session `id`'s next pty, after `before`. */
const nextPty = (id: string, before: FakePty) => vi.waitFor(() => expect(ptyOf(id)).not.toBe(before));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an agent quitting on its own (exit code 0)", () => {
  it("leaves the pane a terminal in its folder: same id, its scrollback above the prompt, its conversation kept, never exited", async () => {
    const t = await manager();
    const s = await running(t.m);
    const agent = ptyOf(s.id);
    agent.exit(0);
    // what tells a terminal from an agent pane changes at once, before any shell starts
    expect(info(t.m, s.id)).toMatchObject({ id: s.id, shell: true, agentQuit: "claude", status: "idle", conversation: { agent: "claude", id: "conv-1" } });
    expect(info(t.m, s.id)!.agent).toBeUndefined();
    await nextPty(s.id, agent);
    const shell = ptyOf(s.id);
    expect(shell.args).toEqual(["-il"]);
    expect(shell.cwd).toBe(folder);
    expect(info(t.m, s.id)).toMatchObject({ id: s.id, shell: true, agentQuit: "claude", status: "idle", cwd: folder, title: "builder", model: "opus", conversation: { agent: "claude", id: "conv-1" } });
    expect(t.saved.find((x) => x.id === s.id)).toMatchObject({ shell: true, agentQuit: "claude", conversation: { agent: "claude", id: "conv-1" } });
    const buffer = t.m.buffer(s.id);
    expect(buffer).toContain("The org picker remembers the last org now.");
    expect(buffer).toContain(`Claude exited — this is now a terminal in ${tildePath(folder)}.`);
    expect(buffer.indexOf("remembers the last org")).toBeLessThan(buffer.indexOf("Claude exited"));
    expect(t.statuses).not.toContain("dead");
  });

  it("isn't a crash: a non-zero exit, or one ended by a signal, leaves it exited as before", async () => {
    const t = await manager();
    const a = await running(t.m);
    const n = ptys.length;
    ptyOf(a.id).exit(1);
    expect(info(t.m, a.id)).toMatchObject({ status: "dead", exitCode: 1, agent: "claude" });
    expect(info(t.m, a.id)!.shell).toBeUndefined();
    const b = await running(t.m, "conv-2");
    ptyOf(b.id).exit(0, 15); // node-pty's report of a process killed by SIGTERM
    expect(info(t.m, b.id)).toMatchObject({ status: "dead", exitCode: 0, agent: "claude" });
    await new Promise((r) => setTimeout(r, 20));
    expect(ptys.length).toBe(n + 1); // only b's own launch: nothing started for either exit
  });

  it("changes nothing Mockingbird stopped itself: Stop, close, restart and quitting the app are as before", async () => {
    const t = await manager();
    const first = ptys.length;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Stop: exited, its pty's exit after that changes nothing
    const stopped = await running(t.m);
    t.m.stop(stopped.id);
    ptyOf(stopped.id).exit(0);
    expect(info(t.m, stopped.id)).toMatchObject({ status: "dead", agent: "claude" });
    // closed: gone from the panes, its record an agent pane's
    const closed = await running(t.m, "conv-2");
    const closedPty = ptyOf(closed.id);
    t.m.kill(closed.id, false);
    closedPty.exit(0);
    expect(info(t.m, closed.id)).toBeUndefined();
    expect(t.saved.find((x) => x.id === closed.id)).toMatchObject({ agent: "claude" });
    // restarted: the agent again, and the replaced pty's exit is nobody's
    const restarted = await running(t.m, "conv-3");
    const before = ptyOf(restarted.id);
    await t.m.restart(restarted.id);
    const after = ptyOf(restarted.id);
    before.exit(0);
    expect(after.args.join(" ")).toContain("conv-3");
    expect(info(t.m, restarted.id)).toMatchObject({ agent: "claude", status: "working" });
    expect(info(t.m, restarted.id)!.shell).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(ptyOf(restarted.id)).toBe(after);
    // the app quitting: each pane's record as it was
    const quitting = await running(t.m, "conv-4");
    const n = ptys.length;
    const done = t.m.shutdown(1000);
    for (const p of ptys.slice(first)) p.exit(0);
    await done;
    expect(ptys.length).toBe(n);
    expect(t.saved.find((x) => x.id === quitting.id)).toMatchObject({ agent: "claude" });
    expect(t.saved.find((x) => x.id === quitting.id)!.shell).toBeUndefined();
  });

  it("is for interactive agent panes only: a debrief exits as before", async () => {
    const t = await manager();
    vi.spyOn(console, "error").mockImplementation(() => {}); // a debrief here starts without Azure DevOps access
    const d = await t.m.create({ ...agentPane, debrief: true, title: "morning brief" });
    ptyOf(d.id).exit(0);
    expect(info(t.m, d.id)).toMatchObject({ status: "dead", debrief: true });
    expect(info(t.m, d.id)!.shell).toBeUndefined();
  });

  it("takes no key between its agent's exit and its shell's start, and hears nothing more from that agent's hooks", async () => {
    const t = await manager();
    const s = await running(t.m);
    const agent = ptyOf(s.id);
    agent.exit(0);
    t.m.write(s.id, "rm -rf build\r");
    expect(t.m.statusFromHook({ paneId: s.id, status: "working", at: Math.floor(Date.now() / 1000) })).toBeNull();
    await nextPty(s.id, agent);
    expect(agent.writes).toEqual([]);
    expect(ptyOf(s.id).writes).toEqual([]);
    // an event its agent wrote before quitting, read late: still not this terminal's
    expect(t.m.statusFromHook({ paneId: s.id, status: "working", at: Math.floor(info(t.m, s.id)!.createdAt / 1000) })).toBeNull();
    expect(info(t.m, s.id)!.status).toBe("idle");
    // an agent started in the terminal by hand, later, reports as it would in any terminal
    expect(t.m.statusFromHook({ paneId: s.id, status: "working", at: Math.floor(info(t.m, s.id)!.createdAt / 1000) + 2 })).toMatchObject({ status: "working" });
  });

  it("never types its agent's kickoff into the terminal: a pane whose agent quit before its kickoff was due", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const t = await manager();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const s = await t.m.create({ ...agentPane, initialPrompt: "Work on #5101: org dropdowns" });
      const agent = ptyOf(s.id);
      agent.exit(0);
      await vi.waitFor(() => expect(ptyOf(s.id)).not.toBe(agent));
      vi.advanceTimersByTime(7000);
      expect(agent.writes).toEqual([]);
      expect(ptyOf(s.id).writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("left exited, as its agent was, when the terminal can't start, saying why in the pane", async () => {
    const t = await manager();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await running(t.m);
    spawnFails.next = true;
    ptyOf(s.id).exit(0);
    await vi.waitFor(() => expect(info(t.m, s.id)!.status).toBe("dead"));
    expect(info(t.m, s.id)).toMatchObject({ agent: "claude", exitCode: 0 });
    expect(info(t.m, s.id)!.shell).toBeUndefined();
    expect(info(t.m, s.id)!.agentQuit).toBeUndefined();
    expect(t.m.buffer(s.id)).toContain("Claude exited, and a terminal couldn't open here: Failed to launch a terminal");
    expect(errors).toHaveBeenCalled();
    // and its Resume brings the agent back, as any exited pane's does
    expect(await t.m.resume(s.id)).toMatchObject({ id: s.id, agent: "claude" });
    expect(ptyOf(s.id).args.join(" ")).toContain("conv-1");
  });
});

describe("a terminal its agent quit into", () => {
  async function quit(m: Awaited<ReturnType<typeof manager>>["m"], conv = "conv-1") {
    const s = await running(m, conv);
    const agent = ptyOf(s.id);
    agent.exit(0);
    await nextPty(s.id, agent);
    return s;
  }
  const receipt = () => {
    const heard: [string, string?][] = [];
    const r: QueueReceipt = { pasting: () => true, settled: (outcome, why) => void heard.push([outcome, why]) };
    return { r, heard };
  };

  it("takes no agent messages or broadcasts, and no wire but a shared worktree's", async () => {
    const t = await manager();
    const s = await quit(t.m);
    const other = await running(t.m, "conv-2");
    expect(() => t.m.deliverAgentMessage(s.id, "run the tests", true, other.id)).toThrow("“builder” is a terminal: agent messages are never typed into terminals");
    expect(() => t.m.deliverNotice(s.id, "overdue", "[Mockingbird: your message is late]", true)).toThrow(/is a terminal/);
    expect(t.m.broadcast("everyone: rebase", [s.id], false)).toEqual([{ id: s.id, outcome: "skipped" }]);
    await new Promise((r) => setTimeout(r, 200));
    expect(ptyOf(s.id).writes).toEqual([]);
    // as a wire's end it's a terminal: a handoff or a context link to it is refused
    const end = (x: SessionInfo) => wireEndOf(x, { room: null, takenOver: null, outsideSandbox: false, placed: true, folder: x.cwd, running: true });
    const ends = new Map([s, other].map((x) => [x.id, end(info(t.m, x.id)!)]));
    const ctx = { end: (id: string) => ends.get(id) ?? null, links: {}, roomsUnknown: null } as unknown as WireContext;
    expect(ends.get(s.id)!.kind).toBe("terminal");
    expect(wireRefusal(other.id, s.id, "handoff", ctx)).toBe("“builder” is a terminal: only a shared worktree wire can reach one.");
  });

  it("fails what was queued with a receipt as its agent quit, and keeps the rest for its agent's next launch", async () => {
    const t = await manager();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await running(t.m);
    t.m.statusFromHook({ paneId: s.id, status: "working", prompted: true });
    const { r, heard } = receipt();
    t.m.deliverAgentMessage(s.id, "the summary", true, undefined, r);
    t.m.deliverAgentMessage(s.id, "from Reviewer: look at the tests", true, "rv000001");
    const agent = ptyOf(s.id);
    agent.exit(0);
    expect(heard).toEqual([["failed", "“builder”'s Claude quit before this reached it: it's a terminal now"]]);
    await nextPty(s.id, agent);
    expect(info(t.m, s.id)!.queuedCount).toBe(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(ptyOf(s.id).writes).toEqual([]);
    // Resume Claude: the agent pane gets what waited for it, once it's at its prompt
    await t.m.resumeAgent(s.id);
    expect(info(t.m, s.id)!.queuedCount).toBe(1);
    t.m.statusFromHook({ paneId: s.id, status: "idle" });
    expect(ptyOf(s.id).writes.join("")).toContain("from Reviewer: look at the tests");
  });

  it("goes back to its agent with Resume Claude: the same id, its conversation resumed, an agent pane again", async () => {
    const t = await manager();
    const s = await quit(t.m);
    const shell = ptyOf(s.id);
    shell.emit("you@mac app % git status\r\n");
    const r = await t.m.resumeAgent(s.id);
    expect(r).toMatchObject({ id: s.id, agent: "claude", model: "opus", conversation: { agent: "claude", id: "conv-1" } });
    expect(shell.killed).toBe(true);
    const back = ptyOf(s.id);
    expect(back.args[0]).toBe("-ilc");
    expect(back.args[1]).toContain("'--resume' 'conv-1'");
    expect(back.args[1]).toContain("'--model' 'opus'");
    expect(back.cwd).toBe(folder);
    const now = info(t.m, s.id)!;
    expect(now.shell).toBeUndefined();
    expect(now.agentQuit).toBeUndefined();
    expect(t.saved.find((x) => x.id === s.id)!.agentQuit).toBeUndefined();
    expect(t.m.buffer(s.id)).toContain("git status");
    // an agent pane again: quitting it makes it a terminal again
    back.exit(0);
    expect(info(t.m, s.id)).toMatchObject({ shell: true, agentQuit: "claude" });
  });

  it("goes back to its agent from its exited shell too, while its own Resume reopens the terminal", async () => {
    const t = await manager();
    const s = await quit(t.m);
    ptyOf(s.id).exit(0); // `exit` typed in the shell: a terminal's exit is any pane's
    expect(info(t.m, s.id)).toMatchObject({ status: "dead", shell: true, agentQuit: "claude" });
    expect(await t.m.resume(s.id)).toMatchObject({ id: s.id, shell: true, agentQuit: "claude" });
    expect(ptyOf(s.id).args).toEqual(["-il"]);
    ptyOf(s.id).exit(0);
    expect(await t.m.resumeAgent(s.id)).toMatchObject({ id: s.id, agent: "claude" });
    expect(ptyOf(s.id).args[1]).toContain("'--resume' 'conv-1'");
  });

  it("refuses Resume <agent> for what isn't one, saying why", async () => {
    const t = await manager();
    const agentPaneNow = await running(t.m);
    const plain = await t.m.create({ ...agentPane, shell: true, agent: undefined, title: "terminal" });
    expect(await t.m.resumeAgent(agentPaneNow.id)).toEqual({ refused: "It isn't a terminal an agent quit into" });
    expect(await t.m.resumeAgent(plain.id)).toEqual({ refused: "It isn't a terminal an agent quit into" });
    expect(await t.m.resumeAgent("nope0000")).toEqual({ refused: "It isn't open here: reopen it from its ghost card or Closed sessions first" });
    const s = await quit(t.m, "conv-2");
    t.m.relaunchGuard = (id) => (id === s.id ? "Nick continues it on his laptop" : null);
    expect(await t.m.resumeAgent(s.id)).toEqual({ refused: "Nick continues it on his laptop" });
  });

  it("reopens as a terminal after the app starts again, its conversation remembered for Resume Claude", async () => {
    const before = await manager();
    const s = await quit(before.m);
    before.m.saveScrollback(true);
    await before.m.shutdown(10);
    // the app started again over the same records
    const after = await manager(before.saved);
    expect(after.m.resumable().find((x) => x.id === s.id)).toMatchObject({ shell: true, agentQuit: "claude", conversation: { agent: "claude", id: "conv-1" } });
    const freed: unknown[] = [];
    after.m.freeConversation = async (c) => {
      freed.push(c);
      return null;
    };
    const reopened = await after.m.relaunch(s.id);
    expect(reopened).toMatchObject({ id: s.id, shell: true, agentQuit: "claude", conversation: { agent: "claude", id: "conv-1" } });
    // a plain shell: its agent isn't run again, and the conversation isn't taken from wherever else it's open
    expect(ptyOf(s.id).args).toEqual(["-il"]);
    expect(freed).toEqual([]);
    expect(after.m.buffer(s.id)).toContain("Claude exited — this is now a terminal in");
    expect(await after.m.resumeAgent(s.id)).toMatchObject({ id: s.id, agent: "claude" });
    expect(ptyOf(s.id).args[1]).toContain("'--resume' 'conv-1'");
  });
});
