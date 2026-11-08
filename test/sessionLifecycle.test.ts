import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers";

/** Every pty the manager starts: what it was asked to run and with what environment, what was written to it, and a way to end it. */
type FakePty = { args: string[]; env: Record<string, string>; writes: string[]; killed: boolean; signals: string[]; emit(d: string): void; exit(code: number): void };
const ptys: FakePty[] = [];
vi.mock("node-pty", () => ({
  spawn: (_file: string, args: string[], opts: { env: Record<string, string> }) => {
    let onData: (d: string) => void = () => {};
    let onExit: (e: { exitCode: number }) => void = () => {};
    const p: FakePty = { args, env: opts.env, writes: [], killed: false, signals: [], emit: (d) => onData(d), exit: (exitCode) => onExit({ exitCode }) };
    ptys.push(p);
    return {
      onData: (cb: any) => ((onData = cb), { dispose() {} }),
      onExit: (cb: any) => ((onExit = cb), { dispose() {} }),
      write: (d: string) => p.writes.push(d.replace(/\x1b\[20[01]~/g, "|")),
      resize() {},
      kill: (signal?: string) => {
        p.killed = true;
        p.signals.push(signal ?? "SIGHUP");
      },
      pid: 1,
    };
  },
}));

// looking binaries up on PATH, under the test's control
const lookups = vi.hoisted(() => ({ which: (bin: string): Promise<string | null> => Promise.resolve(`/found/${bin}`), whichSync: (bin: string): string | null => `/found/${bin}` }));
vi.mock("../src/main/shell", async (original) => ({
  ...(await original<typeof import("../src/main/shell")>()),
  which: (bin: string) => lookups.which(bin),
  whichSync: (bin: string) => lookups.whichSync(bin),
}));

async function manager() {
  const { SessionManager } = await import("../src/main/sessions");
  const saved: any[] = [];
  const store = {
    settings: { claudeBin: "/bin/echo", codexBin: "/bin/echo", workTrackerPath: tempDir("worktracker") },
    state: { sessions: saved },
    upsertSession(i: any) {
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
  m.scrollbackDir = path.join(tempDir("sb"), "scrollback");
  return { m, store };
}
const agentPane = { repoPath: null, useWorktree: false, agent: "claude" as const, title: "a" };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("closing a pane", () => {
  it("ends it even when its scrollback can't be saved", async () => {
    const { m } = await manager();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await m.create(agentPane);
    ptys.at(-1)!.emit("some output\r\n");
    m.scrollbackDir = "/dev/null/scrollback"; // a disk that won't take the write
    expect(() => m.kill(s.id, false)).not.toThrow();
    expect(ptys.at(-1)!.killed).toBe(true);
    expect(m.list().map((x) => x.id)).not.toContain(s.id);
    expect(errors).toHaveBeenCalled();
  });
});

describe("quitting the app", () => {
  it("ends every pty, closed panes' too, and waits for them all to exit, leaving each pane's saved state as it was", async () => {
    const { m, store } = await manager();
    const a = await m.create(agentPane);
    const b = await m.create({ ...agentPane, title: "b" });
    const closed = await m.create({ ...agentPane, title: "closed" });
    m.kill(closed.id, false); // signalled, but its pty hasn't exited yet
    const [pa, pb, pc] = ptys.slice(-3);
    const before = JSON.stringify(store.state.sessions);
    let finished = false;
    const quit = m.shutdown(60_000).then(() => (finished = true));
    expect([pa, pb, pc].map((p) => p.signals.at(-1))).toEqual(["SIGHUP", "SIGHUP", "SIGHUP"]);
    pa.emit("output after the signal\r\n");
    pa.exit(129);
    pc.exit(129);
    await new Promise((r) => setTimeout(r, 10));
    expect(finished).toBe(false); // b's exit is still to come
    pb.exit(129);
    await quit;
    expect(JSON.stringify(store.state.sessions)).toBe(before);
    expect(m.list().find((x) => x.id === a.id)?.status).not.toBe("dead");
    expect(m.list().find((x) => x.id === b.id)?.status).not.toBe("dead");
  });

  it("kills a pty that outlives the grace period, and says when one still hasn't exited", async () => {
    const { m } = await manager();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await m.create(agentPane);
    const p = ptys.at(-1)!;
    await m.shutdown(20);
    expect(p.signals).toEqual(["SIGHUP", "SIGKILL"]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("1 pty(s) still running"))).toBe(true);
  });

  it("starts no pty once shutdown has begun, not even for a launch already under way", async () => {
    const { m } = await manager();
    await m.create(agentPane);
    const started = ptys.length;
    const launching = m.create({ ...agentPane, title: "late" }); // still preparing when the quit begins
    const quit = m.shutdown(20);
    await expect(launching).rejects.toThrow(/quitting/);
    await expect(m.create({ ...agentPane, title: "later" })).rejects.toThrow(/quitting/);
    expect(ptys.length).toBe(started);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await quit;
  });

  it("kills every pty at once when a quit is forced", async () => {
    const { m } = await manager();
    await m.create(agentPane);
    await m.create({ ...agentPane, title: "b" });
    const [a, b] = ptys.slice(-2);
    m.killAll();
    expect([a.signals, b.signals]).toEqual([["SIGKILL"], ["SIGKILL"]]);
    await expect(m.create({ ...agentPane, title: "after" })).rejects.toThrow(/quitting/);
  });
});

describe("messages waiting for a pane", () => {
  it("are still delivered after it restarts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { m } = await manager();
    const s = await m.create(agentPane); // starts working
    expect(m.deliverAgentMessage(s.id, "the API changed", true)).toMatch(/queued/);
    await m.restart(s.id);
    expect(m.list().find((x) => x.id === s.id)?.queuedCount).toBe(1);
    m.statusFromHook({ paneId: s.id, status: "idle" });
    vi.advanceTimersByTime(200);
    expect(ptys.at(-1)!.writes).toEqual(["|the API changed|", "\r"]);
  });

  it("are still delivered when a pane that died is relaunched", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { m } = await manager();
    const s = await m.create(agentPane);
    m.broadcast("status?", [s.id], true);
    ptys.at(-1)!.exit(1);
    await m.relaunch(s.id);
    m.statusFromHook({ paneId: s.id, status: "idle" });
    vi.advanceTimersByTime(200);
    expect(ptys.at(-1)!.writes).toEqual(["|status?|", "\r"]);
  });

  it("are logged, not silently dropped, when the pane is closed for good", async () => {
    const { m } = await manager();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await m.create(agentPane);
    m.deliverAgentMessage(s.id, "never seen", true);
    m.kill(s.id, true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("1 undelivered message") && String(c[0]).includes("never seen"))).toBe(true);
  });
});

