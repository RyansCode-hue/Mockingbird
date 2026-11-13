import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRepo, tempDir } from "./helpers";
import { loopbackMember, loopbackRoom, until, LoopbackNetwork, type LoopbackMember } from "../src/main/team/loopback";
import { TeamService } from "../src/main/team/service";
import type { TeamCore } from "../src/main/team/transport";
import { SessionManager } from "../src/main/sessions";
import { LivePanes, type LivePanesDeps } from "../src/main/team/livePanes";
import { onTurnEnded, isRoomSession, originIdentity, roomOfSession, setRoomSessionLookup, validateRecord, type TurnEnded } from "../src/main/team/roomSessions";
import { DEFAULT_SETTINGS, type NewSessionRequest, type Settings } from "../src/shared/types";
import { CLAUDE_ROOM_SANDBOX_SINCE, CODEX_ROOM_GUARD_SINCE, decodePtyChunk, encodePtyChunk, remotePaneId, type RoomSessionRecord } from "../src/shared/team/livePanes";
import { CODEX_ROOM_PROFILE } from "../src/main/codexRoomSandbox";
import { HouseService } from "../src/main/team/houseService";
import { claudeToolName } from "../src/main/messaging";
import { ROOM_CONTEXT_ENV } from "../src/shared/team/claims";
import { HOUSE_READ_TOOLS, HOUSE_TOOL_NAMES, HOUSE_WRITE_TOOLS } from "../src/shared/team/house";
import { ARTIFACT_TOOL } from "../src/shared/team/artifacts";
import { RemoteAudit } from "../src/main/team/remoteAudit";
import capture from "./fixtures/codex-folder-notice-0.156.1.json";
import { git } from "../src/main/git";
import { quote } from "../src/main/shell";
import { probeRoomSandbox, type SandboxProbe, type SandboxVerdict } from "../src/main/claudeSandboxProbe";
import { readVersionAt } from "../src/main/binPins";
import { LandscapeStore } from "../src/main/landscape";
import { WireService } from "../src/main/wires";

/** Every pty a session manager starts: its command, environment and what was written to it. */
type FakePty = { args: string[]; env: Record<string, string>; writes: string[]; emit(d: string): void; exit(code: number): void };
const ptys: FakePty[] = [];
vi.mock("node-pty", () => ({
  spawn: (_file: string, args: string[], opts: { env: Record<string, string> }) => {
    let onData: (d: string) => void = () => {};
    let onExit: (e: { exitCode: number }) => void = () => {};
    const p: FakePty = { args, env: opts.env, writes: [], emit: (d) => onData(d), exit: (exitCode) => onExit({ exitCode }) };
    ptys.push(p);
    return {
      onData: (cb: any) => ((onData = cb), { dispose() {} }),
      onExit: (cb: any) => ((onExit = cb), { dispose() {} }),
      write: (d: string) => p.writes.push(d),
      resize() {},
      kill() {},
      pid: 1,
    };
  },
}));
const ptyOf = (id: string) => ptys.filter((p) => p.env.MOCKINGBIRD_SESSION === id).at(-1)!;

const FAST = { publishMs: 80, batchMs: 1, heartbeatMs: 100, viewTtlMs: 3000, leaseMs: 3000, resyncMs: 30, gitMs: 60_000 };
const running: LivePanes[] = [];
const managers: SessionManager[] = [];
afterEach(() => {
  for (const l of running.splice(0)) l.stop();
  // its panes are fakes that never end: nothing of a finished test's keeps watching Claude Code's settings
  for (const s of managers.splice(0)) s.killAll();
});

