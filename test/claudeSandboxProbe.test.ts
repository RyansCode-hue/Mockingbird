import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { cliVersion } from "../src/main/agents";
import { claudeRoomSettings } from "../src/main/claudeRoomSandbox";
import { judgeSandbox, probeRoomSandbox, SANDBOX_PROBE_INPUT, sandboxProbeArgs, writtenSandbox, type SandboxProbe } from "../src/main/claudeSandboxProbe";
import { tempDir } from "./helpers";

const FAKE = path.join(__dirname, "fixtures", "fakeClaudeSandbox.cjs");

/** A room launch's Claude settings, as claudeRoomSettings writes them, for a folder and a WorkTracker of this test's. */
function roomSettings(o: { sockets?: string[] } = {}) {
  const wt = tempDir("wt");
  fs.mkdirSync(path.join(wt, "secrets"));
  fs.writeFileSync(path.join(wt, "config.json"), JSON.stringify({ azureDevOps: { orgUrl: "https://dev.azure.com/acme", project: "P", patFile: "secrets/ado.pat" } }));
  fs.writeFileSync(path.join(wt, "secrets", "ado.pat"), "not-a-real-pat\n");
  const folder = tempDir("work");
  const { settings } = claudeRoomSettings({ workTrackerPath: wt, git: null, hooks: [tempDir("hooks")], folders: [folder], caches: tempDir("caches"), ...(o.sockets ? { sockets: o.sockets } : {}) });
  return { settings, folder };
}

/** A stand-in claude binary: the fake run by this test's node, a way of going wrong, and a log of what it was given. */
function fakeClaude(mode: string) {
  const dir = tempDir("fake-claude");
  const bin = path.join(dir, "claude");
  const log = path.join(dir, "seen.json");
  fs.writeFileSync(bin, `#!/bin/bash\nMB_FAKE_SANDBOX=${mode} MB_FAKE_SANDBOX_LOG=${JSON.stringify(log)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`, { mode: 0o755 });
  return { bin, seen: () => JSON.parse(fs.readFileSync(log, "utf8")) as { argv: string[]; input: string; creds: string[] } };
}

function probe(mode: string, o: Partial<SandboxProbe> & { sockets?: string[] } = {}) {
  const { settings, folder } = roomSettings({ sockets: o.sockets });
  const fake = fakeClaude(mode);
  const p: SandboxProbe = {
    bin: fake.bin,
    settingsJson: JSON.stringify({ statusLine: { type: "command", command: "x" }, ...settings }),
    extraDirs: [],
    cwd: folder,
    version: "2.1.318",
    written: writtenSandbox(settings),
    // a credential in the environment the probe starts from: it's taken out before Claude Code starts
    env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-test-not-a-key" },
    ...o,
  };
  return { run: () => probeRoomSandbox(p), fake, settings };
}

