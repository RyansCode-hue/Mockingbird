import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/renderer/FilePanel";
import { resetText, pctNow } from "../src/renderer/usageFormat";

describe("parseDiff", () => {
  it("numbers old and new lines through a hunk", () => {
    const diff = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -10,3 +10,3 @@ fn", " keep", "-old", "+new", " tail", "\\ No newline at end of file"].join("\n");
    const { lines, binary } = parseDiff(diff);
    expect(binary).toBe(false);
    expect(lines.map((l) => [l.kind, l.oldNo ?? null, l.newNo ?? null, l.text])).toEqual([
      ["hunk", null, null, "@@ -10,3 +10,3 @@ fn"],
      ["ctx", 10, 10, "keep"],
      ["del", 11, null, "old"],
      ["add", null, 11, "new"],
      ["ctx", 12, 12, "tail"],
      ["note", null, null, "No newline at end of file"],
    ]);
  });
  it("recognises binary changes", () => {
    expect(parseDiff("diff --git a/i b/i\nBinary files a/i and b/i differ\n").binary).toBe(true);
  });
});

describe("usage reset text", () => {
  const now = Date.parse("2026-09-24T12:00:00");
  it("counts down within a day and names the day beyond it", () => {
    expect(resetText(now + 45 * 60_000, now)).toBe("Resets in 45 min");
    expect(resetText(now + (4 * 60 + 18) * 60_000, now)).toBe("Resets in 4 hr 18 min");
    expect(resetText(now + 3 * 86_400_000, now)).toMatch(/^Resets \w{3} /);
    expect(resetText(now - 1, now)).toBe("Reset");
    expect(resetText(null, now)).toBe("");
  });
  it("shows a window that has already reset as 0%", () => {
    expect(pctNow({ label: "5-hour limit", usedPct: 41, resetsAt: now - 1 }, now)).toBe(0);
    expect(pctNow({ label: "5-hour limit", usedPct: 41, resetsAt: now + 1 }, now)).toBe(41);
  });
});
