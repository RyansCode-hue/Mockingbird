import { describe, expect, it, vi } from "vitest";
import { settled } from "../src/renderer/settled";

describe("an IPC reply a view waits on", () => {
  it("passes a reply through as it came, { error } replies included", async () => {
    expect(await settled(Promise.resolve([1, 2]), "Couldn't read the call stack")).toEqual([1, 2]);
    expect(await settled(Promise.resolve({ error: "not paused" }), "Couldn't read the call stack")).toEqual({ error: "not paused" });
  });
  it("turns a rejected call into an { error } saying what failed, so the view stops waiting", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await settled(Promise.reject(new Error("debug adapter exited")), "Couldn't read the call stack");
    expect(r).toEqual({ error: "Couldn't read the call stack: debug adapter exited" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
