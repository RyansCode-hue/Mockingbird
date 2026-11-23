/**
 * A pipeline's window, Save as template from it, moving a wire's end by dragging it, and not-started steps selected, in
 * the UI preview (PipelinePanel.tsx, Landscape.tsx). `?landscapePanelAudit=<part>` (with
 * `?lsWires&lsPlan=pipeline&lsLaid&lsModels`, laidPipeline's Orchestrator and its four not-started steps; the parts that
 * work in the window add `focusTool=pipeline`, which places it) works it with the page's own events and reports into
 * <script id="mb-landscape-panel-audit"> for test/uiPipelinePanel.test.ts:
 * - =open: Pipeline… in the area's ⋯ opens it; its stages and rows; ↑ ↓ and Enter along the rows; Open pipeline in a card's menu;
 * - =model: a row's model chip picks a not-started step's model at once;
 * - =repoint: a row's Hands off to picker moves its wire, with Undo, and + hand off to… adds one;
 * - =prompt: a not-started step's prompt edited and saved in its row; a running one's isn't kept;
 * - =remove: Remove step forgets it, its handoffs bridged, and Undo brings it back;
 * - =add: + Add step after the last step (and after another), through the Edit dialog;
 * - =template: Save as template, what's simplified said, saved, then saved again under its name with Replace;
 * - =drag: a wire's arrowhead dragged onto another step moves it; Esc, and a drop on nothing, leave it;
 * - =select: a not-started step clicked is selected with its bar, ⇧-click adds another, a workspace clicked lets them go;
 * - =shot, =rowshot, =saveshot: the window, a row open, Save as template's dialog, for --shot.
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
const panel = () => document.querySelector<HTMLElement>('.ls-window[data-tool="pipeline"]');
const row = (id: string) => panel()?.querySelector<HTMLElement>(`.pp-row[data-step="${CSS.escape(id)}"]`) ?? null;
const rowButton = (id: string) => row(id)?.querySelector<HTMLButtonElement>(".pp-row-b") ?? null;
const noteNow = () => document.querySelector<HTMLElement>(".ls-note")?.firstChild?.textContent ?? null;
const undoNote = () => [...document.querySelectorAll<HTMLButtonElement>(".ls-note-act")].find((b) => b.textContent === "Undo") ?? null;
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
const key = (el: Element, k: string, more: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...more }));
const since = (env: Env, mark: number, fn: string) => env.calls.slice(mark).filter((c) => c.fn === fn).map((c) => c.args);
const links = async (): Promise<Record<string, { from: string; to: string; type: string }>> => ((await (window as any).mb.wiresGet()) as any).book.links;
const wireId = async (from: string, to: string) => Object.entries(await links()).find(([, w]) => w.from === from && w.to === to && w.type === "handoff")?.[0] ?? null;
/** A Select's list opened and the option labelled `label` (or ending so) picked; the options as they were, each with whether it's off. */
async function pickIn(select: HTMLElement, label: string | null): Promise<{ label: string | null; off: boolean }[]> {
  select.click();
  const list = await until(() => document.querySelector<HTMLElement>(".mb-listbox"), "a picker's list");
  const opts = [...list.querySelectorAll<HTMLElement>(".mb-opt")];
  const shown = opts.map((o) => ({ label: o.querySelector(".mb-opt-label")?.textContent?.replace("✓", "") ?? null, off: o.classList.contains("disabled") }));
  if (label === null) {
    key(list, "Escape");
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  } else opts.find((o) => o.querySelector(".mb-opt-label")?.textContent?.replace("✓", "").endsWith(label))!.click();
  await sleep(300);
  return shown;
}
async function relayout(): Promise<void> {
  node("pp-orch")!.querySelector<HTMLElement>(".ls-more")!.click();
  await until(() => menuRow("Re-lay out pipeline"), "Re-lay out pipeline in the Orchestrator's menu").then((b) => b.click());
  await sleep(700);
}
async function openRow(id: string): Promise<HTMLElement> {
  const b = await until(() => rowButton(id), `${id}'s row`);
  if (b.getAttribute("aria-expanded") !== "true") b.click();
  await until(() => row(id)?.querySelector(".pp-more"), `${id}'s row open`);
  return row(id)!;
}
const point = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

