import { execFileSync } from "child_process";
import * as fs from "fs";
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
import { CODEX_ROOM_GUARD_SINCE, decodePtyChunk, encodePtyChunk, remotePaneId, type RoomSessionRecord } from "../src/shared/team/livePanes";
import { CODEX_ROOM_PROFILE } from "../src/main/codexRoomSandbox";
import { HouseService } from "../src/main/team/houseService";
import { claudeToolName } from "../src/main/messaging";
import { ROOM_CONTEXT_ENV } from "../src/shared/team/claims";
import { HOUSE_READ_TOOLS, HOUSE_TOOL_NAMES, HOUSE_WRITE_TOOLS } from "../src/shared/team/house";
import { ARTIFACT_TOOL } from "../src/shared/team/artifacts";

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
afterEach(() => {
  for (const l of running.splice(0)) l.stop();
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
  sessions.scrollbackDir = path.join(dir, m.name, "scrollback");
  const window: unknown[][] = [];
  const notes: { title: string; body: string; paneId: string }[] = [];
  const audits: string[] = [];
  const logs: string[] = [];
  const base = path.join(dir, m.name, "live");
  const live = new LivePanes({
    team: () => m.team,
    rooms: () => m.team.status().rooms.map((r) => ({ id: r.id, groupKey: r.groupKey })),
    sessions,
    settings: () => settings,
    notify: (title, body, paneId) => notes.push({ title, body, paneId }),
    toWindow: (...a) => window.push(a),
    audit: (l) => audits.push(l),
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
    timing: FAST,
    ...over,
  });
  live.start();
  running.push(live);
  const start = (req: Partial<NewSessionRequest> = {}) => sessions.create({ repoPath: null, useWorktree: false, agent: "claude", taskGroup: "5110", title: "donors", ...req });
  /** What the window was sent for a pane, as its terminal would show it. */
  const shown = (paneId: string) => window.filter((w) => w[0] === "session:data" && w[1] === paneId).map((w) => w[2]).join("");
  return { m, settings, sessions, live, window, notes, audits, logs, store, start, shown };
}

async function pair(over: Partial<LivePanesDeps> = {}) {
  const dir = tempDir("live");
  const { members, roomId, net } = await loopbackRoom(["Ryan", "Nick"], { dir, groupKey: "5110" });
  const [ryan, nick] = members.map((m) => side(m, dir, over));
  return { dir, roomId, net, ryan, nick };
}

const remoteOf = (s: ReturnType<typeof side>, id: string) => s.live.state().remote.find((r) => r.room?.sessionId === id);

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
    await until(() => !!remoteOf(nick, s.id), "the record");
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

  it("never lets a teammate's wheel, clicks or PageUp/PageDown move the owner's view; their typing still arrives", async () => {
    let clock = 1_000_000;
    const { ryan, nick } = await pair({ now: () => clock });
    const s = await ryan.start();
    await until(() => !!remoteOf(nick, s.id), "the record");
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
  it("denies reading secrets to Claude, and points git at the co-author hooks", async () => {
    const { ryan } = await pair();
    const s = await ryan.start();
    const p = ptyOf(s.id);
    const command = p.args.join(" ");
    expect(command).toContain("--disallowedTools");
    for (const rule of ["Read(**/.env)", "Read(**/.env.*)", "Read(//**/.env)", "Read(**/*.pem)", "Read(**/*.key)", "Read(**/credentials.json)", "Read(~/.mockingbird/team/**)"]) expect(command).toContain(rule);
    expect(command).toContain(`Read(/${path.join(ryan.settings.workTrackerPath, "secrets/ado.pat")})`);
    expect(p.env.GIT_CONFIG_PARAMETERS).toContain("core.hooksPath=");
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
    expect(ryan.sessions.guardsOf(s.id)).toEqual({ secrets: true, coauthors: true });
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
    expect(ptyOf(s.id).args.join(" ")).not.toContain("--append-system-prompt");
    expect(ptyOf(s.id).env[ROOM_CONTEXT_ENV]).toBeUndefined();
    expect(ryan.logs.some((l) => /House board for session/.test(l))).toBe(true);
  });

  it("flags a session moved into the room while running as unguarded", async () => {
    const { ryan, nick } = await pair();
    const s = await ryan.start({ taskGroup: "private" });
    ryan.sessions.setGroup(s.id, "5110");
    await until(() => !!remoteOf(nick, s.id), "the record");
    expect(remoteOf(nick, s.id)!.room!.guards).toEqual({ secrets: false, coauthors: false });
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
