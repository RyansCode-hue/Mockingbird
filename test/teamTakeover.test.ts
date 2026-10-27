import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { git, makeRepo, tempDir, write } from "./helpers";
import { loopbackRoom, until, type LoopbackMember } from "../src/main/team/loopback";
import { liveRoomHost, TakeoverService, TRANSCRIPT_CHUNK } from "../src/main/team/takeover";
import { ROOM_LIMITS } from "../src/main/team/roomLimits";
import { RoomStore } from "../src/main/team/rooms";
import { TurnFeed } from "../src/main/team/roomSessions";
import { agentFor } from "../src/main/agents";
import { claudeProjectDir, codexRolloutPath, realpathOr } from "../src/main/agentFiles";
import { publicUrl, repoIdentity, withoutCredentials } from "../src/main/git";
import { rebaseTranscript } from "../src/main/transcripts";
import { worktreeAt } from "../src/main/worktrees";
import { grantProblem, signGrant } from "../src/main/team/takeoverGrants";
import { offlineTakeoverRefusal } from "../src/main/team/takeover";
import { ConnectionLog, connectedThen, CONNECTED_KEEP_MS } from "../src/main/team/connectionLog";
import { backupFreshness, HANDOVER_GRANT_MS, NOT_ALLOWED, NOT_PUSHED, remoteLabel, type TakeoverGrant, roomBackupRef, type IncomingAsk, type ReceivedChanges, type RoomSessionBackupView } from "../src/shared/team/takeover";
import type { NewSessionRequest, SessionInfo } from "../src/shared/types";

const CONV = "7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6";
const CODEX_CONV = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A bare "origin" and two clones of it (Ryan's and Nick's laptops), plus Ryan's session worktree on feature-x with work in progress. */
function repos() {
  const seed = makeRepo({ "README.md": "hello\n", "src/a.ts": "export const a = 1;\n", "src/gone.ts": "old\n", ".gitignore": "*.log\n" }, "app");
  const bare = path.join(tempDir("origin"), "app.git");
  sh(path.dirname(bare), "clone", "--bare", "-q", seed, bare);
  const ryanClone = path.join(tempDir("ryan-code"), "app");
  const nickClone = path.join(tempDir("nick-code"), "app");
  sh(path.dirname(ryanClone), "clone", "-q", bare, ryanClone);
  sh(path.dirname(nickClone), "clone", "-q", bare, nickClone);
  const wt = path.join(tempDir("ryan-wt"), "feature-x");
  git(ryanClone, "worktree", "add", "-q", "-b", "feature-x", wt);
  // a commit only Ryan has (never pushed), then uncommitted work: an edit, a staged file, an untracked file, a deletion
  write(wt, { "src/b.ts": "export const b = 2;\n" });
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "local only");
  write(wt, { "src/a.ts": "export const a = 42; // edited\n", "src/staged.ts": "staged\n", "notes/todo.md": "- untracked\n", "debug.log": "ignored\n", ".env": "TOKEN=secret\n", "certs/dev.pem": "KEY\n" });
  git(wt, "add", "src/staged.ts");
  fs.rmSync(path.join(wt, "src/gone.ts"));
  return { bare, ryanClone, nickClone, wt };
}

function session(o: Partial<SessionInfo> & { id: string; cwd: string; repoPath: string }): SessionInfo {
  return {
    title: "Donor entities",
    branch: "feature-x",
    ticketId: null,
    ticketTitle: null,
    taskGroup: "5110",
    status: "idle",
    createdAt: 0,
    kind: "work",
    extraDirs: [],
    waitingReason: null,
    waitingSince: null,
    agent: "claude",
    conversation: { agent: "claude", id: CONV },
    ...o,
  };
}

/** A member's take-over service over fakes for the app: its sessions, its repositories, a launch that only records. */
function takeover(m: LoopbackMember, roomId: string, o: { repos: string[]; sessions?: SessionInfo[]; now?: () => number; askMs?: number; skew?: number }) {
  const sessions = new Map((o.sessions ?? []).map((s) => [s.id, s]));
  const turnEnds = new Set<(id: string) => void>();
  const launched: NewSessionRequest[] = [];
  const takenOver: string[] = [];
  const refused: string[] = [];
  const logs: string[] = [];
  /** Sessions whose agent was stopped, the room chat lines posted, and the requests to hand over that were shown. */
  const stopped: string[] = [];
  const chat: string[] = [];
  const asks: IncomingAsk[] = [];
  const received: ReceivedChanges[] = [];
  const base = tempDir(`${m.name}-home`);
  const claudeProjects = path.join(base, ".claude", "projects");
  const codexSessions = path.join(base, ".codex", "sessions");
  const svc = new TakeoverService({
    team: m.team,
    roomsDir: m.store.dir,
    host: {
      roomOf: (id) => (sessions.has(id) ? roomId : null),
      session: (id) => sessions.get(id),
      groupOf: () => "5110",
      onTurnEnd: (cb) => {
        turnEnds.add(cb);
        return () => turnEnds.delete(cb);
      },
      stop: (id) => {
        const s = sessions.get(id);
        if (!s || s.status === "dead") return false;
        stopped.push(id);
        sessions.set(id, { ...s, status: "dead" });
        return true;
      },
    },
    chat: (_roomId, text) => chat.push(text),
    onAsk: (a) => asks.push(a),
    onReceived: (r) => received.push(r),
    askMs: o.askMs,
    repos: () => o.repos,
    launch: async (req) => {
      launched.push(req);
      const info = session({ id: `new${launched.length}`, cwd: req.cwd!, repoPath: req.repoPath!, branch: req.branchName ?? null, agent: req.agent });
      sessions.set(info.id, info); // a room session of this member now
      return info;
    },
    now: o.now,
    log: (ctx, err) => {
      const s = `${ctx}: ${err instanceof Error ? err.message : String(err)}`;
      logs.push(s);
      return s;
    },
    onTakenOver: (id, by) => takenOver.push(`${id} by ${by}`),
    onRefused: (id, owner, title) => refused.push(`${id}: ${owner} refused “${title}”`),
    offlineSkewMs: o.skew,
    claudeProjects,
    codexSessions,
  });
  return { svc, sessions, launched, takenOver, refused, logs, stopped, chat, asks, received, claudeProjects, codexSessions, turnEnd: (id: string) => turnEnds.forEach((cb) => cb(id)) };
}

