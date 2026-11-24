import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers";
import { readLaunchModels, type LaunchModels, type ModelReport } from "../src/main/agentModels";
import { LandscapeStore } from "../src/main/landscape";
import { WireService } from "../src/main/wires";
import { PipelineEdits, modelRefusal } from "../src/main/pipelineEdit";
import { sameModelLine } from "../src/main/sessions";
import type { ModelCatalog, NewSessionRequest, SessionInfo } from "../src/shared/types";
import type { WireReply } from "../src/shared/wires";

// Editing a pipeline once it's laid out: a not-started step's spec, any session's model (and one typed with /model
// sticking), and a step inserted between two — with the real SessionManager over fake ptys, and the real wire book.

type FakePty = { args: string[]; killed: boolean; exit(code: number): void };
const ptys: FakePty[] = [];
vi.mock("node-pty", () => ({
  spawn: (_file: string, args: string[]) => {
    let onExit: (e: { exitCode: number }) => void = () => {};
    const p: FakePty = { args, killed: false, exit: (exitCode) => onExit({ exitCode }) };
    ptys.push(p);
    return {
      onData: () => ({ dispose() {} }),
      onExit: (cb: any) => ((onExit = cb), { dispose() {} }),
      write: () => {},
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

const CATALOG: ModelCatalog = {
  claude: { models: [{ id: "opus", label: "Opus (latest)" }, { id: "sonnet", label: "Sonnet (latest)" }, { id: "claude-opus-4-7[1m]", label: "Opus 4.7 · 1M context" }], efforts: ["low", "medium", "high", "xhigh", "max"] },
  codex: { models: [{ id: "gpt-5.1-codex", label: "GPT-5.1 Codex" }], efforts: ["low", "medium", "high", "xhigh"] },
};

async function setup(opts: { catalog?: ModelCatalog | null; whileReadingCatalog?: () => Promise<void> } = {}) {
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
  m.readClaudeHelp = async () => "Usage: claude [options]\n";
  const logged: string[] = [];
  const log = (context: string, err: unknown) => void logged.push(`${context}: ${err instanceof Error ? err.message : String(err)}`);
  const landscape = new LandscapeStore({ file: path.join(tempDir("ls"), "landscape.json"), emit: () => {}, log });
  const wires = new WireService({ store: landscape, sessions: m, roomOf: () => null, takenOver: () => null, log });
  const forgot: string[] = [];
  const edits = new PipelineEdits({
    sessions: m,
    wires,
    forget: (id) => {
      forgot.push(id);
      m.kill(id, true);
      wires.sessionForgotten(id);
    },
    catalog: async () => {
      await opts.whileReadingCatalog?.();
      return opts.catalog === undefined ? CATALOG : opts.catalog;
    },
    log,
  });
  return { m, store, wires, edits, logged, forgot };
}
const pane = (o: Partial<NewSessionRequest> = {}): NewSessionRequest => ({ repoPath: null, useWorktree: false, agent: "claude", title: "a", ...o });
const step = (m: Awaited<ReturnType<typeof setup>>["m"], title: string, o: Record<string, unknown> = {}) => m.planStep({ title, agent: "claude", repoPath: null, worktree: false, taskGroup: "5200", ...o });
const last = () => ptys.at(-1)!.args.join(" ");
/** What an agent reported running in a launch: its latest report at `at`, its first when known, and the earliest read. */
const reported = (latest: ModelReport, at: number, first: ModelReport | null = null, earliest: ModelReport = first ?? latest): LaunchModels => ({ first, earliest, last: latest, at });
const made = (r: WireReply) => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.id!;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("editing a not-started step", () => {
  it("changes its title, agent, model, effort, permission mode and prompt, saved in its record, which its start runs", async () => {
    const { m, store, edits } = await setup();
    const s = step(m, "Coder", { prompt: "build it" });
    const info = await edits.editStep(s.id, { title: "  Coder   two ", model: "sonnet", effort: "high", permissionMode: "plan", prompt: "build the other thing" });
    expect(info).toMatchObject({ title: "Coder two", model: "sonnet", effort: "high", permissionMode: "plan", planned: { prompt: "build the other thing" } });
    expect(store.state.sessions.find((x) => x.id === s.id)).toMatchObject({ title: "Coder two", model: "sonnet", planned: { prompt: "build the other thing" } });
    // null and empty go back to the defaults
    const back = await edits.editStep(s.id, { model: null, effort: "", permissionMode: null, prompt: "" });
    expect(back.model).toBeUndefined();
    expect(back.effort).toBeUndefined();
    expect(back.permissionMode).toBeUndefined();
    expect(back.planned!.prompt).toBeUndefined();
    await edits.editStep(s.id, { agent: "codex", model: "gpt-5.1-codex", effort: "xhigh" });
    await m.startPlanned(s.id);
    expect(last()).toContain("'--model' 'gpt-5.1-codex'");
    expect(last()).toContain(`model_reasoning_effort="xhigh"`);
  });

  it("refuses an unknown model, agent or effort, and a model the new agent doesn't offer, changing nothing", async () => {
    const { m, store, edits } = await setup();
    const s = step(m, "Coder", { model: "opus" });
    const before = JSON.stringify(store.state.sessions);
    await expect(edits.editStep(s.id, { model: "gpt-9" })).rejects.toThrow("Claude on this Mac doesn't offer “gpt-9”");
    await expect(edits.editStep(s.id, { model: "opus --yolo" })).rejects.toThrow(/A model is a name/);
    await expect(edits.editStep(s.id, { agent: "gemini" })).rejects.toThrow(/There's no agent "gemini"/);
    await expect(edits.editStep(s.id, { effort: "extreme" })).rejects.toThrow(/An effort is one of/);
    await expect(edits.editStep(s.id, { agent: "codex" })).rejects.toThrow(/doesn't offer “opus”.*say its model for Codex, or null/);
    await expect(edits.editStep(s.id, { colour: "red" })).rejects.toThrow(/has no "colour" to edit/);
    await expect(edits.editStep(s.id, { title: "  " })).rejects.toThrow("Name the step");
    expect(JSON.stringify(store.state.sessions)).toBe(before);
    // a model named while the catalog can't be read is refused, not guessed at
    const blind = await setup({ catalog: null });
    const t = step(blind.m, "Coder");
    await expect(blind.edits.editStep(t.id, { model: "opus" })).rejects.toThrow(/can't be read now/);
    expect(await blind.edits.editStep(t.id, { title: "Renamed" })).toMatchObject({ title: "Renamed" });
  });

  it("refuses one that has started, and a mode its room's sandbox wouldn't take", async () => {
    const { m, edits } = await setup();
    const s = await m.create(pane());
    await expect(edits.editStep(s.id, { title: "x" })).rejects.toThrow(/It has started/);
    const t = step(m, "In a room");
    m.roomSandboxOff = (g) => (g === "5200" ? false : null);
    await expect(edits.editStep(t.id, { permissionMode: "bypass" })).rejects.toThrow(/loosen the team room's sandbox/);
  });
});

describe("a session's model (setModel)", () => {
  it("restarts an open pane in place with it, its id kept", async () => {
    const { m, edits } = await setup();
    const s = await m.create(pane({ model: "opus" }));
    const was = ptys.at(-1)!;
    const r = await edits.setModel(s.id, { model: "sonnet", effort: "max" });
    expect(r.did).toBe("restarted");
    expect(r.info.id).toBe(s.id);
    expect(was.killed).toBe(true);
    expect(last()).toContain("'--model' 'sonnet'");
    expect(last()).toContain("'--effort' 'max'");
  });

  it("edits a not-started step's spec, and stores it on a closed one's record for its Reopen", async () => {
    const { m, edits } = await setup();
    const s = step(m, "Coder");
    const started = ptys.length;
    expect(await edits.setModel(s.id, { model: "opus" })).toMatchObject({ did: "edited", info: { model: "opus" } });
    expect(ptys.length).toBe(started);
    const c = await m.create(pane({ model: "opus" }));
    m.kill(c.id, false);
    expect(await edits.setModel(c.id, { model: "sonnet" })).toMatchObject({ did: "stored", info: { model: "sonnet" } });
    await m.relaunch(c.id);
    expect(last()).toContain("'--model' 'sonnet'");
  });

  it("refuses a model its agent doesn't offer, a terminal, and a session this Mac doesn't have, before anything stops", async () => {
    const { m, edits } = await setup();
    const s = await m.create(pane({ model: "opus" }));
    const t = await m.create(pane({ shell: true, agent: undefined }));
    await expect(edits.setModel(s.id, { model: "gpt-5.1-codex" })).rejects.toThrow(/doesn't offer/);
    await expect(edits.setModel(t.id, { model: "opus" })).rejects.toThrow(/is a terminal/);
    await expect(edits.setModel("nope", { model: "opus" })).rejects.toThrow(/no session "nope"/);
    await expect(edits.setModel(s.id, {})).rejects.toThrow(/Say the model, the effort or both/);
    expect(ptys.slice(-2).map((p) => p.killed)).toEqual([false, false]);
  });

  it("with restart off, refuses an open pane, one reopened while the catalog is read included, and stops nothing", async () => {
    const { m, edits } = await setup();
    const s = await m.create(pane({ model: "opus" }));
    await expect(edits.setModel(s.id, { model: "sonnet" }, { restart: false })).rejects.toThrow(/is running: changing its model restarts it/);
    expect(ptys.at(-1)!.killed).toBe(false);
    let reopen: (() => Promise<void>) | undefined;
    const late = await setup({ whileReadingCatalog: () => reopen?.() ?? Promise.resolve() });
    const c = await late.m.create(pane({ model: "opus" }));
    late.m.kill(c.id, false);
    reopen = async () => {
      reopen = undefined;
      await late.m.relaunch(c.id);
    };
    await expect(late.edits.setModel(c.id, { model: "sonnet" }, { restart: false })).rejects.toThrow(/is running/);
    expect(ptys.at(-1)!.killed).toBe(false);
    expect(late.m.list().find((x) => x.id === c.id)?.model ?? null).not.toBe("sonnet");
  });
});

describe("a model that sticks", () => {
  it("keeps a restart with changes' model for a plain restart, a Reopen and a Resume after it", async () => {
    const { m } = await setup();
    const s = await m.create(pane({ model: "opus" }));
    await m.relaunchWith(s.id, { model: "sonnet" });
    await m.restart(s.id);
    expect(last()).toContain("'--model' 'sonnet'");
    m.kill(s.id, false);
    await m.relaunch(s.id);
    expect(last()).toContain("'--model' 'sonnet'");
    ptys.at(-1)!.exit(1);
    await m.resume(s.id);
    expect(last()).toContain("'--model' 'sonnet'");
  });

  it("records a /model its agent reports running for the next launch: against its record's model, or with none against its launch's first report", async () => {
    const { m, store } = await setup();
    const s = await m.create(pane({ model: "opus" }));
    const at = s.createdAt + 1;
    // the alias's own model is no change, and an older run's report says nothing
    expect(m.noteReportedModel(s.id, reported({ model: "claude-opus-4-7" }, at))).toBe(false);
    expect(m.noteReportedModel(s.id, reported({ model: "claude-sonnet-4-5" }, s.createdAt - 1))).toBe(false);
    expect(m.noteReportedModel(s.id, reported({ model: "claude-sonnet-4-5" }, at))).toBe(true);
    expect(store.state.sessions.find((x) => x.id === s.id)?.model).toBe("claude-sonnet-4-5");
    await m.restart(s.id);
    expect(last()).toContain("'--model' 'claude-sonnet-4-5'");
    // with none of its own: nothing to tell a /model by until its launch's first report is known
    const d = await m.create(pane());
    expect(m.noteReportedModel(d.id, reported({ model: "claude-haiku-4-5" }, d.createdAt))).toBe(false);
    expect(m.noteReportedModel(d.id, reported({ model: "claude-opus-4-7[1m]" }, d.createdAt + 1, { model: "claude-opus-4-7" }))).toBe(false);
    expect(m.list().find((x) => x.id === d.id)?.model).toBeUndefined();
    expect(m.noteReportedModel(d.id, reported({ model: "claude-haiku-4-5" }, d.createdAt + 5))).toBe(true);
    expect(m.list().find((x) => x.id === d.id)?.model).toBe("claude-haiku-4-5");
  });

  it("reads what a pane's agent runs at each turn's end, its launch's first report once, and takes the model a starting Claude names as that first", async () => {
    const { m } = await setup();
    const modelOf = (id: string) => m.list().find((x) => x.id === id)?.model;
    const asked: boolean[] = [];
    let report: LaunchModels | null = null;
    m.launchModels = (_s, o) => (asked.push(o.first), report);
    const d = await m.create(pane());
    const finish = (id: string, conv: string) => m.statusFromHook({ paneId: id, conversationId: conv, agent: "claude", status: "idle", finished: true });
    m.statusFromHook({ paneId: d.id, conversationId: "conv-d", agent: "claude", status: "idle", started: true });
    report = reported({ model: "claude-opus-4-7" }, d.createdAt + 1, { model: "claude-opus-4-7" });
    finish(d.id, "conv-d");
    report = reported({ model: "claude-haiku-4-5" }, d.createdAt + 9);
    expect(modelOf(d.id)).toBeUndefined();
    finish(d.id, "conv-d");
    expect(asked).toEqual([true, false]);
    expect(modelOf(d.id)).toBe("claude-haiku-4-5");
    // a /model typed before its first reply: its first reply is already the new model, its start named the default
    const s = await m.create(pane());
    m.statusFromHook({ paneId: s.id, conversationId: "conv-s", agent: "claude", status: "idle", started: true, model: "claude-opus-4-7", at: Math.floor(Date.now() / 1000) });
    asked.length = 0;
    report = reported({ model: "claude-sonnet-4-5" }, s.createdAt + 5, { model: "claude-sonnet-4-5" });
    finish(s.id, "conv-s");
    expect(asked).toEqual([false]);
    expect(modelOf(s.id)).toBe("claude-sonnet-4-5");
    // what fails to read is logged, and the record kept as it was
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.launchModels = () => {
      throw new Error("EACCES: the transcript");
    };
    finish(s.id, "conv-s");
    expect(String(warn.mock.calls[0][0])).toContain(`${s.id}: couldn't read which model its agent reports running`);
    expect(modelOf(s.id)).toBe("claude-sonnet-4-5");
  });

  it("reopens a closed session with what its agent last reported running when its record's line differs", async () => {
    const { m } = await setup();
    const s = await m.create(pane({ model: "opus" }));
    m.kill(s.id, false);
    let report: LaunchModels | null = reported({ model: "claude-sonnet-4-5" }, s.createdAt + 10);
    m.launchModels = () => report;
    await m.relaunch(s.id);
    expect(last()).toContain("'--model' 'claude-sonnet-4-5'");
    // one from before its last launch is an older run's
    const t = await m.create(pane({ model: "opus" }));
    m.kill(t.id, false);
    report = reported({ model: "claude-sonnet-4-5" }, t.createdAt - 10);
    await m.relaunch(t.id);
    expect(last()).toContain("'--model' 'opus'");
  });

  it("reopens a record with no model or effort of its own with what its agent ran last when that's not what its launch first ran", async () => {
    const { m } = await setup();
    let report: LaunchModels | null = null;
    m.launchModels = () => report;
    const reopen = async (o: Partial<NewSessionRequest>, r: (createdAt: number) => LaunchModels) => {
      const x = await m.create(pane(o));
      m.kill(x.id, false);
      report = r(x.createdAt);
      await m.relaunch(x.id);
      return last();
    };
    // Claude: a model typed in, its default's own line, and a first report that's out of reach
    expect(await reopen({}, (t) => reported({ model: "claude-sonnet-4-5" }, t + 9, { model: "claude-opus-4-7" }))).toContain("'--model' 'claude-sonnet-4-5'");
    expect(await reopen({}, (t) => reported({ model: "claude-opus-4-7[1m]" }, t + 9, { model: "claude-opus-4-7" }))).not.toContain("--model");
    expect(await reopen({}, (t) => reported({ model: "claude-sonnet-4-5" }, t + 9, null))).not.toContain("--model");
    // Codex: its reasoning effort alone, its model alone, and an effort a launch can't be given
    const codex = { agent: "codex" as const };
    const effort = await reopen(codex, (t) => reported({ model: "gpt-5.1-codex", effort: "high" }, t + 9, { model: "gpt-5.1-codex", effort: "medium" }));
    expect(effort).toContain('model_reasoning_effort="high"');
    expect(effort).not.toContain("--model");
    const model = await reopen(codex, (t) => reported({ model: "gpt-5.2-codex", effort: "medium" }, t + 9, { model: "gpt-5.1-codex", effort: "medium" }));
    expect(model).toContain("'--model' 'gpt-5.2-codex'");
    expect(model).not.toContain("model_reasoning_effort");
    expect(await reopen(codex, (t) => reported({ model: "gpt-5.1-codex", effort: "minimal" }, t + 9, { model: "gpt-5.1-codex", effort: "medium" }))).not.toContain("model_reasoning_effort");
  });

  it("reads a closed record's files further back for its launch's first report only when what's within reach shows a change", async () => {
    const { m } = await setup();
    const asked: boolean[] = [];
    let near: LaunchModels | null = null;
    let far: LaunchModels | null = null;
    m.launchModels = (_s, o) => (asked.push(o.first), o.first ? far : near);
    const closed = async () => {
      const x = await m.create(pane());
      m.kill(x.id, false);
      asked.length = 0;
      return x;
    };
    // no change within reach: a /model from before it was followed by a turn's end, which kept it
    let x = await closed();
    near = reported({ model: "claude-opus-4-7" }, x.createdAt + 9, null, { model: "claude-opus-4-7" });
    await m.relaunch(x.id);
    expect(asked).toEqual([false]);
    expect(last()).not.toContain("--model");
    // one shown: its launch's first decides
    x = await closed();
    near = reported({ model: "claude-sonnet-4-5" }, x.createdAt + 9, null, { model: "claude-opus-4-7" });
    far = reported({ model: "claude-sonnet-4-5" }, x.createdAt + 9, { model: "claude-opus-4-7" });
    await m.relaunch(x.id);
    expect(asked).toEqual([false, true]);
    expect(last()).toContain("'--model' 'claude-sonnet-4-5'");
    // it started on that model, and switched away and back: no change
    x = await closed();
    near = reported({ model: "claude-sonnet-4-5" }, x.createdAt + 9, null, { model: "claude-opus-4-7" });
    far = reported({ model: "claude-sonnet-4-5" }, x.createdAt + 9, { model: "claude-sonnet-4-5" });
    await m.relaunch(x.id);
    expect(asked).toEqual([false, true]);
    expect(last()).not.toContain("--model");
  });

  it("keeps a Codex session's /model and reasoning effort, read from its rollout, for its next launch: at a turn's end, or as it reopens", async () => {
    const { m, store } = await setup();
    m.launchModels = (s, o) => readLaunchModels(s, o);
    const turn = (at: number, model: string, effort: string) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: "turn_context", payload: { cwd: "/w", model, effort } });
    const rollout = (id: string, lines: string[]) => {
      const dir = path.join(os.homedir(), ".codex", "sessions", "2026", "10", "12");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `rollout-2026-10-12T09-00-00-${id}.jsonl`);
      fs.writeFileSync(file, lines.join("\n") + "\n");
      return file;
    };
    const s = await m.create(pane({ agent: "codex", model: "gpt-5.1-codex", effort: "medium" }));
    const sId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    const file = rollout(sId, [turn(s.createdAt + 1_000, "gpt-5.1-codex", "medium"), turn(s.createdAt + 2_000, "gpt-5.1-codex-max", "xhigh")]);
    m.statusFromHook({ paneId: s.id, conversationId: sId, agent: "codex", status: "idle", started: true, transcriptPath: file });
    m.statusFromHook({ paneId: s.id, conversationId: sId, agent: "codex", status: "idle", finished: true, transcriptPath: file });
    expect(store.state.sessions.find((x) => x.id === s.id)).toMatchObject({ model: "gpt-5.1-codex-max", effort: "xhigh" });
    m.kill(s.id, false);
    await m.relaunch(s.id);
    expect(last()).toContain(`'resume' '${sId}'`);
    expect(last()).toContain("'--model' 'gpt-5.1-codex-max'");
    expect(last()).toContain('model_reasoning_effort="xhigh"');
    // one closed before a turn's end saw its /model: its Reopen reads its rollout
    const t = await m.create(pane({ agent: "codex", model: "gpt-5.1-codex", effort: "medium" }));
    const tId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c";
    m.statusFromHook({ paneId: t.id, conversationId: tId, agent: "codex", status: "idle", started: true });
    m.kill(t.id, false);
    rollout(tId, [turn(t.createdAt + 1_000, "gpt-5.1-codex", "medium"), turn(t.createdAt + 2_000, "gpt-5.1-codex", "high")]);
    await m.relaunch(t.id);
    expect(last()).toContain("'--model' 'gpt-5.1-codex'");
    expect(last()).toContain('model_reasoning_effort="high"');
  });

  it("tells a launch's alias from another line by its name", () => {
    expect(sameModelLine("opus", "claude-opus-4-7[1m]")).toBe(true);
    expect(sameModelLine("claude-opus-4-7", "claude-opus-4-7[1m]")).toBe(true);
    expect(sameModelLine("opus", "claude-sonnet-4-5")).toBe(false);
    expect(sameModelLine("claude-opus-4-7", "claude-opus-4-5")).toBe(false);
    expect(sameModelLine("gpt-5.1-codex", "gpt-5.1-codex")).toBe(true);
  });
});

describe("inserting a step", () => {
  it("puts it between two: A→B becomes A→new→B, the wire into B keeping its id and settings, A→new a plain handoff", async () => {
    const { m, wires, edits } = await setup();
    const a = await m.create(pane({ title: "Builder", taskGroup: "5200", model: "opus", effort: "high" }));
    const b = step(m, "Verifier");
    const ab = made(wires.add(a.id, b.id, "handoff", { template: "Check: {summary}", gate: "ask" }));
    const r = await edits.insertStep({ after: a.id, before: b.id, title: "Coder" });
    expect(r.info).toMatchObject({ title: "Coder", agent: "claude", model: "opus", effort: "high", taskGroup: "5200", planned: { worktree: false } });
    const links = wires.get().book!.links;
    expect(links[ab]).toMatchObject({ from: r.info.id, to: b.id, template: "Check: {summary}" });
    const into = r.wires.find((w) => w !== ab)!;
    expect(links[into]).toMatchObject({ from: a.id, to: r.info.id, type: "handoff", when: "finished", gate: "ask" });
    expect(links[into].template).toBeUndefined();
    expect(r.wires).toEqual([into, ab]);
  });

  it("puts it after the last step and ahead of the first", async () => {
    const { m, wires, edits } = await setup();
    const a = step(m, "First", { agent: "codex", model: "gpt-5.1-codex" });
    const after = await edits.insertStep({ after: a.id, title: "Next" });
    expect(after.info).toMatchObject({ agent: "codex", model: "gpt-5.1-codex" });
    expect(wires.get().book!.links[after.wires[0]]).toMatchObject({ from: a.id, to: after.info.id });
    const before = await edits.insertStep({ before: a.id, title: "Earlier", agent: "claude", prompt: "read the ticket" });
    // another agent than its neighbour's starts at its own defaults
    expect(before.info.model).toBeUndefined();
    expect(before.info.planned!.prompt).toBe("read the ticket");
    expect(wires.get().book!.links[before.wires[0]]).toMatchObject({ from: before.info.id, to: a.id });
  });

  it("is refused before anything is made with no handoff between the two, or an unknown model", async () => {
    const { m, edits } = await setup();
    const a = step(m, "A");
    const b = step(m, "B");
    const count = m.planned().length;
    await expect(edits.insertStep({ after: a.id, before: b.id, title: "X" })).rejects.toThrow(/no handoff from “A” to “B”/);
    await expect(edits.insertStep({ after: a.id, title: "X", model: "gpt-9" })).rejects.toThrow(/doesn't offer/);
    await expect(edits.insertStep({ title: "X" })).rejects.toThrow(/Say where the step goes/);
    expect(m.planned().length).toBe(count);
  });

  it("takes the step back, and the wire into B back to A, when a wire is refused once it's made", async () => {
    const { m, wires, edits, forgot } = await setup();
    const a = await m.create(pane({ title: "A", taskGroup: "5200" }));
    const b = step(m, "B");
    const ab = made(wires.add(a.id, b.id, "handoff"));
    const add = wires.add.bind(wires);
    vi.spyOn(wires, "add").mockImplementation((from, to, type, s) => (from === a.id ? { refused: "nope, not now." } : add(from, to, type, s)));
    await expect(edits.insertStep({ after: a.id, before: b.id, title: "X" })).rejects.toThrow("“A” couldn't hand off to “X”: nope, not now.");
    expect(wires.get().book!.links[ab]).toMatchObject({ from: a.id, to: b.id });
    expect(forgot).toHaveLength(1);
    expect(m.planned().map((s) => s.title)).toEqual(["B"]);
  });
});

describe("modelRefusal", () => {
  it("goes by the launch's shape, then what this Mac's agent offers", () => {
    expect(modelRefusal("claude", "opus", "max", CATALOG)).toBeNull();
    expect(modelRefusal("codex", undefined, "max", CATALOG)).toMatch(/Codex has no max reasoning effort/);
    expect(modelRefusal("claude", null, null, null)).toBeNull();
  });
});
