import { useRef } from "react";
import { rects, type LayoutNode } from "./layoutTree";

const pct = (v: number) => `${v * 100}%`;

/**
 * While a session is dragged over the grid: the layout a drop would leave,
 * one frame per pane, the dragged pane's frame highlighted. Frames are keyed
 * by pane, so moving between drop regions morphs them (a CSS transition)
 * instead of redrawing — on one pane, its right half shrinks the pane to the
 * left half and grows the new one in on the right. The real terminals stay
 * put until the drop, since resizing one makes its CLI redraw. The layer
 * never takes pointer events, so the drag's own events reach the grid below.
 */
export function GridPreview({ on, tree, hot, title }: { on: boolean; tree: LayoutNode | null; hot: string | null; title: (key: string) => string }) {
  // the last layout stays on screen while the layer fades out; each drag starts with fresh frames
  const last = useRef<{ tree: LayoutNode | null; hot: string | null }>({ tree: null, hot: null });
  const drags = useRef({ n: 0, on: false });
  if (on && !drags.current.on) drags.current.n++;
  drags.current.on = on;
  if (on) last.current = { tree, hot };
  const shown = on ? { tree, hot } : last.current;
  return (
    <div key={drags.current.n} className={`grid-preview ${on ? "on" : ""}`} aria-hidden>
      {Object.entries(rects(shown.tree)).map(([key, r]) => (
        <div key={key} className={`gp-frame ${key === shown.hot ? "hot" : ""}`} style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) }}>
          <div className="gp-box">
            <span className="gp-title">{title(key)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
