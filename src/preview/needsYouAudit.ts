/**
 * ?landscapeNeedsAudit=a|g|b|c|d|e|f|s (with ?labs=landscape&motion=off): S7's Needs you and card badges, worked as a person
 * would in the UI preview, into <script id="mb-landscape-needs-audit"> for test/uiLandscapeNeeds.test.ts. Keys and the
 * mouse are pressed for real where the test's Chrome driver is there to press them (scripts/ui-preview.mjs's pageResult
 * takes them from window.__mbKeys), so they go wherever the browser sends them; without it (a person's browser) they're
 * sent to the focused element or what's under the point, and `keys` says "synthetic".
 *
 * =a (with ?joinRequest=later): the button and the tray's items; N and ⇧N from the landscape (the keyboard kept there),
 * in the tray (the item kept clear of it), on the button after Esc, and refused in a text field and a terminal; Dismiss
 * with the keyboard kept in the tray, a double click's second Dismiss let go, Undo, and the item back when its state
 * changes; a copy a teammate took over leaving it; the areas' counts in the tree, a stack's row, a collapsed area's pill
 * and the switcher; Esc giving the keyboard back to the button.
 * =g (with ?joinRequest=later): Go there on a permission prompt, N and Go there on a stack's tab behind another, at the
 * cards' zoom, on a join request and from another tab; the keyboard on the landscape after it, after a join request's
 * prompt and after leaving focus for another workspace, and Enter giving it to the terminal.
 * =b: the badges as drawn at the camera's zoom (?lsCamera, or ?lsFit for the fit), each card's or workspace's, with
 * their boxes against their workspace's and their area's and each row's against its card; then s1's diff source
 * failing, which its badge then says rather than its old value. With ?badgeFail=… it reports what the failing sources
 * show, what was said in the console, the meters' note going once they're read, and what's shown from the meters going
 * when main pushes a failure. ?deadFront exits s2, the front tab of a stack, so its card has its actions and its other
 * tabs' names both.
 * =c (with ?joinRequest=later): the tray's place with seven items, grown while open and opened again; ⇧N lighting the
 * last, kept in the list's view; with ?lsFit, N in the tray bringing each card clear of it.
 * =d: the top bar's buttons on one line, and the button's contrast (run it at 860 px wide, and with ?theme=light).
 * =e (with ?closedAsLeft&lsClosed=s3&joinRequest=later): closed sessions whose records still say idle with a turn's end
 * or waiting on a prompt, as ghosts, in the Closed sessions list and as a stack's closed tab: the tray and the counts
 * without them; then g1 reopened, not listed, until a turn ends in it.
 * =f (with ?joinRequest=later, or ?teamFail): the mouse and keyboard round a Dismiss: a keyboard Dismiss, a real double
 * click on the last item's, the tray with nothing left (or with the rooms unreadable), Undo with the mouse, the button's
 * height with and without its count; ⌘N, ⌘K and ⌘P with the tray open, and Esc after each.
 * =s (at the cards' zoom): a stack's card counting its other tabs as the tray and the tree do: a tab on a prompt,
 * dismissed, on a second prompt, finished, and a teammate's tab on a prompt.
 */
import type { SessionInfo } from "../shared/types";
import { armFocus } from "../renderer/keyArm";

export interface NeedsAuditEnv {
  sessions: () => SessionInfo[];
  /** Change session `id` as main would, and tell the window. */
  setSession: (id: string, over: Partial<SessionInfo>) => void;
  /** Change session `id`'s room tag as team rooms report it (null: back to the fixture's), and tell the window. */
  setOwnTag: (id: string, over: Partial<NonNullable<SessionInfo["room"]>> | null) => void;
  /** Teammates' sessions as team rooms report them. */
  remote: () => SessionInfo[];
  /** Change teammate's session `id`, and tell the window. */
  setRemote: (id: string, over: Partial<SessionInfo>) => void;
  calls: { fn: string; args: unknown[] }[];
  emit: (name: string, ...args: unknown[]) => void;
  /** The badge sources failing now (stub.ts's ?badgeFail), changeable. */
  badgeFails: Set<string>;
  waitFor: (selector: string, then: (el: HTMLElement) => void, tries?: number) => void;
}

type Box = { x: number; y: number; w: number; h: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const vp = () => document.querySelector<HTMLElement>(".ls-viewport")!;
const box = (el: Element | null | undefined): Box | null => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
};
/** `a` lies within `b` (half a pixel's rounding allowed). */
const within = (a: Box | null, b: Box | null) => !!a && !!b && a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.w <= b.x + b.w + 0.5 && a.y + a.h <= b.y + b.h + 0.5;
const overlaps = (a: Box | null, b: Box | null) => !!a && !!b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ---- keys and the mouse: pressed for real by the driver when it's there ----
export type Asked =
  | { key: string; shift?: boolean; meta?: boolean; alt?: boolean; ctrl?: boolean; hold?: "down" | "up" }
  | { mouse: { x: number; y: number; clickCount: number; button?: "left" | "right" | "middle"; shift?: boolean } }
  | { move: { x: number; y: number } }
  | { wheel: { x: number; y: number; dx?: number; dy?: number; meta?: boolean; ctrl?: boolean } }
  | { drag: { x0: number; y0: number; x1: number; y1: number; hold?: "down" | "up" } };