async function openAudit(_env: Env, out: Record<string, unknown>): Promise<void> {
  const more = await until(() => document.querySelector<HTMLElement>('.ls-area[data-area="5115"] .ls-ah-more'), "#5115's ⋯");
  more.click();
  await until(() => menuRow("Pipeline…"), "Pipeline… in #5115's ⋯").then((b) => b.click());
  const win = await until(panel, "the Pipeline window", 60);
  await sleep(300);
  out.head = [win.querySelector(".ls-win-t")?.textContent, win.querySelector(".ls-win-scope")?.textContent];
  out.relayoutInHead = !!win.querySelector('.ls-win-head [data-act="relayout"]');
  out.stages = [...win.querySelectorAll(".pp-stage")].map((st) => ({ word: st.querySelector(".pp-stage-w")?.textContent, rows: [...st.querySelectorAll(".pp-title")].map((t) => t.textContent) }));
  out.tags = [...win.querySelectorAll(".pp-row")].map((r) => r.querySelector(".pp-tag")?.textContent ?? null);
  out.chips = [...win.querySelectorAll(".pp-row [data-model]")].map((c) => c.textContent);
  // the keyboard: one row in the tab order, ↓ to the next, Enter opens it
  const first = rowButton("pp-orch")!;
  out.tabStops = [...win.querySelectorAll(".pp-row-b")].filter((b) => (b as HTMLElement).tabIndex === 0).length;
  first.focus();
  key(first, "ArrowDown");
  out.afterDown = (document.activeElement as HTMLElement)?.dataset.row ?? null;
  key(document.activeElement!, "End");
  out.afterEnd = (document.activeElement as HTMLElement)?.dataset.row ?? null;
  key(document.activeElement!, "Enter");
  await sleep(300);
  out.enterOpened = row("pp-v2")?.querySelector(".pp-row-b")?.getAttribute("aria-expanded") ?? null;
  out.stepSelected = ghost("pp-v2")?.classList.contains("selected") ?? null;
  // a card's own menu opens it too
  ghost("pp-c1")!.querySelector<HTMLElement>(".ls-more")!.click();
  await until(() => menuRow("Edit…"), "Coder 5115's menu");
  out.cardMenu = menuLabels();
  menuRow("Open pipeline")?.click();
  await sleep(400);
  out.windows = document.querySelectorAll('.ls-window[data-tool="pipeline"]').length;
}

async function modelAudit(env: Env, out: Record<string, unknown>): Promise<void> {
  const r = await until(() => row("pp-c2"), "Coder 5110's row");
  const chip = r.querySelector<HTMLElement>("[data-model]")!;
  out.chip = chip.textContent;
  chip.click();
  const pop = await until(() => document.querySelector<HTMLElement>(".mp-pop"), "the model popover");
  out.restart = !!pop.querySelector('[data-act="restart"]');
  const mark = env.calls.length;
  pop.querySelector<HTMLElement>('[data-pick="gpt-5.1-codex-mini"]')!.click();
  await sleep(600);
  out.calls = since(env, mark, "setModel");
  out.chipAfter = row("pp-c2")?.querySelector("[data-model]")?.textContent ?? null;
  // a running one asks first, as its card's chip does
  row("pp-orch")!.querySelector<HTMLElement>("[data-model]")!.click();
  const run = await until(() => document.querySelector<HTMLElement>(".mp-pop"), "the Orchestrator's model popover");
  out.runNote = run.querySelector(".mp-note")?.textContent ?? null;
  out.runRestart = !!run.querySelector('[data-act="restart"]');
}

async function repointAudit(env: Env, out: Record<string, unknown>): Promise<void> {
  const r = await openRow("pp-orch");
  out.selected = node("pp-orch")?.classList.contains("selected") ?? null;
  out.ends = [...r.querySelectorAll(".pp-out .mb-select-val")].map((v) => v.textContent);
  const id = (await wireId("pp-orch", "pp-c1"))!;
  await sleep(200);
  const mark = env.calls.length;
  out.options = await pickIn(r.querySelector<HTMLElement>(`.pp-out[data-wire="${CSS.escape(id)}"] .mb-select`)!, "Verifier 5115");
  out.calls = since(env, mark, "wiresRepoint");
  out.after = (await links())[id];
  out.note = noteNow();
  out.endsAfter = [...(row("pp-orch")?.querySelectorAll(".pp-out .mb-select-val") ?? [])].map((v) => v.textContent);
  undoNote()?.click();
  await sleep(500);
  out.undone = (await links())[id];
  out.undoCalls = since(env, mark, "wiresUnrepoint").length;
  // a new handoff from a step
  const v1 = await openRow("pp-v1");
  const mark2 = env.calls.length;
  await pickIn(v1.querySelector<HTMLElement>(".pp-add")!, "Verifier 5110");
  out.addCalls = since(env, mark2, "wiresAdd");
  out.addNote = noteNow();
  out.v1Ends = [...(row("pp-v1")?.querySelectorAll(".pp-out .mb-select-val") ?? [])].map((v) => v.textContent);
}

