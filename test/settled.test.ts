import { describe, expect, it, vi } from "vitest";
import { checkNote, runCheck, settled } from "../src/renderer/settled";

describe("a check a Settings row shows", () => {
  const note = (c: Parameters<typeof checkNote<{ az: boolean }>>[0]) => checkNote(c, (v) => (v.az ? "Found" : "Not installed"));
  it("reads checking… only while the call is out, then its answer", () => {
    expect(note(null)).toBe("checking…");
    expect(note({ az: true })).toBe("Found");
  });
  it("lands a rejected call as the row's failure, logged with what was being checked", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await runCheck("the Azure CLI", Promise.reject(new Error("No handler registered for 'connectors:status'")));
    expect(note(r)).toBe("Couldn't check: No handler registered for 'connectors:status'");
    expect(spy.mock.calls.some((c) => String(c[0]).includes("couldn't check the Azure CLI"))).toBe(true);
    spy.mockRestore();
  });
  it("logs an { error } answer too, and shows it the same way", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await runCheck("the Azure CLI", Promise.resolve({ error: "login shell timed out" }));
    expect(note(r)).toBe("Couldn't check: login shell timed out");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

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
  it("leaves the wording to the caller when it isn't told what failed", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await settled(Promise.reject(new Error("server exited")))).toEqual({ error: "server exited" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
