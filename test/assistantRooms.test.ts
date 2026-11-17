import { describe, expect, it } from "vitest";
import type { TakeoverPlan } from "../src/shared/team/takeover";
import { roomTools } from "../src/main/assistant/tools/rooms";
import type { AssistantTool } from "../src/main/assistant/registry";
import { harness } from "./assistantHarness";
import { info, landscapeWorld, theirs } from "./assistantWorld";

/**
 * The Assistant's room tools (tools/rooms.ts) over fakes of the team handlers: this Mac is in "Atticus team" (group
 * atticus) with Nick, whose session r~nick~x shows on the landscape; docs isn't shared. The House is a fake: no test
 * here reaches the real one.
 */
function world() {
  const did: string[] = [];
  let sandboxed = true;
  let grant: TakeoverPlan["grant"] = { kind: "ask" };
  let clone: string | null = "/code/atticus";
  const rooms = [{ id: "R1", name: "Atticus team", groupKey: "atticus", members: [{ name: "Nick", self: false }, { name: "Ryan", self: true }], online: ["nick"] }];
  const plan = (): TakeoverPlan => ({
    roomId: "R1",
    sessionId: "x",
    title: "Nick's api",
    agent: "claude",
    branch: "feature/143-api",
    ownerName: "Nick",
    ownerOnline: grant.kind === "ask",
    originUrl: "git@example.com:atticus.git",
    clone,
    snapshot: { sha: "abc", takenAt: Date.now() - 5 * 60_000, source: "peer", skipped: [], filtered: [] },
    other: null,
    toOrigin: false,
    originProblem: null,
    latestMissing: true,
    conversation: { kind: "partial", have: 3, of: 4 },
    resumesOwn: false,
    grant,
  });
  const w = landscapeWorld([info("a1"), info("d1", { taskGroup: "docs" }), info("h1", { taskGroup: "help", role: "tasks" })], {
    remote: [theirs("x", "atticus")],
    rooms,
    over: {
      houseBoard: async (roomId) => (did.push(`board ${roomId}`), "Project atticus.\n#143 api · Nick · in progress"),
      shareRefusal: (g) => (g === "help" ? "The Helpdesk workspace can't be in a team room. Move it out of “help” first, then share the area." : null),
      shareGroup: async (group, title) => (did.push(`share ${group} ${title}`), { roomId: "R2", created: true }),
      leaveRoom: async (roomId) => (did.push(`leave ${roomId}`), "Left Atticus team. Nick heard."),
      takeoverTarget: (id) => (id === "r~nick~x" ? { roomId: "R1", sessionId: "x", title: "Nick's api", owner: "Nick" } : null),
      takeoverPlan: async (roomId, sessionId) => (did.push(`plan ${roomId} ${sessionId}`), plan()),
      takeOver: async (roomId, sessionId) => (did.push(`takeOver ${roomId} ${sessionId}`), "local-7"),
      roomSandboxed: (roomId) => (roomId === "R1" ? sandboxed : null),
      setRoomSandbox: (roomId, on) => {
        did.push(`sandbox ${roomId} ${on}`);
        sandboxed = on;
      },
      houseWrite: async (roomId, wr) => (did.push(`house ${roomId} ${JSON.stringify(wr)}`), wr.kind === "claim" ? `Claimed #${wr.n}` : `Released #${wr.n}`),
    },
  });
  const tools = roomTools(w.deps);
  const tool = (name: string): AssistantTool => tools.find((t) => t.name === name)!;
  return { ...w, did, tool, setGrant: (g: TakeoverPlan["grant"]) => void (grant = g), setClone: (c: string | null) => void (clone = c) };
}

/** Make `name`'s card through the service and press Do it: the card as it settled. */
async function confirmed(w: ReturnType<typeof world>, name: string, args: Record<string, unknown>) {
  const h = harness([w.tool(name)]);
  const t = await h.turn("do it", async (call) => (await call(name, args), "Card up."));
  const before = [...w.did];
  const card = await h.card(t.steps[0].cardId!);
  return { card, before, done: await h.svc.confirm(card.id) };
}

