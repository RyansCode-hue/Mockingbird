import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEscape } from "./useEscape";
import { usePresence } from "./motion";
import { placeMenu } from "./ContextMenu";
import { useLiftOut } from "./lift";

/**
 * A popover under an element anywhere, even one inside a scaled layer (the landscape's world): it's drawn over
 * everything, at the element's place on screen, so it keeps its own size. A press or a wheel outside it, Escape, or
 * the window resizing or losing focus closes it (`onClose` hears which: Escape gives the keyboard back to whoever
 * opened it). It's named for screen readers and takes the keyboard as it opens; `onKeyDown` hears keys pressed in it.
 * `align` "end" lines its right edge up with the element's (a button at the window's right end); its left by default.
 * `below` keeps it under the element however tall it grows, its height capped at the window's bottom (its content
 * scrolls), and placed again whenever its size changes; otherwise a tall one flips above, as a menu does. `anchor` can
 * be a function, read whenever it's placed, for an element that's swapped for another while it's open, or a point on
 * screen (the same object while it's open), where it opens as a menu does at the pointer; `placeKey` changing places
 * it again.
 */
export function AnchoredPopover({
  anchor,
  className,
  label,
  onClose,
  children,
  align = "start",
  below = false,
  onKeyDown,
  placeKey,
}: {
  anchor: HTMLElement | (() => HTMLElement | null) | { x: number; y: number };
  className: string;
  label: string;
  onClose: (how: "escape" | "outside" | "away") => void;
  children: ReactNode;
  align?: "start" | "end";
  below?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  placeKey?: string;
}) {
  useEscape(() => onClose("escape"));
  const anchorNow = useRef(anchor);
  anchorNow.current = anchor;
  const anchorEl = () => {
    const a = anchorNow.current;
    return typeof a === "function" ? a() : a instanceof HTMLElement ? a : null;
  };
  const fixed = typeof anchor === "function" ? null : anchor;
  const box = useRef<HTMLDivElement | null>(null);
  const presence = usePresence<HTMLDivElement>("menu", { also: box });
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const place = () => {
      const to = anchorNow.current;
      const a = anchorEl();
      const r = typeof to === "function" || to instanceof HTMLElement ? a?.getBoundingClientRect() : { left: to.x, right: to.x, bottom: to.y };
      // one that has left the page has no place: it stays where it was
      if (!r || (a && !a.isConnected)) return;
      const x = align === "end" ? r.right - el.offsetWidth : r.left;
      const view = { width: window.innerWidth, height: window.innerHeight };
      const at = placeMenu({ x, y: r.bottom + 4 }, { width: el.offsetWidth, height: below ? 0 : el.scrollHeight }, view);
      const next = below ? { left: at.left, top: r.bottom + 4, maxHeight: Math.max(0, view.height - r.bottom - 4 - 8) } : at;
      setPos((p) => (p && p.left === next.left && p.top === next.top && p.maxHeight === next.maxHeight ? p : next));
    };
    place();
    if (!below) return;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fixed, align, below, placeKey]);
  useEffect(() => {
    box.current?.focus({ preventScroll: true });
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchorEl()?.contains(t)) close.current("outside");
    };
    const away = () => close.current("away");
    // pointerdown too: a press the landscape takes (a pan, a scaled terminal, the minimap) calls preventDefault on it,
    // and the browser then sends no mousedown
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("mousedown", outside, true);
    window.addEventListener("wheel", outside, { capture: true, passive: true });
    window.addEventListener("resize", away);
    window.addEventListener("blur", away);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("mousedown", outside, true);
      window.removeEventListener("wheel", outside, { capture: true });
      window.removeEventListener("resize", away);
      window.removeEventListener("blur", away);
    };
  }, [fixed]);
  return createPortal(
    <div
      ref={presence}
      className={`mb-menu ${className}`}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={pos ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight } : { left: -9999, top: -9999 } /* measured first, then placed */}
      // a portal's events reach its component tree: a press here isn't a press on the landscape under the button
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  );
}

/**
 * A popover anchored by its wrapper's CSS (`className` places it): a click
 * anywhere outside it, or Escape, closes it. With a `label` it's a dialog:
 * named for screen readers and focused when it opens, so the keyboard starts
 * inside it.
 */
export function Popover({ className, onClose, children, label }: { className: string; onClose: () => void; children: ReactNode; label?: string }) {
  // inside the landscape's scaled world it's anchored to its wrapper from the body instead (lift.ts)
  const lift = useLiftOut();
  const marker = useRef<HTMLSpanElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (lift) setAnchor(marker.current?.parentElement ?? null);
  }, [lift]);
  if (lift)
    return (
      <>
        <span ref={marker} hidden />
        {anchor && (
          <AnchoredPopover anchor={anchor} className={`${className} lifted`} label={label ?? ""} onClose={onClose}>
            {children}
          </AnchoredPopover>
        )}
      </>
    );
  return <PlacedPopover className={className} onClose={onClose} label={label}>{children}</PlacedPopover>;
}

function PlacedPopover({ className, onClose, children, label }: { className: string; onClose: () => void; children: ReactNode; label?: string }) {
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
