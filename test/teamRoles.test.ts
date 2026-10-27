import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { loadIdentity, randomToken, roomIdFor, type Identity } from "../src/main/team/identity";
import { claimantOf, eventIdOf, eventPayload, isRoomAdmin, legacyAdmin, mayRemove, OWNER_CLAIM_WAIT_MS, reduceRoom, roleOf, roomAdmins, RoomLog, roomOwner, roomRoles } from "../src/main/team/rooms";
import "../src/main/team/chat"; // the chat's lines for role changes
import { houseOfRoom } from "../src/main/team/board"; // house.project: the owner's
import "../src/main/team/takeover"; // room.settings: backups the owner's, the migration check an admin's too
import { RoomLog as RoomLog150 } from "./fixtures/team/rooms-1.5.0";
import { acceptJoins, LoopbackNetwork, loopbackMember, loopbackRoom, until } from "../src/main/team/loopback";
import { memberLine } from "../src/shared/team/chat";
import { canRemove, claimState, myRole, roleChanges } from "../src/renderer/team/rolesModel";
import type { RoomEvent, RoomState } from "../src/shared/team/types";

/**
 * Room roles (docs/team-rooms.md → Room roles): who may do what is decided
 * where each signed event falls in the room's order, the same on every Mac —
 * so every rule is checked on receipt, from a Mac that doesn't cooperate as
 * much as from one that does.
 */

const DAY = 24 * 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
const newId = (name: string) => loadIdentity(path.join(tempDir(name), "team"));

/** A room `creator` made (joins need accepting), in a log under a fresh folder; `now` is the log's clock (what refuses an event dated ahead of it). */
function newRoom(creator: Identity, o: { approval?: boolean; now?: () => number } = {}) {
  const salt = randomToken();
  const roomId = roomIdFor(creator.publicKey, salt);
  const log = new RoomLog(roomId, path.join(tempDir("room"), roomId), { now: o.now ?? Date.now });
  log.create(creator, "room.created", { name: "#5110 Donor entities", groupKey: "5110", publicKey: creator.publicKey, creatorName: "Ryan", salt, ...(o.approval === false ? {} : { approval: true as const }) }, T0);
  return { log, roomId, salt };
}

/** An event signed by `author` without adding it anywhere. */
function signed(author: Identity, roomId: string, type: string, body: unknown, lamport: number, at = T0): RoomEvent {
  const u = { roomId, type, body, author: author.id, lamport, at };
  const payload = eventPayload(u);
  return { ...u, id: eventIdOf(payload), sig: author.sign(payload) } as RoomEvent;
}

const add = (log: RoomLog, by: Identity, who: Identity, name: string, at = T0) => log.create(by, "member.added", { id: who.id, name, publicKey: who.publicKey, inviter: by.id }, at);
const names = (s: RoomState | null | undefined) => s?.members.map((m) => m.name);
const roles = (s: RoomState) => ({ owner: roomOwner(s), admins: roomAdmins(s) });
const lines = (s: RoomState, nameOf: (id: string) => string) => (s.ext.chat?.entries ?? []).filter((e) => e.kind === "member").map((e) => memberLine(e, nameOf));

/** Ryan (owner), Nick, Sam and Lee in a room; Nick an admin when `nickAdmin`. */
function team4(nickAdmin = true) {
  const [ryan, nick, sam, lee] = ["ryan", "nick", "sam", "lee"].map(newId);
  const { log, roomId } = newRoom(ryan);
  add(log, ryan, nick, "Nick");
  add(log, ryan, sam, "Sam");
  add(log, ryan, lee, "Lee");
  if (nickAdmin) log.create(ryan, "role.admin", { member: nick.id, admin: true }, T0);
  const nameOf = (id: string) => ({ [ryan.id]: "Ryan", [nick.id]: "Nick", [sam.id]: "Sam", [lee.id]: "Lee" })[id] ?? "?";
  return { ryan, nick, sam, lee, log, roomId, nameOf };
}

