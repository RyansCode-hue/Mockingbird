/**
 * ?landscapeStripAudit (with ?wires=fanout): W6's pipeline strip over the wires board (wiresAudit.ts), worked as a person
 * would in the UI preview, into <script id="mb-landscape-strip-audit"> for test/uiLandscapeStrip.test.ts. Keys and the
 * mouse are pressed for real (scripts/ui-preview.mjs's pageResult takes them from window.__mbKeys), so they go wherever
 * the browser sends them.
 *
 * Sizes: a workspace with no wires in focus (no strip, its pty the window's, and an arrow there says so), Builder with
 * wires (the strip's 64 px off its rows, both its neighbours in view), and the strip folded and opened again (one
 * sessionResize each, and the pref saved). Keys: ⌥→ typed in Builder's terminal is the terminal's; on focus's frame
 * given the keyboard by code it does nothing; once a press on the strip arms the frame, ⌥→ and ⌥← move along the chain
 * with the keyboard kept on the frame; ⌘⌥→ and ⌘⌥← from inside a terminal move and write nothing to it, nor from a field
 * elsewhere; held, ⌘⌥→ moves once. Clicks: one on a step just shown, or straight after a move, is let go; a double click
 * on Reviewer goes to Reviewer, never the step that takes its place; a step whose terminal can't take the keyboard leaves
 * it on the frame. The +2 list: Docs, a stack's tab behind, brought to the front; Spike, closed, leaving focus for its
 * ghost. A click on a step goes there; nothing that way is said.
 */
import { colsRows } from "../shared/landscape";
import { measuredCell } from "../renderer/cachedTerm";
import { STRIP_FOLDED_PREF } from "../renderer/PipelineStrip";
import { ANSWER_SETTLE_MS } from "../renderer/answerGuard";
import { drive } from "./needsYouAudit";

