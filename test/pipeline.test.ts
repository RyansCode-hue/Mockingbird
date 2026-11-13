import { execFile, execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineStore, stageComment } from "../src/main/pipeline";
import { parseRemote } from "../src/main/git";
import { clearGitPins } from "../src/main/gitPins";
import { prStatusFor } from "../src/main/prStatus";
import { findOpenPr, prBaseProblem, prCreateRefusal, openPr, pickBase, prDescriptionPrompt, prError, prPreflight, summaryOf, type AdoCall } from "../src/main/pullRequests";
import type { ShellRunner } from "../src/main/headless";
import { BY_YOU, GATES, prBranchProblem, roomPushLine, unrecordedBranch, stageLabel, stageStep, tickOf, TICKET_STAGES, type PipelinePr, type TicketPipeline, type TicketStage } from "../src/shared/types";
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
  it("moves a ticket as a session opened on it does, an Orchestrator's to BA, saying which move failed and why", () => {
    const f = storeFile();
    const s = new PipelineStore(f);
    expect(s.sessionOpened("1", { orchestrator: false, title: "t", by: BY_YOU })!.stage).toBe("coding");
    expect(s.sessionOpened("2", { orchestrator: true, title: "", by: BY_YOU })).toMatchObject({ stage: "ba", title: undefined });
    expect(s.sessionOpened("2", { orchestrator: true })).toBeNull();
    fs.chmodSync(path.dirname(f), 0o500); // the save's temporary file can't be made
    try {
      expect(() => s.sessionOpened("3", { orchestrator: false })).toThrow(/^#3 couldn't be moved to Coding \(.*EACCES/);
      expect(() => s.sessionOpened("4", { orchestrator: true })).toThrow(/^#4 couldn't be tracked at BA \(.*EACCES/);
    } finally {
      fs.chmodSync(path.dirname(f), 0o700);
    }
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
    // so has one that only reached Coding, then went back to BA
    s.startCoding("9");
    s.setStage("9", "ba");
    expect(s.setStage("9", "coding").drafts.at(-1)!.text).toBe("Back in development.");
    // BA isn't development
    s.setStage("10", "ba");
    expect(s.setStage("10", "coding").drafts.at(-1)!.text).toBe("Development has started.");
  });
  it("drafts nothing at BA, AI testing in dev/UAT or Patch notes", () => {
    const s = new PipelineStore(storeFile());
    for (const stage of ["ba", "dev-test", "comms"] as const) s.setStage("11", stage);
    expect(s.get("11")!.drafts).toEqual([]);
  });
  it("drafts nothing for a PR stage reached with no PR, and the link when a PR opens", () => {
    expect([stageComment("pr-dev", {}), stageComment("pr-main", { summary: "x" })]).toEqual([null, null]);
    const s = new PipelineStore(storeFile());
    s.setStage("12", "pr-dev", { by: BY_YOU });
    s.setStage("12", "pr-main", { by: BY_YOU });
    expect(s.get("12")!.drafts).toEqual([]);
    expect(s.addPr("12", prTo("main", 13)).drafts.map((d) => d.text)).toEqual(["Pull request to main opened:\n\nhttps://dev.azure.com/o/p/_git/r/pullrequest/13\n5101-x → main\n\nPR 13's summary."]);
  });
});

