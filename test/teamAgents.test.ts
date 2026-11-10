import { spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { loopbackRoom, until, type LoopbackMember, type LoopbackNetwork } from "../src/main/team/loopback";
import { TeamRoom } from "../src/main/team/teamRoom";
import { Messaging, mcpLaunch, remoteSessionId } from "../src/main/messaging";
import { askAs, testLaunch } from "./mcpClient";
import { AGENT_REQUESTS, AgentBridge } from "../src/main/team/agentBridge";
import type { AgentMessage, SessionInfo } from "../src/shared/types";
import { roomMessageRefusal, ROOM_SANDBOX_REFUSAL } from "../src/shared/team/livePanes";
import { ARTIFACT_TOOL } from "../src/shared/team/artifacts";
import { TEAMMATE_TOOL } from "../src/shared/team/overlaps";
import { HOUSE_TOOLS } from "../src/shared/team/house";
import { WIRE_TOOL } from "../src/main/wireToolSchemas";

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, title: id, ticketTitle: null, repoPath: `/code/backoffice`, branch: `${id}-branch`, taskGroup: "5110", status: "idle", agent: "claude", cwd: `/w/${id}`, kind: "work", waitingReason: null, ...over }) as SessionInfo;

interface Side {
  m: LoopbackMember;
  room: TeamRoom;
  messaging: Messaging;
  sessions: SessionInfo[];
  delivered: { to: string; text: string; submit: boolean }[];
  log: AgentMessage[];
  /** Sessions whose launch didn't run under the room's settings: they joined the room while running. */
  unguarded: Set<string>;
}

let roomId: string;
let netw: LoopbackNetwork;
let ryan: Side;
let nick: Side;
const launch = testLaunch("front");
const sock = launch.env.MOCKINGBIRD_SOCK;

function side(m: LoopbackMember, sessions: SessionInfo[], dir: string, opts: { listen?: boolean; mode?: (s: SessionInfo) => boolean } = {}): Side {
  const s = { m, sessions, delivered: [], log: [], unguarded: new Set() } as unknown as Side;
  const fakeSessions = {
    list: () => s.sessions,
    // each session was started in its room, under the room's settings, unless a test says otherwise
    guardsOf: (id: string) => (s.unguarded.has(id) ? null : { secrets: true, coauthors: true }),
    deliverAgentMessage: (to: string, text: string, submit: boolean) => {
      s.delivered.push({ to, text, submit });
      if (s.sessions.find((x) => x.id === to)?.status !== "idle") return "queued until its current turn ends";
      return submit ? "delivered" : "placed in its prompt for the user to send";
    },
  };
  s.messaging = new Messaging(fakeSessions as any, opts.mode ?? (() => true), () => {}, (msg) => s.log.push(msg));
  if (opts.listen) s.messaging.start();
  s.room = new TeamRoom({
    sessions: () => s.sessions,
    guardsOf: fakeSessions.guardsOf,
    roomGroups: () => m.team.status().rooms.map((r) => ({ roomId: r.id, groupKey: r.groupKey })),
    ask: async () => "unused",
    houseBoard: async () => null,
    chatChanged: () => {},
    notify: () => {},
    windowFocused: () => false,
    log: () => {},
    dir: path.join(dir, m.name),
  });
  s.room.start(m.team, s.messaging);
  return s;
}

/** One request over the socket, the way the MCP server sends it. */
const ask = (req: { op: string; from: string; args?: Record<string, unknown> }): Promise<any> => askAs(sock, req);

const rid = (sid: string, s: Side) => remoteSessionId(sid, s.m.id);

beforeAll(async () => {
  const dir = tempDir("agents");
  const r = await loopbackRoom(["Ryan", "Nick"], { dir });
  roomId = r.roomId;
  netw = r.net;
  const [rm, nm] = r.members;
  ryan = side(rm, [session("front", { title: "Front", taskGroup: "5110/web" }), session("solo", { taskGroup: "9999" })], dir, { listen: true });
  nick = side(
    nm,
    [
      session("api", { title: "Export API", taskGroup: "5110/api" }),
      session("busy", { status: "working" }),
      session("brief", { debrief: true }),
      session("term", { shell: true }),
      session("private", { title: "Private spike", taskGroup: "7777" }),
    ],
    dir,
    // Nick leaves agent messages in the prompt for this group
    { mode: (s) => !s.taskGroup?.startsWith("5110") }
  );
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((res) => setTimeout(res, 20));
});
afterAll(() => fs.rmSync(sock, { force: true }));

