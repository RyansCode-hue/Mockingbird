import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git, makeRepo, tempDir, write } from "./helpers";
import { loopbackRoom, until, type LoopbackMember } from "../src/main/team/loopback";
import { SessionManager } from "../src/main/sessions";
import { LivePanes } from "../src/main/team/livePanes";
import { liveRoomHost, TakeoverService } from "../src/main/team/takeover";
import { claudeProjectDir } from "../src/main/agentFiles";
import { LIVE_METHODS, remotePaneId, roomSessionKey } from "../src/shared/team/livePanes";
import { backupFreshness, roomBackupRef } from "../src/shared/team/takeover";
import { DEFAULT_SETTINGS, type NewSessionRequest, type Settings } from "../src/shared/types";

/**
 * Take-over joined to live panes: room sessions and their turn ends come from
 * the live panes, a taken-over session leaves the room on every laptop, and
 * an owner who was away when it happened catches up when they're back.
 */

type FakePty = { args: string[]; env: Record<string, string>; writes: string[] };
const ptys: FakePty[] = [];
vi.mock("node-pty", () => ({
  spawn: (_file: string, args: string[], opts: { env: Record<string, string> }) => {
    const p: FakePty = { args, env: opts.env, writes: [] };
    ptys.push(p);
    return { onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write: (d: string) => p.writes.push(d), resize() {}, kill() {}, pid: 1 };
  },
}));
const ptyOf = (id: string) => ptys.filter((p) => p.env.MOCKINGBIRD_SESSION === id).at(-1)!;

const CONV = "7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6";
const FAST = { publishMs: 40, batchMs: 1, heartbeatMs: 100, viewTtlMs: 3000, leaseMs: 3000, resyncMs: 30, gitMs: 60_000 };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0).reverse()) s();
});

/** A bare origin, Ryan's and Nick's clones, and Ryan's worktree on feature-x with work in progress. */
function repos() {
  const seed = makeRepo({ "README.md": "hello\n", "src/a.ts": "export const a = 1;\n" }, "app");
  const bare = path.join(tempDir("origin"), "app.git");
  sh(path.dirname(bare), "clone", "--bare", "-q", seed, bare);
  const ryanClone = path.join(tempDir("ryan-code"), "app");
  const nickClone = path.join(tempDir("nick-code"), "app");
  sh(path.dirname(ryanClone), "clone", "-q", bare, ryanClone);
  sh(path.dirname(nickClone), "clone", "-q", bare, nickClone);
  const wt = path.join(tempDir("ryan-wt"), "feature-x");
  git(ryanClone, "worktree", "add", "-q", "-b", "feature-x", wt);
  write(wt, { "src/a.ts": "export const a = 42; // edited\n", "notes/todo.md": "- untracked\n", ".env": "TOKEN=secret\n" });
  return { bare, ryanClone, nickClone, wt };
}

/** One member's Mockingbird: sessions, live panes and take-over, joined as index.ts joins them. */
function app(m: LoopbackMember, clone: string) {
  const dir = tempDir(`${m.name}-app`);
  const settings: Settings = { ...DEFAULT_SETTINGS, claudeBin: "/bin/echo", codexBin: "/bin/echo", workTrackerPath: path.join(dir, "WorkTracker") };
  const saved: any[] = [];
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
  sessions.scrollbackDir = path.join(dir, "scrollback");
  const logs: string[] = [];
  const log = (c: string, e: unknown) => {
    const s = `${c}: ${e instanceof Error ? e.message : String(e)}`;
    logs.push(s);
    return s;
  };
  const rooms = () => m.team.status().rooms.map((r) => ({ id: r.id, groupKey: r.groupKey }));
  const claudeProjects = path.join(dir, ".claude", "projects");
  const takenOver: string[] = [];
  const startLive = () => {
    const live = new LivePanes({
      team: () => m.team,
      rooms,
      sessions,
      settings: () => settings,
      notify: () => {},
      toWindow: () => {},
      audit: () => {},
      log,
      agentContext: () => "the room's plan",
      gitState: async () => ({ dirty: true, dirtyFiles: 1, branch: "feature-x", upstream: null, ahead: 0, behind: 0, insertions: 1, deletions: 1 }),
      originOf: async () => null,
      gitEmail: async () => null,
      dir: path.join(dir, "live"),
      hooksDir: path.join(dir, "live", "githooks"),
      coauthorsDir: path.join(dir, "live", "coauthors"),
      timing: FAST,
    });
    live.start();
    const tk = new TakeoverService({
      team: m.team,
      roomsDir: m.store.dir,
      host: liveRoomHost(live, { sessions: () => sessions.list(), rooms }),
      repos: () => [clone],
      launch: (req: NewSessionRequest) => sessions.create(req),
      log,
      onTakenOver: (id, by) => takenOver.push(`${id} by ${by}`),
      claudeProjects,
      codexSessions: path.join(dir, ".codex", "sessions"),
    });
    const stop = () => {
      tk.close();
      live.stop();
    };
    stops.push(stop);
    return { live, tk, stop };
  };
  return { m, sessions, logs, takenOver, claudeProjects, startLive };
}

