/**
 * ?landscapeStripAudit (with ?wires=fanout&side=closed): W6's pipeline strip over the wires board (wiresAudit.ts),
 * worked as a person would in the UI preview, into <script id="mb-landscape-strip-audit"> for
 * test/uiLandscapeStrip.test.ts. Keys and the mouse are pressed for real (scripts/ui-preview.mjs's pageResult takes
 * them from window.__mbKeys), so they go wherever the browser sends them.
 *
 * Sizes: a workspace with no wires in focus (no strip, its pty the window's), Builder with wires (the strip's 64 px off
 * its rows), and the strip folded and opened again (one sessionResize each, and the pref saved). Keys: ⌥→ typed in
 * Builder's terminal is the terminal's; on focus's frame given the keyboard by code it does nothing; once a press on the
 * strip arms the frame, ⌥→ and ⌥← move along the chain with the keyboard kept on the frame; ⌘⌥→ and ⌘⌥← from inside a
 * terminal move and write nothing to it, nor from a field elsewhere. The +2 list: Docs, a stack's tab behind, brought to
 * the front; Spike, closed, leaving focus for its ghost. A click on a step goes there; nothing that way is said.
 */
import { colsRows } from "../shared/landscape";
import { measuredCell } from "../renderer/cachedTerm";
import { STRIP_FOLDED_PREF } from "../renderer/PipelineStrip";
import { drive } from "./needsYouAudit";

export interface StripAuditEnv {
  calls: { fn: string; args: unknown[] }[];
  waitFor: (selector: string, then: (el: HTMLElement) => void, tries?: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const vp = () => document.querySelector<HTMLElement>(".ls-viewport")!;
const frame = () => document.querySelector<HTMLElement>(".ls-focus");
const inFocus = () => frame()?.querySelector<HTMLElement>(".ls-node")?.dataset.front ?? null;
type Term = import("@xterm/xterm").Terminal;
const term = (id: string) => (window as unknown as { __mbTerms?: Map<string, { term: Term }> }).__mbTerms?.get(id)?.term;
const keyboard = () => {
  const a = document.activeElement;
  if (a === frame()) return "frame";
  const t = a?.closest<HTMLElement>(".ls-node")?.dataset.front;
  if (a?.closest(".xterm")) return `terminal ${t ?? "?"}`;
  return a === document.body ? "page" : (a?.className || a?.tagName || "none");
};
const centre = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
};
async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("nothing to click");
  if (!(await drive([{ mouse: { ...centre(el), clickCount: 1 } }]))) throw new Error("the audit needs the test's Chrome driver to press for real");
  await sleep(250);
}
async function press(key: string, mods: { alt?: boolean; meta?: boolean } = {}): Promise<void> {
  await drive([{ key, ...mods }]);
  await sleep(350);
}