export interface StripAuditEnv {
  calls: { fn: string; args: unknown[] }[];
  waitFor: (selector: string, then: (el: HTMLElement) => void, tries?: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Long enough for whatever moved on the strip to have settled, so a click there counts. */
const settle = () => sleep(ANSWER_SETTLE_MS + 100);
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
const stepOf = (id: string) => document.querySelector<HTMLButtonElement>(`.ls-strip .ls-step[data-step="${CSS.escape(id)}"]`);
/** How wide the chain's fades are (styles.css): a step under one isn't wholly in view. */
const FADE = 28;
/** Of `ids`, the steps wholly in the chain's view, clear of its fades. */
const inView = (...ids: string[]) =>
  ids.filter((id) => {
    const c = document.querySelector<HTMLElement>(".ls-strip-chain");
    const s = stepOf(id);
    if (!c || !s) return false;
    const box = c.getBoundingClientRect();
    const r = s.getBoundingClientRect();
    return r.left >= box.left + (c.classList.contains("more-l") ? FADE : 0) - 1 && r.right <= box.right - (c.classList.contains("more-r") ? FADE : 0) + 1;
  });
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
  /** Workspace `id` picked in the area tree (its area opened first), as a person would. */
  const pickInTree = async (id: string) => {
    const row = () => document.querySelector(`.area-tree .lt-ws[data-sid="${CSS.escape(id)}"]`);
    for (const chev of document.querySelectorAll('.area-tree .lt-chev[aria-expanded="false"]:not(.sm)')) {
      if (row()) break;
      await click(chev);
    }
    await click(row());
    await sleep(300);
  };
  /** Workspace `id` picked and focused with ⌘E. */
  const focusOn = async (id: string) => {
    await pickInTree(id);
    await press("e", { meta: true });
    await sleep(300);
  };
  const leave = async () => {
    await press("Escape", { meta: true });
    await sleep(300);
  };
  const note = () => document.querySelector<HTMLElement>(".ls-note")?.textContent ?? null;

  const B = "wb-builder";
  const R = "wb-reviewer";
  const T = "wb-tester";
  const S = "wb-shape";
  const menuRow = (title: string) => [...document.querySelectorAll<HTMLElement>(".mb-ctx [role=menuitem]")].find((b) => b.querySelector(".mb-ctx-t")?.textContent === title);
  /** A press on the strip's bare right end (no step, chip or button there): it arms focus's frame. */
  const pressStrip = async () => {
    const r = document.querySelector(".ls-strip")!.getBoundingClientRect();
    await drive([{ mouse: { x: Math.round(r.right - 12), y: Math.round(r.top + r.height / 2), clickCount: 1 } }]);
    await sleep(250);
  };

  /**
   * A group of cases, each group starting in Builder's focus with its terminal typed in: one that goes wrong records
   * what went wrong under its name and the next still runs, so a broken case can't hide the ones after it.
   */
  const errors: string[] = [];
  const group = async (name: string, cases: () => Promise<void>, fromBuilder = true) => {
    try {
      if (fromBuilder) {
        await leave();
        await focusOn(B);
      }
      await cases();
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? `${err.message}\n${err.stack}` : String(err)}`);
    }
  };

  env.waitFor(`.ls-world [data-front="${B}"]`, async () => {
    await sleep(800);
    await group(
      "sizes and keys",
      async () => {
        // a workspace with no wires: no strip, and it fills the window; an arrow there says there's nothing to move along
        let mark = env.calls.length;
        await focusOn("s1");
        out.noWires = { focused: inFocus(), strip: !!document.querySelector(".ls-strip"), sent: resizes("s1", mark).at(-1) ?? null, want: want("s1", 0) };
        let w1 = writes("s1");
        const typingIn = keyboard();
        await press("ArrowRight", { alt: true, meta: true });
        out.noWiresKey = { keyboard: typingIn, focused: inFocus(), note: note(), wrote: writes("s1") - w1 };
        await leave();

        // Builder, wired: the strip over it, its 64 px off the pty's rows, both its neighbours wholly in view
        mark = env.calls.length;
        await focusOn(B);
        const strip = () => document.querySelector<HTMLElement>(".ls-strip");
        const top = () => Math.round((frame()?.querySelector(".ls-node")?.getBoundingClientRect().top ?? 0) - vp().getBoundingClientRect().top);
        out.wired = { focused: inFocus(), strip: strip()?.offsetHeight ?? null, nodeTop: top(), sent: resizes(B, mark).at(-1) ?? null, want: want(B, 64), keyboard: keyboard() };
        out.steps = [...document.querySelectorAll<HTMLElement>(".ls-strip .ls-step")].map((el) => `${el.dataset.step}: ${el.querySelector(".ls-step-n")?.textContent}`);
        out.arrows = [...document.querySelectorAll<HTMLElement>(".ls-strip .ls-strip-arrow")].map((el) => `${el.dataset.wire}: ${[...el.classList].find((c) => c !== "ls-strip-arrow")}`);
        out.attached = [...document.querySelectorAll<HTMLElement>(".ls-strip .ls-attach")].map((el) => el.dataset.step);
        out.inView = inView(S, B, R);

        // a click on a step the strip has only just shown is let go, its button off a moment: aimed before it was there
        const atR = centre(stepOf(R)!);
        await leave();
        await drive([{ key: "e", meta: true }, { pause: 100 }, { mouse: { ...atR, clickCount: 1 } }]);
        out.fresh = { focused: inFocus(), heldOff: !!stepOf(R)?.disabled };
        await settle();

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
        w1 = writes(B);
        await click(frame()?.querySelector(".xterm"));
        const inTerm = keyboard();
        await press("ArrowRight", { alt: true });
        out.inTerminal = { keyboard: inTerm, focused: inFocus(), wrote: writes(B) - w1 };

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
        out.inViewOn = inView(B, R, T);
        await press("ArrowLeft", { alt: true });
        out.altLeft = { focused: inFocus(), keyboard: keyboard(), wrote: writes(B) - w1 };

        // a click straight after a move is let go, even on what stayed put going to the same place: Pathways, attached to
        // Builder and to Reviewer both, at the strip's right end
        const pathways = () => document.querySelector<HTMLButtonElement>('.ls-strip .ls-attach[data-step="s5"]');
        const pathwaysAt = pathways()?.getBoundingClientRect().left;
        await drive([{ key: "ArrowRight", alt: true }, { pause: 120 }, { mouse: { ...centre(pathways()!), clickCount: 1 } }]);
        out.soonAfter = { focused: inFocus(), stayed: pathways()?.getBoundingClientRect().left === pathwaysAt, heldOff: !!pathways()?.disabled, keyboard: keyboard() };
        await settle();
        await press("ArrowLeft", { alt: true });

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

        // ⌘⌥→ held from Builder's terminal: one move, its repeats swallowed, so y goes to Reviewer's terminal, not Tester's
        await sleep(300);
        const toR = writes(R);
        const toT = writes(T);
        const held = { key: "ArrowRight", alt: true, meta: true, hold: "down" as const };
        await drive([held, { pause: 80 }, { ...held, repeat: true }, { pause: 80 }, { ...held, repeat: true }, { pause: 80 }, { ...held, repeat: true }, { pause: 80 }, { ...held, hold: "up" }]);
        await sleep(400);
        const heldKeys = { focused: inFocus(), keyboard: keyboard() };
        await press("y");
        out.held = { ...heldKeys, toReviewer: writes(R) - toR, toTester: writes(T) - toT };
        await press("ArrowLeft", { alt: true, meta: true });
        await sleep(200);

        // a step whose terminal can't take the keyboard: the keyboard goes to the frame, never stays with Builder's, gone
        // from sight under focus
        await click(frame()?.querySelector(".xterm"));
        await settle();
        const reviewer = term(R) as (Term & { focus: () => void }) | undefined;
        if (!reviewer) throw new Error("Reviewer has no terminal");
        reviewer.focus = () => {};
        try {
          await click(stepOf(R));
          await sleep(300);
          out.noTerm = { focused: inFocus(), keyboard: keyboard() };
        } finally {
          // its own focus again, the prototype's
          delete (reviewer as Partial<typeof reviewer>).focus;
        }
      },
      false
    );

    await group("the +2 list", async () => {
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
    });

    await group("a double click", async () => {
      // a double click on Reviewer from Builder's terminal goes to Reviewer, and y with it: aimed where Tester's step
      // comes to be once the chain is laid out around Reviewer, its second click lands on Tester, and is let go
      await press("ArrowRight", { alt: true, meta: true });
      const testerThere = stepOf(T)!.getBoundingClientRect();
      await press("ArrowLeft", { alt: true, meta: true });
      await settle();
      const reviewerHere = stepOf(R)!.getBoundingClientRect();
      const [l, r] = [Math.max(testerThere.left, reviewerHere.left), Math.min(testerThere.right, reviewerHere.right)];
      if (r - l < 4) throw new Error(`no point of Reviewer's step that Tester's comes under: ${JSON.stringify({ reviewerHere, testerThere })}`);
      const toR = writes(R);
      const toT = writes(T);
      const atReviewer = { x: Math.round((l + r) / 2), y: Math.round(reviewerHere.top + reviewerHere.height / 2) };
      await drive([{ mouse: { ...atReviewer, clickCount: 1 } }, { pause: 60 }, { mouse: { ...atReviewer, clickCount: 2 } }]);
      await sleep(400);
      const dblKeys = { focused: inFocus(), keyboard: keyboard(), under: document.elementFromPoint(atReviewer.x, atReviewer.y)?.closest<HTMLElement>(".ls-step")?.dataset.step ?? null };
      await press("y");
      out.dbl = { ...dblKeys, toReviewer: writes(R) - toR, toTester: writes(T) - toT };
    });

    await group("clicks and the ends", async () => {
      // a click on a step goes there, its terminal taking the keyboard: Tester's, scrolled into the strip's view first,
      // as a person would with the side bar narrowing it, and let settle there
      const step = stepOf(T);
      const chainEl = document.querySelector<HTMLElement>(".ls-strip-chain");
      if (step && chainEl) chainEl.scrollLeft += Math.max(0, step.getBoundingClientRect().right - chainEl.getBoundingClientRect().right + FADE + 8);
      await settle();
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
      const z = (el: Element | null) => Number(el ? getComputedStyle(el).zIndex : NaN);
      out.nothingBack = { back, note: note(), overFocus: z(document.querySelector(".ls-note")) > z(frame()) };
    });
    if (errors.length) out.error = errors.join("\n\n");
    write();
  });
}
