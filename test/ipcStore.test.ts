import { describe, expect, it, vi } from "vitest";
import { createIpcStore, loadInto } from "../src/renderer/ipcStore";

describe("a mirrored main-process store", () => {
  it("connects once, on first use, however many views read it", () => {
    const connect = vi.fn();
    const store = createIpcStore(0, connect);
    expect(connect).not.toHaveBeenCalled();
    const off = store.subscribe(() => {});
    store.subscribe(() => {});
    expect(connect).toHaveBeenCalledTimes(1);
    off();
  });
  it("tells every reader when the state changes, until it stops reading", () => {
    let push!: (n: number) => void;
    const store = createIpcStore(0, ({ set }) => (push = set));
    const a = vi.fn();
    const b = vi.fn();
    const offA = store.subscribe(a);
    store.subscribe(b);
    push(1);
    offA();
    push(2);
    expect(store.get()).toBe(2);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });
});

describe("a store's first read", () => {
  it("applies what it read", async () => {
    const apply = vi.fn();
    loadInto("the list", Promise.resolve([1, 2]), apply);
    await new Promise((r) => setTimeout(r, 0));
    expect(apply).toHaveBeenCalledWith([1, 2]);
  });
  it("says what couldn't be read, for an { error } reply or a rejection, and applies nothing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const apply = vi.fn();
    loadInto("the ticket pipelines", Promise.resolve({ error: "pipeline.json is corrupt" }), apply);
    loadInto("the message log", Promise.reject(new Error("no handler")), apply);
    await new Promise((r) => setTimeout(r, 0));
    expect(apply).not.toHaveBeenCalled();
    expect(spy.mock.calls.map((c) => String(c[0]))).toEqual(["Couldn't read the ticket pipelines: pipeline.json is corrupt", "Couldn't read the message log:"]);
    spy.mockRestore();
  });
});
