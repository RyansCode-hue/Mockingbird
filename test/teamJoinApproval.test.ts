import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { loadIdentity, randomToken, roomIdFor, type Identity } from "../src/main/team/identity";
import { eventIdOf, eventPayload, mayAddMember, RoomLog } from "../src/main/team/rooms";
import "../src/main/team/chat"; // the chat's lines for who joined
import { acceptJoins, LoopbackNetwork, loopbackMember, loopbackRoom, until } from "../src/main/team/loopback";
import { TeamService } from "../src/main/team/service";
import { formatFingerprint } from "../src/shared/team/protocol";
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/types";
import type { JoinRequestSummary, RoomEvent, RoomState } from "../src/shared/team/types";

const newId = (name: string) => loadIdentity(path.join(tempDir(name), "team"));

/** A room created by `creator`: joins need accepting from the start (`approval`), or it's from before that. */
function newRoom(creator: Identity, approval: boolean) {
  const salt = randomToken();
  const roomId = roomIdFor(creator.publicKey, salt);
  const log = new RoomLog(roomId, path.join(tempDir("room"), roomId));
  log.create(creator, "room.created", { name: "#5110 Donor entities", groupKey: "5110", publicKey: creator.publicKey, creatorName: "Ryan", salt, ...(approval ? { approval: true as const } : {}) });
  return { log, roomId };
}

/** An event signed by `author` without adding it anywhere (for delivering in any order). */
function signed(author: Identity, roomId: string, type: string, body: unknown, lamport: number, at = 1000): RoomEvent {
  const u = { roomId, type, body, author: author.id, lamport, at };
  const payload = eventPayload(u);
  return { ...u, id: eventIdOf(payload), sig: author.sign(payload) } as RoomEvent;
}

const added = (who: Identity, name: string) => ({ id: who.id, name, publicKey: who.publicKey });
const names = (s: RoomState | null | undefined) => s?.members.map((m) => m.name);
const joinLines = (s: RoomState | null | undefined) => s?.ext.chat?.entries.filter((e) => e.kind === "member" && (e.change === "accepted" || e.change === "joined")).map((e) => `${e.change}:${e.member}`);

