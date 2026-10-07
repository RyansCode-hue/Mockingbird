import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { TeamService } from "../src/main/team/service";
import { LoopbackNetwork, until } from "../src/main/team/loopback";
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/types";
import type { TeamStatus } from "../src/shared/team/types";

/** The app's team service over the loopback: what the window asks for. */
function service(net: LoopbackNetwork, name: string, o: { settings?: Partial<Settings>; groups?: string[] } = {}) {
  const dir = path.join(tempDir(name), "team");
  const settings: Settings = { ...DEFAULT_SETTINGS, teamName: name, signalingUrl: "https://signal.example", ...o.settings };
  const emitted: TeamStatus[] = [];
  const logs: string[] = [];
  const s = new TeamService({
    settings: () => settings,
    localGroups: () => o.groups ?? [],
    emit: (st) => emitted.push(st),
    log: (ctx, err) => (logs.push(`${ctx}: ${err instanceof Error ? err.message : String(err)}`), String(err)),
    assetsDir: "/nonexistent",
    dir,
    wire: (identity) => net.wire(identity.id),
  });
  s.start();
  return { s, settings, emitted, logs, dir };
}

describe("the team service", () => {
  it("shares a group as a room once, then hands out fresh invites to it", () => {
    const net = new LoopbackNetwork();
    const { s } = service(net, "Ryan");
    const a = s.shareGroup("5110", "#5110 Donor entities");
    const b = s.shareGroup("5110", "#5110 Donor entities");
    expect(b.roomId).toBe(a.roomId);
    expect(b.invite).not.toBe(a.invite);
    const st = s.status();
    expect(st.self).toMatchObject({ name: "Ryan" });
    expect(st.rooms).toEqual([expect.objectContaining({ id: a.roomId, name: "#5110 Donor entities", groupKey: "5110", signalingUrl: "https://signal.example" })]);
    expect(() => s.shareGroup("ungrouped", "ungrouped")).toThrow(/named group/);
  });

  it("needs a signaling URL to share", () => {
    const { s } = service(new LoopbackNetwork(), "Ryan", { settings: { signalingUrl: "" } });
    expect(() => s.shareGroup("5110", "x")).toThrow(/signaling URL in Settings → Team/);
  });

  it("shows a joined room as its group, or beside a private group of the same name", async () => {
    const net = new LoopbackNetwork();
    const ryan = service(net, "Ryan");
    const nick = service(net, "Nick", { groups: ["5110"] }); // Nick already has a private group 5110
    const { invite, roomId } = ryan.s.shareGroup("5110", "#5110 Donor entities");
    nick.s.join(invite);
    await until(() => nick.s.status().rooms.length === 1, "the join");
    expect(nick.s.status().rooms[0]).toMatchObject({ id: roomId, groupKey: "5110 (team)", members: [{ name: "Ryan" }, { name: "Nick", self: true }] });
    await until(() => nick.emitted.some((st) => st.rooms.length === 1), "the window to hear of it");
  });

  it("keeps a room with its group through a rename, and tells rooms a new display name", async () => {
    const net = new LoopbackNetwork();
    const ryan = service(net, "Ryan");
    const nick = service(net, "Nick");
    const { invite, roomId } = ryan.s.shareGroup("5110", "#5110");
    nick.s.join(invite);
    await until(() => nick.s.status().rooms.length === 1, "the join");
    ryan.s.groupRenamed("5110", "Donors");
    expect(ryan.s.status().rooms[0].groupKey).toBe("Donors");
    expect(ryan.s.shareGroup("Donors", "Donors").roomId).toBe(roomId);
    const before = { ...ryan.settings };
    ryan.settings.teamName = "Ryan E";
    ryan.s.settingsChanged(before, ryan.settings);
    await until(() => nick.s.status().rooms[0].members[0].name === "Ryan E", "the new name");
  });

  it("the sidebar finds a group's room and shows teammates by initials", async () => {
    const { initialsOf, roomOfGroup } = await import("../src/renderer/Team");
    expect(["Nick Smith", "nick", " Sam  de Vries ", ""].map(initialsOf)).toEqual(["NS", "N", "SV", "?"]);
    const net = new LoopbackNetwork();
    const ryan = service(net, "Ryan");
    ryan.s.shareGroup("5110", "#5110");
    expect(roomOfGroup(ryan.s.status(), "5110")?.name).toBe("#5110");
    expect(roomOfGroup(ryan.s.status(), "5101")).toBeUndefined();
    expect(roomOfGroup({ error: "x" }, "5110")).toBeUndefined();
  });

  it("reports an unreadable identity instead of making a new one", () => {
    const net = new LoopbackNetwork();
    const dir = path.join(tempDir("bad"), "team");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "identity.json"), "garbage");
    const s = new TeamService({ settings: () => DEFAULT_SETTINGS, localGroups: () => [], emit: () => undefined, log: (_c, e) => String(e), assetsDir: "", dir, wire: (i) => net.wire(i.id) });
    s.start();
    expect(s.status()).toMatchObject({ self: null, error: expect.stringMatching(/unreadable/) });
    expect(() => s.shareGroup("5110", "x")).toThrow(/unreadable/);
    expect(s.transport).toBeNull();
  });
});
