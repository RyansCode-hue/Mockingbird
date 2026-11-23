/**
 * ?landscapeColourAudit=a|b (with ?motion=off): an area's Colour popover (AreaColour.tsx) worked as a person would in
 * the UI preview, into <script id="mb-landscape-colour-audit-<part>"> for test/uiLandscapeColour.test.ts. The mouse and
 * keys are pressed for real (needsYouAudit.ts' drive), so they go wherever the browser sends them.
 *
 * =a, at fit: 5102 selected and its bar's dot pressed: the popover under the dot, a radio group with Automatic marked
 * and focused. ↓ → ↓ walk to Blue and Enter picks it: saved as 5102's accent through landscapeUpdate, and drawn on its
 * bar, its patch and its tree square. Pressed again, then Esc: closed, nothing saved. A press on a button of the
 * landscape's own leaves the keyboard with the landscape, so that's where both give it back. ⋯'s Colour… opens it over
 * the dot, Blue marked, and a click on Automatic takes the colour away. 5110's tree square (a room's area, Red in the
 * fixture): the popover under the square, Red marked; a click on Green saves it, and Esc there gives the keyboard back
 * to the square.
 * =b (with ?lsCamera at a zoom that draws headers): 5101's header dot pressed: the popover under it; Esc closes it.
 */
import type { Landscape, LandscapePatch, LandscapeState } from "../shared/landscape";
import { isArmed } from "../renderer/keyArm";
import { drive } from "./needsYouAudit";

export interface ColourAuditEnv {
  calls: { fn: string; args: unknown[] }[];
  waitFor: (selector: string, then: (el: HTMLElement) => void, tries?: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stored = async (): Promise<Landscape> => (await (window as unknown as { mb: { landscapeGet: () => Promise<LandscapeState> } }).mb.landscapeGet()).landscape;
const centre = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
};
async function clickAt(x: number, y: number): Promise<void> {
  if (!(await drive([{ mouse: { x, y, clickCount: 1 } }]))) throw new Error("the audit needs the test's Chrome driver to press for real");
  await sleep(300);
}
async function click(el: Element | null | undefined, what: string): Promise<void> {
  if (!el) throw new Error(`nothing to click: ${what}`);
  const c = centre(el);
  await clickAt(c.x, c.y);
}
async function press(key: string): Promise<void> {
  if (!(await drive([{ key }]))) throw new Error("the audit needs the test's Chrome driver to press for real");
  await sleep(250);
}

const popover = () => document.querySelector<HTMLElement>(".mb-menu.ls-colour");
/** An element's accent class's number (`a<n>`), or null. */
const accentOf = (el: Element | null) => {
  const m = el?.className.toString().match(/(?:^|\s)a(\d)(?:\s|$)/);
  return m ? Number(m[1]) : null;
};
const barDot = (key: string) => document.querySelector<HTMLElement>(`.ls-selbar [data-colour-dot="${CSS.escape(key)}"]`);
const treeDot = (key: string) => document.querySelector<HTMLElement>(`.lt-area[data-area="${CSS.escape(key)}"] [data-colour-dot]`);
const headerDot = (key: string) => document.querySelector<HTMLElement>(`.ls-area[data-area="${CSS.escape(key)}"] .ls-ah-dot`);
/** Where area `key`'s accent shows: its selection bar, its patch on the landscape, its tree square. */
const drawn = (key: string) => ({
  bar: accentOf(document.querySelector(`.ls-selbar .ls-sb-who`)),
  area: accentOf(document.querySelector(`.ls-area[data-area="${CSS.escape(key)}"]`)),
  tree: accentOf(treeDot(key)),
});
/** What the keyboard is on: a choice in the popover by its accent, a dot by its area, the landscape (armed?), or what else. */
const keyboard = () => {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === document.body) return "page";
  if (a.classList.contains("ls-viewport")) return isArmed(a) ? "landscape, armed" : "landscape";
  if (a.dataset.accent) return `choice ${a.dataset.accent}`;
  if (a.dataset.colourDot) return `dot ${a.dataset.colourDot}${a.closest(".ls-selbar") ? " in the bar" : a.closest(".lt-area") ? " in the tree" : a.closest(".ls-area") ? " in the header" : ""}`;
  return a.className || a.tagName;
};
/** The popover as it's drawn: its choices, which is marked and focused, and where it hangs from `from`. */
const seen = (from: Element | null) => {
  const p = popover();
  if (!p) return null;
  const group = p.querySelector('[role="radiogroup"]');
  const radios = [...p.querySelectorAll<HTMLElement>('[role="radio"]')];
  const box = p.getBoundingClientRect();
  const at = from?.getBoundingClientRect();
  return {
    label: group?.getAttribute("aria-label") ?? null,
    choices: radios.map((r) => r.getAttribute("aria-label")),
    checked: radios.filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.dataset.accent),
    tabbable: radios.filter((r) => r.tabIndex === 0).map((r) => r.dataset.accent),
    keyboard: keyboard(),
    below: !!at && box.top >= at.bottom - 1 && box.top - at.bottom < 16,
    inWindow: box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight,
  };
};
const ctxPick = async (text: string) => {
  const b = [...document.querySelectorAll<HTMLButtonElement>(".mb-ctx button")].find((x) => x.querySelector(".mb-ctx-t")?.textContent === text);
  await click(b, `the menu's ${text}`);
};

