import { describe, expect, it } from "vitest";
import { BUILT_IN_TEMPLATE, type PipelineTemplate } from "../src/shared/pipelineTemplates";
import type { HouseView } from "../src/shared/team/house";
import type { TicketSessionPlan } from "../src/shared/team/ticketSession";
import { HELPDESK_PRESET, type NewSessionRequest } from "../src/shared/types";
import { HELPDESK_CONVERSATION_WHY, HELPDESK_FOLDER_ONLY } from "../src/main/helpdesk";
import { harness } from "./assistantHarness";
import { cleanTree, fakeMac, helpdesk, info, teammate } from "./assistantWorkFakes";

/** The tiers and standing-rule flags of the sessions, start work, triage, git and diagnose tools (docs/assistant.md). */
const TIERS: Record<string, [tier: string, rule: boolean]> = {
  list_sessions: ["read", false],
  restart_session: ["confirm", true],
  restart_group: ["confirm", true],
  close_session: ["confirm", true],
  resume_session: ["confirm", true],
  handoff_session: ["confirm", false],
  list_presets: ["read", false],
  list_templates: ["read", false],
  list_tickets: ["read", false],
  start_session: ["confirm", true],
  start_preset: ["confirm", true],
  lay_out_template: ["confirm", true],
  start_from_ticket: ["confirm", false],
  review_branch: ["confirm", true],
  needs_you: ["read", false],
  answer_prompt: ["confirm", false],
  send_to_session: ["confirm", true],
  broadcast: ["confirm", true],
  recent_activity: ["read", false],
  git_status: ["read", false],
  branch_stat: ["read", false],
  pr_status: ["read", false],
  cleanup_worktree: ["confirm", false],
  push_branch: ["confirm", false],
  open_pr: ["confirm", false],
  session_detail: ["read", false],
  usage: ["read", false],
  who_touched: ["read", false],
};

describe("the Assistant's sessions, start work, triage, git and diagnose tools", () => {
  it("are in the registry with their tiers fixed, and only the spec's are a standing rule's", () => {
    const { registry } = fakeMac();
    for (const [name, [tier, rule]] of Object.entries(TIERS)) {
      const t = registry.get(name);
      expect(t, name).toBeDefined();
      expect([t!.tier, !!t!.rule], name).toEqual([tier, rule]);
      expect(t!.inputSchema, name).toMatchObject({ type: "object", additionalProperties: false });
    }
  });
});

describe("restart_session", () => {
  it("restarts with a new mode, model or effort: the card's warnings and blocked reason are describeRelaunch's, bypass in the danger color", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "api-fix", status: "working" }));
    const asked: unknown[] = [];
    mac.deps.describeRelaunch = (id, change) => {
      asked.push([id, change]);
      return { blocked: change.permissionMode === "auto" ? "Auto would loosen the team room's sandbox" : null, warnings: ["It's mid-turn: restarting stops the turn it's on"] };
    };
    const t = mac.tool("restart_session");
    const plan = { session: "a1", permissionMode: "plan" as const, model: "opus", effort: "high" };
    expect(t.label(plan)).toBe("Restart “api-fix” in Plan mode, on opus, at high effort");
    expect(await t.check!(plan)).toBeNull();
    expect(await t.card!(plan)).toEqual({
      title: "Restart “api-fix” · a1 · atticus in Plan mode, on opus, at high effort",
      detail: "Stops its agent and starts it again on the same conversation, in the same folder, now in Plan mode, on opus, at high effort. Nothing in its folder changes.",
      warnings: ["It's mid-turn: restarting stops the turn it's on"],
    });
    expect((await t.card!({ session: "a1", permissionMode: "bypass" })).danger).toBe(true);
    expect(await t.check!({ session: "a1", permissionMode: "auto" })).toBe("Auto would loosen the team room's sandbox");
    expect(asked).toContainEqual(["a1", { permissionMode: "plan", model: "opus", effort: "high" }]);

    const r = await t.run(plan);
    expect(r).toEqual({ text: "Restarted “api-fix” in Plan mode, on opus, at high effort." });
    expect(mac.did).toEqual([`relaunchWith a1 ${JSON.stringify({ permissionMode: "plan", model: "opus", effort: "high" })}`]);
  });

  it("refuses a teammate's, an unknown one, and what main's guards refuse (a copy a teammate continues); lapses once the session's closed", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1"), info("g1"));
    mac.remote.push(teammate());
    mac.guarded.set("g1", "“g1” continues on Nick's laptop: take it back first");
    const t = mac.tool("restart_session");
    expect(await t.check!({ session: "r~nick~n1" })).toBe("“Nick's api” is Nick's session: only its owner can restart it");
    expect(await t.check!({ session: "zz" })).toContain("There's no session with id");
    expect(await t.check!({ session: "g1" })).toBe("“g1” continues on Nick's laptop: take it back first");
    expect(t.stillValid!({ session: "a1" })).toBe(true);
    mac.deps.close("a1");
    expect(t.stillValid!({ session: "a1" })).toBe(false);
  });

  it("restarts the Helpdesk workspace (its lifecycle is fine) with whatever describeRelaunch allows it", async () => {
    const mac = fakeMac();
    mac.own.push(helpdesk());
    mac.deps.describeRelaunch = (_id, c) => ({ blocked: c.permissionMode === "acceptEdits" ? "The Helpdesk tasks workspace isn't given a permission mode wider than Ask as usual" : null, warnings: [] });
    const t = mac.tool("restart_session");
    expect(await t.check!({ session: "h1" })).toBeNull();
    expect(await t.check!({ session: "h1", permissionMode: "acceptEdits" })).toContain("wider than Ask as usual");
  });
});

