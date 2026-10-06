import { useEffect, useRef } from "react";

/** The key event as far as Esc handling reads it. */
interface EscapeKey {
  key: string;
  defaultPrevented: boolean;
  preventDefault(): void;
}

/**
 * The layers Esc can close — dialogs, popovers, menus, palettes — in the
 * order they opened. One Esc closes only the newest, so a menu open inside a
 * dialog closes first and the dialog stays. A key something else already
 * handled (the terminal, the code editor's panels, an open dropdown that
 * cancels or stops it) closes nothing.
 */
export function createEscapeStack() {
  const layers: { close: () => void }[] = [];
  return {
    /** Adds a layer on top; the function returned removes it. */
    push(layer: { close: () => void }): () => void {
      layers.push(layer);
      return () => {
        const i = layers.lastIndexOf(layer);
        if (i >= 0) layers.splice(i, 1);
      };
    },
    /** Closes the top layer for an Esc; true when one took the key. */
    press(e: EscapeKey): boolean {
      if (e.key !== "Escape" || e.defaultPrevented || layers.length === 0) return false;
      e.preventDefault();
      layers[layers.length - 1].close();
      return true;
    },
  };
}

const escapes = createEscapeStack();
let listening = false;

/**
 * Esc closes this layer while it's `open` and nothing opened since is,
 * wherever focus is: a dialog opened from ⌘K has nothing inside it focused.
 */
export function useEscape(onClose: () => void, open = true): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    if (!listening) {
      window.addEventListener("keydown", (e) => escapes.press(e));
      listening = true;
    }
    return escapes.push({ close: () => close.current() });
  }, [open]);
}
