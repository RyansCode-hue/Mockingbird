/**
 * ?landscapeFirstRunAudit=k|t|e|b (with ?motion=off): S8's first run, worked as a person would in the UI
 * preview, into <script id="mb-landscape-first-run-audit"> for test/uiLandscapeFirstRun.test.ts. Keys, the wheel and the
 * mouse go through the test's Chrome driver (scripts/ui-preview.mjs), so they reach whatever really has the keyboard or
 * is under the pointer; a page with no driver reports `driver: false` and proves nothing.
 *
 * =k: every row of the shortcuts sheet driven (`driven`, by the row's id), and `?` refused in a terminal and a text field.
 * =t (with ?lsTour): the tour's steps (`steps`: the ring, the target and the card at each), its keyboard, and how it ends:
 * &do=skip|esc|next|done. Reloads with ?lsPersist to say whether it comes back.
 * =u: the tour against what else is going on, by &case=terminal|typing|dropped|keys|field|ring|handle|undo|dialog|palette|focus|tray.
 * =c: the camera the tour moves, by &case=esc|skip|tab|restart|goto (cameraPart).
 * =a: typed keys against the landscape's arming (keyArm.ts), by &case=tour|peekLog|peekGone|jumpInTour|jumpKeys|press|zoomOut|cap|frame|
 * walk|pressNothing|mount|hud|hint|button|frameButton|lag|join|tabWalk|escape.
 * =e (with ?lsOnly=…): what's in the empty landscape's place, right-clicks all over it, its tiles and its links;
 * &tile=helpdesk presses the Helpdesk tasks tile last (with ?lsHelpdeskRoom, where main refuses it).
 * =b: the top bar's boxes at this window's width, + New's menu and its »; &case=tab for + New on another tab, &case=fold
 * for what folds, &case=sheet for the sheet at this size and beside the tray and the palette.
 */
import type { Landscape as Stored, LandscapePatch } from "../shared/landscape";
import type { SessionInfo } from "../shared/types";
import { SHORTCUTS } from "../renderer/landscapeShortcuts";
import { consoleSaid, drive, type Asked } from "./needsYouAudit";
import { armFocus } from "../renderer/keyArm";
import { PEEK_HOVER_MS } from "../renderer/landscapeModel";
import { wiresNow } from "../renderer/WireLayer";
import { wiresInOrder } from "../shared/wires";

export interface FirstRunEnv {
  sessions: () => SessionInfo[];
  calls: { fn: string; args: unknown[] }[];
  stored: () => Stored;
  /** Change landscape.json as main would, and tell the window. */
  patch: (p: LandscapePatch) => void;
  /** A live session changed as main would say (`over`), or gone from the list (null): closed elsewhere, a pane dropped. */
  setSession: (id: string, over: Partial<SessionInfo> | null) => void;
  waitFor: (selector: string, then: (el: HTMLElement) => void, tries?: number) => void;
}