describe("restart_group", () => {
  it("lists who it restarts and who's mid-turn, leaves out terminals, exited panes, teammates' and what the guards refuse, and restarts only those", async () => {
    const mac = fakeMac();
    mac.own.push(
      info("a1", { title: "api", status: "working" }),
      info("a2", { title: "web", taskGroup: "atticus/ui" }),
      info("w1", { title: "wait", status: "waiting", waitingReason: "Claude needs your permission to use Bash", waitingSince: 5 }),
      info("t1", { shell: true }),
      info("d1", { status: "dead" }),
      info("g1", { title: "copy" }),
      info("o1", { taskGroup: "other" })
    );
    mac.remote.push(teammate("r~nick~n1", { taskGroup: "atticus" }));
    mac.guarded.set("g1", "it continues on Nick's laptop");
    const t = mac.tool("restart_group");
    expect(await t.check!({ group: "nope" })).toContain("There's no group “nope”");
    expect(await t.check!({ group: "atticus" })).toBeNull();
    const args = { group: "atticus" };
    expect(await t.card!(args)).toEqual({
      title: "Restart 3 sessions in “atticus”",
      detail: "Stops each one's agent and starts it again on the same conversation: “api” · a1 · atticus, “web” · a2 · atticus/ui, “wait” · w1 · atticus.",
      warnings: ["“api” · a1 · atticus is mid-turn: restarting stops the turn it's on", "“wait” · w1 · atticus is waiting on you: restarting drops the prompt it's showing", "“copy” · g1 · atticus is left out: it continues on Nick's laptop"],
    });
    expect(t.stillValid!(args)).toBe(true);
    const r = await t.run(args);
    expect(r.text).toBe("Restarted “api”, “web”, “wait”.");
    expect(mac.did).toEqual(["restart a1", "restart a2", "restart w1"]);

    // a session joining the group since makes it another card
    mac.own.push(info("a3"));
    expect(t.stillValid!(args)).toBe(false);
  });

  it("refuses a group with nothing to restart, and fails, saying why, when none restarts", async () => {
    const mac = fakeMac();
    mac.own.push(info("t1", { shell: true }));
    const t = mac.tool("restart_group");
    expect(await t.check!({ group: "atticus" })).toBe("No agent session of this Mac's runs in “atticus”");
    mac.own.push(info("a1"));
    mac.deps.relaunch = async () => {
      throw new Error("its folder is gone");
    };
    await expect(t.run({ group: "atticus" })).rejects.toThrow("Failed: “a1” (its folder is gone).");
  });
});

describe("close_session", () => {
  it("names what closing loses (the session guards' closeWarnings), closes without forgetting, and lapses once it's closed", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "api", status: "working", repoPath: "/code/atticus", branch: "fix", cwd: "/w/atticus-fix" }));
    mac.trees.set("/w/atticus-fix", cleanTree({ dirty: true, dirtyFiles: 2, ahead: 1, branch: "fix" }));
    const t = mac.tool("close_session");
    expect(await t.check!({ session: "a1" })).toBeNull();
    expect(await t.card!({ session: "a1" })).toEqual({
      title: "Close “api” · a1 · atticus",
      detail: "Closes its pane and stops its agent. It stays in Closed sessions with its conversation and folder, so it can be reopened.",
      warnings: ["2 files have uncommitted changes", "1 commit isn't pushed", "It's mid-turn: closing stops it"],
    });
    expect((await t.run({ session: "a1" })).text).toBe("Closed “api”: it can be reopened from Closed sessions.");
    expect(mac.did).toEqual(["close a1"]);
    expect(mac.closed.map((s) => s.id)).toEqual(["a1"]);
    expect(t.stillValid!({ session: "a1" })).toBe(false);
    expect(await t.check!({ session: "a1" })).toBe("It's closed already: resume_session reopens it");
  });

  it("refuses a teammate's; closes the Helpdesk workspace, whose lifecycle is fine", async () => {
    const mac = fakeMac();
    mac.own.push(helpdesk());
    mac.remote.push(teammate());
    const t = mac.tool("close_session");
    expect(await t.check!({ session: "r~nick~n1" })).toBe("“Nick's api” is Nick's session: only its owner can close it");
    expect(await t.check!({ session: "h1" })).toBeNull();
  });
});

