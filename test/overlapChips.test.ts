import { describe, expect, it } from "vitest";
import { overlapChips } from "../src/renderer/overlapChips";
import type { FileOverlap } from "../src/shared/types";

const NICK = "n".repeat(32);
const local: FileOverlap = { other: "s2", otherTitle: "Export API", otherBranch: "api", files: ["src/a.ts"] };
const nick = (branch: string, files: string[]): FileOverlap => ({ other: `team:${NICK}:${branch}`, otherTitle: "Nick's pushed branch", otherBranch: branch, files, teammate: { id: NICK, name: "Nick", roomId: "R1" } });

describe("a pane's overlap chips", () => {
  it("words a teammate's pushed branch by name and file, and opens that room's House board", () => {
    const { local: mine, teammates } = overlapChips([local, nick("nick-donor", ["src/api/x.ts"])]);
    expect(mine).toEqual([local]);
    expect(teammates).toEqual([{ key: `R1\n${NICK}`, roomId: "R1", label: "Nick's branch also changes x.ts", title: expect.stringContaining("nick-donor:\n  src/api/x.ts") }]);
    expect(teammates[0].title).toMatch(/House board/);
  });

  it("puts one teammate's branches and files in one chip, counting the rest", () => {
    const { local: mine, teammates } = overlapChips([nick("a", ["src/x.ts", "src/y.ts"]), nick("b", ["src/y.ts", "src/z.ts"])]);
    expect(mine).toEqual([]);
    expect(teammates).toHaveLength(1);
    expect(teammates[0].label).toBe("Nick's branch also changes x.ts +2");
    expect(teammates[0].title).toMatch(/^Nick's pushed branches change/);
  });

  it("has nothing for a pane without overlaps", () => {
    expect(overlapChips(undefined)).toEqual({ local: [], teammates: [] });
  });
});
