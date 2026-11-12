import React, { useEffect, useRef, useState } from "react";
import { isErr } from "../shared/types";
import type { WireVerdict } from "../shared/wires";
import { AnchoredPopover } from "./Popover";
import { useDialogFocus } from "./Modal";
import { keyboardNowhere } from "./keyArm";
import { ANSWER_SETTLE_MS, EARLY_KEYS_HINT, keyClick, useAimedKeys, useHeldOff, useSettledRows } from "./answerGuard";
import { whose, type FinishLine } from "./wiresModel";

/** What the landscape lends what offers its wires outside it (main.tsx's Needs you items): their popovers, opened. */
export interface WireActs {
  /** Wire `id`'s send popover (W4c's Show); why it can't open (the wire has gone), when it can't. */
  show: (id: string) => string | null;
  /**
   * Send what waits at wire `id`'s gate as it is, only while that's still pending `pendingId` (namedSendRefusal; the send
   * popover shows what's there otherwise); settles with why nothing was sent, or null.
   */
  send: (id: string, pendingId: string) => Promise<string | null>;
  /** Session `id`'s Finish step popover; why it can't open, when it can't. */
  finish: (id: string) => string | null;
}

export interface FinishStepProps {
  /** Where on screen: under what opened it. The same object while it's open. */
  at: { x: number; y: number };
  /** The session whose step it finishes. */
  id: string;
  /** Its title. */
  title: string;
  /**
   * When its latest turn ended (SessionInfo.finishedAt): a new one is a new latest message, read again, and what Finish
   * step does is new, so its button is held again.
   */
  finishedAt: number | null;
  /** Whether finishing it needs a verdict: it has a feedback wire out (verdictDue). */
  verdictDue: boolean;
  /** Why it can't be finished now (it's working again: its latest message isn't what the step comes to), or null. */
  blocked: string | null;
  /** What finishing with `verdict` does along each wire out (finishLines), by the wire book as it is now; null while it can't be read. */
  lines: (verdict: WireVerdict | undefined) => FinishLine[] | null;
  /** Finish it with `summary` and `verdict` as shown (main's wires:finish); settles with why nothing was finished, or null. */
  onFinish: (summary: string, verdict: WireVerdict | undefined) => Promise<string | null>;
  /** Why a finish started here didn't go, once the popover has closed: said elsewhere, as it can't be here. */
  onLost: (why: string) => void;
  /** Where the keyboard goes as it closes when it would go back to a terminal. */
  home: () => HTMLElement | null;
  onClose: () => void;
}

/** Its latest message as main read it (wires:lastMessage), while it's being read, or why it couldn't be. */
type Latest = { reading: true } | { reading: false; text: string; why: string | null; cut: boolean };

/**
 * What the summary is: its agent's latest message as read (`agent`), changed here (`yours`), or changes kept from an
 * earlier opening (`kept`). `base` is the agent's text the changes began from.
 */
type Summary = { body: string; from: "agent" | "yours" | "kept"; base: string | null };

/**
 * Changes to a step's summary, by session, kept until it's finished or they're set aside for its latest message: an
 * outside press, a wheel, Cancel or the popover going (its wires removed) doesn't lose them.
 */
const drafts = new Map<string, { body: string; base: string | null }>();

/**
 * The Finish step popover (docs/landscape-wires.md, W5; WireFinishStep.dc.html A): "Finish Reviewer's step", the summary
 * from its latest message, editable and marked as its agent's until changed; the verdict when one's due; where each wire
 * out goes and what finishing does along it ("its gate opens · round 2 of 3", "blocked till approve, then sends
 * itself") and to what's there now ("replaces what waits"); Finish step and Cancel. Nothing moves until Finish step is
 * pressed, and what it sends is what's shown: the summary as it stands, the verdict picked.
 *
 * Each turn that ends while it's open is a new latest message, read in again: the agent's text follows it; changes of
 * yours stay, the newer message offered beside them. Changes are kept for that session until it's finished or they're
 * set aside for its latest message, whatever closes the popover meanwhile.
 *
 * What it does is aimed, as the send popover's is (W4c; keyArm.ts, answerGuard.ts):
 * - nothing in it takes a click for ANSWER_SETTLE_MS after it opens, and Finish step none until it has stayed put that
 *   long after what it does changed (a verdict picked, a wire drawn or removed, a turn ended, the summary read in or set
 *   aside for the latest, it going on or off), shown off meanwhile, a key's click as much as a pointer's;
 * - keys typed in a burst that began before it opened press nothing here until a pause (useAimedKeys); a key's click
 *   counts only as Enter or Space pressed (not held) on that button, and a click made by code never;
 * - one finish at a time: Finish step is off from its click until main answers; what it comes to once the popover has
 *   closed anyway is said (`onLost`);
 * - it takes the keyboard as it opens and gives it back as it closes, never to a terminal: there the landscape gets it.
 */