describe("resume_session", () => {
  it("resumes an exited pane and reopens a closed session, each card saying which, and refuses one that's running", async () => {
    const mac = fakeMac();
    mac.own.push(info("d1", { title: "dead", status: "dead", exitCode: 1 }), info("a1"));
    mac.closed.push(info("c1", { title: "closed" }));
    const t = mac.tool("resume_session");
    expect(await t.check!({ session: "a1" })).toBe("It's running already");
    expect(await t.check!({ session: "d1" })).toBeNull();
    expect(await t.check!({ session: "c1" })).toBeNull();
    const d1 = { session: "d1" };
    const c1 = { session: "c1" };
    expect((await t.card!(d1)).title).toBe("Resume “dead” · d1 · atticus");
    expect((await t.card!(c1)).title).toBe("Reopen “closed” · c1 · atticus");
    expect((await t.run(d1)).text).toBe("Resumed “dead”.");
    expect((await t.run(c1)).text).toBe("Reopened “closed”.");
    expect(mac.did).toEqual(["resume d1", "reopen c1"]);
    // reopened (running) since: the card lapses
    mac.own.push(mac.closed.splice(0, 1)[0]);
    expect(t.stillValid!(c1)).toBe(false);
  });

  it("refuses a teammate's and one that mayn't run again here (main's relaunch guard)", async () => {
    const mac = fakeMac();
    mac.closed.push(info("c1"));
    mac.own.push(info("d1", { status: "dead" }));
    mac.remote.push(teammate());
    mac.guarded.set("c1", "“c1” continues on Nick's laptop");
    mac.guarded.set("d1", "“d1” continues on Nick's laptop");
    const t = mac.tool("resume_session");
    expect(await t.check!({ session: "r~nick~n1" })).toBe("“Nick's api” is Nick's session: only its owner can resume it");
    expect(await t.check!({ session: "c1" })).toBe("“c1” continues on Nick's laptop");
    expect(await t.check!({ session: "d1" })).toBe("“d1” continues on Nick's laptop");
  });
});

describe("handoff_session", () => {
  it("starts a fresh session from a brief, or the other agent's from a handoff it writes", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "api" }));
    const t = mac.tool("handoff_session");
    expect(await t.check!({ session: "a1" })).toBeNull();
    expect(await t.card!({ session: "a1" })).toMatchObject({ title: "Hand “api” · a1 · atticus off to a fresh Claude session", detail: expect.stringContaining("from a brief of its conversation"), warnings: [] });
    expect(await t.card!({ session: "a1", to: "other" })).toMatchObject({ title: "Hand “api” · a1 · atticus off to a fresh Codex session", warnings: ["Writing the handoff takes Codex up to 4 minutes"] });
    expect((await t.run({ session: "a1" })).text).toMatch(/^Started “a1 · fresh” \(new\d+\) from “api”\.$/);
    expect((await t.run({ session: "a1", to: "other" })).text).toMatch(/^Started “a1 · codex”/);
    expect(mac.did).toEqual(["started a1 · fresh", "started a1 · codex"]);
  });

  it("refuses the Helpdesk workspace (its conversation never goes), a teammate's, a taken-over copy, a terminal and a closed one", async () => {
    const mac = fakeMac();
    mac.own.push(helpdesk(), info("t1", { shell: true }), info("k1"));
    mac.closed.push(info("c1"));
    mac.remote.push(teammate());
    mac.taken.add("k1");
    const t = mac.tool("handoff_session");
    expect(await t.check!({ session: "h1" })).toBe(HELPDESK_CONVERSATION_WHY);
    expect(await t.check!({ session: "r~nick~n1" })).toBe("“Nick's api” is Nick's session: only its owner can hand it off");
    expect(await t.check!({ session: "k1" })).toBe("“k1” continues on Nick's laptop — take it back rather than starting a fresh session from this copy");
    expect(await t.check!({ session: "k1", to: "other" })).toBe("“k1” continues on Nick's laptop — take it back rather than handing this copy on");
    expect(await t.check!({ session: "t1" })).toBe("It's a terminal: it has no agent conversation to hand off");
    expect(await t.check!({ session: "c1" })).toBe("It isn't open here: resume it first");
    expect(mac.did).toEqual([]);
  });
});

// ---- start work -------------------------------------------------------------------------------------

const template = (over: Partial<PipelineTemplate> = {}): PipelineTemplate => ({
  id: "t-build",
  name: "Build → Review",
  savedAt: 1,
  startFirst: true,
  steps: [
    { key: "build", name: "Builder", agent: "claude", folder: "new", prompt: "Build {ticket}" },
    { key: "review", name: "Reviewer", agent: "codex", folder: { sameAs: "build" }, prompt: "Review it" },
  ],
  wires: [{ from: "build", to: "review", type: "handoff" }],
  ...over,
});

