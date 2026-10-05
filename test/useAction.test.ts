import { describe, expect, it, vi } from "vitest";
import { createActions } from "../src/renderer/useAction";

/** A promise to settle by hand. */
function later<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function tracker() {
  const changes: string[][] = [];
  const errors: string[] = [];
  const actions = createActions((inflight) => changes.push(inflight), (e) => errors.push(e));
  return { ...actions, changes, errors, inflight: () => changes[changes.length - 1] ?? [] };
}

describe("actions in flight", () => {
  it("stays busy until the last of overlapping actions ends, in whatever order they end", async () => {
    const t = tracker();
    const push = later<null>();
    const stage = later<null>();
    const pushing = t.run("push", () => push.promise);
    const staging = t.run("stage", () => stage.promise);
    expect(t.inflight()).toEqual(["push", "stage"]);
    stage.resolve(null);
    await staging;
    expect(t.isBusy()).toBe(true); // the push is still running
    expect(t.inflight()).toEqual(["push"]);
    push.resolve(null);
    await pushing;
    expect(t.isBusy()).toBe(false);
  });

  it("is busy synchronously, before the view re-renders", () => {
    const t = tracker();
    void t.run("commit", () => later<null>().promise);
    expect(t.isBusy()).toBe(true);
  });

  it("shows an { error } reply and hands it back", async () => {
    const t = tracker();
    const r = await t.run("pull", async () => ({ error: "git pull: not possible to fast-forward" }));
    expect(r).toEqual({ error: "git pull: not possible to fast-forward" });
    expect(t.errors).toEqual(["", "git pull: not possible to fast-forward"]);
    expect(t.isBusy()).toBe(false);
  });

  it("turns a rejected call into an { error } it shows, and isn't left busy", async () => {
    const t = tracker();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await t.run("save", () => Promise.reject(new Error("IPC channel closed")));
    expect(r).toEqual({ error: "IPC channel closed" });
    expect(t.errors[t.errors.length - 1]).toBe("IPC channel closed");
    expect(t.isBusy()).toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("clears the last error when a new action starts", async () => {
    const t = tracker();
    await t.run("a", async () => ({ error: "no" }));
    await t.run("b", async () => "fine");
    expect(t.errors).toEqual(["", "no", ""]);
  });
});