async function setup() {
  const r = repos();
  const { members, roomId, net } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("team") });
  const [ryanM, nickM] = members;
  const ryan = app(ryanM, r.ryanClone);
  const nick = app(nickM, r.nickClone);
  const ryanRun = ryan.startLive();
  const nickRun = nick.startLive();
  // Ryan's room session, with a conversation on disk for its transcript
  const s = await ryan.sessions.create({ repoPath: r.ryanClone, cwd: r.wt, branchName: "feature-x", useWorktree: false, agent: "claude", taskGroup: "5110", title: "Donor entities" });
  const file = path.join(claudeProjectDir(r.wt, ryan.claudeProjects), `${CONV}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: "user", sessionId: CONV, cwd: r.wt, message: { role: "user", content: "Add the donor entity" } })}\n`);
  return { ...r, roomId, net, ryanM, nickM, ryan, nick, ryanRun, nickRun, s };
}

const backupIn = (m: LoopbackMember, roomId: string, id: string) => m.team.room(roomId)?.ext.takeover?.sessions[id];
const recordIn = (m: LoopbackMember, roomId: string, owner: string, id: string) => m.team.room(roomId)?.ext.sessions?.[roomSessionKey(owner, id)];
/** A turn of the agent: the hooks say it's working (on conversation CONV), then that it stopped. */
function turn(sessions: SessionManager, id: string) {
  sessions.statusFromHook({ paneId: id, status: "working", conversationId: CONV, agent: "claude" });
  sessions.statusFromHook({ paneId: id, status: "idle" });
}

