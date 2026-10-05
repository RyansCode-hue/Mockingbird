import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { changesSince, dropSnapshots, KEEP, listSnapshots, restoreSnapshot, takeSnapshot } from "../src/main/snapshots";
import { git, makeRepo, tempDir, write } from "./helpers";

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (root: string, rel: string) => fs.existsSync(path.join(root, rel));

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
