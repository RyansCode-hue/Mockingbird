import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers";
import { loopbackMember, loopbackRoom, until, type LoopbackMember, type LoopbackNetwork } from "../src/main/team/loopback";
import { SessionManager } from "../src/main/sessions";
import { LivePanes, type LivePanesDeps } from "../src/main/team/livePanes";
import { onTurnEnded, isRoomSession, originIdentity, roomOfSession, setRoomSessionLookup, validateRecord, type TurnEnded } from "../src/main/team/roomSessions";
import { DEFAULT_SETTINGS, type NewSessionRequest, type Settings } from "../src/shared/types";
import { decodePtyChunk, encodePtyChunk, remotePaneId, type RoomSessionRecord } from "../src/shared/team/livePanes";
import { PlanService } from "../src/main/team/planService";
import { claudeToolName } from "../src/main/messaging";
import { PLAN_CONTEXT_ENV, PLAN_TOOL } from "../src/shared/team/plan";

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

  it("leaves sessions outside rooms alone; Codex and terminals get the hooks but no deny rules", async () => {
    const { ryan } = await pair();
    const outside = await ryan.start({ taskGroup: "private" });
    expect(ptyOf(outside.id).args.join(" ")).not.toContain("--disallowedTools");
    expect(ptyOf(outside.id).env.GIT_CONFIG_PARAMETERS ?? "").not.toContain("core.hooksPath");
    expect(ryan.sessions.guardsOf(outside.id)).toBeNull();
    const codex = await ryan.start({ agent: "codex" });
    expect(ptyOf(codex.id).args.join(" ")).not.toContain("--disallowedTools");
    expect(ryan.sessions.guardsOf(codex.id)).toEqual({ secrets: false, coauthors: true });
    const term = await ryan.start({ shell: true, agent: undefined });
    expect(ryan.sessions.guardsOf(term.id)).toEqual({ secrets: false, coauthors: true });
    expect(ptyOf(term.id).env.GIT_CONFIG_PARAMETERS).toContain("core.hooksPath=");
  });

  it("starts an agent knowing the room's plan board, with its tool allowed (Claude) — so the SessionStart hook adds nothing", async () => {
    const { ryan, roomId } = await pair();
    const plan = new PlanService({
      roomGroups: () => [{ roomId, groupKey: "5110" }],
      sessions: () => ryan.sessions.list(),
      knownRepos: () => [],
      emit: () => {},
      log: (c, e) => String(e),
      author: () => ({ name: "Ryan" }),
      copiesFile: path.join(tempDir("copies"), "plan-copies.json"),
      timing: { pollMs: 60_000, fetchMs: 60_000 },
    });
    plan.start(ryan.m.team);
    try {
      const s = await ryan.start();
      const claude = ptyOf(s.id);
      const cmd = claude.args.join(" ");
      expect(cmd).toContain("--append-system-prompt");
      expect(cmd).toContain("Mockingbird team room");
      expect(cmd).toContain(claudeToolName(PLAN_TOOL));
      expect(claude.env[PLAN_CONTEXT_ENV]).toBe("1");
      const codex = ptyOf((await ryan.start({ agent: "codex" })).id);
      expect(codex.args.join(" ")).toContain(`'-c' 'developer_instructions="This repository is part of a Mockingbird team room`);
      expect(codex.env[PLAN_CONTEXT_ENV]).toBe("1");
      const term = ptyOf((await ryan.start({ shell: true, agent: undefined })).id);
      expect(term.args.join(" ")).not.toContain("--append-system-prompt");
      expect(term.env[PLAN_CONTEXT_ENV]).toBeUndefined();
      const outside = ptyOf((await ryan.start({ taskGroup: "private" })).id);
      expect(outside.args.join(" ")).not.toContain("--append-system-prompt");
      expect(outside.args.join(" ")).not.toContain(claudeToolName(PLAN_TOOL));
      expect(outside.env[PLAN_CONTEXT_ENV]).toBeUndefined();
    } finally {
      plan.stop();
    }
  });

  it("without the plan board running, an agent starts without it and the SessionStart hook adds it", async () => {
    const { ryan } = await pair();
    const s = await ryan.start();
    expect(ptyOf(s.id).args.join(" ")).not.toContain("--append-system-prompt");
    expect(ptyOf(s.id).env[PLAN_CONTEXT_ENV]).toBeUndefined();
    expect(ryan.logs.some((l) => /plan board for session/.test(l))).toBe(true);
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
    // the owner's resize reaches the teammate's copy
    ryan.sessions.resize(s.id, 100, 30);
    await until(() => remoteOf(nick, s.id)?.room?.cols === 100, "the new size");
  });
});
