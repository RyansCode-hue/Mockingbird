import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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

describe("watchEvents", () => {
  it("turns hook events into session statuses", async () => {
    installHooks(null); // creates events.jsonl
    const seen: [string, string, string | undefined, string | undefined][] = [];
    const fakeSessions = {
      statusByCwd: (cwd: string, status: string, reason?: string, id?: string) => {
        seen.push([cwd, status, reason, id]);
        return { id: "s1", title: "t" } as any;
      },
    };
    watchEvents(fakeSessions as any, () => {});
    const line = (event: string, payload: object) => JSON.stringify({ event, ts: 1, payload: { cwd: "/w", session_id: "c1", ...payload } }) + "\n";
    fs.appendFileSync(
      events,
      line("UserPromptSubmit", {}) +
        line("Notification", { message: "Claude needs your permission to use Bash" }) +
        line("PreToolUse", {}) +
        line("Notification", { message: "Claude is waiting for your input" }) +
        line("PermissionRequest", { tool_name: "Bash" }) +
        line("Stop", {}) +
        "not json\n" +
        JSON.stringify({ event: "Stop", payload: {} }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 1500));
    fs.unwatchFile(events);
    expect(seen).toEqual([
      ["/w", "working", undefined, "c1"],
      ["/w", "waiting", "Claude needs your permission to use Bash", "c1"],
      ["/w", "working", undefined, "c1"],
      ["/w", "idle", undefined, "c1"], // the idle reminder isn't "blocked on you"
      ["/w", "waiting", "Codex needs your permission to use Bash", "c1"],
      ["/w", "idle", undefined, "c1"],
    ]);
  });
});
