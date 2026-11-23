import React, { forwardRef, memo, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { isErr } from "../shared/types";
import type { Camera, Rect } from "../shared/landscape";
import type { WireState } from "../shared/wires";
import { createIpcStore } from "./ipcStore";
import type { AnchorBox } from "./Popover";
import { GHOST_INSET, type Band, type Point } from "./landscapeModel";
import { dotPlace, endKey, labelHangs, pillBox, shiftedBox, translateOf, wireCurves, wireNear, type LabelPlace, type WireAnchor, type WireCurve, type WireLook, type WireView } from "./wiresModel";

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
const SVG_NS = "http://www.w3.org/2000/svg";
/** What the lines pass under (a mask holds them out): areas' headers and names, collapsed areas' pills, and ghosts. */
const UNDER = ".ls-area-head, .ls-area-title, .ls-area-pill, .ls-ghost:not(.hidden)";
/** The mask's reach, in landscape px either way from the origin: past any landscape. */
const FAR = 1e6;
/** What a gate dot keeps off besides UNDER, so a click meant for them isn't the dot's: the workspaces (their buttons, tabs and terminals). */
const KEEP_OFF = ".ls-node:not(.hidden)";
/** A gate dot's radius in screen px (styles.css), and a px to spare round it. */
const DOT_R = 8;

export interface WireLayerHandle {
  /** Draw the wires again where their ends are now: a workspace being dragged (its `translate`) or let go. */
  follow: () => void;
  /** The wire whose line runs within `within` of landscape point `p`, as last drawn: what a right-click there is on (W4b). */
  wireAt: (p: Point, within: number) => string | null;
  /** The wire whose gate dot, as drawn (in the live band), is within `within` of landscape point `p`: what a click there opens (W4c). */
  dotAt: (p: Point, within: number) => string | null;
  /**
   * The end of a wire, as last drawn, within `within` of landscape point `p`, at a workspace or a step (not a collapsed
   * area's pill): its arrowhead (`to`) or its start (`from`), what a press there drags to move it. The nearest wins.
   */
  endAt: (p: Point, within: number) => { id: string; end: "from" | "to" } | null;
  /** Where wire `id`'s gate dot is on screen while it's drawn: its foot's middle, where its send popover opens, and its box, which the popover keeps clear of. */
  dotOnScreen: (id: string) => { x: number; y: number; box: AnchorBox } | null;
}

/**
 * The landscape's wires (docs/landscape-wires.md, W4a): one SVG in the world, over the areas and under the workspaces,
 * and their labels and gate dots beside it, over the workspaces, kept at screen size by --ls-inv (Landscape's
 * paintScale). React draws what each wire is; where it runs is written straight to the elements, as the guides are:
 * when the layout changes, when the zoom does (a card's inset and a pill's size are a few screen px), and as a dragged
 * workspace moves (`follow`), never through a render. The lines pass under the areas' headers and names, collapsed
 * areas' pills and ghosts, as under the workspaces: a mask holds those places out, read from where they're drawn as
 * the lines are painted. Nothing here takes the keyboard, and nothing but a gate dot takes a pointer. A dot keeps off
 * what it would take a click from (those places, and the workspaces): it moves along its wire to the nearest clear
 * point, and a wire wholly beneath them has its dot beneath them too. The press is the landscape's, and a right-click
 * on a wire, and a click on its dot, are found from where they were last drawn (`wireAt`, `dotAt`). Each label hangs
 * beside its dot; side-by-side wires' labels go to their outer sides (labelHangs).
 */
export const WireLayer = memo(forwardRef<WireLayerHandle, { views: WireView[]; band: Band; cam: React.MutableRefObject<Camera>; listeners: Set<(c: Camera) => void> }>(function WireLayer(
  { views, band, cam, listeners },
  ref
) {
  const svg = useRef<SVGSVGElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const dots = useRef<SVGSVGElement>(null);
  const now = useRef({ views, band });
  now.current = { views, band };
  /** Each wire's curve as last painted, for `wireAt`: the layer itself takes no pointer. */
  const curves = useRef(new Map<string, WireCurve>());
  /** Where each drawn gate dot was last put (dotPlace), for `dotAt`. */
  const dotsAt = useRef(new Map<string, Point>());

  const paint = () => {
    const s = svg.current;
    const lb = labels.current;
    const ds = dots.current;
    const world = s?.parentElement;
    if (!s || !lb || !ds || !world) return;
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
    // what the lines pass under, where it's drawn, in landscape px: the svg is 1 × 1 at the world's origin
    const origin = s.getBoundingClientRect();
    const under: Rect[] = [];
    if (now.current.views.length)
      for (const el of world.querySelectorAll<HTMLElement>(UNDER)) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height) under.push({ x: (r.left - origin.left) / zoom, y: (r.top - origin.top) / zoom, w: r.width / zoom, h: r.height / zoom });
      }
    // what a dot keeps off, where it's drawn: only in the live band, where dots are
    const keepOff: Rect[] = [];
    if (now.current.band === "live" && now.current.views.some((v) => v.dot)) {
      keepOff.push(...under);
      for (const el of world.querySelectorAll<HTMLElement>(KEEP_OFF)) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height) keepOff.push({ x: (r.left - origin.left) / zoom, y: (r.top - origin.top) / zoom, w: r.width / zoom, h: r.height / zoom });
      }
    }
    const box = (a: WireAnchor): Rect =>
      a.kind === "pill" ? pillBox(a.rect, pills.get(a.key) ?? null, zoom) : shiftedBox(a.rect, a.kind === "tile" ? moved.get(a.key) : undefined, inset);
    const texts = new Map<string, HTMLElement[]>();
    for (const el of lb.querySelectorAll<HTMLElement>("[data-wire]")) texts.set(el.dataset.wire!, [...(texts.get(el.dataset.wire!) ?? []), el]);
    // the mid labels' sizes on screen (scaled by --ls-inv, so a CSS px is a screen px), read before anything is written
    const sizes = new Map<string, { w: number; h: number }>();
    for (const [id, els] of texts) for (const t of els) if (!t.dataset.end) sizes.set(id, { w: t.offsetWidth, h: t.offsetHeight });
    const groups = new Map<string, SVGGElement>();
    for (const g of s.querySelectorAll<SVGGElement>("g.ls-wire")) groups.set(g.dataset.wire!, g);
    const circles = new Map<string, SVGCircleElement>();
    for (const c of ds.querySelectorAll<SVGCircleElement>("circle.dot")) circles.set(c.dataset.wire!, c);
    const holes = s.querySelector<SVGGElement>("mask g.holes");
    if (holes) {
      while (holes.childElementCount > under.length) holes.lastElementChild!.remove();
      while (holes.childElementCount < under.length) holes.appendChild(document.createElementNS(SVG_NS, "rect"));
      under.forEach((r, i) => {
        const h = holes.children[i];
        h.setAttribute("x", String(r.x));
        h.setAttribute("y", String(r.y));
        h.setAttribute("width", String(r.w));
        h.setAttribute("height", String(r.h));
      });
    }
    const runs = wireCurves(
      now.current.views.map((v) => ({ id: v.id, from: endKey(v.from), to: endKey(v.to), a: box(v.from), b: box(v.to) })),
      px
    );
    curves.current.clear();
    dotsAt.current.clear();
    const hangFrom = new Map<string, Point>();
    for (const v of now.current.views) {
      const g = groups.get(v.id);
      if (!g) continue;
      const c = runs.get(v.id) ?? null;
      const dot = circles.get(v.id);
      g.style.display = c ? "" : "none";
      if (dot) dot.style.display = c ? "" : "none";
      for (const t of texts.get(v.id) ?? []) t.style.display = c ? "" : "none";
      if (!c) continue;
      curves.current.set(v.id, c);
      for (const p of g.querySelectorAll("path")) p.setAttribute("d", c.d);
      let at = c.mid;
      if (dot) {
        // off what it would take a click from, along its wire; wholly beneath them, beneath them too
        const placed = dotPlace(c, DOT_R * px, keepOff);
        dot.dataset.fit = placed.fit;
        if (placed.fit === "under") dot.style.display = "none";
        else {
          at = placed.at;
          dotsAt.current.set(v.id, at);
        }
        dot.setAttribute("cx", String(at.x));
        dot.setAttribute("cy", String(at.y));
      }
      hangFrom.set(v.id, at);
      for (const t of texts.get(v.id) ?? []) {
        const end = t.dataset.end;
        if (!end) continue;
        const e = end === "from" ? c.from : c.to;
        t.style.left = `${e.x}px`;
        t.style.top = `${e.y}px`;
        t.dataset.side = end === "from" ? c.fromSide : c.toSide;
      }
    }
    // each mid label beside its dot, those of wires side by side kept off one another and off each other's dots
    const places: LabelPlace[] = [...hangFrom].flatMap(([id, at]) => {
      const c = curves.current.get(id)!;
      const size = sizes.get(id);
      return size ? [{ id, at, bend: c.bend, lane: c.lane, ...size }] : [];
    });
    const hangs = labelHangs(places, px);
    for (const l of places) {
      const h = hangs.get(l.id)!;
      for (const t of texts.get(l.id) ?? []) {
        if (t.dataset.end) continue;
        t.style.left = `${l.at.x + h.shift.x}px`;
        t.style.top = `${l.at.y + h.shift.y}px`;
        t.dataset.bend = l.bend;
        t.dataset.hang = h.hang;
      }
    }
  };
  const paintNow = useRef(paint);
  paintNow.current = paint;
  /** A wire's dot element while it's drawn: none zoomed out of the live band, where the dots are hidden. */
  const dotEl = (id: string): SVGCircleElement | null => {
    if (now.current.band !== "live") return null;
    const c = dots.current?.querySelector<SVGCircleElement>(`circle.dot[data-wire="${CSS.escape(id)}"]`);
    return c && c.style.display !== "none" ? c : null;
  };
  useImperativeHandle(
    ref,
    () => ({
      follow: () => paintNow.current(),
      wireAt: (p, within) => wireNear(curves.current, p, within),
      endAt: (p, within) => {
        let best: { id: string; end: "from" | "to" } | null = null;
        let near = within;
        for (const v of now.current.views) {
          const c = curves.current.get(v.id);
          if (!c) continue;
          for (const end of ["to", "from"] as const) {
            const d = v[end].kind === "pill" ? Infinity : Math.hypot(c[end].x - p.x, c[end].y - p.y);
            if (d <= near) [best, near] = [{ id: v.id, end }, d];
          }
        }
        return best;
      },
      dotAt: (p, within) => {
        let best: string | null = null;
        let near = within;
        for (const v of now.current.views) {
          const at = v.dot ? dotsAt.current.get(v.id) : undefined;
          const d = at ? Math.hypot(at.x - p.x, at.y - p.y) : Infinity;
          if (d <= near && dotEl(v.id)) [best, near] = [v.id, d];
        }
        return best;
      },
      dotOnScreen: (id) => {
        const r = dotEl(id)?.getBoundingClientRect();
        return r && r.width ? { x: r.left + r.width / 2, y: r.bottom, box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } } : null;
      },
    }),
    []
  );
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
          <mask id="ls-wire-under" maskUnits="userSpaceOnUse" x={-FAR} y={-FAR} width={2 * FAR} height={2 * FAR}>
            <rect x={-FAR} y={-FAR} width={2 * FAR} height={2 * FAR} fill="white" />
            <g className="holes" fill="black" />
          </mask>
        </defs>
        <g className="ls-wire-runs" mask="url(#ls-wire-under)">
          {views.map((v) => (
            <g key={v.id} className={`ls-wire lk-${v.look}`} data-wire={v.id} data-type={v.type}>
              {v.look === "ready" && <path className="glow" />}
              <path className="line" markerEnd={v.arrow ? `url(#ls-wa-${MARK[v.look]})` : undefined} />
            </g>
          ))}
        </g>
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
      <svg ref={dots} className="ls-wire-dots" width="1" height="1" style={inv} aria-hidden="true">
        {views.map((v) => v.dot && <circle key={v.id} className={`dot ${v.dot}`} data-wire={v.id} />)}
      </svg>
    </>
  );
}));
