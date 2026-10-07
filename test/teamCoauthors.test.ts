import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { git, makeRepo, tempDir } from "./helpers";
import { CoauthorTurns, coauthorLine, ensureHooks, hooksEnv } from "../src/main/team/coauthors";

const NICK = { id: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", name: "Nick Smith", email: "nick@example.com" };
const SAM = { id: "5a5a5a5a6b6b6b6b7c7c7c7c8d8d8d8d", name: "Sam", email: null };

/** A hooks folder and co-author lists of this test's own, and git run as a room session's would be. */
function room() {
  const base = tempDir("coauthors");
  const hooksDir = path.join(base, "githooks");
  const lists = path.join(base, "coauthors");
  ensureHooks(hooksDir, lists);
  const turns = new CoauthorTurns(lists);
  const env = (session: string, editor?: string) => ({ ...process.env, ...hooksEnv(hooksDir, ""), MOCKINGBIRD_SESSION: session, ...(editor ? { GIT_EDITOR: editor } : {}) });
  const run = (cwd: string, session: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: env(session), stdio: ["ignore", "pipe", "pipe"] }).trim();
  const edit = (cwd: string, session: string, editor: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: env(session, editor), stdio: ["ignore", "pipe", "pipe"] }).trim();
  const lastMessage = (cwd: string) => git(cwd, "log", "-1", "--format=%B");
  return { hooksDir, lists, turns, run, edit, lastMessage };
}

