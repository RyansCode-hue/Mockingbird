import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { loadIdentity, randomToken, roomIdFor, type Identity } from "../src/main/team/identity";
import { compareEvents, defineEventType, eventIdOf, eventPayload, reduceRoom, RoomLog, RoomStore } from "../src/main/team/rooms";
import type { RoomEvent } from "../src/shared/team/types";

// a stage's own event type, declared the way later stages do
declare module "../src/shared/team/types" {
  interface RoomEventBodies {
    "test.note": { text: string };
  }
  interface RoomExtensions {
    notes: string[];
  }
}
defineEventType("test.note", {
  validate(b: any) {
    if (typeof b?.text !== "string") throw new Error("text must be a string");
  },
  reduce(state, e) {
    (state.ext.notes ??= []).push(e.body.text);
  },
});

const newId = (name: string) => loadIdentity(path.join(tempDir(name), "team"));

/** A room created by `creator`, in a log under a fresh folder. */
function newRoom(creator: Identity, name = "#5110 Donor entities") {
  const salt = randomToken();
  const roomId = roomIdFor(creator.publicKey, salt);
  const log = new RoomLog(roomId, path.join(tempDir("room"), roomId));
  log.create(creator, "room.created", { name, groupKey: "5110", publicKey: creator.publicKey, creatorName: "Ryan", salt });
  return { log, roomId, salt };
}

/** An event signed by `author` without adding it anywhere (for delivering in any order). */
function signed(author: Identity, roomId: string, type: string, body: unknown, lamport: number, at = 1000): RoomEvent {
  const u = { roomId, type, body, author: author.id, lamport, at };
  const payload = eventPayload(u);
  return { ...u, id: eventIdOf(payload), sig: author.sign(payload) } as RoomEvent;
}

const copyInto = (from: RoomLog, to: RoomLog) => from.all().map((e) => to.add(e));

