import { useLayoutEffect, useRef } from "react";
import { rects, type LayoutNode } from "./layoutTree";
import { play, springTiming } from "./motion";

const pct = (v: number) => `${v * 100}%`;
type Box = { x: number; y: number; w: number; h: number };

/**
 * While a session is dragged over the grid: the layout a drop would leave,
 * one frame per pane, the dragged pane's frame highlighted. Frames are keyed
 * by pane, so moving between drop regions morphs them instead of redrawing —
 * on one pane, its right half shrinks the pane to the left half and grows the
 * new one in on the right. A frame takes its new place at once and slides
 * there from the old one as a transform (FLIP), its title held unstretched.
 * The real terminals stay put until the drop, since resizing one makes its CLI
 * redraw. The layer never takes pointer events, so the drag's own events reach
 * the grid below.
 */
export function GridPreview({ on, tree, hot, title }: { on: boolean; tree: LayoutNode | null; hot: string | null; title: (key: string) => string }) {
  // the last layout stays on screen while the layer fades out; each drag starts with fresh frames
  const last = useRef<{ tree: LayoutNode | null; hot: string | null }>({ tree: null, hot: null });
  const drags = useRef({ n: 0, on: false });
  if (on && !drags.current.on) drags.current.n++;
  drags.current.on = on;
  if (on) last.current = { tree, hot };
  const shown = on ? { tree, hot } : last.current;
  const layer = useRef<HTMLDivElement>(null);
  // where each frame was drawn last, this drag
  const was = useRef({ n: 0, at: new Map<string, Box>() });
  const placed = rects(shown.tree);

  useLayoutEffect(() => {
    const frames = layer.current?.querySelectorAll<HTMLElement>(".gp-frame") ?? [];
    const now = new Map<string, Box>();
    for (const f of frames) {
      const key = f.dataset.key!;
      const b = { x: f.offsetLeft, y: f.offsetTop, w: f.offsetWidth, h: f.offsetHeight };
      now.set(key, b);
      const a = was.current.n === drags.current.n ? was.current.at.get(key) : undefined;
      if (!a || !b.w || !b.h || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)) continue;
      const sx = a.w / b.w;
      const sy = a.h / b.h;
      play(f, [{ transform: `translate(${a.x - b.x}px, ${a.y - b.y}px) scale(${sx}, ${sy})` }, { transform: "none" }], springTiming());
      const t = f.querySelector(".gp-title");
      if (t) play(t, [{ transform: `scale(${1 / sx}, ${1 / sy})` }, { transform: "none" }], springTiming());
    }
    was.current = { n: drags.current.n, at: now };
  });

  return (
    <div key={drags.current.n} ref={layer} className={`grid-preview ${on ? "on" : ""}`} aria-hidden>
      {Object.entries(placed).map(([key, r]) => (
        <div key={key} data-key={key} className={`gp-frame ${key === shown.hot ? "hot" : ""}`} style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) }}>
          <div className="gp-box">
            <span className="gp-title">{title(key)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
