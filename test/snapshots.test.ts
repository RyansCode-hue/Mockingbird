import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { programOnPath } from "../src/main/safeGit";
import { scmCommit } from "../src/main/scm";
import { changesSince, dropSnapshots, KEEP, leftOutIn, listSnapshots, restoreSnapshot, snapshotCommit, snapshotTurn, takeSnapshot, worktreeCommitOn, worktreeTree } from "../src/main/snapshots";
import { git, makeRepo, tempDir, write } from "./helpers";

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (root: string, rel: string) => fs.existsSync(path.join(root, rel));

describe("Mockingbird's own commits", () => {
  it("are never signed, whatever commit.gpgSign says (commit-tree, git's plumbing, ignores it): the config's gpg.program never runs for a turn's snapshot or a backup's commit, and still does for the user's own Commit", async () => {
    const repo = makeRepo();
    const dir = tempDir("gpg");
    const ran = path.join(dir, "ran");
    const gpg = path.join(dir, "gpg.sh");
    fs.writeFileSync(gpg, `#!/bin/sh\necho "$@" >> "${ran}"\nexit 1\n`, { mode: 0o755 });
    git(repo, "config", "commit.gpgSign", "true");
    git(repo, "config", "gpg.program", gpg);
    write(repo, { "a.txt": "a\n" });
    const head = git(repo, "rev-parse", "HEAD");
    const turn = await takeSnapshot(repo, "s1", "a turn");
    const backup = await snapshotCommit(repo, "a backup");
    const copy = await worktreeCommitOn(repo, head, "a copy");
    for (const sha of [turn!.sha, backup!.sha, copy.sha]) expect(git(repo, "cat-file", "-p", sha)).not.toContain("gpgsig");
    expect(fs.existsSync(ran)).toBe(false);
    // the user's own, which signs as their config says: here its gpg.program runs, and fails the commit
    git(repo, "add", "a.txt");
    await expect(scmCommit(repo, "mine")).rejects.toThrow(/gpg failed to sign/);
    expect(fs.existsSync(ran)).toBe(true);
  });
});

