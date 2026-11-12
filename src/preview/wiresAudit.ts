/**
 * Wires in the UI preview (W4a, docs/landscape-wires.md). `?lsWires` lays out the wires board (Inbox.dc.html) as its
 * own area, 5120 — Shape donor export, Builder, Reviewer, its Dev server, Tester, a stack and a ghost — with a wire in
 * each state between them, and one out to 5102's Pathways (its pill with `?lsCollapsed=5102`). With
 * `?landscapeMany=<n>`, `?lsWires=<k>` puts k wires between those workspaces instead, for `?landscapePerf`.
 *
 * `?landscapeWiresAudit=<part>` (with `?lsWires`, `?motion=off`) works them as a person would and reports into
 * <script id="mb-landscape-wires-audit"> for test/uiLandscapeWires.test.ts:
 * - =near (with ?lsCamera on 5120 at 100%): each wire's look, label and stacked tab's name, its ends against the
 *   workspaces' boxes on screen, its stroke and label at screen size, and where the layer sits among the world's;
 * - =far (at 13%): the same at cards, with no labels or dots, ends at the cards as they're drawn;
 * - =drag: Builder dragged by its header, its wires following it while it moves and once it's let go, a pinch after,
 *   and every call to the main process meanwhile (no sessionResize);
 * - =area (zoomed out to cards): 5120 dragged by its name, the wires on its workspaces and still under the others;
 * - =pill (with ?lsCollapsed=5102): the wire to Pathways ending at 5102's pill;
 * - =tidy: 5120 tidied from its toolbar (W10), laid out along its wires, and what the note says.
 *
 * W4b's parts press the mouse and keys for real where the test's driver is there (needsYouAudit.ts' `drive`):
 * - =make (at the ?lsCamera's zoom): a wire dragged from Shape export's handle and dropped on Tester, the picker's ↵
 *   making a handoff; Esc while dragging; Esc in the picker; a refused drop (Dev server onto Builder at 100%, onto Nick's
 *   workspace when it is on screen), and drops onto the docs stack (its body, and at 100% its Docs tab);
 * - =keys (at 100%): Builder's terminal typed in, then keys typed while a wire is dragged and straight after its drop,
 *   a click on a row that came up under the pointer, and Enter straight after a row of Connect…'s menu picked with it;
 * - =menus (at 100%): Connect…'s rows, a wire's right-click, its settings changed, and its Remove and Undo;
 * - =pick and =settings: the picker, and Reviewer → Tester's settings, left open for a screenshot (synthetic events).
 */
import type { Area, Landscape, Rect } from "../shared/landscape";
import type { SessionInfo } from "../shared/types";
import { newWire, type Wire, type WireBook } from "../shared/wires";
import { drive } from "./needsYouAudit";

export const WIRE_AREA = "5120";
const DIR = "5120-donor-export";
const W = (id: string) => `wb-${id}`;

/** The board's workspaces: the running ones, and Spike: streaming, closed with its place kept (a ghost). */
export function wireBoardSessions(make: (id: string, over: Partial<SessionInfo>) => SessionInfo, wt: (branch: string) => string): { running: SessionInfo[]; closed: SessionInfo[] } {
  const at = { taskGroup: WIRE_AREA, branch: DIR, cwd: wt(DIR), status: "idle" as const };
  return {
    running: [
      make(W("shape"), { ...at, title: "Shape donor export" }),
      make(W("builder"), { ...at, title: "Builder", agent: "codex", agentVersion: "0.131.0", status: "working" }),
      make(W("reviewer"), { ...at, title: "Reviewer" }),
      make(W("dev"), { ...at, title: "Dev server", shell: true, agent: undefined }),
      make(W("tester"), { ...at, title: "Tester" }),
      make(W("fixtures"), { ...at, title: "Fixtures", taskGroup: `${WIRE_AREA}/docs` }),
      make(W("docs"), { ...at, title: "Docs", taskGroup: `${WIRE_AREA}/docs` }),
    ],
    closed: [make(W("spike"), { ...at, title: "Spike: streaming", status: "dead", conversation: { agent: "claude", id: "conv-wb-spike" } })],
  };
}

/**
 * The board's places at (x, y), Inbox.dc.html's half as big again and on the grid (no workspace is smaller than a 40 × 8
 * terminal): its area, its workspaces' and its stack's.
 */
