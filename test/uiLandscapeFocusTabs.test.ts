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

// In focus the rail is the area tree and the tools that dock beside the workspace (FocusPanel.tsx): one at a time in
// the side bar's slot, on the left between the rail and the focused workspace, on the session in front of it.
const WHOLE_RAIL = ["Sessions", "Files", "Changes", "Search", "Run & debug", "Chat", "Artifacts"];
const FOCUS_RAIL = ["Sessions", "Files", "Changes", "Run & debug"];
/** Each docking view, the tool it docks and the call to main that shows which session it reads. */
const DOCKS = [
  { view: "explorer", tool: "files", fn: "filesList" },
  { view: "scm", tool: "changes", fn: "scmStatus" },
  { view: "run", tool: "run", fn: "runProfile" },
];
/** Steps' helpers for the side bar: its panel's tool and session, the rail's pressed views, a rail button, its width, whether the tree shows. */
const SIDE = `
      const panel = () => $(".sidebar .side-tool");
      const info = () => { const p = panel(); return p ? { tool: p.dataset.tool, session: p.dataset.session ?? null } : null; };
      const pressed = () => [...document.querySelectorAll(".activitybar .ab-btn")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.view);
      const btn = (v) => $('.activitybar .ab-btn[data-view="' + v + '"]');
      const sideW = () => Math.round($(".sidebar").getBoundingClientRect().width);
      const treeShown = () => sideW() > 0 && ($(".sidebar .area-tree")?.getClientRects().length ?? 0) > 0;
      const until = async (ok, ms = 3000) => { for (let i = 0; i < ms / 50 && !ok(); i++) await sleep(50); return ok(); };
      const docks = ${JSON.stringify(DOCKS)};`;

