import React, { useMemo, useRef, useState } from "react";
import type { SessionInfo } from "../shared/types";
import type { JoinRequestSummary, TeamRoomSummary } from "../shared/team/types";
import { LOOSE_GROUP } from "../shared/landscape";
import { agoShort, plural } from "../shared/format";
import { AnchoredPopover } from "./Popover";
import { usePersisted } from "./prefs";
import { shortAreaName } from "./landscapeModel";
import { KIND_LABEL, dismiss, dismissedFrom, needsByArea, needsItems, shownItems, undismiss, type NeedsItem } from "./needsYouModel";
import type { ModelAction } from "./workspaceActions";

/** What the window knows of what needs you: the items shown (not dismissed), how many are dismissed, and each area's count. */
export interface NeedsYouState {
  items: NeedsItem[];
  dismissed: number;
  byArea: Map<string, number>;
  dismiss: (item: NeedsItem) => void;
  /** A Dismiss undone: the item is listed again. */
  undismiss: (item: NeedsItem) => void;
  /** Whether `item`, in its state then, is dismissed now. */
  isDismissed: (item: NeedsItem) => boolean;
  /** Why the rooms' join requests couldn't be read (the team status failed), or null: no requests listed then isn't "none". */
  joinError: string | null;
}

/** Where dismissals are kept between launches (a view preference, never landscape.json). */
export const DISMISSED_PREF = "mb.needsYou.dismissed";

/**
 * What needs you (needsYouModel.ts), from the window's sessions and the join requests this install answers, with
 * its dismissals: a Dismiss holds until the item's state changes (a new prompt, another turn ending), kept between
 * launches.
 */
export function useNeedsYou(
  sessions: readonly SessionInfo[],
  asks: readonly { request: JoinRequestSummary; room: TeamRoomSummary }[],
  areaOf: (s: SessionInfo) => string,
  titleOf: (s: SessionInfo) => string,
  joinError: string | null
): NeedsYouState {
  const [saved, setSaved] = usePersisted<unknown>(DISMISSED_PREF, []);
  const list = useMemo(() => dismissedFrom(saved), [saved]);
  const all = needsItems(sessions, asks, areaOf, titleOf);
  const items = shownItems(all, list);
  // the same items in the same areas give the same counts, so what's memoized on them (the area tree) holds
  const shape = items.map((i) => `${i.sig}@${i.area}`).join("\n");
  const byArea = useMemo(() => needsByArea(items), [shape]);
  return {
    items,
    dismissed: all.length - items.length,
    byArea,
    dismiss: (item) => setSaved((d: unknown) => dismiss(dismissedFrom(d), item, Date.now())),
    undismiss: (item) => setSaved((d: unknown) => undismiss(dismissedFrom(d), item)),
    isDismissed: (item) => list.some((d) => d.sig === item.sig),
    joinError,
  };
}

/** The dot before an item's kind: amber while something waits on you, grey for what's only done. */
const DOT: Record<NeedsItem["kind"], string> = { permission: "waiting", question: "waiting", join: "waiting", finished: "idle" };

/** A second Dismiss this soon after one is a double click landing on the item that slid up under the pointer: it's let go. */
const DISMISS_GUARD_MS = 450;

/**
 * The Needs you button in the top bar and the tray it drops down (design D, "Inbox"): every item with its kind and
 * area, how long it has waited, what it is, and its actions (needsActions: Go there and Dismiss, through the one
 * model). The item the view is on (N's place) is lit. N and ⇧N work in the tray as they do on the landscape, and keep
 * it open; the view keeps the item clear of the tray. The last Dismiss can be undone from its foot.
 */
