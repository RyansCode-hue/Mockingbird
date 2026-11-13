import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { loadIdentity, randomToken, roomIdFor, type Identity } from "../src/main/team/identity";
import { eventIdOf, eventPayload, legacyAdmin, RoomLog, roomOwner } from "../src/main/team/rooms";
import { TeamChat } from "../src/main/team/chat";
import "../src/main/team/roomSessions";
import { LoopbackNetwork, loopbackMember, loopbackRoom, until } from "../src/main/team/loopback";
import { TeamService, workerProblem, type RoomCleanup } from "../src/main/team/service";
import { LivePanes } from "../src/main/team/livePanes";
import type { SessionManager } from "../src/main/sessions";
import { SignalingClient, OLD_WORKER_REVOKE } from "../src/main/team/signalingClient";
import { startLocalSignaling } from "../signaling/src/local/server";
import { signalingJoinKey, signalingTokenHash } from "../src/main/team/identity";
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/types";
import type { RoomEvent, RoomState, TeamStatus } from "../src/shared/team/types";

const newId = (name: string) => loadIdentity(path.join(tempDir(name), "team"));

/** A room created by `creator`, in a log under a fresh folder. */
function newRoom(creator: Identity) {
  const salt = randomToken();
  const roomId = roomIdFor(creator.publicKey, salt);
  const log = new RoomLog(roomId, path.join(tempDir("room"), roomId));
  log.create(creator, "room.created", { name: "#5110 Donor entities", groupKey: "5110", publicKey: creator.publicKey, creatorName: "Ryan", salt });
  return { log, roomId, salt };
}

/** An event signed by `author` without adding it anywhere (for delivering in any order). */
function signed(author: Identity, roomId: string, type: string, body: unknown, lamport: number, at = 1000): RoomEvent {
  const u = { roomId, type, body, author: author.id, lamport, at };
  const payload = eventPayload(u);
  return { ...u, id: eventIdOf(payload), sig: author.sign(payload) } as RoomEvent;
}

const add = (log: RoomLog, by: Identity, who: Identity, name: string) => log.create(by, "member.added", { id: who.id, name, publicKey: who.publicKey });
const names = (s: RoomState | null | undefined) => s?.members.map((m) => m.name);

