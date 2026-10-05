import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { MessageLog } from "../src/main/messageLog";
import { tempDir } from "./helpers";

const msg = (i: number) => ({ at: i, from: "a", fromTitle: "A", to: "b", toTitle: "B", text: `m${i}`, outcome: "delivered" });

describe("the agent message log", () => {
  it("keeps the last 300 across restarts", () => {
    const f = path.join(tempDir("log"), "messages.json");
    const log = new MessageLog(f);
    for (let i = 0; i < 305; i++) log.add(msg(i));
    const again = new MessageLog(f).list();
    expect(again).toHaveLength(300);
    expect(again[0].text).toBe("m5");
    expect(again.at(-1)!.text).toBe("m304");
  });
  it("keeps an unreadable file aside instead of overwriting it", () => {
    const f = path.join(tempDir("log"), "messages.json");
    fs.writeFileSync(f, "{oops");
    expect(new MessageLog(f).list()).toEqual([]);
    expect(fs.readdirSync(path.dirname(f)).some((n) => n.startsWith("messages.json.corrupt-"))).toBe(true);
  });
  it("starts empty, and says so, when an unreadable file can't even be moved aside", () => {
    const dir = tempDir("log");
    const f = path.join(dir, "messages.json");
    fs.writeFileSync(f, "{oops");
    fs.chmodSync(dir, 0o500); // nothing can be renamed in here
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(new MessageLog(f).list()).toEqual([]);
      expect(errors.mock.calls.some((c) => /couldn't be moved aside/.test(String(c[0])))).toBe(true);
    } finally {
      fs.chmodSync(dir, 0o700);
      errors.mockRestore();
    }
  });
  it("keeps a message it couldn't save in the list, and reports the failure", () => {
    const dir = tempDir("log");
    const log = new MessageLog(path.join(dir, "messages.json"));
    fs.chmodSync(dir, 0o500);
    try {
      expect(() => log.add(msg(1))).toThrow();
      expect(log.list()).toHaveLength(1);
      expect(fs.readdirSync(dir)).toEqual([]); // no temp file left behind
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});
