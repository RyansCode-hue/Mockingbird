import { describe, expect, it } from "vitest";
import { AGENT_KINDS, AGENT_NAME, groupKey, isErr, isWorkItemId, otherAgent, slugBranch, ticketIdOf, sanitizeSegment, splitGroupKey, normalizeGroupPath, topOfKey, groupUngrouped } from "../src/shared/types";

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

describe("a failed main-process answer", () => {
  it("is an object carrying an error message", () => {
    expect(isErr({ error: "git status: timed out after 30s" })).toBe(true);
  });
  it("isn't a value that merely could be one", () => {
    expect(isErr(null)).toBe(false);
    expect(isErr(undefined)).toBe(false);
    expect(isErr(true)).toBe(false);
    expect(isErr("error")).toBe(false);
    expect(isErr([])).toBe(false);
    expect(isErr({ sessions: [] })).toBe(false);
    expect(isErr({ error: null })).toBe(false);
    expect(isErr({ state: "preparing", error: undefined })).toBe(false);
  });
});

describe("group keys and ticket ids", () => {
  it("joins a group and an optional workspace, each name one segment", () => {
    expect(groupKey("5038", "backend")).toBe("5038/backend");
    expect(groupKey(" 5038 ", "")).toBe("5038");
    expect(groupKey("perf/q3", "api/v2")).toBe("perf-q3/api-v2");
    expect(normalizeGroupPath("5038/backend")).toBe(groupKey("5038", "backend"));
  });
  it("drops a ticket id's leading #, and knows a work item id by its digits", () => {
    expect(ticketIdOf("#5038")).toBe("5038");
    expect(ticketIdOf("5038")).toBe("5038");
    expect(isWorkItemId("5038")).toBe(true);
    expect(isWorkItemId("#5038")).toBe(false);
    expect(isWorkItemId(ticketIdOf("#5038"))).toBe(true);
    expect(isWorkItemId("perf")).toBe(false);
  });
});

describe("agents", () => {
  it("each have one name the app shows", () => {
    expect(AGENT_KINDS.map((a) => AGENT_NAME[a])).toEqual(["Claude", "Codex"]);
  });
  it("hand over to the other one; a session from before Codex counts as Claude", () => {
    expect(otherAgent("claude")).toBe("codex");
    expect(otherAgent("codex")).toBe("claude");
    expect(otherAgent(undefined)).toBe("codex");
  });
});
