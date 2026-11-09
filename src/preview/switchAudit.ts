/**
 * ?landscapeSwitchAudit=<part> (with ?motion=off): what the grid offered that the landscape has to, worked as a person
 * would in the UI preview, into <script id="mb-landscape-switch-audit"> for test/uiLandscapeSwitch.test.ts.
 *
 * =stack (with ?lsCamera at a zoom that draws headers): a stack's ⋯ and its tree row's right-click; New tab in it, renaming
 * it from its ⋯ and from its name, Unstack with a teammate's tab left in it and with none; a workspace of its own's New
 * tab, cancelled and made. =locked (with ?lsLocked=5101): those rows off, saying why. =palette: ⌘K's rows, Focus, and its
 * room rows following the selected area. =notes: Ask for status said over the landscape, a note said off it in the status
 * bar, problems with room sessions, the tree's rooms, the Team view's stack row. =handoff, =review, =import: what they
 * make, beside what it goes on from (the first free spot elsewhere) and brought into view. =search: a Search window's
 * Match case, set and then read by the next Search window. =tabs (with ?lsCamera at a zoom that draws headers): a
 * right-click on a stack's back tab and on its front one, each tab's Rename… and Close….
 */
import type { Landscape, LandscapeState, Rect } from "../shared/landscape";
import { AREA_PAD, GAP } from "../shared/landscape";
import type { SessionInfo } from "../shared/types";

export interface SwitchAuditEnv {
  sessions: () => SessionInfo[];
  calls: { fn: string; args: unknown[] }[];
  /** The preview's stand-ins, which an audit replaces where the fixture answers "not simulated". */
  api: { handoffStart: unknown; reviewStart: unknown; landscapeUpdate: (patch: unknown) => Promise<unknown> };
  newSession: (over: Partial<SessionInfo>) => SessionInfo;
  /** Problems with room sessions as team rooms report them. */
  setLiveProblems: (problems: string[]) => void;
  /** Nobody's online in any room. */
  roomsEmpty: () => void;
  /** How many areas the file has. */
  areaCount: () => number;
  waitFor: (selector: string, then: (el: HTMLElement) => void, tries?: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stored = async (): Promise<Landscape> => (await (window as unknown as { mb: { landscapeGet: () => Promise<LandscapeState> } }).mb.landscapeGet()).landscape;
const node = (sel: string) => document.querySelector<HTMLElement>(`.ls-world ${sel}`);
const selectedFront = () => node(".ls-node.selected")?.dataset.front ?? null;
/** The keys the grid wrote: nothing the landscape does may change them, so a downgrade still has its grid. */
const legacy = () => Object.fromEntries(["mb.shown", "mb.pinned", "mb.activeGroup", "mb.trees", "mb.groupLayouts", "mb.wsTabs", "mb.wsOpen", "mb.collapsed", "mb.sideView"].map((k) => [k, localStorage.getItem(k)]));

/** The open menu's rows, as tests of the action model read them. */
const ctxRows = () => {
  const m = document.querySelector(".mb-ctx");
  return m ? [...m.children].map((e) => (e.classList.contains("mb-ctx-sep") ? "-" : e.classList.contains("mb-ctx-h") ? `# ${e.textContent}` : `${e.querySelector(".mb-ctx-t")?.textContent ?? ""}${(e as HTMLButtonElement).disabled ? " (off)" : ""}`)) : null;
};
const ctxRow = (text: string) => [...document.querySelectorAll<HTMLButtonElement>(".mb-ctx button")].find((x) => x.querySelector(".mb-ctx-t")?.textContent === text);
const ctxPick = async (text: string) => {
  const b = ctxRow(text);
  if (!b) throw new Error(`the menu has no ${text}: ${JSON.stringify(ctxRows())}`);
  b.click();
  await sleep(400);
};
const closeCtx = async () => {
  document.querySelector(".mb-ctx")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await sleep(200);
};
const moreOf = async (sel: string) => {
  const b = node(`${sel} .ls-more`);
  if (!b) throw new Error(`no ⋯ on ${sel}`);
  b.click();
  await sleep(250);
};
const rightClick = async (el: Element | null) => {
  if (!el) throw new Error("nothing to right-click");
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + Math.min(40, r.width / 2), clientY: r.top + r.height / 2 }));
  await sleep(250);
};
const typeField = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const dialogTitle = () => document.querySelector(".modal h3")?.textContent ?? null;
const dialogButton = (text: RegExp) => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => text.test(b.textContent ?? ""));
const cancelDialog = async () => {
  dialogButton(/^Cancel$/)?.click();
  await sleep(300);
};
const palette = async (): Promise<{ label: string; kbd: string | null }[]> => {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
  await sleep(300);
  return [...document.querySelectorAll(".palette .results .row")].map((r) => ({ label: r.querySelector(".lab")?.textContent ?? "", kbd: r.querySelector(".kbd")?.textContent ?? null }));
};
const paletteRun = async (label: RegExp) => {
  const row = [...document.querySelectorAll<HTMLElement>(".palette .results .row")].find((r) => label.test(r.querySelector(".lab")?.textContent ?? ""));
  if (!row) throw new Error(`⌘K has no ${label}`);
  row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  await sleep(500);
};
const paletteClose = async () => {
  document.querySelector(".palette input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await sleep(200);
};
const press = (el: Element | null | undefined, init: PointerEventInit = {}) => {
  ((el?.querySelector(".ls-head") ?? el) as HTMLElement | null)?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 4, ...init }));
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerId: 4 }));
};
const selectWs = async (id: string) => {
  press(node(`[data-front="${CSS.escape(id)}"]`));
  await sleep(300);
};
const noteText = () => document.querySelector(".ls-note")?.textContent ?? null;
const tabLabel = async (label: string) => {
  [...document.querySelectorAll<HTMLElement>(".tab")].find((b) => b.textContent?.trim() === label)!.click();
  await sleep(500);
};
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: Rect | undefined, a: Rect) => !!r && r.x >= a.x && r.y >= a.y && r.x + r.w <= a.x + a.w && r.y + r.h <= a.y + a.h;
const tabsOf = (sel: string) => [...document.querySelectorAll<HTMLElement>(`.ls-world ${sel} .ls-tab`)].map((t) => t.dataset.sid ?? t.dataset.closed);

