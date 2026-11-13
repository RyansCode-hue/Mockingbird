import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git, makeRepo, tempDir } from "./helpers";
import { legacyWorktreeRoot, worktreeRoot } from "../src/main/worktrees";
import { FOLDER_NOTICE_SETTLE_MS, FOLDER_NOTICE_WAIT_MS } from "../src/main/codexFolderNotice";
import capture from "./fixtures/codex-folder-notice-0.156.1.json";
import { quote } from "../src/main/shell";
import { HELPDESK_RULES } from "../src/main/helpdesk";
import { HELPDESK_STARTING, helpdeskOpenAlready, type PlanRequest, type SessionInfo } from "../src/shared/types";
import { LandscapeStore } from "../src/main/landscape";
import { WireService } from "../src/main/wires";
import { ROOM_LINE } from "../src/shared/wires";

/** Every pty the manager starts: what it was asked to run and with what environment, what was written to it, and a way to end it. */
type FakePty = { args: string[]; env: Record<string, string>; writes: string[]; killed: boolean; signals: string[]; emit(d: string): void; exit(code: number): void };
const ptys: FakePty[] = [];
/** `next`: the next spawn fails, as posix_spawnp can. */
const spawnFails = vi.hoisted(() => ({ next: false }));
vi.mock("node-pty", () => ({
  spawn: (_file: string, args: string[], opts: { env: Record<string, string> }) => {
    if (spawnFails.next) {
      spawnFails.next = false;
      throw new Error("posix_spawnp failed.");
    }
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
  // a room launch's file isn't run for its version here (binPins.test.ts runs real files)
  m.readVersionAt = async () => null;
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

  it("is told failed, and no Enter goes, when Mockingbird quits between its paste and its Enter", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { m } = await manager();
    const s = await m.create({ ...agentPane, title: "Reviewer" });
    m.statusFromHook({ paneId: s.id, status: "idle" });
    const r = receipt(() => ptys.at(-1)!);
    m.deliverAgentMessage(s.id, "the summary", true, undefined, r);
    const quit = m.shutdown(1000);
    const pty = ptys.at(-1)!;
    expect(pty.signals).toEqual(["SIGHUP"]);
    pty.exit(129);
    vi.advanceTimersByTime(150);
    await quit;
    expect(pty.writes).toEqual(["|the summary|"]);
    expect(r.heard).toEqual(["pasting (0 written)", "failed: Mockingbird quit after this was pasted into “Reviewer” and before its Enter, so it wasn't submitted"]);
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
    const promptAt = () => m.list().find((x) => x.id === s.id)!.promptAt;
    expect(promptAt()).toBeNull();
    const before = Date.now();
    m.statusFromHook({ paneId: s.id, status: "working", prompted: true });
    m.statusFromHook({ paneId: s.id, status: "working" }); // a tool use is no prompt
    expect(m.promptCount(s.id)).toEqual({ epoch: first.epoch, seq: 1 });
    // when it came, for a summary since it (the Finished item's Finish step…)
    expect(promptAt()).toBeGreaterThanOrEqual(before);
    await m.restart(s.id);
    expect(m.promptCount(s.id)!.seq).toBe(0);
    expect(promptAt()).toBeNull();
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
  const room = { env: {}, denyReads: [], codexPermissions: [], claudeSettings: null, sandboxMarker: null, agentEnv: {}, codexFolderNotice: false, instructions: "ROOM RULES", allowTools: [], inline: false, guards: { secrets: false, coauthors: false } };
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
  it("keeps the folders a room launch held to having no repository on the record, handing them to every relaunch", async () => {
    const { m } = await manager();
    const held: (string[] | undefined)[] = [];
    m.roomLaunch = async (t) => (held.push(t.noRepo), { ...room, noRepo: ["/held/notes"] });
    const s = await m.create(agentPane);
    const record = () => m.list().find((x) => x.id === s.id)!.noRepo;
    expect(record()).toEqual(["/held/notes"]);
    m.kill(s.id, false);
    // a launch that holds none adds nothing, and the record keeps what it had, in a room or out of one
    m.roomLaunch = async (t) => (held.push(t.noRepo), room);
    await m.relaunch(s.id);
    expect(record()).toEqual(["/held/notes"]);
    m.kill(s.id, false);
    m.roomLaunch = null;
    await m.relaunch(s.id);
    expect(record()).toEqual(["/held/notes"]);
    m.kill(s.id, false);
    m.roomLaunch = async (t) => (held.push(t.noRepo), room);
    await m.relaunch(s.id);
    expect(held).toEqual([undefined, ["/held/notes"], ["/held/notes"]]);
  });
  it("is given the launch's role and the ticket it's on, by its own or its group's, null for a Council's area", async () => {
    const { m } = await manager();
    const asked: [string | undefined, string | null | undefined][] = [];
    m.launchInstructions = (_id, role, ticket) => (asked.push([role, ticket]), null);
    await m.create({ ...agentPane, role: "orchestrator", taskGroup: "Council — CSV export" });
    await m.create({ ...agentPane, role: "orchestrator", ticketId: "#4182", taskGroup: "Donors" });
    await m.create({ ...agentPane, taskGroup: "5120/verify" });
    expect(asked).toEqual([
      ["orchestrator", null],
      ["orchestrator", "4182"],
      [undefined, "5120"],
    ]);
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

describe("a Codex room launch's folder notice", () => {
  const room = { env: {}, denyReads: [], codexPermissions: [], claudeSettings: null, sandboxMarker: null, agentEnv: {}, codexFolderNotice: true, instructions: null, allowTools: [], inline: true, guards: { secrets: true, coauthors: false } };
  const codexPane = { ...agentPane, agent: "codex" as const };
  /** Codex's own notice frame, the highlight moved to Quit. */
  const quitHighlighted = capture.fresh.beforeEnter.replace("› 1. Open restricted", "  1. Open restricted").replace("  2. Quit", "› 2. Quit");

  it("is answered with Enter alone, and nothing else is typed until Codex has opened: a wire, a broadcast sent now, Compact; a ticket's brief waits in Codex's own arguments", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { m } = await manager();
    m.roomLaunch = async () => room;
    const seen: string[] = [];
    m.folderNoticeSeen = (_info, what, why) => seen.push(why ? `${what}: ${why}` : what);
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await m.create({ ...codexPane, initialPrompt: "the brief" });
    const p = ptys.at(-1)!;
    // Codex holds an argument prompt behind its notice: Mockingbird types nothing for it
    expect(p.args.join(" ")).toMatch(/'--' 'the brief'$/);
    expect(m.deliverAgentMessage(s.id, "the wire", true)).toBe("queued until its Codex has opened its folder (its folder notice is still up)");
    p.emit(capture.fresh.beforeEnter);
    // the pane reads as idle (Codex draws its prompt mark under the notice): still nothing goes
    m.clearWaiting(s.id);
    expect(m.list().find((x) => x.id === s.id)?.status).toBe("idle");
    expect(m.broadcast("sent now", [s.id], false)).toEqual([{ id: s.id, outcome: "queued" }]);
    expect(m.compactRefusal(s.id)).toBeTruthy();
    expect(() => m.compact(s.id)).toThrow();
    vi.advanceTimersByTime(FOLDER_NOTICE_SETTLE_MS - 1);
    expect(p.writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(p.writes).toEqual(["\r"]);
    expect(seen).toEqual(["answered"]);
    expect(logged).toHaveBeenCalledWith(`[sessions] ${s.id}: answered its Codex's folder notice with “Open restricted” (Enter, press 1)`);
    vi.advanceTimersByTime(100);
    expect(p.writes).toEqual(["\r"]);
    // Codex opens: what waited goes, one prompt per turn
    p.emit(capture.fresh.afterEnter);
    vi.advanceTimersByTime(200);
    expect(p.writes).toEqual(["\r", "|the wire|", "\r"]);
    expect(m.list().find((x) => x.id === s.id)?.queuedCount).toBe(1);
    m.statusFromHook({ paneId: s.id, status: "idle" });
    vi.advanceTimersByTime(200);
    expect(p.writes).toEqual(["\r", "|the wire|", "\r", "|sent now|", "\r"]);
    expect(seen).toEqual(["answered"]);
  });

  it("isn't answered when it isn't exactly the notice: the user is told once, and what waits goes once Codex has opened", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { m } = await manager();
    m.roomLaunch = async () => room;
    const seen: string[] = [];
    m.folderNoticeSeen = (_info, what, why) => seen.push(why ? `${what}: ${why}` : what);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await m.create(codexPane);
    const p = ptys.at(-1)!;
    m.deliverAgentMessage(s.id, "the wire", true);
    m.deliverAgentMessage(s.id, "the next wire", true);
    p.emit(quitHighlighted);
    m.clearWaiting(s.id);
    vi.advanceTimersByTime(FOLDER_NOTICE_WAIT_MS * 2);
    expect(p.writes).toEqual([]);
    expect(seen).toEqual(["asking: its Codex is asking a folder question Mockingbird doesn't answer for it"]);
    // the user answers it in the pane; Codex's first hook says it's past it, and what waited goes one turn at a time
    m.write(s.id, "\r");
    m.statusFromHook({ paneId: s.id, status: "idle" });
    vi.advanceTimersByTime(200);
    expect(p.writes).toEqual(["\r", "|the wire|", "\r"]);
    m.statusFromHook({ paneId: s.id, status: "idle" });
    vi.advanceTimersByTime(200);
    expect(p.writes).toEqual(["\r", "|the wire|", "\r", "|the next wire|", "\r"]);
  });

  it("holds a teammate's typing until Codex has opened, then types it in order before what was queued; the owner's own keys go at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { m } = await manager();
    m.roomLaunch = async () => room;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await m.create(codexPane);
    const p = ptys.at(-1)!;
    m.deliverAgentMessage(s.id, "the wire", true);
    p.emit(capture.fresh.beforeEnter);
    expect(m.writeFromTeammate(s.id, "2")).toBe("held");
    expect(m.writeFromTeammate(s.id, "fix it")).toBe("held");
    expect(m.writeFromTeammate(s.id, "x".repeat(64 * 1024))).toBe("full");
    // the owner's key is the owner's: straight to the pty
    m.write(s.id, "\x1b[A");
    expect(p.writes).toEqual(["\x1b[A"]);
    vi.advanceTimersByTime(FOLDER_NOTICE_SETTLE_MS);
    expect(p.writes).toEqual(["\x1b[A", "\r"]);
    p.emit(capture.fresh.afterEnter);
    expect(p.writes).toEqual(["\x1b[A", "\r", "2", "fix it"]);
    expect(m.writeFromTeammate(s.id, " now")).toBe("typed");
    // what the teammate left in the prompt is a draft: the wire waits for it, as it would for anyone's
    m.statusFromHook({ paneId: s.id, status: "idle" });
    vi.advanceTimersByTime(200);
    expect(p.writes).toEqual(["\x1b[A", "\r", "2", "fix it", " now"]);
    expect(m.list().find((x) => x.id === s.id)?.queuedCount).toBe(1);
  });

  it("says so when a pane exits with a teammate's typing still held", async () => {
    const { m } = await manager();
    m.roomLaunch = async () => room;
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await m.create(codexPane);
    ptys.at(-1)!.emit(capture.fresh.beforeEnter);
    expect(m.writeFromTeammate(s.id, "abc")).toBe("held");
    ptys.at(-1)!.exit(1);
    expect(warned).toHaveBeenCalledWith(`[sessions] ${s.id} exited with a teammate's typing (3 bytes) still held for its Codex's folder notice: it wasn't typed`);
  });

  it("isn't waited for by a pane that isn't a Codex opening its folders untrusted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { m } = await manager();
    m.roomLaunch = async () => ({ ...room, codexFolderNotice: false });
    const s = await m.create(codexPane);
    m.clearWaiting(s.id);
    expect(m.deliverAgentMessage(s.id, "the wire", true)).toBe("delivered");
    vi.advanceTimersByTime(200);
    expect(ptys.at(-1)!.writes).toEqual(["|the wire|", "\r"]);
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

describe("the Helpdesk tasks workspace", () => {
  const tasksPane = { repoPath: null, useWorktree: false, agent: "claude" as const, title: "Helpdesk tasks", taskGroup: "Helpdesk", role: "tasks" as const };
  const CHROME_HELP = "Usage: claude [options]\n  --chrome     Enable Claude in Chrome integration\n  --no-chrome  Disable Claude in Chrome integration\n";
  const helpdesk = () => path.join(os.homedir(), "Helpdesk");
  async function tasksManager() {
    const t = await manager();
    t.m.readClaudeHelp = async () => CHROME_HELP;
    return t;
  }

  it("starts Claude in Chrome with its rules in its system prompt, in ~/Helpdesk, with no Mockingbird server; its hooks still name its pane", async () => {
    const { m, store } = await tasksManager();
    const asked: string[] = [];
    m.launchInstructions = (id) => (asked.push(id), "WIRES");
    fs.rmSync(helpdesk(), { recursive: true, force: true });
    const s = await m.create(tasksPane);
    const p = ptys.at(-1)!;
    const command = p.args.join(" ");
    expect(command).toContain("'--chrome'");
    expect(command).toContain(`'--append-system-prompt' ${quote(HELPDESK_RULES)}`);
    expect(command).not.toContain("--mcp-config");
    expect(command).not.toContain("WIRES");
    expect(asked).toEqual([]);
    expect(p.env.MOCKINGBIRD_SESSION).toBe(s.id);
    expect(s).toMatchObject({ role: "tasks", cwd: helpdesk(), repoPath: null, branch: null, taskGroup: "Helpdesk", kind: "assistant" });
    expect(fs.statSync(helpdesk()).isDirectory()).toBe(true);
    expect(store.state.sessions.find((x: any) => x.id === s.id).role).toBe("tasks");
    // an ordinary Claude pane: its Mockingbird server, no Chrome
    await m.create(agentPane);
    expect(ptys.at(-1)!.args.join(" ")).toContain("--mcp-config");
    expect(ptys.at(-1)!.args.join(" ")).not.toContain("--chrome");
  });

  it("keeps its role, --chrome and its rules through a relaunch and a Resume, in ~/Helpdesk made again when it was removed", async () => {
    const { m } = await tasksManager();
    const s = await m.create(tasksPane);
    m.kill(s.id, false);
    fs.rmSync(helpdesk(), { recursive: true, force: true });
    expect(await m.missingFolders()).toEqual([]);
    const again = await m.relaunch(s.id);
    expect(again).toMatchObject({ id: s.id, role: "tasks", cwd: helpdesk() });
    for (let i = 0; i < 2; i++) {
      const command = ptys.at(-1)!.args.join(" ");
      expect(command).toContain("'--chrome'");
      expect(command).toContain(quote(HELPDESK_RULES));
      expect(command).not.toContain("--mcp-config");
      if (i) break;
      ptys.at(-1)!.exit(0);
      expect(await m.resume(s.id)).toMatchObject({ id: s.id, role: "tasks" });
    }
  });

  it("is Claude's only, and never starts in, or moves into, a team room's area", async () => {
    const { m } = await tasksManager();
    await expect(m.create({ ...tasksPane, agent: "codex" })).rejects.toThrow(/runs Claude only/);
    await expect(m.create({ ...tasksPane, shell: true })).rejects.toThrow(/runs Claude only/);
    m.roomOfGroup = (g) => (g.split("/")[0] === "Shared" ? "R1" : null);
    const n = ptys.length;
    await expect(m.create({ ...tasksPane, taskGroup: "Shared" })).rejects.toThrow(/never runs in a team room's area: teammates would see your admin consoles/);
    expect(ptys.length).toBe(n);
    const s = await m.create(tasksPane);
    expect(() => m.setGroup(s.id, "Shared/sub")).toThrow(/never runs in a team room's area/);
    expect(m.list().find((x) => x.id === s.id)!.taskGroup).toBe("Helpdesk");
    m.setGroup(s.id, "Elsewhere/sub");
    expect(m.list().find((x) => x.id === s.id)!.taskGroup).toBe("Elsewhere/sub");
    // nor does its area, renamed onto a room's
    expect(() => m.renameGroup("Elsewhere", "Shared")).toThrow(/never runs in a team room's area/);
    expect(m.list().find((x) => x.id === s.id)!.taskGroup).toBe("Elsewhere/sub");
    m.renameGroup("Elsewhere", "Desk");
    expect(m.list().find((x) => x.id === s.id)!.taskGroup).toBe("Desk/sub");
    // closed, its record isn't moved in either
    m.kill(s.id, false);
    expect(() => m.setGroup(s.id, "Shared")).toThrow(/never runs in a team room's area/);
    // any other session moves into a room's area as before
    const other = await m.create(agentPane);
    m.setGroup(other.id, "Shared");
    expect(m.list().find((x) => x.id === other.id)!.taskGroup).toBe("Shared");
  });

  it("is refused, saying why, by a Claude Code without --chrome; the answer is kept per version, and a read that failed is asked again", async () => {
    const { m } = await manager();
    const reads: string[] = [];
    let help = "Usage: claude [options]\n  --no-chrome  Disable Claude in Chrome integration\n";
    m.readClaudeHelp = async (bin) => (reads.push(bin), help);
    m.setAgentVersions({ claude: "2.0.1" });
    const n = ptys.length;
    const why = "Claude Code 2.0.1 has no --chrome, which the Helpdesk tasks workspace needs to work in your Chrome: update Claude Code (Settings → Agents → Update), then start it again";
    await expect(m.create(tasksPane)).rejects.toThrow(why);
    await expect(m.create(tasksPane)).rejects.toThrow(why);
    expect(reads).toEqual(["/bin/echo"]);
    expect(ptys.length).toBe(n);
    // updated: the new version's --help is read
    help = CHROME_HELP;
    m.setAgentVersions({ claude: "2.1.322" });
    const first = await m.create(tasksPane);
    expect(reads).toHaveLength(2);
    // closed, so the next start isn't a second one
    m.kill(first.id, false);
    // a read that fails says why, and isn't kept
    m.setAgentVersions({ claude: "2.1.400" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.readClaudeHelp = async (bin) => {
      reads.push(bin);
      throw new Error("timed out after 20s");
    };
    await expect(m.create(tasksPane)).rejects.toThrow("Couldn't check that Claude Code has Claude in Chrome (/bin/echo --help: timed out after 20s), so the Helpdesk tasks workspace didn't start");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/couldn't read \/bin\/echo --help/));
    m.readClaudeHelp = async (bin) => (reads.push(bin), CHROME_HELP);
    await m.create(tasksPane);
    expect(reads).toHaveLength(4);
  });

  it("reads --help from the binary it runs, through the login shell", async () => {
    const dir = tempDir("claude-bins");
    const standIn = (name: string, help: string) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `#!/bin/sh\ncat <<'EOF'\n${help}EOF\n`, { mode: 0o755 });
      return file;
    };
    const old = standIn("old-claude", "Usage: claude [options]\n  --no-chrome  Disable Claude in Chrome integration\n");
    const current = standIn("claude", CHROME_HELP);
    const { m, store } = await manager();
    store.settings.claudeBin = old;
    m.resetBinCache();
    await expect(m.create(tasksPane)).rejects.toThrow(/^This Claude Code has no --chrome, .*update Claude Code/);
    store.settings.claudeBin = current;
    m.resetBinCache();
    await m.create(tasksPane);
    expect(ptys.at(-1)!.args.join(" ")).toContain(`exec ${quote(current)} `);
  });

  it("is the only agent ~/Helpdesk runs: a resumed conversation, a handoff's, a brief's or a terminal bringing one back there are refused", async () => {
    const { m } = await tasksManager();
    const s = await m.create(tasksPane);
    const n = ptys.length;
    const why = "~/Helpdesk holds the Helpdesk tasks workspace's conversations, which hold what you saw on admin sites, so they open only there: New workspace → Helpdesk tasks…";
    // as Import and a search hit resume one, and a handoff, brief or review start beside it (companionSession)
    fs.mkdirSync(path.join(s.cwd, "notes"), { recursive: true });
    await expect(m.create({ ...agentPane, cwd: s.cwd, resumeSessionId: "conv-h" })).rejects.toThrow(why);
    await expect(m.create({ ...agentPane, agent: "codex", cwd: path.join(s.cwd, "notes"), initialPrompt: "Continue from this handoff" })).rejects.toThrow(why);
    await expect(m.create({ repoPath: null, useWorktree: false, shell: true, cwd: s.cwd, shellResume: { agent: "claude", id: "conv-h" }, title: "t" })).rejects.toThrow(why);
    expect(ptys.length).toBe(n);
    // a plain terminal there runs no agent, and a folder beside it is any other
    await m.create({ repoPath: null, useWorktree: false, shell: true, cwd: s.cwd, title: "t" });
    fs.mkdirSync(path.join(os.homedir(), "Helpdesk-notes"), { recursive: true });
    await m.create({ ...agentPane, cwd: path.join(os.homedir(), "Helpdesk-notes") });
    expect(ptys.length).toBe(n + 2);
  });

  it("is one at a time: a second start while one is open or starting is refused, saying why, and its own relaunch isn't", async () => {
    const { m } = await tasksManager();
    // two starts at once (a double click): the second is refused while the first reads --help, and only one pty starts
    const n = ptys.length;
    const [a, b] = await Promise.allSettled([m.create(tasksPane), m.create(tasksPane)]);
    expect(a.status).toBe("fulfilled");
    expect(b).toMatchObject({ status: "rejected", reason: new Error(HELPDESK_STARTING) });
    expect(ptys.length).toBe(n + 1);
    const s = (a as PromiseFulfilledResult<SessionInfo>).value;
    // open, running or exited: another is refused, naming the one there is
    await expect(m.create(tasksPane)).rejects.toThrow(helpdeskOpenAlready("Helpdesk tasks"));
    ptys.at(-1)!.exit(0);
    await expect(m.create(tasksPane)).rejects.toThrow(/open already, as “Helpdesk tasks”: New workspace → Helpdesk tasks… shows it/);
    expect(ptys.length).toBe(n + 1);
    // its own Resume, under its id, starts it again
    expect(await m.resume(s.id)).toMatchObject({ id: s.id, role: "tasks" });
    // closed, a new one starts; any other session starts as before, alongside it
    m.kill(s.id, false);
    await m.create(tasksPane);
    await m.create(agentPane);
    expect(ptys.length).toBe(n + 4);
  });

  it("is left out of the daily digest, so nothing it read reaches another agent", async () => {
    const { m } = await tasksManager();
    await m.create(tasksPane);
    const other = await m.create(agentPane);
    expect(m.digest().map((d) => d.info.id)).toEqual([other.id]);
  });
});

describe("a step not started yet (W8)", () => {
  /** A clone of an origin, and step A: a worktree session on `feat` with a commit of its own that origin hasn't got. */
  async function upstream() {
    const { m, store } = await manager();
    const origin = makeRepo({ "a.txt": "1" }, "origin");
    const clone = path.join(path.dirname(origin), "clone");
    git(path.dirname(origin), "clone", "-q", origin, clone);
    const a = await m.create({ repoPath: clone, useWorktree: true, branchName: "feat", agent: "claude", title: "Builder", taskGroup: "5120" });
    git(a.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "unpushed work");
    return { m, store, origin, clone, a, work: git(a.cwd, "rev-parse", "HEAD") };
  }
  const step = (after: string, over: Partial<PlanRequest> = {}): PlanRequest => ({ after, title: "Tester", agent: "claude", repoPath: null, worktree: false, taskGroup: "5120", ...over });

  it("is a record with no pty, kept out of resumable() and list(), and among planned()", async () => {
    const { m } = await manager();
    const a = await m.create({ ...agentPane, taskGroup: "5120" });
    const started = ptys.length;
    const b = m.plan(step(a.id));
    expect(ptys.length).toBe(started);
    expect(b).toMatchObject({ title: "Tester", taskGroup: "5120", branch: null, planned: { worktree: false } });
    expect(m.planned().map((s) => s.id)).toEqual([b.id]);
    expect(m.resumable().map((s) => s.id)).not.toContain(b.id);
    expect(m.list().map((s) => s.id)).not.toContain(b.id);
    expect(() => m.closedOutput(b.id)).toThrow("hasn't started, so it has no output");
  });

  it("is refused, saving nothing, for what can't be one", async () => {
    const { m, store } = await manager();
    const a = await m.create({ ...agentPane, taskGroup: "5120" });
    const n = store.state.sessions.length;
    expect(() => m.plan(step("nope"))).toThrow('This Mac has no session "nope" to add a step after');
    expect(() => m.plan(step(a.id, { title: "  " }))).toThrow("Name the step");
    expect(() => m.plan(step(a.id, { taskGroup: "5120/docs" }))).toThrow("A not-started step goes in an area, not a stack");
    expect(() => m.plan(step(a.id, { agent: "shell" as never }))).toThrow(/a step runs Claude or Codex/);
    expect(() => m.plan(step(a.id, { worktree: true }))).toThrow("A worktree needs a repo");
    expect(store.state.sessions.length).toBe(n);
  });

  it("takes from Add next step only the fields it sends: a stray sharesWith picks no folder", async () => {
    const { m } = await manager();
    const a = await m.create({ ...agentPane, taskGroup: "5120" });
    const other = await m.create({ ...agentPane, taskGroup: "5120", title: "other" });
    const b = m.plan({ ...step(a.id), sharesWith: other.id } as PlanRequest);
    expect(b.planned).toEqual({ worktree: false });
  });

  it("is made for a template's lay-out with no step before it, or in the folder of a step that hasn't started either", async () => {
    const { m, store } = await manager();
    const repo = makeRepo({ "a.txt": "1" }, "tpl");
    const first = m.planStep({ title: "Builder", agent: "codex", repoPath: repo, worktree: true, base: "dev", taskGroup: "5115", ticketId: "5115", prompt: " Implement #5115. " });
    expect(first).toMatchObject({ title: "Builder", agent: "codex", repoPath: repo, cwd: repo, taskGroup: "5115", ticketId: "5115", ticketTitle: null, planned: { worktree: true, base: "dev", prompt: "Implement #5115." } });
    const next = m.planStep({ title: "Reviewer", agent: "claude", repoPath: null, worktree: false, taskGroup: "5115", sharesWith: first.id });
    expect(next).toMatchObject({ repoPath: repo, cwd: repo, planned: { worktree: false, sharesWith: first.id } });
    expect(m.planned().map((s) => s.id).sort()).toEqual([first.id, next.id].sort());
    const n = store.state.sessions.length;
    const shares = (sharesWith: string) => () => m.planStep({ title: "Tester", agent: "claude", repoPath: null, worktree: false, taskGroup: "5115", sharesWith });
    expect(shares("nope")).toThrow('This Mac has no session "nope" whose folder a step could work in');
    expect(shares("r~0f1e2d3c4b5a~n1")).toThrow("That's a teammate's session: only its owner can add a step in its folder");
    expect(store.state.sessions.length).toBe(n);
  });

  it("is never relaunched, resumed or restarted: each is refused saying why, starting nothing", async () => {
    const { m, store } = await manager();
    const a = await m.create({ ...agentPane, taskGroup: "5120" });
    const b = m.plan(step(a.id));
    const started = ptys.length;
    const why = "“Tester” hasn't started yet: it starts when the handoff into it is sent, or with Start now in its menu";
    await expect(m.relaunch(b.id)).rejects.toThrow(why);
    expect(await m.resume(b.id)).toEqual({ refused: why });
    await expect(m.restart(b.id)).rejects.toThrow(why);
    expect(ptys.length).toBe(started);
    expect(store.state.sessions.find((s: any) => s.id === b.id)?.planned).toBeTruthy();
  });

  it("starts under its id at the commit the step before it is on, not origin's, on a branch named after that one's", async () => {
    const { m, store, clone, a, work } = await upstream();
    const b = m.plan(step(a.id, { repoPath: clone, worktree: true, base: "main" }));
    const started = await m.startPlanned(b.id, a.id);
    expect(started.id).toBe(b.id);
    expect(started.branch).toBe("feat-tester");
    expect(started.cwd).toBe(path.join(worktreeRoot(clone), "feat-tester"));
    expect(git(started.cwd, "rev-parse", "HEAD")).toBe(work);
    expect(git(started.cwd, "rev-parse", "HEAD")).not.toBe(git(clone, "rev-parse", "origin/main"));
    expect(m.buffer(b.id)).toContain(`Started at “Builder”'s commit ${work.slice(0, 7)}.`);
    // its record is the running session's now: nothing of planned left, and it's neither planned nor closed
    expect(store.state.sessions.find((s: any) => s.id === b.id)?.planned).toBeUndefined();
    expect(m.planned()).toEqual([]);
    expect(m.list().map((s) => s.id)).toContain(b.id);
    await expect(m.startPlanned(b.id, a.id)).rejects.toThrow("It's running already");
  });

  it("is started once: a second start, a resume or a forget while its start is under way is refused", async () => {
    const { m, store, clone, a } = await upstream();
    const b = m.plan(step(a.id, { repoPath: clone, worktree: true }));
    const before = ptys.length;
    const first = m.startPlanned(b.id, a.id);
    await expect(m.startPlanned(b.id, a.id)).rejects.toThrow("It's being started already");
    expect(await m.resume(b.id)).toEqual({ refused: "It's being started already" });
    expect(() => m.kill(b.id, true)).toThrow("It's being started already: forget it once it has opened");
    expect((await first).id).toBe(b.id);
    expect(ptys.length).toBe(before + 1);
    expect(store.state.sessions.filter((s: any) => s.id === b.id)).toHaveLength(1);
  });

  it("says in its pane that the step before's uncommitted files aren't there, and takes a branch no other has", async () => {
    const { m, clone, a, work } = await upstream();
    fs.writeFileSync(path.join(a.cwd, "draft.txt"), "not committed");
    git(clone, "branch", "-q", "feat-tester");
    const b = m.plan(step(a.id, { repoPath: clone, worktree: true }));
    const started = await m.startPlanned(b.id, a.id);
    expect(started.branch).toBe("feat-tester-2");
    expect(git(started.cwd, "rev-parse", "HEAD")).toBe(work);
    expect(fs.existsSync(path.join(started.cwd, "draft.txt"))).toBe(false);
    expect(m.buffer(b.id)).toContain(`Started at “Builder”'s commit ${work.slice(0, 7)}: its uncommitted file isn't carried.`);
  });

  it("counts the step before's uncommitted files with a guarded status: nothing its folder's config names runs", async () => {
    const { m, clone, a } = await upstream();
    const at = tempDir("fsmonitor");
    const ran = path.join(at, "ran");
    fs.writeFileSync(path.join(at, "fsm.sh"), `#!/bin/sh\necho ran >> "${ran}"\nexit 1\n`, { mode: 0o755 });
    git(a.cwd, "config", "core.fsmonitor", path.join(at, "fsm.sh"));
    fs.writeFileSync(path.join(a.cwd, "draft.txt"), "not committed");
    const b = m.plan(step(a.id, { repoPath: clone, worktree: true }));
    await m.startPlanned(b.id, a.id);
    expect(m.buffer(b.id)).toContain("its uncommitted file isn't carried.");
    expect(fs.existsSync(ran)).toBe(false);
  });

  it("starts at the step before's commit when its uncommitted files can't be counted, saying so", async () => {
    const { m, clone, a, work } = await upstream();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // a corrupt index: rev-parse HEAD still reads, status fails
    fs.writeFileSync(path.resolve(a.cwd, git(a.cwd, "rev-parse", "--git-path", "index")), "not an index");
    const b = m.plan(step(a.id, { repoPath: clone, worktree: true }));
    const started = await m.startPlanned(b.id, a.id);
    expect(started.branch).toBe("feat-tester");
    expect(git(started.cwd, "rev-parse", "HEAD")).toBe(work);
    expect(m.buffer(b.id)).toMatch(new RegExp(`Started at “Builder”'s commit ${work.slice(0, 7)}: its uncommitted files couldn't be counted \\(.*index.*\\), and none are carried\\.`));
    expect(warn.mock.calls.some((c) => String(c[0]).includes("“Builder”'s uncommitted files") && String(c[0]).includes(work.slice(0, 7)))).toBe(true);
  });

  it("starts in the folder of the session it shares one with, on its branch as it stands (decision 7)", async () => {
    const { m, a } = await upstream();
    const b = m.plan(step(a.id, { sharesFolder: true, repoPath: "/elsewhere", worktree: true }));
    expect(b.planned).toEqual({ worktree: false, sharesWith: a.id });
    const started = await m.startPlanned(b.id, a.id);
    expect(started).toMatchObject({ id: b.id, cwd: a.cwd, branch: "feat" });
  });

  it("refuses to start, keeping its record, when the folder it shares has gone, or its session was forgotten", async () => {
    const { m, store, clone, a } = await upstream();
    const b = m.plan(step(a.id, { sharesFolder: true }));
    m.kill(a.id, false);
    git(clone, "worktree", "remove", "--force", a.cwd);
    const started = ptys.length;
    await expect(m.startPlanned(b.id, a.id)).rejects.toThrow(`“Tester” works in “Builder”'s folder, ${a.cwd}, which isn't there any more`);
    expect(ptys.length).toBe(started);
    expect(store.state.sessions.find((s: any) => s.id === b.id)?.planned).toBeTruthy();
    m.kill(a.id, true);
    await expect(m.startPlanned(b.id, a.id)).rejects.toThrow("works in another session's folder, and that session was forgotten");
    m.kill(b.id, true);
    expect(m.planned()).toEqual([]);
  });

  it("is cut at its repo's HEAD on a branch of its own, saying why, when the step before it works in another repository", async () => {
    const { m, a } = await upstream();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const other = makeRepo({ "b.txt": "1" }, "other");
    const b = m.plan(step(a.id, { repoPath: other, worktree: true }));
    const started = await m.startPlanned(b.id, a.id);
    expect(started.branch).toBe("step-tester");
    expect(git(started.cwd, "rev-parse", "HEAD")).toBe(git(other, "rev-parse", "HEAD"));
    expect(m.buffer(b.id)).toContain(`Started at ${path.basename(other)}'s HEAD, ${git(other, "rev-parse", "HEAD").slice(0, 7)}: “Builder” works in another repository.`);
  });

  it("says where it would start, for Start now's confirm, as it then starts there", async () => {
    const { m, clone, a, work } = await upstream();
    const shares = m.plan(step(a.id, { sharesFolder: true }));
    const own = m.plan(step(a.id, { title: "QA", repoPath: clone, worktree: true }));
    expect(await m.describeStart(shares.id, a.id)).toBe(`It starts in “Builder”'s folder, ${a.cwd}, on feat, while “Builder” is working.`);
    expect(await m.describeStart(own.id, a.id)).toBe(`It starts in a new worktree, feat-qa, at “Builder”'s commit ${work.slice(0, 7)}.`);
    expect((await m.startPlanned(own.id, a.id)).branch).toBe("feat-qa");
  });

  /** Rooms by group: "room" is team room R1's area, every other group private. Starting asks WireService, as index.ts has it. */
  function roomed(m: Awaited<ReturnType<typeof manager>>["m"]) {
    const store = new LandscapeStore({ file: path.join(tempDir("ls"), "landscape.json"), emit: () => {}, emitWires: () => {}, log: () => {} });
    const groupOf = (id: string) => [...m.list(), ...m.resumable(), ...m.planned()].find((s) => s.id === id)?.taskGroup;
    const wires = new WireService({ store, sessions: m, roomOf: (id) => (groupOf(id) === "room" ? "R1" : null), roomsKnown: () => true, takenOver: () => null, log: () => {} });
    m.startGuard = (s, o) => wires.startRefusal(s, o);
    return { wires, steps: { plan: (q: PlanRequest) => m.plan(q), forget: (id: string) => m.kill(id, true) } };
  }

  it("won't start in the folder of, or from the commit of, a session moved across a team room's line from it, making nothing", async () => {
    const { m, clone, a } = await upstream();
    const { wires, steps } = roomed(m);
    const shares = wires.addStep(step(a.id, { sharesFolder: true }), steps).info;
    const own = wires.addStep(step(a.id, { title: "QA", repoPath: clone, worktree: true }), steps).info;
    m.setGroup(a.id, "room");
    const before = ptys.length;
    await expect(m.startPlanned(shares.id, a.id)).rejects.toThrow(`“Tester” can't start in “Builder”'s folder: ${ROOM_LINE}`);
    await expect(m.describeStart(shares.id, a.id)).rejects.toThrow(`“Tester” can't start in “Builder”'s folder: ${ROOM_LINE}`);
    await expect(m.startPlanned(own.id, a.id)).rejects.toThrow(`“QA” can't start from “Builder”'s commit: ${ROOM_LINE}`);
    expect(ptys.length).toBe(before);
    expect(fs.existsSync(path.join(worktreeRoot(clone), "feat-qa"))).toBe(false);
    expect(m.planned().map((s) => s.id).sort()).toEqual([shares.id, own.id].sort());
    // back on this side of the line, both start
    m.setGroup(a.id, "5120");
    expect((await m.startPlanned(shares.id, a.id)).cwd).toBe(a.cwd);
    expect((await m.startPlanned(own.id, a.id)).branch).toBe("feat-qa");
  });

  it("won't start a team room's step in a private session's folder or from its commit", async () => {
    const { m, clone, a } = await upstream();
    roomed(m);
    const shares = m.plan(step(a.id, { sharesFolder: true, taskGroup: "room" }));
    const own = m.plan(step(a.id, { title: "QA", repoPath: clone, worktree: true, taskGroup: "room" }));
    const before = ptys.length;
    await expect(m.startPlanned(shares.id, a.id)).rejects.toThrow(`“Tester” can't start in “Builder”'s folder: ${ROOM_LINE}`);
    await expect(m.startPlanned(own.id, a.id)).rejects.toThrow(`“QA” can't start from “Builder”'s commit: ${ROOM_LINE}`);
    expect(ptys.length).toBe(before);
  });

  it("asks again as its pty is about to start, taking back what it made: a move across a team room's line, or to another area, while it starts", async () => {
    const { m, clone, a } = await upstream();
    const { wires, steps } = roomed(m);
    const before = ptys.length;
    // the step moved into the room just after the check that let it start from Builder's commit, as its git is read
    const own = wires.addStep(step(a.id, { title: "QA", repoPath: clone, worktree: true }), steps).info;
    const guard = m.startGuard!;
    let moved = false;
    m.startGuard = (s, o) => {
      const why = guard(s, o);
      if (!why && !moved) {
        moved = true;
        queueMicrotask(() => m.setGroup(s, "room"));
      }
      return why;
    };
    await expect(m.startPlanned(own.id, a.id)).rejects.toThrow(`“QA” can't start from “Builder”'s commit: ${ROOM_LINE}`);
    expect(moved).toBe(true);
    expect(fs.existsSync(path.join(worktreeRoot(clone), "feat-qa"))).toBe(false);
    expect(git(clone, "branch", "--list", "feat-qa")).toBe("");
    m.startGuard = guard;
    // Builder moved into the room as the step sharing its folder launches
    const shares = wires.addStep(step(a.id, { sharesFolder: true }), steps).info;
    m.roomLaunch = async (t) => (t.id === shares.id && m.setGroup(a.id, "room"), null);
    await expect(m.startPlanned(shares.id, a.id)).rejects.toThrow(`“Tester” can't start in “Builder”'s folder: ${ROOM_LINE}`);
    // the step moved to another private area as it launches, its launch prepared for the one it was in
    m.setGroup(a.id, "5120");
    m.roomLaunch = async (t) => (t.id === shares.id && m.setGroup(shares.id, "5121"), null);
    await expect(m.startPlanned(shares.id, a.id)).rejects.toThrow("“Tester” moved to another area as it started, so it wasn't started: start it again");
    expect(ptys.length).toBe(before);
    expect(m.planned().map((s) => s.id).sort()).toEqual([own.id, shares.id].sort());
    // nothing moving, it starts
    m.roomLaunch = null;
    expect(await m.startPlanned(shares.id, a.id)).toMatchObject({ cwd: a.cwd, taskGroup: "5121" });
  });

  it("won't start in the folder of, or from the commit of, a copy a teammate continues", async () => {
    const { m, clone, a } = await upstream();
    const shares = m.plan(step(a.id, { sharesFolder: true }));
    const own = m.plan(step(a.id, { title: "QA", repoPath: clone, worktree: true }));
    m.kill(a.id, false);
    const why = "“Builder” continues on Nick's laptop — take it back rather than running this copy again";
    m.relaunchGuard = (id) => (id === a.id ? why : null);
    await expect(m.relaunch(a.id)).rejects.toThrow(why);
    const before = ptys.length;
    await expect(m.startPlanned(shares.id, a.id)).rejects.toThrow(`“Tester” can't start in “Builder”'s folder: ${why}`);
    await expect(m.startPlanned(own.id, a.id)).rejects.toThrow(`“QA” can't start from “Builder”'s commit: ${why}`);
    expect(ptys.length).toBe(before);
  });

  it("with nothing handing off to it, starts at its repo's HEAD on a branch of its own, and says so", async () => {
    const { m, clone, a } = await upstream();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = m.plan(step(a.id, { repoPath: clone, worktree: true }));
    const head = git(clone, "rev-parse", "HEAD");
    expect(await m.describeStart(b.id, null)).toBe(`It starts in a new worktree, step-tester, at clone's HEAD, ${head.slice(0, 7)}: nothing hands off to it.`);
    const started = await m.startPlanned(b.id, null);
    expect(started.branch).toBe("step-tester");
    expect(git(started.cwd, "rev-parse", "HEAD")).toBe(head);
    expect(m.buffer(b.id)).toContain(`Started at clone's HEAD, ${head.slice(0, 7)}: nothing hands off to it.`);
  });

  it("takes back the worktree and branch a start that failed made, so starting it again gets the same branch", async () => {
    const { m, clone, a } = await upstream();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const b = m.plan(step(a.id, { repoPath: clone, worktree: true }));
    spawnFails.next = true;
    await expect(m.startPlanned(b.id, a.id)).rejects.toThrow(/posix_spawnp failed/);
    expect(fs.existsSync(path.join(worktreeRoot(clone), "feat-tester"))).toBe(false);
    expect(git(clone, "branch", "--list", "feat-tester*")).toBe("");
    expect(m.planned().map((s) => s.id)).toEqual([b.id]);
    expect((await m.startPlanned(b.id, a.id)).branch).toBe("feat-tester");
  });

  it("leaves out the step before's branch name when git would take it for an option", async () => {
    const { m, clone, a } = await upstream();
    git(clone, "update-ref", "refs/heads/-x", git(a.cwd, "rev-parse", "HEAD"));
    git(a.cwd, "symbolic-ref", "HEAD", "refs/heads/-x");
    const b = m.plan(step(a.id, { repoPath: clone, worktree: true }));
    const started = await m.startPlanned(b.id, a.id);
    expect(started.branch).toBe("step-tester");
    expect(m.buffer(b.id)).toContain(`The branch it follows, "-x", can't lead a branch's name, so its own starts "step".`);
  });

  it("always leads its branch's name, and refuses one that would be a base branch's", async () => {
    const { m, clone, a } = await upstream();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const main = m.plan(step(a.id, { title: "Main", repoPath: clone, worktree: true }));
    expect((await m.startPlanned(main.id, null)).branch).toBe("step-main");
    const clash = m.plan(step(a.id, { repoPath: clone, worktree: true, base: "feat-tester" }));
    await expect(m.startPlanned(clash.id, a.id)).rejects.toThrow("“Tester” would start on feat-tester, a base branch's name: rename the step");
  });

  it("takes a step before it that hasn't started as none: no folder of its to share, no commit of its to start at", async () => {
    const { m, clone, a } = await upstream();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = m.plan(step(a.id, { title: "S", repoPath: clone, worktree: true }));
    expect(() => m.plan(step(s.id, { title: "T", sharesFolder: true }))).toThrow("“S” hasn't started, so it has no folder to share yet: give this step a folder of its own");
    const v = m.plan(step(s.id, { title: "V", repoPath: clone, worktree: true }));
    const started = await m.startPlanned(v.id, s.id);
    expect(started.branch).toBe("step-v");
    expect(git(started.cwd, "rev-parse", "HEAD")).toBe(git(clone, "rev-parse", "HEAD"));
    expect(m.buffer(v.id)).toContain("“S” hasn't started, so it has no commit to start at.");
  });

  it("is refused a stack's group, as plan refuses one", async () => {
    const { m } = await manager();
    const a = await m.create({ ...agentPane, taskGroup: "5120" });
    const s = m.plan(step(a.id));
    expect(() => m.setGroup(s.id, "5120/docs")).toThrow("A not-started step goes in an area, not a stack");
    expect(m.planned()[0].taskGroup).toBe("5120");
    m.setGroup(s.id, "5121");
    expect(m.planned()[0].taskGroup).toBe("5121");
  });
});

describe("a team room's session and the home folder", () => {
  /** Groups under "Shared" are a team room's. */
  const rooms = (m: { roomOfGroup: ((g: string) => string | null) | null }) => void (m.roomOfGroup = (g) => (g.split("/")[0] === "Shared" ? "R1" : null));
  const AT_HOME = "A team room's session can't work in your home folder: the room's sandbox would let it write across everything there. Choose a repo for it.";

  it("isn't started at home or in a folder holding it (New session), saying why and starting nothing; outside a room, home is as before", async () => {
    const { m } = await manager();
    rooms(m);
    const n = ptys.length;
    await expect(m.create({ ...agentPane, taskGroup: "Shared" })).rejects.toThrow(AT_HOME);
    await expect(m.create({ ...agentPane, taskGroup: "Shared/api", cwd: path.dirname(os.homedir()) })).rejects.toThrow(`A team room's session can't work in ${path.dirname(os.homedir())}, which holds your home folder`);
    // a terminal resuming an agent runs it in the room's sandbox
    await expect(m.create({ repoPath: null, useWorktree: false, shell: true, shellResume: { agent: "codex", id: "019a-conv" }, title: "t", taskGroup: "Shared" })).rejects.toThrow(AT_HOME);
    // a room session on a ticket goes by the ticket's area when it's given no group
    await expect(m.create({ ...agentPane, ticketId: "Shared" })).rejects.toThrow(AT_HOME);
    expect(ptys.length).toBe(n);
    // a plain terminal runs no agent and no sandbox: home is as before
    await expect(m.create({ repoPath: null, useWorktree: false, shell: true, title: "t", taskGroup: "Shared" })).resolves.toMatchObject({ cwd: os.homedir() });
    await expect(m.create({ ...agentPane, taskGroup: "Mine" })).resolves.toMatchObject({ cwd: os.homedir() });
    // a repo's folder is fine in a room
    const repo = makeRepo({ "a.txt": "1" }, "roomrepo");
    await expect(m.create({ repoPath: repo, useWorktree: false, agent: "claude", title: "r", taskGroup: "Shared", cwd: repo })).resolves.toMatchObject({ cwd: repo });
  });

  it("knows the home folder however its name is cased", async (ctx) => {
    const upper = os.homedir().toUpperCase();
    // a case-sensitive volume: the two are different folders
    if (upper === os.homedir() || !fs.existsSync(upper)) ctx.skip();
    const { m } = await manager();
    rooms(m);
    await expect(m.create({ ...agentPane, taskGroup: "Shared", cwd: upper })).rejects.toThrow(AT_HOME);
    await expect(m.create({ ...agentPane, taskGroup: "Shared", cwd: path.join(upper, "..") })).rejects.toThrow("which holds your home folder");
  });

  it("isn't given the home folder, or one holding it, as an extra folder: refused before a worktree's made, and when an old record carrying it is resumed", async () => {
    const { m } = await manager();
    const repo = makeRepo({ "a.txt": "1" }, "extrarepo");
    const before = await m.create({ repoPath: repo, useWorktree: false, cwd: repo, agent: "claude", title: "before", taskGroup: "Shared", extraDirs: ["~"] });
    rooms(m);
    const n = ptys.length;
    const EXTRA_HOME = "A team room's session can't be given your home folder as an extra folder: the room's sandbox would let it write across everything there. Leave it out.";
    await expect(m.create({ repoPath: repo, useWorktree: false, cwd: repo, agent: "claude", title: "r", taskGroup: "Shared", extraDirs: ["~"] })).rejects.toThrow(EXTRA_HOME);
    await expect(m.create({ repoPath: repo, useWorktree: false, cwd: repo, agent: "codex", title: "r", taskGroup: "Shared", extraDirs: [path.dirname(os.homedir())] })).rejects.toThrow(
      `A team room's session can't be given ${path.dirname(os.homedir())}, which holds your home folder, as an extra folder`
    );
    // a terminal bringing an agent back runs it in the room's sandbox
    await expect(m.create({ repoPath: repo, useWorktree: false, cwd: repo, shell: true, shellResume: { agent: "codex", id: "019a-conv" }, title: "t", taskGroup: "Shared", extraDirs: ["~"] })).rejects.toThrow(EXTRA_HOME);
    await expect(m.create({ repoPath: repo, useWorktree: true, branchName: "mb-extra", agent: "claude", title: "w", taskGroup: "Shared", extraDirs: ["~"] })).rejects.toThrow(EXTRA_HOME);
    expect(fs.existsSync(path.join(worktreeRoot(repo), "mb-extra"))).toBe(false);
    // the record of one given home before its area was a room's: its resume is refused, and it's kept
    await expect(m.restart(before.id)).rejects.toThrow(EXTRA_HOME);
    expect(ptys.length).toBe(n);
    expect(m.resumable().map((s) => s.id)).toContain(before.id);
    // a folder inside home is fine in a room, and home outside one is as before
    const notes = tempDir("notes");
    await expect(m.create({ repoPath: repo, useWorktree: false, cwd: repo, agent: "claude", title: "ok", taskGroup: "Shared", extraDirs: [notes] })).resolves.toMatchObject({ extraDirs: [notes] });
    await expect(m.create({ ...agentPane, taskGroup: "Mine", extraDirs: ["~"] })).resolves.toMatchObject({ taskGroup: "Mine" });
  });

  it("isn't planned at home, by Add next step or a template's lay-out, nor in the folder of a session at home, saving nothing", async () => {
    const { m, store } = await manager();
    const a = await m.create({ ...agentPane, taskGroup: "Mine" });
    rooms(m);
    const n = store.state.sessions.length;
    const step: PlanRequest = { after: a.id, title: "Tester", agent: "claude", repoPath: null, worktree: false, taskGroup: "Shared" };
    expect(() => m.plan(step)).toThrow(AT_HOME);
    expect(() => m.plan({ ...step, sharesFolder: true })).toThrow(AT_HOME);
    expect(() => m.planStep({ title: "Tester", agent: "claude", repoPath: null, worktree: false, taskGroup: "Shared" })).toThrow(AT_HOME);
    expect(() => m.planStep({ title: "Tester", agent: "claude", repoPath: null, worktree: false, taskGroup: "Shared", sharesWith: a.id })).toThrow(AT_HOME);
    expect(store.state.sessions.length).toBe(n);
  });

  it("isn't started from a step planned at home before its area was a room's", async () => {
    const { m } = await manager();
    const b = m.planStep({ title: "Tester", agent: "claude", repoPath: null, worktree: false, taskGroup: "Shared" });
    rooms(m);
    const n = ptys.length;
    await expect(m.startPlanned(b.id)).rejects.toThrow(AT_HOME);
    expect(ptys.length).toBe(n);
    expect(m.planned().map((s) => s.id)).toContain(b.id);
  });
});
