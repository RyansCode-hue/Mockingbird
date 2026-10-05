import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionManager, paneEnv } from "../src/main/sessions";

type Written = string[];
function manager(saved: any[] = []) {
  const store = { settings: {}, state: { sessions: saved }, upserts: [] as any[], upsertSession(i: any) { this.upserts.push(structuredClone(i)); }, removeSession() {}, save() {} };
  const m = new SessionManager(store as any);
  const out: Record<string, Written> = {};
  const add = (id: string, status: string, cwd = `/w/${id}`) => {
    out[id] = [];
    (m as any).live.set(id, {
      info: { id, title: id, cwd, status, kind: "work" },
      proc: { write: (d: string) => out[id].push(d.replace(/\x1b\[20[01]~/g, "|")) },
      buffer: "",
      queued: [],
      claudeId: null,
      lastInput: 0,
      draft: false,
      flushTimer: null,
    });
  };
  return { m, out, add, store, status: (id: string) => (m as any).live.get(id).info.status, info: (id: string) => (m as any).live.get(id).info };
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
afterEach(() => vi.useRealTimers());

describe("delivering agent messages", () => {
  it("pastes and submits into an idle pane", () => {
    const { m, out, add, status } = manager();
    add("a", "idle");
    expect(m.deliverAgentMessage("a", "hello", true)).toBe("delivered");
    vi.advanceTimersByTime(200);
    expect(out.a).toEqual(["|hello|", "\r"]);
    expect(status("a")).toBe("working");
  });
  it("waits for a busy pane's turn to end — Enter would answer a pending prompt", () => {
    const { m, out, add } = manager();
    add("b", "waiting");
    expect(m.deliverAgentMessage("b", "hello", true)).toMatch(/queued until its current turn ends/);
    vi.advanceTimersByTime(60_000);
    expect(out.b).toEqual([]);
    m.statusByCwd("/w/b", "idle");
    vi.advanceTimersByTime(200);
    expect(out.b).toEqual(["|hello|", "\r"]);
  });
  it("holds messages while the user has an unsent draft, then delivers after they send it", () => {
    const { m, out, add } = manager();
    add("c", "idle");
    m.write("c", "half a thought");
    expect(m.deliverAgentMessage("c", "hello", true)).toMatch(/unsent draft/);
    vi.advanceTimersByTime(60_000);
    expect(out.c).toEqual(["half a thought"]); // never appended to the draft or submitted with it
    m.write("c", "\r"); // the user sends their prompt; the turn runs and ends
    m.statusByCwd("/w/c", "working");
    m.statusByCwd("/w/c", "idle");
    vi.advanceTimersByTime(200);
    expect(out.c).toEqual(["half a thought", "\r", "|hello|", "\r"]);
  });
  it("places a message without Enter next to a draft left untouched for 2 minutes", () => {
    const { m, out, add, status } = manager();
    add("e", "idle");
    m.write("e", "abandoned");
    m.deliverAgentMessage("e", "hello", true);
    vi.advanceTimersByTime(125_000);
    expect(out.e).toEqual(["abandoned", "|hello|"]); // visible, not sent
    expect(status("e")).toBe("idle");
  });
  it("counts pasted text as a draft, even multi-line", () => {
    const { m, add } = manager();
    add("h", "idle");
    m.write("h", "\x1b[200~line one\rline two\x1b[201~");
    expect(m.deliverAgentMessage("h", "hello", true)).toMatch(/unsent draft/);
  });
  it("doesn't treat arrow keys or a cleared prompt as a draft", () => {
    const { m, out, add } = manager();
    add("f", "idle");
    m.write("f", "\x1b[A"); // arrow up
    expect(m.deliverAgentMessage("f", "one", true)).toBe("delivered");
    add("g", "idle");
    m.write("g", "typed then");
    m.write("g", "\x03"); // Ctrl-C clears the prompt
    expect(m.deliverAgentMessage("g", "two", true)).toBe("delivered");
    vi.advanceTimersByTime(200);
    expect(out.f.at(-1)).toBe("\r");
    expect(out.g.at(-1)).toBe("\r");
  });
  it("submits one queued message per turn — Enter would send everything in the prompt at once", () => {
    const { m, out, add, status } = manager();
    add("q", "working");
    m.deliverAgentMessage("q", "first", true);
    m.deliverAgentMessage("q", "for you to send", false);
    m.deliverAgentMessage("q", "second", true);
    m.statusFromHook({ paneId: "q", status: "idle" });
    vi.advanceTimersByTime(200);
    expect(out.q).toEqual(["|first|", "\r"]);
    expect(status("q")).toBe("working");
    m.statusFromHook({ paneId: "q", status: "idle" });
    vi.advanceTimersByTime(200);
    expect(out.q).toEqual(["|first|", "\r", "|second|", "\r"]);
    m.statusFromHook({ paneId: "q", status: "idle" });
    vi.advanceTimersByTime(200);
    expect(out.q.at(-1)).toBe("|for you to send|"); // last, and never followed by Enter
    expect(status("q")).toBe("idle");
    // what was left in the prompt now holds the next submitted message back, like the user's own draft
    expect(m.deliverAgentMessage("q", "third", true)).toMatch(/unsent draft/);
  });
  it("in manual mode, places the message without pressing Enter", () => {
    const { m, out, add, status } = manager();
    add("d", "idle");
    expect(m.deliverAgentMessage("d", "hello", false)).toMatch(/placed in its prompt/);
    vi.advanceTimersByTime(500);
    expect(out.d).toEqual(["|hello|"]);
    expect(status("d")).toBe("idle");
  });
});

describe("broadcasting", () => {
  it("submits into idle panes, queues for busy ones, skips the rest — and says which", () => {
    const { m, out, add, status, info } = manager();
    for (const [id, st] of [["idle", "idle"], ["busy", "working"], ["asking", "waiting"], ["gone", "dead"], ["term", "idle"], ["brief", "idle"]]) add(id, st);
    info("term").shell = true;
    info("brief").debrief = true;
    expect(m.broadcast("status?", ["idle", "busy", "asking", "gone", "term", "brief", "closed"], true)).toEqual([
      { id: "idle", outcome: "delivered" },
      { id: "busy", outcome: "queued" },
      { id: "asking", outcome: "queued" },
      { id: "gone", outcome: "skipped" },
      { id: "term", outcome: "skipped" },
      { id: "brief", outcome: "skipped" },
      { id: "closed", outcome: "skipped" },
    ]);
    vi.advanceTimersByTime(200);
    expect(out.idle).toEqual(["|status?|", "\r"]);
    expect(status("idle")).toBe("working"); // its turn has started: the next broadcast waits for it
    expect([out.busy, out.asking, out.term, out.brief]).toEqual([[], [], [], []]);
  });
  it("never sends a user's half-typed prompt along with it: an idle pane with a draft gets it once that's sent", () => {
    const { m, out, add } = manager();
    add("a", "idle");
    m.write("a", "half a thought");
    expect(m.broadcast("status?", ["a"], true)).toEqual([{ id: "a", outcome: "queued" }]);
    vi.advanceTimersByTime(60_000);
    expect(out.a).toEqual(["half a thought"]);
    m.write("a", "\r");
    m.statusFromHook({ paneId: "a", status: "working" });
    m.statusFromHook({ paneId: "a", status: "idle" });
    vi.advanceTimersByTime(200);
    expect(out.a).toEqual(["half a thought", "\r", "|status?|", "\r"]);
  });
});

describe("paneEnv", () => {
  it("drops a parent Claude Code session's markers so panes save their own transcripts", () => {
    const keep = { ...process.env };
    Object.assign(process.env, {
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ID: "parent",
      CLAUDE_PID: "42",
      CLAUDE_EFFORT: "high",
      CLAUDE_CONFIG_DIR: "/keep/me",
      ANTHROPIC_MODEL: "keep-too",
    });
    const env = paneEnv();
    process.env = keep;
    for (const k of ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_EFFORT"]) expect(env[k]).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/keep/me");
    expect(env.ANTHROPIC_MODEL).toBe("keep-too");
    expect(env.HOME).toBe(process.env.HOME);
  });
});

describe("routing hook events", () => {
  it("goes by pane id first, even when two panes share a folder", () => {
    const { m, add, status } = manager();
    add("a", "idle", "/home");
    add("b", "idle", "/home");
    m.statusFromHook({ paneId: "b", cwd: "/home", status: "working" });
    expect([status("a"), status("b")]).toEqual(["idle", "working"]);
  });
  it("leaves a dead pane dead: a late event from its exited agent changes nothing and delivers nothing", () => {
    const { m, out, add, status } = manager();
    add("d", "dead");
    (m as any).live.get("d").queued.push({ text: "hello", submit: true });
    expect(m.statusFromHook({ paneId: "d", status: "idle" })).toBeNull();
    vi.advanceTimersByTime(200);
    expect(status("d")).toBe("dead");
    expect(out.d).toEqual([]);
  });
  it("ignores events tagged with an id that isn't a pane (a Collaborate room's runs)", () => {
    const { m, add, status } = manager();
    add("a", "idle", "/code/app");
    expect(m.statusFromHook({ paneId: "collab-123", cwd: "/code/app", status: "working" })).toBeNull();
    expect(status("a")).toBe("idle");
  });
  it("follows a conversation after its agent cd's to another pane's folder", () => {
    const { m, add, status } = manager();
    add("work", "idle", "/code/app");
    add("routine", "idle", "/home");
    m.statusFromHook({ cwd: "/code/app", conversationId: "conv-1", status: "working" });
    m.statusFromHook({ cwd: "/home", conversationId: "conv-1", status: "waiting" }); // Claude ran `cd ~`
    expect([status("work"), status("routine")]).toEqual(["waiting", "idle"]);
  });
  it("remembers the pane's latest conversation, including after /clear", () => {
    const { m, add, info, store } = manager();
    add("t", "idle", "/home");
    m.statusFromHook({ paneId: "t", conversationId: "one", agent: "claude", status: "working" });
    m.statusFromHook({ paneId: "t", conversationId: "one", agent: "claude", status: "idle" });
    expect(store.upserts.at(-1).conversation).toEqual({ agent: "claude", id: "one" });
    m.statusFromHook({ paneId: "t", conversationId: "two", agent: "claude", status: "working" });
    expect(info("t").conversation).toEqual({ agent: "claude", id: "two" });
    expect(store.upserts.at(-1).conversation).toEqual({ agent: "claude", id: "two" });
  });

  it("keeps every conversation the pane has run, for its token meter", () => {
    const { m, add, info } = manager();
    add("t", "idle", "/home");
    for (const c of ["one", "two", "one"]) m.statusFromHook({ paneId: "t", conversationId: c, agent: "claude", status: "working" });
    expect(info("t").conversations).toEqual(["two", "one"]);
  });
});

describe("relaunch after an app restart", () => {
  const transcript = (id: string) => {
    const dir = path.join(os.homedir(), ".claude", "projects", "-Users-me");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), "{}\n");
  };
  const saved = (over: object) => ({ id: "x1", title: "Weekly Routine", repoPath: null, cwd: "/Users/me", branch: null, taskGroup: "Tasks", extraDirs: [], ...over });
  const relaunchReq = (over: object) => {
    const { m } = manager([saved(over)]);
    const create = vi.fn(() => ({}) as any);
    (m as any).create = create;
    m.relaunch("x1");
    return (create.mock.calls as any[])[0][0];
  };

  it("brings a terminal back with the agent conversation that was running in it", () => {
    transcript("routine-conv");
    const req = relaunchReq({ shell: true, conversation: { agent: "claude", id: "routine-conv" } });
    expect(req).toMatchObject({ shell: true, shellResume: { agent: "claude", id: "routine-conv" } });
  });
  it("brings a plain terminal back plain", () => {
    const req = relaunchReq({ shell: true });
    expect(req.shell).toBe(true);
    expect(req.shellResume).toBeUndefined();
  });
  it("resumes an agent session's exact conversation instead of the folder's most recent", () => {
    transcript("exact-conv");
    const req = relaunchReq({ agent: "claude", conversation: { agent: "claude", id: "exact-conv" } });
    expect(req).toMatchObject({ resumeSessionId: "exact-conv", resume: false });
  });
  it("falls back to the folder's most recent when the recorded conversation is gone", () => {
    const req = relaunchReq({ agent: "claude", conversation: { agent: "claude", id: "deleted-conv" } });
    expect(req.resumeSessionId).toBeUndefined();
    expect(req.shellResume).toBeUndefined();
  });
});