describe("who may add members: the room log", () => {
  it("mayAddMember: once a room needs accepting, only its admin; before that, any member", () => {
    const m = (id: string) => ({ id }) as RoomState["members"][number];
    const room = { creator: "c", members: [m("c"), m("a")] };
    expect(mayAddMember({ ...room, joinApproval: true }, "c")).toBe(true);
    expect(mayAddMember({ ...room, joinApproval: true }, "a")).toBe(false);
    expect(mayAddMember({ ...room, joinApproval: true }, "x")).toBe(false);
    expect(mayAddMember(room, "a")).toBe(true); // a room from before: any member, as then
    expect(mayAddMember(room, "x")).toBe(false);
    // the creator has left: the longest-standing member is the admin
    const without = { creator: "c", members: [m("a"), m("b")], joinApproval: true as const };
    expect(mayAddMember(without, "a")).toBe(true);
    expect(mayAddMember(without, "b")).toBe(false);
  });

  it("in a room created now, only the admin's member.added counts: a member's is kept and changes nothing", () => {
    const [ryan, nick, sam] = [newId("ryan"), newId("nick"), newId("sam")];
    const { log } = newRoom(ryan, true);
    expect(log.state!.joinApproval).toBe(true);
    log.create(ryan, "member.added", { ...added(nick, "Nick"), inviter: ryan.id });
    log.create(nick, "member.added", added(sam, "Sam")); // Nick isn't the admin
    expect(names(log.state)).toEqual(["Ryan", "Nick"]);
    expect(log.all().filter((e) => e.type === "member.added")).toHaveLength(2); // kept, and passed on
    expect(log.state!.members[1]).toMatchObject({ invitedBy: ryan.id, acceptedBy: ryan.id });
    // once Ryan has left, Nick — the longest-standing member — is the admin, and his add counts
    log.create(ryan, "member.removed", { member: ryan.id, reason: "left" });
    log.create(nick, "member.added", { ...added(sam, "Sam"), inviter: nick.id });
    expect(names(log.state)).toEqual(["Nick", "Sam"]);
    expect(log.state!.members[1]).toMatchObject({ acceptedBy: nick.id });
    expect(joinLines(log.state)).toEqual([`accepted:${nick.id}`, `accepted:${sam.id}`]);
  });

  it("a room from before keeps everyone a member added, and needs the admin from its admin's room.approval on — whatever order events arrive in", () => {
    const [ryan, nick, sam, lee, kim, ann] = ["ryan", "nick", "sam", "lee", "kim", "ann"].map(newId);
    const { log: first, roomId } = newRoom(ryan, false);
    const created = first.all()[0];
    expect(first.state!.joinApproval).toBeUndefined();
    const events = [
      signed(ryan, roomId, "member.added", added(nick, "Nick"), 2),
      signed(nick, roomId, "member.added", added(sam, "Sam"), 3), // Nick's code, from before: it counts
      signed(nick, roomId, "room.approval", {}, 4), // not the admin's: no switch
      signed(nick, roomId, "member.added", added(lee, "Lee"), 5), // still from before: counts
      signed(ryan, roomId, "room.approval", {}, 6), // the admin switches the room over
      signed(nick, roomId, "member.added", added(kim, "Kim"), 7), // after it: kept, changes nothing
      signed(ryan, roomId, "member.added", { ...added(ann, "Ann"), inviter: sam.id }, 8), // the admin's: counts
    ];
    const orders = [events, [...events].reverse(), [events[5], events[2], events[6], events[0], events[4], events[3], events[1]]];
    const states = orders.map((order) => {
      const log = new RoomLog(roomId, path.join(tempDir("copy"), roomId));
      log.add(created);
      for (const e of order) log.add(e);
      for (const e of events) expect(log.has(e.id)).toBe(true);
      return log.state!;
    });
    for (const s of states) {
      expect(names(s)).toEqual(["Ryan", "Nick", "Sam", "Lee", "Ann"]);
      expect(s.joinApproval).toBe(true);
      expect(s.members.find((m) => m.name === "Sam")).toMatchObject({ invitedBy: nick.id });
      expect(s.members.find((m) => m.name === "Sam")!.acceptedBy).toBeUndefined();
      expect(s.members.find((m) => m.name === "Ann")).toMatchObject({ invitedBy: sam.id, acceptedBy: ryan.id });
      // the chat: "Nick joined" for the joins from before, "Ryan accepted Ann" after
      expect(joinLines(s)).toEqual([`joined:${nick.id}`, `joined:${sam.id}`, `joined:${lee.id}`, `accepted:${ann.id}`]);
    }
    expect(JSON.stringify(states[1])).toBe(JSON.stringify(states[0]));
    expect(JSON.stringify(states[2])).toBe(JSON.stringify(states[0]));
  });
});

// ---- between Mockingbirds -----------------------------------------------------------------------

/** Ryan's room, with Sam in it (Ryan accepted him), and whoever else is named on the network. */
async function roomWithSam(dir: string, net = new LoopbackNetwork()) {
  const ryan = loopbackMember(net, "Ryan", dir);
  const sam = loopbackMember(net, "Sam", dir);
  const roomId = ryan.team.createRoom({ name: "#5110 Donor entities", groupKey: "5110", signalingUrl: "http://loopback.invalid" }).id;
  const stop = acceptJoins(ryan.team);
  sam.team.join(ryan.team.createInvite(roomId));
  await until(() => !!sam.team.room(roomId) && ryan.team.presence(roomId).includes(sam.id), "Sam in the room");
  stop();
  return { net, ryan, sam, roomId };
}

