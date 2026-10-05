import { describe, expect, it } from "vitest";
import { currentSession } from "../src/renderer/debugStore";
import type { DebugSessionInfo } from "../src/shared/types";

const s = (id: string, state: DebugSessionInfo["state"]) => ({ id, state }) as DebugSessionInfo;

describe("the debug session the controls and console act on", () => {
  it("is a paused one first", () => {
    expect(currentSession([s("a", "running"), s("b", "stopped"), s("c", "running")])?.id).toBe("b");
  });
  it("else the newest that hasn't ended", () => {
    expect(currentSession([s("a", "running"), s("b", "running"), s("c", "ended")])?.id).toBe("b");
  });
  it("is none when every session has ended", () => {
    expect(currentSession([s("a", "ended")])).toBeUndefined();
  });
});
