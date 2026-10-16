import { useEffect, useRef, type ReactNode } from "react";
import { useEscape } from "./useEscape";
import { usePresence } from "./motion";

/**
 * A popover anchored by its wrapper's CSS (`className` places it): a click
 * anywhere outside it, or Escape, closes it. With a `label` it's a dialog:
 * named for screen readers and focused when it opens, so the keyboard starts
 * inside it.
 */
export function Popover({ className, onClose, children, label }: { className: string; onClose: () => void; children: ReactNode; label?: string }) {
  useEscape(onClose);
  const box = useRef<HTMLDivElement | null>(null);
  const presence = usePresence<HTMLDivElement>("menu", { also: box });
  useEffect(() => {
    if (label) box.current?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      <div className="who-back" onMouseDown={onClose} />
      <div ref={presence} className={className} {...(label ? { role: "dialog", "aria-label": label, tabIndex: -1 } : {})}>
        {children}
      </div>
    </>
  );
}
