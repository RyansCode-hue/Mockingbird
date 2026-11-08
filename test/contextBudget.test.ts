import { describe, expect, it } from "vitest";
import {
  ASK_SHARE_PCT,
  CLAUDE_COMPACT_RESERVE,
  compactBlocker,
  contextBudget,
  costSentence,
  costWhy,
  keepDismissal,
  rereadCost,
  shownLevel,
  sumEstimates,
  unitsPerPct,
  usableWindow,
} from "../src/shared/contextBudget";

const now = Date.parse("2026-10-26T15:00:00Z");
const min = 60_000;

describe("context warning thresholds", () => {
  it("measures Claude against where it compacts by itself, 33k below its window", () => {
    expect(CLAUDE_COMPACT_RESERVE).toBe(33_000);
    expect(usableWindow("claude", 200_000)).toBe(167_000);
    expect(usableWindow("claude", 1_000_000)).toBe(967_000);
    expect(usableWindow("codex", 272_000)).toBe(272_000); // Codex reports no auto-compact point: its window stands in
  });

  it("heads-up at 75% of that point, firm at 90%: before Claude's own compaction, never after it", () => {
    const at = (tokens: number, window = 200_000, agent: "claude" | "codex" = "claude") => contextBudget({ agent, tokens, window }).level;
    expect(at(125_000)).toBe(0); // 74.9% of 167k
    expect(at(125_300)).toBe(1); // 75%
    expect(at(150_200)).toBe(1);
    expect(at(150_300)).toBe(2); // 90%: 16.7k left before Claude compacts at 167k
    expect(at(724_000, 1_000_000)).toBe(0);
    expect(at(726_000, 1_000_000)).toBe(1);
    expect(at(871_000, 1_000_000)).toBe(2);
    expect(at(203_000, 272_000, "codex")).toBe(0);
    expect(at(204_000, 272_000, "codex")).toBe(1);
    expect(at(245_000, 272_000, "codex")).toBe(2);
    const b = contextBudget({ agent: "claude", tokens: 152_300, window: 200_000 });
    expect(b).toMatchObject({ usable: 167_000, left: 14_700, autoCompacts: true });
    expect(Math.round(b.pct)).toBe(91);
  });

  it("a dismissal holds at its level and the next threshold warns again; dropping below ends it", () => {
    expect(shownLevel(1, undefined)).toBe(1);
    expect(shownLevel(1, { level: 1 })).toBe(0);
    expect(shownLevel(2, { level: 1 })).toBe(2); // 75% dismissed: 90% still warns
    expect(shownLevel(2, { level: 2 })).toBe(0);
    expect(keepDismissal({ level: 1 }, 2)).toEqual({ level: 1 });
    expect(keepDismissal({ level: 2 }, 2)).toEqual({ level: 2 });
    expect(keepDismissal({ level: 2 }, 0)).toBeUndefined(); // compacted: the next rise warns from the start
    expect(keepDismissal({ level: 2 }, 1)).toBeUndefined();
  });
});