describe("who's in a room: leaving and removal in the room log", () => {
  it("Mockingbirds from before roles take the creator for the admin while a member, else the longest-standing member", () => {
    const m = (id: string) => ({ id });
    expect(legacyAdmin({ creator: "c", members: [m("c"), m("a"), m("b")] as any })).toBe("c");
    expect(legacyAdmin({ creator: "c", members: [m("a"), m("b")] as any })).toBe("a");
    expect(legacyAdmin({ creator: "c", members: [] })).toBeNull();
  });

  it("anyone may leave; a member who isn't the owner or an admin removes nobody else", () => {
    const [ryan, nick, sam] = [newId("ryan"), newId("nick"), newId("sam")];
    const { log } = newRoom(ryan);
    add(log, ryan, nick, "Nick");
    add(log, ryan, sam, "Sam");
    // Nick isn't the admin: his removal of Sam is kept in the log and changes nothing
    log.create(nick, "member.removed", { member: sam.id, reason: "removed" });
    expect(names(log.state)).toEqual(["Ryan", "Nick", "Sam"]);
    // a "left" for someone else is malformed
    expect(() => log.create(ryan, "member.removed", { member: sam.id, reason: "left" })).toThrow(/only the member themselves can leave/);
    log.create(nick, "member.removed", { member: nick.id, reason: "left" });
    expect(names(log.state)).toEqual(["Ryan", "Sam"]);
    expect(log.state!.former).toMatchObject([{ id: nick.id, name: "Nick", removedBy: null }]);
    log.create(ryan, "member.removed", { member: sam.id, reason: "removed" });
    expect(names(log.state)).toEqual(["Ryan"]);
    expect(log.state!.former!.map((f) => [f.name, f.removedBy])).toEqual([
      ["Nick", null],
      ["Sam", ryan.id],
    ]);
    expect(log.wasMember(sam.id)).toBe(true);
    expect(log.isMember(sam.id)).toBe(false);
  });

  it("once the creator has left (from an older Mockingbird), the longest-standing member owns the room", () => {
    const [ryan, nick, sam] = [newId("ryan"), newId("nick"), newId("sam")];
    const { log } = newRoom(ryan);
    add(log, ryan, nick, "Nick");
    add(log, nick, sam, "Sam"); // a room from before joins needed accepting: any member's add counts
    log.create(sam, "member.removed", { member: nick.id }); // not the admin: nothing
    expect(roomOwner(log.state!)).toBe(ryan.id);
    log.create(ryan, "member.removed", { member: ryan.id, reason: "left" });
    expect(roomOwner(log.state!)).toBe(nick.id);
    log.create(nick, "member.removed", { member: sam.id, reason: "removed" });
    expect(names(log.state)).toEqual(["Nick"]);
  });

  it("a removed member's later events change nothing, their earlier ones still count — whatever order they arrive in", () => {
    const [ryan, nick, mallory] = [newId("ryan"), newId("nick"), newId("mallory")];
    const { log: first, roomId } = newRoom(ryan);
    const created = first.all()[0];
    const events = [
      signed(ryan, roomId, "member.added", { id: nick.id, name: "Nick", publicKey: nick.publicKey }, 2),
      signed(nick, roomId, "member.renamed", { name: "Nicholas" }, 3), // before his removal
      signed(ryan, roomId, "member.removed", { member: nick.id, reason: "removed" }, 4),
      signed(nick, roomId, "member.renamed", { name: "N" }, 5), // after: written while he hadn't heard yet
      signed(nick, roomId, "member.added", { id: mallory.id, name: "Mallory", publicKey: mallory.publicKey }, 6),
      signed(nick, roomId, "chat.message", { text: "still here?", mentions: [] }, 7),
    ];
    const orders = [events, [...events].reverse(), [events[2], events[4], events[0], events[5], events[1], events[3]]];
    const states = orders.map((order) => {
      const log = new RoomLog(roomId, path.join(tempDir("copy"), roomId));
      log.add(created);
      for (const e of order) log.add(e);
      for (const e of events) expect(log.has(e.id)).toBe(true); // kept (and passed on), whether it counts or not
      return log.state!;
    });
    for (const s of states) {
      expect(names(s)).toEqual(["Ryan"]);
      expect(s.former).toMatchObject([{ id: nick.id, name: "Nicholas", removedBy: ryan.id }]);
      expect(s.ext.chat?.entries.filter((e) => e.kind === "message")).toEqual([]);
      expect(s.ext.chat?.entries.filter((e) => e.kind === "member" && e.change === "removed")).toMatchObject([{ author: ryan.id, member: nick.id, change: "removed" }]);
    }
    expect(JSON.stringify(states[1])).toBe(JSON.stringify(states[0]));
    expect(JSON.stringify(states[2])).toBe(JSON.stringify(states[0]));
  });

  it("a new invite brings a removed member back, as the newest member", () => {
    const [ryan, nick, sam] = [newId("ryan"), newId("nick"), newId("sam")];
    const { log } = newRoom(ryan);
    add(log, ryan, nick, "Nick");
    add(log, ryan, sam, "Sam");
    log.create(ryan, "member.removed", { member: nick.id });
    log.create(nick, "member.renamed", { name: "ignored" }); // a former member's key still signs; it just doesn't count
    add(log, sam, nick, "Nick again");
    expect(names(log.state)).toEqual(["Ryan", "Sam", "Nick again"]);
    expect(log.state!.former).toEqual([]);
    log.create(nick, "member.renamed", { name: "Nick" });
    expect(names(log.state)).toEqual(["Ryan", "Sam", "Nick"]);
    expect(roomOwner(log.state!)).toBe(ryan.id);
  });

  it("the member's room sessions leave the room with them", () => {
    const [ryan, nick] = [newId("ryan"), newId("nick")];
    const { log } = newRoom(ryan);
    add(log, ryan, nick, "Nick");
    const rec = { id: "s1", title: "donors", agent: "claude", status: "idle", waitingReason: null, waitingSince: null, branch: null, repo: null, repoName: null, ticketId: null, ticketTitle: null, sub: null, model: null, createdAt: 1, live: true, cols: 80, rows: 24, guards: { secrets: true, coauthors: true }, git: null };
    log.create(nick, "session.upsert", rec as any);
    log.create(ryan, "session.upsert", { ...rec, id: "r1" } as any);
    expect(Object.keys(log.state!.ext.sessions!)).toHaveLength(2);
    log.create(ryan, "member.removed", { member: nick.id });
    expect(Object.values(log.state!.ext.sessions!).map((s) => s.owner)).toEqual([ryan.id]);
  });
});

