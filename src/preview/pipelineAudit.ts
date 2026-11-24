/**
 * Editing a laid-out pipeline on the canvas in the UI preview (PipelineEdit.tsx). `?landscapePipelineAudit=<part>` (with
 * `?lsWires&lsPlan=pipeline&lsLaid&lsModels`, laidPipeline's Orchestrator and its four not-started steps) works it with
 * the page's own events and reports into <script id="mb-landscape-pipeline-audit"> for test/uiPipelineEdit.test.ts:
 * - =chip: a step's model chip picks a model at once; the running Orchestrator's asks, restarting in place;
 * - =edit: Edit… from a step's menu, and Enter on the step itself, saving its name and prompt;
 * - =relayout: Re-lay out pipeline from the Orchestrator's menu puts it in stage columns, and Undo puts it back;
 * - =insert: the + between two stage columns, its dialog prefilled from the step before, inserting and laying out again;
 * - =repoint: a wire's Settings, its To picker moving it, and Undo moving it back;
 * - =drag: not-started steps and the wires board's closed Spike dragged as workspaces are, within their area and into
 *   another (their groups following), one of two steps selected dragged alone, and a click on the closed one;
 * - =shot, =chipshot, =editshot, =dragshot: laid out again, with a step's model popover open, a step's Edit dialog, or
 *   Coder 5115 and Spike dragged (=drag's first and third drags), for --shot.
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

type Pt = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };
/** Pointer events as a mouse makes them (Landscape.tsx takes the press on the viewport, the moves and release on the window). */
const POINTER = 7;
const pointer = (type: string, at: Pt, buttons: number, shiftKey = false) =>
  new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: POINTER, button: 0, buttons, clientX: at.x, clientY: at.y, shiftKey });
/** Where a card is grabbed: its title's start, clear of its buttons, its model chip and its wire handle. */
const grip = (card: HTMLElement): { el: HTMLElement; at: Pt } => {
  const el = card.querySelector<HTMLElement>(".lg-title") ?? card;
  const r = el.getBoundingClientRect();
  return { el, at: { x: r.left + Math.min(r.width / 2, 20), y: r.top + r.height / 2 } };
};
/** A card pressed at its title and let go there (Shift: a Shift-click). */
function clickCard(card: HTMLElement, shiftKey = false): void {
  const g = grip(card);
  g.el.dispatchEvent(pointer("pointerdown", g.at, 1, shiftKey));
  window.dispatchEvent(pointer("pointerup", g.at, 0, shiftKey));
}
/** A card pressed at its title, moved by (dx, dy) screen px in steps, and let go; `settle` ms for its drop to be saved. */
async function dragCard(card: HTMLElement, dx: number, dy: number, settle = 800): Promise<void> {
  const g = grip(card);
  g.el.dispatchEvent(pointer("pointerdown", g.at, 1));
  for (let i = 1; i <= 6; i++) {
    window.dispatchEvent(pointer("pointermove", { x: g.at.x + (dx * i) / 6, y: g.at.y + (dy * i) / 6 }, 1));
    await sleep(16);
  }
  window.dispatchEvent(pointer("pointerup", { x: g.at.x + dx, y: g.at.y + dy }, 0));
  await sleep(settle);
}
type Stored = { workspaces: Record<string, Box>; areas: Record<string, Box> };
const stored = async (): Promise<Stored> => ((await (window as any).mb.landscapeGet()) as { landscape: Stored }).landscape;
const within = (r: Box, a: Box) => r.x >= a.x && r.y >= a.y && r.x + r.w <= a.x + a.w && r.y + r.h <= a.y + a.h;
/** The screen px a landscape px is now, read off area `key`'s frame. */
const zoomOf = (key: string, areas: Record<string, Box>) => document.querySelector(`.ls-area[data-area="${CSS.escape(key)}"]`)!.getBoundingClientRect().width / areas[key].w;
/** How far, in screen px, wire `id`'s arrowhead ends from `card` as drawn (0: on it); null when either isn't drawn. */
function endOff(id: string, card: HTMLElement | null): number | null {
  const p = document.querySelector<SVGPathElement>(`.ls-wires g[data-wire="${CSS.escape(id)}"] path.line`);
  if (!p || !card) return null;
  const e = p.getPointAtLength(p.getTotalLength()).matrixTransform(p.getScreenCTM()!);
  const r = card.getBoundingClientRect();
  return Math.round(Math.hypot(Math.max(r.left - e.x, 0, e.x - r.right), Math.max(r.top - e.y, 0, e.y - r.bottom)));
}
const selectedSteps = () => [...document.querySelectorAll<HTMLElement>(".ls-ghost.planned.selected")].map((g) => g.dataset.front);
async function fit(): Promise<void> {
  [...document.querySelectorAll<HTMLElement>(".ls-hud-btn")].find((b) => b.textContent === "Fit")!.click();
  await sleep(400);
}

