import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpLaunch } from "../src/main/messaging";

const mcp: McpLaunch = { command: "/Apps/Mockingbird", args: ["/h/.mockingbird/mcp.js"], env: { MOCKINGBIRD_SESSION: "abc12345", ELECTRON_RUN_AS_NODE: "1" } };
const base = { repoPath: null, useWorktree: false };

// agents.ts caches its Codex index for 30s, so each test loads a fresh copy
let agentFor: typeof import("../src/main/agents").agentFor;
beforeEach(async () => {
  vi.resetModules();
  ({ agentFor } = await import("../src/main/agents"));
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
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__mockingbird__list_sessions,mcp__mockingbird__send_message");
  });
  it("resumes a specific conversation by id", () => {
    expect(agentFor("claude").launchArgs({ ...base, resumeSessionId: "uuid-1" }, { mcp }).slice(0, 2)).toEqual(["--resume", "uuid-1"]);
  });
  it("is the agent for sessions saved before agents existed", () => {
    expect(agentFor(undefined).label).toBe("Claude");
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
    expect(args[args.length - 1]).toBe("Ticket #1\nline two");
  });
  it("resumes the most recent conversation in the folder", () => {
    expect(agentFor("codex").launchArgs({ ...base, resume: true }, { mcp }).slice(0, 2)).toEqual(["resume", "--last"]);
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
});
