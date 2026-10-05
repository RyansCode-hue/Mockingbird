import { afterEach, describe, expect, it, vi } from "vitest";
import { readPref, writePref, type PrefStore } from "../src/renderer/prefs";

const memory = (init: Record<string, string> = {}): PrefStore & { data: Record<string, string> } => {
  const data = { ...init };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
};
const broken: PrefStore = {
  getItem: () => {
    throw new Error("storage is off");
  },
  setItem: () => {
    throw new DOMException("quota exceeded", "QuotaExceededError");
  },
};

afterEach(() => vi.restoreAllMocks());

describe("remembered UI state", () => {
  it("reads back what was saved, under the same key and as JSON", () => {
    const store = memory();
    expect(writePref("mb.sideW", 300, store)).toBe(true);
    expect(store.data["mb.sideW"]).toBe("300");
    expect(readPref("mb.sideW", 264, store)).toBe(300);
  });
  it("reads values saved before as plain JSON, so a saved layout survives", () => {
    const store = memory({ "mb.shown": '["s1","s2"]', "mb.helpSeen": "true" });
    expect(readPref<string[]>("mb.shown", [], store)).toEqual(["s1", "s2"]);
    expect(readPref("mb.helpSeen", false, store)).toBe(true);
  });
  it("falls back to the default for a missing key, quietly", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readPref("mb.cols", "auto", memory())).toBe("auto");
    expect(warn).not.toHaveBeenCalled();
  });
  it("falls back to the default, and says so, when the saved value is unreadable or storage is off", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readPref("mb.cols", "auto", memory({ "mb.cols": "{not json" }))).toBe("auto");
    expect(readPref("mb.cols", "auto", broken)).toBe("auto");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain("mb.cols");
  });
  it("says so when a change can't be saved, instead of throwing out of the view", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(writePref("mb.layout", { g: "2x2" }, broken)).toBe(false);
    expect(String(warn.mock.calls[0][0])).toContain("mb.layout");
  });
});