async function stackPart(env: SwitchAuditEnv, out: Record<string, unknown>) {
  const api = '[data-ws="ws:5101/api"]';
  const places = (await stored()).stacks["5101/api"].placement;
  // ⋯, and the tree's row: the same rows
  await moreOf(api);
  out.stackMenu = ctxRows();
  await closeCtx();
  await rightClick(document.querySelector('.area-tree .lt-stack[data-ws="ws:5101/api"]'));
  out.treeMenu = ctxRows();
  await closeCtx();

  // New tab in it: the dialog says so, and what it makes is a tab of the stack, where the stack is
  await moreOf(api);
  await ctxPick("New tab in “api”…");
  out.newTab = { dialog: dialogTitle(), where: [...document.querySelectorAll(".modal .mb-select")].map((e) => e.textContent ?? "").find((t) => t.includes("opens as a tab") || t.includes("workspace")) ?? null };
  dialogButton(/^Start /)?.click();
  await sleep(1000);
  const newTab = env.sessions().at(-1)!;
  const afterTab = await stored();
  out.newTabMade = { group: newTab.taskGroup, tabbed: tabsOf(api).includes(newTab.id), placement: afterTab.stacks["5101/api"].placement, was: places, ownPlace: Object.hasOwn(afterTab.workspaces, newTab.id) };

  // renamed from its ⋯, then from its name on the header
  await moreOf(api);
  await ctxPick("Rename “api”…");
  const field = document.querySelector<HTMLInputElement>(".modal input");
  out.rename = { dialog: dialogTitle(), initial: field?.value ?? null };
  if (field) typeField(field, "api2");
  await sleep(50);
  field?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await sleep(800);
  const api2 = '[data-ws="ws:5101/api2"]';
  const renamed = await stored();
  out.renamed = { calls: env.calls.filter((c) => c.fn === "renameGroup").map((c) => c.args), keyed: Object.hasOwn(renamed.stacks, "5101/api2"), oldGone: !Object.hasOwn(renamed.stacks, "5101/api"), placement: renamed.stacks["5101/api2"]?.placement, tile: !!node(api2) };
  node(`${api2} .ls-stack-name`)?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  await sleep(300);
  out.renameByName = { dialog: dialogTitle(), initial: document.querySelector<HTMLInputElement>(".modal input")?.value ?? null, focused: !!document.querySelector(".ls-focus") };
  await cancelDialog();

  // Unstack with a teammate's tab in it: theirs stays where it is, this Mac's go where there's room
  let mark = env.calls.length;
  await moreOf(api2);
  await ctxPick("Unstack its tabs");
  await sleep(1000);
  const left = await stored();
  const mine = [...new Set(env.calls.slice(mark).filter((c) => c.fn === "setGroup").map((c) => c.args[0] as string))];
  out.unstackTheirs = {
    moved: env.calls.slice(mark).filter((c) => c.fn === "setGroup").map((c) => c.args),
    stackStays: left.stacks["5101/api2"]?.placement,
    was: places,
    tabs: tabsOf(api2),
    placed: mine.map((id) => inside(left.workspaces[id], left.areas["5101"])),
    clear: mine.every((id) => mine.every((o) => o === id || !overlap(left.workspaces[id], left.workspaces[o])) && !overlap(left.workspaces[id], left.stacks["5101/api2"].placement)),
  };

  // two workspaces stacked, then Unstack with nothing of a teammate's in it: the front keeps the stack's place, the other beside it
  await Promise.all(["s4", "s8"].map(async (id) => press(node(`[data-front="${id}"]`), { shiftKey: true })));
  await sleep(300);
  document.querySelector<HTMLElement>('.ls-selbar [data-act="stack"]')?.click();
  await sleep(900);
  const before = await stored();
  const key = Object.keys(before.stacks).find((k) => k.startsWith("5101/tabs"))!;
  const front = before.stacks[key].active;
  const other = front === "s4" ? "s8" : "s4";
  mark = env.calls.length;
  await moreOf(`[data-ws="ws:${key}"]`);
  await ctxPick("Unstack its tabs");
  await sleep(1000);
  const after = await stored();
  out.unstackMine = {
    order: env.calls.slice(mark).filter((c) => c.fn === "setGroup").map((c) => c.args),
    stackGone: !Object.hasOwn(after.stacks, key),
    frontAt: after.workspaces[front],
    was: before.stacks[key].placement,
    otherInArea: inside(after.workspaces[other], after.areas["5101"]),
    clear: !overlap(after.workspaces[front], after.workspaces[other]),
    front,
    fronts: [!!node(`[data-front="s4"]`), !!node(`[data-front="s8"]`)],
  };

  // a workspace of its own's New tab: cancelled, nothing changes
  const lone = '[data-front="s1"]';
  const beforeLone = await stored();
  mark = env.calls.length;
  await moreOf(lone);
  out.loneMenu = ctxRows();
  await ctxPick("New tab…");
  out.loneDialog = { dialog: dialogTitle(), where: [...document.querySelectorAll(".modal .mb-select")].map((e) => e.textContent ?? "").find((t) => t.includes("opens as a tab") || t.includes("workspace")) ?? null };
  await cancelDialog();
  out.loneCancelled = { setGroup: env.calls.slice(mark).filter((c) => c.fn === "setGroup").length, same: JSON.stringify((await stored()).workspaces.s1) === JSON.stringify(beforeLone.workspaces.s1) };
  // made: the two a stack in its place, the new one in front
  await moreOf(lone);
  await ctxPick("New tab…");
  const count = env.sessions().length;
  dialogButton(/^Start /)?.click();
  await sleep(1200);
  const made = await stored();
  const madeId = env.sessions().at(-1)!;
  const stack = madeId.taskGroup ?? "";
  out.loneMade = {
    count: env.sessions().length - count,
    key: stack,
    placement: made.stacks[stack]?.placement ?? null,
    was: beforeLone.workspaces.s1,
    front: made.stacks[stack]?.active === madeId.id,
    s1Group: env.sessions().find((s) => s.id === "s1")?.taskGroup ?? null,
    s1PlaceLetGo: !Object.hasOwn(made.workspaces, "s1"),
    tabs: tabsOf(`[data-ws="ws:${stack}"]`),
  };
}

