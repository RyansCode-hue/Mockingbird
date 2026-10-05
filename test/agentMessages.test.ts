import { describe, expect, it } from "vitest";
import { messageKeys } from "../src/renderer/AgentMessages";
import type { AgentMessage } from "../src/shared/types";

const msg = (at: number, from = "s1", to = "s2"): AgentMessage => ({ at, from, fromTitle: from, to, toTitle: to, text: "hi", outcome: "submitted" });

describe("the message log's row keys", () => {
  it("keep each message's key when a newer message arrives, so an opened row stays open", () => {
    const before = [msg(1), msg(2)];
    const after = [...before, msg(3)];
    expect(messageKeys(after).slice(0, 2)).toEqual(messageKeys(before));
  });
  it("tell apart messages sent at the same moment between the same sessions", () => {
    const keys = messageKeys([msg(5), msg(5), msg(5, "s2", "s1")]);
    expect(new Set(keys).size).toBe(3);
  });
});
