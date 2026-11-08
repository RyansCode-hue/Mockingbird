/**
 * ?landscapeNeedsAudit=a|b (with ?labs=landscape&motion=off): S7's Needs you and card badges, worked as a person would
 * in the UI preview, into <script id="mb-landscape-needs-audit"> for test/uiLandscapeNeeds.test.ts.
 *
 * =a (with ?joinRequest=later): the button and the tray's items; N and ⇧N from the landscape (the keyboard kept there),
 * in the tray, and refused in a text field and a terminal; Dismiss, and the item back when its state changes; a copy a
 * teammate took over leaving it; the areas' counts in the tree, a collapsed area's pill and the switcher; Go there
 * on a permission prompt, a join request and from another tab.
 * =b: the badges as drawn at the camera's zoom (?lsCamera), each card's or workspace's, with their boxes against their
 * workspace's and their area's; then s1's diff source failing, which its badge then says rather than its old value.
 * With ?badgeFail=… it reports what the failing sources show, and what was said in the console.
 */
import type { SessionInfo } from "../shared/types";

export interface NeedsAuditEnv {
  sessions: () => SessionInfo[];
  /** Change session `id` as main would, and tell the window. */
  setSession: (id: string, over: Partial<SessionInfo>) => void;
  /** Change session `id`'s room tag as team rooms report it (null: back to the fixture's), and tell the window. */
  setOwnTag: (id: string, over: Partial<NonNullable<SessionInfo["room"]>> | null) => void;
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
const keyN = (el: Element, shift = false) => {
  const ev = new KeyboardEvent("keydown", { key: shift ? "N" : "n", shiftKey: shift, bubbles: true, cancelable: true });
  Object.defineProperty(ev, "keyCode", { get: () => 78 });
  el.dispatchEvent(ev);
};
const selectedWs = () => document.querySelector<HTMLElement>(".ls-world .ls-node.selected")?.dataset.front ?? null;
const selectedArea = () => document.querySelector<HTMLElement>(".ls-world .ls-area.selected, .ls-world .ls-area-pill.selected")?.dataset.area ?? null;
const camera = () => document.querySelector<HTMLElement>(".ls-world")?.style.transform ?? "";
const keyboard = () => (document.activeElement === vp() ? "landscape" : document.activeElement?.closest(".ny-tray") ? "tray" : document.activeElement?.closest(".xterm") ? "terminal" : (document.activeElement?.tagName ?? "none"));
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
    acts: [...el.querySelectorAll<HTMLButtonElement>(".ny-acts button")].map((b) => ({ key: b.dataset.action ?? null, label: b.textContent, disabled: b.disabled, title: b.title })),
  })),
  foot: document.querySelector(".ny-tray .ny-foot")?.textContent ?? null,
  none: document.querySelector(".ny-tray .ny-none")?.textContent ?? null,
});
const treeBadges = () => Object.fromEntries([...document.querySelectorAll<HTMLElement>(".area-tree .lt-area")].map((a) => [a.dataset.area, a.querySelector(".lt-head .lt-badge")?.textContent ?? null]));
const openTray = async () => {
  if (!document.querySelector(".ny-tray")) document.querySelector<HTMLElement>(".ny-btn")?.click();
  await sleep(250);
};
const closeTray = async () => {
  if (document.querySelector(".ny-tray")) document.querySelector<HTMLElement>(".ny-btn")?.click();
  await sleep(200);
};
const act = (item: string, key: string) => document.querySelector<HTMLElement>(`.ny-tray .ny-item[data-item="${CSS.escape(item)}"] button[data-action="${key}"]`)?.click();

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

export function runNeedsAudit(env: NeedsAuditEnv, part: string): void {
  const write = (out: unknown) => {
    const el = document.createElement("script");
    el.type = "application/json";
    el.id = "mb-landscape-needs-audit";
    el.textContent = JSON.stringify(out);
    document.body.appendChild(el);
  };
  env.waitFor(".ls-world .ls-node", async () => {
    const out: Record<string, unknown> = {};
    try {
      await sleep(1500);
      if (part === "a") await trayPart(env, out);
      else await badgePart(env, out);
    } catch (err) {
      out.error = String((err as Error)?.stack ?? err);
    }
    write(out);
  }, 300);
}

