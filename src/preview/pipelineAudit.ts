/**
 * Editing a laid-out pipeline on the canvas in the UI preview (PipelineEdit.tsx). `?landscapePipelineAudit=<part>` (with
 * `?lsWires&lsPlan=pipeline&lsLaid&lsModels`, laidPipeline's Orchestrator and its four not-started steps) works it with
 * the page's own events and reports into <script id="mb-landscape-pipeline-audit"> for test/uiPipelineEdit.test.ts:
 * - =chip: a step's model chip picks a model at once; the running Orchestrator's asks, restarting in place;
 * - =edit: Edit… from a step's menu, and Enter on the step itself, saving its name and prompt;
 * - =relayout: Re-lay out pipeline from the Orchestrator's menu puts it in stage columns, and Undo puts it back;
 * - =insert: the + between two stage columns, its dialog prefilled from the step before, inserting and laying out again;
 * - =repoint: a wire's Settings, its To picker moving it, and Undo moving it back;
 * - =shot, =chipshot, =editshot: laid out again, with a step's model popover open, or a step's Edit dialog, for --shot.
 */

interface Env {
  calls: { fn: string; args: unknown[] }[];
  waitFor: (selector: string, then: (el: HTMLElement) => void, tries?: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const menuRow = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".mb-ctx:not(.mb-ghost) button")].find((b) => b.querySelector(".mb-ctx-t")?.textContent === label) ?? null;
