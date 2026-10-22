import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { loadIdentity, randomToken, roomIdFor, type Identity } from "../src/main/team/identity";
import { defineEventType, eventIdOf, eventPayload, RoomLog, type RoomLogOptions } from "../src/main/team/rooms";
import { LoopbackNetwork, loopbackRoom, until } from "../src/main/team/loopback";
import { RateBucket, ROOM_LIMITS, transcriptRefusal } from "../src/main/team/roomLimits";
import { REPLACED, REPLACED_ADVICE, SignalingClient } from "../src/main/team/signalingClient";
import { TeamService } from "../src/main/team/service";
import { startLocalSignaling } from "../signaling/src/local/server";
import { Messaging } from "../src/main/messaging";
import { DEFAULT_SETTINGS } from "../src/shared/types";
import type { RoomEvent } from "../src/shared/team/types";
import type { SessionInfo } from "../src/shared/types";

/**
 * What each member may add to a room, enforced by the Mac that receives it
 * (docs/team-rooms.md, "Limits on what a member adds"): event size, events a
 * minute, a share of the log, events in the order their author wrote them,
 * conversation copies; agent messages paced per sending member; and this
 * install's key in use somewhere else, said plainly.
 */

declare module "../src/shared/team/types" {
  interface RoomEventBodies {
    "limits.note": { text: string };
  }
  interface RoomExtensions {
    limitNotes: string[];
  }
}
defineEventType("limits.note", {
  reduce(state, e) {
    (state.ext.limitNotes ??= []).push(e.body.text);
  },
});

const newId = (name: string) => loadIdentity(path.join(tempDir(name), "team"));

function signed(author: Identity, roomId: string, type: string, body: unknown, lamport: number, at = 1000): RoomEvent {
  const u = { roomId, type, body, author: author.id, lamport, at };
  const payload = eventPayload(u);
  return { ...u, id: eventIdOf(payload), sig: author.sign(payload) } as RoomEvent;
}

/** Ryan's room with Nick in it, on a clock the test moves. */
function room(o: RoomLogOptions["limits"] = {}) {
  const clock = { t: 1_000_000 };
  const ryan = newId("ryan");
  const nick = newId("nick");
  const salt = randomToken();
  const roomId = roomIdFor(ryan.publicKey, salt);
  const dir = path.join(tempDir("room"), roomId);
  const opts: RoomLogOptions = { limits: o, now: () => clock.t };
  const log = new RoomLog(roomId, dir, opts);
  log.create(ryan, "room.created", { name: "#5110", groupKey: "5110", publicKey: ryan.publicKey, creatorName: "Ryan", salt });
  log.create(ryan, "member.added", { id: nick.id, name: "Nick", publicKey: nick.publicKey });
  const note = (lamport: number, text = `n${lamport}`) => signed(nick, roomId, "limits.note", { text }, lamport);
  return { clock, ryan, nick, roomId, dir, opts, log, note };
}

const MIN = 60_000;

