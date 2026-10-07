import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { git, makeRepo, tempDir, write } from "./helpers";
import { loopbackRoom, until, type LoopbackMember } from "../src/main/team/loopback";
import { applyPlanOp, planOfRoom } from "../src/main/team/board";
import { publishPlan, planFilesAt, PLAN_REF, type PlanRender } from "../src/main/team/planGit";
import { PlanService, planToolCall, roomAgentContext, type PlanServiceDeps } from "../src/main/team/planService";
import { changedFiles, mergeOverlaps, overlaps, teammateOverlaps } from "../src/main/conflicts";
import { claimConflicts, claimsFile, claimsRoom, renderPlanMarkdown, type ClaimsFile, type PlanWarningNotice } from "../src/shared/team/plan";
import type { SessionInfo } from "../src/shared/types";

/** A repository on origin (a local bare one), and a clone of it for each name. */
function origin(names: string[]) {
  const seed = makeRepo({ "README.md": "hello\n", "src/api/x.ts": "x\n", "src/ui/y.ts": "y\n" }, "seed");
  const base = tempDir("origin");
  const bare = path.join(base, "origin.git");
  git(base, "clone", "-q", "--bare", seed, bare);
  const clones: Record<string, string> = {};
  for (const n of names) {
    clones[n] = path.join(base, n);
    git(base, "clone", "-q", bare, clones[n]);
  }
  return { bare, clones };
}

const ROOM = "R".repeat(22);
const fixed = (files: Record<string, string>, message = "Plan: test"): (() => PlanRender) => () => ({ files, message });
const opts = { roomId: ROOM, author: { name: "Ryan" } };

/** A room member's board rendered as the plan branch holds it. */
const renderOf = (m: LoopbackMember, roomId: string, calls?: { n: number }) => (): PlanRender => {
  if (calls) calls.n++;
  const room = m.team.room(roomId)!;
  return { files: { "plan.md": renderPlanMarkdown(room, planOfRoom(room)), "claims.json": `${JSON.stringify(claimsFile([claimsRoom(room, planOfRoom(room))]))}\n` }, message: `Plan by ${m.name}` };
};

