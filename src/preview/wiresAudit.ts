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
 * - =pick and =settings: the picker, and Reviewer → Tester's settings, left open for a screenshot (synthetic events);
 * - =fresh (with ?lsSpikeGone): Start fresh from Spike's ghost, its handoff from Fixtures moved to the fresh session, or
 *   with `&freshAs=terminal` refused, gone with Spike and said.
 * - =step (with ?lsPlanned, at 100%): W8's not-started Tester and Add next step, from a handle clicked and from one
 *   dragged into empty space, the dialog's guards against a burst's key and an early click, its ⋯ with Enter held, and
 *   Start now…'s confirm (stepAudit).
 *
 * W4c's, the send popover (with ?lsGates for the gates `gateBoardBook` sets):
 * - =send, =gatekeys and =dbl (at 100%): Send and Not yet, and the clicks and keys they take or don't;
 * - =gates: B closed, unconfirmed, a merge that can't be read, a blocked wire's settings; with lsGates=limit, the limit;
 * - =pop&pop=<wire> (&popConfirm): a wire's popover left open for a screenshot (synthetic events);
 * - review fixes 1: =refocus (a newer finish, or a face change, under the keyboard), =limitkeys (lsGates=limit: Send
 *   reached by keys as it comes up), =shift (a Shift in a burst), and with lsGates&lsBigResume=wb-spike =costrepeat (a
 *   held Enter at the cost question), =costlost and =closeother (what a Send comes to as its popover stays or goes).
 */
import type { Area, Landscape, Rect } from "../shared/landscape";
import type { SessionInfo, TicketPipeline } from "../shared/types";
import { newWire, type MergeView, type Wire, type WireBook } from "../shared/wires";
import { drive, type Asked } from "./needsYouAudit";

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

/** W4c's pull request on 5120, which the merge watch can't read (`?lsGates`). */
export const GATE_PR_URL = "https://dev.azure.com/acme/Backoffice/_git/backoffice/pullrequest/11";
const GATE_PR_WHY = "Can't tell whether PR 11 to dev merged (3 tries): the provider answered 503 Service Unavailable.";

/**
 * The wires board's gates as the send popover shows them (W4c, `?lsGates`): Builder's handoff to Reviewer may have
 * arrived (unconfirmed); Fixtures' handoff to Spike, a ghost, waits at its gate (Send reopens it); Shape export's handoff
 * to Builder waits for PR 11 to dev to merge, which can't be read (`gateMerges`, `gatePipeline`); with `limit`,
 * Reviewer's feedback loop is at its limit, 3 of 3, with its changes waiting.
 */
export function gateBoardBook(book: WireBook, at: number, limit: boolean): WireBook {
  const links = { ...book.links };
  links[W("sending")] = { ...links[W("sending")], delivery: { id: "pd-build", state: "unconfirmed", at, why: "It may have reached “Reviewer”: Mockingbird quit while it was being pasted." } };
  links[W("ghost")] = { ...links[W("ghost")], pending: { id: "pd-fixtures", body: "The streaming fixtures are in fixtures/stream: 40k donors, one with no email.", at, flags: [] } };
  const { delivery: _sent, ...shape } = links[W("sent")];
  links[W("sent")] = { ...shape, when: "pr-merged", since: at };
  if (limit) links[W("loop")] = { ...links[W("loop")], rounds: { limit: 3, used: 3 } };
  return { ...book, links };
}
/** Main's merge view of `?lsGates`' pr-merged wire: its pull request can't be read. */
export const gateMerges = (): Record<string, MergeView> => ({ [W("sent")]: { blocked: GATE_PR_WHY, prs: [GATE_PR_URL] } });
/** 5120's ticket record with that pull request, its reads failing. */
export const gatePipeline = (at: number): TicketPipeline => ({
  ticketId: WIRE_AREA,
  title: "Shape donor export",
  stage: "pr-dev",
  history: [],
  prs: [{ target: "dev", provider: "ado", id: 11, url: GATE_PR_URL, repo: "backoffice", branch: DIR, base: "dev", at: at - 3_600_000, watch: { failures: 3, why: "the provider answered 503 Service Unavailable", at } }],
  feedback: [],
  drafts: [],
  checks: {},
});

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
  /** Wire `id`'s source finishes again, as its finish_step would: a new pending, `body`, replaces what waited. */
  finish?: (id: string, body: string) => void;
  /** What waits at wire `id`'s gate is sent from elsewhere (another window's Send): its gate goes idle. */
  sent?: (id: string) => void;
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
  if (a?.closest(".wg-pop")) return "popover";
  if (a?.closest(".wr-pop")) return "settings";
  if (a?.closest(".mb-ctx")) return "menu";
  return a?.tagName ?? "none";
};
const menuNow = () => {
  const m = document.querySelector<HTMLElement>(".mb-ctx:not(.mb-ghost)");
  return m ? [...m.children].map((c) => (c.classList.contains("mb-ctx-sep") ? "-" : c.classList.contains("mb-ctx-h") ? `# ${c.textContent}` : `${(c as HTMLButtonElement).disabled ? "off " : ""}${c.querySelector(".mb-ctx-t")?.textContent}${(c as HTMLElement).title && (c as HTMLButtonElement).disabled ? ` — ${(c as HTMLElement).title}` : ""}`)) : null;
};
const menuRow = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".mb-ctx:not(.mb-ghost) button")].find((b) => b.querySelector(".mb-ctx-t")?.textContent === label) ?? null;
/**
 * A wire dragged with the mouse from `a`, held there (`hold`) or let go at `b`. Letting go of one held moves nothing
 * first: the driver's move has no button down, which ends a wire's drag as a release the window never saw.
 */
const dragWire = (a: Pt, b: Pt, hold?: "down" | "up") =>
  drive([...(hold === "up" ? [] : [{ move: a }]), { drag: { x0: a.x, y0: a.y, x1: b.x, y1: b.y, ...(hold ? { hold } : {}) } }]);
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
  // Settings… picked with Enter, and Tab nine times and Enter in the same burst: Tab walks onto no control, Enter
  // presses nothing (Remove is the ninth stop, after a handoff's three Whens), and nothing is changed
  await sleep(1100);
  mark = env.calls.length;
  await drive([{ mouse: { ...wireMid(W("held")), clickCount: 1, button: "right" } }]);
  await sleep(200);
  await drive([{ key: "Enter" }]);
  const shown = { open: !!form(), keyboard: keysAt() };
  await drive([...Array.from({ length: 9 }, () => ({ key: "Tab" })), { key: "Enter" }]);
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

