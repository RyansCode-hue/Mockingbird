import React, { useRef, useState } from "react";
import { isErr, type IpcResult, type TicketPipeline } from "../shared/types";
import { AnchoredPopover } from "./Popover";
import { useDialogFocus } from "./Modal";
import { afterPause, typed } from "./keyArm";
import { ANSWER_SETTLE_MS, keyClick, useHeldOff, useSettledRows } from "./answerGuard";
import { usePipelines } from "./TicketPipeline";
import { markMergedQuestion } from "./ticketPipelineModel";
import { WireSettingsForm, type WireSettingsProps } from "./WireMaking";
import { blockingPr, type GateView } from "./wiresModel";

/**
 * The send popover (docs/landscape-wires.md, W4c; Cards.dc.html:162–170, WireSettings.dc.html A), opened by a wire's gate
 * dot or by Show, over everything at screen size whatever the zoom. Its faces (wiresModel's gateView): what waits at the
 * gate, editable, with Send and Not yet (its other end closed or exited: Send reopens or resumes it, its cost asked
 * first); a feedback wire at its limit, with One more round; what may have arrived, with Send again and Mark sent; and
 * otherwise the wire's settings, saying why it's blocked or what it waits for, a blocked merge with Check now and Mark
 * merged… What Send sends is the text shown, under the pending it was shown for: a newer finish arriving replaces both
 * at once, and says so.
 *
 * What it does is aimed (keyArm.ts, answerGuard.ts):
 * - nothing in it takes a click for ANSWER_SETTLE_MS after it opens (the click that opened it, a double click's second
 *   landing where it flipped up under the pointer: the settings face's form holds its own); its own buttons, Send among
 *   them, also not until they've stayed put that long after content moved (a newer finish, One more round turning into
 *   Send), shown off meanwhile;
 * - keys typed in a burst that began before it opened press nothing here, whatever has the keyboard in it, until a pause;
 *   a key's click counts only as Enter or Space pressed (not held) on that button, and a click made by code never;
 * - one act at a time: Send is off from its click until main answers, so Send twice sends once;
 * - it takes the keyboard as it opens and gives it back as it closes, never to a terminal: there the landscape gets it.
 */
export interface WirePopoverProps {
  /** Where on screen: under the wire's gate dot. The same object while it's open. */
  at: { x: number; y: number };
  view: GateView;
  /** The wire's settings, as Settings… shows them, and its ends' titles: the face of a wire with nothing at its gate. */
  form: WireSettingsProps;
  /** Its source's ticket and branch: where the pull request a blocked merge waits on is found. */
  source: { ticket: string | null; branch: string | null };
  /** Send `body` as pending `pendingId` (`again`: Send again, after it may have arrived); settles with why nothing was sent, or null. */
  onSend: (pendingId: string, body: string, again: boolean) => Promise<string | null>;
  /** Say what may have arrived did; settles with why not, or null. */
  onMarkSent: (pendingId: string) => Promise<string | null>;
  /** One more round, at the limit; settles with why not, or null. */
  onMoreRounds: () => Promise<string | null>;
  /** Where the keyboard goes as it closes when it would go back to a terminal. */
  home: () => HTMLElement | null;
  onClose: () => void;
}

