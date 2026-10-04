import { afterEach, describe, expect, it, vi } from "vitest";
import { expandBranchPattern, presetProblem, presetRequest, uniqueBranch } from "../src/main/presets";
import type { SessionPreset } from "../src/shared/types";

const writes: string[] = [];
vi.mock("node-pty", () => ({
  spawn: () => ({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write: (d: string) => writes.push(d), resize() {}, kill() {}, pid: 1 }),
}));

const base: SessionPreset = { id: "p1", name: "Review on dev", launch: "claude", repoPath: "/code/backoffice", branch: { mode: "checkout" }, useWorktree: true };
const now = new Date(2026, 9, 4, 9, 5);

describe("preset branch names", () => {
  it("fills in the date and time, and keeps names git accepts", () => {
    expect(expandBranchPattern("review-{date}", now)).toBe("review-20261004");
    expect(expandBranchPattern("test {date}-{time}", now)).toBe("test-20261004-0905");
    expect(expandBranchPattern("a:b?c", now)).toBe("a-b-c");
  });
  it("adds -2, -3… when the name is taken locally or on origin", () => {
    expect(uniqueBranch("review", ["main"])).toBe("review");
    expect(uniqueBranch("review", ["review", "origin/review-2"])).toBe("review-3");
  });
});

describe("the session a preset starts", () => {
  it("runs in the checkout as it is: no branch, no worktree", () => {
    const r = presetRequest(base, [], now);
    expect(r).toEqual({ repoPath: "/code/backoffice", useWorktree: false, title: "Review on dev", agent: "claude" });
  });
  it("opens an existing branch, in a worktree when asked", () => {
    const r = presetRequest({ ...base, branch: { mode: "existing", name: "dev" } }, [], now);
    expect(r).toMatchObject({ branchName: "dev", useWorktree: true });
  });
  it("cuts a fresh, unique branch from its base", () => {
    const r = presetRequest({ ...base, branch: { mode: "new", pattern: "review-{date}", base: "dev" } }, ["review-20261004"], now);
    expect(r).toMatchObject({ branchName: "review-20261004-2", baseBranch: "dev", useWorktree: true });
  });
  it("carries the group, model, effort and kickoff; a terminal gets no model", () => {
    const r = presetRequest({ ...base, group: "5101", model: "opus", effort: "high", kickoff: " Review it. " }, [], now);
    expect(r).toMatchObject({ taskGroup: "5101", model: "opus", effort: "high", initialPrompt: "Review it." });
    const sh = presetRequest({ ...base, launch: "shell", model: "opus", kickoff: "npm test" }, [], now);
    expect(sh).toMatchObject({ shell: true, initialPrompt: "npm test" });
    expect(sh.model).toBeUndefined();
    expect(sh.agent).toBeUndefined();
  });
  it("refuses an incomplete preset", () => {
    expect(presetProblem({ ...base, name: " " })).toMatch(/name/);
    expect(presetProblem({ ...base, repoPath: null, branch: { mode: "existing", name: "dev" } })).toMatch(/needs a repo/);
    expect(presetProblem({ ...base, branch: { mode: "new", pattern: "" } })).toMatch(/pattern/);
    expect(() => presetRequest({ ...base, branch: { mode: "existing", name: "" } }, [], now)).toThrow(/Name the branch/);
  });
});

describe("a terminal's kickoff", () => {
  afterEach(() => vi.useRealTimers());
  it("is typed into the shell and run once it has started", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { SessionManager } = await import("../src/main/sessions");
    const store = { settings: {}, state: { sessions: [] as any[] }, upsertSession() {}, removeSession() {}, save() {} };
    const m = new SessionManager(store as any);
    await m.create({ repoPath: null, useWorktree: false, shell: true, initialPrompt: "npm test\nnpm run lint" });
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(1600);
    expect(writes).toEqual(["npm test ; npm run lint\r"]);
  });
});
