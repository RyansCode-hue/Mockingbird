import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEscape } from "./useEscape";
import { usePresence } from "./motion";
import { useLiftOut } from "./lift";

/**
 * A dialog over the app. A click on the backdrop, or Esc, closes it; without
 * `onClose` neither does (an update installing), and `closeOnBackdrop={false}`
 * keeps a stray click from losing a multi-step dialog. It takes focus when
 * nothing in it asked for focus, so keys reach it rather than a terminal
 * behind it, and gives focus back to what had it when it closes. It eases in;
 * closing is immediate, with the exit played on a static copy (motion.ts).
 * Opened from inside the landscape's scaled world, it's drawn on the body
 * (lift.ts).
 */
export function Modal({
  className = "modal",
  onClose,
  closeOnBackdrop = true,
  onKeyDown,
  children,
}: {
  /** The dialog box's classes ("modal close-dlg"). */
  className?: string;
  onClose?: () => void;
  closeOnBackdrop?: boolean;
  /** Keys pressed anywhere in the dialog (a ⌘↵ shortcut for its main action). */
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const opener = useRef(document.activeElement);
  const presence = usePresence<HTMLDivElement>("dialog");
  const lift = useLiftOut();
  useEscape(() => onClose?.());
  useEffect(() => {
    if (box.current && !box.current.contains(document.activeElement)) box.current.focus({ preventScroll: true });
    const back = opener.current;
    return () => {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost && back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
  }, []);
  const dialog = (
    <div ref={presence} className="modal-back" onMouseDown={closeOnBackdrop ? () => onClose?.() : undefined}>
      <div
        ref={box}
        className={className}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
        // a portal's events still reach its React parents: a press in a lifted dialog isn't a press on the landscape
        onPointerDown={lift ? (e) => e.stopPropagation() : undefined}
        onContextMenu={lift ? (e) => e.stopPropagation() : undefined}
      >
        {children}
      </div>
    </div>
  );
  return lift ? createPortal(dialog, document.body) : dialog;
}
