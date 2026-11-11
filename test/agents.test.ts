import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpLaunch } from "../src/main/messaging";

const mcp: McpLaunch = { command: "/Apps/Mockingbird", args: ["/h/.mockingbird/mcp.js"], env: { MOCKINGBIRD_SESSION: "abc12345", ELECTRON_RUN_AS_NODE: "1" } };
const base = { repoPath: null, useWorktree: false };

// agents.ts caches its Codex index for 30s, so each test loads a fresh copy
let agentFor: typeof import("../src/main/agents").agentFor;
let agentLabel: typeof import("../src/main/agents").agentLabel;
let codexMcpOff: typeof import("../src/main/agents").codexMcpOff;
let listsChromeFlag: typeof import("../src/main/agents").listsChromeFlag;
beforeEach(async () => {
  vi.resetModules();
  ({ agentFor, agentLabel, codexMcpOff, listsChromeFlag } = await import("../src/main/agents"));
});

function rollout(cwd: string, source: string, day = "01"): void {
  const dir = path.join(os.homedir(), ".codex", "sessions", "2026", "09", day);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { type: "session_meta", payload: { id: "x", cwd, originator: "codex-tui", source } };
  fs.writeFileSync(path.join(dir, `rollout-${source}-${Math.random().toString(36).slice(2)}.jsonl`), JSON.stringify(meta) + "\n");
}

