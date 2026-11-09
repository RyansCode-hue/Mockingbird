import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { handoffKickoff, handoffPrompt, hookTranscript, lastReplyLine, lastReplyOf, replyFiles, replyOfConversation, repoState, transcriptDigest, transcriptLines } from "../src/main/handoff";
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

describe("what an agent said last, read now and only from its own conversation", () => {
  const side = (content: unknown) => JSON.stringify({ type: "assistant", isSidechain: true, sessionId: "c1", timestamp: "2026-10-04T10:05:00Z", message: { role: "assistant", content } });
  const toolOutput = (bytes: number) => JSON.stringify({ type: "user", sessionId: "c1", message: { role: "user", content: [{ type: "tool_result", content: "o".repeat(bytes) }] } });

  it("passes over a subagent's lines in the conversation's transcript, in its latest message and in a digest", () => {
    const lines = [claude("user", "Ship it"), claude("assistant", "Shipped the dropdown."), side("I'm the explorer subagent: found 12 files.")];
    expect(lastReplyLine(lines, "claude", "c1")?.line).toBe("Shipped the dropdown.");
    expect(transcriptDigest(lines, "claude", "c1")).not.toContain("explorer subagent");
  });

  it("finds a Claude conversation's own file: its hooks', the index's, else its folder's, never a subagent's", () => {
    const files = ["/p/c1.jsonl", "/p/c1/subagents/agent-a1.jsonl", "/p/other.jsonl"];
    const exists = (f: string) => files.includes(f);
    const locate = vi.fn(() => "/p/c1.jsonl");
    // the index files the subagent under its parent: it's never what's read
    expect(replyFiles("claude", "c1", { hook: null, indexed: [{ path: "/p/c1.jsonl" }, { path: "/p/c1/subagents/agent-a1.jsonl" }], locate, exists })).toEqual([{ path: "/p/c1.jsonl", agent: "claude" }]);
    expect(replyFiles("claude", "c1", { hook: "/p/c1.jsonl", indexed: [], locate, exists })).toEqual([{ path: "/p/c1.jsonl", agent: "claude" }]);
    expect(locate).not.toHaveBeenCalled();
    // a new conversation the index hasn't caught up with: found in its folder
    expect(replyFiles("claude", "c1", { hook: null, indexed: [], locate, exists })).toEqual([{ path: "/p/c1.jsonl", agent: "claude" }]);
    expect(replyFiles("claude", "c1", { hook: "/p/c1/subagents/agent-a1.jsonl", indexed: [], locate: () => null, exists })).toEqual([]);
    expect(replyFiles("claude", "c2", { hook: null, indexed: [], locate: () => null, exists })).toEqual([]);
  });

  it("finds every rollout of a Codex conversation, the newest too before the index has it, oldest first", () => {
    const old = "/s/2026/10/03/rollout-2026-10-03T09-00-00-x1.jsonl";
    const cur = "/s/2026/10/04/rollout-2026-10-04T10-00-00-x1.jsonl";
    const exists = (f: string) => f === old || f === cur;
    expect(replyFiles("codex", "x1", { hook: cur, indexed: [{ path: old }], locate: () => null, exists }).map((f) => f.path)).toEqual([old, cur]);
    expect(replyFiles("codex", "x1", { hook: null, indexed: [{ path: old }], locate: () => cur, exists }).map((f) => f.path)).toEqual([old, cur]);
    expect(replyFiles("codex", "x1", { hook: null, indexed: [{ path: cur }, { path: old }], locate: () => cur, exists }).map((f) => f.path)).toEqual([old, cur]);
  });

  it("reads further back past a long tool output, and says why it's blank when even that held no message", async () => {
    const dir = tempDir("long-turn");
    const f = path.join(dir, "c1.jsonl");
    fs.writeFileSync(f, `${claude("assistant", "Ran the whole suite.")}\n${toolOutput(3 * 1024 * 1024)}\n`);
    expect(await lastReplyOf([{ path: f, agent: "claude" }], "c1")).toMatchObject({ line: "Ran the whole suite." });
    fs.writeFileSync(f, `${claude("assistant", "Ran the whole suite.")}\n${toolOutput(9 * 1024 * 1024)}\n`);
    expect(await lastReplyOf([{ path: f, agent: "claude" }], "c1")).toEqual({ line: null, at: null, why: "no message from the agent in the last 8 MB of its transcript, which a long tool output filled" });
    // an older file isn't read in its place: its line would be older than what the agent last did
    const old = path.join(dir, "old.jsonl");
    fs.writeFileSync(old, `${claude("assistant", "Something from yesterday.")}\n`);
    expect((await lastReplyOf([{ path: old, agent: "claude" }, { path: f, agent: "claude" }], "c1")).line).toBeNull();
  });

  it("reads a file once while it's unchanged, and again once it grows", async () => {
    const dir = tempDir("reply-cache");
    const f = path.join(dir, "c1.jsonl");
    fs.writeFileSync(f, `${claude("assistant", "First answer.")}\n`);
    const open = vi.spyOn(fs.promises, "open");
    expect((await lastReplyOf([{ path: f, agent: "claude" }], "c1")).line).toBe("First answer.");
    expect((await lastReplyOf([{ path: f, agent: "claude" }], "c1")).line).toBe("First answer.");
    expect(open).toHaveBeenCalledTimes(1);
    fs.appendFileSync(f, `${claude("assistant", "Second answer, a turn later.")}\n`);
    expect((await lastReplyOf([{ path: f, agent: "claude" }], "c1")).line).toBe("Second answer, a turn later.");
    expect(open).toHaveBeenCalledTimes(2);
    open.mockRestore();
  });
});