/**
 * Drags (=drag; =dragshot the first and third, briefly), everything in view: Coder 5115 into the free cell above the
 * Orchestrator; one of two steps selected into the cell Coder 5115 left; Spike from 5120 into 5115; Verifier 5115 from
 * 5115 into 5120; then a click on Spike. Each reports the places stored before and after, the calls it made and the
 * cards as drawn.
 */
async function dragAudit(env: Env, out: Record<string, unknown>, brief = false): Promise<void> {
  await fit();
  const before = await stored();
  const area = ghost("pp-c1")!.dataset.area!;
  const at = (id: string) => before.workspaces[id];
  const z = zoomOf(area, before.areas);
  const record = (id: string, now: Stored) => ({ before: at(id), after: now.workspaces[id] });
  const book = await links();
  const wireTo = (to: string) => Object.entries(book).find(([, w]) => w.to === to)?.[0] ?? "";
  const by = (id: string, to: Pt) => [(to.x - at(id).x) * z, (to.y - at(id).y) * z] as const;

  // a step within its area, into the free cell above the Orchestrator
  let mark = env.calls.length;
  const free = { x: at("pp-orch").x, y: at("pp-c1").y };
  await dragCard(ghost("pp-c1")!, ...by("pp-c1", free), brief ? 300 : 800);
  let now = await stored();
  out.step = { area, free, ...record("pp-c1", now), setGroup: since(env, mark, "setGroup"), saves: since(env, mark, "landscapeUpdate").length, translate: ghost("pp-c1")?.style.translate ?? null, wire: endOff(wireTo("pp-c1"), ghost("pp-c1")) };

  if (!brief) {
    // two steps selected (a click, a Shift-click); the one pressed is dragged, alone, into the cell Coder 5115 left
    clickCard(ghost("pp-c2")!);
    await sleep(150);
    clickCard(ghost("pp-v2")!, true);
    await sleep(250);
    const picked = selectedSteps();
    mark = env.calls.length;
    await dragCard(ghost("pp-v2")!, ...by("pp-v2", at("pp-c1")));
    now = await stored();
    out.several = { picked, v2: record("pp-v2", now), c2: record("pp-c2", now), selected: selectedSteps(), setGroup: since(env, mark, "setGroup") };
  }

  // the closed Spike from 5120 into 5115, where Verifier 5115 left (brief: where Coder 5115 left): its group follows
  mark = env.calls.length;
  const into = brief ? at("pp-c1") : at("pp-v2");
  await dragCard(ghost("wb-spike")!, ...by("wb-spike", into), brief ? 300 : 800);
  now = await stored();
  const spike = ((await (window as any).mb.resumableSessions()) as { id: string; taskGroup: string | null }[]).find((x) => x.id === "wb-spike");
  out.closed = {
    into,
    ...record("wb-spike", now),
    inside: within(now.workspaces["wb-spike"], now.areas[area]),
    setGroup: since(env, mark, "setGroup"),
    group: spike?.taskGroup ?? null,
    drawnIn: ghost("wb-spike")?.dataset.area ?? null,
    translate: ghost("wb-spike")?.style.translate ?? null,
    wire: endOff(wireTo("wb-spike"), ghost("wb-spike")),
  };
  if (brief) return;

  // a step from 5115 into 5120, where Spike was: its group follows too
  mark = env.calls.length;
  await dragCard(ghost("pp-v1")!, ...by("pp-v1", at("wb-spike")));
  now = await stored();
  const v1 = ((await (window as any).mb.plannedSessions()) as { id: string; taskGroup: string | null }[]).find((x) => x.id === "pp-v1");
  out.across = {
    ...record("pp-v1", now),
    inside: within(now.workspaces["pp-v1"], now.areas["5120"]),
    setGroup: since(env, mark, "setGroup"),
    group: v1?.taskGroup ?? null,
    drawnIn: ghost("pp-v1")?.dataset.area ?? null,
    wire: endOff(wireTo("pp-v1"), ghost("pp-v1")),
  };

  // a click on the closed card, not dragged: its area selected, as a click on the landscape where it lies, nothing saved
  mark = env.calls.length;
  clickCard(ghost("wb-spike")!);
  await sleep(300);
  out.click = { area: document.querySelector<HTMLElement>(".ls-area.selected")?.dataset.area ?? null, saves: since(env, mark, "landscapeUpdate").length };
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
      else if (part === "drag") await dragAudit(env, out);
      else if (part === "dragshot") await dragAudit(env, out, true);
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
