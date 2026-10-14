import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactFetcher } from "../src/main/team/artifactFetch";
import type { ArtifactStore } from "../src/main/team/artifactStore";
import type { Team } from "../src/main/team/transport";
import type { ArtifactRecord } from "../src/shared/team/artifacts";

const ROOM = "room-1";
const RYAN = "ryan";
const SHA = "a".repeat(64);
const file = { kind: "file", id: "f1", sha256: SHA, size: 10, name: "a.txt", lamport: 1, addedBy: RYAN } as unknown as Extract<ArtifactRecord, { kind: "file" }>;

/** A fetcher in a room where the file's adder is offline and nobody else is connected: every round ends "waiting". */
function lonelyFetcher(now: () => number) {
  let rounds = 0;
  const team = {
    onRequest: () => () => {},
    onPresence: () => () => {},
    rooms: () => [{ id: ROOM }],
    room: () => ({ id: ROOM }),
    presence: () => [],
    request: async () => {
      throw new Error("nobody is connected");
    },
  } as unknown as Team;
  const store = { blobSize: () => null, partialSize: () => 0 } as unknown as ArtifactStore;
  const fetcher = new ArtifactFetcher({
    team,
    store: () => store,
    files: () => [file],
    nameOf: (_r, m) => (m === RYAN ? "Ryan" : m),
    changed: () => rounds++,
    log: () => {},
    now,
    timing: { retryMs: [30, 60], haveGapMs: 20 },
  });
  return { fetcher, rounds: () => rounds };
}

describe("artifact fetch retries", () => {
  afterEach(() => vi.useRealTimers());

  it("are still scheduled when the clock passes a retry's time while the fetcher decides what to start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 });
    // the retry timer fires a millisecond early by the fetcher's clock, which then ticks over mid-pass
    let early = false;
    const now = () => {
      if (!early) return Date.now();
      early = false;
      return Date.now() - 1;
    };
    const { fetcher, rounds } = lonelyFetcher(now);
    fetcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher.local(ROOM, SHA)).toEqual({ state: "waiting", problem: "Ryan added it and is offline; no connected teammate has it yet" });
    expect(rounds()).toBe(1);

    early = true;
    await vi.advanceTimersByTimeAsync(30);
    await vi.advanceTimersByTimeAsync(5);
    expect(rounds()).toBe(2);
    // and the retries go on, each at its time
    await vi.advanceTimersByTimeAsync(60);
    expect(rounds()).toBe(3);
    fetcher.stop();
  });
});
