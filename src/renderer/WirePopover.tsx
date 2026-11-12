import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isErr, type IpcResult, type TicketPipeline } from "../shared/types";
import { AnchoredPopover } from "./Popover";
import { useDialogFocus } from "./Modal";
import { keyboardNowhere } from "./keyArm";
import { ANSWER_SETTLE_MS, EARLY_KEYS_HINT, keyClick, useAimedKeys, useHeldOff, useSettledRows } from "./answerGuard";
import { usePipelines } from "./TicketPipeline";
import { markMergedQuestion, prLabel } from "./ticketPipelineModel";
import { WireSettingsForm, type WireSettingsProps } from "./WireMaking";
import { mergePrsOf, type GateView } from "./wiresModel";

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
 *   Send), shown off meanwhile, a key's click as much as a pointer's;
 * - keys typed in a burst that began before it opened press nothing here, whatever has the keyboard in it, until a pause
 *   (useAimedKeys); a key's click counts only as Enter or Space pressed (not held) on that button, and a click made by
 *   code never;
 * - a newer finish takes the keyboard off the button it was on, and a face that changes under it keeps it in the
 *   popover: what Enter pressed next was aimed at has gone;
 * - one act at a time: Send is off from its click until main answers, so Send twice sends once; a press on a dialog it
 *   opened (Send's cost question) leaves it open, and what an act comes to once it has closed anyway is said
 *   (`onLost`);
 * - it takes the keyboard as it opens and gives it back as it closes, never to a terminal: there the landscape gets it.
 */
export interface WirePopoverProps {
  /** Where on screen: under the wire's gate dot. The same object while it's open. */
  at: { x: number; y: number };
  view: GateView;
  /** The wire's settings, as Settings… shows them, and its ends' titles: the face of a wire with nothing at its gate. */
  form: WireSettingsProps;
  /** Its source's ticket: whose record (pipeline.json) holds the pull requests a blocked merge waits on. */
  ticket: string | null;
  /** Send `body` as pending `pendingId` (`again`: Send again, after it may have arrived); settles with why nothing was sent, or null. */
  onSend: (pendingId: string, body: string, again: boolean) => Promise<string | null>;
  /** Say what may have arrived did; settles with why not, or null. */
  onMarkSent: (pendingId: string) => Promise<string | null>;
  /** One more round, at the limit; settles with why not, or null. */
  onMoreRounds: () => Promise<string | null>;
  /** Why an act started here didn't go, once the popover has closed: said elsewhere, as it can't be here. */
  onLost: (why: string) => void;
  /** Where the keyboard goes as it closes when it would go back to a terminal. */
  home: () => HTMLElement | null;
  onClose: () => void;
}

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

export function WirePopover({ at, view, form, ticket, onSend, onMarkSent, onMoreRounds, onLost, home, onClose }: WirePopoverProps) {
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
  /** The pull request Mark merged… is asking about, by url: the question goes with the face it was asked on. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [face, setFace] = useState(view.face);
  if (face !== view.face) {
    setFace(view.face);
    setConfirming(null);
  }
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const { onKeyDown, keyAimed, stale } = useAimedKeys("button[data-act]");
  const box = useRef<HTMLDivElement>(null);
  const pop = () => box.current?.closest<HTMLElement>(".wg-pop") ?? null;
  const settle = useSettledRows(box, "button[data-act]", (el) => `${el.dataset.act}:${shown.id}`, (el) => el.offsetTop * 10_000 + el.offsetLeft);
  const { holdOff, heldOff } = useHeldOff();
  // the pull requests a blocked merge waits on are in its source's ticket record (pipeline.json)
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

  /** A button going off (held, or while its act runs) drops the keyboard it took: the popover keeps it. */
  const keepKeys = () => pop()?.focus({ preventScroll: true });
  // a newer finish takes the keyboard off the button it was on: Enter pressed there next was aimed at the text before
  const shownWas = useRef(shown.id);
  useLayoutEffect(() => {
    if (shownWas.current === shown.id) return;
    shownWas.current = shown.id;
    const at = document.activeElement;
    if (at?.closest("button") && box.current?.contains(at)) keepKeys();
  }, [shown.id]);
  // a face changing under the keyboard (the button it was on gone) leaves it with the popover, not on the page
  useEffect(() => {
    const el = pop();
    if (!el) return;
    const out = (e: FocusEvent) => {
      if (e.relatedTarget) return;
      requestAnimationFrame(() => {
        if (el.isConnected && keyboardNowhere()) el.focus({ preventScroll: true });
      });
    };
    el.addEventListener("focusout", out);
    return () => el.removeEventListener("focusout", out);
  }, []);
  /** Button `key`'s click, aimed: it runs `run` once, with nothing else running, and closes after when `closes`. */
  const act = (key: string, run: () => Promise<string | null>, closes = false) => (e: React.MouseEvent<HTMLButtonElement>) => {
    // a key's click is checked, and its key spent, even when nothing else is let through
    if (!keyAimed(e) || busy.current) return;
    const wait = settle(`${key}:${shown.id}`);
    if (wait > 0) {
      keepKeys();
      return holdOff(key, wait);
    }
    keepKeys();
    busy.current = true;
    setWorking(key);
    setErr(null);
    void run()
      .catch((x: unknown) => `Couldn't do that: ${x instanceof Error ? x.message : String(x)}`)
      .then((why) => {
        if (!alive.current) return void (why && onLost(why));
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
      {stale && <div className="wg-hint">{EARLY_KEYS_HINT}</div>}
    </>
  );

  let body: React.ReactNode;
  if (view.face === "settings") {
    const prs =view.merge && ticket ? mergePrsOf(pipes[ticket], view.merge.prs) : [];
    const asking = prs.find((x) => x.url === confirming) ?? null;
    const about = (
      <>
        {why}
        {view.merge && ticket && (
          <div className="wg-acts">
            {btn("check", "Check now", "Checking…", act("check", () => pipeCall("check the pull request", () => window.mb.pipelinePrCheck(ticket, prs.length === 1 ? prs[0].url : undefined))))}
            {!asking &&
              prs.map((x) => (
                <button key={x.url} type="button" className="wr-btn" disabled={!!working} onClick={() => setConfirming(x.url)}>
                  {prs.length > 1 ? `Mark ${prLabel(x)} merged…` : "Mark merged…"}
                </button>
              ))}
          </div>
        )}
        {asking && ticket && (
          <div className="wg-confirm">
            <div className="wg-q">{markMergedQuestion(asking)}</div>
            <div className="wg-acts">
              {btn("mark", "Mark merged", "Marking…", act("mark", () => pipeCall("mark it merged", () => window.mb.pipelinePrMarkMerged(ticket, asking.url))), { main: true })}
              <button type="button" className="wr-btn" onClick={() => setConfirming(null)}>
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
    <AnchoredPopover
      anchor={at}
      className={`wr-pop wg-pop f-${view.face} t-${w.type}`}
      label={`Wire ${form.fromTitle} → ${form.toTitle}`}
      onClose={(how) => {
        // a press on a dialog opened by what's running (Send's cost question) is the dialog's: it stays for the answer
        if (how === "outside" && busy.current && document.querySelector(".modal-back")) return;
        onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div ref={box} className={`wg-${view.face}`} onClickCapture={view.face === "settings" ? undefined : onClickFirst}>
        {body}
      </div>
    </AnchoredPopover>
  );
}
