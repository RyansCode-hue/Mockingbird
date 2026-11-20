import { clampTabDrag, movedTo, tabShifts, tabSlot, type TabSlot } from "../shared/tabOrder";

/** A stack's tab dragged along its strip: it follows the pointer, and the tabs it passes make room for it. */
export interface TabDrag {
  /** The pointer at `x` (screen px). */
  move(x: number): void;
  /** The stack's session ids in their new order, or null with the tab back in its own place. */
  order(): string[] | null;
  /** Every tab drawn in its place again, with no motion. */
  clear(): void;
}

/**
 * Start dragging `tab` (a `.ls-tab[data-sid]`) along its strip, pressed at `x0`; null where its strip has no other tab
 * to pass. In focus each tab is wrapped with its × (`.ls-tabw`), which moves with it. A strip on the landscape is drawn
 * at the camera's zoom, so a screen px is 1 / zoom of the strip's own.
 */
export function startTabDrag(tab: HTMLElement, x0: number): TabDrag | null {
  const strip = tab.closest<HTMLElement>(".ls-tabs");
  if (!strip) return null;
  const tabs = [...strip.querySelectorAll<HTMLElement>(".ls-tab[data-sid]")];
  const from = tabs.indexOf(tab);
  if (tabs.length < 2 || from < 0) return null;
  const items = tabs.map((t) => t.closest<HTMLElement>(".ls-tabw") ?? t);
  const ids = tabs.map((t) => t.dataset.sid!);
  const slots: TabSlot[] = items.map((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, width: r.width };
  });
  const scale = items[from].offsetWidth ? slots[from].width / items[from].offsetWidth : 1;
  let to = from;
  strip.classList.add("ls-reordering");
  items[from].classList.add("ls-tab-dragged");
  return {
    move(x) {
      const dx = clampTabDrag(slots, from, x - x0);
      to = tabSlot(slots, from, dx);
      const shifts = tabShifts(slots, from, to);
      items.forEach((el, i) => {
        const by = i === from ? dx : shifts[i];
        el.style.translate = by ? `${by / scale}px` : "";
      });
    },
    order: () => (to === from ? null : movedTo(ids, from, to)),
    clear() {
      // the class first: without it, the tabs going back take no transition
      strip.classList.remove("ls-reordering");
      items[from].classList.remove("ls-tab-dragged");
      for (const el of items) el.style.translate = "";
    },
  };
}