/** A point `f` of the way along wire `id`'s line, on screen. */
const alongWire = (id: string, f: number): Pt => {
  const p = document.querySelector<SVGPathElement>(`.ls-wires g[data-wire="${CSS.escape(id)}"] path.line`);
  const m = p?.getScreenCTM();
  if (!p || !m) throw new Error(`wire ${id} isn't drawn`);
  const q = p.getPointAtLength(p.getTotalLength() * f).matrixTransform(m);
  return { x: Math.round(q.x), y: Math.round(q.y) };
};
const settingsOpen = () => !!document.querySelector(".wr-pop:not(.mb-ghost)");

/**
 * A double click on a wire's Settings… where its menu and its settings both come up above the pointer (near the window's
 * foot, `&dblWire=<id>`): what of the form comes up under the row (found with one click, then closed), then a real double
 * click there, and what it changed; then, settled, one click there, which counts.
 */
async function doubleAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const id = new URLSearchParams(location.search).get("dblWire") ?? W("sent");
  const since = (mark: number, fn: string) => env.calls.slice(mark).filter((c) => c.fn === fn).map((c) => c.args);
  const at = alongWire(id, 0.3);
  const settingsRow = async () => {
    await drive([{ mouse: { ...at, clickCount: 1, button: "right" } }]);
    await sleep(300);
    const r = menuRow("Settings…")?.getBoundingClientRect();
    if (!r) throw new Error(`wire ${id}'s menu has no Settings… (at ${JSON.stringify(at)} in ${innerWidth}x${innerHeight}: ${document.elementFromPoint(at.x, at.y)?.tagName}; menu ${JSON.stringify(menuNow())})`);
    return { l: r.left, r: r.right, y: Math.round(r.top + r.height / 2) };
  };
  let row = await settingsRow();
  await drive([{ mouse: { x: Math.round(row.l + 20), y: row.y, clickCount: 1 } }]);
  await sleep(700);
  const control = (x: number) => document.elementFromPoint(x, row.y)?.closest<HTMLElement>(".wr-pop button, .wr-pop input, .wr-pop .wr-check");
  let hit: { x: number; what: string } | null = null;
  for (let x = row.l + 4; x < row.r && !hit; x += 6) {
    const c = control(x);
    if (c) hit = { x: Math.round(x), what: c.textContent?.trim() || (c as HTMLInputElement).type };
  }
  await drive([{ key: "Escape" }]);
  await sleep(400);
  out.hit = hit;
  if (!hit) return;
  row = await settingsRow();
  const mark = env.calls.length;
  await drive([{ move: { x: hit.x, y: row.y } }, { mouse: { x: hit.x, y: row.y, clickCount: 1 } }, { pause: 100 }, { mouse: { x: hit.x, y: row.y, clickCount: 2 } }]);
  const held = !!document.querySelector(".wr-pop .wr-form.held");
  await sleep(700);
  const changed = () => [...since(mark, "wiresSet"), ...since(mark, "wiresResetRounds"), ...since(mark, "wiresRemove")];
  out.double = { open: settingsOpen(), held, changed: changed(), err: document.querySelector(".wr-pop .wr-err")?.textContent ?? null };
  // settled: a click there is aimed, and counts
  await drive([{ mouse: { x: hit.x, y: row.y, clickCount: 1 } }]);
  await sleep(400);
  out.settled = { changed: changed().length };
}

/**
 * At 100%: the picker under a resting pointer (Connect…'s, opened where its menu was) chooses nothing by hover; Esc on a
 * handle pressed but not yet dragged drops it and reaches nothing else; a drag whose release the window never saw ends
 * at the next move with no button down, or as the window loses focus, and typing reaches the terminal again; and where
 * the handle is beside the resize edge.
 */
async function guardsAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const since = (mark: number, fn: string) => env.calls.slice(mark).filter((c) => c.fn === fn).map((c) => c.args);
  const gesture = () => document.querySelector(".ls-viewport")!.classList.contains("ls-gesture");
  const S = mid(handleOf("shape"));
  // the handle: just in from the right resize strip, which keeps the edge's middle
  const shape = node(W("shape"))!.getBoundingClientRect();
  const edge = document.elementFromPoint(shape.right - 2, shape.top + shape.height / 2);
  out.handle = { edge: edge?.classList.contains("ls-rz") ? edge.getAttribute("data-edge") : (edge?.className.toString() ?? null), handleRight: Math.round(shape.right - handleOf("shape")!.getBoundingClientRect().right) };
  // Connect… from Shape's right-click, Tester picked by a click: the picker comes up under the pointer; it trembles
  let mark = env.calls.length;
  await drive([{ mouse: { ...mid(node(W("shape"))?.querySelector(".ls-head .ls-spacer")), clickCount: 1, button: "right" } }]);
  await sleep(300);
  await drive([{ mouse: { ...mid(menuRow("Connect…")), clickCount: 1 } }]);
  await sleep(400);
  const t = mid(menuRow("Tester"));
  await drive([{ move: t }, { pause: 150 }, { mouse: { ...t, clickCount: 1 } }, { pause: 150 }, { move: { x: t.x + 1, y: t.y } }]);
  await sleep(700);
  await drive([{ move: { x: t.x + 2, y: t.y + 1 } }]);
  const under = { at: document.elementFromPoint(t.x + 2, t.y + 1)?.closest<HTMLElement>(".wp-row")?.dataset.type ?? null, on: pickerNow()?.rows.find((r) => r.on)?.type ?? null };
  await sleep(800);
  await drive([{ key: "Enter" }]);
  await sleep(400);
  out.hover = { ...under, made: since(mark, "wiresAdd").map((a) => a[2]) };
  // Esc on Shape's handle pressed and not yet dragged: dropped, and the selection (Builder) stays
  await drive([{ mouse: { ...mid(node(W("builder"))?.querySelector(".ls-head .ls-spacer")), clickCount: 1 } }]);
  await sleep(300);
  await drive([{ drag: { x0: S.x, y0: S.y, x1: S.x + 2, y1: S.y, hold: "down" } }]);
  const pressed = gesture();
  await drive([{ key: "Escape" }]);
  out.earlyEsc = { pressed, after: gesture(), selected: document.querySelector<HTMLElement>(".ls-world .ls-node.selected")?.dataset.front ?? null };
  await drive([{ drag: { x0: S.x, y0: S.y, x1: S.x + 2, y1: S.y, hold: "up" } }]);
  await sleep(300);
  // a drag whose release never came: the next move with no button down ends it, so the click into Builder's terminal
  // after is a click (not the drop the stuck drag would make of its release), and what's typed there reaches it
  mark = env.calls.length;
  const T = mid(node(W("tester")));
  await drive([{ drag: { x0: S.x, y0: S.y, x1: T.x, y1: T.y, hold: "down" } }]);
  const dragging = { gesture: gesture(), draft: draftNow().line };
  await drive([{ move: { x: T.x + 8, y: T.y + 8 } }]);
  const lost = { gesture: gesture(), draft: draftNow().line };
  await drive([{ mouse: { ...mid(node(W("builder"))?.querySelector(".ls-term")), clickCount: 1 } }]);
  await sleep(1100);
  await drive([{ key: "q" }]);
  out.lostRelease = { dragging, lost, writes: since(mark, "sessionWrite").length, picker: !!pickerNow() };
  if (pickerNow()) await drive([{ key: "Escape" }]);
  await sleep(300);
  // the window losing focus mid-drag ends it too
  await drive([{ drag: { x0: S.x, y0: S.y, x1: T.x, y1: T.y, hold: "down" } }]);
  const before = gesture();
  window.dispatchEvent(new Event("blur"));
  out.blur = { before, after: gesture(), draft: draftNow().line };
  await drive([{ drag: { x0: T.x, y0: T.y, x1: T.x, y1: T.y, hold: "up" } }]);
  await sleep(300);
  out.picker = !!pickerNow();
}

