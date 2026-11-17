import { describe, expect, it } from "vitest";
import type { AssistantWindowAction } from "../src/shared/assistant";
import type { SessionInfo } from "../src/shared/types";
import type { AssistantDeps, AssistantSession } from "../src/main/assistant/deps";
import { buildRegistry, Registry, validateArgs, type AssistantTool } from "../src/main/assistant/registry";
import * as groups from "../src/main/assistant/tools";
import { worldGroups, worldRooms, worldSessions } from "../src/main/assistant/world";
import { fakeTool, rulesFor } from "./assistantHarness";
import { unusedWorkDeps } from "./assistantWorkFakes";
import { unusedToolDeps } from "./assistantWorld";

const mine = (id: string, over: Partial<AssistantSession> = {}): AssistantSession => ({
  id,
  title: id,
  agent: "claude",
  status: "idle",
  waitingReason: null,
  waitingSince: null,
  group: "atticus",
  room: null,
  repo: "atticus",
  branch: "main",
  model: "sonnet",
  permissionMode: "default",
  mine: true,
  helpdesk: false,
  ...over,
});

function tools(sessions: AssistantSession[], over: Partial<AssistantDeps> = {}) {
  const did: string[] = [];
  const d: AssistantDeps = {
    sessions: () => sessions,
    groups: () => [],
    rooms: () => [],
    toWindow: (a: AssistantWindowAction) => void did.push(JSON.stringify(a)),
    rename: (id, title) => {
      did.push(`rename ${id} ${title}`);
      sessions.find((s) => s.id === id)!.title = title;
    },
    relaunchRefusal: () => null,
    relaunch: async (id) => void did.push(`relaunch ${id}`),
    rules: rulesFor({ sessions: () => sessions, groups: () => [] }).engine,
    ...unusedWorkDeps(),
    ...unusedToolDeps(),
    ...over,
  };
  const r = buildRegistry(d, Object.values(groups));
  return { did, tool: (name: string) => r.get(name)!, registry: r };
}

