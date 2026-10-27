import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git, makeRepo, tempDir, write } from "./helpers";
import { loopbackRoom, until, type LoopbackMember } from "../src/main/team/loopback";
import { SessionManager } from "../src/main/sessions";
import { LivePanes } from "../src/main/team/livePanes";
import { liveRoomHost, TakeoverService, type TakeoverDeps } from "../src/main/team/takeover";
import { claudeProjectDir } from "../src/main/agentFiles";
import { LIVE_METHODS, remotePaneId, roomSessionKey } from "../src/shared/team/livePanes";
import { backupFreshness, backupOf, roomBackupRef, type IncomingAsk } from "../src/shared/team/takeover";
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
const NICK_CONV = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
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
function app(m: LoopbackMember, clone: string, takeoverOpts: Partial<TakeoverDeps> = {}) {
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
  const chat: string[] = [];
  const asks: IncomingAsk[] = [];
  /** How often the window was told the take-over view changed. */
  const viewChanges = { n: 0 };
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
      host: liveRoomHost(live, { sessions: () => sessions.list(), resumable: () => sessions.resumable(), rooms, stop: (id) => sessions.stop(id) }),
      repos: () => [clone],
      launch: (req: NewSessionRequest) => sessions.create(req),
      log,
      onTakenOver: (id, by) => takenOver.push(`${id} by ${by}`),
      onAsk: (a) => asks.push(a),
      chat: (_roomId, text) => chat.push(text),
      changed: () => viewChanges.n++,
      claudeProjects,
      codexSessions: path.join(dir, ".codex", "sessions"),
      ...takeoverOpts,
    });
    // as index.ts does: a session a teammate continues never runs here again
    sessions.relaunchGuard = (id) => tk.relaunchRefusal(id);
    const stop = () => {
      tk.close();
      live.stop();
    };
    stops.push(stop);
    return { live, tk, stop };
  };
  return { m, sessions, logs, takenOver, chat, asks, viewChanges, claudeProjects, startLive };
}

/** Ryan's room session with Nick; the room backs up to origin (its admin, Ryan, turned that on) unless `backupsToOrigin: false` keeps it peer to peer, as every room starts. */
async function setup(takeoverOpts: Partial<TakeoverDeps> = {}, o: { backupsToOrigin?: boolean } = {}) {
  const r = repos();
  const { members, roomId, net } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("team") });
  const [ryanM, nickM] = members;
  if (o.backupsToOrigin !== false) {
    ryanM.team.publish(roomId, "room.settings", { backupsToOrigin: true });
    await until(() => nickM.team.room(roomId)?.ext.settings?.backupsToOrigin === true, "Nick to hear the room backs up to origin");
  }
  const ryan = app(ryanM, r.ryanClone, takeoverOpts);
  const nick = app(nickM, r.nickClone, takeoverOpts);
  const ryanRun = ryan.startLive();
  const nickRun = nick.startLive();
  // backing up to origin needs each member's own consent too: both allowed it (kept on their Macs, across restarts)
  if (o.backupsToOrigin !== false) for (const run of [ryanRun, nickRun]) run.tk.setBackupConsent(roomId, true);
  // Ryan's room session, with a conversation on disk for its transcript
  const s = await ryan.sessions.create({ repoPath: r.ryanClone, cwd: r.wt, branchName: "feature-x", useWorktree: false, agent: "claude", taskGroup: "5110", title: "Donor entities" });
  const file = path.join(claudeProjectDir(r.wt, ryan.claudeProjects), `${CONV}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: "user", sessionId: CONV, cwd: r.wt, message: { role: "user", content: "Add the donor entity" } })}\n`);
  return { ...r, roomId, net, ryanM, nickM, ryan, nick, ryanRun, nickRun, s };
}