export function placeWireBoard(l: Landscape, x: number, y: number, repo: string): Area {
  const at = (dx: number, dy: number, w: number, h: number): Rect => ({ x: x + dx, y: y + dy, w, h });
  l.workspaces[W("shape")] = at(40, 88, 344, 288);
  l.workspaces[W("builder")] = at(456, 88, 392, 344);
  l.workspaces[W("reviewer")] = at(920, 88, 328, 304);
  l.workspaces[W("dev")] = at(456, 496, 392, 168);
  l.workspaces[W("tester")] = at(920, 528, 328, 200);
  l.stacks[`${WIRE_AREA}/docs`] = { active: W("fixtures"), placement: at(40, 448, 344, 216) };
  l.workspaces[W("spike")] = at(40, 736, 344, 168);
  return (l.areas[WIRE_AREA] = { ...at(0, 0, 1288, 944), repos: [{ path: repo, base: "dev" }] });
}

/**
 * A wire in each state (Inbox.dc.html): Shape export's spec sent to Builder; Builder's work sending to Reviewer;
 * Reviewer's changes ready to go back (round 2 of 3); its handoff to Tester blocked till it approves; Builder's Dev
 * server sharing its worktree; Shape export read by Docs, a stack's back tab; Fixtures handing off to a ghost; Reviewer
 * reading 5102's Pathways.
 */
export function wireBoardBook(at: number): WireBook {
  let n = 0;
  const wire = (from: string, to: string, type: Wire["type"], over: Partial<Wire> = {}): Wire => ({ ...newWire(from, to, type, at + n++), ...over });
  return {
    wv: 1,
    links: {
      [W("sent")]: wire(W("shape"), W("builder"), "handoff", { delivery: { id: "pd-spec", state: "sent", at } }),
      [W("sending")]: wire(W("builder"), W("reviewer"), "handoff", {
        pending: { id: "pd-build", body: "Streams the export instead of loading 40k rows.", at, flags: [] },
        delivery: { id: "pd-build", state: "queued", at },
      }),
      [W("loop")]: wire(W("reviewer"), W("builder"), "feedback", {
        rounds: { limit: 3, used: 1 },
        pending: { id: "pd-review", body: "1. The stream disposes early.\n2. Email needs DonorPII.", at, verdict: "changes", flags: [] },
      }),
      [W("held")]: wire(W("reviewer"), W("tester"), "handoff"),
      [W("tree")]: wire(W("builder"), W("dev"), "worktree"),
      [W("context")]: wire(W("shape"), W("docs"), "context"),
      [W("ghost")]: wire(W("fixtures"), W("spike"), "handoff"),
      [W("pill")]: wire(W("reviewer"), "s5", "context"),
    },
    notes: { [W("reviewer")]: { summary: { text: "Asked for 2 changes before merge.", at }, verdict: "changes", hops: 0 } },
  };
}

/** The pipeline strip's boards over the wires board (W6, `?wires=`), focused on Builder. */
export type StripBoard = "chain" | "fanout";
export const stripBoardOf = (q: string | null): StripBoard | null => (q === "chain" || q === "fanout" ? q : null);

/**
 * The wires board with what the strip's boards add (W6). chain (Focus.dc.html): Builder's path as the board has it,
 * and 5102's Pathways reading Builder's context, attached beside its Dev server. fanout (WireFanOut.dc.html A): that,
 * and Builder handing on to Spike (closed) and Docs (a stack's tab behind Fixtures) as well as to Reviewer.
 */
export function stripBoardBook(board: StripBoard, at: number): WireBook {
  const book = wireBoardBook(at);
  const wire = (from: string, to: string, type: Wire["type"], n: number): Wire => newWire(from, to, type, at + 100 + n);
  book.links[W("portal")] = wire("s5", W("builder"), "context", 0);
  if (board === "fanout") {
    book.links[W("to-spike")] = wire(W("builder"), W("spike"), "handoff", 1);
    book.links[W("to-docs")] = wire(W("builder"), W("docs"), "handoff", 2);
  }
  return book;
}

/**
 * `count` wires between the agents of `sessions` (?landscapeMany), for what drawing them costs: each to the agent two
 * after it, then three after, and so on, cycling through the states a wire shows.
 */
export function manyWiresBook(sessions: readonly SessionInfo[], count: number, at: number): WireBook {
  const agents = sessions.filter((s) => !s.shell).map((s) => s.id);
  const links: Record<string, Wire> = {};
  for (let k = 0; k < count && agents.length > 1; k++) {
    const from = agents[k % agents.length];
    const to = agents[(k + 1 + Math.floor(k / agents.length)) % agents.length];
    if (from === to) continue;
    const kind = k % 5;
    const w = newWire(from, to, kind === 4 ? "context" : "handoff", at + k);
    const pending = { id: `pm${k}`, body: "Done: the tests cover it now.", at, flags: [] };
    links[`m${k}`] =
      kind === 1 ? { ...w, delivery: { id: `pm${k}`, state: "sent", at } } : kind === 2 ? { ...w, pending, delivery: { id: `pm${k}`, state: "queued", at } } : kind === 3 ? { ...w, pending } : w;
  }
  return { wv: 1, links, notes: {} };
}

