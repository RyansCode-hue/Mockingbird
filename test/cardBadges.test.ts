import { describe, expect, it, vi } from "vitest";
import type { BranchStat, LastReply, SessionMeter, TicketPipeline } from "../src/shared/types";
import { FAILED, costBadge, didLine, diffBadge, logFailure, prBadge, readOf, ticketOfSession, type Read } from "../src/renderer/cardBadges";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const pipeline = (over: Partial<TicketPipeline> = {}): TicketPipeline => ({ ticketId: "5101", stage: "local-test", history: [], prs: [], feedback: [], drafts: [], checks: {}, ...over });
const pr = (id: number, branch: string, at: number, target: "dev" | "main" = "dev") => ({ target, provider: "ado" as const, id, url: `https://dev.azure.com/acme/pr/${id}`, repo: "backoffice", branch, base: target, at });
const meter = (tokens: number, sharePct: number | null): SessionMeter => ({
  agent: "claude",
  tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, replies: 1 },
  window: sharePct === null ? null : { tokens, sharePct, usedPct: 38, resetsAt: NOW },
});

describe("the diff badge", () => {
  it("says what changed since the fork from the area repo's base", () => {
    const b = diffBadge({ state: "ok", value: { base: "origin/dev", files: 3, insertions: 214, deletions: 38 } })!;
    expect(b).toMatchObject({ key: "diff", text: "+214 −38", lines: { add: 214, del: 38 } });
    expect(b.title).toMatch(/^3 files changed since it forked from origin\/dev: 214 lines added, 38 removed/);
  });
  it("is none while loading, without a source, or when nothing changed", () => {
    expect(diffBadge(null)).toBeNull();
    expect(diffBadge({ state: "loading" })).toBeNull();
    expect(diffBadge({ state: "ok", value: { base: "origin/dev", files: 0, insertions: 0, deletions: 0 } })).toBeNull();
  });
  it("shows — with the reason when its source fails, whatever it said before", () => {
    const b = diffBadge(readOf<BranchStat>({ error: "git merge-base: fatal: Not a valid object name origin/dev" }))!;
    expect(b).toEqual({ key: "diff", text: FAILED, failed: true, title: "Couldn't read its changes against its base: git merge-base: fatal: Not a valid object name origin/dev" });
    expect(b.lines).toBeUndefined();
  });
});

describe("the PR badge (ticket pipelines)", () => {
  const s = { ticketId: "5101", taskGroup: "5101", branch: "5101-orgDropdowns" };
  it("is the newest pull request from the session's branch for its ticket, with the ticket's stage on hover", () => {
    const all = { "5101": pipeline({ stage: "pr-dev", prs: [pr(80, "5101-orgDropdowns", NOW - 90 * MIN), pr(88, "5101-orgDropdowns", NOW - 40 * MIN), pr(91, "5101-other", NOW)] }) };
    const b = prBadge(s, { all, error: null }, NOW)!;
    expect(b.text).toBe("PR #88");
    expect(b.title).toBe("Pull request #88, 5101-orgDropdowns → dev, opened 40m ago\n#5101 is at PR to dev\nhttps://dev.azure.com/acme/pr/88");
  });
  it("finds the ticket by a group named after one", () => {
    expect(ticketOfSession({ ticketId: null, taskGroup: "5101/api" })).toBe("5101");
    expect(ticketOfSession({ ticketId: "#77", taskGroup: "5101" })).toBe("77");
    expect(ticketOfSession({ ticketId: null, taskGroup: "Backoffice" })).toBeNull();
    const all = { "5101": pipeline({ prs: [pr(88, "b", NOW)] }) };
    expect(prBadge({ ticketId: null, taskGroup: "5101/api", branch: "b" }, { all, error: null }, NOW)?.text).toBe("PR #88");
  });
  it("is none with no ticket, no branch, no pipeline or no PR from the branch", () => {
    const all = { "5101": pipeline({ prs: [pr(91, "5101-other", NOW)] }) };
    expect(prBadge({ ...s, ticketId: null, taskGroup: "Backoffice" }, { all, error: null })).toBeNull();
    expect(prBadge({ ...s, branch: null }, { all, error: null })).toBeNull();
    expect(prBadge({ ...s, ticketId: "5102", taskGroup: "5102" }, { all, error: null })).toBeNull();
    expect(prBadge(s, { all, error: null })).toBeNull();
  });
  it("shows — with the reason when the pipelines couldn't be read, never a PR it read before", () => {
    const all = { "5101": pipeline({ prs: [pr(88, "5101-orgDropdowns", NOW)] }) };
    expect(prBadge(s, { all, error: "pipeline.json: EACCES: permission denied" })).toEqual({ key: "pr", text: FAILED, failed: true, title: "Couldn't read the ticket pipelines: pipeline.json: EACCES: permission denied" });
  });
});

