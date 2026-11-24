import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readUsage, setClaudePlan, usageReporterSettings } from "../src/main/usage";

const mb = path.join(os.homedir(), ".mockingbird");
const writeClaude = (payload: unknown) => {
  fs.mkdirSync(mb, { recursive: true });
  fs.writeFileSync(path.join(mb, "usage.json"), JSON.stringify(payload));
};
const codexDir = path.join(os.homedir(), ".codex", "sessions", "2026", "09", "24");

beforeEach(() => {
  fs.rmSync(path.join(mb, "usage.json"), { force: true });
  fs.rmSync(path.join(mb, "usage-5h.json"), { force: true });
  fs.rmSync(path.join(os.homedir(), ".codex"), { recursive: true, force: true });
  setClaudePlan(null);
});

describe("Claude usage", () => {
  it("is null until a session has reported", () => {
    expect(readUsage().claude).toBeNull();
  });
  it("reads the 5-hour and weekly windows, plus model weeklies when present, and the plan", () => {
    setClaudePlan("max");
    writeClaude({
      rate_limits: {
        five_hour: { used_percentage: 5, resets_at: 1790289000 },
        seven_day: { used_percentage: 18, resets_at: "2026-09-27T18:00:00Z" },
        seven_day_opus: { used_percentage: 13, resets_at: 1790532000 },
        seven_day_oauth_apps: { used_percentage: 99, resets_at: 1790532000 },
      },
    });
    const c = readUsage().claude!;
    expect(c.plan).toBe("Max");
    expect(c.limits).toEqual([
      { label: "5-hour limit", window: "5h", usedPct: 5, resetsAt: 1790289000_000 },
      { label: "Weekly · all models", window: "week", usedPct: 18, resetsAt: Date.parse("2026-09-27T18:00:00Z") },
      { label: "Weekly · Opus", window: "week", model: "Opus", usedPct: 13, resetsAt: 1790532000_000 },
    ]);
  });
  it("keeps the 5-hour window from an earlier report while it's open, when the latest leaves it out", () => {
    const later = Math.floor(Date.now() / 1000) + 3600;
    fs.writeFileSync(path.join(mb, "usage-5h.json"), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42, resets_at: later } } }));
    writeClaude({ rate_limits: { seven_day: { used_percentage: 11, resets_at: later + 86400 } } });
    expect(readUsage().claude!.limits.map((l) => [l.label, l.usedPct])).toEqual([["5-hour limit", 42], ["Weekly · all models", 11]]);
  });
  it("says there's no 5-hour reading, rather than hiding the row, once that window has closed", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    fs.writeFileSync(path.join(mb, "usage-5h.json"), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 80, resets_at: past } } }));
    writeClaude({ rate_limits: { seven_day: { used_percentage: 11, resets_at: past + 86400 * 3 } } });
    expect(readUsage().claude!.limits[0]).toEqual({ label: "5-hour limit", window: "5h", usedPct: 0, resetsAt: null, note: "no reading yet" });
  });
  it("the reporter keeps the last payload that had the 5-hour window", () => {
    usageReporterSettings();
    const report = (payload: unknown) => execFileSync(path.join(mb, "statusline.sh"), { input: JSON.stringify(payload) });
    report({ rate_limits: { five_hour: { used_percentage: 7, resets_at: 1 }, seven_day: { used_percentage: 1, resets_at: 2 } } });
    report({ rate_limits: { seven_day: { used_percentage: 2, resets_at: 2 } } });
    report({ model: { id: "x" } }); // no limits yet: dropped
    expect(JSON.parse(fs.readFileSync(path.join(mb, "usage.json"), "utf8")).rate_limits).toEqual({ seven_day: { used_percentage: 2, resets_at: 2 } });
    expect(JSON.parse(fs.readFileSync(path.join(mb, "usage-5h.json"), "utf8")).rate_limits.five_hour.used_percentage).toBe(7);
  });
  it("is null for an API-key login (no rate limits) or a corrupt file", () => {
    writeClaude({ rate_limits: null });
    expect(readUsage().claude).toBeNull();
    fs.writeFileSync(path.join(mb, "usage.json"), "{not json");
    expect(readUsage().claude).toBeNull();
  });
});