// ---- the audit ----------------------------------------------------------------------------

export interface WiresAuditEnv {
  calls: { fn: string; args: unknown[] }[];
  waitFor: (selector: string, then: (el: HTMLElement) => void, tries?: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r1 = (n: number) => Math.round(n * 10) / 10;
const world = () => document.querySelector<HTMLElement>(".ls-world")!;
const zoomNow = () => Number(/scale\(([-\d.e]+)\)/.exec(world().style.transform)?.[1] ?? NaN);
const node = (id: string) => document.querySelector<HTMLElement>(`.ls-world [data-front="${CSS.escape(id)}"], .ls-world .ls-node[data-ws="${CSS.escape(id)}"]`);
const box = (el: Element | null) => {
  const r = el?.getBoundingClientRect();
  return r ? { l: r1(r.left), t: r1(r.top), r: r1(r.right), b: r1(r.bottom) } : null;
};
/** A wire's ends on screen, as its path runs. */
const endsOf = (id: string) => {
  const p = document.querySelector<SVGPathElement>(`.ls-wires g[data-wire="${CSS.escape(id)}"] path.line`);
  const m = p?.getScreenCTM();
  if (!p || !m || !p.getAttribute("d")) return null;
  const at = (len: number) => {
    const q = p.getPointAtLength(len).matrixTransform(m);
    return { x: r1(q.x), y: r1(q.y) };
  };
  return { from: at(0), to: at(p.getTotalLength()) };
};
/** Every wire drawn: its look, arrow, dot, label and tab names, ends, and its line's width and its label's height on screen. */
const wiresNow = () => {
  const z = zoomNow();
  return [...document.querySelectorAll<SVGGElement>(".ls-wires g.ls-wire")].map((g) => {
    const id = g.dataset.wire!;
    const line = g.querySelector<SVGPathElement>("path.line")!;
    const label = document.querySelector<HTMLElement>(`.ls-wire-labels .ls-wire-label[data-wire="${CSS.escape(id)}"]`);
    const dot = g.querySelector("circle");
    return {
      id,
      look: [...g.classList].find((c) => c.startsWith("lk-"))?.slice(3) ?? null,
      arrow: !!line.getAttribute("marker-end"),
      dot: dot ? (getComputedStyle(dot).display === "none" ? "hidden" : dot.classList.contains("blocked") ? "blocked" : "ready") : null,
      glow: !!g.querySelector("path.glow"),
      label: label ? { text: label.textContent, shown: getComputedStyle(label).display !== "none" && label.getBoundingClientRect().height > 0, h: r1(label.getBoundingClientRect().height) } : null,
      tabs: [...document.querySelectorAll<HTMLElement>(`.ls-wire-labels .ls-wire-tab[data-wire="${CSS.escape(id)}"]`)].map((t) => ({ end: t.dataset.end, text: t.textContent })),
      ends: endsOf(id),
      width: r1(parseFloat(getComputedStyle(line).strokeWidth) * z),
      dash: getComputedStyle(line).strokeDasharray,
    };
  });
};

// ---- W4b: making wires --------------------------------------------------------------------

type Pt = { x: number; y: number };
const mid = (el: Element | null | undefined): Pt => {
  const r = el?.getBoundingClientRect();
  if (!r || !r.width) throw new Error("what was to be pressed isn't drawn");
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
};
/** The middle of what of `el` is in the landscape's view. */
const midShown = (el: Element): Pt => {
  const r = el.getBoundingClientRect();
  const v = document.querySelector(".ls-viewport")!.getBoundingClientRect();
  const [t, b] = [Math.max(r.top, v.top), Math.min(r.bottom, v.bottom)];
  const [l, rt] = [Math.max(r.left, v.left), Math.min(r.right, v.right)];
  return { x: Math.round((l + rt) / 2), y: Math.round((t + b) / 2) };
};
const handleOf = (k: string) => node(W(k))?.querySelector<HTMLElement>(".ls-wh");
const stackEl = () => document.querySelector<HTMLElement>(`.ls-world .ls-node[data-front="${W("fixtures")}"]`);
/** A wire's middle on screen, where a right-click on it lands. */
const wireMid = (id: string): Pt => {
  const p = document.querySelector<SVGPathElement>(`.ls-wires g[data-wire="${CSS.escape(id)}"] path.line`);
  const m = p?.getScreenCTM();
  if (!p || !m) throw new Error(`wire ${id} isn't drawn`);
  const q = p.getPointAtLength(p.getTotalLength() / 2).matrixTransform(m);
  return { x: Math.round(q.x), y: Math.round(q.y) };
};
const pickerNow = () => {
  const p = document.querySelector<HTMLElement>(".wp-pick:not(.mb-ghost)");
  if (!p) return null;
  return {
    ends: p.querySelector(".wp-ends")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
    rows: [...p.querySelectorAll<HTMLButtonElement>(".wp-row")].map((b) => ({ type: b.dataset.type, off: b.disabled, on: b.classList.contains("on"), line: b.querySelector(".wp-line-t")?.textContent ?? null })),
    foot: p.querySelector(".wp-foot")?.textContent ?? null,
    keyboard: p.contains(document.activeElement),
  };
};
const noteNow = () => document.querySelector<HTMLElement>(".ls-note")?.firstChild?.textContent ?? null;
const draftNow = () => {
  const d = document.querySelector<SVGSVGElement>(".ls-wire-draft");
  const h = document.querySelector<HTMLElement>(".ls-wire-hot");
  return { line: !!d && d.style.display !== "none" && !!d.querySelector("path.draft")?.getAttribute("d"), hot: h && !h.hidden ? { box: box(h), no: h.classList.contains("no") } : null };
};
/** Where the keyboard is, as wire making cares: a terminal, the landscape, the picker, a menu, or a settings popover. */
const keysAt = () => {
  const a = document.activeElement;
  if (a?.closest(".xterm")) return `terminal:${a.closest<HTMLElement>(".ls-node")?.dataset.front ?? "?"}`;
  if (a?.classList.contains("ls-viewport")) return "landscape";
  if (a?.closest(".wp-pick")) return "picker";
  if (a?.closest(".wr-pop")) return "settings";
  if (a?.closest(".mb-ctx")) return "menu";
  return a?.tagName ?? "none";
};
const menuNow = () => {
  const m = document.querySelector<HTMLElement>(".mb-ctx:not(.mb-ghost)");
  return m ? [...m.children].map((c) => (c.classList.contains("mb-ctx-sep") ? "-" : c.classList.contains("mb-ctx-h") ? `# ${c.textContent}` : `${(c as HTMLButtonElement).disabled ? "off " : ""}${c.querySelector(".mb-ctx-t")?.textContent}${(c as HTMLElement).title && (c as HTMLButtonElement).disabled ? ` — ${(c as HTMLElement).title}` : ""}`)) : null;
};
const menuRow = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".mb-ctx:not(.mb-ghost) button")].find((b) => b.querySelector(".mb-ctx-t")?.textContent === label) ?? null;
/** A wire dragged with the mouse from `a`, held there (`hold`) or let go at `b`. */
const dragWire = (a: Pt, b: Pt, hold?: "down" | "up") => drive([{ move: a }, { drag: { x0: a.x, y0: a.y, x1: b.x, y1: b.y, ...(hold ? { hold } : {}) } }]);
/** Synthetic events, for a screenshot with no driver: a wire dragged from `a` and dropped at `b`. */
async function dragWireBy(a: Pt, b: Pt, el: Element) {
  const init = { bubbles: true, cancelable: true, pointerId: 31, button: 0, buttons: 1 };
  el.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: a.x, clientY: a.y }));
  for (let i = 1; i <= 6; i++) {
    window.dispatchEvent(new PointerEvent("pointermove", { ...init, clientX: a.x + ((b.x - a.x) * i) / 6, clientY: a.y + ((b.y - a.y) * i) / 6 }));
    await sleep(30);
  }
  // what's under the drop is found with elementFromPoint, as a person's would be
  window.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0, clientX: b.x, clientY: b.y }));
}