describe("the plan branch", () => {
  it("commits plan.md and claims.json to mockingbird/plan and pushes, leaving the checkout, index and branch alone", async () => {
    const { bare, clones } = origin(["ryan"]);
    const repo = clones.ryan;
    write(repo, { "README.md": "edited, not committed\n", "staged.txt": "staged\n", "loose.txt": "untracked\n" });
    git(repo, "add", "staged.txt");
    const before = { head: git(repo, "rev-parse", "HEAD"), branch: git(repo, "symbolic-ref", "HEAD"), status: git(repo, "status", "--porcelain"), staged: git(repo, "diff", "--cached", "--name-only") };

    const r = await publishPlan(repo, fixed({ "plan.md": "# Plan\n", "claims.json": "{}\n" }), opts);
    expect(r).toMatchObject({ committed: true, pushed: true, retries: 0 });
    expect({ head: git(repo, "rev-parse", "HEAD"), branch: git(repo, "symbolic-ref", "HEAD"), status: git(repo, "status", "--porcelain"), staged: git(repo, "diff", "--cached", "--name-only") }).toEqual(before);
    expect(git(bare, "rev-parse", "mockingbird/plan")).toBe(r.commit);
    expect(git(repo, "rev-parse", PLAN_REF)).toBe(r.commit);
    expect(git(repo, "ls-tree", "--name-only", r.commit).split("\n")).toEqual(["claims.json", "plan.md"]);
    expect(git(repo, "log", "-1", "--format=%s", r.commit)).toBe("Plan: test");
    expect(git(repo, "rev-list", "--count", r.commit)).toBe("1"); // its own history, not the project's

    const again = await publishPlan(repo, fixed({ "plan.md": "# Plan\n", "claims.json": "{}\n" }), opts);
    expect(again).toMatchObject({ commit: r.commit, committed: false, pushed: true });
    const next = await publishPlan(repo, fixed({ "plan.md": "# Plan v2\n", "claims.json": "{}\n" }), opts);
    expect(git(repo, "rev-parse", `${next.commit}^`)).toBe(r.commit);
    expect(await planFilesAt(repo)).toEqual({ "plan.md": "# Plan v2\n", "claims.json": "{}\n" });
  });

  it("commits locally, and says it didn't push, in a clone without origin", async () => {
    const repo = makeRepo();
    const r = await publishPlan(repo, fixed({ "plan.md": "x\n" }), opts);
    expect(r).toMatchObject({ committed: true, pushed: false });
    expect(git(repo, "rev-parse", PLAN_REF)).toBe(r.commit);
  });

  it("when a teammate pushed first, renders again from the room log and pushes on top — never a text merge or a force", async () => {
    const { members, roomId, net } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("t") });
    const [ryan, nick] = members;
    const { bare, clones } = origin(["ryan", "nick"]);
    const o = { roomId, author: { name: "x" } };
    net.setOnline(nick.id, false);
    await until(() => ryan.team.presence(roomId).length === 0, "Nick to drop");
    applyPlanOp(ryan.team, roomId, { kind: "create", title: "Ryan's package" });
    applyPlanOp(nick.team, roomId, { kind: "create", title: "Nick's package" });
    const first = await publishPlan(clones.ryan, renderOf(ryan, roomId), o);

    // Nick's push races Ryan's next one: Ryan lands in between Nick's fetch and push
    let ryanSecond = "";
    const calls = { n: 0 };
    const r = await publishPlan(clones.nick, renderOf(nick, roomId, calls), {
      ...o,
      beforePush: async () => {
        if (ryanSecond) return;
        applyPlanOp(ryan.team, roomId, { kind: "create", title: "Ryan's second" });
        ryanSecond = (await publishPlan(clones.ryan, renderOf(ryan, roomId), o)).commit;
      },
    });
    expect(r.retries).toBe(1);
    expect(calls.n).toBe(2);
    expect(git(bare, "rev-parse", "mockingbird/plan")).toBe(r.commit);
    expect(git(bare, "rev-parse", `${r.commit}^`)).toBe(ryanSecond);
    expect(git(bare, "rev-parse", `${ryanSecond}^`)).toBe(first.commit);
    // the newest commit is Nick's log as it stands, not a merge of the two files
    expect(git(bare, "show", `${r.commit}:plan.md`)).toBe(renderOf(nick, roomId)().files["plan.md"].trimEnd());

    // once the logs merge, both render the same board: one more commit, then nothing to do
    net.setOnline(nick.id, true);
    await until(() => ryan.team.room(roomId)!.events === nick.team.room(roomId)!.events && planOfRoom(nick.team.room(roomId)!).packages.length === 3, "the logs to merge");
    const merged = await publishPlan(clones.ryan, renderOf(ryan, roomId), o);
    expect(merged.committed).toBe(true);
    const none = await publishPlan(clones.nick, renderOf(nick, roomId), o);
    expect(none).toMatchObject({ commit: merged.commit, committed: false });
    for (const title of ["Ryan's package", "Nick's package", "Ryan's second"]) expect(git(bare, "show", "mockingbird/plan:plan.md")).toContain(title);
    expect(git(bare, "rev-list", "--count", "mockingbird/plan")).toBe("4");
  });

  it("won't move the branch while it's checked out, nor overwrite another room's plan", async () => {
    const { clones } = origin(["ryan"]);
    const repo = clones.ryan;
    await publishPlan(repo, fixed({ "plan.md": "a\n", "claims.json": JSON.stringify({ rooms: [{ roomId: "O".repeat(22) }] }) }), { ...opts, roomId: "O".repeat(22) });
    await expect(publishPlan(repo, fixed({ "plan.md": "b\n" }), opts)).rejects.toThrow(/holds another team room's plan/);
    const wt = path.join(path.dirname(repo), "plan-wt");
    git(repo, "worktree", "add", "-q", wt, "mockingbird/plan");
    await expect(publishPlan(repo, fixed({ "plan.md": "b\n" }), { ...opts, roomId: "O".repeat(22) })).rejects.toThrow(/checked out in/);
  });
});

// ---- the service, with two members' real clones ----------------------------------------------

