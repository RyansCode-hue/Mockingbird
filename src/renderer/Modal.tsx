import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEscape } from "./useEscape";
import { usePresence } from "./motion";
import { useLiftOut } from "./lift";
import { armFocus, isArmed, isNowhere, keyboardNowhere, userLeft } from "./keyArm";

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
 * had it before the palette or the menu opened. `armed`: those of them the user had armed (keyArm.ts), armed again
 * when the keyboard goes back to them.
 */
interface Opener {
  chain: readonly Element[];
  armed: ReadonlySet<Element>;
}
const openers: Opener[] = [];
/** The keyboard's place when nothing that had it is left (the landscape, while it's on screen). */
let home: (() => HTMLElement | null) | null = null;

/** The first of `chain` still in the page, or home. */
function placeFor(chain: readonly Element[]): HTMLElement | null {
  for (const el of chain) if (el instanceof HTMLElement && el.isConnected && !isNowhere(el)) return el;
  return home?.() ?? null;
}

/** The keyboard back to `to`: armed again if the user had armed it when what's closing opened from it, and left it. */
export function giveBack(to: HTMLElement, armedThen: ReadonlySet<Element>): void {
  if (armedThen.has(to) && userLeft()) armFocus(to);
  else to.focus({ preventScroll: true });
}

/**
 * What was just picked places the keyboard itself (a jump to a session's terminal): what closes as it's picked gives
 * none back meanwhile, or a key typed straight after would land where the keyboard was. Until the frame after.
 */
let claimed = 0;
export function keyboardMoves(): void {
  const n = ++claimed;
  requestAnimationFrame(() => setTimeout(() => n === claimed && (claimed = 0), 0));
}
export const keyboardClaimed = (): boolean => claimed > 0;

/**
 * While what's open (a menu) has the keyboard, it's where what opens from it goes back past: `back` is what had the
 * keyboard as it opened, `backArmed` whether the user had armed it.
 */
export function useOpener(back: Element | null, backArmed = false): void {
  useEffect(() => {
    const entry: Opener = { chain: back ? [back] : [], armed: new Set(back && backArmed ? [back] : []) };
    openers.push(entry);
    return () => void openers.splice(openers.indexOf(entry), 1);
  }, [back, backArmed]);
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
 * taken it since and what was picked isn't placing it (`keyboardMoves`); past what has gone, to what had it before
 * (`openers`). What the user had armed is armed again (keyArm.ts), unless `rearms` is false: the tour, which comes up
 * on its own. `handsBack` can keep it from giving the keyboard to a place its owner hands back to itself. Returns where
 * the keyboard goes back to now, for passing on.
 */
export function useDialogFocus(opts: { rearms?: boolean; handsBack?: (to: HTMLElement) => boolean } = {}): () => HTMLElement | null {
  // read as it renders: the palette or menu it was opened from is still there
  const chain = useRef<Element[] | null>(null);
  const armedThen = useRef<Set<Element> | null>(null);
  if (!chain.current) {
    const had = document.activeElement;
    chain.current = [had, ...[...openers].reverse().flatMap((o) => o.chain)].filter((e): e is Element => !!e);
    armedThen.current = opts.rearms === false ? new Set() : new Set([...(had && isArmed(had) ? [had] : []), ...openers.flatMap((o) => [...o.armed])]);
  }
  const handsBack = useRef(opts.handsBack);
  handsBack.current = opts.handsBack;
  useEffect(() => {
    const entry: Opener = { chain: chain.current!, armed: armedThen.current! };
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
      if (!keyboardNowhere() || keyboardClaimed()) return;
      const to = placeFor(chain.current!);
      if (to && (handsBack.current?.(to) ?? true)) giveBack(to, entry.armed);
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
        if (el.isConnected && keyboardNowhere()) el.focus({ preventScroll: true });
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
