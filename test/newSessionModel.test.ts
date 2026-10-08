import { describe, expect, it } from "vitest";
import { localTops, repoChoices, roomRepoNames, seedWhere, workspacesOf } from "../src/renderer/newSessionModel";
import type { RepoEntry, SessionInfo } from "../src/shared/types";
import type { TeamRoomSummary } from "../src/shared/team/types";

const room = (groupKey: string): TeamRoomSummary => ({ id: `R${groupKey}`, name: `#${groupKey} room`, groupKey, members: [], online: [], signalingUrl: "", signaling: "online" });
const rooms = [room("5101"), room("5110")];
const groups = ["5101", "5101/api", "5102", "5102/ui", "5102/ui", "spike"];
const repo = (name: string): RepoEntry => ({ name, path: `/code/${name}`, root: "/code" });
const session = (over: Partial<SessionInfo>) => ({ id: "s", title: "t", repoPath: null, ...over }) as SessionInfo;

describe("where a new session starts", () => {
  it("is a connected session when seeded from a team room's group or one of its workspaces", () => {
    expect(seedWhere("5101", rooms)).toEqual({ connected: true, top: "5101", sub: "" });
    expect(seedWhere("5101/api", rooms)).toEqual({ connected: true, top: "5101", sub: "api" });
  });

  it("is local when seeded from any other group, or from none", () => {
    expect(seedWhere("5102/ui", rooms)).toEqual({ connected: false, top: "5102", sub: "ui" });
    expect(seedWhere(undefined, rooms)).toEqual({ connected: false, top: "", sub: "" });
    expect(seedWhere("5101", [])).toEqual({ connected: false, top: "5101", sub: "" });
  });
});

describe("the groups a session can join", () => {
  it("offers local groups without the team rooms', which are picked as connected", () => {
    expect(localTops(groups, rooms)).toEqual(["5102", "spike"]);
  });

  it("lists a group's workspaces once each", () => {
    expect(workspacesOf(groups, "5102")).toEqual(["ui"]);
    expect(workspacesOf(groups, "5101")).toEqual(["api"]);
    expect(workspacesOf(groups, "spike")).toEqual([]);
  });
});

describe("repos a connected session is offered first", () => {
  it("are the ones the room's sessions work in, teammates' included, by folder name", () => {
    const sessions = [
      session({ taskGroup: "5101", repoPath: "/Users/me/Code/backoffice" }),
      session({ taskGroup: "5101/api", room: { repoName: "client-portal" } as SessionInfo["room"] }),
      session({ taskGroup: "5101", repoPath: "/Users/me/Code/backoffice" }),
      session({ taskGroup: "5102", repoPath: "/Users/me/Code/pathlight" }),
      session({ repoPath: "/Users/me/Code/loose" }),
    ];
    expect(roomRepoNames(sessions, rooms)).toEqual({ "5101": ["backoffice", "client-portal"], "5110": [] });
  });

  it("lead the matching repos, the rest in their order, up to the limit", () => {
    const repos = ["atticus", "backoffice", "client-portal", "pathlight"].map(repo);
    expect(repoChoices(repos, "", ["client-portal"]).map((c) => [c.repo.name, c.suggested])).toEqual([
      ["client-portal", true],
      ["atticus", false],
      ["backoffice", false],
      ["pathlight", false],
    ]);
    expect(repoChoices(repos, "ATH", ["client-portal"]).map((c) => c.repo.name)).toEqual(["pathlight"]);
    expect(repoChoices(repos, "", [], 2)).toHaveLength(2);
  });
});
