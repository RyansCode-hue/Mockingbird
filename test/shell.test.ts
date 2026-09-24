import { describe, expect, it } from "vitest";
import { userShell, whichSync, quote } from "../src/main/shell";

describe("userShell", () => {
  it("returns the command's output and exit code, fenced from rc-file noise", async () => {
    expect(await userShell("printf 'line one\\nline two'; exit 3")).toEqual({ code: 3, out: "line one\nline two" });
  });
  it("succeeds with empty output", async () => {
    expect(await userShell("true")).toEqual({ code: 0, out: "" });
  });
});

describe("whichSync", () => {
  it("finds commands on the shell's PATH and returns null for missing ones", () => {
    expect(whichSync("ls")).toMatch(/^\/.*\/ls$/);
    expect(whichSync("definitely-not-a-command-mb")).toBeNull();
  });
});

describe("quote", () => {
  it("survives spaces and single quotes", async () => {
    const tricky = "it's a path with spaces";
    expect((await userShell(`printf %s ${quote(tricky)}`)).out).toBe(tricky);
  });
});
