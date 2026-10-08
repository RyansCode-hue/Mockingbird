import { describe, expect, it } from "vitest";
import { localTops, newRoomOf, newRoomPlan, repoChoices, repoOfFolder, roomRepoNames, seedWhere, workspacesOf } from "../src/renderer/newSessionModel";
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

describe("a new room's group and name", () => {
  it("keys the group by a leading ticket number and names the room as the sidebar titles a ticket's group", () => {
    expect(newRoomOf("5120 Donor search")).toEqual({ key: "5120", title: "#5120 Donor search" });
    expect(newRoomOf("  #5120   Donor  search ")).toEqual({ key: "5120", title: "#5120 Donor search" });
    expect(newRoomOf("5120: Donor search")).toEqual({ key: "5120", title: "#5120 Donor search" });
    expect(newRoomOf("5120 - Donor search")).toEqual({ key: "5120", title: "#5120 Donor search" });
    expect(newRoomOf("5120 — Donor search")).toEqual({ key: "5120", title: "#5120 Donor search" });
    expect(newRoomOf("5120")).toEqual({ key: "5120", title: "#5120" });
    expect(newRoomOf("#5120")).toEqual({ key: "5120", title: "#5120" });
  });

  it("uses any other name for both, as one group segment", () => {
    expect(newRoomOf("Spike")).toEqual({ key: "Spike", title: "Spike" });
    expect(newRoomOf("Donor search spike")).toEqual({ key: "Donor search spike", title: "Donor search spike" });
    expect(newRoomOf("api/v2")).toEqual({ key: "api-v2", title: "api-v2" });
    expect(newRoomOf("2026-planning")).toEqual({ key: "2026-planning", title: "2026-planning" });
    expect(newRoomOf("5120abc")).toEqual({ key: "5120abc", title: "5120abc" });
  });

  it("is nothing until a name is typed", () => {
    expect(newRoomOf("")).toBeNull();
    expect(newRoomOf("   ")).toBeNull();
  });
});

describe("what Start does with + New room", () => {
  it("makes a room for a group that isn't one yet, saying when this Mac already has the group", () => {
    expect(newRoomPlan("5120 Donor search", rooms, groups)).toEqual({ kind: "create", key: "5120", title: "#5120 Donor search", localGroup: false });
    expect(newRoomPlan("5102 Pathways", rooms, groups)).toEqual({ kind: "create", key: "5102", title: "#5102 Pathways", localGroup: true });
    expect(newRoomPlan("spike", rooms, groups)).toMatchObject({ kind: "create", localGroup: true });
  });

  it("starts in the room a group already is instead of making a second", () => {
    expect(newRoomPlan("5101 anything", rooms, groups)).toEqual({ kind: "existing", key: "5101", room: rooms[0] });
  });

  it("treats a joined room shown beside a private group of its name as separate from that group", () => {
    const joined = [{ ...room("5110"), groupKey: "5110 (team)" }];
    expect(newRoomPlan("5110", joined, ["5110", "5110 (team)"])).toMatchObject({ kind: "create", key: "5110", localGroup: true });
  });

  it("never shares the sidebar's own buckets, and waits for a name", () => {
    expect(newRoomPlan("ungrouped", rooms, groups)).toEqual({ kind: "reserved", key: "ungrouped" });
    expect(newRoomPlan("assistant", rooms, groups)).toEqual({ kind: "reserved", key: "assistant" });
    expect(newRoomPlan(" ", rooms, groups)).toEqual({ kind: "unnamed" });
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

describe("the repo an imported conversation belongs to", () => {
  const repos = [{ name: "backoffice", path: "/Users/me/Code/backoffice", root: "/Users/me/Code" }, { name: "web", path: "/Users/me/Code/backoffice/web", root: "/Users/me/Code" }];

  it("is the repo its folder is, or is in — the innermost one", () => {
    expect(repoOfFolder(repos, "/Users/me/Code/backoffice")).toEqual({ repo: repos[0], worktree: null });
    expect(repoOfFolder(repos, "/Users/me/Code/backoffice/src/api")).toEqual({ repo: repos[0], worktree: null });
    expect(repoOfFolder(repos, "/Users/me/Code/backoffice/web/app")).toEqual({ repo: repos[1], worktree: null });
  });

  it("is the repo a Mockingbird worktree was cut from, with the worktree's folder", () => {
    expect(repoOfFolder(repos, "/Users/me/Code/worktrees/backoffice/5101-orgDropdowns")).toEqual({ repo: repos[0], worktree: "5101-orgDropdowns" });
  });

  it("is none for a folder outside every repo, or a prefix that isn't a folder of it", () => {
    expect(repoOfFolder(repos, "/Users/me/Code/backoffice-old")).toBeNull();
    expect(repoOfFolder(repos, "/Users/me/notes")).toBeNull();
    expect(repoOfFolder(repos, "/Users/me/Code/worktrees/gone/x")).toBeNull();
  });
});