type W = Window & { __mbKeys?: Asked[]; __mbKeysDone?: number };
const w = window as W;
let asked = 0;
let driver: boolean | null = null;
/** Ask the driver for `these`, one straight after another; false when there's no driver. */
export async function drive(these: Asked[]): Promise<boolean> {
  if (driver === false) return false;
  (w.__mbKeys ??= []).push(...these);
  const want = (asked += these.length);
  for (let i = 0; i < 60; i++) {
    if ((w.__mbKeysDone ?? 0) >= want) {
      driver = true;
      await sleep(120);
      return true;
    }
    await sleep(50);
  }
  if (driver) throw new Error(`the driver didn't do ${JSON.stringify(these)}`);
  driver = false;
  w.__mbKeys = [];
  return false;
}
/** Press `key` (n, N, k, Enter, Escape) as a person would: through the browser to whatever has the keyboard. */
async function press(key: string, o: { shift?: boolean; meta?: boolean } = {}): Promise<void> {
  if (await drive([{ key, ...o }])) return;
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: !!o.shift, metaKey: !!o.meta, bubbles: true, cancelable: true }));
  await sleep(120);
}
/** Click the middle of `el` as a person's mouse would (`times` 2: a double click), through the browser to what's under it each time. */
async function clickOn(el: Element, times = 1): Promise<void> {
  const r = el.getBoundingClientRect();
  const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
  if (await drive(Array.from({ length: times }, (_, i) => ({ mouse: { x, y, clickCount: i + 1 } })))) return;
  for (let i = 0; i < times; i++) (document.elementFromPoint(x, y) as HTMLElement | null)?.click();
  await sleep(120);
}
const keysWere = () => (driver ? "real" : "synthetic");

const selectedWs = () => document.querySelector<HTMLElement>(".ls-world .ls-node.selected")?.dataset.front ?? null;
const selectedArea = () => document.querySelector<HTMLElement>(".ls-world .ls-area.selected, .ls-world .ls-area-pill.selected")?.dataset.area ?? null;
const picked = () => document.querySelectorAll(".ls-world .ls-node.picked").length;
const camera = () => document.querySelector<HTMLElement>(".ls-world")?.style.transform ?? "";
const term = (id: string) => (window as unknown as { __mbTerms?: Map<string, { term: { textarea?: HTMLTextAreaElement } }> }).__mbTerms?.get(id)?.term;
const keyboard = () => {
  const a = document.activeElement;
  if (a === vp()) return "landscape";
  if (a?.closest(".ny-tray")) return "tray";
  if (a?.classList.contains("ny-btn")) return "button";
  if (a?.closest(".xterm")) return "terminal";
  if (a?.closest(".ls-focus")) return "focus";
  return a?.tagName ?? "none";
};
const button = () => {
  const b = document.querySelector<HTMLElement>(".ny-btn");
  return { on: !!b?.classList.contains("on"), count: b?.querySelector(".ny-n")?.textContent ?? null, title: b?.title ?? null };
};
const tray = () => ({
  open: !!document.querySelector(".ny-tray"),
  head: document.querySelector(".ny-tray .ny-head")?.textContent ?? null,
  items: [...document.querySelectorAll<HTMLElement>(".ny-tray .ny-item")].map((el) => ({
    id: el.dataset.item ?? null,
    kind: [...el.classList].find((c) => c.startsWith("k-"))?.slice(2) ?? null,
    on: el.classList.contains("on"),
    meta: el.querySelector(".ny-kind")?.textContent ?? null,
    text: el.querySelector(".ny-text")?.textContent ?? null,
    acts: [...el.querySelectorAll<HTMLButtonElement>(".ny-acts button")].map((b) => ({ key: b.dataset.action ?? null, label: b.textContent, disabled: b.disabled, title: b.title, filled: b.classList.contains("fill") })),
  })),
  foot: document.querySelector(".ny-tray .ny-foot")?.textContent ?? null,
  undo: !!document.querySelector('.ny-tray button[data-action="undo"]'),
  none: document.querySelector(".ny-tray .ny-none")?.textContent ?? null,
  error: document.querySelector(".ny-tray .ny-err")?.textContent ?? null,
});
const treeBadges = () => Object.fromEntries([...document.querySelectorAll<HTMLElement>(".area-tree .lt-area")].map((a) => [a.dataset.area, a.querySelector(".lt-head .lt-badge")?.textContent ?? null]));
const stackBadge = () => {
  const b = document.querySelector<HTMLElement>(".area-tree .lt-stack .lt-badge");
  return b ? { count: b.textContent, title: b.title, label: b.getAttribute("aria-label") } : null;
};
const openTray = async () => {
  if (!document.querySelector(".ny-tray")) document.querySelector<HTMLElement>(".ny-btn")?.click();
  await sleep(300);
};
const closeTray = async () => {
  if (document.querySelector(".ny-tray")) document.querySelector<HTMLElement>(".ny-btn")?.click();
  await sleep(200);
};
const actBtn = (item: string, key: string) => document.querySelector<HTMLElement>(`.ny-tray .ny-item[data-item="${CSS.escape(item)}"] button[data-action="${key}"]`);
const act = (item: string, key: string) => actBtn(item, key)?.click();
const node = (id: string) => document.querySelector<HTMLElement>(`.ls-world [data-front="${CSS.escape(id)}"]`);
/** The tab in front of the stack holding `ids`' sessions. */
const stackFront = (ids: string[]) => ids.map(node).find(Boolean)?.dataset.front ?? null;

/** Console warnings and errors from the page's start, which a failing badge source's reason must be among. */
const said: string[] = [];
export function recordConsole(): void {
  for (const level of ["warn", "error"] as const) {
    const was = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      said.push(args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      was(...args);
    };
  }
}
/** What's been said so far (recordConsole). */
export const consoleSaid = (): readonly string[] => said;

export function runNeedsAudit(env: NeedsAuditEnv, part: string): void {
  const write = (out: unknown) => {
    const el = document.createElement("script");
    el.type = "application/json";
    el.id = "mb-landscape-needs-audit";
    el.textContent = JSON.stringify(out);
    document.body.appendChild(el);
  };
  env.waitFor(part === "d" ? ".ny-btn" : ".ls-world .ls-node", async () => {
    const out: Record<string, unknown> = {};
    try {
      await sleep(1500);
      if (part === "a") await trayPart(env, out);
      else if (part === "g") await goPart(env, out);
      else if (part === "c") await placePart(env, out);
      else if (part === "d") await barPart(out);
      else if (part === "e") await closedPart(env, out);
      else if (part === "f") await aroundDismissPart(out);
      else if (part === "s") await stackCardPart(env, out);
      else await badgePart(env, out);
    } catch (err) {
      out.error = String((err as Error)?.stack ?? err);
    }
    out.keys = keysWere();
    write(out);
  }, 300);
}

