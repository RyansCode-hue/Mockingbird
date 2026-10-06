import { describe, expect, it } from "vitest";
import { ago, agoShort, fmtElapsed, plural } from "../src/shared/format";

const now = new Date(2026, 9, 5, 12, 0).getTime();
const MIN = 60_000;

describe("how long ago", () => {
  it("says minutes, hours or days, with the 'ago' included", () => {
    expect(ago(now - 4 * MIN, now)).toBe("4m ago");
    expect(ago(now - 3 * 60 * MIN, now)).toBe("3h ago");
    expect(ago(now - 5 * 24 * 60 * MIN, now)).toBe("5d ago");
  });
  it("says 'just now' under a minute", () => {
    expect(ago(now - 20_000, now)).toBe("just now");
  });
  it("gives a date for anything older than a month, with the year only when it isn't this one", () => {
    expect(ago(new Date(2026, 6, 1).getTime(), now)).not.toMatch(/ago$/);
    expect(ago(new Date(2026, 6, 1).getTime(), now)).not.toMatch(/2026/);
    expect(ago(new Date(2025, 6, 1).getTime(), now)).toMatch(/2025/);
  });
  it("never goes negative for a clock that's slightly ahead", () => {
    expect(ago(now + 5 * MIN, now)).toBe("just now");
    expect(agoShort(now + 5 * MIN, now)).toBe("now");
  });
  it("has a short form for narrow columns, without the 'ago'", () => {
    expect(agoShort(now - 4 * MIN, now)).toBe("4m");
    expect(agoShort(now - 3 * 60 * MIN, now)).toBe("3h");
    expect(agoShort(now - 20_000, now)).toBe("now");
    expect(agoShort(new Date(2026, 6, 1).getTime(), now)).toBe(ago(new Date(2026, 6, 1).getTime(), now));
  });
});

describe("how long something has been going", () => {
  it("counts seconds, then minutes, then hours with zero-padded minutes", () => {
    expect(fmtElapsed(now - 45_000, false, now)).toBe("45s");
    expect(fmtElapsed(now - 12 * MIN - 5_000, false, now)).toBe("12m");
    expect(fmtElapsed(now - 12 * MIN - 5_000, true, now)).toBe("12m 05s");
    expect(fmtElapsed(now - 65 * MIN, false, now)).toBe("1h 05m");
  });
  it("never goes negative", () => {
    expect(fmtElapsed(now + 10_000, false, now)).toBe("0s");
  });
});

describe("counts", () => {
  it("pluralize every count but one", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(0, "file")).toBe("0 files");
    expect(plural(3, "uncommitted file")).toBe("3 uncommitted files");
  });
});
