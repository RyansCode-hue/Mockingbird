import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { OVER_TOUR, ownsKeys } from "./keys";
import { useDialogFocus } from "./Modal";
import { fromKeyboard, usePresence } from "./motion";
import { ringAround, tourCardAt, tourNext, type Box, type TourStep, type TourTarget } from "./landscapeFirstRun";
import type { Camera } from "../shared/landscape";

/** How far the ring stands off an area or a workspace, and off a button, in px. */
const RING_PAD = { world: 8, chrome: 4 };
/** How far inside what it's in (the view, or the window) the ring stays, so all of its outline shows. */
const RING_INSET = 2;

const inset = (b: Box, by: number): Box => ({ x: b.x + by, y: b.y + by, w: b.w - 2 * by, h: b.h - 2 * by });

/** Keys closer together than this are typing. */
const TYPING_MS = 1000;

/** What `selector` matches on screen, as one box; null when none of it is. */
function chromeBox(selector: string): Box | null {
  const rects = [...document.querySelectorAll(selector)].map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
  if (!rects.length) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  return { x: left, y: top, w: Math.max(...rects.map((r) => r.right)) - left, h: Math.max(...rects.map((r) => r.bottom)) - top };
}

/**
 * The migration tour (design G): a card over the app and a ring around the real thing each step is about, everything
 * else dimmed. The ring is a hole in the dim, so what it shows is live, and it follows the camera without a render, as
 * the selection bar does. It sits under dialogs and the palette, which can open over it and give the keyboard back.
 *
 * It holds the keyboard while it's up, so nothing typed can reach a terminal behind it: Tab stays in the card, a press
 * on the dim keeps it there, and focus sent elsewhere comes back. When it closes, the keyboard goes back to what had it
 * (useDialogFocus), or `onClosed` finds it a home when that has gone. Esc skips it.
 *
 * Come up as someone is typing (in a terminal or a field, or any key a moment before), it doesn't take what they type:
 * the card itself has the keyboard, with no button to press, and Tab, Enter, Space and Esc do nothing until the keys
 * have stopped for a second.
 */
export function LandscapeTour({
  steps,
  at,
  worldBox,
  listeners,
  onNext,
  onSkip,
  onClosed,
}: {
  steps: readonly TourStep[];
  /** The step shown. */
  at: number;
  /** An area's or a workspace's box in the window as the camera has it now, and the view's, which it's kept inside. */
  worldBox: (t: Exclude<TourTarget, { kind: "chrome" }>) => { box: Box; within: Box } | null;
  listeners: Set<(cam: Camera) => void>;
  onNext: () => void;
  onSkip: () => void;
  onClosed: () => void;
}) {
  useDialogFocus();
  // read as it renders, while what had the keyboard still has it
  const typing = useRef(ownsKeys(document.activeElement) || fromKeyboard() ? performance.now() + TYPING_MS : 0);
  /** Keys still coming as they were when it came up: each one keeps it so for another second. */
  const stillTyping = () => {
    if (performance.now() >= typing.current) return false;
    typing.current = performance.now() + TYPING_MS;
    return true;
  };
  const step = steps[at];
  const last = at === steps.length - 1;
  const ring = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement | null>(null);
  const presence = usePresence<HTMLDivElement>("menu", { also: card });
  const primary = useRef<HTMLButtonElement>(null);
  const now = useRef({ target: step.target, worldBox, onSkip, onClosed });
  now.current = { target: step.target, worldBox, onSkip, onClosed };

  const place = () => {
    const c = card.current;
    const r = ring.current;
    if (!c || !r) return;
    const { target, worldBox: world } = now.current;
    const view = { w: window.innerWidth, h: window.innerHeight };
    const whole: Box = { x: 0, y: 0, ...view };
    const found = target.kind === "chrome" ? ((b) => b && { box: b, within: whole })(chromeBox(target.selector)) : world(target);
    const box = found && ringAround(found.box, target.kind === "chrome" ? RING_PAD.chrome : RING_PAD.world, inset(found.within, RING_INSET));
    r.hidden = !box;
    if (box) Object.assign(r.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
    const under = (document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0) + 8;
    const p = tourCardAt(box, { w: c.offsetWidth, h: c.offsetHeight }, view, under);
    Object.assign(c.style, { left: `${p.x}px`, top: `${p.y}px` });
  };
  const placeNow = useRef(place);
  placeNow.current = place;
  useLayoutEffect(place);
  useEffect(() => {
    const follow = () => placeNow.current();
    listeners.add(follow);
    window.addEventListener("resize", follow);
    const ro = new ResizeObserver(follow);
    if (card.current) ro.observe(card.current);
    return () => {
      listeners.delete(follow);
      window.removeEventListener("resize", follow);
      ro.disconnect();
    };
  }, [listeners]);

  useEffect(() => {
    (typing.current ? card : primary).current?.focus({ preventScroll: true });
    // the card, never a button: an Enter or a Space on the way would press it
    const back = (e: FocusEvent) => {
      if (card.current?.contains(e.target as Node) || document.querySelector(OVER_TOUR)) return;
      card.current?.focus({ preventScroll: true });
    };
    // on the window, so it holds however the keyboard came to be nowhere (a dialog over the tour that closed with it)
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(OVER_TOUR)) return;
      if (e.target === document.body) card.current?.focus({ preventScroll: true });
      if (stillTyping()) {
        if (e.key === "Escape") e.preventDefault();
      } else if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        now.current.onSkip();
      }
    };
    document.addEventListener("focusin", back);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("focusin", back);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  // after useDialogFocus's cleanup, so it's told where the keyboard ended up
  useEffect(() => () => now.current.onClosed(), []);

  const next = tourNext(steps, at);
  return createPortal(
    <div
      className="ls-tour-back"
      onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div ref={ring} className={`ls-tour-ring ${step.target.kind === "chrome" ? "chrome" : ""}`} aria-hidden="true" />
      <div
        ref={presence}
        className="ls-tour-card"
        data-step={step.id}
        role="dialog"
        aria-modal="true"
        aria-label="Landscape tour"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (stillTyping()) {
            if (e.key === "Tab" || e.key === "Enter" || e.key === " ") e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (e.key !== "Tab") return;
          e.preventDefault();
          const list = [...e.currentTarget.querySelectorAll("button")];
          const i = list.indexOf(document.activeElement as HTMLButtonElement);
          list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length]?.focus({ preventScroll: true });
        }}
      >
        <div className="ls-tour-top">
          <span className="ls-tour-count">
            {at + 1} of {steps.length}
          </span>
          <span className="ls-tour-pips" aria-hidden="true">
            {steps.map((s, i) => (
              <span key={s.id} className={i === at ? "on" : ""} />
            ))}
          </span>
        </div>
        <div aria-live="polite">
          <div className="ls-tour-title">{step.title}</div>
          <div className="ls-tour-body">{step.body}</div>
          {next && <div className="ls-tour-next">{next}</div>}
        </div>
        <div className="ls-tour-acts">
          <button ref={primary} type="button" className="primary" data-act="next" onClick={onNext}>
            {last ? "Done" : "Next"}
          </button>
          {!last && (
            <button type="button" className="outline" data-act="skip" onClick={onSkip}>
              Skip the tour
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