async function trayPart(env: NeedsAuditEnv, out: Record<string, unknown>): Promise<void> {
  out.button = button();
  out.tree = treeBadges();
  out.stackRow = stackBadge();
  await openTray();
  out.tray = tray();
  out.trayKeyboard = keyboard();
  await closeTray();

  // N and ⇧N on the landscape: the view goes to each item in turn, the keyboard staying with the landscape
  armFocus(vp());
  const steps: unknown[] = [];
  for (const shift of [false, false, false, false, true]) {
    const cam = camera();
    await press(shift ? "N" : "n", { shift });
    await sleep(600);
    steps.push({ shift, ws: selectedWs(), area: selectedArea(), keyboard: keyboard(), moved: camera() !== cam, prompt: !!document.querySelector(".join-ask") });
  }
  out.steps = steps;

  // N in the tray, its next item (s2) first put where the tray will be: the view moves it clear of the tray
  const trayAt = { x: window.innerWidth - 8 - 160, y: 140 };
  const s2 = box(node("s2"));
  if (s2) vp().dispatchEvent(new WheelEvent("wheel", { deltaX: s2.x + s2.w / 2 - trayAt.x, deltaY: s2.y + s2.h / 2 - trayAt.y, bubbles: true, cancelable: true }));
  await sleep(300);
  await openTray();
  const trayBox = box(document.querySelector(".ny-tray"));
  out.litAfterSteps = tray().items.filter((i) => i.on).map((i) => i.id);
  const under = overlaps(box(node("s2")), trayBox);
  await press("n");
  await sleep(700);
  out.inTray = { ws: selectedWs(), open: tray().open, lit: tray().items.filter((i) => i.on).map((i) => i.id), keyboard: keyboard(), under, clear: !overlaps(box(node("s2")), box(document.querySelector(".ny-tray"))) };
  // Esc gives the keyboard back to the button
  await press("Escape");
  out.escape = { open: tray().open, keyboard: keyboard() };
  // and N on the button goes on to the next, as its title says
  const onButton = { ws: selectedWs(), area: selectedArea() };
  await press("n");
  await sleep(500);
  out.nOnButton = { moved: selectedWs() !== onButton.ws || selectedArea() !== onButton.area, keyboard: keyboard(), open: tray().open };

  // never in a text field or a terminal
  const filter = document.querySelector<HTMLInputElement>(".area-tree .lt-find input")!;
  const before = { ws: selectedWs(), area: selectedArea() };
  filter.focus();
  await press("n");
  await sleep(300);
  out.inField = { before, ws: selectedWs(), area: selectedArea(), typed: filter.value };
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filter, "");
  filter.dispatchEvent(new Event("input", { bubbles: true }));
  armFocus(vp());
  vp().dispatchEvent(new KeyboardEvent("keydown", { key: "1", metaKey: true, bubbles: true, cancelable: true }));
  await sleep(800);
  (node("s1")?.querySelector<HTMLElement>(".ls-head") ?? node("s1"))!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 7 }));
  await sleep(300);
  const ta = term("s1")?.textarea;
  const w0 = env.calls.length;
  ta?.focus();
  await press("n");
  await sleep(300);
  out.inTerminal = {
    textarea: !!ta,
    ws: selectedWs(),
    keyboard: keyboard(),
    wrote: env.calls.slice(w0).filter((c) => c.fn === "sessionWrite" && c.args[0] === "s1").map((c) => String(c.args[1])),
  };
  armFocus(vp());

  // Dismiss: off the list and the counts, the keyboard still in the tray (N moves on); a double click's second
  // Dismiss, landing on the item that slid up, is let go; Undo lists it again
  await openTray();
  const first = tray().items.map((i) => i.id);
  const d1 = actBtn("s:s8", "dismiss");
  d1?.click();
  await sleep(30);
  // the second click of a double click, on whatever is under the pointer now
  (document.elementFromPoint(...(() => { const b = d1?.getBoundingClientRect(); return [b ? b.left + 4 : 0, b ? b.top + 4 : 0] as [number, number]; })()) as HTMLElement | null)?.closest<HTMLElement>("button")?.click();
  await sleep(300);
  out.dismissed = { before: first, tray: tray(), button: button(), tree: treeBadges(), keyboard: keyboard() };
  const sel0 = selectedWs();
  await press("n");
  await sleep(500);
  out.afterDismissN = { keyboard: keyboard(), moved: selectedWs() !== sel0 || selectedArea() !== null, open: tray().open };
  document.querySelector<HTMLElement>('.ny-tray button[data-action="undo"]')?.click();
  await sleep(300);
  out.undone = { ids: tray().items.map((i) => i.id), foot: tray().foot };
  act("s:s8", "dismiss");
  await sleep(300);
  await closeTray();
  env.setSession("s8", { status: "working", finishedAt: null });
  await sleep(200);
  env.setSession("s8", { status: "idle", finishedAt: Date.now() });
  await sleep(400);
  await openTray();
  out.back = { ids: tray().items.map((i) => i.id), button: button(), foot: tray().foot };
  await closeTray();

  // a second prompt worded like a dismissed one is a new item
  await openTray();
  act("s:s2", "dismiss");
  await sleep(600);
  out.stackRowDismissed = stackBadge();
  await closeTray();
  const s2now = env.sessions().find((s) => s.id === "s2")!;
  env.setSession("s2", { waitingAt: (s2now.waitingAt ?? s2now.waitingSince ?? Date.now()) + 60_000 });
  await sleep(400);
  await openTray();
  out.samePrompt = { ids: tray().items.map((i) => i.id) };
  await closeTray();

  // a copy a teammate took over leaves the tray: its prompts and turns go on on their laptop
  env.setOwnTag("s8", { takenOver: { by: "nick", byName: "Nick Smith", at: Date.now() } });
  await sleep(500);
  await openTray();
  out.takenOver = { ids: tray().items.map((i) => i.id), button: button() };
  await closeTray();
  env.setOwnTag("s8", null);
  await sleep(500);

  // a collapsed area's pill keeps its count, and so does the switcher
  const mb = (window as unknown as { mb: { landscapeUpdate: (p: unknown, what: string) => Promise<unknown> } }).mb;
  await mb.landscapeUpdate({ areas: { "5101": { collapsed: true } } }, "audit: 5101 collapsed");
  await sleep(500);
  const pill = document.querySelector<HTMLElement>('.ls-area-pill[data-area="5101"]');
  out.pill = { count: pill?.querySelector(".w")?.textContent ?? null, title: pill?.querySelector(".w")?.getAttribute("title") ?? null };
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true, bubbles: true, cancelable: true }));
  await sleep(400);
  out.switcher = Object.fromEntries([...document.querySelectorAll<HTMLElement>(".ls-switcher .ls-sw")].map((b) => [b.dataset.area, b.querySelector(".w")?.textContent ?? null]));
  out.switcherTitle = document.querySelector<HTMLElement>('.ls-switcher .ls-sw[data-area="5101"] .w')?.title ?? null;
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true, bubbles: true, cancelable: true }));
  await mb.landscapeUpdate({ areas: { "5101": { collapsed: false } } }, "audit: 5101 opened");
  await sleep(600);
  out.treeTitle = document.querySelector<HTMLElement>('.area-tree .lt-area[data-area="5101"] .lt-head .lt-badge')?.title ?? null;
}