describe("list_presets, list_templates and list_tickets", () => {
  it("give what can be started, compactly: presets, templates without their prompts, the House boards with a project and Azure DevOps, read only", async () => {
    const mac = fakeMac();
    mac.deps.presets = () => [HELPDESK_PRESET, { id: "p1", name: "Atticus dev", launch: "codex", repoPath: "~/Code/atticus", branch: { mode: "new", pattern: "ryan/{date}", base: "dev" }, useWorktree: true, group: "atticus", kickoff: "Read the README\nthen wait", model: "gpt-5.1-codex" }];
    mac.deps.templates = () => ({ templates: [BUILT_IN_TEMPLATE, template()], refused: ["Old one: it isn't a list"] });
    const board = (over: Partial<HouseView>): HouseView =>
      ({ roomId: "R1", room: "Atticus team", project: "atticus", admin: "Ryan", isAdmin: true, envFile: "~/x.env", connection: { state: "ok" }, open: [], added: [], fetchedAt: 0, refreshing: false, branches: [], ...over }) as HouseView;
    mac.deps.houseBoards = () => [
      board({
        fetchedAt: Date.UTC(2026, 10, 16, 10),
        open: [
          { n: 12, ticket: { n: 12, title: "Export API", status: "open", priority: "high", kind: "feature", tags: [], claim: { by: "Nick", branch: "feature/12-x", at: null }, blockedBy: [], waiting: null }, owner: { name: "Nick", member: "nick", self: false } },
          { n: 13, ticket: null, owner: null, problem: "couldn't be read" },
        ],
      }),
      board({ roomId: "R2", room: "No project", project: null }),
    ];
    mac.deps.adoItems = async () => {
      throw new Error("Azure DevOps isn't set up: add the WorkTracker config");
    };
    const presets = JSON.parse((await mac.tool("list_presets").run({})).text).presets;
    expect(presets[0]).toMatchObject({ id: HELPDESK_PRESET.id, helpdesk: true });
    expect(presets[1]).toEqual({ id: "p1", name: "Atticus dev", launch: "codex", repo: "atticus", branch: "new from ryan/{date} off dev", worktree: true, group: "atticus", model: "gpt-5.1-codex", kickoff: "Read the README then wait" });
    const templates = JSON.parse((await mac.tool("list_templates").run({})).text);
    expect(templates.templates[1]).toEqual({
      id: "t-build",
      name: "Build → Review",
      startFirst: true,
      steps: [
        { key: "build", name: "Builder", agent: "claude", folder: "new" },
        { key: "review", name: "Reviewer", agent: "codex", folder: "same as build" },
      ],
      wires: ["build → review (handoff)"],
    });
    expect(templates.unreadable).toEqual(["Old one: it isn't a list"]);
    expect(JSON.stringify(templates)).not.toContain("Build {ticket}");
    const tickets = JSON.parse((await mac.tool("list_tickets").run({})).text);
    expect(tickets.house).toEqual([
      {
        room: "Atticus team",
        roomId: "R1",
        project: "atticus",
        connection: "ok",
        read: "2026-11-16T10:00:00.000Z",
        open: [{ n: 12, title: "Export API", status: "open", priority: "high", kind: "feature", claimedBy: "Nick" }, { n: 13, problem: "couldn't be read" }],
      },
    ]);
    expect(tickets.ado).toEqual({ error: "Azure DevOps couldn't be read: Azure DevOps isn't set up: add the WorkTracker config" });
    expect(JSON.parse((await mac.tool("list_tickets").run({ source: "house" })).text).ado).toBeUndefined();
  });
});

