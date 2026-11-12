import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_TEMPLATE, carriesWork, type Wire, type WireSettings } from "../shared/wires";
import { AnchoredPopover } from "./Popover";
import { useDialogFocus } from "./Modal";
import { afterPause, typed } from "./keyArm";
import { ANSWER_SETTLE_MS, keyClick, useHeldOff } from "./answerGuard";
import { TEMPLATE_PARTS, WIRE_TYPE_NAME, defaultChoice, hasPart, togglePart, worktreeLine, type ChoiceEnd, type WireChoice } from "./wiresModel";

/**
 * Making wires and setting them (docs/landscape-wires.md, W4b): the type picker that comes up where a wire is dropped
 * (WireTypePicker.dc.html A), and a wire's settings (WireSettings.dc.html A), a form of its own so the send popover
 * (W4c) shows the same for an idle wire.
 *
 * Neither takes what wasn't aimed at it (keyArm.ts, answerGuard.ts): keys typed in a burst, with no pause, were typed
 * for what was there before (a terminal, a menu's row picked with Enter) and do nothing here, so a stray Enter makes no
 * wire and a stray Tab walks onto no button; in a text field they type as usual. A row that came up under the pointer
 * takes no click until it has been there ANSWER_SETTLE_MS, and is shown off meanwhile. Each gives the keyboard back to
 * what had it as it opened (useDialogFocus), never to a terminal that didn't.
 */

