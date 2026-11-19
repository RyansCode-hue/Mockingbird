import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_DIR, claudeContext, codexContext, readContextWindow, usageReporterSettings } from "../src/main/usage";
import { contextLine, contextPct, contextTarget, contextTokens } from "../src/renderer/usageFormat";
import type { RoomSessionTag } from "../src/shared/team/livePanes";

const mb = path.join(os.homedir(), ".mockingbird");
const settings = path.join(os.homedir(), ".claude", "settings.json");
const ID = "3f2a9c1e-0b4d-4e7a-9c55-1d2e3f4a5b6c";
const report = (payload: unknown) => execFileSync(path.join(mb, "statusline.sh"), { input: JSON.stringify(payload) });
const contextWindow = (tokens: number, size: number) => ({
  total_input_tokens: tokens,
  total_output_tokens: 120,
  context_window_size: size,
  current_usage: tokens ? { input_tokens: 10, output_tokens: 120, cache_creation_input_tokens: 400, cache_read_input_tokens: tokens - 410 } : null,
  used_percentage: tokens ? Math.round((tokens / size) * 100) : null,
  remaining_percentage: tokens ? 100 - Math.round((tokens / size) * 100) : null,
});

beforeEach(() => {
  fs.rmSync(CONTEXT_DIR, { recursive: true, force: true });
  fs.rmSync(settings, { force: true });
});

describe("the reporter keeps each conversation's context window", () => {
  it("files every payload under its top-level session id, rate limits or not", () => {
    usageReporterSettings();
    report({ session_id: ID, transcript_path: "/x.jsonl", model: { id: "claude-opus-4-7[1m]" }, context_window: contextWindow(275_600, 1_000_000), remote: { session_id: "other" } });
    const kept = JSON.parse(fs.readFileSync(path.join(CONTEXT_DIR, `${ID}.json`), "utf8"));
    expect(kept.context_window.total_input_tokens).toBe(275_600);
    expect(fs.readdirSync(CONTEXT_DIR)).toEqual([`${ID}.json`]); // no leftovers, no nested id
  });
  it("ignores a session id that couldn't name a file safely", () => {
    usageReporterSettings();
    report({ session_id: "../../evil", context_window: contextWindow(1000, 200_000) });
    expect(fs.existsSync(CONTEXT_DIR)).toBe(false);
  });
  it("prunes reports of conversations idle for two weeks when a Claude session starts", () => {
    fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    const old = path.join(CONTEXT_DIR, "old.json");
    const recent = path.join(CONTEXT_DIR, "recent.json");
    fs.writeFileSync(old, "{}");
    fs.writeFileSync(recent, "{}");
    const t = (Date.now() - 15 * 86_400_000) / 1000;
    fs.utimesSync(old, t, t);
    usageReporterSettings();
    expect(fs.readdirSync(CONTEXT_DIR)).toEqual(["recent.json"]);
  });
});

