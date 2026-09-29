import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { installHooks, hookStatus, hooksInstalled, watchEvents } from "../src/main/hooks";

const claudeSettings = path.join(os.homedir(), ".claude", "settings.json");
const codexHooks = path.join(os.homedir(), ".codex", "hooks.json");
const fakeCodex = path.join(os.homedir(), "bin", "codex");
const events = path.join(os.homedir(), ".mockingbird", "events.jsonl");

afterEach(() => {
  fs.rmSync(path.dirname(claudeSettings), { recursive: true, force: true });
  fs.rmSync(path.dirname(codexHooks), { recursive: true, force: true });
});

describe("installHooks", () => {
  it("adds its hooks next to the user's own, keeping every other setting", () => {
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    const mine = { hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] }, model: "opus" };
    fs.writeFileSync(claudeSettings, JSON.stringify(mine));
    installHooks(null);
    const s = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
    expect(s.model).toBe("opus");
    expect(s.hooks.Stop).toHaveLength(2);
    expect(JSON.stringify(s.hooks.Stop[0])).toContain("say done");
    for (const ev of ["Stop", "Notification", "UserPromptSubmit", "PreToolUse"]) expect(JSON.stringify(s.hooks[ev])).toContain("hook.sh");
  });
  it("is idempotent", () => {
    installHooks(null);
    installHooks(null);
    expect(JSON.parse(fs.readFileSync(claudeSettings, "utf8")).hooks.Stop).toHaveLength(1);
  });
  it("refuses to overwrite a settings file it can't parse", () => {
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.writeFileSync(claudeSettings, "{ broken");
    expect(() => installHooks(null)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(claudeSettings, "utf8")).toBe("{ broken");
  });
  it("writes Codex hooks only when the Codex CLI is installed — ~/.codex alone isn't enough", () => {
    fs.mkdirSync(path.dirname(codexHooks), { recursive: true }); // what the ChatGPT desktop app leaves behind
    installHooks(null);
    expect(fs.existsSync(codexHooks)).toBe(false);
    expect(hookStatus(null)).toEqual({ claude: true, codex: null });
    expect(hooksInstalled(null)).toBe(true);

    fs.mkdirSync(path.dirname(fakeCodex), { recursive: true });
    fs.writeFileSync(fakeCodex, "#!/bin/sh\n");
    expect(hooksInstalled(fakeCodex)).toBe(false); // Codex present, its hooks not yet wired
    installHooks(fakeCodex);
    const c = JSON.parse(fs.readFileSync(codexHooks, "utf8"));
    for (const ev of ["Stop", "PermissionRequest", "UserPromptSubmit", "PreToolUse", "PostToolUse"]) expect(JSON.stringify(c.hooks[ev])).toContain("hook.sh");
    expect(hookStatus(fakeCodex)).toEqual({ claude: true, codex: true });
  });
});

describe("hook script", () => {
  it("records the pane the event came from, inherited through the agent's environment", () => {
    installHooks(null);
    const script = path.join(os.homedir(), ".mockingbird", "hook.sh");
    const before = fs.existsSync(events) ? fs.readFileSync(events, "utf8").length : 0;
    execFileSync(script, ["Stop"], { input: JSON.stringify({ session_id: "c9", cwd: "/w" }), env: { ...process.env, MOCKINGBIRD_SESSION: "pane42" } });
    execFileSync(script, ["Stop"], { input: JSON.stringify({ session_id: "c9", cwd: "/w" }), env: { ...process.env, MOCKINGBIRD_SESSION: "" } });
    const [inPane, outside] = fs.readFileSync(events, "utf8").slice(before).trim().split("\n").map((l) => JSON.parse(l));
    expect(inPane).toMatchObject({ event: "Stop", pane: "pane42", payload: { session_id: "c9", cwd: "/w" } });
    expect(outside.pane).toBe("");
  });
});

describe("watchEvents", () => {
  it("turns hook events into session statuses, routed by pane and conversation", async () => {
    installHooks(null); // creates events.jsonl
    const seen: any[] = [];
    const fakeSessions = {
      statusFromHook: (ev: any) => {
        seen.push([ev.status, ev.reason, ev.paneId, ev.conversationId, ev.agent]);
        return { id: "s1", title: "t" } as any;
      },
    };
    watchEvents(fakeSessions as any, () => {});
    const line = (event: string, payload: object, pane = "p1") => JSON.stringify({ event, ts: 1, pane, payload: { cwd: "/w", session_id: "c1", ...payload } }) + "\n";
    fs.appendFileSync(
      events,
      line("UserPromptSubmit", { transcript_path: "/h/.claude/projects/x/c1.jsonl" }) +
        line("Notification", { message: "Claude needs your permission to use Bash" }) +
        line("PreToolUse", {}) +
        line("Notification", { message: "Claude is waiting for your input" }) +
        line("PermissionRequest", { tool_name: "Bash", transcript_path: "/h/.codex/sessions/r.jsonl" }) +
        line("Stop", {}, "") +
        "not json\n" +
        JSON.stringify({ event: "Stop", payload: {} }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 1500));
    fs.unwatchFile(events);
    expect(seen).toEqual([
      ["working", undefined, "p1", "c1", "claude"],
      ["waiting", "Claude needs your permission to use Bash", "p1", "c1", "claude"],
      ["working", undefined, "p1", "c1", "claude"],
      ["idle", undefined, "p1", "c1", "claude"], // the idle reminder isn't "blocked on you"
      ["waiting", "Codex needs your permission to use Bash", "p1", "c1", "codex"],
      ["idle", undefined, undefined, "c1", "claude"], // no pane (agent run outside Mockingbird): cwd + conversation decide
    ]);
  });
});