async function goPart(env: NeedsAuditEnv, out: Record<string, unknown>): Promise<void> {
  const enterAndBack = async (id: string) => {
    await press("Enter");
    await sleep(500);
    const r = { terminal: document.activeElement === term(id)?.textarea, focus: !!document.querySelector(".ls-focus") };
    // ⌘E leaves focus, the keyboard back on the landscape
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", metaKey: true, bubbles: true, cancelable: true }));
    await sleep(400);
    armFocus(vp());
    return r;
  };
  // Go there on the permission prompt: the tray goes, the workspace is selected, the keyboard on the landscape (a
  // single letter answers Codex's prompt); Enter then gives its terminal the keyboard
  armFocus(vp());
  await openTray();
  out.goTitle = actBtn("s:s2", "go")?.title ?? null;
  act("s:s2", "go");
  await sleep(800);
  out.goPermission = { open: tray().open, ws: selectedWs(), keyboard: keyboard(), terminal: document.activeElement === term("s2")?.textarea };
  out.goPermissionEnter = await enterAndBack("s2");

  // a stack's tab behind another: N brings it to the front, the keyboard kept on the landscape, and N on round to the
  // first tab brings that back
  const sStack = env.sessions().find((s) => s.id === "s3")!;
  const stack = env.sessions().filter((s) => s.taskGroup === sStack.taskGroup).map((s) => s.id);
  env.setSession("s3", { status: "waiting", waitingReason: "Codex needs your permission to use shell", waitingSince: Date.now() - 60_000, waitingAt: Date.now() - 60_000 });
  await sleep(400);
  const nTo = async (id: string) => {
    for (let i = 0; i < 6 && selectedWs() !== id; i++) {
      await press("n");
      await sleep(600);
    }
  };
  const nBefore = stackFront(stack);
  const nowFront = () => stackFront(stack) ?? "s2";
  const onScreen = () => overlaps(box(node(nowFront())), box(vp()));
  /** The stack off screen, so reaching its tab has to bring it into view. */
  const nFar = async () => {
    const at = box(node(nowFront()));
    if (at) vp().dispatchEvent(new WheelEvent("wheel", { deltaX: at.x + 3000, deltaY: 0, bubbles: true, cancelable: true }));
    await sleep(300);
  };
  await nTo("s8");
  await nFar();
  const farBefore = onScreen();
  await nTo("s3");
  out.nStack = { before: nBefore, front: stackFront(stack), ws: selectedWs(), keyboard: keyboard(), farBefore, onScreen: onScreen(), note: document.querySelector(".ls-note")?.textContent ?? null };
  await nTo("s2");
  out.nStackBack = { front: stackFront(stack), ws: selectedWs(), keyboard: keyboard() };

  // Go there on it, off screen again: brought to the front first, then into view
  await nFar();
  out.stackBefore = stackFront(stack);
  out.stackFar = onScreen();
  await openTray();
  act("s:s3", "go");
  await sleep(1000);
  out.goStack = { front: stackFront(stack), ws: selectedWs(), keyboard: keyboard(), onScreen: onScreen(), note: document.querySelector(".ls-note")?.textContent ?? null };
  out.goStackEnter = await enterAndBack("s3");
  env.setSession("s3", { status: sStack.status, waitingReason: null, waitingSince: null, waitingAt: null });
  await sleep(300);

  // at the cards' zoom (the fit): the same, and Enter fills the window with it, its terminal live and taking keys
  vp().dispatchEvent(new KeyboardEvent("keydown", { key: "0", metaKey: true, bubbles: true, cancelable: true }));
  await sleep(900);
  out.cardsBand = [...vp().classList].find((c) => c.startsWith("ls-band-"))?.slice(8) ?? null;
  armFocus(vp());
  await openTray();
  act("s:s2", "go");
  await sleep(800);
  out.goCards = { ws: selectedWs(), keyboard: keyboard() };
  out.goCardsEnter = await enterAndBack("s2");

  // Go there on the join request: its room's area, and the admin's prompt for it
  armFocus(vp());
  await openTray();
  const join = tray().items.find((i) => i.kind === "join")?.id ?? "";
  act(join, "go");
  await sleep(700);
  out.goJoin = { open: tray().open, area: selectedArea(), ws: selectedWs(), prompt: document.querySelector(".join-ask h3")?.textContent ?? null };
  document.querySelector<HTMLElement>('.join-ask button[title^="Answer later"]')?.click();
  await sleep(300);
  // the tray and what had the keyboard before the prompt are long gone: it's the landscape's
  out.goJoinAfter = { prompt: !!document.querySelector(".join-ask"), keyboard: keyboard() };
  // an area selected (by N, by Go there) lets go of several picked workspaces: one selection at a time
  armFocus(vp());
  for (const id of ["s1", "s8"]) {
    (node(id)?.querySelector<HTMLElement>(".ls-head") ?? node(id))!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 3, shiftKey: true }));
    await sleep(150);
  }
  const pickedBefore = picked();
  await openTray();
  act(join, "go");
  await sleep(700);
  out.pickThenArea = { pickedBefore, picked: picked(), area: selectedArea() };
  document.querySelector<HTMLElement>('.join-ask button[title^="Answer later"]')?.click();
  await sleep(300);

  // from focus on one workspace, Go there on another: focus ends, and N, Enter and Esc still work there
  await openTray();
  act("s:s2", "go");
  await sleep(800);
  await press("Enter");
  await sleep(500);
  const inFocus = !!document.querySelector(".ls-focus");
  await openTray();
  act("s:s8", "go");
  await sleep(900);
  out.goFromFocus = { inFocus, focus: !!document.querySelector(".ls-focus"), ws: selectedWs(), keyboard: keyboard() };

  // from another tab, Go there comes back to the landscape
  [...document.querySelectorAll<HTMLElement>(".tab")].find((b) => b.textContent?.trim() === "Dashboard")?.click();
  await sleep(500);
  await openTray();
  act("s:s8", "go");
  await sleep(900);
  out.goFromTab = { tab: document.querySelector(".tab.on")?.textContent?.trim() ?? null, ws: selectedWs(), keyboard: keyboard() };
}

