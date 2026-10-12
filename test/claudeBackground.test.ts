import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeRunner, freeForResume } from "../src/main/claudeBackground";
import { tempDir } from "./helpers";

/**
 * A stand-in for the `claude` CLI's session subcommands, as 2.1.296 has them:
 * `agents --json` prints the running sessions (from a state file) and
 * `stop <id>` ends a background one. Every call's arguments are logged, so a
 * test can tell nothing else (a prompt, say) was ever run.
 */
function fakeClaude(sessions: object[], behaviour: { agentViewOff?: boolean; stopFails?: boolean; stopIgnored?: boolean } = {}) {
  const dir = tempDir("fake-claude");
  const state = path.join(dir, "agents.json");
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(state, JSON.stringify(sessions));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
const b = ${JSON.stringify(behaviour)};
const list = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
if (args[0] === "agents" && args[1] === "--json") {
  if (b.agentViewOff) { process.stderr.write("'claude agents --json' is disabled by CLAUDE_CODE_DISABLE_AGENT_VIEW.\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify(list, null, 2) + "\\n");
} else if (args[0] === "stop" && args.length === 2) {
  const i = list.findIndex((s) => s.id === args[1]);
  if (i < 0 || b.stopFails) { process.stderr.write("No job matching '" + args[1] + "'. Run 'claude agents' to list running sessions.\\n"); process.exit(1); }
  if (!b.stopIgnored) list.splice(i, 1);
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(list));
} else {
  process.stderr.write("the fake claude was asked to run something else: " + args.join(" ") + "\\n");
  process.exit(3);
}
`,
    { mode: 0o755 }
  );
  return {
    run: claudeRunner(bin, process.env),
    calls: () => fs.readFileSync(log, "utf8").trim().split("\n"),
    running: () => JSON.parse(fs.readFileSync(state, "utf8")) as { id?: string }[],
  };
}

const CONV = "0b1c2d3e-1111-4222-8333-944455556670";
const cwd = "/Users/nick/Code/backoffice";
/** Entries as `claude agents --json` prints them: a background job, and an interactive session (no id). */
const background = (over: object = {}) => ({ pid: 4242, id: "ab12cd34", cwd, kind: "background", startedAt: 1791836030255, sessionId: CONV, name: "export-api", status: "idle", state: "done", ...over });
const interactive = (over: object = {}) => ({ pid: 4343, cwd, kind: "interactive", startedAt: 1791836030256, sessionId: CONV, status: "busy", ...over });

afterEach(() => vi.restoreAllMocks());

describe("freeing a Claude conversation for its pane to resume", () => {
  it("stops the background session running it, waits for it to let go, and says what it did", async () => {
    // the pane's own process from before, still exiting, is interactive: never touched
    const claude = fakeClaude([interactive(), background({ sessionId: CONV.toUpperCase() })]);
    const notice = await freeForResume(claude.run, CONV, { pollMs: 10 });
    expect(notice).toMatch(/running in Claude Code background session ab12cd34, outside its Mockingbird pane\. Mockingbird stopped it there/);
    expect(claude.calls()).toEqual(["agents --json", "stop ab12cd34", "agents --json"]);
    expect(claude.running()).toEqual([interactive()]);
  });

  it("leaves alone a conversation no background session runs", async () => {
    const claude = fakeClaude([
      interactive(),
      background({ sessionId: "another-conversation" }),
      background({ id: "ef56ab78", pid: undefined, status: undefined, state: "blocked" }), // a job no process runs doesn't hold it
    ]);
    expect(await freeForResume(claude.run, CONV)).toBeNull();
    expect(claude.calls()).toEqual(["agents --json"]);
  });

  it("won't stop one in the middle of a turn, and says how to go on", async () => {
    const claude = fakeClaude([background({ status: "busy" })]);
    await expect(freeForResume(claude.run, CONV)).rejects.toThrow(/middle of a turn in Claude Code background session ab12cd34.*Resume once that turn ends, or stop it now with `claude stop ab12cd34`/);
    expect(claude.calls()).toEqual(["agents --json"]);
  });

  it("says what to do when the background session can't be stopped", async () => {
    const noId = fakeClaude([background({ id: undefined })]);
    await expect(freeForResume(noId.run, CONV)).rejects.toThrow(/a Claude Code background session \(pid 4242\).*Find it with `claude agents`/);
    expect(noId.calls()).toEqual(["agents --json"]);

    const failing = fakeClaude([background()], { stopFails: true });
    await expect(freeForResume(failing.run, CONV)).rejects.toThrow(/stopping it failed: No job matching 'ab12cd34'.*Run `claude stop ab12cd34`, then resume/);

    const stuck = fakeClaude([background()], { stopIgnored: true });
    await expect(freeForResume(stuck.run, CONV, { settleMs: 100, pollMs: 20 })).rejects.toThrow(/Stopped Claude Code background session ab12cd34, but it was still running this conversation/);
  });

  it("resumes as usual when Claude can't be asked, logging why unless agent view is simply off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const off = fakeClaude([background()], { agentViewOff: true });
    expect(await freeForResume(off.run, CONV)).toBeNull();
    expect(warn).not.toHaveBeenCalled();

    const missing = claudeRunner(path.join(tempDir("no-claude"), "claude"), process.env);
    expect(await freeForResume(missing, CONV)).toBeNull();
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(new RegExp(`couldn't check whether conversation ${CONV} runs in a Claude Code background session; resuming it as usual`))]);
  });
});
