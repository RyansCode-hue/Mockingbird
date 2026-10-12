import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { loopbackRoom } from "../src/main/team/loopback";
import { TeamRoom } from "../src/main/team/teamRoom";
import { Messaging } from "../src/main/messaging";
import { stopTeamRooms } from "../src/main/team/shutdown";
import type { SessionInfo } from "../src/shared/types";

const session = (status: SessionInfo["status"]): SessionInfo =>
  ({ id: "s1", title: "Export API", ticketTitle: null, repoPath: "/code/app", branch: "api", taskGroup: "5110", status, agent: "claude", cwd: "/w/s1", kind: "work", waitingReason: null }) as SessionInfo;

describe("team rooms stopping with the app", () => {
  it("posts agent updates still gathering before the transport closes, then stops the rest in order", async () => {
    const dir = tempDir("shutdown");
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir });
    const [ryan] = members;
    const sessions = [session("idle")];
    const logs: string[] = [];
    // updates gather for 30 s, as in the app
    const room = new TeamRoom({
      sessions: () => sessions,
      roomGroups: () => [{ roomId, groupKey: "5110" }],
      ask: async () => "unused",
      houseBoard: async () => null,
      chatChanged: () => {},
      notify: () => {},
      windowFocused: () => false,
      log: (m) => logs.push(m),
      dir: path.join(dir, "chat"),
      updates: { groupMs: 30_000, minGapMs: 30_000 },
    });
    room.start(ryan.team, new Messaging({ list: () => sessions, deliverAgentMessage: () => "delivered" } as any, () => true, () => {}));
    sessions[0] = session("working");
    room.sessionsChanged(); // "started", gathering
    const order: string[] = [];
    const part = (name: string, stop?: () => void) => ({ stop: () => (order.push(name), stop?.()), close: () => (order.push(name), stop?.()) });
    stopTeamRooms(
      {
        livePanes: part("live panes"),
        chat: part("chat", () => room.stop()),
        house: part("house", () => {
          throw new Error("house stop failed");
        }),
        takeover: () => part("take-over"),
        team: part("team", () => ryan.team.close()),
      },
      (c, e) => logs.push(`${c}: ${(e as Error).message}`)
    );
    expect(order).toEqual(["live panes", "chat", "house", "take-over", "team"]);
    // the update went into the room log (teammates get it on the next sync), nothing failed to post
    expect(ryan.store.get(roomId)!.all().some((e) => e.type === "chat.update" && e.author === ryan.id)).toBe(true);
    expect(logs.filter((l) => /failed/.test(l))).toEqual(["team: stopping the House board: house stop failed"]);
  });
});