describe("asking Claude Code for its own account of a room launch's sandbox", () => {
  it("is headless and --bare, never a user message: no turn runs, no model is called, no keychain or sign-in is read", () => {
    const args = sandboxProbeArgs('{"sandbox":{}}', ["/x/extra"]);
    for (const flag of ["-p", "--bare", "--strict-mcp-config", "--no-session-persistence", "--verbose"]) expect(args).toContain(flag);
    expect(args.join(" ")).toContain("--input-format stream-json --output-format stream-json");
    expect(args.join(" ")).toContain("--setting-sources user --settings {\"sandbox\":{}} --add-dir /x/extra");
    const sent = SANDBOX_PROBE_INPUT.trim().split("\n").map((l) => JSON.parse(l));
    expect(sent.map((m) => [m.type, m.request.subtype])).toEqual([
      ["control_request", "initialize"],
      ["control_request", "get_sandbox_dialog"],
    ]);
  });

  it("proves a sandbox that's on as the room wrote it, asked with the pane's own --settings and folder, no credential in reach", async () => {
    const { run, fake } = probe("good");
    const v = await run();
    expect(v).toMatchObject({ ok: true, why: null });
    expect(v.log).toMatch(/^ok: Claude Code 2\.1\.318, sandbox on, \d+ denyRead, \d+ denyWrite, 1 allowWrite, 1 allowRead as the room wrote them$/);
    const seen = fake.seen();
    expect(seen.argv).toContain("--bare");
    expect(seen.argv.slice(0, 7)).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--bare"]);
    expect(seen.input).toBe(SANDBOX_PROBE_INPUT);
    expect(seen.input).not.toMatch(/"type":"user"/);
    expect(seen.creds).toEqual([]);
  });

  it("keeps the line closed for each way Claude Code reads the room's sandbox otherwise, saying how", async () => {
    const cases: [string, RegExp][] = [
      ["enabled-renamed", /^Claude Code 2\.1\.318 reads the room's settings with its sandbox off \(its sandbox\.enabled setting isn't one it knows, most likely\)$/],
      ["filesystem-renamed", /^Claude Code 2\.1\.318 doesn't apply the room's sandbox as written: \d+ of its denyRead paths and \d+ of its denyWrite paths aren't denied/],
      ["denyRead-renamed", /^Claude Code 2\.1\.318 doesn't apply the room's sandbox as written: \d+ of its denyRead paths aren't denied \(a setting it reads under another name now, most likely\)$/],
      ["allowUnsandboxed-renamed", /^Claude Code 2\.1\.318 would run a command that fails in the sandbox outside it \(the room's allowUnsandboxedCommands isn't applied\)$/],
      ["not-started", /^Claude Code 2\.1\.318's sandbox didn't start \(sandbox-exec is missing\)$/],
      ["deps", /^Claude Code 2\.1\.318's sandbox is missing what it needs: ripgrep \(rg\) not found$/],
      ["remote-unknown", /^your organization's managed Claude Code settings couldn't be read/],
      ["missing-field", /^Claude Code 2\.1\.318 no longer reports its sandbox as Mockingbird reads it \(get_sandbox_dialog has no restrictions\)$/],
      ["version", /^the Claude Code that answered Mockingbird's sandbox check is 9\.9\.9, not 2\.1\.318 as the pane is/],
      ["no-dialog", /^Claude Code 2\.1\.318 no longer reports its sandbox \(it didn't answer get_sandbox_dialog\)$/],
      ["dialog-error", /^Claude Code 2\.1\.318 no longer reports its sandbox \(get_sandbox_dialog: Unknown control request: get_sandbox_dialog\)$/],
      ["non-json", /^Mockingbird's check of its sandbox failed: Claude Code Error: unknown option '--bare'$/],
    ];
    const got = await Promise.all(cases.map(([mode]) => probe(mode).run()));
    for (const [i, [mode, why]] of cases.entries()) {
      expect(got[i].ok, mode).toBe(false);
      expect(got[i].why, mode).toMatch(why);
      expect(got[i].log, mode).toMatch(/^refused: /);
    }
  });

  it("names what the user's own settings add that a room pane can't run under, what to change, and that other panes are unaffected; the log has counts, not their paths", async () => {
    const [excluded, socket, all, write] = await Promise.all(["excluded", "extra-socket", "all-sockets", "extra-write"].map((m) => probe(m).run()));
    const tail = ", which room panes can't run under. Move them to the settings of the projects that need them (.claude/settings.local.json there), which room panes don't read. Your panes outside rooms aren't affected";
    expect(excluded.why).toBe(`your ~/.claude/settings.json sandbox has excludedCommands ["docker *"] (they run outside the sandbox)${tail}`);
    expect(socket.why).toBe(`your ~/.claude/settings.json sandbox has network.allowUnixSockets ["/var/run/docker.sock"]${tail}`);
    expect(all.why).toBe(`your ~/.claude/settings.json sandbox has network.allowAllUnixSockets (a Docker daemon's socket would reach every folder)${tail}`);
    expect(write.why).toBe(`your ~/.claude/settings.json sandbox has filesystem.allowWrite ["~/Documents/private-notes"]${tail}`);
    expect(write.log).toBe("refused: Claude Code 2.1.318: the user's settings add 1 allowWrite path");
    expect(excluded.log).toBe("refused: Claude Code 2.1.318: the user's settings add 1 excluded command");
  });

  it("allows the sockets the room itself allows (a Council seat's Docker daemon), and only those", async () => {
    expect((await probe("good", { sockets: ["/var/run/docker.sock"] }).run()).ok).toBe(true);
  });

  it("gives up after its time, keeping the line closed and leaving nothing running", async () => {
    const v = await probe("timeout", { timeoutMs: 1_000 }).run();
    expect(v).toEqual({ ok: false, why: "Mockingbird's check of its sandbox got no answer from Claude Code within 1 second", log: "refused: timed out" });
  });

  it("can't be matched to a pane whose version isn't known", async () => {
    expect((await probe("good", { version: null }).run()).why).toMatch(/^the pane's Claude Code version isn't known/);
  });

  it("reads only control responses: other JSON on stdout and lines that aren't JSON are passed over", () => {
    const { settings } = roomSettings();
    const w = writtenSandbox(settings);
    const answer = (d: object) =>
      [
        "zsh: some rc-file noise",
        JSON.stringify({ type: "system", subtype: "status" }),
        JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "mockingbird-initialize", response: { claude_code_version: "2.1.318" } } }),
        JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "mockingbird-sandbox", response: d } }),
      ].join("\n");
    const ok = {
      enabled: true,
      enabled_in_settings: true,
      unsandboxed_fallback: false,
      dependencies: { errors: [] },
      excluded_commands: [],
      policy_origins: [],
      restrictions: { fs_deny_read: w.denyRead, fs_deny_write: w.denyWrite, fs_allow_write: w.allowWrite, fs_allow_read: w.allowRead, unix_sockets: [], allow_all_unix_sockets: false },
    };
    expect(judgeSandbox(answer(ok), { version: "2.1.318", written: w }).ok).toBe(true);
    expect(judgeSandbox(answer({ ...ok, enabled: "yes" }), { version: "2.1.318", written: w }).why).toMatch(/has no enabled\)$/);
    expect(judgeSandbox("Not logged in · Please run /login", { version: "2.1.318", written: w }).why).toBe("Claude Code's answer to Mockingbird's sandbox check wasn't JSON");
  });
});

