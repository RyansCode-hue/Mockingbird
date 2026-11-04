import { describe, expect, it, vi } from "vitest";
import { followPlan, mergeRoomSessions, tellLiveView } from "../src/renderer/team/roomLiveModel";
import { classifyTermInput, forwardTermInput } from "../src/renderer/inputGuard";
import { isTermReply, isViewControl } from "../src/shared/termInput";
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
    expect(forwardTermInput("unattributed", true)).toBe("audit");
  });
  it("never forwards mouse reports, which would scroll or click in the owner's view; a local pane does", () => {
    expect(forwardTermInput("mouse", true)).toBe("drop");
    expect(forwardTermInput("mouse", false)).toBe("send");
  });
  it("tells replies from typing", () => {
    expect(isTermReply("\x1b]11;rgb:2020/1f1f/1c1c\x07")).toBe(true);
    expect(isTermReply("ls\r")).toBe(false);
  });
});

describe("input that only moves a view", () => {
  it("is mouse reports (wheel, clicks, drags) and PageUp/PageDown, one or more and nothing else", () => {
    for (const d of [
      "\x1b[<64;10;5M", // wheel up
      "\x1b[<65;10;5M\x1b[<65;10;5M\x1b[<65;10;5M", // wheel down, several notches in one write
      "\x1b[<80;10;5M", // wheel up with Ctrl
      "\x1b[<0;12;7M\x1b[<0;12;7m", // a click: press and release
      "\x1b[<32;14;9M", // drag motion
      "\x1b[<64;812;403M", // pixel coordinates (mode 1016)
      "\x1b[5~", // PageUp
      "\x1b[6~\x1b[6~", // PageDown, key repeat gathered into one write
      "\x1b[<64;10;5M\x1b[5~", // both
    ]) {
      expect(isViewControl(d), JSON.stringify(d)).toBe(true);
    }
  });
  it("is never typing, a paste, Ctrl-C or the arrow keys", () => {
    for (const d of [
      "ls\r",
      "\r",
      "\x03", // Ctrl-C
      "\x1b", // Escape
      "\x1b\r", // Shift+Enter (newline in the prompt)
      "\x1b[A", // Up: also what xterm's alternate-screen wheel sends, but a key first
      "\x1b[B\x1b[B", // Down, repeated
      "\x1bOA", // Up in application cursor mode
      "[<64;1;1M", // typed text that looks like a report
      "\x1b[200~\x1b[<64;1;1M\x1b[201~", // a bracketed paste holding one
      "\x1b[200~\x1b[5~\x1b[201~",
      "echo hi\x1b[<64;1;1M", // a report riding on typing
      "\x1b[<64;1;1Mx",
      "\x1b[5;5~", // Ctrl+PageUp: a key of its own
      "\x1b[15~", // F5
      "\x1b[<64;1M", // malformed
      "\x1b[M #!", // X10 encoding: Escape then "[M" and any three characters could be typed
      "\x1b[12;5R", // a cursor-position answer (dropped as one, not as this)
      "",
    ]) {
      expect(isViewControl(d), JSON.stringify(d)).toBe(false);
    }
  });
});

describe("telling the main process what's on screen", () => {
  it("says why it couldn't, refused or failing, logged with what it was telling; null once told", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const view = { shown: ["s1", "n1"], focused: "s1" };
      expect(await tellLiveView(() => Promise.resolve(undefined), view)).toBeNull();
      expect(await tellLiveView(() => Promise.resolve({ error: "team rooms aren't running" }), view)).toBe("team rooms aren't running");
      expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/couldn't say what's on screen here \(2 sessions, focused s1\)/), "team rooms aren't running");
      expect(await tellLiveView(() => Promise.reject(new Error("the window is closing")), view)).toBe("the window is closing");
      expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/couldn't say what's on screen here/), "the window is closing");
    } finally {
      log.mockRestore();
    }
  });
});