/**
 * Reviewer → Tester's settings while main refuses every change: a chip's refused change goes back off the field, and a
 * template typed and left as the settings close (Esc) is said over the landscape when it's refused.
 */
async function lostAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const mb = window.mb as unknown as { wiresSet: (...a: unknown[]) => Promise<unknown> };
  mb.wiresSet = async () => ({ refused: "The wire book can't be written right now." });
  await drive([{ mouse: { ...wireMid(W("held")), clickCount: 1, button: "right" } }]);
  await sleep(200);
  await drive([{ mouse: { ...mid(menuRow("Settings…")), clickCount: 1 } }]);
  await sleep(800);
  const tpl = () => document.querySelector<HTMLTextAreaElement>(".wr-pop .wr-tpl")?.value ?? null;
  const was = tpl();
  const chip = [...document.querySelectorAll<HTMLButtonElement>(".wr-pop .wr-chip")].find((b) => b.textContent === "add diff");
  await drive([{ mouse: { ...mid(chip), clickCount: 1 } }]);
  await sleep(300);
  out.chip = { was, now: tpl(), err: document.querySelector(".wr-pop .wr-err")?.textContent ?? null };
  await drive([{ mouse: { ...mid(document.querySelector(".wr-pop .wr-tpl")), clickCount: 1 } }]);
  await sleep(1100);
  await drive([{ key: "x" }, { key: "y" }]);
  await sleep(1100);
  await drive([{ key: "Escape" }]);
  await sleep(500);
  out.closed = { open: settingsOpen(), note: noteNow() };
}

/**
 * Start fresh from Spike's ghost (with ?lsSpikeGone): New session made from it (with `&freshAs=terminal`, a terminal,
 * which a handoff can't end at), then what became of Fixtures' handoff to it, and the note.
 */
async function freshAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const mark = env.calls.length;
  const since = (fn: string) => env.calls.slice(mark).filter((c) => c.fn === fn).map((c) => c.args);
  const ghost = () => document.querySelector<HTMLElement>(`.ls-world .ls-ghost[data-front="${W("spike")}"]`);
  const fronts = () => [...document.querySelectorAll<HTMLElement>(".ls-world .ls-node[data-front]")].map((n) => n.dataset.front!);
  const before = new Set(fronts());
  ghost()?.querySelector<HTMLButtonElement>('[data-act="fresh"]')?.click();
  await sleep(600);
  const dlg = document.querySelector<HTMLElement>(".modal.ns");
  if (new URLSearchParams(location.search).get("freshAs") === "terminal") {
    [...(dlg?.querySelectorAll<HTMLButtonElement>(".ns-launch button") ?? [])].find((b) => b.textContent === "Terminal")?.click();
    await sleep(300);
  }
  dlg?.querySelector<HTMLButtonElement>("button.primary.cta")?.click();
  await sleep(2500);
  const r = await window.mb.wiresGet();
  const links = "book" in r && r.book ? r.book.links : {};
  const w = links[W("ghost")];
  out.fresh = {
    dialog: !!dlg,
    made: fronts().find((id) => !before.has(id)) ?? null,
    ghost: !!ghost(),
    wire: w ? { from: w.from, to: w.to } : null,
    onSpike: Object.values(links).filter((x) => x.from === W("spike") || x.to === W("spike")).length,
    rekey: since("wiresRekey"),
    kill: since("killSession"),
    note: noteNow(),
  };
}

// ---- W4c: the send popover ----------------------------------------------------------------