describe("a member's limits in the room log", () => {
  it("refuses an event over the size limit, from a peer or this install, saying which limit", () => {
    const t = room({ maxEventBytes: 2_000 });
    expect(t.log.add(t.note(10, "x".repeat(1_000)), { remote: true })).toEqual({ status: "added" });
    expect(t.log.add(t.note(11, "x".repeat(4_000)), { remote: true })).toMatchObject({ status: "rejected", limit: "size", reason: "over 2 KB" });
    expect(() => t.log.create(t.ryan, "limits.note", { text: "y".repeat(4_000) })).toThrow(/over 2 KB/);
    expect(t.log.state!.ext.limitNotes).toEqual(["x".repeat(1_000)]);
  });

  it("takes a burst from a peer, then refuses past the per-minute limit until it refills; this install's own aren't paced", () => {
    const t = room({ eventBurst: 5, eventsPerMinute: 60 });
    for (let i = 0; i < 5; i++) expect(t.log.add(t.note(10 + i), { remote: true }).status).toBe("added");
    expect(t.log.add(t.note(20), { remote: true })).toMatchObject({ status: "rejected", limit: "rate", reason: expect.stringMatching(/more than 60 events a minute/) });
    for (let i = 0; i < 20; i++) t.log.create(t.ryan, "limits.note", { text: `r${i}` });
    expect(t.log.rateWaitMs(t.nick.id)).toBe(1_000);
    t.clock.t += 1_000; // one a second
    expect(t.log.add(t.note(20), { remote: true }).status).toBe("added");
    expect(t.log.add(t.note(21), { remote: true }).status).toBe("rejected");
  });

  it("takes the backlog a peer's sync announced without the per-minute limit, and no more", () => {
    const t = room({ eventBurst: 5, eventsPerMinute: 60 });
    t.log.expectCatchUp(t.nick.id, 50);
    for (let i = 0; i < 55; i++) expect(t.log.add(t.note(10 + i), { remote: true }).status).toBe("added");
    expect(t.log.add(t.note(100), { remote: true })).toMatchObject({ status: "rejected", limit: "rate" });
  });

  it("holds each member to a share of the log, across a restart; a member over it can still leave", () => {
    const t = room({ maxMemberLogBytes: 4_000 });
    let lamport = 10;
    while (t.log.add(t.note(lamport++, "z".repeat(300)), { remote: true }).status === "added");
    expect(t.log.bytesOf(t.nick.id)).toBeGreaterThan(3_000);
    expect(t.log.bytesOf(t.nick.id)).toBeLessThanOrEqual(4_000);
    expect(t.log.add(t.note(lamport++), { remote: true })).toMatchObject({ status: "rejected", limit: "share", reason: expect.stringMatching(/the limit is 3.9 KB/) });
    // Ryan's own share is his
    t.log.create(t.ryan, "limits.note", { text: "still mine" });
    // read back from disk: the share counts what's stored
    const again = new RoomLog(t.roomId, t.dir, t.opts).load();
    expect(again.bytesOf(t.nick.id)).toBe(t.log.bytesOf(t.nick.id));
    expect(again.add(t.note(lamport++), { remote: true })).toMatchObject({ status: "rejected", limit: "share" });
    expect(again.add(signed(t.nick, t.roomId, "member.removed", { member: t.nick.id, reason: "left" }, lamport++), { remote: true }).status).toBe("added");
    expect(again.state!.members.map((m) => m.name)).toEqual(["Ryan"]);
  });

  it("refuses an event backdated below what its author sent minutes ago, from anyone", () => {
    const t = room();
    expect(t.log.add(t.note(10), { remote: true }).status).toBe("added");
    expect(t.log.add(t.note(20), { remote: true }).status).toBe("added");
    t.clock.t += 6 * MIN;
    expect(t.log.add(t.note(15, "placed in the past"), { remote: true })).toMatchObject({ status: "rejected", limit: "order", reason: expect.stringMatching(/backdated: its Lamport time 15 sorts at or before 20/) });
    expect(t.log.add(t.note(20, "same time as one before"), { remote: true })).toMatchObject({ status: "rejected", limit: "order" });
    expect(t.log.add(t.note(21), { remote: true }).status).toBe("added");
    expect(t.log.state!.ext.limitNotes).toEqual(["n10", "n20", "n21"]);
    // read back from disk, every stored event is a floor at once
    const again = new RoomLog(t.roomId, t.dir, t.opts).load();
    expect(again.add(t.note(19), { remote: true })).toMatchObject({ status: "rejected", limit: "order" });
  });

  it("takes an author's backlog that arrives just behind a newer event, as around a reconnect", () => {
    const t = room();
    for (let i = 0; i < 40; i++) t.log.create(t.ryan, "limits.note", { text: `r${i}` });
    // Nick wrote 3..9 while apart; his first event after reconnecting (at Ryan's clock) overtakes them by a round trip
    expect(t.log.add(t.note(t.log.state!.lamport + 1, "back"), { remote: true }).status).toBe("added");
    t.clock.t += 2_000;
    for (let l = 3; l < 10; l++) expect(t.log.add(t.note(l, `apart ${l}`), { remote: true }).status).toBe("added");
    expect(t.log.state!.ext.limitNotes!.filter((x) => x.startsWith("apart"))).toHaveLength(7);
  });

  it("keeps the order floor still while refused events wait to be asked for again", () => {
    const t = room({ eventBurst: 5, eventsPerMinute: 60 });
    const results = Array.from({ length: 10 }, (_, i) => t.log.add(t.note(10 + i), { remote: true }).status);
    expect(results.filter((s) => s === "rejected")).toHaveLength(5);
    // a newer event gets in once there's room; the refused five come back after the grace has passed
    t.clock.t += 1_000;
    expect(t.log.add(t.note(50), { remote: true }).status).toBe("added");
    t.clock.t += 10 * MIN;
    for (let l = 15; l < 20; l++) expect(t.log.add(t.note(l), { remote: true }).status).toBe("added");
    // once nothing has been refused for a while, the floor moves on
    t.clock.t += 31 * MIN;
    expect(t.log.add(t.note(30), { remote: true })).toMatchObject({ status: "rejected", limit: "order" });
  });

  it("measures with a token bucket", () => {
    const b = new RateBucket(600, 3, 0);
    expect([b.take(0), b.take(0), b.take(0), b.take(0)]).toEqual([true, true, true, false]);
    expect(b.waitMs(0)).toBe(100);
    expect(b.waitMs(0, 200)).toBe(300); // at most a burst
    expect(b.take(100)).toBe(true);
  });
});