describe("going back to Coding", () => {
  const DEV = GATES[0].items.map((it) => `dev:${it.key}`);
  const ALL = GATES.flatMap((g) => g.items.map((it) => `${g.id}:${it.key}`));
  /** A ticket at `stage` with `keys` ticked by `by`, and a newer build's gate ticked too. */
  const ticked = (s: PipelineStore, id: string, stage: TicketStage, keys: string[], by = "Coder") => {
    s.startCoding(id);
    for (const k of [...keys, "uat:sign"]) s.setCheck(id, k, true, by);
    s.setStage(id, stage);
  };

  it("clears the gates' ticks and who made them on feedback, saying so in the move's note", () => {
    for (const from of ["stakeholder", "approved", "pr-main"] as const) {
      const s = new PipelineStore(storeFile());
      ticked(s, "1", from, [...DEV, "staging:peer-review"]);
      const p = s.addFeedback("1", "The dropdown forgets the org", BY_YOU);
      expect(p.stage).toBe("coding");
      expect(p.checks).toEqual({ "uat:sign": true });
      expect(Object.keys(p.checkedBy!)).toEqual(["uat:sign"]);
      expect(p.history.at(-1)).toEqual({
        at: expect.any(Number),
        stage: "coding",
        by: "you",
        note: "The dropdown forgets the org\n\nGate ticks cleared: Before the PR to dev/UAT (6), Before the PR to main (1)",
      });
      // the drafted comment quotes the feedback alone
      expect(p.drafts.at(-1)!.text).toBe("Stakeholder feedback received; back in development to address it:\n\nThe dropdown forgets the org");
      // back at Local testing, the dev gate starts over
      expect(s.setStage("1", "local-test").checks).toEqual({ "uat:sign": true });
    }
  });
  it("clears them on a move back to Coding on the rail, and every gate's on Reopen from Done", () => {
    const s = new PipelineStore(storeFile());
    ticked(s, "2", "local-test", DEV.slice(0, 2));
    expect(s.setStage("2", "coding", { by: BY_YOU }).history.at(-1)!.note).toBe("Gate ticks cleared: Before the PR to dev/UAT (2)");
    expect(s.get("2")!.checks).toEqual({ "uat:sign": true });
    ticked(s, "3", "done", ALL);
    const p = s.setStage("3", "coding", { by: BY_YOU });
    expect(p.checks).toEqual({ "uat:sign": true });
    expect(p.history.at(-1)!.note).toBe("Gate ticks cleared: Before the PR to dev/UAT (6), Before the PR to main (4), Before production (3)");
  });
  it("keeps the ticks on a move forward to Coding, a move back elsewhere, and says nothing with none to clear", () => {
    const s = new PipelineStore(storeFile());
    s.setCheck("4", "dev:tests", true, BY_YOU);
    expect(s.startCoding("4")!.checks).toEqual({ "dev:tests": true });
    s.setStage("4", "approved");
    s.setCheck("4", "staging:secrets", true, BY_YOU);
    expect(s.setStage("4", "stakeholder").checks).toEqual({ "dev:tests": true, "staging:secrets": true });
    s.setStage("5", "done");
    expect("note" in s.setStage("5", "coding").history.at(-1)!).toBe(false);
  });
  it("leaves a file 1.6.0 reads: checks hold only true", () => {
    const f = storeFile();
    const s = new PipelineStore(f);
    ticked(s, "6", "stakeholder", DEV);
    s.addFeedback("6", "Again");
    const old = new PipelineStore160(f).get("6")!;
    expect(old.checks).toEqual({ "uat:sign": true });
    expect(old.stage).toBe("coding");
  });
});