/** One member's Mockingbird: its sessions, live panes, and what reached its window, notifications and audit log. */
function side(m: LoopbackMember, dir: string, over: Partial<LivePanesDeps> = {}, saved: any[] = []) {
  const wt = path.join(dir, m.name, "WorkTracker");
  fs.mkdirSync(path.join(wt, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(wt, "config.json"), JSON.stringify({ azureDevOps: { orgUrl: "https://dev.azure.com/acme", project: "P", patFile: "secrets/ado.pat" } }));
  const settings: Settings = { ...DEFAULT_SETTINGS, claudeBin: "/bin/echo", codexBin: "/bin/echo", workTrackerPath: wt };
  const store = {
    settings,
    state: { sessions: saved },
    upsertSession(i: any) {
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
  managers.push(sessions);
  sessions.scrollbackDir = path.join(dir, m.name, "scrollback");
  // a Claude Code new enough for the room's sandbox, whose own account of it shows it on (its tests below say otherwise)
  sessions.setAgentVersions({ claude: CLAUDE_ROOM_SANDBOX_SINCE });
  // the file a room launch runs says the version set as installed (binPins.test.ts reads real files)
  sessions.readVersionAt = async () => sessions.agentVersions.claude ?? null;
  sessions.sandboxProbe = async () => ({ ok: true, why: null, log: "ok: a stand-in Claude Code" });
  const window: unknown[][] = [];
  const notes: { title: string; body: string; paneId: string }[] = [];
  const audits: string[] = [];
  const logs: string[] = [];
  const base = path.join(dir, m.name, "live");
  const remoteAudit = new RemoteAudit({ file: path.join(dir, m.name, "audit.log"), log: (c, e) => logs.push(`${c}: ${e}`), timing: { quietMs: 20 } });
  remoteAudit.watch(m.team);
  const live = new LivePanes({
    team: () => m.team,
    rooms: () => m.team.status().rooms.map((r) => ({ id: r.id, groupKey: r.groupKey })),
    sessions,
    settings: () => settings,
    notify: (title, body, paneId) => notes.push({ title, body, paneId }),
    toWindow: (...a) => window.push(a),
    audit: (l) => audits.push(l),
    remoteAudit,
    log: (c, e) => {
      logs.push(`${c}: ${e instanceof Error ? e.message : e}`);
      return String(e);
    },
    gitState: async () => ({ dirty: true, dirtyFiles: 2, branch: "5110-donors", upstream: "origin/dev", ahead: 1, behind: 0, insertions: 10, deletions: 2 }),
    originOf: async () => "https://ryan:ghp_secret@github.com/acme/backoffice.git?x=1",
    gitEmail: async () => `${m.name.toLowerCase()}@example.com`,
    dir: base,
    hooksDir: path.join(base, "githooks"),
    coauthorsDir: path.join(base, "coauthors"),
    cachesDir: path.join(base, "caches"),
    markerScript: path.join(base, "room-sandbox.sh"),
    // the user's own Codex MCP servers, as `codex mcp list` names them
    codexMcpServers: async () => ["github", "dotted.name"],
    timing: FAST,
    ...over,
  });
  live.start();
  running.push(live);
  // a room's session never works at home (roomFolderRefusal): a repo-less one is given a folder of its own
  const work = path.join(dir, m.name, "work");
  fs.mkdirSync(work, { recursive: true });
  const start = (req: Partial<NewSessionRequest> = {}) => sessions.create({ repoPath: null, useWorktree: false, cwd: work, agent: "claude", taskGroup: "5110", title: "donors", ...req });
  /** What the window was sent for a pane, as its terminal would show it. */
  const shown = (paneId: string) => window.filter((w) => w[0] === "session:data" && w[1] === paneId).map((w) => w[2]).join("");
  return { m, settings, sessions, live, window, notes, audits, logs, store, start, shown, remoteAudit };
}

async function pair(over: Partial<LivePanesDeps> = {}) {
  const dir = tempDir("live");
  const { members, roomId, net } = await loopbackRoom(["Ryan", "Nick"], { dir, groupKey: "5110" });
  const [ryan, nick] = members.map((m) => side(m, dir, over));
  return { dir, roomId, net, ryan, nick };
}

/**
 * What a Claude room launch's settings and Mockingbird's own SessionStart hook report as it starts (RoomSandboxWatch),
 * and the launch settled: Claude Code's own account of its sandbox (claudeSandboxProbe.ts) comes in its own time.
 */
async function reportIn(s: ReturnType<typeof side>, id: string, o: { late?: boolean; marker?: string } = {}) {
  const marker = o.marker ?? /room-sandbox\.sh\\" ([0-9a-f]+)/.exec(ptyOf(id).args.join(" "))![1];
  s.sessions.roomSandboxReported(id, marker, !!o.late);
  s.sessions.statusFromHook({ paneId: id, status: "idle", started: true });
  await until(() => !s.sessions.guardsOf(id)?.starting, "its sandbox settled");
}

/** The room one of this install's own sessions is in, as its window's state tags it; undefined until it does. */
const remoteOfOwn = (s: ReturnType<typeof side>, id: string): string | undefined => s.live.state().own[id]?.roomId;

const remoteOf = (s: ReturnType<typeof side>, id: string) => s.live.state().remote.find((r) => r.room?.sessionId === id);

/** `viewer` asks to type into `owner`'s session, and the owner allows it ("session": while it runs, "minutes": for 15). */
async function allowTyping(owner: ReturnType<typeof side>, viewer: ReturnType<typeof side>, sessionId: string, choice: "session" | "minutes" = "session") {
  await until(() => !!remoteOf(viewer, sessionId), "the record");
  await viewer.live.askToType(remotePaneId(owner.m.id, sessionId));
  await until(() => owner.live.state().own[sessionId]?.typingAsks?.some((a) => a.member === viewer.m.id) ?? false, "the ask");
  owner.live.decideTyping(sessionId, viewer.m.id, choice);
  await until(() => remoteOf(viewer, sessionId)?.room?.typing?.state === "allowed", "the allowance at the viewer's");
}

describe("room sessions in the room log", () => {
  it("every member sees a session started in the shared group, tagged with its owner; sessions outside it stay private", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start({ repoPath: null, ticketId: "5110", ticketTitle: "Donor entities" });
    const own = await ryan.start({ taskGroup: "private", title: "mine" });
    await until(() => !!remoteOf(nick, s.id), "Nick to see Ryan's session");
    const r = remoteOf(nick, s.id)!;
    expect(r).toMatchObject({ id: remotePaneId(ryan.m.id, s.id), title: "donors", ticketTitle: "Donor entities", taskGroup: "5110", status: "working", kind: "work", repoPath: null, agent: "claude" });
    expect(r.room).toMatchObject({ owner: ryan.m.id, ownerName: "Ryan", remote: true, online: true, live: true, cols: 120, rows: 32, guards: { secrets: true, coauthors: true } });
    expect(nick.live.state().remote.map((x) => x.room?.sessionId)).not.toContain(own.id);
    expect(roomOfSession(own.id)).toBeNull();
    // the owner's own pane is tagged too
    expect(ryan.live.state().own[s.id]).toMatchObject({ remote: false, ownerName: "Ryan" });
  });

  it("publishes waiting at once, coalesces the rest, and removes a session closed for good", async () => {
    const { ryan, nick, roomId } = await pair();
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "the record");
    const count = () => nick.m.team.room(roomId)!.events;
    const before = count();
    for (let i = 0; i < 10; i++) ryan.sessions.statusFromHook({ paneId: s.id, status: i % 2 ? "working" : "idle" });
    ryan.sessions.statusFromHook({ paneId: s.id, status: "waiting", reason: "Claude needs your permission to use Bash" });
    await until(() => remoteOf(nick, s.id)?.status === "waiting", "the wait to arrive");
    expect(remoteOf(nick, s.id)).toMatchObject({ waitingReason: "Claude needs your permission to use Bash" });
    await new Promise((r) => setTimeout(r, 300));
    expect(count() - before).toBeLessThanOrEqual(3);
    ryan.sessions.kill(s.id, true);
    await until(() => !remoteOf(nick, s.id), "the removal");
  });

  it("never publishes credentials in a repository's origin", () => {
    expect(originIdentity("https://ryan:ghp_secret@github.com/acme/backoffice.git?x=1")).toBe("https://github.com/acme/backoffice.git");
    expect(originIdentity("git@github.com:acme/backoffice.git")).toBe("git@github.com:acme/backoffice.git");
    expect(originIdentity("not a url with spaces")).toBeNull();
  });

  it("refuses malformed records", () => {
    const ok: RoomSessionRecord = {
      id: "abc", title: "t", agent: "claude", status: "idle", waitingReason: null, waitingSince: null, branch: null, repo: null, repoName: null, ticketId: null, ticketTitle: null,
      sub: null, model: null, createdAt: 1, live: true, cols: 80, rows: 24, guards: { secrets: true, coauthors: true }, git: null,
    };
    expect(() => validateRecord(ok)).not.toThrow();
    expect(() => validateRecord({ ...ok, id: "../x" })).toThrow(/session id/);
    expect(() => validateRecord({ ...ok, status: "gone" })).toThrow(/status/);
    expect(() => validateRecord({ ...ok, cols: 1e9 })).toThrow(/cols/);
    expect(() => validateRecord({ ...ok, git: { branch: 1 } })).toThrow(/git/);
    expect(() => validateRecord({ ...ok, repo: "https://ryan:ghp_secret@github.com/acme/backoffice.git" })).toThrow(/credentials/);
    expect(() => validateRecord({ ...ok, repo: "git@github.com:acme/backoffice.git" })).not.toThrow();
  });

  it("keeps room sessions through the owner's restart: closed, then live again under the same pane", async () => {
    const dir = tempDir("live");
    const { members, net } = await loopbackRoom(["Ryan", "Nick"], { dir, groupKey: "5110" });
    const saved: any[] = [];
    let ryan = side(members[0], dir, {}, saved);
    const nick = side(members[1], dir);
    const s = await ryan.start();
    await until(() => remoteOf(nick, s.id)?.room?.live === true, "the session");
    // Ryan quits: the pane is closed but resumable (its record stays in his store)
    ryan.live.stop();
    ryan.m.team.close();
    await until(() => remoteOf(nick, s.id)?.room?.online === false, "Nick to see Ryan offline");
    expect(remoteOf(nick, s.id)?.id).toBe(remotePaneId(members[0].id, s.id));
    // Ryan's Mockingbird starts again, with the same identity and rooms
    const again = loopbackMember(net as LoopbackNetwork, "Ryan", dir);
    ryan = side(again, dir, {}, saved);
    await until(() => remoteOf(nick, s.id)?.room?.online === true && remoteOf(nick, s.id)?.room?.live === false, "the session as closed, owner back");
    expect(remoteOf(nick, s.id)?.status).toBe("dead");
    await ryan.sessions.relaunch(s.id);
    await until(() => remoteOf(nick, s.id)?.room?.live === true, "the relaunched session");
    expect(remoteOf(nick, s.id)?.id).toBe(remotePaneId(members[0].id, s.id));
  });
});

describe("the Helpdesk tasks workspace and a room", () => {
  it("never starts in or moves into a room's area, and is never shared from one it finds itself in", async () => {
    const { ryan, nick } = await pair();
    ryan.sessions.readClaudeHelp = async () => "  --chrome  Enable Claude in Chrome integration\n";
    await expect(ryan.start({ role: "tasks", title: "Helpdesk tasks" })).rejects.toThrow(/never runs in a team room's area/);
    const h = await ryan.start({ role: "tasks", taskGroup: "Helpdesk", title: "Helpdesk tasks" });
    expect(() => ryan.sessions.setGroup(h.id, "5110/sub")).toThrow(/never runs in a team room's area/);
    // as a room joined under its area's name would leave it: in the room's area all the same
    (ryan.sessions as any).live.get(h.id).info.taskGroup = "5110";
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "Nick to see Ryan's room session");
    expect(remoteOf(nick, h.id)).toBeUndefined();
    expect(roomOfSession(h.id)).toBeNull();
  });
});

describe("live panes", () => {
  it("streams only what a teammate shows: scrollback first, then live output", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start();
    ptyOf(s.id).emit("before anyone looked\r\n");
    await until(() => !!remoteOf(nick, s.id), "the record");
    const paneId = remotePaneId(ryan.m.id, s.id);
    const streamed: string[] = [];
    nick.m.team.onStream("pty:*", (c) => streamed.push(c));
    ptyOf(s.id).emit("unwatched\r\n");
    await new Promise((r) => setTimeout(r, 50));
    expect(streamed).toEqual([]); // nobody shows it: nothing is streamed
    nick.live.setView({ shown: [paneId], focused: paneId });
    expect(await nick.sessions.paneBuffer(paneId)).toBe("before anyone looked\r\nunwatched\r\n");
    ptyOf(s.id).emit("live\r\n");
    await until(() => nick.shown(paneId) === "live\r\n", "live output");
    // Nick hides the pane: once his view arrives, Ryan stops streaming it
    nick.live.setView({ shown: [], focused: null });
    await until(() => ryan.live.state().own[s.id].lookers.length === 0, "Ryan to hear Nick's view");
    await new Promise((r) => setTimeout(r, FAST.leaseMs + 200));
    const n = streamed.length;
    ptyOf(s.id).emit("hidden\r\n");
    await new Promise((r) => setTimeout(r, 80));
    expect(streamed.length).toBe(n);
  });

  it("redraws a pane shown again after a spell hidden, and never one that stayed on screen", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "the record");
    const paneId = remotePaneId(ryan.m.id, s.id);
    // the pane's terminal asks for the scrollback as it opens, before the window's view says it's shown
    await nick.sessions.paneBuffer(paneId);
    nick.live.setView({ shown: [paneId], focused: null });
    ptyOf(s.id).emit("live\r\n");
    await until(() => nick.shown(paneId) === "live\r\n", "live output");
    // still shown, now focused: a redraw would throw away where the viewer had scrolled to
    nick.live.setView({ shown: [paneId], focused: paneId });
    await new Promise((r) => setTimeout(r, FAST.resyncMs * 4));
    expect(nick.shown(paneId)).toBe("live\r\n");
    // hidden, then shown again: it may have missed output, so it's redrawn from the scrollback
    nick.live.setView({ shown: [], focused: null });
    nick.live.setView({ shown: [paneId], focused: paneId });
    await until(() => nick.shown(paneId).endsWith("\x1bclive\r\n"), "the redraw");
  });

  it("catches up from the scrollback after a gap in the stream", async () => {
    const { ryan, nick, net } = await pair();
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "the record");
    const paneId = remotePaneId(ryan.m.id, s.id);
    nick.live.setView({ shown: [paneId], focused: null });
    await nick.sessions.paneBuffer(paneId);
    ptyOf(s.id).emit("one ");
    await until(() => nick.shown(paneId) === "one ", "the first chunk");
    net.congest(ryan.m.id, nick.m.id, true); // a congested pipe drops chunks
    ptyOf(s.id).emit("lost ");
    await new Promise((r) => setTimeout(r, 30));
    net.congest(ryan.m.id, nick.m.id, false);
    ptyOf(s.id).emit("three");
    // the next chunk starts past what Nick has: he fetches the scrollback and redraws from it
    await until(() => nick.shown(paneId).endsWith("\x1bcone lost three"), "the redraw");
  });

  it("redraws a teammate's pane when its session restarts (a new pty)", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "the record");
    const paneId = remotePaneId(ryan.m.id, s.id);
    nick.live.setView({ shown: [paneId], focused: null });
    await nick.sessions.paneBuffer(paneId);
    ptyOf(s.id).emit("old pty\r\n");
    await until(() => nick.shown(paneId).includes("old pty"), "output");
    await ryan.sessions.restart(s.id);
    ptyOf(s.id).emit("new pty\r\n");
    await until(() => /\x1bc[^]*restarted[^]*new pty/.test(nick.shown(paneId)), "the redraw from the new pty");
  });

  it("catches up a teammate's pane whose session comes back after its record said it had ended", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "the record");
    const paneId = remotePaneId(ryan.m.id, s.id);
    nick.live.setView({ shown: [paneId], focused: null });
    await nick.sessions.paneBuffer(paneId);
    ptyOf(s.id).emit("old pty\r\n");
    await until(() => nick.shown(paneId).includes("old pty"), "output");
    // the restart's launch takes long enough for the ended record to reach Nick first
    const launch = ryan.sessions.roomLaunch!;
    ryan.sessions.roomLaunch = async (t) => {
      await until(() => remoteOf(nick, s.id)?.room?.live === false, "the ended record");
      // and for Nick's view to come again meanwhile (every 100 ms here), while Ryan's session is between its ptys
      await new Promise((r) => setTimeout(r, 300));
      return launch(t);
    };
    await ryan.sessions.restart(s.id);
    ptyOf(s.id).emit("new pty\r\n");
    await until(() => /\x1bc[^]*new pty/.test(nick.shown(paneId)), "the redraw from the new pty");
  });

  it("keeps a session a teammate shows streamed across a restart, so its new pty's first output isn't dropped", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "the record");
    nick.live.setView({ shown: [remotePaneId(ryan.m.id, s.id)], focused: null });
    const watched = () => (ryan.live["watchedOwn"] as Set<string>).has(s.id);
    await until(watched, "Nick's view");
    // a view comes while the session is between its ptys
    const launch = ryan.sessions.roomLaunch!;
    ryan.sessions.roomLaunch = async (t) => {
      ryan.live["recomputeWatched"]();
      return launch(t);
    };
    await ryan.sessions.restart(s.id);
    expect(watched()).toBe(true);
  });

  it("chunks say where they start; anything else isn't a chunk", () => {
    const c = { session: "ab-1", epoch: "e1", pos: 42, data: "x\ny" };
    expect(decodePtyChunk(encodePtyChunk(c))).toEqual(c);
    expect(decodePtyChunk("p1|a|b|nope\nx")).toBeNull();
    expect(decodePtyChunk("no header")).toBeNull();
  });

  it("shows the last copy, saying so, when the owner is offline", async () => {
    const { ryan, nick, net } = await pair();
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "the record");
    const paneId = remotePaneId(ryan.m.id, s.id);
    nick.live.setView({ shown: [paneId], focused: null });
    await nick.sessions.paneBuffer(paneId);
    ptyOf(s.id).emit("last words\r\n");
    await until(() => nick.shown(paneId).includes("last words"), "output");
    net.setOnline(ryan.m.id, false);
    await until(() => remoteOf(nick, s.id)?.room?.online === false, "Ryan offline");
    expect(await nick.sessions.paneBuffer(paneId)).toMatch(/last words[^]*Ryan's Mockingbird is offline/);
  });
});