describe("start_session", () => {
  it("starts through sessions:create with the request it names: a repo's new worktree on a branch, a mode, model, effort and first prompt", async () => {
    const mac = fakeMac();
    const asked: NewSessionRequest[] = [];
    mac.deps.createSession = async (req) => (asked.push(req), info("n1", { title: req.title ?? "x" }));
    const t = mac.tool("start_session");
    const a = { agent: "claude" as const, repo: "atticus", worktree: true, branch: "fix/login", base: "dev", group: "atticus", title: "Login fix", permissionMode: "acceptEdits" as const, model: "opus", effort: "high", prompt: "Fix the login bug in auth.ts" };
    expect(await t.check!(a)).toBeNull();
    expect(await t.card!(a)).toEqual({
      title: "Start Claude in a new worktree of atticus on fix/login, cut from origin/dev",
      detail: "Starts a new Claude session in a new worktree of atticus on fix/login, cut from origin/dev, in “atticus”, titled “Login fix”, in Accept edits, on opus, at high effort. Its first prompt, below, is sent once it's up.",
      body: "Fix the login bug in auth.ts",
      warnings: ["Accept edits: it changes files without asking you first"],
    });
    expect((await t.run(a)).text).toBe("Started “Login fix” (n1) in a new worktree of atticus on fix/login, cut from origin/dev.");
    expect(asked).toEqual([
      { repoPath: "/code/atticus", useWorktree: true, branchName: "fix/login", baseBranch: "dev", taskGroup: "atticus", agent: "claude", title: "Login fix", permissionMode: "acceptEdits", model: "opus", effort: "high", initialPrompt: "Fix the login bug in auth.ts" },
    ]);
  });

  it("warns of bypass in the danger color, of switching a checkout, and of a room's area", async () => {
    const mac = fakeMac();
    mac.rooms.push({ id: "R1", name: "Atticus team", groupKey: "atticus", members: [{ name: "Ryan", self: true }], online: [] });
    const t = mac.tool("start_session");
    const card = await t.card!({ agent: "codex", repo: "/code/atticus", branch: "dev", group: "atticus", permissionMode: "bypass" });
    expect(card.danger).toBe(true);
    expect(card.warnings).toEqual([
      "Bypass permissions: Codex runs every command without asking, and outside its sandbox",
      "It switches atticus's checkout to dev",
      "Teammates in “Atticus team” will see its terminal and scrollback: “atticus” is that team room's group",
    ]);
  });

  it("refuses what main would: an unknown repo, an effort the agent hasn't, a worktree with no repo, the Helpdesk's or a teammate's folder", async () => {
    const mac = fakeMac();
    mac.own.push(helpdesk(), info("a1", { title: "api", branch: "fix", cwd: "/w/fix" }));
    mac.remote.push(teammate());
    const t = mac.tool("start_session");
    expect(await t.check!({ agent: "claude", repo: "nope" })).toContain("isn't a repository this Mac knows");
    expect(await t.check!({ agent: "codex", effort: "max" })).toBe("Codex has no max reasoning effort: low, medium, high, xhigh");
    expect(await t.check!({ agent: "claude", worktree: true })).toBe("A worktree or a branch needs a repository: name one");
    expect(await t.check!({ agent: "claude", inFolderOf: "h1" })).toBe(HELPDESK_FOLDER_ONLY);
    expect(await t.check!({ agent: "claude", inFolderOf: "r~nick~n1" })).toBe("“Nick's api” is Nick's session: only its owner can start a session in its folder");
    expect(await t.check!({ agent: "claude", inFolderOf: "a1", branch: "x" })).toContain("not both");
    // another session's folder, on its branch as it stands
    const asked: NewSessionRequest[] = [];
    mac.deps.createSession = async (req) => (asked.push(req), info("n1"));
    await t.run({ agent: "codex", inFolderOf: "a1", prompt: "Look at the failing test" });
    expect(asked).toEqual([{ repoPath: "/code/atticus", cwd: "/w/fix", branchName: "fix", useWorktree: false, taskGroup: "atticus", agent: "codex", initialPrompt: "Look at the failing test" }]);
  });
});

