import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import pkg from "../package.json";

// What's new, driven in the UI preview in real headless Chrome: local only (CI runners have no desktop); the
// script passes a mock keychain. ?wnAudit (src/preview/stub.ts) opens and closes the popover the ways a person
// does and reports what it found; nothing reaches GitHub (the preview's gh calls are stubbed).
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

async function audit(query: string, size = "1400x900"): Promise<Record<string, unknown>> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({ size, query: `motion=off&wnAudit${query ? `&${query}` : ""}`, outDir: path.join(tempDir("whatsnew"), "out"), read: `document.getElementById("mb-wn-audit")?.textContent ?? null` });
  if (!json) throw new Error("the preview didn't finish its What's new audit");
  return JSON.parse(json);
}

describe.skipIf(!local)("What's new, from the keyboard", () => {
  it("opens from a focusable label into a focused dialog whose body scrolls, and closes on Esc or a click outside, focus back on the label", async () => {
    const a = await audit("", "1000x600");
    expect(a.startLabel).toBe(`v${pkg.version}`);
    expect(a.startOpen).toBe(false);
    expect(a.labelFocusable).toBe(true);
    expect(a.labelPopup).toBe("dialog");
    expect(a.opened).toBe(true);
    expect(a.expanded).toBe("true");
    expect(a.role).toBe("dialog");
    expect(a.name).toBe("What's new");
    expect(a.focusInside).toBe(true);
    // every fold open: the popover stays inside the window and its body scrolls
    expect(a.expandedFolds).toBeGreaterThan(10);
    expect(a.bodyScrolls).toBe(true);
    expect(a.popBottom as number).toBeLessThanOrEqual(a.windowHeight as number);
    expect(a.closedByEsc).toBe(true);
    expect(a.focusBack).toBe(true);
    expect(a.closedByOutside).toBe(true);
    // Esc while typing a suggestion closes it too, and the draft waits for the next open
    expect(a.typingFocus).toBe(true);
    expect(a.closedFromForm).toBe(true);
    expect(a.draftKept).toBe("Draft title");
  }, 120_000);

  it("after an update reads \"Updated to\" and opens by itself; dismissing it goes back to the version and records it as seen", async () => {
    const a = await audit("whatsNew=updated");
    expect(a.startLabel).toBe(`Updated to ${pkg.version}`);
    expect(a.startOpen).toBe(true);
    expect(a.afterDismissLabel).toBe(`v${pkg.version}`);
    expect(a.lastSeen).toBe(JSON.stringify(pkg.version));
  }, 120_000);
});
