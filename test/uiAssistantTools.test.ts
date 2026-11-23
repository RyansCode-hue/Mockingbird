import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The Assistant's open_tool in the UI preview, in real headless Chrome: local only (CI runners have no desktop); the
// script passes a mock keychain. ?assistantToolAudit (src/preview/assistantToolAudit.ts) sends the window main's
// assistant:window openTool events, and reports what each left once it settled: the windows the landscape stores, the
// changes asked of main (window.__mbCalls), the selection, and what the landscape said.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type Step = { opened: { tool: string; docked: boolean; session?: string; area?: string | null }[]; placed: number; updates: string[][]; selected: string | null; said: string | null; drawn: number };
interface Audit {
  changes: Step;
  artifacts: Step;
  docked: Step;
  filesWhileDocked: Step;
  gone: Step;
  error?: string;
}

async function audit(): Promise<Audit> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const id = "mb-assistant-tool-audit";
  const json: string | null = await pageResult({
    size: "1400x900",
    query: "motion=off&lsCamera=0,0,0.5&assistantToolAudit",
    outDir: path.join(tempDir(id), "out"),
    read: `document.getElementById(${JSON.stringify(id)})?.textContent ?? null`,
  });
  if (!json) throw new Error(`the preview didn't finish ${id}`);
  return JSON.parse(json);
}

describe.skipIf(!local)("the Assistant's open_tool in the window", () => {
  it("opens each tool where it's asked, as the window's own Show does, and says so when the session is gone", async () => {
    const a = await audit();
    expect(a.error).toBeUndefined();

    // Changes beside s5: one window, placed on s5, s5 selected, saved through the landscape in one change (what's
    // beside s5 moved along to make room, its area grown, as the window's own Show does)
    expect(a.changes.opened).toEqual([{ tool: "changes", docked: false, session: "s5", area: "5102" }]);
    expect(a.changes.selected).toBe("s5");
    expect(a.changes.updates).toHaveLength(1);
    expect(a.changes.updates[0]).toContain("tools");
    expect(a.changes.drawn).toBeGreaterThanOrEqual(1);

    // Artifacts in 5102: an area's window
    expect(a.artifacts.opened).toEqual([{ tool: "artifacts", docked: false, area: "5102" }]);

    // Files docked: a docked window, no place of its own
    expect(a.docked.opened).toEqual([{ tool: "files", docked: true }]);

    // Files beside s5 while Files is docked: the docked one shows s5, nothing new opens
    expect(a.filesWhileDocked.opened).toEqual([]);
    expect(a.filesWhileDocked.selected).toBe("s5");

    // a session that isn't here: nothing opens, and the landscape says why
    expect(a.gone.opened).toEqual([]);
    expect(a.gone.updates).toEqual([]);
    expect(a.gone.said).toBe("The Assistant asked to open Files beside a session that isn't here any more");
  });
});
