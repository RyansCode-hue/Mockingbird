import * as fs from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ticketOfSession, type BranchStat, type LastReply, type SessionMeter, type TicketPipeline } from "../src/shared/types";
import { FAILED, costBadge, didLine, diffBadge, logFailure, prBadge, readOf, readStore, repeatsDid, type Read } from "../src/renderer/cardBadges";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const pipeline = (over: Partial<TicketPipeline> = {}): TicketPipeline => ({ ticketId: "5101", stage: "local-test", history: [], prs: [], feedback: [], drafts: [], checks: {}, ...over });
const pr = (id: number, branch: string, at: number, target: "dev" | "main" = "dev") => ({ target, provider: "ado" as const, id, url: `https://dev.azure.com/acme/pr/${id}`, repo: "backoffice", branch, base: target, at });
const meter = (tokens: number, sharePct: number | null): SessionMeter => ({
  agent: "claude",
  tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, replies: 1 },
  window: sharePct === null ? null : { tokens, sharePct, usedPct: 38, resetsAt: NOW },
});
const agent = { shell: false };

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
  it("says which badge failed, with the reason, whatever it said before", () => {
    const b = diffBadge(readOf<BranchStat>({ error: "git merge-base: fatal: Not a valid object name origin/dev" }))!;
    expect(b).toEqual({ key: "diff", text: `diff ${FAILED}`, failed: true, title: "Couldn't read its changes against its base: git merge-base: fatal: Not a valid object name origin/dev" });
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
  it("says it couldn't read the pipelines, never a PR it read before", () => {
    const all = { "5101": pipeline({ prs: [pr(88, "5101-orgDropdowns", NOW)] }) };
    expect(prBadge(s, { all, error: "pipeline.json: EACCES: permission denied" })).toEqual({ key: "pr", text: `PR ${FAILED}`, failed: true, title: "Couldn't read the ticket pipelines: pipeline.json: EACCES: permission denied" });
  });
});