async function lockedPart(out: Record<string, unknown>) {
  await moreOf('[data-ws="ws:5101/api"]');
  const unstack = ctxRow("Unstack its tabs");
  out.stack = { off: unstack?.disabled, why: unstack?.title, newTab: !ctxRow("New tab in “api”…")?.disabled };
  await closeCtx();
  await moreOf('[data-front="s1"]');
  const tab = ctxRow("New tab…");
  out.lone = { off: tab?.disabled, why: tab?.title };
  await closeCtx();
}

const roomRows = (rows: { label: string }[]) => rows.filter((r) => /^(Invite|Share|House board)/.test(r.label)).map((r) => r.label);
const gridRows = (rows: { label: string }[]) => rows.filter((r) => /^(Pin |Unpin |Arrange in|Fullscreen|Exit fullscreen)/.test(r.label)).map((r) => r.label);
const numbered = (rows: { label: string; kbd: string | null }[]) => rows.filter((r) => /^⌘[0-9]$/.test(r.kbd ?? "")).map((r) => r.label);

async function palettePart(out: Record<string, unknown>) {
  const keys = legacy();
  // nothing selected: no room's rows to act on, nothing of the grid's
  const none = await palette();
  await paletteClose();
  out.none = { room: roomRows(none), grid: gridRows(none), numbered: numbered(none) };
  out.treeRow = none.find((r) => r.label.includes("the area tree"))?.label ?? null;
  // a session in a room's area, then one in an area that's no room
  await selectWs("s1");
  const room = await palette();
  out.room = { room: roomRows(room), grid: gridRows(room), numbered: numbered(room), focus: room.find((r) => r.label.startsWith("Focus "))?.kbd ?? null };
  await paletteRun(/^Focus Org dropdowns/);
  await sleep(600);
  out.focused = { front: document.querySelector<HTMLElement>(".ls-focus .ls-node")?.dataset.front ?? null };
  document.querySelector<HTMLElement>(".ls-focus .ls-back")?.click();
  await sleep(500);
  await selectWs("s5");
  const plain = await palette();
  out.plain = roomRows(plain);
  await paletteRun(/^Share .* as a team room$/);
  out.share = dialogTitle();
  out.legacyKeysUnchanged = JSON.stringify(legacy()) === JSON.stringify(keys);
}