describe("typing into a teammate's session", () => {
  it("reaches the owner's pty and is audited; a terminal's automatic answers never are", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start();
    await allowTyping(ryan, nick, s.id);
    const paneId = remotePaneId(ryan.m.id, s.id);
    nick.sessions.write(paneId, "fix the ");
    nick.sessions.write(paneId, "tests\r");
    await until(() => ptyOf(s.id).writes.join("") === "fix the tests\r", "the typing");
    expect(ryan.audits.some((l) => l.startsWith(`remote-input session=${s.id} from="Nick"`))).toBe(true);
    nick.sessions.write(paneId, "\x1b[12;5R"); // a cursor-position answer
    await new Promise((r) => setTimeout(r, 50));
    expect(ptyOf(s.id).writes.join("")).toBe("fix the tests\r");
    expect(ryan.audits.some((l) => l.startsWith(`dropped-remote-reply session=${s.id}`))).toBe(true);
    // a session outside the room can't be typed into, even by naming it
    const own = await ryan.start({ taskGroup: "private" });
    await expect(nick.m.team.request(ryan.m.id, "pty.input", { session: own.id, data: "rm -rf ~\r" }, { roomId: remoteOf(nick, s.id)!.room!.roomId })).rejects.toThrow(/isn't running in this room/);
    expect(ptyOf(own.id).writes).toEqual([]);
  });

  it("holds a teammate's typing into a Codex room session until its Codex has opened its folder: a \"2\" never reaches the notice", async () => {
    const { ryan, nick } = await pair();
    ryan.sessions.setAgentVersions({ codex: CODEX_ROOM_GUARD_SINCE });
    ryan.sessions.folderNoticeTiming = { settleMs: 60_000 };
    const s = await ryan.start({ agent: "codex" });
    ptyOf(s.id).emit(capture.fresh.beforeEnter);
    await allowTyping(ryan, nick, s.id);
    nick.sessions.write(remotePaneId(ryan.m.id, s.id), "2\r");
    await until(() => ryan.audits.some((l) => l.startsWith(`remote-input session=${s.id} from="Nick"`)), "Nick's typing at Ryan's");
    expect(ptyOf(s.id).writes).toEqual([]);
    // Ryan answers it himself: Codex opens, and what Nick typed goes
    ryan.sessions.write(s.id, "\r");
    ptyOf(s.id).emit(capture.fresh.afterEnter);
    expect(ptyOf(s.id).writes).toEqual(["\r", "2\r"]);
  });

  it("never lets a teammate's wheel, clicks or PageUp/PageDown move the owner's view; their typing still arrives", async () => {
    let clock = 1_000_000;
    const { ryan, nick } = await pair({ now: () => clock });
    const s = await ryan.start();
    await allowTyping(ryan, nick, s.id);
    const paneId = remotePaneId(ryan.m.id, s.id);
    const tick = () => new Promise((r) => setImmediate(r)); // each write its own pty.input
    // what an older Mockingbird's pane sends while its terminal tracks the mouse, and its paging keys
    for (const d of ["\x1b[<64;40;12M\x1b[<64;40;12M", "\x1b[<65;40;12M", "\x1b[<0;3;4M\x1b[<0;3;4m", "\x1b[5~", "\x1b[6~"]) {
      nick.sessions.write(paneId, d);
      await tick();
    }
    // typing, Ctrl-C, arrow keys and a bracketed paste holding a report-shaped text are typing
    const typed = ["fix it\r", "\x03", "\x1b[A\x1b[A", "\x1b[200~\x1b[<64;1;1M\x1b[201~", "done\r"];
    for (const d of typed) {
      nick.sessions.write(paneId, d);
      await tick();
    }
    await until(() => ptyOf(s.id).writes.join("").endsWith("done\r"), "the typing");
    expect(ptyOf(s.id).writes).toEqual(typed);
    // dropped on purpose and said so in the audit log, once a minute per teammate rather than per notch
    expect(ryan.audits.filter((l) => l.startsWith(`dropped-remote-view-input session=${s.id} from="Nick"`))).toHaveLength(1);
    clock += 60_000;
    nick.sessions.write(paneId, "\x1b[<64;40;12M");
    await tick();
    nick.sessions.write(paneId, "x");
    await until(() => ptyOf(s.id).writes.at(-1) === "x", "the next keystroke");
    expect(ryan.audits.filter((l) => l.startsWith(`dropped-remote-view-input session=${s.id}`))).toHaveLength(2);
    expect(ptyOf(s.id).writes).toEqual([...typed, "x"]);
  });

  it("says when the owner can't be reached", async () => {
    const { ryan, nick, net } = await pair();
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "the record");
    net.setOnline(ryan.m.id, false);
    await until(() => remoteOf(nick, s.id)?.room?.online === false, "Ryan offline");
    nick.sessions.write(remotePaneId(ryan.m.id, s.id), "hello");
    await until(() => !!remoteOf(nick, s.id)?.room?.problem, "the problem");
    expect(remoteOf(nick, s.id)!.room!.problem).toMatch(/Couldn't type into donors: Ryan isn't connected/);
  });

  it("credits the teammate in the turn they typed into, and says when each turn ends", async () => {
    const { ryan, nick } = await pair();
    const ended: TurnEnded[] = [];
    const off = onTurnEnded((e) => ended.push(e));
    try {
      const s = await ryan.start();
      ryan.sessions.statusFromHook({ paneId: s.id, status: "idle" });
      await until(() => remoteOf(nick, s.id)?.status === "idle", "the record");
      await allowTyping(ryan, nick, s.id);
      // one Mockingbird per process answers for its own sessions; here both run in one
      setRoomSessionLookup(ryan.live);
      expect(isRoomSession(s.id)).toBe(true);
      expect(roomOfSession(s.id)).toBe(remoteOf(nick, s.id)!.room!.roomId);
      nick.sessions.write(remotePaneId(ryan.m.id, s.id), "add the export\r");
      await until(() => ptyOf(s.id).writes.length > 0, "the typing");
      ryan.sessions.statusFromHook({ paneId: s.id, status: "working" });
      const list = path.join(ryan.live["d"].coauthorsDir!, s.id);
      expect(fs.readFileSync(list, "utf8")).toBe("Nick <nick@example.com>\n");
      ryan.sessions.statusFromHook({ paneId: s.id, status: "idle" });
      expect(fs.existsSync(list)).toBe(false);
      expect(ended.at(-1)).toMatchObject({ sessionId: s.id, status: "idle", drivers: [{ id: nick.m.id, name: "Nick", email: "nick@example.com" }] });
      // a turn nobody else typed into ends with no drivers
      ryan.sessions.statusFromHook({ paneId: s.id, status: "working" });
      ryan.sessions.statusFromHook({ paneId: s.id, status: "idle" });
      expect(ended.at(-1)!.drivers).toEqual([]);
    } finally {
      off();
    }
  });
});

describe("typing needs the owner's consent", () => {
  const settle = () => new Promise((r) => setTimeout(r, 60));
  /** pty.input as a modified client (or a newer one, with `v`) would send it straight to the owner. */
  const raw = (viewer: ReturnType<typeof side>, owner: ReturnType<typeof side>, sessionId: string, data: string, v?: number) =>
    viewer.m.team.request<any>(owner.m.id, "pty.input", { session: sessionId, data, ...(v ? { v } : {}) }, { roomId: remoteOf(viewer, sessionId)!.room!.roomId });

  it("a teammate's copy is view-only: their keys never reach the pty, they see why, and the owner is asked", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "the record");
    const paneId = remotePaneId(ryan.m.id, s.id);
    nick.sessions.write(paneId, "rm -rf ~\r");
    await until(() => remoteOf(nick, s.id)?.room?.typing?.state === "asked", "the ask, from typing");
    expect(ptyOf(s.id).writes).toEqual([]);
    expect(remoteOf(nick, s.id)!.room!.typing!.refused?.why).toMatch(/^Ryan hasn't allowed you to type in "donors"/);
    // the owner sees who asks, and is notified
    await until(() => ryan.live.state().own[s.id]?.typingAsks?.length === 1, "the ask at Ryan's");
    expect(ryan.live.state().own[s.id].typingAsks![0]).toMatchObject({ member: nick.m.id, name: "Nick" });
    expect(ryan.notes).toEqual([{ title: "Nick wants to type", body: 'In "donors": allow it or not in Needs you, or on its workspace', paneId: s.id }]);
    // more keys while asked: held here, said so, and never sent
    nick.sessions.write(paneId, "ls\r");
    await settle();
    expect(remoteOf(nick, s.id)!.room!.typing!.refused?.why).toBe("Waiting for Ryan to let you type");
    expect(ptyOf(s.id).writes).toEqual([]);
  });

  it("is decided on the owner's Mac: a client that skips its own checks is refused, and an older one is told why without losing the connection", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "the record");
    // a current Mockingbird's request: refused with where it stands
    expect(await raw(nick, ryan, s.id, "rm -rf ~\r", 2)).toEqual({ ok: false, typing: { session: s.id, state: "view-only", why: `Ryan hasn't allowed you to type in "donors"` } });
    // an older Mockingbird's (no v): an error its pane shows as it is
    await expect(raw(nick, ryan, s.id, "rm -rf ~\r")).rejects.toThrow(/Ryan hasn't allowed you to type in "donors" — a newer Mockingbird can ask them to let you type/);
    expect(ptyOf(s.id).writes).toEqual([]);
    // the connection carries on: the copy still loads
    expect(await nick.sessions.paneBuffer(remotePaneId(ryan.m.id, s.id))).toBe("");
    ptyOf(s.id).emit("still here\r\n");
    await until(() => nick.shown(remotePaneId(ryan.m.id, s.id)).includes("still here"), "output after the refusals");
  });

  it("allowed while the session runs: typing arrives; taken back: refused again, and the teammate told", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start();
    await allowTyping(ryan, nick, s.id);
    expect(ryan.live.state().own[s.id].typists).toEqual([{ member: nick.m.id, name: "Nick", until: null, at: expect.any(Number) }]);
    expect(ryan.live.state().own[s.id].typingAsks).toEqual([]);
    const paneId = remotePaneId(ryan.m.id, s.id);
    nick.sessions.write(paneId, "fix it\r");
    await until(() => ptyOf(s.id).writes.join("") === "fix it\r", "the typing");
    ryan.live.decideTyping(s.id, nick.m.id, "revoke");
    await until(() => remoteOf(nick, s.id)?.room?.typing?.state === "denied", "the revoke at Nick's");
    expect(remoteOf(nick, s.id)!.room!.typing!.refused?.why).toBe("Ryan stopped your typing");
    expect(ryan.live.state().own[s.id].typists).toEqual([]);
    nick.sessions.write(paneId, "more\r");
    await settle();
    expect(await raw(nick, ryan, s.id, "more\r", 2)).toMatchObject({ ok: false, typing: { state: "denied" } });
    expect(ptyOf(s.id).writes.join("")).toBe("fix it\r");
    // after a no, asking again waits a little
    await nick.live.askToType(paneId);
    expect(remoteOf(nick, s.id)!.room!.typing).toMatchObject({ state: "denied", refused: { why: "Ryan said no a moment ago: ask again in a minute" } });
  });

  it("allows only an ask that's pending: one never made, or answered already, is refused and grants nothing", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "the record");
    for (const choice of ["session", "minutes"] as const) expect(() => ryan.live.decideTyping(s.id, nick.m.id, choice)).toThrow(`Nick isn't asking to type in "donors": there's nothing to allow`);
    expect(ryan.live.state().own[s.id]?.typists ?? []).toEqual([]);
    // the ask answered with a no, then an allowance sent after it (a second click): still no
    await nick.live.askToType(remotePaneId(ryan.m.id, s.id));
    await until(() => ryan.live.state().own[s.id]?.typingAsks?.length === 1, "the ask");
    ryan.live.decideTyping(s.id, nick.m.id, "deny");
    expect(() => ryan.live.decideTyping(s.id, nick.m.id, "session")).toThrow(/there's nothing to allow/);
    await settle();
    expect(ryan.live.state().own[s.id].typists ?? []).toEqual([]);
    expect(remoteOf(nick, s.id)!.room!.typing!.state).toBe("denied");
    expect(await raw(nick, ryan, s.id, "x", 2)).toMatchObject({ ok: false });
    expect(ptyOf(s.id).writes).toEqual([]);
  });

  it("denied: the teammate is told, and nothing they type gets through", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "the record");
    await nick.live.askToType(remotePaneId(ryan.m.id, s.id));
    await until(() => ryan.live.state().own[s.id]?.typingAsks?.length === 1, "the ask");
    ryan.live.decideTyping(s.id, nick.m.id, "deny");
    await until(() => remoteOf(nick, s.id)?.room?.typing?.state === "denied", "the no at Nick's");
    expect(remoteOf(nick, s.id)!.room!.typing!.refused?.why).toBe("Ryan didn't allow typing");
    expect(await raw(nick, ryan, s.id, "x", 2)).toMatchObject({ ok: false });
    expect(ptyOf(s.id).writes).toEqual([]);
  });

  it("allowed for 15 minutes: refused once they're up, and the teammate told", async () => {
    let clock = 5_000_000;
    const { ryan, nick } = await pair({ now: () => clock });
    const s = await ryan.start();
    await allowTyping(ryan, nick, s.id, "minutes");
    expect(ryan.live.state().own[s.id].typists![0].until).toBe(5_000_000 + 15 * 60_000);
    expect(remoteOf(nick, s.id)!.room!.typing!.until).toBe(5_000_000 + 15 * 60_000);
    expect(await raw(nick, ryan, s.id, "a", 2)).toEqual({ ok: true });
    clock += 15 * 60_000;
    // refused at once on the owner's Mac, before any timer has said so
    expect(await raw(nick, ryan, s.id, "b", 2)).toMatchObject({ ok: false, typing: { state: "view-only" } });
    await until(() => remoteOf(nick, s.id)?.room?.typing?.state === "view-only", "the expiry at Nick's");
    expect(remoteOf(nick, s.id)!.room!.typing!.refused?.why).toBe("the 15 minutes Ryan allowed are up");
    expect(ryan.live.state().own[s.id].typists).toEqual([]);
    expect(ptyOf(s.id).writes).toEqual(["a"]);
  });

  it("never while the owner's agent asks for permission, even when allowed: the approval is the owner's", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start();
    await allowTyping(ryan, nick, s.id);
    const paneId = remotePaneId(ryan.m.id, s.id);
    ryan.sessions.statusFromHook({ paneId: s.id, status: "waiting", reason: "Claude needs your permission to use Bash" });
    await until(() => remoteOf(nick, s.id)?.status === "waiting", "the prompt at Nick's");
    // Nick's own Mockingbird holds his keys back and says why
    nick.sessions.write(paneId, "1");
    await settle();
    expect(remoteOf(nick, s.id)!.room!.typing!.refused?.why).toBe("Ryan's agent is asking for permission: only Ryan can answer it");
    // and Ryan's refuses them whatever sends them
    expect(await raw(nick, ryan, s.id, "\r", 2)).toEqual({ ok: false, typing: { session: s.id, state: "allowed", until: null, prompt: true, why: `Ryan's agent in "donors" is asking for permission: only Ryan can answer it` } });
    await expect(raw(nick, ryan, s.id, "y")).rejects.toThrow(/asking for permission: only Ryan can answer it — try again once they have/);
    expect(ptyOf(s.id).writes).toEqual([]);
    // Ryan answers it himself; Nick's typing goes through again
    ryan.sessions.write(s.id, "1");
    ryan.sessions.statusFromHook({ paneId: s.id, status: "working" });
    await until(() => remoteOf(nick, s.id)?.status === "working", "the turn at Nick's");
    nick.sessions.write(paneId, "after\r");
    await until(() => ptyOf(s.id).writes.join("") === "1after\r", "Nick's typing after the prompt");
  });

  it("ends with the session: a session closed and started again is view-only again", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start();
    await allowTyping(ryan, nick, s.id);
    ptyOf(s.id).exit(0);
    await until(() => ryan.sessions.list().find((x) => x.id === s.id)?.status === "dead", "the exit");
    await until(() => !ryan.live.state().own[s.id]?.typists?.length, "the allowance gone");
    expect(await raw(nick, ryan, s.id, "x", 2).catch((e) => String(e))).not.toEqual({ ok: true });
    ryan.remoteAudit.flush();
    expect(ryan.remoteAudit.recent().map((e) => e.kind)).toContain("typing.ended");
  });

  it("with an owner on a Mockingbird from before typing consent, typing goes through as it did", async () => {
    const { ryan, nick } = await pair();
    // Ryan's Mockingbird as it was: no typing answers, every member's keys taken
    const live = ryan.live as any;
    const scrollback = live.answerScrollback.bind(live);
    live.answerScrollback = (...a: unknown[]) => {
      const { typing: _t, ...snap } = scrollback(...a);
      return snap;
    };
    live.inputRefusal = () => null;
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "the record");
    const paneId = remotePaneId(ryan.m.id, s.id);
    await nick.sessions.paneBuffer(paneId);
    expect(remoteOf(nick, s.id)!.room!.typing).toEqual({ state: "legacy" });
    nick.sessions.write(paneId, "old ways\r");
    await until(() => ptyOf(s.id).writes.join("") === "old ways\r", "the typing");
  });

  it("is in the audit log by counts — asks, answers and keystrokes — never by what was typed", async () => {
    const { ryan, nick, dir } = await pair();
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "the record");
    const paneId = remotePaneId(ryan.m.id, s.id);
    nick.sessions.write(paneId, "secret-before");
    await until(() => ryan.live.state().own[s.id]?.typingAsks?.length === 1, "the ask");
    await raw(nick, ryan, s.id, "hunter2-refused", 2);
    ryan.live.decideTyping(s.id, nick.m.id, "minutes");
    await until(() => remoteOf(nick, s.id)?.room?.typing?.state === "allowed", "the allowance");
    for (const k of ["hunter2", "-typed", "\r"]) nick.sessions.write(paneId, k);
    await until(() => ptyOf(s.id).writes.join("") === "hunter2-typed\r", "the typing");
    ryan.live.decideTyping(s.id, nick.m.id, "revoke");
    await until(() => ryan.remoteAudit.recent().some((e) => e.kind === "input"), "the keystrokes counted");
    ryan.remoteAudit.flush();
    const file = path.join(dir, "Ryan", "audit.log");
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toMatch(/hunter2|secret-before|-typed/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const entries = text.trim().split("\n").map((l) => JSON.parse(l));
    const of = (kind: string) => entries.filter((e) => e.kind === kind);
    expect(of("typing.asked")).toEqual([expect.objectContaining({ member: "Nick", memberId: nick.m.id, session: s.id, title: "donors" })]);
    expect(of("input.refused")).toEqual([expect.objectContaining({ member: "Nick", reason: "view-only", n: 2, bytes: 28 })]);
    expect(of("typing.allowed")).toEqual([expect.objectContaining({ until: expect.any(Number) })]);
    expect(of("input")).toEqual([expect.objectContaining({ member: "Nick", session: s.id, n: expect.any(Number), bytes: 14 })]);
    expect(of("typing.revoked")).toHaveLength(1);
    // Nick's scrollback reads are there too, counted
    await nick.sessions.paneBuffer(paneId);
    ryan.remoteAudit.flush();
    expect(ryan.remoteAudit.recent().find((e) => e.kind === "scrollback")).toMatchObject({ member: "Nick", session: s.id, n: expect.any(Number) });
  });
});

