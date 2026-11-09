import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { PipelineStore, stageComment } from "../src/main/pipeline";
import { parseRemote } from "../src/main/git";
import { findOpenPr, prBaseProblem, openPr, pickBase, prDescriptionPrompt, prError, prPreflight, summaryOf, type AdoCall } from "../src/main/pullRequests";
import type { ShellRunner } from "../src/main/headless";
import { BY_YOU, GATES, stageLabel, stageStep, tickOf, TICKET_STAGES, type PipelinePr, type TicketPipeline, type TicketStage } from "../src/shared/types";
import { nextSteps, railOf } from "../src/renderer/ticketPipelineModel";
import { PipelineStore as PipelineStore160 } from "./fixtures/pipeline-1.6.0/pipeline";
import { TICKET_STAGES as TICKET_STAGES_160, stageLabel as stageLabel160 } from "./fixtures/pipeline-1.6.0/types";
import { git, makeRepo, tempDir, write } from "./helpers";

const storeFile = () => path.join(tempDir("pipeline"), "pipeline.json");
const readFile = (f: string): Record<string, TicketPipeline> => JSON.parse(fs.readFileSync(f, "utf8"));
const prTo = (target: "dev" | "main", id: number): PipelinePr => ({ target, provider: "ado", id, url: `https://dev.azure.com/o/p/_git/r/pullrequest/${id}`, repo: "p/r", branch: "5101-x", base: target, at: id, summary: `PR ${id}'s summary.` });

