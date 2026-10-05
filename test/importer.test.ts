import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { listClaudeConversations } from "../src/main/importer";
import { importTitle } from "../src/main/transcripts";

const projects = path.join(os.homedir(), ".claude", "projects");
const openFds = () => fs.readdirSync("/dev/fd").length;

describe("listing Claude conversations to import", () => {
  it("closes a transcript it fails to read", () => {
    // a directory named like a transcript: it opens, but reading it fails
    fs.mkdirSync(path.join(projects, "-Users-me", "odd.jsonl"), { recursive: true });
    const before = openFds();
    for (let i = 0; i < 20; i++) listClaudeConversations();
    expect(openFds()).toBeLessThan(before + 5);
  });

  it("titles a conversation by its first real prompt", () => {
    const dir = path.join(projects, "-tmp");
    fs.mkdirSync(dir, { recursive: true });
    const line = (content: string) => JSON.stringify({ type: "user", sessionId: "s1", cwd: os.homedir(), message: { role: "user", content } });
    fs.writeFileSync(path.join(dir, "s1.jsonl"), [line("<command-name>/clear</command-name>"), line("Caveat: generated"), line("Fix the export")].join("\n") + "\n");
    expect(listClaudeConversations().find((c) => c.sessionId === "s1")).toMatchObject({ cwd: os.homedir(), title: "Fix the export" });
  });

  it("titles conversations the way the index does: first non-blank of title and request, else the folder", () => {
    expect(importTitle("/w/app", "", "  Fix\n the   export  ")).toBe("Fix the export");
    expect(importTitle("/w/app", null, undefined)).toBe("app");
    expect(importTitle("/w/app", "x".repeat(100))).toHaveLength(70);
  });
});
