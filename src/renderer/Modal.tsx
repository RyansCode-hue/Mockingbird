import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEscape } from "./useEscape";
import { usePresence } from "./motion";
import { useLiftOut } from "./lift";

/**
 * Said on `document` as a dialog opens, so what floats over the app can get out of its way. `handBack` names who gets
 * the keyboard when the dialog closes, in place of what had it as it opened (which may be leaving with what floated).
 */
export const DIALOG_OPENED = "mb-dialog-opened";
export interface DialogOpened {
  handBack: (to: HTMLElement) => void;
}

/**
 * Where the keyboard goes back to for each thing open over the app (a dialog, the palette, a menu), oldest first: what
 * had it as that opened, then what those before it had. Something opened from a palette row or a menu row has that row
 * as its opener, and the row goes with its palette or menu a moment later: the keyboard goes back past it, to what
 * had it before the palette or the menu opened.
 */
const openers: { chain: readonly Element[] }[] = [];
/** The keyboard's place when nothing that had it is left (the landscape, while it's on screen). */
let home: (() => HTMLElement | null) | null = null;

/** The first of `chain` still in the page, or home. */
function placeFor(chain: readonly Element[]): HTMLElement | null {
  for (const el of chain) if (el instanceof HTMLElement && el.isConnected && el !== document.body) return el;
  return home?.() ?? null;
}

/**
 * While what's open (a menu) has the keyboard, it's where what opens from it goes back past: `back` is what had the
 * keyboard as it opened.
 */
export function useOpener(back: Element | null): void {
  useEffect(() => {
    const entry = { chain: back ? [back] : [] };
    openers.push(entry);
    return () => void openers.splice(openers.indexOf(entry), 1);
  }, [back]);
}

/** `get` is where the keyboard goes when what opened over the app closes and nothing that had it before is left. */
export function useKeyboardHome(get: () => HTMLElement | null): void {
  const now = useRef(get);
  now.current = get;
  useEffect(() => {
    const mine = () => now.current();
    home = mine;
    return () => {
      if (home === mine) home = null;
    };
  }, []);
}

/**
 * What opens over the app: says so (DIALOG_OPENED), and gives focus back to what had it when it closes, if nothing has
 * taken it since; past what has gone, to what had it before (`openers`). Returns where that is now, for passing on.
 */
export function useDialogFocus(): () => HTMLElement | null {
  // read as it renders: the palette or menu it was opened from is still there
  const chain = useRef<Element[] | null>(null);
  if (!chain.current) chain.current = [document.activeElement, ...[...openers].reverse().flatMap((o) => o.chain)].filter((e): e is Element => !!e);
  useEffect(() => {
    const entry = { chain: chain.current! };
    openers.push(entry);
    document.dispatchEvent(
      new CustomEvent<DialogOpened>(DIALOG_OPENED, {
        detail: {
          handBack: (to) => {
            chain.current = [to, ...chain.current!];
            entry.chain = chain.current;
          },
        },
      })
    );
    return () => {
      openers.splice(openers.indexOf(entry), 1);
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost) placeFor(chain.current!)?.focus({ preventScroll: true });
    };
  }, []);
  return () => placeFor(chain.current!);
}

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
  const presence = usePresence<HTMLDivElement>("dialog");
  const lift = useLiftOut();
  useEscape(() => onClose?.());
  useDialogFocus();
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
    // A field with the keyboard swapped out as the dialog fills in (a repo search replaced by the repo it found) would
    // leave the keyboard on the page: it stays with the dialog, so its keys (Esc, ⌘↵) still reach it.
    const out = (e: FocusEvent) => {
      if (e.relatedTarget) return;
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if (el.isConnected && (!a || a === document.body)) el.focus({ preventScroll: true });
      });
    };
    el.addEventListener("focusout", out);
    return () => el.removeEventListener("focusout", out);
  }, []);
  const dialog = (
    // a press on the backdrop doesn't take the keyboard to the page: closing gives it back to what had it
    <div
      ref={presence}
      className="modal-back"
      onMouseDown={(e) => {
        e.preventDefault();
        if (closeOnBackdrop) onClose?.();
      }}
    >
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
