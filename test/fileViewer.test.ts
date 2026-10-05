import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/renderer/FilePanel";

describe("diffs of files with merge conflicts", () => {
  // `git diff -- f.txt` during a conflicted merge
  const combined = [
    "diff --cc f.txt",
    "index ee58e8a,3b6f40a..0000000",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@@ -1,4 -1,3 +1,8 @@@",
    "  a",
    "++<<<<<<< HEAD",
    " +B1",
    "++=======",
    "+ B2",
    "++>>>>>>> other",
    " -b-theirs-only",
    "  c",
    " +d",
  ].join("\n");

  it("shows a combined diff against the branch being merged into", () => {
    const { lines } = parseDiff(combined);
    expect(lines.map((l) => [l.kind, l.oldNo ?? null, l.newNo ?? null, l.text])).toEqual([
      ["hunk", null, null, "@@@ -1,4 -1,3 +1,8 @@@"],
      ["ctx", 1, 1, "a"],
      ["add", null, 2, "<<<<<<< HEAD"],
      ["ctx", 2, 3, "B1"],
      ["add", null, 4, "======="],
      ["add", null, 5, "B2"],
      ["add", null, 6, ">>>>>>> other"],
      ["ctx", 3, 7, "c"],
      ["ctx", 4, 8, "d"],
    ]);
  });

  it("says when a staged diff is empty because the file is unmerged", () => {
    const r = parseDiff("* Unmerged path f.txt\n");
    expect(r.unmerged).toBe(true);
    expect(r.lines).toEqual([]);
  });
});