describe("list_sessions across laptops", () => {
  it("lists a room session's teammates' room sessions, marked remote with their owner — never their other sessions", async () => {
    const r = await ask({ op: "list_sessions", from: "front" });
    const remote = r.result.sessions.filter((s: any) => s.remote);
    expect(r.result.sessions.find((s: any) => s.id === "solo")).toBeDefined();
    expect(remote.map((s: any) => [s.id, s.title, s.owner, s.status, s.same_group])).toEqual([
      [rid("api", nick), "Export API", "Nick", "idle", true],
      [rid("busy", nick), "busy", "Nick", "working", true],
      [rid("term", nick), "term", "Nick", "idle", true],
    ]);
    expect(remote[0]).toMatchObject({ agent: "claude", repo: "backoffice", branch: "api-branch", group: "5110" });
    expect(remote[0].accepts_messages).toBeUndefined();
    // the room shows the terminal, so it's listed — as one that won't take messages
    expect(remote[2]).toMatchObject({ accepts_messages: false, why: expect.stringMatching(/^it's a terminal on Nick's Mac/) });
    expect(JSON.stringify(r.result)).not.toMatch(/Private spike|brief/);
    expect(r.result.teammates).toEqual([{ name: "Nick", connected: true }]);
  });

  it("shows a session outside rooms only this laptop's sessions", async () => {
    const r = await ask({ op: "list_sessions", from: "solo" });
    expect(r.result.sessions.some((s: any) => s.remote)).toBe(false);
    expect(r.result.teammates).toBeUndefined();
  });

  it("answers a teammate's list only for a room it names, with that room's sessions", async () => {
    await expect(ryan.m.team.request(nick.m.id, AGENT_REQUESTS.list, {})).rejects.toThrow(/name the room/);
    const r = await ryan.m.team.request<any>(nick.m.id, AGENT_REQUESTS.list, {}, { roomId });
    expect(r.sessions.map((s: any) => s.id)).toEqual(["api", "busy", "term"]);
  });
});

