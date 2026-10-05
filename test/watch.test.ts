import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { FolderWatcher, ignoredChange } from "../src/main/watch";
import { tempDir } from "./helpers";

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return cond();
};

describe("which changes matter", () => {
  it("ignores dependency installs and git's object store, not edits, staging or commits", () => {
    expect(ignoredChange("src/app.ts")).toBe(false);
    expect(ignoredChange(".git/index")).toBe(false);
    expect(ignoredChange(".git/HEAD")).toBe(false);
    expect(ignoredChange("node_modules/react/index.js")).toBe(true);
    expect(ignoredChange("packages/web/node_modules/x.js")).toBe(true);
    expect(ignoredChange("node_modules")).toBe(true);
    expect(ignoredChange("my_node_modules_notes.md")).toBe(false);
    expect(ignoredChange(".git/objects/ab/cdef")).toBe(true);
    expect(ignoredChange(".git/index.lock")).toBe(true);
    expect(ignoredChange(".git/refs/heads/main.lock")).toBe(true);
    expect(ignoredChange("yarn.lock")).toBe(false); // a project's lockfiles are tracked files
    expect(ignoredChange("Cargo.lock")).toBe(false);
    expect(ignoredChange("api/poetry.lock")).toBe(false);
    expect(ignoredChange("sub/.DS_Store")).toBe(true);
  });
});

describe("FolderWatcher", () => {
  it("says when a file in a watched folder changes, once per burst", async () => {
    const root = fs.realpathSync(tempDir("watched"));
    const seen: string[] = [];
    const w = new FolderWatcher((r) => seen.push(r), (_r, err) => { throw err; }, 80);
    expect(w.set([root]).watching).toEqual([root]);
    await new Promise((r) => setTimeout(r, 150)); // let the watch settle in before writing
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), "x");
    expect(await until(() => seen.length > 0)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.length).toBeLessThanOrEqual(2); // one burst, coalesced
    expect(seen.every((r) => r === root)).toBe(true);
    w.set([]);
  });

  it("stays quiet for ignored paths, and stops watching folders no longer listed", async () => {
    const root = fs.realpathSync(tempDir("quiet"));
    fs.mkdirSync(path.join(root, "node_modules"));
    const seen: string[] = [];
    const w = new FolderWatcher((r) => seen.push(r), () => {}, 50);
    w.set([root]);
    await new Promise((r) => setTimeout(r, 150));
    fs.writeFileSync(path.join(root, "node_modules", "dep.js"), "x");
    await new Promise((r) => setTimeout(r, 400));
    expect(seen).toEqual([]);
    expect(w.set([]).watching).toEqual([]);
    fs.writeFileSync(path.join(root, "after.txt"), "x");
    await new Promise((r) => setTimeout(r, 400));
    expect(seen).toEqual([]);
  });

  it("reports a folder it can't watch instead of failing the rest", () => {
    const errors: string[] = [];
    const good = fs.realpathSync(tempDir("good"));
    const w = new FolderWatcher(() => {}, (r) => errors.push(r));
    const { watching } = w.set(["/no/such/folder", good]);
    expect(errors).toEqual(["/no/such/folder"]);
    expect(watching).toEqual([good]);
    w.set([]);
  });
});
