import { describe, expect, it } from "vitest";
import type { PrPreflight, TranscriptHit, WorktreeEntry } from "../src/shared/types";
import { HELPDESK_CONVERSATION_WHY } from "../src/main/helpdesk";
import { cleanTree, fakeMac, HELPDESK_DIR, helpdesk, info, teammate } from "./assistantWorkFakes";

const entry = (over: Partial<WorktreeEntry> = {}): WorktreeEntry => ({
  repoPath: "/code/atticus",
  repoName: "atticus",
  path: "/code/atticus-worktrees/old-fix",
  name: "old-fix",
  branch: "old-fix",
  dirty: false,
  dirtyFiles: 0,
  ahead: 0,
  behind: 0,
  ageDays: 12,
  inUse: false,
  legacy: false,
  ...over,
});

const preflight = (over: Partial<PrPreflight> = {}): PrPreflight => ({
  branch: "5038-filter-orgs",
  base: "dev",
  bases: ["dev"],
  dirtyFiles: 0,
  commits: 3,
  remote: { provider: "ado", repo: "Atticus/atticus" },
  docs: null,
  existing: null,
  branchProblem: null,
  ...over,
});

describe("git_status, branch_stat and pr_status", () => {
  it("give each session's folder and every worktree, compactly, saying what couldn't be read", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "api", cwd: "/w/a" }), info("a2", { cwd: "/w/a" }), info("b1", { title: "web", cwd: "/w/b" }), helpdesk());
    mac.remote.push(teammate());
    mac.trees.set("/w/a", cleanTree({ branch: "fix", dirty: true, dirtyFiles: 2, ahead: 1, upstream: "origin/dev" }));
    mac.deps.worktrees = async () => [entry(), entry({ path: "/code/atticus-worktrees/bad", error: "not a git repository\nmore" })];
    const out = JSON.parse((await mac.tool("git_status").run({})).text);
    expect(out.sessions).toEqual([
      { id: "a1", title: "api", branch: "fix", upstream: "origin/dev", dirtyFiles: 2, ahead: 1, behind: 0 },
      { id: "b1", title: "web", error: expect.stringContaining("its git state couldn't be read") },
    ]);
    expect(out.worktrees.list).toEqual([
      { repo: "atticus", path: "/code/atticus-worktrees/old-fix", branch: "old-fix", dirtyFiles: 0, ahead: 0, behind: 0, ageDays: 12 },
      { repo: "atticus", path: "/code/atticus-worktrees/bad", error: "not a git repository more" },
    ]);
    expect(JSON.parse((await mac.tool("git_status").run({ session: "a1" })).text)).toMatchObject({ session: "a1", branch: "fix", dirtyFiles: 2 });
    await expect(mac.tool("git_status").run({ session: "r~nick~n1" })).rejects.toThrow("only its owner can read its git state");
    await expect(mac.tool("git_status").run({ session: "h1" })).rejects.toThrow("It isn't in a repository");
  });

  it("branch_stat and pr_status read a session's branch, never a teammate's", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { branch: "fix" }));
    mac.remote.push(teammate());
    mac.deps.prStatus = async () => ({ branch: "fix", pr: { id: 9, url: "https://example.invalid/pr/9", title: "Fix\nlogin", base: "dev", state: "approved", conflicts: false, reviews: ["Sam: approved"] }, at: 1 });
    expect(JSON.parse((await mac.tool("branch_stat").run({ session: "a1" })).text)).toEqual({ session: "a1", branch: "fix", base: "origin/dev", files: 3, insertions: 10, deletions: 2 });
    expect(JSON.parse((await mac.tool("pr_status").run({ session: "a1" })).text)).toEqual({
      session: "a1",
      branch: "fix",
      pr: { id: 9, url: "https://example.invalid/pr/9", title: "Fix login", base: "dev", state: "approved", conflicts: false, reviews: ["Sam: approved"] },
    });
    await expect(mac.tool("pr_status").run({ session: "r~nick~n1" })).rejects.toThrow("only its owner can read its pull request");
  });
});