describe("Codex usage", () => {
  const event = (rl: unknown, ts = "2026-09-24T16:07:39.339Z") =>
    JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", rate_limits: rl } });

  it("reads the newest rate-limit event from the session log", () => {
    fs.mkdirSync(codexDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/x" } }),
      event({ primary: { used_percent: 10, window_minutes: 300, resets_at: 1 }, plan_type: "plus" }, "2026-09-24T15:00:00Z"),
      JSON.stringify({ type: "response_item", payload: { text: "unrelated" } }),
      event({ primary: { used_percent: 1, window_minutes: 300, resets_at: 1790284045 }, secondary: { used_percent: 4, window_minutes: 10080, resets_at: 1790616570 }, plan_type: "plus" }),
    ];
    fs.writeFileSync(path.join(codexDir, "rollout-a.jsonl"), lines.join("\n") + "\n");
    const c = readUsage().codex!;
    expect(c).toMatchObject({ agent: "codex", plan: "Plus", at: Date.parse("2026-09-24T16:07:39.339Z") });
    expect(c.limits).toEqual([
      { label: "5-hour limit", window: "5h", usedPct: 1, resetsAt: 1790284045_000 },
      { label: "Weekly limit", window: "week", usedPct: 4, resetsAt: 1790616570_000 },
    ]);
  });
  it("shows nothing rather than a guess when the format isn't recognised", () => {
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "rollout-b.jsonl"), event({ something_new: { pct: 5 } }) + "\n");
    expect(readUsage().codex).toBeNull();
  });
  it("has no reading, and says why, when Codex's sessions folder can't be listed", () => {
    const sessions = path.join(os.homedir(), ".codex", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.chmodSync(sessions, 0o000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(readUsage().codex).toBeNull();
      expect(String(warn.mock.calls[0]?.[0])).toContain(sessions);
    } finally {
      fs.chmodSync(sessions, 0o755);
      warn.mockRestore();
    }
  });
});

describe("usageReporterSettings", () => {
  const settings = path.join(os.homedir(), ".claude", "settings.json");
  it("adds Mockingbird's statusline when the user has none", () => {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ hooks: {} }));
    expect(usageReporterSettings()!.statusLine.command).toContain("statusline.sh");
  });
  it("leaves the reporter script alone while it's current, and replaces it in one step when it isn't", () => {
    fs.rmSync(settings, { force: true });
    const script = path.join(mb, "statusline.sh");
    usageReporterSettings();
    const first = fs.statSync(script).ino;
    usageReporterSettings(); // every Claude launch: running panes may be executing it right now
    expect(fs.statSync(script).ino).toBe(first);
    fs.writeFileSync(script, "#!/bin/bash\n# an older build's\n");
    const running = fs.openSync(script, "r");
    usageReporterSettings();
    const buf = Buffer.alloc(64);
    expect(buf.toString("utf8", 0, fs.readSync(running, buf, 0, 64, 0))).toContain("an older build's"); // undisturbed
    fs.closeSync(running);
    expect(fs.readFileSync(script, "utf8")).toContain("Mockingbird usage reporter");
    expect(fs.statSync(script).mode & 0o777).toBe(0o755);
  });
  it("wraps the user's own statusLine rather than replacing it (statuslineWrap.test.ts runs it)", () => {
    fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "mine.sh", padding: 0 } }));
    expect(usageReporterSettings()!.statusLine).toEqual({ type: "command", command: `"${path.join(mb, "statusline.sh")}" '\\x6d\\x69\\x6e\\x65\\x2e\\x73\\x68'`, padding: 0 });
  });
});
