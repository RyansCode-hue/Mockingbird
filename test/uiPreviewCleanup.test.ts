import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers";

// How the UI preview lets go of Chrome and its profile (scripts/ui-preview.mjs): Chrome's helpers can still be writing
// there after it's gone, and a folder that won't go is no failure of the test that used it.
// @ts-expect-error — a plain .mjs build script, no type declarations
const load = () => import("../scripts/ui-preview.mjs");

const failing = (times: number) => {
  let left = times;
  return vi.fn(() => {
    if (left-- > 0) throw new Error("ENOTEMPTY: directory not empty, rmdir 'Default'");
  });
};

describe("removing Chrome's profile", () => {
  it("removes a folder that's there", async () => {
    const { removeWhenLetGo } = await load();
    const dir = path.join(tempDir("profile"), "p");
    fs.mkdirSync(path.join(dir, "Default"), { recursive: true });
    expect(await removeWhenLetGo(dir)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("tries again while something's still writing there, saying nothing once it's gone", async () => {
    const { removeWhenLetGo } = await load();
    const remove = failing(3);
    const warn = vi.fn();
    expect(await removeWhenLetGo("/some/profile", { attempts: 5, delayMs: 1, remove, warn })).toBe(true);
    expect(remove).toHaveBeenCalledTimes(4);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns by name, and doesn't throw, when it won't go", async () => {
    const { removeWhenLetGo } = await load();
    const remove = failing(Infinity);
    const warn = vi.fn();
    expect(await removeWhenLetGo("/some/profile", { attempts: 3, delayMs: 1, remove, warn })).toBe(false);
    expect(remove).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("/some/profile");
    expect(warn.mock.calls[0][0]).toContain("ENOTEMPTY");
  });
});

describe("stopping Chrome", () => {
  /** A child that exits on the signals in `exitsOn`. */
  const child = (exitsOn: string[]) => {
    const c = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as string | null,
      signals: [] as string[],
      kill(signal = "SIGTERM") {
        c.signals.push(signal);
        if (exitsOn.includes(signal)) {
          c.signalCode = signal;
          setTimeout(() => c.emit("exit"), 0);
        }
        return true;
      },
    });
    return c;
  };

  it("asks, and needs no more when it goes", async () => {
    const { stopChild } = await load();
    const c = child(["SIGTERM"]);
    await stopChild(c, { askMs: 1000, killMs: 1000 });
    expect(c.signals).toEqual(["SIGTERM"]);
  });

  it("kills it when it won't go", async () => {
    const { stopChild } = await load();
    const c = child(["SIGKILL"]);
    await stopChild(c, { askMs: 5, killMs: 1000 });
    expect(c.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("ends even if that doesn't stop it", async () => {
    const { stopChild } = await load();
    const c = child([]);
    await stopChild(c, { askMs: 5, killMs: 5 });
    expect(c.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does nothing to one that's gone", async () => {
    const { stopChild } = await load();
    const c = child([]);
    c.exitCode = 0;
    await stopChild(c);
    expect(c.signals).toEqual([]);
  });
});