const swallow = (e: React.KeyboardEvent) => {
  e.preventDefault();
  e.stopPropagation();
};
/** A pipeline call's word: why it didn't go, or null. */
async function pipeCall(what: string, call: () => Promise<IpcResult<TicketPipeline>>): Promise<string | null> {
  try {
    const r = await call();
    return isErr(r) ? `Couldn't ${what}: ${r.error}` : null;
  } catch (err) {
    console.error(`[mockingbird] ${what}:`, err);
    return `Couldn't ${what}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function WirePopover({ at, view, form, source, onSend, onMarkSent, onMoreRounds, home, onClose }: WirePopoverProps) {
  useDialogFocus({
    handsBack: (to) => {
      if (!to.closest(".xterm")) return true;
      home()?.focus({ preventScroll: true });
      return false;
    },
  });
  const w = form.wire;
  const pending = view.pendingId && w.pending?.id === view.pendingId ? w.pending : null;
  // what's shown and the pending it's for are one: a newer finish replaces both, and says so
  const [shown, setShown] = useState({ id: pending?.id ?? null, body: pending?.body ?? "", edited: false, note: null as string | null });
  if ((pending?.id ?? null) !== shown.id)
    setShown({
      id: pending?.id ?? null,
      body: pending?.body ?? "",
      edited: false,
      note: shown.id && pending ? `${form.fromTitle} finished again: this is what it sends now${shown.edited ? ", and your edit of the earlier one was set aside" : ""}.` : null,
    });
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [stale, setStale] = useState(false);
  const busy = useRef(false);
  /** A key typed after a pause since it opened: typing from then on is the user's for it. */
  const mine = useRef(false);
  /** The button Enter or Space was just pressed on, whose click that key makes. */
  const keyed = useRef<Element | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const settle = useSettledRows(box, "button[data-act]", (el) => `${el.dataset.act}:${shown.id}`, (el) => el.offsetTop * 10_000 + el.offsetLeft);
  const { holdOff, heldOff } = useHeldOff();
  // a blocked merge's pull request is the source's ticket record's (pipeline.json)
  const pipes = usePipelines();

  const opened = useRef(Date.now());
  /**
   * A click made as it opened (a double click's second on the dot, landing on it where it flipped up under the pointer)
   * presses nothing in it for ANSWER_SETTLE_MS: its own buttons (`act`) are held off for that and after content moves;
   * this holds the rest of its faces' (Not yet, Send automatically). The settings face is W4b's form, which holds its own.
   */
  const onClickFirst = (e: React.MouseEvent<HTMLDivElement>) => {
    if (keyClick(e) || (e.target as Element).closest?.("button[data-act]")) return;
    if (Date.now() - opened.current >= ANSWER_SETTLE_MS) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!typed(e) || e.key === "Escape") return;
    if (afterPause() && !e.repeat) mine.current = true;
    if (!mine.current) {
      swallow(e);
      return setStale(true);
    }
    setStale(false);
    const b = (e.target as Element).closest?.("button[data-act]") ?? null;
    keyed.current = (e.key === "Enter" || e.key === " ") && !e.repeat && b ? b : null;
  };
  /** A button going off (held, or while its act runs) drops the keyboard it took: the popover keeps it. */
  const keepKeys = () => box.current?.closest<HTMLElement>(".wg-pop")?.focus({ preventScroll: true });
  /** Button `key`'s click, aimed: it runs `run` once, with nothing else running, and closes after when `closes`. */
  const act = (key: string, run: () => Promise<string | null>, closes = false) => (e: React.MouseEvent<HTMLButtonElement>) => {
    if (busy.current) return;
    if (keyClick(e)) {
      if (keyed.current !== e.currentTarget) return;
      keyed.current = null;
    } else {
      const wait = settle(`${key}:${shown.id}`);
      if (wait > 0) {
        keepKeys();
        return holdOff(key, wait);
      }
    }
    keepKeys();
    busy.current = true;
    setWorking(key);
    setErr(null);
    void run()
      .catch((x: unknown) => `Couldn't do that: ${x instanceof Error ? x.message : String(x)}`)
      .then((why) => {
        if (!why && closes) return onClose();
        busy.current = false;
        setWorking(null);
        setErr(why);
      });
  };
  const btn = (key: string, label: string, doing: string, onClick: (e: React.MouseEvent<HTMLButtonElement>) => void, o: { main?: boolean; off?: boolean } = {}) => (
    <button type="button" data-act={key} className={`wr-btn${o.main ? " wg-main" : ""}`} disabled={!!working || o.off || heldOff(key)} onClick={onClick}>
      {working === key ? doing : label}
    </button>
  );
  const notYet = (
    <button type="button" className="wr-btn" onClick={() => onClose()}>
      Not yet
    </button>
  );
  const why = view.why ? <div className={`wg-why ${view.face === "ready" ? "t-ready" : view.face === "settings" && form.state !== "blocked" ? "t-quiet" : "t-blocked"}`}>{view.why}</div> : null;
  const said = (
    <>
      {err && (
        <div className="wr-err" role="alert">
          {err}
        </div>
      )}
      {stale && <div className="wg-hint">Keys typed just before this opened don't press anything here: pause, then go on.</div>}
    </>
  );

  let body: React.ReactNode;
  if (view.face === "settings") {
    const pr = view.merge && source.ticket ? blockingPr(pipes[source.ticket], source.branch) : null;
    const ticket = source.ticket;
    const about = (
      <>
        {why}
        {view.merge && ticket && (
          <div className="wg-acts">
            {btn("check", "Check now", "Checking…", act("check", () => pipeCall("check the pull request", () => window.mb.pipelinePrCheck(ticket, pr?.url))))}
            {pr && !confirming && (
              <button type="button" className="wr-btn" disabled={!!working} onClick={() => setConfirming(true)}>
                Mark merged…
              </button>
            )}
          </div>
        )}
        {pr && confirming && (
          <div className="wg-confirm">
            <div className="wg-q">{markMergedQuestion(pr)}</div>
            <div className="wg-acts">
              {btn("mark", "Mark merged", "Marking…", act("mark", () => pipeCall("mark it merged", () => window.mb.pipelinePrMarkMerged(ticket!, pr.url))), { main: true })}
              <button type="button" className="wr-btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {said}
      </>
    );
    body = <WireSettingsForm {...form} about={about} />;
  } else {
    const ready = view.face === "ready";
    const auto = form.refusal({ gate: "automatic" });
    const field =
      view.face === "limit" ? (
        <pre className="wr-tpl wg-body" aria-label="What's waiting">
          {shown.body}
        </pre>
      ) : (
        <textarea
          className="wr-tpl wg-body"
          aria-label="What it sends"
          rows={Math.min(8, Math.max(3, shown.body.split("\n").length))}
          value={shown.body}
          onChange={(e) => setShown({ ...shown, body: e.target.value, edited: true })}
        />
      );
    body = (
      <div className="wr-form">
        <div className="wr-head">
          <span className="wr-ends">
            {form.fromTitle} → {form.toTitle}
          </span>
          <span className="wr-kind wg-kind">{view.kind}</span>
        </div>
        {why}
        {view.starts && view.face !== "limit" && (
          <div className="wg-why t-quiet">
            “{form.toTitle}” {view.starts === "reopen" ? "is closed: sending reopens it" : "has exited: sending resumes it"}, which rereads its conversation.
          </div>
        )}
        {shown.note && <div className="wg-why t-ready">{shown.note}</div>}
        <div className="wr-label">{view.face === "limit" ? "Waiting" : "Sends"}</div>
        {field}
        {!!pending?.flags.length && (
          <ul className="wg-flags">
            {pending.flags.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
        <div className="wr-foot">
          {ready && btn("send", "Send", "Sending…", act("send", () => onSend(shown.id!, shown.body, false), true), { main: true, off: !shown.body.trim() })}
          {view.face === "unconfirmed" && (
            <>
              {btn("again", "Send again", "Sending…", act("again", () => onSend(shown.id!, shown.body, true), true), { main: true, off: !shown.body.trim() })}
              {btn("marksent", "Mark sent", "Marking…", act("marksent", () => onMarkSent(shown.id!), true))}
            </>
          )}
          {view.face === "limit" && btn("more", "One more round", "Allowing…", act("more", onMoreRounds), { main: true })}
          {notYet}
          <span className="wr-spacer" />
          {ready && (
            <label className="wr-check" title={auto ?? "Send without asking when it's ready: never in a team room's area, never reopening a stopped workspace"}>
              <input
                type="checkbox"
                checked={w.gate === "automatic"}
                disabled={!!auto && w.gate !== "automatic"}
                onChange={(e) => {
                  const st = { gate: e.target.checked ? ("automatic" as const) : ("ask" as const) };
                  const no = form.refusal(st);
                  if (no) return setErr(no);
                  void form.onSet(st).then(setErr);
                }}
              />
              Send automatically
            </label>
          )}
        </div>
        {said}
      </div>
    );
  }

  return (
    <AnchoredPopover anchor={at} className={`wr-pop wg-pop f-${view.face} t-${w.type}`} label={`Wire ${form.fromTitle} → ${form.toTitle}`} onClose={() => onClose()} onKeyDown={onKey}>
      <div ref={box} className={`wg-${view.face}`} onClickCapture={view.face === "settings" ? undefined : onClickFirst}>
        {body}
      </div>
    </AnchoredPopover>
  );
}
