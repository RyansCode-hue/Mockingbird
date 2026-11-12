import React, { useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo, TicketPipeline } from "../shared/types";
import type { PlanView } from "../shared/plans";
import type { JoinRequestSummary, TeamRoomSummary } from "../shared/team/types";
import { LOOSE_GROUP } from "../shared/landscape";
import { agoShort, plural } from "../shared/format";
import { DIALOG_OPENED, type DialogOpened } from "./Modal";
import { AnchoredPopover } from "./Popover";
import { ANSWER_GUARD_MS, cameraWait, keyClick, useHeldOff, useSettledRows } from "./answerGuard";
import { usePersisted } from "./prefs";
import { shortAreaName } from "./landscapeModel";
import { KIND_LABEL, dismiss, dismissedFrom, needsByArea, needsItems, needsLabel, shownItems, undismiss, type NeedsItem, type NeedsWires } from "./needsYouModel";
import type { ModelAction } from "./workspaceActions";

/** What the window knows of what needs you: the items shown (not dismissed), how many are dismissed, and each area's count. */
export interface NeedsYouState {
  items: NeedsItem[];
  dismissed: number;
  byArea: Map<string, number>;
  /** The sessions with an item shown: a stack's row counts its own, as its area's does. */
  sessions: ReadonlySet<string>;
  dismiss: (item: NeedsItem) => void;
  /** A Dismiss undone: the item is listed again. */
  undismiss: (item: NeedsItem) => void;
  /** Whether `item`, in its state then, is dismissed now. */
  isDismissed: (item: NeedsItem) => boolean;
  /** Why the rooms' join requests couldn't be read (the team status failed), or null: no requests listed then isn't "none". */
  joinError: string | null;
  /** Why the ticket pipelines couldn't be read, or null: no pull request requests or tickets listed then isn't "none". */
  pipelineError: string | null;
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
  joinError: string | null,
  pipelines: { all: Readonly<Record<string, TicketPipeline>>; error: string | null } = { all: {}, error: null },
  wires: NeedsWires | null = null,
  plans: readonly PlanView[] = []
): NeedsYouState {
  const [saved, setSaved] = usePersisted<unknown>(DISMISSED_PREF, []);
  const list = useMemo(() => dismissedFrom(saved), [saved]);
  const all = needsItems(sessions, asks, areaOf, titleOf, pipelines.all, wires, plans);
  const items = shownItems(all, list);
  // the same items in the same areas give the same counts, so what's memoized on them (the area tree) holds
  const shape = items.map((i) => `${i.sig}@${i.area}`).join("\n");
  const byArea = useMemo(() => needsByArea(items), [shape]);
  const withItem = useMemo(() => new Set(items.flatMap((i) => (i.session ? [i.session] : []))), [shape]);
  return {
    items,
    dismissed: all.length - items.length,
    byArea,
    sessions: withItem,
    dismiss: (item) =>
      setSaved((d: unknown) =>
        dismiss(
          dismissedFrom(d),
          item,
          Date.now(),
          all.map((i) => i.sig)
        )
      ),
    undismiss: (item) => setSaved((d: unknown) => undismiss(dismissedFrom(d), item)),
    isDismissed: (item) => list.some((d) => d.sig === item.sig),
    joinError,
    pipelineError: pipelines.error,
  };
}

/** The dot before an item's kind: amber while something waits on you, grey for what's only done. */
const DOT: Record<NeedsItem["kind"], string> = { permission: "waiting", question: "waiting", typing: "waiting", pr: "waiting", wire: "waiting", plan: "waiting", join: "waiting", ticket: "waiting", merge: "waiting", finished: "idle" };

/** The actions that answer for you from the tray (needsActions): a teammate's ask to type, and a wire's Send. */
const ANSWERS = new Set(["allow", "deny", "send"]);

/** N (1) and ⇧N (-1), or null for any other key. */
const stepOf = (e: React.KeyboardEvent): 1 | -1 | null => (e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== "n" ? null : e.shiftKey ? -1 : 1);

