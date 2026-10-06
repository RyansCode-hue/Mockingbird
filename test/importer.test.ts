import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listClaudeConversations } from "../src/main/importer";
import { importTitle } from "../src/main/transcripts";

const projects = path.join(os.homedir(), ".claude", "projects");
const openFds = () => fs.readdirSync("/dev/fd").length;

/** A transcript whose first real prompt is `prompt`, run in the test's home. */
function transcript(folder: string, id: string, prompt: string): void {
  const dir = path.join(projects, folder);
  fs.mkdirSync(dir, { recursive: true });
  const line = (content: string) => JSON.stringify({ type: "user", sessionId: id, cwd: os.homedir(), message: { role: "user", content } });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [line("<command-name>/clear</command-name>"), line("Caveat: generated"), line(prompt)].join("\n") + "\n");
}

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(projects, { recursive: true, force: true });
});

describe("listing Claude conversations to import", () => {
  it("has nothing to list without Claude's projects folder", () => {
    expect(listClaudeConversations()).toEqual([]);
  });

  it("closes a transcript it fails to read, and says it couldn't read any", () => {
    // a directory named like a transcript: it opens, but reading it fails
    fs.mkdirSync(path.join(projects, "-Users-me", "odd.jsonl"), { recursive: true });
    const before = openFds();
    for (let i = 0; i < 20; i++) expect(() => listClaudeConversations()).toThrow(/Couldn't read Claude's conversations: .*odd\.jsonl/);
    expect(openFds()).toBeLessThan(before + 5);
  });

  it("titles a conversation by its first real prompt", () => {
    transcript("-tmp", "s1", "Fix the export");
    expect(listClaudeConversations().find((c) => c.sessionId === "s1")).toMatchObject({ cwd: os.homedir(), title: "Fix the export" });
  });

  it("lists what it could read and logs the folder it couldn't — and throws when it could read nothing", () => {
    transcript("-tmp", "s1", "Fix the export");
    const locked = path.join(projects, "-locked");
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(listClaudeConversations().map((c) => c.sessionId)).toEqual(["s1"]);
      expect(String(warn.mock.calls[0]?.[0])).toContain(locked);
      fs.rmSync(path.join(projects, "-tmp"), { recursive: true });
      expect(() => listClaudeConversations()).toThrow(locked);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it("titles conversations the way the index does: first non-blank of title and request, else the folder", () => {
    expect(importTitle("/w/app", "", "  Fix\n the   export  ")).toBe("Fix the export");
    expect(importTitle("/w/app", null, undefined)).toBe("app");
    expect(importTitle("/w/app", "x".repeat(100))).toHaveLength(70);
  });
});