export function FinishStepPopover({ at, id, title, finishedAt, verdictDue, blocked, lines, onFinish, onLost, home, onClose }: FinishStepProps) {
  useDialogFocus({
    handsBack: (to) => {
      if (!to.closest(".xterm")) return true;
      home()?.focus({ preventScroll: true });
      return false;
    },
  });
  const [latest, setLatest] = useState<Latest>({ reading: true });
  const [summary, setSummaryState] = useState<Summary>(() => {
    const kept = drafts.get(id);
    return kept ? { body: kept.body, from: "kept", base: kept.base } : { body: "", from: "agent", base: null };
  });
  /** The summary, and the draft kept with it: changes are kept, the agent's own text isn't. */
  const setSummary = (s: Summary) => {
    if (s.from === "agent") drafts.delete(id);
    else drafts.set(id, { body: s.body, base: s.base });
    setSummaryState(s);
  };
  const [verdict, setVerdict] = useState<WireVerdict | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  // what it starts from: the latest message, whole, as main reads it, read again as each turn ends; a failure is said,
  // and the field is the user's to fill. Only the last read asked for counts.
  const reads = useRef(0);
  useEffect(() => {
    const n = ++reads.current;
    setLatest({ reading: true });
    void Promise.resolve(window.mb.wiresLastMessage(id))
      .then(
        (r) => (isErr(r) ? { text: "", why: `Couldn't read its latest message: ${r.error}`, cut: false } : { text: r.text ?? "", why: r.text ? null : `It has no message to start from (${r.why ?? "none was found"})`, cut: !!r.cut }),
        (e: unknown) => ({ text: "", why: `Couldn't read its latest message: ${e instanceof Error ? e.message : String(e)}`, cut: false })
      )
      .then((m) => {
        if (!alive.current || n !== reads.current) return;
        if (m.why) console.warn(`[mockingbird] Finish step for ${id}: ${m.why}`);
        setLatest({ reading: false, ...m });
        // the agent's text follows its latest message; changes stay, and a newer message is offered beside them
        setSummaryState((s) => (s.from === "agent" ? { body: m.text, from: "agent", base: null } : s));
      });
  }, [id, finishedAt]);
  const latestText = latest.reading ? null : latest.text;
  // changes made from an earlier message than the one read now
  const newer = summary.from !== "agent" && !!latestText && latestText !== summary.base;
  const useLatest = () => latestText !== null && setSummary({ body: latestText, from: "agent", base: null });

  const { onKeyDown, keyAimed, stale } = useAimedKeys("button[data-act]");
  const box = useRef<HTMLDivElement>(null);
  const pop = () => box.current?.closest<HTMLElement>(".fs-pop") ?? null;
  const shown = verdictDue && !verdict ? null : lines(verdict);
  const body = summary.body.trim();
  const off = blocked ?? (latest.reading ? "Its latest message is being read" : !body ? "Say what this step did first" : verdictDue && !verdict ? "Pick a verdict first" : !shown ? "The wires can't be read right now" : null);
  // what Finish step does, as shown: a change to it is a button that wasn't there, held till it has stayed put. A turn
  // ended since (a new latest message), it going on or off, or what the summary is (the agent's, yours, the newer one)
  // each count; typing on in your own changes doesn't
  const does = [
    verdict ?? "-",
    finishedAt ?? "-",
    off ?? "on",
    summary.from === "agent" ? `agent:${latest.reading ? "reading" : "read"}` : summary.from,
    shown ? shown.map((l) => `${l.wire}:${l.tone}:${l.text}:${l.over ?? ""}`).join(";") : "none",
  ].join("|");
  const settle = useSettledRows(box, "button[data-act]", (el) => `${el.dataset.act}:${does}`, (el) => el.offsetTop * 10_000 + el.offsetLeft);
  const { holdOff, heldOff } = useHeldOff();
  const opened = useRef(Date.now());
  /** A click made as it opened (a double click's second, landing where it came up) presses nothing in it for ANSWER_SETTLE_MS. */
  const onClickFirst = (e: React.MouseEvent<HTMLDivElement>) => {
    if (keyClick(e) || (e.target as Element).closest?.("button[data-act]")) return;
    if (Date.now() - opened.current >= ANSWER_SETTLE_MS) return;
    e.preventDefault();
    e.stopPropagation();
  };
  /** A button going off (held, or while its act runs) drops the keyboard it took: the popover keeps it. */
  const keepKeys = () => pop()?.focus({ preventScroll: true });
  // a button gone from under the keyboard leaves it with the popover, not on the page
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

  const finish = (e: React.MouseEvent<HTMLButtonElement>) => {
    // a key's click is checked, and its key spent, even when nothing else is let through
    if (!keyAimed(e) || busy.current || off) return;
    const wait = settle(`finish:${does}`);
    if (wait > 0) {
      keepKeys();
      return holdOff("finish", wait);
    }
    keepKeys();
    busy.current = true;
    setWorking(true);
    setErr(null);
    void onFinish(body, verdict)
      .catch((x: unknown) => {
        console.error(`[mockingbird] Finish step for ${id} failed:`, x);
        return `Couldn't finish its step: ${x instanceof Error ? x.message : String(x)}`;
      })
      .then((why) => {
        // finished, the step's changes went with it
        if (!why) drafts.delete(id);
        if (!alive.current) return void (why && onLost(why));
        if (!why) return onClose();
        busy.current = false;
        setWorking(false);
        setErr(why);
      });
  };
  const mark =
    summary.from !== "agent"
      ? newer
        ? "It has a newer message since you changed this."
        : summary.from === "kept"
          ? "Your changes, kept from before."
          : "From its latest message, changed by you."
      : latest.reading
        ? "Reading its latest message…"
        : latest.why
          ? `${latest.why}: write what this step did.`
          : `From its latest message. Its agent wrote this, not you.${latest.cut ? " It was longer than a summary holds, and was cut." : ""}`;
  // changes kept from before, or made from an earlier message: the latest is a click away, setting them aside
  const offerLatest = (newer || summary.from === "kept") && !!latestText;
  return (
    <AnchoredPopover
      anchor={at}
      className="wr-pop fs-pop"
      label={`Finish ${whose(title)} step`}
      onClose={(how) => {
        // a press on a dialog opened while it finishes is that dialog's
        if (how === "outside" && busy.current && document.querySelector(".modal-back")) return;
        onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div ref={box} className="wr-form fs-form" onClickCapture={onClickFirst}>
        <div className="fs-title">Finish {whose(title)} step</div>
        <div className={`fs-mark${summary.from === "agent" && latest.reading === false && latest.why ? " t-blocked" : ""}${newer ? " t-newer" : ""}`}>
          {mark}
          {offerLatest && (
            <>
              {" "}
              <button type="button" className="fs-use" disabled={working} onClick={useLatest}>
                {newer ? "Use it" : "Use its latest message"}
              </button>
            </>
          )}
        </div>
        <textarea
          className="wr-tpl fs-body"
          aria-label="Its summary: what finishing sends on"
          // its lines as they wrap at the popover's width (about 46 of its characters)
          rows={Math.min(8, Math.max(3, summary.body.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 46)), 0)))}
          value={summary.body}
          disabled={summary.from === "agent" && latest.reading}
          onChange={(e) => setSummary({ body: e.target.value, from: summary.from === "agent" ? "yours" : summary.from, base: summary.from === "agent" ? summary.body : summary.base })}
        />
        {verdictDue && (
          <div className="fs-verdict">
            <span className="wr-label">Verdict</span>
            <span className="wr-seg" role="group" aria-label="Verdict">
              {(["changes", "approve"] as const).map((v) => (
                <button key={v} type="button" data-verdict={v} aria-pressed={verdict === v} disabled={working} onClick={() => setVerdict(v)}>
                  {v === "changes" ? "Changes" : "Approve"}
                </button>
              ))}
            </span>
          </div>
        )}
        {shown ? (
          <div className="fs-lines">
            {shown.map((l) => (
              <div key={l.wire} className="fs-line" data-wire={l.wire}>
                <span className={`fs-dot t-${l.tone}`} aria-hidden="true" />
                <span className="fs-to">{l.to}</span>
                <span className="fs-does">
                  <span className="fs-what">{l.text}</span>
                  {l.over && <span className="fs-over">{l.over}</span>}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="fs-mark">{verdictDue && !verdict ? "Changes sends the work back along its feedback loop; Approve lets its handoffs go." : "The wires can't be read right now."}</div>
        )}
        <div className="wr-foot">
          <button type="button" data-act="finish" className="wr-btn wg-main" disabled={working || !!off || heldOff("finish")} title={off ?? undefined} onClick={finish}>
            {working ? "Finishing…" : "Finish step"}
          </button>
          <button type="button" className="wr-btn" onClick={() => onClose()}>
            Cancel
          </button>
        </div>
        {blocked && <div className="fs-mark t-blocked">{blocked}</div>}
        {err && (
          <div className="wr-err" role="alert">
            {err}
          </div>
        )}
        {stale && <div className="wg-hint">{EARLY_KEYS_HINT}</div>}
      </div>
    </AnchoredPopover>
  );
}
