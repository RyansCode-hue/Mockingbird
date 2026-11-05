import { beforeEach, describe, expect, it, vi } from "vitest";

const told = vi.fn(async (_rooms: string[]) => undefined);
beforeEach(() => {
  told.mockClear();
  (globalThis as unknown as { window: unknown }).window = { mb: { teamChatViewing: told } };
});

describe("the room chats on screen", () => {
  it("count each view on its own: one going leaves the room viewed while another shows it", async () => {
    const { chatViewing, viewedRooms } = await import("../src/renderer/team/chatViewing");
    const [a, b, c] = [Symbol("a"), Symbol("b"), Symbol("c")];
    chatViewing(a, "R1");
    chatViewing(b, "R1");
    chatViewing(c, "R2");
    expect(viewedRooms()).toEqual(["R1", "R2"]);
    chatViewing(a, null);
    expect(viewedRooms()).toEqual(["R1", "R2"]);
    // a view no longer seen (off screen, zoomed out) stops counting, as one closed does
    chatViewing(b, null);
    expect(viewedRooms()).toEqual(["R2"]);
    chatViewing(c, null);
    expect(viewedRooms()).toEqual([]);
    expect(told.mock.calls.map((c) => c[0])).toEqual([["R1"], ["R1", "R2"], ["R2"], []]);
  });
});
