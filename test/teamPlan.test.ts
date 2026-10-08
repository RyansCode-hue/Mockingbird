import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { loopbackRoom, until } from "../src/main/team/loopback";
import { applyPlanOp, opFromTool, planOfRoom } from "../src/main/team/board";
import { eventIdOf, eventPayload } from "../src/main/team/rooms";
import {
  ACTIVE_STATUSES,
  claimConflicts,
  claimHookResponse,
  claimsFile,
  claimsRoom,
  editedPaths,
  renderPlanMarkdown,
  type ClaimsFile,
  type PackageStatus,
} from "../src/shared/team/plan";

const room = (dir = tempDir("plan")) => loopbackRoom(["Ryan", "Nick"], { dir });

describe("the plan board's events", () => {
  it("creates, edits, claims and finishes a package, and every member reduces the same board", async () => {
    const { members, roomId } = await room();
    const [ryan, nick] = members;
    const { pkg } = applyPlanOp(ryan.team, roomId, { kind: "create", title: "Donor API", paths: ["./src/api/donor/", "src/shared/donor.ts"], provides: "GET /api/donors/:id", tests: "pytest tests/api/test_donor.py" });
    expect(pkg).toMatch(/^p-[a-z0-9]{8}$/);
    await until(() => planOfRoom(nick.team.room(roomId)!).packages.length === 1, "Nick to see the package");
    applyPlanOp(nick.team, roomId, { kind: "claim", id: pkg! });
    await until(() => planOfRoom(ryan.team.room(roomId)!).packages[0].owner === nick.id, "Ryan to see Nick's claim");
    applyPlanOp(nick.team, roomId, { kind: "status", id: pkg!, status: "in-progress" }, "#5110 — Donor API");
    applyPlanOp(ryan.team, roomId, { kind: "edit", id: pkg!, uses: "the org lookup", paths: ["src/api/donor", "src/api/donor/"] });
    await until(() => planOfRoom(nick.team.room(roomId)!).packages[0].uses === "the org lookup" && planOfRoom(ryan.team.room(roomId)!).packages[0].status === "in-progress", "both changes everywhere");

    const mine = planOfRoom(ryan.team.room(roomId)!);
    expect(mine).toEqual(planOfRoom(nick.team.room(roomId)!));
    expect(mine.packages[0]).toMatchObject({ title: "Donor API", owner: nick.id, status: "in-progress", paths: ["src/api/donor"], provides: "GET /api/donors/:id" });
    const changes = mine.changes.map((c) => [c.kind, c.by === ryan.id ? "Ryan" : "Nick", c.via ?? ""]);
    expect(changes.slice(0, 2)).toEqual([
      ["created", "Ryan", ""],
      ["claimed", "Nick", ""],
    ]);
    // made at the same time on two machines: the log orders them by author
    expect(changes.slice(2)).toHaveLength(2);
    expect(changes.slice(2)).toEqual(expect.arrayContaining([["status", "Nick", "#5110 — Donor API"], ["edited", "Ryan", ""]]));
    expect(mine.changes.find((c) => c.kind === "edited")!.fields).toEqual(["paths", "uses"]);

    applyPlanOp(nick.team, roomId, { kind: "release", id: pkg! });
    await until(() => planOfRoom(ryan.team.room(roomId)!).packages[0].owner === null, "the release");
    expect(planOfRoom(ryan.team.room(roomId)!).packages[0].status).toBe("open");
    applyPlanOp(ryan.team, roomId, { kind: "status", id: pkg!, status: "done" });
    expect(planOfRoom(ryan.team.room(roomId)!).packages[0]).toMatchObject({ status: "done", owner: ryan.id });
  });

  it("settles changes made while apart by the log's order, the same on both sides", async () => {
    const { members, roomId, net } = await room();
    const [ryan, nick] = members;
    const { pkg } = applyPlanOp(ryan.team, roomId, { kind: "create", title: "Exports" });
    await until(() => planOfRoom(nick.team.room(roomId)!).packages.length === 1, "the package to reach Nick");
    net.setOnline(nick.id, false);
    await until(() => ryan.team.presence(roomId).length === 0, "Nick to drop");
    applyPlanOp(ryan.team, roomId, { kind: "edit", id: pkg!, title: "Exports (CSV)" });
    applyPlanOp(ryan.team, roomId, { kind: "claim", id: pkg! });
    applyPlanOp(nick.team, roomId, { kind: "edit", id: pkg!, title: "Exports (Excel)", tests: "export.spec.ts" });
    applyPlanOp(nick.team, roomId, { kind: "create", title: "Nick's own" });
    net.setOnline(nick.id, true);
    await until(() => ryan.team.room(roomId)!.events === 7 && nick.team.room(roomId)!.events === 7, "the logs to merge");
    const r = planOfRoom(ryan.team.room(roomId)!);
    expect(planOfRoom(nick.team.room(roomId)!)).toEqual(r);
    expect(r.packages[0]).toMatchObject({ owner: ryan.id, tests: "export.spec.ts" });
    expect(["Exports (CSV)", "Exports (Excel)"]).toContain(r.packages[0].title);
  });

  it("keeps a removed package removed, whatever edit is ordered after it", async () => {
    const { members, roomId, net } = await room();
    const [ryan, nick] = members;
    const { pkg } = applyPlanOp(ryan.team, roomId, { kind: "create", title: "Spike" });
    await until(() => planOfRoom(nick.team.room(roomId)!).packages.length === 1, "the package to reach Nick");
    net.setOnline(nick.id, false);
    await until(() => ryan.team.presence(roomId).length === 0, "Nick to drop");
    applyPlanOp(ryan.team, roomId, { kind: "remove", id: pkg! });
    applyPlanOp(nick.team, roomId, { kind: "edit", id: pkg!, title: "Spike, renamed" });
    applyPlanOp(nick.team, roomId, { kind: "edit", id: pkg!, description: "more" });
    net.setOnline(nick.id, true);
    await until(() => ryan.team.room(roomId)!.events === nick.team.room(roomId)!.events && ryan.team.room(roomId)!.events === 6, "the logs to merge");
    expect(planOfRoom(nick.team.room(roomId)!).packages).toEqual([]);
    expect(planOfRoom(ryan.team.room(roomId)!)).toEqual(planOfRoom(nick.team.room(roomId)!));
  });

  it("refuses changes it can't make, and malformed events from anyone", async () => {
    const { members, roomId } = await room();
    const [ryan] = members;
    expect(() => applyPlanOp(ryan.team, roomId, { kind: "claim", id: "p-nothere" })).toThrow(/no package p-nothere/);
    expect(() => applyPlanOp(ryan.team, roomId, { kind: "create", title: "  " })).toThrow(/needs a title/);
    expect(() => applyPlanOp(ryan.team, roomId, { kind: "create", title: "Escape", paths: ["../outside"] })).toThrow(/leaves the repository/);
    const { pkg } = applyPlanOp(ryan.team, roomId, { kind: "create", title: "Real" });
    expect(() => applyPlanOp(ryan.team, roomId, { kind: "claim", id: pkg!, owner: "f".repeat(32) })).toThrow(/isn't a member/);
    expect(() => ryan.team.publish(roomId, "plan.status", { id: pkg!, status: "finished" as PackageStatus })).toThrow(/bad status/);
    expect(() => ryan.team.publish(roomId, "plan.package", { id: "nope", title: "x" })).toThrow(/bad package id/);
    expect(() => ryan.team.publish(roomId, "plan.branches", { origin: "x", branches: ["a b"] })).toThrow(/bad branch name/);
  });

  it("keeps a token in the repo's origin URL out of the room log, and refuses an event that carries one", async () => {
    const { members, roomId } = await room();
    const [ryan, nick] = members;
    const tokened = "https://user:TOKEN@dev.azure.com/org/proj/_git/repo";
    const { event } = applyPlanOp(ryan.team, roomId, { kind: "repo", origin: tokened, name: "repo" });
    expect(event.body).toEqual({ origin: "https://dev.azure.com/org/proj/_git/repo", name: "repo" });
    await until(() => !!planOfRoom(nick.team.room(roomId)!).repo, "Nick to see the repo");
    expect(planOfRoom(nick.team.room(roomId)!).repo!.origin).toBe("https://dev.azure.com/org/proj/_git/repo");
    // nor can anyone put one there: not this install, not a teammate's
    expect(() => ryan.team.publish(roomId, "plan.repo", { origin: tokened, name: "repo" })).toThrow(/credentials/);
    expect(() => ryan.team.publish(roomId, "plan.branches", { origin: "https://TOKEN@github.com/acme/app.git", branches: [] })).toThrow(/credentials/);
    for (const [type, body] of [
      ["plan.repo", { origin: tokened, name: "repo" }],
      ["plan.branches", { origin: tokened, branches: ["main"] }],
    ] as const) {
      const u = { roomId, type, body, author: nick.id, lamport: ryan.team.room(roomId)!.lamport + 1, at: Date.now() };
      const payload = eventPayload(u);
      (ryan.team as any).handler.frame(nick.id, JSON.stringify({ k: "ev", roomId, events: [{ ...u, id: eventIdOf(payload), sig: nick.identity.sign(payload) }] }));
    }
    expect(ryan.logs.filter((l) => /refused event .* from Nick: malformed plan\.(repo|branches): origin must not carry credentials/.test(l))).toHaveLength(2);
    for (const m of members) expect(fs.readFileSync(path.join(m.store.get(roomId)!.dir, "log.jsonl"), "utf8")).not.toContain("TOKEN");
  });

  it("maps the agents' tool arguments to board changes, and says what's missing", () => {
    expect(opFromTool({ action: "claim", id: "p-abcd" })).toEqual({ kind: "claim", id: "p-abcd" });
    expect(opFromTool({ action: "status", id: "p-abcd", status: "blocked", note: "waiting on the API" })).toEqual({ kind: "status", id: "p-abcd", status: "blocked", note: "waiting on the API" });
    expect(opFromTool({ action: "create", title: "New", paths: ["src/x"] })).toEqual({ kind: "create", title: "New", paths: ["src/x"] });
    expect(() => opFromTool({ action: "claim" })).toThrow(/needs the package id/);
    expect(() => opFromTool({ action: "delete", id: "p-abcd" })).toThrow(/one of claim, release, status, create, edit/);
    expect(() => opFromTool({ action: "edit", id: "p-abcd", paths: "src" })).toThrow(/paths must be a list/);
  });
});

describe("rendering the board", () => {
  it("renders plan.md and the claims block the same, byte for byte, on every member", async () => {
    const { members, roomId } = await room();
    const [ryan, nick] = members;
    const { pkg } = applyPlanOp(ryan.team, roomId, { kind: "create", title: "Donor | API", description: "The donor endpoints.", paths: ["src/api/donor"], provides: "GET /api/donors/:id", uses: "org lookup", tests: "pytest" });
    applyPlanOp(ryan.team, roomId, { kind: "claim", id: pkg! });
    await until(() => planOfRoom(nick.team.room(roomId)!).packages[0]?.owner === ryan.id, "Nick to have the claim");
    const md = (m: typeof ryan) => renderPlanMarkdown(m.team.room(roomId)!, planOfRoom(m.team.room(roomId)!));
    expect(md(ryan)).toBe(md(nick));
    const text = md(ryan);
    expect(text).toContain("# Plan — 5110");
    expect(text).toContain(`| Donor \\| API (${pkg}) | claimed | Ryan | \`src/api/donor\` |`);
    expect(text).toContain("- **Provides:** GET /api/donors/:id");
    expect(text).toContain("- **Tested by:** pytest");
    expect(text).toMatch(/Ryan claimed "Donor \| API"/);
    expect(text).not.toMatch(/Invalid Date/);
    const claims = claimsRoom(ryan.team.room(roomId)!, planOfRoom(ryan.team.room(roomId)!));
    expect(claims.packages).toEqual([{ id: pkg, title: "Donor | API", status: "claimed", owner: { id: ryan.id, name: "Ryan" }, paths: ["src/api/donor"] }]);
  });
});

describe("claims", () => {
  const file = (over: Partial<ClaimsFile["rooms"][number]["packages"][number]>[], self = "me"): ClaimsFile =>
    claimsFile(
      [{ roomId: "R".repeat(22), room: "5110", updatedAt: "", packages: over.map((o, i) => ({ id: `p-000${i}`, title: `P${i}`, status: "claimed", owner: { id: "nick", name: "Nick" }, paths: [], ...o })) }],
      self
    );

  it("matches folders, files and globs, and only teammates' active claims", () => {
    const f = file([{ paths: ["src/api/donor"] }, { paths: ["**/*.test.ts"] }, { paths: ["docs/*.md"] }, { paths: ["src/ui"], owner: { id: "me", name: "Me" } }, { paths: ["src/old"], status: "done" }, { paths: ["src/free"], owner: null, status: "open" }]);
    const hit = (rel: string) => claimConflicts(f, rel).map((h) => h.pkg);
    expect(hit("src/api/donor/routes.ts")).toEqual(["p-0000"]);
    expect(hit("src/api/donor")).toEqual(["p-0000"]);
    expect(hit("src/api/donors.ts")).toEqual([]);
    expect(hit("test/deep/a.test.ts")).toEqual(["p-0001"]);
    expect(hit("a.test.ts")).toEqual(["p-0001"]);
    expect(hit("docs/plan.md")).toEqual(["p-0002"]);
    expect(hit("docs/deep/plan.md")).toEqual([]);
    expect(hit("src/ui/App.tsx")).toEqual([]); // my own claim
    expect(hit("src/old/x.ts")).toEqual([]); // done
    expect(hit("src/free/x.ts")).toEqual([]); // nobody's
    expect(hit("../elsewhere/src/api/donor/x.ts")).toEqual([]);
    expect(hit("./src/api/donor/x.ts")).toEqual(["p-0000"]);
  });

  it("treats the same statuses as active as the board does", () => {
    for (const status of ["open", "claimed", "in-progress", "blocked", "done"] as PackageStatus[]) {
      expect(claimConflicts(file([{ paths: ["x"], status }]), "x").length > 0).toBe(ACTIVE_STATUSES.includes(status));
    }
  });

  it("reads the files an edit writes, from Claude Code's tools and Codex's apply_patch", () => {
    expect(editedPaths("Edit", { file_path: "/w/src/a.ts", old_string: "a", new_string: "b" }, "/w")).toEqual(["/w/src/a.ts"]);
    expect(editedPaths("Write", { file_path: "src/b.ts", content: "x" }, "/w/")).toEqual(["/w/src/b.ts"]);
    expect(editedPaths("NotebookEdit", { notebook_path: "/w/n.ipynb" }, "/w")).toEqual(["/w/n.ipynb"]);
    expect(editedPaths("Bash", { command: "rm -rf src" }, "/w")).toEqual([]);
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/new.ts\n+x\n*** Update File: src/old.ts\n*** Move to: src/moved.ts\n*** Delete File: /abs/gone.ts\n*** End Patch\n";
    expect(editedPaths("apply_patch", { command: patch }, "/w")).toEqual(["/w/src/a.ts", "/w/src/new.ts", "/w/src/old.ts", "/w/src/moved.ts", "/abs/gone.ts"]);
  });

  it("answers the hook: held back the first time, a reminder after", () => {
    const hits = claimConflicts(file([{ paths: ["src/api"], title: "Donor API", status: "in-progress" }]), "src/api/x.ts");
    const first = claimHookResponse([{ file: "src/api/x.ts", hits }], true) as any;
    expect(first.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(first.hookSpecificOutput.permissionDecisionReason).toMatch(/src\/api\/x\.ts is owned by Nick's package "Donor API" \(p-0000, in progress\)/);
    expect(first.hookSpecificOutput.permissionDecisionReason).toMatch(/make the same edit again/);
    expect(first.systemMessage).toMatch(/Nick's package "Donor API"/);
    const again = claimHookResponse([{ file: "src/api/x.ts", hits }], false) as any;
    expect(again).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: expect.stringMatching(/Reminder from Mockingbird: src\/api\/x\.ts is owned by Nick's/) } });
  });
});
