import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { changedFiles, overlapReport, overlaps, rereadWorktrees, type WorktreeChanges, type WorktreeReads } from "../src/main/conflicts";
import { baseRef } from "../src/main/files";
import { git, makeRepo, tempDir, write } from "./helpers";

const wt = (sessionId: string, repo: string, cwd: string, files: string[]): WorktreeChanges => ({ sessionId, title: sessionId, branch: `b-${sessionId}`, repo, cwd, files });

describe("overlapping changes between worktrees", () => {
  it("flags both sides when two worktrees of one repository change the same file", () => {
    const o = overlaps([wt("a", "/r", "/r/wt/a", ["src/x.ts", "README.md"]), wt("b", "/r", "/r/wt/b", ["src/x.ts", "src/y.ts"])]);
    expect(o.a).toEqual([{ other: "b", otherTitle: "b", otherBranch: "b-b", files: ["src/x.ts"] }]);
    expect(o.b).toEqual([{ other: "a", otherTitle: "a", otherBranch: "b-a", files: ["src/x.ts"] }]);
  });
  it("leaves out sessions sharing a folder, other repositories, and worktrees with nothing in common", () => {
    expect(overlaps([wt("a", "/r", "/r", ["x"]), wt("b", "/r", "/r", ["x"]), wt("c", "/other", "/other", ["x"]), wt("d", "/r", "/r/wt/d", ["y"])])).toEqual({});
  });
});

describe("worktrees overlaps couldn't read", () => {
  it("are counted for every session of their repository, never read as having no changes, and logged once each", async () => {
    const reads: WorktreeReads = { changes: new Map(), unread: new Map() };
    const logs: string[] = [];
    const log = (context: string, err: unknown) => logs.push(`${context}: ${(err as Error).message}`);
    let broken = true;
    const read = async (cwd: string) => {
      if (cwd === "/r/wt/b" && broken) throw new Error("git status: fatal: not a git repository");
      return { repo: cwd.startsWith("/r") ? "/r" : "/o", branch: null, files: ["x.ts"] };
    };
    const live = [
      { sessionId: "a", title: "a", repoPath: "/r", cwd: "/r/wt/a" },
      { sessionId: "b", title: "b", repoPath: "/r", cwd: "/r/wt/b" },
      { sessionId: "b2", title: "b2", repoPath: "/r", cwd: "/r/wt/b" },
      { sessionId: "o", title: "o", repoPath: "/o", cwd: "/o" },
    ];
    const cwds = [...new Set(live.map((s) => s.cwd))];
    await rereadWorktrees(cwds, reads, new Set(), log, read);
    expect(overlapReport(live, reads, [])).toEqual({ bySession: {}, unread: { a: 1, b: 1, b2: 1 } });
    expect(logs).toEqual(["overlaps: /r/wt/b's changed files couldn't be read, so overlaps with it are unknown: git status: fatal: not a git repository"]);
    // read again on the next pass, its failure not logged again while it's the same
    await rereadWorktrees(cwds, reads, new Set(), log, read);
    expect(logs).toHaveLength(1);
    broken = false;
    await rereadWorktrees(cwds, reads, new Set(), log, read);
    expect(overlapReport(live, reads, [])).toEqual({
      bySession: { a: [{ other: "b", otherTitle: "b", otherBranch: null, files: ["x.ts"] }, { other: "b2", otherTitle: "b2", otherBranch: null, files: ["x.ts"] }], b: [{ other: "a", otherTitle: "a", otherBranch: null, files: ["x.ts"] }], b2: [{ other: "a", otherTitle: "a", otherBranch: null, files: ["x.ts"] }] },
      unread: {},
    });
    // its repository named another way (a trailing slash, a symlink) is the same repository
    const real = tempDir("repo");
    const link = path.join(tempDir("links"), "repo");
    fs.symlinkSync(real, link);
    const spelled = [
      { sessionId: "x", title: "x", repoPath: real, cwd: "/q/wt/x" },
      { sessionId: "y", title: "y", repoPath: `${link}/`, cwd: "/q/wt/y" },
      { sessionId: "z", title: "z", repoPath: "/r/", cwd: "/r/wt/z" },
    ];
    const both: WorktreeReads = { changes: new Map(), unread: new Map([["/q/wt/x", "x"], ["/r/wt/b", "b"]]) };
    expect(overlapReport([...live, ...spelled], both, []).unread).toEqual({ a: 1, b: 1, b2: 1, z: 1, x: 1, y: 1 });
    // a folder no longer live is forgotten, read or not
    reads.unread.set("/gone", "x");
    await rereadWorktrees(["/o"], reads, new Set(), log, read);
    expect([...reads.changes.keys(), ...reads.unread.keys()]).toEqual(["/o"]);
  });
});

