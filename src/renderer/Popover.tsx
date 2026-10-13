import type { ReactNode } from "react";
import { useEscape } from "./useEscape";
import { usePresence } from "./motion";

/**
 * A popover anchored by its wrapper's CSS (`className` places it): a click
 * anywhere outside it, or Escape, closes it.
 */
export function Popover({ className, onClose, children }: { className: string; onClose: () => void; children: ReactNode }) {
  useEscape(onClose);
  const presence = usePresence<HTMLDivElement>("menu");
  return (
    <>
      <div className="who-back" onMouseDown={onClose} />
      <div ref={presence} className={className}>
        {children}
      </div>
    </>
  );
}