describe("the ticket pipeline store", () => {
  it("moves a ticket through stages, drafting each stage's comment", () => {
    const s = new PipelineStore(storeFile());
    const p = s.setStage("5101", "coding", { title: "Org dropdowns" });
    expect(p.stage).toBe("coding");
    expect(p.title).toBe("Org dropdowns");
    expect(p.drafts.map((d) => d.text)).toEqual(["Development has started."]);
    s.setStage("5101", "stakeholder");
    expect(s.get("5101")!.history.map((h) => h.stage)).toEqual(["coding", "stakeholder"]);
  });
  it("starts a ticket at Coding when a session opens on it, but never moves one back", () => {
    const s = new PipelineStore(storeFile());
    expect(s.startCoding("1", "t")!.stage).toBe("coding");
    s.setStage("1", "pr-dev");
    expect(s.startCoding("1")).toBeNull();
    expect(s.get("1")!.stage).toBe("pr-dev");
    s.setStage("1", "dev-test");
    expect(s.startCoding("1")).toBeNull();
    expect(s.get("1")!.stage).toBe("dev-test");
  });
  it("sends stakeholder feedback back to Coding, quoting it in the draft", () => {
    const s = new PipelineStore(storeFile());
    s.setStage("7", "stakeholder");
    const p = s.addFeedback("7", "The dropdown should remember the last org", BY_YOU);
    expect(p.stage).toBe("coding");
    expect(p.history.at(-1)).toMatchObject({ stage: "coding", note: "The dropdown should remember the last org", by: "you" });
    expect(p.feedback[0].text).toBe("The dropdown should remember the last org");
    expect(p.drafts.at(-1)!.stage).toBe("coding");
    expect(p.drafts.at(-1)!.text).toBe("Stakeholder feedback received; back in development to address it:\n\nThe dropdown should remember the last org");
    expect(() => s.addFeedback("7", "  ")).toThrow(/empty/);
  });
  it("records a pull request and moves to its stage with the link in the draft", () => {
    const s = new PipelineStore(storeFile());
    const pr = { target: "dev" as const, provider: "ado" as const, id: 42, url: "https://dev.azure.com/o/p/_git/r/pullrequest/42", repo: "p/r", branch: "5101-x", base: "dev", at: 1, summary: "Adds the dropdown." };
    const p = s.addPr("5101", pr);
    expect(p.stage).toBe("pr-dev");
    expect(p.prs).toHaveLength(1);
    expect(p.drafts.at(-1)!.text).toBe("Pull request to dev opened:\n\nhttps://dev.azure.com/o/p/_git/r/pullrequest/42\n5101-x → dev\n\nAdds the dropdown.");
  });
  it("keeps who made each move, and moves from before that without one", () => {
    const s = new PipelineStore(storeFile());
    s.startCoding("2", "t", BY_YOU);
    s.setStage("2", "local-test", { by: BY_YOU });
    s.addPr("2", prTo("dev", 5), undefined, BY_YOU);
    s.setStage("2", "dev-test");
    expect(s.get("2")!.history.map((h) => [h.stage, h.by])).toEqual([
      ["coding", "you"],
      ["local-test", "you"],
      ["pr-dev", "you"],
      ["dev-test", undefined],
    ]);
    expect("by" in s.get("2")!.history[3]).toBe(false);
  });
  it("keeps checklist ticks with who ticked them, and edits or discards drafts", () => {
    const s = new PipelineStore(storeFile());
    s.setStage("9", "coding");
    const before = Date.now();
    s.setCheck("9", "dev:tests", true, BY_YOU);
    const p = s.get("9")!;
    expect(p.checks).toEqual({ "dev:tests": true });
    expect(tickOf(p, "dev:tests")).toEqual({ by: "you", at: expect.any(Number) });
    expect(tickOf(p, "dev:tests")!.at).toBeGreaterThanOrEqual(before);
    s.setCheck("9", "dev:tests", false, BY_YOU);
    expect(s.get("9")!.checks).toEqual({});
    expect(s.get("9")!.checkedBy).toEqual({});
    const d = s.get("9")!.drafts[0];
    s.editDraft("9", d.id, "Started on it.");
    expect(s.findDraft("9", d.id).text).toBe("Started on it.");
    s.dropDraft("9", d.id);
    expect(s.get("9")!.drafts).toEqual([]);
    expect(() => s.dropDraft("9", d.id)).toThrow(/No draft/);
  });
  it("reads a tick's author only while the item is ticked", () => {
    // 1.6.0 unticks by deleting the check alone, leaving its author beside it
    const p: TicketPipeline = { ticketId: "1", stage: "local-test", history: [], prs: [], feedback: [], drafts: [], checks: { "dev:smoke": true }, checkedBy: { "dev:tests": { by: "you", at: 1 } } };
    expect(tickOf(p, "dev:tests")).toBeNull();
    expect(tickOf(p, "dev:smoke")).toBeNull();
  });
  it("persists, and keeps an unreadable file aside instead of overwriting it", () => {
    const f = storeFile();
    new PipelineStore(f).setStage("3", "approved");
    expect(new PipelineStore(f).get("3")!.stage).toBe("approved");
    fs.writeFileSync(f, "{ not json");
    expect(new PipelineStore(f).all()).toEqual({});
    expect(fs.readdirSync(path.dirname(f)).some((n) => n.startsWith("pipeline.json.corrupt-"))).toBe(true);
  });
  it("opens empty, and says so, when an unreadable file can't be moved aside", () => {
    const f = storeFile();
    fs.writeFileSync(f, "{ not json");
    fs.chmodSync(path.dirname(f), 0o500); // nothing can be renamed in here
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(new PipelineStore(f).all()).toEqual({});
      expect(errors.mock.calls.some((c) => /couldn't be moved aside/.test(String(c[0])))).toBe(true);
    } finally {
      fs.chmodSync(path.dirname(f), 0o700);
      errors.mockRestore();
    }
  });
  it("refuses a stage id it doesn't know, for a move or a draft", () => {
    const s = new PipelineStore(storeFile());
    s.setStage("4", "coding");
    expect(() => s.setStage("4", "uat-signoff" as TicketStage)).toThrow('Unknown stage "uat-signoff"');
    expect(() => s.addDraft("4", "uat-signoff" as TicketStage, "x")).toThrow('Unknown stage "uat-signoff"');
    expect(s.get("4")!.stage).toBe("coding");
    expect(s.get("4")!.drafts).toHaveLength(1);
  });
});

describe("the comment each stage drafts", () => {
  const pr = prTo("main", 9);
  it("is the table's, for every stage", () => {
    const drafted = Object.fromEntries(TICKET_STAGES.map((s) => [s.id, stageComment(s.id, { pr, summary: pr.summary })]));
    expect(drafted).toEqual({
      ba: null,
      coding: "Development has started.",
      "local-test": "Development is done; testing locally.",
      "pr-dev": "Pull request to dev opened:\n\nhttps://dev.azure.com/o/p/_git/r/pullrequest/9\n5101-x → main\n\nPR 9's summary.",
      "dev-test": null,
      stakeholder: "Deployed to dev/UAT and tested; ready for stakeholder testing.",
      approved: "Approved in stakeholder testing.",
      "pr-main": "Pull request to main opened:\n\nhttps://dev.azure.com/o/p/_git/r/pullrequest/9\n5101-x → main\n\nPR 9's summary.",
      "prod-test": "Merged to main; testing in staging/production.",
      comms: null,
      done: "Done.",
    });
  });
  it("says a ticket is back in development, not that it has started, once it has been", () => {
    const s = new PipelineStore(storeFile());
    s.startCoding("6");
    s.setStage("6", "done");
    expect(s.setStage("6", "coding", { by: BY_YOU }).drafts.at(-1)!.text).toBe("Back in development.");
    // a ticket set straight to a later stage by hand, then back, has been in development too
    s.setStage("8", "stakeholder");
    expect(s.setStage("8", "coding").drafts.at(-1)!.text).toBe("Back in development.");
    // BA isn't development
    s.setStage("10", "ba");
    expect(s.setStage("10", "coding").drafts.at(-1)!.text).toBe("Development has started.");
  });
  it("drafts nothing at BA, AI testing in dev/UAT or Patch notes", () => {
    const s = new PipelineStore(storeFile());
    for (const stage of ["ba", "dev-test", "comms"] as const) s.setStage("11", stage);
    expect(s.get("11")!.drafts).toEqual([]);
  });
});

describe("pipeline.json across versions", () => {
  it("1.6.0 reads and writes a file this build wrote, keeping dev-test, who moved it and who ticked", () => {
    const f = storeFile();
    const now = new PipelineStore(f);
    now.startCoding("5102", "Quick view", BY_YOU);
    now.setStage("5102", "local-test", { by: BY_YOU });
    now.setCheck("5102", "dev:tests", true, BY_YOU);
    now.addPr("5102", prTo("dev", 91), undefined, BY_YOU);
    now.setStage("5102", "dev-test", { by: BY_YOU });
    now.setStage("5101", "stakeholder", { by: BY_YOU });
    const written = readFile(f);

    const old = new PipelineStore160(f);
    const t = old.get("5102")!;
    // 1.6.0's panel: the chip and the heading say the id, the rail marks no step, and no next step or checklist shows
    expect(t.stage).toBe("dev-test");
    expect(stageLabel160(t.stage)).toBe("dev-test");
    expect(TICKET_STAGES_160.findIndex((s) => s.id === t.stage)).toBe(-1);
    // a session opened on it leaves it alone, and 1.6.0 can't set it
    expect(old.startCoding("5102")).toBeNull();
    expect(() => old.setStage("5103", "dev-test" as never)).toThrow(/Unknown stage/);
    // 1.6.0's own changes: a tick and a draft on the ticket, another ticket moved
    old.setCheck("5102", "dev:smoke", true);
    old.addDraft("5102", "pr-dev", "Merged to dev.");
    old.setStage("5101", "approved");

    const after = readFile(f);
    expect(after["5102"]).toEqual({
      ...written["5102"],
      checks: { "dev:tests": true, "dev:smoke": true },
      drafts: [...written["5102"].drafts, expect.objectContaining({ stage: "pr-dev", text: "Merged to dev." })],
    });
    expect(after["5102"].history.map((h) => [h.stage, h.by])).toEqual([
      ["coding", "you"],
      ["local-test", "you"],
      ["pr-dev", "you"],
      ["dev-test", "you"],
    ]);
    expect(after["5102"].checkedBy).toEqual(written["5102"].checkedBy);
    expect(after["5101"].stage).toBe("approved");

    // and this build reads what 1.6.0 wrote: its tick without an author is still a tick
    const back = new PipelineStore(f).get("5102")!;
    expect(stageLabel(back.stage)).toBe("AI testing in dev/UAT");
    expect(tickOf(back, "dev:tests")?.by).toBe("you");
    expect(back.checks["dev:smoke"]).toBe(true);
    expect(tickOf(back, "dev:smoke")).toBeNull();
  });

  it("1.6.0 unticking an item leaves its author unread here", () => {
    const f = storeFile();
    new PipelineStore(f).setCheck("1", "dev:tests", true, BY_YOU);
    new PipelineStore160(f).setCheck("1", "dev:tests", false);
    const p = new PipelineStore(f).get("1")!;
    expect(p.checks).toEqual({});
    expect(tickOf(p, "dev:tests")).toBeNull();
  });

  /** Each of 1.6.0's stages: where it lands here, as the rail shows it, and the next steps offered. */
  const LANDS: Record<(typeof TICKET_STAGES_160)[number]["id"], { label: string; step: number; sub: string | null; next: string[] }> = {
    ba: { label: "BA", step: 1, sub: null, next: ["Start coding"] },
    coding: { label: "Coding", step: 2, sub: null, next: ["Ready for local testing"] },
    "local-test": { label: "Local testing", step: 3, sub: null, next: ["Create PR to dev…"] },
    "pr-dev": { label: "PR to dev", step: 4, sub: null, next: ["Merged — AI testing in dev/UAT"] },
    stakeholder: { label: "Stakeholder testing", step: 6, sub: null, next: ["Record feedback…", "Approve"] },
    approved: { label: "Approved", step: 6, sub: "approved", next: ["Create PR to main…"] },
    "pr-main": { label: "PR to main", step: 6, sub: "PR to main open", next: ["Merged — AI testing in staging/prod"] },
    "prod-test": { label: "AI testing in staging/prod", step: 7, sub: null, next: ["Write patch notes"] },
    comms: { label: "Patch notes", step: 8, sub: null, next: ["Done"] },
    done: { label: "Done", step: 9, sub: null, next: ["Reopen"] },
  };

  it("lands a ticket 1.6.0 left at each of its stages where it means the same, with all it had", () => {
    expect(Object.keys(LANDS)).toEqual(TICKET_STAGES_160.map((s) => s.id));
    const f = storeFile();
    const old = new PipelineStore160(f);
    for (const [i, { id }] of TICKET_STAGES_160.entries()) {
      const t = String(6000 + i);
      old.startCoding(t, `Ticket at ${id}`);
      old.setCheck(t, "dev:tests", true);
      old.addPr(t, prTo("dev", 100 + i));
      old.addFeedback(t, `Feedback for ${id}`);
      old.addDraft(t, "comms", `Notes for ${id}`);
      old.setStage(t, id);
    }
    const written = readFile(f);

    const now = new PipelineStore(f);
    for (const [i, { id }] of TICKET_STAGES_160.entries()) {
      const t = String(6000 + i);
      const p = now.get(t)!;
      expect(p).toEqual(written[t]);
      expect(p.stage).toBe(id);
      const want = LANDS[id];
      expect({ label: stageLabel(p.stage), step: stageStep(p.stage) }).toEqual({ label: want.label, step: want.step });
      const rail = railOf(p.stage);
      expect(rail.filter((r) => r.state === "on").map((r) => [r.step, r.sub])).toEqual([[want.step, want.sub]]);
      expect(rail.filter((r) => r.state === "done").map((r) => r.step)).toEqual(rail.map((r) => r.step).filter((n) => n < want.step));
      expect(nextSteps(p.stage).map((n) => n.label)).toEqual(want.next);
    }
    // each gate's checklist still shows at the stage it did in 1.6.0
    expect(GATES.map((g) => [g.id, g.at])).toEqual([
      ["dev", "local-test"],
      ["staging", "approved"],
      ["prod", "prod-test"],
    ]);
    // a move here keeps the ticket's history, PRs, feedback, drafts and ticks, and leaves every other ticket as it was
    now.setStage("6004", "approved", { by: BY_YOU });
    const after = readFile(f);
    for (const t of Object.keys(written).filter((t) => t !== "6004")) expect(after[t]).toEqual(written[t]);
    expect(after["6004"]).toEqual({
      ...written["6004"],
      stage: "approved",
      history: [...written["6004"].history, { at: expect.any(Number), stage: "approved", by: "you" }],
      drafts: [...written["6004"].drafts, expect.objectContaining({ stage: "approved", text: "Approved in stakeholder testing." })],
    });
    expect(after["6004"].prs).toHaveLength(1);
    expect(after["6004"].feedback.map((x) => x.text)).toEqual(["Feedback for stakeholder"]);
    expect(after["6004"].checks).toEqual({ "dev:tests": true });
  });

  it("shows a stage id from a newer build as itself, at no step, and writes it back unchanged", () => {
    const f = storeFile();
    const newer = {
      "7001": {
        ticketId: "7001",
        title: "From a newer build",
        stage: "uat-signoff",
        history: [
          { at: 1, stage: "coding", by: "you" },
          { at: 2, stage: "uat-signoff", by: "Verifier", reason: "a field this build doesn't know" },
        ],
        prs: [],
        feedback: [],
        drafts: [{ id: "d1", stage: "uat-signoff", text: "Signed off in UAT.", at: 2 }],
        checks: { "uat:sign": true },
        checkedBy: { "uat:sign": { by: "Verifier", at: 2, via: "gate_notes" } },
        gateNotes: { "uat:sign": { by: "Verifier", note: "Checked the build", at: 2 } },
        requests: [{ id: "r1", target: "main" }],
      },
    };
    fs.writeFileSync(f, JSON.stringify(newer));
    const s = new PipelineStore(f);
    const p = s.get("7001")!;
    expect(stageLabel(p.stage)).toBe("uat-signoff");
    expect(stageStep(p.stage)).toBeNull();
    expect(railOf(p.stage).map((r) => [r.state, r.sub])).toEqual(railOf(p.stage).map(() => ["todo", null]));
    expect(nextSteps(p.stage)).toEqual([]);
    expect(GATES.filter((g) => g.at === p.stage)).toEqual([]);
    expect(stageLabel(p.drafts[0].stage)).toBe("uat-signoff");
    // a session opened on it leaves it alone, and this build won't set it
    expect(s.startCoding("7001")).toBeNull();
    expect(() => s.setStage("7002", "uat-signoff" as TicketStage)).toThrow(/Unknown stage/);
    // saves for other tickets, and for its own ticks and drafts, write it back as it was
    s.setStage("7002", "coding", { by: BY_YOU });
    s.setCheck("7001", "dev:tests", true, BY_YOU);
    s.setCheck("7001", "dev:tests", false, BY_YOU);
    const d = s.addDraft("7001", "comms", "Patch notes").drafts.at(-1)!;
    s.dropDraft("7001", d.id);
    expect(readFile(f)["7001"]).toEqual(newer["7001"]);
  });
});

describe("pull request remotes", () => {
  it("recognises Azure DevOps and GitHub remotes", () => {
    expect(parseRemote("https://acme@dev.azure.com/acme/Back%20Office/_git/backoffice")).toEqual({ provider: "ado", base: "https://dev.azure.com/acme", project: "Back Office", repo: "backoffice" });
    expect(parseRemote("https://acme.visualstudio.com/DefaultCollection/Portal/_git/client-portal")).toEqual({ provider: "ado", base: "https://acme.visualstudio.com", project: "Portal", repo: "client-portal" });
    expect(parseRemote("git@ssh.dev.azure.com:v3/acme/Portal/client-portal")).toEqual({ provider: "ado", base: "https://dev.azure.com/acme", project: "Portal", repo: "client-portal" });
    expect(parseRemote("git@github.com:RyansCode-hue/Mockingbird.git")).toEqual({ provider: "github", owner: "RyansCode-hue", repo: "Mockingbird" });
    expect(parseRemote("https://github.com/RyansCode-hue/Mockingbird")).toEqual({ provider: "github", owner: "RyansCode-hue", repo: "Mockingbird" });
    expect(parseRemote("https://gitlab.com/a/b.git")).toBeNull();
    // names with dots keep them; only a final .git goes
    expect(parseRemote("git@github.com:socketio/socket.io.git")).toEqual({ provider: "github", owner: "socketio", repo: "socket.io" });
    expect(parseRemote("https://github.com/me/my.dotted.repo")).toEqual({ provider: "github", owner: "me", repo: "my.dotted.repo" });
    for (const u of ["ssh://git@github.com/me/app.git", "git+https://github.com/me/app.git", "git://github.com/me/app", "https://www.github.com/me/app/"]) {
      expect(parseRemote(u)).toEqual({ provider: "github", owner: "me", repo: "app" });
    }
  });
  it("picks the target's usual branch name that exists on origin", () => {
    expect(pickBase("dev", ["main", "develop"])).toBe("develop");
    expect(pickBase("dev", ["main", "dev", "uat"])).toBe("dev");
    expect(pickBase("main", ["master", "dev"])).toBe("master");
    expect(pickBase("dev", ["main"])).toBeNull();
  });
  it("won't take the other target's branch as the base", () => {
    const bases = ["develop", "uat", "master", "main", "release/2.1"];
    expect(prBaseProblem("main", "develop", bases)).toMatch(/develop is a dev\/UAT branch/);
    expect(prBaseProblem("main", "uat", bases)).toMatch(/uat is a dev\/UAT branch/);
    expect(prBaseProblem("dev", "master", bases)).toMatch(/master is a main branch/);
    expect(prBaseProblem("main", "main", bases)).toBeNull();
    expect(prBaseProblem("dev", "release/2.1", bases)).toBeNull();
  });
});

describe("opening pull requests", () => {
  const ado = { provider: "ado" as const, base: "https://dev.azure.com/acme", project: "Portal", repo: "client-portal" };
  const recorder = () => {
    const calls: { url: string; method: string; body?: any }[] = [];
    const call: AdoCall = async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (/repositories\/client-portal\?/.test(url)) return { id: "repo-guid", webUrl: "https://dev.azure.com/acme/Portal/_git/client-portal" };
      if (init?.method === "POST") return { pullRequestId: 77 };
      return { value: [{ pullRequestId: 12 }] };
    };
    return { calls, call };
  };
  const noRun: ShellRunner = async () => ({ code: 1, out: "unused" });

  it("creates an ADO pull request linked to the ticket's work item", async () => {
    const { calls, call } = recorder();
    const r = await openPr(ado, { branch: "5101-x", base: "dev", title: "#5101 Org dropdowns", description: "## Summary\nx", workItemId: "5101" }, { ado: call, run: noRun, cwd: "/", env: {} });
    expect(r).toEqual({ id: 77, url: "https://dev.azure.com/acme/Portal/_git/client-portal/pullrequest/77" });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://dev.azure.com/acme/Portal/_apis/git/repositories/repo-guid/pullrequests?api-version=7.0");
    expect(post.body).toEqual({ sourceRefName: "refs/heads/5101-x", targetRefName: "refs/heads/dev", title: "#5101 Org dropdowns", description: "## Summary\nx", workItemRefs: [{ id: "5101" }] });
  });
  it("shortens a description past ADO's 4000-character limit", async () => {
    const { calls, call } = recorder();
    await openPr(ado, { branch: "b", base: "dev", title: "t", description: "x".repeat(5000) }, { ado: call, run: noRun, cwd: "/", env: {} });
    const body = calls.find((c) => c.method === "POST")!.body;
    expect(body.description.length).toBeLessThanOrEqual(4000);
    expect(body.workItemRefs).toBeUndefined();
  });
  it("finds a pull request already open from the branch", async () => {
    const { calls, call } = recorder();
    expect(await findOpenPr(ado, "5101-x", "dev", { ado: call, run: noRun, cwd: "/", env: {} })).toEqual({ id: 12, url: "https://dev.azure.com/acme/Portal/_git/client-portal/pullrequest/12" });
    expect(calls.at(-1)!.url).toContain("searchCriteria.sourceRefName=refs%2Fheads%2F5101-x");
  });
  it("opens a GitHub pull request through gh, with the description on stdin", async () => {
    const seen: { cmd: string; input: string }[] = [];
    const run: ShellRunner = async (cmd, input) => {
      seen.push({ cmd, input });
      return { code: 0, out: "Creating pull request…\nhttps://github.com/RyansCode-hue/Mockingbird/pull/9" };
    };
    const r = await openPr({ provider: "github", owner: "RyansCode-hue", repo: "Mockingbird" }, { branch: "feat/x", base: "main", title: "Add x", description: "body" }, { ado: async () => ({}), run, cwd: "/", env: {} });
    expect(r).toEqual({ id: 9, url: "https://github.com/RyansCode-hue/Mockingbird/pull/9" });
    expect(seen[0].cmd).toBe("gh pr create --head 'feat/x' --base 'main' --title 'Add x' --body-file -");
    expect(seen[0].input).toBe("body");
  });
  it("reports a failed gh run by what it printed, or by its exit code when it printed nothing", async () => {
    const quiet: ShellRunner = async () => ({ code: 4, out: "" });
    const gh = { provider: "github" as const, owner: "me", repo: "app" };
    await expect(findOpenPr(gh, "b", "main", { ado: async () => ({}), run: quiet, cwd: "/", env: {} })).rejects.toThrow("gh: exited with code 4");
    const loud: ShellRunner = async () => ({ code: 1, out: "  To get started with GitHub CLI, please run:  gh auth login\n" });
    await expect(findOpenPr(gh, "b", "main", { ado: async () => ({}), run: loud, cwd: "/", env: {} })).rejects.toThrow(/^gh: To get started/);
  });
  it("says which PAT scope is missing when ADO refuses", () => {
    expect(prError(new Error("Azure DevOps 401 Unauthorized: x"))).toMatch(/Code \(Read & Write\)/);
    expect(prError(new Error("Azure DevOps 404 Not Found: x"))).toBe("Azure DevOps 404 Not Found: x");
  });
});