const menuLabels = () => [...document.querySelectorAll(".mb-ctx:not(.mb-ghost) button .mb-ctx-t")].map((t) => t.textContent);
const ghost = (id: string) => document.querySelector<HTMLElement>(`.ls-ghost[data-front="${CSS.escape(id)}"]`);
const node = (id: string) => document.querySelector<HTMLElement>(`.ls-node[data-ws="${CSS.escape(id)}"]`);
const noteNow = () => document.querySelector<HTMLElement>(".ls-note")?.firstChild?.textContent ?? null;
const box = (el: Element | null) => {
  const r = el?.getBoundingClientRect();
  return r ? { x: Math.round(r.left), y: Math.round(r.top) } : null;
};
async function until<T>(read: () => T | null | undefined | false, what: string, tries = 40): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = read();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`waited for ${what}`);
}
/** Set an input's or a textarea's value as typing does, for React to hear. */
function typeIn(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
const since = (env: Env, mark: number, fn: string) => env.calls.slice(mark).filter((c) => c.fn === fn).map((c) => c.args);
/** The pipeline's cards on screen, by session id. */
const places = () => Object.fromEntries(["pp-orch", "pp-c1", "pp-c2", "pp-v1", "pp-v2"].map((id) => [id, box(id === "pp-orch" ? node(id) : ghost(id))]));
async function relayout(): Promise<void> {
  node("pp-orch")!.querySelector<HTMLElement>(".ls-more")!.click();
  await until(() => menuRow("Re-lay out pipeline"), "Re-lay out pipeline in the Orchestrator's menu").then((b) => b.click());
  await sleep(700);
}
const links = async (): Promise<Record<string, { from: string; to: string; type: string; template?: string }>> => ((await (window as any).mb.wiresGet()) as any).book.links;

async function chipAudit(env: Env, out: Record<string, unknown>): Promise<void> {
  const chip = await until(() => document.querySelector<HTMLElement>('[data-model="pp-c1"]'), "c1's model chip");
  out.stepChip = chip.textContent;
  chip.click();
  const pop = await until(() => document.querySelector<HTMLElement>(".mp-pop"), "the model popover");
  out.stepRows = [...pop.querySelectorAll(".mp-row .mp-name")].map((e) => e.textContent);
  out.stepNote = pop.querySelector(".mp-note")?.textContent ?? null;
  out.stepRestart = !!pop.querySelector('[data-act="restart"]');
  const mark = env.calls.length;
  pop.querySelector<HTMLElement>('[data-pick="gpt-5.1-codex-mini"]')!.click();
  await sleep(500);
  out.stepCalls = since(env, mark, "setModel");
  out.stepOpen = !!document.querySelector(".mp-pop");
  out.stepChipAfter = document.querySelector('[data-model="pp-c1"]')?.textContent ?? null;
  // the running Orchestrator: it asks, with Restart, as restarting stops what it's doing
  document.querySelector<HTMLElement>('[data-model="pp-orch"]')!.click();
  const run = await until(() => document.querySelector<HTMLElement>(".mp-pop"), "the Orchestrator's model popover");
  out.runNote = run.querySelector(".mp-note")?.textContent ?? null;
  const restart = () => run.querySelector<HTMLButtonElement>('[data-act="restart"]');
  out.runOffFirst = restart()?.disabled ?? null;
  const mark2 = env.calls.length;
  run.querySelector<HTMLElement>('[data-pick="opus"]')!.click();
  await sleep(200);
  out.runCallsBefore = since(env, mark2, "setModel").length;
  out.runOffAfterPick = restart()?.disabled ?? null;
  restart()!.click();
  await sleep(500);
  out.runCalls = since(env, mark2, "setModel");
  out.note = noteNow();
}

async function editAudit(env: Env, out: Record<string, unknown>): Promise<void> {
  const card = await until(() => ghost("pp-v1"), "Verifier 5115's card");
  card.querySelector<HTMLElement>(".ls-more")!.click();
  await until(() => menuRow("Edit…"), "Edit… in its menu");
  out.menu = menuLabels();
  menuRow("Edit…")!.click();
  const dlg = await until(() => document.querySelector<HTMLElement>(".se-dlg"), "the Edit dialog");
  out.heading = dlg.querySelector("h3")?.textContent ?? null;
  const name = dlg.querySelector<HTMLInputElement>('input[aria-label="Its name"]')!;
  out.nameWas = name.value;
  out.promptWas = dlg.querySelector<HTMLTextAreaElement>("textarea")!.value;
  typeIn(name, "Verifier 5115 – API keys");
  typeIn(dlg.querySelector<HTMLTextAreaElement>("textarea")!, "Check the keys work against staging.");
  await sleep(100);
  const mark = env.calls.length;
  dlg.querySelector<HTMLElement>('[data-act="save"]')!.click();
  await sleep(600);
  out.calls = since(env, mark, "editStep");
  out.closed = !document.querySelector(".se-dlg");
  out.title = ghost("pp-v1")?.querySelector(".lg-title")?.textContent ?? null;
  // the step takes the keyboard, and Enter edits it
  const c2 = ghost("pp-c2")!;
  c2.focus();
  out.focusable = document.activeElement === c2;
  c2.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await sleep(300);
  out.enterHeading = document.querySelector(".se-dlg h3")?.textContent ?? null;
}

async function relayoutAudit(_env: Env, out: Record<string, unknown>): Promise<void> {
  await until(() => node("pp-orch"), "the Orchestrator");
  out.before = places();
  await relayout();
  out.after = places();
  out.note = noteNow();
  out.gaps = document.querySelectorAll(".ls-insert").length;
  out.captions = [...document.querySelectorAll(".ls-stage")].map((c) => c.textContent);
  const undo = [...document.querySelectorAll<HTMLButtonElement>(".ls-note-act")].find((b) => b.textContent === "Undo");
  undo?.click();
  await sleep(700);
  out.undone = places();
}

async function insertAudit(env: Env, out: Record<string, unknown>): Promise<void> {
  await until(() => node("pp-orch"), "the Orchestrator");
  await relayout();
  const all = await links();
  const c1v1 = Object.entries(all).find(([, w]) => w.from === "pp-c1" && w.to === "pp-v1" && w.type === "handoff")![0];
  const plus = await until(() => document.querySelector<HTMLElement>(`.ls-insert[data-gap="${c1v1}"]`), "the + between Coder 5115 and Verifier 5115");
  out.label = plus.getAttribute("aria-label");
  plus.click();
  const dlg = await until(() => document.querySelector<HTMLElement>(".se-dlg"), "the insert dialog");
  out.heading = dlg.querySelector("h3")?.textContent ?? null;
  out.prefill = [...dlg.querySelectorAll(".se-runs .mb-select-val")].map((v) => v.textContent);
  typeIn(dlg.querySelector<HTMLInputElement>('input[aria-label="Its name"]')!, "Reviewer 5115");
  await sleep(100);
  const mark = env.calls.length;
  dlg.querySelector<HTMLElement>('[data-act="save"]')!.click();
  await sleep(1500);
  out.calls = since(env, mark, "insertStep");
  const made = [...document.querySelectorAll<HTMLElement>(".ls-ghost")].find((g) => g.querySelector(".lg-title")?.textContent === "Reviewer 5115");
  out.drawn = !!made;
  const id = made?.dataset.front ?? "";
  const now = await links();
  out.wireIntoB = now[c1v1] ? { from: now[c1v1].from === id ? "new" : now[c1v1].from, to: now[c1v1].to } : null;
  out.intoNew = Object.values(now).filter((w) => w.to === id).map((w) => w.from);
  out.note = noteNow();
  const at = (el: Element | null) => box(el)?.x ?? null;
  out.columns = { c1: at(ghost("pp-c1")), made: at(made ?? null), v1: at(ghost("pp-v1")) };
}

async function repointAudit(env: Env, out: Record<string, unknown>): Promise<void> {
  await until(() => node("pp-orch"), "the Orchestrator");
  await relayout();
  const all = await links();
  const id = Object.entries(all).find(([, w]) => w.from === "pp-orch" && w.to === "pp-c1")![0];
  const p = await until(() => document.querySelector<SVGPathElement>(`.ls-wires g[data-wire="${CSS.escape(id)}"] path.line`), "Orchestrator → Coder 5115 drawn");
  const q = p.getPointAtLength(p.getTotalLength() / 2).matrixTransform(p.getScreenCTM()!);
  document.querySelector(".ls-viewport")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: q.x, clientY: q.y, button: 2 }));
  await until(() => menuRow("Settings…"), "the wire's Settings…").then((b) => b.click());
  const form = await until(() => document.querySelector<HTMLElement>(".wr-endpick"), "its From and To pickers", 60);
  out.ends = [...form.querySelectorAll(".mb-select-val")].map((v) => v.textContent);
  // the form lets go of clicks for a moment after it opens
  await sleep(700);
  form.querySelectorAll<HTMLElement>(".mb-select")[1].click();
  const list = await until(() => document.querySelector<HTMLElement>(".mb-listbox"), "the To picker's list");
  const opts = [...list.querySelectorAll<HTMLElement>(".mb-opt")];
  out.toOptions = opts.map((o) => ({ label: o.querySelector(".mb-opt-label")?.textContent?.replace("✓", "") ?? null, off: o.classList.contains("disabled") }));
  const mark = env.calls.length;
  opts.find((o) => o.querySelector(".mb-opt-label")?.textContent?.endsWith("Verifier 5115"))!.click();
  await sleep(600);
  out.calls = since(env, mark, "wiresRepoint");
  out.after = (await links())[id];
  out.note = noteNow();
  const undo = [...document.querySelectorAll<HTMLButtonElement>(".ls-note-act")].find((b) => b.textContent === "Undo");
  undo?.click();
  await sleep(500);
  out.undone = (await links())[id];
  out.undoCalls = since(env, mark, "wiresUnrepoint").length;
}

export function runPipelineAudit(env: Env, part: string): void {
  const report = (out: unknown) => {
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-landscape-pipeline-audit";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  };
  env.waitFor(".ls-world .ls-ghost.planned", async () => {
    const out: Record<string, unknown> = { part };
    try {
      await sleep(1200);
      if (part === "chip") await chipAudit(env, out);
      else if (part === "edit") await editAudit(env, out);
      else if (part === "relayout") await relayoutAudit(env, out);
      else if (part === "insert") await insertAudit(env, out);
      else if (part === "repoint") await repointAudit(env, out);
      else if (part === "shot") await relayout();
      else if (part === "chipshot") {
        document.querySelector<HTMLElement>('[data-model="pp-v1"]')?.click();
      } else if (part === "editshot") {
        ghost("pp-c1")?.focus();
        ghost("pp-c1")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      }
      else throw new Error(`there's no part ${part}`);
    } catch (err) {
      out.error = err instanceof Error ? err.message : String(err);
    }
    report(out);
  });
}
