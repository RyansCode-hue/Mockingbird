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

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
  disabled?: boolean;
}

/**
 * A dropdown that opens below its control (macOS's native popup lays the
 * current item over the control, which misplaces it in this layout), with
 * groups and a line of description per choice. Arrow keys and Enter work.
 */
export function Select({
  value,
  options,
  onChange,
  placeholder = "Choose…",
  className = "",
  title,
  disabled,
  style,
}: {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  title?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const [active, setActive] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useLayoutEffect(() => {
    if (!open || !btn.current || !list.current) return;
    const b = btn.current.getBoundingClientRect();
    const h = list.current.scrollHeight;
    const below = window.innerHeight - b.bottom - 12;
    const above = b.top - 12;
    const down = below >= Math.min(h, 240) || below >= above;
    const maxHeight = Math.max(120, down ? below : above);
    const width = Math.max(b.width, 220);
    const left = Math.min(Math.max(8, b.left), window.innerWidth - width - 8);
    setPos({ left, width, maxHeight, top: down ? b.bottom + 4 : b.top - 4 - Math.min(h, maxHeight) });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const close = () => setOpen(false);
    const outside = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", outside);
    window.addEventListener("resize", close);
    const scroll = (e: Event) => !list.current?.contains(e.target as Node) && close();
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);

  useEffect(() => {
    list.current?.querySelector(".mb-opt.active")?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (v: string) => {
    if (options.find((o) => o.value === v)?.disabled) return;
    setOpen(false);
    if (v !== value) onChange(v);
    btn.current?.focus();
  };
  let lastGroup: string | undefined;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`mb-select ${className}`}
        title={title}
        disabled={disabled}
        style={style}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setPos(null);
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setPos(null);
            setOpen(true);
          } else if (open && e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(options.length - 1, i + 1));
          } else if (open && e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (open && e.key === "Enter") {
            e.preventDefault();
            if (options[active]) pick(options[active].value);
          } else if (open && (e.key === "Escape" || e.key === "Tab")) {
            if (e.key === "Escape") e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <span className="mb-select-val">{current ? current.label : placeholder}</span>
        <span className="mb-select-caret">▾</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={list}
            className="mb-menu mb-listbox"
            role="listbox"
            style={pos ? { left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight } : { left: -9999, top: -9999 }}
          >
            {options.map((o, i) => {
              const head = o.group && o.group !== lastGroup ? o.group : null;
              lastGroup = o.group;
              return (
                <React.Fragment key={o.value || "__empty"}>
                  {head && <div className="mb-opt-group">{head}</div>}
                  <button
                    role="option"
                    aria-selected={o.value === value}
                    className={`mb-opt ${o.value === value ? "on" : ""} ${i === active ? "active" : ""} ${o.disabled ? "disabled" : ""}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(o.value)}
                  >
                    <span className="mb-opt-label">
                      <span className="mb-opt-check">{o.value === value ? "✓" : ""}</span>
                      {o.label}
                    </span>
                    {o.description && <span className="mb-opt-desc">{o.description}</span>}
                  </button>
                </React.Fragment>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}

/** The text of an <option>'s children: strings and numbers, however they were written. */
function textOf(n: React.ReactNode): string {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  if (React.isValidElement(n)) return textOf((n.props as { children?: React.ReactNode }).children);
  return "";
}

/** <option>/<optgroup> children as Select options. */
function optionsOf(children: React.ReactNode, group?: string): SelectOption[] {
  const out: SelectOption[] = [];
  React.Children.forEach(children, (c) => {
    if (!React.isValidElement(c)) return;
    const p = c.props as { value?: unknown; children?: React.ReactNode; disabled?: boolean; label?: string };
    if (c.type === "option") out.push({ value: String(p.value ?? textOf(p.children)), label: textOf(p.children), disabled: !!p.disabled, ...(group ? { group } : {}) });
    else if (c.type === "optgroup") out.push(...optionsOf(p.children, p.label));
    else if (c.type === React.Fragment) out.push(...optionsOf(p.children, group));
  });
  return out;
}

/**
 * A drop-in for <select>: the same <option> children and change handler
 * (`e.target.value`), drawn as the app's own dropdown so it opens below the
 * control instead of macOS's popup laid over it.
 */
export function Pick({
  value,
  onChange,
  children,
  ...rest
}: {
  value: string | number;
  onChange: (e: { target: { value: string } }) => void;
  children: React.ReactNode;
  className?: string;
  title?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  return <Select value={String(value)} options={optionsOf(children)} onChange={(v) => onChange({ target: { value: v } })} {...rest} />;
}
