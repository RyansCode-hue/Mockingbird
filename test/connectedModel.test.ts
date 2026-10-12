import { describe, expect, it } from "vitest";
import { connectedSummary, firstName, listNames, roomPresence, roomRowLine } from "../src/renderer/team/connectedModel";
import type { RoomSessionTag } from "../src/shared/team/livePanes";
import type { TeamRoomSummary } from "../src/shared/team/types";

const tag = (over: Partial<RoomSessionTag> = {}): RoomSessionTag => ({
  roomId: "R1",
  sessionId: "x",
  owner: "nick",
  ownerName: "Nick Smith",
  remote: true,
  online: true,
  live: true,
  lookers: [],
  cols: 120,
  rows: 32,
  git: null,
  repo: null,
  repoName: null,
  guards: { secrets: true, coauthors: true },
  ...over,
});

const room = (id: string, online: string[], over: Partial<TeamRoomSummary> = {}): TeamRoomSummary => ({
  id,
  name: `#${id}`,
  groupKey: id,
  members: [
    { id: "me", name: "Ryan", self: true },
    { id: "nick", name: "Nick Smith", self: false },
    { id: "sam", name: "Sam", self: false },
  ],
  online,
  signalingUrl: "",
  signaling: "online",
  ...over,
});

describe("names in words", () => {
  it("uses first names, joined the way a sentence would", () => {
    expect(["Nick Smith", " Sam ", "nicknewberry"].map(firstName)).toEqual(["Nick", "Sam", "nicknewberry"]);
    expect([[], ["Nick"], ["Nick", "Sam"], ["Nick", "Sam", "Lee"]].map(listNames)).toEqual(["", "Nick", "Nick and Sam", "Nick, Sam and Lee"]);
  });
});

describe("a room session's second line", () => {
  it("says whose it is and whether it runs, instead of the owner's initials", () => {
    expect(roomRowLine(tag())).toBe("Nick's session · live");
    expect(roomRowLine(tag({ online: false }))).toBe("Nick's session · offline");
    expect(roomRowLine(tag({ live: false }))).toBe("Nick's session · closed there");
  });
  it("says who's looking at it in words, instead of the lookers' initials, once when the owner is the one looking", () => {
    expect(roomRowLine(tag({ lookers: [{ id: "nick", name: "Nick Smith", focused: false }] }))).toBe("Nick's session · live · Nick has it open");
    expect(roomRowLine(tag({ remote: false, ownerName: "Ryan", lookers: [{ id: "nick", name: "Nick Smith", focused: true }] }))).toBe("Your session · Nick is in it");
    expect(
      roomRowLine(
        tag({
          lookers: [
            { id: "sam", name: "Sam", focused: true },
            { id: "lee", name: "Lee Park", focused: true },
            { id: "kim", name: "Kim", focused: false },
          ],
        })
      )
    ).toBe("Nick's session · live · Sam and Lee are in it · Kim has it open");
  });
  it("says when a teammate continued this Mac's copy", () => {
    expect(roomRowLine(tag({ remote: false, ownerName: "Ryan", takenOver: { by: "nick", byName: "Nick Smith", at: 0 } }))).toBe("Your session · continued by Nick");
  });
});

describe("a room's presence", () => {
  it("names who's online instead of a 'shared' badge and initials", () => {
    expect(roomPresence(room("5101", ["nick"]))).toBe("Shared room · Nick online");
    expect(roomPresence(room("5101", ["nick", "sam"]))).toBe("Shared room · Nick and Sam online");
    expect(roomPresence(room("5101", []))).toBe("Shared room · no one else online");
    expect(roomPresence(room("5101", [], { members: [{ id: "me", name: "Ryan", self: true }] }))).toBe("Shared room · just you so far");
  });
  it("says when the room can't reach its server", () => {
    expect(roomPresence(room("5101", ["nick"], { signaling: "connecting" }))).toBe("Shared room · connecting…");
    expect(roomPresence(room("5101", ["nick"], { signaling: "offline" }))).toBe("Shared room · can't reach the server");
  });
});

describe("the Sessions view's Connected sessions line", () => {
  const remote = (roomId: string, live = true) => ({ room: tag({ roomId, live }) });
  it("counts teammates' running sessions across rooms and each teammate online once", () => {
    const s = connectedSummary([room("5101", ["nick"]), room("5110", ["nick", "sam"])], [remote("5101"), remote("5110"), remote("5110", false), { room: tag({ roomId: "5101", remote: false }) }, {}]);
    expect(s).toMatchObject({ live: 2, online: ["Nick", "Sam"], rooms: 2, title: "Connected sessions · 2", sub: "Nick and Sam online · 2 rooms", roomId: null });
  });
  it("opens the only room straight away, and says when no one is online", () => {
    expect(connectedSummary([room("5101", [])], [])).toMatchObject({ title: "Connected sessions · 0", sub: "no one online · 1 room", roomId: "5101" });
  });
  it("leaves out sessions of rooms this Mac has left", () => {
    expect(connectedSummary([room("5101", [])], [remote("gone")]).live).toBe(0);
  });
});