describe("Claude launch", () => {
  it("resumes, sets model and effort, and wires the Mockingbird MCP server with its tools pre-approved", () => {
    const args = agentFor("claude").launchArgs({ ...base, resume: true, model: "opus", effort: "high", extraDirs: ["~/shared"] }, { mcp });
    expect(args.slice(0, 7)).toEqual(["--continue", "--model", "opus", "--effort", "high", "--add-dir", path.join(os.homedir(), "shared")]);
    const cfg = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    expect(cfg.mcpServers.mockingbird).toEqual({ type: "stdio", ...mcp });
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(
      "mcp__mockingbird__list_sessions,mcp__mockingbird__send_message,mcp__mockingbird__list_links,mcp__mockingbird__finish_step,mcp__mockingbird__read_context,mcp__mockingbird__read_terminal,mcp__mockingbird__set_stage,mcp__mockingbird__request_pr,mcp__mockingbird__write_patch_notes"
    );
  });
  it("resumes a specific conversation by id", () => {
    expect(agentFor("claude").launchArgs({ ...base, resumeSessionId: "uuid-1" }, { mcp }).slice(0, 2)).toEqual(["--resume", "uuid-1"]);
  });
  it("gives a room's sandbox and the status line in one --settings; without one, the status line's file as before", () => {
    const room = agentFor("claude").launchArgs({ ...base }, { claudeSettings: { sandbox: { enabled: true } } });
    expect(room.filter((a) => a === "--settings")).toHaveLength(1);
    expect(JSON.parse(room[room.indexOf("--settings") + 1])).toEqual({ statusLine: { type: "command", command: expect.stringMatching(/statusline\.sh"$/) }, sandbox: { enabled: true } });
    // a room launch reads no settings but the user's (where Mockingbird's hooks are) and runs no MCP server but Mockingbird's
    expect(room.slice(room.indexOf("--settings") + 2, room.indexOf("--settings") + 5)).toEqual(["--setting-sources", "user", "--strict-mcp-config"]);
    const local = agentFor("claude").launchArgs({ ...base }, {});
    expect(local[local.indexOf("--settings") + 1]).toMatch(/statusline-settings\.json$/);
    expect(local).not.toContain("--setting-sources");
    expect(local).not.toContain("--strict-mcp-config");
    // the user's own status line is theirs: the room's settings go alone
    fs.mkdirSync(path.join(os.homedir(), ".claude"), { recursive: true });
    fs.writeFileSync(path.join(os.homedir(), ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "mine" } }));
    try {
      const own = agentFor("claude").launchArgs({ ...base }, { claudeSettings: { sandbox: { enabled: true } } });
      expect(JSON.parse(own[own.indexOf("--settings") + 1])).toEqual({ sandbox: { enabled: true } });
    } finally {
      fs.rmSync(path.join(os.homedir(), ".claude", "settings.json"));
    }
  });
  it("runs Claude in Chrome only when asked (the Helpdesk tasks workspace), with its rules and no Mockingbird server", () => {
    const tasks = agentFor("claude").launchArgs({ ...base, role: "tasks" }, { chrome: true, instructions: "HELPDESK RULES" });
    expect(tasks).toContain("--chrome");
    expect(tasks[tasks.indexOf("--append-system-prompt") + 1]).toBe("HELPDESK RULES");
    expect(tasks).not.toContain("--mcp-config");
    expect(tasks).not.toContain("--allowedTools");
    expect(agentFor("claude").launchArgs({ ...base }, { mcp })).not.toContain("--chrome");
    expect(agentFor("claude").launchArgs({ ...base, role: "tasks" }, {})).not.toContain("--chrome");
  });
  it("reads --chrome from Claude Code's --help; --no-chrome alone doesn't count", () => {
    expect(listsChromeFlag("Options:\n  --chrome                              Enable Claude in Chrome integration\n  --no-chrome   Disable it")).toBe(true);
    expect(listsChromeFlag("Options:\n  --no-chrome                           Disable Claude in Chrome integration")).toBe(false);
    expect(listsChromeFlag("Options:\n  --chrome-profile <name>  Not the flag")).toBe(false);
    expect(listsChromeFlag("")).toBe(false);
  });
  it("leaves the messaging server out when the pane has none", () => {
    expect(agentFor("claude").launchArgs({ ...base }, {})).not.toContain("--mcp-config");
    expect(agentFor("codex").launchArgs({ ...base }, {}).join(" ")).not.toContain("mcp_servers.mockingbird");
  });
  it("is the agent for sessions saved before agents existed", () => {
    expect(agentFor(undefined)).toBe(agentFor("claude"));
    expect(agentLabel(undefined)).toBe("Claude");
    expect(agentLabel("codex")).toBe("Codex");
  });
  it("counts a binary as installed once the shell has found it (a path), not as a bare name", async () => {
    const { isInstalledBin } = await import("../src/main/agents");
    expect(isInstalledBin("/opt/homebrew/bin/claude")).toBe(true);
    expect(isInstalledBin("claude")).toBe(false);
  });
});

describe("Codex launch", () => {
  it("passes effort and the MCP server as TOML overrides, with the kickoff prompt last", () => {
    const args = agentFor("codex").launchArgs({ ...base, model: "gpt-x", effort: "high", initialPrompt: "Ticket #1\nline two" }, { mcp });
    expect(args.slice(0, 4)).toEqual(["--model", "gpt-x", "-c", 'model_reasoning_effort="high"']);
    expect(args).toContain(`mcp_servers.mockingbird.command="/Apps/Mockingbird"`);
    expect(args).toContain(`mcp_servers.mockingbird.args=["/h/.mockingbird/mcp.js"]`);
    expect(args).toContain(`mcp_servers.mockingbird.env={MOCKINGBIRD_SESSION="abc12345", ELECTRON_RUN_AS_NODE="1"}`);
    expect(args).toContain(`mcp_servers.mockingbird.default_tools_approval_mode="approve"`);
    expect(args.join(" ")).not.toContain("tool_timeout_sec"); // only Collaborate's code reader needs minutes
    expect(args.slice(-2)).toEqual(["--", "Ticket #1\nline two"]);
  });
  it("pre-approves the MCP server's tools but for the House's writes and reserving a migration number, which ask before every call", async () => {
    const { HOUSE_READ_TOOLS, HOUSE_WRITE_TOOLS } = await import("../src/shared/team/house");
    const { MIGRATION_TOOL } = await import("../src/shared/team/migrations");
    const args = agentFor("codex").launchArgs({ ...base }, { mcp });
    for (const tool of [...HOUSE_WRITE_TOOLS, MIGRATION_TOOL.reserve]) expect(args).toContain(`mcp_servers.mockingbird.tools.${tool}.approval_mode="prompt"`);
    for (const tool of [...HOUSE_READ_TOOLS, MIGRATION_TOOL.list, MIGRATION_TOOL.release]) expect(args.join(" ")).not.toContain(`tools.${tool}.`);
    expect(args).toContain(`mcp_servers.mockingbird.default_tools_approval_mode="approve"`);
  });
  it("passes a kickoff that starts with a dash as the prompt, not as options", () => {
    expect(agentFor("codex").launchArgs({ ...base, initialPrompt: "- run the tests" }, { mcp }).slice(-2)).toEqual(["--", "- run the tests"]);
    expect(agentFor("codex").launchArgs({ ...base }, { mcp })).not.toContain("--");
  });
  it("resumes the most recent conversation in the folder", () => {
    expect(agentFor("codex").launchArgs({ ...base, resume: true }, { mcp }).slice(0, 2)).toEqual(["resume", "--last"]);
  });
  it("takes a room's permission settings as -c overrides, before the prompt; Claude's deny rules are Claude's alone", () => {
    const ctx = { mcp, codexPermissions: ['default_permissions="room"', 'permissions.room={extends=":workspace"}'], denyReads: ["Read(**/.env)"] };
    const args = agentFor("codex").launchArgs({ ...base, initialPrompt: "go" }, ctx);
    expect(args.join(" ")).toContain(`-c default_permissions="room" -c permissions.room={extends=":workspace"}`);
    expect(args.slice(-2)).toEqual(["--", "go"]);
    expect(args.join(" ")).not.toContain("Read(");
    const claude = agentFor("claude").launchArgs({ ...base }, ctx);
    expect(claude.join(" ")).not.toContain("default_permissions");
    expect(claude[claude.indexOf("--disallowedTools") + 1]).toBe("Read(**/.env)");
  });
  it("switches the user's MCP servers off by name, Mockingbird's own kept, before Mockingbird's server's settings", () => {
    expect(codexMcpOff(["github", "dotted.name", "say \"hi\"", "mockingbird"])).toEqual([`mcp_servers={"github"={enabled=false}, "dotted.name"={enabled=false}, "say \\"hi\\""={enabled=false}}`]);
    expect(codexMcpOff([])).toEqual([]);
    expect(codexMcpOff(["mockingbird"])).toEqual([]);
    // a table given whole replaces the dotted keys given before it, so the room's settings come first
    const args = agentFor("codex").launchArgs({ ...base }, { mcp, codexPermissions: codexMcpOff(["github"]) });
    expect(args.indexOf(`mcp_servers={"github"={enabled=false}}`)).toBeLessThan(args.findIndex((a) => a.startsWith("mcp_servers.mockingbird.command=")));
  });
  it("runs inline when asked (a room session), fresh or resumed, as a setting before the prompt", () => {
    const inline = ["-c", 'tui.alternate_screen="never"'];
    const has = (args: string[]) => args.some((a, i) => a === inline[0] && args[i + 1] === inline[1]);
    const fresh = agentFor("codex").launchArgs({ ...base, initialPrompt: "go" }, { mcp, inline: true });
    expect(has(fresh)).toBe(true);
    expect(fresh.slice(-2)).toEqual(["--", "go"]);
    const byId = agentFor("codex").launchArgs({ ...base, resumeSessionId: "019a-conv" }, { mcp, inline: true });
    expect(byId.slice(0, 2)).toEqual(["resume", "019a-conv"]);
    expect(has(byId)).toBe(true);
    const last = agentFor("codex").launchArgs({ ...base, resume: true }, { mcp, inline: true });
    expect(last.slice(0, 2)).toEqual(["resume", "--last"]);
    expect(has(last)).toBe(true);
    // never the --no-alt-screen flag: a Codex that predates it refuses to start on an unknown flag
    expect(fresh).not.toContain("--no-alt-screen");
    // otherwise Codex runs as it's set up
    expect(agentFor("codex").launchArgs({ ...base, initialPrompt: "go" }, { mcp }).join(" ")).not.toContain("alternate_screen");
    // Claude's switch is in its environment, not its arguments
    expect(agentFor("claude").launchArgs({ ...base }, { mcp, inline: true })).toEqual(agentFor("claude").launchArgs({ ...base }, { mcp }));
  });
});

describe("conversationExists", () => {
  it("Claude: finds a transcript by id in any project folder", () => {
    const dir = path.join(os.homedir(), ".claude", "projects", "-Users-me-Code-app");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "abc-123.jsonl"), "{}\n");
    expect(agentFor("claude").conversationExists("abc-123")).toBe(true);
    expect(agentFor("claude").conversationExists("nope")).toBe(false);
  });
  it("Codex: matches the id at the end of a rollout's file name", () => {
    const dir = path.join(os.homedir(), ".codex", "sessions", "2026", "09", "20");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "rollout-2026-09-20T10-00-00-0199aaaa-bbbb.jsonl"), "{}\n");
    expect(agentFor("codex").conversationExists("0199aaaa-bbbb")).toBe(true);
    expect(agentFor("codex").conversationExists("bbbb")).toBe(false);
  });
});