describe("leaving and removal between Mockingbirds", () => {
  it("the admin removes a connected member: everyone drops them, their Mockingbird hears it, the Worker cuts them off", async () => {
    const { members, roomId, net } = await loopbackRoom(["Ryan", "Nick", "Sam"], { dir: tempDir("team") });
    const [ryan, nick, sam] = members;
    const left: { roomId: string; by: string | null }[] = [];
    nick.team.onLeft((id, info) => {
      left.push({ roomId: id, by: info.by });
      nick.team.forget(id); // as the app does, once its stages forgot the room
    });
    const r = await ryan.team.removeMember(roomId, nick.id);
    expect(r).toMatchObject({ delivered: true, revoke: { ok: true }, already: false });
    expect(nick.team.room(roomId)).toBeUndefined();
    await until(() => left.length === 1, "Nick's Mockingbird to hear it");
    expect(left).toEqual([{ roomId, by: ryan.id }]);
    await until(() => names(sam.team.room(roomId))?.length === 2, "Sam to drop Nick");
    expect(names(sam.team.room(roomId))).toEqual(["Ryan", "Sam"]);
    expect(net.revokes).toEqual([{ roomId, by: ryan.id, member: nick.id }]);
    expect(net.isRevoked(roomId, nick.id)).toBe(true);
    // nothing else connects them, so their links go; Nick can't act in the room any more
    await until(() => !net.isLinked(ryan.id, nick.id) && !net.isLinked(sam.id, nick.id), "Nick's links to go");
    expect(() => nick.team.publish(roomId, "member.renamed", { name: "x" })).toThrow(/not a member/);
    expect(ryan.team.status().rooms[0]).toMatchObject({ admin: ryan.id, creator: ryan.id, former: [{ id: nick.id, name: "Nick" }] });
  });

  it("only the admin can remove members, and nothing changes when someone else tries", async () => {
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick", "Sam"], { dir: tempDir("team") });
    const [ryan, nick, sam] = members;
    await expect(nick.team.removeMember(roomId, sam.id)).rejects.toThrow(/Only the room's owner or an admin removes members: Ryan owns/);
    await expect(ryan.team.removeMember(roomId, ryan.id)).rejects.toThrow(/Leave room/);
    expect(names(ryan.team.room(roomId))).toEqual(["Ryan", "Nick", "Sam"]);
  });

  it("a member who leaves tells whoever's online and is cut off at the Worker; the room goes from their Mac once forgotten", async () => {
    const { members, roomId, net } = await loopbackRoom(["Ryan", "Nick", "Sam"], { dir: tempDir("team") });
    const [ryan, nick, sam] = members;
    const left: string[] = [];
    nick.team.onLeft((id) => left.push(id)); // not for a leave this install made itself
    const r = await nick.team.leave(roomId);
    expect(r.told.sort()).toEqual([ryan.id, sam.id].sort());
    expect(r.missed).toEqual([]);
    expect(r.revoke).toEqual({ ok: true });
    expect(names(ryan.team.room(roomId))).toEqual(["Ryan", "Sam"]);
    expect(ryan.team.room(roomId)!.former).toMatchObject([{ id: nick.id, removedBy: null }]);
    // Nick cut himself off; Ryan, the admin, keeps former members cut off too (in case Nick's didn't get through)
    expect(net.revokes).toContainEqual({ roomId, by: nick.id, member: nick.id });
    expect(net.isRevoked(roomId, nick.id)).toBe(true);
    expect(fs.existsSync(path.join(nick.store.dir, roomId))).toBe(true);
    nick.team.forget(roomId);
    expect(fs.existsSync(path.join(nick.store.dir, roomId))).toBe(false);
    expect(nick.team.status().rooms).toEqual([]);
    expect(left).toEqual([]);
    // the chat says so on the others' Macs
    await until(() => !!sam.team.room(roomId)?.ext.chat?.entries.some((e) => e.kind === "member"), "Sam's chat to say Nick left");
    expect(sam.team.room(roomId)!.ext.chat!.entries.at(-1)).toMatchObject({ kind: "member", author: nick.id, member: nick.id, change: "left" });
  });

  it("a member removed while offline hears of it from the Worker when they're back", async () => {
    const { members, roomId, net } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("team") });
    const [ryan, nick] = members;
    const left: (string | null)[] = [];
    nick.team.onLeft((_id, info) => left.push(info.by));
    net.setOnline(nick.id, false);
    const r = await ryan.team.removeMember(roomId, nick.id);
    expect(r).toMatchObject({ delivered: false, revoke: { ok: true } });
    expect(nick.team.room(roomId)).toBeDefined(); // hasn't heard yet
    net.setOnline(nick.id, true);
    await until(() => left.length === 1, "Nick to hear of his removal from the Worker");
    expect(left).toEqual([ryan.id]);
    expect(nick.team.room(roomId)).toBeUndefined();
    expect(nick.team.status().rooms).toEqual([]);
  });

  it("with a Worker from before revoke, the removal still applies peer to peer, says to update the Worker, and is made there once it is", async () => {
    const net = new LoopbackNetwork();
    net.workerRevoke = false;
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("team"), net });
    const [ryan, nick] = members;
    // a second room, so Nick can still be reached after he's removed from the first while offline
    const second = ryan.team.createRoom({ name: "#5120", groupKey: "5120", signalingUrl: "http://loopback.invalid" });
    nick.team.join(ryan.team.createInvite(second.id));
    await until(() => !!nick.team.room(second.id), "Nick to join the second room");
    net.setOnline(nick.id, false);
    const r = await ryan.team.removeMember(roomId, nick.id);
    expect(r.revoke).toMatchObject({ ok: false, reason: "unsupported" });
    expect(workerProblem(r.revoke, "Nick")).toMatch(/Update your signaling Worker \(cd signaling && npx wrangler deploy\) to also cut them off at the Worker/);
    expect(names(ryan.team.room(roomId))).toEqual(["Ryan"]);
    // the Worker can't tell him: Ryan does, over the room they still share
    net.setOnline(nick.id, true);
    await until(() => !nick.team.room(roomId), "Nick to hear of it from Ryan");
    expect(nick.team.room(second.id)).toBeDefined();
    expect(ryan.logs.some((l) => /still lists .* no longer in: telling them/.test(l))).toBe(true);
    // the Worker is updated: the admin's next connection cuts Nick off there
    expect(net.isRevoked(roomId, nick.id)).toBe(false);
    net.workerRevoke = true;
    ryan.team.wake();
    expect(net.isRevoked(roomId, nick.id)).toBe(true);
    expect(net.revokes).toEqual([{ roomId, by: ryan.id, member: nick.id }]);
  });

  it("a removed member comes back with a new invite code", async () => {
    const { members, roomId, net } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("team") });
    const [ryan, nick] = members;
    nick.team.onLeft((id) => nick.team.forget(id));
    await ryan.team.removeMember(roomId, nick.id);
    await until(() => !fs.existsSync(path.join(nick.store.dir, roomId)), "Nick's copy to go");
    nick.team.join(ryan.team.createInvite(roomId));
    await until(() => names(nick.team.room(roomId))?.join() === "Ryan,Nick", "Nick to be back");
    expect(net.isRevoked(roomId, nick.id)).toBe(false);
    expect(ryan.team.room(roomId)!.former).toEqual([]);
    await until(() => ryan.team.presence(roomId).includes(nick.id), "them to connect again");
  });

  it("leaving with nobody else online: they hear it from the Worker when they connect", async () => {
    const { members, roomId, net } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("team") });
    const [ryan, nick] = members;
    net.setOnline(ryan.id, false);
    const r = await nick.team.leave(roomId, { ackMs: 200 });
    expect(r).toMatchObject({ told: [], missed: [ryan.id], revoke: { ok: true } });
    nick.team.forget(roomId);
    net.setOnline(ryan.id, true);
    await until(() => !!ryan.team.room(roomId)?.former?.some((f) => f.id === nick.id), "Ryan to hear Nick left");
    expect(names(ryan.team.room(roomId))).toEqual(["Ryan"]);
  });

  it("the last member leaving deletes the room", async () => {
    const { members, roomId } = await loopbackRoom(["Ryan"], { dir: tempDir("team") });
    const [ryan] = members;
    const r = await ryan.team.leave(roomId);
    expect(r).toMatchObject({ told: [], missed: [] });
    ryan.team.forget(roomId);
    expect(fs.existsSync(path.join(ryan.store.dir, roomId))).toBe(false);
  });

  it("forgetting a room drops a pending join for it, and refuses a room this install is still in", async () => {
    const net = new LoopbackNetwork();
    const dir = tempDir("team");
    const ryan = loopbackMember(net, "Ryan", dir);
    const nick = loopbackMember(net, "Nick", dir);
    const room = ryan.team.createRoom({ name: "#5110", groupKey: "5110", signalingUrl: "http://loopback.invalid" });
    const code = ryan.team.createInvite(room.id);
    expect(() => ryan.team.forget(room.id)).toThrow(/still a member/);
    net.setOnline(ryan.id, false);
    nick.team.join(code);
    expect(nick.team.status().pending).toHaveLength(1);
    nick.team.forget(room.id);
    expect(nick.team.status().pending).toEqual([]);
    expect(nick.store.pendingJoins()).toEqual([]);
  });
});

