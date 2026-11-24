import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_DIR, claudeContext, reporterPlan, usageReporterSettings } from "../src/main/usage";
import { tempDir } from "./helpers";

// Mockingbird's statusline reporter wraps the user's own status line rather than replacing it: the payload is saved,
// then their command runs on it as Claude Code would run it, its output and exit status passed through.

const mb = path.join(os.homedir(), ".mockingbird");
const userSettings = path.join(os.homedir(), ".claude", "settings.json");
const ID = "5e1b2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const PAYLOAD = JSON.stringify({
  session_id: ID,
  model: { id: "claude-opus-4-7" },
  context_window: { total_input_tokens: 1200, context_window_size: 200_000 },
  rate_limits: { seven_day: { used_percentage: 3, resets_at: 9 } },
});

function writeStatusLine(file: string, statusLine: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ statusLine }));
}

type Run = { out: string; err: string; status: number | null };
/** A program run with the payload on stdin, in `cwd`, with `env`: as Claude Code runs a status line. */
function run(file: string, args: string[], cwd: string, env: Record<string, string>): Run {
  const r = spawnSync(file, args, { input: PAYLOAD, cwd, env: { PATH: process.env.PATH!, HOME: os.homedir(), ...env }, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, status: r.status };
}
/** A shell-form status line's command, run with /bin/sh -c as Claude Code runs one. */
const runShell = (command: string, cwd: string, env: Record<string, string> = {}) => run("/bin/sh", ["-c", command], cwd, env);

afterEach(() => {
  fs.rmSync(path.dirname(userSettings), { recursive: true, force: true });
  fs.rmSync(CONTEXT_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(mb, "usage.json"), { force: true });
  vi.restoreAllMocks();
});

describe("the reporter wrapping the user's own status line", () => {
  it("saves the payload, then runs their command once as written, in the folder and environment it's given, with their output and exit status", () => {
    const folder = tempDir("pane");
    // quotes, $(…) and backticks the shell runs, and the same quoted so it mustn't: a re-read would run those too
    const own =
      'echo ran >> "$MARK"; printf \'%s|%s|%s|%s|%s\\n\' "it\'s" \'say "hi"\' "$(echo sub)" "`echo tick`" \'$(echo never) `echo never`\'; ' +
      'pwd; printf \'%s %s %s\\n\' "$PANE_VAR" "é ✓" \'\\n\'; head -c 25; exit 3';
    writeStatusLine(userSettings, { type: "command", command: own, padding: 2 });
    const statusLine = usageReporterSettings({ cwd: folder })!.statusLine;
    expect(statusLine).toMatchObject({ type: "command", padding: 2 });
    expect(statusLine.command).toMatch(/statusline\.sh" '(\\x[0-9a-f]{2})+'$/);

    const wrapped = runShell(String(statusLine.command), folder, { MARK: path.join(folder, "mark"), PANE_VAR: "pane value" });
    const direct = runShell(own, folder, { MARK: path.join(folder, "mark-direct"), PANE_VAR: "pane value" });
    expect(wrapped).toEqual(direct);
    expect(wrapped.status).toBe(3);
    expect(wrapped.out.split("\n")[0]).toBe("it's|say \"hi\"|sub|tick|$(echo never) `echo never`");
    expect(wrapped.out).toContain(`pane value é ✓ \\n\n${PAYLOAD.slice(0, 25)}`);
    expect(fs.readFileSync(path.join(folder, "mark"), "utf8")).toBe("ran\n");

    expect(JSON.parse(fs.readFileSync(path.join(CONTEXT_DIR, `${ID}.json`), "utf8")).model.id).toBe("claude-opus-4-7");
    expect(JSON.parse(fs.readFileSync(path.join(mb, "usage.json"), "utf8")).rate_limits.seven_day.used_percentage).toBe(3);
    expect(fs.readdirSync(mb).filter((f) => /\.\d+$/.test(f))).toEqual([]); // no copy of the payload left behind
  });

  it("passes a quiet status line's success through, and draws it from a payload with no limits too", () => {
    const folder = tempDir("pane");
    writeStatusLine(userSettings, { type: "command", command: "cat > /dev/null; printf 'model: ok'" });
    const statusLine = usageReporterSettings({ cwd: folder })!.statusLine;
    const r = spawnSync("/bin/sh", ["-c", String(statusLine.command)], { input: JSON.stringify({ model: { id: "x" } }), cwd: folder, encoding: "utf8" });
    expect({ out: r.stdout, status: r.status }).toEqual({ out: "model: ok", status: 0 });
    expect(fs.existsSync(path.join(mb, "usage.json"))).toBe(false); // nothing to keep: dropped as before
  });

  it("refuses, saying so and running nothing, an argument that isn't a statusLine it wrote", () => {
    usageReporterSettings();
    const r = run(path.join(mb, "statusline.sh"), ["echo ran"], tempDir("pane"), {});
    expect(r).toEqual({ out: "", err: expect.stringContaining("can't read: echo ran"), status: 1 });
    expect(fs.existsSync(path.join(CONTEXT_DIR, `${ID}.json`))).toBe(true); // the payload is kept all the same
  });

  it("keeps an exec-form status line exec form: its program and arguments run as given, no shell between", () => {
    const folder = tempDir("pane");
    const args = ["-c", 'printf "%s;" "$0" "$1"; head -c 12', "first arg", "it's $(not) `run`"];
    writeStatusLine(userSettings, { type: "command", command: "/bin/sh", args, shell: "bash", refreshInterval: 5 });
    const statusLine = usageReporterSettings({ cwd: folder })!.statusLine;
    expect(statusLine).toEqual({ type: "command", command: path.join(mb, "statusline.sh"), args: ["--exec", "/bin/sh", ...args], refreshInterval: 5 });
    const wrapped = run(String(statusLine.command), statusLine.args as string[], folder, {});
    expect(wrapped).toEqual(run("/bin/sh", args, folder, {}));
    expect(wrapped.out).toBe(`first arg;it's $(not) \`run\`;${PAYLOAD.slice(0, 12)}`);
    expect(fs.existsSync(path.join(CONTEXT_DIR, `${ID}.json`))).toBe(true);
  });

  it("wraps only the user's own status line; a folder's project or local statusLine is left to Claude Code, which runs it once the folder is trusted; a room launch reads the user's alone", () => {
    const folder = tempDir("pane");
    writeStatusLine(userSettings, { type: "command", command: "echo user", padding: 1 });
    const own = usageReporterSettings({ cwd: folder })!.statusLine;
    expect(own.padding).toBe(1);
    expect(runShell(String(own.command), folder).out).toBe("user\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeStatusLine(path.join(folder, ".claude", "settings.local.json"), { type: "command", command: "echo local", refreshInterval: 2 });
    expect(reporterPlan(folder, false)).toEqual({ kind: "off", why: expect.stringContaining("settings.local.json has its own statusLine") });
    fs.rmSync(path.join(folder, ".claude", "settings.local.json"));
    writeStatusLine(path.join(folder, ".claude", "settings.json"), { type: "command", command: "echo project" });
    expect(usageReporterSettings({ cwd: folder })).toBeNull();
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("has its own statusLine");
    // the payload the wrapped line saved above would answer first: with none, the meter says why there's no report
    fs.rmSync(path.join(CONTEXT_DIR, `${ID}.json`), { force: true });
    expect(claudeContext(ID, CONTEXT_DIR, folder)).toEqual({ state: "none", why: expect.stringMatching(/^Not reported: .*settings\.json has its own statusLine/) });
    warn.mockRestore();
    const room = usageReporterSettings({ cwd: folder, userOnly: true })!.statusLine;
    expect(room.padding).toBe(1);
    expect(runShell(String(room.command), folder).out).toBe("user\n");
    // one that names no type is a command still; one of another type, or with no command, draws nothing of its own
    writeStatusLine(userSettings, { command: "echo untyped" });
    expect(reporterPlan(null, false)).toEqual({ kind: "wraps", own: { command: "echo untyped" } });
    writeStatusLine(userSettings, { type: "static", command: "echo other" });
    expect(reporterPlan(null, false)).toEqual({ kind: "alone" });
    writeStatusLine(userSettings, { type: "command", padding: 1 });
    expect(reporterPlan(null, false)).toEqual({ kind: "alone" });
    // no statusLine anywhere: the reporter alone, drawing nothing
    fs.rmSync(userSettings);
    expect(reporterPlan(null, false)).toEqual({ kind: "alone" });
    expect(usageReporterSettings()!.statusLine).toEqual({ type: "command", command: `"${path.join(mb, "statusline.sh")}"` });
  });

  it("leaves the status line to the user, and the context meter says why, when it can't run theirs or can't read the settings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeStatusLine(userSettings, { type: "command", command: "Write-Output hi", shell: "powershell" });
    expect(usageReporterSettings()).toBeNull();
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("powershell");
    expect(claudeContext(ID)).toEqual({ state: "none", why: expect.stringMatching(/^Not reported: .*powershell/) });
    fs.writeFileSync(userSettings, "{not json");
    expect(usageReporterSettings()).toBeNull();
    expect(claudeContext(ID)).toEqual({ state: "none", why: expect.stringMatching(/^Not reported: .*settings\.json couldn't be read/) });
    // a project's that can't be read leaves out only the panes in that folder
    const folder = tempDir("pane");
    writeStatusLine(userSettings, { type: "command", command: "echo mine" });
    fs.mkdirSync(path.join(folder, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(folder, ".claude", "settings.local.json"), "{half");
    expect(usageReporterSettings({ cwd: folder })).toBeNull();
    expect(usageReporterSettings({ cwd: folder, userOnly: true })).not.toBeNull();
    expect(claudeContext(ID, CONTEXT_DIR, folder)).toEqual({ state: "none", why: expect.stringContaining("settings.local.json couldn't be read") });
    expect(claudeContext(ID)).toEqual({ state: "none", why: expect.stringContaining("No report yet") });
  });
});
