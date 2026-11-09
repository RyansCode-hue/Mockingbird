/**
 * ?landscapeFirstRunAudit=k|t|e|b (with ?labs=landscape&motion=off): S8's first run, worked as a person would in the UI
 * preview, into <script id="mb-landscape-first-run-audit"> for test/uiLandscapeFirstRun.test.ts. Keys, the wheel and the
 * mouse go through the test's Chrome driver (scripts/ui-preview.mjs), so they reach whatever really has the keyboard or
 * is under the pointer; a page with no driver reports `driver: false` and proves nothing.
 *
 * =k: every row of the shortcuts sheet driven (`driven`, by the row's id), and `?` refused in a terminal and a text field.
 * =t (with ?lsTour): the tour's steps (`steps`: the ring, the target and the card at each), its keyboard, and how it ends:
 * &do=skip|esc|next|done. Reloads with ?lsPersist to say whether it comes back.
 * =u: the tour against what else is going on, by &case=terminal|dialog|palette|focus|tray.
 * =e (with ?lsOnly=…): what's in the empty landscape's place, right-clicks all over it, its tiles and its links.
 * =b: the top bar's boxes at this window's width, + New's menu and its »; &case=tab for + New on another tab, &case=fold
 * for what folds, &case=sheet for the sheet at this size and beside the tray and the palette.
 */
import type { Landscape as Stored, LandscapePatch } from "../shared/landscape";
import type { SessionInfo } from "../shared/types";
import { SHORTCUTS } from "../renderer/landscapeShortcuts";
import { drive, type Asked } from "./needsYouAudit";

