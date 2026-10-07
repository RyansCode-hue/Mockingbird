import * as path from "path";
import { pathToFileURL } from "url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANGED, CREATED, DELETED, changeTypes, globRegex, WatchedFiles, type FileChange } from "../src/main/lsp/watchedFiles";

describe("watched-file globs", () => {
  it("reads ** across folders, * and ? within one, {a,b} and [..]", () => {
    const all = globRegex("/r/**/*", false);
    expect(all.test("/r/a.ts")).toBe(true);
    expect(all.test("/r/src/deep/a.ts")).toBe(true);
    expect(all.test("/other/a.ts")).toBe(false);
    const ts = globRegex("**/*.{ts,tsx}", false);
    expect(ts.test("a.ts")).toBe(true);
    expect(ts.test("x/y/b.tsx")).toBe(true);
    expect(ts.test("c.js")).toBe(false);
    expect(globRegex("src/?.ts", false).test("src/a.ts")).toBe(true);
    expect(globRegex("src/?.ts", false).test("src/ab.ts")).toBe(false);
    expect(globRegex("[ab].ts", false).test("b.ts")).toBe(true);
    expect(globRegex("[!ab].ts", false).test("a.ts")).toBe(false);
    expect(globRegex("a.b", false).test("axb")).toBe(false); // a dot is a dot
  });
  it("ignores case where the file system does", () => {
    // servers register paths in their own spelling (TypeScript lowercases them)
    expect(globRegex("/tmp/proj/**/*", true).test("/tmp/Proj/Main.ts")).toBe(true);
    expect(globRegex("/tmp/proj/**/*", false).test("/tmp/Proj/Main.ts")).toBe(false);
  });
});

describe("watching files for a language server", () => {
  afterEach(() => vi.useRealTimers());

  const root = "/r";
  const uri = (rel: string) => pathToFileURL(path.join(root, rel)).href;

  // files that exist, by name: "old" ones were born long ago, the rest just now
  function setup(existing: string[] = [], old: string[] = []) {
    vi.useFakeTimers();
    const sent: FileChange[][] = [];
    let emit: (event: "rename" | "change", file: string | null) => void = () => {};
    let fail: (err: Error) => void = () => {};
    const closed = vi.fn();
    const errors: Error[] = [];
    const born = new Map<string, number>([...existing.map((f) => [path.join(root, f), Date.now()] as const), ...old.map((f) => [path.join(root, f), Date.now() - 86_400_000] as const)]);
    const w = new WatchedFiles(root, (c) => sent.push(c), {
      watch: (_dir, onEvent, onError) => {
        emit = onEvent;
        fail = onError;
        return { close: closed };
      },
      bornAt: (f) => born.get(f) ?? null,
      onError: (e) => errors.push(e),
    });
    return { w, sent, emit: (e: "rename" | "change", f: string) => emit(e, f), fail: (e: Error) => fail(e), closed, errors };
  }

  it("doesn't watch until a server asks, and stops when it no longer does", () => {
    const watch = vi.fn(() => ({ close: () => {} }));
    const w = new WatchedFiles(root, () => {}, { watch });
    expect(watch).not.toHaveBeenCalled();
    w.register("a", [{ globPattern: "**/*" }]);
    w.register("b", [{ globPattern: "**/*.ts" }]);
    expect(watch).toHaveBeenCalledTimes(1);
    const t = setup();
    t.w.register("a", [{ globPattern: "**/*" }]);
    t.w.unregister("a");
    expect(t.closed).toHaveBeenCalled();
  });

  it("sends a burst once it goes quiet, as one batch with each file's kind of change", () => {
    const t = setup(["new.ts"], ["edited.ts", "saved.ts"]);
    t.w.register("a", [{ globPattern: "/r/**/*" }]);
    t.emit("rename", "new.ts");
    t.emit("change", "new.ts"); // a creation followed by a write is still a creation
    t.emit("change", "edited.ts");
    t.emit("rename", "saved.ts"); // macOS reports a write to an existing file as a rename
    t.emit("rename", "gone.ts");
    vi.advanceTimersByTime(100);
    expect(t.sent).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(t.sent).toEqual([
      [
        { uri: uri("new.ts"), type: DELETED },
        { uri: uri("new.ts"), type: CREATED },
        { uri: uri("edited.ts"), type: CHANGED },
        { uri: uri("saved.ts"), type: CHANGED },
        { uri: uri("gone.ts"), type: DELETED },
      ],
    ]);
  });

  it("tells a write to an existing file from a new one by when the file was born", () => {
    const now = 1_000_000;
    expect(changeTypes("rename", now - 60_000, now)).toEqual([CHANGED]);
    expect(changeTypes("rename", now - 100, now)).toEqual([DELETED, CREATED]); // new, or replaced by an atomic save
    expect(changeTypes("change", now, now)).toEqual([CHANGED]);
    expect(changeTypes("rename", null, now)).toEqual([DELETED]);
  });

  it("doesn't hold changes back for the whole of a long burst", () => {
    const t = setup([], ["a.ts"]);
    t.w.register("a", [{ globPattern: "**/*" }]);
    for (let i = 0; i < 12; i++) {
      t.emit("change", "a.ts");
      vi.advanceTimersByTime(100); // never quiet for long enough
    }
    expect(t.sent.length).toBe(1);
  });

  it("sends only what a server asked for: its globs, its kinds of change, never git's own files", () => {
    const t = setup([], ["a.ts", "a.js", "sub/x.json", "top.json"]);
    t.w.register("ts", [{ globPattern: "**/*.ts", kind: 2 }]); // changes only
    t.w.register("rel", [{ globPattern: { baseUri: pathToFileURL("/r/sub").href, pattern: "*.json" } }]);
    t.emit("change", "a.ts");
    t.emit("change", "a.js");
    t.emit("rename", "b.ts"); // deleted: not a kind the .ts watcher wants
    t.emit("change", path.join(".git", "index"));
    t.emit("change", path.join("sub", "x.json"));
    t.emit("change", "top.json"); // outside the relative pattern's base
    vi.advanceTimersByTime(200);
    expect(t.sent).toEqual([[{ uri: uri("a.ts"), type: CHANGED }, { uri: uri("sub/x.json"), type: CHANGED }]]);
  });

  it("says so when the folder can't be watched, and doesn't retry for every registration", () => {
    const t = setup();
    t.w.register("a", [{ globPattern: "**/*" }]);
    t.fail(new Error("EMFILE: too many open files"));
    expect(t.errors.map((e) => e.message)).toEqual(["EMFILE: too many open files"]);
    expect(t.closed).toHaveBeenCalled();
    t.w.register("b", [{ globPattern: "**/*" }]);
    t.emit("change", "a.ts");
    vi.advanceTimersByTime(2000);
    expect(t.sent).toEqual([]);
  });
});