describe("the Assistant's first tools", () => {
  it("are one registry with their tiers fixed: reads, direct changes and a confirm", () => {
    const { registry } = tools([]);
    expect(Object.fromEntries(registry.list().map((t) => [t.name, t.tier]))).toMatchObject({
      list_sessions: "read",
      restart_session: "confirm",
      list_groups: "read",
      landscape: "read",
      focus_session: "direct",
      rename_session: "direct",
      list_rules: "read",
      propose_rule: "confirm",
      change_rule: "confirm",
      set_rule_on: "direct",
      remove_rule: "direct",
      move_workspace: "direct",
      stack_workspaces: "direct",
      unstack: "direct",
      size_workspace: "direct",
      tidy_area: "direct",
      set_group: "direct",
      create_group: "direct",
      rename_group: "direct",
      mute_session: "direct",
      unmute: "direct",
      list_wires: "read",
      add_wire: "direct",
      remove_wire: "direct",
      send_handoff: "confirm",
      approve_gate: "confirm",
      house_board: "read",
      share_group: "confirm",
      leave_room: "confirm",
      take_over: "confirm",
      set_room_sandbox: "confirm",
      claim_ticket: "confirm",
      release_ticket: "confirm",
      get_settings: "read",
      set_setting: "direct",
    });
    for (const t of registry.mcpTools()) expect(t.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("list_sessions gives each session's state, whose it is and the Helpdesk flag, never its output", async () => {
    const sessions = [
      mine("a1", { status: "waiting", waitingReason: "Claude needs your permission to use Bash", waitingSince: Date.UTC(2026, 10, 16, 12), permissionMode: "plan" }),
      mine("b2", { mine: false, owner: "Nick", room: "Atticus team", agent: "codex" }),
      mine("c3", { helpdesk: true, title: "Helpdesk" }),
    ];
    const r = await tools(sessions).tool("list_sessions").run({});
    const out = JSON.parse(r.text).sessions;
    expect(out[0]).toEqual({
      id: "a1",
      title: "a1",
      agent: "claude",
      status: "waiting",
      waiting: { reason: "Claude needs your permission to use Bash", since: "2026-11-16T12:00:00.000Z" },
      group: "atticus",
      room: null,
      repo: "atticus",
      branch: "main",
      model: "sonnet",
      permissionMode: "plan",
      mine: true,
    });
    expect(out[1]).toMatchObject({ mine: false, owner: "Nick", room: "Atticus team", agent: "codex" });
    expect(out[2]).toMatchObject({ helpdesk: true });
    expect(r.undo).toBeUndefined();
  });

  it("focus_session asks the window to focus the session, a teammate's too; an unknown id is refused", async () => {
    const t = tools([mine("a1"), mine("b2", { mine: false, owner: "Nick" })]);
    const focus = t.tool("focus_session");
    expect(await focus.check!({ session: "zz" })).toContain("no session with id");
    expect(await focus.check!({ session: "b2" })).toBeNull();
    await focus.run({ session: "b2" });
    expect(t.did).toEqual([JSON.stringify({ kind: "focus", sessionId: "b2" })]);
  });

  it("rename_session renames this Mac's own, with an Undo that only puts back its own rename", async () => {
    const sessions = [mine("a1", { title: "api-fix" }), mine("b2", { mine: false, owner: "Nick" })];
    const t = tools(sessions);
    const rename = t.tool("rename_session");
    expect(rename.label({ session: "a1", title: "api" })).toBe("Rename “api-fix” to “api”");
    expect(await rename.check!({ session: "b2", title: "x" })).toBe("“b2” is Nick's session: only its owner can rename it");
    expect(await rename.check!({ session: "a1", title: "\n\t" })).toBe("The new title is empty");
    expect(await rename.check!({ session: "a1", title: "api-fix" })).toContain("already");
    expect(await rename.check!({ session: "a1", title: "api" })).toBeNull();

    const r = await rename.run({ session: "a1", title: "api\nmore" });
    expect(sessions[0].title).toBe("api more");
    expect(r.stillUndoable!()).toBe(true);
    expect(await r.undo!()).toBe("Renamed back to “api-fix”");
    expect(sessions[0].title).toBe("api-fix");

    const again = await rename.run({ session: "a1", title: "web" });
    sessions[0].title = "the user's own";
    expect(again.stillUndoable!()).toBe(false);
    expect(() => again.undo!()).toThrow("renamed again");
    expect(sessions[0].title).toBe("the user's own");
  });
});

describe("the Assistant's registry", () => {
  const t = (name: string, over: Partial<AssistantTool> = {}) => fakeTool({ name, tier: "read", ...over });
  it("refuses a tool it couldn't hold to its tier", () => {
    expect(() => new Registry([t("a"), t("a")])).toThrow("Two Assistant tools are named a");
    expect(() => new Registry([t("Bad-Name")])).toThrow("isn't lower case");
    expect(() => new Registry([t("x", { tier: "admin" as any })])).toThrow("has no tier");
    expect(() => new Registry([t("x", { card: () => ({ title: "", detail: "", warnings: [] }) })])).toThrow("isn't a confirm tool");
    expect(() => new Registry([t("x", { inputSchema: { type: "string" } as any })])).toThrow("isn't an object's");
  });

  it("checks arguments against a tool's schema", () => {
    const schema = {
      type: "object" as const,
      properties: { n: { type: "integer" as const, minimum: 1, maximum: 5 }, mode: { type: "string" as const, enum: ["plan", "default"] }, ids: { type: "array" as const, items: { type: "string" as const }, maxItems: 2 } },
      required: ["n"],
      additionalProperties: false,
    };
    expect(validateArgs(schema, { n: 2, mode: "plan", ids: ["a"] })).toBeNull();
    expect(validateArgs(schema, { n: 2.5 })).toBe("arguments.n must be a whole number");
    expect(validateArgs(schema, { n: 9 })).toBe("arguments.n must be at most 5");
    expect(validateArgs(schema, { n: 1, mode: "bypass" })).toBe('arguments.mode must be one of "plan", "default"');
    expect(validateArgs(schema, { n: 1, ids: ["a", 2] })).toBe("arguments.ids[1] must be a string");
    expect(validateArgs(schema, { n: 1, ids: ["a", "b", "c"] })).toBe("arguments.ids must have at most 2 items");
    expect(validateArgs(schema, [])).toBe("arguments must be an object");
  });

  it("takes only a schema's own properties: inherited names are arguments it doesn't take", () => {
    const schema = { type: "object" as const, properties: { n: { type: "integer" as const } }, additionalProperties: false };
    // as the MCP call's JSON parses: __proto__ an own property, not the prototype
    expect(validateArgs(schema, JSON.parse('{"n":1,"__proto__":{"polluted":true}}'))).toBe("arguments.__proto__ isn't an argument this tool takes");
    expect(validateArgs(schema, { n: 1, constructor: "x" })).toBe("arguments.constructor isn't an argument this tool takes");
    expect(validateArgs(schema, { n: 1, toString: 5 })).toBe("arguments.toString isn't an argument this tool takes");
    expect(validateArgs({ ...schema, additionalProperties: undefined }, { n: 1, constructor: "x" })).toBeNull();
  });
});

describe("the app as the Assistant sees it", () => {
  const info = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
    ({ id, title: id, ticketTitle: null, repoPath: "/code/atticus", branch: "main", taskGroup: "atticus/api", status: "idle", agent: "claude", cwd: "/w", kind: "work", waitingReason: "stale", waitingSince: 5, createdAt: 0, extraDirs: [], ticketId: null, ...over }) as SessionInfo;
  const rooms = [{ id: "R1", name: "Atticus team", groupKey: "atticus", members: [{ name: "Nick", self: false }, { name: "Ryan", self: true }], online: ["nick"] }];

  it("maps sessions field by field: titles, waiting only while waiting, mode default when unset, debriefs left out, teammates' marked", () => {
    const own = [
      info("a1", { ticketTitle: "#5038 Filter orgs", status: "waiting", waitingReason: "Claude needs your permission", waitingSince: 99 }),
      info("t1", { shell: true, taskGroup: null }),
      info("h1", { role: "tasks", taskGroup: "Helpdesk" }),
      info("d1", { debrief: true }),
      { ...info("p1"), permissionMode: "plan" } as SessionInfo,
    ];
    const remote = [info("r~nick~x", { room: { roomId: "R1", ownerName: "Nick", repoName: "atticus" } as any })];
    const out = worldSessions({ own, remote, rooms });
    expect(out.map((s) => s.id)).toEqual(["a1", "t1", "h1", "p1", "r~nick~x"]);
    expect(out[0]).toMatchObject({ title: "#5038 Filter orgs", waitingReason: "Claude needs your permission", waitingSince: 99, room: "Atticus team", mine: true, repo: "atticus" });
    expect(out[1]).toMatchObject({ agent: "terminal", group: null, waitingReason: null, waitingSince: null, room: null });
    expect(out[2]).toMatchObject({ helpdesk: true });
    expect(out[3].permissionMode).toBe("plan");
    expect(out[0].permissionMode).toBe("default");
    expect(out[4]).toMatchObject({ mine: false, owner: "Nick", room: "Atticus team" });
    expect(Object.keys(out[0]).sort()).toEqual(["agent", "branch", "group", "helpdesk", "id", "mine", "model", "permissionMode", "repo", "room", "status", "title", "waitingReason", "waitingSince"]);
  });

  it("gathers groups from sessions, areas, stacks and rooms, counting this Mac's running sessions", () => {
    const own = [info("a1"), info("a2", { taskGroup: "atticus", status: "dead" }), info("b1", { taskGroup: "ungrouped" }), info("d1", { taskGroup: "secret", debrief: true })];
    const out = worldGroups({ own, remote: [], areas: ["atticus", "docs"], stacks: ["docs/drafts"], rooms });
    expect(out).toEqual([
      { key: "atticus", stacks: ["atticus/api"], sessions: 1, room: "Atticus team", area: true },
      { key: "docs", stacks: ["docs/drafts"], sessions: 0, room: null, area: true },
    ]);
    expect(worldRooms(rooms)).toEqual([{ id: "R1", name: "Atticus team", group: "atticus", members: ["Ryan", "Nick"], online: 1 }]);
  });
});
