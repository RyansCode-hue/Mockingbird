import { afterEach, describe, expect, it } from "vitest";
import { workflowStates } from "../src/renderer/tickets";

const g = globalThis as unknown as { window?: { mb: unknown } };
afterEach(() => delete g.window);

describe("a board's workflow states", () => {
  it("joins every type's states in their workflow order", async () => {
    const states: Record<string, string[]> = { Bug: ["New", "Active", "Resolved"], Task: ["New", "Doing", "Done"] };
    g.window = { mb: { adoStates: async (t: string) => states[t] } };
    expect(await workflowStates(["Bug", "Task"])).toEqual({ states: ["New", "Active", "Resolved", "Doing", "Done"], error: "" });
  });
  it("keeps the states it could read and says which type failed", async () => {
    g.window = { mb: { adoStates: async (t: string) => (t === "Bug" ? { error: "401 Unauthorized" } : ["New", "Done"]) } };
    const r = await workflowStates(["Bug", "Task"]);
    expect(r.states).toEqual(["New", "Done"]);
    expect(r.error).toBe("Couldn't read the states a Bug can be in: 401 Unauthorized");
  });
});