describe("starting a session in a team room", () => {
  const ATTICUS = { id: "R1", name: "Atticus team", groupKey: "atticus", members: [{ name: "Ryan", self: true }], online: [] };
  const JOINS = (group: string, many = false) => `Teammates in “Atticus team” will see ${many ? "their terminals and scrollback" : "its terminal and scrollback"}: “${group}” is that team room's group`;
  const RULE_REFUSED = (group: string) => `A standing rule starts nothing in a team room: “${group}” is team room “Atticus team”'s group, whose teammates would see what it starts`;
  const RULE_WARNED = (group: string) => `A standing rule starts nothing in a team room: while “${group}” is team room “Atticus team”'s group, this is refused on every run`;
  const roomMac = () => {
    const mac = fakeMac();
    mac.rooms.push(ATTICUS);
    mac.own.push(info("a1", { title: "api", branch: "fix", cwd: "/w/fix" }), info("d1", { title: "docs", taskGroup: "docs" }));
    mac.deps.presets = () => [
      { ...HELPDESK_PRESET, id: "p-room", name: "Room shell", launch: "shell", role: undefined, group: "atticus/scratch", repoPath: null, kickoff: undefined },
      { ...HELPDESK_PRESET, id: "p-help", group: "atticus" },
    ];
    mac.deps.templates = () => ({ templates: [template()], refused: [] });
    return mac;
  };

  it("is decided by the group's top-level key and by an inherited group, as the live panes decide it: every such card says so in the danger color", async () => {
    const mac = roomMac();
    const start = mac.tool("start_session");
    // a stack that doesn't exist yet is still the room's
    const stack = await start.card!({ agent: "claude", group: "atticus/newstack" });
    expect(stack).toMatchObject({ danger: true, warnings: [JOINS("atticus/newstack")] });
    // another session's folder brings its group, and its room
    const beside = await start.card!({ agent: "codex", inFolderOf: "a1" });
    expect(beside).toMatchObject({ danger: true, warnings: [JOINS("atticus")], detail: "Starts a new Codex session in the folder of “api” · a1 · atticus, on fix as it stands, in its group “atticus”." });
    const elsewhere = await start.card!({ agent: "claude", inFolderOf: "a1", group: "docs" });
    expect(elsewhere.warnings).toEqual([]);
    expect(elsewhere.danger).toBeUndefined();
    expect((await start.card!({ agent: "claude", inFolderOf: "d1" })).warnings).toEqual([]);

    const preset = mac.tool("start_preset");
    expect(await preset.card!({ preset: "p-room" })).toMatchObject({ danger: true, warnings: [JOINS("atticus/scratch")] });
    // the Helpdesk workspace is never a room's, wherever its group is (main refuses it there)
    expect((await preset.card!({ preset: "p-help" })).warnings).toEqual([]);

    const layOut = await mac.tool("lay_out_template").card!({ template: "t-build", area: "atticus", repo: "atticus" });
    expect(layOut.danger).toBe(true);
    expect(layOut.warnings).toContain(JOINS("atticus", true));

    expect(await mac.tool("review_branch").card!({ session: "a1" })).toMatchObject({ danger: true, warnings: [JOINS("atticus")] });
    expect(await mac.tool("handoff_session").card!({ session: "a1" })).toMatchObject({ danger: true, warnings: [JOINS("atticus")] });
    expect((await mac.tool("review_branch").card!({ session: "d1" })).warnings).toEqual([]);
  });

  it("a card expires when the group it starts in is shared as a room after it, or the room is left", async () => {
    const mac = roomMac();
    const start = mac.tool("start_session");
    const into = { agent: "claude" as const, group: "docs/new" };
    await start.card!(into);
    expect(start.stillValid!(into)).toBe(true);
    mac.rooms.push({ ...ATTICUS, id: "R2", name: "Docs team", groupKey: "docs" });
    expect(start.stillValid!(into)).toBe(false);
    const beside = { agent: "claude" as const, inFolderOf: "a1" };
    await start.card!(beside);
    expect(start.stillValid!(beside)).toBe(true);
    mac.rooms.splice(0, 1);
    expect(start.stillValid!(beside)).toBe(false);
    const layOut = mac.tool("lay_out_template");
    const a = { template: "t-build", area: "atticus", repo: "atticus" };
    await layOut.card!(a);
    mac.rooms.push(ATTICUS);
    expect(layOut.stillValid!(a)).toBe(false);
  });

  it("is never a standing rule's: refused on every run, and its card says so", async () => {
    const mac = roomMac();
    const rule = { rule: true };
    const cases: [string, Record<string, unknown>, string][] = [
      ["start_session", { agent: "claude", group: "atticus/newstack" }, "atticus/newstack"],
      ["start_session", { agent: "claude", inFolderOf: "a1" }, "atticus"],
      ["start_preset", { preset: "p-room" }, "atticus/scratch"],
      ["lay_out_template", { template: "t-build", area: "atticus", repo: "atticus" }, "atticus"],
      ["review_branch", { session: "a1" }, "atticus"],
    ];
    for (const [name, args, group] of cases) {
      const t = mac.tool(name);
      expect(await t.check!(args, rule), name).toBe(RULE_REFUSED(group));
      await expect(Promise.resolve().then(() => t.run(args, rule)), name).rejects.toThrow(RULE_REFUSED(group));
      expect(t.describe!(args, rule).warnings, name).toContain(RULE_WARNED(group));
      // the user's own card is theirs to confirm
      expect(await t.check!(args, { rule: false }), name).toBeNull();
    }
    expect(mac.did).toEqual([]);
    // through the service, as a rule's run is
    const h = harness(mac.registry.list());
    expect(await h.svc.runAction({ tool: "start_session", args: { agent: "claude", inFolderOf: "a1" }, label: "Start" }, "Beside api")).toMatchObject({ ok: false, text: RULE_REFUSED("atticus") });
    expect(await h.svc.runAction({ tool: "start_session", args: { agent: "claude", inFolderOf: "d1" }, label: "Start" }, "Beside docs")).toMatchObject({ ok: true });
    expect(mac.did).toEqual(["started new"]);
  });
});

describe("start_preset", () => {
  it("starts a preset that's there, through presets:start", async () => {
    const mac = fakeMac();
    mac.deps.presets = () => [HELPDESK_PRESET];
    const t = mac.tool("start_preset");
    expect(await t.check!({ preset: "gone" })).toContain("There's no preset with id “gone”");
    expect(await t.check!({ preset: HELPDESK_PRESET.id })).toBeNull();
    expect((await t.card!({ preset: HELPDESK_PRESET.id })).title).toBe("Start the preset “Helpdesk tasks”");
    await t.run({ preset: HELPDESK_PRESET.id });
    expect(mac.did).toEqual([`started preset ${HELPDESK_PRESET.id}`]);
  });
});

