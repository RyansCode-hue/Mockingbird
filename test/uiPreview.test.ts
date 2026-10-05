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

  // real Chrome: local only (CI runners have no desktop); the script passes a mock keychain
  const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  it.skipIf(!!process.env.CI || !fs.existsSync(chrome))("takes a screenshot of a chosen screen in headless Chrome", async () => {
    // @ts-expect-error — a plain .mjs build script, no type declarations
    const { screenshot } = await import("../scripts/ui-preview.mjs");
    const dir = tempDir("shot");
    const file = await screenshot(path.join(dir, "about.png"), { size: "900x600", query: "section=about", outDir: path.join(dir, "out") });
    const png = fs.readFileSync(file);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.length).toBeGreaterThan(10_000);
  }, 90_000);
});
