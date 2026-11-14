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
 *
 * For the keyboard: `press(...keys)` presses for real (scripts/ui-preview.mjs's window.__mbKeys), `click(el)` presses
 * the mouse on an element's middle, `where()` names what has the keyboard ("term:<id>" for a session's terminal,
 * "holder" for keyArm's, else tag.class), `termIn(id)` waits for session `id`'s terminal to have it, `typed(mark)` is
 * what reached a session's pty since call `mark` ("<id>:<data>"), `swallowed` the keys the holder swallowed, and
 * `warned` what was said with console.warn.
 */
async function drive<T>(query: string, ready: string, steps: string, size = "1400x900"): Promise<T> {
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
      const press = async (...ks) => {
        const done = (w.__mbKeysDone || 0) + ks.length;
        (w.__mbKeys ||= []).push(...ks);
        for (let i = 0; i < 200 && (w.__mbKeysDone || 0) < done; i++) await sleep(25);
      };
      const click = (el) => {
        const r = el.getBoundingClientRect();
        return press({ mouse: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), clickCount: 1 } });
      };
      const where = () => {
        const a = document.activeElement;
        if (!a || a === document.body) return "body";
        if (a.classList.contains("mb-keys-nowhere")) return "holder";
        if (a.closest(".xterm")) return "term:" + (a.closest(".ls-node")?.dataset.front ?? "?");
        return a.tagName.toLowerCase() + "." + [...a.classList].join(".");
      };
      const termIn = async (id, ms = 4000) => {
        for (let i = 0; i < ms / 50 && where() !== "term:" + id; i++) await sleep(50);
        return where();
      };
      const typed = (mark) => w.__mbCalls.slice(mark).filter((c) => c.fn === "sessionWrite").map((c) => c.args[0] + ":" + c.args[1]);
      const swallowed = [];
      document.addEventListener("mb-keys-swallowed", (e) => swallowed.push(e.detail));
      const note = () => [...document.querySelectorAll(".ls-note")].map((n) => n.textContent).join(" | ");
      const warned = [];
      const warn = console.warn;
      console.warn = (...a) => (warned.push(a.map(String).join(" ")), warn.apply(console, a));
      w.__ftRun = (async () => { ${steps} })().then((v) => (w.__ftOut = JSON.stringify(v ?? null)), (e) => (w.__ftOut = JSON.stringify({ failed: String(e && e.stack || e) })));
    }
    return w.__ftOut ?? null;
  })()`;
  const out: string = await pageResult({ size, query: `motion=off&${query}`, outDir: path.join(tempDir("focusTabs"), "out"), read });
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

// What's typed after a tab comes to the front of the focused stack reaches that tab's terminal, never keyArm's holder
// (whose swallowed keys say "Click the landscape to use its keys…"). ?lsSaveMs makes main slow to save the stack's front
// tab, so the new front's terminal is shown, and mounted, a while after the choice.
interface Step {
  id: string;
  at: string;
  typed: string[];
}
const KEYS_NOTE = /Click the landscape/;

describe.skipIf(!local)("the keyboard as the focused stack's tab in front changes", () => {
  /** Real clicks on these tabs in turn, `gap` ms apart, an x typed after each once its tab is in front; returns where the keyboard was and what the x reached. */
  const clicks = (ids: string[], gap: number) => `
      const start = await termIn("s2");
      const steps = [];
      for (const id of ${JSON.stringify(ids)}) {
        await click($('.ls-focus .ls-tab[data-sid="' + id + '"]'));
        await sleep(${gap});
        for (let i = 0; i < 60 && $(".ls-focus .ls-tab.on")?.dataset.sid !== id; i++) await sleep(50);
        const at = await termIn(id, 2000);
        const mark = w.__mbCalls.length;
        await press({ key: "x" });
        await sleep(150);
        steps.push({ id, at, typed: typed(mark) });
      }
      return { start, steps, swallowed, note: note() };`;
  const each = (ids: string[]) => ids.map((id): Step => ({ id, at: `term:${id}`, typed: [`${id}:x`] }));

  it("goes to the chosen tab's terminal every time, chosen slowly or fast", async () => {
    const slow = await drive<{ start: string; steps: Step[]; swallowed: string[]; note: string }>("lsFocus=s2", FOCUSED_STACK, clicks(["s3", "s2", "s3", "s2"], 300));
    expect(slow.start).toBe("term:s2");
    expect(slow.steps).toEqual(each(["s3", "s2", "s3", "s2"]));
    expect(slow.swallowed).toEqual([]);
    expect(slow.note).not.toMatch(KEYS_NOTE);
    const fast = await drive<{ start: string; steps: Step[]; swallowed: string[]; note: string }>("lsFocus=s2", FOCUSED_STACK, clicks(["s3", "s2", "s3"], 0));
    expect(fast.steps).toEqual(each(["s3", "s2", "s3"]));
    expect(fast.swallowed).toEqual([]);
    expect(fast.note).not.toMatch(KEYS_NOTE);
  }, 180_000);

  it("waits for a terminal shown late: main slow to save the tab in front", async () => {
    const r = await drive<{ start: string; steps: Step[]; swallowed: string[]; note: string }>("lsFocus=s2&lsSaveMs=600", FOCUSED_STACK, clicks(["s3", "s2"], 0));
    expect(r.steps).toEqual(each(["s3", "s2"]));
    expect(r.swallowed).toEqual([]);
    expect(r.note).not.toMatch(KEYS_NOTE);
    // two tabs behind chosen back to back, the teammate's first: it comes forward (its frame taking no keys), then s3
    const burst = await drive<{ asked: string[]; frontThen: string | null; at: string; typed: string[]; swallowed: string[] }>(
      "lsFocus=s2&lsSaveMs=600",
      FOCUSED_STACK,
      `
      await termIn("s2");
      const mark0 = w.__mbCalls.length;
      await click([...document.querySelectorAll(".ls-focus .ls-tab[data-sid]")].find((t) => t.textContent.includes("Last-org API tests")));
      await click($('.ls-focus .ls-tab[data-sid="s3"]'));
      // both presses came while s2 was still in front: each one a tab chosen, saved in turn
      const frontThen = $(".ls-focus .ls-tab.on")?.dataset.sid ?? null;
      for (let i = 0; i < 80 && $(".ls-focus .ls-tab.on")?.dataset.sid !== "s3"; i++) await sleep(50);
      const at = await termIn("s3", 2000);
      const asked = w.__mbCalls.slice(mark0).filter((c) => c.fn === "landscapeUpdate" && c.args[0]?.stacks?.["5101/api"]).map((c) => c.args[0].stacks["5101/api"].active);
      const mark = w.__mbCalls.length;
      await press({ key: "x" });
      await sleep(150);
      return { asked: asked.map((id) => (id.startsWith("r~") ? "teammate" : id)), frontThen, at, typed: typed(mark), swallowed };`
    );
    expect(burst).toEqual({ asked: ["teammate", "s3"], frontThen: "s2", at: "term:s3", typed: ["s3:x"], swallowed: [] });
  }, 120_000);

  it("goes to the tab that comes forward when × closes the one in front, once its dialog is confirmed", async () => {
    const r = await drive<{ dialog: boolean; front: string | null; at: string; typed: string[]; swallowed: string[]; note: string }>(
      "lsFocus=s2",
      FOCUSED_STACK,
      `
      await termIn("s2");
      await click($(".ls-focus .ls-tabw.on .ls-tab-x"));
      for (let i = 0; i < 40 && !$(".modal.close-dlg"); i++) await sleep(50);
      const dialog = !!$(".modal.close-dlg");
      await sleep(200);
      await click([...document.querySelectorAll(".modal.close-dlg button.primary")].find((b) => b.textContent === "Close session"));
      for (let i = 0; i < 60 && $('.ls-focus .ls-tab[data-sid="s2"]'); i++) await sleep(50);
      const front = $(".ls-focus .ls-tab.on")?.dataset.sid ?? null;
      const at = await termIn(front, 2000);
      const mark = w.__mbCalls.length;
      await press({ key: "x" });
      await sleep(150);
      return { dialog, front, at, typed: typed(mark), swallowed, note: note() };`
    );
    expect(r.dialog).toBe(true);
    expect(r.front).toBe("s3");
    expect(r.at).toBe("term:s3");
    expect(r.typed).toEqual(["s3:x"]);
    expect(r.swallowed).toEqual([]);
    expect(r.note).not.toMatch(KEYS_NOTE);
  }, 120_000);

  it("goes to the tab + makes, also when it comes forward late", async () => {
    const plus = `
      await termIn("s2");
      await click($(".ls-focus .ls-tab-new"));
      for (let i = 0; i < 40 && !$(".modal.ns"); i++) await sleep(50);
      await sleep(300);
      await click($(".modal.ns button.primary.cta"));
      for (let i = 0; i < 60 && $(".modal.ns"); i++) await sleep(50);
      const before = ["s2", "s3"];
      for (let i = 0; i < 60 && before.includes($(".ls-focus .ls-tab.on")?.dataset.sid); i++) await sleep(50);
      const front = $(".ls-focus .ls-tab.on")?.dataset.sid ?? null;
      const at = await termIn(front, 3000);
      const mark = w.__mbCalls.length;
      await press({ key: "x" });
      await sleep(150);
      return { fresh: !before.includes(front) && !front.startsWith("team:"), at: at === "term:" + front, typed: typed(mark).map((t) => t === front + ":x"), swallowed, note: note(), warned: warned.filter((x) => /keyboard/.test(x)) };`;
    for (const query of ["lsFocus=s2", "lsFocus=s2&lsSaveMs=600"]) {
      const r = await drive<{ fresh: boolean; at: boolean; typed: boolean[]; swallowed: string[]; note: string; warned: string[] }>(query, FOCUSED_STACK, plus);
      // the jump's wait for the terminal says nothing when the terminal does take the keyboard
      expect(r, query).toEqual({ fresh: true, at: true, typed: [true], swallowed: [], note: expect.not.stringMatching(KEYS_NOTE), warned: [] });
    }
  }, 180_000);

  it("stays where the user put it meanwhile, and on focus's frame for a teammate's tab", async () => {
    const r = await drive<{ moved: string; front: string | null; sam: string }>(
      "lsFocus=s2&lsSaveMs=600",
      FOCUSED_STACK,
      `
      await termIn("s2");
      await click($('.ls-focus .ls-tab[data-sid="s3"]'));
      // before main has the tab in front, a click in the area tree's filter
      await click($('input[aria-label="Find a workspace"]'));
      for (let i = 0; i < 60 && $(".ls-focus .ls-tab.on")?.dataset.sid !== "s3"; i++) await sleep(50);
      await sleep(800);
      const moved = where();
      const front = $(".ls-focus .ls-tab.on")?.dataset.sid ?? null;
      await click([...document.querySelectorAll(".ls-focus .ls-tab[data-sid]")].find((t) => t.textContent.includes("Last-org API tests")));
      for (let i = 0; i < 60 && !$(".ls-focus .ls-tab.on")?.textContent.includes("Last-org API tests"); i++) await sleep(50);
      await sleep(300);
      return { moved, front, sam: where() };`
    );
    expect(r.front).toBe("s3");
    expect(r.moved).toBe("input.filter");
    expect(r.sam).toBe("div.ls-focus");
  }, 120_000);

  it("isn't handed on to the chosen tab once a dialog opened meanwhile", async () => {
    // a tab chosen, then New Session's dialog opened from main (no key or press here) and cancelled, before main has
    // the tab in front: what had the keyboard as the dialog opened gets it back, and s3 doesn't take it after
    const r = await drive<{ dialog: boolean; front: string | null; at: string }>(
      "lsFocus=s2&lsSaveMs=900",
      FOCUSED_STACK,
      `
      await termIn("s2");
      await click($('.ls-focus .ls-tab[data-sid="s3"]'));
      w.__mbEmit("onUiCommand", "new-session");
      for (let i = 0; i < 40 && !$(".modal.ns"); i++) await sleep(25);
      const dialog = !!$(".modal.ns");
      await click([...document.querySelectorAll(".modal.ns button")].find((b) => b.textContent === "Cancel"));
      for (let i = 0; i < 80 && $(".ls-focus .ls-tab.on")?.dataset.sid !== "s3"; i++) await sleep(50);
      await sleep(1000);
      return { dialog, front: $(".ls-focus .ls-tab.on")?.dataset.sid ?? null, at: where() };`
    );
    expect(r.dialog).toBe(true);
    expect(r.front).toBe("s3");
    expect(r.at).not.toBe("term:s3");
  }, 120_000);

  it("goes to the landscape, armed, when × closes the only tab and focus ends", async () => {
    const r = await drive<{ focus: boolean; at: string; sheet: boolean; swallowed: string[] }>(
      "lsFocus=s5",
      FOCUSED_S5,
      `
      await termIn("s5");
      await click($(".ls-focus .ls-tabw.on .ls-tab-x"));
      for (let i = 0; i < 60 && $(".ls-focus"); i++) await sleep(50);
      await sleep(300);
      const at = where();
      // armed: its own keys work at once
      await press({ key: "?", shift: true });
      await sleep(300);
      return { focus: !!$(".ls-focus"), at, sheet: !!$(".ls-keys"), swallowed };`
    );
    expect(r).toEqual({ focus: false, at: expect.stringMatching(/^div\.ls-viewport/), sheet: true, swallowed: [] });
  }, 120_000);

  it("keeps a lone workspace in focus when + stacks it with its new tab, which gets the keyboard", async () => {
    const r = await drive<{ focus: boolean; tabs: string[]; front: string | null; at: string; swallowed: string[] }>(
      "lsFocus=s5",
      FOCUSED_S5,
      `
      await termIn("s5");
      await click($(".ls-focus .ls-tab-new"));
      for (let i = 0; i < 40 && !$(".modal.ns"); i++) await sleep(50);
      await sleep(300);
      await click($(".modal.ns button.primary.cta"));
      for (let i = 0; i < 60 && $(".modal.ns"); i++) await sleep(50);
      for (let i = 0; i < 60 && ($(".ls-focus .ls-tab.on")?.dataset.sid ?? "s5") === "s5"; i++) await sleep(50);
      const front = $(".ls-focus .ls-tab.on")?.dataset.sid ?? null;
      const at = await termIn(front, 2000);
      return { focus: !!$(".ls-focus"), tabs: [...document.querySelectorAll(".ls-focus .ls-tab[data-sid]")].map((t) => t.dataset.sid), front, at, swallowed };`
    );
    expect(r.focus).toBe(true);
    expect(r.tabs).toEqual(["s5", r.front]);
    expect(r.front).not.toBe("s5");
    expect(r.at).toBe(`term:${r.front}`);
    expect(r.swallowed).toEqual([]);
  }, 120_000);
});

// A jump (⌘K, a notification, the side bar) waits up to REVEAL_WAIT_MS for its terminal to be there: s3, behind s2 in
// the "api" stack, comes to the front only once main has saved that (?lsSaveMs). Both workspaces are live at 80% in a
// wide window, where a terminal takes the keyboard.
describe.skipIf(!local)("a jump still waiting for its terminal", () => {
  const WIDE = "2400x1200";
  const waitingJump = (then: string) => `
      await sleep(1500);
      w.__mbEmit("onUiCommand", "focus-session", "s3");
      await sleep(150);
      ${then}
      for (let i = 0; i < 80 && $('.ls-world [data-ws="ws:5101/api"]')?.dataset.front !== "s3"; i++) await sleep(50);
      await sleep(1000);
      const a = document.activeElement;
      return { front: $('.ls-world [data-ws="ws:5101/api"]')?.dataset.front ?? null, at: where(), inDialog: !!a?.closest(".modal") };`;

  it("yields to a newer jump that came with no input here (a notification's)", async () => {
    const r = await drive<{ front: string | null; at: string }>("lsCamera=0,0,0.8&lsSaveMs=900", '.ls-world [data-front="s1"] .xterm', waitingJump(`w.__mbEmit("onUiCommand", "focus-session", "s1"); await termIn("s1", 1000);`), WIDE);
    expect(r).toMatchObject({ front: "s3", at: "term:s1" });
  }, 120_000);

  it("yields to a click elsewhere", async () => {
    const r = await drive<{ front: string | null; at: string }>("lsCamera=0,0,0.8&lsSaveMs=900", '.ls-world [data-front="s1"] .xterm', waitingJump(`await click($('input[aria-label="Find a workspace"]'));`), WIDE);
    expect(r).toMatchObject({ front: "s3", at: "input.filter" });
  }, 120_000);

  it("yields to a dialog that opened", async () => {
    const r = await drive<{ front: string | null; inDialog: boolean }>("lsCamera=0,0,0.8&lsSaveMs=900", '.ls-world [data-front="s1"] .xterm', waitingJump(`w.__mbEmit("onUiCommand", "new-session");`), WIDE);
    expect(r).toMatchObject({ front: "s3", inDialog: true });
  }, 120_000);

  it("gives the terminal the keyboard once it's there, when nothing else happened", async () => {
    const r = await drive<{ front: string | null; at: string }>("lsCamera=0,0,0.8&lsSaveMs=900", '.ls-world [data-front="s1"] .xterm', waitingJump(""), WIDE);
    expect(r).toMatchObject({ front: "s3", at: "term:s3" });
  }, 120_000);
});

describe.skipIf(!local)("the focused header's tabs, to assistive tech", () => {
  it("keep the × and + buttons out of the tablist, which owns only the tabs; the only tab takes no Tab stop or hand cursor", async () => {
    const shape = `
      await sleep(300);
      const head = $(".ls-focus .ls-head");
      const lists = [...head.querySelectorAll("[role=tablist]")];
      const owned = (lists[0]?.getAttribute("aria-owns") ?? "").split(" ").filter(Boolean);
      return {
        lists: lists.length,
        inList: lists.flatMap((l) => [...l.querySelectorAll("*")]).length,
        owned: owned.map((id) => { const el = document.getElementById(id); return el ? el.getAttribute("role") + ":" + el.dataset.sid : null; }),
        buttonsInLists: [...head.querySelectorAll(".ls-tab-x, .ls-tab-new")].filter((b) => b.closest("[role=tablist]")).length,
        closes: [...head.querySelectorAll(".ls-tab-x")].map((b) => b.tabIndex),
        tabs: [...head.querySelectorAll("[role=tab]")].map((t) => [t.dataset.sid, t.tabIndex, getComputedStyle(t).cursor]),
      };`;
    const stack = await drive<{ lists: number; inList: number; owned: string[]; buttonsInLists: number; closes: number[]; tabs: [string, number, string][] }>("lsFocus=s2", FOCUSED_STACK, shape);
    expect(stack).toMatchObject({ lists: 1, inList: 0, buttonsInLists: 0, closes: [0, 0] });
    expect(stack.owned).toEqual(["tab:s2", "tab:s3", expect.stringMatching(/^tab:r~/)]);
    expect(stack.tabs.map((t) => [t[1], t[2]])).toEqual([[0, "pointer"], [0, "pointer"], [0, "pointer"]]);
    const lone = await drive<{ lists: number; inList: number; owned: string[]; buttonsInLists: number; closes: number[]; tabs: [string, number, string][] }>("lsFocus=s5", FOCUSED_S5, shape);
    expect(lone).toEqual({ lists: 1, inList: 0, owned: ["tab:s5"], buttonsInLists: 0, closes: [0], tabs: [["s5", -1, "default"]] });
  }, 120_000);
});