async function trayPart(env: NeedsAuditEnv, out: Record<string, unknown>): Promise<void> {
  const term = (id: string) => (window as unknown as { __mbTerms?: Map<string, { term: { textarea?: HTMLTextAreaElement } }> }).__mbTerms?.get(id)?.term;
  out.button = button();
  out.tree = treeBadges();
  await openTray();
  out.tray = tray();
  out.trayKeyboard = keyboard();
  await closeTray();

  // N and ⇧N on the landscape: the view goes to each item in turn, the keyboard staying with the landscape
  vp().focus();
  const steps: unknown[] = [];
  for (const shift of [false, false, false, false, true]) {
    const cam = camera();
    keyN(vp(), shift);
    await sleep(700);
    steps.push({ shift, ws: selectedWs(), area: selectedArea(), keyboard: keyboard(), moved: camera() !== cam, prompt: !!document.querySelector(".join-ask") });
    vp().focus();
  }
  out.steps = steps;
  // where the view is, lit in the tray; N in the tray moves on, the tray staying open
  await openTray();
  out.litAfterSteps = tray().items.filter((i) => i.on).map((i) => i.id);
  keyN(document.querySelector(".ny-tray .ny-in")!);
  await sleep(600);
  out.inTray = { ws: selectedWs(), open: tray().open, lit: tray().items.filter((i) => i.on).map((i) => i.id) };
  await closeTray();

  // never in a text field or a terminal
  const filter = document.querySelector<HTMLInputElement>(".area-tree .lt-find input")!;
  const before = { ws: selectedWs(), area: selectedArea() };
  filter.focus();
  keyN(filter);
  await sleep(400);
  out.inField = { before, ws: selectedWs(), area: selectedArea() };
  vp().focus();
  vp().dispatchEvent(new KeyboardEvent("keydown", { key: "1", metaKey: true, bubbles: true, cancelable: true }));
  await sleep(800);
  (document.querySelector<HTMLElement>('.ls-world [data-front="s1"] .ls-head') ?? document.querySelector<HTMLElement>('.ls-world [data-front="s1"]'))!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 7 }));
  await sleep(300);
  const ta = term("s1")?.textarea;
  const w0 = env.calls.length;
  ta?.focus();
  if (ta) keyN(ta);
  await sleep(400);
  out.inTerminal = {
    textarea: !!ta,
    ws: selectedWs(),
    keyboard: keyboard(),
    wrote: env.calls.slice(w0).filter((c) => c.fn === "sessionWrite" && c.args[0] === "s1").map((c) => String(c.args[1])),
  };
  vp().focus();

  // Dismiss: off the list until its state changes, and the counts with it
  await openTray();
  act("s:s8", "dismiss");
  await sleep(300);
  out.dismissed = { tray: tray(), button: button(), tree: treeBadges() };
  await closeTray();
  env.setSession("s8", { status: "working", finishedAt: null });
  await sleep(200);
  env.setSession("s8", { status: "idle", finishedAt: Date.now() });
  await sleep(400);
  await openTray();
  out.back = { ids: tray().items.map((i) => i.id), button: button(), foot: tray().foot };
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
  await (window as unknown as { mb: { landscapeUpdate: (p: unknown, what: string) => Promise<unknown> } }).mb.landscapeUpdate({ areas: { "5101": { collapsed: true } } }, "audit: 5101 collapsed");
  await sleep(500);
  const pill = document.querySelector<HTMLElement>('.ls-area-pill[data-area="5101"]');
  out.pill = { count: pill?.querySelector(".w")?.textContent ?? null, title: pill?.querySelector(".w")?.getAttribute("title") ?? null };
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true, bubbles: true, cancelable: true }));
  await sleep(400);
  out.switcher = Object.fromEntries([...document.querySelectorAll<HTMLElement>(".ls-switcher .ls-sw")].map((b) => [b.dataset.area, b.querySelector(".w")?.textContent ?? null]));
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true, bubbles: true, cancelable: true }));
  await (window as unknown as { mb: { landscapeUpdate: (p: unknown, what: string) => Promise<unknown> } }).mb.landscapeUpdate({ areas: { "5101": { collapsed: false } } }, "audit: 5101 opened");
  await sleep(600);

  // Go there on the permission prompt: the tray goes, the workspace is selected and its terminal has the keyboard
  vp().focus();
  await openTray();
  act("s:s2", "go");
  await sleep(900);
  out.goPermission = { open: tray().open, ws: selectedWs(), terminal: document.activeElement === term("s2")?.textarea };
  // Go there on the join request: its room's area, and the admin's prompt for it
  vp().focus();
  await openTray();
  const join = tray().items.find((i) => i.kind === "join")?.id ?? "";
  act(join, "go");
  await sleep(700);
  out.goJoin = { open: tray().open, area: selectedArea(), ws: selectedWs(), prompt: document.querySelector(".join-ask h3")?.textContent ?? null };
  document.querySelector<HTMLElement>('.join-ask button[title^="Answer later"]')?.click();
  await sleep(300);
  // from another tab, Go there comes back to the landscape
  [...document.querySelectorAll<HTMLElement>(".tab")].find((b) => b.textContent?.trim() === "Dashboard")?.click();
  await sleep(500);
  await openTray();
  act("s:s8", "go");
  await sleep(900);
  out.goFromTab = { tab: document.querySelector(".tab.on")?.textContent?.trim() ?? null, ws: selectedWs() };
}

