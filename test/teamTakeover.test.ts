import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { git, makeRepo, tempDir, write } from "./helpers";
import { loopbackRoom, until, type LoopbackMember } from "../src/main/team/loopback";
import { liveRoomHost, TakeoverService, TRANSCRIPT_CHUNK } from "../src/main/team/takeover";
import { TurnFeed } from "../src/main/team/roomSessions";
import { agentFor } from "../src/main/agents";
import { claudeProjectDir, codexRolloutPath, realpathOr } from "../src/main/agentFiles";
import { publicUrl, repoIdentity, withoutCredentials } from "../src/main/git";
import { rebaseTranscript } from "../src/main/transcripts";
import { worktreeAt } from "../src/main/worktrees";
import { backupFreshness, roomBackupRef, type RoomSessionBackupView } from "../src/shared/team/takeover";
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
function takeover(m: LoopbackMember, roomId: string, o: { repos: string[]; sessions?: SessionInfo[]; now?: () => number }) {
  const sessions = new Map((o.sessions ?? []).map((s) => [s.id, s]));
  const turnEnds = new Set<(id: string) => void>();
  const launched: NewSessionRequest[] = [];
  const takenOver: string[] = [];
  const logs: string[] = [];
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
    },
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
    claudeProjects,
    codexSessions,
  });
  return { svc, sessions, launched, takenOver, logs, claudeProjects, codexSessions, turnEnd: (id: string) => turnEnds.forEach((cb) => cb(id)) };
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
      if (e.name === ".git" || rel.endsWith(".log") || e.name === ".env" || e.name.endsWith(".pem")) continue;
      if (e.isDirectory()) walk(p);
      else out[rel] = fs.readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