describe("the cost badge (token meters)", () => {
  it("says its tokens and its share of the 5-hour limit", () => {
    expect(costBadge(agent, meter(22_000_000, 14), null)).toMatchObject({ key: "cost", text: "22M · 14%", title: "22M tokens over its conversations\n≈14% of the current 5-hour limit, its cost on the plan" });
    expect(costBadge(agent, meter(900, null), null)).toMatchObject({ text: "900", title: "900 tokens over its conversations" });
  });
  it("is none before it has used any", () => {
    expect(costBadge(agent, undefined, null)).toBeNull();
    expect(costBadge(agent, meter(0, 1), null)).toBeNull();
  });
  it("says it couldn't read the meters, even with an old meter in hand", () => {
    expect(costBadge(agent, meter(22_000_000, 14), "SQLITE_BUSY: database is locked")).toEqual({ key: "cost", text: `cost ${FAILED}`, failed: true, title: "Couldn't read the token meters: SQLITE_BUSY: database is locked" });
  });
  it("is never on a terminal's card, whatever the meters say", () => {
    expect(costBadge({ shell: true }, meter(22_000_000, 14), null)).toBeNull();
    expect(costBadge({ shell: true }, undefined, "SQLITE_BUSY: database is locked")).toBeNull();
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
  it("is — saying why when the part of its transcript read held no message, rather than blank", () => {
    expect(didLine({ state: "ok", value: { line: null, at: null, why: "no message from the agent in the last 8 MB of its transcript" } })).toEqual({
      text: FAILED,
      title: "Couldn't find what it last said: no message from the agent in the last 8 MB of its transcript",
      failed: true,
    });
  });
});

describe("a card's terminal line beside what it did", () => {
  it("repeats it when it's the same words, past a bullet, markdown, spacing or a cut end", () => {
    expect(repeatsDid("● Org pickers now open on the org you used last.", "Org pickers now open on the org you used last.")).toBe(true);
    expect(repeatsDid("⏺ **Streams** the export   instead of loading 40k rows", "Streams the export instead of loading 40k rows. Then the tests.")).toBe(true);
    expect(repeatsDid("Org pickers now open on the o…", "Org pickers now open on the org you used last.")).toBe(true);
  });
  it("doesn't when the terminal says something else, or too little to tell", () => {
    expect(repeatsDid("✻ Running the export tests… (18s · esc to interrupt)", "Streams the export instead of loading 40k rows.")).toBe(false);
    expect(repeatsDid("● Done", "Done with the export, and the tests pass.")).toBe(false);
    expect(repeatsDid(null, "Done")).toBe(false);
    expect(repeatsDid("Done", null)).toBe(false);
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

describe("reads shared between cards", () => {
  afterEach(() => vi.useRealTimers());
  const flush = () => new Promise((r) => setTimeout(r, 0));
  it("reads a source once for every card showing it, and again only when asked", async () => {
    const store = readStore<number>("a test source");
    let n = 0;
    const load = vi.fn(async () => ++n);
    const heard: string[] = [];
    const offA = store.watch("k", { who: "s1", folder: "/w", load }, () => heard.push("a"));
    const offB = store.watch("k", { who: "s2", folder: "/w", load }, () => heard.push("b"));
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.get("k")).toEqual({ state: "ok", value: 1 });
    store.refreshWhere((folder) => folder === "/w");
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.get("k")).toEqual({ state: "ok", value: 2 });
    store.refreshWhere((folder) => folder === "/elsewhere");
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(heard).toEqual(["a", "b", "a", "b"]);
    offA();
    offB();
  });
  it("keeps a read a while after the last card showing it goes, so one drawn again reads nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const store = readStore<number>("a test source", 1000);
    const load = vi.fn(async () => 7);
    const off = store.watch("k", { who: "s1", folder: null, load }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    off();
    await vi.advanceTimersByTimeAsync(500);
    const again = store.watch("k", { who: "s1", folder: null, load }, () => {});
    expect(store.get("k")).toEqual({ state: "ok", value: 7 });
    expect(load).toHaveBeenCalledTimes(1);
    again();
    await vi.advanceTimersByTimeAsync(1500);
    expect(store.get("k")).toEqual({ state: "loading" });
  });
  it("replaces its value with a failure, said once, and takes only the newest read's answer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = readStore<string>("a flaky source");
    const answers: ((v: unknown) => void)[] = [];
    const load = () => new Promise<string | { error: string }>((r) => answers.push(r as (v: unknown) => void));
    const off = store.watch("k", { who: "s9", folder: null, load }, () => {});
    answers[0]("first");
    await flush();
    store.refresh("k");
    store.refresh("k");
    answers[2]({ error: "EIO" });
    await flush();
    answers[1]("late and stale");
    await flush();
    expect(store.get("k")).toEqual({ state: "failed", error: "EIO" });
    expect(warn.mock.calls.map((c) => c[0])).toEqual(["[mockingbird] a landscape card couldn't read a flaky source for s9: EIO"]);
    off();
    warn.mockRestore();
  });

  const NO_SESSION = { error: "Session is no longer running" } as const;
  it("reads through a card showing it now, never one that has gone, whose session main may refuse", async () => {
    const store = readStore<number>("a test source");
    const a = vi.fn(async () => 1);
    const b = vi.fn(async () => NO_SESSION as unknown as number);
    const offA = store.watch("k", { who: "a", folder: "/w", load: a }, () => {});
    await flush();
    const offB = store.watch("k", { who: "b", folder: "/w", load: b }, () => {});
    offB();
    store.refresh("k");
    await flush();
    store.refreshWhere((folder) => folder === "/w");
    await flush();
    expect(b).not.toHaveBeenCalled();
    expect(a).toHaveBeenCalledTimes(3);
    expect(store.get("k")).toEqual({ state: "ok", value: 1 });
    offA();
  });
  it("reads a failure again through another card when the card it went through goes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = readStore<number>("a test source");
    const a = vi.fn(async () => 1);
    const offA = store.watch("k", { who: "a", folder: "/w", load: a }, () => {});
    await flush();
    const offB = store.watch("k", { who: "b", folder: "/w", load: async () => NO_SESSION as unknown as number }, () => {});
    store.refresh("k");
    await flush();
    expect(store.get("k")).toEqual({ state: "failed", error: NO_SESSION.error });
    offB();
    await flush();
    expect(store.get("k")).toEqual({ state: "ok", value: 1 });
    offA();
    warn.mockRestore();
  });
  it("reads again when a read in flight through a card that then goes comes back failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = readStore<number>("a test source");
    const a = vi.fn(async () => 1);
    const heard: unknown[] = [];
    const offA = store.watch("k", { who: "a", folder: "/w", load: a }, () => heard.push(store.get("k")));
    await flush();
    let answer!: (v: unknown) => void;
    const b = vi.fn(() => new Promise<number>((r) => (answer = r as (v: unknown) => void)));
    const offB = store.watch("k", { who: "b", folder: "/w", load: b }, () => {});
    store.refresh("k");
    expect(b).toHaveBeenCalledTimes(1);
    const before = a.mock.calls.length;
    offB(); // b's session closes with its read on the way
    answer(NO_SESSION);
    await flush();
    expect(a.mock.calls.length).toBe(before + 1);
    expect(store.get("k")).toEqual({ state: "ok", value: 1 });
    // the card that stayed never saw the failure
    expect(heard.some((r) => (r as { state: string }).state === "failed")).toBe(false);
    offA();
    warn.mockRestore();
  });
  it("shows a failure that came through a card still there, or with no card left to read through", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = readStore<number>("a test source");
    let answer!: (v: unknown) => void;
    const load = () => new Promise<number>((r) => (answer = r as (v: unknown) => void));
    const off = store.watch("k", { who: "a", folder: "/w", load }, () => {});
    answer(NO_SESSION);
    await flush();
    expect(store.get("k").state).toBe("failed");
    store.refresh("k");
    off();
    answer(NO_SESSION);
    await flush();
    expect(store.get("k").state).toBe("failed");
    warn.mockRestore();
  });
  it("reads again for a card shown for another turn than its read was, and not for the same one", async () => {
    const store = readStore<string>("a test source");
    let said = "before the turn ended";
    const load = vi.fn(async () => said);
    const off = store.watch("s1", { who: "s1", folder: null, load, turn: "working|" }, () => {});
    await flush();
    off();
    said = "the turn's last message";
    const same = store.watch("s1", { who: "s1", folder: null, load, turn: "working|" }, () => {});
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    same();
    const other = store.watch("s1", { who: "s1", folder: null, load, turn: "idle|1" }, () => {});
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.get("s1")).toEqual({ state: "ok", value: "the turn's last message" });
    other();
  });
  it("reads again as a shown card's turn moves on, once for each turn", async () => {
    const store = readStore<number>("a test source");
    const load = vi.fn(async () => 1);
    const off = store.watch("s1", { who: "s1", folder: null, load, turn: "t1" }, () => {});
    await flush();
    store.turnIs("s1", "t1");
    expect(load).toHaveBeenCalledTimes(1);
    store.turnIs("s1", "t2");
    store.turnIs("s1", "t2");
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    off();
  });
  it("reads a source that changed while no card showed it when one next does, and not before", async () => {
    const store = readStore<number>("a test source");
    let n = 0;
    const load = vi.fn(async () => ++n);
    const off = store.watch("k", { who: "s1", folder: "/w", load }, () => {});
    await flush();
    off();
    store.refreshWhere((folder) => folder === "/elsewhere");
    const unchanged = store.watch("k", { who: "s1", folder: "/w", load }, () => {});
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    unchanged();
    store.refreshWhere((folder) => folder === "/w");
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    const again = store.watch("k", { who: "s1", folder: "/w", load }, () => {});
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.get("k")).toEqual({ state: "ok", value: 2 });
    again();
  });
  it("retries a failed read for a card shown again and by the safety net's refreshFailed, and only a failed one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = readStore<number>("a test source");
    const answers: (number | { error: string })[] = [{ error: "SQLITE_BUSY" }, { error: "SQLITE_BUSY" }, 5];
    const load = vi.fn(async () => answers.shift() as number);
    const off = store.watch("k", { who: "s1", folder: null, load }, () => {});
    await flush();
    expect(store.get("k").state).toBe("failed");
    off();
    const again = store.watch("k", { who: "s1", folder: null, load }, () => {});
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    store.refreshFailed();
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
    expect(store.get("k")).toEqual({ state: "ok", value: 5 });
    store.refreshFailed();
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
    again();
    warn.mockRestore();
  });
});

describe("the token meters when the index can't sync", () => {
  const index = fs.readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
  it("pushes the failure to the window, and meters:get says it, rather than leaving costs as they were", () => {
    expect(index).toContain("retryingSync(() => syncTranscripts(transcripts!), metersChanged)");
    expect(index).toContain("if (!transcripts || transcriptsProblem) throw new Error(");
  });
});