async function notesPart(env: SwitchAuditEnv, out: Record<string, unknown>) {
  const counted = () => document.querySelector(".statusbar")?.textContent?.match(/(\d+) areas?/)?.[1] ?? null;
  out.areas = { said: counted(), file: env.areaCount() };
  // the tree's filter narrows the tree, not what the status bar counts
  const find = document.querySelector<HTMLInputElement>('.area-tree input[aria-label="Find a workspace"]');
  if (find) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(find, "Org dropdowns");
    find.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(200);
    out.areasFiltered = counted();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(find, "");
    find.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(200);
  }
  // Ask for status: said where the view is
  node(".ls-area[data-area='5102'] .ls-ah button[data-tip^='Ask every agent']")?.click();
  await sleep(300);
  out.asked = noteText();
  // off the landscape: in the status bar
  await tabLabel("Dashboard");
  await palette();
  await paletteRun(/^Reopen all \(\d+\) — the Closed sessions list/);
  await sleep(1000);
  out.offLandscape = document.querySelector(".statusbar .update-note:not(.bad)")?.textContent ?? null;
  await tabLabel("Sessions");
  // what team rooms can't publish, said in the tree's foot
  env.setLiveProblems(["Couldn't publish “Org dropdowns” to the room: the record is too large"]);
  await sleep(300);
  out.problems = [...document.querySelectorAll(".area-tree .team-live-problems .err")].map((e) => e.textContent);
  const rooms = () => [...document.querySelectorAll<HTMLElement>(".area-tree .lt-area")].map((a) => ({ area: a.dataset.area, online: a.querySelectorAll(".lt-head .lt-av").length, shared: a.querySelector(".lt-head .lt-tag")?.textContent ?? null }));
  out.rooms = rooms();
  env.roomsEmpty();
  await sleep(300);
  out.roomsEmpty = rooms();
  // the Team view's row of a stack brings it into view, as the area tree's does
  document.querySelector<HTMLElement>(".lt-connected .connected-line")?.click();
  await sleep(500);
  const keys = legacy();
  const label = document.querySelector<HTMLElement>(".room-sess-body .sub-label[data-ws]");
  label?.click();
  await sleep(700);
  out.teamStack = { row: label?.dataset.ws ?? null, selected: node(".ls-node.selected")?.dataset.ws ?? null, keysUnchanged: JSON.stringify(legacy()) === JSON.stringify(keys) };
}

