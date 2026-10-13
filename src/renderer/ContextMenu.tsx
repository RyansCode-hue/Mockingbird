import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscape } from "./useEscape";
import { MoreIcon } from "./Icons";

/**
 * One action, said once and shown two ways: as a labelled icon button (an
 * icon over a short word) and as a row of a right-click menu. Callers build
 * an element's actions as a list, show the everyday ones as buttons, and give
 * the whole list to its context menu, so the two can't drift apart.
 */
export interface Action {
  key: string;
  /** The word under the icon: one or two short words. */
  label: string;
  /** The menu row's wording, when the button's word is too terse for it ("Take over…"). */
  menuLabel?: string;
  icon?: React.ReactNode;
  /** More about it, on hover. The label alone must say what it does. */
  title?: string;
  /** Runs it; `from` is the button pressed, when it was one (a menu opens below it). */
  onPick: (from?: HTMLElement) => void;
  danger?: boolean;
  /** A toggle that's on (Pin while pinned, Notify while muted reads "Muted"). */
  pressed?: boolean;
  disabled?: boolean;
  /** The one action the element is for right now (Take over while its owner is offline). */
  primary?: boolean;
}

/** A context menu's rows: actions, with "-" between sets of them. */
export type MenuEntry = Action | "-";

const isAction = (e: MenuEntry | undefined): e is Action => !!e && e !== "-" && !e.disabled;

/** The next pickable row from `from` in `dir`, wrapping; -1 when none is. */
export function nextItem(items: readonly MenuEntry[], from: number, dir: 1 | -1): number {
  for (let step = 1; step <= items.length; step++) {
    const i = (((from + dir * step) % items.length) + items.length) % items.length;
    if (isAction(items[i])) return i;
  }
  return -1;
}

export interface MenuState {
  at: { x: number; y: number };
  items: MenuEntry[];
  /** The row the keyboard is on. */
  active: number;
}

/** A menu opened at a point, on its first pickable row; null when nothing in it can be picked. */
export function openMenu(at: { x: number; y: number }, items: MenuEntry[]): MenuState | null {
  const active = nextItem(items, -1, 1);
  return active < 0 ? null : { at, items, active };
}

/**
 * A key pressed in an open menu: ↑↓ Home End move, Enter or Space picks the
 * row (returned in `picked`, the menu closed), Esc and Tab close it. `handled`
 * is false for keys the menu leaves alone.
 */
export function menuKey(state: MenuState, key: string): { state: MenuState | null; picked?: Action; handled: boolean } {
  const { items, active } = state;
  switch (key) {
    case "ArrowDown":
      return { state: { ...state, active: nextItem(items, active, 1) }, handled: true };
    case "ArrowUp":
      return { state: { ...state, active: nextItem(items, active, -1) }, handled: true };
    case "Home":
      return { state: { ...state, active: nextItem(items, -1, 1) }, handled: true };
    case "End":
      return { state: { ...state, active: nextItem(items, items.length, -1) }, handled: true };
    case "Enter":
    case " ": {
      const it = items[active];
      return isAction(it) ? { state: null, picked: it, handled: true } : { state, handled: true };
    }
    case "Escape":
    case "Tab":
      return { state: null, handled: true };
    default:
      return { state, handled: false };
  }
}

/**
 * Where a menu opened at a point goes: down and right of it when it fits,
 * flipped up or left when it would run off the window, never past an edge,
 * and no taller than the window (a long menu scrolls).
 */
export function placeMenu(at: { x: number; y: number }, size: { width: number; height: number }, view: { width: number; height: number }) {
  const m = 8;
  const maxHeight = view.height - 2 * m;
  const height = Math.min(size.height, maxHeight);
  const left = at.x + size.width > view.width - m ? Math.max(m, Math.min(at.x, view.width - m) - size.width) : Math.max(m, at.x);
  const top = at.y + height > view.height - m ? Math.max(m, at.y - height) : Math.max(m, at.y);
  return { left, top, maxHeight };
}

/** Closes a menu and runs the row picked — closed first, so a dialog the row opens isn't closed with it. */
function run(a: Action, close: () => void) {
  close();
  a.onPick();
}