/** Wire `id`'s gate dot on screen, its middle. */
const dotMid = (id: string): Pt => mid(document.querySelector(`.ls-wires g[data-wire="${CSS.escape(id)}"] circle.dot`));
const popEl = () => document.querySelector<HTMLElement>(".wg-pop:not(.mb-ghost)");
const popButton = (label: string) => [...(popEl()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === label) ?? null;
/** The send popover as shown: its face, title, whys, what it sends, its buttons (off ones marked), and what it said. */
const popNow = () => {
  const p = popEl();
  if (!p) return null;
  const text = (sel: string) => p.querySelector(sel)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
  const field = p.querySelector<HTMLTextAreaElement | HTMLPreElement>(".wg-body");
  return {
    face: [...(p.firstElementChild?.classList ?? [])].find((c) => c.startsWith("wg-"))?.slice(3) ?? null,
    ends: text(".wr-ends"),
    kind: text(".wr-kind"),
    whys: [...p.querySelectorAll(".wg-why")].map((e) => e.textContent),
    body: field ? (field instanceof HTMLTextAreaElement ? field.value : field.textContent) : null,
    flags: [...p.querySelectorAll(".wg-flags li")].map((e) => e.textContent),
    buttons: [...p.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.closest(".wr-foot, .wg-acts")).map((b) => `${b.disabled ? "off " : ""}${b.textContent}`),
    question: text(".wg-q"),
    when: [...p.querySelectorAll<HTMLButtonElement>(".wr-seg button")].map((b) => `${b.getAttribute("aria-pressed") === "true" ? "* " : ""}${b.disabled ? "off " : ""}${b.textContent}`),
    err: text(".wr-err"),
    hint: text(".wg-hint"),
    keyboard: p.contains(document.activeElement),
    box: box(p),
  };
};
const lookNow = (id: string) => [...(document.querySelector(`.ls-wires g[data-wire="${CSS.escape(id)}"]`)?.classList ?? [])].find((c) => c.startsWith("lk-"))?.slice(3) ?? null;
const clickAt = (p: Pt, clickCount = 1) => drive([{ mouse: { ...p, clickCount } }]);

/**
 * Send, Not yet and what they take (at 100%): opened by a click on Reviewer → Builder's dot, a click straight after where
 * Send came up, a click made by code, Not yet; reopened, edited, a second finish arriving while it's open, a click on
 * Send as that lands, then Send double-clicked, and clicked again while main is still answering.
 */
async function sendAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const start = env.calls.length;
  const sends = () => env.calls.slice(start).filter((c) => c.fn === "wiresSend").map((c) => c.args);
  const loop = W("loop");
  await clickAt(dotMid(loop));
  out.opened = popNow();
  await clickAt(mid(popButton("Send")));
  out.early = { sends: sends().length, pop: popNow() };
  await sleep(700);
  popButton("Send")?.click();
  await sleep(200);
  out.byCode = { sends: sends().length, open: !!popEl() };
  await clickAt(mid(popButton("Not yet")));
  await sleep(400);
  out.notYet = { sends: sends().length, pop: popNow(), look: lookNow(loop), keys: keysAt() };
  // reopened, Send automatically clicked as it comes up (let go); then edited, and Reviewer finishes again while it's open
  await sleep(600);
  await clickAt(dotMid(loop));
  const auto = () => popEl()?.querySelector<HTMLInputElement>(".wr-check input") ?? null;
  await clickAt(mid(auto()));
  const autoEarly = { set: env.calls.slice(start).filter((c) => c.fn === "wiresSet").length, checked: auto()?.checked ?? null };
  await sleep(700);
  const field = () => popEl()?.querySelector<HTMLTextAreaElement>("textarea.wg-body") ?? null;
  await drive([{ mouse: { ...mid(field()), clickCount: 1 } }, { key: " " }, { key: "o" }, { key: "k" }]);
  const edited = popNow();
  env.finish?.(loop, "1. The stream still disposes early.\n2. Email needs DonorPII.\n3. Add a test for the cap.");
  await sleep(150);
  const replaced = popNow();
  await clickAt(mid(popButton("Send")));
  const onArrival = { sends: sends().length, pop: popNow() };
  await sleep(700);
  await drive([{ mouse: { ...mid(field()), clickCount: 1 } }, { key: " " }, { key: "o" }, { key: "k" }]);
  await sleep(1100);
  const shown = field()?.value ?? null;
  // Send double-clicked; then, while main is still answering (stub.ts' GATE_ANSWER_MS), clicked once more
  const at = mid(popButton("Send"));
  await clickAt(at);
  await clickAt(at, 2);
  await sleep(200);
  const during = popNow();
  await clickAt(at);
  const again = popNow();
  await sleep(1600);
  out.send = { autoEarly, edited, replaced, onArrival, shown, during, again, sends: sends(), pop: popNow(), look: lookNow(loop), keys: keysAt() };
  await sleep(1200);
  out.sent = { look: lookNow(loop), sends: sends().length };
}

/**
 * A double click on Reviewer → Builder's dot near the window's foot (the popover flips up over it): the second click
 * lands in the popover and presses nothing; then a click on its Send as soon as it would count.
 */
async function dblAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const start = env.calls.length;
  const sends = () => env.calls.slice(start).filter((c) => c.fn === "wiresSend").length;
  // the view panned so the dot is 50 px above the landscape's foot
  const v = document.querySelector(".ls-viewport")!.getBoundingClientRect();
  const was = dotMid(W("loop"));
  await drive([{ wheel: { x: Math.round(v.left + v.width / 2), y: Math.round(v.top + v.height / 2), dy: was.y - (v.bottom - 50) } }]);
  await sleep(800);
  const at = dotMid(W("loop"));
  await drive([{ mouse: { ...at, clickCount: 1 } }, { mouse: { ...at, clickCount: 2 } }]);
  const p = popNow();
  out.dbl = { dot: at, pop: p, under: document.elementFromPoint(at.x, at.y)?.closest(".wg-pop") ? "popover" : "landscape", sends: sends() };
  await sleep(600);
  await clickAt(mid(popButton("Send")));
  await sleep(2200);
  out.after = { sends: sends(), pop: popNow(), keys: keysAt() };
}

/**
 * Keys (at 100%): Builder's terminal typed in, its dot clicked and Tab, Tab, Enter in the same burst (nothing pressed,
 * nothing written there, a word on why); after a pause Tab, Tab, Enter sending it; the keyboard on the landscape after.
 */