/**
 * The Needs you button in the top bar and the tray it drops down (design D, "Inbox"): every item with its kind and
 * area, how long it has waited, what it is, and its actions (needsActions: Go there, a typing ask's Allow and Deny,
 * Dismiss, through the one model). The item the view is on (N's place) is lit and kept in the list's view. N and ⇧N
 * work in the tray as they do on the landscape, and keep it open; the view keeps the item clear of the tray. They work
 * on the button too, which has the keyboard after Esc. The last Dismiss can be undone from its foot. A dialog opening
 * puts the tray away.
 *
 * Allow and Deny let someone type in a session, and a wire's Send sends what waits at its gate, so they take only a
 * pointer's click, as the strip's do: never a Tab stop, Enter or Space (but Deny's); never on a row that has just
 * arrived, moved or changed what it's about, or within a double click of another answer or Dismiss; and the row's
 * buttons are off from the click until main has answered (and its row gone, once it has).
 * A ticket's Open and a request's Dismiss… only open a dialog, which changes nothing until its own button: they take
 * Go there's guard (none within a double click of an answer or Dismiss), and the dialog opening puts the tray away,
 * the keyboard coming back to the button when it closes.
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
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<NeedsItem | null>(null);
  const guardUntil = useRef(0);
  const guarded = () => Date.now() < guardUntil.current;
  // the rows answered and waiting on main, by what they show (`settle`: the item, its state and its buttons): a new
  // ask from the same teammate, or the same wire's pending blocked again, is a new row whose buttons are on
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const free = (settle: string) => setBusy((b) => new Set([...b].filter((x) => x !== settle)));
  // a row that arrived, moved, changed what it's about (its state) or what its buttons are is under a pointer aimed at
  // what was there
  const rowWait = useSettledRows(list, ".ny-item[data-settle]", (el) => el.dataset.settle);
  const { holdOff, heldOff } = useHeldOff();
  const close = (how?: "escape" | "outside" | "away") => {
    setOpen(false);
    // Escape gives the keyboard back to the button that opened it; Go there gives it to the landscape
    if (how === "escape") btn.current?.focus({ preventScroll: true });
  };
  const rows = state.items.map((item) => {
    const acts = actionsFor(item, close);
    return { item, acts, settle: `${item.id}|${item.sig}|${acts.map((a) => a.key).join(",")}` };
  });
  const shownRows = rows.map((r) => r.settle).join("\n");
  // an answered row goes, or changes, once main has it: let go of those no longer shown as they were
  useEffect(() => {
    const shown = new Set(shownRows.split("\n"));
    setBusy((b) => ([...b].every((s) => shown.has(s)) ? b : new Set([...b].filter((s) => shown.has(s)))));
  }, [shownRows]);
  useEffect(() => {
    if (!open) return;
    // the tray floats over the dialogs' backdrop; the keyboard comes back to the button, as the tray won't be there
    const onDialog = (e: Event) => {
      setOpen(false);
      if (btn.current) (e as CustomEvent<DialogOpened>).detail.handBack(btn.current);
    };
    document.addEventListener(DIALOG_OPENED, onDialog);
    return () => document.removeEventListener(DIALOG_OPENED, onDialog);
  }, [open]);
  // after the tray is placed, which is when the list gets its height
  useEffect(() => {
    if (!open || !current) return;
    const frame = requestAnimationFrame(() => list.current?.querySelector(`[data-item="${CSS.escape(current)}"]`)?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [open, current]);
  const n = state.items.length;
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const dir = stepOf(e);
    if (!dir || (e.target as Element).closest("input, textarea, select, [contenteditable]")) return;
    e.preventDefault();
    e.stopPropagation();
    onStep(dir, e.currentTarget.getBoundingClientRect());
  };
  /**
   * A Dismiss or an answer: the guard on (a click straight after is a double click's second), and the keyboard and the
   * tray's height held, as its row will go: that click lands in the tray however short it got, not on the landscape.
   */
  const hold = (e: React.MouseEvent) => {
    guardUntil.current = Date.now() + ANSWER_GUARD_MS;
    const tray = (e.currentTarget as HTMLElement).closest<HTMLElement>(".ny-tray");
    if (!tray) return;
    // its button leaves, or is turned off, with it: the keyboard moves to the tray first, so N and Esc still reach it
    tray.focus({ preventScroll: true });
    tray.style.minHeight = `${tray.getBoundingClientRect().height}px`;
    setTimeout(() => (tray.style.minHeight = ""), ANSWER_GUARD_MS);
  };
  const onDismiss = (item: NeedsItem, a: ModelAction, e: React.MouseEvent) => {
    if (guarded()) return;
    hold(e);
    a.onPick();
    setLast(item);
  };
  const onAnswer = (item: NeedsItem, a: ModelAction, settle: string, e: React.MouseEvent) => {
    if (!a.answer || busy.has(settle)) return;
    // a key's click gives only Deny, the safe answer; a pointer's, one aimed at a row that has settled (answerGuard.ts)
    if (keyClick(e)) {
      if (a.key !== "deny") return;
    } else {
      const wait = Math.max(guardUntil.current - Date.now(), rowWait(settle), cameraWait());
      if (wait > 0) {
        // let go, its button off until a click there would count: the keyboard stays with the tray as it goes off
        (e.currentTarget as HTMLElement).closest<HTMLElement>(".ny-tray")?.focus({ preventScroll: true });
        return holdOff(`${settle}:${a.key}`, wait);
      }
    }
    hold(e);
    setBusy((b) => new Set(b).add(settle));
    // answered, the row stays off until main's word takes it away; refused (said by the answer), it's back on
    a.answer().then(
      (error) => error && free(settle),
      (err: unknown) => {
        console.error(`[mockingbird] answering ${item.id} from Needs you failed:`, err);
        free(settle);
      }
    );
  };
  const onUndo = (item: NeedsItem, e: React.MouseEvent) => {
    if (guarded()) return;
    // Undo's button leaves with the dismissal
    (e.currentTarget as HTMLElement).closest<HTMLElement>(".ny-tray")?.focus({ preventScroll: true });
    state.undismiss(item);
    setLast(null);
  };
  const undoable = last && state.isDismissed(last) ? last : null;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`ny-btn ${n ? "on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          n
            ? `${needsLabel(n)}: permission prompts, questions, teammates asking to type, agents asking for pull requests, wires waiting at their gates, join requests, tickets at your stages, pull requests Mockingbird can't follow and finished sessions (N goes to the next on the landscape)`
            : state.joinError
              ? `Couldn't read the rooms' join requests: ${state.joinError}`
              : state.pipelineError
                ? `Couldn't read the ticket pipelines: ${state.pipelineError}`
                : "Nothing needs you right now"
        }
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          const dir = stepOf(e);
          if (!dir) return;
          e.preventDefault();
          onStep(dir, null);
        }}
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
          <div className="ny-list" ref={list}>
            {state.joinError && (
              <div className="ny-err" title={state.joinError}>
                Couldn't read the rooms' join requests: {state.joinError}
              </div>
            )}
            {state.pipelineError && (
              <div className="ny-err" title={state.pipelineError}>
                Couldn't read the ticket pipelines: {state.pipelineError}
              </div>
            )}
            {!n && !state.joinError && !state.pipelineError && <div className="ny-none">Nothing needs you right now.</div>}
            {rows.map(({ item, acts, settle }) => {
              return (
                <div key={item.id} className={`ny-item k-${item.kind} ${current === item.id ? "on" : ""}`} data-item={item.id} data-settle={settle}>
                  <div className="ny-meta">
                    <span className={`dot sm ${DOT[item.kind]}`} />
                    <span className="ny-kind" title={item.area === LOOSE_GROUP ? "In no area" : areaTitle(item.area)}>
                      {item.label ?? KIND_LABEL[item.kind]} · {item.area === LOOSE_GROUP ? "no area" : shortAreaName(item.area, areaTitle(item.area))}
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
                    {acts.map((a) => {
                      const answer = ANSWERS.has(a.key);
                      return (
                        <button
                          key={a.key}
                          type="button"
                          // the main action is filled only where something waits on you to answer it, as design D does;
                          // an answer, and another act (Show, Mark merged…), is outlined beside it, never filled
                          className={a.primary ? `ny-go ${DOT[item.kind] === "waiting" ? "fill" : ""}` : answer ? "ny-go ny-answer" : a.key.startsWith("dismiss") ? "ny-dismiss" : "ny-go"}
                          data-action={a.key}
                          disabled={a.disabled || busy.has(settle) || heldOff(`${settle}:${a.key}`)}
                          tabIndex={answer && a.key !== "deny" ? -1 : undefined}
                          aria-label={answer ? `${a.label}: ${item.text}` : undefined}
                          title={a.title}
                          onClick={(e) => (answer ? onAnswer(item, a, settle, e) : a.key === "dismiss" ? onDismiss(item, a, e) : !guarded() && a.onPick())}
                        >
                          {a.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          {state.dismissed > 0 && (
            <div className="ny-foot" title="A dismissed item comes back when its state changes: a new prompt, another turn ending, another request">
              <span>{plural(state.dismissed, "item")} dismissed</span>
              {undoable && (
                <button type="button" className="ny-undo" data-action="undo" title={`List “${undoable.text}” again`} onClick={(e) => onUndo(undoable, e)}>
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