async function makeAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const z = zoomNow();
  const since = (mark: number, fn: string) => env.calls.slice(mark).filter((c) => c.fn === fn).map((c) => c.args);
  // where its handle is, read while it is drawn: a dragged wire hides the handles it is not over
  const S = mid(handleOf("shape"));
  // a drop on Reviewer, ↵ in the picker after a pause: a handoff
  let mark = env.calls.length;
  const drawnBefore = document.querySelectorAll(".ls-wires g.ls-wire").length;
  await dragWire(S, mid(node(W("reviewer"))), "down");
  const during = draftNow();
  await dragWire(S, mid(node(W("reviewer"))), "up");
  const picked = pickerNow();
  await sleep(1100);
  await drive([{ key: "Enter" }]);
  await sleep(500);
  out.drop = { during, picker: picked, made: since(mark, "wiresAdd"), afterPicker: pickerNow(), drawn: document.querySelectorAll(".ls-wires g.ls-wire").length - drawnBefore, keys: keysAt() };
  // Esc while dragging: the wire goes, and no picker comes up
  mark = env.calls.length;
  await dragWire(S, mid(node(W("builder"))), "down");
  const held = draftNow();
  await drive([{ key: "Escape" }]);
  const after = draftNow();
  await dragWire(S, mid(node(W("builder"))), "up");
  await sleep(300);
  out.escDrag = { held, after, picker: pickerNow(), made: since(mark, "wiresAdd") };
  // Esc in the picker
  await sleep(1100);
  mark = env.calls.length;
  await dragWire(S, mid(node(W("builder"))));
  const open = pickerNow();
  await drive([{ key: "Escape" }]);
  await sleep(300);
  out.escPick = { open, picker: pickerNow(), made: since(mark, "wiresAdd"), keys: keysAt() };
  // a refused drop: Nick's workspace (a teammate's), or Dev server, a terminal, onto Builder, whose shared worktree it has
  await sleep(600);
  mark = env.calls.length;
  const nick = document.querySelector<HTMLElement>(`.ls-world .ls-node.remote[data-front*="n1"]`) ?? [...document.querySelectorAll<HTMLElement>(".ls-world .ls-node.remote")][0];
  const nickOn = !!nick && (() => {
    const r = nick.getBoundingClientRect();
    return r.bottom > 60 && r.top < innerHeight - 40;
  })();
  const [from, onto] = nickOn ? [S, midShown(nick)] : [mid(handleOf("dev")), mid(node(W("builder")))];
  await dragWire(from, onto, "down");
  const refusedHot = draftNow().hot;
  await dragWire(from, onto, "up");
  await sleep(300);
  out.refused = { onto: nickOn ? "nick" : "builder", hot: refusedHot, note: noteNow(), picker: pickerNow(), made: since(mark, "wiresAdd") };
  // a drop onto the docs stack: its front, Fixtures; at 100%, its Docs tab, the session the wire goes to
  await sleep(600);
  await dragWire(S, midShown(stackEl()!));
  out.stack = { picker: pickerNow() };
  await drive([{ key: "Escape" }]);
  await sleep(300);
  if (z >= 0.75) {
    await sleep(1100);
    await dragWire(S, mid(document.querySelector(`.ls-world .ls-tab[data-sid="${W("docs")}"]`)));
    out.stackTab = { picker: pickerNow() };
    await drive([{ key: "Escape" }]);
    await sleep(300);
  }
  out.writes = env.calls.filter((c) => c.fn === "sessionWrite").length;
}