describe("Co-authored-by trailers in room sessions (real git)", () => {
  it("credits the teammate who typed into the turn, for commits made during it", () => {
    const { turns, run, lastMessage } = room();
    const repo = makeRepo();
    turns.typed("s1", NICK, "idle", true); // Nick types the prompt
    turns.statusChanged("s1", "idle", "working"); // the turn starts
    fs.writeFileSync(path.join(repo, "a.txt"), "a");
    run(repo, "s1", "add", "a.txt");
    run(repo, "s1", "commit", "-q", "-m", "Add a");
    expect(lastMessage(repo)).toBe("Add a\n\nCo-authored-by: Nick Smith <nick@example.com>");
    // the turn ends: the next commit is the owner's alone
    expect(turns.statusChanged("s1", "working", "idle")).toEqual([NICK]);
    fs.writeFileSync(path.join(repo, "b.txt"), "b");
    run(repo, "s1", "add", "b.txt");
    run(repo, "s1", "commit", "-q", "-m", "Add b");
    expect(lastMessage(repo)).toBe("Add b");
    // the author stays the owner
    expect(git(repo, "log", "-1", "--format=%an")).toBe("Mockingbird Test");
  });

  it("adds it with --no-verify and on amend, once", () => {
    const { turns, run, lastMessage } = room();
    const repo = makeRepo();
    turns.typed("s2", NICK, "waiting", true); // answering a permission prompt mid-turn
    fs.writeFileSync(path.join(repo, "a.txt"), "a");
    run(repo, "s2", "add", "a.txt");
    run(repo, "s2", "commit", "-q", "--no-verify", "-m", "Add a");
    run(repo, "s2", "commit", "-q", "--amend", "--no-edit");
    expect(lastMessage(repo)).toBe("Add a\n\nCo-authored-by: Nick Smith <nick@example.com>");
  });

  it("names a teammate without a known email by a handle, and several teammates each", () => {
    const { turns, run, lastMessage } = room();
    const repo = makeRepo();
    turns.typed("s3", NICK, "idle", true);
    turns.typed("s3", SAM, "idle", true);
    turns.statusChanged("s3", "idle", "working");
    run(repo, "s3", "commit", "-q", "--allow-empty", "-m", "Both");
    expect(lastMessage(repo)).toBe("Both\n\nCo-authored-by: Nick Smith <nick@example.com>\nCo-authored-by: Sam <mockingbird:5a5a5a5a6b6b>");
  });

  it("leaves other sessions' and plain commits alone", () => {
    const { turns, run, lastMessage } = room();
    const repo = makeRepo();
    turns.typed("s4", NICK, "working", true);
    run(repo, "other", "commit", "-q", "--allow-empty", "-m", "Mine");
    expect(lastMessage(repo)).toBe("Mine");
    git(repo, "commit", "-q", "--allow-empty", "-m", "Outside Mockingbird");
    expect(lastMessage(repo)).toBe("Outside Mockingbird");
  });

  it("still runs the repository's own hooks: .git/hooks, and a core.hooksPath folder (husky)", () => {
    const { turns, run, lastMessage } = room();
    const repo = makeRepo();
    const hook = (file: string, body: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    hook(path.join(repo, ".git/hooks/prepare-commit-msg"), 'printf "\\nFrom the repo hook\\n" >> "$1"');
    hook(path.join(repo, ".git/hooks/pre-commit"), 'echo ran > "$(git rev-parse --git-dir)/pre-commit-ran"');
    turns.typed("s5", NICK, "working", true);
    run(repo, "s5", "commit", "-q", "--allow-empty", "-m", "Hooked");
    expect(lastMessage(repo)).toBe("Hooked\n\nFrom the repo hook\n\nCo-authored-by: Nick Smith <nick@example.com>");
    expect(fs.existsSync(path.join(repo, ".git/pre-commit-ran"))).toBe(true);

    // a pre-commit hook that refuses still stops the commit
    hook(path.join(repo, ".husky/_/pre-commit"), 'echo "lint failed" >&2; exit 1');
    git(repo, "config", "core.hooksPath", ".husky/_");
    expect(() => run(repo, "s5", "commit", "-q", "--allow-empty", "-m", "Refused")).toThrow(/lint failed/);
    expect(lastMessage(repo)).toMatch(/^Hooked/);
  });

  it("works in a linked worktree", () => {
    const { turns, run, lastMessage } = room();
    const repo = makeRepo();
    const wt = path.join(tempDir("wt"), "feature");
    git(repo, "worktree", "add", "-q", "-b", "feature", wt);
    turns.typed("s6", NICK, "working", true);
    run(wt, "s6", "commit", "-q", "--allow-empty", "-m", "In a worktree");
    expect(lastMessage(wt)).toBe("In a worktree\n\nCo-authored-by: Nick Smith <nick@example.com>");
  });

  it("adds it to a message written in the editor, and an abandoned message still aborts", () => {
    const { turns, edit, lastMessage } = room();
    const repo = makeRepo();
    turns.typed("s7", NICK, "working", true);
    const editor = path.join(tempDir("ed"), "editor.sh");
    fs.writeFileSync(editor, '#!/bin/sh\nprintf "Written in the editor\\n" > "$1"\n', { mode: 0o755 });
    edit(repo, "s7", editor, "commit", "-q", "--allow-empty");
    expect(lastMessage(repo)).toBe("Written in the editor\n\nCo-authored-by: Nick Smith <nick@example.com>");
    fs.writeFileSync(editor, "#!/bin/sh\n: > \"$1\"\n", { mode: 0o755 });
    expect(() => edit(repo, "s7", editor, "commit", "-q", "--allow-empty")).toThrow(/empty commit message/);
    // the editor's comment lines don't count as a message either
    expect(() => edit(repo, "s7", "true", "commit", "-q", "--allow-empty")).toThrow(/empty commit message/);
    expect(lastMessage(repo)).toMatch(/^Written in the editor/);
  });

  it("credits typing in a terminal for ten minutes", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { turns } = room();
      turns.typed("t1", NICK, "idle", false);
      expect(turns.drivers("t1")).toEqual([NICK]);
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect(turns.drivers("t1")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes trailer lines that can't break the message", () => {
    expect(coauthorLine({ id: NICK.id, name: "Nick\nSigned-off-by: x <y>", email: "nick@example.com\nX: y" })).toBe("Nick Signed-off-by: x y <mockingbird:0f1e2d3c4b5a>");
    expect(hooksEnv("/h", "'user.name=X'")).toEqual({ GIT_CONFIG_PARAMETERS: "'user.name=X' 'core.hooksPath=/h'" });
    // Codex drops variables named like KEY, SECRET or TOKEN from its tools' environment
    expect(Object.keys(hooksEnv("/h", "")).filter((k) => /KEY|SECRET|TOKEN/i.test(k))).toEqual([]);
  });
});