describe("cleanup_worktree", () => {
  it("removes a worktree no session runs in, its card in the danger color saying what's lost; refused once it's changed since the card", async () => {
    const mac = fakeMac();
    const path = "/code/atticus-worktrees/old-fix";
    mac.deps.worktrees = async () => [entry({ dirty: true, dirtyFiles: 3, ahead: 2 })];
    mac.trees.set(path, cleanTree({ branch: "old-fix", dirty: true, dirtyFiles: 3, ahead: 2 }));
    const t = mac.tool("cleanup_worktree");
    const a = { path };
    expect(await t.check!(a)).toBeNull();
    expect(await t.card!(a)).toEqual({
      title: "Remove the worktree old-fix",
      detail: "Deletes the folder /code/atticus-worktrees/old-fix. Its branch, old-fix, is kept with its commits.",
      warnings: ["3 files' uncommitted changes are lost with it", "2 commits aren't pushed: they stay on the branch, not on origin"],
      danger: true,
    });
    // a file written since the card: what it said would be lost isn't all there is any more
    mac.trees.set(path, cleanTree({ branch: "old-fix", dirty: true, dirtyFiles: 4, ahead: 2 }));
    expect(await t.check!(a)).toBe("It has changed since this card was made: ask again to see what removing it would lose now");
    mac.trees.set(path, cleanTree({ branch: "old-fix", dirty: true, dirtyFiles: 3, ahead: 2 }));
    expect(await t.check!(a)).toBeNull();
    expect((await t.run(a)).text).toBe("Removed the worktree /code/atticus-worktrees/old-fix; its branch, old-fix, is kept.");
    expect(mac.did).toEqual(["remove /code/atticus /code/atticus-worktrees/old-fix"]);
  });

  it("refuses a path that isn't a listed worktree, one a session runs in, and one git can't read", async () => {
    const mac = fakeMac();
    mac.deps.worktrees = async () => [entry({ inUse: true }), entry({ path: "/x/bad", error: "not a git repository" })];
    const t = mac.tool("cleanup_worktree");
    expect(await t.check!({ path: "/Users/me/.ssh" })).toContain("There's no worktree at /Users/me/.ssh");
    expect(await t.check!({ path: "/code/atticus-worktrees/old-fix" })).toBe("A session runs in it: close that session first");
    expect(await t.check!({ path: "/x/bad" })).toContain("It isn't a worktree git can read");
    expect(mac.did).toEqual([]);
  });
});

describe("push_branch", () => {
  it("pushes the branch its card named, never forced, warning of uncommitted files and being behind", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "api", branch: "fix", cwd: "/w/a" }));
    mac.trees.set("/w/a", cleanTree({ branch: "fix", dirty: true, dirtyFiles: 1, behind: 2, upstream: "origin/fix" }));
    const t = mac.tool("push_branch");
    const a = { session: "a1" };
    expect(await t.check!(a)).toBeNull();
    expect(await t.card!(a)).toEqual({
      title: "Push fix from “api” · a1 · atticus",
      detail: "Pushes fix's commits to origin, a plain push that's never forced.",
      warnings: ["1 file has uncommitted changes, which aren't pushed", "It's 2 commits behind origin/fix: git refuses the push until it's brought up to date"],
    });
    // moved to another branch since: main pushes nothing off the one the card named
    mac.trees.set("/w/a", cleanTree({ branch: "other" }));
    await t.run(a);
    expect(mac.did).toEqual(["push a1 fix"]);
  });

  it("refuses a detached HEAD, a room push that waits for the branch to be named, a teammate's and the Helpdesk workspace", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { cwd: "/w/a" }), helpdesk());
    mac.remote.push(teammate());
    mac.trees.set("/w/a", cleanTree({ branch: "HEAD" }));
    const t = mac.tool("push_branch");
    expect(await t.check!({ session: "a1" })).toBe("It isn't on a branch (a detached HEAD): there's nothing to push to");
    mac.trees.set("/w/a", cleanTree({ branch: "dev" }));
    mac.deps.pushAsk = async () => ({ branch: "dev", why: "dev is a base branch's name" });
    expect(await t.check!({ session: "a1" })).toBe("dev is a base branch's name: push it from Source Control, which asks you to name the branch");
    expect(await t.check!({ session: "r~nick~n1" })).toBe("“Nick's api” is Nick's session: only its owner can push its branch");
    expect(await t.check!({ session: "h1" })).toBe("It isn't in a repository");
    expect(mac.did).toEqual([]);
  });
});