async function keysAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const since = (mark: number, fn: string) => env.calls.slice(mark).filter((c) => c.fn === fn).map((c) => c.args);
  const start = env.calls.length;
  // where its handle is, read while it is drawn: a dragged wire hides the handles it is not over
  const S = mid(handleOf("shape"));
  // Builder's terminal is typed in
  await drive([{ mouse: { ...mid(node(W("builder"))?.querySelector(".ls-term")), clickCount: 1 } }]);
  await sleep(300);
  out.before = keysAt();
  const typedMark = env.calls.length;
  await drive([{ key: "q" }]);
  out.control = since(typedMark, "sessionWrite").length;
  // keys typed while a wire is dragged act nowhere, and Enter straight after the drop, in the same burst, makes no wire
  await sleep(1100);
  let mark = env.calls.length;
  await dragWire(S, mid(node(W("tester"))), "down");
  out.dragKeys = keysAt();
  await drive([{ key: "t" }, { key: "x" }, { key: "Tab" }, { key: "Enter" }]);
  const mid1 = { dragging: { picker: pickerNow(), draft: draftNow().line }, writes: since(mark, "sessionWrite").length, layout: since(mark, "landscapeUpdate").length };
  await dragWire(S, mid(node(W("tester"))), "up");
  await drive([{ key: "Enter" }]);
  out.burst = { ...mid1, picker: pickerNow(), made: since(mark, "wiresAdd") };
  await sleep(1200);
  await drive([{ key: "Enter" }]);
  await sleep(400);
  out.paused = { made: since(mark, "wiresAdd"), picker: pickerNow(), keys: keysAt() };
  // a click on a row that came up under the pointer: let go, its row off until a click there counts
  await sleep(600);
  mark = env.calls.length;
  await dragWire(S, mid(node(W("reviewer"))));
  const row = () => document.querySelector<HTMLElement>(`.wp-pick .wp-row[data-type="context"]`);
  await drive([{ mouse: { ...mid(row()), clickCount: 1 } }]);
  const early = { made: since(mark, "wiresAdd"), off: (row() as HTMLButtonElement | null)?.disabled ?? null, picker: !!pickerNow() };
  await sleep(700);
  // a click with no pointer behind it (a key's on a focused row, or code's) picks nothing, settled or not
  row()?.click();
  await sleep(200);
  const byCode = { made: since(mark, "wiresAdd"), picker: !!pickerNow() };
  await drive([{ mouse: { ...mid(row()), clickCount: 1 } }]);
  await sleep(400);
  out.click = { early, byCode, made: since(mark, "wiresAdd"), picker: pickerNow() };
  // Connect…'s menu: Tester picked with Enter, and Enter again straight after, in the same burst, makes no wire
  await sleep(600);
  mark = env.calls.length;
  await drive([{ mouse: { ...mid(node(W("dev"))?.querySelector(".ls-head .ls-spacer")), clickCount: 1, button: "right" } }]);
  await sleep(200);
  await drive([{ mouse: { ...mid(menuRow("Connect…")), clickCount: 1 } }]);
  await sleep(300);
  await drive([{ move: mid(menuRow("Tester")) }]);
  await sleep(100);
  await drive([{ key: "Enter" }, { key: "Enter" }]);
  const connect = { picker: pickerNow(), made: since(mark, "wiresAdd") };
  await drive([{ key: "Escape" }]);
  await sleep(300);
  out.connect = { ...connect, after: pickerNow(), keys: keysAt() };
  out.writes = since(start, "sessionWrite").map((a) => a[0]);
}