// ---- the app's team service ------------------------------------------------------------------

/** The app's team service over the loopback, with its room cleanup. */
function service(net: LoopbackNetwork, name: string, o: { cleanup?: RoomCleanup[]; dir?: string } = {}) {
  const dir = o.dir ?? path.join(tempDir(name), "team");
  const settings: Settings = { ...DEFAULT_SETTINGS, teamName: name, signalingUrl: "https://signal.example" };
  const emitted: TeamStatus[] = [];
  const notified: { title: string; body: string }[] = [];
  const logs: string[] = [];
  const s = new TeamService({
    settings: () => settings,
    localGroups: () => [],
    emit: (st) => emitted.push(st),
    log: (ctx, err) => {
      const m = `${ctx}: ${err instanceof Error ? err.message : String(err)}`;
      logs.push(m);
      return err instanceof Error ? err.message : String(err);
    },
    assetsDir: "/nonexistent",
    dir,
    wire: (identity) => net.wire(identity.id),
    cleanup: () => o.cleanup ?? [],
    notify: (title, body) => notified.push({ title, body }),
  });
  s.start();
  return { s, dir, emitted, notified, logs, settings };
}

/** Cleanup parts that record what they're asked to forget; `fail` throws, `problem` reports one. */
function recorder() {
  const calls: { what: string; room: RoomState; groupKey: string | null }[] = [];
  const parts: RoomCleanup[] = [
    { what: "the live panes", roomLeft: (room, groupKey) => (calls.push({ what: "live", room, groupKey }), []) },
    { what: "the plan copies", roomLeft: async (room, groupKey) => (calls.push({ what: "plan", room, groupKey }), ["The plan copy in /wt couldn't be removed: EPERM"]) },
    {
      what: "the room's backups and hidden refs",
      roomLeft: (room, groupKey) => {
        calls.push({ what: "takeover", room, groupKey });
        throw new Error("git exploded");
      },
    },
  ];
  return { calls, parts };
}