export function NeedsYou({
  state,
  current,
  actionsFor,
  areaTitle,
  onStep,
}: {
  state: NeedsYouState;
  /** The id of the item the view is on, or null. */
  current: string | null;
  /** An item's actions; `close` puts the tray away (Go there does, Dismiss doesn't). */
  actionsFor: (item: NeedsItem, close: () => void) => ModelAction[];
  areaTitle: (key: string) => string;
  /** N (1) or ⇧N (-1): the view to the next or previous item; `avoid` is the tray's box on screen, to keep it clear of. */
  onStep: (dir: 1 | -1, avoid: DOMRect | null) => void;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<{ item: NeedsItem; at: number } | null>(null);
  const close = (how?: "escape" | "outside" | "away") => {
    setOpen(false);
    // Escape gives the keyboard back to the button that opened it; Go there gives it to the landscape
    if (how === "escape") btn.current?.focus({ preventScroll: true });
  };
  const n = state.items.length;
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== "n") return;
    if ((e.target as Element).closest("input, textarea, select, [contenteditable]")) return;
    e.preventDefault();
    e.stopPropagation();
    onStep(e.shiftKey ? -1 : 1, e.currentTarget.getBoundingClientRect());
  };
  const onDismiss = (item: NeedsItem, a: ModelAction, e: React.MouseEvent) => {
    if (last && Date.now() - last.at < DISMISS_GUARD_MS) return;
    const tray = (e.currentTarget as HTMLElement).closest<HTMLElement>(".ny-tray");
    a.onPick();
    setLast({ item, at: Date.now() });
    // its button leaves with it: the keyboard stays in the tray, so N and Esc still reach it
    requestAnimationFrame(() => tray?.isConnected && tray.focus({ preventScroll: true }));
  };
  const undoable = last && state.isDismissed(last.item) ? last.item : null;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`ny-btn ${n ? "on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={n ? `${n} need you: permission prompts, questions, join requests and finished sessions (N goes to the next on the landscape)` : "Nothing needs you right now"}
        onClick={() => setOpen((o) => !o)}
      >
        Needs you
        {n > 0 && <span className="ny-n">{n}</span>}
      </button>
      {open && btn.current && (
        <AnchoredPopover anchor={btn.current} className="ny-tray" label="Needs you" onClose={close} align="end" below onKeyDown={onKey}>
          <div className="ny-head">
            <span className="ny-title">Needs you</span>
            <span className="ny-keys">N next · ⇧N back</span>
          </div>
          <div className="ny-list">
            {state.joinError && (
              <div className="ny-err" title={state.joinError}>
                Couldn't read the rooms' join requests: {state.joinError}
              </div>
            )}
            {!n && <div className="ny-none">Nothing needs you right now.</div>}
            {state.items.map((item) => (
              <div key={item.id} className={`ny-item k-${item.kind} ${current === item.id ? "on" : ""}`} data-item={item.id}>
                <div className="ny-meta">
                  <span className={`dot sm ${DOT[item.kind]}`} />
                  <span className="ny-kind" title={item.area === LOOSE_GROUP ? "In no area" : areaTitle(item.area)}>
                    {KIND_LABEL[item.kind]} · {item.area === LOOSE_GROUP ? "no area" : shortAreaName(item.area, areaTitle(item.area))}
                  </span>
                  <span className="ny-age" title={new Date(item.at).toLocaleString()}>
                    {agoShort(item.at)}
                  </span>
                </div>
                <div className="ny-text">
                  {item.code ? (
                    <>
                      {item.text.slice(0, item.text.length - item.code.length)}
                      <code>{item.code}</code>
                    </>
                  ) : (
                    item.text
                  )}
                </div>
                <div className="ny-acts">
                  {actionsFor(item, close).map((a) => (
                    <button
                      key={a.key}
                      type="button"
                      // the main action is filled only where something waits on you to answer it, as design D does
                      className={a.primary ? `ny-go ${DOT[item.kind] === "waiting" ? "fill" : ""}` : "ny-dismiss"}
                      data-action={a.key}
                      disabled={a.disabled}
                      title={a.title}
                      onClick={(e) => (a.key === "dismiss" ? onDismiss(item, a, e) : a.onPick())}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {state.dismissed > 0 && (
            <div className="ny-foot" title="A dismissed item comes back when its state changes: a new prompt, another turn ending, another request">
              <span>{plural(state.dismissed, "item")} dismissed</span>
              {undoable && (
                <button type="button" className="ny-undo" data-action="undo" title={`List “${undoable.text}” again`} onClick={() => (state.undismiss(undoable), setLast(null))}>
                  Undo
                </button>
              )}
            </div>
          )}
        </AnchoredPopover>
      )}
    </>
  );
}