describe("lay_out_template", () => {
  it("lays a template out in an area that's there, with its repo and its ticket's own title and description from Azure DevOps", async () => {
    const mac = fakeMac();
    const orchestrated = template({ id: "t-orch", name: "Orchestrated", steps: [{ key: "o", name: "Orchestrator", agent: "claude", folder: "new", prompt: "Plan {ticket}", role: "orchestrator" }, ...template().steps] });
    mac.deps.templates = () => ({ templates: [template(), orchestrated], refused: [] });
    mac.deps.adoItems = async () => ({ me: "Ryan", total: 1, items: [{ id: 5038, title: "Filter orgs", state: "Active", type: "Bug", assignedTo: "Ryan", changed: "", description: "Orgs list is slow", url: "", tags: [] }] });
    const asked: unknown[] = [];
    mac.deps.layOut = async (req) => (asked.push(req), { steps: [{ key: "build", id: "s1", title: "Builder" }, { key: "review", id: "s2", title: "Reviewer" }], wires: ["w1"], started: "s1", notes: [] });
    const t = mac.tool("lay_out_template");
    expect(await t.check!({ template: "t-build", area: "docs" })).toContain("“docs” has no area on the landscape");
    expect(await t.check!({ template: "nope", area: "atticus" })).toContain("There's no template with id “nope”");
    expect(await t.check!({ template: "t-build", area: "atticus" })).toBe("Its steps work in worktrees of their own: name the repo");
    expect(await t.check!({ template: "t-orch", area: "atticus", repo: "atticus" })).toContain("is an Orchestrator");
    expect(await t.check!({ template: "t-build", area: "atticus", repo: "atticus", ticket: "#77" })).toBe("#77 isn't among the Azure DevOps work items the Dashboard lists");

    const a = { template: "t-orch", area: "atticus", repo: "atticus", ticket: "5038" };
    expect(await t.check!(a)).toBeNull();
    expect(await t.card!(a)).toEqual({
      title: "Lay out “Orchestrated” in “atticus”",
      detail: "Makes Orchestrator (Claude) in “atticus”, in atticus, for #5038 “Filter orgs”. Orchestrator starts now; the rest wait for their handoffs.",
      warnings: [],
    });
    // laying its pipeline out again afterwards is said when it can't be done, and the lay-out stands
    expect((await t.run(a)).text).toBe("Laid out “Orchestrated” in “atticus”: Builder (s1), Reviewer (s2); Builder started. Its pipeline wasn't laid out again: landscapeState isn't faked in this test.");
    expect(asked).toEqual([
      { name: "Orchestrated", template: { startFirst: true, steps: orchestrated.steps, wires: orchestrated.wires }, ticketId: "5038", ticketTitle: "Filter orgs", ticketDescription: "Orgs list is slow", repoPath: "/code/atticus", area: "atticus" },
    ]);
  });

  it("gives one Orchestrator several tickets, each looked up, and refuses them for any other template", async () => {
    const mac = fakeMac();
    const orchestrated = template({ id: "t-orch", name: "Orchestrated", steps: [{ key: "o", name: "Orchestrator", agent: "claude", folder: "new", prompt: "Plan {ticket}", role: "orchestrator" }, ...template().steps] });
    mac.deps.templates = () => ({ templates: [template(), orchestrated], refused: [] });
    const item = (id: number, title: string, description: string) => ({ id, title, state: "Active", type: "Bug", assignedTo: "Ryan", changed: "", description, url: "", tags: [] });
    mac.deps.adoItems = async () => ({ me: "Ryan", total: 2, items: [item(5038, "Filter orgs", "Orgs list is slow"), item(5040, "Sort orgs", "By name")] });
    const asked: unknown[] = [];
    mac.deps.layOut = async (req) => (asked.push(req), { steps: [{ key: "o", id: "s1", title: "Orchestrator" }], wires: [], started: "s1", notes: [] });
    const t = mac.tool("lay_out_template");
    const a = { template: "t-orch", area: "atticus", repo: "atticus", ticket: "5038", more_tickets: ["#5040"] };
    expect(await t.check!({ ...a, template: "t-build" })).toBe("“Build → Review” doesn't start at an Orchestrator, so it takes one ticket: lay it out once for each");
    expect(await t.check!({ ...a, ticket: undefined })).toBe("more_tickets come after ticket: name the first one as ticket");
    expect(await t.check!({ ...a, more_tickets: ["5038"] })).toBe("#5038 is named twice");
    expect(await t.check!({ ...a, more_tickets: ["5041"] })).toBe("#5041 isn't among the Azure DevOps work items the Dashboard lists");
    expect(await t.check!(a)).toBeNull();
    expect((await t.card!(a)).detail).toBe(
      "Makes Orchestrator (Claude) in “atticus”, in atticus, for #5038 “Filter orgs”, #5040 “Sort orgs”. Its Orchestrator reads both tickets and proposes one plan, each step on one of them. Orchestrator starts now; the rest wait for their handoffs."
    );
    await t.run(a);
    expect(asked).toEqual([
      {
        name: "Orchestrated",
        template: { startFirst: true, steps: orchestrated.steps, wires: orchestrated.wires },
        ticketId: "5038",
        ticketTitle: "Filter orgs",
        ticketDescription: "Orgs list is slow",
        moreTickets: [{ ticketId: "5040", ticketTitle: "Sort orgs", ticketDescription: "By name" }],
        repoPath: "/code/atticus",
        area: "atticus",
      },
    ]);
  });
});

