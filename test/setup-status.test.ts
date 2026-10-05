import { describe, expect, it, vi } from "vitest";

// Azure DevOps that never answers — the wizard's local checks must not wait on it
vi.mock("../src/main/ado", () => ({ adoIdentity: () => new Promise(() => {}) }));

describe("setupStatus", () => {
  it("gives up on Azure DevOps after 10s and still reports the local checks", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { setupStatus } = await import("../src/main/setup");
    const bins = { binFor: (k: string) => k, refresh: vi.fn(async () => {}) }; // neither CLI installed
    const pending = setupStatus({ settings: { repoRoots: ["~/nowhere"], workTrackerPath: "~/wt" } } as any, bins as any);
    await vi.advanceTimersByTimeAsync(10_000);
    const st = await pending;
    vi.useRealTimers();
    expect(bins.refresh).toHaveBeenCalled();
    expect(st.ado).toEqual({ connected: false, detail: expect.stringMatching(/didn't answer within 10s/) });
    expect(st.claude).toEqual({ found: false, path: null, version: null, signedIn: null });
    expect(st.hooks).toEqual({ claude: false, codex: null });
    expect(st.repoRoots).toEqual([{ path: "~/nowhere", exists: false, repos: 0 }]);
  });

  it("looks the binaries up afresh, without blocking, before asking where they are", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { setupStatus } = await import("../src/main/setup");
    const order: string[] = [];
    const bins = {
      binFor: (k: string) => (order.push(`binFor ${k}`), k),
      refresh: async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push("refreshed");
      },
    };
    const pending = setupStatus({ settings: { repoRoots: [], workTrackerPath: "~/wt" } } as any, bins as any);
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    vi.useRealTimers();
    expect(order).toEqual(["refreshed", "binFor claude", "binFor codex"]);
  });
});
