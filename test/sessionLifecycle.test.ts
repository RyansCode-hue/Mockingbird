import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git, makeRepo, tempDir } from "./helpers";
import { legacyWorktreeRoot, worktreeRoot } from "../src/main/worktrees";

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

describe("a queued message's receipt", () => {
  /** A receipt that writes down what it hears, and the pane's writes as it heard each. */
  function receipt(p: () => FakePty, opts: { paste?: boolean } = {}) {
    const heard: string[] = [];
    return {
      heard,
      pasting: () => {
        heard.push(`pasting (${p().writes.length} written)`);
        return opts.paste ?? true;
      },
      settled: (outcome: string, why?: string) => void heard.push(why ? `${outcome}: ${why}` : outcome),
    };
  }

  it("is asked just before the paste, then told sent once its Enter has gone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { m } = await manager();
    const s = await m.create({ ...agentPane, title: "Reviewer" });
    m.statusFromHook({ paneId: s.id, status: "idle" });
    const r = receipt(() => ptys.at(-1)!);
    expect(m.deliverAgentMessage(s.id, "the summary", true, undefined, r)).toBe("delivered");
    expect(r.heard).toEqual(["pasting (0 written)"]);
    vi.advanceTimersByTime(150);
    expect(ptys.at(-1)!.writes).toEqual(["|the summary|", "\r"]);
    expect(r.heard).toEqual(["pasting (0 written)", "sent"]);
  });

  it("reads the hook events written by its Enter: a permission prompt they report keeps it in the prompt, placed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { m } = await manager();
    const s = await m.create({ ...agentPane, title: "Reviewer" });
    m.statusFromHook({ paneId: s.id, status: "idle" });
    // its permission event was written after the paste, and the poll hasn't read it yet
    let caughtUp = 0;
    m.hooksCatchUp = () => {
      caughtUp++;
      m.statusFromHook({ paneId: s.id, status: "waiting", reason: "Claude needs your permission to use Bash" });
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = receipt(() => ptys.at(-1)!);
    m.deliverAgentMessage(s.id, "the summary", true, undefined, r);
    expect(caughtUp).toBe(0);
    vi.advanceTimersByTime(150);
    expect(caughtUp).toBe(1);
    expect(ptys.at(-1)!.writes).toEqual(["|the summary|"]);
    expect(r.heard.at(-1)).toMatch(/^placed: “Reviewer” started asking for permission as this was pasted/);
  });

  it("is taken back out of its queue unpasted on request, saying whether it was there; the queue says whether it holds it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { m } = await manager();
    const s = await m.create({ ...agentPane, title: "Reviewer" });
    m.statusFromHook({ paneId: s.id, status: "working" });
    const r = receipt(() => ptys.at(-1)!);
    const other = receipt(() => ptys.at(-1)!);
    m.deliverAgentMessage(s.id, "taken back", true, undefined, r);
    m.deliverAgentMessage(s.id, "left", true, undefined, other);
    expect([m.holds(s.id, r), m.holds(s.id, other)]).toEqual([true, true]);
    expect(m.withdraw(s.id, r)).toBe(true);
    expect(m.withdraw(s.id, r)).toBe(false);
    expect([m.holds(s.id, r), m.holds(s.id, other), m.holds("nope", other)]).toEqual([false, true, false]);
    m.statusFromHook({ paneId: s.id, status: "idle" });
    vi.advanceTimersByTime(150);
    expect(ptys.at(-1)!.writes).toEqual(["|left|", "\r"]);
    expect(r.heard).toEqual([]);
  });

  it("is told placed when the user's unsent text there is given up on, with no Enter", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { m } = await manager();
    const s = await m.create({ ...agentPane, title: "Reviewer" });
    m.statusFromHook({ paneId: s.id, status: "idle" });
    m.write(s.id, "half typed");
    const r = receipt(() => ptys.at(-1)!);
    m.deliverAgentMessage(s.id, "the summary", true, undefined, r);
    vi.advanceTimersByTime(119_000);
    expect(r.heard).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(r.heard).toEqual(["pasting (1 written)", "placed: You had unsent text in “Reviewer”'s prompt, so this was put after it, unsent: press Enter there to send both"]);
    expect(ptys.at(-1)!.writes).toEqual(["half typed", "|the summary|"]);
  });

  it("is told placed when a permission prompt comes up before its Enter, which would answer it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { m } = await manager();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await m.create({ ...agentPane, title: "Reviewer" });
    m.statusFromHook({ paneId: s.id, status: "idle" });
    const r = receipt(() => ptys.at(-1)!);
    m.deliverAgentMessage(s.id, "the summary", true, undefined, r);
    m.statusFromHook({ paneId: s.id, status: "waiting", reason: "Claude needs your permission to use Bash" });
    vi.advanceTimersByTime(150);
    expect(ptys.at(-1)!.writes).toEqual(["|the summary|"]);
    expect(r.heard[1]).toMatch(/^placed: “Reviewer” started asking for permission as this was pasted/);
  });

  it("is told failed when its agent exits with it queued, when its pane is closed (kept for no relaunch) or forgotten, and when its pane closes before its Enter", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { m } = await manager();
    const s = await m.create({ ...agentPane, title: "Reviewer" }); // working: messages wait
    const exited = receipt(() => ptys.at(-1)!);
    m.deliverAgentMessage(s.id, "one", true, undefined, exited);
    m.broadcast("status?", [s.id], true); // a message with no receipt is kept for its relaunch, as before
    ptys.at(-1)!.exit(1);
    expect(exited.heard).toEqual(["failed: “Reviewer” stopped running before this reached it"]);
    expect(() => m.deliverAgentMessage(s.id, "to a dead pane", true, undefined, receipt(() => ptys.at(-1)!))).toThrow(/has exited/);
    expect(m.deliverAgentMessage(s.id, "to a dead pane, no receipt", true)).toMatch(/^queued: it has exited/);
    await m.relaunch(s.id);
    const closed = receipt(() => ptys.at(-1)!);
    m.deliverAgentMessage(s.id, "two", true, undefined, closed);
    m.kill(s.id, false);
    expect(closed.heard).toEqual(["failed: “Reviewer” was closed before this reached it"]);
    await m.relaunch(s.id);
    m.statusFromHook({ paneId: s.id, status: "idle" });
    vi.advanceTimersByTime(200);
    // what had no receipt still arrives, after its relaunch; what had one doesn't
    expect(ptys.at(-1)!.writes).toEqual(["|status?|", "\r"]);
    m.statusFromHook({ paneId: s.id, status: "idle" });
    vi.advanceTimersByTime(200);
    expect(ptys.at(-1)!.writes.slice(2)).toEqual(["|to a dead pane, no receipt|", "\r"]);
    m.statusFromHook({ paneId: s.id, status: "idle" });
    const cut = receipt(() => ptys.at(-1)!);
    m.deliverAgentMessage(s.id, "three", true, undefined, cut);
    m.kill(s.id, false);
    vi.advanceTimersByTime(150);
    expect(cut.heard).toEqual(["pasting (4 written)", "failed: “Reviewer” stopped after this was pasted and before its Enter, so it wasn't submitted"]);
    const forgotten = await m.create({ ...agentPane, title: "Forgotten" });
    const gone = receipt(() => ptys.at(-1)!);
    m.deliverAgentMessage(forgotten.id, "four", true, undefined, gone);
    m.kill(forgotten.id, true);
    expect(gone.heard).toEqual(["failed: “Forgotten” was closed before this reached it"]);
    // a launch that takes over a running pane's id doesn't inherit what that pane was given with a receipt
    const replaced = await m.create({ ...agentPane, title: "Replaced" });
    const taken = receipt(() => ptys.at(-1)!);
    m.deliverAgentMessage(replaced.id, "five", true, undefined, taken);
    await m.create({ ...agentPane, title: "Replaced", reuseId: replaced.id });
    expect(taken.heard).toEqual(["failed: “Replaced” was started again before this reached it"]);
    m.statusFromHook({ paneId: replaced.id, status: "idle" });
    vi.advanceTimersByTime(200);
    expect(ptys.at(-1)!.writes).toEqual([]);
  });

  it("keeps its message out of the pane when it says not to paste, and the turn goes to the next one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { m } = await manager();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await m.create({ ...agentPane, title: "Reviewer" });
    const refused = receipt(() => ptys.at(-1)!, { paste: false });
    const throwing = { pasting: () => { throw new Error("broken"); }, settled: () => {} };
    m.deliverAgentMessage(s.id, "kept out", true, undefined, refused);
    m.deliverAgentMessage(s.id, "kept out too", true, undefined, throwing);
    m.deliverAgentMessage(s.id, "goes", true);
    m.statusFromHook({ paneId: s.id, status: "idle" });
    vi.advanceTimersByTime(150);
    expect(ptys.at(-1)!.writes).toEqual(["|goes|", "\r"]);
    expect(refused.heard).toEqual(["pasting (0 written)"]);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("receipt failed as it was to be pasted"))).toBe(true);
    expect(m.list().find((x) => x.id === s.id)!.queuedCount).toBe(0);
  });

  it("counts the prompts its agent takes this launch, from nothing again after a relaunch", async () => {
    const { m } = await manager();
    const s = await m.create({ ...agentPane, title: "Builder" });
    const first = m.promptCount(s.id)!;
    expect(first.seq).toBe(0);
    m.statusFromHook({ paneId: s.id, status: "working", prompted: true });
    m.statusFromHook({ paneId: s.id, status: "working" }); // a tool use is no prompt
    expect(m.promptCount(s.id)).toEqual({ epoch: first.epoch, seq: 1 });
    await m.restart(s.id);
    expect(m.promptCount(s.id)!.seq).toBe(0);
    expect(m.promptCount(s.id)!.epoch).not.toBe(first.epoch);
    ptys.at(-1)!.exit(0);
    expect(m.promptCount(s.id)).toBeNull();
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

  /** A session in a worktree with conversation `conv`, whose worktree and branch have gone: it has nowhere to run. */
  async function nowhereToRun(m: Awaited<ReturnType<typeof manager>>["m"], conv: string) {
    transcript(conv);
    const repo = makeRepo();
    const s = await m.create({ repoPath: repo, useWorktree: true, branchName: "feat", agent: "claude", title: "w" });
    m.statusFromHook({ paneId: s.id, conversationId: conv, agent: "claude", status: "idle" });
    git(repo, "worktree", "remove", "--force", s.cwd);
    git(repo, "branch", "-q", "-D", "feat");
    return s;
  }

  it("aren't let go by a relaunch with nowhere to run: nothing running elsewhere is stopped for it", async () => {
    const { m } = await manager();
    const s = await nowhereToRun(m, "bg-conv");
    m.kill(s.id, false);
    const asked: unknown[] = [];
    m.freeConversation = async (c) => (asked.push(c), "stopped it");
    await expect(m.relaunch(s.id)).rejects.toThrow(/isn't here or on origin/);
    expect(asked).toEqual([]);
  });

  it("aren't let go by a resume with nowhere to run: refused, saying why, the pane left to close", async () => {
    const { m } = await manager();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await nowhereToRun(m, "bg-conv");
    ptys.at(-1)!.exit(1);
    const asked: unknown[] = [];
    m.freeConversation = async (c) => (asked.push(c), "stopped it");
    expect(await m.resume(s.id)).toEqual({ refused: expect.stringMatching(/isn't here or on origin/) });
    expect(asked).toEqual([]);
    expect(m.list().find((x) => x.id === s.id)?.status).toBe("dead");
    warn.mockRestore();
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

describe("what an agent is told of its wires as it launches", () => {
  const room = { env: {}, denyReads: [], codexPermissions: [], instructions: "ROOM RULES", allowTools: [], inline: false, guards: { secrets: false, coauthors: false } };
  it("goes in each CLI's instructions, after a room's, at launch and at every relaunch", async () => {
    const { m } = await manager();
    const asked: string[] = [];
    m.launchInstructions = (id) => (asked.push(id), `WIRES OF ${id}`);
    const s = await m.create(agentPane);
    expect(ptys.at(-1)!.args.join(" ")).toContain(`'--append-system-prompt' 'WIRES OF ${s.id}'`);
    m.kill(s.id, false);
    m.roomLaunch = async () => room;
    await m.relaunch(s.id);
    expect(ptys.at(-1)!.args.join(" ")).toContain(`'--append-system-prompt' 'ROOM RULES\n\nWIRES OF ${s.id}'`);
    m.roomLaunch = null;
    const codex = await m.create({ ...agentPane, agent: "codex" });
    expect(ptys.at(-1)!.args.join(" ")).toContain(`'developer_instructions="WIRES OF ${codex.id}"'`);
    expect(asked).toEqual([s.id, s.id, codex.id]);
  });
  it("isn't asked for a terminal or a debrief", async () => {
    const { m } = await manager();
    const asked: string[] = [];
    m.launchInstructions = (id) => (asked.push(id), "WIRES");
    await m.create({ repoPath: null, useWorktree: false, shell: true, title: "t" });
    await m.create({ ...agentPane, debrief: true });
    expect(asked).toEqual([]);
    expect(ptys.at(-1)!.args.join(" ")).not.toContain("WIRES");
  });
  it("costs the launch nothing when it fails, and is logged", async () => {
    const { m } = await manager();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    m.launchInstructions = () => {
      throw new Error("the book went away");
    };
    m.roomLaunch = async () => room;
    const s = await m.create(agentPane);
    expect(s.id).toBeTruthy();
    expect(ptys.at(-1)!.args.join(" ")).toContain(`'--append-system-prompt' 'ROOM RULES'`);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/starts without its wires' instructions/), expect.objectContaining({ message: "the book went away" }));
  });
});

describe("relaunching a session in the checkout itself", () => {
  const branches = (repo: string) => git(repo, "branch", "--format=%(refname:short)").split("\n").sort();
  async function closedInCheckout(over: Record<string, unknown> = {}) {
    const { m } = await manager();
    const repo = makeRepo();
    const s = await m.create({ repoPath: repo, ticketId: "123", ticketTitle: "Fix thing", useWorktree: false, agent: "claude", title: "t", ...over });
    m.kill(s.id, false);
    return { m, repo, s };
  }

  it("never makes its ticket's branch again once it's deleted: it runs on what's out", async () => {
    const { m, repo, s } = await closedInCheckout();
    expect(s.branch).toMatch(/^123-/);
    git(repo, "switch", "-q", "main");
    git(repo, "branch", "-q", "-D", s.branch!);
    const again = await m.relaunch(s.id);
    expect(again).toMatchObject({ cwd: repo, branch: "main" });
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(branches(repo)).toEqual(["main"]);
  });

  it("never switches a checkout that's since moved to other work", async () => {
    const { m, repo, s } = await closedInCheckout();
    git(repo, "switch", "-q", "main");
    git(repo, "switch", "-q", "-c", "users-own-work");
    const before = branches(repo);
    const again = await m.relaunch(s.id);
    expect(again).toMatchObject({ cwd: repo, branch: "users-own-work" });
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("users-own-work");
    expect(branches(repo)).toEqual(before);
  });

  it("with a branch name of its own and a ticket, makes neither branch nor the ticket's, and switches to neither", async () => {
    const { m, repo, s } = await closedInCheckout({ branchName: "mine" });
    expect(s.branch).toBe("mine");
    // still on its own branch: it stays there, the ticket's never made
    const stay = await m.relaunch(s.id);
    expect(stay).toMatchObject({ cwd: repo, branch: "mine" });
    expect(branches(repo)).toEqual(["main", "mine"]);
    m.kill(s.id, false);
    // moved off and its branch deleted: neither comes back
    git(repo, "switch", "-q", "main");
    git(repo, "branch", "-q", "-D", "mine");
    const moved = await m.relaunch(s.id);
    expect(moved).toMatchObject({ cwd: repo, branch: "main" });
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(branches(repo)).toEqual(["main"]);
  });

  it("refuses once the checkout is gone", async () => {
    const { m, repo, s } = await closedInCheckout();
    fs.rmSync(repo, { recursive: true, force: true });
    await expect(m.relaunch(s.id)).rejects.toThrow(/doesn't exist any more/);
  });
});

describe("relaunching a session whose worktree is gone, its branch's usual folder on another branch", () => {
  /** A closed session in `<root>/feat-2` on feat, with `<root>/feat` on other holding the user's own files; a take-over's folder is named so. */
  async function suffixed() {
    const { m } = await manager();
    const repo = makeRepo();
    const root = worktreeRoot(repo);
    git(repo, "branch", "feat");
    const usual = path.join(root, "feat");
    git(repo, "worktree", "add", "-q", "-b", "other", usual);
    const theirs = path.join(usual, "theirs.txt");
    fs.writeFileSync(theirs, "uncommitted");
    const own = path.join(root, "feat-2");
    git(repo, "worktree", "add", "-q", own, "feat");
    const s = await m.create({ repoPath: repo, cwd: own, branchName: "feat", useWorktree: false, agent: "claude", title: "t" });
    m.kill(s.id, false);
    return { m, repo, s, usual, own, theirs };
  }
  const assertBackInItsOwn = (x: { usual: string; own: string; theirs: string }, again: { cwd: string; branch: string | null } | null) => {
    expect(again).toMatchObject({ cwd: x.own, branch: "feat" });
    expect(git(x.own, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat");
    expect(git(x.usual, "rev-parse", "--abbrev-ref", "HEAD")).toBe("other");
    expect(fs.existsSync(x.theirs)).toBe(true);
  };

  it("makes it again in its own folder, never running in the other", async () => {
    const x = await suffixed();
    git(x.repo, "worktree", "remove", x.own);
    assertBackInItsOwn(x, await x.m.relaunch(x.s.id));
  });

  it("makes it again when its folder was deleted outside git, clearing its own registration", async () => {
    const x = await suffixed();
    fs.rmSync(x.own, { recursive: true, force: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    assertBackInItsOwn(x, await x.m.relaunch(x.s.id));
    warn.mockRestore();
  });

  it("makes it again with a plain folder at the usual place, or an old-layout one on another branch", async () => {
    const { m } = await manager();
    const repo = makeRepo();
    const root = worktreeRoot(repo);
    git(repo, "branch", "feat");
    fs.mkdirSync(path.join(root, "feat"), { recursive: true });
    const legacy = path.join(legacyWorktreeRoot(repo), "feat");
    git(repo, "worktree", "add", "-q", "-b", "other", legacy);
    const own = path.join(root, "feat-2");
    git(repo, "worktree", "add", "-q", own, "feat");
    const s = await m.create({ repoPath: repo, cwd: own, branchName: "feat", useWorktree: false, agent: "claude", title: "t" });
    m.kill(s.id, false);
    git(repo, "worktree", "remove", own);
    expect(await m.relaunch(s.id)).toMatchObject({ cwd: own, branch: "feat" });
    expect(git(own, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat");
  });

  it("is refused, with nothing let go, when its branch has gone too", async () => {
    const x = await suffixed();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    git(x.repo, "worktree", "remove", x.own);
    git(x.repo, "branch", "-q", "-D", "feat");
    const asked: unknown[] = [];
    x.m.freeConversation = async (c: unknown) => (asked.push(c), null);
    await expect(x.m.relaunch(x.s.id)).rejects.toThrow("Its branch, feat, isn't here or on origin any more: start fresh");
    expect(asked).toEqual([]);
    log.mockRestore();
  });
});

describe("relaunching on what's out in its folder", () => {
  it("a repo-less session runs in its own folder, not in home", async () => {
    const { m } = await manager();
    const own = tempDir("own");
    const s = await m.create({ repoPath: null, cwd: own, useWorktree: false, agent: "claude", title: "t" });
    m.kill(s.id, false);
    expect((await m.relaunch(s.id))?.cwd).toBe(own);
  });

  it("a worktree switched by hand says what it's on now, in its record and its pane", async () => {
    const { m } = await manager();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const repo = makeRepo();
    const s = await m.create({ repoPath: repo, useWorktree: true, branchName: "feat", agent: "claude", title: "t" });
    m.kill(s.id, false);
    git(s.cwd, "switch", "-q", "-c", "by-hand");
    expect(await m.relaunch(s.id)).toMatchObject({ cwd: s.cwd, branch: "by-hand" });
    expect(m.buffer(s.id)).toContain("This session was on feat. Its folder is on by-hand now.");
    warn.mockRestore();
  });

  it("a checkout session back on another branch says so in its pane, and nothing when it's the same", async () => {
    const { m } = await manager();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const repo = makeRepo();
    const s = await m.create({ repoPath: repo, branchName: "mine", useWorktree: false, agent: "claude", title: "t" });
    m.kill(s.id, false);
    await m.relaunch(s.id);
    expect(m.buffer(s.id)).not.toContain("This session was on");
    m.kill(s.id, false);
    git(repo, "switch", "-q", "main");
    await m.relaunch(s.id);
    expect(m.buffer(s.id)).toContain("This session was on mine. Its folder is on main now.");
    warn.mockRestore();
  });

  it("a detached one says that, with no branch to its name", async () => {
    const { m } = await manager();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const repo = makeRepo();
    const s = await m.create({ repoPath: repo, useWorktree: true, branchName: "feat", agent: "claude", title: "t" });
    m.kill(s.id, false);
    git(s.cwd, "switch", "-q", "--detach");
    expect(await m.relaunch(s.id)).toMatchObject({ cwd: s.cwd, branch: null });
    expect(m.buffer(s.id)).toContain("This session was on feat. Its folder is on a detached HEAD now.");
    warn.mockRestore();
  });
});

describe("a new ticket session in a checkout with a session running there", () => {
  const ticket = { ticketId: "9", ticketTitle: "New work", useWorktree: false, agent: "claude" as const, title: "n" };

  it("is refused when that one has no branch of its own: switching would move it all the same", async () => {
    const { m } = await manager();
    const repo = makeRepo();
    await m.create({ repoPath: repo, useWorktree: false, agent: "claude", title: "plain" });
    await expect(m.create({ repoPath: repo, ...ticket })).rejects.toThrow(/already checked out on main by a running session/);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("goes ahead when nothing would move: what it wants is what's out", async () => {
    const { m } = await manager();
    const repo = makeRepo();
    await m.create({ repoPath: repo, useWorktree: false, agent: "claude", title: "plain" });
    const s = await m.create({ repoPath: repo, branchName: "main", useWorktree: false, agent: "claude", title: "n" });
    expect(s.branch).toBe("main");
  });

  it("goes ahead once that one has exited", async () => {
    const { m } = await manager();
    const repo = makeRepo();
    const plain = await m.create({ repoPath: repo, useWorktree: false, agent: "claude", title: "plain" });
    m.kill(plain.id, false);
    const s = await m.create({ repoPath: repo, ...ticket });
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe(s.branch);
  });
});

describe("relaunching a session in a worktree whose folder isn't called after its branch (a take-over's)", () => {
  it("runs in that folder while it's there", async () => {
    const { m } = await manager();
    const repo = makeRepo();
    git(repo, "branch", "feat");
    const root = worktreeRoot(repo);
    const folder = path.join(root, "feat-2");
    git(repo, "worktree", "add", "-q", folder, "feat");
    const s = await m.create({ repoPath: repo, cwd: folder, branchName: "feat", useWorktree: false, agent: "claude", title: "t" });
    m.kill(s.id, false);
    expect(await m.relaunch(s.id)).toMatchObject({ cwd: folder, branch: "feat" });
    expect(fs.existsSync(path.join(root, "feat"))).toBe(false);
  });
});

describe("relaunching a worktree session whose worktree was removed", () => {
  /** A clone of an origin, with a worktree session on `feat`, a commit of its own pushed and fetched, then its worktree removed and its local branch deleted. */
  async function removedWorktree() {
    const { m, store } = await manager();
    const origin = makeRepo({ "a.txt": "1" }, "origin");
    const clone = path.join(path.dirname(origin), "clone");
    git(path.dirname(origin), "clone", "-q", origin, clone);
    const s = await m.create({ repoPath: clone, useWorktree: true, branchName: "feat", agent: "claude", title: "w" });
    git(s.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "its work");
    const work = git(s.cwd, "rev-parse", "HEAD");
    git(s.cwd, "push", "-q", "origin", "feat");
    m.kill(s.id, false);
    git(clone, "worktree", "remove", s.cwd);
    git(clone, "branch", "-q", "-D", "feat");
    return { m, store, s, origin, clone, work };
  }

  it("makes it again from what origin last had of its branch, once origin has deleted it", async () => {
    const { m, s, origin, work } = await removedWorktree();
    git(origin, "branch", "-q", "-D", "feat");
    const again = await m.relaunch(s.id);
    expect(again?.cwd).toBe(s.cwd);
    expect(git(s.cwd, "rev-parse", "HEAD")).toBe(work);
    expect(git(s.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat");
  });

  it("says in the pane when origin couldn't be reached, for a relaunch from what was last fetched and a new worktree off the local base", async () => {
    const { m, s, clone, work } = await removedWorktree();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    git(clone, "remote", "set-url", "origin", path.join(tempDir("gone"), "origin"));
    await m.relaunch(s.id);
    expect(git(s.cwd, "rev-parse", "HEAD")).toBe(work);
    expect(m.buffer(s.id)).toMatch(/Origin couldn't be asked whether it has feat, so this went by what was last fetched: git ls-remote: .*does not appear to be a git repository/);
    const fresh = await m.create({ repoPath: clone, useWorktree: true, branchName: "fresh", baseBranch: "main", agent: "claude", title: "f" });
    const shown = m.buffer(fresh.id);
    expect(shown).toContain("Origin couldn't be asked whether it has fresh");
    expect(shown).toMatch(/origin\/main couldn't be fetched, so fresh was branched off the local main, which may be behind origin's: git fetch: /);
  });

  it("refuses, starting nothing and keeping the session, when its branch is gone from here and origin alike", async () => {
    const { m, store, s, origin, clone } = await removedWorktree();
    git(origin, "branch", "-q", "-D", "feat");
    git(clone, "fetch", "-q", "--prune", "origin");
    const started = ptys.length;
    await expect(m.relaunch(s.id)).rejects.toThrow("Its branch, feat, isn't here or on origin any more: start fresh");
    expect(ptys.length).toBe(started);
    expect(git(clone, "branch", "--list", "feat")).toBe("");
    expect(store.state.sessions.some((x: any) => x.id === s.id)).toBe(true);
  });

  it("makes it again when its folder was deleted outside git, still registered, its branch kept", async () => {
    const { m } = await manager();
    const repo = makeRepo();
    const s = await m.create({ repoPath: repo, useWorktree: true, branchName: "kept", agent: "claude", title: "k" });
    m.kill(s.id, false);
    fs.rmSync(s.cwd, { recursive: true, force: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await m.relaunch(s.id))?.cwd).toBe(s.cwd);
    expect(git(s.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("kept");
    expect(warn.mock.calls.some((c) => /deleted outside git but still registered/.test(String(c[0])))).toBe(true);
    warn.mockRestore();
  });

  it("runs a detached worktree's session in its own folder, never the main checkout", async () => {
    const { m } = await manager();
    const repo = makeRepo();
    const detached = path.join(path.dirname(repo), "detached");
    git(repo, "worktree", "add", "-q", "--detach", detached);
    const s = await m.create({ repoPath: repo, cwd: detached, useWorktree: false, agent: "claude", title: "d" });
    expect(s.branch).toBeNull();
    m.kill(s.id, false);
    expect((await m.relaunch(s.id))?.cwd).toBe(detached);
    // and refuses once that folder is gone, rather than running in the repo
    m.kill(s.id, false);
    git(repo, "worktree", "remove", "--force", detached);
    await expect(m.relaunch(s.id)).rejects.toThrow(/doesn't exist any more/);
  });
});