async function placePart(env: NeedsAuditEnv, out: Record<string, unknown>): Promise<void> {
  const place = () => {
    const t = box(document.querySelector(".ny-tray"));
    const b = box(document.querySelector(".ny-btn"));
    const list = document.querySelector<HTMLElement>(".ny-tray .ny-list");
    return {
      items: document.querySelectorAll(".ny-tray .ny-item").length,
      underButton: !!t && !!b && Math.abs(t.y - (b.y + b.h + 4)) <= 1,
      coversButton: overlaps(t, b),
      inWindow: !!t && t.y >= 0 && t.y + t.h <= window.innerHeight - 7.5,
      scrolls: !!list && list.scrollHeight > list.clientHeight + 1,
      lastBorder: (() => { const items = document.querySelectorAll<HTMLElement>(".ny-tray .ny-list > .ny-item"); return items.length ? getComputedStyle(items[items.length - 1]).borderBottomWidth : null; })(),
    };
  };
  await openTray();
  out.few = place();
  // grown while open: four more sessions start waiting on you
  let t = Date.now() - 30_000;
  for (const id of ["s1", "s3", "s5", "s7"]) env.setSession(id, { status: "waiting", waitingReason: `Claude needs your permission to use Edit`, waitingSince: (t += 1000), waitingAt: t });
  await sleep(700);
  out.grown = place();
  await closeTray();
  await openTray();
  out.reopened = place();
  out.filled = tray().items.map((i) => [i.kind, i.acts.find((a) => a.key === "go")?.filled ?? null]);

  // ⇧N to the last item: the list follows, so the lit item is one you can see
  const lit = () => tray().items.findIndex((i) => i.on);
  const last = tray().items.length - 1;
  for (let i = 0; i < 9 && lit() !== last; i++) {
    await press("N", { shift: true });
    await sleep(300);
  }
  const list = document.querySelector<HTMLElement>(".ny-tray .ny-list");
  out.litKept = { last: lit() === last, scrollTop: list?.scrollTop ?? 0, inView: within(box(list?.querySelector(".ny-item.on")), box(list)) };

  // at the fit, N in the tray: each card brought clear of it, in the room beside it
  if (new URLSearchParams(location.search).has("lsFit")) {
    await closeTray();
    vp().dispatchEvent(new KeyboardEvent("keydown", { key: "0", metaKey: true, bubbles: true, cancelable: true }));
    await sleep(900);
    await openTray();
    const steps: { ws: string; covered: boolean; inView: boolean }[] = [];
    for (let i = 0; i < 7; i++) {
      await press("n");
      await sleep(700);
      const ws = selectedWs();
      if (ws) steps.push({ ws, covered: overlaps(box(node(ws)), box(document.querySelector(".ny-tray"))), inView: within(box(node(ws)), box(vp())) });
    }
    out.fitSteps = steps;
  }
}

async function barPart(out: Record<string, unknown>): Promise<void> {
  const bar = document.querySelector<HTMLElement>(".topbar")!;
  const one = (el: HTMLElement | null) => {
    if (!el) return null;
    const line = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.3;
    const pad = parseFloat(getComputedStyle(el).paddingTop) + parseFloat(getComputedStyle(el).paddingBottom) + parseFloat(getComputedStyle(el).borderTopWidth) + parseFloat(getComputedStyle(el).borderBottomWidth);
    return { text: el.textContent?.trim() ?? "", oneLine: el.getBoundingClientRect().height <= pad + line * 1.5 + 2, cut: el.scrollWidth > el.clientWidth + 1 };
  };
  out.width = window.innerWidth;
  out.buttons = [one(document.querySelector<HTMLElement>(".ny-btn")), one(document.querySelector<HTMLElement>(".topbar > button.primary"))];
  out.barOverflows = bar.scrollWidth > bar.clientWidth + 1;
  // the amber button's text against what's under it: its own fill over the top bar
  const rgba = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number).concat(1).slice(0, 4);
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (top: number[], under: number[]) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3]));
  const btn = document.querySelector<HTMLElement>(".ny-btn.on");
  if (btn) {
    const barBg = rgba(getComputedStyle(bar).backgroundColor);
    const bg = over(rgba(getComputedStyle(btn).backgroundColor), barBg);
    const fg = over(rgba(getComputedStyle(btn).color), bg);
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    out.contrast = Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  }
}