async function setup(names = ["Ryan", "Nick"], o: { nickHasClone?: boolean; ryanNow?: () => number } = {}) {
  const r = repos();
  const { members, roomId, net } = await loopbackRoom(names, { dir: tempDir("team") });
  const [ryanM, nickM, samM] = members;
  const ryan = takeover(ryanM, roomId, { repos: [r.ryanClone], sessions: [session({ id: "s1", cwd: r.wt, repoPath: r.ryanClone })], now: o.ryanNow });
  const nick = takeover(nickM, roomId, { repos: o.nickHasClone === false ? [] : [r.nickClone] });
  const sam = samM ? takeover(samM, roomId, { repos: [] }) : null;
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
    const runs = [t.ryan.svc.turnEnded("s1"), t.ryan.svc.turnEnded("s1"), t.ryan.svc.turnEnded("s1")];
    await Promise.all(runs);
    const backups = t.ryanM.team.room(t.roomId)!.events;
    expect(backupIn(t.ryanM, t.roomId)!.push.ok).toBe(true);
    // created, Nick added, then two backups at most: the first, and one for everything that ended while it ran
    expect(backups).toBeLessThanOrEqual(4);
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
    expect(meta).toMatchObject({ agent: "claude", conversationId: CONV, file: `${CONV}.jsonl`, ownerCwd: t.wt, from: t.ryanM.id });
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
  it("continues the session on the teammate's laptop with the owner offline: the work exactly, the conversation resumed", async () => {
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

    // the conversation where Claude resumes it in the new worktree, its working directory moved
    const placed = path.join(claudeProjectDir(realpathOr(r.cwd), t.nick.claudeProjects), `${CONV}.jsonl`);
    const lines = fs.readFileSync(placed, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.cwd)).toEqual([realpathOr(r.cwd), realpathOr(r.cwd)]);
    expect(lines[0].message.content).toBe("Add the donor entity");

    // the session: resumed under Nick's account, in the worktree, in the room's group
    expect(t.nick.launched).toEqual([
      { repoPath: t.nickClone, cwd: r.cwd, branchName: "feature-x", useWorktree: false, agent: "claude", title: "Donor entities", taskGroup: "5110", resumeSessionId: CONV },
    ]);
    const args = agentFor("claude").launchArgs(t.nick.launched[0], {});
    expect(args.slice(0, 2)).toEqual(["--resume", CONV]);

    // the room records it; Ryan sees it when he's back, and his copy stops backing up
    expect(backupIn(t.nickM, t.roomId)!.takenOver).toMatchObject({ by: t.nickM.id, newSessionId: "new1", conversation: "full", snapshot: { sha: plan.snapshot!.sha } });
    t.net.setOnline(t.ryanM.id, true);
    await until(() => !!backupIn(t.ryanM, t.roomId)?.takenOver, "Ryan to hear of the take-over");
    await until(() => t.ryan.takenOver.length === 1, "Ryan to be told");
    expect(t.ryan.takenOver).toEqual(["s1 by Nick"]);
    const mine = t.ryan.svc.view().sessions.find((s) => s.sessionId === "s1")!;
    expect(backupFreshness(mine).text).toMatch(/^taken over by Nick/);
    const ref = refIn(t.bare, roomBackupRef(t.roomId, "s1"));
    const events = t.ryanM.team.room(t.roomId)!.events;
    write(t.wt, { "src/a.ts": "Ryan keeps typing\n" });
    await t.ryan.svc.turnEnded("s1");
    expect(t.ryanM.team.room(t.roomId)!.events).toBe(events);
    expect(refIn(t.bare, roomBackupRef(t.roomId, "s1"))).toBe(ref);
    await expect(t.nick.svc.takeOver(t.roomId, "s1")).rejects.toThrow(/already took that session over/);
  });

  it("uses the newest snapshot: the peer copy when origin's push failed, origin's when it's newer", async () => {
    const t = await setup();
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
    // then a turn pushed to origin that never reached Nick
    rejectPushes(t.bare, false);
    t.net.setOnline(t.nickM.id, false);
    await until(() => t.ryanM.team.presence(t.roomId).length === 0, "Nick to drop");
    write(t.wt, { "src/a.ts": "turn 3\n" });
    await t.ryan.svc.turnEnded("s1");
    const third = backupIn(t.ryanM, t.roomId)!.latest.sha;
    plan = await t.nick.svc.plan(t.roomId, "s1");
    expect(plan.snapshot).toMatchObject({ source: "origin", sha: third });
    expect(plan.other).toMatchObject({ source: "peer" });
    expect(plan.latestMissing).toBe(false); // origin had turn 3 before the room told Nick of it
    const r = await t.nick.svc.takeOver(t.roomId, "s1");
    expect(fs.readFileSync(path.join(r.cwd, "src/a.ts"), "utf8")).toBe("turn 3\n");
  });

  it("resumes from the handoff digest when the conversation's end never arrived, and says so", async () => {
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
    expect(req.initialPrompt).toMatch(/Only part of that session's conversation reached this laptop/);
    expect(req.initialPrompt).toContain("USER: Add the donor entity");
    expect(req.initialPrompt).toMatch(/First tell Nick in one line that you're working from a partial conversation/);
    expect(req.initialPrompt).toContain("Branch: feature-x");
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
    expect(t.nick.launched[0].initialPrompt).toMatch(/conversation didn't reach this laptop, so you're starting without it/);
    expect(files(r.cwd)).toEqual(files(t.wt));
  });

  it("takes over a Codex session: the rollout in its date folder, its working directory moved, resumed by id", async () => {
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
    const r = await t.nick.svc.takeOver(t.roomId, "s1");
    expect(r.conversation).toBe("full");
    const placed = codexRolloutPath(name, t.nick.codexSessions);
    expect(placed).toBe(path.join(t.nick.codexSessions, "2026", "10", "07", name));
    const lines = fs.readFileSync(placed, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].payload.cwd).toBe(realpathOr(r.cwd));
    expect(lines[1].payload.cwd).toBe(realpathOr(r.cwd));
    expect(t.nick.launched[0]).toMatchObject({ agent: "codex", resumeSessionId: CODEX_CONV });
    expect(agentFor("codex").launchArgs(t.nick.launched[0], {}).slice(0, 2)).toEqual(["resume", CODEX_CONV]);
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

describe("take-over pieces", () => {
  it("takes room sessions and their turn ends from the live panes", () => {
    const R = "R".repeat(22);
    const s = (id: string, taskGroup: string | null) => session({ id, cwd: "/w", repoPath: "/r", taskGroup });
    const feed = new TurnFeed();
    // what the live panes say, not the group alone: a taken-over session has left the room
    const live = { roomOfSession: (id: string) => (id === "a" ? R : null), onTurnEnded: (cb: Parameters<TurnFeed["on"]>[0]) => feed.on(cb) };
    const host = liveRoomHost(live, { sessions: () => [s("a", "5110"), s("b", "5110/api"), s("c", "5102")], rooms: () => [{ id: R, groupKey: "5110" }] });
    expect(["a", "b", "c", "gone"].map((id) => host.roomOf(id))).toEqual([R, null, null, null]);
    expect(host.groupOf(R)).toBe("5110");
    expect(host.session("b")?.taskGroup).toBe("5110/api");
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
      transcript: null,
      problem: null,
      ...o,
    });
    expect(backupFreshness(v({}), now)).toEqual({ tone: "ok", text: "backed up 2m ago" });
    const failed = { push: { ok: false as const, at: now, error: "no access", sha: "1".repeat(40) }, pushed: null };
    expect(backupFreshness(v(failed), now)).toEqual({ tone: "warn", text: "latest only on Nick's laptop · backup failed: no access" });
    expect(backupFreshness(v({ ...failed, peerCopy: { sha: "1".repeat(40), takenAt: now - 60_000 } }), now).text).toBe("latest copied here 1m ago · backup failed: no access");
    expect(backupFreshness(v({ ...failed, self: true }), now)).toEqual({ tone: "warn", text: "backup failed: no access" });
    expect(backupFreshness(v({ takenOver: { by: "b".repeat(32), at: now - 300_000, newSessionId: "x", snapshot: { sha: "1".repeat(40), takenAt: 0, source: "peer" }, conversation: "full" }, takenOverByName: "Ryan" }), now).text).toBe(
      "taken over by Ryan 5m ago"
    );
  });
});