async function promptAudit(env: Env, out: Record<string, unknown>): Promise<void> {
  const r = await openRow("pp-v1");
  const text = r.querySelector<HTMLTextAreaElement>('textarea[aria-label="Its prompt"]')!;
  out.was = text.value;
  out.saveBefore = !!r.querySelector('[data-act="save-prompt"]');
  typeIn(text, "Check the keys against staging, then call finish_step.");
  await sleep(100);
  const mark = env.calls.length;
  r.querySelector<HTMLElement>('[data-act="save-prompt"]')!.click();
  await sleep(600);
  out.calls = since(env, mark, "editStep");
  out.saveAfter = !!row("pp-v1")?.querySelector('[data-act="save-prompt"]');
  out.note = noteNow();
  // a running step's prompt isn't kept: its row says so, folded
  const o = await openRow("pp-orch");
  const told = o.querySelector<HTMLDetailsElement>(".pp-told");
  out.told = told ? { open: told.open, summary: told.querySelector("summary")?.textContent, says: told.querySelector(".pp-dim")?.textContent } : null;
  out.orchEditable = !!o.querySelector("textarea");
  out.orchStart = !!o.querySelector('[data-act="start"]');
}

async function removeAudit(env: Env, out: Record<string, unknown>): Promise<void> {
  const r = await openRow("pp-c2");
  const mark = env.calls.length;
  r.querySelector<HTMLElement>('[data-act="remove"]')!.click();
  await sleep(900);
  out.calls = since(env, mark, "forgetSession");
  out.ghost = !!ghost("pp-c2");
  out.row = !!row("pp-c2");
  out.note = noteNow();
  out.bridged = Object.values(await links()).some((w) => w.from === "pp-orch" && w.to === "pp-v2" && w.type === "handoff");
  undoNote()?.click();
  await sleep(900);
  out.undoCalls = since(env, mark, "unforgetSession").length;
  out.ghostBack = !!ghost("pp-c2");
  out.rowBack = !!row("pp-c2");
  out.undoneNote = noteNow();
}

async function addAudit(env: Env, out: Record<string, unknown>): Promise<void> {
  const win = await until(panel, "the Pipeline window");
  win.querySelector<HTMLElement>('[data-act="add"]')!.click();
  const after = await until(() => win.querySelector<HTMLElement>(".pp-after"), "the After picker");
  out.afterDefault = after.querySelector(".mb-select-val")?.textContent ?? null;
  win.querySelector<HTMLElement>('[data-act="add-next"]')!.click();
  const dlg = await until(() => document.querySelector<HTMLElement>(".se-dlg"), "the insert dialog");
  out.heading = dlg.querySelector("h3")?.textContent ?? null;
  out.prefill = [...dlg.querySelectorAll(".se-runs .mb-select-val")].map((v) => v.textContent);
  typeIn(dlg.querySelector<HTMLInputElement>('input[aria-label="Its name"]')!, "Docs 5110");
  await sleep(100);
  const mark = env.calls.length;
  dlg.querySelector<HTMLElement>('[data-act="save"]')!.click();
  await sleep(1500);
  out.calls = since(env, mark, "insertStep");
  out.rows = [...win.querySelectorAll(".pp-title")].map((t) => t.textContent);
  // after another step: the dialog says between it and what it hands off to
  win.querySelector<HTMLElement>('[data-act="add"]')!.click();
  const after2 = await until(() => win.querySelector<HTMLElement>(".pp-after"), "the After picker again");
  await pickIn(after2, "Coder 5115 – CRM keys");
  win.querySelector<HTMLElement>('[data-act="add-next"]')!.click();
  out.heading2 = (await until(() => document.querySelector<HTMLElement>(".se-dlg h3"), "the second insert dialog")).textContent;
}

