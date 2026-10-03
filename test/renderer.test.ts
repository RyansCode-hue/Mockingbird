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

describe("syntax highlighting", () => {
  it("knows a file's language by its name", async () => {
    const { languageFor } = await import("../src/renderer/highlight");
    expect(languageFor("src/a.tsx")).toBe("typescript");
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("api/views.py")).toBe("python");
    expect(languageFor("notes.txt")).toBeNull();
  });
  it("keeps a comment spanning lines colored on every line, and escapes the source", async () => {
    const { highlightLines } = await import("../src/renderer/highlight");
    const lines = highlightLines("/* one\n   two */\nconst a = '<b>';", "javascript");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('<span class="hljs-comment">/* one</span>');
    expect(lines[1]).toBe('<span class="hljs-comment">   two */</span>');
    expect(lines[2]).toContain("&lt;b&gt;");
    expect(lines[2]).not.toContain("<b>");
    expect(highlightLines("<script>x</script>", null)).toEqual(["&lt;script&gt;x&lt;/script&gt;"]);
  });
});

describe("side-by-side diff", () => {
  it("pairs a run of removals with the additions after it, context on both sides", async () => {
    const { parseDiff, splitRows } = await import("../src/renderer/FilePanel");
    const { lines } = parseDiff(["@@ -1,4 +1,3 @@", " keep", "-old 1", "-old 2", "+new 1", " tail"].join("\n"));
    expect(splitRows(lines)).toEqual([{ hunk: 0 }, { left: 1, right: 1 }, { left: 2, right: 4 }, { left: 3, right: null }, { left: 5, right: 5 }]);
  });
  it("highlights each hunk on its own, so an unclosed comment can't color the next one", async () => {
    const { parseDiff, highlightDiff } = await import("../src/renderer/FilePanel");
    const { lines } = parseDiff(["@@ -1,1 +1,1 @@", "-/* old", "+/* new", "@@ -9,1 +9,1 @@", " const a = 1;"].join("\n"));
    const html = highlightDiff(lines, "a.ts");
    expect(html[1]).toContain("hljs-comment");
    expect(html[2]).toContain("hljs-comment");
    expect(html[4]).not.toContain("hljs-comment");
    expect(html[4]).toContain("hljs-keyword");
  });
});
