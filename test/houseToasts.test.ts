import { describe, expect, it } from "vitest";
import { consentToasts } from "../src/renderer/team/HouseBoard";

describe("the House token question", () => {
  const asks = [{ roomId: "R1", room: "#5101" }, { roomId: "R2", room: "#5110" }];

  it("is a toast for every room that asks while no board is open", () => {
    expect(consentToasts(asks, null)).toEqual(asks);
  });

  it("is asked only on the board while that room's board is open, and still as a toast for the other rooms", () => {
    expect(consentToasts(asks, "R1")).toEqual([{ roomId: "R2", room: "#5110" }]);
    expect(consentToasts(asks, "R3")).toEqual(asks);
  });
});