async function templateAudit(env: Env, out: Record<string, unknown>): Promise<void> {
  const win = await until(panel, "the Pipeline window");
  const mark = env.calls.length;
  win.querySelector<HTMLElement>('[data-act="save-template"]')!.click();
  const dlg = await until(() => document.querySelector<HTMLElement>(".tp-save"), "Save as template");
  out.drafted = since(env, mark, "templatesDraft");
  out.notes = [...dlg.querySelectorAll("[data-note]")].map((n) => n.textContent);
  out.name = dlg.querySelector<HTMLInputElement>(".tp-name-in")?.value ?? null;
  out.button = dlg.querySelector('[data-act="save"], [data-act="replace"]')?.textContent ?? null;
  typeIn(dlg.querySelector<HTMLInputElement>(".tp-name-in")!, "Orchestrated pair");
  // the dialog lets go of clicks for a moment after it opens
  await sleep(800);
  dlg.querySelector<HTMLElement>('[data-act="save"]')!.click();
  await sleep(600);
  out.saved = since(env, mark, "templatesSave").map((a) => [a[0], (a[1] as { steps: { name: string; role?: string }[] }).steps.map((s) => (s.role ? `${s.name} (${s.role})` : s.name)), (a[1] as { wires: { type: string }[] }).wires.map((w) => w.type)]);
  out.closed = !document.querySelector(".tp-save");
  out.note = noteNow();
  // again, under the same name: Replace writes over it
  win.querySelector<HTMLElement>('[data-act="save-template"]')!.click();
  const again = await until(() => document.querySelector<HTMLElement>(".tp-save"), "Save as template again");
  typeIn(again.querySelector<HTMLInputElement>(".tp-name-in")!, "orchestrated pair");
  await until(() => again.querySelector('[data-act="replace"]'), "Replace in Save's place", 30);
  out.replaceNote = again.querySelector('[data-note="replace"]')?.textContent ?? null;
  out.replaceButton = again.querySelector('[data-act="replace"]')?.textContent ?? null;
  await sleep(800);
  const mark2 = env.calls.length;
  again.querySelector<HTMLElement>('[data-act="replace"]')!.click();
  await sleep(600);
  const list = (await (window as any).mb.templatesList()) as { templates: { template: { id: string; name: string } }[] };
  out.updated = since(env, mark2, "templatesUpdate").map((a) => [typeof a[0] === "string" && a[0] === list.templates[0]?.template.id, a[1]]);
  out.savedAgain = since(env, mark2, "templatesSave").length;
  out.list = list.templates.map((t) => t.template.name);
  out.replacedNote = noteNow();
}

async function dragAudit(env: Env, out: Record<string, unknown>): Promise<void> {
  await until(() => node("pp-orch"), "the Orchestrator");
  await relayout();
  const id = (await wireId("pp-orch", "pp-c1"))!;
  const vp = document.querySelector<HTMLElement>(".ls-viewport")!;
  const arrowhead = () => {
    const p = document.querySelector<SVGPathElement>(`.ls-wires g[data-wire="${CSS.escape(id)}"] path.line`)!;
    const m = p.getScreenCTM()!;
    // a few screen px back from its tip, on the arrowhead, clear of the card it points at
    const back = 5 / m.a;
    return p.getPointAtLength(Math.max(0, p.getTotalLength() - back)).matrixTransform(m);
  };
  const init = { bubbles: true, cancelable: true, pointerId: 41, button: 0, buttons: 1 };
  const drag = async (to: { x: number; y: number } | null, before?: () => void) => {
    const a = arrowhead();
    const under = document.elementFromPoint(a.x, a.y) ?? vp;
    under.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: a.x, clientY: a.y }));
    const b = to ?? { x: a.x, y: a.y };
    for (let i = 1; i <= 6; i++) {
      window.dispatchEvent(new PointerEvent("pointermove", { ...init, clientX: a.x + ((b.x - a.x) * i) / 6, clientY: a.y + ((b.y - a.y) * i) / 6 }));
      await sleep(30);
    }
    before?.();
    window.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0, clientX: b.x, clientY: b.y }));
    await sleep(500);
  };
  out.pressedOn = (document.elementFromPoint(arrowhead().x, arrowhead().y) as HTMLElement | null)?.className?.toString() ?? null;
  // Esc as it's dragged: nothing moves
  let mark = env.calls.length;
  await drag(point(ghost("pp-v1")!), () => {
    out.hotWhileDragging = document.querySelector<HTMLElement>(".ls-wire-hot")?.hidden === false;
    out.faintWhileDragging = !!document.querySelector(".ls-wires g.ls-wire.moving");
    key(window as unknown as Element, "Escape");
  });
  out.escCalls = since(env, mark, "wiresRepoint");
  out.faintAfter = !!document.querySelector(".ls-wires g.ls-wire.moving");
  // dropped on nothing: nothing moves
  const empty = vp.getBoundingClientRect();
  mark = env.calls.length;
  await drag({ x: empty.right - 30, y: empty.bottom - 200 });
  out.nothingCalls = since(env, mark, "wiresRepoint");
  // dropped on another step: the wire moves there, with Undo
  mark = env.calls.length;
  await drag(point(ghost("pp-v1")!));
  out.calls = since(env, mark, "wiresRepoint");
  out.after = (await links())[id];
  out.note = noteNow();
  out.undo = !!undoNote();
}

