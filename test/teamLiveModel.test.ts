import { describe, expect, it } from "vitest";
import { followPlan, mergeRoomSessions } from "../src/renderer/team/roomLiveModel";
import { classifyTermInput, forwardTermInput } from "../src/renderer/inputGuard";
import { isMouseReports, isTermReply } from "../src/shared/termInput";
import type { SessionInfo } from "../src/shared/types";
import type { LivePanesState, MemberView, RoomSessionTag } from "../src/shared/team/livePanes";

const s = (id: string, taskGroup: string | null, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id, title: id, repoPath: "/r", cwd: "/r", branch: null, ticketId: null, ticketTitle: null, taskGroup, status: "idle", createdAt: 0, kind: "work", extraDirs: [], waitingReason: null, waitingSince: null, ...over,
});
const tag = (over: Partial<RoomSessionTag>): RoomSessionTag => ({
  roomId: "R", sessionId: "", owner: "o", ownerName: "Nick", remote: true, online: true, live: true, lookers: [], cols: 80, rows: 24, git: null, repo: null, repoName: null, guards: { secrets: true, coauthors: true }, ...over,
});
const top = (x: SessionInfo) => (x.taskGroup ?? "ungrouped").split("/")[0];

describe("teammates' sessions in the window", () => {
  it("are added to this window's, and its own room sessions are tagged", () => {
    const state: LivePanesState = { remote: [s("r~nick~n1", "5110", { room: tag({ sessionId: "n1" }) })], own: { a: tag({ remote: false, sessionId: "a" }) }, views: [], problems: [] };
    const merged = mergeRoomSessions([s("a", "5110"), s("b", "private")], state);
    expect(merged.map((x) => [x.id, !!x.room, x.room?.remote ?? null])).toEqual([["a", true, false], ["b", false, null], ["r~nick~n1", true, true]]);
    expect(mergeRoomSessions([s("a", null)], null).map((x) => x.id)).toEqual(["a"]);
  });
});

describe("following a teammate", () => {
  const sessions = [s("a", "5110"), s("b", "5110/api"), s("c", "5102"), s("r~n~1", "5110")];
  const view = (shown: string[], focused: string | null): MemberView => ({ member: "m", name: "Nick", shown, focused, at: 0 });
  it("shows the group of the pane they're in, with their panes in it", () => {
    expect(followPlan(view(["a", "r~n~1", "c"], "r~n~1"), sessions, top)).toEqual({ group: "5110", ids: ["a", "r~n~1"], focused: "r~n~1" });
    expect(followPlan(view(["c", "a"], null), sessions, top)).toEqual({ group: "5102", ids: ["c"], focused: null });
  });
  it("has nothing to show when they show nothing this window knows", () => {
    expect(followPlan(view(["gone"], "gone"), sessions, top)).toBeNull();
    expect(followPlan(undefined, sessions, top)).toBeNull();
  });
});

describe("input from a teammate's pane", () => {
  it("never forwards the terminal's automatic answers; the owner's terminal answers", () => {
    const reply = "\x1b[12;5R";
    expect(classifyTermInput(reply, 10_000, "none")).toBe("reply");
    expect(forwardTermInput("reply", true)).toBe("drop");
    expect(forwardTermInput("reply", false)).toBe("send");
    expect(forwardTermInput("user", true)).toBe("send");
    expect(forwardTermInput("mouse", true)).toBe("send");
    expect(forwardTermInput("unattributed", true)).toBe("audit");
  });
  it("tells replies and mouse reports from typing", () => {
    expect(isTermReply("\x1b]11;rgb:2020/1f1f/1c1c\x07")).toBe(true);
    expect(isTermReply("ls\r")).toBe(false);
    expect(isMouseReports("\x1b[<64;1;1M\x1b[<64;1;1M")).toBe(true);
    expect(isMouseReports("\x1b[<64;1;1Mx")).toBe(false);
  });
});
