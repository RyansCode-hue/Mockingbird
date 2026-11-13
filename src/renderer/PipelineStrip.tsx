import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, type MutableRefObject, type RefObject } from "react";
import type { SessionInfo } from "../shared/types";
import { gateOf } from "../shared/wires";
import { usePersisted } from "./prefs";
import { isArmed, keyboardNowhere } from "./keyArm";
import { OVERLAYS, ownsKeys } from "./keys";
import { StatusDot } from "./StatusDot";
import { ChevronIcon } from "./Icons";
import { menuHeading, useContextMenu } from "./ContextMenu";
import { ANSWER_GUARD_MS, keyClick, useHeldOff, useSettledRows } from "./answerGuard";
import type { ResolvedLayout } from "./landscapeModel";
import { useWires } from "./WireLayer";
import { gateContextOf, type WireRoom } from "./wiresModel";
import { chainOf, noStepNote, stepEnds, stepNote, type Chain, type Hop, type Step, type StripSessions } from "./pipelineChain";

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

/** A move along the chain to workspace `id`: its terminal given the keyboard, or the keyboard left on focus's frame, where the next ⌥ arrow is taken. */
export type StripGo = (id: string, keys: "terminal" | "frame") => void;

/** How wide the chain's fades are (styles.css, .ls-strip-chain): a step under one isn't wholly in view. */
const FADE = 28;

/** A chain wider than the strip fades at the side(s) with more of it out of sight. */
function edges(c: HTMLElement): void {
  const more = c.scrollWidth - c.clientWidth;
  c.classList.toggle("more-l", more > 1 && c.scrollLeft > 1);
  c.classList.toggle("more-r", more > 1 && c.scrollLeft < more - 1);
}

/**
 * The chain scrolled as little as it takes to show this workspace's step and both its neighbours whole, clear of the
 * fades; where the three don't fit, this one and the next (⌥→'s), then this one and the one before; else this one in
 * the middle. By hand: scrollIntoView would scroll the landscape's viewport too.
 */
function keepInView(c: HTMLElement): void {
  const steps = [...c.querySelectorAll<HTMLElement>(".ls-step")];
  const i = steps.findIndex((el) => el.classList.contains("here"));
  if (i < 0) return;
  const box = c.getBoundingClientRect();
  const x = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { l: r.left - box.left + c.scrollLeft, r: r.right - box.left + c.scrollLeft };
  };
  const max = c.scrollWidth - c.clientWidth;
  const here = steps[i];
  const [before, next] = [steps[i - 1] ?? here, steps[i + 1] ?? here];
  for (const [from, to] of [
    [before, next],
    [here, next],
    [before, here],
  ]) {
    // at either end there's no fade on that side, so scrolled all the way the end's step shows whole
    const lo = Math.min(max, x(to).r + FADE - c.clientWidth);
    const hi = Math.max(0, x(from).l - FADE);
    if (lo > hi) continue;
    c.scrollLeft = Math.round(Math.min(Math.max(c.scrollLeft, lo, 0), hi, max));
    return;
  }
  const me = x(here);
  c.scrollLeft = Math.round(Math.max(0, Math.min(max, (me.l + me.r - c.clientWidth) / 2)));
}

