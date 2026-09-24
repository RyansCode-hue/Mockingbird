import { describe, expect, it, vi } from "vitest";

// Azure DevOps that never answers — the wizard's local checks must not wait on it
vi.mock("../src/main/ado", () => ({ adoIdentity: () => new Promise(() => {}) }));

describe("setupStatus", () => {
  it("gives up on Azure DevOps after 10s and still reports the local checks", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { setupStatus } = await import("../src/main/setup");
    const sessions = { binFor: (k: string) => k, resetBinCache: vi.fn() }; // neither CLI installed
    const pending = setupStatus({ settings: { repoRoots: ["~/nowhere"], workTrackerPath: "~/wt" } } as any, sessions as any);
    await vi.advanceTimersByTimeAsync(10_000);
    const st = await pending;
    vi.useRealTimers();
    expect(sessions.resetBinCache).toHaveBeenCalled();
    expect(st.ado).toEqual({ connected: false, detail: expect.stringMatching(/didn't answer within 10s/) });
    expect(st.claude).toEqual({ found: false, path: null, version: null, signedIn: null });
    expect(st.hooks).toEqual({ claude: false, codex: null });
    expect(st.repoRoots).toEqual([{ path: "~/nowhere", exists: false, repos: 0 }]);
  });
});