async function selectAudit(_env: Env, out: Record<string, unknown>): Promise<void> {
  const c1 = await until(() => ghost("pp-c1"), "Coder 5115's card");
  const click = (el: Element, shift = false) => {
    const at = el.querySelector(".lg-line") ?? el;
    const p = point(at);
    const init = { bubbles: true, cancelable: true, pointerId: 51, button: 0, buttons: 1, clientX: p.x, clientY: p.y, shiftKey: shift };
    at.dispatchEvent(new PointerEvent("pointerdown", init));
    window.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
  };
  click(c1);
  await sleep(400);
  out.selected = [...document.querySelectorAll(".ls-ghost.selected")].map((g) => (g as HTMLElement).dataset.front);
  const bar = document.querySelector<HTMLElement>(".ls-selbar");
  out.bar = bar?.getAttribute("aria-label") ?? null;
  out.barKeys = [...(bar?.querySelectorAll("[data-k]") ?? [])].map((k) => (k as HTMLElement).dataset.k).filter((k) => !k!.startsWith("$"));
  out.barChip = bar?.querySelector("[data-model]")?.textContent ?? null;
  click(ghost("pp-c2")!, true);
  await sleep(400);
  out.both = [...document.querySelectorAll(".ls-ghost.selected")].map((g) => (g as HTMLElement).dataset.front);
  const bar2 = document.querySelector<HTMLElement>(".ls-selbar");
  out.bar2 = bar2?.getAttribute("aria-label") ?? null;
  out.bar2Text = bar2?.querySelector(".ls-sb-name")?.textContent ?? null;
  out.bar2Keys = [...(bar2?.querySelectorAll("[data-k]") ?? [])].map((k) => (k as HTMLElement).dataset.k).filter((k) => !k!.startsWith("$"));
  // a workspace clicked is the selection now
  const head = node("pp-orch")!.querySelector(".ls-head") ?? node("pp-orch")!;
  const p = point(head);
  const init = { bubbles: true, cancelable: true, pointerId: 52, button: 0, buttons: 1, clientX: p.x, clientY: p.y };
  head.dispatchEvent(new PointerEvent("pointerdown", init));
  window.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
  await sleep(400);
  out.afterWorkspace = [...document.querySelectorAll(".ls-ghost.selected")].map((g) => (g as HTMLElement).dataset.front);
  out.workspaceSelected = node("pp-orch")?.classList.contains("selected") ?? null;
}

export function runPanelAudit(env: Env, part: string): void {
  const report = (out: unknown) => {
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-landscape-panel-audit";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  };
  env.waitFor(".ls-world .ls-ghost.planned", async () => {
    const out: Record<string, unknown> = { part };
    try {
      await sleep(1200);
      if (part === "open") await openAudit(env, out);
      else if (part === "model") await modelAudit(env, out);
      else if (part === "repoint") await repointAudit(env, out);
      else if (part === "prompt") await promptAudit(env, out);
      else if (part === "remove") await removeAudit(env, out);
      else if (part === "add") await addAudit(env, out);
      else if (part === "template") await templateAudit(env, out);
      else if (part === "drag") await dragAudit(env, out);
      else if (part === "select") await selectAudit(env, out);
      else if (part === "rowshot") await openRow("pp-v1");
      else if (part === "saveshot") (await until(panel, "the Pipeline window")).querySelector<HTMLElement>('[data-act="save-template"]')!.click();
      else if (part !== "shot") throw new Error(`there's no part ${part}`);
    } catch (err) {
      out.error = err instanceof Error ? err.message : String(err);
    }
    report(out);
  });
}
