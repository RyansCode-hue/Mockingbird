import React, { useEffect, useRef } from "react";

/**
 * A popover anchored by its wrapper's CSS (`className` places it): a click
 * anywhere outside it, or Escape, closes it.
 */
export function Popover({ className, onClose, children }: { className: string; onClose: () => void; children: React.ReactNode }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  return (
    <>
      <div className="who-back" onMouseDown={onClose} />
      <div className={className}>{children}</div>
    </>
  );
}
