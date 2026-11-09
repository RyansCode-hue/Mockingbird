import * as fs from "fs";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers";
import { loopbackRoom, until, type LoopbackMember } from "../src/main/team/loopback";
import { SessionManager } from "../src/main/sessions";
import { LivePanes } from "../src/main/team/livePanes";
import { TeamRoom } from "../src/main/team/teamRoom";
import "../src/main/team/takeover"; // the take-over events
import { signGrant } from "../src/main/team/takeoverGrants";
import { Messaging, mcpLaunch, remoteSessionId } from "../src/main/messaging";
import { askAs } from "./mcpClient";
import { DEFAULT_SETTINGS, type AgentMessage, type NewSessionRequest, type SessionInfo, type Settings } from "../src/shared/types";

/**
 * Agent messaging across laptops agrees with the live panes: every session a
 * teammate can watch is one list_sessions lists under the id send_message
 * takes, and a message to one that can't take it is refused saying why —
 * through the real session manager, live panes, room bridge and messaging on
 * both sides.
 */

type FakePty = { env: Record<string, string>; exit(code: number): void };
const ptys: FakePty[] = [];
vi.mock("node-pty", () => ({
  spawn: (_file: string, _args: string[], opts: { env: Record<string, string> }) => {
    let onExit: (e: { exitCode: number }) => void = () => {};
    ptys.push({ env: opts.env, exit: (exitCode) => onExit({ exitCode }) });
    return { onData: () => ({ dispose() {} }), onExit: (cb: any) => ((onExit = cb), { dispose() {} }), write() {}, resize() {}, kill() {}, pid: 1 };
  },
}));
const ptyOf = (id: string) => ptys.filter((p) => p.env.MOCKINGBIRD_SESSION === id).at(-1)!;

const FAST = { publishMs: 50, batchMs: 1, heartbeatMs: 100, viewTtlMs: 3000, leaseMs: 3000, resyncMs: 30, gitMs: 60_000 };
const sock = mcpLaunch("unused").env.MOCKINGBIRD_SOCK;

type Side = ReturnType<typeof side>;

function side(m: LoopbackMember, dir: string, listen = false) {
  const wt = path.join(dir, m.name, "WorkTracker");
  fs.mkdirSync(wt, { recursive: true });
  const settings: Settings = { ...DEFAULT_SETTINGS, claudeBin: "/bin/echo", codexBin: "/bin/echo", workTrackerPath: wt };
  const saved: SessionInfo[] = [];
  const store = {
    settings,
    state: { sessions: saved },
    upsertSession(i: SessionInfo) {
      const k = saved.findIndex((x) => x.id === i.id);
      if (k >= 0) saved[k] = structuredClone(i);
      else saved.push(structuredClone(i));
    },
    removeSession(id: string) {
      const k = saved.findIndex((x) => x.id === id);
      if (k >= 0) saved.splice(k, 1);
    },
    save() {},
  };
  const sessions = new SessionManager(store as any);
  sessions.scrollbackDir = path.join(dir, m.name, "scrollback");
  const base = path.join(dir, m.name, "live");
  const live = new LivePanes({
    team: () => m.team,
    rooms: () => m.team.status().rooms.map((r) => ({ id: r.id, groupKey: r.groupKey })),
    sessions,
    settings: () => settings,
    notify: () => {},
    toWindow: () => {},
    audit: () => {},
    log: (_c, e) => String(e),
    gitState: async () => ({ dirty: false, dirtyFiles: 0, branch: "dev", upstream: null, ahead: 0, behind: 0, insertions: 0, deletions: 0 }),
    originOf: async () => "https://github.com/acme/atticus-backoffice.git",
    gitEmail: async () => null,
    dir: base,
    hooksDir: path.join(base, "githooks"),
    coauthorsDir: path.join(base, "coauthors"),
    timing: FAST,
  });
  live.start();
  const log: AgentMessage[] = [];
  const lines: string[] = [];
  const messaging = new Messaging(sessions, () => true, () => {}, (x) => log.push(x));
  if (listen) messaging.start();
  // wired as index.ts wires it: a session's room is the live panes'
  const room = new TeamRoom({
    sessions: () => sessions.list(),
    resumable: () => sessions.resumable(),
    roomGroups: () => m.team.status().rooms.map((r) => ({ roomId: r.id, groupKey: r.groupKey })),
    roomOf: (id) => live.roomOfSession(id),
    ask: async () => "",
    houseBoard: async () => null,
    chatChanged: () => {},
    notify: () => {},
    windowFocused: () => false,
    log: (l) => lines.push(l),
    dir: path.join(dir, m.name, "chat"),
  });
  room.start(m.team, messaging);
  const repo = path.join(dir, m.name, "atticus-backoffice");
  fs.mkdirSync(repo, { recursive: true });
  const start = (req: Partial<NewSessionRequest> = {}) => sessions.create({ repoPath: repo, useWorktree: false, cwd: repo, agent: "claude", taskGroup: "5110", title: "atticus-backoffice - nick", ...req });
  return { m, sessions, live, room, log, lines, start, stop: () => (live.stop(), room.stop()) };
}

