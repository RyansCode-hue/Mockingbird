import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers";

/** Every pty the manager starts: what it was asked to run, what was written to it, and a way to end it. */
type FakePty = { args: string[]; writes: string[]; killed: boolean; emit(d: string): void; exit(code: number): void };
const ptys: FakePty[] = [];
vi.mock("node-pty", () => ({
  spawn: (_file: string, args: string[]) => {
    let onData: (d: string) => void = () => {};
    let onExit: (e: { exitCode: number }) => void = () => {};
    const p: FakePty = { args, writes: [], killed: false, emit: (d) => onData(d), exit: (exitCode) => onExit({ exitCode }) };
    ptys.push(p);
    return {
      onData: (cb: any) => ((onData = cb), { dispose() {} }),
      onExit: (cb: any) => ((onExit = cb), { dispose() {} }),
      write: (d: string) => p.writes.push(d.replace(/\x1b\[20[01]~/g, "|")),
      resize() {},
      kill: () => (p.killed = true),
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
