import { describe, expect, it } from "vitest";
import { freshHits } from "../src/renderer/TranscriptSearch";
import type { TranscriptHit } from "../src/shared/types";

const hit = (id: string, extra: Partial<TranscriptHit> = {}): TranscriptHit => ({
  id,
  agent: "claude",
  cwd: "/r",
  title: id,
  started: 1,
  updated: 2,
  model: null,
  snippet: "a \u0001match\u0002",
  at: 2,
  kind: "message",
  open: { how: "resume" },
  ...extra,
});

describe("conversation hits re-read while the index syncs", () => {
  it("keeps the list that's showing when the answer is the same, so the selection isn't reset", () => {
    const shown = [hit("a"), hit("b")];
    expect(freshHits(shown, [hit("a"), hit("b")])).toBe(shown);
  });
  it("takes the new list when a hit changed or moved", () => {
    const shown = [hit("a"), hit("b")];
    const moved = [hit("b"), hit("a")];
    expect(freshHits(shown, moved)).toBe(moved);
    const opened = [hit("a", { open: { how: "pane", sessionId: "s1" } }), hit("b")];
    expect(freshHits(shown, opened)).toBe(opened);
  });
});
