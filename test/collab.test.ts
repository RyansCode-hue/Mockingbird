import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import { makeTestCopy } from "../src/main/testCopy";
import { CollabRooms, COLLAB_MODELS, buildPrompt, parseStance, claudeTurnCommand, codexTurnCommand, type TurnRunner } from "../src/main/collab";
import type { CollabParticipantSpec } from "../src/shared/types";
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
  const make = (over: object = {}) => c.create({ title: "Export feature", brief: "Design CSV export", repoPath: null, participants: specs("gpt6", "opus", "fable"), ...over });
  return { c, make, prompts, startSession, dir };
}
/** Preset seats by key, all reading code. */
const specs = (...keys: string[]): CollabParticipantSpec[] =>
  keys.map((k) => {
    const m = COLLAB_MODELS.find((x) => x.key === k)!;
    return { label: m.label, agent: m.agent, model: m.model, effort: null, readsCode: true };
  });
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
    expect(() => c.create({ title: "", brief: " ", repoPath: null, participants: specs("gpt6", "opus") })).toThrow(/Describe/);
    expect(() => c.create({ title: "", brief: "x", repoPath: null, participants: specs("gpt6") })).toThrow(/two models/);
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
    expect(gptSecond).toMatch(/^In the room: Claude Opus 5.5, Claude Fable 5.1\. There's no repository/);
    expect(gptSecond).toMatch(/\n\nNew since your last turn:/);
    expect(gptSecond).toMatch(/\[Claude Opus 5.5\]/);
    expect(gptSecond).toMatch(/\[User\]\nKeep it under 50 lines please/);
    expect(gptSecond).not.toMatch(/gpt6 thoughts/); // its own words aren't repeated back
    expect(gptSecond).not.toMatch(/The topic:/);
  });
  it("mentions the repo only when the room has one", () => {
    const { make } = rooms();
    const withRepo = make({ repoPath: "/code/app" });
    expect(buildPrompt(withRepo, withRepo.participants[0])).toMatch(/You can read the repository at \/code\/app.*shell commands like cat.*Don't change anything.*MCP and app tools are switched off/s);
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

describe("seats: adding, removing, effort and code access", () => {
  const seat = (room: CollabRoom, key: string) => room.participants.find((p) => p.key === key)!;
  const asSpecs = (room: CollabRoom) =>
    room.participants.filter((p) => !p.removed).map((p) => ({ key: p.key, label: p.label, agent: p.agent, model: p.model, effort: p.effort, readsCode: p.readsCode }));

  it("takes any Claude or Codex model id, with a valid effort for that CLI", () => {
    const { c } = rooms();
    const room = c.create({
      title: "t", brief: "b", repoPath: null,
      participants: [
        { label: "", agent: "claude", model: "claude-sonnet-5", effort: "max", readsCode: true },
        { label: "Fast GPT", agent: "codex", model: "gpt-6-astra-mini", effort: "minimal", readsCode: false },
      ],
    });
    expect(room.participants.map((p) => [p.key, p.label, p.effort, p.color])).toEqual([
      ["claude-sonnet-5", "claude-sonnet-5", "max", 0],
      ["gpt-6-astra-mini", "Fast GPT", "minimal", 1],
    ]);
    expect(() => c.create({ title: "", brief: "b", repoPath: null, participants: [...specs("opus"), { label: "", agent: "codex", model: "x", effort: "max", readsCode: true }] })).toThrow(/max isn't an effort level Codex accepts/);
    expect(() => c.create({ title: "", brief: "b", repoPath: null, participants: [...specs("opus"), { label: "", agent: "claude", model: "a b; rm", effort: null, readsCode: true }] })).toThrow(/isn't a valid model id/);
  });
  it("a model added mid-discussion catches up on everything on its first turn", async () => {
    const { c, make, prompts } = rooms();
    const room = make({ mode: "step", participants: specs("gpt6", "opus") });
    await c.run(room.id);
    c.setParticipants(room.id, [...asSpecs(room), ...specs("fable")]);
    expect(room.messages.at(-1)!.text).toBe("Claude Fable 5.1 joined and can read the code.".replace(" and can read the code", ""));
    await c.run(room.id);
    const first = prompts.find((p) => p.key === "fable")!.prompt;
    expect(first).toMatch(/You are Claude Fable 5.1, one of 3 AI models/);
    expect(first).toMatch(/\[GPT-6 Astra\][\s\S]*\[Claude Opus 5.5\][\s\S]*\[GPT-6 Astra\]/); // round 1 and round 2 so far
    expect(said(room)).toEqual(["1:gpt6", "1:opus", "2:gpt6", "2:opus", "2:fable"]);
  });
  it("a removed model stops taking turns but keeps its name on what it said", async () => {
    const { c, make } = rooms();
    const room = make({ mode: "step" });
    await c.run(room.id);
    c.setParticipants(room.id, asSpecs(room).filter((s) => s.key !== "opus"));
    expect(room.messages.at(-1)!.text).toBe("Claude Opus 5.5 left the room.");
    await c.run(room.id);
    expect(said(room)).toEqual(["1:gpt6", "1:opus", "1:fable", "2:gpt6", "2:fable"]);
    expect(seat(room, "opus")).toMatchObject({ removed: true, label: "Claude Opus 5.5" });
  });
  it("changing effort keeps the model's conversation; the new effort applies next turn", async () => {
    const { c, make } = rooms();
    const room = make({ mode: "step" });
    await c.run(room.id);
    c.setParticipants(room.id, asSpecs(room).map((s) => (s.key === "opus" ? { ...s, effort: "xhigh" } : s)));
    expect(seat(room, "opus")).toMatchObject({ effort: "xhigh", conversationId: "opus-conv" });
    expect(() => c.setParticipants(room.id, asSpecs(room).map((s) => (s.key === "gpt6" ? { ...s, effort: "max" } : s)))).toThrow(/max isn't an effort level for GPT-6 Astra/);
  });
  it("speaking order follows the order given", async () => {
    const { c, make } = rooms();
    const room = make({ mode: "step" });
    c.setParticipants(room.id, asSpecs(room).reverse());
    await c.run(room.id);
    expect(said(room)).toEqual(["1:fable", "1:opus", "1:gpt6"]);
  });
  it("only code readers run in the repo; everyone is told who can read it", async () => {
    const cwds: Record<string, string> = {};
    const prompts: Record<string, string> = {};
    const runTurn: TurnRunner = async (p, prompt, ctx) => {
      cwds[p.key] = ctx.cwd;
      prompts[p.key] = prompt;
      return { text: "ok\nSTANCE: CONTINUE — x", conversationId: "c" };
    };
    const c = new CollabRooms(fs.mkdtempSync(path.join(os.homedir(), "collab-")), runTurn, () => {}, vi.fn(), () => null);
    const room = c.create({ title: "t", brief: "b", repoPath: "/code/app", participants: specs("gpt6", "opus").map((s, i) => ({ ...s, readsCode: i === 0 })), mode: "step" });
    await c.run(room.id);
    expect(cwds.gpt6).toBe("/code/app");
    expect(cwds.opus).not.toBe("/code/app");
    expect(prompts.opus).toMatch(/you can't read it yourself\. When something depends on the code, call the ask_code_reader tool: GPT-6 Astra looks it up/);
    expect(prompts.gpt6).toMatch(/In the room: Claude Opus 5.5\. You can read the repository/);
    c.setParticipants(room.id, room.participants.map((p) => ({ key: p.key, label: p.label, agent: p.agent, model: p.model, effort: null, readsCode: true })));
    expect(room.messages.at(-1)!.text).toBe("Claude Opus 5.5 can now read the code.");
  });
  it("a room from the previous build loads with everyone reading code at default effort", () => {
    const dir = fs.mkdtempSync(path.join(os.homedir(), "collab-"));
    const old = { id: "old1", title: "t", brief: "b", repoPath: null, messages: [], mode: "step", maxRounds: 1, round: 0, running: false, speaking: null, plan: null, implementedIn: null, createdAt: 1,
      participants: [{ key: "opus", label: "Claude Opus 5.5", agent: "claude", model: "claude-opus-5-5", conversationId: null, lastSeen: 0 }] };
    fs.writeFileSync(path.join(dir, "old1.json"), JSON.stringify(old));
    const c = new CollabRooms(dir, async () => ({ text: "", conversationId: "" }), () => {}, vi.fn(), () => null);
    expect(c.get("old1").participants[0]).toMatchObject({ effort: null, readsCode: true, color: 0 });
  });
  it("implementing uses the chosen seat's model and effort", async () => {
    const { c, startSession } = rooms();
    const room = c.create({ title: "t", brief: "b", repoPath: "/code/app", mode: "step", participants: [...specs("gpt6"), { ...specs("opus")[0], effort: "high" }] });
    await c.run(room.id);
    c.approve(room.id, room.messages.find((m) => m.speaker === "gpt6")!.id);
    c.implement(room.id, "opus");
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ agent: "claude", model: "claude-opus-5-5", effort: "high" }));
  });
});

describe("CLI commands", () => {
  const base = { key: "k", label: "L", color: 0, lastSeen: 0, conversationId: null as string | null };
  it("Claude: model, effort, resume; never edits; no file tools without code access", () => {
    const reader = claudeTurnCommand("/bin/claude", { ...base, agent: "claude", model: "claude-opus-5-5", effort: "max", readsCode: true, conversationId: "abc" });
    expect(reader).toBe("'/bin/claude' -p --model 'claude-opus-5-5' --output-format json --strict-mcp-config --resume 'abc' --effort 'max' --disallowedTools Edit Write MultiEdit NotebookEdit Bash");
    const blind = claudeTurnCommand("/bin/claude", { ...base, agent: "claude", model: "claude-fable-5-1", effort: null, readsCode: false });
    expect(blind).toMatch(/--disallowedTools Edit Write MultiEdit NotebookEdit Bash Read Grep Glob LS$/);
    expect(blind).not.toMatch(/--effort|--resume/);
  });
  it("Codex: read-only sandbox on the first turn, effort on every turn", () => {
    const first = codexTurnCommand("/bin/codex", { ...base, agent: "codex", model: "gpt-6-astra", effort: "high", readsCode: true }, "/tmp/r.txt");
    expect(first).toBe(`'/bin/codex' exec -c 'model_reasoning_effort="high"' --disable apps --disable plugins -c 'mcp_servers={}' -c 'approval_policy="never"' -c 'sandbox_mode="read-only"' --json --skip-git-repo-check -m 'gpt-6-astra' -o '/tmp/r.txt' -`);
    const later = codexTurnCommand("/bin/codex", { ...base, agent: "codex", model: "gpt-6-astra", effort: null, readsCode: true, conversationId: "t1" }, "/tmp/r.txt");
    // resume takes no -s, so the sandbox is set on every turn rather than left to the user's config
    expect(later).toBe(`'/bin/codex' exec resume 't1' --disable apps --disable plugins -c 'mcp_servers={}' -c 'approval_policy="never"' -c 'sandbox_mode="read-only"' --json --skip-git-repo-check -o '/tmp/r.txt' -`);
  });
});

describe("asking the code reader", () => {
  function lookupRoom(reply: (key: string, prompt: string, ctx: any) => string = (k) => `${k}\nSTANCE: CONTINUE — x`) {
    const calls: { key: string; prompt: string; ctx: any; conv: string | null }[] = [];
    const runTurn: TurnRunner = async (p, prompt, ctx) => {
      calls.push({ key: p.key, prompt, ctx, conv: p.conversationId });
      return { text: reply(p.key, prompt, ctx), conversationId: `${p.key}-${prompt.startsWith("You are") && prompt.includes("code reader") ? "lookup" : "main"}` };
    };
    const c = new CollabRooms(fs.mkdtempSync(path.join(os.homedir(), "collab-")), runTurn, () => {}, vi.fn(), () => null);
    const room = c.create({
      title: "t", brief: "Design CSV export", repoPath: "/code/app", mode: "step",
      participants: [{ ...specs("gpt6")[0], readsCode: true }, { ...specs("fable")[0], readsCode: false }],
    });
    return { c, room, calls };
  }

  it("only models without code access get the tool, and only when someone can read", async () => {
    const { c, room, calls } = lookupRoom();
    await c.run(room.id);
    expect(calls.map((x) => [x.key, x.ctx.askTool, x.ctx.tag])).toEqual([
      ["gpt6", false, `collab-${room.id}.gpt6`],
      ["fable", true, `collab-${room.id}.fable`],
    ]);
    expect(calls[1].prompt).toMatch(/call the ask_code_reader tool: GPT-6 Astra looks it up and the answer comes back within your turn/);
  });
  it("the reader answers in its own lookup thread, in the repo; the exchange joins the transcript", async () => {
    const { c, room, calls } = lookupRoom((k, prompt) => (prompt.includes("code reader") || prompt.startsWith("Question from") ? "It's in src/export.ts:42 (buildQuery)." : `${k}\nSTANCE: CONTINUE — x`));
    const answer = await c.askCodeReader(room.id, "fable", "Where is the export query built?");
    expect(answer).toBe("It's in src/export.ts:42 (buildQuery).");
    const q = calls.at(-1)!;
    expect(q).toMatchObject({ key: "gpt6", conv: null, ctx: { cwd: "/code/app", askTool: false } });
    expect(q.prompt).toMatch(/You are GPT-6 Astra, the code reader[\s\S]*shell commands like rg[\s\S]*Question from Claude Fable 5.1:\nWhere is the export query built\?/);
    expect(room.messages.at(-1)).toMatchObject({ speaker: "gpt6", askedBy: "fable", kind: "lookup", text: "Claude Fable 5.1 asked: Where is the export query built?\n\nIt's in src/export.ts:42 (buildQuery)." });
    expect(room.participants[0].lookupConversationId).toBe("gpt6-lookup");
    expect(room.participants[0].conversationId).toBeNull(); // the discussion thread is untouched

    await c.askCodeReader(room.id, "fable", "And the CSV writer?");
    expect(calls.at(-1)!).toMatchObject({ conv: "gpt6-lookup", prompt: "Question from Claude Fable 5.1:\nAnd the CSV writer?" });
  });
  it("the asker isn't shown its own lookup again; the others see it", async () => {
    const { c, room, calls } = lookupRoom();
    await c.askCodeReader(room.id, "fable", "Where is it?");
    await c.run(room.id);
    const gpt = calls.filter((x) => x.key === "gpt6" && x.prompt.includes("one of 2 AI models"))[0].prompt;
    expect(gpt).toMatch(/\[GPT-6 Astra answering Claude Fable 5.1's code question\]/); // the reader sees its exchange in context
    const fable = calls.filter((x) => x.key === "fable").at(-1)!.prompt;
    expect(fable).not.toMatch(/answering Claude Fable 5.1's code question/);
  });
  it("caps questions per turn and refuses when nobody can read the code", async () => {
    const { c, room } = lookupRoom();
    for (let i = 0; i < 4; i++) await c.askCodeReader(room.id, "fable", `q${i}`);
    await expect(c.askCodeReader(room.id, "fable", "q5")).rejects.toThrow(/That's 4 questions this turn/);
    const r = await c.handleRoomRequest(room.id, "fable", "ask_code_reader", { question: "q6" });
    expect(r).toEqual({ error: expect.stringMatching(/4 questions this turn/) });
    c.setParticipants(room.id, room.participants.map((p) => ({ key: p.key, label: p.label, agent: p.agent, model: p.model, effort: null, readsCode: false })));
    await expect(c.askCodeReader(room.id, "fable", "q")).rejects.toThrow(/Nobody in this room can read the code/);
    expect(await c.handleRoomRequest(room.id, "fable", "rm_rf", {})).toEqual({ error: "Unknown tool: rm_rf" });
  });
  it("the tool reaches the CLIs as Mockingbird's MCP server, pre-approved", () => {
    const ask = { command: "/Apps/Mockingbird", args: ["/h/mcp.js"], env: { MOCKINGBIRD_SESSION: "collab-r1.fable" } };
    const base = { key: "fable", label: "L", color: 0, lastSeen: 0, conversationId: null, effort: null, readsCode: false };
    const cl = claudeTurnCommand("/bin/claude", { ...base, agent: "claude", model: "claude-fable-5-1" }, ask);
    expect(cl).toContain(`--strict-mcp-config --mcp-config '{"mcpServers":{"mockingbird":{"type":"stdio","command":"/Apps/Mockingbird","args":["/h/mcp.js"],"env":{"MOCKINGBIRD_SESSION":"collab-r1.fable"}}}}' --allowedTools mcp__mockingbird__ask_code_reader`);
    const cx = codexTurnCommand("/bin/codex", { ...base, agent: "codex", model: "gpt-6-astra" }, "/tmp/r", ask);
    expect(cx).toContain(`-c 'mcp_servers={}' -c 'mcp_servers.mockingbird.command="/Apps/Mockingbird"'`);
    expect(cx).toContain(`-c 'mcp_servers.mockingbird.default_tools_approval_mode="approve"' -c 'mcp_servers.mockingbird.tool_timeout_sec=600'`);
  });
});

describe("changing a room's repository", () => {
  it("lets a room started without one gain code readers, keeping conversations", async () => {
    const { c, make, dir } = rooms();
    const room = make({ mode: "step" });
    await c.run(room.id);
    const repo = fs.mkdtempSync(path.join(os.homedir(), "repo-"));
    c.setRepo(room.id, repo);
    expect(room.repoPath).toBe(repo);
    expect(room.messages.at(-1)!.text).toBe(`Repository set to ${path.basename(repo)}.`);
    expect(room.participants.every((p) => p.conversationId)).toBe(true);
    expect(buildPrompt(room, room.participants[0])).toMatch(/You can read the repository at/);
    c.setRepo(room.id, null);
    expect(room.messages.at(-1)!.text).toMatch(/Repository removed/);
    expect(() => c.setRepo(room.id, path.join(dir, "nope"))).toThrow(/doesn't exist/);
  });
});

describe("models that run commands", () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  /** A repo with a commit, an ignored folder, an uncommitted edit and an untracked file. */
  function gitRepo(): string {
    const repo = fs.mkdtempSync(path.join(os.homedir(), "repo-"));
    sh(repo, "init", "-q");
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "committed\n");
    sh(repo, "add", ".");
    sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    fs.writeFileSync(path.join(repo, "a.txt"), "edited\n");
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "new.txt"), "untracked\n");
    fs.mkdirSync(path.join(repo, "node_modules"));
    fs.writeFileSync(path.join(repo, "node_modules", "dep.js"), "ignored\n");
    return repo;
  }

  it("the test copy is the repo as it stands — uncommitted work included, ignored files not — with its own git", async () => {
    const repo = gitRepo();
    const dest = path.join(fs.mkdtempSync(path.join(os.homedir(), "copy-")), "work");
    expect(await makeTestCopy(repo, dest)).toMatch(/^[0-9a-f]{7} \+ uncommitted changes and 1 untracked file$/);
    expect(fs.readFileSync(path.join(dest, "a.txt"), "utf8")).toBe("edited\n");
    expect(fs.readFileSync(path.join(dest, "src", "new.txt"), "utf8")).toBe("untracked\n");
    expect(fs.existsSync(path.join(dest, "node_modules"))).toBe(false);
    // a clone, not a worktree: git in the copy never writes into the real repo's .git
    expect(fs.statSync(path.join(dest, ".git")).isDirectory()).toBe(true);
    expect(sh(repo, "worktree", "list").split("\n")).toHaveLength(1);
    fs.writeFileSync(path.join(dest, "a.txt"), "scribbled\n");
    sh(dest, "add", ".");
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("edited\n");
    expect(sh(repo, "status", "--porcelain")).toBe("M a.txt\n?? src/"); // the repo's index is untouched (output trimmed)
  });

  it("refuses a folder that isn't a git repository, leaving nothing behind", async () => {
    const dest = path.join(fs.mkdtempSync(path.join(os.homedir(), "copy-")), "work");
    await expect(makeTestCopy(fs.mkdtempSync(path.join(os.homedir(), "plain-")), dest)).rejects.toThrow(/git rev-parse failed/);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("they work in the room's test copy, made on first need; readers in the repo; lookups never run commands", async () => {
    const repo = gitRepo();
    const seen: { key: string; cwd: string; runs: boolean; prompt: string }[] = [];
    const runTurn: TurnRunner = async (p, prompt, ctx) => {
      seen.push({ key: p.key, cwd: ctx.cwd, runs: !!p.runsCommands, prompt });
      return { text: "ok\nSTANCE: CONTINUE — x", conversationId: `${p.key}-c` };
    };
    const dir = fs.mkdtempSync(path.join(os.homedir(), "collab-"));
    const c = new CollabRooms(dir, runTurn, () => {}, vi.fn(), () => null);
    const [gpt6, opus, fable] = specs("gpt6", "opus", "fable");
    const room = c.create({ title: "t", brief: "b", repoPath: repo, mode: "step", participants: [{ ...gpt6, runsCommands: true, readsCode: false }, opus, { ...fable, readsCode: false }] });
    expect(room.participants[0]).toMatchObject({ runsCommands: true, readsCode: true }); // running implies reading
    expect(room.workspacePath).toBeNull();
    await c.run(room.id);
    const copy = path.join(dir, "work", room.id);
    expect(room.workspacePath).toBe(copy);
    expect(seen.map((s) => [s.key, s.cwd])).toEqual([["gpt6", copy], ["opus", repo], ["fable", path.join(dir, room.id)]]);
    expect(room.messages.some((m) => m.speaker === "system" && /^Made a test copy of repo-\w+ \([0-9a-f]{7} \+ uncommitted/.test(m.text))).toBe(true);
    expect(seen[0].prompt).toContain(`run commands — tests, builds, scripts — in a disposable copy of the repository at ${copy}, made from ${repo}`);
    expect(seen[0].prompt).toMatch(/Docker isn't/);
    expect(seen[0].prompt).not.toMatch(/write files there/); // Codex writes with its shell
    expect(seen[2].prompt).not.toMatch(/write files/);
    expect(buildPrompt(room, { ...room.participants[1], runsCommands: true })).toMatch(/your file tools to read and to write files there/);
    expect(seen[1].prompt).toMatch(/In the room: GPT-6 Astra \(reads the code, runs commands\), Claude Fable 5.1\./);

    // the copy is reused from turn to turn — work a model did there (installs, builds) survives
    fs.writeFileSync(path.join(copy, "built.txt"), "x");
    await c.run(room.id);
    expect(seen[3].cwd).toBe(copy);
    expect(fs.existsSync(path.join(copy, "built.txt"))).toBe(true);

    // a command-running reader answers lookups from the real checkout, without its commands
    seen.length = 0;
    c.setParticipants(room.id, [{ ...gpt6, key: "gpt6", runsCommands: true, readsCode: true }, { ...fable, key: "fable", readsCode: false }]);
    await c.askCodeReader(room.id, "fable", "where is export?");
    expect(seen[0]).toMatchObject({ key: "gpt6", cwd: repo, runs: false });
  });

  it("the copy is thrown away on reset, on a new repository and with the room", async () => {
    const repo = gitRepo();
    const dir = fs.mkdtempSync(path.join(os.homedir(), "collab-"));
    const c = new CollabRooms(dir, async (p) => ({ text: "ok\nSTANCE: CONTINUE — x", conversationId: `${p.key}-c` }), () => {}, vi.fn(), () => null);
    const room = c.create({ title: "t", brief: "b", repoPath: repo, mode: "step", participants: specs("gpt6", "opus").map((s) => ({ ...s, runsCommands: true })) });
    const copy = path.join(dir, "work", room.id);
    await c.run(room.id);
    expect(fs.existsSync(copy)).toBe(true);
    c.resetTestCopy(room.id);
    expect(fs.existsSync(copy)).toBe(false);
    expect(room.workspacePath).toBeNull();
    expect(room.messages.at(-1)!.text).toMatch(/^Test copy reset/);
    await c.run(room.id);
    c.setRepo(room.id, gitRepo());
    expect(fs.existsSync(copy)).toBe(false);
    await c.run(room.id);
    expect(fs.existsSync(copy)).toBe(true);
    c.delete(room.id);
    expect(fs.existsSync(copy)).toBe(false);
  });

  it("a failed copy is that model's turn error; the others carry on", async () => {
    const dir = fs.mkdtempSync(path.join(os.homedir(), "collab-"));
    const c = new CollabRooms(dir, async (p) => ({ text: "ok\nSTANCE: CONTINUE — x", conversationId: `${p.key}-c` }), () => {}, vi.fn(), () => null);
    const plain = fs.mkdtempSync(path.join(os.homedir(), "plain-"));
    const room = c.create({ title: "t", brief: "b", repoPath: plain, mode: "step", participants: [{ ...specs("gpt6")[0], runsCommands: true }, ...specs("opus")] });
    await c.run(room.id);
    expect(room.messages.find((m) => m.kind === "error")!.text).toMatch(/^GPT-6 Astra couldn't take its turn: git rev-parse failed/);
    expect(said(room)).toContain("1:opus");
  });

  it("a room from before this build loads with nobody running commands", () => {
    const dir = fs.mkdtempSync(path.join(os.homedir(), "collab-"));
    fs.writeFileSync(
      path.join(dir, "old2.json"),
      JSON.stringify({ id: "old2", title: "t", brief: "b", repoPath: null, participants: [{ key: "opus", label: "O", agent: "claude", model: "m", conversationId: null, lastSeen: 0, readsCode: true }], messages: [], mode: "step", maxRounds: 1, round: 0, running: false, speaking: null, plan: null, implementedIn: null, createdAt: 1 })
    );
    const c = new CollabRooms(dir, async () => ({ text: "", conversationId: "" }), () => {}, vi.fn(), () => null);
    expect(c.get("old2").participants[0].runsCommands).toBe(false);
    expect(c.get("old2").workspacePath).toBeNull();
  });

  it("CLI: Claude gets Bash in its OS sandbox and file edits confined to its cwd; Codex a workspace-write sandbox with the network", () => {
    const base = { key: "k", label: "L", color: 0, lastSeen: 0, conversationId: "c1", effort: null, readsCode: true, runsCommands: true };
    const cl = claudeTurnCommand("/bin/claude", { ...base, agent: "claude", model: "claude-opus-5-5" });
    const settings = JSON.parse(/--settings '([^']+)'/.exec(cl)![1]);
    expect(settings.sandbox).toEqual({ enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, network: { allowLocalBinding: true, allowedDomains: ["*"] } });
    expect(cl).toMatch(/--permission-mode acceptEdits --disallowedTools NotebookEdit$/);
    const cx = codexTurnCommand("/bin/codex", { ...base, agent: "codex", model: "gpt-6-astra" }, "/tmp/r");
    expect(cx).toContain(`-c 'sandbox_mode="workspace-write"' -c 'sandbox_workspace_write.network_access=true'`);
    expect(cx).not.toContain("read-only");
  });
});
