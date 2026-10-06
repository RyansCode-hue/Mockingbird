import { useEffect, useRef, type ReactNode } from "react";
import { useEscape } from "./useEscape";

/**
 * A dialog over the app. A click on the backdrop, or Esc, closes it; without
 * `onClose` neither does (an update installing), and `closeOnBackdrop={false}`
 * keeps a stray click from losing a multi-step dialog. It takes focus when
 * nothing in it asked for focus, so keys reach it rather than a terminal
 * behind it, and gives focus back to what had it when it closes.
 */
export function Modal({
  className = "modal",
  onClose,
  closeOnBackdrop = true,
  children,
}: {
  /** The dialog box's classes ("modal close-dlg"). */
  className?: string;
  onClose?: () => void;
  closeOnBackdrop?: boolean;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const opener = useRef(document.activeElement);
  useEscape(() => onClose?.());
  useEffect(() => {
    if (box.current && !box.current.contains(document.activeElement)) box.current.focus({ preventScroll: true });
    const back = opener.current;
    return () => {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost && back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div className="modal-back" onMouseDown={closeOnBackdrop ? () => onClose?.() : undefined}>
      <div ref={box} className={className} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
