import { describe, expect, it } from "vitest";
import { notARepository } from "../src/renderer/SourceControl";

describe("which git status failures stop the folder refresh", () => {
  it("is only a folder that isn't a repository", () => {
    expect(notARepository("git status: fatal: not a git repository (or any of the parent directories): .git")).toBe(true);
  });
  it("keeps refreshing after a passing failure, so it clears by itself", () => {
    expect(notARepository("git status: fatal: Unable to create '/r/.git/index.lock': File exists.")).toBe(false);
    expect(notARepository("git status timed out after 20s")).toBe(false);
  });
});