export function runStripAudit(env: StripAuditEnv): void {
  const out: Record<string, unknown> = {};
  const write = () => {
    const el = document.createElement("script");
    el.type = "application/json";
    el.id = "mb-landscape-strip-audit";
    el.textContent = JSON.stringify(out);
    document.body.appendChild(el);
  };
  const resizes = (id: string, from: number) => env.calls.slice(from).filter((c) => c.fn === "sessionResize" && c.args[0] === id).map((c) => `${c.args[1]}×${c.args[2]}`);
  const writes = (id: string) => env.calls.filter((c) => c.fn === "sessionWrite" && c.args[0] === id).length;
  /** The pty size a focused workspace holds under a strip `strip` px tall. */
  const want = (id: string, strip: number) => {
    const c = term(id) && measuredCell(term(id)!);
    if (!c) return `${id} isn't measured`;
    const t = colsRows(vp().clientWidth, vp().clientHeight - strip, c.w, c.h);
    return `${t.cols}×${t.rows}`;
  };
  /** Workspace `id` picked in the area tree (its area opened first) and focused with ⌘E, as a person would. */
  const focusOn = async (id: string) => {
    const row = () => document.querySelector(`.area-tree .lt-ws[data-sid="${CSS.escape(id)}"]`);
    for (const chev of document.querySelectorAll('.area-tree .lt-chev[aria-expanded="false"]:not(.sm)')) {
      if (row()) break;
      await click(chev);
    }
    await click(row());
    await sleep(300);
    await press("e", { meta: true });
    await sleep(300);
  };
  const leave = async () => {
    await press("Escape", { meta: true });
    await sleep(300);
  };

  const B = "wb-builder";
  const R = "wb-reviewer";
  const T = "wb-tester";
  const menuRow = (title: string) => [...document.querySelectorAll<HTMLElement>(".mb-ctx [role=menuitem]")].find((b) => b.querySelector(".mb-ctx-t")?.textContent === title);
  /** A press on the strip's bare right end (no step, chip or button there): it arms focus's frame. */
  const pressStrip = async () => {
    const r = document.querySelector(".ls-strip")!.getBoundingClientRect();
    await drive([{ mouse: { x: Math.round(r.right - 12), y: Math.round(r.top + r.height / 2), clickCount: 1 } }]);
    await sleep(250);
  };

  env.waitFor(`.ls-world [data-front="${B}"]`, async () => {
    try {
      await sleep(800);
      // a workspace with no wires: no strip, and it fills the window
      let mark = env.calls.length;
      await focusOn("s1");
      out.noWires = { focused: inFocus(), strip: !!document.querySelector(".ls-strip"), sent: resizes("s1", mark).at(-1) ?? null, want: want("s1", 0) };
      await leave();

      // Builder, wired: the strip over it, its 64 px off the pty's rows
      mark = env.calls.length;
      await focusOn(B);
      const strip = () => document.querySelector<HTMLElement>(".ls-strip");
      const top = () => Math.round((frame()?.querySelector(".ls-node")?.getBoundingClientRect().top ?? 0) - vp().getBoundingClientRect().top);
      out.wired = { focused: inFocus(), strip: strip()?.offsetHeight ?? null, nodeTop: top(), sent: resizes(B, mark).at(-1) ?? null, want: want(B, 64), keyboard: keyboard() };
      out.steps = [...document.querySelectorAll<HTMLElement>(".ls-strip .ls-step")].map((el) => `${el.dataset.step}: ${el.querySelector(".ls-step-n")?.textContent}`);
      out.arrows = [...document.querySelectorAll<HTMLElement>(".ls-strip .ls-strip-arrow")].map((el) => `${el.dataset.wire}: ${[...el.classList].find((c) => c !== "ls-strip-arrow")}`);
      out.attached = [...document.querySelectorAll<HTMLElement>(".ls-strip .ls-attach")].map((el) => el.dataset.step);

      // folded and opened again: one resize each, and the fold remembered
      const pref = () => localStorage.getItem(STRIP_FOLDED_PREF);
      mark = env.calls.length;
      await click(document.querySelector(".ls-strip-toggle"));
      await sleep(300);
      out.fold = { strip: strip()?.offsetHeight ?? null, nodeTop: top(), sent: resizes(B, mark), want: want(B, 28), pref: pref() };
      mark = env.calls.length;
      await click(document.querySelector(".ls-strip-toggle"));
      await sleep(300);
      out.unfold = { strip: strip()?.offsetHeight ?? null, sent: resizes(B, mark), want: want(B, 64), pref: pref() };

      // ⌥→ typed in Builder's terminal is the terminal's
      let w1 = writes(B);
      await click(frame()?.querySelector(".xterm"));
      const typingIn = keyboard();
      await press("ArrowRight", { alt: true });
      out.inTerminal = { keyboard: typingIn, focused: inFocus(), wrote: writes(B) - w1 };

      // focus's frame given the keyboard by code: disarmed, so ⌥→ does nothing
      frame()!.focus();
      w1 = writes(B);
      await press("ArrowRight", { alt: true });
      out.byCode = { keyboard: keyboard(), focused: inFocus(), wrote: writes(B) - w1 };

      // a press on the strip arms the frame: ⌥→ and ⌥← move along the chain, the keyboard kept on the frame
      await pressStrip();
      const pressed = keyboard();
      await press("ArrowRight", { alt: true });
      out.altRight = { pressed, focused: inFocus(), keyboard: keyboard() };
      await press("ArrowLeft", { alt: true });
      out.altLeft = { focused: inFocus(), keyboard: keyboard(), wrote: writes(B) - w1 };

      // ⌘⌥ from inside a terminal: moves, and nothing reaches the terminal
      await click(frame()?.querySelector(".xterm"));
      const before = keyboard();
      w1 = writes(B);
      await press("ArrowRight", { alt: true, meta: true });
      await sleep(300);
      out.cmdRight = { before, focused: inFocus(), keyboard: keyboard(), wrote: writes(B) - w1 };
      await click(frame()?.querySelector(".xterm"));
      const wr = writes(R);
      await press("ArrowLeft", { alt: true, meta: true });
      await sleep(200);
      out.cmdLeft = { focused: inFocus(), keyboard: keyboard(), wrote: writes(R) - wr };

      // the +2 list: Docs, a stack's tab behind Fixtures, comes to the front in focus with the keyboard on the frame,
      // armed (⌥← goes back); Spike, closed, leaves focus for its ghost
      await click(document.querySelector(".ls-strip-more"));
      out.more = [...document.querySelectorAll<HTMLElement>(".mb-ctx .mb-ctx-h, .mb-ctx [role=menuitem]")].map((el) => (el.matches(".mb-ctx-h") ? `# ${el.textContent}` : `${el.querySelector(".mb-ctx-t")?.textContent} · ${el.querySelector(".mb-ctx-k")?.textContent}`));
      await click(menuRow("Docs"));
      await sleep(400);
      const toDocs = { focused: inFocus(), keyboard: keyboard() };
      await press("ArrowLeft", { alt: true });
      out.stackTab = { ...toDocs, back: inFocus() };
      await click(document.querySelector(".ls-strip-more"));
      await click(menuRow("Spike: streaming"));
      await sleep(600);
      out.ghost = { focused: inFocus(), keyboard: keyboard() };

      // a click on a step goes there, its terminal taking the keyboard
      await focusOn(B);
      // scrolled into the strip's view first, as a person would with the side bar narrowing it
      const step = document.querySelector<HTMLElement>(`.ls-strip .ls-step[data-step="${T}"]`);
      const chainEl = document.querySelector<HTMLElement>(".ls-strip-chain");
      if (step && chainEl) chainEl.scrollLeft += Math.max(0, step.getBoundingClientRect().right - chainEl.getBoundingClientRect().right + 8);
      await sleep(100);
      await click(step);
      await sleep(300);
      out.clicked = { focused: inFocus(), keyboard: keyboard() };

      // ⌘⌥ from a field elsewhere in the window: the field's, never a move
      const field = document.createElement("input");
      field.className = "strip-audit-field";
      Object.assign(field.style, { position: "fixed", left: "8px", bottom: "8px", width: "120px", zIndex: "99" });
      document.body.appendChild(field);
      await click(field);
      await press("ArrowLeft", { alt: true, meta: true });
      out.inField = { focused: inFocus(), keyboard: keyboard() };
      field.remove();

      // nothing that way: said in the landscape's note, drawn over focus
      await pressStrip();
      const back: (string | null)[] = [];
      for (let i = 0; i < 4; i++) {
        await press("ArrowLeft", { alt: true });
        back.push(inFocus());
      }
      // the note takes no pointer, so it's over focus when it stacks above the frame
      const note = document.querySelector<HTMLElement>(".ls-note");
      const z = (el: Element | null) => Number(el ? getComputedStyle(el).zIndex : NaN);
      out.nothingBack = { back, note: note?.textContent ?? null, overFocus: z(note) > z(frame()) };
    } catch (err) {
      out.error = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    }
    write();
  });
}