describe("a record that isn't whole", () => {
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});
  const base = { ticketId: "1", title: "Kept", stage: "coding", history: [{ at: 1, stage: "coding" }], prs: [], feedback: [], drafts: [], checks: { "dev:tests": true } };

  it("starts a missing list or checks empty on reading, says so, and keeps every other field", () => {
    for (const missing of ["history", "prs", "feedback", "drafts", "checks"] as const) {
      const f = storeFile();
      const rec: Record<string, unknown> = { ...base };
      delete rec[missing];
      fs.writeFileSync(f, JSON.stringify({ "1": rec }));
      const errors = quiet();
      try {
        const s = new PipelineStore(f);
        expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([`[mockingbird] pipeline.json: #1 had no ${missing}; started empty.`]);
        expect(tickOf(s.get("1")!, "dev:tests")).toBeNull();
        s.setStage("1", "local-test", { by: BY_YOU });
        s.setCheck("1", "dev:smoke", true, BY_YOU);
        s.addDraft("1", "comms", "Notes");
        s.addFeedback("1", "More", BY_YOU);
        s.addPr("1", prTo("dev", 2));
        const after = readFile(f)["1"];
        expect(after.title).toBe("Kept");
        expect(after.stage).toBe("pr-dev");
        for (const k of ["history", "prs", "feedback", "drafts"] as const) expect(Array.isArray(after[k])).toBe(true);
        if (missing !== "history") expect(after.history[0]).toEqual({ at: 1, stage: "coding" });
      } finally {
        errors.mockRestore();
      }
    }
  });
  it("reads no tick's author from a record with no checks", () => {
    expect(tickOf({ ticketId: "1", stage: "coding" } as unknown as TicketPipeline, "dev:tests")).toBeNull();
  });
  it("refuses a change to a record holding something else in a list, leaving it as it was, in memory and on disk", () => {
    const f = storeFile();
    const odd = { ...base, drafts: "not a list" };
    fs.writeFileSync(f, JSON.stringify({ "1": odd }));
    const s = new PipelineStore(f);
    expect(() => s.setStage("1", "local-test", { title: "Changed" })).toThrow("#1's record in pipeline.json can't be changed: its drafts isn't a list");
    expect(() => s.addFeedback("1", "x")).toThrow(/its drafts isn't a list/);
    expect(() => s.findDraft("1", "d")).toThrow(/its drafts isn't a list/);
    expect(s.get("1")).toEqual(odd);
    s.setStage("2", "coding");
    expect(readFile(f)["1"]).toEqual(odd);
  });
  it("refuses a tick on a record whose checkedBy isn't a map, ticking nothing", () => {
    const f = storeFile();
    fs.writeFileSync(f, JSON.stringify({ "1": { ...base, checkedBy: "x" } }));
    const s = new PipelineStore(f);
    expect(() => s.setCheck("1", "dev:smoke", true, BY_YOU)).toThrow(/its checkedBy isn't a map/);
    expect(s.get("1")!.checks).toEqual({ "dev:tests": true });
  });
  it("puts a record back when its save fails, so another ticket's save doesn't write the change", () => {
    const f = storeFile();
    const s = new PipelineStore(f);
    s.setStage("1", "coding", { title: "Before" });
    const saved = readFile(f)["1"];
    fs.chmodSync(path.dirname(f), 0o500); // the save's temporary file can't be made
    try {
      expect(() => s.setStage("1", "local-test", { title: "After" })).toThrow();
      expect(() => s.setStage("3", "coding")).toThrow();
    } finally {
      fs.chmodSync(path.dirname(f), 0o700);
    }
    expect(s.get("1")).toEqual(saved);
    expect(s.get("3")).toBeNull();
    s.setStage("2", "coding");
    expect(readFile(f)["1"]).toEqual(saved);
    expect(readFile(f)["3"]).toBeUndefined();
  });
});

describe("the window's moves and ticks", () => {
  // main's index.ts can't be imported here (Electron), so its calls are read: each pipeline call that moves a ticket
  // or ticks a gate from the window says it's Ryan's
  it("pass BY_YOU on every pipeline call in index.ts that records who", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/main/index.ts"), "utf8");
    const calls: string[] = [];
    for (const m of src.matchAll(/\bpipeline\.(setStage|startCoding|track|sessionOpened|addFeedback|addPr|setCheck)\(/g)) {
      let depth = 0;
      let i = m.index! + m[0].length - 1;
      for (; i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")" && --depth === 0) break;
      }
      calls.push(src.slice(m.index!, i + 1));
    }
    expect(calls.map((c) => c.match(/^pipeline\.(\w+)/)![1]).sort()).toEqual(["addFeedback", "addPr", "sessionOpened", "setCheck", "setStage"]);
    for (const c of calls) expect(c, c).toMatch(/\bBY_YOU\b/);
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
    approved: { label: "Approved", step: 6, sub: "approved", next: ["Record feedback…", "Create PR to main…"] },
    "pr-main": { label: "PR to main", step: 6, sub: "PR to main open", next: ["Record feedback…", "Merged — AI testing in staging/prod"] },
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
    // the untick is remembered, so no agent ticks it again at this stage (W14)
    expect(readFile(f)["7001"]).toEqual({ ...newer["7001"], unticked: { "dev:tests": { at: expect.any(Number), stage: "uat-signoff" } } });
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
    expect(seen[0].cmd).toBe("gh pr create --head 'feat/x' --base 'main' --title 'Add x' --body-file - --repo 'RyansCode-hue/Mockingbird'");
    expect(seen[0].input).toBe("body");
  });
  it("reports a failed gh run by what it printed, or by its exit code when it printed nothing", async () => {
    const quiet: ShellRunner = async () => ({ code: 4, out: "" });
    const gh = { provider: "github" as const, owner: "me", repo: "app" };
    await expect(findOpenPr(gh, "b", "main", { ado: async () => ({}), run: quiet, cwd: "/", env: {} })).rejects.toThrow("gh: exited with code 4");
    const loud: ShellRunner = async () => ({ code: 1, out: "  To get started with GitHub CLI, please run:  gh auth login\n" });
    await expect(findOpenPr(gh, "b", "main", { ado: async () => ({}), run: loud, cwd: "/", env: {} })).rejects.toThrow(/^gh: To get started/);
  });
  describe("gh, which runs git in its own folder", () => {
    const gh = { provider: "github" as const, owner: "me", repo: "app" };
    afterEach(() => clearGitPins());
    /** A runner that records what it's asked to run, where, and with what environment. */
    const recording = () => {
      const seen: { cmd: string; cwd: string; env: Record<string, string> }[] = [];
      const run: ShellRunner = async (cmd, _input, o) => {
        seen.push({ cmd, cwd: o.cwd, env: { ...o.env } });
        if (cmd.startsWith("gh pr view")) return { code: 1, out: 'no pull requests found for branch "main"' };
        return { code: 0, out: cmd.startsWith("gh pr create") ? "https://github.com/me/app/pull/3" : "[]" };
      };
      return { seen, run };
    };
    /** sh, not the user's login shell, so the stand-in gh in the trap's bin folder is the one PATH finds. */
    const sh: ShellRunner = (cmd, input, o) =>
      new Promise((resolve) => {
        const child = execFile("/bin/sh", ["-c", cmd], { cwd: o.cwd, env: o.env, timeout: o.timeoutMs }, (err, stdout, stderr) =>
          resolve({ code: err ? (typeof (err as NodeJS.ErrnoException).code === "number" ? Number((err as NodeJS.ErrnoException).code) : 1) : 0, out: `${stdout}${stderr}` })
        );
        child.stdin?.on("error", () => {});
        child.stdin?.end(input);
      });
    /**
     * A repository whose working tree holds what a room session's agent can write there: a nested repository whose own
     * config names a core.fsmonitor program, added to the index as a gitlink (status goes into it), and a pre-push hook
     * in the tracked hooks folder its config names. `ran` is written when anything of the agent's runs. Its stand-in gh
     * runs the gits gh runs in its folder: its remotes, pr create's count of uncommitted changes, and a push.
     */
    const trapped = () => {
      const box = tempDir("gh-trap");
      const ran = path.join(box, "ran");
      const evil = path.join(box, "evil.sh");
      fs.writeFileSync(evil, `#!/bin/sh\necho "$0 $* in $(pwd)" >> "${ran}"\nexit 1\n`, { mode: 0o755 });
      const origin = path.join(box, "origin.git");
      git(box, "init", "-q", "--bare", origin);
      const repo = makeRepo({ "a.txt": "a\n" }, "app", box);
      git(repo, "remote", "add", "origin", origin);
      git(repo, "config", "core.hooksPath", ".husky");
      const sub = makeRepo({ "s.txt": "s\n" }, "sub", repo);
      git(sub, "config", "core.fsmonitor", evil);
      git(repo, "add", "sub");
      write(repo, { ".husky/pre-push": `#!/bin/sh\n"${evil}" pre-push\n` });
      fs.chmodSync(path.join(repo, ".husky", "pre-push"), 0o755);
      const bin = tempDir("gh-bin");
      fs.writeFileSync(
        path.join(bin, "gh"),
        `#!/bin/sh\necho "$PWD $*" >> "${path.join(box, "gh-calls")}"\ngit remote -v >/dev/null 2>&1\ngit status --porcelain >/dev/null 2>&1\ngit push -q origin HEAD >/dev/null 2>&1\ncase "$2" in create) echo https://github.com/me/app/pull/3 ;; *) echo '[]' ;; esac\n`,
        { mode: 0o755 }
      );
      const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: os.homedir(), GIT_CONFIG_NOSYSTEM: "1" };
      return { repo, ran, env, calls: () => fs.readFileSync(path.join(box, "gh-calls"), "utf8").trim().split("\n") };
    };
    const ghFolderPath = () => path.join(os.homedir(), ".mockingbird", "gh");

    it("runs nothing of a repository's agent-written tree: it's run in Mockingbird's empty folder, told the repository", async () => {
      const t = trapped();
      // the trap holds: gh run in the repository's folder runs the nested repository's fsmonitor and the tracked hook
      await sh("gh pr create", "", { cwd: t.repo, env: t.env, timeoutMs: 30_000 });
      expect(fs.readFileSync(t.ran, "utf8")).toMatch(/evil\.sh .* in .*\/sub\n[\s\S]*evil\.sh pre-push/);
      fs.rmSync(t.ran);
      const deps = { ado: async () => ({}), run: sh, cwd: t.repo, env: t.env, room: true };
      expect(await findOpenPr(gh, "main", "dev", deps)).toBeNull();
      expect(await openPr(gh, { branch: "5101-x", base: "main", title: "t", description: "d" }, deps)).toEqual({ id: 3, url: "https://github.com/me/app/pull/3" });
      expect(fs.existsSync(t.ran)).toBe(false);
      const folder = fs.realpathSync(ghFolderPath());
      expect(t.calls().slice(1)).toEqual([
        `${folder} pr list --head main --base dev --state open --json number,url --limit 1 --repo me/app`,
        `${folder} pr create --head 5101-x --base main --title t --body-file - --repo me/app`,
      ]);
      expect(fs.readdirSync(folder)).toEqual([]);
    });

    it("finds no repository above its folder, and isn't run while its folder holds anything", async () => {
      const r = recording();
      const deps = { ado: async () => ({}), run: r.run, cwd: makeRepo(), env: { PATH: "/usr/bin:/bin" } };
      await findOpenPr(gh, "b", "main", deps);
      const folder = ghFolderPath();
      expect(r.seen[0]).toMatchObject({ cwd: folder, env: { PATH: "/usr/bin:/bin", GIT_CEILING_DIRECTORIES: path.dirname(folder) } });
      // a repository holding the folder isn't found from it
      const above = path.dirname(folder);
      execFileSync("git", ["init", "-q", above]);
      try {
        expect(() => execFileSync("git", ["rev-parse", "--git-dir"], { cwd: folder, env: { ...process.env, ...r.seen[0].env }, stdio: ["ignore", "pipe", "pipe"] })).toThrow(/not a git repository/);
        // the control: without the ceiling, git finds it
        expect(execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: folder, encoding: "utf8" }).trim()).toBe(fs.realpathSync(path.join(above, ".git")));
      } finally {
        fs.rmSync(path.join(above, ".git"), { recursive: true, force: true });
      }
      fs.mkdirSync(path.join(folder, ".git"));
      try {
        await expect(findOpenPr(gh, "b", "main", deps)).rejects.toThrow(/^gh wasn't run: .*\.mockingbird\/gh, the empty folder Mockingbird runs it in, holds \.git\. Remove what's there\.$/);
        expect(r.seen).toHaveLength(1);
      } finally {
        fs.rmSync(path.join(folder, ".git"), { recursive: true, force: true });
      }
    });

    it("is told the origin as guarded git reads it, refused where git is", async () => {
      const repo = makeRepo();
      git(repo, "remote", "add", "origin", "git@github.com:me/app.git");
      const r = recording();
      const deps = { ado: async () => ({}), run: r.run, env: {} };
      expect((await prStatusFor(repo, deps)).pr).toBeNull();
      expect(r.seen.map((s) => s.cmd)).toEqual([expect.stringMatching(/^gh pr view 'main' --json \S+ --repo 'me\/app'$/)]);
      // a stray commondir would lead git to another folder's config: nothing is read, and gh isn't run
      fs.writeFileSync(path.join(repo, ".git", "commondir"), `${tempDir("elsewhere")}\n`);
      await expect(prStatusFor(repo, deps)).rejects.toThrow(/Mockingbird won't run git in .*: its \.git holds a commondir/);
      await expect(prPreflight(repo, "5101", "main", deps)).rejects.toThrow(/Mockingbird won't run git in /);
      expect(r.seen).toHaveLength(1);
    });

    it("is refused for a room session's folder whose config comes from a file its agent can write, as its origin is read from that config", async () => {
      const repo = makeRepo();
      git(repo, "config", "include.path", "../team.gitconfig");
      const r = recording();
      const room = { ado: async () => ({}), run: r.run, cwd: repo, env: { PATH: "/usr/bin" }, room: true };
      await expect(openPr(gh, { branch: "b", base: "main", title: "t", description: "d" }, room)).rejects.toThrow(
        /^gh wasn't run: Mockingbird runs none of a team room session's git with this repository's config: \.git\/config includes team\.gitconfig, a file in /
      );
      expect(r.seen).toEqual([]);
      // a local session's gh runs
      expect(await findOpenPr(gh, "b", "main", { ...room, room: false })).toBeNull();
      git(repo, "config", "--unset", "include.path");
      expect(await openPr(gh, { branch: "b", base: "main", title: "t", description: "d" }, room)).toEqual({ id: 3, url: "https://github.com/me/app/pull/3" });
      expect(r.seen.map((s) => s.env.PATH)).toEqual(["/usr/bin", "/usr/bin"]);
    });
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
    expect(p.branchProblem).toBeNull();
    // a local session's push runs the repository's hooks as git would: nothing to say about them
    expect(p.roomPush).toBeUndefined();
  });
  it("says when the worktree is on a base branch's name, and, for a room session, what its push runs and doesn't", async () => {
    const clone = setup();
    git(clone, "checkout", "-q", "-B", "dev");
    write(clone, { ".husky/_/pre-push": "#!/bin/sh\nexit 0\n" });
    git(clone, "config", "core.hooksPath", ".husky/_");
    const deps = { ado: async () => ({}), run: async () => ({ code: 0, out: "" }), env: {} };
    const p = await prPreflight(clone, "5101", "dev", deps, { own: true });
    expect(p.branchProblem).toBe("The worktree is on dev, a base branch's name: pushing it would update origin's dev directly. Move the work to a branch of its own first.");
    expect(p.roomPush).toEqual({ runs: null, skipped: { value: ".husky/_", why: "hooks in the working tree can be changed by the session" }, lfs: "none" });
    // with the user's own global pre-push, that runs, and Husky's is still set aside
    const userHooks = tempDir("user-hooks");
    write(userHooks, { "pre-push": "#!/bin/sh\nexit 0\n" });
    const global = path.join(tempDir("global"), "gitconfig");
    fs.writeFileSync(global, `[core]\n\thooksPath = ${userHooks}\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", global);
    try {
      const q = await prPreflight(clone, "5101", "dev", deps, { own: true });
      const runs = `~/${path.basename(userHooks)}`;
      expect(q.roomPush).toEqual({ runs, skipped: { value: ".husky/_", why: "hooks in the working tree can be changed by the session" }, lfs: "none" });
      expect(roomPushLine(q.roomPush!)).toBe(`Your global pre-push in ${runs} runs; the one in .husky/_ doesn't, for a room session's push: hooks in the working tree can be changed by the session.`);
      git(clone, "config", "--unset", "core.hooksPath");
      const r = await prPreflight(clone, "5101", "dev", deps, { own: true });
      expect(roomPushLine(r.roomPush!)).toBe(`Your global pre-push in ${runs} runs for a room session's push; this repository's hooks don't.`);
    } finally {
      vi.unstubAllEnvs();
    }
    // with none of the user's, the repository's .git/hooks is set aside: a hook manager there runs files the agent writes
    write(clone, { ".git/hooks/pre-push": "#!/bin/sh\nexit 0\n" });
    const n = await prPreflight(clone, "5101", "dev", deps, { own: true });
    expect(n.roomPush).toEqual({ runs: null, skipped: { value: ".git/hooks", why: "this repository's hooks can run files its agent writes (a hook manager's config, its scripts)" }, lfs: "none" });
    expect(roomPushLine(n.roomPush!)).toBe("No pre-push runs for a room session's push: the one in .git/hooks doesn't, as this repository's hooks can run files its agent writes (a hook manager's config, its scripts).");
    expect(roomPushLine({ runs: null, skipped: null, lfs: "none" })).toBeNull();
    expect(roomPushLine({ runs: null, skipped: null, lfs: "push" })).toBe("Its Git LFS files are uploaded first, with git lfs push.");
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

describe("a pull request's branch", () => {
  it("is never the base, nor any base branch's name, in any case: the push would land on it directly", () => {
    for (const [branch, base] of [["dev", "dev"], ["main", "dev"], ["Develop", "dev"], ["UAT", "main"], ["master", "main"], ["release/2.0", "release/2.0"]]) {
      expect(prBranchProblem(branch, base), `${branch} → ${base}`).toMatch(new RegExp(`^The worktree is on ${branch.replace("/", "\\/")}, a base branch's name`));
    }
  });
  it("is any other branch, one named like a base's included", () => {
    for (const branch of ["5101-orgDropdowns", "feature/main", "dev-fix", "mainline"]) expect(prBranchProblem(branch, "dev"), branch).toBeNull();
  });
  it("is refused by main before anything is pushed, whatever base the form sent", () => {
    const pre = { branch: "main", base: "dev", bases: ["dev", "main"], dirtyFiles: 0, commits: 2, remote: null, docs: null, existing: null };
    const made = { recorded: "5101-orgDropdowns" };
    expect(prCreateRefusal(pre, "dev", "dev", made)).toBe("Nothing was pushed: The worktree is on main, a base branch's name: pushing it would update origin's main directly. Move the work to a branch of its own first.");
    expect(prCreateRefusal({ ...pre, branch: "Dev" }, "dev", "dev", made)).toMatch(/^Nothing was pushed: The worktree is on Dev/);
    expect(prCreateRefusal({ ...pre, branch: "5101-orgDropdowns" }, "dev", "dev", made)).toBeNull();
    // and the handler asks it before its push
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main", "index.ts"), "utf8");
    const create = main.slice(main.indexOf('"pipeline:pr:create",'), main.indexOf("// ---- continue in the other agent"));
    expect(create.indexOf("prCreateRefusal(")).toBeGreaterThan(0);
    expect(create.indexOf("prCreateRefusal(")).toBeLessThan(create.indexOf("scmPush("));
  });
  it("is the branch main made the session on, or one the user said to push: never a staging, release or teammate's branch unasked", () => {
    const pre = { branch: "staging", base: "dev", bases: ["dev", "main"], dirtyFiles: 0, commits: 2, remote: null, docs: null, existing: null };
    for (const branch of ["staging", "release/2.1", "nick/5098-donorExport"]) {
      expect(prCreateRefusal({ ...pre, branch }, "dev", "dev", { recorded: "5101-orgDropdowns" })).toBe(
        `Nothing was pushed: The worktree is on ${branch}, not 5101-orgDropdowns, the branch this session was made on: pushing it updates origin's ${branch}. Tick “Push ${branch} anyway” in the form to push it.`
      );
      // the say-so is for that branch only
      expect(prCreateRefusal({ ...pre, branch }, "dev", "dev", { recorded: "5101-orgDropdowns", confirmed: branch })).toBeNull();
      expect(prCreateRefusal({ ...pre, branch }, "dev", "dev", { recorded: "5101-orgDropdowns", confirmed: "5101-orgDropdowns" })).toMatch(/^Nothing was pushed/);
    }
    expect(unrecordedBranch("5101-x", null)).toBe("The worktree is on 5101-x, and this session has no branch of its own recorded: pushing it updates origin's 5101-x.");
    expect(prCreateRefusal({ ...pre, branch: "5101-x" }, "dev", "dev", { recorded: null })).toMatch(/^Nothing was pushed: The worktree is on 5101-x, and this session has no branch/);
    // main asks with the session's recorded branch and the form's say-so, and the preflight names it for the form
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main", "index.ts"), "utf8");
    expect(main).toMatch(/prCreateRefusal\(\{ \.\.\.pre, branch: pre\.branch \}, target, base, \{ recorded: s\.branch, confirmed: req\?\.confirmBranch \? String\(req\.confirmBranch\) : undefined \}\)/);
    expect(main).toMatch(/return pre\.branch && pre\.branch !== s\.branch \? \{ \.\.\.pre, recordedBranch: s\.branch \} : pre;/);
  });
  it("pushes a room session's branch with only hooks its agent can't have written, a local one's as git would", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main", "index.ts"), "utf8");
    // a room session's, and every session's until rooms have started (none can be told apart before)
    expect(main).toMatch(/const pushesOwnHooks = \(id: string\): boolean => !roomsKnown \|\| livePanes\.roomOfSession\(id\) !== null;/);
    const create = main.slice(main.indexOf('"pipeline:pr:create",'), main.indexOf("// ---- continue in the other agent"));
    expect(create).toMatch(/const own = pushesOwnHooks\(s\.id\);/);
    expect(create).toMatch(/prPreflight\(s\.cwd, String\(ticketId\), target, prDeps\(s\.cwd\), \{ own \}\)/);
    // from the branch its refusals checked
    expect(create).toMatch(/scmPush\(s\.cwd, \{ own, branch: pre\.branch \}\)/);
    // the preflight says what that push would set aside, and Source Control's Push is the same push
    expect(main).toMatch(/prPreflight\(s\.cwd, [^\n]*\{ own: pushesOwnHooks\(s\.id\) \}\)/);
    expect(main).toContain("return { root: s.cwd, own: pushesOwnHooks(s.id), s };");
    expect(main).toContain('return own ? scmRoomPush(root, s.branch, typeof confirmBranch === "string" ? confirmBranch : undefined) : scmPush(root);');
  });

  it("runs Source Control's every write for a room session, and Close session's, with only hooks its agent can't have written", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main", "index.ts"), "utf8");
    for (const [call, run] of [
      ["scm:stage", "scmStage(root, paths, { own })"],
      ["scm:unstage", "scmUnstage(root, paths, { own })"],
      ["scm:discard", "scmDiscard(root, entries, (abs) => shell.trashItem(abs), { own })"],
      ["scm:commit", 'scmCommit(root, String(message ?? ""), { own })'],
      ["scm:pull", "scmPull(root, { own })"],
      ["scm:fetch", "scmFetch(root, { own })"],
    ]) {
      const at = main.indexOf(`handle("${call}"`);
      expect(main.slice(at, main.indexOf("\n});", at)), call).toContain(`const { root, own } = scmIn(id);\n  return ${run};`);
    }
    // the session is looked up by its folder: Close session has closed its pane by then, so it's among the resumable
    // with the branch they were made on, and what the dialog showed and said
    expect(main).toContain("return cleanupWorktree(repo, folder, mode, { ...folderOwnHooks(folder), shown: text(say?.shown), confirmBranch: text(say?.confirmBranch) });");
    expect(main).toContain("const there = [...sessions.list(), ...sessions.resumable()].filter((s) => samePath(s.cwd, folder));");
    expect(main).toContain("const roomRulesIn = (folder: string): boolean => roomRulesFor(folder, [...sessions.list(), ...sessions.resumable()], pushesOwnHooks);");
    expect(main).toContain("return { own: roomRulesIn(folder), recorded: branches.length === 1 ? branches[0] : null };");
    // gh for a folder goes by the same rules: a room session's there, or none found
    expect(main).toMatch(/const prDeps = \(root: string\): PrDeps => \(\{ .*, cwd: root, room: roomRulesIn\(root\) \}\);/);
    // a folder made or checked out for one, by the group it starts in
    expect(main).toContain("sessions.ownHooksFor = (group) => !roomsKnown || !!sessions.roomOfGroup?.(group ?? LOOSE_GROUP);");
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