describe("open_pr", () => {
  it("opens a ticket's pull request through the pipeline's path, into the base its preflight found", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "Filter orgs", ticketId: "5038", ticketTitle: "Filter orgs", branch: "5038-filter-orgs" }));
    const asked: unknown[] = [];
    mac.deps.prPreflight = async (id, ticket, target) => (asked.push([id, ticket, target]), preflight());
    mac.deps.openPr = async (id, ticket, req) => (asked.push([id, ticket, req]), { url: "https://example.invalid/pr/7" });
    const t = mac.tool("open_pr");
    const a = { session: "a1", title: "Filter orgs by state", description: "## Summary\nFilters." };
    expect(await t.check!(a)).toBeNull();
    expect(await t.card!(a)).toEqual({
      title: "Open a pull request for #5038 from “Filter orgs” · a1 · atticus",
      detail: "Pushes 5038-filter-orgs to origin (never forced), then opens a pull request from it into dev on Azure DevOps (Atticus/atticus), linked to #5038: “Filter orgs by state”. Its description, below, is published with it.",
      body: "## Summary\nFilters.",
      warnings: ["3 commits go in it"],
    });
    expect((await t.run(a)).text).toBe("Opened a pull request for #5038: https://example.invalid/pr/7");
    expect(asked).toEqual([
      ["a1", "5038", "dev"],
      ["a1", "5038", { target: "dev", base: "dev", title: "Filter orgs by state", description: "## Summary\nFilters.", ticketTitle: "Filter orgs" }],
    ]);
  });

  it("offers it only where the pipeline's path works, saying why otherwise", async () => {
    const mac = fakeMac();
    mac.own.push(info("n1", { title: "no ticket", taskGroup: "atticus" }), info("k1", { ticketId: "5038" }), info("a1", { ticketId: "5038" }), info("g1", { taskGroup: "5110/api" }));
    mac.taken.add("k1");
    const t = mac.tool("open_pr");
    const check = (session: string) => t.check!({ session, title: "x" });
    expect(await check("n1")).toContain("“no ticket” isn't on a ticket: Mockingbird opens a pull request from a ticket's pipeline");
    expect(await check("k1")).toBe("“k1” continues on Nick's laptop — take it back rather than opening a pull request from this copy");
    for (const [pre, why] of [
      [{ dirtyFiles: 2 }, "Commit or stash its 2 uncommitted files first: they wouldn't be in the pull request"],
      [{ existing: { id: 1, url: "https://example.invalid/pr/1" } }, "A pull request is already open from 5038-filter-orgs: https://example.invalid/pr/1"],
      [{ recordedBranch: "5038-x" }, "It's on 5038-filter-orgs, not 5038-x, the branch it was made on: open it from the ticket's PR form, which asks you to name the branch"],
      [{ commits: 0 }, "5038-filter-orgs has no commits that aren't on dev"],
      [{ base: null }, "origin has no dev branch for it to merge into"],
    ] as const) {
      mac.deps.prPreflight = async () => preflight(pre as Partial<PrPreflight>);
      expect(await check("a1")).toBe(why);
    }
    // a group named for a ticket is on that ticket
    let ticket = "";
    mac.deps.prPreflight = async (_id, t2) => ((ticket = t2), preflight());
    expect(await check("g1")).toBeNull();
    expect(ticket).toBe("5110");
    expect(mac.did).toEqual([]);
  });
});

// ---- diagnose --------------------------------------------------------------------------------------

describe("session_detail", () => {
  it("says why it's stuck or exited, with the last lines an exited pane showed, ANSI and secrets taken out", async () => {
    const mac = fakeMac();
    mac.own.push(info("d1", { title: "api", status: "dead", exitCode: 1, model: "opus", permissionMode: "plan", finishedAt: Date.UTC(2026, 10, 16, 12) }));
    mac.deps.output = () => "\x1b[31mError: boom\x1b[0m\r\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz123456\r\n$ \r\n";
    const out = JSON.parse((await mac.tool("session_detail").run({ session: "d1" })).text);
    expect(out).toMatchObject({ id: "d1", title: "api", agent: "claude", state: "dead", exitCode: 1, model: "opus", permissionMode: "plan", finishedAt: "2026-11-16T12:00:00.000Z" });
    expect(out.output.lastLines).toMatch(/^Error: boom\nAuthorization: Bearer .*redacted.*\n\$\s*$/);
    expect(JSON.stringify(out)).not.toContain("abcdefghijklmnop");
  });

  it("reads a working one's quiet and silent hooks, and never the Helpdesk workspace's or a teammate's output", async () => {
    const mac = fakeMac();
    mac.own.push(info("s1", { status: "working", stalledSince: Date.UTC(2026, 10, 16, 14), hooksSilent: true }), helpdesk("h1", { status: "dead", exitCode: 0 }));
    mac.closed.push(helpdesk("h2"));
    mac.remote.push(teammate("r~nick~n1", { status: "dead" }));
    const s1 = JSON.parse((await mac.tool("session_detail").run({ session: "s1" })).text);
    expect(s1).toMatchObject({ state: "working", quietSince: "2026-11-16T14:00:00.000Z", hooksSilent: expect.stringContaining("its status is a guess") });
    expect(s1.output).toBeUndefined();
    for (const id of ["h1", "h2"]) {
      const h = JSON.parse((await mac.tool("session_detail").run({ session: id })).text);
      expect(h.output, id).toEqual({ refused: HELPDESK_CONVERSATION_WHY });
    }
    const n = JSON.parse((await mac.tool("session_detail").run({ session: "r~nick~n1" })).text);
    expect(n).toMatchObject({ mine: false, owner: "Nick", status: "dead", output: { refused: "“Nick's api” is Nick's session: only its owner can read its output" } });
    expect(mac.did).toEqual([]);
  });
});