describe("the cost badge (token meters)", () => {
  it("says its tokens and its share of the 5-hour limit", () => {
    expect(costBadge(meter(22_000_000, 14), null)).toMatchObject({ key: "cost", text: "22M · 14%", title: "22M tokens over its conversations\n≈14% of the current 5-hour limit, its cost on the plan" });
    expect(costBadge(meter(900, null), null)).toMatchObject({ text: "900", title: "900 tokens over its conversations" });
  });
  it("is none before it has used any", () => {
    expect(costBadge(undefined, null)).toBeNull();
    expect(costBadge(meter(0, 1), null)).toBeNull();
  });
  it("shows — with the reason when the meters couldn't be read, even with an old meter in hand", () => {
    expect(costBadge(meter(22_000_000, 14), "SQLITE_BUSY: database is locked")).toEqual({ key: "cost", text: FAILED, failed: true, title: "Couldn't read the token meters: SQLITE_BUSY: database is locked" });
  });
});

describe("what it did", () => {
  it("is its latest message's first line, with when on hover", () => {
    expect(didLine({ state: "ok", value: { line: "Streams the export", at: NOW - 6 * MIN } }, NOW)).toEqual({ text: "Streams the export", title: "What it said last, 6m ago:\nStreams the export", failed: false });
  });
  it("is none before it has said anything, and — with the reason when its transcript can't be read", () => {
    expect(didLine({ state: "ok", value: { line: null, at: null } })).toBeNull();
    expect(didLine({ state: "loading" })).toBeNull();
    expect(didLine(readOf<LastReply>({ error: "the conversation index isn't available" }))).toEqual({ text: FAILED, title: "Couldn't read what it last said: the conversation index isn't available", failed: true });
  });
});

describe("a badge's source failing", () => {
  it("is a failed read, never the value read before", () => {
    const ok: Read<number> = readOf(3);
    expect(ok).toEqual({ state: "ok", value: 3 });
    expect(readOf<number>({ error: "boom" })).toEqual({ state: "failed", error: "boom" });
    // an answer whose error key is unset is a success (as isErr has it)
    expect(readOf({ error: undefined } as unknown as number)).toMatchObject({ state: "ok" });
  });
  it("is said in the console with what and whose, once for each different reason, and again after it has read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const said = new Map<string, string>();
    logFailure(said, "its changes against its base", "s1", { state: "failed", error: "fatal: bad object" });
    logFailure(said, "its changes against its base", "s1", { state: "failed", error: "fatal: bad object" });
    logFailure(said, "its changes against its base", "s2", { state: "failed", error: "fatal: bad object" });
    logFailure(said, "its changes against its base", "s1", { state: "failed", error: "EIO" });
    logFailure(said, "its changes against its base", "s1", { state: "ok", value: 1 });
    logFailure(said, "its changes against its base", "s1", { state: "loading" });
    logFailure(said, "its changes against its base", "s1", { state: "failed", error: "EIO" });
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      "[mockingbird] a landscape card couldn't read its changes against its base for s1: fatal: bad object",
      "[mockingbird] a landscape card couldn't read its changes against its base for s2: fatal: bad object",
      "[mockingbird] a landscape card couldn't read its changes against its base for s1: EIO",
      "[mockingbird] a landscape card couldn't read its changes against its base for s1: EIO",
    ]);
    warn.mockRestore();
  });
});
