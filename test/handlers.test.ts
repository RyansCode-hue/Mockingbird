import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { binSettingsChanged, guarded, instructionFile, liveSessionIn, prBaseProblem, rememberAnswer, samePath } from "../src/main/handlers";
import type { SessionInfo } from "../src/shared/types";
import { tempDir } from "./helpers";

describe("IPC handlers", () => {
  const logged: string[] = [];
  const log = (context: string, err: unknown) => {
    logged.push(context);
    return err instanceof Error ? err.message : String(err);
  };

  it("answer { error } for a throw or a rejection, and log it under the channel", async () => {
    expect(await guarded("a:sync", () => { throw new Error("broke"); }, log)()).toEqual({ error: "broke" });
    expect(await guarded("a:async", async () => { throw new Error("later"); }, log)()).toEqual({ error: "later" });
    expect(logged).toEqual(["a:sync", "a:async"]);
  });

  it("pass arguments through and answer the handler's value", async () => {
    expect(await guarded("a:ok", (x: number, y: number) => x + y, log)(2, 3)).toBe(5);
    expect(await guarded("a:okAsync", async (s: string) => s.toUpperCase(), log)("hi")).toBe("HI");
  });
});

const session = (id: string, cwd: string, status: SessionInfo["status"] = "idle") => ({ id, title: id, cwd, status }) as SessionInfo;

describe("a worktree in use", () => {
  it("is found however its path is spelled: trailing slash, or through a symlink", () => {
    const wt = fs.realpathSync(tempDir("wt"));
    const link = path.join(tempDir("links"), "wt-link");
    fs.symlinkSync(wt, link);
    const list = [session("a", wt)];
    expect(liveSessionIn(list, `${wt}/`)?.id).toBe("a");
    expect(liveSessionIn(list, link)?.id).toBe("a");
    expect(liveSessionIn(list, tempDir("other"))).toBeUndefined();
  });

  it("doesn't count a session that has ended", () => {
    const wt = tempDir("wt");
    expect(liveSessionIn([session("a", wt, "dead")], wt)).toBeUndefined();
    expect(liveSessionIn([session("a", wt, "dead"), session("b", wt, "working")], wt)?.id).toBe("b");
  });

  it("compares folders that are gone by their spelling", () => {
    expect(samePath("/no/such/folder/", "/no/such/folder")).toBe(true);
    expect(samePath("/no/such/a", "/no/such/b")).toBe(false);
  });
});

describe("a pull request's base", () => {
  const bases = ["dev", "main", "release/2.0"];
  it("is the target's own branch, or another branch on origin", () => {
    expect(prBaseProblem("dev", "dev", bases)).toBeNull();
    expect(prBaseProblem("main", "main", bases)).toBeNull();
    expect(prBaseProblem("dev", "release/2.0", bases)).toBeNull();
  });
  it("is never the other target's branch", () => {
    expect(prBaseProblem("main", "dev", bases)).toMatch(/dev is a dev\/UAT branch, and this pull request is to main/);
    expect(prBaseProblem("dev", "main", bases)).toMatch(/main is a main branch/);
    expect(prBaseProblem("main", "develop", ["develop", "main"])).toMatch(/develop is a dev\/UAT branch/);
  });
  it("must be on origin", () => {
    expect(prBaseProblem("dev", "gone", bases)).toMatch(/origin has no branch gone/);
  });
});

describe("the CLAUDE.md editor", () => {
  it("reaches CLAUDE.md files only", () => {
    expect(instructionFile("~/.claude/CLAUDE.md")).toBe(path.join(os.homedir(), ".claude", "CLAUDE.md"));
    expect(instructionFile("/Users/you/Code/app/CLAUDE.md")).toBe("/Users/you/Code/app/CLAUDE.md");
    expect(() => instructionFile("/Users/you/.ssh/config")).toThrow(/Only CLAUDE.md files/);
    expect(() => instructionFile("/Users/you/Code/app/CLAUDE.md/../.env")).toThrow(/Only CLAUDE.md files/);
    expect(() => instructionFile("CLAUDE.md")).toThrow(/Only CLAUDE.md files/); // relative: to wherever the app runs from
    expect(() => instructionFile(undefined)).toThrow(/Only CLAUDE.md files/);
  });
});

describe("a remembered answer", () => {
  it("is asked for once, shared by callers while in flight, then remembered", async () => {
    let asked = 0;
    const help = rememberAnswer(async () => (asked++, "--model <alias>"), () => {});
    expect(await Promise.all([help.get(), help.get()])).toEqual(["--model <alias>", "--model <alias>"]);
    expect(await help.get()).toBe("--model <alias>");
    expect(asked).toBe(1);
    help.forget();
    await help.get();
    expect(asked).toBe(2);
  });

  it("isn't remembered while there's none, or when asking failed — and a failure is reported", async () => {
    const answers: (() => Promise<string | null>)[] = [async () => null, async () => { throw new Error("timed out"); }, async () => "help"];
    const errors: unknown[] = [];
    const help = rememberAnswer(() => answers.shift()!(), (err) => errors.push(err));
    expect(await help.get()).toBeNull(); // not installed yet
    expect(await help.get()).toBeNull(); // failed
    expect(errors).toEqual([new Error("timed out")]);
    expect(await help.get()).toBe("help");
    expect(await help.get()).toBe("help");
  });
});

describe("a settings change", () => {
  it("looks the binaries up again only when one of their paths changed", () => {
    const s = { claudeBin: "claude", codexBin: "codex" };
    expect(binSettingsChanged(s, { ...s })).toBe(false);
    expect(binSettingsChanged(s, { ...s, claudeBin: "/opt/claude" })).toBe(true);
    expect(binSettingsChanged(s, { ...s, codexBin: "~/bin/codex" })).toBe(true);
  });
});