describe("send_message across laptops", () => {
  it("delivers through the room by the owner's rules (its group's delivery mode), logging on both laptops", async () => {
    const r = await ask({ op: "send_message", from: "front", args: { to: rid("api", nick), message: "the API now returns organizationId" } });
    expect(r.result).toBe(`Delivered to "Export API" on Nick's laptop (placed in its prompt for the user to send). Any reply will arrive as a new prompt.`);
    const d = nick.delivered.at(-1)!;
    expect(d).toMatchObject({ to: "api", submit: false });
    expect(d.text).toMatch(new RegExp(`^\\[Message from Mockingbird session "Front" on Ryan's laptop \\(id ${rid("front", ryan)}, claude · backoffice · front-branch\\), through your team room\\.`));
    expect(d.text).toMatch(/not by the user/);
    expect(d.text.endsWith("the API now returns organizationId")).toBe(true);
    expect(nick.log.at(-1)).toMatchObject({ from: rid("front", ryan), fromTitle: "Front (Ryan)", to: "api", toTitle: "Export API", outcome: "placed in its prompt for the user to send · from Ryan's laptop" });
    expect(ryan.log.at(-1)).toMatchObject({ from: "front", to: rid("api", nick), toTitle: "Export API (Nick)", outcome: "placed in its prompt for the user to send · on Nick's laptop" });
    expect(ryan.log.at(-1)!.refused).toBeUndefined();
  });

  it("says when the message is queued behind the session's turn", async () => {
    const r = await ask({ op: "send_message", from: "front", args: { to: rid("busy", nick), message: "when you're done: rebase on dev" } });
    expect(r.result).toMatch(/^Delivered to "busy" on Nick's laptop \(queued until its current turn ends\)/);
  });

  it("refuses sessions outside the room, debriefs, and senders outside rooms", async () => {
    const outside = await ask({ op: "send_message", from: "front", args: { to: rid("private", nick), message: "hi" } });
    // the same words as for an id that was never there: a group outside the room is never named
    expect(outside.error).toBe(`Refused by Nick's Mockingbird: Nick's Mockingbird has no session "private" in this room: it was closed for good, moved out of the room, or the id is wrong — call list_sessions for current ids`);
    expect(nick.log.at(-1)).toMatchObject({ to: "private", refused: true });
    expect((await ask({ op: "send_message", from: "front", args: { to: rid("nothere", nick), message: "hi" } })).error).toBe(outside.error.replace('"private"', '"nothere"'));
    const term = await ask({ op: "send_message", from: "front", args: { to: rid("term", nick), message: "hi" } });
    expect(term.error).toMatch(/^Refused by Nick's Mockingbird: Nick's session "term": it's a terminal on Nick's Mac/);
    expect(nick.delivered.some((d) => d.to === "term")).toBe(false);
    expect(nick.delivered.some((d) => d.to === "private")).toBe(false);
    const debrief = await ask({ op: "send_message", from: "front", args: { to: rid("brief", nick), message: "hi" } });
    expect(debrief.error).toMatch(/debrief interview/);
    const notInRoom = await ask({ op: "send_message", from: "solo", args: { to: rid("api", nick), message: "hi" } });
    expect(notInRoom.error).toMatch(/Only sessions in a shared team room/);
    const unknown = await ask({ op: "send_message", from: "front", args: { to: "api@00000000", message: "hi" } });
    expect(unknown.error).toMatch(/no teammate in this room runs "api@00000000"/);
  });

  it("lets the owner's session reply by the id it was given", async () => {
    const before = ryan.delivered.length;
    const r = await nick.room.bridge.send(roomId, { id: "api", title: "Export API", agent: "claude", repo: "backoffice", branch: "api-branch" }, rid("front", ryan), "thanks, picked it up");
    expect(r).toMatchObject({ status: "delivered", owner: "Ryan", toTitle: "Front", detail: "delivered" });
    expect(ryan.delivered.length).toBe(before + 1);
    expect(ryan.delivered.at(-1)!.text).toMatch(/on Nick's laptop \(id api@/);
  });

  it("reports an offline teammate: their sessions as last seen, and messages not sent", async () => {
    netw.setOnline(nick.m.id, false);
    await until(() => ryan.m.team.presence(roomId).length === 0, "Nick to drop");
    const list = await ask({ op: "list_sessions", from: "front" });
    expect(list.result.teammates).toEqual([{ name: "Nick", connected: false, note: "Nick is offline" }]);
    expect(list.result.sessions.filter((s: any) => s.remote).map((s: any) => [s.id, s.status])).toEqual([
      [rid("api", nick), "offline"],
      [rid("busy", nick), "offline"],
      [rid("term", nick), "offline"],
    ]);
    const sent = await ask({ op: "send_message", from: "front", args: { to: rid("api", nick), message: "still there?" } });
    expect(sent.error).toMatch(/^Not sent: Nick's Mockingbird isn't connected right now/);
    expect(ryan.log.at(-1)).toMatchObject({ refused: true, toTitle: "Export API (Nick)", outcome: expect.stringMatching(/^offline: /) });
    netw.setOnline(nick.m.id, true);
    await until(() => ryan.m.team.presence(roomId).length === 1, "Nick to come back");
  });

  it("says when the teammate's Mockingbird can't take agent messages", async () => {
    nick.room.bridge.detach();
    const r = await ask({ op: "send_message", from: "front", args: { to: rid("api", nick), message: "hello?" } });
    expect(r.error).toMatch(/can't take agent messages yet \(it needs an update\)/);
    nick.room.bridge.attach(nick.m.team, nick.messaging);
  });
});

describe("the MCP server script", () => {
  it("lists and messages a teammate's session through the app", async () => {
    const p = spawn(process.execPath, launch.args, { env: { ...process.env, ...launch.env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const w = (m: object) => p.stdin.write(JSON.stringify(m) + "\n");
    w({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_sessions", arguments: {} } });
    w({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_message", arguments: { to: rid("api", nick), message: "via MCP" } } });
    await until(() => out.trim().split("\n").filter(Boolean).length >= 2, "both answers", 5000);
    p.kill();
    const byId = Object.fromEntries(out.trim().split("\n").map((l) => JSON.parse(l)).map((m) => [m.id, m]));
    const listed = JSON.parse(byId[1].result.content[0].text);
    expect(listed.sessions.filter((s: any) => s.remote).map((s: any) => s.owner)).toEqual(["Nick", "Nick", "Nick"]);
    expect(byId[2].result.isError).toBe(false);
    expect(byId[2].result.content[0].text).toMatch(/^Delivered to "Export API" on Nick's laptop/);
    expect(nick.delivered.at(-1)!.text.endsWith("via MCP")).toBe(true);
  });
});

describe("a Claude session that joined its room while it was running", () => {
  it("gets nothing across the room's line, either way, saying why, until it's restarted in the room; nor does a terminal or a Codex change", async () => {
    const joined = session("joined", { title: "Joined", taskGroup: "5110" });
    ryan.sessions.push(joined);
    ryan.unguarded.add("joined");
    const before = nick.delivered.length;
    try {
      const listed = await ask({ op: "list_sessions", from: "joined" });
      expect(listed.result.teammates_error).toBe(ROOM_SANDBOX_REFUSAL);
      expect(listed.result.sessions.some((s: any) => s.remote)).toBe(false);
      expect((await ask({ op: "send_message", from: "joined", args: { to: rid("api", nick), message: "hi" } })).error).toBe(ROOM_SANDBOX_REFUSAL);
      // the room's tools, and its wires and what they read
      for (const op of [ARTIFACT_TOOL.list, TEAMMATE_TOOL.changes, HOUSE_TOOLS.list, "list_links", ...Object.values(WIRE_TOOL)]) {
        expect((await ask({ op, from: "joined", args: { from: "front", summary: "done" } })).error, op).toBe(ROOM_SANDBOX_REFUSAL);
      }
      // and what its teammates send it, which would become its prompt
      const why = "it joined the room while it was running on Ryan's Mac, so it isn't in the room's sandbox — ask Ryan to restart it in the room";
      const theirs = await nick.room.bridge.list(roomId);
      expect(theirs.flatMap((t) => t.sessions).find((s) => s.id === "joined")).toMatchObject({ refused: why });
      const sent = await nick.room.bridge.send(roomId, { id: "api", title: "Export API", agent: "claude", repo: "backoffice", branch: "api-branch" }, rid("joined", ryan), "hello");
      expect(sent).toMatchObject({ status: "refused", detail: expect.stringContaining(why) });
      expect(ryan.delivered.some((d) => d.to === "joined")).toBe(false);
      // the same session outside a room, and a Codex in one, are as before
      expect(roomMessageRefusal({ agent: "codex", status: "idle", live: true, guards: null }, "Ryan")).toBeNull();
      expect(roomMessageRefusal({ agent: "claude", status: "idle", live: true }, "Ryan")).toBeNull();
      // restarted in the room, it runs under the room's settings
      ryan.unguarded.delete("joined");
      expect((await ask({ op: "send_message", from: "joined", args: { to: rid("api", nick), message: "back" } })).result).toMatch(/^Delivered to "Export API"/);
      expect(nick.delivered.length).toBe(before + 1);
    } finally {
      ryan.sessions.splice(ryan.sessions.indexOf(joined), 1);
      ryan.unguarded.delete("joined");
    }
  });
});

describe("a session that left its room", () => {
  it("isn't listed to teammates or reachable through the room once the live panes say it left (taken over)", () => {
    const R = "R".repeat(22);
    const bridge = new AgentBridge({ sessions: () => [session("kept"), session("taken")], roomGroups: () => [{ roomId: R, groupKey: "5110" }], roomOf: (id) => (id === "kept" ? R : null), log: () => {} });
    expect(bridge.localSessions(R).map((s) => s.id)).toEqual(["kept"]);
    expect(bridge.roomOf(session("taken"))).toBeNull();
    // without the live panes' word, the group decides
    const byGroup = new AgentBridge({ sessions: () => [session("kept"), session("taken")], roomGroups: () => [{ roomId: R, groupKey: "5110" }], log: () => {} });
    expect(byGroup.localSessions(R).map((s) => s.id)).toEqual(["kept", "taken"]);
  });
});