const requestsOf = (m: { team: { status(): { rooms: { id: string; requests?: JoinRequestSummary[] }[] } } }, roomId: string) => m.team.status().rooms.find((r) => r.id === roomId)?.requests ?? [];

describe("joining: the room's admin accepts or declines", () => {
  it("the inviter is the admin: the joiner waits — given nothing of the room — until Accept, and everyone hears it", async () => {
    const dir = tempDir("join");
    const { net, ryan, sam, roomId } = await roomWithSam(dir);
    const asked: JoinRequestSummary[] = [];
    ryan.team.onJoinRequest((r) => asked.push(r));
    const nick = loopbackMember(net, "Nick", dir);
    nick.team.join(ryan.team.createInvite(roomId));
    await until(() => nick.team.status().pending[0]?.state === "approval", "Nick to wait for Ryan");
    expect(nick.team.status().pending[0]).toMatchObject({ roomId, admin: "Ryan", name: "#5110 Donor entities" });
    expect(asked).toEqual([expect.objectContaining({ roomId, role: "admin", state: "waiting", id: nick.id, name: "Nick", fingerprint: formatFingerprint(nick.id), inviter: ryan.id, inviterName: "Ryan" })]);
    expect(requestsOf(ryan, roomId)).toEqual(asked);
    // nothing of the room reaches Nick while he waits
    await new Promise((r) => setTimeout(r, 30));
    expect(nick.team.room(roomId)).toBeUndefined();
    expect(nick.store.get(roomId)).toBeUndefined();
    expect(net.isLinked(ryan.id, nick.id) || net.isLinked(sam.id, nick.id)).toBe(false);
    // only the admin answers
    await expect(sam.team.answerJoin(roomId, nick.id, true)).rejects.toThrow(/Only the room's owner or an admin \(Ryan\)/);
    expect(await ryan.team.answerJoin(roomId, nick.id, true)).toEqual({ name: "Nick", accepted: true, worker: null });
    await until(() => !!nick.team.room(roomId) && ryan.team.presence(roomId).includes(nick.id) && sam.team.room(roomId)?.members.length === 3, "Nick in, everyone knowing");
    for (const m of [ryan, sam, nick]) expect(m.team.room(roomId)!.ext.chat!.entries.at(-1)).toMatchObject({ kind: "member", change: "accepted", author: ryan.id, member: nick.id });
    expect(nick.team.room(roomId)!.members[2]).toMatchObject({ name: "Nick", invitedBy: ryan.id, acceptedBy: ryan.id });
    expect(requestsOf(ryan, roomId)).toEqual([]);
    expect(nick.team.status().pending).toEqual([]);
  });

  it("decline: the joiner is told, gets nothing of the room, is dropped at the door, and its code is used up", async () => {
    const dir = tempDir("join");
    const { net, ryan, roomId } = await roomWithSam(dir);
    const nick = loopbackMember(net, "Nick", dir);
    const code = ryan.team.createInvite(roomId);
    nick.team.join(code);
    await until(() => requestsOf(ryan, roomId).length === 1 && nick.team.status().pending[0]?.state === "approval", "Ryan to be asked");
    expect(await ryan.team.answerJoin(roomId, nick.id, false)).toEqual({ name: "Nick", accepted: false, worker: { ok: true } });
    expect(net.denied).toEqual([{ roomId, by: ryan.id, member: nick.id }]);
    await until(() => nick.team.status().pending[0]?.state === "declined", "Nick to hear");
    expect(nick.team.status().pending[0].reason).toBe("Ryan declined your request to join #5110 Donor entities");
    expect(nick.team.room(roomId)).toBeUndefined();
    expect(nick.store.get(roomId)).toBeUndefined();
    expect(ryan.team.room(roomId)!.members.map((m) => m.name)).toEqual(["Ryan", "Sam"]);
    expect(requestsOf(ryan, roomId)).toEqual([]);
    await expect(ryan.team.answerJoin(roomId, nick.id, true)).rejects.toThrow(/Nobody with that key is asking/);
    // the same code again: still declined
    nick.team.join(code);
    await until(() => nick.team.status().pending[0]?.state === "declined", "Nick declined again");
    expect(requestsOf(ryan, roomId)).toEqual([]);
    // a new code asks again
    nick.team.join(ryan.team.createInvite(roomId));
    await until(() => requestsOf(ryan, roomId).length === 1, "a new request");
    expect(nick.store.get(roomId)).toBeUndefined();
    expect(net.isLinked(ryan.id, nick.id)).toBe(false);
  });

  it("the inviter isn't the admin: it passes the request on to the admin, and tells the joiner once the admin accepts", async () => {
    const dir = tempDir("join");
    const { net, ryan, sam, roomId } = await roomWithSam(dir);
    const lee = loopbackMember(net, "Lee", dir);
    lee.team.join(sam.team.createInvite(roomId));
    await until(() => lee.team.status().pending[0]?.state === "approval" && requestsOf(ryan, roomId).length === 1, "Lee's request to reach Ryan");
    expect(lee.team.status().pending[0]).toMatchObject({ admin: "Ryan" });
    expect(requestsOf(ryan, roomId)).toEqual([expect.objectContaining({ role: "admin", id: lee.id, name: "Lee", inviter: sam.id, inviterName: "Sam" })]);
    await until(() => requestsOf(sam, roomId)[0]?.state === "waiting", "Sam to see Ryan has it");
    expect(requestsOf(sam, roomId)).toEqual([expect.objectContaining({ role: "inviter", id: lee.id, adminName: "Ryan", state: "waiting" })]);
    // Sam can't let Lee in himself
    await expect(sam.team.answerJoin(roomId, lee.id, true)).rejects.toThrow(/Only the room's owner or an admin/);
    await ryan.team.answerJoin(roomId, lee.id, true);
    await until(() => !!lee.team.room(roomId) && lee.team.presence(roomId).length === 2, "Lee in, connected to both");
    expect(lee.team.room(roomId)!.members.find((m) => m.id === lee.id)).toMatchObject({ invitedBy: sam.id, acceptedBy: ryan.id });
    await until(() => requestsOf(sam, roomId)[0]?.state === "accepted", "Sam to see it accepted");
    expect(sam.team.room(roomId)!.ext.chat!.entries.at(-1)).toMatchObject({ change: "accepted", author: ryan.id, member: lee.id });
  });

  it("the admin offline: the request waits with the inviter, reaches the admin when it's back, and the answer reaches the joiner through the inviter", async () => {
    const dir = tempDir("join");
    const { net, ryan, sam, roomId } = await roomWithSam(dir);
    net.setOnline(ryan.id, false);
    const lee = loopbackMember(net, "Lee", dir);
    lee.team.join(sam.team.createInvite(roomId));
    await until(() => lee.team.status().pending[0]?.state === "approval" && requestsOf(sam, roomId)[0]?.state === "forwarding", "Sam to hold Lee's request");
    expect(requestsOf(ryan, roomId)).toEqual([]);
    net.setOnline(ryan.id, true);
    await until(() => requestsOf(ryan, roomId).length === 1 && requestsOf(sam, roomId)[0]?.state === "waiting", "the request to reach Ryan");
    // Sam is away when Ryan accepts: Lee hears it when Sam is back
    net.setOnline(sam.id, false);
    await ryan.team.answerJoin(roomId, lee.id, true);
    await new Promise((r) => setTimeout(r, 30));
    expect(lee.team.room(roomId)).toBeUndefined();
    expect(lee.team.status().pending[0].state).toBe("approval");
    net.setOnline(sam.id, true);
    await until(() => !!lee.team.room(roomId) && lee.team.room(roomId)!.members.length === 3, "Lee in once Sam's back");
  });

  it("a code that let someone in can't again: removed, they need a new one", async () => {
    const dir = tempDir("join");
    const { net, ryan, roomId } = await roomWithSam(dir);
    const nick = loopbackMember(net, "Nick", dir);
    nick.team.onLeft((id) => nick.team.forget(id));
    const code = ryan.team.createInvite(roomId);
    nick.team.join(code);
    await until(() => requestsOf(ryan, roomId).length === 1, "Ryan to be asked");
    await ryan.team.answerJoin(roomId, nick.id, true);
    await until(() => !!nick.team.room(roomId), "Nick in");
    await ryan.team.removeMember(roomId, nick.id);
    await until(() => !nick.store.get(roomId), "Nick's copy to go");
    nick.team.join(code);
    await until(() => nick.team.status().pending[0]?.state === "rejected", "the old code refused");
    expect(nick.team.status().pending[0].reason).toMatch(/already used/);
    expect(requestsOf(ryan, roomId)).toEqual([]);
  });

  it("a request expires with its code: the admin can't accept it, and the joiner is told", async () => {
    const dir = tempDir("join");
    const net = new LoopbackNetwork();
    let now = Date.now();
    const ryan = loopbackMember(net, "Ryan", dir, { now: () => now });
    const nick = loopbackMember(net, "Nick", dir, { now: () => now });
    const roomId = ryan.team.createRoom({ name: "#5110", groupKey: "5110", signalingUrl: "http://loopback.invalid" }).id;
    nick.team.join(ryan.team.createInvite(roomId));
    await until(() => nick.team.status().pending[0]?.state === "approval" && requestsOf(ryan, roomId).length === 1, "the request");
    expect(requestsOf(ryan, roomId)[0].expiresAt).toBeLessThanOrEqual(now + 7 * 24 * 3_600_000);
    now += 7 * 24 * 3_600_000 + 1;
    expect(requestsOf(ryan, roomId)).toEqual([]);
    await expect(ryan.team.answerJoin(roomId, nick.id, true)).rejects.toThrow(/expired with the code they used/);
    (nick.team as any).retryJoins(); // the join timer's tick
    expect(nick.team.status().pending[0]).toMatchObject({ state: "rejected", reason: "The code expired before Ryan accepted — ask for a new one" });
    expect(ryan.team.room(roomId)!.members).toHaveLength(1);
  });

  it("an admin on an older Mockingbird can't take a passed-on request: the inviter says it needs an update", async () => {
    const dir = tempDir("join");
    const { net, ryan, sam, roomId } = await roomWithSam(dir);
    (ryan.team as any).requestHandlers.delete("room.joinRequest"); // what an older Mockingbird answers: no handler
    const lee = loopbackMember(net, "Lee", dir);
    lee.team.join(sam.team.createInvite(roomId));
    await until(() => !!requestsOf(sam, roomId)[0]?.problem, "Sam to see the problem");
    expect(requestsOf(sam, roomId)[0]).toMatchObject({ state: "forwarding", problem: "Ryan's Mockingbird needs an update to accept joins" });
  });

  it("a member's own member.added doesn't let anyone in", async () => {
    const dir = tempDir("join");
    const { members, roomId, net } = await loopbackRoom(["Ryan", "Nick"], { dir });
    const [ryan, nick] = members;
    const mallory = loopbackMember(net, "Mallory", dir);
    // a Mockingbird that doesn't cooperate adds its friend without asking the admin
    nick.team.publish(roomId, "member.added", { id: mallory.id, name: "Mallory", publicKey: mallory.identity.publicKey });
    await until(() => ryan.team.room(roomId)!.events === nick.team.room(roomId)!.events, "Ryan to have it");
    for (const m of [ryan, nick]) expect(m.team.room(roomId)!.members.map((x) => x.name)).toEqual(["Ryan", "Nick"]);
    expect(net.isLinked(ryan.id, mallory.id)).toBe(false);
  });
});

// ---- the app ------------------------------------------------------------------------------------

function service(net: LoopbackNetwork, name: string) {
  const dir = path.join(tempDir(name), "team");
  const settings: Settings = { ...DEFAULT_SETTINGS, teamName: name, signalingUrl: "https://signal.example" };
  const notified: { title: string; body: string }[] = [];
  const s = new TeamService({
    settings: () => settings,
    localGroups: () => [],
    emit: () => undefined,
    log: (_ctx, err) => (err instanceof Error ? err.message : String(err)),
    assetsDir: "/nonexistent",
    dir,
    wire: (identity) => net.wire(identity.id),
    notify: (title, body) => notified.push({ title, body }),
  });
  s.start();
  return { s, notified, id: s.status().self!.id };
}

const asked = (s: TeamService, roomId: string) => s.status().rooms.find((r) => r.id === roomId)?.requests?.find((q) => q.role === "admin" && q.state === "waiting");

describe("joining in the app", () => {
  it("the admin is notified of a request, with the joiner's fingerprint; members of the join; the joiner and the admin aren't", async () => {
    const net = new LoopbackNetwork();
    const [ryan, sam, nick] = [service(net, "Ryan"), service(net, "Sam"), service(net, "Nick")];
    const { invite, roomId } = await ryan.s.shareGroup("5110", "#5110 Donor entities");
    sam.s.join(invite);
    await until(() => !!asked(ryan.s, roomId), "Ryan to be asked about Sam");
    await ryan.s.answerJoin(roomId, sam.id, true);
    await until(() => sam.s.status().rooms.length === 1 && ryan.s.status().rooms[0].online.length === 1, "Sam in");
    nick.s.join(ryan.s.createInvite(roomId));
    await until(() => !!asked(ryan.s, roomId), "Ryan to be asked about Nick");
    expect(ryan.notified.at(-1)).toEqual({ title: "Nick wants to join #5110 Donor entities", body: `With your code. Check their fingerprint (${formatFingerprint(nick.id)}) with them, then Accept or Decline in Mockingbird.` });
    expect(await ryan.s.answerJoin(roomId, nick.id, true)).toEqual({ name: "Nick", accepted: true, worker: null });
    await until(() => sam.notified.some((n) => n.title === "Nick joined #5110 Donor entities"), "Sam to hear Nick joined");
    expect(sam.notified.find((n) => n.title === "Nick joined #5110 Donor entities")!.body).toBe("Ryan accepted them.");
    await until(() => nick.s.status().rooms.length === 1, "Nick in");
    await new Promise((r) => setTimeout(r, 50));
    expect(ryan.notified.filter((n) => /joined/.test(n.title))).toEqual([]);
    expect(nick.notified.filter((n) => /joined/.test(n.title))).toEqual([]); // not his own, nor Sam's from before he came
  });

  it("an older Worker: approval still happens in the apps, and declining says to redeploy it", async () => {
    const net = new LoopbackNetwork();
    net.workerApprove = false;
    const [ryan, nick] = [service(net, "Ryan"), service(net, "Nick")];
    const { invite, roomId } = await ryan.s.shareGroup("5110", "#5110 Donor entities");
    nick.s.join(invite);
    await until(() => !!asked(ryan.s, roomId), "Ryan to be asked");
    expect(ryan.s.status().rooms[0].workerApprove).toBe(false);
    const out = await ryan.s.answerJoin(roomId, nick.id, false);
    expect(out).toMatchObject({ name: "Nick", accepted: false });
    expect(out.worker).toMatch(/older: it let Nick connect before you answered .* Update it \(cd signaling && npx wrangler deploy\) to also hold joiners at the door/);
    await until(() => nick.s.status().pending[0]?.state === "declined", "Nick to hear");
    expect(nick.s.status().rooms).toEqual([]);
  });
});
