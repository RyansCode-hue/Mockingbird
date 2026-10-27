import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git, makeRepo, tempDir } from "./helpers";
import { builderHome, fakeHouse, type FakeHouse } from "./fakeHouse";
import { loopbackRoom, until } from "../src/main/team/loopback";
import { houseOfRoom } from "../src/main/team/board";
import { HouseService } from "../src/main/team/houseService";
import { recordFor } from "../src/main/team/roomSessions";
import { CollabRooms, COLLAB_MODELS, splitInstruction, type TurnRunner } from "../src/main/collab";
import { CouncilTickets } from "../src/main/collabTickets";
import { councilLine, updateDraft, type TicketDraft } from "../src/shared/collabTickets";
import type { CollabParticipantSpec, SessionInfo } from "../src/shared/types";

// An approved Council plan becoming Radley House tickets, against the fake House on this Mac (test/fakeHouse.ts):
// nothing here reaches the real House, and no model is called (the council's turns are scripted).

const RYAN_T = "hb_RYAN_secret_token_000111";
const NICK_T = "hb_NICK_secret_token_222333";
const PROJECT = "atticus-backoffice";
const ORIGIN = "https://github.com/acme/backoffice.git";
const PLAN = "## Steps\n1. **Streaming endpoint** — stream the rows (high)\n   - Acceptance: filters honoured\n2. Export button\n3. Timing check on the largest org (low)";

let services: HouseService[] = [];
let houses: FakeHouse[] = [];
afterEach(async () => {
  for (const s of services) s.stop();
  services = [];
  for (const h of houses) await h.close();
  houses = [];
});

const house = async () => {
  const h = await fakeHouse({ [RYAN_T]: "Ryan Ellerbroek", [NICK_T]: "Nick Smith" });
  houses.push(h);
  return h;
};

const specs = (...keys: string[]): CollabParticipantSpec[] =>
  keys.map((k) => {
    const m = COLLAB_MODELS.find((x) => x.key === k)!;
    return { label: m.label, agent: m.agent, model: m.model, effort: null, readsCode: true };
  });

/** A council whose plan is written up and approved, with scripted turns (no model). */
function council(repoPath: string | null, reply: (prompt: string) => string = () => "Plan.") {
  const prompts: string[] = [];
  const runTurn: TurnRunner = async (p, prompt) => {
    prompts.push(prompt);
    return { text: reply(prompt), conversationId: `${p.key}-conv` };
  };
  const c = new CollabRooms(tempDir("collab"), runTurn, () => {}, vi.fn() as any, () => "dev");
  const room = c.create({ title: "CSV export", brief: "Export donors to CSV", repoPath, participants: specs("opus", "fable") });
  room.messages.push({ id: "plan1", speaker: "opus", text: PLAN, round: 1, at: Date.now(), kind: "plan" });
  c.approve(room.id, "plan1");
  return { c, room, prompts };
}

function houseService(home: string, o: { team?: Parameters<HouseService["start"]>[0]; roomId?: string; sessions?: () => SessionInfo[]; knownRepos?: () => string[] } = {}) {
  const logs: string[] = [];
  const svc = new HouseService({
    roomGroups: () => (o.roomId ? [{ roomId: o.roomId, groupKey: "5110" }] : []),
    sessions: o.sessions ?? (() => []),
    knownRepos: o.knownRepos ?? (() => []),
    emit: () => {},
    log: (context, err) => {
      const msg = `${context}: ${err instanceof Error ? err.message : String(err)}`;
      logs.push(msg);
      return msg;
    },
    copiesFile: path.join(tempDir("copies"), "copies.json"),
    consentFile: path.join(tempDir("consent"), "house-consent.json"),
    home,
    allowHttpLoopback: true,
    timing: { pollMs: 60_000, sessionsMs: 30, fetchMs: 60_000, timeoutMs: 3000, nudgeGapMs: 20, nudgeListGapMs: 50 },
  });
  if (o.team) svc.start(o.team);
  services.push(svc);
  return { svc, logs };
}