describe("limits between Macs", () => {
  it("refuses a peer's flood, logs it once, shows it once under the room, and asks again for the rest", async () => {
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("t"), rooms: { limits: { eventBurst: 5, eventsPerMinute: 600 } } });
    const [ryan, nick] = members;
    for (let i = 0; i < 30; i++) nick.team.publish(roomId, "limits.note", { text: `flood ${i}` });
    await until(() => !!ryan.team.status().rooms[0].warnings?.length, "the warning");
    const w = ryan.team.status().rooms[0].warnings!;
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ key: `rate:${nick.id}`, text: "Nick's Mockingbird sent more than 600 room events a minute; the rest are refused for now and asked for again shortly" });
    expect(w[0].count).toBeGreaterThan(1);
    expect(ryan.logs.filter((l) => l.startsWith("refused")).length).toBe(1);
    expect(ryan.logs.join("\n")).toMatch(/refused event \S+ \(limits\.note\): its author sent more than 600 events a minute from Nick in room \S+, over the rate limit/);
    // what was refused is asked for again as the limit allows
    await until(() => ryan.team.room(roomId)!.ext.limitNotes?.length === 30, "Ryan to have all 30", 10_000);
    expect(ryan.team.room(roomId)).toEqual(nick.team.room(roomId));
  }, 15_000);

  it("catches a member up on a long history past the per-minute limit, without refusing any", async () => {
    const net = new LoopbackNetwork();
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick", "Sam"], { dir: tempDir("t"), net, rooms: { limits: { eventBurst: 20, eventsPerMinute: 60 } } });
    const [ryan, nick, sam] = members;
    const notes = (m: typeof ryan) => m.team.room(roomId)!.ext.limitNotes?.length ?? 0;
    net.setOnline(nick.id, false);
    net.setOnline(sam.id, false);
    await until(() => ryan.team.presence(roomId).length === 0, "Nick and Sam to leave");
    // a day's work on Ryan's Mac while both are away; Sam writes on the plane too (his sort earlier than Ryan's newest)
    for (let i = 0; i < 300; i++) ryan.team.publish(roomId, "limits.note", { text: `m${i}` });
    for (let i = 0; i < 3; i++) sam.team.publish(roomId, "limits.note", { text: `plane ${i}` });
    net.setOnline(nick.id, true);
    await until(() => notes(nick) === 300, "Nick to catch up from Ryan", 10_000);
    // Ryan's laptop sleeps; Sam catches up on Ryan's work from Nick, and Nick hears Sam's
    net.setOnline(ryan.id, false);
    await until(() => nick.team.presence(roomId).length === 0, "Ryan to leave");
    net.setOnline(sam.id, true);
    await until(() => notes(sam) === 303 && notes(nick) === 303, "Sam and Nick to catch up", 10_000);
    net.setOnline(ryan.id, true);
    await until(() => notes(ryan) === 303, "Ryan to hear Sam's", 10_000);
    expect(sam.team.room(roomId)).toEqual(ryan.team.room(roomId));
    expect(nick.team.room(roomId)).toEqual(ryan.team.room(roomId));
    for (const m of members) expect(m.logs.join("\n")).not.toMatch(/refused/);
    for (const m of members) expect(m.team.status().rooms[0].warnings).toBeUndefined();
  }, 15_000);

  it("refuses a backdated event from a peer and says so under the room", async () => {
    const clock = { t: Date.now() };
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("t"), rooms: { now: () => clock.t } });
    const [ryan, nick] = members;
    const e = nick.team.publish(roomId, "limits.note", { text: "earlier" });
    await until(() => ryan.team.room(roomId)!.ext.limitNotes?.length === 1, "Ryan to hear it");
    clock.t += 6 * MIN;
    // a tampered Mockingbird on Nick's laptop places a new event before one it sent minutes ago
    const back = signed(nick.identity, roomId, "limits.note", { text: "backdated" }, e.lamport - 1, Date.now());
    (ryan.team as any).handler.frame(nick.id, JSON.stringify({ k: "ev", roomId, events: [back] }));
    expect(ryan.team.room(roomId)!.ext.limitNotes).toEqual(["earlier"]);
    expect(ryan.team.status().rooms[0].warnings).toEqual([
      expect.objectContaining({ key: `order:${nick.id}`, count: 1, text: "Nick's Mockingbird sent events placed before ones it had already sent (backdated); they were refused" }),
    ]);
    expect(ryan.logs.join("\n")).toMatch(/refused event \S+ \(limits\.note\): backdated: .* from Nick/);
  });

  it("refuses a conversation copy over the limit, shows it under the room, and holds a member to a total", () => {
    const dir = tempDir("transcripts");
    const limits = { ...ROOM_LIMITS, maxTranscriptBytes: 1_000, maxMemberTranscriptBytes: 1_500 };
    const nick = "n".repeat(32);
    const sam = "s".repeat(32);
    const copy = (session: string, from: string, bytes: number) => {
      fs.mkdirSync(path.join(dir, session), { recursive: true });
      fs.writeFileSync(path.join(dir, session, "c.jsonl"), "x".repeat(bytes));
      fs.writeFileSync(path.join(dir, session, "meta.json"), JSON.stringify({ file: "c.jsonl", from }));
    };
    const target = path.join(dir, "s1", "c.jsonl");
    expect(transcriptRefusal(dir, target, nick, 0, 900, limits)).toBeNull();
    expect(transcriptRefusal(dir, target, nick, 900, 200, limits)).toBe("a conversation copy over 1 KB");
    copy("s2", nick, 800);
    copy("s3", sam, 800);
    // Nick's other copy counts; Sam's doesn't
    expect(transcriptRefusal(dir, target, nick, 0, 600, limits)).toBeNull();
    expect(transcriptRefusal(dir, target, nick, 600, 200, limits)).toBe("more than 1.5 KB of conversation copies in this room");
    expect(transcriptRefusal(dir, target, sam, 600, 100, limits)).toBeNull();
    expect(transcriptRefusal(dir, target, sam, 600, 101, limits)).not.toBeNull();
  });
});

