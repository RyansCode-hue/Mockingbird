import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { CollabRooms, buildPrompt, parseStance, type TurnRunner } from "../src/main/collab";
import type { CollabRoom } from "../src/shared/types";

/** A runner whose replies come from a script: reply(modelKey, turnNumberForThatModel, prompt). */
function rooms(reply: (key: string, n: number, prompt: string) => string | Error = (k) => `${k} thoughts\nSTANCE: CONTINUE — more to do`) {
  const counts: Record<string, number> = {};
  const prompts: { key: string; prompt: string }[] = [];
  const runTurn: TurnRunner = async (p, prompt, ctx) => {
    counts[p.key] = (counts[p.key] ?? 0) + 1;
    prompts.push({ key: p.key, prompt });
    if (ctx.signal.aborted) throw new Error("stopped");
    const r = reply(p.key, counts[p.key], prompt);
    if (r instanceof Error) throw r;
    return { text: r, conversationId: `${p.key}-conv` };
  };
  const startSession = vi.fn((req: any) => ({ id: "sess1", ...req }) as any);
  const dir = fs.mkdtempSync(path.join(os.homedir(), "collab-"));
  const c = new CollabRooms(dir, runTurn, () => {}, startSession, () => "dev");
  const make = (over: object = {}) => c.create({ title: "Export feature", brief: "Design CSV export", repoPath: null, models: ["gpt6", "opus", "fable"], ...over });
  return { c, make, prompts, startSession, dir };
}
const said = (room: CollabRoom) => room.messages.filter((m) => m.speaker !== "you" && m.speaker !== "system").map((m) => `${m.round}:${m.speaker}`);

describe("parseStance", () => {
  it("splits off the closing stance line", () => {
    expect(parseStance("Use streaming.\n\nSTANCE: AGREE")).toEqual({ text: "Use streaming.", stance: "agree" });
    expect(parseStance("Not yet.\nSTANCE: CONTINUE — auth is unclear")).toEqual({ text: "Not yet.", stance: "continue" });
    expect(parseStance("No stance line")).toEqual({ text: "No stance line" });
  });
});