describe("an approved Council plan as House tickets, in a project chosen directly", () => {
  it("offers the projects this Mac has a token for, asks before using the token, then creates the reviewed drafts in order and links them back", async () => {
    const h = await house();
    const home = builderHome(PROJECT, h, RYAN_T);
    builderHome("other-project", h, RYAN_T, "", home);
    const { svc } = houseService(home);
    const { c, room } = council(null);
    const tickets = new CouncilTickets(c, svc);

    // split without a model, from the plan's steps
    const { found } = c.ticketDrafts(room.id);
    expect(found).toBe(true);
    let drafts = room.ticketDrafts!.drafts;
    expect(drafts.map((d) => d.title)).toEqual(["Streaming endpoint", "Export button", "Timing check on the largest org"]);
    drafts = updateDraft(drafts, drafts[1].id, { title: "Export button in the toolbar", tags: ["needs-agent", "frontend"] });

    expect(await tickets.targets(room.id)).toEqual({
      inRoom: false,
      targets: [
        { kind: "project", project: PROJECT, connection: "consent" },
        { kind: "project", project: "other-project", connection: "consent" },
      ],
    });
    // nothing is read or sent with the token until the user allows it
    await expect(tickets.create(room.id, { project: PROJECT }, drafts, false)).rejects.toThrow(/^Allow your atticus-backoffice builder token first\. Nothing was created\.$/);
    expect(h.requests).toEqual([]);
    expect((await tickets.consent(room.id, { project: PROJECT }, true)).targets[0]).toMatchObject({ project: PROJECT, connection: "connected" });

    const { result, room: after } = await tickets.create(room.id, { project: PROJECT }, drafts, false);
    expect(result).toEqual({
      project: PROJECT,
      room: null,
      created: [
        { draftId: drafts[0].id, n: 100, title: "Streaming endpoint" },
        { draftId: drafts[1].id, n: 101, title: "Export button in the toolbar" },
        { draftId: drafts[2].id, n: 102, title: "Timing check on the largest org" },
      ],
      failed: null,
      notSent: [],
    });
    expect(h.by(RYAN_T)).toEqual(["POST work-items", "PATCH work-items/100", "POST work-items", "PATCH work-items/101", "POST work-items", "PATCH work-items/102"]);
    expect(h.items.get(100)).toMatchObject({ title: "Streaming endpoint", priority: "high", acceptance: "- filters honoured", tags: ["needs-agent"], created_by: "Ryan Ellerbroek" });
    expect(h.items.get(100)!.detail).toBe(`stream the rows\n\n${councilLine("CSV export")}`);
    expect(h.items.get(101)).toMatchObject({ priority: "medium", tags: ["needs-agent", "frontend"] });
    expect(h.items.get(102)).toMatchObject({ priority: "low" });

    // the numbers link back to the discussion: the council's list, and a note in the thread naming each
    expect(after.houseTickets!.map((t) => [t.n, t.project, t.roomId])).toEqual([
      [100, PROJECT, null],
      [101, PROJECT, null],
      [102, PROJECT, null],
    ]);
    expect(after.messages.at(-1)).toMatchObject({ speaker: "system", text: `Created 3 House tickets in ${PROJECT} from the plan: #100 Streaming endpoint; #101 Export button in the toolbar; #102 Timing check on the largest org.` });
    expect(after.ticketDrafts).toBeNull();
    // and each opens in the House by the ticket the council made
    expect((await tickets.url(room.id, 101)).url).toMatch(/\/work-items\/101$/);
    await expect(tickets.url(room.id, 55)).rejects.toThrow(/#55 wasn't created from this council/);
  });

  it("says which tickets were created and which weren't when the House refuses one, keeping the rest for another go", async () => {
    const h = await house();
    const { svc, logs } = houseService(builderHome(PROJECT, h, RYAN_T));
    const { c, room } = council(null);
    const tickets = new CouncilTickets(c, svc);
    c.ticketDrafts(room.id);
    const drafts = room.ticketDrafts!.drafts;
    svc.councilConsent({ project: PROJECT }, true);
    h.state.refuseCreate = (body) => (body.title === "Export button" ? "A work item titled like that already exists" : null);

    const { result, room: after } = await tickets.create(room.id, { project: PROJECT }, drafts, false);
    expect(result.created).toEqual([{ draftId: drafts[0].id, n: 100, title: "Streaming endpoint" }]);
    expect(result.failed).toEqual({ draftId: drafts[1].id, title: "Export button", error: expect.stringMatching(/^Council tickets: creating "Export button" in atticus-backoffice: .*422.*A work item titled like that already exists/) });
    expect(result.notSent).toEqual([{ draftId: drafts[2].id, title: "Timing check on the largest org" }]);
    // nothing after the refused one was sent
    expect(h.by(RYAN_T).filter((r) => r === "POST work-items")).toHaveLength(2);
    expect(logs.some((l) => l.includes("A work item titled like that already exists"))).toBe(true);
    expect(after.houseTickets!.map((t) => t.n)).toEqual([100]);
    expect(after.ticketDrafts!.drafts.map((d) => d.id)).toEqual([drafts[1].id, drafts[2].id]);
    const note = after.messages.at(-1)!.text;
    expect(note).toMatch(/^Created 1 House ticket in atticus-backoffice from the plan: #100 Streaming endpoint\. "Export button" wasn't created: .*already exists/);
    expect(note).toMatch(/Not sent: "Timing check on the largest org"\. It stays in the review with the one that failed\.$/);

    // another go creates only what's left
    h.state.refuseCreate = null;
    const again = await tickets.create(room.id, { project: PROJECT }, after.ticketDrafts!.drafts, false);
    expect(again.result.created.map((x) => x.n)).toEqual([101, 102]);
    expect(again.room.houseTickets!.map((t) => t.n)).toEqual([100, 101, 102]);
    expect(again.room.ticketDrafts).toBeNull();
  });

  it("fails before sending anything when the token is missing or a draft won't do, and says so", async () => {
    const h = await house();
    const home = builderHome(PROJECT, h, RYAN_T);
    const { svc } = houseService(home);
    const { c, room } = council(null);
    const tickets = new CouncilTickets(c, svc);
    c.ticketDrafts(room.id);
    const drafts = room.ticketDrafts!.drafts;
    svc.councilConsent({ project: PROJECT }, true);

    const long = updateDraft(drafts, drafts[2].id, { title: "x".repeat(201) });
    await expect(tickets.create(room.id, { project: PROJECT }, long, false)).rejects.toThrow(/^Ticket 3 \(.*\): title is 201 characters; the limit is 200\. Nothing was created\.$/);
    const both = updateDraft(drafts, drafts[1].id, { tags: ["needs-human", "needs-agent"] });
    await expect(tickets.create(room.id, { project: PROJECT }, both, false)).rejects.toThrow(/^Ticket 2 .*both needs-human and needs-agent.*Nothing was created\.$/);

    // the token file goes: what to do, and nothing sent
    fs.writeFileSync(path.join(home, ".config", "radley-house", `${PROJECT}.env`), `HOUSE_API_URL=${h.url}\nHOUSE_PROJECT_ID=x\n`, { mode: 0o600 });
    await expect(tickets.create(room.id, { project: PROJECT }, drafts, false)).rejects.toThrow(/token.*Nothing was created\.$/is);
    expect(h.requests).toEqual([]);
    expect(room.houseTickets ?? []).toEqual([]);
    // the drafts as reviewed are kept, whatever happened
    expect(c.get(room.id).ticketDrafts!.drafts.map((d) => d.id)).toEqual(drafts.map((d) => d.id));
    // and a plan that isn't approved has no tickets
    const { c: c2 } = council(null);
    const r2 = c2.create({ title: "No plan", brief: "x", repoPath: null, participants: specs("opus", "fable") });
    expect(() => c2.ticketDrafts(r2.id)).toThrow(/Approve a plan first/);
  });
});

describe("a model's split of the plan", () => {
  it("runs only when asked, in a fresh conversation with no code access, and its answer becomes the drafts", async () => {
    const answer = JSON.stringify([
      { title: "Endpoint", detail: "Stream rows", acceptance: ["filters honoured"], priority: "HIGH" },
      { title: "Button", detail: "In the toolbar", priority: "urgent" },
    ]);
    const { c, room, prompts } = council(null, () => `Here you go:\n\`\`\`json\n${answer}\n\`\`\``);
    const seat = room.participants.find((p) => p.key === "opus")!;
    seat.conversationId = "opus-discussion";
    const before = prompts.length;
    const after = await c.splitPlanWithModel(room.id, "opus");
    expect(prompts.length).toBe(before + 1);
    expect(prompts.at(-1)).toBe(splitInstruction(PLAN));
    // the discussion's own conversation is left as it was
    expect(seat.conversationId).toBe("opus-discussion");
    expect(after.ticketDrafts).toMatchObject({ how: "model", by: "Claude Opus 5.5" });
    expect(after.ticketDrafts!.drafts.map((d: TicketDraft) => [d.title, d.priority, d.acceptance])).toEqual([
      ["Endpoint", "high", "- filters honoured"],
      ["Button", "medium", ""],
    ]);
    expect(after.messages.at(-1)!.text).toBe("Claude Opus 5.5 split the approved plan into 2 draft House tickets for you to review.");

    const { c: bad, room: r2 } = council(null, () => "I'd rather not.");
    await expect(bad.splitPlanWithModel(r2.id, "opus")).rejects.toThrow(/didn't answer with a list of tickets/);
    expect(bad.get(r2.id).ticketDrafts ?? null).toBeNull();
  });

  it("offers the whole plan as one ticket when it has no steps to split by", () => {
    const { c, room } = council(null);
    room.plan!.text = "Stream the export, measure the biggest org, and add a job only if it times out.";
    expect(c.ticketDrafts(room.id).found).toBe(false);
    const d = c.wholePlanTicket(room.id).ticketDrafts!.drafts;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ title: "CSV export", detail: `${room.plan!.text}\n\n${councilLine("CSV export")}` });
  });
});

describe("a council whose repository is in a team room", () => {
  it("offers only the room's project, uses the room's own token answer, and adds the tickets to its board when asked", async () => {
    const h = await house();
    const repo = makeRepo({ "README.md": "x\n" }, "backoffice");
    git(repo, "remote", "add", "origin", ORIGIN);
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("t") });
    const [ryan, nick] = members;
    const { svc } = houseService(builderHome(PROJECT, h, RYAN_T), { team: ryan.team, roomId, knownRepos: () => [repo] });
    const s = { id: "r1", title: "Export", repoPath: repo, cwd: repo, branch: "5110-export", ticketId: null, ticketTitle: null, taskGroup: "5110", status: "idle", createdAt: 0, kind: "work", extraDirs: [], waitingReason: null, waitingSince: null, agent: "claude" } as unknown as SessionInfo;
    nick.team.publish(roomId, "session.upsert", recordFor(s, { live: true, repo: ORIGIN, cols: 80, rows: 24, guards: { secrets: true, coauthors: true }, git: null }));
    await until(() => Object.keys(ryan.team.room(roomId)!.ext.sessions ?? {}).length === 1, "Ryan to see Nick's session");

    const { c, room } = council(repo);
    const tickets = new CouncilTickets(c, svc);
    // the room has no project yet: it's offered, and says so
    expect((await tickets.targets(room.id)).targets).toEqual([{ kind: "room", roomId, room: expect.any(String), project: null, admin: "Ryan", connection: "consent" }]);
    await svc.write(roomId, { kind: "project", project: PROJECT }); // Ryan is the admin: choosing it is his answer
    const t = await tickets.targets(room.id);
    expect(t).toMatchObject({ inRoom: true, targets: [{ kind: "room", roomId, project: PROJECT, connection: "connected" }] });

    c.ticketDrafts(room.id);
    const drafts = room.ticketDrafts!.drafts.slice(0, 2);
    const { result, room: after } = await tickets.create(room.id, { roomId }, drafts, true);
    expect(result).toMatchObject({ project: PROJECT, room: expect.any(String), failed: null, created: [{ n: 100 }, { n: 101 }] });
    await until(() => [100, 101].every((n) => houseOfRoom(nick.team.room(roomId)!).tracked.some((x) => x.n === n)), "the tickets to be on the room's board for Nick");
    expect(after.houseTickets!.map((x) => [x.n, x.roomId])).toEqual([
      [100, roomId],
      [101, roomId],
    ]);
    expect(after.messages.at(-1)!.text).toMatch(new RegExp(`^Created 2 House tickets in ${PROJECT} \\(room .+\\) from the plan: #100 Streaming endpoint; #101 Export button\\.$`));

    // without "add to the board", they're created but not tracked
    const more = await tickets.create(room.id, { roomId }, [{ ...drafts[0], id: "dX", title: "Not on the board" }], false);
    expect(more.result.created.map((x) => x.n)).toEqual([102]);
    await svc.idle();
    expect(houseOfRoom(ryan.team.room(roomId)!).tracked.map((x) => x.n)).toEqual([100, 101]);
  });
});
