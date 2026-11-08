import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { handoffKickoff, handoffPrompt, lastReplyLine, lastReplyOf, repoState, transcriptDigest, transcriptLines } from "../src/main/handoff";
import { git, makeRepo, tempDir, write } from "./helpers";

const spawned: { file: string; args: string[]; cwd: string }[] = [];
vi.mock("node-pty", () => ({
  spawn: (file: string, args: string[], o: { cwd: string }) => {
    spawned.push({ file, args, cwd: o.cwd });
    return { onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {}, pid: 1 };
  },
}));

const claude = (type: "user" | "assistant", content: unknown) => JSON.stringify({ type, sessionId: "c1", timestamp: "2026-10-04T10:00:00Z", message: { role: type, content } });

describe("a conversation condensed for the agent taking over", () => {
  const lines = [
    claude("user", "Add a last-used org to the dropdown"),
    claude("assistant", [{ type: "text", text: "I'll store it per user." }, { type: "tool_use", name: "Edit", input: { file_path: "src/org/Dropdown.tsx" } }]),
    claude("user", "<command-name>/clear</command-name>"),
    claude("assistant", [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }]),
    claude("assistant", "Tests pass; next is the API."),
  ];
  it("says who wrote what and which tools ran, without command noise", () => {
    expect(transcriptDigest(lines, "claude", "c1")).toBe(
      [
        "USER: Add a last-used org to the dropdown",
        "AGENT: I'll store it per user.",
        "TOOL: Edit src/org/Dropdown.tsx",
        "TOOL: Bash npm test",
        "AGENT: Tests pass; next is the API.",
      ].join("\n")
    );
  });
  it("keeps the task and the most recent part when it's too long", () => {
    const many = [claude("user", "The task"), ...Array.from({ length: 50 }, (_, i) => claude("assistant", `step ${i} ${"x".repeat(80)}`))];
    const d = transcriptDigest(many, "claude", "c1", 600);
    const out = d.split("\n");
    expect(out[0]).toBe("USER: The task");
    expect(out[1]).toMatch(/^\[… \d+ earlier entries left out …\]$/);
    expect(out.at(-1)).toMatch(/^AGENT: step 49 /);
    expect(d.length).toBeLessThanOrEqual(700);
  });
  it("reads Codex rollouts too", () => {
    const codex = [
      JSON.stringify({ type: "response_item", timestamp: "2026-10-04T10:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the build" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-10-04T10:00:01Z", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["npm", "run", "build"] }) } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-10-04T10:00:02Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed the import." }] } }),
    ];
    expect(transcriptDigest(codex, "codex", "x")).toBe("USER: Fix the build\nTOOL: shell npm run build\nAGENT: Fixed the import.");
  });
  it("is empty for a transcript with nothing said", () => {
    expect(transcriptDigest(["not json"], "claude", "c1")).toBe("");
  });
});

describe("reading a long transcript", () => {
  it("takes its start and its end, dropping lines cut by either window", async () => {
    const f = path.join(tempDir("tx"), "t.jsonl");
    const line = (i: number) => JSON.stringify({ i, pad: "y".repeat(200) });
    const n = 40_000; // ~9MB: more than the two windows
    fs.writeFileSync(f, Array.from({ length: n }, (_, i) => line(i)).join("\n") + "\n");
    const got = await transcriptLines(f);
    const ids = got.map((l) => JSON.parse(l).i);
    expect(ids[0]).toBe(0);
    expect(ids.at(-1)).toBe(n - 1);
    expect(ids.length).toBeLessThan(n);
    expect(got.every((l) => l.endsWith("}"))).toBe(true); // no half lines
  });
  it("reads a short one whole", async () => {
    const f = path.join(tempDir("tx"), "s.jsonl");
    fs.writeFileSync(f, "a\nb\n");
    expect(await transcriptLines(f)).toEqual(["a", "b"]);
  });
});

describe("the handoff", () => {
  it("describes the repository as it stands", async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    git(repo, "checkout", "-q", "-b", "5101-org");
    write(repo, { "a.txt": "changed\n", "new.txt": "n\n" });
    const s = await repoState(repo);
    expect(s).toContain("Branch: 5101-org");
    expect(s).toContain(" M a.txt");
    expect(s).toContain("?? new.txt");
    expect(s).toContain("initial");
    expect(await repoState(tempDir("plain"))).toBe("(not a git repository)");
  });
  it("asks for the sections the new agent needs, and kicks it off with the handoff", () => {
    const p = handoffPrompt({ from: "claude", to: "codex", cwd: "/w", title: "Org dropdown", digest: "USER: x", repo: "Branch: b" });
    for (const s of ["## Goal", "## Done", "## In progress", "## Next steps", "## Watch out for"]) expect(p).toContain(s);
    expect(p).toContain("handing its task to Codex");
    const k = handoffKickoff("claude", "## Goal\nShip it");
    expect(k).toMatch(/^You're taking over a task from a Claude session/);
    expect(k).toContain("## Goal\nShip it");
  });
});

