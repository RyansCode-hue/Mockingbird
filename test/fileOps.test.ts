import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { readJsonFile, readSlice, writeFileAtomic, writeGenerated } from "../src/main/fileOps";
import { codexRollouts, epochMs } from "../src/main/agentFiles";
import { tempDir } from "./helpers";

describe("writing files in one step", () => {
  it("replaces the file whole, keeping its permissions, with nothing left beside it", () => {
    const dir = tempDir("atomic");
    const f = path.join(dir, "settings.json");
    fs.writeFileSync(f, "old", { mode: 0o600 });
    fs.chmodSync(f, 0o600);
    const reader = fs.openSync(f, "r"); // someone reading it as it's replaced
    writeFileAtomic(f, "new");
    const buf = Buffer.alloc(8);
    expect(buf.toString("utf8", 0, fs.readSync(reader, buf, 0, 8, 0))).toBe("old");
    fs.closeSync(reader);
    expect(fs.readFileSync(f, "utf8")).toBe("new");
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
  });
  it("creates the folder a new file goes in", () => {
    const f = path.join(tempDir("atomic"), "never-run", "hooks.json");
    writeFileAtomic(f, "{}");
    expect(fs.readFileSync(f, "utf8")).toBe("{}");
  });
  it("leaves a generated file alone while it's current", () => {
    const f = path.join(tempDir("gen"), "hook.sh");
    expect(writeGenerated(f, "#!/bin/bash\n", 0o755)).toBe(true);
    const ino = fs.statSync(f).ino;
    expect(writeGenerated(f, "#!/bin/bash\n", 0o755)).toBe(false);
    expect(fs.statSync(f).ino).toBe(ino);
    fs.chmodSync(f, 0o644);
    expect(writeGenerated(f, "#!/bin/bash\n", 0o755)).toBe(true); // no longer executable: rewritten
    expect(fs.statSync(f).mode & 0o777).toBe(0o755);
  });
});

describe("reading a JSON file", () => {
  it("answers the fallback when there is no file, or nothing in it", () => {
    const dir = tempDir("json");
    expect(readJsonFile(path.join(dir, "none.json"), { empty: true })).toEqual({ empty: true });
    fs.writeFileSync(path.join(dir, "blank.json"), "  \n");
    expect(readJsonFile(path.join(dir, "blank.json"), {})).toEqual({});
    fs.writeFileSync(path.join(dir, "ok.json"), '{"a":1}');
    expect(readJsonFile(path.join(dir, "ok.json"), {})).toEqual({ a: 1 });
  });
  it("throws, naming the file, when it isn't JSON or can't be read — and leaves it where it is", () => {
    const dir = tempDir("json");
    const bad = path.join(dir, "settings.json");
    fs.writeFileSync(bad, "{ broken");
    expect(() => readJsonFile(bad, {})).toThrow(`${bad} is not valid JSON`);
    expect(fs.readFileSync(bad, "utf8")).toBe("{ broken");
    expect(() => readJsonFile(dir, {})).toThrow(/EISDIR/);
  });
});

describe("reading part of a file", () => {
  it("takes the start or the end, or all of a small file", () => {
    const f = path.join(tempDir("slice"), "t.jsonl");
    fs.writeFileSync(f, "one\ntwo\nthree\n");
    expect(readSlice(f, "start", 6)).toBe("one\ntw");
    expect(readSlice(f, "end", 7)).toBe("\nthree\n");
    expect(readSlice(f, "end", 1000)).toBe("one\ntwo\nthree\n");
  });
});

describe("agent files", () => {
  it("lists Codex rollouts newest first, up to a limit", () => {
    const at = (day: string, name: string) => {
      const dir = path.join(os.homedir(), ".codex", "sessions", "2026", "09", day);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), "{}\n");
    };
    at("01", "rollout-2026-09-01T10-00-00-a.jsonl");
    at("02", "rollout-2026-09-02T09-00-00-b.jsonl");
    at("02", "rollout-2026-09-02T11-00-00-c.jsonl");
    at("02", "notes.txt");
    expect([...codexRollouts()].map((f) => path.basename(f))).toEqual([
      "rollout-2026-09-02T11-00-00-c.jsonl",
      "rollout-2026-09-02T09-00-00-b.jsonl",
      "rollout-2026-09-01T10-00-00-a.jsonl",
    ]);
    expect([...codexRollouts(2)]).toHaveLength(2);
  });
  it("lists no rollouts without a sessions folder, and passes over stray files in it", () => {
    const sessions = path.join(os.homedir(), ".codex", "sessions");
    fs.rmSync(sessions, { recursive: true, force: true });
    expect([...codexRollouts()]).toEqual([]);
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, ".DS_Store"), "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect([...codexRollouts()]).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
  it("leaves out, and logs, a folder it can't list — and throws when that leaves nothing", () => {
    const sessions = path.join(os.homedir(), ".codex", "sessions");
    fs.rmSync(sessions, { recursive: true, force: true });
    const good = path.join(sessions, "2026", "09", "02");
    fs.mkdirSync(good, { recursive: true });
    fs.writeFileSync(path.join(good, "rollout-2026-09-02T09-00-00-b.jsonl"), "{}\n");
    const locked = path.join(sessions, "2026", "08");
    fs.mkdirSync(path.join(locked, "30"), { recursive: true });
    fs.chmodSync(locked, 0o000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect([...codexRollouts()].map((f) => path.basename(f))).toEqual(["rollout-2026-09-02T09-00-00-b.jsonl"]);
      expect(String(warn.mock.calls[0]?.[0])).toContain(locked);
      fs.rmSync(path.join(sessions, "2026", "09"), { recursive: true });
      expect(() => [...codexRollouts()]).toThrow(locked);
    } finally {
      fs.chmodSync(locked, 0o755);
      warn.mockRestore();
    }
  });
  it("reads timestamps as ISO strings, epoch seconds or epoch milliseconds", () => {
    expect(epochMs("2026-09-01T10:00:00Z")).toBe(Date.parse("2026-09-01T10:00:00Z"));
    expect(epochMs(1790289000)).toBe(1790289000_000);
    expect(epochMs(1790289000_000)).toBe(1790289000_000);
    expect(epochMs("soon")).toBeNull();
    expect(epochMs(undefined)).toBeNull();
  });
});