describe("rooms", () => {
  it("needs a brief and at least two models", () => {
    const { c } = rooms();
    expect(() => c.create({ title: "", brief: " ", repoPath: null, models: ["gpt6", "opus"] })).toThrow(/Describe/);
    expect(() => c.create({ title: "", brief: "x", repoPath: null, models: ["gpt6"] })).toThrow(/two models/);
  });
  it("goes round-robin; step mode runs one round", async () => {
    const { c, make } = rooms();
    const room = make({ mode: "step" });
    await c.run(room.id);
    expect(said(room)).toEqual(["1:gpt6", "1:opus", "1:fable"]);
    expect(room.round).toBe(1);
    expect(room.running).toBe(false);
  });
  it("auto mode runs its number of rounds, then pauses", async () => {
    const { c, make } = rooms();
    const room = make({ mode: "auto" });
    c.setMode(room.id, "auto", 2);
    await c.run(room.id);
    expect(said(room)).toHaveLength(6);
    expect(room.round).toBe(2);
  });
  it("until-agreed stops once every model agrees in the same round", async () => {
    const { c, make } = rooms((k, n) => (n >= 2 ? `ok\nSTANCE: AGREE` : `hmm\nSTANCE: CONTINUE — x`));
    const room = make({ mode: "consensus" });
    await c.run(room.id);
    expect(room.round).toBe(2);
    expect(room.messages.at(-1)!.text).toMatch(/All 3 models agree/);
  });
  it("until-agreed gives up at its cap and says so", async () => {
    const { c, make } = rooms();
    const room = make({ mode: "consensus" });
    c.setMode(room.id, "consensus", 2);
    await c.run(room.id);
    expect(room.round).toBe(2);
    expect(room.messages.at(-1)!.text).toMatch(/No agreement after 2 rounds/);
  });
  it("records a model's failure and lets the others carry on", async () => {
    const { c, make } = rooms((k) => (k === "opus" ? new Error("rate limited") : `${k} says\nSTANCE: CONTINUE — x`));
    const room = make({ mode: "step" });
    await c.run(room.id);
    expect(room.messages.find((m) => m.kind === "error")!.text).toMatch(/Claude Opus 5.5 couldn't take its turn: rate limited/);
    expect(said(room)).toEqual(["1:gpt6", "1:opus", "1:fable"]);
  });
  it("stops when every model fails a round instead of looping", async () => {
    const { c, make } = rooms(() => new Error("offline"));
    const room = make({ mode: "auto" });
    await c.run(room.id);
    expect(room.round).toBe(1);
    expect(room.messages.at(-1)!.text).toMatch(/Every model failed/);
  });
  it("stops mid-round when asked", async () => {
    let c!: CollabRooms;
    let id = "";
    const r = rooms((k) => {
      if (k === "opus") c.stop(id);
      return `${k}\nSTANCE: CONTINUE — x`;
    });
    c = r.c;
    const room = r.make({ mode: "auto" });
    id = room.id;
    await c.run(id);
    expect(said(room)).toEqual(["1:gpt6"]); // opus's reply arrived after Stop and was dropped; fable never ran
    expect(room.messages.at(-1)!.text).toBe("Stopped.");
  });
  it("survives a restart: rooms reload from disk, not running", async () => {
    const { c, make, dir } = rooms();
    const room = make({ mode: "step" });
    await c.run(room.id);
    const again = new CollabRooms(dir, async () => ({ text: "", conversationId: "" }), () => {}, vi.fn(), () => null);
    expect(again.get(room.id)).toMatchObject({ title: "Export feature", round: 1, running: false });
  });
});

describe("what each model is told", () => {
  it("first turn: the brief, the rules and what came before; later turns: only what's new", async () => {
    const { c, make, prompts } = rooms();
    const room = make({ mode: "step" });
    await c.run(room.id);
    const opusFirst = prompts.find((p) => p.key === "opus")!.prompt;
    expect(opusFirst).toMatch(/You are Claude Opus 5.5, one of 3 AI models/);
    expect(opusFirst).toMatch(/The topic:\nDesign CSV export/);
    expect(opusFirst).toMatch(/\[GPT-6 Astra\] \(stance: continue\)\ngpt6 thoughts/);
    expect(opusFirst).toMatch(/STANCE: AGREE/);
    c.send(room.id, "Keep it under 50 lines please");
    await vi.waitFor(() => expect(room.round).toBe(2));
    const gptSecond = prompts.filter((p) => p.key === "gpt6")[1].prompt;
    expect(gptSecond).toMatch(/^New since your last turn:/);
    expect(gptSecond).toMatch(/\[Claude Opus 5.5\]/);
    expect(gptSecond).toMatch(/\[User\]\nKeep it under 50 lines please/);
    expect(gptSecond).not.toMatch(/gpt6 thoughts/); // its own words aren't repeated back
    expect(gptSecond).not.toMatch(/The topic:/);
  });
  it("mentions the repo only when the room has one", () => {
    const { make } = rooms();
    const withRepo = make({ repoPath: "/code/app" });
    expect(buildPrompt(withRepo, withRepo.participants[0])).toMatch(/You are in the repository at \/code\/app.*Don't edit files/s);
  });
});

describe("plans and implementation", () => {
  it("approving a model's proposal makes it the plan; the user's own messages can't be approved", async () => {
    const { c, make } = rooms();
    const room = make({ mode: "step" });
    await c.run(room.id);
    const proposal = room.messages.find((m) => m.speaker === "fable")!;
    expect(() => c.approve(room.id, room.messages[0].id)).toThrow(/Only a model's proposal/);
    c.approve(room.id, proposal.id);
    expect(room.plan).toMatchObject({ text: "fable thoughts", by: "fable", approved: true });
  });
  it("a write-up is a plan awaiting approval, with no stance stripped from it", async () => {
    const { c, make, prompts } = rooms((k, n, prompt) => (/write up the plan/.test(prompt) ? "# Plan\n1. Do it" : `${k}\nSTANCE: CONTINUE — x`));
    const room = make({ mode: "step" });
    await c.run(room.id);
    await c.synthesize(room.id, "opus");
    expect(room.plan).toMatchObject({ text: "# Plan\n1. Do it", by: "opus", approved: false });
    expect(room.messages.at(-1)!.kind).toBe("plan");
    expect(prompts.at(-1)!.prompt).toMatch(/don't add a STANCE line/);
  });
  it("implementing needs an approved plan and a repo, then starts a session on a new branch", async () => {
    const { c, make, startSession } = rooms();
    const noRepo = make({ mode: "step" });
    await c.run(noRepo.id);
    expect(() => c.implement(noRepo.id, "gpt6")).toThrow(/Approve a plan first/);
    c.approve(noRepo.id, noRepo.messages.find((m) => m.speaker === "gpt6")!.id);
    expect(() => c.implement(noRepo.id, "gpt6")).toThrow(/no repository/);

    const room = make({ mode: "step", repoPath: "/code/app", title: "CSV Export: v2!" });
    await c.run(room.id);
    c.approve(room.id, room.messages.find((m) => m.speaker === "opus")!.id);
    c.implement(room.id, "gpt6");
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: "/code/app", useWorktree: true, branchName: "collab-csv-export-v2", baseBranch: "dev", agent: "codex", model: "gpt-6-astra", taskGroup: "Collaborate" })
    );
    expect(startSession.mock.calls.at(-1)![0].initialPrompt).toMatch(/approved by the user\.\n\nopus thoughts$/);
    expect(room.implementedIn).toBe("sess1");
  });
});