describe("scrollback files", () => {
  it("are written for panes that can be resumed", async () => {
    const { m } = await manager();
    const s = await m.create(agentPane);
    ptys.at(-1)!.emit("hello\r\n");
    m.kill(s.id, false);
    expect(fs.readFileSync(path.join(m.scrollbackDir, `${s.id}.log`), "utf8")).toBe("hello\r\n");
  });

  it("are never written for debriefs, which don't outlive the app — a restart still shows what they said", async () => {
    const { m } = await manager();
    const s = await m.create({ ...agentPane, debrief: true });
    ptys.at(-1)!.emit("Morning! What's first today?\r\n");
    m.saveScrollback(true); // quitting
    expect(fs.existsSync(path.join(m.scrollbackDir, `${s.id}.log`))).toBe(false);
    await m.restart(s.id);
    expect(fs.existsSync(path.join(m.scrollbackDir, `${s.id}.log`))).toBe(false);
    expect(m.buffer(s.id).startsWith("Morning! What's first today?\r\n")).toBe(true);
  });
});

describe("a terminal that brings back the agent it was running", () => {
  it("resumes the conversation without the messaging tools — terminals are outside agent messaging", async () => {
    const { m } = await manager();
    await m.create({ repoPath: null, useWorktree: false, shell: true, shellResume: { agent: "claude", id: "conv-1" }, title: "t" });
    const command = ptys.at(-1)!.args.join(" ");
    expect(command).toContain("--resume");
    expect(command).toContain("conv-1");
    expect(command).not.toContain("--mcp-config");
    await m.create(agentPane);
    expect(ptys.at(-1)!.args.join(" ")).toContain("--mcp-config"); // an agent pane has them
  });
});

