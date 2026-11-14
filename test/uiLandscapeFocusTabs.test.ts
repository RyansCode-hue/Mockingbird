import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

// The focused header's tabs and ⋯ in the UI preview, in real headless Chrome: local only (CI runners have no desktop);
// the script passes a mock keychain. ?lsFocus=s2 focuses the "api" stack (s2, s3 and Sam's tab, a teammate's), and
// ?lsFocus=s5 a workspace of its own. s2's worktree has uncommitted work (Close… asks first); s5's is clean (it closes
// without asking). window.__mbCalls is what the window asked main for.
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const local = !process.env.CI && fs.existsSync(chrome);

/**
 * Open the preview at `query`, wait for `ready` (a selector), run `steps` (an async function body with `$` for
 * querySelector, `sleep`, `calls()` for window.__mbCalls, `tabs()` for the focused header's tabs as
 * [sid, title, ×'s label or null, ×'s opacity or null] and `menu()` for the open menu's rows: "# heading", "-", or a
 * row's label) once, and return what it returns.
 */
async function drive<T>(query: string, ready: string, steps: string): Promise<T> {
  // @ts-expect-error — a plain .mjs build script, no type declarations
  const { pageResult } = await import("../scripts/ui-preview.mjs");
  const read = `(() => {
    const w = window;
    if (!w.__ftRun) {
      if (!document.querySelector(${JSON.stringify(ready)})) return null;
      const $ = (s) => document.querySelector(s);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const calls = () => w.__mbCalls.map((c) => ({ fn: c.fn, args: c.args }));
      const tabs = () => [...document.querySelectorAll(".ls-focus .ls-tabs .ls-tab[data-sid]")].map((t) => {
        const x = t.closest(".ls-tabw")?.querySelector(".ls-tab-x");
        return [t.dataset.sid, t.querySelector(".t").textContent, x ? x.getAttribute("aria-label") : null, x ? getComputedStyle(x).opacity : null];
      });
      const menu = () => [...(document.querySelector(".mb-ctx:not(.mb-ghost)")?.children ?? [])].map((c) =>
        c.classList.contains("mb-ctx-sep") ? "-" : c.classList.contains("mb-ctx-h") ? "# " + c.textContent : (c.querySelector(".mb-ctx-t")?.textContent ?? c.textContent) + (c.disabled ? " (off)" : ""));
      w.__ftRun = (async () => { ${steps} })().then((v) => (w.__ftOut = JSON.stringify(v ?? null)), (e) => (w.__ftOut = JSON.stringify({ failed: String(e && e.stack || e) })));
    }
    return w.__ftOut ?? null;
  })()`;
  const out: string = await pageResult({ size: "1400x900", query: `motion=off&${query}`, outDir: path.join(tempDir("focusTabs"), "out"), read });
  return JSON.parse(out);
}

const FOCUSED_STACK = '.ls-focus .ls-tab[data-sid="s2"]';
const FOCUSED_S5 = '.ls-focus .ls-tab[data-sid="s5"]';

