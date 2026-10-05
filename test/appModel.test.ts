import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { broadcastFate, cellKeyFor, frontOf, paneShortcuts, remapGroupKeys, remapSeats, worktreeGone, type GridCell } from "../src/renderer/appModel";
import { SessionManager } from "../src/main/sessions";
import { worktreeState } from "../src/main/worktrees";
import type { SessionInfo } from "../src/shared/types";

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, title: id, cwd: `/w/${id}`, status: "idle", kind: "work", ...over }) as SessionInfo;

describe("pane numbers", () => {
  const a = session("a");
  const ws: GridCell = { kind: "workspace", key: "5038/api", sub: "api", list: [session("w1"), session("w2"), session("w3")] };
  const b = session("b");
  const cells: GridCell[] = [{ kind: "session", s: a }, ws, { kind: "session", s: b }];

  it("count panes, not sessions: a workspace is one number, for its front tab", () => {
    const keys = paneShortcuts(cells, { "5038/api": "w2" });
    expect([...keys]).toEqual([["a", 1], ["w2", 2], ["b", 3]]);
    // with no tab chosen the first one is in front
    expect(paneShortcuts(cells, {}).get("w1")).toBe(2);
    expect(frontOf(ws, { "5038/api": "gone" }).id).toBe("w1");
  });
  it("stop at 9", () => {
    const many: GridCell[] = Array.from({ length: 12 }, (_, i) => ({ kind: "session", s: session(`s${i}`) }));
    const keys = paneShortcuts(many, {});
    expect(keys.size).toBe(9);
    expect(keys.has("s9")).toBe(false);
  });
});

describe("a session's cell key", () => {
  it("is the workspace for a session in one, else the session itself", () => {
    expect(cellKeyFor("s1", "5038/api")).toBe("ws:5038/api");
    expect(cellKeyFor("s1", "5038")).toBe("s1");
    expect(cellKeyFor("s1", null)).toBe("s1");
    expect(cellKeyFor("s1", undefined)).toBe("s1");
  });
});

describe("group-keyed state across a rename", () => {
  it("moves the group and everything under it, leaving lookalike names alone", () => {
    const rec = { "5038": 1, "5038/api": 2, "50380": 3, other: 4 };
    expect(remapGroupKeys(rec, "5038", "orgs")).toEqual({ orgs: 1, "orgs/api": 2, "50380": 3, other: 4 });
    // a workspace rename touches only that workspace
    expect(remapGroupKeys(rec, "5038/api", "5038/backend")).toEqual({ "5038": 1, "5038/backend": 2, "50380": 3, other: 4 });
  });
  it("renames workspace cells seated in zones as well as the groups the seats belong to", () => {
    const seats = { "5038": ["s1", "ws:5038/api", null, "ws:50380/x"] };
    expect(remapSeats(seats, "5038", "orgs")).toEqual({ orgs: ["s1", "ws:orgs/api", null, "ws:50380/x"] });
    expect(remapSeats(seats, "5038/api", "5038/web")).toEqual({ "5038": ["s1", "ws:5038/web", null, "ws:50380/x"] });
  });
});

describe("closing a session whose worktree state can't be read", () => {
  it("treats only a missing folder as gone", async () => {
    const missing = path.join(os.tmpdir(), `mb-missing-${process.pid}-${Date.now()}`);
    const gone = await worktreeState(missing).then(
      () => "",
      (e: Error) => e.message
    );
    expect(gone).not.toBe("");
    expect(worktreeGone(gone)).toBe(true);
  });
  it("doesn't take any other failure for a missing worktree", async () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "mb-notrepo-"));
    const failed = await worktreeState(notRepo).then(
      () => "",
      (e: Error) => e.message
    );
    fs.rmSync(notRepo, { recursive: true, force: true });
    expect(failed).not.toBe("");
    expect(worktreeGone(failed)).toBe(false);
    expect(worktreeGone("git status: fatal: Unable to create '/r/.git/index.lock': File exists.")).toBe(false);
    expect(worktreeGone("git status: timed out after 30s")).toBe(false);
  });
});

describe("the control room's delivery list", () => {
  it("says what the main process's broadcast does with each session", () => {
    const store = { settings: {}, state: { sessions: [] }, upsertSession() {}, removeSession() {}, save() {} };
    const m = new SessionManager(store as any);
    const written: Record<string, string[]> = {};
    const all = [
      session("idle"),
      session("working", { status: "working" }),
      session("waiting", { status: "waiting" }),
      session("dead", { status: "dead" }),
      session("shell", { shell: true }),
      session("debrief", { debrief: true }),
    ];
    for (const s of all) {
      written[s.id] = [];
      (m as any).live.set(s.id, { info: s, proc: { write: (d: string) => written[s.id].push(d) }, buffer: "", queued: [], claudeId: null, lastInput: 0, draft: false, flushTimer: null });
    }
    m.broadcast("hello", all.map((s) => s.id), true);
    for (const s of all) {
      const queued = (m as any).live.get(s.id).queued.length > 0;
      const sent = written[s.id].length > 0;
      const fate = sent ? "delivered" : queued ? "queued" : "skipped";
      expect([s.id, broadcastFate(s)]).toEqual([s.id, fate]);
    }
  });
});