export interface FirstRunEnv {
  sessions: () => SessionInfo[];
  calls: { fn: string; args: unknown[] }[];
  stored: () => Stored;
  /** Change landscape.json as main would, and tell the window. */
  patch: (p: LandscapePatch) => void;
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
const giveLandscape = async () => {
  vp().focus({ preventScroll: true });
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

/** Every row's proof, by its id: true once its key has done what the row says. */
async function keysPart(env: FirstRunEnv, out: Record<string, unknown>): Promise<void> {
  const driven: Record<string, boolean> = {};
  const why: Record<string, string> = {};
  const row = async (id: string, prove: () => Promise<boolean | string>) => {
    try {
      const r = await prove();
      driven[id] = r === true;
      if (r !== true) why[id] = typeof r === "string" ? r : "it didn't";
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
    await act([{ key: " ", hold: "down" }, { drag: { x0: p.x, y0: p.y, x1: p.x + 60, y1: p.y + 40 } }, { key: " ", hold: "up" }]);
    await sleep(120);
    const b = camera();
    await act([{ wheel: { x: p.x, y: p.y, dx: 30, dy: 30 } }]);
    await sleep(120);
    const c = camera();
    return moved(a, b) && moved(b, c) && a?.zoom === b?.zoom && b?.zoom === c?.zoom ? true : `space-drag ${moved(a, b)}, two fingers ${moved(b, c)}`;
  });
  await row("zoom", async () => {
    await giveLandscape();
    const p = barePoint();
    const a = zoomNow();
    await act([{ wheel: { x: p.x, y: p.y, dy: -120, meta: true } }]);
    await sleep(120);
    const b = zoomNow();
    await act([{ wheel: { x: p.x, y: p.y, dy: -20, ctrl: true } }]);
    await sleep(120);
    const c = zoomNow();
    return b > a && c > b ? true : `${a} ${b} ${c}`;
  });
  await row("zoomKeys", async () => {
    await giveLandscape();
    const a = zoomNow();
    await press("=", { meta: true });
    await sleep(80);
    const b = zoomNow();
    await press("-", { meta: true });
    await sleep(80);
    const c = zoomNow();
    return b > a && c < b ? true : `${a} ${b} ${c}`;
  });
  await row("fit", async () => {
    await giveLandscape();
    await press("1", { meta: true });
    await sleep(120);
    const at100 = zoomNow();
    await press("0", { meta: true });
    await sleep(120);
    const fitted = zoomNow();
    return at100 === 1 && fitted < 1 ? true : `${at100} ${fitted}`;
  });
  await row("goTo", async () => {
    await giveLandscape();
    await press("k", { meta: true });
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
    await press("\\", { meta: true });
    await sleep(150);
    const b = shown();
    await press("\\", { meta: true });
    await sleep(150);
    return a && !b && shown() ? true : `${a} ${b} ${shown()}`;
  });
  await row("focus", async () => {
    await selectFirst();
    await press("Enter");
    await sleep(250);
    const byEnter = !!q(".ls-focus");
    await press("e", { meta: true });
    await sleep(250);
    const left = !q(".ls-focus");
    await giveLandscape();
    await press("e", { meta: true });
    await sleep(250);
    const byE = !!q(".ls-focus");
    out.focusKeyboard = keyboard();
    return byEnter && left && byE ? true : `Enter ${byEnter}, ⌘E out ${left}, ⌘E in ${byE}`;
  });
  await row("back", async () => {
    if (!q(".ls-focus")) return "not in focus";
    await press("Escape", { meta: true });
    await sleep(250);
    const byEsc = !q(".ls-focus");
    await giveLandscape();
    await press("e", { meta: true });
    await sleep(250);
    const again = !!q(".ls-focus");
    await press("e", { meta: true });
    await sleep(250);
    return byEsc && again && !q(".ls-focus") ? true : `⌘Esc ${byEsc}, ⌘E ${again}`;
  });
  await row("needs", async () => {
    await fit();
    await press("n");
    await sleep(350);
    const a = selected();
    await press("n");
    await sleep(350);
    const b = selected();
    await press("N", { shift: true });
    await sleep(350);
    const c = selected();
    return !!a && !!b && a !== b && c === a ? true : `${a} ${b} ${c}`;
  });
  await row("waiting", async () => {
    await fit();
    await press("Tab", { alt: true });
    await sleep(350);
    const s = selected();
    const waits = env.sessions().find((x) => x.id === s)?.status === "waiting";
    return waits ? true : `selected ${s}`;
  });
  await row("peek", async () => {
    await fit();
    const p = middle(card("s4") ?? card("s5")!);
    await act([{ move: { x: p.x, y: p.y } }]);
    await sleep(800);
    const opened = !!q(".ls-peek");
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
  const windowKey = (tool: string, key: string, o: { shift?: boolean; meta?: boolean; ctrl?: boolean }) => async () => {
    await selectFirst();
    const a = count(tool);
    await press(key, o);
    await sleep(300);
    const b = count(tool);
    await giveLandscape();
    await press(key, o);
    await sleep(300);
    return b === a + 1 && count(tool) === a ? true : `${a} → ${b} → ${count(tool)}`;
  };
  await row("files", async () => {
    const byB = await windowKey("files", "b", { meta: true })();
    const byE = await windowKey("files", "e", { meta: true, shift: true })();
    return byB === true && byE === true ? true : `⌘B ${byB}, ⇧⌘E ${byE}`;
  });
  await row("changes", windowKey("changes", "g", { ctrl: true, shift: true }));
  await row("search", windowKey("search", "f", { meta: true, shift: true }));
  await row("run", windowKey("run", "d", { meta: true, shift: true }));
  await row("file", async () => {
    await selectFirst();
    await press("p", { meta: true });
    await sleep(200);
    const open = !!q(".palette.qo");
    await afterEsc();
    return open && !q(".palette.qo") ? true : `open ${open}`;
  });
  await row("panel", async () => {
    await giveLandscape();
    const a = !!q(".bp");
    await press("j", { meta: true });
    await sleep(200);
    const b = !!q(".bp");
    await press("j", { meta: true });
    await sleep(200);
    return a !== b && !!q(".bp") === a ? true : `${a} ${b}`;
  });
  await row("newHere", async () => {
    await fit();
    const p = barePoint();
    await rightAt(p.x, p.y);
    await sleep(200);
    const rows = menuRows();
    out.rightClickRows = rows;
    await afterEsc();
    return rows.includes("Claude…") && rows.includes("Terminal…") ? true : rows.join(", ");
  });
  await row("newDialog", async () => {
    await giveLandscape();
    await press("n", { meta: true });
    await sleep(250);
    const open = q(".modal.ns h3")?.textContent ?? q(".modal h3")?.textContent ?? null;
    await afterEsc();
    return open === "New session" ? true : `dialog ${open}`;
  });
  await row("several", async () => {
    await fit();
    await press("Escape");
    await sleep(120);
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
    await act([{ drag: { x0: p.x, y0: p.y, x1: r.right - 20, y1: r.bottom - 20 } }]);
    await sleep(200);
    const marquee = picked();
    return shift === 2 && marquee > 0 ? true : `⇧-click ${shift}, marquee ${marquee}`;
  });
  await row("makeArea", async () => {
    if (!picked()) return "nothing picked";
    await giveLandscape();
    await press("m");
    await sleep(250);
    const asks = !!q(".modal input");
    await afterEsc();
    return asks ? true : "M asked for no name";
  });
  await row("clear", async () => {
    await giveLandscape();
    const was = picked();
    await press("Escape");
    await sleep(150);
    return was > 0 && picked() === 0 ? true : `${was} → ${picked()}`;
  });
  await row("tidy", async () => {
    await selectFirst();
    const before = JSON.stringify(env.stored().workspaces);
    await press("t");
    await sleep(350);
    const noted = !!q(".ls-note-act");
    const after = JSON.stringify(env.stored().workspaces);
    out.tidied = { noted, moved: before !== after };
    return noted ? true : "T said nothing";
  });
  await row("undoTidy", async () => {
    if (!q(".ls-note-act")) return "no Tidy to undo";
    await giveLandscape();
    await press("z", { meta: true });
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
    const mark = env.calls.length;
    await giveLandscape();
    await press("g", { meta: true });
    const moved = () => env.calls.slice(mark).filter((c) => c.fn === "setGroup").map((c) => String(c.args[0]));
    const stacks = () => qs(".ls-world .ls-node.stack").length;
    // its groups change one at a time
    for (let i = 0; i < 30 && stacks() === stacksBefore; i++) await sleep(100);
    return stacks() === stacksBefore + 1 && moved().join() === "s4,s8" ? true : `picked ${was}, moved ${moved().join() || "none"}, stacks ${stacksBefore} → ${stacks()}, keyboard ${keyboard()}, said ${q(".ls-note")?.textContent ?? "nothing"}`;
  });

  // keys with the keyboard nowhere are the landscape's: a palette clicked away leaves it on the body
  await press("k", { meta: true });
  await sleep(200);
  q(".scrim")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await sleep(150);
  (document.activeElement as HTMLElement | null)?.blur();
  out.nowhere = { keyboard: keyboard() };
  await press("?", { shift: true });
  await sleep(150);
  (out.nowhere as Record<string, unknown>).sheet = !!q(".ls-keys");
  await afterEsc();

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

/** The tour's card, ring and what's under them at this step. */
const tourNow = () => {
  const ring = q(".ls-tour-ring");
  const c = q(".ls-tour-card");
  const target = c?.dataset.step;
  const rb = ring && !ring.hidden ? box(ring) : null;
  const cb = box(c);
  const t =
    target === "zoom" ? box(q(".ls-hud")) : target === "needs" ? box(q(".ny-btn")) : target === "tools" ? box(q(".activitybar .ab-btn")) : null;
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
    const writes = () => env.calls.filter((c) => c.fn === "sessionWrite").length;
    const was = writes();
    await act([{ key: "a" }, { key: "b" }, { key: " " }, { key: "Tab" }, { key: "Tab" }, { key: "c" }]);
    await sleep(150);
    out.typedIntoTerminal = writes() - was;
    out.stepAfterTyping = q(".ls-tour-card")?.dataset.step ?? null;
    // pressing Space on Next moved a step: go on to the end from wherever it is
    q<HTMLElement>('.ls-tour-card [data-act="next"]')?.focus();
    for (let i = 0; i < 4 && q(".ls-tour-card"); i++) await tourNext();
    await sleep(900);
    out.after = { tour: !!q(".ls-tour-card"), keyboard: keyboard(), tourDone: env.stored().tourDone === true, active: document.activeElement === t };
    const was2 = writes();
    await press("x");
    await sleep(150);
    out.typedAfter = writes() - was2;
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
  out.tourDone = env.stored().tourDone === true;
  out.tour = !!q(".ls-tour-card");
  out.banners = qs(".ls-banner .t").map((b) => b.textContent);
  out.keyboardAtStart = keyboard();
  // what's drawn, when something is, and whether it's in view
  const drawn = q(".ls-world .ls-ghost, .ls-world .ls-window, .ls-world .ls-area");
  out.drawn = drawn ? { cls: drawn.className.split(" ")[0], inView: overlap(box(drawn), box(vp())) } : null;

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

  // each tile runs the create menu's row: the New session dialog as that row opens it
  const dialogNow = () => {
    const d = q(".modal.ns");
    return d ? { launch: d.querySelector(".ns-launch button.on")?.textContent ?? null, mode: d.querySelector(".ns-mode button.on")?.textContent ?? null, ticket: !!qs(".modal.ns *").find((e) => /ticket/i.test(e.className?.toString() ?? "") && e.tagName !== "BUTTON") } : null;
  };
  const tiles: Record<string, unknown> = {};
  for (const t of qs(".ls-empty-tile")) {
    const key = t.dataset.tile!;
    await clickOn(t);
    await sleep(300);
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
}

export function runFirstRunAudit(env: FirstRunEnv, part: string): void {
  const write = (out: unknown) => {
    const el = document.createElement("script");
    el.type = "application/json";
    el.id = "mb-landscape-first-run-audit";
    el.textContent = JSON.stringify(out);
    document.body.appendChild(el);
  };
  env.waitFor(part === "b" ? ".topbar" : part === "e" ? ".ls-viewport" : ".ls-viewport", async () => {
    const out: Record<string, unknown> = {};
    try {
      if (part === "k") await keysPart(env, out);
      else if (part === "t") await tourPart(env, out);
      else if (part === "u") await tourAgainstPart(env, out);
      else if (part === "e") await emptyPart(env, out);
      else await barPart(env, out);
    } catch (err) {
      out.error = String((err as Error)?.stack ?? err);
    }
    out.rows = SHORTCUTS.flatMap((s) => s.rows.map((r) => r.id));
    write(out);
  }, 300);
}