describe("notifications for a teammate's waiting session", () => {
  it("reach every member, once per wait, under each member's own settings", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "the record");
    const paneId = remotePaneId(ryan.m.id, s.id);
    ryan.sessions.statusFromHook({ paneId: s.id, status: "waiting", reason: "Claude needs your permission to use Bash" });
    await until(() => nick.notes.length === 1, "Nick's notification");
    expect(nick.notes[0]).toEqual({ title: "Needs input · Ryan's session", body: "donors · Claude needs your permission to use Bash", paneId });
    expect(ryan.notes).toEqual([]); // the owner's own notification comes from its hooks, as for any session
    // muted on Nick's side only
    ryan.sessions.statusFromHook({ paneId: s.id, status: "working" });
    nick.sessions.setMuted(paneId, true);
    expect(remoteOf(nick, s.id)?.muted).toBe(true);
    ryan.sessions.statusFromHook({ paneId: s.id, status: "waiting", reason: "again" });
    await until(() => remoteOf(nick, s.id)?.waitingReason === "again", "the second wait");
    expect(nick.notes.length).toBe(1);
  });

  it("respects a member's quiet hours", async () => {
    const { ryan, nick } = await pair();
    nick.settings.quietHours = { enabled: true, from: "00:00", to: "23:59" };
    const s = await ryan.start();
    ryan.sessions.statusFromHook({ paneId: s.id, status: "waiting", reason: "x" });
    await until(() => remoteOf(nick, s.id)?.status === "waiting", "the wait");
    expect(nick.notes).toEqual([]);
  });
});

describe("leaving and removal", () => {
  /** What a member's live-muted.json holds (it's under the live panes' dir). */
  const mutedIn = (s: ReturnType<typeof side>) => {
    const file = s.live["mutedFile" as never] as string;
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as string[]) : [];
  };

  it("a removed teammate's sessions leave everyone's panes, mutes of them too; theirs carry on as local sessions", async () => {
    const { ryan, nick, roomId } = await pair();
    const theirs = await nick.start({ title: "nick's" });
    const mine = await ryan.start({ title: "ryan's" });
    await until(() => !!remoteOf(ryan, theirs.id) && !!remoteOf(nick, mine.id), "both sessions to show");
    ryan.sessions.setMuted(remotePaneId(nick.m.id, theirs.id), true);
    nick.sessions.setMuted(remotePaneId(ryan.m.id, mine.id), true);
    expect(mutedIn(ryan)).toEqual([remotePaneId(nick.m.id, theirs.id)]);
    expect(nick.live.roomOfSession(theirs.id)).toBe(roomId);

    await ryan.m.team.removeMember(roomId, nick.m.id);
    await until(() => !remoteOf(ryan, theirs.id), "Nick's session to leave Ryan's panes");
    expect(mutedIn(ryan)).toEqual([]);
    expect(remoteOf(ryan, mine.id)).toBeUndefined(); // his own session is his, not a remote

    // Nick's Mac: the room's gone; his session runs on, as a local one, and Ryan's pane and its mute go
    await until(() => !nick.m.team.room(roomId), "Nick to hear of it");
    expect(nick.live.roomLeft(nick.m.store.get(roomId)!.state!, "5110")).toEqual([]);
    expect(nick.live.roomOfSession(theirs.id)).toBeNull();
    expect(nick.sessions.list().find((s) => s.id === theirs.id)?.status).not.toBe("dead");
    expect(remoteOf(nick, mine.id)).toBeUndefined();
    expect(mutedIn(nick)).toEqual([]);
  });
});

describe("views: who's looking at what", () => {
  it("shows a teammate's initials on the panes they show, and what they're in, for Follow", async () => {
    const { ryan, nick } = await pair();
    const a = await ryan.start({ title: "a" });
    const b = await nick.start({ title: "b" });
    await until(() => !!remoteOf(nick, a.id) && !!remoteOf(ryan, b.id), "both records");
    const aOnNick = remotePaneId(ryan.m.id, a.id);
    nick.live.setView({ shown: [b.id, aOnNick], focused: aOnNick });
    await until(() => ryan.live.state().own[a.id]?.lookers.length === 1, "Ryan to see Nick looking");
    expect(ryan.live.state().own[a.id].lookers).toEqual([{ id: nick.m.id, name: "Nick", focused: true }]);
    expect(remoteOf(ryan, b.id)?.room?.lookers).toEqual([{ id: nick.m.id, name: "Nick", focused: false }]);
    // in Ryan's ids: his own session by its id, Nick's by its pane id here
    expect(ryan.live.state().views).toEqual([expect.objectContaining({ member: nick.m.id, name: "Nick", shown: [remotePaneId(nick.m.id, b.id), a.id], focused: a.id })]);
  });

  it("sends nothing about sessions outside rooms", async () => {
    const { ryan, nick } = await pair();
    const own = await nick.start({ taskGroup: "private" });
    const views: string[] = [];
    ryan.m.team.onStream("view", (c) => views.push(c));
    nick.live.setView({ shown: [own.id], focused: own.id });
    await until(() => views.length > 0, "a view");
    expect(views.join("")).not.toContain(own.id);
  });
});

