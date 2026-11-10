import { describe, expect, it } from "vitest";
import { sendAlongWire } from "../src/renderer/wireSend";
import type { IpcResult } from "../src/shared/types";
import type { SendReply } from "../src/shared/wires";

const state = { book: null, refused: null, wiresRev: 1, problems: [] } as unknown as Extract<SendReply, { state: unknown }>["state"];

/** Main's answers in turn, and what each call asked for. */
function steps(answers: IpcResult<SendReply>[], costOk = true) {
  const sent: boolean[] = [];
  let asked = 0;
  return {
    sent,
    asked: () => asked,
    d: {
      send: async (start: boolean) => (sent.push(start), answers.shift()!),
      costOk: async () => (asked++, costOk),
    },
  };
}

describe("a person's Send along a wire, from the window", () => {
  it("asks main without starting anything first, and answers what main said", async () => {
    const s = steps([{ state }]);
    expect(await sendAlongWire(s.d)).toEqual({ state });
    expect(s.sent).toEqual([false]);
    expect(s.asked()).toBe(0);
  });

  it("asks about the cost when the other end is stopped, then sends starting it once that's agreed", async () => {
    const s = steps([{ refused: "“Reviewer” isn't running: sending this resumes it, which rereads its conversation.", start: "resume" }, { state }]);
    expect(await sendAlongWire(s.d)).toEqual({ state });
    expect(s.sent).toEqual([false, true]);
    expect(s.asked()).toBe(1);
  });

  it("sends nothing more when the cost is declined", async () => {
    const s = steps([{ refused: "stopped", start: "reopen" }], false);
    expect(await sendAlongWire(s.d)).toBeUndefined();
    expect(s.sent).toEqual([false]);
  });

  it("doesn't ask on a refusal about anything else, or an error", async () => {
    const refused = steps([{ refused: "At the limit: 3 of 3 rounds." }]);
    expect(await sendAlongWire(refused.d)).toEqual({ refused: "At the limit: 3 of 3 rounds." });
    const err = steps([{ error: "no handler" }]);
    expect(await sendAlongWire(err.d)).toEqual({ error: "no handler" });
    expect([refused.asked(), err.asked()]).toEqual([0, 0]);
  });
});
