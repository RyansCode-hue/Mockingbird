import { useLayoutEffect, useRef } from "react";
import type { SessionInfo } from "../shared/types";
import { D, EASE, play } from "./motion";

/** A state held this long before a change counts as a real one, so working ↔ idle flapping doesn't flicker. */
export const SETTLED_MS = 300;

/** Whether a status change gets the waiting emphasis: only arriving at waiting, from a state that had settled. */
export function popsOnChange(prev: SessionInfo["status"], next: SessionInfo["status"], heldMs: number): boolean {
  return next === "waiting" && prev !== "waiting" && heldMs >= SETTLED_MS;
}

/**
 * A session's status dot. Arriving at waiting (a session now needs you) pops it once; nothing else animates,
 * and nothing does on a re-render or a tick. The pulse after that is CSS, and stops after ~10 s.
 */
export function StatusDot({ status, className = "" }: { status: SessionInfo["status"]; className?: string }) {
  const el = useRef<HTMLSpanElement>(null);
  const prev = useRef({ status, since: performance.now() });
  useLayoutEffect(() => {
    const p = prev.current;
    if (p.status === status) return;
    const now = performance.now();
    prev.current = { status, since: now };
    if (el.current && popsOnChange(p.status, status, now - p.since))
      play(el.current, [{ transform: "none" }, { transform: "scale(1.5)", offset: 0.3 }, { transform: "none" }], { duration: D.l, easing: EASE.move });
  }, [status]);
  return <span ref={el} className={`dot ${className} ${status}`.replace(/\s+/g, " ")} />;
}