describe("a pane's conversations", () => {
  it("keep the one it resumes last — the latest — after a relaunch", async () => {
    const { m, store } = await manager();
    const s = await m.create(agentPane);
    m.statusFromHook({ paneId: s.id, conversationId: "one", agent: "claude", status: "working" });
    m.statusFromHook({ paneId: s.id, conversationId: "two", agent: "claude", status: "working" });
    m.kill(s.id, false);
    await m.create({ ...agentPane, reuseId: s.id, resumeSessionId: "one" });
    expect(store.state.sessions.find((x: any) => x.id === s.id).conversations).toEqual(["two", "one"]);
  });
});

describe("finding each agent's binary", () => {
  it("never caches a lookup that started before the setting changed", async () => {
    const { m, store } = await manager();
    (store.settings as any).claudeBin = "claude-old";
    (store.settings as any).codexBin = "/bin/codex";
    let finish: (v: string) => void = () => {};
    lookups.which = (bin) => new Promise((r) => (finish = () => r(`/found/${bin}`)));
    const warming = m.warmBins();
    (store.settings as any).claudeBin = "claude-new"; // Settings → claude binary
    m.resetBinCache();
    finish("");
    await warming;
    expect(m.binFor("claude")).toBe("/found/claude-new");
  });
});

describe("a pane's terminal", () => {
  it("tells what runs on it that it draws 24-bit colour: agent panes and plain terminals alike", async () => {
    const { m } = await manager();
    await m.create(agentPane);
    expect(ptys.at(-1)!.env.COLORTERM).toBe("truecolor");
    await m.create({ ...agentPane, agent: "codex" });
    expect(ptys.at(-1)!.env.COLORTERM).toBe("truecolor");
    await m.create({ repoPath: null, useWorktree: false, shell: true, title: "plain" });
    expect(ptys.at(-1)!.env.COLORTERM).toBe("truecolor");
  });
});