async function gateKeysAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const start = env.calls.length;
  const since = (fn: string) => env.calls.slice(start).filter((c) => c.fn === fn).map((c) => c.args);
  const loop = W("loop");
  const dot = dotMid(loop);
  await clickAt(mid(node(W("builder"))?.querySelector(".ls-term")));
  await sleep(300);
  out.before = keysAt();
  await drive([{ key: "q" }, { mouse: { ...dot, clickCount: 1 } }, { key: "Tab" }, { key: "Tab" }, { key: "Enter" }, { key: " " }]);
  await sleep(300);
  out.burst = { pop: popNow(), sends: since("wiresSend").length, writes: since("sessionWrite").length };
  await sleep(1200);
  await drive([{ key: "Tab" }, { key: "Tab" }]);
  const onSend = document.activeElement?.textContent ?? null;
  await drive([{ key: "Enter" }]);
  await sleep(1500);
  out.paused = { onSend, sends: since("wiresSend"), pop: popNow(), keys: keysAt(), writes: since("sessionWrite").length };
  // Esc closes it: the keyboard goes back to the landscape, not to Builder's terminal, which had it before
  await clickAt(mid(node(W("builder"))?.querySelector(".ls-term")));
  await sleep(1200);
  await clickAt(dotMid(W("held")));
  await sleep(300);
  const opened = keysAt();
  await drive([{ key: "Escape" }]);
  await sleep(300);
  out.esc = { opened, pop: !!popEl(), keys: keysAt() };
}

/**
 * The other faces (with ?lsGates): a ready handoff to a ghost (Send reopens it, its cost asked first), what may have
 * arrived (Mark sent), a merge that can't be read (Check now, Mark merged… and its confirm), a blocked wire's settings
 * (When its PR merges, edits saved); with =limit, a feedback loop at its limit (One more round, then Send under it).
 */
async function gatesAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const start = env.calls.length;
  const since = (fn: string) => env.calls.slice(start).filter((c) => c.fn === fn).map((c) => c.args);
  const fns = (mark: number) => env.calls.slice(mark).map((c) => c.fn).filter((f) => /^wires|^pipeline|^resumeCost/.test(f) && f !== "wiresGet");
  if (new URLSearchParams(location.search).get("lsGates") === "limit") {
    await clickAt(dotMid(W("loop")));
    await sleep(700);
    const opened = popNow();
    // Send, where it came up, clicked as soon as the driver can: it presses what's asked every 250 ms, so with nothing
    // waited for in between, this lands about 250 ms after One more round's click (one more wait, and it's 500)
    await clickAt(mid(popButton("One more round")));
    await clickAt(mid(popButton("Send")));
    out.limit = { opened, under: popNow(), moreRounds: since("wiresMoreRounds"), sends: since("wiresSend").length };
    return;
  }
  // a ready handoff to Spike, closed: Send asks main, which says it's stopped; its cost is asked; then sent, starting it
  let mark = env.calls.length;
  await clickAt(dotMid(W("ghost")));
  await sleep(700);
  const ghost = popNow();
  await clickAt(mid(popButton("Send")));
  await sleep(3800);
  out.closed = { opened: ghost, calls: fns(mark), sends: since("wiresSend"), pop: popNow() };
  // what may have arrived: Mark sent
  mark = env.calls.length;
  await clickAt(dotMid(W("sending")));
  await sleep(700);
  const unconfirmed = popNow();
  await clickAt(mid(popButton("Mark sent")));
  await sleep(500);
  out.unconfirmed = { opened: unconfirmed, calls: fns(mark), marked: since("wiresMarkSent"), pop: popNow(), look: lookNow(W("sending")) };
  // a merge that can't be read: Check now; Mark merged…, its confirm clicked as it comes up (let go), then once settled
  mark = env.calls.length;
  await clickAt(dotMid(W("sent")));
  await sleep(700);
  const merge = popNow();
  await clickAt(mid(popButton("Check now")));
  await sleep(500);
  const checked = popNow();
  // Mark merged…, its confirm read off and cancelled; then Mark merged… and its confirm in one go, 150 ms apart (let go)
  await clickAt(mid(popButton("Mark merged…")));
  const asked = popNow();
  const confirmAt = mid(popButton("Mark merged"));
  await clickAt(mid(popButton("Cancel")));
  await sleep(700);
  await drive([{ mouse: { ...mid(popButton("Mark merged…")), clickCount: 1 } }, { pause: 150 }, { mouse: { ...confirmAt, clickCount: 1 } }]);
  const early = { marked: since("pipelinePrMarkMerged").length, pop: popNow() };
  await sleep(700);
  await clickAt(mid(popButton("Mark merged")));
  await sleep(600);
  out.merge = { opened: merge, checked, asked, early, calls: fns(mark), check: since("pipelinePrCheck"), marked: since("pipelinePrMarkMerged"), after: popNow(), look: lookNow(W("sent")) };
  await clickAt(mid(popButton("Not yet")));
  await sleep(400);
  // a blocked wire's face is its settings: a click on When its PR merges as it opens is let go; then it, and a chip, saved as made
  await clickAt(dotMid(W("held")));
  await clickAt(mid(popButton("When its PR merges")));
  const asOpened = { set: since("wiresSet").length, when: popNow()?.when ?? null };
  await sleep(700);
  const held = popNow();
  await clickAt(mid(popButton("When its PR merges")));
  await sleep(400);
  await clickAt(mid(popButton("add diff")));
  await sleep(400);
  out.held = { early: asOpened, opened: held, set: since("wiresSet"), after: popNow() };
}

/** Where the keyboard is: the popover itself, else the text of what has it. */
const focusNow = () => (document.activeElement === popEl() ? "popover" : (document.activeElement?.textContent ?? document.activeElement?.tagName ?? null));
/** Tab on to the popover's Send (at most six stops): what has the keyboard then. */
async function tabToSend(): Promise<string | null> {
  for (let i = 0; i < 6 && document.activeElement?.textContent !== "Send"; i++) await drive([{ key: "Tab" }]);
  return focusNow();
}
const costDialog = () => document.querySelector<HTMLElement>(".cost-dlg");
const costButton = (label: string) => [...(costDialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === label) ?? null;

/**
 * Keys after what's shown moved (at 100%): Send reached by keys after a pause, Reviewer finishing again just before
 * Enter (the keyboard leaves Send, and Enter sends nothing); Send reached again, and what waits sent from elsewhere (its
 * face goes to its settings, Send with it): the keyboard stays in the popover.
 */
async function refocusAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const start = env.calls.length;
  const sends = () => env.calls.slice(start).filter((c) => c.fn === "wiresSend").length;
  const loop = W("loop");
  await clickAt(dotMid(loop));
  await sleep(1300);
  const onSend = await tabToSend();
  env.finish?.(loop, "1. NEWER: not read yet.");
  await sleep(60);
  const moved = focusNow();
  await drive([{ key: "Enter" }]);
  await sleep(1600);
  const newer = { onSend, moved, sends: sends(), pop: popNow() };
  const again = await tabToSend();
  env.sent?.(loop);
  await sleep(400);
  out.refocus = { newer, gone: { again, focus: focusNow(), pop: popNow() } };
}