export function usePipelineStrip({
  here,
  layout,
  rooms,
  closed,
  frame,
  onGo,
  say,
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
  /** The landscape's one-line note: an arrow with nothing that way says so. */
  say: (text: string) => void;
}): { height: number; strip: React.ReactNode } {
  const state = useWires().state;
  const [folded, setFolded] = usePersisted(STRIP_FOLDED_PREF, false);
  const sessions = useMemo<StripSessions>(
    () => ({ open: layout.tiles.flatMap((t) => t.members), ghosts: [...layout.tiles.flatMap((t) => t.closed ?? []), ...layout.ghosts.flatMap((g) => g.members)], closed }),
    [layout, closed]
  );
  const chain = useMemo(() => {
    const gates = here && state ? gateContextOf(layout, state, rooms, closed) : null;
    return here && gates ? chainOf(here.id, gates.links, stepEnds(sessions), (id, w) => gateOf(id, w, gates)) : null;
  }, [here?.id, state, layout, rooms, closed, sessions]);
  const now = useRef({ chain, onGo, say, read: !!state?.book });
  now.current = { chain, onGo, say, read: !!state?.book };
  /** Until when a click on the strip is a double click's second, or aimed before the move it follows (answerGuard.ts). */
  const guard = useRef(0);
  const move = useCallback<StripGo>((id, keys) => {
    guard.current = Date.now() + ANSWER_GUARD_MS;
    now.current.onGo(id, keys);
  }, []);
  const onFold = useCallback(() => setFolded((f) => !f), [setFolded]);

  // ⌥← ⌥→ on focus's frame, armed by the user; ⌘⌥← ⌘⌥→ from anywhere in focus, taken before a terminal sees them.
  // A plain ⌥ arrow typed in a terminal is the terminal's (a word left or right), and a disarmed frame swallows it.
  useEffect(() => {
    if (!here) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const f = frame.current;
      if (!f || document.querySelector(OVERLAYS)) return;
      const a = document.activeElement;
      if (e.metaKey ? !(f.contains(a) || keyboardNowhere()) : !isArmed(f)) return;
      e.preventDefault();
      e.stopPropagation();
      // held, an arrow moves once: its repeats would walk on, each step's terminal taking the keyboard in turn
      if (e.repeat) return;
      const { chain, say, read } = now.current;
      const back = e.key === "ArrowLeft";
      if (!chain) return say(read ? "No wires reach this workspace: there's no pipeline to move along" : "The wires can't be read, so there's no pipeline to move along");
      const to = back ? chain.up[chain.up.length - 1] : chain.down[0];
      if (!to) return say(noStepNote(chain, back));
      move(to.id, a !== f && f.contains(a) && ownsKeys(a) ? "terminal" : "frame");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [here?.id]);

  if (!here || !chain) return { height: 0, strip: null };
  return { height: folded ? STRIP_FOLDED_H : STRIP_H, strip: <StripView chain={chain} folded={folded} onFold={onFold} move={move} guard={guard} /> };
}

/**
 * Each step's, and each attached workspace's, place on the strip, for the settle check: where it is on screen, keyed by
 * where a click on it goes, so one going to the same workspace from the same place after a move counts as settled.
 */
const PICKS = "[data-pick]";
const pickKey = (el: HTMLElement) => el.dataset.pick;
const onScreen = (el: HTMLElement) => Math.round(el.getBoundingClientRect().left);

/** The strip as drawn: rendered again only when its chain or fold changes, or it scrolls or resizes. */
const StripView = memo(function StripView({
  chain,
  folded,
  onFold,
  move,
  guard,
}: {
  chain: Chain;
  folded: boolean;
  onFold: () => void;
  move: StripGo;
  guard: MutableRefObject<number>;
}) {
  const ctx = useContextMenu("Pipeline");
  const root = useRef<HTMLDivElement>(null);
  const chainEl = useRef<HTMLDivElement>(null);
  // a scroll or a resize moves the steps under a resting pointer: drawn again, so the settle check sees them move
  const [, moved] = useReducer((n: number) => n + 1, 0);
  const { up, here: me, down, attached } = chain;
  // before the settle check records where each step is, so a step it scrolls counts as moved
  useLayoutEffect(() => void (chainEl.current && keepInView(chainEl.current)), [me.id, folded]);
  useLayoutEffect(() => void (chainEl.current && edges(chainEl.current)), [chain, folded]);
  useEffect(() => {
    const c = chainEl.current;
    if (!c) return;
    const watch = new ResizeObserver(() => {
      keepInView(c);
      edges(c);
      moved();
    });
    watch.observe(c);
    return () => watch.disconnect();
  }, [folded]);
  const settled = useSettledRows(root, PICKS, pickKey, onScreen);
  const { holdOff, heldOff } = useHeldOff();
  /**
   * A click on a step or an attached workspace goes there, its terminal given the keyboard. A key's always does; a
   * pointer's only when aimed at what's there now (answerGuard.ts): not a double click's second, not on a step that
   * just moved under the pointer, nor straight after a move, when the chain is laid out again around the next step.
   */
  const pick = (e: React.MouseEvent, key: string, id: string) => {
    if (keyClick(e)) return move(id, "terminal");
    if (e.detail > 1) return;
    const wait = Math.max(guard.current - Date.now(), settled(key));
    if (wait > 0) return holdOff(key, wait);
    move(id, "terminal");
  };
  /**
   * A press on this workspace's own step while its terminal is being typed in leaves the keyboard there, as one on its
   * header does: a double click's second, landing on the step its first moved to, doesn't take it from the terminal.
   */
  const keepTyping = (e: React.MouseEvent) => {
    const a = document.activeElement;
    if (a?.closest(".xterm") && e.currentTarget.closest(".ls-focus")?.contains(a)) e.preventDefault();
  };

  const toggle = (
    <button
      type="button"
      className="ls-strip-toggle"
      aria-expanded={!folded}
      data-tip={folded ? "Show the pipeline strip" : "Fold the pipeline strip away (⌥← ⌥→ still move along it)"}
      onClick={onFold}
    >
      <ChevronIcon open={!folded} />
      Pipeline
    </button>
  );
  const stepEl = (s: Step, side: "up" | "here" | "down", kbd: string | null) => {
    const n = stepNote(s, side);
    const title = s.end?.title ?? "A workspace that's gone";
    const inner = (
      <>
        {n.tone === "done" ? <span className="ls-step-ok">✓</span> : s.end?.where === "open" ? <StatusDot status={s.end.status} /> : <span className="dot idle" />}
        <span className="ls-step-text">
          <span className="ls-step-t">{title}</span>
          <span className="ls-step-n">{n.text}</span>
        </span>
        {kbd && <span className="ls-step-k">{kbd}</span>}
      </>
    );
    if (side === "here")
      return (
        <div key={s.id} className="ls-step here" data-step={s.id} aria-current="step" onMouseDown={keepTyping}>
          {inner}
        </div>
      );
    const key = `s:${s.id}`;
    return (
      <button
        key={s.id}
        type="button"
        className={`ls-step ${n.tone}`}
        data-step={s.id}
        data-pick={key}
        data-tip={n.why ? `${title}: ${n.why}` : `Go to ${title}`}
        disabled={heldOff(key)}
        onClick={(e) => pick(e, key, s.id)}
      >
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
                  onPick: () => move(a.id, "terminal"),
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
  return (
    <div ref={root} className={`ls-strip${folded ? " folded" : ""}`} role="navigation" aria-label="Pipeline">
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
          <div
            ref={chainEl}
            className="ls-strip-chain"
            onScroll={(e) => {
              edges(e.currentTarget);
              moved();
            }}
          >
            {parts}
          </div>
          {attached.length > 0 && (
            <div className="ls-strip-attached">
              <span className="ls-strip-label">Attached</span>
              {attached.map((a) => {
                const key = `a:${a.id}`;
                return (
                  <button
                    key={a.wire}
                    type="button"
                    className={`ls-attach ${a.type}`}
                    data-step={a.id}
                    data-pick={key}
                    data-tip={a.type === "worktree" ? "A terminal in this workspace's folder: go to it" : a.reads ? "This workspace reads its context: go to it" : "It reads this workspace's context: go to it"}
                    disabled={heldOff(key)}
                    onClick={(e) => pick(e, key, a.id)}
                  >
                    {a.type === "worktree" && (a.end?.where === "open" ? <StatusDot status={a.end.status} /> : <span className="dot idle" />)}
                    <span className="ls-attach-t">{a.end?.title ?? "A workspace that's gone"}</span>
                    {a.type === "context" && <span className="ls-attach-s">{"·\u00a0context"}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
      {ctx.menu}
    </div>
  );
});