describe("undoing an agent's turn", () => {
  it("records the files without touching the branch, the index or the history", async () => {
    const repo = makeRepo({ "a.txt": "a\n", ".gitignore": "secret.env\n" });
    write(repo, { "a.txt": "edited by me\n", "staged.txt": "s\n", "secret.env": "TOKEN=x\n" });
    git(repo, "add", "staged.txt");
    const before = { status: git(repo, "status", "--porcelain"), head: git(repo, "rev-parse", "HEAD"), log: git(repo, "log", "--oneline") };
    const snap = await takeSnapshot(repo, "s1", "Add the dropdown");
    expect(snap).toMatchObject({ n: 1, prompt: "Add the dropdown", skipped: [] });
    expect(git(repo, "status", "--porcelain")).toBe(before.status);
    expect(git(repo, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(repo, "log", "--oneline")).toBe(before.log);
    // ignored files aren't recorded
    expect(git(repo, "ls-tree", "-r", "--name-only", snap!.sha)).not.toContain("secret.env");
    expect(git(repo, "show", `${snap!.sha}:a.txt`)).toBe("edited by me");
  });

  it("restores edited and deleted files and removes new ones — and the restore can be undone", async () => {
    const repo = makeRepo({ "a.txt": "a\n", "src/b.txt": "b\n", ".gitignore": "*.log\n" });
    write(repo, { "notes.log": "keep me\n" });
    const snap = (await takeSnapshot(repo, "s1", "Refactor"))!;
    // the agent's turn
    write(repo, { "a.txt": "agent changed\n", "src/new/c.txt": "new\n", "notes.log": "agent log\n" });
    fs.rmSync(path.join(repo, "src/b.txt"));
    git(repo, "add", "a.txt"); // something staged during the turn stays staged
    const index = git(repo, "diff", "--cached", "--name-only");

    expect((await changesSince(repo, "s1", snap.n)).sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: "a.txt", action: "restore" },
      { path: "src/b.txt", action: "restore" },
      { path: "src/new/c.txt", action: "remove" },
    ]);
    const r = await restoreSnapshot(repo, "s1", snap.n);
    expect(r).toMatchObject({ restored: 2, removed: 1 });
    expect(read(repo, "a.txt")).toBe("a\n");
    expect(read(repo, "src/b.txt")).toBe("b\n");
    expect(exists(repo, "src/new/c.txt")).toBe(false);
    expect(exists(repo, "src/new")).toBe(false); // emptied folders go too
    expect(read(repo, "notes.log")).toBe("agent log\n"); // ignored: never touched
    expect(git(repo, "diff", "--cached", "--name-only")).toBe(index);

    // undo the undo
    expect(r.undo?.beforeUndo).toBe(true);
    await restoreSnapshot(repo, "s1", r.undo!.n);
    expect(read(repo, "a.txt")).toBe("agent changed\n");
    expect(read(repo, "src/new/c.txt")).toBe("new\n");
    expect(exists(repo, "src/b.txt")).toBe(false);
  });

  it("skips files over 5 MB and says which", async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "big.bin"), Buffer.alloc(6 * 1024 * 1024, 1));
    const snap = (await takeSnapshot(repo, "s1", "x"))!;
    expect(snap.skipped).toEqual(["big.bin"]);
    expect((await listSnapshots(repo, "s1"))[0].skipped).toEqual(["big.bin"]);
    expect(git(repo, "ls-tree", "-r", "--name-only", snap.sha)).not.toContain("big.bin");
  });

  it(`keeps the last ${KEEP} turns per session, and forgets a closed session's`, async () => {
    const repo = makeRepo();
    for (let i = 1; i <= KEEP + 2; i++) {
      write(repo, { "a.txt": `v${i}\n` });
      await takeSnapshot(repo, "s1", `turn ${i}`);
    }
    await takeSnapshot(repo, "s2", "other session");
    const list = await listSnapshots(repo, "s1");
    expect(list).toHaveLength(KEEP);
    expect(list[0]).toMatchObject({ n: KEEP + 2, prompt: `turn ${KEEP + 2}` });
    expect(list.at(-1)!.n).toBe(3);
    await dropSnapshots(repo, "s1");
    expect(await listSnapshots(repo, "s1")).toEqual([]);
    expect(await listSnapshots(repo, "s2")).toHaveLength(1);
  });

  it("forgets a worktree session's turns from the main checkout once the worktree is gone", async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const wt = path.join(tempDir("wts"), "feature");
    git(repo, "worktree", "add", "-q", "-b", "feature", wt);
    write(wt, { "a.txt": "agent\n" });
    await takeSnapshot(wt, "s1", "turn");
    git(repo, "worktree", "remove", "--force", wt);
    expect(await listSnapshots(repo, "s1")).toHaveLength(1); // the refs are the repository's, not the worktree's
    await dropSnapshots(repo, "s1");
    expect(await listSnapshots(repo, "s1")).toEqual([]);
  });

  it("works before the first commit, from a subfolder, and does nothing outside a repository", async () => {
    const repo = path.join(tempDir("fresh"), "r");
    fs.mkdirSync(repo, { recursive: true });
    git(path.dirname(repo), "init", "-q", repo);
    write(repo, { "pkg/a.txt": "1\n" });
    const snap = (await takeSnapshot(path.join(repo, "pkg"), "s1", "first"))!;
    write(repo, { "pkg/a.txt": "2\n" });
    await restoreSnapshot(path.join(repo, "pkg"), "s1", snap.n);
    expect(read(repo, "pkg/a.txt")).toBe("1\n");
    expect(await takeSnapshot(tempDir("plain"), "s1", "x")).toBeNull();
    await expect(takeSnapshot(repo, "../escape", "x")).rejects.toThrow(/isn't a session id/);
  });

  it("takes one snapshot at a time per session", async () => {
    const repo = makeRepo();
    const [a, b, c] = await Promise.all([takeSnapshot(repo, "s1", "1"), takeSnapshot(repo, "s1", "2"), takeSnapshot(repo, "s1", "3")]);
    expect([a!.n, b!.n, c!.n]).toEqual([1, 2, 3]);
  });

  it("orders a session's snapshots even when they name different folders of the repository", async () => {
    const repo = makeRepo({ "pkg/a.txt": "1\n" });
    const [a, b] = await Promise.all([takeSnapshot(path.join(repo, "pkg"), "s1", "turn"), takeSnapshot(repo, "s1", "before an undo")]);
    expect([a!.n, b!.n]).toEqual([1, 2]);
    expect((await listSnapshots(repo, "s1")).map((s) => s.n)).toEqual([2, 1]);
  });
});