type Box = { x: number; y: number; w: number; h: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qs = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const vp = () => q(".ls-viewport")!;
const params = new URLSearchParams(location.search);
const box = (el: Element | null | undefined): Box | null => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
};
const within = (a: Box | null, b: Box | null, slack = 0.5) => !!a && !!b && a.x >= b.x - slack && a.y >= b.y - slack && a.x + a.w <= b.x + b.w + slack && a.y + a.h <= b.y + b.h + slack;
const overlap = (a: Box | null, b: Box | null) => !!a && !!b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const win = (): Box => ({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
const camera = () => {
  const m = /scale\(([\d.e-]+)\)\s*translate\((-?[\d.e-]+)px,\s*(-?[\d.e-]+)px\)/.exec(q(".ls-world")?.style.transform ?? "");
  return m ? { x: -Number(m[2]), y: -Number(m[3]), zoom: Number(m[1]) } : null;
};
const zoomNow = () => camera()?.zoom ?? NaN;
const moved = (a: ReturnType<typeof camera>, b: ReturnType<typeof camera>) => JSON.stringify(a) !== JSON.stringify(b);
const keyboard = () => {
  const a = document.activeElement;
  if (!a || a === document.body) return "body";
  if (a.classList.contains("mb-keys-nowhere")) return "nowhere";
  if (a === vp()) return "landscape";
  if (a.closest(".xterm")) return "terminal";
  if (a.closest(".ls-tour-card")) return "tour";
  if (a.closest(".ls-keys")) return "sheet";
  if (a.closest(".palette")) return "palette";
  if (a.closest(".modal")) return "dialog";
  if (a.closest(".mb-ctx")) return "menu";
  if (a.closest(".topbar")) return `topbar:${a.textContent?.trim() ?? ""}`;
  return a.tagName.toLowerCase();
};
const selected = () => q(".ls-world .ls-node.selected")?.dataset.front ?? null;
const picked = () => qs(".ls-world .ls-node.picked").length;
const menuRows = () =>
  qs(".mb-ctx:not(.mb-ghost) button, .mb-ctx:not(.mb-ghost) [role=presentation]").map((b) => b.querySelector(".mb-ctx-t")?.textContent ?? b.textContent ?? "");
const ctxBox = () => box(q(".mb-ctx:not(.mb-ghost)"));

async function act(these: Asked[]): Promise<void> {
  if (!(await drive(these))) throw new Error("no driver: this audit presses keys for real");
}
const press = (key: string, o: { shift?: boolean; meta?: boolean; alt?: boolean; ctrl?: boolean } = {}) => act([{ key, ...o }]);
const middle = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
const clickOn = (el: Element, o: { button?: "left" | "right"; shift?: boolean } = {}) => act([{ mouse: { ...middle(el), clickCount: 1, ...o } }]);
const rightAt = (x: number, y: number) => act([{ mouse: { x, y, clickCount: 1, button: "right" } }]);
/** A point on the bare landscape: over nothing drawn. */
function barePoint(): { x: number; y: number } {
  const r = vp().getBoundingClientRect();
  for (let y = r.top + 70; y < r.bottom - 60; y += 25)
    for (let x = r.left + 20; x < r.right - 20; x += 25) {
      const el = document.elementFromPoint(x, y);
      if (el === vp() || el?.classList.contains("ls-world")) return { x, y };
    }
  throw new Error("no bare landscape in view");
}
/** The keyboard to the landscape as a press on it gives it: armed (keyArm.ts). */
const giveLandscape = async () => {
  armFocus(vp());
  await sleep(40);
};
const afterEsc = async () => {
  await press("Escape");
  await sleep(120);
};

/** Fit the landscape at the driver's hands, so everything is on screen as cards or read-only. */
const fit = async () => {
  await giveLandscape();
  await press("0", { meta: true });
  await sleep(300);
};
const card = (front: string) => q(`.ls-world .ls-node[data-front="${front}"]`);
/** A workspace's edge dot, drawn only while it's big enough on screen for one. */
const dotOf = (front: string) => card(front)?.querySelector<HTMLElement>(":scope > .ls-wh") ?? null;

/** A row's printed keys one by one ("⌘0 / ⌘1": ⌘0 and ⌘1), every one of which its step has to drive. */
const tokensOf = (id: string): string[] =>
  (SHORTCUTS.flatMap((s) => s.rows).find((r) => r.id === id)?.keys ?? "")
    .split(/\s*(?:·|\/|, then)\s*/)
    .filter(Boolean);
const MODS: Record<string, "meta" | "shift" | "alt" | "ctrl"> = { "⌘": "meta", "⇧": "shift", "⌥": "alt", "⌃": "ctrl" };
const NAMED: Record<string, string> = { Esc: "Escape", Enter: "Enter", "⇥": "Tab", "←": "ArrowLeft", "→": "ArrowRight" };
/** The key press a printed key means: "⇧⌘F" is F with Shift and Command; null when it isn't one key. */
function keyOf(token: string): { key: string; meta?: boolean; shift?: boolean; alt?: boolean; ctrl?: boolean } | null {
  const o: { meta?: boolean; shift?: boolean; alt?: boolean; ctrl?: boolean } = {};
  let rest = token;
  while (rest && MODS[rest[0]]) {
    o[MODS[rest[0]]] = true;
    rest = rest.slice(1);
  }
  const key = NAMED[rest] ?? (rest.length === 1 ? (/[A-Za-z]/.test(rest) ? (o.shift ? rest.toUpperCase() : rest.toLowerCase()) : rest) : null);
  return key ? { key, ...o } : null;
}

/** Every row's proof, by its id: true once its key has done what the row says. */
async function keysPart(env: FirstRunEnv, out: Record<string, unknown>): Promise<void> {
  const driven: Record<string, boolean> = {};
  const why: Record<string, string> = {};
  // first, so the driver's "so far" (its first 600 characters) says which row a run that stalls was on
  out.rowNow = null;
  out.why = why;
  const used: Record<string, Set<string>> = {};
  const mark = (id: string, token: string) => {
    if (!tokensOf(id).includes(token)) throw new Error(`the sheet's ${id} row doesn't print ${token} (it prints ${tokensOf(id).join(", ")})`);
    (used[id] ??= new Set()).add(token);
  };
  /** Press what row `id` prints as `token`: a row's keys are pressed only as it prints them. */
  const pressAs = async (id: string, token: string) => {
    mark(id, token);
    const k = keyOf(token);
    if (!k) throw new Error(`${token} isn't a key press`);
    await press(k.key, k);
  };
  /** A gesture row `id` prints as `token` ("right-click"), which the step does with the mouse. */
  const doing = (id: string, token: string) => mark(id, token);
  const row = async (id: string, prove: () => Promise<boolean | string>) => {
    out.rowNow = id;
    try {
      const r = await prove();
      const missed = tokensOf(id).filter((t) => !used[id]?.has(t));
      driven[id] = r === true && !missed.length;
      if (r !== true) why[id] = typeof r === "string" ? r : "it didn't";
      else if (missed.length) why[id] = `it prints ${missed.join(", ")}, which nothing pressed`;
    } catch (err) {
      driven[id] = false;
      why[id] = String(err);
    }
  };
  const count = (tool: string) => qs(`.ls-window[data-tool="${tool}"]`).length;
  const selectFirst = async () => {
    await fit();
    await clickOn(card("s1")!);
    await sleep(150);
    await giveLandscape();
  };

  await sleep(400);
  out.keyboardAtStart = keyboard();
  await fit();

  await row("sheet", async () => {
    await press("?", { shift: true });
    await sleep(150);
    if (!q(".ls-keys")) return "? opened nothing";
    out.sheetRows = qs(".ls-keys-row").map((r) => r.dataset.row);
    out.sheetKeys = Object.fromEntries(qs(".ls-keys-row").map((r) => [r.dataset.row, r.querySelector("kbd")?.textContent ?? ""]));
    out.sheetSections = qs(".ls-keys-sec h4").map((h) => h.textContent);
    out.sheetBox = box(q(".ls-keys"));
    out.keysBtn = box(q(".tb-keys"));
    const inSheet = keyboard();
    await press("?", { shift: true });
    await sleep(150);
    out.sheetAfterToggle = { open: !!q(".ls-keys"), keyboard: keyboard() };
    await press("?", { shift: true });
    await sleep(120);
    await afterEsc();
    out.sheetAfterEsc = { open: !!q(".ls-keys"), keyboard: keyboard() };
    return inSheet === "sheet" && !q(".ls-keys");
  });

  // `?` in a text field and in a terminal is theirs
  const filter = q<HTMLInputElement>(".area-tree input");
  if (filter) {
    filter.focus();
    await press("?", { shift: true });
    await sleep(120);
    out.questionInField = { sheet: !!q(".ls-keys"), value: filter.value };
    filter.value = "";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
  }

  await row("pan", async () => {
    await giveLandscape();
    const p = barePoint();
    const a = camera();
    doing("pan", "Space-drag");
    await act([{ key: " ", hold: "down" }, { drag: { x0: p.x, y0: p.y, x1: p.x + 60, y1: p.y + 40 } }, { key: " ", hold: "up" }]);
    await sleep(120);
    const b = camera();
    doing("pan", "two fingers");
    await act([{ wheel: { x: p.x, y: p.y, dx: 30, dy: 30 } }]);
    await sleep(120);
    const c = camera();
    return moved(a, b) && moved(b, c) && a?.zoom === b?.zoom && b?.zoom === c?.zoom ? true : `space-drag ${moved(a, b)}, two fingers ${moved(b, c)}`;
  });
  await row("zoom", async () => {
    await giveLandscape();
    const p = barePoint();
    const a = zoomNow();
    doing("zoom", "⌘ scroll");
    await act([{ wheel: { x: p.x, y: p.y, dy: -120, meta: true } }]);
    await sleep(120);
    const b = zoomNow();
    // a pinch reaches the page as a wheel with Control held
    doing("zoom", "pinch");
    await act([{ wheel: { x: p.x, y: p.y, dy: -20, ctrl: true } }]);
    await sleep(120);
    const c = zoomNow();
    return b > a && c > b ? true : `${a} ${b} ${c}`;
  });
  await row("zoomKeys", async () => {
    await giveLandscape();
    const a = zoomNow();
    await pressAs("zoomKeys", "⌘=");
    await sleep(80);
    const b = zoomNow();
    await pressAs("zoomKeys", "⌘-");
    await sleep(80);
    const c = zoomNow();
    return b > a && c < b ? true : `${a} ${b} ${c}`;
  });
  await row("fit", async () => {
    await giveLandscape();
    await pressAs("fit", "⌘1");
    await sleep(120);
    const at100 = zoomNow();
    await pressAs("fit", "⌘0");
    await sleep(120);
    const fitted = zoomNow();
    return at100 === 1 && fitted < 1 ? true : `${at100} ${fitted}`;
  });
  await row("goTo", async () => {
    await giveLandscape();
    await pressAs("goTo", "⌘K");
    await sleep(200);
    const rows = qs(".palette .row .lab").map((l) => l.textContent ?? "");
    const area = rows.some((l) => l.startsWith("Go to 5101") || /^Go to .*its area on the landscape/.test(l));
    const typed = !!q(".palette input");
    await afterEsc();
    return typed && area && !q(".palette") ? true : `palette ${typed}, an area's row ${area}`;
  });
  await row("nearest", async () => {
    await selectFirst();
    const a = selected();
    doing("nearest", "⌥ arrows");
    await press("ArrowRight", { alt: true });
    await sleep(150);
    const b = selected();
    await press("ArrowDown", { alt: true });
    await sleep(150);
    const c = selected();
    return !!a && b !== a && c !== b ? true : `${a} ${b} ${c}`;
  });
  await row("tree", async () => {
    await giveLandscape();
    const shown = () => !q(".sidebar")?.classList.contains("collapsed");
    const a = shown();
    await pressAs("tree", "⌘\\");
    await sleep(150);
    const b = shown();
    await pressAs("tree", "⌘\\");
    await sleep(150);
    return a && !b && shown() ? true : `${a} ${b} ${shown()}`;
  });
  await row("focus", async () => {
    await selectFirst();
    await pressAs("focus", "Enter");
    await sleep(250);
    const byEnter = !!q(".ls-focus");
    await press("e", { meta: true });
    await sleep(250);
    const left = !q(".ls-focus");
    await giveLandscape();
    await pressAs("focus", "⌘E");
    await sleep(250);
    const byE = !!q(".ls-focus");
    out.focusKeyboard = keyboard();
    return byEnter && left && byE ? true : `Enter ${byEnter}, ⌘E out ${left}, ⌘E in ${byE}`;
  });
  await row("back", async () => {
    if (!q(".ls-focus")) return "not in focus";
    await pressAs("back", "⌘Esc");
    await sleep(250);
    const byEsc = !q(".ls-focus");
    await giveLandscape();
    await press("e", { meta: true });
    await sleep(250);
    const again = !!q(".ls-focus");
    await pressAs("back", "⌘E");
    await sleep(250);
    return byEsc && again && !q(".ls-focus") ? true : `⌘Esc ${byEsc}, ⌘E ${again}`;
  });
  await row("needs", async () => {
    // three or more listed (?needsMany), so going back can't land where going on would
    await fit();
    const seen: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      await pressAs("needs", "N");
      await sleep(350);
      seen.push(selected());
    }
    await pressAs("needs", "⇧N");
    await sleep(350);
    const back = selected();
    const [a, b, c] = seen;
    return !!a && !!b && !!c && new Set(seen).size === 3 && back === b ? true : `N ${seen.join(" → ")}, ⇧N ${back}`;
  });
  await row("waiting", async () => {
    // from nothing selected, so the selection it ends with is its own doing
    await fit();
    await press("Escape");
    await sleep(150);
    const none = selected();
    await pressAs("waiting", "⌥⇥");
    await sleep(350);
    const a = selected();
    await press("Tab", { alt: true });
    await sleep(350);
    const b = selected();
    const waits = (id: string | null) => env.sessions().find((x) => x.id === id)?.status === "waiting";
    return none === null && waits(a) && waits(b) && a !== b ? true : `from ${none}: ${a} then ${b}`;
  });
  await row("peek", async () => {
    await fit();
    const p = middle(card("s4") ?? card("s5")!);
    doing("peek", "hover");
    await act([{ move: { x: p.x, y: p.y } }]);
    await sleep(800);
    const opened = !!q(".ls-peek");
    doing("peek", "Space holds");
    await press(" ");
    await sleep(120);
    const held = !!q(".ls-peek.pinned");
    await press("Escape");
    await sleep(120);
    const shut = !q(".ls-peek");
    const b = barePoint();
    await act([{ move: b }]);
    return opened && held && shut ? true : `opened ${opened}, held ${held}, shut ${shut}`;
  });
  const windowKey = (id: string, tool: string, token: string) => async () => {
    await selectFirst();
    const a = count(tool);
    await pressAs(id, token);
    await sleep(300);
    const b = count(tool);
    await giveLandscape();
    await pressAs(id, token);
    await sleep(300);
    return b === a + 1 && count(tool) === a ? true : `${token}: ${a} → ${b} → ${count(tool)}`;
  };
  await row("files", async () => {
    const byB = await windowKey("files", "files", "⌘B")();
    const byE = await windowKey("files", "files", "⇧⌘E")();
    return byB === true && byE === true ? true : `${byB}, ${byE}`;
  });
  await row("changes", windowKey("changes", "changes", "⌃⇧G"));
  await row("search", windowKey("search", "search", "⇧⌘F"));
  await row("run", windowKey("run", "run", "⇧⌘D"));
  await row("file", async () => {
    await selectFirst();
    await pressAs("file", "⌘P");
    await sleep(200);
    const open = !!q(".palette.qo");
    await afterEsc();
    return open && !q(".palette.qo") ? true : `open ${open}`;
  });
  await row("panel", async () => {
    await giveLandscape();
    const a = !!q(".bp");
    await pressAs("panel", "⌘J");
    await sleep(200);
    const b = !!q(".bp");
    await pressAs("panel", "⌘J");
    await sleep(200);
    return a !== b && !!q(".bp") === a ? true : `${a} ${b}`;
  });
  await row("newHere", async () => {
    await fit();
    const p = barePoint();
    doing("newHere", "right-click");
    await rightAt(p.x, p.y);
    await sleep(200);
    const rows = menuRows();
    out.rightClickRows = rows;
    await afterEsc();
    return rows.includes("Claude…") && rows.includes("Terminal…") ? true : rows.join(", ");
  });
  await row("newDialog", async () => {
    await giveLandscape();
    await pressAs("newDialog", "⌘N");
    await sleep(250);
    const open = q(".modal.ns h3")?.textContent ?? q(".modal h3")?.textContent ?? null;
    await afterEsc();
    return open === "New session" ? true : `dialog ${open}`;
  });
  // wires (W4b, W8, W6): s1 (an agent) wired to s8, a step added after s1, and focus walked along the wire
  const wiresMade = () => env.calls.filter((c) => c.fn === "wiresAdd").length;
  await row("connect", async () => {
    await fit();
    await press("Escape");
    await sleep(120);
    const from = dotOf("s1");
    if (!from) return "s1 has no edge dot at this zoom";
    const a = middle(from);
    const b = middle(card("s8")!);
    const was = wiresMade();
    doing("connect", "drag from the edge dot");
    await act([{ move: a }, { drag: { x0: a.x, y0: a.y, x1: b.x, y1: b.y } }]);
    await sleep(250);
    const picker = q(".wp-pick:not(.mb-ghost)");
    const ends = picker?.querySelector(".wp-ends")?.textContent?.replace(/\s+/g, " ").trim() ?? null;
    // the picker takes no key of a burst: ↵ once keys have paused
    await sleep(1100);
    await press("Enter");
    await sleep(400);
    const made = env.calls.filter((c) => c.fn === "wiresAdd").slice(was);
    out.connected = { ends, made: made.map((c) => c.args) };
    const ok = !!picker && made.length === 1 && JSON.stringify(made[0].args).includes('"s1"') && JSON.stringify(made[0].args).includes('"s8"');
    return ok ? true : `picker ${!!picker} (${ends}), made ${JSON.stringify(made.map((c) => c.args))}`;
  });
  await row("along", async () => {
    // s1 is wired to s8 (connect, above): in focus, along the wire and back
    await selectFirst();
    await press("Enter");
    await sleep(300);
    const inFocus = () => q(".ls-focus .ls-node")?.dataset.front ?? null;
    const at = inFocus();
    await pressAs("along", "⌘⌥→");
    await sleep(300);
    const on = inFocus();
    await pressAs("along", "⌘⌥←");
    await sleep(300);
    const back = inFocus();
    await press("e", { meta: true });
    await sleep(250);
    return at === "s1" && on === "s8" && back === "s1" ? true : `focus ${at} → ${on} → ${back}`;
  });
  await row("nextStep", async () => {
    await fit();
    await press("Escape");
    await sleep(120);
    const from = dotOf("s1");
    if (!from) return "s1 has no edge dot at this zoom";
    const a = middle(from);
    const b = barePoint();
    doing("nextStep", "drag a wire into space");
    await act([{ move: a }, { drag: { x0: a.x, y0: a.y, x1: b.x, y1: b.y } }]);
    await sleep(350);
    const step = q(".modal.ns-step:not(.mb-ghost)");
    out.nextStep = { dialog: !!step, head: step?.querySelector(".ns-head")?.textContent?.replace(/\s+/g, " ").trim() ?? null };
    await sleep(1100);
    await afterEsc();
    return !!step && !q(".modal.ns-step:not(.mb-ghost)") ? true : `the step's dialog ${!!step}, still open ${!!q(".modal.ns-step:not(.mb-ghost)")}`;
  });
  await row("several", async () => {
    await fit();
    await press("Escape");
    await sleep(120);
    doing("several", "⇧-click");
    await clickOn(card("s4")!, { shift: true });
    await sleep(100);
    await clickOn(card("s5")!, { shift: true });
    await sleep(150);
    const shift = picked();
    await giveLandscape();
    await press("Escape");
    await sleep(120);
    const r = vp().getBoundingClientRect();
    const p = barePoint();
    doing("several", "marquee");
    await act([{ drag: { x0: p.x, y0: p.y, x1: r.right - 20, y1: r.bottom - 20 } }]);
    await sleep(200);
    const marquee = picked();
    return shift === 2 && marquee > 0 ? true : `⇧-click ${shift}, marquee ${marquee}`;
  });
  await row("makeArea", async () => {
    if (!picked()) return "nothing picked";
    doing("makeArea", "marquee");
    await giveLandscape();
    await pressAs("makeArea", "M");
    await sleep(250);
    const asks = !!q(".modal input");
    await afterEsc();
    return asks ? true : "M asked for no name";
  });
  await row("clear", async () => {
    await giveLandscape();
    const was = picked();
    await pressAs("clear", "Esc");
    await sleep(150);
    return was > 0 && picked() === 0 ? true : `${was} → ${picked()}`;
  });
  await row("tidy", async () => {
    await selectFirst();
    const before = JSON.stringify(env.stored().workspaces);
    await pressAs("tidy", "T");
    await sleep(350);
    const noted = !!q(".ls-note-act");
    const after = JSON.stringify(env.stored().workspaces);
    out.tidied = { noted, moved: before !== after };
    return noted ? true : "T said nothing";
  });
  await row("undoTidy", async () => {
    if (!q(".ls-note-act")) return "no Tidy to undo";
    await giveLandscape();
    await pressAs("undoTidy", "⌘Z");
    await sleep(350);
    return !q(".ls-note-act") ? true : "the note stayed";
  });
  await row("stack", async () => {
    await fit();
    await press("Escape");
    await sleep(120);
    // the fixture's two plain workspaces in 5101
    await clickOn(card("s4")!, { shift: true });
    await sleep(100);
    await clickOn(card("s8")!, { shift: true });
    await sleep(150);
    const was = picked();
    const stacksBefore = qs(".ls-world .ls-node.stack").length;
    const mark0 = env.calls.length;
    await giveLandscape();
    await pressAs("stack", "⌘G");
    const movedNow = () => env.calls.slice(mark0).filter((c) => c.fn === "setGroup").map((c) => String(c.args[0]));
    const stacks = () => qs(".ls-world .ls-node.stack").length;
    // its groups change one at a time
    for (let i = 0; i < 30 && stacks() === stacksBefore; i++) await sleep(100);
    return stacks() === stacksBefore + 1 && movedNow().join() === "s4,s8" ? true : `picked ${was}, moved ${movedNow().join() || "none"}, stacks ${stacksBefore} → ${stacks()}, keyboard ${keyboard()}, said ${q(".ls-note")?.textContent ?? "nothing"}`;
  });

  // The palette clicked away gives the keyboard back to the landscape, which had it: `?` works straight after.
  await giveLandscape();
  await press("k", { meta: true });
  await sleep(200);
  const pal = box(q(".palette"));
  const outside = { x: pal ? Math.max(8, pal.x - 40) : 8, y: innerHeight - 40 };
  await act([{ mouse: { ...outside, clickCount: 1 } }]);
  await sleep(200);
  out.afterScrim = { palette: !!q(".palette"), keyboard: keyboard() };
  await press("?", { shift: true });
  await sleep(150);
  (out.afterScrim as Record<string, unknown>).sheet = !!q(".ls-keys");
  await afterEsc();

  // Keys with the keyboard nowhere do nothing: no sheet, no Needs you, no Tidy, and they don't take the keyboard either.
  await selectFirst();
  const selBefore = selected();
  const writesBefore = env.calls.filter((c) => c.fn === "landscapeUpdate" || c.fn === "sessionWrite").length;
  (document.activeElement as HTMLElement | null)?.blur();
  await sleep(20);
  const nowhereAt = keyboard();
  for (const k of ["?", "n", "t", "Enter", " "]) {
    await press(k, k === "?" ? { shift: true } : {});
    await sleep(120);
  }
  out.nowhere = {
    at: nowhereAt,
    keyboard: keyboard(),
    sheet: !!q(".ls-keys"),
    selected: selected() === selBefore,
    focus: !!q(".ls-focus"),
    writes: env.calls.filter((c) => c.fn === "landscapeUpdate" || c.fn === "sessionWrite").length - writesBefore,
  };

  // in a terminal, last: at 100% it has the keyboard, and `?` is typed into it
  await fit();
  await clickOn(card("s1")!);
  await sleep(150);
  await giveLandscape();
  await press("1", { meta: true });
  await sleep(300);
  await press("Enter");
  await sleep(350);
  const writes = () => env.calls.filter((c) => c.fn === "sessionWrite").length;
  const was = writes();
  const onTerminal = keyboard();
  await press("?", { shift: true });
  await sleep(200);
  out.questionInTerminal = { keyboard: onTerminal, sheet: !!q(".ls-keys"), typed: writes() - was };
  out.driven = driven;
  out.why = why;
}

/** What the wires step points at: the edge dot shown, or else the first wire's two ends together. */
const wiresTarget = (): Box | null => {
  const dot = q(".ls-world .ls-node.show-handle > .ls-wh");
  if (dot) return box(dot);
  const links = wiresNow().state?.book?.links ?? {};
  const first = wiresInOrder(links)[0]?.[1];
  const ends = first ? [first.from, first.to].map((id) => box(q(`.ls-world .ls-node[data-front="${CSS.escape(id)}"]`))) : [];
  if (ends.length !== 2 || !ends[0] || !ends[1]) return null;
  const [a, b] = ends as Box[];
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** The tour's card, ring and what's under them at this step. */
const tourNow = () => {
  const ring = q(".ls-tour-ring");
  const c = q(".ls-tour-card");
  const target = c?.dataset.step;
  const rb = ring && !ring.hidden ? box(ring) : null;
  const cb = box(c);
  const t = target === "zoom" ? box(q(".ls-hud")) : target === "needs" ? box(q(".ny-btn")) : target === "wires" ? wiresTarget() : null;
  return {
    step: target ?? null,
    title: q(".ls-tour-title")?.textContent ?? null,
    next: q(".ls-tour-next")?.textContent ?? null,
    count: q(".ls-tour-count")?.textContent ?? null,
    buttons: qs(".ls-tour-acts button").map((b) => b.textContent),
    ring: rb,
    target: t,
    card: cb,
    // the ring keeps inside the window, so it may stop just short of what's at the window's edge (the rail)
    ringHolds: t ? within(t, rb, 3) : null,
    cardInWindow: within(cb, win()),
    cardOverRing: overlap(cb, rb),
    keyboard: keyboard(),
    // the workspace whose edge dot is shown for the step, and what's selected
    handleOn: q(".ls-world .ls-node.show-handle")?.dataset.ws ?? null,
    selected: selected(),
  };
};
const tourNext = async () => {
  await press("Enter");
  await sleep(200);
};

async function tourPart(env: FirstRunEnv, out: Record<string, unknown>): Promise<void> {
  const how = params.get("do") ?? "done";
  const stage = sessionStorage.getItem("mb.audit.stage");
  if (stage === "reloaded") {
    // the second page: the same landscape, read back
    await sleep(1500);
    out.afterRestart = { tour: !!q(".ls-tour-card"), tourDone: env.stored().tourDone === true };
    sessionStorage.removeItem("mb.audit.stage");
    return;
  }
  await sleep(600);
  // where the window started: the tour may have moved the camera by now
  const startedAt = params.get("lsCamera")?.split(",").map(Number);
  const camAtStart = startedAt ? { x: startedAt[0], y: startedAt[1], zoom: startedAt[2] } : camera();
  const finishAll = async () => {
    // with motion on, what's moving runs to its end, so it's the end state that's read; one with no end is left running
    for (const a of document.getAnimations()) {
      try {
        a.finish();
      } catch {
        // an infinite one (a status dot's pulse) can't be finished
      }
    }
    await sleep(200);
  };
  await finishAll();
  const steps = [tourNow()];
  const cardEl = q(".ls-tour-card");
  out.cardEnd = cardEl && { opacity: getComputedStyle(cardEl).opacity, transform: getComputedStyle(cardEl).transform };
  out.first = steps[0];
  out.areaCentred = (() => {
    const key = q(".ls-area.selected")?.dataset.area;
    return key ?? null;
  })();
  out.ringInView = within(steps[0].ring, box(vp()), 1);
  out.cameraMoved = moved(camAtStart, camera());
  // the ring round the area: its outline as the world draws it
  const areas = qs(".ls-world .ls-area");
  out.ringAroundAnArea = areas.some((a) => {
    const b = box(a);
    const r = steps[0].ring;
    return !!b && !!r && Math.abs(r.x + r.w / 2 - (b.x + b.w / 2)) < 40 && Math.abs(r.y + r.h / 2 - (b.y + b.h / 2)) < 60;
  });
  // what can't be reached behind it: a press on the dim stays there, Tab stays in the card
  const p = barePoint2();
  const sel = selected();
  await act([{ mouse: { x: p.x, y: p.y, clickCount: 1 } }]);
  const tabbed: string[] = [];
  for (const shift of [false, false, false, true, true]) {
    await press("Tab", { shift });
    await sleep(40);
    tabbed.push(keyboard());
  }
  out.afterPressAndTabs = { tabbed, selection: selected() === sel, tour: !!q(".ls-tour-card") };
  // focus sent elsewhere (something behind the tour finishing and focusing its own) comes back
  vp().focus({ preventScroll: true });
  await sleep(40);
  out.focusSentAway = keyboard();
  q<HTMLElement>('.ls-tour-card [data-act="next"]')?.focus();
  if (how === "esc") {
    await press("Escape");
    await sleep(250);
  } else if (how === "skip") {
    await clickOn(q('.ls-tour-card [data-act="skip"]')!);
    await sleep(250);
  } else {
    for (let i = 0; i < 3; i++) {
      await tourNext();
      steps.push(tourNow());
    }
    out.steps = steps;
    await tourNext();
    await sleep(250);
  }
  await finishAll();
  await sleep(100);
  out.after = { tour: !!q(".ls-tour-card"), scrim: !!q(".ls-tour-back"), tourDone: env.stored().tourDone === true, keyboard: keyboard(), cameraBack: !moved(camAtStart, camera()) };
  out.handleAfter = q(".ls-world .ls-node.show-handle")?.dataset.ws ?? null;
  out.note = q(".ls-note")?.textContent ?? null;
  out.banners = qs(".ls-banner .m").map((b) => b.textContent);
  if (params.has("lookAgain")) {
    // it isn't brought back in this run by anything changing
    env.patch({ areas: {} });
    await sleep(500);
    out.backAgain = !!q(".ls-tour-card");
  }
  if (params.has("lsPersist")) {
    sessionStorage.setItem("mb.audit.stage", "reloaded");
    location.reload();
    await new Promise<never>(() => {});
  }
}
/** A point under the tour's dim, away from its card and ring. */
function barePoint2(): { x: number; y: number } {
  const c = box(q(".ls-tour-card"));
  const r = vp().getBoundingClientRect();
  for (const [x, y] of [[r.left + 30, r.bottom - 30], [r.right - 30, r.bottom - 30], [r.right - 30, r.top + 30], [r.left + 30, r.top + 30]]) {
    if (!overlap({ x, y, w: 1, h: 1 }, c)) return { x, y };
  }
  return { x: r.left + 5, y: r.bottom - 5 };
}

async function tourAgainstPart(env: FirstRunEnv, out: Record<string, unknown>): Promise<void> {
  const which = params.get("case");
  const startTour = async () => {
    env.patch({ tourDone: false });
    await sleep(200);
  };
  await sleep(600);
  if (which === "terminal") {
    // a terminal has the keyboard as the tour comes up: nothing typed reaches it, and it has the keyboard after
    await giveLandscape();
    await press("1", { meta: true });
    await sleep(300);
    await clickOn(card("s1")!);
    await sleep(300);
    const t = q<HTMLTextAreaElement>('.ls-world .ls-node[data-front="s1"] .xterm-helper-textarea');
    t?.focus();
    await sleep(80);
    out.before = keyboard();
    await startTour();
    out.during = keyboard();
    out.firstStep = q(".ls-tour-card")?.dataset.step ?? null;
    const writes = () => env.calls.filter((c) => c.fn === "sessionWrite").length;
    const was = writes();
    // typed on as it comes up: letters, Space, Tab, Enter and Esc, none of which is meant for it
    await act([..."ab c"].map((key) => ({ key })).concat([{ key: "Tab" }, { key: "Tab" }, { key: "Enter" }, { key: " " }, { key: "Escape" }, { key: "Enter" }]));
    await sleep(150);
    out.typedIntoTerminal = writes() - was;
    out.stepAfterTyping = { step: q(".ls-tour-card")?.dataset.step ?? null, tourDone: env.stored().tourDone === true, keyboard: keyboard(), onButton: !!document.activeElement?.closest(".ls-tour-acts") };
    // once the keys have stopped for a second, its buttons take the keyboard as usual
    await sleep(1200);
    await press("Tab");
    await sleep(60);
    out.tabAfterPause = (document.activeElement as HTMLElement | null)?.dataset.act ?? keyboard();
    for (let i = 0; i < 4 && q(".ls-tour-card"); i++) await tourNext();
    await sleep(900);
    out.after = { tour: !!q(".ls-tour-card"), keyboard: keyboard(), tourDone: env.stored().tourDone === true, active: document.activeElement === t };
    const was2 = writes();
    await press("x");
    await sleep(150);
    out.typedAfter = writes() - was2;
  } else if (which === "typing") {
    // a key pressed a moment before it comes up, on the landscape: Enter and Space straight after press nothing in it
    await giveLandscape();
    await press("x");
    await startTour();
    out.came = { tour: !!q(".ls-tour-card"), keyboard: keyboard(), onButton: !!document.activeElement?.closest(".ls-tour-acts") };
    await act([{ key: "Enter" }, { key: " " }, { key: "Enter" }]);
    await sleep(150);
    out.afterKeys = { step: q(".ls-tour-card")?.dataset.step ?? null, tourDone: env.stored().tourDone === true };
  } else if (which === "dropped") {
    // the terminal being typed in goes (closed elsewhere, a pane dropped): what's typed on is no shortcut, and reaches
    // no other session
    await giveLandscape();
    await press("1", { meta: true });
    await sleep(300);
    await clickOn(card("s1")!);
    await sleep(300);
    q<HTMLTextAreaElement>('.ls-world .ls-node[data-front="s1"] .xterm-helper-textarea')?.focus();
    // the pointer off the cards, so no peek is open under it
    await act([{ move: barePoint() }]);
    await sleep(80);
    out.before = keyboard();
    env.setSession("s1", null);
    await sleep(700);
    out.dropped = keyboard();
    const sel = selected();
    const cam = camera();
    const mark = env.calls.length;
    const typed: Asked[] = ([..."git checkout main"].map((key) => ({ key })) as Asked[]).concat([{ key: "Enter" }], [..."yarn"].map((key) => ({ key })), [{ key: "Enter" }, { key: "y" }, { key: "n" }, { key: "t" }, { key: "?", shift: true }, { key: " " }, { key: "Enter" }]);
    await act(typed);
    await sleep(500);
    out.afterTyping = {
      keyboard: keyboard(),
      calls: env.calls.slice(mark).filter((c) => ["sessionWrite", "landscapeUpdate", "setGroup"].includes(c.fn)).map((c) => c.fn),
      selected: selected() === sel,
      camera: !moved(cam, camera()),
      focus: !!q(".ls-focus"),
      sheet: !!q(".ls-keys"),
      note: q(".ls-note")?.textContent ?? null,
    };
  } else if (which === "keys") {
    // under the tour the window's keys hold off: ⌘E doesn't focus the selected workspace from behind it
    await fit();
    await clickOn(card("s1")!);
    await sleep(200);
    await startTour();
    await sleep(1200);
    await press("e", { meta: true });
    await sleep(300);
    out.cmdE = { focus: !!q(".ls-focus"), tour: !!q(".ls-tour-card") };
    await press("Escape");
    await sleep(300);
    out.afterEsc = { tour: !!q(".ls-tour-card"), selected: selected(), focus: !!q(".ls-focus") };
  } else if (which === "field") {
    // the area tree's filter had the keyboard as it came up: that's where it goes back
    const filter = q<HTMLInputElement>(".area-tree input")!;
    filter.focus();
    await sleep(60);
    out.before = keyboard();
    await startTour();
    await sleep(1200);
    await clickOn(q('.ls-tour-card [data-act="skip"]')!);
    await sleep(300);
    out.after = { tour: !!q(".ls-tour-card"), keyboard: keyboard(), field: document.activeElement === filter };
  } else if (which === "ring") {
    // a step whose target isn't on screen has no ring left where it was
    await startTour();
    await sleep(300);
    await clickOn(q('.ls-tour-card [data-act="next"]')!);
    await sleep(300);
    out.zoomStep = { step: q(".ls-tour-card")?.dataset.step ?? null, ring: !q<HTMLElement>(".ls-tour-ring")!.hidden };
    q<HTMLElement>(".ls-hud")!.style.display = "none";
    window.dispatchEvent(new Event("resize"));
    await sleep(200);
    out.targetGone = { ring: !q<HTMLElement>(".ls-tour-ring")!.hidden, cardInWindow: within(box(q(".ls-tour-card")), win()) };
  } else if (which === "handle") {
    // s4 (a terminal) selected as the tour comes up, zoomed out (?lsCamera) past where it carries an edge dot: the wires
    // step is about its dot all the same, brought into view, and the tour ends with it as it was
    await clickOn(card("s4")!);
    await sleep(200);
    await giveLandscape();
    out.dotBefore = !!dotOf("s4");
    const cam = camera();
    // saving that the tour was seen is the one write it makes
    const writes = () => env.calls.filter((c) => ["sessionWrite", "setGroup", "wiresAdd", "planSession"].includes(c.fn)).length;
    const was = writes();
    await startTour();
    await sleep(300);
    for (let i = 0; i < 2; i++) {
      await clickOn(q('.ls-tour-card [data-act="next"]')!);
      await sleep(400);
    }
    out.wires = tourNow();
    out.movedForIt = moved(cam, camera());
    for (let i = 0; i < 2; i++) {
      await clickOn(q('.ls-tour-card [data-act="next"]')!);
      await sleep(400);
    }
    out.after = { tour: !!q(".ls-tour-card"), selected: selected(), handle: q(".ls-world .ls-node.show-handle")?.dataset.ws ?? null, cameraBack: !moved(cam, camera()), keyboard: keyboard(), writes: writes() - was };
  } else if (which === "undo") {
    // a Tidy's Undo outlives saving that the tour was seen, which changes nothing it could undo
    await fit();
    await clickOn(card("s1")!);
    await sleep(200);
    await giveLandscape();
    const before = JSON.stringify(env.stored().workspaces);
    await press("t");
    await sleep(400);
    out.tidied = { note: !!q(".ls-note-act"), moved: JSON.stringify(env.stored().workspaces) !== before };
    await startTour();
    await sleep(300);
    out.tourUp = !!q(".ls-tour-card");
    await clickOn(q('.ls-tour-card [data-act="skip"]')!);
    await sleep(400);
    out.tourDone = env.stored().tourDone === true;
    const act0 = q(".ls-note-act");
    out.undoOffered = !!act0;
    if (act0) {
      await clickOn(act0);
      await sleep(500);
    }
    out.undone = { back: JSON.stringify(env.stored().workspaces) === before, note: q(".ls-note")?.textContent ?? null };
  } else if (which === "dialog") {
    // a dialog open as it comes due: the tour waits, and comes up as it closes
    await giveLandscape();
    await press("n", { meta: true });
    await sleep(250);
    await startTour();
    await sleep(600);
    out.withDialog = { tour: !!q(".ls-tour-card"), dialog: !!q(".modal.ns") };
    await afterEsc();
    await sleep(800);
    out.afterDialog = { tour: !!q(".ls-tour-card"), keyboard: keyboard(), tourDone: env.stored().tourDone === true };
  } else if (which === "palette") {
    // over the tour: the palette takes the keyboard and Esc, then gives them back; a second Esc skips the tour
    await startTour();
    const was = keyboard();
    await press("k", { meta: true });
    await sleep(250);
    const center = middle(q(".palette")!);
    out.palette = { was, keyboard: keyboard(), onTop: !!document.elementFromPoint(center.x, center.y)?.closest(".palette"), tour: !!q(".ls-tour-card") };
    await press("Escape");
    await sleep(250);
    out.afterPalette = { palette: !!q(".palette"), tour: !!q(".ls-tour-card"), keyboard: keyboard(), tourDone: env.stored().tourDone === true };
    await press("Escape");
    await sleep(250);
    out.afterSecondEsc = { tour: !!q(".ls-tour-card"), tourDone: env.stored().tourDone === true, keyboard: keyboard() };
  } else if (which === "focus") {
    // it waits out focus, whose overlay covers what it points at
    await fit();
    await clickOn(card("s1")!);
    await sleep(200);
    await giveLandscape();
    await press("Enter");
    await sleep(350);
    await startTour();
    await sleep(500);
    out.inFocus = { focus: !!q(".ls-focus"), tour: !!q(".ls-tour-card") };
    await press("e", { meta: true });
    await sleep(600);
    out.afterFocus = { focus: !!q(".ls-focus"), tour: !!q(".ls-tour-card"), keyboard: keyboard() };
  } else if (which === "tray") {
    // the Needs you tray open: the tour waits for it, as for any popover, and it can't be opened again under the dim
    await clickOn(q(".ny-btn")!);
    await sleep(200);
    await startTour();
    await sleep(600);
    out.withTray = { tray: !!q(".ny-tray"), tour: !!q(".ls-tour-card") };
    await press("Escape");
    await sleep(800);
    out.afterTray = { tray: !!q(".ny-tray"), tour: !!q(".ls-tour-card"), keyboard: keyboard() };
    await clickOn(q(".ny-btn")!);
    await sleep(200);
    out.pressOnDimmedButton = { tray: !!q(".ny-tray"), tour: !!q(".ls-tour-card") };
  }
}

/**
 * =c (with ?lsTour and ?lsCamera somewhere the tour moves it from): the camera the tour moved, put back however the tour
 * ends, and never saved as the window's: &case=esc|skip (during step 1's flight, with ?motion=full), tab (to Dashboard
 * and back during it), restart (a reload during it) and goto (⌘K's Go to during it, which it then leaves alone).
 */
async function cameraPart(env: FirstRunEnv, out: Record<string, unknown>): Promise<void> {
  const which = params.get("case");
  const savedCamera = () => {
    const v = JSON.parse(localStorage.getItem("mb.landscape.camera") ?? "null") as { x: number; y: number; zoom: number } | null;
    return v && { x: Math.round(v.x * 10) / 10, y: Math.round(v.y * 10) / 10, zoom: Math.round(v.zoom * 1e4) / 1e4 };
  };
  const round = (c: ReturnType<typeof camera>) => c && { x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10, zoom: Math.round(c.zoom * 1e4) / 1e4 };
  const finishAll = async () => {
    for (const a of document.getAnimations()) {
      try {
        a.finish();
      } catch {
        // an infinite one (a status dot's pulse) can't be finished
      }
    }
    await sleep(250);
  };
  const tourCard = async () => {
    for (let i = 0; i < 40 && !q(".ls-tour-card"); i++) await sleep(100);
    return !!q(".ls-tour-card");
  };
  const stage = sessionStorage.getItem("mb.audit.camera");
  if (stage) {
    // after the reload: the camera it was saved with, then the tour again, ended
    sessionStorage.removeItem("mb.audit.camera");
    const start = JSON.parse(stage) as { x: number; y: number; zoom: number };
    // the camera the window opened on, as saved
    out.openedAt = savedCamera();
    await sleep(600);
    out.start = start;
    out.tourAgain = await tourCard();
    await finishAll();
    await clickOn(q('.ls-tour-card [data-act="skip"]')!);
    await sleep(300);
    await finishAll();
    await sleep(400);
    out.end = { camera: round(camera()), saved: savedCamera(), kept: localStorage.getItem("mb.landscape.tourCamera") };
    return;
  }
  const s = params.get("lsCamera")!.split(",").map(Number);
  const start = { x: s[0], y: s[1], zoom: s[2] };
  out.start = start;
  if (which === "esc" || which === "skip") {
    // ended while step 1's flight is on its way
    for (let i = 0; i < 60 && !vp().hasAttribute("data-flying"); i++) await sleep(20);
    out.flying = vp().hasAttribute("data-flying");
    // whether the flight was still on its way when what ends the tour arrived
    let ended: boolean | null = null;
    const onEnd = (e: Event) => {
      const ends = e.type === "keydown" ? (e as KeyboardEvent).key === "Escape" : !!(e.target as Element | null)?.closest?.('[data-act="skip"]');
      if (ends && ended === null) ended = vp().hasAttribute("data-flying");
    };
    document.addEventListener("keydown", onEnd, true);
    document.addEventListener("click", onEnd, true);
    if (which === "esc") await press("Escape");
    // Skip from the keyboard, Tab from Next and Space, sent together: the card follows its target while the camera
    // flies, further than it goes in the time a press aimed where Skip was takes to arrive
    else await act([{ key: "Tab" }, { key: " " }]);
    document.removeEventListener("keydown", onEnd, true);
    document.removeEventListener("click", onEnd, true);
    out.endedFlying = ended;
    await sleep(100);
    await finishAll();
    await sleep(400);
  } else {
    await tourCard();
    await finishAll();
    await sleep(400);
    out.during = { camera: round(camera()), saved: savedCamera() };
    if (which === "tab") {
      await clickOn(qs(".topbar .tab").find((t) => t.textContent?.trim() === "Dashboard")!);
      await sleep(400);
      await clickOn(qs(".topbar .tab").find((t) => t.textContent?.trim() === "Landscape")!);
      out.tourAgain = await tourCard();
      await finishAll();
      await clickOn(q('.ls-tour-card [data-act="skip"]')!);
      await sleep(300);
      await finishAll();
      await sleep(400);
    } else if (which === "restart") {
      sessionStorage.setItem("mb.audit.camera", JSON.stringify(start));
      // without ?lsCamera, so the camera it opens on is the one it saved
      const next = new URLSearchParams(location.search);
      next.delete("lsCamera");
      history.replaceState(null, "", `${location.pathname}?${next}`);
      location.reload();
      await new Promise<never>(() => {});
    } else if (which === "goto") {
      // an area other than the one the tour shows
      const v = box(vp())!;
      const mid = { x: v.x + v.w / 2, y: v.y + v.h / 2, w: 1, h: 1 };
      const shown = qs(".ls-world .ls-area").find((a) => overlap(box(a), mid))?.dataset.area ?? null;
      const other = ["5110", "5102", "5101"].find((k) => k !== shown)!;
      out.tourShows = shown;
      await press("k", { meta: true });
      await sleep(250);
      const input = q<HTMLInputElement>(".palette input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, `Go to ${other}`);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(200);
      out.gotoRow = q(".palette .row.sel .lab, .palette .row.on .lab")?.textContent ?? qs(".palette .row .lab")[0]?.textContent ?? null;
      await press("Enter");
      await sleep(300);
      await finishAll();
      out.wentTo = round(camera());
      await sleep(1200);
      await press("Escape");
      await sleep(300);
      await finishAll();
      await sleep(400);
    }
  }
  out.end = { tour: !!q(".ls-tour-card"), camera: round(camera()), saved: savedCamera(), kept: localStorage.getItem("mb.landscape.tourCamera") };
}

async function emptyPart(env: FirstRunEnv, out: Record<string, unknown>): Promise<void> {
  await sleep(1200);
  const state = () => ({
    kind: q(".ls-empty")?.dataset.empty ?? null,
    title: q(".ls-empty-title")?.textContent ?? null,
    text: qs(".ls-empty-text").map((t) => t.textContent).join(" ") || null,
    tiles: qs(".ls-empty-tile").map((t) => `${t.querySelector(".t")?.textContent} / ${t.querySelector(".s")?.textContent}`),
    closed: q(".ls-empty-closed")?.textContent ?? null,
    foot: q(".ls-empty-foot")?.textContent ?? null,
    hud: !!q(".ls-hud"),
    saysEmpty: /an empty landscape/i.test(q(".ls-wrap")?.textContent ?? ""),
  });
  out.state = state();
  // the tiles' rows, by where they sit, and whether each row is centred under the first
  const tileBoxes = qs(".ls-empty-tile").map((t) => box(t)!);
  const rowTops = [...new Set(tileBoxes.map((b) => Math.round(b.y)))].sort((a, b) => a - b);
  const centre = (y: number) => {
    const r = tileBoxes.filter((b) => Math.round(b.y) === y);
    return (Math.min(...r.map((b) => b.x)) + Math.max(...r.map((b) => b.x + b.w))) / 2;
  };
  out.tileRows = rowTops.map((y) => tileBoxes.filter((b) => Math.round(b.y) === y).length);
  out.tileRowsCentred = rowTops.every((y) => Math.abs(centre(y) - centre(rowTops[0])) < 1.5);
  out.tourDone = env.stored().tourDone === true;
  out.tour = !!q(".ls-tour-card");
  out.banners = qs(".ls-banner .t").map((b) => b.textContent);
  out.keyboardAtStart = keyboard();
  // what's drawn, when something is, and whether it's in view
  const drawn = q(".ls-world .ls-ghost, .ls-world .ls-window, .ls-world .ls-area");
  out.drawn = drawn ? { cls: drawn.className.split(" ")[0], inView: overlap(box(drawn), box(vp())) } : null;
  out.note = q(".ls-note")?.textContent ?? null;

  if (params.has("addArea")) {
    // with nothing to tour settled for this run, an area turning up later brings no tour
    env.patch({ areas: { spare: { x: 0, y: 0, w: 900, h: 600, repos: [] } } });
    await sleep(900);
    out.afterArea = { area: !!q(".ls-world .ls-area"), tour: !!q(".ls-tour-card"), tourDone: env.stored().tourDone === true };
    return;
  }
  if (params.has("tall")) {
    // in a view too short for it, the panel scrolls: its title from the top, its foot once scrolled to
    const panel = q(".ls-empty")!;
    const v = box(vp());
    out.tall = { scrolls: panel.hasAttribute("data-scrolls"), titleShown: within(box(q(".ls-empty-title")), v, 1) };
    await act([{ wheel: { ...middle(q(".ls-empty-title")!), dy: 400 } }]);
    await sleep(250);
    (out.tall as Record<string, unknown>).footShown = within(box(q(".ls-empty-foot")), v, 1);
    return;
  }
  if (params.has("team")) {
    // the side bar showing Team rooms in place of the area tree: the Closed list's line says how to show it
    await clickOn(q(".connected-line")!);
    await sleep(300);
    out.team = { title: q(".side-title")?.textContent ?? null, showIt: !!q('.ls-empty [data-act="show-tree"]') };
    if (q('.ls-empty [data-act="show-tree"]')) {
      await clickOn(q('.ls-empty [data-act="show-tree"]')!);
      await sleep(300);
    }
    (out.team as Record<string, unknown>).after = q(".side-title")?.textContent ?? null;
    return;
  }

  if (params.has("retry")) {
    const b = q('.ls-empty [data-act="retry"]');
    out.hasRetry = !!b;
    if (b) {
      await clickOn(b);
      await sleep(600);
    }
    out.afterRetry = state();
    return;
  }
  if (state().kind !== "empty" && state().kind !== "reset") return;

  // `?` straight away, as it says, with no click on the landscape first
  await press("?", { shift: true });
  await sleep(150);
  out.questionMark = !!q(".ls-keys");
  await afterEsc();
  out.keyboardAfterSheet = keyboard();

  // a right-click anywhere: the bare corners, the bottom where the zoom's buttons go, the words and the tiles themselves
  const r = vp().getBoundingClientRect();
  const places: Record<string, { x: number; y: number }> = {
    topLeft: { x: r.left + 12, y: r.top + 12 },
    topRight: { x: r.right - 12, y: r.top + 12 },
    bottomRight: { x: r.right - 12, y: r.bottom - 12 },
    bottomMiddle: { x: r.left + r.width / 2, y: r.bottom - 20 },
    title: middle(q(".ls-empty-title")!),
    tile: middle(q(".ls-empty-tile")!),
    foot: { x: q(".ls-empty-foot")!.getBoundingClientRect().left + 4, y: middle(q(".ls-empty-foot")!).y },
  };
  const menus: Record<string, string[]> = {};
  for (const [name, at] of Object.entries(places)) {
    await rightAt(at.x, at.y);
    await sleep(180);
    menus[name] = menuRows();
    await afterEsc();
  }
  out.menus = menus;
  out.keyboardAfterMenus = keyboard();

  // a press on its words is the landscape's: a drag from the title draws the marquee
  const words = middle(q(".ls-empty-title")!);
  await act([{ drag: { x0: words.x, y0: words.y, x1: words.x + 140, y1: words.y + 90, hold: "down" } }]);
  await sleep(80);
  out.marqueeFromWords = !q(".ls-marquee")?.hidden;
  await act([{ drag: { x0: words.x, y0: words.y, x1: words.x + 140, y1: words.y + 90, hold: "up" } }]);
  await sleep(120);

  // keys with the landscape given the keyboard by code (disarmed, keyArm.ts) press no tile: a burst's Tab, Enter and
  // Space are swallowed, and a Tab after a pause leaves the landscape for the top bar, past the tiles
  vp().focus({ preventScroll: true });
  vp().blur();
  vp().focus({ preventScroll: true });
  await sleep(60);
  out.tilesDisarmedAt = keyboard();
  const opened = () => !!q(".modal:not(.mb-ghost)") || env.calls.some((c) => c.fn === "presetStart");
  await act([{ key: "x" }, { key: "Tab" }, { key: "Enter" }, { key: "Tab" }, { key: " " }]);
  await sleep(250);
  out.tilesDisarmed = { opened: opened(), keyboard: keyboard() };
  await sleep(1100);
  await press("Tab");
  await sleep(100);
  out.tabPastTiles = { onTile: !!document.activeElement?.closest(".ls-empty-tile"), offLandscape: !vp().contains(document.activeElement) };
  await giveLandscape();

  // each tile runs the create menu's row: the New session dialog, or the template picker, as that row opens them. The
  // Helpdesk tile starts a workspace, so it's pressed last (&helpdesk)
  const dialogNow = () => {
    const d = q(".modal.ns");
    if (d) return { launch: d.querySelector(".ns-launch button.on")?.textContent ?? null, mode: d.querySelector(".ns-mode button.on")?.textContent ?? null, ticket: !!qs(".modal.ns *").find((e) => /ticket/i.test(e.className?.toString() ?? "") && e.tagName !== "BUTTON") };
    const p = q(".modal.tp:not(.mb-ghost)");
    return p ? { picker: true, none: q(".modal.tp [data-empty=templates]")?.textContent?.trim() ?? null } : null;
  };
  const tiles: Record<string, unknown> = {};
  for (const t of qs(".ls-empty-tile").filter((x) => x.dataset.tile !== "new:helpdesk")) {
    const key = t.dataset.tile!;
    await clickOn(t);
    await sleep(400);
    tiles[key] = dialogNow();
    await afterEsc();
    await sleep(120);
  }
  out.tilesOpen = tiles;
  out.keyboardAfterDialog = keyboard();

  // the room's link is the join dialog
  await clickOn(q('.ls-empty [data-act="join"]')!);
  await sleep(250);
  out.joinDialog = q(".team-dlg h3")?.textContent ?? null;
  await afterEsc();

  // the side bar hidden: the Closed list's line says how to show it
  const lineHas = () => !!q('.ls-empty [data-act="show-tree"]');
  out.showItWithTree = lineHas();
  await giveLandscape();
  await press("\\", { meta: true });
  await sleep(200);
  out.showItWithoutTree = lineHas();
  if (lineHas()) {
    await clickOn(q('.ls-empty [data-act="show-tree"]')!);
    await sleep(250);
    out.treeBack = !q(".sidebar")?.classList.contains("collapsed");
  } else {
    await press("\\", { meta: true });
    await sleep(200);
  }

  // made from a tile: it goes, what's made is placed in view, and no tour is about it
  if (params.has("make")) {
    await clickOn(q('.ls-empty-tile[data-tile="new:claude"]')!);
    await sleep(300);
    const go = qs<HTMLButtonElement>(".modal.ns button.primary").pop();
    if (go) {
      await clickOn(go);
      await sleep(1000);
    }
    const n = q(".ls-world .ls-node");
    out.made = { empty: !!q(".ls-empty"), workspace: !!n, inView: overlap(box(n), box(vp())), tour: !!q(".ls-tour-card"), tourDone: env.stored().tourDone === true };
  }

  // &tile=helpdesk: the Helpdesk tile is New workspace → Helpdesk tasks…: the built-in preset started (main refuses it
  // in a team room's area, ?lsHelpdeskRoom, and says why)
  // &twice=double|apart (with ?createMs): a double click, or two clicks 400 ms apart, while the first is starting it
  if (params.get("tile") === "helpdesk") {
    const said: string[] = [];
    window.alert = (m?: unknown) => void said.push(String(m));
    const mark = env.calls.length;
    const tile = q('.ls-empty-tile[data-tile="new:helpdesk"]')!;
    const at = middle(tile);
    const twice = params.get("twice");
    if (twice === "double") await act([{ mouse: { ...at, clickCount: 1 } }, { mouse: { ...at, clickCount: 2 } }]);
    else if (twice === "apart") await act([{ mouse: { ...at, clickCount: 1 } }, { pause: 400 }, { mouse: { ...at, clickCount: 1 } }]);
    else await clickOn(tile);
    await sleep(100);
    out.helpdeskDuring = { busy: tile.getAttribute("aria-busy"), sub: tile.querySelector(".s")?.textContent ?? null, note: q(".ls-note")?.textContent ?? null };
    await sleep(Number(params.get("createMs") ?? 0) + 1200);
    const n = q(".ls-world .ls-node");
    out.helpdesk = {
      started: env.calls.slice(mark).filter((c) => c.fn === "presetStart").map((c) => c.args[0]),
      created: env.sessions().filter((s) => s.role === "tasks").map((s) => s.taskGroup),
      empty: !!q(".ls-empty"),
      workspace: n?.dataset.front ? env.sessions().find((s) => s.id === n.dataset.front)?.role ?? null : null,
      said,
      keyboard: keyboard(),
    };
  }
}

async function barPart(env: FirstRunEnv, out: Record<string, unknown>): Promise<void> {
  await sleep(800);
  const bar = q(".topbar")!;
  const barBox = box(bar);
  const tops = [...bar.children].filter((c) => !c.classList.contains("spacer") && !c.classList.contains("tb-probe"));
  const named = tops.map((c) => ({ name: c.textContent?.trim() ?? "", box: box(c) }));
  out.items = named.map((n) => n.name);
  out.tabs = qs(".tabs .tab").map((t) => t.textContent?.trim());
  out.more = q(".tb-more")?.textContent?.trim() ?? null;
  out.keys = !!q(".tb-keys");
  out.height = barBox?.h;
  out.oneLine = named.every((n) => n.box && n.box.h <= 32);
  out.inWindow = named.every((n) => within(n.box, win(), 1));
  out.apart = named.every((a, i) => named.slice(i + 1).every((b) => !overlap(a.box, b.box)));
  // every label whole, not cut off by its box
  out.notCut = qs(".topbar button").every((b) => b.scrollWidth <= b.clientWidth + 1);
  out.scrollsSideways = document.documentElement.scrollWidth > window.innerWidth;
  out.whatsNew = !!q(".brand .ver");
  out.rightEdge = Math.max(...named.map((n) => (n.box ? n.box.x + n.box.w : 0)));
  out.window = { w: innerWidth, h: innerHeight };
  if (params.get("case") === "edges") return;

  const typeInPalette = async (text: string) => {
    await press("k", { meta: true });
    await sleep(250);
    const input = q<HTMLInputElement>(".palette input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(200);
    await press("Enter");
    await sleep(350);
  };
  const writes = () => env.calls.filter((c) => c.fn === "sessionWrite").length;
  /** What has the keyboard, and whether a key typed now reaches a terminal. */
  const keyboardAndTyping = async () => {
    const k = keyboard();
    const was = writes();
    await press("x");
    await sleep(150);
    return { keyboard: k, typed: writes() - was };
  };

  if (params.get("case") === "handback") {
    // What's opened from the palette or a menu gives the keyboard back past the row it came from, which has gone: to
    // what had it before the palette or the menu. (?lsCamera at 100%, so s1's terminal takes keys.)
    const term = () => q<HTMLTextAreaElement>('.ls-world .ls-node[data-front="s1"] .xterm-helper-textarea, .ls-focus .xterm-helper-textarea');
    const toTerminal = async () => {
      await clickOn(card("s1")!);
      await sleep(250);
      term()?.focus();
      await sleep(60);
    };
    await toTerminal();
    out.start = keyboard();
    await typeInPalette("Shortcuts");
    out.sheetFromPalette = !!q(".ls-keys");
    await afterEsc();
    out.afterSheetFromPalette = await keyboardAndTyping();
    await toTerminal();
    await typeInPalette("New session");
    out.dialogFromPalette = q(".modal h3")?.textContent ?? null;
    await afterEsc();
    out.afterDialogFromPalette = await keyboardAndTyping();
    // the same dialog closed by its own button rather than Esc: back to the terminal too, as from the palette alone
    await toTerminal();
    await typeInPalette("New session");
    const cancel = qs(".modal button").find((b) => b.textContent?.trim() === "Cancel");
    out.dialogPressed = cancel ? q(".modal h3")?.textContent ?? null : null;
    if (cancel) await clickOn(cancel);
    await sleep(200);
    out.afterDialogPressed = await keyboardAndTyping();
    // ⌘K, then a command that opens nothing (the log panel, toggled and back): typing reaches the terminal again
    await toTerminal();
    await typeInPalette("Toggle the log panel");
    out.afterCommand = await keyboardAndTyping();
    await toTerminal();
    await typeInPalette("Toggle the log panel");
    out.afterCommandBack = await keyboardAndTyping();
    // a dialog from a menu row: the landscape had the keyboard as the menu opened
    await giveLandscape();
    const p = barePoint();
    await rightAt(p.x, p.y);
    await sleep(200);
    await clickOn(qs(".mb-ctx:not(.mb-ghost) button").find((b) => /Terminal…/.test(b.textContent ?? ""))!);
    await sleep(600);
    out.dialogFromMenu = { dialog: q(".modal h3")?.textContent ?? null, keyboard: keyboard() };
    await afterEsc();
    out.afterDialogFromMenu = keyboard();
    // in focus: its terminal had the keyboard
    await clickOn(card("s1")!);
    await sleep(200);
    await giveLandscape();
    await press("Enter");
    await sleep(400);
    term()?.focus();
    await sleep(60);
    out.focusStart = keyboard();
    await typeInPalette("Shortcuts");
    await afterEsc();
    out.afterSheetInFocus = { ...(await keyboardAndTyping()), focus: !!q(".ls-focus") };
    return;
  }
  if (params.get("case") === "foldsheet") {
    // the sheet under », and Needs you's count changing: » is the same button, and the sheet stays where it was
    const more = q(".tb-more");
    if (!more) throw new Error("nothing folded at this width");
    (more as HTMLElement & { mark?: number }).mark = 1;
    await clickOn(more);
    await sleep(200);
    await clickOn(qs(".mb-ctx:not(.mb-ghost) button").find((b) => /Shortcuts/.test(b.textContent ?? ""))!);
    await sleep(250);
    const sheetAt = box(q(".ls-keys"));
    const needsBefore = q(".ny-btn")?.textContent ?? null;
    env.setSession("s3", { status: "waiting", waitingReason: "Claude needs your permission to use Bash", waitingSince: Date.now() - 60_000 });
    await sleep(500);
    const now = q<HTMLElement & { mark?: number }>(".tb-more");
    const sheetNow = box(q(".ls-keys"));
    const moreBox = box(now)!;
    out.countChanged = {
      needs: [needsBefore, q(".ny-btn")?.textContent ?? null],
      sameMore: now?.mark === 1,
      sheetStayed: !!sheetAt && !!sheetNow && Math.abs(sheetAt.x - sheetNow.x) <= 1 && Math.abs(sheetAt.y - sheetNow.y) <= 1,
      sheetUnderMore: !!sheetNow && sheetNow.y >= moreBox.y + moreBox.h,
      keyboard: keyboard(),
    };
    await afterEsc();
    out.afterEsc = keyboard();
    // » with the keyboard keeps it through another change
    env.setSession("s5", { status: "waiting", waitingReason: "Claude needs your permission to use Edit", waitingSince: Date.now() - 30_000 });
    await sleep(500);
    out.afterSecondChange = { keyboard: keyboard(), sameMore: q<HTMLElement & { mark?: number }>(".tb-more")?.mark === 1 };
    await press("t");
    await sleep(200);
    out.tOnMore = q(".ls-note")?.textContent ?? null;
    return;
  }

  if (params.get("case") === "sheet") {
    await fit();
    await clickOn(q(".tb-keys")!);
    await sleep(200);
    const list = q(".ls-keys-list")!;
    out.sheet = { open: !!q(".ls-keys"), inWindow: within(box(q(".ls-keys")), win(), 1), scrolls: list.scrollHeight > list.clientHeight + 1, keyboard: keyboard() };
    out.window = { w: innerWidth, h: innerHeight };
    // a press on the button closes it and gives the keyboard back to the button
    await clickOn(q(".tb-keys")!);
    await sleep(150);
    out.sheetToggled = { open: !!q(".ls-keys"), keyboard: keyboard() };
    // beside the tray: opening one puts the other away
    await clickOn(q(".ny-btn")!);
    await sleep(200);
    await clickOn(q(".tb-keys")!);
    await sleep(200);
    out.sheetOverTray = { sheet: !!q(".ls-keys"), tray: !!q(".ny-tray") };
    await clickOn(q(".ny-btn")!);
    await sleep(200);
    out.trayOverSheet = { sheet: !!q(".ls-keys"), tray: !!q(".ny-tray") };
    await afterEsc();
    // opened by `?`, a palette over it puts it away, and Esc from the palette gives the landscape the keyboard back
    await giveLandscape();
    await press("?", { shift: true });
    await sleep(150);
    await press("k", { meta: true });
    await sleep(250);
    out.paletteOverSheet = { sheet: !!q(".ls-keys"), palette: !!q(".palette") };
    await afterEsc();
    await sleep(100);
    out.afterPalette = { sheet: !!q(".ls-keys"), keyboard: keyboard() };
    // from the palette too
    await press("k", { meta: true });
    await sleep(200);
    const input = q<HTMLInputElement>(".palette input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Shortcuts");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(150);
    await press("Enter");
    await sleep(300);
    out.fromPalette = { sheet: !!q(".ls-keys"), palette: !!q(".palette") };
    await afterEsc();
    return;
  }
  if (params.get("case") === "tab") {
    await clickOn(qs(".tab").find((t) => t.textContent?.trim() === "Dashboard")!);
    await sleep(400);
    await clickOn(q(".topbar > button.primary")!);
    await sleep(300);
    out.fromDashboard = { dialog: q(".modal.ns h3")?.textContent ?? null, menu: !!q(".mb-ctx"), tab: q(".tab.on")?.textContent?.trim() ?? null };
    await afterEsc();
    await clickOn(qs(".tab").find((t) => t.textContent?.trim() === "Landscape")!);
    await sleep(400);
    out.backOnTab = { tab: q(".tab.on")?.textContent?.trim() ?? null, keyboard: keyboard() };
    await press("?", { shift: true });
    await sleep(150);
    out.questionAfterTabClick = !!q(".ls-keys");
    return;
  }
  if (params.get("case") === "fold") {
    const more = q(".tb-more");
    if (!more) throw new Error("nothing folded at this width");
    await clickOn(more);
    await sleep(200);
    out.foldMenu = menuRows();
    const rows = qs(".mb-ctx:not(.mb-ghost) button");
    const shortcut = rows.find((b) => /Shortcuts/.test(b.textContent ?? ""));
    await afterEsc();
    // `?` with the button folded: the sheet still opens, under » and inside the window
    await giveLandscape();
    await press("?", { shift: true });
    await sleep(200);
    out.sheetFolded = { open: !!q(".ls-keys"), inWindow: within(box(q(".ls-keys")), win(), 1) };
    await afterEsc();
    // a folded tab runs from the menu
    await clickOn(q(".tb-more")!);
    await sleep(200);
    const settings = qs(".mb-ctx:not(.mb-ghost) button").find((b) => /Settings/.test(b.textContent ?? ""));
    out.hadShortcutRow = !!shortcut;
    if (settings) {
      await clickOn(settings);
      await sleep(350);
      out.toSettings = !!q(".set-nav");
    }
    return;
  }

  // + New: the create menu at the view's centre, in the area there when there's one, placing what it makes there
  await fit();
  const before = keyboard();
  await clickOn(q(".topbar > button.primary")!);
  await sleep(250);
  const v = box(vp())!;
  const c = ctxBox();
  out.newMenu = {
    rows: menuRows(),
    at: c && { x: c.x, y: c.y },
    centre: { x: v.x + v.w / 2, y: v.y + v.h / 2 },
    before,
    keyboard: keyboard(),
  };
  await afterEsc();
  out.afterNewMenu = keyboard();
  // over a landscape with no area at the centre, and with one: it's the area's when the centre is in it
  const areas = qs(".ls-world .ls-area");
  const center = { x: v.x + v.w / 2, y: v.y + v.h / 2 };
  out.centreInArea = areas.find((a) => {
    const b = box(a)!;
    return center.x >= b.x && center.x <= b.x + b.w && center.y >= b.y && center.y <= b.y + b.h;
  })?.dataset.area ?? null;

  // a row's dialog takes the keyboard, whatever it fills in as it opens
  await clickOn(q(".topbar > button.primary")!);
  await sleep(250);
  await clickOn(qs(".mb-ctx:not(.mb-ghost) button").find((b) => /Terminal…/.test(b.textContent ?? ""))!);
  await sleep(700);
  out.newDialogKeyboard = keyboard();
  await afterEsc();

  // from its menu, Claude… makes a workspace that overlaps nothing
  const namesBefore = new Set(env.sessions().map((s) => s.id));
  await clickOn(q(".topbar > button.primary")!);
  await sleep(250);
  const claude = qs(".mb-ctx:not(.mb-ghost) button").find((b) => /Claude…/.test(b.textContent ?? ""));
  await clickOn(claude!);
  await sleep(300);
  const go = qs<HTMLButtonElement>(".modal.ns button.primary").pop();
  await clickOn(go!);
  await sleep(1200);
  const made = env.sessions().find((s) => !namesBefore.has(s.id));
  const placed = made ? env.stored().workspaces[made.id] : null;
  const others = made ? Object.entries(env.stored().workspaces).filter(([id]) => id !== made.id) : [];
  out.made = {
    id: made?.id ?? null,
    group: made?.taskGroup ?? null,
    placed,
    overlaps: placed ? others.filter(([, r]) => overlap(placed, r)).map(([id]) => id) : [],
  };
  // in focus: + New still opens the menu over it
  await sleep(200);
  if (q(".ls-focus")) await press("e", { meta: true });
  await sleep(250);
  await fit();
  const someone = card("s1");
  if (someone) {
    await clickOn(someone);
    await sleep(150);
    await giveLandscape();
    await press("Enter");
    await sleep(300);
    await clickOn(q(".topbar > button.primary")!);
    await sleep(250);
    const m = q(".mb-ctx:not(.mb-ghost)");
    const p = m && middle(m);
    out.newInFocus = { focus: !!q(".ls-focus"), menu: !!m, onTop: !!p && !!document.elementFromPoint(p.x, p.y)?.closest(".mb-ctx") };
    await afterEsc();
  }
  // in focus on a workspace in 5102: what + New makes is 5102's, beside it, whatever's under the landscape's centre
  if (q(".ls-focus")) await press("e", { meta: true });
  await sleep(250);
  await fit();
  const s5 = card("s5");
  if (s5) {
    await clickOn(s5);
    await sleep(150);
    await giveLandscape();
    await press("Enter");
    await sleep(300);
    const before5 = new Set(env.sessions().map((s) => s.id));
    await clickOn(q(".topbar > button.primary")!);
    await sleep(250);
    await clickOn(qs(".mb-ctx:not(.mb-ghost) button").find((b) => /Terminal…/.test(b.textContent ?? ""))!);
    await sleep(700);
    const text = q(".modal.ns")?.textContent ?? "";
    out.focusDialog = { focus: !!q(".ls-focus"), says5102: /\b5102\b/.test(text), says5101: /\b5101\b/.test(text), connected: /connected/i.test(q(".modal.ns .ns-foot, .modal.ns footer")?.textContent ?? text.slice(-200)) };
    const go = qs<HTMLButtonElement>(".modal.ns button.primary").pop();
    if (go) {
      await clickOn(go);
      await sleep(1200);
    }
    const made5 = env.sessions().find((s) => !before5.has(s.id));
    const area5 = env.stored().areas["5102"];
    const placed5 = made5 ? env.stored().workspaces[made5.id] : null;
    out.madeInFocus = { group: made5?.taskGroup ?? null, inArea: !!placed5 && !!area5 && within({ ...placed5 }, { x: area5.x, y: area5.y, w: area5.w, h: area5.h }, 1) };
  }
}

/**
 * =a: typed keys against the landscape's arming (keyArm.ts): what's typed acts on the landscape only when the user gave
 * it the keyboard, and reaches no session but the one it was typed for. By &case=:
 * - tour (&how=esc|skip|click, with ?lsCamera=0,0,1&needsMany at 1024×768): the tour comes up as s1's terminal is typed
 *   in, its camera taking the view out of the band terminals take keys in; it's ended, and typing goes straight on
 *   (click: a press elsewhere as the camera comes back, which ends the tour's hold on the keyboard);
 * - peekLog, peekGone (with ?lsCamera=0,0,0.5): a peek open under a resting pointer while the bottom panel's log
 *   terminal is typed in, or with the keyboard nowhere (the field being typed in removed);
 * - jumpInTour (with ?lsCamera=0,0,1): ⌘K to another session during the tour, then the tour ended and typing;
 * - jumpKeys (with ?lsCamera=0,0,1): ⌘K to another session from s1's terminal, typing straight after Enter;
 * - press (with ?needsMany): the landscape given the keyboard by code, as a hand-back gives it, then by a press;
 * - zoomOut (with ?lsCamera=0,0,1&needsMany): a terminal typed in, then a trackpad zoom out of the band it takes keys in;
 * - cap (with ?lsCamera=0,0,1): the tour's hold on the keyboard running to its cap, the terminal unable to take it;
 * - frame: focus's frame given the keyboard by code, then by a press on its header;
 * - walk (&how=closed|closedTab|tour, with ?lsCamera=0,0,1&needsMany): the keyboard nowhere (s1's terminal gone as
 *   it's typed in, or the tour ended after ⌘K went elsewhere during it), then Tab or Shift+Tab, then typing;
 * - mount (&how=jump|notified|cycle|paletteRow|tabClick): the landscape mounted from another tab by a ⌘K jump (the window
 *   opened there, &tab=dashboard), by a notification before any input, by ⌥⇥ after the Dashboard tab was pressed, by
 *   ⌘K's Landscape row, or by its tab;
 * - hud (with ?lsCamera=0,0,0.625): the zoom HUD's Zoom out pressed, then a peek's Space, then Tab;
 * - hint (with ?needsMany): typed keys swallowed by the landscape disarmed, and with the keyboard nowhere, and ⌘E;
 * - pressNothing: a press on the top bar's bare middle, then Tab;
 * - button (&btn=hud|chip|typist|head, with ?lsCamera=0,0,1): s1's terminal typed in, a landscape button pressed (or
 *   s1's own header, off its buttons), typing on;
 * - headOther (with ?lsCamera=0,0,1): s1's terminal typed in, another workspace's header pressed, then ?;
 * - frameButton (with ?lsCamera=0,0,1): the same in focus on s1, a button on its frame, then Esc;
 * - lag (&how=go|side|dialog|dialogGone|idle, with ?lsCamera=0,0,1): Go there on s3 (a stack's back tab), or a
 *   double-click on its side bar row, while main is slow to bring it to the front; meanwhile s1's terminal clicked into
 *   and typed in (go, side), a join prompt coming up on its own (dialog, with ?joinRequest=later), and going on its own
 *   too (dialogGone), or nothing (idle);
 * - preset (&how=typed|idle, with ?lsCamera=500,0,0.75&needsMany): ⌘K's Start preset while main is slow to start it
 *   (it answers with s2, on screen); meanwhile s1's terminal clicked into and typed in, or nothing;
 * - selfClose (with ?joinRequest=later&lsCamera=0,0,0.4): the landscape armed by a press, a join prompt coming up and
 *   going on its own, then ?, N, Enter and y;
 * - frameGone (with ?lsCamera=0,700,0.75): a teammate's workspace focused by a press on its header and Enter, the
 *   frame's session gone, then Shift+Tab ×5 and y;
 * - jumpCards (with ?lsCamera=0,0,0.2): ⌘K to a session whose terminal isn't there (cards), then Shift+Tab ×5 and y;
 * - escMask: the shortcuts sheet opened, the app's Esc cut off, then Esc: the sheet stays (the driver's Esc does no
 *   more than a key's);
 * - menuEsc (with ?lsCamera=0,0,0.4): the landscape armed by a press, the right-click menu opened on it and left with
 *   Esc, then ?;
 * - jumpOver (&how=dialog|none|palette, with ?lsCamera=500,0,0.75&needsMany): a notification's jump to s2 (on screen)
 *   while a join prompt that came up on its own is open (dialog, with ?joinRequest=later), or with nothing open (none);
 *   or ⌘K's jump to s2 (palette); then y;
 * - join (&how=withdrawn|enter|esc, with ?joinRequest=later&lsCamera=0,0,1): Go there on Lee's request, then the
 *   request going from under its prompt, or Accept with Enter, or Esc;
 * - tabWalk (&how=fresh|palette|reopen): Tab from a fresh window (&tab=dashboard, &tab=settings), after
 *   ⌘K's Dashboard row, after the side bar's Reopen went with Enter;
 * - escape (&how=tab|shift, with ?lsCamera=0,0,1): s1's terminal gone as it's typed in, then a pause, then Tab or
 *   Shift+Tab.
 */
async function armingPart(env: FirstRunEnv, out: Record<string, unknown>): Promise<void> {
  const which = params.get("case");
  await sleep(600);
  const typeKeys = async (keys: string[], gap: number) => {
    for (const k of keys) {
      await press(k);
      await sleep(gap);
    }
  };
  /** A real click into a session's terminal, on a part of it nothing covers: the keyboard is that terminal's. */
  const intoTerm = async (id: string) => {
    const screen = q(`.ls-world .ls-node[data-front="${id}"] .xterm-screen`);
    if (!screen) throw new Error(`no terminal on screen for ${id}`);
    const r = screen.getBoundingClientRect();
    let at: { x: number; y: number } | null = null;
    for (let y = r.top + Math.min(120, r.height / 2); !at && y < r.bottom - 4; y += 24)
      for (let x = r.left + Math.min(200, r.width / 2); !at && x < r.right - 4; x += 40)
        if (x > 0 && y > 0 && x < innerWidth && y < innerHeight && screen.closest(".term-holder")?.contains(document.elementFromPoint(x, y))) at = { x, y };
    if (!at) {
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const over = document.elementFromPoint(x, y);
      throw new Error(`no uncovered part of ${id}'s terminal (${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}; its middle under ${over ? nameOf(over) : "nothing"})`);
    }
    await act([{ mouse: { ...at, clickCount: 1 } }]);
    await sleep(300);
    return document.activeElement?.closest<HTMLElement>(".ls-node")?.dataset.front === id && keyboard() === "terminal";
  };
  /** A point on workspace `front`'s header off its buttons and tabs, inside the window. */
  const bareHead = (front: string): { x: number; y: number } | null => {
    const head = q(`.ls-world .ls-node[data-front="${front}"] .ls-head`);
    if (!head) return null;
    const r = head.getBoundingClientRect();
    const y = r.top + r.height / 2;
    for (let x = r.left + 4; x < r.right - 4; x += 6) {
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      const el = document.elementFromPoint(x, y);
      if (el && head.contains(el) && !el.closest("button, [role=button], a[href], input, .ls-tab")) return { x, y };
    }
    return null;
  };
  const writesSince = (mark: number) => env.calls.slice(mark).filter((c) => c.fn === "sessionWrite").map((c) => String(c.args[0]));
  /** What was written to session `id`'s terminal since `mark`. */
  const dataTo = (id: string, mark: number) =>
    env.calls
      .slice(mark)
      .filter((c) => c.fn === "sessionWrite" && c.args[0] === id)
      .map((c) => String(c.args[1]))
      .join("");
  /** Anything that changes a session, a layout or a group since `mark`: name and first argument. */
  const actsSince = (mark: number) =>
    env.calls
      .slice(mark)
      .filter((c) => /Write$|^landscapeUpdate|^setGroup|^kill|^create|^relaunch|^resume|^forget/.test(c.fn))
      .map((c) => `${c.fn} ${JSON.stringify(c.args[0]) ?? ""}`);
  /** The note on the landscape, and what each one put up since `watchNotes` began said. Only the viewport's own
   *  children are watched (the note is one): the terminals under it change all the time, and a subtree observer
   *  over them slows the page to a crawl. */
  const notesSaid: string[] = [];
  const watchNotes = () => {
    const mo = new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n instanceof HTMLElement && n.classList.contains("ls-note")) notesSaid.push(n.textContent?.trim() ?? "");
    });
    mo.observe(vp(), { childList: true });
    return () => mo.disconnect();
  };
  const noteText = () => q(".ls-note")?.textContent?.trim() ?? null;
  /** What an element is, for saying where the keyboard went. */
  const nameOf = (el: Element) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} ${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}`;
  const changesSince = (mark: number) =>
    env.calls.slice(mark).filter((c) => (c.fn === "landscapeUpdate" && JSON.stringify(c.args[0]) !== '{"tourDone":true}') || c.fn === "setGroup").map((c) => c.fn);
  const opened = () => ({ focus: !!q(".ls-focus"), sheet: !!q(".ls-keys"), dialog: !!q(".modal-back:not(.mb-ghost)"), menu: !!q(".mb-ctx:not(.mb-ghost)"), palette: !!q(".palette") });
  const peekNow = () => {
    const p = q(".ls-peek");
    return p ? { of: p.dataset.peek ?? null, pinned: p.classList.contains("pinned") } : null;
  };
  /** The pointer brought to rest on a workspace, long enough for its peek. */
  const restOn = async (front: string) => {
    const c = box(card(front));
    if (!c) throw new Error(`no card for ${front}`);
    await act([{ move: { x: c.x + c.w / 2, y: c.y + Math.min(c.h / 2, 60) } }]);
    await sleep(PEEK_HOVER_MS + 300);
  };
  /** Session `id`'s terminal gets the keyboard at any point from here: the times, in ms. */
  const watchKeys = (id: string) => {
    const t0 = performance.now();
    const got: number[] = [];
    const on = (e: FocusEvent) => {
      if ((e.target as Element | null)?.closest?.(`.ls-node[data-front="${id}"] .xterm`)) got.push(Math.round(performance.now() - t0));
    };
    document.addEventListener("focusin", on, true);
    return () => {
      document.removeEventListener("focusin", on, true);
      return got;
    };
  };

  if (which === "tour") {
    const how = params.get("how") ?? "esc";
    out.before = await intoTerm("s1");
    await press("g");
    await sleep(60);
    env.patch({ tourDone: false });
    await typeKeys([..."it status"], 60);
    out.tourUp = { tour: !!q(".ls-tour-card"), terminalsTakeKeys: zoomNow() >= 0.75 };
    // the keys stop; the tour settles where it put the camera
    await sleep(1300);
    for (let i = 0; i < 50 && vp().hasAttribute("data-flying"); i++) await sleep(40);
    const sel = selected();
    const mark = env.calls.length;
    if (how === "click") {
      // Esc, and straight after it a press away from the landscape (the top bar's bare middle, which takes no
      // keyboard) while the camera comes back: the hold ends there, and the terminal isn't given the keyboard after it
      let atPress: string | null = null;
      let pressedAt = 0;
      const got: number[] = [];
      const onDown = () => {
        if (atPress !== null) return;
        atPress = keyboard();
        pressedAt = performance.now();
      };
      const onFocus = (e: FocusEvent) => {
        if (pressedAt && (e.target as Element | null)?.closest?.('.ls-node[data-front="s1"] .xterm')) got.push(Math.round(performance.now() - pressedAt));
      };
      window.addEventListener("pointerdown", onDown, true);
      document.addEventListener("focusin", onFocus, true);
      const s = box(q(".topbar > .spacer"))!;
      await act([{ key: "Escape" }, { mouse: { x: s.x + s.w / 2, y: s.y + s.h / 2, clickCount: 1 } }]);
      await sleep(1500);
      window.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("focusin", onFocus, true);
      out.afterClick = { spacer: s.w > 4, atPress, keyboard: keyboard(), s1HadKeys: got };
      return;
    }
    // the keyboard 15 ms after the tour's end arrives: the tour gives the landscape none. The card's removal leaves it on
    // the page for the task before the holder takes it (keyArm.ts), which a sample can land in: nowhere either way
    let atEnd: string | null = null;
    const onEnd = (e: Event) => {
      const ends = e.type === "keydown" ? (e as KeyboardEvent).key === "Escape" : !!(e.target as Element | null)?.closest?.('[data-act="skip"]');
      if (ends) setTimeout(() => (atEnd ??= keyboard() === "body" ? "nowhere" : keyboard()), 15);
    };
    document.addEventListener("keydown", onEnd, true);
    document.addEventListener("click", onEnd, true);
    if (how === "skip") await clickOn(q('.ls-tour-card [data-act="skip"]')!);
    else await press("Escape");
    await sleep(40);
    document.removeEventListener("keydown", onEnd, true);
    document.removeEventListener("click", onEnd, true);
    out.atEnd = atEnd;
    // N, then text: a Tab that could walk onto a button, Tidy's letter, Enter, and a prompt's y
    await typeKeys(["n", "Tab", "t", "Enter", "x", "y"], 50);
    await sleep(1500);
    out.after = {
      tour: !!q(".ls-tour-card"),
      keyboard: keyboard(),
      others: writesSince(mark).filter((id) => id !== "s1"),
      s1Got: dataTo("s1", mark),
      changes: changesSince(mark),
      selected: selected() === sel,
      ...opened(),
    };
    // and s1 has its keyboard back: a key now is written to it
    const mark2 = env.calls.length;
    await press("z");
    await sleep(200);
    out.typedAfter = writesSince(mark2);
  } else if (which === "peekLog" || which === "peekGone") {
    if (which === "peekLog") {
      // a dev server's log in the bottom panel, its terminal clicked into
      const w = window as unknown as { mb: { runBuffer: () => Promise<string> }; __mbEmit: (ev: string, ...a: unknown[]) => void };
      w.mb.runBuffer = async () => "vite dev server running\r\n  press h + enter to show help\r\n";
      w.__mbEmit("onRunChanged", [{ id: "r1", service: "web", worktree: "/tmp/w", repo: "/tmp/w", slot: 0, status: "running", ports: [], pid: 1, exitCode: null, startedAt: Date.now() }]);
      await sleep(300);
      await press("j", { meta: true });
      await sleep(600);
      const lb = box(q(".bp .xterm"));
      if (!lb) throw new Error("no log terminal in the bottom panel");
      await act([{ mouse: { x: lb.x + 100, y: lb.y + 40, clickCount: 1 } }]);
      await sleep(300);
      out.before = !!document.activeElement?.closest(".bp .xterm");
    } else {
      // the side bar's filter typed in
      const f = box(q(".area-tree input"));
      if (!f) throw new Error("no filter field");
      await act([{ mouse: { x: f.x + 20, y: f.y + f.h / 2, clickCount: 1 } }]);
      await sleep(200);
      await press("a");
      await sleep(100);
      out.before = document.activeElement?.tagName === "INPUT";
    }
    await restOn("s2");
    out.peek = peekNow();
    // the field goes while being typed in: the keyboard is nowhere
    if (which === "peekGone") document.activeElement?.remove();
    const mark = env.calls.length;
    const keys = which === "peekLog" ? ["h", " ", "x", "Enter", "y", "e", "s", "Enter"] : ["p", " ", "x", "Enter", "y"];
    await typeKeys(keys, 150);
    await sleep(300);
    out.after = {
      peek: peekNow(),
      focus: !!q(".ls-focus"),
      sessionWrites: writesSince(mark),
      inLog: !!document.activeElement?.closest(".bp .xterm"),
      // what reached the log's terminal: written to the process, or held back by its input guard (inputGuard.ts)
      logData: env.calls
        .slice(mark)
        .filter((c) => c.fn === "runWrite" || (c.fn === "auditWrite" && String(c.args[0]).startsWith("run:")))
        .map((c) => String(c.args[c.fn === "runWrite" ? 1 : 2]))
        .join(""),
    };
  } else if (which === "jumpInTour") {
    out.before = await intoTerm("s1");
    const start = camera();
    await press("g");
    await sleep(40);
    env.patch({ tourDone: false });
    await sleep(1500);
    out.tourUp = !!q(".ls-tour-card");
    await press("k", { meta: true });
    await sleep(300);
    await typeKeys([..."test runner"], 40);
    await press("Enter");
    await sleep(800);
    out.jumped = { selected: selected(), tour: !!q(".ls-tour-card") };
    await sleep(600);
    await press("Escape");
    await sleep(1200);
    const mark = env.calls.length;
    await typeKeys([..."abc"], 150);
    await sleep(300);
    out.after = { tour: !!q(".ls-tour-card"), selected: selected(), cameraBack: !moved(start, camera()), toS1: writesSince(mark).filter((id) => id === "s1").length, keyboard: keyboard() };
  } else if (which === "jumpKeys") {
    out.before = await intoTerm("s1");
    await press("k", { meta: true });
    await sleep(300);
    await typeKeys([..."test runner"], 40);
    const s1 = watchKeys("s1");
    const mark = env.calls.length;
    // Enter, and typing straight on
    await act([{ key: "Enter" }, { key: "a" }, { key: "b" }, { key: "c" }]);
    await sleep(600);
    // the session gone to has the keyboard: a key now is written to it
    await press("z");
    await sleep(200);
    out.after = { s1HadKeys: s1(), toS1: writesSince(mark).filter((id) => id === "s1").length, last: writesSince(mark).at(-1) ?? null, selected: selected() };
  } else if (which === "press") {
    // given the keyboard by code, as a hand-back gives it: what's typed does nothing
    await fit();
    vp().focus({ preventScroll: true });
    vp().blur();
    vp().focus({ preventScroll: true });
    await sleep(60);
    const sel0 = selected();
    await press("n");
    await sleep(250);
    await press("?", { shift: true });
    await sleep(250);
    // a Tab can't walk it onto a button for the Enter after to press
    await press("Tab");
    await sleep(100);
    await press("Enter");
    await sleep(250);
    out.byCode = { keyboard: keyboard(), moved: selected() !== sel0, ...opened() };
    // the palette opened from it and left gives it back as it was: disarmed
    await press("k", { meta: true });
    await sleep(250);
    await press("Escape");
    await sleep(250);
    await press("n");
    await sleep(250);
    out.afterPalette = { keyboard: keyboard(), moved: selected() !== sel0, ...opened() };
    // a press on it arms it
    await act([{ mouse: { ...barePoint(), clickCount: 1 } }]);
    await sleep(200);
    const sel1 = selected();
    await press("n");
    await sleep(300);
    out.byPress = { keyboard: keyboard(), moved: selected() !== sel1 };
    // and the palette opened from it, left with Esc, gives it back armed
    await press("k", { meta: true });
    await sleep(250);
    await press("Escape");
    await sleep(250);
    await press("?", { shift: true });
    await sleep(300);
    out.afterPalette2 = { sheet: !!q(".ls-keys") };
  } else if (which === "cap") {
    // s1's terminal made unable to take the keyboard while the tour holds it: the hold after the tour runs to its cap,
    // each key holding it longer, then leaves the keyboard nowhere and says so in the log
    out.before = await intoTerm("s1");
    const ta = document.activeElement as HTMLTextAreaElement;
    env.patch({ tourDone: false });
    await sleep(1500);
    out.tourUp = !!q(".ls-tour-card");
    ta.disabled = true;
    const said = () => consoleSaid().filter((l) => l.includes("couldn't give s1's terminal its keyboard back")).length;
    await press("Escape");
    await sleep(1000);
    await press("x");
    await sleep(1500);
    // past the cap from the tour's end, short of it from the key
    out.beforeCap = { said: said(), keyboard: keyboard() };
    await sleep(1000);
    out.afterCap = { said: said(), keyboard: keyboard(), tour: !!q(".ls-tour-card") };
    ta.disabled = false;
  } else if (which === "frame") {
    // focus on s1, then its frame given the keyboard by code, as a hand-back gives it: Esc there doesn't leave focus
    await fit();
    await clickOn(card("s1")!);
    await sleep(200);
    await press("Enter");
    await sleep(500);
    const frame = () => q(".ls-focus");
    const where = () => (document.activeElement && document.activeElement === frame() ? "frame" : keyboard());
    out.entered = !!frame();
    frame()?.focus({ preventScroll: true });
    await sleep(60);
    await press("Escape");
    await sleep(300);
    out.byCode = { focus: !!frame(), keyboard: where() };
    if (!frame()) return;
    // a press on the frame's header, off its buttons, arms it: Esc then leaves focus
    const h = box(q(".ls-focus .ls-head"));
    if (!h) throw new Error("no header on the focused workspace");
    let pt: { x: number; y: number } | null = null;
    for (let x = h.x + 4; x < h.x + h.w - 4 && !pt; x += 6) {
      const el = document.elementFromPoint(x, h.y + h.h / 2);
      if (el?.closest(".ls-focus") && !el.closest("button, a, input, textarea, .xterm")) pt = { x, y: h.y + h.h / 2 };
    }
    if (!pt) throw new Error("no bare point on the focused workspace's header");
    await act([{ mouse: { ...pt, clickCount: 1 } }]);
    await sleep(200);
    out.pressed = where();
    await press("Escape");
    await sleep(400);
    out.byPress = { focus: !!frame() };
  } else if (which === "zoomOut") {
    // the window opened on it, so it was armed; then a terminal typed in, and the trackpad zooms out: the band hands
    // the landscape the keyboard, disarmed
    const inS1 = await intoTerm("s1");
    await press("g");
    await sleep(100);
    const v = box(vp())!;
    for (let i = 0; i < 6; i++) await act([{ wheel: { x: v.x + v.w / 2, y: v.y + v.h / 2, dy: 120, ctrl: true } }]);
    await sleep(500);
    const sel2 = selected();
    await press("n");
    await sleep(300);
    out.afterZoom = { inS1, terminalsTakeKeys: zoomNow() >= 0.75, keyboard: keyboard(), moved: selected() !== sel2 };
  } else if (which === "walk") {
    const how = params.get("how") ?? "closed";
    out.before = await intoTerm("s1");
    if (how === "tour") {
      // the tour comes up over s1's terminal; ⌘K goes to s4 during it, then Esc ends it
      await press("g");
      await sleep(40);
      env.patch({ tourDone: false });
      await sleep(1800);
      out.tourUp = !!q(".ls-tour-card");
      await press("k", { meta: true });
      await sleep(400);
      await typeKeys([..."test runner"], 40);
      await press("Enter");
      await sleep(2200);
      await press("Escape");
      await sleep(300);
      out.ended = { tour: !!q(".ls-tour-card"), keyboard: keyboard() };
    } else {
      // s1 closed elsewhere as its terminal is typed in
      await press("a");
      await sleep(100);
      env.setSession("s1", null);
      await sleep(300);
      out.gone = { s1: !card("s1"), keyboard: keyboard() };
    }
    // a control or a terminal given the keyboard from here on
    const reached: string[] = [];
    const onFocus = (e: FocusEvent) => {
      const t = e.target as Element | null;
      if (t instanceof Element && !t.classList.contains("mb-keys-nowhere")) reached.push(nameOf(t));
    };
    document.addEventListener("focusin", onFocus, true);
    const mark = env.calls.length;
    const shift = how !== "closedTab";
    const walked: string[] = [];
    for (let i = 0; i < (shift ? 5 : 9); i++) {
      await press("Tab", { shift });
      await sleep(100);
      walked.push(keyboard());
    }
    // a word with a space and an Enter, as at a prompt; after Tabs, a prompt's y
    await typeKeys(shift ? ["d", "o", " ", "i", "t", "Enter"] : ["y"], 70);
    await sleep(600);
    document.removeEventListener("focusin", onFocus, true);
    out.after = { walked: [...new Set(walked)], reached, keyboard: keyboard(), acts: actsSince(mark), ...opened() };
  } else if (which === "button" || which === "frameButton") {
    // typing in s1's terminal, a press on a button of the landscape's, then the rest of the line
    out.before = await intoTerm("s1");
    if (which === "frameButton") {
      await press("e", { meta: true });
      await sleep(500);
      out.inFocus = { focus: !!q(".ls-focus"), keyboard: keyboard() };
    }
    const mark = env.calls.length;
    const sel0 = selected();
    await typeKeys(["o", "k", " "], 60);
    const s1 = (sel: string) => q(`.ls-world .ls-node[data-front="s1"] ${sel}, .ls-focus ${sel}`);
    // in focus, the frame's Stop … typing ×: a button that leaves focus (its ← or ⋯) is a move of its own
    if (params.get("btn") === "head") {
      // s1's own header, off its buttons: the workspace being typed in
      const at = bareHead("s1");
      if (!at) throw new Error("no bare part of s1's header in the window");
      out.button = "s1's header";
      await act([{ mouse: { ...at, clickCount: 1 } }]);
    } else {
      const btn =
        which === "frameButton"
          ? q(".ls-focus button.typist-x")
          : params.get("btn") === "chip"
            ? qs<HTMLElement>('.ls-world .ls-node[data-front="s1"] button').find((b) => /\bfiles?\b/.test(b.textContent ?? ""))
            : params.get("btn") === "typist"
              ? s1("button.typist-x")
              : q(".ls-hud-btn.pct");
      if (!btn) throw new Error(`no button to press (${params.get("btn") ?? which})`);
      out.button = btn.getAttribute("aria-label") ?? btn.textContent?.trim().slice(0, 30) ?? "";
      await clickOn(btn);
    }
    await sleep(250);
    out.pressed = { keyboard: keyboard(), inS1: !!document.activeElement?.closest('.ls-node[data-front="s1"], .ls-focus') };
    // Esc in focus is Claude's (interrupt); n, Enter and y as at a prompt
    await typeKeys(which === "frameButton" ? ["Escape", "n", "Enter", "y"] : ["n", "Enter", "y"], 150);
    await sleep(500);
    out.after = { keyboard: keyboard(), others: writesSince(mark).filter((id) => id !== "s1"), s1Got: dataTo("s1", mark), changes: changesSince(mark), moved: selected() !== sel0, ...opened() };
  } else if (which === "lag") {
    // main slow to answer a change to the landscape (a stack's front tab brought forward)
    const w = window as unknown as { mb: Record<string, unknown> };
    const real = w.mb;
    w.mb = new Proxy(real, {
      get: (t, n) => (n === "landscapeUpdate" ? async (...a: unknown[]) => (await sleep(1500), (t.landscapeUpdate as (...x: unknown[]) => unknown)(...a)) : t[n as string]),
    });
    if (params.get("how") === "side") {
      // a double-click on s3's row in the side bar (its stack opened first): focus on it, once it's in front
      const head = qs(".lt-row.lt-stack").find((r) => r.dataset.sid === "s2" || /api/i.test(r.textContent ?? ""));
      if (!q('.lt-row[data-sid="s3"]') && head) await clickOn(head.querySelector("[class*=caret], button") ?? head);
      await sleep(300);
      const row = q('.lt-row[data-sid="s3"]');
      if (!row) throw new Error("no side bar row for s3");
      const at = middle(row);
      await act([{ mouse: { ...at, clickCount: 1 } }, { mouse: { ...at, clickCount: 2 } }]);
    } else {
      document.querySelector<HTMLElement>(".ny-btn")?.click();
      await sleep(400);
      const go = q('.ny-tray .ny-item[data-item="s:s3"] button[data-action="go"]');
      if (!go) throw new Error("no Go there for s3");
      await clickOn(go);
    }
    await sleep(150);
    const how = params.get("how");
    if (how === "dialog" || how === "dialogGone" || how === "idle") {
      // nothing typed while it waits; a join prompt comes up on its own meanwhile (dialog), or nothing does (idle)
      const mark = env.calls.length;
      let waited = 0;
      if (how !== "idle") {
        const team = window as unknown as { mb: { teamStatus: () => Promise<{ rooms: { requests?: Record<string, unknown>[] }[] }> }; __mbEmit: (ev: string, ...a: unknown[]) => void };
        const st = await team.mb.teamStatus();
        const room = st.rooms.find((r) => r.requests?.length);
        if (!room?.requests) throw new Error("no join request to copy");
        const lee = room.requests[0];
        room.requests = [lee, { ...lee, id: "5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b", name: "Max", at: Number(lee.at) + 1000 }];
        team.__mbEmit("onTeamChanged", st);
        await sleep(300);
        out.promptUp = { prompt: !!q(".join-ask"), keyboard: keyboard() };
        if (how === "dialogGone") {
          // and Max's request answered elsewhere, still while s3 waits
          const now = await team.mb.teamStatus();
          const same = now.rooms.find((r) => r.requests?.some((x) => x.id === lee.id));
          if (!same) throw new Error("the join request went from the status");
          same.requests = [lee];
          team.__mbEmit("onTeamChanged", now);
          await sleep(300);
          out.promptGone = { prompt: !!q(".join-ask"), keyboard: keyboard() };
          waited = 300;
        }
      }
      await sleep(1900 - waited);
      out.afterLag = { keyboard: keyboard(), front: q('.ls-world .ls-node[data-ws="ws:5101/api"]')?.dataset.front ?? null, focus: !!q(".ls-focus"), prompt: !!q(".join-ask") };
      if (how === "dialog") {
        // Enter (meant for the prompt) and y
        await typeKeys(["Enter", "y"], 200);
        await sleep(400);
        out.after = { writes: writesSince(mark), keyboard: keyboard() };
      } else {
        // idle: Go there's own, the landscape armed once s3 is in front, so ? opens the sheet; after a prompt that came
        // and went meanwhile, the late move is dropped: ? and n do nothing
        await press("?", { shift: true });
        await sleep(300);
        const sheet = !!q(".ls-keys");
        if (how === "dialogGone") {
          await press("n");
          await sleep(300);
        }
        out.after = { sheet, writes: writesSince(mark) };
      }
      w.mb = real;
      return;
    }
    out.before = await intoTerm("s1");
    const mark = env.calls.length;
    const words = params.get("how") === "side" ? [..."please run the tests"] : ["a", "b"];
    await typeKeys(words, 110);
    await sleep(1900);
    out.afterLag = { keyboard: keyboard(), inS1: !!document.activeElement?.closest('.ls-node[data-front="s1"]'), focus: !!q(".ls-focus") };
    await typeKeys(["n", "Enter", "y"], 120);
    await sleep(500);
    out.after = { others: writesSince(mark).filter((id) => id !== "s1"), s1Got: dataTo("s1", mark), focus: !!q(".ls-focus") };
    w.mb = real;
  } else if (which === "join") {
    const how = params.get("how") ?? "withdrawn";
    document.querySelector<HTMLElement>(".ny-btn")?.click();
    await sleep(400);
    const go = qs(".ny-tray .ny-item").find((i) => !(i.dataset.item ?? "").startsWith("s:"))?.querySelector<HTMLElement>('button[data-action="go"]');
    if (!go) throw new Error("no Go there on a join request");
    await clickOn(go);
    await sleep(700);
    out.prompt = !!q(".join-ask");
    if (how === "withdrawn") {
      // the user reads it and Tabs toward Accept; the request is answered elsewhere and goes
      await press("Tab");
      await sleep(100);
      const w = window as unknown as { mb: { teamStatus: () => Promise<{ rooms: { requests?: unknown[] }[] }> }; __mbEmit: (ev: string, ...a: unknown[]) => void };
      const st = await w.mb.teamStatus();
      for (const r of st.rooms) r.requests = [];
      w.__mbEmit("onTeamChanged", st);
    } else if (how === "enter") {
      for (let i = 0; i < 6 && document.activeElement?.textContent?.trim() !== "Accept"; i++) {
        await press("Tab");
        await sleep(80);
      }
      out.onAccept = document.activeElement?.textContent?.trim() === "Accept";
      await press("Enter");
    } else await press("Escape");
    await sleep(700);
    out.closed = { prompt: !!q(".join-ask"), keyboard: keyboard() };
    const mark = env.calls.length;
    const sel0 = selected();
    await press("?", { shift: true });
    await sleep(300);
    const sheet = !!q(".ls-keys");
    if (sheet) {
      await press("Escape");
      await sleep(300);
    }
    await typeKeys(["n", "Enter", "y"], 150);
    await sleep(500);
    out.after = { sheet, moved: selected() !== sel0, writes: writesSince(mark), focus: !!q(".ls-focus") };
  } else if (which === "tabWalk") {
    const how = params.get("how") ?? "fresh";
    if (how === "palette") {
      await press("k", { meta: true });
      await sleep(300);
      await typeKeys([..."Dashboard"], 30);
      await sleep(200);
      await press("Enter");
      await sleep(600);
    } else if (how === "reopen") {
      // keyboard only: the side bar's Reopen on a closed session, Tabbed to (given the keyboard here) and pressed
      const reopen = qs<HTMLButtonElement>('.lt-closed-act[data-act="reopen"]').find((b) => b.getClientRects().length && !b.disabled);
      if (!reopen) throw new Error("no Reopen in the side bar");
      out.reopen = reopen.getAttribute("aria-label") ?? "";
      reopen.focus();
      await press("Enter");
      await sleep(600);
    }
    out.start = { keyboard: keyboard(), tab: q(".topbar .tab.on")?.dataset.tab ?? q(".tab.on")?.textContent?.trim() ?? null };
    const walked: string[] = [];
    for (let i = 0; i < 4; i++) {
      await press("Tab");
      await sleep(120);
      walked.push(keyboard());
    }
    out.walked = walked;
  } else if (which === "escape") {
    // the keyboard on the holder (s1's terminal gone as it's typed in); a burst is swallowed, Tab with it
    out.before = await intoTerm("s1");
    await press("a");
    env.setSession("s1", null);
    await sleep(300);
    await typeKeys(["x", "Tab", "y"], 100);
    out.held = keyboard();
    // a pause, then Tab or Shift+Tab: the top bar's first or its last control, never where s1 was
    await sleep(1300);
    const shift = params.get("how") === "shift";
    const bar = qs(".topbar button, .topbar a[href], .topbar input, .topbar select, .topbar [tabindex]:not([tabindex='-1'])").filter((el) => el.getClientRects().length && !(el as HTMLButtonElement).disabled);
    const want = shift ? bar[bar.length - 1] : bar[0];
    await press("Tab", { shift });
    await sleep(150);
    out.left = { keyboard: keyboard(), isStart: !!want && document.activeElement === want };
  } else if (which === "preset") {
    // a jump that waits on main: the preset's session (s2 here) shown and given the keyboard once main answers
    const w = window as unknown as { mb: Record<string, unknown> };
    const real = w.mb;
    w.mb = new Proxy(real, {
      get: (t, n) =>
        n === "presetStart"
          ? async () => (await sleep(1500), ((await (t.listSessions as () => Promise<{ id: string }[]>)()) ?? []).find((s) => s.id === "s2"))
          : t[n as string],
    });
    await press("k", { meta: true });
    await sleep(300);
    await typeKeys([..."Start preset"], 30);
    await sleep(150);
    await press("Enter");
    await sleep(300);
    const typedIn = params.get("how") !== "idle";
    if (typedIn) out.before = await intoTerm("s1");
    const mark = env.calls.length;
    if (typedIn) await typeKeys(["a", "b"], 110);
    await sleep(1900);
    out.afterLag = { keyboard: keyboard(), in: document.activeElement?.closest<HTMLElement>(".ls-node")?.dataset.front ?? null };
    if (typedIn) {
      await typeKeys(["n", "Enter", "y"], 120);
      await sleep(400);
      out.after = { others: writesSince(mark).filter((id) => id !== "s1"), s1Got: dataTo("s1", mark) };
    }
    w.mb = real;
  } else if (which === "headOther") {
    // typing in s1, then a press on another workspace's header, off its buttons: that one is selected, and the
    // landscape armed
    out.before = await intoTerm("s1");
    const other = qs(".ls-world .ls-node[data-front]").map((n) => n.dataset.front!).find((f) => f !== "s1" && bareHead(f));
    const at = other ? bareHead(other) : null;
    if (!other || !at) throw new Error("no other workspace's header in the window");
    await act([{ mouse: { ...at, clickCount: 1 } }]);
    await sleep(250);
    out.pressed = { keyboard: keyboard(), selected: selected() === other };
    await press("?", { shift: true });
    await sleep(300);
    out.armed = { sheet: !!q(".ls-keys") };
  } else if (which === "selfClose") {
    // armed by a press on the bare landscape; a join prompt comes up on its own, and goes on its own
    const at = barePoint();
    await act([{ mouse: { ...at, clickCount: 1 } }]);
    await sleep(300);
    out.armedAt = keyboard();
    const team = window as unknown as { mb: { teamStatus: () => Promise<{ rooms: { requests?: Record<string, unknown>[] }[] }> }; __mbEmit: (ev: string, ...a: unknown[]) => void };
    const st = await team.mb.teamStatus();
    const room = st.rooms.find((r) => r.requests?.length);
    if (!room?.requests) throw new Error("no join request to copy");
    const lee = room.requests[0];
    room.requests = [lee, { ...lee, id: "5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b", name: "Max", at: Number(lee.at) + 1000 }];
    team.__mbEmit("onTeamChanged", st);
    await sleep(700);
    out.up = { prompt: !!q(".join-ask"), keyboard: keyboard() };
    // Max's request answered elsewhere: the status as it is now, without his
    const now = await team.mb.teamStatus();
    const same = now.rooms.find((r) => r.requests?.some((x) => x.id === lee.id));
    if (!same) throw new Error("the join request went from the status");
    same.requests = [lee];
    team.__mbEmit("onTeamChanged", now);
    await sleep(700);
    out.gone = { prompt: !!q(".join-ask"), keyboard: keyboard() };
    const mark = env.calls.length;
    const sel0 = selected();
    await press("?", { shift: true });
    await sleep(300);
    const sheet = !!q(".ls-keys");
    await typeKeys(["n", "Enter", "y"], 150);
    await sleep(400);
    out.after = { sheet, moved: selected() !== sel0, writes: writesSince(mark), focus: !!q(".ls-focus") };
  } else if (which === "frameGone" || which === "jumpCards") {
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => (warned.push(a.map(String).join(" ")), warn.apply(console, a));
    if (which === "frameGone") {
      // a teammate's workspace focused from the keyboard: its header pressed, then Enter; its frame has the keyboard
      const id = "r~0f1e2d3c4b5a~n1";
      const head = q(`.ls-world .ls-node[data-ws="${id}"] .ls-head`);
      if (!head) throw new Error(`no ${id} on the landscape`);
      const r = head.getBoundingClientRect();
      let at: { x: number; y: number } | null = null;
      for (let x = r.left + 4; !at && x < r.right - 4; x += 6) {
        const el = document.elementFromPoint(x, r.top + r.height / 2);
        if (el && head.contains(el) && !el.closest("button, [role=button], a[href]")) at = { x, y: r.top + r.height / 2 };
      }
      if (!at) throw new Error(`no bare part of ${id}'s header`);
      await act([{ mouse: { ...at, clickCount: 1 } }]);
      await sleep(200);
      await press("Enter");
      await sleep(400);
      out.inFocus = { focus: !!q(".ls-focus"), keyboard: document.activeElement === q(".ls-focus") ? "frame" : keyboard() };
      // the teammate's session goes, and its frame with it
      const live = window as unknown as { mb: { teamLive: () => Promise<{ remote: { id: string }[] }> }; __mbEmit: (ev: string, ...a: unknown[]) => void };
      const l = await live.mb.teamLive();
      l.remote = l.remote.filter((s) => s.id !== id);
      live.__mbEmit("onTeamLive", l);
      await sleep(1500);
    } else {
      // ⌘K to a session whose terminal takes no keys this far out
      await press("k", { meta: true });
      await sleep(300);
      await typeKeys([..."test runner"], 30);
      await sleep(150);
      await press("Enter");
      await sleep(400);
    }
    out.gone = { focus: !!q(".ls-focus"), keyboard: keyboard(), warned: warned.filter((w) => /keyboard/.test(w)) };
    console.warn = warn;
    const reached: string[] = [];
    const onFocus = (e: FocusEvent) => {
      const t = e.target as Element | null;
      if (t instanceof Element && !t.classList.contains("mb-keys-nowhere")) reached.push(keyboard());
    };
    document.addEventListener("focusin", onFocus, true);
    const mark = env.calls.length;
    for (let i = 0; i < 5; i++) {
      await press("Tab", { shift: true });
      await sleep(100);
    }
    await press("y");
    await sleep(400);
    document.removeEventListener("focusin", onFocus, true);
    out.after = { reached: [...new Set(reached)], writes: writesSince(mark), acts: actsSince(mark), ...opened() };
  } else if (which === "menuEsc") {
    // the menu gives the keyboard back a frame after it closes: armed, since the user's Esc closed it
    const at = barePoint();
    await act([{ mouse: { ...at, clickCount: 1 } }]);
    await sleep(250);
    await act([{ mouse: { ...at, clickCount: 1, button: "right" } }]);
    await sleep(300);
    out.menu = { open: !!q(".mb-ctx:not(.mb-ghost)"), keyboard: keyboard() };
    await press("Escape");
    await sleep(300);
    out.left = { menu: !!q(".mb-ctx:not(.mb-ghost)"), keyboard: keyboard() };
    await press("?", { shift: true });
    await sleep(300);
    out.armed = { sheet: !!q(".ls-keys") };
  } else if (which === "jumpOver") {
    const how = params.get("how") ?? "dialog";
    if (how === "dialog") {
      const team = window as unknown as { mb: { teamStatus: () => Promise<{ rooms: { requests?: Record<string, unknown>[] }[] }> }; __mbEmit: (ev: string, ...a: unknown[]) => void };
      const st = await team.mb.teamStatus();
      const room = st.rooms.find((r) => r.requests?.length);
      if (!room?.requests) throw new Error("no join request to copy");
      const lee = room.requests[0];
      room.requests = [lee, { ...lee, id: "5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b", name: "Max", at: Number(lee.at) + 1000 }];
      team.__mbEmit("onTeamChanged", st);
      await sleep(600);
      out.promptUp = { prompt: !!q(".join-ask"), keyboard: keyboard() };
    }
    const mark = env.calls.length;
    if (how === "palette") {
      await press("k", { meta: true });
      await sleep(300);
      await typeKeys([..."last org per user"], 30);
      await sleep(150);
      await press("Enter");
    } else (window as unknown as { __mbEmit: (ev: string, ...a: unknown[]) => void }).__mbEmit("onUiCommand", "focus-session", "s2");
    await sleep(600);
    out.jumped = { keyboard: keyboard(), in: document.activeElement?.closest<HTMLElement>(".ls-node")?.dataset.front ?? null, selected: selected(), prompt: !!q(".join-ask") };
    await press("y");
    await sleep(300);
    out.after = { writes: env.calls.slice(mark).filter((c) => c.fn === "sessionWrite").map((c) => `${String(c.args[0])}:${String(c.args[1])}`) };
  } else if (which === "escMask") {
    // the app's own Esc cut off: Esc reaches nothing of it, so the sheet stays open, the page in front all along
    let blurs = 0;
    const onBlur = () => void blurs++;
    window.addEventListener("blur", onBlur);
    await giveLandscape();
    await press("?", { shift: true });
    await sleep(300);
    out.open = !!q(".ls-keys");
    const cut = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", cut, true);
    await press("Escape");
    await sleep(400);
    window.removeEventListener("keydown", cut, true);
    window.removeEventListener("blur", onBlur);
    out.afterEsc = { open: !!q(".ls-keys"), visibility: document.visibilityState, blurs };
    await press("Escape");
    await sleep(300);
    out.closed = !q(".ls-keys");
  } else if (which === "pressNothing") {
    // a press on nothing puts the keyboard on the page by the user's own act: Tab goes on from the press
    const s = box(q(".topbar > .spacer"));
    if (!s || s.w < 4) throw new Error("no bare middle in the top bar");
    await act([{ mouse: { x: s.x + s.w / 2, y: s.y + s.h / 2, clickCount: 1 } }]);
    await sleep(200);
    out.pressed = keyboard();
    await press("Tab");
    await sleep(150);
    out.tabbed = keyboard();
  } else if (which === "mount") {
    const how = params.get("how") ?? "jump";
    const tabBtn = (id: string) => q(`.topbar .tab[data-tab="${id}"]`);
    const typeRow = async (text: string) => {
      await press("k", { meta: true });
      await sleep(400);
      await typeKeys([...text], 40);
      await press("Enter");
      await sleep(900);
    };
    if (how === "jump") {
      // the window opened on Dashboard (&tab=dashboard): ⌘K to a session on the landscape, zoomed out past its terminal
      out.startedOn = { landscape: !!q(".ls-viewport"), tab: q(".topbar .tab.on")?.dataset.tab ?? null };
      await typeRow("test runner");
    } else if (how === "notified") {
      // the window opened on Dashboard and nothing pressed yet: a notification clicked jumps to a session
      out.startedOn = { landscape: !!q(".ls-viewport"), tab: q(".topbar .tab.on")?.dataset.tab ?? null };
      (window as unknown as { __mbEmit: (ev: string, ...a: unknown[]) => void }).__mbEmit("onUiCommand", "focus-session", "s4");
      await sleep(900);
    } else if (how === "cycle") {
      // the Dashboard tab pressed (its button keeps the keyboard), then ⌥⇥ to a waiting session
      await clickOn(tabBtn("dashboard")!);
      await sleep(800);
      out.startedOn = { landscape: !!q(".ls-viewport"), keyboard: keyboard() };
      await press("Tab", { alt: true });
      await sleep(900);
    } else if (how === "paletteRow") {
      // the Dashboard tab pressed, then ⌘K's Landscape row: the palette gives the keyboard back to Dashboard's button
      await clickOn(tabBtn("dashboard")!);
      await sleep(800);
      out.startedOn = { landscape: !!q(".ls-viewport"), keyboard: keyboard() };
      await typeRow("Landscape");
    } else {
      // the Landscape tab pressed, from Dashboard: the user chose it
      await clickOn(tabBtn("dashboard")!);
      await sleep(800);
      out.startedOn = { landscape: !!q(".ls-viewport"), keyboard: keyboard() };
      await clickOn(tabBtn("sessions")!);
      await sleep(900);
    }
    out.mounted = { landscape: !!q(".ls-viewport"), keyboard: keyboard(), selected: selected() };
    const sel0 = selected();
    const mark = env.calls.length;
    // ? asks for the sheet; then N, Enter and a prompt's y
    await press("?", { shift: true });
    await sleep(300);
    const sheet = !!q(".ls-keys");
    if (sheet) {
      await press("Escape");
      await sleep(300);
    }
    await typeKeys(["n", "Enter", "y"], 120);
    await sleep(700);
    out.after = { sheet, moved: selected() !== sel0, acts: actsSince(mark), focus: !!q(".ls-focus"), note: noteText() };
  } else if (which === "hud") {
    // the zoom HUD's Zoom out pressed: the landscape is armed by the press, the button doesn't keep the keyboard
    const zoomOut = q('.ls-hud-btn[aria-label="Zoom out"]');
    if (!zoomOut) throw new Error("no Zoom out on the HUD");
    const z0 = zoomNow();
    await clickOn(zoomOut);
    await sleep(800);
    out.pressed = { keyboard: keyboard(), zoomedOut: zoomNow() < z0 };
    const z1 = zoomNow();
    await restOn("s2");
    out.peek = peekNow();
    await press(" ");
    await sleep(400);
    out.space = { peek: peekNow(), zoomSame: zoomNow() === z1, keyboard: keyboard() };
    // and the buttons are still the keyboard's: Tab from the armed landscape reaches one of its own
    await press("Escape");
    await sleep(300);
    await press("Tab");
    await sleep(200);
    const a = document.activeElement;
    out.tab = { button: !!a?.matches("button, [role=button]"), inLandscape: !!a && vp().contains(a) && a !== vp() };
  } else if (which === "hint") {
    const stop = watchNotes();
    // nothing selected, with the landscape armed as the window opened on it
    await press("Escape");
    await sleep(200);
    out.start = { keyboard: keyboard(), selected: selected() };
    // given the keyboard by code (a hand-back): typed keys say why they do nothing, once
    vp().blur();
    vp().focus({ preventScroll: true });
    await sleep(60);
    // one burst, sent together: a Tab after a pause would leave the landscape, as it should
    await act(["n", "t", "Tab", "x"].map((key) => ({ key })));
    await sleep(200);
    out.disarmed = { notes: [...notesSaid], keyboard: keyboard(), selected: selected() };
    // ⌘E with nothing selected arms it: ? opens the sheet
    await press("e", { meta: true });
    await sleep(200);
    await press("?", { shift: true });
    await sleep(300);
    out.cmdE = { sheet: !!q(".ls-keys") };
    await press("Escape");
    await sleep(300);
    // s1's terminal typed in and closed elsewhere: the keyboard nowhere, typed keys say why once more, and only once
    await intoTerm("s1");
    await press("a");
    env.setSession("s1", null);
    await sleep(300);
    await typeKeys(["x", "y", "z"], 120);
    await sleep(200);
    out.nowhere = { notes: [...notesSaid], keyboard: keyboard() };
    // and again for the next time, though nothing was armed between: s2's terminal typed in and closed (the selection
    // going with it)
    out.inS2 = await intoTerm("s2");
    out.s2Selected = selected();
    await press("b");
    env.setSession("s2", null);
    await sleep(300);
    await typeKeys(["g", "h"], 120);
    await sleep(200);
    out.again = { notes: [...notesSaid], keyboard: keyboard(), selected: selected(), front: q('.ls-world .ls-node[data-ws="ws:5101/api"]')?.dataset.front ?? null };
    stop();
  }
}