/** One request over the socket, the way the MCP server sends it. */
const ask = (req: { op: string; from: string; args?: Record<string, unknown> }): Promise<any> => askAs(sock, req);

let roomId: string;
let ryan: Side;
let nick: Side;
let front: SessionInfo;

beforeAll(async () => {
  const dir = tempDir("reach");
  const r = await loopbackRoom(["Ryan", "Nick"], { dir, groupKey: "5110" });
  roomId = r.roomId;
  ryan = side(r.members[0], dir, true);
  nick = side(r.members[1], dir);
  front = await ryan.start({ title: "Front" });
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((res) => setTimeout(res, 20));
});
afterAll(() => {
  ryan.stop();
  nick.stop();
  fs.rmSync(sock, { force: true });
});

const rid = (id: string) => remoteSessionId(id, nick.m.id);
const viewOf = (id: string) => ryan.live.state().remote.find((s) => s.room?.sessionId === id);
const listed = async (id: string) => (await ask({ op: "list_sessions", from: front.id })).result.sessions.find((s: any) => s.id === rid(id));
const send = (id: string, message = "the API now returns organizationId") => ask({ op: "send_message", from: front.id, args: { to: rid(id), message } });

describe("a teammate's session someone can watch is one their agent can find and message", () => {
  it("a terminal running an agent: shown working in the room, listed with why, refused saying why — on both laptops", async () => {
    const term = await nick.start({ shell: true });
    nick.sessions.statusFromHook({ paneId: term.id, status: "working" }); // claude started by hand in it
    await until(() => viewOf(term.id)?.status === "working", "Ryan to see Nick's terminal working");
    expect(viewOf(term.id)!.room).toMatchObject({ live: true, online: true });

    const row = await listed(term.id);
    expect(row).toMatchObject({ title: "atticus-backoffice - nick", owner: "Nick", remote: true, status: "working", accepts_messages: false });
    expect(row.why).toMatch(/terminal on Nick's Mac.*never typed into terminals/);

    const r = await send(term.id);
    expect(r.error).toMatch(/^Refused by Nick's Mockingbird: Nick's session "atticus-backoffice - nick": it's a terminal on Nick's Mac/);
    expect(r.error).not.toMatch(/no running session/);
    expect(nick.log.at(-1)).toMatchObject({ to: term.id, refused: true, outcome: expect.stringMatching(/^refused: .*terminal/) });
    expect(nick.lines.at(-1)).toMatch(/refused a message from Ryan's session "Front" to session .* terminal/);
    expect(ryan.log.at(-1)).toMatchObject({ to: rid(term.id), refused: true, outcome: expect.stringMatching(/^refused: .*terminal/) });
    expect(ryan.lines.at(-1)).toMatch(/Nick's Mockingbird refused a message to .*terminal/);
  });

  it("every session Ryan sees running in the room is listed by the same id, and a listed one that takes messages gets them", async () => {
    await nick.start({ title: "Attom Migration" });
    await nick.start({ title: "API work", taskGroup: "5110/api" });
    await nick.start({ title: "No repo", repoPath: null, cwd: undefined });
    const gone = await nick.start({ title: "Exited" });
    ptyOf(gone.id).exit(1);
    await until(() => viewOf(gone.id)?.status === "dead", "the exit to reach Ryan");
    await until(() => ryan.live.state().remote.length === nick.sessions.list().length, "every Nick pane to reach Ryan");

    const rows = (await ask({ op: "list_sessions", from: front.id })).result.sessions.filter((s: any) => s.remote);
    const watched = ryan.live.state().remote.filter((s) => s.room?.live);
    expect(rows.map((s: any) => s.id).sort()).toEqual(watched.map((s) => rid(s.room!.sessionId)).sort());
    for (const row of rows) {
      const r = await send(row.id.split("@")[0], "ping");
      if (row.accepts_messages === false) expect(r.error, row.title).toContain(row.why);
      else expect(r.result, row.title).toMatch(/^Delivered to /);
    }
    expect(rows.find((s: any) => s.title === "Exited")).toMatchObject({ accepts_messages: false, why: expect.stringMatching(/agent has exited on Nick's Mac/) });
  });

  it("a closed session stays in the room as resumable, and a message to it says it was closed", async () => {
    const s = await nick.start({ title: "Closed one" });
    await until(() => !!viewOf(s.id), "the record");
    nick.sessions.kill(s.id);
    await until(() => viewOf(s.id)?.room?.live === false, "the close to reach Ryan");
    expect(await listed(s.id)).toBeUndefined();
    expect((await send(s.id)).error).toMatch(/Nick's session "Closed one": Nick closed it; only Nick can resume it/);
  });

  it("a session moved out of the room is retracted, and refused without naming the group it went to", async () => {
    const s = await nick.start({ title: "Moving out" });
    await until(() => !!viewOf(s.id), "the record");
    nick.sessions.setGroup(s.id, "private-spike");
    await until(() => !viewOf(s.id), "the record to be retracted");
    expect(await listed(s.id)).toBeUndefined();
    const r = await send(s.id);
    expect(r.error).toMatch(/Nick's Mockingbird has no session ".*" in this room: it was closed for good, moved out of the room, or the id is wrong/);
    expect(r.error).not.toMatch(/private-spike|Moving out/);
  });

  it("a session in another room both are in is refused naming that room", async () => {
    const other = ryan.m.team.createRoom({ name: "Attom", groupKey: "attom", signalingUrl: "http://loopback.invalid" });
    nick.m.team.join(ryan.m.team.createInvite(other.id));
    await until(() => nick.m.team.room(other.id)?.members.length === 2 && nick.m.team.presence(other.id).length === 1, "Nick to join the second room");
    const group = nick.m.team.status().rooms.find((r) => r.id === other.id)!.groupKey;
    const s = await nick.start({ title: "Attom work", taskGroup: group });
    await until(() => !!viewOf(s.id), "the record in the other room");
    const r = await send(s.id);
    expect(r.error).toMatch(/Nick's session "Attom work" is in the room "Attom", not this one: only sessions in that room can message it/);
  });

  it("a session taken over is refused with where it continues", async () => {
    const s = await nick.start({ title: "Handed over" });
    await until(() => !!viewOf(s.id), "the record");
    const sha = "a".repeat(40);
    nick.m.team.publish(roomId, "session.backup", {
      sessionId: s.id,
      sha,
      takenAt: Date.now(),
      push: { ok: true, at: Date.now() },
      toOrigin: false,
      session: { title: "Handed over", agent: "claude", branch: "dev", originUrl: "https://github.com/acme/atticus-backoffice.git", cwd: "/w/x", conversationId: null },
      transcriptBytes: null,
    } as any);
    await until(() => !!ryan.m.team.room(roomId)?.ext.takeover?.sessions[s.id], "the backup to reach Ryan");
    // Nick handed it over: his signed grant, for Ryan and that snapshot
    const grant = signGrant(nick.m.team, { kind: "handover", roomId, sessions: [s.id], to: ryan.m.id, sha, issuedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    ryan.m.team.publish(roomId, "session.takenOver", { sessionId: s.id, newSessionId: "beef0001", from: nick.m.id, snapshot: { sha, takenAt: Date.now(), source: "peer" }, conversation: "none", branch: "dev", grant } as any);
    await until(() => !!nick.m.team.room(roomId)?.ext.takeover?.sessions[s.id]?.takenOver, "the take-over to reach Nick");
    const r = await send(s.id);
    expect(r.error).toMatch(/Nick's session "Handed over" was taken over: it continues in your own Mockingbird, as "beef0001"/);
  });
});