describe("what a snapshot records", () => {
  it("is exactly the working tree — staged, unstaged, untracked and deleted alike — and the real index is left as it was", async () => {
    const repo = makeRepo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "d.txt": "dd\n" });
    write(repo, { "a.txt": "a staged\n" });
    git(repo, "add", "a.txt");
    write(repo, { "a.txt": "a worktree\n" }); // staged, then edited again
    git(repo, "rm", "-q", "--cached", "b.txt"); // dropped from the index, still on disk
    fs.rmSync(path.join(repo, "c.txt")); // deleted on disk, still in the index
    write(repo, { "n.txt": "n staged\n" });
    git(repo, "add", "n.txt");
    write(repo, { "n.txt": "n worktree\n", "u.txt": "untracked\n" });
    write(repo, { "d.txt": "d1\n" });
    git(repo, "add", "d.txt");
    write(repo, { "d.txt": "D2\n" }); // same size, right after the index was written
    const index = git(repo, "diff", "--cached", "--name-status");

    const snap = (await takeSnapshot(repo, "s1", "x"))!;
    expect(git(repo, "ls-tree", "-r", "--name-only", snap.sha).split("\n")).toEqual(["a.txt", "b.txt", "d.txt", "n.txt", "u.txt"]);
    const at = (rel: string) => git(repo, "show", `${snap.sha}:${rel}`);
    expect([at("a.txt"), at("b.txt"), at("d.txt"), at("n.txt"), at("u.txt")]).toEqual(["a worktree", "b", "D2", "n worktree", "untracked"]);
    expect(git(repo, "diff", "--cached", "--name-status")).toBe(index);
    expect(await changesSince(repo, "s1", snap.n)).toEqual([]);
  });
});

describe("restoring over a changed folder layout", () => {
  it("brings back a folder where a file now stands", async () => {
    const repo = makeRepo({ "a/b.txt": "b\n" });
    const snap = (await takeSnapshot(repo, "s1", "x"))!;
    fs.rmSync(path.join(repo, "a"), { recursive: true });
    write(repo, { a: "a file now\n" });
    expect(await restoreSnapshot(repo, "s1", snap.n)).toMatchObject({ restored: 1, removed: 1 });
    expect(read(repo, "a/b.txt")).toBe("b\n");
  });

  it("brings back a file where a folder now stands", async () => {
    const repo = makeRepo({ a: "a file\n" });
    const snap = (await takeSnapshot(repo, "s1", "x"))!;
    fs.rmSync(path.join(repo, "a"));
    write(repo, { "a/b.txt": "b\n" });
    expect(await restoreSnapshot(repo, "s1", snap.n)).toMatchObject({ restored: 1, removed: 1 });
    expect(read(repo, "a")).toBe("a file\n");
  });
});

const lfsHere = programOnPath("git-lfs", process.env.PATH);

