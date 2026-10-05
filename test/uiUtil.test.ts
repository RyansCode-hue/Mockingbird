import { describe, expect, it } from "vitest";
import { isError } from "../src/renderer/uiUtil";

describe("a failed main-process answer", () => {
  it("is an object carrying an error message", () => {
    expect(isError({ error: "git status: timed out after 30s" })).toBe(true);
  });
  it("isn't a value that merely could be one", () => {
    expect(isError(null)).toBe(false);
    expect(isError(undefined)).toBe(false);
    expect(isError(true)).toBe(false);
    expect(isError("error")).toBe(false);
    expect(isError([])).toBe(false);
    expect(isError({ sessions: [] })).toBe(false);
    expect(isError({ error: null })).toBe(false);
  });
});