describe("room roles in the room log: each rule, allowed and refused, on receipt", () => {
  it("the creator owns a new room; nobody else is an admin", () => {
    const { ryan, nick, log } = team4(false);
    expect(roles(log.state!)).toEqual({ owner: ryan.id, admins: [] });
    expect(roleOf(log.state!, ryan.id)).toBe("owner");
    expect(roleOf(log.state!, nick.id)).toBe("member");
    expect(roleOf(log.state!, "f".repeat(32))).toBeNull();
  });

  it("only the owner makes an admin or takes the role back: an admin's or a member's role.admin is kept and changes nothing", () => {
    const { ryan, nick, sam, lee, log } = team4();
    expect(roles(log.state!)).toEqual({ owner: ryan.id, admins: [nick.id] });
    log.create(nick, "role.admin", { member: sam.id, admin: true }); // an admin can't make admins
    log.create(sam, "role.admin", { member: sam.id, admin: true }); // nor a member themselves
    log.create(lee, "role.admin", { member: nick.id, admin: false }); // nor take it back
    expect(roles(log.state!)).toEqual({ owner: ryan.id, admins: [nick.id] });
    expect(log.all().filter((e) => e.type === "role.admin")).toHaveLength(4); // kept, and passed on
    log.create(ryan, "role.admin", { member: sam.id, admin: true });
    log.create(ryan, "role.admin", { member: nick.id, admin: false });
    expect(roles(log.state!)).toEqual({ owner: ryan.id, admins: [sam.id] });
    expect(() => log.create(ryan, "role.admin", { member: "nobody", admin: true } as never)).toThrow(/bad member id/);
    expect(() => log.create(ryan, "role.admin", { member: sam.id, admin: "yes" } as never)).toThrow(/admin must be true or false/);
  });

  it("only the owner hands over ownership, to a member; the old owner stays an admin", () => {
    const { ryan, nick, sam, log } = team4();
    log.create(nick, "role.owner", { member: nick.id }); // an admin can't take it
    log.create(ryan, "role.owner", { member: "e".repeat(32) }); // nor can it go to someone who isn't a member
    expect(roomOwner(log.state!)).toBe(ryan.id);
    log.create(ryan, "role.owner", { member: sam.id });
    expect(roles(log.state!)).toEqual({ owner: sam.id, admins: [nick.id, ryan.id] });
    // the new owner's word counts now, the old owner's doesn't
    log.create(ryan, "role.admin", { member: nick.id, admin: false });
    expect(roomAdmins(log.state!)).toContain(nick.id);
    log.create(sam, "role.admin", { member: ryan.id, admin: false });
    expect(roles(log.state!)).toEqual({ owner: sam.id, admins: [nick.id] });
  });

  it("removing: admins remove members; only the owner removes an admin or the owner; an admin can't remove another admin", () => {
    const { ryan, nick, sam, lee, log } = team4();
    log.create(ryan, "role.admin", { member: sam.id, admin: true });
    log.create(nick, "member.removed", { member: sam.id, reason: "removed" }); // admin → admin: refused
    log.create(nick, "member.removed", { member: ryan.id, reason: "removed" }); // admin → owner: refused
    log.create(lee, "member.removed", { member: nick.id, reason: "removed" }); // member → admin: refused
    expect(names(log.state)).toEqual(["Ryan", "Nick", "Sam", "Lee"]);
    log.create(nick, "member.removed", { member: lee.id, reason: "removed" }); // admin → member: counts
    expect(names(log.state)).toEqual(["Ryan", "Nick", "Sam"]);
    expect(log.state!.former).toMatchObject([{ id: lee.id, removedBy: nick.id }]);
    log.create(ryan, "member.removed", { member: sam.id, reason: "removed" }); // owner → admin: counts, and the role goes with them
    expect(roles(log.state!)).toEqual({ owner: ryan.id, admins: [nick.id] });
    expect(names(log.state)).toEqual(["Ryan", "Nick"]);
  });

  it("mayRemove says the same", () => {
    const { ryan, nick, sam, log } = team4();
    const s = log.state!;
    expect(mayRemove(s, nick.id, sam.id, T0)).toBe(true);
    expect(mayRemove(s, nick.id, ryan.id, T0)).toBe(false);
    expect(mayRemove(s, sam.id, nick.id, T0)).toBe(false);
    expect(mayRemove(s, sam.id, sam.id, T0)).toBe(true); // leaving
    expect(mayRemove(s, ryan.id, nick.id, T0)).toBe(true);
  });

  it("an admin accepts joins: their member.added counts, a member's doesn't", () => {
    const { ryan, nick, sam, log } = team4();
    const [kim, ann] = [newId("kim"), newId("ann")];
    add(log, sam, kim, "Kim"); // a member's: kept, changes nothing
    add(log, nick, ann, "Ann"); // an admin's: counts
    expect(names(log.state)).toEqual(["Ryan", "Nick", "Sam", "Lee", "Ann"]);
    expect(log.state!.members.at(-1)).toMatchObject({ acceptedBy: nick.id });
    expect(isRoomAdmin(log.state!, nick.id)).toBe(true);
    expect(isRoomAdmin(log.state!, ryan.id)).toBe(true);
    expect(isRoomAdmin(log.state!, sam.id)).toBe(false);
  });

  it("the room's rules are an admin's to set (the migration check); where backups go and the House project are the owner's alone", () => {
    const { ryan, nick, sam, log } = team4();
    log.create(sam, "room.settings", { migrationCheck: false }); // a member: nothing
    expect(log.state!.ext.settings).toBeUndefined();
    log.create(nick, "room.settings", { migrationCheck: false, backupsToOrigin: true }); // an admin: the rule counts, backups don't
    expect(log.state!.ext.settings).toMatchObject({ migrationCheck: false, backupsToOrigin: false, by: nick.id });
    log.create(nick, "room.settings", { backupsToOrigin: true }); // only backups: nothing at all
    expect(log.state!.ext.settings).toMatchObject({ backupsToOrigin: false, by: nick.id });
    log.create(ryan, "room.settings", { backupsToOrigin: true });
    expect(log.state!.ext.settings).toMatchObject({ migrationCheck: false, backupsToOrigin: true, by: ryan.id });
    log.create(nick, "house.project", { project: "sneaky" });
    expect(houseOfRoom(log.state!).project).toBeNull();
    log.create(ryan, "house.project", { project: "atticus-backoffice" });
    expect(houseOfRoom(log.state!).project).toBe("atticus-backoffice");
  });

  it("the same events in any order reduce to the same roles on every Mac", () => {
    const [ryan, nick, sam] = ["ryan", "nick", "sam"].map(newId);
    const { log: first, roomId } = newRoom(ryan);
    const created = first.all()[0];
    const events = [
      signed(ryan, roomId, "member.added", { id: nick.id, name: "Nick", publicKey: nick.publicKey, inviter: ryan.id }, 2),
      signed(ryan, roomId, "member.added", { id: sam.id, name: "Sam", publicKey: sam.publicKey, inviter: ryan.id }, 3),
      signed(nick, roomId, "member.removed", { member: sam.id, reason: "removed" }, 4), // before Nick is an admin: nothing
      signed(ryan, roomId, "role.admin", { member: nick.id, admin: true }, 5),
      signed(nick, roomId, "member.removed", { member: sam.id, reason: "removed" }, 6), // after: counts
      signed(ryan, roomId, "role.owner", { member: nick.id }, 7),
    ];
    const states = [events, [...events].reverse(), [events[5], events[1], events[3], events[0], events[4], events[2]]].map((order) => {
      const log = new RoomLog(roomId, path.join(tempDir("copy"), roomId), { now: () => T0 });
      log.add(created);
      for (const e of order) log.add(e);
      return log.state!;
    });
    for (const s of states) {
      expect(names(s)).toEqual(["Ryan", "Nick"]);
      expect(roles(s)).toEqual({ owner: nick.id, admins: [ryan.id] });
    }
    expect(JSON.stringify(states[1])).toBe(JSON.stringify(states[0]));
    expect(JSON.stringify(states[2])).toBe(JSON.stringify(states[0]));
  });
});

