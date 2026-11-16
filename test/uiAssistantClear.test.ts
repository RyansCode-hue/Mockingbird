import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The landscape's camera keeps workspaces clear of the docked Assistant sheet (Landscape's clearOf), in the UI preview,
// in real headless Chrome: local only (CI runners have no desktop); the script passes a mock keychain.
// ?assistant=open opens the sheet over the landscape once it's laid out (src/preview/assistantStub.ts), so some
// workspaces lie under it; window.__mbEmit plays main's assistant:window events (focus_session's).
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

type Box = { left: number; right: number; top: number; bottom: number };
interface ClearAudit {
  sheet: Box;
  view: Box;
  workspaces: number;
  /** The workspaces under the sheet as it opened. */
  covered: string[];
  /** Each of those after focus_session went to it: whether it's under the sheet, and wholly in the view's uncovered part. */
  focused: { id: string; under: boolean; clear: boolean }[];
  /** After the camera's Fit: the workspaces under the sheet, and whether every one is left of it. */
  fitUnder: string[];
  fitClear: boolean;
  /** A workspace in focus: its frame's right edge against the sheet's left. */
  focusFrame: { right: number; sheetLeft: number } | null;
}

async function audit(size: string): Promise<ClearAudit> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const steps = `
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => [...document.querySelectorAll(s)];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 6000) => {
      for (let i = 0; i < ms / 50; i++) {
        if (fn()) return true;
        await sleep(50);
      }
      return !!fn();
    };
    const box = (r) => ({ left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) });
    const sheetBox = () => {
      const el = $(".as-anchor > .as-sheet:not(.mb-ghost)");
      const a = el.parentElement.getBoundingClientRect();
      return { left: a.right - el.offsetWidth, right: a.right, top: a.top + el.offsetTop, bottom: a.top + el.offsetTop + el.offsetHeight };
    };
    const node = (id) => $('.ls-world .ls-node[data-front="' + CSS.escape(id) + '"]');
    const under = (r, s) => r.right > s.left + 1 && r.left < s.right && r.bottom > s.top && r.top < s.bottom;
    // the camera settled: a workspace's place the same twice running
    const settled = async (id) => {
      let last = "";
      for (let i = 0; i < 40; i++) {
        await sleep(100);
        const n = node(id);
        const now = n ? JSON.stringify(box(n.getBoundingClientRect())) : "";
        if (now && now === last) return;
        last = now;
      }
    };
    await until(() => $(".as-anchor > .as-sheet:not(.mb-ghost)") && $$(".ls-world .ls-node[data-front]").length > 0);
    await sleep(500);
    const sheet = sheetBox();
    const view = box($(".ls-viewport").getBoundingClientRect());
    const ids = $$(".ls-world .ls-node[data-front]").map((n) => n.dataset.front);
    const covered = ids.filter((id) => under(node(id).getBoundingClientRect(), sheet));
    const focused = [];
    for (const id of covered) {
      window.__mbEmit("onAssistantWindow", { kind: "focus", sessionId: id });
      await settled(id);
      const r = node(id).getBoundingClientRect();
      focused.push({ id, under: under(r, sheet), clear: r.right <= sheet.left + 1 && r.left >= view.left - 1 && r.top >= view.top - 1 && r.bottom <= view.bottom + 1 });
    }
    const fitButton = $$(".ls-hud-btn").find((b) => b.textContent.trim() === "Fit");
    fitButton.click();
    await settled(ids[0]);
    const fitUnder = ids.filter((id) => under(node(id).getBoundingClientRect(), sheet));
    const fitClear = ids.every((id) => node(id).getBoundingClientRect().right <= sheet.left + 1);
    // a workspace selected and Enter fills the view with it (focus), as ?lsFocus does it
    let focusFrame = null;
    const picked = node(covered[0] ?? ids[0]);
    (picked.querySelector(".ls-head") ?? picked).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    await sleep(100);
    $(".ls-viewport").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    if (await until(() => $(".ls-focus"), 3000)) {
      await sleep(200);
      focusFrame = { right: Math.round($(".ls-focus").getBoundingClientRect().right), sheetLeft: Math.round(sheetBox().left) };
    }
    return { sheet: box(sheet), view, workspaces: ids.length, covered, focused, fitUnder, fitClear, focusFrame };
  `;
  const read = `(() => {
    const w = window;
    if (!w.__clearRun) {
      if (!document.querySelector(".ls-viewport")) return null;
      w.__clearRun = (async () => { ${steps} })().then((v) => (w.__clearOut = JSON.stringify(v)), (e) => (w.__clearOut = JSON.stringify({ failed: String((e && e.stack) || e) })));
    }
    return w.__clearOut ?? null;
  })()`;
  const out: string = await pageResult({ size, query: "motion=off&assistant=open", outDir: path.join(tempDir("assistant-clear"), "out"), read });
  const parsed = JSON.parse(out);
  if (parsed && typeof parsed === "object" && "failed" in parsed) throw new Error(`the page's steps failed: ${parsed.failed}`);
  return parsed;
}

describe.skipIf(!local)("the landscape with the Assistant's sheet open", () => {
  it("brings a workspace focus_session goes to clear of the sheet, and Fit fits everything left of it", async () => {
    const a = await audit("1280x820");
    // the fixture lays workspaces out under where the sheet docks: what's checked is there to check
    expect(a.workspaces).toBeGreaterThan(1);
    expect(a.covered.length).toBeGreaterThan(0);
    expect(a.focused).toEqual(a.covered.map((id) => ({ id, under: false, clear: true })));
    expect(a.fitUnder).toEqual([]);
    expect(a.fitClear).toBe(true);
    // in focus, the workspace fills only the part of the view the sheet leaves uncovered
    expect(a.focusFrame).not.toBeNull();
    expect(a.focusFrame!.right).toBeLessThanOrEqual(a.focusFrame!.sheetLeft);
  }, 120_000);
});