async function closedPart(env: NeedsAuditEnv, out: Record<string, unknown>): Promise<void> {
  const ghostEl = (id: string) => document.querySelector<HTMLElement>(`.ls-world .ls-ghost[data-front="${CSS.escape(id)}"]`);
  const mb = (window as unknown as { mb: { landscapeUpdate: (p: unknown, what: string) => Promise<unknown> } }).mb;
  /** The pill's count with 5102 (where g1's ghost is) collapsed, and each area's on the switcher. */
  const collapsed = async () => {
    await mb.landscapeUpdate({ areas: { "5102": { collapsed: true } } }, "audit: 5102 collapsed");
    await sleep(500);
    const pill = document.querySelector<HTMLElement>('.ls-area-pill[data-area="5102"]');
    const r = { pill: pill ? pill.querySelector(".w")?.textContent ?? null : "no pill" };
    await mb.landscapeUpdate({ areas: { "5102": { collapsed: false } } }, "audit: 5102 opened");
    await sleep(500);
    return r;
  };
  const counts = async () => {
    await openTray();
    const ids = tray().items.map((i) => i.id);
    await closeTray();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true, bubbles: true, cancelable: true }));
    await sleep(400);
    const switcher = Object.fromEntries([...document.querySelectorAll<HTMLElement>(".ls-switcher .ls-sw")].map((b) => [b.dataset.area, b.querySelector(".w")?.textContent ?? null]));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true, bubbles: true, cancelable: true }));
    await sleep(300);
    return { ids, button: button(), tree: treeBadges(), switcher, ...(await collapsed()) };
  };
  // all of them there to be left out: ghosts, the Closed sessions list and a stack's closed tab
  out.ghosts = [...document.querySelectorAll<HTMLElement>(".ls-world .ls-ghost")].map((g) => g.dataset.front ?? null).sort();
  out.closedList = document.querySelector(".lt-closed-n")?.textContent ?? null;
  out.closedTabs = [...document.querySelectorAll<HTMLElement>(".ls-tab.closed")].map((t) => t.dataset.closed ?? null);
  out.before = await counts();

  // g1 reopened from its ghost: running, and not finished, as no turn has ended in it
  ghostEl("g1")!.querySelector<HTMLButtonElement>('[data-act="reopen"]')!.click();
  await sleep(900);
  out.reopened = { live: env.sessions().some((s) => s.id === "g1"), ghost: !!ghostEl("g1"), node: !!node("g1"), ...(await counts()) };
  // a turn ends in it: now it is
  env.setSession("g1", { status: "idle", finishedAt: Date.now() });
  await sleep(500);
  out.oneTitle = document.querySelector<HTMLElement>('.area-tree .lt-area[data-area="5102"] .lt-head .lt-badge')?.title ?? null;
  out.turnEnded = await counts();
}

async function aroundDismissPart(out: Record<string, unknown>): Promise<void> {
  const height = (selector: string) => box(document.querySelector(selector))?.h ?? null;
  const bar = () => ({ needs: height(".ny-btn"), bottom: (() => { const b = box(document.querySelector(".ny-btn")); return b ? b.y + b.h : null; })(), neighbour: height(".topbar > button.primary") });
  const ids = () => tray().items.map((i) => i.id!);
  out.barWithCount = bar();
  armFocus(vp());
  await openTray();
  const all = ids();
  out.all = all;
  // the tallest item last: its Dismiss is furthest down, so the tray shrinking leaves the pointer past its end
  const itemHeight = (id: string) => height(`.ny-tray .ny-item[data-item="${CSS.escape(id)}"]`) ?? 0;
  const last = [...all].sort((a, b) => itemHeight(b) - itemHeight(a))[0];
  const others = all.filter((id) => id !== last);
  out.last = last;

  // a Dismiss with the keyboard: its button leaves, the keyboard stays in the tray
  actBtn(others[0], "dismiss")!.focus();
  await press("Enter");
  out.keyboardDismiss = { gone: others[0], ids: ids(), keyboard: keyboard() };
  await sleep(520);
  for (const id of others.slice(1)) {
    act(id, "dismiss");
    await sleep(520);
  }

  // a real double click on the last item's Dismiss: the tray shrinks under the pointer, so it holds its height for the
  // second click, which lands in it, not on the landscape
  const before = { ws: selectedWs(), area: selectedArea(), camera: camera(), height: height(".ny-tray") };
  const presses: { inTray: boolean; height: number | null }[] = [];
  const onPress = (e: Event) => presses.push({ inTray: !!(e.target as Element).closest?.(".ny-tray"), height: height(".ny-tray") });
  document.addEventListener("pointerdown", onPress, true);
  await clickOn(actBtn(last, "dismiss")!, 2);
  document.removeEventListener("pointerdown", onPress, true);
  out.doubleClick = { before: before.height, presses, open: tray().open, ids: ids(), selection: selectedWs() === before.ws && selectedArea() === before.area, camera: camera() === before.camera, keyboard: keyboard() };
  await sleep(600);
  out.afterGuard = { height: height(".ny-tray"), held: document.querySelector<HTMLElement>(".ny-tray")?.style.minHeight ?? null };
  out.empty = { none: tray().none, error: tray().error, title: button().title, foot: tray().foot };
  out.barNoCount = bar();

  // Undo with the mouse: its button leaves with the dismissal, the keyboard stays in the tray, and N still works
  const undo = document.querySelector('.ny-tray button[data-action="undo"]');
  if (undo) await clickOn(undo);
  await sleep(600);
  out.undone = { ids: ids(), keyboard: keyboard() };
  const beforeN = { ws: selectedWs(), area: selectedArea() };
  await press("n");
  await sleep(500);
  out.undoneN = { moved: selectedWs() !== beforeN.ws || selectedArea() !== beforeN.area, keyboard: keyboard(), open: tray().open };

  // ⌘N with the tray open: a dialog opens, the tray put away rather than left over its backdrop; Esc: the keyboard on
  // the button, the tray having gone
  await press("n", { meta: true });
  await sleep(500);
  out.dialog = { tray: tray().open, dialog: !!document.querySelector(".modal-back") };
  await press("Escape");
  await sleep(400);
  out.dialogClosed = { dialog: !!document.querySelector(".modal-back"), keyboard: keyboard() };
  // ⌘K: the same
  await openTray();
  await press("k", { meta: true });
  await sleep(500);
  out.palette = { tray: tray().open, palette: !!document.querySelector(".palette") };
  await press("Escape");
  await sleep(400);
  out.paletteClosed = { palette: !!document.querySelector(".palette"), keyboard: keyboard() };
  // ⌘P: the same
  await openTray();
  await press("p", { meta: true });
  await sleep(500);
  out.quickOpen = { tray: tray().open, open: !!document.querySelector(".palette.qo") };
  await press("Escape");
  await sleep(400);
  out.quickOpenClosed = { open: !!document.querySelector(".palette.qo"), keyboard: keyboard() };
}