describe("a room's event log", () => {
  it("starts with its creator as the only member, bound to the creator's key", () => {
    const ryan = newId("ryan");
    const { log, roomId } = newRoom(ryan);
    expect(log.state).toMatchObject({ id: roomId, name: "#5110 Donor entities", groupKey: "5110", creator: ryan.id, members: [{ id: ryan.id, name: "Ryan", publicKey: ryan.publicKey, invitedBy: null }], ext: {}, events: 1 });
  });

  it("adds members by a member's event, and refuses events from anyone else", () => {
    const ryan = newId("ryan");
    const nick = newId("nick");
    const mallory = newId("mallory");
    const { log, roomId } = newRoom(ryan);
    log.create(ryan, "member.added", { id: nick.id, name: "Nick", publicKey: nick.publicKey });
    expect(log.state!.members.map((m) => m.name)).toEqual(["Ryan", "Nick"]);
    log.create(nick, "test.note", { text: "hi from Nick" });
    expect(log.state!.ext.notes).toEqual(["hi from Nick"]);
    // a non-member's event waits (its add might still arrive) and never applies
    expect(log.add(signed(mallory, roomId, "test.note", { text: "let me in" }, 99))).toEqual({ status: "pending" });
    expect(log.state!.ext.notes).toEqual(["hi from Nick"]);
    // nor can a non-member add itself
    expect(log.add(signed(mallory, roomId, "member.added", { id: mallory.id, name: "M", publicKey: mallory.publicKey }, 100))).toEqual({ status: "pending" });
    expect(log.state!.members).toHaveLength(2);
    expect(() => log.create(mallory, "test.note", { text: "x" })).toThrow(/isn't a member/);
  });

  it("refuses a tampered event, a forged signature, a malformed body, and another creation", () => {
    const ryan = newId("ryan");
    const { log, roomId, salt } = newRoom(ryan);
    const good = signed(ryan, roomId, "test.note", { text: "original" }, 2);
    expect(log.add({ ...good, body: { text: "changed" } })).toEqual({ status: "rejected", reason: "its id doesn't match its content" });
    const forged = signed(ryan, roomId, "test.note", { text: "x" }, 3);
    expect(log.add({ ...forged, sig: newId("other").sign(eventPayload(forged)) })).toEqual({ status: "rejected", reason: "bad signature" });
    expect(log.add(signed(ryan, roomId, "test.note", { text: 42 }, 4))).toMatchObject({ status: "rejected", reason: expect.stringMatching(/malformed test.note/) });
    expect(log.add(signed(ryan, roomId, "member.added", { id: "0".repeat(32), name: "x", publicKey: ryan.publicKey }, 5))).toMatchObject({ status: "rejected", reason: expect.stringMatching(/doesn't match its id/) });
    // someone else can't create the same room id, nor can the creator create it twice
    const mallory = newId("mallory");
    expect(log.add(signed(mallory, roomId, "room.created", { name: "evil", groupKey: "x", publicKey: mallory.publicKey, creatorName: "M", salt }, 1))).toMatchObject({ status: "rejected" });
    expect(log.add(signed(ryan, roomId, "room.created", { name: "again", groupKey: "x", publicKey: ryan.publicKey, creatorName: "R", salt }, 1, 5))).toEqual({ status: "rejected", reason: "the room was already created" });
    expect(log.add(good)).toEqual({ status: "added" });
    expect(log.add(good)).toEqual({ status: "duplicate" });
  });

  it("orders by Lamport time, author, then id — the same state whatever order events arrive in", () => {
    const ryan = newId("ryan");
    const nick = newId("nick");
    const { log: a, roomId } = newRoom(ryan);
    a.create(ryan, "member.added", { id: nick.id, name: "Nick", publicKey: nick.publicKey });
    const b = new RoomLog(roomId, path.join(tempDir("b"), roomId));
    copyInto(a, b);
    // both rename concurrently (same Lamport time), and write notes, while apart
    a.create(ryan, "member.renamed", { name: "Ryan E" });
    a.create(ryan, "test.note", { text: "ryan 1" });
    b.create(nick, "test.note", { text: "nick 1" });
    b.create(nick, "test.note", { text: "nick 2" });
    // merged in opposite orders
    copyInto(b, a);
    copyInto(a, b);
    expect(a.all().map((e) => e.id)).toEqual(b.all().map((e) => e.id));
    expect(a.state).toEqual(b.state);
    expect([...a.all()].sort(compareEvents)).toEqual(a.all());
    expect(a.state!.ext.notes).toHaveLength(3);
    expect(reduceRoom(a.all())).toEqual(a.state);
  });

  it("holds an event whose author's add hasn't arrived, and applies it when it does", () => {
    const ryan = newId("ryan");
    const nick = newId("nick");
    const { log: a, roomId } = newRoom(ryan);
    const add = a.create(ryan, "member.added", { id: nick.id, name: "Nick", publicKey: nick.publicKey });
    const note = signed(nick, roomId, "test.note", { text: "early" }, 3);
    const b = new RoomLog(roomId, path.join(tempDir("b"), roomId));
    const applied: string[] = [];
    b.onApplied = (e) => applied.push(e.type);
    b.add(a.all()[0]);
    expect(b.add(note)).toEqual({ status: "pending" });
    expect(b.waiting).toBe(1);
    expect(b.add(add)).toEqual({ status: "added" });
    expect(b.waiting).toBe(0);
    expect(b.state!.ext.notes).toEqual(["early"]);
    expect(applied).toEqual(["room.created", "member.added", "test.note"]);
  });

  it("anti-entropy: each side sends what the other's ids lack, and the logs end up equal", () => {
    const ryan = newId("ryan");
    const nick = newId("nick");
    const { log: a, roomId } = newRoom(ryan);
    a.create(ryan, "member.added", { id: nick.id, name: "Nick", publicKey: nick.publicKey });
    const b = new RoomLog(roomId, path.join(tempDir("b"), roomId));
    copyInto(a, b);
    for (let i = 0; i < 5; i++) a.create(ryan, "test.note", { text: `a${i}` });
    for (let i = 0; i < 3; i++) b.create(nick, "test.note", { text: `b${i}` });
    expect(a.differingAuthors(b.summary()).sort()).toEqual([ryan.id, nick.id].sort());
    for (const author of b.differingAuthors(a.summary())) {
      for (const e of a.missingFor(author, b.idsBy(author))) b.add(e);
      for (const e of b.missingFor(author, a.idsBy(author))) a.add(e);
    }
    expect(a.summary()).toEqual(b.summary());
    expect(a.differingAuthors(b.summary())).toEqual([]);
    expect(a.state).toEqual(b.state);
  });

  it("keeps event types it doesn't know (a newer Mockingbird's) without applying them", () => {
    const ryan = newId("ryan");
    const { log, roomId } = newRoom(ryan);
    const future = signed(ryan, roomId, "board.claim", { anything: true }, 2);
    expect(log.add(future)).toEqual({ status: "added" });
    expect(log.has(future.id)).toBe(true);
    expect(log.state!.events).toBe(2);
  });

  it("reloads from disk: from the snapshot when it matches, by replay when it doesn't, skipping unreadable lines", () => {
    const ryan = newId("ryan");
    const { log, roomId } = newRoom(ryan);
    for (let i = 0; i < 3; i++) log.create(ryan, "test.note", { text: `n${i}` });
    log.flush();
    const again = new RoomLog(roomId, log.dir).load();
    expect(again.state).toEqual(log.state);
    // a snapshot that's behind the log is ignored
    log.create(ryan, "test.note", { text: "after the snapshot" });
    expect(new RoomLog(roomId, log.dir).load().state!.ext.notes).toHaveLength(4);
    // a torn last line (a crash mid-write) is skipped and reported
    fs.appendFileSync(path.join(log.dir, "log.jsonl"), '{"id":"half');
    const torn = new RoomLog(roomId, log.dir).load();
    expect(torn.state!.ext.notes).toHaveLength(4);
    expect(torn.problems.join()).toMatch(/line 6 is unreadable/);
    // a snapshot written with other reducers is replayed instead of trusted
    const snap = JSON.parse(fs.readFileSync(path.join(log.dir, "snapshot.json"), "utf8"));
    fs.writeFileSync(path.join(log.dir, "snapshot.json"), JSON.stringify({ ...snap, count: 5, lastId: log.all().at(-1)!.id, reducers: ["room.created"], state: { bogus: true } }));
    expect(new RoomLog(roomId, log.dir).load().state!.ext.notes).toHaveLength(4);
  });
});

describe("the room store", () => {
  it("keeps invites and pending joins owner-only, and opens every room on disk", () => {
    const ryan = newId("ryan");
    const dir = path.join(tempDir("store"), "rooms");
    const store = new RoomStore(dir).load();
    const salt = randomToken();
    const roomId = roomIdFor(ryan.publicKey, salt);
    store.open(roomId).create(ryan, "room.created", { name: "r", groupKey: "r", publicKey: ryan.publicKey, creatorName: "Ryan", salt });
    store.setMeta(roomId, { signalingUrl: "https://x.example", groupKey: "r" });
    store.saveInvites(roomId, [{ token: randomToken(), tokenHash: "h", createdAt: 1, expiresAt: 2 }]);
    store.savePendingJoins([]);
    expect(fs.statSync(path.join(dir, roomId, "invites.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(path.dirname(dir), "joins.json")).mode & 0o777).toBe(0o600);
    const reopened = new RoomStore(dir).load();
    expect(reopened.get(roomId)?.state?.name).toBe("r");
    expect(reopened.meta(roomId)).toEqual({ signalingUrl: "https://x.example", groupKey: "r" });
    expect(reopened.invites(roomId)).toHaveLength(1);
  });
});