/** Ryan's Claude transcript for the session, in his fake ~/.claude. */
function claudeTranscript(projects: string, cwd: string, lines: object[]): string {
  const file = path.join(claudeProjectDir(cwd, projects), `${CONV}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return file;
}
const userLine = (cwd: string, text: string) => ({ type: "user", sessionId: CONV, cwd, timestamp: "2026-10-07T10:00:00Z", message: { role: "user", content: text } });
const agentLine = (cwd: string, text: string) => ({ type: "assistant", sessionId: CONV, cwd, timestamp: "2026-10-07T10:01:00Z", message: { role: "assistant", model: "claude-opus", content: [{ type: "text", text }] } });

/** Every file in a working tree that a snapshot carries (not .git, ignored or secret files), with its content. */
function files(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p);
      // .mockingbird is Mockingbird's own, git-excluded: a take-over saves the conversation there
      if (e.name === ".git" || e.name === ".mockingbird" || rel.endsWith(".log") || e.name === ".env" || e.name.endsWith(".pem")) continue;
      if (e.isDirectory()) walk(p);
      else out[rel] = fs.readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

/**
 * Ryan's session s1 in a room with Nick (and Sam). Most tests here are about
 * backups on origin, so the room's admin (Ryan) turns those on, unless
 * `backupsToOrigin: false` keeps the room as every room starts: peer to peer.
 */
async function setup(names = ["Ryan", "Nick"], o: { nickHasClone?: boolean; ryanNow?: () => number; nickNow?: () => number; backupsToOrigin?: boolean; consent?: boolean; skew?: number } = {}) {
  const r = repos();
  const { members, roomId, net } = await loopbackRoom(names, { dir: tempDir("team") });
  const [ryanM, nickM, samM] = members;
  if (o.backupsToOrigin !== false) {
    ryanM.team.publish(roomId, "room.settings", { backupsToOrigin: true });
    await until(() => members.every((m) => m.team.room(roomId)?.ext.settings?.backupsToOrigin === true), "everyone to hear the room backs up to origin");
  }
  const ryan = takeover(ryanM, roomId, { repos: [r.ryanClone], sessions: [session({ id: "s1", cwd: r.wt, repoPath: r.ryanClone })], now: o.ryanNow, skew: o.skew });
  const nick = takeover(nickM, roomId, { repos: o.nickHasClone === false ? [] : [r.nickClone], now: o.nickNow });
  const sam = samM ? takeover(samM, roomId, { repos: [] }) : null;
  // backing up to origin needs each member's own consent too: here, everyone allowed it
  if (o.consent !== false) for (const m of [ryan, nick, sam]) m?.svc.setBackupConsent(roomId, true);
  const transcript = claudeTranscript(ryan.claudeProjects, r.wt, [userLine(r.wt, "Add the donor entity"), agentLine(r.wt, "Added src/b.ts and started on a.ts")]);
  return { ...r, roomId, net, ryanM, nickM, samM, ryan, nick, sam, transcript };
}

const backupIn = (m: LoopbackMember, roomId: string, id = "s1") => m.team.room(roomId)?.ext.takeover?.sessions[id];
const refIn = (repo: string, ref: string) => {
  try {
    return sh(repo, "rev-parse", "--verify", "-q", ref);
  } catch {
    return null;
  }
};
const hasObject = (repo: string, obj: string) => {
  try {
    execFileSync("git", ["cat-file", "-e", obj], { cwd: repo, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const rejectPushes = (bare: string, on: boolean) => {
  const hook = path.join(bare, "hooks", "pre-receive");
  if (on) fs.writeFileSync(hook, "#!/bin/sh\necho 'backups are switched off here' >&2\nexit 1\n", { mode: 0o755 });
  else fs.rmSync(hook, { force: true });
};

describe("room session backups", () => {
  it("pushes each turn's snapshot to a hidden ref on origin — never a branch — and records it in the room", async () => {
    const t = await setup();
    const branchesBefore = sh(t.bare, "for-each-ref", "--format=%(refname)", "refs/heads");
    await t.ryan.svc.turnEnded("s1");
    const ref = roomBackupRef(t.roomId, "s1");
    const sha = refIn(t.bare, ref)!;
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sh(t.bare, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe(branchesBefore);
    // the snapshot is the worktree on top of the branch's commit, the unpushed commit included
    expect(sh(t.bare, "rev-parse", `${sha}^1`)).toBe(sh(t.wt, "rev-parse", "HEAD"));
    const tree = sh(t.bare, "ls-tree", "-r", "--name-only", sha).split("\n");
    expect(tree).toEqual(expect.arrayContaining(["src/a.ts", "src/b.ts", "src/staged.ts", "notes/todo.md"]));
    expect(tree).not.toContain("src/gone.ts");
    // ignored files and secrets never leave the Mac, even when the repository doesn't ignore them
    expect(tree).not.toContain("debug.log");
    expect(tree).not.toContain(".env");
    expect(tree).not.toContain("certs/dev.pem");
    expect(sh(t.bare, "show", `${sha}:src/a.ts`)).toBe("export const a = 42; // edited");
    // the room knows, on both laptops
    const b = backupIn(t.ryanM, t.roomId)!;
    expect(b).toMatchObject({ owner: t.ryanM.id, latest: { sha }, push: { ok: true, sha }, pushed: { sha }, takenOver: null });
    expect(b.session).toMatchObject({ title: "Donor entities", agent: "claude", branch: "feature-x", originUrl: t.bare, cwd: t.wt, conversationId: CONV });
    expect(b.transcriptBytes).toBe(fs.statSync(t.transcript).size);
    await until(() => backupIn(t.nickM, t.roomId)?.latest.sha === sha, "Nick to hear of the backup");
    // nothing on the branch, the index or the history moved
    expect(sh(t.wt, "status", "--porcelain")).toContain("A  src/staged.ts");
  });

  it("never takes a secret's staged or edited version: a committed one stays as HEAD has it, a staged-only one stays out", async () => {
    const t = await setup();
    write(t.wt, { "config/app.env": "PUBLIC_URL=https://example.test\n" });
    git(t.wt, "add", "config/app.env");
    git(t.wt, "commit", "-q", "-m", "app config", "--", "config/app.env");
    write(t.wt, { "config/app.env": "TOKEN=edited-in\n" });
    git(t.wt, "add", ".env", "config/app.env");
    const leaks = [sh(t.wt, "hash-object", ".env"), sh(t.wt, "hash-object", "config/app.env")];
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const sha = backupIn(t.ryanM, t.roomId)!.latest.sha;
    expect(refIn(t.bare, roomBackupRef(t.roomId, "s1"))).toBe(sha);
    expect(refIn(t.nickClone, roomBackupRef(t.roomId, "s1"))).toBe(sha);
    expect(sh(t.bare, "ls-tree", "-r", "--name-only", sha).split("\n")).not.toContain(".env");
    expect(sh(t.bare, "show", `${sha}:config/app.env`)).toBe("PUBLIC_URL=https://example.test");
    // neither the push to origin nor the bundle sent to Nick carries the staged contents
    for (const obj of leaks) {
      expect(hasObject(t.bare, obj), `origin has ${obj}`).toBe(false);
      expect(hasObject(t.nickClone, obj), `Nick's clone has ${obj}`).toBe(false);
    }
    // the index is still Ryan's to commit from
    expect(sh(t.wt, "status", "--porcelain").split("\n")).toEqual(expect.arrayContaining(["A  .env", "M  config/app.env"]));
  });

  it("keeps the last snapshot when a turn changed nothing, and pushes again with a lease when files change", async () => {
    const t = await setup();
    await t.ryan.svc.turnEnded("s1");
    const first = backupIn(t.ryanM, t.roomId)!.latest.sha;
    const events = t.ryanM.team.room(t.roomId)!.events;
    await t.ryan.svc.turnEnded("s1");
    expect(backupIn(t.ryanM, t.roomId)!.latest.sha).toBe(first);
    expect(t.ryanM.team.room(t.roomId)!.events).toBe(events); // nothing new to record
    write(t.wt, { "src/a.ts": "export const a = 43;\n" });
    t.ryan.turnEnd("s1"); // through the host's turn-end seam
    await t.ryan.svc.settled();
    const second = backupIn(t.ryanM, t.roomId)!.latest.sha;
    expect(second).not.toBe(first);
    expect(refIn(t.bare, roomBackupRef(t.roomId, "s1"))).toBe(second);
  });

  it("coalesces turns that end while a backup runs into one more", async () => {
    const t = await setup();
    const before = t.ryanM.team.room(t.roomId)!.events;
    const runs = [t.ryan.svc.turnEnded("s1"), t.ryan.svc.turnEnded("s1"), t.ryan.svc.turnEnded("s1")];
    await Promise.all(runs);
    const backups = t.ryanM.team.room(t.roomId)!.events - before;
    expect(backupIn(t.ryanM, t.roomId)!.push.ok).toBe(true);
    // two backups at most: the first, and one for everything that ended while it ran
    expect(backups).toBeLessThanOrEqual(2);
  });

  it("records a failed push in the room and shows it, without stopping the copy to teammates", async () => {
    const t = await setup();
    rejectPushes(t.bare, true);
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const b = backupIn(t.ryanM, t.roomId)!;
    expect(b.push.ok).toBe(false);
    expect(b.push.ok === false && b.push.error).toMatch(/backups are switched off here|pre-receive hook declined/);
    expect(b.pushed).toBeNull();
    expect(t.ryan.logs.some((l) => /pushing the backup of session s1/.test(l))).toBe(true);
    // Ryan sees it on his own session; Nick, who got the snapshot directly, sees it's safe on his Mac
    const mine = t.ryan.svc.view().sessions.find((s) => s.sessionId === "s1")!;
    expect(backupFreshness(mine).text).toMatch(/^backup failed: /);
    await until(() => !!t.nick.svc.view().sessions.find((s) => s.sessionId === "s1")?.peerCopy, "Nick's copy");
    const theirs = t.nick.svc.view().sessions.find((s) => s.sessionId === "s1")!;
    expect(backupFreshness(theirs)).toMatchObject({ tone: "ok", text: expect.stringMatching(/^latest copied here .* · backup failed: /) });
  });

  it("says the latest is only on the owner's laptop when neither origin nor this Mac has it", async () => {
    const t = await setup(["Ryan", "Nick", "Sam"]);
    t.net.partition(t.ryanM.id, t.nickM.id); // Nick hears of it through Sam, but gets no copy
    await until(() => !t.ryanM.team.presence(t.roomId).includes(t.nickM.id), "the partition");
    rejectPushes(t.bare, true);
    await t.ryan.svc.turnEnded("s1");
    await until(() => !!backupIn(t.nickM, t.roomId), "Nick to hear of the backup through Sam");
    const v = t.nick.svc.view().sessions.find((s) => s.sessionId === "s1")!;
    expect(v.peerCopy).toBeNull();
    expect(backupFreshness(v)).toMatchObject({ tone: "warn", text: expect.stringMatching(/^latest only on Ryan's laptop · backup failed: /) });
  });

  it("reports a session that can't be backed up at all", async () => {
    const t = await setup();
    git(t.ryanClone, "remote", "remove", "origin");
    await t.ryan.svc.turnEnded("s1");
    expect(t.ryan.svc.view().unbacked).toEqual([{ sessionId: "s1", roomId: t.roomId, title: "Donor entities", problem: expect.stringMatching(/no origin remote/) }]);
  });
});

describe("the peer-to-peer mirror", () => {
  it("copies each turn's snapshot into the teammate's clone, found by origin URL, as a local ref", async () => {
    const t = await setup();
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const ref = roomBackupRef(t.roomId, "s1");
    const sha = backupIn(t.ryanM, t.roomId)!.latest.sha;
    expect(refIn(t.nickClone, ref)).toBe(sha);
    // with Ryan's unpushed commit, and only under the hidden ref
    expect(sh(t.nickClone, "show", `${sha}:src/b.ts`)).toBe("export const b = 2;");
    expect(sh(t.nickClone, "branch", "--list")).toBe("* main");
    // the next turn sends only what's new
    write(t.wt, { "src/c.ts": "c\n" });
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const next = backupIn(t.ryanM, t.roomId)!.latest.sha;
    expect(refIn(t.nickClone, ref)).toBe(next);
    expect(t.ryan.logs.filter((l) => /failed/.test(l))).toEqual([]);
  });

  it("brings a teammate who connects later up to date", async () => {
    const t = await setup();
    t.net.setOnline(t.nickM.id, false);
    await until(() => t.ryanM.team.presence(t.roomId).length === 0, "Nick to drop");
    await t.ryan.svc.turnEnded("s1");
    const sha = backupIn(t.ryanM, t.roomId)!.latest.sha;
    expect(refIn(t.nickClone, roomBackupRef(t.roomId, "s1"))).toBeNull();
    t.net.setOnline(t.nickM.id, true);
    await until(() => refIn(t.nickClone, roomBackupRef(t.roomId, "s1")) === sha, "Nick's copy after reconnecting");
    await t.ryan.svc.settled();
    const copy = path.join(t.nickM.store.dir, t.roomId, "transcripts", "s1", `${CONV}.jsonl`);
    expect(fs.readFileSync(copy, "utf8")).toBe(fs.readFileSync(t.transcript, "utf8"));
  });

  it("skips the snapshot for a teammate without a clone of the repository, says so once, and still sends the conversation", async () => {
    const t = await setup(["Ryan", "Nick"], { nickHasClone: false });
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    write(t.wt, { "src/c.ts": "c\n" });
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    expect(refIn(t.nickClone, roomBackupRef(t.roomId, "s1"))).toBeNull();
    expect(t.ryan.logs.filter((l) => /Nick has no clone of/.test(l))).toHaveLength(1);
    expect(t.ryan.svc.view().sessions[0].problem).toBeNull();
    const copy = path.join(t.nickM.store.dir, t.roomId, "transcripts", "s1", `${CONV}.jsonl`);
    expect(fs.readFileSync(copy, "utf8")).toBe(fs.readFileSync(t.transcript, "utf8"));
  });

  it("refuses snapshots and conversations for a session from anyone but its owner", async () => {
    const t = await setup(["Ryan", "Nick", "Sam"]);
    await t.ryan.svc.turnEnded("s1");
    await until(() => !!backupIn(t.samM!, t.roomId), "Sam to hear of the backup");
    await expect(
      t.samM!.team.request(t.nickM.id, "takeover.transcript", { roomId: t.roomId, sessionId: "s1", agent: "claude", conversationId: CONV, file: `${CONV}.jsonl`, ownerCwd: "/x", offset: 0, data: "", total: 0 }, { roomId: t.roomId })
    ).rejects.toThrow(/isn't Sam's/);
  });
});

describe("the conversation's copy", () => {
  it("arrives as appended deltas, is resent from where a copy stops after a gap, and starts over when the file was rewritten", async () => {
    const t = await setup();
    const copy = path.join(t.nickM.store.dir, t.roomId, "transcripts", "s1", `${CONV}.jsonl`);
    const same = () => fs.existsSync(copy) && fs.readFileSync(copy, "utf8") === fs.readFileSync(t.transcript, "utf8");
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    expect(same()).toBe(true);
    // the next turn appends
    claudeTranscript(t.ryan.claudeProjects, t.wt, [userLine(t.wt, "Now the tests"), agentLine(t.wt, "Wrote three tests")]);
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    expect(same()).toBe(true);
    // a gap: Nick's copy lost its end; the next delta starts where it stops instead
    fs.truncateSync(copy, 40);
    claudeTranscript(t.ryan.claudeProjects, t.wt, [agentLine(t.wt, "All green")]);
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    expect(same()).toBe(true);
    // rewritten shorter: Nick holds more than there is, so his copy starts over
    fs.writeFileSync(t.transcript, `${JSON.stringify(userLine(t.wt, "fresh"))}\n`);
    write(t.wt, { "src/d.ts": "d\n" });
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    expect(same()).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(copy), "meta.json"), "utf8"));
    expect(meta).toMatchObject({ agent: "claude", conversationId: CONV, file: `${CONV}.jsonl`, ownerCwd: realpathOr(t.wt), from: t.ryanM.id });
  });

  it("sends a long conversation in chunks", async () => {
    const t = await setup();
    const big = "x".repeat(TRANSCRIPT_CHUNK + 1000);
    claudeTranscript(t.ryan.claudeProjects, t.wt, [agentLine(t.wt, big)]);
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const copy = path.join(t.nickM.store.dir, t.roomId, "transcripts", "s1", `${CONV}.jsonl`);
    expect(fs.statSync(copy).size).toBe(fs.statSync(t.transcript).size);
  }, 30_000);

  it("refuses what would take a copy past this Mac's limit, telling the sender and showing it under the room", async () => {
    const t = await setup();
    const was = ROOM_LIMITS.maxTranscriptBytes;
    ROOM_LIMITS.maxTranscriptBytes = 100;
    try {
      const send = (offset: number, bytes: number) =>
        t.ryanM.team.request(t.nickM.id, "takeover.transcript", { roomId: t.roomId, sessionId: "s1", agent: "claude", conversationId: CONV, file: `${CONV}.jsonl`, ownerCwd: "/x", offset, data: Buffer.alloc(bytes, "x").toString("base64"), total: 500 }, { roomId: t.roomId });
      await expect(send(0, 80)).resolves.toEqual({ have: 80 });
      await expect(send(80, 40)).rejects.toThrow(/refused: a conversation copy over 0.1 KB \(this Mac's limit\)/);
      const copy = path.join(t.nickM.store.dir, t.roomId, "transcripts", "s1", `${CONV}.jsonl`);
      expect(fs.statSync(copy).size).toBe(80);
      expect(t.nickM.team.status().rooms[0].warnings).toEqual([expect.objectContaining({ key: `transcript:${t.ryanM.id}`, text: "Ryan's Mockingbird sent a conversation copy over 0.1 KB; it was refused" })]);
    } finally {
      ROOM_LIMITS.maxTranscriptBytes = was;
    }
  });

  it("never puts the conversation in git", async () => {
    const t = await setup();
    await t.ryan.svc.turnEnded("s1");
    const sha = backupIn(t.ryanM, t.roomId)!.latest.sha;
    const all = sh(t.bare, "rev-list", "--objects", "--all");
    expect(all).not.toContain(".jsonl");
    expect(sh(t.bare, "ls-tree", "-r", "--name-only", sha)).not.toContain(CONV);
  });
});