/**
 * Workspace `id` two rows down its area, with `swap` in its place there, and the area under it out of the way: the first
 * free spot is then elsewhere than beside it.
 */
async function apart(env: SwitchAuditEnv, id: string, area: string, swap: string, under: string): Promise<Rect> {
  const l = await stored();
  const r = l.workspaces[id];
  const a = l.areas[area];
  const y = r.y + 2 * (r.h + GAP);
  const away = 4 * (r.h + GAP);
  const below = Object.entries(l.workspaces).filter(([, w]) => inside(w, l.areas[under]));
  await env.api.landscapeUpdate({
    workspaces: { ...Object.fromEntries(below.map(([k, w]) => [k, { ...w, y: w.y + away }])), [id]: { ...r, y }, [swap]: r },
    areas: { [area]: { h: y + r.h + AREA_PAD - a.y }, [under]: { y: l.areas[under].y + away } },
  });
  await sleep(400);
  return { ...r, y };
}

async function handoffPart(env: SwitchAuditEnv, out: Record<string, unknown>) {
  const at = await apart(env, "s5", "5102", "s6", "5110");
  let id = "";
  env.api.handoffStart = async () => {
    const s = env.newSession({ taskGroup: "5102", agent: "codex", title: "Continued in Codex" });
    id = s.id;
    return s;
  };
  // the dialog closed without starting lets its place go, and what's made next goes where new ones go
  await moreOf('[data-front="s5"]');
  await ctxPick("Fresh session from a brief…");
  await cancelDialog();
  const other = env.newSession({ taskGroup: "5102", title: "Made elsewhere" });
  await sleep(600);
  out.afterCancel = { at: (await stored()).workspaces[other.id], first: { x: at.x + at.w + GAP, y: at.y } };
  await env.api.landscapeUpdate({ workspaces: { [other.id]: null } });
  await moreOf('[data-front="s5"]');
  await ctxPick("Continue in Codex…");
  await sleep(1300);
  const close = document.querySelector<HTMLInputElement>(".modal input[type=checkbox]");
  close?.click();
  await sleep(50);
  dialogButton(/^Start /)?.click();
  await sleep(1400);
  const l = await stored();
  out.handoff = { made: !!id, at: l.workspaces[id], of: at, selected: selectedFront() === id, dialog: !!document.querySelector(".modal"), killed: env.calls.filter((c) => c.fn === "killSession").map((c) => c.args), ghost: !!node('.ls-ghost[data-ghost="s5"], [data-ghost="s5"]') };
}

async function reviewPart(env: SwitchAuditEnv, out: Record<string, unknown>) {
  const at = await apart(env, "s5", "5102", "s6", "5110");
  let id = "";
  env.api.reviewStart = async () => {
    const s = env.newSession({ taskGroup: "5102", agent: "codex", title: "Second opinion" });
    id = s.id;
    return s;
  };
  await moreOf('[data-front="s5"]');
  await ctxPick("Second opinion from Codex");
  await sleep(1200);
  out.review = { made: !!id, at: (await stored()).workspaces[id], of: at, drawn: !!node(`[data-front="${CSS.escape(id)}"]`) };
}