describe("a Claude session's context window", () => {
  const write = (payload: unknown) => {
    fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    fs.writeFileSync(path.join(CONTEXT_DIR, `${ID}.json`), JSON.stringify(payload));
  };
  it("reads a 1M-context model's window as Claude Code reports it", () => {
    write({ session_id: ID, context_window: contextWindow(275_600, 1_000_000) });
    expect(claudeContext(ID)).toMatchObject({ state: "reading", agent: "claude", tokens: 275_600, window: 1_000_000 });
  });
  it("reads a 200k model's window", () => {
    write({ session_id: ID, context_window: contextWindow(150_000, 200_000) });
    expect(claudeContext(ID)).toMatchObject({ state: "reading", tokens: 150_000, window: 200_000 });
  });
  it("reads the model, the prompt cache and the running cost as Claude Code 2.1.3xx reports them, and leaves out what's missing", () => {
    // the fields of 2.1.310's payload: model.id, prompt_cache (epoch seconds), cost.total_cost_usd
    write({
      session_id: ID,
      model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
      context_window: contextWindow(150_000, 200_000),
      cost: { total_cost_usd: 4.21, total_duration_ms: 1, total_api_duration_ms: 1, total_lines_added: 0, total_lines_removed: 0 },
      prompt_cache: { warm: true, caching_observed: true, ttl: "5m", expires_at: 1_792_000_000, requests: 9, misses: 0, recache_tokens_if_cold: 149_200 },
    });
    expect(claudeContext(ID)).toMatchObject({ model: "claude-opus-5-5", costUsd: 4.21, cache: { warm: true, expiresAt: 1_792_000_000_000, recacheTokens: 149_200 } });
    // an older CLI: no prompt_cache, no cost
    write({ session_id: ID, context_window: contextWindow(150_000, 200_000), prompt_cache: { warm: "yes" } });
    const r = claudeContext(ID);
    expect(r).not.toHaveProperty("cache");
    expect(r).not.toHaveProperty("costUsd");
  });
  it("says there's been no reply yet when the conversation has no messages", () => {
    write({ session_id: ID, context_window: contextWindow(0, 200_000) });
    expect(claudeContext(ID)).toEqual({ state: "none", why: "No reply yet in this conversation" });
  });
  it("says no report has come yet, or that the user's own statusLine replaces the reporter", () => {
    expect(claudeContext(ID)).toMatchObject({ state: "none", why: expect.stringContaining("No report yet") });
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "mine.sh" } }));
    expect(claudeContext(ID)).toMatchObject({ state: "none", why: expect.stringContaining("your own statusLine") });
  });
  it("shows a short error and logs it for a corrupt report or one without a window", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fs.mkdirSync(CONTEXT_DIR, { recursive: true });
      fs.writeFileSync(path.join(CONTEXT_DIR, `${ID}.json`), "{not json");
      expect(claudeContext(ID)).toEqual({ state: "error", why: "Couldn't read Claude's report" });
      write({ session_id: ID, context_window: { total_input_tokens: 5 } });
      expect(claudeContext(ID).state).toBe("error");
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0][0])).toContain(`${ID}.json`);
    } finally {
      warn.mockRestore();
    }
  });
  it("refuses an id that isn't a conversation id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(claudeContext("../usage").state).toBe("error");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a Codex session's context window", () => {
  const sessions = path.join(os.homedir(), ".codex", "sessions");
  const dir = path.join(sessions, "2026", "10", "12");
  const CODEX_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  const file = path.join(dir, `rollout-2026-10-12T09-00-00-${CODEX_ID}.jsonl`);
  const tokenCount = (info: unknown, ts = "2026-10-12T09:01:00Z") => JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info } });
  afterEach(() => fs.rmSync(path.join(os.homedir(), ".codex"), { recursive: true, force: true }));

  it("reads the newest turn's tokens over the model's window", () => {
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { id: CODEX_ID } }),
      tokenCount({ total_token_usage: { total_tokens: 20_000 }, last_token_usage: { input_tokens: 19_000, cached_input_tokens: 9000, output_tokens: 1000, total_tokens: 20_000 }, model_context_window: 272_000 }, "2026-10-12T09:00:30Z"),
      tokenCount({ total_token_usage: { total_tokens: 84_000 }, last_token_usage: { input_tokens: 63_000, cached_input_tokens: 60_000, output_tokens: 1210, total_tokens: 64_210 }, model_context_window: 272_000 }),
      tokenCount(null), // a rate-limits-only event carries no info
    ];
    fs.writeFileSync(file, lines.join("\n") + "\n");
    expect(codexContext(CODEX_ID, sessions)).toEqual({ state: "reading", agent: "codex", tokens: 64_210, window: 272_000, at: Date.parse("2026-10-12T09:01:00Z") });
  });
  it("says so when Codex didn't report the window, or there's no turn yet", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, tokenCount({ last_token_usage: { total_tokens: 500 } }) + "\n");
    expect(codexContext(CODEX_ID, sessions)).toEqual({ state: "none", why: "Codex didn't report this model's context window" });
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: CODEX_ID } }) + "\n");
    expect(codexContext(CODEX_ID, sessions)).toEqual({ state: "none", why: "No reply yet in this conversation" });
    expect(codexContext("no-such-conversation", sessions)).toEqual({ state: "none", why: "No reply yet in this conversation" });
  });
});

describe("which session the row reads", () => {
  it("a terminal, or a pane with no conversation yet, has nothing to read", () => {
    expect(readContextWindow({ shell: true })).toEqual({ state: "none", why: "A terminal has no context window" });
    expect(readContextWindow({ agent: "claude" })).toEqual({ state: "none", why: "No reply yet in this conversation" });
  });
  it("follows the focused pane, and says plainly when there's none or it's a teammate's", () => {
    expect(contextTarget(null)).toEqual({ why: "No agent session focused" });
    expect(contextTarget({ id: "s1" })).toEqual({ id: "s1" });
    expect(contextTarget({ id: "s4", shell: true })).toEqual({ why: expect.stringContaining("terminal") });
    const room = { remote: true, ownerName: "Nick Smith" } as RoomSessionTag;
    expect(contextTarget({ id: "r~x", room })).toEqual({ why: "Not available for a teammate's session: it runs on Nick Smith's Mac" });
    expect(contextTarget({ id: "s1", room: { ...room, remote: false } })).toEqual({ id: "s1" });
  });
});

describe("context window text", () => {
  it("writes tokens to a tenth: k under a million, M from there", () => {
    expect(contextTokens(275_612)).toBe("275.6k");
    expect(contextTokens(200_000)).toBe("200k");
    expect(contextTokens(1_000_000)).toBe("1M");
    expect(contextTokens(999_960)).toBe("1M");
    expect(contextTokens(1_500_000)).toBe("1.5M");
    expect(contextTokens(640)).toBe("640");
  });
  it("gives the share of the window, whole percent, clamped", () => {
    expect(contextLine(275_612, 1_000_000)).toBe("275.6k / 1M (28%)");
    expect(contextLine(275_612, 200_000)).toBe("275.6k / 200k (100%)");
    expect(contextLine(150_000, 200_000)).toBe("150k / 200k (75%)");
    expect(contextPct(1, 0)).toBe(0);
    expect(contextPct(-5, 100)).toBe(0);
  });
});