describe("take-over over live panes", () => {
  it("backs up a room session at the end of each agent turn the live panes report, and the teammate sees how fresh it is", async () => {
    const t = await setup();
    await until(() => !!recordIn(t.nickM, t.roomId, t.ryanM.id, t.s.id), "Nick to see Ryan's session");
    turn(t.ryan.sessions, t.s.id);
    await until(() => !!backupIn(t.nickM, t.roomId, t.s.id)?.pushed, "the backup to reach origin and Nick", 15_000);
    await t.ryanRun.tk.settled();
    const ref = roomBackupRef(t.roomId, t.s.id);
    expect(sh(t.bare, "rev-parse", ref)).toMatch(/^[0-9a-f]{40}$/);
    expect(sh(t.bare, "ls-tree", "-r", "--name-only", ref)).not.toContain(".env");
    // Nick's view of it: Ryan's, backed up, with the peer copy here
    const v = t.nickRun.tk.view().sessions.find((x) => x.sessionId === t.s.id)!;
    expect(v).toMatchObject({ self: false, owner: t.ryanM.id, ownerOnline: true });
    expect(backupFreshness(v).text).toMatch(/^backed up/);
    // a terminal's status never counts as a turn: no backup for it
    const term = await t.ryan.sessions.create({ repoPath: t.ryanClone, cwd: t.wt, useWorktree: false, shell: true, taskGroup: "5110", title: "term" });
    t.ryan.sessions.statusFromHook({ paneId: term.id, status: "working" });
    t.ryan.sessions.statusFromHook({ paneId: term.id, status: "idle" });
    await t.ryanRun.tk.settled();
    expect(backupIn(t.ryanM, t.roomId, term.id)).toBeUndefined();
  });

  it("an owner away at take-over time comes back to their copy out of the room: unshared, untypeable, taken over by the teammate", async () => {
    const t = await setup();
    turn(t.ryan.sessions, t.s.id);
    await until(() => !!backupIn(t.nickM, t.roomId, t.s.id)?.pushed && t.nickRun.tk.view().sessions.some((v) => v.sessionId === t.s.id && v.transcript?.have), "the backup and conversation at Nick's", 15_000);
    await t.ryanRun.tk.settled();
    // Ryan's laptop goes to sleep; Nick takes over
    t.net.setOnline(t.ryanM.id, false);
    await until(() => !t.nickM.team.presence(t.roomId).includes(t.ryanM.id), "Ryan to be offline");
    const r = await t.nickRun.tk.takeOver(t.roomId, t.s.id, null);
    expect(r.conversation).toBe("full");
    expect(fs.readFileSync(path.join(r.cwd, "src/a.ts"), "utf8")).toBe("export const a = 42; // edited\n");
    expect(fs.existsSync(path.join(r.cwd, ".env"))).toBe(false);
    // it runs on Nick's Mac, in the room's group, resuming the conversation
    const mine = t.nick.sessions.list().find((x) => x.id === r.sessionId)!;
    expect(mine).toMatchObject({ cwd: r.cwd, taskGroup: "5110" });
    expect(ptyOf(r.sessionId).args.join(" ")).toContain(`'--resume' '${CONV}'`);
    // Nick's own session is the room's now; Ryan's stale record (he can't remove it while away) isn't shown
    await until(() => !!recordIn(t.nickM, t.roomId, t.nickM.id, r.sessionId), "Nick's session in the room");
    expect(recordIn(t.nickM, t.roomId, t.ryanM.id, t.s.id)).toBeTruthy();
    await until(() => !t.nickRun.live.state().remote.some((x) => x.id === remotePaneId(t.ryanM.id, t.s.id)), "Ryan's copy to drop from Nick's window");
    expect(t.nickRun.live.state().own[r.sessionId]).toMatchObject({ remote: false, roomId: t.roomId });

    // Ryan is back: his Mockingbird hears of it and takes its copy out of the room
    t.net.setOnline(t.ryanM.id, true);
    await until(() => !!backupIn(t.ryanM, t.roomId, t.s.id)?.takenOver, "Ryan to hear of the take-over");
    await until(() => !recordIn(t.nickM, t.roomId, t.ryanM.id, t.s.id), "Ryan's record to be removed from the room");
    expect(t.ryan.takenOver).toEqual([`${t.s.id} by Nick`]);
    expect(t.ryanRun.live.roomOfSession(t.s.id)).toBeNull();
    expect(t.ryanRun.live.state().own[t.s.id]).toMatchObject({ takenOver: { by: t.nickM.id, byName: "Nick" } });
    // Nick's session shows on Ryan's side instead
    await until(() => t.ryanRun.live.state().remote.some((x) => x.id === remotePaneId(t.nickM.id, r.sessionId)), "Nick's session at Ryan's");
    // nobody types into Ryan's old copy, and its turns are no longer backed up
    await expect(t.nickM.team.request(t.ryanM.id, LIVE_METHODS.input, { session: t.s.id, data: "hi\r" }, { roomId: t.roomId })).rejects.toThrow(/taken over by Nick/);
    expect(ptyOf(t.s.id).writes.join("")).not.toContain("hi");
    const before = backupIn(t.ryanM, t.roomId, t.s.id)!.latest.sha;
    write(t.wt, { "src/later.ts": "after the take-over\n" });
    turn(t.ryan.sessions, t.s.id);
    await t.ryanRun.tk.settled();
    expect(backupIn(t.ryanM, t.roomId, t.s.id)!.latest.sha).toBe(before);
  });

  it("an owner whose Mockingbird was quit reconciles on its next start", async () => {
    const t = await setup();
    turn(t.ryan.sessions, t.s.id);
    await until(() => !!backupIn(t.nickM, t.roomId, t.s.id)?.pushed, "the backup at Nick's", 15_000);
    await t.ryanRun.tk.settled();
    // Ryan quits: his live panes and take-over stop, and his laptop leaves the network
    t.ryanRun.stop();
    t.net.setOnline(t.ryanM.id, false);
    await until(() => !t.nickM.team.presence(t.roomId).includes(t.ryanM.id), "Ryan to be offline");
    const r = await t.nickRun.tk.takeOver(t.roomId, t.s.id, null);
    // Ryan starts again (his session record still in his room log), then reconnects
    const again = t.ryan.startLive();
    t.net.setOnline(t.ryanM.id, true);
    await until(() => !recordIn(t.nickM, t.roomId, t.ryanM.id, t.s.id), "Ryan's record to be removed from the room");
    expect(again.live.state().own[t.s.id]?.takenOver?.byName).toBe("Nick");
    await until(() => !!recordIn(t.ryanM, t.roomId, t.nickM.id, r.sessionId), "Nick's session in Ryan's room log");
  });
});