describe("a team room session's snapshots: nothing from config its agent can write, no filter but git-lfs's", () => {
  /** A repository with the user's own filter "strip" (as `nbstripout --install` sets one), which notes each run. */
  function stripRepo() {
    const repo = makeRepo({ "a.txt": "a\n" });
    const log = path.join(tempDir("filter"), "ran");
    git(repo, "config", "filter.strip.clean", `sh -c 'echo clean >> "${log}"; cat'`);
    git(repo, "config", "filter.strip.smudge", `sh -c 'echo smudge >> "${log}"; cat'`);
    return { repo, log, ran: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []) };
  }

  it("takes none when the repository's config includes a file in its working tree, and says why on the pane, logged once", async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    fs.writeFileSync(path.join(repo, "team.gitconfig"), `[filter "strip"]\n\tclean = cat\n`);
    git(repo, "config", "include.path", path.join(repo, "team.gitconfig"));
    write(repo, { "a.txt": "edited\n" });
    const refused = `Mockingbird runs none of a team room session's git with this repository's config: team.gitconfig, a file in ${fs.realpathSync(repo)}, which the room's sessions can change, sets filter.strip.clean, and a setting there can name a program git runs as you`;
    const errors = new Map<string, string>();
    const log = vi.fn();
    await snapshotTurn(repo, "s1", "a turn", { room: true }, errors, log);
    await snapshotTurn(repo, "s1", "the next turn", { room: true }, errors, log);
    expect(await listSnapshots(repo, "s1")).toEqual([]);
    expect(errors.get("s1")).toContain(refused);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("snapshot s1", expect.objectContaining({ message: expect.stringContaining(refused) }));
    // take-over's backups, its count of a copy's unsent files and what it sends refuse the same way
    await expect(snapshotCommit(repo, "a backup", { room: true })).rejects.toThrow(refused);
    await expect(worktreeTree(repo, { room: true })).rejects.toThrow(refused);
    await expect(worktreeCommitOn(repo, git(repo, "rev-parse", "HEAD"), "sent", { room: true })).rejects.toThrow(refused);
    // a local session's turn is recorded, and clears what the pane says; a room session's Undo of it refuses
    await snapshotTurn(repo, "s1", "a local turn", {}, errors, log);
    expect((await listSnapshots(repo, "s1")).map((s) => s.prompt)).toEqual(["a local turn"]);
    expect(errors.has("s1")).toBe(false);
    await expect(restoreSnapshot(repo, "s1", 1, { room: true })).rejects.toThrow(refused);
    await expect(changesSince(repo, "s1", 1, { room: true })).rejects.toThrow(refused);
    // the refusal coming back after a recorded turn is told again
    await snapshotTurn(repo, "s1", "a room turn", { room: true }, errors, log);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("leaves out a file a filter it turns off keeps, as it does a big file, and says which: none is stored unfiltered", async () => {
    const t = stripRepo();
    // a notebook stored through the filter by the user's own commit
    write(t.repo, { ".gitattributes": "*.ipynb filter=strip\n", "old.ipynb": '{"v": 1}\n' });
    git(t.repo, "add", "-A");
    git(t.repo, "commit", "-q", "-m", "a notebook");
    fs.rmSync(t.log);
    // the agent's turn edits it and adds another
    write(t.repo, { "old.ipynb": '{"v": 2}\n', "new.ipynb": "{}\n", "a.txt": "edited\n" });
    const snap = (await takeSnapshot(t.repo, "s1", "a turn", { room: true }))!;
    expect([...snap.filtered].sort()).toEqual(["new.ipynb", "old.ipynb"]);
    expect(snap.skipped).toEqual([]);
    expect(git(t.repo, "ls-tree", "-r", "--name-only", snap.sha).split("\n")).toEqual([".gitattributes", "a.txt", "old.ipynb"]);
    expect(git(t.repo, "show", `${snap.sha}:old.ipynb`)).toBe('{"v": 1}'); // as it was stored
    expect(git(t.repo, "show", `${snap.sha}:a.txt`)).toBe("edited");
    expect([...(await listSnapshots(t.repo, "s1"))[0].filtered].sort()).toEqual(["new.ipynb", "old.ipynb"]);
    expect(await changesSince(t.repo, "s1", snap.n, { room: true })).toEqual([]);
    // take-over's backup leaves them out too, and its message says which, for the plan to show
    const backup = (await snapshotCommit(t.repo, "a backup", { room: true }))!;
    expect([...backup.filtered].sort()).toEqual(["new.ipynb", "old.ipynb"]);
    expect((await leftOutIn(t.repo, backup.sha)).filtered.sort()).toEqual(["new.ipynb", "old.ipynb"]);
    expect(git(t.repo, "show", `${backup.sha}:old.ipynb`)).toBe('{"v": 1}');
    expect(t.ran()).toEqual([]);
  });

  it("restores nothing over a file a filter it turns off keeps: it would be written as it's stored", async () => {
    const t = stripRepo();
    write(t.repo, { "nb.ipynb": '{"v": 1}\n' });
    const snap = (await takeSnapshot(t.repo, "s1", "a turn", { room: true }))!; // no attributes yet: recorded
    expect(snap.filtered).toEqual([]);
    write(t.repo, { ".gitattributes": "*.ipynb filter=strip\n", "nb.ipynb": '{"v": 2}\n' });
    await expect(restoreSnapshot(t.repo, "s1", snap.n, { room: true })).rejects.toThrow(
      `Nothing was restored: nb.ipynb is kept through the "strip" filter, which Mockingbird doesn't run for a team room session's git`
    );
    expect(read(t.repo, "nb.ipynb")).toBe('{"v": 2}\n');
    expect(exists(t.repo, ".gitattributes")).toBe(true);
    expect((await listSnapshots(t.repo, "s1")).length).toBe(1); // no "before an undo" left behind
    expect(t.ran()).toEqual([]);
    // a local session's runs it, as git would
    await restoreSnapshot(t.repo, "s1", snap.n);
    expect(read(t.repo, "nb.ipynb")).toBe('{"v": 1}\n');
    expect(t.ran()).toContain("clean");
  });

  it("runs no filter but git-lfs's when it restores: a file the snapshot's own attributes mark is written as it's stored", async () => {
    const t = stripRepo();
    write(t.repo, { ".gitattributes": "*.ipynb filter=strip\n", "nb.ipynb": '{"v": 1}\n' });
    git(t.repo, "add", "-A");
    git(t.repo, "commit", "-q", "-m", "a notebook");
    const snap = (await takeSnapshot(t.repo, "s1", "a turn", { room: true }))!;
    // the agent drops the attributes, from the index too, and edits the notebook
    git(t.repo, "rm", "-q", "--cached", ".gitattributes");
    fs.rmSync(path.join(t.repo, ".gitattributes"));
    write(t.repo, { "nb.ipynb": '{"v": 2}\n' });
    fs.rmSync(t.log, { force: true }); // what the test's own gits ran
    expect(await restoreSnapshot(t.repo, "s1", snap.n, { room: true })).toMatchObject({ restored: 2, removed: 0 });
    expect(read(t.repo, "nb.ipynb")).toBe('{"v": 1}\n');
    expect(read(t.repo, ".gitattributes")).toBe("*.ipynb filter=strip\n");
    expect(t.ran()).toEqual([]);
  });

  it.skipIf(!lfsHere)("keeps git-lfs's own filter on: a room session's LFS files are recorded as pointers", async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    git(repo, "lfs", "install", "--local");
    git(repo, "lfs", "track", "*.bin");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "LFS");
    fs.writeFileSync(path.join(repo, "big.bin"), "x".repeat(4000));
    const snap = (await takeSnapshot(repo, "s1", "a turn", { room: true }))!;
    expect(snap.filtered).toEqual([]);
    expect(git(repo, "cat-file", "-p", `${snap.sha}:big.bin`)).toMatch(/^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/);
  });

  it("leaves a local session's snapshot as it was: its filters run, and nothing is left out", async () => {
    const t = stripRepo();
    write(t.repo, { ".gitattributes": "*.ipynb filter=strip\n", "nb.ipynb": "{}\n" });
    const snap = (await takeSnapshot(t.repo, "s1", "a turn"))!;
    expect(snap.filtered).toEqual([]);
    expect(git(t.repo, "ls-tree", "-r", "--name-only", snap.sha).split("\n")).toEqual([".gitattributes", "a.txt", "nb.ipynb"]);
    expect(t.ran()).toContain("clean");
  });
});

