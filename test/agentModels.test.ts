import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { readLaunchModels } from "../src/main/agentModels";
import { claudeProjectDir } from "../src/main/agentFiles";
import { CONTEXT_DIR } from "../src/main/usage";
import { tempDir } from "./helpers";

// Which model (and Codex reasoning effort) an agent reported running in a launch, read from the tails of the files its
// CLI writes: what a /model typed in a pane is told from its launch's default by.

const iso = (ms: number) => new Date(ms).toISOString();
const LAUNCH = Date.parse("2026-10-12T10:00:00Z");

describe("a Codex launch's models, from its rollout's turn_context events", () => {
  const CODEX_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  const dir = path.join(os.homedir(), ".codex", "sessions", "2026", "10", "12");
  const file = path.join(dir, `rollout-2026-10-12T09-00-00-${CODEX_ID}.jsonl`);
  const turn = (at: number, model: string, effort?: string) =>
    JSON.stringify({ timestamp: iso(at), type: "turn_context", payload: { cwd: "/w", approval_policy: "on-request", model, ...(effort ? { effort } : {}), summary: "auto" } });
  const tokens = (at: number) => JSON.stringify({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 900 } } } });
  const session = { agent: "codex" as const, shell: false, cwd: "/w", createdAt: LAUNCH, conversation: { agent: "codex" as const, id: CODEX_ID } };
  const write = (lines: string[]) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, lines.join("\n") + "\n");
  };
  afterEach(() => fs.rmSync(path.join(os.homedir(), ".codex"), { recursive: true, force: true }));

  it("gives the launch's first turn's model and effort and its latest, an earlier launch's left out", () => {
    write([
      JSON.stringify({ timestamp: iso(LAUNCH - 3_600_000), type: "session_meta", payload: { id: CODEX_ID, cwd: "/w", source: "cli" } }),
      turn(LAUNCH - 3_000_000, "gpt-5.1-codex-mini", "low"), // the launch before this one
      turn(LAUNCH + 5_000, "gpt-5.1-codex", "medium"),
      tokens(LAUNCH + 9_000),
      turn(LAUNCH + 60_000, "gpt-5.1-codex-max", "xhigh"),
      tokens(LAUNCH + 70_000),
    ]);
    expect(readLaunchModels(session, { first: true })).toEqual({
      first: { model: "gpt-5.1-codex", effort: "medium" },
      earliest: { model: "gpt-5.1-codex", effort: "medium" },
      last: { model: "gpt-5.1-codex-max", effort: "xhigh" },
      at: LAUNCH + 60_000,
    });
    // a turn that names no effort runs its model's default
    write([turn(LAUNCH + 5_000, "gpt-5.1-codex")]);
    expect(readLaunchModels(session, { first: true })).toMatchObject({ first: { model: "gpt-5.1-codex", effort: null }, last: { model: "gpt-5.1-codex", effort: null }, at: LAUNCH + 5_000 });
    // nothing yet this launch
    write([turn(LAUNCH - 5_000, "gpt-5.1-codex", "high")]);
    expect(readLaunchModels(session, { first: true })).toBeNull();
    // a hook's transcript_path names the file without a look through Codex's folders
    expect(readLaunchModels({ ...session, createdAt: LAUNCH - 9_000 }, { first: false, transcript: file })?.last).toEqual({ model: "gpt-5.1-codex", effort: "high" });
  });

  it("reads its latest from the file's end, and looks further back for the launch's first only when asked, up to a bound", () => {
    const filler = (at: number, kb: number) => JSON.stringify({ timestamp: iso(at), type: "response_item", payload: { type: "function_call_output", output: "x".repeat(kb * 1024) } });
    write([turn(LAUNCH - 1_000, "gpt-5.1-codex", "low"), turn(LAUNCH + 1_000, "gpt-5.1-codex", "medium"), filler(LAUNCH + 2_000, 600), turn(LAUNCH + 3_000, "gpt-5.1-codex", "high")]);
    const high = { model: "gpt-5.1-codex", effort: "high" };
    expect(readLaunchModels(session, { first: false })).toEqual({ first: null, earliest: high, last: high, at: LAUNCH + 3_000 });
    expect(readLaunchModels(session, { first: true })).toMatchObject({ first: { model: "gpt-5.1-codex", effort: "medium" }, earliest: { effort: "medium" } });
    // a launch that began further back than the bound: its first is unknown, not guessed from what's within it
    write([turn(LAUNCH + 1_000, "gpt-5.1-codex", "medium"), filler(LAUNCH + 2_000, 4200), turn(LAUNCH + 3_000, "gpt-5.1-codex", "high"), turn(LAUNCH + 4_000, "gpt-5.1-codex", "high")]);
    expect(readLaunchModels(session, { first: true })).toEqual({ first: null, earliest: high, last: high, at: LAUNCH + 4_000 });
  });
});