/** A key `e` typed in a burst, outside a text field: the popover swallows it. */
function burstKey(e: React.KeyboardEvent): boolean {
  if (!typed(e) || e.key === "Escape" || afterPause()) return false;
  return !(e.target as Element).closest?.("textarea, input:not([type=checkbox])");
}
/** How far the pointer moves from where it rested as the picker came up before hovering a row chooses it, in px. */
const HOVER_PX = 6;
const swallow = (e: React.KeyboardEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

/** A wire about to be made: its ends, where it was dropped (or the menu it was picked from), and the types it can be. */
export interface WirePick {
  from: ChoiceEnd;
  to: ChoiceEnd;
  /** On screen, the same object while it's open. */
  at: { x: number; y: number };
  choices: WireChoice[];
}

/** A row's line: a short stroke drawn as the wire of its type is (Inbox.dc.html's legend). */
function TypeLine({ type }: { type: WireChoice["type"] }) {
  return (
    <svg className={`wp-line t-${type}`} width="30" height="15" viewBox="0 0 30 15" aria-hidden="true">
      {type === "handoff" && (
        <>
          <path d="M1 11 C 10 11, 15 4, 25 4" />
          <path d="M21 0.8 L26.5 4 L22 8" />
        </>
      )}
      {type === "context" && <path d="M1 11 C 10 11, 16 4, 28 4" />}
      {type === "feedback" && (
        <>
          <path d="M25 1.5 C 27 16, 6 16, 6 4" />
          <path d="M2.5 7.5 L6 2.5 L9.8 7" />
        </>
      )}
      {type === "worktree" && <path d="M3 7.5 H26" />}
    </svg>
  );
}

/**
 * The type picker: "Builder → Tester · pick a type", a row for each type with its line, its name and what it does, or,
 * when it can't be made between these two, why. ↵ takes Handoff (or the first that can be made), ↑ ↓ choose another,
 * Esc cancels and the wire goes.
 */
export function WireTypePicker({ pick, onPick, onClose }: { pick: WirePick; onPick: (c: WireChoice) => void; onClose: () => void }) {
  useDialogFocus();
  const opened = useRef(Date.now());
  const first = defaultChoice(pick.choices);
  const [active, setActive] = useState(first ? pick.choices.indexOf(first) : -1);
  const [held, setHeld] = useState(false);
  const { holdOff, heldOff } = useHeldOff();
  const move = (by: 1 | -1) => {
    const n = pick.choices.length;
    for (let i = 1; i <= n; i++) {
      const at = (active + by * i + n) % n;
      if (!pick.choices[at].refused) return setActive(at);
    }
  };
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!typed(e) || e.key === "Escape") return;
    swallow(e);
    if (!afterPause()) return setHeld(e.key === "Enter" || held);
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Enter" && pick.choices[active] && !pick.choices[active].refused) onPick(pick.choices[active]);
  };
  const onRow = (c: WireChoice, e: React.MouseEvent) => {
    // ↵ is the picker's; a row's click is the pointer's, once the row has been where the pointer is a moment
    if (keyClick(e) || c.refused) return;
    const wait = ANSWER_SETTLE_MS - (Date.now() - opened.current);
    if (wait > 0) {
      (e.currentTarget as HTMLElement).closest<HTMLElement>(".wp-pick")?.focus({ preventScroll: true });
      return holdOff(c.type, wait);
    }
    onPick(c);
  };
  // the picker comes up under a resting pointer (at the drop, or where Connect…'s menu was): hover chooses a row only
  // once the rows have settled and the pointer has moved off from where it was first seen
  const rest = useRef<{ x: number; y: number } | null>(null);
  const aimed = useRef(false);
  const onHover = (i: number, e: React.MouseEvent) => {
    if (!aimed.current) {
      const p = (rest.current ??= { x: e.clientX, y: e.clientY });
      if (Date.now() - opened.current < ANSWER_SETTLE_MS || Math.hypot(e.clientX - p.x, e.clientY - p.y) < HOVER_PX) return;
      aimed.current = true;
    }
    if (!pick.choices[i].refused) setActive(i);
  };
  const takes = pick.choices[active];
  return (
    <AnchoredPopover anchor={pick.at} className="wp-pick" label={`Wire from ${pick.from.title} to ${pick.to.title}: pick a type`} onClose={onClose} onKeyDown={onKey}>
      <div className="wp-head">
        <span className="wp-ends">
          {pick.from.title} → {pick.to.title}
        </span>
        <span className="wp-hint">pick a type</span>
      </div>
      <div className="wp-rows">
        {pick.choices.map((c, i) => (
          <button
            key={c.type}
            type="button"
            tabIndex={-1}
            data-type={c.type}
            className={`wp-row${i === active ? " on" : ""}`}
            disabled={!!c.refused || heldOff(c.type)}
            title={c.refused ?? undefined}
            onMouseMove={(e) => onHover(i, e)}
            onClick={(e) => onRow(c, e)}
          >
            <TypeLine type={c.type} />
            <span className="wp-text">
              <span className="wp-name">{c.name}</span>
              <span className="wp-line-t">{c.refused ?? c.line}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="wp-foot">{held ? "Keys typed just before this opened don't pick: pause, then ↵" : `↵ takes ${takes?.name ?? WIRE_TYPE_NAME.handoff} · Esc cancels, and the wire goes`}</div>
    </AnchoredPopover>
  );
}


export interface WireSettingsProps {
  wire: Wire;
  fromTitle: string;
  toTitle: string;
  /** What it shows now, as drawn ("idle", "ready", "blocked"). */
  state: string;
  /** Either end is in a team room's area: what a context link reads can land on teammates' screens. */
  room: boolean;
  /** Why these settings can't go on it (settingsRefusal, which main checks again), or null. */
  refusal: (s: WireSettings) => string | null;
  /** Saves settings (wires:set); settles with why it was refused, or null. */
  onSet: (s: WireSettings) => Promise<string | null>;
  /** A feedback wire's count back to none used (wires:resetRounds); settles with why it was refused, or null. */
  onResetRounds: () => Promise<string | null>;
  onRemove: () => void;
  /** Why a change saved as the form went (its template or files, left as it closed) was refused: said where it was. */
  onLost: (why: string) => void;
  /** What's beside Remove: the send popover's Send now (W4c). */
  actions?: React.ReactNode;
}

/**
 * A wire's settings (WireSettings.dc.html A): its ends and type in the title; on a handoff or feedback wire what it
 * sends, with chips that add or take out the summary, ticket, diff and files, When, a feedback wire's Rounds with Reset,
 * and Send automatically; on a context link whether its reader gets tool output. Each change is saved as it's made
 * (wires:set), the template once it's left; what main refuses is said under it, or, once the form has gone, by `onLost`.
 * It shows the wire as main last said it.
 *
 * It takes no click that wasn't aimed at it: for ANSWER_SETTLE_MS after it opens (it can come up under the pointer, over
 * the menu row that opened it), and never a double click's second, every click on it is let go before it reaches a
 * control, a checkbox's or its label's included, and its controls show off meanwhile.
 */
export function WireSettingsForm({ wire, fromTitle, toTitle, state, room, refusal, onSet, onResetRounds, onRemove, onLost, actions }: WireSettingsProps) {
  const saved = wire.template ?? DEFAULT_TEMPLATE;
  const [draft, setDraft] = useState(saved);
  const [files, setFiles] = useState((wire.files ?? []).join(", "));
  const [err, setErr] = useState<string | null>(null);
  const dirty = useRef(false);
  const alive = useRef(true);
  const now = useRef({ draft, onSet, onLost, saved });
  now.current = { draft, onSet, onLost, saved };
  const form = useRef<HTMLDivElement>(null);
  const { holdOff, heldOff } = useHeldOff();
  // before the browser paints it, so a double click's second, close behind, finds the guard there
  useLayoutEffect(() => {
    const opened = Date.now();
    holdOff("settle", ANSWER_SETTLE_MS);
    // capturing on the form, so a click let go never reaches a control (a checkbox isn't changed, a label passes nothing on)
    const aimed = (e: MouseEvent) => {
      if (e.detail >= 2 || (e.detail >= 1 && Date.now() - opened < ANSWER_SETTLE_MS)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const el = form.current;
    el?.addEventListener("click", aimed, true);
    return () => el?.removeEventListener("click", aimed, true);
  }, [holdOff]);
  // what main says changes the field only while nothing typed there is waiting to be saved
  useEffect(() => {
    if (!dirty.current) setDraft(saved);
  }, [saved]);
  useEffect(() => setFiles((wire.files ?? []).join(", ")), [JSON.stringify(wire.files ?? [])]);
  /** Saves `s`; what main refuses is said under the form, or by onLost once the form has gone (a field left as it closed). */
  const set = (s: WireSettings, refused?: () => void) => {
    const no = refusal(s);
    if (no) {
      setErr(no);
      return refused?.();
    }
    void onSet(s).then((why) => {
      if (!alive.current) return why && now.current.onLost(why);
      setErr(why);
      if (why) refused?.();
    });
  };
  const saveTemplate = (t: string, refused?: () => void) => {
    dirty.current = false;
    if (t === now.current.saved) return;
    set({ template: t === DEFAULT_TEMPLATE ? null : t }, refused);
  };
  // a template still being typed when the settings close is saved as they go
  useEffect(
    () => () => {
      alive.current = false;
      const n = now.current;
      if (dirty.current && n.draft !== n.saved) void n.onSet({ template: n.draft === DEFAULT_TEMPLATE ? null : n.draft }).then((why) => why && n.onLost(why));
    },
    []
  );
  const auto = refusal({ gate: "automatic" });
  const carries = carriesWork(wire.type);
  return (
    <div ref={form} className={`wr-form${heldOff("settle") ? " held" : ""}`}>
      <div className="wr-head">
        <span className="wr-ends">
          {fromTitle} → {toTitle}
        </span>
        <span className="wr-kind">
          {WIRE_TYPE_NAME[wire.type].toLowerCase()} · {state}
        </span>
      </div>
      {carries && (
        <>
          <div className="wr-label">Sends</div>
          <textarea
            className="wr-tpl"
            aria-label="What it sends"
            rows={Math.min(6, Math.max(2, draft.split("\n").length))}
            value={draft}
            onChange={(e) => {
              dirty.current = true;
              setDraft(e.target.value);
            }}
            onBlur={() => saveTemplate(draft)}
          />
          <div className="wr-chips">
            {TEMPLATE_PARTS.map((p) => {
              const on = hasPart(draft, p);
              return (
                <button
                  key={p}
                  type="button"
                  className={`wr-chip${on ? " on" : ""}`}
                  aria-pressed={on}
                  title={on ? `Take {${p}} out of what it sends` : `Add {${p}} to what it sends`}
                  onClick={() => {
                    const next = togglePart(draft, p);
                    setDraft(next);
                    // refused, what's drawn goes back to what it sends
                    saveTemplate(next, () => setDraft(now.current.saved));
                  }}
                >
                  {on ? `+ ${p}` : `add ${p}`}
                </button>
              );
            })}
          </div>
          {hasPart(draft, "files") && (
            <label className="wr-row">
              <span className="wr-label">Files</span>
              <input
                className="wr-files"
                placeholder="paths in its folder, comma between"
                value={files}
                onChange={(e) => setFiles(e.target.value)}
                onBlur={() => {
                  const list = files.split(",").map((f) => f.trim()).filter(Boolean);
                  if (JSON.stringify(list) !== JSON.stringify(wire.files ?? [])) set({ files: list.length ? list : null });
                }}
              />
            </label>
          )}
          <div className="wr-row">
            <span className="wr-label">When</span>
            <span className="wr-seg" role="group" aria-label="When it sends">
              <button type="button" aria-pressed={wire.when === "finished"} onClick={() => set({ when: "finished" })}>
                When it says it's finished
              </button>
              <button type="button" aria-pressed={wire.when === "manual"} onClick={() => set({ when: "manual" })}>
                Only when I send
              </button>
              {wire.when === "pr-merged" && (
                <button type="button" aria-pressed>
                  When its PR merges
                </button>
              )}
            </span>
          </div>
          {wire.rounds && (
            <div className="wr-row">
              <span className="wr-label">Rounds</span>
              <span className="wr-step">
                <button type="button" aria-label="Fewer rounds" disabled={wire.rounds.limit <= 1} onClick={() => set({ limit: wire.rounds!.limit - 1 })}>
                  −
                </button>
                <span className="wr-n">{wire.rounds.limit}</span>
                <button type="button" aria-label="More rounds" onClick={() => set({ limit: wire.rounds!.limit + 1 })}>
                  +
                </button>
              </span>
              <span className="wr-used">{wire.rounds.used} used</span>
              <button type="button" className="wr-link" disabled={!wire.rounds.used} onClick={() => void onResetRounds().then(setErr)}>
                Reset
              </button>
            </div>
          )}
        </>
      )}
      {wire.type === "context" && (
        <>
          <div className="wr-say">
            {toTitle} can read {fromTitle}. Nothing is pushed.
          </div>
          <label className="wr-check">
            <input type="checkbox" checked={wire.toolOutput !== false} onChange={(e) => set({ toolOutput: e.target.checked })} />
            Include tool output
          </label>
          {room && <div className="wr-say">In a team room, what it reads can land on teammates' screens.</div>}
        </>
      )}
      {wire.type === "worktree" && (
        <div className="wr-say">
          {worktreeLine(fromTitle, toTitle)}
        </div>
      )}
      {err && (
        <div className="wr-err" role="alert">
          {err}
        </div>
      )}
      <div className="wr-foot">
        {actions}
        <button type="button" className="wr-btn" onClick={onRemove}>
          Remove
        </button>
        <span className="wr-spacer" />
        {carries && (
          <label className="wr-check" title={auto ?? "Send without asking when it's ready: never in a team room's area, never reopening a stopped workspace"}>
            <input type="checkbox" checked={wire.gate === "automatic"} disabled={!!auto && wire.gate !== "automatic"} onChange={(e) => set({ gate: e.target.checked ? "automatic" : "ask" })} />
            Send automatically
          </label>
        )}
      </div>
    </div>
  );
}

/** A wire's settings, over everything where its right-click was (Settings…). */
export function WireSettingsPopover({ at, onClose, ...form }: WireSettingsProps & { at: { x: number; y: number }; onClose: () => void }) {
  useDialogFocus();
  return (
    <AnchoredPopover anchor={at} className="wr-pop" label={`Wire settings: ${form.fromTitle} → ${form.toTitle}`} onClose={onClose} onKeyDown={(e) => burstKey(e) && swallow(e)}>
      <WireSettingsForm {...form} />
    </AnchoredPopover>
  );
}
