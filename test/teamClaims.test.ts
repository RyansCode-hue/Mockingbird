import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, makeRepo, tempDir, write } from "./helpers";
import { installHooks, watchEvents, type ClaimEvent } from "../src/main/hooks";
import { CLAIMS_CHECK_SCRIPT, CLAIMS_LOG, CLAIMS_WARNED_DIR, pruneWarned } from "../src/main/team/claims";
import { claimsFile, ROOM_CONTEXT_ENV, type ClaimsFile } from "../src/shared/team/claims";

const mb = path.join(os.homedir(), ".mockingbird");
const eventsDir = path.join(mb, "events");
const script = path.join(mb, "hook.sh");
const claudeSettings = path.join(os.homedir(), ".claude", "settings.json");
const NICK = "b".repeat(32);
const ME = "a".repeat(32);

/** A checkout whose read-only claims say Nick's ticket #141 has been changing src/api/x.ts, and my #143 src/ui/y.ts. */
function roomCheckout(claims?: ClaimsFile | string): string {
  const repo = makeRepo({ "src/api/x.ts": "x\n", "src/api/z.ts": "z\n", "src/ui/y.ts": "y\n" });
  const file =
    claims ??
    claimsFile(
      [
        {
          roomId: "R".repeat(22),
          room: "#5110 Donor entities",
          tickets: [
            { n: 141, title: "Donor API", status: "in_progress", owner: { id: NICK, name: "Nick" }, branch: "5110-donorApi", files: ["src/api/x.ts"] },
            { n: 143, title: "Donor UI", status: "review", owner: { id: ME, name: "Me" }, branch: "5110-donorUi", files: ["src/ui/y.ts"] },
          ],
        },
      ],
      ME
    );
  write(repo, { ".mockingbird/claims.json": typeof file === "string" ? file : JSON.stringify(file), ".mockingbird/agent-context.md": "You're working in a Mockingbird team room.\n" });
  return repo;
}

/** Run the installed hook script as an agent does: payload on stdin, in the agent's folder. */
function runHook(event: string, payload: object, cwd: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(script, [event], { cwd, env: { ...process.env, MOCKINGBIRD_SESSION: "p1", ...env } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin!.end(JSON.stringify(payload));
  });
}

const claudeEdit = (cwd: string, file: string, session = "conv-1") => ({
  session_id: session,
  transcript_path: `/Users/x/.claude/projects/p/${session}.jsonl`,
  cwd,
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: "Edit",
  tool_input: { file_path: path.join(cwd, file), old_string: "x", new_string: "y" },
  tool_use_id: "toolu_01",
});

/** Events the hook left for the app, by name. */
const events = (name: string) =>
  fs
    .readdirSync(eventsDir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .map((f) => JSON.parse(fs.readFileSync(path.join(eventsDir, f), "utf8")))
    .filter((e) => e.event === name);

beforeEach(() => {
  fs.rmSync(eventsDir, { recursive: true, force: true });
  installHooks(null);
});
let stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
  fs.rmSync(path.dirname(claudeSettings), { recursive: true, force: true });
});