describe("taking over", () => {
  it("continues the session on the teammate's laptop with the owner offline: the work exactly, a new conversation from a brief", async () => {
    const t = await setup();
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const ryanFiles = files(t.wt);
    const ryanHead = sh(t.wt, "rev-parse", "HEAD");
    t.net.setOnline(t.ryanM.id, false); // Ryan's laptop is shut
    await until(() => t.nickM.team.presence(t.roomId).length === 0, "Ryan to drop");

    const plan = await t.nick.svc.plan(t.roomId, "s1");
    expect(plan).toMatchObject({ clone: t.nickClone, ownerName: "Ryan", ownerOnline: false, branch: "feature-x", latestMissing: false, originProblem: null, conversation: { kind: "full" } });
    expect(plan.snapshot!.sha).toBe(backupIn(t.nickM, t.roomId)!.latest.sha);

    const r = await t.nick.svc.takeOver(t.roomId, "s1");
    expect(r).toMatchObject({ sessionId: "new1", branch: "feature-x", renamedFrom: null, conversation: "full", snapshot: { sha: plan.snapshot!.sha } });
    // the worktree: Ryan's branch and commit, with his uncommitted work on top, untracked files included
    expect(sh(r.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature-x");
    expect(sh(r.cwd, "rev-parse", "HEAD")).toBe(ryanHead);
    expect(files(r.cwd)).toEqual(ryanFiles);
    expect(fs.existsSync(path.join(r.cwd, "src/gone.ts"))).toBe(false);
    expect(fs.existsSync(path.join(r.cwd, ".env"))).toBe(false); // teammates swap secrets by hand
    expect(sh(r.cwd, "status", "--porcelain")).toMatch(/\?\? notes\//);

    // Ryan's conversation isn't resumed on Nick's account: nothing placed where Claude would resume it
    expect(fs.existsSync(path.join(claudeProjectDir(realpathOr(r.cwd), t.nick.claudeProjects), `${CONV}.jsonl`))).toBe(false);
    // it's saved whole in the worktree, read-only and owner-only, where git never sees it
    const saved = path.join(r.cwd, ".mockingbird", "takeover", `${CONV}.jsonl`);
    expect(fs.readFileSync(saved, "utf8")).toBe(fs.readFileSync(t.transcript, "utf8"));
    expect(fs.statSync(saved).mode & 0o777).toBe(0o400);
    expect(fs.statSync(path.dirname(saved)).mode & 0o777).toBe(0o700);
    expect(sh(r.cwd, "status", "--porcelain")).not.toContain(".mockingbird");
    expect(sh(r.cwd, "check-ignore", ".mockingbird/takeover")).toBe(".mockingbird/takeover");

    // the session: a new conversation under Nick's account, in the worktree, in the room's group, its first input the brief
    const { initialPrompt, ...req } = t.nick.launched[0];
    expect(t.nick.launched).toHaveLength(1);
    expect(req).toEqual({ repoPath: t.nickClone, cwd: r.cwd, branchName: "feature-x", useWorktree: false, agent: "claude", title: "Donor entities", taskGroup: "5110" });
    expect(agentFor("claude").launchArgs(t.nick.launched[0], {})).not.toContain("--resume");
    expect(initialPrompt).toMatch(/^You're continuing "Donor entities", a Claude session Ryan was running on their laptop\. Nick took it over on this one: you're a new session on Nick's account/);
    expect(initialPrompt).toContain("Branch: feature-x");
    expect(initialPrompt).toContain(r.cwd);
    expect(initialPrompt).toContain("USER: Add the donor entity");
    expect(initialPrompt).toContain("AGENT: Added src/b.ts and started on a.ts");
    // the changed files against the base: the branch's commit and the work on top, new files too
    expect(initialPrompt).toMatch(/## Changed files \(against origin\/main\)/);
    for (const f of ["src/a.ts", "src/b.ts", "src/gone.ts", "src/staged.ts (new, untracked)", "notes/todo.md (new, untracked)"]) expect(initialPrompt).toContain(f);
    expect(initialPrompt).toContain(`${saved}`);
    expect(initialPrompt).toMatch(/read it only when you need detail this brief leaves out/);

    // the room records it; Ryan sees it when he's back, and his copy stops backing up
    expect(backupIn(t.nickM, t.roomId)!.takenOver).toMatchObject({ by: t.nickM.id, newSessionId: "new1", conversation: "full", snapshot: { sha: plan.snapshot!.sha } });
    t.net.setOnline(t.ryanM.id, true);
    await until(() => !!backupIn(t.ryanM, t.roomId)?.takenOver, "Ryan to hear of the take-over");
    await until(() => t.ryan.takenOver.length === 1, "Ryan to be told");
    expect(t.ryan.takenOver).toEqual(["s1 by Nick"]);
    expect(t.ryan.stopped).toEqual(["s1"]); // his copy's agent stops as soon as he hears
    const mine = t.ryan.svc.view().sessions.find((s) => s.sessionId === "s1")!;
    expect(backupFreshness(mine).text).toMatch(/^continued on Nick's laptop/);
    const ref = refIn(t.bare, roomBackupRef(t.roomId, "s1"));
    const events = t.ryanM.team.room(t.roomId)!.events;
    write(t.wt, { "src/a.ts": "Ryan keeps typing\n" });
    await t.ryan.svc.turnEnded("s1");
    expect(t.ryanM.team.room(t.roomId)!.events).toBe(events);
    expect(refIn(t.bare, roomBackupRef(t.roomId, "s1"))).toBe(ref);
    await expect(t.nick.svc.takeOver(t.roomId, "s1")).rejects.toThrow(/already took that session over/);
  });

  it("uses the newest snapshot the owner recorded: the peer copy when origin's push failed, origin's when it's newer", async () => {
    const t = await setup(["Ryan", "Nick", "Sam"]);
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    // a turn whose push fails but whose snapshot reached Nick
    rejectPushes(t.bare, true);
    write(t.wt, { "src/a.ts": "turn 2\n" });
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    let plan = await t.nick.svc.plan(t.roomId, "s1");
    expect(plan.snapshot).toMatchObject({ source: "peer", sha: backupIn(t.ryanM, t.roomId)!.latest.sha });
    expect(plan.other).toMatchObject({ source: "origin" });
    expect(plan.other!.takenAt).toBeLessThan(plan.snapshot!.takenAt);
    // then a turn pushed to origin whose copy never reached Nick: he hears of it through Sam
    rejectPushes(t.bare, false);
    t.net.partition(t.ryanM.id, t.nickM.id);
    await until(() => !t.ryanM.team.presence(t.roomId).includes(t.nickM.id), "the partition");
    write(t.wt, { "src/a.ts": "turn 3\n" });
    await t.ryan.svc.turnEnded("s1");
    const third = backupIn(t.ryanM, t.roomId)!.latest.sha;
    await until(() => backupIn(t.nickM, t.roomId)?.latest.sha === third, "Nick to hear of turn 3 through Sam");
    plan = await t.nick.svc.plan(t.roomId, "s1");
    expect(plan.snapshot).toMatchObject({ source: "origin", sha: third });
    expect(plan.other).toMatchObject({ source: "peer" });
    expect(plan.latestMissing).toBe(false);
    const r = await t.nick.svc.takeOver(t.roomId, "s1");
    expect(fs.readFileSync(path.join(r.cwd, "src/a.ts"), "utf8")).toBe("turn 3\n");
  });

  it("briefs from what arrived when the conversation's end never did, and says so", async () => {
    const t = await setup();
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    // the last turns didn't reach Nick: his copy is short of what the room says the conversation holds
    const copy = path.join(t.nickM.store.dir, t.roomId, "transcripts", "s1", `${CONV}.jsonl`);
    const firstLine = fs.readFileSync(copy, "utf8").split("\n")[0] + "\n";
    fs.writeFileSync(copy, firstLine);
    t.net.setOnline(t.ryanM.id, false);
    await until(() => t.nickM.team.presence(t.roomId).length === 0, "Ryan to drop");
    const plan = await t.nick.svc.plan(t.roomId, "s1");
    expect(plan.conversation).toEqual({ kind: "partial", have: Buffer.byteLength(firstLine), of: fs.statSync(t.transcript).size });
    const r = await t.nick.svc.takeOver(t.roomId, "s1");
    expect(r.conversation).toBe("digest");
    const req = t.nick.launched[0];
    expect(req.resumeSessionId).toBeUndefined();
    expect(req.initialPrompt).toMatch(/Only part of Ryan's conversation reached this laptop: its most recent turns are missing/);
    expect(req.initialPrompt).toContain("USER: Add the donor entity");
    expect(req.initialPrompt).not.toContain("AGENT: Added src/b.ts");
    expect(req.initialPrompt).toMatch(/and that you're working from a partial conversation/);
    expect(req.initialPrompt).toContain("Branch: feature-x");
    expect(req.initialPrompt).toMatch(/What arrived of Ryan's conversation .* is in /);
    expect(fs.readFileSync(path.join(r.cwd, ".mockingbird", "takeover", `${CONV}.jsonl`), "utf8")).toBe(firstLine);
    expect(fs.existsSync(path.join(claudeProjectDir(realpathOr(r.cwd), t.nick.claudeProjects), `${CONV}.jsonl`))).toBe(false);
    expect(backupIn(t.nickM, t.roomId)!.takenOver).toMatchObject({ conversation: "digest" });
  });

  it("starts from the files alone when no conversation arrived, from origin's backup", async () => {
    const t = await setup(["Ryan", "Nick", "Sam"]);
    t.net.partition(t.ryanM.id, t.nickM.id);
    await until(() => !t.ryanM.team.presence(t.roomId).includes(t.nickM.id), "the partition");
    await t.ryan.svc.turnEnded("s1");
    await until(() => !!backupIn(t.nickM, t.roomId), "Nick to hear of it through Sam");
    const plan = await t.nick.svc.plan(t.roomId, "s1");
    expect(plan).toMatchObject({ snapshot: { source: "origin" }, other: null, conversation: { kind: "none" } });
    const r = await t.nick.svc.takeOver(t.roomId, "s1");
    expect(r.conversation).toBe("none");
    expect(t.nick.launched[0].initialPrompt).toMatch(/Ryan's conversation didn't reach this laptop, so there's nothing of it below: only the files/);
    expect(t.nick.launched[0].initialPrompt).toMatch(/and that you're working from the files alone/);
    expect(t.nick.launched[0].resumeSessionId).toBeUndefined();
    expect(fs.existsSync(path.join(r.cwd, ".mockingbird", "takeover"))).toBe(false);
    expect(files(r.cwd)).toEqual(files(t.wt));
  });

  it("takes over a Codex session as a new Codex conversation: the brief its prompt, the rollout saved in the worktree", async () => {
    const t = await setup();
    const name = `rollout-2026-10-07T09-30-00-${CODEX_CONV}.jsonl`;
    const rollout = codexRolloutPath(name, t.ryan.codexSessions);
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(
      rollout,
      [
        { type: "session_meta", payload: { id: CODEX_CONV, cwd: t.wt, source: "cli" } },
        { type: "turn_context", payload: { cwd: t.wt, model: "gpt-5" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add the donor entity" }] } },
      ]
        .map((l) => `${JSON.stringify(l)}\n`)
        .join("")
    );
    t.ryan.sessions.set("s1", { ...t.ryan.sessions.get("s1")!, agent: "codex", conversation: { agent: "codex", id: CODEX_CONV } });
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    t.net.setOnline(t.ryanM.id, false); // away: taken over without asking
    await until(() => t.nickM.team.presence(t.roomId).length === 0, "Ryan to drop");
    const r = await t.nick.svc.takeOver(t.roomId, "s1");
    expect(r.conversation).toBe("full");
    expect(fs.existsSync(codexRolloutPath(name, t.nick.codexSessions))).toBe(false);
    expect(fs.readFileSync(path.join(r.cwd, ".mockingbird", "takeover", name), "utf8")).toBe(fs.readFileSync(rollout, "utf8"));
    const req = t.nick.launched[0];
    expect(req).toMatchObject({ agent: "codex" });
    expect(req.resumeSessionId).toBeUndefined();
    expect(req.initialPrompt).toMatch(/^You're continuing "Donor entities", a Codex session Ryan was running/);
    expect(req.initialPrompt).toContain("USER: Add the donor entity");
    const args = agentFor("codex").launchArgs(req, {});
    expect(args).not.toContain("resume");
    expect(args.slice(-2)).toEqual(["--", req.initialPrompt]);
  });

  it("asks for the clone when none among the repositories matches origin, and checks the one chosen", async () => {
    const t = await setup(["Ryan", "Nick"], { nickHasClone: false });
    await t.ryan.svc.turnEnded("s1");
    await until(() => !!backupIn(t.nickM, t.roomId), "Nick to hear of the backup");
    expect(await t.nick.svc.plan(t.roomId, "s1")).toMatchObject({ clone: null, snapshot: null, originUrl: t.bare });
    await expect(t.nick.svc.takeOver(t.roomId, "s1")).rejects.toThrow(/No clone of .* was found among your repositories — choose yours/);
    const other = makeRepo({ "x.txt": "x\n" }, "other");
    await expect(t.nick.svc.plan(t.roomId, "s1", other)).rejects.toThrow(/origin is not set, not /);
    const plan = await t.nick.svc.plan(t.roomId, "s1", t.nickClone);
    expect(plan).toMatchObject({ clone: sh(t.nickClone, "rev-parse", "--show-toplevel"), snapshot: { source: "origin" } });
    t.net.setOnline(t.ryanM.id, false); // away: taken over without asking
    await until(() => t.nickM.team.presence(t.roomId).length === 0, "Ryan to drop");
    const r = await t.nick.svc.takeOver(t.roomId, "s1", t.nickClone);
    expect(files(r.cwd)).toEqual(files(t.wt));
  });
});

describe("cleaning up backups", () => {
  const nickCopy = (t: Awaited<ReturnType<typeof setup>>, id = "s1") => ({
    ref: refIn(t.nickClone, roomBackupRef(t.roomId, id)),
    transcript: fs.existsSync(path.join(t.nickM.store.dir, t.roomId, "transcripts", id)),
  });

  it("deletes a forgotten session's backup on origin and every member's copy", async () => {
    const t = await setup();
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const ref = roomBackupRef(t.roomId, "s1");
    expect([refIn(t.bare, ref), refIn(t.ryanClone, ref)].every(Boolean)).toBe(true);
    expect(nickCopy(t)).toEqual({ ref: expect.any(String), transcript: true });
    await t.ryan.svc.sessionForgotten("s1");
    expect(refIn(t.bare, ref)).toBeNull();
    expect(refIn(t.ryanClone, ref)).toBeNull();
    expect(backupIn(t.ryanM, t.roomId)!.dropped).toMatchObject({ by: t.ryanM.id, reason: "closed" });
    await until(() => !nickCopy(t).ref && !nickCopy(t).transcript, "Nick's copies to go");
    // nothing brings it back
    await t.ryan.svc.turnEnded("s1");
    expect(refIn(t.bare, ref)).toBeNull();
    expect(t.ryan.svc.view().cleanup).toEqual([]);
  });

  it("keeps the backup and shows why when deleting it fails, and retries on the next prune", async () => {
    const t = await setup();
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const ref = roomBackupRef(t.roomId, "s1");
    rejectPushes(t.bare, true);
    await t.ryan.svc.sessionForgotten("s1");
    expect(refIn(t.bare, ref)).not.toBeNull();
    expect(backupIn(t.ryanM, t.roomId)!.dropped).toBeNull();
    expect(t.ryan.svc.view().cleanup).toEqual([{ roomId: t.roomId, sessionId: "s1", title: "Donor entities", problem: expect.stringMatching(/backups are switched off here|declined/) }]);
    expect(t.ryan.logs.some((l) => /deleting the backup of session s1/.test(l))).toBe(true);
    expect(nickCopy(t).ref).not.toBeNull(); // members keep theirs until origin's is gone
    rejectPushes(t.bare, false);
    await t.ryan.svc.prune();
    expect(refIn(t.bare, ref)).toBeNull();
    expect(t.ryan.svc.view().cleanup).toEqual([]);
    expect(backupIn(t.ryanM, t.roomId)!.dropped).toMatchObject({ reason: "closed" });
  });

  it("prunes a backup that saw no turn for 14 days, and keeps a recent one", async () => {
    let clock = Date.parse("2026-10-07T09:00:00Z");
    const t = await setup(["Ryan", "Nick"], { ryanNow: () => clock });
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const ref = roomBackupRef(t.roomId, "s1");
    clock += 13 * 86_400_000;
    await t.ryan.svc.prune();
    expect(refIn(t.bare, ref)).not.toBeNull();
    clock += 2 * 86_400_000;
    await t.ryan.svc.prune();
    expect(refIn(t.bare, ref)).toBeNull();
    expect(refIn(t.ryanClone, ref)).toBeNull(); // the owner's own copy goes with the drop, before any next turn
    expect(backupIn(t.ryanM, t.roomId)!.dropped).toMatchObject({ reason: "stale" });
    await until(() => !nickCopy(t).ref, "Nick's copy to go");
    // a turn after all brings the session's backup back
    write(t.wt, { "src/a.ts": "back at it\n" });
    await t.ryan.svc.turnEnded("s1");
    expect(refIn(t.bare, ref)).not.toBeNull();
    expect(backupIn(t.ryanM, t.roomId)!.dropped).toBeNull();
  });

  it("prunes a backup whose work is all merged into the base branch — not one with uncommitted work", async () => {
    const t = await setup();
    await t.ryan.svc.turnEnded("s1");
    const ref = roomBackupRef(t.roomId, "s1");
    // the branch's commit merged, but edits still uncommitted: the backup is the only copy of them
    git(t.wt, "push", "-q", "origin", "HEAD:main");
    git(t.ryanClone, "fetch", "-q", "origin");
    await t.ryan.svc.prune();
    expect(refIn(t.bare, ref)).not.toBeNull();
    // everything committed and merged
    fs.rmSync(path.join(t.wt, ".env"));
    fs.rmSync(path.join(t.wt, "certs"), { recursive: true });
    git(t.wt, "add", "-A");
    git(t.wt, "commit", "-q", "-m", "the rest");
    git(t.wt, "push", "-q", "origin", "HEAD:main");
    git(t.ryanClone, "fetch", "-q", "origin");
    await t.ryan.svc.turnEnded("s1");
    expect(refIn(t.bare, ref)).not.toBeNull();
    await t.ryan.svc.prune();
    expect(refIn(t.bare, ref)).toBeNull();
    expect(backupIn(t.ryanM, t.roomId)!.dropped).toMatchObject({ reason: "merged" });
  });

  it("deletes a taken-over session's old backup once the taker's first backup lands — and only the taker does", async () => {
    const t = await setup();
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const old = roomBackupRef(t.roomId, "s1");
    t.net.setOnline(t.ryanM.id, false);
    await until(() => t.nickM.team.presence(t.roomId).length === 0, "Ryan to drop");
    const r = await t.nick.svc.takeOver(t.roomId, "s1");
    expect(refIn(t.bare, old)).not.toBeNull();
    // Ryan, back, isn't the owner any more: forgetting his copy leaves origin's backup alone,
    // and a deletion he announces doesn't count
    t.net.setOnline(t.ryanM.id, true);
    await until(() => !!backupIn(t.ryanM, t.roomId)?.takenOver, "Ryan to hear of the take-over");
    await t.ryan.svc.sessionForgotten("s1");
    expect(refIn(t.bare, old)).not.toBeNull();
    expect(refIn(t.ryanClone, old)).toBeNull();
    t.ryanM.team.publish(t.roomId, "session.backupDropped", { sessionId: "s1", reason: "closed" });
    await until(() => (t.nickM.team.room(t.roomId)?.events ?? 0) === t.ryanM.team.room(t.roomId)!.events, "Nick to get the event");
    expect(backupIn(t.nickM, t.roomId)!.dropped).toBeNull();
    expect(nickCopy(t).ref).not.toBeNull();
    // Nick's first backup of his copy
    await t.nick.svc.turnEnded(r.sessionId);
    expect(refIn(t.bare, roomBackupRef(t.roomId, r.sessionId))).not.toBeNull();
    expect(refIn(t.bare, old)).toBeNull();
    expect(backupIn(t.nickM, t.roomId)!.dropped).toMatchObject({ by: t.nickM.id, reason: "taken-over" });
    await until(() => !nickCopy(t).ref && !nickCopy(t).transcript, "Nick's copies of the old session to go");
    expect(refIn(t.nickClone, roomBackupRef(t.roomId, "s1", "refs/mockingbird/rooms-origin"))).toBeNull();
  });
});

describe("leaving the room", () => {
  it("the one who leaves deletes their backups on origin and every hidden ref of the room here; teammates forget the copies they had", async () => {
    const t = await setup();
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const ref = roomBackupRef(t.roomId, "s1");
    const nickTranscript = path.join(t.nickM.store.dir, t.roomId, "transcripts", "s1");
    expect([refIn(t.bare, ref), refIn(t.ryanClone, ref), refIn(t.nickClone, ref)].every(Boolean)).toBe(true);
    expect(fs.existsSync(nickTranscript)).toBe(true);
    // what else of the room Ryan's clone holds (a copy left behind, one sent), and another room's ref, which stays
    const head = sh(t.ryanClone, "rev-parse", "HEAD");
    const leftRef = roomBackupRef(t.roomId, "s0", "refs/mockingbird/rooms-left");
    const sentRef = roomBackupRef(t.roomId, "s0", "refs/mockingbird/rooms-sent");
    const otherRoom = roomBackupRef("O".repeat(22), "s7");
    for (const r of [leftRef, sentRef, otherRoom]) sh(t.ryanClone, "update-ref", r, head);

    t.ryanM.team.handOver(t.roomId, t.nickM.id); // the owner hands over before leaving
    const out = await t.ryanM.team.leave(t.roomId);
    expect(await t.ryan.svc.roomLeft(out.room)).toEqual([]);
    expect(refIn(t.bare, ref)).toBeNull();
    for (const r of [ref, leftRef, sentRef]) expect(refIn(t.ryanClone, r)).toBeNull();
    expect(refIn(t.ryanClone, otherRoom)).toBe(head);
    // Nick: Ryan's session is gone from the room, and so are the copies of it on his Mac
    await until(() => !refIn(t.nickClone, ref) && !fs.existsSync(nickTranscript), "Nick's copies to go");
    expect(backupIn(t.nickM, t.roomId)!.dropped).toMatchObject({ by: t.ryanM.id, reason: "left-room" });
    expect(t.nick.svc.view().sessions).toEqual([]);
    await expect(t.nick.svc.plan(t.roomId, "s1")).rejects.toThrow(/Ryan left the room: their sessions can't be taken over/);
  });

  it("says which backup couldn't be deleted from origin, instead of hiding it", async () => {
    const t = await setup();
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    rejectPushes(t.bare, true);
    t.ryanM.team.handOver(t.roomId, t.nickM.id); // the owner hands over before leaving
    const out = await t.ryanM.team.leave(t.roomId);
    const problems = await t.ryan.svc.roomLeft(out.room);
    expect(problems).toEqual([expect.stringMatching(/^The backup of “Donor entities” couldn't be deleted from origin \(refs\/mockingbird\/rooms\/.*\/s1\): .*switched off/)]);
    expect(refIn(t.bare, roomBackupRef(t.roomId, "s1"))).not.toBeNull();
    expect(refIn(t.ryanClone, roomBackupRef(t.roomId, "s1"))).toBeNull(); // this Mac's own copy still goes
  });
});

describe("the conversation saved at a take-over", () => {
  /** Nick takes Ryan's s1 over with Ryan offline: Ryan's whole conversation is saved in Nick's new worktree. */
  async function takenOver(o: { nickNow?: () => number } = {}) {
    const t = await setup(["Ryan", "Nick"], o);
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    t.net.setOnline(t.ryanM.id, false);
    await until(() => t.nickM.team.presence(t.roomId).length === 0, "Ryan to drop");
    const r = await t.nick.svc.takeOver(t.roomId, "s1");
    const saved = path.join(r.cwd, ".mockingbird", "takeover");
    expect(fs.existsSync(path.join(saved, `${CONV}.jsonl`))).toBe(true);
    return { ...t, r, saved };
  }
  const logged = (spy: { mock: { calls: unknown[][] } }, re: RegExp) => spy.mock.calls.some((c) => re.test(String(c[0])));

  it("stays while the continued session runs — past the taker's first backup — and goes once it has no turn for 14 days, logged", async () => {
    let clock = Date.parse("2026-10-07T09:00:00Z");
    const t = await takenOver({ nickNow: () => clock });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // Nick's first backup of his copy deletes Ryan's old backup: the conversation stays, his agent may still need it
      await t.nick.svc.turnEnded(t.r.sessionId);
      await until(() => backupIn(t.nickM, t.roomId)?.dropped?.reason === "taken-over", "the old backup to go");
      await t.nick.svc.settled();
      clock += 10 * 86_400_000;
      await t.nick.svc.turnEnded(t.r.sessionId);
      clock += 13 * 86_400_000;
      await t.nick.svc.prune();
      expect(fs.existsSync(t.saved)).toBe(true);
      clock += 2 * 86_400_000;
      await t.nick.svc.prune();
      expect(fs.existsSync(t.saved)).toBe(false);
      expect(fs.existsSync(path.join(t.r.cwd, "src/a.ts"))).toBe(true); // the worktree itself stays
      expect(logged(log, /deleted the conversation saved at a take-over in .*takeover: “Donor entities” had no turn for 14 days/)).toBe(true);
    } finally {
      log.mockRestore();
    }
  }, 30_000);

  it("goes once the continued session is closed: forgotten at once, or found closed by the prune", async () => {
    const t = await takenOver();
    await t.nick.svc.sessionForgotten(t.r.sessionId);
    expect(fs.existsSync(t.saved)).toBe(false);
    expect(t.nick.svc.view().cleanup).toEqual([]);

    const u = await takenOver();
    u.nick.sessions.delete(u.r.sessionId); // closed without being kept to resume
    await u.nick.svc.prune();
    expect(fs.existsSync(u.saved)).toBe(false);
  }, 40_000);

  it("goes when its owner drops the continued session's backup", async () => {
    const t = await takenOver();
    await t.nick.svc.turnEnded(t.r.sessionId);
    t.nickM.team.publish(t.roomId, "session.backupDropped", { sessionId: t.r.sessionId, reason: "merged" });
    await until(() => !fs.existsSync(t.saved), "the saved conversation to go");
  }, 30_000);

  it("goes when the session is taken back, as soon as the taker hears", async () => {
    const t = await takenOver();
    t.net.setOnline(t.ryanM.id, true);
    await until(() => t.nickM.team.presence(t.roomId).includes(t.ryanM.id), "Ryan back");
    await t.nick.svc.turnEnded(t.r.sessionId);
    await t.nick.svc.settled();
    await until(() => !!refIn(t.ryanClone, roomBackupRef(t.roomId, t.r.sessionId)), "Nick's copy at Ryan's");
    t.net.setOnline(t.nickM.id, false);
    await until(() => t.ryanM.team.presence(t.roomId).length === 0, "Nick to drop");
    await t.ryan.svc.takeOver(t.roomId, t.r.sessionId);
    expect(fs.existsSync(t.saved)).toBe(true); // Nick hasn't heard yet
    t.net.setOnline(t.nickM.id, true);
    await until(() => t.nick.takenOver.length === 1, "Nick to hear of the take-back");
    await until(() => !fs.existsSync(t.saved), "the saved conversation to go");
  }, 40_000);

  it("goes when its taker leaves the room, refusing a link in its place and saying so", async () => {
    const t = await takenOver();
    const out = await t.nickM.team.leave(t.roomId);
    expect(await t.nick.svc.roomLeft(out.room)).toEqual([]);
    expect(fs.existsSync(t.saved)).toBe(false);

    // the agent swapped the folder for a link to somewhere else: nothing there is deleted, and the failure is said
    const u = await takenOver();
    const elsewhere = tempDir("nick-home");
    fs.writeFileSync(path.join(elsewhere, "keep.txt"), "mine\n");
    fs.rmSync(u.saved, { recursive: true });
    fs.symlinkSync(elsewhere, u.saved);
    const left = await u.nickM.team.leave(u.roomId);
    expect(await u.nick.svc.roomLeft(left.room)).toEqual([expect.stringMatching(/^The conversation of “Donor entities” saved at its take-over couldn't be deleted from .*takeover: .*takeover is a symbolic link/)]);
    expect(fs.readFileSync(path.join(elsewhere, "keep.txt"), "utf8")).toBe("mine\n");
    expect(u.nick.logs.some((l) => /deleting the conversation saved at a take-over in .*\(this Mac left the room\)/.test(l))).toBe(true);
  }, 40_000);

  it("is found and deleted where an earlier version saved it without a record", async () => {
    const t = await takenOver();
    t.nick.svc.close();
    const file = path.join(t.nickM.store.dir, t.roomId, "takeover.json");
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(Object.keys(state.saved)).toEqual([t.r.cwd]);
    delete state.saved;
    fs.writeFileSync(file, JSON.stringify(state));
    const again = takeover(t.nickM, t.roomId, { repos: [t.nickClone], sessions: [...t.nick.sessions.values()] });
    await again.svc.prune();
    expect(fs.existsSync(t.saved)).toBe(true); // its session still runs
    const out = await t.nickM.team.leave(t.roomId);
    expect(await again.svc.roomLeft(out.room)).toEqual([]);
    expect(fs.existsSync(t.saved)).toBe(false);
  }, 30_000);
});

const viewOf = (svc: TakeoverService, id = "s1") => svc.view().sessions.find((s) => s.sessionId === id)!;
const originRefs = (bare: string) => sh(bare, "for-each-ref", "--format=%(refname)", "refs/mockingbird");

describe("backups kept peer to peer (every room's default)", () => {
  it("never pushes a turn's backup, still copies it to teammates, and a take-over works from that copy", async () => {
    const t = await setup(["Ryan", "Nick"], { backupsToOrigin: false });
    expect(t.ryanM.team.room(t.roomId)!.ext.settings).toBeUndefined(); // nobody turned anything on
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const ref = roomBackupRef(t.roomId, "s1");
    const sha = backupIn(t.ryanM, t.roomId)!.latest.sha;
    expect(originRefs(t.bare)).toBe("");
    expect(refIn(t.ryanClone, ref)).toBe(sha);
    expect(refIn(t.nickClone, ref)).toBe(sha);
    expect(backupIn(t.ryanM, t.roomId)).toMatchObject({ toOrigin: false, pushed: null });
    // the event still carries a push outcome, so a Mockingbird from before the setting takes it
    const event = t.ryanM.store.get(t.roomId)!.all().find((e) => e.type === "session.backup")!;
    expect(event.body).toMatchObject({ toOrigin: false, push: { ok: false, error: NOT_PUSHED } });
    // each side says where the copies are
    expect(backupFreshness(viewOf(t.ryan.svc))).toMatchObject({ tone: "ok", text: expect.stringMatching(/^copied to Nick /) });
    await until(() => !!viewOf(t.nick.svc)?.peerCopy, "Nick's copy in his view");
    expect(backupFreshness(viewOf(t.nick.svc))).toMatchObject({ tone: "ok", text: expect.stringMatching(/^copied here /) });

    const ryanFiles = files(t.wt);
    t.net.setOnline(t.ryanM.id, false);
    await until(() => t.nickM.team.presence(t.roomId).length === 0, "Ryan to drop");
    const plan = await t.nick.svc.plan(t.roomId, "s1");
    expect(plan).toMatchObject({ toOrigin: false, snapshot: { sha, source: "peer" }, other: null, originProblem: null, latestMissing: false, conversation: { kind: "full" } });
    const r = await t.nick.svc.takeOver(t.roomId, "s1");
    expect(files(r.cwd)).toEqual(ryanFiles);
    expect(r.conversation).toBe("full");
    // origin was never read: no copy of origin's in Nick's clone
    expect(sh(t.nickClone, "for-each-ref", "refs/mockingbird/rooms-origin")).toBe("");
    // Nick's first backup of his copy stays off origin too, and retires the old one everywhere
    await t.nick.svc.turnEnded(r.sessionId);
    expect(originRefs(t.bare)).toBe("");
    expect(backupIn(t.nickM, t.roomId, r.sessionId)).toMatchObject({ toOrigin: false });
    expect(backupIn(t.nickM, t.roomId)!.dropped).toMatchObject({ by: t.nickM.id, reason: "taken-over" });
  });

  it("says how old the copy here is when the owner's laptop has newer work", async () => {
    const t = await setup(["Ryan", "Nick", "Sam"], { backupsToOrigin: false });
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const first = backupIn(t.ryanM, t.roomId)!.latest.sha;
    await until(() => refIn(t.nickClone, roomBackupRef(t.roomId, "s1")) === first, "Nick's copy");
    t.net.partition(t.ryanM.id, t.nickM.id); // Nick hears of the next turn through Sam, but gets no copy of it
    await until(() => !t.ryanM.team.presence(t.roomId).includes(t.nickM.id), "the partition");
    write(t.wt, { "src/a.ts": "a newer turn\n" });
    await t.ryan.svc.turnEnded("s1");
    const second = backupIn(t.ryanM, t.roomId)!.latest.sha;
    await until(() => backupIn(t.nickM, t.roomId)?.latest.sha === second, "Nick to hear of the newer turn through Sam");
    expect(backupFreshness(viewOf(t.nick.svc))).toMatchObject({ tone: "warn", text: expect.stringMatching(/^copied here .* · newer on Ryan's laptop$/) });
    const plan = await t.nick.svc.plan(t.roomId, "s1");
    expect(plan).toMatchObject({ toOrigin: false, ownerOnline: false, snapshot: { sha: first, source: "peer" }, latestMissing: true });
  });

  it("refuses a take-over with no copy here, saying why", async () => {
    const t = await setup(["Ryan", "Nick", "Sam"], { backupsToOrigin: false });
    t.net.partition(t.ryanM.id, t.nickM.id); // Nick hears of it through Sam, but gets no copy
    await until(() => !t.ryanM.team.presence(t.roomId).includes(t.nickM.id), "the partition");
    await t.ryan.svc.turnEnded("s1");
    await until(() => !!backupIn(t.nickM, t.roomId), "Nick to hear of the backup through Sam");
    expect(backupFreshness(viewOf(t.nick.svc))).toEqual({ tone: "warn", text: "no copy here · only on Ryan's laptop" });
    expect(await t.nick.svc.plan(t.roomId, "s1")).toMatchObject({ toOrigin: false, snapshot: null, originProblem: null, latestMissing: true });
    await expect(t.nick.svc.takeOver(t.roomId, "s1")).rejects.toThrow(/^No copy of this session has reached this Mac yet: this room keeps backups peer to peer, and Ryan's laptop hasn't sent one/);
    expect(sh(t.nickClone, "for-each-ref", "refs/mockingbird")).toBe("");
    expect(originRefs(t.bare)).toBe("");
  });

  it("is the owner's alone to change: anyone else's change — an admin's too — is refused here and changes nothing in the room", async () => {
    const t = await setup(["Ryan", "Nick"], { backupsToOrigin: false });
    t.ryanM.team.setAdmin(t.roomId, t.nickM.id, true);
    await until(() => !!t.nickM.team.room(t.roomId)!.roles?.admins.includes(t.nickM.id), "Nick to be an admin at his");
    expect(() => t.nick.svc.setBackupsToOrigin(t.roomId, true)).toThrow(/^Only the room's owner \(Ryan\) can change where its backups go/);
    expect(t.nick.svc.view().rooms).toEqual([{ roomId: t.roomId, toOrigin: false, consent: true, changed: null, adminName: "Ryan", canChange: false, remote: "origin" }]);
    expect(t.ryan.svc.view().rooms[0]).toMatchObject({ canChange: true, adminName: "Ryan" });
    // a Mockingbird that doesn't cooperate signs one anyway: every member applies it as nothing
    t.nickM.team.publish(t.roomId, "room.settings", { backupsToOrigin: true });
    await until(() => (t.ryanM.team.room(t.roomId)?.events ?? 0) === t.nickM.team.room(t.roomId)!.events, "Ryan to get the event");
    for (const m of [t.ryanM, t.nickM]) expect(m.team.room(t.roomId)!.ext.settings).toBeUndefined();
    await t.ryan.svc.turnEnded("s1");
    expect(originRefs(t.bare)).toBe("");
    expect(() => t.ryanM.team.publish(t.roomId, "room.settings", { backupsToOrigin: "yes" } as never)).toThrow(/backupsToOrigin must be true or false/);
    // once the owner hands the room over (and leaves), the new owner's change counts
    t.ryanM.team.handOver(t.roomId, t.nickM.id);
    await t.ryanM.team.leave(t.roomId);
    await until(() => !t.nickM.team.room(t.roomId)!.members.some((m) => m.id === t.ryanM.id), "Ryan gone at Nick's");
    t.nick.svc.setBackupsToOrigin(t.roomId, true);
    expect(t.nickM.team.room(t.roomId)!.ext.settings).toMatchObject({ backupsToOrigin: true, by: t.nickM.id });
  });

  it("treats a room from before the setting as off: its old backups read as pushed, and their owner deletes them from origin on start", async () => {
    const t = await setup(["Ryan", "Nick"], { backupsToOrigin: false });
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const ref = roomBackupRef(t.roomId, "s1");
    const b = backupIn(t.ryanM, t.roomId)!;
    // what a Mockingbird from before left: the backup on origin, its record saying so, and an event without toOrigin
    sh(t.ryanClone, "push", "-q", "origin", `${b.latest.sha}:${ref}`);
    const file = path.join(t.ryanM.store.dir, t.roomId, "takeover.json");
    const local = JSON.parse(fs.readFileSync(file, "utf8"));
    local.own.s1.pushed = b.latest.sha;
    fs.writeFileSync(file, JSON.stringify(local));
    t.ryanM.team.publish(t.roomId, "session.backup", { sessionId: "s1", sha: b.latest.sha, takenAt: Date.now(), push: { ok: true, at: Date.now() }, session: b.session, transcriptBytes: null });
    expect(backupIn(t.ryanM, t.roomId)).toMatchObject({ toOrigin: true, pushed: { sha: b.latest.sha } });
    // Ryan's Mockingbird starts again, as after the update: its first prune takes the backup off origin
    t.ryan.svc.close();
    const again = takeover(t.ryanM, t.roomId, { repos: [t.ryanClone], sessions: [...t.ryan.sessions.values()] });
    await again.svc.prune();
    expect(refIn(t.bare, ref)).toBeNull();
    expect(again.svc.view().cleanup).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).own.s1.pushed).toBeNull();
    // and its next backup stays off origin
    write(t.wt, { "src/a.ts": "after the update\n" });
    await again.svc.turnEnded("s1");
    expect(originRefs(t.bare)).toBe("");
    expect(backupIn(t.ryanM, t.roomId)).toMatchObject({ toOrigin: false, pushed: null });
  });
});

describe("backups to origin (the admin's opt-in)", () => {
  it("runs the repository's pre-push hook on each push, and a hook that refuses one shows as a failed backup", async () => {
    const t = await setup();
    const ran = path.join(tempDir("hook"), "ran");
    const hook = path.join(t.ryanClone, ".git", "hooks", "pre-push");
    fs.writeFileSync(hook, `#!/bin/sh\ncat >> "${ran}"\necho 'secret scanner: an AWS key in src/a.ts' >&2\nexit 1\n`, { mode: 0o755 });
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const ref = roomBackupRef(t.roomId, "s1");
    expect(fs.readFileSync(ran, "utf8")).toContain(ref); // the hook saw the push it refused
    expect(refIn(t.bare, ref)).toBeNull();
    const b = backupIn(t.ryanM, t.roomId)!;
    expect(b.push).toMatchObject({ ok: false, error: expect.stringContaining("secret scanner: an AWS key in src/a.ts") });
    expect(backupFreshness(viewOf(t.ryan.svc)).text).toMatch(/^backup failed: .*secret scanner: an AWS key/);
    expect(refIn(t.nickClone, ref)).toBe(b.latest.sha); // the copy to Nick still went
    // a hook that lets it through: on origin
    fs.writeFileSync(hook, `#!/bin/sh\ncat >> "${ran}"\nexit 0\n`, { mode: 0o755 });
    write(t.wt, { "src/a.ts": "no key\n" });
    await t.ryan.svc.turnEnded("s1");
    expect(refIn(t.bare, ref)).toBe(backupIn(t.ryanM, t.roomId)!.latest.sha);
  });

  it("turned on: what each owner has goes to origin at once, without waiting for a turn", async () => {
    const t = await setup(["Ryan", "Nick"], { backupsToOrigin: false });
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const ref = roomBackupRef(t.roomId, "s1");
    expect(refIn(t.bare, ref)).toBeNull();
    t.ryan.svc.setBackupsToOrigin(t.roomId, true);
    await t.ryan.svc.settled();
    expect(refIn(t.bare, ref)).toBe(backupIn(t.ryanM, t.roomId)!.latest.sha);
    expect(backupIn(t.ryanM, t.roomId)).toMatchObject({ toOrigin: true, push: { ok: true } });
    await until(() => t.nick.svc.view().rooms[0]?.toOrigin === true, "Nick to see it on");
    expect(t.nick.svc.view().rooms[0]).toMatchObject({ changed: { byName: "Ryan", self: false }, canChange: false });
    expect(t.ryan.svc.view().rooms[0]).toMatchObject({ changed: { self: true }, canChange: true });
  });

  it("turned off: each owner deletes what it pushed (a failure shown and retried), pushes nothing more, and teammates stop reading origin", async () => {
    const t = await setup();
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const ref = roomBackupRef(t.roomId, "s1");
    expect(refIn(t.bare, ref)).not.toBeNull();
    rejectPushes(t.bare, true);
    t.ryan.svc.setBackupsToOrigin(t.roomId, false);
    await t.ryan.svc.settled();
    expect(refIn(t.bare, ref)).not.toBeNull();
    expect(t.ryan.svc.view().cleanup).toEqual([{ roomId: t.roomId, sessionId: "s1", title: "Donor entities", problem: expect.stringMatching(/backups are switched off here|declined/) }]);
    expect(t.ryan.logs.some((l) => /deleting the backup of session s1/.test(l))).toBe(true);
    rejectPushes(t.bare, false);
    await t.ryan.svc.prune();
    expect(refIn(t.bare, ref)).toBeNull();
    expect(t.ryan.svc.view().cleanup).toEqual([]);
    // the next turn: copied to Nick, not pushed
    write(t.wt, { "src/a.ts": "after\n" });
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    expect(originRefs(t.bare)).toBe("");
    const b = backupIn(t.ryanM, t.roomId)!;
    expect(b).toMatchObject({ toOrigin: false, pushed: null });
    expect(refIn(t.nickClone, ref)).toBe(b.latest.sha);
    await until(() => backupIn(t.nickM, t.roomId)?.latest.sha === b.latest.sha, "Nick to hear of it");
    expect(await t.nick.svc.plan(t.roomId, "s1")).toMatchObject({ toOrigin: false, snapshot: { source: "peer", sha: b.latest.sha }, other: null });
    expect(sh(t.nickClone, "for-each-ref", "refs/mockingbird/rooms-origin")).toBe("");
  });
});

describe("take-over: the owner's hand-over when they're online, none when they're offline", () => {
  /** Ryan's s1 backed up and copied to Nick, then Ryan's laptop shut. */
  async function ryanAway(o: Parameters<typeof setup>[1] = {}) {
    const t = await setup(["Ryan", "Nick"], o);
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    await until(() => !!refIn(t.nickClone, roomBackupRef(t.roomId, "s1")), "Nick's copy");
    t.net.setOnline(t.ryanM.id, false);
    await until(() => t.nickM.team.presence(t.roomId).length === 0, "Ryan to drop");
    return t;
  }
  const back = async (t: Awaited<ReturnType<typeof setup>>) => {
    t.net.setOnline(t.ryanM.id, true);
    await until(() => t.nickM.team.presence(t.roomId).includes(t.ryanM.id), "Ryan back");
  };
  const caughtUp = (t: Awaited<ReturnType<typeof setup>>) =>
    until(() => (t.ryanM.team.room(t.roomId)?.events ?? 0) === t.nickM.team.room(t.roomId)!.events, "both to hold the same events");

  it("with the owner offline, any member takes it over with no grant, and every log agrees on who holds it", async () => {
    const t = await setup(["Ryan", "Nick", "Sam"]);
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    await until(() => !!refIn(t.nickClone, roomBackupRef(t.roomId, "s1")), "Nick's copy");
    expect(backupIn(t.nickM, t.roomId)).toMatchObject({ grants: true, offline: true });
    t.net.setOnline(t.ryanM.id, false);
    await until(() => !t.nickM.team.presence(t.roomId).includes(t.ryanM.id), "Ryan to drop");
    expect((await t.nick.svc.plan(t.roomId, "s1")).grant).toEqual({ kind: "offline" });
    expect(viewOf(t.nick.svc)).toMatchObject({ ownerOnline: false, offlineTakeover: true });
    const r = await t.nick.svc.takeOver(t.roomId, "s1");
    await until(() => backupIn(t.samM!, t.roomId)?.takenOver?.newSessionId === r.sessionId, "Sam to hear of it");
    // Ryan's Mac, back, was offline when it happened: it honours it, and stops its copy
    t.net.setOnline(t.ryanM.id, true);
    await until(() => t.ryan.stopped.includes("s1"), "Ryan's copy to stop");
    const all = [t.ryanM, t.nickM, t.samM!];
    await until(() => new Set(all.map((m) => m.team.room(t.roomId)!.events)).size === 1, "every log to hold the same events");
    for (const m of all) expect(backupIn(m, t.roomId)).toMatchObject({ takenOver: { by: t.nickM.id, newSessionId: r.sessionId, grant: "offline" } });
    for (const m of all) expect(backupIn(m, t.roomId)!.refusals).toBeUndefined();
    expect(t.ryan.chat).toEqual([]);
    expect(t.ryan.takenOver).toEqual(["s1 by Nick"]);
    expect(t.nick.refused).toEqual([]);
    expect(t.ryan.svc.relaunchRefusal("s1")).toMatch(/continues on Nick's laptop/);
  }, 30_000);

  it("an offline take-over stamped while the owner's Mac was connected to the taker is refused: every log puts the session back, the taker's copy stops", async () => {
    // no leeway, so a take-over moments after connecting falls inside the connection
    const t = await setup(["Ryan", "Nick", "Sam"], { skew: 0 });
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const all = [t.ryanM, t.nickM, t.samM!];
    const caught = () => until(() => new Set(all.map((m) => m.team.room(t.roomId)!.events)).size === 1, "every log to hold the same events");
    await caught();
    // Nick's Mac, connected to Ryan's, publishes a take-over as if Ryan were offline (a modified Mockingbird, or a stale view): its copy is running
    t.nick.sessions.set("n5", session({ id: "n5", cwd: t.nickClone, repoPath: t.nickClone }));
    const sha = backupIn(t.nickM, t.roomId)!.latest.sha;
    t.nickM.team.publish(t.roomId, "session.takenOver", { sessionId: "s1", from: t.ryanM.id, newSessionId: "n5", snapshot: { sha, takenAt: backupIn(t.nickM, t.roomId)!.latest.takenAt, source: "peer" }, conversation: "none", branch: "feature-x", offline: 1 });
    await until(() => t.ryan.chat.length === 1, "Ryan's Mac to refuse it");
    await caught();
    for (const m of all) {
      expect(backupIn(m, t.roomId)).toMatchObject({ owner: t.ryanM.id, takenOver: null, dropped: null, refusals: [{ by: t.nickM.id, newSessionId: "n5", reason: "connected" }] });
    }
    expect(t.ryan.stopped).toEqual([]); // Ryan's agent never stopped
    expect(t.ryan.takenOver).toEqual([]);
    expect(t.ryan.chat[0]).toBe("“Donor entities” stays on Ryan's laptop: Nick's take-over was refused (Ryan's Mac was connected to Nick's then, so Nick should have asked). Ask Ryan to hand it over.");
    expect(t.ryan.logs.some((l) => /refused Nick's offline take-over of session s1/.test(l))).toBe(true);
    // Nick's copy stops, says why, and doesn't run again
    await until(() => t.nick.stopped.includes("n5"), "Nick's copy to stop");
    expect(t.nick.refused).toEqual(["n5: Ryan refused “Donor entities”"]);
    expect(t.nick.svc.relaunchRefusal("n5")).toMatch(/^Ryan's Mac refused this take-over of “Donor entities”: the session stayed theirs/);
    expect(t.ryan.svc.relaunchRefusal("s1")).toBeNull();
    // Ryan's session goes on backing up as his, on every log
    write(t.wt, { "src/a.ts": "Ryan keeps typing\n" });
    await t.ryan.svc.turnEnded("s1");
    await caught();
    for (const m of all) expect(backupIn(m, t.roomId)).toMatchObject({ owner: t.ryanM.id, takenOver: null, latest: { sha: expect.not.stringMatching(sha) } });
    // and a take-over by the hand-over still works afterwards
    const asked = t.nick.svc.takeOver(t.roomId, "s1");
    await until(() => t.ryan.asks.length === 1, "Ryan to be asked");
    t.ryan.svc.answerAsk(t.ryan.asks[0].askId, "handover");
    const r = await asked;
    await caught();
    for (const m of all) expect(backupIn(m, t.roomId)!.takenOver).toMatchObject({ by: t.nickM.id, newSessionId: r.sessionId, grant: "handover" });
  }, 40_000);

  it("is refused by the owner only for a taker it was connected to: cut off from Nick but not from Sam, Ryan's session is Nick's to take", async () => {
    const t = await setup(["Ryan", "Nick", "Sam"], { skew: 0 });
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    await until(() => !!refIn(t.nickClone, roomBackupRef(t.roomId, "s1")), "Nick's copy");
    t.net.partition(t.ryanM.id, t.nickM.id);
    await until(() => !t.nickM.team.presence(t.roomId).includes(t.ryanM.id) && !t.ryanM.team.presence(t.roomId).includes(t.nickM.id), "the partition");
    expect((await t.nick.svc.plan(t.roomId, "s1")).grant).toEqual({ kind: "offline" });
    const r = await t.nick.svc.takeOver(t.roomId, "s1");
    // Ryan hears of it through Sam: his Mac wasn't connected to Nick's then, so it counts
    await until(() => t.ryan.stopped.includes("s1"), "Ryan's copy to stop");
    const all = [t.ryanM, t.nickM, t.samM!];
    await until(() => new Set(all.map((m) => m.team.room(t.roomId)!.events)).size === 1, "every log to hold the same events");
    for (const m of all) expect(backupIn(m, t.roomId)!.takenOver).toMatchObject({ by: t.nickM.id, newSessionId: r.sessionId, grant: "offline" });
    expect(t.ryan.chat).toEqual([]);
  }, 30_000);

  it("still asks an online owner first — when the room's owner or an admin takes over a member's session too", async () => {
    const t = await setup(["Ryan", "Nick", "Sam"]);
    // Ryan owns the room and makes Sam an admin; Nick's session n1
    t.ryanM.team.setAdmin(t.roomId, t.samM!.id, true);
    await until(() => !!t.samM!.team.room(t.roomId)!.roles?.admins.includes(t.samM!.id), "Sam to be an admin at his");
    t.nick.sessions.set("n1", session({ id: "n1", cwd: t.nickClone, repoPath: t.nickClone, title: "Gift export", conversation: undefined }));
    await t.nick.svc.turnEnded("n1");
    await until(() => !!backupIn(t.ryanM, t.roomId, "n1") && !!backupIn(t.samM!, t.roomId, "n1"), "Ryan and Sam to hear of Nick's session");
    for (const taker of [t.ryan, t.sam!]) {
      expect((await taker.svc.plan(t.roomId, "n1")).grant).toEqual({ kind: "ask" });
      // Sam has no clone among his repositories: he picks Ryan's (any clone of the repository does)
      const asked = taker.svc.takeOver(t.roomId, "n1", t.ryanClone);
      await until(() => t.nick.asks.length === 1, "Nick to be asked");
      t.nick.svc.answerAsk(t.nick.asks[0].askId, "keep");
      await expect(asked).rejects.toThrow(/Nick kept/);
      t.nick.asks.length = 0;
    }
    expect(t.nick.stopped).toEqual([]);
    expect(backupIn(t.nickM, t.roomId, "n1")!.takenOver).toBeNull();
  }, 30_000);

  it("waits for a 1.5 owner to come back: their sessions aren't taken over while they're offline, and a forced take-over changes nothing", async () => {
    const t = await setup(["Ryan", "Nick"]);
    await t.ryan.svc.turnEnded("s1");
    await caughtUp(t);
    // what a 1.5 Mockingbird of Ryan's publishes: a backup that signs grants, without taking offline take-overs
    const sha = backupIn(t.nickM, t.roomId)!.latest.sha;
    const at = Date.now();
    t.ryanM.team.publish(t.roomId, "session.backup", { sessionId: "old1", sha, takenAt: at, push: { ok: false, at, error: NOT_PUSHED }, toOrigin: false, session: { title: "Older one", agent: "claude", branch: "feature-x", originUrl: t.bare, cwd: t.wt, conversationId: null }, transcriptBytes: null, grants: 1 });
    await until(() => !!backupIn(t.nickM, t.roomId, "old1"), "Nick to hear of it");
    expect(backupIn(t.nickM, t.roomId, "old1")!.offline).toBeUndefined();
    t.net.setOnline(t.ryanM.id, false);
    await until(() => !t.nickM.team.presence(t.roomId).includes(t.ryanM.id), "Ryan to drop");
    const why = /^Ryan's Mockingbird needs an update \(1\.6\.0\) before their sessions can be taken over while they're offline\. Take it over once Ryan is back online/;
    expect((await t.nick.svc.plan(t.roomId, "old1")).grant).toEqual({ kind: "none", why: expect.stringMatching(why) });
    expect(viewOf(t.nick.svc, "old1").offlineTakeover).toBe(false);
    await expect(t.nick.svc.takeOver(t.roomId, "old1")).rejects.toThrow(/can't be taken over: Ryan's Mockingbird needs an update \(1\.6\.0\)/);
    expect(t.nick.launched).toEqual([]);
    // forced through anyway, it's held as ungranted: nothing changes, on Nick's log as on the 1.5 owner's
    t.nickM.team.publish(t.roomId, "session.takenOver", { sessionId: "old1", from: t.ryanM.id, newSessionId: "forced1", snapshot: { sha, takenAt: at, source: "peer" }, conversation: "none", branch: null, offline: 1 });
    expect(backupIn(t.nickM, t.roomId, "old1")).toMatchObject({ takenOver: null, ungranted: { by: t.nickM.id, newSessionId: "forced1" } });
    // while s1, whose owner's Mockingbird takes them, is Nick's to take
    expect(viewOf(t.nick.svc).offlineTakeover).toBe(true);
  }, 30_000);

  it("loads logs with 1.5's away grants: the take-overs they granted still count, on reload too", async () => {
    const t = await ryanAway();
    // what 1.5 did: Ryan allowed take-overs while away (signed before he left), and Nick took s1 over under it
    const now = Date.now();
    const grant = signGrant(t.ryanM.team, { kind: "away", roomId: t.roomId, sessions: null, to: null, sha: null, issuedAt: now - 60_000, expiresAt: now + 8 * 3_600_000 });
    await back(t);
    t.ryanM.team.publish(t.roomId, "session.awayGrant", { grant });
    await caughtUp(t);
    t.net.setOnline(t.ryanM.id, false);
    await until(() => !t.nickM.team.presence(t.roomId).includes(t.ryanM.id), "Ryan to drop");
    const latest = backupIn(t.nickM, t.roomId)!.latest;
    t.nickM.team.publish(t.roomId, "session.takenOver", { sessionId: "s1", from: t.ryanM.id, newSessionId: "away1", snapshot: { ...latest, source: "peer" }, conversation: "none", branch: "feature-x", grant });
    await back(t);
    await until(() => t.ryan.stopped.includes("s1"), "Ryan's copy to stop");
    await caughtUp(t);
    for (const m of [t.ryanM, t.nickM]) expect(backupIn(m, t.roomId)!.takenOver).toMatchObject({ by: t.nickM.id, newSessionId: "away1", grant: "away" });
    expect(t.ryan.chat).toEqual([]);
    // read back from disk, the same
    for (const m of [t.ryanM, t.nickM]) {
      const store = new RoomStore(m.store.dir).load();
      expect(store.problems).toEqual([]);
      const state = store.get(t.roomId)!.state!;
      expect(state.ext.takeover!.away![t.ryanM.id].id).toBe(grant.id);
      expect(state.ext.takeover!.sessions.s1.takenOver).toMatchObject({ by: t.nickM.id, newSessionId: "away1", grant: "away" });
    }
    // withdrawn the 1.5 way: still parses, and changes nothing that counted
    t.ryanM.team.publish(t.roomId, "session.awayGrant", { grant: null });
    await caughtUp(t);
    expect(backupIn(t.nickM, t.roomId)!.takenOver).toMatchObject({ grant: "away" });
  }, 40_000);

  it("checks every grant against the owner's key, the session, the taker and the snapshot", async () => {
    const t = await setup(["Ryan", "Nick", "Sam"]);
    await t.ryan.svc.turnEnded("s1");
    await until(() => !!backupIn(t.samM!, t.roomId), "Sam to hear of the backup");
    const room = t.nickM.team.room(t.roomId)!;
    const sha = room.ext.takeover!.sessions.s1.latest.sha;
    const now = Date.now();
    const use = { owner: t.ryanM.id, ownerName: "Ryan", sessionId: "s1", taker: t.nickM.id, at: now, sha };
    const handover = (signer: { self: { id: string }; sign(text: string): string }, o: Partial<TakeoverGrant> = {}) => ({
      ...signGrant(signer, { kind: "handover", roomId: t.roomId, sessions: ["s1"], to: t.nickM.id, sha, issuedAt: now, expiresAt: now + 60_000 }),
      ...o,
    });
    expect(grantProblem(room, handover(t.ryanM.team), use)).toBeNull();
    expect(grantProblem(room, undefined, use)).toBe("Ryan didn't hand it over");
    expect(grantProblem(room, handover(t.ryanM.team), { ...use, taker: t.samM!.id })).toBe("Ryan handed it over to someone else");
    expect(grantProblem(room, handover(t.ryanM.team), { ...use, sha: "f".repeat(40) })).toBe("Ryan handed over another snapshot");
    expect(grantProblem(room, handover(t.ryanM.team), { ...use, sessionId: "s2" })).toBe("Ryan's grant doesn't cover this session");
    expect(grantProblem(room, handover(t.ryanM.team), { ...use, at: now + 120_000 })).toBe("Ryan's grant expired");
    // Nick signs one in Ryan's name, or edits Ryan's: not Ryan's signature
    const forged = { ...signGrant(t.nickM.team, { kind: "handover", roomId: t.roomId, sessions: ["s1"], to: t.nickM.id, sha, issuedAt: now, expiresAt: now + 60_000 }), owner: t.ryanM.id };
    expect(grantProblem(room, forged, use)).toBe("the grant isn't signed by Ryan");
    expect(grantProblem(room, { ...handover(t.ryanM.team), expiresAt: now + 120_000 }, { ...use, at: now + 90_000 })).toBe("the grant isn't signed by Ryan");
    expect(grantProblem(room, handover(t.ryanM.team, { roomId: "x".repeat(22) }), use)).toBe("the grant is for another room");
    expect(grantProblem(room, { ...handover(t.ryanM.team), expiresAt: now + HANDOVER_GRANT_MS + 1 }, use)).toBe("a hand-over can't last that long");
    // the room's admin is no exception: Ryan's own grant is the only one that lets anyone take Ryan's session — and Ryan's own session isn't his to take
    expect(grantProblem(room, handover(t.ryanM.team), { ...use, owner: t.nickM.id, ownerName: "Nick" })).toBe("the grant isn't Nick's");
  });

  it("an ungranted take-over changes nothing on the owner's Mac (M3) — not even the room admin's: the session runs on, and the room is told once", async () => {
    const t = await setup(["Ryan", "Nick"]);
    // Nick's session n1; Ryan is the room's admin
    t.nick.sessions.set("n1", session({ id: "n1", cwd: t.nickClone, repoPath: t.nickClone, title: "Gift export", conversation: undefined }));
    await t.nick.svc.turnEnded("n1");
    await until(() => !!backupIn(t.ryanM, t.roomId, "n1"), "Ryan to hear of Nick's session");
    await t.ryan.svc.turnEnded("s1");
    await caughtUp(t);
    // Ryan (the admin) forces a take-over of Nick's session without Nick's grant, as a modified Mockingbird would
    const sha = backupIn(t.ryanM, t.roomId, "n1")!.latest.sha;
    t.ryanM.team.publish(t.roomId, "session.takenOver", { sessionId: "n1", from: t.nickM.id, newSessionId: "r9", snapshot: { sha, takenAt: 1, source: "peer" }, conversation: "none", branch: null });
    await caughtUp(t);
    for (const m of [t.ryanM, t.nickM]) expect(backupIn(m, t.roomId, "n1")).toMatchObject({ takenOver: null, ungranted: { by: t.ryanM.id, newSessionId: "r9" } });
    expect(t.nick.stopped).toEqual([]);
    expect(t.nick.takenOver).toEqual([]);
    await until(() => t.nick.chat.length === 1, "Nick's Mac to say so in the room");
    expect(t.nick.chat[0]).toBe("“Gift export” keeps running on Nick's laptop: Ryan's Mockingbird needs to update to take over: take-overs now need Nick's signed hand-over. Ask Nick to hand it over.");
    expect(t.nick.svc.view().refused).toEqual([{ roomId: t.roomId, sessionId: "n1", title: "Gift export", byName: "Ryan", at: expect.any(Number), why: expect.stringMatching(/^Ryan's Mockingbird needs to update/) }]);
    expect(t.nick.logs.some((l) => /refused Ryan's take-over of session n1/.test(l))).toBe(true);
    // Nick's session still backs up as his
    write(t.nickClone, { "export.ts": "more\n" });
    await t.nick.svc.turnEnded("n1");
    await caughtUp(t);
    expect(backupIn(t.ryanM, t.roomId, "n1")).toMatchObject({ owner: t.nickM.id, takenOver: null });
    // a grant Ryan signed in Nick's name doesn't do it either, and the room is told only once per taker
    const forged = { ...signGrant(t.ryanM.team, { kind: "handover", roomId: t.roomId, sessions: ["n1"], to: t.ryanM.id, sha, issuedAt: Date.now(), expiresAt: Date.now() + 60_000 }), owner: t.nickM.id };
    t.ryanM.team.publish(t.roomId, "session.takenOver", { sessionId: "n1", from: t.nickM.id, newSessionId: "r10", snapshot: { sha, takenAt: 1, source: "peer" }, conversation: "none", branch: null, grant: forged });
    await caughtUp(t);
    expect(backupIn(t.nickM, t.roomId, "n1")!.takenOver).toBeNull();
    expect(t.nick.stopped).toEqual([]);
    expect(t.nick.chat).toHaveLength(1);
  });

  it("tells an older Mockingbird asking for a session that it needs an update — and a taker whose owner's Mockingbird is older", async () => {
    const t = await setup(["Ryan", "Nick"]);
    await t.ryan.svc.turnEnded("s1");
    await caughtUp(t);
    // an older Mockingbird asks the old way: it would take over without Ryan's hand-over
    await expect(t.nickM.team.request(t.ryanM.id, "takeover.ask", { roomId: t.roomId, sessionId: "s1", askId: "a".repeat(24) }, { roomId: t.roomId })).rejects.toThrow(
      /Nick needs to update Mockingbird to take over “Donor entities”: take-overs now need Ryan's signed hand-over/
    );
    expect(t.ryan.asks).toEqual([]);
    expect(t.ryan.stopped).toEqual([]);
    // an older owner can't hand over: there's nothing on their side to ask (closing the service takes its handlers away)
    t.ryan.svc.close();
    await expect(t.nick.svc.takeOver(t.roomId, "s1")).rejects.toThrow(/^Ryan needs to update Mockingbird to hand “Donor entities” over: take-overs now need their signed hand-over/);
    expect(t.nick.launched).toEqual([]);
  });

  it("accepts, on the owner's first start with grants, a take-over from before them that it had already honoured", async () => {
    const t = await ryanAway();
    // what an older Nick did: a take-over with no grant
    const sha = backupIn(t.nickM, t.roomId)!.latest.sha;
    t.nickM.team.publish(t.roomId, "session.takenOver", { sessionId: "s1", from: t.ryanM.id, newSessionId: "old1", snapshot: { sha, takenAt: 1, source: "peer" }, conversation: "full", branch: "feature-x" });
    // and Nick's first backup of his copy dropped the old one
    t.nickM.team.publish(t.roomId, "session.backupDropped", { sessionId: "s1", reason: "taken-over" });
    expect(backupIn(t.nickM, t.roomId)).toMatchObject({ takenOver: null, dropped: null, ungranted: { by: t.nickM.id }, ungrantedDrop: { reason: "taken-over" } });
    // what an older Ryan did with it: stopped its copy and kept a record of it (takeover.json's left)
    t.ryan.svc.close();
    const file = path.join(t.ryanM.store.dir, t.roomId, "takeover.json");
    const local = JSON.parse(fs.readFileSync(file, "utf8"));
    local.left = { s1: { base: sha, repo: t.ryanClone, cwd: t.wt, title: "Donor entities", at: 1 } };
    fs.writeFileSync(file, JSON.stringify(local));
    await back(t);
    await caughtUp(t);
    // Ryan's Mockingbird starts with grants: the take-over it honoured counts, everywhere, with its drop
    const again = takeover(t.ryanM, t.roomId, { repos: [t.ryanClone], sessions: [session({ id: "s1", cwd: t.wt, repoPath: t.ryanClone })] });
    await caughtUp(t);
    for (const m of [t.ryanM, t.nickM]) expect(backupIn(m, t.roomId)).toMatchObject({ takenOver: { by: t.nickM.id, newSessionId: "old1", grant: "accepted" }, dropped: { reason: "taken-over" } });
    expect(again.stopped).toEqual(["s1"]);
    expect(again.chat).toEqual([]);
    // an ungranted take-over this Mac never honoured is never accepted
    const u = await ryanAway();
    u.nickM.team.publish(u.roomId, "session.takenOver", { sessionId: "s1", from: u.ryanM.id, newSessionId: "old2", snapshot: { sha: backupIn(u.nickM, u.roomId)!.latest.sha, takenAt: 1, source: "peer" }, conversation: "full", branch: null });
    u.ryan.svc.close();
    await back(u);
    await caughtUp(u);
    const later = takeover(u.ryanM, u.roomId, { repos: [u.ryanClone], sessions: [session({ id: "s1", cwd: u.wt, repoPath: u.ryanClone })] });
    await caughtUp(u);
    expect(backupIn(u.ryanM, u.roomId)!.takenOver).toBeNull();
    expect(later.stopped).toEqual([]);
  }, 40_000);
});

describe("the snapshot a take-over starts from is one the owner signed (N6)", () => {
  /** Someone with push access to the repository (no room member) sets the session's backup ref on origin to their own commit, dated in the future. */
  function plant(t: Awaited<ReturnType<typeof setup>>): string {
    const elsewhere = path.join(tempDir("outsider"), "app");
    sh(path.dirname(elsewhere), "clone", "-q", t.bare, elsewhere);
    write(elsewhere, { "src/a.ts": "planted\n", ".claude/settings.json": '{"hooks":{}}\n' });
    git(elsewhere, "add", "-A");
    git(elsewhere, "commit", "-q", "-m", `Mockingbird: room session s1 after a turn\n\ntaken-at: ${Date.now() + 86_400_000}`);
    const planted = sh(elsewhere, "rev-parse", "HEAD");
    sh(elsewhere, "push", "-q", "--force", "origin", `HEAD:${roomBackupRef(t.roomId, "s1")}`);
    return planted;
  }

  it("ignores and logs a planted ref on origin, never reading the date inside it, and starts from the snapshot the owner recorded", async () => {
    const t = await setup();
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const signed = backupIn(t.nickM, t.roomId)!.latest.sha;
    const planted = plant(t);
    expect(refIn(t.bare, roomBackupRef(t.roomId, "s1"))).toBe(planted);
    t.net.setOnline(t.ryanM.id, false);
    await until(() => t.nickM.team.presence(t.roomId).length === 0, "Ryan to drop");
    const plan = await t.nick.svc.plan(t.roomId, "s1");
    expect(plan.snapshot).toMatchObject({ sha: signed, source: "peer" });
    expect(plan.other).toBeNull();
    expect(plan.originProblem).toMatch(new RegExp(`^origin's backup ref points at ${planted.slice(0, 8)}, a commit Ryan never recorded backing up — ignored`));
    expect(t.nick.logs.some((l) => l.includes(`reading origin's backup of session s1: origin's backup ref points at ${planted.slice(0, 8)}`))).toBe(true);
    expect(refIn(t.nickClone, roomBackupRef(t.roomId, "s1", "refs/mockingbird/rooms-origin"))).toBeNull();
    const r = await t.nick.svc.takeOver(t.roomId, "s1");
    expect(fs.readFileSync(path.join(r.cwd, "src/a.ts"), "utf8")).toBe("export const a = 42; // edited\n");
    expect(fs.existsSync(path.join(r.cwd, ".claude/settings.json"))).toBe(false);
  });

  it("with no copy here, a planted ref alone is never a snapshot to start from", async () => {
    const t = await setup(["Ryan", "Nick"], { nickHasClone: false });
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    plant(t);
    t.net.setOnline(t.ryanM.id, false);
    await until(() => t.nickM.team.presence(t.roomId).length === 0, "Ryan to drop");
    const plan = await t.nick.svc.plan(t.roomId, "s1", t.nickClone);
    expect(plan).toMatchObject({ snapshot: null, originProblem: expect.stringMatching(/never recorded backing up — ignored/) });
    await expect(t.nick.svc.takeOver(t.roomId, "s1", t.nickClone)).rejects.toThrow(/No snapshot of this session reached this Mac or origin/);
  });

  it("keeps a peer copy only when the commit it names arrived, whatever its bundle's ref says", async () => {
    const t = await setup();
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    const ref = roomBackupRef(t.roomId, "s1");
    const held = refIn(t.nickClone, ref);
    expect(held).toBe(backupIn(t.ryanM, t.roomId)!.latest.sha);
    await expect(t.ryanM.team.request(t.nickM.id, "takeover.snapshot", { roomId: t.roomId, sessionId: "s1", sha: "f".repeat(40), originUrl: publicUrl(t.bare), bundle: null }, { roomId: t.roomId })).rejects.toThrow(
      /snapshot ffffffff isn't in this Mac's clone/
    );
    expect(refIn(t.nickClone, ref)).toBe(held);
    // a bundle whose ref holds some other commit than the one named
    const other = path.join(tempDir("other"), "app");
    sh(path.dirname(other), "clone", "-q", t.bare, other);
    write(other, { "src/a.ts": "something else\n" });
    git(other, "commit", "-qam", "something else");
    git(other, "update-ref", ref, "HEAD");
    const file = path.join(tempDir("bundle"), "x.bundle");
    git(other, "bundle", "create", file, ref);
    const bundle = fs.readFileSync(file).toString("base64");
    await expect(t.ryanM.team.request(t.nickM.id, "takeover.snapshot", { roomId: t.roomId, sessionId: "s1", sha: "e".repeat(40), originUrl: publicUrl(t.bare), bundle }, { roomId: t.roomId })).rejects.toThrow(
      /snapshot eeeeeeee isn't in this Mac's clone \(the bundle didn't hold it\)/
    );
    expect(refIn(t.nickClone, ref)).toBe(held);
    expect(t.nick.logs.some((l) => /doesn't hold the commit it named \(eeeeeeee\): refused/.test(l))).toBe(true);
  });
});

describe("each member's consent to backups to origin", () => {
  it("the admin's switch alone pushes nobody's work: each member allows it for their own sessions, and turning theirs off deletes what they pushed", async () => {
    const t = await setup(["Ryan", "Nick"], { consent: false });
    const ref = roomBackupRef(t.roomId, "s1");
    // the admin (Ryan) made it available; nobody has answered yet: asked, and kept peer to peer meanwhile
    expect(t.ryan.svc.view().rooms[0]).toMatchObject({ toOrigin: true, consent: null });
    expect(t.nick.svc.view().rooms[0]).toMatchObject({ toOrigin: true, consent: null });
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    expect(originRefs(t.bare)).toBe("");
    let b = backupIn(t.ryanM, t.roomId)!;
    expect(b).toMatchObject({ toOrigin: false, pushed: null, push: { ok: false, error: NOT_ALLOWED } });
    expect(refIn(t.nickClone, ref)).toBe(b.latest.sha); // still copied to Nick, peer to peer
    // Not now is an answer: still nothing on origin, and it's kept
    t.ryan.svc.setBackupConsent(t.roomId, false);
    await t.ryan.svc.settled();
    write(t.wt, { "src/a.ts": "turn 2\n" });
    await t.ryan.svc.turnEnded("s1");
    expect(originRefs(t.bare)).toBe("");
    expect(t.ryan.svc.view().rooms[0]).toMatchObject({ consent: false });
    // Allow: the newest snapshot goes at once, and every turn after
    t.ryan.svc.setBackupConsent(t.roomId, true);
    await t.ryan.svc.settled();
    b = backupIn(t.ryanM, t.roomId)!;
    expect(refIn(t.bare, ref)).toBe(b.latest.sha);
    expect(b).toMatchObject({ toOrigin: true, push: { ok: true } });
    // Nick's answer is his own: Ryan allowing it changed nothing for him
    expect(t.nick.svc.view().rooms[0]).toMatchObject({ consent: null });
    // the answer is kept on this Mac only, across restarts
    const kept = path.join(path.dirname(t.ryanM.store.dir), "backup-consent.json");
    expect(JSON.parse(fs.readFileSync(kept, "utf8"))).toEqual({ [t.roomId]: { allow: true, at: expect.any(Number) } });
    expect(fs.statSync(kept).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(t.ryanM.team.room(t.roomId)!.ext)).not.toContain("consent");
    // turning his own off deletes what he pushed, and pushes no more
    t.ryan.svc.setBackupConsent(t.roomId, false);
    await t.ryan.svc.settled();
    expect(refIn(t.bare, ref)).toBeNull();
    write(t.wt, { "src/a.ts": "turn 3\n" });
    await t.ryan.svc.turnEnded("s1");
    await t.ryan.svc.settled();
    expect(originRefs(t.bare)).toBe("");
    expect(backupIn(t.ryanM, t.roomId)).toMatchObject({ toOrigin: false, pushed: null });
  });
});

describe("the owner's record of connections, and the offline take-over rule", () => {
  const MIN = 60_000;
  it("refuses a take-over stamped inside a connection, with leeway at both ends, and one stamped before its snapshot", () => {
    const spans: [number, number | null][] = [[100 * MIN, 200 * MIN], [300 * MIN, null]];
    const rule = (at: number, snapshotAt = 0) => offlineTakeoverRefusal({ at, snapshotAt, connected: spans, skew: 2 * MIN });
    expect(rule(150 * MIN)).toBe("connected");
    expect(rule(101 * MIN)).toBeNull(); // just after connecting: the taker may not have seen it yet
    expect(rule(199 * MIN)).toBeNull(); // just before it dropped: the owner may have been gone already
    expect(rule(250 * MIN)).toBeNull(); // apart
    expect(rule(302 * MIN)).toBe("connected"); // still connected now: any later time
    expect(rule(10_000 * MIN)).toBe("connected");
    expect(rule(250 * MIN, 260 * MIN)).toBe("before-snapshot");
    expect(rule(250 * MIN, 251 * MIN)).toBeNull(); // within the leeway of the snapshot's time
    expect(offlineTakeoverRefusal({ at: 150 * MIN, snapshotAt: 0, connected: [], skew: 2 * MIN })).toBeNull(); // never connected: it counts
    expect(connectedThen(spans, 150 * MIN, 0)).toBe(true);
  });

  it("keeps spans across a restart, ending one left open at its last heartbeat, and lets old ones go", () => {
    const dir = tempDir("connections");
    let now = 1_000 * MIN;
    const log = new ConnectionLog({ dir, now: () => now, log: (c) => c });
    log.update("room1", ["nick", "sam"]);
    now += 10 * MIN;
    log.update("room1", ["sam"]);
    expect(log.spans("room1", "nick")).toEqual([[1_000 * MIN, 1_010 * MIN]]);
    now += 5 * MIN;
    log.beat(); // Sam is still connected at 1015
    now += 30 * MIN; // the app dies without closing
    const again = new ConnectionLog({ dir, now: () => now, log: (c) => c });
    expect(again.spans("room1", "sam")).toEqual([[1_000 * MIN, 1_015 * MIN]]);
    expect(fs.statSync(path.join(dir, "room1", "connected.json")).mode & 0o777).toBe(0o600);
    // a month on, the old spans are let go at the next write
    now += CONNECTED_KEEP_MS;
    again.update("room1", ["sam"]);
    expect(again.spans("room1", "nick")).toEqual([]);
    expect(again.spans("room1", "sam")).toEqual([[now, null]]);
    again.close();
    expect(again.spans("room1", "sam")).toEqual([[now, now]]);
  });
});

describe("take-over pieces", () => {
  it("names the remote backups would go to", () => {
    expect(remoteLabel(["git@github.com:acme/app.git", "https://github.com/acme/other"])).toBe("GitHub");
    expect(remoteLabel(["https://acme@dev.azure.com/acme/Backoffice/_git/Api", "git@ssh.dev.azure.com:v3/acme/Backoffice/Api"])).toBe("Azure DevOps");
    expect(remoteLabel(["git@gitlab.example.com:team/app.git"])).toBe("gitlab.example.com");
    expect(remoteLabel(["git@github.com:acme/app.git", "https://gitlab.com/acme/app"])).toBe("origin");
    expect(remoteLabel(["/srv/git/app.git"])).toBe("origin");
    expect(remoteLabel([])).toBe("origin");
  });

  it("takes room sessions and their turn ends from the live panes", () => {
    const R = "R".repeat(22);
    const s = (id: string, taskGroup: string | null) => session({ id, cwd: "/w", repoPath: "/r", taskGroup });
    const feed = new TurnFeed();
    // what the live panes say, not the group alone: a taken-over session has left the room
    const live = { roomOfSession: (id: string) => (id === "a" ? R : null), onTurnEnded: (cb: Parameters<TurnFeed["on"]>[0]) => feed.on(cb) };
    const stopped: string[] = [];
    const host = liveRoomHost(live, {
      sessions: () => [s("a", "5110"), s("b", "5110/api"), s("c", "5102")],
      resumable: () => [s("r", "5110")],
      rooms: () => [{ id: R, groupKey: "5110" }],
      stop: (id) => (stopped.push(id), true),
    });
    expect(["a", "b", "c", "gone"].map((id) => host.roomOf(id))).toEqual([R, null, null, null]);
    expect(host.groupOf(R)).toBe("5110");
    expect(host.session("b")?.taskGroup).toBe("5110/api");
    expect(host.session("r")?.id).toBe("r"); // closed to resume: its files still back a hand-over
    expect(host.stop("a")).toBe(true);
    expect(stopped).toEqual(["a"]);
    const ends: string[] = [];
    const off = host.onTurnEnd((id) => ends.push(id));
    feed.emit({ sessionId: "a", roomId: R, status: "idle", drivers: [] });
    off();
    feed.emit({ sessionId: "a", roomId: R, status: "idle", drivers: [] });
    expect(ends).toEqual(["a"]);
  });

  it("matches a repository across laptops by origin, however its URL is spelled", () => {
    const gh = ["https://github.com/Acme/App.git", "git@github.com:acme/app.git", "ssh://git@github.com/acme/app", "https://token:x-oauth@github.com/acme/app/"];
    expect(new Set(gh.map(repoIdentity))).toEqual(new Set(["github.com/acme/app"]));
    const ado = ["https://acme@dev.azure.com/acme/Backoffice/_git/Api", "git@ssh.dev.azure.com:v3/acme/Backoffice/Api", "https://acme.visualstudio.com/Backoffice/_git/Api"];
    expect(new Set(ado.map(repoIdentity))).toEqual(new Set(["dev.azure.com/acme/backoffice/api"]));
    expect(repoIdentity("git@gitlab.example.com:team/app.git")).toBe(repoIdentity("https://gitlab.example.com/team/app"));
    expect(repoIdentity("/srv/git/app.git/")).toBe("/srv/git/app.git".replace(/\.git$/, ""));
    expect(publicUrl("https://ryan:ghp_secret@github.com/acme/app.git")).toBe("https://github.com/acme/app.git");
    expect(withoutCredentials("fatal: unable to access 'https://ryan:ghp_secret@github.com/acme/app.git/'")).not.toContain("ghp_secret");
  });

  it("refuses a backup record carrying credentials, in its origin URL or its push error", async () => {
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("team") });
    const [ryan] = members;
    const descriptor = { title: "t", agent: "claude", branch: "feature-x", originUrl: "https://github.com/acme/app.git", cwd: "/w", conversationId: null };
    const body = { sessionId: "s1", sha: "a".repeat(40), takenAt: 1, push: { ok: true, at: 1 }, session: descriptor, transcriptBytes: null };
    expect(() => ryan.team.publish(roomId, "session.backup", { ...body, session: { ...descriptor, originUrl: "https://ryan:ghp_secret@github.com/acme/app.git" } } as never)).toThrow(/credentials/);
    expect(() => ryan.team.publish(roomId, "session.backup", { ...body, push: { ok: false, at: 1, error: "fatal: unable to access 'https://ryan:ghp_secret@github.com/acme/app.git/'" } } as never)).toThrow(/credentials/);
    expect(() => ryan.team.publish(roomId, "session.backup", body as never)).not.toThrow();
  });

  it("moves a transcript's working directory, folders inside it too, and drops a line cut short", () => {
    const claude = [{ cwd: "/a/wt", x: 1 }, { cwd: "/a/wt/sub" }, { cwd: "/elsewhere" }].map((l) => JSON.stringify(l)).join("\n") + "\n" + '{"cwd":"/a/wt","cut';
    expect(rebaseTranscript(claude, "claude", ["/a/wt"], "/b/wt")).toBe(['{"cwd":"/b/wt","x":1}', '{"cwd":"/b/wt/sub"}', '{"cwd":"/elsewhere"}', ""].join("\n"));
    const codex = [{ type: "session_meta", payload: { cwd: "/a/wt" } }, { type: "response_item", payload: { cwd: "/a/wt" } }].map((l) => JSON.stringify(l)).join("\n") + "\n";
    const out = rebaseTranscript(codex, "codex", ["/a/wt"], "/b").trim().split("\n").map((l) => JSON.parse(l));
    expect(out.map((l) => l.payload.cwd)).toEqual(["/b", "/a/wt"]);
  });

  it("names Claude's project folder and Codex's date folder as the CLIs do", () => {
    expect(claudeProjectDir("/Users/nick/Code/worktrees/app/feature-x", "/p")).toBe("/p/-Users-nick-Code-worktrees-app-feature-x");
    expect(claudeProjectDir("/Users/nick/my_app.v2", "/p")).toBe("/p/-Users-nick-my-app-v2");
    expect(() => codexRolloutPath("notes.jsonl", "/s")).toThrow(/isn't a Codex rollout/);
  });

  it("puts a take-over on a fresh branch name when the session's branch here has other commits or is checked out", async () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "branch", "feature-x");
    // free and at base: used as it is
    let wt = await worktreeAt(repo, "feature-x", base);
    expect(wt).toMatchObject({ branch: "feature-x", renamedFrom: null });
    // now checked out there: the next take-over gets its own name
    wt = await worktreeAt(repo, "feature-x", base);
    expect(wt).toMatchObject({ branch: "feature-x-takeover", renamedFrom: "feature-x" });
    // a branch with commits the snapshot lacks is never moved
    git(repo, "branch", "mine");
    write(repo, { "m.txt": "m\n" });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "m");
    const ahead = git(repo, "rev-parse", "HEAD");
    git(repo, "branch", "-f", "mine", ahead);
    wt = await worktreeAt(repo, "mine", base);
    expect(wt.branch).toBe("mine-takeover");
    expect(git(repo, "rev-parse", "mine")).toBe(ahead);
    await expect(worktreeAt(repo, "../escape", base)).rejects.toThrow();
  });

  it("words freshness for each case", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    const v = (o: Partial<RoomSessionBackupView>): RoomSessionBackupView => ({
      sessionId: "s1",
      owner: "a".repeat(32),
      session: { title: "t", agent: "claude", branch: "b", originUrl: "u", cwd: "/c", conversationId: null },
      latest: { sha: "1".repeat(40), takenAt: now - 120_000 },
      toOrigin: true,
      push: { ok: true, at: now - 120_000, sha: "1".repeat(40) },
      pushed: { sha: "1".repeat(40), takenAt: now - 120_000, at: now - 120_000 },
      transcriptBytes: null,
      takenOver: null,
      dropped: null,
      roomId: "r".repeat(22),
      ownerName: "Nick",
      ownerOnline: false,
      self: false,
      takenOverByName: null,
      peerCopy: null,
      offlineTakeover: false,
      heldBy: [],
      transcript: null,
      problem: null,
      ...o,
    });
    expect(backupFreshness(v({}), now)).toEqual({ tone: "ok", text: "backed up 2m ago" });
    const failed = { push: { ok: false as const, at: now, error: "no access", sha: "1".repeat(40) }, pushed: null };
    expect(backupFreshness(v(failed), now)).toEqual({ tone: "warn", text: "latest only on Nick's laptop · backup failed: no access" });
    expect(backupFreshness(v({ ...failed, peerCopy: { sha: "1".repeat(40), takenAt: now - 60_000 } }), now).text).toBe("latest copied here 1m ago · backup failed: no access");
    expect(backupFreshness(v({ ...failed, self: true }), now)).toEqual({ tone: "warn", text: "backup failed: no access" });
    const takenOver = { by: "b".repeat(32), at: now - 300_000, newSessionId: "x", snapshot: { sha: "1".repeat(40), takenAt: 0, source: "peer" as const }, conversation: "full" as const };
    expect(backupFreshness(v({ takenOver, takenOverByName: "Ryan" }), now).text).toBe("taken over by Ryan 5m ago");
    expect(backupFreshness(v({ takenOver, takenOverByName: "Ryan", self: true }), now).text).toBe("continued on Ryan's laptop 5m ago");
    // kept peer to peer: where the copies are, never a push
    const p2p = { toOrigin: false, push: { ok: false as const, at: now, error: NOT_PUSHED, sha: "1".repeat(40) }, pushed: null };
    expect(backupFreshness(v({ ...p2p, self: true, heldBy: ["Nick"] }), now)).toEqual({ tone: "ok", text: "copied to Nick 2m ago" });
    expect(backupFreshness(v({ ...p2p, self: true }), now)).toEqual({ tone: "muted", text: "snapshot 2m ago · no teammate has a copy yet" });
    expect(backupFreshness(v({ ...p2p, peerCopy: { sha: "1".repeat(40), takenAt: now - 120_000 } }), now)).toEqual({ tone: "ok", text: "copied here 2m ago" });
    expect(backupFreshness(v({ ...p2p, peerCopy: { sha: "0".repeat(40), takenAt: now - 3_600_000 } }), now)).toEqual({ tone: "warn", text: "copied here 1h ago · newer on Nick's laptop" });
    expect(backupFreshness(v(p2p), now)).toEqual({ tone: "warn", text: "no copy here · only on Nick's laptop" });
  });
});
