import { useEffect, useRef } from "react";

/**
 * Esc closes a dialog wherever focus is: one opened from ⌘K has nothing
 * inside it focused. A control that handles Esc itself (an open dropdown)
 * stops the key before it reaches the window.
 */
export function useEscape(onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