export function runColourAudit(env: ColourAuditEnv, part: string): void {
  const out: Record<string, unknown> = {};
  const write = () => {
    const el = document.createElement("script");
    el.type = "application/json";
    el.id = `mb-landscape-colour-audit-${part}`;
    el.textContent = JSON.stringify(out);
    document.body.appendChild(el);
  };
  const updates = (from: number) => env.calls.slice(from).filter((c) => c.fn === "landscapeUpdate").map((c) => c.args[0] as LandscapePatch);

  const a = async () => {
    // 5102 selected as a person selects an area: a click on its bare patch, its lower right corner
    const r = document.querySelector(`.ls-area[data-area="5102"]`)!.getBoundingClientRect();
    await clickAt(Math.round(r.right - 8), Math.round(r.bottom - 8));
    if (!barDot("5102")) throw new Error("selecting 5102 showed no bar with its dot");
    out.before = { drawn: drawn("5102"), stored: (await stored()).areas["5102"].accent ?? null };

    // its bar's dot: the popover under it, Automatic marked and focused; ↓ → ↓ to Blue, then Enter
    let mark = env.calls.length;
    await click(barDot("5102"), "5102's bar dot");
    out.opened = seen(barDot("5102"));
    const walk: string[] = [];
    for (const key of ["ArrowDown", "ArrowRight", "ArrowDown"]) {
      await press(key);
      walk.push(keyboard());
    }
    out.walk = walk;
    await press("Enter");
    out.picked = { open: !!popover(), updates: updates(mark), stored: (await stored()).areas["5102"].accent ?? null, drawn: drawn("5102"), keyboard: keyboard() };

    // pressed again, then Esc: nothing saved, the keyboard back where it was
    mark = env.calls.length;
    await click(barDot("5102"), "5102's bar dot");
    const again = seen(barDot("5102"));
    await press("Escape");
    out.escaped = { again, open: !!popover(), updates: updates(mark), keyboard: keyboard(), drawn: drawn("5102") };

    // ⋯'s Colour…: over the dot, Blue marked; Automatic clicked
    mark = env.calls.length;
    await click(document.querySelector(`.ls-selbar [data-act="more"]`), "the bar's ⋯");
    await ctxPick("Colour…");
    const fromMenu = seen(barDot("5102"));
    await click(popover()?.querySelector(".ls-colour-auto"), "Automatic");
    const now = (await stored()).areas["5102"];
    out.automatic = { fromMenu, open: !!popover(), updates: updates(mark), hasAccent: Object.hasOwn(now, "accent"), drawn: drawn("5102") };

    // 5110's tree square: a room's area, Red in the fixture; Green clicked
    mark = env.calls.length;
    out.treeBefore = accentOf(treeDot("5110"));
    await click(treeDot("5110"), "5110's tree square");
    const fromTree = seen(treeDot("5110"));
    await click(popover()?.querySelector('[data-accent="7"]'), "Green");
    out.tree = { fromTree, open: !!popover(), updates: updates(mark), stored: (await stored()).areas["5110"].accent ?? null, square: accentOf(treeDot("5110")), area: accentOf(document.querySelector(`.ls-area[data-area="5110"]`)), keyboard: keyboard() };
    // and Esc there: the keyboard back on the square, which a press outside the landscape gives it
    mark = env.calls.length;
    await click(treeDot("5110"), "5110's tree square");
    const treeAgain = seen(treeDot("5110"));
    await press("Escape");
    out.treeEscaped = { again: treeAgain, open: !!popover(), updates: updates(mark), keyboard: keyboard() };
  };

  const b = async () => {
    const dot = headerDot("5101");
    if (!dot) throw new Error("5101's header has no dot at this zoom");
    const mark = env.calls.length;
    await click(dot, "5101's header dot");
    out.opened = seen(headerDot("5101"));
    await press("Escape");
    out.escaped = { open: !!popover(), updates: updates(mark), keyboard: keyboard() };
  };

  env.waitFor(".ls-world .ls-node", () =>
    setTimeout(() => {
      (part === "b" ? b() : a())
        .catch((err: unknown) => {
          out.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
        })
        .finally(write);
    }, 800)
  );
}