/**
 * Keys as content moves (?lsGates=limit): One more round by keys after a pause, then Tab Tab Enter at once onto the Send
 * that came up under it (held, nothing sent); after a pause, Send by keys sends.
 */
async function limitKeysAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const start = env.calls.length;
  const since = (fn: string) => env.calls.slice(start).filter((c) => c.fn === fn).map((c) => c.args);
  await clickAt(dotMid(W("loop")));
  await sleep(1300);
  await drive([{ key: "Tab" }]);
  const onMore = focusNow();
  await drive([{ key: "Enter" }, { pause: 150 }, { key: "Tab" }, { key: "Tab" }, { key: "Enter" }]);
  const burst = { sends: since("wiresSend").length, moreRounds: since("wiresMoreRounds").length, focus: focusNow(), pop: popNow() };
  await sleep(1300);
  const onSend = await tabToSend();
  await drive([{ key: "Enter" }]);
  await sleep(2000);
  out.limitkeys = { onMore, burst, onSend, sends: since("wiresSend").length, pop: popNow() };
}

/** A key in Builder's terminal after a pause; its dot clicked, then Shift alone, Tab, Tab and Enter, all in one burst. */
async function shiftAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const start = env.calls.length;
  const since = (fn: string) => env.calls.slice(start).filter((c) => c.fn === fn).length;
  await clickAt(mid(node(W("builder"))?.querySelector(".ls-term")));
  await sleep(1300);
  await drive([{ key: "q" }, { mouse: { ...dotMid(W("loop")), clickCount: 1 } }, { key: "Shift" }, { key: "Tab" }, { key: "Tab" }, { key: "Enter" }]);
  await sleep(1800);
  out.shift = { sends: since("wiresSend"), writes: since("sessionWrite"), pop: popNow() };
}

/**
 * The cost question (with ?lsGates&lsBigResume=wb-spike): Send to Spike, closed, by Enter after a pause; once the question
 * is up, Enter held (a repeat) presses nothing in it; Esc answers it, and the popover says nothing was sent.
 */
async function costRepeatAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const start = env.calls.length;
  const since = (fn: string) => env.calls.slice(start).filter((c) => c.fn === fn).map((c) => c.args);
  await clickAt(dotMid(W("ghost")));
  await sleep(1300);
  const onSend = await tabToSend();
  await drive([{ key: "Enter" }]);
  await sleep(2600);
  const asked = { dialog: !!costDialog(), focus: document.activeElement?.textContent ?? null };
  await drive([{ key: "Enter", repeat: true }]);
  await sleep(1000);
  const held = { dialog: !!costDialog(), hint: costDialog()?.querySelector(".cost-hint")?.textContent ?? null, sends: since("wiresSend").length };
  await drive([{ key: "Escape" }]);
  await sleep(600);
  out.costrepeat = { onSend, asked, held, sends: since("wiresSend"), resumeCost: since("resumeCost").length, dialog: !!costDialog(), pop: popNow() };
}

/**
 * Send to Spike by the pointer (?lsGates&lsBigResume=wb-spike): the popover stays while its cost is asked; Fixtures
 * finishes again meanwhile; Continue sends the earlier one, which main refuses, and the popover says so.
 */
async function costLostAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const start = env.calls.length;
  const since = (fn: string) => env.calls.slice(start).filter((c) => c.fn === fn).map((c) => c.args);
  await clickAt(dotMid(W("ghost")));
  await sleep(1300);
  await clickAt(mid(popButton("Send")));
  await sleep(2600);
  const asked = { dialog: !!costDialog(), pop: !!popEl() };
  env.finish?.(W("ghost"), "Newer fixtures: 41k donors.");
  await sleep(300);
  await clickAt(mid(costButton("Continue")));
  await sleep(600);
  const answered = { dialog: !!costDialog(), pop: popNow() };
  await sleep(2400);
  out.costlost = { asked, answered, sends: since("wiresSend"), pop: popNow(), note: noteNow() };
}

/**
 * Send to Spike by the pointer (?lsGates&lsBigResume=wb-spike), Continue; Fixtures finishes again, so main will refuse it;
 * Reviewer → Tester's dot clicked meanwhile (Spike's popover closes, Tester's opens): when the refusal comes, it's said
 * in the note, and Tester's popover stays.
 */
async function closeOtherAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const start = env.calls.length;
  const since = (fn: string) => env.calls.slice(start).filter((c) => c.fn === fn).map((c) => c.args);
  await clickAt(dotMid(W("ghost")));
  await sleep(1300);
  await clickAt(mid(popButton("Send")));
  await sleep(2600);
  await clickAt(mid(costButton("Continue")));
  await sleep(100);
  env.finish?.(W("ghost"), "Newer fixtures: 41k donors.");
  await sleep(100);
  await clickAt(dotMid(W("held")));
  await sleep(200);
  const opened = popNow()?.ends ?? null;
  await sleep(2600);
  out.closeother = { opened, after: popNow()?.ends ?? null, sends: since("wiresSend"), note: noteNow() };
}

/**
 * Add next step (W8; with ?lsPlanned, at 100%): Tester's not-started card and its right-click's menu; Shape's handle
 * dragged into the empty canvas under 5120 (a window tall enough to show some), the step placed where it was let go;
 * Reviewer's handle clicked straight after a key typed into Builder's terminal, with a key straight after it opened (the
 * same burst) and a click there at once, neither taken; the step named, set to work in Reviewer's folder and added; Dev
 * server's handle clicked, refused and said; and Tester started from its menu.
 */