let services: PlanService[] = [];
afterEach(() => {
  for (const s of services) s.stop();
  services = [];
});

const session = (id: string, over: Partial<SessionInfo>): SessionInfo =>
  ({ id, title: id, repoPath: null, cwd: "/", branch: null, ticketId: null, ticketTitle: null, taskGroup: "5110", status: "idle", createdAt: 0, kind: "work", extraDirs: [], waitingReason: null, waitingSince: null, agent: "claude", ...over }) as SessionInfo;

function service(m: LoopbackMember, roomId: string, clone: string, sessions: () => SessionInfo[], extra: Partial<PlanServiceDeps> = {}) {
  const out = { emitted: [] as [string, any][], logs: [] as string[], notes: [] as string[], overlaps: 0 };
  const svc = new PlanService({
    roomGroups: () => [{ roomId, groupKey: "5110" }],
    sessions,
    knownRepos: () => [clone],
    emit: (channel, payload) => out.emitted.push([channel, payload]),
    log: (context, err) => {
      const msg = `${context}: ${err instanceof Error ? err.message : String(err)}`;
      out.logs.push(msg);
      return msg;
    },
    notify: (title, body) => out.notes.push(`${title}: ${body}`),
    overlapsChanged: () => out.overlaps++,
    author: () => ({ name: m.name }),
    copiesFile: path.join(tempDir("copies"), "plan-copies.json"),
    timing: { ownSyncMs: 0, repairSyncMs: 40, pollMs: 30, fetchMs: 60_000 },
    ...extra,
  });
  svc.start(m.team);
  services.push(svc);
  return Object.assign(out, { svc });
}

