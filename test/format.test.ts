import { describe, expect, it } from "vitest";
import { ago } from "../src/renderer/format";

describe("how long ago", () => {
  const now = new Date(2026, 9, 5, 12, 0).getTime();
  it("says minutes, hours or days, with the 'ago' included", () => {
    expect(ago(now - 4 * 60_000, now)).toBe("4m ago");
    expect(ago(now - 3 * 3600_000, now)).toBe("3h ago");
    expect(ago(now - 5 * 86400_000, now)).toBe("5d ago");
  });
  it("gives a date for anything older than a month", () => {
    expect(ago(new Date(2026, 6, 1).getTime(), now)).not.toMatch(/ago$/);
  });
  it("never goes negative for a clock that's slightly ahead", () => {
    expect(ago(now + 30_000, now)).toBe("0m ago");
  });
});