async function stepAudit(env: WiresAuditEnv, out: Record<string, unknown>): Promise<void> {
  const since = (mark: number, fn: string) => env.calls.slice(mark).filter((c) => c.fn === fn).map((c) => c.args);
  const ghostOf = (id: string) => document.querySelector<HTMLElement>(`.ls-world .ls-ghost[data-front="${CSS.escape(id)}"]`);
  const steps = () => [...document.querySelectorAll<HTMLElement>(".ls-world .ls-ghost.planned")].map((g) => g.dataset.front!);
  const dialog = () => document.querySelector<HTMLElement>(".modal.ns-step:not(.mb-ghost)");
  const nameField = () => dialog()?.querySelector<HTMLInputElement>(".ns-sec input[type=text]") ?? null;
  const works = () => [...(dialog()?.querySelectorAll<HTMLButtonElement>(".ns-works button") ?? [])];
  const cardOf = (el: HTMLElement | null) =>
    el && {
      rows: [...el.querySelectorAll<HTMLElement>("[data-row]")].map((r) => r.dataset.row),
      buttons: el.querySelectorAll(".lg-acts button").length,
      line: el.querySelector(".lg-line")?.textContent ?? null,
      status: el.querySelector(".lg-status")?.textContent ?? null,
    };
  const linkInto = async (id: string) => {
    const r = await window.mb.wiresGet();
    const links = "book" in r && r.book ? r.book.links : {};
    return Object.values(links).filter((w) => w.to === id).map((w) => [w.from, w.type]);
  };
  // Tester, not started: its card, and its right-click's menu
  const tester = ghostOf(W("tester"));
  out.card = cardOf(tester);
  await drive([{ mouse: { ...mid(tester?.querySelector(".lg-line")), clickCount: 1, button: "right" } }]);
  await sleep(300);
  out.cardMenu = menuNow();
  await drive([{ key: "Escape" }]);
  await sleep(300);
  // Shape's handle dragged into the empty canvas under 5120 (before a step placed in 5120 grows it): the step goes in no
  // area, where it was let go
  let mark = env.calls.length;
  const area = document.querySelector<HTMLElement>(`.ls-world .ls-area[data-area="${WIRE_AREA}"]`)!.getBoundingClientRect();
  const drop = { x: Math.round(node(W("dev"))!.getBoundingClientRect().left), y: Math.round(area.bottom + 64) };
  const space = !document.elementFromPoint(drop.x, drop.y)?.closest(".ls-node, .ls-ghost, .ls-area, button");
  await dragWire(mid(handleOf("shape")), drop);
  await sleep(300);
  const dropped = { dialog: !!dialog(), head: dialog()?.querySelector(".ns-head")?.textContent?.replace(/\s+/g, " ").trim() ?? null, picker: pickerNow() };
  if (!dropped.dialog) return void (out.dropped = { space, drop, ...dropped, under: document.elementFromPoint(drop.x, drop.y)?.className.toString() ?? null, note: noteNow() });
  await sleep(700);
  const before2 = new Set(steps());
  await drive([{ mouse: { ...mid(nameField()), clickCount: 1 } }, { key: "d" }, { key: "o" }, { key: "c" }, { key: "s" }]);
  await drive([{ mouse: { ...mid(dialog()?.querySelector("button.primary.cta")), clickCount: 1 } }]);
  await sleep(800);
  const placed = steps().find((id) => !before2.has(id)) ?? null;
  const at = placed ? ghostOf(placed)!.getBoundingClientRect() : null;
  out.dropped = { space, drop, ...dropped, plan: since(mark, "planSession"), made: placed, at: at && { x: Math.round(at.left), y: Math.round(at.top) }, area: placed ? ghostOf(placed)!.dataset.area : null, card: cardOf(placed ? ghostOf(placed) : null), wires: placed ? await linkInto(placed) : [] };
  // Shape finishes: its handoff into that step is ready, its popover (W4c) saying sending starts it, and Send starts it
  // with no cost asked, then sends
  if (placed) {
    await sleep(600);
    mark = env.calls.length;
    const r = await window.mb.wiresGet();
    const into = Object.entries("book" in r && r.book ? r.book.links : {}).find(([, w]) => w.to === placed)?.[0];
    if (!into) return void (out.stepSend = { wire: null });
    env.finish?.(into, "The export streams now: test it against 40k donors.");
    await sleep(400);
    await clickAt(dotMid(into));
    const opened = popNow();
    await sleep(700);
    await clickAt(mid(popButton("Send")));
    await sleep(2800);
    const after = await window.mb.wiresGet();
    const w = "book" in after && after.book ? after.book.links[into] : undefined;
    out.stepSend = {
      opened,
      sends: since(mark, "wiresSend").map((a) => [a[2], a[3] ?? null]),
      cost: since(mark, "resumeCost").length,
      pop: !!popEl(),
      ghost: !!ghostOf(placed),
      node: !!node(placed),
      delivery: w?.delivery?.state ?? null,
    };
  }
  // Reviewer's handle clicked in a burst of keys typed into Builder's terminal: the key after it opened isn't taken, nor
  // a click straight after
  await sleep(600);
  await drive([{ mouse: { ...mid(node(W("builder"))?.querySelector(".ls-term")), clickCount: 1 } }]);
  await sleep(1100);
  mark = env.calls.length;
  await drive([{ key: "q" }, { mouse: { ...mid(handleOf("reviewer")), clickCount: 1 } }, { key: "x" }]);
  const opened = {
    dialog: !!dialog(),
    head: dialog()?.querySelector(".ns-head")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
    name: nameField()?.value ?? null,
    focused: !!nameField() && document.activeElement === nameField(),
    works: works().map((b) => b.textContent),
  };
  await drive([{ mouse: { ...mid(works()[1]), clickCount: 1 } }]);
  const early = { on: works().findIndex((b) => b.classList.contains("on")), dialog: !!dialog() };
  out.burst = { opened, early, writes: since(mark, "sessionWrite").map((a) => a[0]) };
  // once it has settled: Reviewer's folder, a name, and Add step
  await sleep(700);
  await drive([{ mouse: { ...mid(works()[1]), clickCount: 1 } }]);
  await drive([{ mouse: { ...mid(nameField()), clickCount: 1 } }, { key: "q" }, { key: "a" }]);
  const before = new Set(steps());
  const filled = { on: works().findIndex((b) => b.classList.contains("on")), name: nameField()?.value ?? null, note: dialog()?.querySelector(".ns-works")?.closest(".ns-sec")?.querySelector(".ns-note")?.textContent ?? null };
  await drive([{ mouse: { ...mid(dialog()?.querySelector("button.primary.cta")), clickCount: 1 } }]);
  await sleep(800);
  const made = steps().find((id) => !before.has(id)) ?? null;
  out.added = { filled, plan: since(mark, "planSession"), dialog: !!dialog(), made, card: cardOf(made ? ghostOf(made) : null), wires: made ? await linkInto(made) : [], note: noteNow() };
  // a double click on Reviewer's handle: the dialog its first click opened stays for its second, on the backdrop; a click
  // there once it has settled closes it
  await sleep(600);
  const RH = mid(handleOf("reviewer"));
  await drive([{ mouse: { ...RH, clickCount: 1 } }, { mouse: { ...RH, clickCount: 2 } }]);
  await sleep(200);
  const dbl = { dialog: !!dialog(), under: document.elementFromPoint(RH.x, RH.y)?.className.toString() ?? null };
  await sleep(600);
  await drive([{ mouse: { ...RH, clickCount: 1 } }]);
  await sleep(300);
  out.double = { ...dbl, closed: !dialog() };
  // Dev server's handle: a terminal, which no step can follow
  await sleep(600);
  mark = env.calls.length;
  await drive([{ mouse: { ...mid(handleOf("dev")), clickCount: 1 } }]);
  await sleep(300);
  out.terminal = { dialog: !!dialog(), note: noteNow(), plan: since(mark, "planSession") };
  // Tester's ⋯ by the keyboard with its Enter held, as the keyboard repeats it: the menu opens, and the repeats run
  // nothing in it, nor ask anything
  const confirm = () => document.querySelector<HTMLElement>(".modal.start-step:not(.mb-ghost)");
  const confirmButton = (label: string) => [...(confirm()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === label) ?? null;
  await sleep(600);
  mark = env.calls.length;
  ghostOf(W("tester"))?.querySelector<HTMLElement>("button.ls-more")?.focus();
  const repeats: Asked[] = Array.from({ length: 12 }, (): Asked[] => [{ key: "Enter", hold: "down", repeat: true }, { pause: 35 }]).flat();
  await drive([{ key: "Enter", hold: "down" }, { pause: 350 }, ...repeats, { key: "Enter", hold: "up" }]);
  await sleep(300);
  out.held = { menu: menuNow(), row: document.activeElement?.closest(".mb-ctx") ? (document.activeElement.textContent ?? null) : null, confirm: !!confirm(), asked: since(mark, "describeStart").length, start: since(mark, "startPlanned").length };
  await drive([{ key: "Escape" }]);
  // Start now… from its right-click: a confirm saying where it starts, which takes no click straight after it opens
  await sleep(1100);
  mark = env.calls.length;
  await drive([{ mouse: { ...mid(ghostOf(W("tester"))?.querySelector(".lg-line")), clickCount: 1, button: "right" } }]);
  await sleep(300);
  await drive([{ mouse: { ...mid(menuRow("Start now…")), clickCount: 1 } }]);
  const asked = { open: !!confirm(), head: confirm()?.querySelector("h3")?.textContent ?? null, says: confirm()?.querySelector(".sub-h")?.textContent ?? null, off: confirmButton("Start now")?.disabled ?? null };
  await drive([{ mouse: { ...mid(confirmButton("Start now")), clickCount: 1 } }]);
  out.confirm = { ...asked, early: { open: !!confirm(), start: since(mark, "startPlanned").length } };
  // Enter, pressed for it once it has settled: started, a workspace in its card's place
  await sleep(700);
  await drive([{ key: "Enter" }]);
  await sleep(1200);
  out.started = { asked: since(mark, "describeStart"), start: since(mark, "startPlanned"), confirm: !!confirm(), ghost: !!ghostOf(W("tester")), node: !!document.querySelector(`.ls-world .ls-node[data-front="${W("tester")}"]`) };
}

/** The picker or a wire's settings left open, for a screenshot beside its board (synthetic events: no driver there). */
async function showAudit(part: string): Promise<void> {
  if (part === "pop") {
    // the send popover of ?pop=<wire> (wb- left off), opened by a click on its dot; &popConfirm asks Mark merged…
    const q = new URLSearchParams(location.search);
    const at = dotMid(W(q.get("pop") ?? "loop"));
    const init = { bubbles: true, cancelable: true, pointerId: 41, button: 0, buttons: 1, clientX: at.x, clientY: at.y };
    document.elementFromPoint(at.x, at.y)?.dispatchEvent(new PointerEvent("pointerdown", init));
    window.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
    if (!q.has("popConfirm")) return;
    await sleep(600);
    popButton("Mark merged…")?.click();
    return;
  }
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
      const shot = part === "pick" || part === "settings" || part === "pop";
      await sleep(shot ? 300 : 1200);
      out.zoom = zoomNow();
      if (shot) {
        await showAudit(part);
        out.shown = { picker: pickerNow(), settings: !!document.querySelector(".wr-pop:not(.mb-ghost)"), pop: popNow(), note: noteNow() };
      }
      if (part === "make") await makeAudit(env, out);
      else if (part === "keys") await keysAudit(env, out);
      else if (part === "menus") await menusAudit(env, out);
      else if (part === "fresh") await freshAudit(env, out);
      else if (part === "double") await doubleAudit(env, out);
      else if (part === "guards") await guardsAudit(env, out);
      else if (part === "lost") await lostAudit(env, out);
      else if (part === "step") await stepAudit(env, out);
      // which of 5120's workspaces carry a handle at this zoom: those big enough on screen for one
      else if (part === "handles") out.handles = ["shape", "builder", "reviewer", "dev", "tester", "fixtures"].filter((k) => !!handleOf(k));
      else if (part === "send") await sendAudit(env, out);
      else if (part === "dbl") await dblAudit(env, out);
      else if (part === "gatekeys") await gateKeysAudit(env, out);
      else if (part === "gates") await gatesAudit(env, out);
      else if (part === "refocus") await refocusAudit(env, out);
      else if (part === "limitkeys") await limitKeysAudit(env, out);
      else if (part === "shift") await shiftAudit(env, out);
      else if (part === "costrepeat") await costRepeatAudit(env, out);
      else if (part === "costlost") await costLostAudit(env, out);
      else if (part === "closeother") await closeOtherAudit(env, out);
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
