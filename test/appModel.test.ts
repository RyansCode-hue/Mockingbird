import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { reachesBroadcast, cellKeyFor, frontOf, groupChoices, inReadingOrder, paneShortcuts, remapGroupKeys, remapTrees, sessionHolding, sessionOutline, worktreeGone, type GridCell, type OutlineEntry } from "../src/renderer/appModel";
import { keysOf, leaf, split } from "../src/renderer/layoutTree";
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
  it("follow the grid's reading order, top-left first, whatever order the panes were opened in", () => {
    // b on the left; a above the workspace on the right
    const tree = split("row", [leaf("b"), split("col", [leaf("a"), leaf("ws:5038/api")])]);
    const ordered = inReadingOrder(cells, tree);
    expect(ordered.map((c) => (c.kind === "session" ? c.s.id : c.key))).toEqual(["b", "a", "5038/api"]);
    expect([...paneShortcuts(ordered, {})]).toEqual([["b", 1], ["a", 2], ["w1", 3]]);
    // a cell the tree doesn't place yet comes last
    expect(inReadingOrder(cells, leaf("b")).map((c) => (c.kind === "session" ? c.s.id : c.key))).toEqual(["b", "a", "5038/api"]);
  });
  it("stop at 9", () => {
    const many: GridCell[] = Array.from({ length: 12 }, (_, i) => ({ kind: "session", s: session(`s${i}`) }));
    const keys = paneShortcuts(many, {});
    expect(keys.size).toBe(9);
    expect(keys.has("s9")).toBe(false);
  });
});

describe("the session a file belongs to", () => {
  const api = session("api", { cwd: "/w/api" });
  const apiV2 = session("api2", { cwd: "/w/api-v2" });
  const web = session("web", { cwd: "/w/web" });
  it("prefers the given session when its folder holds the file, else the first that does", () => {
    expect(sessionHolding([api, apiV2, web], "/w/web/src/a.ts", api)?.id).toBe("web");
    expect(sessionHolding([api, web], "/w/api/x.ts", null)?.id).toBe("api");
    const twin = session("twin", { cwd: "/w/api" });
    expect(sessionHolding([api, twin], "/w/api/x.ts", twin)?.id).toBe("twin");
  });
  it("matches whole folders only, and is null when none holds the file", () => {
    expect(sessionHolding([api, apiV2], "/w/api-v2/x.ts")?.id).toBe("api2");
    expect(sessionHolding([api], "/elsewhere/x.ts")).toBeNull();
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
  it("renames the workspace panes in layout trees as well as the groups the trees belong to", () => {
    const trees = { "5038": split("row", [leaf("s1"), leaf("ws:5038/api"), leaf("ws:50380/x")])! };
    const top = remapTrees(trees, "5038", "orgs");
    expect(Object.keys(top)).toEqual(["orgs"]);
    expect(keysOf(top.orgs)).toEqual(["s1", "ws:orgs/api", "ws:50380/x"]);
    expect(keysOf(remapTrees(trees, "5038/api", "5038/web")["5038"])).toEqual(["s1", "ws:5038/web", "ws:50380/x"]);
  });
  it("keeps a tree already saved under the new name, dropping the old one", () => {
    const ahead = { "5038": leaf("s1"), orgs: split("row", [leaf("s1"), leaf("ws:orgs/api")])! };
    const out = remapTrees(ahead, "5038", "orgs");
    expect(Object.keys(out)).toEqual(["orgs"]);
    expect(keysOf(out.orgs)).toEqual(["s1", "ws:orgs/api"]);
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
  it("offers a broadcast to exactly the sessions the main process gives it to", () => {
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
    const offered = all.filter(reachesBroadcast).map((s) => s.id); // before: delivery changes a pane's status
    const outcomes = m.broadcast("hello", all.map((s) => s.id), true);
    expect(outcomes.filter((o) => o.outcome !== "skipped").map((o) => o.id)).toEqual(offered);
    expect(Object.fromEntries(outcomes.map((o) => [o.id, o.outcome]))).toEqual({
      idle: "delivered",
      working: "queued",
      waiting: "queued",
      dead: "skipped",
      shell: "skipped",
      debrief: "skipped",
    });
  });
});

describe("the Sessions outline", () => {
  // a row as the sidebar draws it: a group header with its sessions (* when it's a room's), or the Connected sessions line
  const rows = (outline: OutlineEntry<SessionInfo>[]) => outline.map((e) => (e.kind === "connected" ? "--connected--" : `${e.key}${e.shared ? "*" : ""}:${e.list.map((s) => s.id).join(",")}`));
  const theirs = { remote: true } as SessionInfo["room"];
  const mine = { remote: false } as SessionInfo["room"];
  const sessions = [
    session("r1", { taskGroup: "5101", room: mine }),
    session("l1", { taskGroup: "5102" }),
    session("u1", { taskGroup: null }),
    session("t1", { taskGroup: "5101/api", room: theirs }),
    session("l2", { taskGroup: "5038/backend" }),
    session("l3", { taskGroup: "5102" }),
    session("t2", { taskGroup: "5110", room: theirs }),
  ];

  it("lists the groups of this Mac's sessions, a room's too, in first-appearance order, then one line for the rooms", () => {
    expect(rows(sessionOutline(sessions, ["5110", "5101"], false))).toEqual(["5101*:r1", "5102:l1,l3", "ungrouped:u1", "5038:l2", "--connected--"]);
  });
  it("leaves teammates' sessions, and a room's group holding only theirs, to the Team view", () => {
    expect(rows(sessionOutline(sessions.filter((s) => s.id !== "r1"), ["5110", "5101"], false))).toEqual(["5102:l1,l3", "ungrouped:u1", "5038:l2", "--connected--"]);
  });
  it("has no rooms line when no group is a room", () => {
    expect(rows(sessionOutline(sessions.filter((s) => !s.room), [], false))).toEqual(["5102:l1,l3", "ungrouped:u1", "5038:l2"]);
    expect(sessionOutline([], [], false)).toEqual([]);
  });
  it("shows the rooms line for a joined room with no session here", () => {
    expect(rows(sessionOutline([], ["5110"], false))).toEqual(["--connected--"]);
  });
  it("while filtering shows only groups with a match, and the rooms line only when a room's session matches", () => {
    const matching = (ids: string[]) => sessions.filter((s) => ids.includes(s.id));
    expect(rows(sessionOutline(matching(["l1", "t1"]), ["5110", "5101"], true))).toEqual(["5102:l1", "--connected--"]);
    expect(rows(sessionOutline(matching(["l1"]), ["5110", "5101"], true))).toEqual(["5102:l1"]);
    expect(rows(sessionOutline(matching(["r1"]), ["5110", "5101"], true))).toEqual(["5101*:r1", "--connected--"]);
    expect(sessionOutline([], ["5110"], true)).toEqual([]);
  });
});

describe("the groups New Session offers", () => {
  it("are every session's group and every joined room's, once each, never the debriefs' assistant group", () => {
    const sessions = [session("a", { taskGroup: "5101" }), session("b", { taskGroup: "5101/api" }), session("c", { taskGroup: null }), session("d", { taskGroup: "assistant" }), session("e", { taskGroup: "5101" })];
    expect(groupChoices(sessions, ["5110", "5101"])).toEqual(["5101", "5101/api", "5110"]);
    expect(groupChoices([], ["5110"])).toEqual(["5110"]);
  });
});