async function menusAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const since = (mark: number, fn: string) => env.calls.slice(mark).filter((c) => c.fn === fn).map((c) => c.args);
  // Connect…'s rows
  await drive([{ mouse: { ...mid(node(W("shape"))?.querySelector(".ls-head .ls-spacer")), clickCount: 1, button: "right" } }]);
  await sleep(200);
  out.wsMenu = menuNow();
  await drive([{ mouse: { ...mid(menuRow("Connect…")), clickCount: 1 } }]);
  await sleep(300);
  out.connect = menuNow();
  await drive([{ key: "Escape" }]);
  await sleep(300);
  // the same from its row in the side bar's tree, outside the landscape
  const treeRow = document.querySelector<HTMLElement>(`.area-tree .lt-ws[data-sid="${CSS.escape(W("shape"))}"]`);
  if (treeRow) {
    await drive([{ mouse: { ...mid(treeRow), clickCount: 1, button: "right" } }]);
    await sleep(200);
    await drive([{ mouse: { ...mid(menuRow("Connect…")), clickCount: 1 } }]);
    await sleep(300);
    out.fromTree = menuNow();
    await drive([{ key: "Escape" }]);
    await sleep(300);
  } else out.fromTree = "no row in the tree";
  // a wire's right-click: Reviewer → Tester, held till approve
  await drive([{ mouse: { ...wireMid(W("held")), clickCount: 1, button: "right" } }]);
  await sleep(200);
  out.wireMenu = menuNow();
  await drive([{ mouse: { ...mid(menuRow("Settings…")), clickCount: 1 } }]);
  await sleep(300);
  const form = () => {
    const f = document.querySelector<HTMLElement>(".wr-pop:not(.mb-ghost)");
    return f
      ? {
          ends: f.querySelector(".wr-ends")?.textContent?.replace(/\s+/g, " ").trim(),
          kind: f.querySelector(".wr-kind")?.textContent,
          template: f.querySelector<HTMLTextAreaElement>(".wr-tpl")?.value,
          chips: [...f.querySelectorAll<HTMLElement>(".wr-chip")].map((c) => c.textContent),
          when: [...f.querySelectorAll<HTMLElement>(".wr-seg button")].map((b) => `${b.getAttribute("aria-pressed") === "true" ? "* " : ""}${b.textContent}`),
          auto: f.querySelector<HTMLInputElement>(".wr-check input")?.checked ?? null,
          keyboard: f.contains(document.activeElement),
        }
      : null;
  };
  const opened = form();
  let mark = env.calls.length;
  await drive([{ mouse: { ...mid([...document.querySelectorAll(".wr-seg button")].find((b) => b.textContent === "Only when I send")), clickCount: 1 } }]);
  await sleep(400);
  out.settings = { opened, set: since(mark, "wiresSet"), after: form() };
  await drive([{ key: "Escape" }]);
  await sleep(300);
  out.settingsClosed = { form: form(), keys: keysAt() };
  // a shared worktree has nothing to set
  await drive([{ mouse: { ...wireMid(W("tree")), clickCount: 1, button: "right" } }]);
  await sleep(200);
  out.treeMenu = menuNow();
  await drive([{ key: "Escape" }]);
  await sleep(300);
  // Settings… picked with Enter, and Tab eight times and Enter in the same burst: Tab walks onto no control, Enter
  // presses nothing (Remove is the eighth stop), and nothing is changed
  await sleep(1100);
  mark = env.calls.length;
  await drive([{ mouse: { ...wireMid(W("held")), clickCount: 1, button: "right" } }]);
  await sleep(200);
  await drive([{ key: "Enter" }]);
  const shown = { open: !!form(), keyboard: keysAt() };
  await drive([...Array.from({ length: 8 }, () => ({ key: "Tab" })), { key: "Enter" }]);
  await sleep(300);
  const burstKeys = { shown, open: !!form(), keyboard: document.activeElement?.classList.contains("wr-pop") ?? false, set: since(mark, "wiresSet"), removed: since(mark, "wiresRemove") };
  await drive([{ key: "Escape" }]);
  await sleep(300);
  out.settingsBurst = { ...burstKeys, closed: !form() };
  // Remove, and the note's Undo
  mark = env.calls.length;
  await drive([{ mouse: { ...wireMid(W("held")), clickCount: 1, button: "right" } }]);
  await sleep(200);
  await drive([{ mouse: { ...mid(menuRow("Remove the wire")), clickCount: 1 } }]);
  await sleep(400);
  const removed = { calls: since(mark, "wiresRemove"), note: noteNow(), drawn: !!document.querySelector(`.ls-wires g[data-wire="${W("held")}"]`) };
  await drive([{ mouse: { ...mid(document.querySelector(".ls-note .ls-note-act")), clickCount: 1 } }]);
  await sleep(400);
  out.remove = { removed, restore: since(mark, "wiresRestore"), drawn: !!document.querySelector(`.ls-wires g[data-wire="${W("held")}"]`) };
}

