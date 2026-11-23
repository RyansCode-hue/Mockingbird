import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers";
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

async function setup(opts: { catalog?: ModelCatalog | null } = {}) {
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
    catalog: async () => (opts.catalog === undefined ? CATALOG : opts.catalog),
    log,
  });
  return { m, store, wires, edits, logged, forgot };
}
const pane = (o: Partial<NewSessionRequest> = {}): NewSessionRequest => ({ repoPath: null, useWorktree: false, agent: "claude", title: "a", ...o });
const step = (m: Awaited<ReturnType<typeof setup>>["m"], title: string, o: Record<string, unknown> = {}) => m.planStep({ title, agent: "claude", repoPath: null, worktree: false, taskGroup: "5200", ...o });
const last = () => ptys.at(-1)!.args.join(" ");
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

  it("records a /model its agent reports running (its status line's model) for the next launch, an older run's report saying nothing", async () => {
    const { m, store } = await setup();
    const s = await m.create(pane({ model: "opus" }));
    const now = s.createdAt + 1;
    // the alias's own model is no change
    expect(m.noteReportedModel(s.id, "claude-opus-4-7", now)).toBe(false);
    expect(m.noteReportedModel(s.id, "claude-sonnet-4-5", s.createdAt - 1)).toBe(false);
    expect(m.noteReportedModel(s.id, "claude-sonnet-4-5", now)).toBe(true);
    expect(store.state.sessions.find((x) => x.id === s.id)?.model).toBe("claude-sonnet-4-5");
    await m.restart(s.id);
    expect(last()).toContain("'--model' 'claude-sonnet-4-5'");
    // with none of its own, the first it reports is its default, and a later other one a /model
    const d = await m.create(pane());
    expect(m.noteReportedModel(d.id, "claude-opus-4-7", d.createdAt)).toBe(false);
    expect(m.list().find((x) => x.id === d.id)?.model).toBeUndefined();
    expect(m.noteReportedModel(d.id, "claude-haiku-4-5", d.createdAt + 5)).toBe(true);
    expect(m.list().find((x) => x.id === d.id)?.model).toBe("claude-haiku-4-5");
  });

  it("reopens a closed session with what its agent last reported running when its record's line differs", async () => {
    const { m } = await setup();
    const s = await m.create(pane({ model: "opus" }));
    m.kill(s.id, false);
    let report: { model: string; at: number } | null = { model: "claude-sonnet-4-5", at: s.createdAt + 10 };
    m.reportedModel = () => report;
    await m.relaunch(s.id);
    expect(last()).toContain("'--model' 'claude-sonnet-4-5'");
    // one from before its last launch is an older run's
    const t = await m.create(pane({ model: "opus" }));
    m.kill(t.id, false);
    report = { model: "claude-sonnet-4-5", at: t.createdAt - 10 };
    await m.relaunch(t.id);
    expect(last()).toContain("'--model' 'opus'");
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