export function runFirstRunAudit(env: FirstRunEnv, part: string): void {
  const write = (out: unknown) => {
    const el = document.createElement("script");
    el.type = "application/json";
    el.id = "mb-landscape-first-run-audit";
    el.textContent = JSON.stringify(out);
    document.body.appendChild(el);
  };
  // =b, and =a&case=mount|tabWalk (which may open on another tab) or the grid's escape, start once the top bar is there;
  // the rest, the landscape
  const fromBar = part === "b" || (part === "a" && (["mount", "tabWalk"].includes(params.get("case") ?? "") || params.get("how") === "grid"));
  env.waitFor(fromBar ? ".topbar" : ".ls-viewport", async () => {
    const out: Record<string, unknown> = {};
    // what it has found so far, for the driver to say where it was if it never finishes
    (window as unknown as { __mbAuditOut?: unknown }).__mbAuditOut = out;
    try {
      if (part === "k") await keysPart(env, out);
      else if (part === "t") await tourPart(env, out);
      else if (part === "u") await tourAgainstPart(env, out);
      else if (part === "c") await cameraPart(env, out);
      else if (part === "a") await armingPart(env, out);
      else if (part === "e") await emptyPart(env, out);
      else await barPart(env, out);
    } catch (err) {
      out.error = String((err as Error)?.stack ?? err);
    }
    out.rows = SHORTCUTS.flatMap((s) => s.rows.map((r) => r.id));
    write(out);
  }, 300);
}