describe.skipIf(!local)("the rail while a workspace is in focus", () => {
  it("offers only Sessions, Files, Changes and Run & debug; unfocused, and once focus ends, the whole rail", async () => {
    const labels = `[...document.querySelectorAll(".activitybar .ab-btn")].map((b) => b.getAttribute("aria-label"))`;
    const r = await drive<{ focused: string[]; after: string[] }>(
      "lsFocus=s5",
      FOCUSED_S5,
      `
      await sleep(300);
      const focused = ${labels};
      $(".ls-focus .ls-back").click();
      for (let i = 0; i < 40 && $(".ls-focus"); i++) await sleep(50);
      await sleep(100);
      return { focused, after: ${labels} };`
    );
    expect(r).toEqual({ focused: FOCUS_RAIL, after: WHOLE_RAIL });
    expect(await drive<string[]>("", ".ls-world .ls-node", `await sleep(300); return ${labels};`)).toEqual(WHOLE_RAIL);
  }, 120_000);

  it("Sessions opens the area tree in the slot beside the workspace, in place of a docked tool, and pressed again hides it; focus stays throughout", async () => {
    interface State { focus: boolean; tree: boolean; left: boolean; tool: { tool: string; session: string | null } | null; pressed: string[] }
    const r = await drive<Record<"start" | "opened" | "files" | "back" | "shut", State>>(
      "side=closed&lsFocus=s5",
      FOCUSED_S5,
      `${SIDE}
      await sleep(300);
      const state = () => {
        const tree = $(".sidebar .area-tree")?.getBoundingClientRect();
        const node = $(".ls-focus .ls-node.focus")?.getBoundingClientRect();
        return { focus: !!$(".ls-focus"), tree: treeShown(), left: !!tree && !!node && tree.right <= node.left + 1, tool: info(), pressed: pressed() };
      };
      const start = state();
      await click(btn("sessions"));
      await until(treeShown);
      const opened = state();
      await click(btn("explorer"));
      await until(() => !!panel());
      const files = state();
      await click(btn("sessions"));
      await until(() => !panel());
      const back = state();
      await click(btn("sessions"));
      await until(() => sideW() === 0);
      return { start, opened, files, back, shut: state() };`
    );
    expect(r.start).toMatchObject({ focus: true, tree: false, tool: null, pressed: [] });
    expect(r.opened).toEqual({ focus: true, tree: true, left: true, tool: null, pressed: ["sessions"] });
    expect(r.files).toMatchObject({ focus: true, tree: false, tool: { tool: "files", session: "s5" }, pressed: ["explorer"] });
    expect(r.back).toEqual({ focus: true, tree: true, left: true, tool: null, pressed: ["sessions"] });
    expect(r.shut).toMatchObject({ focus: true, tree: false, tool: null, pressed: [] });
  }, 120_000);

  it("docks Files, Changes and Run & debug on the left, between the rail and the workspace, on the focused session; one at a time", async () => {
    const r = await drive<{ view: string; tool: unknown; pressed: string[]; place: Record<string, boolean>; asked: string[]; focus: boolean; right: boolean }[]>(
      "lsFocus=s5",
      FOCUSED_S5,
      `${SIDE}
      await sleep(300);
      const out = [];
      for (const d of docks) {
        const mark = calls().length;
        await click(btn(d.view));
        await until(() => panel()?.dataset.tool === d.tool);
        await until(() => calls().slice(mark).some((c) => c.fn === d.fn));
        await sleep(200);
        const p = panel().getBoundingClientRect();
        const node = $(".ls-focus .ls-node.focus").getBoundingClientRect();
        const bar = $(".activitybar").getBoundingClientRect();
        out.push({
          view: d.view,
          tool: info(),
          pressed: pressed(),
          place: { afterRail: p.left >= bar.right - 1, beforeWorkspace: p.right <= node.left + 1, wide: p.width >= 150, tall: p.height >= node.height - 2 },
          asked: [...new Set(calls().slice(mark).filter((c) => c.fn === d.fn).map((c) => c.args[0]))],
          focus: !!$(".ls-focus"),
          // nothing of the side bar's or a tool's sits to the workspace's right
          right: [...document.querySelectorAll(".side-tool, .ls-dock")].some((el) => el.getBoundingClientRect().left >= node.right - 1),
        });
      }
      return out;`
    );
    expect(r).toEqual(
      DOCKS.map((d) => ({
        view: d.view,
        tool: { tool: d.tool, session: "s5" },
        pressed: [d.view],
        place: { afterRail: true, beforeWorkspace: true, wide: true, tall: true },
        asked: ["s5"],
        focus: true,
        right: false,
      }))
    );
  }, 120_000);

  it("re-scopes the docked tool to the tab that comes to the front, and says why it can't show a teammate's", async () => {
    const r = await drive<{ steps: { view: string; first: string | null; second: string | null; asked: string[]; back: string | null }[]; teammate: { session: string | null; note: string | null } }>(
      "lsFocus=s2",
      FOCUSED_STACK,
      `${SIDE}
      await sleep(300);
      const front = () => $(".ls-focus .ls-tab.on")?.dataset.sid ?? null;
      const tab = (id) => $('.ls-focus .ls-tab[data-sid="' + id + '"]');
      const steps = [];
      for (const d of docks) {
        await click(btn(d.view));
        await until(() => panel()?.dataset.tool === d.tool);
        const first = info()?.session ?? null;
        const mark = calls().length;
        await click(tab("s3"));
        await until(() => front() === "s3" && info()?.session === "s3");
        await until(() => calls().slice(mark).some((c) => c.fn === d.fn && c.args[0] === "s3"));
        const second = info()?.session ?? null;
        const asked = [...new Set(calls().slice(mark).filter((c) => c.fn === d.fn).map((c) => c.args[0]))];
        await click(tab("s2"));
        await until(() => front() === "s2" && info()?.session === "s2");
        steps.push({ view: d.view, first, second, asked, back: info()?.session ?? null });
      }
      await click([...document.querySelectorAll(".ls-focus .ls-tab[data-sid]")].find((t) => t.textContent.includes("Last-org API tests")));
      await until(() => !!front()?.startsWith("r~") && !panel()?.dataset.session);
      return { steps, teammate: { session: info()?.session ?? null, note: panel()?.querySelector(".fp-note")?.textContent ?? null } };`
    );
    expect(r.steps).toEqual(DOCKS.map((d) => ({ view: d.view, first: "s2", second: "s3", asked: ["s3"], back: "s2" })));
    expect(r.teammate.session).toBeNull();
    expect(r.teammate.note).toMatch(/doesn't open on|teammate|Sam/);
  }, 120_000);

  it("closes a docked tool when its icon is pressed again, or its ×, putting the slot away; focus stays", async () => {
    const r = await drive<{ again: Record<string, unknown>; x: Record<string, unknown> }>(
      "lsFocus=s5",
      FOCUSED_S5,
      `${SIDE}
      await sleep(300);
      const state = () => ({ panel: !!panel(), side: sideW(), focus: !!$(".ls-focus"), pressed: pressed() });
      await click(btn("scm"));
      await until(() => !!panel());
      await click(btn("scm"));
      await until(() => !panel() && sideW() === 0);
      const again = state();
      await click(btn("run"));
      await until(() => !!panel());
      await click($(".sidebar .side-tool .side-close"));
      await until(() => !panel() && sideW() === 0);
      return { again, x: state() };`
    );
    expect(r.again).toEqual({ panel: false, side: 0, focus: true, pressed: [] });
    expect(r.x).toEqual({ panel: false, side: 0, focus: true, pressed: [] });
  }, 120_000);

  it("leaves the landscape's side bar as it was before focus, whatever the slot held in focus", async () => {
    const leave = `
      $(".ls-focus .ls-back").click();
      await until(() => !$(".ls-focus"));
      await sleep(200);`;
    // the tree shown on the landscape: Files opened and closed (by its icon), Changes by its ×, then focus left
    const shown = await drive<{ before: boolean; inFocus: number; after: boolean; pref: string | null }>(
      "lsFocus=s5",
      FOCUSED_S5,
      `${SIDE}
      await sleep(300);
      const before = treeShown();
      await click(btn("explorer"));
      await until(() => !!panel());
      await click(btn("explorer"));
      await until(() => !panel());
      await click(btn("scm"));
      await until(() => !!panel());
      await click($(".sidebar .side-tool .side-close"));
      await until(() => !panel());
      const inFocus = sideW();
      ${leave}
      return { before, inFocus, after: treeShown(), pref: localStorage.getItem("mb.side") };`
    );
    expect(shown).toEqual({ before: true, inFocus: 0, after: true, pref: expect.not.stringMatching(/true/) });
    // the tree hidden on the landscape: shown in focus by Sessions, then a tool docked there and closed
    const hidden = await drive<{ before: boolean; tree: boolean; after: boolean; side: number }>(
      "side=closed&lsFocus=s5",
      FOCUSED_S5,
      `${SIDE}
      await sleep(300);
      const before = treeShown();
      await click(btn("sessions"));
      await until(treeShown);
      const tree = treeShown();
      await click(btn("run"));
      await until(() => !!panel());
      await click(btn("run"));
      await until(() => !panel());
      ${leave}
      return { before, tree, after: treeShown(), side: sideW() };`
    );
    expect(hidden).toEqual({ before: false, tree: true, after: false, side: 0 });
  }, 180_000);

  it("ends focus for ⇧⌘F, Search opening beside the workspace on the landscape: its field takes the keyboard where the zoom draws it, else the landscape does", async () => {
    type Out = { focus: boolean; windows: number; onScreen: boolean; at: string };
    const steps = `
      await termIn("s5");
      await press({ key: "F", meta: true, shift: true });
      const win = () => $('.ls-world .ls-window[data-tool="search"]');
      for (let i = 0; i < 80 && ($(".ls-focus") || !win()); i++) await sleep(50);
      for (let i = 0; i < 40 && !document.activeElement?.closest('.ls-window[data-tool="search"]'); i++) await sleep(50);
      await sleep(300);
      const v = $(".ls-viewport").getBoundingClientRect();
      const b = win()?.getBoundingClientRect();
      const inSearch = !!document.activeElement?.closest('.ls-window[data-tool="search"]');
      return {
        focus: !!$(".ls-focus"),
        windows: document.querySelectorAll('.ls-world .ls-window[data-tool="search"]').length,
        onScreen: !!b && b.right > v.left && b.left < v.right && b.bottom > v.top && b.top < v.bottom,
        at: inSearch ? "search:" + document.activeElement.tagName.toLowerCase() : where(),
      };`;
    // at 100% the window is drawn whole, its field taking the keyboard
    expect(await drive<Out>("lsCamera=0,0,1&lsFocus=s5", FOCUSED_S5, steps)).toEqual({ focus: false, windows: 1, onScreen: true, at: "search:input" });
    // fitted, zoomed out to cards, it's its head alone, as a window opened from the landscape is: the landscape keeps the keyboard
    expect(await drive<Out>("lsFocus=s5", FOCUSED_S5, steps)).toEqual({ focus: false, windows: 1, onScreen: true, at: expect.stringMatching(/^div\.ls-viewport/) });
  }, 180_000);
});

describe.skipIf(!local)("the keyboard with a tool docked in focus", () => {
  it("stays with the focused terminal when a tool is opened, clicked in, swapped or closed, also from a field in it", async () => {
    const r = await drive<{ steps: Step[]; field: string; swallowed: string[]; note: string }>(
      "lsFocus=s5",
      FOCUSED_S5,
      `${SIDE}
      const steps = [];
      const typeX = async (id) => {
        await sleep(150);
        const at = where();
        const mark = w.__mbCalls.length;
        await press({ key: "x" });
        await sleep(150);
        steps.push({ id, at, typed: typed(mark) });
      };
      await termIn("s5");
      await click(btn("explorer"));
      await until(() => !!panel()?.querySelector(".fp-row .fp-folder"));
      await typeX("s5");
      // a folder's row (it expands), and the panel's own head
      await click(panel().querySelector(".fp-row .fp-folder").closest(".fp-row"));
      await typeX("s5");
      await click(panel().querySelector(".side-title"));
      await typeX("s5");
      // swapped for Changes, its commit message clicked into, then closed from the keyboard
      await click(btn("scm"));
      await until(() => !!panel()?.querySelector("textarea"));
      await typeX("s5");
      await click(panel().querySelector("textarea"));
      await sleep(150);
      const field = where();
      await press({ key: "G", ctrl: true, shift: true });
      await until(() => !panel());
      await typeX("s5");
      // opened and closed again from the rail
      await click(btn("run"));
      await until(() => !!panel());
      await click(btn("run"));
      await until(() => !panel());
      await typeX("s5");
      return { steps, field, swallowed, note: note() };`
    );
    expect(r.field).toMatch(/^textarea/);
    expect(r.steps).toEqual(Array.from({ length: 6 }, () => ({ id: "s5", at: "term:s5", typed: ["s5:x"] })));
    expect(r.swallowed).toEqual([]);
    expect(r.note).not.toMatch(KEYS_NOTE);
  }, 120_000);

  it("goes back to the focused terminal on Esc in a docked tool, from a field or a button, and focus stays; Esc in the terminal is the terminal's, as before", async () => {
    const r = await drive<Record<"field" | "button", { from: string; at: string; focus: boolean; panel: boolean }> & { term: { at: string; focus: boolean; typed: string[] } }>(
      "lsFocus=s5",
      FOCUSED_S5,
      `${SIDE}
      await termIn("s5");
      await click(btn("scm"));
      await until(() => !!panel()?.querySelector("textarea"));
      const esc = async (from) => {
        await press({ key: "Escape" });
        await sleep(200);
        return { from, at: where(), focus: !!$(".ls-focus"), panel: !!panel() };
      };
      await click(panel().querySelector("textarea"));
      await sleep(150);
      const field = await esc(where());
      panel().querySelector(".side-close").focus();
      const button = await esc(where());
      const mark = w.__mbCalls.length;
      await press({ key: "Escape" });
      await sleep(200);
      return { field, button, term: { at: where(), focus: !!$(".ls-focus"), typed: typed(mark) } };`
    );
    expect(r.field).toEqual({ from: expect.stringMatching(/^textarea/), at: "term:s5", focus: true, panel: true });
    expect(r.button).toEqual({ from: expect.stringMatching(/^button\..*side-close/), at: "term:s5", focus: true, panel: true });
    expect(r.term).toEqual({ at: "term:s5", focus: true, typed: ["s5:\u001b"] });
  }, 120_000);
});
