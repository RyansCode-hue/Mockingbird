import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { claudeSandboxSources, SettingsWatch } from "../src/main/claudeSettingsWatch";
import { until } from "../src/main/team/loopback";
import { tempDir } from "./helpers";

const FAST = { pollMs: 20, settleMs: 40 };
const settle = () => new Promise((r) => setTimeout(r, 150));

describe("watching the settings a room pane takes beside its own", () => {
  it("are the user's own and an administrator's, with the administrator's drop-ins", () => {
    expect(claudeSandboxSources("/Users/ryan")).toEqual({
      files: ["/Users/ryan/.claude/settings.json", "/Library/Application Support/ClaudeCode/managed-settings.json"],
      dirs: ["/Library/Application Support/ClaudeCode/managed-settings.d"],
    });
    expect(claudeSandboxSources().files[0]).toBe(path.join(os.homedir(), ".claude", "settings.json"));
  });

  it("says once, when they've settled, that one was written, replaced, removed or made, and nothing while they're still", async () => {
    const dir = tempDir("settings-watch");
    const user = path.join(dir, "settings.json");
    const dropIns = path.join(dir, "managed-settings.d");
    let changes = 0;
    const w = new SettingsWatch({ files: [user], dirs: [dropIns] }, () => changes++, FAST);
    w.start();
    try {
      await settle();
      expect(changes).toBe(0);
      // made
      fs.writeFileSync(user, "{}");
      await until(() => changes === 1, "a new file");
      // written in place, several times in a row: once
      fs.writeFileSync(user, '{"sandbox":{}}');
      fs.writeFileSync(user, '{"sandbox":{"excludedCommands":["docker"]}}');
      await until(() => changes === 2, "a write");
      await settle();
      expect(changes).toBe(2);
      // an editor's save: a new file renamed over it
      fs.writeFileSync(`${user}.tmp`, '{"sandbox":{"excludedCommands":[]}}');
      fs.renameSync(`${user}.tmp`, user);
      await until(() => changes === 3, "a replacement");
      // an administrator's drop-in folder made, and a drop-in written in it
      fs.mkdirSync(dropIns);
      await until(() => changes === 4, "a drop-in folder");
      fs.writeFileSync(path.join(dropIns, "10-sandbox.json"), "{}");
      await until(() => changes === 5, "a drop-in");
      fs.writeFileSync(path.join(dropIns, "10-sandbox.json"), '{"sandbox":{"enabled":false}}');
      await until(() => changes === 6, "a drop-in written");
      // removed
      fs.rmSync(user);
      await until(() => changes === 7, "a removal");
      await settle();
      expect(changes).toBe(7);
    } finally {
      w.stop();
    }
    // stopped, it says nothing more
    fs.writeFileSync(user, "{}");
    await settle();
    expect([changes, w.watching]).toEqual([7, false]);
  });

  it("waits for writes seen one after another to stop before saying so, once", async () => {
    const dir = tempDir("settings-watch");
    const user = path.join(dir, "settings.json");
    let changes = 0;
    const w = new SettingsWatch({ files: [user], dirs: [] }, () => changes++, { pollMs: 10, settleMs: 500 });
    w.start();
    try {
      for (let i = 0; i < 4; i++) {
        fs.writeFileSync(user, JSON.stringify({ step: i, pad: "x".repeat(i) }));
        await new Promise((r) => setTimeout(r, 40));
      }
      expect(changes).toBe(0);
      await until(() => changes === 1, "the burst settled");
      await new Promise((r) => setTimeout(r, 600));
      expect(changes).toBe(1);
    } finally {
      w.stop();
    }
  });

  it("keeps watching after what it calls throws, and says so", async () => {
    const dir = tempDir("settings-watch");
    const user = path.join(dir, "settings.json");
    let calls = 0;
    const errors: unknown[] = [];
    const error = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    const w = new SettingsWatch(
      { files: [user], dirs: [] },
      () => {
        calls++;
        throw new Error("the check couldn't start");
      },
      FAST
    );
    w.start();
    try {
      fs.writeFileSync(user, "{}");
      await until(() => calls === 1, "the first change");
      fs.writeFileSync(user, '{"a":1}');
      await until(() => calls === 2, "the second change");
    } finally {
      w.stop();
      console.error = error;
    }
    expect(errors).toHaveLength(2);
    expect(String((errors[0] as unknown[])[0])).toBe("[sessions] acting on a change to Claude Code's settings failed:");
  });
});