describe("Claude Code's background sessions", () => {
  /** A Claude transcript on disk, so a relaunch resumes that conversation by id. */
  const transcript = (id: string) => {
    const dir = path.join(os.homedir(), ".claude", "projects", "-Users-nick-Code");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), "{}\n");
  };
  /** A pane that ran conversation `conv`, closed so it can be resumed. */
  async function closedPane(m: Awaited<ReturnType<typeof manager>>["m"], conv: string) {
    transcript(conv);
    const s = await m.create(agentPane);
    m.statusFromHook({ paneId: s.id, conversationId: conv, agent: "claude", status: "idle" });
    ptys.at(-1)!.emit("earlier output\r\n");
    m.kill(s.id, false);
    return s;
  }

  it("are off for every Claude a pane runs, so its conversation can't leave the pane", async () => {
    const { m } = await manager();
    const agentView = () => ptys.at(-1)!.env.CLAUDE_CODE_DISABLE_AGENT_VIEW;
    await m.create(agentPane);
    expect(agentView()).toBe("1");
    await m.create({ repoPath: null, useWorktree: false, shell: true, shellResume: { agent: "claude", id: "conv-1" }, title: "t" });
    expect(agentView()).toBe("1");
    await m.create({ ...agentPane, agent: "codex" });
    expect(agentView()).toBeUndefined();
    // a plain terminal is the user's: a claude they start in it is theirs to send to the background
    await m.create({ repoPath: null, useWorktree: false, shell: true, title: "plain" });
    expect(agentView()).toBeUndefined();
  });

  it("let go of the conversation a relaunch resumes first, and the pane says what was done", async () => {
    const { m } = await manager();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await closedPane(m, "bg-conv");
    const asked: unknown[] = [];
    const notice = "This conversation was running in Claude Code background session ab12cd34. Mockingbird stopped it there to resume it here.";
    m.freeConversation = async (c) => (asked.push(c), notice);
    await m.relaunch(s.id);
    expect(asked).toEqual([{ agent: "claude", id: "bg-conv" }]);
    expect(ptys.at(-1)!.args.join(" ")).toMatch(/--resume' 'bg-conv/);
    const shown = m.buffer(s.id);
    expect(shown.indexOf("earlier output")).toBeGreaterThanOrEqual(0);
    expect(shown.indexOf("earlier output")).toBeLessThan(shown.indexOf(notice));
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(`[sessions] ${s.id}: ${notice}`);
  });

  it("that won't let go fail the relaunch with why, start nothing, and leave the session to resume later", async () => {
    const { m } = await manager();
    const s = await closedPane(m, "busy-conv");
    m.freeConversation = async () => {
      throw new Error("This conversation is in the middle of a turn in Claude Code background session ab12cd34, outside its Mockingbird pane.");
    };
    const started = ptys.length;
    await expect(m.relaunch(s.id)).rejects.toThrow(/middle of a turn in Claude Code background session ab12cd34/);
    expect(ptys.length).toBe(started);
    expect(m.resumable().map((x) => x.id)).toContain(s.id);
  });

  /** A pane that ran conversation `conv`, stopped: exited, its pane still there to Resume. */
  async function stoppedPane(m: Awaited<ReturnType<typeof manager>>["m"], conv: string) {
    transcript(conv);
    const s = await m.create(agentPane);
    m.statusFromHook({ paneId: s.id, conversationId: conv, agent: "claude", status: "idle" });
    m.stop(s.id);
    return s;
  }

  it("that won't let go refuse a Resume with why before its pane is let go, which stays to resume once the turn ends", async () => {
    const { m } = await manager();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await stoppedPane(m, "busy-conv");
    const busy = "This conversation is in the middle of a turn in Claude Code background session ab12cd34, outside its Mockingbird pane. Resume once that turn ends.";
    m.freeConversation = async () => {
      throw new Error(busy);
    };
    const started = ptys.length;
    expect(await m.resume(s.id)).toEqual({ refused: busy });
    expect(m.list().find((x) => x.id === s.id)?.status).toBe("dead");
    expect(ptys.length).toBe(started);
    expect(warn.mock.calls.some((c) => String(c[0]).includes(busy))).toBe(true);
    // once it's free, Resume goes ahead: nothing was left under way
    m.freeConversation = async () => null;
    expect(await m.resume(s.id)).toMatchObject({ id: s.id });
    expect(ptys.length).toBe(started + 1);
  });

  it("for Resume, let go of it while the pane is kept, then check again, with nothing waited on from those checks to the kill", async () => {
    const { m } = await manager();
    const s = await stoppedPane(m, "bg-conv");
    let release!: (notice: string | null) => void;
    m.freeConversation = () => new Promise((r) => (release = r));
    let waited = false;
    const kill = m.kill.bind(m);
    let waitedAtKill: boolean | null = null;
    m.kill = (id: string, forget?: boolean) => {
      waitedAtKill = waited;
      return kill(id, forget);
    };
    const resumed = m.resume(s.id);
    await Promise.resolve();
    // a restart meanwhile is refused before it lets the pane go
    await expect(m.restart(s.id)).rejects.toThrow("It's being resumed already");
    expect(waitedAtKill).toBeNull();
    expect(m.list().find((x) => x.id === s.id)?.status).toBe("dead");
    // the conversation is free: queued once it is, this runs at the first thing waited on after
    release(null);
    queueMicrotask(() => (waited = true));
    expect(await resumed).toMatchObject({ id: s.id });
    expect(waitedAtKill).toBe(false);
  });

  it("for Resume, refuse it when a take-over arrives while the conversation is let go, the pane kept", async () => {
    const { m } = await manager();
    const s = await stoppedPane(m, "bg-conv");
    let release!: (notice: string | null) => void;
    m.freeConversation = () => new Promise((r) => (release = r));
    const resumed = m.resume(s.id);
    await Promise.resolve();
    const refusal = "“a” continues on Nick's laptop — take it back rather than running this copy again";
    m.relaunchGuard = () => refusal;
    const started = ptys.length;
    release(null);
    expect(await resumed).toEqual({ refused: refusal });
    expect(m.list().find((x) => x.id === s.id)?.status).toBe("dead");
    expect(ptys.length).toBe(started);
  });

  it("for Resume, say what letting the conversation go did when a take-over then refuses it", async () => {
    const { m } = await manager();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await stoppedPane(m, "bg-conv");
    const stopped = "This conversation was running in Claude Code background session ab12cd34, outside its Mockingbird pane. Mockingbird stopped it there to resume it here.";
    let release!: (notice: string | null) => void;
    m.freeConversation = () => new Promise((r) => (release = r));
    const resumed = m.resume(s.id);
    await Promise.resolve();
    const refusal = "“a” continues on Nick's laptop — take it back rather than running this copy again";
    m.relaunchGuard = () => refusal;
    release(stopped);
    expect(await resumed).toEqual({ refused: `${refusal}. Meanwhile, letting its conversation go: ${stopped}` });
    expect(warn.mock.calls.some((c) => String(c[0]).includes(stopped))).toBe(true);
    warn.mockRestore();
  });

  it("aren't asked about a pane with no conversation to resume by id", async () => {
    const { m } = await manager();
    const s = await m.create(agentPane);
    m.kill(s.id, false);
    const ask = vi.fn(async () => null);
    m.freeConversation = ask;
    await m.relaunch(s.id);
    expect(ask).not.toHaveBeenCalled();
  });

  it("make a second relaunch, a resume or a forget wait for nothing: each is refused while the first relaunch is under way", async () => {
    const { m, store } = await manager();
    const s = await closedPane(m, "slow-conv");
    let release!: (notice: string | null) => void;
    m.freeConversation = () => new Promise((r) => (release = r));
    const first = m.relaunch(s.id);
    await Promise.resolve();
    const started = ptys.length;
    await expect(m.relaunch(s.id)).rejects.toThrow("It's being reopened already");
    expect(await m.resume(s.id)).toEqual({ refused: "It's being reopened already" });
    expect(() => m.kill(s.id, true)).toThrow(/being reopened already: forget it once it has opened/);
    expect(store.state.sessions.some((x: any) => x.id === s.id)).toBe(true);
    release(null);
    await first;
    expect(ptys.length).toBe(started + 1);
    expect(ptys.at(-1)!.killed).toBe(false);
    // once it has opened, forgetting it is the user's to do
    m.kill(s.id, true);
    expect(store.state.sessions.some((x: any) => x.id === s.id)).toBe(false);
  });

  it("refuse relaunching a session that's running, which would kill its agent to take its id", async () => {
    const { m } = await manager();
    const s = await m.create(agentPane);
    const p = ptys.at(-1)!;
    await expect(m.relaunch(s.id)).rejects.toThrow("It's running already");
    expect(p.killed).toBe(false);
    // a dead pane can still be relaunched in place
    p.exit(1);
    await m.relaunch(s.id);
    expect(ptys.at(-1)).not.toBe(p);
  });

  it("refuse forgetting a pane while it's being resumed", async () => {
    const { m, store } = await manager();
    const s = await m.create(agentPane);
    m.statusFromHook({ paneId: s.id, conversationId: "resume-conv", agent: "claude", status: "idle" });
    transcript("resume-conv");
    ptys.at(-1)!.exit(0);
    let release!: (notice: string | null) => void;
    m.freeConversation = () => new Promise((r) => (release = r));
    const resumed = m.resume(s.id);
    await Promise.resolve();
    expect(() => m.kill(s.id, true)).toThrow(/being resumed already: forget it once it has opened/);
    release(null);
    expect(await resumed).toMatchObject({ id: s.id });
    expect(store.state.sessions.some((x: any) => x.id === s.id)).toBe(true);
  });
});