describe("existing rooms: roles from a log written before them", () => {
  it("the creator owns it; where the creator had left, today's admin — the longest-standing member — owns it", () => {
    const [ryan, nick, sam] = ["ryan", "nick", "sam"].map(newId);
    const { log, roomId } = newRoom(ryan, { approval: false });
    add(log, ryan, nick, "Nick");
    add(log, nick, sam, "Sam");
    expect(roles(log.state!)).toEqual({ owner: ryan.id, admins: [] });
    // the same log, but the creator left before roles existed
    const created = log.all()[0];
    const before = [...log.all().slice(1), signed(ryan, roomId, "member.removed", { member: ryan.id, reason: "left" }, 10)];
    const s = reduceRoom([created, ...before])!;
    expect(legacyAdmin(s)).toBe(nick.id);
    expect(roles(s)).toEqual({ owner: nick.id, admins: [] });
  });

  it("a snapshot reduced before roles is reduced again on load: its state gets them", () => {
    const [ryan, nick] = ["ryan", "nick"].map(newId);
    const { log, roomId } = newRoom(ryan);
    add(log, ryan, nick, "Nick");
    log.flush();
    const snapFile = path.join(log.dir, "snapshot.json");
    // as 1.5.0 wrote it: no roles in the state, and the reducers it knew
    const snap = JSON.parse(fs.readFileSync(snapFile, "utf8"));
    delete snap.state.roles;
    snap.reducers = snap.reducers.filter((n: string) => !n.startsWith("role"));
    fs.writeFileSync(snapFile, JSON.stringify(snap));
    const again = new RoomLog(roomId, log.dir).load();
    expect(again.state!.roles).toMatchObject({ owner: ryan.id, admins: [] });
  });
});

