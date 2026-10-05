import { describe, expect, it } from "vitest";
import { baseName, dirName, tildePath } from "../src/shared/paths";

describe("paths as the app shows them", () => {
  it("names a path by its last segment", () => {
    expect(baseName("src/renderer/main.tsx")).toBe("main.tsx");
    expect(baseName("/Users/ann/Code/backoffice")).toBe("backoffice");
    expect(baseName("README.md")).toBe("README.md");
  });
  it("gives the folder a path is in, or nothing at the top", () => {
    expect(dirName("src/renderer/main.tsx")).toBe("src/renderer");
    expect(dirName("README.md")).toBe("");
    expect(dirName("/top")).toBe("");
  });
  it("shows the home folder as ~, and nothing else", () => {
    expect(tildePath("/Users/ann/Code/backoffice")).toBe("~/Code/backoffice");
    expect(tildePath("/Users/ann")).toBe("~");
    expect(tildePath("/opt/Users/ann")).toBe("/opt/Users/ann");
  });
});
