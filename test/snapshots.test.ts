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
});
