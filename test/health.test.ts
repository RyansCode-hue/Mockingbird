import { describe, expect, it, vi } from "vitest";
import { cliVersion } from "../src/main/agents";

vi.mock("node-pty", () => ({ spawn: () => ({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {}, pid: 1 }) }));

const manager = async () => {
  const { SessionManager } = await import("../src/main/sessions");
  const store = { settings: { claudeBin: "/bin/echo", codexBin: "/bin/echo" }, state: { sessions: [] as any[] }, upsertSession() {}, removeSession() {}, save() {} };
  return new SessionManager(store as any);
};

describe("session health", () => {
  it("reads the version from each CLI's --version", () => {
    expect(cliVersion("2.1.5 (Claude Code)")).toBe("2.1.5");
    expect(cliVersion("codex-cli 0.46.0")).toBe("0.46.0");
    expect(cliVersion("command not found")).toBeNull();
  });

  it("notices panes still running the version they started with after the CLI updates", async () => {
    const m = await manager();
    m.setAgentVersions({ claude: "2.1.3" });
    const a = await m.create({ repoPath: null, useWorktree: false, agent: "claude", title: "a" });
    await m.create({ repoPath: null, useWorktree: false, shell: true, title: "shell" });
    expect(a.agentVersion).toBe("2.1.3");
    expect(m.updateNotices()).toEqual([]);
    m.setAgentVersions({ claude: "2.1.5" });
    expect(m.updateNotices()).toEqual([{ agent: "claude", installed: "2.1.5", sessions: [{ id: a.id, title: "a", version: "2.1.3" }] }]);
    // a pane started after the update is current
    const b = await m.create({ repoPath: null, useWorktree: false, agent: "claude", title: "b" });
    expect(b.agentVersion).toBe("2.1.5");
    expect(m.updateNotices()[0].sessions.map((s) => s.id)).toEqual([a.id]);
  });

  it("flags a working pane that has gone quiet, and clears it when it moves on", async () => {
    const m = await manager();
    const s = await m.create({ repoPath: null, useWorktree: false, agent: "claude", title: "a" });
    const now = Date.now();
    expect(m.checkStalls(now + 10 * 60_000, 5 * 60_000)).toBe(true); // created "working", then silent
    expect(m.list().find((x) => x.id === s.id)!.stalledSince).toBeTruthy();
    expect(m.checkStalls(now + 11 * 60_000, 5 * 60_000)).toBe(false); // already flagged
    m.statusFromHook({ paneId: s.id, status: "idle" });
    expect(m.list().find((x) => x.id === s.id)!.stalledSince).toBeNull();
    expect(m.checkStalls(now + 20 * 60_000, 5 * 60_000)).toBe(false); // idle panes are quiet by design
  });
});
