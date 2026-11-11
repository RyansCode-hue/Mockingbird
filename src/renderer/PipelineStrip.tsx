import React, { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { SessionInfo } from "../shared/types";
import { gateOf } from "../shared/wires";
import { usePersisted } from "./prefs";
import { isArmed, keyboardNowhere } from "./keyArm";
import { OVERLAYS, ownsKeys } from "./keys";
import { StatusDot } from "./StatusDot";
import { ChevronIcon } from "./Icons";
import { menuHeading, useContextMenu } from "./ContextMenu";
import type { ResolvedLayout } from "./landscapeModel";
import { useWires } from "./WireLayer";
import { gateContextOf, type WireRoom } from "./wiresModel";
import { chainOf, stepEnds, stepNote, type Hop, type Step, type StripSessions } from "./pipelineChain";

/**
 * The pipeline strip (docs/landscape.md, Focus): over a focused workspace that has wires, the chain of steps through it
 * (pipelineChain.ts), each with its status; a click on one, or ⌥← ⌥→, moves along it. Attached workspaces sit at its
 * right end. Folded, it's a thin bar until it's opened again, remembered across launches. The workspace under it
 * reflows: its pty loses the strip's height in rows. The book and each wire's gate are the drawn wires' (WireLayer's
 * store, wiresModel's gateContextOf), so the strip and the wires never disagree; a book that can't be read shows no
 * strip, and the landscape's banner says why.
 */

/** The strip's height open, and folded: what comes off the focused workspace. */
export const STRIP_H = 64;
export const STRIP_FOLDED_H = 28;
export const STRIP_FOLDED_PREF = "mb.pipelineStrip.folded";

/**
 * Where a move along the chain goes: workspace `id` (null: there's nothing that way, `dir` says which), its terminal
 * given the keyboard (`terminal`) or the keyboard left on focus's frame, where the next ⌥ arrow is taken.
 */
export type StripGo = (id: string | null, dir: "back" | "on", keys: "terminal" | "frame") => void;

/** A chain wider than the strip fades at the side(s) with more of it out of sight. */
function edges(c: HTMLElement): void {
  const more = c.scrollWidth - c.clientWidth;
  c.classList.toggle("more-l", more > 1 && c.scrollLeft > 1);
  c.classList.toggle("more-r", more > 1 && c.scrollLeft < more - 1);
}

export function usePipelineStrip({
  here,
  layout,
  rooms,
  closed,
  frame,
  onGo,
}: {
  /** The focused workspace's session, while one of this Mac's is in focus. */
  here: SessionInfo | null;
  layout: ResolvedLayout;
  /** The team rooms and the areas they're shared as, for the wires' gates (wiresModel). */
  rooms: readonly WireRoom[] | undefined;
  /** Closed sessions with no place: a step can be one. */
  closed: readonly SessionInfo[];
  /** Focus's frame: plain ⌥ arrows act only while it has the keyboard, armed by the user (keyArm.ts). */
  frame: RefObject<HTMLElement | null>;
  onGo: StripGo;
}): { height: number; strip: React.ReactNode } {
  const state = useWires().state;
  const [folded, setFolded] = usePersisted(STRIP_FOLDED_PREF, false);
  const ctx = useContextMenu("Pipeline");
  const sessions = useMemo<StripSessions>(
    () => ({ open: layout.tiles.flatMap((t) => t.members), ghosts: [...layout.tiles.flatMap((t) => t.closed ?? []), ...layout.ghosts.flatMap((g) => g.members)], closed }),
    [layout, closed]
  );
  const chain = useMemo(() => {
    const gates = here && state ? gateContextOf(layout, state, rooms, closed) : null;
    return here && gates ? chainOf(here.id, gates.links, stepEnds(sessions), (id, w) => gateOf(id, w, gates)) : null;
  }, [here?.id, state, layout, rooms, closed, sessions]);
  const now = useRef({ chain, onGo });
  now.current = { chain, onGo };
  // a chain wider than the strip scrolls; this workspace's step is kept in the middle of what shows
  const chainEl = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // by hand: scrollIntoView would scroll the landscape's viewport too
    const c = chainEl.current;
    const h = c?.querySelector(".ls-step.here")?.getBoundingClientRect();
    if (!c || !h) return;
    const r = c.getBoundingClientRect();
    c.scrollLeft += h.left + h.width / 2 - (r.left + r.width / 2);
  }, [here?.id, folded, !chain]);
  useLayoutEffect(() => void (chainEl.current && edges(chainEl.current)));

  // ⌥← ⌥→ on focus's frame, armed by the user; ⌘⌥← ⌘⌥→ from anywhere in focus, taken before a terminal sees them.
  // A plain ⌥ arrow typed in a terminal is the terminal's (a word left or right), and a disarmed frame swallows it.
  useEffect(() => {
    if (!here) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const { chain, onGo } = now.current;
      const f = frame.current;
      if (!chain || !f || document.querySelector(OVERLAYS)) return;
      const a = document.activeElement;
      if (e.metaKey ? !(f.contains(a) || keyboardNowhere()) : !isArmed(f)) return;
      e.preventDefault();
      e.stopPropagation();
      const back = e.key === "ArrowLeft";
      const to = back ? chain.up[chain.up.length - 1] : chain.down[0];
      onGo(to?.id ?? null, back ? "back" : "on", a !== f && f.contains(a) && ownsKeys(a) ? "terminal" : "frame");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [here?.id]);

  if (!here || !chain) return { height: 0, strip: null };
  const height = folded ? STRIP_FOLDED_H : STRIP_H;
  const toggle = (
    <button
      type="button"
      className="ls-strip-toggle"
      aria-expanded={!folded}
      data-tip={folded ? "Show the pipeline strip" : "Fold the pipeline strip away (⌥← ⌥→ still move along it)"}
      onClick={() => setFolded(!folded)}
    >
      <ChevronIcon open={!folded} />
      Pipeline
    </button>
  );
  const go = (id: string) => onGo(id, "on", "terminal");
  const stepEl = (s: Step, side: "up" | "here" | "down", key: string | null) => {
    const n = stepNote(s, side);
    const title = s.end?.title ?? "A workspace that's gone";
    const inner = (
      <>
        {n.tone === "done" ? <span className="ls-step-ok">✓</span> : s.end?.where === "open" ? <StatusDot status={s.end.status} /> : <span className="dot idle" />}
        <span className="ls-step-text">
          <span className="ls-step-t">{title}</span>
          <span className="ls-step-n">{n.text}</span>
        </span>
        {key && <span className="ls-step-k">{key}</span>}
      </>
    );
    if (side === "here")
      return (
        <div key={s.id} className="ls-step here" data-step={s.id} aria-current="step">
          {inner}
        </div>
      );
    return (
      <button key={s.id} type="button" className={`ls-step ${n.tone}`} data-step={s.id} data-tip={n.why ? `${title}: ${n.why}` : `Go to ${title}`} onClick={() => go(s.id)}>
        {inner}
      </button>
    );
  };
  /** The wire between two steps, coloured by its gate, with a +n chip naming the other workspaces the walk could take there. */
  const arrow = (side: "up" | "down", hop: Hop | null, also: Step[], heading: string, foot: string, k: string) => {
    const gate = hop?.gate.state ?? "idle";
    return (
      <span key={k} className={`ls-strip-arrow ${gate}`} data-wire={hop?.wire}>
        <svg width={also.length ? 60 : 38} height="20" aria-hidden="true">
          <path className="line" d={also.length ? "M2 10 C 21 10, 36 10, 56 10" : "M2 10 C 14 10, 22 10, 34 10"} />
          <path d={also.length ? "M52 6 L57 10 L52 14" : "M30 6 L35 10 L30 14"} />
        </svg>
        {also.length > 0 && (
          <button
            type="button"
            className="ls-strip-more"
            aria-haspopup="menu"
            data-tip={`${heading}: ${foot}`}
            onClick={(e) =>
              ctx.openBelow(e.currentTarget, [
                menuHeading(heading),
                ...also.map((a) => ({
                  key: a.id,
                  label: a.end?.title ?? "A workspace that's gone",
                  icon: a.end?.where === "open" ? <StatusDot status={a.end.status} /> : <span className="dot idle" />,
                  kbd: stepNote(a, side).text,
                  onPick: () => go(a.id),
                })),
                menuHeading(foot),
              ])
            }
          >
            +{also.length}
          </button>
        )}
      </span>
    );
  };
  const { up, here: me, down, attached } = chain;
  const titleAt = (i: number) => [...up, me, ...down][i]?.end?.title ?? "it";
  const parts = [
    ...up.flatMap((s, i) => [
      stepEl(s, "up", i === up.length - 1 ? "⌥←" : null),
      arrow("up", s.hop, s.also, `Also into ${titleAt(i + 1)}`, i === up.length - 1 ? `⌥← takes ${titleAt(i)}; click for one of these` : "Click for one of these", `a:${s.id}`),
    ]),
    stepEl(me, "here", null),
    ...down.flatMap((s, i) => [
      arrow("down", s.hop, s.also, `Also from ${titleAt(up.length + i)}`, i === 0 ? `⌥→ takes ${titleAt(up.length + 1)}; click for one of these` : "Click for one of these", `a:${s.id}`),
      stepEl(s, "down", i === 0 ? "⌥→" : null),
    ]),
  ];
  return {
    height,
    strip: (
      <div className={`ls-strip${folded ? " folded" : ""}`} role="navigation" aria-label="Pipeline">
        {toggle}
        {folded ? (
          <span className="ls-strip-sum">
            {[...up, me, ...down].map((s, i) => (
              <React.Fragment key={s.id}>
                {i > 0 && " › "}
                <span className={s === me ? "here" : ""}>{s.end?.title ?? "gone"}</span>
              </React.Fragment>
            ))}
          </span>
        ) : (
          <>
            <div ref={chainEl} className="ls-strip-chain" onScroll={(e) => edges(e.currentTarget)}>
              {parts}
            </div>
            {attached.length > 0 && (
              <div className="ls-strip-attached">
                <span className="ls-strip-label">Attached</span>
                {attached.map((a) => (
                  <button
                    key={a.wire}
                    type="button"
                    className={`ls-attach ${a.type}`}
                    data-step={a.id}
                    data-tip={a.type === "worktree" ? "A terminal in this workspace's folder: go to it" : a.reads ? "This workspace reads its context: go to it" : "It reads this workspace's context: go to it"}
                    onClick={() => go(a.id)}
                  >
                    {a.type === "worktree" && (a.end?.where === "open" ? <StatusDot status={a.end.status} /> : <span className="dot idle" />)}
                    <span className="ls-attach-t">{a.end?.title ?? "A workspace that's gone"}</span>
                    {a.type === "context" && " · context"}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {ctx.menu}
      </div>
    ),
  };
}
