import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { changedFiles, overlaps, type WorktreeChanges } from "../src/main/conflicts";
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
