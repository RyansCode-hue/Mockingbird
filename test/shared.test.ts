import { describe, expect, it } from "vitest";
import { slugBranch, sanitizeSegment, splitGroupKey, normalizeGroupPath, topOfKey, groupUngrouped } from "../src/shared/types";

describe("slugBranch", () => {
  it("joins the ticket number and a dashed title", () => {
    expect(slugBranch("5038", "Filter orgs by foundation")).toBe("5038-Filter-orgs-by-foundation");
  });
  it("drops a leading # and punctuation at the edges", () => {
    expect(slugBranch("#4911", "  Copy all insights! ")).toBe("4911-Copy-all-insights");
  });
});

describe("group paths", () => {
  it("splits a group from its workspace at the first slash", () => {
    expect(splitGroupKey("5038/backend")).toEqual({ top: "5038", sub: "backend" });
    expect(splitGroupKey("5038")).toEqual({ top: "5038", sub: null });
  });
  it("treats an empty group as ungrouped and an empty workspace as none", () => {
    expect(splitGroupKey("")).toEqual({ top: "ungrouped", sub: null });
    expect(splitGroupKey("5038/  ")).toEqual({ top: "5038", sub: null });
  });
  it("keeps everything after the first slash in the workspace name, sanitized", () => {
    expect(normalizeGroupPath(" 5038/api/v2 ")).toBe("5038/api-v2");
    expect(topOfKey("5038/api/v2")).toBe("5038");
  });
  it("never lets a typed name add a path level", () => {
    expect(sanitizeSegment(" front/end ")).toBe("front-end");
  });
});

describe("naming the ungrouped bucket", () => {
  it("moves every session without a group into the new one, keeping workspaces, and leaves grouped ones alone", () => {
    const sessions = [
      { id: "a", taskGroup: null },
      { id: "b" },
      { id: "c", taskGroup: "5101" },
      { id: "d", taskGroup: "5101/etl" },
      { id: "e", taskGroup: "ungrouped/scratch" },
    ];
    expect(groupUngrouped(sessions, "perf")).toEqual([
      { id: "a", group: "perf" },
      { id: "b", group: "perf" },
      { id: "e", group: "perf/scratch" },
    ]);
  });
});
