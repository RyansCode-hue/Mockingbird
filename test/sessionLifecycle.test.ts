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

  it("aren't asked about a pane with no conversation to resume by id", async () => {
    const { m } = await manager();
    const s = await m.create(agentPane);
    m.kill(s.id, false);
    const ask = vi.fn(async () => null);
    m.freeConversation = ask;
    await m.relaunch(s.id);
    expect(ask).not.toHaveBeenCalled();
  });
});