async function stackCardPart(env: NeedsAuditEnv, out: Record<string, unknown>): Promise<void> {
  const noPrompt = { waitingReason: null, waitingSince: null, waitingAt: null };
  const ago = Date.now() - 60_000;
  const prompt = { status: "waiting" as const, waitingReason: "Claude needs your permission to use Bash", waitingSince: ago, waitingAt: ago };
  const shown = () => ({
    card: document.querySelector('.ls-world .ls-node[data-ws="ws:5101/api"] .ls-card-needs')?.textContent ?? null,
    front: document.querySelector<HTMLElement>('.ls-world .ls-node[data-ws="ws:5101/api"]')?.dataset.front ?? null,
    stackRow: stackBadge()?.count ?? null,
    button: button().count,
  });
  out.tabs = document.querySelector('.ls-world .ls-node[data-ws="ws:5101/api"] .ls-card-tabs')?.textContent ?? null;
  out.before = shown();

  // s3, behind the front tab, on a prompt: an item, counted on the card as in the tree and on the button
  env.setSession("s3", prompt);
  await sleep(500);
  out.waiting = shown();
  // dismissed: gone from all of them
  await openTray();
  act("s:s3", "dismiss");
  await sleep(600);
  await closeTray();
  out.dismissed = shown();

  // a second prompt: back on all of them
  env.setSession("s3", { waitingAt: ago + 30_000 });
  await sleep(500);
  out.secondPrompt = shown();

  // its turn ended: an item too, so counted
  env.setSession("s3", { ...noPrompt, status: "idle", finishedAt: Date.now() });
  await sleep(500);
  out.finished = shown();
  env.setSession("s3", { status: "idle", finishedAt: null });
  await sleep(300);

  // a teammate's tab in the stack, on a prompt: it waits on them, so it's in none of them
  const teammate = env.remote().find((s) => s.taskGroup === "5101/api")!;
  out.teammate = teammate.id;
  env.setRemote(teammate.id, prompt);
  await sleep(500);
  out.teammateWaiting = { ...shown(), status: env.remote().find((s) => s.id === teammate.id)!.status };
}

