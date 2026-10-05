import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { parseClaudeJson, readCodexReply } from "../src/main/headless";
import { tempDir } from "./helpers";

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
