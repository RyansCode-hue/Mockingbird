import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, paneEnv } from "../src/main/sessions";

type Written = string[];
const store = { settings: {}, state: { sessions: [] }, upsertSession() {}, removeSession() {}, save() {} };

function manager() {
  const m = new SessionManager(store as any);
  const out: Record<string, Written> = {};
  const add = (id: string, status: string) => {
    out[id] = [];
    (m as any).live.set(id, {
      info: { id, title: id, cwd: `/w/${id}`, status, kind: "work" },
      proc: { write: (d: string) => out[id].push(d.replace(/\x1b\[20[01]~/g, "|")) },
      buffer: "",
      queued: [],
      claudeId: null,
      lastInput: 0,
      draft: false,
      flushTimer: null,
    });
  };
  return { m, out, add, status: (id: string) => (m as any).live.get(id).info.status };
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
  it("in manual mode, places the message without pressing Enter", () => {
    const { m, out, add, status } = manager();
    add("d", "idle");
    expect(m.deliverAgentMessage("d", "hello", false)).toMatch(/placed in its prompt/);
    vi.advanceTimersByTime(500);
    expect(out.d).toEqual(["|hello|"]);
    expect(status("d")).toBe("idle");
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
