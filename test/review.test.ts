import { describe, expect, it } from "vitest";
import { reviewPrompt } from "../src/main/review";

describe("the cross-agent review prompt", () => {
  const p = reviewPrompt({ author: "claude", authorId: "a1b2c3d4", authorTitle: "Org dropdowns", branch: "5101-org", base: "origin/dev" });
  it("says whose work it is and how to see every change", () => {
    expect(p).toContain('a Claude session called "Org dropdowns"');
    expect(p).toContain("on branch 5101-org");
    expect(p).toContain("git diff origin/dev...HEAD");
    expect(p).toContain("git diff HEAD and git status");
  });
  it("asks for bugs, security, silent failures and tests, and to change nothing", () => {
    for (const s of ["Bugs and edge cases", "Security", "Silent failures", "Tests", "don't change, stage or commit anything"]) expect(p).toContain(s);
  });
  it("sends the findings back to the author's session by id", () => {
    expect(p).toContain('send_message tool (to: "a1b2c3d4")');
  });
  it("falls back to recent commits without a base branch", () => {
    expect(reviewPrompt({ author: "codex", authorId: "x", authorTitle: "t", branch: null, base: null })).toContain("git log -5 -p");
  });
});