describe("the owner leaving, and a gone owner's room", () => {
  it("an owner who leaves anyway (an older Mockingbird lets them) hands the room on: to the longest-standing admin, else member — and the chat says so", () => {
    const { ryan, nick, sam, log, nameOf } = team4();
    log.create(ryan, "role.admin", { member: sam.id, admin: true });
    log.create(ryan, "member.removed", { member: ryan.id, reason: "left" });
    expect(roles(log.state!)).toEqual({ owner: nick.id, admins: [sam.id] });
    expect(lines(log.state!, nameOf).slice(-2)).toEqual(["Ryan left", "Nick owns the room now"]);
  });

  it("the claimant may claim only once the owner has gone unheard from for 14 days; anything the owner says starts it again", () => {
    let now = T0;
    const [ryan, nick, sam] = ["ryan", "nick", "sam"].map(newId);
    const { log } = newRoom(ryan, { now: () => now });
    add(log, ryan, nick, "Nick");
    add(log, ryan, sam, "Sam");
    log.create(ryan, "role.admin", { member: nick.id, admin: true }, T0 + DAY);
    expect(claimantOf(log.state!)).toBe(nick.id);
    expect(roomRoles(log.state!).ownerSeenAt).toBe(T0 + DAY);
    // 13 days on: too soon, kept and changes nothing
    now = T0 + 14 * DAY;
    log.create(nick, "role.claim", {}, now);
    expect(roomOwner(log.state!)).toBe(ryan.id);
    // Ryan says something: heard from, the wait starts again
    log.create(ryan, "chat.message", { text: "back for a bit", mentions: [] }, T0 + 5 * DAY);
    now = T0 + 15 * DAY + 1;
    log.create(nick, "role.claim", {}, now);
    expect(roomOwner(log.state!)).toBe(ryan.id);
    // Sam isn't the claimant: never his
    now = T0 + 30 * DAY;
    log.create(sam, "role.claim", {}, now);
    expect(roomOwner(log.state!)).toBe(ryan.id);
    log.create(nick, "role.claim", {}, now);
    expect(roles(log.state!)).toEqual({ owner: nick.id, admins: [] });
    expect(roomRoles(log.state!).claim).toEqual({ from: ryan.id, by: nick.id, at: now, byWasAdmin: true });
  });

  it("a claim dated ahead of this Mac's clock is refused (it can't be hurried by a clock set forward)", () => {
    const [ryan, nick] = ["ryan", "nick"].map(newId);
    const { log, roomId } = newRoom(ryan, { now: () => T0 });
    add(log, ryan, nick, "Nick");
    const early = signed(nick, roomId, "role.claim", {}, 10, T0 + 15 * DAY);
    expect(log.add(early)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/dated .* ahead of this Mac's clock/) });
    // a removal of someone else is, too; leaving isn't
    expect(log.add(signed(ryan, roomId, "member.removed", { member: nick.id, reason: "removed" }, 11, T0 + DAY))).toMatchObject({ status: "rejected" });
    expect(log.add(signed(nick, roomId, "member.removed", { member: nick.id, reason: "left" }, 12, T0 + DAY))).toEqual({ status: "added" });
  });

  it("the old owner takes it back; until 14 days after the claim nobody can remove them", () => {
    let now = T0;
    const [ryan, nick, sam] = ["ryan", "nick", "sam"].map(newId);
    const { log } = newRoom(ryan, { now: () => now });
    add(log, ryan, nick, "Nick");
    add(log, ryan, sam, "Sam");
    log.create(ryan, "role.admin", { member: nick.id, admin: true }, T0);
    now = T0 + 20 * DAY;
    log.create(nick, "role.claim", {}, now);
    const claimedAt = now;
    // the new owner can't remove the old one while they may come back
    now = claimedAt + 13 * DAY;
    log.create(nick, "member.removed", { member: ryan.id, reason: "removed" }, now);
    expect(names(log.state)).toEqual(["Ryan", "Nick", "Sam"]);
    expect(mayRemove(log.state!, nick.id, ryan.id, now)).toBe(false);
    // Sam can't take it back: only the owner it was taken from
    log.create(sam, "role.contest", {}, now);
    expect(roomOwner(log.state!)).toBe(nick.id);
    log.create(ryan, "role.contest", {}, now);
    expect(roles(log.state!)).toEqual({ owner: ryan.id, admins: [nick.id] });
    expect(roomRoles(log.state!).claim).toBeUndefined();
    // once the claim stood 14 days uncontested, the new owner may remove the old one
    now = claimedAt + 13 * DAY + OWNER_CLAIM_WAIT_MS; // the contest was Ryan heard from: 14 days on from it
    log.create(nick, "role.claim", {}, now);
    expect(roomOwner(log.state!)).toBe(nick.id);
    now += OWNER_CLAIM_WAIT_MS;
    log.create(nick, "member.removed", { member: ryan.id, reason: "removed" }, now);
    expect(names(log.state)).toEqual(["Nick", "Sam"]);
  });

  it("with no admins, the longest-standing member is the claimant; a claimant who wasn't an admin isn't made one by a contest", () => {
    let now = T0;
    const [ryan, nick, sam] = ["ryan", "nick", "sam"].map(newId);
    const { log } = newRoom(ryan, { now: () => now });
    add(log, ryan, nick, "Nick");
    add(log, ryan, sam, "Sam");
    expect(claimantOf(log.state!)).toBe(nick.id);
    now = T0 + 15 * DAY;
    log.create(nick, "role.claim", {}, now);
    expect(roomOwner(log.state!)).toBe(nick.id);
    log.create(ryan, "role.contest", {}, now);
    expect(roles(log.state!)).toEqual({ owner: ryan.id, admins: [] });
  });
});

describe("role changes are announced in the room's chat", () => {
  it("made and removed as an admin, handed over, claimed and taken back", () => {
    let now = T0;
    const [ryan, nick] = ["ryan", "nick"].map(newId);
    const { log } = newRoom(ryan, { now: () => now });
    add(log, ryan, nick, "Nick");
    log.create(ryan, "role.admin", { member: nick.id, admin: true }, T0);
    log.create(ryan, "role.admin", { member: nick.id, admin: false }, T0);
    log.create(ryan, "role.owner", { member: nick.id }, T0);
    log.create(nick, "role.owner", { member: ryan.id }, T0);
    now = T0 + 15 * DAY;
    log.create(nick, "role.claim", {}, now);
    log.create(ryan, "role.contest", {}, now);
    log.create(nick, "role.admin", { member: nick.id, admin: true }); // refused: no line
    const nameOf = (id: string) => (id === ryan.id ? "Ryan" : id === nick.id ? "You" : "?");
    expect(lines(log.state!, nameOf)).toEqual([
      "Ryan accepted you",
      "Ryan made you an admin",
      "Ryan removed you as an admin",
      "Ryan handed ownership of the room to you",
      "You handed ownership of the room to Ryan",
      "You claimed ownership of the room: Ryan hadn't been heard from in it for 14 days, and can take it back",
      "Ryan took ownership of the room back from you",
    ]);
  });
});

describe("an older Mac (1.5.0, before roles) in the same room", () => {
  /** The same events, reduced by 1.5.0's room log: what an older Mac makes of them. */
  function onOlderMac(log: RoomLog): RoomState {
    const old = new RoomLog150(log.roomId, path.join(tempDir("old-mac"), log.roomId));
    for (const e of log.all()) expect(old.add(e).status).not.toBe("rejected");
    return old.state!;
  }

  it("keeps role events and goes on with the room: the same members, and it takes the creator for the admin", () => {
    const { ryan, nick, sam, lee, log } = team4();
    log.create(nick, "member.renamed", { name: "Nicholas" });
    log.create(lee, "member.removed", { member: lee.id, reason: "left" });
    const old = onOlderMac(log);
    expect(old.members.map((m) => m.id)).toEqual(log.state!.members.map((m) => m.id));
    expect(names(old)).toEqual(["Ryan", "Nicholas", "Sam"]);
    expect((old as RoomState & { roles?: unknown }).roles).toBeUndefined(); // it knows nothing of them
    expect(legacyAdmin(log.state!)).toBe(ryan.id);
    void sam;
  });

  it("after a hand-over an older Mac still takes the creator for the admin; a newer Mac never takes an admin action from them without the role", () => {
    const { ryan, nick, sam, lee, log } = team4(false);
    log.create(ryan, "role.owner", { member: nick.id }); // Ryan stays an admin...
    log.create(nick, "role.admin", { member: ryan.id, admin: false }); // ...until Nick takes it back
    expect(roleOf(log.state!, ryan.id)).toBe("member");
    const kim = newId("kim");
    // a Mockingbird that signs what an older Mac would accept from the creator
    log.create(ryan, "member.removed", { member: sam.id, reason: "removed" });
    add(log, ryan, kim, "Kim");
    log.create(ryan, "room.settings", { backupsToOrigin: true, migrationCheck: false });
    log.create(ryan, "house.project", { project: "sneaky" });
    // on this Mac: none of it counts
    expect(names(log.state)).toEqual(["Ryan", "Nick", "Sam", "Lee"]);
    expect(log.state!.ext.settings).toBeUndefined();
    expect(houseOfRoom(log.state!).project).toBeNull();
    // an older Mac takes it all from Ryan, whom it still sees as the admin — and nothing from Nick, the owner
    const old = onOlderMac(log);
    expect(names(old)).toEqual(["Ryan", "Nick", "Lee", "Kim"]);
    log.create(nick, "member.removed", { member: lee.id, reason: "removed" });
    expect(names(log.state)).toEqual(["Ryan", "Nick", "Sam"]);
    expect(names(onOlderMac(log))).toEqual(["Ryan", "Nick", "Lee", "Kim"]);
  });
});

describe("roles between Mockingbirds", () => {
  it("only the owner changes roles; an admin removes a member but not the owner or another admin; refusals are said before anything is sent", async () => {
    const dir = tempDir("roles");
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick", "Sam", "Lee"], { dir });
    const [ryan, nick, sam, lee] = members;
    expect(() => nick.team.setAdmin(roomId, sam.id, true)).toThrow(/Only the room's owner \(Ryan\) makes admins/);
    expect(() => nick.team.handOver(roomId, nick.id)).toThrow(/Only the room's owner \(Ryan\) hands over ownership/);
    ryan.team.setAdmin(roomId, nick.id, true);
    ryan.team.setAdmin(roomId, sam.id, true);
    await until(() => members.every((m) => roomAdmins(m.team.room(roomId)!).length === 2), "everyone to see two admins");
    await expect(nick.team.removeMember(roomId, ryan.id)).rejects.toThrow(/Only the room's owner \(Ryan\) removes the owner/);
    await expect(nick.team.removeMember(roomId, sam.id)).rejects.toThrow(/Only the room's owner \(Ryan\) removes an admin/);
    await expect(lee.team.removeMember(roomId, nick.id)).rejects.toThrow(/Only the room's owner or an admin removes members/);
    const out = await nick.team.removeMember(roomId, lee.id);
    expect(out).toMatchObject({ delivered: true, already: false });
    await until(() => members.slice(0, 3).every((m) => m.team.room(roomId)!.members.length === 3), "everyone to see Lee go");
    expect(lee.team.room(roomId)).toBeUndefined();
  });

  it("a Mac that doesn't cooperate publishes a role change or removal anyway: every other Mac refuses it", async () => {
    const dir = tempDir("roles");
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick", "Sam"], { dir });
    const [ryan, nick, sam] = members;
    ryan.team.setAdmin(roomId, nick.id, true);
    await until(() => members.every((m) => isRoomAdmin(m.team.room(roomId)!, nick.id)), "Nick an admin everywhere");
    nick.team.publish(roomId, "role.admin", { member: sam.id, admin: true });
    nick.team.publish(roomId, "role.owner", { member: nick.id });
    nick.team.publish(roomId, "member.removed", { member: ryan.id, reason: "removed" });
    await until(() => members.every((m) => m.team.room(roomId)!.events === nick.team.room(roomId)!.events), "the events everywhere");
    for (const m of members) {
      expect(roles(m.team.room(roomId)!)).toEqual({ owner: ryan.id, admins: [nick.id] });
      expect(m.team.room(roomId)!.members).toHaveLength(3);
    }
  });

  it("the owner can't leave before handing over; then they can", async () => {
    const dir = tempDir("roles");
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir });
    const [ryan, nick] = members;
    await expect(ryan.team.leave(roomId)).rejects.toThrow(/You own 5110: hand ownership over to a teammate before you leave/);
    expect(ryan.team.room(roomId)!.members).toHaveLength(2);
    ryan.team.handOver(roomId, nick.id);
    await ryan.team.leave(roomId);
    await until(() => nick.team.room(roomId)!.members.length === 1, "Nick to see Ryan go");
    expect(roles(nick.team.room(roomId)!)).toEqual({ owner: nick.id, admins: [] });
  });

  it("an admin answers a join while the owner is offline: the inviter passes it on to them", async () => {
    const dir = tempDir("roles");
    const net = new LoopbackNetwork();
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick", "Sam"], { dir, net });
    const [ryan, nick, sam] = members;
    ryan.team.setAdmin(roomId, nick.id, true);
    await until(() => members.every((m) => isRoomAdmin(m.team.room(roomId)!, nick.id)), "Nick an admin everywhere");
    net.setOnline(ryan.id, false);
    const lee = loopbackMember(net, "Lee", dir);
    acceptJoins(nick.team);
    lee.team.join(sam.team.createInvite(roomId));
    await until(() => !!lee.team.room(roomId)?.members.some((m) => m.id === lee.id), "Lee in, accepted by Nick", 10_000);
    expect(nick.team.room(roomId)!.members.at(-1)).toMatchObject({ id: lee.id, acceptedBy: nick.id, invitedBy: sam.id });
    // Ryan hears of it when he's back
    net.setOnline(ryan.id, true);
    await until(() => !!ryan.team.room(roomId)?.members.some((m) => m.id === lee.id), "Ryan to hear Lee joined");
  });

  it("claiming ownership is refused while the owner is connected, or heard from recently", async () => {
    const dir = tempDir("roles");
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir });
    const [, nick] = members;
    expect(() => nick.team.claimOwnership(roomId)).toThrow(/Ryan is connected now: ask them to hand ownership over instead/);
    expect(() => nick.team.contestClaim(roomId)).toThrow(/Nobody claimed ownership of 5110 from you/);
  });
});

describe("what the window offers for roles (rolesModel)", () => {
  const me = { id: "me", name: "You", self: true };
  const nick = { id: "nick", name: "Nick", self: false };
  const sam = { id: "sam", name: "Sam", self: false };
  type R = Parameters<typeof canRemove>[0];
  const room = (o: Partial<R> = {}): R => ({ members: [me, nick, sam], owner: "me", admins: ["nick"], claimOpensAt: null, ...o });

  it("the owner changes roles and removes anyone; an admin removes members only; a member nothing", () => {
    expect(roleChanges(room(), "nick")).toEqual({ makeAdmin: false, removeAdmin: true, handOver: true });
    expect(roleChanges(room(), "sam")).toEqual({ makeAdmin: true, removeAdmin: false, handOver: true });
    expect([canRemove(room(), "nick"), canRemove(room(), "sam")]).toEqual([true, true]);
    const asAdmin = room({ owner: "nick", admins: ["me", "sam"] });
    expect(roleChanges(asAdmin, "sam")).toEqual({ makeAdmin: false, removeAdmin: false, handOver: false });
    expect([canRemove(asAdmin, "nick"), canRemove(asAdmin, "sam")]).toEqual([false, false]);
    expect(canRemove(room({ owner: "nick", admins: ["me"] }), "sam")).toBe(true);
    expect(canRemove(room({ owner: "nick", admins: [] }), "sam")).toBe(false);
    expect(myRole(room({ owner: "nick", admins: [] }))).toBe("member");
  });

  it("the claim: take it back, claim it, or when it opens", () => {
    const now = Date.now();
    expect(claimState(room({ owner: "nick", admins: [], claim: { from: "me", by: "nick", at: now } }), now)).toEqual({ kind: "contest", by: "Nick" });
    expect(claimState(room({ owner: "nick", admins: [], claimOpensAt: now - 1 }), now)).toEqual({ kind: "can-claim", owner: "Nick" });
    expect(claimState(room({ owner: "nick", admins: [], claimOpensAt: now + DAY }), now)).toEqual({ kind: "waiting", owner: "Nick", opensAt: now + DAY });
    expect(claimState(room(), now)).toBeNull();
    // the claimed-from owner can't be removed for 14 days
    expect(canRemove(room({ claim: { from: "sam", by: "me", at: now } }), "sam", now + DAY)).toBe(false);
    expect(canRemove(room({ claim: { from: "sam", by: "me", at: now } }), "sam", now + OWNER_CLAIM_WAIT_MS)).toBe(true);
  });
});