describe("the transcript path a hook named, which comes from a file others could write to", () => {
  const setup = (name: string) => {
    const dir = tempDir(name);
    const root = path.join(dir, "projects");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    const own = path.join(root, "c1.jsonl");
    fs.writeFileSync(own, `${claude("assistant", "From the transcript folder.")}\n`);
    const secret = path.join(outside, "c1.jsonl");
    fs.writeFileSync(secret, `${claude("assistant", "From outside the transcript folders.")}\n`);
    return { root, outside, own, secret, real: (p: string) => fs.realpathSync(p) };
  };
  it("is read inside the transcript folders, with links followed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup("hook-in");
    expect(hookTranscript(t.own, [t.root])).toEqual({ path: t.real(t.own), refused: null });
    const link = path.join(t.root, "link.jsonl");
    fs.symlinkSync(t.own, link);
    expect(hookTranscript(link, [t.root])).toEqual({ path: t.real(t.own), refused: null });
    // a transcript folder reached through a link itself: the same place
    const linkedRoot = path.join(t.outside, "linked-projects");
    fs.symlinkSync(t.root, linkedRoot);
    expect(hookTranscript(t.own, [linkedRoot]).path).toBe(t.real(t.own));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it("is none, and not refused, when there's nothing there yet", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup("hook-missing");
    expect(hookTranscript(null, [t.root])).toEqual({ path: null, refused: null });
    expect(hookTranscript(path.join(t.root, "new.jsonl"), [t.root])).toEqual({ path: null, refused: null });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it("is refused outside them, through a link out of them, or beside them with a name that starts the same; said once each", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup("hook-out");
    expect(hookTranscript(t.secret, [t.root])).toEqual({ path: null, refused: expect.stringContaining(`is outside ${t.root}`) });
    hookTranscript(t.secret, [t.root]);
    const out = path.join(t.root, "out.jsonl");
    fs.symlinkSync(t.secret, out);
    expect(hookTranscript(out, [t.root]).path).toBeNull();
    const beside = `${t.root}-other`;
    fs.mkdirSync(beside);
    fs.writeFileSync(path.join(beside, "c1.jsonl"), "");
    expect(hookTranscript(path.join(beside, "c1.jsonl"), [t.root]).path).toBeNull();
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      expect.stringMatching(/^\[mockingbird\] not reading the transcript a hook named, .*outside\/c1\.jsonl: it's outside /),
      expect.stringMatching(/^\[mockingbird\] not reading the transcript a hook named, .*projects\/out\.jsonl: it's outside /),
      expect.stringMatching(/^\[mockingbird\] not reading the transcript a hook named, .*projects-other\/c1\.jsonl: it's outside /),
    ]);
    warn.mockRestore();
  });
  it("is refused when it isn't a regular file, so a FIFO can't hold a thread, and isn't read as one from elsewhere", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup("hook-fifo");
    const fifo = path.join(t.root, "c2.jsonl");
    execFileSync("mkfifo", [fifo]);
    expect(hookTranscript(fifo, [t.root])).toEqual({ path: null, refused: expect.stringContaining("not a regular file") });
    expect(hookTranscript(t.root, [t.root]).refused).toContain("not a regular file");
    expect(replyFiles("claude", "c2", { hook: null, indexed: [{ path: fifo }], locate: () => fifo })).toEqual([]);
    expect(replyFiles("codex", "c2", { hook: null, indexed: [{ path: fifo }], locate: () => fifo })).toEqual([]);
    warn.mockRestore();
  });
  it("gives the file's message when it's in, and never one from outside", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup("hook-reply");
    const o = { roots: [t.root], indexed: [], locate: () => null };
    expect(await replyOfConversation("claude", "c1", { ...o, hook: t.own })).toMatchObject({ line: "From the transcript folder." });
    for (const agent of ["claude", "codex"] as const) {
      const r = await replyOfConversation(agent, "c1", { ...o, hook: t.secret });
      expect(r.line).toBeNull();
      expect(r.why).toContain(`its transcript, ${t.secret}, is outside ${t.root}`);
    }
    warn.mockRestore();
  });
  it("is checked by main's handler, against the agents' transcript folders", () => {
    const index = fs.readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/replyOfConversation\(agent, conv, \{\s*hook: sessions\.transcriptOf\(s\.id, conv\),\s*roots: \[CLAUDE_PROJECTS, CODEX_SESSIONS\],/);
  });
  it("still finds the conversation's own file when the path was refused, saying nothing then", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup("hook-fallback");
    const r = await replyOfConversation("claude", "c1", { hook: t.secret, roots: [t.root], indexed: [], locate: () => t.own });
    expect(r).toMatchObject({ line: "From the transcript folder." });
    expect(r.why).toBeUndefined();
    warn.mockRestore();
  });
});
