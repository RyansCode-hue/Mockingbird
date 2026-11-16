import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { askAgent, claudeAskCommand, parseClaudeJson, readCodexReply, type ShellRunner } from "../src/main/headless";
import { tempDir } from "./helpers";

const launch = { command: "/apps/mb", args: ["/h/.mockingbird/mcp.js"], env: { MOCKINGBIRD_SESSION: "assistant-t-1", MOCKINGBIRD_TOKEN_FILE: "/h/.mockingbird/mcp-tokens/ab" } };

describe("headless commands", () => {
  it("Claude with no MCP server: no built-in tools, no MCP servers, nothing saved", () => {
    expect(claudeAskCommand("/bin/claude")).toBe("'/bin/claude' -p --model 'haiku' --output-format json --tools '' --strict-mcp-config --no-session-persistence");
  });
  it("Claude with Mockingbird's server: only it, only the tools given, and the rules added to its system prompt", () => {
    const cmd = claudeAskCommand("/bin/claude", "sonnet", { mcp: { launch, allowedTools: ["mcp__mockingbird__a", "mcp__mockingbird__b"] }, system: "Don't 'guess'." });
    expect(cmd).toBe(
      `'/bin/claude' -p --model 'sonnet' --output-format json --tools '' --strict-mcp-config --mcp-config '${JSON.stringify({ mcpServers: { mockingbird: { type: "stdio", ...launch } } })}' ` +
        `--allowedTools 'mcp__mockingbird__a,mcp__mockingbird__b' --append-system-prompt 'Don'\\''t '\\''guess'\\''.' --no-session-persistence`
    );
    expect(() => claudeAskCommand("/bin/claude", "sonnet", { mcp: { launch, allowedTools: [] } })).toThrow("needs the tools it may call");
  });
  it("askAgent hands the shell's pid on, and refuses a server or rules for Codex", async () => {
    const pids: number[] = [];
    const run: ShellRunner = async (_cmd, _input, opts) => (opts.onSpawn?.(4242), { code: 0, out: JSON.stringify({ result: "hi", is_error: false }) });
    expect(await askAgent("q", { agent: "claude", bin: "/bin/claude", run, env: {}, tag: "t", onSpawn: (p) => void pids.push(p) })).toBe("hi");
    expect(pids).toEqual([4242]);
    await expect(askAgent("q", { agent: "codex", bin: "/bin/codex", run, env: {}, tag: "t", system: "rules" })).rejects.toThrow("Only a Claude run");
  });
});

describe("headless replies", () => {
  it("Claude: the result text and its conversation, or the CLI's error", () => {
    expect(parseClaudeJson({ code: 0, out: JSON.stringify({ result: "Done", session_id: "s1", is_error: false }) })).toEqual({ text: "Done", sessionId: "s1" });
    expect(() => parseClaudeJson({ code: 1, out: JSON.stringify({ result: "Credit balance too low", is_error: true }) })).toThrow("Credit balance too low");
    expect(() => parseClaudeJson({ code: 127, out: "zsh: command not found: claude" })).toThrow("command not found");
    expect(() => parseClaudeJson({ code: 1, out: "" })).toThrow("claude exited with code 1");
  });
  it("Codex: the reply file, or the run's error line when it wrote none", async () => {
    const last = path.join(tempDir("codex"), "reply.txt");
    await expect(readCodexReply(last, { code: 1, out: "starting\nERROR: not logged in\n" })).rejects.toThrow("ERROR: not logged in");
    fs.writeFileSync(last, "Update a\n");
    expect(await readCodexReply(last, { code: 0, out: "" })).toBe("Update a\n");
  });
});