describe("agent messages from a teammate's Mac", () => {
  it("are paced per sending member and target session, whatever session id the sender reports", () => {
    const target = { id: "back", title: "back", status: "idle", agent: "claude", cwd: "/w", kind: "work", taskGroup: "5110" } as SessionInfo;
    const delivered: string[] = [];
    const m = new Messaging({ list: () => [target], deliverAgentMessage: (_to: string, text: string) => (delivered.push(text), "delivered") } as any, () => true, () => {});
    const nick = { id: "b".repeat(32), name: "Nick" };
    const send = (i: number, member = nick) => m.receiveRemote({ member, from: { id: `fresh-${i}`, title: "Front", agent: "claude", repo: "app", branch: "x" }, to: "back", text: `hello ${i}` }, () => true);
    const out = Array.from({ length: 10 }, (_, i) => send(i).status);
    expect(out.slice(0, 8)).toEqual(Array(8).fill("delivered"));
    expect(out.slice(8)).toEqual(["refused", "refused"]);
    expect(send(10).detail).toMatch(/hit the limit of 8 messages in 5 minutes/);
    // another member has their own allowance
    expect(send(11, { id: "c".repeat(32), name: "Sam" }).status).toBe("delivered");
    expect(delivered).toHaveLength(9);
  });
});