describe("start_from_ticket", () => {
  const plan = (over: Partial<TicketSessionPlan> = {}): TicketSessionPlan => ({
    roomId: "R1",
    room: "Atticus team",
    group: "atticus",
    project: "atticus",
    n: 12,
    title: "Export API",
    holder: { state: "free" },
    branch: "feature/12-export-api",
    branchFrom: "new",
    repos: [{ path: "/code/atticus", name: "atticus", base: "dev" }],
    repoNote: null,
    ...over,
  });

  it("claims and starts through house:startSession, in the one clone there is", async () => {
    const mac = fakeMac();
    mac.rooms.push({ id: "R1", name: "Atticus team", groupKey: "atticus", members: [{ name: "Ryan", self: true }], online: [] });
    mac.deps.ticketPlan = async () => plan();
    const asked: unknown[] = [];
    mac.deps.startTicket = async (roomId, req) => (asked.push([roomId, req]), { session: info("n1"), claimed: true, branch: "feature/12-export-api", message: "Claimed #12 and started Claude on feature/12-export-api" });
    const t = mac.tool("start_from_ticket");
    const a = { room: "Atticus team", ticket: 12 };
    expect(await t.check!(a)).toBeNull();
    expect(await t.card!(a)).toEqual({
      title: "Start on #12 “Export API”",
      detail: "Claims #12 on room Atticus team's House board as you. Makes feature/12-export-api's worktree in atticus, cut from origin/dev, and starts Claude there in “atticus” with the ticket as its brief.",
      warnings: ["Teammates in “Atticus team” will see its terminal and scrollback: “atticus” is that team room's group"],
      danger: true,
    });
    expect((await t.run(a)).text).toBe("Claimed #12 and started Claude on feature/12-export-api (n1).");
    expect(asked).toEqual([["R1", { n: 12, agent: "claude", repoPath: "/code/atticus" }]]);
  });

  it("refuses a teammate's ticket, a closed one, an unknown room and a clone it can't pick; a failed start fails the card", async () => {
    const mac = fakeMac();
    mac.rooms.push({ id: "R1", name: "Atticus team", groupKey: "atticus", members: [], online: [] });
    const t = mac.tool("start_from_ticket");
    expect(await t.check!({ room: "Other", ticket: 1 })).toContain("There's no team room “Other”");
    mac.deps.ticketPlan = async () => plan({ holder: { state: "taken", by: "Nick" } });
    expect(await t.check!({ room: "R1", ticket: 12 })).toBe("#12 is Nick's: ask them to release it, or start on another ticket");
    mac.deps.ticketPlan = async () => plan({ holder: { state: "closed", status: "done" } });
    expect(await t.check!({ room: "R1", ticket: 12 })).toBe("#12 is done: only open tickets get a session");
    mac.deps.ticketPlan = async () => plan({ repos: [{ path: "/a/atticus", name: "atticus", base: null }, { path: "/b/atticus2", name: "atticus2", base: null }] });
    expect(await t.check!({ room: "R1", ticket: 12 })).toBe("Pick the clone to start in: atticus (/a/atticus), atticus2 (/b/atticus2)");
    expect(await t.check!({ room: "R1", ticket: 12, repo: "atticus2" })).toBeNull();
    mac.deps.startTicket = async () => ({ error: "Someone claimed #12 just before you, so nothing was started.", step: "claim" });
    const a = { room: "R1", ticket: 12, repo: "atticus2" };
    await t.check!(a);
    await expect(t.run(a)).rejects.toThrow("Someone claimed #12 just before you");
  });
});

describe("review_branch", () => {
  it("has the other agent review a session's branch through review:start, and refuses what review:start would", async () => {
    const mac = fakeMac();
    mac.own.push(info("a1", { title: "api", branch: "fix" }), helpdesk(), info("t1", { shell: true }), info("k1"));
    mac.remote.push(teammate());
    mac.taken.add("k1");
    const t = mac.tool("review_branch");
    expect(await t.check!({ session: "r~nick~n1" })).toBe("“Nick's api” is Nick's session: only its owner can have its branch reviewed");
    expect(await t.check!({ session: "h1" })).toBe("It isn't in a repository, so it has no branch to review");
    expect(await t.check!({ session: "t1" })).toBe("It's a terminal: it has no agent's work to review");
    expect(await t.check!({ session: "k1" })).toBe("“k1” continues on Nick's laptop — take it back rather than having this copy's branch reviewed");
    expect(await t.check!({ session: "a1" })).toBeNull();
    expect(await t.card!({ session: "a1" })).toMatchObject({ title: "Have Codex review the branch of “api” · a1 · atticus", detail: expect.stringContaining("on fix as it stands") });
    await t.run({ session: "a1" });
    expect(mac.did).toEqual(["started Review · a1"]);
  });
});
