import * as fs from "fs";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

/** Every call that pushes, opens a pull request or writes to Azure DevOps, as it's reached: no ticket tool may reach one. */
const reached = vi.hoisted(() => [] as string[]);
vi.mock("../src/main/scm", async (orig) => ({
  ...(await orig<typeof import("../src/main/scm")>()),
  scmPush: vi.fn(async () => (reached.push("scmPush"), Promise.reject(new Error("no push in a test")))),
}));
vi.mock("../src/main/pullRequests", async (orig) => ({
  ...(await orig<typeof import("../src/main/pullRequests")>()),
  openPr: vi.fn(async () => (reached.push("openPr"), Promise.reject(new Error("no pull request in a test")))),
}));
vi.mock("../src/main/ado", async (orig) => ({
  ...(await orig<typeof import("../src/main/ado")>()),
  addComment: vi.fn(async () => (reached.push("addComment"), Promise.reject(new Error("no ADO comment in a test")))),
  updateWorkItem: vi.fn(async () => (reached.push("updateWorkItem"), Promise.reject(new Error("no ADO change in a test")))),
}));

/** The panes a real SessionManager starts, and what's written to each. */
type FakePty = { session: string; writes: string[] };
const ptys = vi.hoisted(() => [] as FakePty[]);
vi.mock("node-pty", () => ({
  spawn: (_file: string, _args: string[], opts: { env: Record<string, string> }) => {
    const p: FakePty = { session: opts.env.MOCKINGBIRD_SESSION, writes: [] };
    ptys.push(p);
    return { onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write: (d: string) => void p.writes.push(d), resize() {}, kill() {}, pid: 1 };
  },
}));
vi.mock("../src/main/shell", async (orig) => ({
  ...(await orig<typeof import("../src/main/shell")>()),
  which: (bin: string) => Promise.resolve(`/found/${bin}`),
  whichSync: (bin: string) => `/found/${bin}`,
}));

import { addComment, updateWorkItem } from "../src/main/ado";
import { Messaging, mcpLaunch, retireMcpLaunch } from "../src/main/messaging";
import { goesBack, PipelineStore, stageRefusal } from "../src/main/pipeline";
import { openPr } from "../src/main/pullRequests";
import { scmPush } from "../src/main/scm";
import { SessionManager } from "../src/main/sessions";
import { agentBy, TicketTools, type ApprovalUndone } from "../src/main/ticketTools";
import { GATE_ITEM_KEYS, PATCH_NOTES_GUIDANCE, PATCH_NOTES_MAX, PERSON_GATE_ITEMS, TICKET_TOOL, TICKET_TOOL_SCHEMAS } from "../src/main/ticketToolSchemas";
import { BY_YOU, TICKET_STAGES, tickOf, gateTicks, type PipelinePr, type SessionInfo, type StoredStage, type TicketPipeline, type TicketStage } from "../src/shared/types";
import { PipelineStore as PipelineStore160 } from "./fixtures/pipeline-1.6.0/pipeline";
import { askAs, startServer, testLaunch } from "./mcpClient";
import { tempDir } from "./helpers";
import { ROOMS_STARTING } from "../src/shared/wires";

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, title: id, ticketTitle: null, ticketId: null, repoPath: `/code/${id}`, branch: "b", taskGroup: null, status: "idle", agent: "claude", cwd: `/w/${id}`, kind: "work", ...over }) as SessionInfo;

const prTo = (target: "dev" | "main", id: number, by?: string): PipelinePr => ({
  target,
  provider: "ado",
  id,
  url: `https://dev.azure.com/x/_git/r/pullrequest/${id}`,
  repo: "x/r",
  branch: "4182-filter",
  base: target,
  at: 1,
  ...(by ? { by } : {}),
});

const GITHUB_TOKEN = `ghp_${"k".repeat(36)}`;
const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";

/** A pipeline with #4182 at Coding and #5101 tracked too, and the agents and tools that act on them. */
function setup() {
  const file = path.join(tempDir("tickettools"), "pipeline.json");
  const pipeline = new PipelineStore(file);
  pipeline.startCoding("4182", "Org filter", BY_YOU);
  pipeline.startCoding("5101", "Quick view", BY_YOU);
  const running = [
    session("coder", { title: "Coder", ticketId: "4182", ticketTitle: "Org filter" }),
    // on the ticket by its group alone, as a workspace in the ticket's area is
    session("verifier", { title: "Verifier", taskGroup: "4182/verify" }),
    session("other", { title: "Other coder", ticketId: "#5101" }),
    session("free", { title: "Free" }),
    session("untracked", { title: "Untracked", ticketId: "7777" }),
    session("busy", { title: "Busy", ticketId: "4182", status: "working" }),
    session("exited", { title: "Exited", ticketId: "4182", status: "dead" }),
  ];
  const closed = [session("gone", { title: "Gone coder", ticketId: "4182" })];
  const takenOver: Record<string, string> = {};
  const told: { id: string; text: string; submit: boolean }[] = [];
  const logged: string[] = [];
  const counts = { changed: 0 };
  const rooms: Record<string, string> = {};
  /** roomsKnown: whether team rooms have started; notify: whether the user's settings show the approval notice. */
  const flags = { roomsKnown: true, notify: true };
  const undone: ApprovalUndone[] = [];
  const tools = new TicketTools({
    pipeline,
    sessions: {
      list: () => running,
      resumable: () => closed,
      deliverAgentMessage: (id, text, submit) => {
        told.push({ id, text, submit });
        return running.find((s) => s.id === id)?.status === "working" ? "queued until its current turn ends" : "delivered";
      },
    },
    submitOnDelivery: () => true,
    takenOver: (id, doing) => {
      if (takenOver[id] === "throws") throw new Error("the take-over state can't be read");
      return takenOver[id] ? `${takenOver[id]} — take it back rather than ${doing}` : null;
    },
    roomOf: (id) => rooms[id] ?? null,
    roomsKnown: () => flags.roomsKnown,
    onApprovalUndone: (e) => (undone.push(e), flags.notify),
    onChanged: () => void counts.changed++,
    log: (context, err) => void logged.push(`${context}: ${err instanceof Error ? err.message : String(err)}`),
  });
  pipeline.onRequestsDropped = (id, dropped) => void tools.requestsDropped(id, dropped);
  const as = (id: string) => running.find((s) => s.id === id)!;
  const call = async (id: string, op: string, args: Record<string, unknown>): Promise<{ result?: string; error?: string }> => (await tools.call(as(id), op, args)) as { result?: string; error?: string };
  const at = (stage: TicketStage, id = "4182") => pipeline.setStage(id, stage, { by: BY_YOU });
  const record = (id = "4182"): TicketPipeline => JSON.parse(fs.readFileSync(file, "utf8"))[id];
  const disk = () => fs.readFileSync(file, "utf8");
  return { file, pipeline, running, takenOver, told, logged, counts, rooms, flags, undone, tools, as, call, at, record, disk };
}