describe("this install's key in use somewhere else", () => {
  it("is said plainly by the signaling client, which waits before taking the room back", async () => {
    const server = await startLocalSignaling({ log: () => undefined });
    const ryan = newId("ryan");
    const salt = randomToken();
    const roomId = roomIdFor(ryan.publicKey, salt);
    const events: { who: string; t: string }[] = [];
    const logs: string[] = [];
    const mk = (who: string) => new SignalingClient({ url: server.url, roomId, identity: ryan, create: salt, onEvent: (e) => events.push({ who, t: e.t }), log: (m) => logs.push(`${who}: ${m}`), backoffMs: [50] });
    const here = mk("here");
    const elsewhere = mk("elsewhere");
    try {
      here.start();
      await until(() => here.state === "online", "this Mac online");
      elsewhere.start();
      await until(() => elsewhere.state === "online", "the other place online");
      await until(() => here.problemCode === "replaced", "this Mac to hear it was replaced");
      expect(here.problem).toBe(REPLACED);
      expect(events).toContainEqual({ who: "here", t: "replaced" });
      expect(logs.join("\n")).toMatch(/here: signaling \S+: the server closed this connection because the same key connected again from somewhere else/);
      // not straight back (the backoff here is 50 ms): the two places don't knock each other off every second
      await new Promise((r) => setTimeout(r, 400));
      expect(here.state).toBe("offline");
      expect(elsewhere.state).toBe("online");
      expect(events.filter((e) => e.who === "elsewhere" && e.t === "replaced")).toEqual([]);
    } finally {
      here.stop();
      elsewhere.stop();
      await server.close();
    }
  });

  it("shows under the room, counted, and tells the user once with a notification", async () => {
    const net = new LoopbackNetwork();
    const dir = tempDir("svc");
    const notified: { title: string; body: string }[] = [];
    const s = new TeamService({
      settings: () => ({ ...DEFAULT_SETTINGS, teamName: "Ryan", signalingUrl: "https://signal.example" }),
      localGroups: () => [],
      emit: () => {},
      log: (_c, err) => String(err),
      assetsDir: "/nonexistent",
      dir,
      wire: (identity) => net.wire(identity.id),
      notify: (title, body) => notified.push({ title, body }),
    });
    s.start();
    try {
      const { roomId } = await s.shareGroup("5110", "#5110 Donor entities");
      const handler = (s.transport as any).handler;
      handler.replaced(roomId);
      handler.replaced(roomId);
      const w = s.status().rooms[0].warnings!;
      expect(w).toEqual([expect.objectContaining({ key: "replaced", count: 2, text: `${REPLACED}. ${REPLACED_ADVICE}` })]);
      expect(notified).toEqual([{ title: "Your room identity connected from another place", body: `#5110 Donor entities: this Mac was disconnected. ${REPLACED_ADVICE}` }]);
    } finally {
      s.stop();
    }
  });
});
