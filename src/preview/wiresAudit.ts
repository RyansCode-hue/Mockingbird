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
 * - =area (zoomed out to cards): 5120 dragged by its name, the wires lifted with its patch and on its workspaces;
 * - =pill (with ?lsCollapsed=5102): the wire to Pathways ending at 5102's pill.
 */
import type { Area, Landscape, Rect } from "../shared/landscape";
import type { SessionInfo } from "../shared/types";
import { newWire, type Wire, type WireBook } from "../shared/wires";

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
      await sleep(1200);
      out.zoom = zoomNow();
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
        // 5120 dragged by its name zoomed out to cards: its patch is lifted, and the wires with it, on its workspaces
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