/** The room's admin accepts the next request to join, as Accept in its prompt would. */
async function acceptNext(admin: TeamService, roomId: string) {
  const asked = () => admin.status().rooms.find((r) => r.id === roomId)?.requests?.find((q) => q.role === "admin" && q.state === "waiting");
  await until(() => !!asked(), "the admin to be asked");
  return admin.answerJoin(roomId, asked()!.id, true);
}

async function sharedPair(net: LoopbackNetwork, o: { ryan?: RoomCleanup[]; nick?: RoomCleanup[] } = {}) {
  const ryan = service(net, "Ryan", { cleanup: o.ryan });
  const nick = service(net, "Nick", { cleanup: o.nick });
  const { invite, roomId } = await ryan.s.shareGroup("5110", "#5110 Donor entities");
  nick.s.join(invite);
  await acceptNext(ryan.s, roomId);
  await until(() => nick.s.status().rooms.length === 1, "the join");
  await until(() => ryan.s.status().rooms[0]?.online.length === 1, "them to connect");
  return { ryan, nick, roomId };
}

describe("leaving and removing in the app", () => {
  it("Leave room tells the teammate, deletes the room's folder after every stage forgot it, and lists what couldn't be cleaned up", async () => {
    const net = new LoopbackNetwork();
    const rec = recorder();
    const chatDir = tempDir("chat");
    const { ryan, nick, roomId } = await sharedPair(net, { nick: rec.parts });
    // the chat's read marks, one room's to go and another's to stay
    fs.writeFileSync(path.join(chatDir, "chat-read.json"), JSON.stringify({ [roomId]: { a: 1 }, other: { b: 2 } }));
    const chat = new TeamChat({ dir: chatDir, emit: () => {}, notify: () => {}, windowFocused: () => true, log: () => {} });
    rec.parts.push({ what: "the chat's read marks", roomLeft: (room) => chat.roomLeft(room.id) });
    const out = await nick.s.leaveRoom(roomId);
    expect(out).toMatchObject({ roomName: "#5110 Donor entities", told: ["Ryan"], notTold: [], worker: null });
    expect(out.problems).toEqual(["The plan copy in /wt couldn't be removed: EPERM", "The room's backups and hidden refs couldn't be cleaned up: git exploded"]);
    expect(rec.calls.map((c) => c.what)).toEqual(["live", "plan", "takeover"]);
    expect(rec.calls[0].groupKey).toBe("5110");
    expect(rec.calls[0].room.former).toMatchObject([{ name: "Nick", removedBy: null }]);
    expect(JSON.parse(fs.readFileSync(path.join(chatDir, "chat-read.json"), "utf8"))).toEqual({ other: { b: 2 } });
    expect(fs.existsSync(path.join(nick.dir, "rooms", roomId))).toBe(false);
    expect(nick.s.status().rooms).toEqual([]);
    expect(nick.s.status().notices).toMatchObject([{ roomId, kind: "left", problems: out.problems }]);
    nick.s.dismissNotice(nick.s.status().notices![0].id);
    expect(nick.s.status().notices).toEqual([]);
    await until(() => ryan.s.status().rooms[0].members.length === 1, "Ryan to see Nick go");
    expect(ryan.s.status().rooms[0].former).toEqual([{ id: expect.any(String), name: "Nick" }]);
    await expect(nick.s.leaveRoom(roomId)).rejects.toThrow(/not in that room/);
  });

  it("a member the admin removes is told who did it, and the room is deleted on their Mac", async () => {
    const net = new LoopbackNetwork();
    const rec = recorder();
    const { ryan, nick, roomId } = await sharedPair(net, { nick: rec.parts.slice(0, 1) });
    const nickId = nick.s.status().self!.id;
    const out = await ryan.s.removeMember(roomId, nickId);
    expect(out).toEqual({ name: "Nick", delivered: true, worker: null });
    await until(() => !fs.existsSync(path.join(nick.dir, "rooms", roomId)), "Nick's copy to go");
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].groupKey).toBe("5110"); // the group the room was shown as, so its sessions can stop being the room's
    expect(nick.s.status().notices).toMatchObject([{ roomId, kind: "removed", by: "Ryan", problems: [] }]);
    expect(nick.notified).toEqual([{ title: "Ryan removed you from #5110 Donor entities", body: expect.stringMatching(/deleted from this Mac/) }]);
    expect(ryan.s.status().rooms[0]).toMatchObject({ members: [{ name: "Ryan" }], former: [{ name: "Nick" }] });
    // asked again: the Worker only
    const again = await ryan.s.removeMember(roomId, nickId);
    expect(again).toEqual({ name: "Nick", delivered: false, worker: null });
  });

  it("a member the admin removes has the room's sandbox switch dropped on their Mac, as the team status said it, so joining again starts sandboxed", async () => {
    const net = new LoopbackNetwork();
    const parts: RoomCleanup[] = [];
    const { ryan, nick, roomId } = await sharedPair(net, { nick: parts });
    // Nick's live panes, wired as index.ts wires them: the switch through them, their leave cleanup a room cleanup part
    const live = new LivePanes({
      team: () => nick.s.transport,
      rooms: () => nick.s.status().rooms.map((r) => ({ id: r.id, groupKey: r.groupKey })),
      sessions: { list: () => [], resumable: () => [] } as unknown as SessionManager,
      settings: () => nick.settings,
      saveSettings: (patch) => Object.assign(nick.settings, patch),
      notify: () => {},
      toWindow: () => {},
      audit: () => {},
      log: (_c, e) => String(e),
      dir: path.join(tempDir("live"), "live"),
    });
    parts.push({ what: "the room's live panes", roomLeft: (room, groupKey) => live.roomLeft(room, groupKey) });
    expect(nick.s.status().rooms[0].sandboxed).toBe(true);
    live.setRoomSandbox(roomId, false);
    expect(nick.s.status().rooms[0].sandboxed).toBe(false);
    await ryan.s.removeMember(roomId, nick.s.status().self!.id);
    await until(() => !fs.existsSync(path.join(nick.dir, "rooms", roomId)), "Nick's copy to go");
    expect(nick.settings.roomsUnsandboxed).toEqual([]);
    expect(nick.s.status().notices).toMatchObject([{ roomId, kind: "removed", problems: [] }]);
  });

  it("a room left and joined again starts sandboxed, and stays so as another room's sandbox is switched off", async () => {
    const net = new LoopbackNetwork();
    const parts: RoomCleanup[] = [];
    const { ryan, nick, roomId } = await sharedPair(net, { nick: parts });
    const live = new LivePanes({
      team: () => nick.s.transport,
      rooms: () => nick.s.status().rooms.map((r) => ({ id: r.id, groupKey: r.groupKey })),
      sessions: { list: () => [], resumable: () => [] } as unknown as SessionManager,
      settings: () => nick.settings,
      saveSettings: (patch) => Object.assign(nick.settings, patch),
      notify: () => {},
      toWindow: () => {},
      audit: () => {},
      log: (_c, e) => String(e),
      dir: path.join(tempDir("live"), "live"),
    });
    parts.push({ what: "the room's live panes", roomLeft: (room, groupKey) => live.roomLeft(room, groupKey) });
    live.setRoomSandbox(roomId, false);
    await nick.s.leaveRoom(roomId);
    expect(nick.settings.roomsUnsandboxed).toEqual([]);
    nick.s.join(ryan.s.createInvite(roomId));
    await acceptNext(ryan.s, roomId);
    await until(() => nick.s.status().rooms.some((r) => r.id === roomId), "Nick to join again");
    const { roomId: other } = await nick.s.shareGroup("attom", "Attom");
    live.setRoomSandbox(other, false);
    expect(nick.settings.roomsUnsandboxed).toEqual([other]);
    expect(Object.fromEntries(nick.s.status().rooms.map((r) => [r.id, r.sandboxed]))).toEqual({ [roomId]: true, [other]: false });
  });

  it("against a Worker from before revoke, removing says to update it", async () => {
    const net = new LoopbackNetwork();
    net.workerRevoke = false;
    const { ryan, nick, roomId } = await sharedPair(net);
    expect(ryan.s.status().rooms[0].workerRevoke).toBe(false);
    const out = await ryan.s.removeMember(roomId, nick.s.status().self!.id);
    expect(out.delivered).toBe(true);
    expect(out.worker).toMatch(/older .* Update your signaling Worker \(cd signaling && npx wrangler deploy\) to also cut them off at the Worker/);
  });

  it("a leave cut short by quitting is finished on the next start", async () => {
    const net = new LoopbackNetwork();
    const { nick, roomId } = await sharedPair(net);
    await (nick.s.transport as any).leave(roomId); // published and told, then Mockingbird quit before cleaning up
    nick.s.stop();
    expect(fs.existsSync(path.join(nick.dir, "rooms", roomId))).toBe(true);
    const rec = recorder();
    const again = service(net, "Nick", { dir: nick.dir, cleanup: rec.parts.slice(0, 1) });
    expect(again.s.status().rooms).toEqual([]);
    await again.s.finishLeftRooms();
    expect(rec.calls.map((c) => c.what)).toEqual(["live"]);
    expect(fs.existsSync(path.join(nick.dir, "rooms", roomId))).toBe(false);
    expect(again.s.status().notices).toEqual([]); // nothing went wrong this time: no notice
  });
});