describe("which snapshots are a team room session's", () => {
  /** Each call of one of `names` in `file`, as written, through its closing parenthesis. */
  function callsIn(file: string, names: string[]): string[] {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const calls: string[] = [];
    for (const m of src.matchAll(new RegExp(`\\b(?:${names.join("|")})\\(`, "g"))) {
      let depth = 0;
      let i = m.index! + m[0].length - 1;
      for (; i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")" && --depth === 0) break;
      }
      calls.push(src.slice(m.index!, i + 1));
    }
    return calls;
  }

  it("take-over's are all one's, and a pane's are when its session is in a room (or rooms haven't started)", () => {
    const takeover = callsIn("src/main/team/takeover.ts", ["snapshotCommit", "worktreeTree", "worktreeCommitOn", "takeSnapshot", "checkoutSnapshotFiles"]);
    expect(takeover).toHaveLength(5);
    for (const call of takeover) expect(call).toContain("room: true");
    // its git apply, which runs filters, with them off
    const applies = callsIn("src/main/team/takeover.ts", ["git"]).filter((c) => c.includes('["apply"'));
    expect(applies).toHaveLength(2);
    for (const call of applies) expect(call).toMatch(/\{ input: patch, env \}\)$/);
    const main = callsIn("src/main/index.ts", ["snapshotTurn", "changesSince", "restoreSnapshot"]);
    expect(main).toHaveLength(3);
    for (const call of main) expect(call).toContain("{ room: pushesOwnHooks(");
  });
});
