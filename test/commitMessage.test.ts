import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { cleanMessage, commitContext, commitPrompt, generateCommitMessage, type ShellRunner } from "../src/main/commitMessage";
import { git, makeRepo, tempDir } from "./helpers";

describe("what a commit message describes", () => {
  it("is the staged change when something is staged", async () => {
    const repo = makeRepo({ "a.txt": "one\n", "b.txt": "b\n" });
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    fs.writeFileSync(path.join(repo, "b.txt"), "unstaged\n");
    git(repo, "add", "a.txt");
    const c = await commitContext(repo);
    expect(c.scope).toBe("staged");
    expect(c.diff).toContain("+two");
    expect(c.diff).not.toContain("unstaged");
    expect(c.recent).toEqual(["initial"]);
  });

  it("is everything, new files' text included, when nothing is staged", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    fs.writeFileSync(path.join(repo, "new.ts"), "export const x = 1;\n");
    const c = await commitContext(repo);
    expect(c.scope).toBe("all");
    expect(c.diff).toContain("+two");
    expect(c.newFiles).toEqual(["new.ts"]);
    expect(c.diff).toContain("export const x = 1;");
  });

  it("works before the first commit, and says when there's nothing to describe", async () => {
    const dir = path.join(tempDir("fresh"), "r");
    fs.mkdirSync(dir);
    git(dir, "init", "-q");
    fs.writeFileSync(path.join(dir, "first.txt"), "hello\n");
    expect((await commitContext(dir)).newFiles).toEqual(["first.txt"]);
    await expect(commitContext(makeRepo())).rejects.toThrow(/no changes/);
  });

  it("asks for the repository's style and the message alone", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    const p = commitPrompt(await commitContext(repo));
    expect(p).toMatch(/at most 72 characters/);
    expect(p).toContain("  initial");
    expect(p).toContain("+two");
  });
});

describe("the model's reply", () => {
  it("is cleaned of fences, labels and quotes", () => {
    expect(cleanMessage("```\nFix the thing\n\nBody\n```")).toBe("Fix the thing\n\nBody");
    expect(cleanMessage("Commit message: Add tabs")).toBe("Add tabs");
    expect(cleanMessage('"Add tabs"')).toBe("Add tabs");
    expect(cleanMessage("Keep \"quotes\" inside")).toBe('Keep "quotes" inside');
  });
});

describe("generating a message", () => {
  it("runs Claude headless with no tools, outside the repository, tagged so its hooks aren't a pane's", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    const calls: { cmd: string; input: string; cwd: string; tag: string }[] = [];
    const run: ShellRunner = async (cmd, input, o) => {
      calls.push({ cmd, input, cwd: o.cwd, tag: o.env.MOCKINGBIRD_SESSION });
      return { code: 0, out: JSON.stringify({ result: "Change a to two", is_error: false }) };
    };
    const r = await generateCommitMessage(repo, "claude", "/bin/claude", run, {});
    expect(r).toEqual({ message: "Change a to two", scope: "all" });
    expect(calls[0].cmd).toContain("--tools ''");
    expect(calls[0].cmd).toContain("--no-session-persistence");
    expect(calls[0].cwd).not.toBe(repo);
    expect(fs.existsSync(calls[0].cwd)).toBe(false); // the scratch folder is cleaned up
    expect(calls[0].tag).toMatch(/^commit-message-/);
    expect(calls[0].input).toContain("+two");
  });

  it("reads Codex's reply from its last-message file, and reports a failed run", async () => {
    const repo = makeRepo({ "a.txt": "one\n" });
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    const ok: ShellRunner = async (cmd) => {
      const file = /-o '([^']+)'/.exec(cmd)![1];
      fs.writeFileSync(file, "Update a\n");
      return { code: 0, out: "" };
    };
    expect((await generateCommitMessage(repo, "codex", "/bin/codex", ok, {})).message).toBe("Update a");
    const bad: ShellRunner = async () => ({ code: 1, out: "ERROR: not logged in" });
    await expect(generateCommitMessage(repo, "codex", "/bin/codex", bad, {})).rejects.toThrow(/not logged in/);
    await expect(generateCommitMessage(repo, "claude", "claude", ok, {})).rejects.toThrow(/isn't installed/);
  });
});