describe("the plan service", () => {
  it("keeps origin's plan branch and every worktree's read-only copy current, git-ignored, with teammates' claims", async () => {
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("t") });
    const [ryan, nick] = members;
    const { bare, clones } = origin(["ryan", "nick"]);
    const wtA = path.join(path.dirname(clones.ryan), "ryan-wt-a");
    git(clones.ryan, "worktree", "add", "-q", "-b", "ryan-feature", wtA);
    const r = service(ryan, roomId, clones.ryan, () => []);
    const n = service(nick, roomId, clones.nick, () => []);

    r.svc.apply(roomId, { kind: "repo", origin: bare, name: "backoffice" });
    const { pkg } = r.svc.apply(roomId, { kind: "create", title: "Donor API", paths: ["src/api"] });
    r.svc.apply(roomId, { kind: "claim", id: pkg! });
    await until(() => planOfRoom(nick.team.room(roomId)!).packages[0]?.owner === ryan.id, "Nick to see the claim");
    await r.svc.idle();
    await until(() => {
      try {
        return git(bare, "show", "mockingbird/plan:claims.json").includes(`"id": "${ryan.id}"`);
      } catch {
        return false;
      }
    }, "origin's plan to have the claim");
    await n.svc.idle();
    await r.svc.idle();
    const commits = git(bare, "rev-list", "--count", "mockingbird/plan");
    expect(r.svc.view(roomId).git).toMatchObject({ state: "synced", clones: [fs.realpathSync(clones.ryan) === clones.ryan ? clones.ryan : expect.any(String)], copies: 2 });

    // Ryan's checkouts: the copy is there, read-only, and invisible to git
    for (const wt of [clones.ryan, wtA]) {
      const plan = path.join(wt, ".mockingbird", "plan.md");
      expect(fs.readFileSync(plan, "utf8")).toContain("Donor API");
      expect(fs.statSync(plan).mode & 0o777).toBe(0o444);
      expect(fs.readFileSync(path.join(wt, ".mockingbird", "agent-context.md"), "utf8")).toContain(path.join(wt, ".mockingbird", "plan.md"));
      expect(git(wt, "status", "--porcelain")).toBe("");
    }
    expect(fs.readFileSync(path.join(clones.ryan, ".git", "info", "exclude"), "utf8")).toContain("/.mockingbird/\n");
    // Ryan's own claim never warns Ryan; Nick's copy names Ryan as a teammate
    const ryanCopy = JSON.parse(fs.readFileSync(path.join(wtA, ".mockingbird", "claims.json"), "utf8")) as ClaimsFile;
    expect(claimConflicts(ryanCopy, "src/api/x.ts")).toEqual([]);
    await until(() => fs.existsSync(path.join(clones.nick, ".mockingbird", "claims.json")), "Nick's copy");
    const nickCopy = JSON.parse(fs.readFileSync(path.join(clones.nick, ".mockingbird", "claims.json"), "utf8")) as ClaimsFile;
    expect(nickCopy.self).toBe(nick.id);
    expect(claimConflicts(nickCopy, "src/api/x.ts")).toMatchObject([{ pkg, title: "Donor API", owner: { id: ryan.id, name: "Ryan" } }]);

    // Nick's check after Ryan's change found the branch current: no commit of its own
    await new Promise((res) => setTimeout(res, 120));
    await n.svc.idle();
    expect(git(bare, "rev-list", "--count", "mockingbird/plan")).toBe(commits);
    expect(n.svc.view(roomId).git.state).toBe("synced");
    expect(r.logs.concat(n.logs)).toEqual([]);
    expect(r.emitted.some(([c, v]) => c === "plan:changed" && v.plan.packages.length === 1)).toBe(true);

    // a worktree that's gone from the repo loses nothing, a new one gets its copy
    const wtB = path.join(path.dirname(clones.ryan), "ryan-wt-b");
    git(clones.ryan, "worktree", "add", "-q", "-b", "ryan-other", wtB);
    r.svc.apply(roomId, { kind: "status", id: pkg!, status: "in-progress" });
    await until(() => fs.existsSync(path.join(wtB, ".mockingbird", "plan.md")) && fs.readFileSync(path.join(wtB, ".mockingbird", "plan.md"), "utf8").includes("in progress"), "the new worktree's copy");
  });

  it("shows a teammate's pushed branch next to a worktree here that changes the same file", async () => {
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("t") });
    const [ryan, nick] = members;
    const { bare, clones } = origin(["ryan", "nick"]);
    // Nick's work, pushed
    git(clones.nick, "checkout", "-q", "-b", "nick-donor");
    write(clones.nick, { "src/api/x.ts": "nick's x\n", "src/api/z.ts": "z\n" });
    git(clones.nick, "add", "-A");
    git(clones.nick, "commit", "-q", "-m", "nick");
    git(clones.nick, "push", "-q", "origin", "nick-donor");
    // Ryan's worktree changes x too, and y
    const wtA = path.join(path.dirname(clones.ryan), "ryan-wt");
    git(clones.ryan, "worktree", "add", "-q", "-b", "ryan-feature", wtA);
    write(wtA, { "src/api/x.ts": "ryan's x\n", "src/ui/y.ts": "ryan's y\n" });

    const r = service(ryan, roomId, clones.ryan, () => [session("r1", { repoPath: clones.ryan, cwd: wtA, branch: "ryan-feature" })]);
    service(nick, roomId, clones.nick, () => [session("n1", { repoPath: clones.nick, cwd: clones.nick, branch: "nick-donor" }), session("n2", { repoPath: clones.nick, cwd: clones.nick, branch: "main" })]);
    r.svc.apply(roomId, { kind: "repo", origin: bare, name: "backoffice" });

    await until(() => ryan.team.room(roomId)!.ext.memberBranches?.[nick.id]?.branches.join() === "nick-donor", "Nick's branches to be announced (not main)");
    await until(() => r.svc.teammateChanges().length === 1, "Ryan to read Nick's branch");
    expect(r.svc.teammateChanges()).toEqual([{ member: nick.id, name: "Nick", branch: "nick-donor", repo: expect.any(String), files: ["src/api/x.ts", "src/api/z.ts"] }]);
    expect(r.overlaps).toBeGreaterThan(0);
    expect(ryan.team.room(roomId)!.ext.memberBranches?.[ryan.id]?.branches).toEqual(["ryan-feature"]);

    const mine = await changedFiles(wtA);
    const local = [{ sessionId: "r1", title: "r1", cwd: wtA, ...mine }];
    const found = mergeOverlaps(overlaps(local), teammateOverlaps(local, r.svc.teammateChanges()));
    expect(found).toEqual({ r1: [{ other: `team:${nick.id}:nick-donor`, otherTitle: "Nick's pushed branch", otherBranch: "nick-donor", files: ["src/api/x.ts"], teammate: { id: nick.id, name: "Nick" } }] });
    expect(r.svc.view(roomId)).toMatchObject({ teammates: [{ name: "Nick", branch: "nick-donor" }], fetchedAt: expect.any(Number) });
  });

  it("lets an agent in the room change the board through its tool, attributed to its session, and gives launches the room's instructions", async () => {
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("t") });
    const [ryan, nick] = members;
    const { clones } = origin(["ryan"]);
    const s1 = session("s1", { title: "#5110 — Donor API", repoPath: clones.ryan, cwd: clones.ryan });
    const outside = session("s2", { taskGroup: "5200", repoPath: clones.ryan, cwd: clones.ryan });
    const r = service(ryan, roomId, clones.ryan, () => [s1, outside]);

    const created = planToolCall("s1", { action: "create", title: "Exports", paths: ["src/export"], tests: "export.spec.ts" });
    expect(created).toEqual({ result: expect.stringMatching(/^Ryan \(agent: #5110 — Donor API\) created "Exports" \(id p-[a-z0-9]{8}\)\. Your teammates see it now/) });
    const id = /id (p-[a-z0-9]+)/.exec((created as { result: string }).result)![1];
    expect(r.svc.toolCall("s1", { action: "status", id, status: "blocked", note: "needs the API" })).toEqual({ result: expect.stringMatching(/marked "Exports" blocked: needs the API/) });
    await until(() => planOfRoom(nick.team.room(roomId)!).packages[0]?.status === "blocked", "Nick to see it");
    expect(planOfRoom(nick.team.room(roomId)!).changes.at(-1)).toMatchObject({ by: ryan.id, via: "#5110 — Donor API" });
    expect(r.svc.toolCall("s2", { action: "claim", id })).toEqual({ error: expect.stringMatching(/isn't in a shared team room/) });
    expect(r.svc.toolCall("s1", { action: "claim", id: "p-nothere" })).toEqual({ error: expect.stringMatching(/no package p-nothere/) });
    expect(r.svc.toolCall("gone", { action: "claim", id })).toEqual({ error: expect.stringMatching(/not known/) });

    const context = roomAgentContext(roomId);
    expect(context).toContain('Mockingbird team room, "5110", shared with Nick');
    expect(context).toContain(".mockingbird/plan.md");
    expect(context).toContain("update_team_plan");
  });

  it("turns the claims check's warnings into notices for the window, and a held-back edit into a notification", async () => {
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir: tempDir("t") });
    const [ryan] = members;
    const { clones } = origin(["ryan"]);
    const s1 = session("s1", { title: "API tests", repoPath: clones.ryan, cwd: clones.ryan });
    const r = service(ryan, roomId, clones.ryan, () => [s1]);
    const hit = { roomId, room: "5110", pkg: "p-abcd", title: "Donor API", status: "in-progress" as const, owner: { id: "n".repeat(32), name: "Nick" }, pattern: "src/api" };
    r.svc.claimEvent({ kind: "warning", warning: { pane: "", cwd: path.join(clones.ryan, "src"), conversation: "c1", tool: "Edit", decision: "deny", conflicts: [{ file: "src/api/x.ts", root: clones.ryan, hits: [hit] }] } });
    r.svc.claimEvent({ kind: "failed", pane: "s1", message: "claims.json isn't JSON" });
    const notices = r.emitted.filter(([c]) => c === "plan:warning").map(([, v]) => v as PlanWarningNotice);
    expect(notices[0]).toMatchObject({ sessionId: "s1", sessionTitle: "API tests", decision: "deny", tool: "Edit" });
    expect(notices[1]).toMatchObject({ sessionId: "s1", decision: "failed", error: expect.stringContaining("claims.json isn't JSON") });
    expect(r.notes).toEqual([`Nick's package: API tests tried to edit src/api/x.ts — it's in "Donor API". The agent was held back once and can go ahead.`]);
    expect(r.logs).toEqual([expect.stringContaining("the claims check in an agent's hook failed")]);
  });
});