/** The picker or a wire's settings left open, for a screenshot beside its board (synthetic events: no driver there). */
async function showAudit(part: string): Promise<void> {
  if (part === "pick") {
    const h = handleOf("shape")!;
    h.style.opacity = "1";
    await dragWireBy(mid(h), mid(node(W("tester"))), h);
    return;
  }
  const at = wireMid(W("held"));
  document.querySelector(".ls-viewport")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 2 }));
  await sleep(300);
  menuRow("Settings…")?.click();
}

export function runWiresAudit(env: WiresAuditEnv, part: string): void {
  const report = (out: unknown) => {
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "mb-landscape-wires-audit";
    tag.textContent = JSON.stringify(out);
    document.body.appendChild(tag);
  };
  env.waitFor(`.ls-wires g.ls-wire`, async () => {
    const out: Record<string, unknown> = { part };
    try {
      // the screenshots' parts open theirs at once: a screenshot is taken a few seconds of virtual time in
      await sleep(part === "pick" || part === "settings" ? 300 : 1200);
      out.zoom = zoomNow();
      if (part === "pick" || part === "settings") {
        await showAudit(part);
        out.shown = { picker: pickerNow(), settings: !!document.querySelector(".wr-pop:not(.mb-ghost)"), note: noteNow() };
      }
      if (part === "make") await makeAudit(env, out);
      else if (part === "keys") await keysAudit(env, out);
      else if (part === "menus") await menusAudit(env, out);
      const boxes = () => Object.fromEntries(["shape", "builder", "reviewer", "dev", "tester", "fixtures", "spike"].map((k) => [k, box(node(W(k)))]));
      if (part === "near" || part === "far") {
        out.wires = wiresNow();
        out.boxes = boxes();
        out.docsTab = box(document.querySelector(`.ls-world .ls-tab[data-sid="${W("docs")}"]`));
        // the layer: after the areas, before every ghost and workspace
        const kids = [...world().children];
        const at = (sel: string) => kids.findIndex((k) => k.matches(sel));
        const areas = kids.flatMap((k, i) => (k.matches(".ls-area, .ls-area-pill") ? [i] : []));
        out.order = { svg: at(".ls-wires"), labels: at(".ls-wire-labels"), lastArea: Math.max(...areas), firstGhost: at(".ls-ghost"), firstNode: at(".ls-node") };
        out.events = [getComputedStyle(document.querySelector(".ls-wires")!).pointerEvents, getComputedStyle(document.querySelector(".ls-wire-labels")!).pointerEvents];
      } else if (part === "area") {
        // 5120 dragged by its name zoomed out to cards: the wires follow its workspaces, and stay where they are among the world's
        const name = document.querySelector<HTMLElement>(`.ls-world .ls-area[data-area="5120"] .ls-area-title .n`);
        if (!name) throw new Error("5120 has no name to drag");
        const r = name.getBoundingClientRect();
        const p = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        const init = { bubbles: true, cancelable: true, pointerId: 22, button: 0, buttons: 1 };
        const lifted = () => [getComputedStyle(document.querySelector(".ls-wires")!).zIndex, getComputedStyle(document.querySelector(".ls-wire-labels")!).zIndex];
        out.before = { lifted: lifted(), builder: box(node(W("builder"))), sent: endsOf(W("sent")) };
        name.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: p.x, clientY: p.y }));
        for (let i = 1; i <= 6; i++) {
          window.dispatchEvent(new PointerEvent("pointermove", { ...init, clientX: p.x + i * 6, clientY: p.y + i * 4 }));
          await sleep(30);
        }
        out.during = { lifted: lifted(), builder: box(node(W("builder"))), sent: endsOf(W("sent")) };
        window.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0, clientX: p.x + 36, clientY: p.y + 24 }));
        await sleep(1200);
        out.after = { lifted: lifted(), builder: box(node(W("builder"))), sent: endsOf(W("sent")) };
      } else if (part === "tidy") {
        // 5120 tidied from its toolbar (W10): along its wires, said in the note
        const tidy = document.querySelector<HTMLButtonElement>(`.ls-world .ls-area[data-area="${WIRE_AREA}"] .ls-area-tools button[data-act="tidy"]`);
        if (!tidy) throw new Error("5120 has no Tidy");
        tidy.click();
        await sleep(600);
        out.said = document.querySelector(".ls-note")?.textContent ?? null;
        out.boxes = boxes();
        out.wires = wiresNow();
      } else if (part === "pill") {
        out.wires = wiresNow();
        out.pill = box(document.querySelector(`.ls-world .ls-area-pill[data-area="5102"]`));
      } else if (part === "drag") {
        const mark = env.calls.length;
        const head = node(W("builder"))?.querySelector<HTMLElement>(".ls-head .ls-spacer") ?? node(W("builder"))?.querySelector<HTMLElement>(".ls-head");
        if (!head) throw new Error("Builder has no header to drag");
        const r = head.getBoundingClientRect();
        const p = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        const init = { bubbles: true, cancelable: true, pointerId: 21, button: 0, buttons: 1 };
        const before = { builder: box(node(W("builder"))), sent: endsOf(W("sent")), tree: endsOf(W("tree")) };
        head.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: p.x, clientY: p.y }));
        const moves = 8;
        for (let i = 1; i <= moves; i++) {
          window.dispatchEvent(new PointerEvent("pointermove", { ...init, clientX: p.x + (i * 64) / moves, clientY: p.y + (i * 40) / moves }));
          await sleep(30);
        }
        out.before = before;
        out.during = { builder: box(node(W("builder"))), sent: endsOf(W("sent")), tree: endsOf(W("tree")), loop: endsOf(W("loop")), translate: node(W("builder"))?.style.translate ?? null };
        window.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0, clientX: p.x + 64, clientY: p.y + 40 }));
        await sleep(1200);
        out.after = { builder: box(node(W("builder"))), sent: endsOf(W("sent")), tree: endsOf(W("tree")), loop: endsOf(W("loop")), translate: node(W("builder"))?.style.translate ?? null };
        // a pinch out about the viewport's middle: the wires redrawn at the new zoom, still on their ends
        const vp = document.querySelector<HTMLElement>(".ls-viewport")!.getBoundingClientRect();
        for (let i = 0; i < 6; i++) {
          document.querySelector(".ls-viewport")!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 12, clientX: vp.left + vp.width / 2, clientY: vp.top + vp.height / 2 }));
          await sleep(30);
        }
        await sleep(600);
        out.pinched = { zoom: zoomNow(), builder: box(node(W("builder"))), sent: endsOf(W("sent")) };
        out.calls = env.calls.slice(mark).map((c) => c.fn);
      }
    } catch (err) {
      out.error = String(err instanceof Error ? err.stack : err);
    }
    report(out);
  });
}