describe("the claims check in the agents' PreToolUse hook", () => {
  it("is installed with the hooks, for SessionStart too", () => {
    const s = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
    for (const ev of ["PreToolUse", "SessionStart"]) expect(JSON.stringify(s.hooks[ev])).toContain("hook.sh");
    expect(fs.readFileSync(CLAIMS_CHECK_SCRIPT, "utf8")).toContain("function claimConflicts");
    expect(fs.readFileSync(script, "utf8")).toContain(CLAIMS_CHECK_SCRIPT);
  });

  it("holds back the first edit of a teammate's file in a conversation, then lets it through with a reminder", async () => {
    const repo = roomCheckout();
    const first = JSON.parse(await runHook("PreToolUse", claudeEdit(repo, "src/api/x.ts"), repo));
    expect(first.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(first.hookSpecificOutput.permissionDecisionReason).toContain('src/api/x.ts has been changing on Nick\'s ticket #141 "Donor API" (branch 5110-donorApi, in progress)');
    expect(first.hookSpecificOutput.permissionDecisionReason).toContain("read_house_ticket");
    expect(first.systemMessage).toMatch(/^Mockingbird: src\/api\/x\.ts has been changing on Nick's ticket #141/);

    const again = JSON.parse(await runHook("PreToolUse", claudeEdit(repo, "src/api/x.ts"), repo));
    expect(again.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(again.hookSpecificOutput.additionalContext).toMatch(/^Reminder from Mockingbird: src\/api\/x\.ts has been changing on Nick's ticket #141/);
    expect(again.systemMessage).toBeUndefined();

    // another conversation is warned afresh
    const other = JSON.parse(await runHook("PreToolUse", claudeEdit(repo, "src/api/x.ts", "conv-2"), repo));
    expect(other.hookSpecificOutput.permissionDecision).toBe("deny");

    // the app hears each one, and still gets the PreToolUse status event
    const warnings = events("ClaimWarning");
    expect(warnings.map((w) => w.payload.decision).sort()).toEqual(["context", "deny", "deny"]);
    expect(warnings[0]).toMatchObject({ pane: "p1", payload: { tool: "Edit", conflicts: [{ file: "src/api/x.ts", hits: [{ n: 141, branch: "5110-donorApi", owner: { name: "Nick" } }] }] } });
    expect(events("PreToolUse")).toHaveLength(3);
  });

  it("says nothing for my own claims, files no teammate's ticket changed (even next to one), tools that don't edit, and checkouts outside a room", async () => {
    const repo = roomCheckout();
    expect(await runHook("PreToolUse", claudeEdit(repo, "src/ui/y.ts"), repo)).toBe("");
    expect(await runHook("PreToolUse", claudeEdit(repo, "src/api/z.ts"), repo)).toBe("");
    expect(await runHook("PreToolUse", claudeEdit(repo, "README.md"), repo)).toBe("");
    expect(await runHook("PreToolUse", { ...claudeEdit(repo, "src/api/x.ts"), tool_name: "Bash", tool_input: { command: "echo > src/api/x.ts" } }, repo)).toBe("");
    const plain = makeRepo();
    expect(await runHook("PreToolUse", claudeEdit(plain, "src/api/x.ts"), plain)).toBe("");
    expect(events("ClaimWarning")).toEqual([]);
    expect(events("PreToolUse")).toHaveLength(5);
  });

  it("checks Codex's apply_patch the same way", async () => {
    const repo = roomCheckout();
    const patch = "*** Begin Patch\n*** Update File: src/api/x.ts\n@@\n-x\n+y\n*** End Patch\n";
    const out = JSON.parse(
      await runHook("PreToolUse", { session_id: "codex-1", transcript_path: "/Users/x/.codex/sessions/r.jsonl", cwd: repo, hook_event_name: "PreToolUse", turn_id: "t1", tool_name: "apply_patch", tool_use_id: "call_1", tool_input: { command: patch } }, repo)
    );
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("Nick's ticket #141");
  });

  it("forgets old conversations' warnings, so a long-gone conversation's markers don't pile up", async () => {
    const repo = roomCheckout();
    await runHook("PreToolUse", claudeEdit(repo, "src/api/x.ts", "old-conv"), repo);
    await runHook("PreToolUse", claudeEdit(repo, "src/api/x.ts", "new-conv"), repo);
    const old = path.join(CLAIMS_WARNED_DIR, "old-conv.json");
    const longAgo = (Date.now() - 30 * 24 * 3_600_000) / 1000;
    fs.utimesSync(old, longAgo, longAgo);
    pruneWarned(14 * 24 * 3_600_000);
    expect(fs.readdirSync(CLAIMS_WARNED_DIR)).toContain("new-conv.json");
    expect(fs.readdirSync(CLAIMS_WARNED_DIR)).not.toContain("old-conv.json");
  });

  it("never blocks an edit by failing: an unreadable claims file lets it run and tells the app", async () => {
    const repo = roomCheckout("{ not json");
    expect(await runHook("PreToolUse", claudeEdit(repo, "src/api/x.ts"), repo)).toBe("");
    expect(events("ClaimCheckFailed")).toMatchObject([{ pane: "p1", payload: { message: expect.stringMatching(/JSON/) } }]);
    expect(fs.readFileSync(CLAIMS_LOG, "utf8")).toMatch(/claims check failed/);
    expect(events("PreToolUse")).toHaveLength(1);
  });

  it("routes the check's events to the room's board, without touching a pane's status", async () => {
    fs.rmSync(eventsDir, { recursive: true, force: true });
    const seen: ClaimEvent[] = [];
    const statuses: string[] = [];
    const sessions = { statusFromHook: (ev: any) => (statuses.push(ev.status), { id: "p1", title: "t" }) };
    stops.push(watchEvents(sessions as any, () => {}, undefined, (e) => seen.push(e)));
    const repo = roomCheckout();
    await runHook("PreToolUse", claudeEdit(repo, "src/api/x.ts"), repo);
    const end = Date.now() + 5000;
    while (seen.length < 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(seen).toMatchObject([{ kind: "warning", warning: { pane: "p1", cwd: repo, conversation: "conv-1", decision: "deny", tool: "Edit" } }]);
    while (statuses.length < 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(statuses).toEqual(["working"]); // the PreToolUse itself
  });
});

describe("the SessionStart hook", () => {
  it("gives an agent in a room's checkout the room's instructions, and leaves its event (the pane is at its prompt)", async () => {
    const repo = roomCheckout();
    fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
    const start = { session_id: "c1", cwd: repo, hook_event_name: "SessionStart", source: "startup" };
    expect(await runHook("SessionStart", start, path.join(repo, "src", "deep"))).toBe("You're working in a Mockingbird team room.\n");
    expect(await runHook("SessionStart", start, repo, { [ROOM_CONTEXT_ENV]: "1" })).toBe("");
    expect(await runHook("SessionStart", start, makeRepo())).toBe("");
    expect(events("SessionStart").map((e) => e.payload)).toEqual([start, start, start]);
  });

  it("reads the main checkout's copy in a worktree too new to have its own", async () => {
    const repo = roomCheckout();
    const wt = path.join(tempDir("wt"), "fresh");
    git(repo, "worktree", "add", "-q", "-b", "fresh", wt);
    expect(fs.existsSync(path.join(wt, ".mockingbird"))).toBe(false);
    expect(await runHook("SessionStart", { session_id: "c1", cwd: wt, hook_event_name: "SessionStart", source: "startup" }, wt)).toBe("You're working in a Mockingbird team room.\n");
  });
});
