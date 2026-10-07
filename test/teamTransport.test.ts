import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { LoopbackNetwork, loopbackMember, loopbackRoom, until } from "../src/main/team/loopback";
import { TeamCore, TeamError } from "../src/main/team/transport";
import { defineEventType, RoomStore } from "../src/main/team/rooms";
import { MAX_STREAM_CHUNK } from "../src/main/team/frames";
import { encodeInvite, decodeInvite, TEAM_PROTOCOL } from "../src/shared/team/protocol";
import type { RoomEvent } from "../src/shared/team/types";

declare module "../src/shared/team/types" {
  interface RoomEventBodies {
    "chat.test": { text: string };
  }
  interface RoomExtensions {
    chatTest: string[];
  }
}
defineEventType("chat.test", {
  reduce(state, e) {
    (state.ext.chatTest ??= []).push(e.body.text);
  },
});

describe("the team transport over the loopback", () => {
  it("joins a room by invite code: every member has the room, the members and each other", async () => {
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("t") });
    const [ryan, nick] = members;
    for (const m of members) {
      expect(m.team.room(roomId)!.members.map((x) => x.name)).toEqual(["Ryan", "Nick"]);
    }
    expect(ryan.team.presence(roomId)).toEqual([nick.id]);
    expect(nick.team.presence(roomId)).toEqual([ryan.id]);
    expect(nick.team.status().pending).toEqual([]);
    expect(nick.store.meta(roomId)).toEqual({ signalingUrl: "http://loopback.invalid", groupKey: "5110" });
    expect(ryan.team.peers()).toEqual([{ id: nick.id, name: "Nick", state: "direct", since: 0 }]);
  });

  it("publishes events to every member, including the publisher's own handlers", async () => {
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("t") });
    const [ryan, nick] = members;
    const seen: Record<string, string[]> = { ryan: [], nick: [] };
    ryan.team.onEvent("chat.test", (e) => seen.ryan.push(`${e.author === ryan.id ? "me" : "them"}:${e.body.text}`));
    nick.team.onEvent("chat.test", (e, room) => seen.nick.push(`${room.members.find((m) => m.id === e.author)!.name}:${e.body.text}`));
    const e = ryan.team.publish(roomId, "chat.test", { text: "hello" });
    expect(e.author).toBe(ryan.id);
    await until(() => seen.nick.length === 1, "Nick to hear it");
    expect(seen).toEqual({ ryan: ["me:hello"], nick: ["Ryan:hello"] });
    expect(nick.team.room(roomId)!.ext.chatTest).toEqual(["hello"]);
    expect(() => ryan.team.publish("x".repeat(22), "chat.test", { text: "nope" })).toThrow(TeamError);
  });

  it("merges what each side published while apart when they reconnect", async () => {
    const { members, roomId, net } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("t") });
    const [ryan, nick] = members;
    net.setOnline(nick.id, false);
    await until(() => ryan.team.presence(roomId).length === 0, "Nick to drop");
    ryan.team.publish(roomId, "chat.test", { text: "while you were out" });
    nick.team.publish(roomId, "chat.test", { text: "on the plane" });
    net.setOnline(nick.id, true);
    await until(() => ryan.team.room(roomId)!.ext.chatTest?.length === 2 && nick.team.room(roomId)!.ext.chatTest?.length === 2, "both to have both");
    expect(ryan.team.room(roomId)).toEqual(nick.team.room(roomId));
  });

  it("passes events on to members who aren't directly connected", async () => {
    const { members, roomId, net } = await loopbackRoom(["Ryan", "Nick", "Sam"], { dir: tempDir("t") });
    const [ryan, nick, sam] = members;
    net.partition(ryan.id, sam.id);
    await until(() => !ryan.team.presence(roomId).includes(sam.id), "the partition");
    ryan.team.publish(roomId, "chat.test", { text: "via Nick" });
    await until(() => sam.team.room(roomId)!.ext.chatTest?.[0] === "via Nick", "Sam to hear it through Nick");
    void nick;
  });

  it("says who's connected, and when that changes", async () => {
    const { members, roomId, net } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("t") });
    const [ryan, nick] = members;
    const changes: string[][] = [];
    ryan.team.onPresence((r, online) => r === roomId && changes.push(online));
    net.setOnline(nick.id, false);
    await until(() => changes.length === 1, "a presence change");
    net.setOnline(nick.id, true);
    await until(() => changes.length === 2, "another");
    expect(changes).toEqual([[], [nick.id]]);
    expect(ryan.team.status().rooms[0]).toMatchObject({ id: roomId, online: [nick.id], groupKey: "5110", signaling: "online" });
  });

  it("answers requests, and fails them clearly: no handler, a thrown error, a timeout, offline, a dropped connection", async () => {
    const { members, roomId, net } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("t") });
    const [ryan, nick] = members;
    nick.team.onRequest("transcript", (params, ctx) => ({ asked: params.session, by: ctx.from, room: ctx.roomId, text: "y".repeat(200_000) }));
    nick.team.onRequest("boom", () => {
      throw new Error("disk full");
    });
    nick.team.onRequest("never", () => new Promise(() => undefined));
    const r = await ryan.team.request<{ asked: string; by: string; room: string; text: string }>(nick.id, "transcript", { session: "s1" }, { roomId });
    expect(r).toMatchObject({ asked: "s1", by: ryan.id, room: roomId });
    expect(r.text).toHaveLength(200_000); // bigger than one message: sent in parts
    await expect(ryan.team.request(nick.id, "nothing")).rejects.toMatchObject({ code: "no-handler" });
    await expect(ryan.team.request(nick.id, "boom")).rejects.toMatchObject({ code: "remote", message: "disk full" });
    expect(nick.logs.join("\n")).toMatch(/answering boom for Ryan failed: disk full/);
    await expect(ryan.team.request(nick.id, "never", null, { timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
    const pending = ryan.team.request(nick.id, "never", null, { timeoutMs: 5000 });
    net.setOnline(nick.id, false);
    await expect(pending).rejects.toMatchObject({ code: "disconnected" });
    await expect(ryan.team.request(nick.id, "transcript")).rejects.toMatchObject({ code: "offline" });
    expect(() => nick.team.onRequest("boom", () => 1)).toThrow(/already registered/);
  });

  it("refuses a request naming a room the caller isn't in", async () => {
    const dir = tempDir("t");
    const net = new LoopbackNetwork();
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir, net });
    const [ryan, nick] = members;
    // a second room with Sam only: Ryan and Sam connect, Sam asks about room one
    const sam = loopbackMember(net, "Sam", dir);
    const other = ryan.team.createRoom({ name: "other", groupKey: "other", signalingUrl: "http://loopback.invalid" });
    sam.team.join(ryan.team.createInvite(other.id));
    await until(() => ryan.team.presence(other.id).includes(sam.id), "Sam to connect");
    ryan.team.onRequest("secret", () => "the plan");
    await expect(sam.team.request(ryan.id, "secret", null, { roomId })).rejects.toMatchObject({ code: "forbidden" });
    expect(await nick.team.request(ryan.id, "secret", null, { roomId })).toBe("the plan");
  });

  it("streams in order to connected members; a full pipe drops, says so, drains, and the receiver sees the gap", async () => {
    const { members, roomId, net } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("t") });
    const [ryan, nick] = members;
    const got: { chunk: string; seq: number; gap: boolean; from: string }[] = [];
    nick.team.onStream("pane:*", (chunk, ctx) => got.push({ chunk, seq: ctx.seq, gap: ctx.gap, from: ctx.from }));
    const s = ryan.team.stream(roomId, "pane:s1");
    expect(s.write("one")).toBe(true);
    expect(s.write("two")).toBe(true);
    await until(() => got.length === 2, "two chunks");
    net.congest(ryan.id, nick.id, true);
    expect(s.congested).toBe(true);
    expect(s.write("lost")).toBe(false);
    let drained = false;
    s.onDrain(() => (drained = true));
    net.congest(ryan.id, nick.id, false);
    await until(() => drained, "the drain");
    s.write("three");
    s.write("z".repeat(70_000)); // split into pieces, each its own sequence number
    await until(() => got.length === 3 + Math.ceil(70_000 / MAX_STREAM_CHUNK), "the rest");
    expect(got.slice(0, 3).map((g) => [g.chunk, g.seq, g.gap])).toEqual([["one", 1, false], ["two", 2, false], ["three", 4, true]]);
    expect(got.slice(3).map((g) => g.chunk).join("")).toBe("z".repeat(70_000));
    expect(got.every((g) => g.from === ryan.id)).toBe(true);
  });

  it("refuses a join with a wrong, used or expired code, and says why on the joiner's side", async () => {
    const dir = tempDir("t");
    const net = new LoopbackNetwork();
    let now = Date.now();
    const ryan = loopbackMember(net, "Ryan", dir, { now: () => now });
    const room = ryan.team.createRoom({ name: "5110", groupKey: "5110", signalingUrl: "http://loopback.invalid" });
    const code = ryan.team.createInvite(room.id);
    // a code with the right room but a made-up token
    const forged = encodeInvite({ ...decodeInvite(code), token: decodeInvite(ryan.team.createInvite(room.id)).token.replace(/^./, (c) => (c === "A" ? "B" : "A")) });
    const mallory = loopbackMember(net, "Mallory", dir);
    mallory.team.join(forged);
    await until(() => mallory.team.status().pending[0]?.state === "rejected", "the refusal");
    expect(mallory.team.status().pending[0].reason).toMatch(/isn't valid/);
    expect(ryan.team.room(room.id)!.members).toHaveLength(1);
    // used once, then not again
    const nick = loopbackMember(net, "Nick", dir);
    nick.team.join(code);
    await until(() => !!nick.team.room(room.id), "Nick to join");
    const sam = loopbackMember(net, "Sam", dir);
    sam.team.join(code);
    await until(() => sam.team.status().pending[0]?.state === "rejected", "Sam's refusal");
    expect(sam.team.status().pending[0].reason).toMatch(/already used/);
    sam.team.cancelJoin(room.id);
    expect(sam.team.status().pending).toEqual([]);
    // expired
    const late = ryan.team.createInvite(room.id);
    now += 8 * 24 * 3_600_000;
    const lee = loopbackMember(net, "Lee", dir);
    lee.team.join(late);
    await until(() => lee.team.status().pending[0]?.state === "rejected", "Lee's refusal");
    expect(lee.team.status().pending[0].reason).toMatch(/expired/);
    // your own code, a room you're in
    expect(() => ryan.team.join(late)).toThrow(/own room/);
    expect(() => nick.team.join(late)).toThrow(/already in/);
  });

  it("waits for the inviter to come online before joining", async () => {
    const dir = tempDir("t");
    const net = new LoopbackNetwork();
    const ryan = loopbackMember(net, "Ryan", dir);
    const room = ryan.team.createRoom({ name: "5110", groupKey: "5110", signalingUrl: "http://loopback.invalid" });
    const code = ryan.team.createInvite(room.id);
    net.setOnline(ryan.id, false);
    const nick = loopbackMember(net, "Nick", dir);
    nick.team.join(code);
    await new Promise((r) => setTimeout(r, 30));
    expect(nick.team.status().pending[0]).toMatchObject({ roomId: room.id, state: "waiting", name: "5110" });
    net.setOnline(ryan.id, true);
    await until(() => !!nick.team.room(room.id), "the join once Ryan is back");
  });

  it("refuses events from a peer that isn't a member, and frames before its hello", async () => {
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("t") });
    const [ryan, nick] = members;
    const before = ryan.team.room(roomId)!.events;
    // Nick's wire delivers a frame naming a room Nick isn't in
    (ryan.team as any).handler.frame(nick.id, JSON.stringify({ k: "ev", roomId: "Q".repeat(22), events: [] }));
    expect(ryan.logs.join("\n")).toMatch(/refused events for room Q+ from Nick, who isn't a member/);
    (ryan.team as any).handler.frame("e".repeat(32), JSON.stringify({ k: "ev", roomId, events: [] }));
    expect(ryan.logs.join("\n")).toMatch(/before its hello/);
    expect(ryan.team.room(roomId)!.events).toBe(before);
  });

  it("shows a teammate on another protocol as needing an update", async () => {
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("t") });
    const [ryan, nick] = members;
    (ryan.team as any).handler.frame(nick.id, JSON.stringify({ k: "hello", team: TEAM_PROTOCOL + 1, name: "Nick", rooms: [roomId] }));
    await until(() => ryan.team.peers()[0]?.state === "needs-update", "the version check");
    expect(ryan.team.peers()[0].detail).toMatch(/This Mockingbird needs an update/);
    expect(ryan.team.presence(roomId)).toEqual([]);
  });

  it("tells every room when the display name changes", async () => {
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("t") });
    const [ryan, nick] = members;
    ryan.rename("Ryan E");
    ryan.team.nameChanged();
    await until(() => nick.team.room(roomId)!.members[0].name === "Ryan E", "the rename");
  });

  it("keeps rooms across a restart and catches up on reconnect", async () => {
    const dir = tempDir("t");
    const net = new LoopbackNetwork();
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir, net });
    const [ryan, nick] = members;
    nick.team.close();
    await until(() => ryan.team.presence(roomId).length === 0, "Nick to leave");
    ryan.team.publish(roomId, "chat.test", { text: "missed" });
    // Nick's app starts again: same identity, rooms read back from disk, a fresh wire
    const reopened = new RoomStore(nick.store.dir).load();
    const nick2 = new TeamCore({ identity: nick.identity, store: reopened, wire: net.wire(nick.id), name: () => "Nick", log: () => undefined });
    expect(nick2.room(roomId)!.members).toHaveLength(2);
    await until(() => nick2.room(roomId)!.ext.chatTest?.[0] === "missed", "the missed event");
    const events: RoomEvent[] = [];
    nick2.onEvent("*", (e) => events.push(e));
    ryan.team.publish(roomId, "chat.test", { text: "live" });
    await until(() => events.length === 1, "a live event");
  });
});
