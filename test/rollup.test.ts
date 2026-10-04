import { describe, expect, it } from "vitest";
import { activeMs, composeRollup, GAP_MS, ticketOf, weekBounds } from "../src/main/rollup";
import type { TicketPipeline } from "../src/shared/types";

const min = 60_000;
const mon = new Date(2026, 8, 28, 9, 0); // Monday Sep 28, 2026, 09:00

describe("weekly rollup", () => {
  it("counts active time as stretches of messages under 10 minutes apart", () => {
    const t0 = mon.getTime();
    expect(activeMs([t0])).toBe(min); // one message: a minute
    expect(activeMs([t0, t0 + 5 * min, t0 + 9 * min])).toBe(min + 9 * min);
    expect(activeMs([t0, t0 + GAP_MS + 1])).toBe(2 * min); // a long gap starts a new stretch
  });
  it("knows a week runs Monday to Monday", () => {
    const { start, end } = weekBounds(new Date(2026, 9, 1, 15)); // Thursday Oct 1
    expect([start.getMonth(), start.getDate(), start.getDay(), start.getHours()]).toEqual([8, 28, 1, 0]);
    expect([end.getMonth(), end.getDate()]).toEqual([9, 5]);
    expect(weekBounds(new Date(2026, 9, 4), 1).start.getDate()).toBe(21); // a Sunday's week, and the one before
  });
  it("finds a conversation's ticket from its session or a ticket-named folder", () => {
    const sessions = [
      { cwd: "/w/a", repoPath: "/c/backoffice", ticketId: "5101", ticketTitle: "Org dropdowns", taskGroup: "5101" },
      { cwd: "/w/b", repoPath: "/c/portal", ticketId: null, ticketTitle: null, taskGroup: "5102/api" },
    ];
    expect(ticketOf("/w/a", sessions)).toEqual({ id: "5101", title: "Org dropdowns" });
    expect(ticketOf("/w/b", sessions)).toEqual({ id: "5102", title: null });
    expect(ticketOf("/x/worktrees/portal/5207-fix-login", sessions)).toEqual({ id: "5207", title: null });
    expect(ticketOf("/Users/me/Code/Mockingbird", sessions)).toBeNull();
  });
  it("writes the week: totals, each ticket's time, stages and PRs, and work outside tickets", () => {
    const { start, end } = weekBounds(mon);
    const t = (day: number, h: number, m = 0) => new Date(2026, 8, 28 + day, h, m).getTime();
    const pipeline: TicketPipeline = {
      ticketId: "5101",
      title: "Org dropdowns",
      stage: "pr-dev",
      history: [{ at: t(0, 9), stage: "coding" }, { at: t(2, 16), stage: "pr-dev" }, { at: t(-10, 9), stage: "ba" }],
      prs: [{ target: "dev", provider: "ado", id: 88, url: "https://dev.azure.com/o/p/_git/r/pullrequest/88", repo: "p/r", branch: "5101-org", base: "dev", at: t(2, 16) }],
      feedback: [],
      drafts: [],
      checks: {},
    };
    const md = composeRollup({
      start,
      end,
      activity: [
        { conv: "c1", agent: "claude", cwd: "/w/a", title: "Add the org dropdown", times: [t(0, 9), t(0, 9, 5), t(1, 14)] },
        { conv: "c2", agent: "codex", cwd: "/Users/me/Code/Mockingbird", title: "Fix the build", times: [t(3, 10), t(3, 10, 8)] },
        { conv: "c3", agent: "claude", cwd: "/w/a", title: "last week", times: [t(-3, 10)] },
      ],
      usage: [
        { conv: "c1", agent: "claude", input: 1000, output: 500, cacheRead: 1_000_000, cacheWrite: 0 },
        { conv: "c2", agent: "codex", input: 2000, output: 0, cacheRead: 0, cacheWrite: 0 },
      ],
      sessions: [{ cwd: "/w/a", repoPath: "/c/backoffice", ticketId: "5101", ticketTitle: "Org dropdowns", taskGroup: "5101" }],
      pipelines: { "5101": pipeline },
      digests: ["2026-09-28.md", "notes.txt"],
      generated: new Date(2026, 9, 2),
    });
    expect(md).toMatch(/^# Weekly rollup — Sep 28 – Oct 4, 2026/);
    expect(md).toContain("- Active time: 16m across 2 conversations (Codex 9m, Claude 7m)");
    expect(md).toContain("- Tokens: 4k (Codex 2k, Claude 2k), plus 1.0M read from cache");
    expect(md).toContain("- Tickets: 1 worked on, 1 moved stage, 1 pull request opened");
    expect(md).toContain("### #5101 Org dropdowns — now: PR to dev");
    expect(md).toContain("- Time: 7m (Mon 6m, Tue 1m)");
    expect(md).toContain("- Stages: Coding (Mon) → PR to dev (Wed)");
    expect(md).toContain("- Pull request: https://dev.azure.com/o/p/_git/r/pullrequest/88 (5101-org → dev)");
    expect(md).toContain('- Claude: "Add the org dropdown" — 7m');
    expect(md).toContain("### Mockingbird — 9m");
    expect(md).toContain("- Mon: session-digests/2026-09-28.md");
    expect(md).not.toContain("last week");
    expect(md).not.toContain("notes.txt");
  });
});