async function badgePart(env: NeedsAuditEnv, out: Record<string, unknown>): Promise<void> {
  const band = [...vp().classList].find((c) => c.startsWith("ls-band-"))?.slice(8) ?? null;
  const areaOf = (id: string) => {
    const s = env.sessions().find((x) => x.id === id);
    const top = s?.taskGroup?.split("/")[0] ?? null;
    return document.querySelector(`.ls-world .ls-area[data-area="${CSS.escape(top ?? "")}"]`);
  };
  const workspaces = () =>
    [...document.querySelectorAll<HTMLElement>(".ls-world .ls-node")].map((n) => {
      const id = n.dataset.front!;
      const node = box(n);
      const area = box(areaOf(id));
      const row = n.querySelector(".ls-badges");
      const rowBox = box(row);
      const badges = [...n.querySelectorAll<HTMLElement>(".ls-badge")].map((b) => {
        const bb = box(b);
        // a badge that didn't fit wrapped onto the row's second line, which it never shows
        const shown = !!bb && !!rowBox && bb.y < rowBox.y + rowBox.h - 1;
        return { key: b.dataset.badge ?? null, text: b.textContent, title: b.title, failed: b.classList.contains("failed"), shown, cut: b.scrollWidth > b.clientWidth + 1, inCard: within(bb, node), inArea: !area || within(bb, area) };
      });
      const did = n.querySelector<HTMLElement>(".ls-card-did");
      const diffCell = n.querySelector<HTMLElement>(".ls-foot .ls-diff");
      return {
        id,
        mode: n.classList.contains("card") ? "card" : n.classList.contains("live") ? "live" : [...n.classList].find((c) => ["still", "snapshot", "focus", "placeholder"].includes(c)) ?? "other",
        rowClips: row ? getComputedStyle(row).overflow === "hidden" : null,
        rowInCard: !rowBox || within(rowBox, node),
        badges,
        did: did ? { text: did.textContent, title: did.title, failed: did.classList.contains("bad"), inCard: within(box(did), node), inArea: !area || within(box(did), area) } : null,
        diffCell: diffCell ? { text: diffCell.querySelector(".v")?.textContent ?? null, title: diffCell.title, failed: diffCell.classList.contains("failed"), inNode: within(box(diffCell), node), inArea: !area || within(box(diffCell), area) } : null,
      };
    });
  out.band = band;
  out.workspaces = workspaces();
  out.said = [...said];

  // s1's diff source failing from now on: its badge says so on the next refresh, never its old value
  const s1 = env.sessions().find((s) => s.id === "s1")!;
  const diffNow = () => {
    const n = document.querySelector<HTMLElement>('.ls-world [data-front="s1"]');
    const el = n?.querySelector<HTMLElement>('.ls-badge[data-badge="diff"], .ls-foot .ls-diff');
    return el ? { text: (el.querySelector(".v") ?? el).textContent, title: el.title } : null;
  };
  const stale: Record<string, unknown> = { before: diffNow() };
  env.badgeFails.add("diff");
  env.emit("onFolderChanged", s1.cwd);
  await sleep(600);
  stale.after = diffNow();
  stale.said = said.filter((m) => m.includes("its changes against its base for s1"));
  env.badgeFails.delete("diff");
  env.emit("onFolderChanged", s1.cwd);
  await sleep(600);
  stale.again = diffNow();
  out.stale = stale;
}
