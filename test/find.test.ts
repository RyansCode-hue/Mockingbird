import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { clipLine, listAllFiles, parseGrepLine, searchFiles } from "../src/main/find";
import { makeRepo, tempDir, write } from "./helpers";

describe("listing every file (⌘P)", () => {
  it("lists tracked and untracked files in a repository, skipping what .gitignore ignores", async () => {
    const repo = makeRepo({ "src/a.ts": "a\n", ".gitignore": "secret.env\n" });
    write(repo, { "new file.ts": "n\n", "secret.env": "x\n" });
    const { files, truncated } = await listAllFiles(repo);
    expect(files.sort()).toEqual([".gitignore", "new file.ts", "src/a.ts"]);
    expect(truncated).toBe(false);
  });

  it("walks a plain folder, skipping hidden and dependency folders", async () => {
    const dir = tempDir("plain");
    write(dir, { "a.txt": "a", "sub/b.txt": "b", ".hidden/c.txt": "c", "node_modules/x/d.js": "d" });
    expect((await listAllFiles(dir)).files.sort()).toEqual(["a.txt", "sub/b.txt"]);
  });
});

describe("searching file contents (⌘⇧F)", () => {
  it("finds a fixed string, case-insensitively by default, in tracked and untracked files", async () => {
    const repo = makeRepo({ "a.txt": "Hello world\nbye\n", "dir/b c.txt": "say hello: yes\n" });
    write(repo, { "u.txt": "hello untracked\n" });
    const r = await searchFiles(repo, "hello", { regex: false, matchCase: false });
    expect(r.hits.map((h) => `${h.path}:${h.line}:${h.text}`).sort()).toEqual([
      "a.txt:1:Hello world",
      "dir/b c.txt:1:say hello: yes",
      "u.txt:1:hello untracked",
    ]);
    expect(r.files).toBe(3);
    expect(r.stopped).toBeNull();
    expect((await searchFiles(repo, "hello", { regex: false, matchCase: true })).hits).toHaveLength(2);
  });

  it("treats the query literally unless regex is on", async () => {
    const repo = makeRepo({ "a.ts": "const x = a.b(1);\nconst y = aXb(2);\n" });
    expect((await searchFiles(repo, "a.b(", { regex: false, matchCase: true })).hits.map((h) => h.line)).toEqual([1]);
    expect((await searchFiles(repo, "a.b\\(", { regex: true, matchCase: true })).hits.map((h) => h.line)).toEqual([1, 2]);
  });

  it("finds nothing without failing, and reports a broken pattern as an error", async () => {
    const repo = makeRepo({ "a.txt": "x\n" });
    expect((await searchFiles(repo, "zzz", { regex: false, matchCase: false })).hits).toEqual([]);
    await expect(searchFiles(repo, "a(", { regex: true, matchCase: false })).rejects.toThrow();
  });

  it("searches a folder that isn't a repository with grep", async () => {
    const dir = tempDir("plain-grep");
    write(dir, { "a.txt": "needle here\n", "node_modules/m.js": "needle\n" });
    const r = await searchFiles(dir, "NEEDLE", { regex: false, matchCase: false });
    expect(r.hits).toEqual([{ path: "a.txt", line: 1, text: "needle here" }]);
  });

  it("stops at the match limit and says so", async () => {
    const repo = makeRepo({ "big.txt": "hit\n".repeat(2500) });
    const r = await searchFiles(repo, "hit", { regex: false, matchCase: false });
    expect(r.hits).toHaveLength(2000);
    expect(r.stopped).toBe("limit");
  });
});

describe("search output", () => {
  it("parses git grep's and grep's NUL-separated lines", () => {
    expect(parseGrepLine("d/b c.txt\u000012\u0000a: b", true)).toEqual({ path: "d/b c.txt", line: 12, text: "a: b" });
    expect(parseGrepLine("./d/x.txt\u00003:a: b", false)).toEqual({ path: "d/x.txt", line: 3, text: "a: b" });
    expect(parseGrepLine("Binary file matches", true)).toBeNull();
  });

  it("cuts a very long line to a window around its match", () => {
    const line = "x".repeat(1000) + "NEEDLE" + "y".repeat(1000);
    const clipped = clipLine(line, "needle", { regex: false, matchCase: false });
    expect(clipped.length).toBeLessThan(260);
    expect(clipped).toContain("NEEDLE");
    expect(clipLine("short", "s", { regex: false, matchCase: false })).toBe("short");
  });
});

it("returns paths relative to the session folder", async () => {
  const repo = makeRepo({ "a.txt": "token\n" });
  const r = await searchFiles(repo, "token", { regex: false, matchCase: false });
  for (const h of r.hits) expect(fs.existsSync(path.join(repo, h.path))).toBe(true);
});