const backupIn = (m: LoopbackMember, roomId: string, id: string) => m.team.room(roomId)?.ext.takeover?.sessions[id];
const statusOf = (sessions: SessionManager, id: string) => sessions.list().find((x) => x.id === id)?.status;
/** Every file in a working tree but .git, with its content. */
function files(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}
const recordIn = (m: LoopbackMember, roomId: string, owner: string, id: string) => m.team.room(roomId)?.ext.sessions?.[roomSessionKey(owner, id)];
/** A turn of the agent: the hooks say it's working (on conversation CONV), then that it stopped. */
function turn(sessions: SessionManager, id: string) {
  sessions.statusFromHook({ paneId: id, status: "working", conversationId: CONV, agent: "claude" });
  sessions.statusFromHook({ paneId: id, status: "idle" });
}

describe("a room session's backup in the window", () => {
  it("is found by its room, owner and the owner's session id — never by the window's id for it", () => {
    const view = (owner: string, sessionId: string, roomId = "R1") => ({ roomId, owner, sessionId }) as any;
    const ryan = "a".repeat(32);
    const nick = "b".repeat(32);
    const v = { sessions: [view(ryan, "s1"), view(nick, "s1"), view(nick, "s2", "R2")], rooms: [], unbacked: [], cleanup: [], asks: [], asking: [], left: [], received: [], refused: [] };
    // Nick's s1 shows here as remotePaneId(nick, "s1"); its tag still names s1
    expect(backupOf(v, { roomId: "R1", sessionId: "s1", owner: nick })).toBe(v.sessions[1]);
    expect(backupOf(v, { roomId: "R1", sessionId: "s1", owner: ryan })).toBe(v.sessions[0]);
    expect(backupOf(v, { roomId: "R1", sessionId: "s2", owner: nick })).toBeNull();
    expect(backupOf(v, undefined)).toBeNull();
    expect(backupOf(null, { roomId: "R1", sessionId: "s1", owner: ryan })).toBeNull();
  });
});

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
    // it runs on Nick's Mac, in the room's group, as a new conversation started from a brief
    const mine = t.nick.sessions.list().find((x) => x.id === r.sessionId)!;
    expect(mine).toMatchObject({ cwd: r.cwd, taskGroup: "5110" });
    expect(ptyOf(r.sessionId).args.join(" ")).not.toContain("--resume");
    // Nick's own session is the room's now; Ryan's stale record (he can't remove it while away) isn't shown
    await until(() => !!recordIn(t.nickM, t.roomId, t.nickM.id, r.sessionId), "Nick's session in the room");
    expect(recordIn(t.nickM, t.roomId, t.ryanM.id, t.s.id)).toBeTruthy();
    await until(() => !t.nickRun.live.state().remote.some((x) => x.id === remotePaneId(t.ryanM.id, t.s.id)), "Ryan's copy to drop from Nick's window");
    expect(t.nickRun.live.state().own[r.sessionId]).toMatchObject({ remote: false, roomId: t.roomId });

    // Ryan is back: his Mockingbird hears of it and takes its copy out of the room
    const filesBefore = files(t.wt);
    t.net.setOnline(t.ryanM.id, true);
    await until(() => !!backupIn(t.ryanM, t.roomId, t.s.id)?.takenOver, "Ryan to hear of the take-over");
    // ...and stops it: the agent ends, every file in its worktree stays as it was, and it never runs again here
    await until(() => statusOf(t.ryan.sessions, t.s.id) === "dead", "Ryan's copy to stop");
    expect(files(t.wt)).toEqual(filesBefore);
    await expect(t.ryan.sessions.relaunch(t.s.id)).rejects.toThrow(/continues on Nick's laptop — take it back/);
    await expect(t.ryan.sessions.restart(t.s.id)).rejects.toThrow(/continues on Nick's laptop/);
    expect(statusOf(t.ryan.sessions, t.s.id)).toBe("dead"); // the refused restart didn't close the pane either
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

  it("tells the window when a session's owner goes away, so Take over can lead", async () => {
    const t = await setup();
    turn(t.ryan.sessions, t.s.id);
    await until(() => !!backupIn(t.nickM, t.roomId, t.s.id)?.pushed, "the backup at Nick's", 15_000);
    await new Promise((r) => setTimeout(r, 300));
    const before = t.nick.viewChanges.n;
    t.net.setOnline(t.ryanM.id, false);
    await until(() => t.nick.viewChanges.n > before, "the window to be told");
    expect(t.nickRun.tk.view().sessions.find((v) => v.sessionId === t.s.id)).toMatchObject({ ownerOnline: false });
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

/** Ryan's session backed up after a turn, then Ryan offline: Nick can take it over from that backup. */
async function takenOverWhileAway(t: Awaited<ReturnType<typeof setup>>) {
  turn(t.ryan.sessions, t.s.id);
  await until(() => !!backupIn(t.nickM, t.roomId, t.s.id)?.pushed && t.nickRun.tk.view().sessions.some((v) => v.sessionId === t.s.id && v.transcript?.have), "the backup and conversation at Nick's", 15_000);
  await t.ryanRun.tk.settled();
  t.net.setOnline(t.ryanM.id, false);
  await until(() => !t.nickM.team.presence(t.roomId).includes(t.ryanM.id), "Ryan to be offline");
}

describe("the copy a take-over leaves behind", () => {
  it("stops when the owner's Mockingbird starts again, even one relaunched before it reconnected — and doesn't run again after that", async () => {
    const t = await setup();
    await takenOverWhileAway(t);
    // Ryan quits: the pane closes to resume, as quitting leaves it
    t.ryan.sessions.kill(t.s.id, false);
    t.ryanRun.stop();
    const r = await t.nickRun.tk.takeOver(t.roomId, t.s.id, null);
    const before = files(t.wt);
    // he starts again and his open session runs again (as an update restart relaunches it), before the room catches up
    const again = t.ryan.startLive();
    await t.ryan.sessions.create({ repoPath: t.ryanClone, cwd: t.wt, useWorktree: false, agent: "claude", taskGroup: "5110", title: "Donor entities", reuseId: t.s.id });
    expect(statusOf(t.ryan.sessions, t.s.id)).not.toBe("dead");
    t.net.setOnline(t.ryanM.id, true);
    await until(() => statusOf(t.ryan.sessions, t.s.id) === "dead", "the relaunched copy to stop once he hears");
    expect(files(t.wt)).toEqual(before);
    expect(again.tk.view().left).toEqual([
      expect.objectContaining({ sessionId: t.s.id, byName: "Nick", now: expect.objectContaining({ owner: t.nickM.id, sessionId: r.sessionId, self: false, online: true }) }),
    ]);
    // the next start knows from the room log already: the copy stays stopped, and relaunching it is refused
    t.ryan.sessions.kill(t.s.id, false);
    again.stop();
    const third = t.ryan.startLive();
    await expect(t.ryan.sessions.relaunch(t.s.id)).rejects.toThrow(/continues on Nick's laptop/);
    expect(third.tk.relaunchRefusal("someone-else")).toBeNull();
  });

  it("counts the files the copy changed after the snapshot the teammate continued from, and sends them as a patch that lands on their session to review — never applied by itself", async () => {
    const t = await setup();
    await takenOverWhileAway(t);
    // offline (its laptop asleep mid-turn: nothing backed up), Ryan's agent kept working: an edit, a new file, a deletion (and a secret, staged even, which never leaves)
    write(t.wt, { "src/a.ts": "export const a = 43; // offline\n", "src/offline.ts": "export const later = true;\n", ".env": "TOKEN=changed\n" });
    git(t.wt, "add", ".env");
    fs.rmSync(path.join(t.wt, "notes/todo.md"));
    const r = await t.nickRun.tk.takeOver(t.roomId, t.s.id, null);
    expect(fs.readFileSync(path.join(r.cwd, "src/a.ts"), "utf8")).toBe("export const a = 42; // edited\n");
    t.net.setOnline(t.ryanM.id, true);
    await until(() => statusOf(t.ryan.sessions, t.s.id) === "dead", "Ryan's copy to stop");
    const left = () => t.ryanRun.tk.view().left.find((l) => l.sessionId === t.s.id)!;
    await until(() => !!left()?.unsent, "the copy's changes counted");
    expect(left().unsent).toEqual({ files: ["notes/todo.md", "src/a.ts", "src/offline.ts"], checkedAt: expect.any(Number) });
    expect(left().takeBack).toBe(false); // Nick's copy has no backup yet

    // Send to Nick: a patch on his session, his worktree as it was
    const nickBefore = files(r.cwd);
    await expect(t.ryanRun.tk.sendLeft(t.roomId, t.s.id)).resolves.toEqual({ files: 3 });
    expect(t.ryan.chat).toEqual([`Sent Nick 3 changed files from my copy of “Donor entities”, made after the snapshot they continued from. They're on Nick's session to review and apply.`]);
    expect(left()).toMatchObject({ unsent: { files: [] }, sent: { files: 3 } });
    await expect(t.ryanRun.tk.sendLeft(t.roomId, t.s.id)).rejects.toThrow(/Nothing to send: Nick has everything in this copy/);
    const got = t.nickRun.tk.view().received;
    expect(got).toEqual([
      expect.objectContaining({
        sessionId: r.sessionId,
        fromSessionId: t.s.id,
        fromName: "Ryan",
        applied: null,
        files: [
          { path: "notes/todo.md", status: "deleted" },
          { path: "src/a.ts", status: "modified" },
          { path: "src/offline.ts", status: "added" },
        ],
      }),
    ]);
    expect(files(r.cwd)).toEqual(nickBefore);
    const { patch } = await t.nickRun.tk.receivedPatch(t.roomId, got[0].id);
    expect(patch).toContain("+export const a = 43; // offline");
    expect(patch).not.toContain("TOKEN");

    // Nick changed src/a.ts too: applying refuses and changes nothing
    write(r.cwd, { "src/a.ts": "export const a = 99; // Nick's\n" });
    await expect(t.nickRun.tk.applyReceived(t.roomId, got[0].id)).rejects.toThrow(/don't apply cleanly to this worktree, so nothing was changed — changed here too: src\/a\.ts\. To merge them by hand: git apply --3way /);
    expect(fs.existsSync(path.join(r.cwd, "src/offline.ts"))).toBe(false);
    // with his edit undone, they apply: Ryan's files in Nick's worktree, uncommitted, and an Undo-turn snapshot from before
    write(r.cwd, { "src/a.ts": "export const a = 42; // edited\n" });
    await expect(t.nickRun.tk.applyReceived(t.roomId, got[0].id)).resolves.toEqual({ files: 3 });
    expect(fs.readFileSync(path.join(r.cwd, "src/a.ts"), "utf8")).toBe("export const a = 43; // offline\n");
    expect(fs.readFileSync(path.join(r.cwd, "src/offline.ts"), "utf8")).toBe("export const later = true;\n");
    expect(fs.existsSync(path.join(r.cwd, "notes/todo.md"))).toBe(false);
    expect(fs.existsSync(path.join(r.cwd, ".env"))).toBe(false);
    expect(sh(r.cwd, "for-each-ref", "--format=%(refname)", `refs/mockingbird/snapshots/${r.sessionId}/`)).not.toBe("");
    expect(t.nickRun.tk.view().received[0].applied).toEqual(expect.any(Number));
    await expect(t.nickRun.tk.applyReceived(t.roomId, got[0].id)).rejects.toThrow(/applied already/);
    await t.nickRun.tk.dismissReceived(t.roomId, got[0].id);
    expect(t.nickRun.tk.view().received).toEqual([]);

    // later edits in Ryan's copy count from what was sent
    write(t.wt, { "src/b.ts": "b\n" });
    await t.ryanRun.tk.checkLeft(t.roomId, t.s.id);
    expect(left().unsent).toMatchObject({ files: ["src/b.ts"] });
    // and a teammate can't send changes for a session that isn't theirs
    await expect(
      t.nickM.team.request(t.ryanM.id, "takeover.changes", { roomId: t.roomId, sessionId: r.sessionId, title: "x", files: [{ path: "a", status: "added" }], patch: "eA==" }, { roomId: t.roomId })
    ).rejects.toThrow(/isn't a session of Nick's that was continued/);
  });

  it("takes it back: Nick's copy continues on Ryan's laptop again, asking Nick first, and Nick's copy stops in turn", async () => {
    const t = await setup();
    await takenOverWhileAway(t);
    const r = await t.nickRun.tk.takeOver(t.roomId, t.s.id, null);
    t.net.setOnline(t.ryanM.id, true);
    await until(() => statusOf(t.ryan.sessions, t.s.id) === "dead", "Ryan's copy to stop");
    // Nick works on, in a conversation of his own (it started from the brief): a turn, backed up — now it can be taken back
    write(r.cwd, { "src/nick.ts": "by nick\n" });
    const nickFile = path.join(claudeProjectDir(fs.realpathSync(r.cwd), t.nick.claudeProjects), `${NICK_CONV}.jsonl`);
    fs.mkdirSync(path.dirname(nickFile), { recursive: true });
    fs.writeFileSync(nickFile, [{ type: "user", message: { role: "user", content: "Carry on with the export" } }, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Wrote src/nick.ts" }] } }].map((l) => `${JSON.stringify({ ...l, sessionId: NICK_CONV, cwd: r.cwd })}\n`).join(""));
    t.nick.sessions.statusFromHook({ paneId: r.sessionId, status: "working", conversationId: NICK_CONV, agent: "claude" });
    t.nick.sessions.statusFromHook({ paneId: r.sessionId, status: "idle" });
    const left = () => t.ryanRun.tk.view().left.find((l) => l.sessionId === t.s.id);
    await until(() => !!left()?.takeBack, "Take it back to be offered", 15_000);
    await until(() => !!t.ryanRun.tk.view().sessions.find((v) => v.sessionId === r.sessionId)?.peerCopy, "Nick's snapshot at Ryan's", 15_000);
    await until(() => !!t.ryanRun.tk.view().sessions.find((v) => v.sessionId === r.sessionId)?.transcript?.have, "Nick's conversation at Ryan's", 15_000);
    expect(await t.ryanRun.tk.plan(t.roomId, r.sessionId)).toMatchObject({ resumesOwn: true, conversation: { kind: "full" } });
    // Nick is connected: he's asked, and hands over
    const back = t.ryanRun.tk.takeOver(t.roomId, r.sessionId, null);
    await until(() => t.nick.asks.length === 1, "Nick to be asked");
    expect(t.nick.asks[0]).toMatchObject({ fromName: "Ryan", sessionId: r.sessionId, title: "Donor entities" });
    t.nickRun.tk.answerAsk(t.nick.asks[0].askId, "handover");
    const mine = await back;
    expect(statusOf(t.nick.sessions, r.sessionId)).toBe("dead");
    expect(fs.readFileSync(path.join(mine.cwd, "src/nick.ts"), "utf8")).toBe("by nick\n");
    expect(statusOf(t.ryan.sessions, mine.sessionId)).toBe("working"); // the new copy runs here
    // on Ryan's account it resumes Ryan's own conversation, not Nick's, and is told first what Nick did
    expect(ptyOf(mine.sessionId).args.join(" ")).toContain(`'--resume' '${CONV}'`);
    expect(fs.readFileSync(path.join(mine.cwd, ".mockingbird", "takeover", `${NICK_CONV}.jsonl`), "utf8")).toBe(fs.readFileSync(nickFile, "utf8"));
    await until(() => ptyOf(mine.sessionId).writes.join("").includes("Ryan took this session back from Nick"), "the brief of Nick's turns", 15_000);
    const brief = ptyOf(mine.sessionId).writes.join("");
    expect(brief).toContain("AGENT: Wrote src/nick.ts");
    expect(brief).toContain("src/nick.ts (new, untracked)");
    // Ryan's old copy now says it continues here; Nick's says it continues on Ryan's laptop
    expect(left()).toMatchObject({ now: { self: true, sessionId: mine.sessionId }, takeBack: false });
    await until(() => !!t.nickRun.tk.view().left.some((l) => l.sessionId === r.sessionId && l.now.owner === t.ryanM.id), "Nick's copy to know");
    await expect(t.ryan.sessions.relaunch(t.s.id)).rejects.toThrow(/was taken back into another session here/);
    // the session taken back backs up its own conversation, not the stopped copy's (same conversation, another worktree)
    turn(t.ryan.sessions, mine.sessionId);
    const copy = path.join(t.nickM.store.dir, t.roomId, "transcripts", mine.sessionId, `${CONV}.jsonl`);
    await until(() => fs.existsSync(copy), "the taken-back conversation at Nick's", 15_000);
    await t.ryanRun.tk.settled();
    expect(JSON.parse(fs.readFileSync(copy, "utf8").split("\n")[0]).cwd).toBe(fs.realpathSync(mine.cwd));
  }, 60_000); // the brief is typed in 6s after the agent starts
});

describe("asking a connected owner first", () => {
  it("hands over: the turn in progress finishes, that snapshot goes to the taker, the owner's agent stops, and the take-over uses exactly it", async () => {
    const t = await setup();
    turn(t.ryan.sessions, t.s.id);
    await until(() => !!backupIn(t.nickM, t.roomId, t.s.id)?.pushed, "a first backup at Nick's", 15_000);
    await t.ryanRun.tk.settled();
    // Ryan's agent is mid-turn when Nick asks
    t.ryan.sessions.statusFromHook({ paneId: t.s.id, status: "working", conversationId: CONV, agent: "claude" });
    const taking = t.nickRun.tk.takeOver(t.roomId, t.s.id, null);
    await until(() => t.ryanRun.tk.view().asks.length === 1, "Ryan to be asked");
    const ask = t.ryanRun.tk.view().asks[0];
    expect(ask).toMatchObject({ fromName: "Nick", sessionId: t.s.id, title: "Donor entities", state: "waiting", deadline: ask.at + 120_000 });
    expect(t.ryan.asks).toEqual([ask]); // and he's notified
    expect(t.nickRun.tk.view().asking).toEqual([expect.objectContaining({ sessionId: t.s.id, ownerName: "Ryan", state: "asking" })]);
    t.ryanRun.tk.answerAsk(ask.askId, "handover");
    await until(() => t.nickRun.tk.view().asking[0]?.state === "handing-over", "Nick to hear it's being handed over");
    // the turn goes on: nothing stops yet
    await new Promise((res) => setTimeout(res, 300));
    expect(statusOf(t.ryan.sessions, t.s.id)).toBe("working");
    write(t.wt, { "src/last-turn.ts": "written in the turn that was running\n" });
    t.ryan.sessions.statusFromHook({ paneId: t.s.id, status: "idle" });
    const r = await taking;
    // Ryan's agent stopped; Nick continues from the snapshot taken after that turn, with its file
    expect(statusOf(t.ryan.sessions, t.s.id)).toBe("dead");
    const handed = backupIn(t.ryanM, t.roomId, t.s.id)!.latest.sha;
    expect(r.snapshot.sha).toBe(handed);
    expect(fs.readFileSync(path.join(r.cwd, "src/last-turn.ts"), "utf8")).toBe("written in the turn that was running\n");
    expect(r.conversation).toBe("full");
    expect(t.ryanRun.tk.view().asks).toEqual([]);
    expect(t.nickRun.tk.view().asking).toEqual([]);
    // Ryan's copy: continued on Nick's laptop, nothing Nick lacks
    await until(() => !!t.ryanRun.tk.view().left.find((l) => l.sessionId === t.s.id)?.unsent, "Ryan's copy counted");
    expect(t.ryanRun.tk.view().left[0]).toMatchObject({ byName: "Nick", unsent: { files: [] } });
  });

  it("hands over peer to peer in a room that keeps backups off origin: nothing reaches origin", async () => {
    const t = await setup({}, { backupsToOrigin: false });
    turn(t.ryan.sessions, t.s.id);
    await until(() => !!t.nickRun.tk.view().sessions.find((v) => v.sessionId === t.s.id)?.peerCopy, "a first copy at Nick's", 15_000);
    await t.ryanRun.tk.settled();
    write(t.wt, { "src/since.ts": "after the copy Nick has\n" });
    const taking = t.nickRun.tk.takeOver(t.roomId, t.s.id, null);
    await until(() => t.ryanRun.tk.view().asks.length === 1, "Ryan to be asked");
    t.ryanRun.tk.answerAsk(t.ryanRun.tk.view().asks[0].askId, "handover");
    const r = await taking;
    // the hand-over's own snapshot, sent straight to Nick: the work since his copy included
    expect(r.snapshot).toMatchObject({ sha: backupIn(t.ryanM, t.roomId, t.s.id)!.latest.sha, source: "peer" });
    expect(fs.readFileSync(path.join(r.cwd, "src/since.ts"), "utf8")).toBe("after the copy Nick has\n");
    expect(statusOf(t.ryan.sessions, t.s.id)).toBe("dead");
    expect(sh(t.bare, "for-each-ref", "refs/mockingbird")).toBe("");
    expect(sh(t.nickClone, "for-each-ref", "refs/mockingbird/rooms-origin")).toBe("");
  });

  it("keeps it: the taker is told, the owner's agent runs on, nothing is taken over", async () => {
    const t = await setup();
    turn(t.ryan.sessions, t.s.id);
    await until(() => !!backupIn(t.nickM, t.roomId, t.s.id)?.pushed, "a backup at Nick's", 15_000);
    const taking = t.nickRun.tk.takeOver(t.roomId, t.s.id, null);
    await until(() => t.ryanRun.tk.view().asks.length === 1, "Ryan to be asked");
    t.ryanRun.tk.answerAsk(t.ryanRun.tk.view().asks[0].askId, "keep");
    await expect(taking).rejects.toThrow(/Ryan kept “Donor entities”: it carries on on their laptop/);
    expect(statusOf(t.ryan.sessions, t.s.id)).not.toBe("dead");
    expect(backupIn(t.nickM, t.roomId, t.s.id)!.takenOver).toBeNull();
    expect(t.nick.sessions.list()).toEqual([]);
    expect(() => t.ryanRun.tk.answerAsk("0".repeat(24), "handover")).toThrow(/withdrawn, answered, or timed out/);
  });

  it("keeps it when the owner doesn't answer in time", async () => {
    const t = await setup({ askMs: 400 });
    turn(t.ryan.sessions, t.s.id);
    await until(() => !!backupIn(t.nickM, t.roomId, t.s.id)?.pushed, "a backup at Nick's", 15_000);
    await expect(t.nickRun.tk.takeOver(t.roomId, t.s.id, null)).rejects.toThrow(/Ryan didn't answer in time, so “Donor entities” stays on their laptop/);
    expect(t.ryanRun.tk.view().asks).toEqual([]);
    expect(statusOf(t.ryan.sessions, t.s.id)).not.toBe("dead");
  });

  it("an owner who drops offline mid-request leaves it to a normal take-over from the newest backup", async () => {
    const t = await setup();
    turn(t.ryan.sessions, t.s.id);
    await until(() => !!backupIn(t.nickM, t.roomId, t.s.id)?.pushed, "a backup at Nick's", 15_000);
    await t.ryanRun.tk.settled();
    const taking = t.nickRun.tk.takeOver(t.roomId, t.s.id, null);
    await until(() => t.ryanRun.tk.view().asks.length === 1, "Ryan to be asked");
    t.net.setOnline(t.ryanM.id, false);
    await expect(taking).rejects.toThrow(/Ryan went offline before handing “Donor entities” over — you can take it over from the newest backup now/);
    await until(() => t.ryanRun.tk.view().asks.length === 0, "the request to lapse at Ryan's");
    expect(statusOf(t.ryan.sessions, t.s.id)).not.toBe("dead"); // nothing was handed over: his agent runs until he hears
    const plan = await t.nickRun.tk.plan(t.roomId, t.s.id);
    expect(plan.ownerOnline).toBe(false);
    const r = await t.nickRun.tk.takeOver(t.roomId, t.s.id, null);
    expect(r.snapshot.sha).toBe(backupIn(t.nickM, t.roomId, t.s.id)!.latest.sha);
    t.net.setOnline(t.ryanM.id, true);
    await until(() => statusOf(t.ryan.sessions, t.s.id) === "dead", "Ryan's copy to stop when he's back");
  });
});