describe("Compact's gate", () => {
  it("allows only an idle session at its prompt with nothing typed there", () => {
    expect(compactBlocker({ status: "idle" })).toBeNull();
    expect(compactBlocker({ status: "waiting" })).toMatch(/asking for permission/);
    expect(compactBlocker({ status: "working" })).toMatch(/mid-turn/);
    expect(compactBlocker({ status: "dead" })).toMatch(/isn't running/);
    expect(compactBlocker({ status: "idle", draft: true })).toMatch(/unsent text/);
    expect(compactBlocker({ status: "idle", starting: true })).toMatch(/starting/);
    expect(compactBlocker({ status: "idle", shell: true })).toMatch(/terminal/);
    expect(compactBlocker({ status: "idle", remote: true })).toMatch(/teammate/);
    expect(compactBlocker({ status: "idle", compactSentAt: now - 30_000 }, now)).toMatch(/just sent/);
    expect(compactBlocker({ status: "idle", compactSentAt: now - 5 * min }, now)).toBeNull();
  });
});

describe("what re-reading a conversation costs", () => {
  // this Mac's sessions used 38 units of the window, which is at 40%: 0.95 units per 1%
  const rate = unitsPerPct(38, 40)!;

  it("prices a cold Claude re-read as cache writes (1.25× input) and a warm one as cache reads (0.1×)", () => {
    expect(rate).toBeCloseTo(0.95);
    const cold = rereadCost({ agent: "claude", model: "claude-opus-5-5", tokens: 380_000, cache: { warm: false, expiresAt: now - 3 * 60 * min }, now, unitsPerPct: rate });
    expect(cold.cold).toBe(true);
    expect(cold.units).toBeCloseTo((380_000 * 18.75) / 1e6); // 7.125
    expect(cold.warmUnits).toBeCloseTo((380_000 * 1.5) / 1e6);
    expect(cold.sharePct).toBeCloseTo(7.5);
    expect(cold.ask).toBe(true);
    expect(costSentence("Resuming this", cold)).toBe("Resuming this re-reads about 380k tokens, roughly 7.5% of your 5-hour limit.");
    expect(costWhy(cold, "claude")).toBe("Cold: its cache went cold 3 hr ago, so they're written to the cache again at about 1.25× the input price — about 13× what a warm cache would cost.");
    const warm = rereadCost({ agent: "claude", model: "claude-opus-5-5", tokens: 380_000, cache: { warm: true, expiresAt: now + min }, now, unitsPerPct: rate });
    expect(warm.cold).toBe(false);
    expect(warm.sharePct).toBeCloseTo(0.6);
    expect(warm.ask).toBe(false); // a warm cache is never worth asking about
    // Sonnet costs a fifth of Opus
    expect(rereadCost({ agent: "claude", model: "claude-sonnet-5", tokens: 380_000, fresh: true, now, unitsPerPct: rate }).sharePct).toBeCloseTo(1.5);
  });

  it("adds several resumes up into one estimate, so a batch asks once: a share only when each has one", () => {
    const cold = rereadCost({ agent: "claude", model: "claude-opus-5-5", tokens: 380_000, cache: { warm: false, expiresAt: now - 3 * 60 * min }, now, unitsPerPct: rate });
    const warm = rereadCost({ agent: "claude", model: "claude-opus-5-5", tokens: 20_000, cache: { warm: true, expiresAt: now + min }, now, unitsPerPct: rate });
    const both = sumEstimates([cold, warm]);
    expect(both).toMatchObject({ tokens: 400_000, cold: true, fresh: false, why: "some of their caches are cold", ask: true });
    expect(both.units).toBeCloseTo(cold.units + warm.units);
    expect(both.sharePct).toBeCloseTo(cold.sharePct! + warm.sharePct!);
    expect(sumEstimates([warm, warm]).ask).toBe(false);
    // its why speaks of them all, not of any one's "its cache"; one alone says its own
    expect(sumEstimates([cold, cold]).why).toBe("their caches are cold");
    expect(sumEstimates([warm, warm]).why).toBe("their caches are still warm");
    expect(sumEstimates([cold]).why).toBe(cold.why);
    expect(sumEstimates([]).why).toBe("");
    expect(costWhy(both, "claude")).toMatch(/^Cold: some of their caches are cold, so they're written to the cache again/);
    expect(costWhy(sumEstimates([warm, warm]), "claude")).toMatch(/^It's cheap now: their caches are still warm/);
    expect(sumEstimates([cold, { ...warm, sharePct: null }]).sharePct).toBeNull();
  });

  it("takes the cache to be cold five minutes after the last reply when the agent doesn't say", () => {
    const at = (idle: number) => rereadCost({ agent: "claude", tokens: 200_000, lastAt: now - idle, now, unitsPerPct: rate });
    expect(at(4 * min).cold).toBe(false);
    expect(at(6 * min).cold).toBe(true);
    expect(at(6 * min).why).toMatch(/6 min ago, past the cache's 5 minutes/);
  });

  it("prices Codex's miss as plain input (no write charge)", () => {
    const e = rereadCost({ agent: "codex", tokens: 100_000, lastAt: now - 60 * min, now, unitsPerPct: null });
    expect(e.units).toBeCloseTo((100_000 * 1.25) / 1e6);
    expect(e.sharePct).toBeNull();
    expect(costWhy(e, "codex")).toMatch(/sent as new input/);
  });

  it("asks from 5% of the 5-hour limit, or 150k tokens cold when there's no plan reading", () => {
    expect(ASK_SHARE_PCT).toBe(5);
    const big = rereadCost({ agent: "claude", tokens: 160_000, now, unitsPerPct: null });
    expect(big).toMatchObject({ cold: true, sharePct: null, ask: true });
    expect(costSentence("Resuming this", big)).toBe("Resuming this re-reads about 160k tokens.");
    expect(rereadCost({ agent: "claude", tokens: 140_000, now, unitsPerPct: null }).ask).toBe(false);
    // 200k Opus cold at 0.95/% is 3.9%: below the bar
    expect(rereadCost({ agent: "claude", tokens: 200_000, now, unitsPerPct: rate }).ask).toBe(false);
    expect(rereadCost({ agent: "claude", tokens: 260_000, now, unitsPerPct: rate }).ask).toBe(true);
    // under 1% used, the window can't say what a percent holds
    expect(unitsPerPct(0.4, 0.5)).toBeNull();
  });

  it("says a fresh session's brief is all new: written to the cache once, never 'again'", () => {
    const e = rereadCost({ agent: "claude", tokens: 4_000, fresh: true, now, unitsPerPct: rate });
    expect(costSentence("Starting it", e, "sends")).toBe("Starting it sends about 4k tokens, under 0.1% of your 5-hour limit.");
    expect(costWhy(e, "claude")).toBe("A new conversation has nothing cached: all of it is written to the cache, at about 1.25× the input price.");
  });
});