async function badgePart(env: NeedsAuditEnv, out: Record<string, unknown>): Promise<void> {
  const q = new URLSearchParams(location.search);
  if (q.has("lsFit")) {
    vp().dispatchEvent(new KeyboardEvent("keydown", { key: "0", metaKey: true, bubbles: true, cancelable: true }));
    await sleep(900);
  }
  if (q.has("deadFront")) {
    env.setSession("s2", { status: "dead", exitCode: 1, waitingReason: null, waitingSince: null, waitingAt: null });
    await sleep(700);
  }
  const band = [...vp().classList].find((c) => c.startsWith("ls-band-"))?.slice(8) ?? null;
  const areaOf = (id: string) => {
    const s = env.sessions().find((x) => x.id === id);
    const top = s?.taskGroup?.split("/")[0] ?? null;
    return document.querySelector(`.ls-world .ls-area[data-area="${CSS.escape(top ?? "")}"]`);
  };
  const workspaces = () =>
    [...document.querySelectorAll<HTMLElement>(".ls-world .ls-node")].map((n) => {
      const id = n.dataset.front!;
      const nodeBox = box(n);
      const area = box(areaOf(id));
      const row = n.querySelector(".ls-badges");
      const rowBox = box(row);
      const foot = box(n.querySelector(".ls-card-foot"));
      const badges = [...n.querySelectorAll<HTMLElement>(".ls-badge")].map((b) => {
        const bb = box(b);
        // a badge that didn't fit wrapped onto the row's second line, which it never shows; one past the foot's end
        // (whose overflow hides it) would show cut: it must never be there
        const shown = !!bb && !!rowBox && bb.y < rowBox.y + rowBox.h - 1 && (!foot || bb.x < foot.x + foot.w - 0.5);
        return { key: b.dataset.badge ?? null, text: b.textContent, title: b.title, failed: b.classList.contains("failed"), shown, whole: shown && within(bb, rowBox) && (!foot || within(bb, foot)), cut: b.scrollWidth > b.clientWidth + 1, inCard: within(bb, nodeBox), inArea: !area || within(bb, area) };
      });
      const did = n.querySelector<HTMLElement>(".ls-card-did");
      const line = n.querySelector<HTMLElement>(".ls-card-line");
      const body = box(n.querySelector(".ls-card-body"));
      const words = box(n.querySelector(".ls-card-text"));
      const didBox = box(did);
      const lineBox = box(line);
      // a row too tall for what's left moved to the body's second column, past its edge: gone, not cut; and the same
      // within the words
      const inFirstColumn = (b: Box | null) => !!b && !!body && b.x < body.x + body.w - 0.5;
      const inWords = (b: Box | null) => inFirstColumn(words) && !!b && !!words && b.x < words.x + words.w - 0.5;
      const didShown = inWords(didBox);
      const lineShown = inWords(lineBox);
      const footShown = !body || inFirstColumn(foot);
      for (const b of badges) if (!footShown) b.shown = b.whole = false;
      /** Its height is whole lines of its type, at least one. */
      const wholeLines = (el: HTMLElement) => {
        const cs = getComputedStyle(el);
        const lines = parseFloat(cs.height) / parseFloat(cs.lineHeight);
        return lines >= 0.99 && Math.abs(lines - Math.round(lines)) < 0.02;
      };
      const owner = n.querySelector<HTMLElement>(".ls-card-owner");
      const ownerBox = box(owner);
      const ownerShown = footShown && !!ownerBox && !!rowBox && ownerBox.y < rowBox.y + rowBox.h - 1;
      const head = box(n.querySelector(".ls-card-head"));
      // a stack's other tabs' names: the same, in the column over the body
      const mid = box(n.querySelector(".ls-card-mid"));
      const tabs = box(n.querySelector(".ls-card-tabs"));
      const tabsShown = !!tabs && !!mid && tabs.x < mid.x + mid.w - 0.5;
      // a foot's word narrower than its text, by however little: it ends in an ellipsis. Measured against a copy free to
      // be its own width, as a fraction of a pixel is enough
      const wordsCut = [...n.querySelectorAll<HTMLElement>(".ls-card-foot > .ls-card-status")].some((word) => {
        const free = word.cloneNode(true) as HTMLElement;
        free.style.cssText = "position:absolute;visibility:hidden;flex:none;overflow:visible;width:auto;max-width:none";
        word.parentElement!.appendChild(free);
        const whole = free.getBoundingClientRect().width;
        free.remove();
        return word.getBoundingClientRect().width < whole - 0.001;
      });
      const acts = [...n.querySelectorAll<HTMLElement>(".ls-card-acts button")].map((b) => ({ label: b.textContent, whole: within(box(b), nodeBox) }));
      const diffCell = n.querySelector<HTMLElement>(".ls-foot .ls-diff");
      return {
        id,
        mode: n.classList.contains("card") ? "card" : n.classList.contains("live") ? "live" : [...n.classList].find((c) => ["still", "snapshot", "focus", "placeholder"].includes(c)) ?? "other",
        rowClips: row ? getComputedStyle(row).overflow === "hidden" : null,
        rowInCard: !rowBox || !badges.some((b) => b.shown) || within(rowBox, nodeBox),
        rowInFoot: !rowBox || !badges.some((b) => b.shown) || within(rowBox, foot),
        badges,
        rows: n.classList.contains("card")
          ? {
              head: within(head, nodeBox),
              // the foot whole, and each of its words inside it: one that gave way ends in an ellipsis, never past its edge
              foot: {
                shown: footShown,
                whole: !footShown || (within(foot, body) && within(foot, nodeBox) && [...n.querySelectorAll(".ls-card-foot > :not(.ls-badges)")].every((p) => { const pb = box(p); return !pb || pb.w === 0 || within(pb, foot); })),
              },
              did: did ? { shown: didShown, whole: !didShown || (within(didBox, body) && within(didBox, nodeBox)) } : null,
              line: line ? { shown: lineShown, whole: !lineShown || (within(lineBox, body) && within(lineBox, nodeBox) && wholeLines(line)) } : null,
              owner: owner ? { shown: ownerShown, whole: !ownerShown || (within(ownerBox, rowBox) && within(ownerBox, foot)) } : null,
              tabs: tabs ? { shown: tabsShown, whole: !tabsShown || (within(tabs, mid) && within(tabs, nodeBox)) } : null,
              wordsCut,
              acts,
            }
          : null,
        line: line?.textContent ?? null,
        did: did ? { text: did.textContent, title: did.title, failed: did.classList.contains("bad"), inCard: !didShown || within(didBox, nodeBox), inArea: !area || !didShown || within(didBox, area) } : null,
        diffCell: diffCell ? { text: diffCell.querySelector(".v")?.textContent ?? null, title: diffCell.title, failed: diffCell.classList.contains("failed"), inNode: within(box(diffCell), nodeBox), inArea: !area || within(box(diffCell), area) } : null,
      };
    });
  out.band = band;
  out.workspaces = workspaces();
  out.said = [...said];

  // s1's diff source failing from now on: its badge says so on the next refresh, never its old value
  const s1 = env.sessions().find((s) => s.id === "s1")!;
  const diffNow = () => {
    const el = node("s1")?.querySelector<HTMLElement>('.ls-badge[data-badge="diff"], .ls-foot .ls-diff');
    return el ? { text: (el.querySelector(".v") ?? el).textContent, title: el.title } : null;
  };
  const stale: Record<string, unknown> = { before: diffNow() };
  env.badgeFails.add("diff");
  env.emit("onFolderChanged", s1.cwd);
  await sleep(600);
  stale.after = diffNow();
  stale.said = said.filter((m) => m.includes("couldn't read its changes against its base for"));
  env.badgeFails.delete("diff");
  env.emit("onFolderChanged", s1.cwd);
  await sleep(600);
  stale.again = diffNow();
  // read once per folder: the cards on s1's folder asked once for each change, not once each
  stale.asked = env.calls.filter((c) => c.fn === "branchStat").length;
  out.stale = stale;

  // the meters read again after failing: their note goes from the status bar and the cost badge has its value
  if (env.badgeFails.has("meters")) {
    const note = () => [...document.querySelectorAll<HTMLElement>(".statusbar .update-note.bad")].map((n) => n.title).filter((t) => t.includes("token meters"));
    const cost = () => node("s1")?.querySelector('[data-badge="cost"]')?.textContent ?? null;
    const today = () => /today/.test(document.querySelector(".usage-wrap .usage")?.textContent ?? "");
    const failing = note();
    const todayFailing = today();
    env.badgeFails.delete("meters");
    const fine = await (window as unknown as { mb: { metersGet: () => Promise<unknown> } }).mb.metersGet();
    env.emit("onMetersChanged", fine);
    await sleep(500);
    const back = { after: note(), cost: cost(), today: today() };
    // a later sync failing: main pushes the failure, and what's shown from the meters goes with the note
    env.emit("onMetersChanged", { error: "the conversation index isn't available (transcripts:sync: SQLITE_BUSY: database is locked)" });
    await sleep(500);
    out.metersBack = { failing, todayFailing, ...back, pushed: { note: note(), cost: cost(), today: today() } };
  }
}