describe("pull request preflight", () => {
  /** A clone whose origin has main and dev, on a ticket branch with one commit and a dirty file. */
  const setup = () => {
    const upstream = makeRepo({ "a.txt": "a\n" }, "upstream");
    git(upstream, "branch", "dev");
    const clone = path.join(tempDir("clone"), "repo");
    git(path.dirname(clone), "clone", "-q", upstream, clone);
    git(clone, "checkout", "-q", "-b", "5101-org-dropdowns", "origin/dev");
    write(clone, { "doc/features/5101-orgDropdowns/5101-Description.md": "# 5101\n", "b.txt": "b\n" });
    git(clone, "add", "-A");
    git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "Add org dropdowns");
    write(clone, { "a.txt": "changed\n" });
    return clone;
  };
  it("reports branch, base, commits, uncommitted files and the ticket docs", async () => {
    const clone = setup();
    const p = await prPreflight(clone, "5101", "dev", { ado: async () => ({}), run: async () => ({ code: 0, out: "" }), env: {} });
    expect(p.branch).toBe("5101-org-dropdowns");
    expect(p.base).toBe("dev");
    expect(p.bases.slice(0, 1)).toEqual(["dev"]);
    expect(p.bases).toContain("main");
    expect(p.commits).toBe(1);
    expect(p.dirtyFiles).toBe(1);
    expect(p.docs).toBe("doc/features/5101-orgDropdowns/5101-Description.md");
    expect(p.remote).toBeNull(); // a local path isn't a PR host
    expect(p.existing).toBeNull();
    expect(p.lookupError).toBeNull();
  });
  it("builds a description prompt from the branch's commits and diff", async () => {
    const clone = setup();
    const prompt = await prDescriptionPrompt(clone, "dev", { id: "5101", title: "Org dropdowns" });
    expect(prompt).toContain('ticket #5101 "Org dropdowns"');
    expect(prompt).toContain("- Add org dropdowns");
    expect(prompt).toContain("b.txt");
    await expect(prDescriptionPrompt(clone, "main", { id: "5101", title: "x" }).then((p) => p.length)).resolves.toBeGreaterThan(0);
  });
  it("takes the Summary section for the ticket comment", () => {
    expect(summaryOf("## Summary\nAdds x.\n\n## Changes\n- y")).toBe("Adds x.");
    expect(summaryOf("No sections here")).toBe("No sections here");
  });
});

describe("a pull request's base", () => {
  const bases = ["dev", "main", "release/2.0"];
  it("is the target's own branch, or another branch on origin", () => {
    expect(prBaseProblem("dev", "dev", bases)).toBeNull();
    expect(prBaseProblem("main", "main", bases)).toBeNull();
    expect(prBaseProblem("dev", "release/2.0", bases)).toBeNull();
  });
  it("is never the other target's branch", () => {
    expect(prBaseProblem("main", "dev", bases)).toMatch(/dev is a dev\/UAT branch, and this pull request is to main/);
    expect(prBaseProblem("dev", "main", bases)).toMatch(/main is a main branch/);
    expect(prBaseProblem("main", "develop", ["develop", "main"])).toMatch(/develop is a dev\/UAT branch/);
  });
  it("must be on origin", () => {
    expect(prBaseProblem("dev", "gone", bases)).toMatch(/origin has no branch gone/);
  });
});
