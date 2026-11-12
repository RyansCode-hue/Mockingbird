import React, { forwardRef, memo, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { isErr } from "../shared/types";
import type { Camera, Rect } from "../shared/landscape";
import type { WireState } from "../shared/wires";
import { createIpcStore } from "./ipcStore";
import { GHOST_INSET, type Band, type Point } from "./landscapeModel";
import { pillBox, shiftedBox, translateOf, wireCurve, wireNear, type WireAnchor, type WireCurve, type WireLook, type WireView } from "./wiresModel";

/** The wire book as main last said it (wires:get, then wires:changed), and why it couldn't be read when it couldn't. */
export interface WiresRead {
  state: WireState | null;
  error: string | null;
}

/** Asks main for the wires again (wires:get): at the start, and from the banner's Read it again. */
let readWires = () => {};
const wires = createIpcStore<WiresRead>({ state: null, error: null }, ({ get, set }) => {
  // a reply older than a change already here is dropped: wiresRev counts the book's changes. One with the same is main
  // saying again what only it can tell (merges, folders) as that moves
  const take = (s: WireState) => {
    const now = get().state;
    if (now && s.wiresRev < now.wiresRev) return;
    set({ state: { book: s.book, refused: s.refused, wiresRev: s.wiresRev, problems: s.problems, ...(s.merges ? { merges: s.merges } : {}), ...(s.folders ? { folders: s.folders } : {}) }, error: null });
  };
  const failed = (error: string) => {
    console.error(`Couldn't read the wires: ${error}`);
    if (!get().state) set({ state: null, error });
  };
  window.mb.onWiresChanged((c: WireState) => take(c));
  readWires = () =>
    void Promise.resolve(window.mb.wiresGet()).then(
      (r) => (isErr(r) ? failed(r.error) : take(r)),
      (err: unknown) => failed(err instanceof Error ? err.message : String(err))
    );
  readWires();
});

/** The wire book, kept current. */
export const useWires = (): WiresRead => wires.use();
/** The wire book as it is now, for what reads it once (Tidy), not on every change. */
export const wiresNow = (): WiresRead => wires.get();
/** Read the wires again, as the banner's Read it again does. */
export const rereadWires = (): void => readWires();

/** The arrowhead each look ends in: its colour's. */
const MARK: Record<WireLook, string> = { idle: "idle", ready: "amber", sending: "amber", sent: "green", blocked: "red", context: "idle", tree: "idle" };
const MARKS = ["idle", "amber", "green", "red"];

export interface WireLayerHandle {
  /** Draw the wires again where their ends are now: a workspace being dragged (its `translate`) or let go. */
  follow: () => void;
  /** The wire whose line runs within `within` of landscape point `p`, as last drawn: what a right-click there is on (W4b). */
  wireAt: (p: Point, within: number) => string | null;
}

/**
 * The landscape's wires (docs/landscape-wires.md, W4a): one SVG in the world, over the areas and under the workspaces,
 * and their labels beside it, kept at screen size by --ls-inv (Landscape's paintScale). React draws what each wire is;
 * where it runs is written straight to the elements, as the guides are: when the layout changes, when the zoom does
 * (a card's inset and a pill's size are a few screen px), and as a dragged workspace moves (`follow`), never through a
 * render. Nothing here takes a pointer or the keyboard: a right-click on a wire is found from where it was last drawn (`wireAt`).
 */
export const WireLayer = memo(forwardRef<WireLayerHandle, { views: WireView[]; band: Band; cam: React.MutableRefObject<Camera>; listeners: Set<(c: Camera) => void> }>(function WireLayer(
  { views, band, cam, listeners },
  ref
) {
  const svg = useRef<SVGSVGElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const now = useRef({ views, band });
  now.current = { views, band };
  /** Each wire's curve as last painted, for `wireAt`: the layer itself takes no pointer. */
  const curves = useRef(new Map<string, WireCurve>());

  const paint = () => {
    const s = svg.current;
    const lb = labels.current;
    const world = s?.parentElement;
    if (!s || !lb || !world) return;
    const zoom = cam.current.zoom;
    const px = 1 / zoom;
    // zoomed out to cards, workspaces and ghosts are drawn a few screen px in from their places (styles.css --ci)
    const inset = now.current.band === "cards" ? GHOST_INSET * px : 0;
    // a drag moves a workspace by its `translate` until the layout has it where it was let go; its `dragging` class is
    // no sign of one, as a render of the workspace (its selection) sets its class names again
    const moved = new Map<string, Point>();
    for (const el of world.querySelectorAll<HTMLElement>(".ls-node[data-ws][style*='translate']")) {
      const by = translateOf(el.style.translate);
      if (by && el.dataset.ws) moved.set(el.dataset.ws, by);
    }
    // the pills' sizes, read before anything is written, so a frame lays out once
    const pills = new Map<string, { w: number; h: number } | null>();
    for (const v of now.current.views)
      for (const a of [v.from, v.to])
        if (a.kind === "pill" && !pills.has(a.key)) {
          const el = world.querySelector<HTMLElement>(`.ls-area-pill[data-area="${CSS.escape(a.key)}"]`);
          pills.set(a.key, el ? { w: el.offsetWidth, h: el.offsetHeight } : null);
        }
    const box = (a: WireAnchor): Rect =>
      a.kind === "pill" ? pillBox(a.rect, pills.get(a.key) ?? null, zoom) : shiftedBox(a.rect, a.kind === "tile" ? moved.get(a.key) : undefined, inset);
    const texts = new Map<string, HTMLElement[]>();
    for (const el of lb.querySelectorAll<HTMLElement>("[data-wire]")) texts.set(el.dataset.wire!, [...(texts.get(el.dataset.wire!) ?? []), el]);
    const groups = new Map<string, SVGGElement>();
    for (const g of s.querySelectorAll<SVGGElement>(":scope > g.ls-wire")) groups.set(g.dataset.wire!, g);
    curves.current.clear();
    for (const v of now.current.views) {
      const g = groups.get(v.id);
      if (!g) continue;
      const c = wireCurve(box(v.from), box(v.to), px);
      g.style.display = c ? "" : "none";
      for (const t of texts.get(v.id) ?? []) t.style.display = c ? "" : "none";
      if (!c) continue;
      curves.current.set(v.id, c);
      for (const p of g.querySelectorAll("path")) p.setAttribute("d", c.d);
      const dot = g.querySelector("circle");
      if (dot) {
        dot.setAttribute("cx", String(c.mid.x));
        dot.setAttribute("cy", String(c.mid.y));
      }
      for (const t of texts.get(v.id) ?? []) {
        const end = t.dataset.end;
        const at = end === "from" ? c.from : end === "to" ? c.to : c.mid;
        t.style.left = `${at.x}px`;
        t.style.top = `${at.y}px`;
        if (end) t.dataset.side = end === "from" ? c.fromSide : c.toSide;
        else t.dataset.bend = c.bend;
      }
    }
  };
  const paintNow = useRef(paint);
  paintNow.current = paint;
  useImperativeHandle(ref, () => ({ follow: () => paintNow.current(), wireAt: (p, within) => wireNear(curves.current, p, within) }), []);
  useLayoutEffect(() => paint());
  useEffect(() => {
    let zoom = cam.current.zoom;
    const l = (c: Camera) => {
      if (c.zoom === zoom) return;
      zoom = c.zoom;
      paintNow.current();
    };
    listeners.add(l);
    return () => void listeners.delete(l);
  }, [listeners]);

  const inv = { ["--ls-inv" as string]: 1 / cam.current.zoom } as React.CSSProperties;
  return (
    <>
      <svg ref={svg} className="ls-wires" width="1" height="1" style={inv} aria-hidden="true">
        <defs>
          {MARKS.map((m) => (
            <marker key={m} id={`ls-wa-${m}`} className={`ls-wm m-${m}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M2 1L8 5L2 9" />
            </marker>
          ))}
        </defs>
        {views.map((v) => (
          <g key={v.id} className={`ls-wire lk-${v.look}`} data-wire={v.id} data-type={v.type}>
            {v.look === "ready" && <path className="glow" />}
            <path className="line" markerEnd={v.arrow ? `url(#ls-wa-${MARK[v.look]})` : undefined} />
            {v.dot && <circle className={`dot ${v.dot}`} />}
          </g>
        ))}
      </svg>
      <div ref={labels} className="ls-wire-labels" style={inv} aria-hidden="true">
        {views.map((v) => (
          <React.Fragment key={v.id}>
            {v.label && (
              <span className={`ls-wire-label t-${v.label.tone}`} data-wire={v.id}>
                {v.label.text}
              </span>
            )}
            {v.from.tab && (
              <span className="ls-wire-tab" data-wire={v.id} data-end="from">
                {v.from.tab}
              </span>
            )}
            {v.to.tab && (
              <span className="ls-wire-tab" data-wire={v.id} data-end="to">
                {v.to.tab}
              </span>
            )}
          </React.Fragment>
        ))}
      </div>
    </>
  );
}));
