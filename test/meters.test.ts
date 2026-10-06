import { describe, expect, it } from "vitest";
import { computeMeters, fiveHourWindows, weighted } from "../src/main/meters";
import type { UsageRow } from "../src/main/transcripts";
import { formatTokens, type UsageReport } from "../src/shared/types";

const now = Date.parse("2026-10-03T15:00:00Z");
const resetsAt = now + 2 * 3_600_000; // the window started 3 hours ago
const report = (pct: number): UsageReport => ({
  claude: { agent: "claude", plan: "Max", limits: [{ label: "5-hour limit", window: "5h", usedPct: pct, resetsAt }], at: now },
  codex: null,
});
const row = (conv: string, model: string, input: number, output: number, cacheRead = 0): UsageRow => ({ conv, agent: "claude", model, input, output, cacheRead, cacheWrite: 0, replies: 1 });

describe("token meters", () => {
  it("adds up a pane's conversations and estimates its share of the 5-hour window", () => {
    // two panes used the window equally (same model, same tokens); the window is 40% used
    const window = [row("a1", "claude-opus-5-5", 1000, 1000), row("b1", "claude-opus-5-5", 1000, 1000)];
    const m = computeMeters({
      sessions: [
        { id: "A", agent: "claude", conversations: ["a0", "a1"] },
        { id: "B", agent: "claude", conversation: { agent: "claude", id: "b1" } },
        { id: "C", agent: "claude" },
      ],
      rows: [row("a0", "claude-opus-5-5", 500, 100), ...window],
      windowRows: { claude: window },
      todayRows: window,
      report: report(40),
      now,
    });
    expect(m.sessions.A.tokens).toMatchObject({ input: 1500, output: 1100, replies: 2 }); // both of A's conversations
    expect(m.sessions.A.window).toMatchObject({ tokens: 2000, sharePct: 20, usedPct: 40, resetsAt });
    expect(m.sessions.B.window?.sharePct).toBe(20);
    expect(m.sessions.C).toBeUndefined(); // no conversation yet
    expect(m.today.claude).toMatchObject({ input: 2000, output: 2000, replies: 2 });
  });

  it("weighs tokens by model: Opus output fills a window faster than cached Sonnet input", () => {
    expect(weighted(row("x", "claude-opus-5-5", 0, 1000))).toBeGreaterThan(weighted(row("y", "claude-sonnet-5-5", 0, 0, 1000)) * 100);
    const window = [row("a", "claude-opus-5-5", 0, 1000), row("b", "claude-haiku-4-5", 0, 1000)];
    const m = computeMeters({ sessions: [{ id: "A", conversations: ["a"] }, { id: "B", conversations: ["b"] }], rows: window, windowRows: { claude: window }, todayRows: [], report: report(30), now });
    expect(m.sessions.A.window!.sharePct!).toBeGreaterThan(m.sessions.B.window!.sharePct! * 10);
    expect(m.sessions.A.window!.sharePct! + m.sessions.B.window!.sharePct!).toBeCloseTo(30, 0);
  });

  it("has no window share without a current 5-hour reading", () => {
    expect(fiveHourWindows(report(10), resetsAt + 1)).toEqual({}); // already reset
    expect(fiveHourWindows({ claude: { agent: "claude", plan: null, limits: [{ label: "5-hour limit", window: "5h", usedPct: 0, resetsAt: null, note: "no reading yet" }], at: now }, codex: null }, now)).toEqual({});
    const m = computeMeters({ sessions: [{ id: "A", conversations: ["a"] }], rows: [row("a", "x", 1, 1)], windowRows: {}, todayRows: [], report: { claude: null, codex: null }, now });
    expect(m.sessions.A.window).toBeNull();
  });

  it("formats counts compactly", () => {
    expect([980, 34_200, 1_240_000, 15_600_000, 2_100_000_000].map(formatTokens)).toEqual(["980", "34k", "1.2M", "16M", "2.1B"]);
  });
});