describe("a worktree's changed files", () => {
  it("counts the branch's commits since the base and what isn't committed, and sees the clash", async () => {
    const upstream = makeRepo({ "src/x.ts": "x\n", "src/y.ts": "y\n" }, "upstream");
    git(upstream, "branch", "dev");
    const clone = path.join(tempDir("clone"), "repo");
    git(path.dirname(clone), "clone", "-q", upstream, clone);
    const a = path.join(path.dirname(clone), "wt-a");
    const b = path.join(path.dirname(clone), "wt-b");
    git(clone, "worktree", "add", "-q", "-b", "5101-a", a, "origin/dev");
    git(clone, "worktree", "add", "-q", "-b", "5102-b", b, "origin/dev");
    // a commits a change to x; b changes x and y without committing, and adds a file
    write(a, { "src/x.ts": "a's x\n" });
    git(a, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "a");
    write(b, { "src/x.ts": "b's x\n", "src/y.ts": "b's y\n", "src/new.ts": "n\n" });

    const ca = await changedFiles(a);
    const cb = await changedFiles(b);
    expect(ca).toMatchObject({ branch: "5101-a", files: ["src/x.ts"] });
    expect(cb.files).toEqual(["src/new.ts", "src/x.ts", "src/y.ts"]);
    expect(fs.realpathSync(ca.repo)).toBe(fs.realpathSync(clone));
    expect(ca.repo).toBe(cb.repo);
    const o = overlaps([{ sessionId: "A", title: "A", cwd: a, ...ca }, { sessionId: "B", title: "B", cwd: b, ...cb }]);
    expect(o.A[0].files).toEqual(["src/x.ts"]);
    expect(o.B[0]).toMatchObject({ other: "A", otherBranch: "5101-a", files: ["src/x.ts"] });
  });

  it("measures a branch cut from UAT against UAT, not an older dev: two such worktrees share only what they changed", async () => {
    const upstream = makeRepo({ "src/x.ts": "x\n", "src/y.ts": "y\n" }, "upstream");
    git(upstream, "branch", "dev");
    git(upstream, "checkout", "-q", "-b", "UAT");
    // UAT moves on past dev: work dev doesn't have yet
    for (const f of ["a", "b", "c"]) {
      write(upstream, { [`src/uat-${f}.ts`]: `${f}\n` });
      git(upstream, "add", "-A");
      git(upstream, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", f);
    }
    const clone = path.join(tempDir("clone"), "repo");
    git(path.dirname(clone), "clone", "-q", upstream, clone);
    const a = path.join(path.dirname(clone), "wt-a");
    const b = path.join(path.dirname(clone), "wt-b");
    git(clone, "worktree", "add", "-q", "-b", "feature/1-a", a, "origin/UAT");
    git(clone, "worktree", "add", "-q", "-b", "feature/2-b", b, "origin/UAT");
    write(a, { "src/x.ts": "a's x\n" });
    write(b, { "src/y.ts": "b's y\n" });

    expect(await baseRef(a)).toBe("origin/UAT");
    const ca = await changedFiles(a);
    const cb = await changedFiles(b);
    expect(ca.files).toEqual(["src/x.ts"]);
    expect(cb.files).toEqual(["src/y.ts"]);
    expect(overlaps([{ sessionId: "A", title: "A", cwd: a, ...ca }, { sessionId: "B", title: "B", cwd: b, ...cb }])).toEqual({});
    // a branch cut from dev is still measured against dev
    const c = path.join(path.dirname(clone), "wt-c");
    git(clone, "worktree", "add", "-q", "-b", "feature/3-c", c, "origin/dev");
    expect(await baseRef(c)).toBe("origin/dev");
  });

  it("fails when the branch can't be compared with its base, rather than claim it changed nothing", async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    git(repo, "branch", "dev");
    git(repo, "checkout", "-q", "--orphan", "lonely");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "unrelated");
    await expect(changedFiles(repo)).rejects.toThrow(/no merge base/);
  });
});