async function importPart(env: SwitchAuditEnv, out: Record<string, unknown>) {
  const keys = legacy();
  const ids = new Set(env.sessions().map((s) => s.id));
  [...document.querySelectorAll<HTMLElement>(".topbar button")].find((b) => b.textContent?.startsWith("Import"))?.click();
  await new Promise<void>((ok) => env.waitFor(".import-dlg .pick-list .item:not(.blocked)", () => ok()));
  document.querySelector<HTMLElement>(".import-dlg .pick-list .item:not(.blocked)")?.click();
  await sleep(200);
  document.querySelector<HTMLElement>(".import-dlg button.primary")?.click();
  await sleep(1400);
  const opened = env.sessions().find((s) => !ids.has(s.id));
  out.imported = { opened: !!opened, placed: !!opened && !!(await stored()).workspaces[opened.id], selected: !!opened && selectedFront() === opened.id, dialog: !!document.querySelector(".import-dlg"), keysUnchanged: JSON.stringify(legacy()) === JSON.stringify(keys) };
}

/** A Search window's options are the next one's, as the side bar's Search kept them (mb.search). */
async function searchPart(out: Record<string, unknown>) {
  const win = () => document.querySelector<HTMLElement>('.ls-window[data-tool="search"]');
  const filesTab = () => [...(win()?.querySelectorAll<HTMLElement>('.sv-scope [role="tab"]') ?? [])].find((t) => t.textContent?.trim() === "Files") ?? null;
  // Match case shows only on the Files scope
  const matchCase = () => win()?.querySelector<HTMLElement>('.sv-opt[title="Match case"]') ?? null;
  const state = () => ({ open: !!win(), files: filesTab()?.getAttribute("aria-selected") ?? null, matchCase: matchCase()?.getAttribute("aria-pressed") ?? null });
  const searchKey = async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "f", shiftKey: true, metaKey: true, bubbles: true, cancelable: true }));
    await sleep(500);
  };
  await selectWs("s1");
  await searchKey();
  out.first = state();
  filesTab()?.click();
  await sleep(300);
  matchCase()?.click();
  await sleep(300);
  out.saved = JSON.parse(localStorage.getItem("mb.search") ?? "null");
  win()?.querySelector<HTMLElement>('[aria-label="Close Search"]')?.click();
  await sleep(400);
  out.closed = !win();
  await selectWs("s5");
  await searchKey();
  out.next = state();
}

/** A right-click on a stack's tab is that tab's session's: s3, behind s2 in 5101/api, renamed and closed as itself. */
async function tabsPart(env: SwitchAuditEnv, out: Record<string, unknown>) {
  const tab = (id: string) => node(`.ls-tab[data-sid="${id}"]`);
  out.front = node(".ls-tab.on")?.dataset.sid ?? null;
  const renameFrom = async (id: string) => {
    await rightClick(tab(id));
    await ctxPick("Rename…");
    const value = document.querySelector<HTMLInputElement>(".modal input")?.value ?? null;
    await cancelDialog();
    return value;
  };
  out.renameBack = await renameFrom("s3");
  out.renameFront = await renameFrom("s2");
  await rightClick(tab("s3"));
  out.backRows = ctxRows();
  const before = env.calls.length;
  await ctxPick("Close…");
  await sleep(600);
  out.close = {
    dialog: dialogTitle(),
    named: env.calls.slice(before).flatMap((c) => (typeof c.args[0] === "string" && /^s[23]$/.test(c.args[0]) ? [`${c.fn}:${c.args[0]}`] : [])),
  };
  await cancelDialog();
  out.frontAfter = node(".ls-tab.on")?.dataset.sid ?? null;
}

export function runSwitchAudit(env: SwitchAuditEnv, part: string): void {
  env.waitFor(".ls-world .ls-node", async () => {
    const out: Record<string, unknown> = {};
    try {
      await sleep(600);
      if (part === "stack") await stackPart(env, out);
      else if (part === "locked") await lockedPart(out);
      else if (part === "palette") await palettePart(out);
      else if (part === "notes") await notesPart(env, out);
      else if (part === "handoff") await handoffPart(env, out);
      else if (part === "review") await reviewPart(env, out);
      else if (part === "import") await importPart(env, out);
      else if (part === "search") await searchPart(out);
      else if (part === "tabs") await tabsPart(env, out);
      else throw new Error(`no part ${part}`);
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-landscape-switch-audit";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  });
}