// ---- the signaling client against a Worker, old and new -----------------------------------------

describe("revoke from the app's signaling client", () => {
  async function connected(features?: []) {
    const server = await startLocalSignaling({ log: () => undefined, ...(features ? { features } : {}) });
    const ryan = newId("ryan");
    const nick = newId("nick");
    const salt = randomToken();
    const roomId = roomIdFor(ryan.publicKey, salt);
    const events: { who: string; e: any }[] = [];
    const mk = (who: string, identity: Identity, o: { create?: string; join?: string }) =>
      new SignalingClient({ url: server.url, roomId, identity, ...o, onEvent: (e) => events.push({ who, e }), log: () => {}, backoffMs: [50] });
    const r = mk("ryan", ryan, { create: salt });
    r.start();
    await until(() => r.state === "online", "Ryan online");
    const token = randomToken();
    r.send({ t: "invite", tokenHash: signalingTokenHash(token), expiresAt: Date.now() + 3_600_000 });
    await new Promise((res) => setTimeout(res, 50));
    const n = mk("nick", nick, { join: signalingJoinKey(token) });
    n.start();
    await until(() => n.state === "online", "Nick online");
    return { server, ryan, nick, r, n, events, roomId };
  }

  it("cuts a member off and hands them their removal; the app learns the Worker can", async () => {
    const t = await connected();
    try {
      expect(t.r.features?.has("revoke")).toBe(true);
      const event = { type: "member.removed", note: "signed by Ryan's app" };
      expect(await t.r.revoke(t.nick.id, event)).toEqual({ ok: true });
      await until(() => t.n.problemCode === "revoked", "Nick to be refused as removed");
      expect(t.n.problem).toMatch(/removed from the room/);
      expect(t.events.filter((x) => x.who === "nick" && x.e.t === "room-events").map((x) => x.e.events)).toContainEqual([event]);
    } finally {
      t.r.stop();
      t.n.stop();
      await t.server.close();
    }
  });

  it("against a Worker from before revoke: unsupported, saying to update it", async () => {
    const t = await connected([]);
    try {
      expect(t.r.features?.size).toBe(0);
      expect(await t.r.revoke(t.nick.id, null)).toEqual({ ok: false, reason: "unsupported", message: OLD_WORKER_REVOKE });
      expect(OLD_WORKER_REVOKE).toMatch(/cd signaling && npx wrangler deploy/);
      // a Worker that says it can but answers like an old one is read the same way
      t.r.features!.add("revoke");
      expect(await t.r.revoke(t.nick.id, null)).toMatchObject({ ok: false, reason: "unsupported" });
      expect(t.n.state).toBe("online");
    } finally {
      t.r.stop();
      t.n.stop();
      await t.server.close();
    }
  });
});
