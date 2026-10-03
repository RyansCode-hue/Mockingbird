import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  key: string;
  label: React.ReactNode;
  onPick: () => void;
}

/**
 * A button that opens a list of choices. The list floats over the page (in a
 * portal), so a scrolling or clipped container can't cut it off; it opens
 * below the button, or above when there's no room, stays inside the window,
 * and closes on a choice, a click elsewhere, Esc, or a scroll.
 */
export function MenuButton({
  label,
  items,
  className = "outline",
  title,
  disabled,
}: {
  label: React.ReactNode;
  items: MenuItem[];
  className?: string;
  title?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current || !list.current) return;
    const b = btn.current.getBoundingClientRect();
    const l = list.current.getBoundingClientRect();
    const gap = 4;
    const below = b.bottom + gap + l.height <= window.innerHeight - 8;
    const top = below ? b.bottom + gap : Math.max(8, b.top - gap - l.height);
    const left = Math.min(Math.max(8, b.left), window.innerWidth - l.width - 8);
    setPos({ left, top });
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const outside = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true); // any scrolling container would leave the list behind
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        className={className}
        title={title}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setPos(null);
          setOpen((o) => !o);
        }}
      >
        {label}
      </button>
      {open &&
        createPortal(
          <div
            ref={list}
            className="mb-menu"
            role="menu"
            style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 } /* measured first, then placed */}
          >
            {items.map((it) => (
              <button
                key={it.key}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  it.onPick();
                }}
              >
                {it.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
