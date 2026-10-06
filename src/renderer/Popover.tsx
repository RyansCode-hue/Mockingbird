import type { ReactNode } from "react";
import { useEscape } from "./useEscape";

/**
 * A popover anchored by its wrapper's CSS (`className` places it): a click
 * anywhere outside it, or Escape, closes it.
 */
export function Popover({ className, onClose, children }: { className: string; onClose: () => void; children: ReactNode }) {
  useEscape(onClose);
  return (
    <>
      <div className="who-back" onMouseDown={onClose} />
      <div className={className}>{children}</div>
    </>
  );
}
