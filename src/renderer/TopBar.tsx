import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useContextMenu, type Action } from "./ContextMenu";
import { DIALOG_OPENED, useDialogFocus, type DialogOpened } from "./Modal";
import { AnchoredPopover } from "./Popover";
import { SHEET_FOOT, SHORTCUTS } from "./landscapeShortcuts";
import { foldBar } from "./selectionBarModel";
import type { Tab } from "./tabs";

/** A tab of the top bar: its name, what it draws beside it, and what that says when the tab is folded into the menu. */
export interface TopTab {
  id: Tab;
  label: string;
  badge: ReactNode;
  badgeSays: string | null;
}

/** Folding's keys for what isn't a tab. */
const KEYS = "$keys";
const FIXED = "$fixed";
/** Folding order: the shortcuts button first (`?` still opens the sheet), then tabs from the right. */
const RANK_KEYS = 2;
const RANK_TAB = 1;

/**
 * The shortcuts sheet (design G) under its button: landscapeShortcuts.ts's rows. It's a popover over the app that says
 * so (useDialogFocus puts the Needs you tray away) and gives the keyboard back to what had it: the landscape after `?`,
 * the button after a click. A dialog or the palette opening puts it away in turn, and hands them the same place to
 * give the keyboard back to.
 */
function ShortcutsSheet({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  useDialogFocus();
  const opener = useRef(document.activeElement);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onDialog = (e: Event) => {
      close.current();
      if (opener.current instanceof HTMLElement) (e as CustomEvent<DialogOpened>).detail.handBack(opener.current);
    };
    document.addEventListener(DIALOG_OPENED, onDialog);
    return () => document.removeEventListener(DIALOG_OPENED, onDialog);
  }, []);
  return (
    <AnchoredPopover
      anchor={anchor}
      className="ls-keys"
      label="Shortcuts"
      onClose={onClose}
      align="end"
      below
      onKeyDown={(e) => {
        if (e.key !== "?") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="ls-keys-head">
        <span className="ls-keys-title">Shortcuts</span>
        <button type="button" className="ls-keys-x" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="ls-keys-list">
        {SHORTCUTS.map((s) => (
          <section key={s.title} className="ls-keys-sec">
            <h4>{s.title}</h4>
            {s.rows.map((r) => (
              <div key={r.id} className="ls-keys-row" data-row={r.id}>
                <span>{r.what}</span>
                <kbd>{r.keys}</kbd>
              </div>
            ))}
          </section>
        ))}
      </div>
      <div className="ls-keys-foot">{SHEET_FOOT}</div>
    </AnchoredPopover>
  );
}

/**
 * The top bar with the landscape on (designs G, D and O): the brand and What's new, the tabs, Needs you, "? Shortcuts"
 * and + New. In a narrow window what doesn't fit folds behind "» n more" as the selection bar's buttons do (foldBar,
 * measured before anything is painted), the shortcuts button first, then tabs from the right; the open tab, Needs you
 * and + New stay, and a folded tab's badge shows on »: it opens a menu of them, since the bar has no second row.
 */
export function LandscapeTopBar({
  brand,
  tabs,
  tab,
  onTab,
  needs,
  needsCount,
  keysOpen,
  onKeysOpen,
  onNew,
}: {
  brand: ReactNode;
  tabs: readonly TopTab[];
  tab: Tab;
  onTab: (t: Tab) => void;
  /** The Needs you button and its tray. */
  needs: ReactNode;
  /** How many it lists: its button's width goes by it. */
  needsCount: number;
  keysOpen: boolean;
  onKeysOpen: (open: boolean) => void;
  onNew: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const keysBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const ctx = useContextMenu("More in the top bar");
  const [room, setRoom] = useState("");
  const sig = [room, tab, needsCount, ...tabs.map((t) => `${t.id}:${t.label}:${t.badgeSays ?? ""}`)].join("\n");
  const [fold, setFold] = useState<{ sig: string; folded: string[] } | null>(null);
  const measuring = fold?.sig !== sig;
  const folded = new Set(measuring ? [] : fold.folded);

  useEffect(() => {
    const b = bar.current;
    if (!b) return;
    const brandEl = b.querySelector(".brand");
    const read = () => setRoom(`${b.clientWidth}:${brandEl?.clientWidth ?? 0}`);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(b);
    if (brandEl) ro.observe(brandEl);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const b = bar.current;
    if (!measuring || !b) return;
    const css = getComputedStyle(b);
    const w = (q: string) => b.querySelector<HTMLElement>(q)?.offsetWidth ?? 0;
    // the brand and the tabs' margins (.brand, .tabs) go with what never folds
    const fixed = w(".brand") + 12 + w(".ny-btn") + b.querySelector<HTMLElement>(":scope > button.primary")!.offsetWidth;
    const fit = foldBar(
      [{ key: FIXED, w: fixed, rank: 0 }, ...tabs.map((t) => ({ key: t.id, w: w(`[data-tab="${t.id}"]`), rank: t.id === tab ? 0 : RANK_TAB })), { key: KEYS, w: keysBtn.current?.offsetWidth ?? 0, rank: RANK_KEYS }],
      b.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight),
      w(".tb-probe"),
      parseFloat(css.columnGap) || 0
    );
    setFold({ sig, folded: fit.folded });
  }, [sig, measuring]);

  const rest = tabs.filter((t) => folded.has(t.id));
  const keysFolded = folded.has(KEYS);
  const count = rest.length + (keysFolded ? 1 : 0);
  const busy = rest.filter((t) => t.badgeSays);
  const menu = (): Action[] => [
    ...rest.map((t): Action => ({ key: t.id, label: t.badgeSays ? `${t.label} (${t.badgeSays})` : t.label, onPick: () => onTab(t.id) })),
    ...(keysFolded ? [{ key: KEYS, label: "? Shortcuts", onPick: () => onKeysOpen(true) }] : []),
  ];
  return (
    <div ref={bar} className="topbar">
      {brand}
      <span className="tabs">
        {tabs
          .filter((t) => !folded.has(t.id))
          .map((t) => (
            <button key={t.id} type="button" className={`tab ${tab === t.id ? "on" : ""}`} data-tab={t.id} onClick={() => onTab(t.id)}>
              {t.label}
              {t.badge}
            </button>
          ))}
      </span>
      {count > 0 && (
        <button
          ref={moreBtn}
          type="button"
          className="tab tb-more"
          aria-haspopup="menu"
          title={busy.length ? busy.map((t) => `${t.label}: ${t.badgeSays}`).join(" · ") : "What doesn't fit in the bar"}
          onClick={(e) => ctx.openBelow(e.currentTarget, menu())}
        >
          » {count} more
          {busy.length > 0 && <span className="dot sm waiting" style={{ marginLeft: 6 }} />}
        </button>
      )}
      {measuring && (
        <span className="tab tb-more tb-probe" aria-hidden="true">
          » 9 more
        </span>
      )}
      <span className="spacer" />
      {needs}
      {!keysFolded && (
        <button ref={keysBtn} type="button" className="tb-keys" aria-haspopup="dialog" aria-expanded={keysOpen} title="Every shortcut (? while the landscape has the keyboard)" onClick={() => onKeysOpen(!keysOpen)}>
          ? Shortcuts
        </button>
      )}
      {keysOpen && (keysBtn.current ?? moreBtn.current) && <ShortcutsSheet anchor={(keysBtn.current ?? moreBtn.current)!} onClose={() => onKeysOpen(false)} />}
      <button type="button" className="primary" title="New workspace: on the landscape, the menu a right-click gives (⌘N goes straight to New session)" onClick={onNew}>
        + New
      </button>
      {ctx.menu}
    </div>
  );
}
