import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

describe("the UI preview", () => {
  it("builds the real interface over the fixture stand-in", async () => {
    // @ts-expect-error — a plain .mjs build script, no type declarations
    const { buildPreview } = await import("../scripts/ui-preview.mjs");
    const out = await buildPreview(path.join(tempDir("preview"), "out"));
    const js = fs.readFileSync(path.join(out, "renderer.js"), "utf8");
    expect(js).toContain("Not simulated in the UI preview"); // the stand-in is in the bundle
    expect(fs.existsSync(path.join(out, "renderer.css"))).toBe(true);
    expect(fs.readFileSync(path.join(out, "index.html"), "utf8")).toContain("<title>Mockingbird · UI preview</title>");
  }, 60_000);
});