/** The installed Claude Code, when there is one: these run it, not signed in (this file's HOME), with no model call. */
const realClaude = (() => {
  if (process.env.CI) return null;
  for (const bin of ["claude", path.join(os.userInfo().homedir, ".local", "bin", "claude")]) {
    try {
      const v = cliVersion(execFileSync(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 }));
      if (v) return { bin, version: v };
    } catch {
      // not there: the next, or these are skipped
    }
  }
  return null;
})();

describe.skipIf(!realClaude)("the installed Claude Code's own account of a room launch's sandbox", () => {
  const real = (settings: Record<string, unknown>, folder: string, written = writtenSandbox(settings)) =>
    probeRoomSandbox({ bin: realClaude!.bin, settingsJson: JSON.stringify(settings), extraDirs: [], cwd: folder, version: realClaude!.version, written, timeoutMs: 30_000 });

  it("shows the room's sandbox on as written, and off once sandbox.enabled is a name it doesn't know", async () => {
    const { settings, folder } = roomSettings();
    const ok = await real(settings, folder);
    expect(ok.log).toMatch(/^ok: /);
    expect(ok.ok).toBe(true);
    const sandbox = { ...(settings.sandbox as Record<string, unknown>) };
    sandbox.enabledRenamed = sandbox.enabled;
    delete sandbox.enabled;
    const off = await real({ ...settings, sandbox }, folder, writtenSandbox(settings));
    expect(off.why).toBe(`Claude Code ${realClaude!.version} reads the room's settings with its sandbox off (its sandbox.enabled setting isn't one it knows, most likely)`);
  }, 90_000);

  it("names the excluded commands the user's own settings add", async () => {
    const { settings, folder } = roomSettings();
    const userSettings = path.join(os.homedir(), ".claude", "settings.json");
    fs.mkdirSync(path.dirname(userSettings), { recursive: true });
    fs.writeFileSync(userSettings, JSON.stringify({ sandbox: { excludedCommands: ["docker *"] } }));
    try {
      expect((await real(settings, folder)).why).toMatch(/^your ~\/\.claude\/settings\.json sandbox has excludedCommands \["docker \*"\] \(they run outside the sandbox\), which room panes can't run under/);
    } finally {
      fs.rmSync(userSettings);
    }
  }, 60_000);
});