describe("starting a session in another session's folder", () => {
  it("runs in that folder as it is: no worktree, no branch switch", async () => {
    const { SessionManager } = await import("../src/main/sessions");
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    const store = { settings: { claudeBin: "/bin/echo", codexBin: "/bin/echo" }, state: { sessions: [] as any[] }, upsertSession() {}, removeSession() {}, save() {} };
    const m = new SessionManager(store as any);
    const info = await m.create({ repoPath: "/somewhere/main", cwd: repo, branchName: "feature", useWorktree: false, agent: "codex", title: "x · codex", taskGroup: "5101", initialPrompt: "hi" });
    expect(info.cwd).toBe(repo);
    expect(info.branch).toBe("feature");
    expect(info.repoPath).toBe("/somewhere/main");
    expect(info.taskGroup).toBe("5101");
    expect(spawned.at(-1)!.cwd).toBe(repo);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
    await expect(m.create({ repoPath: null, cwd: path.join(repo, "gone"), useWorktree: false })).rejects.toThrow(/doesn't exist/);
  });
});

describe("what an agent said last (a landscape card's \"what it did\")", () => {
  it("is the first line of the agent's latest message, past tool calls and the user's messages, its markdown let go", () => {
    const lines = [
      claude("user", "Make the dropdown remember the org"),
      claude("assistant", [{ type: "text", text: "## Done\n\nThe dropdown now remembers it." }]),
      claude("assistant", [{ type: "text", text: "\n\n**Streams** the export instead of loading `40k` rows.\nThen the tests." }, { type: "tool_use", name: "Bash", input: { command: "npm test" } }]),
      claude("assistant", [{ type: "tool_use", name: "Edit", input: { file_path: "a.ts" } }]),
      claude("user", "thanks"),
    ];
    expect(lastReplyLine(lines, "claude", "c1")).toEqual({ line: "Streams the export instead of loading 40k rows.", at: Date.parse("2026-10-04T10:00:00Z") });
    expect(lastReplyLine(lines.slice(0, 2), "claude", "c1")?.line).toBe("Done");
  });
  it("reads Codex rollouts", () => {
    const codex = [
      JSON.stringify({ type: "response_item", timestamp: "2026-10-04T10:00:02Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed the import." }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-10-04T10:00:03Z", payload: { type: "function_call", name: "shell", arguments: "{}" } }),
    ];
    expect(lastReplyLine(codex, "codex", "x1")?.line).toBe("Fixed the import.");
  });
  it("is null before the agent has said anything, and for lines that aren't JSON", () => {
    expect(lastReplyLine([claude("user", "Start"), claude("assistant", [{ type: "tool_use", name: "Read", input: {} }]), "{not json"], "claude", "c1")).toBeNull();
  });
  it("reads a transcript from its end, dropping a line the window cut, and the newest file first", async () => {
    const dir = tempDir("transcripts");
    const old = path.join(dir, "old.jsonl");
    const cur = path.join(dir, "cur.jsonl");
    fs.writeFileSync(old, `${claude("assistant", "From the earlier file.")}\n`);
    // past the tail window: the line it starts inside is dropped, and the last message read
    fs.writeFileSync(cur, `${claude("assistant", "x".repeat(1_200_000))}\n${claude("user", "go on")}\n${claude("assistant", "The newest reply.")}\n`);
    expect((await lastReplyOf([{ path: old, agent: "claude" }, { path: cur, agent: "claude" }], "c1")).line).toBe("The newest reply.");
    fs.writeFileSync(cur, `${claude("user", "only a question so far")}\n`);
    expect((await lastReplyOf([{ path: old, agent: "claude" }, { path: cur, agent: "claude" }], "c1")).line).toBe("From the earlier file.");
    expect(await lastReplyOf([{ path: cur, agent: "claude" }], "c1")).toEqual({ line: null, at: null });
    await expect(lastReplyOf([{ path: path.join(dir, "gone.jsonl"), agent: "claude" }], "c1")).rejects.toThrow(/ENOENT/);
  });
});
