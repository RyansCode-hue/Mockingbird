import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// Motion, played in the UI preview in real headless Chrome: local only (CI runners have no desktop); the script
// passes a mock keychain. ?motionAudit (src/preview/stub.ts) minimizes a workspace into its folder and restores
// it, opens and closes a dialog, and shows and dismisses a toast, finishing each animation instead of waiting on
// real time, and reports the end states: tests read those, never frames caught in flight.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type State = { folderOpen: boolean; cells: string[]; ghosts: number; holding: number; named: number };
type Audit = {
  before: State;
  inFlight: State & { move: string | null };
  minimized: State;
  lidOpening: State;
  restored: State;
  dialogOpen: number;
  dialogClosing: { real: number; ghosts: number };
  dialogClosed: State;
  toastGone: State & { toasts: number };
  waitingPulse: string | null;
  transitions: number;
  longest: number;
  mode: string;
};

async function audit(motion: "full" | "reduce"): Promise<Audit> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const json: string | null = await pageResult({ size: "1400x900", query: `motion=${motion}&motionAudit`, outDir: path.join(tempDir("motion"), "out"), read: `document.getElementById("mb-motion-audit")?.textContent ?? null` });
  if (!json) throw new Error("the preview didn't finish its motion audit");
  return JSON.parse(json);
}

const settled = (s: State) => {
  expect(s.ghosts).toBe(0); // no exit copies left behind
  expect(s.holding).toBe(0); // no animation left holding a frame (a stuck fill)
  expect(s.named).toBe(0); // no View Transition names left on panes
};

describe.skipIf(!local)("the interface's motion", () => {
  it("minimizes a workspace into its open folder, closing the lid after, and restores it out of the opened folder", async () => {
    const a = await audit("full");
    expect(a.mode).toBe("full");
    const ws = "ws:5101/api";
    expect(a.before.folderOpen).toBe(true);
    expect(a.before.cells).toContain(ws);
    // in flight: the pane has left the grid and the folder is still open for it
    expect(a.inFlight.move).toBe("minimize");
    expect(a.inFlight.cells).not.toContain(ws);
    expect(a.inFlight.folderOpen).toBe(true);
    // landed: the lid has closed
    expect(a.minimized.folderOpen).toBe(false);
    settled(a.minimized);
    // restoring: the lid opens first, with the pane not yet back
    expect(a.lidOpening.folderOpen).toBe(true);
    expect(a.lidOpening.cells).not.toContain(ws);
    expect(a.restored.cells).toContain(ws);
    expect(a.restored.folderOpen).toBe(true);
    settled(a.restored);
    expect(a.transitions).toBeGreaterThanOrEqual(2);
    // a dialog closes at once; its exit plays on a copy that then goes
    expect(a.dialogOpen).toBe(1);
    expect(a.dialogClosing).toEqual({ real: 0, ghosts: 1 });
    settled(a.dialogClosed);
    expect(a.toastGone.toasts).toBe(0);
    settled(a.toastGone);
    expect(a.longest).toBeLessThanOrEqual(400);
  }, 120_000);

  it("under reduce, runs no View Transitions, only fades of 120 ms or less, and no waiting pulse", async () => {
    const a = await audit("reduce");
    expect(a.mode).toBe("reduce");
    expect(a.transitions).toBe(0);
    expect(a.longest).toBeLessThanOrEqual(120);
    expect(a.minimized.folderOpen).toBe(false);
    expect(a.restored.cells).toContain("ws:5101/api");
    expect(a.restored.folderOpen).toBe(true);
    for (const s of [a.minimized, a.restored, a.dialogClosed, a.toastGone]) settled(s);
    expect(a.waitingPulse).toBe("none");
  }, 120_000);
});