describe("usage", () => {
  it("gives the plan's limits, and says when the meters can't be read", async () => {
    const mac = fakeMac();
    mac.deps.usage = () => ({ claude: { agent: "claude", plan: "Max", limits: [{ label: "5-hour limit", window: "5h", usedPct: 42, resetsAt: Date.UTC(2026, 10, 16, 15) }], at: Date.UTC(2026, 10, 16, 12) }, codex: null });
    const out = JSON.parse((await mac.tool("usage").run({})).text);
    expect(out.plan).toEqual({ claude: { plan: "Max", limits: [{ label: "5-hour limit", usedPct: 42, resetsAt: "2026-11-16T15:00:00.000Z" }], at: "2026-11-16T12:00:00.000Z" }, codex: null });
    expect(out.meters).toEqual({ error: "The token meters couldn't be read: the conversation index isn't available" });
    mac.own.push(info("a1", { title: "api" }));
    const tokens = { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, replies: 2 };
    mac.deps.meters = () => ({ sessions: { a1: { agent: "claude", tokens, window: { tokens: 115, sharePct: 3, usedPct: 42, resetsAt: 0 } } }, today: { claude: tokens }, at: Date.UTC(2026, 10, 16, 12) });
    expect(JSON.parse((await mac.tool("usage").run({})).text).meters).toEqual({
      today: { claude: { tokens: 115, replies: 2 } },
      sessionsByWindowShare: [{ id: "a1", title: "api", agent: "claude", tokens: 115, sharePct: 3 }],
      groups: [],
      at: "2026-11-16T12:00:00.000Z",
    });
  });
});

describe("who_touched", () => {
  it("finds a file in overlaps, turns' changes and conversations, leaving out the Helpdesk workspace's", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "api" }), info("b1", { title: "web" }), helpdesk("h1", { repoPath: "/code/x" }));
    mac.closed.push(helpdesk("h2"));
    mac.deps.overlaps = () => ({
      bySession: { a1: [{ other: "b1", otherTitle: "web", otherBranch: "ui", files: ["src/main/index.ts", "README.md"] }, { other: "r1", otherTitle: "Export", otherBranch: "feature/12", files: ["src/main/index.ts"], teammate: { id: "nick", name: "Nick", roomId: "R1" } }] },
      unread: {},
    });
    const asked: string[] = [];
    mac.deps.turnFiles = async (id, since) => (asked.push(`${id} ${since}`), id === "b1" ? ["src/main/index.ts"] : ["other.ts"]);
    const hit = (over: Partial<TranscriptHit>): TranscriptHit => ({ id: "c1", agent: "claude", cwd: "/w/a1", title: "Fix index", started: 0, updated: 0, model: null, snippet: "…index.ts…", at: Date.UTC(2026, 10, 16, 9), kind: "tool", open: { how: "pane", sessionId: "a1" }, ...over });
    mac.deps.searchTranscripts = () => [hit({}), hit({ id: "c2", cwd: `${HELPDESK_DIR()}/notes`, title: "admin console" }), hit({ id: "c3", cwd: "/w/other", title: "via helpdesk", open: { how: "previous", sessionId: "h2" } }), hit({ id: "c4", title: "old", open: { how: "resume" } })];
    const out = JSON.parse((await mac.tool("who_touched").run({ file: "index.ts" })).text);
    expect(out.overlaps).toEqual([
      { session: "a1", title: "api", with: { session: "b1", title: "web", branch: "ui" }, files: ["src/main/index.ts"] },
      { session: "a1", title: "api", with: { teammate: "Nick", branch: "feature/12" }, files: ["src/main/index.ts"] },
    ]);
    expect(out.turns).toEqual([{ session: "b1", title: "web", files: ["src/main/index.ts"] }]);
    expect(asked).toEqual(["a1 first", "b1 first"]);
    expect(out.conversations).toEqual([
      { title: "Fix index", agent: "claude", at: "2026-11-16T09:00:00.000Z", kind: "tool", session: "a1", open: true },
      { title: "old", agent: "claude", at: "2026-11-16T09:00:00.000Z", kind: "tool" },
    ]);
    expect(JSON.stringify(out)).not.toContain("admin console");
    expect(JSON.stringify(out)).not.toContain("snippet");
  });
});
