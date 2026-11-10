import * as fs from "fs";
import { describe, expect, it, vi } from "vitest";
import { UNTAKEN_CALLS, untakenHandler, type UntakenCall, type UntakenDeps } from "../src/main/takenOverGuard";

type S = { id: string; title: string };
const sessions: Record<string, S> = { s1: { id: "s1", title: "Donor entities" }, n5: { id: "n5", title: "Donor entities" }, s9: { id: "s9", title: "Org dropdowns" } };
/** Main's handlers' deps, with s1 taken over by Nick; n5, a copy from a refused take-over, isn't (takenOverRefusal says so: teamTakeover.test.ts). */
const deps = (refusing = true): UntakenDeps<S> => ({
  sessionOf: (id) => {
    const s = sessions[id];
    if (!s) throw new Error("Session is no longer running");
    return s;
  },
  refusal: () => (refusing ? (id, doing) => (id === "s1" ? `“Donor entities” continues on Nick's laptop — take it back rather than ${doing}` : null) : null),
});

/** The calls registered as index.ts registers them, against a stand-in for ipcMain. */
function registered(d: UntakenDeps<S>) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn) };
  const ran = vi.fn<(call: string, s: S, args: unknown[]) => string>((call, s) => `${call} ran for ${s.id}`);
  for (const call of Object.keys(UNTAKEN_CALLS) as UntakenCall[]) ipc.handle(call, untakenHandler(call, d, (s, ...args: unknown[]) => ran(call, s, args)));
  return { invoke: (call: string, ...args: unknown[]) => handlers.get(call)!(...args), ran };
}

describe("the calls a copy a teammate took over refuses (main)", () => {
  it("refuse a taken-over copy before doing anything, saying what was refused", () => {
    const { invoke, ran } = registered(deps());
    for (const [call, doing] of Object.entries(UNTAKEN_CALLS)) {
      expect(() => invoke(call, "s1", "the brief"), call).toThrow(`“Donor entities” continues on Nick's laptop — take it back rather than ${doing}`);
    }
    expect(ran).not.toHaveBeenCalled();
    // the window's Finish step readies wires from the copy, so it's one of them
    expect(() => invoke("wires:finish", "s1", "done")).toThrow("take it back rather than finishing this copy's step");
  });

  it("let through a copy from a refused take-over and a session no one took, with the call's own arguments", () => {
    const { invoke, ran } = registered(deps());
    for (const call of Object.keys(UNTAKEN_CALLS)) {
      for (const id of ["n5", "s9"]) expect(invoke(call, id, "the brief", 2), `${call} ${id}`).toBe(`${call} ran for ${id}`);
    }
    expect(ran).toHaveBeenCalledWith("turns:restore", sessions.n5, ["the brief", 2]);
  });

  it("with team rooms not started, take nothing as taken over; a session that's gone is said as before", () => {
    const { invoke } = registered(deps(false));
    expect(invoke("handoff:start", "s1", "x")).toBe("handoff:start ran for s1");
    expect(() => invoke("handoff:start", "gone", "x")).toThrow("Session is no longer running");
  });

  // index.ts is Electron's entry: importing it starts the app (app.whenReady, its windows, the single-instance lock) and
  // needs Electron's runtime, so how it registers them is read from its source, whitespace and line breaks aside
  it("are each registered in index.ts through the guard, under its own name, with main's take-over check", () => {
    const src = fs.readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
    for (const call of Object.keys(UNTAKEN_CALLS)) {
      const name = call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(src, call).toMatch(new RegExp(String.raw`\bhandle\(\s*"${name}"\s*,\s*untakenHandler\(\s*"${name}"\s*,\s*untaken\s*,`));
      expect(src.match(new RegExp(String.raw`\bhandle\(\s*"${name}"`, "g")), call).toHaveLength(1);
    }
    expect(src).toMatch(/const untaken\s*:\s*UntakenDeps<SessionInfo>\s*=\s*\{\s*sessionOf\s*,\s*refusal\s*:\s*\(\)\s*=>\s*\(?\s*takeover\s*\?\s*\(sid,\s*doing\)\s*=>\s*takeover!\.takenOverRefusal\(sid,\s*doing\)\s*:\s*null\s*\)?\s*\}/);
  });

  it("Resume's one call is registered in index.ts as SessionManager.resume, and the window's bridge invokes it", () => {
    const src = fs.readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
    expect(src).toMatch(/\bhandle\(\s*"sessions:resume"\s*,\s*\(\s*id\s*\)\s*=>\s*sessions\.resume\(\s*String\(\s*id\s*\)\s*\)\s*\)/);
    expect(src.match(/\bhandle\(\s*"sessions:resume"/g)).toHaveLength(1);
    // the relaunch guard main checks it with is the take-over service's
    expect(src).toMatch(/sessions\.relaunchGuard\s*=\s*\(\s*id\s*\)\s*=>\s*takeover\?\.relaunchRefusal\(\s*id\s*\)\s*\?\?\s*null/);
    const preload = fs.readFileSync(new URL("../src/main/preload.ts", import.meta.url), "utf8");
    expect(preload).toMatch(/\bresumeSession\s*:\s*\(\s*id\s*:\s*string\s*\)[^=]*=>\s*ipcRenderer\.invoke\(\s*"sessions:resume"\s*,\s*id\s*\)/);
  });
});