describe("stageRefusal: what an agent may move a ticket to", () => {
  const ids = TICKET_STAGES.map((s) => s.id);
  const allowed = (note?: string) => ids.flatMap((from) => ids.filter((to) => !stageRefusal(from, to, note)).map((to) => `${from} → ${to}`));

  it("forward one rail step into a stage an agent sets, or back to Coding with the feedback: nothing else, from any stage", () => {
    expect(allowed("the filter drops orgs with no users")).toEqual([
      "ba → coding",
      "coding → local-test",
      "local-test → coding",
      "pr-dev → coding",
      "dev-test → coding",
      "dev-test → stakeholder",
      "stakeholder → coding",
      "approved → coding",
      "pr-main → coding",
      "prod-test → coding",
      "prod-test → comms",
      "comms → coding",
    ]);
    // back needs the feedback that sends it back
    expect(allowed()).toEqual(["ba → coding", "coding → local-test", "dev-test → stakeholder", "prod-test → comms"]);
    expect(allowed("   ")).toEqual(allowed());
  });

  it("says why for each refusal", () => {
    const why = (from: StoredStage, to: unknown, note?: string) => stageRefusal(from, to, note);
    expect(why("comms", "done")).toMatch(/^Done is the user's to mark, never an agent's/);
    expect(why("stakeholder", "approved")).toMatch(/^Approving stakeholder testing is the user's, never an agent's/);
    expect(why("local-test", "pr-dev")).toMatch(/^Only a pull request opening moves a ticket to PR to dev, so the stage never claims a PR that isn't there: ask for one with request_pr/);
    expect(why("approved", "pr-main")).toMatch(/^Only a pull request opening moves a ticket to PR to main/);
    expect(why("coding", "ba", "x")).toBe("A ticket never goes back to BA.");
    expect(why("coding", "stakeholder")).toBe("Forward is one step on the rail: from Coding the next is Local testing.");
    expect(why("ba", "local-test")).toBe("Forward is one step on the rail: from BA the next is Coding.");
    expect(why("dev-test", "comms")).toBe("Forward is one step on the rail: from AI testing in dev/UAT the next is Stakeholder testing.");
    for (const from of ["stakeholder", "approved", "pr-main"] as const) {
      for (const to of ["prod-test", "comms"]) expect(why(from, to), `${from} → ${to}`).toMatch(/^From stakeholder testing an agent can only send it back to Coding, with the feedback: moving it on is the user's/);
    }
    expect(why("pr-dev", "dev-test")).toMatch(/^Only its pull request merging, or the user, moves a ticket to AI testing in dev\/UAT, so the stage never claims a merge/);
    expect(why("stakeholder", "local-test", "x")).toMatch(/^An agent sends a ticket back only to Coding, with the feedback that sends it there\. It's at Stakeholder testing\./);
    expect(why("approved", "stakeholder", "x")).toMatch(/^An agent sends a ticket back only to Coding/);
    expect(why("dev-test", "coding")).toBe("Sending it back to Coding needs note: the feedback that sends it back.");
    expect(why("done", "coding", "x")).toBe("It's Done: only the user reopens it.");
    expect(why("qa-later", "coding", "x")).toMatch(/^It's at "qa-later", a stage this version of Mockingbird doesn't know: the user moves it\./);
    expect(why("coding", "qa-later")).toMatch(/^"qa-later" isn't a stage an agent can move a ticket to\./);
    expect(why("coding", 7)).toMatch(/^"7" isn't a stage/);
    expect(why("coding", "coding", "x")).toBe("It's at Coding already.");
    expect(goesBack("approved", "stakeholder")).toBe(true);
    expect(goesBack("stakeholder", "approved")).toBe(true); // within step 6: no agent moves there at all
    expect(goesBack("coding", "local-test")).toBe(false);
  });
});

describe("set_stage", () => {
  it("moves the caller's ticket one step, with who did it and the stage's comment, and nothing else", async () => {
    const t = setup();
    const before = t.record();
    const r = await t.call("coder", TICKET_TOOL.setStage, { stage: "local-test", note: "Committed as 1a2b3c" });
    expect(r.result).toBe("#4182 moved from Coding to Local testing, marked as yours. Mockingbird drafted the stage's comment for the ticket; only the user posts it.");
    const p = t.record();
    expect(p.stage).toBe("local-test");
    expect(p.history.at(-1)).toEqual({ at: expect.any(Number), stage: "local-test", note: "Committed as 1a2b3c", by: "Coder's agent" });
    // Mockingbird's words, marked as the agent's move's
    expect(p.drafts.at(-1)).toEqual({ id: expect.any(String), stage: "local-test", text: "Development is done; testing locally.", at: expect.any(Number), by: "Coder's agent" });
    expect({ ...p, stage: before.stage, history: before.history, drafts: before.drafts }).toEqual(before);
    expect(t.record("5101")).toEqual(JSON.parse(t.disk())["5101"]);
    expect(t.told).toEqual([]);
    expect(t.counts.changed).toBe(1);
  });

  it("works on the ticket its group is named after, and the window hears of each move", async () => {
    const t = setup();
    t.at("dev-test");
    expect((await t.call("verifier", TICKET_TOOL.setStage, { stage: "stakeholder" })).result).toMatch(/^#4182 moved from AI testing in dev\/UAT to Stakeholder testing/);
    expect(t.record().history.at(-1)).toMatchObject({ stage: "stakeholder", by: "Verifier's agent" });
    expect(t.record().drafts.at(-1)!.text).toBe("Deployed to dev/UAT and tested; ready for stakeholder testing.");
    // a forward move's note is history, never quoted into the stage's comment
    t.at("ba");
    await t.call("coder", TICKET_TOOL.setStage, { stage: "coding", note: "Plan agreed" });
    expect(t.record().drafts.at(-1)!.text).toBe("Back in development.");
    expect(t.counts.changed).toBe(2);
  });

  it("sends it back to Coding with the feedback kept as whose, drafting no comment, clearing only agents' ticks and saying whose", async () => {
    const t = setup();
    await t.call("coder", TICKET_TOOL.setStage, { stage: "local-test", gate_notes: [{ item: "dev:tests", note: "npm test: 412 passed", done: true }] });
    t.pipeline.setCheck("4182", "dev:smoke", true, BY_YOU);
    t.at("dev-test");
    const drafts = t.record().drafts.length;
    const r = await t.call("verifier", TICKET_TOOL.setStage, { stage: "coding", note: "Orgs with no users vanish from the filter on dev." });
    expect(r.result).toBe("#4182 is back at Coding from AI testing in dev/UAT, with your note kept as its feedback, marked as yours. Agents' ticks on its checklists were cleared, as the work changes; the user's stay.");
    const p = t.record();
    expect(p.feedback.at(-1)).toEqual({ at: expect.any(Number), text: "Orgs with no users vanish from the filter on dev.", by: "Verifier's agent" });
    expect(p.drafts).toHaveLength(drafts);
    expect(p.checks).toEqual({ "dev:smoke": true });
    expect(tickOf(p, "dev:smoke")).toMatchObject({ by: "you" });
    expect(p.gateNotes).toEqual({});
    expect(p.history.at(-1)).toMatchObject({
      stage: "coding",
      by: "Verifier's agent",
      note: 'Orgs with no users vanish from the filter on dev.\n\nAgents\' ticks cleared: "Tests pass" (ticked by Coder\'s agent).',

    });
    // before the user's approval: nobody is notified
    expect(t.undone).toEqual([]);
  });

  it("from past the user's approval: their ticks and a person's items stay, and they're told once, naming the agent and its note", async () => {
    const t = setup();
    for (const stage of ["approved", "pr-main", "prod-test", "comms"] as const) {
      t.at("local-test");
      t.pipeline.setCheck("4182", "dev:tests", true, "Coder's agent");
      t.pipeline.setCheck("4182", "dev:smoke", true, BY_YOU);
      t.at(stage);
      t.pipeline.setCheck("4182", "staging:peer-review", true, BY_YOU);
      t.pipeline.setCheck("4182", "staging:security-reviewed", true, BY_YOU);
      t.pipeline.setCheck("4182", "prod:sign-off", true, BY_YOU);
      t.pipeline.setCheck("4182", "staging:secrets", true, "Verifier's agent");
      const before = t.undone.length;
      const r = await t.call("verifier", TICKET_TOOL.setStage, { stage: "coding", note: "The deployed build drops orgs" });
      expect(r.result, stage).toMatch(/That undoes the user's approval of stakeholder testing, so Mockingbird showed them a notice\.$/);
      const p = t.record();
      expect(Object.keys(p.checks).sort(), stage).toEqual(["dev:smoke", "prod:sign-off", "staging:peer-review", "staging:security-reviewed"]);
      expect(p.history.at(-1)!.note, stage).toBe(
        'The deployed build drops orgs\n\nAgents\' ticks cleared: "Tests pass" (ticked by Coder\'s agent), "No hardcoded secrets, credentials or environment-specific values" (ticked by Verifier\'s agent). Your ticks were kept: peer review, security doc reviewed, sign-off; untick them if the rework needs a new review.'
      );
      expect(t.undone.slice(before), stage).toEqual([
        { ticket: "4182", title: "Org filter", session: t.as("verifier"), by: "Verifier's agent", from: stage, note: "The deployed build drops orgs", kept: ["peer review", "security doc reviewed", "sign-off"] },
      ]);
    }
    // a notice the user's settings didn't show isn't claimed
    t.flags.notify = false;
    t.at("approved");
    expect((await t.call("verifier", TICKET_TOOL.setStage, { stage: "coding", note: "Again" })).result).toMatch(
      /That undoes the user's approval of stakeholder testing, and Mockingbird showed them no notice \(their notification settings, or it failed\): say so in your reply\.$/
    );
    // the user's own move back clears every tick, as before
    t.at("approved");
    t.pipeline.setCheck("4182", "staging:peer-review", true, BY_YOU);
    t.pipeline.addFeedback("4182", "Stakeholders want it reworked", BY_YOU);
    expect(gateTicks(t.record())).toBe(0);
    expect(t.undone).toHaveLength(5);
  });

  it("refuses, writing nothing: each of section 4's rules, and a call that names anything but its arguments", async () => {
    const t = setup();
    const cases: [TicketStage, Record<string, unknown>, RegExp][] = [
      ["comms", { stage: "done" }, /Done is the user's/],
      ["stakeholder", { stage: "approved" }, /Approving stakeholder testing is the user's/],
      ["local-test", { stage: "pr-dev" }, /Only a pull request opening/],
      ["approved", { stage: "pr-main" }, /Only a pull request opening/],
      ["coding", { stage: "ba", note: "x" }, /never goes back to BA/],
      ["coding", { stage: "stakeholder" }, /Forward is one step/],
      ["stakeholder", { stage: "prod-test" }, /From stakeholder testing an agent can only send it back/],
      ["pr-dev", { stage: "dev-test" }, /Only its pull request merging/],
      ["stakeholder", { stage: "local-test", note: "x" }, /back only to Coding/],
      ["dev-test", { stage: "coding" }, /needs note/],
      ["done", { stage: "coding", note: "reopen" }, /only the user reopens it/],
      ["local-test", { stage: "coding", note: "x", gate_notes: [{ item: "dev:tests", note: "y", done: true }] }, /takes no gate_notes/],
      ["coding", { stage: "local-test", ticket: "5101" }, /^set_stage takes stage and note and gate_notes, nothing else \(not "ticket"\)\./],
      ["coding", { stage: "local-test", from: "other" }, /nothing else \(not "from"\)/],
      ["dev-test", { stage: "coding", note: `see ${PRIVATE_KEY}` }, /note holds a private key, so nothing was kept/],
      ["dev-test", { stage: "coding", note: "x".repeat(4001) }, /note is 4,001 characters; the limit is 4,000/],
    ];
    for (const [stage, args, why] of cases) {
      t.at(stage);
      const before = t.disk();
      const changed = t.counts.changed;
      const r = await t.call("coder", TICKET_TOOL.setStage, args);
      expect(r.error, JSON.stringify(args)).toMatch(why);
      expect(t.disk(), JSON.stringify(args)).toBe(before);
      expect(t.counts.changed).toBe(changed);
    }
    expect(t.told).toEqual([]);
  });

  it("acts only on the caller's own ticket: never another's, none for a workspace on no ticket or an untracked one, nor for a copy taken over", async () => {
    const t = setup();
    const before = t.disk();
    expect((await t.call("free", TICKET_TOOL.setStage, { stage: "local-test" })).error).toMatch(/^This workspace isn't on a ticket/);
    expect((await t.call("untracked", TICKET_TOOL.setStage, { stage: "local-test" })).error).toMatch(/^#7777 isn't tracked in Mockingbird's ticket pipeline yet/);
    t.takenOver.coder = "Nick took this copy over";
    expect((await t.call("coder", TICKET_TOOL.setStage, { stage: "local-test" })).error).toBe("Nick took this copy over — take it back rather than moving this copy's ticket");
    for (const op of Object.values(TICKET_TOOL)) expect((await t.call("coder", op, {})).error, op).toMatch(/^Nick took this copy over/);
    expect(t.disk()).toBe(before);
    expect(t.pipeline.get("7777")).toBeNull();
    delete t.takenOver.coder;
    // another session's ticket moves only by that session's own call
    await t.call("other", TICKET_TOOL.setStage, { stage: "local-test" });
    expect(t.record("5101").stage).toBe("local-test");
    expect(t.record("4182").stage).toBe("coding");
  });
});

describe("gate_notes", () => {
  it("keeps the agent's evidence beside each item and ticks what it did as its tick; the user can untick it, and keeps a tick of their own", async () => {
    const t = setup();
    t.pipeline.setCheck("4182", "dev:smoke", true, BY_YOU);
    const r = await t.call("coder", TICKET_TOOL.setStage, {
      stage: "local-test",
      gate_notes: [
        { item: "dev:tests", note: "npm test: 412 passed", done: true },
        { item: "dev:smoke", note: "Ran it against the seed orgs", done: true },
        { item: "dev:security-doc", note: `Drafted, with GITHUB_TOKEN=${GITHUB_TOKEN} left out` },
      ],
    });
    expect(r.result).toMatch(/Your notes are kept beside 3 checklist items, 1 of them ticked as yours \(the user can untick them\)\. 1 secret-looking value was replaced with \[redacted\]/);
    const p = t.record();
    expect(p.gateNotes).toEqual({
      "dev:tests": { by: "Coder's agent", note: "npm test: 412 passed", at: expect.any(Number) },
      "dev:smoke": { by: "Coder's agent", note: "Ran it against the seed orgs", at: expect.any(Number) },
      "dev:security-doc": { by: "Coder's agent", note: "Drafted, with GITHUB_TOKEN=[redacted] left out", at: expect.any(Number) },
    });
    expect(tickOf(p, "dev:tests")).toEqual({ by: "Coder's agent", at: expect.any(Number) });
    expect(tickOf(p, "dev:smoke")).toMatchObject({ by: "you" });
    expect(p.checks["dev:security-doc"]).toBeUndefined();
    t.pipeline.setCheck("4182", "dev:tests", false, BY_YOU);
    expect(tickOf(t.record(), "dev:tests")).toBeNull();
    // the agent's tick reads as its own, never as the user's, whatever the workspace is called
    expect(agentBy({ title: "you" })).toBe("you's agent");
  });

  it("refuses to tick a person's act, a checklist the call isn't about, and anything malformed, writing nothing", async () => {
    const t = setup();
    expect(PERSON_GATE_ITEMS).toEqual(["staging:peer-review", "staging:security-reviewed", "prod:sign-off"]);
    const cases: [TicketStage, string, Record<string, unknown>, RegExp][] = [
      ["approved", TICKET_TOOL.requestPr, { target: "main", title: "t", description: "d", gate_notes: [{ item: "staging:peer-review", note: "Reviewed it myself", done: true }] }, /^staging:peer-review \("Peer review completed"\) records a person's act, so an agent can't tick it/],
      ["approved", TICKET_TOOL.requestPr, { target: "main", title: "t", description: "d", gate_notes: [{ item: "staging:security-reviewed", note: "x", done: true }] }, /records a person's act/],
      ["prod-test", TICKET_TOOL.setStage, { stage: "comms", gate_notes: [{ item: "prod:sign-off", note: "x", done: true }] }, /records a person's act/],
      ["coding", TICKET_TOOL.setStage, { stage: "local-test", gate_notes: [{ item: "staging:secrets", note: "x", done: true }] }, /^staging:secrets is on the "Before the PR to main" checklist; this call reports against "Before the PR to dev\/UAT"\./],
      ["coding", TICKET_TOOL.requestPr, { target: "dev", title: "t", description: "d", gate_notes: [{ item: "prod:rollback", note: "x" }] }, /is on the "Before production" checklist/],
      ["dev-test", TICKET_TOOL.setStage, { stage: "stakeholder", gate_notes: [{ item: "dev:tests", note: "x" }] }, /^There's no checklist at AI testing in dev\/UAT or Stakeholder testing/],
      ["coding", TICKET_TOOL.setStage, { stage: "local-test", gate_notes: [{ item: "dev:vibes", note: "x" }] }, /names "dev:vibes", which isn't a checklist item: they're dev:tests, /],
      ["coding", TICKET_TOOL.setStage, { stage: "local-test", gate_notes: [{ item: "dev:tests", note: "a" }, { item: "dev:tests", note: "b" }] }, /names dev:tests twice/],
      ["coding", TICKET_TOOL.setStage, { stage: "local-test", gate_notes: [{ item: "dev:tests", note: "x", by: "you" }] }, /^Each of gate_notes takes item and note and done, nothing else \(not "by"\)/],
      ["coding", TICKET_TOOL.setStage, { stage: "local-test", gate_notes: [{ item: "dev:tests", note: "  " }] }, /^The note for dev:tests is empty/],
      ["coding", TICKET_TOOL.setStage, { stage: "local-test", gate_notes: [{ item: "dev:tests", note: "x", done: "yes" }] }, /done, for dev:tests, is true or false/],
      ["coding", TICKET_TOOL.setStage, { stage: "local-test", gate_notes: { "dev:tests": "x" } }, /gate_notes is a list/],
    ];
    for (const [stage, op, args, why] of cases) {
      t.at(stage);
      const before = t.disk();
      expect((await t.call("coder", op, args)).error, JSON.stringify(args)).toMatch(why);
      expect(t.disk()).toBe(before);
    }
    // a person's item may carry a note, unticked
    t.at("approved");
    await t.call("coder", TICKET_TOOL.requestPr, { target: "main", title: "t", description: "d", gate_notes: [{ item: "staging:peer-review", note: "Ready for Nick's review" }] });
    expect(t.record().gateNotes?.["staging:peer-review"]).toMatchObject({ note: "Ready for Nick's review", by: "Coder's agent" });
    expect(t.record().checks["staging:peer-review"]).toBeUndefined();
    // the schema names every item, so an agent sees them
    expect((TICKET_TOOL_SCHEMAS[0].inputSchema.properties as any).gate_notes.items.properties.item.enum).toEqual(GATE_ITEM_KEYS);
  });
});

describe("request_pr", () => {
  it("holds one request per ticket and target, a newer replacing the older and saying so; dev from Coding or Local testing, main only once approved", async () => {
    const t = setup();
    const r = await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title: "Org filter\nremembers", description: `## Summary\nIt remembers.\n\ntoken: ${GITHUB_TOKEN}` });
    expect(r.result).toBe(
      'Asked: the user is shown your request for a pull request to dev on #4182, "Org filter remembers", with your description, marked as yours. ' +
        "Nothing is pushed or opened until they open it from Mockingbird; you'll hear if they dismiss it. 1 secret-looking value was replaced with [redacted]; redaction is a net, not a guarantee."
    );
    expect(t.record().requests).toEqual([
      { id: expect.any(String), target: "dev", from: "coder", fromTitle: "Coder", title: "Org filter remembers", description: "## Summary\nIt remembers.\n\ntoken: [redacted]", at: expect.any(Number) },
    ]);
    expect(t.record().stage).toBe("coding");
    t.at("local-test");
    const again = await t.call("busy", TICKET_TOOL.requestPr, { target: "dev", title: "Org filter, again", description: "Second go" });
    expect(again.result).toMatch(/It replaces the request "Coder" made earlier for this target\.$/);
    expect(t.record().requests!.map((x) => [x.target, x.from, x.title])).toEqual([["dev", "busy", "Org filter, again"]]);
    expect((await t.call("busy", TICKET_TOOL.requestPr, { target: "dev", title: "Third", description: "d" })).result).toMatch(/It replaces the request you made earlier/);

    for (const stage of ["ba", "pr-dev", "dev-test", "stakeholder", "approved", "pr-main", "prod-test", "comms", "done"] as const) {
      t.at(stage);
      const before = t.disk();
      expect((await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title: "t", description: "d" })).error, stage).toMatch(/^Nothing was asked: A pull request to dev is asked for from Coding or Local testing/);
      expect(t.disk()).toBe(before);
    }
    for (const stage of ["coding", "local-test", "pr-dev", "dev-test", "stakeholder", "pr-main", "prod-test"] as const) {
      t.at(stage);
      expect((await t.call("coder", TICKET_TOOL.requestPr, { target: "main", title: "t", description: "d" })).error, stage).toMatch(/^Nothing was asked: A pull request to main is asked for once the user has approved stakeholder testing/);
    }
    t.at("approved");
    expect((await t.call("coder", TICKET_TOOL.requestPr, { target: "main", title: "To main", description: "d" })).result).toMatch(/^Asked: .* pull request to main on #4182/);
    // the dev request went with the first move to a stage that doesn't take it
    expect(t.record().requests!.map((x) => x.target)).toEqual(["main"]);
    expect((await t.call("coder", TICKET_TOOL.requestPr, { target: "prod", title: "t", description: "d" })).error).toMatch(/target is "dev" or "main", not "prod"/);
    expect((await t.call("coder", TICKET_TOOL.requestPr, { target: "main", title: "t", description: PRIVATE_KEY })).error).toMatch(/^description holds a private key/);
    expect((await t.call("coder", TICKET_TOOL.requestPr, { target: "main", title: " ", description: "d" })).error).toBe("title is empty.");
    expect((await t.call("coder", TICKET_TOOL.requestPr, { target: "main", title: "t", description: "d", base: "main" })).error).toMatch(/nothing else \(not "base"\)/);
  });

  it("is answered by a pull request opened from the session that asked; another session's PR leaves it to be dropped, saying so", () => {
    const t = setup();
    t.at("local-test");
    t.pipeline.holdRequest("4182", { target: "dev", from: "coder", fromTitle: "Coder", title: "t", description: "d" }, [], "Coder's agent");
    t.pipeline.addPr("4182", prTo("dev", 91, "coder"), undefined, BY_YOU);
    expect(t.record().requests).toEqual([]);
    expect(t.record().prs.at(-1)).toMatchObject({ id: 91, by: "coder" });
    expect(t.record().history.at(-1)!.note).toBeUndefined();
    // opened from B's form: the PR is B's, and A's request goes as PR to dev takes none, the history saying so
    t.at("local-test");
    t.pipeline.holdRequest("4182", { target: "dev", from: "coder", fromTitle: "Coder", title: "t", description: "d" }, [], "Coder's agent");
    t.pipeline.addPr("4182", prTo("dev", 92, "busy"), undefined, BY_YOU);
    const p = t.record();
    expect(p.prs.at(-1)).toMatchObject({ id: 92, by: "busy" });
    expect(p.requests).toEqual([]);
    expect(p.history.at(-1)).toMatchObject({
      stage: "pr-dev",
      note: "Dropped the held request for a pull request to dev from Coder: a pull request to dev was opened from another workspace.",
    });
    // its asker hears why, as a dismissal tells it
    expect(t.told).toEqual([
      { id: "coder", submit: true, text: '[Mockingbird: your request for a pull request to dev on #4182 ("t") was dropped: a pull request to dev was opened from another workspace. Nothing was pushed or opened.]' },
    ]);
    t.at("stakeholder");
    expect(t.tools.approve("4182").told).toEqual({ to: "busy", title: "Busy", told: "queued until its current turn ends" });
  });
});

describe("write_patch_notes", () => {
  it("at AI testing in staging/prod or Patch notes only, replacing an agent's draft and leaving the user's, redacted, at most 4,000 characters", async () => {
    const t = setup();
    for (const stage of ["ba", "coding", "local-test", "pr-dev", "dev-test", "stakeholder", "approved", "pr-main", "done"] as const) {
      t.at(stage);
      const before = t.disk();
      expect((await t.call("verifier", TICKET_TOOL.writePatchNotes, { text: "Notes" })).error, stage).toMatch(/^Nothing was kept: Patch notes are written at AI testing in staging\/prod or Patch notes/);
      expect(t.disk()).toBe(before);
    }
    t.at("prod-test");
    t.pipeline.addDraft("4182", "comms", "The user's own notes");
    const r = await t.call("verifier", TICKET_TOOL.writePatchNotes, { text: `  The org filter remembers your last org. Key: ${GITHUB_TOKEN}  ` });
    expect(r.result).toBe("Kept as #4182's patch notes draft (55 characters), marked as yours. The user reads it and posts it; nothing is posted by this. 1 secret-looking value was replaced with [redacted]; redaction is a net, not a guarantee.");
    t.at("comms");
    const r2 = await t.call("coder", TICKET_TOOL.writePatchNotes, { text: "x".repeat(PATCH_NOTES_MAX) });
    expect(r2.result).toMatch(/\(4,000 characters\).*It replaces the earlier agent's draft\.$/);
    const comms = t.record().drafts.filter((d) => d.stage === "comms");
    expect(comms.map((d) => [d.text.slice(0, 20), d.by])).toEqual([
      ["The user's own notes", undefined],
      ["x".repeat(20), "Coder's agent"],
    ]);
    const before = t.disk();
    expect((await t.call("coder", TICKET_TOOL.writePatchNotes, { text: "x".repeat(PATCH_NOTES_MAX + 1) })).error).toBe("text is 4,001 characters; the limit is 4,000.");
    expect((await t.call("coder", TICKET_TOOL.writePatchNotes, { text: `Notes\n${PRIVATE_KEY}` })).error).toBe("text holds a private key, so nothing was kept: take it out and call again.");
    expect((await t.call("coder", TICKET_TOOL.writePatchNotes, { text: "" })).error).toBe("text is empty.");
    expect(t.disk()).toBe(before);
  });

  it("is guided by the words the window's Write patch notes uses, kept in one place", () => {
    expect(TICKET_TOOL_SCHEMAS.find((x) => x.name === TICKET_TOOL.writePatchNotes)!.description).toContain(PATCH_NOTES_GUIDANCE);
    const src = fs.readFileSync(path.join(__dirname, "../src/main/index.ts"), "utf8");
    const comms = src.slice(src.indexOf('handle("pipeline:comms"'), src.indexOf("askFor(", src.indexOf('handle("pipeline:comms"')));
    expect(comms).toContain("PATCH_NOTES_GUIDANCE,");
    expect(src).not.toContain(PATCH_NOTES_GUIDANCE);
  });
});

describe("nothing an agent calls pushes, opens a pull request or writes to Azure DevOps", () => {
  it("never reaches scmPush, openPr, addComment, updateWorkItem or the network, through every tool, the approval and the dismissal", async () => {
    const t = setup();
    const net = vi.spyOn(globalThis, "fetch").mockImplementation(async () => (reached.push("fetch"), Promise.reject(new Error("no network in a test"))));
    onTestFinished(() => net.mockRestore());
    t.at("coding");
    await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title: "t", description: "d", gate_notes: [{ item: "dev:tests", note: "pass", done: true }] });
    await t.call("coder", TICKET_TOOL.setStage, { stage: "local-test" });
    await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title: "t2", description: "d" });
    const req = t.record().requests![0];
    t.tools.dismissRequest("4182", req.id, "Not yet");
    t.pipeline.addPr("4182", prTo("dev", 91, "coder"), undefined, BY_YOU);
    t.at("stakeholder");
    t.tools.approve("4182");
    await t.call("coder", TICKET_TOOL.requestPr, { target: "main", title: "t", description: "d" });
    t.at("prod-test");
    await t.call("verifier", TICKET_TOOL.writePatchNotes, { text: "Notes" });
    await t.call("verifier", TICKET_TOOL.setStage, { stage: "comms" });
    expect(t.record().stage).toBe("comms");
    expect(reached).toEqual([]);
    for (const spy of [scmPush, openPr, addComment, updateWorkItem]) expect(spy).not.toHaveBeenCalled();
    expect(net).not.toHaveBeenCalled();
    // and none of the ticket tools' code can reach them: it imports none of what pushes, opens or posts
    for (const f of ["ticketTools.ts", "ticketToolSchemas.ts"]) {
      const src = fs.readFileSync(path.join(__dirname, "../src/main", f), "utf8");
      expect(src.match(/from "\.\/(\w+)"/g) ?? [], f).not.toEqual(expect.arrayContaining([expect.stringMatching(/"\.\/(ado|scm|pullRequests|git|safeGit|shell|headless)"/)]));
      expect(src, f).not.toMatch(/\b(scmPush|openPr|addComment|updateWorkItem|fetch)\(/);
    }
  });
});

describe("pipeline:approve and pipeline:request:dismiss", () => {
  it("dismissing a request drops it and tells the agent that asked, with the user's note", async () => {
    const t = setup();
    await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title: "Org <filter>", description: "d" });
    const req = t.record().requests![0];
    const { told } = t.tools.dismissRequest("4182", req.id, "  Split the migration out first.  ");
    expect(told).toEqual({ to: "coder", title: "Coder", told: "delivered" });
    expect(t.told).toEqual([
      {
        id: "coder",
        submit: true,
        text: '[Mockingbird: the user dismissed your request for a pull request to dev on #4182 ("Org \\u003cfilter\\u003e"). Nothing was pushed or opened. Their note follows.]\n\nSplit the migration out first.',
      },
    ]);
    expect(t.record().requests).toEqual([]);
    expect(() => t.tools.dismissRequest("4182", req.id, "")).toThrow(/has no pull request request/);
  });

  it("approves only from stakeholder testing, and tells nobody when no PR to dev says who asked; a closed asker isn't reopened", () => {
    const t = setup();
    expect(() => t.tools.approve("4182")).toThrow("#4182 is at Coding: Approve is for a ticket in stakeholder testing");
    expect(() => t.tools.approve("7777")).toThrow(/isn't tracked/);
    t.at("stakeholder");
    expect(t.tools.approve("4182").told).toEqual({ to: null, title: null, notTold: "No pull request to dev on #4182 says which workspace asked for it, so no agent was told." });
    expect(t.record().stage).toBe("approved");
    expect(t.record().history.at(-1)).toMatchObject({ stage: "approved", by: "you" });
    for (const [asker, title] of [["gone", "Gone coder"], ["exited", "Exited"]]) {
      t.pipeline.addPr("4182", prTo("dev", 93, asker), undefined, BY_YOU);
      t.at("stakeholder");
      expect(t.tools.approve("4182").told, asker).toEqual({ to: asker, title, notTold: `"${title}" isn't running, so it wasn't told, and nothing tells it later: once you reopen it, tell it yourself.`, reopen: true });
    }
    t.takenOver.coder = "Nick took this copy over";
    t.pipeline.addPr("4182", prTo("dev", 94, "coder"), undefined, BY_YOU);
    t.at("stakeholder");
    expect(t.tools.approve("4182").told).toEqual({ to: "coder", title: "Coder", notTold: "Nick took this copy over — take it back rather than telling this copy" });
    expect(t.told).toEqual([]);
  });
});

describe("approval's line to a busy Coder, through the real SessionManager", () => {
  const dir = tempDir("tickettools-sessions");
  const saved: SessionInfo[] = [];
  const sessionStore = {
    settings: { claudeBin: "/bin/echo", codexBin: "/bin/echo", workTrackerPath: tempDir("worktracker") },
    state: { sessions: saved },
    upsertSession(i: SessionInfo) {
      const k = saved.findIndex((x) => x.id === i.id);
      if (k >= 0) saved[k] = i;
      else saved.push(i);
    },
    removeSession(id: string) {
      const k = saved.findIndex((x) => x.id === id);
      if (k >= 0) saved.splice(k, 1);
    },
    save() {},
  };
  const m = new SessionManager(sessionStore as any);
  m.scrollbackDir = path.join(dir, "scrollback");
  afterAll(() => {
    for (const s of m.list()) m.kill(s.id, true);
  });

  it("waits in its queue while it works and reaches it as its turn ends, in Mockingbird's words", async () => {
    const pipeline = new PipelineStore(path.join(dir, "pipeline.json"));
    const coder = await m.create({ repoPath: null, useWorktree: false, agent: "claude", title: "Coder", ticketId: "4182", ticketTitle: "Org filter" });
    const tools = new TicketTools({ pipeline, sessions: m, submitOnDelivery: () => true, takenOver: () => null, roomOf: () => null, roomsKnown: () => true, onChanged: () => {}, log: () => {} });
    pipeline.startCoding("4182", "Org filter", BY_YOU);
    pipeline.setStage("4182", "local-test", { by: BY_YOU });
    pipeline.addPr("4182", prTo("dev", 91, coder.id), undefined, BY_YOU);
    pipeline.setStage("4182", "stakeholder", { by: BY_YOU });
    m.statusFromHook({ paneId: coder.id, status: "working", prompted: true });
    const pty = ptys.filter((p) => p.session === coder.id).at(-1)!;
    const writes = pty.writes.length;

    const { pipeline: p, told } = tools.approve("4182");
    expect(p.stage).toBe("approved");
    expect(told).toEqual({ to: coder.id, title: "Coder", told: "queued until its current turn ends" });
    expect(m.list().find((s) => s.id === coder.id)!.queuedCount).toBe(1);
    expect(pty.writes.slice(writes).join("")).not.toContain("approved");

    m.statusFromHook({ paneId: coder.id, status: "idle" });
    const typed = pty.writes.slice(writes).join("");
    expect(typed).toContain(
      '[Mockingbird: the user approved #4182 "Org filter" in stakeholder testing. Prepare the pull request to main: when the branch is ready, call the mockingbird request_pr tool with target "main". The user opens it; nothing is pushed until they do.]'
    );
    expect(m.list().find((s) => s.id === coder.id)!.queuedCount).toBe(0);
  });
});

describe("the ticket tools through the real MCP server", () => {
  const t = setup();
  const sock = mcpLaunch("unused").env.MOCKINGBIRD_SOCK;
  const relay = new Messaging({ list: () => t.running, deliverAgentMessage: () => "delivered" } as any, () => true, () => {});

  beforeAll(async () => {
    relay.start();
    for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 20));
  });
  afterAll(() => fs.rmSync(sock, { force: true }));

  it("say they aren't ready before they're registered, then act as the token's session alone", async () => {
    expect((await askAs(sock, { from: "coder", op: "set_stage", args: { stage: "local-test" } })).error).toMatch(/^Ticket tools aren't ready yet/);
    relay.setTicketTools(t.tools);
    const launch = testLaunch("coder");
    const server = startServer(launch);
    try {
      const listed: { name: string; inputSchema: unknown }[] = (await server.request("tools/list")).result.tools;
      const mine = listed.filter((x) => (Object.values(TICKET_TOOL) as string[]).includes(x.name));
      expect(mine.map((x) => x.name)).toEqual(["set_stage", "request_pr", "write_patch_notes"]);
      expect(mine.map((x) => x.inputSchema)).toEqual(TICKET_TOOL_SCHEMAS.map((x) => JSON.parse(JSON.stringify(x.inputSchema))));
      for (const x of TICKET_TOOL_SCHEMAS) expect(x.inputSchema.additionalProperties, x.name).toBe(false);
      // another ticket can't be named, and the caller can't be: the token's session's ticket is the one moved
      const forged = await server.call("set_stage", { stage: "local-test", ticket: "5101" });
      expect(forged).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/nothing else \(not "ticket"\)/) }] });
      const r = await server.call("set_stage", { stage: "local-test" });
      expect(r).toMatchObject({ isError: false, content: [{ text: expect.stringMatching(/^#4182 moved from Coding to Local testing/) }] });
    } finally {
      await server.stop();
      retireMcpLaunch(launch);
    }
    expect(t.record("4182").stage).toBe("local-test");
    expect(t.record("5101").stage).toBe("coding");
    expect((await askAs(sock, { from: "other", op: "set_stage", args: { stage: "local-test" } })).result).toMatch(/^#5101 moved/);
    expect(t.record("5101").history.at(-1)).toMatchObject({ by: "Other coder's agent" });
  });
});

describe("pipeline.json across versions", () => {
  it("1.6.0 keeps what the ticket tools write through its own changes", async () => {
    const t = setup();
    t.at("local-test");
    await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title: "t", description: "d", gate_notes: [{ item: "dev:tests", note: "pass", done: true }] });
    t.at("dev-test");
    await t.call("verifier", TICKET_TOOL.setStage, { stage: "coding", note: "Broken on dev" });
    t.at("prod-test");
    await t.call("verifier", TICKET_TOOL.writePatchNotes, { text: "Notes" });
    const ours = t.record();
    const old = new PipelineStore160(t.file);
    old.setStage("4182", "comms");
    old.addDraft("4182", "comms", "Theirs");
    const after = t.record();
    expect(after.requests).toEqual(ours.requests);
    expect(after.gateNotes).toEqual(ours.gateNotes);
    expect(after.feedback).toEqual(ours.feedback);
    expect(after.drafts.slice(0, ours.drafts.length)).toEqual(ours.drafts);
    expect(new PipelineStore(t.file).get("4182")!.requests).toEqual(ours.requests);
  });
});

describe("review fixes 1", () => {
  it("the user's edit makes an agent's draft theirs: the agent's next patch notes don't replace it", async () => {
    const t = setup();
    t.at("prod-test");
    await t.call("verifier", TICKET_TOOL.writePatchNotes, { text: "Agent draft one." });
    const d = t.record().drafts.find((x) => x.stage === "comms" && x.by)!;
    expect(d).toMatchObject({ by: "Verifier's agent", from: "verifier" });
    t.pipeline.editDraft("4182", d.id, "Rewritten by the user.");
    expect(t.record().drafts.find((x) => x.id === d.id)).toEqual({ id: d.id, stage: "comms", text: "Rewritten by the user.", at: d.at });
    const r = await t.call("verifier", TICKET_TOOL.writePatchNotes, { text: "Agent draft two." });
    expect(r.result).not.toMatch(/replaces/);
    expect(t.record().drafts.filter((x) => x.stage === "comms").map((x) => x.text)).toEqual(["Rewritten by the user.", "Agent draft two."]);
  });

  it("approval tells only a session still on the ticket: one moved to another says where it is now, and is told nothing", async () => {
    const t = setup();
    t.pipeline.addPr("4182", prTo("dev", 91, "coder"), undefined, BY_YOU);
    t.running[0] = { ...t.as("coder"), ticketId: "5101" };
    t.at("stakeholder");
    expect(t.tools.approve("4182").told).toEqual({ to: "coder", title: "Coder", notTold: '"Coder" is on #5101 now, so it wasn\'t told.' });
    t.running[0] = { ...t.as("coder"), ticketId: null };
    t.pipeline.addPr("4182", prTo("dev", 92, "coder"), undefined, BY_YOU);
    t.at("stakeholder");
    expect(t.tools.approve("4182").told).toMatchObject({ notTold: '"Coder" isn\'t on a ticket now, so it wasn\'t told.' });
    expect(t.told).toEqual([]);
  });

  it("a failure while telling never half-finishes approval or dismissal: the move stands, the answer says so, and it's logged", async () => {
    const t = setup();
    await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title: "t", description: "d" });
    t.pipeline.addPr("4182", prTo("dev", 91, "coder"), undefined, BY_YOU);
    t.at("stakeholder");
    t.takenOver.coder = "throws";
    const a = t.tools.approve("4182");
    expect(a.told).toEqual({ to: "coder", title: null, notTold: "It couldn't be told: the take-over state can't be read" });
    expect(t.record().stage).toBe("approved");
    expect(t.logged).toEqual(["tickets: telling coder about #4182: the take-over state can't be read"]);
    t.at("coding");
    delete t.takenOver.coder;
    await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title: "t", description: "d" });
    t.takenOver.coder = "throws";
    const d = t.tools.dismissRequest("4182", t.record().requests![0].id, "");
    expect(d.told).toMatchObject({ notTold: "It couldn't be told: the take-over state can't be read" });
    expect(t.record().requests).toEqual([]);
    // the window hears of the record however the call ends
    const src = fs.readFileSync(path.join(__dirname, "../src/main/index.ts"), "utf8");
    expect(src).toMatch(/const pipelineDo = async <T,>\(fn: \(\) => T \| Promise<T>\): Promise<T> => \{\n  try \{\n    return await fn\(\);\n  \} finally \{\n    pipelineChanged\(\);/);
  });

  it("holds every cap after redaction, which can lengthen a value: refused, saying so", async () => {
    const t = setup();
    const title = "pwd=Zq9xW2kL ".repeat(15);
    expect((await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title, description: "d" })).error).toBe(
      "title is 224 characters once its 15 secret-looking values are replaced with [redacted]; the limit is 200: shorten it."
    );
    t.at("prod-test");
    const text = "pwd=Zq9xW2kL ".repeat(307);
    expect(text.trim().length).toBeLessThanOrEqual(PATCH_NOTES_MAX);
    expect((await t.call("verifier", TICKET_TOOL.writePatchNotes, { text })).error).toMatch(/^text is 4,604 characters once its 307 secret-looking values are replaced with \[redacted\]; the limit is 4,000/);
    expect(t.record().requests ?? []).toEqual([]);
    expect(t.record().drafts.filter((d) => d.stage === "comms")).toEqual([]);
  });

  it("takes bidi controls and zero-width characters out of titles, descriptions, patch notes, gate notes and feedback", async () => {
    const t = setup();
    const hidden = "‮⁦​‍﻿⁩‬";
    await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title: `Fix ${hidden}gnissap tests`, description: `Line one${hidden}\nLine two`, gate_notes: [{ item: "dev:tests", note: `ran${hidden} them` }] });
    const req = t.record().requests![0];
    expect([req.title, req.description, t.record().gateNotes!["dev:tests"].note]).toEqual(["Fix gnissap tests", "Line one\nLine two", "ran them"]);
    t.at("dev-test");
    await t.call("verifier", TICKET_TOOL.setStage, { stage: "coding", note: `Broken${hidden}` });
    expect(t.record().feedback.at(-1)!.text).toBe("Broken");
    t.at("prod-test");
    await t.call("verifier", TICKET_TOOL.writePatchNotes, { text: `It ${hidden}remembers.` });
    expect(t.record().drafts.at(-1)!.text).toBe("It remembers.");
    expect((await t.call("coder", TICKET_TOOL.writePatchNotes, { text: hidden })).error).toBe("text is empty.");
  });

  it("takes every other format character out too, and the Hangul fillers: tag characters, the soft hyphen, the Mongolian vowel separator, the invisible operators", async () => {
    const t = setup();
    // "Approve" spelled in tag characters (U+E0041…), unseen where the user reads it
    const tags = [..."Approve"].map((c) => String.fromCodePoint(0xe0000 + c.codePointAt(0)!)).join("");
    const others = "\u00ad\u180e\u2061\u2062\u2063\u2064\u206a\u206f\u{1d173}\u{1d17a}\u115f\u1160\u3164\uffa0";
    await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title: `Fix${tags} it`, description: `Done${others}.`, gate_notes: [{ item: "dev:tests", note: `ran${tags}${others}` }] });
    const req = t.record().requests![0];
    expect([req.title, req.description, t.record().gateNotes!["dev:tests"].note]).toEqual(["Fix it", "Done.", "ran"]);
    t.at("prod-test");
    expect((await t.call("coder", TICKET_TOOL.writePatchNotes, { text: tags + others })).error).toBe("text is empty.");
  });

  it("an item the user unticked isn't ticked again by an agent until the user ticks it or moves the ticket; a note on it still is kept", async () => {
    const t = setup();
    await t.call("coder", TICKET_TOOL.setStage, { stage: "local-test", gate_notes: [{ item: "dev:tests", note: "ran", done: true }] });
    t.pipeline.setCheck("4182", "dev:tests", false, BY_YOU);
    expect(t.record().unticked).toEqual({ "dev:tests": { at: expect.any(Number), stage: "local-test" } });
    const before = t.disk();
    const r = await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title: "t", description: "d", gate_notes: [{ item: "dev:tests", note: "ran again", done: true }] });
    expect(r.error).toBe("The user unticked dev:tests at Local testing, so no agent ticks it again until the user ticks it or moves the ticket: leave done out, and say in its note what changed.");
    expect(t.disk()).toBe(before);
    await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title: "t", description: "d", gate_notes: [{ item: "dev:tests", note: "Fixed the flaky one; ran again" }] });
    expect(t.record().gateNotes!["dev:tests"].note).toBe("Fixed the flaky one; ran again");
    expect(tickOf(t.record(), "dev:tests")).toBeNull();
    // the user's own tick ends it; so does the user's move
    t.pipeline.setCheck("4182", "dev:tests", true, BY_YOU);
    expect(t.record().unticked).toEqual({});
    t.pipeline.setCheck("4182", "dev:tests", false, BY_YOU);
    t.at("coding");
    expect(t.record().unticked).toBeUndefined();
    // an agent's own move doesn't: unticked at Coding, then set_stage to Local testing, and the tick is still refused
    t.pipeline.setCheck("4182", "dev:tests", true, BY_YOU);
    t.pipeline.setCheck("4182", "dev:tests", false, BY_YOU);
    expect((await t.call("coder", TICKET_TOOL.setStage, { stage: "local-test" })).result).toMatch(/^#4182 moved from Coding to Local testing/);
    expect(t.record().unticked).toEqual({ "dev:tests": { at: expect.any(Number), stage: "coding" } });
    expect((await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title: "t", description: "d", gate_notes: [{ item: "dev:tests", note: "ran", done: true }] })).error).toMatch(/^The user unticked dev:tests at Coding/);
    t.at("coding");
    await t.call("coder", TICKET_TOOL.setStage, { stage: "local-test", gate_notes: [{ item: "dev:tests", note: "ran", done: true }] });
    expect(tickOf(t.record(), "dev:tests")).toMatchObject({ by: "Coder's agent" });
  });

  it("no request or patch notes draft is replaced across a team room's line, either way, nor while rooms are starting, and no name crosses it", async () => {
    const t = setup();
    t.rooms.busy = "room-1";
    await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title: "Private", description: "d" });
    const before = t.disk();
    const fromRoom = await t.call("busy", TICKET_TOOL.requestPr, { target: "dev", title: "From the room", description: "d" });
    expect(fromRoom.error).toBe(
      "Nothing was asked: a request for a pull request to dev is held from another workspace, and it's on the other side of a team room's line, so this can't replace it: the user opens or dismisses it first."
    );
    expect(fromRoom.error).not.toContain("Coder");
    expect(t.disk()).toBe(before);
    // and the reverse
    t.pipeline.dropRequest("4182", t.record().requests![0].id);
    await t.call("busy", TICKET_TOOL.requestPr, { target: "dev", title: "From the room", description: "d" });
    expect((await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title: "Private", description: "d" })).error).toMatch(/other side of a team room's line/);
    // the same room: replaced, and named
    t.rooms.coder = "room-1";
    expect((await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title: "Private", description: "d" })).result).toMatch(/It replaces the request "Busy" made earlier/);
    delete t.rooms.coder;
    // patch notes
    t.at("prod-test");
    await t.call("verifier", TICKET_TOOL.writePatchNotes, { text: "Private notes" });
    expect((await t.call("busy", TICKET_TOOL.writePatchNotes, { text: "Room notes" })).error).toBe(
      "Nothing was kept: the patch notes draft there is another workspace's, and it's on the other side of a team room's line, so this can't replace it: the user opens or dismisses it first."
    );
    t.flags.roomsKnown = false;
    expect((await t.call("coder", TICKET_TOOL.writePatchNotes, { text: "Mine" })).error).toBe(`Nothing was kept: the patch notes draft there is another workspace's, and ${ROOMS_STARTING}`);
    // its own draft it replaces whatever rooms are doing
    expect((await t.call("verifier", TICKET_TOOL.writePatchNotes, { text: "Private notes, again" })).result).toMatch(/It replaces the earlier agent's draft/);
  });

  it("a held request goes when a move takes the ticket to a stage that doesn't take it, the history saying so", async () => {
    const t = setup();
    t.at("approved");
    await t.call("coder", TICKET_TOOL.requestPr, { target: "main", title: "To main", description: "d" });
    await t.call("verifier", TICKET_TOOL.setStage, { stage: "coding", note: "Rework" });
    expect(t.record().requests).toEqual([]);
    expect(t.record().history.at(-1)!.note).toBe(
      "Rework\n\nDropped the held request for a pull request to main from Coder: A pull request to main is asked for once the user has approved stakeholder testing; it's at Coding."
    );
    expect(t.told).toEqual([
      {
        id: "coder",
        submit: true,
        text: '[Mockingbird: your request for a pull request to main on #4182 ("To main") was dropped: A pull request to main is asked for once the user has approved stakeholder testing; it\'s at Coding. Nothing was pushed or opened.]',
      },
    ]);
    // an asker that has moved to another ticket isn't told
    t.at("approved");
    await t.call("coder", TICKET_TOOL.requestPr, { target: "main", title: "To main", description: "d" });
    t.running[0] = { ...t.as("coder"), ticketId: "5101" };
    t.at("coding");
    expect(t.told).toHaveLength(1);
    t.running[0] = { ...t.as("coder"), ticketId: "4182" };
    // a move that keeps it takeable keeps it
    await t.call("coder", TICKET_TOOL.requestPr, { target: "dev", title: "To dev", description: "d" });
    t.at("local-test");
    expect(t.record().requests!.map((r) => r.target)).toEqual(["dev"]);
  });
});