describe("resuming an exited pane", () => {
  it("lets its dead pty go and relaunches it under its id; refused, with nothing undone, for one a teammate continues or whose record is gone", async () => {
    const { m, store } = await manager();
    const s = await m.create(agentPane);
    m.stop(s.id);
    let refusal: string | null = "“a” continues on Nick's laptop — take it back rather than running this copy again";
    m.relaunchGuard = () => refusal;
    const started = ptys.length;
    expect(await m.resume(s.id)).toEqual({ refused: refusal });
    // the pane is as it was: dead, still listed, its pty never started again
    expect(m.list().find((x) => x.id === s.id)?.status).toBe("dead");
    expect(ptys.length).toBe(started);
    refusal = null;
    const back = await m.resume(s.id);
    expect(back).toMatchObject({ id: s.id });
    expect(m.list().find((x) => x.id === s.id)?.status).not.toBe("dead");
    expect(ptys.length).toBe(started + 1);
    // a dead pane whose record went: said, nothing killed
    m.stop(s.id);
    store.state.sessions.splice(0);
    expect(await m.resume(s.id)).toEqual({ refused: expect.stringMatching(/record is gone/) });
    expect(m.list().find((x) => x.id === s.id)?.status).toBe("dead");
  });
});

describe("resuming twice, or a pane that isn't dead", () => {
  it("refuses a second Resume while the first is under way, and one of a pane that's running, saying why; only one agent starts", async () => {
    const { m } = await manager();
    const s = await m.create(agentPane);
    expect(await m.resume(s.id)).toEqual({ refused: "It's running already" });
    m.stop(s.id);
    const started = ptys.length;
    const first = m.resume(s.id);
    expect(await m.resume(s.id)).toEqual({ refused: "It's being resumed already" });
    expect(await first).toMatchObject({ id: s.id });
    expect(ptys.length).toBe(started + 1);
    // and once it has relaunched, it's running: refused again rather than killed
    expect(await m.resume(s.id)).toEqual({ refused: "It's running already" });
    expect(ptys.length).toBe(started + 1);
  });

  it("checks and lets the dead pty go with nothing waited on from its first check to the kill", async () => {
    const { m } = await manager();
    const s = await m.create(agentPane);
    m.stop(s.id);
    // queued before Resume is asked, this runs at the first thing it waits on
    let waited = false;
    queueMicrotask(() => (waited = true));
    const kill = m.kill.bind(m);
    let waitedAtKill: boolean | null = null;
    m.kill = (id: string, forget?: boolean) => {
      waitedAtKill = waited;
      return kill(id, forget);
    };
    const resumed = m.resume(s.id);
    // let go before resume() first waits, so before it even returns
    expect(waitedAtKill).toBe(false);
    expect(await resumed).toMatchObject({ id: s.id });
  });

  it("keeps a pane being resumed among this Mac's sessions, and refuses to relaunch or restart it meanwhile; only one agent starts", async () => {
    const { m } = await manager();
    const s = await m.create(agentPane);
    m.stop(s.id);
    const started = ptys.length;
    const first = m.resume(s.id);
    // its dead pty is let go and its record kept while it relaunches: no longer a pane, but still a session here
    // (main reads list() and resumable() as every session this Mac has), which a reopen can't start twice
    expect(m.list().map((x) => x.id)).not.toContain(s.id);
    expect(m.resumable().map((x) => x.id)).toContain(s.id);
    const reopened = m.relaunch(s.id);
    const restarted = m.restart(s.id);
    await expect(reopened).rejects.toThrow("It's being resumed already");
    await expect(restarted).rejects.toThrow("It's being resumed already");
    expect(await first).toMatchObject({ id: s.id });
    expect(ptys.length).toBe(started + 1);
    m.stop(s.id);
    // once it's done, the pane is its own again
    expect(await m.resume(s.id)).toMatchObject({ id: s.id });
    expect(ptys.length).toBe(started + 2);
  });
});

describe("a session a teammate continues", () => {
  it("isn't started by a relaunch that was already under way when the take-over arrived", async () => {
    const { m } = await manager();
    const s = await m.create(agentPane);
    m.kill(s.id, false);
    let refusal: string | null = null;
    m.relaunchGuard = () => refusal;
    // the take-over is heard while the relaunch prepares its launch; stopping the session finds nothing running yet
    m.roomLaunch = async () => {
      refusal = "“a” continues on Nick's laptop";
      expect(m.stop(s.id)).toBe(false);
      return null;
    };
    const started = ptys.length;
    await expect(m.relaunch(s.id)).rejects.toThrow(/continues on Nick's laptop/);
    expect(ptys.length).toBe(started);
    expect(m.list().some((x) => x.id === s.id && x.status !== "dead")).toBe(false);
    expect(m.resumable().map((x) => x.id)).toContain(s.id);
  });
});
