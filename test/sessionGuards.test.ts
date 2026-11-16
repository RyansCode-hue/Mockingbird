import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git, makeRepo, tempDir } from "./helpers";
import { HELPDESK_CONVERSATION_WHY, HELPDESK_MODE_WHY } from "../src/main/helpdesk";
import { GUARD_OPS, PROMPT_CHANGED, SessionGuards, promptSeen, type GuardOp } from "../src/main/sessionGuards";
import { worktreeState } from "../src/main/worktrees";
import { closeWarningLines } from "../src/shared/closing";
import type { NewSessionRequest, SessionInfo, WorktreeStateInfo } from "../src/shared/types";

/** Every pty the manager starts: what it was asked to run, what was written to it, and whether it was ended. */
type FakePty = { args: string[]; writes: string[]; killed: boolean; exit(code: number): void };
const ptys: FakePty[] = [];
vi.mock("node-pty", () => ({
  spawn: (_file: string, args: string[]) => {
    let onExit: (e: { exitCode: number }) => void = () => {};
    const p: FakePty = { args, writes: [], killed: false, exit: (exitCode) => onExit({ exitCode }) };
    ptys.push(p);
    return {
      onData: () => ({ dispose() {} }),
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

const CHROME_HELP = "Usage: claude [options]\n  --chrome     Enable Claude in Chrome integration\n";
const PERMISSION = "Claude needs your permission to use Bash";

async function manager() {
  const { SessionManager } = await import("../src/main/sessions");
  const saved: SessionInfo[] = [];
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
  m.scrollbackDir = path.join(tempDir("sb"), "scrollback");
  m.readVersionAt = async () => null;
  m.readClaudeHelp = async () => CHROME_HELP;
  return { m, store };
}
const pane = (o: Partial<NewSessionRequest> = {}): NewSessionRequest => ({ repoPath: null, useWorktree: false, agent: "claude", title: "a", ...o });
const helpdesk: Partial<NewSessionRequest> = { title: "Helpdesk tasks", taskGroup: "Helpdesk", role: "tasks" };
const last = () => ptys.at(-1)!.args.join(" ");
/** A team room's launch with its sandbox on, as main's roomLaunch gives it (only the parts a mode is held to). */
const roomLaunch = (agent: "claude" | "codex") => async () => ({
  env: {},
  denyReads: [],
  codexPermissions: agent === "codex" ? ['default_permissions="mockingbird-room"'] : [],
  claudeSettings: agent === "claude" ? { sandbox: { enabled: true, allowUnsandboxedCommands: false } } : null,
  instructions: null,
  allowTools: [],
  inline: false,
  guards: { secrets: true, coauthors: true },
  sandboxMarker: null,
  agentEnv: {},
  codexFolderNotice: false,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a session's permission mode, kept as its model and effort are", () => {
  it("is on its record from the create request, and every relaunch, resume and restart starts it in that mode", async () => {
    const { m, store } = await manager();
    const s = await m.create(pane({ permissionMode: "plan", model: "opus", effort: "high" }));
    expect(last()).toContain("'--permission-mode' 'plan'");
    expect(store.state.sessions.find((x) => x.id === s.id)).toMatchObject({ permissionMode: "plan", model: "opus", effort: "high" });
    await m.restart(s.id);
    expect(last()).toContain("'--permission-mode' 'plan'");
    m.kill(s.id, false);
    await m.relaunch(s.id);
    expect(last()).toContain("'--permission-mode' 'plan'");
    ptys.at(-1)!.exit(1);
    await m.resume(s.id);
    expect(last()).toContain("'--permission-mode' 'plan'");
    expect(m.list().find((x) => x.id === s.id)).toMatchObject({ permissionMode: "plan", model: "opus", effort: "high" });
  });

  it("is nothing on the record or the command line for the default", async () => {
    const { m } = await manager();
    const s = await m.create(pane({ permissionMode: "default" }));
    expect(s.permissionMode).toBeUndefined();
    expect(last()).not.toContain("--permission-mode");
  });

  it("refuses a create request whose mode isn't one, or that the Helpdesk tasks workspace mayn't have, before anything starts", async () => {
    const { m } = await manager();
    const started = ptys.length;
    await expect(m.create(pane({ permissionMode: "yolo" as never }))).rejects.toThrow("“yolo” isn't a permission mode");
    for (const permissionMode of ["acceptEdits", "auto", "bypass"] as const) await expect(m.create(pane({ ...helpdesk, permissionMode }))).rejects.toThrow(HELPDESK_MODE_WHY);
    expect(ptys.length).toBe(started);
    const h = await m.create(pane({ ...helpdesk, permissionMode: "plan" }));
    expect(h.role).toBe("tasks");
    expect(last()).toContain("'--permission-mode' 'plan'");
  });

  it("refuses a mode that would loosen a team room's sandbox, by the launch's own room settings, starting nothing", async () => {
    const { m } = await manager();
    const started = ptys.length;
    m.roomLaunch = roomLaunch("claude");
    for (const permissionMode of ["acceptEdits", "auto", "bypass"] as const) await expect(m.create(pane({ taskGroup: "5101", permissionMode }))).rejects.toThrow(/loosen the team room's sandbox/);
    m.roomLaunch = roomLaunch("codex");
    await expect(m.create(pane({ agent: "codex", taskGroup: "5101", permissionMode: "plan" }))).rejects.toThrow(/would replace the team room's/);
    expect(ptys.length).toBe(started);
    m.roomLaunch = roomLaunch("claude");
    await m.create(pane({ taskGroup: "5101", permissionMode: "plan" }));
    expect(last()).toContain("'--permission-mode' 'plan'");
    expect(last()).toContain("--settings");
  });

  it("refuses it before a worktree is made when the room's switch has its sandbox on", async () => {
    const { m } = await manager();
    const repo = makeRepo();
    m.roomSandboxOff = (g) => (g === "5101" ? false : null);
    await expect(m.create(pane({ repoPath: repo, useWorktree: true, branchName: "mode-x", taskGroup: "5101", permissionMode: "bypass" }))).rejects.toThrow(/loosen the team room's sandbox/);
    expect(git(repo, "branch", "--list", "mode-x")).toBe("");
    expect(git(repo, "worktree", "list")).not.toContain("mode-x");
  });
});

describe("restarting with changes (relaunchWith)", () => {
  it("resumes its conversation in the new mode, model and effort, which are then its record's; a null model goes back to the default", async () => {
    const { m, store } = await manager();
    const s = await m.create(pane({ model: "sonnet", effort: "low" }));
    const before = ptys.at(-1)!;
    const info = await m.relaunchWith(s.id, { permissionMode: "acceptEdits", effort: "max" });
    expect(before.killed).toBe(true);
    expect(info).toMatchObject({ id: s.id, permissionMode: "acceptEdits", model: "sonnet", effort: "max" });
    expect(last()).toContain("'--permission-mode' 'acceptEdits'");
    expect(last()).toContain("'--effort' 'max'");
    await m.relaunchWith(s.id, { model: null, permissionMode: "default" });
    expect(last()).not.toContain("--model");
    expect(last()).not.toContain("--permission-mode");
    expect(store.state.sessions.find((x) => x.id === s.id)).toMatchObject({ effort: "max" });
    expect(store.state.sessions.find((x) => x.id === s.id)?.model).toBeUndefined();
    // Codex: its reasoning effort, by the same name
    const c = await m.create(pane({ agent: "codex" }));
    await m.relaunchWith(c.id, { effort: "xhigh", permissionMode: "plan" });
    expect(last()).toContain(`'-c' 'model_reasoning_effort="xhigh"'`);
    expect(last()).toContain("'-s' 'read-only'");
  });

  it("refuses what isn't valid for its agent, saying why, with nothing stopped", async () => {
    const { m } = await manager();
    const s = await m.create(pane());
    const c = await m.create(pane({ agent: "codex" }));
    const t = await m.create(pane({ shell: true, agent: undefined }));
    const running = ptys.length;
    await expect(m.relaunchWith(s.id, { permissionMode: "bypassPermissions" })).rejects.toThrow(/isn't a permission mode/);
    await expect(m.relaunchWith(s.id, { model: "opus --dangerously-skip-permissions" })).rejects.toThrow(/A model is a name/);
    await expect(m.relaunchWith(s.id, { effort: "minimal" })).rejects.toThrow(/An effort is one of/);
    await expect(m.relaunchWith(s.id, "plan")).rejects.toThrow(/a permission mode, a model and an effort/);
    await expect(m.relaunchWith(c.id, { effort: "max" })).rejects.toThrow("Codex has no max reasoning effort");
    await expect(m.relaunchWith(t.id, { permissionMode: "plan" })).rejects.toThrow(/It's a terminal/);
    expect(ptys.length).toBe(running);
    expect(ptys.slice(-3).map((p) => p.killed)).toEqual([false, false, false]);
  });

  it("goes through restart's own checks: a teammate's session, one a teammate continues, one being reopened, one not open here", async () => {
    const { m } = await manager();
    const s = await m.create(pane());
    const p = ptys.at(-1)!;
    await expect(m.relaunchWith("r~nick~s1", { permissionMode: "plan" })).rejects.toThrow("That's a teammate's session: only its owner can restart it");
    m.relaunchGuard = (id) => (id === s.id ? "“a” continues on Nick's laptop — take it back rather than running this copy again" : null);
    await expect(m.relaunchWith(s.id, { permissionMode: "plan" })).rejects.toThrow(/continues on Nick's laptop/);
    expect(p.killed).toBe(false);
    m.relaunchGuard = null;
    m.kill(s.id, false);
    await expect(m.relaunchWith(s.id, { permissionMode: "plan" })).rejects.toThrow(/It isn't open here/);
    const reopening = m.relaunch(s.id);
    await expect(m.relaunchWith(s.id, {})).rejects.toThrow("It's being reopened already");
    await reopening;
  });

  it("refuses a wider mode for the Helpdesk tasks workspace, and one a room's sandbox wouldn't take, as it runs or at its next launch", async () => {
    const { m } = await manager();
    const h = await m.create(pane(helpdesk));
    await expect(m.relaunchWith(h.id, { permissionMode: "auto" })).rejects.toThrow(HELPDESK_MODE_WHY);
    m.roomLaunch = roomLaunch("claude");
    const r = await m.create(pane({ taskGroup: "5101" }));
    const p = ptys.at(-1)!;
    await expect(m.relaunchWith(r.id, { permissionMode: "bypass" })).rejects.toThrow(/loosen the team room's sandbox/);
    expect(p.killed).toBe(false);
    // started outside the room's sandbox, but the room's switch has it on for its next launch
    m.roomLaunch = null;
    const o = await m.create(pane({ taskGroup: "5102" }));
    m.roomSandboxOff = (g) => (g === "5102" ? false : null);
    await expect(m.relaunchWith(o.id, { permissionMode: "auto" })).rejects.toThrow(/loosen the team room's sandbox/);
    expect(await m.relaunchWith(o.id, { permissionMode: "plan" })).toMatchObject({ permissionMode: "plan" });
  });

  it("leaves a session whose launch was refused once stopped closed, with the mode it had", async () => {
    const { m, store } = await manager();
    const s = await m.create(pane({ taskGroup: "5101", permissionMode: "plan" }));
    // the room's sandbox comes on only as the launch is prepared: the pre-check couldn't know
    m.roomLaunch = roomLaunch("claude");
    await expect(m.relaunchWith(s.id, { permissionMode: "auto" })).rejects.toThrow(/loosen the team room's sandbox/);
    expect(m.list().some((x) => x.id === s.id)).toBe(false);
    expect(store.state.sessions.find((x) => x.id === s.id)).toMatchObject({ permissionMode: "plan" });
  });

  it("is described for a card: why it's blocked, and what to know first", async () => {
    const { m } = await manager();
    const s = await m.create(pane());
    expect(m.describeRelaunch(s.id, { permissionMode: "plan" })).toEqual({ blocked: null, warnings: ["It's mid-turn: restarting stops the turn it's on"] });
    m.statusFromHook({ paneId: s.id, status: "waiting", reason: PERMISSION });
    expect(m.describeRelaunch(s.id, { permissionMode: "bypass" })).toEqual({
      blocked: null,
      warnings: ["It's waiting on you: restarting drops the prompt it's showing", "Bypass permissions: it runs every tool without asking you first"],
    });
    m.statusFromHook({ paneId: s.id, status: "idle" });
    expect(m.describeRelaunch(s.id, {})).toEqual({ blocked: null, warnings: [] });
    expect(m.describeRelaunch(s.id, { effort: "huge" }).blocked).toMatch(/An effort is one of/);
    expect(m.describeRelaunch("gone", {}).blocked).toMatch(/It isn't open here/);
    const c = await m.create(pane({ agent: "codex" }));
    m.statusFromHook({ paneId: c.id, status: "idle" });
    expect(m.describeRelaunch(c.id, { permissionMode: "auto" }).warnings).toEqual(["Auto: Codex's automatic review answers its approval requests, not you"]);
    // a mode it already runs in is still said
    const w = await m.create(pane({ permissionMode: "acceptEdits" }));
    m.statusFromHook({ paneId: w.id, status: "idle" });
    expect(m.describeRelaunch(w.id, { model: "opus" }).warnings).toEqual(["Accept edits: it changes files without asking you first"]);
  });
});

describe("what main lets be done to a session on someone's behalf (whyNot)", () => {
  async function world() {
    const t = await manager();
    const { m } = t;
    const s = await m.create(pane({ title: "work" }));
    const h = await m.create(pane(helpdesk));
    const term = await m.create(pane({ shell: true, agent: undefined, title: "term" }));
    const closed = await m.create(pane({ title: "closed" }));
    m.kill(closed.id, false);
    const exited = await m.create(pane({ title: "exited" }));
    ptys.at(-1)!.exit(1);
    const taken = await m.create(pane({ title: "taken" }));
    const step = m.plan({ after: s.id, title: "step", agent: "claude", repoPath: null, worktree: false, taskGroup: null });
    m.relaunchGuard = (id) => (id === taken.id ? "“taken” continues on Nick's laptop — take it back rather than running this copy again" : null);
    const guards = new SessionGuards({
      sessions: m,
      takenOver: () => (id, doing) => (id === taken.id ? `“taken” continues on Nick's laptop — take it back rather than ${doing}` : null),
      worktreeState,
    });
    return { ...t, guards, ids: { s: s.id, h: h.id, term: term.id, closed: closed.id, exited: exited.id, taken: taken.id, step: step.id } };
  }

  it("answers each op for each kind of session, by main's own checks", async () => {
    const { guards, ids } = await world();
    const matrix = (id: string) => Object.fromEntries(GUARD_OPS.map((op) => [op, guards.whyNot(op, id)]));
    expect(matrix(ids.s)).toEqual({ relaunch: null, kill: null, resume: "It's running already", write: null, broadcast: null, readOutput: null, rename: null, group: null, mute: null, focus: null });
    // the Helpdesk: its lifecycle, name, place, notifications and focus, never its conversation
    expect(matrix(ids.h)).toEqual({ relaunch: null, kill: null, resume: "It's running already", write: HELPDESK_CONVERSATION_WHY, broadcast: HELPDESK_CONVERSATION_WHY, readOutput: HELPDESK_CONVERSATION_WHY, rename: null, group: null, mute: null, focus: null });
    expect(guards.whyNot("write", ids.term)).toBe("It's a terminal: what's typed into it runs as commands");
    expect(guards.whyNot("broadcast", ids.term)).toBe("It's a terminal: what's typed into it runs as commands");
    expect(guards.whyNot("relaunch", ids.closed)).toBeNull();
    expect(guards.whyNot("write", ids.closed)).toBe("It isn't running");
    expect(guards.whyNot("mute", ids.closed)).toBe("It isn't open here");
    expect(guards.whyNot("readOutput", ids.closed)).toBeNull();
    expect(guards.whyNot("resume", ids.exited)).toBeNull();
    expect(guards.whyNot("write", ids.exited)).toBe("It isn't running");
    expect(guards.whyNot("readOutput", ids.step)).toBe("It hasn't started, so it has no output");
    expect(guards.whyNot("relaunch", ids.step)).toMatch(/hasn't started yet/);
    expect(guards.whyNot("rename", ids.step)).toBeNull();
  });

  it("refuses every op on a teammate's session, and on one this Mac doesn't have", async () => {
    const { guards } = await world();
    for (const op of GUARD_OPS) {
      expect(guards.whyNot(op, "r~nick~s1"), op).toMatch(/^That's a teammate's session: only its owner can /);
      expect(guards.whyNot(op, "nope"), op).toBe("There's no such session on this Mac");
    }
    expect(guards.whyNot("bogus" as GuardOp, "nope")).toBe("“bogus” isn't something done to a session");
  });

  it("refuses running or typing into a copy a teammate took over; closing, naming and reading it are this Mac's", async () => {
    const { guards, ids } = await world();
    expect(guards.whyNot("relaunch", ids.taken)).toMatch(/continues on Nick's laptop — take it back rather than running this copy again/);
    expect(guards.whyNot("write", ids.taken)).toMatch(/take it back rather than typing into this copy/);
    expect(guards.whyNot("broadcast", ids.taken)).toMatch(/take it back rather than sending this copy a broadcast/);
    for (const op of ["kill", "rename", "group", "mute", "focus", "readOutput"] as const) expect(guards.whyNot(op, ids.taken), op).toBeNull();
  });
});

describe("what closing a session can lose (closeWarnings)", () => {
  const state = (o: Partial<WorktreeStateInfo>): WorktreeStateInfo => ({ dirty: false, dirtyFiles: 0, branch: "b", upstream: "origin/b", ahead: 0, behind: 0, insertions: 0, deletions: 0, ...o });

  it("counts its own worktree's uncommitted files and unpushed commits, and whether it's mid-turn", async () => {
    const { m } = await manager();
    const repo = makeRepo();
    const s = await m.create(pane({ repoPath: repo, useWorktree: true, branchName: "close-me" }));
    const guards = new SessionGuards({ sessions: m, takenOver: () => null, worktreeState });
    expect(await guards.closeWarnings(s.id)).toEqual({ uncommitted: 0, unpushed: 0, busy: true, unread: null });
    fs.writeFileSync(path.join(s.cwd, "new.txt"), "x");
    fs.writeFileSync(path.join(s.cwd, "README.md"), "changed");
    m.statusFromHook({ paneId: s.id, status: "idle" });
    const { forgetState } = await import("../src/main/worktrees");
    forgetState(s.cwd);
    expect(await guards.closeWarnings(s.id)).toEqual({ uncommitted: 2, unpushed: 0, busy: false, unread: null });
    // a worktree that's gone holds nothing to lose, as Close session finds it
    git(repo, "worktree", "remove", "--force", s.cwd);
    forgetState(s.cwd);
    expect(await guards.closeWarnings(s.id)).toEqual({ uncommitted: 0, unpushed: 0, busy: false, unread: null });
  });

  it("asks about nothing in a repository's checkout or outside one; a state it can't read is said, not taken as nothing", async () => {
    const { m } = await manager();
    const repo = makeRepo();
    const checkout = await m.create(pane({ repoPath: repo, useWorktree: false }));
    const plain = await m.create(pane());
    const wt = await m.create(pane({ repoPath: repo, useWorktree: true, branchName: "ahead" }));
    const reads: string[] = [];
    let next: () => Promise<WorktreeStateInfo> = async () => state({ dirty: true, dirtyFiles: 0, ahead: 3 });
    const guards = new SessionGuards({ sessions: m, takenOver: () => null, worktreeState: (f) => (reads.push(f), next()) });
    expect((await guards.closeWarnings(checkout.id)).uncommitted).toBe(0);
    expect((await guards.closeWarnings(plain.id)).uncommitted).toBe(0);
    expect(reads).toEqual([]);
    // dirty with no count still has something to lose
    expect(await guards.closeWarnings(wt.id)).toMatchObject({ uncommitted: 1, unpushed: 3 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    next = async () => {
      throw new Error("git status: fatal: Unable to create '/r/.git/index.lock': File exists.");
    };
    const w = await guards.closeWarnings(wt.id);
    expect(w).toMatchObject({ uncommitted: 0, unpushed: 0, unread: "git status: fatal: Unable to create '/r/.git/index.lock': File exists." });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("its worktree's state couldn't be read"));
    expect(closeWarningLines(w)).toEqual(["It's mid-turn: closing stops it", "Its worktree's changes couldn't be read (git status: fatal: Unable to create '/r/.git/index.lock': File exists.), so it may hold work"]);
    expect(closeWarningLines({ uncommitted: 1, unpushed: 2, busy: false, unread: null })).toEqual(["1 file has uncommitted changes", "2 commits aren't pushed"]);
    await expect(guards.closeWarnings("nope")).rejects.toThrow("There's no such session on this Mac");
  });
});

describe("answering a permission prompt once (answerPrompt)", () => {
  async function waiting() {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = await manager();
    const s = await t.m.create(pane());
    t.m.statusFromHook({ paneId: s.id, status: "waiting", reason: PERMISSION });
    const guards = new SessionGuards({ sessions: t.m, takenOver: () => null, worktreeState });
    const seen = promptSeen(t.m.list().find((x) => x.id === s.id)!);
    return { ...t, s, guards, seen, p: ptys.at(-1)! };
  }

  it("types the agent's allow-once or deny key while it's the prompt the answer was offered for", async () => {
    const { guards, s, seen, p } = await waiting();
    expect(guards.answerPrompt(s.id, "allow", seen)).toEqual({ answered: "allow once" });
    expect(p.writes.at(-1)).toBe("1");
    const c = await waiting();
    const codex = await c.m.create(pane({ agent: "codex" }));
    c.m.statusFromHook({ paneId: codex.id, status: "waiting", reason: "Codex needs your permission to use exec_command" });
    expect(c.guards.answerPrompt(codex.id, "deny", promptSeen(c.m.list().find((x) => x.id === codex.id)!))).toEqual({ answered: "deny" });
    expect(ptys.at(-1)!.writes.at(-1)).toBe("\x1b");
  });

  it("refuses, typing nothing, once the prompt changed: answered, another one come up, or a second worded alike", async () => {
    const { m, guards, s, seen, p } = await waiting();
    const typed = p.writes.length;
    vi.setSystemTime(Date.now() + 5_000);
    m.statusFromHook({ paneId: s.id, status: "waiting", reason: PERMISSION }); // a second prompt, worded alike
    expect(guards.answerPrompt(s.id, "allow", seen)).toEqual({ refused: PROMPT_CHANGED });
    // held to when it began and what it says even when no later prompt is named
    expect(guards.answerPrompt(s.id, "allow", { waitingSince: seen.waitingSince, reason: "Claude needs your permission to use Read" })).toEqual({ refused: PROMPT_CHANGED });
    expect(guards.answerPrompt(s.id, "allow", { waitingSince: seen.waitingSince! - 1, reason: PERMISSION })).toEqual({ refused: PROMPT_CHANGED });
    m.statusFromHook({ paneId: s.id, status: "working" });
    expect(guards.answerPrompt(s.id, "allow", seen)).toEqual({ refused: PROMPT_CHANGED });
    m.statusFromHook({ paneId: s.id, status: "waiting", reason: "Claude needs your permission to use Write" });
    expect(guards.answerPrompt(s.id, "deny", seen)).toEqual({ refused: PROMPT_CHANGED });
    expect(p.writes.length).toBe(typed);
  });

  it("refuses a question, a teammate's session, the Helpdesk, a terminal, and a prompt that isn't named", async () => {
    const { m, guards } = await waiting();
    const q = await m.create(pane());
    m.statusFromHook({ paneId: q.id, status: "waiting", reason: "Claude has a question" });
    expect(guards.answerPrompt(q.id, "allow", promptSeen(m.list().find((x) => x.id === q.id)!))).toEqual({ refused: "It's asking a question, not for permission: answer it in its pane" });
    const h = await m.create(pane(helpdesk));
    m.statusFromHook({ paneId: h.id, status: "waiting", reason: PERMISSION });
    const hp = ptys.at(-1)!;
    expect(guards.answerPrompt(h.id, "allow", promptSeen(m.list().find((x) => x.id === h.id)!))).toEqual({ refused: HELPDESK_CONVERSATION_WHY });
    expect(hp.writes).toEqual([]);
    expect(guards.answerPrompt("r~nick~s1", "allow", { waitingSince: 1, reason: PERMISSION })).toEqual({ refused: "That's a teammate's session: only its owner can type into it" });
    expect(guards.answerPrompt(q.id, "always" as never, { waitingSince: 1, reason: PERMISSION })).toEqual({ refused: "“always” isn't an answer: allow or deny" });
    expect(guards.answerPrompt(q.id, "allow", null as never)).toEqual({ refused: "No prompt was named to answer" });
  });
});

describe("a broadcast from the Assistant", () => {
  it("skips the Helpdesk tasks workspace when asked; the user's own broadcast is as it was", async () => {
    const { m } = await manager();
    const s = await m.create(pane());
    const h = await m.create(pane(helpdesk));
    for (const id of [s.id, h.id]) m.statusFromHook({ paneId: id, status: "idle" });
    expect(m.broadcast("run the tests", [s.id, h.id], true, { skipHelpdesk: true })).toEqual([
      { id: s.id, outcome: "delivered" },
      { id: h.id, outcome: "skipped" },
    ]);
    expect(m.broadcast("run the tests", [s.id, h.id], true).map((o) => o.outcome === "skipped")).toEqual([false, false]);
  });
});

// the Helpdesk folder the tasks workspace makes is the file's own HOME's
afterEach(() => void fs.rmSync(path.join(os.homedir(), "Helpdesk"), { recursive: true, force: true }));
