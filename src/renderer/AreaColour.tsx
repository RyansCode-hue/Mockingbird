import { useEffect, useRef, useState } from "react";
import { AnchoredPopover } from "./Popover";
import { useDialogFocus } from "./Modal";
import { ACCENT_NAMES, ACCENT_ORDER } from "./landscapeModel";

/** What an area's Colour popover hangs from: the dot pressed, an element found for it, or a point where none is drawn. */
export type ColourAnchor = HTMLElement | (() => HTMLElement | null) | { x: number; y: number };

/** The popover's choices in order: Automatic (null), then the colours as ACCENT_ORDER lays them out. */
const CHOICES: readonly (number | null)[] = [null, ...ACCENT_ORDER];
/** The swatches' rows are this long. */
export const COLOUR_COLUMNS = 5;

/**
 * Where a key moves the popover's focus from choice `i` (CHOICES' index), or null for a key it doesn't take. ← and →
 * walk the choices in order, stopping at either end; ↑ and ↓ move between the swatches' rows, ↑ from the top row (or ←
 * from its first) going to Automatic and ↓ (or →) from Automatic to the first swatch; Home and End go to the first and
 * last choice.
 */
export function colourStep(i: number, key: string): number | null {
  const last = CHOICES.length - 1;
  const row = i === 0 ? -1 : Math.floor((i - 1) / COLOUR_COLUMNS);
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return last;
    case "ArrowLeft":
      return Math.max(0, i - 1);
    case "ArrowRight":
      return Math.min(last, i + 1);
    case "ArrowUp":
      return row <= 0 ? 0 : i - COLOUR_COLUMNS;
    case "ArrowDown":
      return row < 0 ? 1 : i + COLOUR_COLUMNS <= last ? i + COLOUR_COLUMNS : i;
    default:
      return null;
  }
}

/**
 * An area's Colour popover (its ⋯'s Colour…, or a press on its dot): Automatic, with the colour that gives it, then
 * the colours as swatches in two rows round the wheel, the one in force marked. A radio group: the arrow keys move
 * between them (colourStep), Enter or Space picks the one focused, Esc closes; either way the keyboard goes back to
 * what had it as it opened (useDialogFocus): a dot in the tree, or the landscape, which a press on its own buttons
 * leaves the keyboard with. Picking only says which: `onPick` saves it.
 */
export function AreaColourPopover({
  anchor,
  title,
  chosen,
  automatic,
  onPick,
  onClose,
}: {
  anchor: ColourAnchor;
  title: string;
  /** Its chosen colour; undefined while it takes an automatic one. */
  chosen: number | undefined;
  /** The colour it takes when none is chosen. */
  automatic: number;
  /** A colour picked, or null for Automatic. */
  onPick: (accent: number | null) => void;
  onClose: () => void;
}) {
  useDialogFocus();
  const current = Math.max(0, CHOICES.indexOf(chosen ?? null));
  const [at, setAt] = useState(current);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  // after AnchoredPopover has taken the keyboard for itself as it opened: on to the choice in force, then where it moves
  useEffect(() => buttons.current[at]?.focus({ preventScroll: true }), [at]);
  const name = (c: number | null) => (c === null ? `Automatic (${ACCENT_NAMES[automatic]})` : ACCENT_NAMES[c]);
  const pick = (c: number | null) => {
    onPick(c);
    onClose();
  };
  const choice = (c: number | null, i: number) => {
    const on = i === current;
    return (
      <button
        key={c ?? "auto"}
        ref={(el) => void (buttons.current[i] = el)}
        type="button"
        role="radio"
        aria-checked={on}
        aria-label={name(c)}
        title={name(c)}
        tabIndex={i === at ? 0 : -1}
        data-accent={c ?? "auto"}
        className={c === null ? `ls-colour-auto ${on ? "on" : ""}` : `ls-colour-sw a${c} ${on ? "on" : ""}`}
        onFocus={() => setAt(i)}
        onClick={() => pick(c)}
      >
        {c === null ? (
          <>
            <span className={`ls-colour-dot a${automatic}`} aria-hidden="true" />
            Automatic
            {on && (
              <span className="ls-colour-check" aria-hidden="true">
                ✓
              </span>
            )}
          </>
        ) : (
          on && (
            <span className="ls-colour-check" aria-hidden="true">
              ✓
            </span>
          )
        )}
      </button>
    );
  };
  return (
    <AnchoredPopover anchor={anchor} className="ls-colour" label={`${title}: colour`} onClose={onClose}>
      <div className="ls-colour-head">Colour</div>
      <div
        role="radiogroup"
        aria-label={`${title}: colour`}
        className="ls-colour-grid"
        onKeyDown={(e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          // Enter and Space pick here, once: kept from the button's own activation, which would pick again
          const next = e.key === "Enter" || e.key === " " ? "pick" : colourStep(at, e.key);
          if (next === null) return;
          e.preventDefault();
          e.stopPropagation();
          if (next === "pick") pick(CHOICES[at]);
          else setAt(next);
        }}
      >
        {choice(null, 0)}
        <div className="ls-colour-rows">{CHOICES.slice(1).map((c, i) => choice(c, i + 1))}</div>
      </div>
      <div className="ls-colour-name" aria-hidden="true">
        {name(CHOICES[at])}
      </div>
    </AnchoredPopover>
  );
}

/**
 * An area's colour dot. With `onColour` it's a button opening the area's Colour popover from itself (`data-colour-dot`
 * names the area, for Colour… in its menu to hang the popover from); without, just the colour.
 */
export function AccentDot({ className, area, title, onColour }: { className: string; area: string; title: string; onColour?: (el: HTMLElement) => void }) {
  if (!onColour) return <span className={className} aria-hidden="true" />;
  return (
    <button
      type="button"
      className={`${className} ls-dot-btn`}
      data-colour-dot={area}
      aria-label={`${title}: colour`}
      aria-haspopup="dialog"
      title="Colour…"
      onClick={(e) => {
        e.stopPropagation();
        onColour(e.currentTarget);
      }}
    />
  );
}

/**
 * What Colour… in an area's menu hangs the popover from: the area's dot in the selection bar, its header or the area
 * tree, else its pill or its name zoomed out, whichever is drawn first in that order; else a point near the middle of
 * the window, so it opens all the same.
 */
export function colourAnchor(area: string): ColourAnchor {
  const k = CSS.escape(area);
  const seen = (el: HTMLElement | null) => (el && el.getClientRects().length ? el : null);
  for (const sel of [`.ls-selbar [data-colour-dot="${k}"]`, `.ls-area [data-colour-dot="${k}"]`, `[data-colour-dot="${k}"]`, `.ls-area-pill[data-area="${k}"]`, `.ls-area[data-area="${k}"] .ls-area-title`]) {
    const el = seen(document.querySelector<HTMLElement>(sel));
    if (el) return el;
  }
  return { x: Math.round(window.innerWidth / 2 - 110), y: Math.round(window.innerHeight / 3) };
}