/** The menu itself, in a portal over everything. Use it through useContextMenu or MoreButton. */
function ContextMenuView({ state, setState, label }: { state: MenuState; setState: (s: MenuState | null) => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const close = () => setState(null);
  useEscape(close);
  // keys read the newest state, even two pressed before a render
  const cur = useRef(state);
  cur.current = state;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(placeMenu(state.at, { width: el.offsetWidth, height: el.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [state.at, state.items]);

  // the keyboard's row has focus, so Enter and screen readers act on it
  useEffect(() => {
    if (!pos) return;
    (ref.current?.querySelector(`[data-i="${state.active}"]`) as HTMLElement | null)?.focus();
  }, [state.active, pos]);

  useEffect(() => {
    const outside = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("contextmenu", outside, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    // a wheel outside, not any scroll: panes and the chat scroll themselves as output arrives
    window.addEventListener("wheel", outside, { capture: true, passive: true });
    return () => {
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("contextmenu", outside, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("wheel", outside, { capture: true });
    };
  }, []);

  return createPortal(
    <div
      ref={ref}
      className="mb-menu mb-ctx"
      role="menu"
      aria-label={label}
      style={pos ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight } : { left: -9999, top: -9999 } /* measured first, then placed */}
      // React passes a portal's events up its component tree: a click here isn't a click on the row or header that opened it
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onDragStart={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        const r = menuKey(cur.current, e.key);
        if (!r.handled) return;
        e.preventDefault();
        e.stopPropagation();
        if (r.picked) run(r.picked, close);
        else {
          if (r.state) cur.current = r.state;
          setState(r.state);
        }
      }}
    >
      {state.items.map((it, i) =>
        it === "-" ? (
          <div key={`sep${i}`} className="mb-ctx-sep" role="separator" />
        ) : (
          <button
            key={it.key}
            data-i={i}
            role={it.pressed === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={it.pressed === undefined ? undefined : it.pressed}
            tabIndex={i === state.active ? 0 : -1}
            disabled={it.disabled}
            className={`${it.danger ? "danger" : ""} ${i === state.active ? "active" : ""}`}
            title={it.title}
            onMouseEnter={() => !it.disabled && setState({ ...state, active: i })}
            onClick={() => run(it, close)}
          >
            <span className="mb-ctx-ico">{it.icon}</span>
            <span className="mb-ctx-t">{it.menuLabel ?? it.label}</span>
          </button>
        )
      )}
    </div>,
    document.body
  );
}

/**
 * A right-click menu for any element: spread `bind(items)` onto it (items as
 * a list or a function building one when the menu opens) and render `menu`
 * once anywhere. Opened from the keyboard (the menu key, ⇧F10), it opens at
 * the element's corner instead of the pointer. On close, focus goes back to
 * where it was.
 */
export function useContextMenu(label?: string) {
  const [state, setState] = useState<MenuState | null>(null);
  const back = useRef<HTMLElement | null>(null);
  const set = (s: MenuState | null) => {
    setState(s);
    if (!s) {
      const el = back.current;
      back.current = null;
      // unless what the row did took focus (a dialog), or another menu opened
      requestAnimationFrame(() => {
        const now = document.activeElement;
        if (el?.isConnected && (!now || now === document.body) && !document.querySelector(".mb-ctx")) el.focus({ preventScroll: true });
      });
    }
  };
  const openAt = (at: { x: number; y: number }, items: MenuEntry[]) => {
    back.current = document.activeElement as HTMLElement | null;
    setState(openMenu(at, items));
  };
  return {
    open: state !== null,
    openAt,
    /** Opens below an element, lined up with its left edge (a More button). */
    openBelow: (el: HTMLElement, items: MenuEntry[]) => {
      const r = el.getBoundingClientRect();
      openAt({ x: r.left, y: r.bottom + 2 }, items);
    },
    bind: (items: MenuEntry[] | (() => MenuEntry[])) => ({
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const list = typeof items === "function" ? items() : items;
        const fromKeys = e.clientX === 0 && e.clientY === 0;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openAt(fromKeys ? { x: r.left + 8, y: r.bottom } : { x: e.clientX, y: e.clientY }, list);
      },
    }),
    menu: state && <ContextMenuView state={state} setState={set} label={label} />,
  };
}

/** An icon over a short word: what every icon button in a row, header or bar looks like. */
export function LabelledButton({ action, className = "" }: { action: Action; className?: string }) {
  const a = action;
  return (
    <button
      type="button"
      className={`lbtn ${a.primary ? "primary" : ""} ${a.danger ? "danger" : ""} ${a.pressed ? "on" : ""} ${className}`}
      // where there's no room for the word (a sidebar row), the button is its icon alone: it's named by these
      title={a.title ?? a.label}
      aria-label={a.label}
      aria-pressed={a.pressed}
      disabled={a.disabled}
      data-action={a.key}
      onClick={(e) => {
        e.stopPropagation();
        a.onPick(e.currentTarget);
      }}
      onDoubleClick={(e) => e.stopPropagation() /* a row's double-click renames */}
    >
      {a.icon}
      <span className="lbtn-t">{a.label}</span>
    </button>
  );
}

/** A row of labelled icon buttons, and More with the element's whole menu when `more` is given. */
export function ActionBar({ actions, more, label, className = "" }: { actions: Action[]; more?: MenuEntry[] | (() => MenuEntry[]); label?: string; className?: string }) {
  if (!actions.length && !more) return null;
  return (
    <span className={`lbar ${className}`}>
      {actions.map((a) => (
        <LabelledButton key={a.key} action={a} />
      ))}
      {more && <MoreButton items={more} label={label} />}
    </span>
  );
}

/** The actions named in `keys`, in that order: the ones an element shows as buttons, out of its menu's. */
export function pickActions(entries: readonly MenuEntry[], keys: readonly string[]): Action[] {
  const byKey = new Map(entries.filter((e): e is Action => e !== "-").map((a) => [a.key, a]));
  return keys.map((k) => byKey.get(k)).filter((a): a is Action => !!a);
}

/** A menu's rows without separators at its ends or two in a row (where a set of actions came out empty). */
export function tidyMenu(entries: readonly (MenuEntry | null | false | undefined)[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (e === "-" && (!out.length || out[out.length - 1] === "-")) continue;
    out.push(e);
  }
  while (out[out.length - 1] === "-") out.pop();
  return out;
}

/** "More": the element's whole menu, from a button, for actions that have no button of their own. */
export function MoreButton({ items, label, title = "More actions — or right-click" }: { items: MenuEntry[] | (() => MenuEntry[]); label?: string; title?: string }) {
  const ctx = useContextMenu(label);
  return (
    <>
      <LabelledButton
        action={{
          key: "more",
          label: "More",
          icon: <MoreIcon />,
          title,
          onPick: (from) => from && ctx.openBelow(from, typeof items === "function" ? items() : items),
        }}
      />
      {ctx.menu}
    </>
  );
}