describe.skipIf(!local)("the focused header's tabs", () => {
  it("give each tab that can be closed here a ×, shown on the front one and on keyboard focus or hover on the others; a teammate's has none; the front one's × asks as Close… does", async () => {
    const r = await drive<{ tabs: string[][]; x3: { tag: string; tabIndex: number; shown: string }; dialog: string | null; asked: unknown[]; killed: unknown[] }>(
      "lsFocus=s2",
      FOCUSED_STACK,
      `
      await sleep(300);
      const tabs0 = tabs();
      // the keyboard reaches a tab behind's ×, which shows while it has focus
      const x3 = $('.ls-focus .ls-tab[data-sid="s3"]').closest(".ls-tabw").querySelector(".ls-tab-x");
      x3.focus();
      await sleep(100);
      const x3Info = { tag: x3.tagName.toLowerCase(), tabIndex: x3.tabIndex, shown: getComputedStyle(x3).opacity };
      x3.blur();
      const mark = calls().length;
      $(".ls-focus .ls-tabw.on .ls-tab-x").click();
      for (let i = 0; i < 30 && !$(".modal.close-dlg"); i++) await sleep(100);
      const dialog = $(".modal.close-dlg h3")?.textContent ?? null;
      const since = calls().slice(mark);
      return { tabs: tabs0, x3: x3Info, dialog, asked: since.filter((c) => c.fn === "worktreeState").map((c) => c.args[0]), killed: since.filter((c) => c.fn === "killSession").map((c) => c.args[0]) };`
    );
    expect(r.tabs).toEqual([
      ["s2", "API: last org per user", "Close API: last org per user", "1"],
      ["s3", "API tests", "Close API tests", "0"],
      [expect.any(String), "Last-org API tests", null, null],
    ]);
    expect(r.x3).toEqual({ tag: "button", tabIndex: 0, shown: "1" });
    // its worktree has uncommitted work: Close…'s dialog, and nothing closed until it's answered
    expect(r.asked).toEqual(["/Users/you/Code/worktrees/backoffice/5101-orgDropdowns"]);
    expect(r.dialog).toBe("Close API: last org per user?");
    expect(r.killed).toEqual([]);
  }, 120_000);

  it("closes a lone workspace from its one tab's × as Close… does: a clean worktree closes without asking", async () => {
    const r = await drive<{ tabs: string[][]; killed: unknown[]; dialog: boolean }>(
      "lsFocus=s5",
      FOCUSED_S5,
      `
      await sleep(300);
      const tabs0 = tabs();
      const mark = calls().length;
      $(".ls-focus .ls-tabw.on .ls-tab-x").click();
      for (let i = 0; i < 30 && !calls().slice(mark).some((c) => c.fn === "killSession"); i++) await sleep(100);
      return { tabs: tabs0, killed: calls().slice(mark).filter((c) => c.fn === "killSession").map((c) => c.args), dialog: !!$(".modal.close-dlg") };`
    );
    expect(r.tabs).toEqual([["s5", "Pathways quick view freezes", "Close Pathways quick view freezes", "1"]]);
    expect(r.killed).toEqual([["s5", false]]);
    expect(r.dialog).toBe(false);
  }, 120_000);

  it("end with + : New session's dialog for a new tab in the stack, or for one beside a lone workspace that stacks them", async () => {
    const plus = `
      await sleep(300);
      const b = $(".ls-focus .ls-tab-new");
      const info = { label: b.getAttribute("aria-label"), disabled: b.disabled, tip: b.dataset.tip };
      b.click();
      for (let i = 0; i < 30 && !$(".modal.ns"); i++) await sleep(100);
      return { ...info, dialog: $(".modal.ns")?.textContent ?? null };`;
    const stack = await drive<{ label: string; disabled: boolean; tip: string; dialog: string | null }>("lsFocus=s2", FOCUSED_STACK, plus);
    expect(stack).toMatchObject({ label: "New tab in api", disabled: false, tip: "Another session in this stack" });
    expect(stack.dialog).toContain("5101/api");
    const lone = await drive<{ label: string; disabled: boolean; tip: string; dialog: string | null }>("lsFocus=s5", FOCUSED_S5, plus);
    expect(lone).toMatchObject({ label: "New tab beside Pathways quick view freezes", disabled: false, tip: expect.stringContaining("they become a stack") });
    expect(lone.dialog).toMatch(/5102\/\S/);
  }, 180_000);

  it("with a teammate's tab in front: no × on it, and + off with New tab's refusal as its tooltip", async () => {
    const r = await drive<{ front: string | null; x: boolean; plus: { disabled: boolean; tip: string } }>(
      "lsFocus=s2",
      FOCUSED_STACK,
      `
      await sleep(300);
      const sam = [...document.querySelectorAll(".ls-focus .ls-tab[data-sid]")].find((t) => t.textContent.includes("Last-org API tests"));
      sam.click();
      for (let i = 0; i < 30 && !$(".ls-focus .ls-tab.on")?.textContent.includes("Last-org API tests"); i++) await sleep(100);
      await sleep(200);
      const b = $(".ls-focus .ls-tab-new");
      return { front: $(".ls-focus .ls-tab.on .t")?.textContent ?? null, x: !!$(".ls-focus .ls-tabw.on .ls-tab-x"), plus: { disabled: b.disabled, tip: b.dataset.tip } };`
    );
    expect(r.front).toBe("Last-org API tests");
    expect(r.x).toBe(false);
    expect(r.plus).toEqual({ disabled: true, tip: "Sam's session: only its owner adds tabs beside it" });
  }, 120_000);
});

describe.skipIf(!local)("the focused header's ⋯", () => {
  const open = (sel: string) => `
      await sleep(300);
      $(${JSON.stringify(sel)}).click();
      for (let i = 0; i < 30 && !menu().length; i++) await sleep(100);
      await sleep(100);
      return menu();`;

  it("offers Session, Stack, Terminal, Hand on and Close, and only rows that can be done now: no sizes, tools, wires or New tab", async () => {
    expect(await drive<string[]>("lsFocus=s2", FOCUSED_STACK, open(".ls-focus .ls-more"))).toEqual([
      "# Session", "Rename…", "Mute notifications", "Move to area…",
      "-", "# Stack", "Rename “api”…", "Unstack its tabs",
      "-", "# Terminal", "Repaint", "Undo the last turn…", "Add terminal on its tree",
      "-", "# Hand on", "Continue in Codex…", "Fresh session from a brief…", "Second opinion from Codex",
      "-", "Close…",
    ]);
  }, 120_000);

  it("leaves the card's ⋯ whole", async () => {
    const rows = await drive<string[]>("", '.ls-world [data-front="s2"] .ls-more', open('.ls-world [data-front="s2"] .ls-more'));
    expect(rows).toEqual(expect.arrayContaining(["# Tools", "Files", "Artifacts", "New tab in “api”…", "# Wires", "Connect…", "Close…"]));
    expect(rows.some((r) => r.startsWith("Size M"))).toBe(true);
    expect(rows).toContain("Hide the agent's diff panel (off)");
  }, 120_000);
});