describe("room session launch", () => {
  it("never lets a room agent's sandbox write home, as its folder or an extra one, whatever asked for it; a plain terminal's isn't asked", async () => {
    const { ryan } = await pair();
    const work = tempDir("launch");
    const target = { id: "x1", group: "5110", agent: "claude" as const, agentVersion: CLAUDE_ROOM_SANDBOX_SINCE, cwd: work, repoPath: null };
    await expect(ryan.live.roomLaunch({ ...target, extraDirs: [os.homedir()] })).rejects.toThrow("can't be given your home folder as an extra folder");
    await expect(ryan.live.roomLaunch({ ...target, agent: "codex", agentVersion: CODEX_ROOM_GUARD_SINCE, extraDirs: [path.dirname(os.homedir())] })).rejects.toThrow("which holds your home folder, as an extra folder");
    await expect(ryan.live.roomLaunch({ ...target, cwd: os.homedir() })).rejects.toThrow("can't work in your home folder");
    // a terminal bringing a conversation back runs that agent under the room's settings
    await expect(ryan.live.roomLaunch({ ...target, agent: null, resumes: "claude", extraDirs: ["/"] })).rejects.toThrow("which holds your home folder, as an extra folder");
    await expect(ryan.live.roomLaunch({ ...target, agent: null, cwd: os.homedir(), extraDirs: [os.homedir()] })).resolves.toMatchObject({ guards: { secrets: false } });
    await expect(ryan.live.roomLaunch({ ...target, extraDirs: [tempDir("extra")] })).resolves.toMatchObject({ guards: { secrets: true } });
  });

  it("denies reading secrets to Claude, and points git at the co-author hooks", async () => {
    const { ryan } = await pair();
    const s = await ryan.start();
    const p = ptyOf(s.id);
    const command = p.args.join(" ");
    expect(command).toContain("--disallowedTools");
    for (const rule of ["Read(**/.env)", "Read(**/.env.*)", "Read(//**/.env)", "Read(**/*.pem)", "Read(**/*.key)", "Read(**/credentials.json)", "Read(~/.mockingbird/team/**)"]) expect(command).toContain(rule);
    expect(command).toContain(`Read(/${path.join(ryan.settings.workTrackerPath, "secrets/ado.pat")})`);
    expect(p.env.GIT_CONFIG_PARAMETERS).toContain("core.hooksPath=");
    // starting until its sandbox reports in, and Claude Code's own account of it (a stand-in's, here) has come
    expect(ryan.sessions.guardsOf(s.id)).toEqual({ secrets: true, coauthors: true, starting: true });
    await reportIn(ryan, s.id);
    expect(ryan.sessions.guardsOf(s.id)).toEqual({ secrets: true, coauthors: true });
  });

  it("leaves sessions outside rooms alone; a Codex of unknown version and terminals get the hooks but no deny rules", async () => {
    const { ryan } = await pair();
    const outside = await ryan.start({ taskGroup: "private" });
    expect(ptyOf(outside.id).args.join(" ")).not.toContain("--disallowedTools");
    expect(ptyOf(outside.id).env.GIT_CONFIG_PARAMETERS ?? "").not.toContain("core.hooksPath");
    expect(ryan.sessions.guardsOf(outside.id)).toBeNull();
    const codex = await ryan.start({ agent: "codex" });
    expect(ptyOf(codex.id).args.join(" ")).not.toContain("--disallowedTools");
    expect(ptyOf(codex.id).args.join(" ")).not.toContain("default_permissions");
    expect(ryan.sessions.guardsOf(codex.id)).toEqual({ secrets: false, coauthors: true });
    const term = await ryan.start({ shell: true, agent: undefined });
    expect(ryan.sessions.guardsOf(term.id)).toEqual({ secrets: false, coauthors: true });
    expect(ptyOf(term.id).env.GIT_CONFIG_PARAMETERS).toContain("core.hooksPath=");
  });

  it("runs room sessions inline, so teammates' copies hold their history; sessions outside rooms run as set up", async () => {
    const { ryan } = await pair();
    const INLINE_ENV = "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN";
    const CODEX_INLINE = `'-c' 'tui.alternate_screen="never"'`;
    const claude = await ryan.start();
    expect(ptyOf(claude.id).env[INLINE_ENV]).toBe("1");
    expect(ptyOf((await ryan.start({ agent: "codex" })).id).args.join(" ")).toContain(CODEX_INLINE);
    // resumed: by id, and in a terminal that had Codex running in it
    const resumed = ptyOf((await ryan.start({ agent: "codex", resumeSessionId: "019a-conv" })).id).args.join(" ");
    expect(resumed).toContain("'resume' '019a-conv'");
    expect(resumed).toContain(CODEX_INLINE);
    const term = ptyOf((await ryan.start({ shell: true, agent: undefined, shellResume: { agent: "codex", id: "019a-conv" } })).id);
    expect(term.args.join(" ")).toContain("'resume' '019a-conv'");
    expect(term.args.join(" ")).toContain(CODEX_INLINE);
    // a claude started by hand in a room's terminal runs inline too
    expect(term.env[INLINE_ENV]).toBe("1");
    // a restart of one that joined while running brings it inline
    expect(ryan.live.state().own[claude.id].inlineOnStart).toBe(true);
    // outside rooms, nothing changes
    expect(ptyOf((await ryan.start({ taskGroup: "private" })).id).env[INLINE_ENV]).toBeUndefined();
    expect(ptyOf((await ryan.start({ agent: "codex", taskGroup: "private" })).id).args.join(" ")).not.toContain("alternate_screen");
  });

  it("leaves room sessions as their agent is set up when this Mac's person turns inline off", async () => {
    const { ryan } = await pair();
    ryan.settings.roomSessionsInline = false;
    const claude = await ryan.start();
    expect(ptyOf(claude.id).env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined();
    expect(ptyOf((await ryan.start({ agent: "codex" })).id).args.join(" ")).not.toContain("alternate_screen");
    expect(ptyOf((await ryan.start({ shell: true, agent: undefined })).id).env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined();
    // the room's other rules still apply
    expect(ptyOf(claude.id).args.join(" ")).toContain("--disallowedTools");
    expect(ryan.live.state().own[claude.id].inlineOnStart).toBe(false);
  });

  it("launches a session as a room session as soon as sharing its group has answered", async () => {
    const dir = tempDir("live-share");
    const net = new LoopbackNetwork();
    const service = new TeamService({
      settings: () => ({ ...DEFAULT_SETTINGS, signalingUrl: "http://loopback.invalid" }),
      localGroups: () => [],
      emit: () => {},
      log: (_c, e) => String(e),
      assetsDir: "/nonexistent",
      dir: path.join(dir, "Ryan", "team"),
      wire: (identity) => net.wire(identity.id),
    });
    service.start();
    const ryan = side({ name: "Ryan", team: service.transport as TeamCore } as LoopbackMember, dir);
    // the rooms are read before the share, as an open window would have
    const before = await ryan.start({ taskGroup: "5120" });
    expect(ryan.sessions.guardsOf(before.id)).toBeNull();
    await service.shareGroup("5120", "#5120 Donor search");
    const s = await ryan.start({ taskGroup: "5120" });
    expect(ryan.sessions.guardsOf(s.id)).toEqual({ secrets: true, coauthors: true, starting: true });
    expect(ptyOf(s.id).args.join(" ")).toContain("--disallowedTools");
    service.stop();
  });

  it("starts Codex under the room's permission profile once its version is known to hold it, and tells it about the sandbox", async () => {
    const { ryan } = await pair();
    const reads: string[] = [];
    ryan.sessions.readVersion = async (kind) => {
      reads.push(kind);
      return kind === "codex" ? CODEX_ROOM_GUARD_SINCE : "2.1.5";
    };
    // a burst of launches reads the version once
    const [a, b] = await Promise.all([ryan.start({ agent: "codex" }), ryan.start({ agent: "codex" })]);
    expect(reads.filter((k) => k === "codex")).toEqual(["codex"]);
    for (const s of [a, b]) {
      const cmd = ptyOf(s.id).args.join(" ");
      expect(cmd).toContain(`'-c' 'default_permissions="${CODEX_ROOM_PROFILE}"'`);
      expect(cmd).toContain(`"**/.env"="deny"`);
      expect(cmd).toContain(JSON.stringify(path.join(ryan.settings.workTrackerPath, "secrets/ado.pat")));
      expect(cmd).toContain("so commits, branches and stashes work");
      expect(cmd).toContain("git worktree add` and `git submodule update` fail here");
      expect(cmd).not.toContain("--disallowedTools");
      // the board couldn't be read here, so the SessionStart hook still adds it
      expect(ptyOf(s.id).env[ROOM_CONTEXT_ENV]).toBeUndefined();
      expect(ryan.sessions.guardsOf(s.id)).toEqual({ secrets: true, coauthors: true });
      expect(ryan.sessions.list().find((x) => x.id === s.id)?.agentVersion).toBe(CODEX_ROOM_GUARD_SINCE);
    }
    // in a repository, its git data is writable (commits) but not its config; co-author hooks stay readable
    const repo = makeRepo();
    const inRepo = ptyOf((await ryan.start({ agent: "codex", cwd: repo })).id).args.join(" ");
    const common = execFileSync("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    expect(inRepo).toContain(`${JSON.stringify(common)}="write"`);
    expect(inRepo).toContain(`${JSON.stringify(path.join(common, "config"))}="read"`);
    expect(inRepo).toMatch(/githooks"="read"/);
    // outside the room, Codex runs as configured
    const outside = await ryan.start({ agent: "codex", taskGroup: "private" });
    expect(ptyOf(outside.id).args.join(" ")).not.toContain("default_permissions");
    expect(ryan.sessions.guardsOf(outside.id)).toBeNull();
  });

  it("keeps a Codex room session from what would run outside its sandbox: the user's MCP servers, project config from the repository's top down, notify, apps", async () => {
    const { ryan } = await pair();
    ryan.sessions.setAgentVersions({ codex: CODEX_ROOM_GUARD_SINCE });
    const repo = makeRepo({ "web/index.ts": "x\n" });
    const s = await ryan.start({ agent: "codex", cwd: path.join(repo, "web") });
    const cmd = ptyOf(s.id).args.join(" ");
    // off by name, before Mockingbird's own server's settings, which a table given after them would replace
    const servers = cmd.indexOf(`'-c' 'mcp_servers={"github"={enabled=false}, "dotted.name"={enabled=false}}'`);
    expect(servers).toBeGreaterThan(0);
    expect(servers).toBeLessThan(cmd.indexOf("'mcp_servers.mockingbird.command="));
    const real = fs.realpathSync(repo);
    const folders = [path.join(repo, "web"), path.join(real, "web"), repo, real].filter((f, i, all) => all.indexOf(f) === i);
    expect(cmd).toContain(`'-c' 'projects={${folders.map((f) => `${JSON.stringify(f)}={trust_level="untrusted"}`).join(", ")}}'`);
    for (const c of ["notify=[]", 'approval_policy="on-request"', "features.apps=false", "features.plugins=false", "features.computer_use=false"]) expect(cmd).toContain(`'-c' '${c}'`);
    expect(cmd).toContain("Before you start, read any AGENTS.md from the repository");
    // the editors', agents' and shells' settings files: read-only at its folder's top, hidden below
    expect(cmd).toContain(`".envrc"="read", "*/**/.envrc"="deny"`);
    expect(cmd).toContain(`".codex"="read", "*/**/.codex"="deny", "*/**/.codex/**"="deny"`);
    expect(ryan.sessions.guardsOf(s.id)).toEqual({ secrets: true, coauthors: true });
  });

  it("starts a Codex room session outside the room's sandbox when the user's MCP servers can't be named, and says so once", async () => {
    let reads = 0;
    const { ryan, nick } = await pair({
      codexMcpServers: async () => {
        reads++;
        throw new Error("`codex mcp list` exited with code 1");
      },
    });
    ryan.sessions.setAgentVersions({ codex: CODEX_ROOM_GUARD_SINCE });
    const [a, b] = [await ryan.start({ agent: "codex" }), await ryan.start({ agent: "codex" })];
    expect(reads).toBe(2);
    for (const s of [a, b]) {
      const cmd = ptyOf(s.id).args.join(" ");
      // everything else still holds
      expect(cmd).toContain(`'-c' 'default_permissions="${CODEX_ROOM_PROFILE}"'`);
      expect(cmd).toContain("'-c' 'notify=[]'");
      expect(cmd).not.toContain("enabled=false");
      expect(ryan.sessions.guardsOf(s.id)).toEqual({ secrets: false, coauthors: true });
    }
    const told = ryan.live.state().problems.filter((p) => p.includes("couldn't read which MCP servers your Codex config names"));
    expect(told).toEqual([expect.stringContaining("(`codex mcp list` exited with code 1)")]);
    await until(() => !!remoteOf(nick, a.id), "the record");
    expect(remoteOf(nick, a.id)!.room!.guards).toEqual({ secrets: false, coauthors: true });
  });

  it("answers a Codex room session's folder notice, logged, typing nothing else into it till Codex has opened; a folder question it doesn't answer is Ryan's, told once", async () => {
    const { ryan } = await pair();
    ryan.sessions.setAgentVersions({ codex: CODEX_ROOM_GUARD_SINCE });
    ryan.sessions.folderNoticeTiming = { settleMs: 20 };
    const s = await ryan.start({ agent: "codex" });
    expect(ryan.sessions.deliverAgentMessage(s.id, "the wire", true)).toMatch(/until its Codex has opened its folder/);
    ptyOf(s.id).emit(capture.fresh.beforeEnter);
    await until(() => ptyOf(s.id).writes.length > 0, "the Enter");
    expect(ptyOf(s.id).writes).toEqual(["\r"]);
    expect(ryan.logs.filter((l) => l.includes("folder notice"))).toEqual([`team: room session ${s.id}: answered its Codex's folder notice for “donors” with “Open restricted” (Enter)`]);
    ptyOf(s.id).emit(capture.fresh.afterEnter);
    ryan.sessions.statusFromHook({ paneId: s.id, status: "idle" });
    await until(() => ptyOf(s.id).writes.join("").includes("the wire"), "the wire");

    const asks = await ryan.start({ agent: "codex", title: "asks" });
    ptyOf(asks.id).emit(capture.fresh.beforeEnter.replace("› 1. Open restricted", "  1. Open restricted").replace("  2. Quit", "› 2. Quit"));
    await until(() => ryan.live.state().problems.some((p) => p.includes("“asks”")), "Ryan told");
    await new Promise((r) => setTimeout(r, 100));
    expect(ryan.live.state().problems.filter((p) => p.includes("“asks”"))).toEqual([
      "“asks” is waiting on its Codex: its Codex is asking a folder question Mockingbird doesn't answer for it. Answer its folder notice in its pane if it's still up; nothing is typed into the pane until its Codex has opened.",
    ]);
    expect(ptyOf(asks.id).writes).toEqual([]);

    // a Claude room session opens on no such notice
    const claude = await ryan.start({ title: "claude" });
    ryan.sessions.clearWaiting(claude.id);
    expect(ryan.sessions.deliverAgentMessage(claude.id, "to claude", true)).toBe("delivered");
  });

  it("leaves a Codex older than the permission profile unguarded, and says so", async () => {
    const { ryan, nick } = await pair();
    ryan.sessions.setAgentVersions({ codex: "0.137.9" });
    const s = await ryan.start({ agent: "codex" });
    expect(ptyOf(s.id).args.join(" ")).not.toContain("default_permissions");
    expect(ptyOf(s.id).args.join(" ")).not.toContain("so commits, branches and stashes work");
    expect(ryan.sessions.guardsOf(s.id)).toEqual({ secrets: false, coauthors: true });
    await until(() => !!remoteOf(nick, s.id), "the record");
    expect(remoteOf(nick, s.id)!.room!.guards).toEqual({ secrets: false, coauthors: true });
  });

  it("starts an agent knowing the room's House board, its read tools allowed and its writes asking in the pane — so the SessionStart hook adds nothing", async () => {
    const { ryan, roomId } = await pair();
    const plan = new HouseService({
      roomGroups: () => [{ roomId, groupKey: "5110" }],
      sessions: () => ryan.sessions.list(),
      knownRepos: () => [],
      emit: () => {},
      log: (c, e) => String(e),
      copiesFile: path.join(tempDir("copies"), "copies.json"),
      home: tempDir("home"),
      timing: { pollMs: 60_000, sessionsMs: 60_000, fetchMs: 60_000 },
    });
    plan.start(ryan.m.team);
    try {
      const s = await ryan.start();
      const claude = ptyOf(s.id);
      const cmd = claude.args.join(" ");
      expect(cmd).toContain("--append-system-prompt");
      expect(cmd).toContain("Mockingbird team room");
      // what its sandbox refuses that an agent reaches for: a worktree of its own, a submodule's update
      expect(cmd).toContain("git worktree add` and `git submodule update` fail here");
      expect(cmd).toContain("a sub-agent with worktree isolation");
      // the House's reads run without asking; its writes are left to Claude's permission prompt in the pane
      const allowed = /'--allowedTools' '([^']+)'/.exec(cmd)![1].split(",");
      for (const tool of HOUSE_READ_TOOLS) expect(allowed).toContain(claudeToolName(tool));
      for (const tool of HOUSE_WRITE_TOOLS) expect(cmd).not.toContain(claudeToolName(tool));
      expect([...HOUSE_READ_TOOLS, ...HOUSE_WRITE_TOOLS].sort()).toEqual([...HOUSE_TOOL_NAMES].sort());
      expect(cmd).toContain("list_house_tickets (the room");
      // and the room artifacts' tools, which the context names too
      for (const tool of Object.values(ARTIFACT_TOOL)) expect(cmd).toContain(claudeToolName(tool));
      expect(cmd).toContain(`List them with the mockingbird MCP tool ${ARTIFACT_TOOL.list}`);
      expect(claude.env[ROOM_CONTEXT_ENV]).toBe("1");
      const codex = ptyOf((await ryan.start({ agent: "codex" })).id);
      expect(codex.args.join(" ")).toContain(`'-c' 'developer_instructions="This repository is part of a Mockingbird team room`);
      for (const tool of HOUSE_WRITE_TOOLS) expect(codex.args.join(" ")).toContain(`'-c' 'mcp_servers.mockingbird.tools.${tool}.approval_mode="prompt"'`);
      expect(codex.env[ROOM_CONTEXT_ENV]).toBe("1");
      const term = ptyOf((await ryan.start({ shell: true, agent: undefined })).id);
      expect(term.args.join(" ")).not.toContain("--append-system-prompt");
      expect(term.env[ROOM_CONTEXT_ENV]).toBeUndefined();
      const outside = ptyOf((await ryan.start({ taskGroup: "private" })).id);
      expect(outside.args.join(" ")).not.toContain("--append-system-prompt");
      expect(outside.args.join(" ")).not.toContain(claudeToolName(HOUSE_TOOL_NAMES[0]));
      expect(outside.args.join(" ")).not.toContain(claudeToolName(ARTIFACT_TOOL.read));
      expect(outside.env[ROOM_CONTEXT_ENV]).toBeUndefined();
    } finally {
      plan.stop();
    }
  });

  it("without the House board running, an agent starts without it and the SessionStart hook adds it", async () => {
    const { ryan } = await pair();
    const s = await ryan.start();
    // told only of its sandbox, not the board
    const cmd = ptyOf(s.id).args.join(" ");
    expect(cmd).not.toContain("tracked as Radley House tickets");
    expect(cmd).toContain("--append-system-prompt' 'This Mockingbird team room session runs its Bash commands in the room'\\''s sandbox.");
    expect(ptyOf(s.id).env[ROOM_CONTEXT_ENV]).toBeUndefined();
    expect(ryan.logs.some((l) => /House board for session/.test(l))).toBe(true);
  });

  it("flags a session moved into the room while running as unguarded, and keeps a Claude one off the room's line until it restarts there", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start({ taskGroup: "private" });
    const local = await ryan.start({ taskGroup: "private" });
    const inRoom = await ryan.start();
    await reportIn(ryan, inRoom.id);
    expect(ryan.live.outsideSandbox(s.id)).toBe(false);
    ryan.sessions.setGroup(s.id, "5110");
    await until(() => !!remoteOf(nick, s.id), "the record");
    expect(remoteOf(nick, s.id)!.room!.guards).toEqual({ secrets: false, coauthors: false });
    expect(ryan.live.outsideSandbox(s.id)).toBe(true);
    expect(ryan.live.outsideSandbox(inRoom.id)).toBe(false);
    expect(ryan.live.outsideSandbox(local.id)).toBe(false);
    // restarted in the room, it runs in the room's sandbox once that reports in
    const again = await ryan.sessions.restart(s.id);
    expect(ptyOf(again.id).args.join(" ")).toContain('"sandbox":{"enabled":true');
    expect(ryan.live.outsideSandbox(again.id)).toBe(true);
    await reportIn(ryan, again.id);
    expect(ryan.live.outsideSandbox(again.id)).toBe(false);
  });

  it("starts Claude in the room's sandbox, with the status line in the same --settings, reading no settings but the user's and running no MCP server but Mockingbird's; outside a room, as before", async () => {
    const { ryan } = await pair();
    const repo = makeRepo();
    const s = await ryan.start({ cwd: repo, extraDirs: ["/extra/dir"] });
    const args = ptyOf(s.id).args.join(" ");
    expect(args.match(/--settings/g)).toHaveLength(1);
    expect(args).toContain("'--setting-sources' 'user' '--strict-mcp-config'");
    expect(args).toMatch(/'--mcp-config' '\{"mcpServers":\{"mockingbird"/);
    const settings = JSON.parse(/--settings' '(\{.*?\})'/.exec(args)![1]);
    expect(settings.statusLine).toMatchObject({ type: "command", command: expect.stringContaining("statusline.sh") });
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, network: { allowedDomains: ["*"] } });
    const git = fs.realpathSync(path.join(repo, ".git"));
    expect(settings.sandbox.filesystem.allowWrite[0]).toBe(git);
    expect(settings.sandbox.filesystem.allowWrite).not.toContain("~/.npm");
    expect(settings.sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining(["~/.mockingbird", "~/.zshenv", "~/.claude", path.join(git, "config"), path.join(git, "hooks"), path.join(git, "info", "attributes")]));
    expect(settings.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(["~/.mockingbird/mcp-tokens", "~/Library/Keychains"]));
    // the co-author hooks its commits run, inside the denied ~/.mockingbird/team
    expect(settings.sandbox.filesystem.allowRead.map((p: string) => path.basename(p))).toEqual(["githooks", "coauthors"]);
    expect(settings.permissions).toMatchObject({
      blockWritesOutsideWorkingDirectories: true,
      deny: expect.arrayContaining(["Edit(~/.mockingbird/**)", "Edit(~/.zshrc)", `Edit(/${path.join(git, "config")})`, `Edit(/${path.join(git, "hooks")}/**)`, `Edit(/${repo}/.git)`, `Edit(/${repo}/.mcp.json)`, `Edit(/${repo}/.claude/**)`, "Edit(//extra/dir/.git/**)"]),
    });
    // its sandbox reports in through its own SessionStart hook
    expect(settings.hooks.SessionStart[0].hooks[0].command).toMatch(/room-sandbox\.sh" [0-9a-f]{32}$/);
    expect(ryan.sessions.guardsOf(s.id)).toMatchObject({ secrets: true, starting: true });
    const outside = ptyOf((await ryan.start({ taskGroup: "private" })).id).args.join(" ");
    expect(outside).not.toContain("sandbox");
    expect(outside).not.toContain("--setting-sources");
    expect(outside).toMatch(/--settings' '[^']*statusline-settings\.json'/);
  });

  it("points a room agent's package managers at the room's own caches, on its command and not its shell's startup", async () => {
    const { ryan } = await pair();
    const s = await ryan.start();
    const p = ptyOf(s.id);
    await until(() => !!remoteOfOwn(ryan, s.id), "the room");
    const roomId = remoteOfOwn(ryan, s.id)!;
    const folder = path.join(ryan.live["d"].cachesDir!, roomId);
    expect(fs.statSync(folder).isDirectory()).toBe(true);
    const command = p.args.join(" ");
    expect(command).toContain(`exec '/usr/bin/env' 'npm_config_cache=${folder}/npm'`);
    for (const k of ["XDG_CACHE_HOME", "GOMODCACHE", "CARGO_HOME", "NUGET_PACKAGES", "COREPACK_HOME", "electron_config_cache"]) expect(command).toContain(`'${k}=${folder}/`);
    // the pane's shell starts with the user's own
    expect(p.env.XDG_CACHE_HOME).toBeUndefined();
    expect(JSON.parse(/--settings' '(\{.*?\})'/.exec(command)![1]).sandbox.filesystem.allowWrite).toEqual([folder]);
    // a Codex in the room writes them too, and a plain terminal is left alone
    ryan.sessions.setAgentVersions({ codex: CODEX_ROOM_GUARD_SINCE });
    const codex = ptyOf((await ryan.start({ agent: "codex" })).id).args.join(" ");
    expect(codex).toContain(`'GOMODCACHE=${folder}/go/mod'`);
    expect(codex).toContain(`${JSON.stringify(folder)}="write"`);
    const term = ptyOf((await ryan.start({ shell: true, agent: undefined })).id);
    expect(term.args.join(" ")).not.toContain("/usr/bin/env");
  });

  it("starts the terminal added on a room session's tree in its room, under the room's rules for a terminal, and wires it there", async () => {
    const { ryan } = await pair();
    const s = await ryan.start();
    await reportIn(ryan, s.id);
    const store = new LandscapeStore({ file: path.join(tempDir("tree"), "landscape.json"), emit: () => {}, emitWires: () => {}, log: () => {} });
    const wires = new WireService({
      store,
      sessions: ryan.sessions,
      roomOf: (id) => ryan.live.roomOfSession(id),
      roomsKnown: () => true,
      takenOver: () => null,
      outsideSandbox: (id) => ryan.live.outsideSandbox(id),
      log: () => {},
    });
    const t = await wires.addTerminal(s, { create: (req) => ryan.sessions.create(req), forget: (id) => ryan.sessions.kill(id, true) });
    expect(t).toMatchObject({ shell: true, cwd: s.cwd, taskGroup: "5110" });
    expect(ryan.live.roomOfSession(t.id)).toBeTruthy();
    expect(ryan.live.roomOfSession(t.id)).toBe(ryan.live.roomOfSession(s.id));
    // a room's terminal: its hooks credit teammates and a claude started in it runs inline; no agent, so no agent's
    // settings, tools or instructions, and never on the room's line
    const p = ptyOf(t.id);
    expect(p.env.GIT_CONFIG_PARAMETERS).toContain("core.hooksPath=");
    expect(p.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe("1");
    expect(p.args).toEqual(["-il"]);
    expect(ryan.sessions.guardsOf(t.id)).toEqual({ secrets: false, coauthors: true });
    expect(Object.values(wires.get().book!.links)).toEqual([expect.objectContaining({ from: s.id, to: t.id, type: "worktree" })]);
  });

  it("keeps a step added after a room session to this Mac till it starts, then starts it in the room under the room's rules for an agent", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start();
    await reportIn(ryan, s.id);
    await until(() => !!remoteOf(nick, s.id), "Nick to see Ryan's session");
    const store = new LandscapeStore({ file: path.join(tempDir("step"), "landscape.json"), emit: () => {}, emitWires: () => {}, log: () => {} });
    const wires = new WireService({ store, sessions: ryan.sessions, roomOf: (id) => ryan.live.roomOfSession(id), roomsKnown: () => true, takenOver: () => null, outsideSandbox: (id) => ryan.live.outsideSandbox(id), log: () => {} });
    const { info } = wires.addStep(
      { after: s.id, title: "Tester", agent: "claude", repoPath: null, worktree: false, taskGroup: "5110", sharesFolder: true },
      { plan: (q) => ryan.sessions.plan(q), forget: (id) => ryan.sessions.kill(id, true) }
    );
    // in the room's area, wired from a room session, and never published while it waits
    expect(ryan.live.roomOfSession(info.id)).toBe(ryan.live.roomOfSession(s.id));
    expect(Object.values(wires.get().book!.links)).toEqual([expect.objectContaining({ from: s.id, to: info.id, type: "handoff" })]);
    await new Promise((r) => setTimeout(r, 300));
    expect(remoteOf(nick, info.id)).toBeUndefined();
    expect(ryan.live.state().own[info.id]).toBeUndefined();
    // started: in the room, guarded as its agents are, and published
    const started = await ryan.sessions.startPlanned(info.id, s.id);
    expect(started).toMatchObject({ id: info.id, cwd: s.cwd, taskGroup: "5110" });
    expect(ptyOf(info.id).args.join(" ")).toContain('"sandbox":{"enabled":true');
    expect(ryan.sessions.guardsOf(info.id)).toMatchObject({ secrets: true, coauthors: true });
    await reportIn(ryan, info.id);
    await until(() => !!remoteOf(nick, info.id), "Nick to see the started step");
  });

  it("runs a Claude conversation a terminal brings back under the room's settings, the terminal itself still unguarded", async () => {
    const { ryan } = await pair();
    const t = await ryan.start({ shell: true, agent: undefined, shellResume: { agent: "claude", id: "conv-1" } });
    const command = ptyOf(t.id).args.join(" ");
    expect(command).toMatch(/'--resume' 'conv-1'/);
    expect(command).toContain('"sandbox":{"enabled":true');
    expect(command).toContain("'--setting-sources' 'user' '--strict-mcp-config'");
    expect(command).toContain("--disallowedTools");
    // no messaging tools, so no report to wait for; back at the shell once it quits
    expect(command).not.toContain("room-sandbox.sh");
    expect(command).not.toContain("--mcp-config");
    expect(command).toMatch(/; exec \/bin\/zsh -il$/);
    expect(ryan.sessions.guardsOf(t.id)).toEqual({ secrets: false, coauthors: true });
  });

  it("keeps a Claude launch off the room's line until its sandbox reports in, and for good when a turn comes first or nothing comes in time — told once", async () => {
    const { ryan, nick } = await pair();
    const folder = tempDir("own");
    const ok = await ryan.start({ title: "reported", cwd: folder });
    expect(ryan.live.outsideSandbox(ok.id)).toBe(true);
    // starting is this Mac's to know: teammates' records keep the two fields every Mockingbird reads
    await until(() => !!remoteOf(nick, ok.id), "the record");
    expect(remoteOf(nick, ok.id)!.room!.guards).toEqual({ secrets: true, coauthors: true });
    // an event matched only by its folder may be another agent's there: it says nothing of this launch
    ryan.sessions.statusFromHook({ cwd: folder, status: "working", prompted: true });
    expect(ryan.sessions.guardsOf(ok.id)).toMatchObject({ secrets: true, starting: true });
    // the marker alone isn't enough: Mockingbird's own hooks must be seen to run for it
    const marker = /room-sandbox\.sh\\" ([0-9a-f]+)/.exec(ptyOf(ok.id).args.join(" "))![1];
    ryan.sessions.roomSandboxReported(ok.id, "f".repeat(32), false); // another launch's marker says nothing
    ryan.sessions.roomSandboxReported(ok.id, marker, false);
    expect(ryan.live.outsideSandbox(ok.id)).toBe(true);
    ryan.sessions.statusFromHook({ paneId: ok.id, status: "idle", started: true });
    expect(ryan.live.outsideSandbox(ok.id)).toBe(false);
    // a turn after it changes nothing
    ryan.sessions.statusFromHook({ paneId: ok.id, status: "working", prompted: true });
    expect(ryan.sessions.guardsOf(ok.id)).toEqual({ secrets: true, coauthors: true });

    // a prompt before the report: its agent could have written the marker itself
    const early = await ryan.start({ title: "early" });
    ryan.sessions.statusFromHook({ paneId: early.id, status: "idle", started: true });
    ryan.sessions.statusFromHook({ paneId: early.id, status: "working", prompted: true });
    await reportIn(ryan, early.id);
    expect(ryan.sessions.guardsOf(early.id)).toEqual({ secrets: false, coauthors: true });
    expect(ryan.live.outsideSandbox(early.id)).toBe(true);
    await until(() => remoteOf(nick, early.id)?.room?.guards.secrets === false, "teammates see it unguarded");

    // read beside a turn's event, the marker can't be told from one the turn wrote
    const late = await ryan.start({ title: "late" });
    await reportIn(ryan, late.id, { late: true });
    expect(ryan.sessions.guardsOf(late.id)).toMatchObject({ secrets: false });

    // a rejected settings file runs none of its hooks: nothing reports in, and the time runs out
    ryan.sessions.sandboxReportMs = 300;
    const silent = await ryan.start({ title: "silent" });
    ryan.sessions.statusFromHook({ paneId: silent.id, status: "idle", started: true });
    await until(() => ryan.sessions.guardsOf(silent.id)?.secrets === false, "the time running out");
    const told = ryan.live.state().problems.filter((p) => p.includes("“silent”"));
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/didn't report in within 0 seconds.*may have rejected them/);
    expect(ryan.live.state().problems.filter((p) => p.includes("“early”"))).toEqual([expect.stringMatching(/first turn began before its sandbox settings reported in/)]);
    // a session refused across the line says why
    expect(ryan.live.outsideSandbox(silent.id)).toBe(true);
  });

  it("opens a Claude launch's line only once Claude Code's own account shows its sandbox on: the marker and the start alone don't, and a turn between them and it changes nothing", async () => {
    const { ryan } = await pair();
    let answer!: (v: SandboxVerdict) => void;
    ryan.sessions.sandboxProbe = () => new Promise((r) => (answer = r));
    const s = await ryan.start();
    ryan.sessions.roomSandboxReported(s.id, /room-sandbox\.sh\\" ([0-9a-f]+)/.exec(ptyOf(s.id).args.join(" "))![1], false);
    ryan.sessions.statusFromHook({ paneId: s.id, status: "idle", started: true });
    ryan.sessions.statusFromHook({ paneId: s.id, status: "working", prompted: true });
    expect(ryan.sessions.guardsOf(s.id)).toEqual({ secrets: true, coauthors: true, starting: true });
    expect(ryan.live.outsideSandbox(s.id)).toBe(true);
    answer({ ok: true, why: null, log: "ok: a stand-in" });
    await until(() => !ryan.sessions.guardsOf(s.id)?.starting, "its sandbox confirmed");
    expect(ryan.sessions.guardsOf(s.id)).toEqual({ secrets: true, coauthors: true });
    expect(ryan.live.outsideSandbox(s.id)).toBe(false);
  });

  it("asks Claude Code with the pane's own binary, --settings, folder and version, and keeps the line closed when its account says otherwise, telling Ryan once what to change; the log has no path of his", async () => {
    const { ryan } = await pair();
    const asked: SandboxProbe[] = [];
    const fake = path.join(tempDir("fake-claude"), "claude");
    const fakeOf = (mode: string) => `#!/bin/bash\nMB_FAKE_SANDBOX=${mode} MB_FAKE_SANDBOX_VERSION=${CLAUDE_ROOM_SANDBOX_SINCE} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(__dirname, "fixtures", "fakeClaudeSandbox.cjs"))} "$@"\n`;
    // the pane runs /bin/echo here: the account comes from a stand-in Claude Code given what the pane was given
    ryan.sessions.sandboxProbe = (p) => (asked.push(p), probeRoomSandbox({ ...p, bin: fake }));
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    fs.writeFileSync(fake, fakeOf("extra-write"), { mode: 0o755 });
    const s = await ryan.start({ title: "extras", extraDirs: ["/extra/dir"] });
    await reportIn(ryan, s.id);
    const args = ptyOf(s.id).args.join(" ");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ bin: "/bin/echo", cwd: s.cwd, version: CLAUDE_ROOM_SANDBOX_SINCE, extraDirs: ["/extra/dir"] });
    expect(args).toContain(quote(asked[0].settingsJson));
    expect(asked[0].written.denyRead.length).toBeGreaterThan(5);
    expect(ryan.sessions.guardsOf(s.id)).toEqual({ secrets: false, coauthors: true });
    expect(ryan.live.outsideSandbox(s.id)).toBe(true);
    expect(ryan.live.state().problems.filter((p) => p.includes("“extras”"))).toEqual([
      `“extras” isn't in its team room's sandbox: your ~/.claude/settings.json sandbox has filesystem.allowWrite ["~/Documents/private-notes"], which room panes can't run under. Move them to the settings of the projects that need them (.claude/settings.local.json there), which room panes don't read. Your panes outside rooms aren't affected. Nothing crosses the room's line for it, and teammates see it as unguarded; restart it to try again.`,
    ]);
    const verdicts = logged.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("sandbox check"));
    expect(verdicts).toEqual([`[sessions] ${s.id}: sandbox check refused: Claude Code ${CLAUDE_ROOM_SANDBOX_SINCE}: the user's settings add 1 allowWrite path`]);

    // the sandbox on as written: the line opens
    fs.writeFileSync(fake, fakeOf("good"), { mode: 0o755 });
    const ok = await ryan.start({ title: "good" });
    await reportIn(ryan, ok.id);
    expect(ryan.sessions.guardsOf(ok.id)).toEqual({ secrets: true, coauthors: true });
    // a renamed sandbox.enabled: closed, saying so
    fs.writeFileSync(fake, fakeOf("enabled-renamed"), { mode: 0o755 });
    const renamed = await ryan.start({ title: "renamed" });
    await reportIn(ryan, renamed.id);
    expect(ryan.live.state().problems.filter((p) => p.includes("“renamed”"))).toEqual([expect.stringContaining("reads the room's settings with its sandbox off")]);
  });

  it("runs a Claude room launch, checks it and reads its version from the one file the claude link names as it begins: an update between launches is the next one's, and a link moved mid-launch changes nothing", async () => {
    const { ryan } = await pair();
    const dir = tempDir("claude-install");
    fs.mkdirSync(path.join(dir, "versions"));
    for (const v of ["2.1.320", "2.1.321", "2.1.322"]) fs.writeFileSync(path.join(dir, "versions", v), `#!/bin/sh\n[ "$1" = --version ] && echo "${v} (Claude Code)"\nexit 0\n`, { mode: 0o755 });
    const link = path.join(dir, "claude");
    const point = (v: string) => {
      fs.rmSync(link, { force: true });
      fs.symlinkSync(path.join(dir, "versions", v), link);
    };
    const file = (v: string) => fs.realpathSync(path.join(dir, "versions", v));
    point("2.1.320");
    ryan.settings.claudeBin = link;
    ryan.sessions.resetBinCache();
    // the file itself is run for its version
    ryan.sessions.readVersionAt = readVersionAt;
    const asked: SandboxProbe[] = [];
    ryan.sessions.sandboxProbe = async (p) => (asked.push(p), { ok: true, why: null, log: "ok: a stand-in" });
    const launch = async () => {
      const s = await ryan.start();
      return { cmd: ptyOf(s.id).args.join(" "), asked: asked.at(-1)!, version: ryan.sessions.list().find((x) => x.id === s.id)!.agentVersion };
    };
    const runs = (l: Awaited<ReturnType<typeof launch>>, v: string) => {
      expect(l.cmd).toContain(` ${quote(file(v))} `);
      expect(l.cmd).not.toContain(quote(link));
      expect(l.asked).toMatchObject({ bin: file(v), version: v });
      expect(l.version).toBe(v);
    };
    runs(await launch(), "2.1.320");
    // what the link named is the installed version now, so the pane isn't shown as behind it
    expect(ryan.sessions.agentVersions.claude).toBe("2.1.320");
    expect(ryan.sessions.updateNotices()).toEqual([]);
    // Claude Code updated between launches; the version last read for the app is still the one before
    point("2.1.321");
    expect(ryan.sessions.agentVersions.claude).toBe("2.1.320");
    runs(await launch(), "2.1.321");
    expect(ryan.sessions.agentVersions.claude).toBe("2.1.321");
    // it updates again while the next launch is being prepared: the file it named as the launch began is the one
    const roomLaunch = ryan.sessions.roomLaunch!;
    const chosenFor: (string | null)[] = [];
    ryan.sessions.roomLaunch = async (t) => {
      point("2.1.322");
      chosenFor.push(t.agentVersion);
      return roomLaunch(t);
    };
    runs(await launch(), "2.1.321");
    expect(chosenFor).toEqual(["2.1.321"]);
  }, 60_000);

  it("asks a running room pane's Claude Code for its sandbox again when Claude Code's settings change, started as the pane was, and closes its line once if it's no longer on", async () => {
    const { ryan } = await pair();
    ryan.sessions.settingsTiming = { pollMs: 20, settleMs: 40 };
    const asked: SandboxProbe[] = [];
    let verdict: SandboxVerdict = { ok: true, why: null, log: "ok: a stand-in" };
    ryan.sessions.sandboxProbe = async (p) => (asked.push(p), verdict);
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await ryan.start({ title: "rechecked" });
    await reportIn(ryan, s.id);
    expect(ryan.sessions.guardsOf(s.id)).toEqual({ secrets: true, coauthors: true });
    // asked with the pane's own environment, and the room's variables its command sets before the binary
    const pane = ptyOf(s.id);
    expect(asked[0].env).toEqual(pane.env);
    expect(asked[0].env!.MOCKINGBIRD_SESSION).toBe(s.id);
    const first = asked[0].envFirst!;
    expect(Object.keys(first).length).toBeGreaterThan(0);
    expect(pane.args[1]).toContain(["/usr/bin/env", ...Object.entries(first).map(([k, v]) => `${k}=${v}`), asked[0].bin].map(quote).join(" "));

    const user = path.join(os.homedir(), ".claude", "settings.json");
    fs.mkdirSync(path.dirname(user), { recursive: true });
    try {
      // a change that leaves it on: asked again as it was asked first, and its line stays open
      fs.writeFileSync(user, JSON.stringify({ model: "opus" }));
      await until(() => asked.length === 2, "asked again");
      expect(asked[1]).toEqual(asked[0]);
      await until(() => logged.mock.calls.some((c) => String(c[0]) === `[sessions] ${s.id}: sandbox re-check ok: a stand-in`), "the re-check logged");
      expect(ryan.sessions.guardsOf(s.id)).toEqual({ secrets: true, coauthors: true });
      // one that adds an excluded command: its line closes, and Ryan is told once
      const why = `your ~/.claude/settings.json sandbox has excludedCommands ["docker *"] (they run outside the sandbox), which room panes can't run under`;
      verdict = { ok: false, why, log: "refused: Claude Code 2.1.320: the user's settings add 1 excluded command" };
      fs.writeFileSync(user, JSON.stringify({ sandbox: { excludedCommands: ["docker *"] } }));
      await until(() => ryan.sessions.guardsOf(s.id)?.secrets === false, "its line closed");
      expect(ryan.live.outsideSandbox(s.id)).toBe(true);
      const told = () => ryan.live.state().problems.filter((p) => p.includes("“rechecked”"));
      expect(told()).toEqual([
        `“rechecked” isn't in its team room's sandbox: after its Claude Code settings changed, ${why}. Nothing crosses the room's line for it, and teammates see it as unguarded; restart it to try again.`,
      ]);
      expect(warned.mock.calls.map((c) => String(c[0]))).toContain(`[sessions] ${s.id}: sandbox re-check refused: Claude Code 2.1.320: the user's settings add 1 excluded command`);
      // outside its sandbox now, it isn't asked again, and nothing more is said
      fs.writeFileSync(user, "{}");
      await new Promise((r) => setTimeout(r, 200));
      expect([asked.length, told().length]).toEqual([3, 1]);
    } finally {
      fs.rmSync(user, { force: true });
    }
  });

  it("holds git in a room session's worktree to the git folders it started on: rewritten, its folder isn't read for teammates, and Ryan is told once", async () => {
    const { ryan } = await pair();
    const repo = makeRepo();
    const wt = path.join(fs.realpathSync(tempDir("wts")), "5110");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "5110-x", wt]);
    const reads: string[] = [];
    ryan.live["d"].gitState = async (cwd: string) => (reads.push(cwd), { dirty: false, dirtyFiles: 0, branch: "5110-x", upstream: null, ahead: 0, behind: 0, insertions: 0, deletions: 0 });
    const s = await ryan.start({ cwd: wt, repoPath: repo });
    await ryan.live["pollGit"]();
    expect(reads).toContain(wt);
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${tempDir("elsewhere")}\n`);
    reads.length = 0;
    await ryan.live["pollGit"]();
    await ryan.live["pollGit"]();
    expect(reads).toEqual([]);
    expect(ryan.live.state().problems.filter((p) => p.includes(`won't run git in ${wt}`))).toHaveLength(1);
    // restarted, it reads its folder afresh: a .git leading out of its repository is refused from the start, said once
    await ryan.sessions.restart(s.id);
    await expect(git(wt, ["status"])).rejects.toThrow(/won't run git/);
    expect(ryan.live.state().problems.filter((p) => p.includes(`won't run git in room session ${s.id}`))).toEqual([expect.stringMatching(/git found no repository there/)]);
    expect(ryan.live.state().problems.filter((p) => p.includes(`won't run git in ${wt}`))).toHaveLength(1);
  });

  it("leaves a Claude Code too old for the room's sandbox outside it, and says so once", async () => {
    const { ryan } = await pair();
    ryan.sessions.setAgentVersions({ claude: "2.1.313" });
    const a = await ryan.start();
    const b = await ryan.start();
    for (const s of [a, b]) {
      expect(ryan.sessions.guardsOf(s.id)).toEqual({ secrets: false, coauthors: true });
      expect(ryan.live.outsideSandbox(s.id)).toBe(true);
      expect(ptyOf(s.id).args.join(" ")).not.toContain("room-sandbox.sh");
    }
    expect(ryan.live.state().problems.filter((p) => p.includes("Claude Code 2.1.313 is older than 2.1.314"))).toHaveLength(1);
  });
});

describe("a teammate's session in the session manager", () => {
  it("is never resized from here, and can't be renamed or moved", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "the record");
    const paneId = remotePaneId(ryan.m.id, s.id);
    nick.sessions.resize(paneId, 20, 5);
    await new Promise((r) => setTimeout(r, 150));
    expect(remoteOf(nick, s.id)?.room).toMatchObject({ cols: 120, rows: 32 });
    expect(() => nick.sessions.rename(paneId, "x")).toThrow(/only its owner/);
    expect(() => nick.sessions.setGroup(paneId, "other")).toThrow(/only its owner/);
    // closing, restarting or relaunching it here would act on nothing of this Mac's: refused, not silently ignored
    expect(() => nick.sessions.kill(paneId, true)).toThrow(/only its owner/);
    expect(() => nick.sessions.clearWaiting(paneId)).toThrow(/only its owner/);
    await expect(nick.sessions.restart(paneId)).rejects.toThrow(/only its owner/);
    await expect(nick.sessions.relaunch(paneId)).rejects.toThrow(/only its owner/);
    expect(nick.sessions.list().some((x) => x.id === paneId)).toBe(false);
    // a broadcast never reaches a teammate's session, named or not
    expect(nick.sessions.broadcast("status?", [paneId], false)).toEqual([{ id: paneId, outcome: "skipped" }]);
    expect(nick.sessions.broadcast("status?", [], false).map((o) => o.id)).not.toContain(paneId);
    expect(ptyOf(s.id).writes.join("")).not.toContain("status?");
    // the owner's resize reaches the teammate's copy
    ryan.sessions.resize(s.id, 100, 30);
    await until(() => remoteOf(nick, s.id)?.room?.cols === 100, "the new size");
  });
});