describe("resume detection", () => {
  it("Claude: a transcript in the folder's project directory counts", () => {
    const cwd = "/Users/nick/Code/app";
    expect(agentFor("claude").hasConversation(cwd)).toBe(false);
    const dir = path.join(os.homedir(), ".claude", "projects", cwd.replace(/\//g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "s.jsonl"), "{}\n");
    expect(agentFor("claude").hasConversation(cwd)).toBe(true);
  });
  it("Codex: only interactive (cli) runs count — resume --last skips exec runs", () => {
    rollout("/work/exec-only", "exec");
    rollout("/work/interactive", "cli", "02");
    rollout("/work/desktop", "vscode");
    const codex = agentFor("codex");
    expect(codex.hasConversation("/work/interactive")).toBe(true);
    expect(codex.hasConversation("/work/exec-only")).toBe(false);
    expect(codex.hasConversation("/work/desktop")).toBe(false);
    expect(codex.hasConversation("/work/nothing")).toBe(false);
  });
  it("Codex: an unreadable sessions folder means starting fresh, and says why", () => {
    const sessions = path.join(os.homedir(), ".codex", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.chmodSync(sessions, 0o000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(agentFor("codex").hasConversation("/work/interactive")).toBe(false);
      expect(agentFor("codex").conversationExists("0199aaaa-bbbb")).toBe(false);
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining(sessions), expect.stringContaining(sessions)]);
    } finally {
      fs.chmodSync(sessions, 0o755);
      warn.mockRestore();
    }
  });
});