describe("a Claude launch's models, from its transcript and its status line's report", () => {
  const ID = "3f2a9c1e-0b4d-4e7a-9c55-1d2e3f4a5b6c";
  afterEach(() => {
    fs.rmSync(path.join(os.homedir(), ".claude"), { recursive: true, force: true });
    fs.rmSync(CONTEXT_DIR, { recursive: true, force: true });
  });
  const reply = (at: number, model: string, extra: object = {}) =>
    JSON.stringify({ parentUuid: null, isSidechain: false, type: "assistant", message: { model, role: "assistant", content: [{ type: "text", text: "ok" }] }, uuid: "u", timestamp: iso(at), ...extra });

  it("gives the launch's first reply's model and its latest, leaving out an earlier launch's, a subagent's and a synthetic one", () => {
    const cwd = tempDir("repo");
    const launch = Date.now() - 600_000;
    const transcript = path.join(claudeProjectDir(cwd), `${ID}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(
      transcript,
      [
        reply(launch - 60_000, "claude-haiku-4-5"),
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, timestamp: iso(launch + 1_000) }),
        reply(launch + 2_000, "claude-opus-4-7"),
        reply(launch + 3_000, "claude-sonnet-4-5"),
        reply(launch + 4_000, "claude-haiku-4-5", { isSidechain: true }),
        reply(launch + 5_000, "<synthetic>"),
      ].join("\n") + "\n"
    );
    const s = { agent: "claude" as const, shell: false, cwd, createdAt: launch, conversation: { agent: "claude" as const, id: ID } };
    expect(readLaunchModels(s, { first: true })).toEqual({ first: { model: "claude-opus-4-7" }, earliest: { model: "claude-opus-4-7" }, last: { model: "claude-sonnet-4-5" }, at: launch + 3_000 });
    // the status line's report is newer than the last reply (a /model typed since): it's the latest
    fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    fs.writeFileSync(path.join(CONTEXT_DIR, `${ID}.json`), JSON.stringify({ session_id: ID, model: { id: "claude-opus-4-7[1m]" } }));
    expect(readLaunchModels(s, { first: true })).toMatchObject({ first: { model: "claude-opus-4-7" }, last: { model: "claude-opus-4-7[1m]" } });
    // one from before this launch is an older run's
    const before = (launch - 1_000) / 1000;
    fs.utimesSync(path.join(CONTEXT_DIR, `${ID}.json`), before, before);
    expect(readLaunchModels(s, { first: true })?.last).toEqual({ model: "claude-sonnet-4-5" });
    // no reply yet this launch: only the status line says, so its first isn't known
    fs.utimesSync(path.join(CONTEXT_DIR, `${ID}.json`), new Date(), new Date());
    expect(readLaunchModels({ ...s, createdAt: launch + 6_000 }, { first: true })).toMatchObject({ first: null, earliest: { model: "claude-opus-4-7[1m]" }, last: { model: "claude-opus-4-7[1m]" } });
  });
});