describe("the Assistant's room tools", () => {
  it("fix their tiers: the board a read, every room action a card, none rule-able", () => {
    const w = world();
    expect(Object.fromEntries(roomTools(w.deps).map((t) => [t.name, t.tier]))).toEqual({
      house_board: "read",
      share_group: "confirm",
      leave_room: "confirm",
      take_over: "confirm",
      set_room_sandbox: "confirm",
      claim_ticket: "confirm",
      release_ticket: "confirm",
    });
    expect(roomTools(w.deps).filter((t) => t.rule)).toEqual([]);
  });

  it("house_board reads a room's board by its name or group, and refuses a room this Mac isn't in", async () => {
    const w = world();
    const board = w.tool("house_board");
    expect(await board.check!({ room: "nowhere" })).toContain("isn't in a room called");
    expect(JSON.parse((await board.run({ room: "atticus" })).text)).toEqual({ room: "Atticus team", board: "Project atticus.\n#143 api · Nick · in progress" });
    expect(w.did).toEqual(["board R1"]);
  });

  it("share_group shares a named group through team:share's checks, never giving the invite", async () => {
    const w = world();
    const share = w.tool("share_group");
    expect(await share.check!({ group: "atticus" })).toBe("“atticus” is shared already, as the room “Atticus team”");
    expect(await share.check!({ group: "help" })).toContain("Helpdesk workspace can't be in a team room");
    expect(await share.check!({ group: "nope" })).toContain("no top-level group");
    const { card, before, done } = await confirmed(w, "share_group", { group: "docs" });
    expect(before).toEqual([]);
    expect(card).toMatchObject({ title: "Share “docs” as a team room", warnings: ["Its 1 running session show to whoever joins."] });
    expect(done).toMatchObject({ state: "done", result: "Shared “docs” as a team room: its invite code is in the Team view, for the user to send." });
    expect(w.did).toEqual(["share docs docs"]);
  });

  it("leave_room is a danger card that leaves only on Do it", async () => {
    const w = world();
    const { card, before, done } = await confirmed(w, "leave_room", { room: "Atticus team" });
    expect(before).toEqual([]);
    expect(card).toMatchObject({ title: "Leave the room “Atticus team”", danger: true, warnings: ["Nick stays in it without you."] });
    expect(done).toMatchObject({ state: "done", result: "Left Atticus team. Nick heard." });
    expect(w.did).toEqual(["leave R1"]);
  });

  it("take_over reads the take-over plan for its card, and refuses what the plan refuses", async () => {
    const w = world();
    const take = w.tool("take_over");
    expect(await take.check!({ session: "a1" })).toContain("isn't a teammate's room session");
    const { card, done } = await confirmed(w, "take_over", { session: "r~nick~x" });
    expect(card).toMatchObject({
      // named as every card names a session: its landscape title, its id and its group
      title: "Take over “r~nick~x” · r~nick~x · atticus from Nick",
      detail: expect.stringContaining("on feature/143-api of /code/atticus, from the snapshot of 5m ago"),
      warnings: ["A newer snapshot was announced than any that reached this Mac.", "Only part of the conversation reached this Mac (3 of 4)."],
    });
    expect(card.detail).toContain("Nick is online: they're asked first");
    expect(done).toMatchObject({ state: "done", result: "Took over “Nick's api” from Nick: it runs on this Mac as session local-7." });
    expect(w.did.filter((x) => x.startsWith("takeOver"))).toEqual(["takeOver R1 x"]);
    w.setGrant({ kind: "none", why: "Nick's Mac refused it" });
    expect(await take.check!({ session: "r~nick~x" })).toBe("“Nick's api” can't be taken over: Nick's Mac refused it");
    w.setGrant({ kind: "offline" });
    w.setClone(null);
    expect(await take.check!({ session: "r~nick~x" })).toContain("No clone of its repository");
  });

  it("set_room_sandbox switches the room's sandbox on this Mac, off in the danger color, and refuses the state it's in", async () => {
    const w = world();
    const sandbox = w.tool("set_room_sandbox");
    expect(await sandbox.check!({ room: "atticus", on: true })).toBe("Its sandbox is on already");
    const { card, before, done } = await confirmed(w, "set_room_sandbox", { room: "atticus", on: false });
    expect(before).toEqual([]);
    expect(card).toMatchObject({ danger: true });
    expect(done).toMatchObject({ state: "done" });
    expect(w.did).toEqual(["sandbox R1 false"]);
    expect(sandbox.stillValid!({ room: "atticus", on: false })).toBe(false);
  });

  it("claim_ticket and release_ticket write to the House only on Do it, checking the branch", async () => {
    const w = world();
    expect(await w.tool("claim_ticket").check!({ room: "atticus", ticket: 143, branch: "bad branch" })).toBe("“bad branch” isn't a branch name git accepts");
    const claim = await confirmed(w, "claim_ticket", { room: "atticus", ticket: 143, branch: "feature/143-api" });
    expect(claim.before).toEqual([]);
    expect(claim.done).toMatchObject({ state: "done", result: "Claimed #143" });
    const release = await confirmed(w, "release_ticket", { room: "Atticus team", ticket: 143 });
    expect(release.done).toMatchObject({ state: "done", result: "Released #143" });
    expect(w.did).toEqual([`house R1 ${JSON.stringify({ kind: "claim", n: 143, branch: "feature/143-api" })}`, `house R1 ${JSON.stringify({ kind: "release", n: 143 })}`]);
  });
});
